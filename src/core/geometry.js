// Vector stage: turn traced polylines into a clean planar line network.
// A segment is { a:{x,y}, b:{x,y}, w } where w is a support weight.

const EPS = 1e-9;

export const sub = (p, q) => ({ x: p.x - q.x, y: p.y - q.y });
export const add = (p, q) => ({ x: p.x + q.x, y: p.y + q.y });
export const mul = (p, s) => ({ x: p.x * s, y: p.y * s });
export const dot = (p, q) => p.x * q.x + p.y * q.y;
export const cross = (p, q) => p.x * q.y - p.y * q.x;
export const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
export const segLen = (s) => dist(s.a, s.b);

export function simplifyDP(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const a = pts[i], b = pts[j];
    let best = -1, bi = -1;
    for (let k = i + 1; k < j; k++) {
      const d = pointSegDist(pts[k], a, b);
      if (d > best) { best = d; bi = k; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([i, bi], [bi, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

export function pointSegDist(p, a, b) {
  const ab = sub(b, a), l2 = dot(ab, ab);
  if (l2 < EPS) return dist(p, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, add(a, mul(ab, t)));
}

export function polylinesToSegments(lines, tol) {
  const segs = [];
  for (const line of lines) {
    const s = simplifyDP(line, tol);
    for (let i = 0; i + 1 < s.length; i++) if (dist(s[i], s[i + 1]) > EPS) segs.push({ a: s[i], b: s[i + 1], w: 1 });
  }
  return segs;
}

const angleOf = (s) => {
  let t = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
  if (t < 0) t += Math.PI;
  if (t >= Math.PI) t -= Math.PI;
  return t;
};

// Guess the angle step the design is built on (90, 45, 30, 22.5, 18, 15 degrees): the
// coarsest step that explains most of the line length. Returns 0 if nothing fits.
export function detectAngleStep(segs, candidates = [90, 45, 30, 22.5, 18, 15]) {
  // Long lines carry the design; weight by length squared so junction debris barely counts.
  let total = 0;
  for (const s of segs) total += segLen(s) ** 2;
  if (!total) return { deg: 0, coverage: [] };
  const coverage = [...new Set(candidates)].sort((a, b) => b - a).map((deg) => {
    const step = (deg * Math.PI) / 180, tol = (Math.min(4, deg / 5) * Math.PI) / 180;
    let hit = 0;
    for (const s of segs) {
      const t = angleOf(s), r = Math.abs(t - Math.round(t / step) * step);
      if (r <= tol) hit += segLen(s) ** 2;
    }
    const cov = hit / total, chance = (2 * tol) / step;
    // finer steps match more lines by chance; correct for that
    return { deg, cov, score: (cov - chance) / (1 - chance) };
  });
  const best = Math.max(...coverage.map((c) => c.score));
  if (best < 0.4) return { deg: 0, coverage };
  return { deg: coverage.find((c) => c.score >= best - 0.1).deg, coverage };
}

// Rotate each segment about its midpoint onto the nearest multiple of `step` if within `tol`.
export function snapAngles(segs, step, tol) {
  if (!(step > 0)) return segs;
  return segs.map((s) => {
    const t = angleOf(s);
    const target = Math.round(t / step) * step;
    if (Math.abs(t - target) > tol) return { ...s, snapped: false };
    const m = mul(add(s.a, s.b), 0.5), h = segLen(s) / 2;
    const u = { x: Math.cos(target) * h, y: Math.sin(target) * h };
    // keep the original orientation of a->b
    const sign = dot(u, sub(s.b, s.a)) >= 0 ? 1 : -1;
    return { ...s, a: sub(m, mul(u, sign)), b: add(m, mul(u, sign)), snapped: true };
  });
}

export function transformSeg(s, m) {
  const f = (p) => ({ x: m.a * p.x + m.b * p.y + m.c, y: m.d * p.x + m.e * p.y + m.f });
  return { ...s, a: f(s.a), b: f(s.b) };
}

// Merge segments lying on (nearly) the same infinite line. Returns segments with a
// `cover` field: average number of input segments overlapping the merged interval.
export function mergeCollinear(segs, { angTol = 0.03, rhoTol = 1.5, gapTol = 2 } = {}) {
  const items = segs.filter((s) => segLen(s) > EPS).map((s) => ({ s, t: angleOf(s) })).sort((p, q) => p.t - q.t);
  if (!items.length) return [];
  // Greedy angle clustering with wrap-around at pi.
  const groups = [];
  let cur = [items[0]];
  // Bounded span (not chaining), otherwise a spread of noisy angles collapses into one group.
  for (let i = 1; i < items.length; i++) {
    if (items[i].t - cur[0].t < angTol) cur.push(items[i]);
    else { groups.push(cur); cur = [items[i]]; }
  }
  groups.push(cur);
  if (groups.length > 1) {
    const first = groups[0], last = groups[groups.length - 1];
    if (first[0].t + Math.PI - last[last.length - 1].t < angTol) { groups[0] = last.concat(first); groups.pop(); }
  }
  const out = [];
  for (const g of groups) {
    // Mean direction via doubled angles (handles the pi ambiguity).
    let cx = 0, cy = 0;
    for (const { s, t } of g) { const l = segLen(s) * (s.w ?? 1); cx += Math.cos(2 * t) * l; cy += Math.sin(2 * t) * l; }
    const th = Math.atan2(cy, cx) / 2;
    const u = { x: Math.cos(th), y: Math.sin(th) }, n = { x: -u.y, y: u.x };
    const proj = g.map(({ s }) => {
      const r = (dot(s.a, n) + dot(s.b, n)) / 2;
      const t0 = dot(s.a, u), t1 = dot(s.b, u);
      return { r, t0: Math.min(t0, t1), t1: Math.max(t0, t1), w: s.w ?? 1 };
    }).sort((p, q) => p.r - q.r);
    let line = [proj[0]];
    const flush = () => {
      let rw = 0, rs = 0;
      for (const p of line) { const l = (p.t1 - p.t0 + 0.5) * p.w; rw += l; rs += p.r * l; }
      const r = rs / rw;
      line.sort((p, q) => p.t0 - q.t0);
      let a = line[0].t0, b = line[0].t1, support = (b - a) * line[0].w;
      const emit = () => {
        const len = b - a;
        out.push({
          a: add(mul(u, a), mul(n, r)), b: add(mul(u, b), mul(n, r)),
          w: 1, cover: len > EPS ? support / len : line.length,
        });
      };
      for (let i = 1; i < line.length; i++) {
        const p = line[i];
        if (p.t0 <= b + gapTol) { b = Math.max(b, p.t1); support += (p.t1 - p.t0) * p.w; }
        else { emit(); a = p.t0; b = p.t1; support = (b - a) * p.w; }
      }
      emit();
    };
    for (let i = 1; i < proj.length; i++) {
      if (proj[i].r - proj[i - 1].r < rhoTol && proj[i].r - line[0].r < 2 * rhoTol) line.push(proj[i]);
      else { flush(); line = [proj[i]]; }
    }
    flush();
  }
  return out;
}

// Liang-Barsky clip to [x0,x1]x[y0,y1].
export function clipSeg(s, x0, y0, x1, y1) {
  let t0 = 0, t1 = 1;
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
  const p = [-dx, dx, -dy, dy], q = [s.a.x - x0, x1 - s.a.x, s.a.y - y0, y1 - s.a.y];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < EPS) { if (q[i] < 0) return null; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return { ...s, a: { x: s.a.x + t0 * dx, y: s.a.y + t0 * dy }, b: { x: s.a.x + t1 * dx, y: s.a.y + t1 * dy } };
}

// Enforce the symmetry group on a segment soup: fold everything into tile 0, apply the
// tile's rotations/reflections, merge and vote, then tile back out across the panel.
export function enforceSymmetry(segs, group, { W, H, rhoTol, gapTol, angTol, minCover = 0.25 }) {
  const { tw, th, nx, ny, local } = group;
  const tiled = nx * ny > 1;
  const folded = [];
  for (const s of segs) {
    const mx = (s.a.x + s.b.x) / 2, my = (s.a.y + s.b.y) / 2;
    const i = tiled ? Math.floor(mx / tw) : 0, j = tiled ? Math.floor(my / th) : 0;
    const shifted = { ...s, a: { x: s.a.x - i * tw, y: s.a.y - j * th }, b: { x: s.b.x - i * tw, y: s.b.y - j * th } };
    for (const m of local) {
      let t = transformSeg(shifted, m);
      if (tiled) {
        // keep the midpoint inside tile 0 so copies of the same feature coincide
        const cx = (t.a.x + t.b.x) / 2, cy = (t.a.y + t.b.y) / 2;
        const di = Math.floor(cx / tw) * tw, dj = Math.floor(cy / th) * th;
        t = { ...t, a: { x: t.a.x - di, y: t.a.y - dj }, b: { x: t.b.x - di, y: t.b.y - dj } };
      }
      folded.push(t);
    }
  }
  // A feature in a periodic design should be seen in many tiles; noise is not.
  const expected = tiled ? nx * ny : 1;
  let canon = mergeCollinear(folded, { angTol, rhoTol, gapTol }).filter((s) => s.cover >= minCover * expected);
  if (!tiled) return canon.map((s) => clipSeg(s, 0, 0, W, H)).filter(Boolean);
  const out = [];
  for (let j = -1; j <= ny; j++)
    for (let i = -1; i <= nx; i++)
      for (const s of canon) {
        const c = clipSeg({ a: { x: s.a.x + i * tw, y: s.a.y + j * th }, b: { x: s.b.x + i * tw, y: s.b.y + j * th }, w: 1 }, 0, 0, W, H);
        if (c && segLen(c) > EPS) out.push(c);
      }
  return mergeCollinear(out, { angTol: angTol / 4, rhoTol: rhoTol / 4, gapTol: 0.5 });
}

function lineIntersect(p, r, q, s) {
  // p + t r = q + u s
  const d = cross(r, s);
  if (Math.abs(d) < EPS) return null;
  const qp = sub(q, p);
  return { t: cross(qp, s) / d, u: cross(qp, r) / d };
}

// Close small gaps: L-corners where two lines stop short, and T-junctions where a line
// stops short of (or overshoots) another one.
export function closeGaps(segs, { extTol }) {
  const S = segs.map((s) => ({ ...s, a: { ...s.a }, b: { ...s.b } }));
  const ends = [];
  S.forEach((s, i) => { ends.push({ i, k: 'a' }, { i, k: 'b' }); });
  const P = (e) => S[e.i][e.k];
  const dirOut = (e) => {
    const s = S[e.i], o = e.k === 'a' ? s.b : s.a, p = s[e.k];
    const l = dist(p, o) || 1;
    return { x: (p.x - o.x) / l, y: (p.y - o.y) / l };
  };
  const connected = (e, tol) => {
    const p = P(e);
    for (let j = 0; j < S.length; j++) {
      if (j === e.i) continue;
      if (pointSegDist(p, S[j].a, S[j].b) < tol) return true;
    }
    return false;
  };
  const tiny = Math.max(0.25, extTol * 0.05);
  // 1) L-corners: two free ends whose lines intersect close to both ends.
  const free = ends.filter((e) => !connected(e, tiny));
  const used = new Set();
  for (let x = 0; x < free.length; x++) {
    const e = free[x];
    if (used.has(x)) continue;
    let best = null;
    for (let y = 0; y < free.length; y++) {
      if (y === x || used.has(y) || free[y].i === e.i) continue;
      const f = free[y];
      const pe = P(e), pf = P(f);
      if (dist(pe, pf) > 2 * extTol) continue;
      const hit = lineIntersect(pe, dirOut(e), pf, dirOut(f));
      if (!hit) continue;
      // mostly extension; only a little pull-back so unrelated ends are not folded together
      const back = -0.2 * extTol;
      if (hit.t < back || hit.t > extTol || hit.u < back || hit.u > extTol) continue;
      const cost = Math.abs(hit.t) + Math.abs(hit.u);
      if (!best || cost < best.cost) best = { y, cost, hit };
    }
    if (best) {
      const f = free[best.y];
      const q = add(P(e), mul(dirOut(e), best.hit.t));
      S[e.i][e.k] = { ...q };
      S[f.i][f.k] = { ...q };
      used.add(x); used.add(best.y);
    }
  }
  // 2) T-junctions: extend (or pull back) a free end onto the nearest crossing line.
  for (const e of ends) {
    if (connected(e, tiny)) continue;
    const p = P(e), d = dirOut(e);
    let bestT = Infinity;
    for (let j = 0; j < S.length; j++) {
      if (j === e.i) continue;
      const s = S[j], r = sub(s.b, s.a);
      const hit = lineIntersect(p, d, s.a, r);
      if (!hit || hit.u < -0.02 || hit.u > 1.02) continue;
      if (hit.t > extTol || hit.t < -extTol) continue;
      if (Math.abs(hit.t) < Math.abs(bestT)) bestT = hit.t;
    }
    if (Number.isFinite(bestT)) S[e.i][e.k] = add(p, mul(d, bestT));
  }
  return S.filter((s) => segLen(s) > tiny);
}

// Cut back line ends that run a little past their last crossing (detected lines overshoot
// into corner blobs by up to about half a strap). All trims use the original geometry.
export function trimOvershoots(segs, { trimTol }) {
  const cuts = segs.map((s) => {
    const r = sub(s.b, s.a), L = Math.hypot(r.x, r.y);
    if (L < EPS) return [0, 1];
    let lo = 0, hi = 1;
    const ts = [];
    for (const o of segs) {
      if (o === s) continue;
      const hit = lineIntersect(s.a, r, o.a, sub(o.b, o.a));
      if (!hit || hit.u < -1e-6 || hit.u > 1 + 1e-6 || hit.t < 0 || hit.t > 1) continue;
      ts.push(hit.t);
    }
    if (!ts.length) return [0, 1];
    const first = Math.min(...ts), last = Math.max(...ts);
    if (first * L < trimTol) lo = first;
    if ((1 - last) * L < trimTol) hi = last;
    return hi - lo > EPS ? [lo, hi] : [0, 1];
  });
  return segs.map((s, i) => {
    const r = sub(s.b, s.a), [lo, hi] = cuts[i];
    return { ...s, a: add(s.a, mul(r, lo)), b: add(s.a, mul(r, hi)) };
  });
}

// Split at all intersections, weld nearby points, prune short dangling spurs.
export function planarize(segs, { weldTol = 1, spurLen = 4 } = {}) {
  const cuts = segs.map(() => [0, 1]);
  const box = segs.map((s) => [Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.max(s.a.x, s.b.x), Math.max(s.a.y, s.b.y)]);
  // uniform grid broad-phase
  const cell = Math.max(8, weldTol * 8);
  const grid = new Map();
  segs.forEach((s, i) => {
    const b = box[i];
    for (let gx = Math.floor((b[0] - weldTol) / cell); gx <= Math.floor((b[2] + weldTol) / cell); gx++)
      for (let gy = Math.floor((b[1] - weldTol) / cell); gy <= Math.floor((b[3] + weldTol) / cell); gy++) {
        const k = gx + ',' + gy;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
  });
  const tested = new Set();
  for (const list of grid.values())
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        const i = list[x], j = list[y];
        const key = i < j ? i * 1e6 + j : j * 1e6 + i;
        if (tested.has(key)) continue;
        tested.add(key);
        const s = segs[i], t = segs[j];
        const r = sub(s.b, s.a), q = sub(t.b, t.a);
        const hit = lineIntersect(s.a, r, t.a, q);
        const li = Math.hypot(r.x, r.y), lj = Math.hypot(q.x, q.y);
        if (hit) {
          const ti = weldTol / li, tj = weldTol / lj;
          if (hit.t >= -ti && hit.t <= 1 + ti && hit.u >= -tj && hit.u <= 1 + tj) {
            cuts[i].push(Math.max(0, Math.min(1, hit.t)));
            cuts[j].push(Math.max(0, Math.min(1, hit.u)));
          }
        }
        // endpoints touching the other segment's interior (covers parallel overlaps too)
        for (const [a, b, c, k] of [[s, t, cuts[j], lj], [t, s, cuts[i], li]]) {
          const ab = sub(b.b, b.a);
          for (const p of [a.a, a.b]) {
            if (pointSegDist(p, b.a, b.b) < weldTol) c.push(Math.max(0, Math.min(1, dot(sub(p, b.a), ab) / (k * k))));
          }
        }
      }
  // weld points
  const pts = [], pgrid = new Map();
  const nodeOf = (p) => {
    const gx = Math.floor(p.x / weldTol), gy = Math.floor(p.y / weldTol);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const l = pgrid.get(gx + dx + ',' + (gy + dy));
        if (!l) continue;
        for (const id of l) if (dist(pts[id], p) <= weldTol) return id;
      }
    const id = pts.length;
    pts.push({ x: p.x, y: p.y });
    const k = gx + ',' + gy;
    if (!pgrid.has(k)) pgrid.set(k, []);
    pgrid.get(k).push(id);
    return id;
  };
  const edges = new Map();
  segs.forEach((s, i) => {
    const ts = [...new Set(cuts[i].map((t) => Math.round(t * 1e6) / 1e6))].sort((a, b) => a - b);
    const r = sub(s.b, s.a);
    let prev = nodeOf(s.a);
    for (let k = 1; k < ts.length; k++) {
      const id = nodeOf(add(s.a, mul(r, ts[k])));
      if (id !== prev) {
        const key = Math.min(id, prev) + ':' + Math.max(id, prev);
        edges.set(key, [Math.min(id, prev), Math.max(id, prev)]);
      }
      prev = id;
    }
  });
  let E = [...edges.values()];
  // prune spurs iteratively
  for (let iter = 0; iter < 20; iter++) {
    const deg = new Map();
    for (const [i, j] of E) { deg.set(i, (deg.get(i) || 0) + 1); deg.set(j, (deg.get(j) || 0) + 1); }
    const before = E.length;
    E = E.filter(([i, j]) => {
      const short = dist(pts[i], pts[j]) < spurLen;
      const dangling = deg.get(i) === 1 || deg.get(j) === 1;
      const isolated = deg.get(i) === 1 && deg.get(j) === 1;
      return !(short && (dangling || isolated));
    });
    if (E.length === before) break;
  }
  return compact(pts, E);
}

function compact(pts, E) {
  const map = new Map(), nodes = [];
  const id = (i) => { if (!map.has(i)) { map.set(i, nodes.length); nodes.push(pts[i]); } return map.get(i); };
  return { nodes, edges: E.map(([i, j]) => [id(i), id(j)]) };
}

// Remove isolated components whose total length is below minLen.
export function dropSmallComponents(graph, minLen) {
  const { nodes, edges } = graph;
  const parent = nodes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const [i, j] of edges) parent[find(i)] = find(j);
  const len = new Map();
  for (const [i, j] of edges) { const r = find(i); len.set(r, (len.get(r) || 0) + dist(nodes[i], nodes[j])); }
  return compact(nodes, edges.filter(([i]) => len.get(find(i)) >= minLen));
}

// Group edges into polylines through degree-2 nodes (for band offsetting and export).
export function chains(graph) {
  const { nodes, edges } = graph;
  const adj = nodes.map(() => []);
  edges.forEach(([i, j], k) => { adj[i].push({ k, to: j }); adj[j].push({ k, to: i }); });
  const used = new Uint8Array(edges.length);
  const out = [];
  const follow = (start, first) => {
    const path = [start];
    let cur = start, e = first;
    for (;;) {
      used[e.k] = 1;
      cur = e.to;
      path.push(cur);
      if (adj[cur].length !== 2) break;
      const next = adj[cur].find((x) => !used[x.k]);
      if (!next) break;
      e = next;
    }
    return path;
  };
  nodes.forEach((_, i) => {
    if (adj[i].length === 2) return;
    for (const e of adj[i]) if (!used[e.k]) out.push({ pts: follow(i, e).map((n) => nodes[n]), closed: false });
  });
  // pure loops
  edges.forEach((_, k) => {
    if (used[k]) return;
    const [i] = edges[k];
    const path = follow(i, adj[i].find((x) => x.k === k));
    out.push({ pts: path.map((n) => nodes[n]), closed: path[0] === path[path.length - 1] });
  });
  return out;
}

export function graphToSegments(graph) {
  return graph.edges.map(([i, j]) => ({ a: graph.nodes[i], b: graph.nodes[j], w: 1 }));
}

// Merge collinear consecutive edges so the output has as few segments as possible.
export function simplifyGraph(graph, angTol = 0.01) {
  const segs = [];
  for (const c of chains(graph)) {
    const simplified = [c.pts[0]];
    for (let i = 1; i < c.pts.length - 1; i++) {
      const a = simplified[simplified.length - 1], b = c.pts[i], d = c.pts[i + 1];
      const u = sub(b, a), v = sub(d, b);
      const ang = Math.abs(Math.atan2(cross(u, v), dot(u, v)));
      if (ang > angTol) simplified.push(b);
    }
    simplified.push(c.pts[c.pts.length - 1]);
    for (let i = 0; i + 1 < simplified.length; i++) segs.push({ a: simplified[i], b: simplified[i + 1], w: 1 });
  }
  return segs;
}
