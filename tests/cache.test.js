/* Cache tests: key dimensions, per-image cap, global byte budget with LRU
 * eviction and clear().
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { loadNoir } from "./helpers.js";

const NS = loadNoir(["cache.js"]);
const C = NS.cache;

const rect = { sX: 10, sY: 20, sW: 30, sH: 40 };

beforeEach(() => {
  C.clear();
});

describe("keys", () => {
  test("featKey covers rect and pixel size", () => {
    expect(C.featKey(rect, 100, 200)).toBe(C.featKey(rect, 100, 200));
    expect(C.featKey(rect, 100, 200)).not.toBe(C.featKey(rect, 101, 200));
    expect(C.featKey(rect, 100, 200)).not.toBe(
      C.featKey({ ...rect, sX: 11 }, 100, 200)
    );
  });

  test("resKey covers sensitivity and foreground, not the background", () => {
    const fkey = C.featKey(rect, 100, 200);
    expect(C.resKey(fkey, 0.7, "#d8dee9")).toBe(C.resKey(fkey, 0.7, "#d8dee9"));
    expect(C.resKey(fkey, 0.7, "#d8dee9")).not.toBe(
      C.resKey(fkey, 0.8, "#d8dee9")
    );
    expect(C.resKey(fkey, 0.7, "#d8dee9")).not.toBe(
      C.resKey(fkey, 0.7, "#ffffff")
    );
  });
});

describe("entries", () => {
  test("features survive a sensitivity change (key has no sensitivity)", () => {
    const obj = {};
    const fkey = C.featKey(rect, 100, 200);
    const feats = { nearWhite: 0.9, lowSat: 1, flat: 0.9, darkNeutral: 0.1 };
    C.putFeatures(obj, fkey, feats);
    expect(C.getFeatures(obj, fkey)).toBe(feats);
    // A different sensitivity only changes the result key, not the features.
    const r1 = C.resKey(fkey, 0.7, "#d8dee9");
    const r2 = C.resKey(fkey, 0.9, "#d8dee9");
    expect(r1).not.toBe(r2);
    C.putResult(obj, r1, { canvas: { width: 4, height: 4 }, removedFrac: 1 });
    expect(C.getResult(obj, r1)).not.toBeNull();
    expect(C.getResult(obj, r2)).toBeNull();
  });

  test("per-image cap keeps the most recently used entries", () => {
    const obj = {};
    for (let i = 0; i < 8; i++) {
      C.putFeatures(obj, "f" + i, { i });
    }
    C.getFeatures(obj, "f0"); // touch the oldest
    C.putFeatures(obj, "f8", { i: 8 }); // overflow: evicts the LRU entry
    expect(C.getFeatures(obj, "f0")).not.toBeNull();
    expect(C.getFeatures(obj, "f1")).toBeNull();
    expect(C.getFeatures(obj, "f8")).not.toBeNull();
    expect(C.stats().entries).toBe(8);
  });

  test("global byte budget evicts the least recently used entries", () => {
    const objects = [];
    for (let i = 0; i < 20; i++) {
      const obj = { i };
      objects.push(obj);
      // 1024 * 1024 * 4 bytes = 4 MiB per entry
      C.putResult(obj, "k", { canvas: { width: 1024, height: 1024 } });
    }
    const st = C.stats();
    expect(st.bytes).toBeLessThanOrEqual(st.maxBytes);
    expect(st.entries).toBeLessThan(20);
    // The newest entry survived; the very first one was evicted.
    expect(C.getResult(objects[19], "k")).not.toBeNull();
    expect(C.getResult(objects[0], "k")).toBeNull();
  });
});

describe("clear", () => {
  test("drops everything and resets the budget", () => {
    const obj = {};
    C.putFeatures(obj, "f", {});
    C.putResult(obj, "r", { canvas: { width: 8, height: 8 } });
    expect(C.stats().entries).toBe(2);
    C.clear();
    expect(C.stats().entries).toBe(0);
    expect(C.stats().bytes).toBe(0);
    expect(C.getFeatures(obj, "f")).toBeNull();
    expect(C.getResult(obj, "r")).toBeNull();
  });
});
