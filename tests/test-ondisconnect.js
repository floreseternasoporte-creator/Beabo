/* ================================================================
 * Tests de onDisconnect() cancelable (drex-cloud.js)
 * Ejecutar con: node tests/test-ondisconnect.js
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */

var assert = require('assert');

// Spies de listeners.
var pagehideHandlers = [];
var visHandlers = [];
global.window = global;
global.addEventListener = function (type, fn) {
  if (type === 'pagehide') pagehideHandlers.push(fn);
};
global.removeEventListener = function (type, fn) {
  if (type === 'pagehide') {
    var i = pagehideHandlers.indexOf(fn);
    if (i !== -1) pagehideHandlers.splice(i, 1);
  }
};
global.document = {
  visibilityState: 'visible',
  addEventListener: function (type, fn) {
    if (type === 'visibilitychange') visHandlers.push(fn);
  },
  removeEventListener: function (type, fn) {
    if (type === 'visibilitychange') {
      var i = visHandlers.indexOf(fn);
      if (i !== -1) visHandlers.splice(i, 1);
    }
  }
};

require('../drex-cloud.js');
var DrexCloud = global.DrexCloud;

var passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(function () {
    console.log('  \u2713 ' + name); passed++;
  }).catch(function (e) {
    console.log('  \u2717 ' + name + ': ' + e.message); failed++;
  });
}
function resetSpies() { pagehideHandlers = []; visHandlers = []; }

async function runAll() {
  console.log('\nonDisconnect() cancelable:');

  await test('remove() arma listeners y devuelve handle con cancel()', function () {
    resetSpies();
    var ref = DrexCloud.database().ref('t/x');
    var h = ref.onDisconnect().remove();
    assert(h && typeof h.cancel === 'function', 'debe devolver handle cancelable');
    assert(pagehideHandlers.length === 1, 'debe armar 1 pagehide, hay ' + pagehideHandlers.length);
    assert(visHandlers.length === 1, 'debe armar 1 visibilitychange, hay ' + visHandlers.length);
  });

  await test('cancel() quita los listeners armados', function () {
    resetSpies();
    var ref = DrexCloud.database().ref('t/x');
    var h = ref.onDisconnect().remove();
    h.cancel();
    assert(pagehideHandlers.length === 0, 'pagehide debe quedar en 0');
    assert(visHandlers.length === 0, 'visibilitychange debe quedar en 0');
  });

  await test('tras cancel(), el handler ya no dispara la escritura', function () {
    resetSpies();
    var ref = DrexCloud.database().ref('t/x');
    var writes = 0;
    ref.remove = function () { writes++; return Promise.resolve(); };
    var h = ref.onDisconnect().remove();
    h.cancel();
    global.document.visibilityState = 'hidden';
    visHandlers.slice().forEach(function (fn) { fn(); });
    pagehideHandlers.slice().forEach(function (fn) { fn(); });
    global.document.visibilityState = 'visible';
    assert(writes === 0, 'no debe escribir tras cancel(), escribió ' + writes + ' veces');
  });

  await test('sin cancel(), ocultar la página sí dispara la escritura', function () {
    resetSpies();
    var ref = DrexCloud.database().ref('t/x');
    var writes = 0;
    ref.remove = function () { writes++; return Promise.resolve(); };
    ref.onDisconnect().remove();
    global.document.visibilityState = 'hidden';
    visHandlers.slice().forEach(function (fn) { fn(); });
    global.document.visibilityState = 'visible';
    assert(writes === 1, 'debe escribir 1 vez, escribió ' + writes);
  });

  await test('re-arme tras cancel() no acumula listeners', function () {
    resetSpies();
    var ref = DrexCloud.database().ref('t/x');
    var h1 = ref.onDisconnect().remove();
    h1.cancel();
    ref.onDisconnect().remove();
    assert(pagehideHandlers.length === 1, 'debe haber 1 pagehide, hay ' + pagehideHandlers.length);
    assert(visHandlers.length === 1, 'debe haber 1 visibilitychange, hay ' + visHandlers.length);
  });

  await test('set() y update() también devuelven handle cancelable', function () {
    resetSpies();
    var ref = DrexCloud.database().ref('t/x');
    var hs = ref.onDisconnect().set({ a: 1 });
    var hu = ref.onDisconnect().update({ a: 1 });
    assert(hs && typeof hs.cancel === 'function', 'set() debe devolver handle');
    assert(hu && typeof hu.cancel === 'function', 'update() debe devolver handle');
    hs.cancel(); hu.cancel();
    assert(pagehideHandlers.length === 0 && visHandlers.length === 0, 'todo cancelado');
  });

  console.log('\n========================================');
  console.log('Resumen: ' + passed + ' pasados, ' + failed + ' fallidos');
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(function (e) { console.error(e); process.exit(1); });
