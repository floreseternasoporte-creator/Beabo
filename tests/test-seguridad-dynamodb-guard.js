'use strict';
/* SEGURIDAD-DYNAMODB — el cliente no puede ESCRIBIR en particiones server-only
 * (wallets, transactions, stripe_events, ratelimit, users/<uid>/orbit), pero sí
 * en el resto. Ejecutar con: node tests/test-seguridad-dynamodb-guard.js */
const path = require('path');
const { __internals: I } = require(path.join(__dirname, '..', 'drex-cloud.js'));
let failures = 0;
function check(name, cond) { if (cond) console.log('  OK  ' + name); else { failures++; console.log('  FAIL ' + name); } }

// isServerOnlyKey
check('wallets protegido', I.isServerOnlyKey('wallets', 'u1/coins'));
check('transactions protegido', I.isServerOnlyKey('transactions', 'u1/t1/amount'));
check('stripe_events protegido', I.isServerOnlyKey('stripe_events', 'evt_1'));
check('ratelimit protegido', I.isServerOnlyKey('ratelimit', 'pay/1.2.3.4'));
check('users/<uid>/orbit protegido', I.isServerOnlyKey('users', 'abc/orbit'));
check('users/<uid>/orbit/x protegido', I.isServerOnlyKey('users', 'abc/orbit/status'));
check('users/<uid>/name NO protegido', !I.isServerOnlyKey('users', 'abc/name'));
check('users/<uid>/orbitalX NO protegido', !I.isServerOnlyKey('users', 'abc/orbitalX'));
check('users/<uid> raíz NO protegido', !I.isServerOnlyKey('users', 'abc'));
check('communityNotes NO protegido', !I.isServerOnlyKey('communityNotes', 'n1/content'));

// findServerOnlyWrite
const T = 'drex-kv';
check('put wallets detectado', I.findServerOnlyWrite('put', { TableName: T, Item: { pk: 'wallets', sk: 'u/coins', v: '1' } }) === 'wallets/u/coins');
check('put normal OK', I.findServerOnlyWrite('put', { TableName: T, Item: { pk: 'users', sk: 'u/name', v: '"a"' } }) === null);
check('put en otra tabla se ignora', I.findServerOnlyWrite('put', { TableName: 'drex-support-tickets', Item: { pk: 'wallets', sk: 'x' } }) === null);
check('delete orbit detectado', I.findServerOnlyWrite('delete', { TableName: T, Key: { pk: 'users', sk: 'u/orbit' } }) === 'users/u/orbit');
check('batchWrite mixto detectado', I.findServerOnlyWrite('batchWrite', { RequestItems: { [T]: [
  { PutRequest: { Item: { pk: 'notifications', sk: 'u/n1' } } },
  { PutRequest: { Item: { pk: 'wallets', sk: 'u/diamonds' } } } ] } }) === 'wallets/u/diamonds');
check('batchWrite limpio OK', I.findServerOnlyWrite('batchWrite', { RequestItems: { [T]: [
  { DeleteRequest: { Key: { pk: 'notifications', sk: 'u/n1' } } } ] } }) === null);
check('transactWrite detectado', I.findServerOnlyWrite('transactWrite', { TransactItems: [
  { Put: { TableName: T, Item: { pk: 'users', sk: 'u/orbit', v: '{}' } } } ] }) === 'users/u/orbit');
check('transactWrite limpio OK', I.findServerOnlyWrite('transactWrite', { TransactItems: [
  { Put: { TableName: T, Item: { pk: 'userCount', sk: '#' } } } ] }) === null);

// Adaptador real: el envío NO ocurre si hay clave protegida
(async () => {
  let sent = 0;
  const fakeDoc = { send: async () => { sent++; return { ok: 1 }; } };
  class Cmd { constructor(p) { this.p = p; } }
  const V3 = { GetCommand: Cmd, PutCommand: Cmd, QueryCommand: Cmd, DeleteCommand: Cmd, BatchWriteCommand: Cmd, TransactWriteCommand: Cmd };
  const ad = I.makeDocAdapterForTest(fakeDoc, V3);
  let err = null;
  try { await ad.put({ TableName: T, Item: { pk: 'wallets', sk: 'u/coins', v: '999999' } }).promise(); } catch (e) { err = e; }
  check('adaptador rechaza put en wallets', err && err.code === 'permission-denied' && sent === 0);
  await ad.put({ TableName: T, Item: { pk: 'users', sk: 'u/bio', v: '"hola"' } }).promise();
  check('adaptador deja pasar put normal', sent === 1);
  await ad.query({ TableName: T, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'wallets' } }).promise();
  check('lecturas no se tocan (la protección de lectura es IAM)', sent === 2);
  console.log(failures ? failures + ' FALLOS' : 'todo OK');
  process.exit(failures ? 1 : 0);
})();
