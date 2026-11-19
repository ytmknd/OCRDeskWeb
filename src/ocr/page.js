// 1 ページを読む。縦に長いページは重なりのある短冊に分けて読み、つなぎ直す。
// デスクトップ版 OCRDesk の DocumentOcr（短冊分割）と TextPostProcessor（行の並べ替え）の移植。
import { cropRows, resizeCubic } from './image.js';

/** PP-OCR は長辺 2000 px を超えると縮めてしまうので、高さがこれを超えるページは分割する。 */
const TILE_THRESHOLD = 2400;
const TILE_HEIGHT = 1600;
const TILE_OVERLAP = 240;
/** これより広いページは全体を縮小する。 */
const MAX_PAGE_WIDTH = 6000;

export function planTiles(height) {
  if (height <= TILE_THRESHOLD) return [{ top: 0, height }];
  const tiles = [];
  const step = TILE_HEIGHT - TILE_OVERLAP;
  for (let top = 0; ; top += step) {
    if (top + TILE_HEIGHT >= height) {
      // 最後の短冊は下端に揃え、薄すぎる短冊を作らない
      const lastTop = Math.max(0, height - TILE_HEIGHT);
      tiles.push({ top: lastTop, height: height - lastTop });
      break;
    }
    tiles.push({ top, height: TILE_HEIGHT });
  }
  return tiles;
}

/** 隣り合う短冊 a（上）と b（下）の重なりの中央。行の中心がどちら側にあるかで持ち主を決める。 */
const ownershipBoundary = (a, b) => (b.top + a.top + a.height) / 2;

const lineBounds = (line) => {
  const xs = line.box.map((p) => p[0]), ys = line.box.map((p) => p[1]);
  const left = Math.min(...xs), top = Math.min(...ys);
  return { left, top, right: Math.max(...xs), bottom: Math.max(...ys) };
};

/** 境界付近の行が、上の短冊で採用済みの行と同じか（検出枠が数画素ずれて両方の持ち分に入ることがある）。 */
function isDuplicateNearBoundary(accepted, candidate, boundary) {
  const c = candidate.bounds;
  const lineHeight = Math.max(1, c.bottom - c.top);
  if (Math.abs((c.top + c.bottom) / 2 - boundary) > lineHeight * 2) return false;
  const text = candidate.text.replace(/\s/g, '');
  if (!text) return false;
  return accepted.some((line) => {
    const b = line.bounds;
    const overlap = Math.min(b.bottom, c.bottom) - Math.max(b.top, c.top);
    if (overlap < 0.5 * Math.min(lineHeight, b.bottom - b.top)) return false;
    const other = line.text.replace(/\s/g, '');
    return other.length > 0 && (other.includes(text) || text.includes(other));
  });
}

/**
 * ページ画像（BGR）を読み、行（ページ座標の範囲つき）を返す。
 * onProgress(done, total) で短冊ごとの進み具合を知らせる。
 */
export async function recognizePage(engine, page, { onProgress, signal } = {}) {
  let image = page;
  let scaleBack = 1;
  if (image.width > MAX_PAGE_WIDTH) {
    scaleBack = image.width / MAX_PAGE_WIDTH;
    image = resizeCubic(image, MAX_PAGE_WIDTH, Math.max(1, Math.round(image.height / scaleBack)));
  }
  const tiles = planTiles(image.height);
  const merged = [];
  for (let i = 0; i < tiles.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const { top, height } = tiles[i];
    // 読み始める前に知らせる（done は読み終えた短冊の数）
    onProgress?.(i, tiles.length);
    const tile = tiles.length === 1 ? image : cropRows(image, top, height);
    const result = await engine.recognize(tile);
    // 分割したときに「全体を 1 行として読む」経路に落ちた結果は、ページの一部の誤読なので使わない
    if (tiles.length > 1 && result.mode === 'rec-only') continue;
    const keepFrom = i === 0 ? -Infinity : ownershipBoundary(tiles[i - 1], tiles[i]);
    const keepTo = i === tiles.length - 1 ? Infinity : ownershipBoundary(tiles[i], tiles[i + 1]);
    for (const line of result.lines) {
      const box = line.box.map(([x, y]) => [x, y + top]);
      const entry = { text: line.text, confidence: line.confidence, box };
      entry.bounds = lineBounds(entry);
      const center = (entry.bounds.top + entry.bounds.bottom) / 2;
      if (center < keepFrom || center >= keepTo) continue;
      if (i > 0 && isDuplicateNearBoundary(merged, entry, keepFrom)) continue;
      merged.push(entry);
    }
  }
  if (scaleBack !== 1) {
    for (const line of merged) {
      line.box = line.box.map(([x, y]) => [x * scaleBack, y * scaleBack]);
      line.bounds = lineBounds(line);
    }
  }
  return { lines: merged, text: linesToText(merged), tiles: tiles.length };
}

/**
 * 行を上から下・左から右に並べてテキストにする（TextPostProcessor の既定の設定）。
 * 同じ高さ（上端の差が行の高さの半分未満）の行は左から並べる。
 */
export function linesToText(lines) {
  const remaining = lines.map((line, index) => ({ line, index, b: line.bounds ?? lineBounds(line) }))
    .sort((a, b) => a.b.top - b.b.top || a.index - b.index);
  const ordered = [];
  while (remaining.length) {
    const anchor = remaining[0];
    const band = Math.max(1, (anchor.b.bottom - anchor.b.top) * 0.5);
    const same = remaining.filter((x) => Math.abs(x.b.top - anchor.b.top) < band)
      .sort((a, b) => a.b.left - b.b.left || a.index - b.index);
    ordered.push(...same);
    for (const item of same) remaining.splice(remaining.indexOf(item), 1);
  }
  const text = ordered.map((x) => x.line.text.trimEnd()).join('\n').replace(/ {2,}/g, ' ');
  const rows = text.split('\n');
  let start = 0, end = rows.length;
  while (start < end && !rows[start].trim()) start++;
  while (end > start && !rows[end - 1].trim()) end--;
  return rows.slice(start, end).join('\n');
}
