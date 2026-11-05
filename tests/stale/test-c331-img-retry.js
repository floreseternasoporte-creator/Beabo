// test-c331-img-retry.js — imágenes fiables: timeout + reintento con backoff
// Verifica drexReadWithRetry (extraído de index.html):
//  1. éxito al primer intento -> resuelve con 1 sola llamada
//  2. falla 2 veces y luego OK -> resuelve tras 3 llamadas, con backoff entre intentos
//  3. falla siempre -> rechaza tras (retries+1) llamadas
//  4. lectura colgada más allá del timeout -> se trata como fallo y reintenta
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const s = html.indexOf('const DREX_IMG_READ_TIMEOUT_MS');
assert(s >= 0, 'marcador DREX_IMG_READ_TIMEOUT_MS no encontrado');
const e = html.indexOf('\n  function loadNoteImages(noteId) {', s);
assert(e >= 0, 'fin del bloque no encontrado');
const src = html.slice(s, e);

const sandbox = { setTimeout, clearTimeout, Promise };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const read = sandbox.drexReadWithRetry;
assert(typeof read === 'function', 'drexReadWithRetry no quedó definida');

const T = { timeoutMs: 60, retries: 3, backoffMs: [20, 40] };

(async () => {
  // 1. éxito inmediato
  let calls = 0;
  const r1 = await read(() => { calls++; return Promise.resolve('ok'); }, T);
  assert.strictEqual(r1, 'ok');
  assert.strictEqual(calls, 1, 'debió llamar una sola vez');

  // 2. dos fallos y luego éxito: 3 llamadas y backoff aplicado (>= 20+40 ms)
  calls = 0;
  const t0 = Date.now();
  const r2 = await read(() => { calls++; return calls < 3 ? Promise.reject(new Error('net')) : Promise.resolve('late-ok'); }, T);
  const dt = Date.now() - t0;
  assert.strictEqual(r2, 'late-ok');
  assert.strictEqual(calls, 3, 'debió intentar 3 veces');
  assert(dt >= 55, 'el backoff no se aplicó (dt=' + dt + 'ms)');

  // 3. fallo permanente: rechaza tras 4 llamadas (1 + 3 reintentos)
  calls = 0;
  let rejected = false;
  try { await read(() => { calls++; return Promise.reject(new Error('down')); }, T); }
  catch (err) { rejected = true; assert.strictEqual(err.message, 'down'); }
  assert(rejected, 'debió rechazar');
  assert.strictEqual(calls, 4, 'debió intentar 1+3 veces, fueron ' + calls);

  // 4. promesa colgada: el timeout la convierte en fallo y reintenta
  calls = 0;
  const t1 = Date.now();
  const r4 = await read(() => { calls++; return calls < 2 ? new Promise(() => {}) : Promise.resolve('woke'); }, T);
  const dt2 = Date.now() - t1;
  assert.strictEqual(r4, 'woke');
  assert.strictEqual(calls, 2);
  assert(dt2 >= 60, 'el timeout no disparó (dt=' + dt2 + 'ms)');

  console.log('test-c331-img-retry OK: timeout + backoff + reintentos verificados');
})().catch(err => { console.error('FALLO:', err); process.exit(1); });
