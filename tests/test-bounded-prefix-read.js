'use strict';
/* PERF 2026-09-23 — test de la lectura acotada bajo prefijo (readLeavesBoundedPrefix).
 * Verifica que ref('conversationMessages/<id>').limitToLast(80) YA NO descarga
 * la conversación completa en cada lectura, sino solo los hijos más nuevos.
 * Usa un DocumentClient falso inyectado vía __internals.setDocClient.
 * Ejecutar con: node tests/test-bounded-prefix-read.js
 */
const path = require('path');
const { __internals: I } = require(path.join(__dirname, '..', 'drex-cloud.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

// --- Tabla falsa -----------------------------------------------------------
const items = []; // {pk, sk, v}
const calls = []; // params de cada query/get
const BASE_TS = 1750000000000;
const N_CONV1 = 2000, N_CONV2 = 50, LEAVES = 10; // LEAVES ~ realista (texto, autor, ts, tipo, estado...)

function pushKey(i) { return I.pushIdLowerBound(BASE_TS + i * 1000); }
const conv1Keys = []; // índice i -> pushId (i=0 el más viejo)
for (let i = 0; i < N_CONV1; i++) {
  const k = pushKey(i);
  conv1Keys.push(k);
  for (let l = 0; l < LEAVES; l++) {
    items.push({ pk: 'conversationMessages', sk: 'conv1/' + k + '/f' + l, v: JSON.stringify('v' + i + '_' + l) });
  }
}
for (let i = 0; i < N_CONV2; i++) {
  const k = pushKey(i);
  for (let l = 0; l < LEAVES; l++) {
    items.push({ pk: 'conversationMessages', sk: 'conv2/' + k + '/f' + l, v: JSON.stringify('w' + i + '_' + l) });
  }
}
// userConversations para el test de exclusión (claves NO push ID)
for (let i = 0; i < 60; i++) {
  items.push({ pk: 'userConversations', sk: 'u1/conv' + i + '/updatedAt', v: JSON.stringify(BASE_TS + i) });
}

function cmpSk(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

const fakeClient = {
  query(params) {
    calls.push(params);
    return {
      promise() {
        const vals = params.ExpressionAttributeValues || {};
        let arr = items.filter(it => it.pk === vals[':pk']);
        const kc = params.KeyConditionExpression || '';
        if (kc.includes('begins_with(sk, :pfx)')) {
          arr = arr.filter(it => it.sk.indexOf(vals[':pfx']) === 0);
        } else if (kc.includes('sk BETWEEN :lo AND :hi')) {
          arr = arr.filter(it => it.sk >= vals[':lo'] && it.sk <= vals[':hi']);
        } else if (kc.includes('sk < :endSk')) {
          arr = arr.filter(it => it.sk < vals[':endSk']);
        }
        arr.sort((a, b) => params.ScanIndexForward === false ? cmpSk(b.sk, a.sk) : cmpSk(a.sk, b.sk));
        if (params.ExclusiveStartKey) {
          const esk = params.ExclusiveStartKey.sk;
          const idx = arr.findIndex(it => it.sk === esk);
          arr = idx >= 0 ? arr.slice(idx + 1) : [];
        }
        let lek = null;
        if (params.Limit && arr.length > params.Limit) {
          const page = arr.slice(0, params.Limit);
          lek = { pk: page[page.length - 1].pk, sk: page[page.length - 1].sk };
          arr = page;
        }
        const proj = params.ProjectionExpression === 'sk';
        const out = arr.map(it => (proj ? { sk: it.sk } : { pk: it.pk, sk: it.sk, v: it.v }));
        const res = { Items: out };
        if (lek) res.LastEvaluatedKey = lek;
        return Promise.resolve(res);
      }
    };
  },
  get(params) {
    calls.push({ GetItem: true, Key: params.Key });
    return { promise() { return Promise.resolve({ Item: null }); } };
  }
};
I.setDocClient(fakeClient);

let itemsRead = 0;
const origQuery = fakeClient.query;
fakeClient.query = function (p) {
  const r = origQuery(p);
  const origPromise = r.promise;
  r.promise = function () { return origPromise().then(res => { itemsRead += (res.Items || []).length; return res; }); };
  return r;
};

function childKeysOf(leaves) {
  const set = {};
  leaves.forEach(l => { set[l.segs[2]] = 1; });
  return Object.keys(set);
}
function newestKeys(n) { return conv1Keys.slice(N_CONV1 - n).reverse(); } // más nuevos primero

async function main() {
  // 1. limitToLast(80) sin orderBy: acotado y correcto
  calls.length = 0; itemsRead = 0;
  const leaves = await I.readLeaves(['conversationMessages', 'conv1'], { limitLast: 80 });
  const unbounded = N_CONV1 * LEAVES; // 1200: lo que leía ANTES
  check('1a. lee menos items que la conversación completa (' + itemsRead + ' < ' + unbounded + ')', itemsRead < unbounded);
  const fullScans = calls.filter(c => !c.GetItem && (c.KeyConditionExpression || '').includes('begins_with') && c.ProjectionExpression !== 'sk');
  check('1b. ningún begins_with sin proyección sk (sin descarga completa)', fullScans.length === 0, JSON.stringify(fullScans.length));
  const keys = childKeysOf(leaves).sort();
  const exp = newestKeys(90).sort(); // want = 80 + 10 (sin margen skew: orden por clave)
  check('1c. trae exactamente los 90 hijos más nuevos', JSON.stringify(keys) === JSON.stringify(exp),
    'got ' + keys.length + ' hijos');
  // applyQuery recorta a 80 como haría readRefValue
  const val = I.unflatten(leaves, ['conversationMessages', 'conv1']);
  const trimmed = I.applyQuery(val, { limitLast: 80 });
  const tkeys = Object.keys(trimmed).sort();
  check('1d. applyQuery deja los 80 más nuevos', JSON.stringify(tkeys) === JSON.stringify(newestKeys(80).sort()),
    'got ' + tkeys.length);
  const other = leaves.filter(l => l.segs[1] === 'conv2');
  check('1e. aislamiento de prefijo: nada de conv2', other.length === 0);

  // 2. orderByKey + limitToLast: mismo resultado exacto
  calls.length = 0; itemsRead = 0;
  const leaves2 = await I.readLeaves(['conversationMessages', 'conv1'], { limitLast: 80, orderByKey: true });
  const val2 = I.unflatten(leaves2, ['conversationMessages', 'conv1']);
  const t2 = I.applyQuery(val2, { limitLast: 80, orderByKey: true });
  check('2. orderByKey().limitToLast(80) da los 80 más nuevos',
    JSON.stringify(Object.keys(t2).sort()) === JSON.stringify(newestKeys(80).sort()));

  // 3. endAt (paginación de comentarios): solo hijos <= cursor
  calls.length = 0;
  const cursor = conv1Keys[N_CONV1 - 300]; // el hijo #300 desde el más nuevo
  const leaves3 = await I.readLeaves(['conversationMessages', 'conv1'], { limitLast: 80, orderByKey: true, endAt: cursor });
  const k3 = childKeysOf(leaves3).sort();
  // los 90 hijos más nuevos con clave <= cursor:
  const exp3b = [];
  for (let i = N_CONV1 - 300; i > N_CONV1 - 300 - 90 && i >= 0; i--) exp3b.push(conv1Keys[i]);
  check('3. endAt acota por arriba: 90 hijos terminando en el cursor',
    JSON.stringify(k3) === JSON.stringify(exp3b.sort()), 'got ' + k3.length);

  // 4. Exclusión de seguridad: orderByChild('updatedAt') conserva lectura completa
  calls.length = 0; itemsRead = 0;
  await I.readLeaves(['userConversations', 'u1'], { limitLast: 20, orderBy: 'updatedAt' });
  const full = calls.filter(c => !c.GetItem && (c.KeyConditionExpression || '').includes('begins_with') && c.ProjectionExpression !== 'sk');
  check('4. orderBy updatedAt NO usa la rama acotada (claves no push ID)', full.length > 0);

  // 5. Sin query: lectura de prefijo intacta (chatUnread y cía.)
  calls.length = 0;
  const leaves5 = await I.readLeaves(['conversationMessages', 'conv2']);
  check('5. sin query trae el prefijo completo (' + leaves5.length + ' hojas)', leaves5.length === N_CONV2 * LEAVES);

  console.log(failures === 0 ? '\nTODOS LOS TESTS OK' : '\n' + failures + ' FALLOS');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
