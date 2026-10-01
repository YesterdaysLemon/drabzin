// DXF (AutoCAD R12 ASCII, the most widely accepted by CAM software) and SVG export.
// Input coordinates are millimetres with y pointing down; DXF gets y up.

function dxfPolyline(out, pts, layer, H, closed = true) {
  out.push('0', 'POLYLINE', '8', layer, '66', '1', '10', '0', '20', '0', '30', '0', '70', closed ? '1' : '0');
  for (const p of pts) out.push('0', 'VERTEX', '8', layer, '10', p.x.toFixed(4), '20', (H - p.y).toFixed(4), '30', '0');
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

// Generic path export: paths = [{ pts:[{x,y}] (mm, y down), closed, layer }]
export function pathsToDXF(paths, { height }) {
  const layers = [...new Set(paths.map((p) => p.layer || 'CUT'))];
  const colors = { CUT: 7, OUTER: 7, HOLES: 1, CENTRELINE: 3, BORDER: 5 };
  const out = [
    '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(layers.length),
  ];
  for (const l of layers) out.push('0', 'LAYER', '2', l, '70', '0', '62', String(colors[l] ?? 7), '6', 'CONTINUOUS');
  out.push('0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES');
  for (const p of paths) dxfPolyline(out, p.pts, p.layer || 'CUT', height, p.closed);
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\r\n') + '\r\n';
}

export function pathsToSVG(paths, { width, height, fill = false }) {
  const body = fill
    ? `<path fill="#222" fill-rule="evenodd" d="${paths.filter((p) => p.closed).map((p) => pathD(p.pts)).join('')}"/>`
    : `<g fill="none" stroke="#000" stroke-width="0.2">${paths.map((p) => `<path d="${pathD(p.pts, p.closed)}"/>`).join('')}</g>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">
  ${body}
</svg>
`;
}
