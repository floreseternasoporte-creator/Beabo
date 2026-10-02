/* test-ui-structure.js — chequeo estructural global del HTML servido.
 *
 * Regresiones que fija (auditoría overlays 2026-10-01, carril 6):
 * 1. Tags <style>/<script> sin cerrar: una vez 2 <style> sin cerrar se
 *    tragaron 3 <script> enteros y media app quedó muerta. El parseo respeta
 *    la semántica raw-text de HTML (<script>/<style> literales dentro de
 *    comentarios o strings NO cuentan como aperturas).
 * 2. onclick="..." que referencia funciones inexistentes (taps muertos):
 *    antecedente de funciones atrapadas en IIFEs sin exportar a window.
 *    También se aceptan exposiciones dinámicas (window.x=, window['x']=,
 *    baro6dExpose('x',...)).
 *
 * Uso: node tests/test-ui-structure.js   (código 0 = todo OK)
 */
'use strict';
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var ROOT = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// Los comentarios HTML no generan tags.
var noC = src.replace(/<!--[\s\S]*?-->/g, '');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

/* ---- 1. balance <style>/<script> con semántica raw-text ---- */
function rawTextBalance(tag) {
  var openRe = new RegExp('<' + tag + '[\\s>]', 'gi');
  var closeRe = new RegExp('</' + tag + '>', 'gi');
  var ev = [], m;
  while ((m = openRe.exec(noC))) ev.push({ t: 'o', i: m.index });
  while ((m = closeRe.exec(noC))) ev.push({ t: 'c', i: m.index });
  ev.sort(function (a, b) { return a.i - b.i; });
  var inside = false, openAt = 0;
  var unclosed = [], orphan = [];
  for (var k = 0; k < ev.length; k++) {
    var e = ev[k];
    if (!inside) {
      if (e.t === 'o') { inside = true; openAt = e.i; }
      else orphan.push(e.i);
    } else if (e.t === 'c') { inside = false; }
    // aperturas dentro de raw-text se ignoran (p. ej. "<script>" en un comentario JS)
  }
  if (inside) unclosed.push(openAt);
  return { unclosed: unclosed, orphan: orphan };
}

test('tags <style> balanceados (raw-text)', function () {
  var b = rawTextBalance('style');
  assert.strictEqual(b.unclosed.length, 0, 'style sin cerrar en ' + JSON.stringify(b.unclosed));
  assert.strictEqual(b.orphan.length, 0, 'cierre </style> huérfano en ' + JSON.stringify(b.orphan));
});

test('tags <script> balanceados (raw-text)', function () {
  var b = rawTextBalance('script');
  assert.strictEqual(b.unclosed.length, 0, 'script sin cerrar en ' + JSON.stringify(b.unclosed));
  assert.strictEqual(b.orphan.length, 0, 'cierre </script> huérfano en ' + JSON.stringify(b.orphan));
});

test('ningún </script> literal dentro de strings JS (rompería el bloque)', function () {
  // Un </script> dentro de un string cerraría el bloque antes de tiempo en el
  // parseo real. Los bloques del repo evitan el literal a propósito.
  // Un cierre legítimo nunca va precedido de una comilla.
  var bad = [];
  var re = /['"`]<\/script>/g, m;
  while ((m = re.exec(src))) {
    var lineStart = src.lastIndexOf('\n', m.index) + 1;
    bad.push(src.slice(lineStart, m.index + 10).trim().slice(0, 90));
  }
  assert.strictEqual(bad.length, 0, 'posibles </script> embebidos: ' + JSON.stringify(bad.slice(0, 3)));
});

/* ---- 2. onclick -> función global existente ---- */
function collectGlobals() {
  var g = new Set(), r;
  var fre = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((r = fre.exec(src))) g.add(r[1]);
  var wre = /\bwindow\.([A-Za-z_$][\w$]*)\s*=/g;
  while ((r = wre.exec(src))) g.add(r[1]);
  var wre2 = /\bwindow\[['"]([A-Za-z_$][\w$]*)['"]\]\s*=/g;
  while ((r = wre2.exec(src))) g.add(r[1]);
  // Exposición dinámica usada por los bloques de Baro.
  var ere = /\bbaro6dExpose\s*\(\s*['"]([A-Za-z_$][\w$]*)['"]/g;
  while ((r = ere.exec(src))) g.add(r[1]);
  return g;
}

test('todos los onclick referencian funciones globales existentes', function () {
  var globals = collectGlobals();
  var handlers = [];
  var re = /\sonclick\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, m;
  while ((m = re.exec(noC))) handlers.push(m[1] !== undefined ? m[1] : m[2]);
  assert(handlers.length > 100, 'se esperaban cientos de onclick, hallados: ' + handlers.length);
  var KEYWORDS = { 'if': 1, 'for': 1, 'while': 1, 'switch': 1, 'catch': 1, 'do': 1, 'else': 1,
    'return': 1, 'typeof': 1, 'void': 1, 'delete': 1, 'new': 1, 'in': 1, 'of': 1,
    'var': 1, 'let': 1, 'const': 1, 'this': 1, 'event': 1 };
  var missing = {};
  handlers.forEach(function (h) {
    var hh = h.trim().replace(/;+$/, '');
    var name = null;
    var cm = hh.match(/^([A-Za-z_$][\w$]*)\s*\(/);
    if (cm) name = cm[1];
    else if (/^[A-Za-z_$][\w$]*$/.test(hh)) name = hh;
    if (!name || KEYWORDS[name]) return;
    if (!globals.has(name)) missing[name] = (missing[name] || 0) + 1;
  });
  var names = Object.keys(missing).sort();
  assert.strictEqual(names.length, 0,
    'onclick con función inexistente (taps muertos): ' +
    names.map(function (n) { return n + ' x' + missing[n]; }).join(', '));
});

/* ---- 3. cobertura Tailwind de los overlays del carril ---- */
test('clases Tailwind usadas por overlays generados en JS tienen regla', function () {
  // Regresión lane-6: el purge no vio estas clases (HTML generado en JS) y el
  // backdrop del paywall era transparente + los CTA medían 23px.
  var need = ['bg-black/55', 'bg-yellow-400/20', 'min-h-[52px]', 'mx-5', 'text-white/30', 'text-white/75'];
  function escSel(cls) {
    return '.' + cls.replace(/\\/g, '\\\\').replace(/\//g, '\\/').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
  }
  var missingCls = need.filter(function (c) { return src.indexOf(escSel(c) + '{') === -1; });
  assert.strictEqual(missingCls.length, 0, 'sin regla en el CSS: ' + missingCls.join(', '));
});

console.log('\n' + passed + ' pasados, ' + failed + ' fallados');
process.exit(failed ? 1 : 0);
