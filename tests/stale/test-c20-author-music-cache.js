// tests/test-c20-author-music-cache.js
// Regresión C20: el bloque musical del perfil de autor NO debe contaminar
// musicSearchCache (lista de búsqueda del tab Música).
// Extrae el CODIGO REAL de index.html y lo ejecuta en vm con stubs.
// Uso: node tests/test-c20-author-music-cache.js [ruta/index.html]
// Sale 0 si pasa, 1 si falla. Debe FALLAR en 267e5f3 (base) y PASAR con el fix.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX_PATH = process.argv[2] || path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_PATH, 'utf8');

function grab(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s < 0) throw new Error('no hallado: ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e < 0) throw new Error('cierre no hallado para: ' + startMarker);
  return src.slice(s, e + endMarker.length);
}
// Declaraciones de cachés (1 línea en la base, 3 con el fix).
let d0 = src.indexOf('let musicSearchCache = [];');
if (d0 < 0) throw new Error('sin musicSearchCache');
let dEnd;
const uidIdx = src.indexOf('let musicAuthorBlockUid', d0);
dEnd = (uidIdx >= 0 && uidIdx < d0 + 400) ? src.indexOf('\n', uidIdx) : src.indexOf('\n', d0);
const decl = src.slice(d0, dEnd);

const code = [
  decl,
  grab('window.renderAuthorMusicBlock = function', '\n};'),
  grab('window.musicPlayFromList = function', '\n};'),
  grab('function musicFavArrForCtx(ctx)', '\n}'),
].join('\n\n');

// ---- sandbox ----
const rowCalls = [];   // ctx con que se pintó cada fila
const pending = {};    // authorId -> {res, tracks}
function fakeSnap(tracks) {
  return { forEach(cb) { tracks.forEach(t => cb({ key: t.id, val: () => t })); } };
}
function fakeEl() {
  return {
    id: '', className: '', innerHTML: '', _connected: true,
    get isConnected() { return this._connected; },
    prepend() {}, remove() { this._connected = false; },
  };
}
const sandbox = {
  console,
  pending, fakeSnap,
  MUSIC_NOTE_SVG: '<svg/>',
  musicTrackRowHTML: (t, i, ctx) => { rowCalls.push({ ctx, id: t.id }); return '<div>row</div>'; },
  musicDb: () => ({
    ref() {
      const chain = {
        _id: null,
        orderByChild() { return this; },
        equalTo(id) { this._id = id; return this; },
        limitToLast() { return this; },
        once() {
          const id = this._id;
          return new Promise(res => { pending[id] = { res }; });
        },
      };
      return chain;
    },
  }),
  document: { createElement: () => fakeEl() },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const driver = `
var musicQueue = [], musicQueueIdx = -1, musicMixActive = false;
var musicExploreCache = [], musicTopCache = [], musicHistoryCache = [];
var musicArtistCache = [], musicPlaylistDetailCache = null;
var __played = [];
function musicSortedMine(){ return []; }
function musicStartTrack(t){ __played.push(t); }
globalThis.__T = {
  setSearchCache: function(v){ musicSearchCache = v; },
  getSearchCache: function(){ return musicSearchCache; },
  getAuthorBlockCache: function(){ try { return musicAuthorBlockCache; } catch (e) { return 'MISSING'; } },
  hasAuthorBlockCache: function(){ try { musicAuthorBlockCache; return true; } catch (e) { return false; } },
  play: function(ctx, i){ __played = []; musicPlayFromList(ctx, i); return __played.slice(); },
  favArr: function(ctx){ return musicFavArrForCtx(ctx); },
  renderAuthorBlock: function(authorId){ var c = { block: null, prepend: function(el){ this.block = el; } }; renderAuthorMusicBlock(authorId, c); return c; },
  resolvePending: function(authorId, tracks){ var p = pending[authorId]; if (p) p.res(fakeSnap(tracks)); },
};
`;
vm.runInContext(code + '\n' + driver, sandbox, { filename: 'c20-extracted.js' });

const T = sandbox.__T;
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FALLA ' + name); }
}
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
const ids = a => (a || []).map(t => t.id).join(',');

(async () => {
  console.log('index.html bajo prueba: ' + INDEX_PATH);

  // 1) Simular resultados de búsqueda presentes en el tab Música.
  const searchTracks = [{ id: 's1', title: 'Salsa 1' }, { id: 's2', title: 'Salsa 2' }];
  T.setSearchCache(searchTracks);

  // 2) Abrir perfil de autor con 3 canciones.
  const authorTracks = [{ id: 'a1', title: 'Autor 1' }, { id: 'a2', title: 'Autor 2' }, { id: 'a3', title: 'Autor 3' }];
  T.renderAuthorBlock('authorX');
  T.resolvePending('authorX', authorTracks);
  await flush();

  // 3) La búsqueda NO debe contaminarse.
  ok(ids(T.getSearchCache()) === 's1,s2',
    'musicSearchCache conserva los resultados de búsqueda tras abrir el perfil del autor');

  // 4) El bloque de autor usa su propio caché (solo existe con el fix).
  const abc = T.getAuthorBlockCache();
  ok(abc !== 'MISSING' && ids(abc) === 'a1,a2,a3',
    'el bloque de autor guarda sus canciones en caché propio (musicAuthorBlockCache)');

  // 5) Las filas del bloque se pintan con ctx dedicado, no 'search'.
  const blockRows = rowCalls.filter(r => ['a1', 'a2', 'a3'].includes(r.id));
  ok(blockRows.length === 3 && blockRows.every(r => r.ctx === 'authorblock'),
    "las filas del autor usan ctx 'authorblock' (no 'search')");

  // 6) Reproducir desde la lista de BÚSQUEDA tras abrir el perfil: debe sonar s1.
  const played = T.play('search', 0);
  ok(played.length === 1 && played[0].id === 's1',
    "musicPlayFromList('search', 0) reproduce el resultado de búsqueda (s1), no una canción del autor");

  // 7) Reproducir desde el bloque de autor.
  const playedA = T.play('authorblock', 2);
  ok(T.hasAuthorBlockCache() ? (playedA.length === 1 && playedA[0].id === 'a3') : playedA.length === 0,
    "musicPlayFromList('authorblock', 2) reproduce la canción a3 del autor");

  // 8) Favoritos del bloque de autor resuelven contra su caché.
  const favArr = T.favArr('authorblock');
  ok(T.hasAuthorBlockCache() ? ids(favArr) === 'a1,a2,a3' : true,
    "musicFavArrForCtx('authorblock') devuelve las canciones del autor");

  // 9) Guarda anti-stale A→B (solo con el fix).
  if (T.hasAuthorBlockCache()) {
    rowCalls.length = 0;
    T.renderAuthorBlock('A');
    T.renderAuthorBlock('B');
    T.resolvePending('B', [{ id: 'b1' }, { id: 'b2' }]);
    await flush();
    T.resolvePending('A', [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]); // respuesta vieja, llega tarde
    await flush();
    ok(ids(T.getAuthorBlockCache()) === 'b1,b2',
      'respuesta stale del perfil A no sobrescribe el caché del perfil B');
    ok(rowCalls.length === 2 && rowCalls.every(r => r.ctx === 'authorblock'),
      'la respuesta stale no repinta filas del perfil viejo');
  } else {
    console.log('  (stale-guard omitido: sin caché de autor en esta base)');
  }

  console.log('\n' + pass + ' ok, ' + fail + ' fallas');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
