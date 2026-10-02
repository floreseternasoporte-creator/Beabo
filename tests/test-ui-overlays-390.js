/* test-ui-overlays-390.js — contratos del sistema de overlays a 390px.
 *
 * Regresiones que fija (auditoría overlays 2026-10-01, carril 6):
 * 1. Overlays que empujan el guard de Atrás (_pushOverlayBackGuard) pero NO
 *    están en _drexOverlayCandidates(): Atrás/Esc no los cerraban y el guard
 *    se consumía sin cerrar nada (la ruta cambiaba con el overlay encima).
 *    Casos reales: orbit-paywall, orbit-view, payments-view,
 *    orbit-analytics-view, drex-snap-viewer.
 * 2. Cada overlay registrado existe en el DOM y su closeFn es una función
 *    global real (nada de cierres muertos).
 * 3. El toast único se auto-oculta (sin toasts eternos ni encimados).
 * 4. El banner "Nueva versión disponible" existe, va por encima de todo
 *    (z-99999) y su botón llama a DrexForceUpdate.
 * 5. El paywall tiene backdrop con cierre por tap (bg-black/55).
 *
 * Uso: node tests/test-ui-overlays-390.js   (código 0 = todo OK)
 */
'use strict';
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var ROOT = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var noC = src.replace(/<!--[\s\S]*?-->/g, '');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

/* Extrae el cuerpo de una function declarada (balance de llaves). */
function fnBody(name) {
  var m = src.match(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\('));
  assert(m, 'función no encontrada: ' + name);
  var open = src.indexOf('{', m.index), depth = 0, j = open;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(open, j + 1);
}
function isGlobalFn(name) {
  if (new RegExp('\\bfunction\\s+' + name + '\\s*\\(').test(src)) return true;
  if (new RegExp('\\bwindow\\.' + name + '\\s*=').test(src)) return true;
  if (new RegExp('baro6dExpose\\s*\\(\\s*[\'"]' + name + '[\'"]').test(src)) return true;
  return false;
}

/* ---- 1. candidatos del sistema central de overlays ---- */
function candidates() {
  var out = [];
  var re = /\['([a-z0-9\-]+)',\s*\(\)\s*=>\s*(?:typeof\s+([A-Za-z_$][\w$.]*)\s*===\s*'function'\s*&&\s*)?([A-Za-z_$][\w$.]*)\([^)]*\)/g, m;
  var body = fnBody('_drexOverlayCandidates');
  while ((m = re.exec(body))) out.push({ id: m[1], closeRef: m[3] });
  return out;
}

test('candidatos: cada overlay registrado existe en el DOM', function () {
  var cands = candidates();
  assert(cands.length >= 30, 'se esperaban 30+ candidatos, hay ' + cands.length);
  var missing = cands.filter(function (c) { return src.indexOf('id="' + c.id + '"') === -1; });
  assert.strictEqual(missing.length, 0,
    'ids registrados sin elemento: ' + missing.map(function (c) { return c.id; }).join(', '));
});

test('candidatos: sin ids duplicados', function () {
  var cands = candidates(), seen = {};
  cands.forEach(function (c) {
    assert(!seen[c.id], 'id duplicado en candidatos: ' + c.id);
    seen[c.id] = 1;
  });
});

test('candidatos: cada closeFn es una función global real', function () {
  var cands = candidates();
  var bad = [];
  cands.forEach(function (c) {
    // closeRef puede ser window.x o un bloque try/catch inline; extraer el nombre base.
    var base = c.closeRef.split('.').pop();
    if (/^(close|hide|minimize)/.test(c.closeRef) || /^[A-Za-z_$]/.test(c.closeRef)) {
      // llamadas inline tipo window.minimizeMusicPlayer se verifican por separado
      if (c.closeRef.indexOf('window.') === 0) {
        if (!isGlobalFn(base)) bad.push(c.id + ' -> ' + c.closeRef);
      } else if (!isGlobalFn(base) && !/^\s*\{/.test(c.closeRef)) {
        bad.push(c.id + ' -> ' + c.closeRef);
      }
    }
  });
  assert.strictEqual(bad.length, 0, 'cierres muertos: ' + bad.join(', '));
});

/* ---- 2. paridad guard de Atrás <-> registro ---- */
function overlayIdsClosedBy(closeRef) {
  var base = closeRef.split('.').pop();
  var ids = [];
  try {
    var body = fnBody(base);
    var re = /getElementById\('([A-Za-z0-9\-_]+)'\)/g, m;
    while ((m = re.exec(body))) ids.push(m[1]);
  } catch (e) { /* cierre inline: sin cuerpo extraíble */ }
  return ids;
}

test('todo overlay con guard de Atrás está registrado (Atrás/Esc lo cierran)', function () {
  var cands = candidates();
  var managed = {};
  cands.forEach(function (c) {
    managed[c.id] = 1;
    overlayIdsClosedBy(c.closeRef).forEach(function (id) { managed[id] = 1; });
  });
  var lines = src.split('\n');
  var problems = [];
  lines.forEach(function (l, idx) {
    if (l.indexOf('_pushOverlayBackGuard()') === -1) return;
    if (/function _pushOverlayBackGuard/.test(l)) return;
    if (/window\._pushOverlayBackGuard\s*=\s*_pushOverlayBackGuard/.test(l)) return;
    // id del overlay/contenedor más cercano hacia atrás
    var id = null;
    for (var i = idx; i > Math.max(0, idx - 120) && !id; i--) {
      var mm = lines[i].match(/getElementById\('([A-Za-z0-9\-_]+)'\)/);
      if (mm && /(overlay|modal|sheet|view|paywall|viewer)$/.test(mm[1])) id = mm[1];
    }
    if (id && !managed[id]) problems.push('línea ' + (idx + 1) + ': ' + id);
  });
  assert.strictEqual(problems.length, 0,
    'overlays con guard pero sin registro (Atrás/Esc muertos): ' + problems.join('; '));
});

test('los 5 overlays del fix lane-6 siguen registrados', function () {
  var ids = candidates().map(function (c) { return c.id; });
  ['orbit-paywall', 'orbit-view', 'payments-view', 'orbit-analytics-view', 'drex-snap-viewer']
    .forEach(function (id) { assert(ids.indexOf(id) !== -1, id + ' salió de candidatos'); });
});

/* ---- 3. toast: auto-oculta, sin encimados ---- */
test('showMiniToast se auto-oculta y reusa un único elemento', function () {
  var body = fnBody('showMiniToast');
  assert(body.indexOf("getElementById('mini-toast')") !== -1, 'no usa el elemento único #mini-toast');
  assert(body.indexOf('clearTimeout') !== -1, 'no reinicia el timer (toasts encimados)');
  assert(/setTimeout\([\s\S]{0,200}?2000/.test(body), 'no hay auto-ocultado a los 2s');
  assert(body.indexOf("opacity = '0'") !== -1 || body.indexOf('opacity="0"') !== -1,
    'el timer no oculta el toast');
});

/* ---- 4. updater: banner visible por encima de todo ---- */
test('banner "Nueva versión disponible" con z-index máximo y botón funcional', function () {
  assert(src.indexOf('drex-update-banner') !== -1, 'no se crea #drex-update-banner');
  assert(src.indexOf('window.DrexForceUpdate = function') !== -1, 'falta DrexForceUpdate');
  var i = src.indexOf("el.id = 'drex-update-banner'");
  var css = src.slice(i, i + 600);
  assert(/z-index:99999/.test(css), 'el banner no va por encima de todo (z-99999)');
  assert(/DrexForceUpdate\(\)/.test(src.slice(i, i + 2500)), 'el botón no llama a DrexForceUpdate');
});

/* ---- 5. paywall: backdrop real con cierre por tap ---- */
test('orbit-paywall tiene backdrop con cierre por tap', function () {
  var i = src.indexOf('id="orbit-paywall"');
  assert(i !== -1, 'falta #orbit-paywall');
  var html = src.slice(i, i + 400);
  assert(html.indexOf('bg-black/55') !== -1, 'backdrop sin clase de oscurecido');
  assert(html.indexOf('onclick="closeOrbitPaywall()"') !== -1, 'backdrop sin cierre por tap');
});

console.log('\n' + passed + ' pasados, ' + failed + ' fallados');
process.exit(failed ? 1 : 0);
