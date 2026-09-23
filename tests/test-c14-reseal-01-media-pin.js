'use strict';
// QA ciclo 14 — CONTRATO DE RESEAL, cláusula (c): pin opt-in de la key (C14-01).
//
// Escenario (PoC C14-01): el composer reserva K_old, sube los trozos de media
// ONLINE a noteVideos/<K_old> (o noteImages/<K_old>); la red cae antes del
// .set() de la nota y solo communityNotes/<K_old> se encola. Al vaciar, el
// reseal movía la nota a K_new y los trozos ya persistidos quedaban huérfanos.
//
// Fix: Ref.set(value, { noReseal: true }) — la op pineada conserva su key al
// vaciar (resealQueue la salta). publishNoteToDatabase pinea cuando ya hubo
// dependientes persistidos (note.video || note.imageCount).
//
// Regresión: ANTES del fix la opción se ignora -> el reseal ocurre -> los
// checks T1/T2b/T3/T4 FALLAN. DESPUÉS del fix pasan.
//   BEFORE: DREX_CLOUD_PATH=../src-base/drex-cloud.js node test-c14-reseal-01-media-pin.js  (falla)
//   AFTER:  node test-c14-reseal-01-media-pin.js  (pasa)
const fs = require('fs');
const path = require('path');

function findRepoFile(cands) {
  for (const c of cands) { const p = path.join(__dirname, c); if (fs.existsSync(p)) return p; }
  throw new Error('archivo no encontrado: ' + cands.join(' / '));
}
// Layout del repo (tests/ en raíz) primero; layout de dir aislado del worker como fallback.
const CLOUD = process.env.DREX_CLOUD_PATH || findRepoFile(['../drex-cloud.js', '../src/drex-cloud.js']);
const SRC_INDEX = process.env.DREX_INDEX_PATH || findRepoFile(['../index.html', '../src/index.html']);

// ---------- stubs de entorno (antes de cargar el módulo) ----------
const realSetTimeout = setTimeout;
global.setTimeout = (fn, ms, ...a) => (ms === 1500 ? 0 : realSetTimeout(fn, ms, ...a));
global.clearTimeout = clearTimeout;
let online = true;
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
Object.defineProperty(globalThis.navigator, 'onLine', { get: () => online, configurable: true });
let lsStore = new Map();
global.localStorage = {
  getItem: k => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: k => lsStore.delete(k),
};

function makeFakeDb() {
  const store = new Map();
  let failBatch = 0, failErr = null;
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
  return { dc, store,
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

async function main() {
  console.log('== C14-01: pin de reseal para media pre-persistida (módulo: ' + CLOUD + ')');
  const fake = makeFakeDb();
  const M = freshModule();
  M.__internals.setDocClient(fake.dc);
  const db = () => M.DrexCloud.database();

  // T1: escenario PoC con el contrato aplicado (set pineado).
  online = true;
  const reservedRef = db().ref('communityNotes').push();
  const kOld = reservedRef.key;
  await db().ref('noteVideos/' + kOld).set({ chunk_00000: 'AAA', chunk_00001: 'BBB' });
  await settle(4);
  online = false;
  const noteP = reservedRef.set({ text: 'mi video', authorId: 'u1', video: { chunks: 2 } }, { noReseal: true });
  await settle(2);
  check('T1 nota encolada offline', M.DrexCloud._outbox.pending().length === 1);
  online = true;
  M.DrexCloud._outbox.flush();
  await noteP;
  await settle(8);
  check('T1 sin reseal: ref.key conserva K_old', reservedRef.key === kOld, reservedRef.key + ' vs ' + kOld);
  check('T1 nota escrita en communityNotes/K_old',
    fake.leafVal('communityNotes', kOld + '/text') === 'mi video');
  check('T1 trozos legibles en noteVideos/K_old (la app reproduce el video)',
    !!fake.leafVal('noteVideos', kOld + '/chunk_00000'));
  check('T1 cero trozos huérfanos en otras keys',
    fake.childKeys('noteVideos', '').filter(k => k !== kOld).length === 0,
    JSON.stringify(fake.childKeys('noteVideos', '')));

  // T2: sin pin, el reseal C13 sigue funcionando (no se rompió el default).
  online = false;
  const r2 = db().ref('communityNotes').push();
  const k2old = r2.key;
  const p2 = r2.set({ text: 'texto plano' });
  await settle(2);
  online = true;
  M.DrexCloud._outbox.flush();
  await p2;
  await settle(8);
  check('T2 sin pin: la nota SÍ se re-sella (comportamiento C13 intacto)', r2.key !== k2old);
  check('T2 valor intacto tras reseal', fake.leafVal('communityNotes', r2.key + '/text') === 'texto plano');

  // T2b: red cae DURANTE la subida de trozos (chunks encolados + nota pineada).
  online = true;
  const r3 = db().ref('communityNotes').push();
  const k3 = r3.key;
  await db().ref('noteVideos/' + k3).set({ chunk_00000: 'AAA' }); // online: persistido
  await settle(4);
  online = false; // cae a mitad de la subida
  const chunkP = db().ref('noteVideos/' + k3).set({ chunk_00000: 'AAA', chunk_00001: 'BBB' }); // encolado
  const noteP3 = r3.set({ text: 'video 2', video: { chunks: 2 } }, { noReseal: true }); // encolado pineado
  await settle(2);
  online = true;
  M.DrexCloud._outbox.flush();
  await Promise.all([chunkP, noteP3]);
  await settle(8);
  check('T2b nota y chunks acoplados en K_old (sin huérfanos)',
    r3.key === k3 &&
    fake.leafVal('communityNotes', k3 + '/text') === 'video 2' &&
    !!fake.leafVal('noteVideos', k3 + '/chunk_00001'));

  // T3: el pin sobrevive a un reinicio (la op persiste en localStorage).
  online = false;
  const r4 = db().ref('communityNotes').push();
  const k4 = r4.key;
  r4.set({ text: 'tras reinicio', video: { chunks: 1 } }, { noReseal: true }).catch(() => {});
  await settle(2);
  check('T3 op pineada persistida en cola', M.DrexCloud._outbox.pending().length === 1);
  const M2 = freshModule(); // "reinicio": módulo nuevo, mismo localStorage
  M2.__internals.setDocClient(fake.dc);
  const db2 = () => M2.DrexCloud.database();
  online = true;
  M2.DrexCloud._outbox.flush();
  await settle(10);
  check('T3 tras reinicio: la nota se escribió sin re-sellar',
    fake.leafVal('communityNotes', k4 + '/text') === 'tras reinicio',
    'keys: ' + JSON.stringify(fake.childKeys('communityNotes', '')));

  // T4: fallo retriable -> reintento reusa la key pineada (idempotencia, sin duplicados).
  online = false;
  const r5 = db().ref('communityNotes').push();
  const k5 = r5.key;
  const p5 = r5.set({ text: 'reintento', video: { chunks: 1 } }, { noReseal: true });
  await settle(2);
  online = true;
  const retriable = new Error('throttled');
  retriable.code = 'Throttling';
  fake.failBatchWrites(1, retriable);
  M.DrexCloud._outbox.flush();
  await settle(10); // el fallo agenda reintento con backoff; lo disparamos manual
  M.DrexCloud._outbox.flush();
  await p5;
  await settle(8);
  const k5keys = fake.childKeys('communityNotes', '').filter(k => k === k5 || k.indexOf(k5) === 0);
  check('T4 reintento reusa K_old (sin duplicados ni reseal)',
    r5.key === k5 && fake.leafVal('communityNotes', k5 + '/text') === 'reintento' && k5keys.length === 1,
    r5.key + ' keys=' + JSON.stringify(k5keys));

  // T5: el pin es sticky en el coalescing (una reescritura sin pin no lo libera).
  online = false;
  const r6 = db().ref('communityNotes').push();
  const k6 = r6.key;
  r6.set({ text: 'v1', video: { chunks: 1 } }, { noReseal: true });
  await settle(1);
  const p6 = r6.set({ text: 'v2', video: { chunks: 1 } }); // sin pin: reemplaza (último gana)
  await settle(2);
  online = true;
  M.DrexCloud._outbox.flush();
  await p6;
  await settle(8);
  check('T5 pin sticky: conserva K_old y aplica el último valor',
    r6.key === k6 && fake.leafVal('communityNotes', k6 + '/text') === 'v2');

  // T6 (estático): publishNoteToDatabase pinea cuando hubo dependientes persistidos.
  const html = fs.readFileSync(SRC_INDEX, 'utf8');
  const pubZone = html.slice(html.indexOf('function publishNoteToDatabase'));
  check('T6 publishNoteToDatabase pinea con { noReseal: true }',
    /pinNoteKey[\s\S]{0,400}noReseal:\s*true/.test(pubZone) &&
    /note\.video\s*\|\|\s*note\.imageCount/.test(pubZone));

  console.log(failures ? `\n${failures} FALLA(S)` : '\nTODOS OK');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
