'use strict';
// Tests de fugas de blob URLs (música) — Ciclo 99.
// C99-F1: musicUrlCache con tope LRU (12) + revocación al desalojar;
//         musicDeleteTrack revoca el blob URL (antes solo lo olvidaba).
// C99-F2: el probe de duración de audio revoca su object URL también en onerror.
// Extrae el módulo de caché de index.html; --target permite correr contra la
// base (git show HEAD:index.html) para verificar que el test FALLA sin el parche.
// Uso: node tests/test-c99-object-urls.js [--target base.html]
process.chdir(__dirname + '/..');
const fs = require('fs');

let target = 'index.html';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) target = process.argv[++i];
}

const html = fs.readFileSync(target, 'utf8');
const START = 'let musicUrlCache = new Map();';
const END = 'let musicExploreCache = [];';
const si = html.indexOf(START), ei = html.indexOf(END);
const src = (si >= 0 && ei > si) ? html.slice(si, ei) : null;

let fails = 0, oks = 0;
const CASES = [];
function tcase(name, fn) { CASES.push([name, fn]); }
function assert(cond, label) { if (!cond) throw new Error('assert: ' + label); }
function eqJ(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(label + ' esperado=' + e + ' actual=' + a);
}

// --- Módulo extraído (C99) ---
tcase('extracción del módulo musicUrlCache', () => {
  assert(src, 'bloque musicUrlCache ausente en ' + target);
  assert(src.indexOf('function musicUrlCacheSet(') >= 0, 'musicUrlCacheSet ausente (sin parche?)');
  assert(src.indexOf('function musicUrlCacheRemove(') >= 0, 'musicUrlCacheRemove ausente (sin parche?)');
});

let M = null;
function loadModule() {
  if (M) return M;
  assert(src, 'sin bloque que cargar');
  const revoked = [];
  const fakeURL = {
    createObjectURL: (b) => 'blob:fake-' + (++fakeURL._n),
    revokeObjectURL: (u) => { revoked.push(u); }
  };
  fakeURL._n = 0;
  fakeURL._revoked = revoked; // el cuerpo de new Function no ve el scope exterior
  const body = src + '\n;return { musicUrlCache, musicUrlCacheSet, musicUrlCacheRemove, DREX_MUSIC_URL_CACHE_MAX, _revoked: URL._revoked };';
  M = new Function('URL', body)(fakeURL);
  return M;
}

tcase('set/get roundtrip', () => {
  const m = loadModule();
  m.musicUrlCache.clear(); m._revoked.length = 0;
  m.musicUrlCacheSet('t1', 'blob:u1');
  assert(m.musicUrlCache.get('t1') === 'blob:u1', 'get no devuelve lo insertado');
});

tcase('re-set de la misma clave revoca la URL vieja y no duplica', () => {
  const m = loadModule();
  m.musicUrlCache.clear(); m._revoked.length = 0;
  m.musicUrlCacheSet('t1', 'blob:old');
  m.musicUrlCacheSet('t1', 'blob:new');
  eqJ(m._revoked, ['blob:old'], 'debe revocar la URL anterior');
  assert(m.musicUrlCache.size === 1, 'la clave no debe duplicarse');
  assert(m.musicUrlCache.get('t1') === 'blob:new', 'debe quedar la URL nueva');
});

tcase('tope LRU: al exceder 12 se desaloja y revoca la más vieja', () => {
  const m = loadModule();
  m.musicUrlCache.clear(); m._revoked.length = 0;
  assert(m.DREX_MUSIC_URL_CACHE_MAX === 12, 'tope debe ser 12');
  for (let i = 1; i <= 13; i++) m.musicUrlCacheSet('k' + i, 'blob:k' + i);
  assert(m.musicUrlCache.size === 12, 'el tamaño no debe exceder 12 (es ' + m.musicUrlCache.size + ')');
  eqJ(m._revoked, ['blob:k1'], 'debe revocar exactamente la más vieja');
  assert(!m.musicUrlCache.has('k1'), 'k1 debe haber salido');
  assert(m.musicUrlCache.has('k13'), 'k13 debe estar dentro');
});

tcase('LRU: re-set refresca recencia (no se desaloja la tocada)', () => {
  const m = loadModule();
  m.musicUrlCache.clear(); m._revoked.length = 0;
  for (let i = 1; i <= 12; i++) m.musicUrlCacheSet('k' + i, 'blob:k' + i);
  m.musicUrlCacheSet('k1', 'blob:k1b'); // k1 pasa a ser la más reciente
  m.musicUrlCacheSet('k13', 'blob:k13');
  assert(!m.musicUrlCache.has('k2'), 'k2 (la más vieja no tocada) debe salir');
  assert(m.musicUrlCache.has('k1'), 'k1 (re-seteada) debe quedarse');
  eqJ(m._revoked.slice(-1), ['blob:k2'], 'revocada debe ser k2');
});

tcase('remove revoca la URL y elimina la clave', () => {
  const m = loadModule();
  m.musicUrlCache.clear(); m._revoked.length = 0;
  m.musicUrlCacheSet('tdel', 'blob:del');
  m.musicUrlCacheRemove('tdel');
  eqJ(m._revoked, ['blob:del'], 'remove debe revocar');
  assert(!m.musicUrlCache.has('tdel'), 'remove debe eliminar la clave');
});

tcase('remove de clave inexistente no crashea', () => {
  const m = loadModule();
  m.musicUrlCache.clear(); m._revoked.length = 0;
  m.musicUrlCacheRemove('no-existe');
  eqJ(m._revoked, [], 'no debe revocar nada');
});

tcase('set con args vacíos no crashea ni inserta', () => {
  const m = loadModule();
  m.musicUrlCache.clear();
  m.musicUrlCacheSet('', 'blob:x');
  m.musicUrlCacheSet('k', '');
  assert(m.musicUrlCache.size === 0, 'no debe insertar args vacíos');
});

// --- Integración con los call sites (asserts estáticos sobre el árbol) ---
tcase('musicGetAudioUrl usa musicUrlCacheSet (no .set directo)', () => {
  assert(html.indexOf('musicUrlCacheSet(trackId, url); // C99') >= 0, 'call site de cacheo sin parche');
  const rawSets = (html.match(/musicUrlCache\.set\(/g) || []).length;
  assert(rawSets === 1, 'solo el helper interno debe usar .set (hay ' + rawSets + ')');
});

tcase('musicDeleteTrack usa musicUrlCacheRemove (revoca, no olvida)', () => {
  assert(html.indexOf('musicUrlCacheRemove(trackId); // C99') >= 0, 'call site de borrado sin parche');
});

tcase('probe de duración revoca en onerror (C99-F2)', () => {
  assert(html.indexOf('probe.onerror = function () { try { URL.revokeObjectURL(probe.src);') >= 0,
    'onerror del probe no revoca (sin parche?)');
});

tcase('logout/cambio de cuenta sigue revocando todo el caché', () => {
  assert(html.indexOf('musicUrlCache.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} }); musicUrlCache.clear();') >= 0,
    'path de limpieza en cambio de cuenta ausente o modificado');
});

for (const [name, fn] of CASES) {
  try { fn(); oks++; }
  catch (e) { fails++; console.error('FAIL ' + name + ' :: ' + e.message); }
}
console.log('c99-object-urls: ' + oks + ' OK, ' + fails + ' FAIL');
process.exit(fails ? 1 : 0);
