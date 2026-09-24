/* ================================================================
 * C158 — Correcciones: AVISO DEL PRIMER «ÚTIL» AL CORRECTOR.
 *
 * HALLAZGO (hueco real, verificado contra el código):
 *  - SE CALCULA: toggleCorrectionHelpful (transacción sobre
 *    exerciseCorrections/<exId>/<corrId>/helpfulCount, +1/-1 por usuario;
 *    índice correctionHelpful/<exId>/<corrId>/<uid>).
 *  - SE PINTA: la tarjeta de corrección muestra «Útil N»
 *    (data-helpful-count) y las correcciones se ordenan por helpfulCount.
 *  - SILENCIO: el único addNotification de correcciones avisa al AUTOR
 *    DEL EJERCICIO de la corrección nueva; el CORRECTOR jamás se entera
 *    de que su corrección le sirvió a alguien. Ningún call site cubre el
 *    «útil» (grep: cero addNotification cerca de útil/helpful).
 *
 * CAMBIO (index.html):
 *  - correctionHelpfulNotifyDecision(adding, correctorId, voterUid):
 *    núcleo PURO. Solo anuncia al AGREGAR, con corrector conocido y
 *    distinto del votante.
 *  - correctionHelpfulText(voterName): texto del aviso, español fijo
 *    (C147/C153/C157).
 *  - correctionHelpfulNotifyFlag(cur, nowMs): updater PURO de la
 *    transacción exactamente-una-vez. Vive en el nodo paralelo
 *    correctionHelpfulNotified/<exId>/<corrId>: NO toca el shape de la
 *    transacción caliente (lección C149).
 *  - maybeAnnounceCorrectionHelpful(exId, corrId, correctorId, voterUid):
 *    detección client-side oportunista (patrón C153/C154/C157). Sin
 *    auto-aviso: si el votante es el corrector no se marca el flag
 *    (precedente C154). El ganador relee correctorId del servidor (como
 *    C157 relee authorId) y dispara addNotification con tipo 'info' para
 *    heredar el toggle 'corrections' del destinatario (notifTypeToPrefKey),
 *    el mismo bucket que el aviso de nueva corrección. Guarda de sesión
 *    por exId/corrId.
 *  - toggleCorrectionHelpful: tras confirmar la transacción del conteo,
 *    invoca al anunciador con guarda typeof (los harnesses viejos lo
 *    ejecutan en sandbox sin él; patrón C153).
 *
 * Ejecutar con: node tests/test-c158-correccion-util.js
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let failures = 0;
function tcase(name, fn) {
  try {
    const ok = fn();
    if (ok && typeof ok.then === 'function') {
      return ok.then(function (v) {
        console.log((v ? 'ok - ' : 'NOT OK - ') + name);
        if (!v) failures++;
      }).catch(function (e) {
        console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
        failures++;
      });
    }
    console.log((ok ? 'ok - ' : 'NOT OK - ') + name);
    if (!ok) failures++;
  } catch (e) {
    console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
    failures++;
  }
}
function extractFn(source, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(source);
  if (!m) throw new Error('no se encontró ' + name);
  let i = source.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(m.index, j + 1); }
  }
  throw new Error('llaves sin balance en ' + name);
}
function extractC158Block() {
  const start = html.indexOf('// ============ C158:');
  const endMark = '// ============ /C158 ============';
  const ei = html.indexOf(endMark);
  if (start === -1 || ei === -1 || ei < start) throw new Error('bloque C158 ausente en index.html');
  return html.slice(start, ei + endMark.length);
}

// ---------- Parte A: estáticos (FALLAN sin el parche) ----------
tcase('A1 existen las 4 funciones C158 + guarda de sesión', () => {
  return html.indexOf('function correctionHelpfulNotifyDecision(adding, correctorId, voterUid)') !== -1
    && html.indexOf('function correctionHelpfulText(voterName)') !== -1
    && html.indexOf('function correctionHelpfulNotifyFlag(cur, nowMs)') !== -1
    && html.indexOf('function maybeAnnounceCorrectionHelpful(exId, corrId, correctorId, voterUid)') !== -1
    && html.indexOf('var _c158HelpfulTried = {};') !== -1;
});
tcase('A2 hook en toggleCorrectionHelpful tras confirmar el conteo (guarda typeof + decisión)', () => {
  const fn = extractFn(html, 'toggleCorrectionHelpful');
  return fn.indexOf("typeof maybeAnnounceCorrectionHelpful === 'function'") !== -1
    && fn.indexOf('correctionHelpfulNotifyDecision(true, corr && corr.correctorId, me.uid)') !== -1
    && fn.indexOf('maybeAnnounceCorrectionHelpful(exId, corrId, corr.correctorId, me.uid)') !== -1
    && fn.indexOf('if (adding &&') !== -1;
});
tcase('A3 transacción caliente del conteo intacta (updater ±1 sin lógica de aviso)', () => {
  const fn = extractFn(html, 'toggleCorrectionHelpful');
  return fn.indexOf('Math.max(0, (c || 0) + (adding ? 1 : -1))') !== -1
    && fn.indexOf('correctionHelpfulNotified') === -1; // el flag vive fuera del conteo
});
tcase('A4 el aviso usa tipo info + meta exerciseId (hereda toggle corrections)', () => {
  const fn = extractFn(html, 'maybeAnnounceCorrectionHelpful');
  return fn.indexOf("addNotification(freshId, correctionHelpfulText(voterName), 'info', { exerciseId: exId })") !== -1;
});
tcase('A5 la transacción corre sobre correctionHelpfulNotified/<ex>/<co> (nodo paralelo)', () => {
  const fn = extractFn(html, 'maybeAnnounceCorrectionHelpful');
  return fn.indexOf("DrexCloud.database().ref('correctionHelpfulNotified/' + exId + '/' + corrId).transaction(function (cur)") !== -1
    && fn.indexOf('return correctionHelpfulNotifyFlag(cur, Date.now());') !== -1
    && fn.indexOf("ref('exerciseCorrections/'") !== -1 // solo lectura de correctorId
    && fn.indexOf('.set(') === -1 && fn.indexOf('.update(') === -1; // nunca escribe en exerciseCorrections
});
tcase('A6 guarda de sesión: una sola tentativa por exId/corrId (_c158HelpfulTried)', () => {
  const fn = extractFn(html, 'maybeAnnounceCorrectionHelpful');
  return fn.indexOf("var gk = exId + '/' + corrId;") !== -1
    && fn.indexOf('if (_c158HelpfulTried[gk]) return;') !== -1
    && fn.indexOf('_c158HelpfulTried[gk] = true;') !== -1;
});
tcase('A7 sin auto-aviso: votante == corrector no marca el flag (C154)', () => {
  const fn = extractFn(html, 'maybeAnnounceCorrectionHelpful');
  return fn.indexOf('if (!correctorId || correctorId === voterUid) return;') !== -1
    && fn.indexOf('if (!freshId || freshId === voterUid) return;') !== -1;
});
tcase('A8 mensaje en español fijo (sin claves i18n nuevas que romper)', () => {
  const fn = extractFn(html, 'correctionHelpfulText');
  return fn.indexOf('le pareció útil tu corrección') !== -1 && fn.indexOf('appT(') === -1;
});
tcase('A9 best-effort: el anunciador va envuelto en try/catch', () => {
  const fn = extractFn(html, 'maybeAnnounceCorrectionHelpful');
  return fn.trim().startsWith('function maybeAnnounceCorrectionHelpful(exId, corrId, correctorId, voterUid) {\n  try {')
    && fn.indexOf('.catch(function () {});') !== -1;
});

// ---------- Parte B: núcleo puro (sandbox con el bloque real) ----------
function pureBox() {
  const sb = {};
  vm.createContext(sb);
  sb.setTimeout = setTimeout;
  sb.clearTimeout = clearTimeout;
  const mocks = [
    'var DrexCloud = { database: function(){ return { ref: function(){ throw new Error("sin BD en test puro"); } }; } };',
    'function addNotification(){ return Promise.resolve(); }',
    'async function practicarCurrentProfile(){ return { uid: "v", name: "Alguien", img: "" }; }'
  ].join('\n');
  vm.runInContext(mocks, sb);
  vm.runInContext(extractC158Block(), sb);
  return sb;
}
tcase('B1 updater: sin flag -> marca timestamp; con flag -> undefined (no-op)', () => {
  const sb = pureBox();
  const u = (cur, now) => vm.runInContext('correctionHelpfulNotifyFlag(' + JSON.stringify(cur) + ', ' + now + ')', sb);
  return u(null, 1700000000000) === 1700000000000
    && u(undefined, 1700000000000) === 1700000000000
    && u(1699999999999, 1700000000000) === undefined
    && u(0, 1700000000000) === undefined;
});
tcase('B2 texto del aviso en español con el nombre del votante', () => {
  const sb = pureBox();
  return vm.runInContext("correctionHelpfulText('María')", sb) === 'A María le pareció útil tu corrección.'
    && vm.runInContext("correctionHelpfulText('')", sb) === 'A Alguien le pareció útil tu corrección.'
    && vm.runInContext('correctionHelpfulText(null)', sb) === 'A Alguien le pareció útil tu corrección.';
});
tcase('B3 decisión: solo agregar + corrector conocido + distinto del votante', () => {
  const sb = pureBox();
  const d = (a, c, v) => vm.runInContext(
    'correctionHelpfulNotifyDecision(' + JSON.stringify(a) + ', ' + JSON.stringify(c) + ', ' + JSON.stringify(v) + ')', sb);
  return d(true, 'c1', 'v1') === true
    && d(true, 'c1', 'c1') === false   // auto-«útil»: no avisa
    && d(false, 'c1', 'v1') === false  // quitar el «útil»: no avisa
    && d(true, '', 'v1') === false
    && d(true, null, 'v1') === false
    && d(true, undefined, 'v1') === false;
});

// ---------- Parte C: maybeAnnounceCorrectionHelpful (conductual, mocks) ----------
function triggerBox(opts) {
  // opts: {voterUid, correctorId(server), txnCommitted:null|bool, voterName}
  const counters = { txn: 0, correctorRead: 0, notifs: [] };
  const sb = {};
  vm.createContext(sb);
  const mocks = [
    'var DrexCloud = {',
    '  database: function(){ return { ref: function(path){ return __ref(path); } }; }',
    '};',
    'function __ref(path){',
    '  var m = /^correctionHelpfulNotified\\/(.+)\\/(.+)$/.exec(path);',
    '  if (m) return {',
    '    transaction: function(updater, onComplete){',
    '      __counters.txn++;',
    '      var cur = (__flagStore.map[path] === undefined) ? null : __flagStore.map[path];',
    '      var res = updater(cur);',
    '      var committed = (typeof __txnCommitted === "boolean") ? __txnCommitted : (res !== undefined);',
    '      if (committed && res !== undefined) __flagStore.map[path] = res;',
    '      onComplete(null, committed, { val: function(){ return committed ? res : cur; } });',
    '    }',
    '  };',
    '  if (/^exerciseCorrections\\/.+\\/correctorId$/.test(path)) return {',
    '    once: function(){ __counters.correctorRead++; return Promise.resolve({ val: function(){ return __correctorId; } }); }',
    '  };',
    '  throw new Error("ruta inesperada: " + path);',
    '}',
    'async function practicarCurrentProfile(){ return { uid: __voterUid, name: __voterName, img: "" }; }',
    'function addNotification(userId, message, type, meta){',
    '  __counters.notifs.push({ userId: userId, message: message, type: type, meta: meta });',
    '  return Promise.resolve();',
    '}'
  ].join('\n');
  sb.__counters = counters;
  sb.__flagStore = { map: {} };
  if (opts.flagValue !== undefined) sb.__flagStore.map['correctionHelpfulNotified/e1/c1'] = opts.flagValue;
  sb.__correctorId = opts.correctorId;
  sb.__voterUid = opts.voterUid;
  sb.__voterName = opts.voterName || 'Ana';
  sb.__txnCommitted = (opts.txnCommitted === undefined ? null : opts.txnCommitted);
  sb.setTimeout = setTimeout;
  sb.clearTimeout = clearTimeout;
  vm.runInContext(mocks, sb);
  vm.runInContext(extractC158Block(), sb);
  return { sb: sb, counters: counters };
}
function fire(trigger, exId, corrId, correctorId, voterUid) {
  vm.runInContext(
    'maybeAnnounceCorrectionHelpful(' + JSON.stringify(exId) + ', ' + JSON.stringify(corrId) + ', '
    + JSON.stringify(correctorId) + ', ' + JSON.stringify(voterUid) + ')',
    trigger.sb);
  return new Promise(function (res) { setTimeout(res, 40); });
}
tcase('C1 «útil» de tercero -> transacción, flag marcado y aviso info al corrector', () => {
  const tr = triggerBox({ voterUid: 'v1', correctorId: 'c9', voterName: 'Ana' });
  return fire(tr, 'e1', 'c1', 'c9', 'v1').then(function () {
    const n = tr.counters.notifs[0];
    return tr.counters.txn === 1 && tr.counters.notifs.length === 1
      && n.userId === 'c9' && n.type === 'info'
      && n.meta && n.meta.exerciseId === 'e1'
      && n.message === 'A Ana le pareció útil tu corrección.'
      && tr.sb.__flagStore.map['correctionHelpfulNotified/e1/c1'] > 0;
  });
});
tcase('C2 flag ya marcado en servidor -> updater no-op, sin aviso ni relectura', () => {
  const tr = triggerBox({ voterUid: 'v1', correctorId: 'c9', flagValue: 1699999999999 });
  return fire(tr, 'e1', 'c1', 'c9', 'v1').then(function () {
    return tr.counters.txn === 1 && tr.counters.notifs.length === 0 && tr.counters.correctorRead === 0;
  });
});
tcase('C3 el corrector marca «útil» en su propia corrección -> sin transacción (no se quema el flag)', () => {
  const tr = triggerBox({ voterUid: 'c9', correctorId: 'c9' });
  return fire(tr, 'e1', 'c1', 'c9', 'c9').then(function () {
    return tr.counters.txn === 0 && tr.counters.notifs.length === 0
      && Object.keys(tr.sb.__flagStore.map).length === 0;
  });
});
tcase('C4 carrera perdida (commit false) -> sin aviso', () => {
  const tr = triggerBox({ voterUid: 'v1', correctorId: 'c9', txnCommitted: false });
  return fire(tr, 'e1', 'c1', 'c9', 'v1').then(function () {
    return tr.counters.txn === 1 && tr.counters.notifs.length === 0 && tr.counters.correctorRead === 0;
  });
});
tcase('C5 segunda llamada en la sesión no reintenta la transacción', () => {
  const tr = triggerBox({ voterUid: 'v1', correctorId: 'c9' });
  return fire(tr, 'e1', 'c1', 'c9', 'v1').then(function () {
    return fire(tr, 'e1', 'c1', 'c9', 'v1').then(function () {
      return tr.counters.txn === 1 && tr.counters.notifs.length === 1;
    });
  });
});
tcase('C6 correctorId stale en local: manda el del servidor', () => {
  const tr = triggerBox({ voterUid: 'v1', correctorId: 'cFresh' });
  return fire(tr, 'e1', 'c1', 'cStale', 'v1').then(function () {
    const n = tr.counters.notifs[0];
    return tr.counters.notifs.length === 1 && n.userId === 'cFresh';
  });
});
tcase('C7 el servidor dice que el votante es el corrector -> sin aviso', () => {
  const tr = triggerBox({ voterUid: 'v1', correctorId: 'v1' });
  return fire(tr, 'e1', 'c1', 'cOtro', 'v1').then(function () {
    return tr.counters.txn === 1 && tr.counters.notifs.length === 0;
  });
});
tcase('C8 sin exId -> nada (sin transacción)', () => {
  const tr = triggerBox({ voterUid: 'v1', correctorId: 'c9' });
  return fire(tr, '', 'c1', 'c9', 'v1').then(function () {
    return tr.counters.txn === 0 && tr.counters.notifs.length === 0;
  });
});

setTimeout(function () {
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
}, 900);
