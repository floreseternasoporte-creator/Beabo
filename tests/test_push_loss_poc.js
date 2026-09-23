#!/usr/bin/env node
/* test_push_loss_poc.js — PoC de la pérdida potencial del defecto
 * `await ref.push(valor)` (clase c del inventario).
 *
 * Usa la implementación REAL de Ref.prototype.push / pushAsync de
 * drex-cloud.js, con el transporte `set` sustituido por un stub controlable
 * (sin red). Compara:
 *   - patrón VIEJO (pre-migración):  await ref.push(msg)
 *   - patrón NUEVO (migrado):        await ref.pushAsync(msg)
 *
 * El test `propagaFalloEscritura` FALLA contra el patrón viejo (demuestra la
 * pérdida silenciosa) y PASA contra pushAsync (el fix).
 *
 * Layout: ../drex-cloud.js primero, fallback ../src/drex-cloud.js.
 * Uso: node tests/test_push_loss_poc.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

function resolveLib() {
  const cands = [path.join(__dirname, '..', 'drex-cloud.js'), path.join(__dirname, '..', 'src', 'drex-cloud.js')];
  for (const c of cands) { if (fs.existsSync(c)) return c; }
  console.error('FAIL: no se encontró drex-cloud.js');
  process.exit(2);
}

const lib = require(resolveLib());
const Ref = lib.__internals.Ref;
if (!Ref || typeof Ref.prototype.pushAsync !== 'function') {
  console.error('FAIL: no se pudo obtener Ref/pushAsync de drex-cloud.js');
  process.exit(2);
}

// --- Stub del transporte: set() controlable, sin red ---
let mode = 'ok-slow'; // 'ok-slow' | 'fail'
const origSet = Ref.prototype.set;
Ref.prototype.set = function (value) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (mode === 'fail') reject(new Error('boom: DynamoDB 500 (simulado)'));
      else resolve(null);
    }, mode === 'ok-slow' ? 200 : 20);
  });
};

// Silenciar el console.warn interno de push() ante fallo (ruido esperado).
const origWarn = console.warn;
console.warn = () => {};

async function main() {
  let failures = 0;
  const t = (name, fn) => Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch(e => { failures++; console.log(`  FALLA ${name}: ${e.message}`); });
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  // Patrón VIEJO (pre-migración, el defecto): tal cual estaba en ciclos <12.
  async function sendMessage_old(ref, msg) {
    await ref.push(msg); // push() devuelve un Ref, no una promesa
    return 'ok';
  }
  // Patrón NUEVO (migrado, estado actual del repo).
  async function sendMessage_new(ref, msg) {
    await ref.pushAsync(msg);
    return 'ok';
  }

  console.log('--- PoC 1: el await del patrón viejo NO espera la escritura ---');
  mode = 'ok-slow';
  await t('patrón viejo resuelve antes del flush (200ms de escritura)', async () => {
    const ref = new Ref(['poc', 'lento']);
    const t0 = Date.now();
    const res = await sendMessage_old(ref, { text: 'hola' });
    const dt = Date.now() - t0;
    assert(res === 'ok', 'debería resolver ok');
    assert(dt < 100, `resolvió en ${dt}ms, la escritura tarda 200ms: NO la esperó`);
    console.log(`       (resolvió en ${dt}ms con escritura pendiente de 200ms)`);
  });

  console.log('--- PoC 2: si la escritura falla, el patrón viejo la TRAGA ---');
  mode = 'fail';
  // Demostración before: el test que exige propagación FALLA con el patrón viejo.
  let oldPropagated = true;
  try {
    const res = await sendMessage_old(new Ref(['poc', 'fallo']), { text: 'se pierde' });
    oldPropagated = false; // llegó aquí = el error NO se propagó
    console.log(`  FALLA propagaFalloEscritura [patrón viejo]: resolvió "${res}" aunque la escritura falló`);
    console.log('       => PÉRDIDA DEMOSTRADA: el llamador creería "Enviado", el mensaje no existe.');
  } catch (e) {
    console.log(`  (inesperado: el patrón viejo rechazó: ${e.message})`);
  }
  assert(!oldPropagated, 'se esperaba que el patrón viejo tragara el error');

  console.log('--- PoC 3: pushAsync SÍ propaga el fallo (el fix) ---');
  await t('propagaFalloEscritura [pushAsync]: rechaza si la escritura falla', async () => {
    let rejected = null;
    try { await sendMessage_new(new Ref(['poc', 'fallo2']), { text: 'x' }); }
    catch (e) { rejected = e; }
    assert(rejected, 'pushAsync debería rechazar cuando set() falla');
    console.log(`       (rechazó con: ${rejected.message})`);
  });

  console.log('--- PoC 4: pushAsync SÍ espera la escritura real ---');
  mode = 'ok-slow';
  await t('pushAsync espera el flush (200ms)', async () => {
    const t0 = Date.now();
    const res = await sendMessage_new(new Ref(['poc', 'ok']), { text: 'hola' });
    const dt = Date.now() - t0;
    assert(res === 'ok', 'debería resolver ok');
    assert(dt >= 150, `resolvió en ${dt}ms: no esperó la escritura`);
    console.log(`       (resolvió en ${dt}ms, tras la escritura)`);
  });

  Ref.prototype.set = origSet;
  console.warn = origWarn;
  console.log(failures ? `\nRESULTADO: ${failures} fallo(s)` : '\nRESULTADO: PoC completa — el defecto pierde escrituras en silencio; pushAsync lo corrige.');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('ERROR', e); process.exit(2); });
