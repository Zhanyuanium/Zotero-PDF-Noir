pref("extensions.pdf-noir.enable", true);
// All three numeric knobs are stored as STRINGS because Firefox default prefs
// have no float type (a float literal would read back as int 0); bootstrap.js
// parses them with parseFloat and clamps.
//
// Classification sensitivity, 0.0 (conservative) .. 1.0 (aggressive). Tunes
// ONLY whether a raster counts as white-background line art; it no longer
// affects the pixel transform. 0.7 is the aggressive default (typical paper
// figures with colored curves on white are caught; lower it to keep more
// light tints).
pref("extensions.pdf-noir.classSensitivity", "0.7");
// Relative chroma gate, 0.00 .. 1.00. At or above it a pixel is treated as
// coloured and left untouched. Relative chroma reaches 1.0 only when one
// channel is exactly 0 and the max channel is >= 32, so the shipped default
// (1.00) still protects exactly-saturated colours like (255,0,0) and (40,0,0)
// but no longer gates out mid-saturation ones such as (200,50,50). Lower the
// value to protect more colour; 0.00 treats every pixel as coloured, turning
// the transform into a no-op.
pref("extensions.pdf-noir.chromaThreshold", "1");
// Width of the mirror-symmetric neutral band around L = 0.5, 0.00 .. 1.00
// (see BAND_OUTER_HI in content/scripts/noir/transform.js). 0.00 disables both
// band effects. The ramps start overlapping in the mid-tones at 0.434 and
// their weights still sum to at most 1 up to 0.868; the shipped 0.6 default
// (white [0.334, 0.934], black [0.066, 0.666]) is deliberately in that
// overlapping regime, so mid-tone pixels receive both the alpha reduction and
// the lightness flip. Values above 0.868 combine the two effects past one full
// pass (the maximum-aggressiveness end of the range).
pref("extensions.pdf-noir.bandWidth", "0.6");
// Dev-only: item id to auto-open on startup; 0 disables it.
pref("extensions.pdf-noir.devAutoOpenItem", 0);
