// DXF (AutoCAD R12 ASCII, the most widely accepted by CAM software) and SVG export.
// Input coordinates are millimetres with y pointing down; DXF gets y up.
import { arcBulge } from './fit.js';

function dxfPolyline(out, pts, layer, H, closed = true) {
  out.push('0', 'POLYLINE', '8', layer, '66', '1', '10', '0', '20', '0', '30', '0', '70', closed ? '1' : '0');
  for (const p of pts) out.push('0', 'VERTEX', '8', layer, '10', p.x.toFixed(4), '20', (H - p.y).toFixed(4), '30', '0');
  out.push('0', 'SEQEND', '8', layer);
}

// A path of lines and arcs (see fit.js) as ONE polyline. An arc is the vertex that starts it
// plus group 42, the bulge: tan(sweep / 4) of the arc up to the next vertex. DXF measures
// counter-clockwise with y up, and y is flipped on the way out, so the sign flips.
function dxfSegPolyline(out, segs, layer, H, closed = true) {
  const f = (v) => (Object.is(v, -0) || Math.abs(v) < 5e-5 ? 0 : v).toFixed(4);
  const verts = segs.map((s) => ({ p: s.a, bulge: s.type === 'arc' ? arcBulge(s, true) : 0 }));
  if (!closed) verts.push({ p: segs[segs.length - 1].b, bulge: 0 });
  // A path that collapsed to a point has nothing to cut.
  if (verts.length < 2 || segs.every((s) => s.type === 'line' && s.a.x === s.b.x && s.a.y === s.b.y)) return;
  out.push('0', 'POLYLINE', '8', layer, '66', '1', '10', '0', '20', '0', '30', '0', '70', closed ? '1' : '0');
  for (const v of verts) {
    out.push('0', 'VERTEX', '8', layer, '10', f(v.p.x), '20', f(H - v.p.y), '30', '0');
    if (v.bulge) out.push('42', (Math.abs(v.bulge) < 5e-9 ? 0 : v.bulge).toFixed(8));
  }
  out.push('0', 'SEQEND', '8', layer);
}

export function toDXF(cut, { panelH, centrelines = null }) {
  const layers = [['OUTLINE', 7], ['HOLES', 1], ['CENTRELINE', 8]];
  const out = [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1009',
    '9', '$INSUNITS', '70', '4',
    '9', '$MEASUREMENT', '70', '1',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LAYER', '70', String(layers.length),
  ];
  for (const [name, color] of layers) out.push('0', 'LAYER', '2', name, '70', '0', '62', String(color), '6', 'CONTINUOUS');
  out.push('0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES');
  dxfPolyline(out, cut.outline, 'OUTLINE', panelH);
  for (const h of cut.holes) dxfPolyline(out, h, 'HOLES', panelH);
  if (centrelines) for (const s of centrelines) dxfPolyline(out, [s.a, s.b], 'CENTRELINE', panelH, false);
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\r\n') + '\r\n';
}

const pathD = (pts, closed = true) =>
  pts.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(3) + ' ' + p.y.toFixed(3)).join('') + (closed ? 'Z' : '');

// The same for lines and arcs. SVG is y down like our input, and its sweep flag 1 means the
// direction of increasing angle, which is our positive sweep.
const segPathD = (segs, closed = true) => {
  let d = 'M' + segs[0].a.x.toFixed(3) + ' ' + segs[0].a.y.toFixed(3);
  for (const s of segs) {
    d += s.type === 'arc'
      ? `A${s.r.toFixed(3)} ${s.r.toFixed(3)} 0 ${Math.abs(s.sweep) > Math.PI ? 1 : 0} ${s.sweep > 0 ? 1 : 0} ${s.b.x.toFixed(3)} ${s.b.y.toFixed(3)}`
      : `L${s.b.x.toFixed(3)} ${s.b.y.toFixed(3)}`;
  }
  return d + (closed ? 'Z' : '');
};
const hasSegs = (p) => Array.isArray(p.segs) && p.segs.length > 0;
const anyD = (p) => (hasSegs(p) ? segPathD(p.segs, p.closed) : pathD(p.pts, p.closed));

export function toSVG(cut, { panelW, panelH, centrelines = null }) {
  const holes = cut.holes.map((h) => pathD(h)).join('');
  const cl = centrelines ? `<g id="centreline" fill="none" stroke="#888" stroke-width="0.3">${centrelines.map((s) => `<path d="${pathD([s.a, s.b], false)}"/>`).join('')}</g>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${panelW}mm" height="${panelH}mm" viewBox="0 0 ${panelW} ${panelH}">
  <path id="panel" fill="#b8bec6" fill-rule="evenodd" d="${pathD(cut.outline)}${holes}"/>
  ${cl}
</svg>
`;
}

export function centrelinesToSVG(segs, w, h) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">
  <g fill="none" stroke="#000" stroke-width="0.5">${segs.map((s) => `<path d="${pathD([s.a, s.b], false)}"/>`).join('')}</g>
</svg>
`;
}

// Generic path export: paths = [{ pts:[{x,y}] (mm, y down), closed, layer, segs? }]
// A path with `segs` (lines and arcs from fitPath) is written from those: in DXF one POLYLINE
// whose arcs are vertex bulges, in SVG `A` commands. Otherwise `pts` is written as before.
export function pathsToDXF(paths, { height }) {
  const layers = [...new Set(paths.map((p) => p.layer || 'CUT'))];
  const colors = { CUT: 7, OUTER: 7, HOLES: 1, CENTRELINE: 3, BORDER: 5 };
  const out = [
    '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(layers.length),
  ];
  for (const l of layers) out.push('0', 'LAYER', '2', l, '70', '0', '62', String(colors[l] ?? 7), '6', 'CONTINUOUS');
  out.push('0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES');
  for (const p of paths) {
    if (hasSegs(p)) dxfSegPolyline(out, p.segs, p.layer || 'CUT', height, p.closed);
    else dxfPolyline(out, p.pts, p.layer || 'CUT', height, p.closed);
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\r\n') + '\r\n';
}

export function pathsToSVG(paths, { width, height, fill = false }) {
  const body = fill
    ? `<path fill="#222" fill-rule="evenodd" d="${paths.filter((p) => p.closed).map(anyD).join('')}"/>`
    : `<g fill="none" stroke="#000" stroke-width="0.2">${paths.map((p) => `<path d="${anyD(p)}"/>`).join('')}</g>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">
  ${body}
</svg>
`;
}
