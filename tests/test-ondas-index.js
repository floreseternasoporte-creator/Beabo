'use strict';
// Tests de la lógica del índice de Ondas (ondaIndex) — Laboratorio de Funciones.
// Uso: node tests/test-ondas-index.js  (cwd = src/)
// Extrae el módulo ONDAS de ../index.html; si el parche no está aplicado,
// FALLA con salida distinta de cero (verificado contra la base).
process.chdir(__dirname + '/..');
const fs = require('fs');

const START = '// ===== ONDAS (Descubrimiento) v1 — inicio =====';
const END = '// ===== ONDAS (Descubrimiento) v1 — fin =====';
const html = fs.readFileSync('index.html', 'utf8');
const si = html.indexOf(START), ei = html.indexOf(END);
if (si < 0 || ei < 0 || ei <= si) {
  console.error('FAIL modulo ONDAS ausente en index.html: el parche no esta aplicado');
  process.exit(1);
}

function makeLS() {
  return {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); }
  };
}
global.localStorage = makeLS();

const src = html.slice(si, ei);
const M = new Function(src + '\n;return { DREX_ONDA, ondaIndex };')();
const { DREX_ONDA, ondaIndex } = M;

let fails = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const okc = a === e;
  console.log((okc ? 'OK   ' : 'FAIL ') + label + (okc ? '' : '  esperado=' + e + ' actual=' + a));
  if (!okc) fails++;
}
function ondas() { return ondaIndex.list().map(w => w.onda); }

ondaIndex._resetMemory();

// 1. feed básico: conteos y orden por actividad reciente (lastTs desc).
ondaIndex.feed([
  { id: 'p1', content: 'Hola #drex #beta', timestamp: 1000 },
  { id: 'p2', content: 'Otro #drex', timestamp: 2000 },
  { id: 'p3', content: 'Sin tags', timestamp: 3000 }
]);
eq(ondaIndex.size(), 2, 'size 2 ondas');
eq(ondas(), ['drex', 'beta'], 'orden por lastTs desc');
eq(ondaIndex.list().find(w => w.onda === 'drex').count, 2, 'count drex=2');
eq(ondaIndex.has('beta'), true, 'has(beta)');

// 2. Dedup por post id: el mismo post no cuenta dos veces (doble hook).
ondaIndex.feed([{ id: 'p1', content: 'Hola #drex #beta', timestamp: 1000 }]);
eq(ondaIndex.list().find(w => w.onda === 'drex').count, 2, 're-feed mismo id no duplica');
eq(ondaIndex.size(), 2, 'size sigue 2');

// 3. feedOne con noteId explícito (hook del feed en vivo).
ondaIndex.feedOne({ content: 'Nuevo #gamma', timestamp: 5000 }, 'p9');
eq(ondas()[0], 'gamma', 'feedOne registra con noteId');
ondaIndex.feedOne({ content: 'Nuevo #gamma', timestamp: 5000 }, 'p9');
eq(ondaIndex.list().find(w => w.onda === 'gamma').count, 1, 'feedOne dedup por noteId');

// 4. Post sin id igual se indexa (sin dedup posible).
ondaIndex.feed([{ content: '#suelta', timestamp: 10 }]);
eq(ondaIndex.has('suelta'), true, 'post sin id se indexa');

// 5. Desempate: mismo lastTs -> mayor count primero.
ondaIndex._resetMemory();
ondaIndex.feed([
  { id: 'a', content: '#uno', timestamp: 100 },
  { id: 'b', content: '#dos #dosx', timestamp: 100 },
  { id: 'c', content: '#dos', timestamp: 100 }
]);
eq(ondas(), ['dos', 'dosx', 'uno'], 'tie lastTs: count desc, luego alfabetico');

// 6. Persist/restore roundtrip.
ondaIndex.persist(true);
const snapA = JSON.stringify(ondaIndex.list());
ondaIndex._resetMemory();
eq(ondaIndex.size(), 0, 'reset vacia memoria');
eq(ondaIndex.restore(), true, 'restore con datos frescos');
eq(JSON.stringify(ondaIndex.list()), snapA, 'restore conserva lista');
eq(ondaIndex.size(), 3, 'size tras restore');

// 7. TTL expirado -> restore falso y vacío.
{
  const raw = JSON.parse(global.localStorage.getItem(DREX_ONDA.LS_KEY));
  raw.ts = Date.now() - DREX_ONDA.TTL_MS - 1000;
  global.localStorage.setItem(DREX_ONDA.LS_KEY, JSON.stringify(raw));
}
ondaIndex._resetMemory();
eq(ondaIndex.restore(), false, 'restore con TTL vencido = false');
eq(ondaIndex.size(), 0, 'indice vacio tras TTL vencido');

// 8. Versión distinta -> se ignora.
ondaIndex.feed([{ id: 'z', content: '#zeta', timestamp: 1 }]);
ondaIndex.persist(true);
{
  const raw = JSON.parse(global.localStorage.getItem(DREX_ONDA.LS_KEY));
  raw.v = 999;
  global.localStorage.setItem(DREX_ONDA.LS_KEY, JSON.stringify(raw));
}
ondaIndex._resetMemory();
eq(ondaIndex.restore(), false, 'version distinta se ignora');

// 9. clear() vacía memoria y borra la clave.
ondaIndex.feed([{ id: 'z', content: '#zeta', timestamp: 1 }]);
ondaIndex.persist(true);
ondaIndex.clear();
eq(ondaIndex.size(), 0, 'clear vacia');
eq(global.localStorage.getItem(DREX_ONDA.LS_KEY), null, 'clear borra LS');

// 10. feed con entradas inválidas no rompe.
eq(ondaIndex.feed(null), 0, 'feed(null)=0');
eq(ondaIndex.feed('x'), 0, 'feed(string)=0');
eq(ondaIndex.feed([null, undefined, {}]), 0, 'feed basura=0');
eq(ondaIndex.feedOne(null), 0, 'feedOne(null)=0');

console.log(fails === 0 ? 'TODOS OK' : fails + ' FALLOS');
process.exit(fails === 0 ? 0 : 1);
