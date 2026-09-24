'use strict';
// Tests de cotas en cachés Map — Ciclo 100.
// C100-F1: _drexUpvoteActivatedAt (ventana de doble toque, 600 ms) sin poda:
//          cada post votado dejaba una entrada muerta para siempre (sin clear
//          ni en cambio de cuenta). Fix: borrado de la entrada caducada en la
//          lectura + _drexUpvoteActivatedSet con tope 500 y barrido de muertas.
// C100-F2: _commentersCache/_commentersLoaded sin tope ni limpieza: ~1 KB de
//          HTML por post hidratado, sin clear en cambio de cuenta. Fix:
//          _commentersCacheSet con tope 300, desalojo por ts más vieja
//          (las dos estructuras se podan juntas).
// Extrae los módulos de index.html; --target permite correr contra la base
// (git show HEAD:index.html) para verificar que el test FALLA sin el parche.
// Uso: node tests/test-c100-map-caps.js [--target base.html]
process.chdir(__dirname + '/..');
const fs = require('fs');

let target = 'index.html';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) target = process.argv[++i];
}

const html = fs.readFileSync(target, 'utf8');

// --- Módulo F1 (entre la declaración del Map y el bloque siguiente) ---
const F1_START = 'const _drexUpvoteActivatedAt = new Map();';
const F1_END = '// REINTENTO AUTOMÁTICO';
const f1i = html.indexOf(F1_START), f1e = html.indexOf(F1_END);
const f1src = (f1i >= 0 && f1e > f1i) ? html.slice(f1i, f1e) : null;

// --- Lectura con autolimpieza (verbatim, envuelta en función) ---
const RD_START = '// C100: autolimpieza';
const RD_END = "if (voteType === 'up' && wasUpvoted &&";
const rdi = html.indexOf(RD_START), rde = html.indexOf(RD_END);
const rdsrc = (rdi >= 0 && rde > rdi) ? html.slice(rdi, rde) : null;

// --- Módulo F2 ---
const F2_START = 'const _commentersLoaded = new Set();';
const F2_END = 'let _commentersIO = null;';
const f2i = html.indexOf(F2_START), f2e = html.indexOf(F2_END);
const f2src = (f2i >= 0 && f2e > f2i) ? html.slice(f2i, f2e) : null;

let fails = 0, oks = 0;
const CASES = [];
function tcase(name, fn) { CASES.push([name, fn]); }
function assert(cond, label) { if (!cond) throw new Error('assert: ' + label); }

// --- F1: extracción ---
tcase('F1 extracción del módulo _drexUpvoteActivatedAt', () => {
  assert(f1src, 'bloque F1 ausente en ' + target);
  assert(f1src.indexOf('function _drexUpvoteActivatedSet(') >= 0, '_drexUpvoteActivatedSet ausente (sin parche?)');
  assert(f1src.indexOf('DREX_UPVOTE_ACTIVATED_CAP') >= 0, 'cota ausente (sin parche?)');
});

let M1 = null;
function loadF1() {
  if (M1) return M1;
  assert(f1src, 'sin bloque F1 que cargar');
  const body = f1src + '\n;return { _drexUpvoteActivatedAt, _drexUpvoteActivatedSet, DREX_UPVOTE_DOUBLE_TAP_MS, DREX_UPVOTE_ACTIVATED_CAP };';
  M1 = new Function(body)();
  return M1;
}

tcase('F1 set/get roundtrip y cota = 500', () => {
  const m = loadF1();
  m._drexUpvoteActivatedAt.clear();
  m._drexUpvoteActivatedSet('p1');
  assert(typeof m._drexUpvoteActivatedAt.get('p1') === 'number', 'get no devuelve timestamp');
  assert(m.DREX_UPVOTE_ACTIVATED_CAP === 500, 'la cota debe ser 500');
});

tcase('F1 el tope desaloja las más antiguas por inserción', () => {
  const m = loadF1();
  m._drexUpvoteActivatedAt.clear();
  for (let i = 0; i < 505; i++) m._drexUpvoteActivatedSet('k' + i);
  assert(m._drexUpvoteActivatedAt.size <= 500, 'size=' + m._drexUpvoteActivatedAt.size + ' excede el tope');
  assert(!m._drexUpvoteActivatedAt.has('k0'), 'k0 (la más vieja) debió ser desalojada');
  assert(m._drexUpvoteActivatedAt.has('k504'), 'k504 (la más nueva) debe sobrevivir');
});

tcase('F1 el barrido elimina primero las entradas muertas (>600 ms)', () => {
  const m = loadF1();
  m._drexUpvoteActivatedAt.clear();
  // 500 entradas muertas + 5 vivas: al insertar la 506 el barrido debe
  // limpiar las muertas y quedar solo con las vivas.
  const old = Date.now() - 60000;
  for (let i = 0; i < 500; i++) m._drexUpvoteActivatedAt.set('dead' + i, old);
  for (let i = 0; i < 5; i++) m._drexUpvoteActivatedSet('live' + i);
  assert(m._drexUpvoteActivatedAt.size === 5, 'size=' + m._drexUpvoteActivatedAt.size + ', esperado 5');
  assert(!m._drexUpvoteActivatedAt.has('dead0'), 'las muertas debieron barrerse');
  assert(m._drexUpvoteActivatedAt.has('live4'), 'las vivas deben sobrevivir');
});

tcase('F1 la lectura borra la entrada caducada (verbatim del núcleo)', () => {
  assert(rdsrc, 'bloque de lectura C100 ausente en ' + target);
  const m = loadF1();
  m._drexUpvoteActivatedAt.clear();
  const readFn = new Function('noteId', '_drexUpvoteActivatedAt', 'DREX_UPVOTE_DOUBLE_TAP_MS', rdsrc);
  m._drexUpvoteActivatedAt.set('stale', Date.now() - 60000);
  readFn('stale', m._drexUpvoteActivatedAt, m.DREX_UPVOTE_DOUBLE_TAP_MS);
  assert(!m._drexUpvoteActivatedAt.has('stale'), 'la entrada caducada debió borrarse en la lectura');
  m._drexUpvoteActivatedAt.set('fresh', Date.now());
  readFn('fresh', m._drexUpvoteActivatedAt, m.DREX_UPVOTE_DOUBLE_TAP_MS);
  assert(m._drexUpvoteActivatedAt.has('fresh'), 'la entrada viva (<600 ms) NO debe borrarse');
});

tcase('F1 call sites: el set directo quedó reemplazado por el helper', () => {
  assert(html.indexOf('_drexUpvoteActivatedSet(noteId)') >= 0, 'call site de escritura ausente');
  // El único .set directo permitido es el que vive DENTRO del helper.
  const n = html.split('_drexUpvoteActivatedAt.set(noteId, Date.now())').length - 1;
  assert(n === 1, 'hay ' + n + ' sets directos; solo el del helper es válido');
  assert(rdsrc !== null, 'bloque de autolimpieza en lectura ausente');
});

// --- F2: extracción ---
tcase('F2 extracción del módulo _commentersCache', () => {
  assert(f2src, 'bloque F2 ausente en ' + target);
  assert(f2src.indexOf('function _commentersCacheSet(') >= 0, '_commentersCacheSet ausente (sin parche?)');
  assert(f2src.indexOf('DREX_COMMENTERS_CACHE_CAP') >= 0, 'cota ausente (sin parche?)');
});

let M2 = null;
function loadF2() {
  if (M2) return M2;
  assert(f2src, 'sin bloque F2 que cargar');
  const body = f2src + '\n;return { _commentersCache, _commentersLoaded, _commentersCacheSet, DREX_COMMENTERS_CACHE_CAP };';
  M2 = new Function(body)();
  return M2;
}

tcase('F2 set/get roundtrip y cota = 300', () => {
  const m = loadF2();
  m._commentersCache.clear(); m._commentersLoaded.clear();
  m._commentersCacheSet('n1', '<b>html</b>');
  const rec = m._commentersCache.get('n1');
  assert(rec && rec.html === '<b>html</b>' && typeof rec.ts === 'number', 'get no devuelve {html, ts}');
  assert(m.DREX_COMMENTERS_CACHE_CAP === 300, 'la cota debe ser 300');
});

tcase('F2 el tope desaloja las de ts más vieja y poda el Set en sync', () => {
  const m = loadF2();
  m._commentersCache.clear(); m._commentersLoaded.clear();
  for (let i = 0; i < 305; i++) {
    m._commentersCacheSet('p' + i, 'h' + i);
    m._commentersLoaded.add('p' + i);
  }
  assert(m._commentersCache.size <= 300, 'size=' + m._commentersCache.size + ' excede el tope');
  assert(!m._commentersCache.has('p0'), 'p0 (ts más vieja) debió ser desalojada');
  assert(!m._commentersLoaded.has('p0'), '_commentersLoaded debe podarse en sync');
  assert(m._commentersCache.has('p304'), 'p304 (la más nueva) debe sobrevivir');
});

tcase('F2 re-set de la misma clave no crece ni duplica', () => {
  const m = loadF2();
  m._commentersCache.clear(); m._commentersLoaded.clear();
  m._commentersCacheSet('n1', 'h1');
  m._commentersCacheSet('n1', 'h2');
  assert(m._commentersCache.size === 1, 'la clave no debe duplicarse');
  assert(m._commentersCache.get('n1').html === 'h2', 'debe quedar el html nuevo');
});

tcase('F2 call sites: el set directo quedó reemplazado por el helper', () => {
  assert(html.indexOf('_commentersCacheSet(noteId, el.innerHTML)') >= 0, 'call site de escritura ausente');
  // El único .set directo permitido es el que vive DENTRO del helper.
  const n = html.split('_commentersCache.set(noteId, { html:').length - 1;
  assert(n === 1, 'hay ' + n + ' sets directos; solo el del helper es válido');
});

for (const [name, fn] of CASES) {
  try { fn(); oks++; }
  catch (e) { fails++; console.log('FAIL ' + name + ' :: ' + (e && e.message)); }
}
console.log('c100-map-caps: ' + oks + ' OK, ' + fails + ' FAIL');
process.exit(fails ? 1 : 0);
