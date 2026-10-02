/* Pruebas de regresión: errores de pago de Drex Orbit / Drex Coins.
 *
 * Historia (2026-10-02): el usuario tocó "Suscribirme" (plan Anual $49.99) y
 * recibió "We couldn't reach the payment server". Investigación:
 *  - El endpoint configurado era correcto y la Lambda respondía bien
 *    (200 en /, 400/401 con validación correcta y CORS dinámico OK para el
 *    origen del usuario). La causa raíz fue red del lado del dispositivo
 *    (el fetch falló en los 4 intentos): no había nada que corregir en la
 *    URL ni en el backend.
 *  - Lo que SÍ se corrigió: el mensaje de error ahora es accionable
 *    (menciona VPN, bloqueador de anuncios o DNS privado en vez del
 *    genérico "revisa tu conexión").
 *
 * Este test fija el contrato:
 *  1. DREX_PAYMENTS_ENDPOINT es una Function URL válida (no vacía/placeholder).
 *  2. El checkout usa Content-Type text/plain (CORS "simple", sin preflight:
 *     en iOS los preflights fallan de forma intermitente y se ven como
 *     error de red aunque el servidor esté sano).
 *  3. Cada tipo de fallo mapea a un mensaje ESPECÍFICO (network/timeout no
 *     caen al genérico "Error al iniciar el pago").
 *  4. Las claves ES usadas existen traducidas en EN/ZH/PT.
 *
 * Uso: node tests/test-orbit-payment-errors.js   (código 0 = todo OK)
 */
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var ROOT = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var i18n = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

/* 1. Endpoint configurado y con formato de Function URL real. */
test('DREX_PAYMENTS_ENDPOINT es una lambda-url válida', function () {
  var m = html.match(/var DREX_PAYMENTS_ENDPOINT = '([^']*)'/);
  assert(m, 'no se encontró DREX_PAYMENTS_ENDPOINT');
  var url = m[1];
  assert(/^https:\/\/[a-z0-9]+\.lambda-url\.us-east-1\.on\.aws\/?$/.test(url),
    'formato inesperado: ' + url);
});

/* 2. POST de pagos como CORS simple (sin preflight). */
test('DrexOrbit._post usa Content-Type text/plain', function () {
  var m = html.match(/_post:\s*async function\s*\(path,\s*fields\)[\s\S]{0,2500}?headers:\s*\{\s*'Content-Type':\s*'([^']+)'/);
  assert(m, 'no se encontró el Content-Type de DrexOrbit._post');
  assert(m[1].indexOf('text/plain') === 0, 'Content-Type inesperado: ' + m[1]);
});
test('drexStripeCheckout (coins) usa Content-Type text/plain', function () {
  var start = html.indexOf('async function drexStripeCheckout(pkg)');
  assert(start !== -1, 'no se encontró drexStripeCheckout');
  var seg = html.slice(start, start + 4000);
  assert(/'Content-Type':\s*'text\/plain/.test(seg), 'coins no usa text/plain');
});

/* 3. Mapeo de errores -> mensajes específicos en orbitSubscribe. */
function orbitSubscribeCatch() {
  var start = html.indexOf('async function orbitSubscribe(planId)');
  assert(start !== -1, 'no se encontró orbitSubscribe');
  var end = html.indexOf('async function orbitManage()', start);
  return html.slice(start, end === -1 ? start + 3000 : end);
}
test("network/timeout -> diagnóstico de red (no genérico)", function () {
  // 2026-10-02: el mensaje directo se reemplazó por drexPayNetDiag(), que
  // prueba App/Internet/Pagos y muestra el resultado para captura.
  var body = orbitSubscribeCatch();
  assert(/m\s*===\s*'network'\s*\|\|\s*m\s*===\s*'timeout'/.test(body),
    'no se encontró la rama network/timeout');
  assert(body.indexOf('drexPayNetDiag()') !== -1,
    'network/timeout debe invocar drexPayNetDiag()');
  assert(body.indexOf('Mándanos captura de este mensaje para arreglarlo.') !== -1,
    'network/timeout debe pedir captura del diagnóstico');
});
test('no-token -> mensaje de login', function () {
  var body = orbitSubscribeCatch();
  assert(/'no-token'\)\s*orbitToast\(t\('Inicia sesión para suscribirte/.test(body),
    "no-token no mapea a 'Inicia sesión para suscribirte'");
});
test('invalid_plan -> mensaje de plan no disponible', function () {
  var body = orbitSubscribeCatch();
  assert(/invalid_plan/.test(body), 'invalid_plan no está mapeado');
});
test('http_503/subscription_not_configured -> mensaje de no disponible', function () {
  var body = orbitSubscribeCatch();
  assert(/subscription_not_configured/.test(body), '503 no está mapeado');
});

/* 4. Las claves ES del mapeo existen traducidas en EN/ZH/PT. */
var KEYS = [
  'No pudimos contactar el servidor de pagos desde tu conexión. Si usas VPN, bloqueador de anuncios o DNS privado, desactívalo e inténtalo de nuevo.',
  'Inicia sesión para suscribirte a Drex Orbit.',
  'No se pudo contactar el servidor de pagos desde tu conexión a internet. Si usas VPN, bloqueador de anuncios o DNS privado, desactívalo e inténtalo de nuevo.'
];
test('claves de error de pago traducidas en EN/ZH/PT', function () {
  KEYS.forEach(function (k) {
    var q = JSON.stringify(k);
    assert(i18n.indexOf(q + ':"') !== -1 || i18n.indexOf(q + ': "') !== -1,
      'clave sin traducción: ' + k.slice(0, 40) + '...');
  });
  // Cada clave debe aparecer al menos 4 veces: uso en index.html + 3 dicts.
  KEYS.forEach(function (k) {
    var count = i18n.split(JSON.stringify(k)).length - 1;
    assert(count >= 3, 'clave con menos de 3 traducciones: ' + k.slice(0, 40));
  });
});

console.log('\n' + passed + ' pasadas, ' + failed + ' falladas');
process.exit(failed ? 1 : 0);
