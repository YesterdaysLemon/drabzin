// Outline mode: trace the boundary of every solid region as a smooth closed curve.
// Sub-pixel marching squares on a lightly blurred ink field, then corner-preserving
// smoothing, then simplification.

// Marching squares at `level`. The field is padded with 0 so every contour closes.
// Loops are oriented with ink on the left (outer boundaries CCW in y-down coordinates
// come out with negative shoelace area; see `signedArea`).
export function marchingSquares(field, level = 0.5) {
  const { w, h, data } = field;
  const W = w + 2, H = h + 2;
  const v = (x, y) => (x < 1 || y < 1 || x > w || y > h ? 0 : data[(y - 1) * w + (x - 1)]);
  // Edge ids: horizontal edge (x,y)-(x+1,y) -> 2*(y*W+x); vertical (x,y)-(x,y+1) -> 2*(y*W+x)+1
  const pt = new Map();
  const point = (id) => {
    let p = pt.get(id);
    if (p) return p;
    const base = id >> 1, x = base % W, y = (base - x) / W;
    const a = v(x, y), b = (id & 1) ? v(x, y + 1) : v(x + 1, y);
    const t = Math.abs(b - a) < 1e-9 ? 0.5 : (level - a) / (b - a);
    // -1 removes the padding; +0.5 puts samples at pixel centres
    p = (id & 1) ? { x: x - 1 + 0.5, y: y - 1 + 0.5 + t } : { x: x - 1 + 0.5 + t, y: y - 1 + 0.5 };
    pt.set(id, p);
    return p;
  };
  const next = new Map(); // edge id -> edge id (directed, ink on the left)
  const link = (a, b) => next.set(a, b);
  for (let y = 0; y < H - 1; y++)
    for (let x = 0; x < W - 1; x++) {
      const tl = v(x, y) >= level, tr = v(x + 1, y) >= level, br = v(x + 1, y + 1) >= level, bl = v(x, y + 1) >= level;
      const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const top = 2 * (y * W + x), bottom = 2 * ((y + 1) * W + x), left = 2 * (y * W + x) + 1, right = 2 * (y * W + x + 1) + 1;
      switch (code) {
        case 1: link(bottom, left); break;
        case 2: link(right, bottom); break;
        case 3: link(right, left); break;
        case 4: link(top, right); break;
        case 6: link(top, bottom); break;
        case 7: link(top, left); break;
        case 8: link(left, top); break;
        case 9: link(bottom, top); break;
        case 11: link(right, top); break;
        case 12: link(left, right); break;
        case 13: link(bottom, right); break;
        case 14: link(left, bottom); break;
        case 5: case 10: {
          // saddle: decide by the centre value
          const c = (v(x, y) + v(x + 1, y) + v(x + 1, y + 1) + v(x, y + 1)) / 4 >= level;
          if (code === 5) { if (c) { link(top, left); link(bottom, right); } else { link(bottom, left); link(top, right); } }
          else { if (c) { link(left, bottom); link(right, top); } else { link(left, top); link(right, bottom); } }
          break;
        }
      }
    }
  const loops = [];
  const seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let e = start;
    while (e !== undefined && !seen.has(e)) {
      seen.add(e);
      loop.push(point(e));
      e = next.get(e);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

export function perimeter(pts, closed = true) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (closed && pts.length > 1) s += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  return s;
}

export function signedArea(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j].x * pts[i].y - pts[i].x * pts[j].y);
  return s / 2;
}

function resampleClosed(pts, spacing) {
  const out = [];
  const n = pts.length;
  let carry = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    let t = carry;
    while (t < L) { out.push({ x: a.x + ((b.x - a.x) * t) / L, y: a.y + ((b.y - a.y) * t) / L }); t += spacing; }
    carry = t - L;
  }
  return out.length >= 3 ? out : pts.slice();
}

// Turning angle at each point measured over +-k samples.
function turning(pts, k) {
  const n = pts.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[(i - k + n) % n], b = pts[i], c = pts[(i + k) % n];
    const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
    out[i] = Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
  }
  return out;
}

// Smooth a closed loop but keep sharp corners where they are.
export function smoothClosed(pts, { sigma = 1.5, cornerDeg = 55, spacing = 0.75 } = {}) {
  const P = resampleClosed(pts, spacing);
  const n = P.length;
  if (n < 8) return { pts: P, corners: [] };
  const k = Math.max(2, Math.round((2.5 * sigma) / spacing));
  const turn = turning(P, k);
  const thr = (cornerDeg * Math.PI) / 180;
  const isCorner = new Uint8Array(n);
  const corners = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] < thr) continue;
    let max = true;
    for (let d = -k; d <= k; d++) if (d && turn[(i + d + n) % n] > turn[i]) { max = false; break; }
    if (max) { isCorner[i] = 1; corners.push(i); }
  }
  const r = Math.max(1, Math.round((3 * sigma) / spacing));
  const wts = [];
  for (let d = 0; d <= r; d++) wts.push(Math.exp(-((d * spacing) ** 2) / (2 * sigma * sigma)));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    if (isCorner[i]) { out[i] = P[i]; continue; }
    let sx = P[i].x * wts[0], sy = P[i].y * wts[0], sw = wts[0];
    // walk each way until the window ends or a corner is hit (corner itself included)
    for (const dir of [1, -1]) {
      for (let d = 1; d <= r; d++) {
        const j = (i + dir * d + n * 4) % n;
        sx += P[j].x * wts[d]; sy += P[j].y * wts[d]; sw += wts[d];
        if (isCorner[j]) {
          // mirror the remaining weight onto the corner so it pulls like a pinned end
          let rest = 0;
          for (let e = d + 1; e <= r; e++) rest += wts[e];
          sx += P[j].x * rest; sy += P[j].y * rest; sw += rest;
          break;
        }
      }
    }
    out[i] = { x: sx / sw, y: sy / sw };
  }
  return { pts: out, corners };
}

function pointSegDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

// Douglas-Peucker on a closed loop, never removing listed corner indices.
export function simplifyClosed(pts, tol, keep = []) {
  const n = pts.length;
  if (n <= 4) return pts.slice();
  const anchors = [...new Set([0, ...keep, Math.floor(n / 2)])].sort((a, b) => a - b);
  const mark = new Uint8Array(n);
  for (const a of anchors) mark[a] = 1;
  for (let s = 0; s < anchors.length; s++) {
    const i0 = anchors[s], i1 = s + 1 < anchors.length ? anchors[s + 1] : anchors[0] + n;
    const stack = [[i0, i1]];
    while (stack.length) {
      const [i, j] = stack.pop();
      const a = pts[i % n], b = pts[j % n];
      let best = -1, bi = -1;
      for (let k = i + 1; k < j; k++) {
        const d = pointSegDist(pts[k % n], a, b);
        if (d > best) { best = d; bi = k; }
      }
      if (best > tol) { mark[bi % n] = 1; stack.push([i, bi], [bi, j]); }
    }
  }
  return pts.filter((_, i) => mark[i]);
}

/**
 * Trace outlines. field: ink 0..1. Returns { paths, pieces, holes } in pixel units.
 *   paths: [{ pts, closed: true, kind: 'outer' | 'hole', area }]
 */
export function traceOutlines(field, { level = 0.5, minArea = 4, minHoleArea = minArea, minHoleWidth = 0, sigma = 1.2, cornerDeg = 55, tol = 0.2 } = {}) {
  const loops = marchingSquares(field, level);
  const paths = [];
  for (const loop of loops) {
    const a = signedArea(loop);
    if (Math.abs(a) < (a < 0 ? minArea : minHoleArea)) continue;
    // Slivers (shading highlights, JPEG ringing) are holes far too narrow to cut: their
    // mean width 2A/P is tiny compared with their length.
    if (a > 0 && minHoleWidth > 0 && (2 * a) / perimeter(loop) < minHoleWidth / 2) continue;
    const { pts, corners } = smoothClosed(loop, { sigma, cornerDeg });
    const simple = simplifyClosed(pts, tol, corners);
    if (simple.length < 3) continue;
    // With ink on the left of travel and y pointing down, an outer boundary has negative area.
    paths.push({ pts: simple, closed: true, kind: a < 0 ? 'outer' : 'hole', area: Math.abs(a) });
  }
  return {
    paths,
    pieces: paths.filter((p) => p.kind === 'outer').length,
    holes: paths.filter((p) => p.kind === 'hole').length,
  };
}

// Smooth an open polyline with pinned ends (and pinned sharp corners).
export function smoothOpen(pts, { sigma = 1.5, cornerDeg = 55, spacing = 0.75 } = {}) {
  // resample
  const P = [pts[0]];
  let carry = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], L = Math.hypot(b.x - a.x, b.y - a.y);
    let t = spacing - carry;
    while (t < L) { P.push({ x: a.x + ((b.x - a.x) * t) / L, y: a.y + ((b.y - a.y) * t) / L }); t += spacing; }
    carry = L - (t - spacing);
  }
  P.push(pts[pts.length - 1]);
  const n = P.length;
  if (n < 5) return { pts: P, corners: [0, n - 1] };
  const k = Math.max(2, Math.round((2.5 * sigma) / spacing));
  const thr = (cornerDeg * Math.PI) / 180;
  const turn = new Float32Array(n);
  for (let i = k; i < n - k; i++) {
    const a = P[i - k], b = P[i], c = P[i + k];
    const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
    turn[i] = Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
  }
  const pinned = new Uint8Array(n);
  pinned[0] = pinned[n - 1] = 1;
  const corners = [0];
  for (let i = k; i < n - k; i++) {
    if (turn[i] < thr) continue;
    let max = true;
    for (let d = -k; d <= k; d++) if (d && turn[i + d] > turn[i]) { max = false; break; }
    if (max) { pinned[i] = 1; corners.push(i); }
  }
  corners.push(n - 1);
  const r = Math.max(1, Math.round((3 * sigma) / spacing));
  const wts = [];
  for (let d = 0; d <= r; d++) wts.push(Math.exp(-((d * spacing) ** 2) / (2 * sigma * sigma)));
  const out = P.map((p, i) => {
    if (pinned[i]) return p;
    let sx = p.x * wts[0], sy = p.y * wts[0], sw = wts[0];
    for (const dir of [1, -1]) {
      for (let d = 1; d <= r; d++) {
        const j = i + dir * d;
        if (j < 0 || j >= n) break;
        sx += P[j].x * wts[d]; sy += P[j].y * wts[d]; sw += wts[d];
        if (pinned[j]) {
          let rest = 0;
          for (let e = d + 1; e <= r; e++) rest += wts[e];
          sx += P[j].x * rest; sy += P[j].y * rest; sw += rest;
          break;
        }
      }
    }
    return { x: sx / sw, y: sy / sw };
  });
  return { pts: out, corners };
}

export function simplifyOpen(pts, tol, keep = []) {
  const n = pts.length;
  if (n <= 2) return pts.slice();
  const anchors = [...new Set([0, ...keep, n - 1])].sort((a, b) => a - b);
  const mark = new Uint8Array(n);
  for (const a of anchors) mark[a] = 1;
  for (let s = 0; s + 1 < anchors.length; s++) {
    const stack = [[anchors[s], anchors[s + 1]]];
    while (stack.length) {
      const [i, j] = stack.pop();
      let best = -1, bi = -1;
      for (let k = i + 1; k < j; k++) {
        const d = pointSegDist(pts[k], pts[i], pts[j]);
        if (d > best) { best = d; bi = k; }
      }
      if (best > tol) { mark[bi] = 1; stack.push([i, bi], [bi, j]); }
    }
  }
  return pts.filter((_, i) => mark[i]);
}

// Join open paths end-to-end where exactly two ends meet (within `tol`), optionally
// bridging free ends that are within `gap` of each other. Paths that come back to
// their own start become closed. Points are { x, y }.
export function joinPaths(paths, { tol = 1.5, gap = 0 } = {}) {
  let P = paths.map((p) => ({ ...p, pts: p.pts.slice() }));
  const open = () => P.filter((p) => !p.closed);
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  // 1) bridge gaps between mutually nearest free ends
  if (gap > 0) {
    const ends = [];
    for (const p of open()) { ends.push({ p, at: 0 }); ends.push({ p, at: 1 }); }
    const pt = (e) => (e.at ? e.p.pts[e.p.pts.length - 1] : e.p.pts[0]);
    const free = ends.filter((e) => !ends.some((f) => f !== e && d(pt(e), pt(f)) <= tol));
    const nearest = (e) => {
      let best = null, bd = gap;
      for (const f of free) {
        if (f === e || (f.p === e.p && e.p.pts.length < 4)) continue;
        const dd = d(pt(e), pt(f));
        if (dd <= bd) { bd = dd; best = f; }
      }
      return best;
    };
    const done = new Set();
    for (const e of free) {
      if (done.has(e)) continue;
      const f = nearest(e);
      if (!f || done.has(f) || nearest(f) !== e) continue;
      // move both ends to their midpoint so they join in step 2
      const m = { x: (pt(e).x + pt(f).x) / 2, y: (pt(e).y + pt(f).y) / 2 };
      for (const g of [e, f]) { if (g.at) g.p.pts.push(m); else g.p.pts.unshift(m); }
      done.add(e); done.add(f);
    }
  }
  // 2) chain through points where exactly two ends meet
  for (let changed = true; changed;) {
    changed = false;
    const O = open();
    outer: for (let i = 0; i < O.length; i++) {
      const a = O[i];
      for (const atA of [1, 0]) {
        const pa = atA ? a.pts[a.pts.length - 1] : a.pts[0];
        const touching = [];
        for (const b of O) for (const atB of [0, 1]) {
          if (b === a && atB === atA) continue;
          const pb = atB ? b.pts[b.pts.length - 1] : b.pts[0];
          if (d(pa, pb) <= tol) touching.push({ b, atB });
        }
        if (touching.length !== 1) continue;
        const { b, atB } = touching[0];
        if (b === a) { a.closed = true; a.pts.pop(); changed = true; break outer; }
        const A = atA ? a.pts : a.pts.slice().reverse();
        const B = atB ? b.pts.slice().reverse() : b.pts;
        a.pts = A.concat(B.slice(1));
        P = P.filter((q) => q !== b);
        changed = true;
        break outer;
      }
    }
  }
  return P;
}
