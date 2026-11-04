/* ================================================================
 * Tests de regresión: auth a pantalla completa en escritorio (2026-09-27)
 * P1: en escritorio (>=1024px) el login/registro ocupa TODO el viewport
 *     con layout dividido (panel de marca índigo + formulario) — pedido
 *     directo del usuario: ya no es tarjeta modal ni columna de teléfono.
 * P2: móvil (<1024px) intacto: .drex-auth-brand oculto y .drex-auth-main
 *     transparente (display:contents).
 * P3: los 12 pasos del auth viven dentro de .drex-auth-main para que los
 *     `absolute inset-0` queden confinados al panel derecho en escritorio.
 * P4: el reto 2FA del login y el onboarding reciben el mismo tratamiento.
 * P5: las 4 cadenas nuevas del panel de marca existen en EN/ZH/PT.
 * Ejecutar con: node tests/test-c208-auth-desktop.js
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var src = fs.readFileSync(__dirname + '/../index.html', 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}
function mustContain(hay, needle, label) {
  assert(hay.indexOf(needle) !== -1, label + ' no encontrado');
}
function mustNotContain(hay, needle, label) {
  assert(hay.indexOf(needle) === -1, label + ' encontrado (no debería estar)');
}

/* Extrae el bloque del responsive layer */
function responsiveLayer() {
  var start = src.indexOf('<style id="drex-responsive-layer">');
  assert(start !== -1, 'responsive layer no encontrado');
  var end = src.indexOf('</style>', start);
  return src.slice(start, end);
}
var css = responsiveLayer();
function desktopCss() {
  var i = css.indexOf('@media (min-width: 1024px)');
  assert(i !== -1, 'media query desktop no encontrada');
  return css.slice(i);
}
var dcss = desktopCss();

/* ---------- P1: estructura de puertas ---------- */
test('#auth-form es puerta (.drex-gate) con panel de marca y main', function () {
  mustContain(src, 'id="auth-form" class="drex-gate', '#auth-form.drex-gate');
  var s = src.indexOf('<div id="auth-form"');
  var brand = src.indexOf('<div class="drex-auth-brand"', s);
  var main = src.indexOf('<div class="drex-auth-main">', s);
  assert(brand !== -1 && main !== -1 && brand < main, 'brand antes que main dentro de #auth-form');
});

test('#twofactor-challenge-view es puerta con brand y main--center', function () {
  mustContain(src, 'id="twofactor-challenge-view" class="drex-gate', '2fa.drex-gate');
  mustContain(src, 'drex-auth-main drex-auth-main--center', 'main--center en 2FA');
});

/* ---------- P3: los 12 pasos dentro de .drex-auth-main ---------- */
var STEPS = ['auth-options', 'login-options', 'email-step', 'password-step',
  'recovery-step', 'reg-name-step', 'reg-birthdate-step', 'reg-credentials-step',
  'reg-verify-step', 'reg-username-step', 'reg-photo-step', 'reg-success-step'];
test('los 12 pasos del auth están dentro de .drex-auth-main', function () {
  var mainOpen = src.indexOf('<div class="drex-auth-main">');
  var mainClose = src.indexOf('<!-- /drex-auth-main (puerta de auth) -->');
  assert(mainOpen !== -1 && mainClose !== -1, 'wrapper main no encontrado');
  STEPS.forEach(function (s) {
    var p = src.indexOf('id="' + s + '"');
    assert(p !== -1, 'paso ' + s + ' no existe');
    assert(p > mainOpen && p < mainClose, 'paso ' + s + ' fuera de .drex-auth-main');
  });
});

/* ---------- P1: CSS desktop full-screen ---------- */
test('#auth-form ocupa todo el viewport en escritorio (sin tarjeta)', function () {
  mustContain(dcss, '#auth-form {', 'regla #auth-form desktop');
  mustContain(dcss, 'width: 100vw;', 'ancho viewport');
  mustContain(dcss, 'max-width: none;', 'sin max-width de teléfono');
  mustNotContain(dcss, 'max-width: 460px;', 'la tarjeta modal de 460px ya no existe');
  mustNotContain(dcss, 'border-radius: 28px;', 'sin bordes de tarjeta');
});

test('.drex-gate cambia a fila en escritorio', function () {
  mustContain(dcss, '#auth-form.drex-gate, #twofactor-challenge-view.drex-gate', 'regla drex-gate');
  mustContain(dcss, 'flex-direction: row;', 'fila en escritorio');
});

test('panel de marca visible solo en escritorio con índigo Drex', function () {
  /* la base móvil debe estar FUERA del media desktop (si quedara dentro,
     el panel se vería sin estilos en el teléfono) */
  var mediaIdx = css.indexOf('@media (min-width: 1024px)');
  var baseIdx = css.indexOf('.drex-auth-brand { display: none; }');
  assert(baseIdx !== -1 && baseIdx < mediaIdx, 'base móvil fuera del media desktop');
  mustContain(dcss, '.drex-gate > .drex-auth-brand {', 'visible en escritorio');
  mustContain(dcss, 'flex: 0 0 44%;', 'ancho 44%');
  mustContain(dcss, '#2F33B8', 'índigo de marca en el gradiente');
});

test('.drex-auth-main es transparente en móvil y panel en escritorio', function () {
  var mediaIdx = css.indexOf('@media (min-width: 1024px)');
  var baseIdx = css.indexOf('.drex-auth-main { display: contents; }');
  assert(baseIdx !== -1 && baseIdx < mediaIdx, 'base móvil fuera del media desktop');
  mustContain(dcss, '.drex-gate > .drex-auth-main {', 'panel en escritorio');
  mustContain(dcss, 'position: relative;', 'ancestro posicionado para los inset-0');
});

test('pasos confinados al panel derecho con ancho de lectura', function () {
  mustContain(dcss, '#auth-form .drex-auth-main > div {', 'regla de pasos');
  mustContain(dcss, 'max-width: 520px;', 'ancho de lectura');
});

/* ---------- P4: onboarding y 2FA ---------- */
test('onboarding a pantalla completa en escritorio', function () {
  mustContain(dcss, '#onboarding-overlay { max-width: none;', 'onboarding sin columna');
  mustContain(dcss, '#onboarding-overlay .onb-screen { max-width: 640px;', 'contenido centrado');
});

test('reto 2FA mantiene su fondo claro en el panel', function () {
  mustContain(dcss, '#twofactor-challenge-view > .drex-auth-main--center { background: #f0f4f9; }', 'fondo 2FA');
});

test('reto 2FA exento de la columna de overlays fijos en escritorio', function () {
  mustContain(dcss, '#twofactor-challenge-view {', 'regla de exención 2FA');
  mustContain(dcss, 'max-width: none !important;', 'sin tope de columna');
});

/* ---------- P2: sin reglas sueltas divergentes ---------- */
test('una sola definición del sistema auth-desktop (sin duplicados)', function () {
  var n = css.split('.drex-auth-brand { display: none; }').length - 1;
  assert(n === 1, 'definición móvil duplicada x' + n);
  n = dcss.split('.drex-gate > .drex-auth-brand {').length - 1;
  assert(n === 1, 'definición desktop duplicada x' + n);
});

/* ---------- P5: i18n de las 4 cadenas nuevas ---------- */
var I18N_KEYS = [
  'Publica fotos, videos y votaciones',
  'Vota y haz eco de lo que te gusta',
  'Conecta con personas de todo el mundo',
  'Publica, conversa y crea tu comunidad.'
];
function extractDict(file, varName, nextVarName) {
  var s = file.indexOf(varName);
  assert(s !== -1, varName + ' no encontrado');
  var e = nextVarName ? file.indexOf(nextVarName, s) : file.length;
  var sec = file.slice(s, e);
  var closeIdx = sec.lastIndexOf('\n};');
  var objText = sec.slice(sec.indexOf('{'), closeIdx + 2);
  return new Function('return (' + objText + ');')();
}
test('las 4 cadenas del panel de marca existen en EN/ZH/PT', function () {
  var i18n = fs.readFileSync(__dirname + '/../drex-i18n.js', 'utf8');
  var EN = extractDict(i18n, 'var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {');
  var ZH = extractDict(i18n, 'var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {');
  var PT = extractDict(i18n, 'var APP_PORTUGUESE_TEXT = {', 'var APP_CHINESE_ATTRS = {');
  I18N_KEYS.forEach(function (k) {
    assert(Object.prototype.hasOwnProperty.call(EN, k), 'falta en EN: ' + k);
    assert(Object.prototype.hasOwnProperty.call(ZH, k), 'falta en ZH: ' + k);
    assert(Object.prototype.hasOwnProperty.call(PT, k), 'falta en PT: ' + k);
    assert(EN[k] && EN[k] !== k, 'EN sin traducir: ' + k);
  });
});

console.log('\n' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
