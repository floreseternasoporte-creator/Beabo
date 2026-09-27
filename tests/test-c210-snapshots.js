/* ================================================================
 * Tests de regresión: Instantáneas C210 (2026-09-27)
 * Fotos efímeras cuadradas (5 h de vida) con bandeja superior en el
 * feed, selector Todos/Siguiendo/Amigos, visor propio con gestos y
 * reacciones de emojis, purga de expiradas y hook de la cámara C209.
 * Verifica sin navegador: lógica pura (TTL, expiración exacta,
 * filtros, agrupado), presencia del markup y paridad i18n ES/EN/ZH/PT.
 * Ejecutar con: node tests/test-c210-snapshots.js [--target <html>]
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var ti = process.argv.indexOf('--target');
var target = ti !== -1 ? process.argv[ti + 1] : path.join(__dirname, '..', 'index.html');
var src = fs.readFileSync(target, 'utf8');
var i18nSrc = fs.readFileSync(path.join(__dirname, '..', 'drex-i18n.js'), 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

// ---- Extraer el bloque JS C210 y evaluarlo con stubs de navegador ----
var m = src.match(/\/\/ ==================== C210 INSTANTÁNEAS ====================\n([\s\S]*?)\n\/\/ ================== FIN C210 INSTANTÁNEAS ==================/);
assert(m, 'bloque C210 no encontrado en ' + target);
var js = m[1];

var stubDoc = {
  readyState: 'complete',
  hidden: false,
  getElementById: function () { return null; },
  addEventListener: function () {},
  querySelector: function () { return null; }
};
function stubFn() { return stubDoc; }
var C210 = new Function(
  'document', 'window', 'DrexCloud', 'appT', 'escapeHtml',
  'showMiniToast', 'lockBodyScroll', 'unlockBodyScroll',
  'localStorage', 'setInterval',
  js + '\nreturn { DREX_SNAP_TTL_HOURS: DREX_SNAP_TTL_HOURS,'
     + ' DREX_SNAP_TTL_MS: DREX_SNAP_TTL_MS,'
     + ' DREX_SNAP_EMOJIS: DREX_SNAP_EMOJIS,'
     + ' drexSnapIsExpired: drexSnapIsExpired,'
     + ' drexSnapRemainingText: drexSnapRemainingText,'
     + ' drexSnapFilterList: drexSnapFilterList,'
     + ' drexSnapLatestByAuthor: drexSnapLatestByAuthor };'
)(
  stubDoc, {},
  { auth: function () { return { currentUser: null }; }, database: function () { throw new Error('no-db'); } },
  function (s) { return s; },
  function (s) { return String(s == null ? '' : s); },
  function () {}, function () {}, function () {},
  { getItem: function () { return null; }, setItem: function () {} },
  function () { return 0; }
);

// ---- 1. Constantes de TTL ----
test('DREX_SNAP_TTL_HOURS es 5', function () {
  assert.strictEqual(C210.DREX_SNAP_TTL_HOURS, 5);
});
test('DREX_SNAP_TTL_MS son 5 horas en ms', function () {
  assert.strictEqual(C210.DREX_SNAP_TTL_MS, 5 * 3600 * 1000);
});

// ---- 2. Expiración exacta (visible a las 4:59, invisible a las 5:01) ----
test('visible a las 4:59, expirada a las 5:01', function () {
  var now = 1000000000000;
  var born = now - 1000;
  var s = { expiresAt: born + C210.DREX_SNAP_TTL_MS };
  assert.strictEqual(C210.drexSnapIsExpired(s, born + (4 * 3600 + 59 * 60) * 1000), false, '4:59 debe verse');
  assert.strictEqual(C210.drexSnapIsExpired(s, born + (5 * 3600 + 60) * 1000), true, '5:01 debe estar expirada');
});
test('en el límite exacto ya está expirada', function () {
  var now = 2000000000000;
  assert.strictEqual(C210.drexSnapIsExpired({ expiresAt: now }, now), true);
});
test('sin expiresAt no expira', function () {
  assert.strictEqual(C210.drexSnapIsExpired({}, Date.now()), false);
  assert.strictEqual(C210.drexSnapIsExpired(null, Date.now()), false);
});

// ---- 3. Texto de tiempo restante ----
test('tiempo restante: horas, minutos y <1 min', function () {
  var now = 3000000000000;
  assert.strictEqual(C210.drexSnapRemainingText(now + 3 * 3600 * 1000, now), 'quedan 3 h');
  assert.strictEqual(C210.drexSnapRemainingText(now + 60 * 60 * 1000, now), 'quedan 1 h');
  assert.strictEqual(C210.drexSnapRemainingText(now + 45 * 60 * 1000, now), 'quedan 45 min');
  assert.strictEqual(C210.drexSnapRemainingText(now + 30 * 1000, now), 'menos de 1 min');
  assert.strictEqual(C210.drexSnapRemainingText(now - 1000, now), 'menos de 1 min');
});

// ---- 4. Set de emojis ----
test('set de 8 emojis únicos', function () {
  assert.strictEqual(C210.DREX_SNAP_EMOJIS.length, 8);
  var seen = {};
  C210.DREX_SNAP_EMOJIS.forEach(function (e) {
    assert(typeof e === 'string' && e.length > 0, 'emoji vacío');
    assert(!seen[e], 'emoji duplicado: ' + e);
    seen[e] = true;
  });
});

// ---- 5. Filtros Todos/Siguiendo/Amigos ----
function mockSnaps() {
  return [
    { id: 's1', a: 'u1', createdAt: 100, expiresAt: 9999999999999 },
    { id: 's2', a: 'u2', createdAt: 200, expiresAt: 9999999999999 },
    { id: 's3', a: 'u3', createdAt: 300, expiresAt: 9999999999999 }
  ];
}
test('filtro all deja todo', function () {
  assert.strictEqual(C210.drexSnapFilterList(mockSnaps(), 'all', {}, {}).length, 3);
});
test('filtro following solo seguidos', function () {
  var out = C210.drexSnapFilterList(mockSnaps(), 'following', { u1: 1, u2: 1 }, {});
  assert.deepStrictEqual(out.map(function (s) { return s.a; }), ['u1', 'u2']);
});
test('filtro friends solo mutuos', function () {
  var out = C210.drexSnapFilterList(mockSnaps(), 'friends', { u1: 1, u2: 1 }, { u1: 1 });
  assert.deepStrictEqual(out.map(function (s) { return s.a; }), ['u1']);
});
test('filtro ignora snaps sin autor y listas vacías', function () {
  assert.deepStrictEqual(C210.drexSnapFilterList([{ id: 'x' }], 'all', {}, {}), []);
  assert.deepStrictEqual(C210.drexSnapFilterList([], 'friends', {}, {}), []);
});

// ---- 6. Agrupado por autor ----
test('latest por autor y orden descendente', function () {
  var list = [
    { id: 'a1', a: 'u1', createdAt: 100 },
    { id: 'a2', a: 'u1', createdAt: 300 },
    { id: 'b1', a: 'u2', createdAt: 200 }
  ];
  var g = C210.drexSnapLatestByAuthor(list);
  assert.strictEqual(g.by.u1.length, 2);
  assert.strictEqual(g.by.u1[0].id, 'a2');
  assert.deepStrictEqual(g.latest.map(function (s) { return s.id; }), ['a2', 'b1']);
});

// ---- 7. Markup en index.html ----
test('bandeja con selector de 3 opciones', function () {
  assert(src.indexOf('id="drex-snap-tray"') !== -1, 'falta #drex-snap-tray');
  var sel = src.match(/<select id="drex-snap-filter"[\s\S]*?<\/select>/);
  assert(sel, 'falta #drex-snap-filter');
  ['value="all"', 'value="following"', 'value="friends"'].forEach(function (v) {
    assert(sel[0].indexOf(v) !== -1, 'falta opción ' + v);
  });
});
test('la bandeja va antes del feed (sobre las publicaciones)', function () {
  var trayPos = src.indexOf('id="drex-snap-tray"');
  var feedPos = src.indexOf('id="notes-feed"');
  assert(trayPos !== -1 && feedPos !== -1 && trayPos < feedPos, 'la bandeja debe ir sobre el feed');
});
test('visor propio presente con sus piezas', function () {
  ['id="drex-snap-viewer"', 'id="drex-snap-viewer-img"', 'id="drex-snap-viewer-top"',
   'id="drex-snap-viewer-time"', 'id="drex-snap-reactions"',
   'id="drex-snap-prev"', 'id="drex-snap-next"'].forEach(function (id) {
    assert(src.indexOf(id) !== -1, 'falta ' + id);
  });
});
test('hook one-shot de la cámara C209 presente', function () {
  assert(src.indexOf('C210: entrega one-shot para instantáneas') !== -1, 'falta el hook en drexCamCapturePhoto');
  assert(src.indexOf('__drexSnapDeliverOnce') !== -1, 'falta __drexSnapDeliverOnce');
});
test('todos los onclick de instantáneas apuntan a funciones definidas', function () {
  var fns = ['drexSnapNew', 'drexSnapFilterChange', 'drexSnapFileChosen', 'drexSnapOpenAuthor',
             'drexSnapCloseViewer', 'drexSnapNav', 'drexSnapToggleReaction', 'drexSnapAskDelete'];
  fns.forEach(function (fn) {
    assert(src.indexOf('function ' + fn + '(') !== -1, 'no definida: ' + fn);
  });
  var calls = src.match(/onclick="drexSnap\w+\(/g) || [];
  assert(calls.length > 0, 'no hay llamadas onclick de instantáneas');
  calls.forEach(function (c) {
    var fn = c.slice(9, -1);
    assert(fns.indexOf(fn) !== -1, 'onclick huérfano: ' + fn);
  });
});
test('constante TTL y purga en el código', function () {
  assert(src.indexOf('DREX_SNAP_TTL_HOURS = 5') !== -1, 'falta la constante TTL');
  assert(src.indexOf('function drexSnapSweep(') !== -1, 'falta drexSnapSweep');
  assert(src.indexOf('userSnapshots/') !== -1, 'falta el índice userSnapshots');
});

// ---- 8. Paridad i18n ----
test('las 19 claves C210 existen en EN/ZH/PT', function () {
  var keys = [
    'Destellos', 'Amigos', 'Filtrar destellos', 'Tomar un destello',
    'Nueva', 'Publicando destello…', 'Tu destello se publicó',
    'No se pudo publicar el destello. Inténtalo de nuevo.',
    'Aún no hay destellos. ¡Sé la primera persona en compartir uno!',
    'quedan {n} h', 'quedan {n} min', 'menos de 1 min',
    'El destello ha expirado', 'Ver destello de ',
    'Inicia sesión para compartir un destello.',
    '¿Eliminar este destello? Esta acción no se puede deshacer.',
    'El destello se eliminó',
    'No se pudo eliminar el destello. Inténtalo de nuevo.',
    'Los destellos desaparecen a las 5 horas'
  ];
  keys.forEach(function (k) {
    var needle = JSON.stringify(k) + ':';
    var n = i18nSrc.split(needle).length - 1;
    assert(n >= 3, 'clave sin paridad completa: ' + k + ' (aparece ' + n + ' veces)');
  });
});

console.log('\n' + passed + ' pasadas, ' + failed + ' fallidas');
process.exit(failed ? 1 : 0);
