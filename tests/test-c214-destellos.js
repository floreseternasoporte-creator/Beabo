/* ================================================================
 * Tests de regresión: Destellos C214 (2026-09-27)
 * (1) Eliminar destello: solo el autor puede borrar el suyo
 *     (registro en snapshots/, imagen en snapImages/ e índice
 *     userSnapshots/); otro usuario no puede ni ver la opción.
 * (2) Renombre visible Instantáneas -> Destellos (ES), Glimmers
 *     (EN), 闪光 (ZH), Lampejos (PT): ningún texto visible al
 *     usuario conserva el nombre copiado.
 * Verifica sin navegador. Ejecutar con: node tests/test-c214-destellos.js
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
var removedPaths = [];
function fakeRef(path) {
  return {
    remove: function () { removedPaths.push(path); return Promise.resolve(); },
    set: function () { return Promise.resolve(); },
    once: function () { return Promise.resolve({ val: function () { return null; }, forEach: function () {} }); },
    push: function () { return { key: 'k1' }; },
    orderByChild: function () { return this; },
    limitToLast: function () { return this; }
  };
}
var fakeDb = { ref: fakeRef };

var setup = '\nwindow.__setSnapViewer=function(l,i){_snapViewerList=l;_snapViewerIndex=i;};\n';
var C214 = new Function(
  'document', 'window', 'DrexCloud', 'appT', 'escapeHtml',
  'showMiniToast', 'lockBodyScroll', 'unlockBodyScroll',
  'localStorage', 'setInterval',
  js + setup + '\nreturn { drexSnapDelete: drexSnapDelete,'
    + ' drexSnapAskDelete: drexSnapAskDelete,'
    + ' drexSnapRenderViewer: drexSnapRenderViewer,'
    + ' drexSnapMe: drexSnapMe };'
)(
  stubDoc, stubWin,
  { auth: function () { return { currentUser: currentUserVar }; }, database: function () { return fakeDb; } },
  function (s) { return s; },
  function (s) { return String(s == null ? '' : s); },
  function () {}, function () {}, function () {},
  { getItem: function () { return null; }, setItem: function () {} },
  function () { return 0; }
);

function snapAlice() {
  return { id: 's1', a: 'alice', createdAt: 1, expiresAt: Date.now() + 3600000 };
}

// ---- 1. El autor SÍ puede eliminar: borra registro + imagen + índice ----
atest('el autor elimina: se borran snapshots/, snapImages/ y userSnapshots/', function () {
  removedPaths = [];
  currentUserVar = { uid: 'alice' };
  return C214.drexSnapDelete(snapAlice()).then(function (ok) {
    assert.strictEqual(ok, true, 'debe resolver true');
    assert.deepStrictEqual(removedPaths, ['snapshots/s1', 'snapImages/s1', 'userSnapshots/alice/s1']);
  });
});

// ---- 2. Otro usuario NO puede eliminar: ni siquiera llega al confirm ----
atest('un no-autor no borra nada (drexSnapDelete resuelve false)', function () {
  removedPaths = [];
  currentUserVar = { uid: 'bob' };
  return C214.drexSnapDelete(snapAlice()).then(function (ok) {
    assert.strictEqual(ok, false, 'debe resolver false');
    assert.strictEqual(removedPaths.length, 0, 'no debe tocar la BD');
  });
});
atest('drexSnapAskDelete con no-autor no pide confirmación ni borra', function () {
  removedPaths = [];
  currentUserVar = { uid: 'bob' };
  stubWin.__setSnapViewer([snapAlice()], 0);
  var confirmCalls = 0;
  globalThis.confirm = function () { confirmCalls++; return true; };
  try {
    C214.drexSnapAskDelete();
  } finally { delete globalThis.confirm; }
  assert.strictEqual(confirmCalls, 0, 'no debe mostrar el diálogo');
  assert.strictEqual(removedPaths.length, 0, 'no debe tocar la BD');
  return Promise.resolve();
});
atest('drexSnapAskDelete con el autor confirma y borra', function () {
  removedPaths = [];
  currentUserVar = { uid: 'alice' };
  stubWin.__setSnapViewer([snapAlice()], 0);
  var confirmCalls = 0;
  globalThis.confirm = function () { confirmCalls++; return true; };
  try { C214.drexSnapAskDelete(); } finally { delete globalThis.confirm; }
  assert.strictEqual(confirmCalls, 1, 'debe pedir confirmación una vez');
  return new Promise(function (res) { setTimeout(res, 100); }).then(function () {
    assert.deepStrictEqual(removedPaths, ['snapshots/s1', 'snapImages/s1', 'userSnapshots/alice/s1']);
  });
});

// ---- 3. El botón Eliminar solo se muestra al autor ----
test('el visor muestra Eliminar al autor y lo oculta a otros', function () {
  currentUserVar = { uid: 'alice' };
  stubWin.__setSnapViewer([snapAlice()], 0);
  C214.drexSnapRenderViewer();
  assert.strictEqual(getEl('drex-snap-delete').style.display, '', 'autor: visible');
  currentUserVar = { uid: 'bob' };
  C214.drexSnapRenderViewer();
  assert.strictEqual(getEl('drex-snap-delete').style.display, 'none', 'no-autor: oculto');
});
test('markup: existe el botón #drex-snap-delete con drexSnapAskDelete', function () {
  assert(src.indexOf('id="drex-snap-delete"') !== -1, 'falta el botón en el visor');
  assert(src.indexOf('onclick="drexSnapAskDelete()"') !== -1, 'falta el onclick');
  assert(src.indexOf('function drexSnapAskDelete(') !== -1, 'falta la función');
  assert(src.indexOf('function drexSnapDelete(') !== -1, 'falta la función');
});

// ---- 4. Renombre: ningún texto visible dice "instantánea" ----
test('ningún appT visible contiene "instantánea"', function () {
  var lits = [];
  var re = /appT\('((?:[^'\\]|\\.)*)'\)/g, mm;
  while ((mm = re.exec(src))) lits.push(mm[1]);
  assert(lits.length > 0, 'no se encontraron literales appT');
  var bad = lits.filter(function (l) { return /instantánea/i.test(l); });
  assert.strictEqual(bad.length, 0, 'literales con instantánea: ' + JSON.stringify(bad.slice(0, 3)));
});
test('la bandeja y el visor usan "Destellos" por defecto', function () {
  assert(src.indexOf('>Destellos</span>') !== -1, 'falta el título Destellos');
  assert(src.indexOf('aria-label="Destellos"') !== -1, 'falta el aria Destellos');
  assert(src.indexOf('aria-label="Filtrar destellos"') !== -1, 'falta el aria del filtro');
  assert(src.indexOf('aria-label="Destello"') !== -1, 'falta el aria del visor');
});
test('i18n: Destellos -> Glimmers / 闪光 / Lampejos y sin rastros del nombre viejo', function () {
  var dicts = {};
  ['APP_ENGLISH_TEXT', 'APP_CHINESE_TEXT', 'APP_PORTUGUESE_TEXT'].forEach(function (n) {
    var dm = i18nSrc.match(new RegExp('var ' + n + ' = \\{([\\s\\S]*?)\\n\\};'));
    assert(dm, 'diccionario no encontrado: ' + n);
    dicts[n] = new Function('return {' + dm[1] + '}')();
  });
  assert.strictEqual(dicts.APP_ENGLISH_TEXT['Destellos'], 'Glimmers');
  assert.strictEqual(dicts.APP_CHINESE_TEXT['Destellos'], '闪光');
  assert.strictEqual(dicts.APP_PORTUGUESE_TEXT['Destellos'], 'Lampejos');
  var keys = ['Destellos', 'Filtrar destellos', 'Tomar un destello', 'Publicando destello…',
    'Tu destello se publicó', 'No se pudo publicar el destello. Inténtalo de nuevo.',
    'Aún no hay destellos. ¡Sé la primera persona en compartir uno!',
    'El destello ha expirado', 'Ver destello de ', 'Inicia sesión para compartir un destello.',
    '¿Eliminar este destello? Esta acción no se puede deshacer.', 'El destello se eliminó',
    'No se pudo eliminar el destello. Inténtalo de nuevo.', 'Los destellos desaparecen a las 5 horas'];
  var legacy = /instantánea/i, legacyEn = /snapshot/i, legacyZh = /快拍/, legacyPt = /instantâneo/i;
  Object.keys(dicts).forEach(function (dn) {
    keys.forEach(function (k) {
      var v = dicts[dn][k];
      assert(typeof v === 'string' && v.length > 0, dn + ': falta valor para ' + k);
      assert(!legacy.test(v), dn + ': rastro ES en ' + k);
      assert(!legacyEn.test(v), dn + ': rastro EN en ' + k);
      assert(!legacyZh.test(v), dn + ': rastro ZH en ' + k);
      assert(!legacyPt.test(v), dn + ': rastro PT en ' + k);
    });
  });
});

// ---- correr los async en serie ----
asyncTests.reduce(function (p, t) {
  return p.then(function () {
    return t.fn().then(
      function () { passed++; console.log('ok - ' + t.name); },
      function (e) { failed++; console.log('FALLO - ' + t.name + ': ' + (e && e.message)); }
    );
  });
}, Promise.resolve()).then(function () {
  console.log('\n' + passed + ' pasadas, ' + failed + ' fallidas');
  process.exit(failed ? 1 : 0);
});
