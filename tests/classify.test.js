/* Classification tests: opaque-only denominators, flat pairs across
 * transparent pixels (A3) and the decision thresholds.
 */
import { describe, expect, test } from "bun:test";
import { loadNoir, makeImageData, setPixel } from "./helpers.js";

const NS = loadNoir(["classify.js"]);
const C = NS.classify;

const WHITE = [255, 255, 255, 255];
const CLEAR = [255, 255, 255, 0]; // transparent white (typical RGBA margin)

describe("features", () => {
  test("transparent pixels are excluded from denominators", () => {
    const img = makeImageData(8, 4, CLEAR);
    for (let y = 0; y < 4; y++) {
      for (let x = 4; x < 8; x++) {
        setPixel(img, x, y, WHITE);
      }
    }
    const f = C.featuresFromImageData(img);
    expect(f.valid).toBe(16);
    // 16 opaque white pixels: nearWhite/lowSat 1.0, not 0.5 as with w*h.
    expect(f.nearWhite).toBeCloseTo(1, 5);
    expect(f.lowSat).toBeCloseTo(1, 5);
    expect(f.darkNeutral).toBeCloseTo(0, 5);
    expect(f.flat).toBeCloseTo(1, 5);
  });

  test("flat pairs require both pixels to be opaque", () => {
    // Two identical white pixels, but the second is transparent: the old code
    // counted the pair as flat and inflated the ratio.
    const img = makeImageData(2, 1, WHITE);
    setPixel(img, 1, 0, CLEAR);
    const f = C.featuresFromImageData(img);
    expect(f.valid).toBe(1);
    expect(f.flat).toBe(0); // no opaque pair exists
  });

  test("vertical flat pairs also skip transparent neighbours", () => {
    const img = makeImageData(1, 3, WHITE);
    setPixel(img, 0, 1, CLEAR);
    const f = C.featuresFromImageData(img);
    expect(f.valid).toBe(2);
    expect(f.flat).toBe(0);
  });

  test("all-transparent image yields zeroed features", () => {
    const img = makeImageData(4, 4, CLEAR);
    const f = C.featuresFromImageData(img);
    expect(f.valid).toBe(0);
    expect(f.nearWhite).toBe(0);
    expect(f.lowSat).toBe(0);
    expect(f.flat).toBe(0);
    expect(f.darkNeutral).toBe(0);
  });

  test("line art on white is classified as a hit, photo-like content is not", () => {
    // Synthetic line art: white background with a few dark neutral pixels.
    const art = makeImageData(16, 16, WHITE);
    for (let i = 0; i < 16; i++) {
      setPixel(art, i, 8, [23, 23, 21, 255]);
    }
    const artFeatures = C.featuresFromImageData(art);
    expect(C.decide(artFeatures, 0.7).hit).toBe(true);

    // Synthetic photo: noisy mid-tone colours, little white, low flatness.
    const photo = makeImageData(16, 16, [120, 90, 60, 255]);
    let seed = 7;
    for (let i = 0; i < 16 * 16; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      photo.data[i * 4] = 60 + (seed % 120);
      photo.data[i * 4 + 1] = 40 + ((seed >> 8) % 100);
      photo.data[i * 4 + 2] = 30 + ((seed >> 16) % 80);
    }
    const photoFeatures = C.featuresFromImageData(photo);
    expect(C.decide(photoFeatures, 0.7).hit).toBe(false);
  });
});

describe("thresholds", () => {
  test("lower with sensitivity (more aggressive at higher s)", () => {
    const lo = C.thresholds(0.1);
    const hi = C.thresholds(1);
    expect(hi.nearWhite).toBeLessThan(lo.nearWhite);
    expect(hi.lowSat).toBeLessThan(lo.lowSat);
    expect(hi.flat).toBeLessThan(lo.flat);
  });
});
