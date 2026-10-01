// Synthetic end-to-end evaluation: known pattern -> fake bad photo -> pipeline -> compare.
// Usage: node test/eval.mjs [--out dir]
import { writeFileSync, mkdirSync } from 'node:fs';
import { writePNG as png } from './png.mjs';
import { khatamGrid, rosette, render, degrade } from '../src/core/synth.js';
import { run } from '../src/core/pipeline.js';
import { pointSegDist } from '../src/core/geometry.js';
import { squareToQuad, applyH } from '../src/core/raster.js';
import { toDXF, toSVG } from '../src/core/export.js';

const outDir = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
if (outDir) mkdirSync(outDir, { recursive: true });

// RGB overlay: cleaned image (faded), mask, truth in green, result in red.
function overlay(out, truthMM) {
  const { img, mask } = out.cleaned;
  const { w, h } = img;
  const data = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const g = 0.6 + 0.4 * img.data[i] - (mask.data[i] ? 0.15 : 0);
    data[i * 3] = data[i * 3 + 1] = data[i * 3 + 2] = g;
  }
  const s = 1 / out.rect.mmPerPx;
  const line = (a, b, c, wd) => {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * s * 2) + 1;
    for (let k = 0; k <= n; k++) {
      const x = (a.x + ((b.x - a.x) * k) / n) * s, y = (a.y + ((b.y - a.y) * k) / n) * s;
      for (let dy = -wd; dy <= wd; dy++) for (let dx = -wd; dx <= wd; dx++) {
        const xx = Math.round(x + dx), yy = Math.round(y + dy);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        data.set(c, (yy * w + xx) * 3);
      }
    }
  };
  for (const t of truthMM) line(t.a, t.b, [0.1, 0.75, 0.2], 1);
  for (const t of out.result.centrelines) line(t.a, t.b, [0.9, 0.1, 0.1], 0);
  return { w, h, data, rgb: true };
}

// Distance from points sampled along `from` to the nearest segment in `to`.
function directed(from, to, step = 2) {
  const d = [];
  for (const s of from) {
    const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y), n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k <= n; k++) {
      const p = { x: s.a.x + ((s.b.x - s.a.x) * k) / n, y: s.a.y + ((s.b.y - s.a.y) * k) / n };
      let best = Infinity;
      for (const t of to) best = Math.min(best, pointSegDist(p, t.a, t.b));
      d.push(best);
    }
  }
  return d.sort((a, b) => a - b);
}

function report(name, truth, got, tolMM) {
  const fwd = directed(truth, got), back = directed(got, truth);
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))];
  const recall = fwd.filter((d) => d <= tolMM).length / fwd.length;
  const precision = back.filter((d) => d <= tolMM).length / back.length;
  const r = {
    case: name,
    segments: got.length,
    recall: +recall.toFixed(3),
    precision: +precision.toFixed(3),
    medianErrMM: +q(fwd, 0.5).toFixed(2),
    p95ErrMM: +q(fwd, 0.95).toFixed(2),
  };
  console.log(JSON.stringify(r));
  return r;
}

const cases = [];

// 1) Gate panel, 2x4 grid of 8-point stars, photographed at an angle.
{
  const gt = khatamGrid({ panelW: 800, panelH: 1600, nx: 2, ny: 4, frame: 40 });
  const panel = render(gt.segs, { panelW: 800, panelH: 1600, band: 12, pxPerMM: 0.6 });
  const corners = [{ x: 140, y: 90 }, { x: 610, y: 150 }, { x: 640, y: 1030 }, { x: 110, y: 1080 }];
  const photo = degrade(panel, { photoW: 760, photoH: 1160, corners, blur: 2.2, noise: 0.07, contrast: 0.5 });
  const common = { panelW: 800, panelH: 1600, corners, frame: 40, workSize: 1200 };
  cases.push(['khatam-photo-nosym', gt, photo, common]);
  cases.push(['khatam-photo-mirror', gt, photo, { ...common, order: 2, mirror: true }]);
  // What a user would do for a repeating design: corners on the patterned area, 2x4 tiles,
  // 4-fold + mirror inside each tile, solid border added back around it.
  const H = squareToQuad(corners);
  const { x: ox, y: oy } = gt.origin, s = gt.tile;
  const pa = [[ox, oy], [ox + 2 * s, oy], [ox + 2 * s, oy + 4 * s], [ox, oy + 4 * s]].map(([x, y]) => applyH(H, x / 800, y / 1600));
  cases.push(['khatam-photo-grid', { segs: gt.segs.map((g) => ({ a: { x: g.a.x - ox, y: g.a.y - oy }, b: { x: g.b.x - ox, y: g.b.y - oy } })) }, photo,
    { panelW: 2 * s, panelH: 4 * s, corners: pa, nx: 2, ny: 4, order: 4, mirror: true, frame: 0, workSize: 1200 }]);
}

// 2) Single 10-fold rosette, blurry, with rotational symmetry enforced.
{
  const gt = rosette({ size: 1000, n: 10 });
  const panel = render(gt.segs, { panelW: 1000, panelH: 1000, band: 30, pxPerMM: 0.5 });
  const corners = [{ x: 60, y: 50 }, { x: 560, y: 80 }, { x: 540, y: 570 }, { x: 40, y: 560 }];
  const photo = degrade(panel, { photoW: 620, photoH: 620, corners, blur: 2.5, noise: 0.08, contrast: 0.5, seed: 3 });
  const common = { panelW: 1000, panelH: 1000, corners, frame: 0, workSize: 1000 };
  cases.push(['rosette-photo-nosym', gt, photo, common]);
  cases.push(['rosette-photo-sym10', gt, photo, { ...common, order: 10, mirror: true }]);
}

const results = [];
for (const [name, gt, photo, params] of cases) {
  const t0 = Date.now();
  const out = run(photo, params);
  const ms = Date.now() - t0;
  const r = report(name, gt.segs, out.result.centrelines, 6);
  r.ms = ms;
  r.snapDeg = out.vec.snapDeg;
  r.holes = out.result.stats.holeCount;
  r.warnings = out.result.warnings.length;
  results.push(r);
  if (outDir) {
    png(photo, `${outDir}/${name}-photo.png`);
    png(overlay(out, gt.segs), `${outDir}/${name}-overlay.png`);
    writeFileSync(`${outDir}/${name}.svg`, toSVG(out.result, { panelW: params.panelW, panelH: params.panelH, centrelines: out.result.centrelines }));
    writeFileSync(`${outDir}/${name}.dxf`, toDXF(out.result, { panelH: params.panelH, centrelines: out.result.centrelines }));
  }
}
for (const r of results) console.log(`${r.case}: ${r.ms} ms, snap ${r.snapDeg} deg, ${r.holes} holes, ${r.warnings} warnings`);
