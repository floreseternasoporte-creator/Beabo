/* Prueba de regresión: reparación Drex Orbit (auditoría 2026-10-01).
 *
 * Historia: el commit 1fb41da ("auto-limpieza de lives") borró la sección
 * Pagos completa, rompió el enforcement dinámico (_serverConfigured),
 * devolvió las llamadas a application/json (preflight que falla en iOS),
 * eliminó DrexOrbit.reset() y los taps de beneficios. Este test fija el
 * estado reparado para que ninguna "limpieza" futura lo vuelva a romper.
 *
 * Uso: node tests/test-orbit-repair.js   (código 0 = todo OK)
 */
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var ROOT = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var src404 = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

/* --- 1. Sección Pagos restaurada --- */
test('existe #payments-view con su contenido', function () {
  assert(src.indexOf('id="payments-view"') !== -1, 'falta #payments-view');
  assert(src.indexOf('id="payments-view-content"') !== -1, 'falta #payments-view-content');
  assert(src.indexOf('onclick="closePaymentsView()"') !== -1, 'falta botón cerrar');
});
test('existe #pagos-settings-card en Ajustes', function () {
  assert(src.indexOf('id="pagos-settings-card"') !== -1, 'falta la tarjeta');
  assert(src.indexOf('onclick="openPaymentsView()"') !== -1, 'la tarjeta no abre la vista');
});
test('funciones de Pagos definidas', function () {
  ['openPaymentsView', 'closePaymentsView', 'renderPaymentsView',
   'renderPagosSettingsPreview', 'orbitTxStatusLabel', 'orbitTxAmount'
  ].forEach(function (f) {
    assert(new RegExp('function ' + f + '\\(').test(src), 'falta function ' + f);
  });
});
test('el hook de idioma/gates refresca el subtítulo de Pagos', function () {
  assert(src.indexOf("typeof renderPagosSettingsPreview === 'function'") !== -1,
    'drexOrbitApplyGates no refresca Pagos');
});
test('DrexOrbit.transactions() existe y usa la red endurecida', function () {
  var i = src.indexOf('transactions: async function');
  assert(i !== -1, 'falta DrexOrbit.transactions');
  var seg = src.slice(i, i + 600);
  assert(seg.indexOf('/transactions') !== -1, 'no llama a /transactions');
  assert(seg.indexOf("this._post('/transactions'") !== -1,
    'transactions no pasa por _post (text/plain, timeout, reintentos)');
});

/* --- 2. Enforcement dinámico + reset --- */
test('enforced() lee _serverConfigured (no solo el flag manual)', function () {
  var i = src.indexOf('enforced: function');
  assert(i !== -1, 'falta enforced');
  assert(src.slice(i, i + 200).indexOf('_serverConfigured') !== -1,
    'enforced no considera _serverConfigured');
});
test('refresh() guarda data.configured en _serverConfigured', function () {
  assert(src.indexOf('self._serverConfigured = (data.configured === true)') !== -1,
    'refresh no lee data.configured');
  assert(src.indexOf('self._st = fail; self._serverConfigured = false') !== -1,
    'refresh no limpia _serverConfigured en fallo');
});
test('DrexOrbit.reset() existe y se usa al cambiar de cuenta', function () {
  assert(/reset: function \(\) \{/.test(src), 'falta DrexOrbit.reset');
  assert(src.indexOf('DrexOrbit.reset()') !== -1, 'reset nunca se llama');
  assert(src.indexOf('clearAccountScopedState') !== -1, 'falta clearAccountScopedState');
  var i = src.indexOf('function clearAccountScopedState()');
  assert(src.slice(i, i + 400).indexOf('DrexOrbit.reset()') !== -1,
    'clearAccountScopedState no llama a reset');
});

/* --- 3. Red endurecida --- */
test('las llamadas Orbit pasan por _post/_postData (text/plain, timeout, reintentos)', function () {
  var i = src.indexOf('_post: async function');
  assert(i !== -1, 'falta DrexOrbit._post');
  var seg = src.slice(i, i + 2200);
  assert(seg.indexOf('text/plain;charset=UTF-8') !== -1, '_post no usa text/plain');
  assert(seg.indexOf('AbortController') !== -1, '_post no tiene timeout');
  assert(seg.indexOf('BACKOFF_MS') !== -1, '_post no tiene reintentos');
  /* C247 (2026-10-03): /create-subscription-session y /create-customer-portal
   * (redirect LEGADO) retirados con DrexOrbit.subscribe/manage; el contrato
   * vivo es el embebido de C244 (forEach de _postData más abajo). */
  ['/subscription-status', '/transactions'].forEach(function (p) {
    assert(src.indexOf("this._post('" + p + "'") !== -1 && src.indexOf('self._post(\'' + p + '\'') !== -1 ||
           src.indexOf("_post('" + p + "'") !== -1, 'llamada a ' + p + ' no usa _post');
  });
  ['/subscribe-embedded', '/subscription-cancel',
   '/subscription-reactivate', '/subscription-setup'].forEach(function (p) {
    assert(src.indexOf("_postData('" + p + "'") !== -1, 'llamada a ' + p + ' no usa _postData');
  });
});
test('ninguna llamada Orbit usa application/json', function () {
  var i = src.indexOf('var DrexOrbit = {');
  var j = src.indexOf('/* Enforcement:', i);
  var seg = src.slice(i, j);
  assert(seg.indexOf('application/json') === -1, 'queda application/json en DrexOrbit');
});

/* --- 4. Beneficios tocables --- */
test('orbitBenefitTap existe y las filas son botones', function () {
  assert(/function orbitBenefitTap\(feature\)/.test(src), 'falta orbitBenefitTap');
  var taps = (src.match(/onclick="orbitBenefitTap\(\\''/g) || []).length;
  /* C243: las listas comparten el helper orbitBenefitsListHTML() (una sola
   * fuente de filas-boton); se exige el tap en el helper y su uso en la vista. */
  assert(taps >= 1, 'las filas de beneficios no tienen tap (encontrados: ' + taps + ')');
  assert(src.indexOf('orbitBenefitsListHTML()') !== -1, 'la vista no usa el helper de beneficios');
});

/* --- 5. Planes (escalera completa: 7 planes desde 2026-10-01) --- */
test('se aceptan los 7 planes (cliente = servidor)', function () {
  assert(src.indexOf("ORBIT_PLAN_IDS = ['weekly', 'monthly', 'quarterly', 'semiannual', 'yearly', 'biennial', 'lifetime']") !== -1,
    'faltan planes en ORBIT_PLAN_IDS');
  assert(src.indexOf('Trimestral') !== -1 && src.indexOf('Semestral') !== -1,
    'faltan nombres de planes trimestral/semestral');
  assert(src.indexOf("t('De por vida')") !== -1 && src.indexOf("t('Semanal')") !== -1,
    'faltan nombres de planes semanal/de por vida');
});

/* --- 6. Timeouts y retorno --- */
test('renderOrbitView tiene timeout (no pantalla en blanco)', function () {
  var i = src.indexOf('async function renderOrbitView');
  assert(src.slice(i, i + 600).indexOf('Promise.race') !== -1, 'falta Promise.race en renderOrbitView');
});
test('captureOrbitReturn re-verifica solo y no borra toda la query', function () {
  var i = src.indexOf('function captureOrbitReturn');
  var seg = src.slice(i, i + 2200);
  assert(seg.indexOf('8000') !== -1 && seg.indexOf('45000') !== -1, 'falta re-poll del retorno');
  assert(seg.indexOf("searchParams.delete('orbit')") !== -1, 'sigue borrando toda la query');
  assert(seg.indexOf("url.search = ''") === -1, 'queda url.search = \'\'');
});

/* --- 7. hasAccess y legales --- */
test('ORBIT_FEATURES usa las claves reales de beneficios', function () {
  assert(src.indexOf("'no_ads', 'badge'") !== -1, 'ORBIT_FEATURES desalineado');
  assert(src.indexOf("'ads_free'") === -1, 'queda clave vieja ads_free');
});
test('la vista Orbit enlaza Términos y Privacidad', function () {
  assert(src.indexOf("openSubpageView(\\'terminos\\')") !== -1, 'falta enlace a Términos');
  assert(src.indexOf("openSubpageView(\\'privacidad\\')") !== -1, 'falta enlace a Privacidad');
});

/* --- 8. 404 sincronizado --- */
test('404.html idéntico a index.html', function () {
  assert.strictEqual(src404, src, '404.html desincronizado');
});

console.log('\n' + passed + ' pasadas, ' + failed + ' fallidas.');
process.exit(failed ? 1 : 0);
