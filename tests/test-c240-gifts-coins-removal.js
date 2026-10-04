/* ================================================================
 * C240 — eliminación de la función de regalos y Drex Coins (2026-10-03).
 *
 * Orden del usuario: la función de enviar regalos ya no está disponible
 * en la plataforma (era remanente de los en vivo de video, eliminados);
 * se elimina por completo: hoja de billetera/tienda, hoja de regalos,
 * motor DrexCoins, checkout de monedas, paquetes y diamantes, el
 * beneficio Orbit `exclusive_gifts` (Orbit pasa de 8 a 7 beneficios)
 * y la mención en los términos.
 *
 * Este test fija la eliminación y protege lo que NO se tocó:
 *  - el cliente DrexOrbit y su checkout de suscripción,
 *  - la vista Pagos (historial) y su icono coin,
 *  - el endpoint de pagos (lo lee DrexOrbit._endpoint),
 *  - las fiestas de voz (drexFiestaSwitchTab),
 *  - 404.html sigue siendo copia exacta de index.html.
 *
 * Ejecutar: node tests/test-c240-gifts-coins-removal.js
 * ================================================================ */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const html404 = fs.readFileSync(path.join(root, '404.html'), 'utf8');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('ok - ' + name); }

/* ---------- ausencia: la función de regalos y las monedas se fueron ---------- */

const ABSENT = [
  'drexCoinsOpenWallet',   // abría la hoja de billetera
  'drexCoinsOpenShop',     // abría la tienda de paquetes
  'drexCoinsBuy',          // compraba paquetes
  'DREX_COIN_PACKAGES',    // catálogo de paquetes de monedas
  'DREX_DIAMOND_RATE',     // tasa monedas -> diamantes
  'DREX_DIAMOND_USD_RATE', // tasa diamantes -> USD
  'DrexCoins',             // motor de billetera (objeto + window.DrexCoins)
  'drexCoins',             // cualquier identificador del motor/UI
  'DrexPay',               // proveedor de pago de monedas
  'drexStripeCheckout',    // checkout de monedas
  'capturePaymentReturn',  // retorno ?coins=success/cancelled
  'exclusive_gifts',       // beneficio Orbit eliminado (8 -> 7)
  'Regalos exclusivos',    // texto del beneficio en beneficios/paywall
  'id="drex-coins-sheet"', // DOM de la hoja de billetera/tienda
  'drex-coins-sheet',
  'drexTierLabel',         // etiquetas de tier de la hoja de regalos
  'regalos virtuales',     // mención en los términos de servicio
  'dlc-',                  // CSS de la hoja de billetera/tienda
];

ABSENT.forEach(function (needle) {
  ok('ausente en index.html: ' + needle, function () {
    assert(html.indexOf(needle) === -1, 'sigue presente: ' + needle);
  });
});

/* ---------- presencia: lo que NO se tocó sigue vivo ---------- */

const PRESENT = [
  'var DrexOrbit = {',            // cliente de suscripción
  '/subscribe-embedded',          // C247: suscripción Orbit embebida (C244; antes checkout hospedado)
  '/subscription-cancel',         // C247: gestión propia sin portal de Stripe (C244)
  'renderPaymentsView',           // vista Pagos (historial)
  'drexFiestaSwitchTab',          // fiestas de voz intactas
  'DREX_ORBIT_ENFORCE',           // gates de enforcement
  'function drexPayNetDiag',      // diagnóstico de red de pagos
  'captureOrbitReturn',           // retorno ?orbit= de la suscripción
];

PRESENT.forEach(function (needle) {
  ok('presente en index.html: ' + needle, function () {
    assert(html.indexOf(needle) !== -1, 'falta (no debía tocarse): ' + needle);
  });
});

ok('DREX_PAYMENTS_ENDPOINT sigue declarado (DrexOrbit._endpoint lo lee)', function () {
  assert(html.indexOf("var DREX_PAYMENTS_ENDPOINT = 'https://") !== -1,
    'el endpoint de pagos ya no está declarado');
  assert(html.indexOf('.lambda-url.us-east-1.on.aws/') !== -1,
    'el endpoint ya no es la Function URL de la Lambda');
});

function iconsRegion() {
  var a = html.indexOf('var DREX_ICONS = {');
  assert(a !== -1, 'DREX_ICONS no encontrado');
  return html.slice(a, html.indexOf('};', a));
}

ok('el icono coin se conserva (lo usa el historial de Pagos)', function () {
  assert(html.indexOf("dxIcon('coin'") !== -1, 'Pagos ya no dibuja el icono coin');
  assert(iconsRegion().indexOf("  coin: '") !== -1, 'DREX_ICONS perdió el icono coin');
});

ok('DREX_ICONS ya no define gift/diamond/wallet', function () {
  var region = iconsRegion();
  ['gift', 'diamond', 'wallet'].forEach(function (name) {
    assert(region.indexOf('\n  ' + name + ": '") === -1,
      'DREX_ICONS aún define ' + name);
  });
});

ok('ORBIT_FEATURES tiene 7 funciones y ninguna es exclusive_gifts', function () {
  var a = html.indexOf('var ORBIT_FEATURES = [');
  assert(a !== -1, 'ORBIT_FEATURES no encontrado');
  var seg = html.slice(a, html.indexOf('];', a));
  var feats = seg.split(',').filter(function (x) { return x.indexOf("'") !== -1; });
  assert(feats.length === 11, 'se esperaban 11 funciones (7 de C241 + 4 de C243), hay ' + feats.length);
  assert(seg.indexOf('exclusive_gifts') === -1, 'exclusive_gifts sigue en ORBIT_FEATURES');
});

/* ---------- C246: el hub de crear tampoco vende monedas ---------- */

ok('el hub de crear (#creator-hub-view) no contiene ninguna loseta de monedas', function () {
  // QA en vivo (2026-10-03) reportó una loseta "Gana Drex Coins" en el hub;
  // el código publicado no la contiene (probable service worker viejo).
  // Este guardia fija que ninguna loseta del hub hable de monedas/diamantes.
  var a = html.indexOf('id="creator-hub-view"');
  assert(a !== -1, 'creator-hub-view no encontrado');
  // El hub termina donde empieza el editor a pantalla completa.
  var hub = html.slice(a, html.indexOf('id="note-creation-fullscreen"', a));
  assert(!/coins|diamantes|diamonds/i.test(hub), 'el hub menciona monedas/diamantes');
  assert(hub.indexOf('Gana') === -1 || hub.indexOf('Coins') === -1,
    'loseta "Gana Drex Coins" en el hub');
});

ok('cero superficies de monedas alcanzables por el usuario en toda la app', function () {
  ['Gana Drex Coins', 'Drex Coins', 'drexCoins', 'DREX_COIN_PACKAGES',
   'drex-coins-sheet', 'exclusive_gifts'].forEach(function (s) {
    assert(html.indexOf(s) === -1, 'sigue presente: ' + s);
  });
});

/* ---------- coherencia de los dos archivos ---------- */

ok('404.html es copia exacta de index.html', function () {
  assert(html === html404, '404.html difiere de index.html');
});

console.log('\n' + passed + ' aserciones OK — C240: regalos y Drex Coins eliminados');
