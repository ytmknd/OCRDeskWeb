# OCRDesk Web

OCRDesk Web turns PNG and JPEG images and PDF documents into text with OCR, entirely in the browser. **Files are never uploaded**: images, PDF pages, and results stay on the device. It is the browser version of the OCRDesk desktop app and uses the same OCR engine (PP-OCRv6 Small) and the same processing, so the results match the desktop app.

It is a static website with no build step and no server-side code.

## Features

- Add PNG, JPEG, and PDF files by drag and drop or with a file picker. Several files can be processed at once.
- PDF pages are rendered with PDF.js at 150, 200, or 300 dpi and read with OCR. Text embedded in the PDF is not used. Password-protected PDFs cannot be opened.
- Tall images, such as full-page screenshots of web forms, are split into overlapping strips (1600 px high, 240 px overlap) and joined again without duplicated lines. Without this, the detector would shrink the image so that the long side is at most 2000 px and the text would become unreadable.
- The result is editable and can be copied or saved as a UTF-8 `.txt` file.
- The user interface is in Japanese when the browser language is Japanese, and in English otherwise. Add `?lang=ja` or `?lang=en` to the URL to override it.

## How it works

| Part | Implementation |
| --- | --- |
| OCR models | PP-OCRv6 Small detection and recognition models (ONNX, about 31 MB) in `models/`. They are downloaded on first use and stored in the browser with the Cache API. |
| Inference | [ONNX Runtime Web](https://onnxruntime.ai/) 1.31.1, loaded from jsDelivr. Runs in a Web Worker so the page stays responsive. |
| Pre/post-processing | `src/ocr/`: a JavaScript port of RapidOCR's pipeline (resize, DB post-processing, crop, CTC decoding) and of the desktop app's extra steps (upscaling small images, margins, duplicate removal, strip splitting, line ordering). The text-line orientation classifier is not used, because it sometimes judged horizontal Japanese lines to be upside down. |
| PDF | [PDF.js](https://mozilla.github.io/pdf.js/) 6.5.438, loaded from jsDelivr. |
| Language | `src/strings.js` holds all messages, with the English and Japanese text side by side. |

### Engines

- **CPU (WebAssembly)**: the default. It uses up to 4 threads when the page is cross-origin isolated. A 1280 × 1600 px strip takes about 25–35 seconds with 4 threads on a typical PC, roughly twice as fast as one thread.
- **GPU (WebGPU, experimental)**: can be selected in the toolbar. In testing it produced the same text as the CPU engine. Its speed depends on the GPU and has not been measured on real hardware.

### Multi-threading and cross-origin isolation

WebAssembly threads need the page to be cross-origin isolated (COOP/COEP headers).

- `_headers` sets these headers on hosts that read it (Netlify, Cloudflare Pages).
- On hosts where headers cannot be set (such as GitHub Pages), `sw.js` adds them in a service worker. On the first visit the page reloads once after the service worker is registered.

Without isolation, OCR still works with one thread.

## Privacy

- Files are read and processed only inside the browser tab and its workers.
- The only network requests are GET requests for the page itself, the models, ONNX Runtime Web, and PDF.js. Automated tests checked that no other requests are made.
- There are no analytics or tracking.

## Running locally

Serve the folder with any static web server and open it in a browser. For example:

```powershell
python -m http.server 8000
```

Then open <http://localhost:8000/>. Opening `index.html` directly as a file does not work, because module workers and the Cache API need HTTP.

For testing, these URL parameters are available:

| Parameter | Meaning |
| --- | --- |
| `lang=ja` / `lang=en` | Force the UI language |
| `backend=wasm` / `backend=webgpu` | Force the engine |
| `threads=1`…`4` | Number of WebAssembly threads |

## Deploying

Upload the whole folder to any static hosting service (GitHub Pages, Netlify, Cloudflare Pages, and so on). HTTPS is required for the service worker and the Cache API (`localhost` is exempt). The largest file is the recognition model (about 21 MB).

## Project structure

```text
index.html                 Page
sw.js                      Service worker that enables cross-origin isolation
_headers                   COOP/COEP headers for Netlify / Cloudflare Pages
src/app.js                 UI
src/worker.js              OCR worker (model loading, inference)
src/strings.js             Messages (English / Japanese)
src/styles.css             Styles (light and dark)
src/ocr/                   OCR pipeline (no DOM access; also runs in Node.js)
models/                    PP-OCRv6 Small models and character table
LICENSES/Apache-2.0.txt    License of the models and ported code
```

## License

OCRDesk Web is licensed under the [MIT License](LICENSE), except for the PP-OCRv6 models and the files ported from RapidOCR/PaddleOCR, which are under the Apache License 2.0. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
