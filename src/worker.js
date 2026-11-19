// OCR を実行するワーカー。画面が固まらないよう、モデルの読み込みと推論はすべてここで行う。
// 受け取った画像はこのワーカーの中だけで処理し、どこにも送信しない（モデルの取得以外に通信しない）。
import { OcrEngine } from './ocr/engine.js';
import { recognizePage } from './ocr/page.js';
import { bgrFromRgba, createImage } from './ocr/image.js';

const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
// CPU だけなら WebAssembly 専用の版（ランタイム約 15 MB）を、GPU を使うときだけ WebGPU 版
// （約 29 MB。CPU でも動く）を読み込む。
const ORT_BUNDLES = { wasm: `${ORT_BASE}ort.wasm.min.mjs`, webgpu: `${ORT_BASE}ort.webgpu.min.mjs` };
let ort = null;

/** スレッド数。複数スレッドは crossOriginIsolated（COOP/COEP ヘッダー）のときだけ使える。 */
function threadCount(requested) {
  if (!self.crossOriginIsolated) return 1;
  const cores = navigator.hardwareConcurrency || 1;
  const n = Number.isInteger(requested) && requested > 0 ? requested : MAX_THREADS;
  return Math.max(1, Math.min(n, cores, MAX_THREADS));
}
// 4 を超えると、試した環境（12 論理コア）では起動に失敗した。4 で 1 スレッドの約 2 倍速い。
const MAX_THREADS = 4;

// モデルを差し替えたら名前を変える（古いキャッシュを使わないため）。
const CACHE_NAME = 'ocrdeskweb-models-pp-ocrv6-small-v1';
const MODEL_BASE = new URL('../models/', import.meta.url);
const FILES = {
  det: 'PP-OCRv6_det_small.onnx',
  rec: 'PP-OCRv6_rec_small.onnx',
  keys: 'PP-OCRv6_rec_small.keys.txt',
};
/** ファイルの大きさ。途中で切れたダウンロードをキャッシュに残さないために確かめる。 */
const SIZES = {
  [FILES.det]: 9929594,
  [FILES.rec]: 21234383,
  [FILES.keys]: 74947,
};
const EXPECTED_BYTES = Object.values(SIZES).reduce((a, b) => a + b, 0);

let engine = null;

/** Cache API にあればそれを使い、なければ進み具合を知らせながらダウンロードして保存する。 */
async function fetchCached(name, onBytes, onCacheMiss) {
  const url = new URL(name, MODEL_BASE).href;
  let cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch { /* プライベートモードなどでは使えない */ }
  const cached = cache ? await cache.match(url) : null;
  if (cached) {
    const buffer = await cached.arrayBuffer();
    if (buffer.byteLength === SIZES[name]) {
      onBytes(buffer.byteLength);
      return buffer;
    }
    await cache.delete(url); // 壊れている保存分は捨ててダウンロードし直す
  }
  onCacheMiss();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onBytes(value.byteLength);
  }
  if (received !== SIZES[name]) throw new Error(`${name}: incomplete download (${received} / ${SIZES[name]} bytes)`);
  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { buffer.set(c, offset); offset += c.byteLength; }
  if (cache) {
    try { await cache.put(url, new Response(buffer.slice().buffer)); } catch { /* 容量不足などは無視 */ }
  }
  return buffer.buffer;
}

async function createSessions(detBuffer, recBuffer, backend) {
  const options = { executionProviders: [backend], graphOptimizationLevel: 'all' };
  const det = await ort.InferenceSession.create(new Uint8Array(detBuffer), options);
  const rec = await ort.InferenceSession.create(new Uint8Array(recBuffer), options);
  return { det, rec };
}

async function init(preferred, threads) {
  const useGpu = preferred === 'webgpu' && !!self.navigator?.gpu;
  ort = await import(useGpu ? ORT_BUNDLES.webgpu : ORT_BUNDLES.wasm);
  ort.env.wasm.wasmPaths = ORT_BASE;
  ort.env.wasm.numThreads = threadCount(threads);
  let loaded = 0;
  let downloading = false; // 1 つでも保存済みでなければ「ダウンロード中」と表示する
  const miss = () => { downloading = true; };
  const report = (n) => {
    loaded += n;
    postMessage({ type: 'download', loaded, total: EXPECTED_BYTES, downloading });
  };
  const [det, rec, keys] = await Promise.all([
    fetchCached(FILES.det, report, miss),
    fetchCached(FILES.rec, report, miss),
    fetchCached(FILES.keys, report, miss).then((b) => new TextDecoder().decode(b)),
  ]);
  // GPU（WebGPU）は試験的な扱い。使えなければ CPU（WebAssembly）に戻す。
  const candidates = useGpu ? ['webgpu', 'wasm'] : ['wasm'];
  let lastError = null;
  for (const backend of candidates) {
    try {
      const sessions = await createSessions(det, rec, backend);
      engine = new OcrEngine(ort, sessions.det, sessions.rec, keys);
      postMessage({ type: 'ready', backend, threads: ort.env.wasm.numThreads, isolated: self.crossOriginIsolated });
      return;
    } catch (e) {
      lastError = e;
    }
  }
  // モデルの保存分が原因で失敗し続けないよう、保存分を消す（次の起動でダウンロードし直す）
  try { await caches.delete(CACHE_NAME); } catch { /* 無視 */ }
  throw lastError ?? new Error('no backend');
}

/**
 * ImageBitmap を BGR の画像にする。大きな画像を 1 枚の canvas に描くとブラウザーの上限に
 * かかるので、横長の帯に分けて描いて読み取る。
 */
function bitmapToBgr(bitmap) {
  const { width, height } = bitmap;
  const out = createImage(width, height, 3);
  const band = Math.max(1, Math.min(height, Math.floor(16_000_000 / Math.max(1, width))));
  const canvas = new OffscreenCanvas(width, band);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  for (let top = 0; top < height; top += band) {
    const h = Math.min(band, height - top);
    ctx.clearRect(0, 0, width, band);
    ctx.drawImage(bitmap, 0, top, width, h, 0, 0, width, h);
    const rgba = ctx.getImageData(0, 0, width, h).data;
    out.data.set(bgrFromRgba(rgba, width, h).data, top * width * 3);
  }
  bitmap.close();
  return out;
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      await init(msg.backend, msg.threads);
    } else if (msg.type === 'ocr') {
      if (!engine) throw new Error('engine not ready');
      const image = bitmapToBgr(msg.bitmap);
      const result = await recognizePage(engine, image, {
        onProgress: (done, total) => postMessage({ type: 'progress', id: msg.id, done, total }),
      });
      postMessage({ type: 'result', id: msg.id, text: result.text, lines: result.lines.length, tiles: result.tiles });
    }
  } catch (e) {
    postMessage({ type: 'error', id: msg.id, message: String(e?.message ?? e) });
  }
};
