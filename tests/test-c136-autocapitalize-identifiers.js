// C136: familia NUEVA "autocapitalize/autocorrect/spellcheck repo-wide"
// + barridos pattern-en-TOTP, inputmode-en-textarea y select-nativos.
//
// AUDITORÍA (2026-09-24, base 2abec136d1728db4b335da00279dae9ebdb6a163,
// hit por hit, repo-wide, index.html + *.js):
//
// 1. autocapitalize/autocorrect/spellcheck: SOLO 4 inputs los declaraban
//    (emailInput, regUsername, settings-username: trio "none/off/false";
//    twofactor-challenge-input: autocapitalize="characters" + spellcheck=false,
//    DELIBERADO: el modo respaldo (toggleMfaBackupMode) cambia ese input a
//    inputmode=text con placeholder XXXX-XXXX -> CAPS es lo correcto).
//    LEADS (4): regEmail (type=email, registro) y settings-showcase-u-0/1/2
//    (type=url, inputmode=url) NO declaraban el trio. iOS capitaliza la
//    primera letra al teclear por defecto: una URL con mayuscula queda rota
//    y un correo con mayuscula fricciona el registro. -> trio en los 4.
// 2. password fields (type=password): iOS/Android suprimen autocorrect y
//    autocapitalize en campos seguros por defecto. Sin leads (documentado).
// 3. type=number / inputmode=numeric / type=tel: teclado numerico, sin
//    teclas de letras -> autocapitalize inerte. Sin leads.
// 4. Campos de texto natural (chat, composer, busquedas, titulos, bio,
//    ciudad, pais): autocorrect/capitalize DEBEN quedarse (decision de
//    producto). Sin leads.
// 5. pattern="[0-9]*" x2 SOLO en recoveryCodeInput y regVerifyCode. NINGUNO
//    de estos inputs vive dentro de <form> (el unico form es #authForm),
//    asi que pattern no valida nada; y todos los OTP ya comparten
//    inputmode="numeric" (C134/C115), asi que el teclado movil ya es
//    consistente. Agregar pattern al resto seria cambio cosmetico sin
//    efecto visible -> auditado, SIN CAMBIO (documentado aqui).
// 6. <textarea> x14 (13 estaticos + 1 en string JS px-correction-text):
//    TODOS son texto libre (bio, comentarios, mensajes, letra, descripciones,
//    reportes, apelacion). Ninguno pide entrada numerica/identificador.
//    chat-edit-input ya tiene enterkeyhint=done + onkeydown honesto.
//    -> inputmode en textarea: auditado, SIN LEADS.
// 7. <select> nativos x12: uso consistente en toda la app (idiomas,
//    audiencia, grupo, orden, limite, permisos, sort comentarios, genero).
//    Los pickers custom (cumpleanos readonly x6, pais con buscador) son
//    diseno deliberado; reemplazarlos por selects seria decision de
//    producto. -> auditado, SIN CAMBIO.
'use strict';
const fs = require('fs');
const path = require('path');

function pickTarget(def, flag) {
  const a = process.argv.find(x => x.startsWith(flag + '='));
  return a ? a.slice(flag.length + 1) : path.join(__dirname, '..', def);
}
const htmlPath = pickTarget('index.html', '--target');
const html = fs.readFileSync(htmlPath, 'utf8');
const isBase = process.argv.includes('--base');

let failures = 0;
function ok(name, cond) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name); }
}
function tcase(name, fn) {
  try { ok(name, fn()); }
  catch (e) { failures++; console.error('FAIL - ' + name + ' (throw: ' + (e && e.message) + ')'); }
}
function count(re, src) { return (src.match(re) || []).length; }
function tagOf(src, id) {
  const i = src.indexOf('id="' + id + '"');
  if (i < 0) return null;
  const lt = src.lastIndexOf('<', i);
  const gt = src.indexOf('>', i);
  if (lt < 0 || gt < 0) return null;
  return src.slice(lt, gt + 1);
}
function hasTrio(src, id) {
  const t = tagOf(src, id);
  return t !== null &&
    t.indexOf('autocapitalize="none"') >= 0 &&
    t.indexOf('autocorrect="off"') >= 0 &&
    t.indexOf('spellcheck="false"') >= 0;
}

// ---- 1. LEADS: el trio en los 4 inputs identificadores ----
tcase('LEAD: regEmail con autocapitalize=none + autocorrect=off + spellcheck=false', () =>
  hasTrio(html, 'regEmail'));
for (let i = 0; i < 3; i++) {
  tcase('LEAD: settings-showcase-u-' + i + ' (URL) con el trio autocapitalize/autocorrect/spellcheck', () =>
    hasTrio(html, 'settings-showcase-u-' + i));
}

// ---- 2. Sin regresion: los que ya lo tenian lo conservan ----
tcase('sin regresion: emailInput / regUsername / settings-username conservan el trio', () =>
  hasTrio(html, 'emailInput') && hasTrio(html, 'regUsername') && hasTrio(html, 'settings-username'));
tcase('deliberado: twofactor-challenge-input conserva autocapitalize=characters (modo respaldo XXXX-XXXX)', () => {
  const t = tagOf(html, 'twofactor-challenge-input');
  return t !== null && t.indexOf('autocapitalize="characters"') >= 0 && t.indexOf('spellcheck="false"') >= 0;
});

// ---- 3. pattern en TOTP: inventario cerrado en 2, sin cambio ----
tcase('pattern="[0-9]*": exactamente 2 ocurrencias (recoveryCodeInput, regVerifyCode)', () => {
  if (count(/pattern="\[0-9\]\*"/g, html) !== 2) return false;
  const t1 = tagOf(html, 'recoveryCodeInput') || '';
  const t2 = tagOf(html, 'regVerifyCode') || '';
  return t1.indexOf('pattern="[0-9]*"') >= 0 && t2.indexOf('pattern="[0-9]*"') >= 0;
});
tcase('pattern inerte: ningun input OTP vive dentro de <form> (unico form = authForm)', () => {
  const formIdx = html.indexOf('<form');
  if (formIdx < 0) return false;
  const formEnd = html.indexOf('</form>', formIdx);
  const formHtml = html.slice(formIdx, formEnd);
  const otpIds = ['recoveryCodeInput', 'regVerifyCode', 'twofactor-challenge-input',
    'twofactor-setup-code', 'twofactor-disable-code', 'cpw-code', 'parental-link-code-input'];
  return otpIds.every(id => formHtml.indexOf('id="' + id + '"') < 0);
});
tcase('teclado movil consistente: todos los OTP conservan inputmode=numeric', () => {
  const otpIds = ['recoveryCodeInput', 'regVerifyCode', 'twofactor-challenge-input',
    'twofactor-setup-code', 'twofactor-disable-code', 'cpw-code', 'parental-link-code-input'];
  return otpIds.every(id => {
    const t = tagOf(html, id);
    return t !== null && t.indexOf('inputmode="numeric"') >= 0;
  });
});

// ---- 4. textarea: inventario x14, ninguno con inputmode (sin leads) ----
tcase('textarea: 14 ocurrencias y ninguna declara inputmode', () => {
  const n = count(/<textarea/g, html);
  if (n !== 14) return false;
  const tags = html.match(/<textarea[\s\S]*?>/g) || [];
  return tags.length === 14 && tags.every(t => t.indexOf('inputmode=') < 0);
});
tcase('textarea: chat-edit-input conserva enterkeyhint=done + onkeydown honesto', () => {
  const t = tagOf(html, 'chat-edit-input');
  return t !== null && t.indexOf('enterkeyhint="done"') >= 0 &&
    t.indexOf('saveEditedChatMessage()') >= 0;
});

// ---- 5. select nativos: inventario x12, uso consistente ----
tcase('select: 12 <select nativos (inventario cerrado)', () =>
  count(/<select[\s>]/g, html) === 12);

// ---- 6. falla-en-base: contra HEAD los 4 leads carecen del trio ----
tcase('base: en HEAD (sin el fix) los 4 leads NO tienen el trio', () => {
  if (!isBase) return true; // solo se evalua con --base
  return !hasTrio(html, 'regEmail') &&
    !hasTrio(html, 'settings-showcase-u-0') &&
    !hasTrio(html, 'settings-showcase-u-1') &&
    !hasTrio(html, 'settings-showcase-u-2');
});

console.log('---');
console.log(failures === 0 ? 'C136: ALL PASS' : 'C136: ' + failures + ' FAIL');
process.exit(failures === 0 ? 0 : 1);
