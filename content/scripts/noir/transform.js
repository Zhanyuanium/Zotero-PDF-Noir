/* Zotero PDF Noir — pixel transform (v1.1.0).
 *
 * Runs inside the pdf.js viewer realm. Pure typed-array pixel work on the
 * ImageData of the source rect, at original resolution, single pass.
 *
 * The neutral lightness axis is handled by ONE mirror-symmetric band
 * (see `params`): a near-white end and a near-black end that share the same
 * width, the same ramp shape and the same chromatic gate. The two ends get
 * the two symmetric effects:
 *
 *   near-white end -> remove:  alpha = alpha * (1 - wWhite)
 *   near-black end -> flip:    rgb   = mix(rgb, flipped, wDark)
 *
 * `flipped` is the mirror of the pixel's lightness (L -> 1 - L) placed on the
 * theme foreground -> white axis: `flipped = fg + (255 - fg) * (1 - L)`, so
 * pure black becomes (nearly) white and the darkest ink is the lightest
 * output — the mirror of the near-white end becoming the theme background.
 * The middle of the axis is untouched while the band stays narrow. Wider bands
 * reach into it deliberately, and above the 0.868 disjointness bound a
 * mid-tone pixel receives both effects at once (see `params`).
 *
 * Chromatic pixels are protected by a *relative* chroma gate (see
 * CHROMA_FLOOR), not the absolute channel spread: a dark saturated colour
 * like (40,0,0) has a small spread but is fully saturated, and an absolute
 * gate would wrongly flip it. Relative chroma reaches 1.0 only when one
 * channel is exactly 0 and the max channel is >= 32, so the shipped default
 * gate (1.0) still protects exactly-saturated colours — (255,0,0), (40,0,0),
 * (0,0,60) — but no longer gates out mid-saturation colours such as
 * (200,50,50). How much a passed pixel actually changes still depends on the
 * absolute-spread ramp (NEUTRAL_SPREAD): (200,50,50)'s spread is far above
 * it and gets zero weight, while moderately tinted inks (e.g. (60,40,30))
 * are now processed. Protecting mid-saturation colour is the user's decision
 * via lowering the gate; 0 treats every pixel as coloured, turning the whole
 * transform into a no-op. Both endpoints are degenerate but graceful.
 *
 * Parameterization (v1.1.0): the transform has its own two knobs, both passed
 * in by hook.js and clamped by bootstrap.js:
 *  - BAND_OUTER_HI is the fixed outer edge of the band; bandWidth (pref,
 *    0..1) is how far each end reaches inward from it. 0 disables both ends.
 *    In the region where both ramps are active their weights sum to
 *    (1 - 2*inner) / bandWidth, so up to bandWidth 0.868 the two ends compose
 *    to at most one full pass — the shipped default (0.6) sits in this
 *    overlapping regime, so mid-tones get both effects; above 0.868 a
 *    mid-tone receives both past one full pass, the accepted
 *    maximum-aggressiveness behaviour;
 *  - chromaT (pref, 0..1) is the relative chroma gate.
 * NEUTRAL_SPREAD is a fixed constant: the absolute-spread ramp width, not a
 * user knob. Classification sensitivity is NOT an input here any more (the
 * split): it only tunes classify.js, so changing it cannot alter pixels.
 *
 * The figure's content is baked into the bitmap (lines, labels, satellite
 * icons, ...) and goes through this transform. If the PDF also draws vector
 * copies of figure elements over the bitmap, Zotero's Blender already maps
 * those styles to theme-light colours; page-level vector content (body text,
 * column rules) is out of scope as well.
 *
 * All output is written back into the given ImageData in place.
 */
(function () {
  "use strict";

  var g = typeof window !== "undefined" ? window : globalThis;
  var NS = (g.PDFNoir = g.PDFNoir || {});

  // Denominator floor for the relative chroma. Without it, JPEG chroma noise
  // on near-black ink (max channel ~10) would produce a high ratio and the
  // ink would stop being flipped; with it, a pixel must exceed both a minimum
  // absolute spread and the relative threshold to count as coloured.
  var CHROMA_FLOOR = 32;

  // Fixed OUTER edge of the neutral band on the lightness axis (furthest from
  // L = 0.5). The white end's full-effect edge and the dark end's full-effect
  // edge are mirror images — whiteHi = BAND_OUTER_HI, darkLo = 1 -
  // BAND_OUTER_HI — and the band width extends both ends inward to their
  // matching inner edges (whiteLo, darkHi). Anchoring on role-named edges
  // like this is what removes the old whiteHi/darkLo ambiguity: no dark edge
  // is derived from a white-edge variable.
  var BAND_OUTER_HI = 0.934;

  // Width of the absolute-spread weight ramp (how quickly a neutral pixel
  // reaches full effect as its spread drops). Fixed at the ramp the old
  // sensitivity default produced; intentionally NOT a user knob — it shapes
  // anti-aliasing behaviour, it does not define what counts as neutral.
  var NEUTRAL_SPREAD = 56.8;

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /**
   * Shared neutral-band parameters.
   *
   * The band is mirror-symmetric around L = 0.5. One pair of ROLE-named
   * edges defines it, and both ends derive from those roles — never from the
   * other end's variables (that was the old whiteHi/darkLo ambiguity):
   *   outer = BAND_OUTER_HI               (furthest from L = 0.5)
   *   inner = BAND_OUTER_HI - bandWidth   (closest to L = 0.5)
   *   white end: [whiteLo, whiteHi] = [inner, outer]
   *   dark end:  [darkLo, darkHi]   = [1 - outer, 1 - inner]
   * so the pairing is outer↔outer / inner↔inner: darkLo mirrors the white
   * band's OUTER edge, darkHi mirrors its INNER edge.
   * Defaults ({chromaT: 1.0, bandWidth: 0.6}): white [0.334, 0.934],
   * black [0.066, 0.666] — the ends overlap across the middle of the axis,
   * so mid-tones receive both effects by default while their weight sum stays
   * <= 1 (0.6 is below the 0.868 bound).
   *
   * @param {{chromaT:number, bandWidth:number}} opts
   *   chromaT (0..1) - relative chroma gate; a pixel at or above it is
   *   treated as coloured and left alone. At the shipped default (1.0) only
   *   exactly-saturated colours (spread === max channel) qualify; see the
   *   file header. 0 treats every pixel as coloured (a complete no-op).
   *   bandWidth (0..1) - inward reach of each end; bootstrap.js caps it at
   *   1.0. The shipped default (0.6) already overlaps: mid-tones receive both
   *   effects while the sum of weights stays <= 1 (the bound is 0.868). Above
   *   that the sum exceeds 1, which is intended; darkHi (= 1 - inner) then
   *   exceeds 1 and leaves the physical lightness range — harmless, because
   *   clamp01 bounds each weight individually. A width of 0 disables both
   *   ends.
   * @returns {{whiteLo:number, whiteHi:number, darkLo:number, darkHi:number,
   *   chromaT:number, neutralSpread:number}}
   */
  function params(opts) {
    var outer = BAND_OUTER_HI;
    var inner = BAND_OUTER_HI - opts.bandWidth;
    return {
      whiteLo: inner,
      whiteHi: outer,
      darkLo: 1 - outer,
      darkHi: 1 - inner,
      chromaT: opts.chromaT,
      neutralSpread: NEUTRAL_SPREAD,
    };
  }

  function hexToRgb(hex) {
    var h = String(hex || "").replace("#", "");
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    var n = parseInt(h, 16);
    if (!isFinite(n)) {
      return [0, 0, 0];
    }
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /**
   * Evaluate the neutral band for one colour: the single decision function of
   * the pixel transform (called once per pixel by `transformImageData`;
   * exported for console debugging and tests).
   *
   * @param {number} r @param {number} g @param {number} b 0..255
   * @param {object} P params(opts)
   * @param {number[]} fg theme foreground rgb (0..255)
   * @returns {?{L:number, chroma:number, wWhite:number, wDark:number, flip:number[]}}
   *   null for chromatic colours (relative chroma gate)
   */
  function neutralEval(r, g, b, P, fg) {
    var mx = r > g ? (r > b ? r : b) : g > b ? g : b;
    var mn = r < g ? (r < b ? r : b) : g < b ? g : b;
    var spread = mx - mn;
    var denom = mx > CHROMA_FLOOR ? mx : CHROMA_FLOOR;
    var chroma = spread / denom;
    if (chroma >= P.chromaT) {
      return null; // coloured -> untouched
    }
    var wSat = clamp01((P.neutralSpread - spread) / P.neutralSpread);
    var L = (2126 * r + 7152 * g + 722 * b) / 2550000;

    // A zero-width band must be inert, not NaN: at bandWidth 0 the two edges
    // of an end coincide, so (L - whiteLo) / 0 would be Infinity or NaN — and
    // clamp01 passes NaN through into the pixels. Compute each span once and
    // skip the ramp when it is not positive.
    var wWhiteSpan = P.whiteHi - P.whiteLo;
    var wDarkSpan = P.darkHi - P.darkLo;
    var wWhite = wWhiteSpan > 0 ? clamp01((L - P.whiteLo) / wWhiteSpan) * wSat : 0;
    var wDark = wDarkSpan > 0 ? clamp01((P.darkHi - L) / wDarkSpan) * wSat : 0;

    // Flipped colour: the mirror of the lightness (1 - L) on the
    // foreground -> white axis (pure black -> white).
    var Lf = 1 - L;
    var flip = [
      fg[0] + (255 - fg[0]) * Lf,
      fg[1] + (255 - fg[1]) * Lf,
      fg[2] + (255 - fg[2]) * Lf,
    ];
    return { L: L, chroma: chroma, wWhite: wWhite, wDark: wDark, flip: flip };
  }

  /**
   * @param {ImageData} imageData source rect at original resolution (mutated in place)
   * @param {object} P resolved params, i.e. the output of `params(opts)` — the
   *   SAME object the caller passes to `neutralEval` and to `resKey`. Taking P
   *   rather than the raw opts is what guarantees the cached result and the
   *   pixels it was produced from are the same transform: the caller builds P
   *   once per draw and hands the identical object to both.
   * @param {string} fgHex theme foreground
   * @returns {{removedFrac:number}}
   */
  function transformImageData(imageData, P, fgHex) {
    var fg = hexToRgb(fgHex);
    var data = imageData.data;
    var w = imageData.width;
    var h = imageData.height;
    var N = w * h;

    var removed = 0;
    for (var i = 0, p = 0; i < N; i++, p += 4) {
      var r = data[p];
      var gg = data[p + 1];
      var b = data[p + 2];
      var e = neutralEval(r, gg, b, P, fg);
      if (!e) {
        continue; // coloured
      }

      // near-white end: remove
      if (e.wWhite > 0) {
        data[p + 3] = data[p + 3] * (1 - e.wWhite);
        if (e.wWhite > 0.5) {
          removed++;
        }
      }

      // near-black end: flip the lightness toward white
      if (e.wDark > 0) {
        var wd = e.wDark;
        data[p] = r + (e.flip[0] - r) * wd;
        data[p + 1] = gg + (e.flip[1] - gg) * wd;
        data[p + 2] = b + (e.flip[2] - b) * wd;
      }
    }
    return { removedFrac: N ? removed / N : 0 };
  }

  NS.transform = {
    params: params,
    hexToRgb: hexToRgb,
    neutralEval: neutralEval,
    transformImageData: transformImageData,
  };
})();
