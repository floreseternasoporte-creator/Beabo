'use strict';
// QA ciclo 15 — R5-1: SCOPE POR CUENTA DEL OUTBOX.
//
// Harness con el drex-cloud.js REAL + stub de red/IAM (fake DocumentClient).
// Escenarios:
//   (A) op de A encolada offline -> switch a B -> flush bajo B: la op de A NO
//       debe ejecutarse ni borrarse; al volver A se vacía intacta.
//   (B) backoff pendiente + signOut: el retryTimer se cancela; ningún intento
//       de flush tras el logout y la op de A sobrevive (sin dropHead).
//   (C) variante sin dueño (op encolada sin sesión): prueba directa de que el
//       timer murió — si el flush corriera tras el logout, la op se intentaría.
//   (D) regresión del contrato de reseal con colas mixtas: el flush de A solo
//       re-sella las ops de A; las de B quedan intactas (sin reseal) y se
//       vacían cuando B flushea.
//
// Before/after real:
//   BEFORE: DREX_CLOUD_PATH=/home/hatch/workspace/beabo/drex-cloud.js node tests/test-c15-outbox-account-scope.js  (falla)
//   AFTER:  node tests/test-c15-outbox-account-scope.js  (pasa)
//
// Reglas del repo: el test resuelve el layout primero (../drex-cloud.js) con
// fallback por env; sin rutas absolutas cableadas; sin dependencia de git.
const fs = require('fs');
const path = require('path');

const CLOUD = process.env.DREX_CLOUD_PATH || path.join(__dirname, '..', 'drex-cloud.js');
if (!fs.existsSync(CLOUD)) {
  console.error('No se encontró drex-cloud.js en: ' + CLOUD);
  process.exit(2);
}

// ---------- stubs de entorno (antes de cargar el módulo) ----------
const realSetTimeout = setTimeout;
// El flush de arranque (1500 ms, programado sincrónicamente al cargar el
// módulo) se anula UNA vez por boot; el resto de timers son reales (el
// backoff del outbox debe disparar de verdad en los escenarios B/C).
let armStartupSwallow = false;
global.setTimeout = (fn, ms, ...a) => {
  if (ms === 1500 && armStartupSwallow) { armStartupSwallow = false; return 0; }
  return realSetTimeout(fn, ms, ...a);
};
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

// Fake DocumentClient: éxito/fracaso programable + registro de intentos con
// el uid "activo" en el momento de la escritura (lo lee el test).
function makeFakeDb() {
  const store = new Map();
  let failLeft = 0, failErr = null;
  const writes = []; // { at, uid, nReqs }
  let getUid = () => null;
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
          if (failLeft > 0) { failLeft--; reject(failErr || new Error('boom')); return; }
          const tableReqs = params.RequestItems[Object.keys(params.RequestItems)[0]] || [];
          writes.push({ at: Date.now(), uid: getUid(), nReqs: tableReqs.length });
          tableReqs.forEach(r => {
            if (r.PutRequest) { const it = r.PutRequest.Item; store.set(it.pk + '\0' + it.sk, { pk: it.pk, sk: it.sk, v: it.v }); }
            else if (r.DeleteRequest) store.delete(r.DeleteRequest.Key.pk + '\0' + r.DeleteRequest.Key.sk);
          });
          resolve({ UnprocessedItems: {} });
        }, 0);
      }) };
    },
  };
  return { dc, store, writes,
    setGetUid(fn) { getUid = fn; },
    failBatchWrites(n, err) { failLeft = n; failErr = err; },
    succeed() { failLeft = 0; failErr = null; },
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
// Rastrea el estado de una promesa sin alterar su cadena.
function track(p) {
  const st = { resolved: false, rejected: false, value: undefined };
  p.then(v => { st.resolved = true; st.value = v; }, e => { st.rejected = true; st.value = e; });
  return st;
}
function throttlingErr() { const e = new Error('Rate exceeded'); e.code = 'ThrottlingException'; return e; }

// Boot: módulo fresco, localStorage fresco, fake inyectado, sesión simulada.
// La "sesión" se simula dejando auth().currentUser como lo deja
// establishSession() (el outbox solo lee ese campo).
function boot(uid) {
  lsStore = new Map();
  const fake = makeFakeDb();
  armStartupSwallow = true; // el require() programa el flush de arranque
  const M = freshModule();
  M.__internals.setDocClient(fake.dc);
  const auth = M.DrexCloud.auth();
  auth.currentUser = uid ? { uid: String(uid), email: uid + '@x.com' } : null;
  fake.setGetUid(() => { try { const u = M.DrexCloud.auth().currentUser; return (u && u.uid) || null; } catch (e) { return null; } });
  online = true;
  return { M, fake, auth, db: () => M.DrexCloud.database() };
}
async function pollFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
}

async function scenarioA() {
  console.log('== (A) switch de cuenta con op pendiente: la op de A sobrevive a B ==');
  const { M, fake, auth, db } = boot('A');
  const outbox = M.DrexCloud._outbox;

  online = false;
  const p = db().ref('users/A/name').set('Darel');
  const st = track(p);
  await settle(3);
  check('A1 op encolada offline', outbox.pending().length === 1);
  check('A2 op etiquetada con uid de A', outbox.pending()[0] && outbox.pending()[0].uid === 'A',
    'uid=' + (outbox.pending()[0] && outbox.pending()[0].uid));

  // A cambia a B: signOut REAL (debe cancelar el retryTimer) + sesión de B.
  online = true;
  await auth.signOut();
  M.__internals.setDocClient(fake.dc); // signOut anula el docClient; B lo reconfigura al entrar
  auth.currentUser = { uid: 'B', email: 'b@x.com' };

  // El timer de backoff (o el evento online) dispara flush() bajo la sesión B.
  outbox.flush();
  await settle(8);

  const writesUnderB = fake.writes.filter(w => w.uid === 'B').length;
  check('A3 la op de A NO se ejecuta bajo la sesión de B', writesUnderB === 0,
    'writes con uid=B: ' + writesUnderB);
  check('A4 la op de A sigue encolada e intacta',
    outbox.pending().length === 1 && outbox.pending()[0].path === 'users/A/name',
    'pending=' + outbox.pending().length);
  check('A5 la promesa del set de A sigue pendiente (no resuelta ni rechazada)',
    !st.resolved && !st.rejected, 'resolved=' + st.resolved + ' rejected=' + st.rejected);

  // A vuelve: su op se vacía ahora.
  auth.currentUser = { uid: 'A', email: 'a@x.com' };
  outbox.flush();
  await p;
  await settle(6);
  check('A6 al volver A, su op se flushea y resuelve', st.resolved && st.value && st.value.flushed === true);
  check('A7 el valor quedó escrito', fake.leafVal('users', 'A/name') === 'Darel');
  check('A8 la escritura ocurrió con la sesión de A',
    fake.writes.length > 0 && fake.writes[fake.writes.length - 1].uid === 'A',
    'uids=' + JSON.stringify(fake.writes.map(w => w.uid)));
  check('A9 cola vacía', outbox.pending().length === 0);
}

async function scenarioB() {
  console.log('== (B) backoff pendiente + signOut: el timer muere, la op sobrevive ==');
  const { M, fake, auth, db } = boot('A');
  const outbox = M.DrexCloud._outbox;

  fake.failBatchWrites(100, throttlingErr()); // fallo retriable persistente
  online = false;
  const p = db().ref('users/A/status').set('hola');
  const st = track(p);
  await settle(3);
  check('B1 op encolada', outbox.pending().length === 1);

  // Primer flush: falla retriable -> tries=1 y backoff 1-2s programado.
  online = true;
  outbox.flush();
  const sawBackoff = await pollFor(() => outbox.pending().length === 1 && outbox.pending()[0].tries >= 1, 12000, 'backoff');
  check('B2 el fallo retriable programó backoff (tries>=1)', sawBackoff,
    'tries=' + (outbox.pending()[0] && outbox.pending()[0].tries));

  // Logout REAL en la ventana del backoff.
  await auth.signOut();
  M.__internals.setDocClient(fake.dc);
  fake.succeed(); // la red/DB ahora responde: si el timer disparara, se notaría
  const writesAtLogout = fake.writes.length;
  await sleep(3200); // ventana del backoff (1000-2000 ms) + margen

  check('B3 ningún intento de flush tras el logout (timer cancelado)',
    fake.writes.length === writesAtLogout,
    'writes antes=' + writesAtLogout + ' después=' + fake.writes.length);
  const q = outbox.pending();
  check('B4 la op de A sigue encolada intacta (sin dropHead silencioso)',
    q.length === 1 && q[0].path === 'users/A/status' && q[0].tries === 1,
    'pending=' + q.length);
  check('B5 la promesa sigue pendiente', !st.resolved && !st.rejected);
  void p;
}

async function scenarioC() {
  console.log('== (C) op sin dueño: el flush post-logout no ocurre ==');
  const { M, fake, auth, db } = boot(null); // sin sesión
  const outbox = M.DrexCloud._outbox;

  fake.failBatchWrites(100, throttlingErr());
  online = false;
  const p = db().ref('public/notice').set('x'); // sin sesión -> op sin uid (legacy)
  const st = track(p);
  await settle(3);
  check('C1 op encolada sin etiqueta uid', outbox.pending().length === 1 && !('uid' in outbox.pending()[0]),
    JSON.stringify(outbox.pending()[0] && Object.keys(outbox.pending()[0])));
  online = true;
  outbox.flush();
  const sawBackoff = await pollFor(() => outbox.pending().length === 1 && outbox.pending()[0].tries >= 1, 12000, 'backoff');
  check('C2 backoff programado', sawBackoff);

  await auth.signOut();
  M.__internals.setDocClient(fake.dc);
  fake.succeed();
  const writesAtLogout = fake.writes.length;
  await sleep(3200);

  // Una op sin dueño SÍ sería intentada por flush(): si el timer hubiera
  // sobrevivido, habría un write. Cero writes = el timer murió.
  check('C3 ningún intento de flush tras el logout', fake.writes.length === writesAtLogout,
    'writes antes=' + writesAtLogout + ' después=' + fake.writes.length);
  check('C4 la op sigue encolada', outbox.pending().length === 1);
  check('C5 la promesa sigue pendiente', !st.resolved && !st.rejected);
  void p;
}

async function scenarioD() {
  console.log('== (D) reseal con cola mixta: cada flush solo re-sella lo suyo ==');
  const { M, fake, auth, db } = boot('A');
  const outbox = M.DrexCloud._outbox;

  online = false;
  const rA = db().ref('communityNotes').push();
  const kAold = rA.key;
  const pA = rA.set({ text: 'de A' });
  const stA = track(pA);
  auth.currentUser = { uid: 'B', email: 'b@x.com' };
  const rB = db().ref('communityNotes').push();
  const kBold = rB.key;
  const pB = rB.set({ text: 'de B' });
  const stB = track(pB);
  await settle(3);
  check('D1 dos ops encoladas, cada una con su dueño',
    outbox.pending().length === 2 &&
    outbox.pending()[0].uid === 'A' && outbox.pending()[1].uid === 'B',
    JSON.stringify(outbox.pending().map(o => o.uid)));

  // Flush como A: procesa la suya, salta la de B sin re-sellla.
  auth.currentUser = { uid: 'A', email: 'a@x.com' };
  online = true;
  outbox.flush();
  await pA;
  await settle(8);
  check('D2 la op de A se re-selló (contrato C13 intacto para el dueño)', rA.key !== kAold,
    'key=' + rA.key + ' old=' + kAold);
  check('D3 el valor de A quedó escrito', fake.leafVal('communityNotes', rA.key + '/text') === 'de A');
  const qb = outbox.pending();
  check('D4 la op de B sigue encolada SIN re-sellar (path con la key vieja)',
    qb.length === 1 && qb[0].path === 'communityNotes/' + kBold && !qb[0].resealed,
    'path=' + (qb[0] && qb[0].path));
  check('D5 nada de B escrito todavía', fake.leafVal('communityNotes', kBold + '/text') === undefined);
  check('D6 la promesa de B sigue pendiente', !stB.resolved && !stB.rejected);

  // Flush como B: ahora sí se procesa (y se re-sella en SU flush).
  auth.currentUser = { uid: 'B', email: 'b@x.com' };
  outbox.flush();
  await pB;
  await settle(8);
  check('D7 al flushear B, su op se re-sella y se escribe', rB.key !== kBold &&
    fake.leafVal('communityNotes', rB.key + '/text') === 'de B');
  check('D8 cola vacía', outbox.pending().length === 0);
  void stA;
}

async function scenarioE() {
  console.log('== (E) coalescing con scope: cuentas distintas no se fusionan ==');
  const { M, fake, auth, db } = boot('A');
  const outbox = M.DrexCloud._outbox;

  online = false;
  const pA = db().ref('users/A/status').set('de A');
  const stA = track(pA);
  auth.currentUser = { uid: 'B', email: 'b@x.com' };
  const pB = db().ref('users/A/status').set('de B'); // MISMO path, otra cuenta
  const stB = track(pB);
  await settle(3);

  const q0 = outbox.pending();
  check('E1 dos ops encoladas (B no reemplaza la de A)',
    q0.length === 2 && q0[0].uid === 'A' && q0[1].uid === 'B' &&
    q0[0].value === 'de A' && q0[1].value === 'de B',
    JSON.stringify(q0.map(o => ({ uid: o.uid, value: o.value }))));

  // Coalescing del MISMO dueño sigue funcionando (último gana, conserva id).
  const idB = q0[1] && q0[1].id;
  const pB2 = db().ref('users/A/status').set('de B v2');
  const stB2 = track(pB2);
  await settle(3);
  const q1 = outbox.pending();
  check('E2 el segundo set de B coalesce con el primero (mismo dueño)',
    q1.length === 2 && idB !== undefined && q1[1].id === idB && q1[1].value === 'de B v2' && q1[1].uid === 'B',
    JSON.stringify(q1.map(o => ({ id: o.id, uid: o.uid, value: o.value }))));

  // Flush como B: solo la op de B corre; la de A queda intacta.
  online = true;
  outbox.flush();
  await pB; await pB2;
  await settle(6);
  check('E3 ambas promesas de B resuelven (mismo op.id)', stB.resolved && stB2.resolved);
  check('E4 el valor de B quedó escrito', fake.leafVal('users', 'A/status') === 'de B v2');
  const q2 = outbox.pending();
  check('E5 la op de A sigue intacta',
    q2.length === 1 && q2[0].uid === 'A' && q2[0].value === 'de A',
    JSON.stringify(q2.map(o => ({ uid: o.uid, value: o.value }))));
  check('E6 la promesa de A sigue pendiente', !stA.resolved && !stA.rejected);

  // Flush como A: su op corre con su valor.
  auth.currentUser = { uid: 'A', email: 'a@x.com' };
  outbox.flush();
  await pA;
  await settle(6);
  check('E7 la op de A se flushea y resuelve', stA.resolved && stA.value && stA.value.flushed === true);
  check('E8 valor final = el de A', fake.leafVal('users', 'A/status') === 'de A');
  check('E9 cola vacía', outbox.pending().length === 0);
}

async function main() {
  console.log('R5-1 scope por cuenta — módulo: ' + CLOUD);
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  await scenarioE();
  console.log(failures ? `\n${failures} FALLA(S)` : '\nTODOS OK');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
