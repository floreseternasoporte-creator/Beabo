/* ================================================================
 * Tests de regresión: Destellos C215 — rediseño diamante premium (2026-09-27)
 * (1) Miniaturas en forma de diamante: foto enderezada, borde índigo
 *     #2F33B8 con degradado cónico, anillo de tiempo restante de 5 h,
 *     brillo animado en no vistos y borde apagado en vistos.
 * (2) Tiempo restante preciso "quedan 3 h 12 min" (no solo horas).
 * (3) Orden de la bandeja: no vistos primero, luego por recencia.
 * (4) Contador de vistas únicas: snapViews/<id>/<uid>; el autor ve "N vistas".
 * (5) Doble toque en el visor = enviar ❤️.
 * (6) Silenciar destellos de un usuario (snapMuted/<me>/<autor>) sin
 *     dejar de seguirlo, con forma real de des-silenciar.
 * (7) Responder abre el chat directo existente con el autor.
 * (8) Estados premium: skeleton de carga, vacío con CTA.
 * Verifica sin navegador. Ejecutar con: node tests/test-c215-destellos-premium.js
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var target = path.join(__dirname, '..', 'index.html');
var src = fs.readFileSync(target, 'utf8');
var i18nSrc = fs.readFileSync(path.join(__dirname, '..', 'drex-i18n.js'), 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}
var asyncTests = [];
function atest(name, fn) { asyncTests.push({ name: name, fn: fn }); }

// ---- Extraer el bloque JS C210 y evaluarlo con stubs ----
var m = src.match(/\/\/ ==================== C210 INSTANTÁNEAS ====================\n([\s\S]*?)\n\/\/ ================== FIN C210 INSTANTÁNEAS ==================/);
assert(m, 'bloque C210 no encontrado en ' + target);
var js = m[1];

function fakeEl() {
  return {
    style: {}, dataset: {},
    classList: { toggle: function () {}, add: function () {}, remove: function () {}, contains: function () { return false; } },
    setAttribute: function () {}, getAttribute: function () { return null; },
    textContent: '', innerHTML: '', src: '', alt: '', value: undefined,
    querySelector: function () { return null; }, focus: function () {}
  };
}
var els = {};
function getEl(id) { return els[id] || (els[id] = fakeEl()); }
var stubDoc = {
  readyState: 'complete', hidden: false, activeElement: null,
  body: { classList: { add: function () {}, remove: function () {} } },
  getElementById: getEl,
  addEventListener: function () {},
  querySelector: function () { return null; }
};
var stubWin = {};
var currentUserVar = null;
var setPaths = [], removedPaths = [];
var mutedStore = {}; // snapMuted/<me> -> {uid:true} (simula la BD real)
function fakeRef(p) {
  return {
    remove: function () {
      removedPaths.push(p);
      var m = p.match(/^snapMuted\/([^/]+)\/(.+)$/);
      if (m && mutedStore[m[1]]) delete mutedStore[m[1]][m[2]];
      return Promise.resolve();
    },
    set: function () {
      setPaths.push(p);
      var m2 = p.match(/^snapMuted\/([^/]+)\/(.+)$/);
      if (m2) { (mutedStore[m2[1]] = mutedStore[m2[1]] || {})[m2[2]] = true; }
      return Promise.resolve();
    },
    once: function () {
      var m3 = p.match(/^snapMuted\/([^/]+)$/);
      var v = m3 ? (mutedStore[m3[1]] || null) : null;
      return Promise.resolve({ val: function () { return v; }, forEach: function () {} });
    },
    push: function () { return { key: 'k1' }; },
    orderByChild: function () { return this; },
    limitToLast: function () { return this; }
  };
}
var fakeDb = { ref: fakeRef };
var lsStore = {};
var stubLocalStorage = {
  getItem: function (k) { return (k in lsStore) ? lsStore[k] : null; },
  setItem: function (k, v) { lsStore[k] = String(v); },
  removeItem: function (k) { delete lsStore[k]; }
};

var setup = '\nwindow.__setSnapViewer=function(l,i){_snapViewerList=l;_snapViewerIndex=i;};\n'
  + 'window.__resetSnapViewed=function(){_snapViewedSession={};};\n'
  + 'window.__setSnapAuthorSnaps=function(v){_snapAuthorSnaps=v;};\n';
var C215 = new Function(
  'document', 'window', 'DrexCloud', 'appT', 'escapeHtml',
  'showMiniToast', 'lockBodyScroll', 'unlockBodyScroll',
  'localStorage', 'setInterval',
  js + setup + '\nreturn { drexSnapRemainingText: drexSnapRemainingText,'
    + ' drexSnapPct: drexSnapPct,'
    + ' drexSnapSeenGet: drexSnapSeenGet, drexSnapSeenSet: drexSnapSeenSet,'
    + ' drexSnapSortTray: drexSnapSortTray, drexSnapApplyMute: drexSnapApplyMute,'
    + ' drexSnapIsMuted: drexSnapIsMuted, drexSnapToggleMute: drexSnapToggleMute,'
    + ' drexSnapDoubleTapHeart: drexSnapDoubleTapHeart,'
    + ' drexSnapReply: drexSnapReply, drexSnapCloseViewer: drexSnapCloseViewer,'
    + ' drexSnapRenderViewer: drexSnapRenderViewer, drexSnapMe: drexSnapMe,'
    + ' drexSnapTickTrayRings: drexSnapTickTrayRings };'
)(
  stubDoc, stubWin,
  { auth: function () { return { currentUser: currentUserVar }; }, database: function () { return fakeDb; } },
  function (s) { return s; },
  function (s) { return String(s == null ? '' : s); },
  function () {}, function () {}, function () {},
  stubLocalStorage,
  function () { return 0; }
);

function snapOf(id, a, createdAgoMs) {
  var now = Date.now();
  return { id: id, a: a, createdAt: now - createdAgoMs, expiresAt: now - createdAgoMs + 5 * 3600000 };
}

// ================= (2) Tiempo restante preciso =================
test('tiempo restante preciso: 3 h 12 min', function () {
  var now = Date.now();
  assert.strictEqual(C215.drexSnapRemainingText(now + (3 * 60 + 12) * 60000, now), 'quedan 3 h 12 min');
});
test('tiempo restante: horas exactas sin minutos', function () {
  var now = Date.now();
  assert.strictEqual(C215.drexSnapRemainingText(now + 2 * 3600000, now), 'quedan 2 h');
});
test('tiempo restante: menos de 1 h muestra minutos', function () {
  var now = Date.now();
  assert.strictEqual(C215.drexSnapRemainingText(now + 45 * 60000, now), 'quedan 45 min');
});
test('tiempo restante: expirado dice menos de 1 min', function () {
  assert.strictEqual(C215.drexSnapRemainingText(Date.now() - 1000), 'menos de 1 min');
});

// ================= (1) Anillo de tiempo =================
test('fracción del anillo: 2.5 h de 5 h = 50%', function () {
  var now = Date.now();
  var s = { expiresAt: now + 2.5 * 3600000 };
  assert.strictEqual(C215.drexSnapPct(s, now), 50);
});
test('fracción del anillo: expirado = 0', function () {
  assert.strictEqual(C215.drexSnapPct({ expiresAt: Date.now() - 1 }, Date.now()), 0);
});

// ================= (3) Orden: no vistos primero =================
test('bandeja: no vistos primero, luego por recencia', function () {
  var s1 = snapOf('s1', 'a', 300000); // no visto, viejo
  var s2 = snapOf('s2', 'b', 60000);  // visto, nuevo
  var s3 = snapOf('s3', 'c', 120000); // no visto, medio
  var out = C215.drexSnapSortTray([s1, s2, s3], { s2: 1 });
  assert.deepStrictEqual(out.map(function (s) { return s.id; }), ['s3', 's1', 's2']);
});

// ================= vistos (localStorage) =================
test('visto: set + get redondo', function () {
  lsStore = {};
  C215.drexSnapSeenSet('sx');
  assert.ok(C215.drexSnapSeenGet().sx, 'debe recordar sx como visto');
});

// ================= (6) Silenciar =================
test('silenciar filtra al autor sin borrar nada', function () {
  var list = [snapOf('s1', 'alice', 1000), snapOf('s2', 'bob', 2000)];
  var out = C215.drexSnapApplyMute(list, { alice: true });
  assert.deepStrictEqual(out.map(function (s) { return s.id; }), ['s2']);
});
atest('silenciar: escribe snapMuted/<me>/<autor>', function () {
  setPaths = []; removedPaths = [];
  currentUserVar = { uid: 'bob' };
  stubWin.__resetSnapViewed();
  return C215.drexSnapToggleMute('alice', 'alice').then(function (ok) {
    assert.strictEqual(ok, true);
    assert.ok(setPaths.indexOf('snapMuted/bob/alice') !== -1, 'debe escribir snapMuted/bob/alice');
    assert.ok(C215.drexSnapIsMuted('alice'), 'isMuted debe ser true');
  });
});
atest('des-silenciar: borra snapMuted/<me>/<autor>', function () {
  setPaths = []; removedPaths = [];
  currentUserVar = { uid: 'bob' };
  return C215.drexSnapToggleMute('alice', 'alice').then(function (ok) {
    assert.strictEqual(ok, true);
    assert.ok(removedPaths.indexOf('snapMuted/bob/alice') !== -1, 'debe borrar snapMuted/bob/alice');
    assert.ok(!C215.drexSnapIsMuted('alice'), 'isMuted debe volver a false');
  });
});
atest('silenciar al propio autor no hace nada', function () {
  setPaths = []; removedPaths = [];
  currentUserVar = { uid: 'bob' };
  return C215.drexSnapToggleMute('bob', 'bob').then(function (ok) {
    assert.strictEqual(ok, false);
    assert.strictEqual(setPaths.length, 0, 'no debe escribir nada');
  });
});

// ================= (5) Doble toque = ❤️ =================
atest('doble toque envía ❤️ como reacción', function () {
  setPaths = [];
  currentUserVar = { uid: 'bob' };
  stubWin.__resetSnapViewed();
  stubWin.__setSnapViewer([snapOf('s1', 'alice', 1000)], 0);
  C215.drexSnapDoubleTapHeart(100, 120);
  return new Promise(function (res) { setTimeout(res, 60); }).then(function () {
    var heart = 'snapshots/s1/reactions/❤️/bob';
    assert.ok(setPaths.indexOf(heart) !== -1, 'debe enviar ❤️, paths: ' + setPaths.join(','));
  });
});

// ================= (4) Vistas únicas =================
atest('ver destello ajeno registra vista única en snapViews/<id>/<uid>', function () {
  setPaths = [];
  currentUserVar = { uid: 'bob' };
  stubWin.__resetSnapViewed();
  stubWin.__setSnapViewer([snapOf('s1', 'alice', 1000)], 0);
  C215.drexSnapRenderViewer();
  assert.ok(setPaths.indexOf('snapViews/s1/bob') !== -1, 'debe registrar snapViews/s1/bob');
  setPaths = [];
  C215.drexSnapRenderViewer();
  assert.strictEqual(setPaths.length, 0, 'segunda vista en la sesión no duplica');
});

// ================= Botón ••• solo para no-autores =================
test('botón de opciones visible solo para no-autores', function () {
  stubWin.__setSnapViewer([snapOf('s1', 'alice', 1000)], 0);
  currentUserVar = { uid: 'bob' };
  C215.drexSnapRenderViewer();
  assert.strictEqual(getEl('drex-snap-more').style.display, '', 'no-autor ve el botón');
  currentUserVar = { uid: 'alice' };
  C215.drexSnapRenderViewer();
  assert.strictEqual(getEl('drex-snap-more').style.display, 'none', 'el autor no ve el botón');
});
test('eliminar sigue visible solo para el autor (C214)', function () {
  stubWin.__setSnapViewer([snapOf('s1', 'alice', 1000)], 0);
  currentUserVar = { uid: 'alice' };
  C215.drexSnapRenderViewer();
  assert.strictEqual(getEl('drex-snap-delete').style.display, '', 'el autor ve eliminar');
  currentUserVar = { uid: 'bob' };
  C215.drexSnapRenderViewer();
  assert.strictEqual(getEl('drex-snap-delete').style.display, 'none', 'el no-autor no ve eliminar');
});

// ================= (7) Responder abre el chat directo =================
atest('responder abre el chat directo existente con el autor', function () {
  var opened = [];
  globalThis.openChatRoomFromInbox = function (uid) { opened.push(uid); };
  stubWin.__setSnapViewer([snapOf('s1', 'alice', 1000)], 0);
  currentUserVar = { uid: 'bob' };
  globalThis.openChatRoomFromInbox = function (uid) { opened.push(uid); };
  C215.drexSnapReply();
  return new Promise(function (res) { setTimeout(res, 450); }).then(function () {
    delete globalThis.openChatRoomFromInbox;
    assert.deepStrictEqual(opened, ['alice'], 'debe abrir el chat con el autor');
    assert.ok(getEl('drex-snap-viewer').classList, 'visor manipulado sin errores');
  });
});

// ================= Tick del anillo sin reconstruir =================
test('tick del anillo actualiza --snap-pct y etiqueta en vivo', function () {
  var now = Date.now();
  var s = { id: 's1', a: 'alice', createdAt: now - 9000000, expiresAt: now + 9000000 }; // 2.5 h restantes
  stubWin.__setSnapAuthorSnaps({ alice: [s] });
  var gotPct = null;
  var ring = { style: { setProperty: function (k, v) { if (k === '--snap-pct') gotPct = v; } } };
  var titleSet = null;
  var dia = {
    classList: { contains: function () { return false; }, toggle: function () {} },
    querySelector: function (sel) { return sel === '.drex-snap-ring' ? ring : null; },
    setAttribute: function (k, v) { if (k === 'title') titleSet = v; }
  };
  var lab = { textContent: '' };
  var cell = {
    querySelector: function (sel) {
      if (sel === '.drex-snap-diamond') return dia;
      if (sel === '.drex-snap-tlabel') return lab;
      return null;
    },
    getAttribute: function () { return "drexSnapOpenAuthor('alice')"; }
  };
  els['drex-snap-row'] = { querySelectorAll: function () { return [cell]; } };
  lsStore = {};
  C215.drexSnapTickTrayRings(now);
  assert.strictEqual(gotPct, 50, 'el anillo debe marcar 50%');
  assert.strictEqual(lab.textContent, 'quedan 2 h 30 min', 'la etiqueta se actualiza');
  assert.strictEqual(titleSet, 'quedan 2 h 30 min', 'el tooltip se actualiza');
  assert.ok(dia, 'sin errores');
  delete els['drex-snap-row'];
});

// ================= (1)+(8) Marcado diamante =================
test('CSS: diamante con clip-path y anillo cónico índigo #2F33B8', function () {
  assert.ok(src.indexOf('clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)') !== -1, 'clip-path diamante');
  assert.ok(src.indexOf('conic-gradient') !== -1, 'degradado cónico del anillo');
  assert.ok(src.indexOf('--snap-pct') !== -1, 'variable de fracción del anillo');
});
test('CSS: no vistos con brillo animado, vistos apagados', function () {
  assert.ok(src.indexOf('drex-snap-glow') !== -1, 'animación de brillo');
  assert.ok(src.indexOf('.drex-snap-diamond.seen .drex-snap-ring') !== -1, 'estilo de vistos');
});
test('CSS: skeleton de carga y estado vacío premium', function () {
  assert.ok(src.indexOf('drex-snap-skel') !== -1, 'skeleton');
  assert.ok(src.indexOf('drex-snap-empty-wrap') !== -1, 'estado vacío');
  assert.ok(src.indexOf('drex-snap-heart-pop') !== -1, 'corazón flotante');
});
test('ya no hay miniaturas cuadradas', function () {
  assert.strictEqual(src.indexOf('drex-snap-tile'), -1, 'clase cuadrada eliminada');
});
test('botón + diamante y botón de silenciados existen', function () {
  assert.ok(src.indexOf('drex-snap-new') !== -1, 'botón + diamante');
  assert.ok(src.indexOf('id="drex-snap-muted-btn"') !== -1, 'botón Silenciados');
  assert.ok(src.indexOf('id="drex-snap-more"') !== -1, 'botón ••• del visor');
  assert.ok(src.indexOf('drexSnapOpenMutedSheet') !== -1, 'hoja de gestión de silenciados');
});
test('el borrado y la purga también limpian snapViews', function () {
  assert.ok(src.indexOf("db.ref('snapViews/' + s.id).remove()") !== -1, 'purga limpia vistas');
  assert.ok(src.indexOf("db.ref('snapViews/' + id).remove()") !== -1, 'borrado limpia vistas');
});
test('sin menciones visibles a SpaceX', function () {
  assert.strictEqual(src.toLowerCase().indexOf('spacex'), -1, 'ninguna mención a SpaceX');
});

// ================= i18n C215 =================
test('claves C215 presentes en EN/ZH/PT', function () {
  ['quedan {h} h {m} min', '{n} vistas', '1 vista', 'Silenciar destellos de {u}',
   'Dejar de silenciar a {u}', 'Destellos de {u} silenciados',
   'Volverás a ver sus destellos', 'Ya no verás sus destellos',
   'Destellos silenciados', 'Sin destellos silenciados', 'Sin destellos',
   'No se pudo abrir el chat. Inténtalo de nuevo.'
  ].forEach(function (k) {
    assert.ok(i18nSrc.indexOf('"' + k + '"') !== -1, 'falta clave: ' + k);
  });
});

// ---- Correr pruebas async en serie ----
(asyncTests.reduce(function (p, t) {
  return p.then(function () {
    return Promise.resolve().then(t.fn).then(
      function () { passed++; console.log('ok - ' + t.name); },
      function (e) { failed++; console.log('FALLO - ' + t.name + ': ' + (e && e.message)); }
    );
  });
}, Promise.resolve())).then(function () {
  console.log('\nRESULTADO C215: ' + passed + ' ok, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
});
