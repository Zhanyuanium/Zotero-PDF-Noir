# Zotero PDF Noir

Dark-mode image handling for the Zotero PDF reader. Embedded figures with a
white background stop glaring: near-white neutral pixels become transparent
(globally — no interior exceptions), near-black neutral pixels have their
lightness flipped toward white (one shared, mirror-symmetric band drives both
ends), and saturated colors are preserved. The figure's outlines, labels,
icons and grid lines are baked into the raster image and go through this pixel
transform; any vector copies the PDF draws over it are mapped by Zotero's own
dark mode (the pdf.js `Blender`), as is page-level vector content.

Verified on Zotero 10.0.6 (Firefox ESR 140) with the sample paper in
`samples/` (Fig. 1 page 2, Fig. 3 page 5), dark reader theme.

## Install

### From a release (recommended)

1. Download `zotero-pdf-noir-1.0.0.xpi` from
   [GitHub Releases](https://github.com/Zhanyuanium/Zotero-PDF-Noir/releases).
2. In Zotero: **Tools → Plugins**, click the gear icon ⚙ and choose
   **Install Add-on From File…**.
3. Select the downloaded `.xpi` and confirm the install prompt.
4. Restart Zotero when asked (the plugin is a bootstrapped add-on).
5. Open a PDF in the reader and pick a **dark theme** (the "Aa" theme button
   in the reader toolbar; "Dark" is the default dark theme). Light themes are
   intentionally left alone.

Verified on Zotero 10.0.6 only; no Bun, no Node and no separate Firefox are
needed for the XPI. The plugin relies on Zotero 10's `Blender` behavior and
`manifest.json` refuses to install below 10.0.6.

### From source (development)

```sh
bun install
bun run build
```

Then install `build/zotero-pdf-noir-<version>.xpi` as above.

The plugin only affects raster images in the PDF; page text, vector graphics
and the reader UI are handled by Zotero itself.

## Structure

| Path | Purpose |
|---|---|
| `manifest.json` | Add-on id `pdf-noir@zotero-plugins`; `applications.zotero` carries `id`, `update_url`, `strict_min_version` (10.0.6) and `strict_max_version` |
| `bootstrap.js` | Lifecycle, viewer-window discovery, script injection into the pdf.js viewer realm, exact-build version check, log draining, dev auto-open |
| `content/scripts/noir/classify.js` | White-background-line-art classifier (runs in the viewer realm) |
| `content/scripts/noir/transform.js` | Pixel transform (runs in the viewer realm) |
| `content/scripts/noir/cache.js` | Feature cache (parameter-independent) + transformed-canvas cache, keyed by upstream image identity, bounded by a per-image cap and a global byte budget with LRU eviction |
| `content/scripts/noir/hook.js` | `Blender.prototype.customDrawImage` interception, upstream identity capture, transfer-map detection, draw dispatch |
| `prefs.js` | `extensions.pdf-noir.enable` (bool), `extensions.pdf-noir.sensitivity` (string `"0.7"`) |
| `tests/` | `bun test` suite: transform band, chroma gate, classification, caches |
| `scripts/build.ts` | Zero-dependency packer → `build/*.xpi` (+ identical `.zip`) |
| `docs/m0-findings.md` | How Zotero 10.0.6 dark mode actually renders PDF images (M0 investigation) |

## How it works

### Interception point

In the Zotero pdf.js fork, dark-mode images are handled by the `Blender`
class. Its constructor overwrites `ctx.drawImage` with an own arrow function
(`... => this.customDrawImage(args)`), which defeats every canvas-level hook.
The plugin therefore wraps `Blender.prototype.customDrawImage`, reached from
inside the viewer realm through the instance chain:

```
PDFPageProxy.prototype.render
  -> InternalRenderTask.prototype.initializeGraphics   (grab gfx)
    -> CanvasGraphics.prototype.paintInlineImageXObject[Group]
         (record the upstream imgData/bitmap identity and the active
          transfer map for caching)
    -> Blender.prototype.customDrawImage               (the hook)
```

The first render after a reader opens may run before the hook is armed; the
hook then calls `reset()` on the page views and `pdfViewer.update()` once so
the visible page is re-rendered through the noir path immediately.

For each image, `customDrawImage` receives the original drawImage arguments
(3/5/9-argument forms). The wrapper resolves the source rect exactly like
Blender does, then:

- passes through untouched when `ctx.skipBlender` is set, the theme is light
  (`!blender.dark`), the theme forces image inversion
  (`theme.invertImages`, e.g. Zotero's "Black" theme), the image is an
  entire-page candidate, or it is larger than 8 MP. An entire-page candidate
  is an image whose transformed bounding box differs from the full page area
  by less than 25% of the page area — i.e. scans of a whole page;
- classifies the rest and, if it is white-background line art, draws the
  transformed canvas through Blender's own `origDrawImage` with the same
  argument form;
- otherwise calls the original `customDrawImage` so Blender behaves exactly
  as before.

Safety: every pdf.js internal the plugin touches is checked for existence
first, so a Zotero update that renames things degrades to "do not intervene".
The original method is called at most once per draw (a noir hit never reaches
it); only the noir preparation is wrapped in try/catch, and any exception
falls back to the untouched original. Uninstall restores every wrapped method
and removes its markers, so a disable/enable cycle re-installs cleanly.

A window that still runs code from another build (e.g. a reader that stayed
open across a plugin update) is never accepted as "already injected": the
bootstrap uninstalls it, deletes the `PDFNoir` namespace and injects the
current build (retries are throttled to one attempt per 5 s per window).

### Classification (`classify.js`)

Features are computed on a downsampled copy (long side ~192 px); the
transform itself always runs at the source resolution so thin strokes are
preserved. All features are ratios in 0..1, computed over **opaque pixels
only**; transparent pixels are excluded from every denominator and a `flat`
pixel pair only counts when both of its pixels are opaque, so a transparent
margin cannot skew the ratios:

| Feature | Definition |
|---|---|
| `nearWhite` | lightness > 0.94 and relative saturation < 0.1 |
| `lowSat` | absolute channel spread <= 32 or relative saturation < 0.2 |
| `flat` | adjacent opaque pixel pairs with max channel difference <= 12 |
| `darkNeutral` | (logged only) L < 0.5 and neutral color |

An image is classified as white-background line art when all three
thresholds are met. Thresholds derive from the sensitivity pref `s` (0..1):

```
tNearWhite = 0.45 - 0.27*s      (s=0.7 -> 0.261)
tLowSat    = 0.75 - 0.25*s      (s=0.7 -> 0.575)
tFlat      = 0.55 - 0.25*s      (s=0.7 -> 0.375)
```

`0.7` (aggressive, the default) was chosen so typical paper figures with
colored curves on white are caught. Photographic content (no white
background, low flatness) is passed through untouched at every sensitivity.

### Transform (`transform.js`)

The neutral lightness axis is handled by **one mirror-symmetric band**
(`params(s)`): a near-white end and a near-black end of the same width, with
the same ramp shape and the same chromatic gate. The two ends get the two
symmetric effects:

| End | Band (s = 0.7) | Effect |
|---|---|---|
| near-white | `[whiteLo, whiteHi]` = `[0.768, 0.934]` | `alpha = alpha * (1 - wWhite)` — removed |
| near-black | `[darkLo, darkHi]` = `[0.066, 0.232]` | `rgb = mix(rgb, flipped, wDark)` — lightness flipped |

`darkLo = 1 - whiteHi` and `darkHi = 1 - whiteLo`, so the two ends always
share the band width; `sensitivity` widens or narrows both together. The
ramps are smooth, so antialiased edges fade instead of getting a hard halo.
The middle of the axis is untouched.

`flipped` is the mirror of the pixel's lightness (`L -> 1 - L`) placed on the
theme foreground -> white axis:

```
flipped = fg + (255 - fg) * (1 - L)
```

so **pure black becomes white** (and the darkest ink lands near white — the
mirror of the near-white end becoming the theme background); the darkest
neutral ink is the lightest output. The flip is applied as a mix with the
original color, so mid-dark ink lands between the original and that value.

**Saturated pixels are untouched.** The decision uses a *relative* chroma
measure, not the absolute channel spread:

```
chroma = spread / max(maxChannel, 32)     (32 = floor for numerical stability)
chromatic when chroma >= chromaT,  chromaT = 0.2 + 0.1*s   (s=0.7 -> 0.27)
```

The relative measure exists because a dark saturated color like `(40,0,0)`
has a small absolute spread but is fully saturated: the previous
absolute-spread gate (`spread >= 40 + 24*s`) misjudged such colors and
lightened them. Measured on the sample paper's extracted bitmaps at the
default sensitivity, the old gate changed 596 pixels of clearly saturated
color on Fig. 1 and 3,917 on Fig. 3; with the relative gate **zero** saturated
pixels change, while the overall set of treated pixels is otherwise identical.
Raising `s` can never disable color protection: `chromaT` is bounded to 0.30,
far below the chroma of any clearly saturated color. The floor keeps JPEG
chroma noise on near-black ink from looking "saturated".

There is no connectivity test and no interior exception: near-white is
background wherever it is (white fills, panels, baked-in white text
included).

The transform mutates the `ImageData` in place in a single pass. It is
cached per upstream image identity + source rect + pixel size + parameters;
repeated renders of the same figure at the same scale (scroll, repaint) are
cache hits, and changing only `sensitivity` reuses the cached classification
features and recomputes only the transform. The result key uses the theme
**foreground** color only (the background does not influence the output).
Draws made under an active transfer map (`CanvasGraphics.current.transferMaps`,
a CSS filter that changes the pixels the same image data produces) bypass both
caches entirely — this path is rare and recomputing is safer than mixing
results. Memory is bounded per image identity and globally (64 MiB budget,
LRU eviction); `uninstall` clears the caches. Measured cost on the sample
paper: ~20 ms for an 815x629 figure, ~85-135 ms for 1629x1258/2100x2389
(first render only).

### Logging

Everything goes to the Zotero debug log with the `[PDF-Noir]` prefix
(`-console` or Help → Debug Output Logging → View Output). One line per
image draw, hit or miss:

```
[PDF-Noir] #1 img1 815x629 src=up noir cache=miss cls=miss feats{white=0.880 lowSat=0.968 flat=0.891 dark=0.023} thr{white=0.261 lowSat=0.575 flat=0.375} ms=20 removed=0.895
[PDF-Noir] #2 img2 900x675 src=up pass cls=miss feats{white=0.000 lowSat=0.217 flat=0.328 dark=0.031} thr{white=0.261 lowSat=0.575 flat=0.375} ms=3
```

`src=up` means the cache key came from the upstream `imgData`/bitmap;
`noir` = transformed, `pass` = handed to Blender unchanged (`skip=...` names
the reason: `lightTheme`, `forceInversion`, `entirePage`, `tooLarge`).
`cache=` is the transformed-canvas cache, `cls=` the classification-feature
cache; `xf=on` marks a draw under an active transfer map (caches disabled for
it). The viewer realm cannot call `Zotero.debug`; log lines are buffered on
the window and drained by `bootstrap.js` every 1.5 s. Note that Zotero's
`-console` stdout is buffered, so a redirected log file may only be complete
after Zotero exits.

## Prefs

| Pref | Default | Meaning |
|---|---|---|
| `extensions.pdf-noir.enable` | `true` | master switch (unset = enabled) |
| `extensions.pdf-noir.sensitivity` | `"0.7"` | classifier/transform aggressiveness, 0..1, stored as a string (Firefox default prefs have no float type) |
| `extensions.pdf-noir.devAutoOpenItem` | unset | dev-only: item ID to open on startup (used by the automated test profile; unset means no behavior) |

How to change them:

1. **Edit → Settings → Advanced → Config Editor** (编辑 → 设置 → 高级 →
   配置编辑器), accept the warning.
2. Search for `extensions.pdf-noir`.
3. `extensions.pdf-noir.enable` is a boolean; `extensions.pdf-noir.sensitivity`
   is a **string** between `"0"` and `"1"` — higher is more aggressive
   (widens the shared neutral band at both ends and accepts more colors as
   neutral), default `"0.7"`.
4. The pref is re-read within about 1.5 s, but **changing it does not repaint
   by itself**: wait ~2 s and then zoom or scroll the PDF so the visible pages
   re-render (the cached result is keyed by sensitivity, so the new value
   takes effect on the next render).

## Build

```sh
bun install
bun run build
bun test          # 28 tests: band, chroma gate, classification, caches
# -> build/zotero-pdf-noir-<version>.xpi
# -> build/zotero-pdf-noir-<version>.zip  (identical bytes; xpi is a zip)
```

The xpi root contains only `manifest.json`, `bootstrap.js`, `prefs.js`,
`content/` and `LICENSE`.

## Verification (as performed for 1.0.0)

1. `bun test`: 28 pass, 0 fail (mirror symmetry, band continuity, the chroma
   gate incl. the dark-saturated cases, alpha behavior, idempotence,
   opaque-only classification, cache LRU/clear).
2. `bun run build`: the xpi contains exactly `manifest.json`, `bootstrap.js`,
   `prefs.js`, `content/scripts/noir/{cache,classify,hook,transform}.js` and
   `LICENSE`.
3. Test profile in `%TEMP%` with `ui.systemUsesDarkMode=1` and a proxy file
   in `extensions/` pointing at this repo (no packaging needed during
   iteration); the sample paper opened at high zoom in the dark theme.
4. Screenshots (`v1-p2-*.png`, `v1-p5-*.png` in the run log directory):
   - Fig. 1 (page 2) at 4x/8.5x: white background gone (dark page shows
     through), outlines, axes and labels light and readable, the red search
     trajectory, orange path, purple/violet arrow, green dots and the blue
     UAV photos unchanged, no halos on antialiased edges;
   - Fig. 3 (page 5) at 4.5x: 3D surfaces, heatmaps (blue/yellow/cyan) and
     the red/green markers unchanged, axis numbers and labels light;
   - body text and formulas around the figures are light and crisp (Blender's
     vector handling; the plugin does not touch them).
5. Color fidelity (A1) measured per pixel against the previous build on the
   extracted source bitmaps: pixels of clearly saturated color changed by the
   old absolute-spread gate — Fig. 1: 596, small Fig.: 1, Fig. 3: 3,917 —
   change to **0** with the relative chroma gate; total treated pixels are
   otherwise identical.
6. Photographic content: a synthetic photographic image (no white background)
   is classified `pass` at every sensitivity, and the blue UAV photos inside
   Fig. 1 render in their original colors.
7. Upgrade path: a reader window left with a stale build (`0.9.9`) is
   detected, uninstalled, its namespace deleted and the current build
   re-injected — verified live with the build changed mid-run; the hook
   re-arms and keeps drawing. Disable → enable re-installs cleanly (verified
   in earlier rounds; uninstall now also clears the caches).
8. No `javascript error`, `uncaught`, `TypeError` or `ReferenceError` lines in
   any of the run logs.

## Known behavior / side effects

- **All near-white neutral pixels are removed**, including interior white
  fills and panels (the white plane in Fig. 1, the white plot interiors in
  Fig. 3). Near-black ink on them is flipped toward white — pure black
  becomes white — so black grid lines and text on white become light and stay
  readable. This is the intended behavior (no interior exception).
- **Light, low-saturation fills are faded too** (e.g. the pale pink ellipse
  in Fig. 1 becomes a muted, slightly transparent pink). This is the direct
  cost of "any near-white neutral pixel is background"; lower
  `sensitivity` to keep more of such tints.
- **The figure's dark line work is flipped by the pixel transform.** The
  outlines, labels, icons and grid lines are baked into the raster image, so
  the shared near-black band reaches them (measured on Fig. 1: pixels darker
  than 40 in the figure area go from 2516 to 0 between the M2.1 build and
  M3).
- **The PDF may also draw vector copies of figure elements on top of the
  bitmap** (page 2 of the sample has 35 near-black filled annotation paths
  whose rects lie inside the image rect). Those are already mapped to
  theme-light colours by Zotero's own Blender before this plugin sees them
  (measured: `styles seen=50 rewritten=0`; the values that arrive are
  `stroke #d8dee9`, `fill #b5bbc6`), so they are not a cause of dark-looking
  outlines and the plugin does not intervene. A vector-layer hook was tried
  in M3 and removed again as redundant.
- **Colors are protected by the relative chroma gate**: only colors whose
  relative chroma is below the threshold are guaranteed to be left alone.
  Dark saturated colors that the earlier absolute-spread gate misjudged are
  now preserved (see Verification item 5).
- Entire-page raster images (scans) are passed through to Blender's existing
  handling; they are not noir-processed.
- Themes with `invertImages` (e.g. Zotero's "Black" theme) are passed
  through, so that theme keeps its full-inversion behavior. Light themes are
  never touched.
- `sensitivity` is re-read from prefs every 1.5 s while a reader is open, but
  a change only takes effect on the next render (see Prefs item 4).
- Verified on Zotero 10.0.6 only.

## Troubleshooting

1. **Check the plugin is enabled**: Tools → Plugins (工具 → 插件) — "Zotero
   PDF Noir" must be enabled, and Zotero restarted after installing or
   updating it.
2. **Check the reader theme**: the plugin only acts on dark themes; switch to
   "Dark" (or another dark theme) with the "Aa" button in the reader toolbar.
3. **Reopen the PDF**: close the reader tab and open the PDF again — the hook
   arms on reader startup and forces one repaint; a page rendered before that
   is not transformed until it re-renders.
4. **Enable debug logging first, then reopen the PDF**: Help → Debug Output
   Logging → Enable Output Logging (and View Output), or start Zotero with
   `-console`, *before* opening the PDF — the hook logs its install at reader
   startup, so enabling logging afterwards misses those lines. Then search
   for `[PDF-Noir]`:
   - `hook install build=...` and `attached; Blender hook armed` mean the hook
     is active;
   - per-image lines show `noir` or `pass` with the measured features; a
     `pass skip=...` tells you why the plugin deliberately did nothing
     (`lightTheme`, `forceInversion`, `entirePage`, `tooLarge`);
   - **no `[PDF-Noir]` lines at all can also mean the injection failed** (not
     only "no raster image was drawn"): a text-only page paints without this
     code path, but if even the `hook install` line is missing, check that the
     plugin is enabled, that the reader tab was opened after Zotero started,
     and look for injection errors (`loadSubScript`, `inline injection`,
     `script tag injection`).
5. Note that Zotero's `-console` stdout is buffered: a redirected log file
   may only be complete after Zotero exits.

## Feedback

Bug reports are welcome at
[github.com/Zhanyuanium/Zotero-PDF-Noir/issues](https://github.com/Zhanyuanium/Zotero-PDF-Noir/issues).
Please include your Zotero version, the reader theme in use, and the
`[PDF-Noir]` log lines covering the problem (see Troubleshooting item 4).

## License

Zotero PDF Noir is licensed under the **GNU Affero General Public License
v3.0 (AGPL-3.0)** — see [LICENSE](LICENSE) for the full text.
