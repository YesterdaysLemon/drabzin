# Drabzin Vectorizer

Turns images of door and gate designs into clean DXF cut paths for CO2 lasers, fiber lasers and CNC routers. It handles photos, scans, screenshots and stock images. The output opens directly in AutoCAD.

Everything runs in the browser. Images are never uploaded, and the app is plain static files, so it can be hosted anywhere.

## Modes

| Mode | Use it for | What it does |
|---|---|---|
| **Solid shapes** (default) | Filled designs: panels, arches, floral lattices, logos, calligraphy | Traces the boundary of every solid region as smooth closed curves. Sharp corners stay sharp. Separate pieces that would fall out are flagged. **Straight edges** turns polygon designs (Islamic star patterns) into exact straight-edged polygons. |
| **Line drawing** | Outline drawings and outlined lettering, where the drawn line *is* the cut path | Traces the centre of each line and joins touching pieces. Short gaps close to the nearest end; longer ones (a faint stretch of line) only between ends that point at each other. Stubs at junctions are dropped and ends that stop just short of a line are extended onto it. Ends that still touch nothing are circled in red. |
| **Geometric** (beta) | Photos of regular strapwork lattices | Rebuilds the line network with exact angles (auto-detected 90/45/30/22.5/18/15°) and optional repeat-grid / rotational / mirror symmetry, then regenerates uniform straps. |

**Auto** picks Solid shapes or Line drawing from the image.

### Lines and arcs

Curves are written as true arcs, the way CAD draws them and CNC and laser controllers cut them (G2/G3), not as hundreds of short lines: `src/core/fit.js` fits lines and arcs to each traced edge within 0.3 px of the crop (at least 0.02 mm), keeping sharp corners. In the DXF an arc is a polyline vertex bulge (group 42), in the SVG an `A` command. **Make edges straight** keeps polygon designs all-straight, and *More settings > Curves in the file* can switch arcs off for a machine that cannot read them.

## Workflow

1. Choose, drop or paste an image.
2. Click **Find the design**, then a plain spot near the middle of the panel, paper or board: the four crop corners jump onto its edges and, with **Ignore everything outside it**, the desk or wall around it no longer counts. Or drag the four corners yourself. For a photo taken at an angle, the corners go on the panel's real corners and the result is straightened.
3. Enter the real width or height in mm.
4. Check the **Overlay** and **Result** views. Click a path to select it (Shift-click for several), then press Delete to remove it. Ctrl+Z undoes.
5. **Download DXF.** The output uses AutoCAD R12 format, millimetres, with closed polylines on layer `CUT`.

By default the design is whatever differs from the colour at the crop's border. When that guess is wrong (a dark frame around the crop, a desk in the photo, pencil shading), **Design colour** and **Background colour** let the user click one spot of each: every pixel is then measured along the line from the background colour to the design colour, so 0.5 on the cut-off is exactly halfway. **Uneven light** divides out the light falling on the background (a smooth light map measured on a coarse grid, robust to big solid shapes) for photos with a shadow or a lamp on one side. **Swap filled and empty areas** flips the result.

Each image opens in its own tab. A tab keeps its image, crop, settings and deletions in the browser's IndexedDB (`web/designs.js`), so switching tabs or reloading the page keeps the work. Nothing is uploaded.

### Languages, theme and feedback

- **Languages:** English, and machine translations into Persian, Arabic, Urdu and Hindi (`web/i18n.js`), picked from the top bar or from the browser's language. Arabic, Persian and Urdu turn the page right-to-left. A note under the bar says the translation was made by a machine, with a link back to English. `test/i18n.test.mjs` checks every language has every phrase with the same placeholders.
- **Light and dark:** follows the computer until the sun/moon button is used; the choice is remembered (`web/boot.js` applies it before the page draws).
- **Feedback:** the Feedback button opens a short form (what it is about, the message, how easy the app is, an optional email for a reply, and optionally the current settings, never the picture). It posts to `/api/feedback`, which the Cloudflare Worker in `feedback/worker.js` turns into an email to the app's maker (see Deployment).

See [docs/requirements.md](docs/requirements.md) for the shop's requirements and how each reference design is handled.

## Development

```sh
npm install          # dev-only: jpeg-js for the sample tests
npm run dev          # http://localhost:8080 (serves web/ with src/core mapped to /core)
npm run build        # static site in dist/
npm run preview      # build + serve dist/
npm test             # geometric accuracy test, arc fitting and colour/light tests
npm run samples      # trace every samples/*.jpg into .out/samples (samples/ is git-ignored)
node test/trace.mjs [filter]   # trace samples/*.jpg with samples/params.json (crops, picks...) into .out/trace
node scripts/ui-smoke.mjs [image] [--quick] [--dist]   # headless browser: picks, uneven light, tabs, DXF, theme, feedback, all languages
node scripts/fetch-models.mjs   # download the click-to-select model into models/ (~40 MB, git-ignored); run before build
node scripts/segment-check.mjs [--backend webgpu]   # headless: click-to-select on samples/ -> .out/segment
node --test test/segment-geometry.test.mjs          # the mask -> box / four corners maths
```

### Layout

```
src/core/          processing engine (plain ES modules, no dependencies)
  raster.js        colour→material field, perspective crop, blur, threshold, symmetry averaging
  contour.js       sub-pixel marching squares, corner-preserving smoothing, path joining
  skeleton.js      thinning + centreline tracing + spur pruning
  lines.js         constrained line search (geometric mode)
  geometry.js      segment merging, symmetry enforcement, planar graph clean-up
  bands.js         strap offsetting and cut checks (uses vendored clipper-lib, Boost licence)
  fit.js           lines + arcs through traced edges (tolerance-bounded)
  export.js        DXF (R12, arcs as bulges) and SVG writers
  pipeline.js      the three modes wired together
  synth.js         synthetic patterns + "bad photo" degrader for tests
web/               the app (index.html, app.js, worker.js, style.css; designs.js: saved tabs)
test/              eval.mjs (synthetic accuracy), fit/ink tests, samples.mjs + trace.mjs (real images)
web/segment/       click-to-select: segment.js (API), worker.js, sam.js, geometry.js, models.json (pins)
```

### Click to select (Segment Anything, in the browser)

One click on the panel, sheet or wood slice in a photo gives its mask, so the background can be ignored and the four crop corners snapped onto it. It runs the SlimSAM-77 model (Apache-2.0, ~40 MB) with onnxruntime-web in a Web Worker: on the GPU (WebGPU) when the browser has one (about 0.6 s per picture), otherwise as multi-threaded WebAssembly (1.5 to 6 s). The model is fetched only the first time the tool is used and kept in the browser's cache storage; the picture never leaves the browser, and the library, its WebAssembly and the model weights are all served from the site's own origin.

```js
import { createSegmenter } from './segment/segment.js';
const seg = createSegmenter();
await seg.ready((fraction, text) => {});                 // first use: loads the model
await seg.setImage({ data: rgba, w, h });                // once per picture
const r = await seg.segment({ points: [{ x, y, positive: true }] });   // per click, ~0.1 s
// r.mask (Uint8Array w*h, 1 = object), r.score, r.quad (4 corners, clockwise from top-left), r.box
```

`scripts/fetch-models.mjs` downloads the pinned files (exact revision, SHA-256 checked); `scripts/build.mjs` copies them and the library into `dist/`; the Dockerfile runs both. The server sends cross-origin isolation headers (needed for WebAssembly threads) and a Content Security Policy with `'wasm-unsafe-eval'`; on a host without those headers the tool still works, on one thread.

### Accuracy (synthetic geometric test)

`npm test` renders known patterns, degrades them into fake photos (perspective, blur, noise, uneven lighting), runs the geometric engine, and compares the result with the ground truth:

| Case | Recall | Precision | Median error | 95th pct error |
|---|---|---|---|---|
| 8-point star gate panel, angled photo | 100% | 100% | 0.11 mm | 0.40 mm |
| same, mirror symmetry | 100% | 100% | 0.08 mm | 0.26 mm |
| same, 2×4 repeat grid | 100% | 99.8% | 0.06 mm | 0.62 mm |
| 10-fold rosette, blurry photo | 100% | 91% | 0.12 mm | 0.50 mm |
| same, 10-fold symmetry | 100% | 91% | 0.08 mm | 0.20 mm |
