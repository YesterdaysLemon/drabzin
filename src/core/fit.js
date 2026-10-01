// Turn a fine polyline into exact straight lines and circular arcs.
//
// Machines cut lines and arcs natively (G1 / G2 / G3), so a path of hundreds of tiny straight
// moves is replaced by a few long ones: straight where the design is straight, an arc where it
// curves, decided per stretch of the path.
//
// Coordinates are millimetres with y pointing DOWN (screen convention), the same frame as the
// input. An arc's `sweep` is the signed angle from `a` to `b` around `c` in that frame:
// positive means the direction of increasing atan2(y, x).
//
//   { type: 'line', a: {x, y}, b: {x, y} }
//   { type: 'arc',  a, b, c: {x, y}, r, sweep }
//
// Segments come out in path order with no gaps: each `a` has the same numbers as the previous
// `b`, and for a closed path the last `b` equals the first `a`.

const FIT_SWEEP = 2.5;    // largest arc accepted when fitting a stretch of the input (rad)
const MERGE_SWEEP = 3.3;  // largest arc when two neighbours are joined (a circle = two halves)
const MIN_RADIUS = 4;     // smallest arc radius, in tolerances
const MIN_CHORD = 3;      // shortest arc chord, in tolerances (below this a line is used)
const EPS = 1e-9;

// Scratch space for the local coordinates of the points of the stretch being fitted.
let LX = new Float64Array(1024), LY = new Float64Array(1024);
function reserve(n) {
  if (LX.length < n) {
    const size = Math.max(n, LX.length * 2);
    LX = new Float64Array(size);
    LY = new Float64Array(size);
  }
}

export function fitPath(pts, { closed = true, tol = 0.1, corners = null, straight = false, maxRadius = 5000 } = {}) {
  if (!(tol > 0) || !Number.isFinite(tol)) tol = 0.1;
  if (!(maxRadius > 0)) maxRadius = 5000;
  const input = Array.isArray(pts) ? pts : [];

  // 1) Clean the input: drop non-finite points and repeats, remember where each index went.
  const P = [];
  const map = new Int32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const p = input[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) { map[i] = Math.max(0, P.length - 1); continue; }
    const q = P[P.length - 1];
    if (q && Math.abs(q.x - p.x) < EPS && Math.abs(q.y - p.y) < EPS) { map[i] = P.length - 1; continue; }
    map[i] = P.length;
    P.push({ x: p.x, y: p.y });
  }
  if (closed && P.length > 1) {
    const f = P[0], l = P[P.length - 1];
    if (Math.abs(f.x - l.x) < EPS && Math.abs(f.y - l.y) < EPS) {
      const last = P.length - 1;
      P.pop();
      for (let i = 0; i < map.length; i++) if (map[i] === last) map[i] = 0;
    }
  }
  const n = P.length;
  if (n === 0) return [];
  if (n === 1) return [{ type: 'line', a: { x: P[0].x, y: P[0].y }, b: { x: P[0].x, y: P[0].y } }];

  // 2) Corner indices in the cleaned array. Open paths always break at both ends.
  const cset = new Set();
  if (corners) for (const c of corners) if (Number.isInteger(c) && c >= 0 && c < map.length) cset.add(map[c]);
  if (!closed) { cset.delete(0); cset.delete(n - 1); }
  const cs = [...cset].sort((a, b) => a - b);

  // 3) Lay the points out so every stretch to fit is a plain index range [s, e].
  //    Open: as is. Closed with corners: rotated to start at a corner, first point repeated at
  //    the end. Closed without corners: doubled (so two pieces can be joined across the seam).
  let X, Y, bounds, ring = false;
  const fill = (list) => { X = new Float64Array(list.length); Y = new Float64Array(list.length); list.forEach((p, i) => { X[i] = p.x; Y[i] = p.y; }); };
  if (!closed) {
    fill(P);
    bounds = [0, ...cs, n - 1];
  } else if (cs.length) {
    const start = cs[0], list = [];
    for (let k = 0; k <= n; k++) list.push(P[(start + k) % n]);
    fill(list);
    bounds = [...cs.map((c) => c - start), n];
  } else {
    ring = true;
    fill([...P, ...P, P[0]]);
    let far = 1, fd = -1;
    for (let i = 1; i < n; i++) {
      const d = (X[i] - X[0]) ** 2 + (Y[i] - Y[0]) ** 2;
      if (d > fd) { fd = d; far = i; }
    }
    bounds = [0, far, n];
  }

  const minChord = MIN_CHORD * tol, minRadius = MIN_RADIUS * tol;

  // --- measuring --------------------------------------------------------------------------

  // Largest distance of the points strictly between s and e from the chord s-e. Leaves the
  // index of the farthest point in `worst`. With `all` false it stops at the first point
  // beyond tol. A zero-length chord reports Infinity.
  let worst = -1;
  function chordDev(s, e, all) {
    const ax = X[s], ay = Y[s], dx = X[e] - ax, dy = Y[e] - ay;
    const L2 = dx * dx + dy * dy;
    let max = -1;
    worst = s + 1;
    if (L2 < 1e-18) {
      for (let i = s + 1; i < e; i++) {
        const d = (X[i] - ax) ** 2 + (Y[i] - ay) ** 2;
        if (d > max) { max = d; worst = i; }
      }
      return Infinity;
    }
    const L = Math.sqrt(L2);
    for (let i = s + 1; i < e; i++) {
      const px = X[i] - ax, py = Y[i] - ay;
      const t = (px * dx + py * dy) / L2;
      let d;
      if (t < 0) d = Math.sqrt(px * px + py * py);
      else if (t > 1) d = Math.sqrt((px - dx) * (px - dx) + (py - dy) * (py - dy));
      else d = Math.abs(px * dy - py * dx) / L;
      if (d > max) { max = d; worst = i; if (!all && d > tol) return d; }
    }
    return max;
  }

  // Worst deviation of the local points from the arc with centre (0, t), radius R through the
  // chord ends (-h, 0) and (h, 0), bulging to the side `sg` (+1 or -1). It also checks the
  // middle of every long input edge, so sparse input cannot hide a bad fit between points.
  function arcDev(t, h, sg, m, bail) {
    const R = Math.sqrt(h * h + t * t);
    const lim2 = 2 * R * tol;
    let max = 0, px = -h, py = 0;
    for (let i = 0; i <= m; i++) {
      const qx = i < m ? LX[i] : h, qy = i < m ? LY[i] : 0;
      if (i < m) {
        const d = arcDist(qx, qy, t, h, sg, R);
        if (d > max) { max = d; if (max > bail) return max; }
      }
      const ex = qx - px, ey = qy - py;
      if (ex * ex + ey * ey > lim2) {
        const d = arcDist((px + qx) / 2, (py + qy) / 2, t, h, sg, R);
        if (d > max) { max = d; if (max > bail) return max; }
      }
      px = qx; py = qy;
    }
    return max;
  }

  // The arc is the part of the circle on the bulge side of the chord. A point on the other
  // side, or (for an arc that is less than half a circle) past either end of the chord, is
  // measured to the nearer end of the arc.
  function arcDist(lx, ly, t, h, sg, R) {
    if (ly * sg >= -1e-9 && (t * sg > 0 || lx <= h && lx >= -h)) {
      const dy = ly - t;
      return Math.abs(Math.sqrt(lx * lx + dy * dy) - R);
    }
    const da = (lx + h) * (lx + h) + ly * ly, db = (lx - h) * (lx - h) + ly * ly;
    return Math.sqrt(Math.min(da, db));
  }

  // Best circle through the ends of s..e for the points between them. Fills `arc` and returns
  // true when every point is within tol and the arc is a sensible one.
  const arc = { cx: 0, cy: 0, r: 0, sweep: 0 };
  function arcFit(s, e, maxSweep) {
    const m = e - s - 1;
    if (m < 1) return false;
    const ax = X[s], ay = Y[s], dx = X[e] - ax, dy = Y[e] - ay;
    const L = Math.sqrt(dx * dx + dy * dy);
    if (L < minChord) return false;
    const h = L / 2, ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    const mx = (ax + X[e]) / 2, my = (ay + Y[e]) / 2;
    reserve(m);
    let syy = 0, syq = 0, sy = 0;
    for (let i = 0; i < m; i++) {
      const px = X[s + 1 + i] - mx, py = Y[s + 1 + i] - my;
      const lx = px * ux + py * uy, ly = px * nx + py * ny;
      LX[i] = lx; LY[i] = ly;
      syy += ly * ly; syq += ly * (lx * lx + ly * ly - h * h); sy += ly;
    }
    if (syy < 1e-24) return false;
    const sg = sy >= 0 ? 1 : -1;

    // Algebraic start (exact least squares for |P-C|^2 = r^2; for points near a circle it is
    // almost the geometric fit), then a few Gauss-Newton steps on the true radial distances.
    // The centre sits at (0, t) in the chord's frame.
    let t = syq / (2 * syy);
    if (!Number.isFinite(t) || Math.abs(t) > 1e7) return false;
    // Throw out what is far from working before spending more on it.
    if (2 * Math.atan2(h, -t * sg) > maxSweep + 0.3 || Math.sqrt(h * h + t * t) > 2 * maxRadius) return false;
    if (arcDev(t, h, sg, m, 3 * tol) > 3 * tol) return false;
    const cost = (tt) => {
      const R = Math.sqrt(h * h + tt * tt);
      let c = 0;
      for (let i = 0; i < m; i++) { const dy2 = LY[i] - tt; const d = Math.sqrt(LX[i] * LX[i] + dy2 * dy2) - R; c += d * d; }
      return c;
    };
    let c0 = cost(t);
    for (let it = 0; it < 3; it++) {
      const R = Math.sqrt(h * h + t * t);
      let jr = 0, jj = 0;
      for (let i = 0; i < m; i++) {
        const dy2 = LY[i] - t, rho = Math.sqrt(LX[i] * LX[i] + dy2 * dy2);
        if (rho < 1e-12) continue;
        const J = -dy2 / rho - t / R;
        jr += J * (rho - R); jj += J * J;
      }
      if (jj < 1e-18) break;
      let step = -jr / jj;
      let next = t + step, c1 = cost(next);
      for (let k = 0; k < 3 && !(c1 <= c0); k++) { step /= 2; next = t + step; c1 = cost(next); }
      if (!(c1 <= c0)) break;
      const done = Math.abs(step) < 1e-6 * tol;
      t = next; c0 = c1;
      if (done) break;
    }

    // The tolerance. Least squares leaves the worst point further out than needed, so when it
    // is close slide the centre to minimise the worst error instead (golden-section on the one
    // free parameter; the best centre is within a few tolerances of the least-squares one).
    let dev = arcDev(t, h, sg, m, 2.5 * tol);
    if (dev > 2.5 * tol) return false;
    if (dev > tol) {
      let lo = t - 3 * tol, hi = t + 3 * tol;
      const g = 0.6180339887498949;
      let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
      let f1 = arcDev(x1, h, sg, m, Infinity), f2 = arcDev(x2, h, sg, m, Infinity);
      for (let it = 0; it < 12; it++) {
        if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = arcDev(x1, h, sg, m, Infinity); }
        else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = arcDev(x2, h, sg, m, Infinity); }
      }
      const tb = f1 < f2 ? x1 : x2, fb = Math.min(f1, f2);
      if (fb < dev) { t = tb; dev = fb; }
      if (dev > tol) return false;
    }
    const R = Math.sqrt(h * h + t * t);
    if (R < minRadius || R > maxRadius) return false;
    const sweep = -sg * 2 * Math.atan2(h, -t * sg);
    if (!(Math.abs(sweep) <= maxSweep)) return false;
    arc.cx = mx + nx * t; arc.cy = my + ny * t; arc.r = R; arc.sweep = sweep;
    return true;
  }

  // A line or an arc for the whole of s..e, or null. `deep` keeps the worst point for splitting.
  function fitSpan(s, e, maxSweep, deep) {
    if (e - s === 1) return { s, e, arc: null };
    const dev = chordDev(s, e, deep);
    if (dev <= tol) return { s, e, arc: null };
    if (!straight && arcFit(s, e, maxSweep)) return { s, e, arc: { cx: arc.cx, cy: arc.cy, r: arc.r, sweep: arc.sweep } };
    return null;
  }

  // --- fitting ----------------------------------------------------------------------------

  // Split a stretch at its worst point until every piece is a line or an arc.
  function solve(s0, e0, out) {
    const stack = [s0, e0];
    while (stack.length) {
      const e = stack.pop(), s = stack.pop();
      const piece = fitSpan(s, e, FIT_SWEEP, true);
      if (piece) { out.push(piece); continue; }
      const w = worst > s && worst < e ? worst : (s + e) >> 1;
      stack.push(w, e, s, w);
    }
  }

  // Join neighbours whose union is still a single line or arc within tol.
  function merge(list) {
    for (let pass = 0; pass < 4 && list.length > 1; pass++) {
      let changed = false;
      const out = [list[0]];
      for (let i = 1; i < list.length; i++) {
        const prev = out[out.length - 1];
        const joined = fitSpan(prev.s, list[i].e, MERGE_SWEEP, false);
        if (joined) { out[out.length - 1] = joined; changed = true; } else out.push(list[i]);
      }
      list = out;
      if (!changed) break;
    }
    return list;
  }

  const fits = (s, e) => fitSpan(s, e, MERGE_SWEEP, false) !== null;

  // Drop a piece that its neighbours can share: the piece before it reaches as far into it as
  // it can, the piece after it as far back, and when those reaches overlap the boundary can
  // sit anywhere in the overlap. This is what lets an S bend come out as two arcs even when the
  // first cut fell a little short of where the curve changes.
  const tried = new Set();
  function eliminate(list) {
    let changed = false;
    for (let i = 1; i + 1 < list.length; i++) {
      const o = list[i - 1], p = list[i], q = list[i + 1];
      const key = o.s + ',' + p.s + ',' + p.e + ',' + q.e;
      if (tried.has(key)) continue;
      // How far the piece before reaches into this one.
      let a = p.s, b = p.e;
      if (fits(o.s, b)) a = b;
      else while (b - a > 1) { const mid = (a + b) >> 1; if (fits(o.s, mid)) a = mid; else b = mid; }
      const reachO = a;
      // The piece after must reach back at least that far.
      if (reachO === p.s || !fits(reachO, q.e)) { tried.add(key); continue; }
      let c = p.s, d = reachO;
      if (fits(c, q.e)) d = c;
      else while (d - c > 1) { const mid = (c + d) >> 1; if (fits(mid, q.e)) d = mid; else c = mid; }
      const m = (d + reachO) >> 1;
      const left = fitSpan(o.s, m, MERGE_SWEEP, false), right = fitSpan(m, q.e, MERGE_SWEEP, false);
      if (!left || !right) { tried.add(key); continue; }
      list.splice(i - 1, 3, left, right);
      changed = true;
      i = Math.max(0, i - 2);
    }
    return changed;
  }

  // Merge and eliminate until nothing more can go.
  function settle(list) {
    for (let round = 0; round < 4; round++) {
      list = merge(list);
      if (!eliminate(list)) break;
    }
    return list;
  }

  // A loop has no start: join the last piece to the first across the seam, then settle.
  function seam(list) {
    for (let round = 0; round < 8 && list.length > 2; round++) {
      const joined = fitSpan(list[list.length - 1].s, list[0].e + n, MERGE_SWEEP, false);
      if (!joined) break;
      list = settle([...list.slice(1, -1), joined]);
    }
    return list;
  }

  let pieces = [];
  if (ring) {
    for (let k = 0; k + 1 < bounds.length; k++) solve(bounds[k], bounds[k + 1], pieces);
    pieces = seam(settle(pieces));
    if (pieces.length > 3) {
      // Turn the loop half way round, so the old seam is in the middle where it can be tidied.
      const k = pieces.length >> 1;
      pieces = [...pieces.slice(k), ...pieces.slice(0, k).map((p) => ({ s: p.s + n, e: p.e + n, arc: p.arc }))];
      pieces = seam(settle(pieces));
    }
  } else {
    for (let k = 0; k + 1 < bounds.length; k++) {
      const part = [];
      solve(bounds[k], bounds[k + 1], part);
      for (const p of settle(part)) pieces.push(p);
    }
  }

  // --- output -----------------------------------------------------------------------------
  return pieces.map((p) => {
    const a = { x: X[p.s], y: Y[p.s] }, b = { x: X[p.e], y: Y[p.e] };
    return p.arc
      ? { type: 'arc', a, b, c: { x: p.arc.cx, y: p.arc.cy }, r: p.arc.r, sweep: p.arc.sweep }
      : { type: 'line', a, b };
  });
}

// Points along the segments, close enough to the true shape (within maxErr mm) for drawing,
// hit testing and area. Each segment contributes its start and the points along it; the last
// point is added only when the path is open (or `closed` is false), so a closed path does not
// repeat its first point.
export function sampleSegs(segs, maxErr = 0.05, closed) {
  const out = [];
  if (!segs || !segs.length) return out;
  for (const s of segs) {
    out.push({ x: s.a.x, y: s.a.y });
    if (s.type !== 'arc') continue;
    const r = s.r;
    const step = Math.min(Math.PI / 2, 2 * Math.acos(Math.max(-1, 1 - Math.min(1, maxErr / r))) || Math.PI / 2);
    const k = Math.max(1, Math.ceil(Math.abs(s.sweep) / step));
    const a0 = Math.atan2(s.a.y - s.c.y, s.a.x - s.c.x);
    for (let i = 1; i < k; i++) {
      const ang = a0 + (s.sweep * i) / k;
      out.push({ x: s.c.x + r * Math.cos(ang), y: s.c.y + r * Math.sin(ang) });
    }
  }
  const first = segs[0].a, last = segs[segs.length - 1].b;
  const isClosed = closed ?? (Math.abs(first.x - last.x) < EPS && Math.abs(first.y - last.y) < EPS);
  if (!isClosed) out.push({ x: last.x, y: last.y });
  return out;
}

export function segsLength(segs) {
  let total = 0;
  for (const s of segs || []) {
    total += s.type === 'arc' ? s.r * Math.abs(s.sweep) : Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
  }
  return total;
}

// The DXF bulge of an arc: tan(sweep / 4). DXF counts counter-clockwise with y up, so when
// the y axis is flipped on the way out (y_dxf = height - y) the sign flips too.
export function arcBulge(seg, flipY = false) {
  const b = Math.tan(seg.sweep / 4);
  return flipY ? -b : b;
}
