# Drabzin Vectorizer

Turns images of door and gate designs into clean DXF cut paths for CO2 lasers, fiber lasers and CNC routers. It handles photos, scans, screenshots and stock images. The output opens directly in AutoCAD.

Everything runs in the browser. Images are never uploaded, and the app is plain static files, so it can be hosted anywhere.

## Modes

| Mode | Use it for | What it does |
|---|---|---|
| **Solid shapes** (default) | Filled designs: panels, arches, floral lattices, logos, calligraphy | Traces the boundary of every solid region as smooth closed curves. Sharp corners stay sharp. Separate pieces that would fall out are flagged. **Straight edges** turns polygon designs (Islamic star patterns) into exact straight-edged polygons. |
| **Line drawing** | Outline drawings and outlined lettering, where the drawn line *is* the cut path | Traces the centre of each line, joins touching pieces, and bridges small gaps. |
| **Geometric** (beta) | Photos of regular strapwork lattices | Rebuilds the line network with exact angles (auto-detected 90/45/30/22.5/18/15°) and optional repeat-grid / rotational / mirror symmetry, then regenerates uniform straps. |

**Auto** picks Solid shapes or Line drawing from the image.

## Workflow

1. Choose, drop or paste an image.
2. Drag the four corners onto the design to crop out labels and dimensions. For a photo taken at an angle, put them on the panel's real corners and the result is straightened.
3. Enter the real width or height in mm.
4. Check the **Overlay** and **Result** views. Click a path to select it (Shift-click for several), then press Delete to remove it. Ctrl+Z undoes.
5. **Download DXF.** The output uses AutoCAD R12 format, millimetres, with closed polylines on layer `CUT`.

"Material" is whatever differs from the colour at the crop's border. Use **Swap material and background** if it picked the wrong side.

See [docs/requirements.md](docs/requirements.md) for the shop's requirements and how each reference design is handled.

## Development

```sh
npm install          # dev-only: jpeg-js for the sample tests
npm run dev          # http://localhost:8080 (serves web/ with src/core mapped to /core)
npm run build        # static site in dist/
npm run preview      # build + serve dist/
npm test             # synthetic accuracy test for the geometric engine
npm run samples      # trace every samples/*.jpg into .out/samples (samples/ is git-ignored)
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
  export.js        DXF (R12) and SVG writers
  pipeline.js      the three modes wired together
  synth.js         synthetic patterns + "bad photo" degrader for tests
web/               the app (index.html, app.js, worker.js, style.css)
test/              eval.mjs (synthetic accuracy), samples.mjs (real images)
```

### Accuracy (synthetic geometric test)

`npm test` renders known patterns, degrades them into fake photos (perspective, blur, noise, uneven lighting), runs the geometric engine, and compares the result with the ground truth:

| Case | Recall | Precision | Median error | 95th pct error |
|---|---|---|---|---|
| 8-point star gate panel, angled photo | 100% | 100% | 0.11 mm | 0.40 mm |
| same, mirror symmetry | 100% | 100% | 0.08 mm | 0.26 mm |
| same, 2×4 repeat grid | 100% | 99.8% | 0.06 mm | 0.62 mm |
| 10-fold rosette, blurry photo | 100% | 91% | 0.12 mm | 0.50 mm |
| same, 10-fold symmetry | 100% | 91% | 0.08 mm | 0.20 mm |
