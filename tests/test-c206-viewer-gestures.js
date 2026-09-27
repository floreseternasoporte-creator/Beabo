/* ================================================================
 * Tests de regresión: gestos compartidos de los visores (2026-09-27)
 * El visor de fotos y el de video comparten umbrales y feedback visual
 * de "deslizar abajo para cerrar" / "pellizco para cerrar" en un solo
 * módulo (drexViewerDismissDrag, drexViewerDismissSnapBack,
 * drexViewerPinchCloseDrag, DREX_VIEWER_*): si los números divergen, el
 * test rompe. Los helpers se extraen de index.html y se ejecutan en
 * sandbox con elementos falsos mínimos.
 * Ejecutar con: node tests/test-c206-viewer-gestures.js
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');

var src = fs.readFileSync(__dirname + '/../index.html', 'utf8');
var startMark = '// ============ GESTOS COMPARTIDOS DE LOS VISORES (fotos + video) ============';
var endMark = '// ---- Visor de video a pantalla completa (reproductor propio) ----';
var start = src.indexOf(startMark);
var end = src.indexOf(endMark);
assert(start !== -1 && end !== -1 && end > start, 'módulo de gestos compartidos no encontrado');
var code = src.slice(start, end);

function fakeEl() { return { style: {} }; }

var sandbox = {
  console: console, Math: Math,
  window: { innerHeight: 800, innerWidth: 400 }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'viewer-gestures.js' });

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

function run(expr) { return vm.runInContext(expr, sandbox); }

/* ---------- Umbrales únicos ---------- */
test('umbrales compartidos: slop 12, dismiss 90, ratio 1.4', function () {
  assert.strictEqual(run('DREX_VIEWER_TAP_SLOP'), 12, 'slop de tap');
  assert.strictEqual(run('DREX_VIEWER_DISMISS_DY'), 90, 'umbral de cierre');
  assert.strictEqual(run('DREX_VIEWER_DISMISS_RATIO'), 1.4, 'ratio dy/dx');
});

test('el visor de fotos usa los umbrales compartidos (sin números propios)', function () {
  var photoStart = src.indexOf("function _setFeedImageModalDismissDrag");
  assert(photoStart !== -1, 'helper de dismiss de fotos no encontrado');
  // El helper delega: no debe contener la fórmula duplicada.
  var body = src.slice(photoStart, photoStart + 700);
  assert(body.indexOf('drexViewerDismissDrag') !== -1, 'delega en drexViewerDismissDrag');
  assert(body.indexOf('dy * 0.85') === -1, 'sin fórmula duplicada del factor 0.85');
  var upStart = src.indexOf('} else if (_feedImageModalZoom === 1 && dy > DREX_VIEWER_DISMISS_DY');
  assert(upStart !== -1, 'el cierre por swipe usa DREX_VIEWER_DISMISS_DY');
});

test('el visor de video usa los umbrales compartidos', function () {
  assert(src.indexOf('if (_videoModalDismissY > DREX_VIEWER_DISMISS_DY)') !== -1,
    'cierre del video por swipe usa DREX_VIEWER_DISMISS_DY');
  assert(src.indexOf('tdy > DREX_VIEWER_TAP_SLOP && tdy > Math.abs(tdx) * DREX_VIEWER_DISMISS_RATIO') !== -1,
    'detección del arrastre del video usa los umbrales compartidos');
});

/* ---------- drexViewerDismissDrag ---------- */
test('dismiss drag: el medio baja con el dedo y el fondo se atenúa', function () {
  run('var __img = ({ style: {} }); var __bd = ({ style: {} });');
  var r = run('drexViewerDismissDrag(__img, __bd, 120)');
  assert.strictEqual(r, true, 'devuelve true cuando aplica');
  var st = run('__img.style');
  assert.strictEqual(st.transform, 'translateY(102.0px)', 'factor 0.85: ' + st.transform);
  assert.strictEqual(st.transition, 'none', 'sin transición durante el arrastre');
  var bd = run('__bd.style');
  // f = 1 - 120/(800*0.55) = 1 - 120/440 = 0.727
  assert.strictEqual(bd.backgroundColor, 'rgba(0,0,0,0.727)', 'atenuación: ' + bd.backgroundColor);
});

test('dismiss drag: dy<=0 no toca nada y devuelve false', function () {
  run('var __img2 = ({ style: { transform: "scale(2)" } }); var __bd2 = ({ style: {} });');
  var r = run('drexViewerDismissDrag(__img2, __bd2, 0)');
  assert.strictEqual(r, false, 'devuelve false');
  assert.strictEqual(run('__img2.style.transform'), 'scale(2)', 'transform intacto');
});

test('dismiss drag: respeta el sufijo extra (rotación de fotos)', function () {
  run('var __img3 = ({ style: {} });');
  run("drexViewerDismissDrag(__img3, null, 100, ' rotate(90deg)')");
  assert.strictEqual(run('__img3.style.transform'), 'translateY(85.0px) rotate(90deg)');
});

/* ---------- drexViewerDismissSnapBack ---------- */
test('snap-back: restaura el medio y el fondo con animación', function () {
  run('var __img4 = ({ style: { transform: "translateY(50px)", transition: "none" } }); var __bd4 = ({ style: { backgroundColor: "rgba(0,0,0,0.5)" } });');
  run('drexViewerDismissSnapBack(__img4, __bd4, function () { __img4.style.transform = "scale(2)"; }, false)');
  assert.strictEqual(run('__img4.style.transform'), 'scale(2)', 'restoreMedia aplicado');
  assert.strictEqual(run('__img4.style.transition'), 'transform .22s ease-out', 'animación de regreso');
  assert.strictEqual(run('__bd4.style.backgroundColor'), '', 'fondo a negro puro');
});

test('snap-back instantáneo (sin animación)', function () {
  run('var __img5 = ({ style: {} }); var __bd5 = ({ style: {} });');
  run('drexViewerDismissSnapBack(__img5, __bd5, null, true)');
  assert.strictEqual(run('__img5.style.transition'), 'none');
  assert.strictEqual(run('__img5.style.transform'), '');
});

/* ---------- drexViewerPinchCloseDrag ---------- */
test('pinch-close: el medio se encoge y el fondo se atenúa con la escala', function () {
  run('var __img6 = ({ style: {} }); var __bd6 = ({ style: {} });');
  run('drexViewerPinchCloseDrag(__img6, __bd6, 0.5)');
  assert.strictEqual(run('__img6.style.transform'), 'scale(0.500)');
  assert.strictEqual(run('__bd6.style.backgroundColor'), 'rgba(0,0,0,0.500)');
});

test('pinch-close: la escala tiene piso en 0.35', function () {
  run('var __img7 = ({ style: {} });');
  run('drexViewerPinchCloseDrag(__img7, null, 0.1)');
  assert.strictEqual(run('__img7.style.transform'), 'scale(0.350)', 'no colapsa a un punto');
});

console.log('\nRESULTADO: ' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
