'use strict';
// Tests de LA FILA (cola curada por el usuario) — Ciclo 84.
// Uso: node test-c84-lafila.js [--target <html>]
//   --target: HTML a probar (default: ../index.html, el parcheado).
// Diseñados para FALLAR contra la base sin parche (las funciones no existen).
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const target = (() => {
  const i = process.argv.indexOf('--target');
  return i >= 0 && process.argv[i + 1]
    ? path.resolve(process.argv[i + 1])
    : path.resolve(__dirname, '..', 'index.html');
})();

const html = fs.readFileSync(target, 'utf8');
const i18nSrc = fs.readFileSync(path.resolve(__dirname, '..', 'drex-i18n.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); console.error('FAIL:', name); }
}
function eq(a, b, name) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  ok(sa === sb, name + ' (esperado ' + sb + ', obtenido ' + sa + ')');
}

// ---- extracción verbatim del HTML ----
function extractFunction(src, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('función no encontrada en el HTML: ' + name);
  let i = src.indexOf('{', m.index);
  let depth = 0, inStr = null, esc = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error('llaves sin balancear: ' + name);
}

// ============================================================
// T1 — Núcleo puro extraído verbatim del HTML
// ============================================================
const sandbox = { console };
vm.createContext(sandbox);
try {
  const maxDecl = /var MUSIC_QUEUE_MAX = \d+;/.exec(html);
  if (!maxDecl) throw new Error('MUSIC_QUEUE_MAX no declarado en el HTML');
  const prelude = maxDecl[0] + '\n' +
    extractFunction(html, 'musicQueueCoreAdd') + '\n' +
    extractFunction(html, 'musicQueueCorePlayNext') + '\n' +
    extractFunction(html, 'musicQueueCoreRemove');
  vm.runInContext(prelude, sandbox, { filename: 'lafila-prelude.js' });
  ok(true, 'T1a núcleo (MUSIC_QUEUE_MAX + 3 cores) extraído y evalúa sin errores');
} catch (e) {
  ok(false, 'T1a núcleo extraído del HTML: ' + e.message);
}
function run(expr) { return vm.runInContext(expr, sandbox); }
const q = (...ids) => ids.map(id => ({ id }));

// ============================================================
// T2 — musicQueueCoreAdd
// ============================================================
try {
  let r = run('musicQueueCoreAdd([], -1, {id:"a"}, 200)');
  eq([r.queue.map(t => t.id), r.idx, r.result], [['a'], 0, 'playing'], 'T2a añadir a fila vacía → empieza a sonar');
  r = run('musicQueueCoreAdd(' + JSON.stringify(q('a')) + ', 0, {id:"b"}, 200)');
  eq([r.queue.map(t => t.id), r.idx, r.result], [['a', 'b'], 0, 'added'], 'T2b añadir al final conserva el índice actual');
  r = run('musicQueueCoreAdd(' + JSON.stringify(q('a', 'b', 'c')) + ', 0, {id:"b"}, 200)');
  eq([r.queue.map(t => t.id), r.idx, r.result], [['a', 'c', 'b'], 0, 'moved'], 'T2c duplicado se mueve al final sin duplicar');
  r = run('musicQueueCoreAdd(' + JSON.stringify(q('a', 'b', 'c')) + ', 2, {id:"a"}, 200)');
  eq([r.queue.map(t => t.id), r.idx, r.result], [['b', 'c', 'a'], 1, 'moved'], 'T2d mover desde antes del actual ajusta el índice');
  r = run('musicQueueCoreAdd(' + JSON.stringify(q('a', 'b')) + ', 1, {id:"b"}, 200)');
  eq([r.queue.map(t => t.id), r.idx, r.result], [['a', 'b'], 1, 'current'], 'T2e añadir la que suena → current (no reinicia)');
  r = run('musicQueueCoreAdd(' + JSON.stringify(q('a', 'b')) + ', 0, {id:"c"}, 2)');
  eq([r.queue.map(t => t.id), r.idx, r.result], [['a', 'b'], 0, 'full'], 'T2f fila llena (cap 200) → full sin cambios');
  r = run('musicQueueCoreAdd(' + JSON.stringify(q('a', 'b')) + ', 0, {id:"b"}, 2)');
  eq([r.queue.map(t => t.id), r.idx, r.result], [['a', 'b'], 0, 'moved'], 'T2g duplicado en fila llena sí se puede mover');
  r = run('musicQueueCoreAdd(' + JSON.stringify(q('a')) + ', 0, null, 200)');
  eq(r.result, 'invalid', 'T2h track nulo → invalid');
  r = run('musicQueueCoreAdd(' + JSON.stringify(q('a')) + ', 0, {}, 200)');
  eq(r.result, 'invalid', 'T2i track sin id → invalid');
  r = run('musicQueueCoreAdd(' + JSON.stringify(q('a')) + ', 9, {id:"b"}, 200)');
  eq([r.queue.map(t => t.id), r.idx, r.result], [['a', 'b'], 0, 'added'], 'T2j índice stale se fija al rango');
} catch (e) { ok(false, 'T2 musicQueueCoreAdd: ' + e.message); }

// ============================================================
// T3 — musicQueueCorePlayNext
// ============================================================
try {
  let r = run('musicQueueCorePlayNext([], -1, {id:"a"}, 200)');
  eq([r.queue.map(t => t.id), r.idx, r.result], [['a'], 0, 'playing'], 'T3a siguiente en fila vacía → empieza a sonar');
  r = run('musicQueueCorePlayNext(' + JSON.stringify(q('a', 'b')) + ', 0, {id:"c"}, 200)');
  eq([r.queue.map(t => t.id), r.idx, r.result], [['a', 'c', 'b'], 0, 'next'], 'T3b se inserta justo después de la actual');
  r = run('musicQueueCorePlayNext(' + JSON.stringify(q('a', 'b')) + ', 0, {id:"a"}, 200)');
  eq(r.result, 'current', 'T3c siguiente = la que suena → current');
  r = run('musicQueueCorePlayNext(' + JSON.stringify(q('a', 'b', 'c')) + ', 0, {id:"c"}, 200)');
  eq([r.queue.map(t => t.id), r.idx, r.result], [['a', 'c', 'b'], 0, 'moved-next'], 'T3d duplicado posterior se adelanta sin duplicar');
  r = run('musicQueueCorePlayNext(' + JSON.stringify(q('a', 'b', 'c')) + ', 2, {id:"a"}, 200)');
  eq([r.queue.map(t => t.id), r.idx, r.result], [['b', 'c', 'a'], 1, 'moved-next'], 'T3e mover desde antes del actual ajusta el índice');
  r = run('musicQueueCorePlayNext(' + JSON.stringify(q('a', 'b')) + ', 0, {id:"c"}, 2)');
  eq([r.queue.map(t => t.id), r.idx, r.result], [['a', 'b'], 0, 'full'], 'T3f fila llena → full sin cambios');
  r = run('musicQueueCorePlayNext(' + JSON.stringify(q('a')) + ', 0, null, 200)');
  eq(r.result, 'invalid', 'T3g track nulo → invalid');
} catch (e) { ok(false, 'T3 musicQueueCorePlayNext: ' + e.message); }

// ============================================================
// T4 — musicQueueCoreRemove
// ============================================================
try {
  let r = run('musicQueueCoreRemove(' + JSON.stringify(q('a', 'b', 'c')) + ', 0, 2)');
  eq([r.queue.map(t => t.id), r.idx, r.result], [['a', 'b'], 0, 'removed'], 'T4a quitar después de la actual');
  r = run('musicQueueCoreRemove(' + JSON.stringify(q('a', 'b', 'c')) + ', 2, 0)');
  eq([r.queue.map(t => t.id), r.idx, r.result], [['b', 'c'], 1, 'removed'], 'T4b quitar antes de la actual decrementa el índice');
  r = run('musicQueueCoreRemove(' + JSON.stringify(q('a', 'b', 'c')) + ', 1, 1)');
  eq(r.result, 'noop', 'T4c la actual nunca se quita');
  r = run('musicQueueCoreRemove(' + JSON.stringify(q('a')) + ', 0, 7)');
  eq(r.result, 'noop', 'T4d índice fuera de rango → noop');
  r = run('musicQueueCoreRemove(' + JSON.stringify(q('a', 'b')) + ', 1, 0)');
  eq([r.queue.map(t => t.id), r.idx, r.result], [['b'], 0, 'removed'], 'T4e quitar deja el índice dentro del rango');
} catch (e) { ok(false, 'T4 musicQueueCoreRemove: ' + e.message); }

// ============================================================
// T5 — Integración estática en el HTML
// ============================================================
ok(html.includes('id="music-sheet-queueblock"'), 'T5a bloque La fila en la hoja de playlist');
ok(html.includes('onclick="musicSheetQueueNext()"'), 'T5b botón Reproducir siguiente');
ok(html.includes('onclick="musicSheetQueueAdd()"'), 'T5c botón Añadir a la fila');
ok(/musicRemoveFromQueue\(\$\{i\}\)/.test(html), 'T5d filas de la cola con botón quitar');
ok(html.includes('>La fila <span id="music-queue-mix-label"'), 'T5e encabezado de la cola = "La fila" (vocabulario Drex)');
ok(!html.includes('A continuación <span id="music-queue-mix-label"'), 'T5f sin restos del encabezado viejo');
ok(html.includes('window.musicAddToQueue = function'), 'T5g wrapper musicAddToQueue expuesto');
ok(html.includes('window.musicPlayNext = function'), 'T5h wrapper musicPlayNext expuesto');
ok(html.includes('window.musicRemoveFromQueue = function'), 'T5i wrapper musicRemoveFromQueue expuesto');
ok(html.includes("appT('Quitar de la fila')"), 'T5j aria-label del botón quitar traducido');
ok(/var MUSIC_QUEUE_MAX = 200;/.test(html), 'T5k cap de la fila = 200');

// ============================================================
// T6 — i18n EN/ZH/PT en drex-i18n.js
// ============================================================
const FILA_KEYS = [
  'La fila',
  'Reproducir siguiente',
  'Añadir a la fila',
  'Quitar de la fila',
  'Añadida a la fila',
  'Sonará después de esta',
  'La fila está llena',
  'Ya está sonando'
];
function dictBlock(src, varName) {
  const i = src.indexOf('var ' + varName + ' = {');
  const j = src.indexOf('};', i);
  return src.slice(i, j);
}
['APP_ENGLISH_TEXT', 'APP_CHINESE_TEXT', 'APP_PORTUGUESE_TEXT'].forEach(vn => {
  const blk = dictBlock(i18nSrc, vn);
  FILA_KEYS.forEach(k => {
    ok(blk.includes('"' + k + '":"') || blk.includes('"' + k + '": "'), 'T6 ' + vn + ' tiene "' + k + '"');
  });
});
['APP_ENGLISH_TEXT', 'APP_CHINESE_TEXT', 'APP_PORTUGUESE_TEXT'].forEach(vn => {
  const blk = dictBlock(i18nSrc, vn);
  FILA_KEYS.forEach(k => {
    const n = blk.split('"' + k + '":').length - 1;
    ok(n === 1, 'T6dup ' + vn + ' "' + k + '" aparece exactamente 1 vez');
  });
});

console.log('\n==== test-c84-lafila: ' + pass + ' OK, ' + fail + ' FAIL ====');
if (failures.length) { console.log('Fallos:'); failures.forEach(f => console.log(' - ' + f)); }
process.exit(fail ? 1 : 0);
