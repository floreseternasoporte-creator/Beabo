/* Prueba de regresión UI: Drex Orbit + Pagos a 390px (carril 4, auditoría UI).
 *
 * Fija los hallazgos de la re-verificación profunda de Orbit/Pagos:
 *  1. Cero emojis como iconos en toda la superficie Orbit/Pagos (el 🔜 de
 *     Analíticas se reemplazó por el SVG 'clock' del catálogo).
 *  2. El plan semanal dice "a la semana" (no "al semana") en la tarjeta y
 *     en orbitPlanPrice(); además su tarjeta NO muestra el equivalente
 *     mensual ("≈ $8.62 al mes" confundía: parecía más caro que el mensual).
 *  3. El candado de los temas pro es una píldora superior compacta
 *     (.orbit-theme-lock sin inset:0, con nowrap): antes el overlay centrado
 *     de 11px se desbordaba y tapaba el nombre del tema a 390px.
 *  4. El importe de compras de monedas es solo dinero ("$4.99"), sin
 *     repetir "· 500 monedas": la columna derecha era tan ancha que el
 *     título se truncaba ("Compra de Drex …").
 *  5. Colores de estado del historial: paid/succeeded también en verde;
 *     past_due/uncollectible en rojo (antes "Pago vencido" salía apagado).
 *  6. i18n ES/EN/ZH/PT: existen las claves 'a la semana', 'Términos',
 *     'Beneficio Drex Orbit activo.' y 'Próximamente: alcance, visitas al
 *     perfil y votos por publicación.'; la línea de pago seguro usa la
 *     clave larga con "Aceptamos tarjetas y Link" (la corta no tenía
 *     traducción y salía en español en EN/ZH/PT).
 *  7. Contrato de planes no disponibles: weekly/biennial/lifetime fuera de
 *     ORBIT_BACKEND_PLANS (tarjeta .plan-coming-soon sin botón de pago).
 *  8. Las funciones que abren Orbit/Pagos son declaraciones globales
 *     (los taps muertos del pasado fueron por <style> sin cerrar y por
 *     funciones no exportadas: no debe repetirse).
 *  9. 404.html sigue siendo copia exacta de index.html.
 *
 * Uso: node tests/test-ui-orbit-390.js   (código 0 = todo OK)
 */
'use strict';
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

var EMOJI = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\u2C00-\u2CFF]/u;
function orbitZone() {
  var a = src.indexOf('var ORBIT_PLANS');
  var b = src.indexOf('/* ---------- C240: co-anfitrión');
  assert(a !== -1 && b !== -1 && b > a, 'zona Orbit no encontrada');
  return src.slice(a, b);
}
function htmlZone() {
  var a = src.indexOf('<!-- ============ Drex Orbit: vista de suscripción ============ -->');
  var b = src.indexOf('<div id="settings-view"');
  assert(a !== -1 && b !== -1 && b > a, 'zona HTML Orbit no encontrada');
  return src.slice(a, b);
}

/* 1. Cero emojis en la superficie Orbit/Pagos. */
test('sin emojis en el JS de Orbit/Pagos', function () {
  assert(!EMOJI.test(orbitZone()), 'emoji encontrado en la zona JS de Orbit/Pagos');
});
test('sin emojis en el HTML de Orbit/Pagos', function () {
  assert(!EMOJI.test(htmlZone()), 'emoji encontrado en la zona HTML de Orbit/Pagos');
});
test('el aviso de Analíticas usa el SVG clock, no emoji', function () {
  var i = src.indexOf('Próximamente: alcance, visitas al perfil y votos por publicación.');
  assert(i !== -1, 'texto del aviso no encontrado');
  var ctx = src.slice(Math.max(0, i - 400), i);
  assert(ctx.indexOf("dxIcon('clock'") !== -1, 'no se usa dxIcon(clock) junto al aviso');
});

/* 2. "a la semana" (gramática) y sin equivalente mensual en weekly. */
test('no existe "al semana" fuera de comentarios', function () {
  var noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  assert(noComments.indexOf('al semana') === -1, '"al semana" sigue presente en el código');
});
test("weekly usa t('a la semana') en tarjeta y precio", function () {
  assert(src.indexOf("t('a la semana')") !== -1, "t('a la semana') no usado");
  assert(/plan === 'weekly'\) return p\.price \+ ' ' \+ t\('a la semana'\)/.test(src),
    'orbitPlanPrice no tiene el caso weekly');
});
test('la tarjeta weekly no muestra equivalente mensual', function () {
  assert(/planId !== 'monthly' && planId !== 'weekly'/.test(src),
    'el equivalente mensual no excluye weekly');
});

/* 3. Candado de temas pro: píldora superior, sin overlay de pantalla completa. */
test('.orbit-theme-lock es píldora superior compacta', function () {
  var m = src.match(/\.orbit-theme-lock\{([^}]*)\}/);
  assert(m, 'regla .orbit-theme-lock no encontrada');
  var rule = m[1];
  assert(rule.indexOf('inset:0') === -1, 'sigue siendo overlay de pantalla completa');
  assert(rule.indexOf('top:6px') !== -1, 'no está anclada arriba');
  assert(rule.indexOf('border-radius:999px') !== -1, 'no es píldora');
  assert(rule.indexOf('white-space:nowrap') !== -1, 'el texto puede partirse en dos líneas');
});

/* 4. Importe de monedas: solo dinero. */
test('orbitTxAmount (monedas) no repite la cantidad de monedas', function () {
  var i = src.indexOf('function orbitTxAmount(tx)');
  assert(i !== -1, 'orbitTxAmount no encontrada');
  var body = src.slice(i, src.indexOf('\n}\n', i));
  assert(body.indexOf("t('monedas')") !== -1, 'se perdió el fallback sin cents');
  assert(body.indexOf("' · ' + tx.amount") === -1, 'sigue concatenando "· N monedas" al importe');
});

/* 5. Colores de estado del historial. */
test('paid/succeeded en verde; past_due/uncollectible en rojo', function () {
  var i = src.indexOf('var stColor');
  assert(i !== -1, 'stColor no encontrado');
  var line = src.slice(i, src.indexOf(';', i) + 1);
  assert(line.indexOf("'paid'") !== -1 && line.indexOf("'succeeded'") !== -1,
    'paid/succeeded no están en verde');
  assert(line.indexOf("'past_due'") !== -1 && line.indexOf("'uncollectible'") !== -1,
    'past_due/uncollectible no están en rojo');
});

/* 6. i18n: claves nuevas en EN/ZH/PT + clave larga de pago seguro. */
function dictOf(varName, nextName) {

  var dsrc = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');
  var a = dsrc.indexOf(varName);
  var b = nextName ? dsrc.indexOf(nextName, a) : dsrc.length;
  var sec = dsrc.slice(a, b);
  var close = sec.lastIndexOf('};');
  return new Function('return (' + sec.slice(sec.indexOf('{'), close + 1) + ');')();
}
test('claves lane-4 existen en EN/ZH/PT', function () {
  var EN = dictOf('var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {');
  var ZH = dictOf('var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {');
  var PT = dictOf('var APP_PORTUGUESE_TEXT = {', 'var APP_CHINESE_ATTRS = {');
  ['a la semana', 'Términos', 'Beneficio Drex Orbit activo.',
   'Próximamente: alcance, visitas al perfil y votos por publicación.'
  ].forEach(function (k) {
    assert(EN[k], 'falta en EN: ' + k);
    assert(ZH[k], 'falta en ZH: ' + k);
    assert(PT[k], 'falta en PT: ' + k);
  });
});
test('la línea de pago seguro usa la clave larga traducida', function () {
  assert(src.indexOf("t('Pago 100% seguro con Stripe. Aceptamos tarjetas y Link. Sin permanencia. Cancela cuando quieras.')") !== -1,
    'el código no usa la clave larga con "Aceptamos tarjetas y Link"');
  assert(src.indexOf("t('Pago 100% seguro con Stripe. Sin permanencia. Cancela cuando quieras.')") === -1,
    'sigue la clave corta sin traducción');
});

/* 7. Contrato de planes no disponibles. */
test('weekly/biennial/lifetime fuera de ORBIT_BACKEND_PLANS', function () {
  var m = src.match(/var ORBIT_BACKEND_PLANS = \[([^\]]*)\]/);
  assert(m, 'ORBIT_BACKEND_PLANS no encontrado');
  var list = m[1];
  ['weekly', 'biennial', 'lifetime'].forEach(function (p) {
    assert(list.indexOf("'" + p + "'") === -1, p + ' no debería estar disponible');
  });
  ['monthly', 'quarterly', 'semiannual', 'yearly'].forEach(function (p) {
    assert(list.indexOf("'" + p + "'") !== -1, p + ' debería estar disponible');
  });
});

/* 8. Funciones globales que abren Orbit/Pagos (anti taps muertos). */
test('funciones de apertura/cierre Orbit/Pagos son globales', function () {
  ['openOrbitView', 'closeOrbitView', 'openPaymentsView', 'closePaymentsView',
   'openOrbitPaywall', 'closeOrbitPaywall', 'orbitSubscribe', 'orbitManage',
   'orbitRestore', 'orbitBenefitTap', 'orbitOpenAnalytics', 'orbitCloseAnalytics',
   'renderPaymentsView', 'setOrbitProfileTheme'
  ].forEach(function (fn) {
    assert(new RegExp('function ' + fn + '\\(').test(src), fn + ' no es declaración global');
  });
});
test('los <style> previos al script de Orbit están cerrados (anti taps muertos)', function () {
  /* Regresión del bug histórico: un <style> sin cerrar se traga el <script>
   * siguiente y los onclick de Orbit/Pagos mueren. Se verifica que entre el
   * último <style> anterior al bloque que contiene var ORBIT_PLANS y dicho
   * bloque haya un </style>. */
  var anchor = src.indexOf('var ORBIT_PLANS');
  assert(anchor !== -1, 'var ORBIT_PLANS no encontrado');
  var lastOpen = src.lastIndexOf('<style', anchor);
  assert(lastOpen !== -1, 'no hay <style> previo al bloque Orbit');
  var seg = src.slice(lastOpen, anchor);
  assert(seg.indexOf('</style>') !== -1, 'el <style> previo al script de Orbit no está cerrado');
});

/* 9. 404.html idéntico. */
test('404.html es copia exacta de index.html', function () {
  assert.strictEqual(src404, src, '404.html difiere de index.html');
});

console.log('\n' + passed + ' OK, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
