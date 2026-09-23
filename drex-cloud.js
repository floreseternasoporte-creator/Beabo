/* DrexCloud — adaptador de backend AWS para Drex.
 *
 * Expone la misma API que usaba el proveedor anterior, para no reescribir la app:
 *   DrexCloud.database()  -> base de datos sobre DynamoDB (tabla drex-kv)
 *   DrexCloud.auth()      -> autenticación con Amazon Cognito
 *
 * Motor de datos: la tabla drex-kv emula un árbol de documentos.
 *   pk = primer segmento de la ruta, sk = resto unido con "/",
 *   atributo "v" = valor de la hoja serializado en JSON.
 *   Ej: ref('users/abc/name').set('Zed') -> pk='users', sk='abc/name', v='"Zed"'
 *
 * NOTA (verificado 2026-09-17): el User Pool SÍ exige verificación de email en
 * el registro ("Cognito-assisted verification: verify email address"); las
 * cuentas quedan UNCONFIRMED hasta ingresar el código de 6 dígitos y la app
 * (web y nativa) muestra la pantalla de código con reenvío. Los correos los
 * envía Cognito con su remitente por defecto (COGNITO_DEFAULT,
 * no-reply@verificationemail.com): límite de 50/día y entregabilidad pobre
 * (suele caer en spam en Gmail). Si los códigos dejan de llegar, revisar ese
 * límite o migrar el pool a SES con remitente propio verificado.
 */
(function (global) {
  'use strict';

  var AWS_CONFIG = {
    region: 'us-east-1',
    userPoolId: 'us-east-1_kDSYEBsnY',
    userPoolClientId: '7cm12q14tm12u8b3bnn6ksjqni',
    identityPoolId: 'us-east-1:92871635-d775-42e5-b161-8de1171d271a',
    tableName: 'drex-kv',
    // Login social via Cognito OAuth (se activa al desplegar el dominio + IdPs)
    oauthDomain: 'drex-voz-auth.auth.us-east-1.amazoncognito.com',
    oauthRedirectUri: 'https://drex.glamworksapps.workers.dev/',
    oauthScope: 'email openid profile',
    // URL de DrexTotpFunction (verificación TOTP del lado servidor).
    // Se rellena con el Output TotpFunctionUrl tras desplegar el backend.
    totpFunctionUrl: '',
    // URL de la Lambda drex-username-resolve (login con nombre de usuario).
    // Se rellena con la Function URL real tras crear la Lambda en AWS.
    usernameLoginUrl: 'https://opyy2nl5x66xhu5uy4n4dwjzui0wkuas.lambda-url.us-east-1.on.aws/'
  };
  var IDP_ISSUER = 'cognito-idp.us-east-1.amazonaws.com/us-east-1_kDSYEBsnY';

  // Restauración de sesión estilo Instagram: en <head> ya sabemos si hay un
  // usuario guardado en localStorage. Mientras restorePending sea true, la
  // app no debe mostrar el login: la sesión aún se está restaurando.
  var restoreSeq = 0;
  function quickHasStoredUser() {
    try {
      if (typeof localStorage === 'undefined') return false;
      return !!localStorage.getItem('CognitoIdentityServiceProvider.' + AWS_CONFIG.userPoolClientId + '.LastAuthUser');
    } catch (e) { return false; }
  }
  var restorePending = quickHasStoredUser();
  function setRestorePending(v) { restorePending = !!v; }

  // Extrae sub/email/etc. del ID token (JWT) sin usar la red: permite
  // establecer la sesión aunque getUserAttributes falle (p. ej. abriendo la
  // app sin conexión, con una sesión válida en caché).
  function attrsFromIdToken(session) {
    try {
      var jwt = session.getIdToken().getJwtToken();
      var parts = String(jwt).split('.');
      if (parts.length < 2) return null;
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var payload = JSON.parse(decodeURIComponent(escape(atob(b64))));
      var out = [];
      ['sub', 'email', 'email_verified', 'name'].forEach(function (n) {
        if (payload[n] === undefined || payload[n] === null) return;
        out.push({
          getName: function () { return n; },
          getValue: function () { return String(payload[n]); }
        });
      });
      return out.length ? out : null;
    } catch (e) { return null; }
  }

  // Marca la sesión como expirada/no recuperada. Usa localStorage (además de
  // sessionStorage) para que el aviso sobreviva al cierre de la pestaña y el
  // usuario sí se entere de por qué volvió al login.
  function flagSessionExpired(reason) {
    var lang = 'es';
    try {
      var stored = (typeof localStorage !== 'undefined') && localStorage.getItem('drex_app_language_v1');
      if (stored === 'en') lang = 'en';
    } catch (e) {}
    try { sessionStorage.setItem('drex_session_expired', lang); } catch (e2) {}
    try { sessionStorage.setItem('drex_session_expired_reason', reason); } catch (e3) {}
    try { localStorage.setItem('drex_session_expired', lang); } catch (e4) {}
    try { localStorage.setItem('drex_session_expired_reason', reason); } catch (e5) {}
  }

  function clearSessionExpiredFlag() {
    try { sessionStorage.removeItem('drex_session_expired'); } catch (e) {}
    try { sessionStorage.removeItem('drex_session_expired_reason'); } catch (e2) {}
    try { localStorage.removeItem('drex_session_expired'); } catch (e3) {}
    try { localStorage.removeItem('drex_session_expired_reason'); } catch (e4) {}
  }

  // utilidades

  function normalizePath(path) {
    path = String(path == null ? '' : path).trim();
    path = path.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    return path;
  }
  function splitPath(path) {
    var p = normalizePath(path);
    return p === '' ? [] : p.split('/');
  }
  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) &&
      Object.prototype.toString.call(v) === '[object Object]';
  }

  // Generador de ids estilo push (20 caracteres, ordenados por tiempo)
  var PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  var lastPushTime = 0;
  var lastRandChars = [];
  function newPushId() {
    var now = Date.now();
    var duplicateTime = (now === lastPushTime);
    lastPushTime = now;
    var timeStampChars = new Array(8);
    var i;
    for (i = 7; i >= 0; i--) {
      timeStampChars[i] = PUSH_CHARS.charAt(now % 64);
      now = Math.floor(now / 64);
    }
    var id = timeStampChars.join('');
    if (!duplicateTime) {
      for (i = 0; i < 12; i++) lastRandChars[i] = Math.floor(Math.random() * 64);
    } else {
      for (i = 11; i >= 0 && lastRandChars[i] === 63; i--) lastRandChars[i] = 0;
      lastRandChars[i]++;
    }
    for (i = 0; i < 12; i++) id += PUSH_CHARS.charAt(lastRandChars[i]);
    return id;
  }

  // aplanado / reconstrucción

  // Marcador de "ahora mismo" (equivale al TIMESTAMP del proveedor anterior)
  var TIMESTAMP_SENTINEL = { '.sv': 'timestamp' };

  function resolveValue(v) {
    if (v === TIMESTAMP_SENTINEL) return Date.now();
    if (isPlainObject(v) && v['.sv'] === 'timestamp' && Object.keys(v).length === 1) return Date.now();
    return v;
  }

  // Aplana un valor a hojas: [{ segs: [...], value }]
  // null equivale a BORRAR la clave (semántica de borrado con null): no genera hoja y,
  // si se pasa nullPaths, registra la ruta para que quien escriba la borre.
  function flatten(value, baseSegs, out, nullPaths) {
    out = out || [];
    value = resolveValue(value);
    if (value === undefined) return out;
    if (value === null) {
      if (Array.isArray(nullPaths)) nullPaths.push(baseSegs.slice());
      return out; // null borra la clave, no escribe tumba
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return out; // [] equivale a subárbol vacío
      for (var i = 0; i < value.length; i++) flatten(value[i], baseSegs.concat([String(i)]), out, nullPaths);
      return out;
    }
    if (isPlainObject(value)) {
      var keys = Object.keys(value);
      if (keys.length === 0) return out; // {} equivale a borrar el subárbol
      for (var k = 0; k < keys.length; k++) {
        flatten(value[keys[k]], baseSegs.concat([keys[k]]), out, nullPaths);
      }
      return out;
    }
    out.push({ segs: baseSegs.slice(), value: value });
    return out;
  }

  // Reconstruye el subárbol a partir de hojas [{ segs, value }]
  function unflatten(items, baseSegs) {
    var result;
    var hasChildren = false;
    for (var i = 0; i < items.length; i++) {
      var rel = items[i].segs.slice(baseSegs.length);
      if (rel.length === 0) {
        result = items[i].value; // hoja exacta en la ruta base
      } else {
        hasChildren = true;
        if (result === undefined || result === null || typeof result !== 'object') result = {};
        var node = result;
        for (var d = 0; d < rel.length - 1; d++) {
          if (node[rel[d]] === undefined || node[rel[d]] === null || typeof node[rel[d]] !== 'object') {
            node[rel[d]] = {};
          }
          node = node[rel[d]];
        }
        node[rel[rel.length - 1]] = items[i].value;
      }
    }
    if (result === undefined) return hasChildren ? {} : null;
    return arraysBack(result);
  }

  // Los arrays se aplanan como claves numéricas ("0","1",...); al reconstruir,
  // los objetos con claves 0..n-1 consecutivas vuelven a ser arrays (comportamiento
  // estándar de la plataforma). Sin esto las encuestas nunca se podían votar.
  function arraysBack(node) {
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) node[i] = arraysBack(node[i]);
      return node;
    }
    if (!isPlainObject(node)) return node;
    var keys = Object.keys(node);
    var isSeq = keys.length > 0;
    for (var i = 0; i < keys.length && isSeq; i++) {
      if (keys[i] !== String(i)) isSeq = false;
    }
    if (isSeq) {
      var arr = [];
      for (var j = 0; j < keys.length; j++) arr.push(arraysBack(node[String(j)]));
      return arr;
    }
    for (var k = 0; k < keys.length; k++) node[keys[k]] = arraysBack(node[keys[k]]);
    return node;
  }

  // cliente DynamoDB (perezoso)

  var _docClient = null; // inyectable en pruebas
  var _awsCredentials = null;

  function awsLib() {
    return (typeof global.AWS !== 'undefined') ? global.AWS : null;
  }

  function ensureAwsConfigured() {
    var AWS = awsLib();
    if (!AWS) throw new Error('AWS SDK no cargado');
    if (!AWS.config.region) AWS.config.update({ region: AWS_CONFIG.region });
    return AWS;
  }

  function currentCredentials() {
    var AWS = ensureAwsConfigured();
    if (_awsCredentials) return _awsCredentials;
    _awsCredentials = new AWS.CognitoIdentityCredentials({ IdentityPoolId: AWS_CONFIG.identityPoolId });
    return _awsCredentials;
  }

  function getDocClient() {
    if (_docClient) return _docClient;
    var AWS = ensureAwsConfigured();
    var creds = currentCredentials();
    _docClient = new AWS.DynamoDB.DocumentClient({ region: AWS_CONFIG.region, credentials: creds });
    return _docClient;
  }

// ==FIABILIDAD-INICIO==
// =====================================================================
// MÓDULO DE FIABILIDAD (2026-09-21).
// Endurece el camino navegador -> DynamoDB para escala de millones de
// usuarios. Tres piezas:
//   1) classifyDbError + withCredRetry con backoff: distingue errores
//      reintentables (red, throttling, timeouts) de los que no lo son
//      (4xx, validación, lógica de app) y solo reintenta los primeros.
//   2) CircuitBreaker por subsistema (db/auth/storage): tras 5 fallos
//      consecutivos del subsistema db, las operaciones fallan rápido
//      (~1 ms) en vez de colgar 25 s cada una; se recupera con un probe.
//   3) Colector de errores del cliente: captura window.onerror y
//      promesas no capturadas, deduplica, muestrea y envía en lotes con
//      sendBeacon al endpoint de ingesta (o a un respaldo local si no
//      hay endpoint configurado).
// Este módulo NO toca el motor de polling, los índices secundarios, el
// ruteo de readRefValue, la cascada de arranque ni la consistencia
// eventual: solo añade código y reescribe withCredRetry (única función
// existente modificada). La API pública vive en DrexCloud.reliability.
// =====================================================================

// Clasifica un error de la capa de datos:
//   'credential'   -> hay que refrescar la sesión Cognito (una sola vez)
//   'retryable'    -> red / throttling / timeout: reintentar con backoff
//   'nonretryable' -> 4xx, validación, lógica de app: fallar de inmediato
// TransactionCanceledException es 'nonretryable' a propósito: ya la maneja
// transaction() con su propio reintento (hasta 6 intentos); aquí no se
// duplica ese reintento.
function classifyDbError(err) {
  if (isCredError(err)) return 'credential';
  var code = String((err && err.code) || '');
  var msg = String((err && err.message) || '');
  if (code === 'TransactionCanceledException') return 'nonretryable';
  // Bandera interna de "sin red": no es fallo del backend, no reintentar.
  if (code === 'DrexNetworkDown' || msg.indexOf('DrexNetworkDown') >= 0) return 'nonretryable';
  // Timeouts propios: dbTimeout/promiseTimeout generan estos mensajes.
  if (/^db-(.+-)?timeout$/.test(msg) || msg === 'aws-creds-timeout') return 'retryable';
  // Errores de red del AWS SDK.
  if (/^(NetworkingError|TimeoutError|RequestAbortedError)$/.test(code)) return 'retryable';
  // Throttling de DynamoDB: la respuesta correcta es esperar y reintentar.
  if (/Throttl|ProvisionedThroughputExceeded|RequestLimitExceeded|TooManyRequestsException/i.test(code)) return 'retryable';
  if (/^5\d\d$/.test(code)) return 'retryable';
  var status = err && err.statusCode;
  if (typeof status === 'string' && /^\d+$/.test(status)) status = parseInt(status, 10);
  if (typeof status === 'number') {
    if (status >= 500 && status < 600) return 'retryable';
    if (status >= 400 && status < 500) return 'nonretryable';
  }
  // Mensajes típicos de red (fetch/XHR del SDK en el navegador).
  if (/timeout|timed out|network|failed to fetch|econnreset|econnaborted|enetunreach|socket hang up|eai_again/i.test(msg)) return 'retryable';
  // Por defecto: 4xx, validación y errores de app -> no reintentar.
  return 'nonretryable';
}

// Reintento con backoff exponencial + jitter (decorrelación simple):
//   intento 0 -> 150-300 ms, intento 1 -> 300-600 ms, intento 2 -> 600-1200 ms.
// Total esperado ~1.6 s (máx 2.1 s): absorbe picos de throttling sin
// castigar la UX. Tope de 8 s por si algún día se amplía el nº de reintentos.
var REL_MAX_RETRIES = 3;
var REL_BACKOFF_BASE_MS = 300;
var REL_BACKOFF_CAP_MS = 8000;
function relBackoffMs(attempt) {
  var exp = Math.min(REL_BACKOFF_CAP_MS, REL_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt || 0)));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}
function relSleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Disyuntor por subsistema. Estados: closed -> open -> half-open -> closed.
//   closed:    opera normal; N fallos consecutivos abren el circuito.
//   open:      fail-fast durante openMs (las ops se rechazan en ~1 ms).
//   half-open: pasado openMs se permite UN probe; si tiene éxito el
//              circuito se cierra, si falla se reabre otros openMs.
// Emite onHealthChange({subsystem, from, to, at}) en cada transición.
// Es una factoría (no una clase con 'new'): devuelve el objeto API.
function CircuitBreaker(name, opts) {
  opts = opts || {};
  var threshold = opts.threshold || 5; // fallos consecutivos para abrir
  var openMs = opts.openMs || 30000;   // tiempo abierto antes del probe
  var state = 'closed';
  var consecutive = 0;
  var openedAt = 0;
  var probeInFlight = false;
  var listeners = [];
  function now() { return Date.now(); }
  function emit(from, to) {
    var ev = { subsystem: name, from: from, to: to, at: now() };
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](ev); } catch (e) { /* un observador roto no debe romper el breaker */ }
    }
  }
  function setState(to) {
    if (state === to) return;
    var from = state;
    state = to;
    emit(from, to);
  }
  function maybeHalfOpen() {
    if (state === 'open' && now() - openedAt >= openMs) setState('half-open');
  }
  return {
    // Estado actual ('closed' | 'open' | 'half-open'). Hace la transición
    // perezosa open -> half-open cuando ya pasó openMs.
    state: function () { maybeHalfOpen(); return state; },
    // true si el circuito está abierto (fail-fast). ~1 ms, sin red.
    isOpen: function () { maybeHalfOpen(); return state === 'open'; },
    // Reserva el probe único del estado half-open (o una verificación
    // manual en closed). Devuelve false si ya hay un probe en vuelo.
    allowProbe: function () {
      maybeHalfOpen();
      if (state === 'open') return false;
      if (probeInFlight) return false;
      probeInFlight = true;
      return true;
    },
    // Libera un probe reservado sin contar éxito ni fallo (p. ej. el probe
    // terminó con un error nonretryable: la BD sí respondió, no cuenta
    // como caída).
    releaseProbe: function () { probeInFlight = false; },
    recordSuccess: function () {
      consecutive = 0;
      probeInFlight = false;
      setState('closed'); // resetea el conteo y cierra desde half-open
    },
    recordFailure: function (/* err */) {
      probeInFlight = false;
      if (state === 'half-open') { openedAt = now(); setState('open'); return; } // reapertura
      if (state === 'open') return;
      consecutive++;
      if (consecutive >= threshold) { openedAt = now(); setState('open'); }
    },
    onHealthChange: function (cb) {
      if (typeof cb !== 'function') return function () {};
      listeners.push(cb);
      return function () {
        var i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    // Solo para diagnóstico y pruebas.
    stats: function () { return { state: state, consecutiveFailures: consecutive, threshold: threshold, openMs: openMs }; }
  };
}

// Registro de disyuntores por subsistema. Solo 'db' está cableado (lo usa
// withCredRetry); 'auth' y 'storage' quedan listos para futuros frentes
// sin tocar este módulo.
var circuitRegistry = {
  db: CircuitBreaker('db', { threshold: 5, openMs: 30000 }),
  auth: CircuitBreaker('auth', { threshold: 5, openMs: 30000 }),
  storage: CircuitBreaker('storage', { threshold: 5, openMs: 30000 })
};

// Contadores de los caminos silenciosos ("best-effort") que recorre este
// módulo sin cambiar la conducta visible: Rel.note('tag') cuenta y
// silentStats() los expone para diagnóstico. No se toca ningún
// .catch(()=>{}) existente: esto cubre solo los caminos nuevos de aquí.
var _relSilentCounts = {};
function relNote(tag) {
  try {
    tag = String(tag == null ? 'unknown' : tag);
    _relSilentCounts[tag] = (_relSilentCounts[tag] || 0) + 1;
  } catch (e) { /* contar nunca debe lanzar */ }
}
function silentStats() {
  var out = {};
  try {
    for (var k in _relSilentCounts) {
      if (Object.prototype.hasOwnProperty.call(_relSilentCounts, k)) out[k] = _relSilentCounts[k];
    }
  } catch (e) {}
  return out;
}

// ---------------------------------------------------------------------
// Colector de errores del cliente.
// Captura window.onerror y unhandledrejection, deduplica por firma
// (ventana de 10 min), muestrea al 10 % y envía en lotes de <=10 con
// navigator.sendBeacon al endpoint de ingesta
// (window.DREX_ERROR_INGEST_URL; vacío = solo respaldo local).
// Respaldo en localStorage ('drex_errbuf_v1', máx 50 eventos) con drenaje
// piggyback en cada envío: lo respaldado viaja primero.
// Nunca lanza, nunca se auto-reporta y filtra el 'Script error.' opaco
// de scripts de terceros.
// ---------------------------------------------------------------------
var DREX_ERRBUF_KEY = 'drex_errbuf_v1';
var DREX_ERRBUF_MAX = 50;
var REL_DEDUP_WINDOW_MS = 10 * 60 * 1000;
var REL_BATCH_MAX = 10;
var REL_QUEUE_MAX = 200;
var REL_STACK_CAP = 2048;

var _relErrQueue = [];    // lote en memoria pendiente de envío
var _relErrSeen = {};     // firma -> timestamp (dedup 10 min)
var _relReporting = false; // guardia de reentrancia: no auto-reportarse
var _relFlushing = false;   // guardia propia del envío (ver relFlushErrors)
var _relFlushTimer = null;

// Firma de deduplicación: mensaje + primer frame útil del stack.
function relErrSignature(msg, stack) {
  var first = '';
  try {
    var lines = String(stack || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].replace(/^\s+/, '');
      if (!t) continue;
      if (t.indexOf('relReportError') >= 0) continue; // frames propios
      first = t.slice(0, 160);
      break;
    }
  } catch (e) {}
  return String(msg || '').slice(0, 200) + '|' + first;
}

function relReadErrBuf() {
  try {
    if (typeof localStorage === 'undefined') return [];
    var raw = localStorage.getItem(DREX_ERRBUF_KEY);
    if (!raw) return [];
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { relNote('errbuf-read-fail'); return []; }
}
function relWriteErrBuf(arr) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(DREX_ERRBUF_KEY, JSON.stringify(arr.slice(-DREX_ERRBUF_MAX)));
  } catch (e) { relNote('errbuf-write-fail'); }
}
function relIngestUrl() {
  try { return String(global.DREX_ERROR_INGEST_URL || ''); }
  catch (e) { return ''; }
}
function relBeaconSend(url, batch) {
  try {
    var nav = (typeof navigator !== 'undefined') ? navigator : null;
    if (!nav || typeof nav.sendBeacon !== 'function') return false;
    var payload = JSON.stringify({ app: 'drex-web', v: 1, batch: batch });
    var body = payload;
    try { body = new Blob([payload], { type: 'application/json' }); } catch (e) { /* sendBeacon acepta string */ }
    return !!nav.sendBeacon(url, body);
  } catch (e) {
    relNote('beacon-throw');
    return false;
  }
}

// Envía lo pendiente (respaldo local primero = drenaje piggyback).
// Nunca lanza. Tiene su propia guardia (_relFlushing) porque también se
// llama desde dentro de relReportError, donde _relReporting está activa.
function relFlushErrors() {
  if (_relFlushing) return;
  try {
    _relFlushing = true;
    var pending = relReadErrBuf().concat(_relErrQueue);
    _relErrQueue = [];
    if (!pending.length) return;
    var url = relIngestUrl();
    if (!url) {
      // Sin endpoint configurado: solo respaldo local (máx 50).
      relWriteErrBuf(pending);
      relNote('ingest-unset');
      return;
    }
    var batch = pending.slice(0, REL_BATCH_MAX);
    var rest = pending.slice(REL_BATCH_MAX);
    if (relBeaconSend(url, batch)) {
      relNote('beacon-ok');
      relWriteErrBuf(rest); // lo que no cupo espera el próximo envío
    } else {
      // El beacon falló (o no existe): todo vuelve al respaldo local.
      relWriteErrBuf(pending);
      relNote('beacon-fail');
    }
  } catch (e) {
    relNote('flush-fail');
  } finally {
    _relFlushing = false;
  }
}

// Punto de entrada del colector. Acepta Error, objeto o string. Nunca lanza.
function relReportError(input, kind) {
  if (_relReporting) return; // no auto-reportarse
  try {
    _relReporting = true;
    var msg = '', stack = '', url = '', line = null, col = null;
    try {
      var inp = input;
      if (inp instanceof Error) {
        msg = String(inp.message || inp.name || 'Error');
        stack = String(inp.stack || '');
      } else if (inp && typeof inp === 'object') {
        msg = String(inp.message || inp.msg || '');
        if (!msg) { try { msg = JSON.stringify(inp).slice(0, 300); } catch (e) { msg = 'object-error'; } }
        stack = String(inp.stack || '');
        line = (inp.lineno != null ? inp.lineno : (inp.line != null ? inp.line : null));
        col = (inp.colno != null ? inp.colno : (inp.col != null ? inp.col : null));
        url = String(inp.filename || inp.url || '');
      } else {
        msg = String(inp);
      }
    } catch (e) { msg = 'unserializable-error'; }
    msg = msg.slice(0, 300);
    // Filtra el error opaco de scripts de terceros (sin información útil).
    if (msg === 'Script error.' || msg === 'Script error') { relNote('opaque-filtered'); return; }
    stack = stack.slice(0, REL_STACK_CAP);
    if (!url) { try { url = String((global.location && global.location.href) || '').split('#')[0]; } catch (e) {} }
    url = String(url).slice(0, 300);
    var sig = relErrSignature(msg, stack);
    var nowMs = Date.now();
    // Deduplicación por firma (ventana de 10 min).
    var seenAt = _relErrSeen[sig];
    if (seenAt && nowMs - seenAt < REL_DEDUP_WINDOW_MS) { relNote('dedup-drop'); return; }
    _relErrSeen[sig] = nowMs;
    // Poda del mapa de firmas (no crece sin cota).
    try {
      var keys = Object.keys(_relErrSeen);
      if (keys.length > 500) {
        for (var i = 0; i < keys.length; i++) {
          if (nowMs - _relErrSeen[keys[i]] >= REL_DEDUP_WINDOW_MS) delete _relErrSeen[keys[i]];
        }
      }
    } catch (e) {}
    // Muestreo: por defecto solo el 10 % viaja a la red.
    if (Math.random() >= Rel.sampleRate) { relNote('sampled-out'); return; }
    var ev = { v: 1, ts: nowMs, kind: kind || 'error', msg: msg, stack: stack, url: url, line: line, col: col, sig: sig };
    if (_relErrQueue.length >= REL_QUEUE_MAX) { _relErrQueue.shift(); relNote('queue-overflow'); }
    _relErrQueue.push(ev);
    // Lote lleno -> se envía solo (<=10 por beacon).
    if (_relErrQueue.length >= REL_BATCH_MAX) relFlushErrors();
  } catch (e) {
    relNote('report-fail');
  } finally {
    _relReporting = false;
  }
}

// Instala los hooks globales y drena la cola temprana que index.html llena
// (window.__drexErrQ) antes de que cargue este bundle. Nunca lanza.
function relInstallCollector() {
  try {
    var q = global.__drexErrQ;
    if (Array.isArray(q) && q.length) {
      global.__drexErrQ = [];
      for (var i = 0; i < q.length; i++) {
        try { relReportError(q[i], 'early'); } catch (e) {}
      }
      relNote('early-drained');
    }
    var prevOnError = global.onerror;
    global.onerror = function (msg, src, ln, co, err) {
      try { relReportError(err || { message: msg, filename: src, lineno: ln, colno: co }, 'error'); } catch (e) {}
      try { if (typeof prevOnError === 'function') return prevOnError.apply(this, arguments); } catch (e) {}
      return false;
    };
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('unhandledrejection', function (ev) {
        try { relReportError(ev && ev.reason, 'rejection'); } catch (e) {}
      });
      var flushOnHide = function () { try { relFlushErrors(); } catch (e) {} };
      global.addEventListener('pagehide', flushOnHide);
      if (global.document && global.document.addEventListener) {
        global.document.addEventListener('visibilitychange', function () {
          try { if (global.document.visibilityState === 'hidden') relFlushErrors(); } catch (e) {}
        });
      }
    }
    // Si los errores no llegan a 10, salen solos cada 30 s (no deja
    // telemetría pudriéndose en memoria; unref para no frenar a node).
    try {
      _relFlushTimer = setInterval(function () {
        try { if (_relErrQueue.length) relFlushErrors(); } catch (e) {}
      }, 30000);
      if (_relFlushTimer && typeof _relFlushTimer.unref === 'function') _relFlushTimer.unref();
    } catch (e) {}
  } catch (e) { /* instalar el colector nunca debe romper la app */ }
}

// Contadores best-effort del módulo (Rel.note) + tasa de muestreo ajustable.
var Rel = {
  note: relNote,
  stats: silentStats,
  sampleRate: 0.10
};

// Verificación barata de salud de DynamoDB: un solo GetItem a _health/#.
// Sirve como probe del circuit breaker y como acción del botón "Reintentar"
// del banner de degradación. NO pasa por withCredRetry a propósito: si el
// circuito está abierto, withCredRetry haría fail-fast y el probe jamás
// llegaría a la red.
function probeDb() {
  var brk = circuitRegistry.db;
  if (!brk.allowProbe()) {
    return Promise.reject(new Error('db/probe-busy: ya hay una verificación de conexión en curso'));
  }
  var dc;
  try {
    dc = getDocClient();
  } catch (e) {
    brk.releaseProbe();
    return Promise.reject(e);
  }
  return dbTimeout(
    dc.get({ TableName: AWS_CONFIG.tableName, Key: { pk: '_health', sk: '#' } }).promise(),
    'db-health-timeout'
  ).then(function (res) {
    brk.recordSuccess();
    relNote('probe-ok');
    return (res && res.Item) ? res.Item : null;
  }, function (err) {
    var cls = classifyDbError(err);
    if (cls === 'retryable' || cls === 'credential') brk.recordFailure(err);
    else brk.releaseProbe(); // la BD respondió (4xx): no cuenta como caída
    relNote('probe-fail');
    throw err;
  });
}

// API pública de fiabilidad (se expone como DrexCloud.reliability).
var RelPublicApi = {
  // Contador best-effort para catches que antes tragaban el error en silencio.
  // Uso: DrexCloud.reliability.note('vote-train-fail'). Nunca lanza.
  note: function (tag) { relNote(tag); },  // Disyuntor de un subsistema ('db' | 'auth' | 'storage').
  circuit: function (name) { return circuitRegistry[name] || null; },
  resetCircuits: function () {
    Object.keys(circuitRegistry).forEach(function (k) { circuitRegistry[k].recordSuccess(); });
  },
  // cb({subsystem, from, to, at}); devuelve función para desuscribir.
  onHealthChange: function (cb) {
    var offs = Object.keys(circuitRegistry).map(function (k) { return circuitRegistry[k].onHealthChange(cb); });
    return function () { offs.forEach(function (off) { try { off(); } catch (e) {} }); };
  },
  // true si algún subsistema está degradado (open o half-open).
  isDegraded: function () {
    return Object.keys(circuitRegistry).some(function (k) {
      var s = circuitRegistry[k].state();
      return s === 'open' || s === 'half-open';
    });
  },
  probeDb: probeDb,
  silentStats: silentStats,
  reportError: relReportError,
  // Vacía la cola/búfer hacia el endpoint ahora mismo (también se hace
  // solo al llenar el lote, cada 30 s y al ocultar la página).
  flushErrors: relFlushErrors
};

relInstallCollector();
// ==FIABILIDAD-FIN==

  // --- Auto-reparación de credenciales AWS (fix 2026-09-17) ---
  // Causa del bug "No se pudo enviar el mensaje": si el configure inicial de
  // credenciales fallaba (red inestable al abrir la app) o el refresh del
  // token no lograba reconfigurarlas, el usuario quedaba "logueado" pero con
  // credenciales anónimas/rotas cacheadas: TODA lectura y escritura a DynamoDB
  // fallaba con AccessDenied hasta reinstalar o reloguear. El comentario viejo
  // decía "se reintentan al usar la BD" pero nada lo implementaba.
  // Ahora: cualquier operación que falle por credenciales refresca la sesión
  // Cognito, reconfigura las credenciales y reintenta la operación UNA vez.
  var _credsRefreshPromise = null;

  function isCredError(err) {
    if (!err) return false;
    var code = String((err && err.code) || '');
    var msg = String((err && err.message) || '');
    return /CredentialsError|AccessDenied|UnrecognizedClient|InvalidSignature|ExpiredToken|TokenRefresh/i.test(code)
        || /credential/i.test(msg);
  }

  function refreshAwsCredentialsNow() {
    if (_credsRefreshPromise) return _credsRefreshPromise;
    _credsRefreshPromise = promiseTimeout(new Promise(function (resolve, reject) {
      try {
        if (!currentCognitoUser) return reject(new Error('no-session'));
        // getSession refresca solo con el refresh token si el ID token venció
        currentCognitoUser.getSession(function (err, session) {
          if (err || !session) return reject(err || new Error('no-session'));
          resolve(configureAwsCredentials(session.getIdToken()));
        });
      } catch (e) { reject(e); }
    }), 20000, 'aws-creds-timeout');
    function clear() { _credsRefreshPromise = null; }
    _credsRefreshPromise.then(clear, clear);
    return _credsRefreshPromise;
  }

// ==WITHCREDRETRY-INICIO==
// withCredRetry endurecido (2026-09-21; única función existente reescrita):
//  - Fail-fast: si el circuit breaker de db está abierto, rechaza en ~1 ms
//    con un error claro en vez de colgar hasta 25 s por intento.
//  - Reintento con backoff exponencial + jitter (base 300 ms, tope 8 s,
//    3 reintentos) SOLO para errores 'retryable' (red, throttling, timeout).
//  - Credenciales: se refrescan UNA vez, como antes.
//  - 'nonretryable' (4xx, validación, lógica de app) falla de inmediato y
//    NO abre el circuito. TransactionCanceledException la sigue manejando
//    transaction() con su propio reintento (no se duplica aquí).
function withCredRetry(opFn) {
  var brk = circuitRegistry.db;
  function circuitOpenError() {
    return new Error('db/circuit-open: el servicio de datos no responde; reintenta en unos segundos');
  }
  // Fail-fast: circuito abierto -> rechazo inmediato, 0 llamadas a la red.
  if (brk.isOpen()) return Promise.reject(circuitOpenError());
  // En half-open solo pasa un probe; el resto sigue en fail-fast.
  var holdsProbe = false;
  if (brk.state() === 'half-open') {
    if (!brk.allowProbe()) return Promise.reject(circuitOpenError());
    holdsProbe = true;
  }
  function run() {
    try { return opFn(); }
    catch (e) { return Promise.reject(e); }
  }
  function settledOk(v) {
    brk.recordSuccess();
    return v;
  }
  function settledErr(err) {
    var cls = classifyDbError(err);
    if (cls === 'retryable') {
      brk.recordFailure(err);
    } else if (holdsProbe) {
      brk.releaseProbe(); // el probe terminó sin veredicto de caída
    }
    throw err;
  }
  function attempt(n, credRefreshed) {
    return run().catch(function (err) {
      var cls = classifyDbError(err);
      if (cls === 'credential') {
        // Comportamiento original: una sola oportunidad de refrescar.
        if (credRefreshed || !currentCognitoUser) return settledErr(err);
        return refreshAwsCredentialsNow().then(
          function () { return attempt(n, true); },
          function () { return settledErr(err); }
        );
      }
      if (cls === 'retryable' && n < REL_MAX_RETRIES) {
        return relSleep(relBackoffMs(n)).then(function () { return attempt(n + 1, credRefreshed); });
      }
      return settledErr(err);
    });
  }
  return attempt(0, false).then(settledOk, settledErr);
}
// ==WITHCREDRETRY-FIN==

  function queryAll(params) {
    return withCredRetry(function () {
      var dc = getDocClient();
      var items = [];
      function loop(lastKey) {
        // PERF 2026-09-21: lecturas de consistencia eventual (default de
        // DynamoDB). El ConsistentRead:true anterior duplicaba el costo de
        // RCU y subía la latencia p99 en cada polling; la app ya está
        // diseñada para eventualidad (eco local + polling 3s) y
        // transaction() reintenta ante lecturas obsoletas.
        var p = Object.assign({ ConsistentRead: false }, params);
        if (lastKey) p.ExclusiveStartKey = lastKey;
        return dbTimeout(dc.query(p).promise(), 'db-query-timeout').then(function (res) {
          items = items.concat(res.Items || []);
          if (res.LastEvaluatedKey) return loop(res.LastEvaluatedKey);
          return items;
        });
      }
      return loop(null);
    });
  }

  function batchWriteAll(requests) {
    if (!requests.length) return Promise.resolve();
    return withCredRetry(function () {
      var dc = getDocClient();
      var TABLE = AWS_CONFIG.tableName;
      var attempt = 0;
      function sendBatch(batch) {
        var params = { RequestItems: {} };
        params.RequestItems[TABLE] = batch;
        return dbTimeout(dc.batchWrite(params).promise(), 'db-write-timeout').then(function (res) {
          var unp = (res.UnprocessedItems && res.UnprocessedItems[TABLE]) || [];
          if (unp.length && attempt < 3) { attempt++; return sendBatch(unp); }
          if (unp.length) throw new Error('DynamoDB: quedaron escrituras sin procesar');
        });
      }
      var chain = Promise.resolve();
      for (var i = 0; i < requests.length; i += 25) {
        (function (batch) { chain = chain.then(function () { return sendBatch(batch); }); })(requests.slice(i, i + 25));
      }
      return chain;
    });
  }

  // DynamoDB no permite cadenas vacías en las claves: las rutas de un solo
  // segmento (p. ej. 'userCount') se guardan con este centinela como sort key,
  // y se traduce de vuelta al leer. Ningún segmento real usa '#'.
  var EMPTY_SK = '#';
  function normSk(sk) { return (sk === '' || sk === null || sk === undefined) ? EMPTY_SK : sk; }

  function putLeaf(pk, sk, value) {
    return {
      PutRequest: { Item: { pk: pk, sk: normSk(sk), v: JSON.stringify(value === undefined ? null : value) } }
    };
  }
  function deleteKey(pk, sk) {
    return { DeleteRequest: { Key: { pk: pk, sk: normSk(sk) } } };
  }
  // Put condicional de una hoja: solo escribe si el valor actual en 'v' sigue
  // siendo expectedJson (o si la hoja no existe cuando expectedJson es null).
  // Es la primitiva que da atomicidad real a transaction() en hojas escalares.
  function putLeafConditional(pk, sk, jsonValue, expectedJson) {
    var params = {
      TableName: AWS_CONFIG.tableName,
      Item: { pk: pk, sk: normSk(sk), v: jsonValue },
      ExpressionAttributeNames: { '#v': 'v' },
      ExpressionAttributeValues: { ':exp': expectedJson }
    };
    if (expectedJson === null) {
      // snap.val() devuelve null tanto si la hoja no existe como si guarda
      // el JSON null; en ambos casos la v almacenada es inexistente o la
      // cadena "null" (JSON.stringify(null)). Comparar contra la cadena,
      // no contra el tipo NULL de DynamoDB (una v='null' nunca iguala NULL).
      params.ExpressionAttributeValues = { ':exp': 'null' };
      params.ConditionExpression = 'attribute_not_exists(pk) OR #v = :exp';
    } else {
      params.ConditionExpression = '#v = :exp';
    }
    return withCredRetry(function () { return dbTimeout(getDocClient().put(params).promise(), 'db-put-timeout'); });
  }

  // Transacción multi-hoja con atomicidad real (DynamoDB transact_write_items):
  // cada hoja se escribe o borra solo si su valor crudo sigue siendo el que
  // se leyó; si otra escritura se adelantó, toda la transacción se aborta de
  // forma atómica. Límite de DynamoDB: 100 hojas por transacción.
  function transactObjectLeaves(segs, oldLeaves, newValue) {
    var oldMap = {}; // sk relativo a segs -> json crudo almacenado
    oldLeaves.forEach(function (l) {
      oldMap[l.segs.slice(segs.length).join('/')] = JSON.stringify(l.value);
    });
    var newMap = {};
    flatten(newValue, []).forEach(function (l) {
      newMap[l.segs.join('/')] = JSON.stringify(l.value);
    });
    var items = [];
    var sk;
    var skPrefix = segs.slice(1).join('/');
    function fullSk(rel) { return normSk(skPrefix ? skPrefix + '/' + rel : rel); }
    for (sk in newMap) {
      var put = { Put: {
        TableName: AWS_CONFIG.tableName,
        Item: { pk: segs[0], sk: fullSk(sk), v: newMap[sk] }
      } };
      if (Object.prototype.hasOwnProperty.call(oldMap, sk)) {
        put.Put.ConditionExpression = '#v = :old';
        put.Put.ExpressionAttributeNames = { '#v': 'v' };
        put.Put.ExpressionAttributeValues = { ':old': oldMap[sk] };
      } else {
        put.Put.ConditionExpression = 'attribute_not_exists(pk)';
      }
      items.push(put);
    }
    for (sk in oldMap) {
      if (Object.prototype.hasOwnProperty.call(newMap, sk)) continue;
      items.push({ Delete: {
        TableName: AWS_CONFIG.tableName,
        Key: { pk: segs[0], sk: fullSk(sk) },
        ConditionExpression: '#v = :old',
        ExpressionAttributeNames: { '#v': 'v' },
        ExpressionAttributeValues: { ':old': oldMap[sk] }
      } });
    }
    if (!items.length) return Promise.resolve();
    return withCredRetry(function () {
      return dbTimeout(getDocClient().transactWrite({ TransactItems: items }).promise(), 'db-transact-timeout');
    });
  }

  // Lee todas las hojas bajo una ruta (hoja exacta + descendientes).
  // Usa begins_with(sk, 'ruta/') para no confundir 'abc' con 'abc2'.
  // Fase 1: localiza los prefijos (push IDs) más recientes con un Query en
  // reversa proyectando SOLO sk (items de ~30 bytes: 1 página típica).
  // Fase 2: lee en paralelo solo las hojas de esos prefijos. Costo acotado
  // por N, independiente del tamaño total de la tabla.
  // Cota superior de pushId para un timestamp: los ids estilo push llevan el
  // tiempo en sus primeros 8 caracteres (base64 propio, ver newPushId), así
  // que todo id con tiempo <= ts ordena estrictamente antes que esta cota
  // (los 12 caracteres de sufijo son el mínimo '-'). Permite paginar "los N
  // anteriores a X" con una condición sobre sk, sin descargar el pk completo.
  // OVERLAP ANTI CLOCK-SKEW (delta-sync): los push IDs llevan el reloj del
  // dispositivo escritor en sus primeros 8 caracteres. Si un par tiene el
  // reloj adelantado, su senal avanza _deltaSk y una senal posterior con
  // timestamp menor (reloj atrasado o escritura retrasada) quedaria por
  // debajo del watermark y se perderia para siempre (offers/answers/ICE
  // de WebRTC rotos en silencio). Para evitarlo, cada ciclo delta re-pide
  // una ventana de ~15s por debajo del maximo visto. El dedup de
  // dispatchSnapshot (l.kids) evita re-disparar lo ya procesado, y el
  // BETWEEN de DynamoDB ya es inclusivo (re-descarga fromSk cada ciclo),
  // asi que el solape no cambia la semantica de entrega: solo ensancha el
  // rango por abajo. Ante cualquier anomalia en el formato, se usa la
  // cota original sin solape (comportamiento previo).
  var DELTA_OVERLAP_MS = 15000;
  function pushIdTime(id) {
    var t = 0;
    for (var i = 0; i < 8; i++) {
      var c = PUSH_CHARS.indexOf(id.charAt(i));
      if (c < 0) return null;
      t = t * 64 + c;
    }
    return t;
  }
  function pushIdLowerBound(ts) {
    var now = Math.floor(Number(ts) || 0);
    if (now < 0) now = 0;
    var timeStampChars = new Array(8);
    for (var i = 7; i >= 0; i--) {
      timeStampChars[i] = PUSH_CHARS.charAt(now % 64);
      now = Math.floor(now / 64);
    }
    // Sufijo minimo: la menor clave posible con ese timestamp.
    return timeStampChars.join('') + '------------';
  }
  function deltaFromSk(minSk) {
    if (typeof minSk !== 'string' || minSk.length < 8) return minSk;
    var t = pushIdTime(minSk);
    if (t === null) return minSk;
    return pushIdLowerBound(t - DELTA_OVERLAP_MS);
  }
  function pushIdUpperBound(ts) {
    var now = Math.floor(Number(ts) || 0) + 1;
    var timeStampChars = new Array(8);
    for (var i = 7; i >= 0; i--) {
      timeStampChars[i] = PUSH_CHARS.charAt(now % 64);
      now = Math.floor(now / 64);
    }
    return timeStampChars.join('') + '------------';
  }

  function readLeavesBounded(pk, limitN, endAt) {
    var want = Math.ceil(limitN * 1.5) + 10;
    // communityNotes: los posts viejos guardan las fotos como data URLs inline
    // (hasta ~300KB c/u, 20 por post). Descargarlas en cada polling (cada 3 s)
    // saturaba la red del telefono y el feed tardaba una eternidad en cargar.
    // La fase 2 EXCLUYE esos bytes con FilterExpression; la fase 1 anota solo
    // las KEYS de imagen por post (pocos bytes) y las fotos se cargan bajo
    // demanda al pintar la tarjeta (ver hydrateLegacyNoteImages en index.html).
    var lightImages = (pk === 'communityNotes');
    var wantScan = lightImages ? want + 3 : want;
    // PERF ciclo 8 H4: la fase 1 es el detector de cambios de la válvula de
    // huella (abajo): acotarla con Limit como hace readLeavesBoundedPrefix
    // para no traer páginas de 1 MB en cada ciclo de polling. El bucle ya
    // pagina con LastEvaluatedKey hasta reunir wantScan prefijos, así el
    // conjunto de prefijos (y por tanto la huella) es idéntico al de antes:
    // solo cambia cuántos ítems lee cada query de fase 1.
    var phase1Limit = Math.max(100, wantScan * 10);
    var phase1sks = []; // H4: todos los sk vistos en fase 1 (huella de cambio)
    // Paginación "cargar anteriores": endAt (timestamp) se traduce a cota de
    // pushId (misma hipótesis de correlación tiempo/pushId que el path sin
    // endAt). Sin esto, cada "cargar anteriores" descargaba el pk COMPLETO.
    var endSk = (endAt === undefined || endAt === null) ? null : pushIdUpperBound(endAt);
    var prefixes = [];
    var seen = {};
    var imgKeysByPrefix = {}; // pfx -> ['imageUrls/0', ...] o ['imageUrl']
    function phase1(lastKey) {
      var p = {
        TableName: AWS_CONFIG.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ProjectionExpression: 'sk',
        ScanIndexForward: false,
        Limit: phase1Limit // H4: acotar la fase 1 (ver arriba)
      };
      // La cota endAt se aplica en el SERVIDOR (KeyConditionExpression), no
      // solo saltando en cliente: si hay mucho contenido más nuevo que endAt,
      // DynamoDB lo poda sin leerlo (las key conditions no consumen RCU en
      // los ítems descartados). Equivale al filtro cliente de abajo porque
      // todo sk es '<pushId>/...' y endSk es cota superior estricta de pushId.
      if (endSk) {
        p.KeyConditionExpression = 'pk = :pk AND sk < :endSk';
        p.ExpressionAttributeValues[':endSk'] = endSk;
      }
      if (lastKey) p.ExclusiveStartKey = lastKey;
      return withCredRetry(function () {
        return dbTimeout(getDocClient().query(p).promise(), 'db-query-timeout');
      }).then(function (res) {
        var arr = res.Items || [];
        for (var i = 0; i < arr.length; i++) {
          var sk = (arr[i].sk === undefined || arr[i].sk === null) ? '' : String(arr[i].sk);
          var first = sk.split('/')[0];
          if (endSk && first >= endSk) continue; // más nuevo que endAt: saltar
          if (!first) continue; // H4: espejo de H3 (la huella no cubre sk vacíos)
          phase1sks.push(sk); // H4: huella (antes del filtro seen: cubre atributos)
          if (!seen[first]) { seen[first] = 1; prefixes.push(first); }
          if (lightImages && first) {
            var rel = sk.slice(first.length + 1);
            if (rel === 'imageUrl' || rel === 'imageUrls' || rel.indexOf('imageUrls/') === 0) {
              (imgKeysByPrefix[first] = imgKeysByPrefix[first] || []).push(rel);
            }
          }
          if (prefixes.length >= wantScan) break;
        }
        if (prefixes.length < wantScan && res.LastEvaluatedKey) return phase1(res.LastEvaluatedKey);
        // Con +3 de margen, las keys de imagen de los primeros `want` prefijos
        // estan completas: en orden descendente de sk, todas las hojas de un
        // prefijo vienen antes que la primera hoja del siguiente.
        if (lightImages) prefixes = prefixes.slice(0, want);
        return prefixes;
      });
    }
    function phase2() {
      if (!prefixes.length) return Promise.resolve([]);
      return Promise.all(prefixes.map(function (pfx) {
        var pr = lightImages
          ? readLeavesLight([pk, pfx]).catch(function () { return readLeaves([pk, pfx]); })
          : readLeaves([pk, pfx]);
        return pr.then(function (leaves) {
          if (lightImages && imgKeysByPrefix[pfx] && imgKeysByPrefix[pfx].length) {
            leaves.push({ segs: [pk, pfx, '_imgKeys'], value: sortImgKeys(imgKeysByPrefix[pfx]) });
          }
          return leaves;
        });
      })).then(function (lists) {
        var out = [];
        lists.forEach(function (ll) { out = out.concat(ll); });
        return out;
      });
    }
    // PERF ciclo 8 H4: válvula de huella para el FEED (pk='communityNotes'),
    // con el mismo patrón de H3 en readLeavesBoundedPrefix: la fase 1 (ya
    // acotada con Limit arriba) actúa como detector de cambios. Si la lista
    // de sk es idéntica a la de la última fase 2 y no venció la válvula de
    // staleness (H3_STALE_MS), se reutilizan las hojas cacheadas y se salta
    // la fase 2 (~85 posts × ~10 hojas menos por ciclo en idle).
    // La huella cubre TODOS los sk vistos en fase 1: posts nuevos, borrados y
    // cambios de atributo (p. ej. imagen agregada) la invalidan de inmediato y
    // la fase 2 corre en ese mismo ciclo (~3 s, igual que antes). Los cambios
    // puros de valor sin tocar atributos (votos, contadores, texto editado,
    // votos de encuesta) no mueven los sk: la válvula fuerza una fase 2
    // completa cada 30 s para que ningún child_changed quede tragado para
    // siempre (retraso acotado, no pérdida; mismo trade-off aceptado en H3).
    // Las escrituras LOCALES invalidan el caché vía notifyLocal (ver
    // invalidateBoundedPrefixCache con prefixSeg ''), así el eco local
    // re-renderiza al instante. Solo aplica al feed; otros callers de
    // readLeavesBounded (p. ej. musicSearch) conservan el camino viejo intacto.
    var useFeedCache = (pk === 'communityNotes');
    var feedCacheKey = 'FEEDv1\n' + pk + '\n' + limitN + '\n' +
      ((endAt === undefined || endAt === null) ? '' : String(endAt));
    return phase1(null).then(function () {
      if (!useFeedCache) return phase2();
      var fp = phase1sks.join('\n');
      var now = Date.now();
      var hit = _boundedPrefixCache[feedCacheKey];
      if (hit && hit.fp === fp && (now - hit.ts) < H3_STALE_MS) {
        return hit.leaves;
      }
      return phase2().then(function (leaves) {
        _boundedPrefixCacheStore(feedCacheKey, { pk: pk, prefixSeg: '', fp: fp, leaves: leaves, ts: now });
        return leaves;
      });
    });
  }

  // PERF 2026-09-23: variante acotada de readLeavesBounded para rutas de 2
  // segmentos (pk + prefijo) con hijos push ID: p. ej.
  // conversationMessages/<id> + limitToLast(80) de la sala de chat.
  // Fase 1: localiza los hijos más nuevos con un escaneo ligero (solo sk,
  // orden descendente, con Limit para no traer páginas de 1 MB). Fase 2:
  // lee SOLO esos hijos con un único rango BETWEEN sobre la sort key.
  // El costo por ciclo queda acotado a ~los N pedidos en vez de crecer con
  // la conversación (conversaciones con menos de N mensajes leen lo mismo
  // que antes: no hay regresión en salas pequeñas).
  // Margen: sin orderBy o con orderByKey no hace falta margen (el orden por
  // clave ES el criterio del límite); con orderBy timestamp/createdAt se usa
  // el mismo margen anti-skew que readLeavesBounded (1.5x+10).
  // endAt (clave, p. ej. paginación "anteriores" de comentarios) se aplica
  // como cota superior de hijo en la fase 1.
  // NOTA: la búsqueda dentro del chat (limitToLast(300) por tecla) ahora
  // cubre los últimos ~460 mensajes en vez del historial completo.
  // PERF ciclo 8 H3: caché de fase 2 para lecturas acotadas bajo prefijo
  // (conversationMessages/<id>, notifications/<uid>, fiestas/<id>/chat).
  // Cada ciclo de polling (3 s) corría la 2-fase completa aunque no hubiera
  // nada nuevo (~900 RCU/ciclo en salas de chat). Ahora la fase 1 (barata:
  // solo proyecta sk) actúa como detector de cambios: si la lista de sk es
  // idéntica a la de la última fase 2, se reutilizan las hojas cacheadas y
  // se salta la fase 2 (~450 RCU menos por ciclo en idle).
  // La huella cubre TODOS los sk de la fase 1 (no solo los nombres de hijo):
  // altas, bajas y cambios de atributos (editedAt, deletedForAll, borrado de
  // imágenes) la invalidan de inmediato y la fase 2 corre en ese mismo ciclo
  // (mensajes nuevos y borrados/ediciones estructurales llegan en ~3 s, igual
  // que antes). Los cambios puros de valor sin tocar atributos (p. ej. el
  // segundo edit de texto del mismo mensaje) no mueven los sk: una válvula
  // de staleness fuerza una fase 2 completa cada H3_STALE_MS para que ningún
  // child_changed quede tragado para siempre (retraso acotado, no pérdida).
  // Las escrituras LOCALES invalidan el caché vía notifyLocal, así el eco
  // local (120 ms tras escribir) siempre re-renderiza al instante.
  // El diff por clave de dispatchSnapshot no se toca: recibe el mismo
  // snapshot que recibiría con la fase 2 y sigue evitando re-renders.
  var _boundedPrefixCache = {}; // key -> { pk, prefixSeg, fp, leaves, ts }
  var H3_STALE_MS = 30000;      // válvula anti-tragado de child_changed
  var H3_CACHE_MAX = 40;        // tope de entradas (una por sala/prefijo)
  function _boundedPrefixCacheKey(pk, prefixSeg, limitN, endAt, skewMargin) {
    return pk + '\n' + prefixSeg + '\n' + limitN + '\n' +
      ((typeof endAt === 'string' && endAt) ? endAt : '') + '\n' +
      (skewMargin ? '1' : '0');
  }
  function invalidateBoundedPrefixCache(changedSegs) {
    if (!changedSegs || !changedSegs.length) return;
    var pk = changedSegs[0];
    var tail = changedSegs.slice(1).join('/');
    Object.keys(_boundedPrefixCache).forEach(function (k) {
      var e = _boundedPrefixCache[k];
      if (!e || e.pk !== pk) return;
      var p = e.prefixSeg;
      // H4: prefixSeg '' = caché del feed (lectura de pk completo): cualquier
      // escritura local bajo el pk la invalida (eco local instantáneo).
      if (p === '' || !tail || tail === p || p.indexOf(tail + '/') === 0 || tail.indexOf(p + '/') === 0) {
        delete _boundedPrefixCache[k];
      }
    });
  }
  function _boundedPrefixCacheStore(key, entry) {
    _boundedPrefixCache[key] = entry;
    var keys = Object.keys(_boundedPrefixCache);
    if (keys.length > H3_CACHE_MAX) {
      // Evicción simple: fuera la entrada más vieja.
      var oldestK = null, oldestT = Infinity;
      keys.forEach(function (k) {
        var t = _boundedPrefixCache[k] && _boundedPrefixCache[k].ts;
        if (t < oldestT) { oldestT = t; oldestK = k; }
      });
      if (oldestK) delete _boundedPrefixCache[oldestK];
    }
  }
  function readLeavesBoundedPrefix(pk, prefixSeg, limitN, endAt, skewMargin) {
    var want = skewMargin ? Math.ceil(limitN * 1.5) + 10 : limitN + 10;
    var prefix = prefixSeg + '/';
    var endKey = (typeof endAt === 'string' && endAt) ? endAt : null;
    var children = [];
    var seen = {};
    var phase1sks = []; // H3: todos los sk vistos en fase 1 (huella de cambio)
    function phase1(lastKey) {
      var p = {
        TableName: AWS_CONFIG.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :pfx)',
        ExpressionAttributeValues: { ':pk': pk, ':pfx': prefix },
        ProjectionExpression: 'sk',
        ScanIndexForward: false,
        Limit: Math.max(100, want * 10)
      };
      if (lastKey) p.ExclusiveStartKey = lastKey;
      return withCredRetry(function () {
        return dbTimeout(getDocClient().query(p).promise(), 'db-query-timeout');
      }).then(function (res) {
        var arr = res.Items || [];
        for (var i = 0; i < arr.length; i++) {
          var sk = (arr[i].sk === undefined || arr[i].sk === null) ? '' : String(arr[i].sk);
          if (sk.indexOf(prefix) !== 0) continue;
          var child = sk.slice(prefix.length).split('/')[0];
          if (!child) continue;
          if (endKey && child > endKey) continue; // paginación: solo hijos <= cursor
          phase1sks.push(sk); // H3: huella (antes del filtro seen: cubre atributos)
          if (seen[child]) continue;
          seen[child] = 1;
          children.push(child);
          if (children.length >= want) break;
        }
        if (children.length < want && res.LastEvaluatedKey) return phase1(res.LastEvaluatedKey);
        return children;
      });
    }
    function phase2() {
      if (!children.length) return Promise.resolve([]);
      var minChild = children[0];
      for (var i = 1; i < children.length; i++) if (children[i] < minChild) minChild = children[i];
      // Con endAt, el ':hi' se cierra en el cursor: con hijos de longitud
      // fija (push IDs) excluye con exactitud a los hijos más nuevos que el
      // cursor. El filtro de abajo es la red de seguridad para hijos de
      // longitud variable. El ':lo' con '/' final impide que el rango alcance
      // otros prefijos.
      var hi = endKey ? prefix + endKey + String.fromCharCode(0xFFFF)
                      : prefix + String.fromCharCode(0xFFFF);
      return queryAll({
        TableName: AWS_CONFIG.tableName,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :lo AND :hi',
        ExpressionAttributeValues: {
          ':pk': pk,
          ':lo': prefix + minChild,
          // U+FFFF: mayor que cualquier char ASCII de los push IDs.
          ':hi': hi
        }
      }).then(function (items) {
        var out = [];
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          var rawSk = (it.sk === undefined || it.sk === null) ? '' : String(it.sk);
          if (rawSk.indexOf(prefix) !== 0) continue;
          var childSeg = rawSk.slice(prefix.length).split('/')[0];
          if (endKey && childSeg > endKey) continue; // red de seguridad
          var skSegs = rawSk.split('/').filter(function (s) { return s !== ''; });
          var v;
          try { v = JSON.parse(it.v); } catch (e) { v = null; }
          out.push({ segs: [pk].concat(skSegs), value: v });
        }
        return out;
      });
    }
    // H3: la fase 1 ya corrió; si nada cambió desde la última fase 2, se
    // reutilizan sus hojas sin pagar la fase 2. Si la huella cambió (hijo
    // nuevo/eliminado o atributo agregado/quitado) o la válvula de staleness
    // venció, la fase 2 corre y el caché se refresca.
    var cacheKey = _boundedPrefixCacheKey(pk, prefixSeg, limitN, endAt, skewMargin);
    return phase1(null).then(function () {
      var fp = phase1sks.join('\n');
      var now = Date.now();
      var hit = _boundedPrefixCache[cacheKey];
      if (hit && hit.fp === fp && (now - hit.ts) < H3_STALE_MS) {
        return hit.leaves;
      }
      return phase2().then(function (leaves) {
        _boundedPrefixCacheStore(cacheKey, { pk: pk, prefixSeg: prefixSeg, fp: fp, leaves: leaves, ts: now });
        return leaves;
      });
    });
  }

  // Orden natural para las keys de imagen: imageUrls/0, imageUrls/1, ...,
  // imageUrls/10 (no lexicografico, que pondria el 10 antes que el 2).
  function sortImgKeys(keys) {
    return keys.slice().sort(function (a, b) {
      var na = parseInt(String(a).split('/')[1], 10);
      var nb = parseInt(String(b).split('/')[1], 10);
      var aNum = !isNaN(na), bNum = !isNaN(nb);
      if (aNum && bNum && na !== nb) return na - nb;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
  }

  // Variante liviana de readLeaves para el feed: lee las hojas bajo el prefijo
  // EXCLUYENDO los bytes de imagen inline (imageUrl*), que son los que volvian
  // lento cada polling. Las fotos se cargan bajo demanda al ver el post.
  function readLeavesLight(segs) {
    var pk = segs[0];
    var skExact = segs.slice(1).join('/');
    return queryAll({
      TableName: AWS_CONFIG.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :pfx)',
      FilterExpression: 'NOT contains(sk, :img)',
      ExpressionAttributeValues: { ':pk': pk, ':pfx': skExact + '/', ':img': '/imageUrl' }
    }).then(function (items) {
      return items.map(function (it) {
        var rawSk = (it.sk === undefined || it.sk === null) ? '' : String(it.sk);
        if (rawSk === EMPTY_SK) rawSk = ''; // centinela de ruta de un segmento
        var skSegs = rawSk.split('/').filter(function (s) { return s !== ''; });
        var v;
        try { v = JSON.parse(it.v); } catch (e) { v = null; }
        return { segs: [pk].concat(skSegs), value: v };
      });
    });
  }

  // Búsqueda por prefijo de clave ACOTADA en DynamoDB: KeyConditionExpression
  // pk = :pk AND begins_with(sk, :pfx) con Limit real (sin paginar de más).
  // Antes, consultas como users.orderByChild('username').startAt(q)...
  // .limitToFirst(20) descargaban el pk COMPLETO y filtraban en el cliente.
  // Se usa para el índice usernames/ (orderByKey + startAt + limitToFirst):
  // solo viajan las entradas cuyo nombre empieza por el prefijo.
  function queryPrefixBounded(pk, prefix, limitN) {
    var want = Math.max(1, Math.ceil(limitN));
    var dc = getDocClient();
    var items = [];
    function loop(lastKey) {
      var p = {
        TableName: AWS_CONFIG.tableName,
        ConsistentRead: false,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :pfx)',
        ExpressionAttributeValues: { ':pk': pk, ':pfx': String(prefix) },
        ProjectionExpression: 'sk, v',
        Limit: want - items.length,
        ScanIndexForward: true
      };
      if (lastKey) p.ExclusiveStartKey = lastKey;
      return withCredRetry(function () {
        return dbTimeout(dc.query(p).promise(), 'db-query-timeout');
      }).then(function (res) {
        items = items.concat(res.Items || []);
        if (items.length < want && res.LastEvaluatedKey) return loop(res.LastEvaluatedKey);
        return items.slice(0, want);
      });
    }
    return loop(null).then(function (its) {
      var out = [];
      its.forEach(function (it) {
        var rawSk = (it.sk === undefined || it.sk === null) ? '' : String(it.sk);
        var skSegs = rawSk.split('/').filter(function (s) { return s !== ''; });
        // Solo hojas exactas del índice (sk sin '/'): un nombre de usuario
        // nunca contiene '/', así que los sub-paths no son entradas válidas.
        if (skSegs.length !== 1) return;
        var v;
        try { v = JSON.parse(it.v); } catch (e) { v = null; }
        out.push({ segs: [pk].concat(skSegs), value: v });
      });
      return out;
    });
  }

  function readLeaves(segs, query) {
    if (!segs.length) return Promise.reject(new Error('Ruta vacía no soportada'));
    var pk = segs[0];
    var skExact = segs.slice(1).join('/');
    // Lectura ACOTADA "últimos N por tiempo": orderByChild('timestamp'|
    // 'createdAt') + limitToLast(N), sin otros filtros. Los push IDs ordenan
    // lexicográficamente por tiempo de creación (newPushId), así que los N
    // más recientes por pushId son los N más recientes por timestamp. En vez
    // de descargar el pk COMPLETO en cada polling (crece sin cota con la
    // tabla), se localizan los prefijos más nuevos con un escaneo ligero
    // (solo sk) y luego se leen únicamente esos posts/pistas. El applyQuery
    // posterior ordena por el campo real y aplica el límite exacto.
    if (segs.length === 1 && query && typeof query.limitLast === 'number' && query.limitLast > 0 &&
        !query.limitFirst && !query.orderByKey &&
        (query.orderBy === 'timestamp' || query.orderBy === 'createdAt') &&
        query.equalTo === undefined && query.startAt === undefined) {
      return readLeavesBounded(pk, query.limitLast, query.endAt);
    }
    // PERF 2026-09-23: lectura ACOTADA bajo prefijo de 2 segmentos con
    // limitToLast (p. ej. conversationMessages/<id> de la sala de chat, o
    // notifications/<uid> del badge). ANTES: se descargaban TODAS las hojas
    // bajo el prefijo en cada ciclo de polling (3 s) y applyQuery recortaba
    // a N en cliente: abrir una sala con M mensajes costaba O(M) hojas por
    // ciclo, sin cota. Mismo contrato de hijos push ID que la rama de arriba;
    // con otro orderBy se conserva la lectura completa (p. ej.
    // userConversations ordenado por updatedAt, cuyas claves NO son push ID).
    if (segs.length === 2 && query && typeof query.limitLast === 'number' && query.limitLast > 0 &&
        !query.limitFirst && query.equalTo === undefined && query.startAt === undefined &&
        (query.orderByKey || query.orderBy === undefined ||
         query.orderBy === 'timestamp' || query.orderBy === 'createdAt')) {
      var skewMargin = !query.orderByKey && query.orderBy !== undefined;
      return readLeavesBoundedPrefix(pk, segs[1], query.limitLast, query.endAt, skewMargin);
    }
    // PERF 2026-09-23 (ciclo 7, H1): lectura ACOTADA bajo prefijo de 3
    // segmentos con limitToLast (chat de fiestas: fiestas/<id>/chat +
    // limitToLast(50) del oyente child_added de la sala). ANTES: cada ciclo
    // de polling (3 s) descargaba TODAS las hojas bajo el prefijo con
    // begins_with (sin cota: crece con la duración de la fiesta; cada
    // mensaje = ~5 ítems) y applyQuery recortaba a N en el cliente. Ahora se
    // reutiliza la variante acotada de 2 fases con el prefijo compuesto
    // '<id>/chat' (los hijos siguen siendo push IDs ordenados por tiempo):
    // el costo por ciclo queda acotado a ~los N pedidos, igual que en la
    // rama de 2 segmentos. Con otras formas de consulta (filtros,
    // limitToFirst, orderBy no temporal) se conserva la lectura completa.
    if (segs.length === 3 && query && typeof query.limitLast === 'number' && query.limitLast > 0 &&
        !query.limitFirst && query.equalTo === undefined && query.startAt === undefined &&
        (query.orderByKey || query.orderBy === undefined ||
         query.orderBy === 'timestamp' || query.orderBy === 'createdAt')) {
      var skewMargin3 = !query.orderByKey && query.orderBy !== undefined;
      return readLeavesBoundedPrefix(pk, segs[1] + '/' + segs[2], query.limitLast, query.endAt, skewMargin3);
    }
    var jobs;
    if (skExact === '') {
      jobs = [queryAll({
        TableName: AWS_CONFIG.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk }
      })];
    } else {
      jobs = [
        queryAll({
          TableName: AWS_CONFIG.tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :pfx)',
          ExpressionAttributeValues: { ':pk': pk, ':pfx': skExact + '/' }
        }),
        withCredRetry(function () {
          // PERF 2026-09-21: consistencia eventual también aquí (ver nota en queryAll).
          return dbTimeout(getDocClient().get({
            TableName: AWS_CONFIG.tableName,
            Key: { pk: pk, sk: skExact },
            ConsistentRead: false
          }).promise(), 'db-get-timeout').then(function (res) { return res.Item ? [res.Item] : []; });
        })
      ];
    }
    return Promise.all(jobs).then(function (parts) {
      var items = parts[0].concat(parts[1] || []);
      return items.map(function (it) {
        var rawSk = (it.sk === undefined || it.sk === null) ? '' : String(it.sk);
        if (rawSk === EMPTY_SK) rawSk = ''; // centinela de ruta de un segmento
        var skSegs = rawSk.split('/').filter(function (s) { return s !== ''; });
        var v;
        try { v = JSON.parse(it.v); } catch (e) { v = null; }
        return { segs: [pk].concat(skSegs), value: v };
      });
    });
  }

  // DELTA-SYNC (parche parcial 2026-09-21): lee solo las hojas NUEVAS bajo un
  // prefijo (sk > fromSk) con un rango BETWEEN sobre la sort key. Solo válido
  // para rutas append-only con hijos push ID (orden temporal lexicográfico,
  // ver newPushId): p. ej. fiestaSignals/<id>/<uid> (bandeja WebRTC).
  // La query BETWEEN vacía (sin señales nuevas, el caso común cada 800 ms)
  // consume ~0 RCU en vez de re-descargar la bandeja completa.
  // LÍMITES DEL PARCHE (diseño completo en el reporte): no sirve para
  // child_changed/removed ni para rutas con hijos de orden no temporal; el
  // delta de 'value' sobre objetos mutables requiere timestamps por hoja
  // (migración de datos) y queda como roadmap.
  function readLeavesDelta(segs, fromSk) {
    var pk = segs[0];
    var prefix = segs.slice(1).join('/') + '/';
    return queryAll({
      TableName: AWS_CONFIG.tableName,
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :lo AND :hi',
      ExpressionAttributeValues: {
        ':pk': pk,
        ':lo': prefix + fromSk,
        ':hi': prefix + '\uFFFF' // mayor que cualquier push ID (ASCII)
      }
    }).then(function (items) {
      return items.map(function (it) {
        var rawSk = (it.sk === undefined || it.sk === null) ? '' : String(it.sk);
        if (rawSk === EMPTY_SK) rawSk = '';
        var skSegs = rawSk.split('/').filter(function (s) { return s !== ''; });
        var v;
        try { v = JSON.parse(it.v); } catch (e) { v = null; }
        return { segs: [pk].concat(skSegs), value: v };
      });
    });
  }

  // Mayor clave hija de un valor ya desplegado (para fijar la línea base).
  function maxChildKeyOf(val) {
    if (!val || typeof val !== 'object') return null;
    var ks = Object.keys(val);
    if (!ks.length) return null;
    var m = ks[0];
    for (var i = 1; i < ks.length; i++) if (ks[i] > m) m = ks[i];
    return m;
  }

  // Mayor sk relativo entre las hojas de una lectura delta.
  function maxSkOfLeaves(leaves, segs) {
    var m = null;
    leaves.forEach(function (l) {
      var rel = l.segs.slice(segs.length).join('/');
      if (rel && (m === null || rel > m)) m = rel;
    });
    return m;
  }

  // Snapshot solo con lo nuevo bajo ref (para oyentes child_added con delta).
  function readRefValueDelta(ref, fromSk) {
    return readLeavesDelta(ref._segs, fromSk).then(function (leaves) {
      var val = unflatten(leaves, ref._segs);
      var key = ref._segs.length ? ref._segs[ref._segs.length - 1] : null;
      return { snap: new DataSnapshot(val, key), maxSk: maxSkOfLeaves(leaves, ref._segs) };
    });
  }

  // Borra todo el subárbol bajo una ruta (incluida la hoja exacta)
  function deleteSubtree(segs) {
    return readLeaves(segs).then(function (leaves) {
      var reqs = leaves.map(function (l) { return deleteKey(l.segs[0], l.segs.slice(1).join('/')); });
      return batchWriteAll(reqs);
    });
  }

  // DataSnapshot

  function DataSnapshot(value, key) {
    this._value = value === undefined ? null : value;
    this.key = key == null ? null : key;
  }
  DataSnapshot.prototype.val = function () { return this._value; };
  DataSnapshot.prototype.exists = function () { return this._value !== null && this._value !== undefined; };
  DataSnapshot.prototype.child = function (path) {
    var v = this._value;
    var segs = splitPath(path);
    for (var i = 0; i < segs.length; i++) {
      if (v === null || v === undefined || typeof v !== 'object') { v = null; break; }
      v = v[segs[i]];
      if (v === undefined) { v = null; break; }
    }
    return new DataSnapshot(v, segs.length ? segs[segs.length - 1] : this.key);
  };
  DataSnapshot.prototype.forEach = function (cb) {
    if (!this.exists() || typeof this._value !== 'object') return false;
    var keys = Object.keys(this._value);
    for (var i = 0; i < keys.length; i++) {
      var r = cb(new DataSnapshot(this._value[keys[i]], keys[i]));
      if (r === true) return true;
    }
    return false;
  };
  DataSnapshot.prototype.numChildren = function () {
    if (!this.exists() || typeof this._value !== 'object') return 0;
    return Object.keys(this._value).length;
  };

  // consultas del lado cliente

  function typeRank(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'boolean') return v ? 2 : 1;
    if (typeof v === 'number') return 3;
    if (typeof v === 'string') return 4;
    return 5;
  }
  function compareVals(a, b) {
    var ra = typeRank(a), rb = typeRank(b);
    if (ra !== rb) return ra - rb;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  // Aplica orderByChild/orderByKey + equalTo/startAt/endAt + limit sobre un objeto ya leído
  function applyQuery(obj, spec) {
    if (obj === null || obj === undefined || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    spec = spec || {};
    var entries = Object.keys(obj).map(function (k) { return [k, obj[k]]; });
    function dimVal(e) {
      if (spec.orderByKey) return e[0];
      if (spec.orderBy !== undefined) {
        var c = e[1];
        return (c !== null && typeof c === 'object' && !Array.isArray(c)) ? c[spec.orderBy] : undefined;
      }
      return e[0];
    }
    if (spec.equalTo !== undefined && (spec.orderBy !== undefined || spec.orderByKey)) {
      entries = entries.filter(function (e) { return dimVal(e) === spec.equalTo; });
    }
    if (spec.startAt !== undefined) {
      entries = entries.filter(function (e) {
        var d = dimVal(e);
        return d !== undefined && compareVals(d, spec.startAt) >= 0;
      });
    }
    if (spec.endAt !== undefined) {
      entries = entries.filter(function (e) {
        var d = dimVal(e);
        return d !== undefined && compareVals(d, spec.endAt) <= 0;
      });
    }
    var ordered = (spec.orderBy !== undefined || spec.orderByKey);
    entries.sort(function (x, y) {
      if (ordered) {
        var c = compareVals(dimVal(x), dimVal(y));
        if (c !== 0) return c;
      }
      return x[0] < y[0] ? -1 : (x[0] > y[0] ? 1 : 0);
    });
    if (spec.limitFirst !== undefined) entries = entries.slice(0, spec.limitFirst);
    if (spec.limitLast !== undefined) entries = entries.slice(Math.max(0, entries.length - spec.limitLast));
    // Sin coincidencias se devuelve val() === null y exists() === false
    // (nunca un objeto vacío). Devolver {} aquí rompía la verificación de
    // disponibilidad de usernames (todo aparecía "en uso"), los estados
    // "vacío" de solicitudes/notas y el bloqueo de correcciones duplicadas.
    if (!entries.length) return null;
    var out = {};
    entries.forEach(function (e) { out[e[0]] = e[1]; });
    return out;
  }

  // oyentes (polling + eco local)

  var listeners = [];
  var pollTimer = null;
  var fastTimer = null; // ciclo de 800ms solo para señalización WebRTC (fiestas)

  function pathsOverlap(a, b) {
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function readRefValue(ref) {
    var q = ref._query || {};
    // Índice notesByAuthor: las consultas "posts de un autor" descargaban
    // communityNotes COMPLETO (todos los posts de todos) y filtraban en el
    // cliente, lo que dejaba los perfiles colgados en "Cargando..." y
    // saturaba la red en cada polling de 3 s. Ahora se lee el índice
    // pequeño del autor y solo se descargan sus posts.
    if (ref._segs.length === 1 && ref._segs[0] === 'communityNotes' &&
        q.orderBy === 'authorId' && q.equalTo !== undefined &&
        q.startAt === undefined && q.endAt === undefined) {
      return readNotesByAuthor(q.equalTo, queryLimit(q)).then(function (val) {
        val = applyQuery(val, ref._query);
        return new DataSnapshot(val, 'communityNotes');
      });
    }
    // Índice musicByAuthor: las consultas "pistas de un autor" descargaban
    // musicTracks COMPLETO (todas las canciones de todos) y filtraban en el
    // cliente, lo que dejaba "Tu música" en "Cargando..." eterno. Ahora se
    // lee el índice pequeño del autor y solo se descargan sus pistas.
    if (ref._segs.length === 1 && ref._segs[0] === 'musicTracks' &&
        q.orderBy === 'authorId' && q.equalTo !== undefined &&
        q.startAt === undefined && q.endAt === undefined) {
      return readMusicTracksByAuthor(q.equalTo, queryLimit(q)).then(function (val) {
        val = applyQuery(val, ref._query);
        return new DataSnapshot(val, 'musicTracks');
      });
    }
    // Índices postsByGroup / postsByFiesta: "posts del grupo" y "terminar
    // fiesta" descargaban communityNotes COMPLETO en cada apertura.
    if (ref._segs.length === 1 && ref._segs[0] === 'communityNotes' &&
        (q.orderBy === 'groupId' || q.orderBy === 'fiestaId') && q.equalTo !== undefined &&
        q.startAt === undefined && q.endAt === undefined) {
      var dimIdxPk = (q.orderBy === 'groupId') ? 'postsByGroup' : 'postsByFiesta';
      var dimLim = (typeof q.limitLast === 'number' && q.limitLast > 0) ? q.limitLast : 200;
      return readPostsByDimIndex(dimIdxPk, q.orderBy, q.equalTo, dimLim).then(function (val) {
        val = applyQuery(val, ref._query);
        return new DataSnapshot(val, 'communityNotes');
      });
    }
    // Índice de búsqueda de música: cada tecla descargaba musicTracks
    // completo (con portadas). Incluye backfill único.
    if (ref._segs.length === 1 && ref._segs[0] === 'musicSearch' &&
        q.orderBy === 'createdAt' && typeof q.limitLast === 'number' && q.limitLast > 0 &&
        !q.limitFirst && !q.orderByKey &&
        q.equalTo === undefined && q.startAt === undefined && q.endAt === undefined) {
      return readMusicSearchIndex(q.limitLast).then(function (val) {
        val = applyQuery(val, ref._query);
        return new DataSnapshot(val, 'musicSearch');
      });
    }
    // Índice verifiedUsers: la caché de insignias descargaba users completo
    // en cada login. Incluye backfill único.
    if (ref._segs.length === 1 && ref._segs[0] === 'verifiedUsers' &&
        !q.orderBy && !q.orderByKey) {
      return readVerifiedUsersIndex().then(function (val) {
        if (ref._query) val = applyQuery(val, ref._query);
        return new DataSnapshot(val, 'verifiedUsers');
      });
    }
    // Búsqueda de usuarios por prefijo sobre el índice usernames/: antes
    // descargaba users COMPLETO en cada tecla. Acota en DynamoDB con
    // begins_with; el llamador hidrata solo los perfiles coincidentes.
    if (ref._segs.length === 1 && ref._segs[0] === 'usernames' && q.orderByKey &&
        q.startAt !== undefined && q.equalTo === undefined &&
        typeof q.limitFirst === 'number' && q.limitFirst > 0) {
      return queryPrefixBounded('usernames', q.startAt, q.limitFirst).then(function (leaves) {
        var val = unflatten(leaves, ['usernames']);
        if (ref._query) val = applyQuery(val, ref._query);
        return new DataSnapshot(val, 'usernames');
      });
    }
    // Lectura exacta usernames/<nombre>: con backfill global único si el
    // nombre no está indexado (usuario legacy). Elimina el "respaldo" que
    // descargaba users completo en cada tecla del registro.
    if (ref._segs.length === 2 && ref._segs[0] === 'usernames' &&
        !q.orderBy && !q.orderByKey) {
      return readUsernameEntry(ref._segs[1]).then(function (val) {
        return new DataSnapshot(val, ref._segs[1]);
      });
    }
    return readLeaves(ref._segs, ref._query).then(function (leaves) {
      var val = unflatten(leaves, ref._segs);
      if (ref._query) val = applyQuery(val, ref._query);
      var key = ref._segs.length ? ref._segs[ref._segs.length - 1] : null;
      return new DataSnapshot(val, key);
    });
  }

  // Límite de la consulta para recortar ANTES de hidratar documentos: con
  // orderBy+equalTo, applyQuery ordena por clave cuando los valores del
  // campo son iguales, así que recortar por orden de clave da el mismo
  // conjunto que applyQuery recortaría después (pero sin descargar todo).
  function queryLimit(q) {
    if (q && typeof q.limitFirst === 'number' && q.limitFirst > 0) return { first: q.limitFirst };
    if (q && typeof q.limitLast === 'number' && q.limitLast > 0) return { last: q.limitLast };
    return null;
  }
  function applyLimitSpec(ids, limitSpec) {
    if (!limitSpec) return ids;
    var sorted = ids.slice().sort(function (a, b) { return a < b ? -1 : (a > b ? 1 : 0); });
    return limitSpec.first ? sorted.slice(0, limitSpec.first)
                           : sorted.slice(Math.max(0, sorted.length - limitSpec.last));
  }

  // Lee los posts de un autor vía el índice notesByAuthor/<uid>/<postId>.
  // El índice se escribe al crear cada post (ver index.html); para posts
  // anteriores al índice se hace UN backfill (escaneo legacy) y se marca
  // _indexed para no repetirlo. Sin índice ni marca y sin posts => {}
  // (applyQuery -> null).
  function readNotesByAuthor(uid, limitSpec) {
    uid = String(uid);
    return readLeaves(['notesByAuthor', uid]).then(function (leaves) {
      var idx = unflatten(leaves, ['notesByAuthor', uid]) || {};
      var ids = Object.keys(idx).filter(function (k) { return k.charAt(0) !== '_'; });
      if (!ids.length && !idx._indexed) {
        return readLeaves(['communityNotes']).then(function (allLeaves) {
          var all = unflatten(allLeaves, ['communityNotes']) || {};
          var reqs = [];
          var obj = {};
          Object.keys(all).forEach(function (pid) {
            var p = all[pid];
            if (p && typeof p === 'object' && String(p.authorId) === uid) {
              obj[pid] = p;
              reqs.push(putLeaf('notesByAuthor', uid + '/' + pid, { t: p.timestamp || 0 }));
            }
          });
          reqs.push(putLeaf('notesByAuthor', uid + '/_indexed', true));
          batchWriteAll(reqs).catch(function () {});
          return obj;
        });
      }
      // Con límite (p. ej. limitToLast(15) del encabezado del perfil): se
      // hidrata solo lo pedido. Antes se descargaban TODOS los posts del
      // autor para quedarse con 15.
      var take = applyLimitSpec(ids, limitSpec);
      return Promise.all(take.map(function (pid) {
        return readLeaves(['communityNotes', pid]).then(function (ll) {
          return [pid, unflatten(ll, ['communityNotes', pid]) || {}];
        });
      })).then(function (pairs) {
        var obj = {};
        pairs.forEach(function (pr) { obj[pr[0]] = pr[1]; });
        return obj;
      });
    });
  }

  // Lee las pistas de un autor vía el índice musicByAuthor/<uid>/<trackId>.
  // El índice se escribe al subir cada canción; para canciones anteriores al
  // índice se hace UN backfill (escaneo legacy) y se marca _indexed para no
  // repetirlo. Sin índice ni marca y sin pistas => {} (applyQuery -> null).
  function readMusicTracksByAuthor(uid, limitSpec) {
    uid = String(uid);
    return readLeaves(['musicByAuthor', uid]).then(function (leaves) {
      var idx = unflatten(leaves, ['musicByAuthor', uid]) || {};
      var ids = Object.keys(idx).filter(function (k) { return k.charAt(0) !== '_'; });
      // Ordenar por t desc: con limitToLast(N) basta leer los primeros N.
      ids.sort(function (a, b) {
        var ta = (idx[a] && idx[a].t) || 0, tb = (idx[b] && idx[b].t) || 0;
        return tb - ta;
      });
      if (!ids.length && !idx._indexed) {
        return readLeaves(['musicTracks']).then(function (allLeaves) {
          var all = unflatten(allLeaves, ['musicTracks']) || {};
          var reqs = [];
          var obj = {};
          Object.keys(all).forEach(function (tid) {
            var t = all[tid];
            if (t && typeof t === 'object' && String(t.authorId) === uid) {
              obj[tid] = t;
              reqs.push(putLeaf('musicByAuthor', uid + '/' + tid, { t: t.createdAt || 0 }));
            }
          });
          reqs.push(putLeaf('musicByAuthor', uid + '/_indexed', true));
          batchWriteAll(reqs).catch(function () {});
          return obj;
        });
      }
      // Con límite: recortar por orden de clave ANTES de hidratar (igual que
      // applyQuery haría después). Sin esto, "pistas del artista"
      // descargaba TODAS para quedarse con 10.
      var take = applyLimitSpec(ids, limitSpec);
      return Promise.all(take.map(function (tid) {
        return readLeaves(['musicTracks', tid]).then(function (ll) {
          return [tid, unflatten(ll, ['musicTracks', tid]) || {}];
        });
      })).then(function (pairs) {
        var obj = {};
        pairs.forEach(function (pr) { obj[pr[0]] = pr[1]; });
        return obj;
      });
    });
  }

  // Índice por dimensión de post: postsByGroup/<gid>/<pid> y
  // postsByFiesta/<fid>/<pid>, con valor {t} (timestamp). Antes, "posts del
  // grupo" y "terminar fiesta" descargaban communityNotes COMPLETO en cada
  // apertura. El índice se escribe al crear/borrar cada post (ver index.html);
  // para contenido anterior al índice se hace UN backfill global (marca
  // <idx>/_indexed) la primera vez que se lee el índice.
  function readPostsByDimIndex(idxPk, field, dimVal, limitN) {
    dimVal = String(dimVal);
    var lim = (typeof limitN === 'number' && limitN > 0) ? limitN : 200;
    function hydrate(ids) {
      return Promise.all(ids.map(function (pid) {
        return readLeaves(['communityNotes', pid]).then(function (ll) {
          return [pid, unflatten(ll, ['communityNotes', pid]) || {}];
        });
      })).then(function (pairs) {
        var obj = {};
        pairs.forEach(function (pr) { obj[pr[0]] = pr[1]; });
        return obj;
      });
    }
    return readLeaves([idxPk, dimVal]).then(function (leaves) {
      var idx = unflatten(leaves, [idxPk, dimVal]) || {};
      var ids = Object.keys(idx).filter(function (k) { return k.charAt(0) !== '_'; });
      // La marca _indexed manda, no el hecho de que haya entradas: si un
      // backfill anterior murió a la mitad, el índice estaría parcial para
      // siempre. Sin marca se re-ejecuta (los puts son idempotentes).
      return readLeaves([idxPk, '_indexed']).then(function (ml) {
        if (unflatten(ml, [idxPk, '_indexed']) !== true) return doBackfill();
        if (!ids.length) return {};
        ids.sort(function (a, b) { return (((idx[b] || {}).t) || 0) - (((idx[a] || {}).t) || 0); });
        return hydrate(ids.slice(0, lim));
      });
    });
    function doBackfill() {
      // Backfill global único: un solo escaneo legacy construye el índice
      // para TODAS las dimensiones de una vez; luego se marca.
      return readLeaves(['communityNotes']).then(function (allLeaves) {
          var all = unflatten(allLeaves, ['communityNotes']) || {};
          var reqs = [];
          Object.keys(all).forEach(function (pid) {
            var p = all[pid];
            if (p && typeof p === 'object' && p[field] !== undefined && p[field] !== null && String(p[field]) !== '') {
              reqs.push(putLeaf(idxPk, String(p[field]) + '/' + pid, { t: p.timestamp || 0 }));
            }
          });
          reqs.push(putLeaf(idxPk, '_indexed', true));
          batchWriteAll(reqs).catch(function () {});
          var mine = [];
          Object.keys(all).forEach(function (pid) {
            var p = all[pid];
            if (p && typeof p === 'object' && String(p[field] || '') === dimVal) mine.push([pid, p]);
          });
          mine.sort(function (x, y) { return (Number(y[1].timestamp) || 0) - (Number(x[1].timestamp) || 0); });
          var obj = {};
          mine.slice(0, lim).forEach(function (pr) { obj[pr[0]] = pr[1]; });
          return obj;
      });
    }
  }

  // Entrada del índice de búsqueda de música: solo texto (sin portadas).
  function musicSearchEntry(t) {
    t = t || {};
    return {
      ti: String(t.title || ''), ar: String(t.artist || t.artistName || ''),
      an: String(t.authorName || ''), aid: String(t.authorId || ''),
      createdAt: Number(t.createdAt) || 0
    };
  }
  // Índice de búsqueda de música (musicSearch/<trackId> -> texto ligero).
  // Antes, cada tecla del buscador descargaba musicTracks COMPLETO
  // (metadatos + portadas de hasta ~300KB). El índice guarda ~150 bytes por
  // pista y se lee acotado por createdAt; la portada se hidrata solo para
  // los resultados visibles (ver musicSearchTracks en index.html). Incluye
  // backfill único para pistas anteriores al índice.
  function readMusicSearchIndex(limitN) {
    var lim = (typeof limitN === 'number' && limitN > 0) ? limitN : 500;
    function doBackfill() {
      return readLeaves(['musicTracks']).then(function (allLeaves) {
        var all = unflatten(allLeaves, ['musicTracks']) || {};
        var reqs = [];
        var obj2 = {};
        Object.keys(all).forEach(function (tid) {
          var t = all[tid];
          if (t && typeof t === 'object') {
            var e = musicSearchEntry(t);
            obj2[tid] = e;
            reqs.push(putLeaf('musicSearch', tid, e));
          }
        });
        reqs.push(putLeaf('musicSearch', '_indexed', true));
        batchWriteAll(reqs).catch(function () {});
        return obj2;
      });
    }
    return readLeavesBounded('musicSearch', lim).then(function (leaves) {
      var idx = unflatten(leaves, ['musicSearch']) || {};
      var ids = Object.keys(idx).filter(function (k) { return k.charAt(0) !== '_'; });
      // La marca _indexed manda: un backfill interrumpido dejaría el índice
      // parcial para siempre si solo miráramos si hay entradas.
      return readLeaves(['musicSearch', '_indexed']).then(function (ml) {
        if (unflatten(ml, ['musicSearch', '_indexed']) !== true) return doBackfill();
        var obj = {};
        ids.forEach(function (tid) { obj[tid] = idx[tid]; });
        return obj;
      });
    });
  }

  // Índice verifiedUsers/<uid> -> {at, by, em}: evita descargar users
  // COMPLETO en cada inicio de sesión para la caché de insignias. El índice
  // se rellena con backfill único; las concesiones futuras deben escribirlo
  // (ver nota en refreshVerifiedUsersCache de index.html).
  function readVerifiedUsersIndex() {
    return readLeaves(['verifiedUsers']).then(function (leaves) {
      var idx = unflatten(leaves, ['verifiedUsers']) || {};
      // La marca _indexed manda, no el conteo de entradas: un backfill
      // interrumpido dejaría el índice parcial para siempre.
      if (idx._indexed === true) return idx;
      return readLeaves(['users']).then(function (ul) {
        var users = unflatten(ul, ['users']) || {};
        var reqs = [];
        var obj = {};
        Object.keys(users).forEach(function (uid) {
          var u = users[uid];
          if (!u || typeof u !== 'object') return;
          var v = u.verified;
          if (!(v === true || v === 'true' || v === 1 || v === '1')) return;
          var em = String(u.email || '').trim().toLowerCase();
          var e = { at: u.verifiedAt || '', by: u.verifiedBy || 'Drex', em: em };
          obj[uid] = e;
          reqs.push(putLeaf('verifiedUsers', uid, e));
        });
        reqs.push(putLeaf('verifiedUsers', '_indexed', true));
        batchWriteAll(reqs).catch(function () {});
        return obj;
      });
    });
  }

  // Backfill global único del índice usernames/: lo dispara la primera
  // lectura exacta que falle (usuario legacy anterior al índice). Usa put
  // CONDICIONAL (solo si la hoja no existe) para no pisar reservas hechas
  // por transacción mientras corre el escaneo.
  var _usernamesBackfillPromise = null;
  function ensureUsernamesBackfilled() {
    if (_usernamesBackfillPromise) return _usernamesBackfillPromise;
    _usernamesBackfillPromise = readLeaves(['usernames', '_indexed']).then(function (ml) {
      if (unflatten(ml, ['usernames', '_indexed']) === true) return null;
      return readLeaves(['users']).then(function (leaves) {
        var users = unflatten(leaves, ['users']) || {};
        var tasks = [];
        Object.keys(users).forEach(function (uid) {
          var u = users[uid];
          if (!u || typeof u !== 'object') return;
          var uname = String(u.username || '').toLowerCase();
          if (!uname || uname.charAt(0) === '_') return;
          tasks.push(function () {
            return putLeafConditional('usernames', uname, JSON.stringify(uid), null)
              .then(function () {
                // Índice inverso usernameByUid/<uid> -> <nombre>: permite la
                // búsqueda "¿qué nombre apunta a este uid?" con una lectura
                // puntual (la usa maybeRepairCorruptedUsername). Solo se
                // escribe si la reserva directa tuvo éxito; si otro la tomó,
                // se respeta y no se escribe nada.
                return putLeafConditional('usernameByUid', uid, JSON.stringify(uname), null)
                  .catch(function () {});
              })
              .catch(function () { /* otro la reservó: se respeta */ });
          });
        });
        function runChunk(i) {
          if (i >= tasks.length) return Promise.resolve(null);
          return Promise.all(tasks.slice(i, i + 25).map(function (fn) { return fn(); }))
            .then(function () { return runChunk(i + 25); });
        }
        return runChunk(0).then(function () {
          return batchWriteAll([putLeaf('usernames', '_indexed', true)]).catch(function () {});
        });
      });
    }).catch(function () { _usernamesBackfillPromise = null; });
    return _usernamesBackfillPromise;
  }
  // Lectura exacta usernames/<nombre> con backfill global único en caso de
  // fallo. Antes, la pantalla de registro descargaba users COMPLETO en cada
  // tecla como "respaldo por si no se usa el índice".
  function readUsernameEntry(name) {
    var segs = ['usernames', String(name)];
    return readLeaves(segs).then(function (leaves) {
      var val = unflatten(leaves, segs);
      if (val !== null && val !== undefined) return val;
      return ensureUsernamesBackfilled().then(function () {
        return readLeaves(segs);
      }).then(function (leaves2) {
        return unflatten(leaves2, segs);
      }, function () { return val; });
    });
  }

  // Huella de cambio liviana para oyentes: las fotos se guardan como data
  // URLs en base64 (hasta ~300 KB cada una) y un feed con posts de varias
  // fotos suma decenas de MB. Comparar con JSON.stringify del snapshot
  // completo en cada ciclo de polling (3 s) reventaba la memoria y el CPU
  // del iPhone: los ciclos se apilaban, los .catch tragaban los fallos y el
  // feed dejaba de actualizarse (posts recién publicados que "no aparecían").
  // La huella reemplaza cada cadena larga por longitud+hash de sus bordes;
  // los campos escalares (votos, timestamps, contenido) se comparan exactos.
  function _hashStr(s) {
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
      h2 = Math.imul(h2 + s.charCodeAt(i), 31);
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
  }
  function _fingerprintValue(v) {
    if (typeof v === 'string') {
      if (v.length > 2048) return '~BLOB:' + v.length + ':' + _hashStr(v.slice(0, 64) + v.slice(-64));
      return v;
    }
    if (Array.isArray(v)) {
      var a = new Array(v.length);
      for (var i = 0; i < v.length; i++) a[i] = _fingerprintValue(v[i]);
      return a;
    }
    if (v !== null && typeof v === 'object') {
      var o = {};
      var ks = Object.keys(v);
      for (var k = 0; k < ks.length; k++) o[ks[k]] = _fingerprintValue(v[ks[k]]);
      return o;
    }
    return v;
  }
  function _changeFingerprint(v) {
    try { return JSON.stringify(_fingerprintValue(v)); } catch (e) { return null; }
  }
  function callCb(cb, arg) {
    try { cb(arg); } catch (e) { setTimeout(function () { throw e; }, 0); }
  }

  function childEntriesOf(snap) {
    var v = snap.val();
    if (!v || typeof v !== 'object') return [];
    return Object.keys(v).map(function (k) { return [k, v[k]]; });
  }

  // Dispara un oyente según su tipo de evento ('value' | 'child_added' | 'child_changed' | 'child_removed')
  // Reparte un snapshot ya leído entre la lógica de eventos de UN oyente
  // ('value' | 'child_added' | 'child_changed' | 'child_removed').
  // isDelta = true → el snapshot trae SOLO hijos nuevos (delta-sync): no se
  // poda l.kids (los hijos viejos siguen existiendo, solo no se re-descargaron).
  function dispatchSnapshot(l, snap, isDelta) {
      // P1: una lectura en vuelo puede resolverse DESPUÉS de off(). Sin este
      // guard, el callback de un oyente dado de baja seguiría disparándose
      // (ej. el listener del comentario fijado contaminaba la vista del post nuevo).
      if (listeners.indexOf(l) === -1) return;
      if (l.eventType === 'value') {
        var j = _changeFingerprint(snap.val());
        if (j !== l.lastJson) { l.lastJson = j; callCb(l.cb, snap); }
        return;
      }
      var entries = childEntriesOf(snap);
      if (l.eventType === 'child_added') {
        if (!l.kids) {
          l.kids = {};
          entries.forEach(function (e) { l.kids[e[0]] = _changeFingerprint(e[1]); callCb(l.cb, snap.child(e[0])); });
        } else {
          var seen = {};
          entries.forEach(function (e) {
            seen[e[0]] = 1;
            var ej = _changeFingerprint(e[1]);
            if (!(e[0] in l.kids)) { l.kids[e[0]] = ej; callCb(l.cb, snap.child(e[0])); }
            else l.kids[e[0]] = ej;
          });
          // En delta-sync el snapshot trae SOLO lo nuevo: no podar (los hijos
          // viejos siguen existiendo, simplemente no se re-descargaron; si se
          // podaran, el siguiente delta los re-dispararía como "nuevos").
          if (!isDelta) Object.keys(l.kids).forEach(function (k) { if (!seen[k]) delete l.kids[k]; });
        }
      } else if (l.eventType === 'child_changed') {
        if (!l.kids) {
          l.kids = {};
          entries.forEach(function (e) { l.kids[e[0]] = _changeFingerprint(e[1]); });
        } else {
          entries.forEach(function (e) {
            var ej = _changeFingerprint(e[1]);
            if ((e[0] in l.kids) && l.kids[e[0]] !== ej) callCb(l.cb, snap.child(e[0]));
            l.kids[e[0]] = ej;
          });
        }
      } else if (l.eventType === 'child_removed') {
        // Primera lectura: línea base, sin disparar (igual que child_changed).
        // Después: todo hijo que estaba y ya no está => eliminado.
        if (!l.kids) {
          l.kids = {};
          entries.forEach(function (e) { l.kids[e[0]] = _changeFingerprint(e[1]); });
        } else {
          var seenR = {};
          entries.forEach(function (e) { seenR[e[0]] = 1; l.kids[e[0]] = _changeFingerprint(e[1]); });
          Object.keys(l.kids).forEach(function (k) {
            if (!seenR[k]) { delete l.kids[k]; callCb(l.cb, snap.child(k)); }
          });
        }
      }
      }

  function fireListener(l) {
    // No apilar lecturas: si la anterior aún no terminó (lectura pesada con
    // muchas fotos), se marca un re-disparo pendiente en vez de lanzar otra
    // lectura encima. Sin esto, los ciclos de polling se solapaban y la
    // pestaña del iPhone se quedaba sin memoria.
    if (l._reading) { l._pendingFire = true; return Promise.resolve(); }
    l._reading = true;
    return readRefValue(l.ref).then(function (snap) {
      dispatchSnapshot(l, snap);
    }).catch(function () { /* el próximo ciclo reintenta */ }).then(function () {
      l._reading = false;
      if (l._pendingFire) { l._pendingFire = false; fireListener(l); }
    });
  }

  // Clave de agrupación: oyentes sobre la MISMA ruta y la MISMA consulta
  // comparten una sola lectura por ciclo de polling.
  function pollGroupKey(l) {
    return l.ref._segs.join('/') + '|' + JSON.stringify(l.ref._query || null);
  }

  // REALTIME 2026-09-21: tolerancia a throttling de DynamoDB.
  // Antes: si una lectura fallaba (throttle/5xx), el grupo reintentaba en el
  // siguiente ciclo fijo (3 s / 800 ms). Tras un evento de throttling, TODOS
  // los clientes reintentaban a la vez en la misma rejilla: estampida
  // sincronizada que re-saturaba la tabla. Ahora cada grupo de oyentes lleva
  // su propio estado: backoff exponencial con jitter (los reintentos se
  // des-correlacionan entre clientes) y circuit-breaker ligero (si un grupo
  // falla K veces seguidas, sus ciclos se degradan a 30 s/60 s y se recupera
  // con una sonda). El eco local (notifyLocal) nunca se bloquea: va a ritmo
  // de usuario, no de ciclo.
  var POLL_MAX_FAILS = 4;       // fallos retriables seguidos para abrir el circuito
  var POLL_BACKOFF_CAP = 30000; // tope del backoff entre reintentos (30 s)
  var POLL_CIRCUIT_MS = 30000;  // ventana de circuito abierto (60 s si reincide)
  var pollCircuit = {};         // groupKey -> { fails, notBefore, openUntil, openedLong }

  function pollCircuitState(key) {
    var st = pollCircuit[key];
    if (!st) st = pollCircuit[key] = { fails: 0, notBefore: 0, openUntil: 0, openedLong: false };
    return st;
  }

  // Clasifica errores retriables de DynamoDB/red: throttling, 5xx y fallos de
  // red/timeout sí; validación, credenciales o lógica no (reintentarlos es inútil).
  function isRetriablePollError(err) {
    if (!err) return false;
    var code = String(err.code || err.name || '');
    var msg = String(err.message || '');
    if (/ProvisionedThroughputExceeded|Throttling|RequestLimitExceeded|TooManyRequests|RequestThrottled/i.test(code)) return true;
    var sc = err.statusCode || (err.$metadata && err.$metadata.httpStatusCode);
    if (typeof sc === 'number' && sc >= 500) return true;
    if (/timeout|NetworkingError|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|ServiceUnavailable|InternalError/i.test(code + ' ' + msg)) return true;
    return false;
  }

  // Backoff "equal jitter" (recomendación AWS): mitad determinista y mitad
  // aleatoria por cliente, así dos clientes que fallaron a la vez NO
  // reintentan a la vez. baseMs = intervalo natural del grupo (3 s / 800 ms).
  function pollBackoffDelay(st, baseMs) {
    var exp = Math.min(POLL_BACKOFF_CAP, baseMs * Math.pow(2, Math.max(0, st.fails - 1)));
    var half = exp / 2;
    return Math.floor(half + Math.random() * half);
  }

  function pollGroupSucceeded(key) {
    var st = pollCircuit[key];
    if (st) { st.fails = 0; st.notBefore = 0; st.openUntil = 0; st.openedLong = false; }
  }

  function pollGroupFailed(key, err, baseMs) {
    if (!isRetriablePollError(err)) return; // no castigar fallos no retriables
    var st = pollCircuitState(key);
    st.fails++;
    var now = Date.now();
    if (st.fails >= POLL_MAX_FAILS) {
      // Circuito abierto: se pausan los ciclos de este grupo. Al expirar la
      // ventana entra UNA sonda; si falla, se reabre (esta vez a 60 s).
      st.openUntil = now + (st.openedLong ? POLL_CIRCUIT_MS * 2 : POLL_CIRCUIT_MS);
      st.notBefore = st.openUntil;
      st.openedLong = true;
      st.fails = 0;
      return;
    }
    st.notBefore = now + pollBackoffDelay(st, baseMs);
  }

  // Dispara un grupo de oyentes con UNA sola lectura compartida.
  // opts.local = true → eco local tras escritura propia (nunca bloqueado por
  // el circuito: es la única forma de que el usuario vea su propio cambio).
  function pollGroup(ls, opts) {
    var key = pollGroupKey(ls[0]);
    var isLocal = !!(opts && opts.local);
    if (!isLocal) {
      var st = pollCircuitState(key);
      var now = Date.now();
      if (st.notBefore > now || st.openUntil > now) return; // backoff / circuito
    }
    var busy = false;
    for (var i = 0; i < ls.length; i++) { if (ls[i]._reading) { busy = true; break; } }
    if (busy) { ls.forEach(function (l) { l._pendingFire = true; }); return; }
    var fast = ls.some(isSignalingListener);
    var baseMs = fast ? FAST_POLL_MS : NORMAL_POLL_MS;
    ls.forEach(function (l) { l._reading = true; });
    // DELTA-SYNC (parche parcial): si todos los oyentes del grupo son
    // child_added con delta habilitado y ya tienen línea base, se pide solo
    // lo nuevo (sk > último visto) en vez de re-descargar todo.
    var useDelta = ls.length > 0 && ls.every(function (l) {
      return l.eventType === 'child_added' && l._delta === true && typeof l._deltaSk === 'string';
    });
    var readP = useDelta
      ? readRefValueDelta(ls[0].ref, deltaFromSk(minDeltaSk(ls))).then(function (r) {
          return { snap: r.snap, delta: true, maxSk: r.maxSk };
        })
      : readRefValue(ls[0].ref).then(function (snap) {
          return { snap: snap, delta: false, maxSk: null };
        });
    readP.then(function (r) {
      pollGroupSucceeded(key);
      ls.forEach(function (l) {
        dispatchSnapshot(l, r.snap, r.delta);
        if (l._delta === true) {
          var mk = r.delta ? r.maxSk : maxChildKeyOf(r.snap.val());
          if (mk && (typeof l._deltaSk !== 'string' || mk > l._deltaSk)) l._deltaSk = mk;
        }
      });
    }).catch(function (err) {
      // Antes: comentario vacío y reintento en el siguiente ciclo fijo,
      // sincronizado entre todos los clientes tras un throttling.
      pollGroupFailed(key, err, baseMs);
    }).then(function () {
      var again = false;
      ls.forEach(function (l) {
        l._reading = false;
        if (l._pendingFire) { l._pendingFire = false; again = true; }
      });
      if (again) pollGroup(ls, opts);
    });
  }

  // Mínimo _deltaSk del grupo (el más antiguo manda: el rango trae un
  // superconjunto y las huellas evitan re-disparar lo ya visto).
  function minDeltaSk(ls) {
    var m = null;
    ls.forEach(function (l) {
      if (typeof l._deltaSk === 'string' && (m === null || l._deltaSk < m)) m = l._deltaSk;
    });
    return m;
  }

  // PERF 2026-09-21: solo la bandeja de señales WebRTC (fiestaSignals/...)
  // necesita el ciclo rápido de 800ms (offers/answers/ICE). El resto de la
  // fiesta (miembros, reacciones, chat, estado, juego) va al ciclo normal
  // de 3s. Antes TODO iba a 800ms: ~5 lecturas DynamoDB cada 800ms por
  // cliente (~6-7/s), que con varios usuarios en sala saturaba la tabla.
  function isSignalingListener(l) {
    return !!(l && l.ref && l.ref._segs && l.ref._segs[0] === 'fiestaSignals');
  }

  // Un ciclo de polling agrupa los oyentes por (ruta + consulta): el feed
  // tenía 3 oyentes (child_added/changed/removed) sobre la misma consulta y
  // cada uno descargaba communityNotes COMPLETO cada 3 s. Ahora los 3
  // comparten el mismo snapshot: ~3x menos lecturas al servidor.
  function pollListenersGrouped(fastOnly) {
    // En segundo plano no se sondea (ahorra batería y datos en el iPhone);
    // al volver a primer plano el siguiente ciclo (<=3 s) refresca. La
    // señalización de fiestas (polling rápido de WebRTC) sigue activa.
    if (typeof document !== 'undefined' && document.hidden) {
      if (!fastOnly || !fastPolling) return;
    }
    var groups = {};
    listeners.slice().forEach(function (l) {
      if (fastPolling && (!!fastOnly !== isSignalingListener(l))) return;
      var k = pollGroupKey(l);
      (groups[k] = groups[k] || []).push(l);
    });
    Object.keys(groups).forEach(function (k) { pollGroup(groups[k]); });
  }

  var fastPolling = false;
  var NORMAL_POLL_MS = 3000, FAST_POLL_MS = 800;

  // REALTIME 2026-09-21: polling adaptativo a la red (NetworkInformation).
  // En 2G o con ahorro de datos, sondear cada 3 s (800 ms en fiestas) quema
  // datos y batería sin mejorar la UX: la red no da para más. Con feature-
  // detect: si el navegador no expone navigator.connection, todo queda igual.
  // NOTA: en segundo plano el ciclo normal ya se pausa (ver
  // pollListenersGrouped); el rápido SIGUE porque es señalización WebRTC
  // crítica: pausarlo tumbaría las llamadas de fiesta al cambiar de app.
  function adaptivePollMs(baseMs) {
    try {
      var c = (typeof navigator !== 'undefined' && navigator.connection) || null;
      if (c) {
        if (c.saveData) return Math.max(baseMs, 10000);
        var t = c.effectiveType;
        if (t === 'slow-2g' || t === '2g') return Math.max(baseMs, 10000);
        if (t === '3g') return Math.max(baseMs, 5000);
      }
    } catch (e) { /* sin NetworkInformation: intervalo base */ }
    return baseMs;
  }
  function currentNormalMs() { return adaptivePollMs(NORMAL_POLL_MS); }
  function currentFastMs() { return adaptivePollMs(FAST_POLL_MS); }
  function restartPollTimers() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (fastTimer) { clearInterval(fastTimer); fastTimer = null; }
    ensurePolling();
  }
  function ensurePolling() {
    if (!listeners.length) return;
    if (!pollTimer) pollTimer = setInterval(function () { pollListenersGrouped(false); }, currentNormalMs());
    if (fastPolling && !fastTimer) fastTimer = setInterval(function () { pollListenersGrouped(true); }, currentFastMs());
  }
  // Si la calidad de red cambia (2G<->4G, entra/sale saveData), se recalculan
  // los intervalos sin perder oyentes.
  try {
    var _netInfo = (typeof navigator !== 'undefined' && navigator.connection) || null;
    if (_netInfo && typeof _netInfo.addEventListener === 'function') {
      _netInfo.addEventListener('change', function () { restartPollTimers(); });
    }
  } catch (e) {}
  function maybeStopPolling() {
    if (pollTimer && !listeners.length) { clearInterval(pollTimer); pollTimer = null; }
    if (fastTimer && !listeners.length) { clearInterval(fastTimer); fastTimer = null; }
  }
  // Activa/desactiva polling rápido (800ms) para señalización WebRTC en fiestas.
  // El polling normal de 3s es muy lento para offers/answers/ICE candidates.
  function setFastPolling(enabled) {
    fastPolling = !!enabled;
    restartPollTimers();
  }

  // Avisa a los oyentes afectados por una escritura propia (eco local inmediato)
  function notifyLocal(changedSegs) {
    // H3: cualquier escritura local invalida el caché de fase 2 de los
    // prefijos afectados: el eco local (abajo, 120 ms) debe re-leer completo
    // para que el propio envío/edición/borrado se pinte al instante.
    invalidateBoundedPrefixCache(changedSegs);
    // Eco local inmediato tras una escritura propia, agrupado por
    // (ruta + consulta) para no repetir la misma lectura N veces.
    var groups = {};
    listeners.forEach(function (l) {
      if (!pathsOverlap(l.ref._segs, changedSegs)) return;
      var k = pollGroupKey(l);
      (groups[k] = groups[k] || []).push(l);
    });
    Object.keys(groups).forEach(function (k) {
      var ls = groups[k];
      ls.forEach(function (l) { if (l._deb) { clearTimeout(l._deb); l._deb = null; } });
      var rep = ls[0];
      // Eco local: se marca como lectura de usuario para que el circuito de
      // throttling nunca la bloquee (ver pollGroup).
      rep._deb = setTimeout(function () { rep._deb = null; pollGroup(ls, { local: true }); }, 120);
    });
  }

  // OUTBOX OFFLINE (esqueleto 2026-09-21 — solo operación 'set').
  // Cola persistente (localStorage) de escrituras cuando no hay red: en vez
  // de fallar, Ref.set() encola y resuelve al vaciarse la cola. Orden FIFO
  // estricto; ante fallo retriable (throttle/5xx/red) la operación se queda
  // al frente y se reintenta con backoff con jitter; ante fallo no retriable
  // (validación) se descarta para no bloquear la cola. Coalescing: dos 'set'
  // pendientes sobre la misma ruta colapsan (último valor gana) y TODOS los
  // llamadores encolados reciben el resultado.
  // DISEÑO COMPLETO (roadmap): 'update'/'push'/'remove' (push necesita
  // reservar el ID localmente), encolar también ante 5xx en caliente (hoy
  // solo sin red, vía navigator.onLine), y contadores de telemetría.
  var Outbox = (function () {
    var LS_KEY = 'drex-outbox-v1';
    var MAX_OPS = 200;
    var waiters = {}; // opId -> [{ resolve, reject }] (varios si hubo coalescing)
    var flushing = false;
    var retryTimer = null;
    var bypass = false; // runOp escribe directo, sin re-encolar

    function load() {
      try {
        var raw = (typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY)) || '[]';
        var a = JSON.parse(raw);
        return Array.isArray(a) ? a : [];
      } catch (e) { return []; }
    }
    function save(q) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify(q.slice(-MAX_OPS)));
      } catch (e) {}
    }
    function isOffline() {
      try { return typeof navigator !== 'undefined' && navigator.onLine === false; }
      catch (e) { return false; }
    }
    function shouldQueue() { return !bypass && isOffline(); }
    function newOpId() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
    // Eco local sintético: los oyentes sobre la ruta ven el valor encolado
    // al instante; las huellas de cambio evitan el doble disparo cuando
    // llegue el eco real del servidor tras el flush.
    function echoLocal(segs, value) {
      try {
        var snap = new DataSnapshot(value, segs.length ? segs[segs.length - 1] : null);
        listeners.slice().forEach(function (l) {
          if (!pathsOverlap(l.ref._segs, segs)) return;
          var rel = segs.slice(l.ref._segs.length).join('/');
          dispatchSnapshot(l, rel ? snap.child(rel) : snap);
        });
      } catch (e) {}
    }
    function runOp(op) {
      if (op.type !== 'set') return Promise.reject(new Error('Outbox: tipo no soportado: ' + op.type));
      bypass = true;
      try { return new Ref(splitPath(op.path)).set(op.value); }
      catch (e) { return Promise.reject(e); }
      finally { bypass = false; }
    }
    function scheduleFlush(ms) {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      retryTimer = setTimeout(function () { retryTimer = null; flush(); }, ms);
    }
    function settleAll(op, ok, val) {
      var ws = waiters[op.id]; delete waiters[op.id];
      (ws || []).forEach(function (w) { ok ? w.resolve(val) : w.reject(val); });
    }
    function dropHead(qq, op, err) {
      save(qq.filter(function (o) { return o.id !== op.id; }));
      settleAll(op, false, err || new Error('Outbox: operación descartada'));
      try {
        if (typeof console !== 'undefined' && console.warn)
          console.warn('Outbox: operación descartada (no retriable)', op.path, err && err.message);
      } catch (e) {}
    }
    function flush() {
      if (flushing || isOffline()) return;
      var qq = load();
      if (!qq.length) return;
      flushing = true;
      (function step() {
        var cur = load();
        if (!cur.length || isOffline()) { flushing = false; return; }
        var op = cur[0];
        runOp(op).then(function () {
          save(load().filter(function (o) { return o.id !== op.id; }));
          settleAll(op, true, { flushed: true, path: op.path });
          step();
        }, function (err) {
          if (isRetriablePollError(err)) {
            // Se mantiene el orden: no se avanza; reintento con backoff+jitter.
            op.tries = (op.tries || 0) + 1;
            var all = load();
            for (var i = 0; i < all.length; i++) if (all[i].id === op.id) { all[i] = op; break; }
            save(all);
            flushing = false;
            var d = Math.min(60000, 2000 * Math.pow(2, Math.min(5, op.tries - 1)));
            scheduleFlush(Math.floor(d / 2 + Math.random() * d / 2));
          } else {
            dropHead(cur, op, err);
            step();
          }
        });
      })();
    }
    function enqueueSet(segs, value) {
      var q = load();
      var op = { id: newOpId(), type: 'set', path: segs.join('/'), value: value, ts: Date.now(), tries: 0 };
      var dup = null;
      for (var i = 0; i < q.length; i++) {
        if (q[i].type === 'set' && q[i].path === op.path) { dup = q[i]; break; }
      }
      if (dup) { op.id = dup.id; q[q.indexOf(dup)] = op; } // coalescing: último gana
      else q.push(op);
      save(q);
      echoLocal(segs, value);
      scheduleFlush(0);
      return new Promise(function (res, rej) {
        // Con coalescing, varios llamadores esperan la misma op: se avisa a todos.
        (waiters[op.id] = waiters[op.id] || []).push({ resolve: res, reject: rej });
      });
    }
    // Al volver la red: el backoff/circuitos quedaron obsoletos (los fallos
    // eran por falta de red) y la cola pendiente se vacía.
    try {
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('online', function () { pollCircuit = {}; flush(); });
      }
    } catch (e) {}
    // Arranque con cola pendiente (pestaña cerrada antes de vaciar).
    try { setTimeout(function () { flush(); }, 1500); } catch (e) {}
    return {
      shouldQueue: shouldQueue,
      enqueueSet: enqueueSet,
      flush: flush,
      isOffline: isOffline,
      pending: load
    };
  })();

  // Ref

  function Ref(segs, query) {
    this._segs = segs;
    this._query = query || null;
  }

  Ref.prototype.child = function (path) {
    var extra = splitPath(path);
    return new Ref(this._segs.concat(extra), this._query);
  };

  Object.defineProperty(Ref.prototype, 'key', {
    get: function () { return this._segs.length ? this._segs[this._segs.length - 1] : null; }
  });

  Ref.prototype.toString = function () { return this._segs.join('/'); };

  Ref.prototype.set = function (value) {
    var segs = this._segs;
    // OUTBOX (esqueleto): sin red, la escritura se encola en vez de fallar.
    if (Outbox.shouldQueue()) return Outbox.enqueueSet(segs, value);
    var leaves = flatten(value, segs);
    return deleteSubtree(segs).then(function () {
      if (!leaves.length) return null;
      var reqs = leaves.map(function (l) {
        return putLeaf(l.segs[0], l.segs.slice(1).join('/'), l.value);
      });
      return batchWriteAll(reqs);
    }).then(function () { notifyLocal(segs); return null; });
  };

  Ref.prototype.update = function (obj) {
    var base = this._segs;
    if (!isPlainObject(obj)) return Promise.reject(new Error('update() requiere un objeto'));
    var leafReqs = [];
    var exactDeletes = {};
    var prefixDeletes = {};
    Object.keys(obj).forEach(function (k) {
      var relSegs = splitPath(k);
      var fullSegs = base.concat(relSegs);
      var nullSegs = [];
      var leaves = flatten(obj[k], fullSegs, [], nullSegs);
      // null (en cualquier nivel) borra esa ruta
      nullSegs.forEach(function (ns) { prefixDeletes[ns.join('/')] = ns; });
      leaves.forEach(function (l) {
        leafReqs.push(l);
        // Al escribir una hoja, los ancestros exactos (primitivas) y los
        // descendientes deben desaparecer: así la mezcla equivale al árbol.
        for (var i = 1; i < l.segs.length; i++) {
          var a = l.segs.slice(0, i).join('/');
          exactDeletes[a] = l.segs.slice(0, i);
        }
        prefixDeletes[l.segs.join('/')] = l.segs;
      });
      if (!leaves.length && !nullSegs.length) {
        // update({ruta: {}}) o update({ruta: []}) borra ese subárbol, como en
        // el proveedor anterior. (null se borra vía nullSegs, arriba.)
        prefixDeletes[fullSegs.join('/')] = fullSegs;
      }
    });
    var delReqs = [];
    Object.keys(exactDeletes).forEach(function (k) {
      var s = exactDeletes[k];
      delReqs.push(deleteKey(s[0], s.slice(1).join('/')));
    });
    var prefixLists = Object.keys(prefixDeletes).map(function (k) { return prefixDeletes[k]; });
    var chain = Promise.resolve();
    prefixLists.forEach(function (s) {
      chain = chain.then(function () { return deleteSubtree(s); });
    });
    return chain
      .then(function () { return batchWriteAll(delReqs); })
      .then(function () {
        var reqs = leafReqs.map(function (l) {
          return putLeaf(l.segs[0], l.segs.slice(1).join('/'), l.value);
        });
        return batchWriteAll(reqs);
      })
      .then(function () {
        leafReqs.forEach(function (l) { notifyLocal(l.segs); });
        return null;
      });
  };

  Ref.prototype.push = function (value) {
    var r = this.child(newPushId());
    if (value !== undefined) {
      r._writePromise = r.set(value).catch(function (e) {
        if (typeof console !== 'undefined' && console.warn) console.warn('push(): escritura fallida', e && e.message);
      });
    }
    return r;
  };

  // pushAsync(value): como push(), pero DEVUELVE la promesa de la escritura
  // real: resuelve con el Ref hijo cuando la escritura termina de verdad y
  // RECHAZA si la escritura falla. (push() traga el error en un .catch que
  // solo avisa por consola: el llamador mostraba "éxito" aunque nada se
  // hubiera guardado, p. ej. publicar 9 fotos veía "¡Publicación creada
  // exitosamente!" y el post no aparecía en el feed ni en ningún lado.)
  Ref.prototype.pushAsync = function (value) {
    var r = this.child(newPushId());
    if (value === undefined) return Promise.resolve(r);
    r._writePromise = r.set(value);
    return r._writePromise.then(function () { return r; });
  };

  // NOTA: se eliminó Ref.prototype.then (hacía al Ref "thenable" y provocaba
  // asimilación recursiva infinita: `await ref.push(x)` nunca resolvía).
  // Para esperar la escritura: `await ref.push(valor)._writePromise`.

  Ref.prototype.remove = function () {
    var segs = this._segs;
    return deleteSubtree(segs).then(function () { notifyLocal(segs); return null; });
  };

  Ref.prototype.once = function (eventType) {
    if (eventType && eventType !== 'value') return Promise.reject(new Error('Solo se soporta once("value")'));
    return readRefValue(this);
  };

  Ref.prototype.get = function () { return this.once('value'); };

  Ref.prototype.on = function (eventType, cb, opts) {
    if (eventType !== 'value' && eventType !== 'child_added' && eventType !== 'child_changed' && eventType !== 'child_removed') {
      throw new Error('Evento no soportado: ' + eventType);
    }
    var l = { ref: this, eventType: eventType, cb: cb, lastJson: undefined, kids: null, _deb: null };
    // opts.delta (ver onDelta): la primera lectura es completa (línea base);
    // después cada ciclo pide solo sk > último visto (rango BETWEEN).
    if (opts && opts.delta === true && eventType === 'child_added') l._delta = true;
    listeners.push(l);
    ensurePolling();
    // Lectura inicial: en 'value' dispara el callback; en 'child_added' dispara
    // una vez por cada hijo existente (como el proveedor anterior).
    fireListener(l).catch(function () {});
    return function () {
      var i = listeners.indexOf(l);
      if (i !== -1) listeners.splice(i, 1);
      l._pendingFire = false; // no re-disparar una lectura en vuelo tras off()
      if (l._deb) clearTimeout(l._deb);
      maybeStopPolling();
    };
  };

  // onDelta(cb): como on('child_added', cb), pero con delta-sync: tras la
  // lectura inicial completa, cada ciclo pide solo los hijos nuevos
  // (sk > último push ID visto) en vez de re-descargar la ruta entera.
  // SOLO para rutas append-only con hijos push ID (orden temporal):
  // fiestaSignals/<id>/<uid> (bandeja WebRTC), NO para objetos mutables.
  // off('child_added', cb) sigue funcionando igual para desuscribir.
  Ref.prototype.onDelta = function (cb) {
    return this.on('child_added', cb, { delta: true });
  };

  Ref.prototype.off = function (eventType, cb) {
    var path = this._segs.join('/');
    var query = JSON.stringify(this._query || null);
    for (var i = listeners.length - 1; i >= 0; i--) {
      var l = listeners[i];
      var sameRef = l.ref._segs.join('/') === path;
      var sameQuery = JSON.stringify(l.ref._query || null) === query;
      var sameEvent = !eventType || l.eventType === eventType;
      if (sameRef && sameQuery && sameEvent && (!cb || l.cb === cb)) {
        if (l._deb) clearTimeout(l._deb);
        l._pendingFire = false; // no re-disparar una lectura en vuelo tras off()
        listeners.splice(i, 1);
      }
    }
    maybeStopPolling();
  };

  Ref.prototype.orderByChild = function (k) {
    return new Ref(this._segs, { orderBy: k });
  };
  Ref.prototype.orderByKey = function () {
    return new Ref(this._segs, { orderByKey: true });
  };
  Ref.prototype.startAt = function (v) {
    var q = Object.assign({}, this._query, { startAt: v });
    return new Ref(this._segs, q);
  };
  Ref.prototype.endAt = function (v) {
    var q = Object.assign({}, this._query, { endAt: v });
    return new Ref(this._segs, q);
  };
  Ref.prototype.equalTo = function (v) {
    var q = Object.assign({}, this._query, { equalTo: v });
    return new Ref(this._segs, q);
  };
  Ref.prototype.limitToLast = function (n) {
    var q = Object.assign({}, this._query, { limitLast: n });
    return new Ref(this._segs, q);
  };
  Ref.prototype.limitToFirst = function (n) {
    var q = Object.assign({}, this._query, { limitFirst: n });
    return new Ref(this._segs, q);
  };

  // Transacción con atomicidad real del lado servidor (sin backend nuevo):
  // - Hojas escalares (contadores, reservas): Put condicional sobre el valor
  //   leído; si otro escritor se adelantó, reintenta la lectura completa.
  // - Objetos (p. ej. el voto de encuestas): transact_write_items multi-hoja;
  //   cada hoja se escribe/borra solo si su valor sigue siendo el leído, así
  //   que los votos concurrentes ya no se pierden. Si el objeto supera el
  //   límite de DynamoDB (90 hojas) se usa optimistic locking: releer y solo
  //   escribir si nadie cambió los datos; si no, reintentar con datos frescos.
  // Huella canónica de un conjunto de hojas para comparar lecturas
  // (el orden de readLeaves no es determinista, por eso se ordena).
  function leavesFingerprint(leaves) {
    return (leaves || [])
      .map(function (l) { return l.segs.join('/') + '=' + JSON.stringify(l.value); })
      .sort()
      .join('\n');
  }

  // transactionBlind(): variante opt-in de transaction() para callers que NO
  // consumen el snapshot devuelto (solo les importa `committed`, o nada).
  // PERF (H4, ciclo 8): transaction() hace un re-read post-commit
  // (ref.once('value')) tras cada escritura exitosa para devolver el snapshot
  // fresco al estilo Firebase. Ese re-read cuesta ~0.5 RCU (hoja escalar) o
  // mas (objeto multi-hoja) y NO afecta la atomicidad: la escritura
  // condicional ya se aplico antes de el. Para contadores ciegos
  // (followersCount, plays, chatUnread por destinatario, claims de username,
  // reparaciones de perfil...) el re-read es puro desperdicio, y ademas un
  // fallo del re-read convierte un commit exitoso en promesa rechazada.
  // transactionBlind() omite el re-read y devuelve
  // { committed, snapshot: null }. La semantica de `committed` es identica
  // (true = la escritura se aplico; false = updateFn aborto) y el reintento
  // ante ConditionalCheckFailed se conserva igual. NO migrar aqui callers
  // que lean res.snapshot o el snap de onComplete: recibirian null.
  function runTransaction(ref, updateFn, onComplete, skipReread) {
    var MAX_ATTEMPTS = 6;
    var MAX_TRANSACT_ITEMS = 90; // margen bajo el límite de 100 de DynamoDB
    function isScalar(v) { return v === null || v === undefined || typeof v !== 'object'; }
    function isConditionalCancel(err) {
      if (!err) return false;
      if (err.code === 'ConditionalCheckFailedException') return true;
      if (err.code === 'TransactionCanceledException' && err.CancellationReasons) {
        return err.CancellationReasons.some(function (r) { return r && r.Code === 'ConditionalCheckFailed'; });
      }
      return false;
    }
    // Lectura del snapshot a devolver: con skipReread se omite el
    // ref.once('value') post-commit y se devuelve snapshot null.
    function finishRead() {
      if (skipReread) return Promise.resolve({ committed: true, snapshot: null });
      return ref.once('value').then(function (s2) { return { committed: true, snapshot: s2 }; });
    }
    function run(attempt) {
      return readLeaves(ref._segs).then(function (leaves) {
        var cur = unflatten(leaves, ref._segs);
        var newVal = updateFn(cur);
        if (newVal === undefined) {
          var key = ref._segs.length ? ref._segs[ref._segs.length - 1] : null;
          return { committed: false, snapshot: new DataSnapshot(cur, key) };
        }
        var segs = ref._segs;
        if (isScalar(cur) && isScalar(newVal) && segs.length) {
          var expectedJson = (cur === null || cur === undefined) ? null : JSON.stringify(cur);
          return putLeafConditional(segs[0], segs.slice(1).join('/'), JSON.stringify(newVal), expectedJson)
            .then(function () {
              notifyLocal(segs);
              return finishRead();
            })
            .catch(function (err) {
              if (isConditionalCancel(err) && attempt < MAX_ATTEMPTS) return run(attempt + 1);
              throw err;
            });
        }
        if (segs.length) {
          var newLeaves = flatten(newVal, []);
          if (leaves.length + newLeaves.length <= MAX_TRANSACT_ITEMS) {
            return transactObjectLeaves(segs, leaves, newVal)
              .then(function () {
                notifyLocal(segs);
                return finishRead();
              })
              .catch(function (err) {
                if (isConditionalCancel(err) && attempt < MAX_ATTEMPTS) return run(attempt + 1);
                throw err;
              });
          }
        }
        // Más de 90 hojas: no cabe en una TransactWriteItems de DynamoDB.
        // Optimistic locking en vez de set() ciego: releer y escribir solo si
        // nadie modificó los datos; si hubo cambios concurrentes, reintentar
        // con datos frescos en lugar de sobrescribirlos en silencio.
        return readLeaves(ref._segs).then(function (freshLeaves) {
          if (leavesFingerprint(freshLeaves) !== leavesFingerprint(leaves)) {
            if (attempt < MAX_ATTEMPTS) return run(attempt + 1);
            throw new Error('transaction(): contención excesiva, intente de nuevo');
          }
          return ref.set(newVal).then(function () {
            return finishRead();
          });
        });
      });
    }
    var p = run(1);
    if (typeof onComplete === 'function') {
      p = p.then(function (res) { onComplete(null, res.committed, res.snapshot); return res; },
                 function (err) { onComplete(err, false, null); throw err; });
    }
    return p;
  }
  Ref.prototype.transaction = function (updateFn, onComplete) {
    return runTransaction(this, updateFn, onComplete, false);
  };
  Ref.prototype.transactionBlind = function (updateFn, onComplete) {
    return runTransaction(this, updateFn, onComplete, true);
  };

  // onDisconnect best-effort: intenta la escritura al ocultar/cerrar la página.
  // FIX: set/update/remove devuelven un handle cancelable. Antes cada arm()
  // añadía listeners permanentes a pagehide/visibilitychange que jamás se
  // quitaban (fuga: cada entrada a fiesta o ráfaga de typing sumaba 2), y
  // cancel() era no-op. Ahora el handle cancela con active=false +
  // removeEventListener; el llamador debe guardarlo y cancelarlo al salir.
  Ref.prototype.onDisconnect = function () {
    var ref = this;
    function arm(fn) {
      var active = true;
      function handler() {
        if (!active) return;
        try { var r = fn(); if (r && r.catch) r.catch(function () {}); } catch (e) {}
      }
      function onVis() { if (global.document.visibilityState === 'hidden') handler(); }
      if (typeof global.addEventListener === 'function') {
        global.addEventListener('pagehide', handler);
        if (typeof global.document !== 'undefined' && global.document.addEventListener) {
          global.document.addEventListener('visibilitychange', onVis);
        }
      }
      return {
        cancel: function () {
          active = false;
          try {
            if (typeof global.removeEventListener === 'function') global.removeEventListener('pagehide', handler);
            if (typeof global.document !== 'undefined' && global.document.removeEventListener) {
              global.document.removeEventListener('visibilitychange', onVis);
            }
          } catch (e) {}
          return Promise.resolve();
        }
      };
    }
    return {
      set: function (v) { return arm(function () { return ref.set(v); }); },
      update: function (o) { return arm(function () { return ref.update(o); }); },
      remove: function () { return arm(function () { return ref.remove(); }); },
      cancel: function () { return Promise.resolve(); } // sin handle previo: no-op
    };
  };

  function createDatabase() {
    function database() { return database; }
    database.ref = function (path) { return new Ref(splitPath(path || '')); };
    database.ServerValue = { TIMESTAMP: TIMESTAMP_SENTINEL };
    return database;
  }

  // autenticación

  function cognitoLib() {
    return (typeof global.AmazonCognitoIdentity !== 'undefined') ? global.AmazonCognitoIdentity : null;
  }

  function mapAuthError(err) {
    var code = (err && err.code) || '';
    var message = (err && err.message) || 'Error de autenticación';
    var out = new Error(message);
    switch (code) {
      case 'UserNotFoundException': out.code = 'auth/user-not-found'; break;
      case 'NotAuthorizedException': out.code = 'auth/wrong-password'; out.message = 'Correo o contraseña incorrectos.'; break;
      case 'UsernameExistsException': out.code = 'auth/email-already-in-use'; break;
      case 'InvalidPasswordException': out.code = 'auth/weak-password'; out.message = 'La contraseña no cumple los requisitos mínimos.'; break;
      case 'InvalidParameterException': out.code = 'auth/invalid-email'; break;
      case 'UserNotConfirmedException': out.code = 'auth/user-not-confirmed'; out.message = 'Debes verificar tu correo antes de iniciar sesión.'; break;
      case 'CodeMismatchException': out.code = 'auth/invalid-verification-code'; out.message = 'El código de verificación no es válido.'; break;
      case 'ExpiredCodeException': out.code = 'auth/code-expired'; out.message = 'El código venció. Solicita uno nuevo.'; break;
      case 'LimitExceededException': out.code = 'auth/too-many-requests'; break;
      case 'TooManyRequestsException': out.code = 'auth/too-many-requests'; break;
      case 'PasswordResetRequiredException': out.code = 'auth/password-reset-required'; out.message = 'Debes restablecer tu contraseña.'; break;
      default: out.code = 'auth/unknown';
    }
    return out;
  }

  var userPool = null;
  function getUserPool() {
    if (userPool) return userPool;
    var C = cognitoLib();
    if (!C) throw new Error('AmazonCognitoIdentity no cargado');
    userPool = new C.CognitoUserPool({
      UserPoolId: AWS_CONFIG.userPoolId,
      ClientId: AWS_CONFIG.userPoolClientId
    });
    return userPool;
  }

  // Usuario actual estilo compat: { uid, email, emailVerified, displayName, photoURL, ... }
  function makeCurrentUser(cognitoUser, attrs) {
    var map = {};
    (attrs || []).forEach(function (a) { map[a.getName()] = a.getValue(); });
    var user = {
      uid: map.sub || cognitoUser.getUsername(),
      email: map.email || cognitoUser.getUsername(),
      emailVerified: map.email_verified === 'true',
      displayName: map.name || null,
      photoURL: map.picture || null,
      _cognitoUser: cognitoUser,
      reload: function () {
        return refreshCurrentUserAttributes().then(function () { return undefined; });
      },
      updateProfile: function (profile) {
        return updateAuthProfile(profile || {});
      },
      updatePassword: function (newPassword) {
        return changeAuthPassword(newPassword);
      },
      sendEmailVerification: function () {
        return new Promise(function (resolve, reject) {
          try {
            cognitoUser.resendConfirmationCode(function (err) {
              if (err) reject(mapAuthError(err)); else resolve();
            });
          } catch (e) { reject(mapAuthError(e)); }
        });
      }
    };
    return user;
  }

  var authInstance = null;
  var authListeners = [];
  var currentCognitoUser = null;
  var refreshTimer = null;

  function getAuth() {
    if (authInstance) return authInstance;
    authInstance = {
      currentUser: null,
      languageCode: 'es', // no-op: se conserva la asignación del código existente
      onAuthStateChanged: function (cb) {
        authListeners.push(cb);
        // Llamada inicial asíncrona, como en el proveedor anterior
        setTimeout(function () { try { cb(authInstance.currentUser); } catch (e) { setTimeout(function () { throw e; }, 0); } }, 0);
        return function () {
          var i = authListeners.indexOf(cb);
          if (i !== -1) authListeners.splice(i, 1);
        };
      },
      signInWithEmailAndPassword: signInWithEmailAndPassword,
      signInWithUsernameAndPassword: signInWithUsernameAndPassword,
      createUserWithEmailAndPassword: createUserWithEmailAndPassword,
      signUpOrResendConfirmation: signUpOrResendConfirmation,
      confirmRegistration: confirmRegistration,
      resendConfirmation: resendConfirmation,
      sendPasswordResetEmail: sendPasswordResetEmail,
      confirmPasswordReset: confirmPasswordReset,
      signOut: signOutUser,
      signInWithPopup: signInWithPopup,
      // JWT del ID token de Cognito (para autenticar llamadas a lambdas propias)
      getIdToken: function () {
        return new Promise(function (resolve) {
          try {
            var C = cognitoLib();
            if (!C) return resolve(null);
            var cu = getUserPool().getCurrentUser();
            if (!cu) return resolve(null);
            cu.getSession(function (err, session) {
              if (err || !session || !session.isValid()) return resolve(null);
              try { resolve(session.getIdToken().getJwtToken()); }
              catch (e) { resolve(null); }
            });
          } catch (e) { resolve(null); }
        });
      }
    };
    return authInstance;
  }

  function notifyAuthListeners() {
    var u = authInstance.currentUser;
    authListeners.slice().forEach(function (cb) {
      try { cb(u); } catch (e) { setTimeout(function () { throw e; }, 0); }
    });
  }

  function refreshCurrentUserAttributes() {
    return new Promise(function (resolve) {
      if (!currentCognitoUser || !authInstance.currentUser) return resolve();
      currentCognitoUser.getUserAttributes(function (err, attrs) {
        if (!err && attrs) {
          var fresh = makeCurrentUser(currentCognitoUser, attrs);
          authInstance.currentUser.uid = fresh.uid;
          authInstance.currentUser.email = fresh.email;
          authInstance.currentUser.emailVerified = fresh.emailVerified;
          authInstance.currentUser.displayName = fresh.displayName;
          authInstance.currentUser.photoURL = fresh.photoURL;
        }
        resolve();
      });
    });
  }

  function updateAuthProfile(profile) {
    var user = authInstance.currentUser;
    if (!user) return Promise.reject(Object.assign(new Error('Sin sesión'), { code: 'auth/no-current-user' }));
    var C = cognitoLib();
    var attrs = [];
    if (profile.displayName !== undefined) attrs.push(new C.CognitoUserAttribute({ Name: 'name', Value: String(profile.displayName || '') }));
    if (profile.photoURL !== undefined) attrs.push(new C.CognitoUserAttribute({ Name: 'picture', Value: String(profile.photoURL || '') }));
    if (profile.displayName !== undefined) user.displayName = profile.displayName || null;
    if (profile.photoURL !== undefined) user.photoURL = profile.photoURL || null;
    if (!attrs.length || !currentCognitoUser) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      currentCognitoUser.updateAttributes(attrs, function (err) {
        if (err) reject(mapAuthError(err)); else resolve();
      });
    });
  }

  // Puente temporal: Cognito exige la contraseña actual para cambiarla.
  function changeAuthPassword(newPassword) {
    var cognitoUser = currentCognitoUser;
    if (!cognitoUser) return Promise.reject(Object.assign(new Error('Sin sesión'), { code: 'auth/no-current-user' }));
    var oldPassword = (typeof global.prompt === 'function')
      ? global.prompt('Por seguridad, escribe tu contraseña actual para cambiarla:')
      : null;
    if (oldPassword === null || oldPassword === undefined) {
      return Promise.reject(Object.assign(new Error('Cancelado'), { code: 'auth/cancelled' }));
    }
    return new Promise(function (resolve, reject) {
      cognitoUser.changePassword(String(oldPassword), String(newPassword), function (err) {
        if (err) {
          var mapped = mapAuthError(err);
          if (err.code === 'NotAuthorizedException') mapped.code = 'auth/requires-recent-login';
          reject(mapped);
        } else resolve();
      });
    });
  }

  function configureAwsCredentials(idToken) {
    var AWS = ensureAwsConfigured();
    var logins = {};
    logins[IDP_ISSUER] = idToken.getJwtToken();
    _awsCredentials = new AWS.CognitoIdentityCredentials({
      IdentityPoolId: AWS_CONFIG.identityPoolId,
      Logins: logins
    });
    _docClient = null; // el próximo getDocClient usará las credenciales nuevas
    return new Promise(function (resolve, reject) {
      _awsCredentials.get(function (err) {
        if (err) reject(err); else resolve();
      });
    });
  }

  // C12: si el refresh del token falla, la sesión murió. Se limpia el
  // estado de auth, se avisa a los listeners (la app vuelve al login) y se
  // deja una marca para mostrar "sesión expirada" en el idioma de la app.
  function handleExpiredSession() {
    try { if (currentCognitoUser) currentCognitoUser.signOut(); } catch (e) {}
    currentCognitoUser = null;
    if (authInstance) authInstance.currentUser = null;
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    _awsCredentials = null;
    _docClient = null;
    restoreSeq++;
    setRestorePending(false);
    flagSessionExpired('expired');
    notifyAuthListeners();
  }

  function scheduleTokenRefresh(cognitoUser, session) {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    try {
      var expMs = session.getIdToken().getExpiration() * 1000;
      var delay = expMs - Date.now() - 5 * 60 * 1000;
      if (delay < 60000) delay = 60000;
      refreshTimer = setTimeout(function () {
        cognitoUser.refreshSession(session.getRefreshToken(), function (err, newSession) {
          if (!err && newSession) {
            configureAwsCredentials(newSession.getIdToken()).catch(function (credErr) {
              // Fix 2026-09-17: NO tragar el fallo en silencio. Se anulan las
              // credenciales para no dejar un objeto a medias cacheado; la
              // próxima operación de BD las reconstruye vía withCredRetry
              // (auto-reparación sin reloguear).
              _awsCredentials = null;
              _docClient = null;
              try { if (typeof console !== 'undefined' && console.warn) console.warn('[DrexCloud] configureAwsCredentials falló tras refresh:', credErr && (credErr.code || credErr.message)); } catch (_) {}
            });
            scheduleTokenRefresh(cognitoUser, newSession);
          } else {
            handleExpiredSession();
          }
        });
      }, delay);
    } catch (e) { /* best-effort */ }
  }

  // Una promesa con tiempo límite: si la red se queda colgada, se continúa
  // con el flujo en vez de dejar la sesión atascada.
  function promiseTimeout(promise, ms, label) {    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; reject(new Error(label || 'timeout')); }
      }, ms);
      promise.then(function (v) {
        if (!settled) { settled = true; clearTimeout(timer); resolve(v); }
      }, function (e) {
        if (!settled) { settled = true; clearTimeout(timer); reject(e); }
      });
    });
  }

  // FIX 2026-09-18: las operaciones de DynamoDB no tenían ningún timeout.
  // Si la red se colgaba a mitad de la petición (típico en datos móviles),
  // la promesa jamás se resolvía y el login se quedaba en "Iniciando..."
  // para siempre, sin mostrar ningún error. Ahora fallan a los 25 s y el
  // flujo de login muestra el error con botón Reintentar en vez de atorarse.
  function dbTimeout(promise, label) {
    return promiseTimeout(promise, 25000, label || 'db-timeout');
  }

  // Reparación del índice de login por username (2026-09-20): las cuentas
  // creadas antes de la función "iniciar sesión con nombre de usuario"
  // tienen perfil con username pero NUNCA se escribió su entrada
  // `usernames/<normalizado>` en la tabla, que es lo que la Lambda
  // drex-username-resolve consulta. Sin esa entrada el login por username
  // devuelve "incorrecta" aunque la contraseña sea correcta.
  // Tras cada autenticación exitosa se asegura, SIN bloquear el login:
  //   1. `usernames/<normalizado>` -> uid (transacción suave: solo si está
  //      libre o ya apunta a este uid; jamás se roba el de otro usuario)
  //   2. `users/<uid>/email` -> email de Cognito (la Lambda lo necesita para
  //      resolver el correo sin exponerlo; Cognito es la fuente autoritativa)
  // No indexa usernames temporales (usernameIsFallback). Idempotente y
  // silencioso: cualquier fallo se ignora, el login no depende de esto.
  function ensureUsernameLoginIndex(user) {
    try {
      if (!user || !user.uid) return;
      var uid = String(user.uid);
      var email = user.email ? String(user.email) : '';
      new Ref(splitPath('users/' + uid + '/username')).once('value').then(function (snap) {
        var username = snap.val();
        if (!username || typeof username !== 'string') return null;
        username = username.trim().toLowerCase().replace(/^@+/, '').replace(/\s+/g, '');
        if (username.length < 3 || username.length > 30) return null;
        return new Ref(splitPath('users/' + uid + '/usernameIsFallback')).once('value').then(function (fb) {
          if (fb.val() === true) return null; // temporal: no se indexa
          return new Ref(splitPath('usernames/' + username)).transactionBlind(function (cur) {
            return (cur === null || cur === uid) ? uid : undefined;
          });
        });
      }).then(function (claim) {
        if (claim && claim.committed && email) {
          return new Ref(splitPath('users/' + uid + '/email')).set(email).catch(function () {});
        }
        return null;
      }).catch(function () { /* silencioso */ });
    } catch (e) { /* nunca bloquear el login */ }
  }

  // [HISTORIAL-ACCESOS] inicio — Registro del historial de accesos (Ing. #3, 2026-09-20).
  // Cada login EXPLÍCITO (email, username u OAuth) guarda un ítem
  // pk='users', sk='<uid>/logins/<timestamp_ms>_<rand>' con v=JSON:
  // {ts, ua, browser, os, deviceLabel, deviceType, tz, loginMethod}.
  // Fire-and-forget TOTAL: cualquier fallo se ignora en silencio; el login
  // nunca espera ni depende de esta escritura.
  // Privacidad: NO se guarda la IP (no hay forma de obtenerla del lado del
  // cliente sin un servicio externo, y enviarla a un tercero sería una fuga
  // de datos; la zona horaria sirve como aproximación gruesa). El userAgent
  // se trunca a 300 caracteres. Jamás contraseñas ni tokens.
  // Retención: máximo 50 accesos por usuario. La limpieza se hace EN LA
  // ESCRITURA, solo cuando se supera el límite: se leen las claves del
  // subárbol y se borran las más viejas hasta quedar en 50 (barato porque
  // solo ocurre cuando hay exceso; no se limpia en la lectura para que la
  // tabla no crezca si el usuario nunca abre el Centro de seguridad).
  var DREX_LOGIN_HISTORY_MAX = 50;
  var drexPendingLoginMethod = null; // 'email' | 'username' | 'oauth' | null

  function drexSummarizeUA(ua) {
    ua = String(ua || '');
    var browser = 'Navegador', os = '', deviceType = 'desktop';
    var m;
    if (/iPhone|iPad|iPod/i.test(ua)) { os = 'iOS'; deviceType = 'phone'; }
    else if (/Android/i.test(ua)) { os = 'Android'; deviceType = 'phone'; }
    else if (/Windows NT/i.test(ua)) os = 'Windows';
    else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';
    else if (/CrOS/i.test(ua)) os = 'ChromeOS';
    if (/Edg\/|EdgA|EdgiOS/i.test(ua)) browser = 'Edge';
    else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
    else if (/SamsungBrowser/i.test(ua)) browser = 'Samsung Internet';
    else if (/FxiOS/i.test(ua)) browser = 'Firefox';
    else if (/Firefox/i.test(ua)) browser = 'Firefox';
    else if (/CriOS/i.test(ua)) browser = 'Chrome';
    else if (/Chrome/i.test(ua)) browser = 'Chrome';
    else if (/Safari/i.test(ua)) browser = 'Safari';
    var devName = deviceType === 'phone'
      ? (/iPhone/i.test(ua) ? 'iPhone' : (/iPad/i.test(ua) ? 'iPad' : (/Android/i.test(ua) ? 'Android' : 'Móvil')))
      : 'Computadora';
    return { browser: browser, os: os, deviceType: deviceType, label: devName + ' · ' + browser };
  }

  function recordLoginHistory(user) {
    try {
      var method = drexPendingLoginMethod;
      drexPendingLoginMethod = null; // se consume una sola vez
      if (!method || !user || !user.uid) return; // restauración de sesión: no es un login
      var uid = String(user.uid);
      var now = Date.now();
      var ua = '';
      try { ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''; } catch (_) {}
      var info = drexSummarizeUA(ua);
      var tz = '';
      try { tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || ''; } catch (_) {}
      var record = {
        ts: now,
        ua: ua.slice(0, 300),
        browser: info.browser,
        os: info.os,
        deviceLabel: info.label,
        deviceType: info.deviceType,
        tz: tz,
        loginMethod: method
      };
      var key = String(now) + '_' + Math.random().toString(36).slice(2, 6);
      var baseRef = new Ref(splitPath('users/' + uid + '/logins'));
      baseRef.child(key).set(record).catch(function () {}).then(function () {
        return baseRef.once('value').then(function (snap) {
          var val = snap.val() || {};
          var keys = Object.keys(val).sort(); // prefijo ts numérico (13 dígitos) => orden cronológico
          var excess = keys.length - DREX_LOGIN_HISTORY_MAX;
          if (excess <= 0) return null;
          var oldest = keys.slice(0, excess);
          var chain = Promise.resolve();
          oldest.forEach(function (k) {
            chain = chain.then(function () { return baseRef.child(k).remove().catch(function () {}); });
          });
          return chain;
        }).catch(function () {});
      });
    } catch (e) { /* nunca bloquear el login */ }
  }
  // [HISTORIAL-ACCESOS] fin

  // [DISPOSITIVOS] inicio — alertas de dispositivo nuevo.
  // Fingerprint estable por dispositivo/navegador: userAgent normalizado
  // (familia de navegador + SO + móvil/escritorio, SIN versiones menores para
  // no alertar en cada auto-actualización del navegador), resolución de
  // pantalla, zona horaria e idioma. Registro en users/<uid>/devices/<hash>
  // (pk='users', sk='<uid>/devices/<hash>') con {label, firstSeen, lastSeen,
  // userAgent, tz}. La alerta in-app la muestra la app vía
  // window.drexOnNewDeviceDetected(info), solo si el usuario tiene las
  // alertas activadas. Todo es fire-and-forget: cualquier fallo se traga en
  // silencio para no romper jamás el login. Sin IP (privacidad) y sin email
  // (no hay SES configurado): solo alerta in-app.
  function drexDeviceUA() {
    try { return String((typeof navigator !== 'undefined' && navigator.userAgent) || ''); }
    catch (_) { return ''; }
  }
  function drexSummarizeDeviceUA(ua) {
    ua = String(ua || '');
    var browser = 'navegador', os = '', form = 'desktop';
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) form = 'mobile';
    if (/iPhone|iPad|iPod/i.test(ua)) os = 'ios';
    else if (/Android/i.test(ua)) os = 'android';
    else if (/Windows NT/i.test(ua)) os = 'windows';
    else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macos';
    else if (/Linux/i.test(ua)) os = 'linux';
    else if (/CrOS/i.test(ua)) os = 'chromeos';
    if (/Edg\/|EdgA|EdgiOS/i.test(ua)) browser = 'edge';
    else if (/OPR\/|Opera/i.test(ua)) browser = 'opera';
    else if (/SamsungBrowser/i.test(ua)) browser = 'samsung internet';
    else if (/FxiOS/i.test(ua)) browser = 'firefox';
    else if (/Firefox/i.test(ua)) browser = 'firefox';
    else if (/CriOS/i.test(ua)) browser = 'chrome';
    else if (/Chrome/i.test(ua)) browser = 'chrome';
    else if (/Safari/i.test(ua)) browser = 'safari';
    return { browser: browser, os: os, form: form };
  }
  function drexDeviceFriendlyLabel(ua) {
    ua = String(ua || '');
    var p = drexSummarizeDeviceUA(ua);
    var browserNames = { edge: 'Edge', opera: 'Opera', 'samsung internet': 'Samsung Internet', firefox: 'Firefox', chrome: 'Chrome', safari: 'Safari' };
    var browserName = browserNames[p.browser] || 'Navegador';
    var devicePart;
    if (p.form === 'mobile') {
      if (/iPhone/i.test(ua)) devicePart = 'iPhone';
      else if (/iPad/i.test(ua)) devicePart = 'iPad';
      else if (/Android/i.test(ua)) devicePart = 'Android';
      else devicePart = 'Móvil';
    } else {
      var osNames = { windows: 'Windows', macos: 'macOS', linux: 'Linux', chromeos: 'ChromeOS', ios: 'iOS', android: 'Android' };
      devicePart = osNames[p.os] || 'Computadora';
    }
    return devicePart + ' · ' + browserName;
  }
  function drexShortUA(ua) {
    ua = String(ua || '');
    var p = drexSummarizeDeviceUA(ua);
    var browserNames = { edge: 'Edge', opera: 'Opera', 'samsung internet': 'Samsung Internet', firefox: 'Firefox', chrome: 'Chrome', safari: 'Safari' };
    var browserName = browserNames[p.browser] || 'Navegador';
    var m = null;
    if (p.browser === 'edge') m = /Edg(?:A|iOS)?\/(\d+)/i.exec(ua);
    else if (p.browser === 'opera') m = /(?:OPR|Opera)\/(\d+)/i.exec(ua);
    else if (p.browser === 'samsung internet') m = /SamsungBrowser\/(\d+)/i.exec(ua);
    else if (p.browser === 'firefox') m = /(?:FxiOS|Firefox)\/(\d+)/i.exec(ua);
    else if (p.browser === 'chrome') m = /(?:CriOS|Chrome)\/(\d+)/i.exec(ua);
    else if (p.browser === 'safari') m = /Version\/(\d+)/i.exec(ua);
    var ver = m ? ' ' + m[1] : '';
    var osNames = { windows: 'Windows', macos: 'macOS', linux: 'Linux', chromeos: 'ChromeOS', ios: 'iOS', android: 'Android' };
    var osPart = osNames[p.os] ? ' · ' + osNames[p.os] : '';
    return (browserName + ver + osPart).slice(0, 120);
  }
  function drexDeviceFingerprintString() {
    var ua = drexDeviceUA();
    var p = drexSummarizeDeviceUA(ua);
    var res = '';
    try {
      var s = (typeof screen !== 'undefined') ? screen : null;
      if (s && s.width && s.height) res = s.width + 'x' + s.height;
    } catch (_) {}
    var tz = '', lang = '';
    try { tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || ''; } catch (_) {}
    try { lang = (typeof navigator !== 'undefined' && navigator.language) || ''; } catch (_) {}
    return ['drex-dev-v1', p.browser, p.os, p.form, res, String(tz), String(lang)].join('|');
  }
  function drexCyrb53(str, seed) {
    str = String(str);
    var h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    var a = (h2 >>> 0).toString(16), b = (h1 >>> 0).toString(16);
    while (a.length < 8) a = '0' + a;
    while (b.length < 8) b = '0' + b;
    return a + b;
  }
  function drexHashDeviceString(str) {
    str = String(str);
    try {
      var c = (typeof crypto !== 'undefined') ? crypto : null;
      if (c && c.subtle && typeof c.subtle.digest === 'function') {
        var bytes = null;
        try { bytes = new TextEncoder().encode(str); } catch (_) { bytes = null; }
        if (bytes) {
          return c.subtle.digest('SHA-256', bytes).then(function (buf) {
            var arr = new Uint8Array(buf), out = '';
            for (var i = 0; i < arr.length; i++) out += ('0' + arr[i].toString(16)).slice(-2);
            return out;
          }, function () { return drexCyrb53(str); });
        }
      }
    } catch (_) {}
    return Promise.resolve(drexCyrb53(str));
  }
  function drexTzCity(tz) {
    var parts = String(tz || '').split('/');
    var city = parts.length ? parts[parts.length - 1] : '';
    return city.replace(/_/g, ' ');
  }
  function drexNotifyNewDevice(info) {
    try {
      var key = 'drex_newdevice_alert_' + info.uid + '_' + info.fpHash;
      var seen = false;
      try { seen = !!(typeof sessionStorage !== 'undefined' && sessionStorage.getItem(key)); } catch (_) {}
      if (seen) return;
      try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, String(Date.now())); } catch (_) {}
      var w = (typeof window !== 'undefined') ? window : ((typeof globalThis !== 'undefined') ? globalThis : null);
      var cb = w && w.drexOnNewDeviceDetected;
      if (typeof cb === 'function') { try { cb(info); } catch (_) {} }
    } catch (_) {}
  }
  // db inyectable para pruebas; en producción usa el Ref real de DynamoDB.
  function checkDrexNewDevice(user, db) {
    function done(result) { return Promise.resolve(result); }
    try {
      if (!user || !user.uid) return done({ checked: false });
      var uid = String(user.uid);
      var ua = drexDeviceUA();
      var fpString = drexDeviceFingerprintString();
      var label = drexDeviceFriendlyLabel(ua);
      var uaShort = drexShortUA(ua);
      var tz = '';
      try { tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || ''; } catch (_) {}
      var now = Date.now();
      var database = db || { ref: function (path) { return new Ref(splitPath(path)); } };
      var devicesRef, prefsRef;
      try {
        devicesRef = database.ref('users/' + uid + '/devices');
        prefsRef = database.ref('security/' + uid + '/preferences');
      } catch (e) { return done({ checked: false, error: 'ref' }); }
      return drexHashDeviceString(fpString).then(function (fpHash) {
        var oneRef = devicesRef.child(fpHash);
        return Promise.all([
          oneRef.once('value').then(function (s) { return s.val(); }, function () { return 'READ_ERROR'; }),
          prefsRef.once('value').then(function (s) { return s.val() || {}; }, function () { return {}; })
        ]).then(function (pair) {
          var existing = pair[0], prefs = pair[1] || {};
          if (existing === 'READ_ERROR') return { checked: false, error: 'read' };
          if (existing && typeof existing === 'object') {
            // Dispositivo conocido: solo refrescar lastSeen (y etiqueta).
            return oneRef.update({ lastSeen: now, label: label }).then(function () {
              return { checked: true, isNew: false, fpHash: fpHash };
            }, function () { return { checked: true, isNew: false, fpHash: fpHash, error: 'write' }; });
          }
          // Dispositivo nuevo: registrar primero; la alerta solo si el registro funcionó.
          var record = { label: label, firstSeen: now, lastSeen: now, userAgent: uaShort, tz: String(tz) };
          return oneRef.set(record).then(function () {
            var alertsOn = prefs.securityChangeAlerts !== false && prefs.newDeviceAlerts !== false;
            if (alertsOn) drexNotifyNewDevice({ uid: uid, fpHash: fpHash, label: label, firstSeen: now, tz: String(tz), tzCity: drexTzCity(tz) });
            return { checked: true, isNew: true, fpHash: fpHash, alertShown: alertsOn };
          }, function () { return { checked: true, isNew: true, fpHash: fpHash, alertShown: false, error: 'write' }; });
        });
      }, function () { return { checked: false, error: 'hash' }; });
    } catch (e) {
      return done({ checked: false, error: 'unexpected' });
    }
  }
  // [DISPOSITIVOS] fin

  function establishSession(cognitoUser, session) {

    currentCognitoUser = cognitoUser;
    restoreSeq++;
    return new Promise(function (resolve) {
      // Los atributos enriquecen el usuario, pero una sesión válida no debe
      // morir si esta llamada falla o se cuelga (sin red al abrir la app):
      // se usan los datos del ID token como respaldo.
      var tokenAttrs = attrsFromIdToken(session);
      var finished = false;
      function finish(useAttrs, usedFallback) {
        if (finished) return;
        finished = true;
        if (usedFallback) {
          try { console.warn('[DrexCloud] getUserAttributes no disponible; sesión establecida con datos del token.'); } catch (_) {}
        }
        authInstance.currentUser = makeCurrentUser(cognitoUser, useAttrs || []);
        // Reparación no bloqueante del índice de login por username
        // (cuentas creadas antes de esa función). Corre en segundo plano;
        // el login no espera ni depende de ella.
        try { setTimeout(function () { ensureUsernameLoginIndex(authInstance.currentUser); }, 0); } catch (_) {}
        // [HISTORIAL-ACCESOS] inicio — Ing. #3: registra el acceso (fire-and-forget).
        try { setTimeout(function () { recordLoginHistory(authInstance.currentUser); }, 0); } catch (_) {}
        // [HISTORIAL-ACCESOS] fin
        // [DISPOSITIVOS] inicio — verificación de dispositivo nuevo.
        // Fire-and-forget: jamás bloquea ni rompe el login.
        try { setTimeout(function () { checkDrexNewDevice(authInstance.currentUser); }, 0); } catch (_) {}
        // [DISPOSITIVOS] fin
        // [SESIONES] inicio — Ing. #5: registro de sesión activa (fire-and-forget).
        try { setTimeout(function () { drexSessionsRegister(authInstance.currentUser); }, 0); } catch (_) {}
        // [SESIONES] fin
        var credPromise = promiseTimeout(Promise.resolve().then(function () {
          return configureAwsCredentials(session.getIdToken());
        }), 15000, 'aws-creds-timeout');
        credPromise.then(function () {
          scheduleTokenRefresh(cognitoUser, session);
          clearSessionExpiredFlag();
          setRestorePending(false);
          notifyAuthListeners();
          resolve(authInstance.currentUser);
        }, function (credErr) {
          // Sesión válida aunque las credenciales AWS fallen o tarden:
          // se reintentan al usar la BD.
          _awsCredentials = null;
          scheduleTokenRefresh(cognitoUser, session);
          clearSessionExpiredFlag();
          setRestorePending(false);
          notifyAuthListeners();
          resolve(authInstance.currentUser);
        });
      }
      var attrTimer = setTimeout(function () { finish(tokenAttrs, true); }, 10000);
      try {
        cognitoUser.getUserAttributes(function (err, attrs) {
          clearTimeout(attrTimer);
          var ok = (!err && attrs && attrs.length);
          finish(ok ? attrs : tokenAttrs, !ok);
        });
      } catch (e) {
        clearTimeout(attrTimer);
        finish(tokenAttrs, true);
      }
    });
  }

  function signInWithEmailAndPassword(email, password) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var cleanEmail = String(email).trim();
    var lowerEmail = cleanEmail.toLowerCase();
    // Cognito distingue mayúsculas/minúsculas en el nombre de usuario: si el
    // correo se escribió con distintas mayúsculas que en el registro, el
    // primer intento devuelve "no autorizado" y la app lo mostraba como
    // "contraseña incorrecta". Se reintenta una vez en minúsculas antes de
    // reportar el error, sin cambiar el comportamiento de cuentas existentes.
    return attemptSignIn(cleanEmail).catch(function (err) {
      var wrongPw = err && (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential' || err.code === 'auth/invalid-login-credentials');
      if (wrongPw && lowerEmail !== cleanEmail) return attemptSignIn(lowerEmail);
      throw err;
    });
    function attemptSignIn(em) {
      var cognitoUser = new C.CognitoUser({ Username: em, Pool: getUserPool() });
      var authDetails = new C.AuthenticationDetails({ Username: em, Password: String(password) });
      // FIX 2026-09-18: authenticateUser no tenía timeout. Si el endpoint de
      // Cognito se colgaba, el botón se quedaba en "Iniciando..." para
      // siempre sin mostrar ningún error. Ahora falla a los 30 s con mensaje
      // de conexión. EXCEPCIÓN (MFA 2026-09-20): cuando Cognito pide el desafío
      // TOTP (totpRequired), el temporizador de red se apaga y rige la ventana
      // del código (MFA_CODE_WINDOW_MS): el usuario necesita tiempo para abrir
      // su app de autenticación y escribir el código.
      return new Promise(function (resolve, reject) {
        var done = false;
        var mfaPhase = false;
        var netTimer = setTimeout(function () {
          if (!done && !mfaPhase) {
            done = true;
            var t = new Error('Tiempo de espera agotado. Revisa tu conexión.');
            t.code = 'auth/network-request-failed';
            reject(t);
          }
        }, 30000);
        var mfaTimer = null;
        function clearTimers() {
          try { clearTimeout(netTimer); } catch (_) {}
          try { if (mfaTimer) clearTimeout(mfaTimer); } catch (_) {}
        }
        function ok(user) { if (!done) { done = true; clearTimers(); resolve({ user: user }); } }
        function fail(err) { if (!done) { done = true; clearTimers(); reject(err); } }
        try {
          cognitoUser.authenticateUser(authDetails, {
            onSuccess: function (session) {
              // [HISTORIAL-ACCESOS] marca el método ANTES de establecer la sesión.
              drexPendingLoginMethod = 'email';
              establishSession(cognitoUser, session).then(function (user) { ok(user); }, fail);
            },
            onFailure: function (err) {
              if (err && err.code === 'UserNotConfirmedException') {
                // La cuenta existe pero el email no está verificado: la app debe
                // llevar al usuario a la pantalla de código de verificación.
                var need = new Error('Tu correo aún no está verificado. Escribe el código que te enviamos.');
                need.code = 'auth/needs-confirmation';
                need.email = em;
                fail(need);
                return;
              }
              fail(mapAuthError(err));
            },
            // Desafío TOTP (MFA opcional del pool con "Authenticator apps"):
            // se completa con el código de 6 dígitos mediante la vista de
            // desafío (#twofactor-challenge-view). NOTA: en este SDK el
            // callback es `totpRequired`, no `mfaRequired` (ese es solo SMS).
            totpRequired: function (challengeName, challengeParameters) {
              mfaPhase = true;
              try { clearTimeout(netTimer); } catch (_) {}
              mfaTimer = setTimeout(function () { fail(mfaExpiredError()); }, MFA_CODE_WINDOW_MS);
              beginMfaChallenge({
                kind: 'email',
                submitCode: function (code) {
                  return new Promise(function (res, rej) {
                    try {
                      cognitoUser.sendMFACode(String(code).trim(), {
                        onSuccess: function (session) {
                          // [HISTORIAL-ACCESOS] marca el método (login email con MFA).
                          drexPendingLoginMethod = 'email';
                          establishSession(cognitoUser, session).then(function (user) { res({ user: user }); }, rej);
                        },
                        onFailure: function (err) { rej(mapMfaError(err)); }
                      }, 'SOFTWARE_TOKEN_MFA');
                    } catch (e) { rej(mapMfaError(e)); }
                  });
                },
                cancel: function () { fail(Object.assign(new Error('Verificación cancelada.'), { code: 'auth/mfa-cancelled' })); }
              }).then(function (r) { ok(r.user); }, fail);
            },
            newPasswordRequired: function () {
              fail(Object.assign(new Error('Debes restablecer tu contraseña.'), { code: 'auth/password-reset-required' }));
            }
          });
        } catch (e) { fail(mapAuthError(e)); }
      });
    }
  }

  // Inicio de sesión con nombre de usuario (2026-09-20).
  // El User Pool solo acepta el correo como identificador (los aliases son
  // inmutables del pool), así que la autenticación ocurre en el servidor:
  // la Lambda drex-username-resolve normaliza el username, lo resuelve a
  // email en DynamoDB y autentica con Cognito (ADMIN_NO_SRP_AUTH),
  // devolviendo SOLO los tokens. El correo jamás sale del servidor y los
  // errores son genéricos (sin enumeración de cuentas).
  // Aquí se reconstruye la sesión de Cognito con esos tokens para que todo
  // lo demás (refresh, credenciales AWS, listeners) funcione igual que con
  // el login por correo.
  // Paso 2 del login con MFA por username (Ing. #1, 2026-09-20): envía el
  // código TOTP junto con la sesión opaca del desafío que devolvió el paso 1.
  // Resuelve con el JSON de la Lambda ({tokens}) o rechaza con un error
  // genérico (401 -> reintentable, para que la vista deje intentar de nuevo).
  function usernameMfaStep2(loginUrl, username, challengeSession, code) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (_) {} }, 20000);
    function clearTimer() { try { clearTimeout(timer); } catch (_) {} }
    var fetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: String(username || ''), session: String(challengeSession || ''), code: String(code || '') })
    };
    if (ctrl) fetchOpts.signal = ctrl.signal;
    return fetch(loginUrl, fetchOpts).then(function (resp) {
      clearTimer();
      if (resp.status === 429) {
        var e429 = new Error('Demasiados intentos. Inténtalo de nuevo en un minuto.');
        e429.code = 'auth/too-many-requests';
        throw e429;
      }
      return resp.json().then(function (data) {
        if (!resp.ok) {
          var e = new Error('Código incorrecto o vencido. Inténtalo de nuevo.');
          e.code = 'auth/invalid-mfa-code';
          e.retryable = (resp.status === 401);
          throw e;
        }
        return data;
      });
    }).catch(function (err) {
      clearTimer();
      if (err && err.name === 'AbortError') {
        var te = new Error('Tiempo de espera agotado. Revisa tu conexión.');
        te.code = 'auth/network-request-failed';
        throw te;
      }
      throw err;
    });
  }

  // Detecta forma de código de respaldo con el MISMO criterio que la UI
  // del desafío (#twofactor-challenge-view): 6+ caracteres alfanuméricos o
  // guiones con al menos una letra o guion. Los códigos TOTP son
  // exactamente 6 dígitos, así que nunca colisionan.
  function looksLikeRecoveryCode(code) {
    var s = String(code == null ? '' : code).trim();
    return /^[A-Za-z0-9-]{6,}$/.test(s) && /[^0-9]/.test(s);
  }

  // Paso R del login con username (2026-09-20): canje de código de respaldo
  // en el SERVIDOR (contrato con el backend drex-username-resolve).
  // POST {username, password, recoveryCode} a la misma Function URL.
  // El password viaja solo por HTTPS al backend propio y no se guarda más
  // allá del intento (vive en el closure del login en curso).
  // Respuestas:
  //   200 {tokens: {..., recoveryUsed: true}} -> canje OK; el servidor
  //       desactivó el 2FA. Construir la sesión como en el paso 2.
  //   200 {tokens} sin recoveryUsed -> el 2FA no estaba activo; login
  //       normal, no se quemó ningún código.
  //   401 -> genérico reintentable (username/contraseña/código mal, código
  //       ya usado o formato inválido). La UI no distingue "inválido" de
  //       "bloqueado".
  //   429 -> demasiados intentos (incluye el bloqueo temporal de canje:
  //       5 intentos/15 min por username).
  //   403 -> igual que el paso 1 (unconfirmed / reset_required).
  function usernameRecoveryStep2(loginUrl, username, password, recoveryCode) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (_) {} }, 20000);
    function clearTimer() { try { clearTimeout(timer); } catch (_) {} }
    var fetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: String(username || ''),
        password: String(password || ''),
        recoveryCode: String(recoveryCode || '')
      })
    };
    if (ctrl) fetchOpts.signal = ctrl.signal;
    return fetch(loginUrl, fetchOpts).then(function (resp) {
      clearTimer();
      if (resp.status === 429) {
        var e429 = new Error('Demasiados intentos. Inténtalo más tarde.');
        e429.code = 'auth/too-many-requests';
        throw e429;
      }
      if (resp.status === 403) {
        return resp.json().then(function (data) {
          var code = (data && data.error) || '';
          if (code === 'unconfirmed') {
            // Sin correo conocido (el servidor no lo revela): la app pide
            // al usuario iniciar sesión con su correo para verificarla.
            var need = new Error('Tu cuenta aún no está verificada. Inicia sesión con tu correo electrónico para verificarla.');
            need.code = 'auth/needs-confirmation';
            throw need;
          }
          var rst = new Error('Debes restablecer tu contraseña.');
          rst.code = 'auth/password-reset-required';
          throw rst;
        });
      }
      return resp.json().then(function (data) {
        if (!resp.ok) {
          var e = new Error('Código de respaldo inválido. Revisa e inténtalo de nuevo.');
          e.code = 'auth/invalid-recovery-code';
          e.retryable = (resp.status === 401);
          throw e;
        }
        return data;
      });
    }).catch(function (err) {
      clearTimer();
      if (err && err.name === 'AbortError') {
        var te = new Error('Tiempo de espera agotado. Revisa tu conexión.');
        te.code = 'auth/network-request-failed';
        throw te;
      }
      throw err;
    });
  }

  // Construye la sesión de Cognito a partir de los tokens que devuelve la
  // Lambda (paso 1 directo o paso 2 tras el desafío MFA). Idéntico en ambos
  // casos: el username de Cognito es el correo y se lee del claim `email` del
  // ID token (respaldo: `cognito:username`); el servidor nunca lo envía.
  function buildSessionFromLambdaTokens(data) {
    var C = cognitoLib();
    var t = (data && data.tokens) || {};
    if (!t.idToken || !t.accessToken || !t.refreshToken) {
      return Promise.reject(Object.assign(new Error('Error de conexión. Revisa tu internet.'), { code: 'auth/network-request-failed' }));
    }
    var claims = null;
    try {
      var parts = String(t.idToken).split('.');
      if (parts.length >= 2) claims = JSON.parse(base64UrlDecode(parts[1]));
    } catch (e) { claims = null; }
    var cognitoUsername = (claims && (claims.email || claims['cognito:username'])) || '';
    if (!cognitoUsername) {
      return Promise.reject(Object.assign(new Error('Error de conexión. Revisa tu internet.'), { code: 'auth/network-request-failed' }));
    }
    var session = new C.CognitoUserSession({
      IdToken: new C.CognitoIdToken({ IdToken: t.idToken }),
      AccessToken: new C.CognitoAccessToken({ AccessToken: t.accessToken }),
      RefreshToken: new C.CognitoRefreshToken({ RefreshToken: t.refreshToken })
    });
    if (!session.isValid()) {
      return Promise.reject(Object.assign(new Error('Nombre de usuario o contraseña incorrectos.'), { code: 'auth/invalid-credential' }));
    }
    var cognitoUser = new C.CognitoUser({ Username: cognitoUsername, Pool: getUserPool() });
    cognitoUser.setSignInUserSession(session);
    // [HISTORIAL-ACCESOS] marca el método ANTES de establecer la sesión.
    drexPendingLoginMethod = 'username';
    // recoveryUsed: el servidor canjeó un código de respaldo (paso R) y
    // desactivó el 2FA. Se expone para que la UI muestre el aviso y se
    // refresca la bandera local para que el Centro de seguridad no diga
    // que la verificación sigue activa. No se asume que queden códigos.
    var recoveryUsed = !!(((data && data.tokens) || {}).recoveryUsed);
    return establishSession(cognitoUser, session).then(function (user) {
      if (recoveryUsed && user && user.uid) {
        try { new Ref(splitPath('users/' + user.uid + '/twoFactorEnabled')).set(false).catch(function () {}); } catch (_) {}
      }
      return { user: user, recoveryUsed: recoveryUsed };
    });
  }

  function signInWithUsernameAndPassword(username, password) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var url = (AWS_CONFIG.usernameLoginUrl || '').replace(/\/$/, '');
    if (!url) {
      var nc = new Error('Error de conexión. Revisa tu internet.');
      nc.code = 'auth/network-request-failed';
      return Promise.reject(nc);
    }
    // MFA (2026-09-20): si la cuenta tiene TOTP activado, el paso 1 de la
    // Lambda responde {challenge:'mfa', session}; el paso 2 envía el código
    // de 6 dígitos. Los temporizadores de red se apagan al entrar en fase MFA
    // y rige la ventana del código (MFA_CODE_WINDOW_MS).
    return new Promise(function (resolve, reject) {
      var done = false;
      var mfaPhase = false;
      var mfaTimer = null;
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var netAbort = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (_) {} }, 20000);
      var hardTimer = setTimeout(function () {
        if (!done && !mfaPhase) {
          done = true;
          var t = new Error('Tiempo de espera agotado. Revisa tu conexión.');
          t.code = 'auth/network-request-failed';
          reject(t);
        }
      }, 30000);
      function clearTimers() {
        try { clearTimeout(netAbort); } catch (_) {}
        try { clearTimeout(hardTimer); } catch (_) {}
        try { if (mfaTimer) clearTimeout(mfaTimer); } catch (_) {}
      }
      function ok(user) { if (!done) { done = true; clearTimers(); resolve({ user: user }); } }
      function fail(err) { if (!done) { done = true; clearTimers(); reject(err); } }

      var fetchOpts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: String(username || ''), password: String(password || '') })
      };
      if (ctrl) fetchOpts.signal = ctrl.signal;

      fetch(url, fetchOpts).then(function (resp) {
        clearTimers();
        if (resp.status === 429) {
          var e429 = new Error('Demasiados intentos. Inténtalo de nuevo en un minuto.');
          e429.code = 'auth/too-many-requests';
          throw e429;
        }
        if (resp.status === 403) {
          return resp.json().then(function (data) {
            var code = (data && data.error) || '';
            if (code === 'unconfirmed') {
              // Sin correo conocido (el servidor no lo revela): la app pide
              // al usuario iniciar sesión con su correo para verificarla.
              var need = new Error('Tu cuenta aún no está verificada. Inicia sesión con tu correo electrónico para verificarla.');
              need.code = 'auth/needs-confirmation';
              throw need;
            }
            var rst = new Error('Debes restablecer tu contraseña.');
            rst.code = 'auth/password-reset-required';
            throw rst;
          });
        }
        if (!resp.ok) {
          throw Object.assign(new Error('Nombre de usuario o contraseña incorrectos.'), { code: 'auth/invalid-credential' });
        }
        return resp.json();
      }).then(function (data) {
        // Desafío MFA: la Lambda devolvió la sesión del desafío; se pide el
        // código en la vista de desafío y se completa con el paso 2.
        if (data && data.challenge === 'mfa' && data.session) {
          mfaPhase = true;
          mfaTimer = setTimeout(function () { fail(mfaExpiredError()); }, MFA_CODE_WINDOW_MS);
          beginMfaChallenge({
            kind: 'username',
            submitCode: function (code) {
              // Canje de respaldo en el servidor (paso R): si el texto tiene
              // forma de código de respaldo se envía {username, password,
              // recoveryCode}; el password está en el closure y no se guarda
              // más allá del intento. Si no, es el TOTP de 6 dígitos (paso 2).
              if (looksLikeRecoveryCode(code)) {
                return usernameRecoveryStep2(url, username, password, code).then(function (data2) {
                  return buildSessionFromLambdaTokens(data2);
                });
              }
              return usernameMfaStep2(url, username, data.session, code).then(function (data2) {
                return buildSessionFromLambdaTokens(data2);
              });
            },
            cancel: function () { fail(Object.assign(new Error('Verificación cancelada.'), { code: 'auth/mfa-cancelled' })); }
          }).then(function (r) { ok(r.user); }, fail);
          return;
        }
        buildSessionFromLambdaTokens(data).then(function (r) { ok(r.user); }, fail);
      }).catch(function (err) {
        if (err && err.name === 'AbortError') {
          var te = new Error('Tiempo de espera agotado. Revisa tu conexión.');
          te.code = 'auth/network-request-failed';
          fail(te);
          return;
        }
        fail(err);
      });
    });
  }

  function createUserWithEmailAndPassword(email, password) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    // El correo se guarda en minúsculas: Cognito distingue mayúsculas en el
    // nombre de usuario y Gmail (y la mayoría de proveedores) no.
    var cleanEmail = String(email).trim().toLowerCase();
    var attrs = [new C.CognitoUserAttribute({ Name: 'email', Value: cleanEmail })];
    return new Promise(function (resolve, reject) {
      getUserPool().signUp(cleanEmail, String(password), attrs, null, function (err, result) {
        if (err) { reject(mapAuthError(err)); return; }
        if (result && result.userConfirmed) {
          // Autoconfirmado: entrar de inmediato
          signInWithEmailAndPassword(cleanEmail, String(password)).then(resolve, reject);
        } else {
          // El User Pool no debería exigir verificación (está desactivada),
          // pero si algún día vuelve a exigirla, la app muestra un error.
          resolve({ user: null, needsConfirmation: true, email: cleanEmail });
        }
      });
    });
  }

  // Registro tolerante a registros abandonados: si el correo ya existe en
  // Cognito pero la cuenta sigue SIN confirmar (el usuario abandonó el
  // registro en la pantalla del código, cerró la app o el código venció),
  // reenvía el código de verificación y retoma el registro en vez de
  // mostrar "correo ya registrado". Solo si la cuenta ya está confirmada
  // se conserva el error auth/email-already-in-use (ahí sí pertenece a
  // otra cuenta y corresponde iniciar sesión / recuperar contraseña).
  // Resuelve igual que createUserWithEmailAndPassword, con `resumed: true`
  // cuando se retomó un registro previo sin confirmar.
  function signUpOrResendConfirmation(email, password) {
    return createUserWithEmailAndPassword(email, password).catch(function (err) {
      if (!err || err.code !== 'auth/email-already-in-use') throw err;
      var C = cognitoLib();
      if (!C) throw err;
      var cleanEmail = String(email).trim().toLowerCase();
      var cognitoUser = new C.CognitoUser({ Username: cleanEmail, Pool: getUserPool() });
      return new Promise(function (resolve, reject) {
        cognitoUser.resendConfirmationCode(function (rerr) {
          if (!rerr) {
            resolve({ user: null, needsConfirmation: true, email: cleanEmail, resumed: true });
            return;
          }
          // Cuenta ya confirmada: el correo pertenece a una cuenta existente.
          var msg = String((rerr && rerr.message) || '').toLowerCase();
          if (rerr.code === 'InvalidParameterException' || /already confirm/i.test(msg)) {
            reject(err);
            return;
          }
          reject(mapAuthError(rerr));
        });
      });
    });
  }

  // Confirma la cuenta con el código de 6 dígitos enviado al correo.
  // Resuelve con 'CONFIRMED' (o 'ALREADY_CONFIRMED' si ya estaba verificada).
  function confirmRegistration(email, code) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var cleanEmail = String(email).trim().toLowerCase();
    var cleanCode = String(code).trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      var bad = new Error('Escribe el código de 6 dígitos que recibiste por correo.');
      bad.code = 'auth/invalid-verification-code';
      return Promise.reject(bad);
    }
    var cognitoUser = new C.CognitoUser({ Username: cleanEmail, Pool: getUserPool() });
    return new Promise(function (resolve, reject) {
      cognitoUser.confirmRegistration(cleanCode, true, function (err, result) {
        if (err) {
          // Si ya estaba confirmada (p. ej. doble envío), no es un error real.
          var msg = String((err && err.message) || '');
          if (err.code === 'NotAuthorizedException' && /confirm/i.test(msg)) {
            resolve('ALREADY_CONFIRMED');
            return;
          }
          reject(mapAuthError(err));
          return;
        }
        resolve(result || 'CONFIRMED');
      });
    });
  }

  function resendConfirmation(email) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var cleanEmail = String(email).trim().toLowerCase();
    var cognitoUser = new C.CognitoUser({ Username: cleanEmail, Pool: getUserPool() });
    return new Promise(function (resolve, reject) {
      cognitoUser.resendConfirmationCode(function (err, result) {
        if (err) reject(mapAuthError(err)); else resolve(result);
      });
    });
  }

  // Cognito envía un CÓDIGO de 6 dígitos por correo (no un enlace).
  // Esta función solo envía el código; la app pide el PIN y la nueva
  // contraseña en su propia sección (login y Ajustes).
  function sendPasswordResetEmail(email) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var cleanEmail = String(email).trim().toLowerCase();
    var cognitoUser = new C.CognitoUser({ Username: cleanEmail, Pool: getUserPool() });
    return new Promise(function (resolve, reject) {
      cognitoUser.forgotPassword({
        onSuccess: function () { resolve(); },
        onFailure: function (err) { reject(mapAuthError(err)); }
      });
    });
  }

  function confirmPasswordReset(email, code, newPassword) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var cognitoUser = new C.CognitoUser({ Username: String(email).trim().toLowerCase(), Pool: getUserPool() });
    return new Promise(function (resolve, reject) {
      cognitoUser.confirmPassword(String(code).trim(), String(newPassword), {
        onSuccess: function () { resolve(); },
        onFailure: function (err) { reject(mapAuthError(err)); }
      });
    });
  }

  function signOutUser() {
    getAuth();
    restoreSeq++;
    setRestorePending(false);
    // [SESIONES] Ing. #5: revocar refresh token en Cognito + marcar registro propio (fire-and-forget).
    try { drexSessionsOnLocalSignOut(); } catch (e) {}
    return new Promise(function (resolve) {
      try { if (currentCognitoUser) currentCognitoUser.signOut(); } catch (e) {}
      currentCognitoUser = null;
      if (authInstance) authInstance.currentUser = null;
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      _awsCredentials = null;
      _docClient = null;
      notifyAuthListeners();
      resolve();
    });
  }

  // Login social real via Cognito OAuth (Google / Facebook)
  // Redirige a Cognito, que hace el baile OAuth con el proveedor y regresa
  // con ?code= ; aquí se canjea por tokens y se abre la sesión.
  var SOCIAL_IDP = { Google: 'Google', Facebook: 'Facebook' };

  function oauthAvailable() {
    return !!(AWS_CONFIG.oauthDomain && AWS_CONFIG.oauthRedirectUri && AWS_CONFIG.userPoolClientId);
  }

  function federatedSignIn(providerName) {
    getAuth();
    if (!oauthAvailable()) {
      var err = new Error('El login social aún no está activado en el servidor.');
      err.code = 'auth/operation-not-allowed';
      return Promise.reject(err);
    }
    var url = 'https://' + AWS_CONFIG.oauthDomain + '/oauth2/authorize'
      + '?identity_provider=' + encodeURIComponent(providerName)
      + '&redirect_uri=' + encodeURIComponent(AWS_CONFIG.oauthRedirectUri)
      + '&response_type=code'
      + '&client_id=' + encodeURIComponent(AWS_CONFIG.userPoolClientId)
      + '&scope=' + encodeURIComponent(AWS_CONFIG.oauthScope || 'email openid profile');
    try { global.location.assign(url); }
    catch (e) { global.location.href = url; }
    return new Promise(function () {}); // la página navega fuera
  }

  function base64UrlDecode(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    // atob maneja UTF-8 mal; los claims que leemos son ASCII
    return global.atob(s);
  }

  function exchangeCodeForSession(code) {
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var body = 'grant_type=authorization_code'
      + '&client_id=' + encodeURIComponent(AWS_CONFIG.userPoolClientId)
      + '&code=' + encodeURIComponent(code)
      + '&redirect_uri=' + encodeURIComponent(AWS_CONFIG.oauthRedirectUri);
    // FIX 2026-09-18: el fetch al token endpoint no tenía timeout. Si se
    // colgaba, el login social se quedaba en spinner eterno (se había
    // disparado drex:oauth-pending pero la promesa jamás se resolvía).
    return promiseTimeout(global.fetch('https://' + AWS_CONFIG.oauthDomain + '/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body
    }), 25000, 'oauth-token-timeout').then(function (resp) { return resp.json(); }).then(function (tok) {
      if (!tok || !tok.id_token) throw new Error('oauth/token-failed');
      var payload;
      try { payload = JSON.parse(base64UrlDecode(String(tok.id_token).split('.')[1])); }
      catch (e) { throw new Error('oauth/bad-token'); }
      var username = payload['cognito:username'] || payload.sub;
      if (!username) throw new Error('oauth/no-username');
      var cu = new C.CognitoUser({ Username: username, Pool: getUserPool() });
      var session = new C.CognitoUserSession({
        IdToken: new C.CognitoIdToken({ IdToken: tok.id_token }),
        AccessToken: new C.CognitoAccessToken({ AccessToken: tok.access_token }),
        RefreshToken: new C.CognitoRefreshToken({ RefreshToken: tok.refresh_token })
      });
      cu.setSignInUserSession(session);
      // [HISTORIAL-ACCESOS] marca el método ANTES de establecer la sesión.
      drexPendingLoginMethod = 'oauth';
      return establishSession(cu, session).then(function (user) { return { user: user }; });
    });
  }

  // Procesa el regreso del login social (?code= o ?error=)
  function handleOAuthRedirect() {
    try {
      var loc = global.location;
      if (!loc || !loc.search) return;
      var qs = String(loc.search);
      var mErr = /[?&]error(?:_description)?=([^&]*)/.exec(qs);
      var mCode = /[?&]code=([^&]+)/.exec(qs);
      if (!mErr && !mCode) return;
      // Limpiar la URL para no reprocesar
      try {
        var clean = loc.pathname + loc.hash;
        global.history.replaceState(null, '', clean);
      } catch (e) {}
      if (mErr) {
        var desc = '';
        try { desc = decodeURIComponent(/error_description=([^&]*)/.exec(qs)[1]).replace(/\+/g, ' '); } catch (e) {}
        var msg = 'No se pudo entrar con esa cuenta.';
        if (/already/i.test(desc)) msg = 'Ese correo ya tiene una cuenta en Drex. Entra con tu correo y contraseña.';
        notifyAuthError(msg);
        return;
      }
      var code = decodeURIComponent(mCode[1]);
      notifyAuthPending();
      getAuth();
      exchangeCodeForSession(code).then(function () {
        // establishSession ya notificó a los listeners
      }, function (err) {
        notifyAuthError('No se pudo completar el inicio de sesión. Intenta de nuevo.');
      });
    } catch (e) { /* sin login social pendiente */ }
  }

  var authPendingListeners = [];
  function notifyAuthPending() {
    // Avisa a la app que hay un login social en curso (puede mostrar spinner)
    try {
      if (global.document) {
        global.document.dispatchEvent(new global.CustomEvent('drex:oauth-pending'));
      }
    } catch (e) {}
  }
  function notifyAuthError(msg) {
    try {
      if (global.document) {
        global.document.dispatchEvent(new global.CustomEvent('drex:oauth-error', { detail: { message: msg } }));
      }
    } catch (e) {}
    if (typeof global.alert === 'function') { try { global.alert(msg); } catch (e) {} }
  }

  // Login social: Google y Facebook van por Cognito; otros siguen pendientes
  var SOCIAL_NAMES = { GoogleProvider: 'Google', FacebookProvider: 'Facebook', TwitterProvider: 'X (Twitter)' };
  function signInWithPopup(provider) {
    getAuth();
    var name = (provider && (provider._socialName || SOCIAL_NAMES[provider.constructor && provider.constructor.name])) || 'esta red social';
    if (SOCIAL_IDP[name]) return federatedSignIn(SOCIAL_IDP[name]);
    var msg = 'El inicio con ' + name + ' estará disponible próximamente en Drex. Usa tu correo, Google o Facebook por ahora.';
    if (typeof global.alert === 'function') { try { global.alert(msg); } catch (e) {} }
    var err = new Error(msg);
    err.code = 'auth/operation-not-allowed';
    return Promise.reject(err);
  }

  function restoreSession() {
    try {
      getAuth();
      var C = cognitoLib();
      if (!C) { setRestorePending(false); return; }
      var cu;
      try { cu = getUserPool().getCurrentUser(); } catch (e) { cu = null; }
      if (!cu) { setRestorePending(false); return; }
      var runId = ++restoreSeq;
      attemptRestore(cu, 0, runId);
    } catch (e) { setRestorePending(false); /* inicio sin sesión */ }
  }

  function attemptRestore(cu, attempt, runId) {
    if (runId !== restoreSeq) return; // un login manual o signOut tomó el control
    try {
      // FIX 2026-09-18: getSession no tenía timeout. Si la red se colgaba,
      // el callback jamás llegaba, restorePending quedaba en true y el
      // splash se quedaba visible para siempre ("app atorada en el logo").
      var _rsSettled = false;
      var _rsTimer = setTimeout(function () {
        if (_rsSettled || runId !== restoreSeq) return;
        _rsSettled = true;
        retryOrFail(cu, attempt, runId, 'network');
      }, 20000);
      cu.getSession(function (err, session) {
        if (_rsSettled) return;
        _rsSettled = true;
        clearTimeout(_rsTimer);
        if (runId !== restoreSeq) return;
        try { if (getAuth().currentUser) { setRestorePending(false); return; } } catch (e) {}
        if (!err && session && session.isValid()) {
          establishSession(cu, session).then(function () {
            setRestorePending(false);
          }, function () {
            retryOrFail(cu, attempt, runId, 'network');
          });
          return;
        }
        var msg = String((err && (err.message || '')) || '');
        var reason = (err && (err.code === 'NotAuthorizedException' || /not authorized/i.test(msg))) ? 'expired' : 'network';
        retryOrFail(cu, attempt, runId, reason);
      });
    } catch (e) {
      retryOrFail(cu, attempt, runId, 'network');
    }
  }

  function retryOrFail(cu, attempt, runId, reason) {
    if (runId !== restoreSeq) return;
    if (attempt < 1) {
      // Un reintento: la red del teléfono a veces aún no está lista al abrir la app.
      setTimeout(function () { attemptRestore(cu, attempt + 1, runId); }, 4000);
      return;
    }
    signalRestoreFailed(reason);
  }

  function signalRestoreFailed(reason) {
    setRestorePending(false);
    try { if (getAuth().currentUser) return; } catch (e) {}
    flagSessionExpired(reason);
    notifyAuthListeners();
  }

  // DrexCloud

  var databaseSingleton = null;

  // Llamadas a DrexTotpFunction (verificación del lado servidor).
  // El secreto nunca viaja al cliente: solo se envían códigos de 6 dígitos.
  function totpApi(path, body) {
    var base = (AWS_CONFIG.totpFunctionUrl || '').replace(/\/$/, '');
    if (!base) return Promise.reject(new Error('totp-not-configured'));
    // FIX 2026-09-18: timeout para no dejar la verificación 2FA colgada.
    return promiseTimeout(getAuth().getIdToken().then(function (jwt) {
      if (!jwt) throw new Error('totp-no-session');
      return fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
        body: JSON.stringify(body || {})
      }).then(function (res) {
        if (!res.ok) throw new Error('totp-http-' + res.status);
        return res.json();
      });
    }), 25000, 'totp-timeout');
  }
  function totpSetupStart() { return totpApi('/totp/setup/start', {}); }
  function totpSetupConfirm(code) { return totpApi('/totp/setup/confirm', { code: code }); }
  function totpVerify(code) { return totpApi('/totp/verify', { code: code }); }
  function totpDisable(code) { return totpApi('/totp/disable', { code: code }); }
  function totpBackupRegenerate(code) { return totpApi('/totp/backup/regenerate', { code: code }); }
  function totpConfigured() { return !!(AWS_CONFIG.totpFunctionUrl || '').trim(); }
  var totpApiNs = {
    configured: totpConfigured,
    setupStart: totpSetupStart,
    setupConfirm: totpSetupConfirm,
    verify: totpVerify,
    disable: totpDisable,
    backupRegenerate: totpBackupRegenerate
  };

  // ================================================================
  // MFA TOTP nativo de Cognito (Ing. #1 — Suite de Seguridad, 2026-09-20).
  // El User Pool tiene MFA opcional con "Authenticator apps" (TOTP).
  // Activación: associateTotp() -> QR/clave manual -> confirmTotpSetup(código)
  //   [verifySoftwareToken + setUserMfaPreference como preferido].
  // Desactivación: reauthenticate(password) para confirmar identidad y luego
  //   disableTotp().
  // El desafío SOFTWARE_TOKEN_MFA durante el login se maneja dentro de
  // signInWithEmailAndPassword (callback totpRequired del SDK) y de
  // signInWithUsernameAndPassword (paso 2 de la Lambda), ambos mediante
  // beginMfaChallenge() + la UI que expone index.html en window.__drexMfaUi.
  // NOTA SDK 6.3.15: el desafío TOTP llega por `totpRequired` (NO por
  // `mfaRequired`, que es solo para SMS). Verificado contra el dist real.
  // ================================================================
  var MFA_CODE_WINDOW_MS = 5 * 60 * 1000; // tiempo para ingresar el código TOTP

  function mapMfaError(err) {
    var code = (err && err.code) || '';
    var message = String((err && err.message) || '');
    var out = new Error(message || 'No se pudo completar la verificación.');
    if (/not authenticated/i.test(message)) {
      out.code = 'auth/session-expired';
      out.message = 'Tu sesión venció. Inicia sesión de nuevo.';
      return out;
    }
    switch (code) {
      case 'CodeMismatchException':
        out.code = 'auth/invalid-mfa-code';
        out.message = 'Código incorrecto. Revisa e inténtalo de nuevo.';
        out.retryable = true;
        break;
      case 'NotAuthorizedException':
        // Cognito no distingue "código incorrecto" de "sesión del desafío
        // vencida": mensaje genérico que cubre ambos; se puede reintentar.
        out.code = 'auth/invalid-mfa-code';
        out.message = 'Código incorrecto o vencido. Inténtalo de nuevo.';
        out.retryable = true;
        break;
      case 'ExpiredCodeException':
        out.code = 'auth/mfa-expired';
        out.message = 'El código venció. Inicia sesión de nuevo.';
        break;
      case 'LimitExceededException':
      case 'TooManyRequestsException':
        out.code = 'auth/too-many-requests';
        out.message = 'Demasiados intentos. Inténtalo de nuevo en un minuto.';
        break;
      default:
        out.code = 'auth/mfa-error';
        out.message = 'No se pudo completar la verificación. Inténtalo de nuevo.';
    }
    return out;
  }

  function mfaExpiredError() {
    return Object.assign(new Error('El código venció. Inicia sesión de nuevo.'), { code: 'auth/mfa-expired' });
  }

  function mfaCurrentCognitoUser() {
    getAuth();
    return currentCognitoUser || null;
  }

  function mfaBuildOtpauthUrl(secret) {
    var user = authInstance.currentUser;
    var label = (user && user.email) || 'Drex';
    var issuer = 'Drex';
    return 'otpauth://totp/' + encodeURIComponent(issuer + ':' + label) +
      '?secret=' + encodeURIComponent(secret) +
      '&issuer=' + encodeURIComponent(issuer) +
      '&algorithm=SHA1&digits=6&period=30';
  }

  // Paso 1 de la activación: obtiene el secreto TOTP generado por Cognito.
  function mfaAssociateTotp() {
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var cu = mfaCurrentCognitoUser();
    if (!cu) return Promise.reject(mapMfaError(new Error('User is not authenticated')));
    return new Promise(function (resolve, reject) {
      try {
        cu.associateSoftwareToken({
          onFailure: function (err) { reject(mapMfaError(err)); },
          associateSecretCode: function (secret) {
            if (!secret) { reject(mapMfaError(new Error('empty-secret'))); return; }
            // Clave manual legible en grupos de 4 para quien no puede escanear el QR.
            var manualKey = String(secret).replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
            resolve({ secret: secret, manualKey: manualKey, otpauthUrl: mfaBuildOtpauthUrl(secret) });
          }
        });
      } catch (e) { reject(mapMfaError(e)); }
    });
  }

  // Paso 2 de la activación: verifica el código y deja el TOTP como MFA preferido.
  function mfaConfirmTotpSetup(code) {
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var cu = mfaCurrentCognitoUser();
    if (!cu) return Promise.reject(mapMfaError(new Error('User is not authenticated')));
    var clean = String(code || '').trim();
    if (!/^\d{6}$/.test(clean)) {
      var bad = new Error('Escribe el código de 6 dígitos que muestra tu app.');
      bad.code = 'auth/invalid-mfa-code'; bad.retryable = true;
      return Promise.reject(bad);
    }
    var deviceName = 'Drex';
    try {
      if (typeof global.getDrexDeviceLabel === 'function') deviceName = 'Drex · ' + global.getDrexDeviceLabel();
    } catch (_) {}
    return new Promise(function (resolve, reject) {
      try {
        cu.verifySoftwareToken(clean, deviceName, {
          onFailure: function (err) { reject(mapMfaError(err)); },
          onSuccess: function () {
            try {
              cu.setUserMfaPreference(null, { Enabled: true, PreferredMfa: true }, function (err2) {
                if (err2) reject(mapMfaError(err2)); else resolve();
              });
            } catch (e) { reject(mapMfaError(e)); }
          }
        });
      } catch (e) { reject(mapMfaError(e)); }
    });
  }

  // Desactiva el MFA TOTP (llamar tras confirmar la identidad).
  function mfaDisableTotp(cognitoUser) {
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var cu = cognitoUser || mfaCurrentCognitoUser();
    if (!cu) return Promise.reject(mapMfaError(new Error('User is not authenticated')));
    return new Promise(function (resolve, reject) {
      try {
        cu.setUserMfaPreference(null, { Enabled: false, PreferredMfa: false }, function (err) {
          if (err) reject(mapMfaError(err)); else resolve();
        });
      } catch (e) { reject(mapMfaError(e)); }
    });
  }

  // Re-autentica con contraseña SIN tocar la sesión global (no llama a
  // establishSession ni notifica listeners): sirve para confirmar la identidad
  // antes de desactivar el MFA. Si Cognito pide el desafío TOTP durante la
  // re-autenticación, se usa totpCodeProvider(), que debe devolver una
  // Promise<string> con el código actual de la app de autenticación.
  // Resuelve con el CognitoUser recién autenticado (sesión fresca válida).
  function mfaReauthenticate(password, totpCodeProvider) {
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    getAuth();
    var user = authInstance.currentUser;
    var email = user && user.email;
    if (!email || String(email).indexOf('@') < 0) {
      return Promise.reject(new Error('No se pudo confirmar tu identidad. Inicia sesión con tu correo.'));
    }
    var poolUser = new C.CognitoUser({ Username: String(email), Pool: getUserPool() });
    var details = new C.AuthenticationDetails({ Username: String(email), Password: String(password || '') });
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) {
          done = true;
          reject(Object.assign(new Error('Tiempo de espera agotado. Revisa tu conexión.'), { code: 'auth/network-request-failed' }));
        }
      }, 30000);
      function clear() { try { clearTimeout(timer); } catch (_) {} }
      function ok() { if (!done) { done = true; clear(); resolve(poolUser); } }
      function fail(e) { if (!done) { done = true; clear(); reject(e); } }
      try {
        poolUser.authenticateUser(details, {
          onSuccess: function () { ok(); },
          onFailure: function (err) { fail(mapAuthError(err)); },
          totpRequired: function () {
            Promise.resolve()
              .then(function () { return totpCodeProvider(); })
              .then(function (code) {
                poolUser.sendMFACode(String(code || '').trim(), {
                  onSuccess: function () { ok(); },
                  onFailure: function (err) { fail(mapMfaError(err)); }
                }, 'SOFTWARE_TOKEN_MFA');
              }, function (e) { fail(e); });
          },
          newPasswordRequired: function () {
            fail(Object.assign(new Error('Debes restablecer tu contraseña.'), { code: 'auth/password-reset-required' }));
          }
        });
      } catch (e) { fail(mapAuthError(e)); }
    });
  }

  // Puente entre el flujo de login y la vista de desafío (#twofactor-challenge-view).
  // La UI la provee index.html como window.__drexMfaUi({kind, onCode, onCancel}).
  // onCode(code) -> Promise: resuelve al completar el desafío; rechaza con
  // un Error con .retryable=true si el código fue incorrecto (reintentable).
  function beginMfaChallenge(opts) {
    return new Promise(function (resolve, reject) {
      var ui = global.__drexMfaUi;
      if (typeof ui !== 'function') {
        reject(new Error('La verificación en dos pasos no está disponible en esta pantalla.'));
        return;
      }
      try {
        ui({
          kind: opts.kind,
          onCode: function (code) {
            return Promise.resolve()
              .then(function () { return opts.submitCode(code); })
              .then(function (r) {
                // Marca para la puerta legacy de index.html: el MFA nativo ya
                // se pasó en este inicio; no se debe volver a pedir post-sesión.
                try { global.__drexMfaPassed = true; } catch (_) {}
                resolve(r);
                return r;
              });
          },
          onCancel: function () {
            try { if (typeof opts.cancel === 'function') opts.cancel(); } catch (_) {}
            reject(Object.assign(new Error('Verificación cancelada.'), { code: 'auth/mfa-cancelled' }));
          }
        });
      } catch (e) { reject(e); }
    });
  }

  // Detecta si el TOTP está habilitado en el payload de Cognito getUserData
  // (API GetUser). OJO: MFAOptions solo describe los medios SMS
  // ({DeliveryMedium:'SMS',...}); el TOTP aparece en UserMFASettingList
  // (['SOFTWARE_TOKEN_MFA']) y en PreferredMfaSetting. Función pura (sin
  // DOM ni red) para que sea comprobable en pruebas.
  function mfaDetectTotpFromUserData(data) {
    try {
      var d = data || {};
      var list = d.UserMFASettingList || d.userMFASettingList || [];
      if (list && typeof list.some === 'function') {
        var on = list.some(function (s) {
          return String(s || '').toUpperCase().indexOf('SOFTWARE_TOKEN') === 0;
        });
        if (on) return true;
      }
      var pref = String(d.PreferredMfaSetting || d.preferredMfaSetting || '').toUpperCase();
      if (pref.indexOf('SOFTWARE_TOKEN') === 0) return true;
      var opts = d.MFAOptions || d.mfaOptions || [];
      if (opts && typeof opts.some === 'function') {
        return opts.some(function (o) {
          var m = String((o && (o.DeliveryMedium || o.deliveryMedium)) || '').toUpperCase();
          return m === 'SOFTWARE_TOKEN_MFA' || m === 'SOFTWARE_TOKEN';
        });
      }
    } catch (_) {}
    return false;
  }

  // Lee la bandera local users/<uid>/twoFactorEnabled (la app la escribe al
  // activar y la borra al desactivar). Resuelve boolean; nunca rechaza.
  function mfaReadLocalFlag() {
    return Promise.resolve().then(function () {
      var au = null;
      try { au = getAuth().currentUser; } catch (_) {}
      var uid = au && au.uid;
      if (!uid) return false;
      return new Ref(splitPath('users/' + uid + '/twoFactorEnabled')).once('value')
        .then(function (snap) { return !!(snap && typeof snap.val === 'function' && snap.val()); })
        .catch(function () { return false; });
    }).catch(function () { return false; });
  }

  // Estado del MFA para la UI (Ing. #1, 2026-09-20; corrección raíz 2026-09-20):
  // la versión anterior llamaba `currentCognitoUser()` como si fuera función,
  // pero es la VARIABLE que guarda el CognitoUser -> TypeError "not a function"
  // -> la promesa rechazaba y la vista pintaba "No se pudo cargar esta sección".
  // Ahora: pregunta a Cognito (getUserData, revisando UserMFASettingList /
  // PreferredMfaSetting, no solo MFAOptions) y usa la bandera local como
  // respaldo. GARANTÍA: nunca rechaza; si no se puede determinar, resuelve
  // {enabled:false} para no romper la vista de seguridad.
  function mfaStatus() {
    return Promise.resolve().then(function () {
      var u = mfaCurrentCognitoUser();
      var askCognito;
      if (!u || typeof u.getUserData !== 'function') {
        askCognito = Promise.resolve(null);
      } else {
        askCognito = new Promise(function (resolve) {
          var settled = false;
          function done(v) { if (!settled) { settled = true; resolve(v); } }
          var watchdog = setTimeout(function () { done(null); }, 8000);
          function clearW() { try { clearTimeout(watchdog); } catch (_) {} }
          try {
            u.getUserData(function (err, data) {
              clearW();
              if (err || !data) { done(null); return; }
              done(mfaDetectTotpFromUserData(data));
            });
          } catch (e) { clearW(); done(null); }
        });
      }
      return askCognito.then(function (cognitoOn) {
        if (cognitoOn === true) return { enabled: true };
        // Cognito no lo confirma (o no hay usuario Cognito en memoria):
        // respaldo con la bandera local que la app mantiene al activar/desactivar.
        return mfaReadLocalFlag().then(function (flag) { return { enabled: !!flag }; });
      });
    }).catch(function () { return { enabled: false }; });
  }

  var mfaNs = {
    associateTotp: mfaAssociateTotp,
    confirmTotpSetup: mfaConfirmTotpSetup,
    disableTotp: mfaDisableTotp,
    reauthenticate: mfaReauthenticate,
    beginChallenge: beginMfaChallenge,
    status: mfaStatus,
    codeWindowMs: MFA_CODE_WINDOW_MS
  };
  var SUPPORT_TABLE = 'drex-support-tickets';
  var SUPPORT_OWNER_EMAIL = 'zam.contact@yahoo.com';

  // Soporte estilo Instagram: el usuario envia su solicitud, el equipo
  // la revisa y responde; el usuario ve el estado: Recibida / En revision / Resuelta.
  function supportDoc() { return getDocClient(); }
  function supportUser() {
    var u = null;
    try { u = getAuth().currentUser; } catch (e) {}
    return u || {};
  }
  function supportNow() { return new Date().toISOString(); }
  var supportApi = {
    // Crea una solicitud de soporte; el equipo la revisa y responde.
    createTicket: function (subject, message) {
      var u = supportUser();
      if (!u.uid) return Promise.reject(new Error('auth/no-user'));
      var now = supportNow();
      var item = {
        ticketId: newPushId(),
        userId: u.uid,
        userEmail: u.email || '',
        subject: String(subject || '').slice(0, 120),
        messages: [{ from: 'user', text: String(message || '').slice(0, 4000), at: now }],
        status: 'received',
        createdAt: now,
        updatedAt: now
      };
      return supportDoc().put({ TableName: SUPPORT_TABLE, Item: item }).promise().then(function () { return item; });
    },
    // Solicitudes del usuario actual, más recientes primero.
    listMyTickets: function () {
      var u = supportUser();
      if (!u.uid) return Promise.reject(new Error('auth/no-user'));
      return supportDoc().query({
        TableName: SUPPORT_TABLE,
        IndexName: 'byUser',
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': u.uid },
        ScanIndexForward: false,
        Limit: 25
      }).promise().then(function (r) { return r.Items || []; });
    },
    // El usuario agrega un mensaje a su solicitud (la reabre como Recibida).
    replyToTicket: function (ticketId, message) {
      var u = supportUser();
      if (!u.uid) return Promise.reject(new Error('auth/no-user'));
      var now = supportNow();
      return supportDoc().update({
        TableName: SUPPORT_TABLE,
        Key: { ticketId: ticketId },
        UpdateExpression: 'SET #m = list_append(if_not_exists(#m, :empty), :nm), #s = :st, updatedAt = :now',
        ConditionExpression: 'userId = :u',
        ExpressionAttributeNames: { '#m': 'messages', '#s': 'status' },
        ExpressionAttributeValues: {
          ':empty': [],
          ':nm': [{ from: 'user', text: String(message || '').slice(0, 4000), at: now }],
          ':st': 'received',
          ':now': now,
          ':u': u.uid
        },
        ReturnValues: 'ALL_NEW'
      }).promise().then(function (r) { return r.Attributes; });
    },
    // Lado del equipo (solo el dueno ve esta seccion en la app)
    isOwner: function () {
      var u = supportUser();
      return String(u.email || '').toLowerCase() === SUPPORT_OWNER_EMAIL;
    },
    adminListTickets: function () {
      if (!this.isOwner()) return Promise.reject(new Error('auth/not-owner'));
      return supportDoc().scan({ TableName: SUPPORT_TABLE, Limit: 50 }).promise()
        .then(function (r) {
          return (r.Items || []).sort(function (a, b) {
            return String(b.updatedAt || '') < String(a.updatedAt || '') ? -1 : 1;
          });
        });
    },
    // El equipo responde: agrega mensaje from=team y marca En revision.
    adminReply: function (ticketId, message) {
      if (!this.isOwner()) return Promise.reject(new Error('auth/not-owner'));
      var now = supportNow();
      return supportDoc().update({
        TableName: SUPPORT_TABLE,
        Key: { ticketId: ticketId },
        UpdateExpression: 'SET #m = list_append(if_not_exists(#m, :empty), :nm), #s = :st, updatedAt = :now',
        ExpressionAttributeNames: { '#m': 'messages', '#s': 'status' },
        ExpressionAttributeValues: {
          ':empty': [],
          ':nm': [{ from: 'team', text: String(message || '').slice(0, 4000), at: now }],
          ':st': 'reviewing',
          ':now': now
        },
        ReturnValues: 'ALL_NEW'
      }).promise().then(function (r) { return r.Attributes; });
    },
    adminSetStatus: function (ticketId, status) {
      if (!this.isOwner()) return Promise.reject(new Error('auth/not-owner'));
      if (['received', 'reviewing', 'resolved'].indexOf(status) < 0) {
        return Promise.reject(new Error('support/bad-status'));
      }
      return supportDoc().update({
        TableName: SUPPORT_TABLE,
        Key: { ticketId: ticketId },
        UpdateExpression: 'SET #s = :st, updatedAt = :now',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':st': status, ':now': supportNow() },
        ReturnValues: 'ALL_NEW'
      }).promise().then(function (r) { return r.Attributes; });
    }
  };

  var DrexCloud = {
    database: function () {
      if (!databaseSingleton) databaseSingleton = createDatabase();
      return databaseSingleton;
    },
    auth: getAuth,
    support: supportApi,
    totp: totpApiNs,
    mfa: mfaNs,
    setFastPolling: setFastPolling,
    _outbox: Outbox // interno: cola offline (esqueleto: solo 'set')
  };
  // ServerValue también directo sobre DrexCloud.database (sin llamar),
  // porque el código migrado usa DrexCloud.database.ServerValue.TIMESTAMP
  DrexCloud.database.ServerValue = DrexCloud.database().ServerValue;

  // Clases de proveedor para `new DrexCloud.auth.GoogleProvider()` etc.
  function makeProvider(socialName) {
    var P = function () { this._socialName = socialName; };
    return P;
  }
  DrexCloud.auth.GoogleProvider = makeProvider('Google');
  DrexCloud.auth.FacebookProvider = makeProvider('Facebook');
  DrexCloud.auth.TwitterProvider = makeProvider('X (Twitter)');

  // La app lo usa para no mostrar el login mientras la sesión se restaura.
  DrexCloud.authRestorePending = function () { return restorePending; };

  global.DrexCloud = DrexCloud;

  // API de fiabilidad (módulo 2026-09-21): disyuntores, probe de
  // salud, colector de errores y contadores silenciosos.
  DrexCloud.reliability = RelPublicApi;

  // [DISPOSITIVOS] acceso interno (navegador): la app lo usa para marcar
  // "Este dispositivo" en el Centro de seguridad y para pruebas manuales.
  // Prefijo _ = interno, no parte de la API pública.
  DrexCloud._drexDevices = {
    fingerprintString: drexDeviceFingerprintString,
    hashDeviceString: drexHashDeviceString,
    friendlyLabel: drexDeviceFriendlyLabel,
    checkNewDevice: checkDrexNewDevice
  };
  // [DISPOSITIVOS] fin
  // [SESIONES] inicio — Sesiones activas (Ingeniero #5, 2026-09-20).
  //
  // Registro de sesiones por dispositivo en pk='users', sk='<uid>/sessions/<session_id>'
  // con v=JSON {id, deviceLabel, form, os, browser, ip, createdAt, lastActivity,
  // current, revoked, endedAt}.
  //
  // - Se ejecuta en cada establishSession (login explícito o restauración), fire-and-forget
  //   total: cualquier fallo se ignora en silencio y jamás bloquea ni rompe el login.
  // - El session_id se genera con crypto.getRandomValues y persiste en localStorage por uid:
  //   el mismo dispositivo/navegador reutiliza su registro entre aperturas (sin duplicados).
  // - Etiqueta de dispositivo "iPhone · Safari" (mismo formato que el Ing. #4;
  //   parser propio porque el baseline limpio no incluye su módulo).
  // - Al registrar, las demás sesiones del usuario pasan a current:false.
  // - Heartbeat: lastActivity se actualiza cada 5 min con la app visible y al volver
  //   a primer plano (throttle: mínimo 60 s entre escrituras).
  // - Limpieza perezosa: al listar, se borran las sesiones con lastActivity > 30 días.
  //
  // DECISIÓN DE REVOCACIÓN (documentada):
  // Cognito no permite revocar los tokens de OTRO dispositivo desde el cliente:
  // GlobalSignOut/AdminUserGlobalSignOut exigen credenciales admin (IAM) y en este
  // proyecto no hay ninguna Lambda admin para sesiones (la única Lambda es
  // drex-username-resolve, de login). user.globalSignOut() solo afecta a la sesión local.
  // Por eso "Cerrar" / "Cerrar todas las demás" marcan revoked:true en DynamoDB y el
  // dispositivo afectado lo detecta de dos formas: (1) oyente en tiempo real sobre su
  // propio registro -> signOut inmediato (segundos, si tiene la app abierta); (2) al
  // restaurar sesión se lee el registro ANTES de re-registrar: si está revocado se hace
  // signOut local (se borran los tokens) y la app vuelve a pedir login. Efecto real:
  // el otro dispositivo debe iniciar sesión de nuevo. Los tokens Cognito del otro
  // dispositivo siguen siendo técnicamente válidos hasta expirar, pero la app ya no los
  // acepta para restaurar sesión. Punto de extensión futuro: DrexCloud.revokeOtherDrexSessions().
  //
  // Cierre de la sesión PROPIA: además de marcar el registro, se intenta revocar el
  // refresh token en Cognito (revokeToken), best-effort.
  //
  // Privacidad: el navegador no conoce su IP publica sin un backend o un servicio
  // externo, y no se envia la IP del usuario a terceros (sin ipify ni similares):
  // el registro guarda ip:null. Si a futuro el servidor aporta un prefijo ya
  // truncado (p. ej. "187.200.•.•"), se persiste con drexSessionsTruncateIp().
  var DREX_SESSIONS_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
  var DREX_SESSIONS_HEARTBEAT_MS = 5 * 60 * 1000;
  var DREX_SESSIONS_TOUCH_MIN_MS = 60 * 1000;
  var drexSessionState = {
    uid: null, sessionId: null, lastTouch: 0, revokedNoticed: false,
    heartbeatTimer: null, detachWatch: null, visibilityHook: false
  };

  function drexSessionsStorageKey(uid) { return 'drex_session_id_' + uid; }

  function drexSessionsNewId() {
    var hex = '', i;
    try {
      var bytes = new Uint8Array(16);
      var c = (typeof global !== 'undefined' && global.crypto) || null;
      if (c && typeof c.getRandomValues === 'function') {
        c.getRandomValues(bytes);
        for (i = 0; i < bytes.length; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
        return 's_' + hex;
      }
    } catch (_) {}
    // Respaldo sin crypto: nunca debe fallar la generación del id.
    hex = Date.now().toString(36);
    for (i = 0; i < 4; i++) hex += Math.random().toString(36).slice(2, 8);
    return 's_' + hex;
  }

  function drexSessionsLoadId(uid) {
    try {
      if (typeof localStorage === 'undefined') return null;
      var v = localStorage.getItem(drexSessionsStorageKey(uid));
      return (v && /^[A-Za-z0-9_:-]{4,80}$/.test(v)) ? v : null;
    } catch (_) { return null; }
  }
  function drexSessionsSaveId(uid, sid) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(drexSessionsStorageKey(uid), sid); } catch (_) {}
  }
  function drexSessionsForgetId(uid) {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(drexSessionsStorageKey(uid)); } catch (_) {}
  }

  function drexSessionsTruncateIp(ip) {
    ip = String(ip || '').trim();
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return ip.split('.').slice(0, 2).join('.') + '.•.•';
    if (ip.indexOf(':') !== -1) {
      var parts = ip.split(':').filter(function (p) { return p !== ''; });
      if (parts.length >= 4) return parts.slice(0, 4).join(':') + '::•';
    }
    return null;
  }
  // Acceso directo a DynamoDB con UN item por sesion:
  // pk='users', sk='<uid>/sessions/<session_id>', v=JSON del registro completo.
  // (Ref.set/update/transaction aplanan en varias hojas; aqui se exige un item.)
  function drexSessionsItemKey(uid, sid) { return { pk: 'users', sk: String(uid) + '/sessions/' + String(sid) }; }
  function drexSessionsGetRecord(uid, sid) {
    var dc = null;
    try { dc = getDocClient(); } catch (_) { return Promise.resolve(null); }
    if (!dc) return Promise.resolve(null);
    return withCredRetry(function () {
      return dbTimeout(dc.get({ TableName: AWS_CONFIG.tableName, Key: drexSessionsItemKey(uid, sid) }).promise(), 'ses-get');
    }).then(function (res) {
      try {
        if (res && res.Item && typeof res.Item.v === 'string') {
          var rec = JSON.parse(res.Item.v);
          return (rec && typeof rec === 'object') ? rec : null;
        }
      } catch (_) {}
      return null;
    }).catch(function () { return null; });
  }
  function drexSessionsPutRecord(uid, sid, record) {
    var dc = null;
    try { dc = getDocClient(); } catch (_) { return Promise.resolve(false); }
    if (!dc) return Promise.resolve(false);
    var key = drexSessionsItemKey(uid, sid);
    var params = { TableName: AWS_CONFIG.tableName, Item: { pk: key.pk, sk: key.sk, v: JSON.stringify(record) } };
    return withCredRetry(function () {
      return dbTimeout(dc.put(params).promise(), 'ses-put');
    }).then(function () { return true; }).catch(function () { return false; });
  }
  function drexSessionsDeleteRecord(uid, sid) {
    var dc = null;
    try { dc = getDocClient(); } catch (_) { return Promise.resolve(false); }
    if (!dc) return Promise.resolve(false);
    return withCredRetry(function () {
      return dbTimeout(dc.delete({ TableName: AWS_CONFIG.tableName, Key: drexSessionsItemKey(uid, sid) }).promise(), 'ses-del');
    }).then(function () { return true; }).catch(function () { return false; });
  }
  // Lista solo claves de profundidad exacta <uid>/sessions/<id> (ignora subrutas).
  function drexSessionsQueryRecords(uid) {
    var dc = null;
    try { dc = getDocClient(); } catch (_) { return Promise.resolve([]); }
    if (!dc) return Promise.resolve([]);
    var pfx = String(uid) + '/sessions/';
    var params = {
      TableName: AWS_CONFIG.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :pfx)',
      ExpressionAttributeValues: { ':pk': 'users', ':pfx': pfx }
    };
    return withCredRetry(function () {
      return dbTimeout(dc.query(params).promise(), 'ses-query');
    }).then(function (res) {
      var out = [];
      ((res && res.Items) || []).forEach(function (it) {
        try {
          if (!it || typeof it.sk !== 'string') return;
          if (it.sk.slice(0, pfx.length) !== pfx) return;
          var rest = it.sk.slice(pfx.length);
          if (!rest || rest.indexOf('/') !== -1) return;
          var rec = (typeof it.v === 'string') ? JSON.parse(it.v) : null;
          if (rec && typeof rec === 'object') out.push({ id: rest, record: rec });
        } catch (_) {}
      });
      return out;
    }).catch(function () { return []; });
  }

  // Parseo de user agent AUTOCONTENIDO. Etiqueta "iPhone · Safari": mismo formato
  // que el Ing. #4 para que las etiquetas coincidan al integrar ramas.
  function drexSessionsParseUA(ua) {
    ua = String(ua || '');
    var browser = 'Navegador', os = '', form = 'desktop';
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) form = 'mobile';
    if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/Windows NT/i.test(ua)) os = 'Windows';
    else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';
    else if (/CrOS/i.test(ua)) os = 'ChromeOS';
    if (/Edg\/|EdgA|EdgiOS/i.test(ua)) browser = 'Edge';
    else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
    else if (/SamsungBrowser/i.test(ua)) browser = 'Samsung Internet';
    else if (/FxiOS/i.test(ua)) browser = 'Firefox';
    else if (/Firefox/i.test(ua)) browser = 'Firefox';
    else if (/CriOS/i.test(ua)) browser = 'Chrome';
    else if (/Chrome/i.test(ua)) browser = 'Chrome';
    else if (/Safari/i.test(ua)) browser = 'Safari';
    var device;
    if (form === 'mobile') {
      if (/iPhone/i.test(ua)) device = 'iPhone';
      else if (/iPad/i.test(ua)) device = 'iPad';
      else if (/Android/i.test(ua)) device = 'Android';
      else device = 'Móvil';
    } else {
      device = os || 'Computadora';
    }
    return { label: device + ' · ' + browser, form: form, os: os, browser: browser };
  }

  function drexSessionsRegister(user) {
    try {
      var uid = (user && user.uid) ? String(user.uid) : '';
      if (!uid) return;
      if (drexSessionState.uid === uid && drexSessionState.sessionId) {
        drexSessionsTouch(false); // re-establish en la misma página: solo latido
        return;
      }
      var sid = drexSessionsLoadId(uid);
      if (!sid) { sid = drexSessionsNewId(); drexSessionsSaveId(uid, sid); }
      drexSessionState.uid = uid;
      drexSessionState.sessionId = sid;
      drexSessionState.revokedNoticed = false;
      var ref = DrexCloud.database().ref('users/' + uid + '/sessions/' + sid);
      var mySid = sid, myUid = uid;
      drexSessionsGetRecord(myUid, mySid).then(function (existing) {
        try {
          // El usuario pudo cerrar sesión mientras se leía: no actuar con estado viejo.
          if (drexSessionState.sessionId !== mySid || drexSessionState.uid !== myUid) return;
          if (existing && existing.revoked === true) {
            // Esta sesión fue cerrada desde otro dispositivo: salir sin re-registrar.
            drexSessionsHandleRemoteRevoke();
            return;
          }
          drexSessionsUpsert(myUid, mySid, ref, existing);
        } catch (_) {}
      }).catch(function () { /* sin red: la sesión local sigue válida */ });
    } catch (_) { /* nunca bloquear el login */ }
  }

  function drexSessionsUpsert(uid, sid, ref, existing) {
    try {
      var now = Date.now();
      var ua = '';
      try { ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''; } catch (_) {}
      // Etiqueta "iPhone · Safari" (parser propio, mismo formato que el Ing. #4).
      var info = drexSessionsParseUA(ua);
      var record = {
        id: sid,
        deviceLabel: info.label,
        form: info.form,       // 'mobile' | 'desktop' (icono en la UI)
        os: info.os,           // 'iOS' | 'Android' | 'Windows' | ...
        browser: info.browser, // 'Chrome' | 'Safari' | ...
        // Privacidad: el navegador no conoce su IP publica sin un servicio externo;
        // no se envia a terceros. Queda null hasta que el servidor aporte un prefijo
        // ya truncado (ver drexSessionsTruncateIp).
        ip: null,
        createdAt: (existing && existing.createdAt) || now,
        lastActivity: now,
        current: true,
        revoked: false
      };
      var myUid2 = uid, mySid2 = sid, myRef = ref, myExisting = existing, myNow = now, myRecord = record, myInfo = info;
      // Lectura + escritura de UN item: si otro dispositivo la revoco entre la
      // lectura y la escritura, se aborta en vez de "resucitar" la sesion.
      drexSessionsGetRecord(myUid2, mySid2).then(function (cur) {
        try {
          if (drexSessionState.sessionId !== mySid2 || drexSessionState.uid !== myUid2) return;
          if (cur && cur.revoked === true) { drexSessionsHandleRemoteRevoke(); return; }
          var merged = (cur && typeof cur === 'object') ? cur : {};
          Object.keys(myRecord).forEach(function (k) { merged[k] = myRecord[k]; });
          if (!merged.createdAt) merged.createdAt = myNow;
          var wasNew = !myExisting;
          drexSessionsPutRecord(myUid2, mySid2, merged).then(function () {
            try {
              drexSessionState.lastTouch = myNow;
              drexSessionsMarkOthersNotCurrent(myUid2, mySid2);
              drexSessionsWatchRevocation(myRef, mySid2);
              drexSessionsStartHeartbeat();
              drexSessionsHookVisibility();
          // Aviso a la UI (index.html registra el evento de seguridad si es nueva).
          try {
            if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') {
              var ev = null;
              try { ev = new CustomEvent('drex:session-registered', { detail: { isNew: wasNew, deviceLabel: myInfo.label } }); }
              catch (_) {
                try {
                  ev = document.createEvent('CustomEvent');
                  ev.initCustomEvent('drex:session-registered', false, false, { isNew: wasNew, deviceLabel: myInfo.label });
                } catch (_) { ev = null; }
              }
              if (ev) document.dispatchEvent(ev);
            }
          } catch (_) {}
            } catch (_) {}
          }).catch(function () {});
        } catch (_) {}
      }).catch(function () {});
    } catch (_) {}
  }

  function drexSessionsMarkOthersNotCurrent(uid, sid) {
    try {
      drexSessionsQueryRecords(uid).then(function (rows) {
        try {
          rows.forEach(function (row) {
            try {
              var s = row.record;
              if (row.id !== sid && s && s.revoked !== true && s.current !== false) {
                s.current = false;
                drexSessionsPutRecord(uid, row.id, s);
              }
            } catch (_) {}
          });
        } catch (_) {}
      });
    } catch (_) {}
  }

  function drexSessionsWatchRevocation(ref, sid) {
    try {
      if (drexSessionState.detachWatch) {
        try { drexSessionState.detachWatch(); } catch (_) {}
        drexSessionState.detachWatch = null;
      }
      var detach = ref.on('value', function (snap) {
        try {
          var s = snap.val();
          if (s && s.revoked === true && drexSessionState.sessionId === sid) {
            drexSessionsHandleRemoteRevoke();
          }
        } catch (_) {}
      });
      drexSessionState.detachWatch = (typeof detach === 'function') ? detach : null;
    } catch (_) {}
  }

  function drexSessionsHandleRemoteRevoke() {
    try {
      if (drexSessionState.revokedNoticed) return;
      drexSessionState.revokedNoticed = true;
      drexSessionsTeardown(true); // olvida el id: no debe re-registrarse
      try {
        if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('drex_session_revoked_notice', '1');
      } catch (_) {}
      try { DrexCloud.auth().signOut(); } catch (_) {}
    } catch (_) {}
  }

  function drexSessionsTeardown(forgetId) {
    try {
      if (drexSessionState.heartbeatTimer) { clearInterval(drexSessionState.heartbeatTimer); drexSessionState.heartbeatTimer = null; }
      if (drexSessionState.detachWatch) { try { drexSessionState.detachWatch(); } catch (_) {} drexSessionState.detachWatch = null; }
      if (drexSessionState.visibilityHook && typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        try { document.removeEventListener('visibilitychange', drexSessionsOnVisibility); } catch (_) {}
        drexSessionState.visibilityHook = false;
      }
      if (forgetId && drexSessionState.uid) drexSessionsForgetId(drexSessionState.uid);
    } catch (_) {}
    drexSessionState.uid = null;
    drexSessionState.sessionId = null;
    drexSessionState.lastTouch = 0;
    drexSessionState.revokedNoticed = false;
  }

  // Cierre de la sesión PROPIA (llamado desde signOutUser, antes de borrar tokens):
  // 1) intenta revocar el refresh token en Cognito; 2) marca el registro como
  // terminado; 3) olvida el id local para que el próximo login genere uno nuevo.
  function drexSessionsOnLocalSignOut() {
    try {
      var uid = drexSessionState.uid, sid = drexSessionState.sessionId;
      try {
        var cu = (typeof currentCognitoUser !== 'undefined') ? currentCognitoUser : null;
        var rt = null;
        try {
          var sess = (cu && typeof cu.getSignInUserSession === 'function') ? cu.getSignInUserSession() : null;
          rt = (sess && typeof sess.getRefreshToken === 'function' && sess.getRefreshToken()) ? sess.getRefreshToken().getToken() : null;
        } catch (_) { rt = null; }
        if (cu && rt && typeof cu.revokeToken === 'function') {
          try { cu.revokeToken(rt, function () {}); } catch (_) {}
        }
      } catch (_) {}
      try {
        if (uid && sid) {
          var oUid = uid, oSid = sid, oStamp = Date.now();
          drexSessionsGetRecord(oUid, oSid).then(function (cur) {
            try {
              var rec = (cur && typeof cur === 'object') ? cur : { id: oSid };
              rec.revoked = true;
              rec.endedAt = oStamp;
              rec.current = false;
              drexSessionsPutRecord(oUid, oSid, rec);
            } catch (_) {}
          });
        }
      } catch (_) {}
      drexSessionsTeardown(true);
    } catch (_) {}
  }

  function drexSessionsTouch(force) {
    try {
      var st = drexSessionState;
      if (!st.uid || !st.sessionId || st.revokedNoticed) return;
      var now = Date.now();
      if (!force && (now - st.lastTouch) < DREX_SESSIONS_TOUCH_MIN_MS) return;
      st.lastTouch = now;
      var tUid = st.uid, tSid = st.sessionId;
      drexSessionsGetRecord(tUid, tSid).then(function (cur) {
        try {
          if (!cur || cur.revoked === true) return;
          if (drexSessionState.sessionId !== tSid) return;
          cur.lastActivity = now;
          drexSessionsPutRecord(tUid, tSid, cur);
        } catch (_) {}
      });
    } catch (_) {}
  }

  function drexSessionsStartHeartbeat() {
    try {
      if (drexSessionState.heartbeatTimer) clearInterval(drexSessionState.heartbeatTimer);
      drexSessionState.heartbeatTimer = setInterval(function () {
        try {
          var hidden = false;
          try { hidden = (typeof document !== 'undefined' && !!document.hidden); } catch (_) {}
          if (!hidden) drexSessionsTouch(false);
        } catch (_) {}
      }, DREX_SESSIONS_HEARTBEAT_MS);
    } catch (_) {}
  }

  function drexSessionsOnVisibility() {
    try {
      var hidden = false;
      try { hidden = (typeof document !== 'undefined' && !!document.hidden); } catch (_) {}
      if (!hidden) drexSessionsTouch(false);
    } catch (_) {}
  }
  function drexSessionsHookVisibility() {
    try {
      if (drexSessionState.visibilityHook) return;
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', drexSessionsOnVisibility);
        drexSessionState.visibilityHook = true;
      }
    } catch (_) {}
  }

  // --- API pública para la UI (Centro de seguridad) ---
  DrexCloud.getActiveDrexSessionId = function () {
    try {
      if (drexSessionState.sessionId) return drexSessionState.sessionId;
      var u = null;
      try { u = DrexCloud.auth().currentUser; } catch (_) {}
      if (u && u.uid) return drexSessionsLoadId(String(u.uid));
    } catch (_) {}
    return null;
  };

  // Lista las sesiones no revocadas, ordenadas por actividad (con limpieza
  // perezosa de las que llevan >30 días sin actividad).
  DrexCloud.listDrexSessions = function () {
    var user = null;
    try { user = DrexCloud.auth().currentUser; } catch (_) {}
    if (!user || !user.uid) return Promise.resolve([]);
    var uid = String(user.uid);
    var now = Date.now();
    var mySid = null;
    try { mySid = drexSessionState.sessionId; } catch (_) {}
    return drexSessionsQueryRecords(uid).then(function (rows) {
      var stale = [];
      rows.forEach(function (row) {
        var s = row.record;
        if (s && s.revoked !== true && row.id !== mySid &&
            typeof s.lastActivity === 'number' && (now - s.lastActivity) > DREX_SESSIONS_MAX_AGE_MS) {
          stale.push(row.id);
        }
      });
      stale.forEach(function (id) { try { drexSessionsDeleteRecord(uid, id); } catch (_) {} });
      return rows.filter(function (row) {
        return row.record && row.record.revoked !== true && stale.indexOf(row.id) === -1;
      }).map(function (row) {
        var r = row.record;
        if (!r.id) r.id = row.id;
        return r;
      }).sort(function (a, b) { return (b.lastActivity || 0) - (a.lastActivity || 0); });
    });
  };

  // Cierra UNA sesión ajena (la marca revocada; su dispositivo sale al detectar el cambio).
  DrexCloud.revokeDrexSession = function (sessionId) {
    var user = null;
    try { user = DrexCloud.auth().currentUser; } catch (_) {}
    if (!user || !user.uid || !sessionId) return Promise.reject(new Error('Sin sesión'));
    var me = null;
    try { me = DrexCloud.getActiveDrexSessionId(); } catch (_) {}
    if (String(sessionId) === String(me)) return Promise.reject(new Error('No puedes cerrar tu sesión actual desde aquí'));
    var rUid = String(user.uid), rSid = String(sessionId), rStamp = Date.now();
    return drexSessionsGetRecord(rUid, rSid).then(function (cur) {
      var rec = (cur && typeof cur === 'object') ? cur : { id: rSid };
      rec.revoked = true;
      rec.endedAt = rStamp;
      rec.current = false;
      return drexSessionsPutRecord(rUid, rSid, rec);
    });
  };

  // Cierra TODAS las demás sesiones. Punto de extensión: si a futuro existe una
  // Lambda admin, aquí se llamaría a AdminUserGlobalSignOut por usuario.
  DrexCloud.revokeOtherDrexSessions = function () {
    var user = null;
    try { user = DrexCloud.auth().currentUser; } catch (_) {}
    if (!user || !user.uid) return Promise.reject(new Error('Sin sesión'));
    var uid = String(user.uid);
    var me = null;
    try { me = DrexCloud.getActiveDrexSessionId(); } catch (_) {}
    var stamp = Date.now();
    return drexSessionsQueryRecords(uid).then(function (rows) {
      var jobs = [];
      rows.forEach(function (row) {
        var s = row.record;
        if (String(row.id) !== String(me) && s && s.revoked !== true) {
          s.revoked = true;
          s.endedAt = stamp;
          s.current = false;
          jobs.push(drexSessionsPutRecord(uid, row.id, s));
        }
      });
      return Promise.all(jobs).then(function () {
        // Compatibilidad: dispositivos con versiones viejas escuchan este comando.
        try {
          return DrexCloud.database().ref('security/' + uid + '/revokeOtherSessions')
            .set({ timestamp: stamp, exceptSessionId: me }).catch(function () {});
        } catch (_) { return null; }
      });
    });
  };

  // Actividad en acciones clave (la UI puede llamarlo tras acciones importantes).
  DrexCloud.touchDrexSessionActivity = function () { drexSessionsTouch(true); };
  // [SESIONES] fin

  // Solo en navegador: procesar regreso del login social y restaurar sesión
  if (typeof global.window !== 'undefined' && typeof global.document !== 'undefined') {
    if (global.document.readyState === 'complete' || global.document.readyState === 'interactive') {
      setTimeout(function () { handleOAuthRedirect(); restoreSession(); }, 0);
    } else {
      global.document.addEventListener('DOMContentLoaded', function () { setTimeout(function () { handleOAuthRedirect(); restoreSession(); }, 0); });
    }
  }

  // exportaciones solo para pruebas en node
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      DrexCloud: DrexCloud,
      __internals: {
        normalizePath: normalizePath,
        splitPath: splitPath,
        flatten: flatten,
        unflatten: unflatten,
        applyQuery: applyQuery,
        newPushId: newPushId,
        // [ONDELTA-OVERLAP] internos para pruebas en node (fix 2026-09-23)
        pushIdTime: pushIdTime,
        pushIdUpperBound: pushIdUpperBound,
        pushIdLowerBound: pushIdLowerBound,
        deltaFromSk: deltaFromSk,
        // [PERF-BOUNDED-PREFIX] lectura acotada bajo prefijo (2026-09-23)
        readLeavesBoundedPrefix: readLeavesBoundedPrefix,
        // [PERF-H3] invalidación del caché de fase 2 (2026-09-23)
        invalidateBoundedPrefixCache: invalidateBoundedPrefixCache,
        readLeaves: readLeaves,
        DELTA_OVERLAP_MS: DELTA_OVERLAP_MS,
        mapAuthError: mapAuthError,
        DataSnapshot: DataSnapshot,
        Ref: Ref,
        TIMESTAMP_SENTINEL: TIMESTAMP_SENTINEL,
        AWS_CONFIG: AWS_CONFIG,
        // [SEGURIDAD-2FA] detector TOTP puro (sin red) para pruebas (fix 2026-09-20)
        mfaDetectTotp: mfaDetectTotpFromUserData,
        // [DISPOSITIVOS] internos para pruebas en node
        drexDevices: {
          summarizeUA: drexSummarizeDeviceUA,
          friendlyLabel: drexDeviceFriendlyLabel,
          shortUA: drexShortUA,
          fingerprintString: drexDeviceFingerprintString,
          hashDeviceString: drexHashDeviceString,
          cyrb53: drexCyrb53,
          tzCity: drexTzCity,
          checkNewDevice: checkDrexNewDevice
        },
        // [DISPOSITIVOS] fin
        setDocClient: function (dc) { _docClient = dc; },
        setAwsCredentials: function (c) { _awsCredentials = c; },
        // [HISTORIAL-ACCESOS] exportaciones solo para pruebas (Ing. #3)
        recordLoginHistory: recordLoginHistory,
        setPendingLoginMethod: function (m) { drexPendingLoginMethod = m; },
        getPendingLoginMethod: function () { return drexPendingLoginMethod; },
        resetListeners: function () {
          for (var i = listeners.length - 1; i >= 0; i--) {
            if (listeners[i]._deb) clearTimeout(listeners[i]._deb);
          }
          listeners.length = 0;
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        },
        listenerCount: function () { return listeners.length; },
        // [SESIONES] Ing. #5: superficie de pruebas del registro de sesiones.
        drexSessions: {
          register: drexSessionsRegister,
          touch: function (force) { drexSessionsTouch(!!force); },
          onLocalSignOut: drexSessionsOnLocalSignOut,
          handleRemoteRevoke: drexSessionsHandleRemoteRevoke,
          teardown: function (forgetId) { drexSessionsTeardown(!!forgetId); },
          newId: drexSessionsNewId,
          truncateIp: drexSessionsTruncateIp,
          parseUA: drexSessionsParseUA,
          getRecord: drexSessionsGetRecord,
          putRecord: drexSessionsPutRecord,
          deleteRecord: drexSessionsDeleteRecord,
          queryRecords: drexSessionsQueryRecords,
          itemKey: drexSessionsItemKey,
          state: drexSessionState
        }
      }
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
