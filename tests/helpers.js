/* Test helpers: load the noir browser scripts into a plain sandbox object.
 *
 * The noir files are IIFEs that attach their API to `window.PDFNoir` in the
 * viewer realm. Here `window` is a plain object, so the modules stay isolated
 * per load and tests can exercise them without a browser.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NOIR_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "content",
  "scripts",
  "noir"
);

/**
 * @param {string[]} files noir script file names (default: pure logic modules)
 * @returns {object} the sandbox's PDFNoir namespace
 */
export function loadNoir(files = ["classify.js", "transform.js", "cache.js"]) {
  const sandbox = {};
  const source = files
    .map((f) => readFileSync(join(NOIR_DIR, f), "utf8"))
    .join("\n;\n");
  // The scripts pick `window` over globalThis when it exists; the function
  // parameter shadows the real global inside the evaluated source.
  // eslint-disable-next-line no-new-func
  new Function("window", source)(sandbox);
  return sandbox.PDFNoir;
}

/**
 * ImageData-like object filled with one RGBA colour.
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
export function makeImageData(width, height, rgba = [0, 0, 0, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { data, width, height };
}

/** Set one pixel of an ImageData-like object. */
export function setPixel(img, x, y, rgba) {
  const p = (y * img.width + x) * 4;
  img.data[p] = rgba[0];
  img.data[p + 1] = rgba[1];
  img.data[p + 2] = rgba[2];
  img.data[p + 3] = rgba[3];
}

/** Copy of an ImageData-like object (deep, typed array included). */
export function cloneImageData(img) {
  return {
    data: new Uint8ClampedArray(img.data),
    width: img.width,
    height: img.height,
  };
}
