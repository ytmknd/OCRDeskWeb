// SPDX-License-Identifier: Apache-2.0
// Portions of this file are ported from RapidOCR (https://github.com/RapidAI/RapidOCR),
// Copyright RapidOCR Authors, which in turn derives from PaddleOCR (Copyright PaddlePaddle Authors),
// both licensed under the Apache License, Version 2.0 (see LICENSES/Apache-2.0.txt).
// Modified by ytmknd (2026): translated from Python to JavaScript for OCRDesk Web.
// 1 枚の画像（短冊）を読む。RapidOCR の処理の流れ（縮小・上下の余白・検出・切り出し・認識・
// 座標の復元・スコアでの除外）と、デスクトップ版 OCRDesk の前後処理（小さい画像の拡大、
// 背景色の余白、二重検出の除去、検出が空のときの読み直し）をまとめたもの。
import { addBorder, createImage, medianPerChannel, resizeCubic, resizeLinear, rotate90CounterClockwise, roundHalfEven } from './image.js';
import { getPerspectiveTransform, warpPerspectiveCubic } from './geometry.js';
import { detectText } from './detector.js';
import { recognizeText, buildCharacterTable } from './recognizer.js';

// RapidOCR の Global 設定
const TEXT_SCORE = 0.5;
const MIN_SIDE_LEN = 30;
const MAX_SIDE_LEN = 2000;
const PAD_RATIO = 8;
const PAD_MIN_HEIGHT = 30;

// デスクトップ版（ppocrv6_small.py）の前後処理
const MIN_TEXT_HEIGHT = 48;
const MAX_UPSCALE = 8;
const MAX_SIDE = 1600;
const MARGIN_RATIO = 0.4;
const MIN_MARGIN = 16;
const MAX_MARGIN = 64;
const FALLBACK_MIN_SCORE = 0.5;
const SAME_ROW_RATIO = 0.7;

export class OcrEngine {
  /**
   * @param ort onnxruntime（ブラウザーでは onnxruntime-web、テストでは onnxruntime-node）
   * @param detSession 検出モデルのセッション
   * @param recSession 認識モデルのセッション
   * @param keysText 認識モデルの文字表（1 行 1 文字）
   */
  constructor(ort, detSession, recSession, keysText) {
    this.ort = ort;
    this.det = detSession;
    this.rec = recSession;
    this.characters = buildCharacterTable(keysText);
  }

  /** RapidOCR の __call__ 相当（行の向き判定なし）。座標は渡した画像の基準。 */
  async runRapid(original, useDet = true) {
    const { image, ratioH, ratioW } = resizeWithinBounds(original);
    if (!useDet) {
      const [res] = await recognizeText(this.ort, this.rec, this.characters, [image]);
      return { lines: res && res.text.trim() ? [{ text: res.text, score: res.score, box: null }] : [] };
    }
    const { image: padded, top } = verticalPadding(image);
    const boxes = await detectText(this.ort, this.det, padded);
    if (boxes.length === 0) return { lines: [] };
    const crops = boxes.map(({ box }) => cropRotated(padded, box));
    const recs = await recognizeText(this.ort, this.rec, this.characters, crops);
    const lines = [];
    boxes.forEach(({ box }, i) => {
      const { text, score } = recs[i];
      if (!text.trim() || score < TEXT_SCORE) return;
      const mapped = box.map(([x, y]) => {
        let mx = x * ratioW, my = (y - top) * ratioH;
        mx = Math.min(Math.max(mx, 0), original.width);
        my = Math.min(Math.max(my, 0), original.height);
        return [mx, my];
      });
      lines.push({ text, score, box: mapped });
    });
    return { lines };
  }

  /**
   * 1 枚の画像を読む（デスクトップ版 ppocrv6_small.py の recognize_file 相当）。
   * 戻り値の mode は、通常の検出なら 'det'、検出が空で全体を 1 行として読んだなら 'rec-only'。
   */
  async recognize(image) {
    const { width, height } = image;
    const { image: scaled, scale } = upscale(image);
    const { image: prepared, margin } = addMargin(scaled);
    const result = await this.runRapid(prepared, true);
    let lines = result.lines.map((l) => ({
      text: l.text,
      confidence: l.score,
      box: l.box.map(([x, y]) => [
        Math.min(Math.max((x - margin) / scale, 0), width),
        Math.min(Math.max((y - margin) / scale, 0), height),
      ]),
    }));
    lines = dropRedundant(lines);
    if (lines.length > 0) return { mode: 'det', lines };

    const fallback = await this.runRapid(image, false);
    const recLines = fallback.lines
      .filter((l) => l.score >= FALLBACK_MIN_SCORE)
      .map((l) => ({ text: l.text, confidence: l.score, box: [[0, 0], [width, 0], [width, height], [0, height]] }));
    return { mode: 'rec-only', lines: recLines };
  }
}

function resizeWithinBounds(img) {
  let image = img, ratioH = 1, ratioW = 1;
  const resizeTo = (src, ratio) => {
    const rh = roundHalfEven(Math.trunc(src.height * ratio) / 32) * 32;
    const rw = roundHalfEven(Math.trunc(src.width * ratio) / 32) * 32;
    if (rh <= 0 || rw <= 0) throw new Error('resize failed');
    return { out: resizeLinear(src, rw, rh), ratioH: src.height / rh, ratioW: src.width / rw };
  };
  if (Math.max(image.height, image.width) > MAX_SIDE_LEN) {
    const ratio = MAX_SIDE_LEN / (image.height > image.width ? image.height : image.width);
    const r = resizeTo(image, ratio);
    image = r.out; ratioH = r.ratioH; ratioW = r.ratioW;
  }
  if (Math.min(image.height, image.width) < MIN_SIDE_LEN) {
    const ratio = MIN_SIDE_LEN / (image.height < image.width ? image.height : image.width);
    const r = resizeTo(image, ratio);
    image = r.out; ratioH = r.ratioH; ratioW = r.ratioW;
  }
  return { image, ratioH, ratioW };
}

function verticalPadding(image) {
  const { width: w, height: h } = image;
  if (h <= PAD_MIN_HEIGHT || w / h > PAD_RATIO) {
    const newH = Math.max(Math.trunc(w / PAD_RATIO), PAD_MIN_HEIGHT) * 2;
    const pad = Math.trunc(Math.abs(newH - h) / 2);
    return { image: addBorder(image, pad, pad, 0, 0, [0, 0, 0]), top: pad };
  }
  return { image, top: 0 };
}

/** 箱の範囲を切り出して水平にする（get_rotate_crop_image）。縦長なら反時計回りに 90 度回す。 */
function cropRotated(image, box) {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = Math.trunc(Math.max(dist(box[0], box[1]), dist(box[2], box[3])));
  const h = Math.trunc(Math.max(dist(box[0], box[3]), dist(box[1], box[2])));
  if (w <= 0 || h <= 0) return createImage(1, 1, 3);
  const dst = [[0, 0], [w, 0], [w, h], [0, h]];
  const inverse = getPerspectiveTransform(dst, box);
  const crop = warpPerspectiveCubic(image, inverse, w, h);
  return h / w >= 1.5 ? rotate90CounterClockwise(crop) : crop;
}

function upscale(image) {
  const { width, height } = image;
  if (height <= 0 || width <= 0 || height >= MIN_TEXT_HEIGHT) return { image, scale: 1 };
  const scale = Math.min(MIN_TEXT_HEIGHT / height, MAX_UPSCALE, MAX_SIDE / Math.max(height, width));
  if (scale <= 1) return { image, scale: 1 };
  const out = resizeCubic(image, Math.max(1, roundHalfEven(width * scale)), Math.max(1, roundHalfEven(height * scale)));
  return { image: out, scale };
}

function addMargin(image) {
  const { width, height, channels: c, data } = image;
  const samples = [];
  const push = (x, y) => { for (let k = 0; k < c; k++) samples.push(data[(y * width + x) * c + k]); };
  for (let x = 0; x < width; x++) push(x, 0);
  for (let x = 0; x < width; x++) push(x, height - 1);
  for (let y = 0; y < height; y++) push(0, y);
  for (let y = 0; y < height; y++) push(width - 1, y);
  const color = medianPerChannel(samples, c);
  const margin = Math.trunc(Math.min(MAX_MARGIN, Math.max(MIN_MARGIN, roundHalfEven(Math.min(height, width) * MARGIN_RATIO))));
  return { image: addBorder(image, margin, margin, margin, margin, color), margin };
}

function bounds(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);

function isDuplicateOf(a, b) {
  if (Math.min(a[2], b[2]) - Math.max(a[0], b[0]) <= 0) return false;
  const vertical = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const height = Math.min(a[3] - a[1], b[3] - b[1]);
  return height > 0 && vertical >= SAME_ROW_RATIO * height;
}

/** 同じ行を二重に検出した短い方を捨てる（余白を足したときに稀に起きる）。 */
function dropRedundant(lines) {
  const rects = lines.map((l) => bounds(l.box));
  return lines.filter((line, i) => {
    for (let j = 0; j < lines.length; j++) {
      if (i === j || !lines[j].text.includes(line.text) || area(rects[i]) <= 0) continue;
      const smaller = area(rects[i]) < area(rects[j]) || (area(rects[i]) === area(rects[j]) && j < i);
      if (smaller && isDuplicateOf(rects[i], rects[j])) return false;
    }
    return true;
  });
}
