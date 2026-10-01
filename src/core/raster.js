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

// Where a source-image point lands in the straightened outW x outH crop of quad q.
export function quadToCrop(q, pt, outW, outH) {
  const { a, b, c, d, e, f, g, h } = squareToQuad(q);
  // Inverse of [[a b c] [d e f] [g h 1]] by cofactors (the scale cancels out).
  const A = e - f * h, B = c * h - b, C = b * f - c * e;
  const D = f * g - d, E = a - c * g, F = c * d - a * f;
  const G = d * h - e * g, Hh = b * g - a * h, I = a * e - b * d;
  const z = G * pt.x + Hh * pt.y + I;
  return { x: ((A * pt.x + B * pt.y + C) / z) * outW, y: ((D * pt.x + E * pt.y + F) / z) * outH };
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
// Colour -> design field: 0 = background, 1 = design, for every pixel of the crop.
//   bg:       the background colour [r, g, b], or null: the median colour of the crop's border.
//   design:   the design colour [r, g, b], or null. With it, a pixel's value is how far it lies
//             along the line from the background colour to the design colour, so a grey halfway
//             between white paper and black ink reads 0.5 (pencil shading, shadows, the desk).
//             Without it, a pixel's value is its distance from the background colour.
export function inkFromRGBA(rgba, w, h, { bg = null, design = null } = {}) {
  bg = bg ?? borderColor(rgba, w, h);
  const dist = new Float32Array(w * h);
  // Perceptual colour (CIE76 in Lab) so pale-but-saturated colours (gold highlights) still
  // read as material while light greys (watermarks, JPEG noise) do not.
  const bgLab = rgbToLab(bg[0], bg[1], bg[2]);
  const dLab = design && rgbToLab(design[0], design[1], design[2]);
  const ax = dLab && [dLab[0] - bgLab[0], dLab[1] - bgLab[1], dLab[2] - bgLab[2]];
  const ax2 = ax && Math.max(1e-6, ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2]);
  for (let i = 0, j = 0; i < dist.length; i++, j += 4) {
    const a = rgba[j + 3] / 255;
    const L = rgbToLab(rgba[j] * a + bg[0] * (1 - a), rgba[j + 1] * a + bg[1] * (1 - a), rgba[j + 2] * a + bg[2] * (1 - a));
    const d0 = L[0] - bgLab[0], d1 = L[1] - bgLab[1], d2 = L[2] - bgLab[2];
    dist[i] = ax ? (d0 * ax[0] + d1 * ax[1] + d2 * ax[2]) / ax2 : Math.hypot(d0, d1, d2) / 100;
  }
  if (ax) {
    for (let i = 0; i < dist.length; i++) dist[i] = Math.min(1, Math.max(0, dist[i]));
  } else {
    // Scale so the typical ink colour maps near 1: use a high percentile of the distances.
    const sorted = Float32Array.from(dist).sort();
    const hi = Math.max(0.08, sorted[Math.floor(sorted.length * 0.995)]);
    for (let i = 0; i < dist.length; i++) dist[i] = Math.min(1, dist[i] / hi);
  }
  return { w, h, data: dist, bg };
}

// Per-channel median of the border: robust to a design that touches the edge.
export function borderColor(rgba, w, h) {
  const border = [];
  const step = Math.max(1, Math.floor((w + h) / 400));
  const push = (x, y) => { const j = (y * w + x) * 4; border.push([rgba[j], rgba[j + 1], rgba[j + 2]]); };
  for (let x = 0; x < w; x += step) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y += step) { push(0, y); push(w - 1, y); }
  const med = (k) => border.map((p) => p[k]).sort((a, b) => a - b)[border.length >> 1];
  return [med(0), med(1), med(2)];
}

// The colour the design most likely has: the median colour of the pixels furthest from the background.
export function guessDesignColor(rgba, w, h, bg) {
  const bgLab = rgbToLab(bg[0], bg[1], bg[2]);
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 250000)));
  const px = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const j = (y * w + x) * 4, L = rgbToLab(rgba[j], rgba[j + 1], rgba[j + 2]);
    px.push([Math.hypot(L[0] - bgLab[0], L[1] - bgLab[1], L[2] - bgLab[2]), rgba[j], rgba[j + 1], rgba[j + 2]]);
  }
  px.sort((a, b) => b[0] - a[0]);
  const top = px.slice(0, Math.max(1, Math.ceil(px.length * 0.01)));
  const med = (k) => top.map((p) => p[k]).sort((a, b) => a - b)[top.length >> 1];
  return [med(1), med(2), med(3)];
}

// Uneven light (a shadow across the paper, a lamp on one side): find how bright the background
// is at every spot and divide that out, so the whole crop looks evenly lit before the colours
// are read. The light map is smooth on purpose: it is measured on a coarse grid from the
// background side of every cell (its brighter pixels when the design is darker than the
// background, its darker ones when it is lighter), and cells that are mostly design are
// replaced by a smooth fit through the others, so big solid shapes are not taken for shade.
//   returns { rgba, gain }: the evenly lit copy, and the light per pixel (1 = as bright as bg)
export function evenLight(rgba, w, h, { bg = null, design = null, cells = 12 } = {}) {
  bg = bg ?? borderColor(rgba, w, h);
  design = design ?? guessDesignColor(rgba, w, h, bg);
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const bgLum = Math.max(1, lum(bg[0], bg[1], bg[2]));
  const darkDesign = lum(design[0], design[1], design[2]) <= bgLum;
  const q = darkDesign ? 0.8 : 0.2;   // the background side of a cell
  // Grid of about square cells, `cells` along the long side.
  const cs = Math.max(8, Math.ceil(Math.max(w, h) / cells));
  const gx = Math.ceil(w / cs), gy = Math.ceil(h / cs);
  const level = new Float64Array(gx * gy);
  const step = Math.max(1, Math.floor(cs / 24));
  for (let cy = 0; cy < gy; cy++) for (let cx = 0; cx < gx; cx++) {
    const v = [];
    for (let y = cy * cs; y < Math.min(h, (cy + 1) * cs); y += step)
      for (let x = cx * cs; x < Math.min(w, (cx + 1) * cs); x += step) { const j = (y * w + x) * 4; v.push(lum(rgba[j], rgba[j + 1], rgba[j + 2])); }
    v.sort((a, b) => a - b);
    level[cy * gx + cx] = v[Math.min(v.length - 1, Math.floor(v.length * q))];
  }
  // Robust smooth fit (quadratic surface, reweighted): cells far to the design side of the
  // fit are design, not shade, and take the fit's value instead.
  const fit = robustQuadFit(level, gx, gy, darkDesign);
  for (let i = 0; i < level.length; i++) {
    const designSide = darkDesign ? level[i] < fit[i] * 0.8 : level[i] > fit[i] * 1.25;
    if (designSide) level[i] = fit[i];
  }
  // Light per pixel: bilinear between cell centres, relative to the background colour.
  const gain = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gy - 1, Math.max(0, (y + 0.5) / cs - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(gy - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gx - 1, Math.max(0, (x + 0.5) / cs - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(gx - 1, x0 + 1), tx = fx - x0;
      const l = (level[y0 * gx + x0] * (1 - tx) + level[y0 * gx + x1] * tx) * (1 - ty) + (level[y1 * gx + x0] * (1 - tx) + level[y1 * gx + x1] * tx) * ty;
      gain[y * w + x] = Math.max(0.05, l / bgLum);
    }
  }
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0, j = 0; i < gain.length; i++, j += 4) {
    const k = 1 / gain[i];
    out[j] = rgba[j] * k; out[j + 1] = rgba[j + 1] * k; out[j + 2] = rgba[j + 2] * k; out[j + 3] = rgba[j + 3];
  }
  return { rgba: out, gain, bg, design };
}

// Least-squares quadratic surface through a grid of values, refitted a few times with the
// cells on the design side of the previous fit given almost no weight.
function robustQuadFit(v, gx, gy, darkDesign) {
  const n = v.length, wt = new Float64Array(n).fill(1);
  const pts = [];
  for (let y = 0; y < gy; y++) for (let x = 0; x < gx; x++) {
    const u = x / Math.max(1, gx - 1) - 0.5, t = y / Math.max(1, gy - 1) - 0.5;
    pts.push([1, u, t, u * u, u * t, t * t]);
  }
  const k = n >= 12 ? 6 : n >= 3 ? 3 : 1;
  const fit = new Float64Array(n);
  for (let it = 0; it < 6; it++) {
    const A = Array.from({ length: k }, () => new Float64Array(k)), b = new Float64Array(k);
    for (let i = 0; i < n; i++) for (let r = 0; r < k; r++) {
      b[r] += wt[i] * pts[i][r] * v[i];
      for (let c = 0; c < k; c++) A[r][c] += wt[i] * pts[i][r] * pts[i][c];
    }
    for (let r = 0; r < k; r++) A[r][r] += 1e-6;
    const coef = solve(A, b);
    for (let i = 0; i < n; i++) { let s = 0; for (let r = 0; r < k; r++) s += coef[r] * pts[i][r]; fit[i] = s; }
    for (let i = 0; i < n; i++) {
      const rel = (v[i] - fit[i]) / Math.max(1, Math.abs(fit[i]));
      wt[i] = (darkDesign ? -rel : rel) > 0.08 ? 0.02 : 1;   // far to the design side: not shade
    }
  }
  return fit;
}

// Gaussian elimination with partial pivoting (tiny systems).
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / d; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

// The median colour of a small square around (x, y) in an RGBA image: a picked colour that a
// single noisy pixel can't throw off.
export function sampleColor(rgba, w, h, x, y, r = 3) {
  const ch = [[], [], []];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const xi = Math.min(w - 1, Math.max(0, Math.round(x) + dx)), yi = Math.min(h - 1, Math.max(0, Math.round(y) + dy));
    const j = (yi * w + xi) * 4;
    for (let k = 0; k < 3; k++) ch[k].push(rgba[j + k]);
  }
  return ch.map((c) => c.sort((a, b) => a - b)[c.length >> 1]);
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
