// The Segment Anything maths that does not depend on where it runs (browser worker or Node):
// turning a picture into the encoder's input, feeding the mask decoder a few clicks, and
// turning the decoder's small logits grid back into a full-size 0/1 mask.
//
// The model files are the Hugging Face "SamModel" export (SlimSAM): an image encoder that
// takes a 1024 x 1024 padded picture, and a mask decoder that takes the encoder's output plus
// click points and returns three candidate masks with a quality score each.

export const SIZE = 1024;                 // the encoder's square input
export const LOGITS = 256;                // the decoder's mask grid is 256 x 256 over that square
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// Weights for shrinking (or growing) a line of `inN` samples to `outN`, triangle filter,
// widened when shrinking so it averages instead of skipping pixels (what PIL's bilinear does).
function resizeWeights(inN, outN) {
  const scale = inN / outN;
  const fs = Math.max(scale, 1);
  const start = new Int32Array(outN), count = new Int32Array(outN);
  const taps = [];
  for (let i = 0; i < outN; i++) {
    const centre = (i + 0.5) * scale;
    const lo = Math.max(0, Math.floor(centre - fs + 0.5));
    const hi = Math.min(inN, Math.floor(centre + fs + 0.5));
    const w = [];
    let sum = 0;
    for (let x = lo; x < hi; x++) {
      const v = Math.max(0, 1 - Math.abs((x + 0.5 - centre) / fs));
      w.push(v);
      sum += v;
    }
    if (!(sum > 0)) { w.length = 0; w.push(1); sum = 1; start[i] = Math.min(inN - 1, Math.max(0, Math.floor(centre))); }
    else start[i] = lo;
    count[i] = w.length;
    for (const v of w) taps.push(v / sum);
  }
  return { start, count, taps: Float32Array.from(taps) };
}

// RGBA bytes -> {rw, rh, scale, tensor}: the picture shrunk so its long side is 1024, scaled
// to 0..1, normalised, laid out as planes (CHW) in the top-left of a 1024 x 1024 field.
// Transparent pixels count as white.
export function prepareImage(rgba, w, h) {
  const scale = SIZE / Math.max(w, h);
  const rw = Math.max(1, Math.min(SIZE, Math.round(w * scale)));
  const rh = Math.max(1, Math.min(SIZE, Math.round(h * scale)));
  const hx = resizeWeights(w, rw), vy = resizeWeights(h, rh);

  // Horizontal pass: h rows of rw pixels, three planes of floats (0..255).
  const mid = new Float32Array(3 * h * rw);
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    let t = 0;
    for (let ox = 0; ox < rw; ox++) {
      const s = hx.start[ox], n = hx.count[ox];
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < n; k++, t++) {
        const o = row + (s + k) * 4, wt = hx.taps[t], a = rgba[o + 3];
        if (a === 255) { r += rgba[o] * wt; g += rgba[o + 1] * wt; b += rgba[o + 2] * wt; }
        else { const f = a / 255, bg = 255 * (1 - f); r += (rgba[o] * f + bg) * wt; g += (rgba[o + 1] * f + bg) * wt; b += (rgba[o + 2] * f + bg) * wt; }
      }
      const m = y * rw + ox;
      mid[m] = r; mid[h * rw + m] = g; mid[2 * h * rw + m] = b;
    }
  }

  // Vertical pass straight into the normalised, padded tensor.
  const out = new Float32Array(3 * SIZE * SIZE);
  for (let c = 0; c < 3; c++) {
    const plane = c * h * rw, dst = c * SIZE * SIZE;
    const mean = MEAN[c] * 255, inv = 1 / (STD[c] * 255);
    let t = 0;
    for (let oy = 0; oy < rh; oy++) {
      const s = vy.start[oy], n = vy.count[oy];
      const d = dst + oy * SIZE;
      for (let ox = 0; ox < rw; ox++) {
        let v = 0, tt = t;
        for (let k = 0; k < n; k++, tt++) v += mid[plane + (s + k) * rw + ox] * vy.taps[tt];
        out[d + ox] = (v - mean) * inv;
      }
      t += n;
    }
  }
  return { rw, rh, scale, data: out };
}

// The encoder takes the prepared picture; what it returns is what every click then uses.
export async function encode(ort, session, prepared) {
  const input = new ort.Tensor('float32', prepared.data, [1, 3, SIZE, SIZE]);
  const out = await session.run({ [session.inputNames[0]]: input });
  return { embeddings: out.image_embeddings, positional: out.image_positional_embeddings };
}

// Click points in picture pixels -> the decoder's tensors. Positive clicks are label 1,
// negative clicks label 0.
export function pointTensors(ort, points, scale) {
  const n = points.length;
  const xy = new Float32Array(n * 2);
  const labels = new BigInt64Array(n);
  points.forEach((p, i) => {
    xy[i * 2] = p.x * scale;
    xy[i * 2 + 1] = p.y * scale;
    labels[i] = p.positive === false ? 0n : 1n;
  });
  return {
    input_points: new ort.Tensor('float32', xy, [1, 1, n, 2]),
    input_labels: new ort.Tensor('int64', labels, [1, 1, n]),
  };
}

// The decoder returns three candidate masks as logits (above 0 = object) and a score each.
export async function decode(ort, session, emb, points, scale) {
  const feeds = { ...pointTensors(ort, points, scale), image_embeddings: emb.embeddings, image_positional_embeddings: emb.positional };
  const out = await session.run(feeds);
  const dims = out.pred_masks.dims;                    // [1, 1, 3, 256, 256]
  const count = dims[dims.length - 3];
  return { logits: out.pred_masks.data, scores: Array.from(out.iou_scores.data).slice(0, count), count };
}

// One candidate's 256 x 256 logits -> a w x h mask of 0/1, sampled bilinearly. Picture
// pixel (x, y) sits at ((x + .5) * rw / w) in the resized picture and a quarter of that on
// the logits grid.
export function upsampleMask(logits, offset, rw, rh, w, h) {
  const L = LOGITS;
  const xi = new Int32Array(w), xf = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const g = Math.min(L - 1, Math.max(0, (x + 0.5) * rw / (4 * w) - 0.5));
    xi[x] = Math.min(L - 2, Math.floor(g)); xf[x] = g - xi[x];
  }
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const g = Math.min(L - 1, Math.max(0, (y + 0.5) * rh / (4 * h) - 0.5));
    const yi = Math.min(L - 2, Math.floor(g)), yf = g - yi;
    const r0 = offset + yi * L, r1 = r0 + L, o = y * w;
    for (let x = 0; x < w; x++) {
      const i = xi[x], f = xf[x];
      const a = logits[r0 + i] + (logits[r0 + i + 1] - logits[r0 + i]) * f;
      const b = logits[r1 + i] + (logits[r1 + i + 1] - logits[r1 + i]) * f;
      mask[o + x] = a + (b - a) * yf > 0 ? 1 : 0;
    }
  }
  return mask;
}

export function countOn(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  return n;
}

// Chooses which candidate to hand back, given each one's pixel count and score:
//   'object'  (default) the biggest candidate the model is reasonably sure of, so a click
//             lands on the whole panel or sheet rather than on a part of it
//   'score'   the candidate with the best score (often a part of the object)
//   'largest' the biggest candidate
//   0, 1, 2   a fixed candidate
export const OBJECT_MIN_SCORE = 0.5;
export function pick(areas, scores, how = 'object') {
  if (typeof how === 'number') return Math.max(0, Math.min(areas.length - 1, how | 0));
  const best = (ok, key) => {
    let at = -1;
    for (let i = 0; i < areas.length; i++) if (ok(i) && (at < 0 || key(i) > key(at))) at = i;
    return at;
  };
  if (how === 'largest') return best(() => true, (i) => areas[i]);
  if (how === 'object') {
    const at = best((i) => scores[i] >= OBJECT_MIN_SCORE && areas[i] > 0, (i) => areas[i]);
    if (at >= 0) return at;
  }
  return best(() => true, (i) => scores[i]);
}
