// 画像処理の基本部品。OpenCV（cv2）と同じ結果になるよう計算方法を合わせている。
// 画像は { width, height, channels, data: Uint8Array }（行優先、画素ごとにチャンネルが並ぶ）で表す。
// OCR モデルは OpenCV で読んだ BGR 画像で学習されているので、カラー画像は BGR で持つ。

/** 空の画像を作る。 */
export function createImage(width, height, channels = 3) {
  return { width, height, channels, data: new Uint8Array(width * height * channels) };
}

/**
 * RGBA（canvas の ImageData など）を白背景に合成して BGR にする。
 * 透明部分を黒のまま渡すと黒地に黒文字になって読めなくなるため、白で埋める。
 */
export function bgrFromRgba(rgba, width, height) {
  const out = createImage(width, height, 3);
  const src = rgba;
  const dst = out.data;
  for (let i = 0, j = 0; i < width * height * 4; i += 4, j += 3) {
    const a = src[i + 3];
    if (a === 255) {
      dst[j] = src[i + 2];
      dst[j + 1] = src[i + 1];
      dst[j + 2] = src[i];
    } else {
      const alpha = a / 255;
      const back = 255 * (1 - alpha);
      dst[j] = Math.round(src[i + 2] * alpha + back);
      dst[j + 1] = Math.round(src[i + 1] * alpha + back);
      dst[j + 2] = Math.round(src[i] * alpha + back);
    }
  }
  return out;
}

/** 画像の一部（行の範囲）を切り出す。 */
export function cropRows(image, top, height) {
  const { width, channels } = image;
  const out = createImage(width, height, channels);
  out.data.set(image.data.subarray(top * width * channels, (top + height) * width * channels));
  return out;
}

const clampByte = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/** Python の round()（偶数丸め）。RapidOCR の寸法計算に合わせる。 */
export function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** cv2.resize(..., interpolation=INTER_LINEAR) 相当（画素中心を合わせる双線形補間）。 */
export function resizeLinear(image, dstWidth, dstHeight) {
  const { width: sw, height: sh, channels: c, data: src } = image;
  const out = createImage(dstWidth, dstHeight, c);
  const dst = out.data;
  const scaleX = sw / dstWidth;
  const scaleY = sh / dstHeight;
  const xs0 = new Int32Array(dstWidth);
  const xs1 = new Int32Array(dstWidth);
  const xw = new Float32Array(dstWidth);
  for (let x = 0; x < dstWidth; x++) {
    let fx = (x + 0.5) * scaleX - 0.5;
    let sx = Math.floor(fx);
    fx -= sx;
    if (sx < 0) { sx = 0; fx = 0; }
    if (sx >= sw - 1) { sx = sw - 1; fx = 0; }
    xs0[x] = sx;
    xs1[x] = Math.min(sx + 1, sw - 1);
    xw[x] = fx;
  }
  for (let y = 0; y < dstHeight; y++) {
    let fy = (y + 0.5) * scaleY - 0.5;
    let sy = Math.floor(fy);
    fy -= sy;
    if (sy < 0) { sy = 0; fy = 0; }
    if (sy >= sh - 1) { sy = sh - 1; fy = 0; }
    const sy1 = Math.min(sy + 1, sh - 1);
    const row0 = sy * sw * c;
    const row1 = sy1 * sw * c;
    let o = y * dstWidth * c;
    for (let x = 0; x < dstWidth; x++) {
      const a0 = xs0[x] * c, a1 = xs1[x] * c, wx = xw[x];
      for (let k = 0; k < c; k++) {
        const top = src[row0 + a0 + k] * (1 - wx) + src[row0 + a1 + k] * wx;
        const bottom = src[row1 + a0 + k] * (1 - wx) + src[row1 + a1 + k] * wx;
        dst[o++] = clampByte(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return out;
}

const CUBIC_A = -0.75;

/** OpenCV の 3 次補間の係数（A = -0.75）。 */
export function cubicCoeffs(x, out) {
  const A = CUBIC_A;
  out[0] = ((A * (x + 1) - 5 * A) * (x + 1) + 8 * A) * (x + 1) - 4 * A;
  out[1] = ((A + 2) * x - (A + 3)) * x * x + 1;
  out[2] = ((A + 2) * (1 - x) - (A + 3)) * (1 - x) * (1 - x) + 1;
  out[3] = 1 - out[0] - out[1] - out[2];
  return out;
}

/** cv2.resize(..., interpolation=INTER_CUBIC) 相当。縁は端の画素を繰り返す。 */
export function resizeCubic(image, dstWidth, dstHeight) {
  const { width: sw, height: sh, channels: c, data: src } = image;
  const out = createImage(dstWidth, dstHeight, c);
  const dst = out.data;
  const scaleX = sw / dstWidth;
  const scaleY = sh / dstHeight;
  const clampX = (v) => (v < 0 ? 0 : v >= sw ? sw - 1 : v);
  const clampY = (v) => (v < 0 ? 0 : v >= sh ? sh - 1 : v);
  const xIdx = new Int32Array(dstWidth * 4);
  const xW = new Float32Array(dstWidth * 4);
  const coeff = new Float64Array(4);
  for (let x = 0; x < dstWidth; x++) {
    const fx = (x + 0.5) * scaleX - 0.5;
    const sx = Math.floor(fx);
    cubicCoeffs(fx - sx, coeff);
    for (let k = 0; k < 4; k++) {
      xIdx[x * 4 + k] = clampX(sx - 1 + k) * c;
      xW[x * 4 + k] = coeff[k];
    }
  }
  const rowTmp = new Float64Array(dstWidth * c * 4);
  for (let y = 0; y < dstHeight; y++) {
    const fy = (y + 0.5) * scaleY - 0.5;
    const sy = Math.floor(fy);
    cubicCoeffs(fy - sy, coeff);
    const wy = [coeff[0], coeff[1], coeff[2], coeff[3]];
    for (let r = 0; r < 4; r++) {
      const rowBase = clampY(sy - 1 + r) * sw * c;
      for (let x = 0; x < dstWidth; x++) {
        for (let k = 0; k < c; k++) {
          let s = 0;
          for (let t = 0; t < 4; t++) s += src[rowBase + xIdx[x * 4 + t] + k] * xW[x * 4 + t];
          rowTmp[(r * dstWidth + x) * c + k] = s;
        }
      }
    }
    let o = y * dstWidth * c;
    for (let x = 0; x < dstWidth; x++) {
      for (let k = 0; k < c; k++) {
        const i = x * c + k;
        const v = rowTmp[i] * wy[0] + rowTmp[dstWidth * c + i] * wy[1]
          + rowTmp[2 * dstWidth * c + i] * wy[2] + rowTmp[3 * dstWidth * c + i] * wy[3];
        dst[o++] = clampByte(v);
      }
    }
  }
  return out;
}

/** cv2.copyMakeBorder(..., BORDER_CONSTANT, value=color) 相当。 */
export function addBorder(image, top, bottom, left, right, color) {
  const { width, height, channels: c } = image;
  const out = createImage(width + left + right, height + top + bottom, c);
  const fill = color.map((v) => clampByte(v));
  const d = out.data;
  for (let i = 0; i < out.width * out.height; i++) {
    for (let k = 0; k < c; k++) d[i * c + k] = fill[k];
  }
  for (let y = 0; y < height; y++) {
    d.set(image.data.subarray(y * width * c, (y + 1) * width * c), ((y + top) * out.width + left) * c);
  }
  return out;
}

/** np.rot90（反時計回りに 90 度）。 */
export function rotate90CounterClockwise(image) {
  const { width, height, channels: c, data } = image;
  const out = createImage(height, width, c);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ny = width - 1 - x;
      const nx = y;
      for (let k = 0; k < c; k++) out.data[(ny * height + nx) * c + k] = data[(y * width + x) * c + k];
    }
  }
  return out;
}

/** チャンネルごとの中央値（np.median と同じく、偶数個なら中央 2 つの平均）。 */
export function medianPerChannel(samples, channels) {
  const n = samples.length / channels;
  const result = [];
  for (let k = 0; k < channels; k++) {
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) values[i] = samples[i * channels + k];
    values.sort();
    result.push(n % 2 === 1 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2);
  }
  return result;
}
