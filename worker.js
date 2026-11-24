/* ═══════════════════════════════════════════════════════
   worker.js — Cactus WASM Inference Worker
   Runs mirage model off-main-thread for 60fps UI.

   Exact Cactus 4.0.0 WASM API (verified via cactus.h):
     CACTUS_API int cactus_load(const unsigned char* cact, unsigned long long n);
     CACTUS_API int cactus_models(void);
     CACTUS_API int cactus_describe(
         const unsigned char* rgb,
         int width, int height,
         const char* options,
         const char* language,
         const char* keywords,
         char* out, int out_capacity
     );
     CACTUS_API const char* cactus_last_error(void);
     CACTUS_API void cactus_reset(void);
   ═══════════════════════════════════════════════════════ */

const LOCAL_URLS = {
  cactusJs:    './models/cactus.js',
  cactusWasm:  './models/cactus.wasm',
  mirageModel: './models/mirage.cact',
};

const REMOTE_URLS = {
  cactusJs:    'https://huggingface.co/Cactus-Compute/cactus/resolve/main/releases/4.0.0/wasm/cactus.js',
  cactusWasm:  'https://huggingface.co/Cactus-Compute/cactus/resolve/main/releases/4.0.0/wasm/cactus.wasm',
  mirageModel: 'https://huggingface.co/Cactus-Compute/mirage/resolve/main/mirage.cact',
};

const CACHE_NAME = 'mirage-model-v2';
let Module = null;
let modelLoaded = false;

function log(msg) {
  postMessage({ type: 'LOG', message: `[Worker] ${msg}` });
}

// ── Fetch asset with Cache & Progress ──
async function fetchAsset(localUrl, remoteUrl, label) {
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
    for (const url of [localUrl, remoteUrl]) {
      const cached = await cache.match(url);
      if (cached) {
        log(`${label}: loaded from cache`);
        postMessage({ type: 'DOWNLOAD_PROGRESS', label, loaded: 1, total: 1, done: true, fromCache: true });
        return cached;
      }
    }
  } catch (e) {
    log(`${label}: cache unavailable (${e.message})`);
  }

  // Local fetch
  try {
    log(`${label}: fetching local ${localUrl}…`);
    const resp = await fetchWithProgress(localUrl, label);
    if (resp.ok) {
      if (cache) {
        try { await cache.put(localUrl, resp.clone()); } catch {}
      }
      log(`${label}: loaded from local bundle`);
      return resp;
    }
  } catch (e) {
    log(`${label}: local fetch failed (${e.message})`);
  }

  // Remote fetch
  try {
    log(`${label}: fetching remote ${remoteUrl}…`);
    const resp = await fetchWithProgress(remoteUrl, label);
    if (resp.ok) {
      if (cache) {
        try { await cache.put(remoteUrl, resp.clone()); } catch {}
      }
      log(`${label}: downloaded from remote`);
      return resp;
    }
  } catch (e) {
    log(`${label}: remote fetch failed (${e.message})`);
  }

  throw new Error(`${label}: all sources failed.`);
}

async function fetchWithProgress(url, label) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);

  const contentLength = parseInt(resp.headers.get('Content-Length') || '0', 10);
  if (!contentLength || !resp.body) {
    postMessage({ type: 'DOWNLOAD_PROGRESS', label, loaded: 0, total: 0, done: true, fromCache: false });
    return new Response(await resp.arrayBuffer(), {
      status: resp.status,
      headers: resp.headers,
    });
  }

  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    postMessage({
      type: 'DOWNLOAD_PROGRESS',
      label, loaded, total: contentLength, done: false, fromCache: false,
    });
  }

  const body = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }

  postMessage({ type: 'DOWNLOAD_PROGRESS', label, loaded, total: contentLength, done: true, fromCache: false });

  return new Response(body.buffer, {
    status: 200,
    headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/octet-stream' },
  });
}

// ── Initialize Engine ──
async function initEngine() {
  try {
    postMessage({ type: 'STATUS', status: 'loading', message: 'Downloading Cactus runtime…' });

    // 1. Fetch & evaluate cactus.js glue code
    const jsResp = await fetchAsset(LOCAL_URLS.cactusJs, REMOTE_URLS.cactusJs, 'cactus.js');
    const jsText = await jsResp.text();

    const jsBlob = new Blob([jsText], { type: 'text/javascript' });
    const jsBlobUrl = URL.createObjectURL(jsBlob);
    importScripts(jsBlobUrl);
    URL.revokeObjectURL(jsBlobUrl);
    log('cactus.js evaluated');

    // 2. Fetch cactus.wasm
    postMessage({ type: 'STATUS', status: 'loading', message: 'Downloading WASM binary (~1.2 MB)…' });
    const wasmResp = await fetchAsset(LOCAL_URLS.cactusWasm, REMOTE_URLS.cactusWasm, 'cactus.wasm');
    const wasmBinary = await wasmResp.arrayBuffer();
    log(`cactus.wasm ready: ${(wasmBinary.byteLength / 1024 / 1024).toFixed(2)} MB`);

    // 3. Fetch mirage.cact
    postMessage({ type: 'STATUS', status: 'loading', message: 'Downloading Mirage model (~21.6 MB)…' });
    const modelResp = await fetchAsset(LOCAL_URLS.mirageModel, REMOTE_URLS.mirageModel, 'mirage.cact');
    const modelBytes = new Uint8Array(await modelResp.arrayBuffer());
    log(`mirage.cact ready: ${(modelBytes.byteLength / 1024 / 1024).toFixed(2)} MB`);

    // 4. Instantiate WASM module with createCactus
    postMessage({ type: 'STATUS', status: 'loading', message: 'Initializing WebAssembly module…' });
    const factory = self.createCactus || self.createCactusModule || self.Module;
    if (typeof factory !== 'function') {
      throw new Error('createCactus factory function not found in cactus.js');
    }

    Module = await factory({ wasmBinary });
    log('WebAssembly runtime initialized');

    // 5. Load model directly into WASM heap via cactus_load
    postMessage({ type: 'STATUS', status: 'loading', message: 'Loading Mirage model weights…' });
    const modelPtr = Module._malloc(modelBytes.byteLength);
    if (!modelPtr) throw new Error('Failed to allocate memory for model weights in WASM heap');
    
    Module.HEAPU8.set(modelBytes, modelPtr);

    // Call cactus_load(ptr, (unsigned long long)size) using BigInt for 64-bit int
    const rc = Module.ccall(
      'cactus_load',
      'number',
      ['number', 'bigint'],
      [modelPtr, BigInt(modelBytes.byteLength)]
    );
    Module._free(modelPtr);

    if (rc !== 0) {
      const err = Module.ccall('cactus_last_error', 'string', [], []);
      throw new Error(`cactus_load failed (code ${rc}): ${err || 'unknown error'}`);
    }

    const modelMask = Module.ccall('cactus_models', 'number', [], []);
    log(`cactus_load succeeded! Models bitmask: ${modelMask} (4=CACTUS_VISION)`);

    modelLoaded = true;
    postMessage({ type: 'STATUS', status: 'ready', message: 'Mirage vision model loaded & ready!' });

  } catch (err) {
    log(`INIT ERROR: ${err.message}\n${err.stack || ''}`);
    postMessage({ type: 'STATUS', status: 'error', message: err.message });
  }
}

// ── Run Vision Inference using cactus_describe ──
async function runInference(rgbBytes, width, height) {
  if (!Module || !modelLoaded) {
    postMessage({ type: 'RESULT', error: 'Model not loaded yet' });
    return;
  }

  const startTime = performance.now();

  try {
    log(`Starting inference on ${width}x${height} image (${(rgbBytes.length / 1024).toFixed(1)} KB RGB)…`);

    // Allocate RGB input buffer in WASM heap
    const rgbPtr = Module._malloc(rgbBytes.length);
    if (!rgbPtr) throw new Error('Out of WASM memory allocating RGB buffer');
    Module.HEAPU8.set(rgbBytes, rgbPtr);

    // Allocate output buffer for JSON result (64 KB)
    const outCap = 65536;
    const outPtr = Module._malloc(outCap);
    if (!outPtr) {
      Module._free(rgbPtr);
      throw new Error('Out of WASM memory allocating result buffer');
    }
    Module.HEAPU8.fill(0, outPtr, outPtr + outCap);

    /*
      cactus_describe signature:
      int cactus_describe(
          const unsigned char* rgb,
          int width, int height,
          const char* options,
          const char* language,
          const char* keywords,
          char* out, int out_capacity
      );
    */
    const rc = Module.ccall(
      'cactus_describe',
      'number',
      ['number', 'number', 'number', 'string', 'string', 'string', 'number', 'number'],
      [rgbPtr, width, height, '{}', 'en', '', outPtr, outCap]
    );

    const resultStr = Module.UTF8ToString(outPtr);
    Module._free(rgbPtr);
    Module._free(outPtr);

    const elapsed = performance.now() - startTime;
    log(`cactus_describe returned ${rc} in ${elapsed.toFixed(0)}ms (output length: ${resultStr.length})`);

    let parsed;
    try {
      parsed = JSON.parse(resultStr);
    } catch {
      parsed = { description: resultStr, raw: resultStr };
    }

    postMessage({
      type: 'RESULT',
      result: parsed,
      raw: resultStr,
      inferenceMs: Math.round(elapsed),
    });

  } catch (err) {
    const elapsed = performance.now() - startTime;
    log(`INFERENCE ERROR: ${err.message}`);
    postMessage({
      type: 'RESULT',
      error: err.message,
      inferenceMs: Math.round(elapsed),
    });
  }
}

// ── Clear Cache ──
async function clearModelCache() {
  try {
    await caches.delete(CACHE_NAME);
    log(`Cache "${CACHE_NAME}" cleared`);
  } catch (e) {
    log(`Clear cache error: ${e.message}`);
  }
  postMessage({ type: 'CACHE_CLEARED' });
}

// ── Worker Message Dispatcher ──
self.onmessage = async (e) => {
  const { type } = e.data;

  switch (type) {
    case 'INIT':
      await initEngine();
      break;
    case 'INFER':
      await runInference(e.data.rgbBytes, e.data.width, e.data.height);
      break;
    case 'CLEAR_CACHE':
      await clearModelCache();
      break;
    case 'RESET':
      if (Module && Module._cactus_reset) {
        try { Module._cactus_reset(); } catch {}
      }
      log('Engine reset');
      postMessage({ type: 'RESET_DONE' });
      break;
    default:
      log(`Unknown command: ${type}`);
  }
};

log('Worker script initialized');
