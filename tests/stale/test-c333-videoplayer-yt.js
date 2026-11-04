/* ================================================================
 * Tests: reproductor de video nivel YouTube (C333)
 * - Auto-ocultado de controles: _videoModalChromeTouch programa el
 *   ocultado; no oculta en pausa ni con la hoja de velocidad abierta.
 * - Buffer: _videoModalRenderBuffered pinta lo descargado.
 * - Velocidad: setVideoModalSpeed cambia playbackRate, etiqueta y
 *   cierra la hoja; toggleVideoModalSpeedSheet abre/cierra.
 * - Error con reintento: _videoModalShowError muestra/oculta el overlay.
 * - Reanudar: _videoModalSetPos/_videoModalGetPos/_videoModalClearPos
 *   redondean y topan el mapa en 60 entradas.
 * El bloque se extrae de index.html y se ejecuta en sandbox con DOM
 * mínimo falso. Ejecutar con: node tests/test-c333-videoplayer-yt.js
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
  var el = {
    id: id,
    style: {},
    dataset: {},
    textContent: '',
    innerHTML: '',
    offsetWidth: 0,
    classList: {
      add: function (c) { classes.add(c); },
      remove: function (c) { classes.delete(c); },
      contains: function (c) { return classes.has(c); },
      toggle: function (c, f) { if (f === undefined) f = !classes.has(c); if (f) classes.add(c); else classes.delete(c); return f; }
    },
    addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: function () {},
    setPointerCapture: function () {},
    querySelector: function () { return null; },
    // API de <video> falsa
    paused: true,
    playbackRate: 1,
    currentTime: 0,
    duration: 0,
    ended: false,
    src: '',
    buffered: { length: 0, end: function () { return 0; } },
    play: function () { this.paused = false; return Promise.resolve(); },
    pause: function () { this.paused = true; },
    load: function () {},
    removeAttribute: function () {},
    getAttribute: function () { return ''; },
    _classes: classes,
    _listeners: listeners
  };
  return el;
}

var els = {};
['video-modal', 'video-modal-stage', 'video-modal-player', 'video-modal-seek',
 'video-modal-cur', 'video-modal-dur', 'video-modal-loading', 'video-modal-2x',
 'video-modal-skipl', 'video-modal-skipr', 'video-modal-speedbk',
 'video-modal-speedsheet', 'video-modal-speedtitle', 'video-modal-speedopts',
 'video-modal-speedbtn', 'video-modal-speedlabel', 'video-modal-rotatebtn',
 'video-modal-error', 'video-modal-topbar', 'video-modal-controls'
].forEach(function (id) { els[id] = makeEl(id); });
// La seekbar expone la capa de buffer
var bufferedBar = makeEl('buffered-bar');
els['video-modal-seek'].querySelector = function (sel) {
  return sel === '.drex-seek-buffered' ? bufferedBar : null;
};

var _ls = {};
var sandbox = {
  console: console,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  setInterval: setInterval, clearInterval: clearInterval,
  Date: Date, Math: Math, Map: Map, Uint8Array: Uint8Array, Blob: Blob,
  atob: atob, URL: URL,
  localStorage: {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(_ls, k) ? _ls[k] : null; },
    setItem: function (k, v) { _ls[k] = String(v); },
    removeItem: function (k) { delete _ls[k]; }
  },
  window: { innerHeight: 800, innerWidth: 400, screen: { orientation: {} } },
  document: {
    getElementById: function (id) { return els[id] || null; },
    activeElement: null,
    body: makeEl('body')
  },
  navigator: {},
  appT: function (s) { return s; },
  showMiniToast: function () {},
  formatVideoDuration: function (s) { return String(Math.round(s || 0)); }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'video-block-c333.js' });

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

/* ---------- auto-ocultado ---------- */
test('_videoModalSetChrome(true) programa el auto-ocultado', function () {
  assert(src.indexOf('_videoModalChromeTouch(); // C333: reprograma el auto-ocultado') !== -1,
    '_videoModalSetChrome debe reprogramar el timer');
  assert(src.indexOf('}, 3500);') !== -1, 'el timer es de 3.5 s');
});

test('el auto-ocultado respeta pausa, hoja de velocidad y error', function () {
  assert(src.indexOf('if (!player || player.paused) return;') !== -1, 'no oculta en pausa');
  assert(src.indexOf("if (sheet && !sheet.classList.contains('hidden')) return;") !== -1, 'no oculta con la hoja abierta');
  assert(src.indexOf("if (err && !err.classList.contains('hidden')) return;") !== -1, 'no oculta en error');
});

/* ---------- buffer ---------- */
test('_videoModalRenderBuffered pinta el % descargado', function () {
  var player = els['video-modal-player'];
  player.duration = 100;
  player.buffered = { length: 1, end: function () { return 30; } };
  vm.runInContext('_videoModalRenderBuffered()', sandbox);
  assert.strictEqual(bufferedBar.style.width, '30%', 'dio ' + bufferedBar.style.width);
  player.buffered = { length: 0, end: function () { return 0; } };
  vm.runInContext('_videoModalRenderBuffered()', sandbox);
  assert.strictEqual(bufferedBar.style.width, '0%', 'sin datos -> 0%');
});

/* ---------- velocidad ---------- */
test('setVideoModalSpeed cambia rate, etiqueta y cierra la hoja', function () {
  els['video-modal-speedsheet']._classes.delete('hidden');
  els['video-modal-speedbk']._classes.delete('hidden');
  vm.runInContext('setVideoModalSpeed(1.5)', sandbox);
  assert.strictEqual(els['video-modal-player'].playbackRate, 1.5, 'playbackRate');
  assert.strictEqual(els['video-modal-speedlabel'].textContent, '1.5x', 'etiqueta');
  assert(els['video-modal-speedsheet']._classes.has('hidden'), 'hoja cerrada');
  assert(els['video-modal-speedbk']._classes.has('hidden'), 'fondo cerrado');
  assert.strictEqual(vm.runInContext('_videoModalSpeed', sandbox), 1.5, 'velocidad guardada');
  vm.runInContext('setVideoModalSpeed(1)', sandbox); // restaurar
});

test('la hoja ofrece 0.5x–2x con la activa marcada en índigo Drex', function () {
  assert(src.indexOf('const _VIDEO_MODAL_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];') !== -1, 'lista de velocidades');
  vm.runInContext('_videoModalPaintSpeedOpts()', sandbox);
  var html = els['video-modal-speedopts'].innerHTML;
  [0.5, 0.75, 1, 1.25, 1.5, 2].forEach(function (v) {
    assert(html.indexOf('setVideoModalSpeed(' + v + ')') !== -1, 'falta opción ' + v + 'x');
  });
  assert(html.indexOf('text-[#9AA3FF]') !== -1, 'la activa va en índigo Drex');
});

test('el 2x de mantener presionado vuelve a la velocidad elegida', function () {
  assert(src.indexOf('player.playbackRate = _videoModalSpeed;') !== -1,
    'al soltar el 2x restaura _videoModalSpeed, no 1 fijo');
});

/* ---------- error con reintento ---------- */
test('_videoModalShowError muestra/oculta el overlay sin cerrar', function () {
  vm.runInContext('_videoModalShowError(true)', sandbox);
  assert(!els['video-modal-error']._classes.has('hidden'), 'overlay visible');
  assert(els['video-modal-error']._classes.has('flex'), 'overlay en flex');
  vm.runInContext('_videoModalShowError(false)', sandbox);
  assert(els['video-modal-error']._classes.has('hidden'), 'overlay oculto');
  assert(src.indexOf('onclick="retryVideoModalLoad()"') !== -1, 'existe el botón Reintentar');
  assert(src.indexOf('closeVideoModal(); // no dejar el modal clavado') === -1,
    'ya no se cierra de golpe ante un error');
});

/* ---------- reanudar donde quedó ---------- */
test('la posición se guarda redondeada y el mapa se topa en 60', function () {
  vm.runInContext("_videoModalSetPos('n1', 12.6)", sandbox);
  assert.strictEqual(vm.runInContext("_videoModalGetPos('n1')", sandbox), 13, 'redondea');
  for (var i = 0; i < 70; i++) vm.runInContext("_videoModalSetPos('k" + i + "', " + i + ")", sandbox);
  var n = vm.runInContext("Object.keys(JSON.parse(localStorage.getItem('drex-vpos'))).length", sandbox);
  assert(n <= 60, 'tope 60, hay ' + n);
  vm.runInContext("_videoModalClearPos('k69')", sandbox);
  assert.strictEqual(vm.runInContext("_videoModalGetPos('k69')", sandbox), 0, 'clear borra');
});

test('openVideoModal aplica la posición guardada en loadedmetadata', function () {
  assert(src.indexOf('_videoModalResumeAt = _videoModalGetPos(noteId); // C333') !== -1,
    'startPlayback pide la posición guardada');
  assert(src.indexOf('if (rp > 4 && (player.duration || 0) > rp + 8)') !== -1,
    'solo reanuda si pasaron 4 s y faltan 8 s');
});

/* ---------- rotación ---------- */
test('existe el botón de rotar con lock/unlock de orientación', function () {
  assert(src.indexOf('id="video-modal-rotatebtn"') !== -1, 'botón en el topbar');
  assert(src.indexOf("orientation.lock('landscape')") !== -1, 'pide landscape');
  assert(src.indexOf('_videoModalUnlockOrientation()') !== -1, 'libera al cerrar');
});

console.log('\nRESULTADO: ' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
