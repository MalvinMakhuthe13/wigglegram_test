/* Wigglegram — event depth camera.
 * Capture a sideways sweep (or import rig photos), pick evenly spaced views,
 * lock the subject, loop it, and sell/deliver the clip on the spot.
 */
(function () {
  "use strict";
  const WG = window.WG;
  const $ = (id) => document.getElementById(id);

  // ---------- Settings ----------
  const DEFAULTS = {
    eventName: "",
    watermark: "",
    showLogo: false,
    price: 50,
    organiserPays: false,
    payLink: "",
    allowCash: true,
    allowCard: true,
    deliverShare: true,
    deliverWhatsApp: true,
    deliverEmail: true,
    deliverQr: false,
    uploadUrl: "",
    uploadKey: "",
    message: "Your wigglegram from tonight ✨",
    frames: 14,
    sweepSec: 1.4,
    countdown: 2,
    longEdge: 1080,
    clipSec: 4,
  };
  const S = loadSettings();
  let logoImg = null;

  function loadSettings() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem("wg.settings") || "{}"));
    } catch {
      return Object.assign({}, DEFAULTS);
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem("wg.settings", JSON.stringify(S));
    } catch {
      /* storage full or private */
    }
  }
  function loadLogo() {
    const data = localStorage.getItem("wg.logo");
    if (!data) return;
    const img = new Image();
    img.onload = () => {
      logoImg = img;
      drawCurrent();
    };
    img.src = data;
  }

  // ---------- State ----------
  const st = {
    stream: null,
    facing: "environment",
    torch: false,
    wakeLock: null,
    frames: [], // canvases at capture resolution
    small: [], // { g: gradient, w, h }
    mid: [],
    sharp: [],
    positions: [],
    views: [],
    offsets: [],
    ref: 0,
    focus: null, // in frame pixels
    baseCrop: null,
    crop: null,
    aspect: 0.8,
    timeline: [],
    step: 0,
    timer: null,
    clip: null, // { id, blob, mime, url, status, method, contact, delivered, createdAt, price, link }
  };

  // ---------- Navigation ----------
  function show(name) {
    document.querySelectorAll(".screen").forEach((el) => el.classList.toggle("active", el.id === "screen-" + name));
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.screen === name));
    if (name === "gallery") renderGallery();
    if (name !== "edit") stopPlayback();
    else if (st.views.length) startPlayback();
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.screen)));

  let toastTimer = null;
  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2600);
  }
  function busy(on, text) {
    $("busy").hidden = !on;
    if (text) $("busyText").textContent = text;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextPaint = () => new Promise((r) => requestAnimationFrame(() => r()));

  // ---------- Camera ----------
  async function startCamera() {
    stopCamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("This browser has no camera access. Use Import instead.");
      return;
    }
    try {
      st.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: st.facing },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
      });
    } catch (err) {
      toast("Camera blocked. Allow camera access for this site.");
      return;
    }
    const video = $("video");
    video.srcObject = st.stream;
    await video.play().catch(() => undefined);
    $("camOff").hidden = true;
    $("camBtn").textContent = "Stop camera";
    $("viewfinder").classList.toggle("mirrored", st.facing === "user");
    const track = st.stream.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    $("torchBtn").hidden = !caps.torch;
    try {
      if ("wakeLock" in navigator) st.wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      /* not allowed */
    }
  }
  function stopCamera() {
    if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
    st.stream = null;
    st.torch = false;
    $("torchBtn").classList.remove("on");
    $("video").srcObject = null;
    $("camOff").hidden = false;
    $("camBtn").textContent = "Start camera";
    if (st.wakeLock) st.wakeLock.release().catch(() => undefined);
    st.wakeLock = null;
  }
  $("camBtn").addEventListener("click", () => (st.stream ? stopCamera() : startCamera()));
  $("flipBtn").addEventListener("click", () => {
    st.facing = st.facing === "environment" ? "user" : "environment";
    startCamera();
  });
  $("torchBtn").addEventListener("click", async () => {
    const track = st.stream && st.stream.getVideoTracks()[0];
    if (!track) return;
    st.torch = !st.torch;
    try {
      await track.applyConstraints({ advanced: [{ torch: st.torch }] });
      $("torchBtn").classList.toggle("on", st.torch);
    } catch {
      toast("This phone does not allow the light from the browser.");
    }
  });

  // ---------- Capture ----------
  let capturing = false;
  $("shutterBtn").addEventListener("click", async () => {
    if (capturing) return;
    if (!st.stream) {
      await startCamera();
      if (!st.stream) return;
    }
    capturing = true;
    $("shutterBtn").classList.add("busy");
    try {
      const frames = await captureSweep();
      if (frames.length >= 2) await loadFrames(frames);
    } finally {
      capturing = false;
      $("shutterBtn").classList.remove("busy");
    }
  });

  async function captureSweep() {
    const video = $("video");
    const cd = $("countdown");
    for (let n = Math.round(S.countdown); n > 0; n--) {
      cd.hidden = false;
      cd.textContent = n;
      await sleep(800);
    }
    cd.hidden = true;
    if (!video.videoWidth) {
      toast("The camera has no picture yet.");
      return [];
    }
    const count = clamp(Math.round(S.frames), 6, 24);
    const total = clamp(S.sweepSec, 0.6, 3) * 1000;
    const scale = Math.min(1, S.longEdge / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);

    $("guide").hidden = false;
    $("guideText").textContent = "Slide the phone slowly →";
    const fill = $("guideFill");
    const frames = [];
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      const due = start + (total * i) / (count - 1);
      const wait = due - performance.now();
      if (wait > 4) await sleep(wait - 2);
      await nextVideoFrame(video);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(video, 0, 0, w, h);
      frames.push(c);
      fill.style.width = ((i + 1) / count) * 100 + "%";
    }
    $("guideText").textContent = "Got it ✓";
    if (navigator.vibrate) navigator.vibrate(40);
    await sleep(250);
    $("guide").hidden = true;
    fill.style.width = "0";
    return frames;
  }

  function nextVideoFrame(video) {
    return new Promise((resolve) => {
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => resolve());
      else requestAnimationFrame(() => resolve());
    });
  }

  // Import: 2+ photos from a multi-phone rig, a multi-lens camera, or two handheld shots.
  $("importInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith("image/"));
    e.target.value = "";
    if (files.length < 2) {
      toast("Pick at least 2 photos, in left-to-right order.");
      return;
    }
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const bitmaps = [];
    for (const f of files) {
      try {
        bitmaps.push(await createImageBitmap(f));
      } catch {
        toast("One photo could not be read: " + f.name);
        return;
      }
    }
    const first = bitmaps[0];
    const scale = Math.min(1, S.longEdge / Math.max(first.width, first.height));
    const w = Math.round(first.width * scale);
    const h = Math.round(first.height * scale);
    const frames = bitmaps.map((bmp) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      // Cover-fit so photos of slightly different sizes still line up.
      const s = Math.max(w / bmp.width, h / bmp.height);
      const dw = bmp.width * s;
      const dh = bmp.height * s;
      c.getContext("2d").drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
      bmp.close && bmp.close();
      return c;
    });
    await loadFrames(frames, true);
  });

  // ---------- Processing ----------
  function grayOf(canvas, width) {
    const w = Math.max(16, Math.round(width));
    const h = Math.max(16, Math.round((canvas.height * w) / canvas.width));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, w, h);
    const gray = WG.grayFromRGBA(ctx.getImageData(0, 0, w, h).data, w, h);
    return { gray, g: WG.gradient(gray, w, h), w, h };
  }

  async function loadFrames(frames, imported) {
    show("edit");
    busy(true, "Finding the depth…");
    await nextPaint();
    stopPlayback();
    st.frames = frames;
    st.small = [];
    st.mid = [];
    st.sharp = [];
    const W = frames[0].width;
    for (const f of frames) {
      const small = grayOf(f, 160);
      const mid = grayOf(f, Math.min(540, W));
      st.small.push(small);
      st.mid.push(mid);
      st.sharp.push(WG.sharpness(mid.gray, mid.w, mid.h));
      await sleep(0);
    }

    // Camera travel between neighbouring frames, measured on the whole picture.
    if (imported) {
      st.positions = frames.map((_, i) => i);
    } else {
      const shifts = [];
      let guess = { dx: 0, dy: 0 };
      for (let i = 1; i < frames.length; i++) {
        const a = st.small[i - 1];
        const b = st.small[i];
        const m = Math.round(a.w * 0.1);
        const s = WG.estimateShift(a.g, b.g, a.w, a.h, { x: m, y: m, w: a.w - 2 * m, h: a.h - 2 * m }, guess, 14, 2);
        shifts.push(s.dx);
        guess = s;
      }
      st.positions = WG.cumulative(shifts);
      const travel = Math.abs(st.positions[st.positions.length - 1]);
      if (travel < 3) toast("The phone barely moved. Slide it further next time for more depth.");
    }

    st.focus = { x: W / 2, y: frames[0].height / 2 };
    $("views").max = String(Math.min(10, frames.length));
    if (+$("views").value > frames.length) $("views").value = String(frames.length);
    reselect();
    busy(false);
    startPlayback();
  }

  /** Pick views for the current depth and count, then align. */
  function reselect() {
    if (!st.frames.length) return;
    const count = Math.min(+$("views").value, st.frames.length);
    const depth = +$("depth").value;
    st.views = WG.selectViews(st.positions, st.sharp, count, depth);
    st.ref = st.views[Math.floor(st.views.length / 2)];
    align();
  }

  /** Lock every view onto the focus point. */
  function align() {
    const W = st.frames[0].width;
    const H = st.frames[0].height;
    const refS = st.small[st.ref];
    const refM = st.mid[st.ref];
    const sS = refS.w / W;
    const sM = refM.w / W;
    const patch = 0.26; // of the width
    st.offsets = st.views.map((i) => {
      if (i === st.ref) return { dx: 0, dy: 0 };
      // Coarse: small image, wide search, seeded by the global camera travel.
      const pw = refS.w * patch;
      const rectS = { x: st.focus.x * sS - pw / 2, y: st.focus.y * sS - pw / 2, w: pw, h: pw };
      // Try two starting points and keep the better match: "the subject stayed put" (the
      // photographer kept it centred) and "the subject moved with the camera".
      const travel = (st.positions[i] - st.positions[st.ref]) || 0;
      let coarse = WG.estimateShift(refS.g, st.small[i].g, refS.w, refS.h, rectS, { dx: 0, dy: 0 }, 22, 1);
      if (Math.abs(travel) > 6) {
        const alt = WG.estimateShift(refS.g, st.small[i].g, refS.w, refS.h, rectS, { dx: travel, dy: 0 }, 22, 1);
        if (alt.cost < coarse.cost) coarse = alt;
      }
      // Fine: mid image, small search around the coarse answer, sub-pixel.
      const k = refM.w / refS.w;
      const pm = refM.w * patch;
      const rectM = { x: st.focus.x * sM - pm / 2, y: st.focus.y * sM - pm / 2, w: pm, h: pm };
      const fine = WG.estimateShift(refM.g, st.mid[i].g, refM.w, refM.h, rectM, { dx: coarse.dx * k, dy: coarse.dy * k }, 3, 1);
      return { dx: fine.dx / sM, dy: fine.dy / sM };
    });
    st.baseCrop = WG.commonCrop(st.offsets, W, H);
    applyAspect();
  }

  function applyAspect() {
    st.crop = WG.fitAspect(st.baseCrop, st.aspect, st.focus);
    const c = $("preview");
    const s = Math.min(1, 720 / Math.max(st.crop.w, st.crop.h));
    c.width = Math.round(st.crop.w * s);
    c.height = Math.round(st.crop.h * s);
    st.timeline = WG.timeline(st.views.length, +$("tween").value);
    st.step = 0;
    placeFocusDot();
    drawCurrent();
  }

  function placeFocusDot() {
    const c = $("preview");
    const dot = $("focusDot");
    if (!st.crop) return;
    const rect = c.getBoundingClientRect();
    const stage = c.parentElement.getBoundingClientRect();
    const x = rect.left - stage.left + ((st.focus.x - st.crop.x) / st.crop.w) * rect.width;
    const y = rect.top - stage.top + ((st.focus.y - st.crop.y) / st.crop.h) * rect.height;
    dot.style.left = x + "px";
    dot.style.top = y + "px";
    dot.style.display = "block";
  }

  // ---------- Drawing ----------
  function drawEntry(ctx, entry, w, h) {
    const crop = st.crop;
    const draw = (viewIndex, alpha) => {
      const f = st.frames[st.views[viewIndex]];
      const o = st.offsets[viewIndex];
      ctx.globalAlpha = alpha;
      ctx.drawImage(f, crop.x + o.dx, crop.y + o.dy, crop.w, crop.h, 0, 0, w, h);
    };
    draw(entry.a, 1);
    if (entry.t > 0) draw(entry.b, entry.t);
    ctx.globalAlpha = 1;
    drawBranding(ctx, w, h);
  }

  function drawBranding(ctx, w, h) {
    const pad = Math.round(w * 0.04);
    if (S.watermark) {
      const size = Math.max(12, Math.round(w * 0.04));
      ctx.font = `700 ${size}px system-ui, sans-serif`;
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillText(S.watermark, pad + 1, h - pad + 1);
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillText(S.watermark, pad, h - pad);
    }
    if (S.showLogo && logoImg) {
      const lw = w * 0.18;
      const lh = (logoImg.height / logoImg.width) * lw;
      ctx.drawImage(logoImg, w - pad - lw, h - pad - lh, lw, lh);
    }
  }

  function drawCurrent() {
    if (!st.crop || !st.timeline.length) return;
    const c = $("preview");
    drawEntry(c.getContext("2d"), st.timeline[st.step % st.timeline.length], c.width, c.height);
  }

  function stepMs() {
    return +$("speed").value / (+$("tween").value + 1);
  }
  function startPlayback() {
    stopPlayback();
    if (!st.views.length) return;
    const tick = () => {
      st.step = (st.step + 1) % st.timeline.length;
      drawCurrent();
      st.timer = setTimeout(tick, stepMs());
    };
    drawCurrent();
    st.timer = setTimeout(tick, stepMs());
  }
  function stopPlayback() {
    clearTimeout(st.timer);
    st.timer = null;
  }

  // ---------- Edit controls ----------
  function bindRange(id, fmt, onChange) {
    const input = $(id);
    const out = $(id + "Out");
    const update = () => (out.textContent = fmt(+input.value));
    update();
    input.addEventListener("input", () => {
      update();
      onChange();
    });
  }
  bindRange("depth", (v) => Math.round(v * 100) + "%", () => st.frames.length && reselect());
  bindRange("views", (v) => String(v), () => st.frames.length && reselect());
  bindRange("speed", (v) => v + " ms", () => startPlayback());
  bindRange("tween", (v) => (v ? "+" + v : "off"), () => st.frames.length && applyAspect());

  $("aspectSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $("aspectSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    st.aspect = +b.dataset.aspect;
    if (st.frames.length) applyAspect();
  });

  $("preview").addEventListener("click", (e) => {
    if (!st.crop) return;
    const r = e.currentTarget.getBoundingClientRect();
    st.focus = {
      x: st.crop.x + ((e.clientX - r.left) / r.width) * st.crop.w,
      y: st.crop.y + ((e.clientY - r.top) / r.height) * st.crop.h,
    };
    align();
    startPlayback();
  });
  window.addEventListener("resize", placeFocusDot);

  $("retakeBtn").addEventListener("click", () => show("capture"));

  // ---------- Export ----------
  function outputSize() {
    const s = Math.min(1, S.longEdge / Math.max(st.crop.w, st.crop.h));
    // Encoders want even sizes.
    return { w: Math.round((st.crop.w * s) / 2) * 2, h: Math.round((st.crop.h * s) / 2) * 2 };
  }

  function pickMime() {
    if (!window.MediaRecorder) return null;
    const list = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    return list.find((m) => MediaRecorder.isTypeSupported(m)) || null;
  }

  async function renderVideo() {
    const mime = pickMime();
    if (!mime) return null;
    const { w, h } = outputSize();
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    drawEntry(ctx, st.timeline[0], w, h);
    const stream = c.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    rec.start(250);
    const ms = stepMs();
    const total = Math.max(2, S.clipSec) * 1000;
    const start = performance.now();
    let i = 0;
    while (performance.now() - start < total) {
      drawEntry(ctx, st.timeline[i % st.timeline.length], w, h);
      i++;
      await sleep(ms);
    }
    rec.stop();
    stream.getTracks().forEach((t) => t.stop());
    await done;
    return { blob: new Blob(chunks, { type: mime.split(";")[0] }), mime: mime.split(";")[0] };
  }

  let gifLib = null;
  async function loadGifLib() {
    if (gifLib) return gifLib;
    await loadScript("https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js");
    // Workers must be same-origin, so wrap the CDN worker in a blob.
    const res = await fetch("https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js");
    const workerUrl = URL.createObjectURL(new Blob([await res.text()], { type: "application/javascript" }));
    gifLib = { GIF: window.GIF, workerUrl };
    return gifLib;
  }

  async function renderGif() {
    const { GIF, workerUrl } = await loadGifLib();
    const s = Math.min(1, 600 / Math.max(st.crop.w, st.crop.h));
    const w = Math.round(st.crop.w * s);
    const h = Math.round(st.crop.h * s);
    const gif = new GIF({ workers: 2, quality: 8, width: w, height: h, workerScript: workerUrl });
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    for (const entry of st.timeline) {
      drawEntry(ctx, entry, w, h);
      gif.addFrame(ctx, { copy: true, delay: Math.round(stepMs()) });
    }
    return new Promise((resolve, reject) => {
      gif.on("finished", (blob) => resolve({ blob, mime: "image/gif" }));
      gif.on("abort", () => reject(new Error("GIF stopped")));
      gif.render();
    });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }

  $("exportBtn").addEventListener("click", async () => {
    if (!st.views.length) return toast("Capture or import first.");
    stopPlayback();
    busy(true, "Making the clip…");
    $("exportBtn").disabled = true;
    try {
      let out = await renderVideo();
      if (!out) out = await renderGif();
      const thumb = thumbnail();
      const clip = {
        id: "wg_" + Date.now().toString(36),
        createdAt: Date.now(),
        eventName: S.eventName,
        blob: out.blob,
        mime: out.mime,
        thumb,
        price: S.organiserPays ? 0 : Number(S.price) || 0,
        status: S.organiserPays || !(Number(S.price) > 0) ? "free" : "unpaid",
        method: S.organiserPays ? "organiser" : "",
        contact: "",
        delivered: false,
        link: "",
      };
      await dbPut(clip);
      openDeliver(clip);
    } catch (err) {
      toast("Could not make the clip: " + (err && err.message ? err.message : err));
    } finally {
      busy(false);
      $("exportBtn").disabled = false;
    }
  });

  function thumbnail() {
    const c = document.createElement("canvas");
    const s = 240 / Math.max(st.crop.w, st.crop.h);
    c.width = Math.round(st.crop.w * s);
    c.height = Math.round(st.crop.h * s);
    drawEntry(c.getContext("2d"), st.timeline[0], c.width, c.height);
    return c.toDataURL("image/jpeg", 0.7);
  }

  // ---------- Deliver ----------
  function ext(mime) {
    return mime === "image/gif" ? "gif" : mime === "video/mp4" ? "mp4" : "webm";
  }
  function fileOf(clip) {
    const name = `${(clip.eventName || "wigglegram").replace(/[^\w-]+/g, "-")}-${clip.id}.${ext(clip.mime)}`;
    return new File([clip.blob], name, { type: clip.mime });
  }

  function openDeliver(clip) {
    if (st.clip && st.clip.url) URL.revokeObjectURL(st.clip.url);
    st.clip = clip;
    clip.url = URL.createObjectURL(clip.blob);
    const isGif = clip.mime === "image/gif";
    $("clipVideo").hidden = isGif;
    $("clipImg").hidden = !isGif;
    if (isGif) $("clipImg").src = clip.url;
    else {
      $("clipVideo").src = clip.url;
      $("clipVideo").play().catch(() => undefined);
    }
    $("guestContact").value = clip.contact || "";
    $("dlQrWrap").hidden = true;
    renderPay();
    renderSend();
    show("deliver");
    updateStats();
  }

  function paidOk(clip) {
    return clip.status === "paid" || clip.status === "free";
  }

  function renderPay() {
    const clip = st.clip;
    $("priceLabel").textContent = clip.status === "free" ? "Free" : rand(clip.price);
    const buttons = $("payButtons");
    buttons.innerHTML = "";
    const status = $("payStatus");
    status.className = "status" + (paidOk(clip) ? " ok" : "");
    status.textContent =
      clip.status === "free"
        ? S.organiserPays
          ? "Paid by the organiser"
          : "Free"
        : clip.status === "paid"
          ? `Paid · ${clip.method}`
          : "Not paid yet";

    $("payQrWrap").hidden = true;
    if (clip.status === "unpaid") {
      if (S.payLink) {
        $("payQrWrap").hidden = false;
        renderQr($("payQr"), S.payLink);
        addBtn(buttons, "Open pay link", "ghost-btn", () => window.open(S.payLink, "_blank", "noopener"));
        addBtn(buttons, "Paid online ✓", "primary-btn", () => markPaid("link"));
      }
      if (S.allowCash) addBtn(buttons, "Paid cash ✓", "primary-btn", () => markPaid("cash"));
      if (S.allowCard) addBtn(buttons, "Paid card ✓", "primary-btn", () => markPaid("card"));
      if (!S.payLink && !S.allowCash && !S.allowCard) {
        addBtn(buttons, "Mark paid ✓", "primary-btn", () => markPaid("other"));
      }
    } else if (clip.status === "paid") {
      addBtn(buttons, "Undo payment", "ghost-btn", async () => {
        clip.status = "unpaid";
        clip.method = "";
        await dbPut(clip);
        renderPay();
        renderSend();
        updateStats();
      });
    }
  }

  async function markPaid(method) {
    st.clip.status = "paid";
    st.clip.method = method;
    await dbPut(st.clip);
    if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
    renderPay();
    renderSend();
    updateStats();
    toast("Paid ✓ Now send it.");
  }

  function renderSend() {
    const clip = st.clip;
    const box = $("sendButtons");
    box.innerHTML = "";
    const locked = !paidOk(clip);
    const canQr = S.deliverQr && S.uploadUrl;
    if (S.deliverShare) addBtn(box, "Share…", "primary-btn", () => shareClip(), locked);
    if (S.deliverWhatsApp) addBtn(box, "WhatsApp", "ghost-btn", () => sendWhatsApp(), locked);
    if (S.deliverEmail) addBtn(box, "Email", "ghost-btn", () => sendEmail(), locked);
    if (canQr) addBtn(box, "QR download", "ghost-btn", () => showDownloadQr(), locked);
    addBtn(box, "Save to phone", "ghost-btn", () => download(clip), locked);
    if (locked) {
      const p = document.createElement("p");
      p.className = "muted";
      p.style.width = "100%";
      p.textContent = "Mark it paid to unlock sending.";
      box.appendChild(p);
    }
  }

  function addBtn(parent, label, cls, fn, disabled) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    b.disabled = !!disabled;
    b.addEventListener("click", fn);
    parent.appendChild(b);
    return b;
  }

  $("guestContact").addEventListener("change", async () => {
    if (!st.clip) return;
    st.clip.contact = $("guestContact").value.trim();
    await dbPut(st.clip);
  });

  async function delivered(how) {
    st.clip.delivered = true;
    st.clip.deliveredBy = how;
    await dbPut(st.clip);
    updateStats();
  }

  async function shareClip() {
    const file = fileOf(st.clip);
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: S.message, title: S.eventName || "Wigglegram" });
        await delivered("share");
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return;
      }
    }
    download(st.clip);
    toast("Saved. Send it from your gallery.");
  }

  /** Upload once and reuse the link. Returns null when no upload address is set. */
  async function ensureLink() {
    const clip = st.clip;
    if (clip.link) return clip.link;
    if (!S.uploadUrl) return null;
    busyDeliver(true);
    try {
      const form = new FormData();
      form.append("file", fileOf(clip));
      form.append("id", clip.id);
      form.append("event", S.eventName || "");
      const headers = S.uploadKey ? { Authorization: "Bearer " + S.uploadKey } : {};
      const res = await fetch(S.uploadUrl, { method: "POST", body: form, headers });
      if (!res.ok) throw new Error("Upload failed (" + res.status + ")");
      const type = res.headers.get("content-type") || "";
      const link = type.includes("json") ? (await res.json()).url : (await res.text()).trim();
      if (!/^https?:\/\//.test(link || "")) throw new Error("The upload address did not return a link.");
      clip.link = link;
      await dbPut(clip);
      return link;
    } catch (err) {
      toast(err.message || "Upload failed. Check signal or the upload address.");
      return null;
    } finally {
      busyDeliver(false);
    }
  }
  function busyDeliver(on) {
    $("sendButtons").querySelectorAll("button").forEach((b) => (b.disabled = on || !paidOk(st.clip)));
  }

  function waNumber(raw) {
    let d = String(raw || "").replace(/[^\d+]/g, "");
    if (d.startsWith("+")) d = d.slice(1);
    else if (d.startsWith("0")) d = "27" + d.slice(1); // South African local numbers
    return d.replace(/\D/g, "");
  }

  async function sendWhatsApp() {
    const number = waNumber($("guestContact").value);
    const link = await ensureLink();
    if (link) {
      const text = encodeURIComponent(`${S.message}\n${link}`);
      window.open(number ? `https://wa.me/${number}?text=${text}` : `https://wa.me/?text=${text}`, "_blank", "noopener");
      await delivered("whatsapp-link");
      return;
    }
    // No upload address: hand the file to WhatsApp through the share sheet.
    await shareClip();
    if (number) toast("Pick WhatsApp, then the guest's chat.");
  }

  async function sendEmail() {
    const email = $("guestContact").value.trim();
    const link = await ensureLink();
    if (link) {
      const subject = encodeURIComponent(S.eventName ? `Your wigglegram from ${S.eventName}` : "Your wigglegram");
      const body = encodeURIComponent(`${S.message}\n\n${link}`);
      window.location.href = `mailto:${email.includes("@") ? email : ""}?subject=${subject}&body=${body}`;
      await delivered("email-link");
      return;
    }
    await shareClip();
  }

  async function showDownloadQr() {
    const link = await ensureLink();
    if (!link) return;
    $("dlQrWrap").hidden = false;
    renderQr($("dlQr"), link);
    await delivered("qr");
  }

  function download(clip) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(clip.blob);
    a.download = fileOf(clip).name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  $("saveGifBtn").addEventListener("click", async () => {
    if (!st.views.length) return;
    $("saveGifBtn").disabled = true;
    try {
      const out = await renderGif();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(out.blob);
      a.download = `${st.clip ? st.clip.id : "wigglegram"}.gif`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch {
      toast("GIF needs a connection the first time.");
    } finally {
      $("saveGifBtn").disabled = false;
    }
  });

  $("nextBtn").addEventListener("click", () => {
    st.frames = [];
    st.views = [];
    show("capture");
  });

  // ---------- QR ----------
  let qrReady = null;
  async function renderQr(el, text) {
    el.textContent = "";
    try {
      qrReady = qrReady || loadScript("https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js");
      await qrReady;
      const qr = window.qrcode(0, "M");
      qr.addData(text);
      qr.make();
      el.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
    } catch {
      el.textContent = text;
      el.style.lineHeight = "1.3";
      el.style.color = "#000";
    }
  }

  // ---------- Storage (IndexedDB) ----------
  let dbp = null;
  function db() {
    dbp =
      dbp ||
      new Promise((resolve, reject) => {
        const req = indexedDB.open("wigglegram", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("clips", { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction("clips", mode);
      const out = fn(t.objectStore("clips"));
      t.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }
  function dbPut(clip) {
    const copy = Object.assign({}, clip);
    delete copy.url;
    return tx("readwrite", (s) => s.put(copy));
  }
  function dbAll() {
    return tx("readonly", (s) => s.getAll()).then((rows) => (rows || []).sort((a, b) => b.createdAt - a.createdAt));
  }
  function dbClear() {
    return tx("readwrite", (s) => s.clear());
  }

  // ---------- Gallery / sales ----------
  function rand(n) {
    return "R" + (Number(n) || 0).toLocaleString("en-ZA");
  }

  async function updateStats() {
    try {
      const rows = await dbAll();
      const revenue = rows.filter((r) => r.status === "paid").reduce((s, r) => s + (Number(r.price) || 0), 0);
      $("todayStats").textContent = `${rows.length} clip${rows.length === 1 ? "" : "s"} · ${rand(revenue)}`;
      return { rows, revenue };
    } catch {
      return { rows: [], revenue: 0 };
    }
  }

  async function renderGallery() {
    const { rows, revenue } = await updateStats();
    const paid = rows.filter((r) => r.status === "paid").length;
    const unpaid = rows.filter((r) => r.status === "unpaid").length;
    $("totals").innerHTML = `<div><b>${rows.length}</b><span>clips</span></div><div><b>${paid}</b><span>paid${
      unpaid ? ` · ${unpaid} owing` : ""
    }</span></div><div><b>${rand(revenue)}</b><span>taken</span></div>`;
    const list = $("gallery");
    list.innerHTML = "";
    if (!rows.length) {
      list.innerHTML = '<li style="grid-column:1/-1;padding:24px;text-align:center" class="muted">No clips yet tonight.</li>';
      return;
    }
    for (const row of rows) {
      const li = document.createElement("li");
      const time = new Date(row.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      li.innerHTML = `<img alt="" /><div class="meta"><span>${time}${row.delivered ? " · sent" : ""}</span><span class="badge ${row.status}">${
        row.status === "unpaid" ? "owing" : row.status
      }</span></div>`;
      li.querySelector("img").src = row.thumb;
      li.addEventListener("click", () => openDeliver(row));
      list.appendChild(li);
    }
  }

  $("csvBtn").addEventListener("click", async () => {
    const rows = await dbAll();
    const head = ["id", "time", "event", "price", "status", "method", "contact", "delivered", "link"];
    const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const lines = [head.join(",")].concat(
      rows.map((r) =>
        [r.id, new Date(r.createdAt).toISOString(), r.eventName, r.price, r.status, r.method, r.contact, r.deliveredBy || (r.delivered ? "yes" : ""), r.link]
          .map(esc)
          .join(","),
      ),
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `${(S.eventName || "wigglegram").replace(/[^\w-]+/g, "-")}-sales.csv`;
    a.click();
  });

  $("clearBtn").addEventListener("click", async () => {
    if (!confirm("Delete every clip from this event on this phone? Export the CSV first if you need it.")) return;
    await dbClear();
    renderGallery();
  });

  // ---------- Settings form ----------
  const form = $("settingsForm");
  function fillForm() {
    for (const el of form.elements) {
      if (!el.name || !(el.name in S)) continue;
      if (el.type === "checkbox") el.checked = !!S[el.name];
      else el.value = S[el.name];
    }
    $("eventTitle").textContent = S.eventName || "Wigglegram";
  }
  form.addEventListener("input", (e) => {
    const el = e.target;
    if (!el.name || !(el.name in DEFAULTS)) return;
    if (el.type === "checkbox") S[el.name] = el.checked;
    else if (typeof DEFAULTS[el.name] === "number") S[el.name] = Number(el.value);
    else S[el.name] = el.value.trim();
    saveSettings();
    $("eventTitle").textContent = S.eventName || "Wigglegram";
    if (st.crop) drawCurrent();
  });
  $("logoInput").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        localStorage.setItem("wg.logo", reader.result);
      } catch {
        toast("Logo too big to keep. Use a smaller PNG.");
      }
      S.showLogo = true;
      saveSettings();
      fillForm();
      loadLogo();
    };
    reader.readAsDataURL(file);
  });

  function clamp(n, a, b) {
    return Math.min(b, Math.max(a, Number(n) || a));
  }

  // ---------- Boot ----------
  fillForm();
  loadLogo();
  updateStats();
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => undefined);
  }
  // Test hook: lets automated checks feed frames without a camera.
  window.__wg = { loadFrames, state: st };
})();
