/* Test C237-L1 (manager): preview WebRTC del En vivo en el feed.
 * Extrae el bloque C237-L1 de index.html y lo ejecuta en vm con fakes
 * (DOM, IntersectionObserver, MutationObserver, DrexLiveCore, usuario).
 * Uso: node tests/test-c237-preview.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const W = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(W, 'index.html'), 'utf8');

const m = html.match(/\/\* ===== C237-L1 feed-live-preview: INICIO ===== \*\/([\s\S]*?)\/\* ===== C237-L1 feed-live-preview: FIN ===== \*\//);
assert(m, 'ROJO: no se encontro el bloque C237-L1 en index.html');

// ---------- fakes ----------
function FakeClassList() { this._s = new Set(); }
FakeClassList.prototype.add = function (c) { this._s.add(c); };
FakeClassList.prototype.remove = function (c) { this._s.delete(c); };
FakeClassList.prototype.contains = function (c) { return this._s.has(c); };

function FakeEl(liveId, status) {
  this.dataset = { livePreview: '1', liveId: liveId, liveStatus: status || 'live' };
  this._attrs = {};
  this.classList = new FakeClassList();
  this.isConnected = true;
  this._video = { srcObject: null, classList: new FakeClassList(), play: function () { return Promise.resolve(); } };
  this._cover = { classList: new FakeClassList() };
}
FakeEl.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
FakeEl.prototype.getAttribute = function (k) { return this._attrs[k]; };
FakeEl.prototype.hasAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); };
FakeEl.prototype.matches = function (sel) { return sel.indexOf('[data-live-preview') === 0; };
FakeEl.prototype.querySelector = function (sel) {
  if (sel.indexOf('video') >= 0 || sel.indexOf('data-flp-video') >= 0) return this._video;
  if (sel.indexOf('data-flp-cover') >= 0) return this._cover;
  return null;
};

const ioInsts = [];
function FakeIO(cb) { this.cb = cb; this.observed = []; ioInsts.push(this); }
FakeIO.prototype.observe = function (el) { this.observed.push(el); };
FakeIO.prototype.unobserve = function (el) { this.observed = this.observed.filter(function (e) { return e !== el; }); };
FakeIO.prototype.disconnect = function () {};
FakeIO.prototype.fire = function (entries) { this.cb(entries, this); };

const moInsts = [];
function FakeMO(cb) { this.cb = cb; moInsts.push(this); }
FakeMO.prototype.observe = function () {};
FakeMO.prototype.disconnect = function () {};
FakeMO.prototype.fire = function (recs) { this.cb(recs, this); };

const cores = [];
function FakeCore() {
  this.joinCalls = []; this.leaveCalls = 0; this.setUserCalls = [];
  this.handlers = {}; this.failJoin = !!FakeCore.nextFail; FakeCore.nextFail = false;
  cores.push(this);
}
FakeCore.nextFail = false;
FakeCore.prototype.setUser = function (u) { this.setUserCalls.push(u); };
FakeCore.prototype.on = function (ev, cb) { (this.handlers[ev] = this.handlers[ev] || []).push(cb); };
FakeCore.prototype.fire = function (ev, d) { (this.handlers[ev] || []).forEach(function (cb) { cb(d); }); };
FakeCore.prototype.joinLive = function (id) {
  this.joinCalls.push(id);
  return this.failJoin ? Promise.reject(new Error('live-ended')) : Promise.resolve({ liveId: id });
};
FakeCore.prototype.leaveLive = function () { this.leaveCalls++; return Promise.resolve({}); };

let fakeUser = { uid: 'u1', name: 'Yo' };
const timers = [];
const deps = {
  IO: FakeIO,
  MO: FakeMO,
  createCore: function () { return new FakeCore(); },
  getUser: function () { return fakeUser; },
  t: function (s) { return s; },
  setTimeout: function (fn) { const id = timers.length; timers.push({ fn: fn, cleared: false }); return id; },
  clearTimeout: function (id) { if (timers[id]) timers[id].cleared = true; },
  observeTarget: {},
  MAX: 2,
  TIMEOUT: 15000
};

const sb = { window: {} };
vm.createContext(sb);
vm.runInContext(m[1] + '\nthis.__factory = window.drexFeedLivePreviewFactory;', sb);
assert(typeof sb.__factory === 'function', 'ROJO: factory no expuesta');
const api = sb.__factory(deps);

function fakeRoot(cards) {
  return {
    querySelectorAll: function (sel) {
      return cards.filter(function (c) { return !c.hasAttribute('data-flp-done'); });
    }
  };
}
function nextTick() { return new Promise(function (r) { setTimeout(r, 10); }); }

(async function () {
  // 1. scan observa las tarjetas
  const c1 = new FakeEl('LIVE1'), c2 = new FakeEl('LIVE2');
  api.scan(fakeRoot([c1, c2]));
  assert(ioInsts.length === 1, 'ROJO: no se creo IntersectionObserver');
  assert(ioInsts[0].observed.length === 2, 'ROJO: no se observaron las 2 tarjetas');
  console.log('OK scan observa tarjetas');

  // 2. entra al viewport -> joinLive con el liveId
  ioInsts[0].fire([{ target: c1, isIntersecting: true }]);
  await nextTick();
  assert(cores.length === 1, 'ROJO: no se creo el core al entrar al viewport');
  assert(cores[0].joinCalls[0] === 'LIVE1', 'ROJO: joinLive no se llamo con LIVE1');
  assert(cores[0].setUserCalls[0].uid === 'u1', 'ROJO: setUser sin uid');
  console.log('OK viewport -> joinLive');

  // 3. remotetrack -> video visible con el stream
  const stream = { id: 'stream1' };
  cores[0].fire('remotetrack', { stream: stream });
  assert(c1._video.srcObject === stream, 'ROJO: stream no adjuntado al video');
  assert(c1._video.classList.contains('is-on'), 'ROJO: video sin clase is-on');
  assert(c1._cover.classList.contains('is-off'), 'ROJO: cover no oculto');
  console.log('OK remotetrack -> video en vivo');

  // 4. sale del viewport -> leaveLive y limpieza (regla DrexLive)
  ioInsts[0].fire([{ target: c1, isIntersecting: false }]);
  await nextTick();
  assert(cores[0].leaveCalls === 1, 'ROJO: no se llamo leaveLive al salir');
  assert(c1._video.srcObject === null, 'ROJO: srcObject no limpiado');
  assert(!c1._video.classList.contains('is-on'), 'ROJO: video sigue visible');
  console.log('OK salida -> leaveLive + limpieza');

  // 5. joinLive falla -> fallback sin video roto
  cores.length = 0;
  const c3 = new FakeEl('LIVE3');
  api.scan(fakeRoot([c3]));
  FakeCore.nextFail = true;
  ioInsts[0].fire([{ target: c3, isIntersecting: true }]);
  await nextTick(); await nextTick();
  const core3 = cores[cores.length - 1];
  assert(!c3._video.classList.contains('is-on'), 'ROJO: video visible pese al fallo');
  assert(!c3._cover.classList.contains('is-off'), 'ROJO: cover oculto pese al fallo');
  assert(core3.leaveCalls === 1, 'ROJO: sin limpieza tras fallo de join');
  console.log('OK fallo -> badge + portada, sin video roto');

  // 6. tarjeta no-live (ended) -> no conecta
  cores.length = 0;
  const c4 = new FakeEl('LIVE4', 'ended');
  api.scan(fakeRoot([c4]));
  ioInsts[0].fire([{ target: c4, isIntersecting: true }]);
  await nextTick();
  assert(cores.length === 0, 'ROJO: se conecto una tarjeta no-live');
  console.log('OK tarjeta ended no conecta');

  // 7. tope de 2 simultaneos: la 3a espera
  cores.length = 0;
  const a = new FakeEl('A'), b = new FakeEl('B'), c = new FakeEl('C');
  api.scan(fakeRoot([a, b, c]));
  ioInsts[0].fire([{ target: a, isIntersecting: true }, { target: b, isIntersecting: true }, { target: c, isIntersecting: true }]);
  await nextTick();
  const joined = cores.map(function (k) { return k.joinCalls[0]; }).sort().join(',');
  assert(joined === 'A,B', 'ROJO: tope no respetado, joins=' + joined);
  // al salir una, la tercera entra
  ioInsts[0].fire([{ target: a, isIntersecting: false }]);
  await nextTick();
  assert(cores.some(function (k) { return k.joinCalls[0] === 'C'; }), 'ROJO: la tarjeta en cola no entro al liberarse');
  console.log('OK maximo 2 simultaneos + cola');

  // 8. tarjeta eliminada del DOM -> leaveLive
  // (libera los slots de la prueba 7 para que D conecte de verdad)
  ioInsts[0].fire([{ target: b, isIntersecting: false }, { target: c, isIntersecting: false }]);
  await nextTick();
  const d = new FakeEl('D');
  api.scan(fakeRoot([d]));
  ioInsts[0].fire([{ target: d, isIntersecting: true }]);
  await nextTick();
  const coreD = cores[cores.length - 1];
  const leavesBefore = coreD.leaveCalls;
  d.isConnected = false;
  moInsts[0].fire([{ addedNodes: [], removedNodes: [d] }]);
  await nextTick();
  assert(coreD.leaveCalls === leavesBefore + 1, 'ROJO: sin limpieza al remover la tarjeta');
  console.log('OK tarjeta removida -> leaveLive');

  // 9. sin usuario -> no conecta
  cores.length = 0;
  fakeUser = null;
  const e = new FakeEl('E');
  api.scan(fakeRoot([e]));
  ioInsts[0].fire([{ target: e, isIntersecting: true }]);
  await nextTick();
  assert(cores.length === 0, 'ROJO: conecto sin usuario');
  fakeUser = { uid: 'u1', name: 'Yo' };
  console.log('OK sin usuario no conecta');

  // 10. re-entrada no duplica el join
  cores.length = 0;
  const f = new FakeEl('F');
  api.scan(fakeRoot([f]));
  ioInsts[0].fire([{ target: f, isIntersecting: true }]);
  ioInsts[0].fire([{ target: f, isIntersecting: true }]);
  await nextTick();
  assert(cores.length === 1 && cores[0].joinCalls.length === 1, 'ROJO: join duplicado');
  console.log('OK sin joins duplicados');

  console.log('C237-L1-PREVIEW VERDE');
})().catch(function (e) { console.error('FALLO:', e && e.message); process.exit(1); });
