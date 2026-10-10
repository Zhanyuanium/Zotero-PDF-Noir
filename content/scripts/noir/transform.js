/* Zotero PDF Noir — pixel transform (v1.0.0).
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
 * The middle of the axis is untouched.
 *
 * Chromatic pixels are never modified. The decision uses a *relative* chroma
 * (see CHROMA_FLOOR), not the absolute channel spread: a dark saturated
 * colour like (40,0,0) has a small spread but is fully saturated, and an
 * absolute gate would wrongly flip it. All thresholds derive from the
 * sensitivity pref s (0..1).
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

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /**
   * Shared neutral-band parameters, derived from sensitivity s (0..1).
   *
   * The band is mirror-symmetric around L = 0.5:
   *   white: [whiteLo, whiteHi]   (alpha ramp)
   *   black: [darkLo, darkHi]     with darkLo = 1 - whiteHi, darkHi = 1 - whiteLo
   * Defaults (s = 0.7): white [0.768, 0.934], black [0.066, 0.232].
   *
   *   chromaT      - relative chroma gate; a pixel at or above it is treated
   *                  as coloured and left alone. Grows with s (more
   *                  aggressive = more colours accepted as neutral); bounded
   *                  by construction to 0.30, far below the chroma of any
   *                  clearly saturated colour, so raising s can never disable
   *                  colour protection.
   *   neutralSpread - width of the absolute-spread weight ramp (how quickly a
   *                  neutral pixel reaches full effect as its spread drops).
   */
  function params(s) {
    var whiteLo = 0.88 - 0.16 * s;
    var whiteHi = 0.99 - 0.08 * s;
    return {
      whiteLo: whiteLo,
      whiteHi: whiteHi,
      darkHi: 1 - whiteLo,
      darkLo: 1 - whiteHi,
      chromaT: 0.2 + 0.1 * s,
      neutralSpread: 40 + 24 * s,
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
   * @param {object} P params(s)
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

    var wWhite = clamp01((L - P.whiteLo) / (P.whiteHi - P.whiteLo)) * wSat;
    var wDark = clamp01((P.darkHi - L) / (P.darkHi - P.darkLo)) * wSat;

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
   * @param {number} s sensitivity 0..1
   * @param {string} fgHex theme foreground
   * @returns {{removedFrac:number}}
   */
  function transformImageData(imageData, s, fgHex) {
    var P = params(s);
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
