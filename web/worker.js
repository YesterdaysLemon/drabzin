// Processing runs here so the page stays responsive.
import { prepareInk, outline, centreline, suggestMode, run as runGeometric } from './core/pipeline.js';
import { invert, threshold, strokeWidth } from './core/raster.js';

let src = null;      // { rgba, w, h }
let prepCache = null; // { key, prep }

function prepFor(p) {
  const key = JSON.stringify([p.corners, p.maxSide, p.invert, p.blur, p.sizeMM, p.sizeAxis, p.pickDesign, p.pickBg, p.adaptive, p.useMask && p.maskKey]);
  if (prepCache?.key === key) return prepCache.prep;
  const prep = prepareInk(src.rgba, src.w, src.h, { ...p, mask: p.useMask ? src.mask : null });
  prepCache = { key, prep };
  return prep;
}

// Small greyscale preview of the material mask for the "Cleaned" view.
function maskPreview(prep, level) {
  const { ink } = prep;
  const s = Math.min(1, 900 / Math.max(ink.w, ink.h));
  const w = Math.max(1, Math.round(ink.w * s)), h = Math.max(1, Math.round(ink.h * s));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = ink.data[Math.min(ink.h - 1, Math.floor(y / s)) * ink.w + Math.min(ink.w - 1, Math.floor(x / s))];
      const o = (y * w + x) * 4, on = v >= level;
      out[o] = out[o + 1] = out[o + 2] = on ? 40 : 245;
      out[o + 3] = 255;
    }
  return { w, h, data: out };
}

// Downscaled copy of the straightened crop, for the overlay view.
function cropPreview(prep) {
  const s = Math.min(1, 1400 / Math.max(prep.w, prep.h));
  const w = Math.max(1, Math.round(prep.w * s)), h = Math.max(1, Math.round(prep.h * s));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (Math.min(prep.h - 1, Math.floor(y / s)) * prep.w + Math.min(prep.w - 1, Math.floor(x / s))) * 4;
      out.set(prep.crop.subarray(i, i + 4), (y * w + x) * 4);
    }
  return { w, h, data: out };
}

function geometric(prep, p) {
  // The geometric engine expects dark straps on a light ground. Straps are whichever
  // side forms the thinner network (unless the user swapped it).
  const thinA = strokeWidth(threshold(prep.ink, { level: p.level, lightLines: true }));
  const thinB = strokeWidth(threshold(prep.ink, { level: p.level, lightLines: false }));
  const inkIsStrap = p.invert ? true : thinA <= thinB;
  const gray = inkIsStrap ? invert(prep.ink) : prep.ink;
  const W = prep.w * prep.mmPerPx, H = prep.h * prep.mmPerPx;
  const out = runGeometric(gray, {
    panelW: W, panelH: H, corners: null, workSize: Math.min(1400, Math.max(prep.w, prep.h)),
    lightLines: false, flatten: false, blur: 0.6,
    nx: p.nx, ny: p.ny, order: p.order, mirror: p.mirror,
    snapDeg: p.snapDeg, bandWidth: p.bandWidthMM, frame: p.frameMM, pad: 0,
    toolDiameter: 0, minBridge: 0,
  });
  const r = out.result;
  const paths = [{ pts: r.outline, closed: true, layer: 'CUT', kind: 'outer' }]
    .concat(r.holes.map((h) => ({ pts: h, closed: true, layer: 'CUT', kind: 'hole' })));
  return {
    paths, widthMM: W, heightMM: H, pieces: 1 + r.flags.islands.length, holes: r.holes.length,
    bandWidthMM: r.bandWidth, snapDeg: out.vec.snapDeg,
    centrelines: r.centrelines.map((s) => ({ pts: [s.a, s.b], closed: false, layer: 'CENTRELINE' })),
    warnings: r.warnings,
  };
}

self.onmessage = (e) => {
  const { id, cmd } = e.data;
  try {
    if (cmd === 'load') {
      src = { rgba: new Uint8ClampedArray(e.data.buffer), w: e.data.w, h: e.data.h };
      prepCache = null;
      self.postMessage({ id, ok: true });
      return;
    }
    if (cmd === 'mask') {   // the selected object (click to select), or null
      if (src) src.mask = e.data.mask;
      prepCache = null;
      self.postMessage({ id, ok: true });
      return;
    }
    if (cmd === 'process') {
      const p = e.data.params;
      const t0 = performance.now();
      const prep = prepFor(p);
      const suggestion = suggestMode(prep, p);
      const mode = p.mode === 'auto' ? suggestion.mode : p.mode;
      let res;
      if (mode === 'centreline') res = centreline(prep, p);
      else if (mode === 'geometric') res = geometric(prep, p);
      else res = outline(prep, p);
      const preview = maskPreview(prep, p.level);
      const crop = cropPreview(prep);
      self.postMessage({
        id, ok: true, mode, suggestion: suggestion.mode, ms: Math.round(performance.now() - t0),
        result: res, preview, crop, cropW: prep.w, cropH: prep.h, colors: prep.colors,
      }, [preview.data.buffer, crop.data.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.stack || err) });
  }
};
