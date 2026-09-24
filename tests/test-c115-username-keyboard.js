// C115: los dos campos de nombre de usuario (regUsername en el registro y
// settings-username en ajustes) no tenían autocapitalize="none",
// autocorrect="off" ni spellcheck="false". En iOS esto auto-capitaliza la
// primera letra y sugiere correcciones de diccionario sobre un identificador,
// de modo que el campo puede mostrar "Darelito" mientras la verificación de
// disponibilidad y el nombre final usan normalizeUsername() en minúsculas
// ("darelito"): el display difiere del valor real. El fix alinea ambos campos
// con el trío que ya lleva el campo de login (emailInput).
'use strict';
const fs = require('fs');
const path = require('path');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(__dirname, '..', 'index.html');
let html;
try { html = fs.readFileSync(htmlPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer index.html'); process.exit(1); }

let failures = 0;
function ok(name, cond) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name); }
}

function inputTagWithId(id) {
  const m = html.match(new RegExp('<input\\b[^>]*\\bid="' + id + '"[^>]*>', 'i'));
  return m ? m[0] : null;
}

// ---------- 1. Los 2 campos de username llevan el trío ----------
const USERNAME_IDS = ['regUsername', 'settings-username'];
const TRIO = ['autocapitalize="none"', 'autocorrect="off"', 'spellcheck="false"'];
for (const id of USERNAME_IDS) {
  const tag = inputTagWithId(id);
  ok('input#' + id + ' existe', !!tag);
  for (const attr of TRIO) {
    ok('input#' + id + ' tiene ' + attr, !!tag && tag.indexOf(attr) !== -1);
  }
}

// ---------- 2. El trío sigue en el campo de login (regresión) ----------
const loginTag = inputTagWithId('emailInput');
ok('input#emailInput existe', !!loginTag);
for (const attr of TRIO) {
  ok('input#emailInput conserva ' + attr, !!loginTag && loginTag.indexOf(attr) !== -1);
}

// ---------- 3. normalizeUsername sigue minúsculas: el atributo es display-only ----------
// El fix es de teclado/display; la normalización (minúsculas) sigue siendo la
// autoridad del valor final. Sin la línea toLowerCase, el fix sería incompleto.
ok('normalizeUsername sigue con toLowerCase (autoridad del valor)',
  /function normalizeUsername\(raw\)[\s\S]{0,300}?\.toLowerCase\(\)/.test(html));

// ---------- 4. Valores exactos (sin variantes como "sentences") ----------
for (const id of USERNAME_IDS) {
  const tag = inputTagWithId(id);
  const m = tag && tag.match(/autocapitalize="([^"]*)"/i);
  ok('input#' + id + ' autocapitalize es exactamente "none" (' + (m ? m[1] : 'sin tag') + ')',
    !!m && m[1] === 'none');
}

console.log(failures ? '\n' + failures + ' FAIL(s)' : '\nALL OK');
process.exit(failures ? 1 : 0);
