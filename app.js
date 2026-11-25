// ======================
// Wigglegram Maker - App Logic
// ======================

const leftInput = document.getElementById('leftInput');
const rightInput = document.getElementById('rightInput');
const leftBox = document.getElementById('leftBox');
const rightBox = document.getElementById('rightBox');
const leftContent = document.getElementById('leftContent');
const rightContent = document.getElementById('rightContent');
const leftPreview = document.getElementById('leftPreview');
const rightPreview = document.getElementById('rightPreview');

const alignSection = document.getElementById('alignSection');
const previewSection = document.getElementById('previewSection');
const offsetX = document.getElementById('offsetX');
const offsetY = document.getElementById('offsetY');
const offsetXValue = document.getElementById('offsetXValue');
const offsetYValue = document.getElementById('offsetYValue');
const speedInput = document.getElementById('speed');
const speedValue = document.getElementById('speedValue');
const playBtn = document.getElementById('playBtn');
const downloadBtn = document.getElementById('downloadBtn');
const canvas = document.getElementById('wiggleCanvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');

let leftImg = null;
let rightImg = null;
let isPlaying = true;
let animationId = null;
let currentFrame = 0; // 0 = left, 1 = right
let lastSwitch = 0;
let canvasWidth = 0;
let canvasHeight = 0;

// ======================
// Upload handling
// ======================

function setupUpload(box, input, content, preview, isLeft) {
  box.addEventListener('click', () => input.click());

  box.addEventListener('dragover', (e) => {
    e.preventDefault();
    box.classList.add('dragover');
  });

  box.addEventListener('dragleave', () => {
    box.classList.remove('dragover');
  });

  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      loadImage(file, isLeft);
    }
  });

  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadImage(file, isLeft);
  });
}

setupUpload(leftBox, leftInput, leftContent, leftPreview, true);
setupUpload(rightBox, rightInput, rightContent, rightPreview, false);

function loadImage(file, isLeft) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      if (isLeft) {
        leftImg = img;
        leftPreview.src = e.target.result;
        leftPreview.hidden = false;
        leftContent.hidden = true;
      } else {
        rightImg = img;
        rightPreview.src = e.target.result;
        rightPreview.hidden = false;
        rightContent.hidden = true;
      }
      checkReady();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function checkReady() {
  if (leftImg && rightImg) {
    alignSection.hidden = false;
    previewSection.hidden = false;
    setupCanvas();
    startAnimation();
    setStatus('Ready! Adjust alignment then download.');
  }
}

// ======================
// Canvas & Alignment
// ======================

function setupCanvas() {
  // Use the smaller dimensions so both images fit
  const maxW = Math.min(leftImg.width, rightImg.width, 800);
  const scale = maxW / Math.max(leftImg.width, rightImg.width);
  
  canvasWidth = Math.round(Math.min(leftImg.width, rightImg.width) * (maxW / Math.max(leftImg.width, rightImg.width)));
  canvasHeight = Math.round(Math.min(leftImg.height, rightImg.height) * (maxW / Math.max(leftImg.width, rightImg.width)));

  // Better approach: make canvas the size of the left image (scaled)
  const targetWidth = Math.min(leftImg.width, 900);
  const ratio = targetWidth / leftImg.width;
  canvasWidth = targetWidth;
  canvasHeight = Math.round(leftImg.height * ratio);

  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
}

function drawFrame(showLeft) {
  if (!leftImg || !rightImg) return;

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const ox = parseInt(offsetX.value) || 0;
  const oy = parseInt(offsetY.value) || 0;

  if (showLeft) {
    // Draw left image scaled to canvas
    ctx.drawImage(leftImg, 0, 0, canvasWidth, canvasHeight);
  } else {
    // Draw right image with offset, scaled
    ctx.drawImage(
      rightImg,
      ox, oy,
      canvasWidth, canvasHeight
    );
  }
}

// ======================
// Animation Loop
// ======================

function animate(timestamp) {
  if (!isPlaying) {
    animationId = requestAnimationFrame(animate);
    return;
  }

  const speed = parseInt(speedInput.value) || 120;

  if (timestamp - lastSwitch >= speed) {
    currentFrame = 1 - currentFrame;
    lastSwitch = timestamp;
  }

  drawFrame(currentFrame === 0);
  animationId = requestAnimationFrame(animate);
}

function startAnimation() {
  if (animationId) cancelAnimationFrame(animationId);
  lastSwitch = performance.now();
  currentFrame = 0;
  isPlaying = true;
  playBtn.textContent = 'Pause';
  animationId = requestAnimationFrame(animate);
}

// ======================
// Controls
// ======================

offsetX.addEventListener('input', () => {
  offsetXValue.textContent = offsetX.value;
});

offsetY.addEventListener('input', () => {
  offsetYValue.textContent = offsetY.value;
});

speedInput.addEventListener('input', () => {
  speedValue.textContent = speedInput.value;
});

playBtn.addEventListener('click', () => {
  isPlaying = !isPlaying;
  playBtn.textContent = isPlaying ? 'Pause' : 'Play';
});

// ======================
// GIF Download
// ======================

downloadBtn.addEventListener('click', () => {
  if (!leftImg || !rightImg) return;

  setStatus('Generating GIF... please wait');
  downloadBtn.disabled = true;

  const speed = parseInt(speedInput.value) || 120;
  const ox = parseInt(offsetX.value) || 0;
  const oy = parseInt(offsetY.value) || 0;

  // Create offscreen canvases for frames
  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = canvasWidth;
  frameCanvas.height = canvasHeight;
  const frameCtx = frameCanvas.getContext('2d');

  const gif = new GIF({
    workers: 2,
    quality: 10,
    width: canvasWidth,
    height: canvasHeight,
    workerScript: 'https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js'
  });

  // Add alternating frames (enough for a smooth loop)
  const framesToAdd = 12; // 6 of each

  for (let i = 0; i < framesToAdd; i++) {
    const showLeft = i % 2 === 0;

    frameCtx.fillStyle = '#000';
    frameCtx.fillRect(0, 0, canvasWidth, canvasHeight);

    if (showLeft) {
      frameCtx.drawImage(leftImg, 0, 0, canvasWidth, canvasHeight);
    } else {
      frameCtx.drawImage(rightImg, ox, oy, canvasWidth, canvasHeight);
    }

    gif.addFrame(frameCanvas, { delay: speed, copy: true });
  }

  gif.on('finished', (blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wigglegram-${Date.now()}.gif`;
    a.click();
    URL.revokeObjectURL(url);

    setStatus('GIF downloaded!', 'success');
    downloadBtn.disabled = false;
  });

  gif.on('progress', (p) => {
    setStatus(`Generating GIF... ${Math.round(p * 100)}%`);
  });

  gif.render();
});

// ======================
// Helpers
// ======================

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (type ? ` ${type}` : '');
}

// Initial status
setStatus('Upload a left and right image to begin');
