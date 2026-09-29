/* ================================================================
 * Tests C240-L3 (carril 3 de en vivos): metas de regalos, entradas
 * destacadas, doble-tap = lluvia de corazones, panel del host.
 *
 * Vive en tests/ (rutas __dirname + '/../...'). Sin dependencias
 * externas — solo Node.js. Ejecucion: node tests/test-live-l3-goals-entries-hearts.js
 *
 * Estrategia:
 * - La logica pura C240-L3 se extrae del index.html entre los
 *   marcadores LOGICA PURA y se evalua en Node (patron UMD).
 * - Fixtures de giftEvents/transactions con datos REALISTAS (sin
 *   datos falsos en prod: la funcion se oculta o muestra 0 honesto).
 * - i18n: toda string usada con dl3t('...') en el bloque C240-L3
 *   debe existir como clave en los 3 dicts de drex-i18n.js, con
 *   placeholders identicos en ES/EN/ZH/PT.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

/* ---------- extraccion de la logica pura desde index.html ---------- */
var HTML = fs.readFileSync(__dirname + '/../index.html', 'utf8');
var PURE_A = '/* ============ C240-L3: LOGICA PURA ============ */';
var PURE_B = '/* ============ C240-L3: FIN LOGICA PURA ============ */';
var BLOCK_A = '/* ============ C240-L3: METAS + ENTRADAS DESTACADAS + CORAZONES + PANEL DEL HOST ============ */';
var BLOCK_B = '/* ============ C240-L3: FIN ============ */';

var pa = HTML.indexOf(PURE_A), pb = HTML.indexOf(PURE_B);
assert(pa !== -1 && pb !== -1 && pb > pa, 'bloque C240-L3 LOGICA PURA no encontrado en index.html');
var pureCode = HTML.slice(pa, pb);

var ba = HTML.indexOf(BLOCK_A), bb = HTML.indexOf(BLOCK_B);
assert(ba !== -1 && bb !== -1 && bb > ba, 'bloque C240-L3 completo no encontrado en index.html');
var fullBlock = HTML.slice(ba, bb);

/* El codigo puro no toca DOM: se evalua con un stub de module. */
var __mod = { exports: {} };
new Function('module', 'exports', pureCode)(__mod, __mod.exports);
var L3 = __mod.exports;
assert(L3 && typeof L3.goalProgressFromGiftEvents === 'function', 'L3 no exporto la logica pura');

/* ---------- 1. progreso de meta desde giftEvents (diamantes = floor(coins/10)) ---------- */
test('diamondsFromCoins: 1 diamante por cada 10 coins', function () {
  assert.strictEqual(L3.diamondsFromCoins(95), 9);
  assert.strictEqual(L3.diamondsFromCoins(100), 10);
  assert.strictEqual(L3.diamondsFromCoins(5), 0);
  assert.strictEqual(L3.diamondsFromCoins(0), 0);
  assert.strictEqual(L3.diamondsFromCoins(-50), 0);
  assert.strictEqual(L3.diamondsFromCoins('abc'), 0);
  assert.strictEqual(L3.diamondsFromCoins(null), 0);
});

test('goalProgressFromGiftEvents: suma floor(coins/10), sin eventos = 0 honesto', function () {
  var events = {
    e1: { fromUid: 'u1', fromName: 'Ana', giftId: 'g1', coins: 95, ts: 1 },
    e2: { fromUid: 'u2', fromName: 'Beto', giftId: 'g2', coins: 105, ts: 2 },
    e3: { fromUid: 'u3', fromName: 'Cid', giftId: 'g3', coins: 4, ts: 3 },
    e4: { fromUid: 'u4', giftId: 'g4', ts: 4 },          /* sin coins: 0 */
    e5: null                                            /* evento roto: 0 */
  };
  var p = L3.goalProgressFromGiftEvents(events, 100);
  assert.strictEqual(p.current, 19);   /* 9 + 10 + 0 + 0 + 0 */
  assert.strictEqual(p.target, 100);
  assert.strictEqual(p.pct, 19);
  assert.strictEqual(p.done, false);
  assert.strictEqual(p.remaining, 81);

  var done = L3.goalProgressFromGiftEvents(events, 19);
  assert.strictEqual(done.done, true);
  assert.strictEqual(done.pct, 100);

  var empty = L3.goalProgressFromGiftEvents({}, 100);
  assert.strictEqual(empty.current, 0);
  assert.strictEqual(empty.done, false);

  var nul = L3.goalProgressFromGiftEvents(null, 100);
  assert.strictEqual(nul.current, 0);

  var over = L3.goalProgressFromGiftEvents(events, 10);
  assert.strictEqual(over.pct, 100, 'el porcentaje nunca pasa de 100');
  assert.strictEqual(over.done, true);
});

/* ---------- 2. top fans desde transactions (gift_received, meta.from) ---------- */
test('aggregateTopFans: agrupa gift_received por meta.from, ignora el resto', function () {
  var txs = {
    t1: { type: 'gift_received', amount: 50, currency: 'diamonds', ts: 1, meta: { type: 'gift_received', from: 'u1' } },
    t2: { type: 'gift_received', amount: 30, currency: 'diamonds', ts: 2, meta: { type: 'gift_received', from: { uid: 'u2' } } },
    t3: { type: 'gift_received', amount: 20, currency: 'diamonds', ts: 3, meta: { type: 'gift_received', from: 'u1' } },
    t4: { type: 'gift_sent', amount: 999, currency: 'coins', ts: 4, meta: { to: 'u9' } },
    t5: { type: 'gift_received', amount: 10, currency: 'diamonds', ts: 5, meta: {} },
    t6: { type: 'purchase', amount: 5, currency: 'usd', ts: 6 },
    t7: { type: 'gift_received', amount: 'nope', currency: 'diamonds', ts: 7, meta: { from: 'u3' } }
  };
  var top = L3.aggregateTopFans(txs);
  assert.strictEqual(top.length, 2, 'solo u1 y u2 son atribuibles; gift_sent/purchase/sin-from/no-numerico se ignoran');
  assert.strictEqual(top[0].uid, 'u1');
  assert.strictEqual(top[0].diamonds, 70);
  assert.strictEqual(top[1].uid, 'u2');
  assert.strictEqual(top[1].diamonds, 30);
  assert.deepStrictEqual(L3.aggregateTopFans({}), []);
  assert.deepStrictEqual(L3.aggregateTopFans(null), []);
});

test('liveTopGivers: top-3 del live actual desde giftEvents', function () {
  var events = {
    e1: { fromUid: 'a', fromName: 'Ana', coins: 100 },
    e2: { fromUid: 'b', fromName: 'Beto', coins: 50 },
    e3: { fromUid: 'a', fromName: 'Ana', coins: 25 }
  };
  var top = L3.liveTopGivers(events);
  assert.strictEqual(top[0].uid, 'a');
  assert.strictEqual(top[0].diamonds, 12);
  assert.strictEqual(top[1].uid, 'b');
  assert.strictEqual(top[1].diamonds, 5);
});

/* ---------- 3. decision del banner de entrada ---------- */
test('buildEntryBanner: korone > topfan > nada (sin datos falsos)', function () {
  var k = L3.buildEntryBanner({ uid: 'x', name: 'Ana' }, { korOneMember: true, topFan: true });
  assert.strictEqual(k.kind, 'korone');
  assert.strictEqual(k.key, '💎 {n} (Kor One) se unió');

  var t = L3.buildEntryBanner({ uid: 'x', name: 'Ana' }, { korOneMember: false, topFan: true });
  assert.strictEqual(t.kind, 'topfan');
  assert.strictEqual(t.key, '⭐ {n} se unió');

  assert.strictEqual(L3.buildEntryBanner({ uid: 'x', name: 'Ana' }, { korOneMember: false, topFan: false }), null);
  assert.strictEqual(L3.buildEntryBanner({ uid: 'x', name: 'Ana' }, {}), null);
  assert.strictEqual(L3.buildEntryBanner({ uid: null, name: '?' }, { topFan: true }), null);
  assert.strictEqual(L3.buildEntryBanner(null, { topFan: true }), null);
});

test('guardia Kor One ausente: no crashea, cae a top fans', function () {
  assert.strictEqual(L3.isKorOnePresent({}), false);
  assert.strictEqual(L3.isKorOnePresent(), false, 'sin window (Node) no crashea');
  assert.strictEqual(L3.korOneIsMember('u1', {}), false);
  assert.strictEqual(L3.korOneIsMember('u1'), false);
  /* Y cuando existe, detecta miembros sin crashear: */
  assert.strictEqual(L3.isKorOnePresent({ DrexKorOne: {} }), true);
  var g = { DrexKorOne: { isMember: function (id) { return id === 'u1'; } } };
  assert.strictEqual(L3.korOneIsMember('u1', g), true);
  assert.strictEqual(L3.korOneIsMember('u2', g), false);
  var g2 = { DrexKorOne: { members: { u9: true } } };
  assert.strictEqual(L3.korOneIsMember('u9', g2), true);
});

/* ---------- 4. scoping del doble-tap: solo area del video del live ---------- */
function fakeEl(zone) {
  return {
    closest: function (sel) {
      if (zone === 'viewer' && sel === '#drex-live-viewer-stage') return {};
      if ((zone === 'host' || zone === 'hostbtn') && sel === '#drex-live-host') return {};
      if (zone === 'hostbtn' && sel === 'button,input,textarea,select,a,[role="button"]') return {};
      if (zone === 'post' && sel === '[data-drex-post]') return {};
      return null;
    }
  };
}
test('tapZone: viewer/host si, botones y posts no', function () {
  assert.strictEqual(L3.tapZone(fakeEl('viewer')), 'viewer');
  assert.strictEqual(L3.tapZone(fakeEl('host')), 'host');
  assert.strictEqual(L3.tapZone(fakeEl('hostbtn')), null, 'sobre un boton del host no dispara corazones');
  assert.strictEqual(L3.tapZone(fakeEl('post')), null, 'en posts el doble-tap sigue sin hacer nada');
  assert.strictEqual(L3.tapZone(fakeEl('other')), null);
  assert.strictEqual(L3.tapZone(null), null);
  assert.strictEqual(L3.tapZone({}), null, 'sin closest no crashea');
});

/* ---------- 5. el bloque no toca Baro/podcasts/Series/drexLiveOnGift ---------- */
test('el bloque C240-L3 no invade otros carriles ni funciones prohibidas', function () {
  assert(fullBlock.indexOf('drexLiveOnGift') === -1, 'no debe modificar ni envolver drexLiveOnGift (carril 1)');
  assert(!/baro/i.test(fullBlock.replace(/BARO/g, '')), 'no toca Baro');
  assert(fullBlock.toLowerCase().indexOf('podcast') === -1, 'no revive podcasts');
});

/* ---------- 6. i18n: claves presentes en EN/ZH/PT con placeholders identicos ---------- */
function extractDict(varName, nextVarName) {
  var start = I18N_TEXT.indexOf(varName);
  assert(start !== -1, 'no se encontro ' + varName);
  var end = nextVarName ? I18N_TEXT.indexOf(nextVarName, start) : I18N_TEXT.length;
  var sec = I18N_TEXT.slice(start, end);
  var closeIdx = sec.lastIndexOf('\n};');
  assert(closeIdx !== -1, 'cierre no encontrado para ' + varName);
  var objText = sec.slice(sec.indexOf('{'), closeIdx + 2);
  return new Function('return (' + objText + ');')();
}
var I18N_TEXT = fs.readFileSync(__dirname + '/../drex-i18n.js', 'utf8');
var EN = extractDict('var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {');
var ZH = extractDict('var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {');
var PT = extractDict('var APP_PORTUGUESE_TEXT = {', 'var APP_CHINESE_ATTRS = {');

function placeholders(s) {
  var out = [], re = /\{[^}]*\}/g, m;
  while ((m = re.exec(s)) !== null) out.push(m[0]);
  return out.sort().join('|');
}

test('toda string dl3t(...) del bloque C240-L3 existe en EN/ZH/PT', function () {
  var keys = {}, re = /dl3t\('((?:[^'\\]|\\.)*)'\)/g, m;
  while ((m = re.exec(fullBlock)) !== null) keys[m[1]] = true;
  var list = Object.keys(keys);
  assert(list.length > 15, 'se esperaban 15+ strings nuevas, hay ' + list.length);
  var missing = [];
  list.forEach(function (k) {
    if (!(k in EN)) missing.push('EN:' + k);
    if (!(k in ZH)) missing.push('ZH:' + k);
    if (!(k in PT)) missing.push('PT:' + k);
  });
  assert(missing.length === 0, 'claves faltantes: ' + missing.slice(0, 5).join(' / '));
});

test('placeholders identicos en EN/ZH/PT para las claves C240-L3', function () {
  var keys = {}, re = /dl3t\('((?:[^'\\]|\\.)*)'\)/g, m;
  while ((m = re.exec(fullBlock)) !== null) keys[m[1]] = true;
  var bad = [];
  Object.keys(keys).forEach(function (k) {
    var phEs = placeholders(k);
    if (placeholders(EN[k]) !== phEs) bad.push('EN:' + k);
    if (placeholders(ZH[k]) !== phEs) bad.push('ZH:' + k);
    if (placeholders(PT[k]) !== phEs) bad.push('PT:' + k);
  });
  assert(bad.length === 0, 'placeholders dispares: ' + bad.slice(0, 5).join(' / '));
});

/* ---------- 7. anclas del base que el carril necesita ---------- */
test('anclas del base presentes (hooks + contenedores dl3)', function () {
  assert(HTML.indexOf('window.DrexLiveL3.initRoom(which, LS.liveId)') !== -1, 'hook initRoom en drexLiveWireEvents');
  assert(HTML.indexOf('window.DrexLiveL3.cleanup()') !== -1, 'hook cleanup en drexLiveCleanupRoom');
  ['dl3-goal-host', 'dl3-goal-viewer', 'dl3-entry-host', 'dl3-entry-viewer',
   'dl3-hl-host', 'dl3-hl-viewer', 'dl3-hostpanel'].forEach(function (id) {
    assert(HTML.indexOf('id="' + id + '"') !== -1, 'contenedor ' + id);
  });
  assert(HTML.indexOf('window.drexLiveLike') !== -1, 'ancla drexLiveLike');
  assert(HTML.indexOf('window.drexLiveToggleMute') !== -1, 'ancla drexLiveToggleMute');
});


/* ---------- 8. deteccion premium generalizada (Drex Orbit, 2026-09-29) ---------- */
test('premiumApi: detecta DrexOrbit/DrexPremium/DrexKorOne/KorOne en orden', function () {
  assert.strictEqual(L3.premiumApi({}), null);
  assert.strictEqual(L3.premiumApi(), null);
  assert.strictEqual(L3.premiumApi({ DrexOrbit: {} }).key, 'DrexOrbit');
  assert.strictEqual(L3.premiumApi({ DrexPremium: {} }).key, 'DrexPremium');
  assert.strictEqual(L3.premiumApi({ DrexKorOne: {} }).key, 'DrexKorOne');
  assert.strictEqual(L3.premiumApi({ KorOne: {} }).key, 'KorOne');
  assert.strictEqual(L3.premiumApi({ DrexKorOne: {}, DrexOrbit: {} }).key, 'DrexOrbit', 'prioridad al primero');
});
test('premiumDisplayName: del objeto o generico', function () {
  assert.strictEqual(L3.premiumDisplayName({ api: { displayName: 'Drex Orbit' } }), 'Drex Orbit');
  assert.strictEqual(L3.premiumDisplayName({ api: { brandName: 'X' } }), 'X');
  assert.strictEqual(L3.premiumDisplayName({ api: {} }), 'Premium');
  assert.strictEqual(L3.premiumDisplayName(null), 'Premium');
});
test('isKorOnePresent/korOneIsMember funcionan con DrexOrbit', function () {
  assert.strictEqual(L3.isKorOnePresent({ DrexOrbit: {} }), true);
  assert.strictEqual(L3.isKorOnePresent({}), false);
  var g = { DrexOrbit: { isMember: function (id) { return id === 'u1'; } } };
  assert.strictEqual(L3.korOneIsMember('u1', g), true);
  assert.strictEqual(L3.korOneIsMember('u2', g), false);
});
test('buildEntryBanner con premiumName usa clave parametrizada', function () {
  var b = L3.buildEntryBanner({ uid: 'x', name: 'Ana' }, { korOneMember: true, premiumName: 'Drex Orbit' });
  assert.strictEqual(b.kind, 'korone');
  assert.strictEqual(b.key, '\uD83D\uDC8E {n} ({p}) se uni\u00F3');
  assert.strictEqual(b.pname, 'Drex Orbit');
  var k2 = L3.buildEntryBanner({ uid: 'x', name: 'Ana' }, { korOneMember: true });
  assert.strictEqual(k2.key, '\uD83D\uDC8E {n} (Kor One) se uni\u00F3', 'sin premiumName: clave historica');
});
test('clave parametrizada existe en EN/ZH/PT con {n} y {p}', function () {
  var k = '\uD83D\uDC8E {n} ({p}) se uni\u00F3';
  assert(EN[k] && EN[k].indexOf('{n}') !== -1 && EN[k].indexOf('{p}') !== -1, 'EN');
  assert(ZH[k] && ZH[k].indexOf('{n}') !== -1 && ZH[k].indexOf('{p}') !== -1, 'ZH');
  assert(PT[k] && PT[k].indexOf('{n}') !== -1 && PT[k].indexOf('{p}') !== -1, 'PT');
});

console.log('\nRESULTADO: ' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
