// Drive the page in headless Chromium like a person would: load an image, pick the design
// and background colours with real clicks, turn on "Uneven light", and save screenshots.
//
//   node scripts/ui-smoke.mjs [image] [--design x,y] [--bg x,y] [--url http://localhost:8091] [--quick] [--select x,y] [--dist]
//
// --quick only loads the image and saves 1-loaded.png (any sample, as the app first traces it).
// --select x,y first uses Find the design (click to select, needs models/ from fetch-models) there.
// --dist serves the production build (run npm run build first) instead of the dev files.
//
// Points are in the image's own pixels. Screenshots go to .out/ui/. Starts its own server on a
// free port unless --url is given. Exits non-zero if the page logs an error or a step fails.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const pt = (s) => s && s.split(',').map(Number);
const image = args[0] && !args[0].startsWith('--') ? args[0] : null;
const out = '.out/ui';
mkdirSync(out, { recursive: true });

const freePort = () => new Promise((res) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
let server = null, url = opt('--url');
if (!url) {
  const port = await freePort();
  server = spawn(process.execPath, ['scripts/serve.mjs', ...(args.includes('--dist') ? ['--dist'] : [])], { stdio: 'ignore', env: { ...process.env, PORT: String(port) } });
  url = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(url); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
}

const browser = await chromium.launch();
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);

  // A drawn test card: n dark shapes on paper, shaded towards the right.
  const addCard = (name, n) => page.evaluate(async ([name, n]) => {
    const c = new OffscreenCanvas(900, 600), g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 900, 0);
    grad.addColorStop(0, '#f2eee6'); grad.addColorStop(1, '#5c5a55');
    g.fillStyle = grad; g.fillRect(0, 0, 900, 600);
    g.fillStyle = 'rgba(40, 32, 28, 0.92)';
    for (let i = 0; i < n; i++) { g.beginPath(); g.arc(120 + i * 135, 300, 50, 0, 7); g.fill(); g.fillRect(100 + i * 135, 120, 40, 360); }
    const blob = await c.convertToBlob({ type: 'image/png' });
    const dt = new DataTransfer(); dt.items.add(new File([blob], name, { type: 'image/png' }));
    const inp = document.getElementById('file'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
  }, [name, n]);
  // An image: the one given, or the test card.
  if (image) await page.setInputFiles('#file', image);
  else await addCard('test-card.png', 6);
  const settle = async () => { await page.waitForTimeout(400);   // past the 200 ms input debounce
    await page.waitForFunction(() => document.getElementById('busy').hidden && window.__drabzin.last, null, { timeout: 60000 }); };
  await settle();
  const stats = () => page.$eval('#stats', (el) => el.innerText.replace(/\n/g, ' · '));
  console.log('loaded:', await stats());
  await page.screenshot({ path: `${out}/1-loaded.png` });
  const select = pt(opt('--select'));
  if (select) {
    await page.click('#segPick');
    await page.waitForFunction(() => /Now click/.test(document.getElementById('segStatus').innerText), null, { timeout: 120000 });
    await page.click('[data-view="photo"]');
    const p = await page.evaluate(([sx, sy]) => {
      const c = window.__drabzin.cam.photo, box = document.getElementById('viewer').getBoundingClientRect();
      return { x: box.left + (sx - c.x) * c.s, y: box.top + (sy - c.y) * c.s };
    }, select);
    await page.mouse.click(p.x, p.y);
    await page.waitForFunction(() => /Found it|Nothing found|Sorry/.test(document.getElementById('segStatus').innerText), null, { timeout: 60000 });
    const found = await page.evaluate(() => ({ status: document.getElementById('segStatus').innerText, corners: window.__drabzin.corners?.map((c) => [Math.round(c.x), Math.round(c.y)]), mask: !document.getElementById('segMaskRow').hidden }));
    if (!/Found it/.test(found.status) || !found.mask) throw new Error(`find the design failed: ${JSON.stringify(found)}`);
    await page.screenshot({ path: `${out}/0-selected-corners.png` });
    await settle();
    console.log('selected:', JSON.stringify(found.corners));
    console.log('         ', await stats());
    await page.click('[data-view="overlay"]');
    await page.screenshot({ path: `${out}/0-selected.png` });
    // The selection is part of the tab: a reload brings back the corners and the mask.
    const before = await stats();
    await page.waitForTimeout(600);
    await page.reload();
    await settle();
    const kept = await page.evaluate(() => ({ corners: window.__drabzin.corners?.map((c) => [Math.round(c.x), Math.round(c.y)]), mask: !document.getElementById('segMaskRow').hidden }));
    if (!kept.mask || JSON.stringify(kept.corners) !== JSON.stringify(found.corners) || (await stats()) !== before) throw new Error(`a reload lost the selection: ${JSON.stringify(kept)}`);
  }
  if (args.includes('--quick')) {
    console.log('warnings:', await page.$eval('#warnings', (el) => el.innerText || '(none)'));
    throw Object.assign(new Error('quick'), { quick: true });
  }

  // Click a spot of the picture (image px) in the current view.
  const clickImage = async ([sx, sy]) => {
    const p = await page.evaluate(([sx, sy]) => {
      const S = window.__drabzin, box = document.getElementById('viewer').getBoundingClientRect();
      let x = sx, y = sy, c = S.cam.photo;
      if (S.view !== 'photo') { const r = S.last.result; x = (sx / S.src.w) * r.widthMM; y = (sy / S.src.h) * r.heightMM; c = S.cam.mm; }
      return { x: box.left + (x - c.x) * c.s, y: box.top + (y - c.y) * c.s };
    }, [sx, sy]);
    await page.mouse.click(p.x, p.y);
  };
  const size = await page.evaluate(() => [window.__drabzin.src.w, window.__drabzin.src.h]);
  const design = pt(opt('--design')) || [Math.round(size[0] * 0.133), Math.round(size[1] * 0.5)];
  const bg = pt(opt('--bg')) || [Math.round(size[0] * 0.05), Math.round(size[1] * 0.08)];

  await page.click('#pickDesign');
  if (!(await page.$eval('#viewer', (el) => el.classList.contains('picking')))) throw new Error('pick mode did not start');
  await clickImage(design);
  await settle();
  await page.click('#pickBg');
  await clickImage(bg);
  await settle();
  const picked = await page.evaluate(() => ({ colors: window.__drabzin.last.colors, level: document.getElementById('level').value, status: document.getElementById('pickStatus').innerText }));
  if (!picked.colors.design) throw new Error('no design colour after picking');
  console.log('picked:', JSON.stringify(picked), '\n       ', await stats());
  await page.locator('#pickDesign').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/2-picked.png` });

  await page.check('#adaptive');
  await settle();
  console.log('uneven light:', await stats());
  await page.click('[data-view="result"]');
  await page.screenshot({ path: `${out}/3-uneven-light-result.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.locator('#pickDesign').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/4-phone.png` });
  await page.setViewportSize({ width: 1280, height: 800 });

  // Tabs: a second image opens beside the first, and each keeps its own work, also after a reload.
  const first = await page.evaluate(() => ({ id: window.__drabzin.current, level: document.getElementById('level').value, adaptive: document.getElementById('adaptive').checked, picks: !!window.__drabzin.pickDesign }));
  await page.click('[data-view="overlay"]');
  const onLine = await page.evaluate(() => {   // a point on the second cut line, in page px
    const S = window.__drabzin, q = S.last.result.paths[1].pts[0], c = S.cam.mm, box = document.getElementById('viewer').getBoundingClientRect();
    return { x: box.left + (q.x - c.x) * c.s, y: box.top + (q.y - c.y) * c.s };
  });
  await page.mouse.click(onLine.x, onLine.y);   // select it...
  await page.keyboard.press('Delete');         // ...and delete it
  const removed = await page.evaluate(() => window.__drabzin.removed.size);
  if (removed !== 1) throw new Error(`clicking a line and pressing Delete removed ${removed}`);
  await addCard('second-card.png', 3);
  await settle();
  const second = await page.evaluate(() => ({ tabs: document.querySelectorAll('#designs .design').length, level: document.getElementById('level').value, adaptive: document.getElementById('adaptive').checked, picks: !!window.__drabzin.pickDesign }));
  if (second.tabs !== 2 || second.picks || second.adaptive) throw new Error(`second image should start fresh in a new tab: ${JSON.stringify(second)}`);
  await page.locator('#designs .design').nth(0).locator('.open').click();
  await settle();
  const back = await page.evaluate(() => ({ id: window.__drabzin.current, level: document.getElementById('level').value, adaptive: document.getElementById('adaptive').checked, picks: !!window.__drabzin.pickDesign, removed: window.__drabzin.removed.size }));
  if (back.id !== first.id || back.level !== first.level || back.adaptive !== first.adaptive || back.picks !== first.picks || back.removed !== removed) throw new Error(`switching back lost work: ${JSON.stringify({ first, removed, back })}`);
  await page.screenshot({ path: `${out}/5-tabs.png` });
  await page.waitForTimeout(600);   // let the save land
  await page.reload();
  await settle();
  const reloaded = await page.evaluate(() => ({ id: window.__drabzin.current, tabs: document.querySelectorAll('#designs .design').length, adaptive: document.getElementById('adaptive').checked, removed: window.__drabzin.removed.size }));
  if (reloaded.tabs !== 2 || reloaded.id !== first.id || reloaded.adaptive !== first.adaptive || reloaded.removed !== removed) throw new Error(`a reload lost work: ${JSON.stringify(reloaded)}`);
  console.log(`tabs: switch and reload keep settings and ${removed} deletion(s)`);
  page.once('dialog', (d) => d.accept());
  await page.locator('#designs .design').nth(1).locator('.close').click();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.querySelectorAll('#designs .design').length);
  if (after !== 1) throw new Error(`closing a tab left ${after}`);

  // The DXF download: R12 polylines, curves as arcs (vertex bulges, group code 42).
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportDxf')]);
  const dxf = readFileSync(await dl.path(), 'utf8').split(/\r?\n/);
  const polylines = dxf.filter((l) => l === 'POLYLINE').length;
  const bulges = dxf.filter((l, i) => i % 2 === 0 && l.trim() === '42').length;
  if (!dxf.includes('AC1009') || !polylines) throw new Error('the DXF has no R12 polylines');
  console.log(`dxf: ${dl.suggestedFilename()}, ${polylines} polylines, ${bulges} arcs`);

  // Light and dark: the button flips the theme, and the choice survives a reload.
  const startTheme = await page.evaluate(() => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  await page.click('#theme');
  const flipped = await page.evaluate(() => document.documentElement.dataset.theme);
  if (!flipped || flipped === startTheme) throw new Error(`the theme button did not switch (${startTheme} -> ${flipped})`);
  await page.screenshot({ path: `${out}/6-${flipped}.png` });
  await page.reload();
  await settle();
  if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== flipped) throw new Error('the theme was not remembered');
  console.log(`theme: ${startTheme} -> ${flipped}, kept after a reload`);

  // Feedback: an empty message is stopped with a hint; a real one is sent (the dev server
  // checks it like the live Worker does and prints the email).
  // Production builds and the live site leave /api/feedback to the edge Worker, which really emails:
  // answer it here as the Worker would.
  if (args.includes('--dist') || opt('--url')) await page.route('**/api/feedback', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await page.click('#feedback');
  await page.waitForSelector('#fbDialog[open]');
  await page.click('#fbSend');
  const emptyHint = await page.$eval('#fbStatus', (el) => el.textContent);
  if (!emptyHint) throw new Error('an empty message gave no hint');
  await page.check('input[name="kind"][value="idea"]');
  await page.fill('#fbMessage', 'UI smoke: tabs work well. Could the app read PDF files too?');
  await page.selectOption('#fbEase', 'easy');
  await page.fill('#fbEmail', 'smoke@example.com');
  await page.click('#fbSend');
  await page.waitForFunction(() => /Thank you/.test(document.getElementById('fbStatus').textContent), null, { timeout: 10000 });
  await page.screenshot({ path: `${out}/7-feedback.png` });
  await page.waitForFunction(() => !document.getElementById('fbDialog').open, null, { timeout: 5000 });
  console.log('feedback: empty message stopped, a real one sent');

  // Languages: every word changes, Arabic-script languages turn the page right-to-left, the
  // machine-translation note shows, no key shows raw, and nothing is wider than the window.
  const { DICT } = await import('../web/i18n.js');
  for (const [lang, w, h] of [['fa', 1280, 800], ['ar', 1280, 800], ['ur', 1280, 800], ['hi', 1280, 800], ['fa', 390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.selectOption('#lang', lang);
    await page.waitForTimeout(200);
    const got = await page.evaluate(() => ({
      dir: document.documentElement.dir, lang: document.documentElement.lang,
      dxf: document.getElementById('exportDxf').textContent, note: !document.getElementById('mtNote').hidden,
      raw: [...document.querySelectorAll('[data-i18n]')].filter((el) => el.textContent === el.dataset.i18n).map((el) => el.dataset.i18n),
      stats: document.getElementById('stats').innerText,
      wide: document.documentElement.scrollWidth - innerWidth,
    }));
    const wantDir = lang === 'hi' ? 'ltr' : 'rtl';
    if (got.dir !== wantDir || got.lang !== lang || got.dxf !== DICT[lang]['top.dxf'] || !got.note || got.raw.length || !got.stats.includes(DICT[lang]['stat.size']) || got.wide > 0)
      throw new Error(`${lang} at ${w}px: ${JSON.stringify(got)}`);
    await page.screenshot({ path: `${out}/8-${lang}-${w}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('#feedback');
  await page.screenshot({ path: `${out}/8-fa-feedback.png` });
  await page.click('#fbCancel');
  await page.click('#toEnglish');
  if ((await page.evaluate(() => [document.documentElement.dir, document.getElementById('mtNote').hidden].join())) !== 'ltr,true') throw new Error('"English" did not switch back');
  console.log('languages: fa, ar, ur, hi translated (right-to-left where needed), no raw keys, no sideways scroll');
} catch (e) {
  if (!e.quick) throw e;
} finally {
  await browser.close();
  server?.kill();
}
if (errors.length) { console.error('page errors:\n ', errors.join('\n  ')); process.exit(1); }
console.log(`ok, screenshots in ${out}/`);
