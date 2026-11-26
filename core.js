/* Wigglegram core: frame selection, alignment and timing.
 * Pure functions on grayscale arrays, so they run (and are tested) outside the browser too.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WG = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** RGBA bytes -> luminance in 0..255. */
  function grayFromRGBA(data, w, h) {
    const out = new Float32Array(w * h);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      out[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    }
    return out;
  }

  /** |dx| + |dy| gradient image. Matching on edges ignores exposure flicker between frames. */
  function gradient(gray, w, h) {
    const out = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        out[i] = Math.abs(gray[i + 1] - gray[i - 1]) + Math.abs(gray[i + w] - gray[i - w]);
      }
    }
    return out;
  }

  /** Variance of the Laplacian: higher is sharper. Used to skip motion-blurred frames. */
  function sharpness(gray, w, h) {
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    for (let y = 1; y < h - 1; y += 2) {
      for (let x = 1; x < w - 1; x += 2) {
        const i = y * w + x;
        const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        sum += lap;
        sum2 += lap * lap;
        n++;
      }
    }
    if (!n) return 0;
    const mean = sum / n;
    return sum2 / n - mean * mean;
  }

  /**
   * Find (dx, dy) so that ref(x, y) ≈ cur(x + dx, y + dy) inside `rect` (ref coordinates).
   * Inputs are gradient images of the same size. Searches a square of `radius` around `guess`,
   * then refines to sub-pixel with a parabola through the best cost and its neighbours.
   */
  function estimateShift(ref, cur, w, h, rect, guess, radius, step) {
    step = step || 1;
    const gx = Math.round(guess ? guess.dx : 0);
    const gy = Math.round(guess ? guess.dy : 0);
    const x0 = Math.max(1, Math.floor(rect.x));
    const y0 = Math.max(1, Math.floor(rect.y));
    const x1 = Math.min(w - 1, Math.floor(rect.x + rect.w));
    const y1 = Math.min(h - 1, Math.floor(rect.y + rect.h));
    const size = 2 * radius + 1;
    const costs = new Float64Array(size * size).fill(Infinity);
    let best = Infinity;
    let bx = gx;
    let by = gy;

    for (let sy = -radius; sy <= radius; sy++) {
      for (let sx = -radius; sx <= radius; sx++) {
        const dx = gx + sx;
        const dy = gy + sy;
        let cost = 0;
        let n = 0;
        for (let y = y0; y < y1; y += step) {
          const cy = y + dy;
          if (cy < 1 || cy >= h - 1) continue;
          const rRow = y * w;
          const cRow = cy * w;
          for (let x = x0; x < x1; x += step) {
            const cx = x + dx;
            if (cx < 1 || cx >= w - 1) continue;
            cost += Math.abs(ref[rRow + x] - cur[cRow + cx]);
            n++;
          }
        }
        // Too little overlap means the shift walked off the picture; never prefer it.
        const minN = (((x1 - x0) * (y1 - y0)) / (step * step)) * 0.35;
        const value = n > minN ? cost / n : Infinity;
        costs[(sy + radius) * size + (sx + radius)] = value;
        if (value < best) {
          best = value;
          bx = dx;
          by = dy;
        }
      }
    }

    const ix = bx - gx + radius;
    const iy = by - gy + radius;
    const at = (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? Infinity : costs[y * size + x]);
    const sub = (a, b, c) => {
      if (!Number.isFinite(a) || !Number.isFinite(c)) return 0;
      const denom = a - 2 * b + c;
      if (denom <= 1e-9) return 0;
      return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
    };
    return {
      dx: bx + sub(at(ix - 1, iy), best, at(ix + 1, iy)),
      dy: by + sub(at(ix, iy - 1), best, at(ix, iy + 1)),
      cost: best,
    };
  }

  /**
   * Choose `count` views from a burst so their camera positions are evenly spaced.
   * `positions` is the cumulative horizontal camera travel per frame (in pixels of image shift).
   * `depth` (0.2..1) is how much of the sweep to use: more travel, more parallax, more depth.
   * Near each ideal position the sharpest frame wins.
   */
  function selectViews(positions, sharp, count, depth) {
    const n = positions.length;
    if (n <= count) return positions.map((_, i) => i);
    depth = Math.max(0.2, Math.min(1, depth == null ? 1 : depth));
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of positions) {
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
    const span = hi - lo;
    if (span < 1e-6) {
      // The phone barely moved: fall back to evenly spaced in time.
      return evenly(n, count);
    }
    const mid = (lo + hi) / 2;
    const half = (span * depth) / 2;
    const start = mid - half;
    const end = mid + half;
    const maxSharp = Math.max(1e-9, ...sharp);
    const picked = [];
    for (let k = 0; k < count; k++) {
      const target = start + ((end - start) * k) / (count - 1);
      let bestI = -1;
      let bestScore = Infinity;
      for (let i = 0; i < n; i++) {
        if (picked.includes(i)) continue;
        const distance = Math.abs(positions[i] - target) / (span / (count - 1) || 1);
        const blur = 1 - sharp[i] / maxSharp;
        const score = distance + 0.6 * blur;
        if (score < bestScore) {
          bestScore = score;
          bestI = i;
        }
      }
      picked.push(bestI);
    }
    // Keep them in sweep order so the wiggle travels one way and back.
    const dir = positions[n - 1] >= positions[0] ? 1 : -1;
    return picked.sort((a, b) => dir * (positions[a] - positions[b]));
  }

  function evenly(n, count) {
    const out = [];
    for (let k = 0; k < count; k++) out.push(Math.round(((n - 1) * k) / (count - 1)));
    return out;
  }

  /** Largest rectangle (ref coordinates) that every shifted view covers. */
  function commonCrop(offsets, w, h) {
    let x0 = 0;
    let y0 = 0;
    let x1 = w;
    let y1 = h;
    for (const o of offsets) {
      x0 = Math.max(x0, -o.dx);
      y0 = Math.max(y0, -o.dy);
      x1 = Math.min(x1, w - o.dx);
      y1 = Math.min(y1, h - o.dy);
    }
    x0 = Math.ceil(x0);
    y0 = Math.ceil(y0);
    x1 = Math.floor(x1);
    y1 = Math.floor(y1);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  /** Fit an aspect ratio (w/h) inside a rect, centred on a focus point where possible. */
  function fitAspect(rect, aspect, focus) {
    if (!aspect) return rect;
    let w = rect.w;
    let h = w / aspect;
    if (h > rect.h) {
      h = rect.h;
      w = h * aspect;
    }
    const fx = focus ? focus.x : rect.x + rect.w / 2;
    const fy = focus ? focus.y : rect.y + rect.h / 2;
    const x = Math.min(rect.x + rect.w - w, Math.max(rect.x, fx - w / 2));
    const y = Math.min(rect.y + rect.h - h, Math.max(rect.y, fy - h / 2));
    return { x: Math.round(x), y: Math.round(y), w: Math.floor(w), h: Math.floor(h) };
  }

  /**
   * The playback timeline: views go 0 → last → 0 (ping-pong), with `tween` blended
   * in-between frames per step for a smoother, more continuous turn.
   * Each entry is { a, b, t }: draw view a, then view b on top at opacity t.
   */
  function timeline(count, tween) {
    tween = Math.max(0, Math.floor(tween || 0));
    if (count < 2) return [{ a: 0, b: 0, t: 0 }];
    const order = [];
    for (let i = 0; i < count; i++) order.push(i);
    for (let i = count - 2; i > 0; i--) order.push(i);
    const out = [];
    for (let s = 0; s < order.length; s++) {
      const a = order[s];
      const b = order[(s + 1) % order.length];
      out.push({ a, b: a, t: 0 });
      for (let k = 1; k <= tween; k++) out.push({ a, b, t: k / (tween + 1) });
    }
    return out;
  }

  /** Cumulative positions from frame-to-frame shifts. */
  function cumulative(shifts) {
    const out = [0];
    for (let i = 0; i < shifts.length; i++) out.push(out[i] + shifts[i]);
    return out;
  }


  /**
   * Least-squares similarity (rotation + uniform scale + translation) taking points ps -> qs:
   * q = [a -b; b a] p + t. Handles a phone that tilts or drifts closer during the sweep.
   */
  function fitSimilarity(ps, qs, weights) {
    const n = ps.length;
    if (!n) return { a: 1, b: 0, tx: 0, ty: 0 };
    let W = 0, px = 0, py = 0, qx = 0, qy = 0;
    for (let i = 0; i < n; i++) {
      const w = weights ? weights[i] : 1;
      W += w; px += w * ps[i].x; py += w * ps[i].y; qx += w * qs[i].x; qy += w * qs[i].y;
    }
    px /= W; py /= W; qx /= W; qy /= W;
    if (n === 1) return { a: 1, b: 0, tx: qx - px, ty: qy - py };
    let sxx = 0, sab = 0, sba = 0;
    for (let i = 0; i < n; i++) {
      const w = weights ? weights[i] : 1;
      const ux = ps[i].x - px, uy = ps[i].y - py;
      const vx = qs[i].x - qx, vy = qs[i].y - qy;
      sxx += w * (ux * ux + uy * uy);
      sab += w * (ux * vx + uy * vy);
      sba += w * (ux * vy - uy * vx);
    }
    if (sxx < 1e-9) return { a: 1, b: 0, tx: qx - px, ty: qy - py };
    let a = sab / sxx;
    let b = sba / sxx;
    // Keep it physical: a handheld sweep never zooms more than ±12% or tilts past ±10°.
    const scale = Math.hypot(a, b);
    const angle = Math.atan2(b, a);
    const cs = Math.min(1.12, Math.max(0.89, scale));
    const ca = Math.min(0.175, Math.max(-0.175, angle));
    a = cs * Math.cos(ca);
    b = cs * Math.sin(ca);
    return { a, b, tx: qx - (a * px - b * py), ty: qy - (b * px + a * py) };
  }

  function applySim(T, p) {
    return { x: T.a * p.x - T.b * p.y + T.tx, y: T.b * p.x + T.a * p.y + T.ty };
  }

  function invertSim(T) {
    const d = T.a * T.a + T.b * T.b;
    const a = T.a / d;
    const b = -T.b / d;
    return { a, b, tx: -(a * T.tx - b * T.ty), ty: -(b * T.tx + a * T.ty) };
  }

  /**
   * Largest axis-aligned rectangle (reference coordinates) that every view covers, where view i
   * maps reference -> frame by T[i]. Conservative: shrinks to the inner bound of each view's quad.
   */
  function commonCropSim(transforms, w, h) {
    let x0 = 0, y0 = 0, x1 = w, y1 = h;
    for (const T of transforms) {
      const inv = invertSim(T);
      const c = [applySim(inv, { x: 0, y: 0 }), applySim(inv, { x: w, y: 0 }), applySim(inv, { x: w, y: h }), applySim(inv, { x: 0, y: h })];
      x0 = Math.max(x0, c[0].x, c[3].x);
      x1 = Math.min(x1, c[1].x, c[2].x);
      y0 = Math.max(y0, c[0].y, c[1].y);
      y1 = Math.min(y1, c[2].y, c[3].y);
    }
    x0 = Math.ceil(x0); y0 = Math.ceil(y0); x1 = Math.floor(x1); y1 = Math.floor(y1);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }


  /** Resample `cur` so that out(p) = cur(T(p)) (bilinear). T maps reference -> current. */
  function warpGray(cur, w, h, T) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let qx = T.a * 0 - T.b * y + T.tx;
      let qy = T.b * 0 + T.a * y + T.ty;
      for (let x = 0; x < w; x++, qx += T.a, qy += T.b) {
        const x0 = Math.floor(qx);
        const y0 = Math.floor(qy);
        if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) {
          out[y * w + x] = 0;
          continue;
        }
        const fx = qx - x0;
        const fy = qy - y0;
        const i = y0 * w + x0;
        out[y * w + x] =
          cur[i] * (1 - fx) * (1 - fy) + cur[i + 1] * fx * (1 - fy) + cur[i + w] * (1 - fx) * fy + cur[i + w + 1] * fx * fy;
      }
    }
    return out;
  }

  /** T1 after T2: p -> T1(T2(p)). */
  function composeSim(T1, T2) {
    return {
      a: T1.a * T2.a - T1.b * T2.b,
      b: T1.b * T2.a + T1.a * T2.b,
      tx: T1.a * T2.tx - T1.b * T2.ty + T1.tx,
      ty: T1.b * T2.tx + T1.a * T2.ty + T1.ty,
    };
  }

  /** Mean gradient (texture) inside a rect of a gradient image. */
  function textureIn(g, w, h, rect) {
    return meanIn(g, w, h, rect);
  }

  /** Mean of a gray image inside a rect: used to even out exposure between views. */
  function meanIn(gray, w, h, rect) {
    let s = 0, n = 0;
    const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(w, Math.floor(rect.x + rect.w)), y1 = Math.min(h, Math.floor(rect.y + rect.h));
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { s += gray[y * w + x]; n++; }
    return n ? s / n : 0;
  }

  return {
    grayFromRGBA, gradient, sharpness, estimateShift, selectViews, commonCrop, fitAspect, timeline, cumulative,
    fitSimilarity, applySim, invertSim, commonCropSim, meanIn, warpGray, composeSim, textureIn,
  };
});
