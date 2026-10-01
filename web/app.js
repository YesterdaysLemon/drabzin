import { pathsToDXF, pathsToSVG } from './core/export.js';
import { squareToQuad, applyH, quadToCrop } from './core/raster.js';
import { listDesigns, saveDesign, deleteDesign } from './designs.js';
import { segsLength } from './core/fit.js';
import { danglingEnds } from './core/contour.js';
import { createSegmenter } from './segment/segment.js';
import { t, LANGS, setLang, initialLang, currentLang, langInfo } from './i18n.js';

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
  pickDesign: null,   // {x, y} in source px: a spot on the design
  pickBg: null,       // {x, y} in source px: a spot on the background
  picking: null,      // 'design' | 'bg' while waiting for a click on the picture
  designs: [],        // every open image (see designs.js)
  current: null,      // id of the design on screen
  restore: null,      // deletions to apply to the first result of a reopened design
  seg: null,          // the selected object (Find the design): { key, w, h, runs } mask over the source
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
  if (state.restore) {
    if (r.result.paths.length === state.restore.pathCount) state.removed = new Set(state.restore.removed);
    state.restore = null;
  }
  state.history = [];
  state.selected = new Set();
  setImage($('maskImg'), r.preview);
  setImage($('cropImg'), r.crop);
  renderResult();
  if (firstResult && state.view === 'photo') setView('overlay');
  else if (state.view !== 'photo') { if (!state.cam.mm) fit(); else applyCam(); }
  saveSoon();
}

function params() {
  const num = (id) => { const v = $(id).value.trim(); return v === '' ? null : Number(v); };
  return {
    mode: state.mode,
    corners: state.corners,
    sizeMM: num('sizeMM') || 1000,
    sizeAxis: $('sizeAxis').value,
    invert: $('invert').checked,
    pickDesign: state.pickDesign, pickBg: state.pickBg, adaptive: $('adaptive').checked,
    level: Number($('level').value),
    smooth: Number($('smooth').value),
    cornerDeg: Number($('cornerDeg').value),
    straight: $('straight').checked,
    speckMM2: num('speckMM2'),
    bridgeMM: num('bridgeMM'),
    useMask: !!state.seg && $('segMask').checked, maskKey: state.seg?.key ?? null,
    arcs: $('arcs').value === '1',
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
  $('warnings').innerHTML = `<li>${escapeHtml(t('err.generic', { msg: String(err).split('\n')[0] }))}</li>`;
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// The line under the file picker: a message key, or the open file's name and size.
let fileNote = null;
function setFileNote(note) { fileNote = note; renderFileNote(); }
function renderFileNote() {
  $('filename').textContent = !fileNote ? '' : fileNote.key ? t(fileNote.key) : fileNote.text;
}

// ---------- designs (one tab per image) ----------
// Every image opened becomes a design with its own settings and deletions. They are kept in
// this browser (designs.js), so switching tabs or closing the page does not lose the work.
const CONTROLS = ['segMask', 'sizeMM', 'sizeAxis', 'invert', 'adaptive', 'straight', 'level', 'smooth', 'cornerDeg', 'speckMM2', 'bridgeMM', 'arcs', 'maxSide', 'nx', 'ny', 'order', 'mirror', 'snapDeg', 'bandWidthMM'];
const CARRY = ['sizeMM', 'sizeAxis', 'arcs', 'maxSide'];   // a new image starts with these from the open one
const readControl = (id) => ($(id).type === 'checkbox' ? $(id).checked : $(id).value);
const DEFAULTS = Object.fromEntries(CONTROLS.map((id) => [id, readControl(id)]));

function settings() {
  return {
    controls: Object.fromEntries(CONTROLS.map((id) => [id, readControl(id)])),
    mode: state.mode, corners: state.corners, pickDesign: state.pickDesign, pickBg: state.pickBg, seg: state.seg,
  };
}
function applySettings(s) {
  for (const id of CONTROLS) {
    const v = s.controls?.[id] ?? DEFAULTS[id];
    if ($(id).type === 'checkbox') $(id).checked = !!v; else $(id).value = v;
  }
  state.mode = s.mode || 'auto';
  for (const x of $('mode').children) x.classList.toggle('on', x.dataset.v === state.mode);
  state.corners = s.corners || null;
  state.pickDesign = s.pickDesign || null;
  state.pickBg = s.pickBg || null;
  state.seg = s.seg || null;
  updateOutputs();
}

const current = () => state.designs.find((d) => d.id === state.current);
let saveTimer = 0;
function saveSoon(delay = 400) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delay);
}
function saveNow() {
  clearTimeout(saveTimer);
  const d = current();
  if (!d) return;
  d.settings = settings();
  d.removed = [...state.removed];
  if (state.last) d.pathCount = state.last.result.paths.length;
  saveDesign(d);
}

async function addImages(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) {
    setFileNote({ key: 'file.notImage' });
    return;
  }
  saveNow();
  const carry = Object.fromEntries(CARRY.map((id) => [id, readControl(id)]));
  for (const file of images) {
    const now = Date.now();
    const d = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${now}-${Math.random()}`,
      name: file.name || 'pasted image', blob: file, created: now, opened: now,
      settings: { controls: { ...DEFAULTS, ...carry }, mode: 'auto' }, removed: [], pathCount: 0,
    };
    if (!(await openDesign(d))) continue;   // the message says why
    state.designs.push(d);
    saveDesign(d);
  }
  renderDesigns();
}

async function openDesign(d) {
  let bmp;
  try { bmp = await createImageBitmap(d.blob); } catch {
    setFileNote({ key: 'file.cantOpen' });
    return false;
  }
  const s = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  if (state.src?.url) URL.revokeObjectURL(state.src.url);
  const url = URL.createObjectURL(d.blob);
  state.current = d.id;
  d.opened = Date.now();
  state.src = { w, h, url, name: d.name.replace(/\.[^.]+$/, '') || 'design' };
  applySettings(d.settings);
  // Deletions are kept by line number: they apply again if the same settings give the same lines.
  state.restore = d.removed?.length ? { removed: d.removed, pathCount: d.pathCount } : null;
  setPicking(null);
  state.last = null;
  state.removed = new Set();
  state.cam = { photo: null, mm: null };
  setFileNote({ text: `${d.name} · ${bmp.width} × ${bmp.height} px` });
  const img = $('photoImg');
  img.setAttribute('href', url);
  img.setAttribute('width', w); img.setAttribute('height', h);
  document.body.classList.add('has-image');
  $('empty').hidden = true;
  renderDesigns();
  await call({ cmd: 'load', buffer: data.buffer, w, h }, [data.buffer]);
  await sendMask();
  segSay();
  setView('photo');
  process();
  return true;
}

function closeDesign(d) {
  if (!confirm(t('tab.confirmClose', { name: d.name }))) return;
  deleteDesign(d.id);
  const i = state.designs.indexOf(d);
  state.designs.splice(i, 1);
  if (d.id !== state.current) { renderDesigns(); return; }
  const next = state.designs[Math.min(i, state.designs.length - 1)];
  if (next) { openDesign(next); return; }
  // Nothing left: back to the start screen.
  state.current = null;
  state.src = null;
  state.last = null;
  document.body.classList.remove('has-image');
  $('empty').hidden = false;
  for (const id of ['photoImg', 'maskImg', 'cropImg']) $(id).removeAttribute('href');
  for (const id of ['paths', 'cropUI', 'picksUI', 'endsUI', 'stats', 'warnings']) $(id).innerHTML = '';
  state.seg = null;
  segSay();
  state.looseEnds = [];
  setFileNote(null);
  $('sel').hidden = true;
  renderDesigns();
}

function renderDesigns() {
  const nav = $('designs');
  nav.hidden = !state.designs.length;
  nav.innerHTML = '';
  for (const d of state.designs) {
    const tab = document.createElement('div');
    tab.className = `design${d.id === state.current ? ' on' : ''}`;
    const open = document.createElement('button');
    open.className = 'open';
    open.textContent = d.name.replace(/\.[^.]+$/, '');
    open.title = d.name;
    open.setAttribute('aria-current', String(d.id === state.current));
    open.addEventListener('click', () => { if (d.id !== state.current) { saveNow(); openDesign(d); } });
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.setAttribute('aria-label', t('tab.closeName', { name: d.name }));
    close.title = t('tab.close');
    close.addEventListener('click', () => closeDesign(d));
    tab.append(open, close);
    nav.appendChild(tab);
  }
  const add = document.createElement('button');
  add.className = 'add';
  add.textContent = t('tab.add');
  add.addEventListener('click', () => $('file').click());
  nav.appendChild(add);
}

$('file').addEventListener('change', (e) => { addImages(e.target.files); e.target.value = ''; });
const drop = $('drop');
for (const t of [drop, $('viewer')]) {
  t.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  t.addEventListener('dragleave', () => drop.classList.remove('over'));
  t.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer?.files?.length) addImages(e.dataTransfer.files);
  });
}
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) addImages([item.getAsFile()]);
});
window.addEventListener('pagehide', saveNow);

// Reopen the designs from last time, the last one used in front.
listDesigns().then((saved) => {
  if (!saved.length || state.designs.length) return;
  state.designs = saved.sort((a, b) => a.created - b.created);
  openDesign(saved.reduce((a, b) => (b.opened > a.opened ? b : a)));
});

// ---------- controls ----------
for (const id of CONTROLS) {
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
$('cropReset').addEventListener('click', () => { state.corners = null; state.seg = null; sendMask(); segSay(); drawCrop(); schedule(0); });

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
  if (!box.width || !box.height) return;   // not laid out yet (a hidden tab): fit when it is
  const s = Math.min(box.width / w, box.height / h) * 0.94;
  state.cam[space()] = { s, x: w / 2 - box.width / s / 2, y: h / 2 - box.height / s / 2, auto: true };
  applyCam();
}
function applyCam() {
  const c = camFor();
  if (!c) return;
  const box = $('viewer').getBoundingClientRect();
  if (!box.width || !box.height || !(c.s > 0)) return;
  $('svg').setAttribute('viewBox', `${c.x} ${c.y} ${box.width / c.s} ${box.height / c.s}`);
  if (state.view === 'photo') drawCrop();
  drawPicks();
  drawEnds();
}
// Keep the drawing fitted while the layout settles, until the user zooms or pans.
new ResizeObserver(() => (!camFor() || camFor().auto ? fit() : applyCam())).observe($('viewer'));

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
  try { svg.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
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
  else if (drag && drag.moved < 4) { if (state.picking) pickAt(e); else clickAt(drag.target, e.shiftKey); }
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

// ---------- colour picks ----------
// Click a pick button, then click the picture (any view): that spot's colour becomes the design
// or the background colour. Picks are kept in source px so they survive crop changes.
function setPicking(kind) {
  state.picking = state.src ? kind : null;
  for (const [id, k] of [['pickDesign', 'design'], ['pickBg', 'bg'], ['segPick', 'segment']]) {
    $(id).classList.toggle('on', state.picking === k);
    $(id).setAttribute('aria-pressed', String(state.picking === k));
  }
  $('viewer').classList.toggle('picking', !!state.picking);
  renderPicks();
  renderSeg();
}
$('pickDesign').addEventListener('click', () => setPicking(state.picking === 'design' ? null : 'design'));
$('pickBg').addEventListener('click', () => setPicking(state.picking === 'bg' ? null : 'bg'));
$('pickStatus').addEventListener('click', (e) => {
  if (!e.target.closest('#pickClear')) return;
  state.pickDesign = state.pickBg = null;
  setPicking(null);
  schedule(0);
});

function pickAt(e) {
  const w = toWorld(e);
  let pt = w;
  if (space() === 'mm') {
    const r = state.last?.result;
    if (!r) return;
    pt = applyH(squareToQuad(currentCorners()), w.x / r.widthMM, w.y / r.heightMM);
  }
  if (!(pt.x >= 0 && pt.y >= 0 && pt.x <= state.src.w && pt.y <= state.src.h)) return;
  if (state.picking === 'segment') { selectAt(pt); return; }
  const kind = state.picking;
  state[kind === 'design' ? 'pickDesign' : 'pickBg'] = { x: pt.x, y: pt.y };
  // With the design colour known, 0.5 is exactly halfway between background and design.
  if (kind === 'design') { $('level').value = 0.5; updateOutputs(); }
  setPicking(null);
  drawPicks();
  schedule(0);
}

const rgb = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
function renderPicks() {
  const colors = state.last?.colors || {};
  const sw = (id, picked, col) => {
    $(id).classList.toggle('auto', !picked || !col);
    $(id).style.background = picked && col ? rgb(col) : '';
  };
  sw('designSwatch', state.pickDesign, colors.design);
  sw('bgSwatch', state.pickBg, colors.bg);
  const st = $('pickStatus');
  if (state.picking === 'design') st.textContent = t('pick.nowDesign');
  else if (state.picking === 'bg') st.textContent = t('pick.nowBg');
  else if (state.pickDesign || state.pickBg) st.innerHTML = `${escapeHtml(t('pick.done'))} <button id="pickClear">${escapeHtml(t('pick.reset'))}</button>`;
  else st.textContent = '';
}

// Loose line ends (centreline mode), as rings that keep their size on screen.
function drawEnds() {
  const g = $('endsUI');
  g.innerHTML = '';
  const c = camFor();
  if (!c || space() !== 'mm' || state.view === 'mask') return;
  for (const e of state.looseEnds || []) {
    const el = document.createElementNS(SVGNS, 'circle');
    el.setAttribute('cx', e.x); el.setAttribute('cy', e.y); el.setAttribute('r', 6 / c.s);
    g.appendChild(el);
  }
}

function drawPicks() {
  const g = $('picksUI');
  g.innerHTML = '';
  const c = camFor(), r = state.last?.result;
  if (!state.src || !c) return;
  for (const [kind, pt] of [['design', state.pickDesign], ['bg', state.pickBg]]) {
    if (!pt) continue;
    let p = pt;
    if (space() === 'mm') {
      if (!r) continue;
      p = quadToCrop(currentCorners(), pt, r.widthMM, r.heightMM);
    }
    const col = state.last?.colors?.[kind];
    for (const [cls, rad, fill] of [['ring', 9, 'none'], ['', 7, col ? rgb(col) : 'transparent']]) {
      const el = document.createElementNS(SVGNS, 'circle');
      el.setAttribute('cx', p.x); el.setAttribute('cy', p.y); el.setAttribute('r', rad / c.s);
      if (cls) el.setAttribute('class', cls); else el.setAttribute('fill', fill);
      g.appendChild(el);
    }
  }
}

// ---------- find the design (Segment Anything, in the browser: see web/segment/) ----------
// One click on the panel, paper or board gives its mask (kept per design, as run lengths) and
// its four corners, which become the crop. The model loads on first use (about 55 MB, cached).
let segmenter = null, segFor = null, segScale = 1, segBusy = false, segMsg = null;   // segMsg: { key, vars }
const SEG_SIDE = 2048;   // the picture the model sees, longest side in px

function renderSeg() {
  $('segStatus').textContent = segMsg ? t(segMsg.key, segMsg.vars) : state.picking === 'segment' && !segBusy ? t('seg.now') : '';
  $('segMaskRow').hidden = !state.seg;
}
function segSay(key, vars) { segMsg = key ? { key, vars } : null; renderSeg(); }

$('segPick').addEventListener('click', () => {
  if (state.picking === 'segment') { setPicking(null); segSay(); return; }
  segMsg = null;
  setView('photo');
  setPicking('segment');
  prepareSegmenter();
});
$('segMask').addEventListener('input', () => schedule(0));

async function prepareSegmenter() {
  const id = state.current;
  segmenter ??= createSegmenter();
  segBusy = true;
  try {
    segSay('seg.starting');
    await segmenter.ready((f, text) => (text === 'Downloading' ? segSay('seg.download', { p: Math.round(f * 100) }) : segSay('seg.starting')));
    if (segFor !== id) {
      segSay('seg.looking');
      const bmp = await createImageBitmap(current().blob);
      const k = Math.min(1, SEG_SIDE / Math.max(state.src.w, state.src.h));
      const w = Math.round(state.src.w * k), h = Math.round(state.src.h * k);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, w, h);
      await segmenter.setImage({ data: ctx.getImageData(0, 0, w, h).data, w, h, key: id, transfer: true });
      if (state.current !== id) return;   // another tab was opened meanwhile
      segFor = id; segScale = k;
    }
    segBusy = false;
    segSay();
  } catch (err) {
    segBusy = false;
    if (err?.code === 'superseded') return;
    console.warn('find the design:', err);
    setPicking(null);
    segSay('seg.cantStart');
  }
}

async function selectAt(pt) {
  if (segBusy) return;
  if (segFor !== state.current) { await prepareSegmenter(); if (segFor !== state.current) return; }
  const id = state.current, k = segScale;
  segBusy = true;
  segSay('seg.finding');
  try {
    const r = await segmenter.segment({ points: [{ x: pt.x * k, y: pt.y * k, positive: true }] });
    if (state.current !== id) return;
    if (!r.quad) { segSay('seg.nothing'); return; }
    state.corners = r.quad.map((c) => ({ x: Math.min(state.src.w, Math.max(0, c.x / k)), y: Math.min(state.src.h, Math.max(0, c.y / k)) }));
    state.seg = { key: `${id}:${Date.now()}`, w: r.w, h: r.h, runs: toRuns(r.mask) };
    setPicking(null);
    segSay('seg.found');
    await sendMask();
    drawCrop();
    schedule(0);
  } catch (err) {
    console.warn('find the design:', err);
    segSay('seg.failed');
  } finally {
    segBusy = false;
    renderSeg();
  }
}

// Masks are kept as run lengths (0s, 1s, 0s, ...): a few KB per tab instead of megabytes.
function toRuns(mask) {
  const runs = [];
  let v = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === v) { n++; continue; }
    runs.push(n); v = mask[i]; n = 1;
  }
  runs.push(n);
  return runs;
}
function fromRuns(runs, size) {
  const m = new Uint8Array(size);
  let i = 0;
  runs.forEach((n, j) => { if (j % 2) m.fill(1, i, i + n); i += n; });
  return m;
}
function sendMask() {
  const m = state.seg;
  return call({ cmd: 'mask', mask: m ? { w: m.w, h: m.h, data: fromRuns(m.runs, m.w * m.h) } : null });
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
  const hits = [];
  res.paths.forEach((p, i) => {
    if (state.removed.has(i)) return;
    const cls = state.selected.has(i) ? 'selected' : p.kind === 'hole' ? 'hole' : p.closed ? 'outer' : 'open';
    const el = document.createElementNS(SVGNS, 'path');
    el.setAttribute('class', cls);
    el.setAttribute('d', d(p.pts, p.closed));
    g.appendChild(el);
    hits.push({ i, p, area: p.closed ? Math.abs(area(p.pts)) : 0 });
  });
  // Click targets: a closed shape can be picked by clicking anywhere inside it, not just on its
  // thin edge. Smaller shapes go on top, so a loose piece inside a hole picks the piece. The main
  // part (the largest outline) only picks by its edge, so a stray click can't select the whole design.
  const main = hits.reduce((m, h) => (h.p.kind !== 'hole' && h.area > (m?.area ?? 0) ? h : m), null);
  hits.sort((a, b) => b.area - a.area);
  for (const h of hits) {
    const hit = document.createElementNS(SVGNS, 'path');
    hit.setAttribute('class', h.p.closed && h !== main ? 'hit area' : 'hit');
    hit.setAttribute('d', d(h.p.pts, h.p.closed));
    hit.dataset.i = h.i;
    g.appendChild(hit);
  }
  renderStatus();
  drawPicks();
}

function renderStatus() {
  const r = state.last;
  const res = r.result;
  const kept = res.paths.filter((_, i) => !state.removed.has(i));
  // What the file is made of: arcs and straight pieces (a path without arcs is all straight pieces).
  const arcs = kept.reduce((s, p) => s + (p.segs ? p.segs.filter((g) => g.type === 'arc').length : 0), 0);
  const straight = kept.reduce((s, p) => s + (p.segs ? p.segs.filter((g) => g.type === 'line').length : p.pts.length - (p.closed ? 0 : 1)), 0);
  const cut = kept.reduce((s, p) => {
    if (p.segs) return s + segsLength(p.segs);
    let L = 0;
    const n = p.pts.length, edges = p.closed ? n : n - 1;
    for (let i = 0; i < edges; i++) { const a = p.pts[i], b = p.pts[(i + 1) % n]; L += Math.hypot(b.x - a.x, b.y - a.y); }
    return s + L;
  }, 0);
  // Pieces and holes as they are now (after any deletions); every piece but the main one is loose.
  const loose = res.pieces != null ? Math.max(0, kept.filter((p) => p.kind === 'outer').length - 1) : null;
  const holes = res.holes != null ? kept.filter((p) => p.kind === 'hole').length : null;
  const stat = (k, v, tip = '') => `<span${tip ? ` title="${escapeHtml(tip)}"` : ''}>${escapeHtml(k)} <b dir="auto">${escapeHtml(v)}</b></span>`;
  $('stats').innerHTML = [
    stat(t('stat.size'), `${fmt(res.widthMM)} × ${fmt(res.heightMM)} mm`),
    stat(t('stat.cuts'), kept.length),
    stat(t('stat.length'), `${(cut / 1000).toFixed(2)} m`),
    holes != null ? stat(t('stat.holes'), holes) : '',
    loose != null ? stat(t('stat.loose'), loose, t('stat.looseTip')) : '',
    res.snapDeg != null ? stat(t('stat.angles'), res.snapDeg ? t('geo.every', { n: res.snapDeg }) : t('stat.any')) : '',
    res.bandWidthMM != null ? stat(t('stat.bar'), `${fmt(res.bandWidthMM)} mm`) : '',
    stat(t('stat.madeOf'), arcs ? t('stat.arcsStraight', { a: arcs, s: straight }) : t('stat.straightOnly', { s: straight }), t('stat.madeOfTip')),
  ].join('');
  const what = t(`what.${r.mode}`);
  $('modeHint').textContent = state.mode === 'auto'
    ? t('mode.autoChose', { name: t(`mode.${r.mode}`), what })
    : r.suggestion !== r.mode ? t('mode.wouldChoose', { what, name: t(`mode.${r.suggestion}`) }) : what;
  document.body.classList.toggle('mode-geometric', r.mode === 'geometric');
  document.body.classList.toggle('mode-centreline', r.mode === 'centreline');
  document.body.classList.toggle('mode-outline', r.mode === 'outline');
  // The size stays left-to-right inside right-to-left text (an isolate: U+2066 ... U+2069).
  $('sizeOut').textContent = t('size.out', { size: `\u2066${fmt(res.widthMM)} × ${fmt(res.heightMM)}\u2069` });
  renderPicks();

  // Engine warnings come as { code, n, mm } (geometric mode), in the page's language.
  const warn = (res.warnings || []).map((w) => (typeof w === 'string' ? w : t(`geo.warn.${w.code}`, w)));
  if (r.mode === 'outline' && loose > 0) warn.push(t('warn.loose', { n: loose }));
  state.looseEnds = r.mode === 'centreline' && res.looseTol ? danglingEnds(kept, res.looseTol) : [];
  if (state.looseEnds.length) {
    warn.push(t('warn.ends', { n: state.looseEnds.length }));
  }
  drawEnds();
  $('warnings').innerHTML = warn.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
  $('exportDxf').disabled = $('exportSvg').disabled = !kept.length;
  const sel = state.selected.size;
  $('sel').hidden = !sel && !state.history.length;
  $('selInfo').textContent = sel ? t('sel.count', { n: sel }) : t('sel.hint');
  $('delSel').disabled = !sel;
  $('undo').disabled = !state.history.length;
}
const fmt = (v) => (Math.round(v * 10) / 10).toString();
// Signed area of a closed polyline (shoelace).
const area = (pts) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p.x * q.y - q.x * p.y; }, 0) / 2;

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
  saveSoon();
}
$('delSel').addEventListener('click', deleteSelected);
$('undo').addEventListener('click', () => { if (state.history.length) { state.removed = state.history.pop(); renderResult(); saveSoon(); } });
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select')) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); $('undo').click(); }
  if (e.key === 'Escape') { if (state.picking) { setPicking(null); return; } state.selected.clear(); renderResult(); }
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

// ---------- light / dark ----------
// Follows the computer until the button is used; then the choice is remembered (boot.js applies
// it before the page draws).
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const theme = () => document.documentElement.dataset.theme || (systemDark.matches ? 'dark' : 'light');
function renderThemeButton() {
  const dark = theme() === 'dark', b = $('theme'), label = t(dark ? 'top.theme.toLight' : 'top.theme.toDark');
  b.classList.toggle('is-dark', dark);
  b.title = label;
  b.setAttribute('aria-label', label);
}
$('theme').addEventListener('click', () => {
  const next = theme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('drabzin.theme', next); } catch { /* storage blocked */ }
  renderThemeButton();
});
systemDark.addEventListener('change', renderThemeButton);

// ---------- language ----------
// English, plus machine translations (i18n.js); a note under the bar says so in that language.
const langSel = $('lang');
for (const l of LANGS) {
  const o = document.createElement('option');
  o.value = l.id; o.textContent = l.name; o.lang = l.id;
  langSel.appendChild(o);
}
function useLang(id, remember) {
  setLang(id, { remember });
  langSel.value = currentLang();
  $('mtNote').hidden = currentLang() === 'en';
  renderThemeButton();
  renderDesigns();
  renderPicks();
  renderSeg();
  renderFileNote();
  if (state.last) renderStatus();
  document.documentElement.removeAttribute('data-pending');
}
langSel.addEventListener('change', () => useLang(langSel.value, true));
$('toEnglish').addEventListener('click', () => useLang('en', true));
useLang(initialLang(), false);

// ---------- feedback ----------
// A short form; /api/feedback (a Cloudflare Worker on this site, see feedback/) emails it to the
// app's maker. The picture is never sent; with the box ticked, the settings and numbers are.
const fb = $('fbDialog');
const fbSay = (key, bad = false) => { $('fbStatus').textContent = key ? t(key) : ''; $('fbStatus').classList.toggle('bad', bad); };
$('feedback').addEventListener('click', () => {
  fbSay();
  $('fbSend').disabled = false;
  fb.showModal();
  $('fbMessage').focus();
});
$('fbCancel').addEventListener('click', () => fb.close());
$('fbForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = $('fbMessage').value.trim(), email = $('fbEmail').value.trim();
  if (message.length < 3) { fbSay('fb.empty', true); $('fbMessage').focus(); return; }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { fbSay('fb.badEmail', true); $('fbEmail').focus(); return; }
  const body = {
    kind: new FormData($('fbForm')).get('kind'), message, ease: $('fbEase').value, email,
    website: $('fbWebsite').value, lang: currentLang(),
    context: $('fbSettings').checked ? feedbackContext() : null,
  };
  $('fbSend').disabled = true;
  fbSay('fb.sending');
  try {
    const r = await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 429) { fbSay('fb.tooMany', true); $('fbSend').disabled = false; return; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fbSay('fb.sent');
    $('fbMessage').value = '';
    setTimeout(() => { if (fb.open) fb.close(); }, 2500);
  } catch (err) {
    console.warn('feedback:', err);
    fbSay('fb.failed', true);
    $('fbSend').disabled = false;
  }
});

// What helps find a problem, without the picture or its name: sizes, settings and the result's numbers.
function feedbackContext() {
  const r = state.last, res = r?.result;
  const kept = res ? res.paths.filter((_, i) => !state.removed.has(i)) : [];
  const p = params();
  delete p.maskKey;
  return {
    browser: navigator.userAgent,
    window: `${innerWidth}x${innerHeight}`,
    theme: theme(),
    tabs: state.designs.length,
    image: state.src ? `${state.src.w}x${state.src.h} px` : null,
    findTheDesign: !!state.seg,
    settings: p,
    result: res ? {
      mode: r.mode, suggested: r.suggestion, ms: r.ms,
      sizeMM: [Math.round(res.widthMM * 10) / 10, Math.round(res.heightMM * 10) / 10],
      cutLines: kept.length, deleted: state.removed.size,
      holes: res.holes ?? null, pieces: res.pieces ?? null, looseEnds: state.looseEnds?.length ?? null,
      warnings: [...$('warnings').querySelectorAll('li')].map((li) => li.textContent),
    } : null,
  };
}
