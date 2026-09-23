'use strict';
// QA ciclo 13 — re-sellado de push IDs al vaciar el Outbox tras offline.
//
// Escenario: M1 (emisor, con su propia vista del chat) se queda offline y
// encola escrituras push-style (3 mensajes de chat, 1 post con foto acoplado
// noteImages/<K>, 1 comentario sobre el post offline, 1 set de ruta fija).
// M2 (receptor puro) sigue online; otros clientes avanzan su watermark por
// encima de los IDs viejos. Al reconectar, M1 vacía la cola.
//
// Patched: cada escritura sale con push ID fresco -> el receptor la recibe en
// el siguiente ciclo delta SIN esperar el re-baseline (<< 40 ciclos); 0
// pérdidas, 0 duplicados, orden preservado, acoplamientos consistentes
// (noteImages/<K'> == communityNotes/<K'>), la ruta fija intacta, y los refs
// del llamador (pushAsync / preReservedRef.set) apuntan a la key nueva.
// Control (--control, árbol sin parche): el receptor NO ve el mensaje hasta
// el re-baseline de 40 ciclos (documenta el "antes").
const path = require('path');
const CONTROL = process.argv.includes('--control');

// ---------- stubs de entorno (antes de cargar el módulo) ----------
const timers = new Map();
let nextTimerId = 1;
const realSetTimeout = setTimeout;
global.setInterval = (fn, ms) => { const id = nextTimerId++; timers.set(id, { fn, ms, cleared: false }); return id; };
global.clearInterval = (id) => { const t = timers.get(id); if (t) t.cleared = true; };
// El flush de arranque del Outbox (1500 ms) se suprime: el vaciado es manual
// y así el Outbox de M2 nunca corre sobre la cola compartida de M1.
global.setTimeout = (fn, ms, ...a) => (ms === 1500 ? 0 : realSetTimeout(fn, ms, ...a));
global.clearTimeout = clearTimeout;
let online = true;
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
Object.defineProperty(globalThis.navigator, 'onLine', { get: () => online, configurable: true });
const lsStore = new Map();
global.localStorage = {
  getItem: k => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: k => lsStore.delete(k),
};
// Reloj simulado: permite que el "offline" dure minutos (los push IDs viejos
// quedan FUERA del overlap de 15 s del delta, como en el mundo real).
const realDateNow = Date.now;
let nowShiftMs = 0;
Date.now = () => realDateNow() + nowShiftMs;

// ---------- DynamoDB falso con BETWEEN ----------
function makeFakeDb() {
  const store = new Map(); // "pk\0sk" -> {pk, sk, v}
  let failBatch = 0, failErr = null;
  const put = (pk, sk, v) => store.set(pk + '\0' + sk, { pk, sk, v: JSON.stringify(v === undefined ? null : v) });
  const dc = {
    query(params) {
      return { promise: () => new Promise((resolve) => {
        realSetTimeout(() => {
          const vals = params.ExpressionAttributeValues || {};
          const kce = params.KeyConditionExpression || '';
          let items = [];
          for (const it of store.values()) if (it.pk === vals[':pk']) items.push(it);
          if (kce.indexOf('BETWEEN') >= 0) {
            const lo = vals[':lo'], hi = vals[':hi'];
            items = items.filter(it => it.sk >= lo && it.sk <= hi);
          } else if (kce.indexOf('begins_with') >= 0) {
            const pfx = vals[':pfx'];
            items = items.filter(it => it.sk.indexOf(pfx) === 0);
          }
          items.sort((a, b) => (a.sk < b.sk ? -1 : (a.sk > b.sk ? 1 : 0)));
          resolve({ Items: items.map(it => ({ pk: it.pk, sk: it.sk, v: it.v })), LastEvaluatedKey: null });
        }, 0);
      }) };
    },
    batchWrite(params) {
      return { promise: () => new Promise((resolve, reject) => {
        realSetTimeout(() => {
          if (failBatch > 0) { failBatch--; reject(failErr || new Error('boom')); return; }
          const tableReqs = params.RequestItems[Object.keys(params.RequestItems)[0]] || [];
          tableReqs.forEach(r => {
            if (r.PutRequest) { const it = r.PutRequest.Item; store.set(it.pk + '\0' + it.sk, { pk: it.pk, sk: it.sk, v: it.v }); }
            else if (r.DeleteRequest) store.delete(r.DeleteRequest.Key.pk + '\0' + r.DeleteRequest.Key.sk);
          });
          resolve({ UnprocessedItems: {} });
        }, 0);
      }) };
    },
  };
  return { dc, put, store,
    failBatchWrites(n, err) { failBatch = n; failErr = err; },
    childKeys(pk, prefix) {
      const out = new Set();
      for (const it of store.values()) {
        if (it.pk !== pk) continue;
        if (it.sk.indexOf(prefix) !== 0) continue;
        out.add(it.sk.slice(prefix.length).split('/')[0]);
      }
      return [...out].sort();
    },
    leafVal(pk, sk) {
      const it = store.get(pk + '\0' + sk);
      return it ? JSON.parse(it.v) : undefined;
    } };
}

function freshModule() {
  const p = path.join(__dirname, '..', 'drex-cloud.js');
  delete require.cache[require.resolve(p)];
  return require(p);
}
const sleep = (ms) => new Promise(r => realSetTimeout(r, ms));
async function settle(n) { for (let i = 0; i < (n || 10); i++) await sleep(25); }
function tick() {
  for (const t of timers.values()) if (!t.cleared) { try { t.fn(); } catch (e) { console.error('tick throw', e); } }
}
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FALLA ' + name + (extra ? ' :: ' + extra : '')); }
}

async function main() {
  const fake = makeFakeDb();
  const M1 = freshModule(); // emisor (+ su vista local del chat)
  const M2 = freshModule(); // receptor puro
  const I1 = M1.__internals, I2 = M2.__internals;
  M1.__internals.setDocClient(fake.dc);
  M2.__internals.setDocClient(fake.dc);
  const db1 = () => M1.DrexCloud.database(), db2 = () => M2.DrexCloud.database();
  const chat1 = () => db1().ref('fiestas/f1/chat'), chat2 = () => db2().ref('fiestas/f1/chat');

  // 1. Baseline: un mensaje previo por la vía normal (online).
  online = true;
  const seedRef = await chat2().pushAsync({ uid: 'u0', text: 'seed', ts: Date.now() });
  const s1 = seedRef.key;
  await settle(6);

  // 2. Receptor (M2) y vista local del emisor (M1) se suscriben.
  const fired1 = [], fired2 = [];
  const off1 = chat1().onDelta(snap => fired1.push(snap.key));
  const off2 = chat2().onDelta(snap => fired2.push(snap.key));
  await settle(10); // lecturas iniciales
  check('baseline inicial entrega s1 a ambos', fired1.join() === s1 && fired2.join() === s1, fired1.join() + ' / ' + fired2.join());
  tick(); await settle(8); tick(); await settle(8);

  // 3. M1 se queda offline y encola. El reloj se atrasa 3 min: los IDs
  // encolados nacen "viejos" (fuera del overlap de 15 s del delta).
  online = false;
  nowShiftMs = -180000;
  const tEnq = Date.now();
  const p1 = chat1().pushAsync({ uid: 'u1', text: 'm1', ts: tEnq });
  let p2, p3, pf, pImg, pNote, pCom, noteRef, kOld;
  if (!CONTROL) {
    p2 = chat1().pushAsync({ uid: 'u1', text: 'm2', ts: tEnq });
    p3 = chat1().pushAsync({ uid: 'u1', text: 'm3', ts: tEnq });
    pf = db1().ref('users/u1/status').set('offline-status');
    noteRef = db1().ref('communityNotes').push(); // reserva sin escribir
    kOld = noteRef.key;
    pImg = db1().ref('noteImages/' + kOld).set({ img_00000: 'data:image/png,AAA', img_00001: 'data:image/png,BBB' });
    pNote = noteRef.set({ text: 'post foto', imageCount: 2, authorId: 'u1' });
    pCom = db1().ref('communityNotes/' + kOld + '/comments').pushAsync({ uid: 'u2', text: 'c1' });
  }
  await settle(4);
  const pend = M1.DrexCloud._outbox.pending();
  const NOPS = CONTROL ? 1 : 7;
  check('cola con N ops pendientes', pend.length === NOPS, 'pend=' + pend.length);
  const chatOldKeys = pend.filter(o => o.path.indexOf('fiestas/f1/chat/') === 0).map(o => o.path.split('/').pop());
  if (!CONTROL) check('3 mensajes encolados', chatOldKeys.length === 3, JSON.stringify(chatOldKeys));
  check('eco local no duplica en child_added del padre (no-op verificado)', fired1.length === 1 && fired2.length === 1,
    'fired1=' + fired1.length + ' fired2=' + fired2.length);

  // 4. Otros clientes escriben: el watermark del receptor avanza por encima de los IDs viejos.
  online = true; // M2 (receptor) sigue online; M1 sigue "offline" lógicamente: no vacía aún
  nowShiftMs = 0; // el presente real: o1/o2 son nuevos, los encolados tienen 3 min
  const o1 = (await chat2().pushAsync({ uid: 'u9', text: 'other1', ts: Date.now() })).key;
  const o2 = (await chat2().pushAsync({ uid: 'u9', text: 'other2', ts: Date.now() })).key;
  await settle(6);
  tick(); await settle(8); tick(); await settle(8);
  const gk = 'fiestas/f1/chat|null';
  const wmOk = chatOldKeys.every(k => o2 > k);
  check('watermark del receptor por encima de los IDs viejos', wmOk && fired2.slice(-2).join() === [o1, o2].join(),
    'o2=' + o2 + ' olds=' + chatOldKeys.join());

  // 5. M1 reconecta y vacía.
  const drainStart = Date.now();
  online = true;
  M1.DrexCloud._outbox.flush();
  const tFlush = Date.now();
  let flushErr = null;
  const all = CONTROL ? [p1] : [p1, p2, p3, pf, pImg, pNote, pCom];
  try { await Promise.all(all); } catch (e) { flushErr = e; }
  await settle(14); // vaciado secuencial + ecos locales (120 ms)
  check('flush sin rechazos (0 pérdidas)', flushErr === null, flushErr && flushErr.message);
  check('cola vacía tras flush', M1.DrexCloud._outbox.pending().length === 0);

  const chatKeys = fake.childKeys('fiestas', 'f1/chat/');
  if (CONTROL) {
    // --- rama control: sin parche, el mensaje viejo es invisible al delta ---
    const oldKey = chatOldKeys[0];
    check('control: el ID viejo SÍ se escribió (misma key)', chatKeys.indexOf(oldKey) >= 0, chatKeys.join());
    for (let i = 0; i < 10; i++) { tick(); await settle(6); }
    check('control: invisible al delta antes del re-baseline', fired2.indexOf(oldKey) < 0, 'fired2=' + fired2.join());
    for (let i = 0; i < 32; i++) { tick(); await settle(6); } // hasta el ciclo ~42
    check('control: el re-baseline (~40 ciclos) sí lo entrega', fired2.indexOf(oldKey) >= 0, 'fired2=' + fired2.join());
    check('control: sin duplicados', fired2.filter(k => k === oldKey).length === 1);
  } else {
    // --- rama parche ---
    const news = chatKeys.filter(k => [s1, o1, o2].indexOf(k) < 0);
    check('3 mensajes con keys NUEVAS (no las viejas)', news.length === 3 && chatOldKeys.every(k => chatKeys.indexOf(k) < 0),
      'keys=' + chatKeys.join());
    const fresh = news.every(k => {
      const t = I1.pushIdTime(k);
      return k.length === 20 && t >= drainStart - 2000 && t <= Date.now() + 2000;
    });
    check('IDs frescos (ts ≈ momento del vaciado)', fresh, news.join());
    check('IDs únicos', new Set(news).size === 3);
    const [n1, n2, n3] = news.slice().sort();
    const texts = [n1, n2, n3].map(k => fake.leafVal('fiestas', 'f1/chat/' + k + '/text'));
    check('orden FIFO preservado', texts.join() === 'm1,m2,m3', texts.join());

    // receptor: entrega en el siguiente delta, sin re-baseline
    let deliveredAt = -1;
    for (let i = 1; i <= 6; i++) { tick(); await settle(8); if (news.every(k => fired2.indexOf(k) >= 0)) { deliveredAt = i; break; } }
    check('receptor recibe las 3 en el siguiente ciclo delta', deliveredAt >= 1 && deliveredAt <= 3, 'ciclos=' + deliveredAt);
    const cyc = I2.deltaCyclesForTest(gk);
    check('sin re-baseline de por medio (ciclos << 40)', cyc < 10, 'deltaCycles=' + cyc);
    check('receptor: cada mensaje exactamente 1 vez', news.every(k => fired2.filter(x => x === k).length === 1),
      'fired2=' + fired2.join());
    // NOTA PRE-EXISTENTE (no causada por el re-sellado): el eco local al
    // encolar poda l.kids con un snapshot vacío y el siguiente delta
    // (overlap 15 s) re-dispara el mensaje base s1 en la vista del emisor.
    // Se verifica aquí solo la garantía del re-sellado: cada key NUEVA se
    // pinta exactamente una vez y ninguna key VIEJA aparece jamás.
    const newsOnce = news.every(k => fired1.filter(x => x === k).length === 1);
    const noOldKeys = chatOldKeys.every(k => fired1.indexOf(k) < 0);
    check('vista local del emisor: keys nuevas 1 vez, viejas 0 veces', newsOnce && noOldKeys,
      'fired1=' + fired1.join());
    if (fired1.filter(k => k === s1).length > 1)
      console.log('  nota  re-disparo pre-existente de s1 por poda del eco (fuera de esta unidad)');

    // acoplamiento foto: misma key nueva en communityNotes y noteImages
    const cnKeys = fake.childKeys('communityNotes', '');
    const niKeys = fake.childKeys('noteImages', '');
    check('post con key nueva (no la vieja)', cnKeys.indexOf(kOld) < 0 && cnKeys.length === 1, cnKeys.join());
    const kNew = cnKeys[0];
    check('noteImages usa la MISMA key nueva', niKeys.join() === kNew, niKeys.join() + ' vs ' + kNew);
    check('trozos de foto intactos', fake.leafVal('noteImages', kNew + '/img_00000') === 'data:image/png,AAA');
    check('key del post fresca', I1.pushIdTime(kNew) >= drainStart - 2000, kNew);
    // comentario: referencia intermedia traducida
    const cKeys = fake.childKeys('communityNotes', kNew + '/comments/');
    check('comentario bajo la key nueva', cKeys.length === 1 && fake.leafVal('communityNotes', kNew + '/comments/' + cKeys[0] + '/text') === 'c1',
      cKeys.join());
    // ruta fija intacta
    check('ruta fija sin re-sellar', fake.leafVal('users', 'u1/status') === 'offline-status');
    // propagación de la key al llamador
    const r1 = await p1;
    check('pushAsync resuelve con la key nueva', r1.key === n1, 'key=' + r1.key + ' n1=' + n1);
    check('ref reservado apunta a la key nueva', noteRef.key === kNew, 'key=' + noteRef.key);
  }

  off1(); off2();
  console.log(failures === 0 ? 'TODAS LAS PRUEBAS PASARON' : 'FALLAS: ' + failures);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
