/* ================================================================
 * C147 — Votaciones: AVISO AL AUTOR EN EL PRIMER VOTO DE ENCUESTA.
 *
 * HALLAZGO (hueco real, re-verificado contra el código): votePost avisa al
 * autor con addNotification(..., 'vote', ...) en cada upvote nuevo (línea
 * ~20725), pero voteInPoll NUNCA avisaba: el autor de una encuesta no se
 * enteraba de que la votaban. Votar en encuesta ya deja rastro en
 * "Mis votos" (C146) y permite cambiar el voto (C143), pero el autor queda
 * ciego.
 *
 * CAMBIO (index.html):
 *  - pollVoteNotifyDecision(prevVoteIdx, authorId, voterUid): helper PURO.
 *    true solo si es el PRIMER voto del usuario (prevVoteIdx undefined),
 *    hay authorId y no es auto-voto. Los cambios de voto (C143) no avisan,
 *    igual que votePost solo avisa del upvote nuevo.
 *  - voteInPoll: el updater de la transacción captura el voto previo del
 *    usuario (_c147PrevVoteIdx, server-accurate: no depende del DOM como
 *    hadVoted). En la rama committed, si fue primer voto, lee
 *    communityNotes/<noteId>/authorId (1 lectura barata, no el post entero)
 *    y llama addNotification(authorId, 'A <u> le dio un voto en tu encuesta.',
 *    'vote', {actionType:'post', actionId: noteId}).
 *    Tipo 'vote' a propósito: hereda el toggle 'likes' del destinatario vía
 *    notifTypeToPrefKey → shouldSkipNotificationFor (el usuario puede
 *    silenciarlo donde silencia los votos a posts). Convención de strings:
 *    los mensajes de notificación van en texto plano ES en todo el árbol
 *    (votePost, toggleEco, comentarios...) sin appT.
 *    Best-effort con try/catch + .catch(): el voto ya quedó confirmado por
 *    la transacción; un fallo de lectura/escritura no lo revierte ni toca
 *    la UI (mismo patrón que el índice userPollVotes de C146).
 *
 * Ejecutar con: node tests/test-c147-poll-vote-notify.js
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
    console.log((ok ? 'ok - ' : 'NOT OK - ') + name);
    if (!ok) failures++;
  } catch (e) {
    console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
    failures++;
  }
}
function count(re, src) { return (src.match(re) || []).length; }

// ---------- Extractor (misma técnica que los harnesses del ciclo) ----------
function extractFn(source, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(source);
  if (!m) throw new Error('no se encontró ' + name);
  const start = m.index;
  let i = source.indexOf('(', m.index), j, pdepth = 0, depth = 0, inStr = null, esc = false;
  for (j = i; j < source.length; j++) {
    const c = source[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(') pdepth++; else if (c === ')') { pdepth--; if (pdepth === 0) break; }
  }
  const bodyStart = source.indexOf('{', j);
  inStr = null; esc = false;
  for (j = bodyStart; j < source.length; j++) {
    const c = source[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(start, j + 1);
}

// ---------- Parte A: estáticos hit por hit ----------
tcase('A1 helper pollVoteNotifyDecision existe', () => {
  return html.indexOf('function pollVoteNotifyDecision(prevVoteIdx, authorId, voterUid)') !== -1;
});
tcase('A2 voteInPoll captura el voto previo en el updater (_c147PrevVoteIdx)', () => {
  const fn = extractFn(html, 'voteInPoll');
  return fn.indexOf('_c147PrevVoteIdx = (poll && poll.voters) ? poll.voters[user.uid] : undefined;') !== -1
    && fn.indexOf('return pollApplyVote(poll, user.uid, optIdx, Date.now());') !== -1;
});
tcase('A3 rama committed llama pollVoteNotifyDecision + addNotification tipo vote', () => {
  const fn = extractFn(html, 'voteInPoll');
  return fn.indexOf("pollVoteNotifyDecision(_c147PrevVoteIdx, authorId, user.uid)") !== -1
    && fn.indexOf("'vote', { actionType: 'post', actionId: noteId }") !== -1;
});
tcase('A4 mensaje exacto del aviso: "le dio un voto en tu encuesta"', () => {
  const fn = extractFn(html, 'voteInPoll');
  return fn.indexOf('le dio un voto en tu encuesta.') !== -1;
});
tcase('A5 el aviso solo corre en la rama committed (voto confirmado)', () => {
  const fn = extractFn(html, 'voteInPoll');
  return fn.indexOf('pollVoteNotifyDecision') > fn.indexOf('if (committed && snap && snap.val())');
});
tcase('A6 el aviso NO se lee/ejecuta si fue cambio de voto (prevVoteIdx undefined como puerta)', () => {
  const fn = extractFn(html, 'voteInPoll');
  return fn.indexOf('_c147PrevVoteIdx === undefined') !== -1;
});
tcase('A7 best-effort: try/catch + .catch en el camino de aviso', () => {
  const fn = extractFn(html, 'voteInPoll');
  const at = fn.indexOf('_c147PrevVoteIdx === undefined');
  const block = fn.slice(at, at + 1400);
  return count(/try\s*\{/g, block) >= 2 && count(/\.catch\(\(\)\s*=>\s*\{\}\)/g, block) >= 2;
});
tcase('A8 lee solo authorId (communityNotes/<noteId>/authorId), no el post entero', () => {
  const fn = extractFn(html, 'voteInPoll');
  return fn.indexOf("ref('communityNotes/' + noteId + '/authorId')") !== -1
    && fn.indexOf("ref('communityNotes/' + noteId).once") === -1;
});
tcase('A9 regresión C146: índice userPollVotes intacto en la rama committed', () => {
  const fn = extractFn(html, 'voteInPoll');
  return fn.indexOf("ref('userPollVotes/' + user.uid + '/' + noteId)") !== -1
    && fn.indexOf('refreshHistorialIfVisible();') !== -1;
});
tcase('A10 regresión C143: delegación en pollApplyVote + toast hadVoted intactos', () => {
  const fn = extractFn(html, 'voteInPoll');
  return fn.indexOf('return pollApplyVote(poll, user.uid, optIdx, Date.now());') !== -1
    && fn.indexOf("if (hadVoted) showMiniToast(appT('Voto actualizado'))") !== -1
    && fn.indexOf('poll.voters[user.uid] !== undefined') === -1;
});
tcase('A11 addNotification va con guarda typeof (no rompe si no existe)', () => {
  const fn = extractFn(html, 'voteInPoll');
  return fn.indexOf("typeof addNotification === 'function'") !== -1;
});

// ---------- Parte B: helper puro en sandbox ----------
function decisionBox() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(extractFn(html, 'pollVoteNotifyDecision'), sandbox);
  return sandbox;
}
function decide(sb, prev, authorId, voterUid) {
  const lit = v => (v === undefined ? 'undefined' : JSON.stringify(v));
  return vm.runInContext('pollVoteNotifyDecision(' + lit(prev) + ', ' + lit(authorId) + ', ' + lit(voterUid) + ')', sb);
}
tcase('B1 primer voto a autor ajeno -> true', () => decide(decisionBox(), undefined, 'author9', 'u1') === true);
tcase('B2 cambio de voto (prev=0) -> false', () => decide(decisionBox(), 0, 'author9', 'u1') === false);
tcase('B3 cambio de voto (prev=1) -> false', () => decide(decisionBox(), 1, 'author9', 'u1') === false);
tcase('B4 authorId null -> false', () => decide(decisionBox(), undefined, null, 'u1') === false);
tcase('B5 authorId vacío -> false', () => decide(decisionBox(), undefined, '', 'u1') === false);
tcase('B6 auto-voto (autor === votante) -> false', () => decide(decisionBox(), undefined, 'u1', 'u1') === false);
tcase('B7 prev=null (defensivo) -> false (sin aviso)', () => decide(decisionBox(), null, 'author9', 'u1') === false);

// ---------- Parte C: wiring de voteInPoll con mocks ----------
function voteBox(opts) {
  // opts: { poll, authorId, hadVotedMine, pollVotesSetRejects, username }
  const sandbox = { __calls: { notify: [], toasts: [] }, __opts: opts };
  vm.createContext(sandbox);
  const mockSrc = `
    var CSS = { escape: function(s){ return String(s); } };
    function appT(s){ return s; }
    function showMiniToast(m){ __calls.toasts.push(m); }
    function renderPostPollHTML(n, a){ return '<div class="drex-poll-mock"></div>'; }
    function requestAnimationFrame(f){ try { f(); } catch(_) {} return 1; }
    var _histCalls = 0;
    function refreshHistorialIfVisible(){ _histCalls++; }
    function addNotification(uid, msg, type, meta){ __calls.notify.push({uid, msg, type, meta}); return Promise.resolve(); }
    var DrexCloud = {
      auth: function(){ return { currentUser: { uid: 'u1', displayName: 'U', email: 'u@x' } }; },
      database: function(){
        return {
          ref: function(path){
            if (path === 'communityNotes/n1/poll') {
              return { transaction: function(fn, cb){
                var out = fn(JSON.parse(JSON.stringify(__opts.poll)));
                cb(null, true, { val: function(){ return out; } });
              }};
            }
            if (path === 'communityNotes/n1/authorId') {
              return { once: function(){ return Promise.resolve({ val: function(){ return __opts.authorId; } }); } };
            }
            if (path === 'users/u1') {
              return { once: function(){ return Promise.resolve({ val: function(){ return __opts.username ? { username: __opts.username } : {}; } }); } };
            }
            if (path === 'userPollVotes/u1/n1') {
              return { set: function(ts){
                if (__opts.pollVotesSetRejects) return Promise.reject(new Error('denied'));
                return Promise.resolve();
              }};
            }
            throw new Error('ruta no mockeada: ' + path);
          }
        };
      }
    };
    var document = {
      querySelector: function(sel){
        if (String(sel).indexOf('.drex-poll-opt.mine') !== -1) return __opts.hadVotedMine ? {} : null;
        return null;
      },
      querySelectorAll: function(){ return []; }
    };
  `;
  vm.runInContext(mockSrc, sandbox);
  vm.runInContext(extractFn(html, 'pollApplyVote'), sandbox);
  vm.runInContext(extractFn(html, 'pollVoteNotifyDecision'), sandbox);
  vm.runInContext(extractFn(html, 'voteInPoll'), sandbox);
  return sandbox;
}
function mkPoll(voters) {
  return { options: [{ t: 'A', v: 5 }, { t: 'B', v: 3 }], total: 8, voters: voters || {}, endsAt: Date.now() + 3600000 };
}
async function settle(ms) { return new Promise(r => setTimeout(r, ms || 60)); }
async function runVoteCase(opts, noteId, optIdx) {
  const sb = voteBox(opts);
  vm.runInContext('voteInPoll(' + JSON.stringify(noteId) + ', ' + optIdx + ');', sb);
  await settle(120);
  return sb.__calls;
}
async function main() {
  // C1: primer voto -> aviso al autor con tipo 'vote' y meta post.
  let calls = await runVoteCase({ poll: mkPoll({}), authorId: 'author9', username: 'votante' }, 'n1', 1);
  tcase('C1 primer voto: addNotification UNA vez al autor', () => calls.notify.length === 1 && calls.notify[0].uid === 'author9');
  tcase('C2 primer voto: tipo vote + mensaje exacto + meta post', () => {
    const n = calls.notify[0] || {};
    return n.type === 'vote'
      && n.msg === 'A votante le dio un voto en tu encuesta.'
      && n.meta && n.meta.actionType === 'post' && n.meta.actionId === 'n1';
  });
  tcase('C3 primer voto: NO sale el toast "Voto actualizado"', () => calls.toasts.indexOf('Voto actualizado') === -1);
  // C4: cambio de voto (C143) -> sin aviso, con toast.
  calls = await runVoteCase({ poll: mkPoll({ u1: 0 }), authorId: 'author9', hadVotedMine: true }, 'n1', 1);
  tcase('C4 cambio de voto: SIN aviso al autor', () => calls.notify.length === 0);
  tcase('C5 cambio de voto: toast "Voto actualizado" intacto', () => calls.toasts.indexOf('Voto actualizado') !== -1);
  // C6: auto-voto -> sin aviso.
  calls = await runVoteCase({ poll: mkPoll({}), authorId: 'u1', username: 'votante' }, 'n1', 0);
  tcase('C6 auto-voto: SIN aviso al autor', () => calls.notify.length === 0);
  // C7: best-effort: si userPollVotes.set falla, el aviso igual se envía y no hay excepción.
  calls = await runVoteCase({ poll: mkPoll({}), authorId: 'author9', pollVotesSetRejects: true }, 'n1', 0);
  tcase('C7 set userPollVotes falla: el aviso igual se envía (sin excepción)', () => calls.notify.length === 1);
  // C8: sin username en BD -> fallback displayName/email/'Alguien' (sin excepción).
  calls = await runVoteCase({ poll: mkPoll({}), authorId: 'author9' }, 'n1', 0);
  tcase('C8 sin username: mensaje con fallback, sin excepción', () => {
    const n = calls.notify[0] || {};
    return calls.notify.length === 1 && /le dio un voto en tu encuesta\./.test(n.msg || '');
  });
}
main().then(() => {
  console.log(failures === 0 ? 'PASS' : 'FAIL(' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
}).catch(e => { console.error('NOT OK - main [excepción: ' + e.message + ']'); process.exit(1); });
