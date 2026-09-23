// SEC C14 keyguard fuera del chat: interpolaciones de `.key` / `snapshot.key` /
// `child.key` y derivados dentro de HTML fuera del chat.
//
// Instancias REALES corregidas (antes: XSS almacenado / SyntaxError con claves forjadas):
//  1. openGroupPostsView: item.id (= child.key de communityNotes) crudo en
//     onclick="... openPostPermalink('${item.id}')" -> escapeInlineSingleQuote.
//  2. practicarCardHTML: x.id (= ch.key de languageExercises) crudo en
//     onclick="openExerciseDetail('"+x.id+"')" -> escapeInlineSingleQuote.
//  3. renderPostsList: authorAvatarId (= `search-post-author-${post.id}`, post.id =
//     child.key) crudo en id="..." y post.authorId crudo en data-author-id (x2)
//     -> escapeHtml en el sitio de interpolacion.
//  4-8. Selectores JS construidos con ids derivados de claves forjables:
//     snfUpdateFeedPostCounters (#score-/#eco-), setCommentsCountUI
//     ([id="commentscount-"]), voteInPoll ([data-poll=]), revealPostSpoiler
//     ([data-spoiler-card=]), openAuthorProfile ([data-author-id=]) -> CSS.escape.
//
// Instancias revisadas y SANAS (no se tocan):
//  - drexReportChooseReason('${r.key}'): DREX_REPORT_REASONS es lista hardcodeada.
//  - getElementById(`post-${snap.key}`) / noteElement.id = `post-${note.id}`:
//    DOM lookup / asignacion por propiedad, no HTML.
//  - Musica (musicEsc/musicEscJs), notificaciones (escapeInlineSingleQuote),
//    composer de grupos (escapeHtml), historial (callbacks por propiedad DOM),
//    stickers (URLs hardcodeadas), idiomas (whitelist [^a-z]).
'use strict';
const fs = require('fs');
const path = require('path');

function findHtml() {
  const cands = [
    path.join(__dirname, '..', 'index.html'),
    path.join(__dirname, '..', 'src', 'index.html'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('index.html no encontrado');
}
const html = fs.readFileSync(findHtml(), 'utf8');

function extractFn(name) {
  const i = html.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no encontrada: ' + name);
  let j = html.indexOf('{', i), depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}') { depth--; if (!depth) return html.slice(i, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}
function checkCount(name, needle, expected) {
  const n = html.split(needle).length - 1;
  check(`${name} (x${n}==${expected})`, n === expected);
}

// ---------- 1. Estáticos: formas vulnerables eliminadas ----------
check('grupo: openPostPermalink con escapeInlineSingleQuote',
  html.includes("openPostPermalink('${escapeInlineSingleQuote(item.id)}')"));
check('grupo: forma cruda eliminada', !html.includes("openPostPermalink('${item.id}')"));

check('practicar: openExerciseDetail con escapeInlineSingleQuote',
  html.includes("openExerciseDetail(\\'' + escapeInlineSingleQuote(x.id) + '\\')"));
check('practicar: forma cruda eliminada',
  !html.includes("openExerciseDetail(\\'' + x.id + '\\')"));

check('busqueda: id con escapeHtml(authorAvatarId)',
  html.includes('<img id="${escapeHtml(authorAvatarId)}"'));
checkCount('busqueda: data-author-id con escapeHtml(post.authorId)',
  'data-author-id="${escapeHtml(post.authorId || \'\')}"', 2);
check('busqueda: forma cruda id eliminada',
  !html.includes('<img id="${authorAvatarId}" data-author-id="${post.authorId'));
check('busqueda: forma cruda data-author-id eliminada',
  !html.includes('data-author-id="${post.authorId || \'\'}"'));

// ---------- 2. Estáticos: selectores con CSS.escape ----------
check('feed: #score- con CSS.escape',
  html.includes('existingPost.querySelector(`#score-${CSS.escape(note.id)}`)'));
check('feed: #eco- con CSS.escape',
  html.includes('existingPost.querySelector(`#eco-${CSS.escape(note.id)}`)'));
check('commentscount: selector con CSS.escape',
  html.includes(`document.querySelectorAll('[id="commentscount-' + CSS.escape(noteId) + '"]')`));
check('poll: selector con CSS.escape',
  html.includes(`const sel = '[data-poll="' + CSS.escape(noteId) + '"]';`));
check('spoiler: selector con CSS.escape',
  html.includes(`document.querySelectorAll('[data-spoiler-card="' + CSS.escape(noteId) + '"]')`));
check('author-profile: selector con CSS.escape',
  html.includes('document.querySelectorAll(`[data-author-id="${CSS.escape(authorId)}"]`)'));

// ---------- 3. Sanas: no se tocaron ----------
check('reporte: razones siguen hardcodeadas',
  html.includes("drexReportChooseReason('${r.key}')"));
check('feed: getElementById(post-snap.key) intacto (DOM lookup)',
  html.includes('getElementById(`post-${snap.key}`)'));
check('musica: musicEscJs sigue en uso', html.includes('musicEscJs('));
check('notificaciones: escapeInlineSingleQuote en notificationId',
  html.includes('escapeInlineSingleQuote(notification.notificationId'));

// ---------- 4. Funcionales con escapers reales ----------
// Se evaluan en un ambito compartido porque escapeInlineSingleQuote
// depende de escapeSingleQuote y escapeHtml de escapeHTML.
// eslint-disable-next-line no-eval
const __scope = eval('(function(){ ' + extractFn('escapeHTML') + ' ' + extractFn('escapeSingleQuote') + ' ' + extractFn('escapeInlineSingleQuote') + ' ' + extractFn('escapeHtml') + ' return { escapeHTML: escapeHTML, escapeInlineSingleQuote: escapeInlineSingleQuote, escapeHtml: escapeHtml }; })()');
const escapeHTML = __scope.escapeHTML;
const escapeInlineSingleQuote = __scope.escapeInlineSingleQuote;
const escapeHtml = __scope.escapeHtml;

const FORGED_KEY = 'x\');window.__pwned=\'YES\';//';
const FORGED_ATTR = 'x"><svg onload="window.__pwned=\'YES\'">';
const LEGIT = '-Nxyz_abc123';

// 4a. onclick '...' con clave forjada: sin breakout del literal ni del atributo.
// Propiedad real: toda comilla simple del valor escapado va precedida de backslash,
// asi que el literal JS '...' nunca se termina antes de tiempo.
const escForged = escapeInlineSingleQuote(FORGED_KEY);
const lit = "openExerciseDetail('" + escForged + "')";
const unescapedQuote = /(?<!\\)'/.test(escForged);
check('onclick: sin comilla sin escapar en valor forjado', !unescapedQuote);
check('onclick: el literal completo no se rompe',
  lit === "openExerciseDetail('x\\');window.__pwned=\\'YES\\';//')");
check('onclick: id legitimo intacto',
  escapeInlineSingleQuote(LEGIT) === LEGIT);

// 4b. id="..." con clave forjada: sin breakout de atributo
const idAttr = 'search-post-author-' + escapeHtml(FORGED_ATTR);
check('id: comillas neutralizadas', idAttr.includes('&quot;') && !idAttr.includes('"><'));
check('id: < > neutralizados', !idAttr.includes('<svg') && idAttr.includes('&lt;'));
check('id: legitimo intacto', escapeHtml('search-post-author-' + LEGIT) === 'search-post-author-' + LEGIT);

// 4c. data-author-id con authorId forjado: sin breakout
const dataAttr = escapeHtml('u1" data-x="');
check('data-author-id: sin breakout', dataAttr === 'u1&quot; data-x=&quot;');

// 4d. escapeInlineSingleQuote no deja pasar & crudo que el parser decodificaria
check('escapeInlineSingleQuote escapa & primero', escapeInlineSingleQuote('a&b').includes('&amp;'));

console.log(failures === 0 ? 'test-c14-keyguard-outside-chat: TODO OK' : `test-c14-keyguard-outside-chat: ${failures} FALLOS`);
process.exit(failures ? 1 : 0);
