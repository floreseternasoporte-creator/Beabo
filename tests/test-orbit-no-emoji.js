/* Prueba de regresión: Drex Orbit SIN emojis como iconos (carril orbit-icons).
 *
 * Historia: el 2026-09-29 el commit 0d2328b reemplazó los emojis de Orbit
 * por SVG reales del catálogo Drex (DREX_ICONS + window.dxIcon). El commit
 * 1fb41da (30-sep) revirtió esa zona y devolvió emojis (🚫👑🎨📡🧩📊🎁🎧🪐)
 * a la lista de beneficios, el paywall, la fila de Analíticas y el candado
 * de los temas pro; además dejó rotos dos iconos de Pagos porque
 * window.dxIcon ya no estaba definido.
 *
 * Este test fija el estado intencional actual:
 *   - orbitBenefits() usa ic: <nombre del catálogo>, sin campo `e`
 *   - orbitPaywallCopy() igual, con fallback { ic: 'crown' }
 *   - openOrbitPaywall() dibuja chip SVG con window.dxIcon(c.ic), no c.e
 *   - renderOrbitView() dibuja las filas de beneficios con dxIcon(b.ic)
 *     y la fila de Analíticas con dxIcon('chart')
 *   - el candado "Solo Drex Orbit" usa el SVG crown del catálogo
 *   - drexTierLabel() no tiene emoji en la etiqueta del tier orbit
 *   - el IIFE "iconos SVG ampliados" registra el catálogo y expone
 *     window.dxIcon
 *   - 404.html sigue siendo copia exacta de index.html
 *
 * Uso: node tests/test-orbit-no-emoji.js   (código 0 = todo OK)
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

/* Rango de emojis amplio: pictogramas, misceláneos, símbolos y 🪐 (1FA90). */
var EMOJI = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\u2C00-\u2CFF]/u;

function blockBetween(s, start, end, label) {
  var i = s.indexOf(start);
  assert(i !== -1, label + ': marcador de inicio no encontrado');
  var j = s.indexOf(end, i + start.length);
  assert(j !== -1, label + ': marcador de fin no encontrado');
  return s.slice(i, j + end.length);
}
function fnBlock(s, sig, label) {
  /* Bloque de una función: desde su firma hasta el primer '}' al inicio
   * de línea (convención de cierre del archivo). */
  var i = s.indexOf(sig);
  assert(i !== -1, label + ': firma no encontrada');
  var j = s.indexOf('\n}\n', i);
  assert(j !== -1, label + ': cierre de función no encontrado');
  return s.slice(i, j + 3);
}

/* ---------- 1. catálogo de iconos + window.dxIcon ---------- */

test('IIFE de iconos SVG ampliados presente y expuesto en window', function () {
  assert(src.indexOf('=== Drex Orbit: iconos SVG ampliados (cero emojis como iconos) ===') !== -1,
    'falta el IIFE de registro de iconos');
  assert(src.indexOf('window.dxIcon = function (name, cls) {') !== -1,
    'window.dxIcon no está definido');
});

test('catálogo incluye los iconos que usa Orbit', function () {
  var i = src.indexOf('=== Drex Orbit: iconos SVG ampliados (cero emojis como iconos) ===');
  assert(i !== -1, 'IIFE no encontrado');
  var j = src.indexOf('})();', i);
  var region = src.slice(i, j);
  ['noads', 'palette', 'signal', 'puzzle', 'chart', 'headphones', 'receipt', 'planet']
    .forEach(function (name) {
      assert(new RegExp('\\b' + name + ": '<").test(region), 'falta icono ' + name);
    });
  assert(!EMOJI.test(region), 'emoji dentro del IIFE de iconos');
});

/* ---------- 2. lista de beneficios ---------- */

test('orbitBenefits(): 8 beneficios con ic del catálogo, sin emojis', function () {
  var r = fnBlock(src, 'function orbitBenefits() {', 'orbitBenefits');
  var rows = r.match(/\{\s*f:\s*'[^']+',\s*ic:\s*'[^']+'/g) || [];
  assert(rows.length === 8, 'se esperaban 8 beneficios, hay ' + rows.length);
  ['noads', 'crown', 'palette', 'mic', 'puzzle', 'chart', 'gift', 'headphones']
    .forEach(function (name) {
      assert(r.indexOf("ic: '" + name + "'") !== -1, 'falta ic ' + name);
    });
  assert(!EMOJI.test(r), 'emoji en orbitBenefits');
  assert(/\be:\s*['"]/.test(r) === false, 'orbitBenefits aún usa el campo e (emoji)');
});

/* ---------- 3. vista de Orbit ---------- */

test('renderOrbitView(): filas de beneficios dibujan SVG, no emojis', function () {
  var r = blockBetween(src, 'async function renderOrbitView() {',
    'async function orbitSubscribe(planId) {', 'renderOrbitView');
  var rows = r.split("window.dxIcon(b.ic, 'w-5 h-5')");
  assert(rows.length === 3, 'las 2 listas de beneficios deben usar dxIcon(b.ic)');
  assert(r.indexOf("'<span class=\"text-2xl\">' + b.e") === -1,
    'regresión: fila de beneficio con emoji (text-2xl + b.e)');
  assert(r.indexOf("window.dxIcon('chart', 'w-6 h-6')") !== -1,
    'la fila de Analíticas debe usar el SVG chart del catálogo');
  assert(!EMOJI.test(r), 'emoji en renderOrbitView');
});

test('candado de temas pro usa SVG crown, no emoji', function () {
  /* carril 4 (auditoría 390px): el candado pasó a píldora superior compacta
   * (w-3 h-3); el contrato sigue siendo SVG crown del catálogo, sin emoji. */
  assert(src.indexOf("window.dxIcon('crown', 'w-3 h-3 shrink-0')") !== -1,
    'candado de tema pro sin SVG crown');
  assert(src.indexOf('<span class="orbit-theme-lock">👑') === -1,
    'regresión: candado con emoji 👑');
});

/* ---------- 4. paywall ---------- */

test('orbitPaywallCopy(): mapa con ic del catálogo y fallback crown, sin emojis', function () {
  var r = fnBlock(src, 'function orbitPaywallCopy(feature) {', 'orbitPaywallCopy');
  ['mic', 'puzzle', 'chart', 'gift', 'palette', 'noads', 'crown', 'headphones']
    .forEach(function (name) {
      assert(r.indexOf("ic: '" + name + "'") !== -1, 'falta ic ' + name);
    });
  assert(r.indexOf("{ ic: 'crown', title: 'Drex Orbit'") !== -1,
    'el fallback debe ser { ic: \'crown\' }');
  assert(!EMOJI.test(r), 'emoji en orbitPaywallCopy');
  assert(/\be:\s*['"]/.test(r) === false, 'orbitPaywallCopy aún usa el campo e (emoji)');
});

test('openOrbitPaywall(): chip SVG grande en vez del emoji gigante', function () {
  var r = fnBlock(src, 'function openOrbitPaywall(feature) {', 'openOrbitPaywall');
  assert(r.indexOf("window.dxIcon(c.ic, 'w-8 h-8')") !== -1,
    'el paywall debe dibujar el SVG del beneficio con dxIcon(c.ic)');
  assert(r.indexOf('text-5xl') === -1, 'regresión: paywall con emoji gigante (text-5xl)');
  assert(r.indexOf('c.e') === -1, 'regresión: el paywall aún usa c.e');
  assert(!EMOJI.test(r), 'emoji en openOrbitPaywall');
});

/* ---------- 5. etiquetas y tarjeta de Ajustes ---------- */

test('drexTierLabel(): etiqueta del tier orbit sin emoji', function () {
  var r = fnBlock(src, 'function drexTierLabel(tier) {', 'drexTierLabel');
  assert(r.indexOf("orbit: 'Drex Orbit'") !== -1, 'etiqueta del tier orbit cambiada');
  assert(!EMOJI.test(r), 'emoji en drexTierLabel');
});

test('tarjeta de Ajustes de Orbit usa SVG, no emoji', function () {
  var i = src.indexOf('id="orbit-settings-card"');
  assert(i !== -1, 'tarjeta de Ajustes no encontrada');
  var j = src.indexOf('id="pagos-settings-card"', i);
  var r = j !== -1 ? src.slice(i, j) : src.slice(i, i + 2000);
  assert(!EMOJI.test(r), 'emoji en la tarjeta de Ajustes de Orbit');
  assert(r.indexOf('<svg') !== -1, 'la tarjeta de Ajustes debe llevar un SVG');
});

/* ---------- 6. coherencia de los dos archivos ---------- */

test('index.html y 404.html son idénticos', function () {
  assert(src === src404, '404.html no es copia exacta de index.html');
});

test('404.html también está libre de emojis en Orbit', function () {
  var r = blockBetween(src404, 'async function renderOrbitView() {',
    'async function orbitSubscribe(planId) {', 'renderOrbitView@404');
  assert(!EMOJI.test(r), 'emoji en Orbit de 404.html');
});

console.log('\n' + passed + ' OK, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
