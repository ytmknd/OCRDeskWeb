// SPDX-License-Identifier: Apache-2.0
// Portions of this file are ported from RapidOCR (https://github.com/RapidAI/RapidOCR),
// Copyright RapidOCR Authors, which in turn derives from PaddleOCR (Copyright PaddlePaddle Authors),
// both licensed under the Apache License, Version 2.0 (see LICENSES/Apache-2.0.txt).
// Modified by ytmknd (2026): translated from Python to JavaScript for OCRDesk Web.
// 文字領域の検出（PP-OCRv6 Small det）。RapidOCR の TextDetector / DBPostProcess の移植。
import { resizeLinear, roundHalfEven } from './image.js';
import { getMiniBoxes, unclipRect, insideOrOnPolygon } from './geometry.js';

const LIMIT_SIDE_LEN = 736; // limit_type: min
const THRESH = 0.3;
const BOX_THRESH = 0.5;
const MAX_CANDIDATES = 1000;
const UNCLIP_RATIO = 1.6;
const MIN_SIZE = 3;
const SORT_Y_THRESHOLD = 10;

/** 検出用の入力テンソル（短辺を 736 以上・32 の倍数にして正規化、BGR、NCHW）。 */
function preprocess(ort, image) {
  const { width: w, height: h } = image;
  let ratio = 1;
  if (Math.min(h, w) < LIMIT_SIDE_LEN) ratio = LIMIT_SIDE_LEN / (h < w ? h : w);
  const rh = roundHalfEven(Math.trunc(h * ratio) / 32) * 32;
  const rw = roundHalfEven(Math.trunc(w * ratio) / 32) * 32;
  if (rh <= 0 || rw <= 0) return null;
  const resized = resizeLinear(image, rw, rh);
  const plane = rw * rh;
  const data = new Float32Array(3 * plane);
  const src = resized.data;
  for (let i = 0; i < plane; i++) {
    data[i] = (src[i * 3] / 255 - 0.5) / 0.5;
    data[plane + i] = (src[i * 3 + 1] / 255 - 0.5) / 0.5;
    data[2 * plane + i] = (src[i * 3 + 2] / 255 - 0.5) / 0.5;
  }
  return { tensor: new ort.Tensor('float32', data, [1, 3, rh, rw]), width: rw, height: rh };
}

/** 2x2 の膨張（cv2.dilate、アンカーは (1, 1)）。 */
function dilate2x2(seg, width, height) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      out[i] = seg[i] || (x > 0 && seg[i - 1]) || (y > 0 && seg[i - width]) || (x > 0 && y > 0 && seg[i - width - 1]) ? 1 : 0;
    }
  }
  return out;
}

/**
 * 8 近傍でつながった領域ごとに、各行の左端・右端の画素を集める。
 * 領域の凸包はこれらの点の凸包と一致するので、輪郭追跡（cv2.findContours）の代わりに使える。
 */
function components(mask, width, height) {
  const labels = new Int32Array(width * height);
  const result = [];
  const stack = [];
  let next = 0;
  for (let start = 0; start < width * height; start++) {
    if (!mask[start] || labels[start]) continue;
    next++;
    const rows = new Map();
    labels[start] = next;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      const x = i % width, y = (i - x) / width;
      const row = rows.get(y);
      if (row) { if (x < row[0]) row[0] = x; if (x > row[1]) row[1] = x; } else rows.set(y, [x, x]);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const j = ny * width + nx;
          if (mask[j] && !labels[j]) { labels[j] = next; stack.push(j); }
        }
      }
    }
    const points = [];
    for (const [y, [x0, x1]] of rows) { points.push([x0, y]); if (x1 !== x0) points.push([x1, y]); }
    result.push(points);
    if (result.length >= MAX_CANDIDATES) break;
  }
  return result;
}

/** 箱の内側の確率の平均（box_score_fast）。 */
function boxScoreFast(pred, width, height, box) {
  const xs = box.map((p) => p[0]), ys = box.map((p) => p[1]);
  const clamp = (v, hi) => Math.min(Math.max(v, 0), hi);
  const xmin = clamp(Math.floor(Math.min(...xs)), width - 1), xmax = clamp(Math.ceil(Math.max(...xs)), width - 1);
  const ymin = clamp(Math.floor(Math.min(...ys)), height - 1), ymax = clamp(Math.ceil(Math.max(...ys)), height - 1);
  const poly = box.map((p) => [Math.trunc(p[0] - xmin), Math.trunc(p[1] - ymin)]);
  let sum = 0, count = 0;
  for (let y = ymin; y <= ymax; y++) {
    for (let x = xmin; x <= xmax; x++) {
      if (insideOrOnPolygon(x - xmin, y - ymin, poly)) { sum += pred[y * width + x]; count++; }
    }
  }
  return count ? sum / count : 0;
}

function orderPointsClockwise(pts) {
  const xSorted = pts.slice().sort((a, b) => a[0] - b[0]);
  const left = xSorted.slice(0, 2).sort((a, b) => a[1] - b[1]);
  const right = xSorted.slice(2).sort((a, b) => a[1] - b[1]);
  return [left[0], right[0], right[1], left[1]].map((p) => [p[0], p[1]]);
}

/** 上から下、同じ行は左から右に並べる（TextDetector.sorted_boxes）。 */
function sortBoxes(items) {
  const byY = items.map((item, i) => ({ item, i })).sort((a, b) => a.item.box[0][1] - b.item.box[0][1] || a.i - b.i);
  let line = 0;
  byY.forEach((entry, k) => {
    if (k > 0 && entry.item.box[0][1] - byY[k - 1].item.box[0][1] >= SORT_Y_THRESHOLD) line++;
    entry.line = line;
    entry.order = k;
  });
  return byY.sort((a, b) => a.line - b.line || a.item.box[0][0] - b.item.box[0][0] || a.order - b.order).map((e) => e.item);
}

/** 文字領域を検出する。戻り値は 4 頂点（左上から時計回り）の箱とスコアの配列。 */
export async function detectText(ort, session, image) {
  const input = preprocess(ort, image);
  if (!input) return [];
  const output = await session.run({ [session.inputNames[0]]: input.tensor });
  const predTensor = output[session.outputNames[0]];
  const [, , H, W] = predTensor.dims;
  const pred = predTensor.data;
  const seg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) seg[i] = pred[i] > THRESH ? 1 : 0;
  const mask = dilate2x2(seg, W, H);

  const destW = image.width, destH = image.height;
  const found = [];
  for (const points of components(mask, W, H)) {
    const first = getMiniBoxes(points);
    if (first.side < MIN_SIZE) continue;
    const score = boxScoreFast(pred, W, H, first.box);
    if (BOX_THRESH > score) continue;
    const second = getMiniBoxes(unclipRect(first.box, UNCLIP_RATIO));
    if (second.side < MIN_SIZE + 2) continue;
    const box = second.box.map(([x, y]) => [
      Math.min(Math.max(roundHalfEven((x / W) * destW), 0), destW),
      Math.min(Math.max(roundHalfEven((y / H) * destH), 0), destH),
    ]);
    found.push({ box, score });
  }

  const filtered = [];
  for (const { box, score } of found) {
    const ordered = orderPointsClockwise(box).map(([x, y]) => [
      Math.trunc(Math.min(Math.max(x, 0), destW - 1)),
      Math.trunc(Math.min(Math.max(y, 0), destH - 1)),
    ]);
    const rectW = Math.trunc(Math.hypot(ordered[0][0] - ordered[1][0], ordered[0][1] - ordered[1][1]));
    const rectH = Math.trunc(Math.hypot(ordered[0][0] - ordered[3][0], ordered[0][1] - ordered[3][1]));
    if (rectW <= 3 || rectH <= 3) continue;
    filtered.push({ box: ordered, score });
  }
  return sortBoxes(filtered);
}
