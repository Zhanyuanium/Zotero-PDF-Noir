# Zotero PDF Noir

[中文](README.zh-CN.md)

Dark-mode image handling for the Zotero PDF reader. Embedded figures with a
white background stop glaring: near-white neutral pixels become transparent
(globally — no interior exceptions), near-black neutral pixels have their
lightness flipped toward white (one shared, mirror-symmetric band drives both
ends), and colour is filtered by a relative-chroma gate — at the shipped
threshold only fully saturated pixels are left untouched. The figure's
outlines, labels, icons and grid lines are baked into the raster image and go
through this pixel transform; any vector copies the PDF draws over it are
mapped by Zotero's own dark mode (the pdf.js `Blender`), as is page-level
vector content.

## Install

### From a release (recommended)

1. Download the `.xpi` from
   [GitHub Releases](https://github.com/Zhanyuanium/Zotero-PDF-Noir/releases).
2. In Zotero: **Tools → Plugins**, click the gear icon ⚙ and choose
   **Install Add-on From File…**.
3. Select the downloaded `.xpi` and confirm the install prompt.
4. Restart Zotero when asked (the plugin is a bootstrapped add-on).
5. Open a PDF in the reader and pick a **dark theme** (the "Aa" theme button
   in the reader toolbar; "Dark" is the default dark theme). Light themes are
   intentionally left alone.

The add-on declares support from Zotero 10.0.0; live testing was done on
Zotero 10.0.6. No Bun, no Node and no separate Firefox are needed for the
XPI. The plugin relies on Zotero 10's `Blender` behavior and `manifest.json`
refuses to install below 10.0.0.

### From source (development)

```sh
bun install
bun run build
```

Then install `build/zotero-pdf-noir-<version>.xpi` as above.

### Settings

The plugin is configured in its own pane: **Edit → Settings → "Zotero PDF
Noir"**, at the bottom of the settings sidebar. It holds the master switch and
three independent numeric knobs — neutral-colour threshold, lightness band
width and detection sensitivity — each a range slider with a live percentage
readout, plus a **Restore Defaults** button. Changes reach an already-open
reader within about 1.5 s, with no scrolling or zooming needed.

Fresh profiles start at 100% (threshold), 60% (lightness band width) and 70%
(detection sensitivity). A default applies only when the pref has never been
set, so an existing profile keeps the values already stored; there is no
migration.

The plugin only affects raster images in the PDF; page text, vector graphics
and the reader UI are handled by Zotero itself.

## Structure

| Path | Purpose |
|---|---|
| `manifest.json` | Add-on id `pdf-noir@zotero-plugins`; `applications.zotero` carries `id`, `update_url`, `strict_min_version` (10.0.0) and `strict_max_version` |
| `bootstrap.js` | Lifecycle, viewer-window discovery, script injection into the pdf.js viewer realm, exact-build version check, log draining, dev auto-open |
| `content/scripts/noir/classify.js` | White-background-line-art classifier (runs in the viewer realm) |
| `content/scripts/noir/transform.js` | Pixel transform (runs in the viewer realm) |
| `content/scripts/noir/cache.js` | Feature cache (parameter-independent) + transformed-canvas cache, keyed by upstream image identity, bounded by a per-image cap and a global byte budget with LRU eviction |
| `content/scripts/noir/hook.js` | `Blender.prototype.customDrawImage` interception, upstream identity capture, transfer-map detection, draw dispatch, immediate `repaint()` |
| `content/preferences.xhtml` | Settings-pane fragment, registered by `bootstrap.js` via `Zotero.PreferencePanes.register()` |
| `content/preferences.js` | Pane readout wiring + Restore Defaults |
| `prefs.js` | Default declarations for all five prefs: `extensions.pdf-noir.enable` (bool), `.classSensitivity`, `.chromaThreshold`, `.bandWidth` (strings), `.devAutoOpenItem` (number) |
| `locale/` | Fluent strings for the pane (`en-US`, `zh-CN`; every message id prefixed `pdfnoir-prefs-`) |
| `tests/` | `bun test` suite: transform band, chroma gate, classification, caches, pane sliders, parameterization split |
| `scripts/build.ts` | Zero-dependency packer → `build/*.xpi` (+ identical `.zip`) |
| `docs/m0-findings.md` | How Zotero 10.0.6 dark mode actually renders PDF images (M0 investigation) |
| `docs/neutral-band.md` | Band and chroma mechanics: band geometry, overlap algebra, gate notes, result-cache key |

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
thresholds are met. Thresholds derive from the `classSensitivity` pref `s`
(0..1):

```
tNearWhite = 0.45 - 0.27*s      (s=0.7 -> 0.261)
tLowSat    = 0.75 - 0.25*s      (s=0.7 -> 0.575)
tFlat      = 0.55 - 0.25*s      (s=0.7 -> 0.375)
```

`s` affects classification ONLY: the pixel transform does not read it, so for
any image classified as white-background line art at BOTH sensitivities, the
pixel output is identical. `s` only decides whether an image is treated at
all, never how it is treated.

`0.7` (aggressive, the default) was chosen so typical paper figures with
colored curves on white are caught. Photographic content (no white
background, low flatness) is passed through untouched at every
`classSensitivity` setting.

### Transform (`transform.js`)

The neutral lightness axis is handled by **one mirror-symmetric band**
(`params({chromaT, bandWidth})`): a near-white end and a near-black end of the
same width, with the same ramp shape and the same chromatic gate. The band's
outer edge is fixed at `BAND_OUTER_HI = 0.934`, and `bandWidth` moves only the
inner edge (`darkLo` mirrors the outer edge, `darkHi` the inner edge), so both
ends always share the band width:

| End | Band (shipped `bandWidth` = 0.6) | Effect |
|---|---|---|
| near-white | `[whiteLo, whiteHi]` = `[0.334, 0.934]` | `alpha = alpha * (1 - wWhite)` — removed |
| near-black | `[darkLo, darkHi]` = `[0.066, 0.666]` | `rgb = mix(rgb, flipped, wDark)` — lightness flipped |

At the shipped width the two ends **overlap across the middle of the lightness
axis**, so mid-tone pixels are processed by default and receive both effects
at once — the alpha reduction from the white end and the lightness flip from
the dark end. The overlap is bounded: wherever both ramps are active their
weights sum to at most 1 for any `bandWidth` up to 0.868, so no pixel is
over-processed. The geometry, the weight-sum derivation, the behaviour above
0.868, the fixed constants, the `CHROMA_FLOOR` caveat and the exact
result-cache key are in [docs/neutral-band.md](docs/neutral-band.md).

`flipped` is the mirror of the pixel's lightness (`L -> 1 - L`) placed on the
theme foreground -> white axis:

```
flipped = fg + (255 - fg) * (1 - L)
```

so **pure black becomes white** (and the darkest ink lands near white — the
mirror of the near-white end becoming the theme background); the darkest
neutral ink is the lightest output. The flip is applied as a mix with the
original color, so mid-dark ink lands between the original and that value.

**Colour protection is a gate on relative chroma**, not the absolute channel
spread:

```
chroma = spread / max(maxChannel, CHROMA_FLOOR)   (CHROMA_FLOOR = 32)
chroma >= chromaT -> colored, left untouched;  chromaT = the chromaThreshold pref (shipped default 1)
```

Pixels whose relative chroma reaches the threshold are treated as colored and
left untouched; pixels below it are eligible for the band. The relative
measure exists because a dark saturated colour like `(40,0,0)` has a small
absolute spread but is fully saturated: the previous absolute-spread gate
(`spread >= 40 + 24*s`) misjudged such colours and lightened them.

At the shipped default only **fully saturated** pixels clear the gate:
relative chroma reaches 1.0 only when the smallest channel is exactly 0, so
mid-saturation colours are treated as ink and may be flipped toward light.
The default was chosen after live testing on the material the plugin is used
with. Lower `chromaThreshold` to protect more colour; at 0 every pixel counts
as coloured and the transform becomes a complete no-op.

There is no connectivity test and no interior exception: near-white is
background wherever it is (white fills, panels, baked-in white text
included).

The transform mutates the `ImageData` in place in a single pass and is cached
per upstream image identity + source rect + pixel size + transform parameters;
repeated renders of the same figure at the same scale (scroll, repaint) are
cache hits, and draws made under an active transfer map bypass the cache.
Memory is bounded per image identity and globally (64 MiB budget, LRU
eviction); `uninstall` clears the caches.

### Logging

Everything goes to the Zotero debug log with the `[PDF-Noir]` prefix
(`-console` or Help → Debug Output Logging → View Output). One line per
image draw, hit or miss:

```
[PDF-Noir] #1 img1 <w>x<h> src=up noir cache=miss cls=miss feats{white=… lowSat=… flat=… dark=…} thr{white=… lowSat=… flat=…} ms=… removed=…
[PDF-Noir] #2 img2 <w>x<h> src=up pass cls=miss feats{white=… lowSat=… flat=… dark=…} thr{white=… lowSat=… flat=…} ms=…
```

`src=up` means the cache key came from the upstream `imgData`/bitmap;
`noir` = transformed, `pass` = handed to Blender unchanged (`skip=...` names
the reason: `lightTheme`, `forceInversion`, `entirePage`, `tooLarge`).
`cache=` is the transformed-canvas cache, `cls=` the classification-feature
cache; `xf=on` marks a draw under an active transfer map (caches disabled for
it); `removed=` reports the share of pixels counted as removed background
(near-white removal weight above 0.5). The viewer realm cannot call
`Zotero.debug`; log lines are buffered on
the window and drained by `bootstrap.js` every 1.5 s. Note that Zotero's
`-console` stdout is buffered, so a redirected log file may only be complete
after Zotero exits.

## Prefs

| Pref | Type | Default | Read-time clamp | Meaning |
|---|---|---|---|---|
| `extensions.pdf-noir.enable` | bool | `true` | — | master switch (unset = enabled) |
| `extensions.pdf-noir.classSensitivity` | string | `"0.7"` | 0 … 1 | classification ONLY: how eagerly a raster image is judged white-background line art |
| `extensions.pdf-noir.chromaThreshold` | string | `"1"` | 0 … 1 | relative chroma gate: at or above it a pixel counts as colored and is left untouched; at the shipped default only fully saturated pixels (one channel at zero) still qualify |
| `extensions.pdf-noir.bandWidth` | string | `"0.6"` | 0 … 1 | width of the neutral band along the lightness axis; at the shipped width the near-white and near-black ends overlap in the mid-tones |
| `extensions.pdf-noir.devAutoOpenItem` | number | `0` | — | dev-only, not surfaced in the UI (item ID to auto-open at startup; `0` = off) |

The three numeric knobs are **strings** because Firefox default prefs have no
float type; each of them is a range slider with a live percentage readout in
the settings pane. How to change them:

1. **Edit → Settings → "Zotero PDF Noir"** (编辑 → 设置 →「Zotero PDF Noir」) —
   the pane the plugin registers at startup, at the bottom of the sidebar.
   Each readout also follows a change made outside the pane (Config Editor),
   and a change is reflected in an open reader within about 1.5 s without
   scrolling or zooming.
2. The Config Editor still works: **Edit → Settings → Advanced → Config
   Editor** (编辑 → 设置 → 高级 → 配置编辑器), accept the warning and search for
   `extensions.pdf-noir`. `enable` is a boolean; the three knobs are strings,
   as tabulated above.
3. Out-of-range values are clamped at read time, so a hand-edited value is
   silently corrected to the nearest clamp bound rather than honoured; the
   clamps match the slider ranges (0 … 1).
4. **Restore Defaults** in the pane writes all four UI prefs back through
   `Zotero.Prefs.set(..., true)`.

## Build

```sh
bun install
bun run build
bun test          # test suite: band, chroma gate, classification, caches,
                  # cache keys, parameterization split, transform parameter
                  # contract, zero-width band safety, pane slider grid
                  # contract
# -> build/zotero-pdf-noir-<version>.xpi
# -> build/zotero-pdf-noir-<version>.zip  (identical bytes; xpi is a zip)
```

The xpi root contains only `manifest.json`, `bootstrap.js`, `prefs.js`,
`content/`, `locale/` and `LICENSE`.

## Known behavior / side effects

- **White-background line art is redrawn for dark mode.** Near-white neutral
  pixels are made transparent, globally — interior white fills and panels
  included, with no connectivity test. Near-black neutral ink on them is
  flipped toward white, so black grid lines and text on white become light and
  readable.
- **Mid-tone pixels are processed by default.** At the shipped band width
  (0.6) the near-white and near-black ends overlap across the middle of the
  lightness axis, so mid-tone pixels receive both effects at once, and pale or
  mid-saturation fills may fade or lighten. Lower `bandWidth` narrows the band
  and keeps more of them.
- **Only fully saturated colours are protected at the shipped chroma
  threshold.** With `chromaThreshold` at 1.0, a pixel stays untouched only
  when its relative chroma reaches 1.0 — one channel exactly 0.
  Mid-saturation colours such as `(200,50,50)` are treated as ink and
  lightened; lower the threshold to protect more colour.
- **Passthrough cases:** light themes are never touched; themes that set
  `invertImages` (e.g. Zotero's "Black" theme) keep their full-inversion
  behavior; whole-page scans and images larger than 8 MP are handed to Blender
  unchanged.
- **Pref changes reach an open reader within about 1.5 s** without scrolling
  or zooming: the plugin re-reads the render-affecting prefs and forces a
  repaint.

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
