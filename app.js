/* ═══════════════════════════════════════════════════════
   app.js — Main application script for Mirage Vision PWA
   Handles UI, camera, file upload, and worker messaging.
   ═══════════════════════════════════════════════════════ */

// ══════════ DOM References ══════════
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const initOverlay    = $('#init-overlay');
const initStatus     = $('#init-status');
const initProgress   = $('#init-progress');
const initDetail     = $('#init-detail');
const initError      = $('#init-error');
const initErrorMsg   = $('#init-error-msg');
const btnRetry       = $('#btn-retry');

const mainContent    = $('#main-content');
const statusBadge    = $('#status-badge');

const tabs           = $$('.tab');
const panelUpload    = $('#panel-upload');
const panelCamera    = $('#panel-camera');

const dropZone       = $('#drop-zone');
const fileInput      = $('#file-input');

const cameraVideo    = $('#camera-video');
const cameraSnap     = $('#camera-snap');
const btnFlip        = $('#btn-flip');
const btnCapture     = $('#btn-capture');

const resultsSection = $('#results-section');
const previewCanvas  = $('#preview-canvas');
const inferenceTimer = $('#inference-timer');
const cardScene      = $('#card-scene');
const sceneText      = $('#scene-text');
const cardObjects    = $('#card-objects');
const objectsList    = $('#objects-list');
const cardOcr        = $('#card-ocr');
const ocrText        = $('#ocr-text');
const cardRaw        = $('#card-raw');
const rawJson        = $('#raw-json');
const btnClear       = $('#btn-clear');
const btnNew         = $('#btn-new');

const btnSettings    = $('#btn-settings');
const settingsModal  = $('#settings-modal');
const btnCloseSettings = $('#btn-close-settings');
const btnClearCache  = $('#btn-clear-cache');
const btnWipe        = $('#btn-wipe');
const chkDiagnostics = $('#chk-diagnostics');
const diagPanel      = $('#diag-panel');
const diagPanelText  = $('#diag-panel-text');
const btnCloseDiag   = $('#btn-close-diag');

// ══════════ State ══════════
let worker = null;
let engineReady = false;
let cameraStream = null;
let facingMode = 'environment'; // rear camera
let currentImageUrl = null;
let diagLogs = [];

// ══════════ Diagnostic Logging ══════════
function diag(msg) {
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${msg}`;
  diagLogs.push(line);
  if (diagLogs.length > 500) diagLogs.shift();
  if (diagPanelText) {
    diagPanelText.textContent = diagLogs.join('\n');
    diagPanelText.scrollTop = diagPanelText.scrollHeight;
  }
  console.log(line);
}

// ══════════ Service Worker Registration ══════════
async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      diag(`Service Worker registered (scope: ${reg.scope})`);
    } catch (err) {
      diag(`SW registration failed: ${err.message}`);
    }
  }
}

// ══════════ Web Worker Setup ══════════
function initWorker() {
  worker = new Worker('./worker.js?v=3');

  worker.onmessage = (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'LOG':
        diag(msg.message);
        break;
      case 'STATUS':
        handleWorkerStatus(msg);
        break;
      case 'DOWNLOAD_PROGRESS':
        handleDownloadProgress(msg);
        break;
      case 'RESULT':
        handleInferenceResult(msg);
        break;
      case 'CACHE_CLEARED':
        diag('Model cache cleared');
        statusBadge.textContent = 'Cache Cleared';
        statusBadge.className = 'badge badge-loading';
        break;
      case 'RESET_DONE':
        diag('Session memory wiped');
        break;
    }
  };

  worker.onerror = (err) => {
    diag(`Worker error: ${err.message}`);
    showInitError(`Worker crashed: ${err.message}`);
  };

  // Kick off init
  worker.postMessage({ type: 'INIT' });
}

// ── Worker Status ──
function handleWorkerStatus(msg) {
  diag(`Engine status: ${msg.status} — ${msg.message}`);
  initStatus.textContent = msg.message;

  if (msg.status === 'ready') {
    engineReady = true;
    statusBadge.textContent = 'Ready';
    statusBadge.className = 'badge badge-ready';
    initOverlay.hidden = true;
    mainContent.hidden = false;
  } else if (msg.status === 'error') {
    showInitError(msg.message);
  } else if (msg.status === 'loading') {
    statusBadge.textContent = 'Loading…';
    statusBadge.className = 'badge badge-loading';
  }
}

// ── Download Progress ──
const downloadState = {};
function handleDownloadProgress(msg) {
  downloadState[msg.label] = msg;

  // Calculate overall progress
  const labels = Object.keys(downloadState);
  const weights = { 'cactus.js': 1, 'cactus.wasm': 5, 'mirage.cact': 94 };
  let totalPct = 0;

  for (const label of labels) {
    const s = downloadState[label];
    const w = weights[label] || 1;
    if (s.done || s.fromCache) {
      totalPct += w;
    } else if (s.total > 0) {
      totalPct += w * (s.loaded / s.total);
    }
  }

  const pct = Math.min(100, Math.round(totalPct));
  initProgress.style.width = pct + '%';

  if (!msg.done && !msg.fromCache && msg.total > 0) {
    const mb = (msg.loaded / 1024 / 1024).toFixed(1);
    const totalMb = (msg.total / 1024 / 1024).toFixed(1);
    initDetail.textContent = `${msg.label}: ${mb} / ${totalMb} MB`;
  } else if (msg.done) {
    initDetail.textContent = msg.fromCache
      ? `${msg.label}: loaded from cache ✓`
      : `${msg.label}: download complete ✓`;
  }
}

// ── Init Error ──
function showInitError(message) {
  statusBadge.textContent = 'Error';
  statusBadge.className = 'badge badge-error';
  initError.hidden = false;
  initErrorMsg.textContent = message;
}

// ══════════ Tab Switching ══════════
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    tabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');

    panelUpload.hidden = target !== 'upload';
    panelCamera.hidden = target !== 'camera';

    if (target === 'camera') {
      startCamera();
    } else {
      stopCamera();
    }
  });
});

// ══════════ File Upload / Drag & Drop ══════════
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});

fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) processImageFile(file);
  fileInput.value = '';
});

// Drag events
['dragenter', 'dragover'].forEach((ev) => {
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    dropZone.classList.add('drag-over');
  });
});
['dragleave', 'drop'].forEach((ev) => {
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    dropZone.classList.remove('drag-over');
  });
});
dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type.startsWith('image/')) processImageFile(file);
});

// ══════════ Camera ══════════
async function startCamera() {
  try {
    if (cameraStream) stopCamera();
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    cameraVideo.srcObject = cameraStream;
    diag(`Camera started (${facingMode})`);
  } catch (err) {
    diag(`Camera error: ${err.message}`);
    alert('Camera access denied or unavailable. Please use file upload instead.');
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
    cameraVideo.srcObject = null;
  }
}

btnFlip.addEventListener('click', () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  startCamera();
});

btnCapture.addEventListener('click', () => {
  if (!cameraStream) return;
  const ctx = cameraSnap.getContext('2d');
  cameraSnap.width = cameraVideo.videoWidth;
  cameraSnap.height = cameraVideo.videoHeight;
  ctx.drawImage(cameraVideo, 0, 0);
  const dataUrl = cameraSnap.toDataURL('image/jpeg', 0.85);
  processImageDataUrl(dataUrl);
});

// ══════════ Image Processing ══════════
function processImageFile(file) {
  if (!engineReady) {
    alert('Mirage engine is still loading. Please wait…');
    return;
  }
  diag(`Processing file: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);

  const reader = new FileReader();
  reader.onload = () => {
    processImageDataUrl(reader.result);
  };
  reader.readAsDataURL(file);
}

function processImageDataUrl(dataUrl) {
  if (!engineReady) return;

  const img = new Image();
  img.onload = () => {
    showPreview(img);

    // Convert image to RGB Uint8Array for cactus_describe(rgb, width, height, ...)
    // Limit dimensions to max 512 for fast on-device inference
    const maxDim = 512;
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (w > maxDim || h > maxDim) {
      if (w > h) {
        h = Math.round((h * maxDim) / w);
        w = maxDim;
      } else {
        w = Math.round((w * maxDim) / h);
        h = maxDim;
      }
    }

    const offCanvas = document.createElement('canvas');
    offCanvas.width = w;
    offCanvas.height = h;
    const offCtx = offCanvas.getContext('2d');
    offCtx.drawImage(img, 0, 0, w, h);
    const imgData = offCtx.getImageData(0, 0, w, h).data; // RGBA

    // Convert RGBA to RGB (strip Alpha channel)
    const rgbBytes = new Uint8Array(w * h * 3);
    let j = 0;
    for (let i = 0; i < imgData.length; i += 4) {
      rgbBytes[j++] = imgData[i];     // R
      rgbBytes[j++] = imgData[i + 1]; // G
      rgbBytes[j++] = imgData[i + 2]; // B
    }

    sendToWorker(rgbBytes, w, h);

    if (currentImageUrl) {
      URL.revokeObjectURL(currentImageUrl);
      currentImageUrl = null;
    }
  };
  img.src = dataUrl;
}

function showPreview(img) {
  const ctx = previewCanvas.getContext('2d');
  const maxW = Math.min(640, window.innerWidth - 32);
  const scale = maxW / img.naturalWidth;
  previewCanvas.width = img.naturalWidth * scale;
  previewCanvas.height = img.naturalHeight * scale;
  ctx.drawImage(img, 0, 0, previewCanvas.width, previewCanvas.height);

  resultsSection.hidden = false;
  inferenceTimer.hidden = true;
  inferenceTimer.textContent = '';

  // Clear previous results
  cardScene.hidden = true;
  cardObjects.hidden = true;
  cardOcr.hidden = true;
  cardRaw.hidden = true;
  objectsList.innerHTML = '';

  // Scroll to results
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function sendToWorker(rgbBytes, width, height) {
  statusBadge.textContent = 'Analyzing…';
  statusBadge.className = 'badge badge-running';

  // Transfer array buffer for zero-copy performance
  worker.postMessage({
    type: 'INFER',
    rgbBytes,
    width,
    height
  }, [rgbBytes.buffer]);
}

// ══════════ Inference Result Handling ══════════
function handleInferenceResult(msg) {
  statusBadge.textContent = 'Ready';
  statusBadge.className = 'badge badge-ready';

  if (msg.error) {
    diag(`Inference error: ${msg.error}`);
    sceneText.textContent = `Error: ${msg.error}`;
    cardScene.hidden = false;
    inferenceTimer.textContent = `${msg.inferenceMs}ms (error)`;
    inferenceTimer.hidden = false;
    return;
  }

  const result = msg.result;
  diag(`Inference result received (${msg.inferenceMs}ms)`);

  // Show inference time
  inferenceTimer.textContent = `⚡ ${msg.inferenceMs}ms`;
  inferenceTimer.hidden = false;

  // Parse structured output from Mirage
  displayResults(result, msg.raw);
}

function displayResults(result, rawText) {
  // ── Scene Description ──
  let description = '';
  if (result.scene && typeof result.scene === 'object') {
    description = Object.values(result.scene).filter(Boolean).join('. ');
  }
  if (!description) {
    description = result.description || result.scene_description ||
      result.scene || result.caption || result.summary || result.reasoning ||
      (typeof result === 'string' ? result : null);
  }

  if (description) {
    sceneText.textContent = description;
    cardScene.hidden = false;
  }

  // ── Detected Objects ──
  const objects = result.objects || result.detections || result.entities || [];
  if (objects.length > 0) {
    objectsList.innerHTML = '';
    objects.forEach((obj) => {
      const name = obj.name || obj.label || obj.class || 'unknown';
      const conf = obj.confidence || obj.score || obj.conf;
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `${name}${conf != null ? `<span class="conf">${(conf * 100).toFixed(0)}%</span>` : ''}`;
      objectsList.appendChild(chip);

      // Draw bounding box on canvas
      if (obj.bbox || obj.bounding_box || obj.box) {
        drawBoundingBox(obj.bbox || obj.bounding_box || obj.box, name, conf);
      }
    });
    cardObjects.hidden = false;
  }

  // ── OCR Text ──
  let text = '';
  if (Array.isArray(result.text)) {
    text = result.text.map(t => {
      const str = t.string || t.text || t.content || '';
      const sc = t.score != null ? ` (${(t.score * 100).toFixed(0)}%)` : '';
      return `${str}${sc}`;
    }).filter(Boolean).join('\n');

    // Also draw bounding boxes for text regions
    result.text.forEach(t => {
      if (t.bbox) {
        drawBoundingBox(t.bbox, t.string || 'text', t.score, '#3fb950');
      }
    });
  } else {
    text = result.text || result.ocr || result.extracted_text ||
      (result.text_regions && result.text_regions.map((r) => r.text || r.content).join('\n'));
  }

  if (text) {
    ocrText.textContent = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
    cardOcr.hidden = false;
  }

  // ── Raw JSON ──
  rawJson.textContent = typeof rawText === 'string' ? rawText : JSON.stringify(result, null, 2);
  cardRaw.hidden = false;
}

function drawBoundingBox(bbox, label, confidence, color = '#58a6ff') {
  const ctx = previewCanvas.getContext('2d');
  const w = previewCanvas.width;
  const h = previewCanvas.height;

  // Mirage uses 0-1000 normalized coords: [x1, y1, x2, y2]
  let x1, y1, x2, y2;
  if (Array.isArray(bbox)) {
    [x1, y1, x2, y2] = bbox;
  } else {
    x1 = bbox.x1 || bbox.left || bbox.x || 0;
    y1 = bbox.y1 || bbox.top || bbox.y || 0;
    x2 = bbox.x2 || bbox.right || (bbox.x + bbox.width) || 0;
    y2 = bbox.y2 || bbox.bottom || (bbox.y + bbox.height) || 0;
  }

  // Convert from 0-1000 to canvas pixels
  const scale = Math.max(x1, y1, x2, y2) > 10 ? 1000 : 1;
  const px1 = (x1 / scale) * w;
  const py1 = (y1 / scale) * h;
  const px2 = (x2 / scale) * w;
  const py2 = (y2 / scale) * h;

  // Draw box
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(px1, py1, px2 - px1, py2 - py1);

  // Draw label
  const text = `${label}${confidence != null ? ` ${(confidence * 100).toFixed(0)}%` : ''}`;
  ctx.font = `bold ${Math.max(11, Math.round(h * 0.025))}px ${getComputedStyle(document.body).fontFamily}`;
  const metrics = ctx.measureText(text);
  const pad = 4;
  const labelH = 18;

  ctx.fillStyle = color === '#3fb950' ? 'rgba(63, 185, 80, 0.85)' : 'rgba(88, 166, 255, 0.85)';
  ctx.fillRect(px1, Math.max(0, py1 - labelH - pad), metrics.width + pad * 2, labelH + pad);

  ctx.fillStyle = '#000';
  ctx.fillText(text, px1 + pad, Math.max(labelH, py1 - pad - 2));
}

// ══════════ Clear / New Actions ══════════
btnClear.addEventListener('click', () => {
  resultsSection.hidden = true;
  if (currentImageUrl) {
    URL.revokeObjectURL(currentImageUrl);
    currentImageUrl = null;
  }
  worker.postMessage({ type: 'RESET' });
  diag('Session cleared');
});

btnNew.addEventListener('click', () => {
  resultsSection.hidden = true;
  if (currentImageUrl) {
    URL.revokeObjectURL(currentImageUrl);
    currentImageUrl = null;
  }
});

// ══════════ Settings Modal ══════════
btnSettings.addEventListener('click', () => { settingsModal.hidden = false; });
btnCloseSettings.addEventListener('click', () => { settingsModal.hidden = true; });
$('.modal-backdrop')?.addEventListener('click', () => { settingsModal.hidden = true; });

btnClearCache.addEventListener('click', async () => {
  if (!confirm('This will delete the cached Mirage model (~22 MB). You\'ll need to re-download it next time.')) return;
  worker.postMessage({ type: 'CLEAR_CACHE' });
  // Also clear SW caches
  const keys = await caches.keys();
  for (const k of keys) {
    if (k.includes('model')) await caches.delete(k);
  }
  diag('All model caches cleared');
  alert('Model cache cleared. Reload to re-download.');
});

btnWipe.addEventListener('click', () => {
  worker.postMessage({ type: 'RESET' });
  resultsSection.hidden = true;
  diagLogs = [];
  if (diagPanelText) diagPanelText.textContent = '';
  diag('All session memory wiped');
  alert('Session memory wiped.');
});

chkDiagnostics.addEventListener('change', () => {
  diagPanel.hidden = !chkDiagnostics.checked;
});

btnCloseDiag?.addEventListener('click', () => {
  diagPanel.hidden = true;
  chkDiagnostics.checked = false;
});

// ══════════ Retry ══════════
btnRetry?.addEventListener('click', () => {
  initError.hidden = true;
  initStatus.textContent = 'Retrying…';
  initProgress.style.width = '0%';
  initDetail.textContent = '';
  worker.postMessage({ type: 'INIT' });
});

// ══════════ Boot ══════════
async function boot() {
  diag('Mirage Vision PWA booting…');
  await registerSW();
  initWorker();
}

boot();
