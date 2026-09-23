'use strict';
/* PERF 2026-09-23 (ciclo 11) — test de regresión del tope de ventana server-side
 * en fase 1 de readLeavesBoundedPrefix cuando hay endAt ("cargar anteriores").
 *
 * Sin el tope, la fase 1 escaneaba desde el hijo MÁS NUEVO y el filtro
 * `child > endKey` solo se aplicaba en cliente: con 20k comentarios y cursor
 * en el #1000 se leían 57,540 sk en 137 páginas para traer 32 comentarios.
 * Con el tope (`sk < :endBound` = prefix+endKey+U+FFFF), DynamoDB poda en el
 * servidor y la fase 1 lee ~want*leaves en 1 página.
 *
 * Verifica:
 *  1. "Cargar anteriores" profundo (2 segmentos, postComments): coste acotado.
 *  2. Corrección: llegan EXACTAMENTE los 32 hijos #969..#1000 (endAt inclusivo).
 *  3. Rama de 3 segmentos (fiestas/<id>/chat) con endAt: también acotada.
 *  4. Aislamiento: los hijos de otro prefijo no se cuelan.
 *  5. Sin endAt: el comportamiento no cambia (la cota no se aplica).
 * Ejecutar con: node tests/test-c11-bounded-prefix-window.js
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
const stats = { p1items: 0, p1pages: 0 }; // solo fase 1 (begins_with + ProjectionExpression sk)
const BASE_TS = 1750000000000;
function cmpSk(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
function pushKey(i) { return I.pushIdLowerBound(BASE_TS + i * 1000); }

function seedComments(pk, nid, n, fields) {
  const keys = [];
  for (let i = 0; i < n; i++) {
    const k = pushKey(i); keys.push(k);
    fields.forEach(f => items.push({ pk, sk: nid + '/' + k + '/' + f, v: JSON.stringify(f + '#' + i) }));
  }
  return keys;
}
function seedFiestaChat(fid, n) {
  const keys = [];
  const F = ['uid', 'name', 'photo', 'text', 'ts'];
  for (let i = 0; i < n; i++) {
    const k = pushKey(i); keys.push(k);
    F.forEach(f => items.push({ pk: 'fiestas', sk: fid + '/chat/' + k + '/' + f, v: JSON.stringify(f + '#' + i) }));
  }
  return keys;
}

function runQuery(params) {
  const vals = params.ExpressionAttributeValues || {};
  let arr = items.filter(it => it.pk === vals[':pk']);
  const kc = params.KeyConditionExpression || '';
  if (kc.indexOf('begins_with(sk, :pfx)') >= 0 && kc.indexOf('sk < :endBound') >= 0) {
    arr = arr.filter(it => it.sk.indexOf(vals[':pfx']) === 0 && it.sk < vals[':endBound']);
  } else if (kc.indexOf('begins_with(sk, :pfx)') >= 0) {
    arr = arr.filter(it => it.sk.indexOf(vals[':pfx']) === 0);
  } else if (kc.indexOf('sk BETWEEN :lo AND :hi') >= 0) {
    arr = arr.filter(it => it.sk >= vals[':lo'] && it.sk <= vals[':hi']);
  } else throw new Error('KC no soportada en el test: ' + kc);
  arr.sort((a, b) => params.ScanIndexForward === false ? cmpSk(b.sk, a.sk) : cmpSk(a.sk, b.sk));
  if (params.ExclusiveStartKey) {
    const ix = arr.findIndex(it => it.sk === params.ExclusiveStartKey.sk);
    arr = ix >= 0 ? arr.slice(ix + 1) : [];
  }
  let lek = null;
  if (params.Limit && arr.length > params.Limit) {
    const pg = arr.slice(0, params.Limit);
    lek = { pk: pg[pg.length - 1].pk, sk: pg[pg.length - 1].sk };
    arr = pg;
  }
  const isP1 = kc.indexOf('begins_with') >= 0 && params.ProjectionExpression === 'sk';
  if (isP1) { stats.p1items += arr.length; stats.p1pages++; }
  const out = arr.map(it => (params.ProjectionExpression === 'sk' ? { sk: it.sk } : { pk: it.pk, sk: it.sk, v: it.v }));
  const res = { Items: out };
  if (lek) res.LastEvaluatedKey = lek;
  return Promise.resolve(res);
}
I.setDocClient({
  query(params) { return { promise() { return runQuery(params); } }; },
  get() { return { promise() { return Promise.resolve({ Item: null }); } }; },
});

async function readPage(segs, query) {
  stats.p1items = 0; stats.p1pages = 0;
  const leaves = await I.readLeaves(segs, query);
  const val = I.unflatten(leaves, segs);
  const out = I.applyQuery(val, query);
  return { out, p1items: stats.p1items, p1pages: stats.p1pages };
}

async function main() {
  const FIELDS = ['authorId', 'text', 'ts'];

  // 1+2. Cargar anteriores profundo: 20k comentarios, cursor en el #1000, limit 32
  const keysA = seedComments('postComments', 'notaA', 20000, FIELDS);
  // aislamiento: otra nota con 5k comentarios
  seedComments('postComments', 'notaB', 5000, FIELDS);
  let r = await readPage(['postComments', 'notaA'], { limitLast: 32, orderByKey: true, endAt: keysA[1000] });
  const gotKeys = Object.keys(r.out || {});
  const wantKeys = keysA.slice(1000 - 31, 1001);
  check('A. fase 1 acotada: <= 2 páginas (era 137)', r.p1pages <= 2, r.p1pages + ' págs, ' + r.p1items + ' items');
  check('A. fase 1 lee < 5% del historial tras el cursor (era 57,540 sk)',
    r.p1items < 0.05 * (20000 - 1000) * FIELDS.length, r.p1items + ' items');
  check('A. llegan exactamente 32 hijos', gotKeys.length === 32, gotKeys.length + ' hijos');
  check('A. son los hijos #969..#1000 (endAt inclusivo)',
    JSON.stringify(gotKeys) === JSON.stringify(wantKeys));
  check('A. aislamiento: ningún hijo de notaB', gotKeys.every(k => wantKeys.indexOf(k) >= 0));

  // 3. Rama de 3 segmentos (fiestas/<id>/chat) con endAt profundo
  const keysF = seedFiestaChat('fiestaF', 5000);
  r = await readPage(['fiestas', 'fiestaF', 'chat'], { limitLast: 50, endAt: keysF[500] });
  const gotF = Object.keys(r.out || {});
  check('B. fiesta 3-seg con endAt: fase 1 en 1 página (era 38)', r.p1pages <= 2, r.p1pages + ' págs');
  check('B. fiesta 3-seg: 50 mensajes #451..#500',
    gotF.length === 50 && JSON.stringify(gotF) === JSON.stringify(keysF.slice(451, 501)));

  // 5. Sin endAt: la cota no se aplica (mismo coste que antes del cambio)
  r = await readPage(['postComments', 'notaA'], { limitLast: 32, orderByKey: true });
  check('C. sin endAt: fase 1 sin tope (420 items = Limit max(100, 42*10), 1 pág)',
    r.p1items === 420 && r.p1pages === 1, r.p1items + ' items/' + r.p1pages + ' págs');
  const gotC = Object.keys(r.out || {});
  check('C. sin endAt: últimos 32 (#19969..#19999)',
    gotC.length === 32 && gotC[0] === keysA[19968] && gotC[31] === keysA[19999]);

  console.log(failures === 0 ? 'TODOS LOS TESTS OK' : failures + ' FALLOS');
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('ERROR:', e); process.exit(1); });
