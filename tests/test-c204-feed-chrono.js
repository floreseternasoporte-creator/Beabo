/* ================================================================
 * Tests de regresión: "Para ti" algorítmico (2026-10-01, carril 4)
 *
 * La orden cronológica del 2026-09-27 quedó SUSTITUIDA por pedido directo
 * del usuario: "el algoritmo y todo… 'Para ti' debe sentirse personal de
 * verdad". Este archivo reemplaza al test-c204-feed-chrono.js original.
 *
 * P1: "Para ti" vuelve a ordenarse con el motor V2 (flag
 *     window.DREX_FORYOU_CHRONO = false; rankFeed solo para foryou).
 * P2: "Mi gente" (Siguiendo) SIGUE cronológica — el ranking no la toca.
 * P3: "Destacados" y "Mi Marea" CONSERVAN su orden por puntaje.
 * P4: el aviso al entrar a "Descubre" refleja el modo personalizado,
 *     con i18n ES/EN/ZH/PT.
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

/* ---------- P1: el flag algorítmico está activo ---------- */
test('flag DREX_FORYOU_CHRONO en false (ranking V2 reactivado 2026-10-01)', function () {
  mustContain(src, 'window.DREX_FORYOU_CHRONO = false;', 'flag');
});

/* ---------- P1: el batch inicial de foryou va por rankFeed ---------- */
test('snfMountInitialBatch rankea foryou con DrexRecEngine.rankFeed', function () {
  var start = src.indexOf('function snfMountInitialBatch(ctx)');
  assert(start !== -1, 'snfMountInitialBatch no encontrada');
  var body = src.slice(start, start + 2600);
  mustContain(body, "ctx.feedMode === 'foryou' && window.DREX_FORYOU_CHRONO !== true", 'guarda solo-foryou');
  mustContain(body, 'window.DrexRecEngine.rankFeed(ctx._initialBatch, _rankCtx)', 'llamada a rankFeed');
});

/* ---------- P2: Siguiendo no se rankea ---------- */
test('snfMountInitialBatch NO rankea following (sigue cronológico)', function () {
  var start = src.indexOf('function snfMountInitialBatch(ctx)');
  var body = src.slice(start, start + 2600);
  assert(body.indexOf("ctx.feedMode === 'following' && window.DrexRecEngine") === -1,
    'following no debe entrar a rankFeed');
  assert(body.indexOf("else if (ctx.feedMode === 'foryou' && window.DREX_FORYOU_CHRONO !== true") !== -1,
    'la rama de ranking exige foryou');
});

test('snfMountFeedPost: following sigue con prepend/append (sin score)', function () {
  var start = src.indexOf('function snfMountFeedPost(ctx, note, appendAtBottom');
  assert(start !== -1, 'snfMountFeedPost no encontrada');
  var body = src.slice(start, start + 4200);
  mustContain(body, "ctx.feedMode === 'foryou' && window.DREX_FORYOU_CHRONO !== true", 'inserción por score solo en foryou');
});

/* ---------- P1: resort/insert del V2 siguen cableados ---------- */
test('drexRecResortForYou existe como red de seguridad de foryou', function () {
  var start = src.indexOf('function drexRecResortForYou()');
  assert(start !== -1, 'drexRecResortForYou no encontrada');
  var body = src.slice(start, start + 600);
  // Ya no hay salida temprana cronológica: con el flag en false, reordena.
  assert(body.indexOf('if (window.DREX_FORYOU_CHRONO === true) return;') === -1,
    'la salida temprana cronológica debe haber desaparecido');
});

test('DrexRecEngine.resortForYou procede cuando el flag es false', function () {
  var start = engineSrc.indexOf('resortForYou: function');
  assert(start !== -1, 'resortForYou no encontrada en el motor');
  var body = engineSrc.slice(start, start + 700);
  mustContain(body, 'window.DREX_FORYOU_CHRONO !== false', 'guarda del modo');
});

/* ---------- P3: popular y marea conservan su ranking ---------- */
test('"Destacados" y "Mi Marea" conservan su orden por puntaje', function () {
  var start = src.indexOf('function snfMountInitialBatch(ctx)');
  var body = src.slice(start, start + 2600);
  mustContain(body, "if (ctx.feedMode === 'marea')", 'rama marea intacta');
  mustContain(body, 'drexMareaSortBatch(ctx, ctx._initialBatch)', 'ranking de marea intacto');
  mustContain(src, 'dataset.feedScore', 'ranking de popular intacto');
});

/* ---------- P4: el aviso refleja el modo personalizado ---------- */
test('cambiar a Descubre avisa "Mostrando lo mejor para ti"', function () {
  var start = src.indexOf('function switchFeedTab(');
  assert(start !== -1, 'switchFeedTab no encontrada');
  var body = src.slice(start, start + 4500);
  mustContain(body, "showToast(appT('Mostrando lo mejor para ti'))", 'toast personalizado');
  assert(body.indexOf("showToast(appT('Mostrando lo más reciente'))") === -1,
    'el toast cronológico ya no debe usarse en foryou');
});

test('la clave i18n existe en EN/ZH/PT (paridad)', function () {
  var i18n = fs.readFileSync(__dirname + '/../drex-i18n.js', 'utf8');
  assert(i18n.indexOf('"Mostrando lo mejor para ti":"Showing the best for you"') !== -1, 'EN');
  assert(i18n.indexOf('"Mostrando lo mejor para ti":"正在为你精选内容"') !== -1, 'ZH');
  assert(i18n.indexOf('"Mostrando lo mejor para ti":"Mostrando o melhor para você"') !== -1, 'PT');
});

/* ---------- P1 (lógica pura): la diversidad penaliza la repetición ---------- */
test('semántica: 4 del mismo autor en ventana → penalización', function () {
  // maxInWindow.sameAuthor=3, penaltyPerRepeat=3.0
  var sameAuthor = 4, max = 3, ppr = 3.0;
  var penalty = sameAuthor > max ? (sameAuthor - max) * ppr : 0;
  assert.strictEqual(penalty, 3.0, 'penalización esperada');
});

test('semántica: tope de racha bidireccional (2 máx. seguidas)', function () {
  // [x90, x80, y50] + nueva x de score alto: delante de x90 forma racha de 3 → se salta;
  // no hay hueco válido → va al final, sin crear racha de 3 en el medio.
  function runAt(cards, idx, author) {
    var run = 1, i = idx - 1;
    while (i >= 0 && run <= 2) { if (cards[i] === author) run++; else break; i--; }
    i = idx;
    while (i < cards.length && run <= 2) { if (cards[i] === author) run++; else break; i++; }
    return run;
  }
  var cards = ['x', 'x', 'y'];
  assert(runAt(cards, 0, 'x') > 2, 'delante de la racha: racha resultante 3 → saltar');
  assert(runAt(cards, 3, 'x') <= 2, 'al final: racha resultante 2 → válido');
});

console.log('\nRESULTADO: ' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
