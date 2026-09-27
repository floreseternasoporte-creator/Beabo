/* ================================================================
 * Tests de regresión: diamantes de Destellos C220c (2026-09-27)
 * Compatibilidad iOS: iOS Safari solo entiende `clip-path` sin
 * prefijo desde iOS 16. En iOS 15 o menor la regla se ignora y
 * los diamantes (.drex-snap-ring, .drex-snap-photo, .drex-snap-skel)
 * se verían como CUADRADOS. Cada `clip-path: polygon(...)` debe
 * tener su gemelo `-webkit-clip-path` con el MISMO polígono en la
 * línea inmediata anterior (el prefijo cubre iOS 9.1+).
 * Verifica sin navegador. Ejecutar con: node tests/test-c220c-diamonds.js
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var target = path.join(__dirname, '..', 'index.html');
var src = fs.readFileSync(target, 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

// ---- Extraer el bloque de estilos de Destellos ----
var m = src.match(/<style id="drex-snap-style">([\s\S]*?)<\/style>/);
assert(m, 'bloque <style id="drex-snap-style"> no encontrado en ' + target);
var css = m[1];
var lines = css.split('\n');

var SELECTORS = ['.drex-snap-ring', '.drex-snap-photo', '.drex-snap-skel'];
var POLYGON = 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)';

// Líneas con clip-path SIN prefijo (solo polygon, ignorar p. ej. clip-path: none)
var bare = [];
for (var i = 0; i < lines.length; i++) {
  var t = lines[i].trim();
  if (/^clip-path:\s*polygon\(/.test(t)) bare.push({ idx: i, line: t });
}

test('exactamente 3 clip-path polygon en la región Destellos', function () {
  assert.strictEqual(bare.length, 3,
    'se esperaban 3, hay ' + bare.length + ': ' + JSON.stringify(bare.map(function (b) { return b.line; })));
});

test('ningún -webkit-clip-path duplicado ni suelto', function () {
  var prefixed = lines.filter(function (l) { return /^\s*-webkit-clip-path:\s*polygon\(/.test(l); });
  assert.strictEqual(prefixed.length, bare.length,
    'prefijadas=' + prefixed.length + ' vs sin prefijo=' + bare.length);
});

// ---- Extraer cada bloque de selector dentro del style ----
function ruleBody(selector) {
  var re = new RegExp('(^|\\n)\\s*' + selector.replace(/\./g, '\\.') + '\\s*\\{([^}]*)\\}');
  var mm = css.match(re);
  assert(mm, 'selector ' + selector + ' no encontrado en el bloque Destellos');
  return mm[2];
}

SELECTORS.forEach(function (sel) {
  test(sel + ' tiene -webkit-clip-path con el mismo polígono', function () {
    var body = ruleBody(sel);
    assert(new RegExp('-webkit-clip-path:\\s*' + POLYGON.replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/%/g, '\\%') + ';').test(body),
      sel + ': falta -webkit-clip-path con ' + POLYGON);
    assert(body.indexOf('clip-path: ' + POLYGON + ';') !== -1,
      sel + ': falta clip-path sin prefijo con ' + POLYGON);
  });
});

bare.forEach(function (b) {
  test('gemelo -webkit-clip-path en la línea inmediata anterior (línea ' + (b.idx + 1) + ')', function () {
    assert(b.idx > 0, 'clip-path en la primera línea del bloque, sin línea anterior');
    var prev = lines[b.idx - 1].trim();
    var poly = b.line.match(/polygon\([^)]*\)/)[0];
    var expected = '-webkit-clip-path: ' + poly + ';';
    assert.strictEqual(prev, expected,
      'línea anterior: «' + prev + '», se esperaba: «' + expected + '»');
  });
});

test('ningún clip-path sin prefijo suelto en el bloque Destellos', function () {
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (!/^clip-path:\s*polygon\(/.test(t)) continue;
    assert(i > 0 && /^-webkit-clip-path:\s*polygon\(/.test(lines[i - 1].trim()),
      'clip-path sin gemelo -webkit en la línea ' + (i + 1));
  }
});

console.log('\n' + passed + ' pasadas, ' + failed + ' fallidas');
process.exit(failed ? 1 : 0);
