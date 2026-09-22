'use strict';
/* Prueba de la capa de datos de perfiles (drex-cloud.js) con DynamoDB falso.
   Hipótesis a verificar:
   1. ref('users/<uid>').once('value') nunca mezcla atributos entre usuarios.
   2. Carrera A-lento / B-rápido: cada promesa resuelve con SU usuario.
   3. Búsqueda por prefijo usernames/: solo devuelve el prefijo pedido.
   4. Lectura exacta usernames/<nombre> -> uid correcto.
   Ejecutar: node tests/test-profile-data-isolation.js
*/
const path = require('path');
const { makeFakeDb } = require('./helpers/fake-dynamodb.js');

global.window = global;
const { DrexCloud, __internals } = require(path.join(__dirname, '..', 'drex-cloud.js'));

const db = makeFakeDb();
__internals.setDocClient(db);
DrexCloud.configure && DrexCloud.configure({ tableName: 'drex-kv' });

// Sembrar dos usuarios con atributos separados (esquema real: un item por atributo)
db._put('users', 'uidA/username', 'alice');
db._put('users', 'uidA/profileImage', 'https://img/a.png');
db._put('users', 'uidA/bio', 'bio de alice');
db._put('users', 'uidB/username', 'bob');
db._put('users', 'uidB/profileImage', 'https://img/b.png');
db._put('users', 'uidB/bio', 'bio de bob');
// Índice usernames/
db._put('usernames', 'alice', 'uidA');
db._put('usernames', 'alina', 'uidC');
db._put('usernames', 'bob', 'uidB');
db._put('usernames', 'bobby', 'uidD');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  OK  ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

async function main() {
  console.log('[1] Lectura aislada por uid');
  const a = await DrexCloud.database().ref('users/uidA').once('value').then(s => s.val());
  const b = await DrexCloud.database().ref('users/uidB').once('value').then(s => s.val());
  check('uidA.username == alice', a && a.username === 'alice', JSON.stringify(a));
  check('uidA.profileImage es de A', a && a.profileImage === 'https://img/a.png');
  check('uidA no tiene datos de B', a && a.bio === 'bio de alice');
  check('uidB.username == bob', b && b.username === 'bob', JSON.stringify(b));
  check('uidB.profileImage es de B', b && b.profileImage === 'https://img/b.png');

  console.log('[2] Carrera: A lento (300ms) vs B rápido (10ms)');
  db._addDelayRule((kind, p) => {
    const s = JSON.stringify(p.ExpressionAttributeValues || {}) + '|' + ((p.Key && p.Key.sk) || '');
    return s.includes('uidA');
  }, 300);
  db._addDelayRule((kind, p) => {
    const s = JSON.stringify(p.ExpressionAttributeValues || {}) + '|' + ((p.Key && p.Key.sk) || '');
    return s.includes('uidB');
  }, 10);
  const [ra, rb] = await Promise.all([
    DrexCloud.database().ref('users/uidA').once('value').then(s => s.val()),
    DrexCloud.database().ref('users/uidB').once('value').then(s => s.val())
  ]);
  check('respuesta de A trae username alice (no bob)', ra && ra.username === 'alice', JSON.stringify(ra));
  check('respuesta de B trae username bob (no alice)', rb && rb.username === 'bob', JSON.stringify(rb));

  console.log('[3] Búsqueda por prefijo usernames/');
  const snap = await DrexCloud.database().ref('usernames').orderByKey().startAt('al').limitToFirst(20).once('value');
  const keys = [];
  snap.forEach(ch => keys.push(ch.key + '=' + ch.val()));
  check('prefijo "al" solo trae alice y alina', keys.length === 2 && keys[0] === 'alice=uidA' && keys[1] === 'alina=uidC', JSON.stringify(keys));
  const snap2 = await DrexCloud.database().ref('usernames').orderByKey().startAt('bob').limitToFirst(20).once('value');
  const keys2 = [];
  snap2.forEach(ch => keys2.push(ch.key + '=' + ch.val()));
  check('prefijo "bob" trae bob y bobby', keys2.length === 2, JSON.stringify(keys2));

  console.log('[4] Lectura exacta usernames/<nombre>');
  const u1 = await DrexCloud.database().ref('usernames/alice').once('value').then(s => s.val());
  const u2 = await DrexCloud.database().ref('usernames/bob').once('value').then(s => s.val());
  check('usernames/alice -> uidA', u1 === 'uidA', JSON.stringify(u1));
  check('usernames/bob -> uidB', u2 === 'uidB', JSON.stringify(u2));

  console.log(failures ? ('\nRESULTADO: ' + failures + ' FALLOS') : '\nRESULTADO: TODO OK');
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error('ERROR', e); process.exit(2); });
