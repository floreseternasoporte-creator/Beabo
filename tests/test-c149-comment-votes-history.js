/* ================================================================
 * C149 — COMENTARIOS VOTADOS EN "MIS VOTOS" (Historial).
 *
 * HALLAZGO (hueco real, re-verificado contra el código, candidato del
 * brief C149): la pestaña "Mis votos" del Historial leía userVotes/<uid>
 * (votos a posts, C146 sumó encuestas votadas vía userPollVotes), pero los
 * VOTOS A COMENTARIOS (voteComment, con su propio índice
 * userCommentVotes/<uid> = 'up'|'down') no aparecían en ningún lado: el
 * usuario no tenía forma de reencontrar un comentario al que le dio voto
 * positivo, aunque el voto existe y hasta genera notificación al autor.
 *
 * CAMBIO (index.html):
 *  - voteComment: tras confirmar la transacción, escribe best-effort el
 *    índice inverso userCommentVotePosts/<uid>/<safeVoteKey> =
 *    {n: noteId, t: ts, p: commentPath} con .catch() (fire-and-forget: un
 *    fallo no revierte el voto ni cambia la UI). Al retirar el voto se
 *    borra la entrada (.remove()). El valor 'up'/'down' de userCommentVotes
 *    NO se toca (lo lee la transacción del voto). Además llama a
 *    refreshHistorialIfVisible() (igual que votePost/voteInPoll).
 *  - drexCommentVotePostEntry(newVote, noteId, commentPath, nowMs): helper
 *    puro que construye la entrada del índice o null (null = borrar).
 *  - drexMergeHistorialCommentVotes(commentVotes, commentPosts): helper puro
 *    que fusiona {key:'up'|'down'} con {key:{n,t,p}}; solo 'up' con nota y
 *    ruta válidas, ordenados por t descendente.
 *  - loadHistorialLikes: lee userCommentVotes + userCommentVotePosts en
 *    paralelo (best-effort) y pinta la sección "Comentarios que votaste"
 *    DESPUÉS de las tarjetas de posts (orden garantizado); cada tarjeta
 *    abre los comentarios del post (openCommentsView). Los estados
 *    vacío/error quedan intactos.
 *  - i18n: merge C149 con 'Comentarios que votaste' y 'Voto positivo' en
 *    EN/ZH/PT (patrón de los merges de Pulso).
 *
 * DEGRADACIÓN DOCUMENTADA: userCommentVotePosts es un nodo RTDB nuevo y las
 * reglas viven fuera del repo; si se deniegan, la sección simplemente no
 * muestra esos votos (best-effort). Los votos hechos ANTES de este cambio
 * no tienen entrada en el índice y no aparecen (sin backfill posible: el
 * índice viejo no guarda el noteId).
 *
 * Ejecutar con: node tests/test-c149-comment-votes-history.js [--target base.html]
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
// tests/test-c146-poll-votes-history.js).
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

// Extrae los dicts EN/ZH/PT del bloque "// C149: i18n" y los evalúa.
function extractC149I18n(src) {
  const mark = src.indexOf('// C149: i18n');
  if (mark === -1) return null;
  const sec = src.slice(mark, mark + 2000);
  const out = {};
  ['EN', 'ZH', 'PT'].forEach(function (k) {
    const key = 'var ' + k + ' = {';
    const s = sec.indexOf(key);
    if (s === -1) { out[k] = null; return; }
    const open = sec.indexOf('{', s);
    let depth = 0, i = open;
    for (; i < sec.length; i++) {
      if (sec[i] === '{') depth++;
      else if (sec[i] === '}') { depth--; if (depth === 0) break; }
    }
    try { out[k] = new Function('return (' + sec.slice(open, i + 1) + ');')(); }
    catch (e) { out[k] = null; }
  });
  return out;
}

// ---------- A. Aserciones estáticas (hit por hit) ----------
const entryBody = extractFnBody(html, 'drexCommentVotePostEntry');
tcase('A1 drexCommentVotePostEntry existe (helper puro)', entryBody !== null);

const mergeBody = extractFnBody(html, 'drexMergeHistorialCommentVotes');
tcase('A2 drexMergeHistorialCommentVotes existe (helper puro)', mergeBody !== null);
if (mergeBody) {
  tcase('A2b el merge solo acepta up', mergeBody.indexOf("!== 'up'") !== -1);
  tcase('A2c ordena por t descendente',
    mergeBody.replace(/\s+/g, '').indexOf('(b.ts||0)-(a.ts||0)') !== -1);
}

const commentVoteBody = extractFnBody(html, 'voteComment');
tcase('A3 voteComment existe', commentVoteBody !== null);
if (commentVoteBody) {
  tcase('A4 voteComment escribe el índice userCommentVotePosts/<uid>/<safeVoteKey>',
    commentVoteBody.indexOf("ref('userCommentVotePosts/' + user.uid + '/' + safeVoteKey)") !== -1);
  tcase('A5 la escritura del índice es best-effort con catch',
    commentVoteBody.indexOf('_c149IdxRef.set(_c149Entry).catch(function () {})') !== -1);
  tcase('A6 al retirar el voto se borra la entrada del índice',
    commentVoteBody.indexOf('_c149IdxRef.remove().catch(function () {})') !== -1);
  tcase('A7 el valor up/down de userCommentVotes NO se toca (transacción intacta)',
    commentVoteBody.indexOf('if (newVote) return userVoteRef.set(newVote);') !== -1 &&
    commentVoteBody.indexOf('return userVoteRef.remove();') !== -1);
  tcase('A8 el índice se escribe antes del set principal (fire-and-forget, no bloquea)',
    commentVoteBody.indexOf('userCommentVotePosts') < commentVoteBody.indexOf('if (newVote) return userVoteRef.set(newVote);'));
  tcase('A9 voteComment refresca el historial si está visible',
    commentVoteBody.indexOf('refreshHistorialIfVisible()') !== -1);
}

const likesBody = extractFnBody(html, 'loadHistorialLikes');
tcase('A10 loadHistorialLikes existe', likesBody !== null);
if (likesBody) {
  tcase('A11 lee userCommentVotes/<uid> en paralelo',
    likesBody.indexOf("ref('userCommentVotes/' + user.uid)") !== -1);
  tcase('A12 lee userCommentVotePosts/<uid> en paralelo',
    likesBody.indexOf("ref('userCommentVotePosts/' + user.uid)") !== -1);
  tcase('A13 fusiona con drexMergeHistorialCommentVotes',
    likesBody.indexOf('drexMergeHistorialCommentVotes(') !== -1);
  tcase('A14 sección con encabezado traducido',
    likesBody.indexOf("appT('Comentarios que votaste')") !== -1);
  tcase('A15 el encabezado usa textContent (sin HTML inyectado)',
    likesBody.indexOf('sec.textContent = appT(') !== -1);
  tcase('A16 el encabezado usa estilo inline determinista (sin Tailwind arbitrary)',
    likesBody.indexOf("sec.setAttribute('style',") !== -1);
  tcase('A17 lee cada comentario de postComments/<noteId>/<path>',
    likesBody.indexOf("ref('postComments/' + row.noteId + '/' + row.path)") !== -1);
  tcase('A18 conserva el límite de 30 comentarios',
    likesBody.indexOf('cVotes.slice(0, 30)') !== -1);
  tcase('A19 la tarjeta abre los comentarios del post',
    likesBody.indexOf('openCommentsView(') !== -1);
  tcase('A20 estado vacío intacto',
    likesBody.indexOf('Aún no has votado ninguna publicación') !== -1);
  tcase('A21 estado de error intacto',
    likesBody.indexOf('No se pudieron cargar tus votos.') !== -1);
  tcase('A22 la sección de comentarios se pinta después de los posts',
    likesBody.lastIndexOf('_c149RenderCommentVotes();') > likesBody.indexOf('panel.appendChild(_buildHistorialCard'));
}

// ---------- B. Conductuales: helpers puros en sandbox ----------
function loadPure() {
  const sb = {};
  vm.createContext(sb);
  const eb = extractFnBody(html, 'drexCommentVotePostEntry');
  const mb = extractFnBody(html, 'drexMergeHistorialCommentVotes');
  if (!eb || !mb) return null;
  vm.runInContext('function drexCommentVotePostEntry(newVote, noteId, commentPath, nowMs) {' + eb + '}', sb);
  vm.runInContext('function drexMergeHistorialCommentVotes(commentVotes, commentPosts) {' + mb + '}', sb);
  return sb;
}
const sb = loadPure();
tcase('B0 helpers cargan en sandbox', sb !== null);
if (sb) {
  // `run` aísla `this` por llamada (los métodos shorthand con `this` no
  // propagan contadores al llamarse como función libre: se usan closures).
  const run = (src, vars) => {
    const c = vm.createContext(Object.assign({}, vars));
    vm.runInContext('function drexCommentVotePostEntry(newVote, noteId, commentPath, nowMs) {' +
      extractFnBody(html, 'drexCommentVotePostEntry') + '}', c);
    vm.runInContext('function drexMergeHistorialCommentVotes(commentVotes, commentPosts) {' +
      extractFnBody(html, 'drexMergeHistorialCommentVotes') + '}', c);
    return vm.runInContext(src, c);
  };

  tcase('B1 voto up genera entrada {n,t,p}',
    () => {
      const e = run('drexCommentVotePostEntry("up", "n1", "c1/replies/c2", 1700000000000)', {});
      return e && e.n === 'n1' && e.t === 1700000000000 && e.p === 'c1/replies/c2';
    });
  tcase('B2 retirar el voto (null) -> null (se borra la entrada)',
    () => run('drexCommentVotePostEntry(null, "n1", "c1", 1700000000000)', {}) === null);
  tcase('B3 sin noteId -> null',
    () => run('drexCommentVotePostEntry("up", "", "c1", 1700000000000)', {}) === null);
  tcase('B4 nowMs inválido -> null',
    () => run('drexCommentVotePostEntry("up", "n1", "c1", "NaN")', {}) === null);
  tcase('B5 sin commentPath -> null',
    () => run('drexCommentVotePostEntry("up", "n1", "", 1700000000000)', {}) === null);
  tcase('B6 el merge solo deja pasar up (down y ausentes fuera)',
    () => {
      const r = run('drexMergeHistorialCommentVotes({k1:"up", k2:"down", k3:"up"}, {k1:{n:"n1",t:5,p:"c1"}, k2:{n:"n2",t:9,p:"c2"}, k4:{n:"n4",t:1,p:"c4"}})', {});
      return r.length === 1 && r[0].key === 'k1' && r[0].noteId === 'n1' && r[0].path === 'c1';
    });
  tcase('B7 orden por t descendente',
    () => {
      const r = run('drexMergeHistorialCommentVotes({a:"up",b:"up",c:"up"}, {a:{n:"n",t:3,p:"p"}, b:{n:"n",t:30,p:"p"}, c:{n:"n",t:10,p:"p"}})', {});
      return r.length === 3 && r[0].key === 'b' && r[1].key === 'c' && r[2].key === 'a';
    });
  tcase('B8 entradas sin n o sin p se descartan',
    () => {
      const r = run('drexMergeHistorialCommentVotes({a:"up",b:"up",c:"up"}, {a:{t:3,p:"p"}, b:{n:"n",t:3}, c:{n:"n",t:3,p:"p"}})', {});
      return r.length === 1 && r[0].key === 'c';
    });
  tcase('B9 entradas no-objeto se descartan',
    () => {
      const r = run('drexMergeHistorialCommentVotes({a:"up",b:"up"}, {a:"up", b:{n:"n",t:1,p:"p"}})', {});
      return r.length === 1 && r[0].key === 'b';
    });
  tcase('B10 inputs nulos -> vacío',
    () => {
      const r = run('drexMergeHistorialCommentVotes(null, null)', {});
      return Array.isArray(r) && r.length === 0;
    });
  tcase('B11 ts corrupto no rompe el orden (va al final)',
    () => {
      const r = run('drexMergeHistorialCommentVotes({a:"up",b:"up"}, {a:{n:"n",t:"NaN",p:"p"}, b:{n:"n",t:7,p:"p"}})', {});
      return r.length === 2 && r[0].key === 'b' && r[1].key === 'a' && r[1].ts === 0;
    });
}

// ---------- C. i18n del bloque C149 ----------
const i18n = extractC149I18n(html);
tcase('C1 bloque i18n C149 existe con EN/ZH/PT', !!(i18n && i18n.EN && i18n.ZH && i18n.PT));
if (i18n && i18n.EN && i18n.ZH && i18n.PT) {
  const keys = ['Comentarios que votaste', 'Voto positivo'];
  keys.forEach(function (k) {
    tcase('C2 clave "' + k + '" en EN', typeof i18n.EN[k] === 'string' && i18n.EN[k].length > 0);
    tcase('C3 clave "' + k + '" en ZH', typeof i18n.ZH[k] === 'string' && i18n.ZH[k].length > 0);
    tcase('C4 clave "' + k + '" en PT', typeof i18n.PT[k] === 'string' && i18n.PT[k].length > 0);
  });
  tcase('C5 el merge escribe en los dicts TEXT (no ATTRS)',
    html.indexOf('Object.assign(APP_ENGLISH_TEXT, EN)') !== -1 &&
    html.indexOf('Object.assign(APP_CHINESE_TEXT, ZH)') !== -1 &&
    html.indexOf('Object.assign(APP_PORTUGUESE_TEXT, PT)') !== -1);
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASARON' : '\nFALLARON ' + failures + ' TESTS');
process.exit(failures === 0 ? 0 : 1);
