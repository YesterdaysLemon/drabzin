// Static build: dist/ = web/ + src/core/ as dist/core/. Deploy dist/ to any static host.
// dist/build.json records the commit being built (read straight from .git, so it works
// inside `docker build` without build args); the server's /healthz reports it.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync('web', 'dist', { recursive: true });
cpSync('src/core', 'dist/core', { recursive: true, filter: (f) => !f.endsWith('synth.js') });

function sha() {
  if (process.env.GIT_SHA) return process.env.GIT_SHA;
  try {
    const head = readFileSync('.git/HEAD', 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    if (existsSync(`.git/${ref}`)) return readFileSync(`.git/${ref}`, 'utf8').trim();
    const packed = readFileSync('.git/packed-refs', 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
    return packed ? packed.split(' ')[0] : 'unknown';
  } catch {
    return 'unknown';
  }
}
writeFileSync('dist/build.json', JSON.stringify({ sha: sha(), built: new Date().toISOString() }) + '\n');
console.log('built dist/');
