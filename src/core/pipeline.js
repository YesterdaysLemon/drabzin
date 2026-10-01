// End-to-end pipeline, split into stages so the UI can re-run only what changed.
import * as R from './raster.js';
import { thin, tracePolylines, pruneBranches } from './skeleton.js';
import * as G from './geometry.js';
import { buildCutGeometry } from './bands.js';
import { findLines } from './lines.js';
import { fitPath, sampleSegs } from './fit.js';
import { traceOutlines, smoothOpen, simplifyOpen, smoothClosed, simplifyClosed, joinPaths, mendEnds, danglingEnds } from './contour.js';

export const DEFAULTS = {
  workSize: 1400,      // long side of the working image, px
  panelW: 1000,        // mm
  panelH: 2000,        // mm
  corners: null,       // [{x,y} x4] clockwise from top-left in source pixels, or null = whole image
  flatten: true,
  blur: 1.0,           // px
  autoSmooth: true,    // extra blur proportional to measured strap width
  lightLines: 'auto',  // 'auto' | true | false
  level: null,         // threshold 0..1, null = Otsu
  nx: 1, ny: 1,        // repeat grid
  order: 1,            // rotational symmetry about each tile centre
  mirror: false,
  center: null,        // rotation centre when there is a single tile (working px)
  symmetrizeRaster: true,
  snapDeg: null,       // null = auto-detect (90/45/30/22.5/18/15), 0 = off
  snapTolDeg: 6,
  strict: true,        // with snapping on, discard pieces that are not at an allowed angle
  lineSearch: true,    // with a known angle step, find whole lines instead of fitting pieces
  closeGaps: null,     // null = only when tracing (line search already bridges gaps)
  minCover: 0.25,
  bandWidth: null,     // mm, null = measured from the image
  pad: 0,              // mm of solid border added around the traced area
  frame: 40,           // mm solid border inside the panel edge
  toolDiameter: 6,     // mm (router bit / effective cutter width)
  minBridge: 8,        // mm thinnest allowed metal
};

export function rectify(src, p) {
  const long = Math.max(p.panelW, p.panelH);
  const outW = Math.round((p.workSize * p.panelW) / long), outH = Math.round((p.workSize * p.panelH) / long);
  const quad = p.corners ?? [{ x: 0, y: 0 }, { x: src.w, y: 0 }, { x: src.w, y: src.h }, { x: 0, y: src.h }];
  // Pre-shrink very large photos so sampling does not alias.
  const quadW = Math.max(G.dist(quad[0], quad[1]), G.dist(quad[3], quad[2]));
  const quadH = Math.max(G.dist(quad[0], quad[3]), G.dist(quad[1], quad[2]));
  const factor = Math.min(quadW / outW, quadH / outH);
  let img = src, q = quad;
  if (factor > 1.5) {
    img = R.resize(src, Math.max(src.w, src.h) / (factor / 1.2));
    const s = img.w / src.w;
    q = quad.map((c) => ({ x: c.x * s, y: c.y * s }));
  }
  const rect = R.warpQuad(img, q, outW, outH);
  return { img: rect, mmPerPx: p.panelW / outW };
}

export function clean(rect, p) {
  let img = rect.img;
  if (p.flatten) img = R.flattenLighting(img, Math.max(img.w, img.h) / 12);
  else img = R.normalize(img);
  img = R.gaussianBlur(img, p.blur);
  const lightLines = p.lightLines === 'auto' ? R.guessLightLines(img) : !!p.lightLines;
  if (lightLines) img = R.invert(img);
  const group = R.symmetryGroup({ w: img.w, h: img.h, nx: p.nx, ny: p.ny, order: p.order, mirror: p.mirror, center: p.center });
  const symmetric = p.nx * p.ny > 1 || p.order > 1 || p.mirror;
  if (symmetric && p.symmetrizeRaster) img = R.symmetrize(img, group);
  const minSpeck = Math.max(8, (img.w * img.h) / 40000);
  const binarize = (im) => R.fillHoles(R.removeSpecks(R.threshold(im, { level: p.level }), minSpeck), minSpeck);
  let mask = binarize(img);
  let stroke = R.strokeWidth(mask);
  // Smooth in proportion to the strap width: ragged edges grow skeleton spurs.
  const extra = stroke * 0.12;
  if (p.autoSmooth && extra > 1) {
    img = R.gaussianBlur(img, extra);
    mask = binarize(img);
    stroke = R.strokeWidth(mask);
  }
  const level = R.otsu(img);
  return { img, mask, group, lightLines, level, stroke, symmetric };
}

export function vectorize(cleaned, p) {
  const { mask, group, stroke } = cleaned;
  const W = mask.w, H = mask.h;
  const sw = Math.max(2, stroke || 4);
  const skel = thin(mask);
  const lines = pruneBranches(tracePolylines(skel), sw * 1.2);
  const dpTol = Math.max(1.5, Math.min(4, sw * 0.12));
  let segs = G.polylinesToSegments(lines, dpTol);
  const rawCount = segs.length;
  const order = Math.max(1, p.order);
  const candidates = [90, 45, 30, 22.5, 18, 15, ...(order > 2 ? [180 / order, 90 / order] : [])];
  const detected = G.detectAngleStep(segs.filter((s) => G.segLen(s) > sw * 1.5), candidates);
  const snapDeg = p.snapDeg ?? detected.deg;
  const snapStep = (snapDeg * Math.PI) / 180;
  // With many allowed angles (10-, 12-fold) a wide tolerance would accept almost anything.
  const snapTol = (Math.min(p.snapTolDeg, snapDeg > 0 ? snapDeg / 4 : p.snapTolDeg) * Math.PI) / 180;
  const useLineSearch = snapDeg > 0 && p.lineSearch;
  if (useLineSearch) segs = findLines(mask, { stepDeg: snapDeg, strokePx: sw });
  segs = G.snapAngles(segs, snapStep, snapTol);
  // Junction blobs skeletonize into short off-angle spurs; in a geometric design the real
  // lines are all at allowed angles, so drop the rest and let gap closing rejoin the lines.
  if (snapStep > 0 && p.strict) segs = segs.filter((s) => s.snapped);
  const rhoTol = Math.max(1.5, sw * 0.4), gapTol = Math.max(2, sw * 0.75);
  if (cleaned.symmetric) {
    segs = G.enforceSymmetry(segs, group, { W, H, rhoTol, gapTol, angTol: Math.max(snapTol / 2, 0.02), minCover: p.minCover });
  } else {
    segs = G.mergeCollinear(segs, { angTol: 0.02, rhoTol, gapTol });
  }
  segs = G.snapAngles(segs, snapStep, snapTol);
  // Pieces shorter than the strap is wide are almost always junction debris.
  if (snapStep > 0 && p.strict) segs = segs.filter((s) => G.segLen(s) >= sw * 0.9);
  if (p.closeGaps ?? !useLineSearch) segs = G.closeGaps(segs, { extTol: sw * 1.5 });
  segs = G.trimOvershoots(segs, { trimTol: sw * 0.9 });
  let graph = G.planarize(segs, { weldTol: Math.max(1, sw * 0.25), spurLen: sw * 1.2 });
  graph = G.dropSmallComponents(graph, sw * 4);
  const out = G.simplifyGraph(graph);
  graph = G.planarize(out, { weldTol: 0.5, spurLen: 0 });
  return { graph, segs: G.graphToSegments(graph), skel, rawCount, strokePx: sw, snapDeg, angleCoverage: detected.coverage, method: useLineSearch ? 'line-search' : 'trace' };
}

export function toMM(graph, mmPerPx) {
  return { nodes: graph.nodes.map((n) => ({ x: n.x * mmPerPx, y: n.y * mmPerPx })), edges: graph.edges };
}

export function cut(vec, rect, p) {
  const pad = p.pad || 0;
  const g = toMM(vec.graph, rect.mmPerPx);
  const graphMM = { nodes: g.nodes.map((n) => ({ x: n.x + pad, y: n.y + pad })), edges: g.edges };
  const panelW = p.panelW + 2 * pad, panelH = p.panelH + 2 * pad;
  const bandWidth = p.bandWidth ?? Math.round(vec.strokePx * rect.mmPerPx * 2) / 2;
  const geom = buildCutGeometry(graphMM, { panelW, panelH, bandWidth, frame: p.frame, toolDiameter: p.toolDiameter, minBridge: p.minBridge });
  return { ...geom, bandWidth, panelW, panelH, graphMM, centrelines: G.graphToSegments(graphMM) };
}

export function run(src, params = {}) {
  const p = { ...DEFAULTS, ...params };
  const rect = rectify(src, p);
  const cleaned = clean(rect, p);
  const vec = vectorize(cleaned, p);
  const result = cut(vec, rect, p);
  return { p, rect, cleaned, vec, result };
}

// ---------------------------------------------------------------------------------------
// Outline and centreline modes (filled shapes and line drawings).

export const SHAPE_DEFAULTS = {
  corners: null,       // crop quad in source px (clockwise from top-left), null = whole image
  maxSide: 2400,       // working resolution cap, px
  sizeMM: 1000,        // physical size of the crop...
  sizeAxis: 'width',   // ...measured along 'width' or 'height'
  invert: false,       // swap which side counts as material
  level: 0.4,          // ink threshold 0..1
  blur: 0.8,           // px, before thresholding
  smooth: 1.2,         // px, curve smoothing
  cornerDeg: 55,       // sharper turns than this stay sharp
  straight: false,     // outline: straight edges between corners (geometric/polygonal designs)
  speckMM2: null,      // ignore blobs smaller than this (mm^2), null = auto
  bridgeMM: null,      // centreline: join loose ends closer than this (mm), null = 3 strokes
  pickDesign: null,    // {x, y} in source px: a spot on the design, its colour is "material"
  pickBg: null,        // {x, y} in source px: a spot on the background
  adaptive: false,     // uneven light: divide out the light falling on the background
  mask: null,          // { w, h, data: Uint8Array 1 = object } over the source (any scale): ignore the rest
  arcs: true,          // curves as true arcs (lines + arcs, like CAD) instead of many short lines
  arcTolPx: 0.3,       // how far an arc or line may stray from the traced edge, px of the crop
};

// Lines and arcs through a traced path (px), in mm. `pts` is resampled from them for drawing,
// hit testing and areas; the exporters write `segs`.
function toSegs(dense, corners, closed, mmPerPx, p) {
  const mm = dense.map((v) => ({ x: v.x * mmPerPx, y: v.y * mmPerPx }));
  const tol = Math.max(0.02, p.arcTolPx * mmPerPx);
  const segs = fitPath(mm, { closed, tol, corners });
  return { segs, pts: sampleSegs(segs, Math.max(0.01, tol / 4), closed) };
}

export function prepareInk(rgba, w, h, p) {
  const quad = p.corners ?? [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const qw = Math.max(G.dist(quad[0], quad[1]), G.dist(quad[3], quad[2]));
  const qh = Math.max(G.dist(quad[0], quad[3]), G.dist(quad[1], quad[2]));
  const s = Math.min(1, p.maxSide / Math.max(qw, qh));
  const outW = Math.max(2, Math.round(qw * s)), outH = Math.max(2, Math.round(qh * s));
  const crop = R.warpQuadRGBA(rgba, w, h, quad, outW, outH);
  // Picked colours come from the full-size source, a few px square, so one noisy pixel can't decide.
  const pick = (pt) => pt && R.sampleColor(rgba, w, h, pt.x, pt.y, Math.max(2, Math.round(Math.max(w, h) / 500)));
  let bg = pick(p.pickBg), design = pick(p.pickDesign), lit = crop;
  if (p.adaptive) {
    const even = R.evenLight(crop, outW, outH, { bg, design });
    lit = even.rgba;
    bg = bg ?? even.bg;
    // The design was picked in whatever light fell on it: read it again in the evenly lit copy.
    const at = p.pickDesign && R.quadToCrop(quad, p.pickDesign, outW, outH);
    if (at && at.x >= 0 && at.y >= 0 && at.x < outW && at.y < outH) design = R.sampleColor(lit, outW, outH, at.x, at.y, 2);
  }
  let ink = R.inkFromRGBA(lit, outW, outH, { bg, design });
  const colors = { bg: ink.bg, design: pick(p.pickDesign) || null };   // as picked, for the page's swatches
  if (p.invert) ink = R.invert(ink);
  if (p.mask) {
    // The selected object only: outside it everything is background, whatever its colour.
    const k = p.mask.w / w, m = { w: p.mask.w, h: p.mask.h, data: Float32Array.from(p.mask.data) };
    const inside = R.warpQuad(m, quad.map((c) => ({ x: c.x * k, y: c.y * k })), outW, outH);
    for (let i = 0; i < ink.data.length; i++) ink.data[i] *= inside.data[i];
  }
  ink = R.gaussianBlur(ink, p.blur);
  const mmPerPx = p.sizeAxis === 'height' ? p.sizeMM / outH : p.sizeMM / outW;
  return { ink, crop, w: outW, h: outH, mmPerPx, colors };
}

export function outline(prep, params = {}) {
  const p = { ...SHAPE_DEFAULTS, ...params };
  const { ink, mmPerPx } = prep;
  const minArea = p.speckMM2 != null ? p.speckMM2 / (mmPerPx * mmPerPx) : Math.max(6, (ink.w * ink.h) / 150000);
  // Straight mode: corners are found at a lower angle and everything between them is
  // simplified hard, so polygon edges come out as single straight lines.
  const res = traceOutlines(ink, {
    level: p.level, minArea, minHoleArea: minArea * 3, minHoleWidth: 2.5, sigma: p.smooth,
    cornerDeg: p.straight ? Math.min(p.cornerDeg, 30) : p.cornerDeg, tol: p.straight ? 1.2 : 0.15,
  });
  // Straight mode keeps its hard-simplified polygons: straight edges between corners, no arcs.
  const arcs = p.arcs && !p.straight;
  const paths = res.paths.map((q) => (arcs
    ? { ...toSegs(q.dense, q.corners, true, mmPerPx, p), closed: true, kind: q.kind, layer: 'CUT' }
    : { pts: q.pts.map((v) => ({ x: v.x * mmPerPx, y: v.y * mmPerPx })), closed: true, kind: q.kind, layer: 'CUT' }));
  return { paths, pieces: res.pieces, holes: res.holes, widthMM: ink.w * mmPerPx, heightMM: ink.h * mmPerPx };
}

// Centreline mode: for line drawings where the drawn line itself is the cut path.
export function centreline(prep, params = {}) {
  const p = { ...SHAPE_DEFAULTS, ...params };
  const { ink, mmPerPx } = prep;
  const minArea = p.speckMM2 != null ? p.speckMM2 / (mmPerPx * mmPerPx) : Math.max(6, (ink.w * ink.h) / 150000);
  let mask = R.threshold(ink, { level: p.level, lightLines: true });
  mask = R.fillHoles(R.removeSpecks(mask, minArea), Math.max(4, minArea / 4));
  const stroke = Math.max(1, R.strokeWidth(mask));
  const traced = pruneBranches(tracePolylines(thin(mask)), Math.max(3, stroke * 2));
  const bridge = p.bridgeMM != null ? p.bridgeMM / mmPerPx : stroke * 3;
  // Short gaps join to the nearest end; longer ones (a faint stretch of line) only between ends
  // that point at each other.
  const joined = joinPaths(traced.map((pts) => ({ pts, closed: false })), {
    tol: Math.max(1.5, stroke * 0.75), gap: bridge, reach: p.bridgeMM != null ? bridge : bridge * 8, aimDeg: 35, aimBack: Math.max(6, stroke * 3),
  });
  // Then loose ends: stubs at junctions go, ends that stop just short of a line meet it.
  const mended = mendEnds(joined, { touch: Math.max(1.5, stroke), reach: Math.max(bridge, stroke * 5), spur: stroke * 6 });
  const lines = mended.map((j) => (j.closed ? j.pts.concat([j.pts[0]]) : j.pts));
  const paths = [];
  for (const line of lines) {
    if (line.length < 2) continue;
    const first = line[0], last = line[line.length - 1];
    const closed = line.length > 3 && Math.hypot(first.x - last.x, first.y - last.y) < 1.5;
    const sm = { sigma: Math.max(p.smooth, stroke * 0.4), cornerDeg: p.cornerDeg };
    const r = closed ? smoothClosed(line.slice(0, -1), sm) : smoothOpen(line, sm);
    if (p.arcs) { paths.push({ ...toSegs(r.pts, r.corners, closed, mmPerPx, p), closed, layer: 'CUT' }); continue; }
    const pts = closed ? simplifyClosed(r.pts, 0.15, r.corners) : simplifyOpen(r.pts, 0.15, r.corners);
    paths.push({ pts: pts.map((v) => ({ x: v.x * mmPerPx, y: v.y * mmPerPx })), closed, layer: 'CUT' });
  }
  const looseTol = Math.max(1.5, stroke) * mmPerPx;
  return { paths, looseEnds: danglingEnds(paths, looseTol), looseTol, strokeMM: stroke * mmPerPx, widthMM: ink.w * mmPerPx, heightMM: ink.h * mmPerPx };
}

// Guess the right mode: thin, even strokes with little ink coverage = a line drawing.
export function suggestMode(prep, params = {}) {
  const p = { ...SHAPE_DEFAULTS, ...params };
  const mask = R.threshold(prep.ink, { level: p.level, lightLines: true });
  let on = 0;
  for (const v of mask.data) on += v;
  const coverage = on / mask.data.length;
  const stroke = R.strokeWidth(mask);
  const size = Math.max(prep.ink.w, prep.ink.h);
  const lineDrawing = coverage < 0.12 && stroke > 0 && stroke < size / 150;
  return { mode: lineDrawing ? 'centreline' : 'outline', coverage, strokePx: stroke };
}
