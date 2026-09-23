'use strict';
/* H4 (ciclo 8): transactionBlind() — equivalencia con transaction() sin el re-read post-commit.
   Hipótesis a verificar:
   1. transaction() hace 1 lectura inicial + 1 escritura + 1 re-read post-commit.
   2. transactionBlind() hace 1 lectura inicial + 1 escritura, SIN re-read;
      devuelve { committed: <igual>, snapshot: null }.
   3. La semántica de `committed` es idéntica en ambos (incluido reintento ante
      ConditionalCheckFailed y el path de aborto con updateFn -> undefined).
   4. El estado final en BD es idéntico en ambos.
   El fake de DynamoDB se extiende AQUÍ (put condicional + transactWrite
   condicional); no se toca tests/helpers/fake-dynamodb.js.
   Ejecutar: node tests/test-transaction-blind.js
*/
const path = require('path');
const { makeFakeDb } = require('./helpers/fake-dynamodb.js');

global.window = global;
const { DrexCloud, __internals } = require(path.join(__dirname, '..', 'drex-cloud.js'));
const db = makeFakeDb();
__internals.setDocClient(db);
DrexCloud.configure && DrexCloud.configure({ tableName: 'drex-kv' });

// ---------- Extensión del fake: put/transactWrite condicionales ----------
const store = db._store;
const log = db._log;
function condFail(code, reasons) {
  const e = new Error(code);
  e.code = code;
  if (reasons) e.CancellationReasons = reasons;
  return e;
}
let beforePutHook = null; // el test lo arma para simular un escritor rival
db.put = function (params) {
  return {
    promise: () => new Promise((resolve, reject) => {
      setTimeout(() => {
        log.push(['put', params.Item.pk, params.Item.sk]);
        if (beforePutHook) { const h = beforePutHook; beforePutHook = null; h(); }
        const key = params.Item.pk + '\x00' + params.Item.sk;
        const cur = store.get(key);
        const cond = params.ConditionExpression || '';
        const exp = (params.ExpressionAttributeValues || {})[':exp'];
        let ok = true;
        if (cond === 'attribute_not_exists(pk) OR #v = :exp') ok = !cur || cur.v === exp;
        else if (cond === '#v = :exp') ok = !!cur && cur.v === exp;
        if (!ok) return reject(condFail('ConditionalCheckFailedException'));
        store.set(key, { pk: params.Item.pk, sk: params.Item.sk, v: params.Item.v });
        resolve({});
      }, 0);
    })
  };
};
db.transactWrite = function (params) {
  return {
    promise: () => new Promise((resolve, reject) => {
      setTimeout(() => {
        log.push(['transactWrite', (params.TransactItems || []).length]);
        const staged = [];
        const reasons = [];
        let failed = false;
        for (const ti of (params.TransactItems || [])) {
          if (ti.Put) {
            const it = ti.Put.Item;
            const key = it.pk + '\x00' + it.sk;
            const cur = store.get(key);
            const cond = ti.Put.ConditionExpression || '';
            const vals = ti.Put.ExpressionAttributeValues || {};
            let ok = true;
            if (cond === 'attribute_not_exists(pk)') ok = !cur;
            else if (cond === '#v = :old') ok = !!cur && cur.v === vals[':old'];
            reasons.push({ Code: ok ? 'None' : 'ConditionalCheckFailed' });
            if (!ok) failed = true;
            else staged.push(['put', key, { pk: it.pk, sk: it.sk, v: it.v }]);
          } else if (ti.Delete) {
            const k = ti.Delete.Key;
            const key = k.pk + '\x00' + k.sk;
            const cur = store.get(key);
            const vals = ti.Delete.ExpressionAttributeValues || {};
            const ok = !!cur && cur.v === vals[':old'];
            reasons.push({ Code: ok ? 'None' : 'ConditionalCheckFailed' });
            if (!ok) failed = true;
            else staged.push(['del', key]);
          }
        }
        if (failed) return reject(condFail('TransactionCanceledException', reasons));
        for (const [op, key, item] of staged) {
          if (op === 'put') store.set(key, item); else store.delete(key);
        }
        resolve({});
      }, 0);
    })
  };
};
// -------------------------------------------------------------------------

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  OK  ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function readOps() { return log.filter(e => e[0] === 'query' || e[0] === 'get').length; }
function writeOps() { return log.filter(e => e[0] === 'put' || e[0] === 'transactWrite').length; }
function resetLog() { log.length = 0; }
async function leafVal(pk, sk) {
  return DrexCloud.database().ref(pk + '/' + sk).once('value').then(s => s.val());
}

async function main() {
  console.log('[1] Escalar: transaction() devuelve snapshot fresco + hace re-read');
  db._put('counters', 'n', 5);
  resetLog();
  const r1 = await DrexCloud.database().ref('counters/n').transaction(c => (c || 0) + 1);
  const readsFull = readOps(), writesFull = writeOps();
  check('committed === true', r1.committed === true);
  check('snapshot.val() === 6', r1.snapshot && r1.snapshot.val() === 6, JSON.stringify(r1.snapshot && r1.snapshot.val()));
  check('BD quedó en 6', (await leafVal('counters', 'n')) === 6);
  check('1 escritura', writesFull === 1, 'writes=' + writesFull);
  check('2 lecturas (inicial + re-read post-commit)', readsFull === 4, 'reads=' + readsFull);
  // readLeaves = begins_with query + get exacto = 2 ops por lectura

  console.log('[2] Escalar: transactionBlind() omite el re-read, mismo commit');
  resetLog();
  const r2 = await DrexCloud.database().ref('counters/n').transactionBlind(c => (c || 0) + 1);
  const readsBlind = readOps(), writesBlind = writeOps();
  check('committed === true', r2.committed === true);
  check('snapshot === null', r2.snapshot === null);
  check('BD quedó en 7 (idéntico estado final)', (await leafVal('counters', 'n')) === 7);
  check('1 escritura', writesBlind === 1, 'writes=' + writesBlind);
  check('solo la lectura inicial (2 ops menos que transaction)', readsBlind === readsFull - 2,
        'blind=' + readsBlind + ' full=' + readsFull);

  console.log('[3] Objeto multi-hoja: equivalencia + ahorro del re-read del subárbol');
  db._put('chatUnread', 'u1/convo1/c', 2);
  db._put('chatUnread', 'u1/convo1/r', 100);
  resetLog();
  const r3 = await DrexCloud.database().ref('chatUnread/u1/convo1')
    .transaction(cur => ({ c: (cur.c || 0) + 1, r: cur.r }));
  const readsFullO = readOps();
  check('committed === true', r3.committed === true);
  check('snapshot.val().c === 3', r3.snapshot && r3.snapshot.val() && r3.snapshot.val().c === 3);
  resetLog();
  const r4 = await DrexCloud.database().ref('chatUnread/u1/convo1')
    .transactionBlind(cur => ({ c: (cur.c || 0) + 1, r: cur.r }));
  const readsBlindO = readOps();
  check('committed === true', r4.committed === true);
  check('snapshot === null', r4.snapshot === null);
  const finalObj = await DrexCloud.database().ref('chatUnread/u1/convo1').once('value').then(s => s.val());
  check('BD: c === 4 y r intacto', finalObj && finalObj.c === 4 && finalObj.r === 100, JSON.stringify(finalObj));
  check('blind ahorra el re-read del subárbol', readsBlindO === readsFullO - 2,
        'blind=' + readsBlindO + ' full=' + readsFullO);

  console.log('[4] Aborto (updateFn -> undefined): idéntico en ambos, sin escritura');
  db._put('usernames', 'taken', 'uidOtro');
  resetLog();
  const a1 = await DrexCloud.database().ref('usernames/taken')
    .transaction(cur => (cur === null ? 'uidMio' : undefined));
  const wA1 = writeOps();
  resetLog();
  const a2 = await DrexCloud.database().ref('usernames/taken')
    .transactionBlind(cur => (cur === null ? 'uidMio' : undefined));
  const wA2 = writeOps();
  check('transaction aborta: committed === false', a1.committed === false);
  check('transactionBlind aborta: committed === false', a2.committed === false);
  check('ninguno escribió (BD intacta)', wA1 === 0 && wA2 === 0 &&
        (await leafVal('usernames', 'taken')) === 'uidOtro');

  console.log('[5] Contención: el reintento ante ConditionalCheckFailed se conserva');
  for (const [label, fn] of [['transaction', (ref, u) => ref.transaction(u)],
                             ['transactionBlind', (ref, u) => ref.transactionBlind(u)]]) {
    db._put('counters', 'race', 10);
    // Escritor rival: muta la hoja justo antes del primer put condicional.
    beforePutHook = () => db._put('counters', 'race', 11);
    resetLog();
    const rr = await fn(DrexCloud.database().ref('counters/race'), c => (c || 0) + 1);
    check(label + ': committed === true tras reintentar', rr.committed === true);
    check(label + ': 2 puts (1 fallido + 1 exitoso)', writeOps() === 2, 'writes=' + writeOps());
    const expectSnap = label === 'transaction' ? 12 : null;
    const gotSnap = rr.snapshot ? rr.snapshot.val() : null;
    check(label + ': snapshot ' + (expectSnap === null ? 'null' : 'fresco (12)'),
          gotSnap === expectSnap, 'got=' + JSON.stringify(gotSnap));
    check(label + ': BD quedó en 12', (await leafVal('counters', 'race')) === 12);
  }

  console.log('[6] onComplete en blind recibe (null, committed, null)');
  db._put('counters', 'cb', 0);
  let cbArgs = null;
  const r6 = await DrexCloud.database().ref('counters/cb')
    .transactionBlind(c => (c || 0) + 1, (err, committed, snap) => { cbArgs = [err, committed, snap]; });
  check('onComplete: err null', cbArgs && cbArgs[0] === null);
  check('onComplete: committed true', cbArgs && cbArgs[1] === true);
  check('onComplete: snap null', cbArgs && cbArgs[2] === null);
  check('promesa resuelve {committed:true, snapshot:null}',
        r6.committed === true && r6.snapshot === null);

  console.log(failures === 0 ? 'PASS: transactionBlind equivale a transaction sin el re-read' :
              'FAIL: ' + failures + ' fallos');
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('ERROR no esperado:', e); process.exit(2); });
