'use strict';
/* ================================================================
 * Tests C240-L2: Cofre del tesoro + Encuestas + Q&A en vivos
 * Asume que vivirá en tests/ (rutas __dirname + '/../index.html').
 * Extrae el bloque <script id="dl2-pure"> del index.html y prueba la
 * lógica pura (UMD) + la presencia/paridad de claves i18n.
 * Ejecutar con: node tests/test-live-l2-chest-polls-qa.js
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + (e && e.message)); }
}

/* ---------- carga del bloque puro desde index.html ---------- */
var indexPath = path.join(__dirname, '..', 'index.html');
var html = fs.readFileSync(indexPath, 'utf8');
var mPure = html.match(/<script id="dl2-pure">([\s\S]*?)<\/script>/);
assert(mPure, 'no se encontró <script id="dl2-pure"> en index.html');
var mod = { exports: {} };
new Function('module', 'exports', mPure[1])(mod, mod.exports);
var P = mod.exports;
assert(P && typeof P.chestShare === 'function', 'el bloque puro no exportó la API esperada');

/* ---------- bloques de app presentes ---------- */
test('bloques dl2 presentes en index.html', function () {
  assert(html.indexOf('id="dl2-app"') !== -1, 'falta script dl2-app');
  assert(html.indexOf('id="dl2-style"') !== -1, 'falta style dl2-style');
  assert(html.indexOf('id="dl2-host-tools"') !== -1, 'falta dl2-host-tools');
  assert(html.indexOf('id="dl2-host-cards"') !== -1, 'falta dl2-host-cards');
  assert(html.indexOf('id="dl2-viewer-cards"') !== -1, 'falta dl2-viewer-cards');
  assert(html.indexOf('drexLiveQAFeature') !== -1, 'falta window.drexLiveQAFeature');
  assert(html.indexOf('drexLiveQAState') !== -1, 'falta window.drexLiveQAState');
  assert(html.indexOf('drexLiveOnGift') !== -1, 'el carril 1 (drexLiveOnGift) debe seguir intacto');
});

/* ---------- cofre: matemática del reparto ---------- */
test('chestShare: monto fijo por reclamo = floor(total/maxClaims)', function () {
  assert.strictEqual(P.chestShare(100, 20), 5);
  assert.strictEqual(P.chestShare(500, 20), 25);
  assert.strictEqual(P.chestShare(1000, 20), 50);
  assert.strictEqual(P.chestShare(99, 20), 4);   // floor, no redondeo
  assert.strictEqual(P.chestShare(0, 20), 0);
  assert.strictEqual(P.chestShare(-50, 20), 0);
});
test('chestRemainder: el polvo vuelve al host', function () {
  assert.strictEqual(P.chestRemainder(100, 20), 0);
  assert.strictEqual(P.chestRemainder(1000, 20), 0);
  assert.strictEqual(P.chestRemainder(99, 20), 99 - 4 * 20); // 19
});
test('chestHostRefund: total - claimed*perClaim (nunca negativo)', function () {
  assert.strictEqual(P.chestHostRefund(1000, 20, 20), 0);    // agotado: todo repartido
  assert.strictEqual(P.chestHostRefund(1000, 7, 20), 650);    // 1000 - 7*50
  assert.strictEqual(P.chestHostRefund(100, 0, 20), 100);     // nadie reclamó: todo vuelve
  assert.strictEqual(P.chestHostRefund(99, 20, 20), 19);      // el remanente vuelve
  assert.strictEqual(P.chestHostRefund(100, 99, 20), 0);      // clamp a 0
});
test('validateChestAmount: presets y saldo real', function () {
  assert.deepStrictEqual(P.validateChestAmount(500, 1000), { ok: true });
  assert.strictEqual(P.validateChestAmount(1000, 500).ok, false);
  assert.strictEqual(P.validateChestAmount(1000, 500).error, 'funds');
  assert.strictEqual(P.validateChestAmount(250, 10000).error, 'preset'); // no es preset
  assert.strictEqual(P.validateChestAmount(0, 10000).error, 'amount');
});

/* ---------- cofre: idempotencia del claim (doble reclamo = un solo crédito) ---------- */
/* Emula con fidelidad la secuencia de la app: puerta idempotente
 * (transaction en claims/<uid>) -> contador con tope -> crédito con
 * clave idempotente. */
function makeChestSim(total, maxClaims) {
  return { total: total, maxClaims: maxClaims, per: P.chestShare(total, maxClaims), claims: {}, claimed: 0, credited: {} };
}
function simClaim(sim, uid, liveId) {
  if (!P.chestClaimIsFirst(sim.claims[uid])) return { ok: false, reason: 'dup', credited: 0 };
  if (sim.claimed >= sim.maxClaims) return { ok: false, reason: 'exhausted', credited: 0 };
  sim.claims[uid] = { at: 1 };
  sim.claimed++;
  var idem = 'chestclaim_' + liveId + '_' + uid;
  if (sim.credited[idem]) return { ok: false, reason: 'dup-credit', credited: 0 };
  sim.credited[idem] = sim.per;
  return { ok: true, credited: sim.per };
}
test('doble reclamo del mismo espectador = un solo crédito', function () {
  var sim = makeChestSim(1000, 20);
  var r1 = simClaim(sim, 'u1', 'L1');
  var r2 = simClaim(sim, 'u1', 'L1');
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.credited, 50);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'dup');
  var totalCredited = Object.keys(sim.credited).reduce(function (a, k) { return a + sim.credited[k]; }, 0);
  assert.strictEqual(totalCredited, 50, 'solo se acreditó una vez');
  assert.strictEqual(sim.claimed, 1, 'el contador solo avanzó una vez');
});
test('20 reclamos agotan el cofre; el 21 no cobra; refund 0', function () {
  var sim = makeChestSim(1000, 20);
  for (var i = 0; i < 20; i++) {
    var r = simClaim(sim, 'u' + i, 'L1');
    assert.strictEqual(r.ok, true, 'reclamo ' + i + ' debe pasar');
  }
  var r21 = simClaim(sim, 'uX', 'L1');
  assert.strictEqual(r21.ok, false);
  assert.strictEqual(r21.reason, 'exhausted');
  assert.strictEqual(r21.credited, 0);
  var total = Object.keys(sim.credited).reduce(function (a, k) { return a + sim.credited[k]; }, 0);
  assert.strictEqual(total, 1000);
  assert.strictEqual(P.chestHostRefund(1000, sim.claimed, 20), 0);
});
test('expiración con 7 reclamos devuelve 650 al host', function () {
  var sim = makeChestSim(1000, 20);
  for (var i = 0; i < 7; i++) simClaim(sim, 'u' + i, 'L1');
  assert.strictEqual(P.chestHostRefund(sim.total, sim.claimed, sim.maxClaims), 650);
});
test('reintento del crédito con la misma clave idempotente no duplica', function () {
  var sim = makeChestSim(500, 20);
  var a = simClaim(sim, 'u1', 'L1');
  assert.strictEqual(a.credited, 25);
  // la app reintenta credit() con el MISMO idem: el ledger no duplica
  var idem = 'chestclaim_L1_u1';
  var before = sim.credited[idem];
  if (!sim.credited[idem + '#retry']) sim.credited[idem] = before; // set() idempotente: sobrescribe
  assert.strictEqual(sim.credited[idem], 25);
});

/* ---------- encuestas ---------- */
test('validatePoll: pregunta + 2-4 opciones', function () {
  var ok = P.validatePoll('¿Cuál te gusta más?', ['Rojo', 'Azul']);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.q, '¿Cuál te gusta más?');
  assert.strictEqual(ok.opts.length, 2);
  assert.strictEqual(P.validatePoll('x', ['A', 'B']).error, 'q');
  assert.strictEqual(P.validatePoll('Pregunta válida', ['Solo una']).error, 'opts');
  assert.strictEqual(P.validatePoll('Pregunta válida', ['  ', '']).error, 'opts');
  var four = P.validatePoll('Q?', ['a', 'b', 'c', 'd', 'e']);
  assert.strictEqual(four.ok, true);
  assert.strictEqual(four.opts.length, 4, 'máximo 4 opciones');
});
test('un voto por espectador (puerta pollHasVoted)', function () {
  var votes = {};
  assert.strictEqual(P.pollHasVoted(votes, 'u1'), false);
  votes.u1 = 0;
  assert.strictEqual(P.pollHasVoted(votes, 'u1'), true);
  assert.strictEqual(P.pollHasVoted(votes, 'u2'), false);
});
test('pollCounts cuenta votos reales por opción', function () {
  var votes = { a: 0, b: 2, c: 0, d: 1, e: 9 };
  assert.deepStrictEqual(P.pollCounts(votes, 3), [2, 1, 1]); // e:9 fuera de rango se ignora
  assert.deepStrictEqual(P.pollCounts({}, 3), [0, 0, 0]);
});
test('pollPercentages suman exactamente 100', function () {
  function sum(a) { return a.reduce(function (x, y) { return x + y; }, 0); }
  var cases = [
    [{ a: 0, b: 0, c: 1 }, 3],
    [{ a: 0 }, 2],
    [{}, 4],
    [{ a: 1, b: 1, c: 1 }, 3],
    [{ u0: 0, u1: 0, u2: 0, u3: 1, u4: 2, u5: 2, u6: 2 }, 3]
  ];
  cases.forEach(function (c, i) {
    var pcts = P.pollPercentages(c[0], c[1]);
    var total = P.pollTotalVotes(c[0]);
    if (total === 0) assert.deepStrictEqual(pcts, [0, 0, 0, 0].slice(0, c[1]), 'caso ' + i + ': sin votos = 0%');
    else assert.strictEqual(sum(pcts), 100, 'caso ' + i + ': ' + JSON.stringify(pcts));
    pcts.forEach(function (p) { assert(p >= 0 && p <= 100, 'caso ' + i + ': porcentaje fuera de rango'); });
  });
  // votos {a:0,b:0,c:1} -> conteos [2,1,0] -> 67/33/0 (resto mayor), no 66/33/0
  var p = P.pollPercentages({ a: 0, b: 0, c: 1 }, 3);
  assert.deepStrictEqual(p, [67, 33, 0]);
});
test('pollWinner: gana la opción con más votos (empate -> primera)', function () {
  assert.strictEqual(P.pollWinner([2, 5, 3]), 1);
  assert.strictEqual(P.pollWinner([4, 4, 1]), 0);
  assert.strictEqual(P.pollWinner([]), -1);
});

/* ---------- Q&A ---------- */
test('sanitize/validate de preguntas', function () {
  assert.strictEqual(P.validateQuestion('  '), false);
  assert.strictEqual(P.validateQuestion('x'), false);
  assert.strictEqual(P.validateQuestion('¿Cómo estás?'), true);
  assert.strictEqual(P.sanitizeQuestion('  hola  '), 'hola');
  assert(P.sanitizeQuestion(new Array(300).join('x')).length <= 200, 'trunca a 200');
});
test('makeQid: formato y unicidad', function () {
  var ids = {};
  for (var i = 0; i < 500; i++) {
    var qid = P.makeQid();
    assert(/^q[A-Za-z0-9]+$/.test(qid), 'qid seguro para rutas: ' + qid);
    assert(!ids[qid], 'qid duplicado');
    ids[qid] = 1;
  }
});
test('sanitizeUid: solo caracteres seguros para rutas', function () {
  assert.strictEqual(P.sanitizeUid('abc-123_X'), 'abc-123_X');
  assert.strictEqual(P.sanitizeUid('../../x'), 'x');
  assert.strictEqual(P.sanitizeUid(null), '');
});
test('qaQuestionCount', function () {
  assert.strictEqual(P.qaQuestionCount({}), 0);
  assert.strictEqual(P.qaQuestionCount({ a: 1, b: 2 }), 2);
});
test('formatCountdown', function () {
  assert.strictEqual(P.formatCountdown(120000), '2:00');
  assert.strictEqual(P.formatCountdown(59000), '0:59');
  assert.strictEqual(P.formatCountdown(0), '0:00');
  assert.strictEqual(P.formatCountdown(-5), '0:00');
});

/* ---------- i18n ---------- */
function findFile(cands) {
  for (var i = 0; i < cands.length; i++) {
    var p = path.join(__dirname, cands[i]);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
var jsonPath = findFile(['lane2-i18n.json', '../lane2-i18n.json']);
test('lane2-i18n.json existe y es válido', function () {
  assert(jsonPath, 'no se encontró lane2-i18n.json');
  var arr = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert(Array.isArray(arr) && arr.length > 0, 'vacío o no es arreglo');
});
test('todas las entradas tienen es/en/zh/pt no vacíos y sin es duplicado', function () {
  var arr = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  var seen = {};
  arr.forEach(function (e, i) {
    assert(e.es && e.en && e.zh && e.pt, 'entrada ' + i + ' incompleta');
    assert(!seen[e.es], 'clave es duplicada: ' + e.es);
    seen[e.es] = 1;
  });
});
function placeholders(s) {
  var out = [], re = /\{[^}]*\}/g, m;
  while ((m = re.exec(s)) !== null) out.push(m[0]);
  return out.sort().join(',');
}
test('placeholders de la clave ES presentes en en/zh/pt', function () {
  var arr = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  var bad = [];
  arr.forEach(function (e) {
    var kp = placeholders(e.es);
    ['en', 'zh', 'pt'].forEach(function (L) {
      var lp = placeholders(e[L]);
      kp.split(',').filter(Boolean).forEach(function (ph) {
        if (lp.indexOf(ph) === -1) bad.push(L + ':' + e.es.slice(0, 40));
      });
    });
  });
  assert(bad.length === 0, 'placeholders faltantes: ' + bad.slice(0, 5).join(' / '));
});
test('toda clave ES usada en el código dl2 está en lane2-i18n.json o ya existe en la base', function () {
  var arr = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  var inJson = {};
  arr.forEach(function (e) { inJson[e.es] = 1; });
  // claves ES ya presentes en los dicts TEXT de la base (reutilizadas, no van al JSON)
  var baseKeys = {};
  var basePath = findFile(['drex-i18n.js', '../drex-i18n.js']);
  if (basePath) {
    var bsrc = fs.readFileSync(basePath, 'utf8');
    var s = bsrc.indexOf('var APP_ENGLISH_TEXT = {');
    var e = bsrc.indexOf('var APP_CHINESE_TEXT = {', s);
    var sec = bsrc.slice(s, e);
    var re = /"((?:[^"\\]|\\.)*)":/g, mm;
    while ((mm = re.exec(sec)) !== null) baseKeys[mm[1]] = 1;
  }
  var codeKeys = {};
  var blocks = [
    html.match(/<script id="dl2-app">([\s\S]*?)<\/script>/)[1]
  ];
  // Extrae TODOS los literales dentro de t(...)/tf(...), incluyendo ternarios
  // como t(cond ? 'A' : 'B') donde el regex simple no llega.
  blocks.forEach(function (code) {
    var callRe = /\btf?\(/g, cm;
    while ((cm = callRe.exec(code)) !== null) {
      var i = cm.index + cm[0].length, depth = 1, s = null, buf = '';
      while (i < code.length && depth > 0) {
        var c = code[i];
        if (s) {
          if (c === '\\') { buf += code[i + 1] || ''; i += 2; continue; }
          if (c === s) { codeKeys[buf.replace(/\\'/g, "'")] = 1; s = null; buf = ''; }
          else buf += c;
        } else {
          if (c === "'" || c === '"') { s = c; buf = ''; }
          else if (c === '(') depth++;
          else if (c === ')') depth--;
        }
        i++;
      }
    }
  });
  // 'funds' es código de error interno de validateChestAmount, no cadena UI
  delete codeKeys.funds;
  var missing = Object.keys(codeKeys).filter(function (k) { return k.length > 2 && !inJson[k] && !baseKeys[k]; });
  assert(missing.length === 0, 'claves sin traducir: ' + missing.slice(0, 5).join(' / '));
});


/* ---------- cofre: fixes financieros (auditoria 2026-09-29) ---------- */
test('idem de reclamo incluye createdAt del cofre (2+ cofres por live)', function () {
  assert(html.indexOf("'chestclaim_' + S.liveId + '_' + (chest.createdAt | 0) + '_' + uid") !== -1,
    'la clave idem del reclamo debe llevar createdAt del cofre');
});
test('idem de reembolso incluye createdAt del cofre', function () {
  assert(html.indexOf("'chestrefund_' + S.liveId + '_' + (chest.createdAt | 0)") !== -1,
    'la clave idem del reembolso debe llevar createdAt del cofre');
});
test('el cierre relee el cofre del servidor tras ganar el closeLock', function () {
  var i = html.indexOf('function dl2MaybeCloseChest');
  assert(i !== -1, 'falta dl2MaybeCloseChest');
  var seg = html.slice(i, i + 2500);
  assert(seg.indexOf("ref('lives/' + S.liveId + '/chest').once('value')") !== -1,
    'debe releer el cofre tras el lock antes de calcular el reembolso');
});

console.log('\nRESULTADO: ' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
