/* Pixel transform tests: mirror symmetry, band continuity, the relative
 * chroma gate (A1), alpha behaviour, determinism (explicitly not idempotence),
 * the parameterization split (classification sensitivity must not influence
 * the transform), and the hook's production call boundary.
 */
import { describe, expect, test } from "bun:test";
import { cloneImageData, loadNoir, makeImageData } from "./helpers.js";

const NS = loadNoir(["transform.js"]);
const T = NS.transform;

// Shipped defaults, mirroring the root prefs.js (cross-file agreement is
// asserted in preferences.test.js): gate wide open at 1.0, band 0.6.
const DEFAULTS = { chromaT: 1.0, bandWidth: 0.6 };
// Chroma-gate fixtures below (CASES) require gates between the fixtures'
// relative chromas: above 0.1875 (the lowest neutral ink) and at or below
// 0.30 (the "clearly saturated" (180,150,120) sits at 0.333). The shipped
// gate (1.0) blocks only exactly-saturated colours and has its own test.
const GATE_OPTS = [
  { chromaT: 0.20, bandWidth: 0.02 },
  { chromaT: 0.30, bandWidth: 0.10 },
  { chromaT: 0.24, bandWidth: 0.20 },
  { chromaT: 0.27, bandWidth: 0.40 },
];
// Option pairs spanning the usable parameter space: the shipped defaults plus
// the gate options. bandWidth 0 (a complete no-op) and the 1.0 maximum (both
// ramps combined past one full pass) have dedicated tests below.
const OPTS = [DEFAULTS, ...GATE_OPTS];
// Widths spanning the full slider range, including both degenerate ends.
const WIDTHS = [0, 0.02, 0.4, 0.5, 0.6, 0.868, 0.9, 1.0];
// The clamp maximum: each ramp is one full axis-width long and spills past
// the visible 0..1 range on one side.
const MAX = { chromaT: 1.0, bandWidth: 1.0 };
const FG = "#d8dee9";
const fg = T.hexToRgb(FG);

/** neutralEval for a gray value (L = v/255 exactly, spread 0). */
function evalGray(v, opts) {
  return T.neutralEval(v, v, v, T.params(opts), fg);
}

/** Run the transform on one colour, return the resulting RGBA. */
function run(rgb, opts = DEFAULTS) {
  const img = makeImageData(1, 1, [rgb[0], rgb[1], rgb[2], 255]);
  // transformImageData takes RESOLVED params, exactly as hook.js does.
  T.transformImageData(img, T.params(opts), FG);
  return Array.from(img.data);
}

/**
 * The transform sees integer bytes: an edge at lightness v is sampled at
 * round(v * 255), so the nearest sample can sit up to one byte inside the
 * ramp. That is 1 / (255 * bandWidth) of the ramp — the tolerance of the
 * boundary checks below (without it a narrow band would look "discontinuous"
 * merely because a single byte covers a fifth of it).
 */
function byteTol(P) {
  return 1 / (255 * (P.whiteHi - P.whiteLo));
}

describe("params", () => {
  test("shipped defaults resolve to the exact overlapping 0.6 band", () => {
    const P = T.params(DEFAULTS);
    // chromaT 1.0 / bandWidth 0.6: white [0.334, 0.934], black
    // [0.066, 0.666]. The ends overlap across the middle of the axis by
    // design (0.6 is below the 0.868 bound), so mid-tones get both effects.
    expect(P.whiteLo).toBeCloseTo(0.334, 10);
    expect(P.whiteHi).toBeCloseTo(0.934, 10);
    expect(P.darkLo).toBeCloseTo(0.066, 10);
    expect(P.darkHi).toBeCloseTo(0.666, 10);
    expect(P.chromaT).toBeCloseTo(1.0, 10);
    expect(P.neutralSpread).toBeCloseTo(56.8, 10);
  });

  test("shipped defaults already overlap in the mid-tones", () => {
    // bandWidth 0.6 > 0.434, so the two ramps meet at L = 0.5: a mid-tone now
    // receives the white end's alpha reduction and the dark end's flip at
    // once. The weight sum stays <= 1 (0.6 < the 0.868 bound).
    const P = T.params(DEFAULTS);
    const mid = T.neutralEval(128, 128, 128, P, fg);
    expect(mid.wWhite).toBeGreaterThan(0);
    expect(mid.wDark).toBeGreaterThan(0);
    expect(mid.wWhite + mid.wDark).toBeLessThanOrEqual(1 + 1e-9);
    expect(run([128, 128, 128])).not.toEqual([128, 128, 128, 255]);
  });

  test("mirror-symmetric around L = 0.5 for every option pair", () => {
    for (const opts of OPTS) {
      const P = T.params(opts);
      // darkLo mirrors the OUTER edge (whiteHi), darkHi the INNER edge
      // (whiteLo): outer↔outer / inner↔inner, never one end's variable used
      // to compute the other end's edges.
      expect(P.darkLo).toBeCloseTo(1 - P.whiteHi, 12);
      expect(P.darkHi).toBeCloseTo(1 - P.whiteLo, 12);
      expect(P.darkLo).toBeLessThan(P.darkHi);
      expect(P.whiteLo).toBeLessThan(P.whiteHi);
    }
  });

  test("below the 0.434 halfway width the two ends stay disjoint", () => {
    // inner = BAND_OUTER_HI - bandWidth reaches L = 0.5 (inner = 0.5) at
    // width 0.434; below that whiteLo > 0.5 > darkHi and the middle of the
    // axis is untouched. The shipped default (0.6) is above it by design.
    for (const bandWidth of [0.02, 0.2, 0.4]) {
      const P = T.params({ chromaT: 1.0, bandWidth });
      expect(P.whiteLo).toBeGreaterThan(0.5);
      expect(P.darkHi).toBeLessThan(0.5);
    }
  });

  test("chromaT is passed through unchanged, neutralSpread is fixed", () => {
    for (const opts of OPTS) {
      const P = T.params(opts);
      expect(P.chromaT).toBeCloseTo(opts.chromaT, 12);
      expect(P.neutralSpread).toBe(56.8);
    }
  });

  test("each weight stays within 0..1 across the full 0..1 width range", () => {
    // clamp01 is the real safety net: every weight is independently bounded,
    // so even a fully overlapping band can never push one effect past full
    // strength. Checked over the whole slider range, degenerate ends included.
    for (const bandWidth of WIDTHS) {
      for (let v = 0; v <= 255; v++) {
        const e = evalGray(v, { chromaT: 1.0, bandWidth });
        expect(e.wWhite).toBeGreaterThanOrEqual(0);
        expect(e.wWhite).toBeLessThanOrEqual(1);
        expect(e.wDark).toBeGreaterThanOrEqual(0);
        expect(e.wDark).toBeLessThanOrEqual(1);
      }
    }
  });

  test("past 0.868 a mid-tone gets BOTH effects; the output stays well-formed", () => {
    // The accepted maximum-aggressiveness mode. With inner = BAND_OUTER_HI -
    // bandWidth, wherever both ramps are active their weights sum to
    // (1 - 2*inner) / bandWidth = 2 - 0.868/bandWidth, so above bandWidth
    // 0.868 that sum exceeds 1: a mid-tone pixel receives the white end's
    // alpha reduction AND the dark end's flip at once. This is intended; the
    // invariants that still hold are per-weight bounds (previous test) and
    // well-formed output.
    const P = T.params(MAX);
    // At the maximum each ramp is one full axis-width long and spills past
    // the visible range: whiteLo -0.066 .. whiteHi 0.934, darkLo 0.066 ..
    // darkHi 1.066. darkHi leaving the physical 0..1 range is harmless —
    // clamp01 bounds the weight.
    expect(P.whiteLo).toBeLessThan(0);
    expect(P.darkHi).toBeGreaterThan(1);

    const mid = T.neutralEval(128, 128, 128, P, fg);
    expect(Number.isFinite(mid.wWhite)).toBe(true);
    expect(Number.isFinite(mid.wDark)).toBe(true);
    expect(mid.wWhite).toBeGreaterThan(0);
    expect(mid.wDark).toBeGreaterThan(0);
    expect(mid.wWhite + mid.wDark).toBeGreaterThan(1);

    const img = makeImageData(2, 2, [128, 128, 128, 255]);
    T.transformImageData(img, P, FG);
    for (let p = 0; p < img.data.length; p++) {
      expect(Number.isFinite(img.data[p])).toBe(true);
      expect(img.data[p]).toBeGreaterThanOrEqual(0);
      expect(img.data[p]).toBeLessThanOrEqual(255);
    }
    // Both effects actually landed: alpha reduced (white end) and RGB
    // lightened (dark end), neither collapsed to an endpoint.
    expect(img.data[3]).toBeGreaterThan(0);
    expect(img.data[3]).toBeLessThan(255);
    expect(img.data[0]).toBeGreaterThan(128);
  });
});

describe("band continuity", () => {
  test("white end: zero at whiteLo, one at whiteHi, monotone, no jumps", () => {
    for (const opts of OPTS) {
      const P = T.params(opts);
      const tol = byteTol(P);
      const lo = Math.round(P.whiteLo * 255);
      const hi = Math.round(P.whiteHi * 255);
      expect(evalGray(lo, opts).wWhite).toBeLessThan(tol);
      expect(evalGray(hi, opts).wWhite).toBeGreaterThan(1 - tol);
      let prev = 0;
      for (let v = 0; v <= 255; v++) {
        const w = evalGray(v, opts).wWhite;
        expect(w).toBeGreaterThanOrEqual(prev - 1e-9); // non-decreasing
        expect(w - prev).toBeLessThanOrEqual(Math.max(0.05, tol) + 1e-9); // no jump
        prev = w;
      }
    }
  });

  test("dark end: zero at darkHi, one at darkLo, monotone, no jumps", () => {
    for (const opts of OPTS) {
      const P = T.params(opts);
      const tol = byteTol(P);
      const hi = Math.round(P.darkHi * 255);
      const lo = Math.round(P.darkLo * 255);
      expect(evalGray(hi, opts).wDark).toBeLessThan(tol);
      expect(evalGray(lo, opts).wDark).toBeGreaterThan(1 - tol);
      let prev = 0;
      for (let v = 255; v >= 0; v--) {
        const w = evalGray(v, opts).wDark;
        expect(w).toBeGreaterThanOrEqual(prev - 1e-9); // non-decreasing as L drops
        expect(w - prev).toBeLessThanOrEqual(Math.max(0.05, tol) + 1e-9);
        prev = w;
      }
    }
  });

  test("up to the 0.868 disjointness bound the two weights sum to at most 1", () => {
    // With inner = BAND_OUTER_HI - bandWidth, wherever both ramps are active
    // their weights sum to exactly (1 - 2*inner)/bandWidth = 2 - 0.868/w,
    // which is <= 1 exactly when w <= 0.868. Above that the sum is allowed to
    // exceed 1 by design (see the params tests): the ends are no longer
    // disjoint and a mid-tone receives both effects.
    for (const bandWidth of [0.02, 0.4, 0.5, 0.6, 0.868]) {
      for (let v = 0; v <= 255; v++) {
        const e = evalGray(v, { chromaT: 1.0, bandWidth });
        expect(e.wWhite + e.wDark).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
});

describe("chroma gate (A1)", () => {
  const CASES = [
    // clearly saturated colours: never touched (the old absolute-spread gate
    // misjudged the dark ones, e.g. (40,0,0))
    { rgb: [40, 0, 0], chromatic: true },
    { rgb: [0, 0, 60], chromatic: true },
    { rgb: [90, 40, 0], chromatic: true },
    { rgb: [200, 50, 50], chromatic: true },
    { rgb: [255, 0, 0], chromatic: true },
    { rgb: [180, 150, 120], chromatic: true },
    // neutral inks: gated in (effects differ by lightness)
    { rgb: [23, 23, 21], chromatic: false },
    { rgb: [40, 40, 40], chromatic: false },
    { rgb: [10, 9, 4], chromatic: false },
    { rgb: [35, 31, 32], chromatic: false },
    { rgb: [128, 128, 128], chromatic: false },
    { rgb: [255, 255, 255], chromatic: false },
    { rgb: [240, 213, 212], chromatic: false },
  ];

  for (const opts of GATE_OPTS) {
    test(`decisions at chromaT ${opts.chromaT} bandWidth ${opts.bandWidth}`, () => {
      const P = T.params(opts);
      for (const c of CASES) {
        const e = T.neutralEval(c.rgb[0], c.rgb[1], c.rgb[2], P, fg);
        expect(!!e).toBe(!c.chromatic);
      }
    });
  }

  test("saturated colours are byte-identical after the transform", () => {
    for (const opts of GATE_OPTS) {
      for (const c of CASES.filter((c) => c.chromatic)) {
        expect(run(c.rgb, opts)).toEqual([...c.rgb, 255]);
      }
    }
  });

  test("shipped gate 1.0: exactly-saturated colours stay protected", () => {
    // Relative chroma = spread / max(maxChannel, 32) reaches 1.0 only when
    // spread === max channel (one channel exactly 0). At the shipped gate
    // (1.0) these are the only colours gated out; mid-saturation colours are
    // no longer protected and pass the gate.
    const P = T.params(DEFAULTS);
    for (const rgb of [[255, 0, 0], [40, 0, 0], [0, 0, 60]]) {
      expect(T.neutralEval(rgb[0], rgb[1], rgb[2], P, fg)).toBeNull();
      expect(run(rgb)).toEqual([...rgb, 255]);
    }
    for (const rgb of [[200, 50, 50], [9, 0, 0]]) {
      expect(T.neutralEval(rgb[0], rgb[1], rgb[2], P, fg)).not.toBeNull();
    }
    // A passed pixel still needs a small absolute spread for any weight:
    // (200,50,50) has spread 150, far above NEUTRAL_SPREAD, so the transform
    // leaves it unchanged despite passing the gate; (9,0,0) is flipped.
    expect(run([200, 50, 50])).toEqual([200, 50, 50, 255]);
    expect(run([9, 0, 0])).not.toEqual([9, 0, 0, 255]);
  });

  test("neutral dark ink is flipped toward white", () => {
    for (const c of [[23, 23, 21], [10, 9, 4], [35, 31, 32], [40, 40, 40]]) {
      const out = run(c);
      expect(out[0]).toBeGreaterThan(c[0]); // lightened
      expect(out[0]).toBeGreaterThan(120); // readable on a dark background
      expect(out[3]).toBe(255); // alpha untouched at the dark end
    }
    // The darkest neutral ink lands near white (mirror of the white end).
    expect(run([10, 9, 4])[0]).toBeGreaterThan(200);
    expect(run([23, 23, 21])[0]).toBeGreaterThan(200);
  });

  test("mid-axis neutral is left alone while the bands stay disjoint", () => {
    // At a narrow width the middle of the axis sits between the two ramps.
    // At the shipped 0.6 width it does not — the defaults deliberately
    // process mid-tones (covered in the params tests).
    expect(run([128, 128, 128], { chromaT: 1.0, bandWidth: 0.2 })).toEqual([128, 128, 128, 255]);
  });
});

describe("parameterization split (classification != transform)", () => {
  test("same opts, different classification sensitivities: identical output", () => {
    // Regression guard for the 1.1.0 split: the old transform took the
    // classification sensitivity directly, so changing it changed pixels.
    // Now only chromaT/bandWidth matter; a stray `sens` field (an old call
    // site left over) must not influence the output.
    const low = { ...DEFAULTS, sens: 0.2 };
    const high = { ...DEFAULTS, sens: 0.9 };
    for (const rgb of [[255, 255, 255], [10, 9, 4], [128, 128, 128], [240, 213, 212]]) {
      expect(run(rgb, low)).toEqual(run(rgb, high));
    }
  });

  test("the transform does depend on chromaT and bandWidth", () => {
    // Sanity: both knobs are actually consumed (guards against a no-op split).
    // Mid-ramp gray: the band width changes how much alpha is removed.
    expect(run([217, 217, 217], DEFAULTS)).not.toEqual(
      run([217, 217, 217], { chromaT: 1.0, bandWidth: 0.02 })
    );
    // Dark slightly-chromatic ink: gated out at a low gate, flipped at the
    // shipped 1.0.
    expect(run([40, 34, 31], { chromaT: 0.2, bandWidth: 0.6 })).toEqual([40, 34, 31, 255]);
    expect(run([40, 34, 31], DEFAULTS)).not.toEqual([40, 34, 31, 255]);
  });
});

describe("alpha behaviour", () => {
  test("near-white end scales alpha by (1 - wWhite), RGB untouched", () => {
    // Narrow band on purpose: at the shipped 0.6 width the same mid-ramp grey
    // also receives the dark end's flip (the ends overlap by default, see the
    // params tests), so RGB would move. This test isolates the white effect.
    const P = T.params({ chromaT: 1.0, bandWidth: 0.2 });
    const v = Math.round(((P.whiteLo + P.whiteHi) / 2) * 255); // mid-ramp
    const e = T.neutralEval(v, v, v, P, fg);
    expect(e.wWhite).toBeGreaterThan(0.2);
    expect(e.wWhite).toBeLessThan(0.8);
    expect(e.wDark).toBe(0); // dark ramp is below darkHi = 0.266 at L = 0.835

    const img = makeImageData(1, 1, [v, v, v, 200]);
    T.transformImageData(img, P, FG);
    expect(img.data[3]).toBeCloseTo(200 * (1 - e.wWhite), 0);
    expect(Array.from(img.data.slice(0, 3))).toEqual([v, v, v]);
  });

  test("fully white becomes fully transparent, pure black becomes light", () => {
    expect(run([255, 255, 255])[3]).toBe(0);
    const black = run([0, 0, 0]);
    expect(black[3]).toBe(255);
    expect(black[0]).toBeGreaterThan(230);
  });
});

describe("parameter contract", () => {
  // Regression guard for the v1.1.0 bug: transformImageData re-ran params()
  // on its argument, so when the hook correctly handed it the RESOLVED P the
  // re-parse read P.bandWidth === undefined, every band edge became NaN, and
  // the transform silently returned removedFrac 0 while leaving the bitmap
  // intact. The fix is that transformImageData consumes P directly. These
  // tests pin the positive contract; the hook integration test below pins it
  // at the real production call boundary.
  test("takes resolved params and removes a white field", () => {
    const img = makeImageData(4, 4, [255, 255, 255, 255]);
    const tr = T.transformImageData(img, T.params(DEFAULTS), FG);
    expect(tr.removedFrac).toBeGreaterThan(0.9);
    expect(img.data[3]).toBe(0);
  });

  test("every band edge stays a finite number across the full 0..1 width range", () => {
    for (const bandWidth of WIDTHS) {
      const P = T.params({ chromaT: 1.0, bandWidth });
      for (const k of ["whiteLo", "whiteHi", "darkLo", "darkHi", "chromaT", "neutralSpread"]) {
        expect(Number.isFinite(P[k])).toBe(true);
      }
    }
  });
});

describe("zero-width band (bandWidth 0)", () => {
  test("leaves every pixel byte-identical and removes nothing", () => {
    // whiteLo == whiteHi at width 0; without the neutralEval span guard the
    // ramp would divide by zero and write NaN (or a full-strength weight)
    // instead of doing nothing.
    const P = T.params({ chromaT: 1.0, bandWidth: 0 });
    const img = makeImageData(2, 2, [255, 255, 255, 255]); // pure white stays opaque
    const before = Array.from(img.data);
    const tr = T.transformImageData(img, P, FG);
    expect(Array.from(img.data)).toEqual(before);
    expect(img.data[3]).toBe(255);
    expect(tr.removedFrac).toBe(0);
  });

  test("the dark end is inert too: pure black stays black", () => {
    const P = T.params({ chromaT: 1.0, bandWidth: 0 });
    const img = makeImageData(1, 1, [0, 0, 0, 255]);
    const tr = T.transformImageData(img, P, FG);
    expect(Array.from(img.data)).toEqual([0, 0, 0, 255]);
    expect(tr.removedFrac).toBe(0);
  });

  test("neutralEval reports zero weights rather than NaN", () => {
    const P = T.params({ chromaT: 1.0, bandWidth: 0 });
    const white = T.neutralEval(255, 255, 255, P, fg);
    const black = T.neutralEval(0, 0, 0, P, fg);
    expect(white.wWhite).toBe(0);
    expect(black.wDark).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Hook integration: the real production call boundary.
 * ------------------------------------------------------------------------ */

const WHITE = [255, 255, 255, 255];
const RED = [255, 0, 0, 255];

/** Mostly-white line art with a saturated red patch. */
function lineArtPatch(u, v) {
  return u > 0.4 && u < 0.6 && v > 0.4 && v < 0.6 ? RED : WHITE;
}

/**
 * Minimal fake viewer realm for hook.js.
 *
 * hook.js only ever touches: the viewer window, PDFViewerApplication, the
 * pdf.js prototypes it wraps (page.render -> task._internalRenderTask.
 * initializeGraphics -> gfx.blender.customDrawImage), and canvases created
 * via document.createElement. This harness provides exactly those, with a
 * canvas 2d context that samples an RGBA pattern from the image handed to
 * drawImage, so classify() and transformImageData() see real pixels.
 */
function makeFakeViewer(pattern, width, height) {
  const img = {
    width: width,
    height: height,
    naturalWidth: width,
    naturalHeight: height,
    _pattern: pattern,
  };

  const document = {
    createElement: function () {
      const canvas = { width: 0, height: 0, _pixels: null };
      canvas.getContext = function () {
        return {
          drawImage: function (src, sx, sy, sw, sh) {
            canvas._src = src;
            canvas._sx = sx;
            canvas._sy = sy;
            canvas._sw = sw;
            canvas._sh = sh;
          },
          getImageData: function (x, y, w, h) {
            const src = canvas._src;
            const data = new Uint8ClampedArray(w * h * 4);
            for (let yy = 0; yy < h; yy++) {
              for (let xx = 0; xx < w; xx++) {
                const u = (canvas._sx + ((xx + 0.5) / w) * canvas._sw) / src.width;
                const v = (canvas._sy + ((yy + 0.5) / h) * canvas._sh) / src.height;
                const px = src._pattern(u, v);
                const p = (yy * w + xx) * 4;
                data[p] = px[0];
                data[p + 1] = px[1];
                data[p + 2] = px[2];
                data[p + 3] = px[3];
              }
            }
            return { data: data, width: w, height: h };
          },
          putImageData: function (idata) {
            canvas._pixels = idata;
          },
        };
      };
      return canvas;
    },
  };

  // Record what the wrapped production methods actually do.
  const drawn = []; // args passed to Blender.origDrawImage (noir path)
  const passthrough = []; // args passed to the original customDrawImage

  const pageProto = {
    render: function () {
      return this._task;
    },
  };
  const page = Object.create(pageProto);

  const irtProto = {
    initializeGraphics: function () {
      return null;
    },
  };
  const irt = Object.create(irtProto);

  const gfx = Object.create({});
  const blenderProto = {
    customDrawImage: function (args) {
      passthrough.push(args);
    },
  };
  const blender = Object.create(blenderProto);
  blender.dark = true;
  blender.ctx = { canvas: { width: 200, height: 200 } };
  blender.pageWidth = 200;
  blender.pageHeight = 200;
  blender.getTransformedBoundingBox = function () {
    return { width: width, height: height }; // far smaller than the page
  };
  blender.origDrawImage = function () {
    drawn.push(Array.prototype.slice.call(arguments));
  };
  gfx.blender = blender;
  irt.gfx = gfx;
  page._task = { _internalRenderTask: irt };

  const win = {
    document: document,
    theme: { background: "#2e3440", foreground: FG },
    setTimeout: setTimeout,
    PDFViewerApplication: {
      pdfDocument: {
        getPage: function () {
          return Promise.resolve(page);
        },
      },
      pdfViewer: { _pages: [], update: function () {} },
    },
  };

  return { win, page, irt, blender, img, drawn, passthrough };
}

/** Arm the production chain: install -> attach -> render -> init gfx. */
async function armHook(H, v) {
  H.install(v.win, 0.7, 1.0, 0.6, true);
  await new Promise((resolve) => setTimeout(resolve, 0)); // getPage(1).then
  v.page.render(); // wraps InternalRenderTask.initializeGraphics
  v.irt.initializeGraphics(); // wraps Blender.customDrawImage
}

describe("hook integration (the real production call boundary)", () => {
  test("resKey and transformImageData receive the SAME resolved params object", async () => {
    const H = loadNoir(["classify.js", "transform.js", "cache.js", "hook.js"]);
    const v = makeFakeViewer(lineArtPatch, 64, 64);

    // Record both sides exactly where hook.js reads them at draw time.
    const resKeyCalls = [];
    const transformCalls = [];
    const origResKey = H.cache.resKey;
    const origTransform = H.transform.transformImageData;
    H.cache.resKey = function (fkey, P, fgHex) {
      resKeyCalls.push({ fkey: fkey, P: P, fgHex: fgHex });
      return origResKey.call(this, fkey, P, fgHex);
    };
    H.transform.transformImageData = function (imageData, P, fgHex) {
      transformCalls.push({ imageData: imageData, P: P, fgHex: fgHex });
      return origTransform.call(this, imageData, P, fgHex);
    };

    await armHook(H.hook, v);
    v.blender.customDrawImage([v.img, 0, 0]);

    // The contract that broke: the object the result key is built from must
    // be the very object the transform consumed, and it must be resolved
    // params() output — not the raw {chromaT, bandWidth} opts. If the hook
    // hands the transform raw opts instead, identity passes but the deep
    // equality fails; if the transform re-parses its P internally (the
    // original bug), the effect assertions below fail because every band
    // edge is NaN and the transform is inert.
    expect(resKeyCalls.length).toBe(1);
    expect(transformCalls.length).toBe(1);
    expect(resKeyCalls[0].P).toBe(transformCalls[0].P);
    expect(resKeyCalls[0].P).toEqual(H.transform.params({ chromaT: 1.0, bandWidth: 0.6 }));

    // End-to-end effect through the real wrapper: the transformed canvas was
    // drawn, the white field lost its alpha, the red patch survived the
    // chroma gate byte-identical.
    expect(v.drawn.length).toBe(1);
    expect(v.drawn[0][0]._pixels).toBe(transformCalls[0].imageData);
    expect(v.passthrough.length).toBe(0); // noir hit: original never ran
    const data = transformCalls[0].imageData.data;
    expect(data[3]).toBe(0); // (0,0) is white -> fully transparent
    const red = (32 * 64 + 32) * 4;
    expect(Array.from(data.slice(red, red + 4))).toEqual(RED);

    // setPrefs must reach the same boundary: a new band width means a new P,
    // a new cache key (so a fresh transform) and the same identity contract.
    H.hook.setPrefs(0.7, 0.3, 0.1, true);
    v.blender.customDrawImage([v.img, 0, 0]);
    expect(resKeyCalls.length).toBe(2);
    expect(transformCalls.length).toBe(2);
    expect(resKeyCalls[1].P).not.toBe(resKeyCalls[0].P);
    expect(resKeyCalls[1].P.chromaT).toBe(0.3);
    expect(resKeyCalls[1].fkey).toBe(resKeyCalls[0].fkey); // same source rect
    expect(resKeyCalls[1].P).toBe(transformCalls[1].P);
    expect(resKeyCalls[1].P).toEqual(H.transform.params({ chromaT: 0.3, bandWidth: 0.1 }));
  });
});

describe("determinism (explicitly not idempotence)", () => {
  test("same input twice produces identical output", () => {
    const img = makeImageData(4, 4, [30, 28, 27, 255]);
    img.data[0] = 255;
    img.data[1] = 255;
    img.data[2] = 255;
    img.data[7] = 128; // semi-transparent white corner
    const a = cloneImageData(img);
    const b = cloneImageData(img);
    const P = T.params(DEFAULTS);
    T.transformImageData(a, P, FG);
    T.transformImageData(b, P, FG);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  test("re-running the transform on its own output is NOT idempotent", () => {
    // Pinned deliberately: the white end scales alpha by (1 - wWhite) on
    // every pass, so transforming the output again compounds the fade. The
    // plugin runs exactly one pass per source bitmap; this test exists so the
    // determinism/idempotence distinction cannot quietly regress into an
    // "idempotent" claim the transform does not satisfy.
    const P = T.params(DEFAULTS);
    const v = Math.round(((P.whiteLo + P.whiteHi) / 2) * 255); // mid-ramp
    const once = makeImageData(1, 1, [v, v, v, 200]);
    T.transformImageData(once, P, FG);
    const twice = cloneImageData(once);
    T.transformImageData(twice, P, FG);
    expect(twice.data[3]).toBeLessThan(once.data[3]);
  });

  test("returns the fraction of removed pixels", () => {
    const img = makeImageData(2, 2, [255, 255, 255, 255]);
    const tr = T.transformImageData(img, T.params(DEFAULTS), FG);
    expect(tr.removedFrac).toBeCloseTo(1, 5);
  });
});
