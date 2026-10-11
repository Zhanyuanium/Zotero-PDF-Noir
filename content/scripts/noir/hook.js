/* Zotero PDF Noir — Blender hook (v1.1.0).
 *
 * Runs inside the pdf.js viewer realm. Intercepts the fork's image path:
 *
 *   PDFPageProxy.prototype.render
 *     -> InternalRenderTask.prototype.initializeGraphics   (grab gfx)
 *       -> CanvasGraphics.prototype.paintInlineImageXObject[Group]
 *            (record the upstream imgData/bitmap identity for caching)
 *       -> Blender.prototype.customDrawImage               (the real hook)
 *
 * customDrawImage receives the original drawImage argument list from
 * CanvasGraphics.drawImageAtIntegerCoords (3/5/9-arg forms). The wrapper
 * classifies the source rect; for white-background line art it runs the
 * noir transform and draws the transformed canvas through Blender's own
 * origDrawImage with the same argument form. Everything else is passed to
 * the original method untouched, so Blender's behavior is preserved.
 *
 * Safety:
 *  - every pdf.js internal touched here is checked for existence first, so
 *    a Zotero update that renames things degrades to "do not intervene";
 *  - the original customDrawImage is called exactly once per draw, at the
 *    end of the wrapper; the try/catch only guards the noir preparation;
 *  - ctx.skipBlender, light themes (!blender.dark) and force-inversion
 *    themes are passed through untouched;
 *  - async callbacks (attach retry / getPage) are bound to an install
 *    generation and do nothing after uninstall.
 *
 * Logging: lines are pushed to win.__PDFNoirLogs; bootstrap.js drains them
 * into Zotero.debug (the viewer realm has no Zotero object).
 *
 * Prefs (passed as primitives by bootstrap.js, which also clamps them):
 *  - classSens: classification aggressiveness only (classify.decide);
 *  - chromaT:   relative chroma gate of the pixel transform (0..1);
 *  - bandWidth: width of the mirror-symmetric neutral band (0 disables both
 *    ends; 1.0 is the maximum, where the two ramps overlap and a mid-tone
 *    receives both effects);
 *  - enabled:   master switch.
 * The transform params are built once per draw (not per pixel) from the last
 * two, so the cached result key always matches the transform that ran.
 */
(function () {
  "use strict";

  var g = typeof window !== "undefined" ? window : globalThis;
  var NS = (g.PDFNoir = g.PDFNoir || {});

  var BUILD = "1.1.0";
  var MAX_PIXELS = 8e6;
  var LOG_CAP = 800;
  var ATTACH_TRIES = 120;

  // Upstream image identity for the drawImage call currently on the stack,
  // set by the CanvasGraphics paint* wrappers below.
  var drawSource = null;
  // Active transfer map (a CSS filter string) for the draw currently on the
  // stack, or null. Same imgData with different transfer maps produces
  // different pixels, so the caches must not be used while it is set.
  var drawTransfer = null;

  var state = {
    installed: false,
    win: null,
    sens: 0.7,
    chromaT: 1.0,
    bandWidth: 0.6,
    enabled: true,
    draws: 0,
    generation: 0,
    originals: [],
    attachTimer: null,
    transferLogged: false,
  };

  function log(win, msg) {
    var line = "[PDF-Noir] " + msg;
    // Array is the single source of truth; bootstrap.js drains it into
    // Zotero.debug. Do not attempt Zotero.debug here: the viewer realm may
    // expose a Zotero object whose debug call throws, which would lose the
    // line entirely.
    try {
      var w = win || state.win;
      var arr = w.__PDFNoirLogs;
      if (!arr) {
        arr = w.__PDFNoirLogs = [];
      }
      arr.push(line);
      while (arr.length > LOG_CAP) {
        arr.shift();
      }
    } catch (e) {
      /* logging must never break rendering */
    }
  }

  function themeDesc(win) {
    try {
      var t = win.theme;
      if (!t) {
        return "none";
      }
      return "bg=" + t.background + " fg=" + t.foreground + " invert=" + !!t.invertImages;
    } catch (e) {
      return "?";
    }
  }

  function num(v, d) {
    var n = typeof v === "number" ? v : parseFloat(v);
    return isFinite(n) ? n : d;
  }

  function fmt(v) {
    return v.toFixed(3);
  }

  function isObj(v) {
    return !!v && (typeof v === "object" || typeof v === "function");
  }

  // ---- installation / prototype wrapping -------------------------------

  function install(win, classSens, chromaT, bandWidth, enabled) {
    win = win || g;
    if (state.installed && state.win === win) {
      setPrefs(classSens, chromaT, bandWidth, enabled);
      return true;
    }
    if (state.installed) {
      uninstall();
    }
    state.generation++;
    state.installed = true;
    state.win = win;
    state.sens = num(classSens, 0.7);
    state.chromaT = num(chromaT, 1.0);
    state.bandWidth = num(bandWidth, 0.6);
    state.enabled = enabled !== false;
    state.draws = 0;
    log(
      win,
      "hook install build=" + BUILD +
        " sens=" + state.sens +
        " chromaT=" + state.chromaT +
        " bandWidth=" + state.bandWidth +
        " theme " + themeDesc(win)
    );
    attach(win, 0);
    return true;
  }

  function setPrefs(classSens, chromaT, bandWidth, enabled) {
    state.sens = num(classSens, state.sens);
    state.chromaT = num(chromaT, state.chromaT);
    state.bandWidth = num(bandWidth, state.bandWidth);
    state.enabled = enabled !== false;
  }

  function attach(win, tries) {
    var gen = state.generation;
    if (!state.installed || state.win !== win) {
      return;
    }
    var app = win.PDFViewerApplication;
    if (!app || !app.pdfDocument || !app.pdfViewer) {
      if (tries < ATTACH_TRIES) {
        state.attachTimer = win.setTimeout(function () {
          if (state.generation !== gen) {
            return;
          }
          attach(win, tries + 1);
        }, 250);
      } else {
        log(win, "attach gave up waiting for PDFViewerApplication");
      }
      return;
    }
    var doc = app.pdfDocument;
    if (typeof doc.getPage !== "function") {
      log(win, "pdfDocument.getPage is not a function; not hooking");
      return;
    }
    doc
      .getPage(1)
      .then(function (page) {
        if (state.generation !== gen || !state.installed) {
          return;
        }
        var proto = Object.getPrototypeOf(page);
        wrapRender(win, proto);
        repaint(win, app);
        log(win, "attached; Blender hook armed");
      })
      .catch(function (err) {
        if (state.generation !== gen) {
          return;
        }
        log(win, "attach getPage failed: " + (err && err.message ? err.message : err));
      });
  }

  /**
   * Force a repaint so currently visible pages get the noir path now: the
   * page restored on startup may have rendered before the hook was armed,
   * and update() alone does not re-render an unchanged page. Takes the app
   * explicitly so callers that already hold it (attach, the prefs repaint)
   * do not depend on state.win.
   */
  function repaint(win, app) {
    try {
      var pages = app.pdfViewer._pages || [];
      for (var i = 0; i < pages.length; i++) {
        var pv = pages[i];
        try {
          if (pv && typeof pv.reset === "function") {
            pv.reset();
          }
        } catch (eReset) {}
      }
    } catch (ePages) {}
    try {
      app.pdfViewer.update();
    } catch (e) {}
  }

  function wrapRender(win, proto) {
    if (proto.__pdfNoirRender) {
      return;
    }
    var orig = proto.render;
    if (typeof orig !== "function") {
      log(win, "PDFPageProxy.render is not a function; not hooking");
      return;
    }
    proto.render = function () {
      var task = orig.apply(this, arguments);
      try {
        observeTask(win, task);
      } catch (e) {}
      return task;
    };
    try {
      Object.defineProperty(proto, "__pdfNoirRender", { value: true, configurable: true });
    } catch (e) {}
    state.originals.push({ obj: proto, prop: "render", orig: orig, marker: "__pdfNoirRender" });
  }

  function observeTask(win, task) {
    var irt = task && task._internalRenderTask;
    if (!irt) {
      return;
    }
    var proto = Object.getPrototypeOf(irt);
    if (proto.__pdfNoirInit) {
      return;
    }
    var orig = proto.initializeGraphics;
    if (typeof orig !== "function") {
      return;
    }
    proto.initializeGraphics = function () {
      var ret = orig.apply(this, arguments);
      try {
        afterInitialize(win, this);
      } catch (e) {}
      return ret;
    };
    try {
      Object.defineProperty(proto, "__pdfNoirInit", { value: true, configurable: true });
    } catch (e) {}
    state.originals.push({
      obj: proto,
      prop: "initializeGraphics",
      orig: orig,
      marker: "__pdfNoirInit",
    });
  }

  function afterInitialize(win, irt) {
    var gfx = irt && irt.gfx;
    if (!gfx) {
      return;
    }
    var cgProto = Object.getPrototypeOf(gfx);
    if (cgProto) {
      wrapCanvasGraphics(win, cgProto);
    }
    var blender = gfx.blender;
    if (!blender) {
      return; // light mode or skipBlender
    }
    var proto = Object.getPrototypeOf(blender);
    if (!proto) {
      return;
    }
    if (proto.__pdfNoirCustom) {
      return;
    }
    wrapBlender(win, proto);
  }

  // Record the upstream imgData identity for the drawImage calls made
  // synchronously inside CanvasGraphics.paint* methods. This keeps cache
  // keys stable across renders even though _scaleImage hands Blender a
  // freshly created temporary canvas every time.
  function wrapCanvasGraphics(win, proto) {
    if (proto.__pdfNoirPaint) {
      return;
    }
    var names = ["paintInlineImageXObject", "paintInlineImageXObjectGroup"];
    var wrapped = 0;
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var orig = proto[name];
      if (typeof orig !== "function") {
        continue;
      }
      proto[name] = makeSourceCapture(orig);
      state.originals.push({ obj: proto, prop: name, orig: orig, marker: null });
      wrapped++;
    }
    if (wrapped) {
      try {
        Object.defineProperty(proto, "__pdfNoirPaint", { value: true, configurable: true });
      } catch (e) {}
      // Marker-only entry so uninstall() deletes it too.
      state.originals.push({ obj: proto, prop: null, orig: null, marker: "__pdfNoirPaint" });
      log(win, "source capture armed (CanvasGraphics)");
    }
  }

  function makeSourceCapture(orig) {
    return function () {
      var prevSource = drawSource;
      var prevTransfer = drawTransfer;
      // both paintInlineImageXObject(opIdx, imgData) and
      // paintInlineImageXObjectGroup(opIdx, imgData, map) carry imgData 2nd
      drawSource = isObj(arguments[1]) ? arguments[1] : null;
      // CanvasGraphics.current.transferMaps is a string, "none" when unset
      // (pdf-shipped.mjs:11202); when set, applyTransferMapsToBitmap/Canvas
      // filter the pixels before they are painted.
      var cur = this && this.current;
      drawTransfer =
        cur && typeof cur.transferMaps === "string" && cur.transferMaps !== "none"
          ? cur.transferMaps
          : null;
      try {
        return orig.apply(this, arguments);
      } finally {
        drawSource = prevSource;
        drawTransfer = prevTransfer;
      }
    };
  }

  function wrapBlender(win, proto) {
    var orig = proto.customDrawImage;
    if (typeof orig !== "function") {
      log(win, "customDrawImage is not a function; not hooking");
      return;
    }
    proto.customDrawImage = function (args) {
      var plan = null;
      try {
        plan = planDraw(win, this, args);
      } catch (err) {
        log(win, "ERROR in noir path, falling back: " + (err && err.stack ? err.stack : err));
        plan = null;
      }
      if (plan && plan.canvas && typeof this.origDrawImage === "function") {
        try {
          drawCanvas(this, plan.canvas, args, plan.rect);
          return;
        } catch (err2) {
          log(
            win,
            "ERROR drawing noir canvas, falling back: " +
              (err2 && err2.message ? err2.message : err2)
          );
        }
      }
      // Passthrough / failure fallback: the original method runs at most
      // once, here. A successful noir hit draws the transformed canvas above
      // and never reaches this line.
      return orig.call(this, args);
    };
    try {
      Object.defineProperty(proto, "__pdfNoirCustom", { value: true, configurable: true });
    } catch (e) {}
    state.originals.push({
      obj: proto,
      prop: "customDrawImage",
      orig: orig,
      marker: "__pdfNoirCustom",
    });
  }

  // ---- draw planning -----------------------------------------------------

  function resolveRect(args, img) {
    var sW;
    var sH;
    var r = {};
    if (args.length === 3) {
      r.dX = args[1];
      r.dY = args[2];
      sW = img.naturalWidth || img.width;
      sH = img.naturalHeight || img.height;
      r.sX = 0;
      r.sY = 0;
      r.dW = sW;
      r.dH = sH;
    } else if (args.length === 5) {
      r.dX = args[1];
      r.dY = args[2];
      r.dW = args[3];
      r.dH = args[4];
      sW = img.naturalWidth || img.width;
      sH = img.naturalHeight || img.height;
      r.sX = 0;
      r.sY = 0;
    } else if (args.length === 9) {
      r.sX = args[1];
      r.sY = args[2];
      sW = args[3];
      sH = args[4];
      r.dX = args[5];
      r.dY = args[6];
      r.dW = args[7];
      r.dH = args[8];
    } else {
      return null;
    }
    r.sW = sW;
    r.sH = sH;
    if (!(sW > 0) || !(sH > 0) || !isFinite(sW) || !isFinite(sH)) {
      return null;
    }
    return r;
  }

  function drawCanvas(blender, canvas, args, rect) {
    if (args.length === 3) {
      blender.origDrawImage(canvas, rect.dX, rect.dY);
    } else if (args.length === 5) {
      blender.origDrawImage(canvas, rect.dX, rect.dY, rect.dW, rect.dH);
    } else {
      blender.origDrawImage(
        canvas,
        0,
        0,
        rect.sW,
        rect.sH,
        rect.dX,
        rect.dY,
        rect.dW,
        rect.dH
      );
    }
  }

  function sourcePixels(src, img) {
    var w = 0;
    var h = 0;
    try {
      if (src) {
        w = src.width || (src.bitmap && src.bitmap.width) || 0;
        h = src.height || (src.bitmap && src.bitmap.height) || 0;
      }
    } catch (e) {}
    if (!w || !h) {
      try {
        w = img.naturalWidth || img.width || 0;
        h = img.naturalHeight || img.height || 0;
      } catch (e) {}
    }
    return { w: w, h: h };
  }

  function featsDesc(f) {
    return (
      "feats{white=" + fmt(f.nearWhite) +
      " lowSat=" + fmt(f.lowSat) +
      " flat=" + fmt(f.flat) +
      " dark=" + fmt(f.darkNeutral) + "}"
    );
  }

  function thrDesc(t) {
    return (
      "thr{white=" + fmt(t.nearWhite) +
      " lowSat=" + fmt(t.lowSat) +
      " flat=" + fmt(t.flat) + "}"
    );
  }

  function passthrough(win, why) {
    state.draws++;
    log(win, "#" + state.draws + " pass skip=" + why);
    return null;
  }

  /**
   * Decide what to draw. Returns { canvas, rect } for a noir hit, or null
   * to let the caller run the untouched original. Never draws anything.
   */
  function planDraw(win, blender, args) {
    // Mirror the first side effects of Blender.customDrawImage.
    blender.hasBackgrounds = true;
    try {
      delete blender.cachedImage;
    } catch (e) {}

    if (!state.enabled) {
      return null;
    }
    var img = args && args[0];
    if (!img) {
      return null;
    }
    var ctx = blender.ctx;
    if (ctx && ctx.skipBlender) {
      return null;
    }
    if (!blender.dark) {
      // Light themes: Blender still runs, but the noir transform is only
      // meaningful on dark backgrounds.
      return passthrough(win, "lightTheme");
    }
    if (blender.forceInversion) {
      return passthrough(win, "forceInversion");
    }
    var rect = resolveRect(args, img);
    if (!rect) {
      return null;
    }
    if (rect.sW * rect.sH > MAX_PIXELS) {
      return passthrough(win, "tooLarge(" + rect.sW + "x" + rect.sH + ")");
    }
    if (typeof blender.getTransformedBoundingBox !== "function") {
      return null;
    }
    var pageWidth = blender.pageWidth || (ctx && ctx.canvas.width) || 0;
    var pageHeight = blender.pageHeight || (ctx && ctx.canvas.height) || 0;
    var box = blender.getTransformedBoundingBox(ctx, rect.dX, rect.dY, rect.dW, rect.dH);
    var entirePage =
      Math.abs(pageWidth * pageHeight - box.width * box.height) < pageWidth * pageHeight * 0.25;
    if (entirePage) {
      return passthrough(win, "entirePage");
    }

    var theme = win.theme || {};
    var fgHex = String(theme.foreground || "#000000");

    // Cache identity: upstream imgData/bitmap when known, else the object
    // handed to drawImage. The temporary _scaleImage canvas is never used
    // as a key when the upstream identity is available.
    var upstream = isObj(drawSource);
    var srcObj = upstream ? drawSource : img;
    var pix = sourcePixels(upstream ? drawSource : null, img);
    var fkey = NS.cache.featKey(rect, pix.w, pix.h);
    var id = NS.cache.imageId(srcObj);
    var srcTag = upstream ? "src=up" : "src=draw";

    // A transfer map filters the pixels the same imgData produces, so the
    // identity-keyed caches would mix results. This path is rare; recompute
    // and skip both caches rather than risk cross-talk.
    var transfer = drawTransfer;
    if (transfer && !state.transferLogged) {
      state.transferLogged = true;
      log(win, "transfer map active (" + transfer + "); cache disabled for those draws");
    }

    var t0 = Date.now();
    var feats = transfer ? null : NS.cache.getFeatures(srcObj, fkey);
    var clsMiss = false;
    if (!feats) {
      clsMiss = true;
      feats = NS.classify.classify(win, img, rect);
      if (!transfer) {
        NS.cache.putFeatures(srcObj, fkey, feats);
      }
    }
    var decision = NS.classify.decide(feats, state.sens);
    if (!decision.hit) {
      state.draws++;
      log(
        win,
        "#" + state.draws + " img" + id + " " + rect.sW + "x" + rect.sH + " " + srcTag +
        " pass cls=" + (clsMiss ? "miss" : "hit") + " " + featsDesc(feats) +
        " " + thrDesc(decision.thresholds) + " ms=" + (Date.now() - t0) +
        (transfer ? " xf=on(cache-off)" : "")
      );
      return null;
    }

    // One params build per draw (not per pixel): the result key below must
    // be the exact key of the transform that will run, so both use this P.
    var P = NS.transform.params({ chromaT: state.chromaT, bandWidth: state.bandWidth });
    var rkey = transfer ? null : NS.cache.resKey(fkey, P, fgHex);
    var res = transfer ? null : NS.cache.getResult(srcObj, rkey);
    var resMiss = false;
    if (!res) {
      resMiss = true;
      var off = win.document.createElement("canvas");
      off.width = rect.sW;
      off.height = rect.sH;
      var octx = off.getContext("2d");
      octx.drawImage(img, rect.sX, rect.sY, rect.sW, rect.sH, 0, 0, rect.sW, rect.sH);
      var idata = octx.getImageData(0, 0, rect.sW, rect.sH);
      var tr = NS.transform.transformImageData(idata, P, fgHex);
      octx.putImageData(idata, 0, 0);
      res = { canvas: off, removedFrac: tr.removedFrac };
      if (!transfer) {
        NS.cache.putResult(srcObj, rkey, res);
      }
    }
    state.draws++;
    log(
      win,
      "#" + state.draws + " img" + id + " " + rect.sW + "x" + rect.sH + " " + srcTag +
      " noir cache=" + (transfer ? "off" : resMiss ? "miss" : "hit") +
      " cls=" + (clsMiss ? "miss" : "hit") +
      " " + featsDesc(feats) + " " + thrDesc(decision.thresholds) +
      " ms=" + (Date.now() - t0) + " removed=" + fmt(res.removedFrac || 0) +
      (transfer ? " xf=on" : "")
    );
    return { canvas: res.canvas, rect: rect };
  }

  // ---- teardown ----------------------------------------------------------

  function uninstall() {
    var win = state.win;
    state.generation++;
    for (var i = state.originals.length - 1; i >= 0; i--) {
      var o = state.originals[i];
      if (o.prop) {
        try {
          o.obj[o.prop] = o.orig;
        } catch (e) {}
      }
      if (o.marker) {
        try {
          delete o.obj[o.marker];
        } catch (e2) {}
      }
    }
    state.originals = [];
    state.installed = false;
    state.transferLogged = false;
    if (state.attachTimer) {
      try {
        clearTimeout(state.attachTimer);
      } catch (e) {}
      state.attachTimer = null;
    }
    try {
      if (NS.cache && typeof NS.cache.clear === "function") {
        NS.cache.clear();
      }
    } catch (e2) {}
    drawSource = null;
    drawTransfer = null;
    if (win) {
      log(win, "hook uninstalled");
    }
    state.win = null;
  }

  NS.hook = {
    BUILD: BUILD,
    install: install,
    setPrefs: setPrefs,
    uninstall: uninstall,
    isInstalled: function () {
      return state.installed;
    },
    /**
     * Repaint the current viewer after a pref change. Deliberately safe to
     * call at any time: not installed, or an app that has not finished
     * loading, is a no-op — a pref tick must never break the viewer.
     */
    repaint: function () {
      if (!state.installed || !state.win) {
        return;
      }
      try {
        var app = state.win.PDFViewerApplication;
        if (!app || !app.pdfViewer) {
          return;
        }
        repaint(state.win, app);
        log(state.win, "repaint (prefs changed)");
      } catch (e) {
        /* best-effort: never throw out of a pref change */
      }
    },
  };
})();
