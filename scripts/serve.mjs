// Dev server: serves web/ with /core/ mapped to src/core/ (or dist/ with --dist).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const dist = process.argv.includes('--dist');
const port = Number(process.env.PORT || 8080);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  path = normalize(path).replace(/^(\.\.[/\\])+/, '');
  const file = dist ? join('dist', path) : path.startsWith('/core/') ? join('src', path) : join('web', path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, () => console.log(`http://localhost:${port}`));
