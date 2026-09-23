'use strict';
/* PERF 2026-09-23 (ciclo 7, H1) — test del chat de fiestas acotado.
 * Verifica que ref('fiestas/<id>/chat').limitToLast(50) (oyente child_added
 * de la sala, polling cada 3 s) YA NO descarga TODO el chat en cada ciclo,
 * sino que usa la rama acotada de 3 segmentos (prefijo compuesto '<id>/chat').
 * Usa un DocumentClient falso inyectado vía __internals.setDocClient.
 * Ejecutar con: node tests/test-fiesta-chat-bounded.js
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
const F1 = 'f1', F2 = 'f2', F3 = 'f3';
const N_F1 = 1500, N_F2 = 30, N_F3 = 20;
const FIELDS = ['uid', 'name', 'photo', 'text', 'ts']; // 5 hojas por mensaje (real)

function pushKey(i) { return I.pushIdLowerBound(BASE_TS + i * 1000); }
const f1Keys = [];
for (let i = 0; i < N_F1; i++) {
  const k = pushKey(i);
  f1Keys.push(k);
  const val = { uid: 'u' + (i % 40), name: 'Usuario ' + (i % 40), photo: 'https://x/y.png', text: 'mensaje número ' + i + ' hola', ts: BASE_TS + i * 1000 };
  FIELDS.forEach(f => items.push({ pk: 'fiestas', sk: F1 + '/chat/' + k + '/' + f, v: JSON.stringify(val[f]) }));
}
// Hojas de la fiesta que NO son del chat (no deben leerse ni filtrarse mal)
[['title', 'Fiesta de prueba'], ['status', 'live'], ['hostId', 'u1'], ['maxSpeakers', 8]].forEach(([f, v]) =>
  items.push({ pk: 'fiestas', sk: F1 + '/' + f, v: JSON.stringify(v) }));
// Otra fiesta: aislamiento de prefijo
for (let i = 0; i < N_F2; i++) {
  const k = pushKey(i);
  FIELDS.forEach(f => items.push({ pk: 'fiestas', sk: F2 + '/chat/' + k + '/' + f, v: JSON.stringify('otro' + i) }));
}
// Fiesta pequeña (< 50 mensajes): sin regresión
const f3Keys = [];
for (let i = 0; i < N_F3; i++) {
  const k = pushKey(i);
  f3Keys.push(k);
  FIELDS.forEach(f => items.push({ pk: 'fiestas', sk: F3 + '/chat/' + k + '/' + f, v: JSON.stringify('p' + i) }));
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

let itemsRead = 0, bytesRead = 0;
const origQuery = fakeClient.query;
fakeClient.query = function (p) {
  const r = origQuery(p);
  const origPromise = r.promise;
  r.promise = function () {
    return origPromise().then(res => {
      (res.Items || []).forEach(it => {
        itemsRead++;
        bytesRead += Buffer.byteLength(it.sk || '', 'utf8') + Buffer.byteLength(it.v || '', 'utf8');
      });
      return res;
    });
  };
  return r;
};

// Réplica fiel del camino VIEJO (antes del fix): la rama final de readLeaves
// para 3 segmentos — begins_with completo sobre '<id>/chat/' + get exacto.
async function readLeavesBefore() {
  const out = [];
  let lek = null;
  do {
    const p = {
      TableName: 'drex-kv',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :pfx)',
      ExpressionAttributeValues: { ':pk': 'fiestas', ':pfx': F1 + '/chat/' },
    };
    if (lek) p.ExclusiveStartKey = lek;
    const res = await fakeClient.query(p).promise();
    (res.Items || []).forEach(it => out.push({ sk: it.sk, v: it.v }));
    lek = res.LastEvaluatedKey || null;
  } while (lek);
  await fakeClient.get({ TableName: 'drex-kv', Key: { pk: 'fiestas', sk: F1 + '/chat' } }).promise();
  return out;
}

function newestKeys(n) { return f1Keys.slice(N_F1 - n).sort(); }

async function main() {
  // 0. ANTES: descarga completa del chat (línea base del costo por ciclo)
  calls.length = 0; itemsRead = 0; bytesRead = 0;
  const beforeLeaves = await readLeavesBefore();
  const beforeItems = itemsRead, beforeBytes = bytesRead;
  check('0. baseline "antes": lee TODO el chat (' + beforeItems + ' items, ' + (beforeBytes / 1024).toFixed(1) + ' KB)',
    beforeItems === N_F1 * FIELDS.length, 'got ' + beforeItems);

  // 1. DESPUÉS: readLeaves real con limitToLast(50) sobre 3 segmentos
  calls.length = 0; itemsRead = 0; bytesRead = 0;
  const leaves = await I.readLeaves(['fiestas', F1, 'chat'], { limitLast: 50 });
  const afterItems = itemsRead, afterBytes = bytesRead;
  check('1a. lee muchos menos items que antes (' + afterItems + ' < ' + beforeItems + ')', afterItems < beforeItems);
  const fullScans = calls.filter(c => !c.GetItem && (c.KeyConditionExpression || '').includes('begins_with') && c.ProjectionExpression !== 'sk');
  check('1b. ningún begins_with sin proyección sk (sin descarga completa)', fullScans.length === 0, JSON.stringify(fullScans.length));
  check('1c. reducción >= 5x en items (' + (beforeItems / afterItems).toFixed(1) + 'x)',
    beforeItems / afterItems >= 5, (beforeItems / afterItems).toFixed(2) + 'x');

  // 2. Correctitud: los 50 más nuevos, idénticos al camino viejo + applyQuery
  const val = I.unflatten(leaves, ['fiestas', F1, 'chat']);
  const trimmed = I.applyQuery(val, { limitLast: 50 });
  const gotKeys = Object.keys(trimmed).sort();
  check('2a. applyQuery deja exactamente los 50 mensajes más nuevos',
    JSON.stringify(gotKeys) === JSON.stringify(newestKeys(50)), 'got ' + gotKeys.length);
  const beforeVal = {};
  beforeLeaves.forEach(l => {
    const rel = l.sk.slice((F1 + '/chat/').length).split('/');
    (beforeVal[rel[0]] = beforeVal[rel[0]] || {})[rel[1]] = JSON.parse(l.v);
  });
  const beforeTrimmed = I.applyQuery(beforeVal, { limitLast: 50 });
  check('2b. paridad con el camino viejo (mismas 50 claves)',
    JSON.stringify(Object.keys(beforeTrimmed).sort()) === JSON.stringify(gotKeys));
  const sampleNewest = trimmed[f1Keys[N_F1 - 1]];
  check('2c. el mensaje más nuevo trae sus 5 campos',
    sampleNewest && sampleNewest.text === 'mensaje número ' + (N_F1 - 1) + ' hola' && sampleNewest.ts === BASE_TS + (N_F1 - 1) * 1000,
    JSON.stringify(sampleNewest));

  // 3. Aislamiento: nada de otra fiesta ni de hojas no-chat
  const badSegs = leaves.filter(l => !(l.segs.length === 5 && l.segs[0] === 'fiestas' && l.segs[1] === F1 && l.segs[2] === 'chat'));
  check('3a. todas las hojas son fiestas/f1/chat/<pushId>/<campo>', badSegs.length === 0, JSON.stringify(badSegs.slice(0, 2)));
  const fromF2 = leaves.filter(l => l.segs[1] === F2);
  check('3b. nada del chat de otra fiesta', fromF2.length === 0);

  // 4. Fiesta pequeña (< 50 mensajes): mismo resultado que antes, sin regresión
  calls.length = 0; itemsRead = 0;
  const small = await I.readLeaves(['fiestas', F3, 'chat'], { limitLast: 50 });
  const smallVal = I.applyQuery(I.unflatten(small, ['fiestas', F3, 'chat']), { limitLast: 50 });
  check('4. chat pequeño: trae los 20 mensajes completos (' + Object.keys(smallVal).length + ')',
    Object.keys(smallVal).sort().join(',') === f3Keys.slice().sort().join(','));

  // 5. Números para el reporte: RCU aproximadas (lectura eventual: 1 RCU / 4 KB)
  const rcu = b => Math.ceil(b / 4096);
  console.log('\n--- costo por ciclo de polling (3 s) ---');
  console.log('ANTES: ' + beforeItems + ' items, ' + (beforeBytes / 1024).toFixed(1) + ' KB ≈ ' + rcu(beforeBytes) + ' RCU/ciclo');
  console.log('DESPUÉS: ' + afterItems + ' items, ' + (afterBytes / 1024).toFixed(1) + ' KB ≈ ' + rcu(afterBytes) + ' RCU/ciclo');
  console.log('Reducción: ' + (beforeItems / afterItems).toFixed(1) + 'x en items, ' + (rcu(beforeBytes) / rcu(afterBytes)).toFixed(1) + 'x en RCU');
  console.log('Proyección 1 h/participante: ANTES ≈ ' + (rcu(beforeBytes) * 1200).toLocaleString('en-US') +
    ' RCU → DESPUÉS ≈ ' + (rcu(afterBytes) * 1200).toLocaleString('en-US') + ' RCU');

  console.log(failures === 0 ? '\nTODOS LOS TESTS OK' : '\n' + failures + ' FALLOS');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
