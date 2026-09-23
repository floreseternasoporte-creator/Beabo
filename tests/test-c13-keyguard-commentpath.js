// SEC ciclo 13: barrido de interpolaciones de snapshot.key/.key en HTML.
// Claves forjables (commentPath de postComments, exSnap.key/ch.key) llegaban
// crudas a atributos id="..." (8x en comentarios) y al onclick '...' de
// practicarCorrectionHTML -> XSS almacenado (PoC en Chromium: inyeccion y
// ejecucion de JS confirmadas antes del fix, bloqueadas despues).
// Este test fija la regresion: estaticos sobre index.html + funcionales con
// los escapers REALES extraidos del archivo.
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}

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

// ---------- 1. Estaticos: ningun id="..." con commentPath crudo ----------
const rawIdInterp = html.match(/id="[^"]*\$\{(?:o\.)?commentPath\}/g) || [];
check('0x id="..." con ${o.commentPath}/${commentPath} crudo', rawIdInterp.length === 0);
check('igRowOpts define safeCommentPathAttr = escapeHTML(commentPath)',
  html.includes('safeCommentPathAttr: escapeHTML(commentPath),'));
for (const n of ['upvote', 'score', 'downvote', 'textbox', 'content', 'edited']) {
  check(`id="comment-${n}-..." usa safeCommentPathAttr`,
    html.includes(`id="comment-${n}-\${o.safeCommentPathAttr}"`));
}
check('id="ig-replies-label-..." escapado', html.includes('id="ig-replies-label-${escapeHTML(commentPath)}"'));
check('id="replies-..." escapado', html.includes('id="replies-${escapeHTML(commentPath)}"'));

// ---------- 2. Estaticos: onclick de correcciones escapado ----------
check('toggleCorrectionHelpful escapa pxDetailExercise.id',
  html.includes("escapeInlineSingleQuote(pxDetailExercise.id)"));
check('toggleCorrectionHelpful escapa c.id',
  html.includes("escapeInlineSingleQuote(c.id)"));
check('no queda onclick con id crudo en correcciones',
  !html.includes("toggleCorrectionHelpful(\\'' + pxDetailExercise.id"));

// ---------- 3. Funcionales con escapers reales ----------
// eslint-disable-next-line no-eval
const escapeHTML = eval('(' + extractFn('escapeHTML') + ')');
const escapeSingleQuote = eval('(' + extractFn('escapeSingleQuote') + ')');
const escapeInlineSingleQuote = eval('(' + extractFn('escapeInlineSingleQuote') + ')');

const FORGED = 'x"><img src=x onerror=alert(1)>';
const LEGIT = '-Nxyz_abc123';

// 3a. id="..." con escapeHTML: sin breakout, comillas neutralizadas
const idAttr = 'comment-upvote-' + escapeHTML(FORGED);
check('escapeHTML neutraliza " en id', idAttr.includes('&quot;') && !idAttr.includes('">'));
check('escapeHTML neutraliza < > en id', !idAttr.includes('<img') && idAttr.includes('&lt;'));
check('id legitimo intacto tras escapeHTML', escapeHTML(LEGIT) === LEGIT);

// 3b. onclick '...' con escapeInlineSingleQuote: sin breakout de literal ni de atributo
const forgedCorr = "x');alert(1);//";
const lit = "toggleCorrectionHelpful('" + escapeInlineSingleQuote('-Nex1') + "', '" +
  escapeInlineSingleQuote(forgedCorr) + "', this)";
// escapeInlineSingleQuote("x');alert(1);//") === "x\\');alert(1);//": la comilla
// queda escapada con backslash, sin breakout del literal ni del atributo.
check("escapeInlineSingleQuote neutraliza ' en literal JS",
  lit === "toggleCorrectionHelpful('-Nex1', 'x\\');alert(1);//', this)");
const withQuote = escapeInlineSingleQuote('a"b');
check('escapeInlineSingleQuote escapa " como &quot;', withQuote === 'a&quot;b');

console.log(failures === 0 ? 'test-c13-keyguard-commentpath: TODO OK' : `test-c13-keyguard-commentpath: ${failures} FALLOS`);
process.exit(failures ? 1 : 0);
