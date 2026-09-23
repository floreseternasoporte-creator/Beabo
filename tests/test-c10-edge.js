'use strict';
// Casos borde de OPT-1 (fusión begins_with+get) y OPT-6 (piggyback en fireListener).
// Ciclo 10, rendimiento. Uso: node tests/test-c10-edge.js  (cwd = src/)
process.chdir(__dirname + '/..');
const { DrexCloud, __internals: I } = require('../drex-cloud.js');
const { makeFakeDb } = require('./helpers/fake-dynamodb.js');
const raw = makeFakeDb();
let ops = 0;
const fake = {
  query(p) { ops++; return raw.query(p); },
  get(p) { ops++; return raw.get(p); },
  batchWrite(p) { ops++; return raw.batchWrite(p); },
  transactWrite(p) { return raw.transactWrite(p); }
};
I.setDocClient(fake);
const db = () => DrexCloud.database();
let fails = 0;
function ok(cond, label) { console.log((cond ? 'OK   ' : 'FAIL ') + label); if (!cond) fails++; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  // OPT-1a: nodo con valor exacto E hijos: antes (hijos primero, exacto al
  // final) ganaba el exacto; el orden se conserva.
  await db().ref('mix/node').set(5);
  await db().ref('mix/node/child').set(9);
  const v1 = (await db().ref('mix/node').once('value')).val();
  ok(v1 === 5, 'OPT-1a mix exacto+hijos -> gana exacto (orden previo): ' + JSON.stringify(v1));

  // OPT-1b: solo hijos
  await db().ref('only/kids').set({ a: 1, b: 2 });
  const v2 = (await db().ref('only/kids').once('value')).val();
  ok(v2 && v2.a === 1 && v2.b === 2, 'OPT-1b solo hijos: ' + JSON.stringify(v2));

  // OPT-1c: solo exacto
  await db().ref('solo/exacto').set('hola');
  const v3 = (await db().ref('solo/exacto').once('value')).val();
  ok(v3 === 'hola', 'OPT-1c solo exacto: ' + JSON.stringify(v3));

  // OPT-1d: inexistente
  const v4 = (await db().ref('nada/aqui').once('value')).val();
  ok(v4 === null, 'OPT-1d inexistente -> null: ' + JSON.stringify(v4));

  // OPT-1e: una sola op para lectura puntual (antes 2: begins_with + get)
  ops = 0;
  await db().ref('solo/exacto').once('value');
  ok(ops === 1, 'OPT-1e lectura puntual = 1 op: ' + ops);

  // OPT-6a: 3 on() sincrónicos sobre el mismo grupo -> 1 lectura inicial,
  // y los 3 reciben su dispatch.
  await db().ref('grp/x').set({ m: 1 });
  ops = 0;
  let c1 = 0, c2 = 0, c3 = 0;
  const o1 = db().ref('grp/x').on('value', () => { c1++; });
  const o2 = db().ref('grp/x').on('value', () => { c2++; });
  const o3 = db().ref('grp/x').on('value', () => { c3++; });
  await sleep(300);
  ok(ops === 1, 'OPT-6a 3 on() mismo grupo = 1 lectura: ' + ops);
  ok(c1 === 1 && c2 === 1 && c3 === 1, 'OPT-6a los 3 reciben el valor: ' + [c1, c2, c3].join(','));

  // OPT-6b: off() durante la lectura en vuelo -> el dado de baja no recibe nada.
  ops = 0;
  let c4 = 0, c5 = 0;
  const o4 = db().ref('grp/slow').on('value', () => { c4++; });
  const o5 = db().ref('grp/slow').on('value', () => { c5++; });
  o5(); // baja inmediata, antes de que complete la lectura
  await db().ref('grp/slow').set({ z: 2 });
  await sleep(400); // cubre el eco local de 120 ms
  ok(c5 === 0 && c4 === 2, 'OPT-6b baja en vuelo no recibe dispatch (c4=' + c4 + ' c5=' + c5 + ')');
  o1(); o2(); o3(); o4();
  await sleep(100);

  // OPT-6c: grupos distintos no se mezclan.
  ops = 0;
  let da = null, dbb = null;
  const oa = db().ref('ga/v').on('value', s => { da = s.val(); });
  const ob = db().ref('gb/v').on('value', s => { dbb = s.val(); });
  await db().ref('ga/v').set('A'); await db().ref('gb/v').set('B');
  await sleep(400);
  ok(ops >= 2 && da === 'A' && dbb === 'B',
    'OPT-6c grupos distintos independientes: ops=' + ops + ' da=' + da + ' db=' + dbb);
  oa(); ob();
  await sleep(100);

  console.log(fails === 0 ? 'EDGE OK' : fails + ' FALLOS');
  process.exit(fails === 0 ? 0 : 1);
}
main().catch(e => { console.error('ERROR:', e); process.exit(1); });
