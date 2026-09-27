/* ================================================================
 * Tests de regresión: feed principal cronológico (2026-09-27)
 * P1: la pestaña principal "Descubre" ("Para ti") y "Mi gente" son
 *     CRONOLÓGICAS — lo más reciente primero, estilo Instagram — por
 *     pedido directo del usuario. El ranking algorítmico legado queda
 *     desactivado por defecto (flag window.DREX_FORYOU_CHRONO).
 * P2: "Destacados" y "Mi Marea" CONSERVAN su orden por puntaje: ese es
 *     su propósito (no tocar sus rankings).
 * P3: el aviso al cambiar de pestaña refleja el modo real.
 * Ejecutar con: node tests/test-c204-feed-chrono.js
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var src = fs.readFileSync(__dirname + '/../index.html', 'utf8');
var engineSrc = fs.readFileSync(__dirname + '/../drex-rec-engine.js', 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}
function mustContain(hay, needle, label) {
  assert(hay.indexOf(needle) !== -1, label + ' no encontrado');
}

/* ---------- P1: el flag cronológico existe y está activo ---------- */
test('flag DREX_FORYOU_CHRONO declarado y en true por defecto', function () {
  mustContain(src, 'window.DREX_FORYOU_CHRONO = true;', 'flag');
});

/* ---------- P1: el batch inicial de foryou/following va por fecha ---------- */
test('snfMountInitialBatch ordena foryou/following por timestamp ascendente', function () {
  var start = src.indexOf('function snfMountInitialBatch(ctx)');
  assert(start !== -1, 'snfMountInitialBatch no encontrada');
  var body = src.slice(start, start + 2200);
  mustContain(body, "window.DREX_FORYOU_CHRONO === true && (ctx.feedMode === 'foryou' || ctx.feedMode === 'following')", 'rama cronológica');
  mustContain(body, 'Number(a.timestamp || 0) - Number(b.timestamp || 0)', 'orden ascendente por timestamp');
});

/* ---------- P1: los posts en vivo de foryou ya no usan score ---------- */
test('snfMountFeedPost no inserta por score en foryou cuando es cronológico', function () {
  var start = src.indexOf('function snfMountFeedPost(ctx, note, appendAtBottom');
  assert(start !== -1, 'snfMountFeedPost no encontrada');
  var body = src.slice(start, start + 4200);
  mustContain(body, "ctx.feedMode === 'foryou' && window.DREX_FORYOU_CHRONO !== true", 'guarda cronológica');
  assert(body.indexOf('Ranking algorítmico legado de "Para ti" (desactivado') !== -1,
    'el ranking por score debe quedar marcado como legado/desactivado');
});

/* ---------- P1: la red de seguridad no re-desordena ---------- */
test('drexRecResortForYou no reordena cuando el feed es cronológico', function () {
  var start = src.indexOf('function drexRecResortForYou()');
  assert(start !== -1, 'drexRecResortForYou no encontrada');
  var body = src.slice(start, start + 600);
  mustContain(body, 'if (window.DREX_FORYOU_CHRONO === true) return;', 'salida temprana');
});

test('DrexRecEngine.resortForYou no reordena cuando el feed es cronológico', function () {
  var start = engineSrc.indexOf('resortForYou: function');
  assert(start !== -1, 'resortForYou no encontrada en el motor');
  var body = engineSrc.slice(start, start + 700);
  mustContain(body, 'window.DREX_FORYOU_CHRONO !== false', 'salida temprana cronológica');
});

/* ---------- P2: popular y marea conservan su ranking ---------- */
test('"Destacados" y "Mi Marea" conservan su orden por puntaje', function () {
  var start = src.indexOf('function snfMountInitialBatch(ctx)');
  var body = src.slice(start, start + 2200);
  mustContain(body, "if (ctx.feedMode === 'marea')", 'rama marea intacta');
  mustContain(body, 'drexMareaSortBatch(ctx, ctx._initialBatch)', 'ranking de marea intacto');
  mustContain(src, 'rankFeed', 'el motor de ranking sigue existiendo para otros usos');
});

/* ---------- P3: el aviso de pestaña refleja el modo ---------- */
test('cambiar a Descubre avisa "Mostrando lo más reciente"', function () {
  var start = src.indexOf('function switchFeedTab(');
  assert(start !== -1, 'switchFeedTab no encontrada');
  var body = src.slice(start, start + 4500);
  mustContain(body, "showToast(appT('Mostrando lo más reciente'))", 'toast cronológico');
});

test('la clave i18n existe en EN/ZH/PT (paridad)', function () {
  var i18n = fs.readFileSync(__dirname + '/../drex-i18n.js', 'utf8');
  var n = 0, i = -1;
  while ((i = i18n.indexOf('"Mostrando lo más reciente"', i + 1)) !== -1) n++;
  assert(n === 3, 'se esperaban 3 definiciones (EN/ZH/PT), hay ' + n);
});

/* ---------- P1 (lógica pura): prepend + orden ascendente = newest-first ---------- */
test('semántica: batch ascendente + prepend deja lo más reciente arriba', function () {
  // child_added entrega ascendente [100,200,300]; el sort cronológico lo
  // mantiene; snfMountFeedPost hace prepend de cada uno.
  var batch = [{ id: 'a', timestamp: 100 }, { id: 'b', timestamp: 300 }, { id: 'c', timestamp: 200 }];
  batch.sort(function (x, y) { return Number(x.timestamp || 0) - Number(y.timestamp || 0); });
  assert.deepStrictEqual(batch.map(function (n) { return n.id; }), ['a', 'c', 'b'], 'orden ascendente');
  var dom = [];
  batch.forEach(function (n) { dom.unshift(n.id); }); // prepend
  assert.deepStrictEqual(dom, ['b', 'c', 'a'], 'el DOM queda newest-first');
  // Y un post en vivo más nuevo que todos va directo arriba.
  var live = { id: 'z', timestamp: 400 };
  dom.unshift(live.id);
  assert.strictEqual(dom[0], 'z', 'el post en vivo más reciente queda primero');
});

console.log('\nRESULTADO: ' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
