/* ================================================================
 * Barrido de seguridad 2026-11-12 (carril 1: paywall / Drex Plus).
 *
 * 1. `users/<uid>/adsFree` es una concesión de pago (sin anuncios) que
 *    solo debe escribir el servidor, igual que `orbit`/`plus`. Antes el
 *    guard de escritura de drex-cloud.js no la cubría: cualquier usuario
 *    autenticado podía ponérsela a sí mismo con
 *    DrexCloud.database().ref("users/"+uid+"/adsFree").set(true) y
 *    quedarse con no_ads sin pagar.
 * 2. `drexCompNoAds()` confiaba en localStorage
 *    ("drex_comp_noads_v1:<uid>" === "1") antes de que llegara la lectura
 *    de la BD: bastaba escribir esa clave en DevTools para que
 *    hasAccess("no_ads") devolviera true. Ahora solo vale lo que
 *    devuelve la BD (fail-closed mientras la lectura está pendiente).
 * 3. La puerta de encuestas largas (drexPollHoursForPublish) era
 *    fail-open ante un error interno (catch -> allowed=true); ahora es
 *    fail-closed como el resto de puertas.
 *
 * Ejecutar: node tests/test-sec-adsfree-guard.js
 * ================================================================ */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const cloud = fs.readFileSync(path.join(root, 'drex-cloud.js'), 'utf8');

let passed = 0;
const _tests = [];
function ok(name, fn) { _tests.push([name, fn]); }

/* ---------- 1. el guard de escritura cubre adsFree ---------- */
ok('isServerOnlyKey bloquea users/<uid>/adsFree (y sigue bloqueando orbit/plus)', () => {
  const m = cloud.match(/var SERVER_ONLY_PKS = \{[^}]*\};\n  function isServerOnlyKey\(pk, sk\) \{[\s\S]*?\n  \}/);
  assert(m, 'isServerOnlyKey no encontrado en drex-cloud.js');
  const isServerOnlyKey = new Function(m[0] + '; return isServerOnlyKey;')(); // eslint-disable-line no-new-func
  assert.strictEqual(isServerOnlyKey('users', 'abc123/adsFree'), true);
  assert.strictEqual(isServerOnlyKey('users', 'abc123/adsFree/x'), true);
  assert.strictEqual(isServerOnlyKey('users', 'abc123/orbit'), true);
  assert.strictEqual(isServerOnlyKey('users', 'abc123/plus'), true);
  assert.strictEqual(isServerOnlyKey('users', 'abc123/name'), false);
  assert.strictEqual(isServerOnlyKey('users', 'abc123/adsFree2'), false);
  assert.strictEqual(isServerOnlyKey('communityNotes', 'abc'), false);
});

/* ---------- 2. sin confianza en localStorage para no_ads ---------- */
ok('drexCompNoAdsCached no lee localStorage y el fetch no lo escribe', () => {
  const start = html.indexOf('function drexCompNoAdsCached');
  const end = html.indexOf('async function refreshPlusProfileBadge');
  assert(start > 0 && end > start, 'segmento drexCompNoAds no encontrado');
  const seg = html.slice(start, end);
  assert(!seg.includes('localStorage'), 'drexCompNoAds no debe tocar localStorage');
  assert(!html.includes('drex_comp_noads_v1'), 'no debe quedar la clave drex_comp_noads_v1');
});

ok('hasAccess("no_ads") sigue consultando la concesión de la BD', () => {
  assert(html.includes('typeof drexCompNoAds==="function"&&drexCompNoAds()'),
    'hasAccess debe seguir consultando drexCompNoAds()');
});

ok('una clave localStorage forjada no concede no_ads; la BD sí manda', async () => {
  const start = html.indexOf('var _drexCompNoAds=');
  const end = html.indexOf('async function refreshPlusProfileBadge');
  assert(start > 0 && end > start);
  const seg = html.slice(start, end);
  const store = { 'drex_comp_noads_v1:u1': '1' }; // clave forjada por el atacante
  const sandbox = {
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    window: {},
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'u1' } }),
      database: () => ({ ref: () => ({ once: () => Promise.resolve({ val: () => false }) }) }),
    },
  };
  const vm = require('vm');
  vm.createContext(sandbox);
  vm.runInContext(seg, sandbox);
  assert.strictEqual(vm.runInContext('drexCompNoAds()', sandbox), false,
    'con la lectura de BD pendiente, la clave forjada no debe conceder no_ads');
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(vm.runInContext('drexCompNoAds()', sandbox), false,
    'la BD dice false: no_ads sigue denegado aunque localStorage diga "1"');
});

/* ---------- 3. puerta de encuestas largas fail-closed ---------- */
ok('drexPollHoursForPublish es fail-closed ante error interno', () => {
  const i = html.indexOf('function drexPollHoursForPublish');
  assert(i > 0);
  const fn = html.slice(i, i + 600);
  assert(fn.includes('catch(_){allowed=false}'), 'el catch debe dejar allowed=false');
  assert(!fn.includes('catch(_){allowed=true}'), 'no debe quedar el fail-open allowed=true');
});

(async () => {
  for (const [name, fn] of _tests) { await fn(); passed++; console.log('ok - ' + name); }
  console.log(passed + ' checks OK');
})().catch(e => { console.error('FAIL:', e && e.message); process.exit(1); });
