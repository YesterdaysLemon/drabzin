// Downloads the pinned Segment Anything model files into models/ (git-ignored), checking
// each file's SHA-256. The site serves them from its own origin, so the app never talks to a
// third party at run time; this script is the only thing that does, and only at build time.
//
//   node scripts/fetch-models.mjs          download what is missing or wrong
//   node scripts/fetch-models.mjs --check  only verify (exit 1 when something is missing)
//
// What to fetch (repo, exact revision, file names and hashes) lives in web/segment/models.json,
// which the in-browser worker reads too.
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const manifest = JSON.parse(readFileSync('web/segment/models.json', 'utf8'));
const dir = join('models', manifest.id);
const checkOnly = process.argv.includes('--check');
const MB = (n) => (n / 1e6).toFixed(1) + ' MB';

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function download(url, to, expect) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
  const hash = createHash('sha256');
  let got = 0;
  const tmp = to + '.part';
  const source = Readable.fromWeb(res.body);
  source.on('data', (d) => { hash.update(d); got += d.length; });
  await pipeline(source, createWriteStream(tmp));
  const digest = hash.digest('hex');
  if (digest !== expect) {
    rmSync(tmp, { force: true });
    throw new Error(`SHA-256 mismatch (got ${digest}, expected ${expect})`);
  }
  renameSync(tmp, to);
  return got;
}

mkdirSync(dir, { recursive: true });
let bad = 0;
for (const [key, f] of Object.entries(manifest.files)) {
  const file = join(dir, f.name);
  if (existsSync(file) && (await sha256(file)) === f.sha256) {
    console.log(`ok       ${key.padEnd(11)} ${f.name} (${MB(statSync(file).size)})`);
    continue;
  }
  if (checkOnly) { console.error(`MISSING  ${key.padEnd(11)} ${f.name}`); bad++; continue; }
  const url = `https://huggingface.co/${manifest.source.repo}/resolve/${manifest.source.revision}/${f.from}`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      process.stdout.write(`fetching ${key.padEnd(11)} ${f.name} ... `);
      const n = await download(url, file, f.sha256);
      console.log(`${MB(n)} ok`);
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      console.log(`failed (${e.message})`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  if (lastError) { console.error(`could not fetch ${url}`); bad++; }
}
if (bad) { console.error(`${bad} model file(s) missing`); process.exit(1); }
console.log(`models ready in ${dir}/`);
