// Synthetic Islamic-style patterns for demos and tests, plus a "bad photo" degrader.
import { squareToQuad, sample, gaussianBlur } from './raster.js';

// Classic 8-point star (two overlapping squares) on a square grid, with the star tips
// joined to the tile edges and corners. Returns centreline segments in mm.
export function khatamGrid({ panelW = 800, panelH = 1600, nx = 2, ny = 4, frame = 40 } = {}) {
  const segs = [];
  const iw = panelW - 2 * frame, ih = panelH - 2 * frame;
  const s = Math.min(iw / nx, ih / ny);
  const ox = frame + (iw - s * nx) / 2, oy = frame + (ih - s * ny) / 2;
  const a = s * 0.21, b = a * Math.SQRT2;
  const add = (cx, cy, pts) => {
    for (let i = 0; i + 1 < pts.length; i++) segs.push({ a: { x: cx + pts[i][0], y: cy + pts[i][1] }, b: { x: cx + pts[i + 1][0], y: cy + pts[i + 1][1] } });
  };
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const cx = ox + (i + 0.5) * s, cy = oy + (j + 0.5) * s;
      add(cx, cy, [[-a, -a], [a, -a], [a, a], [-a, a], [-a, -a]]);
      add(cx, cy, [[b, 0], [0, b], [-b, 0], [0, -b], [b, 0]]);
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) add(cx, cy, [[dx * b, dy * b], [(dx * s) / 2, (dy * s) / 2]]);
      for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) add(cx, cy, [[dx * a, dy * a], [(dx * s) / 2, (dy * s) / 2]]);
    }
  // tile boundary grid
  for (let i = 0; i <= nx; i++) segs.push({ a: { x: ox + i * s, y: oy }, b: { x: ox + i * s, y: oy + ny * s } });
  for (let j = 0; j <= ny; j++) segs.push({ a: { x: ox, y: oy + j * s }, b: { x: ox + nx * s, y: oy + j * s } });
  return { segs, panelW, panelH, nx, ny, tile: s, origin: { x: ox, y: oy } };
}

// A single 10-fold rosette: star {10/3} plus petals out to an enclosing decagon.
export function rosette({ size = 1000, n = 10 } = {}) {
  const segs = [], c = size / 2, R = size * 0.42, r = R * 0.55;
  const P = (rad, k) => ({ x: c + rad * Math.cos((2 * Math.PI * k) / n - Math.PI / 2), y: c + rad * Math.sin((2 * Math.PI * k) / n - Math.PI / 2) });
  for (let k = 0; k < n; k++) {
    segs.push({ a: P(r, k), b: P(r, k + 3) });
    segs.push({ a: P(R, k), b: P(R, k + 1) });
    segs.push({ a: P(r, k), b: P(R, k) });
  }
  return { segs, panelW: size, panelH: size };
}

// Render centrelines as straps of width `band` (mm) at `pxPerMM`. Dark straps on light ground.
export function render(segs, { panelW, panelH, band = 30, pxPerMM = 0.6 }) {
  const w = Math.round(panelW * pxPerMM), h = Math.round(panelH * pxPerMM);
  const data = new Float32Array(w * h).fill(1);
  const hw = (band * pxPerMM) / 2;
  for (const s of segs) {
    const ax = s.a.x * pxPerMM, ay = s.a.y * pxPerMM, bx = s.b.x * pxPerMM, by = s.b.y * pxPerMM;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw - 1)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + hw + 1));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - hw - 1)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + hw + 1));
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
        const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
        const cov = Math.max(0, Math.min(1, hw + 0.5 - d));
        const i = y * w + x;
        data[i] = Math.min(data[i], 1 - cov);
      }
  }
  return { w, h, data };
}

// Deterministic PRNG so tests are reproducible.
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function invert3(H) {
  const m = [H.a, H.b, H.c, H.d, H.e, H.f, H.g, H.h, 1];
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
  return inv;
}

// Place the panel image into a photo at quad `corners` (clockwise from top-left) with blur,
// noise, uneven lighting and low contrast.
export function degrade(panel, { photoW, photoH, corners, blur = 2, noise = 0.06, contrast = 0.55, seed = 7 }) {
  const H = squareToQuad(corners);
  const inv = invert3(H);
  const rand = rng(seed);
  const data = new Float32Array(photoW * photoH);
  for (let y = 0; y < photoH; y++)
    for (let x = 0; x < photoW; x++) {
      const px = x + 0.5, py = y + 0.5;
      const z = inv[6] * px + inv[7] * py + inv[8];
      const u = (inv[0] * px + inv[1] * py + inv[2]) / z, v = (inv[3] * px + inv[4] * py + inv[5]) / z;
      let val;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) val = sample(panel, Math.min(panel.w - 1, Math.max(0, u * panel.w - 0.5)), Math.min(panel.h - 1, Math.max(0, v * panel.h - 0.5)));
      else val = 0.45 + 0.1 * Math.sin(x / 37) * Math.cos(y / 53); // wall / background
      data[y * photoW + x] = val;
    }
  let img = gaussianBlur({ w: photoW, h: photoH, data }, blur);
  const out = new Float32Array(photoW * photoH);
  for (let y = 0; y < photoH; y++)
    for (let x = 0; x < photoW; x++) {
      const light = 0.65 + 0.35 * (x / photoW) * (1 - 0.5 * (y / photoH)); // shadow gradient
      const n = (rand() + rand() + rand() - 1.5) * noise * 2;
      out[y * photoW + x] = Math.min(1, Math.max(0, (0.5 + (img.data[y * photoW + x] - 0.5) * contrast) * light + n));
    }
  return { w: photoW, h: photoH, data: out };
}
