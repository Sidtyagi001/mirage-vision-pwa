# 🌵 Mirage Vision PWA

**Private, offline AI vision** powered by [Cactus Compute](https://cactuscompute.com)'s Mirage model — runs **100% in your browser** via WebAssembly.

> No servers. No uploads. No tracking. Your images never leave your device.

---

## ✨ Features

- 🔒 **Zero-server privacy** — all inference runs locally in WebAssembly
- 📴 **Offline-capable** — works without internet after first download (PWA with Service Worker)
- 📷 **Camera capture** — live camera with front/rear toggle
- 📁 **File upload** — drag-and-drop or browse (JPG, PNG, WebP)
- 🏞️ **Scene description** — natural language image summary
- 📦 **Object detection** — with bounding box overlays and confidence scores
- 📝 **OCR** — text extraction from images
- ⚡ **Non-blocking** — runs in a Web Worker for smooth 60fps UI
- 📱 **Cross-platform** — responsive dark-mode UI for mobile and desktop
- 🧹 **Privacy controls** — clear session memory and cached model data

Link to Access
https://privatemirage.netlify.app/

## 📁 Project Structure

```
mirage-pwa/
├── index.html          # App shell
├── style.css           # Dark-mode responsive styles
├── app.js              # Main UI logic (camera, upload, results)
├── worker.js           # Web Worker (WASM init + inference)
├── sw.js               # Service Worker (offline caching)
├── manifest.json       # PWA manifest
├── netlify.toml        # Netlify deploy config + headers
├── _headers            # Netlify/Cloudflare headers file
├── icon-192.png        # PWA icon 192×192
├── icon-512.png        # PWA icon 512×512
└── public/
    └── models/         # Drop local fallback files here:
        ├── cactus.js       # (optional) local WASM glue
        ├── cactus.wasm     # (optional) local WASM binary
        └── mirage.cact     # (optional) local model weights
```

## 🔧 Self-Hosting / Offline Fallback

If Hugging Face CDN is unreachable (CORS issues, air-gapped network), download the files manually and place them in `public/models/`:

```bash
# Download runtime (~1.2 MB)
wget https://huggingface.co/Cactus-Compute/cactus/resolve/main/wasm/cactus.js -O public/models/cactus.js
wget https://huggingface.co/Cactus-Compute/cactus/resolve/main/wasm/cactus.wasm -O public/models/cactus.wasm

# Download model (~21.6 MB)
wget https://huggingface.co/Cactus-Compute/mirage/resolve/main/mirage.cact -O public/models/mirage.cact
```

The worker automatically falls back to these local paths if remote fetch fails.

## 🛡️ Privacy Guarantees

- Images are processed **strictly in memory** inside the WebAssembly sandbox
- Object URLs are revoked immediately after inference
- No data is sent to any server — all computation is local
- "Wipe Memory" clears all buffers; "Clear Cache" removes downloaded model files
- The Service Worker only caches static app assets and model binaries

## ⚙️ Technical Details

| Component | Details |
|-----------|---------|
| Engine    | Cactus Compute WASM runtime (~1.2 MB) |
| Model     | Mirage vision-language model (~21.6 MB, 2-bit quantized) |
| Output    | Structured JSON: scene description, objects + bboxes, OCR text |
| BBox format | Normalized 0–1000 coordinates `[x1, y1, x2, y2]` |
| Architecture | Main thread (UI) → Web Worker (WASM inference) → Service Worker (caching) |

## 📄 License

This project uses the Cactus Compute engine and Mirage model. See their respective licenses on [Hugging Face](https://huggingface.co/Cactus-Compute).
