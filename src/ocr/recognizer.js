// SPDX-License-Identifier: Apache-2.0
// Portions of this file are ported from RapidOCR (https://github.com/RapidAI/RapidOCR),
// Copyright RapidOCR Authors, which in turn derives from PaddleOCR (Copyright PaddlePaddle Authors),
// both licensed under the Apache License, Version 2.0 (see LICENSES/Apache-2.0.txt).
// Modified by ytmknd (2026): translated from Python to JavaScript for OCRDesk Web.
// 文字列の認識（PP-OCRv6 Small rec）。RapidOCR の TextRecognizer / CTCLabelDecode の移植。
import { resizeLinear } from './image.js';

const IMG_H = 48;
const IMG_W = 320;
const BATCH = 6;

/**
 * モデルに埋め込まれていた文字表（1 行 1 文字）から、CTC の文字表を作る。
 * 先頭に blank、末尾に空白を足す（RapidOCR と同じ）。
 */
export function buildCharacterTable(keysText) {
  const lines = keysText.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return ['blank', ...lines.map((l) => l.replace(/\r$/, '')), ' '];
}

function toTensorData(image, width, out, offset) {
  // 48 x width に縮小し、右側は 0（正規化後の値なので中間の灰色）で埋める。
  const ratio = image.width / image.height;
  const resizedW = Math.ceil(IMG_H * ratio) > width ? width : Math.ceil(IMG_H * ratio);
  const resized = resizeLinear(image, Math.max(1, resizedW), IMG_H);
  const plane = IMG_H * width;
  const src = resized.data;
  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < resized.width; x++) {
      const s = (y * resized.width + x) * 3;
      const d = offset + y * width + x;
      out[d] = (src[s] / 255 - 0.5) / 0.5;
      out[d + plane] = (src[s + 1] / 255 - 0.5) / 0.5;
      out[d + 2 * plane] = (src[s + 2] / 255 - 0.5) / 0.5;
    }
  }
}

function decode(probs, steps, classes, batchIndex, characters) {
  let text = '';
  const confs = [];
  let previous = -1;
  const base = batchIndex * steps * classes;
  for (let t = 0; t < steps; t++) {
    let best = 0, bestValue = -Infinity;
    const row = base + t * classes;
    for (let k = 0; k < classes; k++) {
      const v = probs[row + k];
      if (v > bestValue) { bestValue = v; best = k; }
    }
    if (best !== 0 && best !== previous) {
      text += characters[best];
      confs.push(Math.round(bestValue * 1e5) / 1e5);
    }
    previous = best;
  }
  const score = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
  return { text, score: Math.round(score * 1e5) / 1e5 };
}

/** 切り出した行画像（BGR）の文字列とスコアを返す。結果は入力と同じ順。 */
export async function recognizeText(ort, session, characters, images) {
  const results = new Array(images.length);
  const order = images.map((img, i) => ({ i, r: img.width / img.height })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.i);
  for (let begin = 0; begin < order.length; begin += BATCH) {
    const indices = order.slice(begin, begin + BATCH);
    let maxRatio = IMG_W / IMG_H;
    for (const i of indices) maxRatio = Math.max(maxRatio, images[i].width / images[i].height);
    const width = Math.trunc(IMG_H * maxRatio);
    const plane = IMG_H * width;
    const data = new Float32Array(indices.length * 3 * plane);
    indices.forEach((imgIndex, b) => toTensorData(images[imgIndex], width, data, b * 3 * plane));
    const tensor = new ort.Tensor('float32', data, [indices.length, 3, IMG_H, width]);
    const output = await session.run({ [session.inputNames[0]]: tensor });
    const pred = output[session.outputNames[0]];
    const [, steps, classes] = pred.dims;
    if (classes !== characters.length) {
      throw new Error(`character table mismatch: model has ${classes} classes, table has ${characters.length}`);
    }
    indices.forEach((imgIndex, b) => { results[imgIndex] = decode(pred.data, steps, classes, b, characters); });
  }
  return results;
}
