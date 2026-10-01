// In-browser "click on the object" segmentation (Segment Anything, SlimSAM build).
//
//   import { createSegmenter } from './segment/segment.js';
//   const seg = createSegmenter();
//   await seg.ready((fraction, text) => ...);          // first use only: downloads ~40 MB, then cached
//   await seg.setImage({ data: rgba, w, h });          // once per picture (a few seconds)
//   const r = await seg.segment({ points: [{ x, y, positive: true }] });   // fast, repeat per click
//   r.mask   Uint8Array(w * h), 1 = object          r.score  the model's own quality score, 0..1
//   r.quad   four corners [{ x, y }] clockwise from the top-left, or null
//   r.box    { x, y, w, h } around the object, or null
//
// Everything runs in a Web Worker on this page's own origin: the picture, the library and the
// model never touch another server. The model is only fetched when ready() is first called.
export { maskToQuad, maskBox, fitQuad, cleanMask } from './geometry.js';
import { maskToQuad, maskBox, fitQuad } from './geometry.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);

// backend: 'webgpu' | 'wasm' to force one (default: the GPU when the browser has one, else
// WebAssembly). threads: WebAssembly threads (default half the cores, up to 8; always one when
// the page is not cross-origin isolated).
export function createSegmenter({ backend, threads } = {}) {
  let worker = null;
  let starting = null;                 // the one in-flight or finished ready() promise
  let listeners = new Set();           // progress callbacks waiting on ready()
  let sequence = 0;
  let imageBusy = false;               // the worker is working out a picture
  let imageNext = null;                // the newest picture waiting for it: { msg, transfer, resolve, reject }
  let lastImage = Promise.resolve();   // settles when the most recent setImage() call has
  const pending = new Map();           // request id -> { resolve, reject }
  let state = { backend: null, threads: 0, isolated: false };

  function spawn() {
    worker = new Worker(WORKER_URL, { type: 'module', name: 'segment' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.progress !== undefined) { for (const fn of listeners) fn(m.progress, m.text || ''); return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m);
      else p.reject(Object.assign(new Error(m.error || 'segmentation failed'), { code: m.code }));
    };
    worker.onerror = (e) => {
      const err = new Error(e.message || 'the segmentation worker stopped');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    };
  }

  function send(msg, transfer = []) {
    return new Promise((resolve, reject) => {
      if (!worker) { reject(new Error('call ready() first')); return; }
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id }, transfer);
    });
  }

  function pump() {
    if (imageBusy || !imageNext) return;
    const job = imageNext;
    imageNext = null;
    imageBusy = true;
    send(job.msg, job.transfer).then(job.resolve, job.reject).finally(() => { imageBusy = false; pump(); });
  }

  const api = {
    // Loads the model (first call only) and starts the worker. onProgress(fraction 0..1, text)
    // is called while it downloads and starts. Calling again returns the same promise, so
    // several callers can wait; after a failure the next call tries again.
    ready(onProgress) {
      if (onProgress) listeners.add(onProgress);
      if (!starting) {
        spawn();
        starting = send({ type: 'init', backend, threads }).then((m) => {
          state = { backend: m.backend, threads: m.threads, isolated: m.isolated, model: m.model, ms: m.ms, fellBack: m.fellBack };
          return state;
        }, (err) => {
          worker?.terminate();
          worker = null;
          starting = null;
          throw err;
        });
      }
      return starting.finally(() => { if (onProgress) listeners.delete(onProgress); });
    },

    // Works out the picture's embedding, once. image = { data: Uint8ClampedArray RGBA, w, h }.
    // The data is copied, so your array stays usable; pass transfer: true to hand it over
    // instead (it will be empty afterwards). If key is given and equals the last picture's key
    // (same size), nothing is recomputed. Only one picture is worked on at a time: if you set a
    // newer picture while an older one is still waiting its turn, the older call rejects with an
    // error whose code is 'superseded'. segment() always uses the newest picture set.
    setImage({ data, w, h, width, height, key, transfer = false }) {
      w = w ?? width; h = h ?? height;
      const done = (async () => {
        if (!(w > 0 && h > 0) || data.length < w * h * 4) throw new TypeError('setImage needs { data: RGBA bytes, w, h }');
        await api.ready();
        const buffer = transfer ? data.buffer : data.slice().buffer;
        return new Promise((resolve, reject) => {
          imageNext?.reject(Object.assign(new Error('a newer picture replaced this one'), { code: 'superseded' }));
          imageNext = { msg: { type: 'image', data: buffer, w, h, key }, transfer: [buffer], resolve: (m) => resolve({ w, h, ms: m.ms, cached: !!m.cached }), reject };
          pump();
        });
      })();
      lastImage = done.catch(() => {});
      return done;
    },

    // One mask from clicks on the current picture. points: [{ x, y, positive }] in picture
    // pixels; positive (default true) clicks add to the object, positive: false clicks cut
    // away. pick chooses among the model's three candidates:
    //   'object' (default) the biggest one it is reasonably sure of: the whole panel or sheet
    //   'score'            the one it scores highest, often just a part
    //   'largest', or 0, 1, 2
    // Returns { mask, score, index, candidates: [{ score, area }], w, h, quad, quadKind, box, ms }.
    // The mask is yours (not shared). Pass geometry: false to skip quad and box.
    async segment({ points, pick = 'object', geometry = true }) {
      for (let seen; seen !== lastImage;) { seen = lastImage; await seen; }     // wait for the newest picture
      const m = await send({ type: 'segment', points, pick, geometry });
      return {
        mask: m.mask, score: m.score, index: m.index, candidates: m.candidates, w: m.w, h: m.h,
        quad: m.quad ?? null, quadKind: m.quadKind ?? null, quadFit: m.quadFit ?? 0, box: m.box ?? null, ms: m.ms,
      };
    },

    maskToQuad, maskBox, fitQuad,
    get info() { return state; },

    // Stops the worker and frees the model. ready() can be called again afterwards.
    dispose() {
      worker?.terminate();
      worker = null;
      starting = null;
      imageNext?.reject(new Error('the segmenter was disposed'));
      imageNext = null;
      imageBusy = false;
      listeners = new Set();
      for (const p of pending.values()) p.reject(new Error('the segmenter was disposed'));
      pending.clear();
    },
  };
  return api;
}
