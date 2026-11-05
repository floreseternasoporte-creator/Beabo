/* DrexFeedLive — utilidades puras (sin DOM ni red) del feed al estilo X.
 *
 * Se mantienen fuera de index.html para poder probarlas con node
 * (tests/test-feed-live.js). index.html las usa a través de window.DrexFeedLive.
 *
 *  - dedupe(): comparte UNA sola petición en vuelo por clave (arregla el N+1:
 *    50 publicaciones del mismo autor ya no disparan 50 lecturas idénticas).
 *  - createBuffer(): cola de "publicaciones nuevas" que llegan en vivo mientras
 *    el usuario ya bajó por el feed; se muestran al tocar la píldora.
 *  - shouldBufferNewPost(): decide si una publicación en vivo se encola o se
 *    monta de inmediato (propias o estando arriba del todo = inmediato).
 *  - pullState(): matemática del pull-to-refresh (resistencia, umbral).
 *  - pickFollowedAuthors(): autores más recientes a los que sigo (para rellenar
 *    "Mi gente" cuando el flujo global no trae suficientes publicaciones suyas).
 *  - navShouldHide(): histéresis para ocultar la barra inferior sin parpadeo.
 */
(function (global) {
  'use strict';

  var PULL_THRESHOLD = 64;   // px (ya con resistencia) para soltar y refrescar
  var PULL_MAX = 112;        // px máximos que se estira el indicador
  var PULL_RESISTANCE = 0.5; // el dedo se mueve 2px por cada 1px del indicador
  var TOP_FLUSH_PX = 24;     // al volver a <= 24px del tope se vuelcan las nuevas
  var BUFFER_AFTER_PX = 120; // por debajo de este scroll, las nuevas se encolan
  var NAV_MIN_DELTA = 6;     // px mínimos de scroll para cambiar la barra
  var NAV_ALWAYS_SHOW_PX = 56; // cerca del tope la barra siempre se ve

  // ---- Promesas en vuelo compartidas (anti N+1) ---------------------------
  function dedupe(store, key, fn) {
    var hit = store.get(key);
    if (hit) return hit;
    var p;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    var done = function () { if (store.get(key) === p) store.delete(key); };
    p.then(done, done);
    store.set(key, p);
    return p;
  }

  // ---- Cola de publicaciones nuevas --------------------------------------
  function createBuffer() {
    var items = new Map();
    return {
      add: function (note) {
        if (!note || !note.id || items.has(note.id)) return false;
        items.set(note.id, note);
        return true;
      },
      has: function (id) { return items.has(id); },
      remove: function (id) { return items.delete(id); },
      count: function () { return items.size; },
      clear: function () { items.clear(); },
      // Devuelve las notas de la más VIEJA a la más NUEVA: al montarlas con
      // prepend() la más nueva queda arriba.
      drain: function () {
        var arr = Array.from(items.values());
        items.clear();
        arr.sort(function (a, b) { return Number(a.timestamp || 0) - Number(b.timestamp || 0); });
        return arr;
      }
    };
  }

  function shouldBufferNewPost(opts) {
    opts = opts || {};
    if (opts.isOwn) return false;          // lo que publico yo se ve ya
    if (opts.alreadyShown) return false;   // actualización de una tarjeta existente
    return Number(opts.scrollTop || 0) > BUFFER_AFTER_PX;
  }

  function shouldFlushOnScroll(scrollTop, pending) {
    return pending > 0 && Number(scrollTop || 0) <= TOP_FLUSH_PX;
  }

  // ---- Pull to refresh ----------------------------------------------------
  function pullState(deltaY) {
    var d = Math.max(0, Number(deltaY) || 0);
    var dist = Math.min(PULL_MAX, d * PULL_RESISTANCE);
    var progress = Math.min(1, dist / PULL_THRESHOLD);
    return { distance: dist, progress: progress, ready: dist >= PULL_THRESHOLD };
  }

  // ---- "Mi gente" ----------------------------------------------------------
  // followingMap: { uid: true | { followedAt } }. Más recientemente seguidos
  // primero (los que no tienen fecha van al final). Excluye mi propio uid.
  function pickFollowedAuthors(followingMap, myUid, cap) {
    if (!followingMap || typeof followingMap !== 'object') return [];
    var arr = Object.keys(followingMap)
      .filter(function (uid) { return uid && uid !== myUid && followingMap[uid]; })
      .map(function (uid) {
        var v = followingMap[uid];
        var t = (v && typeof v === 'object') ? Number(v.followedAt || 0) : 0;
        return { uid: uid, t: t };
      });
    arr.sort(function (a, b) { return b.t - a.t; });
    return arr.slice(0, Math.max(0, cap | 0)).map(function (x) { return x.uid; });
  }

  // ---- Barra inferior -----------------------------------------------------
  // Devuelve true (ocultar), false (mostrar) o null (sin cambio).
  function navShouldHide(prevTop, top) {
    var d = top - prevTop;
    if (top <= NAV_ALWAYS_SHOW_PX) return false;
    if (Math.abs(d) < NAV_MIN_DELTA) return null;
    return d > 0;
  }

  var api = {
    dedupe: dedupe,
    createBuffer: createBuffer,
    shouldBufferNewPost: shouldBufferNewPost,
    shouldFlushOnScroll: shouldFlushOnScroll,
    pullState: pullState,
    pickFollowedAuthors: pickFollowedAuthors,
    navShouldHide: navShouldHide,
    PULL_THRESHOLD: PULL_THRESHOLD,
    PULL_MAX: PULL_MAX,
    TOP_FLUSH_PX: TOP_FLUSH_PX,
    BUFFER_AFTER_PX: BUFFER_AFTER_PX
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DrexFeedLive = api;
})(typeof window !== 'undefined' ? window : globalThis);
