/* ================================================================
 * Tests de regresión: C217 auditoría y redibujo de íconos (2026-09-27)
 * - La cámara propia (C209) tenía el path del cuerpo de la cámara
 *   MALFORMADO (arco duplicado) en 2 lugares: se veía horrible.
 * - Íconos de voltear cámara y efectos redibujados (trazos limpios).
 * - Nuevo botón de flash con soporte torch (se muestra solo si el
 *   dispositivo lo soporta).
 * - Drex Studio: tarjeta "Plantillas de juego" tenía un remolino sin
 *   sentido -> gamepad; "Detección facial" -> marco de escaneo facial.
 * Verifica sin navegador. Ejecutar con: node tests/test-c217-icons.js
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

// (1) El path malformado de la cámara NO debe existir en ningún lado
test('sin path de cámara malformado (arco duplicado)', function () {
  assert(src.indexOf('a2 2 0 012 2v9a2 2 0 012 2v9') === -1,
    'persiste el path malformado con el arco duplicado');
});

// (2) El path correcto de la cámara existe (modal + composer)
test('path de cámara correcto presente', function () {
  var good = 'H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z';
  var n = src.split(good).length - 1;
  assert(n >= 3, 'se esperaban >=3 cámaras correctas (modal error, captura, composer), hay ' + n);
});

// (3) Íconos clave de la cámara existen con viewBox válido
// C220: drex-cam-effects-btn/close eliminados (tira superior fx-topbar en su lugar)
['drex-cam-close', 'drex-cam-flip', 'drex-cam-flash',
 'drex-cam-capture'].forEach(function (id) {
  test('botón de cámara con SVG válido: ' + id, function () {
    var re = new RegExp('<button[^>]*id="' + id + '"[\\s\\S]{0,900}?<svg[^>]*viewBox="0 0 24 24"');
    assert(re.test(src), 'falta SVG con viewBox 0 0 24 24 en #' + id);
  });
});

// (4) Ícono de voltear redibujado (arcos simétricos, sin el refresh genérico viejo)
test('ícono voltear-cámara redibujado', function () {
  assert(src.indexOf('M4.8 9a7.5 7.5 0 0114.4 0') !== -1, 'falta el arco superior del nuevo ícono');
  assert(src.indexOf('M4 4v6h6M20 20v-6h-6') === -1, 'persiste el ícono viejo de voltear');
});

// (5) Tira de efectos C220 ELIMINADA en Fase 2 (con todos los efectos de cámara)
test('tira de efectos C220 ausente', function () {
  assert(src.indexOf('drex-cam-fx-topbar') === -1, 'persiste #drex-cam-fx-topbar (debió eliminarse en Fase 2)');
  assert(src.indexOf('drex-cam-fx-list') === -1, 'persiste #drex-cam-fx-list (debió eliminarse en Fase 2)');
});

// (6) Flash: botón + función + cableado
test('botón de flash con estados on/off', function () {
  assert(src.indexOf('id="drex-cam-flash"') !== -1, 'falta #drex-cam-flash');
  assert(src.indexOf('drex-cam-flash-on') !== -1 && src.indexOf('drex-cam-flash-off') !== -1,
    'faltan los estados on/off del flash');
  assert(src.indexOf('onclick="drexCameraToggleFlash()"') !== -1, 'falta el handler del flash');
});
test('JS de flash: toggle + detección torch + hooks', function () {
  assert(/function drexCameraToggleFlash\(\)/.test(src), 'falta drexCameraToggleFlash');
  assert(/function drexCamUpdateFlashBtn\(\)/.test(src), 'falta drexCamUpdateFlashBtn');
  assert(/getCapabilities\(\)\.torch/.test(src), 'falta la detección de torch');
  assert(/applyConstraints\(\{ advanced: \[\{ torch:/.test(src), 'falta applyConstraints torch');
});

// (7)-(8) Drex Studio ELIMINADO en Fase 3: las tarjetas "Plantillas de juego" y
// "Detección facial" ya no existen; se verifica su ausencia.
test('tarjetas de Drex Studio ausentes', function () {
  assert(src.indexOf('Plantillas de juego') === -1, 'persiste la tarjeta Plantillas de juego (Fase 3)');
  assert(src.indexOf('Detección facial') === -1, 'persiste la tarjeta Detección facial (Fase 3)');
});

// (9) Todos los SVG del modal de cámara tienen viewBox
test('todos los SVG del modal de cámara tienen viewBox', function () {
  var start = src.indexOf('id="drex-cam-modal"');
  var end = src.indexOf('FIN DREX-CAM v1');
  assert(start !== -1 && end > start, 'no se encontró el modal de cámara');
  var block = src.slice(start, end);
  var svgs = block.match(/<svg\b[^>]*>/g) || [];
  assert(svgs.length >= 6, 'se esperaban >=6 SVG en el modal, hay ' + svgs.length);
  svgs.forEach(function (tag, k) {
    assert(tag.indexOf('viewBox') !== -1, 'SVG #' + k + ' del modal sin viewBox: ' + tag.slice(0, 60));
  });
});

// (10) stroke-widths dentro del rango del sistema de diseño (1.5–2.5) en cámara
test('trazos de la cámara dentro del sistema (1.5-2.5)', function () {
  var start = src.indexOf('id="drex-cam-modal"');
  var end = src.indexOf('FIN DREX-CAM v1');
  var block = src.slice(start, end);
  var bad = [];
  block.replace(/<svg\b[^>]*stroke-width="([\d.]+)"/g, function (_, w) {
    var f = parseFloat(w);
    if (f < 1.5 || f > 2.5) bad.push(w);
    return '';
  });
  assert(bad.length === 0, 'stroke-width fuera de rango: ' + bad.join(','));
});

console.log('\n' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
