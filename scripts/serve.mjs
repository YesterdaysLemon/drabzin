// Serves the app. Dev: web/ with /core/ mapped to src/core/. Production (--dist): the built
// dist/, which is what the Docker image runs (PORT, default 8080).
//   /healthz  {"ok":true,"sha":"<commit>"} once dist/ is built (503 before), for Deploy Manager.
// Everything runs in the browser, so the server only hands out files. The Content Security
// Policy keeps it that way: the page can load and talk to nothing but this site.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, posix } from 'node:path';

const dist = process.argv.includes('--dist');
const port = Number(process.env.PORT || 8080);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
};
const headers = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // Only this site, and no eval: 'wasm-unsafe-eval' lets the page compile WebAssembly (the
  // segmentation model's runtime) without allowing eval() or new Function().
  'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  // Cross-origin isolation lets WebAssembly use several threads (SharedArrayBuffer). The page
  // loads nothing from other sites, so require-corp costs nothing. Served without these headers
  // (another host) the model still runs, on one thread.
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
};
const build = () => {
  try { return JSON.parse(readFileSync(join('dist', 'build.json'), 'utf8')); } catch { return { sha: process.env.GIT_SHA || 'dev' }; }
};

// The built files never change inside a running container: keep them, with an ETag each. Big
// files (the model's WebAssembly and weights, ~80 MB together) keep only their ETag and are
// read again when someone needs the bytes, so they do not sit in memory.
const KEEP = 4_000_000;
const cache = new Map();
async function load(file, needBody = true) {
  const hit = dist ? cache.get(file) : null;
  if (hit && (hit.body || !needBody)) return hit;
  const body = await readFile(file);
  const etag = hit?.etag || `"${createHash('sha1').update(body).digest('base64url')}"`;
  if (dist) cache.set(file, { body: body.length < KEEP ? body : null, etag });
  return { body, etag };
}

createServer(async (req, res) => {
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400, headers); res.end('bad request'); return; }
  if (path === '/healthz') {
    const ready = !dist || existsSync(join('dist', 'index.html'));
    res.writeHead(ready ? 200 : 503, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: ready, sha: build().sha }));
    return;
  }
  if (path === '/api/feedback') {
    // Live, the Cloudflare Worker in feedback/ answers this before it reaches us. Here in dev we
    // check the form the same way and print the email instead of sending it.
    const reply = (status, body) => { res.writeHead(status, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (dist) { reply(503, { ok: false, error: 'feedback is sent by the edge worker' }); return; }
    if (req.method !== 'POST') { reply(405, { ok: false }); return; }
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 20000) break; }
    const { validate, buildEmail } = await import('../feedback/worker.js');
    let v;
    try { v = validate(JSON.parse(raw)); } catch { v = { ok: false, status: 400, error: 'bad JSON' }; }
    if (!v.ok) { reply(v.status, { ok: false, error: v.error }); return; }
    if (!v.data.bot) { const m = buildEmail(v.data); console.log(`\n--- feedback (dev: not sent) ---\nSubject: ${m.subject}\n\n${m.text}\n---`); }
    reply(200, { ok: true, dev: true });
    return;
  }
  if (path.endsWith('/')) path += 'index.html';
  // URL paths are always '/'-separated (a Windows normalize would turn /core/ into \core\).
  path = posix.normalize(path).replace(/^(\.\.\/)+/, '');
  const file = dist ? join('dist', path) : path.startsWith('/core/') ? join('src', path)
    : path.startsWith('/vendor/ort/') ? join('node_modules/onnxruntime-web/dist', path.slice(12))
    : path.startsWith('/models/') ? join('models', path.slice(8)) : join('web', path);
  try {
    const { body, etag } = await load(file, false);
    const h = { ...headers, 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); res.end(); return; }
    res.writeHead(200, h);
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(body ?? (await load(file)).body);
  } catch {
    res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(port, () => console.log(JSON.stringify({ msg: 'listening', port, mode: dist ? 'dist' : 'dev', sha: dist ? build().sha : 'dev' })));
