/* Zotero PDF Noir — classification (v1.0.0).
 *
 * Runs inside the pdf.js viewer realm (injected by bootstrap.js). Decides
 * whether a raster image is "white-background line art" that the noir
 * transform should handle, or content Blender should treat normally.
 *
 * Classification is done on a downsampled copy (long side ~192 px) only;
 * the transform itself always runs at the original resolution so thin
 * strokes are preserved.
 *
 * Features (all 0..1, computed over opaque pixels only):
 *   nearWhite  - fraction of pixels with lightness > 0.94 and relative
 *                saturation < 0.1
 *   lowSat     - fraction of pixels that are neutral: absolute channel
 *                spread <= 32 or relative saturation < 0.2
 *   flat       - fraction of adjacent opaque pixel pairs with max channel
 *                difference <= 12 (Blender's deviation convention)
 *   darkNeutral - fraction of pixels with L < 0.5 and neutral color
 *
 * Transparent pixels are excluded from every denominator, and a flat pair is
 * only counted when both of its pixels are opaque, so a transparent margin
 * cannot skew the ratios.
 *
 * Decision thresholds derive from the sensitivity pref s (0..1):
 *   tNearWhite = 0.45 - 0.27*s
 *   tLowSat    = 0.75 - 0.25*s
 *   tFlat      = 0.55 - 0.25*s
 * At the aggressive default s = 0.7: 0.261 / 0.575 / 0.375.
 */
(function () {
  "use strict";

  var g = typeof window !== "undefined" ? window : globalThis;
  var NS = (g.PDFNoir = g.PDFNoir || {});

  var LONG_SIDE = 192;
  var FLAT_TOL = 12;
  var NEUTRAL_SPREAD = 32;
  var ALPHA_MIN = 32;

  function featuresFromImageData(imageData) {
    var data = imageData.data;
    var w = imageData.width;
    var h = imageData.height;
    var valid = 0;
    var nearWhite = 0;
    var lowSat = 0;
    var darkNeutral = 0;
    var flatPairs = 0;
    var totalPairs = 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var p = (y * w + x) * 4;
        if (data[p + 3] < ALPHA_MIN) {
          continue; // transparent: not a valid pixel
        }
        valid++;
        var r = data[p];
        var gg = data[p + 1];
        var b = data[p + 2];
        var mx = r > gg ? (r > b ? r : b) : gg > b ? gg : b;
        var mn = r < gg ? (r < b ? r : b) : gg < b ? gg : b;
        var spread = mx - mn;
        var L = (2126 * r + 7152 * gg + 722 * b) / 2550000;
        var S = mx === 0 ? 0 : spread / mx;
        if (L > 0.94 && S < 0.1) {
          nearWhite++;
        }
        if (spread <= NEUTRAL_SPREAD || S < 0.2) {
          lowSat++;
        }
        if (L < 0.5 && spread <= NEUTRAL_SPREAD) {
          darkNeutral++;
        }
        if (x + 1 < w) {
          var q = p + 4;
          if (data[q + 3] >= ALPHA_MIN) {
            totalPairs++;
            if (
              Math.abs(r - data[q]) <= FLAT_TOL &&
              Math.abs(gg - data[q + 1]) <= FLAT_TOL &&
              Math.abs(b - data[q + 2]) <= FLAT_TOL
            ) {
              flatPairs++;
            }
          }
        }
        if (y + 1 < h) {
          var q2 = p + w * 4;
          if (data[q2 + 3] >= ALPHA_MIN) {
            totalPairs++;
            if (
              Math.abs(r - data[q2]) <= FLAT_TOL &&
              Math.abs(gg - data[q2 + 1]) <= FLAT_TOL &&
              Math.abs(b - data[q2 + 2]) <= FLAT_TOL
            ) {
              flatPairs++;
            }
          }
        }
      }
    }
    return {
      valid: valid,
      nearWhite: valid ? nearWhite / valid : 0,
      lowSat: valid ? lowSat / valid : 0,
      flat: totalPairs ? flatPairs / totalPairs : 0,
      darkNeutral: valid ? darkNeutral / valid : 0,
    };
  }

  function thresholds(s) {
    return {
      nearWhite: 0.45 - 0.27 * s,
      lowSat: 0.75 - 0.25 * s,
      flat: 0.55 - 0.25 * s,
    };
  }

  function decide(features, s) {
    var t = thresholds(s);
    var hit =
      features.nearWhite >= t.nearWhite &&
      features.lowSat >= t.lowSat &&
      features.flat >= t.flat;
    return { hit: hit, thresholds: t };
  }

  /**
   * Downsample the source rect of `img` and compute features.
   * @param {Window} win viewer window
   * @param {CanvasImageSource} img
   * @param {{sX:number,sY:number,sW:number,sH:number}} rect
   */
  function classify(win, img, rect) {
    var long = Math.max(rect.sW, rect.sH);
    var scale = Math.min(1, LONG_SIDE / long);
    var tw = Math.max(1, Math.round(rect.sW * scale));
    var th = Math.max(1, Math.round(rect.sH * scale));
    var c = win.document.createElement("canvas");
    c.width = tw;
    c.height = th;
    var cx = c.getContext("2d");
    cx.drawImage(img, rect.sX, rect.sY, rect.sW, rect.sH, 0, 0, tw, th);
    var d = cx.getImageData(0, 0, tw, th);
    return featuresFromImageData(d);
  }

  NS.classify = {
    LONG_SIDE: LONG_SIDE,
    featuresFromImageData: featuresFromImageData,
    thresholds: thresholds,
    decide: decide,
    classify: classify,
  };
})();
