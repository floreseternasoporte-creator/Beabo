/* ================================================================
 * Tests de regresión: gating premium de Destellos (Drex Orbit)
 * Bug 2026-09-29: un usuario SIN Orbit veía la bandeja de Destellos
 * completamente abierta (botón "Nuevo" + CTA) porque:
 *  (a) la bandeja se renderizaba ANTES de que DrexOrbit.refresh()
 *      verificara la suscripción contra el backend, y
 *  (b) drexOrbitApplyGates() no re-renderizaba la bandeja tras el
 *      refresh, y
 *  (c) nadie escuchaba el evento 'drex-orbit-change' (existía pero
 *      sin suscriptores: cosas "no vinculadas").
 * Fix: applyGates() re-renderiza la bandeja + listener de
 * 'drex-orbit-change' en el módulo de Destellos + reintento del
 * refresh si no logró verificar.
 * Verifica sin navegador. Ejecutar con: node tests/test-orbit-destellos-gating.js
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = process.env.ORBIT_TEST_ROOT || '/home/hatch/workspace/drex-orbit2';
var src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

/* ---- 1. applyGates re-renderiza la bandeja de Destellos ---- */
test('drexOrbitApplyGates re-renderiza la bandeja tras verificar', function () {
  var m = src.match(/drexOrbitApplyGates = function \(\) \{[\s\S]*?\n\};/);
  assert(m, 'drexOrbitApplyGates no encontrada en index.html');
  assert(m[0].indexOf('drexSnapLoadTray()') !== -1,
    'REGRESIÓN: applyGates ya no re-renderiza la bandeja (el bug del 2026-09-29)');
});

/* ---- 2. orbitPaywallCopy cubre las 12 funciones ---- */
test('orbitPaywallCopy cubre more_chars y priority_boost', function () {
  var m = src.match(/function orbitPaywallCopy\(feature\) \{[\s\S]*?\n\}/);
  assert(m, 'orbitPaywallCopy no encontrada');
  assert(m[0].indexOf('more_chars') !== -1, 'falta copy de more_chars');
  assert(m[0].indexOf('priority_boost') !== -1, 'falta copy de priority_boost');
});

/* ---- 3. Reintento del refresh tras login ---- */
test('tras login hay reintento si el refresh no verificó', function () {
  assert(src.indexOf('Reintento único') !== -1,
    'falta el reintento del refresh de Orbit tras login');
});

/* ---- Núcleo Orbit real evaluado en sandbox ---- */
var mCore = src.match(/\/\* =+\n \* DREX ORBIT — suscripción Orbit de Drex[\s\S]*?window\.DREX_ORBIT_ENFORCE = false;/);
assert(mCore, 'bloque core DrexOrbit no encontrado');
var sandbox = {
  console: console, setTimeout: function () { return 0; }, clearTimeout: function () {},
  localStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
  location: { origin: 'https://x.test' },
  document: { readyState: 'complete', addEventListener: function () {}, getElementById: function () { return null; } },
  window: {}, fetch: function () { return Promise.reject(new Error('no-network')); }
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
sandbox.t = function (s) { return s; };
sandbox.DrexCloud = { auth: function () { return { currentUser: null }; } };
vm.createContext(sandbox);
vm.runInContext(mCore[0], sandbox);
var K = sandbox.DrexOrbit;
assert(K, 'DrexOrbit no definido tras evaluar el core');

/* ---- Bloque C210 evaluado con stubs (estilo test-c215) ---- */
var m210 = src.match(/\/\/ ==================== C210 INSTANTÁNEAS ====================\n([\s\S]*?)\n\/\/ ================== FIN C210 INSTANTÁNEAS ==================/);
assert(m210, 'bloque C210 no encontrado');
var js210 = m210[1];

function fakeEl() {
  return {
    style: {}, dataset: {},
    classList: { toggle: function () {}, add: function () {}, remove: function () {}, contains: function () { return false; } },
    setAttribute: function () {}, getAttribute: function () { return null; },
    textContent: '', innerHTML: '', src: '', alt: '', value: undefined,
    querySelector: function () { return null; }, querySelectorAll: function () { return []; }, focus: function () {}
  };
}
var els = {};
function getEl(id) { return els[id] || (els[id] = fakeEl()); }
var listened = [];
var stubDoc = {
  readyState: 'complete', hidden: false, activeElement: null,
  body: { classList: { add: function () {}, remove: function () {} } },
  getElementById: getEl,
  addEventListener: function (ev) { listened.push(ev); },
  querySelector: function () { return null; }
};
var fakeDb = {
  ref: function () {
    return {
      once: function () { return Promise.resolve({ val: function () { return null; }, forEach: function () {} }); },
      orderByChild: function () { return this; }, limitToLast: function () { return this; }
    };
  }
};
var stubDrexCloud = {
  auth: function () { return { currentUser: { uid: 'u1' } }; },
  database: function () { return fakeDb; }
};
var C210 = new Function(
  'document', 'window', 'DrexCloud', 'DrexOrbit', 't', 'appT', 'escapeHtml',
  'showMiniToast', 'lockBodyScroll', 'unlockBodyScroll',
  'localStorage', 'setInterval',
  js210 + '\nreturn { drexSnapRenderTray: drexSnapRenderTray };'
)(
  stubDoc, {},
  stubDrexCloud, K,
  function (s) { return s; }, function (s) { return s; },
  function (s) { return String(s == null ? '' : s); },
  function () {}, function () {}, function () {},
  { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
  function () { return 0; }
);

function rowHTML() { return getEl('drex-snap-row').innerHTML || ''; }

/* ---- 4. El módulo escucha drex-orbit-change ---- */
test("Destellos escucha 'drex-orbit-change' (vinculación)", function () {
  assert(listened.indexOf('drex-orbit-change') !== -1,
    "REGRESIÓN: nadie escucha 'drex-orbit-change' (cosas no vinculadas)");
});

/* ---- 5. No-miembro + enforcement ON -> tarjeta de desbloqueo ---- */
test('no-miembro con enforcement: bandeja muestra tarjeta Orbit (no el botón Nuevo)', function () {
  K._serverConfigured = true;
  K._setTestState({ active: false, plan: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, status: 'none' });
  assert(K.enforced() === true, 'precondición: enforced() debe ser true');
  assert(K.isActive() === false, 'precondición: isActive() debe ser false');
  getEl('drex-snap-row').innerHTML = '';
  C210.drexSnapRenderTray([], {}, Date.now());
  var html = rowHTML();
  assert(html.indexOf('drex-snap-locked') !== -1, 'falta la tarjeta de desbloqueo Orbit');
  assert(html.indexOf('drex-snap-new') === -1, 'el botón "Nuevo" NO debe aparecer para no-miembros');
  assert(html.indexOf('openOrbitView()') !== -1, 'la tarjeta debe abrir la vista Orbit');
});

/* ---- 6. Miembro activo -> bandeja normal ---- */
test('miembro Orbit activo: bandeja normal con botón Nuevo', function () {
  K._serverConfigured = true;
  K._setTestState({ active: true, plan: 'monthly', currentPeriodEnd: 9999999999, cancelAtPeriodEnd: false, status: 'active' });
  assert(K.isActive() === true, 'precondición: isActive() debe ser true');
  getEl('drex-snap-row').innerHTML = '';
  C210.drexSnapRenderTray([], {}, Date.now());
  var html = rowHTML();
  assert(html.indexOf('drex-snap-locked') === -1, 'la tarjeta de bloqueo NO debe aparecer para miembros');
  assert(html.indexOf('drex-snap-new') !== -1, 'el botón "Nuevo" debe aparecer para miembros');
});

/* ---- 7. Sin backend configurado -> diseño documentado (bandeja normal) ---- */
test('sin backend Orbit configurado: bandeja normal (diseño fail-open documentado)', function () {
  K._serverConfigured = false;
  K._setTestState(null);
  assert(K.enforced() === false, 'precondición: enforced() debe ser false sin backend');
  getEl('drex-snap-row').innerHTML = '';
  C210.drexSnapRenderTray([], {}, Date.now());
  var html = rowHTML();
  assert(html.indexOf('drex-snap-new') !== -1, 'sin backend configurado la bandeja sigue operativa');
});

console.log('\nRESULTADO ORBIT-DESTELLOS-GATING: ' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
