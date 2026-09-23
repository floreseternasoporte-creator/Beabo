// CICLO 43 (C43-D1) — Gate de bloqueos en el perfil de artista de música.
//
// PoC del defecto original: window.musicOpenArtistProfile(uid) se abre por
// enlace profundo (ruta musica/artista/:uid del router v2) con CUALQUIER uid,
// sin verificar bloqueos: renderizaba nombre, avatar, conteo de seguidores,
// la lista COMPLETA de canciones (títulos, portadas, reproducción) y daba
// acceso a la lista de seguidores de una cuenta BLOQUEADA por el usuario.
// openAuthorProfile muestra la pantalla de bloqueo en vez del perfil y
// musicSearchTracks filtra isAccountBlockedForCurrentUser — la vista de
// artista era la única superficie que no lo hacía.
//
// El fix aplica isAccountBlockedForCurrentUser(uid) al inicio (fail-closed):
// pantalla de bloqueo (showBlockedUserScreen(uid, 'music-artist')) en vez
// del perfil; y al desbloquear desde esa pantalla se reabre el artista.
//
// Convención del repo: resuelve ../index.html con fallback a ../src/index.html;
// no depende del historial de git; sin rutas absolutas.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function findFile(names) {
  const cands = [];
  for (const n of names) {
    cands.push(path.join(__dirname, '..', n));
    cands.push(path.join(__dirname, '..', 'src', n));
  }
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('no encontrado: ' + names.join(' / '));
}
const html = fs.readFileSync(findFile(['index.html']), 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}

function extractAssignedFn(name) {
  const anchor = 'window.' + name + ' = function';
  const a = html.indexOf(anchor);
  if (a < 0) throw new Error('ancla no encontrada: ' + anchor);
  const j = html.indexOf('{', a);
  let depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}') { depth--; if (!depth) return html.slice(html.indexOf('function', a), k + 1); }
  }
  throw new Error('sin cierre: ' + anchor);
}

const artistSrc = extractAssignedFn('musicOpenArtistProfile');

// ---- 1. Estático: el gate está presente, ordenado y es fail-closed ---------
check('musicOpenArtistProfile consulta isAccountBlockedForCurrentUser(uid)',
  artistSrc.includes('isAccountBlockedForCurrentUser(uid)'));
check('gate defensivo con typeof (no rompe si el helper falta)',
  /typeof isAccountBlockedForCurrentUser === 'function'/.test(artistSrc));
check('gate ANTES de mostrar la vista (classList.remove)',
  artistSrc.indexOf('isAccountBlockedForCurrentUser(uid)') < artistSrc.indexOf("classList.remove('hidden')"));
check('gate ANTES de empujar la ruta (drexPushDynamicRoute)',
  artistSrc.indexOf('isAccountBlockedForCurrentUser(uid)') < artistSrc.indexOf('drexPushDynamicRoute('));
check('bloqueado -> pantalla de bloqueo, no render del artista',
  artistSrc.includes("showBlockedUserScreen(uid, 'music-artist')"));
check('rama bloqueada termina con return (fail-closed)',
  /showBlockedUserScreen\(uid, 'music-artist'\)[\s\S]{0,400}return;/.test(artistSrc));
check('desbloquear desde la pantalla reabre el artista (simetría con profile)',
  html.includes("origin === 'music-artist'") && html.includes('window.musicOpenArtistProfile(uid)'));

// ---- 2. Funcional: función REAL en sandbox ----------------------------------
// Caso A: uid bloqueado -> pantalla de bloqueo, sin render de canciones.
// Caso B: uid no bloqueado -> la vista se abre y las canciones se listan.
function runCase(blocked) {
  const calls = [];
  const els = {};
  const mk = () => ({
    _h: '', _t: '',
    set innerHTML(v) { this._h = String(v); }, get innerHTML() { return this._h; },
    set textContent(v) { this._t = String(v); }, get textContent() { return this._t; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  });
  ['music-artist-view', 'music-artist-name', 'music-artist-meta', 'music-artist-avatar',
   'music-artist-list', 'music-artist-stats', 'music-artist-follow-btn'].forEach(id => { els[id] = mk(); });
  const trackSnap = { forEach(cb) { cb({ key: 't1', val: () => ({ title: 'Tema X', authorId: 'u1', createdAt: 1 }) }); } };
  const userSnap = { val: () => ({ artistName: 'A', followersCount: 3 }) };
  const ref = p => ({
    once() {
      if (p === 'users/u1') return Promise.resolve(userSnap);
      if (p === 'musicTracks') return Promise.resolve(trackSnap);
      return Promise.resolve({ val: () => null, exists: () => false, forEach() {} });
    },
    orderByChild() { return { equalTo: () => ({ once: () => Promise.resolve(trackSnap) }) }; },
    limitToFirst() { return { once: () => Promise.resolve({ forEach() {} }) }; },
  });
  const sb = {
    console, setTimeout, clearTimeout, Promise,
    document: { getElementById: id => els[id] || null },
    DrexCloud: { auth: () => ({ currentUser: { uid: 'me' } }), database: () => ({ ref }) },
    minimizeMusicPlayer() {},
    drexPushDynamicRoute(r) { calls.push('route:' + r); },
    musicEsc: s => String(s == null ? '' : s),
    musicDb: () => ({ ref }),
    musicQueue: [], musicQueueIdx: -1,
    musicPaintArtistFollowBtn() {},
    musicTrackRowHTML: t => '<div>' + t.title + '</div>',
    musicFmtNum: n => String(n),
    musicEmptyHTML: m => '<div>' + m + '</div>',
    musicCloseArtistProfile() { calls.push('close'); },
    isAccountBlockedForCurrentUser: uid => { calls.push('check:' + uid); return blocked; },
    showBlockedUserScreen: (uid, origin) => { calls.push('screen:' + uid + ':' + origin); },
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext('var musicOpenArtistProfile = (' + artistSrc + ');', sb, { timeout: 5000 });
  return (async () => {
    vm.runInContext('musicOpenArtistProfile("u1");', sb, { timeout: 5000 });
    await new Promise(r => setTimeout(r, 120));
    return { calls, listHTML: els['music-artist-list'].innerHTML, name: els['music-artist-name'].textContent };
  })();
}

(async () => {
  const a = await runCase(true);
  check('bloqueado: se consulta el gate', a.calls.includes('check:u1'));
  check('bloqueado: se muestra la pantalla de bloqueo', a.calls.includes('screen:u1:music-artist'));
  check('bloqueado: NO se renderizan canciones', !a.listHTML.includes('Tema X'));
  check('bloqueado: NO se empuja la ruta del artista', !a.calls.some(c => c.startsWith('route:musica/artista/')));

  const b = await runCase(false);
  check('no bloqueado: se consulta el gate', b.calls.includes('check:u1'));
  check('no bloqueado: la vista se abre con canciones', b.listHTML.includes('Tema X'));
  check('no bloqueado: se empuja la ruta del artista', b.calls.includes('route:musica/artista/u1'));

  if (failures) { console.error(`\n${failures} checks FAILED`); process.exit(1); }
  console.log('\nAll C43-D1 checks passed');
})();
