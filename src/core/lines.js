// Constrained line search for geometric designs. When the design only uses a few angles
// (multiples of 45, 30, 22.5, 18 ... degrees) we can sweep every offset at every allowed
// angle and keep the lines that run along strap centres. Unlike piecewise fitting this is
// not confused by crossings, where the skeleton is unreliable.
import { distanceTransform } from './raster.js';

export function findLines(mask, { stepDeg, strokePx, minRunFactor = 2, minBoundedFactor = 1, ridge = 0.75 }) {
  const { w, h } = mask;
  const dt = distanceTransform(mask);
  const hw = strokePx / 2;
  const need = ridge * hw;
  const on = new Uint8Array(w * h);
  for (let i = 0; i < on.length; i++) on[i] = dt[i] >= need ? 1 : 0;
  const minRun = minRunFactor * strokePx, gapTol = Math.max(2, 0.5 * strokePx);
  const segs = [];
  const nAng = Math.round(180 / stepDeg);
  for (let k = 0; k < nAng; k++) {
    const th = (k * stepDeg * Math.PI) / 180;
    const u = { x: Math.cos(th), y: Math.sin(th) }, n = { x: -u.y, y: u.x };
    const corners = [[0, 0], [w, 0], [w, h], [0, h]];
    const rs = corners.map(([x, y]) => x * n.x + y * n.y), ts = corners.map(([x, y]) => x * u.x + y * u.y);
    const r0 = Math.floor(Math.min(...rs)), r1 = Math.ceil(Math.max(...rs));
    const t0 = Math.floor(Math.min(...ts)), t1 = Math.ceil(Math.max(...ts));
    // A real line somewhere runs along an isolated strap (background on both sides at a
    // little more than half a strap width). Lines that only cut through junction blobs never do.
    const side = 1.6 * hw;
    const bg = (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      return xi < 0 || yi < 0 || xi >= w || yi >= h || !mask.data[yi * w + xi];
    };
    const needBounded = minBoundedFactor * strokePx;
    const runsAt = (r) => {
      const runs = [];
      let start = null, last = null, bounded = 0;
      const close = () => { if (last - start >= minRun && bounded >= needBounded) runs.push([start, last]); };
      for (let t = t0; t <= t1; t++) {
        const fx = n.x * r + u.x * t, fy = n.y * r + u.y * t;
        const x = Math.floor(fx), y = Math.floor(fy);
        const inside = x >= 0 && y >= 0 && x < w && y < h && on[y * w + x];
        if (inside) {
          if (start === null) { start = t; bounded = 0; }
          else if (t - last > gapTol) { close(); start = t; bounded = 0; }
          last = t;
          if (bg(fx + n.x * side, fy + n.y * side) && bg(fx - n.x * side, fy - n.y * side)) bounded++;
        }
      }
      if (start !== null) close();
      return runs;
    };
    const resp = new Float32Array(r1 - r0 + 1);
    for (let r = r0; r <= r1; r++) {
      let s = 0;
      for (const [a, b] of runsAt(r + 0.5)) s += b - a;
      resp[r - r0] = s;
    }
    // Non-maximum suppression across offsets: parallel strap centres are at least a strap apart.
    const win = Math.max(2, Math.round(0.6 * strokePx));
    for (let i = 0; i < resp.length; i++) {
      const v = resp[i];
      if (v <= 0) continue;
      let isMax = true;
      for (let j = Math.max(0, i - win); j <= Math.min(resp.length - 1, i + win); j++) {
        if (resp[j] > v || (resp[j] === v && j < i)) { isMax = false; break; }
      }
      if (!isMax) continue;
      // Sub-pixel offset: centroid of the response plateau around the peak.
      const half = Math.max(1, Math.round(0.3 * strokePx));
      let ws = 0, rs2 = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(resp.length - 1, i + half); j++) { ws += resp[j]; rs2 += resp[j] * (j + r0 + 0.5); }
      const r = rs2 / ws;
      // Use the union of runs over the plateau so a slightly off-centre line is not chopped.
      const all = [];
      for (const rr of [r - 1, r, r + 1]) all.push(...runsAt(rr));
      all.sort((p, q) => p[0] - q[0]);
      const merged = [];
      for (const run of all) {
        const m = merged[merged.length - 1];
        if (m && run[0] <= m[1] + gapTol) m[1] = Math.max(m[1], run[1]);
        else merged.push([...run]);
      }
      for (const [a, b] of merged)
        segs.push({ a: { x: n.x * r + u.x * a, y: n.y * r + u.y * a }, b: { x: n.x * r + u.x * b, y: n.y * r + u.y * b }, w: 1, snapped: true });
    }
  }
  return segs;
}
