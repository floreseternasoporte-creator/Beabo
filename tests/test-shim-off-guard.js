/* ================================================================
 * Tests del guard de liveness del shim (drex-cloud.js)
 * P1: dispatchSnapshot no despacha a oyentes dados de baja (off()),
 * y off() limpia _pendingFire para no re-disparar lecturas en vuelo.
 * Ejecutar con: node tests/test-shim-off-guard.js
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */

var assert = require('assert');
var fs = require('fs');
var src = fs.readFileSync(__dirname + '/../drex-cloud.js', 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(function () {
    passed++;
    console.log('ok - ' + name);
  }).catch(function (err) {
    failed++;
    console.log('FALLO - ' + name + ': ' + (err && err.message));
  });
}

// 1. El guard existe dentro de dispatchSnapshot, ANTES de cualquier callCb.
function dispatchBody() {
  var i = src.indexOf('function dispatchSnapshot(l, snap, isDelta)');
  assert(i !== -1, 'dispatchSnapshot no encontrada');
  var j = src.indexOf('{', i);
  var depth = 0, k = j;
  while (true) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) break; }
    k++;
  }
  return src.slice(j, k + 1);
}

var chain = Promise.resolve();
function run(name, fn) { chain = chain.then(function () { return test(name, fn); }); }

run('guard de liveness presente en dispatchSnapshot', function () {
  var body = dispatchBody();
  assert(body.indexOf('if (listeners.indexOf(l) === -1) return;') !== -1,
    'falta el guard listeners.indexOf(l) === -1');
});

run('guard corre antes del primer callCb', function () {
  var body = dispatchBody();
  var g = body.indexOf('listeners.indexOf(l) === -1');
  var c = body.indexOf('callCb(');
  assert(g !== -1 && c !== -1 && g < c, 'el guard debe preceder a callCb');
});

// 2. Ambos caminos de off() limpian _pendingFire.
run('unsubscribe de on() limpia _pendingFire', function () {
  var i = src.indexOf('if (i !== -1) listeners.splice(i, 1);');
  assert(i !== -1, 'unsubscribe no encontrado');
  var ctx = src.slice(i, i + 200);
  assert(ctx.indexOf('l._pendingFire = false;') !== -1,
    'falta l._pendingFire = false en unsubscribe');
});

run('Ref.prototype.off limpia _pendingFire', function () {
  var i = src.indexOf('Ref.prototype.off = function');
  assert(i !== -1, 'Ref.prototype.off no encontrado');
  var ctx = src.slice(i, i + 900);
  assert(ctx.indexOf('l._pendingFire = false;') !== -1,
    'falta l._pendingFire = false en Ref.prototype.off');
});

// 3. Simulación conductual de la carrera con el patrón real:
//    on() -> lectura en vuelo -> off() -> la lectura resuelve -> sin dispatch.
run('carrera on/off: lectura en vuelo no despacha tras off()', function () {
  var listeners = [];
  var dispatched = [];
  // Réplica fiel del guard tal como quedó en el fuente.
  function dispatchSnapshot(l, snap) {
    if (listeners.indexOf(l) === -1) return;
    dispatched.push(l.id);
  }
  var l = { id: 'L1', _pendingFire: false };
  listeners.push(l);
  var off = function () {
    var i = listeners.indexOf(l);
    if (i !== -1) listeners.splice(i, 1);
    l._pendingFire = false;
    if (l._deb) clearTimeout(l._deb);
  };
  // La lectura en vuelo resuelve DESPUÉS de off().
  off();
  dispatchSnapshot(l, { val: function () { return 1; } });
  assert.deepStrictEqual(dispatched, [], 'no debe despachar a oyente dado de baja');
  // Y un oyente aún suscrito sí recibe.
  var l2 = { id: 'L2' };
  listeners.push(l2);
  dispatchSnapshot(l2, { val: function () { return 2; } });
  assert.deepStrictEqual(dispatched, ['L2'], 'oyente activo sí despacha');
});

chain.then(function () {
  console.log('\nshim-off-guard: ' + passed + ' OK, ' + failed + ' FALLOS');
  process.exit(failed ? 1 : 0);
});
