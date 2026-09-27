/* ================================================================
 * Tests de regresión: C216 fix del "cuadrito" (2026-09-27)
 * El input del chat mostraba un rectángulo (anillo/box-shadow nativo
 * sobre el input cuadrado) DENTRO de la píldora redondeada.
 * Causa raíz: la regla B2 `input:focus-visible { box-shadow: ... }`
 * dibujaba el anillo índigo sobre el input (rectángulo sin radio)
 * en vez de sobre el contenedor redondeado; además textarea/select/
 * contenteditable no estaban en el sistema de foco y usaban el
 * outline nativo del navegador.
 * Verifica sin navegador. Ejecutar con: node tests/test-c216-cuadrito.js
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var target = path.join(__dirname, '..', 'index.html');
var src = fs.readFileSync(target, 'utf8');

// Extraer todo el CSS de los <style> del documento
var css = '';
src.replace(/<style[^>]*>([\s\S]*?)<\/style>/g, function (_, body) { css += '\n' + body; return ''; });
assert(css.length > 1000, 'no se encontró CSS en index.html');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

// (1) Los campos fantasma no llevan anillo propio en :focus-visible
test('regla neutraliza box-shadow en input.bg-transparent:focus-visible', function () {
  assert(/input\.bg-transparent:focus-visible[\s\S]{0,120}?box-shadow:\s*none/.test(css),
    'falta la regla input.bg-transparent:focus-visible { box-shadow: none }');
});
test('regla neutraliza box-shadow en textarea.bg-transparent:focus-visible', function () {
  assert(/textarea\.bg-transparent:focus-visible[\s\S]{0,200}?box-shadow:\s*none/.test(css),
    'falta la regla textarea.bg-transparent:focus-visible { box-shadow: none }');
});

// (2) El contenedor redondeado muestra el anillo índigo con :focus-within
test('regla .drex-pill-field:focus-within con anillo índigo', function () {
  var m = css.match(/\.drex-pill-field:focus-within\s*\{([^}]*)\}/);
  assert(m, 'falta la regla .drex-pill-field:focus-within');
  assert(/box-shadow/.test(m[1]) && /drex-brand/.test(m[1]),
    '.drex-pill-field:focus-within debe usar box-shadow con --drex-brand');
});

// (3) textarea/select/contenteditable entran al sistema de foco Drex (sin outline nativo)
test('textarea:focus-visible usa anillo Drex, no outline nativo', function () {
  assert(/textarea:focus-visible[\s\S]{0,200}?outline:\s*none/.test(css),
    'textarea:focus-visible debe anular el outline nativo');
});
test('select:focus-visible usa anillo Drex, no outline nativo', function () {
  assert(/select:focus-visible[\s\S]{0,200}?outline:\s*none/.test(css),
    'select:focus-visible debe anular el outline nativo');
});
test('[contenteditable]:focus-visible usa anillo Drex, no outline nativo', function () {
  assert(/\[contenteditable="true"\]:focus-visible[\s\S]{0,200}?outline:\s*none/.test(css),
    '[contenteditable="true"]:focus-visible debe anular el outline nativo');
});

// (4) Accesibilidad: el sistema de foco por teclado sigue existiendo para inputs normales
test('persiste el anillo de foco-visible global para input (a11y teclado)', function () {
  assert(/input:focus-visible\s*\{\s*outline:\s*none;\s*box-shadow:[^}]*drex-brand/.test(css),
    'la regla B2 input:focus-visible con anillo índigo debe seguir existiendo');
});

// (5) Cada campo fantasma vive dentro de un contenedor .drex-pill-field
var ghostInputs = ['chat-room-input', 'fiesta-chat-input', 'gif-search-input',
  'music-explore-input', 'search-input', 'sticker-search'];
ghostInputs.forEach(function (id) {
  test('input fantasma #' + id + ' envuelto en .drex-pill-field', function () {
    var idx = src.indexOf('id="' + id + '"');
    assert(idx > 0, 'no existe el input #' + id);
    var divIdx = src.lastIndexOf('<div', idx);
    assert(divIdx > 0, 'no hay <div> contenedor antes de #' + id);
    var tagEnd = src.indexOf('>', divIdx);
    var divTag = src.slice(divIdx, tagEnd);
    var cm = divTag.match(/class="([^"]*)"/);
    assert(cm && cm[1].split(/\s+/).indexOf('drex-pill-field') !== -1,
      'el contenedor de #' + id + ' no tiene la clase drex-pill-field');
  });
});

// (6) El input del chat NO tiene radio propio que justifique un anillo rectangular:
//     el anillo va en el contenedor (verificación de diseño)
test('el wrapper del chat es rounded-full (el anillo sigue su forma)', function () {
  var idx = src.indexOf('id="chat-room-input"');
  var divIdx = src.lastIndexOf('<div', idx);
  var divTag = src.slice(divIdx, src.indexOf('>', divIdx));
  assert(/rounded-full/.test(divTag), 'el wrapper del chat debe ser rounded-full');
});

console.log('\n' + passed + ' pasados, ' + failed + ' fallados');
process.exit(failed ? 1 : 0);
