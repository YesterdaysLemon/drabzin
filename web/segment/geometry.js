// Pure helpers that turn a segmentation mask into shapes the app can use: a bounding box and
// the four corners of the quadrilateral that best fits the object (a panel, a sheet of paper,
// possibly photographed at an angle). No browser or model code in here, so it runs in Node tests.
//
// A mask is a Uint8Array of w * h, 1 = object, row by row. Coordinates are in picture pixels
// and sit on pixel edges: a mask that covers the whole picture has its corners at (0,0), (w,0),
// (w,h) and (0,h).

const EPS = 1e-9;

// ---- cleaning ----

// Removes small stray blobs (a logo in the corner, a speck on the table) and keeps the object.
// Works on a coarse grid so it stays fast on photographs of many megapixels: a grid cell is
// "on" if any of its pixels is on, cells join through their 8 neighbours, and every blob smaller
// than `minShare` of the biggest one is dropped. Returns a new mask (or the same one if
// nothing had to go) and the number of pixels kept.
export function cleanMask(mask, w, h, { minShare = 0.05 } = {}) {
  const cell = Math.max(1, Math.ceil(Math.max(w, h) / 384));
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const grid = new Int32Array(gw * gh);              // pixels on, per cell
  for (let y = 0; y < h; y++) {
    const row = y * w, g = Math.floor(y / cell) * gw;
    for (let x = 0; x < w; x++) if (mask[row + x]) grid[g + Math.floor(x / cell)]++;
  }
  const label = new Int32Array(gw * gh);              // 0 = off, else blob number
  const sizes = [0];                                  // pixels per blob
  const stack = [];
  for (let s = 0; s < grid.length; s++) {
    if (!grid[s] || label[s]) continue;
    const id = sizes.length;
    let total = 0;
    label[s] = id; stack.push(s);
    while (stack.length) {
      const c = stack.pop();
      total += grid[c];
      const cx = c % gw, cy = (c - cx) / gw;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= gh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= gw) continue;
          const n = ny * gw + nx;
          if (grid[n] && !label[n]) { label[n] = id; stack.push(n); }
        }
      }
    }
    sizes.push(total);
  }
  const biggest = Math.max(0, ...sizes);
  const keep = sizes.map((n) => n > 0 && n >= biggest * minShare);
  let dropped = 0;
  for (let i = 1; i < sizes.length; i++) if (!keep[i]) dropped++;
  const kept = sizes.reduce((a, n, i) => a + (keep[i] ? n : 0), 0);
  if (!dropped) return { mask, kept };
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w, g = Math.floor(y / cell) * gw;
    for (let x = 0; x < w; x++) if (mask[row + x] && keep[label[g + Math.floor(x / cell)]]) out[row + x] = 1;
  }
  return { mask: out, kept };
}

// ---- box ----

// The smallest box around the object: { x, y, w, h } in whole pixels (x, y is the top-left
// pixel), or null when the mask is empty. Stray blobs are ignored unless clean is false.
export function maskBox(mask, w, h, { clean = true } = {}) {
  const m = clean ? cleanMask(mask, w, h).mask : mask;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let l = 0;
    while (l < w && !m[row + l]) l++;
    if (l === w) continue;
    let r = w - 1;
    while (!m[row + r]) r--;
    if (l < x0) x0 = l;
    if (r > x1) x1 = r;
    if (y < y0) y0 = y;
    y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---- hull ----

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

// Convex hull of [x, y] points (Andrew's monotone chain), counter-clockwise on a y-up page,
// i.e. clockwise on the screen. Without repeated end point.
export function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const n = p.length;
  if (n < 3) return p;
  const out = [];
  for (let i = 0; i < n; i++) {
    while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p[i]) <= 0) out.pop();
    out.push(p[i]);
  }
  const lower = out.length + 1;
  for (let i = n - 2; i >= 0; i--) {
    while (out.length >= lower && cross(out[out.length - 2], out[out.length - 1], p[i]) <= 0) out.pop();
    out.push(p[i]);
  }
  out.pop();
  return out;
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

// Hull of every pixel of the mask, on pixel edges. Only the left-most and right-most pixel of
// each row can be on the hull.
export function maskHull(mask, w, h) {
  const pts = [];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let l = 0;
    while (l < w && !mask[row + l]) l++;
    if (l === w) continue;
    let r = w - 1;
    while (!mask[row + r]) r--;
    pts.push([l, y], [l, y + 1], [r + 1, y], [r + 1, y + 1]);
  }
  return convexHull(pts);
}

// ---- lines ----

// A line is { x, y, dx, dy }: a point and a unit direction.
const lineThrough = (a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
  return { x: a[0], y: a[1], dx: dx / len, dy: dy / len };
};

function intersect(a, b) {
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < EPS) return null;
  const t = ((b.x - a.x) * b.dy - (b.y - a.y) * b.dx) / den;
  return [a.x + a.dx * t, a.y + a.dy * t];
}

// Straight line through points by total least squares.
function fitLine(pts) {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= pts.length; cy /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { const dx = p[0] - cx, dy = p[1] - cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { x: cx, y: cy, dx: Math.cos(th), dy: Math.sin(th) };
}

// ---- quadrilateral ----

// Shrinks a convex polygon to four sides by repeatedly dropping the side whose removal adds the
// least area: its two neighbours are extended until they meet. The result touches the polygon
// on all four sides and contains all of it.
export function polygonToQuad(poly) {
  let P = poly.map((p) => p.slice());
  if (P.length < 4) return null;
  while (P.length > 4) {
    const n = P.length;
    let best = -1, bestArea = Infinity, bestPoint = null;
    for (let i = 0; i < n; i++) {
      // Side i runs from P[i] to P[i + 1]; its neighbours are P[i - 1] -> P[i] and P[i + 1] -> P[i + 2].
      const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n], d = P[(i + 2) % n];
      const X = intersect(lineThrough(a, b), lineThrough(c, d));
      if (!X) continue;
      // The neighbours must meet beyond the side (on its outer side), not behind it.
      const ahead = (X[0] - b[0]) * (b[0] - a[0]) + (X[1] - b[1]) * (b[1] - a[1]);
      const back = (X[0] - c[0]) * (c[0] - d[0]) + (X[1] - c[1]) * (c[1] - d[1]);
      if (ahead < 0 || back < 0) continue;
      const area = Math.abs(cross(b, X, c)) / 2;
      if (area < bestArea) { bestArea = area; best = i; bestPoint = X; }
    }
    if (best < 0) return null;
    const next = [];
    for (let k = 0; k < n; k++) {
      if (k === best) next.push(bestPoint);
      else if (k !== (best + 1) % n) next.push(P[k]);
    }
    P = next;
  }
  return P;
}

// Points along the polygon's outline, about `step` pixels apart.
function sampleOutline(poly, step) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}

// Lets each side of the quadrilateral settle on the outline points that run along it, so one
// stray bump does not drag a whole side out. The outline points within `tol` of a side (and
// away from its corners) are fitted with a straight line, twice, and the corners are where the
// new lines meet.
function refineQuad(quad, outline, tol) {
  let Q = quad;
  const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
  const reach = 0.15 * Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  for (let pass = 0; pass < 2; pass++) {
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const a = Q[i], b = Q[(i + 1) % 4], L = lineThrough(a, b);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const near = [];
      for (const p of outline) {
        const rx = p[0] - a[0], ry = p[1] - a[1];
        const along = rx * L.dx + ry * L.dy;
        if (along < len * 0.06 || along > len * 0.94) continue;
        if (Math.abs(rx * L.dy - ry * L.dx) <= tol / (pass + 1)) near.push(p);
      }
      lines.push(near.length >= 8 ? fitLine(near) : L);
    }
    const next = [];
    for (let i = 0; i < 4; i++) {
      const X = intersect(lines[(i + 3) % 4], lines[i]);
      // A corner that jumped far from where it was means the fit went wrong: keep the old quad.
      if (!X || Math.hypot(X[0] - Q[i][0], X[1] - Q[i][1]) > reach) return Q;
      next.push(X);
    }
    Q = next;
  }
  return Q;
}

// Four corners ordered clockwise from the top-left (the corner closest to the picture's
// top-left comes first), as [{ x, y }, ...].
export function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const sorted = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let first = 0;
  sorted.forEach((p, i) => { if (p[0] + p[1] < sorted[first][0] + sorted[first][1]) first = i; });
  return sorted.map((_, i) => sorted[(first + i) % sorted.length]).map(([x, y]) => ({ x, y }));
}

// The smallest rectangle around a convex polygon, as four [x, y] corners. The picture-aligned
// rectangle wins unless a tilted one is clearly (over 4%) smaller, so a round object gets an
// upright box instead of an arbitrary tilt.
export function minAreaRect(poly) {
  const rect = (ux, uy) => {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of poly) {
      const u = x * ux + y * uy, v = -x * uy + y * ux;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const at = (u, v) => [u * ux - v * uy, u * uy + v * ux];
    return { area: (u1 - u0) * (v1 - v0), corners: [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)] };
  };
  const upright = rect(1, 0);
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < EPS) continue;
    const r = rect((b[0] - a[0]) / len, (b[1] - a[1]) / len);
    if (!best || r.area < best.area) best = r;
  }
  return best && best.area < upright.area * 0.96 ? best.corners : upright.corners;
}

// How close to a four-sided shape the object has to be for its own four sides to be used.
// Below this (a circle is 0.785, a hexagon 0.87) the fit falls back to a plain rectangle.
export const QUAD_MIN_FIT = 0.9;

// The quadrilateral that best fits the object, for placing the four crop corners.
//   corners   [{ x, y } x 4], clockwise from the top-left
//   kind      'quad': the object is four-sided (a panel or sheet, possibly photographed at an
//             angle) and the corners follow its edges and perspective; 'box': it is not (a
//             round plate), so the corners are the smallest rectangle around it
//   fit       0..1, the object's area over the corners' area
// Returns null for an empty or sliver-thin mask. Options: clamp (default true) keeps the
// corners inside the picture; clean (default true) ignores stray blobs.
export function fitQuad(mask, w, h, { clamp = true, clean = true } = {}) {
  const m = clean ? cleanMask(mask, w, h).mask : mask;
  const hull = maskHull(m, w, h);
  if (hull.length < 3) return null;
  const hullArea = Math.abs(polygonArea(hull));
  if (hullArea < 16) return null;
  let quad = polygonToQuad(hull), kind = 'quad';
  if (quad) quad = refineQuad(quad, sampleOutline(hull, 1), Math.sqrt(hullArea) * 0.02);
  if (!quad || hullArea / Math.abs(polygonArea(quad)) < QUAD_MIN_FIT) { quad = minAreaRect(hull); kind = 'box'; }
  let corners = orderCorners(quad);
  if (clamp) corners = corners.map(({ x, y }) => ({ x: Math.min(w, Math.max(0, x)), y: Math.min(h, Math.max(0, y)) }));
  const quadArea = Math.abs(polygonArea(corners.map((c) => [c.x, c.y])));
  return { corners, kind, hullArea, quadArea, fit: quadArea > 0 ? Math.min(1, hullArea / quadArea) : 0 };
}

export function maskToQuad(mask, w, h, opts) {
  return fitQuad(mask, w, h, opts)?.corners ?? null;
}
