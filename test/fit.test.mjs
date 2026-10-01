// Tests for the line-and-arc fitter (src/core/fit.js) and its DXF / SVG output.
// Run with: node --test test/fit.test.mjs   (npm test runs it too)
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPath, sampleSegs, segsLength, arcBulge } from '../src/core/fit.js';
import { pathsToDXF, pathsToSVG } from '../src/core/export.js';

const TOL = 0.1;
const EPS = 1e-6; // slack for floating point when comparing with a limit

// --- helpers ------------------------------------------------------------------------------

// Small deterministic random numbers in [-1, 1).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

const lines = (segs) => segs.filter((s) => s.type === 'line');
const arcs = (segs) => segs.filter((s) => s.type === 'arc');

// Distance from p to one segment, worked out from the definitions (not from fit.js).
function distToSeg(p, s) {
  if (s.type === 'line') {
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / L2)) : 0;
    return Math.hypot(p.x - s.a.x - t * dx, p.y - s.a.y - t * dy);
  }
  const a0 = Math.atan2(s.a.y - s.c.y, s.a.x - s.c.x);
  const ap = Math.atan2(p.y - s.c.y, p.x - s.c.x);
  let rel = (ap - a0) * Math.sign(s.sweep);
  rel = ((rel % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (rel <= Math.abs(s.sweep)) return Math.abs(Math.hypot(p.x - s.c.x, p.y - s.c.y) - s.r);
  return Math.min(Math.hypot(p.x - s.a.x, p.y - s.a.y), Math.hypot(p.x - s.b.x, p.y - s.b.y));
}

// Worst distance of any input point from the output.
function maxDev(pts, segs) {
  let worst = 0;
  for (const p of pts) {
    let best = Infinity;
    for (const s of segs) best = Math.min(best, distToSeg(p, s));
    worst = Math.max(worst, best);
  }
  return worst;
}

// The other way round: how far the output wanders from the input polyline.
function outputDev(segs, pts, closed) {
  const edges = [];
  for (let i = 0; i + 1 < pts.length; i++) edges.push({ type: 'line', a: pts[i], b: pts[i + 1] });
  if (closed) edges.push({ type: 'line', a: pts[pts.length - 1], b: pts[0] });
  let worst = 0;
  for (const p of sampleSegs(segs, 0.005, closed)) {
    let best = Infinity;
    for (const e of edges) best = Math.min(best, distToSeg(p, e));
    worst = Math.max(worst, best);
  }
  return worst;
}

// What every result must satisfy: finite numbers, no gaps (the very same numbers), closed when
// asked, and arcs whose centre, radius and sweep agree with their end points.
function assertValid(segs, closed = true) {
  assert.ok(Array.isArray(segs));
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    for (const v of [s.a.x, s.a.y, s.b.x, s.b.y]) assert.ok(Number.isFinite(v), `non-finite number in segment ${i}`);
    if (i) {
      assert.equal(s.a.x, segs[i - 1].b.x, `gap before segment ${i}`);
      assert.equal(s.a.y, segs[i - 1].b.y, `gap before segment ${i}`);
    }
    if (s.type === 'arc') {
      for (const v of [s.c.x, s.c.y, s.r, s.sweep]) assert.ok(Number.isFinite(v), `non-finite arc number in segment ${i}`);
      assert.ok(s.r > 0);
      assert.ok(Math.abs(s.sweep) < 2 * Math.PI);
      assert.ok(Math.abs(Math.hypot(s.a.x - s.c.x, s.a.y - s.c.y) - s.r) < 1e-6 * (1 + s.r), 'start is off the circle');
      assert.ok(Math.abs(Math.hypot(s.b.x - s.c.x, s.b.y - s.c.y) - s.r) < 1e-6 * (1 + s.r), 'end is off the circle');
      const da = Math.atan2(s.a.y - s.c.y, s.a.x - s.c.x), db = Math.atan2(s.b.y - s.c.y, s.b.x - s.c.x);
      let d = db - da - s.sweep;
      d = Math.abs((((d % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      assert.ok(d < 1e-6, 'sweep does not take a to b');
    } else assert.equal(s.type, 'line');
  }
  if (closed && segs.length) {
    assert.equal(segs[0].a.x, segs[segs.length - 1].b.x, 'closed path does not close');
    assert.equal(segs[0].a.y, segs[segs.length - 1].b.y, 'closed path does not close');
  }
}

function noisyCircle(n, r, noise, seed = 1) {
  const rnd = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return { x: 100 + r * Math.cos(a) + rnd() * noise, y: 80 + r * Math.sin(a) + rnd() * noise };
  });
}

// A rectangle with rounded corners, sampled every `step` mm, going round once.
function roundRect(w, h, r, step = 0.5) {
  const out = [];
  const line = (x0, y0, x1, y1) => {
    const k = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step);
    for (let i = 0; i < k; i++) out.push({ x: x0 + ((x1 - x0) * i) / k, y: y0 + ((y1 - y0) * i) / k });
  };
  const corner = (cx, cy, a0) => {
    const k = Math.ceil((r * Math.PI) / 2 / step);
    for (let i = 0; i < k; i++) out.push({ x: cx + r * Math.cos(a0 + ((Math.PI / 2) * i) / k), y: cy + r * Math.sin(a0 + ((Math.PI / 2) * i) / k) });
  };
  line(r, 0, w - r, 0); corner(w - r, r, -Math.PI / 2);
  line(w, r, w, h - r); corner(w - r, h - r, 0);
  line(w - r, h, r, h); corner(r, h - r, Math.PI / 2);
  line(0, h - r, 0, r); corner(r, r, Math.PI);
  return out;
}

// Two arcs of radius 30 bending opposite ways, joined smoothly: an S.
function sCurve() {
  const R = 30, pts = [];
  const c1 = { x: 0, y: R };
  for (let i = 0; i <= 100; i++) {
    const a = -Math.PI / 2 + i / 100;
    pts.push({ x: c1.x + R * Math.cos(a), y: c1.y + R * Math.sin(a) });
  }
  const E = pts[pts.length - 1], c2 = { x: 2 * E.x - c1.x, y: 2 * E.y - c1.y };
  const a2 = Math.atan2(E.y - c2.y, E.x - c2.x);
  for (let i = 1; i <= 100; i++) {
    const a = a2 - i / 100;
    pts.push({ x: c2.x + R * Math.cos(a), y: c2.y + R * Math.sin(a) });
  }
  return pts;
}

// A star of `n` points (2n corners), each edge sampled densely with a little noise.
function star(n, outer, inner, noise, seed = 7) {
  const rnd = rng(seed), V = [];
  for (let i = 0; i < 2 * n; i++) {
    const r = i % 2 ? inner : outer, a = (i / (2 * n)) * 2 * Math.PI;
    V.push({ x: 100 + r * Math.cos(a), y: 100 + r * Math.sin(a) });
  }
  const pts = [], corners = [];
  for (let i = 0; i < V.length; i++) {
    const A = V[i], B = V[(i + 1) % V.length];
    corners.push(pts.length);
    for (let k = 0; k < 40; k++) pts.push({ x: A.x + ((B.x - A.x) * k) / 40 + rnd() * noise, y: A.y + ((B.y - A.y) * k) / 40 + rnd() * noise });
  }
  return { pts, corners };
}

// --- the fitter ---------------------------------------------------------------------------

test('a noisy circle of 400 points becomes a few arcs of the right size', () => {
  const R = 50, pts = noisyCircle(400, R, 0.04);
  const segs = fitPath(pts, { tol: TOL });
  assertValid(segs);
  console.log(`  circle: ${segs.length} segs (${arcs(segs).length} arcs), max dev ${maxDev(pts, segs).toFixed(3)} mm`);
  assert.equal(lines(segs).length, 0);
  assert.ok(arcs(segs).length <= 4, `${arcs(segs).length} arcs`);
  assert.ok(maxDev(pts, segs) <= TOL + EPS, `max deviation ${maxDev(pts, segs)}`);
  const length = segsLength(segs);
  assert.ok(Math.abs(length - 2 * Math.PI * R) / (2 * Math.PI * R) < 0.005, `length ${length}`);
  for (const a of arcs(segs)) {
    assert.ok(Math.abs(a.r - R) < 0.2, `radius ${a.r}`);
    assert.ok(Math.hypot(a.c.x - 100, a.c.y - 80) < 0.2, 'centre');
  }
  // All the sweeps go the same way and add up to one turn.
  const total = arcs(segs).reduce((s, a) => s + a.sweep, 0);
  assert.ok(Math.abs(Math.abs(total) - 2 * Math.PI) < 0.02, `total sweep ${total}`);
  assert.ok(outputDev(segs, pts, true) <= TOL + 0.01);
});

test('a rectangle is exactly four lines, with or without its corners marked', () => {
  const pts = [], corners = [];
  const edge = (a, b, k) => {
    corners.push(pts.length);
    for (let i = 0; i < k; i++) pts.push({ x: a[0] + ((b[0] - a[0]) * i) / k, y: a[1] + ((b[1] - a[1]) * i) / k });
  };
  edge([10, 10], [110, 10], 200); edge([110, 10], [110, 70], 120); edge([110, 70], [10, 70], 200); edge([10, 70], [10, 10], 120);
  for (const c of [corners, null]) {
    const segs = fitPath(pts, { tol: TOL, corners: c });
    assertValid(segs);
    assert.equal(segs.length, 4);
    assert.equal(lines(segs).length, 4);
    assert.ok(Math.abs(segsLength(segs) - 320) < 1e-9);
    assert.ok(maxDev(pts, segs) <= TOL + EPS);
  }
});

test('a rounded rectangle is four lines and four arcs, and no line cuts a corner', () => {
  for (const step of [0.5, 2]) {
    const pts = roundRect(100, 60, 10, step);
    const segs = fitPath(pts, { tol: TOL });
    assertValid(segs);
    console.log(`  rounded rectangle (${pts.length} pts): ${lines(segs).length} lines, ${arcs(segs).length} arcs`);
    assert.equal(lines(segs).length, 4);
    assert.equal(arcs(segs).length, 4);
    for (const a of arcs(segs)) {
      assert.ok(Math.abs(a.r - 10) < 0.25, `radius ${a.r}`);
      assert.ok(Math.abs(a.sweep - Math.PI / 2) < 0.15, `sweep ${a.sweep}`);
    }
    assert.ok(Math.abs(segsLength(segs) - (2 * 80 + 2 * 40 + 2 * Math.PI * 10)) < 0.5);
    assert.ok(maxDev(pts, segs) <= TOL + EPS);
    // A line that cut through a curved corner would stray from the outline.
    assert.ok(outputDev(segs, pts, true) <= TOL + 0.01, `output strays ${outputDev(segs, pts, true)}`);
    // Lines and arcs alternate round the shape.
    for (let i = 0; i < segs.length; i++) assert.notEqual(segs[i].type, segs[(i + 1) % segs.length].type);
  }
});

test('an S bend (two opposite arcs, open path) is two arcs that turn opposite ways', () => {
  const pts = sCurve();
  const segs = fitPath(pts, { closed: false, tol: TOL });
  assertValid(segs, false);
  console.log(`  S curve: ${segs.map((s) => s.type + (s.sweep ? ' ' + s.sweep.toFixed(2) : '')).join(', ')}`);
  assert.equal(lines(segs).length, 0);
  assert.equal(arcs(segs).length, 2);
  assert.ok(segs[0].sweep * segs[1].sweep < 0, 'sweeps should have opposite signs');
  assert.ok(segs[0].sweep > 0 && segs[1].sweep < 0, 'first bends one way, then the other');
  for (const a of segs) assert.ok(Math.abs(a.r - 30) < 0.1 && Math.abs(Math.abs(a.sweep) - 1) < 0.05);
  // An open path keeps its two ends.
  assert.deepEqual(segs[0].a, pts[0]);
  assert.deepEqual(segs[segs.length - 1].b, pts[pts.length - 1]);
  assert.ok(maxDev(pts, segs) <= TOL + EPS);
});

test('a 12-point star with noise is 24 lines and nothing else', () => {
  const { pts, corners } = star(12, 50, 25, 0.03);
  const segs = fitPath(pts, { tol: TOL, corners });
  assertValid(segs);
  assert.equal(segs.length, 24);
  assert.equal(lines(segs).length, 24);
  assert.ok(maxDev(pts, segs) <= TOL + EPS, `max deviation ${maxDev(pts, segs)}`);
  // Every marked corner is where two segments meet.
  for (let i = 0; i < corners.length; i++) {
    assert.deepEqual(segs[i].a, pts[corners[i]]);
  }
  // Without the corners marked the stars still come out as lines.
  const free = fitPath(pts, { tol: TOL });
  assertValid(free);
  assert.equal(lines(free).length, 24);
  assert.equal(arcs(free).length, 0);
});

test('an arc never crosses a marked corner', () => {
  // A lens: two circular arcs meeting at sharp points (the tips are marked).
  const R = 40, d = Math.sqrt(R * R - 25 * 25), pts = [];
  for (let i = 0; i < 100; i++) { const t = Math.atan2(-d, -25) + (i / 100) * (Math.atan2(-d, 25) - Math.atan2(-d, -25)); pts.push({ x: 100 + R * Math.cos(t), y: 100 + d + R * Math.sin(t) }); }
  for (let i = 0; i < 100; i++) { const t = Math.atan2(d, 25) + (i / 100) * (Math.atan2(d, -25) - Math.atan2(d, 25)); pts.push({ x: 100 + R * Math.cos(t), y: 100 - d + R * Math.sin(t) }); }
  const lens = fitPath(pts, { tol: TOL, corners: [0, 100] });
  assertValid(lens);
  assert.equal(lens.length, 2);
  assert.equal(arcs(lens).length, 2);
  assert.deepEqual([lens[0].a, lens[1].a], [pts[0], pts[100]]);
  // Even in the middle of a smooth circle, a marked corner is where one arc ends and the next begins.
  const circle = noisyCircle(400, 50, 0.02);
  for (const corners of [[0, 200], [30, 130, 250, 390], [5]]) {
    const segs = fitPath(circle, { tol: TOL, corners });
    assertValid(segs);
    for (const c of corners) assert.ok(segs.some((g) => g.a.x === circle[c].x && g.a.y === circle[c].y), 'corner ' + c + ' is where a segment starts');
    assert.ok(segs.length >= corners.length);
    assert.ok(maxDev(circle, segs) <= TOL + EPS);
  }
});

test('"straight edges" gives lines only, still within tolerance', () => {
  const pts = noisyCircle(400, 50, 0.04);
  const segs = fitPath(pts, { tol: TOL, straight: true });
  assertValid(segs);
  console.log(`  straight circle: ${segs.length} lines, max dev ${maxDev(pts, segs).toFixed(3)} mm`);
  assert.equal(arcs(segs).length, 0);
  assert.ok(segs.length > 8);
  assert.ok(maxDev(pts, segs) <= TOL + EPS);
  const rr = fitPath(roundRect(100, 60, 10), { tol: TOL, straight: true });
  assertValid(rr);
  assert.equal(arcs(rr).length, 0);
});

test('radius limits: a huge or a tiny circle is cut with lines', () => {
  const huge = Array.from({ length: 400 }, (_, i) => ({ x: 20000 * Math.sin((i / 400) * 0.2), y: 20000 * (1 - Math.cos((i / 400) * 0.2)) }));
  const a = fitPath(huge, { closed: false, tol: TOL });
  assertValid(a, false);
  assert.equal(arcs(a).length, 0);
  assert.ok(maxDev(huge, a) <= TOL + EPS);
  const b = fitPath(huge, { closed: false, tol: TOL, maxRadius: 50000 });
  assert.ok(arcs(b).length >= 1 && b.length < a.length);
  const tiny = Array.from({ length: 50 }, (_, i) => ({ x: 0.3 * Math.cos((i / 50) * 2 * Math.PI), y: 0.3 * Math.sin((i / 50) * 2 * Math.PI) }));
  const c = fitPath(tiny, { tol: TOL });
  assertValid(c);
  assert.equal(arcs(c).length, 0);
  assert.ok(maxDev(tiny, c) <= TOL + EPS);
});

test('a polygon with long edges stays a polygon (arcs must fit the edges, not just the corners)', () => {
  const gon = Array.from({ length: 12 }, (_, i) => ({ x: 50 * Math.cos((i / 12) * 2 * Math.PI), y: 50 * Math.sin((i / 12) * 2 * Math.PI) }));
  const segs = fitPath(gon, { tol: TOL });
  assertValid(segs);
  assert.equal(lines(segs).length, 12);
  assert.ok(outputDev(segs, gon, true) <= TOL + 0.01);
});

test('a smooth ellipse and a spiral come out as a modest number of arcs', () => {
  const ell = Array.from({ length: 600 }, (_, i) => ({ x: 60 * Math.cos((i / 600) * 2 * Math.PI), y: 30 * Math.sin((i / 600) * 2 * Math.PI) }));
  const e = fitPath(ell, { tol: TOL });
  assertValid(e);
  assert.ok(e.length <= 20, `${e.length} segs`);
  assert.ok(maxDev(ell, e) <= TOL + EPS);
  const spiral = Array.from({ length: 800 }, (_, i) => { const a = (i / 800) * 6 * Math.PI, r = 5 + 3 * a; return { x: r * Math.cos(a), y: r * Math.sin(a) }; });
  const s = fitPath(spiral, { closed: false, tol: TOL });
  assertValid(s, false);
  assert.ok(s.length <= 30, `${s.length} segs`);
  assert.ok(maxDev(spiral, s) <= TOL + EPS);
});

test('a tighter tolerance is honoured', () => {
  const pts = roundRect(100, 60, 10, 0.25).map((p, i) => ({ x: p.x + Math.sin(i * 1.7) * 0.01, y: p.y + Math.cos(i * 2.3) * 0.01 }));
  for (const tol of [0.02, 0.05, 0.25]) {
    const segs = fitPath(pts, { tol });
    assertValid(segs);
    assert.ok(maxDev(pts, segs) <= tol + EPS, `tol ${tol}: ${maxDev(pts, segs)}`);
  }
});

test('10,000 points are fitted in under 100 ms', () => {
  fitPath(noisyCircle(300, 20, 0.01)); // warm the code up on something small
  const N = 10000;
  const shapes = {
    circle: Array.from({ length: N }, (_, i) => ({ x: 100 * Math.cos((i / N) * 2 * Math.PI), y: 100 * Math.sin((i / N) * 2 * Math.PI) })),
    rosette: Array.from({ length: N }, (_, i) => { const a = (i / N) * 2 * Math.PI, r = 50 + 5 * Math.sin(8 * a); return { x: 100 + r * Math.cos(a), y: 100 + r * Math.sin(a) }; }),
    roundRect: roundRect(300, 200, 20, 0.12),
    star: star(100, 500, 400, 0.02).pts,
  };
  for (const [name, pts] of Object.entries(shapes)) {
    const t0 = performance.now();
    const segs = fitPath(pts, { tol: TOL });
    const ms = performance.now() - t0;
    console.log(`  ${name}: ${pts.length} points -> ${segs.length} segments in ${ms.toFixed(1)} ms`);
    assertValid(segs);
    assert.ok(ms < 100, `${name} took ${ms.toFixed(1)} ms`);
    assert.ok(maxDev(pts.filter((_, i) => i % 7 === 0), segs) <= TOL + EPS);
  }
  const t0 = performance.now();
  fitPath(shapes.rosette, { tol: TOL, straight: true });
  assert.ok(performance.now() - t0 < 100, 'straight mode');
});

test('degenerate input still gives valid segments and no NaN', () => {
  const cases = {
    'nothing': [],
    'one point': [{ x: 5, y: 5 }],
    'two points': [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    'repeated points': [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }],
    'all the same': Array(20).fill({ x: 3, y: 4 }),
    'closing point repeated': [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 }],
    'bad numbers': [{ x: 0, y: 0 }, { x: NaN, y: 3 }, { x: 10, y: 0 }, { x: Infinity, y: 1 }, { x: 10, y: 10 }, null],
    'a speck': [{ x: 0, y: 0 }, { x: 0.01, y: 0 }, { x: 0.01, y: 0.01 }, { x: 0, y: 0.01 }],
    'collinear': Array.from({ length: 50 }, (_, i) => ({ x: i, y: i * 2 })),
    'a spike': [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0.001, y: 0.001 }, { x: 50, y: 0.002 }],
  };
  for (const [name, pts] of Object.entries(cases)) {
    for (const closed of [true, false]) {
      for (const straight of [false, true]) {
        const segs = fitPath(pts, { closed, straight, corners: [0, 1, 2, 99, -4, 1.5, NaN] });
        assertValid(segs, closed);
        assert.ok(segs.length > 0 || name === 'nothing', `${name} gave nothing`);
        assert.ok(Number.isFinite(segsLength(segs)), name);
        for (const p of sampleSegs(segs)) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), name);
      }
    }
  }
  assert.deepEqual(fitPath([]), []);
  assert.equal(fitPath([{ x: 1, y: 2 }]).length, 1);
  assert.equal(fitPath([{ x: 0, y: 0 }, { x: 10, y: 0 }], { closed: false }).length, 1);
  assert.equal(fitPath([{ x: 0, y: 0 }, { x: 10, y: 0 }], { closed: true }).length, 2); // there and back
  // Bad options fall back to the defaults.
  assertValid(fitPath(noisyCircle(100, 10, 0), { tol: NaN, maxRadius: -3 }));
  assert.equal(fitPath(undefined).length, 0);
});

test('random shapes always give valid, in-tolerance results', () => {
  const rnd = rng(99);
  for (let it = 0; it < 120; it++) {
    const n = 5 + Math.floor((rnd() + 1) * 150), pts = [];
    const kind = it % 4;
    if (kind === 0) for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI, r = 40 + 10 * Math.sin(3 * a + 1); pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) }); }
    else if (kind === 1) { let x = 0, y = 0, a = 0; for (let i = 0; i < n; i++) { a += rnd() * 0.3; x += Math.cos(a) * 0.5; y += Math.sin(a) * 0.5; pts.push({ x, y }); } }
    else if (kind === 2) for (let i = 0; i < n; i++) pts.push({ x: (rnd() + 1) * 50, y: (rnd() + 1) * 50 });
    else for (let i = 0; i < n; i++) pts.push({ x: i * 0.4, y: 3 * Math.sin(i * 0.1) + rnd() * 0.02 });
    for (const closed of [true, false]) {
      const segs = fitPath(pts, { closed, tol: 0.1, straight: it % 3 === 0 });
      assertValid(segs, closed);
      assert.ok(maxDev(pts, segs) <= 0.1 + EPS, `case ${it}: ${maxDev(pts, segs)}`);
    }
  }
});

// --- sampling, length, bulge ---------------------------------------------------------------

test('sampleSegs follows the shape closely and does not repeat the closing point', () => {
  const R = 50, pts = noisyCircle(400, R, 0);
  const segs = fitPath(pts, { tol: TOL });
  for (const err of [0.05, 0.01]) {
    const s = sampleSegs(segs, err);
    assert.deepEqual(s[0], segs[0].a);
    assert.notDeepEqual(s[s.length - 1], s[0], 'closing point repeated');
    // The chords of the sampled polyline stay within `err` of the circle.
    let worst = 0;
    for (let i = 0; i < s.length; i++) {
      const p = s[i], q = s[(i + 1) % s.length];
      worst = Math.max(worst, R - Math.hypot((p.x + q.x) / 2 - segs[0].c.x, (p.y + q.y) / 2 - segs[0].c.y));
    }
    assert.ok(worst <= err * 1.05, `sagitta ${worst} for ${err}`);
  }
  // An open path keeps its last point.
  const open = fitPath(sCurve(), { closed: false });
  const s = sampleSegs(open);
  assert.deepEqual(s[s.length - 1], open[open.length - 1].b);
  assert.deepEqual(sampleSegs([]), []);
  // Samples of lines are just their ends.
  const sq = fitPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], { corners: [0, 1, 2, 3] });
  assert.equal(sampleSegs(sq).length, 4);
});

test('segsLength and arcBulge', () => {
  const quarter = { type: 'arc', a: { x: 10, y: 0 }, b: { x: 0, y: 10 }, c: { x: 0, y: 0 }, r: 10, sweep: Math.PI / 2 };
  assert.ok(Math.abs(segsLength([quarter]) - 5 * Math.PI) < 1e-12);
  assert.ok(Math.abs(segsLength([{ type: 'line', a: { x: 0, y: 0 }, b: { x: 3, y: 4 } }]) - 5) < 1e-12);
  assert.equal(segsLength([]), 0);
  assert.ok(Math.abs(arcBulge(quarter) - Math.tan(Math.PI / 8)) < 1e-12);
  assert.ok(Math.abs(arcBulge(quarter, true) + Math.tan(Math.PI / 8)) < 1e-12);
  assert.ok(Math.abs(arcBulge({ ...quarter, sweep: -Math.PI }) + 1) < 1e-12); // a half circle is 1
  assert.ok(Math.abs(arcBulge({ ...quarter, sweep: -Math.PI }, true) - 1) < 1e-12);
});

// --- DXF and SVG --------------------------------------------------------------------------

// A tiny DXF reader for what we write: the POLYLINEs in ENTITIES, their closed flag and their
// vertices (x, y, bulge). It knows nothing about fit.js.
function readDXF(text) {
  const lines = text.split(/\r?\n/);
  const groups = [];
  for (let i = 0; i + 1 < lines.length; i += 2) groups.push([lines[i].trim(), lines[i + 1].trim()]);
  const header = {};
  const polys = [];
  let cur = null, v = null, inEntities = false;
  for (let i = 0; i < groups.length; i++) {
    const [c, val] = groups[i];
    if (c === '9') header[val] = groups[i + 1][1];
    if (c === '2' && val === 'ENTITIES') inEntities = true;
    if (c === '0' && val === 'ENDSEC') inEntities = false;
    if (!inEntities) continue;
    if (c === '0') {
      v = null;
      if (val === 'POLYLINE') { cur = { layer: null, closed: false, verts: [], ended: false }; polys.push(cur); }
      else if (val === 'VERTEX') { v = { x: NaN, y: NaN, bulge: 0 }; cur.verts.push(v); }
      else if (val === 'SEQEND') cur.ended = true;
    } else if (v) {
      if (c === '10') v.x = +val; else if (c === '20') v.y = +val; else if (c === '42') v.bulge = +val;
    } else if (cur && !cur.ended) {
      if (c === '8') cur.layer = val; else if (c === '70') cur.closed = (+val & 1) === 1;
    }
  }
  return { header, polys };
}

// Distance from p to the geometry a DXF polyline describes, using the standard bulge formulas
// (counter-clockwise positive, y up).
function distToDXFPoly(p, poly) {
  const n = poly.verts.length, last = poly.closed ? n : n - 1;
  let best = Infinity;
  for (let i = 0; i < last; i++) {
    const A = poly.verts[i], B = poly.verts[(i + 1) % n], b = A.bulge;
    const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy);
    if (!b) {
      const t = L ? Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / (L * L))) : 0;
      best = Math.min(best, Math.hypot(p.x - A.x - t * dx, p.y - A.y - t * dy));
      continue;
    }
    const theta = 4 * Math.atan(b), r = (L * (1 + b * b)) / (4 * Math.abs(b));
    const off = (L / 4) * ((1 - b * b) / b); // from the chord's middle to the centre, to its left
    const cx = (A.x + B.x) / 2 - (dy / L) * off, cy = (A.y + B.y) / 2 + (dx / L) * off;
    const a0 = Math.atan2(A.y - cy, A.x - cx);
    let rel = (Math.atan2(p.y - cy, p.x - cx) - a0) * Math.sign(theta);
    rel = ((rel % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    best = Math.min(best, rel <= Math.abs(theta) ? Math.abs(Math.hypot(p.x - cx, p.y - cy) - r) : Math.min(Math.hypot(p.x - A.x, p.y - A.y), Math.hypot(p.x - B.x, p.y - B.y)));
  }
  return best;
}

// Points along the geometry of a DXF polyline (eleven per segment), by the same formulas.
function dxfSamples(poly) {
  const n = poly.verts.length, last = poly.closed ? n : n - 1, out = [];
  for (let i = 0; i < last; i++) {
    const A = poly.verts[i], B = poly.verts[(i + 1) % n], b = A.bulge;
    const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy);
    let cx = 0, cy = 0, r = 0, theta = 0;
    if (b) {
      theta = 4 * Math.atan(b);
      r = (L * (1 + b * b)) / (4 * Math.abs(b));
      const off = (L / 4) * ((1 - b * b) / b);
      cx = (A.x + B.x) / 2 - (dy / L) * off;
      cy = (A.y + B.y) / 2 + (dx / L) * off;
    }
    for (let k = 0; k <= 10; k++) {
      const f = k / 10;
      if (!b) out.push({ x: A.x + dx * f, y: A.y + dy * f });
      else { const ang = Math.atan2(A.y - cy, A.x - cx) + theta * f; out.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) }); }
    }
  }
  return out;
}

test('DXF round trip: bulges and the y flip rebuild the original shape', () => {
  const H = 400;
  const shapes = [
    { name: 'circle', pts: noisyCircle(400, 50, 0.04), closed: true },
    { name: 'rounded rectangle', pts: roundRect(100, 60, 10), closed: true },
    { name: 'S bend', pts: sCurve().map((p) => ({ x: p.x + 20, y: p.y + 30 })), closed: false },
    { name: 'spiral', pts: Array.from({ length: 800 }, (_, i) => { const a = (i / 800) * 6 * Math.PI, r = 5 + 3 * a; return { x: 200 + r * Math.cos(a), y: 200 + r * Math.sin(a) }; }), closed: false },
    { name: 'star', ...(() => { const s = star(12, 50, 25, 0.03); return { pts: s.pts, corners: s.corners, closed: true }; })() },
  ];
  const paths = shapes.map((s) => ({ pts: s.pts, closed: s.closed, layer: 'CUT', segs: fitPath(s.pts, { closed: s.closed, tol: TOL, corners: s.corners }) }));
  const text = pathsToDXF(paths, { height: H });
  const dxf = readDXF(text);
  assert.equal(dxf.header.$ACADVER, 'AC1009', 'stays R12 so every CAM program reads it');
  assert.equal(dxf.polys.length, shapes.length, 'one POLYLINE per path');
  assert.ok(text.includes('\r\n0\r\nPOLYLINE\r\n') && text.endsWith('0\r\nEOF\r\n'));
  shapes.forEach((s, k) => {
    const poly = dxf.polys[k], segs = paths[k].segs;
    assert.equal(poly.layer, 'CUT');
    assert.equal(poly.closed, s.closed);
    assert.equal(poly.verts.length, segs.length + (s.closed ? 0 : 1), `${s.name}: one vertex per segment`);
    assert.equal(poly.verts.filter((v) => v.bulge).length, arcs(segs).length, `${s.name}: a bulge for every arc`);
    // Every original point lies within 2 tolerances of what the DXF describes.
    let worst = 0;
    for (const p of s.pts) worst = Math.max(worst, distToDXFPoly({ x: p.x, y: H - p.y }, poly));
    console.log(`  ${s.name}: ${s.pts.length} points -> ${poly.verts.length} vertices, ${poly.verts.filter((v) => v.bulge).length} bulges, worst ${worst.toFixed(3)} mm`);
    assert.ok(worst <= 2 * TOL, `${s.name}: ${worst} mm from the DXF geometry`);
    // And the other way round: points along the DXF's lines and arcs stay near the input outline.
    const outline = s.pts.map((p) => ({ x: p.x, y: H - p.y }));
    const edges = outline.slice(1).map((p, i) => ({ type: 'line', a: outline[i], b: p }));
    if (s.closed) edges.push({ type: 'line', a: outline[outline.length - 1], b: outline[0] });
    let stray = 0;
    for (const q of dxfSamples(poly)) stray = Math.max(stray, Math.min(...edges.map((e) => distToSeg(q, e))));
    assert.ok(stray <= 2 * TOL, `${s.name}: the DXF strays ${stray} mm from the input`);
  });
});

test('DXF arc direction: a quarter circle written by hand', () => {
  // y down: from (10, 0) to (0, 10) round the origin through (7.07, 7.07): increasing angle.
  const q = { type: 'arc', a: { x: 10, y: 0 }, b: { x: 0, y: 10 }, c: { x: 0, y: 0 }, r: 10, sweep: Math.PI / 2 };
  const back = { type: 'line', a: { x: 0, y: 10 }, b: { x: 10, y: 0 } };
  const dxf = readDXF(pathsToDXF([{ closed: true, layer: 'CUT', pts: [], segs: [q, back] }], { height: 100 }));
  const [v0, v1] = dxf.polys[0].verts;
  assert.deepEqual([v0.x, v0.y, v1.x, v1.y], [10, 100, 0, 90]);
  // In the file the y axis points up, so the same arc now runs clockwise: negative bulge.
  assert.ok(Math.abs(v0.bulge + Math.tan(Math.PI / 8)) < 1e-7, `bulge ${v0.bulge}`);
  assert.equal(v1.bulge, 0);
  // The same arc going the other way round is a positive bulge.
  const rev = { type: 'arc', a: { x: 0, y: 10 }, b: { x: 10, y: 0 }, c: { x: 0, y: 0 }, r: 10, sweep: -Math.PI / 2 };
  const d2 = readDXF(pathsToDXF([{ closed: false, layer: 'CUT', pts: [], segs: [rev] }], { height: 100 }));
  assert.ok(Math.abs(d2.polys[0].verts[0].bulge - Math.tan(Math.PI / 8)) < 1e-7);
  assert.equal(d2.polys[0].verts.length, 2);
});

test('paths with only pts are written exactly as before', () => {
  const tri = { pts: [{ x: 1, y: 2 }, { x: 11.5, y: 2 }, { x: 5, y: 9.25 }], closed: true, layer: 'CUT' };
  const open = { pts: [{ x: 0, y: 0 }, { x: 3, y: 4 }], closed: false, layer: 'HOLES' };
  const expected = [
    '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', '2',
    '0', 'LAYER', '2', 'CUT', '70', '0', '62', '7', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'HOLES', '70', '0', '62', '1', '6', 'CONTINUOUS',
    '0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
    '0', 'POLYLINE', '8', 'CUT', '66', '1', '10', '0', '20', '0', '30', '0', '70', '1',
    '0', 'VERTEX', '8', 'CUT', '10', '1.0000', '20', '98.0000', '30', '0',
    '0', 'VERTEX', '8', 'CUT', '10', '11.5000', '20', '98.0000', '30', '0',
    '0', 'VERTEX', '8', 'CUT', '10', '5.0000', '20', '90.7500', '30', '0',
    '0', 'SEQEND', '8', 'CUT',
    '0', 'POLYLINE', '8', 'HOLES', '66', '1', '10', '0', '20', '0', '30', '0', '70', '0',
    '0', 'VERTEX', '8', 'HOLES', '10', '0.0000', '20', '100.0000', '30', '0',
    '0', 'VERTEX', '8', 'HOLES', '10', '3.0000', '20', '96.0000', '30', '0',
    '0', 'SEQEND', '8', 'HOLES',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\r\n') + '\r\n';
  assert.equal(pathsToDXF([tri, open], { height: 100 }), expected);
  assert.equal(
    pathsToSVG([tri, open], { width: 50, height: 100 }),
    '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="100mm" viewBox="0 0 50 100">\n' +
      '  <g fill="none" stroke="#000" stroke-width="0.2"><path d="M1.000 2.000L11.500 2.000L5.000 9.250Z"/><path d="M0.000 0.000L3.000 4.000"/></g>\n</svg>\n',
  );
  // An empty segs list falls back to pts.
  assert.equal(pathsToDXF([{ ...tri, segs: [] }], { height: 100 }), pathsToDXF([tri], { height: 100 }));
});

test('SVG output uses arc commands with the right flags', () => {
  const R = 50, pts = noisyCircle(400, R, 0);
  const segs = fitPath(pts, { tol: TOL });
  const svg = pathsToSVG([{ pts, closed: true, layer: 'CUT', segs }], { width: 300, height: 300 });
  const d = /d="([^"]+)"/.exec(svg)[1];
  assert.ok(d.startsWith('M') && d.endsWith('Z'));
  assert.ok(!d.includes('L'), 'a circle has no lines');
  const arcsSVG = [...d.matchAll(/A([\d.]+) ([\d.]+) 0 ([01]) ([01]) ([\d.-]+) ([\d.-]+)/g)];
  assert.equal(arcsSVG.length, arcs(segs).length);
  arcsSVG.forEach((m, i) => {
    const s = arcs(segs)[i];
    assert.ok(Math.abs(+m[1] - s.r) < 1e-3 && Math.abs(+m[2] - s.r) < 1e-3);
    assert.equal(+m[3], Math.abs(s.sweep) > Math.PI ? 1 : 0, 'large-arc flag');
    assert.equal(+m[4], s.sweep > 0 ? 1 : 0, 'sweep flag: 1 = increasing angle (y down)');
    assert.ok(Math.abs(+m[5] - s.b.x) < 1e-3 && Math.abs(+m[6] - s.b.y) < 1e-3);
  });
  // Filled output uses the same commands.
  assert.ok(pathsToSVG([{ pts, closed: true, segs }], { width: 1, height: 1, fill: true }).includes('A'));
  // A line path has L commands and an open path has no Z.
  const open = fitPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], { closed: false, corners: [1] });
  const od = /d="([^"]+)"/.exec(pathsToSVG([{ pts: [], closed: false, segs: open }], { width: 1, height: 1 }))[1];
  assert.equal(od, 'M0.000 0.000L10.000 0.000L10.000 10.000');
});

test('a path collapsed to a point writes nothing to the DXF', () => {
  const segs = fitPath(Array(5).fill({ x: 3, y: 4 }));
  const dxf = readDXF(pathsToDXF([{ pts: [], closed: true, layer: 'CUT', segs }], { height: 10 }));
  assert.equal(dxf.polys.length, 0);
});
