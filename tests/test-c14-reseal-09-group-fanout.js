'use strict';
// QA ciclo 14 — CONTRATO DE RESEAL, cláusulas (a)+(b): crear grupo (C14-09).
//
// Antes: set() en groupChats/<gid> (Outbox-aware) + update() fan-out a
// userConversations/<uid>/<gid> (update NO es Outbox-aware: rechazaba offline)
// + push() a conversationMessages/<gid> con la key léxica. Si la red caía
// entre el set y el update, el grupo se re-sellaba pero el inbox jamás se
// escribía -> grupo fantasma.
//
// Fix (contrato): conservar el ref (gref); tras `await gref.set(...)` usar
// gref.key (siempre la key final) para el fan-out expresado como set()s
// (Outbox-aware, mismo mapa de reseal) con { noReseal: true } (la key ya es
// final: un segundo corte no debe re-sellarla a una key inexistente), y para
// el push del mensaje.
//
// Regresión: T2 FALLA antes del fix (el pin se ignora -> el fan-out se
// re-sella a una key fantasma); después pasa. T3 estático falla antes.
//   BEFORE: DREX_CLOUD_PATH=../src-base/drex-cloud.js DREX_INDEX_PATH=<base> node test-c14-reseal-09-group-fanout.js
//   AFTER:  node test-c14-reseal-09-group-fanout.js
const fs = require('fs');
const path = require('path');

function findRepoFile(cands) {
  for (const c of cands) { const p = path.join(__dirname, c); if (fs.existsSync(p)) return p; }
  throw new Error('archivo no encontrado: ' + cands.join(' / '));
}
// Layout del repo (tests/ en raíz) primero; layout de dir aislado del worker como fallback.
const CLOUD = process.env.DREX_CLOUD_PATH || findRepoFile(['../drex-cloud.js', '../src/drex-cloud.js']);
const SRC_INDEX = process.env.DREX_INDEX_PATH || findRepoFile(['../index.html', '../src/index.html']);

// ---------- stubs de entorno ----------
const realSetTimeout = setTimeout;
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
  return { dc, store,
    childKeys(pk, prefix) {
      const out = new Set();
      for (const it of store.values()) {
        if (it.pk !== pk) continue;
        if (it.sk.indexOf(prefix) !== 0) continue;
        out.add(it.sk.slice(prefix.length).split('/')[0]);
      }
      return [...out].sort();
    },
    leafVal(pk, sk) { const it = store.get(pk + '\0' + sk); return it ? JSON.parse(it.v) : undefined; } };
}

function freshModule() {
  delete require.cache[require.resolve(CLOUD)];
  return require(CLOUD);
}
const sleep = (ms) => new Promise(r => realSetTimeout(r, ms));
async function settle(n) { for (let i = 0; i < (n || 10); i++) await sleep(25); }
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FALLA ' + name + (extra ? ' :: ' + extra : '')); }
}

// Réplica fiel del flujo fixeado de crear-grupo (index.html), con el patrón
// del contrato: conservar el ref, await set, usar ref.key para dependientes.
async function createGroupFixed(db, outbox, memberUids, groupName) {
  const gref = db.ref('groupChats').push();
  const createdAt = Date.now();
  await gref.set({ name: groupName, createdBy: memberUids[0], createdAt, members: {} });
  const finalGroupId = gref.key;
  await Promise.all(memberUids.map(uid =>
    db.ref('userConversations/' + uid + '/' + finalGroupId).set({
      isGroup: true, groupId: finalGroupId, groupName, updatedAt: createdAt, lastMessage: 'Grupo creado',
    }, { noReseal: true })
  ));
  await db.ref('conversationMessages/' + finalGroupId).push({ system: true, text: 'Grupo creado', timestamp: createdAt })._writePromise;
  return finalGroupId;
}

async function main() {
  console.log('== C14-09: crear grupo con fan-out reseal-aware (módulo: ' + CLOUD + ')');
  const fake = makeFakeDb();
  const M = freshModule();
  M.__internals.setDocClient(fake.dc);
  const db = () => M.DrexCloud.database();

  // T1: escenario del PoC (red cae entre el set y el fan-out) con el contrato.
  // El await del set bloquea el fan-out hasta el flush: no hay ventana.
  online = false;
  const gref = db().ref('groupChats').push();
  const kOld = gref.key;
  const setP = gref.set({ name: 'Grupo T1', createdBy: 'u1', createdAt: Date.now(), members: {} });
  await settle(2);
  check('T1 set encolado offline', M.DrexCloud._outbox.pending().length === 1);
  online = true;
  M.DrexCloud._outbox.flush();
  await setP; // el fix hace await aquí antes del fan-out
  await settle(6);
  const finalKey = gref.key;
  check('T1 tras flush, gref.key es la key final', finalKey && finalKey !== kOld, finalKey);
  await Promise.all(['u1', 'u2'].map(uid =>
    db().ref('userConversations/' + uid + '/' + finalKey).set(
      { isGroup: true, groupId: finalKey, groupName: 'Grupo T1' }, { noReseal: true })));
  await settle(6);
  await db().ref('conversationMessages/' + finalKey).push({ system: true, text: 'Grupo creado' })._writePromise;
  await settle(6);
  const gKeys = fake.childKeys('groupChats', '');
  const inboxU1 = fake.childKeys('userConversations', 'u1/');
  const inboxU2 = fake.childKeys('userConversations', 'u2/');
  const msgKeys = fake.childKeys('conversationMessages', '');
  check('T1 grupo existe bajo la key final', gKeys.indexOf(finalKey) !== -1, JSON.stringify(gKeys));
  check('T1 inbox de u1 y u2 apunta a la key final (sin fantasma)',
    inboxU1.indexOf(finalKey) !== -1 && inboxU2.indexOf(finalKey) !== -1,
    'u1=' + JSON.stringify(inboxU1) + ' u2=' + JSON.stringify(inboxU2));
  check('T1 groupId del inbox es la key final',
    fake.leafVal('userConversations', 'u1/' + finalKey + '/groupId') === finalKey);
  check('T1 mensaje del sistema bajo la key final', msgKeys.indexOf(finalKey) !== -1);
  check('T1 nada bajo la key vieja', gKeys.indexOf(kOld) === -1 && inboxU1.indexOf(kOld) === -1);

  // T2: segundo corte de red ENTRE el set (ya final) y el fan-out.
  online = true;
  const g2 = db().ref('groupChats').push();
  await g2.set({ name: 'Grupo T2', createdBy: 'u1', createdAt: Date.now(), members: {} });
  await settle(4);
  const k2 = g2.key; // key final (escritura online directa)
  online = false; // cae la red justo antes del fan-out
  const fanP = Promise.all(['u1', 'u2'].map(uid =>
    db().ref('userConversations/' + uid + '/' + k2).set(
      { isGroup: true, groupId: k2, groupName: 'Grupo T2' }, { noReseal: true })));
  await settle(2);
  check('T2 fan-out encolado offline', M.DrexCloud._outbox.pending().length === 2);
  online = true;
  M.DrexCloud._outbox.flush();
  await fanP;
  await settle(8);
  const inbox2U1 = fake.childKeys('userConversations', 'u1/');
  const inbox2U2 = fake.childKeys('userConversations', 'u2/');
  check('T2 el fan-out pineado NO se re-sella: inbox en la key final',
    inbox2U1.indexOf(k2) !== -1 && inbox2U2.indexOf(k2) !== -1,
    'u1=' + JSON.stringify(inbox2U1));
  check('T2 groupId del inbox es la key del grupo',
    fake.leafVal('userConversations', 'u1/' + k2 + '/groupId') === k2);

  // T2b (mecanismo): SIN pin, ese mismo fan-out se re-sellaría a una key inexistente.
  online = true;
  const g3 = db().ref('groupChats').push();
  await g3.set({ name: 'Grupo T2b', createdBy: 'u1', createdAt: Date.now(), members: {} });
  await settle(4);
  const k3 = g3.key;
  online = false;
  const fanP3 = db().ref('userConversations/u9/' + k3).set({ isGroup: true, groupId: k3 }); // sin pin
  await settle(2);
  online = true;
  M.DrexCloud._outbox.flush();
  await fanP3;
  await settle(8);
  const inboxU9 = fake.childKeys('userConversations', 'u9/');
  check('T2b sin pin el fan-out se re-sella (por eso el pin es necesario)',
    inboxU9.length === 1 && inboxU9[0] !== k3, 'u9=' + JSON.stringify(inboxU9));

  // T3 (estático): el código real de crear-grupo aplica el contrato.
  const html = fs.readFileSync(SRC_INDEX, 'utf8');
  const startMarker = html.indexOf("const gref = DrexCloud.database().ref('groupChats').push();");
  const legacyMarker = html.indexOf("ref('groupChats').push().key");
  const gi = startMarker !== -1 ? startMarker : legacyMarker;
  const zone = gi !== -1 ? html.slice(gi, gi + 4000) : '';
  check('T3 crear-grupo conserva el ref y usa su key final',
    /const gref = DrexCloud\.database\(\)\.ref\('groupChats'\)\.push\(\);/.test(zone) &&
    /await gref\.set\(/.test(zone) &&
    /const finalGroupId = gref\.key;/.test(zone));
  check('T3 fan-out como set()s pineados (no update)',
    /userConversations\/' \+ uid \+ '\/' \+ finalGroupId\)\.set\(/.test(zone) &&
    /noReseal:\s*true/.test(zone) &&
    !/\.update\(inboxUpdates\)/.test(zone));
  check("T3 el push de mensajes usa finalGroupId",
    /ref\('conversationMessages\/' \+ finalGroupId\)\.push\(/.test(zone));

  console.log(failures ? `\n${failures} FALLA(S)` : '\nTODOS OK');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
