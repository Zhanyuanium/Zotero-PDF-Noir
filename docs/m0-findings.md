# M0 Findings: How Zotero 10.0.6 Dark Mode Actually Renders PDF Images

Status: M0 complete (verified on Zotero 10.0.6, Firefox ESR 140, build 20261007153950).
All claims below were verified against the shipped bundle, not inferred from upstream docs.

> **Warning:** all pdf.js file/line numbers and function names below refer to the shipped
> bundle of build `20261007153950` only. After a Zotero upgrade they must be re-verified
> against the new bundle by symbol name, not by line number.

## Environment

| Item | Value |
| --- | --- |
| Zotero | 10.0.6 (x64), `C:\Program Files\Zotero` |
| Gecko base | Firefox ESR 140 (`platform.ini`, `mozilla-esr140`) |
| Plugin bundle | `resource/reader/pdf/build/pdf.mjs` inside `app/omni.ja` |
| Manifest requirement | `applications.zotero` must carry **all three** of `id`, `update_url`, `strict_max_version` |

## 1. Packaging: why the XPI was rejected

`manifest.json` using `applications.gecko` is not recognized by Zotero. Worse, a Zotero
extension manifest that omits `update_url` is parsed as invalid, and the installer reports
the generic "incompatible with this version of Zotero" dialog. Both were root causes of a
plugin that would not install.

Required shape:

```json
{
  "manifest_version": 2,
  "applications": {
    "zotero": {
      "id": "pdf-noir@zotero-plugins",
      "update_url": "https://.../update.json",
      "strict_min_version": "6.999",
      "strict_max_version": "10.*"
    }
  }
}
```

> `strict_max_version` was later widened from `10.0.*` to `10.*` at release
> time: a `10.0.*` ceiling would have locked every user out of updates the
> moment Zotero 10.1 shipped. `strict_min_version` remains `10.0.6`, the only
> release the plugin was actually verified against.

`onMainWindowLoad` / `onMainWindowUnload` must exist (even as no-ops) or Zotero logs a
warning on every window open.

`prefs.js` must live in the plugin root. Float defaults are unsafe: Firefox default prefs
have no float type, so `0.7` reads back as int `0`. Store numerics as strings.

## 2. Dark mode is not a CSS filter

`pdfjs/viewer.css` contains no `filter: invert`. The `img, svg { filter: invert(1) }` rule
in the reader's `inject.scss` applies only to the DOM snapshot/EPUB path, never to the PDF
canvas. The PDF canvas dark theme comes from the `Blender` class in the pdf.js fork.

Dark mode is signalled to the viewer realm by `window.theme`
(`{ background, foreground, invertImages }`), set by `pdf-view.js` `_updateColorScheme()`.

## 3. The hook that actually matters: `Blender`

`src/display/canvas.js` `beginDrawing()` (bundle line ~11460):

```js
if (typeof window !== 'undefined' && window.theme && !this.ctx.skipBlender) {
  this.blender = new Blender(this.ctx, window.theme);
  this.blender.pageWidth = viewport.width * Math.abs(transform ? transform[0] : 1);
  this.blender.pageHeight = viewport.height * Math.abs(transform ? transform[3] : 1);
}
```

`Blender`'s constructor (line ~10570) immediately overwrites context methods as **own
instance properties**:

```js
this.origDrawImage = this.ctx.drawImage.bind(this.ctx);
this.ctx.drawImage = (...args) => this.customDrawImage(args);
```

`unwrap()` restores them, and `endDrawing` calls it (line ~11595).

### Why every canvas-level probe failed

Wrapping `CanvasRenderingContext2D.prototype.drawImage`, installing per-context
`drawImage` accessors, and hooking `getContext` **all fail to observe real page paints**.
Blender constructs after those hooks are installed and overwrites the instance property
with a plain value, discarding the accessor chain. Evidence gathered:

- `watching context drawImage shape=accessor hasCell=true setHits=1` — the accessor was
  installed and was replaced exactly once, by Blender, at `beginDrawing`.
- `selftest A (ctx.drawImage): calls=1 shape=accessor watched=true` — a probe issued
  *before* `beginDrawing` is caught, proving the trap itself is alive.
- Zero `#N drawImage` lines for actual page paints, across many re-renders (every zoom
  level rebuilt page canvases at new sizes and the counters never moved).

Ruled out along the way: `transferControlToOffscreen` (absent from the bundle),
`bitmaprenderer`/`transferFromImageBitmap` (present only in the SVG cache → blob path,
irrelevant to page rendering), detached-method calls (`ctx.drawImage.call` and explicit
re-assignment both behave identically).

Consequence: **`customDrawImage` is the correct interception point for M1.** Canvas-level
instrumentation cannot work and should not be retried.

## 4. `customDrawImage` already computes what M1 needs

Bundle line ~10813. For every image it:

1. Resolves the source rect (handles the 3-, 5-, and 9-argument overloads).
2. Computes `entirePage` via `getTransformedBoundingBox`, with a 25% area tolerance.
3. Rasterizes the source region into an offscreen canvas and calls `getImageData` —
   so pixel data is **already in hand**, no extra GPU read-back is required.
4. Classifies into one of four types.

Classification (`type` defaults to `"overlay"`):

| Type | Condition |
| --- | --- |
| `invert` | `theme.invertImages` (forced), or an entire-page image with `averageLightness >= 150` while dark (also sets `forceInversion`) |
| `gradient` | not dark, entire page, `averageLightness >= 150 && neutralRatio >= 0.9` |
| `replace` | not entire page, `distinctColors(imageData, 3) <= 2` |
| `overlay` | everything else |

The helper functions already exist on the instance: `averageLightness` (BT.601 weights,
alpha < 64 treated as white), `neutralRatio` (deviation 12, sampled every 16 px, skips
alpha < 32), `distinctColors` (unique-RGB count with early exit at the cutoff), and
`isColorNeutral` (max channel spread < deviation).

### Why embedded line art ends up as `overlay`

`distinctColors(imageData, 3) <= 2` requires a nearly monochrome figure. A figure with
coloured curves and annotations has far more, so it falls through to `overlay`, which only
dims it — no RGB inversion, just a lower alpha:

```js
this.ctx.globalCompositeOperation = "source-over";
this.ctx.globalAlpha = entirePage ? 1 : 0.8;
this.origDrawImage(...args);
```

That is exactly the reported defect: the white background survives (dimmed by alpha) while
dark line work on it is not inverted and remains effectively invisible on the dark
background.

## 5. Sample PDF (M1 test fixture)

`samples/Dual-Grained_Recursive_Bayesian_Filtering_...pdf`, 6 pages, three raster images:

| Page | Object | Size |
| --- | --- | --- |
| 2 | `/Im1` | 1629×1258 (Fig. 1) |
| 3 | `/Im2` | 347×203 |
| 5 | `/Im3` | 2100×2389 (Fig. 3) |

No `/Subtype /Form` XObjects were found, so no figure content is hidden inside Form
XObjects. **Corrected in §8:** this does *not* mean figure content reaches
`customDrawImage` without vector overlays — the sample's page 2 draws 35 near-black
vector paths on top of the Fig. 1 bitmap. Those are already mapped to theme-light styles
by Blender itself, so no vector-layer hook is needed.

## 6. Design decisions (as implemented)

The M1/M2 implementation follows this list; differences from the original M0
proposal are noted.

- **Intercept `customDrawImage`, not canvas APIs.** `Blender.prototype.customDrawImage`
  is wrapped from inside the viewer realm via the instance chain
  (`PDFPageProxy.render` -> `InternalRenderTask.initializeGraphics` -> `Blender`).
  Implemented as proposed.
- **Own `getImageData`, synchronously.** The original proposal was to reuse the
  `imageData` Blender already extracted; that is not reachable from a wrapper around
  `customDrawImage`, so the plugin rasterizes the source rect and calls `getImageData`
  itself, in the same synchronous draw call. Cost measured on the sample paper:
  ~10 ms for 815x629, ~30 ms for 1629x1258 (first render only, cached afterwards).
- **Discriminators** for white-background line art vs photography: near-white ratio,
  low-saturation ratio, flat-region ratio (plus a logged dark-neutral ratio). Aggressive
  defaults per the product decision, exposed through the `sensitivity` pref.
  Implemented as proposed.
- **Transform:** *differs from the original proposal.* The original text proposed making
  only the border-connected near-white background transparent and keeping interior whites
  (fills, baked-in text). The product decision for M2 is the opposite: **every** near-white
  neutral pixel is removed globally, with no connectivity test and no interior exception;
  all neutral ink (including ink that sat on white fills) is lifted to the foreground.
  Saturated pixels still keep their original RGB. Alpha removal uses a smooth
  lightness/saturation weight, so antialiased edges fade rather than getting a hard halo.
- **Caching:** per upstream image identity (the pdf.js `imgData`/bitmap recorded by
  wrapping `CanvasGraphics.paintInlineImageXObject[Group]` — *not* the temporary canvas
  `_scaleImage` creates per render) + source rect + pixel size; classification features
  are cached independently of sensitivity and theme colors, the transformed canvas is
  cached per parameter set. Repeated renders at the same scale are cache hits.
- **Safety:** every pdf.js internal touched is checked for existence first (a Zotero
  update degrades to "do not intervene"); the original method is called exactly once per
  draw and any error in the noir preparation falls back to it; light themes
  (`!blender.dark`), `ctx.skipBlender` and `invertImages` themes are passed through;
  uninstall restores all wrapped methods and deletes their markers so a disable/enable
  cycle re-installs cleanly.

## 7. M0 code disposition

The accumulated `bootstrap.js` probe (prototype wrapper, instance accessor trap,
`getContext` hook, `putImageData` hook, `transferFromImageBitmap` hook, three-lane
selftest, realm diagnostics) is obsolete now that the interception point is known. It was
deleted and rewritten for M1 rather than patched further.

## 8. M3 finding: vector overlay copies sit on top of the bitmap (and why the vector hook is still redundant)

Re-verified with pymupdf, checking **both** colour keys (`fill` and `color`) and the
geometry of every drawing:

| Page | Bitmap rect (pt) | Drawings | Near-black `fill == (23,23,21)` |
| --- | --- | --- | --- |
| 2 (Fig. 1) | `[67.07, 73.49, 262.69, 224.59]`, xref 82, 1629x1258, no SMask | 44 | 37 paths; **35 of them inside the bitmap rect**, 2 straddling its edge (y=67, x=267) |
| 5 (Fig. 3) | `[37.44, 66.84, 289.44, 353.52]`, xref 125, 2100x2389, no SMask | 285 | none inside the bitmap rect (the dark ones are page furniture, y=443, ...) |

The 37 page-2 paths are curve/line/rect fills (`items` kinds: 1929 `c`, 1277 `l`, 9 `re`)
with label-sized bounding boxes (1x3 pt to 33x7 pt), drawn after the image — they are the
**vector copies (outlined paths) of the figure annotations** (handover, UAV, SROI,
LEO SUT, Search phase, ...) that the PDF lays over the bitmap. So "the PDF draws a vector
layer on top of the figure bitmap" **is a real, verified fact**.

What is *not* true is the inference that this layer makes the outlines look dark. The M3
diagnostic chained onto the vector style accessor and logged what Blender had already
produced for those styles:

```
[PDF-Noir] vector hook armed build=M3.0 (fill=true stroke=true)
[PDF-Noir] vector seen stroke #d8dee9      (= theme foreground)
[PDF-Noir] vector seen fill #b5bbc6        (= mid light)
[PDF-Noir] vector: styles seen=50 rewritten=0
```

Blender's `interceptStyleProperty` / `getCanvasStyle` already map the near-black vector
colours to theme light values before any plugin code sees them, so the vector layer was
never the cause of dark-looking outlines. The M2.1 defect had a different root cause: the
pixel transform's **one-sided lift** did not reach the dark strokes that need flipping
once the white background is removed — and the figure's main line work is baked into the
bitmap. The M3 mirror-symmetric band (near-white removed, near-black flipped) is the fix:

- very dark pixels (`max < 40`) inside the Fig. 1 figure area: **2516 → 0**;
- near-`(23,23,21)` pixels on the same view: **633 → 6**.

Consequences:

- The vector hook is **redundant** — Blender already maps those styles, and the pixel
  layer covers the bitmap (verified: with the hook removed the outlines stay light, 0
  very-dark pixels). It was removed again in M3 and no vector hook ships.
- **Forced rasterization is unnecessary** (and was rejected anyway): it would reintroduce
  antialiasing artefacts on thin lines and race pdf.js's render/zoom/theme cycle, while
  the pixel path already covers the figure's line work.

### Methodology note (this project misjudged twice)

`page.get_drawings()` in pymupdf reports a path's **fill** colour under `fill` and its
**stroke** colour under `color`. There is **no `stroke` key**. Filtering on `d['stroke']`
silently matches nothing, and a probe that only inspects `color` misses every *filled*
path — which is exactly how this project produced two false negatives in a row:

1. "the page has no dark vector objects" (only `color` checked);
2. "the near-black vector objects are all outside the image rect" (only the 7 stroke-only
   page-furniture objects were seen; the 35 filled annotation copies inside the figure
   rect were invisible to the probe).

Always check both keys, and verify the geometry (does the object's rect fall inside the
image rect?) before drawing conclusions about which drawing layer causes a visual effect.