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
};
const headers = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const build = () => {
  try { return JSON.parse(readFileSync(join('dist', 'build.json'), 'utf8')); } catch { return { sha: process.env.GIT_SHA || 'dev' }; }
};

// The built files never change inside a running container: keep them, with an ETag each.
const cache = new Map();
async function load(file) {
  if (dist && cache.has(file)) return cache.get(file);
  const body = await readFile(file);
  const entry = { body, etag: `"${createHash('sha1').update(body).digest('base64url')}"` };
  if (dist) cache.set(file, entry);
  return entry;
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
  if (path.endsWith('/')) path += 'index.html';
  // URL paths are always '/'-separated (a Windows normalize would turn /core/ into \core\).
  path = posix.normalize(path).replace(/^(\.\.\/)+/, '');
  const file = dist ? join('dist', path) : path.startsWith('/core/') ? join('src', path) : join('web', path);
  try {
    const { body, etag } = await load(file);
    const h = { ...headers, 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); res.end(); return; }
    res.writeHead(200, h);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(port, () => console.log(JSON.stringify({ msg: 'listening', port, mode: dist ? 'dist' : 'dev', sha: dist ? build().sha : 'dev' })));
