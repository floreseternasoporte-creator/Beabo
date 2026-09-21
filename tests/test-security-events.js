/* Harness de pruebas para recordSecurityEvent() (node, sin cuentas reales).
   Extrae el bloque [EVENTOS-SEGURIDAD] tal como quedó publicado en index.html
   y 404.html, lo evalúa con fakes (DrexCloud, appT, document, escapeHtml,
   formatSecurityTime) y verifica:
     1. formato del item escrito (pk='users', sk='<uid>/security/events/<pushId>',
        {eventKey, type, detail, timestamp, ts})
     2. cap de 50: el 51º evento borra el más viejo
     3. no-op silencioso sin usuario autenticado
     4. nunca lanza (entradas basura, DynamoDB roto)
     5. todos los call sites de index.html/404.html usan tipos conocidos
     6. renderSecurityEvents pinta etiqueta + detalle + fecha legible
   Ejecutar: node tests/test-security-events.js
   NOTA: sin 'use strict' a proposito: el eval directo del bloque publicado
   necesita exponer sus declaraciones de funcion en este scope (como hacen
   los scripts inline del navegador). */


var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ok - ' + name); }
  else { failed++; console.error('  FALLO - ' + name); }
}
function waitFor(fn, ms, label) {
  return new Promise(function (resolve, reject) {
    var start = Date.now();
    (function poll() {
      var v;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - start > ms) return reject(new Error('timeout: ' + label));
      setTimeout(poll, 15);
    })();
  });
}

/* ---------- extraer el bloque publicado ---------- */
function extractBlock(file) {
  var src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  var a = src.indexOf('// [EVENTOS-SEGURIDAD-BLOCK-BEGIN]');
  var b = src.indexOf('// [EVENTOS-SEGURIDAD-BLOCK-END]');
  if (a < 0 || b < 0 || b < a) throw new Error('bloque no encontrado en ' + file);
  return src.slice(a, b + '// [EVENTOS-SEGURIDAD-BLOCK-END]'.length);
}
var blockIndex = extractBlock('index.html');
var block404 = extractBlock('404.html');
ok(blockIndex === block404, 'bloque identico en index.html y 404.html');

/* ---------- fakes ---------- */
var store = {}; // árbol en memoria: users/<uid>/security/events/<pushId>
function splitSegs(p) { return String(p).split('/').filter(Boolean); }
function nodeAt(segs, create) {
  var node = store;
  for (var i = 0; i < segs.length; i++) {
    if (node == null || typeof node !== 'object') return undefined;
    if (!(segs[i] in node)) { if (!create) return undefined; node[segs[i]] = {}; }
    node = node[segs[i]];
  }
  return node;
}
function FakeSnapshot(v) { this._v = (v === undefined) ? null : v; }
FakeSnapshot.prototype.val = function () { return this._v; };

var dbShouldFail = false; // ref() lanza
var dbOpsFail = false;   // set()/once() rechazan
function FakeRef(segs) { this._segs = segs; }
FakeRef.prototype.child = function (k) { return new FakeRef(this._segs.concat([String(k)])); };
FakeRef.prototype.set = function (value) {
  var self = this;
  return new Promise(function (resolve, reject) {
    if (dbShouldFail || dbOpsFail) return reject(new Error('dynamo down'));
    var parent = nodeAt(self._segs.slice(0, -1), true);
    parent[self._segs[self._segs.length - 1]] = value;
    resolve();
  });
};
FakeRef.prototype.remove = function () {
  var self = this;
  return new Promise(function (resolve) {
    var parent = nodeAt(self._segs.slice(0, -1), false);
    if (parent) delete parent[self._segs[self._segs.length - 1]];
    resolve();
  });
};
FakeRef.prototype.once = function () {
  var self = this;
  return new Promise(function (resolve, reject) {
    if (dbShouldFail || dbOpsFail) return reject(new Error('dynamo down'));
    resolve(new FakeSnapshot(nodeAt(self._segs, false)));
  });
};

var currentUser = { uid: 'sub-qa-123' };
global.DrexCloud = {
  auth: function () { return { currentUser: currentUser }; },
  database: function () {
    return { ref: function (p) {
      if (dbShouldFail) throw new Error('ref roto');
      return new FakeRef(splitSegs(p));
    } };
  }
};
var LANG = 'es';
var DICTS = {
  en: {
    'Verificación en dos pasos activada': 'Two-step verification enabled',
    'Verificación en dos pasos desactivada': 'Two-step verification disabled',
    'Código de respaldo usado': 'Backup code used',
    'Nuevo inicio de sesión': 'New login',
    'Preferencia de seguridad': 'Security preference',
    'Nuevo dispositivo detectado': 'New device detected',
    'Dispositivo no reconocido': 'Unrecognized device',
    'Dispositivo olvidado': 'Forgotten device',
    'Verificación de correo solicitada': 'Email verification requested',
    'Recuperación solicitada': 'Recovery requested',
    'Contraseña cambiada': 'Password changed',
    'Sesión cerrada': 'Session signed out',
    'Otras sesiones cerradas': 'Other sessions signed out',
    'Datos descargados': 'Data downloaded',
    'Actividad de seguridad': 'Security activity',
    'Aún no hay eventos de seguridad registrados.': 'No security events recorded yet.'
  },
  zh: {
    'Verificación en dos pasos activada': '两步验证已开启',
    'Código de respaldo usado': '备用验证码已使用',
    'Nuevo dispositivo detectado': '检测到新设备',
    'Dispositivo no reconocido': '无法识别的设备',
    'Dispositivo olvidado': '已移除的设备',
    'Aún no hay eventos de seguridad registrados.': '暂无安全事件记录。'
  }
};
global.appT = function (esText) {
  if (LANG === 'es') return esText;
  var d = DICTS[LANG] || {};
  return d[esText] || esText;
};
global.escapeHtml = function (s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};
global.formatSecurityTime = function (ts) { return 'FECHA(' + ts + ')'; };
var lastList = null;
global.document = {
  getElementById: function (id) {
    if (id === 'security-events-list') {
      lastList = { innerHTML: '' };
      return lastList;
    }
    return null;
  }
};

// Date.now determinista: base + contador (claves pushId estrictamente crecientes)
var nowCounter = 0;
var BASE_TS = 1786000000000;
Date.now = function () { return BASE_TS + (nowCounter++); };

/* evaluar el bloque publicado (define DREX_SECURITY_EVENT_TYPES,
   recordSecurityEvent, securityEventTypeLabel en este scope) */
eval(blockIndex);

async function run() {
  console.log('== test 1: formato del item ==');
  store = {}; nowCounter = 0; dbShouldFail = false; currentUser = { uid: 'sub-qa-123' };
  var r = await recordSecurityEvent('Contraseña cambiada', 'Se cambió la contraseña desde el Centro de seguridad.');
  ok(r === true, 'resuelve true con usuario');
  var eventsNode = nodeAt(['users', 'sub-qa-123', 'security', 'events'], false);
  var keys = Object.keys(eventsNode || {});
  ok(keys.length === 1, 'un item escrito bajo users/<uid>/security/events');
  var item = eventsNode[keys[0]];
  ok(item.eventKey === 'password_changed', 'eventKey canonico (password_changed)');
  ok(item.type === 'Contraseña cambiada', 'type = etiqueta ES');
  ok(item.detail === 'Se cambió la contraseña desde el Centro de seguridad.', 'detail intacto');
  ok(typeof item.timestamp === 'number' && item.timestamp === item.ts, 'timestamp y ts presentes e iguales');
  ok(/^\d{13}_[a-z0-9]+$/.test(keys[0]), 'pushId = timestamp_ms + random (' + keys[0] + ')');

  console.log('== test 2: cap de 50 (el 51 borra el mas viejo) ==');
  store = {}; nowCounter = 0;
  for (var i = 0; i < 53; i++) {
    await recordSecurityEvent('Sesión cerrada', 'evento ' + i);
  }
  await waitFor(function () {
    var n = nodeAt(['users', 'sub-qa-123', 'security', 'events'], false);
    return n && Object.keys(n).length === 50 ? n : null;
  }, 5000, 'cap llega a 50');
  var n2 = nodeAt(['users', 'sub-qa-123', 'security', 'events'], false);
  var ks = Object.keys(n2).sort();
  ok(ks.length === 50, 'quedan exactamente 50 items');
  var oldestKept = n2[ks[0]].detail;
  var newestKept = n2[ks[ks.length - 1]].detail;
  ok(oldestKept === 'evento 3' && newestKept === 'evento 52',
    'se borraron los 3 mas viejos (evento 0..2); queda evento 3..52');

  console.log('== test 3: no-op sin usuario ==');
  store = {};
  currentUser = null;
  var r2 = await recordSecurityEvent('Contraseña cambiada', 'x');
  ok(r2 === false, 'resuelve false sin usuario');
  ok(Object.keys(store).length === 0, 'cero escrituras sin usuario');
  currentUser = { uid: 'sub-qa-123' };

  console.log('== test 4: nunca lanza ==');
  dbOpsFail = true;
  var r3 = await recordSecurityEvent('Sesión cerrada', 'x');
  ok(r3 === true, 'resuelve aunque las operaciones DynamoDB fallen (fire-and-forget)');
  dbOpsFail = false;
  dbShouldFail = true;
  var r3b = await recordSecurityEvent('Sesión cerrada', 'x');
  ok(r3b === false, 'resuelve false si ref() explota, sin lanzar');
  dbShouldFail = false;
  global.DrexCloud.database = function () { throw new Error('boom'); };
  var r4 = await recordSecurityEvent('Sesión cerrada', 'x');
  ok(r4 === false, 'resuelve false si database() explota');
  global.DrexCloud = {
    auth: function () { return { currentUser: currentUser }; },
    database: function () { return { ref: function (p) { return new FakeRef(splitSegs(p)); } }; }
  };
  var r5 = await recordSecurityEvent(undefined, undefined);
  ok(r5 === true, 'no lanza con type/detail undefined');
  var r6 = await recordSecurityEvent({ toString: function () { throw new Error('x'); } }, null);
  ok(r6 === false, 'no lanza con type toxico');

  console.log('== test 5: todos los call sites usan tipos conocidos ==');
  var EXPECTED = {
    'Verificación en dos pasos activada': 'mfa_enabled',
    'Verificación en dos pasos desactivada': 'mfa_disabled',
    'Código de respaldo usado': 'recovery_code_used',
    'Nuevo inicio de sesión': 'new_login',
    'Preferencia de seguridad': 'security_preference',
    'Nuevo dispositivo detectado': 'new_device',
    'Dispositivo no reconocido': 'unrecognized_device',
    'Dispositivo olvidado': 'device_forgotten',
    'Verificación de correo solicitada': 'email_verify_requested',
    'Recuperación solicitada': 'password_recovery_requested',
    'Contraseña cambiada': 'password_changed',
    'Sesión cerrada': 'session_closed',
    'Otras sesiones cerradas': 'other_sessions_closed',
    'Datos descargados': 'data_downloaded'
  };
  ['index.html', '404.html'].forEach(function (file) {
    var src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    var lines = src.split('\n');
    var sites = 0, unknown = [];
    lines.forEach(function (ln) {
      if (ln.indexOf('function recordSecurityEvent') >= 0) return; // definicion, no call site
      var m = ln.match(/recordSecurityEvent\(\s*(appT\()?('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`)/);
      if (!m) return;
      sites++;
      var raw = m[2];
      if (raw.charAt(0) === '`' && raw.indexOf('${') >= 0) return; // dinamico: no aplicable
      var label;
      try { label = eval(raw); } // literal del propio fuente: decodifica \uXXXX y comillas
      catch (e) { label = raw.slice(1, -1); }
      if (!EXPECTED[label]) unknown.push(file + ': ' + label);
    });
    ok(sites > 0, file + ': call sites encontrados (' + sites + ')');
    ok(unknown.length === 0, file + ': todos los tipos mapean a clave canonica' + (unknown.length ? ' -> ' + unknown.join('; ') : ''));
  });

  console.log('== test 6: renderSecurityEvents ==');
  // renderSecurityEvents vive en el HTML fuera del bloque; se extrae y evalua
  function extractRender(file) {
    var src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    var i = src.indexOf('function renderSecurityEvents(events)');
    if (i < 0) throw new Error('render no encontrado en ' + file);
    var depth = 0, j = src.indexOf('{', i);
    for (var k = j; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (depth === 0) { j = k + 1; break; } }
    }
    return src.slice(i, j);
  }
  ['index.html', '404.html'].forEach(function (file) {
    eval(extractRender(file));
    LANG = 'es';
    lastList = null;
    renderSecurityEvents({
      a: { eventKey: 'mfa_enabled', type: 'Verificación en dos pasos activada', detail: 'Se activó una app.', timestamp: 1000, ts: 1000 },
      b: { type: 'Etiqueta legada sin clave', detail: 'detalle legado', timestamp: 2000, ts: 2000 }
    });
    ok(lastList && lastList.innerHTML.indexOf('Verificación en dos pasos activada') >= 0, file + ': pinta etiqueta canonica');
    ok(lastList.innerHTML.indexOf('Etiqueta legada sin clave') >= 0, file + ': pinta evento legado sin eventKey');
    ok(lastList.innerHTML.indexOf('Se activó una app.') >= 0, file + ': pinta detalle');
    ok(lastList.innerHTML.indexOf('FECHA(2000)') >= 0, file + ': pinta fecha legible (el mas nuevo primero)');
    ok(lastList.innerHTML.indexOf('FECHA(2000)') < lastList.innerHTML.indexOf('FECHA(1000)'), file + ': orden descendente');
    LANG = 'en';
    renderSecurityEvents({ a: { eventKey: 'mfa_enabled', type: 'Verificación en dos pasos activada', detail: 'x', timestamp: 1, ts: 1 } });
    ok(lastList.innerHTML.indexOf('Two-step verification enabled') >= 0, file + ': etiqueta traducida a EN');
    LANG = 'zh';
    renderSecurityEvents({ a: { eventKey: 'recovery_code_used', type: 'Código de respaldo usado', detail: 'x', timestamp: 1, ts: 1 } });
    ok(lastList.innerHTML.indexOf('备用验证码已使用') >= 0, file + ': etiqueta traducida a ZH');
    LANG = 'es';
    renderSecurityEvents({});
    ok(lastList.innerHTML.indexOf('Aún no hay eventos de seguridad registrados.') >= 0, file + ': estado vacio con appT');
    // XSS: el render escapa
    renderSecurityEvents({ a: { eventKey: 'custom', type: '<img src=x onerror=1>', detail: '<b>hola</b>', timestamp: 1, ts: 1 } });
    ok(lastList.innerHTML.indexOf('<img') < 0 && lastList.innerHTML.indexOf('&lt;img') >= 0, file + ': escapa HTML en etiqueta y detalle');
  });

  console.log('');
  console.log('RESULTADO: ' + passed + ' ok, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
}

run().catch(function (e) { console.error('FATAL en tests:', e); process.exit(1); });
