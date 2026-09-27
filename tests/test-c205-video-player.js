/* ================================================================
 * Tests de regresión: visor de video (2026-09-27)
 * P1: la reproducción usa Blob/Object URL en vez de la data URL gigante
 *     (las data URL de varios MB son frágiles en móviles: iOS las rechaza
 *     en silencio y el player dispara 'error' -> "no funciona").
 * P2: el visor hereda los gestos del visor de fotos: deslizar abajo para
 *     cerrar (mismo umbral DREX_VIEWER_DISMISS_DY), pellizco hacia adentro
 *     para cerrar, doble tap = play/pausa, tap = chrome.
 * P3: al cerrar se revoca el Object URL y se limpia el estado de gestos.
 * El bloque se extrae de index.html y se ejecuta en una sandbox con un
 * DOM mínimo falso. Ejecutar con: node tests/test-c205-video-player.js
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');

var src = fs.readFileSync(__dirname + '/../index.html', 'utf8');
var startMark = '// ============ GESTOS COMPARTIDOS DE LOS VISORES (fotos + video) ============';
var endMark = '// Negro puro, chrome mínimo (X + contador + puntos), swipe horizontal entre';
var start = src.indexOf(startMark);
var end = src.indexOf(endMark);
assert(start !== -1 && end !== -1 && end > start, 'marcas del bloque de video no encontradas');
var code = src.slice(start, end);

function makeEl(id) {
  var classes = new Set();
  var listeners = {};
  return {
    id: id,
    style: {},
    dataset: {},
    classList: {
      add: function (c) { classes.add(c); },
      remove: function (c) { classes.delete(c); },
      contains: function (c) { return classes.has(c); },
      toggle: function (c, f) { if (f === undefined) f = !classes.has(c); if (f) classes.add(c); else classes.delete(c); return f; }
    },
    addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: function () {},
    setPointerCapture: function () {},
    releasePointerCapture: function () {},
    // API de <video> falsa
    paused: true,
    playbackRate: 1,
    currentTime: 0,
    duration: 0,
    src: '',
    play: function () { this.paused = false; (listeners['playing'] || []).forEach(function (f) { f(); }); return Promise.resolve(); },
    pause: function () { this.paused = true; (listeners['pause'] || []).forEach(function (f) { f(); }); },
    load: function () {},
    removeAttribute: function () {},
    textContent: '',
    value: 0,
    _classes: classes,
    _listeners: listeners
  };
}

var els = {};
['video-modal', 'video-modal-stage', 'video-modal-player', 'video-modal-bigplay',
 'video-modal-playbtn', 'video-modal-mutebtn', 'video-modal-seek', 'video-modal-cur',
 'video-modal-dur', 'video-modal-loading', 'video-modal-2x', 'video-modal-x',
 'video-modal-title'].forEach(function (id) { els[id] = makeEl(id); });

var sandbox = {
  console: console,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  setInterval: setInterval, clearInterval: clearInterval,
  Date: Date, Math: Math, Map: Map, Uint8Array: Uint8Array, Blob: Blob,
  atob: atob, URL: URL,
  window: { innerHeight: 800, innerWidth: 400 },
  document: {
    getElementById: function (id) { return els[id] || null; },
    activeElement: null,
    body: makeEl('body')
  },
  navigator: {},
  _saveOverlayFocus: function () {},
  _restoreOverlayFocus: function () {},
  appT: function (s) { return s; },
  showMiniToast: function () {},
  formatVideoDuration: function (s) { return String(Math.round(s || 0)); }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'video-block.js' });

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

/* ---------- P1: Blob/Object URL ---------- */
test('_videoModalDataUrlToObjectUrl convierte data URL a blob:', function () {
  var bin = '';
  for (var i = 0; i < 256; i++) bin += String.fromCharCode(i % 256);
  var b64 = Buffer.from(bin, 'binary').toString('base64');
  var out = vm.runInContext("_videoModalDataUrlToObjectUrl('data:video/mp4;base64," + b64 + "')", sandbox);
  assert(typeof out === 'string' && out.indexOf('blob:') === 0, 'debe devolver blob: URL, dio ' + String(out).slice(0, 40));
});

test('_videoModalDataUrlToObjectUrl deja pasar lo que no es data URL', function () {
  var out = vm.runInContext("_videoModalDataUrlToObjectUrl('blob:nativemos')", sandbox);
  assert.strictEqual(out, 'blob:nativemos', 'fallback intacto');
  var out2 = vm.runInContext('_videoModalDataUrlToObjectUrl(null)', sandbox);
  assert.strictEqual(out2, null, 'null intacto');
});

test('startPlayback usa Object URL (no la data URL gigante)', function () {
  assert(code.indexOf('player.src = _videoModalDataUrlToObjectUrl(dataUrl)') !== -1,
    'startPlayback debe asignar el Object URL');
  assert(code.indexOf('player.src = dataUrl') === -1,
    'no debe quedar asignación directa de la data URL gigante');
});

test('la caché de sesión guarda la data URL original (no el blob:)', function () {
  assert(code.indexOf('_videoModalCache[nid] = du') !== -1, 'cachea la data URL pendiente');
  assert(code.indexOf("src.indexOf('data:video')") === -1, 'ya no cachea player.src');
});

/* ---------- P2: gestos compartidos ---------- */
function ptr(id, x, y) { return { pointerId: id, clientX: x, clientY: y }; }

test('deslizar abajo más allá del umbral cierra el visor', function () {
  els['video-modal']._classes.delete('hidden');
  vm.runInContext('_videoModalStageDown(' + JSON.stringify(ptr(1, 100, 100)) + ')', sandbox);
  vm.runInContext('_videoModalStageMove(' + JSON.stringify(ptr(1, 110, 260)) + ')', sandbox);
  var tf = els['video-modal-player'].style.transform || '';
  assert(tf.indexOf('translateY(') === 0, 'el video baja con el dedo, transform=' + tf);
  var bg = els['video-modal'].style.backgroundColor || '';
  assert(bg.indexOf('rgba(0,0,0,') === 0, 'el fondo se atenúa, bg=' + bg);
  vm.runInContext('_videoModalStageUp(' + JSON.stringify(ptr(1, 110, 260)) + ')', sandbox);
  assert(els['video-modal']._classes.has('hidden'), 'el modal se cerró');
});

test('arrastre corto hace snap-back sin cerrar ni alternar chrome', function () {
  els['video-modal']._classes.delete('hidden');
  var chromeBefore = vm.runInContext('_videoModalChrome', sandbox);
  vm.runInContext('_videoModalStageDown(' + JSON.stringify(ptr(2, 100, 100)) + ')', sandbox);
  vm.runInContext('_videoModalStageMove(' + JSON.stringify(ptr(2, 105, 140)) + ')', sandbox); // dy=40 < 90
  vm.runInContext('_videoModalStageUp(' + JSON.stringify(ptr(2, 105, 140)) + ')', sandbox);
  assert(!els['video-modal']._classes.has('hidden'), 'el modal sigue abierto');
  assert.strictEqual(els['video-modal-player'].style.transform, '', 'el video regresó a su lugar');
  var chromeAfter = vm.runInContext('_videoModalChrome', sandbox);
  assert.strictEqual(chromeAfter, chromeBefore, 'el chrome no se alternó tras un arrastre');
});

test('tap alterna el chrome; doble tap reproduce/pausa', function () {
  els['video-modal']._classes.delete('hidden');
  var player = els['video-modal-player'];
  player.paused = true;
  player.src = 'blob:fake'; // toggleVideoModalPlay exige src (no reproducir "nada")
  var c0 = vm.runInContext('_videoModalChrome', sandbox);
  vm.runInContext('_videoModalStageDown(' + JSON.stringify(ptr(3, 100, 100)) + ')', sandbox);
  vm.runInContext('_videoModalStageUp(' + JSON.stringify(ptr(3, 100, 100)) + ')', sandbox);
  var c1 = vm.runInContext('_videoModalChrome', sandbox);
  assert.notStrictEqual(c1, c0, 'el primer tap alternó el chrome');
  vm.runInContext('_videoModalStageDown(' + JSON.stringify(ptr(4, 100, 100)) + ')', sandbox);
  vm.runInContext('_videoModalStageUp(' + JSON.stringify(ptr(4, 100, 100)) + ')', sandbox);
  var c2 = vm.runInContext('_videoModalChrome', sandbox);
  assert.strictEqual(c2, c0, 'el doble tap revirtió el chrome del primer tap');
  assert.strictEqual(player.paused, false, 'el doble tap reprodujo el video');
});

test('pellizco hacia adentro cierra el visor', function () {
  els['video-modal']._classes.delete('hidden');
  vm.runInContext('_videoModalStageDown(' + JSON.stringify(ptr(5, 100, 200)) + ')', sandbox);
  vm.runInContext('_videoModalStageDown(' + JSON.stringify(ptr(6, 300, 200)) + ')', sandbox);
  vm.runInContext('_videoModalStageMove(' + JSON.stringify(ptr(5, 150, 200)) + ')', sandbox);
  vm.runInContext('_videoModalStageMove(' + JSON.stringify(ptr(6, 250, 200)) + ')', sandbox); // d: 200 -> 100
  var tf = els['video-modal-player'].style.transform || '';
  assert(tf.indexOf('scale(') === 0, 'el video se encoge, transform=' + tf);
  vm.runInContext('_videoModalStageUp(' + JSON.stringify(ptr(5, 150, 200)) + ')', sandbox);
  vm.runInContext('_videoModalStageUp(' + JSON.stringify(ptr(6, 250, 200)) + ')', sandbox);
  assert(els['video-modal']._classes.has('hidden'), 'el pellizco cerró el visor');
});

/* ---------- P3: limpieza al cerrar ---------- */
test('closeVideoModal revoca el Object URL y limpia el gesto', function () {
  assert(code.indexOf('_videoModalRevokeObjectUrl();') !== -1, 'revoca el Object URL al cerrar');
  assert(code.indexOf('_videoModalPendingDataUrl = null;') !== -1, 'limpia la data URL pendiente');
  assert(code.indexOf('_videoModalDismissY = 0; _videoModalPinchScale = 1;') !== -1, 'resetea el estado de gestos');
});

console.log('\nRESULTADO: ' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
