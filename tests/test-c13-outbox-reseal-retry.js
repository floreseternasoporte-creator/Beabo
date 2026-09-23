'use strict';
// QA ciclo 13 (2/2) — reintento tras fallo: la key re-sellada se REUSA,
// no se vuelve a re-sellar (exactamente-una-vez ante backoff/reinicio).
const path = require('path');
const timers = new Map(); let nid = 1;
const rst = setTimeout;
global.setInterval = (fn, ms) => { const id = nid++; timers.set(id, { fn, cleared: false }); return id; };
global.clearInterval = id => { const t = timers.get(id); if (t) t.cleared = true; };
global.setTimeout = (fn, ms, ...a) => (ms === 1500 ? 0 : rst(fn, ms, ...a));
let online = true;
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
Object.defineProperty(globalThis.navigator, 'onLine', { get: () => online, configurable: true });
const ls = new Map();
global.localStorage = { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) };
const realDateNow = Date.now; let shift = 0;
Date.now = () => realDateNow() + shift;

const store = new Map();
let failBatch = 0;
function cmp(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
const dc = {
  query(p) {
    return { promise: () => new Promise(res => rst(() => {
      const vals = p.ExpressionAttributeValues || {};
      let items = [];
      for (const it of store.values()) if (it.pk === vals[':pk']) items.push(it);
      const kce = p.KeyConditionExpression || '';
      if (kce.indexOf('BETWEEN') >= 0) { const lo = vals[':lo'], hi = vals[':hi']; items = items.filter(it => it.sk >= lo && it.sk <= hi); }
      else if (kce.indexOf('begins_with') >= 0) { const pfx = vals[':pfx']; items = items.filter(it => it.sk.indexOf(pfx) === 0); }
      items.sort((a, b) => cmp(a.sk, b.sk));
      res({ Items: items.map(it => ({ pk: it.pk, sk: it.sk, v: it.v })), LastEvaluatedKey: null });
    }, 0)) };
  },
  batchWrite(p) {
    return { promise: () => new Promise((res, rej) => rst(() => {
      if (failBatch > 0) { failBatch--; const e = new Error('throttled'); e.code = 'ProvisionedThroughputExceededException'; rej(e); return; }
      (p.RequestItems[Object.keys(p.RequestItems)[0]] || []).forEach(r => {
        if (r.PutRequest) { const it = r.PutRequest.Item; store.set(it.pk + '\0' + it.sk, { pk: it.pk, sk: it.sk, v: it.v }); }
        else if (r.DeleteRequest) store.delete(r.DeleteRequest.Key.pk + '\0' + r.DeleteRequest.Key.sk);
      });
      res({ UnprocessedItems: {} });
    }, 0)) };
  },
};
const P = require('path').join(__dirname, '..', 'drex-cloud.js'); // C13-fix: ruta relativa al repo (la absoluta solo existía en la máquina del worker)
const M = require(P);
M.__internals.setDocClient(dc);
const I = M.__internals;
const sleep = ms => new Promise(r => rst(r, ms));
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  ok   ' + n); else { failures++; console.log('  FALLA ' + n + (x ? ' :: ' + x : '')); } };

(async () => {
  // offline 3 min, una escritura
  online = false; shift = -180000;
  const p = M.DrexCloud.database().ref('fiestas/f9/chat').pushAsync({ uid: 'u1', text: 'retry-me', ts: Date.now() });
  await sleep(100);
  const pend0 = M.DrexCloud._outbox.pending();
  check('1 op encolada', pend0.length === 1, JSON.stringify(pend0.length));
  const oldKey = pend0[0].path.split('/').pop();

  // el vaciado falla 4 veces (throttle) -> backoff del Outbox -> reintento
  failBatch = 4;
  online = true; shift = 0;
  const drainStart = Date.now();
  M.DrexCloud._outbox.flush();
  const t0 = realDateNow();
  let settled = false, perr = null, ref = null;
  p.then(r => { settled = true; ref = r; }).catch(e => { settled = true; perr = e; });
  while (!settled && realDateNow() - t0 < 20000) await sleep(200);
  check('la escritura termina resolviendo (tras backoff)', settled && !perr, perr && perr.message);

  const kids = new Set();
  for (const it of store.values()) if (it.pk === 'fiestas' && it.sk.indexOf('f9/chat/') === 0) kids.add(it.sk.split('/')[2]);
  check('exactamente UN hijo escrito (sin duplicados)', kids.size === 1, [...kids].join());
  const newKey = [...kids][0];
  check('la key usada NO es la vieja', newKey !== oldKey, newKey);
  const t = I.pushIdTime(newKey);
  check('la key es la del PRIMER vaciado (no re-sellada en el retry)', t >= drainStart - 2000 && t <= Date.now() + 2000, newKey);
  check('pushAsync resolvió con la key re-sellada', ref && ref.key === newKey, ref && ref.key);
  check('cola vacía', M.DrexCloud._outbox.pending().length === 0);
  // persistencia: la cola guardada marcó resealed (un reinicio reusaría la key)
  const saved = JSON.parse(ls.get('drex_outbox_v1') || '[]');
  check('nada pendiente en localStorage', saved.length === 0, JSON.stringify(saved.length));

  console.log(failures === 0 ? 'TODAS LAS PRUEBAS PASARON' : 'FALLAS: ' + failures);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
