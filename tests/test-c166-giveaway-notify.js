/* ================================================================
 * C166 — GIVEAWAY: AVISO AL ARTISTA DESTACADO ("Artistas destacados").
 *
 * HALLAZGO (hueco real con ancla triple, verificado contra el código):
 *  - SE CALCULA: featuredArtistsIsActive(cfg) (~33428) — nodo
 *    `featuredArtists` con slots válidos dentro de la ventana; cada slot
 *    se resuelve a un uid real vía usernames/<nombre> (loadFeaturedArtists).
 *  - SE PINTA: renderFeaturedArtists pinta tarjetas con avatar+nombre en
 *    el inicio de TODOS (incluido el artista).
 *  - SILENCIO: el artista destacado nunca se entera (ni push ni unread).
 *    Gemelo estructural del hueco C154 (spotlight top 3), que SÍ avisa
 *    con maybeAnnounceSpotlight (~49815); el módulo del giveaway (c15,
 *    posterior) quedó sin anuncio.
 *
 * CAMBIO (index.html, 2 hunks mínimos):
 *  - giveawayNotifyText(): núcleo puro, texto fijo en español, sin
 *    interpolación (cero superficie de inyección).
 *  - maybeAnnounceGiveaway(cfg, profiles): hook único en el pintado
 *    (tras renderFeaturedArtists) + transacción exactamente-una-vez en
 *    featuredArtistsNotified/<startsAt>/<uid> (reutiliza el flag
 *    idempotente spotlightNotifyFlag de C154) + guarda de sesión
 *    _c166GiveawayTried. Sin auto-aviso (excluye al propio visor).
 *    Best-effort: no bloquea el pintado.
 *  - case 'home' en handleNotificationNavigation → openHome() (con
 *    guarda typeof, patrón C153): el tap abre el inicio, donde se pinta
 *    el módulo.
 *  - Tipo 'music' (existente) → notifTypeToPrefKey devuelve
 *    'followingPosts' (mismo bucket que el aviso de spotlight C154).
 *    Sin tipos nuevos.
 *
 * Ejecutar con: node tests/test-c166-giveaway-notify.js
 * (DREX_HTML puede apuntar al index.html a evaluar.)
 * En base: múltiples NOT OK, exit 1. Con parche: ALL PASS.
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function findHtml() {
  const cands = [
    process.env.DREX_HTML || null,
    path.join(__dirname, '..', 'patched.html'),
    path.join(__dirname, '..', 'index.html'),
    path.join(__dirname, '..', '..', 'beabo', 'index.html'),
  ];
  for (const c of cands) { if (c && fs.existsSync(c)) return c; }
  throw new Error('no se encontró index.html (usa DREX_HTML)');
}
const htmlPath = findHtml();
const html = fs.readFileSync(htmlPath, 'utf8');
console.log('evaluando: ' + htmlPath);

let failures = 0;
const pending = [];
function tcase(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(v => {
        console.log((v ? 'ok - ' : 'NOT OK - ') + name);
        if (!v) failures++;
      }).catch(e => {
        console.log('NOT OK - ' + name + ' [excepción: ' + (e && e.message) + ']');
        failures++;
      }));
    } else {
      console.log((r ? 'ok - ' : 'NOT OK - ') + name);
      if (!r) failures++;
    }
  } catch (e) {
    console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
    failures++;
  }
}
function extractFn(source, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(source);
  if (!m) throw new Error('no se encontró ' + name);
  let i = source.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(m.index, j + 1); }
  }
  throw new Error('llaves sin cerrar en ' + name);
}
function tryExtract(name) {
  try { return extractFn(html, name); } catch (e) { return null; }
}

// ---------- A. Existencia del parche ----------
tcase('A1 existe giveawayNotifyText', () => !!tryExtract('giveawayNotifyText'));
tcase('A2 existe maybeAnnounceGiveaway', () => !!tryExtract('maybeAnnounceGiveaway'));
tcase('A3 hook tras renderFeaturedArtists', () =>
  html.includes('maybeAnnounceGiveaway(cfg, ok)'));
tcase('A4 case home en el manejador de tap', () =>
  /case 'home':[\s\S]{0,400}?openHome\(\)/.test(html));
tcase('A5 nodo de flag featuredArtistsNotified', () =>
  html.includes('featuredArtistsNotified/'));

// ---------- B. Funciones puras ----------
tcase('B1 giveawayNotifyText: texto fijo en español', () => {
  const src = tryExtract('giveawayNotifyText');
  if (!src) return false;
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(src + '\nglobalThis.__t = giveawayNotifyText();', sb);
  return sb.__t === '¡Felicidades! Fuiste seleccionado como Artista Destacado en Drex.';
});
tcase('B2 giveawayNotifyText: sin interpolación (inmune a nombre forjado)', () => {
  const src = tryExtract('giveawayNotifyText');
  if (!src) return false;
  return !src.includes('${') && !src.includes('+ name') && !src.includes('+name');
});
tcase('B3 featuredArtistsIsActive: config válida → true', () => {
  const src = tryExtract('featuredArtistsIsActive');
  if (!src) return false;
  const sb = {};
  vm.createContext(sb);
  const now = 1759000000000;
  vm.runInContext(src + `\nglobalThis.__t = featuredArtistsIsActive(
    { slots: [{username:'a'},{username:'b'}], startsAt: ${now - 1000}, endsAt: ${now + 1000} }, ${now});`, sb);
  return sb.__t === true;
});
tcase('B4 featuredArtistsIsActive: fuera de ventana → false', () => {
  const src = tryExtract('featuredArtistsIsActive');
  if (!src) return false;
  const sb = {};
  vm.createContext(sb);
  const now = 1759000000000;
  vm.runInContext(src + `\nglobalThis.__t = featuredArtistsIsActive(
    { slots: [{username:'a'}], startsAt: ${now + 5000}, endsAt: ${now + 9000} }, ${now});`, sb);
  return sb.__t === false;
});
tcase('B5 spotlightNotifyFlag: idempotente (null→set, existente→no-op)', () => {
  const src = tryExtract('spotlightNotifyFlag');
  if (!src) return false;
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(src + `
    globalThis.__a = spotlightNotifyFlag(null, 123);
    globalThis.__b = spotlightNotifyFlag({at: 1}, 456);`, sb);
  return sb.__a && sb.__a.at === 123 && sb.__b === undefined;
});
tcase('B6 notifTypeToPrefKey: music → followingPosts (bucket existente)', () => {
  const src = tryExtract('notifTypeToPrefKey');
  if (!src) return false;
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(src + `\nglobalThis.__t = notifTypeToPrefKey('music', {});`, sb);
  return sb.__t === 'followingPosts';
});

// ---------- C. Comportamiento del anunciador (con mocks) ----------
function makeDb(store) {
  return {
    database: () => ({
      ref: (p) => ({
        transaction: (updateFn, cb) => {
          const cur = Object.prototype.hasOwnProperty.call(store, p) ? store[p] : null;
          const next = updateFn(cur);
          if (next === undefined) { cb(null, false); return; }
          store[p] = next;
          cb(null, true);
        }
      })
    }),
    auth: () => ({ currentUser: { uid: 'viewer1' } })
  };
}
function runAnnouncer(store, cfg, profiles, viewerUid) {
  const srcActive = tryExtract('featuredArtistsIsActive');
  const srcFlag = tryExtract('spotlightNotifyFlag');
  const srcText = tryExtract('giveawayNotifyText');
  const srcMain = tryExtract('maybeAnnounceGiveaway');
  if (!srcActive || !srcFlag || !srcText || !srcMain) return null;
  const calls = [];
  const txCount = { n: 0 };
  const db = makeDb(store);
  if (viewerUid !== undefined) db.auth = () => ({ currentUser: viewerUid ? { uid: viewerUid } : null });
  const sb = {
    DrexCloud: db,
    addNotification: (userId, message, type, meta) => { calls.push({ userId, message, type, meta }); return Promise.resolve(); },
    console: console
  };
  // envolver transaction para contar intentos
  const origRef = db.database().ref;
  const dbWrap = {
    database: () => ({
      ref: (p) => {
        const r = origRef(p);
        return { transaction: (uf, cb) => { txCount.n++; return r.transaction(uf, cb); } };
      }
    }),
    auth: db.auth
  };
  sb.DrexCloud = dbWrap;
  vm.createContext(sb);
  vm.runInContext(
    'var _c166GiveawayTried = {};\n' + srcActive + '\n' + srcFlag + '\n' + srcText + '\n' + srcMain +
    '\nglobalThis.__run = function(cfg, profiles){ maybeAnnounceGiveaway(cfg, profiles); };',
    sb);
  sb.__run(cfg, profiles);
  return { calls, txCount: txCount.n, store };
}
const NOW = Date.now();
const CFG = { slots: [{ username: 'artista1' }, { username: 'artista2' }], startsAt: NOW - 1000, endsAt: NOW + 7 * 86400000 };
function prof(uid, uname) {
  return { username: uname, uid: uid, data: { displayName: 'Nombre ' + uname, username: uname, profileImage: 'https://x/y.png' } };
}

tcase('C1 config activa + 2 artistas: avisa a ambos con type music/actionType home', () => {
  const r = runAnnouncer({}, CFG, [prof('u1', 'artista1'), prof('u2', 'artista2')]);
  if (!r) return false;
  if (r.calls.length !== 2) return false;
  const ids = r.calls.map(c => c.userId).sort();
  if (ids[0] !== 'u1' || ids[1] !== 'u2') return false;
  return r.calls.every(c =>
    c.type === 'music' &&
    c.meta && c.meta.actionType === 'home' &&
    c.message === '¡Felicidades! Fuiste seleccionado como Artista Destacado en Drex.');
});
tcase('C2 exactamente-una-vez entre clientes: el segundo no re-avisa', () => {
  const store = {};
  const r1 = runAnnouncer(store, CFG, [prof('u1', 'artista1'), prof('u2', 'artista2')]);
  if (!r1 || r1.calls.length !== 2) return false;
  // "otro cliente": guarda de sesión fresca, misma BD compartida
  const r2 = runAnnouncer(store, CFG, [prof('u1', 'artista1'), prof('u2', 'artista2')]);
  if (!r2) return false;
  return r2.calls.length === 0 && r2.txCount === 2; // intentó, pero no commiteó
});
tcase('C3 sin auto-aviso: el visor-artista no se avisa a sí mismo', () => {
  const r = runAnnouncer({}, CFG, [prof('viewer1', 'artista1'), prof('u2', 'artista2')], 'viewer1');
  if (!r) return false;
  return r.calls.length === 1 && r.calls[0].userId === 'u2';
});
tcase('C4 config inactiva (fuera de ventana): cero intentos', () => {
  const bad = { slots: [{ username: 'a' }], startsAt: NOW + 5000, endsAt: NOW + 9000 };
  const r = runAnnouncer({}, bad, [prof('u1', 'a')]);
  if (!r) return false;
  return r.calls.length === 0 && r.txCount === 0;
});
tcase('C5 config sin slots: cero intentos', () => {
  const bad = { slots: [], startsAt: NOW - 1000, endsAt: NOW + 9000 };
  const r = runAnnouncer({}, bad, [prof('u1', 'a')]);
  if (!r) return false;
  return r.calls.length === 0 && r.txCount === 0;
});
tcase('C6 sin sesión: no hace nada', () => {
  const r = runAnnouncer({}, CFG, [prof('u1', 'a')], null);
  if (!r) return false;
  return r.calls.length === 0 && r.txCount === 0;
});
tcase('C7 perfiles sin uid se saltan', () => {
  const r = runAnnouncer({}, CFG, [{ username: 'fantasma', uid: null }, prof('u2', 'artista2')]);
  if (!r) return false;
  return r.calls.length === 1 && r.calls[0].userId === 'u2';
});
tcase('C8 actor del aviso es el propio artista (nombre/avatar reales)', () => {
  const r = runAnnouncer({}, CFG, [prof('u1', 'artista1')]);
  if (!r || r.calls.length !== 1) return false;
  const m = r.calls[0].meta;
  return m.actorId === 'u1' && m.actorName === 'Nombre artista1' && m.actorImage === 'https://x/y.png';
});

// ---------- D. Tap navega al inicio ----------
tcase('D1 tap en el aviso abre el inicio (openHome)', () => {
  const src = tryExtract('handleNotificationNavigation');
  if (!src) return false;
  const sb = {
    called: [],
    closeNotifications: function () { sb.called.push('close'); },
    openHome: function () { sb.called.push('openHome'); },
    setTimeout: function (fn) { fn(); return 0; }
  };
  vm.createContext(sb);
  vm.runInContext(src + '\nglobalThis.__nav = handleNotificationNavigation;', sb);
  sb.__nav({ actionType: 'home', type: 'music' });
  return sb.called.includes('openHome');
});
tcase('D2 case home con guarda typeof (no revienta sin openHome)', () => {
  const src = tryExtract('handleNotificationNavigation');
  if (!src) return false;
  const sb = {
    closeNotifications: function () {},
    setTimeout: function (fn) { fn(); return 0; }
  };
  vm.createContext(sb);
  vm.runInContext(src + '\nglobalThis.__nav = handleNotificationNavigation;', sb);
  sb.__nav({ actionType: 'home', type: 'music' }); // sin openHome definido: no debe lanzar
  return true;
});

Promise.all(pending).then(() => {
  console.log('---');
  if (failures > 0) { console.log(failures + ' NOT OK'); process.exit(1); }
  console.log('ALL PASS');
});
