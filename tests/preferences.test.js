/* Settings-pane contract tests: slider ranges/steps and defaults must match
 * the root prefs.js (the bootstrap fallbacks and the pane's Restore Defaults
 * constants too), the readouts must render the stored value as a whole
 * percentage, and both locale files must carry the same message ids. The bug
 * class this guards: a default off its slider's step grid gets normalized by
 * the browser to the nearest step, after which the readout shows a value the
 * stored pref does not contain.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PREFS_SOURCE = readFileSync(join(ROOT, "prefs.js"), "utf8");
const XHTML_SOURCE = readFileSync(join(ROOT, "content", "preferences.xhtml"), "utf8");
const PREFS_JS_SOURCE = readFileSync(join(ROOT, "content", "preferences.js"), "utf8");
const BOOTSTRAP_SOURCE = readFileSync(join(ROOT, "bootstrap.js"), "utf8");
const FTL_EN = readFileSync(join(ROOT, "locale", "en-US", "pdf-noir-preferences.ftl"), "utf8");
const FTL_ZH = readFileSync(join(ROOT, "locale", "zh-CN", "pdf-noir-preferences.ftl"), "utf8");

/** The string default declared for `key` in the root prefs.js. */
function prefDefault(key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = PREFS_SOURCE.match(new RegExp(`pref\\("${escaped}", "([^"]*)"\\)`));
  return m ? m[1] : null;
}

/** String constant declared in content/preferences.js (Restore Defaults). */
function paneConstant(name) {
  const m = PREFS_JS_SOURCE.match(new RegExp(`var ${name} = "([^"]*)"`));
  return m ? m[1] : null;
}

/**
 * getPrefs() from bootstrap.js with every pref read failing, so the built-in
 * fallbacks surface. The chrome script only declares vars and functions at
 * load time, so it evaluates in a sandbox with a stub Zotero.
 */
function bootstrapFallbacks() {
  const Zotero = {
    Prefs: {
      get: () => {
        throw new Error("no pref storage");
      },
    },
    debug: () => {},
  };
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "Zotero",
    "Services",
    BOOTSTRAP_SOURCE + "\nreturn { getPrefs: getPrefs };"
  );
  return factory(Zotero, {}).getPrefs();
}

/** Ordered message ids of an FTL file (ids start a line; attributes indent). */
function ftlMessageIds(source) {
  const ids = [];
  for (const line of source.split(/\r?\n/)) {
    const m = line.match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)?)\s*=/);
    if (m) {
      ids.push(m[1]);
    }
  }
  return ids;
}

/** min/max/step of the range input with the given id in preferences.xhtml. */
function slider(sliderId) {
  const block = XHTML_SOURCE.match(
    new RegExp(`<html:input id="${sliderId}"[\\s\\S]*?/>`)
  );
  if (!block) {
    throw new Error("slider not found in preferences.xhtml: " + sliderId);
  }
  const attr = (name) => {
    const m = block[0].match(new RegExp(`${name}="([^"]+)"`));
    return m ? Number(m[1]) : NaN;
  };
  return { min: attr("min"), max: attr("max"), step: attr("step") };
}

/** Fixed width (in em) of the readout span paired with a slider id. */
function readoutWidth(sliderId) {
  const block = XHTML_SOURCE.match(
    new RegExp(`<html:span id="${sliderId}-value"[\\s\\S]*?/>`)
  );
  if (!block) {
    throw new Error("readout not found in preferences.xhtml: " + sliderId + "-value");
  }
  const m = block[0].match(/width:\s*([\d.]+)em/);
  return m ? Number(m[1]) : NaN;
}

// pref key, slider id, min, max, step, shipped default. All three sliders span
// 0..1 at 0.01 steps, and every shipped default sits exactly on that grid.
const SLIDERS = [
  ["extensions.pdf-noir.chromaThreshold", "pdfnoir-chroma-threshold", 0, 1, 0.01, "1"],
  ["extensions.pdf-noir.bandWidth", "pdfnoir-band-width", 0, 1, 0.01, "0.6"],
  ["extensions.pdf-noir.classSensitivity", "pdfnoir-class-sensitivity", 0, 1, 0.01, "0.7"],
];

describe("slider grids", () => {
  test("ranges and steps match the shipped contract", () => {
    for (const [, sliderId, min, max, step] of SLIDERS) {
      const s = slider(sliderId);
      expect(s.min).toBe(min);
      expect(s.max).toBe(max);
      expect(s.step).toBe(step);
    }
  });

  test("every shipped default lands exactly on its slider step grid", () => {
    for (const [prefKey, sliderId, , , , def] of SLIDERS) {
      const s = slider(sliderId);
      expect(prefDefault(prefKey)).toBe(def);
      const value = Number(def);
      expect(value).toBeGreaterThanOrEqual(s.min);
      expect(value).toBeLessThanOrEqual(s.max);
      const steps = (value - s.min) / s.step;
      // A default that is off the grid is normalized by the browser (the
      // slider snaps it to the nearest step), after which the UI no longer
      // shows the stored pref. The shipped defaults are on-grid, so this
      // holds for all three.
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
    }
  });

  test("readout columns have room for the widest percentage", () => {
    // All three readouts render percentages now, so the longest possible
    // string is "100%" (4 glyphs). The fixed column used to be 4em, sized for
    // strings like "0.166"; 4.5em leaves margin for four glyphs plus the
    // percent sign at either end of the range.
    for (const [, sliderId] of SLIDERS) {
      const width = readoutWidth(sliderId);
      expect(Number.isFinite(width)).toBe(true);
      expect(width).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("shipped defaults agree across files", () => {
  test("prefs.js, the pane script and the bootstrap fallbacks match", () => {
    // prefs.js is the shipping source. The pane's Restore Defaults constants
    // and bootstrap.js's getPrefs fallbacks must not drift from it (the
    // existing reset() test pins the pane's behaviour; this pins the values).
    expect(prefDefault("extensions.pdf-noir.chromaThreshold")).toBe("1");
    expect(prefDefault("extensions.pdf-noir.bandWidth")).toBe("0.6");
    expect(prefDefault("extensions.pdf-noir.classSensitivity")).toBe("0.7");
    expect(paneConstant("PDFNOIR_DEFAULT_CHROMA_THRESHOLD")).toBe(
      prefDefault("extensions.pdf-noir.chromaThreshold")
    );
    expect(paneConstant("PDFNOIR_DEFAULT_BAND_WIDTH")).toBe(
      prefDefault("extensions.pdf-noir.bandWidth")
    );
    expect(paneConstant("PDFNOIR_DEFAULT_CLASS_SENSITIVITY")).toBe(
      prefDefault("extensions.pdf-noir.classSensitivity")
    );
    const fb = bootstrapFallbacks();
    expect(String(fb.chromaT)).toBe(prefDefault("extensions.pdf-noir.chromaThreshold"));
    expect(String(fb.bandWidth)).toBe(prefDefault("extensions.pdf-noir.bandWidth"));
    expect(String(fb.classSensitivity)).toBe(prefDefault("extensions.pdf-noir.classSensitivity"));
    expect(fb.enable).toBe(true);
    expect(fb.devAutoOpenItem).toBe(0);
  });
});

describe("localization files", () => {
  test("both locales expose the same messages in the same order", () => {
    const en = ftlMessageIds(FTL_EN);
    expect(en.length).toBeGreaterThan(0);
    expect(ftlMessageIds(FTL_ZH)).toEqual(en);
  });

  test("band label is renamed and the obsolete chroma advice is gone", () => {
    expect(FTL_EN).toContain(".value = Lightness band width");
    expect(FTL_ZH).toContain(".value = 亮度带宽");
    expect(FTL_EN).not.toContain("stay at the low end");
    expect(FTL_ZH).not.toContain("集中在低端");
    // The non-obvious consequence stays: raising the gate weakens colour
    // protection. No help text still describes a numeric range.
    expect(FTL_EN).toContain("Higher values weaken colour protection");
    expect(FTL_ZH).toContain("彩色保护越弱");
    expect(FTL_EN + FTL_ZH).not.toMatch(/Range:|范围/);
  });
});

/* ------------------------------------------------------------------------ *
 * Pane script: loaded the way the real pane loads it — `window`,
 * `document` and `Zotero` are its only ambient dependencies.
 * ------------------------------------------------------------------------ */

function loadPane(onSet) {
  const elements = new Map();
  const makeEl = () => ({
    value: null,
    textContent: "",
    _listeners: {},
    addEventListener: function (type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    dispatch: function (type) {
      (this._listeners[type] || []).forEach((fn) => fn());
    },
  });
  const ids = [
    "zotero-prefpane-pdf-noir",
    "pdfnoir-chroma-threshold",
    "pdfnoir-chroma-threshold-value",
    "pdfnoir-band-width",
    "pdfnoir-band-width-value",
    "pdfnoir-class-sensitivity",
    "pdfnoir-class-sensitivity-value",
  ];
  for (const id of ids) {
    elements.set(id, makeEl());
  }
  const document = { getElementById: (id) => elements.get(id) || null };
  const Zotero = {
    Prefs: {
      set: (key, value) => {
        if (onSet) {
          onSet(key, value);
        }
      },
    },
  };
  const window = { setTimeout: (fn) => fn() };
  // eslint-disable-next-line no-new-func
  new Function("window", "document", "Zotero", PREFS_JS_SOURCE)(window, document, Zotero);
  return { pane: window.PDFNoir_Preferences, elements };
}

describe("readouts", () => {
  test("render every slider value as a whole percentage", () => {
    const { pane, elements } = loadPane();
    elements.get("pdfnoir-band-width").value = "0.6";
    elements.get("pdfnoir-chroma-threshold").value = "1";
    elements.get("pdfnoir-class-sensitivity").value = "0.7";
    pane.init();
    expect(elements.get("pdfnoir-band-width-value").textContent).toBe("60%");
    expect(elements.get("pdfnoir-chroma-threshold-value").textContent).toBe("100%");
    expect(elements.get("pdfnoir-class-sensitivity-value").textContent).toBe("70%");
  });

  test("cover both ends of every slider without clipping the string", () => {
    const { pane, elements } = loadPane();
    for (const [, sliderId, min, max] of SLIDERS) {
      const input = elements.get(sliderId);
      input.value = String(min);
      pane.init();
      const low = elements.get(sliderId + "-value").textContent;
      input.value = String(max);
      pane.init();
      const high = elements.get(sliderId + "-value").textContent;
      expect(low).toBe("0%");
      expect(high).toBe("100%");
      // The fixed-width readout column must fit the longest rendered string;
      // 4 characters is the worst case across all three sliders.
      expect(Math.max(low.length, high.length)).toBeLessThanOrEqual(4);
    }
  });

  test("track a dragged slider as a percentage", () => {
    const { pane, elements } = loadPane();
    pane.init();
    const band = elements.get("pdfnoir-band-width");
    band.value = "0.35";
    band.dispatch("input");
    expect(elements.get("pdfnoir-band-width-value").textContent).toBe("35%");
  });

  test("reset() writes exactly the shipped pref defaults", () => {
    const writes = {};
    const { pane } = loadPane((key, value) => {
      writes[key] = value;
    });
    pane.reset();
    expect(writes["extensions.pdf-noir.enable"]).toBe(true);
    expect(writes["extensions.pdf-noir.classSensitivity"]).toBe(
      prefDefault("extensions.pdf-noir.classSensitivity")
    );
    expect(writes["extensions.pdf-noir.chromaThreshold"]).toBe(
      prefDefault("extensions.pdf-noir.chromaThreshold")
    );
    expect(writes["extensions.pdf-noir.bandWidth"]).toBe(
      prefDefault("extensions.pdf-noir.bandWidth")
    );
  });
});
