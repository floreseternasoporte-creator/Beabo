// SEC C14-04-residual: el fix 99b70c9 escapó practicarCardHTML pero dejó crudo el
// botón "Eliminar ejercicio" en la vista de detalle:
//   html += '<button onclick="deleteExercise(\'' + ex.id + '\')">...'
// donde ex.id = exSnap.key de `languageExercises` (clave forjable por el atacante).
// Fix: escapeInlineSingleQuote(ex.id).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

// 1. Estático: el botón delete usa escapeInlineSingleQuote (forma cruda eliminada).
check('detalle: deleteExercise con escapeInlineSingleQuote',
  html.includes("deleteExercise(\\'' + escapeInlineSingleQuote(ex.id) + '\\')"));
check('detalle: forma cruda eliminada',
  !html.includes("deleteExercise(\\'' + ex.id + '\\')"));

// 2. Fuente: ex.id viene de exSnap.key (clave forjable).
check('fuente: ex.id = exSnap.key',
  html.includes('pxDetailExercise = Object.assign({ id: exSnap.key }'));

// 3. Funcional: con el escaper REAL del HTML, una key forjada no rompe el literal.
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(extractFn('escapeSingleQuote') + '\n' + extractFn('escapeInlineSingleQuote'), sandbox);
const esc = sandbox.escapeInlineSingleQuote;
// Tokeniza el handler como lo haría el motor JS: el literal '...' debe cerrarse
// exactamente antes del ')' final, y el valor interno debe redondear al original.
function parseJsStringLiteral(handler, openIdx) {
  // handler[openIdx] debe ser '; retorna {value, endIdx} o null si no cierra bien.
  if (handler[openIdx] !== "'") return null;
  let out = '', i = openIdx + 1;
  while (i < handler.length) {
    const ch = handler[i];
    if (ch === '\\' && i + 1 < handler.length) { out += handler[i + 1]; i += 2; continue; }
    if (ch === "'") return { value: out, endIdx: i };
    out += ch; i++;
  }
  return null;
}
const evilId = `x');alert('XSS-PWN');//`;
const handler = `deleteExercise('${esc(evilId)}')`;
const lit = parseJsStringLiteral(handler, handler.indexOf("'"));
check('forjada: el literal cierra justo antes de )',
  !!lit && handler[lit.endIdx + 1] === ')' && lit.endIdx === handler.length - 2);
check('forjada: el valor interno redondea al original',
  !!lit && lit.value === evilId);
// Legítima: IDs normales pasan intactos (sin regresión).
check('legitima: push ID intacto', esc('-Nxyz_abc123') === '-Nxyz_abc123');

console.log(failures ? `\n${failures} checks FAILED` : '\ntest-c14-deleteexercise-escape: TODO OK');
process.exit(failures ? 1 : 0);
