'use strict';
// Tests de "Tendencias por onda" (Ondas v2) — Ciclo 94.
// Extrae el módulo ONDAS de index.html; --target permite correr contra la
// base (git show HEAD:index.html) para verificar que el test FALLA sin el
// parche. Uso: node tests/test-c94-ondas-tendencias.js [--target base.html]
process.chdir(__dirname + '/..');
const fs = require('fs');

let target = 'index.html';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) target = process.argv[++i];
}

const START = '// ===== ONDAS (Descubrimiento) v1 — inicio =====';
const END = '// ===== ONDAS (Descubrimiento) v1 — fin =====';
const html = fs.readFileSync(target, 'utf8');
const si = html.indexOf(START), ei = html.indexOf(END);
if (si < 0 || ei < 0 || ei <= si) {
  console.error('FAIL modulo ONDAS ausente en ' + target);
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
global.window = {};

const src = html.slice(si, ei);
let M = null, loadErr = null;
try {
  M = new Function(src + '\n;return { DREX_ONDA, ondaIndex, drexExtractOndas, drexOndaDay, ondaMergeI18n };')();
} catch (e) { loadErr = e; }
if (!M || loadErr) {
  console.error('FAIL carga del modulo ONDAS desde ' + target + ' :: ' + (loadErr && loadErr.message));
  process.exit(1);
}
const { DREX_ONDA, ondaIndex } = M;

let fails = 0, oks = 0;
const CASES = [];
function tcase(name, fn) { CASES.push([name, fn]); }
function assert(cond, label) {
  if (!cond) throw new Error('assert: ' + label);
}
function eqJ(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(label + ' esperado=' + e + ' actual=' + a);
}

const DAY = 86400000;
const NOW = 30 * DAY + 12 * 3600000; // día 30, mediodía (evita bordes)
const today = (h) => NOW - h * 3600000;
const yesterday = (h) => NOW - DAY - h * 3600000;
const daysAgo = (d, h) => NOW - d * DAY - (h || 1) * 3600000;

// T1: índice vacío -> sin tendencias.
tcase('T1 trending vacío = []', () => {
  ondaIndex._resetMemory();
  eqJ(ondaIndex.trending(NOW), [], 'trending vacío');
});

// T2: orden por velocidad (score = 2*d0 + d1); lo viejo no entra.
tcase('T2 orden por velocidad y exclusión de lo viejo', () => {
  ondaIndex._resetMemory();
  ondaIndex.feed([
    { id: 'a1', content: '#alpha', timestamp: today(1) },
    { id: 'a2', content: '#alpha', timestamp: today(2) },
    { id: 'a3', content: '#alpha', timestamp: today(3) },
    { id: 'b1', content: '#beta', timestamp: today(1) },
    { id: 'b2', content: '#beta', timestamp: yesterday(2) },
    { id: 'g1', content: '#gamma', timestamp: daysAgo(3) }
  ]);
  const tr = ondaIndex.trending(NOW);
  eqJ(tr.map(w => w.onda), ['alpha', 'beta'], 'orden alpha,beta');
  eqJ([tr[0].d0, tr[0].d1, tr[0].score], [3, 0, 6], 'alpha d0=3 score=6');
  eqJ([tr[1].d0, tr[1].d1, tr[1].score], [1, 1, 3], 'beta d0=1 d1=1 score=3');
  assert(!tr.some(w => w.onda === 'gamma'), 'gamma (3 días) excluida');
  assert(ondaIndex.has('gamma'), 'gamma sigue en la lista general');
});

// T3: umbral mínimo: 1 post en 48 h no es tendencia.
tcase('T3 umbral TREND_MIN_48H', () => {
  ondaIndex._resetMemory();
  ondaIndex.feed([{ id: 's1', content: '#solo', timestamp: today(1) }]);
  eqJ(ondaIndex.trending(NOW), [], '1 post no alcanza el umbral');
  eqJ(ondaIndex.list().map(w => w.onda), ['solo'], 'pero sí está en la lista');
});

// T4: desempates: score -> d0 -> count -> alfabético.
tcase('T4 desempates de trending', () => {
  ondaIndex._resetMemory();
  const posts = [];
  let k = 0;
  const add = (tag, d0n, d1n) => {
    for (let i = 0; i < d0n; i++) posts.push({ id: 't' + (k++), content: '#' + tag, timestamp: today(i + 1) });
    for (let i = 0; i < d1n; i++) posts.push({ id: 't' + (k++), content: '#' + tag, timestamp: yesterday(i + 1) });
  };
  add('xx', 1, 2);  // score 4, d0 1
  add('yy', 2, 0);  // score 4, d0 2 -> antes que xx
  ondaIndex.feed(posts);
  const ord = ondaIndex.trending(NOW).map(w => w.onda);
  eqJ(ord, ['yy', 'xx'], 'mismo score: mayor d0 primero');
});

// T4b: empate total en score/d0 -> mayor count, luego alfabético.
tcase('T4b empate score+d0: count y alfabético', () => {
  ondaIndex._resetMemory();
  const posts = [];
  let k = 0;
  // mm: 2 hoy + 3 viejos (count 5); nn: 2 hoy (count 2)
  for (let i = 0; i < 2; i++) posts.push({ id: 'u' + (k++), content: '#mm', timestamp: today(i + 1) });
  for (let i = 0; i < 3; i++) posts.push({ id: 'u' + (k++), content: '#mm', timestamp: daysAgo(5, i + 1) });
  for (let i = 0; i < 2; i++) posts.push({ id: 'u' + (k++), content: '#nn', timestamp: today(i + 1) });
  ondaIndex.feed(posts);
  const ord = ondaIndex.trending(NOW).map(w => w.onda);
  eqJ(ord, ['mm', 'nn'], 'mismo score+d0: mayor count primero');
});

// T5: tope TREND_TOP_N.
tcase('T5 tope de tendencias', () => {
  ondaIndex._resetMemory();
  const posts = [];
  for (let i = 0; i < 25; i++) {
    posts.push({ id: 'cap' + i + 'a', content: '#w' + i, timestamp: today(1) });
    posts.push({ id: 'cap' + i + 'b', content: '#w' + i, timestamp: today(2) });
  }
  ondaIndex.feed(posts);
  const tr = ondaIndex.trending(NOW);
  eqJ(tr.length, DREX_ONDA.TREND_TOP_N, 'tope 20');
});

// T6: nowMs inválido -> [].
tcase('T6 nowMs inválido', () => {
  ondaIndex._resetMemory();
  ondaIndex.feed([{ id: 'v1', content: '#vv', timestamp: today(1) }]);
  eqJ(ondaIndex.trending('NaN'), [], 'string NaN');
  eqJ(ondaIndex.trending(0), [], 'cero');
  eqJ(ondaIndex.trending(-5), [], 'negativo');
  eqJ(ondaIndex.trending(undefined), [], 'undefined');
});

// T7: persist/restore conserva las cubetas (roundtrip de trending).
tcase('T7 persist/restore conserva cubetas', () => {
  ondaIndex._resetMemory();
  ondaIndex.feed([
    { id: 'r1', content: '#rt', timestamp: today(1) },
    { id: 'r2', content: '#rt', timestamp: yesterday(2) }
  ]);
  const before = JSON.stringify(ondaIndex.trending(NOW));
  ondaIndex.persist(true);
  ondaIndex._resetMemory();
  assert(ondaIndex.restore() === true, 'restore true');
  eqJ(JSON.stringify(ondaIndex.trending(NOW)), before, 'trending idéntico tras restore');
});

// T8: migración v1 -> v2 (lista intacta, sin cubetas, clave vieja borrada).
tcase('T8 migración desde v1', () => {
  ondaIndex._resetMemory();
  global.localStorage = makeLS(); // sin clave v2: fuerza la ruta de migración
  const v1 = {
    v: 1, ts: Date.now(),
    waves: [['vieja', { count: 5, lastTs: today(1) }]]
  };
  global.localStorage.setItem(DREX_ONDA.V1_LS_KEY, JSON.stringify(v1));
  assert(ondaIndex.restore() === true, 'restore migra v1');
  eqJ(ondaIndex.list().map(w => w.onda), ['vieja'], 'lista migrada');
  eqJ(ondaIndex.list()[0].count, 5, 'count migrado');
  eqJ(ondaIndex.trending(NOW), [], 'sin cubetas: no entra a tendencias');
  assert(global.localStorage.getItem(DREX_ONDA.V1_LS_KEY) === null, 'clave v1 borrada');
  assert(global.localStorage.getItem(DREX_ONDA.LS_KEY) !== null, 'clave v2 escrita');
});

// T9: i18n local: las 5 claves nuevas llegan a EN/ZH/PT.
tcase('T9 merge i18n de tendencias', () => {
  const win = global.window;
  win.APP_ENGLISH_TEXT = {}; win.APP_CHINESE_TEXT = {}; win.APP_PORTUGUESE_TEXT = {};
  M.ondaMergeI18n();
  const keys = ['Tendencias', 'En alza', 'Sin tendencias todavía',
    'Las ondas con más actividad reciente aparecerán aquí.', '+{n} hoy'];
  keys.forEach(k => {
    assert(typeof win.APP_ENGLISH_TEXT[k] === 'string' && win.APP_ENGLISH_TEXT[k].length > 0, 'en:' + k);
    assert(typeof win.APP_CHINESE_TEXT[k] === 'string' && win.APP_CHINESE_TEXT[k].length > 0, 'zh:' + k);
    assert(typeof win.APP_PORTUGUESE_TEXT[k] === 'string' && win.APP_PORTUGUESE_TEXT[k].length > 0, 'pt:' + k);
  });
  eqJ(win.APP_ENGLISH_TEXT['Tendencias'], 'Trending', 'en Tendencias');
  eqJ(win.APP_PORTUGUESE_TEXT['Tendencias'], 'Tendências', 'pt Tendencias');
});

// T10: drexOndaDay: bordes.
tcase('T10 drexOndaDay bordes', () => {
  assert(M.drexOndaDay(NOW) === 30, 'día 30');
  assert(M.drexOndaDay(today(1)) === 30, 'hoy = día 30');
  assert(M.drexOndaDay(yesterday(1)) === 29, 'ayer = día 29');
  assert(M.drexOndaDay(-1) === -1, 'negativo -> -1');
  assert(M.drexOndaDay('NaN') === -1, 'string NaN -> -1');
  assert(M.drexOndaDay(null) === -1, 'null -> -1');
});

// T11: dedup por post id no duplica cubetas.
tcase('T11 dedup no duplica cubetas', () => {
  ondaIndex._resetMemory();
  ondaIndex.feed([{ id: 'd1', content: '#dup', timestamp: today(1) }]);
  ondaIndex.feed([{ id: 'd1', content: '#dup', timestamp: today(1) }]);
  const tr = ondaIndex.trending(NOW);
  eqJ(tr, [], '1 post único no alcanza umbral aunque se re-alimente');
  eqJ(ondaIndex.list()[0].count, 1, 'count sigue 1');
});

// T12: poda de cubetas a DAY_BUCKET_CAP.
tcase('T12 poda de cubetas a 8 días', () => {
  ondaIndex._resetMemory();
  const posts = [];
  for (let d = 0; d < 10; d++) posts.push({ id: 'p' + d, content: '#podada', timestamp: daysAgo(d) });
  ondaIndex.feed(posts);
  ondaIndex.persist(true);
  const raw = JSON.parse(global.localStorage.getItem(DREX_ONDA.LS_KEY));
  const rec = raw.waves.find(e => e[0] === 'podada')[1];
  assert(Object.keys(rec.d).length === DREX_ONDA.DAY_BUCKET_CAP, 'cubetas podadas a 8');
});

// T13: VERSION 2 y claves nuevas.
tcase('T13 versión y constantes v2', () => {
  eqJ(DREX_ONDA.VERSION, 2, 'VERSION 2');
  assert(DREX_ONDA.LS_KEY !== DREX_ONDA.V1_LS_KEY, 'clave nueva distinta');
  eqJ(typeof ondaIndex.trending, 'function', 'trending expuesto');
});

// Runner: cada caso aislado con try/catch (no crashea contra la base).
for (const [name, fn] of CASES) {
  try { fn(); oks++; console.log('OK   ' + name); }
  catch (e) { fails++; console.log('FAIL ' + name + ' :: ' + (e && e.message)); }
}

console.log(fails === 0 ? 'TODOS OK (' + oks + ')' : fails + ' FALLOS de ' + (oks + fails));
process.exit(fails === 0 ? 0 : 1);
