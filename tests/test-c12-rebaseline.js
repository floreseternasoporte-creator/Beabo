'use strict';
// QA ciclo 12 P3 — re-baseline periódico anti clock-skew (DELTA_FULL_EVERY).
// Verifica sobre la bandeja fiestaSignals/<id>/<uid> con DynamoDB falso:
//  1. Baseline inicial dispara 1 callback por señal existente (sin dupes).
//  2. Ciclos delta entregan solo lo nuevo; sin novedades no hay callbacks.
//  3. REPRODUCE EL HUECO: una señal con timestamp 60s en el pasado que
//     aterriza DESPUÉS de que el watermark avanzó es invisible para el
//     rango delta (0 callbacks) — el blind spot residual del ciclo 4.
//  4. FIX: al cumplirse DELTA_FULL_EVERY ciclos delta exitosos, el grupo
//     hace UNA lectura completa y la señal tardía SE ENTREGA (exactamente
//     1 vez); nada de lo ya visto se re-dispara (dedup de l.kids).
//  5. EQUIVALENCIA: el stream de callbacks con re-baseline es idéntico al
//     de un run control donde la señal "tardía" estuvo desde el inicio
//     (mismo multiset, 1 vez cada clave).
//  6. INVARIANZA ANTE FALLOS: un ciclo fallido (no-retriable) no avanza ni
//     reinicia el contador; un re-baseline forzado que falla se reintenta
//     como lectura completa (no se salta en silencio).
//
// No toca la red: temporizadores y DynamoDB están simulados. Cada tick
// manual equivale a exactamente UNA ejecución de pollGroup (settle amplio,
// sin solapes).
const path = require('path');

// ---- stub de temporizadores (captura los intervalos de polling) ----
const timers = new Map();
let nextTimerId = 1;
const realSetTimeout = setTimeout;
global.setInterval = (fn, ms) => { const id = nextTimerId++; timers.set(id, { fn, ms, cleared: false }); return id; };
global.clearInterval = (id) => { const t = timers.get(id); if (t) t.cleared = true; };
function tickFast() {
  const fns = new Set();
  for (const t of timers.values()) if (!t.cleared && t.ms === 800) fns.add(t.fn);
  fns.forEach(fn => { try { fn(); } catch (e) { console.error('tick throw', e); } });
}
const sleep = (ms) => new Promise(r => realSetTimeout(r, ms));
async function settle(n) { for (let i = 0; i < (n || 8); i++) await sleep(15); } // ~120ms

// ---- DynamoDB falso: soporta BETWEEN y begins_with sobre sk ----
function makeFakeDb() {
  const store = new Map(); // "pk\0sk" -> {pk, sk, v}
  let failNext = 0, failErr = null;
  function put(pk, sk, v) { store.set(pk + '\0' + sk, { pk, sk, v: JSON.stringify(v) }); }
  function itemsFor(pk) {
    const out = [];
    for (const it of store.values()) if (it.pk === pk) out.push(it);
    out.sort((a, b) => (a.sk < b.sk ? -1 : (a.sk > b.sk ? 1 : 0)));
    return out;
  }
  const dc = {
    query(params) {
      return {
        promise() {
          return new Promise((resolve, reject) => {
            realSetTimeout(() => {
              if (failNext > 0) { failNext--; reject(failErr || new Error('boom')); return; }
              const vals = params.ExpressionAttributeValues || {};
              const kce = params.KeyConditionExpression || '';
              let items = itemsFor(vals[':pk']);
              if (kce.indexOf('BETWEEN') >= 0) {
                const lo = vals[':lo'], hi = vals[':hi'];
                items = items.filter(it => it.sk >= lo && it.sk <= hi);
              } else if (kce.indexOf('begins_with') >= 0) {
                const pfx = vals[':pfx'];
                items = items.filter(it => it.sk.indexOf(pfx) === 0);
              }
              resolve({ Items: items.map(it => ({ pk: it.pk, sk: it.sk, v: it.v })), LastEvaluatedKey: null });
            }, 0);
          });
        }
      };
    }
  };
  return { dc, put, failTimes(n, err) { failNext = n; failErr = err; } };
}

function freshModule() {
  const p = path.join(__dirname, '..', 'drex-cloud.js');
  delete require.cache[require.resolve(p)];
  return require(p);
}
const nonRetriable = () => Object.assign(new Error('ValidationException'), { code: 'ValidationException' });

async function runScenario(opts) {
  // opts: { seedLate, failMidAt|null, failForcedFull }
  const M = freshModule();
  const { DrexCloud, __internals: I } = M;
  const fake = makeFakeDb();
  I.setDocClient(fake.dc);
  const fired = [];
  const seenN = [];
  const now = Date.now();
  const lateId = I.pushIdLowerBound(now - 60000); // señal 60s en el pasado
  const s1 = I.newPushId(), s2 = I.newPushId(), s3 = I.newPushId();
  fake.put('fiestaSignals', 'f1/u1/' + s1, { t: 'offer', n: 1 });
  fake.put('fiestaSignals', 'f1/u1/' + s2, { t: 'ice', n: 2 });
  fake.put('fiestaSignals', 'f1/u1/' + s3, { t: 'ice', n: 3 });
  if (opts.seedLate) fake.put('fiestaSignals', 'f1/u1/' + lateId, { t: 'offer', n: 0 });
  const gk = 'fiestaSignals/f1/u1|null'; // pollGroupKey del grupo

  DrexCloud.setFastPolling(true);
  const ref = DrexCloud.database().ref('fiestaSignals/f1/u1');
  const off = ref.onDelta(snap => { fired.push(snap.key); seenN.push((snap.val() || {}).n); });
  await settle(12); // lectura inicial (fireListener)

  const EVERY = I.DELTA_FULL_EVERY;
  async function tick() { tickFast(); await settle(8); }

  for (let i = 0; i < 5; i++) await tick();      // 5 ciclos delta sin novedades
  const afterIdle = fired.length;

  const s4 = I.newPushId();                      // señal fresca
  fake.put('fiestaSignals', 'f1/u1/' + s4, { t: 'answer', n: 4 });
  await tick();
  const afterFresh = fired.length;

  let lateSeenAt = -1;
  if (!opts.seedLate) {                          // la señal TARDÍA aterriza tarde
    fake.put('fiestaSignals', 'f1/u1/' + lateId, { t: 'offer', n: 0 });
    await tick();
    lateSeenAt = fired.length;                   // debe seguir igual: invisible al delta
  }

  // avanzar hasta EVERY ciclos delta exitosos (fallo determinista opcional)
  let midFailed = false, guard = 0;
  while (I.deltaCyclesForTest(gk) < EVERY && guard++ < 90) {
    if (opts.failMidAt != null && !midFailed && I.deltaCyclesForTest(gk) === opts.failMidAt) {
      fake.failTimes(1, nonRetriable()); midFailed = true;
    }
    await tick();
  }
  const reachedFull = I.deltaCyclesForTest(gk) >= EVERY;
  const beforeFull = fired.length;

  // el próximo tick es el re-baseline forzado (lectura completa)
  if (opts.failForcedFull) fake.failTimes(1, nonRetriable());
  await tick();
  const afterFailLen = fired.length;
  if (opts.failForcedFull) await tick();         // reintento: sigue siendo full
  const afterFull = fired.length;

  off();
  I.resetListeners();
  return { fired, seenN, afterIdle, afterFresh, lateSeenAt, beforeFull, afterFailLen, afterFull,
           reachedFull, EVERY, lateId, keys: { s1, s2, s3, s4 } };
}

(async () => {
  let fails = 0;
  const ok = (c, name) => { if (!c) { fails++; console.error('FALLA:', name); } else console.log('ok:', name); };

  // Run A: parcheado; la señal tardía aterriza DESPUÉS de que avanzó el watermark
  const A = await runScenario({ seedLate: false });
  ok(A.EVERY === 40, 'DELTA_FULL_EVERY = 40 (I.DELTA_FULL_EVERY=' + A.EVERY + ')');
  ok(A.afterIdle === 3, 'baseline dispara s1,s2,s3 una vez cada una (' + A.afterIdle + ' callbacks)');
  ok(A.afterFresh === 4 && A.fired[3] === A.keys.s4, 'delta entrega la señal fresca exactamente 1 vez');
  ok(A.lateSeenAt === 4, 'HUECO REPRODUCIDO: señal 60s tardía invisible al rango delta (0 callbacks)');
  ok(A.reachedFull, 'el contador llegó a EVERY tras 40 deltas exitosos');
  ok(A.beforeFull === 4, 'nada nuevo antes del re-baseline');
  ok(A.afterFull === 5 && A.fired[4] === A.lateId, 're-baseline entrega la señal tardía exactamente 1 vez');
  const countsA = {};
  A.fired.forEach(k => { countsA[k] = (countsA[k] || 0) + 1; });
  ok(Object.keys(countsA).length === 5 && Object.keys(countsA).every(k => countsA[k] === 1),
    'sin re-disparos: 5 claves distintas, 1 vez cada una');

  // Run B: control — la misma señal estuvo desde el inicio (equivalencia).
  // Las claves push ID llevan aleatoriedad y difieren entre runs: la
  // equivalencia se verifica sobre el MULTISET de payloads (campo n).
  const B = await runScenario({ seedLate: true });
  const sk = (arr) => JSON.stringify(arr.slice().sort((a, b) => a - b));
  ok(sk(A.seenN) === sk(B.seenN) && sk(A.seenN) === '[0,1,2,3,4]',
    'EQUIVALENCIA: mismo multiset de payloads que el control ([0,1,2,3,4])');
  ok(B.fired.length === 5, 'control: 5 callbacks (4 baseline + s4), sin dupes del full (' + B.fired.length + ')');

  // Run C: fallo no-retriable a mitad + fallo del re-baseline forzado
  const C = await runScenario({ seedLate: false, failMidAt: 10, failForcedFull: true });
  ok(C.afterFailLen === 4, 'el re-baseline fallido no entrega nada ni avanza el contador');
  ok(C.afterFull === 5 && C.fired[4] === C.lateId,
    'el re-baseline fallido se reintenta como lectura completa (tardía entregada)');
  const countsC = {};
  C.fired.forEach(k => { countsC[k] = (countsC[k] || 0) + 1; });
  ok(C.fired.length === 5 && Object.keys(countsC).length === 5 &&
     Object.keys(countsC).every(k => countsC[k] === 1),
    'fallos no rompen invariantes: 5 callbacks únicos, 1 vez cada uno');

  if (fails) { console.error(fails + ' FALLAS'); process.exit(1); }
  console.log('test-c12-rebaseline: TODO OK');
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
