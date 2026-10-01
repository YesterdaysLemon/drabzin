// Turn the centreline network into cuttable geometry (all units here are millimetres).
//   bands  = centrelines thickened to the strap width
//   solid  = bands + frame border
//   holes  = everything inside the frame that is not a band (these get cut out)
import ClipperLib from './clipper.js';
import { chains } from './geometry.js';

const SCALE = 1000; // Clipper works in integers: 1 unit = 1 micron

const toPath = (pts) => pts.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
const fromPath = (path) => path.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE }));

function offset(paths, delta, { joinType = ClipperLib.JoinType.jtMiter, endType = ClipperLib.EndType.etClosedPolygon, miter = 3 } = {}) {
  const co = new ClipperLib.ClipperOffset(miter, 0.01 * SCALE);
  co.AddPaths(paths, joinType, endType);
  const out = new ClipperLib.Paths();
  co.Execute(out, delta * SCALE);
  return out;
}

function boolean(type, subj, clip) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
  if (clip) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const out = new ClipperLib.Paths();
  c.Execute(type, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}

function booleanTree(type, subj, clip) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
  if (clip) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(type, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return tree;
}

const area = (path) => Math.abs(ClipperLib.Clipper.Area(path)) / (SCALE * SCALE);

function regularPolygon(c, r, n = 24) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    // circumscribe so the polygon fully covers the circle
    const R = r / Math.cos(Math.PI / n);
    pts.push({ x: c.x + R * Math.cos(t), y: c.y + R * Math.sin(t) });
  }
  return pts;
}

const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

/**
 * graph: { nodes, edges } in mm, y down.
 * opts: { panelW, panelH, bandWidth, frame, toolDiameter, minBridge }
 */
export function buildCutGeometry(graph, opts) {
  const { panelW, panelH, bandWidth, frame = 0, toolDiameter = 0, minBridge = 0 } = opts;
  const half = bandWidth / 2;

  // Thicken centreline chains. Mitred bends; junctions filled with a disc so every point
  // within half the band width of the network is solid.
  const bandPaths = new ClipperLib.Paths();
  const cs = chains(graph);
  const openPaths = [], closedPaths = [];
  for (const c of cs) {
    if (c.closed) closedPaths.push(toPath(c.pts.slice(0, -1)));
    else openPaths.push(toPath(c.pts));
  }
  if (openPaths.length) bandPaths.push(...offset(openPaths, half, { endType: ClipperLib.EndType.etOpenButt }));
  if (closedPaths.length) bandPaths.push(...offset(closedPaths, half, { endType: ClipperLib.EndType.etClosedLine }));
  const deg = graph.nodes.map(() => 0);
  for (const [i, j] of graph.edges) { deg[i]++; deg[j]++; }
  graph.nodes.forEach((p, i) => { if (deg[i] >= 3) bandPaths.push(toPath(regularPolygon(p, half))); });
  const bands = boolean(ClipperLib.ClipType.ctUnion, bandPaths);

  const outer = [toPath(rect(0, 0, panelW, panelH))];
  const inner = frame > 0 ? [toPath(rect(frame, frame, panelW - frame, panelH - frame))] : outer;

  // Holes: inside the frame and not band. A PolyTree tells us which holes contain islands.
  const tree = booleanTree(ClipperLib.ClipType.ctDifference, inner, bands);
  const holes = [], islands = [];
  const walk = (node, depth) => {
    for (const ch of node.Childs()) {
      const contour = ch.Contour();
      if (depth % 2 === 0) holes.push(contour);
      else islands.push(contour);
      walk(ch, depth + 1);
    }
  };
  walk(tree, 0);

  const solid = boolean(ClipperLib.ClipType.ctDifference, outer, boolean(ClipperLib.ClipType.ctUnion, holes, null));
  // islands are solid pieces sitting inside a hole: they would fall out when cut
  const solidFinal = islands.length ? boolean(ClipperLib.ClipType.ctUnion, solid, islands) : solid;

  const warnings = [];
  const flags = { tinyHoles: [], tightHoles: [], thinBridges: [], islands: islands.map(fromPath) };
  if (islands.length) warnings.push(`${islands.length} loose piece(s) would fall out when cut. Add tabs or join them to the strapwork.`);

  // Holes the tool cannot clear (morphological opening by the tool radius).
  if (toolDiameter > 0) {
    const r = toolDiameter / 2;
    for (const h of holes) {
      const shrunk = offset([h], -r);
      if (!shrunk.length) { flags.tinyHoles.push(fromPath(h)); continue; }
      const reopened = offset(shrunk, r);
      const lost = 1 - reopened.reduce((s, p) => s + area(p), 0) / area(h);
      if (lost > 0.2) flags.tightHoles.push(fromPath(h));
    }
    if (flags.tinyHoles.length) warnings.push(`${flags.tinyHoles.length} hole(s) are smaller than the ${toolDiameter} mm tool and cannot be cut.`);
    if (flags.tightHoles.length) warnings.push(`${flags.tightHoles.length} hole(s) have narrow points the ${toolDiameter} mm tool cannot fully reach.`);
  }
  // Solid bridges thinner than the minimum (opening of the solid by half the minimum).
  if (minBridge > 0) {
    const r = minBridge / 2;
    const opened = offset(offset(solidFinal, -r), r);
    const thin = boolean(ClipperLib.ClipType.ctDifference, solidFinal, opened).filter((p) => area(p) > (minBridge * minBridge) / 4);
    flags.thinBridges = thin.map(fromPath);
    if (thin.length) warnings.push(`${thin.length} place(s) where the metal is thinner than ${minBridge} mm.`);
  }

  return {
    bands: bands.map(fromPath),
    holes: holes.map(fromPath),
    outline: fromPath(outer[0]),
    flags,
    warnings,
    stats: {
      holeCount: holes.length,
      cutLength: holes.reduce((s, h) => s + perimeter(fromPath(h)), 0) + 2 * (panelW + panelH),
      openArea: holes.reduce((s, h) => s + area(h), 0),
    },
  };
}

function perimeter(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return s;
}
