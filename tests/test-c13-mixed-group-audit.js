'use strict';
// AUDITORÍA C13 — inventario de .on('child_added'): prueba de que en un grupo
// de polling MIXTO
// (child_added con delta + child_changed en el mismo ref+query, el patrón del
// chat DM y del feed) el delta-sync NO se activa: useDelta exige que TODOS
// los oyentes del grupo sean child_added con delta. Resultado: migrar el
// child_added a onDelta en esos nodos es un no-op de RCU.
//
// Escenarios sobre el código REAL de drex-cloud.js + DynamoDB falso
// instrumentado (modelo RCU del ciclo 10: por query max(0.5, ceil(bytes/4096)*0.5)):
//   MIXTO   = onDelta(child_added) + on('child_changed') en
//             conversationMessages/conv1 limitToLast(80)  [patrón chat DM]
//   CONTROL = solo onDelta(child_added) en el mismo nodo     [patrón fiesta chat]
//
// Métrica: queries BETWEEN (delta) vs completas por ciclo en estado estable,
// RCU por ciclo idle, RCU por ciclo con 1 mensaje nuevo, callbacks disparados.
const path = require('path');
const SRC = path.join(__dirname, '..');

// ---- stub de temporizadores ----
const timers = new Map();
let nextTimerId = 1;
const realSetTimeout = setTimeout;
global.setInterval = (fn, ms) => { const id = nextTimerId++; timers.set(id, { fn, ms, cleared: false }); return id; };
global.clearInterval = (id) => { const t = timers.get(id); if (t) t.cleared = true; };
function tickMs(ms) {
  const fns = new Set();
  for (const t of timers.values()) if (!t.cleared && t.ms === ms) fns.add(t.fn);
  fns.forEach(fn => { try { fn(); } catch (e) { console.error('tick throw', e); } });
}
const sleep = (ms) => new Promise(r => realSetTimeout(r, ms));
async function settle(n) { for (let i = 0; i < (n || 10); i++) await sleep(15); }

// ---- DynamoDB falso instrumentado (patrón test-c10-fiesta-chat-cost) ----
function cmpSk(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
function makeFakeDb() {
  const items = [];
  const stats = { ops: 0, bytes: 0, rcu: 0, betweenQ: 0, fullQ: 0 };
  function put(pk, sk, v) { items.push({ pk, sk, v: JSON.stringify(v) }); }
  function charge(returned, isDeltaSync) {
    let bytes = 0;
    returned.forEach(it => { bytes += Buffer.byteLength(it.sk || '', 'utf8') + Buffer.byteLength(it.v || '', 'utf8'); });
    stats.ops++; stats.bytes += bytes; stats.rcu += Math.max(0.5, Math.ceil(bytes / 4096) * 0.5);
    if (isDeltaSync) stats.betweenQ++; else stats.fullQ++;
  }
  // Delta-sync REAL = la query la emite readLeavesDelta (poll delta). La fase 2
  // del bounded-prefix tambien usa BETWEEN pero NO es delta-sync.
  function isDeltaSyncCall() {
    const st = new Error().stack || '';
    return st.indexOf('readLeavesDelta') >= 0;
  }
  function runQuery(params) {
    const vals = params.ExpressionAttributeValues || {};
    let arr = items.filter(it => it.pk === vals[':pk']);
    const kc = params.KeyConditionExpression || '';
    let isDelta = false;
    if (kc.includes('begins_with(sk, :pfx)')) {
      arr = arr.filter(it => it.sk.indexOf(vals[':pfx']) === 0);
    } else if (kc.includes('sk BETWEEN :lo AND :hi')) {
      arr = arr.filter(it => it.sk >= vals[':lo'] && it.sk <= vals[':hi']);
      isDelta = true;
    } else if (kc.includes('sk < :endSk')) {
      arr = arr.filter(it => it.sk < vals[':endSk']);
    }
    arr.sort((a, b) => params.ScanIndexForward === false ? cmpSk(b.sk, a.sk) : cmpSk(a.sk, b.sk));
    if (params.ExclusiveStartKey) {
      const esk = params.ExclusiveStartKey.sk;
      const idx = arr.findIndex(it => it.sk === esk);
      arr = idx >= 0 ? arr.slice(idx + 1) : [];
    }
    if (params.Limit && arr.length > params.Limit) arr = arr.slice(0, params.Limit);
    const proj = params.ProjectionExpression === 'sk';
    const out = arr.map(it => (proj ? { sk: it.sk } : { pk: it.pk, sk: it.sk, v: it.v }));
    charge(out, isDeltaSyncCall());
    return { Items: out, LastEvaluatedKey: null };
  }
  const dc = {
    query(params) { return { promise() { return Promise.resolve(runQuery(params)); } }; },
    _put: put, _stats: stats,
    _reset() { stats.ops = 0; stats.bytes = 0; stats.rcu = 0; stats.betweenQ = 0; stats.fullQ = 0; }
  };
  return dc;
}

function freshModule() {
  const p = path.join(SRC, 'drex-cloud.js');
  delete require.cache[require.resolve(p)];
  return require(p);
}

async function runScenario(mixed) {
  const M = freshModule();
  const { DrexCloud, __internals: I } = M;
  const fake = makeFakeDb();
  I.setDocClient(fake);
  const now = Date.now();
  // 80 mensajes push (ventana llena de limitToLast(80)), ~120 bytes c/u
  for (let i = 0; i < 80; i++) {
    const k = I.pushIdLowerBound(now - (80 - i) * 5000);
    fake._put('conversationMessages', 'conv1/' + k + '/text', 'mensaje numero ' + i + ' con algo de relleno para simular tamano real');
    fake._put('conversationMessages', 'conv1/' + k + '/senderId', 'u' + (i % 2));
  }
  const addedCb = [], changedCb = [];
  const ref = DrexCloud.database().ref('conversationMessages/conv1').limitToLast(80);
  const offs = [];
  offs.push(ref.onDelta(snap => addedCb.push(snap.key)));
  if (mixed) offs.push(ref.on('child_changed', snap => changedCb.push(snap.key)));
  await settle(14); // lectura inicial (fireListener por oyente)
  fake._reset();

  // 5 ciclos idle en estado estable (ciclo normal 3000ms)
  for (let i = 0; i < 5; i++) { tickMs(3000); await settle(10); }
  const idle = { rcu: fake._stats.rcu, betweenQ: fake._stats.betweenQ, fullQ: fake._stats.fullQ, added: addedCb.length - 80, changed: changedCb.length };
  fake._reset();

  // 1 mensaje nuevo -> 1 ciclo
  const nk = I.newPushId();
  fake._put('conversationMessages', 'conv1/' + nk + '/text', 'hola nuevo');
  fake._put('conversationMessages', 'conv1/' + nk + '/senderId', 'u9');
  const before = addedCb.length;
  tickMs(3000); await settle(10);
  const active = { rcu: fake._stats.rcu, betweenQ: fake._stats.betweenQ, fullQ: fake._stats.fullQ, newDelivered: addedCb.length - before === 1 && addedCb[addedCb.length - 1] === nk };

  offs.forEach(off => { try { off(); } catch (_) {} });
  I.resetListeners();
  return { idle, active };
}

(async () => {
  const M = await runScenario(false); // CONTROL: solo onDelta
  const X = await runScenario(true);  // MIXTO: onDelta + child_changed
  const r = (v) => Math.round(v * 100) / 100;
  console.log('CONTROL (solo onDelta):');
  console.log('  idle:    ' + r(M.idle.rcu / 5) + ' RCU/ciclo, deltaQ=' + M.idle.betweenQ + ' fullQ=' + M.idle.fullQ + ' (5 ciclos), re-disparos=' + M.idle.added);
  console.log('  1 nuevo: ' + r(M.active.rcu) + ' RCU, deltaQ=' + M.active.betweenQ + ' fullQ=' + M.active.fullQ + ', entregado=' + M.active.newDelivered);
  console.log('MIXTO (onDelta + child_changed, patron chat DM/feed):');
  console.log('  idle:    ' + r(X.idle.rcu / 5) + ' RCU/ciclo, deltaQ=' + X.idle.betweenQ + ' fullQ=' + X.idle.fullQ + ' (5 ciclos), re-disparos=' + X.idle.added);
  console.log('  1 nuevo: ' + r(X.active.rcu) + ' RCU, deltaQ=' + X.active.betweenQ + ' fullQ=' + X.active.fullQ + ', entregado=' + X.active.newDelivered);
  let fails = 0;
  const ok = (c, n) => { if (!c) { fails++; console.error('FALLA: ' + n); } else console.log('ok: ' + n); };
  ok(M.idle.betweenQ >= 4 && M.idle.fullQ <= 1, 'control usa delta-sync en idle (delta>=4, full<=1 por 1ra lectura)');
  ok(X.idle.betweenQ === 0 && X.idle.fullQ >= 5, 'mixto NUNCA usa delta-sync (delta=0, full>=5)');
  ok(X.idle.added === 0, 'mixto: 0 re-disparos en idle (dedup intacto)');
  ok(M.active.newDelivered && X.active.newDelivered, 'ambos entregan el mensaje nuevo exactamente 1 vez');
  ok(X.active.rcu > M.active.rcu * 2, 'mixto cuesta >2x RCU que el control con 1 mensaje nuevo');
  console.log(fails === 0 ? 'C13-AUDIT: 5/5 — grupo mixto bloquea delta-sync (migrar es no-op de RCU)' : 'FALLOS: ' + fails);
  process.exit(fails === 0 ? 0 : 1);
})();
