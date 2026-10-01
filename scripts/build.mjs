// Static build: dist/ = web/ + src/core/ as dist/core/. Deploy dist/ to any static host.
import { cpSync, rmSync, mkdirSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync('web', 'dist', { recursive: true });
cpSync('src/core', 'dist/core', { recursive: true, filter: (f) => !f.endsWith('synth.js') });
console.log('built dist/');
