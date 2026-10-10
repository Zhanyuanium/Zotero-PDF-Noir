/* Zotero PDF Noir — result caches (v1.0.0).
 *
 * Two caches, both keyed by the *upstream* image identity (the pdf.js
 * imgData object or its bitmap — not the temporary canvas `_scaleImage`
 * creates per render), plus the source rect and the source's pixel size:
 *
 *  - features cache: classification features. Independent of sensitivity
 *    and theme colors, so a pref change does not invalidate it.
 *  - result cache: the transformed canvas for a noir hit. Keyed by the
 *    features key plus sensitivity and the theme foreground colour (the
 *    background colour does not influence the output, so it is not part of
 *    the key).
 *
 * Repeated renders of the same figure (scroll, repaint) hit the caches;
 * zoom changes produce a different rect and therefore a new entry.
 *
 * Memory is bounded twice:
 *  - per image identity: MAX_PER_IMAGE entries (oldest evicted first);
 *  - globally: an approximate byte budget (MAX_BYTES) with LRU eviction over
 *    all identities, so many live source objects cannot accumulate without
 *    limit. Transformed canvases are charged width * height * 4 bytes.
 *
 * `clear()` drops every entry and resets the budget; hook.js calls it on
 * uninstall.
 */
(function () {
  "use strict";

  var g = typeof window !== "undefined" ? window : globalThis;
  var NS = (g.PDFNoir = g.PDFNoir || {});

  var MAX_PER_IMAGE = 8;
  var MAX_BYTES = 64 * 1024 * 1024;
  var FEATURES_BYTES = 256; // fixed estimate per features entry

  var ids = new WeakMap();
  var nextId = 1;
  var featStore = new WeakMap();
  var resStore = new WeakMap();

  // Global LRU: lruKey -> { store, obj, key, entry, size }. Insertion order is
  // the eviction order; `totalBytes` tracks the approximate footprint.
  var lru = new Map();
  var lruSeq = 1;
  var totalBytes = 0;

  function imageId(obj) {
    var id = ids.get(obj);
    if (!id) {
      id = nextId++;
      ids.set(obj, id);
    }
    return id;
  }

  /** Key for parameter-independent data (features). */
  function featKey(rect, pixW, pixH) {
    return (
      rect.sX + "," + rect.sY + "," + rect.sW + "," + rect.sH +
      "@" + pixW + "x" + pixH
    );
  }

  /** Key for parameter-dependent data (transformed canvas). */
  function resKey(fkey, sens, fgHex) {
    return fkey + "|s=" + sens + "|fg=" + fgHex;
  }

  function entrySize(store, entry) {
    if (store === resStore && entry && entry.canvas) {
      return entry.canvas.width * entry.canvas.height * 4;
    }
    return FEATURES_BYTES;
  }

  function touch(lruKey) {
    var rec = lru.get(lruKey);
    if (!rec) {
      return null;
    }
    lru.delete(lruKey);
    lru.set(lruKey, rec);
    return rec;
  }

  function drop(lruKey) {
    var rec = lru.get(lruKey);
    if (!rec) {
      return;
    }
    lru.delete(lruKey);
    totalBytes -= rec.size;
    if (totalBytes < 0) {
      totalBytes = 0;
    }
    var map = rec.store.get(rec.obj);
    if (map) {
      map.delete(rec.key);
      if (!map.size) {
        rec.store.delete(rec.obj);
      }
    }
  }

  function evictToBudget() {
    while (totalBytes > MAX_BYTES && lru.size) {
      var oldest = lru.keys().next().value;
      drop(oldest);
    }
  }

  /** The least recently used entry of one identity, in global LRU order. */
  function oldestLruKeyFor(store, obj) {
    var it = lru.keys();
    var step = it.next();
    while (!step.done) {
      var rec = lru.get(step.value);
      if (rec && rec.store === store && rec.obj === obj) {
        return step.value;
      }
      step = it.next();
    }
    return null;
  }

  function getFrom(store, obj, key) {
    var map = store.get(obj);
    if (!map || !map.has(key)) {
      return null;
    }
    var entry = map.get(key);
    if (entry && entry.__lruKey) {
      touch(entry.__lruKey);
    }
    return entry;
  }

  function putInto(store, obj, key, entry) {
    var map = store.get(obj);
    if (!map) {
      map = new Map();
      store.set(obj, map);
    }
    if (entry && entry.__lruKey) {
      drop(entry.__lruKey);
    }
    var lruKey = "k" + lruSeq++;
    var size = entrySize(store, entry);
    try {
      Object.defineProperty(entry, "__lruKey", { value: lruKey, configurable: true });
    } catch (e) {
      entry.__lruKey = lruKey;
    }
    map.set(key, entry);
    lru.set(lruKey, { store: store, obj: obj, key: key, entry: entry, size: size });
    totalBytes += size;
    while (map.size > MAX_PER_IMAGE) {
      var victimLru = oldestLruKeyFor(store, obj);
      if (victimLru) {
        drop(victimLru);
      } else {
        var oldestKey = map.keys().next().value;
        map.delete(oldestKey);
      }
    }
    evictToBudget();
  }

  /** Drop everything (used on uninstall). */
  function clear() {
    for (var lruKey of Array.from(lru.keys())) {
      drop(lruKey);
    }
    lru.clear();
    totalBytes = 0;
  }

  NS.cache = {
    imageId: imageId,
    featKey: featKey,
    resKey: resKey,
    getFeatures: function (obj, key) {
      return getFrom(featStore, obj, key);
    },
    putFeatures: function (obj, key, feats) {
      putInto(featStore, obj, key, feats);
    },
    getResult: function (obj, key) {
      return getFrom(resStore, obj, key);
    },
    putResult: function (obj, key, entry) {
      putInto(resStore, obj, key, entry);
    },
    clear: clear,
    // exposed for tests / diagnostics
    stats: function () {
      return { entries: lru.size, bytes: totalBytes, maxBytes: MAX_BYTES };
    },
  };
})();
