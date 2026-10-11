// These defaults must match the root prefs.js.
var PDFNOIR_DEFAULT_ENABLE = true;
var PDFNOIR_DEFAULT_CLASS_SENSITIVITY = "0.7";
var PDFNOIR_DEFAULT_CHROMA_THRESHOLD = "1";
var PDFNOIR_DEFAULT_BAND_WIDTH = "0.6";

/** Readout formatter: a 0..1 slider value as a whole percentage. */
function formatPercent(value) {
  // At the 0.01 step every representable value has an exact integer
  // percentage; Math.round absorbs float noise (0.29 * 100 = 28.999...).
  return Math.round(value * 100) + "%";
}

var PDFNoir_Preferences = {
  init: function () {
    var root = document.getElementById("zotero-prefpane-pdf-noir");
    if (!root) {
      return;
    }
    if (!root._pdfnoirShowingBound) {
      root.addEventListener("showing", function () {
        PDFNoir_Preferences.init();
      });
      root._pdfnoirShowingBound = true;
    }

    this.bindReadout("pdfnoir-chroma-threshold", "pdfnoir-chroma-threshold-value", formatPercent);
    this.bindReadout("pdfnoir-band-width", "pdfnoir-band-width-value", formatPercent);
    this.bindReadout("pdfnoir-class-sensitivity", "pdfnoir-class-sensitivity-value", formatPercent);
  },

  /**
   * Bind a slider to its numeric readout. `format` maps the slider's current
   * value to the display string. All three sliders use the same convention —
   * a whole percentage — so their column stays uniform and every 0.01 step
   * renders exactly; `format` stays a parameter in case a future slider needs
   * a different rendering.
   */
  bindReadout: function (inputID, readoutID, format) {
    var input = document.getElementById(inputID);
    var readout = document.getElementById(readoutID);
    if (!input || !readout) {
      return;
    }
    var update = function () {
      readout.textContent = format(Number(input.value));
    };
    if (!input._pdfnoirReadoutBound) {
      input.addEventListener("input", update);
      input.addEventListener("change", update);
      input.addEventListener("syncfrompreference", function () {
        // Preference binding may assign the value after dispatching this event.
        window.setTimeout(update, 0);
      });
      input._pdfnoirReadoutBound = true;
    }
    update();
    // The root load event can precede Zotero's initial preference binding.
    window.setTimeout(update, 0);
  },

  reset: function () {
    Zotero.Prefs.set("extensions.pdf-noir.enable", PDFNOIR_DEFAULT_ENABLE, true);
    Zotero.Prefs.set("extensions.pdf-noir.classSensitivity", PDFNOIR_DEFAULT_CLASS_SENSITIVITY, true);
    Zotero.Prefs.set("extensions.pdf-noir.chromaThreshold", PDFNOIR_DEFAULT_CHROMA_THRESHOLD, true);
    Zotero.Prefs.set("extensions.pdf-noir.bandWidth", PDFNOIR_DEFAULT_BAND_WIDTH, true);
  }
};

window.PDFNoir_Preferences = PDFNoir_Preferences;
