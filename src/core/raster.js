// Raster stage: grayscale, perspective rectification, blur, symmetrization, thresholding.
// Images are { w, h, data: Float32Array } with values in 0..1 (0 = black).

export function grayFromRGBA(rgba, w, h) {
  const data = new Float32Array(w * h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    const a = rgba[j + 3] / 255;
    const g = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) / 255;
    data[i] = g * a + (1 - a); // transparent pixels become white
  }
  return { w, h, data };
}

export function sample(img, x, y) {
  const { w, h, data } = img;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return NaN;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0, fy = y - y0;
  const a = data[y0 * w + x0], b = data[y0 * w + x1];
  const c = data[y1 * w + x0], d = data[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

export function resize(img, maxSide) {
  const s = Math.min(1, maxSide / Math.max(img.w, img.h));
  if (s === 1) return img;
  // Box-filter down first to avoid aliasing on big photos, then bilinear.
  const w = Math.max(1, Math.round(img.w * s)), h = Math.max(1, Math.round(img.h * s));
  const blurred = gaussianBlur(img, 0.5 / s);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      out[y * w + x] = sample(blurred, Math.min((x + 0.5) / s - 0.5, img.w - 1), Math.min((y + 0.5) / s - 0.5, img.h - 1));
  return { w, h, data: out };
}

// Homography mapping unit-square corners (0,0),(1,0),(1,1),(0,1) to quad q[0..3].
export function squareToQuad(q) {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  let g = 0, hh = 0;
  if (Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) {
    const det = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / det;
    hh = (dx1 * dy3 - dx3 * dy1) / det;
  }
  return {
    a: p1.x - p0.x + g * p1.x, b: p3.x - p0.x + hh * p3.x, c: p0.x,
    d: p1.y - p0.y + g * p1.y, e: p3.y - p0.y + hh * p3.y, f: p0.y,
    g, h: hh,
  };
}

export function applyH(H, u, v) {
  const z = H.g * u + H.h * v + 1;
  return { x: (H.a * u + H.b * v + H.c) / z, y: (H.d * u + H.e * v + H.f) / z };
}

// Rectify the quad (clockwise from top-left) into an outW x outH image.
export function warpQuad(img, quad, outW, outH) {
  const H = squareToQuad(quad);
  const out = new Float32Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const v = (y + 0.5) / outH;
    for (let x = 0; x < outW; x++) {
      const p = applyH(H, (x + 0.5) / outW, v);
      const s = sample(img, p.x - 0.5, p.y - 0.5);
      out[y * outW + x] = Number.isNaN(s) ? 1 : s;
    }
  }
  return { w: outW, h: outH, data: out };
}

export function gaussianBlur(img, sigma) {
  if (!(sigma > 0.3)) return img;
  const { w, h, data } = img;
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += k[i + r] * data[row + Math.min(w - 1, Math.max(0, x + i))];
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = acc;
    }
  return { w, h, data: out };
}

// Remove slow lighting gradients (photos of metal, shadows) by dividing by a heavy blur.
export function flattenLighting(img, radius) {
  const bg = gaussianBlur(img, radius);
  const out = new Float32Array(img.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, img.data[i] / Math.max(bg.data[i], 1e-3) * 0.75);
  return normalize({ w: img.w, h: img.h, data: out });
}

export function normalize(img) {
  const sorted = Float32Array.from(img.data).sort();
  const lo = sorted[Math.floor(sorted.length * 0.01)], hi = sorted[Math.floor(sorted.length * 0.99)];
  const out = new Float32Array(img.data.length);
  const span = Math.max(hi - lo, 1e-6);
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, Math.max(0, (img.data[i] - lo) / span));
  return { w: img.w, h: img.h, data: out };
}

export function invert(img) {
  const out = new Float32Array(img.data.length);
  for (let i = 0; i < out.length; i++) out[i] = 1 - img.data[i];
  return { w: img.w, h: img.h, data: out };
}

// Symmetry group as a list of 2x3 affine maps {a,b,c,d,e,f}: x' = a x + b y + c, y' = d x + e y + f.
export function symmetryGroup({ w, h, nx = 1, ny = 1, order = 1, mirror = false, center = null }) {
  const tw = w / nx, th = h / ny;
  const rots = [];
  for (let k = 0; k < Math.max(1, order); k++) {
    const t = (2 * Math.PI * k) / Math.max(1, order);
    rots.push({ a: Math.cos(t), b: -Math.sin(t), d: Math.sin(t), e: Math.cos(t) });
    if (mirror) rots.push({ a: Math.cos(t), b: Math.sin(t), d: Math.sin(t), e: -Math.cos(t) });
  }
  // Rotations act about the tile centre (or the chosen centre when there is a single tile).
  const cx = nx === 1 && ny === 1 && center ? center.x : tw / 2;
  const cy = nx === 1 && ny === 1 && center ? center.y : th / 2;
  const local = rots.map((r) => ({ ...r, c: cx - r.a * cx - r.b * cy, f: cy - r.d * cx - r.e * cy }));
  return { tw, th, nx, ny, local };
}

export function applyA(m, x, y) {
  return { x: m.a * x + m.b * y + m.c, y: m.d * x + m.e * y + m.f };
}

// Average the image over the symmetry group. Translations are averaged into one tile first,
// then the tile is averaged over its rotations/reflections, then tiled back out.
export function symmetrize(img, group) {
  const { w, h } = img;
  const { nx, ny, tw, th, local } = group;
  const TW = Math.max(1, Math.round(tw)), TH = Math.max(1, Math.round(th));
  const sx = tw / TW, sy = th / TH;
  const tile = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y++)
    for (let x = 0; x < TW; x++) {
      let acc = 0, n = 0;
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const s = sample(img, i * tw + (x + 0.5) * sx - 0.5, j * th + (y + 0.5) * sy - 0.5);
          if (!Number.isNaN(s)) { acc += s; n++; }
        }
      tile[y * TW + x] = n ? acc / n : 1;
    }
  const tileImg = { w: TW, h: TH, data: tile };
  const single = nx === 1 && ny === 1;
  const sym = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y++)
    for (let x = 0; x < TW; x++) {
      const px = (x + 0.5) * sx, py = (y + 0.5) * sy;
      let acc = 0, n = 0;
      for (const m of local) {
        let q = applyA(m, px, py);
        if (!single) { q.x = mod(q.x, tw); q.y = mod(q.y, th); }
        const s = sample(tileImg, q.x / sx - 0.5, q.y / sy - 0.5);
        if (!Number.isNaN(s)) { acc += s; n++; }
      }
      sym[y * TW + x] = n ? acc / n : tile[y * TW + x];
    }
  const symImg = { w: TW, h: TH, data: sym };
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = sample(symImg, mod(x + 0.5, tw) / sx - 0.5, mod(y + 0.5, th) / sy - 0.5);
      out[y * w + x] = Number.isNaN(s) ? sym[Math.min(TH - 1, Math.floor(mod(y, th) / sy)) * TW + Math.min(TW - 1, Math.floor(mod(x, tw) / sx))] : s;
    }
  return { w, h, data: out };
}

export function mod(a, n) {
  return ((a % n) + n) % n;
}

export function otsu(img) {
  const bins = 256, hist = new Float64Array(bins);
  for (const v of img.data) hist[Math.min(bins - 1, Math.max(0, Math.floor(v * bins)))]++;
  const total = img.data.length;
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = 0, thr = 0.5;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = (i + 0.5) / bins; }
  }
  return thr;
}

// Binary mask (1 = line/strap). Dark lines on a light ground unless `lightLines`.
export function threshold(img, { level = null, lightLines = false } = {}) {
  const t = level ?? otsu(img);
  const mask = new Uint8Array(img.data.length);
  for (let i = 0; i < mask.length; i++) mask[i] = lightLines ? (img.data[i] > t ? 1 : 0) : (img.data[i] < t ? 1 : 0);
  return { w: img.w, h: img.h, data: mask, level: t };
}

// Guess whether the strapwork is the light or the dark part: lines are usually the minority.
export function guessLightLines(img) {
  const t = otsu(img);
  let dark = 0;
  for (const v of img.data) if (v < t) dark++;
  return dark > img.data.length / 2;
}

// Remove connected blobs smaller than minArea pixels.
export function removeSpecks(mask, minArea) {
  const { w, h, data } = mask;
  const seen = new Uint8Array(w * h), out = Uint8Array.from(data);
  const stack = [], comp = [];
  for (let i = 0; i < data.length; i++) {
    if (!data[i] || seen[i]) continue;
    stack.push(i); seen[i] = 1; comp.length = 0;
    while (stack.length) {
      const p = stack.pop(); comp.push(p);
      const x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (data[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
        }
    }
    if (comp.length < minArea) for (const p of comp) out[p] = 0;
  }
  return { w, h, data: out };
}

// Fill small holes (background blobs) inside straps.
export function fillHoles(mask, maxArea) {
  const inv = { w: mask.w, h: mask.h, data: mask.data.map((v) => 1 - v) };
  const cleaned = removeSpecks(inv, maxArea);
  return { w: mask.w, h: mask.h, data: cleaned.data.map((v) => 1 - v) };
}

// Median-ish stroke width estimate from a distance transform of the mask.
export function strokeWidth(mask) {
  const dist = distanceTransform(mask);
  const vals = [];
  const { w, h } = mask;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, d = dist[i];
      if (d <= 0) continue;
      // local maxima of the distance transform lie on the centreline
      if (d >= dist[i - 1] && d >= dist[i + 1] && d >= dist[i - w] && d >= dist[i + w]) vals.push(d);
    }
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  return 2 * vals[Math.floor(vals.length / 2)];
}

// Two-pass chamfer distance (approximates Euclidean) from background pixels.
export function distanceTransform(mask) {
  const { w, h, data } = mask;
  const INF = 1e9, d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = data[i] ? INF : 0;
  const a = 1, b = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let m = d[i];
      if (x > 0) m = Math.min(m, d[i - 1] + a);
      if (y > 0) {
        m = Math.min(m, d[i - w] + a);
        if (x > 0) m = Math.min(m, d[i - w - 1] + b);
        if (x < w - 1) m = Math.min(m, d[i - w + 1] + b);
      }
      d[i] = m;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let m = d[i];
      if (x < w - 1) m = Math.min(m, d[i + 1] + a);
      if (y < h - 1) {
        m = Math.min(m, d[i + w] + a);
        if (x < w - 1) m = Math.min(m, d[i + w + 1] + b);
        if (x > 0) m = Math.min(m, d[i + w - 1] + b);
      }
      d[i] = m;
    }
  return d;
}

// "Ink" field 0..1 from colour distance to the background colour (estimated from the
// border of the crop). Works for black-on-white, white-on-black, coloured fills (gold
// leaves), and coloured backgrounds. Returns { w, h, data, bg }.
export function inkFromRGBA(rgba, w, h) {
  const border = [];
  const step = Math.max(1, Math.floor((w + h) / 400));
  const push = (x, y) => { const j = (y * w + x) * 4; border.push([rgba[j], rgba[j + 1], rgba[j + 2], rgba[j + 3]]); };
  for (let x = 0; x < w; x += step) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y += step) { push(0, y); push(w - 1, y); }
  // Per-channel median of the border is robust to a design that touches the edge.
  const med = (k) => border.map((p) => p[k]).sort((a, b) => a - b)[border.length >> 1];
  const bg = [med(0), med(1), med(2)];
  const dist = new Float32Array(w * h);
  // Perceptual difference (CIE76 in Lab) so pale-but-saturated colours (gold highlights)
  // still read as material while light greys (watermarks, JPEG noise) do not.
  const bgLab = rgbToLab(bg[0], bg[1], bg[2]);
  for (let i = 0, j = 0; i < dist.length; i++, j += 4) {
    const a = rgba[j + 3] / 255;
    const L = rgbToLab(rgba[j] * a + bg[0] * (1 - a), rgba[j + 1] * a + bg[1] * (1 - a), rgba[j + 2] * a + bg[2] * (1 - a));
    dist[i] = Math.hypot(L[0] - bgLab[0], L[1] - bgLab[1], L[2] - bgLab[2]) / 100;
  }
  // Scale so the typical ink colour maps near 1: use a high percentile of the distances.
  const sorted = Float32Array.from(dist).sort();
  const hi = Math.max(0.08, sorted[Math.floor(sorted.length * 0.995)]);
  for (let i = 0; i < dist.length; i++) dist[i] = Math.min(1, dist[i] / hi);
  return { w, h, data: dist, bg };
}

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const fLab = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
export function rgbToLab(r, g, b) {
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const fx = fLab(x), fy = fLab(y), fz = fLab(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// Rectify an RGBA image: map the quad (clockwise from top-left) to an outW x outH image.
export function warpQuadRGBA(rgba, w, h, quad, outW, outH) {
  const H = squareToQuad(quad);
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const v = (y + 0.5) / outH;
    for (let x = 0; x < outW; x++) {
      const p = applyH(H, (x + 0.5) / outW, v);
      const sx = Math.min(w - 1, Math.max(0, p.x - 0.5)), sy = Math.min(h - 1, Math.max(0, p.y - 0.5));
      const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0, o = (y * outW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = rgba[(y0 * w + x0) * 4 + c], b = rgba[(y0 * w + x1) * 4 + c];
        const d = rgba[(y1 * w + x0) * 4 + c], e = rgba[(y1 * w + x1) * 4 + c];
        out[o + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
      }
    }
  }
  return out;
}
