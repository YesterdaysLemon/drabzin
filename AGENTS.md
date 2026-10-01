<!-- al-stack:project:start -->
## Al-stack project

Project: drabzin-vectorizer. Profile: web. Status: experimental.

Drabzin Vectorizer: turns images of door and gate designs into DXF cut paths for lasers and CNC routers, entirely in the browser (static site)

`al-stack.toml` records this project's setup and dependencies. Work from the checkout selected for the task; other branches/worktrees are optional history. Use `al-stack register .` once when starting work here. Local registration does not change the project's lifecycle.

Project commands:
- dev: `npm run dev`
- build: `npm run build`
- test: `npm test`
- preview: `npm run preview`

Edit project guidance outside this managed section. Use `al-stack configure` for its fields and `al-stack check .` for setup checks. Run the actual project checks for behavioral validation.
<!-- al-stack:project:end -->

# Drabzin Vectorizer

Turns a picture of a door or gate design into a DXF file for laser and CNC cutting. Built
for a metal shop: the people using it are designers who know conversational English, so
every word in the UI is plain, short and literal (see "Copy" below). README.md covers the
modes, workflow, engine layout and accuracy; docs/requirements.md the shop's answers.

## Copy

- Short sentences. Common words. Say what to do ("Move it left"), not how the engine works.
- No jargon in labels: "Colour cut-off", not "threshold"; "Loose pieces", not "islands";
  "Bar width", not "strap width"; counts use the right singular/plural (`count()` in app.js).
- Numbers the user sees must match what they see now (counts update after deletions).

## Engine decisions

- Cut paths are lines and arcs (`src/core/fit.js`), written as DXF R12 polyline bulges: the
  industry form CNC/laser CAM reads. Straight mode stays all-straight polygons.
- Colour picks are stored in source pixels; with a design colour the field is a projection
  from background to design colour (0.5 = halfway). Uneven light divides out a smooth light map.
- Tabs store each image (Blob), settings and deletions in IndexedDB (`web/designs.js`).
  Deletions are line indices: they re-apply only if the same settings give the same lines.
- Hard photos to try changes on: `samples/` (git-ignored) with `samples/params.json`, run by
  `node test/trace.mjs`. The metal rosette photo (09) flips tone between lit and shaded areas:
  no threshold fixes it, it needs the click-to-select step or an AI clean-up.

## Click-to-select (Segment Anything)

- `web/segment/`: `segment.js` (page API: `createSegmenter`, `ready`, `setImage`, `segment`, plus
  `maskToQuad`/`maskBox`), `worker.js` (module worker), `sam.js` (pre/post-processing, no model
  code), `geometry.js` (pure mask -> box / four corners, tested in `test/segment-geometry.test.mjs`),
  `models.json` (pins: Hugging Face repo + revision + SHA-256 + sizes, and the ORT wasm sizes).
- Model: `Xenova/slimsam-77-uniform`, **fp32** encoder + decoder (40 MB). The 8-bit quantised files
  are half the size but visibly worse on perforated metal photos (09), so do not switch to them
  without re-running `scripts/segment-check.mjs` on the samples. Runtime: `onnxruntime-web` pinned
  exactly in `package.json`; WebGPU build (`ort.min.mjs` + jsep wasm) when the browser has an
  adapter, else `ort.wasm.min.mjs` + plain wasm. Both are copied to `dist/vendor/ort/`.
- Nothing is fetched from another origin at run time. `models/` is git-ignored: `node
  scripts/fetch-models.mjs` fills it (SHA-256 checked), `scripts/build.mjs` copies it into
  `dist/models/` (`--require-models` makes missing files an error; the Dockerfile uses it).
  `scripts/serve.mjs` maps `/vendor/ort/` and `/models/` in dev, and sends COOP/COEP
  (cross-origin isolation: WebAssembly threads) and `script-src 'self' 'wasm-unsafe-eval'`.
- `segment()` picks among the model's three candidate masks with `pick`: `'object'` (default, the
  largest one scoring >= 0.5, i.e. the whole panel), `'score'`, `'largest'` or an index. Quad fit
  (`fitQuad`): convex hull -> least-area circumscribed four-sided shape -> sides refined on the hull;
  below 0.9 fit (a round plate) it falls back to the smallest upright rectangle (`kind: 'box'`).
- `node scripts/segment-check.mjs [--backend webgpu]` writes mask + corner overlays to `.out/segment/`.

## Languages

- English plus machine translations (fa, ar, ur, hi) in `web/i18n.js`; the page says they are
  machine-made. New words go into every language (the test fails otherwise). Keep them as plain
  as the English. Numbers stay Western digits; sizes are wrapped in a left-to-right isolate.
- HTML text uses `data-i18n` / `data-i18n-html` / `data-i18n-title` (etc.); app.js uses `t()`.

## Deployment

- Feedback: `/api/feedback` on the live hostname is the Cloudflare Worker `drabzin-feedback`
  (`feedback/worker.js`, route `drabzin.alirezaafshan.com/api/feedback`). It emails the one
  verified Email Routing destination of the account (bindings set at upload: `EMAIL` send_email
  restricted to it and to the sender `drabzin@alirezaafshan.com`, plus `TO`/`FROM` text). No
  API key. Redeploy by hand with the Cloudflare connector (script upload with those bindings);
  the site's CI does not deploy it. In dev, `scripts/serve.mjs` answers the same path and prints
  the email instead of sending it.

- Live at https://drabzin.alirezaafshan.com (Deploy Manager app `drabzin`, Caddy -> loopback
  3300, candidate 3301, container port 8080, `/healthz` reports the build SHA). Cloudflare
  proxies the hostname (A record to the VPS).
- Pushes to `main` run `.github/workflows/deploy.yml`: `npm test` (fails if accuracy drops),
  build, a production-server check, then the signed Deploy Manager webhook and a live SHA check.
- The image (`Dockerfile`) builds `dist/` and serves it with `scripts/serve.mjs --dist`: a tiny
  Node server with no dependencies, a strict Content Security Policy (the page can only talk
  to its own site, which backs the "never uploaded" promise) and ETag caching.

## Acceptance

- `npm test` and `npm run build` pass; `npm run preview` serves the app with no console errors.
- `node scripts/ui-smoke.mjs` passes (picks, uneven light, tabs + reload, DXF with arcs, theme,
  feedback form, every language with no sideways scroll), also
  with `--dist` after a build, and `--select 970,920` on `samples/09-rosette-metal-photo.jpg`
  (Find the design, needs `models/` from `scripts/fetch-models.mjs`).
- Live: `/healthz` reports the deployed commit; the page loads and an image traces.
