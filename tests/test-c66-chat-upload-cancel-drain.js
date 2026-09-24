/* ================================================================
 * C66-F1: cancelar (o fallar) la subida de un adjunto no debe dejar
 * trozos huérfanos en chatFiles/<fileId>.
 *
 * Defecto (base, PoC): `_writeChatFileChunksLimited` rechazaba EN CUANTO
 * veía `entry.cancelled` (o el primer trozo fallido), con hasta
 * CHAT_FILE_UPLOAD_CONCURRENCY (2) escrituras `set()` aún en vuelo. El
 * `remove()` de limpieza que hace el llamador (`_uploadChatFileEntry`,
 * rama cancelled/failed) se emitía entonces en carrera contra esos
 * `set()`: si un trozo aterrizaba después del remove, quedaba huérfano
 * bajo `chatFiles/<fileId>` — esa subida nunca se referenció (sin
 * refcount: no hay mensaje que la apunte) y no hay TTL ni barrido que
 * lo limpie. Hasta 2 trozos × 300 KB por cancelación/fallo, acumulables.
 *
 * Fix: la promesa solo asienta cuando `inflight === 0` — al cancelar o
 * fallar se marca `stopErr` y se drenan las escrituras en vuelo antes de
 * rechazar, de modo que el `remove()` del llamador se emite siempre
 * DESPUÉS de que el último `set()` asentó. Los `set()` del SDK siempre
 * asientan (db-put-timeout), así que la espera está acotada. La ruta
 * normal (sin cancelación ni fallo) no cambia.
 *
 * Extrae la función REAL de ../index.html (sin rutas absolutas ni git).
 * Ejecutar con: node tests/test-c66-chat-upload-cancel-drain.js
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
const fnSrc = extractFn(HTML, '_writeChatFileChunksLimited');
const norm = fnSrc.replace(/\s+/g, ' ');
assert(/const CHAT_FILE_UPLOAD_CONCURRENCY = 2;/.test(HTML), 'concurrencia esperada: 2 en producción');

/* ---------- Checks estáticos sobre el código real ---------- */
if (BASELINE) {
  assert(/if \(entry\.cancelled\) \{ settled = true; reject\(new Error\('cancelled'\)\); return; \}/.test(norm),
    'PoC base: se esperaba el rechazo inmediato al cancelar');
  assert(norm.indexOf('stopErr') === -1 && norm.indexOf('inflight') === -1,
    'PoC base: se esperaba ausencia del drenaje de escrituras en vuelo');
  console.log('OK  estaticos (base): rechazo sin drenar — defecto presente');
} else {
  assert(/if \(entry\.cancelled\) \{ settled = true; reject\(new Error\('cancelled'\)\); return; \}/.test(norm) === false,
    'el rechazo inmediato al cancelar debe haber desaparecido');
  assert(/if \(!settled\) \{ settled = true; reject\(err\); \}/.test(norm) === false,
    'el rechazo inmediato al fallar un trozo debe haber desaparecido');
  assert(norm.indexOf('stopErr') !== -1, 'el fix debe marcar stopErr al cancelar/fallar');
  assert(/inflight\+\+/.test(norm) && /inflight--/.test(norm), 'el fix debe contar escrituras en vuelo');
  assert(/if \(inflight === 0\) \{ settled = true; reject\(stopErr\); \}/.test(norm),
    'el fix solo debe rechazar con cero escrituras en vuelo');
  console.log('OK  estaticos: drenaje de escrituras en vuelo antes de rechazar');
}

/* ---------- Escenarios funcionales con la función real en vm ---------- */
// Escrituras controladas: cada set() devuelve una promesa diferida que el
// test resuelve/rechaza a mano para simular el orden de red.
const writes = []; // {path, val, state, resolve, reject} — compartido con el sandbox
function fakeRef(path) {
  return {
    set(val) {
      let rec;
      const p = new Promise((res, rej) => {
        rec = {
          path, val, state: 'pending',
          resolve(v) { rec.state = 'ok'; res(v); },
          reject(e) { rec.state = 'err'; rej(e); }
        };
      });
      writes.push(rec);
      return p;
    }
  };
}
const sandbox = {
  console,
  DrexCloud: { database: () => ({ ref: p => fakeRef(p) }) },
  setTimeout, clearTimeout, Promise,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const PRELUDE = [
  'const CHAT_FILE_UPLOAD_CONCURRENCY = 2;',
  'let __renderCalls = 0;',
  'function _renderChatFileAttachments() { __renderCalls++; }',
  ''
].join('\n');
vm.runInContext(PRELUDE + fnSrc, sandbox, { filename: 'upload-under-test.js' });

const tick = () => new Promise(r => setImmediate(r));
const tick2 = async () => { await tick(); await tick(); };
const pendingWrites = () => writes.filter(w => w.state === 'pending');
const settledCount = () => writes.filter(w => w.state !== 'pending').length;
function resetWrites() { writes.length = 0; }

async function runUpload(entry, chunks) {
  sandbox.__entry = entry;
  sandbox.__chunks = chunks;
  const st = { rejected: null, resolved: false, settledAtEnd: -1 };
  const pr = vm.runInContext('_writeChatFileChunksLimited(__entry, __chunks)', sandbox);
  pr.then(
    () => { st.resolved = true; st.settledAtEnd = settledCount(); },
    e => { st.rejected = e; st.settledAtEnd = settledCount(); }
  );
  await tick();
  return st;
}

// S1: cancelación a mitad de subida con 2 escrituras en vuelo.
async function scenarioCancel() {
  resetWrites();
  const entry = { cancelled: false, fileId: 'cf_s1', progress: 0, uploaded: 0 };
  const st = await runUpload(entry, ['c0', 'c1', 'c2', 'c3']);
  assert.strictEqual(pendingWrites().length, 2, 'S1: 2 escrituras en vuelo al arrancar');
  writes[0].resolve(); await tick2(); // w0 ok -> arranca w2
  assert.strictEqual(pendingWrites().length, 2, 'S1: tras w0 siguen 2 en vuelo (w1,w2)');
  writes[1].resolve(); await tick2(); // w1 ok -> arranca w3
  assert.strictEqual(pendingWrites().length, 2, 'S1: tras w1 siguen 2 en vuelo (w2,w3)');
  entry.cancelled = true;
  writes[2].resolve(); await tick2(); // w2 ok; w3 aún en vuelo
  if (BASELINE) {
    assert(st.rejected && st.rejected.message === 'cancelled', 'PoC base: rechaza al cancelar');
    assert.strictEqual(pendingWrites().length, 1,
      'PoC base: w3 sigue en vuelo al rechazar -> el remove() del llamador pierde la carrera (trozos huérfanos)');
    console.log('PoC OK (base): rechaza sin drenar las escrituras en vuelo (defecto presente)');
    return;
  }
  assert.strictEqual(st.rejected, null, 'S1: no debe rechazar con escrituras en vuelo');
  assert.strictEqual(pendingWrites().length, 1, 'S1: w3 en drenaje');
  writes[3].resolve(); await tick2();
  assert(st.rejected && st.rejected.message === 'cancelled', 'S1: rechaza tras drenar');
  assert.strictEqual(st.settledAtEnd, 4, 'S1: las 4 escrituras asentaron antes del rechazo');
  console.log('OK  S1 cancelación: drena las escrituras en vuelo antes de rechazar');
}

// S2: un trozo falla con su hermano aún en vuelo (misma carrera en la rama failed).
async function scenarioError() {
  resetWrites();
  const entry = { cancelled: false, fileId: 'cf_s2', progress: 0, uploaded: 0 };
  const st = await runUpload(entry, ['c0', 'c1', 'c2', 'c3']);
  writes[0].reject(new Error('boom-s2')); await tick2();
  assert.strictEqual(st.rejected, null, 'S2: no debe rechazar con el hermano en vuelo');
  assert.strictEqual(pendingWrites().length, 1, 'S2: w1 en drenaje');
  writes[1].resolve(); await tick2();
  assert(st.rejected && st.rejected.message === 'boom-s2', 'S2: rechaza con el error original tras drenar');
  assert.strictEqual(st.settledAtEnd, 2, 'S2: ambas escrituras asentaron antes del rechazo');
  console.log('OK  S2 fallo de trozo: drena al hermano en vuelo antes de rechazar');
}

// S3: ruta normal intacta (sin cancelación ni fallo): resuelve con progreso 100.
async function scenarioHappy() {
  resetWrites();
  const entry = { cancelled: false, fileId: 'cf_s3', progress: 0, uploaded: 0 };
  const st = await runUpload(entry, ['a', 'b', 'c']);
  for (let k = 0; k < 10 && !st.resolved && !st.rejected; k++) {
    const pw = pendingWrites();
    if (!pw.length) break;
    pw[0].resolve(); await tick2();
  }
  assert(st.resolved, 'S3: la subida normal debe resolver');
  assert.strictEqual(entry.progress, 100, 'S3: progreso 100');
  assert.strictEqual(entry.uploaded, 3, 'S3: 3 trozos subidos');
  console.log('OK  S3 ruta normal intacta (resolve, progreso 100)');
}

// S4: un solo trozo cancelado en vuelo: también drena.
async function scenarioSingle() {
  resetWrites();
  const entry = { cancelled: false, fileId: 'cf_s4', progress: 0, uploaded: 0 };
  const st = await runUpload(entry, ['solo']);
  assert.strictEqual(pendingWrites().length, 1, 'S4: 1 escritura en vuelo');
  entry.cancelled = true;
  await tick2();
  assert.strictEqual(st.rejected, null, 'S4: espera al set() en vuelo');
  writes[0].resolve(); await tick2();
  assert(st.rejected && st.rejected.message === 'cancelled', 'S4: rechaza tras drenar');
  assert.strictEqual(st.settledAtEnd, 1, 'S4: el set() asentó antes del rechazo');
  console.log('OK  S4 un solo trozo: drena antes de rechazar');
}

async function main() {
  await scenarioCancel();
  if (BASELINE) return;
  await scenarioError();
  await scenarioHappy();
  await scenarioSingle();
}

main().then(
  () => console.log(BASELINE ? 'C66-F1 PoC: defecto confirmado en base' : 'C66-F1: 4/4 escenarios PASS'),
  err => { console.error('FAIL:', err.message); process.exit(1); }
);
