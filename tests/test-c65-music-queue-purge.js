/* ================================================================
 * C65-M1: borrar una canción debe purgarla de la cola de reproducción.
 *
 * Defecto (base, PoC): `deleteMusicTrack()` solo detenía el reproductor
 * si el track era el actual (`musicStopAndHide()` vacía la cola). Un track
 * eliminado que seguía en `musicQueue` en otra posición dejaba la cola
 * atascada: al avanzar, `musicStartTrack()` pintaba la UI con datos
 * obsoletos, registraba historial fantasma (`musicHistoryRecord` dentro de
 * `musicPaintTrackUI`) y el audio fallaba ("No se pudo cargar el audio."),
 * deteniendo el autoplay en el índice muerto.
 *
 * Fix: `_musicPurgeDeletedFromQueue(trackId)` — purga el track de
 * `musicQueue` y ajusta `musicQueueIdx` (decrementa si el borrado quedó
 * antes del índice actual; retrocede en crossfade en vuelo hacia el track
 * borrado para no saltar la siguiente canción; clamp si quedó fuera de
 * rango). `deleteMusicTrack` lo llama en la rama no-actual.
 *
 * Extrae la función REAL de ../index.html (sin rutas absolutas ni git).
 * Ejecutar con: node tests/test-c65-music-queue-purge.js
 * Con BASE_POC=1 se corre el PoC contra la base sin fix.
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Extracción por balanceo de llaves (respeta strings y comentarios).
function extractFn(src, name) {
  const m = new RegExp('(async\\s+)?function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('no encontrada: ' + name);
  let i = src.indexOf('{', m.index);
  const start = m.index;
  let depth = 0, str = null, tpl = 0, lineC = false, blockC = false, esc = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (lineC) { if (c === '\n') lineC = false; continue; }
    if (blockC) { if (c === '*' && n === '/') { blockC = false; i++; } continue; }
    if (str) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (str === '`' && c === '$' && n === '{') { tpl++; i++; continue; }
      if (c === str && tpl === 0) { str = null; continue; }
      if (str === '`' && c === '}' && tpl > 0) { tpl--; continue; }
      continue;
    }
    if (c === '/' && n === '/') { lineC = true; i++; continue; }
    if (c === '/' && n === '*') { blockC = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { str = c; tpl = 0; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('llaves sin cerrar: ' + name);
}

const BASELINE = process.env.BASE_POC === '1';

if (BASELINE) {
  // PoC: en la base no existe la purga -> el track eliminado permanece en
  // la cola y musicStartTrack lo alcanzaría (UI fantasma + autoplay muerto).
  assert(HTML.indexOf('_musicPurgeDeletedFromQueue') === -1,
    'PoC base: se esperaba ausencia de _musicPurgeDeletedFromQueue');
  assert(/if \(musicCurrentTrackId\(\) === trackId\) musicStopAndHide\(\);(?!\s*else)/.test(HTML),
    'PoC base: deleteMusicTrack no purga la rama no-actual');
  console.log('PoC OK (base): el track eliminado permanece en musicQueue (defecto presente)');
  process.exit(0);
}

/* ---------- Checks estáticos sobre el código real ---------- */
const purgeSrc = extractFn(HTML, '_musicPurgeDeletedFromQueue');
assert(/musicQueue\.splice\(qi, 1\)/.test(purgeSrc), 'la purga debe eliminar el track de musicQueue');
assert(/qi < musicQueueIdx/.test(purgeSrc), 'la purga debe ajustar el índice si el borrado quedó antes');
assert(/musicXfading/.test(purgeSrc), 'la purga debe contemplar el crossfade en vuelo');
assert(/renderMusicQueueList/.test(purgeSrc), 'la purga debe repintar la lista de la cola');
assert(/if \(musicCurrentTrackId\(\) === trackId\) musicStopAndHide\(\);\s*else _musicPurgeDeletedFromQueue\(trackId\);/.test(HTML),
  'deleteMusicTrack debe purgar en la rama no-actual');
assert(/musicCurrentTrackId\(\) === trackId\) musicStopAndHide\(\)/.test(HTML),
  'la rama del track actual sigue usando musicStopAndHide');
console.log('OK  estaticos: helper presente, deleteMusicTrack purga la rama no-actual');

/* ---------- Escenarios funcionales con la función real en vm ---------- */
const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const PRELUDE = [
  'let musicQueue = [];',
  'let musicQueueIdx = -1;',
  'var musicXfading = false;',
  'let __renderCalls = 0;',
  'function renderMusicQueueList() { __renderCalls++; }',
  ''
].join('\n');
vm.runInContext(PRELUDE + extractFn(HTML, '_musicPurgeDeletedFromQueue'), sandbox, { filename: 'purge-under-test.js' });

function scenario(name, queueIds, idx, xfading, purgeId, expIds, expIdx) {
  vm.runInContext(
    'musicQueue = ' + JSON.stringify(queueIds.map(id => ({ id }))) + ';' +
    'musicQueueIdx = ' + idx + ';' +
    'musicXfading = ' + (xfading ? 'true' : 'false') + ';' +
    '__renderCalls = 0;' +
    '_musicPurgeDeletedFromQueue(' + JSON.stringify(purgeId) + ');' +
    'globalThis.__ids = musicQueue.map(function (t) { return t.id; });' +
    'globalThis.__idx = musicQueueIdx;' +
    'globalThis.__rc = __renderCalls;',
    sandbox);
  assert.deepStrictEqual(Array.from(sandbox.__ids), expIds, name + ': ids de la cola');
  assert.strictEqual(sandbox.__idx, expIdx, name + ': musicQueueIdx');
  console.log('OK  ' + name + ' -> [' + Array.from(sandbox.__ids).join(',') + '] idx=' + sandbox.__idx);
}

// P1: borrado después del índice actual: el índice no se mueve.
scenario('P1 borrado tras el actual', ['a', 'x', 'b'], 0, false, 'x', ['a', 'b'], 0);
// P2: borrado antes del índice actual: el índice decrementa (sigue en 'b').
scenario('P2 borrado antes del actual', ['a', 'x', 'b'], 2, false, 'x', ['a', 'b'], 1);
// P3: único track, sin reproducción activa.
scenario('P3 cola de un track', ['x'], -1, false, 'x', [], -1);
// P4: crossfade en vuelo hacia el track borrado (idx ya avanzó a 'x'):
// retrocede para que musicNext llegue a 'b' sin saltarla.
scenario('P4 crossfade en vuelo', ['a', 'x', 'b'], 1, true, 'x', ['a', 'b'], 0);
// P5: track inexistente: no-op (ni siquiera repinta).
vm.runInContext(
  'musicQueue = [{id:"a"},{id:"b"}]; musicQueueIdx = 0; musicXfading = false; __renderCalls = 0;' +
  '_musicPurgeDeletedFromQueue("zzz");' +
  'globalThis.__ids = musicQueue.map(function (t) { return t.id; });' +
  'globalThis.__idx = musicQueueIdx; globalThis.__rc = __renderCalls;',
  sandbox);
assert.deepStrictEqual(Array.from(sandbox.__ids), ['a', 'b'], 'P5: cola intacta');
assert.strictEqual(sandbox.__idx, 0, 'P5: índice intacto');
assert.strictEqual(sandbox.__rc, 0, 'P5: sin repintado en no-op');
console.log('OK  P5 track inexistente -> no-op');
// P6: índice obsoleto fuera de rango: el clamp lo devuelve al último válido.
scenario('P6 clamp de indice obsoleto', ['a', 'x'], 7, false, 'a', ['x'], 0);

console.log('C65-M1: 6/6 escenarios PASS');
