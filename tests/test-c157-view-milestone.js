/* ================================================================
 * C157 — Vistas: AVISO DE HITO AL AUTOR (función nueva construida).
 *
 * HALLAZGO (hueco real, verificado contra el código): viewCount se
 * CONTABA (drexViewCoreCountUpdate, transacción sobre
 * communityNotes/<id>/viewCount, 1 vista por usuario por post) y se
 * PINTABA (drexViewsOwnBadgeForNote en la tarjeta del autor + panel
 * Pulso), pero el autor nunca se enteraba cuando su post cruzaba un hito
 * de vistas (100 / 1000 / 10000 / 100000). Nadie avisaba: ni el tracker
 * ni el panel ni la tarjeta.
 *
 * CAMBIO (index.html):
 *  - DREX_VIEW_MILESTONES = [100, 1000, 10000, 100000].
 *  - drexViewMilestoneForCount(count): núcleo PURO. Devuelve el hito si
 *    el conteo NUEVO lo cruzó EXACTAMENTE, o 0. Igualdad exacta: el
 *    contador sube de 1 en 1 por transacción serializada, así que el
 *    cruce siempre cae en el número exacto (sin falsos anuncios por
 *    saltos grandes de migraciones).
 *  - viewMilestoneText(milestone): texto del aviso, español fijo (C147/C153).
 *  - viewMilestoneNotifyFlag(cur, nowMs): updater PURO de la transacción
 *    exactamente-una-vez. Si el hito ya se anunció (cur truthy), no-op;
 *    si no, marca el timestamp. Vive en el nodo paralelo
 *    viewMilestoneNotified/<noteId>/m<hito>: NO toca el shape de la
 *    transacción caliente (lección C149; drexViewCoreCountUpdate intacto).
 *  - maybeAnnounceViewMilestone(noteId, newCount, viewerUid): detección
 *    client-side oportunista (sin AWS), patrón C153/C154. Solo el autor
 *    (sin auto-aviso: las vistas del propio autor sí cuentan). Tipo
 *    'vote' para heredar el toggle 'likes' del destinatario (mismo bucket
 *    que votos/ecos: interacción con tu contenido, notifTypeToPrefKey).
 *    Guarda de sesión por noteId+hito.
 *  - drexViewRecord: tras confirmar el conteo nuevo
 *    (vres.snapshot.val()), invoca al anunciador con guarda typeof
 *    (los harnesses viejos ejecutan drexViewRecord en sandbox sin él).
 *
 * Ejecutar con: node tests/test-c157-view-milestone.js
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
function extractC157Block() {
  const start = html.indexOf('// ============ C157: HITO DE VISTAS');
  const endMark = '// ============ /C157 ============';
  const ei = html.indexOf(endMark);
  if (start === -1 || ei === -1 || ei < start) throw new Error('bloque C157 ausente en index.html');
  return html.slice(start, ei + endMark.length);
}

// ---------- Parte A: estáticos (FALLAN sin el parche) ----------
tcase('A1 existen DREX_VIEW_MILESTONES + 4 funciones C157', () => {
  return html.indexOf('var DREX_VIEW_MILESTONES = [100, 1000, 10000, 100000];') !== -1
    && html.indexOf('function drexViewMilestoneForCount(count)') !== -1
    && html.indexOf('function viewMilestoneText(milestone)') !== -1
    && html.indexOf('function viewMilestoneNotifyFlag(cur, nowMs)') !== -1
    && html.indexOf('function maybeAnnounceViewMilestone(noteId, newCount, viewerUid)') !== -1;
});
tcase('A2 hook en drexViewRecord tras confirmar el conteo (guarda typeof)', () => {
  const fn = extractFn(html, 'drexViewRecord');
  return fn.indexOf('maybeAnnounceViewMilestone(id, Number(vres.snapshot.val()) || 0, uid)') !== -1
    && fn.indexOf("typeof maybeAnnounceViewMilestone === 'function'") !== -1;
});
tcase('A3 drexViewCoreCountUpdate intacto (sin lógica de hitos en la transacción caliente)', () => {
  const fn = extractFn(html, 'drexViewCoreCountUpdate');
  return fn.indexOf('Milestone') === -1 && fn.indexOf('milestone') === -1
    && fn.indexOf('return (Number(cur) || 0) + 1;') !== -1;
});
tcase('A4 el aviso usa tipo vote + meta actionType/actionId (hereda toggle likes)', () => {
  const fn = extractFn(html, 'maybeAnnounceViewMilestone');
  return fn.indexOf("addNotification(authorId, viewMilestoneText(milestone), 'vote', { actionType: 'post', actionId: noteId })") !== -1;
});
tcase('A5 la transacción corre sobre viewMilestoneNotified/<id>/m<hito> (nodo paralelo)', () => {
  const fn = extractFn(html, 'maybeAnnounceViewMilestone');
  return fn.indexOf("DrexCloud.database().ref('viewMilestoneNotified/' + noteId + '/m' + milestone).transaction(function (cur)") !== -1
    && fn.indexOf('return viewMilestoneNotifyFlag(cur, Date.now());') !== -1
    && fn.indexOf('communityNotes/') === fn.lastIndexOf('communityNotes/'); // solo la lectura de authorId
});
tcase('A6 guarda de sesión: una sola tentativa por noteId+hito (_c157ViewMilestoneTried)', () => {
  const fn = extractFn(html, 'maybeAnnounceViewMilestone');
  return html.indexOf('var _c157ViewMilestoneTried = {};') !== -1
    && fn.indexOf("var gk = noteId + ':m' + milestone;") !== -1
    && fn.indexOf('if (_c157ViewMilestoneTried[gk]) return;') !== -1
    && fn.indexOf('_c157ViewMilestoneTried[gk] = true;') !== -1;
});
tcase('A7 sin auto-aviso: el autor que cruza el hito con su propia vista no se notifica', () => {
  const fn = extractFn(html, 'maybeAnnounceViewMilestone');
  return fn.indexOf('if (!authorId || authorId === viewerUid) return;') !== -1;
});
tcase('A8 mensaje en español fijo (sin claves i18n nuevas que romper)', () => {
  const fn = extractFn(html, 'viewMilestoneText');
  return fn.indexOf('Tu publicación llegó a') !== -1 && fn.indexOf('appT(') === -1;
});
tcase('A9 best-effort: todo el trigger va envuelto en try/catch', () => {
  const fn = extractFn(html, 'maybeAnnounceViewMilestone');
  return fn.trim().startsWith('function maybeAnnounceViewMilestone(noteId, newCount, viewerUid) {\n    try {')
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
    'function addNotification(){ return Promise.resolve(); }'
  ].join('\n');
  vm.runInContext(mocks, sb);
  vm.runInContext(extractC157Block(), sb);
  return sb;
}
tcase('B1 hitos exactos: 100/1000/10000/100000 -> hito; 99/101/999/1001/0/null -> 0', () => {
  const sb = pureBox();
  const f = c => vm.runInContext('drexViewMilestoneForCount(' + JSON.stringify(c) + ')', sb);
  return f(100) === 100 && f(1000) === 1000 && f(10000) === 10000 && f(100000) === 100000
    && f(99) === 0 && f(101) === 0 && f(999) === 0 && f(1001) === 0
    && f(0) === 0 && f(null) === 0 && f('1000') === 1000 && f(1000000) === 0;
});
tcase('B2 texto del aviso en español con el hito', () => {
  const sb = pureBox();
  const t = vm.runInContext('viewMilestoneText(1000)', sb);
  return t === 'Tu publicación llegó a 1000 vistas.'
    && vm.runInContext('viewMilestoneText(100)', sb) === 'Tu publicación llegó a 100 vistas.';
});
tcase('B3 updater: sin flag -> marca timestamp; con flag -> undefined (no-op)', () => {
  const sb = pureBox();
  const u = (cur, now) => vm.runInContext('viewMilestoneNotifyFlag(' + JSON.stringify(cur) + ', ' + now + ')', sb);
  return u(null, 1700000000000) === 1700000000000
    && u(undefined, 1700000000000) === 1700000000000
    && u(1699999999999, 1700000000000) === undefined
    && u(0, 1700000000000) === undefined;
});

// ---------- Parte C: maybeAnnounceViewMilestone (conductual, mocks) ----------
function triggerBox(opts) {
  // opts: {viewerUid, flagValue, authorId, txnCommitted:null|bool}
  const counters = { txn: 0, authorRead: 0, notifs: [] };
  const sb = {};
  vm.createContext(sb);
  const mocks = [
    'var DrexCloud = {',
    '  database: function(){ return { ref: function(path){ return __ref(path); } }; }',
    '};',
    'function __ref(path){',
    '  var m = /^viewMilestoneNotified\\/(.+)\\/m(\\d+)$/.exec(path);',
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
    '  if (path === "communityNotes/n1/authorId") return {',
    '    once: function(){ __counters.authorRead++; return Promise.resolve({ val: function(){ return __authorId; } }); }',
    '  };',
    '  throw new Error("ruta inesperada: " + path);',
    '}',
    'function addNotification(userId, message, type, meta){',
    '  __counters.notifs.push({ userId: userId, message: message, type: type, meta: meta });',
    '  return Promise.resolve();',
    '}'
  ].join('\n');
  sb.__counters = counters;
  sb.__flagStore = { map: {} };
  if (opts.flagValue !== undefined && opts.flagPath) sb.__flagStore.map[opts.flagPath] = opts.flagValue;
  sb.__authorId = opts.authorId;
  sb.__txnCommitted = (opts.txnCommitted === undefined ? null : opts.txnCommitted);
  sb.setTimeout = setTimeout;
  sb.clearTimeout = clearTimeout;
  vm.runInContext(mocks, sb);
  vm.runInContext(extractC157Block(), sb);
  return { sb: sb, counters: counters };
}
function fire(trigger, noteId, newCount, viewerUid) {
  vm.runInContext(
    'maybeAnnounceViewMilestone(' + JSON.stringify(noteId) + ', ' + JSON.stringify(newCount) + ', ' + JSON.stringify(viewerUid) + ')',
    trigger.sb);
  return new Promise(function (res) { setTimeout(res, 30); });
}
tcase('C1 conteo 1000 + autor ajeno -> transacción, flag marcado y aviso vote al autor', () => {
  const tr = triggerBox({ viewerUid: 'viewer1', authorId: 'author9' });
  return fire(tr, 'n1', 1000, 'viewer1').then(function () {
    const n = tr.counters.notifs[0];
    return tr.counters.txn === 1 && tr.counters.notifs.length === 1
      && n.userId === 'author9' && n.type === 'vote'
      && n.meta && n.meta.actionType === 'post' && n.meta.actionId === 'n1'
      && n.message === 'Tu publicación llegó a 1000 vistas.'
      && Object.keys(tr.sb.__flagStore.map).length > 0 && tr.sb.__flagStore.map[Object.keys(tr.sb.__flagStore.map)[0]] > 0;
  });
});
tcase('C2 conteo 999 (no hito) -> sin transacción ni aviso', () => {
  const tr = triggerBox({ viewerUid: 'viewer1', authorId: 'author9' });
  return fire(tr, 'n1', 999, 'viewer1').then(function () {
    return tr.counters.txn === 0 && tr.counters.notifs.length === 0;
  });
});
tcase('C3 hito ya anunciado en servidor -> updater no-op, sin aviso', () => {
  const tr = triggerBox({ viewerUid: 'viewer1', authorId: 'author9', flagValue: 1699999999999, flagPath: 'viewMilestoneNotified/n1/m1000' });
  return fire(tr, 'n1', 1000, 'viewer1').then(function () {
    return tr.counters.txn === 1 && tr.counters.notifs.length === 0 && tr.counters.authorRead === 0;
  });
});
tcase('C4 el autor cruza el hito con su propia vista: marca el flag pero no se auto-avisa', () => {
  const tr = triggerBox({ viewerUid: 'author9', authorId: 'author9' });
  return fire(tr, 'n1', 100, 'author9').then(function () {
    return tr.counters.txn === 1 && tr.counters.notifs.length === 0
      && Object.keys(tr.sb.__flagStore.map).length > 0 && tr.sb.__flagStore.map[Object.keys(tr.sb.__flagStore.map)[0]] > 0;
  });
});
tcase('C5 carrera perdida (commit false) -> sin aviso y sin lectura de autor', () => {
  const tr = triggerBox({ viewerUid: 'viewer1', authorId: 'author9', txnCommitted: false });
  return fire(tr, 'n1', 10000, 'viewer1').then(function () {
    return tr.counters.txn === 1 && tr.counters.notifs.length === 0 && tr.counters.authorRead === 0;
  });
});
tcase('C6 segunda llamada en la sesión no reintenta la transacción', () => {
  const tr = triggerBox({ viewerUid: 'viewer1', authorId: 'author9' });
  return fire(tr, 'n1', 100, 'viewer1').then(function () {
    return fire(tr, 'n1', 100, 'viewer1').then(function () {
      return tr.counters.txn === 1 && tr.counters.notifs.length === 1;
    });
  });
});
tcase('C7 hitos distintos tienen flag y aviso independientes', () => {
  const tr = triggerBox({ viewerUid: 'viewer1', authorId: 'author9' });
  return fire(tr, 'n1', 100, 'viewer1').then(function () {
    return fire(tr, 'n1', 1000, 'viewer1').then(function () {
      return tr.counters.txn === 2 && tr.counters.notifs.length === 2
        && tr.counters.notifs[1].message === 'Tu publicación llegó a 1000 vistas.';
    });
  });
});
tcase('C8 sin noteId -> nada (sin transacción)', () => {
  const tr = triggerBox({ viewerUid: 'viewer1', authorId: 'author9' });
  return fire(tr, '', 1000, 'viewer1').then(function () {
    return tr.counters.txn === 0 && tr.counters.notifs.length === 0;
  });
});

setTimeout(function () {
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
}, 800);
