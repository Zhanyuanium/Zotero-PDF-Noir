/* Zotero PDF Noir — pixel transform (M2).
 *
 * Runs inside the pdf.js viewer realm. Pure typed-array pixel work on the
 * ImageData of the source rect, at original resolution, single pass.
 *
 * Rules (all thresholds derive from sensitivity s, 0..1):
 *  1. Near-white neutral pixels are removed globally: alpha = 255 * (1 - wBg)
 *     where wBg is a smooth lightness/saturation weight, so antialiased
 *     edges fade instead of getting a hard halo. There is no connectivity
 *     test and no interior exception — any pixel close to white is treated
 *     as background, wherever it is.
 *  2. Neutral dark ink is lifted toward the theme foreground color
 *     (fg -> white ramp). Every lift-eligible pixel is lifted, including
 *     ink that used to sit on white fills.
 *  3. Saturated pixels are untouched (absolute channel spread gate).
 *
 * All output is written back into the given ImageData in place.
 */
(function () {
  "use strict";

  var g = typeof window !== "undefined" ? window : globalThis;
  var NS = (g.PDFNoir = g.PDFNoir || {});

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  function params(s) {
    return {
      // near-white background removal weight (alpha)
      loL: 0.86 - 0.08 * s,
      hiL: 0.99 - 0.06 * s,
      satHi: 0.3 - 0.08 * s,
      satLo: 0.12 - 0.04 * s,
      // neutral ink lift
      liftPivot: 0.5 + 0.25 * s,
      liftMax: 0.95 + 0.03 * s,
      liftFade: 0.05,
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
   * @param {ImageData} imageData source rect at original resolution (mutated in place)
   * @param {number} s sensitivity 0..1
   * @param {string} bgHex theme background (unused by the transform, kept for API symmetry)
   * @param {string} fgHex theme foreground
   * @returns {{removedFrac:number}}
   */
  function transformImageData(imageData, s, bgHex, fgHex) {
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
      var mx = r > gg ? (r > b ? r : b) : gg > b ? gg : b;
      var mn = r < gg ? (r < b ? r : b) : gg < b ? gg : b;
      var spread = mx - mn;
      var L = (2126 * r + 7152 * gg + 722 * b) / 2550000;
      var S = mx === 0 ? 0 : spread / mx;

      // 1) near-white background removal, global and smooth
      var wL = clamp01((L - P.loL) / (P.hiL - P.loL));
      var wS = clamp01((P.satHi - S) / (P.satHi - P.satLo));
      var wbg = wL * wS;
      if (wbg > 0) {
        data[p + 3] = data[p + 3] * (1 - wbg);
        if (wbg > 0.5) {
          removed++;
        }
      }

      // 2) lift neutral dark ink toward the theme foreground
      var wl;
      if (L <= P.liftMax - P.liftFade) {
        wl = 1;
      } else if (L >= P.liftMax) {
        wl = 0;
      } else {
        wl = (P.liftMax - L) / P.liftFade;
      }
      var ws = spread >= P.neutralSpread ? 0 : (P.neutralSpread - spread) / P.neutralSpread;
      var wgt = wl * ws;
      if (wgt > 0) {
        var tt = L >= P.liftPivot ? 1 : L / P.liftPivot;
        var nr = fg[0] + (255 - fg[0]) * tt;
        var ng = fg[1] + (255 - fg[1]) * tt;
        var nb = fg[2] + (255 - fg[2]) * tt;
        data[p] = data[p] * (1 - wgt) + nr * wgt;
        data[p + 1] = data[p + 1] * (1 - wgt) + ng * wgt;
        data[p + 2] = data[p + 2] * (1 - wgt) + nb * wgt;
      }
    }
    return { removedFrac: N ? removed / N : 0 };
  }

  NS.transform = {
    params: params,
    hexToRgb: hexToRgb,
    transformImageData: transformImageData,
  };
})();
