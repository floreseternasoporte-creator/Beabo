// test-c18-push-lifecycle.js
// Regresión ciclo 18: fuga de notificaciones push entre cuentas.
// El endpoint push es por origen/navegador, no por cuenta. Sin el fix:
//  1) A cierra sesión -> pushSubscriptions/A/<subId> quedaba huérfano y A
//     seguía recibiendo push en ese navegador;
//  2) B inicia sesión en el mismo navegador y activa notificaciones ->
//     el mismo endpoint se registraba bajo B y B veía los push de A.
// El fix: drexDetachPushOnLogout(uid) borra el registro de ESTE dispositivo
// al salir; drexReconcilePushOnLogin(uid) lo restaura solo si vuelve la
// MISMA cuenta (nunca para otra cuenta).
// El harness extrae las funciones REALES de index.html y las ejecuta en vm.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function findIndexHtml() {
  const cands = [
    path.join(__dirname, '..', 'index.html'),
    path.join(__dirname, '..', 'src', 'index.html'),
  ];
  for (const c of cands) { if (fs.existsSync(c)) return c; }
  throw new Error('index.html no encontrado');
}

function extractFn(src, name) {
  const markers = ['async function ' + name + '(', 'function ' + name + '('];
  let fi = -1;
  for (const m of markers) { fi = src.indexOf(m); if (fi !== -1) break; }
  assert.ok(fi !== -1, name + ' no encontrada (regresión)');
  const open = src.indexOf('{', fi);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0, 'no se pudo cerrar ' + name);
  return src.slice(fi, i + 1);
}

const html = fs.readFileSync(findIndexHtml(), 'utf8');
const src = [
  extractFn(html, '_drexPushSubId'),
  extractFn(html, '_u8ToB64Url'),
  extractFn(html, 'drexDetachPushOnLogout'),
  extractFn(html, 'drexReconcilePushOnLogin'),
].join('\n\n');

const ENDPOINT = 'https://fcm.test/e/abc123';

const sandbox = {
  __dbRemoved: [],   // paths con .remove()
  __dbSets: [],      // [path, val]
  __dbExists: false, // lo que devuelve once('value')
  __store: {},       // sessionStorage falso
  __fakeSub: null,   // se configura por escenario
  __sid: null, __s1: null, __s2: null, __s3: null, __s4: null,
  sessionStorage: null,
  navigator: null,
  window: { PushManager: function PushManager() {} },
  location: { origin: 'https://x.github.io', pathname: '/Beabo/' },
  DrexCloud: null,
};
sandbox.sessionStorage = {
  getItem: (k) => (k in sandbox.__store ? sandbox.__store[k] : null),
  setItem: (k, v) => { sandbox.__store[k] = String(v); },
  removeItem: (k) => { delete sandbox.__store[k]; },
};
sandbox.navigator = {
  userAgent: 'test-agent',
  serviceWorker: {
    get ready() { return Promise.resolve(sandbox.__reg); },
  },
};
sandbox.__reg = {
  pushManager: {
    getSubscription: () => Promise.resolve(sandbox.__fakeSub),
  },
};
function fakeSub() {
  return {
    endpoint: ENDPOINT,
    getKey: () => new Uint8Array([1, 2, 3]).buffer,
  };
}
sandbox.DrexCloud = {
  database: () => ({
    ref: (p) => ({
      remove: () => { sandbox.__dbRemoved.push(p); return Promise.resolve(); },
      set: (v) => { sandbox.__dbSets.push([p, v]); return Promise.resolve(); },
      once: () => Promise.resolve({ exists: () => sandbox.__dbExists }),
    }),
  }),
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'push-lifecycle.js' });

async function waitFor(cond, label) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > 5000) throw new Error('timeout esperando: ' + label);
    await new Promise(r => setTimeout(r, 20));
  }
}

(async () => {
  // subId esperado (determinista por endpoint)
  vm.runInContext(`__sid = _drexPushSubId('${ENDPOINT}');`, sandbox);
  const sid = sandbox.__sid;
  assert.ok(/^s[0-9a-z]+$/.test(sid), 'subId con formato inesperado: ' + sid);
  const recPath = 'pushSubscriptions/uidA/' + sid;

  // --- Escenario 1: logout desvincula el registro de este dispositivo ---
  sandbox.__fakeSub = fakeSub();
  vm.runInContext(`drexDetachPushOnLogout('uidA').then(()=>{__s1='done';},()=>{__s1='err';});`, sandbox);
  await waitFor(() => sandbox.__s1, 'detach');
  assert.strictEqual(sandbox.__s1, 'done');
  assert.deepStrictEqual(sandbox.__dbRemoved, [recPath],
    'el logout debe borrar pushSubscriptions/uidA/<subId> de este dispositivo, fue: ' + JSON.stringify(sandbox.__dbRemoved));
  assert.strictEqual(sandbox.__store['drex-push-detached:uidA'], sid,
    'debe marcar la cuenta para una eventual restauración');

  // --- Escenario 2: la MISMA cuenta vuelve -> se restaura el registro ---
  sandbox.__dbExists = false;
  sandbox.__dbSets = [];
  vm.runInContext(`drexReconcilePushOnLogin('uidA').then(()=>{__s2='done';},()=>{__s2='err';});`, sandbox);
  await waitFor(() => sandbox.__s2, 'reconcile misma cuenta');
  assert.strictEqual(sandbox.__s2, 'done');
  assert.strictEqual(sandbox.__dbSets.length, 1, 'debe re-crear el registro al volver la misma cuenta');
  assert.strictEqual(sandbox.__dbSets[0][0], recPath);
  assert.strictEqual(sandbox.__dbSets[0][1].endpoint, ENDPOINT);
  assert.ok(!('drex-push-detached:uidA' in sandbox.__store), 'la marca debe limpiarse tras restaurar');

  // --- Escenario 3: OTRA cuenta entra -> NO se restaura nada ---
  sandbox.__store['drex-push-detached:uidA'] = sid; // simula que A se desvinculó
  sandbox.__dbSets = [];
  vm.runInContext(`drexReconcilePushOnLogin('uidB').then(()=>{__s3='done';},()=>{__s3='err';});`, sandbox);
  await waitFor(() => sandbox.__s3, 'reconcile otra cuenta');
  assert.strictEqual(sandbox.__s3, 'done');
  assert.strictEqual(sandbox.__dbSets.length, 0,
    'una cuenta DISTINTA jamás debe heredar el registro push: ' + JSON.stringify(sandbox.__dbSets.map(x => x[0])));

  // --- Escenario 4: sin suscripción del navegador -> logout no toca la BD ---
  sandbox.__fakeSub = null;
  sandbox.__dbRemoved = [];
  vm.runInContext(`drexDetachPushOnLogout('uidC').then(()=>{__s4='done';},()=>{__s4='err';});`, sandbox);
  await waitFor(() => sandbox.__s4, 'detach sin suscripción');
  assert.strictEqual(sandbox.__s4, 'done');
  assert.strictEqual(sandbox.__dbRemoved.length, 0, 'sin suscripción no debe borrar nada');

  console.log('test-c18-push-lifecycle: OK (detach en logout; restore solo misma cuenta; otra cuenta sin herencia; sin sub no-op)');
})().catch(err => { console.error(err); process.exit(1); });
