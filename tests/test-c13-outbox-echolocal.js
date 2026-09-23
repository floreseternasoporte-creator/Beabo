'use strict';
// C13: el eco local del Outbox no debe podar la memoria de los oyentes.
// echoLocal() corre al encolar offline. Antes del fix, para un oyente
// child_added sobre el PADRE despachaba snap.child(rel): un snapshot VACÍO,
// sin isDelta. La rama child_added de dispatchSnapshot podaba entonces l.kids
// por completo. Consecuencias: (a) el eco no mostraba nada localmente;
// (b) tras el flush, el re-read completo (notifyLocal, no-delta) re-disparaba
// TODOS los hijos como "nuevos" (parpadeo/duplicado en la vista del emisor);
// (c) un oyente 'value' sobre el padre recibía un evento espurio con valor vacío.
// Fix: echoLocal solo despacha en la ruta exacta (rel === ''); para oyentes
// del padre no hace nada: ni eco fantasma ni poda.
// Este test falla en el árbol sin fix (el seed se re-dispara) y pasa con el fix.
const path = require('path');

// ---------- stubs de entorno (antes de cargar el módulo) ----------
const realSetTimeout = setTimeout;
global.setInterval = () => 0;
global.clearInterval = () => {};
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

// ---------- DynamoDB falso mínimo ----------
function makeFakeDb() {
  const store = new Map();
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
      return { promise: () => new Promise((resolve) => {
        realSetTimeout(() => {
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
  return { dc };
}

const sleep = (ms) => new Promise(r => realSetTimeout(r, ms));
async function settle(n) { for (let i = 0; i < (n || 10); i++) await sleep(25); }
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FALLA ' + name + (extra ? ' :: ' + extra : '')); }
}

async function main() {
  const p = path.join(__dirname, '..', 'drex-cloud.js');
  delete require.cache[require.resolve(p)];
  const M = require(p);
  M.__internals.setDocClient(makeFakeDb().dc);
  const chat = () => M.DrexCloud.database().ref('chats/c1');

  // 1. Online: oyente child_added sobre el padre + mensaje semilla.
  online = true;
  const fired = [];
  const off = chat().on('child_added', s => fired.push(s.key));
  const seedRef = await chat().pushAsync({ uid: 'u1', text: 'seed' });
  const seedKey = seedRef.key;
  await settle(10);
  check('baseline: el seed dispara exactamente una vez', fired.length === 1 && fired[0] === seedKey, JSON.stringify(fired));
  fired.length = 0;

  // 2. Offline: se encola un mensaje (corre echoLocal).
  online = false;
  const pending = chat().pushAsync({ uid: 'u1', text: 'offline-msg' });
  await settle(6);
  check('al encolar offline no hay eventos espurios', fired.length === 0, JSON.stringify(fired));

  // 3. Online + flush: el eco real (notifyLocal -> re-read completo) debe
  // disparar SOLO el mensaje nuevo. Si l.kids se podó al encolar, el seed
  // se re-dispara como "nuevo" (el parpadeo reportado).
  online = true;
  M.DrexCloud._outbox.flush();
  await pending;
  await settle(10);
  check('tras el flush solo se dispara el mensaje nuevo (l.kids intacto)',
    fired.length === 1 && fired[0] !== seedKey, JSON.stringify(fired));

  off();
  if (failures) { console.error(`\n${failures} FALLAS`); process.exit(1); }
  console.log('\nechoLocal: sin poda de oyentes — OK');
}

main().catch(e => { console.error('ERROR', e); process.exit(1); });
