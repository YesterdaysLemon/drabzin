// Tests for the click-to-select helpers: the mask -> box and mask -> four-corners geometry
// (web/segment/geometry.js) and the model-side maths that needs no model (web/segment/sam.js).
// Run: node --test test/segment-geometry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskBox, maskToQuad, fitQuad, cleanMask, convexHull, polygonArea, polygonToQuad, minAreaRect, orderCorners } from '../web/segment/geometry.js';
import * as sam from '../web/segment/sam.js';

const W = 480, H = 360;

// A mask with the polygon (list of [x, y]) filled in.
function polygonMask(poly, w = W, h = H) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let inside = false;
      const px = x + 0.5, py = y + 0.5;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) m[y * w + x] = 1;
    }
  }
  return m;
}
const disc = (cx, cy, r, w = W, h = H) => {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) m[y * w + x] = 1;
  return m;
};
const fill = (m, x0, y0, x1, y1, v = 1, w = W) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = v; return m; };
const near = (p, q, tol) => Math.hypot(p.x - q[0], p.y - q[1]) <= tol;
function assertCorners(got, want, tol) {
  assert.equal(got.length, 4);
  want.forEach((q, i) => assert.ok(near(got[i], q, tol), `corner ${i}: got (${got[i].x.toFixed(1)}, ${got[i].y.toFixed(1)}), wanted (${q})`));
}

test('a panel photographed at an angle: the four corners come back clockwise from the top-left', () => {
  const quad = [[70, 40], [400, 70], [430, 320], [40, 290]];
  const got = maskToQuad(polygonMask(quad), W, H);
  assertCorners(got, quad, 2);
});

test('a rotated rectangle is found whatever order its edges come in', () => {
  const a = (30 * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const rect = [[-150, -80], [150, -80], [150, 80], [-150, 80]].map(([x, y]) => [240 + x * c - y * s, 180 + x * s + y * c]);
  const got = maskToQuad(polygonMask(rect), W, H);
  // The corner nearest the picture's top-left is first, then clockwise.
  const sorted = orderCorners(rect);
  assertCorners(got, sorted.map((p) => [p.x, p.y]), 2);
});

test('ragged edges, a hole and stray specks do not move the corners', () => {
  const quad = [[60, 50], [420, 60], [410, 310], [50, 300]];
  const m = polygonMask(quad);
  // Notches bitten out of the edges, as a real mask has.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 30; i++) {
    const x = 90 + Math.floor(rnd() * 300), top = Math.round(50 + (10 * (x - 60)) / 360);   // the top edge here
    fill(m, x, top, x + 4 + Math.floor(rnd() * 3), top + 2 + Math.floor(rnd() * 3), 0);
  }
  fill(m, 200, 150, 280, 220, 0);              // a hole in the middle (a cut-out in the panel)
  fill(m, 5, 5, 12, 12, 1);                    // a speck far from the object
  fill(m, 460, 340, 470, 350, 1);
  const got = maskToQuad(m, W, H);
  assertCorners(got, quad, 8);
});

test('a round object gets a plain upright box, not an arbitrary tilt', () => {
  const m = disc(240, 180, 110);
  const fit = fitQuad(m, W, H);
  assert.equal(fit.kind, 'box');
  assertCorners(fit.corners, [[130, 70], [350, 70], [350, 290], [130, 290]], 2);
  assert.ok(fit.fit > 0.7 && fit.fit < 0.85, `fit ${fit.fit}`);
});

test('the corners stay inside the picture', () => {
  // A sheet whose corner runs off the top-left of the picture.
  const m = polygonMask([[-60, -40], [300, 20], [310, 300], [-30, 280]]);
  for (const p of maskToQuad(m, W, H)) assert.ok(p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H, `(${p.x}, ${p.y})`);
});

test('a mask that covers the whole picture has the picture\'s corners', () => {
  const got = maskToQuad(new Uint8Array(W * H).fill(1), W, H);
  assertCorners(got, [[0, 0], [W, 0], [W, H], [0, H]], 0.01);
});

test('empty and tiny masks give null', () => {
  assert.equal(maskToQuad(new Uint8Array(W * H), W, H), null);
  assert.equal(maskBox(new Uint8Array(W * H), W, H), null);
  assert.equal(maskToQuad(fill(new Uint8Array(W * H), 10, 10, 12, 12), W, H), null);
});

test('maskBox is exact, and ignores stray specks unless told not to', () => {
  const m = fill(new Uint8Array(W * H), 100, 50, 300, 250);
  assert.deepEqual(maskBox(m, W, H), { x: 100, y: 50, w: 200, h: 200 });
  fill(m, 450, 20, 454, 24);
  assert.deepEqual(maskBox(m, W, H), { x: 100, y: 50, w: 200, h: 200 });
  assert.deepEqual(maskBox(m, W, H, { clean: false }), { x: 100, y: 20, w: 354, h: 230 });
});

test('cleanMask drops small blobs but keeps both halves of an object split in two', () => {
  const m = new Uint8Array(W * H);
  fill(m, 40, 40, 200, 300);                   // one half
  fill(m, 260, 40, 420, 300);                  // the other half, a gap between
  fill(m, 230, 330, 238, 338);                 // a speck
  const { mask } = cleanMask(m, W, H);
  assert.equal(mask[335 * W + 234], 0);
  assert.equal(mask[100 * W + 100], 1);
  assert.equal(mask[100 * W + 300], 1);
});

test('convex hull and area', () => {
  const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [5, 2], [3, 8]]);
  assert.equal(hull.length, 4);
  assert.equal(Math.abs(polygonArea(hull)), 100);
});

test('polygonToQuad shrinks a many-sided shape to the four sides it is mostly made of', () => {
  // A rectangle with its corners chamfered.
  const poly = convexHull([[10, 0], [90, 0], [100, 10], [100, 50], [90, 60], [10, 60], [0, 50], [0, 10]]);
  const quad = polygonToQuad(poly);
  assert.equal(quad.length, 4);
  const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
  assert.ok(Math.min(...xs) >= -0.001 && Math.max(...xs) <= 100.001 + 40 && Math.max(...ys) <= 60.001 + 40);
  // It contains the original (every vertex is inside or on it).
  const area = Math.abs(polygonArea(quad));
  assert.ok(area >= Math.abs(polygonArea(poly)) - 1e-6);
});

test('minAreaRect prefers the upright box when a tilt gains almost nothing', () => {
  const circle = Array.from({ length: 72 }, (_, i) => [50 + 40 * Math.cos((i / 72) * 2 * Math.PI), 50 + 40 * Math.sin((i / 72) * 2 * Math.PI)]);
  const r = minAreaRect(convexHull(circle));
  const xs = r.map((p) => p[0]), ys = r.map((p) => p[1]);
  assert.equal(new Set(xs.map((v) => v.toFixed(3))).size, 2);
  assert.equal(new Set(ys.map((v) => v.toFixed(3))).size, 2);
});

test('orderCorners starts at the corner nearest the top-left and goes clockwise', () => {
  const got = orderCorners([[400, 300], [20, 280], [30, 20], [380, 40]]);
  assert.deepEqual(got.map((p) => [p.x, p.y]), [[30, 20], [380, 40], [400, 300], [20, 280]]);
});

test('big pictures are handled quickly', () => {
  const w = 4000, h = 3000;
  const m = new Uint8Array(w * h);
  for (let y = 400; y < 2600; y++) m.fill(1, y * w + 500, y * w + 3500);
  const t = performance.now();
  const q = maskToQuad(m, w, h);
  const ms = performance.now() - t;
  assertCorners(q, [[500, 400], [3500, 400], [3500, 2600], [500, 2600]], 1.5);
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms for 12 megapixels`);
});

// ---- the model-side maths ----

test('prepareImage: long side 1024, normalised, padded with zeros bottom and right', () => {
  const w = 40, h = 20;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([124, 116, 104, 255], i * 4);     // about the ImageNet mean
  const p = sam.prepareImage(rgba, w, h);
  assert.equal(p.rw, 1024);
  assert.equal(p.rh, 512);
  assert.equal(p.scale, 1024 / 40);
  assert.equal(p.data.length, 3 * 1024 * 1024);
  const at = (c, x, y) => p.data[c * 1024 * 1024 + y * 1024 + x];
  assert.ok(Math.abs(at(0, 500, 200) - (124 / 255 - 0.485) / 0.229) < 1e-3);
  assert.ok(Math.abs(at(2, 10, 10) - (104 / 255 - 0.406) / 0.225) < 1e-3);
  assert.equal(at(0, 500, 600), 0);          // padding
  assert.ok(Math.abs(at(1, 1023, 511) - (116 / 255 - 0.456) / 0.224) < 0.05);   // last picture pixel is still the picture
});

test('prepareImage: transparent pixels count as white', () => {
  const rgba = new Uint8ClampedArray(4 * 4 * 4);                              // all transparent black
  const p = sam.prepareImage(rgba, 4, 4);
  assert.ok(Math.abs(p.data[100 * 1024 + 100] - (1 - 0.485) / 0.229) < 1e-3);
});

test('upsampleMask: a constant logits grid gives an all-on or all-off mask of the picture size', () => {
  const on = new Float32Array(256 * 256).fill(2), off = new Float32Array(256 * 256).fill(-2);
  const m = sam.upsampleMask(on, 0, 1024, 512, 40, 20);
  assert.equal(m.length, 40 * 20);
  assert.equal(sam.countOn(m), 800);
  assert.equal(sam.countOn(sam.upsampleMask(off, 0, 1024, 512, 40, 20)), 0);
});

test('upsampleMask: the edge lands where the logits cross zero', () => {
  // Left half of the 256 grid on, right half off: in a 512 x 256 picture (scale 2, rw 1024)
  // the edge is at x = 256 in the picture.
  const g = new Float32Array(256 * 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) g[y * 256 + x] = x < 128 ? 1 : -1;
  const m = sam.upsampleMask(g, 0, 1024, 512, 512, 256);
  let edge = 0;
  while (m[100 * 512 + edge]) edge++;
  assert.ok(Math.abs(edge - 256) <= 2, `edge at ${edge}`);
});

test('pick: the object (default), the best score, the largest, or a fixed one', () => {
  const areas = [9000, 400, 80], scores = [0.62, 0.8, 0.93];
  assert.equal(sam.pick(areas, scores), 0);                  // the biggest one the model trusts
  assert.equal(sam.pick(areas, scores, 'score'), 2);
  assert.equal(sam.pick(areas, scores, 'largest'), 0);
  assert.equal(sam.pick(areas, scores, 1), 1);
  assert.equal(sam.pick(areas, scores, 9), 2);
  // A big candidate the model is unsure of is not the object.
  assert.equal(sam.pick([9000, 400, 80], [0.3, 0.8, 0.93]), 1);
  // When nothing is trusted, fall back to the best score.
  assert.equal(sam.pick([9000, 400, 80], [0.3, 0.2, 0.1]), 0);
});

test('pointTensors: positive clicks are 1, negative 0, scaled into the 1024 frame', () => {
  const made = [];
  const ort = { Tensor: class { constructor(type, data, dims) { made.push({ type, data, dims }); } } };
  sam.pointTensors(ort, [{ x: 100, y: 50, positive: true }, { x: 10, y: 20, positive: false }, { x: 1, y: 2 }], 2);
  assert.deepEqual(Array.from(made[0].data), [200, 100, 20, 40, 2, 4]);
  assert.deepEqual(made[0].dims, [1, 1, 3, 2]);
  assert.deepEqual(Array.from(made[1].data), [1n, 0n, 1n]);
  assert.deepEqual(made[1].dims, [1, 1, 3]);
});
