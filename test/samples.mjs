// Run the outline tracer on the sample designs in samples/ and write overlays + DXF.
// Usage: node test/samples.mjs [outDir] [filter]
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { prepareInk, outline, centreline, suggestMode } from '../src/core/pipeline.js';
import { pathsToDXF } from '../src/core/export.js';
import { writePNG } from './png.mjs';

const out = process.argv[2] || '.out/samples';
const filter = process.argv[3] || '';
mkdirSync(out, { recursive: true });
for (const f of readdirSync('samples').filter((f) => f.endsWith('.jpg') && f.includes(filter)).sort()) {
  const img = jpeg.decode(readFileSync(`samples/${f}`), { useTArray: true, formatAsRGBA: true });
  const t0 = Date.now();
  const prep = prepareInk(img.data, img.width, img.height, { maxSide: 2400, blur: 0.8, sizeMM: 1000, sizeAxis: 'width', invert: false });
  const sug = suggestMode(prep);
  const res = sug.mode === 'centreline' ? centreline(prep, {}) : outline(prep, { straight: f.includes('geometric') });
  console.log(`  suggest ${sug.mode} (coverage ${sug.coverage.toFixed(3)}, stroke ${sug.strokePx.toFixed(1)}px)`);
  const ms = Date.now() - t0;
  const verts = res.paths.reduce((s, p) => s + p.pts.length, 0);
  console.log(`${f}: ${img.width}x${img.height} -> ${res.paths.length} paths (${res.pieces} pieces, ${res.holes} holes), ${verts} vertices, ${ms} ms, bg=${prep.ink.bg}`);
  // overlay: faded crop + red contours, at 1:1 working px
  const { w, h, crop, mmPerPx } = prep;
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = 0.55 + 0.45 * (crop[i * 4 + c] / 255);
  const plot = (x, y, col) => { const xi = Math.round(x), yi = Math.round(y); if (xi >= 0 && yi >= 0 && xi < w && yi < h) rgb.set(col, (yi * w + xi) * 3); };
  for (const p of res.paths) {
    const col = p.kind === 'hole' ? [0.05, 0.25, 0.9] : p.closed ? [0.85, 0.05, 0.05] : [0.0, 0.6, 0.1];
    for (let i = 0; i < p.pts.length - (p.closed ? 0 : 1); i++) {
      const a = p.pts[i], b = p.pts[(i + 1) % p.pts.length];
      const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / mmPerPx) + 1;
      for (let k = 0; k <= n; k++) plot((a.x + ((b.x - a.x) * k) / n) / mmPerPx, (a.y + ((b.y - a.y) * k) / n) / mmPerPx, col);
    }
  }
  writePNG({ w, h, data: rgb, rgb: true }, `${out}/${f.replace('.jpg', '')}-result.png`);
  writeFileSync(`${out}/${f.replace('.jpg', '')}.dxf`, pathsToDXF(res.paths, { height: res.heightMM }));
}
