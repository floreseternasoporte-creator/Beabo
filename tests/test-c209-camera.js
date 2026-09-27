/* ================================================================
 * Tests de regresión: DREX-CAM v1 — cámara propia de Drex (2026-09-27)
 * El icono de cámara del composer abre el modal propio (getUserMedia +
 * MediaRecorder) en vez del input file nativo; los iconos de foto/video
 * siguen abriendo el selector de archivos. El bloque se extrae de
 * index.html y se ejecuta en sandbox: lo puro (límite de 60 s, anillo,
 * normalización de efectos, pipeline no-op con catálogo vacío) se prueba
 * sin DOM; el HTML y el i18n se verifican por texto.
 * Ejecutar con: node tests/test-c209-camera.js [--target <ruta-index.html>]
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var path = require('path');

var target = path.join(__dirname, '..', 'index.html');
var ti = process.argv.indexOf('--target');
if (ti !== -1 && process.argv[ti + 1]) target = process.argv[ti + 1];
var src = fs.readFileSync(target, 'utf8');

var i18nPath = path.join(path.dirname(target), 'drex-i18n.js');
if (!fs.existsSync(i18nPath)) i18nPath = path.join(__dirname, '..', 'drex-i18n.js');

var startMark = '/* === DREX-CAM v1';
var endMark = '/* === FIN DREX-CAM v1 === */';
var start = src.indexOf(startMark);
var end = src.indexOf(endMark);
assert(start !== -1 && end !== -1 && end > start, 'bloque DREX-CAM v1 no encontrado en ' + target);
var code = src.slice(start, end);

var sandbox = {
  console: console, Math: Math, Date: Date, JSON: JSON,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  setInterval: setInterval, clearInterval: clearInterval,
  window: {}
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'drex-cam.js' });

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}
function run(expr) { return vm.runInContext(expr, sandbox); }

/* ---------- Límite de grabación ---------- */
test('DREX_CAM_MAX_VIDEO_SEC es 60 y es global', function () {
  assert.strictEqual(run('DREX_CAM_MAX_VIDEO_SEC'), 60, 'límite 60 s');
  assert.strictEqual(run('typeof DREX_CAM_MAX_VIDEO_SEC'), 'number');
});

test('drexCamTick: 0s -> 60 restantes, frac 0, no done', function () {
  var t = run('drexCamTick(0)');
  assert.strictEqual(t.remaining, 60);
  assert.strictEqual(t.frac, 0);
  assert.strictEqual(t.done, false);
});

test('drexCamTick: 30s -> 30 restantes, frac 0.5', function () {
  var t = run('drexCamTick(30)');
  assert.strictEqual(t.remaining, 30);
  assert.strictEqual(t.frac, 0.5);
  assert.strictEqual(t.done, false);
});

test('drexCamTick: 60s -> done, 0 restantes; más allá se recorta', function () {
  var t = run('drexCamTick(60)');
  assert.strictEqual(t.done, true);
  assert.strictEqual(t.remaining, 0);
  assert.strictEqual(t.frac, 1);
  var t2 = run('drexCamTick(999)');
  assert.strictEqual(t2.done, true);
  assert.strictEqual(t2.elapsed, 60, 'recorte al máximo');
});

test('drexCamRingOffset: 0 -> C completa, 1 -> 0, 0.5 -> mitad', function () {
  assert.strictEqual(run('drexCamRingOffset(0, 238.76)'), 238.76);
  assert.strictEqual(run('drexCamRingOffset(1, 238.76)'), 0);
  assert.strictEqual(run('drexCamRingOffset(0.5, 200)'), 100);
});

/* ---------- Efectos: normalización y pipeline ---------- */
test('drexCamNormalizeEffects: null/no-objeto -> []', function () {
  // Nota: el array viene de otro realm (vm); se compara por longitud.
  assert.strictEqual(run('drexCamNormalizeEffects(null).length'), 0);
  assert.strictEqual(run('drexCamNormalizeEffects("x").length'), 0);
});

test('drexCamNormalizeEffects: snapshot del backend -> array con id/nombre', function () {
  var out = run('drexCamNormalizeEffects({a:{name:"Neon"},b:{id:"custom",name:"Retro",filter:"sepia(.8)"}})');
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].id, 'a');
  assert.strictEqual(out[0].name, 'Neon');
  assert.strictEqual(out[1].id, 'custom', 'respeta id explícito');
  assert.strictEqual(out[1].filter, 'sepia(.8)');
});

test('drexCamEffectToFilter: no-op documentado con catálogo vacío', function () {
  assert.strictEqual(run('drexCamEffectToFilter(null)'), '');
  assert.strictEqual(run('drexCamEffectToFilter({})'), '');
  assert.strictEqual(run('drexCamEffectToFilter({filter:"  sepia(1)  "})'), 'sepia(1)');
});

test('drexCamPickRecorderMime: prefiere mp4 cuando el navegador lo soporta', function () {
  run('var __MR = function(){}; __MR.isTypeSupported = function(m){ return m === "video/mp4"; }; var MediaRecorder = __MR;');
  assert.strictEqual(run('drexCamPickRecorderMime()'), 'video/mp4');
  run('var MediaRecorder = undefined;');
  assert.strictEqual(run('drexCamPickRecorderMime()'), '', 'sin MediaRecorder -> cadena vacía');
});

test('drexCamExtFor: mp4 -> .mp4, resto -> .webm', function () {
  assert.strictEqual(run('drexCamExtFor("video/mp4")'), '.mp4');
  assert.strictEqual(run('drexCamExtFor("video/webm")'), '.webm');
  assert.strictEqual(run('drexCamExtFor("")'), '.webm');
});

/* ---------- API global expuesta ---------- */
test('window.drexCameraOpen y window.drexApplyEffect expuestos', function () {
  assert.strictEqual(run('typeof drexCameraOpen'), 'function');
  assert.strictEqual(run('typeof drexApplyEffect'), 'function');
  assert.strictEqual(run('window.drexCameraOpen === drexCameraOpen'), true);
  assert.strictEqual(run('window.drexApplyEffect === drexApplyEffect'), true);
});

test('todas las funciones de los onclick del modal existen', function () {
  var fns = ['drexCameraOpen', 'drexCameraClose', 'drexCameraRetry',
    'drexCameraUploadFallback', 'drexCameraSwitchMode', 'drexCameraFlip',
    'drexCameraToggleEffects', 'drexCameraCloseEffects', 'drexCameraCapture',
    'drexCameraSelectEffect', 'drexApplyEffect'];
  fns.forEach(function (f) {
    assert.strictEqual(run('typeof ' + f), 'function', f + ' no definida');
  });
});

/* ---------- HTML del modal ---------- */
test('el icono de cámara abre drexCameraOpen(); foto/video intactos', function () {
  assert(src.indexOf('<button id="tool-camera" onclick="drexCameraOpen()"') !== -1,
    'tool-camera debe llamar a drexCameraOpen()');
  assert(src.indexOf('onclick="pickNoteImageFromCamera()"') === -1,
    'ya no debe quedar el input nativo en el icono de cámara');
  assert(src.indexOf('<button id="tool-media" onclick="pickNoteMedia()"') !== -1,
    'tool-media (foto/video) sigue abriendo el selector de archivos');
});

test('modal: IDs requeridos y preview playsinline+muted', function () {
  var ids = ['drex-cam-modal', 'drex-cam-preview', 'drex-cam-effect-layer',
    'drex-cam-error', 'drex-cam-retry', 'drex-cam-upload',
    'drex-cam-topbar', 'drex-cam-close', 'drex-cam-mode-photo', 'drex-cam-mode-video',
    'drex-cam-flip', 'drex-cam-progress-wrap', 'drex-cam-progress-fill',
    'drex-cam-countdown', 'drex-cam-countdown-num',
    'drex-cam-effects-panel', 'drex-cam-effects-panel-inner', 'drex-cam-effects-title',
    'drex-cam-effects-list', 'drex-cam-effects-empty', 'drex-cam-effects-close',
    'drex-cam-controls', 'drex-cam-effects-btn', 'drex-cam-capture',
    'drex-cam-ring-svg', 'drex-cam-ring-fg', 'drex-cam-capture-icon', 'drex-cam-capture-rec'];
  ids.forEach(function (id) {
    assert(src.indexOf('id="' + id + '"') !== -1, 'falta id="' + id + '"');
  });
  var vpos = src.indexOf('id="drex-cam-preview"');
  var vtag = src.slice(vpos, vpos + 200);
  assert(vtag.indexOf('playsinline') !== -1, 'preview sin playsinline');
  assert(vtag.indexOf('muted') !== -1, 'preview sin muted');
});

test('getElementById estáticos del bloque resuelven a IDs del DOM', function () {
  var re = /getElementById\('([A-Za-z0-9_-]+)'\)/g;
  var m, missing = [];
  while ((m = re.exec(code)) !== null) {
    if (src.indexOf('id="' + m[1] + '"') === -1) missing.push(m[1]);
  }
  assert(missing.length === 0, 'IDs sin elemento: ' + missing.join(', '));
});

test('efecto: el panel es de media pantalla y hay estado vacío diseñado', function () {
  assert(src.indexOf('id="drex-cam-effects-panel"') !== -1);
  assert(src.indexOf('max-height:52%') !== -1, 'panel de media pantalla');
  assert(src.indexOf('Aún no hay efectos') !== -1, 'estado vacío');
});

/* ---------- i18n ES/EN/ZH/PT ---------- */
test('todo appT del bloque tiene clave en los 3 diccionarios', function () {
  var i18n = fs.readFileSync(i18nPath, 'utf8');
  function dict(varName, nextVar) {
    var s0 = i18n.indexOf(varName);
    var s1 = i18n.indexOf(nextVar, s0);
    var sec = i18n.slice(s0, s1);
    var close = sec.lastIndexOf('\n};');
    var obj = new Function('return (' + sec.slice(sec.indexOf('{'), close + 2) + ');')();
    return obj;
  }
  var EN = dict('var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {');
  var ZH = dict('var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {');
  var PT = dict('var APP_PORTUGUESE_TEXT = {', 'var APP_CHINESE_ATTRS = {');
  var re = /appT\('((?:[^'\\]|\\.)*)'\)/g;
  var m, missing = [];
  while ((m = re.exec(code)) !== null) {
    var k = m[1];
    if (!(k in EN) || !(k in ZH) || !(k in PT)) missing.push(k);
  }
  assert(missing.length === 0, 'claves sin traducción EN/ZH/PT: ' + missing.join(' / '));
});

test('sin mención a SpaceX en el bloque', function () {
  assert(code.toLowerCase().indexOf('spacex') === -1, 'SpaceX mencionado');
});

console.log('\n' + passed + ' pasados, ' + failed + ' fallidos');
process.exit(failed ? 1 : 0);
