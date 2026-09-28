/* ================================================================
 * C226 — regresión: el feed paginado NO debe borrar tarjetas de
 * posts legacy sin contadores (upvotes/downvotes/commentsCount).
 *
 * Bug real: snfAttachPostCounterSubs() concluía "post borrado" cuando
 * los 3 campos de contadores eran null, SIN esperar los 3 callbacks
 * iniciales. Un post legacy (creado antes del esquema canónico, sin
 * esos campos) borraba su tarjeta en el PRIMER callback al entrar al
 * viewport (rootMargin 300px): posts "faltantes" al hacer scroll
 * infinito más allá de la ventana en vivo de 50.
 *
 * El fix: snfCountersNeedGoneCheck() exige haber visto los 3 callbacks
 * iniciales y, aun con los 3 en null, solo dispara UNA lectura acotada
 * (communityNotes/<pid>/timestamp — todo post real lo tiene, la query
 * ordena por él). Solo si el timestamp también es null se quita la
 * tarjeta. Sin esa verificación, la tarjeta se conserva y los
 * contadores quedan en 0.
 *
 * El test extrae las funciones reales de index.html y las corre contra
 * una BD falsa fiel (on/value con null para campos ausentes) y un DOM
 * falso. Sin el fix, snfCountersNeedGoneCheck no existe -> el test
 * falla (rojo). Con el fix, todos los checks pasan (verde).
 *
 * Ejecutar: node tests/test-c226-feed-gone-check.js [--target ruta]
 * ================================================================ */
'use strict';
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');

var target = process.argv.indexOf('--target') !== -1
  ? process.argv[process.argv.indexOf('--target') + 1]
  : __dirname + '/../index.html';
var src = fs.readFileSync(target, 'utf8');

// ---- extracción de las funciones reales ----
var startMark = 'function snfCountersNeedGoneCheck(state) {';
var start = src.indexOf(startMark);
assert(start !== -1, 'ROJO: snfCountersNeedGoneCheck no existe en ' + target +
  ' (el fix C226 no está aplicado)');
var detachMark = 'function snfDetachPostCounterSubs(ctx, pid) {';
var dStart = src.indexOf(detachMark, start);
assert(dStart !== -1, 'no se encontró snfDetachPostCounterSubs');
var dEnd = src.indexOf('\n  }\n', dStart);
assert(dEnd !== -1, 'no se encontró el cierre de snfDetachPostCounterSubs');
var code = src.slice(start, dEnd + '\n  }\n'.length);

// ---- BD falsa fiel: on('value') dispara con null si el campo no existe ----
function makeDb(paths) {
  var listeners = {};   // path -> [{evt, cb}]
  var onceCalls = [];   // lecturas once() realizadas
  function ref(path) {
    return {
      child: function (f) { return ref(path + '/' + f); },
      on: function (evt, cb) {
        (listeners[path] = listeners[path] || []).push({ evt: evt, cb: cb });
      },
      off: function (evt, cb) {
        var arr = listeners[path] || [];
        for (var i = arr.length - 1; i >= 0; i--) {
          if (arr[i].cb === cb) arr.splice(i, 1);
        }
      },
      once: function (evt) {
        onceCalls.push(path);
        var v = Object.prototype.hasOwnProperty.call(paths, path) ? paths[path] : null;
        return Promise.resolve({ val: function () { return v; } });
      }
    };
  }
  return {
    database: function () { return { ref: ref }; },
    listeners: listeners,
    onceCalls: onceCalls,
    fire: function (path, val) {
      (listeners[path] || []).forEach(function (l) { l.cb({ val: function () { return val; } }); });
    }
  };
}

function makeCtx(db) {
  var cards = {};
  var doc = {
    getElementById: function (id) { return cards[id] || null; }
  };
  return {
    sandbox: null,
    cards: cards,
    doc: doc,
    db: db,
    emptyShown: 0,
    ctx: null,
    addCard: function (pid) {
      var card = {
        id: 'post-' + pid,
        removed: false,
        remove: function () { this.removed = true; delete cards['post-' + pid]; }
      };
      cards['post-' + pid] = card;
      return card;
    },
    makeCtxObj: function () {
      return {
        _alive: true,
        alive: function () { return this._alive; },
        postCounterSubs: new Map(),
        feedLoadedIds: new Set()
      };
    }
  };
}

function loadFns(h) {
  var sandbox = {
    DrexCloud: h.db,
    document: h.doc,
    snfUpdateFeedPostCounters: function () {},
    snfMaybeShowEmptyState: function () { h.emptyShown++; },
    console: console
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'snf-extract.js' });
  h.sandbox = sandbox;
  h.ctx = h.makeCtxObj();
  return sandbox;
}

function attach(h, pid, paths) {
  var el = { isConnected: true, dataset: { feedPaginated: '1' } };
  h.sandbox.snfAttachPostCounterSubs(h.ctx, pid, el);
  var P = 'communityNotes/' + pid + '/';
  return {
    fire: function (field, val) { h.db.fire(P + field, val); }
  };
}

var tick = function () { return new Promise(function (r) { setTimeout(r, 5); }); };

var passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () { passed++; console.log('ok - ' + name); })
    .catch(function (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); });
}

(async function main() {
  // T1: decisión pura — carrera del primer callback: solo llegó upvotes=null.
  // El código viejo borraba aquí. El nuevo NO debe marcar para verificación.
  await test('T1 primer callback con null no implica borrado', function () {
    var h = makeCtx(makeDb({})); loadFns(h);
    assert.strictEqual(
      h.sandbox.snfCountersNeedGoneCheck({ up: null, down: null, comments: null, seenUp: true, seenDown: false, seenComments: false }),
      false);
  });

  // T2: decisión pura — los 3 callbacks llegaron, los 3 en null -> verificar.
  await test('T2 tres callbacks en null sí ameritan verificación', function () {
    var h = makeCtx(makeDb({})); loadFns(h);
    assert.strictEqual(
      h.sandbox.snfCountersNeedGoneCheck({ up: null, down: null, comments: null, seenUp: true, seenDown: true, seenComments: true }),
      true);
  });

  // T3: decisión pura — un contador con valor descarta el borrado.
  await test('T3 contador con valor no implica borrado', function () {
    var h = makeCtx(makeDb({})); loadFns(h);
    assert.strictEqual(
      h.sandbox.snfCountersNeedGoneCheck({ up: 0, down: null, comments: null, seenUp: true, seenDown: true, seenComments: true }),
      false);
    assert.strictEqual(
      h.sandbox.snfCountersNeedGoneCheck({ up: 5, down: 2, comments: 1, seenUp: true, seenDown: true, seenComments: true }),
      false);
  });

  // T4 (integración): post legacy sin contadores — la tarjeta SOBREVIVE al
  // entrar al viewport y NO se borra tras la verificación de timestamp.
  await test('T4 post legacy sin contadores conserva su tarjeta', async function () {
    var pid = 'legacy1';
    var db = makeDb({ 'communityNotes/legacy1/timestamp': 1759000000000 });
    var h = makeCtx(db); loadFns(h);
    h.ctx.feedLoadedIds.add(pid);
    var card = h.addCard(pid);
    var a = attach(h, pid);
    a.fire('upvotes', null);      // <- el código viejo borraba la tarjeta AQUÍ
    assert.strictEqual(card.removed, false, 'la tarjeta se borró en el primer callback');
    assert.ok(h.ctx.feedLoadedIds.has(pid), 'el pid salió de feedLoadedIds');
    a.fire('downvotes', null);
    a.fire('commentsCount', null);
    await tick(); await tick();
    assert.strictEqual(card.removed, false, 'la tarjeta se borró tras la verificación');
    assert.ok(h.ctx.feedLoadedIds.has(pid));
    assert.ok(h.ctx.postCounterSubs.has(pid), 'los subs de contadores se desmontaron');
    assert.deepStrictEqual(db.onceCalls, ['communityNotes/legacy1/timestamp'],
      'la verificación debe ser 1 lectura acotada a timestamp, no N+1');
  });

  // T5 (integración): post REALMENTE borrado — los 3 en null + timestamp
  // null -> la tarjeta sí se quita y se limpia el estado.
  await test('T5 post borrado sí quita la tarjeta tras verificar', async function () {
    var pid = 'gone1';
    var db = makeDb({}); // ni timestamp existe
    var h = makeCtx(db); loadFns(h);
    h.ctx.feedLoadedIds.add(pid);
    var card = h.addCard(pid);
    var a = attach(h, pid);
    a.fire('upvotes', null);
    a.fire('downvotes', null);
    a.fire('commentsCount', null);
    await tick(); await tick();
    assert.strictEqual(card.removed, true, 'la tarjeta de un post borrado debe quitarse');
    assert.ok(!h.ctx.feedLoadedIds.has(pid), 'el pid debe salir de feedLoadedIds');
    assert.ok(!h.ctx.postCounterSubs.has(pid), 'los subs deben desmontarse');
    assert.strictEqual(h.emptyShown, 1, 'debe reevaluarse el estado vacío');
  });

  // T6 (integración): post normal con contadores — sin lecturas extra.
  await test('T6 post normal no dispara verificación de borrado', async function () {
    var pid = 'normal1';
    var db = makeDb({
      'communityNotes/normal1/timestamp': 1759000000000,
      'communityNotes/normal1/upvotes': 3
    });
    var h = makeCtx(db); loadFns(h);
    var card = h.addCard(pid);
    var a = attach(h, pid);
    a.fire('upvotes', 3);
    a.fire('downvotes', 0);
    a.fire('commentsCount', 2);
    await tick();
    assert.strictEqual(card.removed, false);
    assert.deepStrictEqual(db.onceCalls, [], 'un post sano no debe generar lecturas once()');
    assert.ok(h.ctx.postCounterSubs.has(pid));
  });

  // T7: el detach apaga los 3 listeners (sin fugas).
  await test('T7 detach apaga los 3 listeners del post', async function () {
    var pid = 'detach1';
    var db = makeDb({ 'communityNotes/detach1/timestamp': 1 });
    var h = makeCtx(db); loadFns(h);
    h.addCard(pid);
    attach(h, pid);
    assert.strictEqual(Object.keys(db.listeners).length, 3);
    h.sandbox.snfDetachPostCounterSubs(h.ctx, pid);
    var remaining = Object.keys(db.listeners).reduce(function (n, k) { return n + db.listeners[k].length; }, 0);
    assert.strictEqual(remaining, 0, 'quedaron listeners colgados');
  });

  console.log('\n' + passed + ' ok, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
})();
