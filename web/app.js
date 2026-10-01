import { pathsToDXF, pathsToSVG } from './core/export.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const worker = new Worker('./worker.js', { type: 'module' });

const state = {
  src: null,          // { w, h, url, name }
  corners: null,      // crop quad in source px
  mode: 'auto',
  view: 'photo',
  last: null,         // last worker result
  removed: new Set(), // indices of deleted paths
  history: [],        // undo stack of removed-sets
  selected: new Set(),
  cam: { photo: null, mm: null }, // { x, y, s } per coordinate space
};

window.__drabzin = state; // handy for debugging from the console

// ---------- worker plumbing ----------
let seq = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const cb = pending.get(e.data.id);
  pending.delete(e.data.id);
  cb?.(e.data);
};
const call = (msg, transfer = []) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, res);
  worker.postMessage({ ...msg, id }, transfer);
});

let inFlight = false, queued = false, timer = 0;
function schedule(delay = 200) {
  clearTimeout(timer);
  timer = setTimeout(process, delay);
}
async function process() {
  if (!state.src) return;
  if (inFlight) { queued = true; return; }
  inFlight = true;
  $('busy').hidden = false;
  const r = await call({ cmd: 'process', params: params() });
  inFlight = false;
  $('busy').hidden = true;
  if (queued) { queued = false; process(); return; }
  if (!r.ok) { showError(r.error); return; }
  const firstResult = !state.last;
  state.last = r;
  state.removed = new Set();
  state.history = [];
  state.selected = new Set();
  setImage($('maskImg'), r.preview);
  setImage($('cropImg'), r.crop);
  renderResult();
  if (firstResult && state.view === 'photo') setView('overlay');
  else if (state.view !== 'photo') { if (!state.cam.mm) fit(); else applyCam(); }
}

function params() {
  const num = (id) => { const v = $(id).value.trim(); return v === '' ? null : Number(v); };
  return {
    mode: state.mode,
    corners: state.corners,
    sizeMM: num('sizeMM') || 1000,
    sizeAxis: $('sizeAxis').value,
    invert: $('invert').checked,
    level: Number($('level').value),
    smooth: Number($('smooth').value),
    cornerDeg: Number($('cornerDeg').value),
    straight: $('straight').checked,
    speckMM2: num('speckMM2'),
    bridgeMM: num('bridgeMM'),
    maxSide: Number($('maxSide').value),
    blur: 0.8,
    nx: num('nx') || 1, ny: num('ny') || 1,
    order: Number($('order').value), mirror: $('mirror').checked,
    snapDeg: $('snapDeg').value === '' ? null : Number($('snapDeg').value),
    bandWidthMM: num('bandWidthMM'),
    frameMM: 0,
  };
}

function setImage(el, img) {
  const c = document.createElement('canvas');
  c.width = img.w; c.height = img.h;
  c.getContext('2d').putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
  el.setAttribute('href', c.toDataURL('image/png'));
}

function showError(err) {
  console.error(err);
  $('warnings').innerHTML = `<li>Something went wrong while processing: ${escapeHtml(String(err).split('\n')[0])}</li>`;
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- loading ----------
async function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    $('filename').textContent = 'That file is not an image. For a PDF, take a screenshot of the page and use that.';
    return;
  }
  let bmp;
  try { bmp = await createImageBitmap(file); } catch {
    $('filename').textContent = 'This browser cannot open that image format (for HEIC photos, export as JPEG first).';
    return;
  }
  const s = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  if (state.src?.url) URL.revokeObjectURL(state.src.url);
  const url = URL.createObjectURL(file);
  state.src = { w, h, url, name: (file.name || 'design').replace(/\.[^.]+$/, '') };
  state.corners = null;
  state.last = null;
  state.cam = { photo: null, mm: null };
  $('filename').textContent = `${file.name || 'pasted image'} · ${bmp.width} × ${bmp.height} px`;
  const img = $('photoImg');
  img.setAttribute('href', url);
  img.setAttribute('width', w); img.setAttribute('height', h);
  document.body.classList.add('has-image');
  $('empty').hidden = true;
  await call({ cmd: 'load', buffer: data.buffer, w, h }, [data.buffer]);
  setView('photo');
  process();
}

$('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
const drop = $('drop');
for (const t of [drop, $('viewer')]) {
  t.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  t.addEventListener('dragleave', () => drop.classList.remove('over'));
  t.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer?.files?.length) loadFile(e.dataTransfer.files[0]);
  });
}
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

// ---------- controls ----------
for (const id of ['sizeMM', 'sizeAxis', 'invert', 'straight', 'level', 'smooth', 'cornerDeg', 'speckMM2', 'bridgeMM', 'maxSide', 'nx', 'ny', 'order', 'mirror', 'snapDeg', 'bandWidthMM']) {
  $(id).addEventListener('input', () => { updateOutputs(); schedule(); });
}
function updateOutputs() {
  $('levelOut').textContent = Number($('level').value).toFixed(2);
  $('smoothOut').textContent = Number($('smooth').value).toFixed(1);
  $('cornerOut').textContent = `${$('cornerDeg').value}°`;
}
updateOutputs();

$('mode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.mode = b.dataset.v;
  for (const x of $('mode').children) x.classList.toggle('on', x === b);
  schedule(0);
});

$('cropEdit').addEventListener('click', () => setView('photo'));
$('cropReset').addEventListener('click', () => { state.corners = null; drawCrop(); schedule(0); });

// ---------- views ----------
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) setView(b.dataset.view);
});
$('fit').addEventListener('click', () => fit());

function setView(v) {
  state.view = v;
  for (const b of document.querySelectorAll('.tabs [data-view]')) b.classList.toggle('on', b.dataset.view === v);
  $('cropEdit').classList.toggle('on', v === 'photo');
  document.body.classList.toggle('view-result', v === 'result');
  $('photoImg').style.display = v === 'photo' ? '' : 'none';
  $('maskImg').style.display = v === 'mask' ? '' : 'none';
  $('cropImg').style.display = v === 'overlay' ? '' : 'none';
  $('paths').style.display = v === 'photo' || v === 'mask' ? 'none' : '';
  $('cropUI').style.display = v === 'photo' ? '' : 'none';
  if (state.last) renderResult();
  if (!camFor() || camFor().auto) fit(); else applyCam();
}

const space = () => (state.view === 'photo' ? 'photo' : 'mm');
const camFor = () => state.cam[space()];
function worldSize() {
  if (space() === 'photo') return state.src ? { w: state.src.w, h: state.src.h } : { w: 100, h: 100 };
  const r = state.last?.result;
  return r ? { w: r.widthMM, h: r.heightMM } : { w: 100, h: 100 };
}
function fit() {
  const { w, h } = worldSize();
  const box = $('viewer').getBoundingClientRect();
  const s = Math.min(box.width / w, box.height / h) * 0.94;
  state.cam[space()] = { s, x: w / 2 - box.width / s / 2, y: h / 2 - box.height / s / 2, auto: true };
  applyCam();
}
function applyCam() {
  const c = camFor();
  if (!c) return;
  const box = $('viewer').getBoundingClientRect();
  $('svg').setAttribute('viewBox', `${c.x} ${c.y} ${box.width / c.s} ${box.height / c.s}`);
  if (state.view === 'photo') drawCrop();
}
// Keep the drawing fitted while the layout settles, until the user zooms or pans.
new ResizeObserver(() => (camFor()?.auto ? fit() : applyCam())).observe($('viewer'));

function toWorld(ev) {
  const c = camFor(), box = $('viewer').getBoundingClientRect();
  return { x: c.x + (ev.clientX - box.left) / c.s, y: c.y + (ev.clientY - box.top) / c.s };
}

// pan / zoom
const svg = $('svg');
svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const c = camFor();
  if (!c) return;
  const p = toWorld(e);
  const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
  c.s = Math.min(200, Math.max(0.01, c.s * k));
  c.auto = false;
  const box = $('viewer').getBoundingClientRect();
  c.x = p.x - (e.clientX - box.left) / c.s;
  c.y = p.y - (e.clientY - box.top) / c.s;
  applyCam();
}, { passive: false });

// The <image> elements are natively draggable in some browsers, which would hijack
// corner dragging and panning.
svg.addEventListener('dragstart', (e) => e.preventDefault());
const pointers = new Map();
let drag = null;
svg.addEventListener('pointerdown', (e) => {
  svg.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const handle = e.target.closest('[data-corner]');
  if (handle) { drag = { kind: 'corner', i: Number(handle.dataset.corner) }; return; }
  drag = { kind: 'pan', x: e.clientX, y: e.clientY, moved: 0, target: e.target };
  svg.classList.add('panning');
});
svg.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const c = camFor();
  if (!c || !drag) return;
  if (pointers.size === 2) {
    // pinch zoom
    const [a, b] = [...pointers.values()];
    const others = [...pointers.entries()].find(([id]) => id !== e.pointerId)[1];
    const d0 = Math.hypot(prev.x - others.x, prev.y - others.y), d1 = Math.hypot(a.x - b.x, a.y - b.y);
    if (d0 > 0) {
      const mid = { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 };
      const p = toWorld(mid);
      c.s = Math.min(200, Math.max(0.01, c.s * (d1 / d0)));
      c.auto = false;
      const box = $('viewer').getBoundingClientRect();
      c.x = p.x - (mid.clientX - box.left) / c.s;
      c.y = p.y - (mid.clientY - box.top) / c.s;
      applyCam();
    }
    drag.moved = 99;
    return;
  }
  if (drag.kind === 'corner') {
    const p = toWorld(e);
    const q = currentCorners();
    q[drag.i] = { x: Math.min(state.src.w, Math.max(0, p.x)), y: Math.min(state.src.h, Math.max(0, p.y)) };
    state.corners = q;
    drawCrop();
    return;
  }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  c.x -= dx / c.s; c.y -= dy / c.s;
  if (Math.abs(dx) + Math.abs(dy) > 0) c.auto = false;
  drag.x = e.clientX; drag.y = e.clientY;
  applyCam();
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size) return;
  svg.classList.remove('panning');
  if (drag?.kind === 'corner') schedule(0);
  else if (drag && drag.moved < 4) clickAt(drag.target, e.shiftKey);
  drag = null;
};
svg.addEventListener('pointerup', endPointer);
svg.addEventListener('pointercancel', endPointer);
svg.addEventListener('dblclick', () => fit());

// ---------- crop UI ----------
function currentCorners() {
  const { w, h } = state.src;
  return (state.corners ?? [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]).map((p) => ({ ...p }));
}
function drawCrop() {
  const g = $('cropUI');
  g.innerHTML = '';
  if (!state.src) return;
  const q = currentCorners();
  const { w, h } = state.src;
  const pts = q.map((p) => `${p.x},${p.y}`).join(' ');
  const shade = document.createElementNS(SVGNS, 'path');
  shade.setAttribute('class', 'shade');
  shade.setAttribute('d', `M0 0H${w}V${h}H0Z M${q.map((p) => `${p.x} ${p.y}`).join(' L')}Z`);
  g.appendChild(shade);
  const poly = document.createElementNS(SVGNS, 'polygon');
  poly.setAttribute('points', pts);
  g.appendChild(poly);
  const r = 9 / (state.cam.photo?.s || 1);
  q.forEach((p, i) => {
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', r);
    c.dataset.corner = i;
    g.appendChild(c);
  });
}

// ---------- result rendering ----------
function renderResult() {
  const r = state.last;
  if (!r) return;
  const res = r.result;
  $('maskImg').setAttribute('width', res.widthMM); $('maskImg').setAttribute('height', res.heightMM);
  $('cropImg').setAttribute('width', res.widthMM); $('cropImg').setAttribute('height', res.heightMM);
  const g = $('paths');
  g.innerHTML = '';
  const d = (pts, closed) => pts.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(3) + ' ' + p.y.toFixed(3)).join('') + (closed ? 'Z' : '');
  // filled preview of the material (outline + geometric modes)
  const closedPaths = res.paths.filter((p, i) => p.closed && !state.removed.has(i));
  if (r.mode !== 'centreline' && closedPaths.length) {
    const fill = document.createElementNS(SVGNS, 'path');
    fill.setAttribute('class', 'fill');
    fill.setAttribute('fill-rule', 'evenodd');
    fill.setAttribute('d', closedPaths.map((p) => d(p.pts, true)).join(''));
    fill.style.display = state.view === 'result' ? '' : 'none';
    g.appendChild(fill);
  }
  if (res.centrelines && state.view === 'overlay') {
    const c = document.createElementNS(SVGNS, 'path');
    c.setAttribute('class', 'centre');
    c.setAttribute('d', res.centrelines.map((p) => d(p.pts, false)).join(''));
    g.appendChild(c);
  }
  res.paths.forEach((p, i) => {
    if (state.removed.has(i)) return;
    const cls = state.selected.has(i) ? 'selected' : p.kind === 'hole' ? 'hole' : p.closed ? 'outer' : 'open';
    const el = document.createElementNS(SVGNS, 'path');
    el.setAttribute('class', cls);
    el.setAttribute('d', d(p.pts, p.closed));
    g.appendChild(el);
    const hit = document.createElementNS(SVGNS, 'path');
    hit.setAttribute('class', 'hit');
    hit.setAttribute('d', d(p.pts, p.closed));
    hit.dataset.i = i;
    g.appendChild(hit);
  });
  renderStatus();
}

function renderStatus() {
  const r = state.last;
  const res = r.result;
  const kept = res.paths.filter((_, i) => !state.removed.has(i));
  const verts = kept.reduce((s, p) => s + p.pts.length, 0);
  const cut = kept.reduce((s, p) => {
    let L = 0;
    for (let i = 1; i < p.pts.length; i++) L += Math.hypot(p.pts[i].x - p.pts[i - 1].x, p.pts[i].y - p.pts[i - 1].y);
    return s + L;
  }, 0);
  const names = { outline: 'Solid shapes', centreline: 'Line drawing', geometric: 'Geometric' };
  const stat = (k, v) => `<span>${k} <b>${v}</b></span>`;
  $('stats').innerHTML = [
    stat('Size', `${fmt(res.widthMM)} × ${fmt(res.heightMM)} mm`),
    stat('Cut paths', kept.length),
    stat('Cut length', `${(cut / 1000).toFixed(2)} m`),
    res.holes != null ? stat('Holes', res.holes) : '',
    res.pieces != null ? stat('Separate pieces', res.pieces) : '',
    res.snapDeg != null ? stat('Angles', res.snapDeg ? `every ${res.snapDeg}°` : 'free') : '',
    res.bandWidthMM != null ? stat('Strap', `${fmt(res.bandWidthMM)} mm`) : '',
    stat('Vertices', verts),
    stat('Time', `${r.ms} ms`),
  ].join('');
  $('modeHint').textContent = state.mode === 'auto' ? `Auto picked: ${names[r.mode]}.` : (r.suggestion !== r.mode ? `Auto would pick: ${names[r.suggestion]}.` : '');
  document.body.classList.toggle('mode-geometric', r.mode === 'geometric');
  document.body.classList.toggle('mode-centreline', r.mode === 'centreline');
  document.body.classList.toggle('mode-outline', r.mode === 'outline');
  $('sizeOut').textContent = `Output: ${fmt(res.widthMM)} × ${fmt(res.heightMM)} mm`;

  const warn = [...(res.warnings || [])];
  if (r.mode === 'outline' && res.pieces > 1)
    warn.push(`${res.pieces} separate pieces. Anything not joined to the main part will fall out when cut. Join it in the design or delete it here.`);
  if (r.mode === 'centreline') {
    const open = kept.filter((p) => !p.closed).length;
    if (open) warn.push(`${open} open path(s) (green). Fine for engraving or scoring lines; for through-cuts, check they meet up.`);
  }
  $('warnings').innerHTML = warn.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
  $('exportDxf').disabled = $('exportSvg').disabled = !kept.length;
  const sel = state.selected.size;
  $('sel').hidden = !sel && !state.history.length;
  $('selInfo').textContent = sel ? `${sel} path(s) selected` : 'Click a path to select it (Shift for several).';
  $('delSel').disabled = !sel;
  $('undo').disabled = !state.history.length;
}
const fmt = (v) => (Math.round(v * 10) / 10).toString();

function clickAt(target, add) {
  if (state.view === 'photo' || state.view === 'mask') return;
  const i = target?.dataset?.i;
  if (i == null) { if (state.selected.size) { state.selected.clear(); renderResult(); } return; }
  const k = Number(i);
  if (!add) { const had = state.selected.has(k); state.selected.clear(); if (had) { renderResult(); return; } }
  if (state.selected.has(k)) state.selected.delete(k); else state.selected.add(k);
  renderResult();
}
function deleteSelected() {
  if (!state.selected.size) return;
  state.history.push(new Set(state.removed));
  for (const i of state.selected) state.removed.add(i);
  state.selected.clear();
  renderResult();
}
$('delSel').addEventListener('click', deleteSelected);
$('undo').addEventListener('click', () => { if (state.history.length) { state.removed = state.history.pop(); renderResult(); } });
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select')) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); $('undo').click(); }
  if (e.key === 'Escape') { state.selected.clear(); renderResult(); }
});

// ---------- export ----------
function keptPaths() {
  return state.last.result.paths.filter((_, i) => !state.removed.has(i)).map((p) => ({ ...p, layer: 'CUT' }));
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('exportDxf').addEventListener('click', () => {
  const r = state.last.result;
  download(`${state.src.name}.dxf`, pathsToDXF(keptPaths(), { height: r.heightMM }), 'application/dxf');
});
$('exportSvg').addEventListener('click', () => {
  const r = state.last.result;
  download(`${state.src.name}.svg`, pathsToSVG(keptPaths(), { width: r.widthMM, height: r.heightMM, fill: state.last.mode !== 'centreline' }), 'image/svg+xml');
});
