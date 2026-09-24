/* ================================================================
 * C146 — ENCUESTAS VOTADAS EN "MIS VOTOS" (Historial).
 *
 * HALLAZGO (hueco real, re-verificado contra el código, candidato del
 * brief C146): la pestaña "Mis votos" del Historial solo leía
 * userVotes/<uid> (votos up/down a posts). Un voto en una ENCUESTA
 * (Votación, voteInPoll) no aparecía en ningún lado: el usuario no tenía
 * forma de reencontrar el post cuya encuesta votó, y la pestaña le decía
 * "Aún no has votado ninguna publicación" aunque sí había votado.
 *
 * CAMBIO (index.html):
 *  - voteInPoll: tras el commit confirmado de la transacción, escribe el
 *    índice inverso userPollVotes/<uid>/<noteId> = Date.now(), best-effort
 *    con .catch() (el voto ya quedó confirmado; un fallo no lo revierte ni
 *    cambia la UI; mismo patrón de escritura que userVotes). Además llama
 *    a refreshHistorialIfVisible() (igual que votePost) para que el voto
 *    recién hecho aparezca en el historial si está abierto.
 *  - drexMergeHistorialVoteIds(upVotes, pollVotes): helper puro que
 *    fusiona upvotes + encuestas votadas, sin duplicados por noteId;
 *    las encuestas (con fecha) van primero, los upvotes sin fecha
 *    conservan su orden anterior al final (sort estable).
 *  - loadHistorialLikes: lee userVotes y userPollVotes en paralelo
 *    (best-effort) y fusiona con el helper; el resto (límite 50, tarjetas,
 *    estados vacío/error) intacto, sin strings i18n nuevos.
 *
 * Ejecutar con: node tests/test-c146-poll-votes-history.js [--target base.html]
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const _ti = process.argv.indexOf('--target');
const _target = _ti >= 0 && process.argv[_ti + 1] ? path.resolve(process.argv[_ti + 1]) : path.join(ROOT, 'index.html');
const html = fs.readFileSync(_target, 'utf8');

let failures = 0;
function tcase(name, fn) {
  try {
    const ok = (typeof fn === 'function') ? fn() : !!fn;
    console.log((ok ? 'ok - ' : 'NOT OK - ') + name);
    if (!ok) failures++;
  } catch (e) {
    console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
    failures++;
  }
}

// Extrae el cuerpo de `function NAME(...) { ... }` (mismo patrón que
// tests/test-c145-poll-only-post.js).
function extractFnBody(src, fnName) {
  const start = src.indexOf('function ' + fnName + '(');
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

// ---------- A. Aserciones estáticas (hit por hit) ----------
const voteBody = extractFnBody(html, 'voteInPoll');
tcase('A1 voteInPoll existe', voteBody !== null);
if (voteBody) {
  tcase('A2 voteInPoll escribe el índice inverso userPollVotes/<uid>/<noteId>',
    voteBody.indexOf("ref('userPollVotes/' + user.uid + '/' + noteId)") !== -1);
  tcase('A3 la escritura va con valor Date.now() (ordenable por fecha)',
    voteBody.indexOf('.set(Date.now())') !== -1);
  tcase('A4 la escritura está dentro de la rama committed (solo si el voto quedó confirmado)',
    voteBody.indexOf('userPollVotes') > voteBody.indexOf('if (committed && snap && snap.val())'));
  tcase('A5 best-effort: la escritura tiene .catch() que no revierte el voto',
    voteBody.indexOf('.catch(() => {})') !== -1);
  tcase('A6 la rama committed llama refreshHistorialIfVisible() (igual que votePost)',
    voteBody.indexOf('refreshHistorialIfVisible();') !== -1);
  tcase('A7 C143 intacto: delega en pollApplyVote',
    voteBody.indexOf('return pollApplyVote(poll, user.uid, optIdx, Date.now());') !== -1);
}

const mergeBody = extractFnBody(html, 'drexMergeHistorialVoteIds');
tcase('A8 drexMergeHistorialVoteIds existe (helper puro de fusión)', mergeBody !== null);
if (mergeBody) {
  tcase('A9 filtra upvotes (data[k] === \'up\') como antes',
    mergeBody.indexOf("=== 'up'") !== -1);
  tcase('A10 dedup por noteId (Set seen)',
    mergeBody.indexOf('new Set()') !== -1 && mergeBody.indexOf('seen.has(k)') !== -1);
  tcase('A11 ordena por fecha descendente (encuestas votadas primero)',
    mergeBody.replace(/\s+/g, '').indexOf('(b.ts||0)-(a.ts||0)') !== -1);
}

const likesBody = extractFnBody(html, 'loadHistorialLikes');
tcase('A12 loadHistorialLikes existe', likesBody !== null);
if (likesBody) {
  tcase('A13 lee userVotes/<uid> (como antes)',
    likesBody.indexOf("ref('userVotes/' + user.uid)") !== -1);
  tcase('A14 lee userPollVotes/<uid> en paralelo',
    likesBody.indexOf("ref('userPollVotes/' + user.uid)") !== -1);
  tcase('A15 fusiona con drexMergeHistorialVoteIds',
    likesBody.indexOf('drexMergeHistorialVoteIds(') !== -1);
  tcase('A16 conserva el límite de 50 posts',
    likesBody.indexOf('ids.slice(0, 50)') !== -1);
  tcase('A17 estado vacío intacto',
    likesBody.indexOf('Aún no has votado ninguna publicación') !== -1);
  tcase('A18 estado de error intacto',
    likesBody.indexOf('No se pudieron cargar tus votos.') !== -1);
}

// ---------- B. Conductuales: drexMergeHistorialVoteIds en sandbox ----------
function mergeBox() {
  const sb = {};
  vm.createContext(sb);
  const src = extractFnBody(html, 'drexMergeHistorialVoteIds');
  if (!src) return null;
  vm.runInContext('function drexMergeHistorialVoteIds(upVotes, pollVotes) {' + src + '}', sb);
  return sb;
}
function runMerge(upVotes, pollVotes) {
  const sb = mergeBox();
  if (!sb) return null;
  const _u = 'u'; const _p = 'p';
  sb[_u] = upVotes; sb[_p] = pollVotes;
  return vm.runInContext('drexMergeHistorialVoteIds(this.u, this.p)', sb);
}

tcase('B1 solo upvotes: filtra \'up\' y conserva el orden reverse previo', () => {
  const out = runMerge({ a: 'up', b: 'down', c: 'up' }, {});
  return out && out.length === 2 && out[0] === 'c' && out[1] === 'a';
});
tcase('B2 solo encuestas: orden por fecha descendente', () => {
  const out = runMerge({}, { n1: 100, n2: 500, n3: 300 });
  return out && out.join(',') === 'n2,n3,n1';
});
tcase('B3 mezcla: encuestas votadas primero, upvotes al final en su orden', () => {
  const out = runMerge({ u1: 'up', u2: 'up' }, { p1: 9000 });
  return out && out.join(',') === 'p1,u2,u1';
});
tcase('B4 dedup: mismo noteId con upvote y voto en encuesta -> una sola vez', () => {
  const out = runMerge({ x: 'up' }, { x: 12345 });
  return out && out.length === 1 && out[0] === 'x';
});
tcase('B5 ts corrupto (objeto) no rompe: cae a ts=0 con los upvotes', () => {
  const out = runMerge({ u1: 'up' }, { p1: { raro: true } });
  return out && out.length === 2 && out.indexOf('p1') !== -1 && out.indexOf('u1') !== -1;
});
tcase('B6 entradas nulas -> lista vacía (estado vacío del tab)', () => {
  const out = runMerge(null, null);
  return out && out.length === 0;
});
tcase('B7 ts como string numérico se convierte (Number)', () => {
  const out = runMerge({}, { p1: '777' });
  return out && out.length === 1 && out[0] === 'p1';
});
tcase("B8 'down' nunca aparece (sin regresión)", () => {
  const out = runMerge({ d: 'down' }, {});
  return out && out.length === 0;
});

if (failures > 0) { console.error(failures + ' FAILURES'); process.exit(1); }
console.log('TODOS OK');
