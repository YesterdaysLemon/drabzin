// Runs Segment Anything (SlimSAM) in its own worker so the page stays responsive. Everything
// it loads - the onnxruntime-web library, its WebAssembly and the model weights - comes from
// this site's own origin, so the picture never leaves the browser. See segment.js for the API
// the page uses; this file only answers its messages.
//
// Messages in  { id, type: 'init' | 'image' | 'segment' | 'dispose', ... }
// Messages out { id, ok, ... } as the answer, and { id, progress, text } while 'init' loads.
// Requests are handled strictly one after another, in the order they arrive.
import * as sam from './sam.js';
import { fitQuad, maskBox } from './geometry.js';

const here = (rel) => new URL(rel, import.meta.url);
const CACHE = 'drabzin-segment-v1';

let manifest = null;
let ort = null;
let backend = null;       // 'webgpu' | 'wasm'
let encoder = null, decoder = null;
let emb = null;           // { embeddings, positional } for the current picture
let view = null;          // { w, h, rw, rh, scale, key } the current picture's geometry

const reply = (id, body, transfer = []) => self.postMessage({ id, ok: true, ...body }, transfer);
const fail = (id, err) => self.postMessage({ id, ok: false, error: String(err?.message || err), code: err?.code });
const coded = (code, message) => Object.assign(new Error(message), { code });

// ---- loading ----

async function sha256Hex(bytes) {
  if (!self.crypto?.subtle) return null;
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

const used = new Set();    // cache keys this version of the app uses; anything else in the cache is old

async function cacheOpen() {
  try { return await caches.open(CACHE); } catch { return null; }
}

// Fetches a file as bytes, reporting each chunk as it arrives. Files are kept in the browser's
// Cache Storage under a versioned name, so the second visit does not download them again.
async function getFile(url, { expect, sha256, version, onBytes, onTotal }) {
  const key = new URL(url);
  if (sha256 || version) key.searchParams.set('v', sha256 ? sha256.slice(0, 16) : version);
  used.add(key.href);
  const cache = await cacheOpen();
  try {
    const hit = await cache?.match(key);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      if (!expect || bytes.length === expect) { onTotal(bytes.length); onBytes(bytes.length); return bytes; }
    }
  } catch { /* an unreadable cache is just a miss */ }

  const res = await fetch(key);
  if (!res.ok) throw coded('missing', `${url} answered ${res.status}`);
  const encoded = res.headers.get('content-encoding');
  const length = !encoded && Number(res.headers.get('content-length'));
  onTotal(expect || length || 0);
  const chunks = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onBytes(value.length);
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  if (expect && got !== expect) throw coded('corrupt', `${url} is ${got} bytes, expected ${expect}`);
  if (sha256) {
    const sum = await sha256Hex(bytes);
    if (sum && sum !== sha256) throw coded('corrupt', `${url} does not match its checksum`);
  }
  try { await cache?.put(key, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })); } catch { /* storage full or blocked: fine */ }
  return bytes;
}

async function pickBackend(want) {
  if (want === 'wasm') return 'wasm';
  try {
    // A software "fallback" adapter would be slower than WebAssembly on the CPU: not worth it.
    const adapter = self.navigator?.gpu && (await navigator.gpu.requestAdapter());
    if (adapter && !adapter.isFallbackAdapter) return 'webgpu';
  } catch { /* no usable GPU */ }
  return 'wasm';
}

// The library comes in two builds: plain WebAssembly, and one that can also run on the GPU.
const RUNTIME = {
  wasm: { module: 'ort.wasm.min.mjs', wasm: 'ort-wasm-simd-threaded.wasm' },
  webgpu: { module: 'ort.min.mjs', wasm: 'ort-wasm-simd-threaded.jsep.wasm' },
};

async function startBackend(kind, wasmBytes, models, progress, threads) {
  const rt = RUNTIME[kind];
  ort = await import(here(`../vendor/ort/${rt.module}`).href);
  ort.env.wasm.wasmPaths = here('../vendor/ort/').href;
  ort.env.wasm.proxy = false;                                   // already in a worker
  ort.env.wasm.numThreads = self.crossOriginIsolated ? threads || Math.min(8, Math.max(1, Math.floor((self.navigator?.hardwareConcurrency || 2) / 2))) : 1;
  ort.env.wasm.wasmBinary = wasmBytes;
  ort.env.logLevel = 'error';                                   // no per-node chatter in the console
  progress(0.93, 'Starting');
  const opts = (providers) => ({ executionProviders: providers, graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  // The encoder does the heavy work, so it gets the GPU when there is one; the small decoder
  // runs on the CPU either way.
  encoder = await ort.InferenceSession.create(models.encoder, opts(kind === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm']));
  progress(0.97, 'Starting');
  decoder = await ort.InferenceSession.create(models.decoder, opts(['wasm']));
  if (kind === 'webgpu') {
    // The GPU compiles its shaders on the first run, which takes a second or two: do it now,
    // while the loading bar is up, rather than on the user's first picture. A GPU that cannot
    // run the model fails here and the caller falls back to WebAssembly.
    progress(0.98, 'Starting');
    const blank = new ort.Tensor('float32', new Float32Array(3 * sam.SIZE * sam.SIZE), [1, 3, sam.SIZE, sam.SIZE]);
    await encoder.run({ [encoder.inputNames[0]]: blank });
  }
  backend = kind;
}

async function init({ id, backend: want, threads }) {
  if (backend) return reply(id, info());
  const t0 = performance.now();
  manifest = await (await fetch(here('./models.json'))).json();
  const kind = await pickBackend(want);
  const modelDir = here(`../models/${manifest.id}/`);

  // Progress is bytes loaded over bytes to load, across all the files.
  let loaded = 0, last = 0;
  const totals = new Map();
  const progress = (fraction, text) => { last = Math.max(last, fraction); self.postMessage({ id, progress: last, text }); };
  const tell = () => {
    let total = 0;
    for (const t of totals.values()) total += t;
    progress(Math.min(0.9, total ? (loaded / total) * 0.9 : 0), 'Downloading');
  };
  const fetchOne = (name, url, expect, sha256, version) => {
    totals.set(name, expect || 0);
    return getFile(url, {
      expect, sha256, version,
      onTotal: (n) => { if (n) totals.set(name, n); tell(); },
      onBytes: (n) => { loaded += n; tell(); },
    });
  };
  const fetchWasm = (k) => fetchOne('wasm-' + k, here(`../vendor/ort/${RUNTIME[k].wasm}`).href, manifest.runtime.files[RUNTIME[k].wasm], null, manifest.runtime.version);

  const { encoder: enc, decoder: dec } = manifest.files;
  const [wasmBytes, encBytes, decBytes] = await Promise.all([
    fetchWasm(kind),
    fetchOne('encoder', new URL(enc.name, modelDir).href, enc.bytes, enc.sha256),
    fetchOne('decoder', new URL(dec.name, modelDir).href, dec.bytes, dec.sha256),
  ]);
  const tDownload = performance.now() - t0;
  const models = { encoder: encBytes, decoder: decBytes };
  let fellBack = false;
  try {
    await startBackend(kind, wasmBytes, models, progress, threads);
  } catch (e) {
    if (kind === 'wasm') throw e;
    // The GPU would not start (old driver, blocked): fall back to the plain WebAssembly build.
    console.warn('WebGPU failed, using WebAssembly:', e);
    fellBack = true;
    await release();
    await startBackend('wasm', await fetchWasm('wasm'), models, progress, threads);
  }
  progress(1, 'Ready');
  try {
    // Files from an older version of the model or library are no longer wanted.
    const cache = await cacheOpen();
    for (const k of (await cache?.keys()) || []) if (!used.has(k.url)) await cache.delete(k);
  } catch { /* the cache is only a speed-up */ }
  reply(id, { ...info(), fellBack, ms: { download: Math.round(tDownload), total: Math.round(performance.now() - t0) } });
}

const info = () => ({
  backend,
  threads: self.crossOriginIsolated ? ort?.env.wasm.numThreads : 1,
  isolated: !!self.crossOriginIsolated,
  model: manifest?.id,
});

// ---- work ----

async function image({ id, data, w, h, key }) {
  if (key !== undefined && view && view.key === key && view.w === w && view.h === h && emb) return reply(id, { cached: true, ms: { prep: 0, encode: 0 } });
  emb = null; view = null;
  const rgba = new Uint8ClampedArray(data);
  let t = performance.now();
  const prepared = sam.prepareImage(rgba, w, h);
  const prep = performance.now() - t;
  t = performance.now();
  emb = await sam.encode(ort, encoder, prepared);
  const encode = performance.now() - t;
  view = { w, h, rw: prepared.rw, rh: prepared.rh, scale: prepared.scale, key };
  reply(id, { ms: { prep: Math.round(prep), encode: Math.round(encode) } });
}

async function segment({ id, points, pick, geometry }) {
  if (!emb || !view) throw coded('no-image', 'segment() was called before setImage()');
  if (!points?.length) throw coded('no-points', 'segment() needs at least one point');
  const { w, h } = view;
  const pts = points.map((p) => ({ x: Math.min(w - 1, Math.max(0, +p.x)), y: Math.min(h - 1, Math.max(0, +p.y)), positive: p.positive !== false }));
  let t = performance.now();
  const d = await sam.decode(ort, decoder, emb, pts, view.scale);
  const decode = performance.now() - t;
  t = performance.now();
  const masks = [];
  for (let i = 0; i < d.count; i++) masks.push(sam.upsampleMask(d.logits, i * sam.LOGITS * sam.LOGITS, view.rw, view.rh, w, h));
  const areas = masks.map(sam.countOn);
  const index = sam.pick(areas, d.scores, pick);
  const mask = masks[index];
  const upsample = performance.now() - t;
  const out = { mask, score: d.scores[index], index, candidates: d.scores.map((score, i) => ({ score, area: areas[i] })), w, h };
  t = performance.now();
  if (geometry !== false) {
    const fit = fitQuad(mask, w, h);
    out.quad = fit ? fit.corners : null;
    out.quadKind = fit ? fit.kind : null;
    out.quadFit = fit ? fit.fit : 0;
    out.box = maskBox(mask, w, h);
  }
  out.ms = { decode: Math.round(decode), upsample: Math.round(upsample), geometry: Math.round(performance.now() - t) };
  reply(id, out, [mask.buffer]);
}

// ---- dispatch ----

async function release() {
  emb = null; view = null; backend = null;
  await encoder?.release?.().catch(() => {});
  await decoder?.release?.().catch(() => {});
  encoder = decoder = null;
}

let queue = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data;
  queue = queue.then(async () => {
    try {
      if (m.type === 'init') {
        try { await init(m); } catch (e) { await release(); throw e; }
      }
      else if (m.type === 'image') await image(m);
      else if (m.type === 'segment') await segment(m);
      else if (m.type === 'dispose') { await release(); reply(m.id, {}); }
    } catch (err) {
      fail(m.id, err);
    }
  });
};
