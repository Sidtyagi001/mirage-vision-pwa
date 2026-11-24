/* ═══════════════════════════════════════════════════════
   sw.js — Service Worker for Mirage Vision PWA
   Caches app shell + heavy model assets for offline use.
   ═══════════════════════════════════════════════════════ */

const APP_CACHE = 'mirage-app-v3';
const MODEL_CACHE = 'mirage-model-v3';

// App shell files — always cached on install
// App shell files — always cached on install
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './worker.js',
  './manifest.json',
];

// Model files — cached on install when bundled locally
const MODEL_FILES = [
  './models/cactus.js',
  './models/cactus.wasm',
  './models/mirage.cact',
];

// ── Install: pre-cache app shell ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(APP_CACHE).then((cache) => {
        console.log('[SW] Pre-caching app shell');
        return cache.addAll(APP_SHELL);
      }),
      caches.open(MODEL_CACHE).then(async (cache) => {
        console.log('[SW] Pre-caching bundled model files');
        for (const url of MODEL_FILES) {
          try {
            const existing = await cache.match(url);
            if (!existing) {
              await cache.add(url);
              console.log(`[SW] Cached: ${url}`);
            }
          } catch (e) {
            console.warn(`[SW] Could not cache ${url}:`, e.message);
          }
        }
      }),
    ])
  );
  self.skipWaiting();
});

// ── Activate: clean old caches ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== APP_CACHE && k !== MODEL_CACHE)
          .map((k) => {
            console.log('[SW] Removing old cache:', k);
            return caches.delete(k);
          })
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: Cache-first for app shell & model files, network-first for HF ──
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET
  if (event.request.method !== 'GET') return;

  // Model / WASM files from HuggingFace — cache-first (they're immutable)
  if (url.hostname.includes('huggingface.co') &&
      (url.pathname.endsWith('.wasm') ||
       url.pathname.endsWith('.cact') ||
       url.pathname.endsWith('.js'))) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((resp) => {
          if (resp.ok) {
            const cloned = resp.clone();
            caches.open(MODEL_CACHE).then((c) => c.put(event.request, cloned));
          }
          return resp;
        });
      })
    );
    return;
  }

  // Local model fallback files
  if (url.pathname.includes('/models/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((resp) => {
          if (resp.ok) {
            const cloned = resp.clone();
            caches.open(MODEL_CACHE).then((c) => c.put(event.request, cloned));
          }
          return resp;
        });
      })
    );
    return;
  }

  // App shell — cache-first, network fallback
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((resp) => {
        if (resp.ok && url.origin === self.location.origin) {
          const cloned = resp.clone();
          caches.open(APP_CACHE).then((c) => c.put(event.request, cloned));
        }
        return resp;
      });
    }).catch(() => {
      // Fallback for navigation requests
      if (event.request.mode === 'navigate') {
        return caches.match('./index.html');
      }
    })
  );
});
