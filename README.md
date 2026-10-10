# Zotero PDF Noir

Dark-mode image handling for the Zotero PDF reader. Embedded figures with a
white background stop glaring: near-white neutral pixels become transparent
(globally — no interior exceptions), near-black neutral pixels have their
lightness flipped toward the theme foreground (one shared, mirror-symmetric
band drives both ends), and saturated colors are preserved. The figure's
outlines, labels, icons and grid lines are baked into the raster image and go
through this pixel transform; any vector copies the PDF draws over it are
mapped by Zotero's own dark mode (the pdf.js `Blender`), as is page-level
vector content.

Verified on Zotero 10.0.6 (Firefox ESR 140) with the sample paper in
`samples/` (Fig. 1 page 2, Fig. 3 page 5), dark reader theme.

## Install

```sh
bun install
bun run build
```

1. In Zotero: **Tools → Plugins** (工具 → 插件), click the gear icon ⚙ and
   choose **Install Add-on From File…** (从文件安装插件).
2. Select `build/zotero-pdf-noir-<version>.xpi`.
3. Confirm the install prompt and restart Zotero if asked.
4. Open a PDF in the reader and pick a **dark theme** (the "Aa" theme button
   in the reader toolbar; "Dark" is the default dark theme). Light themes are
   intentionally left alone.

The plugin only affects raster images in the PDF; page text, vector graphics
and the reader UI are handled by Zotero itself.

## Structure

| Path | Purpose |
|---|---|
| `manifest.json` | Add-on id `pdf-noir@zotero-plugins`; `applications.zotero` carries `id`, `update_url` and `strict_max_version` (all three are required or Zotero rejects the install) |
| `bootstrap.js` | Lifecycle, viewer-window discovery, script injection into the pdf.js viewer realm, log draining, dev auto-open |
| `content/scripts/noir/classify.js` | White-background-line-art classifier (runs in the viewer realm) |
| `content/scripts/noir/transform.js` | Pixel transform (runs in the viewer realm) |
| `content/scripts/noir/cache.js` | Feature cache (parameter-independent) + transformed-canvas cache, keyed by upstream image identity |
| `content/scripts/noir/hook.js` | `Blender.prototype.customDrawImage` interception, upstream identity capture, draw dispatch |
| `prefs.js` | `extensions.pdf-noir.enable` (bool), `extensions.pdf-noir.sensitivity` (string `"0.7"`) |
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
         (record the upstream imgData/bitmap identity for caching)
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
The original method is called exactly once per draw; only the noir
preparation is wrapped in try/catch, and any exception falls back to the
untouched original. Uninstall restores every wrapped method and removes its
markers, so a disable/enable cycle re-installs cleanly.

### Classification (`classify.js`)

Features are computed on a downsampled copy (long side ~192 px); the
transform itself always runs at the source resolution so thin strokes are
preserved. All three features are ratios in 0..1:

| Feature | Definition |
|---|---|
| `nearWhite` | lightness > 0.94 and relative saturation < 0.1 |
| `lowSat` | absolute channel spread <= 32 or relative saturation < 0.2 |
| `flat` | adjacent pixel pairs with max channel difference <= 12 |
| `darkNeutral` | (logged only) L < 0.5 and neutral color |

An image is classified as white-background line art when all three
thresholds are met. Thresholds derive from the sensitivity pref `s` (0..1):

```
tNearWhite = 0.45 - 0.27*s      (s=0.7 -> 0.261)
tLowSat    = 0.75 - 0.25*s      (s=0.7 -> 0.575)
tFlat      = 0.55 - 0.25*s      (s=0.7 -> 0.375)
```

`0.7` (aggressive, the default) was chosen so typical paper figures with
colored curves on white are caught.

### Transform (`transform.js`)

The neutral lightness axis is handled by **one mirror-symmetric band**
(`params(s)`): a near-white end and a near-black end of the same width, with
the same ramp shape and the same chromatic gate. The two ends get the two
symmetric effects:

| End | Band (s = 0.7) | Effect |
|---|---|---|
| near-white | `[whiteLo, whiteHi]` = `[0.768, 0.934]` | `alpha = 255 * (1 - wWhite)` — removed |
| near-black | `[darkLo, darkHi]` = `[0.066, 0.232]` | `rgb = mix(rgb, flipped, wDark)` — lightness flipped |

`darkLo = 1 - whiteHi` and `darkHi = 1 - whiteLo`, so the two ends always
share the band width; `sensitivity` widens or narrows both together. The
ramps are smooth, so antialiased edges fade instead of getting a hard halo.
The middle of the axis is untouched.

`flipped` is the mirror of the pixel's lightness (`L -> 1 - L`) placed on the
theme foreground -> white axis, so the darkest ink lands on the theme
foreground and pure black approaches white — the mirror of the near-white end
becoming the theme background.

**Saturated pixels are untouched** (absolute channel spread gate
`spread >= neutralSpread`), so red/orange/blue/green curves stay their
original color. There is no connectivity test and no interior exception:
near-white is background wherever it is (white fills, panels, baked-in white
text included).

The transform mutates the `ImageData` in place in a single pass. It is
cached per upstream image identity + source rect + pixel size + parameters;
repeated renders of the same figure at the same scale (scroll, repaint) are
cache hits, and changing only `sensitivity` reuses the cached classification
features and recomputes only the transform. Measured cost on the sample
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
cache. The viewer realm cannot call `Zotero.debug`; log lines are buffered on
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
   (widens the shared neutral band at both ends), default `"0.7"`.
4. Changes apply within about 1.5 s while a reader is open; to see them
   immediately, zoom or scroll the PDF so the page re-renders (the cached
   result is keyed by sensitivity, so the new value takes effect on the next
   render).

## Build

```sh
bun install
bun run build
# -> build/zotero-pdf-noir-<version>.xpi
# -> build/zotero-pdf-noir-<version>.zip  (identical bytes; xpi is a zip)
```

The xpi root contains only `manifest.json`, `bootstrap.js`, `prefs.js` and
`content/`.

## Verification (as performed for M2.1)

1. Test profile in `%TEMP%` with `extensions.startupScanScopes=1`,
   `ui.systemUsesDarkMode=1` and a proxy file in `extensions/` pointing at
   this repo (no packaging needed during iteration).
2. Start Zotero with `-no-remote -profile <test> -datadir <test> -console`.
3. Open the sample paper, dark theme. Log lines confirmed:
   - Fig. 1 (`815x629`): `noir ... feats{white=0.880 lowSat=0.968 flat=0.891}`
   - Fig. 3 (`1050x1195`): `noir ... feats{white=0.780 lowSat=0.862 flat=0.841}`
   - a photographic image (`900x675`): `pass ... feats{white=0.000 lowSat=0.217 flat=0.328}`
   - sensitivity `"0.25"` changes the logged thresholds to
     `thr{white=0.383 lowSat=0.688 flat=0.488}`.
   - repeated same-scale renders show `cache=hit` (upstream identity is
     stable across renders).
4. Screenshots (`winapp ui screenshot`) show: white background gone on
   Fig. 1 and Fig. 3, thin lines and axis labels readable, colored curves and
   surfaces unchanged, and no rendering breakage.
5. Disable → enable the plugin with a reader open: the hook re-installs and
   keeps drawing (no duplicate wrapping, no stale markers).

## Known behavior / side effects

- **All near-white neutral pixels are removed**, including interior white
  fills and panels (the white plane in Fig. 1, the white plot interiors in
  Fig. 3). Near-black ink on them is flipped to the foreground color, so
  black grid lines and text on white become light and stay readable. This is
  the intended behavior (no interior exception).
- **Light, low-saturation fills are faded too** (e.g. the pale pink ellipse
  in Fig. 1 becomes a muted, slightly transparent pink). This is the direct
  cost of "any near-white neutral pixel is background"; lower
  `sensitivity` to keep more of such tints.
- **The figure's dark line work is flipped by the pixel transform.** The
  outlines, labels, icons and grid lines are baked into the raster image, so
  the shared near-black band reaches them (measured on Fig. 1: pixels darker
  than 40 in the figure area go from 2516 to 0 between the previous build and
  this one).
- **The PDF may also draw vector copies of figure elements on top of the
  bitmap** (page 2 of the sample has 35 near-black filled annotation paths
  whose rects lie inside the image rect). Those are already mapped to
  theme-light colours by Zotero's own Blender before this plugin sees them
  (measured: `styles seen=50 rewritten=0`; the values that arrive are
  `stroke #d8dee9`, `fill #b5bbc6`), so they are not a cause of dark-looking
  outlines and the plugin does not intervene. A vector-layer hook was tried
  in M3 and removed again as redundant.
- Entire-page raster images (scans) are passed through to Blender's existing
  handling; they are not noir-processed.
- Themes with `invertImages` (e.g. Zotero's "Black" theme) are passed
  through, so that theme keeps its full-inversion behavior. Light themes are
  never touched.
- `sensitivity` is re-read from prefs every 1.5 s while a reader is open;
  changing it affects the next render of an image.
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
4. **Look at the log**: Help → Debug Output Logging → View Output (or start
   Zotero with `-console`) and search for `[PDF-Noir]`:
   - `hook install build=...` and `attached; Blender hook armed` mean the hook
     is active;
   - per-image lines show `noir` or `pass` with the measured features; a
     `pass skip=...` tells you why the plugin deliberately did nothing
     (`lightTheme`, `forceInversion`, `entirePage`, `tooLarge`);
   - if there are no lines at all, no raster image was drawn — text-only
     pages paint without this code path.
