// Trace real images the way the app does (crop, colour -> design, mode, trace) and draw the
// cut lines over the cropped image. For trying hard inputs and comparing settings.
//
//   node test/trace.mjs [filter]      reads samples/*.jpg and samples/params.json (both git-ignored)
//
// params.json: { "<file>.jpg": [ { "label": "...", "corners": [[x,y] x4] | null, "mode": "auto" |
// "outline" | "centreline", "level": 0.4, "invert": false, "straight": false, "smooth": 1.2,
// "pickDesign": [x, y], "pickBg": [x, y] (source px), "adaptive": false }, ... ] }
// Writes .out/trace/<file>-<label>.png (red: outer cuts, blue: holes, green: open lines) and
// prints one line of numbers per run.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { prepareInk, outline, centreline, suggestMode } from '../src/core/pipeline.js';
import { writePNG } from './png.mjs';

const filter = process.argv[2] || '';
const out = '.out/trace';
mkdirSync(out, { recursive: true });
const params = existsSync('samples/params.json') ? JSON.parse(readFileSync('samples/params.json', 'utf8')) : {};

for (const f of readdirSync('samples').filter((n) => n.endsWith('.jpg') && n.includes(filter)).sort()) {
  const img = jpeg.decode(readFileSync(`samples/${f}`), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
  for (const v of params[f] || [{ label: 'default' }]) {
    const corners = v.corners ? v.corners.map(([x, y]) => ({ x, y })) : null;
    const p = { corners, maxSide: 2400, blur: 0.8, sizeMM: 1000, sizeAxis: 'width', invert: !!v.invert, level: v.level ?? 0.4, smooth: v.smooth ?? 1.2, straight: !!v.straight,
      pickDesign: v.pickDesign ? { x: v.pickDesign[0], y: v.pickDesign[1] } : null, pickBg: v.pickBg ? { x: v.pickBg[0], y: v.pickBg[1] } : null, adaptive: !!v.adaptive, arcs: v.arcs ?? true, arcTolPx: v.arcTolPx ?? 0.3 };
    const t0 = Date.now();
    const prep = prepareInk(img.data, img.width, img.height, p);
    const sug = suggestMode(prep, p);
    const mode = !v.mode || v.mode === 'auto' ? sug.mode : v.mode;
    const res = mode === 'centreline' ? centreline(prep, p) : outline(prep, p);
    const ms = Date.now() - t0;
    const verts = res.paths.reduce((s, q) => s + q.pts.length, 0);
    const arcs = res.paths.reduce((s, q) => s + (q.segs || []).filter((g) => g.type === 'arc').length, 0);
    const lines = res.paths.reduce((s, q) => s + (q.segs ? q.segs.filter((g) => g.type === 'line').length : q.pts.length - (q.closed ? 0 : 1)), 0);
    const nan = res.paths.filter((q) => q.pts.some((pt) => !Number.isFinite(pt.x) || !Number.isFinite(pt.y))).length;
    console.log(`${f} [${v.label}] ${prep.w}x${prep.h} auto=${sug.mode} (cover ${sug.coverage.toFixed(3)}, stroke ${sug.strokePx.toFixed(1)}px) used=${mode}: ${res.paths.length} paths, ${res.pieces ?? '-'} pieces, ${res.holes ?? '-'} holes, ${verts} pts, ${arcs} arcs + ${lines} lines, ${res.paths.filter((q) => !q.closed).length} open, ${res.looseEnds?.length ?? "-"} loose ends, ${nan} NaN paths, ${ms} ms`);
    // overlay: faded crop + coloured cut lines, at working px
    const { w, h, crop, mmPerPx } = prep;
    const rgb = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = 0.6 + 0.4 * (crop[i * 4 + c] / 255);
    const plot = (x, y, col) => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xi = Math.round(x) + dx, yi = Math.round(y) + dy;
        if (xi >= 0 && yi >= 0 && xi < w && yi < h) rgb.set(col, (yi * w + xi) * 3);
      }
    };
    for (const q of res.paths) {
      const col = q.kind === 'hole' ? [0.05, 0.25, 0.9] : q.closed ? [0.85, 0.05, 0.05] : [0.0, 0.6, 0.1];
      const n0 = q.pts.length - (q.closed ? 0 : 1);
      for (let i = 0; i < n0; i++) {
        const a = q.pts[i], b = q.pts[(i + 1) % q.pts.length];
        if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
        const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / mmPerPx) + 1;
        for (let k = 0; k <= n; k++) plot((a.x + ((b.x - a.x) * k) / n) / mmPerPx, (a.y + ((b.y - a.y) * k) / n) / mmPerPx, col);
      }
    }
    for (const e of res.looseEnds || []) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) if (dx * dx + dy * dy <= 16) plot(e.x / mmPerPx + dx, e.y / mmPerPx + dy, [0.85, 0.1, 0.8]);
    writePNG({ w, h, data: rgb, rgb: true }, `${out}/${f.replace('.jpg', '')}-${v.label}.png`);
    if (process.env.INK) writePNG({ w, h, data: prep.ink.data.map((d) => 1 - d) }, `${out}/${f.replace('.jpg', '')}-${v.label}-ink.png`);
  }
}
