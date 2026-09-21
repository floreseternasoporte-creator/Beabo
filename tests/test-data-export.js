/* Harness de pruebas para drex-data-export.js (node, sin cuentas reales).
   Verifica el flujo ASÍNCRONO del backend durable:
     requestExport -> POST /request al backend (nada se prepara en el navegador)
     cierre de pestaña simulado -> el "servidor" cambia el job a ready solo
     downloadExport -> POST /download-url -> bytes por URL pre-firmada
   Fakes: DynamoDB (fachada .ref), localStorage, sessionToken, backend fetch,
   DrexSheet, document/Blob mínimos, crypto.subtle (sha256 real con node:crypto).
   Ejecutar: node tests/test-data-export.js */
'use strict';

var nodeCrypto = require('crypto');

global.window = global; // el módulo hace window.DrexDataExport = ...

/* ---------- Fake localStorage ---------- */
function makeStorage(initial) {
  var map = new Map(Object.entries(initial || {}));
  return {
    getItem: function (k) { return map.has(k) ? map.get(k) : null; },
    setItem: function (k, v) { map.set(k, String(v)); },
    removeItem: function (k) { map.delete(k); },
    key: function (i) { return Array.from(map.keys())[i] || null; },
    get length() { return map.size; },
    _map: map
  };
}

/* ---------- Fake DynamoDB (fachada .ref) ---------- */
function getPath(store, segs, create) {
  var node = store;
  for (var i = 0; i < segs.length; i++) {
    if (node == null || typeof node !== 'object') return undefined;
    if (!(segs[i] in node)) {
      if (!create) return undefined;
      node[segs[i]] = {};
    }
    node = node[segs[i]];
  }
  return node;
}
function setPath(store, segs, value) {
  if (!segs.length) return;
  var parent = getPath(store, segs.slice(0, -1), true);
  parent[segs[segs.length - 1]] = value;
}
function FakeSnapshot(value, key) {
  this._v = (value === undefined) ? null : value;
  this.key = (key == null) ? null : key;
}
FakeSnapshot.prototype.val = function () { return this._v; };

function FakeRef(db, segs) {
  this._db = db; this._segs = segs;
}
FakeRef.prototype.once = function () {
  var self = this;
  return Promise.resolve().then(function () {
    var v = getPath(self._db.store, self._segs);
    return new FakeSnapshot(v === undefined ? null : v, self._segs[self._segs.length - 1] || null);
  });
};
FakeRef.prototype.get = FakeRef.prototype.once;
FakeRef.prototype.set = function (v) {
  var self = this;
  return Promise.resolve().then(function () { setPath(self._db.store, self._segs, v); });
};
FakeRef.prototype.update = function (patch) {
  var self = this;
  return Promise.resolve().then(function () {
    var cur = getPath(self._db.store, self._segs);
    if (cur === undefined || cur === null || typeof cur !== 'object' || Array.isArray(cur)) cur = {};
    Object.keys(patch).forEach(function (k) {
      if (patch[k] !== undefined) cur[k] = patch[k];
    });
    setPath(self._db.store, self._segs, cur);
  });
};
FakeRef.prototype.remove = function () {
  var self = this;
  return Promise.resolve().then(function () {
    var parent = getPath(self._db.store, self._segs.slice(0, -1));
    if (parent) delete parent[self._segs[self._segs.length - 1]];
  });
};
FakeRef.prototype.child = function (p) {
  return new FakeRef(this._db, this._segs.concat(String(p).split('/').filter(Boolean)));
};
['orderByChild', 'equalTo', 'limitToLast', 'limitToFirst'].forEach(function (m) {
  FakeRef.prototype[m] = function () { return this; };
});

function makeFakeDb(seed) {
  var db = {
    store: seed || {},
    ref: function (path) {
      var segs = String(path || '').split('/').filter(Boolean);
      return new FakeRef(db, segs);
    }
  };
  return db;
}

/* ---------- DOM / Blob mínimos ---------- */
global.Blob = global.Blob || function (parts, opts) {
  this.parts = parts; this.type = (opts && opts.type) || '';
};
global.URL = global.URL || {};
var revokedUrls = [];
global.URL.createObjectURL = function () { return 'blob:faked'; };
global.URL.revokeObjectURL = function (u) { revokedUrls.push(u); };
var clickedLinks = [];
global.document = {
  createElement: function (tag) {
    if (tag === 'a') {
      var a = {
        href: '', download: '',
        click: function () { clickedLinks.push({ href: this.href, download: this.download }); },
        remove: function () {},
        style: {}
      };
      return a;
    }
    return { style: {} };
  },
  body: {
    appendChild: function () {},
    removeChild: function () {}
  }
};
// Node 24 ya trae crypto.subtle real (WebCrypto): se usa tal cual para sha256.

/* ---------- Backend falso (simula la Lambda drex-data-export) ---------- */
var BACKEND_URL = 'https://fake-backend.test';
var FILE_BYTES = new Uint8Array(Buffer.from('{"hola":"mundo","secciones":27}'));
var FILE_SHA = nodeCrypto.createHash('sha256').update(Buffer.from(FILE_BYTES)).digest('hex');

var backendLog = []; // {action, body, authOk}
var jobCounter = 0;
function activeInDb(db, uid) {
  var node = getPath(db.store, ['users', uid, 'dataExports']) || {};
  return Object.keys(node).map(function (k) { return node[k]; }).filter(function (j) {
    return j && (j.status === 'requested' || j.status === 'preparing') && j.uid === uid;
  });
}
function fetchFake(url, opts) {
  opts = opts || {};
  var method = (opts.method || 'GET').toUpperCase();
  var headers = opts.headers || {};
  function json(status, data) {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status: status,
      json: function () { return Promise.resolve(data); }
    });
  }
  if (url === BACKEND_URL && method === 'POST') {
    var body = JSON.parse(opts.body || '{}');
    var authOk = (headers.Authorization === 'Bearer fake-jwt');
    backendLog.push({ action: body.action, authOk: authOk, body: body });
    if (!authOk) return json(401, { error: 'invalid_token' });
    if (body.action === 'request') {
      if (activeInDb(db, UID).length) {
        var ex = activeInDb(db, UID)[0];
        return json(200, { jobId: ex.id, status: ex.status, alreadyActive: true });
      }
      jobCounter++;
      var jobId = 'ex_test' + jobCounter;
      var now = Date.now();
      setPath(db.store, ['users', UID, 'dataExports', jobId], {
        id: jobId, uid: UID, format: body.format || 'json',
        status: 'requested', createdAt: now, updatedAt: now, lastHeartbeat: now,
        expiresAt: now + 7 * 24 * 3600 * 1000,
        progress: { done: 0, total: 27, current: null },
        browserSnapshot: body.browserSnapshot || null
      });
      return json(200, { jobId: jobId, status: 'requested' });
    }
    if (body.action === 'download-url') {
      var j = getPath(db.store, ['users', UID, 'dataExports', body.jobId]);
      if (!j || j.uid !== UID) return json(404, { error: 'job_not_found' });
      if (j.status === 'expired' || Date.now() > j.expiresAt) return json(410, { error: 'job_expired' });
      if (j.status !== 'ready' && j.status !== 'downloaded') return json(409, { error: 'job_not_ready' });
      return json(200, {
        url: 'https://s3.test/file.json',
        filename: 'drex-mis-datos-2026-09-20.json',
        sha256: FILE_SHA,
        size: FILE_BYTES.length,
        expiresIn: 900
      });
    }
    return json(400, { error: 'bad_action' });
  }
  if (url === 'https://s3.test/file.json' && method === 'GET') {
    return Promise.resolve({
      ok: true, status: 200,
      arrayBuffer: function () { return Promise.resolve(FILE_BYTES.slice().buffer); }
    });
  }
  return json(404, { error: 'not_found' });
}

/* ---------- Módulo bajo prueba ---------- */
var UID = 'sub-test-1';
var db;
var storage;
var sheetOpened = [];
var sheetFake = {
  open: function (opts) { sheetOpened.push(opts); },
  close: function () {}
};

function freshDeps(extra) {
  db = makeFakeDb();
  backendLog = [];
  jobCounter = 0;
  sheetOpened = [];
  clickedLinks.length = 0;
  storage = makeStorage({
    drex_music_history: JSON.stringify([{ id: 't1', accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.firma' }]),
    drex_chat_draft_room1: JSON.stringify({ text: 'hola' }),
    drex_app_language_v1: 'es',
    'CognitoIdentityServiceProvider.xxxx.accessToken': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.firma'
  });
  var D = require('../drex-data-export.js');
  D._setDeps(Object.assign({
    db: function () { return db; },
    auth: function () { return { currentUser: { uid: UID } }; },
    storage: function () { return storage; },
    sheet: function () { return sheetFake; },
    now: function () { return NOW; },
    backendUrl: BACKEND_URL,
    fetchFn: function () { return fetchFake; },
    sessionToken: function () { return Promise.resolve('fake-jwt'); }
  }, extra || {}));
  return D;
}
var NOW = Date.now();

/* ---------- runner ---------- */
var failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FALLO ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
function expectReject(promise, codePart, name) {
  return promise.then(function () {
    ok(false, name + ' (debió rechazar)');
  }, function (e) {
    ok(e && ((e.code || '') + ' ' + (e.message || '')).indexOf(codePart) !== -1,
      name, (e && e.code) || (e && e.message));
  });
}
function waitFor(fn, ms, name) {
  var start = Date.now();
  return new Promise(function (resolve, reject) {
    (function poll() {
      var v = null;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - start > (ms || 3000)) return reject(new Error('timeout: ' + name));
      setTimeout(poll, 25);
    })();
  });
}

/* ---------- tests ---------- */
async function main() {
  console.log('== requestExport: ciclo feliz (nada se prepara en el navegador) ==');
  var D = freshDeps();
  var r = await D.requestExport({ format: 'json' });
  ok(r && r.job && r.job.id === 'ex_test1', 'devuelve jobId ex_test1');
  ok(r.alreadyActive === false, 'no alreadyActive la primera vez');
  ok(sheetOpened.length === 1 && /Solicitud recibida/.test(sheetOpened[0].title), 'bottom sheet de confirmación');
  ok(sheetOpened[0].body.indexOf('minutos a unos días') !== -1, 'mensaje honesto minutos-a-días');
  var stored = getPath(db.store, ['users', UID, 'dataExports', 'ex_test1']);
  ok(stored && stored.status === 'requested', 'job requested en DB');
  var snap = stored.browserSnapshot;
  ok(snap && snap.drex_music_history, 'snapshot con historial de música');
  ok(snap.drex_music_history[0].accessToken === undefined, 'snapshot sanitizado (accessToken eliminado)');
  ok(snap.chatDrafts && snap.chatDrafts['drex_chat_draft_room1'], 'snapshot con borradores');
  ok(JSON.stringify(snap).indexOf('CognitoIdentityServiceProvider') === -1, 'snapshot jamás lee llaves Cognito');
  ok(JSON.stringify(snap).length <= 64 * 1024, 'snapshot ≤ 64 KB');
  ok(backendLog.filter(function (e) { return e.action === 'request'; }).length === 1, '1 POST request al backend');
  ok(backendLog[0].authOk === true, 'request con Bearer fake-jwt');
  // clave: el navegador no ensambló nada
  ok(r.job.bytes === undefined && r.job.sections === undefined, 'sin payload/bytes/secciones en el cliente');

  console.log('== requestExport: idempotencia (job activo ya existe) ==');
  var r2 = await D.requestExport({ format: 'html' });
  ok(r2.job.id === 'ex_test1' && r2.alreadyActive === true, 'segundo request devuelve el job activo');
  ok(backendLog.filter(function (e) { return e.action === 'request'; }).length === 1, 'cliente no re-llama al backend (idempotencia local)');

  console.log('== requestExport: backend sin configurar ==');
  var D2 = freshDeps({ backendUrl: '' });
  global.DREX_EXPORT_BACKEND_URL = '';
  await expectReject(D2.requestExport({ format: 'json' }), 'backend-unconfigured', 'rechaza sin URL del backend');

  console.log('== requestExport: sin sesión (sessionToken falla) ==');
  var D3 = freshDeps({ sessionToken: function () { return Promise.reject(new Error('auth/no-session')); } });
  await expectReject(D3.requestExport({ format: 'json' }), 'auth/no-session', 'propaga falta de sesión');

  console.log('== cierre de pestaña simulado: el servidor prepara, el cliente solo observa ==');
  var D4 = freshDeps();
  var rr = await D4.requestExport({ format: 'html' });
  // "cerramos la pestaña": el cliente deja de existir; el servidor (falso) avanza el job
  var jid = rr.job.id;
  var job = getPath(db.store, ['users', UID, 'dataExports', jid]);
  job.status = 'preparing'; job.lastHeartbeat = Date.now(); job.progress = { done: 13, total: 27, current: 'posts' };
  var D5 = require('../drex-data-export.js'); // "nueva pestaña": mismo módulo, deps frescas sobre el mismo db
  D5._setDeps({
    db: function () { return db; },
    auth: function () { return { currentUser: { uid: UID } }; },
    storage: function () { return storage; },
    sheet: function () { return sheetFake; },
    now: function () { return NOW; },
    backendUrl: BACKEND_URL,
    pollMs: 40, // polling rápido solo en test
    fetchFn: function () { return fetchFake; },
    sessionToken: function () { return Promise.resolve('fake-jwt'); }
  });
  var j = await D5.getJob(jid);
  ok(j.status === 'preparing', 'el job avanzó sin el navegador (progreso del servidor)');
  // el cliente observa con polling mientras sigue "preparing"
  var readyFired = [];
  D5.onExportReady(function (jj) { readyFired.push(jj.id); });
  var el = { innerHTML: '', _handlers: {}, isConnected: true,
    addEventListener: function (ev, fn) { this._handlers[ev] = fn; },
    querySelector: function () { return null; } };
  var destroy = D5.renderInto(el);
  await waitFor(function () { return el.innerHTML.indexOf('En preparación') !== -1; }, 5000, 'renderInto muestra preparing');
  // el trabajador termina (sin que el navegador hiciera nada)
  job.status = 'ready';
  job.fileKey = 'exports/' + UID + '/' + jid + '/drex-mis-datos.json';
  job.sha256 = FILE_SHA;
  await waitFor(function () { return readyFired.length === 1; }, 5000, 'hook ready via polling');
  ok(readyFired[0] === jid, 'onExportReady se disparó por polling (transición a ready)');
  destroy();

  console.log('== downloadExport: URL pre-firmada, sha256, sin re-ensamblar ==');
  clickedLinks.length = 0;
  var dl = await D5.downloadExport(jid);
  ok(dl.filename === 'drex-mis-datos-2026-09-20.json', 'filename del servidor');
  ok(dl.bytes === FILE_BYTES.length, 'bytes = tamaño del archivo servido', dl.bytes);
  ok(clickedLinks.length === 1 && clickedLinks[0].download === dl.filename, 'clic de descarga con el filename');
  var after = await D5.getJob(jid);
  ok(after.status === 'downloaded', 'job marcado downloaded');
  ok(backendLog.some(function (e) { return e.action === 'download-url' && e.authOk; }), 'download-url con Bearer');

  console.log('== downloadExport: no listo / expirado ==');
  var D6 = freshDeps();
  var rr6 = await D6.requestExport({ format: 'json' });
  await expectReject(D6.downloadExport(rr6.job.id), 'not-ready', 'preparing -> job/not-ready');
  var j6 = getPath(db.store, ['users', UID, 'dataExports', rr6.job.id]);
  j6.createdAt = NOW - 8 * 24 * 3600 * 1000; // 8 días
  await expectReject(D6.downloadExport(rr6.job.id), 'expired', '8 días -> job/expired');
  var jobs6 = await D6.getJobs();
  ok(jobs6[0].status === 'expired', 'getJobs marca expired a los 7 días');

  console.log('== downloadExport: sha256 no coincide ==');
  var D7 = freshDeps();
  var rr7 = await D7.requestExport({ format: 'json' });
  var j7 = getPath(db.store, ['users', UID, 'dataExports', rr7.job.id]);
  j7.status = 'ready'; j7.fileKey = 'x'; j7.sha256 = FILE_SHA;
  FILE_SHA_SAVED = FILE_SHA;
  FILE_SHA = '0'.repeat(64); // el servidor "miente": el archivo no coincide
  await expectReject(D7.downloadExport(rr7.job.id), 'sha-mismatch', 'archivo corrupto -> export/sha-mismatch');
  FILE_SHA = FILE_SHA_SAVED;

  console.log('== anti-atoro: heartbeat >15 min -> cancelar y reintentar ==');
  var D8 = freshDeps();
  var rr8 = await D8.requestExport({ format: 'json' });
  var j8 = getPath(db.store, ['users', UID, 'dataExports', rr8.job.id]);
  j8.status = 'preparing';
  j8.lastHeartbeat = Date.now() - 20 * 60 * 1000; // 20 min sin progreso
  ok(D8._internals.isStuck(j8) === true, 'isStuck detecta job sin heartbeat');
  var cancelled = await D8.cancelExport(rr8.job.id);
  ok(cancelled.status === 'failed', 'cancelExport marca failed');
  var r8 = await D8.retryExport(rr8.job.id);
  ok(r8.job.id !== rr8.job.id && r8.alreadyActive === false, 'retryExport crea solicitud nueva');
  ok(j8.id !== undefined, 'job viejo conserva su id en el historial');

  console.log('== retryExport: solo failed/expired ==');
  var D9 = freshDeps();
  var rr9 = await D9.requestExport({ format: 'json' });
  await expectReject(D9.retryExport(rr9.job.id), 'not-retryable', 'requested activo no es reintentable');
  await expectReject(D9.cancelExport('ex_inexistente'), 'not-found', 'cancelar job inexistente');

  console.log('== UI: botón cancelar en job atorado ==');
  var D10 = freshDeps();
  var rr10 = await D10.requestExport({ format: 'json' });
  var j10 = getPath(db.store, ['users', UID, 'dataExports', rr10.job.id]);
  j10.status = 'preparing'; j10.lastHeartbeat = Date.now() - 30 * 60 * 1000;
  var el10 = { innerHTML: '', _handlers: {}, isConnected: true,
    addEventListener: function (ev, fn) { this._handlers[ev] = fn; },
    querySelector: function () { return null; } };
  D10.renderInto(el10);
  await waitFor(function () { return el10.innerHTML.indexOf('data-act="cancel"') !== -1; }, 5000, 'botón cancelar visible');
  ok(el10.innerHTML.indexOf('data-act="cancel"') !== -1, 'job atorado muestra Cancelar');
  ok(el10.innerHTML.indexOf('atorada') !== -1 || el10.innerHTML.indexOf('15 minutos') !== -1, 'nota de atorada visible');

  console.log('== i18n ES/EN/ZH ==');
  var langs = ['es', 'en', 'zh'];
  var keys = ['title', 'requestBtn', 'sheetTitle', 'stuckNote', 'cancelBtn', 'backendUnconfigured', 'shaMismatch'];
  var titles = { es: 'Descargar mis datos', en: 'Download your data', zh: '下载我的数据' };
  var D11 = freshDeps();
  langs.forEach(function (L) {
    global.getAppLanguage = function () { return L; };
    keys.forEach(function (k) {
      var s = D11.t(k);
      ok(typeof s === 'string' && s.length > 0 && s !== k, 't(' + k + ') en ' + L);
    });
    ok(D11.t('title') === titles[L], 'title en ' + L, D11.t('title'));
  });
  delete global.getAppLanguage;

  console.log('== listados documentados / sanitización / HTML ==');
  var D12 = freshDeps();
  ok(D12._internals.excludedList().length === 11, '11 exclusiones documentadas');
  ok(D12._internals.limitsList().length === 6, '6 límites documentados');
  ok(D12._internals.TOTAL_SECTIONS === 27, '27 secciones');
  var dirty = { twoFactorSecret: 'x', nested: { AccessToken: 'abc', otherField: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signatureReal0123456789' }, big: 'z'.repeat(300000), keep: 1 };
  var clean = D12._internals.stripSecretsDeep(dirty);
  ok(clean.twoFactorSecret === undefined && clean.nested.AccessToken === undefined, 'stripSecretsDeep elimina llaves prohibidas (case-insensitive)');
  ok(clean.nested.otherField === '[token omitido]', 'JWT en llave no prohibida se redacta');
  ok(clean.big.indexOf('omitido') !== -1 && clean.keep === 1, 'strings gigantes truncados, datos intactos');
  var fakePayload = {
    language: 'es', generatedAt: '2026-09-20T00:00:00.000Z', jobId: 'ex_x',
    account: { email: 'a@b.c' },
    summary: { sectionsOk: 27, sectionsFailed: 0 },
    sections: { account: { status: 'ok', count: 3, data: { username: 'x' } } },
    limits: [{ section: 'posts', limit: 200, note: 'n' }],
    excluded: [{ category: 'pushSubscriptions', reason: 'r' }]
  };
  var html = D12._internals.buildHtml(fakePayload);
  ok(html.indexOf('<!DOCTYPE html>') === 0, 'documento HTML completo');
  ok(html.indexOf('((•))') !== -1, 'identidad Drex ((•))');
  ok(html.indexOf('<script') === -1, 'HTML sin scripts');

  console.log('== renderInto: formulario y sección activa ==');
  var D13 = freshDeps();
  var el13 = { innerHTML: '', _handlers: {}, isConnected: true,
    addEventListener: function (ev, fn) { this._handlers[ev] = fn; },
    querySelector: function () { return null; } };
  var destroy = D13.renderInto(el13);
  await waitFor(function () { return el13.innerHTML.indexOf('data-act="request"') !== -1; }, 5000, 'renderInto pinta');
  ok(el13.innerHTML.indexOf('data-act="request"') !== -1, 'botón solicitar presente');
  ok(el13.innerHTML.indexOf('Historial de solicitudes') !== -1, 'historial presente');
  ok(el13.innerHTML.indexOf('minutos a unos días') !== -1, 'texto honesto en la intro');
  destroy();

  console.log('\nRESULTADO: ' + passes + ' ok, ' + failures + ' fallos');
  process.exit(failures ? 1 : 0);
}

var FILE_SHA_SAVED = null;

main().catch(function (e) {
  console.error('ERROR FATAL', e);
  process.exit(2);
});
