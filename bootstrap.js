/* Zotero PDF Noir — bootstrap entry (M2.1).
 *
 * Lifecycle: install / startup / shutdown / uninstall (bootstrapped add-on).
 *
 * Responsibilities:
 *  - find the pdf.js viewer windows of open readers,
 *  - inject content/scripts/noir/*.js into the viewer realm,
 *  - install the Blender hook with the current prefs,
 *  - drain hook log lines into the Zotero debug log ([PDF-Noir] prefix).
 *
 * The viewer realm is the nested iframe (pdf/web/viewer.html) inside the
 * reader window; PDFViewerApplication lives there, and so does window.theme
 * which drives the fork's Blender image handling.
 *
 * Injection mechanisms, in order: Services.scriptloader.loadSubScript into
 * the viewer window, inline <script> element with the file contents, then
 * classic <script src="..."> tags.
 */

/* global Zotero, Services */

var ADDON_ID = "pdf-noir@zotero-plugins";
var LOG_PREFIX = "[PDF-Noir]";
var BUILD = "M2.1";
var NOIR_FILES = [
  "content/scripts/noir/classify.js",
  "content/scripts/noir/transform.js",
  "content/scripts/noir/cache.js",
  "content/scripts/noir/hook.js"
];

var _rootURI = null;
var _injectedWins = [];
var _timer = null;
var _startupTimeout = null;
var _active = false;
var _listenerRegistered = false;

function debugLine(line) {
  try {
    Zotero.debug(line);
  } catch (e) {
    /* Zotero.debug unavailable very early */
  }
}

function log() {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) {
    parts.push(String(arguments[i]));
  }
  debugLine(LOG_PREFIX + " " + parts.join(" "));
}

// ---- prefs ---------------------------------------------------------------

function getPrefs() {
  var out = { enable: true, sensitivity: 0.7, devAutoOpenItem: 0 };
  try {
    var e = Zotero.Prefs.get("extensions.pdf-noir.enable", true);
    if (typeof e === "boolean") {
      out.enable = e;
    }
  } catch (err) {}
  try {
    var s = Zotero.Prefs.get("extensions.pdf-noir.sensitivity", true);
    var n = typeof s === "number" ? s : parseFloat(s);
    if (isFinite(n)) {
      out.sensitivity = Math.min(1, Math.max(0, n));
    }
  } catch (err) {}
  try {
    var d = Zotero.Prefs.get("extensions.pdf-noir.devAutoOpenItem", true);
    var dn = typeof d === "number" ? d : parseInt(d, 10);
    if (dn > 0) {
      out.devAutoOpenItem = dn;
    }
  } catch (err) {}
  return out;
}

// ---- reader / viewer discovery --------------------------------------------

function getReaders() {
  try {
    return Zotero.Reader._readers || [];
  } catch (e) {
    return [];
  }
}

function rawWin(win) {
  try {
    return win && (win.wrappedJSObject || win);
  } catch (e) {
    return null;
  }
}

function isViewerWindow(win) {
  try {
    var raw = rawWin(win);
    return !!(raw && raw.PDFViewerApplication);
  } catch (e) {
    return false;
  }
}

function collectFrames(win, depth, out) {
  if (!win || depth > 2) {
    return;
  }
  var frames;
  try {
    frames = win.frames;
  } catch (e) {
    return;
  }
  var n = frames ? frames.length : 0;
  for (var i = 0; i < n; i++) {
    var f = null;
    try {
      f = frames[i];
    } catch (e) {
      continue;
    }
    if (!f) {
      continue;
    }
    out.push(f);
    collectFrames(f, depth + 1, out);
  }
}

function findViewerWindows(reader) {
  var out = [];
  var outer = null;
  try {
    outer = reader._iframeWindow;
  } catch (e) {}
  if (!outer) {
    return out;
  }
  if (isViewerWindow(outer)) {
    out.push(outer);
  }
  var frames = [];
  collectFrames(outer, 0, frames);
  for (var i = 0; i < frames.length; i++) {
    if (isViewerWindow(frames[i])) {
      out.push(frames[i]);
    }
  }
  return out;
}

// ---- injection ------------------------------------------------------------

function pluginURL(rel) {
  var base = _rootURI;
  if (!base) {
    return null;
  }
  if (/\.xpi$/i.test(base)) {
    base = "jar:" + base + "!/";
  } else if (!/[/!]$/.test(base)) {
    base += "/";
  }
  return base + rel;
}

function hasNoirNS(raw) {
  try {
    return !!(raw && raw.PDFNoir && raw.PDFNoir.hook && raw.PDFNoir.hook.BUILD);
  } catch (e) {
    return false;
  }
}

function callHook(raw, method, a1, a2, a3) {
  try {
    var hook = raw.PDFNoir.hook;
    // Direct call: content code cannot read properties of chrome objects
    // (e.g. an array's .length via apply), so pass primitives only.
    return hook[method](a1, a2, a3);
  } catch (e) {
    log("hook." + method + " failed: " + (e && e.message ? e.message : e));
    return null;
  }
}

function registerWin(raw) {
  for (var i = 0; i < _injectedWins.length; i++) {
    if (_injectedWins[i] === raw) {
      return;
    }
  }
  _injectedWins.push(raw);
}

function ensureInjected(win) {
  var raw = rawWin(win);
  if (!raw) {
    return false;
  }
  var prefs = getPrefs();
  if (hasNoirNS(raw)) {
    // Already injected (e.g. after a shutdown/startup cycle, or found again
    // by discovery): register the reference so prefs updates and uninstall
    // keep reaching this window.
    registerWin(raw);
    if (callHook(raw, "isInstalled") !== true) {
      callHook(raw, "install", raw, prefs.sensitivity, prefs.enable);
    }
    return true;
  }
  var urls = [];
  for (var i = 0; i < NOIR_FILES.length; i++) {
    var u = pluginURL(NOIR_FILES[i]);
    if (!u) {
      log("cannot resolve plugin URL (rootURI missing)");
      return false;
    }
    urls.push(u);
  }

  // 1) loadSubScript with the viewer window as target
  try {
    for (var j = 0; j < urls.length; j++) {
      Services.scriptloader.loadSubScript(urls[j], raw);
    }
    if (hasNoirNS(raw)) {
      log("injected noir scripts into viewer (loadSubScript)");
    } else {
      log("loadSubScript did not reach the viewer realm; trying inline");
    }
  } catch (e) {
    log("loadSubScript failed: " + (e && e.message ? e.message : e));
  }

  // 2) inline script element with the file contents
  if (!hasNoirNS(raw)) {
    try {
      var texts = [];
      for (var k = 0; k < NOIR_FILES.length; k++) {
        texts.push(Zotero.File.getContentsFromURL(urls[k]));
      }
      var doc = raw.document;
      var s = doc.createElement("script");
      s.textContent = texts.join("\n;\n");
      (doc.head || doc.documentElement).appendChild(s);
      s.remove();
      if (hasNoirNS(raw)) {
        log("injected noir scripts into viewer (inline)");
      }
    } catch (e2) {
      log("inline injection failed: " + (e2 && e2.message ? e2.message : e2));
    }
  }

  // 3) classic script tags (async; picked up on a later tick)
  if (!hasNoirNS(raw)) {
    try {
      var doc2 = raw.document;
      for (var m = 0; m < urls.length; m++) {
        var tag = doc2.createElement("script");
        tag.src = urls[m];
        (doc2.head || doc2.documentElement).appendChild(tag);
      }
      log("appended noir script tags into viewer (pending)");
      return false;
    } catch (e3) {
      log("script tag injection failed: " + (e3 && e3.message ? e3.message : e3));
      return false;
    }
  }

  if (hasNoirNS(raw)) {
    registerWin(raw);
    callHook(raw, "install", raw, prefs.sensitivity, prefs.enable);
    return true;
  }
  return false;
}

function drainLogs(raw) {
  try {
    var logs = raw.__PDFNoirLogs;
    if (!logs) {
      return;
    }
    var n = logs.length;
    if (!n) {
      return;
    }
    var lines = [];
    for (var i = 0; i < n; i++) {
      lines.push(String(logs[i]));
    }
    try {
      logs.length = 0;
    } catch (eLen) {
      logs.splice(0, n);
    }
    for (var j = 0; j < lines.length; j++) {
      debugLine(lines[j]);
    }
  } catch (e) {
    log("drainLogs failed: " + (e && e.message ? e.message : e));
  }
}

// ---- main loop ------------------------------------------------------------

function tick() {
  var prefs = getPrefs();
  var readers = getReaders();
  var found = 0;
  for (var i = 0; i < readers.length; i++) {
    var wins = findViewerWindows(readers[i]);
    for (var j = 0; j < wins.length; j++) {
      found++;
      ensureInjected(wins[j]);
    }
  }
  // Drain every injected window, independent of reader discovery: discovery
  // can stop finding a window (reader internals change) while its hook keeps
  // producing log lines. Closed or lost windows are uninstalled and dropped
  // so the registry (and the hook's strong references) cannot accumulate.
  for (var k = _injectedWins.length - 1; k >= 0; k--) {
    var raw = _injectedWins[k];
    var alive = false;
    try {
      alive = !!raw && !raw.closed;
    } catch (e) {
      alive = false;
    }
    if (!alive) {
      try {
        if (raw && hasNoirNS(raw)) {
          callHook(raw, "uninstall");
        }
      } catch (e2) {}
      _injectedWins.splice(k, 1);
      continue;
    }
    if (!hasNoirNS(raw)) {
      // Viewer navigated/reloaded: the old document's globals are gone.
      // Discovery will inject into the new document.
      _injectedWins.splice(k, 1);
      continue;
    }
    callHook(raw, "setPrefs", prefs.sensitivity, prefs.enable);
    drainLogs(raw);
  }
  var sig = readers.length + "/" + found + "/" + _injectedWins.length;
  if (sig !== tick._lastSig) {
    tick._lastSig = sig;
    log("readers=" + readers.length + " viewerWins=" + found + " injected=" + _injectedWins.length);
  }
}

function onRenderToolbar() {
  try {
    tick();
  } catch (e) {
    log("renderToolbar handler failed: " + (e && e.message ? e.message : e));
  }
}

function maybeDevAutoOpen() {
  var prefs = getPrefs();
  if (!prefs.devAutoOpenItem) {
    return;
  }
  var id = prefs.devAutoOpenItem;
  Zotero.Items.getAsync(id)
    .then(function (item) {
      if (!_active) {
        return null;
      }
      if (!item) {
        log("devAutoOpen: item " + id + " not found");
        return null;
      }
      log("devAutoOpen: opening item " + id);
      return Zotero.Reader.open(id);
    })
    .then(function (reader) {
      if (_active && reader) {
        log("devAutoOpen: reader opened");
      }
    })
    .catch(function (e) {
      if (_active) {
        log("devAutoOpen failed: " + (e && e.message ? e.message : e));
      }
    });
}

// ---- lifecycle -------------------------------------------------------------

function install(_data, _reason) {
  log("installed build=" + BUILD);
}

function startup(data, reason) {
  try {
    _rootURI = data && data.rootURI ? String(data.rootURI) : null;
  } catch (e) {
    _rootURI = null;
  }
  _active = true;
  log("startup build=" + BUILD + " rootURI=" + _rootURI + " reason=" + reason);
  try {
    Zotero.Reader.registerEventListener("renderToolbar", onRenderToolbar, ADDON_ID);
    _listenerRegistered = true;
  } catch (e) {
    log("registerEventListener failed: " + (e && e.message ? e.message : e));
  }
  // Cover readers already open, and pick up late-loading viewer iframes.
  if (!_timer) {
    _timer = setInterval(function () {
      if (!_active) {
        return;
      }
      try {
        tick();
      } catch (e) {}
    }, 1500);
  }
  if (_startupTimeout) {
    clearTimeout(_startupTimeout);
  }
  _startupTimeout = setTimeout(function () {
    _startupTimeout = null;
    if (!_active) {
      return;
    }
    try {
      tick();
    } catch (e) {}
    maybeDevAutoOpen();
  }, 1500);
}

function shutdown(_data, _reason) {
  log("shutdown build=" + BUILD);
  _active = false;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  if (_startupTimeout) {
    clearTimeout(_startupTimeout);
    _startupTimeout = null;
  }
  if (_listenerRegistered) {
    try {
      Zotero.Reader.unregisterEventListener("renderToolbar", ADDON_ID);
    } catch (e) {
      try {
        Zotero.Reader.unregisterEventListener(onRenderToolbar);
      } catch (e2) {}
    }
    _listenerRegistered = false;
  }
  for (var i = 0; i < _injectedWins.length; i++) {
    var raw = _injectedWins[i];
    try {
      if (raw && !raw.closed && hasNoirNS(raw)) {
        callHook(raw, "uninstall");
      }
    } catch (e) {}
  }
  _injectedWins = [];
}

function uninstall(_data, _reason) {
  log("uninstalled build=" + BUILD);
}

// No-op window hooks: Zotero calls these on every plugin and warns when absent.
function onMainWindowLoad(_data) {}
function onMainWindowUnload(_data) {}
