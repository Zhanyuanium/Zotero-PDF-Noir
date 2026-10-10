/* Zotero PDF Noir — result caches (M2.1).
 *
 * Two caches, both keyed by the *upstream* image identity (the pdf.js
 * imgData object or its bitmap — not the temporary canvas `_scaleImage`
 * creates per render), plus the source rect and the source's pixel size:
 *
 *  - features cache: classification features. Independent of sensitivity
 *    and theme colors, so a pref change does not invalidate it.
 *  - result cache: the transformed canvas for a noir hit. Keyed by the
 *    features key plus sensitivity and theme colors.
 *
 * Repeated renders of the same figure (scroll, repaint) hit the caches;
 * zoom changes produce a different rect and therefore a new entry.
 * Per-identity entries are capped; oldest entries are evicted first.
 */
(function () {
  "use strict";

  var g = typeof window !== "undefined" ? window : globalThis;
  var NS = (g.PDFNoir = g.PDFNoir || {});

  var MAX_PER_IMAGE = 8;
  var ids = new WeakMap();
  var nextId = 1;
  var featStore = new WeakMap();
  var resStore = new WeakMap();

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
  function resKey(fkey, sens, bgHex, fgHex) {
    return fkey + "|s=" + sens + "|bg=" + bgHex + "|fg=" + fgHex;
  }

  function getFrom(store, obj, key) {
    var map = store.get(obj);
    if (!map || !map.has(key)) {
      return null;
    }
    // touch for LRU order
    var entry = map.get(key);
    map.delete(key);
    map.set(key, entry);
    return entry;
  }

  function putInto(store, obj, key, entry) {
    var map = store.get(obj);
    if (!map) {
      map = new Map();
      store.set(obj, map);
    }
    map.set(key, entry);
    while (map.size > MAX_PER_IMAGE) {
      var oldest = map.keys().next().value;
      map.delete(oldest);
    }
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
  };
})();
