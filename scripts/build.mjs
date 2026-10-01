// Static build: dist/ = web/ + src/core/ as dist/core/. Deploy dist/ to any static host.
// dist/build.json records the commit being built (read straight from .git, so it works
// inside `docker build` without build args); the server's /healthz reports it.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync('web', 'dist', { recursive: true });
cpSync('src/core', 'dist/core', { recursive: true, filter: (f) => !f.endsWith('synth.js') });

// Click-to-select (Segment Anything) runs in the browser from this site's own files: the
// onnxruntime-web library and its WebAssembly (from node_modules, pinned in package.json) and
// the model weights (from models/, downloaded by scripts/fetch-models.mjs and git-ignored).
// A build without the weights still works but the tool cannot load; --require-models makes
// that an error (the Docker build uses it).
const ortDir = 'node_modules/onnxruntime-web';
mkdirSync('dist/vendor/ort', { recursive: true });
for (const f of ['ort.min.mjs', 'ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  cpSync(`${ortDir}/dist/${f}`, `dist/vendor/ort/${f}`);
}
const ortPkg = JSON.parse(readFileSync(`${ortDir}/package.json`, 'utf8'));
writeFileSync('dist/vendor/ort/SOURCE.txt', `onnxruntime-web ${ortPkg.version}
License: ${ortPkg.license}
Source: https://github.com/microsoft/onnxruntime
`);
const seg = JSON.parse(readFileSync('web/segment/models.json', 'utf8'));
const missing = Object.values(seg.files).filter((f) => !existsSync(`models/${seg.id}/${f.name}`) || statSync(`models/${seg.id}/${f.name}`).size !== f.bytes);
if (missing.length) {
  const msg = `segmentation model files missing in models/${seg.id}/ (run: node scripts/fetch-models.mjs)`;
  if (process.argv.includes('--require-models')) { console.error(msg); process.exit(1); }
  console.warn('warning: ' + msg);
} else {
  mkdirSync(`dist/models/${seg.id}`, { recursive: true });
  for (const f of Object.values(seg.files)) cpSync(`models/${seg.id}/${f.name}`, `dist/models/${seg.id}/${f.name}`);
  writeFileSync(`dist/models/${seg.id}/SOURCE.txt`, `${seg.name}
License: ${seg.license}
Source: ${seg.source.url} (revision ${seg.source.revision})
`);
}

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
