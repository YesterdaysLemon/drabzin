// Every language has every phrase, with the same {placeholders} and markup, and every key the
// page uses exists.   node --test test/i18n.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DICT, LANGS } from '../web/i18n.js';

const vars = (s) => new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
const tags = (s) => [...String(s).matchAll(/<\/?(\w+)/g)].map((m) => m[1]).sort().join(',');
// An English plural function shows its placeholders when called with marked values.
const englishVars = (v) => (typeof v === 'function'
  ? new Set(['n', 'mm', 'a', 's'].filter((k) => v({ n: '§n', mm: '§mm', a: '§a', s: '§s' }).includes(`§${k}`)))
  : vars(v));

test('every language listed has a dictionary, and the other way round', () => {
  assert.deepEqual(LANGS.map((l) => l.id).sort(), Object.keys(DICT).sort());
});

for (const { id } of LANGS.filter((l) => l.id !== 'en')) {
  test(`${id}: every key, same placeholders and markup, nothing left in English`, () => {
    const en = DICT.en, tr = DICT[id];
    assert.deepEqual(Object.keys(tr).filter((k) => !(k in en)), [], 'keys that English does not have');
    for (const [key, ev] of Object.entries(en)) {
      const v = tr[key];
      assert.ok(typeof v === 'string' || typeof v === 'function', `${id} is missing ${key}`);
      if (typeof v === 'string') {
        assert.ok(v.trim(), `${id} ${key} is empty`);
        assert.deepEqual([...vars(v)].sort(), [...englishVars(ev)].sort(), `${id} ${key} placeholders`);
        if (typeof ev === 'string') {
          assert.equal(tags(v), tags(ev), `${id} ${key} markup`);
          // Words a translation must not just copy (brand names, units and short codes are fine).
          if (/[a-z]{4,}/.test(ev.replace(/DXF|SVG|CNC|AutoCAD|JPEG|HEIC|PDF|Ctrl\+V|Shift|Delete|iPhone|MB/g, ''))) assert.notEqual(v, ev, `${id} ${key} is still English`);
        }
      }
    }
  });
}

test('every key the page and the app use exists', () => {
  const html = readFileSync('web/index.html', 'utf8'), app = readFileSync('web/app.js', 'utf8');
  const used = new Set([
    ...[...html.matchAll(/data-i18n(?:-html|-title|-aria-label|-placeholder)?="([^"]+)"/g)].map((m) => m[1]),
    ...[...app.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]),
    ...[...app.matchAll(/(?:fbSay|segSay)\('([\w.]+)'/g)].map((m) => m[1]),
    ...[...app.matchAll(/key: '([\w.]+)'/g)].map((m) => m[1]),
    // built from names: t(`what.${mode}`), t(`mode.${mode}`), t(`geo.warn.${code}`)
    ...['outline', 'centreline', 'geometric'].flatMap((m) => [`what.${m}`, `mode.${m}`]),
    ...['loose', 'tinyHoles', 'tightHoles', 'thin'].map((c) => `geo.warn.${c}`),
  ]);
  const missing = [...used].filter((k) => !(k in DICT.en));
  assert.deepEqual(missing, []);
});
