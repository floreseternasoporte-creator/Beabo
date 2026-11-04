// C96 — Limpieza de observers globales: el resto de IntersectionObserver con
// patrón "global + mounts por generación" retenía nodos desmontados (mismo
// leak que C95 encontró en _drexViewObserver). Cubre:
//   - monetagInFeedObserver / adsterraInFeedObserver (slots de anuncios)
//   - _drexRecViewObserver (entrenamiento por retención)
//   - ctx._feedWindowIO (ventana virtual del feed: guard + teardown)
//   - _commentersIO (clúster de comentaristas)
// Uso: node tests/test-c96-observer-cleanup.js [--target <index.html>]
'use strict';
const fs = require('fs');
const vm = require('vm');

const target = (() => {
  const i = process.argv.indexOf('--target');
  return i !== -1 ? process.argv[i + 1] : 'index.html';
})();
const src = fs.readFileSync(target, 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); }
}
function tcase(name, fn) {
  try { fn(); } catch (e) { ok(false, name + ' (throw: ' + e.message + ')'); }
}

// ---- extracción del callback real por anchor + balance de llaves ----
function extractCallback(srcText, anchor) {
  const ai = srcText.indexOf(anchor);
  if (ai === -1) throw new Error('anchor no encontrado: ' + anchor);
  const ni = srcText.indexOf('new IntersectionObserver(', ai);
  if (ni === -1) throw new Error('observer no encontrado tras: ' + anchor);
  const pi = srcText.indexOf('(', ni + 'new IntersectionObserver'.length);
  const bi = srcText.indexOf('{', pi);
  if (bi === -1) throw new Error('callback sin cuerpo: ' + anchor);
  let depth = 0, inStr = null, inLine = false, inBlock = false;
  for (let i = bi; i < srcText.length; i++) {
    const c = srcText[i], n = srcText[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return srcText.slice(pi + 1, i + 1).trim(); }
  }
  throw new Error('callback sin cerrar: ' + anchor);
}

function extractFunction(srcText, anchor) {
  const ai = srcText.indexOf(anchor);
  if (ai === -1) throw new Error('anchor no encontrado: ' + anchor);
  const bi = srcText.indexOf('{', ai);
  let depth = 0, inStr = null, inLine = false, inBlock = false;
  for (let i = bi; i < srcText.length; i++) {
    const c = srcText[i], n = srcText[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return srcText.slice(ai, i + 1); }
  }
  throw new Error('función sin cerrar: ' + anchor);
}

// ---- sandbox con IntersectionObserver falso ----
function makeIO() {
  const W = { targets: [], unobserved: [], cb: null, disconnected: false };
  function FakeIO(callback) {
    W.cb = callback;
    this.observe = function (el) { if (W.targets.indexOf(el) === -1) W.targets.push(el); };
    this.unobserve = function (el) {
      W.unobserved.push(el);
      const i = W.targets.indexOf(el);
      if (i !== -1) W.targets.splice(i, 1);
    };
    this.disconnect = function () { W.disconnected = true; W.targets = []; };
  }
  return { W: W, FakeIO: FakeIO };
}
function fakeEl(connected) { return { isConnected: !!connected }; }
function fire(W, target, isIntersecting) { W.cb([{ target: target, isIntersecting: !!isIntersecting }]); }

function parseChecked(label, expr) {
  // expr es cuerpo de función: envolver para validar el parseo en vm.
  try { new vm.Script('(function(){\n' + expr + '\n})'); }
  catch (e) { throw new Error('parseo de ' + label + ': ' + e.message); }
  return new Function(expr)();
}

// ---- extracción de los bloques reales ----
let cbMonetag, cbAdsterra, cbRec, cbWin, cbCommenters, teardownFn;
tcase('T0 extracción de los 5 callbacks + teardown', () => {
  cbMonetag = extractCallback(src, 'var monetagInFeedObserver = null;');
  cbAdsterra = extractCallback(src, 'var adsterraInFeedObserver = null;');
  cbRec = extractCallback(src, 'let _drexRecViewObserver = null;');
  cbWin = extractCallback(src, 'function snfFeedWindowEnsureIO(ctx) {');
  cbCommenters = extractCallback(src, 'let _commentersIO = null;');
  teardownFn = extractFunction(src, 'function snfTeardownCardObservers(ctx)');
  ok(true, 'extracción OK');
});
if (!cbMonetag) { console.log('FAIL extracción'); process.exit(1); }

// ================= anuncios: monetag / adsterra =================
['monetag', 'adsterra'].forEach(function (kind) {
  const cb = kind === 'monetag' ? cbMonetag : cbAdsterra;
  const loaderName = kind === 'monetag' ? 'loadMonetagInFeedSlot' : 'loadAdsterraInFeedSlot';
  const obsVarName = kind === 'monetag' ? 'monetagInFeedObserver' : 'adsterraInFeedObserver';
  tcase(kind + ': slot desmontado se libera sin cargar', () => {
    const M = makeIO();
    let loaded = 0;
    const expr = 'return (function(IntersectionObserver, ' + loaderName + ') {\n' +
      'var ' + obsVarName + ' = null;\n' +
      'try { ' + obsVarName + ' = new IntersectionObserver(' + cb + ', { rootMargin: "1600px 0px" }); }\n' +
      'catch (_) { ' + obsVarName + ' = null; }\n' +
      'return ' + obsVarName + ';\n});';
    parseChecked(kind + 'Factory', expr);
    const factory = parseChecked(kind + 'Factory2', expr);
    const obs = factory(M.FakeIO, function () { loaded++; });
    ok(obs !== null, kind + ': observer creado');
    const dead = fakeEl(false), live = fakeEl(true);
    obs.observe(dead); obs.observe(live);
    fire(M.W, dead, false); // entry final de desconexión
    ok(M.W.unobserved.indexOf(dead) !== -1, kind + ': slot desmontado liberado (unobserve)');
    ok(loaded === 0, kind + ': slot desmontado NO dispara carga');
  });
  tcase(kind + ': slot vivo conserva el comportamiento', () => {
    const M = makeIO();
    let loaded = 0;
    const expr = 'return (function(IntersectionObserver, ' + loaderName + ') {\n' +
      'var ' + obsVarName + ' = null;\n' +
      'try { ' + obsVarName + ' = new IntersectionObserver(' + cb + ', { rootMargin: "1600px 0px" }); }\n' +
      'catch (_) { ' + obsVarName + ' = null; }\n' +
      'return ' + obsVarName + ';\n});';
    parseChecked(kind + 'FactoryB', expr);
    const factory = parseChecked(kind + 'FactoryB2', expr);
    const obs = factory(M.FakeIO, function () { loaded++; });
    const live = fakeEl(true);
    obs.observe(live);
    fire(M.W, live, false);
    ok(M.W.unobserved.indexOf(live) === -1, kind + ': slot vivo offscreen NO se libera');
    fire(M.W, live, true);
    ok(loaded === 1, kind + ': slot vivo al intersectar carga 1 vez');
    ok(M.W.unobserved.indexOf(live) !== -1, kind + ': slot vivo al intersectar se libera');
  });
  tcase(kind + ': el bloque conoce isConnected (hook C96)', () => {
    ok(cb.indexOf('isConnected') !== -1, kind + ': hook isConnected presente');
  });
});

// ================= retención: _drexRecViewObserver =================
tcase('rec: tarjeta desmontada libera observer + timers', () => {
  const M = makeIO();
  const scheduled = [], cleared = [];
  const expr = 'return (function(IntersectionObserver, setTimeout, clearTimeout) {\n' +
    'var _drexRecViewObserver = null;\n' +
    'const _drexRecViewTimers = new Map();\n' +
    'const _drexRecViewTrainEl = function () {};\n' +
    'const DREX_REC = { weights: { view: 0.3, deepView: 1.2 }, viewMs: 999999, deepViewMs: 1999999 };\n' +
    '_drexRecViewObserver = new IntersectionObserver(' + cbRec + ', { threshold: 0.4 });\n' +
    'return { obs: _drexRecViewObserver, timers: _drexRecViewTimers };\n});';
  parseChecked('recFactory', expr);
  const factory = parseChecked('recFactory2', expr);
  const R = factory(M.FakeIO,
    function (fn) { const id = scheduled.length + 1; scheduled.push(id); return id; },
    function (id) { cleared.push(id); });
  const card = fakeEl(true);
  R.obs.observe(card);
  fire(M.W, card, true); // programa t1
  ok(scheduled.length === 1, 'rec: t1 programado al intersectar');
  card.isConnected = false; // la tarjeta se desmonta (cambio de tab)
  fire(M.W, card, false); // entry final de desconexión
  ok(M.W.unobserved.indexOf(card) !== -1, 'rec: tarjeta desmontada liberada (unobserve)');
  ok(cleared.indexOf(1) !== -1, 'rec: timer pendiente cancelado');
  ok(!R.timers.has(card), 'rec: entrada del mapa de timers eliminada');
});
tcase('rec: tarjeta viva offscreen conserva el comportamiento', () => {
  const M = makeIO();
  const cleared = [];
  const expr = 'return (function(IntersectionObserver, setTimeout, clearTimeout) {\n' +
    'var _drexRecViewObserver = null;\n' +
    'const _drexRecViewTimers = new Map();\n' +
    'const _drexRecViewTrainEl = function () {};\n' +
    'const DREX_REC = { weights: { view: 0.3, deepView: 1.2 }, viewMs: 999999, deepViewMs: 1999999 };\n' +
    '_drexRecViewObserver = new IntersectionObserver(' + cbRec + ', { threshold: 0.4 });\n' +
    'return { obs: _drexRecViewObserver, timers: _drexRecViewTimers };\n});';
  parseChecked('recFactoryC', expr);
  const factory = parseChecked('recFactoryC2', expr);
  let idc = 0;
  const R = factory(M.FakeIO,
    function () { idc++; return idc; },
    function (id) { cleared.push(id); });
  const card = fakeEl(true);
  R.obs.observe(card);
  fire(M.W, card, true);
  fire(M.W, card, false); // sale de pantalla pero sigue en el DOM
  ok(M.W.unobserved.indexOf(card) === -1, 'rec: tarjeta viva offscreen NO se libera');
  ok(cleared.indexOf(1) !== -1, 'rec: timer se cancela al salir de pantalla (comportamiento previo)');
});
tcase('rec: el bloque conoce isConnected (hook C96)', () => {
  ok(cbRec.indexOf('isConnected') !== -1, 'rec: hook isConnected presente');
});

// ================= ventana del feed: _feedWindowIO =================
function winFactory(aliveFlag) {
  const M = makeIO();
  const expr = 'return (function(IntersectionObserver) {\n' +
    'var alive = ' + (aliveFlag ? 'true' : 'false') + ';\n' +
    'const remounts = [];\n' +
    'const ctx = { alive: function () { return alive; }, _feedWindowIO: null };\n' +
    'function snfFeedWindowRemount(c, t) { remounts.push(t); }\n' +
    'ctx._feedWindowIO = new IntersectionObserver(' + cbWin + ', { rootMargin: "1600px 0px 1600px 0px" });\n' +
    'return { ctx: ctx, remounts: remounts, setAlive: function (v) { alive = v; } };\n});';
  parseChecked('winFactory', expr);
  const factory = parseChecked('winFactory2', expr);
  const F = factory(M.FakeIO);
  F.W = M.W;
  return F;
}
tcase('feedWindow: ctx muerto + marcador desmontado → se libera', () => {
  const F = winFactory(false); // tab cambiado: el ctx murió
  const ph = fakeEl(false);
  F.ctx._feedWindowIO.observe(ph);
  fire(F.W, ph, false);
  ok(F.W.unobserved.indexOf(ph) !== -1, 'feedWindow: marcador muerto del ctx anterior liberado');
  ok(F.remounts.length === 0, 'feedWindow: ctx muerto no remonta');
});
tcase('feedWindow: ctx vivo + marcador desmontado → se libera sin remontar', () => {
  const F = winFactory(true);
  const ph = fakeEl(false);
  F.ctx._feedWindowIO.observe(ph);
  fire(F.W, ph, false);
  ok(F.W.unobserved.indexOf(ph) !== -1, 'feedWindow: marcador desmontado liberado');
  ok(F.remounts.length === 0, 'feedWindow: marcador desmontado no se remonta');
});
tcase('feedWindow: ctx vivo conserva el comportamiento', () => {
  const F = winFactory(true);
  const ph = fakeEl(true);
  F.ctx._feedWindowIO.observe(ph);
  fire(F.W, ph, true);
  ok(F.remounts.length === 1, 'feedWindow: marcador vivo al intersectar se remonta');
  ok(F.W.unobserved.indexOf(ph) !== -1, 'feedWindow: marcador vivo al intersectar se libera');
  const ph2 = fakeEl(true);
  F.ctx._feedWindowIO.observe(ph2);
  fire(F.W, ph2, false);
  ok(F.W.unobserved.indexOf(ph2) === -1, 'feedWindow: marcador vivo offscreen NO se libera');
});
tcase('feedWindow: teardown desconecta el observer', () => {
  const expr = 'return (function() {\n' + teardownFn + '\nreturn snfTeardownCardObservers;\n});';
  parseChecked('teardownFactory', expr);
  const factory = parseChecked('teardownFactory2', expr);
  const fn = factory();
  let winDisc = false, cardDisc = false;
  const ctx = {
    cardVisibilityObserver: { disconnect: function () { cardDisc = true; } },
    postCounterSubs: new Map(),
    _feedWindowIO: { disconnect: function () { winDisc = true; } }
  };
  fn(ctx);
  ok(winDisc, 'teardown: _feedWindowIO desconectado');
  ok(ctx._feedWindowIO === null, 'teardown: _feedWindowIO nulado');
  ok(cardDisc, 'teardown: cardVisibilityObserver sigue desconectándose');
});
tcase('feedWindow: el bloque conoce isConnected (hook C96)', () => {
  ok(cbWin.indexOf('isConnected') !== -1, 'feedWindow: hook isConnected presente');
});

// ================= comentaristas: _commentersIO =================
tcase('commenters: marcador desmontado se libera sin leer', () => {
  const M = makeIO();
  let loaded = 0;
  const expr = 'return (function(IntersectionObserver, _loadCommentersCluster) {\n' +
    'var _commentersIO = null;\n' +
    'try { _commentersIO = new IntersectionObserver(' + cbCommenters + ', { rootMargin: "360px" }); }\n' +
    'catch (_) { _commentersIO = null; }\n' +
    'return _commentersIO;\n});';
  parseChecked('commentersFactory', expr);
  const factory = parseChecked('commentersFactory2', expr);
  const obs = factory(M.FakeIO, function () { loaded++; });
  const dead = fakeEl(false), live = fakeEl(true);
  obs.observe(dead); obs.observe(live);
  fire(M.W, dead, false);
  ok(M.W.unobserved.indexOf(dead) !== -1, 'commenters: marcador desmontado liberado');
  ok(loaded === 0, 'commenters: marcador desmontado NO dispara lectura');
  fire(M.W, live, false);
  ok(M.W.unobserved.indexOf(live) === -1, 'commenters: marcador vivo offscreen NO se libera');
  fire(M.W, live, true);
  ok(loaded === 1 && M.W.unobserved.indexOf(live) !== -1, 'commenters: marcador vivo al intersectar lee y se libera');
});
tcase('commenters: el bloque conoce isConnected (hook C96)', () => {
  ok(cbCommenters.indexOf('isConnected') !== -1, 'commenters: hook isConnected presente');
});

console.log('\nC96 observer cleanup: ' + pass + ' pass, ' + fail + ' fail');
if (failures.length) { console.log('FAILURES:'); failures.forEach(function (f) { console.log('  - ' + f); }); }
process.exit(fail ? 1 : 0);
