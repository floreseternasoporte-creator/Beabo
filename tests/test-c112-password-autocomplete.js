// C112: 4 campos de contraseña de CREACIÓN (regPassword, regPasswordConfirm,
// settings-account-password, settings-account-password-confirm) no tenían
// atributo autocomplete. Sin autocomplete="new-password", el gestor de
// contraseñas no ofrece generar contraseñas seguras ni sugiere creación, y
// puede ofrecer rellenar una contraseña guardada existente en un campo de
// "crear contraseña". Los otros 5 password inputs ya tenían current-password
// o new-password según el flujo; el fix alinea los 4 restantes.
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

// ---------- 1. Los 4 campos de creación tienen new-password ----------
const NEW_PW_IDS = [
  'regPassword',
  'regPasswordConfirm',
  'settings-account-password',
  'settings-account-password-confirm'
];
for (const id of NEW_PW_IDS) {
  const tag = inputTagWithId(id);
  ok('input#' + id + ' existe', !!tag);
  ok('input#' + id + ' tiene autocomplete="new-password"',
    !!tag && /autocomplete="new-password"/i.test(tag));
}

// ---------- 2. Ningún password input queda sin autocomplete ----------
const pwTags = html.match(/<input\b[^>]*\btype="password"[^>]*>/gi) || [];
ok('hay password inputs (' + pwTags.length + ')', pwTags.length >= 9);
const sinAutocomplete = pwTags.filter(t => !/\bautocomplete\s*=\s*"[^"]+"/i.test(t));
ok('0 password inputs sin autocomplete (quedan ' + sinAutocomplete.length + ')',
  sinAutocomplete.length === 0);

// ---------- 3. Tokens válidos: solo current-password / new-password / one-time-code ----------
const bad = pwTags.filter(t => {
  const m = t.match(/\bautocomplete\s*=\s*"([^"]+)"/i);
  return m && !/^(current-password|new-password|one-time-code)$/.test(m[1]);
});
ok('tokens autocomplete válidos en passwords (' + bad.length + ' inválidos)', bad.length === 0);

console.log(failures ? '\n' + failures + ' FAIL(s)' : '\nALL OK');
process.exit(failures ? 1 : 0);
