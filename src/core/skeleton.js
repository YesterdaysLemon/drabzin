// Thin a binary mask to 1px centrelines and trace them into polylines.

export function thin(mask) {
  const { w, h } = mask;
  // Pad by one pixel so the neighbourhood lookups never leave the array.
  const W = w + 2, H = h + 2;
  const img = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img[(y + 1) * W + x + 1] = mask.data[y * w + x];
  const del = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 1; y < H - 1; y++)
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (!img[i]) continue;
          const p2 = img[i - W], p3 = img[i - W + 1], p4 = img[i + 1], p5 = img[i + W + 1];
          const p6 = img[i + W], p7 = img[i + W - 1], p8 = img[i - 1], p9 = img[i - W - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const a = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (a !== 1) continue;
          if (pass === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
          del.push(i);
        }
      if (del.length) changed = true;
      for (const i of del) img[i] = 0;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = img[(y + 1) * W + x + 1];
  // Remove redundant staircase pixels (keeps 8-connectivity, avoids fake junctions).
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!out[i]) continue;
      const n = out[i - w], s = out[i + w], e = out[i + 1], wv = out[i - 1];
      if ((n && e && !out[i + w - 1]) || (e && s && !out[i - w - 1]) || (s && wv && !out[i - w + 1]) || (wv && n && !out[i + w + 1])) {
        const cnt = n + s + e + wv + out[i - w - 1] + out[i - w + 1] + out[i + w - 1] + out[i + w + 1];
        if (cnt === 2) out[i] = 0;
      }
    }
  return { w, h, data: out };
}

const NB = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

// Returns polylines (arrays of {x,y} in pixel-centre coordinates).
export function tracePolylines(skel) {
  const { w, h, data } = skel;
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? data[y * w + x] : 0);
  const deg = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      let c = 0;
      for (const [dx, dy] of NB) c += at(x + dx, y + dy);
      deg[y * w + x] = c;
    }
  const isNode = (i) => data[i] && deg[i] !== 2;
  // Cluster adjacent junction pixels into a single node.
  const cluster = new Int32Array(w * h).fill(-1);
  const centres = [];
  for (let i = 0; i < data.length; i++) {
    if (!isNode(i) || cluster[i] >= 0) continue;
    const id = centres.length, stack = [i];
    let sx = 0, sy = 0, n = 0;
    cluster[i] = id;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p - x) / w;
      sx += x; sy += y; n++;
      if (deg[p] < 3) continue; // endpoints do not merge with neighbours
      for (const [dx, dy] of NB) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (isNode(q) && deg[q] >= 3 && cluster[q] < 0) { cluster[q] = id; stack.push(q); }
      }
    }
    centres.push({ x: sx / n + 0.5, y: sy / n + 0.5 });
  }
  const visited = new Uint8Array(w * h);
  const lines = [];
  const seenPairs = new Set();
  const walk = (startNode, from, first) => {
    const pts = [centres[startNode]];
    let prev = from, cur = first;
    for (;;) {
      if (cluster[cur] >= 0) {
        pts.push(centres[cluster[cur]]);
        pts.end = cluster[cur];
        return pts;
      }
      visited[cur] = 1;
      const x = cur % w, y = (cur - x) / w;
      pts.push({ x: x + 0.5, y: y + 0.5 });
      let next = -1;
      // Prefer an unvisited path pixel, otherwise a node pixel we have not just come from.
      for (const [dx, dy] of NB) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (!data[q] || q === prev || visited[q]) continue;
        if (cluster[q] >= 0 && cluster[q] === cluster[prev] && pts.length <= 2) continue;
        next = q;
        if (cluster[q] < 0) break;
      }
      if (next < 0) { pts.end = -1; return pts; }
      prev = cur; cur = next;
    }
  };
  for (let i = 0; i < data.length; i++) {
    if (cluster[i] < 0) continue;
    const x = i % w, y = (i - x) / w;
    for (const [dx, dy] of NB) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const q = yy * w + xx;
      if (!data[q] || visited[q]) continue;
      if (cluster[q] >= 0) {
        if (cluster[q] === cluster[i]) continue;
        const key = Math.min(cluster[q], cluster[i]) + ':' + Math.max(cluster[q], cluster[i]);
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        lines.push({ pts: [centres[cluster[i]], centres[cluster[q]]], n0: cluster[i], n1: cluster[q] });
        continue;
      }
      const pts = walk(cluster[i], i, q);
      lines.push({ pts, n0: cluster[i], n1: pts.end });
    }
  }
  // Closed loops with no junctions.
  for (let i = 0; i < data.length; i++) {
    if (!data[i] || visited[i] || cluster[i] >= 0) continue;
    const pts = [];
    let prev = -1, cur = i;
    while (cur >= 0 && !visited[cur]) {
      visited[cur] = 1;
      const x = cur % w, y = (cur - x) / w;
      pts.push({ x: x + 0.5, y: y + 0.5 });
      let next = -1;
      for (const [dx, dy] of NB) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (data[q] && q !== prev && !visited[q]) { next = q; break; }
      }
      prev = cur; cur = next;
    }
    if (pts.length > 2) { pts.push(pts[0]); lines.push({ pts, n0: -1, n1: -1 }); }
  }
  return lines;
}

const plen = (pts) => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return s;
};

// Remove short dead-end branches (edge noise grows these) and rejoin lines through
// nodes left with two branches. Returns plain arrays of points.
export function pruneBranches(lines, minLen) {
  let L = lines.filter((l) => l.pts.length >= 2);
  for (let iter = 0; iter < 10; iter++) {
    const deg = new Map();
    for (const l of L) for (const n of [l.n0, l.n1]) if (n >= 0) deg.set(n, (deg.get(n) || 0) + 1);
    const before = L.length;
    L = L.filter((l) => {
      if (l.n0 < 0 && l.n1 < 0) return plen(l.pts) >= minLen; // loops / isolated bits
      const dead = (l.n0 < 0 || deg.get(l.n0) === 1) || (l.n1 < 0 || deg.get(l.n1) === 1);
      const bothDead = (l.n0 < 0 || deg.get(l.n0) === 1) && (l.n1 < 0 || deg.get(l.n1) === 1);
      // a dead-end branch hanging off a junction is a spur; an isolated short line is a speck
      return !(dead && plen(l.pts) < minLen) || (bothDead && plen(l.pts) >= minLen);
    });
    if (L.length === before) break;
  }
  // Join through degree-2 nodes.
  const byNode = new Map();
  L.forEach((l, i) => { for (const n of [l.n0, l.n1]) if (n >= 0) { if (!byNode.has(n)) byNode.set(n, []); byNode.get(n).push(i); } });
  const used = new Uint8Array(L.length);
  const out = [];
  const extend = (pts, node, from) => {
    for (;;) {
      const list = byNode.get(node);
      if (!list || list.length !== 2) return;
      const k = list[0] === from ? list[1] : list[0];
      if (used[k] || k === from) return;
      used[k] = 1;
      const l = L[k];
      const seq = l.n0 === node ? l.pts : l.pts.slice().reverse();
      for (let i = 1; i < seq.length; i++) pts.push(seq[i]);
      node = l.n0 === node ? l.n1 : l.n0;
      from = k;
    }
  };
  L.forEach((l, i) => {
    if (used[i]) return;
    used[i] = 1;
    const fwd = l.pts.slice();
    extend(fwd, l.n1, i);
    const back = [fwd[0]];
    extend(back, l.n0, i);
    out.push(back.slice(1).reverse().concat(fwd));
  });
  return out;
}
