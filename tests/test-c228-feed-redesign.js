/* ================================================================
 * Tests Drex C228 — rediseño del feed (carril 3, 2026-10-01)
 * Ejecutar con: node tests/test-c228-feed-redesign.js
 *
 * C246 (2026-10-03): el rediseño C228 se REVERTIÓ el mismo 2026-10-01
 * (rompía el feed a 390px: divs de más y desbordes) y la app volvió a
 * la tarjeta clásica byte-idéntica. Los archivos lane del rediseño
 * (feed-redesign.css/js/i18n.js, fragments/) nunca se commitearon y ya
 * no existen; el test original (que los validaba) quedó sin objeto.
 * Este archivo fija ahora el contrato vigente:
 *   - la tarjeta clásica sigue siendo el render del feed;
 *   - el ranking C229 (conservado tras el revert) sigue presente;
 *   - ninguna referencia al rediseño feed-redesign vive en el build.
 * Si el rediseño vuelve algún día, se reescribe este test con él.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

test('tarjeta clásica: snfMountFeedPost es el render del feed', function () {
  assert(src.indexOf('function snfMountFeedPost(') !== -1, 'falta el builder clásico');
  assert(src.indexOf('drexNoteHasRenderableContent(note)') !== -1, 'falta el filtro de notas vacías');
});

test('ranking C229 conservado tras el revert (drexRecScore)', function () {
  assert(src.indexOf('drexRecScore') !== -1, 'falta drexRecScore');
});

test('sin referencias al rediseño C228 en el build', function () {
  assert(src.indexOf('feed-redesign') === -1, 'quedan referencias a feed-redesign');
  var i18n = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');
  assert(i18n.indexOf('feed-redesign') === -1, 'quedan referencias a feed-redesign en i18n');
});

console.log('\n' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
