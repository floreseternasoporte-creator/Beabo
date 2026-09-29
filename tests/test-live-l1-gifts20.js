// Test C240-L1 — Regalos 2.0 (combos, momento, leaderboard).
//
// Prueba la lógica pura del módulo Dl1Gifts20 extraído de index.html
// (patrón UMD, como DrexLiveCore): ventana de combo de 8 s, umbral de
// "momento" >= 1000 coins, agregación del leaderboard desde eventos reales
// y deduplicación sesión/persistido. Además verifica que toda string ES
// usada con t('...') en el módulo UI exista en lane1-i18n.json o en los
// dicts base de drex-i18n.js (los 3 idiomas), y que el contrato compartido
// giftEvents esté escrito en window.drexLiveSendGift.
//
// Uso: node tests/test-live-l1-gifts20.js [--html=...] [--i18n=...]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function arg(name, def) {
  const a = process.argv.find(x => x.startsWith(name + '='));
  return a ? a.slice(name.length + 1) : def;
}
const htmlPath = arg('--html', path.join(__dirname, '..', 'index.html'));
const i18nPath = arg('--i18n', path.join(__dirname, '..', 'lane1-i18n.json'));

const html = fs.readFileSync(htmlPath, 'utf8');

function extract(startMark, endMark) {
  const a = html.indexOf(startMark);
  assert(a !== -1, 'marcador no encontrado: ' + startMark);
  const b = html.indexOf(endMark, a);
  assert(b !== -1, 'marcador no encontrado: ' + endMark);
  return html.slice(a, b + endMark.length);
}

const coreSrc = extract(
  '/* ============ C240-L1: Regalos 2.0 — núcleo puro (UMD) ============ */',
  '/* ============ /C240-L1: núcleo puro ============ */');
const uiSrc = extract(
  '/* ============ C240-L1: Regalos 2.0 — UI (combos, momento, leaderboard) ============ */',
  '/* ============ /C240-L1: UI ============ */');

/* Carga el núcleo puro en sandbox vm con `module` para capturar el export. */
const sandbox = { module: { exports: {} }, console };
vm.createContext(sandbox);
vm.runInContext(coreSrc, sandbox, { filename: 'dl1-core.js' });
const Core = sandbox.module.exports;
assert(Core && typeof Core.comboNext === 'function', 'Dl1Gifts20 no exportó');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

/* ---------------- combos ---------------- */

test('combo: primer envío cuenta x1 sin combo', function () {
  const r = Core.comboNext(null, { uid: 'u1', giftId: 'chispa', ts: 1000 });
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.isCombo, false);
});

test('combo: mismo regalo dentro de 8s sube a x2/x3/x4', function () {
  let s = Core.comboNext(null, { uid: 'u1', giftId: 'chispa', ts: 1000 });
  s = Core.comboNext(s, { uid: 'u1', giftId: 'chispa', ts: 5000 });
  assert.strictEqual(s.count, 2); assert.strictEqual(s.isCombo, true);
  s = Core.comboNext(s, { uid: 'u1', giftId: 'chispa', ts: 9000 });
  assert.strictEqual(s.count, 3);
  s = Core.comboNext(s, { uid: 'u1', giftId: 'chispa', ts: 12000 });
  assert.strictEqual(s.count, 4); assert.strictEqual(s.isCombo, true);
});

test('combo: borde exacto de 8000 ms sigue contando', function () {
  let s = Core.comboNext(null, { uid: 'u1', giftId: 'chispa', ts: 0 });
  s = Core.comboNext(s, { uid: 'u1', giftId: 'chispa', ts: 8000 });
  assert.strictEqual(s.count, 2);
});

test('combo: fuera de la ventana (8001 ms) reinicia', function () {
  let s = Core.comboNext(null, { uid: 'u1', giftId: 'chispa', ts: 0 });
  s = Core.comboNext(s, { uid: 'u1', giftId: 'chispa', ts: 8001 });
  assert.strictEqual(s.count, 1); assert.strictEqual(s.isCombo, false);
});

test('combo: cambiar de regalo reinicia', function () {
  let s = Core.comboNext(null, { uid: 'u1', giftId: 'chispa', ts: 1000 });
  s = Core.comboNext(s, { uid: 'u1', giftId: 'flor_nebular', ts: 2000 });
  assert.strictEqual(s.count, 1);
});

test('combo: otro usuario no suma al combo ajeno', function () {
  let s = Core.comboNext(null, { uid: 'u1', giftId: 'chispa', ts: 1000 });
  s = Core.comboNext(s, { uid: 'u2', giftId: 'chispa', ts: 2000 });
  assert.strictEqual(s.count, 1);
  assert.strictEqual(s.uid, 'u2');
});

test('combo: reloj hacia atrás no suma', function () {
  let s = Core.comboNext(null, { uid: 'u1', giftId: 'chispa', ts: 5000 });
  s = Core.comboNext(s, { uid: 'u1', giftId: 'chispa', ts: 4000 });
  assert.strictEqual(s.count, 1);
});

test('combo: evento sin uid no revienta', function () {
  const r = Core.comboNext(null, {});
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.uid, '');
});

/* ---------------- momento ---------------- */

test('momento: umbral >= 1000 coins (999 no, 1000 sí)', function () {
  assert.strictEqual(Core.BIG_GIFT_MIN_COINS, 1000);
  assert.strictEqual(Core.isBigGift(999), false);
  assert.strictEqual(Core.isBigGift(1000), true);
  assert.strictEqual(Core.isBigGift(15000), true);
  assert.strictEqual(Core.isBigGift(0), false);
  assert.strictEqual(Core.isBigGift(undefined), false);
  assert.strictEqual(Core.isBigGift(null), false);
  assert.strictEqual(Core.isBigGift('1200'), true);
});

/* ---------------- leaderboard ---------------- */

function fx(uid, name, coins, ts, giftId) {
  return { fromUid: uid, fromName: name, giftId: giftId || 'chispa', coins, ts: ts || 1 };
}

test('leaderboard: top 3 por coins desde fixtures', function () {
  const evs = [
    fx('u1', 'Ana', 1200), fx('u1', 'Ana', 1600),
    fx('u2', 'Beto', 10000),
    fx('u3', 'Ceci', 50),
    fx('u4', 'Dani', 300),
    fx('u5', 'Eli', 20)
  ];
  const top = Core.aggregateTop(evs);
  assert.strictEqual(top.length, 3);
  assert.strictEqual(top[0].uid, 'u2'); assert.strictEqual(top[0].coins, 10000);
  assert.strictEqual(top[1].uid, 'u1'); assert.strictEqual(top[1].coins, 2800);
  assert.strictEqual(top[2].uid, 'u4'); assert.strictEqual(top[2].coins, 300);
  assert.strictEqual(top[0].name, 'Beto');
});

test('leaderboard: sin eventos -> vacío honesto ([])', function () {
  /* Nota: deepStrictEqual entre reinos vm falla por prototipos distintos;
   * se compara .length y campos. */
  assert.strictEqual(Core.aggregateTop([]).length, 0);
  assert.strictEqual(Core.aggregateTop(null).length, 0);
});

test('leaderboard: ignora eventos sin fromUid', function () {
  const top = Core.aggregateTop([fx('', 'X', 9999), fx('u1', 'Ana', 10)]);
  assert.strictEqual(top.length, 1);
  assert.strictEqual(top[0].uid, 'u1');
});

test('merge: sesión + giftEvents sin doble conteo', function () {
  const db = [fx('u1', 'Ana', 1200, 100000, 'anillo_orbital')];
  const ses = [fx('u1', 'Ana', 1200, 100005, 'anillo_orbital')];
  const merged = Core.mergeGiftEvents(db, ses);
  assert.strictEqual(merged.length, 1);
  const top = Core.aggregateTop(merged);
  assert.strictEqual(top[0].coins, 1200);
});

test('merge: eventos separados > 10 s sí cuentan doble', function () {
  const db = [fx('u1', 'Ana', 1200, 100000, 'anillo_orbital')];
  const ses = [fx('u1', 'Ana', 1200, 120001, 'anillo_orbital')];
  assert.strictEqual(Core.mergeGiftEvents(db, ses).length, 2);
});

test('merge: distinto regalo no se deduplica', function () {
  const db = [fx('u1', 'Ana', 1200, 100000, 'anillo_orbital')];
  const ses = [fx('u1', 'Ana', 1600, 100002, 'corona_cosmos')];
  assert.strictEqual(Core.mergeGiftEvents(db, ses).length, 2);
});

/* ---------------- i18n ---------------- */

test('lane1-i18n.json válido: es/en/zh/pt no vacíos por entrada', function () {
  const arr = JSON.parse(fs.readFileSync(i18nPath, 'utf8'));
  assert(Array.isArray(arr) && arr.length > 0, 'JSON vacío');
  arr.forEach(function (e, i) {
    ['es', 'en', 'zh', 'pt'].forEach(function (k) {
      assert(typeof e[k] === 'string' && e[k].length > 0, 'entrada ' + i + ' sin ' + k);
    });
  });
});

test('i18n: toda string t(\'...\') del módulo UI tiene traducción', function () {
  const json = JSON.parse(fs.readFileSync(i18nPath, 'utf8'));
  const jsonKeys = {};
  json.forEach(function (e) { jsonKeys[e.es] = true; });
  /* dicts base (los 3 idiomas) desde el drex-i18n.js junto al html */
  const baseI18n = fs.readFileSync(path.join(path.dirname(htmlPath), 'drex-i18n.js'), 'utf8');
  function inDicts(key) {
    const q = '"' + key + '"';
    const secs = [
      ['var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {'],
      ['var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {'],
      ['var APP_PORTUGUESE_TEXT = {', 'var APP_CHINESE_ATTRS = {']
    ];
    return secs.every(function (pair) {
      const a = baseI18n.indexOf(pair[0]);
      const b = baseI18n.indexOf(pair[1], a);
      return a !== -1 && b !== -1 && baseI18n.slice(a, b).indexOf(q) !== -1;
    });
  }
  const lits = {};
  const re = /[^a-zA-Z_$]t\('((?:[^'\\\n]|\\.)*)'\)/g;
  let m;
  while ((m = re.exec(uiSrc)) !== null) lits[m[1]] = true;
  const missing = Object.keys(lits).filter(function (k) { return !jsonKeys[k] && !inDicts(k); });
  assert.strictEqual(missing.length, 0, 'sin traducción: ' + missing.join(' / '));
});

test('i18n: las 4 claves nuevas están en lane1-i18n.json', function () {
  const json = JSON.parse(fs.readFileSync(i18nPath, 'utf8'));
  const keys = json.map(function (e) { return e.es; });
  ['Top', 'Top regaladores', '¡COMBO!', 'Aún no hay regalos en este live'].forEach(function (k) {
    assert(keys.indexOf(k) !== -1, 'falta clave ES: ' + k);
  });
});

/* ---------------- contrato y cableado estático ---------------- */

test('contrato: giftEvents se escribe en window.drexLiveSendGift', function () {
  assert(html.indexOf("lives/' + LS.liveId + '/giftEvents") !== -1, 'falta ruta giftEvents');
  assert(html.indexOf('pushAsync({') !== -1, 'falta pushAsync');
  ['fromUid', 'fromName', 'giftId', 'coins', 'ts'].forEach(function (f) {
    assert(html.indexOf(f + ':') !== -1 || html.indexOf(f + ' :') !== -1, 'falta campo ' + f);
  });
});

test('cableado: drexLiveOnGift invoca dl1TrackGift', function () {
  const i = html.indexOf('function drexLiveOnGift(which, g)');
  assert(i !== -1, 'drexLiveOnGift no encontrada');
  const body = html.slice(i, i + 1200);
  assert(body.indexOf('window.dl1TrackGift(which, g, gift)') !== -1, 'falta hook dl1TrackGift');
});

test('cableado: botones Top + CSS dl1- presentes', function () {
  assert(html.indexOf("dl1OpenBoard('host')") !== -1, 'falta botón host');
  assert(html.indexOf("dl1OpenBoard('viewer')") !== -1, 'falta botón viewer');
  assert(html.indexOf('dl1-boardbtn-host-t') !== -1, 'falta static host');
  assert(html.indexOf('dl1-boardbtn-viewer-t') !== -1, 'falta static viewer');
  ['.dl1-combo-ov', '.dl1-moment', '.dl1-board', '.dl1-combo-x'].forEach(function (c) {
    assert(html.indexOf(c + '{') !== -1, 'falta CSS ' + c);
  });
});

console.log('\n' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
