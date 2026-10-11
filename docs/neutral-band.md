# Neutral Band and Chroma-Gate Mechanics

Status: current for the shipped 1.1.0 defaults (`chromaThreshold` = 1, `bandWidth` = 0.6).

This document holds the implementation detail behind the `bandWidth` and
`chromaThreshold` prefs that the README summarises: the band geometry, the
overlap algebra, the chroma-gate notes (including `CHROMA_FLOOR`) and the
result-cache key. [m0-findings.md](m0-findings.md) covers how Zotero's dark
mode reaches this pixel path in the first place.

## Band geometry

The neutral lightness axis (`L` in 0..1) is handled by **one mirror-symmetric
band**: a near-white end and a near-black end of the same width, with the same
ramp shape and the same chromatic gate. The outer edge is fixed; `bandWidth`
moves only the inner edge (`darkLo` mirrors the outer edge, `darkHi` the inner
edge):

```
BAND_OUTER_HI = 0.934      fixed: the near-white end reaches full effect here
whiteLo = BAND_OUTER_HI - bandWidth
whiteHi = BAND_OUTER_HI
darkLo  = 1 - BAND_OUTER_HI   mirrors the OUTER edge
darkHi  = 1 - whiteLo         mirrors the inner edge
NEUTRAL_SPREAD = 56.8      fixed constant: anti-aliasing ramp width, not a user knob
```

At the shipped `bandWidth` 0.6 the intervals are white `[0.334, 0.934]` and
black `[0.066, 0.666]`. The two symmetric effects are:

| End | Effect |
|---|---|
| near-white | `alpha = alpha * (1 - wWhite)` — the pixel is removed |
| near-black | `rgb = mix(rgb, flipped, wDark)` — lightness flipped |

with

```
flipped = fg + (255 - fg) * (1 - L)
```

where `fg` is the theme foreground: the mirror of the pixel's lightness placed
on the theme foreground -> white axis, so pure black becomes white. The flip
is applied as a mix with the original colour, so mid-dark ink lands between
the original and that value. The ramps are smooth, so antialiased edges fade
instead of getting a hard halo.

## Overlap algebra

Write `inner = whiteLo = 0.934 - bandWidth`. The two intervals intersect when
`whiteLo < darkHi`, i.e. `bandWidth > 0.434`. Wherever both ramps are active,
their weights sum to

```
(1 - 2*inner) / bandWidth = (2*bandWidth - 0.868) / bandWidth
```

which is at most 1 exactly when `bandWidth <= 0.868`. Consequences:

- `bandWidth <= 0.434`: the two ends never intersect.
- `0.434 < bandWidth <= 0.868` (includes the shipped 0.6): the ends overlap in
  the mid-tones, and a mid-tone pixel receives both effects — alpha reduction
  from the white end and the lightness flip from the dark end — but the
  weights sum to at most 1, so no pixel is processed beyond one full-strength
  band application.
- `bandWidth > 0.868`: in the middle the weight sum exceeds 1 — reachable now
  that the range runs to 1.0 — so a mid-tone pixel receives both effects at
  once, with a combined weight above one full-strength band application (each
  individual weight still stays under 1). This is the deliberate "maximum
  aggressiveness" end of the control, not a malfunction; `clamp01` bounds each
  weight, so the output stays in range.
- `darkHi = 0.066 + bandWidth` exceeds 1.0 above `bandWidth = 0.934`: the dark
  band's outer edge lies outside the physical lightness range. That is
  harmless; the ramp simply saturates.
- `bandWidth = 0`: the band has no width and both effects are inert. The ramp
  division is guarded, so the zero-width case yields zero weights rather than
  writing `NaN` into pixels.

## Chroma gate

```
chroma = spread / max(maxChannel, CHROMA_FLOOR)   CHROMA_FLOOR = 32
chroma >= chromaT -> coloured, left untouched;  chromaT = the chromaThreshold pref
```

Relative chroma is used instead of the absolute channel spread because a dark
saturated colour like `(40,0,0)` has a small spread but is fully saturated;
the earlier absolute gate (`spread >= 40 + 24*s`) misjudged and lightened such
colours. The largest reachable value is 1.0, reached exactly when
`spread === maxChannel` — i.e. when the smallest channel is 0.

`CHROMA_FLOOR` matters at the dark end: the divisor is
`max(maxChannel, 32)`, so a very dark pixel with a small absolute spread sits
below the gate even when it is fully saturated. The floor is deliberate —
without it, JPEG chroma noise on near-black ink would keep the ink from being
flipped — but it also means `(9,0,0)` reads chroma `9 / 32 = 0.28`, not 1.

Worked examples at the shipped threshold `chromaT` = 1.0:

| Pixel | spread / divisor | chroma | at `chromaT` 1.0 |
|---|---|---|---|
| `(255,0,0)` | 255 / 255 | 1.00 | protected |
| `(40,0,0)` | 40 / 40 | 1.00 | protected |
| `(0,0,60)` | 60 / 60 | 1.00 | protected |
| `(200,50,50)` | 150 / 200 | 0.75 | not protected — treated as ink, flipped toward light |
| `(9,0,0)` | 9 / 32 | 0.28 | not protected — the floor depresses it, flipped toward light |

Endpoint behaviour: `chromaT` = 0 treats every pixel as coloured and makes the
transform a complete no-op; `chromaT` = 1.0 leaves only fully saturated colour
untouched, as above. Both endpoints are degenerate but graceful (no crash, no
corrupted pixels).

The defaults were chosen after live testing on the material the plugin is used
with: `chromaThreshold` 1 and `bandWidth` 0.6 are the settings that looked
best there. A Firefox default pref applies only when the user has never set
that pref, so fresh profiles get these defaults and existing profiles keep
their stored values; there is no migration code.

## Caches and clamps

The transformed canvas is cached per upstream image identity + source rect +
pixel size + transform parameters. The result key is `resKey(fkey, P, fgHex)`,
built from chroma gate + band width + theme **foreground** (the background
does not influence the output); changing either knob misses the result cache,
while the classification-feature cache is parameter-independent and still
hits. Draws made under an active transfer map
(`CanvasGraphics.current.transferMaps`) bypass both caches — that path is rare
and recomputing is safer than mixing results. Memory is bounded per image
identity and globally (64 MiB budget, LRU eviction); `uninstall` clears the
caches.

Both numeric knobs are clamped to 0 … 1 at read time: a hand-edited value
outside the slider range is silently corrected to the nearest bound rather
than honoured.
