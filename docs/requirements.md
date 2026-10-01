# Requirements and what the samples showed

## The shop's answers

- **Machines:** CO2 laser, fiber laser and CNC router. Output must be clean cut paths; router-only concerns (bit size, inside corners) are optional checks.
- **Software:** AutoCAD. DXF is the deliverable, in mm, as closed polylines where possible.
- **Material thickness doesn't matter** to the vector work, so the main flow has no thickness, strap-width or minimum-metal settings.
- **Manual redraw time is 10 minutes to 6 hours per design.** That is the time this tool saves.

## The 10 reference designs

| # | Design | Kind | Handled by |
|---|---|---|---|
| 1 | Tapered fleur-de-lis panel (black + gold render, dimension labels) | filled shapes, colour, labels to crop | Solid shapes + crop + size by height (300 mm) |
| 2 | Arch with arabesque scrollwork and border | filled shapes | Solid shapes (flags 9 loose pieces) |
| 3 | 12-point star panel (brown/white, watermark) | polygonal strapwork | Solid shapes + Straight edges |
| 4 | "United Metal Factory" sign, outlined Arabic/English text | line drawing | Line drawing |
| 5 | "CC 1979" logo, white on black | filled shapes, inverted | Solid shapes (material = differs from border) |
| 6 | Square floral lattice | filled shapes | Solid shapes |
| 7 | Calligraphy panels (mixed colours, low quality) | filled shapes | Solid shapes |
| 8 | Acanthus/swirl outline drawing | line drawing | Line drawing |
| 9 | Drips shape with "shutterstock" watermark | filled shape + watermark | Solid shapes (watermark ignored by colour threshold) |
| 10 | Symmetric scroll border | filled shapes | Solid shapes |

Takeaways that shaped the design:

- Most inputs are **clean digital images, not blurry photos**. The common job is outlining filled regions, not rebuilding geometry.
- **Colour matters**: gold and pale highlights must count as material. That's why the tool uses Lab colour difference from the background rather than brightness.
- **Labels, dimensions and watermarks** are common, so a crop step and a sensible threshold are essential.
- **Loose pieces** (parts not joined to the main body) are a real fabrication problem and are flagged.
- Only a minority are strict geometric strapwork. The Geometric mode (exact angles + symmetry) is kept as a beta for photos of regular lattices.

## Not done yet

- Reading PDF and HEIC input directly (use a screenshot/JPEG for now).
- Router checks (bit diameter vs. small holes and tight inside corners) in the main flow.
- Arc/spline output (currently fine polylines, which AutoCAD and laser software handle well).
- Testing on real machines with real jobs.
