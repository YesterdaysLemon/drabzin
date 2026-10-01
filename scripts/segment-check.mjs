// Headless check of click-to-select (Segment Anything in the browser) on the sample photos.
// Serves the built site (npm run build first), opens it in headless Chromium, loads the model
// the way a user would, clicks the object in each photo and writes the mask over the picture
// with the fitted four corners to .out/segment/<sample>-<backend>.png, plus timings in
// report-<backend>.json. A second picture per sample (-negative) adds a click that cuts
// something out of the mask.
//
//   node scripts/segment-check.mjs                    plain WebAssembly (what every browser has)
//   node scripts/segment-check.mjs --backend webgpu   the GPU build (needs a GPU)
//   node scripts/segment-check.mjs --only 09          one sample (09, 10 or 12)
//   node scripts/segment-check.mjs --repeat 5         more repeat clicks for the timing
//   node scripts/segment-check.mjs --threads 4        WebAssembly threads
//   node scripts/segment-check.mjs --url https://...  check a running site instead of dist/
//
// Exits 1 on any console error, failed request or request to another origin. Headless only: it
// never opens a visible browser and never asks for pointer lock.
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : (process.argv[i + 1] ?? true); };
const backend = arg('backend', 'wasm');
const only = arg('only', '');
const repeat = Number(arg('repeat', 3));
const threads = Number(arg('threads', 0)) || undefined;
const out = '.out/segment';
mkdirSync(out, { recursive: true });

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* fall through */ }
  const alt = process.env.PLAYWRIGHT_DIR || 'C:/Users/Yeste/Project/nightfall-bunker/node_modules/playwright/index.mjs';
  if (existsSync(alt)) return import('file:///' + alt.replace(/\\/g, '/'));
  throw new Error('playwright is not installed (npm install)');
}
const { chromium } = await loadPlaywright();

const freePort = () => new Promise((resolve) => { const s = createNetServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const remote = arg('url', '');
const port = remote ? 0 : await freePort();
const origin = remote ? remote.replace(/\/+$/, '') : `http://127.0.0.1:${port}`;
let server = null;
if (!remote) {
  if (!existsSync('dist/index.html')) { console.error('dist/ is missing: run npm run build first'); process.exit(1); }
  server = spawn(process.execPath, ['scripts/serve.mjs', '--dist'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'inherit', 'inherit'] });
}
const stop = () => { try { server?.kill(); } catch { /* already gone */ } };
process.on('exit', stop);
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(origin + '/healthz')).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 100));
}

// Each sample, and where a user would click: the object's middle (fractions of the picture),
// then a second click that should cut something out of the mask ("negative", Shift or right
// click in the app).
const SAMPLES = [
  { id: '09', file: 'samples/09-rosette-metal-photo.jpg', what: 'metal panel on glass', click: [0.5, 0.52], negative: [0.467, 0.437] },
  { id: '10', file: 'samples/10-horse-paper-photo.jpg', what: 'printed sheet on a desk', click: [0.5, 0.22], negative: [0.2, 0.9] },
  { id: '12', file: 'samples/12-etsy-wood-slice-photo.jpg', what: 'engraved wood slice on a shelf', click: [0.5, 0.42], negative: [0.1, 0.45] },
].filter((s) => s.id.includes(only) && existsSync(s.file));
if (!SAMPLES.length) { console.error('no samples found in samples/ (it is git-ignored and local)'); stop(); process.exit(1); }

// The lean headless shell has no GPU adapter; the full Chromium in its new headless mode does.
const browser = await chromium.launch(backend === 'webgpu'
  ? { headless: true, channel: 'chromium', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] }
  : { headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => problems.push('request failed: ' + r.url() + ' ' + (r.failure()?.errorText || '')));
const external = [];
page.on('request', (r) => { const u = r.url(); if (!u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u); });

// The photos are served from the test's own route, as same-origin files.
await page.route(origin + '/__samples/*', (route) => {
  const id = new URL(route.request().url()).pathname.split('/').pop();
  const s = SAMPLES.find((x) => x.id === id);
  route.fulfill({ body: readFileSync(s.file), contentType: 'image/jpeg', headers: { 'cache-control': 'no-store' } });
});
await page.goto(origin + '/healthz');          // a plain page with the site's real security headers

const report = await page.evaluate(async ({ samples, backend, repeat, threads }) => {
  const t = () => performance.now();
  const res = { isolated: self.crossOriginIsolated, gpu: !!navigator.gpu, cores: navigator.hardwareConcurrency, samples: [] };
  const { createSegmenter } = await import('/segment/segment.js');
  const seg = createSegmenter({ backend, threads });
  const progress = [];
  let t0 = t();
  await seg.ready((f, text) => { if (!progress.length || f - progress[progress.length - 1][0] >= 0.1 || f === 1) progress.push([+f.toFixed(2), text]); });
  res.load = { ms: Math.round(t() - t0), progress, info: seg.info };

  const label = (ctx, text, x, y) => { ctx.font = '600 15px sans-serif'; ctx.lineWidth = 4; ctx.strokeStyle = '#000'; ctx.strokeText(text, x, y); ctx.fillStyle = '#fff'; ctx.fillText(text, x, y); };
  // The picture with everything outside the mask dimmed, the mask tinted, the corners and clicks marked.
  async function overlay(bmp, w, h, r, points) {
    const scale = Math.min(1, 900 / Math.max(w, h));
    const ow = Math.round(w * scale), oh = Math.round(h * scale);
    const o = new OffscreenCanvas(ow, oh);
    const og = o.getContext('2d');
    og.drawImage(bmp, 0, 0, ow, oh);
    const img = og.getImageData(0, 0, ow, oh);
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
      const on = r.mask[Math.min(h - 1, Math.floor(y / scale)) * w + Math.min(w - 1, Math.floor(x / scale))];
      const i = (y * ow + x) * 4;
      if (on) { img.data[i] = img.data[i] * 0.65; img.data[i + 1] = img.data[i + 1] * 0.65 + 90; img.data[i + 2] = img.data[i + 2] * 0.65; }
      else { img.data[i] *= 0.3; img.data[i + 1] *= 0.3; img.data[i + 2] *= 0.3; }
    }
    og.putImageData(img, 0, 0);
    if (r.quad) {
      og.strokeStyle = '#ffd400'; og.lineWidth = 3; og.beginPath();
      r.quad.forEach((p, i) => (i ? og.lineTo(p.x * scale, p.y * scale) : og.moveTo(p.x * scale, p.y * scale)));
      og.closePath(); og.stroke();
      r.quad.forEach((p, i) => { og.fillStyle = ['#ff2d2d', '#ff9a00', '#e040fb', '#00b0ff'][i]; og.beginPath(); og.arc(p.x * scale, p.y * scale, 7, 0, 7); og.fill(); label(og, ['TL', 'TR', 'BR', 'BL'][i], p.x * scale + 9, p.y * scale - 9); });
    }
    for (const p of points) { og.fillStyle = p.positive ? '#fff' : '#2040ff'; og.strokeStyle = p.positive ? '#d00' : '#fff'; og.lineWidth = 3; og.beginPath(); og.arc(p.x * scale, p.y * scale, 7, 0, 7); og.fill(); og.stroke(); }
    const buf = new Uint8Array(await (await o.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const count = (m) => { let n = 0; for (let i = 0; i < m.length; i++) n += m[i]; return n; };
  const summary = (r, ms, w, h) => ({
    ms, score: +r.score.toFixed(3), index: r.index, share: +(count(r.mask) / (w * h)).toFixed(3),
    candidates: r.candidates.map((x) => ({ score: +x.score.toFixed(3), share: +(x.area / (w * h)).toFixed(3) })),
    quad: r.quad && r.quad.map((p) => [Math.round(p.x), Math.round(p.y)]), quadKind: r.quadKind, quadFit: +r.quadFit.toFixed(3), box: r.box, detail: r.ms,
  });
  const pixels = (bmp) => { const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); const d = g.getImageData(0, 0, bmp.width, bmp.height); return { data: d.data, w: d.width, h: d.height }; };

  // Queueing: three pictures in a row, the middle one is replaced before it starts; the same key
  // twice is not worked out twice.
  {
    const tiny = () => ({ data: new Uint8ClampedArray(64 * 64 * 4).fill(200), w: 64, h: 64 });
    const results = await Promise.allSettled([seg.setImage(tiny()), seg.setImage(tiny()), seg.setImage({ ...tiny(), key: 'k' })]);
    const again = await seg.setImage({ ...tiny(), key: 'k' });
    res.queue = { outcomes: results.map((x) => (x.status === 'fulfilled' ? 'done' : x.reason.code || x.reason.message)), sameKeyCached: again.cached };
  }

  for (const s of samples) {
    const bmp = await createImageBitmap(await (await fetch('/__samples/' + s.id)).blob());
    const { data, w, h } = pixels(bmp);
    t0 = t();
    const set = await seg.setImage({ data, w, h });
    const embedMs = Math.round(t() - t0);
    const row = { id: s.id, what: s.what, w, h, embedMs, embedDetail: set.ms };

    const pos = { x: s.click[0] * w, y: s.click[1] * h, positive: true };
    t0 = t();
    const r = await seg.segment({ points: [pos] });
    const first = Math.round(t() - t0);
    const times = [];
    for (let i = 0; i < repeat; i++) { const a = t(); await seg.segment({ points: [pos] }); times.push(Math.round(t() - a)); }
    row.click = { at: [Math.round(pos.x), Math.round(pos.y)], repeatMs: times, ...summary(r, first, w, h) };
    row.png = await overlay(bmp, w, h, r, [pos]);

    const neg = { x: s.negative[0] * w, y: s.negative[1] * h, positive: false };
    const nAt = Math.round(neg.y) * w + Math.round(neg.x);
    t0 = t();
    const r2 = await seg.segment({ points: [pos, neg] });
    row.negative = { at: [Math.round(neg.x), Math.round(neg.y)], wasOn: r.mask[nAt], nowOn: r2.mask[nAt], ...summary(r2, Math.round(t() - t0), w, h) };
    row.pngNegative = await overlay(bmp, w, h, r2, [pos, neg]);
    for (const pick of ['score', 'largest']) {
      const rp = await seg.segment({ points: [pos], pick, geometry: false });
      row['pick_' + pick] = { index: rp.index, share: +(count(rp.mask) / (w * h)).toFixed(3) };
    }
    res.samples.push(row);
  }
  seg.dispose();
  return res;
}, { samples: SAMPLES, backend, repeat, threads });

for (const s of report.samples) {
  writeFileSync(join(out, `${s.id}-${backend}.png`), Buffer.from(s.png, 'base64'));
  writeFileSync(join(out, `${s.id}-${backend}-negative.png`), Buffer.from(s.pngNegative, 'base64'));
  delete s.png; delete s.pngNegative;
}
writeFileSync(join(out, `report-${backend}.json`), JSON.stringify(report, null, 2));
await browser.close();
stop();

const ms = (n) => String(n).padStart(5) + ' ms';
const corners = (q) => (q ? q.map((p) => `(${p})`).join(' ') : 'none');
console.log(`\nbackend ${report.load.info.backend} (asked for ${backend}), ${report.load.info.threads} thread(s), cross-origin isolated: ${report.isolated}, WebGPU in browser: ${report.gpu}, cores: ${report.cores}`);
console.log(`model load ${ms(report.load.ms)} (download ${report.load.info.ms?.download ?? '?'} ms; progress ${report.load.progress.map((p) => p[0]).join(' ')})`);
console.log(`queue: three setImage calls in a row -> ${report.queue.outcomes.join(', ')}; same key again cached: ${report.queue.sameKeyCached}`);
for (const s of report.samples) {
  const c = s.click, n = s.negative;
  console.log(`\n${s.id} ${s.what} ${s.w}x${s.h}: embedding ${ms(s.embedMs)} (prepare ${s.embedDetail?.prep} ms, encoder ${s.embedDetail?.encode} ms)`);
  console.log(`  click ${c.at}: first ${ms(c.ms)}, repeats ${c.repeatMs.join('/')} ms; picked candidate ${c.index} of ${c.candidates.map((x) => `${x.score}/${(x.share * 100).toFixed(0)}%`).join(' ')}; mask covers ${(c.share * 100).toFixed(0)}%`);
  console.log(`    corners (${c.quadKind}, fit ${c.quadFit}): ${corners(c.quad)}`);
  console.log(`    box ${JSON.stringify(c.box)}; decode ${c.detail.decode} ms, upsample ${c.detail.upsample} ms, geometry ${c.detail.geometry} ms`);
  console.log(`  + negative click ${n.at}: ${ms(n.ms)}; the point was ${n.wasOn ? 'in' : 'out of'} the mask, now ${n.nowOn ? 'in' : 'out of'} it; mask covers ${(n.share * 100).toFixed(0)}%; corners ${corners(n.quad)}`);
  console.log(`  pick 'score' -> candidate ${s.pick_score.index} (${(s.pick_score.share * 100).toFixed(0)}%), 'largest' -> candidate ${s.pick_largest.index} (${(s.pick_largest.share * 100).toFixed(0)}%)`);
}
if (external.length) console.log('\nREQUESTS TO OTHER ORIGINS:\n  ' + external.join('\n  '));
if (problems.length) console.log('\nconsole problems:\n  ' + [...new Set(problems)].join('\n  '));
console.log(`\nimages in ${out}/`);
process.exit(external.length || problems.length ? 1 : 0);
