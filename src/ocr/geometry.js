// 幾何計算。OpenCV の minAreaRect / getPerspectiveTransform / warpPerspective に相当する処理。
import { createImage, cubicCoeffs } from './image.js';

/** 点群の凸包（Andrew の単調連鎖法）。点は [x, y]。 */
export function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * 最小外接矩形（cv2.minAreaRect + cv2.boxPoints 相当）。
 * 戻り値は 4 頂点と、短辺・長辺の長さ。
 */
export function minAreaRect(points) {
  const hull = convexHull(points);
  if (hull.length === 0) return { corners: [[0, 0], [0, 0], [0, 0], [0, 0]], width: 0, height: 0 };
  if (hull.length === 1) {
    const p = hull[0];
    return { corners: [p, p, p, p].map((q) => [q[0], q[1]]), width: 0, height: 0 };
  }
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len === 0) continue;
    const ux = ex / len, uy = ey / len;
    const nx = -uy, ny = ux;
    let minU = Infinity, maxU = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy;
      const n = p[0] * nx + p[1] * ny;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (n < minN) minN = n;
      if (n > maxN) maxN = n;
    }
    const area = (maxU - minU) * (maxN - minN);
    if (best === null || area < best.area - 1e-9) {
      best = { area, ux, uy, nx, ny, minU, maxU, minN, maxN };
    }
  }
  const { ux, uy, nx, ny, minU, maxU, minN, maxN } = best;
  const corner = (u, n) => [u * ux + n * nx, u * uy + n * ny];
  return {
    corners: [corner(minU, minN), corner(maxU, minN), corner(maxU, maxN), corner(minU, maxN)],
    width: maxU - minU,
    height: maxN - minN,
  };
}

/**
 * RapidOCR の get_mini_boxes。最小外接矩形の頂点を「左上・右上・右下・左下」の順に並べ、
 * 短辺の長さを返す。
 */
export function getMiniBoxes(points) {
  const rect = minAreaRect(points);
  // Python の sorted(key=x) は安定ソート。
  const pts = rect.corners.map((p, i) => ({ p, i })).sort((a, b) => a.p[0] - b.p[0] || a.i - b.i).map((x) => x.p);
  let i1, i2, i3, i4;
  if (pts[1][1] > pts[0][1]) { i1 = 0; i4 = 1; } else { i1 = 1; i4 = 0; }
  if (pts[3][1] > pts[2][1]) { i2 = 2; i3 = 3; } else { i2 = 3; i3 = 2; }
  return { box: [pts[i1], pts[i2], pts[i3], pts[i4]], side: Math.min(rect.width, rect.height) };
}

/** 多角形の面積と周長（shapely の Polygon.area / length）。 */
export function polygonAreaAndLength(poly) {
  let area = 0, length = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    area += a[0] * b[1] - b[0] * a[1];
    length += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return { area: Math.abs(area) / 2, length };
}

/**
 * RapidOCR の unclip。矩形を各辺から distance = area * ratio / length だけ外へ広げる
 * （pyclipper の丸め結合で広げた形の最小外接矩形は、各辺を distance だけ平行移動した矩形になる）。
 */
export function unclipRect(box, ratio) {
  const { area, length } = polygonAreaAndLength(box);
  if (length === 0) return box.map((p) => [p[0], p[1]]);
  const d = (area * ratio) / length;
  const cx = (box[0][0] + box[1][0] + box[2][0] + box[3][0]) / 4;
  const cy = (box[0][1] + box[1][1] + box[2][1] + box[3][1]) / 4;
  const ux = box[1][0] - box[0][0], uy = box[1][1] - box[0][1];
  const vx = box[3][0] - box[0][0], vy = box[3][1] - box[0][1];
  const lu = Math.hypot(ux, uy) || 1, lv = Math.hypot(vx, vy) || 1;
  const eu = [ux / lu, uy / lu], ev = [vx / lv, vy / lv];
  const hu = lu / 2 + d, hv = lv / 2 + d;
  return [
    [cx - eu[0] * hu - ev[0] * hv, cy - eu[1] * hu - ev[1] * hv],
    [cx + eu[0] * hu - ev[0] * hv, cy + eu[1] * hu - ev[1] * hv],
    [cx + eu[0] * hu + ev[0] * hv, cy + eu[1] * hu + ev[1] * hv],
    [cx - eu[0] * hu + ev[0] * hv, cy - eu[1] * hu + ev[1] * hv],
  ];
}

/** 点が多角形の内側か辺上（0.5 画素以内）にあるか。cv2.fillPoly が辺上の画素も塗ることに合わせる。 */
export function insideOrOnPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  if (inside) return true;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (distanceToSegment(x, y, poly[j], poly[i]) <= 0.5) return true;
  }
  return false;
}

function distanceToSegment(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((x - a[0]) * dx + (y - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

/** 4 点対応の射影変換行列（cv2.getPerspectiveTransform）。src の点を dst の点へ写す 3x3 行列。 */
export function getPerspectiveTransform(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
  }
  const h = solveLinear(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const p = M[col][col];
    if (Math.abs(p) < 1e-12) return new Array(n).fill(0);
    for (let c = col; c <= n; c++) M[col][c] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

const INTER_TAB_SIZE = 32;

/**
 * cv2.warpPerspective(src, M, (w, h), flags=INTER_CUBIC, borderMode=BORDER_REPLICATE) 相当。
 * inverse は出力座標から入力座標へ写す行列（M の逆行列）。
 * OpenCV と同じく、入力座標の端数を 1/32 単位に丸めてから 3 次補間する。
 */
export function warpPerspectiveCubic(image, inverse, outWidth, outHeight) {
  const { width: sw, height: sh, channels: c, data: src } = image;
  const out = createImage(outWidth, outHeight, c);
  const dst = out.data;
  const coeffTab = [];
  const tmp = new Float64Array(4);
  for (let i = 0; i < INTER_TAB_SIZE; i++) coeffTab.push(Array.from(cubicCoeffs(i / INTER_TAB_SIZE, tmp)));
  const clampX = (v) => (v < 0 ? 0 : v >= sw ? sw - 1 : v);
  const clampY = (v) => (v < 0 ? 0 : v >= sh ? sh - 1 : v);
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = inverse;
  let o = 0;
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const w = m6 * x + m7 * y + m8;
      const scale = w ? INTER_TAB_SIZE / w : 0;
      const X = Math.round((m0 * x + m1 * y + m2) * scale);
      const Y = Math.round((m3 * x + m4 * y + m5) * scale);
      const ix = Math.floor(X / INTER_TAB_SIZE), iy = Math.floor(Y / INTER_TAB_SIZE);
      const wx = coeffTab[X - ix * INTER_TAB_SIZE], wy = coeffTab[Y - iy * INTER_TAB_SIZE];
      for (let k = 0; k < c; k++) {
        let s = 0;
        for (let r = 0; r < 4; r++) {
          const row = clampY(iy - 1 + r) * sw;
          let rs = 0;
          for (let t = 0; t < 4; t++) rs += src[(row + clampX(ix - 1 + t)) * c + k] * wx[t];
          s += rs * wy[r];
        }
        dst[o++] = s <= 0 ? 0 : s >= 255 ? 255 : Math.round(s);
      }
    }
  }
  return out;
}
