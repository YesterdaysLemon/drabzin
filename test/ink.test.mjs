// Colour -> design: picked colours and uneven light.
// (The design field is 1 for design: threshold it with lightLines, as the centreline mode does.)
//   node --test test/ink.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { inkFromRGBA, evenLight, sampleColor, threshold, quadToCrop, squareToQuad, applyH } from '../src/core/raster.js';

// A design on a background: bars and a ring, so there is detail everywhere across the image.
function scene(w, h, { paper, ink, light = () => 1 }) {
  const rgba = new Uint8ClampedArray(w * h * 4), truth = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ring = Math.abs(Math.hypot(x - w / 2, y - h / 2) - h / 3) < 6;
    const bar = (x % 40) < 8 && y > 20 && y < h - 20;
    const on = ring || bar;
    truth[y * w + x] = on ? 1 : 0;
    const c = on ? ink : paper, k = light(x, y);
    rgba.set([c[0] * k, c[1] * k, c[2] * k, 255], (y * w + x) * 4);
  }
  return { rgba, truth };
}

function score(mask, truth) {
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < truth.length; i++) {
    if (mask[i] && truth[i]) tp++; else if (mask[i]) fp++; else if (truth[i]) fn++;
  }
  return { recall: tp / (tp + fn), precision: tp / (tp + fp) };
}

test('picked colours: a mid grey splits paper from ink at 0.5', () => {
  const w = 40, h = 4, rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const v = 255 - Math.round((255 * (i % w)) / (w - 1)); rgba.set([v, v, v, 255], i * 4); }
  const f = inkFromRGBA(rgba, w, h, { bg: [255, 255, 255], design: [0, 0, 0] });
  assert.ok(f.data[0] < 0.02, 'paper reads 0');
  assert.ok(f.data[w - 1] > 0.98, 'ink reads 1');
  for (let x = 1; x < w; x++) assert.ok(f.data[x] >= f.data[x - 1] - 1e-6, 'monotonic from paper to ink');
});

test('picked colours: a dark frame around the crop no longer turns the design inside out', () => {
  const w = 120, h = 120;
  const { rgba, truth } = scene(w, h, { paper: [235, 235, 232], ink: [40, 40, 40] });
  // Paint a dark frame around the edge: the border median is now "ink", so the automatic
  // choice calls the paper the design. Picking says otherwise.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < 6 || y < 6 || x >= w - 6 || y >= h - 6) { rgba.set([40, 40, 40, 255], (y * w + x) * 4); truth[y * w + x] = 1; }
  const auto = threshold(inkFromRGBA(rgba, w, h), { level: 0.5, lightLines: true });
  const picked = threshold(inkFromRGBA(rgba, w, h, { bg: [235, 235, 232], design: [40, 40, 40] }), { level: 0.5, lightLines: true });
  assert.ok(score(auto.data, truth).precision < 0.5, 'the automatic guess is inside out');
  const s = score(picked.data, truth);
  assert.ok(s.recall > 0.99 && s.precision > 0.99, JSON.stringify(s));
});

const evenInk = (rgba, w, h, opts = {}) => { const e = evenLight(rgba, w, h, opts); return inkFromRGBA(e.rgba, w, h, { bg: opts.bg ?? e.bg, design: opts.design }); };
const count = (m) => { let n = 0; for (const v of m) n += v ? 1 : 0; return n; };

test('uneven light: a shadow across the page no longer reads as design', () => {
  const w = 400, h = 200;
  // Light falls from 1.0 at the left to 0.3 at the right: the shaded paper is darker than the lit ink.
  const { rgba, truth } = scene(w, h, { paper: [240, 236, 228], ink: [70, 60, 55], light: (x) => 1 - 0.7 * (x / w) });
  const flat = score(threshold(inkFromRGBA(rgba, w, h), { level: 0.4, lightLines: true }).data, truth);
  const even = score(threshold(evenInk(rgba, w, h), { level: 0.4, lightLines: true }).data, truth);
  assert.ok(flat.precision < 0.6, `without it the shade is design: ${JSON.stringify(flat)}`);
  assert.ok(even.recall > 0.97 && even.precision > 0.95, JSON.stringify(even));
});

test('uneven light with picked colours: a lamp in one corner', () => {
  const w = 300, h = 300;
  const light = (x, y) => 0.35 + 0.65 * Math.exp(-((x * x + y * y) / (2 * 260 * 260)));
  const { rgba, truth } = scene(w, h, { paper: [245, 240, 230], ink: [30, 30, 35], light });
  // Picked where the light is: the background near the lamp, the design in the shade.
  const bg = sampleColor(rgba, w, h, 4, 4, 2), design = sampleColor(rgba, w, h, 283, 150, 1);
  const s = score(threshold(evenInk(rgba, w, h, { bg, design }), { level: 0.5, lightLines: true }).data, truth);
  assert.ok(s.recall > 0.95 && s.precision > 0.95, JSON.stringify(s));
});

test('uneven light keeps plain areas plain and big shapes solid', () => {
  // A blank margin with paper grain around one big solid shape (a third of the width).
  const w = 300, h = 300, rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 100; y < 200; y++) for (let x = 100; x < 200; x++) rgba.set([20, 20, 20, 255], (y * w + x) * 4);
  for (let i = 0; i < w * h; i++) { const n = (i * 7919) % 9; rgba[i * 4] -= n; rgba[i * 4 + 1] -= n; rgba[i * 4 + 2] -= n; }   // paper grain
  const on = count(threshold(evenInk(rgba, w, h), { level: 0.4, lightLines: true }).data);
  assert.ok(Math.abs(on - 10000) < 300, `only the square is design (${on} px)`);
});

test('quadToCrop undoes the perspective warp', () => {
  const q = [{ x: 150, y: 168 }, { x: 1693, y: 186 }, { x: 1745, y: 1688 }, { x: 193, y: 1770 }];
  const H = squareToQuad(q);
  for (const [u, v] of [[0, 0], [1, 1], [0.3, 0.7], [0.9, 0.2], [1.4, -0.2]]) {
    const c = quadToCrop(q, applyH(H, u, v), 1000, 500);
    assert.ok(Math.abs(c.x - u * 1000) < 1e-6 && Math.abs(c.y - v * 500) < 1e-6, `${u},${v} -> ${c.x},${c.y}`);
  }
});

test('sampleColor takes the median of a small square', () => {
  const w = 9, h = 9, rgba = new Uint8ClampedArray(w * h * 4).fill(200);
  rgba.set([0, 0, 0, 255], (4 * w + 4) * 4);   // one dead pixel at the centre
  assert.deepEqual(sampleColor(rgba, w, h, 4, 4, 2), [200, 200, 200]);
});
