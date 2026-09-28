/* ================================================================
 * Tests: C223 doble espacio de nombres de efectos (2026-09-28)
 * Causa raiz: Drex Studio escribe con putPublic('effects/'+id) ->
 *   pk='public', sk='effects/<id>/...'; la app leia solo pk='effects'.
 *   Lo publicado NUNCA aparecia (camara, perfil, bandeja).
 * El fix: la app lee y fusiona AMBOS espacios (canonico gana en
 * colision); aprobar/rechazar y el bump de `usos` escriben en el
 * espacio donde vive cada efecto (`_ns`: 'canon'|'legacy').
 * Simula el flujo REAL: escritura estilo Studio (flatten a hojas
 * pk/sk) -> lecturas/escrituras de la app contra la misma tienda.
 * Ejecutar con: node tests/test-c223-efectos-namespaces.js [--target <ruta>]
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var path = require('path');

var target = path.join(__dirname, '..', 'index.html');
var ti = process.argv.indexOf('--target');
if (ti !== -1 && process.argv[ti + 1]) target = process.argv[ti + 1];
var src = fs.readFileSync(target, 'utf8');

var start = src.indexOf('let drexCamEffects = [];');
assert(start !== -1, 'inicio de helpers de camara no encontrado');
var end = src.indexOf('/* === FIN DREX-EFFECTS v1 === */');
assert(start !== -1 && end !== -1 && end > start, 'bloque de efectos no encontrado');
var code = src.slice(start, end);
assert(code.indexOf('C223') !== -1, 'el codigo C223 no esta en el bloque extraido');

/* ---------- tienda fiel pk/sk (como drex-kv via drex-cloud.js) ---------- */
function makeDb() {
  var store = {}; // "pk\nsk" -> JSON string
  function split(p) {
    var segs = String(p).split('/').filter(function (x) { return x !== ''; });
    return { pk: segs[0] || '', sk: segs.slice(1).join('/') };
  }
  function flatten(obj, segs, out) {
    out = out || [];
    if (obj !== null && typeof obj === 'object') {
      Object.keys(obj).forEach(function (k) { flatten(obj[k], segs.concat([k]), out); });
    } else {
      out.push({ pk: segs[0], sk: segs.slice(1).join('/'), v: JSON.stringify(obj) });
    }
    return out;
  }
  function delSubtree(p) {
    var q = split(p);
    Object.keys(store).forEach(function (k) {
      var i = k.indexOf('\n'), pk = k.slice(0, i), sk = k.slice(i + 1);
      if (pk === q.pk && (sk === q.sk || sk.indexOf(q.sk + '/') === 0)) delete store[k];
    });
  }
  function treeAt(p) {
    var q = split(p), root = {}, found = false;
    Object.keys(store).forEach(function (k) {
      var i = k.indexOf('\n');
      if (k.slice(0, i) !== q.pk) return;
      var sk = k.slice(i + 1);
      if (q.sk && sk !== q.sk && sk.indexOf(q.sk + '/') !== 0) return;
      var rel = q.sk ? sk.slice(q.sk.length).replace(/^\//, '') : sk;
      var segs = rel ? rel.split('/') : [];
      var node = root;
      for (var s = 0; s < segs.length; s++) {
        if (s === segs.length - 1) { node[segs[s]] = JSON.parse(store[k]); found = true; }
        else { if (!node[segs[s]] || typeof node[segs[s]] !== 'object') node[segs[s]] = {}; node = node[segs[s]]; }
      }
      if (!segs.length) { root = JSON.parse(store[k]); found = true; }
    });
    return found ? root : null;
  }
  function ref(p) {
    return {
      once: function () {
        return Promise.resolve({ val: function () { return treeAt(p); } });
      },
      set: function (v) {
        var q = split(p);
        delSubtree(p);
        flatten(v, [q.pk].concat(q.sk ? q.sk.split('/') : [])).forEach(function (l) {
          store[l.pk + '\n' + l.sk] = l.v;
        });
        return Promise.resolve();
      },
      update: function (obj) {
        var q = split(p);
        Object.keys(obj).forEach(function (k) {
          store[q.pk + '\n' + (q.sk ? q.sk + '/' : '') + k] = JSON.stringify(obj[k]);
        });
        return Promise.resolve();
      },
      transaction: function (fn) {
        var q = split(p), key = q.pk + '\n' + q.sk;
        var cur = (key in store) ? JSON.parse(store[key]) : null;
        store[key] = JSON.stringify(fn(cur));
        return Promise.resolve();
      }
    };
  }
  return { ref: ref, _store: store };
}

var OFFICIAL_UID = 'uid-oficial-1';
var db = makeDb();
db.ref('userEmails/darelvega20@gmail.com').set(OFFICIAL_UID); // cuenta oficial
var notifs = [], toasts = [], camCalls = [];
var uidActual = OFFICIAL_UID;

function makeEl(id) {
  return { id: id || '', _html: '', children: [],
    set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; },
    querySelector: function () { return null; } };
}
var registry = {};
var fakeDocument = {
  getElementById: function (id) { return registry[id] || null; },
  createElement: function (t) { return makeEl(); },
  addEventListener: function () {},
  querySelector: function () { return null; }
};

var sandbox = {
  console: console, Math: Math, Date: Date, JSON: JSON, Promise: Promise,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  window: {}, document: fakeDocument,
  DrexCloud: {
    database: function () { return db; },
    auth: function () { return { currentUser: uidActual ? { uid: uidActual } : null }; }
  },
  addNotification: function () { notifs.push(Array.prototype.slice.call(arguments)); return Promise.resolve(); },
  showMiniToast: function (m) { toasts.push(String(m)); },
  drexCamRenderEffects: function () {},   // stub: fuera del bloque extraido
  drexCameraOpen: function () {},        // stub: se define antes del bloque
  appT: undefined
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'drex-effects-c223.js' });
/* drexCamRenderEffects SI esta en el bloque y toca DOM real: neutralizarla */
vm.runInContext('drexCamRenderEffects = function () {};', sandbox);

var passed = 0, failed = 0, seq = Promise.resolve();
function testSeq(name, fn) {
  seq = seq.then(fn).then(
    function () { passed++; console.log('ok - ' + name); },
    function (e) { failed++; console.log('FALLO - ' + name + ': ' + (e && e.message)); }
  );
}
function run(expr) { return vm.runInContext(expr, sandbox); }
function finish() {
  console.log('\n' + passed + ' ok, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
}
/* Escritura EXACTAMENTE como Drex Studio: putPublic('effects/'+id) */
function studioSubmit(fx) {
  return db.ref('public/effects/' + fx.id).set(fx);
}
var STUDIO_FX = {
  id: 'fx_st1', nombre: 'Neon Studio', autorUid: OFFICIAL_UID, portada: '',
  tipo: 'cara', definicion: { filter: 'saturate(2)' }, createdAt: 999,
  usos: 0, status: 'pending'
};

testSeq('1. escritura Studio va a pk=public (reproduce el bug original)', function () {
  return studioSubmit(STUDIO_FX).then(function () {
    var keys = Object.keys(db._store).filter(function (k) { return k.indexOf('effects') !== -1; });
    assert(keys.length > 0, 'se escribieron hojas del efecto');
    assert(keys.every(function (k) { return k.indexOf('public\n') === 0; }), 'todo quedo en pk=public');
    assert(keys.some(function (k) { return k === 'public\neffects/fx_st1/status'; }), 'status en public/effects/fx_st1');
  });
});

testSeq('2. lectura fusionada encuentra el efecto legado con _ns=legacy', function () {
  return run('drexFxReadAllRaw()').then(function (res) {
    assert(res.merged.fx_st1, 'fx_st1 visible en la fusion');
    assert.strictEqual(res.ns.fx_st1, 'legacy');
    var list = run('drexFxWithNs(drexFxNormalizeEffects(' + JSON.stringify(res.merged) + '),' + JSON.stringify(res.ns) + ')');
    assert.strictEqual(list[0]._ns, 'legacy');
    assert.strictEqual(list[0].nombre, 'Neon Studio');
    assert.strictEqual(list[0].status, 'pending');
  });
});

testSeq('3. pendiente legado NO sale en la camara (moderacion intacta)', function () {
  camCalls.length = 0;
  run('drexCameraLoadEffects()');
  return new Promise(function (res) { setTimeout(res, 50); }).then(function () {
    var n = run('drexCamEffects.length');
    assert.strictEqual(n, 0, 'camara vacia con solo un pendiente');
  });
});

testSeq('4. la bandeja oficial VE el pendiente legado', function () {
  registry['drexstudio-review-list'] = makeEl('drexstudio-review-list');
  run('drexFxOfficialUidCache = null');
  return run('drexStudioLoadReviewInbox()').then(function (pend) {
    assert.strictEqual(pend.length, 1, 'un pendiente en bandeja');
    assert.strictEqual(pend[0].id, 'fx_st1');
    assert.strictEqual(pend[0]._ns, 'legacy');
    assert(registry['drexstudio-review-list'].innerHTML.indexOf('Neon Studio') !== -1, 'se renderizo');
  });
});

testSeq('5. aprobar escribe en el espacio LEGADO (no crea fantasma en canon)', function () {
  var n0 = notifs.length;
  return run('drexStudioReviewDecide("fx_st1", true, "")').then(function (ok) {
    assert.strictEqual(ok, true);
    assert.strictEqual(db._store['public\neffects/fx_st1/status'], '"published"', 'status published en legacy');
    var canonKeys = Object.keys(db._store).filter(function (k) { return k.indexOf('effects\n') === 0; });
    assert.deepStrictEqual(canonKeys, [], 'nada escrito en pk=effects: ' + JSON.stringify(canonKeys));
    assert.strictEqual(notifs.length - n0, 1, 'notifico al autor');
  });
});

testSeq('6. tras aprobar, la camara MUESTRA el efecto', function () {
  run('drexCameraLoadEffects()');
  return new Promise(function (res) { setTimeout(res, 50); }).then(function () {
    var got = run('drexCamEffects.map(function(e){return {id:e.id, ns:e._ns, nombre:e.nombre};})');
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].id, 'fx_st1');
    assert.strictEqual(got[0].ns, 'legacy');
    assert.strictEqual(got[0].nombre, 'Neon Studio', 'nombre real, no el id crudo');
  });
});

testSeq('7. bump de usos va al espacio LEGADO (sin fantasma)', function () {
  run('drexFxCache = {}'); // fuerza la ruta read-one
  run('drexFxBumpUsos("fx_st1")');
  return new Promise(function (res) { setTimeout(res, 80); }).then(function () {
    assert.strictEqual(db._store['public\neffects/fx_st1/usos'], '1', 'usos=1 en legacy');
    var canonKeys = Object.keys(db._store).filter(function (k) { return k.indexOf('effects\n') === 0; });
    assert.deepStrictEqual(canonKeys, [], 'sin fantasma en canonico');
  });
});

testSeq('8. el canonico gana en colision de id', function () {
  return db.ref('effects/fx_col').set({
    id: 'fx_col', nombre: 'Neon Canonico', autorUid: 'otro', status: 'published', usos: 5, createdAt: 1
  }).then(function () {
    return db.ref('public/effects/fx_col').set({
      id: 'fx_col', nombre: 'Neon Legado', autorUid: 'otro', status: 'published', usos: 2, createdAt: 2
    });
  }).then(function () { return run('drexFxReadAllRaw()'); }).then(function (res) {
    assert.strictEqual(res.ns.fx_col, 'canon', 'canonico gana');
    assert.strictEqual(res.merged.fx_col.nombre, 'Neon Canonico');
  });
});

testSeq('9. read-one: canonico primero, legado como fallback', function () {
  return run('drexFxReadOneEffect("fx_col")').then(function (fx) {
    assert(fx && fx._ns === 'canon' && fx.nombre === 'Neon Canonico', 'canonico primero');
    return db.ref('public/effects/fx_leg2').set({
      id: 'fx_leg2', nombre: 'Solo Legado', autorUid: 'u9', status: 'pending', usos: 0, createdAt: 2
    });
  }).then(function () { return run('drexFxReadOneEffect("fx_leg2")'); }).then(function (fx) {
    assert(fx && fx._ns === 'legacy' && fx.nombre === 'Solo Legado', 'fallback a legacy');
    return run('drexFxReadOneEffect("fx_noexiste")');
  }).then(function (fx) {
    assert.strictEqual(fx, null, 'inexistente => null');
  });
});

testSeq('10. useEffect: pendiente legado avisa y no abre camara', function () {
  run('drexFxCache = {}');
  toasts.length = 0; camCalls.length = 0;
  sandbox.window.drexCameraOpen = function (d) { camCalls.push(d); };
  run('drexFxUseEffect("fx_leg2")');
  return new Promise(function (res) { setTimeout(res, 60); }).then(function () {
    assert.strictEqual(camCalls.length, 0, 'camara no abierta');
    assert(toasts.some(function (t) { return t.indexOf('a\u00fan no est\u00e1 publicado') !== -1; }), 'toast mostrado');
  });
});

testSeq('11. el autor ve su pendiente legado en su pestana (badge En revision)', function () {
  return studioSubmit({ id: 'fx_st2', nombre: 'Gris Studio', autorUid: OFFICIAL_UID, portada: '',
    tipo: 'cara', definicion: { filter: 'grayscale(1)' }, createdAt: 1000, usos: 0, status: 'pending'
  }).then(function () {
    return run('drexFxFetchAuthorEffects("' + OFFICIAL_UID + '", true)');
  }).then(function (list) {
    var mine = list.filter(function (e) { return e.autorUid === OFFICIAL_UID; });
    assert(mine.some(function (e) { return e.id === 'fx_st2'; }), 'el autor ve su efecto');
    var html = run('drexFxCardHTML(' + JSON.stringify(mine.filter(function (e) { return e.id === 'fx_st2'; })[0]) + ', {showStatus:true})');
    assert(html.indexOf('En revisi\u00f3n') !== -1, 'badge En revision');
    assert(html.indexOf('disabled') !== -1, 'Usar deshabilitado');
  });
});

testSeq('12. rechazar en legado escribe reviewNote en legacy', function () {
  run('drexFxOfficialUidCache = null');
  return run('drexStudioReviewDecide("fx_leg2", false, "motivo x")').then(function (ok) {
    assert.strictEqual(ok, true);
    assert.strictEqual(db._store['public\neffects/fx_leg2/status'], '"rejected"');
    assert.strictEqual(db._store['public\neffects/fx_leg2/reviewNote'], '"motivo x"');
  });
});

seq.then(finish);
