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
    sweepSec: 1.2,
    film: false,
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
    mode: "sweep", // sweep | action | multi
    moment: null, // { kind: "action", frames } | { kind: "multi", videos, lags, t0, t1 }
    recorder: null,
  };

  // ---------- Navigation ----------
  function show(name) {
    document.querySelectorAll(".screen").forEach((el) => el.classList.toggle("active", el.id === "screen-" + name));
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.screen === name));
    if (name === "gallery") renderGallery();
    $("editEmpty").hidden = st.views.length > 0 || !!st.moment;
    $("deliverEmpty").hidden = !!st.clip;
    $("deliverBody").hidden = !st.clip;
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
        audio: st.mode === "multi",
        video: {
          facingMode: { ideal: st.facing },
          // As sharp as the phone allows; 60 fps keeps sweep blur down where supported.
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          frameRate: { ideal: 60 },
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
  const HINTS = {
    sweep: "Hold the shutter steady on your subject, then slide the phone sideways about a hand-width while it shoots.",
    action: "For moving action: HOLD the shutter while the play happens (up to 3 s), let go, then pick the exact moment.",
    multi: "Put 2–4 phones side by side, all filming the same play. Tap to record on each phone, then import all the videos here.",
  };
  function setMode(mode) {
    if (st.recorder) return toast("Stop recording first.");
    const had = !!st.stream;
    const needAudio = mode === "multi" || st.mode === "multi";
    st.mode = mode;
    $("modeSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    $("captureHint").textContent = HINTS[mode];
    $("importLabel").hidden = mode === "multi";
    $("videoLabel").hidden = mode !== "multi";
    if (had && needAudio) startCamera();
  }
  $("modeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) setMode(b.dataset.mode);
  });

  let capturing = false;
  $("shutterBtn").addEventListener("click", async () => {
    if (st.mode === "action") return; // action uses press-and-hold
    if (st.mode === "multi") return toggleRecording();
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

  // Action mode: hold to keep shooting; the last 3 s are kept so the decisive moment is never missed.
  let action = null;
  $("shutterBtn").addEventListener("pointerdown", async (e) => {
    if (st.mode !== "action" || action) return;
    e.preventDefault();
    // Keep the press even if the thumb drifts off the button; only lifting it stops.
    try {
      $("shutterBtn").setPointerCapture(e.pointerId);
    } catch {
      /* older browsers */
    }
    if (!st.stream) {
      await startCamera();
      if (!st.stream) return;
    }
    const video = $("video");
    if (!video.videoWidth) return toast("The camera has no picture yet.");
    const scale = Math.min(1, Math.min(S.longEdge, 1280) / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    const fps = 15;
    const keep = 45; // 3 seconds
    action = { frames: [], start: performance.now(), stop: false };
    $("shutterBtn").classList.add("busy");
    $("recBadge").hidden = false;
    const pool = [];
    let n = 0;
    while (!action.stop && performance.now() - action.start < 8000) {
      const c = pool.pop() || Object.assign(document.createElement("canvas"), { width: w, height: h });
      c.getContext("2d").drawImage(video, 0, 0, w, h);
      action.frames.push(c);
      if (action.frames.length > keep) pool.push(action.frames.shift());
      $("recTime").textContent = Math.min(3, (performance.now() - action.start) / 1000).toFixed(1);
      // Keep a steady 15 fps: wait for the next slot on a fixed schedule, then the next camera frame.
      n++;
      const wait = action.start + (n * 1000) / fps - performance.now();
      if (wait > 4) await sleep(wait - 2);
      await nextVideoFrame(video);
    }
    const frames = action.frames;
    action = null;
    $("recBadge").hidden = true;
    $("shutterBtn").classList.remove("busy");
    if (frames.length) openMoment({ kind: "action", frames });
  });
  const stopAction = () => {
    if (action) action.stop = true;
  };
  ["pointerup", "pointercancel"].forEach((ev) => $("shutterBtn").addEventListener(ev, stopAction));

  // Multi-phone: this phone records a normal video with sound; sound is what lines the phones up.
  async function toggleRecording() {
    if (st.recorder) {
      st.recorder.stop();
      return;
    }
    if (!st.stream) {
      await startCamera();
      if (!st.stream) return;
    }
    if (!st.stream.getAudioTracks().length) toast("No microphone: the videos can't be lined up by sound.");
    const mime = pickMime();
    if (!mime) return toast("This phone can't record video in the browser. Use its camera app instead.");
    const chunks = [];
    const rec = new MediaRecorder(st.stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const started = performance.now();
    const timer = setInterval(() => ($("recTime").textContent = ((performance.now() - started) / 1000).toFixed(1)), 100);
    rec.onstop = () => {
      clearInterval(timer);
      st.recorder = null;
      $("recBadge").hidden = true;
      $("shutterBtn").classList.remove("busy");
      const type = mime.split(";")[0];
      const name = `${(S.eventName || "wigglegram").replace(/[^\w-]+/g, "-")}-cam-${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}.${type === "video/mp4" ? "mp4" : "webm"}`;
      const file = new File([new Blob(chunks, { type })], name, { type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: "Wigglegram camera" }).catch(() => downloadFile(file));
      } else downloadFile(file);
      toast("Saved. Collect every phone's video on one phone, then Import videos.");
    };
    rec.start(500);
    st.recorder = rec;
    $("recBadge").hidden = false;
    $("shutterBtn").classList.add("busy");
  }
  function downloadFile(file) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  $("videoInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(f.name));
    e.target.value = "";
    if (files.length < 2) return toast("Pick at least 2 videos, one per phone, left to right.");
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    show("edit");
    busy(true, "Lining the phones up by sound…");
    try {
      const videos = await Promise.all(files.map(loadVideo));
      const envs = [];
      for (const f of files) envs.push(await soundEnvelope(f));
      const lags = [0];
      let synced = !!envs[0];
      for (let i = 1; i < files.length; i++) {
        if (!envs[0] || !envs[i]) {
          lags.push(0);
          synced = false;
          continue;
        }
        const r = WG.bestLag(envs[0], envs[i], Math.min(8000, Math.floor(Math.max(envs[0].length, envs[i].length) * 0.6)));
        lags.push(r.lag / 1000); // seconds: time in video i = t0 - lag
        if (r.score < 0.2) synced = false;
      }
      // The window where every phone was recording.
      let t0 = 0;
      const dur = (v) => (Number.isFinite(v.duration) ? v.duration : 60);
      let t1 = dur(videos[0]);
      videos.forEach((v, i) => {
        t0 = Math.max(t0, lags[i]);
        t1 = Math.min(t1, dur(v) + lags[i]);
      });
      if (!(t1 > t0)) throw new Error("The videos don't overlap in time.");
      openMoment({ kind: "multi", videos, lags, t0, t1 });
      $("momentNote").textContent = synced
        ? `Lined up ${files.length} phones by sound.`
        : "Couldn't line every phone up by sound (no audio?). Frames may be from slightly different moments.";
    } catch (err) {
      toast(err.message || "Those videos could not be opened.");
    } finally {
      busy(false);
    }
  });

  function loadVideo(file) {
    return new Promise((resolve, reject) => {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.onerror = () => reject(new Error("Could not open " + file.name));
      v.onloadedmetadata = () => {
        if (Number.isFinite(v.duration)) return resolve(v);
        // Browser-recorded WebM has no length in its header: seek to the end to learn it.
        const done = () => {
          if (!Number.isFinite(v.duration)) return;
          v.removeEventListener("durationchange", done);
          v.currentTime = 0;
          resolve(v);
        };
        v.addEventListener("durationchange", done);
        v.currentTime = 1e9;
        setTimeout(() => resolve(v), 4000);
      };
      v.src = URL.createObjectURL(file);
    });
  }

  async function soundEnvelope(file) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      const data = buf.getChannelData(0);
      ctx.close && ctx.close();
      return WG.envelope(data, buf.sampleRate, 1000);
    } catch {
      return null;
    }
  }

  function seekTo(video, t) {
    return new Promise((resolve) => {
      const done = () => {
        video.removeEventListener("seeked", done);
        resolve();
      };
      video.addEventListener("seeked", done);
      video.currentTime = Math.max(0, Math.min(video.duration - 0.01, t));
      setTimeout(done, 3000);
    });
  }

  // ---------- Moment picker (action + multi-phone) ----------
  function openMoment(m) {
    stopPlayback();
    st.moment = m;
    st.views = [];
    st.crop = null;
    $("editControls").hidden = true;
    $("editActions").hidden = true;
    show("edit");
    $("editEmpty").hidden = true;
    $("momentPanel").hidden = false;
    const r = $("momentRange");
    if (m.kind === "action") {
      $("nudges").innerHTML = "";
      r.min = "0";
      r.max = String(m.frames.length - 1);
      r.step = "1";
      r.value = String(m.frames.length - 1);
      $("momentTitle").textContent = "Pick the moment (ball off the foot, peak of the jump…)";
      $("momentUse").textContent = "Make 3D from this moment";
      $("momentNote").textContent = "One moment, frozen sharp. Depth comes from the scene itself.";
    } else {
      r.min = String(m.t0);
      r.max = String(m.t1);
      r.step = "0.033";
      r.value = String((m.t0 + m.t1) / 2);
      $("momentTitle").textContent = "Pick the moment — every phone jumps to the same instant";
      $("momentUse").textContent = "Use this moment from every phone";
      // Fine-tune: if one phone's sound and picture are slightly out, nudge it by whole frames.
      const box = $("nudges");
      box.innerHTML = "";
      m.videos.forEach((_, i) => {
        if (i === 0) return;
        const row = document.createElement("div");
        row.className = "nudge";
        row.innerHTML = `<span>Phone ${i + 1}</span><button type="button" class="ghost-btn">−1 frame</button><output>0</output><button type="button" class="ghost-btn">+1 frame</button>`;
        const [minus, plus] = row.querySelectorAll("button");
        const out = row.querySelector("output");
        let n = 0;
        const apply = (d) => {
          n += d;
          m.lags[i] -= d / 30;
          out.textContent = (n > 0 ? "+" : "") + n;
        };
        minus.addEventListener("click", () => apply(-1));
        plus.addEventListener("click", () => apply(1));
        box.appendChild(row);
      });
    }
    showMoment();
  }

  let momentBusy = false;
  async function showMoment() {
    const m = st.moment;
    if (!m || momentBusy) return;
    momentBusy = true;
    const c = $("preview");
    let src;
    if (m.kind === "action") src = m.frames[+$("momentRange").value];
    else {
      const v = m.videos[0];
      await seekTo(v, +$("momentRange").value - m.lags[0]);
      src = v;
    }
    const sw = src.videoWidth || src.width;
    const sh = src.videoHeight || src.height;
    const k = Math.min(1, 720 / Math.max(sw, sh));
    c.width = Math.round(sw * k);
    c.height = Math.round(sh * k);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    $("focusDot").style.display = "none";
    momentBusy = false;
  }
  $("momentRange").addEventListener("input", showMoment);
  const nudge = (dir) => {
    const r = $("momentRange");
    r.value = String(Math.min(+r.max, Math.max(+r.min, +r.value + dir * +r.step)));
    showMoment();
  };
  $("momentPrev").addEventListener("click", () => nudge(-1));
  $("momentNext").addEventListener("click", () => nudge(1));

  $("momentUse").addEventListener("click", async () => {
    const m = st.moment;
    if (!m) return;
    $("momentUse").disabled = true;
    try {
      if (m.kind === "action") {
        const frame = m.frames[+$("momentRange").value];
        const views = await depthViews(frame);
        $("momentPanel").hidden = true;
        await loadFrames(views, true);
      } else {
        busy(true, "Grabbing the same instant from every phone…");
        const t = +$("momentRange").value;
        const frames = [];
        for (let i = 0; i < m.videos.length; i++) {
          const v = m.videos[i];
          await seekTo(v, t - m.lags[i]);
          const k = Math.min(1, S.longEdge / Math.max(v.videoWidth, v.videoHeight));
          const c = document.createElement("canvas");
          c.width = Math.round(v.videoWidth * k);
          c.height = Math.round(v.videoHeight * k);
          c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
          frames.push(c);
        }
        // Different phones, different sizes: match everything to the first.
        const W = frames[0].width;
        const H = frames[0].height;
        const same = frames.map((f) => {
          if (f.width === W && f.height === H) return f;
          const c = document.createElement("canvas");
          c.width = W;
          c.height = H;
          const s2 = Math.max(W / f.width, H / f.height);
          c.getContext("2d").drawImage(f, (W - f.width * s2) / 2, (H - f.height * s2) / 2, f.width * s2, f.height * s2);
          return c;
        });
        busy(false);
        $("momentPanel").hidden = true;
        await loadFrames(same, true);
      }
    } catch (err) {
      busy(false);
      toast(err.message || "That moment could not be used.");
    } finally {
      $("momentUse").disabled = false;
    }
  });

  /** Seven viewpoints from one frame, using depth: people pop out, the ground and sky fall back. */
  async function depthViews(frame) {
    busy(true, "Finding the players…");
    const w = frame.width;
    const h = frame.height;
    const ctx = frame.getContext("2d", { willReadFrequently: true });
    const src = ctx.getImageData(0, 0, w, h).data;
    let mask = await segmentPeople(frame);
    let focus = { x: w / 2, y: h / 2 };
    if (mask) {
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        sx += i % w;
        sy += (i / w) | 0;
        n++;
      }
      if (n < w * h * 0.002) mask = null;
      else focus = { x: sx / n, y: sy / n };
    }
    busy(true, mask ? "Adding depth around the players…" : "Adding depth…");
    await nextPaint();
    const depth = WG.makeDepth(mask, w, h, focus);
    const fd = depth[Math.round(focus.y) * w + Math.round(focus.x)];
    const amp = w * 0.045;
    const N = 7;
    const out = [];
    for (let k = 0; k < N; k++) {
      const shift = amp * ((k / (N - 1)) * 2 - 1);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").putImageData(new ImageData(WG.depthView(src, w, h, depth, shift, fd), w, h), 0, 0);
      out.push(c);
      await sleep(0);
    }
    if (!mask) toast("No players found (or offline): depth is estimated from the scene.");
    busy(false);
    return out;
  }

  // On-device AI (MediaPipe DeepLab): which pixels are people (and other objects). Null if unavailable.
  let segmenter = null;
  async function segmentPeople(canvas) {
    try {
      if (!segmenter) {
        segmenter = (async () => {
          const base = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
          const vision = await import(base + "/vision_bundle.mjs");
          const fileset = await vision.FilesetResolver.forVisionTasks(base + "/wasm");
          return vision.ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite" },
            outputCategoryMask: true,
            outputConfidenceMasks: false,
            runningMode: "IMAGE",
          });
        })();
      }
      const seg = await Promise.race([segmenter, sleep(15000).then(() => null)]);
      if (!seg) return null;
      return await new Promise((resolve) => {
        seg.segment(canvas, (result) => {
          const m = result && result.categoryMask;
          if (!m) return resolve(null);
          const raw = m.getAsUint8Array();
          const out = new Uint8Array(canvas.width * canvas.height);
          for (let y = 0; y < canvas.height; y++) {
            const my = Math.min(m.height - 1, Math.floor((y / canvas.height) * m.height));
            for (let x = 0; x < canvas.width; x++) {
              const mx = Math.min(m.width - 1, Math.floor((x / canvas.width) * m.width));
              out[y * canvas.width + x] = raw[my * m.width + mx] > 0 ? 1 : 0; // 0 = background
            }
          }
          resolve(out);
        });
      });
    } catch {
      segmenter = null;
      return null;
    }
  }

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
    $("editEmpty").hidden = true;
    $("momentPanel").hidden = true;
    $("editControls").hidden = false;
    $("editActions").hidden = false;
    st.moment = null;
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
      const fastest = Math.max(...shifts.map((v) => Math.abs(v)));
      if (travel < 3) toast("The phone barely moved. Slide it further next time for more depth.");
      else if (fastest > st.small[0].w * 0.12) toast("That sweep was fast — slide a little slower for sharper frames.");
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

  /**
   * Lock every view onto the focus point. Five small patches on the subject are tracked, and a
   * rotation + zoom + shift is fitted to them, so a phone that tilts or drifts closer during the
   * sweep still gives a rock-steady subject. Brightness is evened out between views as well.
   */
  function align() {
    const W = st.frames[0].width;
    const H = st.frames[0].height;
    const refS = st.small[st.ref];
    const refM = st.mid[st.ref];
    const sS = refS.w / W;
    const sM = refM.w / W;
    const k = refM.w / refS.w;
    const R = W * 0.09;
    const pts = [
      { x: 0, y: 0 },
      { x: -R, y: -R },
      { x: R, y: -R },
      { x: -R, y: R },
      { x: R, y: R },
    ].map((o) => ({ x: clamp(st.focus.x + o.x, W * 0.06, W * 0.94), y: clamp(st.focus.y + o.y, H * 0.06, H * 0.94) }));
    const pm = refM.w * 0.11;
    const expRect = { x: st.focus.x * sM - refM.w * 0.12, y: st.focus.y * sM - refM.w * 0.12, w: refM.w * 0.24, h: refM.w * 0.24 };
    const refMean = WG.meanIn(refM.gray, refM.w, refM.h, expRect) || 1;

    st.transforms = [];
    st.gains = [];
    for (const i of st.views) {
      if (i === st.ref) {
        st.transforms.push({ a: 1, b: 0, tx: 0, ty: 0 });
        st.gains.push(1);
        continue;
      }
      // Coarse: whole subject patch on the small image, two starting guesses.
      const pw = refS.w * 0.26;
      const rectS = { x: st.focus.x * sS - pw / 2, y: st.focus.y * sS - pw / 2, w: pw, h: pw };
      const travel = (st.positions[i] - st.positions[st.ref]) || 0;
      let coarse = WG.estimateShift(refS.g, st.small[i].g, refS.w, refS.h, rectS, { dx: 0, dy: 0 }, 22, 1);
      if (Math.abs(travel) > 6) {
        const alt = WG.estimateShift(refS.g, st.small[i].g, refS.w, refS.h, rectS, { dx: travel, dy: 0 }, 22, 1);
        if (alt.cost < coarse.cost) coarse = alt;
      }
      // Fine: each patch on the mid image, around the coarse answer.
      const ps = [];
      const qs = [];
      const ws = [];
      let centre = null;
      pts.forEach((p, n) => {
        const cx = p.x * sM;
        const cy = p.y * sM;
        const size = n === 0 ? refM.w * 0.2 : pm;
        const rect = { x: cx - size / 2, y: cy - size / 2, w: size, h: size };
        // Flat patches (plain skin, a white wall) cannot be matched reliably: leave them out.
        if (n > 0 && WG.textureIn(refM.g, refM.w, refM.h, rect) < 4) return;
        const f = WG.estimateShift(refM.g, st.mid[i].g, refM.w, refM.h, rect, { dx: coarse.dx * k, dy: coarse.dy * k }, n === 0 ? 3 : 6, 1);
        if (!Number.isFinite(f.cost)) return;
        if (n === 0) centre = f;
        else if (centre) {
          // A patch that moved very differently from the centre is background (parallax), not subject.
          const off = Math.hypot(f.dx - centre.dx, f.dy - centre.dy);
          if (off > R * sM * 0.15 + 2) return;
        }
        ps.push({ x: cx, y: cy });
        qs.push({ x: cx + f.dx, y: cy + f.dy });
        ws.push(n === 0 ? 3 : 1);
      });
      let T = ps.length >= 3 ? WG.fitSimilarity(ps, qs, ws) : { a: 1, b: 0, tx: (centre ? centre.dx : coarse.dx * k), ty: (centre ? centre.dy : coarse.dy * k) };
      // Refine: undo the estimated tilt and zoom, measure what is left, correct. Twice.
      if (ps.length >= 3) {
        for (let pass = 0; pass < 2; pass++) {
          const warped = WG.gradient(WG.warpGray(st.mid[i].gray, refM.w, refM.h, T), refM.w, refM.h);
          const rp = [];
          const rq = [];
          const rw = [];
          ps.forEach((p, n) => {
            const size = n === 0 ? refM.w * 0.2 : pm;
            const rect = { x: p.x - size / 2, y: p.y - size / 2, w: size, h: size };
            const f = WG.estimateShift(refM.g, warped, refM.w, refM.h, rect, { dx: 0, dy: 0 }, 2, 1);
            if (!Number.isFinite(f.cost)) return;
            rp.push(p);
            rq.push({ x: p.x + f.dx, y: p.y + f.dy });
            rw.push(ws[n]);
          });
          if (rp.length < 3) break;
          T = WG.composeSim(T, WG.fitSimilarity(rp, rq, rw));
        }
      }
      // Mid-image coordinates -> frame coordinates (same rotation/zoom, shift rescaled).
      st.transforms.push({ a: T.a, b: T.b, tx: T.tx / sM, ty: T.ty / sM });
      const c = centre || { dx: coarse.dx * k, dy: coarse.dy * k };
      const m = WG.meanIn(st.mid[i].gray, refM.w, refM.h, { x: expRect.x + c.dx, y: expRect.y + c.dy, w: expRect.w, h: expRect.h });
      st.gains.push(m > 1 ? clamp(refMean / m, 0.8, 1.25) : 1);
    }
    // Kept for diagnostics: where the focus point lands in each view.
    st.offsets = st.transforms.map((T) => {
      const q = WG.applySim(T, st.focus);
      return { dx: q.x - st.focus.x, dy: q.y - st.focus.y };
    });
    st.baseCrop = WG.commonCropSim(st.transforms, W, H);
    applyAspect();
  }

  function applyAspect() {
    st.crop = WG.fitAspect(st.baseCrop, st.aspect, st.focus);
    $("editEmpty").hidden = true;
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
  const canFilter = (() => {
    try {
      const c = document.createElement("canvas").getContext("2d");
      return !!c && "filter" in c;
    } catch {
      return false;
    }
  })();

  function drawEntry(ctx, entry, w, h, frameNo) {
    const crop = st.crop;
    const kk = w / crop.w;
    const draw = (viewIndex, alpha) => {
      const f = st.frames[st.views[viewIndex]];
      const inv = WG.invertSim(st.transforms[viewIndex]);
      const gain = st.gains[viewIndex] || 1;
      ctx.globalAlpha = alpha;
      if (canFilter) ctx.filter = Math.abs(gain - 1) > 0.01 ? `brightness(${gain.toFixed(3)})` : "none";
      ctx.setTransform(kk * inv.a, kk * inv.b, -kk * inv.b, kk * inv.a, kk * (inv.tx - crop.x), kk * (inv.ty - crop.y));
      ctx.drawImage(f, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (canFilter) ctx.filter = "none";
    };
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    draw(entry.a, 1);
    if (entry.t > 0) draw(entry.b, entry.t);
    ctx.globalAlpha = 1;
    if (S.film) drawFilm(ctx, w, h, frameNo == null ? st.step : frameNo);
    drawBranding(ctx, w, h);
  }

  // Film look: warm tone, soft vignette and moving grain, like a print from an analogue 3D camera.
  let grainTile = null;
  function drawFilm(ctx, w, h, n) {
    if (!grainTile) {
      grainTile = document.createElement("canvas");
      grainTile.width = grainTile.height = 256;
      const g = grainTile.getContext("2d");
      const img = g.createImageData(256, 256);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 128 + (Math.random() - 0.5) * 120;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    }
    ctx.save();
    ctx.globalCompositeOperation = "soft-light";
    ctx.fillStyle = "rgba(255,170,90,0.35)";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.22;
    const pat = ctx.createPattern(grainTile, "repeat");
    if (pat) {
      const ox = (n * 97) % 256;
      const oy = (n * 57) % 256;
      ctx.translate(-ox, -oy);
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, w + 256, h + 256);
      ctx.translate(ox, oy);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "multiply";
    const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6);
    v.addColorStop(0, "rgba(255,255,255,1)");
    v.addColorStop(1, "rgba(60,50,45,1)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
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

  const filmBtn = $("filmBtn");
  const syncFilm = () => {
    filmBtn.classList.toggle("on", !!S.film);
    filmBtn.textContent = S.film ? "Film look: on" : "Film look: off";
  };
  syncFilm();
  filmBtn.addEventListener("click", () => {
    S.film = !S.film;
    saveSettings();
    syncFilm();
    drawCurrent();
  });

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
      drawEntry(ctx, st.timeline[i % st.timeline.length], w, h, i);
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
    for (const [n, entry] of st.timeline.entries()) {
      drawEntry(ctx, entry, w, h, n);
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
    const free = rows.filter((r) => r.status === "free").length;
    const extra = [unpaid ? `${unpaid} owing` : "", free ? `${free} free` : ""].filter(Boolean).join(" · ");
    $("totals").innerHTML = `<div><b>${rows.length}</b><span>clips</span></div><div><b>${paid}</b><span>paid${
      extra ? ` · ${extra}` : ""
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
  window.__wg = { loadFrames, state: st, openMoment, depthViews, setMode };
})();
