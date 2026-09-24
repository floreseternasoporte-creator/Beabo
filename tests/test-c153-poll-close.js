/* ================================================================
 * C153 — Votaciones: AVISO DE CIERRE AL AUTOR (función nueva construida).
 *
 * HALLAZGO (hueco real, re-verificado contra el código): cuando una votación
 * cerraba (Date.now() > endsAt), la tarjeta solo pintaba "Votación cerrada"
 * y nadie se enteraba del resultado final: el autor no recibía ningún aviso
 * (C147 solo avisa del PRIMER voto) y tenía que reabrir el post para ver el
 * desenlace. Para Series Drex (v1, "la audiencia vota el guion") el autor
 * NECESITA el resultado para escribir el capítulo siguiente: el cierre era
 * silencioso.
 *
 * CAMBIO (index.html):
 *  - pollCloseAnnounce(poll, nowMs): updater PURO de la transacción. Si la
 *    encuesta ya cerró y nadie la anunció, marca poll.closeAnnounced = nowMs
 *    (exactamente un cliente gana la carrera). No-op (undefined): poll null,
 *    sin endsAt, aún abierta o ya anunciada. No toca options/total/voters.
 *  - pollCloseResultText(poll): texto del aviso con el resultado final
 *    (ganador = más votos, primero en empate; "No recibió votos." si total
 *    es 0). Puro.
 *  - maybeAnnouncePollClose(noteId, poll): detección client-side oportunista
 *    (sin AWS), invocada desde renderPostPollHTML (único renderer: cubre
 *    feed, permalink, búsqueda e Historial). Transacción best-effort sobre
 *    communityNotes/<id>/poll; el ganador lee authorId y dispara
 *    addNotification(..., 'vote', {actionType:'post', actionId}) — tipo
 *    'vote' para heredar el toggle 'likes' del destinatario (C147). Solo el
 *    autor (sin auto-aviso); una tentativa por noteId y sesión.
 *  - renderPostPollHTML: hook con guarda typeof (los harnesses viejos como
 *    test-c143 ejecutan la función en sandbox sin el anunciador).
 *
 * Ejecutar con: node tests/test-c153-poll-close.js
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
const NOW = Date.now(); // base real: el sandbox usa Date.now() nativo
function mkPoll(over) {
  return Object.assign({
    options: [{ t: 'Pizza', v: 6 }, { t: 'Pasta', v: 4 }, { t: 'Sushi', v: 0 }],
    endsAt: NOW + 3600000, total: 10, voters: { u1: 0, u2: 1 }
  }, over || {});
}
function closedPoll(over) { return mkPoll(Object.assign({ endsAt: NOW - 1000 }, over || {})); }

// ---------- Parte A: estáticos ----------
tcase('A1 existen pollCloseAnnounce, pollCloseResultText y maybeAnnouncePollClose', () => {
  return html.indexOf('function pollCloseAnnounce(poll, nowMs)') !== -1
    && html.indexOf('function pollCloseResultText(poll)') !== -1
    && html.indexOf('function maybeAnnouncePollClose(noteId, poll)') !== -1;
});
tcase('A2 el hook vive en renderPostPollHTML con guarda typeof (sandbox viejos)', () => {
  const fn = extractFn(html, 'renderPostPollHTML');
  return fn.indexOf("typeof maybeAnnouncePollClose === 'function'") !== -1
    && fn.indexOf('maybeAnnouncePollClose(note && note.id, poll)') !== -1;
});
tcase('A3 maybeAnnouncePollClose es top-level (fuera de voteInPoll/renderPostPollHTML)', () => {
  const v = extractFn(html, 'voteInPoll');
  const r = extractFn(html, 'renderPostPollHTML');
  return v.indexOf('function maybeAnnouncePollClose') === -1
    && r.indexOf('function maybeAnnouncePollClose') === -1
    && r.indexOf('_c153PollCloseTried') === -1;
});
tcase('A4 el aviso usa tipo vote + meta actionType/actionId (hereda toggle likes)', () => {
  const fn = extractFn(html, 'maybeAnnouncePollClose');
  return fn.indexOf("addNotification(authorId, msg, 'vote', { actionType: 'post', actionId: noteId })") !== -1;
});
tcase('A5 la transacción corre sobre communityNotes/<id>/poll (mismo path que el voto)', () => {
  const fn = extractFn(html, 'maybeAnnouncePollClose');
  return fn.indexOf("DrexCloud.database().ref('communityNotes/' + noteId + '/poll').transaction(function(p)") !== -1
    && fn.indexOf('return pollCloseAnnounce(p, Date.now());') !== -1;
});
tcase('A6 pollApplyVote no toca closeAnnounced (shape de la transacción caliente intacto)', () => {
  return extractFn(html, 'pollApplyVote').indexOf('closeAnnounced') === -1;
});
tcase('A7 guarda de sesión: una sola tentativa por noteId (_c153PollCloseTried)', () => {
  const fn = extractFn(html, 'maybeAnnouncePollClose');
  return html.indexOf('var _c153PollCloseTried = {};') !== -1
    && fn.indexOf('if (_c153PollCloseTried[noteId]) return;') !== -1
    && fn.indexOf('_c153PollCloseTried[noteId] = true;') !== -1;
});
tcase('A8 sin auto-aviso: el autor que la está viendo no se notifica a sí mismo', () => {
  const fn = extractFn(html, 'maybeAnnouncePollClose');
  return fn.indexOf('if (!authorId || authorId === user.uid) return;') !== -1;
});
tcase('A9 best-effort: todo el trigger va envuelto en try/catch', () => {
  const fn = extractFn(html, 'maybeAnnouncePollClose');
  return fn.trim().startsWith('function maybeAnnouncePollClose(noteId, poll) {\n    try {')
    && fn.indexOf('.catch(function() {});') !== -1;
});
tcase('A10 mensaje en español fijo como C147 (sin claves i18n nuevas que romper)', () => {
  const fn = extractFn(html, 'pollCloseResultText');
  return fn.indexOf('Tu encuesta') !== -1 && fn.indexOf('appT(') === -1;
});

// ---------- Parte B: pollCloseAnnounce (puro) ----------
function pureBox() {
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(extractFn(html, 'pollCloseAnnounce'), sb);
  return sb;
}
function announce(pollObj, nowMs) {
  const sb = pureBox();
  vm.runInContext('this.__p = ' + JSON.stringify(pollObj) + ';', sb);
  return vm.runInContext('pollCloseAnnounce(this.__p, ' + nowMs + ')', sb);
}
tcase('B1 null / sin endsAt / abierta -> undefined y sin mutar', () => {
  const p1 = mkPoll({ endsAt: 0 });
  const p2 = mkPoll();
  return announce(null, NOW) === undefined
    && announce(p1, NOW) === undefined && p1.closeAnnounced === undefined
    && announce(p2, NOW) === undefined && p2.closeAnnounced === undefined;
});
tcase('B2 cerrada sin anunciar -> marca closeAnnounced = nowMs', () => {
  const p = closedPoll();
  const r = announce(p, NOW);
  return r !== undefined && r.closeAnnounced === NOW;
});
tcase('B3 ya anunciada -> undefined (no re-anuncia, no pisa el timestamp)', () => {
  const p = closedPoll({ closeAnnounced: NOW - 5000 });
  const r = announce(p, NOW);
  return r === undefined && p.closeAnnounced === NOW - 5000;
});
tcase('B4 borde nowMs === endsAt -> aún abierta (undefined)', () => {
  const p = mkPoll({ endsAt: NOW });
  return announce(p, NOW) === undefined;
});
tcase('B5 no toca options/total/voters al anunciar', () => {
  const p = closedPoll();
  const before = JSON.stringify({ o: p.options, t: p.total, v: p.voters });
  announce(p, NOW);
  return JSON.stringify({ o: p.options, t: p.total, v: p.voters }) === before;
});

// ---------- Parte C: pollCloseResultText (puro) ----------
function textBox() {
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(extractFn(html, 'pollCloseResultText'), sb);
  return sb;
}
function resultText(pollObj) {
  const sb = textBox();
  vm.runInContext('this.__p = ' + JSON.stringify(pollObj) + ';', sb);
  return vm.runInContext('pollCloseResultText(this.__p)', sb);
}
tcase('C1 cerrada con votos: nombra al ganador con % y total', () => {
  const t = resultText(closedPoll());
  return t.indexOf('Ganó «Pizza»') !== -1 && t.indexOf('60%') !== -1 && t.indexOf('(10 votos)') !== -1;
});
tcase('C2 con pregunta q: la cita en el encabezado', () => {
  const t = resultText(closedPoll({ q: '¿Qué cenamos?' }));
  return t.indexOf('Tu encuesta «¿Qué cenamos?» cerró.') === 0 && t.indexOf('Ganó «Pizza»') !== -1;
});
tcase('C3 sin pregunta: encabezado genérico', () => {
  const t = resultText(closedPoll());
  return t.indexOf('Tu encuesta cerró.') === 0;
});
tcase('C4 sin votos: mensaje sin ganador', () => {
  const p = closedPoll();
  p.options.forEach(function (o) { o.v = 0; });
  p.total = 0;
  const t = resultText(p);
  return t.indexOf('No recibió votos.') !== -1 && t.indexOf('Ganó') === -1;
});
tcase('C5 empate: gana la primera opción', () => {
  const p = closedPoll({ options: [{ t: 'A', v: 5 }, { t: 'B', v: 5 }], total: 10 });
  return resultText(p).indexOf('Ganó «A»') !== -1;
});
tcase('C6 un solo voto: singular "voto"', () => {
  const p = closedPoll({ options: [{ t: 'Solo', v: 1 }], total: 1 });
  const t = resultText(p);
  return t.indexOf('(1 voto)') !== -1 && t.indexOf('(1 votos)') === -1;
});
tcase('C7 opción sin título: cae a "Opción N"', () => {
  const p = closedPoll({ options: [{ v: 3 }, { t: 'B', v: 1 }], total: 4 });
  return resultText(p).indexOf('Ganó «Opción 1»') !== -1;
});
tcase('C8 null-safe: poll null no revienta', () => {
  const sb = textBox();
  const t = vm.runInContext('pollCloseResultText(null)', sb);
  return typeof t === 'string' && t.indexOf('No recibió votos.') !== -1;
});

// ---------- Parte D: maybeAnnouncePollClose (conductual, mocks) ----------
function triggerBox(opts) {
  // opts: {uid, serverPoll, authorId, txnCommitted:null|bool}
  const counters = { txn: 0, authorRead: 0, notifs: [] };
  const sb = {};
  vm.createContext(sb);
  const mocks = [
    'var _c153PollCloseTried = {};',
    'var DrexCloud = {',
    '  auth: function(){ return { currentUser: ' + (opts.uid ? '{ uid: ' + JSON.stringify(opts.uid) + ' }' : 'null') + ' }; },',
    '  database: function(){ return { ref: function(path){ return __ref(path); } }; }',
    '};',
    'function __ref(path){',
    '  if (path === "communityNotes/n1/poll") return {',
    '    transaction: function(updater, onComplete){',
    '      __counters.txn++;',
    '      var res = updater(JSON.parse(JSON.stringify(__serverPoll)));',
    '      var committed = (typeof __txnCommitted === "boolean") ? __txnCommitted : (res !== undefined);',
    '      if (committed && res !== undefined) __serverPoll = res;',
    '      onComplete(null, committed, { val: function(){ return committed ? res : __serverPoll; } });',
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
  sb.__serverPoll = JSON.parse(JSON.stringify(opts.serverPoll));
  sb.__authorId = opts.authorId;
  sb.__txnCommitted = (opts.txnCommitted === undefined ? null : opts.txnCommitted);
  sb.setTimeout = setTimeout;
  sb.clearTimeout = clearTimeout;
  vm.runInContext(mocks, sb);
  vm.runInContext(extractFn(html, 'pollCloseAnnounce'), sb);
  vm.runInContext(extractFn(html, 'pollCloseResultText'), sb);
  vm.runInContext(extractFn(html, 'maybeAnnouncePollClose'), sb);
  return { sb: sb, counters: counters };
}
function fire(trigger, noteId, pollObj) {
  const sb = trigger.sb;
  vm.runInContext('this.__p = ' + JSON.stringify(pollObj) + ';', sb);
  vm.runInContext('maybeAnnouncePollClose(' + JSON.stringify(noteId) + ', this.__p)', sb);
  return new Promise(function (res) { setTimeout(res, 30); });
}
tcase('D1 cerrada sin anunciar + autor ajeno -> transacción y aviso con resultado', () => {
  const tr = triggerBox({ uid: 'viewer1', serverPoll: closedPoll(), authorId: 'author9' });
  return fire(tr, 'n1', closedPoll()).then(function () {
    const n = tr.counters.notifs[0];
    return tr.counters.txn === 1 && tr.counters.notifs.length === 1
      && n.userId === 'author9' && n.type === 'vote'
      && n.meta && n.meta.actionType === 'post' && n.meta.actionId === 'n1'
      && n.message.indexOf('Ganó «Pizza»') !== -1
      && tr.sb.__serverPoll.closeAnnounced !== undefined;
  });
});
tcase('D2 ya anunciada en servidor -> sin transacción útil y sin aviso', () => {
  const tr = triggerBox({ uid: 'viewer1', serverPoll: closedPoll({ closeAnnounced: NOW - 9 }), authorId: 'author9' });
  return fire(tr, 'n1', closedPoll({ closeAnnounced: NOW - 9 })).then(function () {
    return tr.counters.txn === 0 && tr.counters.notifs.length === 0;
  });
});
tcase('D3 aún abierta -> sin transacción', () => {
  const tr = triggerBox({ uid: 'viewer1', serverPoll: mkPoll(), authorId: 'author9' });
  return fire(tr, 'n1', mkPoll()).then(function () {
    return tr.counters.txn === 0 && tr.counters.notifs.length === 0;
  });
});
tcase('D4 sin sesión -> sin transacción', () => {
  const tr = triggerBox({ uid: null, serverPoll: closedPoll(), authorId: 'author9' });
  return fire(tr, 'n1', closedPoll()).then(function () {
    return tr.counters.txn === 0;
  });
});
tcase('D5 el autor viéndola marca el flag pero no se auto-avisa', () => {
  const tr = triggerBox({ uid: 'author9', serverPoll: closedPoll(), authorId: 'author9' });
  return fire(tr, 'n1', closedPoll()).then(function () {
    return tr.counters.txn === 1 && tr.counters.notifs.length === 0
      && tr.sb.__serverPoll.closeAnnounced !== undefined;
  });
});
tcase('D6 carrera perdida (commit false) -> sin aviso', () => {
  const tr = triggerBox({ uid: 'viewer1', serverPoll: closedPoll(), authorId: 'author9', txnCommitted: false });
  return fire(tr, 'n1', closedPoll()).then(function () {
    return tr.counters.txn === 1 && tr.counters.notifs.length === 0 && tr.counters.authorRead === 0;
  });
});
tcase('D7 segunda llamada en la sesión no reintenta la transacción', () => {
  const tr = triggerBox({ uid: 'viewer1', serverPoll: closedPoll(), authorId: 'author9' });
  return fire(tr, 'n1', closedPoll()).then(function () {
    return fire(tr, 'n1', closedPoll()).then(function () {
      return tr.counters.txn === 1;
    });
  });
});
tcase('D8 updater server-accurate: si el servidor sigue abierta, no hay commit', () => {
  const tr = triggerBox({ uid: 'viewer1', serverPoll: mkPoll(), authorId: 'author9' });
  // El poll local dice cerrada (stale) pero el servidor dice abierta.
  return fire(tr, 'n1', closedPoll()).then(function () {
    return tr.counters.txn === 1 && tr.counters.notifs.length === 0;
  });
});

// ---------- Parte E: renderPostPollHTML intacto en sandbox viejo ----------
function oldRenderBox(withAnnouncer) {
  const sandbox = {};
  vm.createContext(sandbox);
  const mocks = [
    'var DrexCloud = { auth: function(){ return { currentUser: { uid: "u1" } }; } };',
    'var DREX_POLL_CHECK_SVG = \'<svg class="chk"></svg>\';',
    'var CSS = { escape: function(s){ return String(s); } };',
    'function appT(s){ return s; }',
    'function escapeHtml(s){ return String(s); }',
    'function escapeInlineSingleQuote(s){ return String(s); }'
  ].join('\n');
  vm.runInContext(mocks, sandbox);
  if (withAnnouncer) {
    vm.runInContext('var __hookCalls = 0; function maybeAnnouncePollClose(){ __hookCalls++; }', sandbox);
  }
  vm.runInContext(extractFn(html, 'pollTimeLeftText'), sandbox);
  vm.runInContext(extractFn(html, 'renderPostPollHTML'), sandbox);
  return sandbox;
}
tcase('E1 sandbox viejo (sin anunciador): cerrada renderiza igual, sin excepción', () => {
  const sb = oldRenderBox(false);
  vm.runInContext('this.__n = ' + JSON.stringify(closedPoll({ voters: { u1: 1 } })) + ';', sb);
  const out = vm.runInContext('renderPostPollHTML({ id: "n1", poll: this.__n }, false)', sb);
  return out.indexOf('Votación cerrada') !== -1 && out.indexOf('drex-poll-bar') !== -1;
});
tcase('E2 con anunciador definido: el hook se invoca al renderizar', () => {
  const sb = oldRenderBox(true);
  vm.runInContext('this.__n = ' + JSON.stringify(closedPoll()) + ';', sb);
  vm.runInContext('renderPostPollHTML({ id: "n1", poll: this.__n }, false)', sb);
  return vm.runInContext('__hookCalls', sb) === 1;
});

setTimeout(function () {
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
}, 500);
