/* Pixel transform tests: mirror symmetry, band continuity, the relative
 * chroma gate (A1), alpha behaviour and idempotence.
 */
import { describe, expect, test } from "bun:test";
import { cloneImageData, loadNoir, makeImageData } from "./helpers.js";

const NS = loadNoir(["transform.js"]);
const T = NS.transform;

const SENS = [0, 0.3, 0.7, 1];
const FG = "#d8dee9";
const fg = T.hexToRgb(FG);

/** neutralEval for a gray value (L = v/255 exactly, spread 0). */
function evalGray(v, s) {
  return T.neutralEval(v, v, v, T.params(s), fg);
}

/** Run the transform on one colour, return the resulting RGBA. */
function run(rgb, s = 0.7) {
  const img = makeImageData(1, 1, [rgb[0], rgb[1], rgb[2], 255]);
  T.transformImageData(img, s, FG);
  return Array.from(img.data);
}

describe("params", () => {
  test("mirror-symmetric around L = 0.5 and ordered", () => {
    for (const s of SENS) {
      const P = T.params(s);
      expect(P.darkHi).toBeCloseTo(1 - P.whiteLo, 12);
      expect(P.darkLo).toBeCloseTo(1 - P.whiteHi, 12);
      expect(P.darkLo).toBeLessThan(P.darkHi);
      expect(P.darkHi).toBeLessThan(0.5);
      expect(P.whiteLo).toBeLessThan(P.whiteHi);
      expect(P.whiteLo).toBeGreaterThan(0.5);
    }
  });

  test("chroma gate grows with sensitivity but stays far below clear colours", () => {
    for (const s of SENS) {
      expect(T.params(s).chromaT).toBeGreaterThan(0.19);
      expect(T.params(s).chromaT).toBeLessThanOrEqual(0.3001);
    }
    expect(T.params(1).chromaT).toBeGreaterThan(T.params(0).chromaT);
  });
});

describe("band continuity", () => {
  test("white end: zero at whiteLo, one at whiteHi, monotone, no jumps", () => {
    for (const s of SENS) {
      const P = T.params(s);
      const lo = Math.round(P.whiteLo * 255);
      const hi = Math.round(P.whiteHi * 255);
      expect(evalGray(lo, s).wWhite).toBeLessThan(0.02);
      expect(evalGray(hi, s).wWhite).toBeGreaterThan(0.98);
      let prev = 0;
      for (let v = 0; v <= 255; v++) {
        const w = evalGray(v, s).wWhite;
        expect(w).toBeGreaterThanOrEqual(prev - 1e-9); // non-decreasing
        expect(w - prev).toBeLessThan(0.05); // no discontinuity
        prev = w;
      }
    }
  });

  test("dark end: zero at darkHi, one at darkLo, monotone, no jumps", () => {
    for (const s of SENS) {
      const P = T.params(s);
      const hi = Math.round(P.darkHi * 255);
      const lo = Math.round(P.darkLo * 255);
      expect(evalGray(hi, s).wDark).toBeLessThan(0.02);
      expect(evalGray(lo, s).wDark).toBeGreaterThan(0.98);
      let prev = 0;
      for (let v = 255; v >= 0; v--) {
        const w = evalGray(v, s).wDark;
        expect(w).toBeGreaterThanOrEqual(prev - 1e-9); // non-decreasing as L drops
        expect(w - prev).toBeLessThan(0.05);
        prev = w;
      }
    }
  });

  test("the two ends never overlap", () => {
    for (const s of SENS) {
      for (let v = 0; v <= 255; v++) {
        const e = evalGray(v, s);
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

  for (const s of SENS) {
    test(`decisions at sensitivity ${s}`, () => {
      const P = T.params(s);
      for (const c of CASES) {
        const e = T.neutralEval(c.rgb[0], c.rgb[1], c.rgb[2], P, fg);
        expect(!!e).toBe(!c.chromatic);
      }
    });
  }

  test("saturated colours are byte-identical after the transform", () => {
    for (const s of SENS) {
      for (const c of CASES.filter((c) => c.chromatic)) {
        expect(run(c.rgb, s)).toEqual([...c.rgb, 255]);
      }
    }
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

  test("mid-axis neutral is left alone", () => {
    expect(run([128, 128, 128])).toEqual([128, 128, 128, 255]);
  });
});

describe("alpha behaviour", () => {
  test("near-white end scales alpha by (1 - wWhite), RGB untouched", () => {
    const P = T.params(0.7);
    const v = Math.round(((P.whiteLo + P.whiteHi) / 2) * 255); // mid-ramp
    const e = T.neutralEval(v, v, v, P, fg);
    expect(e.wWhite).toBeGreaterThan(0.2);
    expect(e.wWhite).toBeLessThan(0.8);

    const img = makeImageData(1, 1, [v, v, v, 200]);
    T.transformImageData(img, 0.7, FG);
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

describe("idempotence", () => {
  test("same input twice produces identical output", () => {
    const img = makeImageData(4, 4, [30, 28, 27, 255]);
    img.data[0] = 255;
    img.data[1] = 255;
    img.data[2] = 255;
    img.data[7] = 128; // semi-transparent white corner
    const a = cloneImageData(img);
    const b = cloneImageData(img);
    T.transformImageData(a, 0.7, FG);
    T.transformImageData(b, 0.7, FG);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  test("returns the fraction of removed pixels", () => {
    const img = makeImageData(2, 2, [255, 255, 255, 255]);
    const tr = T.transformImageData(img, 0.7, FG);
    expect(tr.removedFrac).toBeCloseTo(1, 5);
  });
});
