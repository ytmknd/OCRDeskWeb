// 画面の制御。OCR そのものは worker.js で行う。
// ファイルはこのページの中だけで扱い、どこにも送信しない。
import { S } from './strings.js';
import * as pdfjs from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/build/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/build/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const el = {
  drop: $('drop'), fileInput: $('fileInput'), list: $('fileList'), empty: $('emptyList'),
  run: $('runBtn'), cancel: $('cancelBtn'), remove: $('removeBtn'), clear: $('clearBtn'),
  copy: $('copyBtn'), save: $('saveBtn'), dpi: $('dpiSelect'), backend: $('backendSelect'), result: $('result'),
  status: $('status'), progress: $('progress'), previewImg: $('previewImg'), previewCanvas: $('previewCanvas'),
  previewEmpty: $('previewEmpty'), prev: $('prevPage'), next: $('nextPage'), pageLabel: $('pageLabel'),
};

const SUPPORTED = /\.(png|jpe?g|pdf)$/i;
const STATE = { pending: 'pending', processing: 'processing', done: 'done', partial: 'partial', notext: 'notext', cancelled: 'cancelled' };
const stateLabel = {
  pending: S.statePending, processing: S.stateProcessing, done: S.stateDone,
  partial: S.statePartialError, notext: S.stateNoText, cancelled: S.stateCancelled,
};

let nextId = 1;
const items = [];          // { id, file, name, kind, pages, pdf, state, results, url }
let selectedId = null;
let previewPage = 0;
let previewToken = 0;
let busy = false;
let cancelRequested = false;
let resultEdited = false;
let settingResult = false;

// ---- 初期化 -----------------------------------------------------------------------------

function applyTexts() {
  document.documentElement.lang = S.lang;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = S[node.dataset.i18n];
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = S[node.dataset.i18nTitle];
  for (const [select, key] of [[el.dpi, 'ocrdeskweb.dpi'], [el.backend, 'ocrdeskweb.backend']]) {
    try {
      const saved = localStorage.getItem(key);
      if (saved && [...select.options].some((o) => o.value === saved)) select.value = saved;
    } catch { /* localStorage が使えない環境 */ }
  }
  if (!('gpu' in navigator)) el.backend.querySelector('option[value="webgpu"]').disabled = true;
  const forced = params.get('backend');
  if (forced === 'wasm' || forced === 'webgpu') el.backend.value = forced;
  setStatus(S.statusReady);
}

function setStatus(text, progress = null) {
  el.status.textContent = text;
  if (progress === null) el.progress.hidden = true;
  else { el.progress.hidden = false; el.progress.value = progress; }
}

// ---- OCR ワーカー -----------------------------------------------------------------------

let worker = null;
let workerReady = null;
let rejectReady = null;
let backendName = '';
const pending = new Map();

function startWorker() {
  if (workerReady) return workerReady;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  workerReady = new Promise((resolve, reject) => {
    rejectReady = reject;
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'download') {
        const mb = (n) => (n / 1048576).toFixed(1);
        setStatus(msg.downloading ? S.statusDownloading(mb(msg.loaded), mb(msg.total)) : S.statusLoadingModel, msg.loaded / msg.total);
      } else if (msg.type === 'ready') {
        backendName = msg.backend === 'webgpu' ? 'WebGPU' : `WebAssembly, ${S.threads(msg.threads)}`;
        document.body.dataset.backend = backendName;
        rejectReady = null;
        resolve();
      } else if (msg.type === 'error' && msg.id === undefined) {
        reject(new Error(msg.message));
      } else if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        if (msg.type === 'progress') p.onProgress?.(msg.done, msg.total);
        else if (msg.type === 'result') { pending.delete(msg.id); p.resolve(msg); }
        else if (msg.type === 'error') { pending.delete(msg.id); p.reject(new Error(msg.message)); }
      }
    };
    worker.onerror = (e) => reject(new Error(e.message || 'worker error'));
  });
  setStatus(S.statusLoadingEngine);
  worker.postMessage({ type: 'init', backend: el.backend.value, threads: Number(params.get('threads')) || undefined });
  workerReady.catch(() => stopWorker());
  return workerReady;
}

/** 中止はワーカーごと終わらせる（推論の途中でもすぐ止まる）。モデルは保存済みなので再開は速い。 */
function stopWorker() {
  if (worker) worker.terminate();
  worker = null;
  workerReady = null;
  // モデルの準備中に止めた場合も、準備を待っている処理を終わらせる
  rejectReady?.(new DOMException('Aborted', 'AbortError'));
  rejectReady = null;
  for (const p of pending.values()) p.reject(new DOMException('Aborted', 'AbortError'));
  pending.clear();
}

/** エンジンを起動する。ライブラリの読み込みが一時的な通信エラーで失敗することがあるので、1 度だけやり直す。 */
async function startEngine() {
  try {
    await startWorker();
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    stopWorker();
    await new Promise((r) => setTimeout(r, 1500));
    if (cancelRequested) throw new DOMException('Aborted', 'AbortError');
    await startWorker();
  }
}

let requestId = 0;
function recognize(bitmap, onProgress) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    // ページの画像を準備している間に中止された場合は、ワーカーがもうない
    if (!worker || cancelRequested) { bitmap.close(); reject(new DOMException('Aborted', 'AbortError')); return; }
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ type: 'ocr', id, bitmap }, [bitmap]);
  });
}

// ---- ファイル ----------------------------------------------------------------------------

async function addFiles(fileList) {
  const errors = [];
  let firstAdded = null;
  for (const file of fileList) {
    if (!SUPPORTED.test(file.name)) { errors.push(S.unsupportedFormat(file.name)); continue; }
    if (items.some((x) => x.file.name === file.name && x.file.size === file.size && x.file.lastModified === file.lastModified)) continue;
    const item = { id: nextId++, file, name: file.name, kind: /\.pdf$/i.test(file.name) ? 'pdf' : 'image', pages: 1, pdf: null, state: STATE.pending, results: null, url: null };
    try {
      if (item.kind === 'pdf') {
        item.pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        item.pages = item.pdf.numPages;
      } else {
        item.url = URL.createObjectURL(file);
      }
    } catch (e) {
      errors.push(`${file.name}: ${e?.name === 'PasswordException' ? S.pdfPasswordProtected : S.pdfLoadFailed(e?.message ?? e)}`);
      continue;
    }
    items.push(item);
    firstAdded ??= item;
  }
  if (firstAdded) select(firstAdded.id);
  renderList();
  updateButtons();
  if (errors.length) alert(`${S.addFailedTitle}\n\n${errors.join('\n')}`);
}

function removeItems(ids) {
  for (const id of ids) {
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) continue;
    const [item] = items.splice(i, 1);
    if (item.url) URL.revokeObjectURL(item.url);
    item.pdf?.destroy();
  }
  if (!items.some((x) => x.id === selectedId)) select(items[0]?.id ?? null);
  renderList();
  rebuildResult();
  updateButtons();
}

function renderList() {
  el.list.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    li.className = 'file' + (item.id === selectedId ? ' selected' : '');
    li.dataset.id = item.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', item.id === selectedId ? 'true' : 'false');
    const badge = document.createElement('span');
    badge.className = `badge ${item.state}`;
    badge.textContent = stateLabel[item.state];
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name + (item.pages > 1 ? S.pagesSuffix(item.pages) : '');
    li.append(badge, name);
    return li;
  }));
  el.empty.hidden = items.length > 0;
}

function select(id) {
  selectedId = id;
  previewPage = 0;
  renderList();
  showPreview();
}

// ---- プレビュー -------------------------------------------------------------------------

async function showPreview() {
  const token = ++previewToken;
  const item = items.find((x) => x.id === selectedId);
  el.previewImg.hidden = el.previewCanvas.hidden = true;
  el.previewEmpty.hidden = !!item;
  el.prev.disabled = el.next.disabled = true;
  el.pageLabel.textContent = '';
  if (!item) return;
  el.pageLabel.textContent = S.pageOf(previewPage + 1, item.pages);
  el.prev.disabled = previewPage <= 0;
  el.next.disabled = previewPage >= item.pages - 1;
  if (item.kind === 'image') {
    el.previewImg.src = item.url;
    el.previewImg.hidden = false;
    return;
  }
  const page = await item.pdf.getPage(previewPage + 1);
  if (token !== previewToken) return;
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, (el.previewCanvas.parentElement.clientWidth * devicePixelRatio) / base.width || 1);
  const viewport = page.getViewport({ scale });
  const canvas = el.previewCanvas;
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport, background: '#ffffff' }).promise;
  if (token === previewToken) canvas.hidden = false;
}

// ---- OCR の実行 -------------------------------------------------------------------------

const MAX_CANVAS_PIXELS = 16_000_000;
const MAX_CANVAS_SIDE = 16_384;

async function pageBitmap(item, pageIndex, dpi) {
  if (item.kind === 'image') {
    try { return await createImageBitmap(item.file, { imageOrientation: 'from-image' }); }
    catch { throw new Error(S.imageLoadFailed); }
  }
  const page = await item.pdf.getPage(pageIndex + 1);
  // pdf.js の scale 1 は 72 dpi。大きな用紙（A0 など）を高い解像度で描くと、canvas の上限
  // （iOS Safari では約 1,670 万画素）を超えて白紙になるので、上限に収まるよう縮める。
  const base = page.getViewport({ scale: 1 });
  let scale = dpi / 72;
  scale = Math.min(scale, Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height)), MAX_CANVAS_SIDE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport, background: '#ffffff' }).promise;
  const bitmap = await createImageBitmap(canvas);
  canvas.width = canvas.height = 0;
  return bitmap;
}

function confirmDiscardEdits() {
  return !resultEdited || confirm(S.discardEdits);
}

async function run() {
  if (busy || items.length === 0 || !confirmDiscardEdits()) return;
  let targets = items.filter((x) => !x.results);
  if (targets.length === 0) {
    const sel = items.find((x) => x.id === selectedId);
    targets = sel ? [sel] : items.slice();
    for (const t of targets) t.results = null;
  }
  const dpi = Number(el.dpi.value);
  const totalPages = targets.reduce((n, x) => n + x.pages, 0);
  let done = 0, failed = 0, cancelled = false;
  const started = performance.now();
  busy = true;
  cancelRequested = false;
  updateButtons();
  try {
    await startEngine();
    setStatus(S.statusEngineReady(backendName));
    for (const item of targets) {
      item.state = STATE.processing;
      item.results = [];
      renderList();
      for (let p = 0; p < item.pages; p++) {
        // finished: 読み終えた区画（短冊）の数、parts: 区画の数（縦長のページだけ 2 以上）
        const report = (finished, parts) => setStatus(S.statusReading(item.name, p + 1, item.pages, finished + 1, parts),
          (done + (parts ? finished / parts : 0)) / totalPages);
        report(0, 0);
        let entry;
        try {
          const bitmap = await pageBitmap(item, p, dpi);
          const r = await recognize(bitmap, (finished, parts) => report(finished, parts));
          entry = { page: p, ok: true, text: r.text, message: r.text ? '' : S.noTextFound };
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          entry = { page: p, ok: false, text: '', message: String(e?.message ?? e) };
          failed++;
        }
        item.results.push(entry);
        done++;
        rebuildResult();
      }
      item.state = item.results.some((r) => !r.ok) ? STATE.partial : item.results.every((r) => !r.text) ? STATE.notext : STATE.done;
      renderList();
    }
  } catch (e) {
    if (e?.name === 'AbortError') {
      cancelled = true;
      for (const item of targets.filter((x) => x.state === STATE.processing)) { item.results = null; item.state = STATE.cancelled; }
    } else {
      for (const item of targets.filter((x) => x.state === STATE.processing)) { item.results = null; item.state = STATE.pending; }
      busy = false;
      renderList();
      rebuildResult();
      updateButtons();
      setStatus(S.statusEngineFailed(e?.message ?? e));
      return;
    }
  }
  busy = false;
  renderList();
  rebuildResult();
  updateButtons();
  const elapsed = S.seconds((performance.now() - started) / 1000);
  setStatus(cancelled ? S.statusCancelled(done, totalPages, elapsed)
    : failed ? S.statusDoneWithErrors(totalPages, failed, elapsed) : S.statusDone(totalPages, elapsed));
}

function cancel() {
  if (!busy) return;
  cancelRequested = true;
  stopWorker();
}

// ---- 結果 --------------------------------------------------------------------------------

function formatItem(item) {
  const out = [`===== ${item.name} =====`];
  for (const r of item.results) {
    if (item.pages > 1) out.push(S.pageHeader(r.page + 1, item.pages));
    if (r.message) out.push(`[${r.ok ? '' : S.errorPrefix}${r.message}]`);
    if (r.text) out.push(r.text.trimEnd());
    out.push('');
  }
  return out.join('\n');
}

function rebuildResult() {
  const text = items.filter((x) => x.results).map(formatItem).join('\n').trimEnd();
  settingResult = true;
  el.result.value = text ? text + '\n' : '';
  settingResult = false;
  resultEdited = false;
  el.result.scrollTop = el.result.scrollHeight;
  updateButtons();
}

async function copyResult() {
  const { selectionStart: s, selectionEnd: e, value } = el.result;
  const text = s !== e ? value.slice(s, e) : value;
  if (!text) return;
  try { await navigator.clipboard.writeText(text); setStatus(S.statusCopied); }
  catch { setStatus(S.statusCopyFailed); }
}

function saveResult() {
  if (!el.result.value) return;
  const first = items.find((x) => x.results);
  const base = first ? first.name.replace(/\.[^.]+$/, '') + '_ocr' : 'ocr';
  const blob = new Blob(['﻿', el.result.value.replace(/\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${base}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function updateButtons() {
  const hasPending = items.some((x) => !x.results);
  el.run.disabled = busy || items.length === 0;
  el.run.textContent = hasPending || items.length === 0 ? S.run : S.rerun;
  el.cancel.disabled = !busy;
  el.remove.disabled = busy || selectedId === null;
  el.clear.disabled = busy || items.length === 0;
  el.fileInput.disabled = busy;
  el.drop.classList.toggle('disabled', busy);
  el.dpi.disabled = el.backend.disabled = busy;
  el.copy.disabled = el.save.disabled = !el.result.value;
}

// ---- イベント ----------------------------------------------------------------------------

el.fileInput.addEventListener('change', () => { addFiles([...el.fileInput.files]); el.fileInput.value = ''; });
el.drop.addEventListener('dragover', (e) => { e.preventDefault(); if (!busy) el.drop.classList.add('over'); });
el.drop.addEventListener('dragleave', () => el.drop.classList.remove('over'));
el.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  el.drop.classList.remove('over');
  if (!busy) addFiles([...e.dataTransfer.files]);
});
// ドロップ先を外したときに、ブラウザーがファイルを開いてしまわないようにする
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

el.list.addEventListener('click', (e) => {
  const li = e.target.closest('li.file');
  if (li) select(Number(li.dataset.id));
});
el.list.addEventListener('keydown', (e) => {
  const li = e.target.closest('li.file');
  if (!li) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(Number(li.dataset.id)); }
  if (e.key === 'Delete' && !busy) removeItems([Number(li.dataset.id)]);
});
el.run.addEventListener('click', run);
el.cancel.addEventListener('click', cancel);
el.remove.addEventListener('click', () => { if (selectedId !== null && confirmDiscardEdits()) removeItems([selectedId]); });
el.clear.addEventListener('click', () => { if (confirmDiscardEdits()) removeItems(items.map((x) => x.id)); });
el.copy.addEventListener('click', copyResult);
el.save.addEventListener('click', saveResult);
el.dpi.addEventListener('change', () => { try { localStorage.setItem('ocrdeskweb.dpi', el.dpi.value); } catch { /* 無視 */ } });
el.backend.addEventListener('change', () => {
  try { localStorage.setItem('ocrdeskweb.backend', el.backend.value); } catch { /* 無視 */ }
  if (!busy) stopWorker(); // 次の実行で、選んだエンジンで準備し直す
});
el.prev.addEventListener('click', () => { previewPage--; showPreview(); });
el.next.addEventListener('click', () => { previewPage++; showPreview(); });
el.result.addEventListener('input', () => { if (!settingResult) resultEdited = true; updateButtons(); });
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && el.result.value) { e.preventDefault(); saveResult(); }
});
window.addEventListener('beforeunload', (e) => { if (busy || resultEdited) e.preventDefault(); });

applyTexts();
renderList();
updateButtons();
