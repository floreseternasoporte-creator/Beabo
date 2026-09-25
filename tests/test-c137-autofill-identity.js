// C137: familia NUEVA "autocomplete tokens repo-wide en campos de identidad/contacto"
// + "enterkeyhint en <textarea>" + "name attributes en inputs".
//
// AUDITORIA (2026-09-24, base 22746ce1292594a3dd08e2059bd4a3ba47453810,
// hit por hit, repo-wide, index.html + *.js):
//
// 1. autocomplete: 30 declarados (29 en index.html + 1 en recovery-codes.js).
//    LEADS (4, corregidos):
//    - regEmail (type=email, flujo de registro) SIN autocomplete -> "email"
//      (iOS/Android no ofrecian autollenado del correo en el registro).
//    - regFirstName ("Nombre", registro) SIN autocomplete -> "given-name".
//    - phone-input (type=tel) SIN autocomplete -> "tel" (pre-sonda del brief
//      C137 confirmada en el codigo).
//    - settings-username (cambio de usuario) SIN autocomplete -> "username"
//      (emailInput y regUsername ya lo declaraban; este era el hueco).
// 2. name attributes: CERO inputs lo declaraban en todo el arbol. Los password
//    managers (1Password/Bitwarden/iCloud Keychain) usan name+autocomplete+id
//    como senales; se agrego name a los 4 campos de identidad corregidos
//    (name="email" / "given-name" / "tel" / "username", espejo del token).
//    Sin form que haga submit (el unico form es #authForm, submit por JS),
//    name no altera ningun flujo -> cambio seguro y acotado.
// 3. Inventario de tokens (regresion, debe seguir igual):
//    username x3 (emailInput, regUsername, settings-username),
//    current-password x2 (passwordInput, twofactor-disable-pw),
//    new-password x7 (regPassword, regPasswordConfirm, cpw-new, cpw-confirm,
//      settings-account-password, settings-account-password-confirm,
//      recoveryNewPassword),
//    one-time-code x7 (recoveryCodeInput, regVerifyCode,
//      twofactor-challenge-input, twofactor-setup-code, twofactor-disable-code,
//      cpw-code + recovery-regen-code en recovery-codes.js),
//    url x3 (settings-showcase-u-0/1/2), address-level2 x1 (settings-city),
//    email x2 (recoveryEmailInput + regEmail), off x8 (buscadores + chats + baro:
//      fiesta-chat-input, fiesta-games-search, gif-search-input,
//      onb-country-search, settings-country-search, settings-search-input,
//      sticker-search).
// 4. Sin leads (documentado): settings-account-email (readonly+disabled ->
//    autofill inerte), pickers de cumpleanos readonly x6 (regBdDay/Month/Year,
//    settings-account-birthday-day/month/year), resto de inputs sin token son
//    busquedas, chats, titulos/contenido o file inputs (no identidad).
// 5. enterkeyhint en <textarea>: 14 textareas (regex multiline, igual que C136).
//    Solo chat-edit-input tiene accion de Enter (onkeydown Enter->save) y ya
//    declara enterkeyhint="done" (honesto, C135/C136). Los otros 13 son texto
//    libre multiline (Enter = salto de linea): agregar enterkeyhint seria UI
//    mentirosa (leccion C135). -> auditado hit por hit, SIN CAMBIO.
'use strict';
const fs = require('fs');
const path = require('path');

function pickTarget(def, flag) {
  const a = process.argv.find(x => x.startsWith(flag + '='));
  return a ? a.slice(flag.length + 1) : path.join(__dirname, '..', def);
}
const htmlPath = pickTarget('index.html', '--target');
const html = fs.readFileSync(htmlPath, 'utf8');
const repoRoot = path.join(__dirname, '..');
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
// Tag del input con id dado (single-line; ids unicos en el arbol).
function inputTag(id) {
  const m = html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'));
  return m ? m[0] : null;
}
function hasAttr(tag, attr, val) {
  return tag !== null && tag.indexOf(attr + '="' + val + '"') >= 0;
}

// ---- 1. Los 4 leads: autocomplete + name ----
tcase('lead: regEmail declara autocomplete="email" + name="email"', () => {
  const t = inputTag('regEmail');
  return hasAttr(t, 'autocomplete', 'email') && hasAttr(t, 'name', 'email');
});
tcase('lead: regFirstName declara autocomplete="given-name" + name="given-name"', () => {
  const t = inputTag('regFirstName');
  return hasAttr(t, 'autocomplete', 'given-name') && hasAttr(t, 'name', 'given-name');
});
tcase('lead: phone-input declara autocomplete="tel" + name="tel"', () => {
  const t = inputTag('phone-input');
  return hasAttr(t, 'autocomplete', 'tel') && hasAttr(t, 'name', 'tel');
});
tcase('lead: settings-username declara autocomplete="username" + name="username"', () => {
  const t = inputTag('settings-username');
  return hasAttr(t, 'autocomplete', 'username') && hasAttr(t, 'name', 'username');
});

// ---- 2. Inventario de tokens (regresion) ----
tcase('username x3: emailInput, regUsername, settings-username', () => {
  const ids = ['emailInput', 'regUsername', 'settings-username'];
  return ids.every(id => hasAttr(inputTag(id), 'autocomplete', 'username')) &&
    count(/autocomplete="username"/g, html) === 3;
});
tcase('current-password x2: passwordInput, twofactor-disable-pw', () =>
  count(/autocomplete="current-password"/g, html) === 2 &&
  hasAttr(inputTag('passwordInput'), 'autocomplete', 'current-password') &&
  hasAttr(inputTag('twofactor-disable-pw'), 'autocomplete', 'current-password'));
tcase('new-password x7 (inventario cerrado)', () => {
  const ids = ['regPassword', 'regPasswordConfirm', 'cpw-new', 'cpw-confirm',
    'settings-account-password', 'settings-account-password-confirm', 'recoveryNewPassword'];
  return ids.every(id => hasAttr(inputTag(id), 'autocomplete', 'new-password')) &&
    count(/autocomplete="new-password"/g, html) === 7;
});
tcase('one-time-code x6 en index.html + recovery-regen-code en recovery-codes.js', () => {
  const ids = ['recoveryCodeInput', 'regVerifyCode', 'twofactor-challenge-input',
    'twofactor-setup-code', 'twofactor-disable-code', 'cpw-code'];
  const jsOk = fs.readFileSync(path.join(repoRoot, 'recovery-codes.js'), 'utf8')
    .indexOf('autocomplete="one-time-code"') >= 0;
  const othersClean = fs.readdirSync(repoRoot)
    .filter(f => f.endsWith('.js') && f !== 'recovery-codes.js')
    .every(f => fs.readFileSync(path.join(repoRoot, f), 'utf8').indexOf('autocomplete=') < 0);
  return ids.every(id => hasAttr(inputTag(id), 'autocomplete', 'one-time-code')) &&
    count(/autocomplete="one-time-code"/g, html) === 6 && jsOk && othersClean;
});
tcase('url x3: settings-showcase-u-0/1/2', () =>
  count(/autocomplete="url"/g, html) === 3 &&
  ['settings-showcase-u-0', 'settings-showcase-u-1', 'settings-showcase-u-2']
    .every(id => hasAttr(inputTag(id), 'autocomplete', 'url')));
tcase('address-level2 x1: settings-city', () =>
  hasAttr(inputTag('settings-city'), 'autocomplete', 'address-level2'));
tcase('email x2: recoveryEmailInput (previo) + regEmail (lead C137)', () =>
  count(/autocomplete="email"/g, html) === 2 &&
  hasAttr(inputTag('recoveryEmailInput'), 'autocomplete', 'email'));
tcase('off x8 en buscadores/chats (inventario cerrado)', () => {
  const ids = ['fiesta-chat-input', 'fiesta-games-search', 'gif-search-input',
    'onb-country-search', 'settings-country-search', 'settings-search-input', 'sticker-search',
    'baro-input'];
  return ids.every(id => hasAttr(inputTag(id), 'autocomplete', 'off')) &&
    count(/autocomplete="off"/g, html) === 8;
});

// ---- 3. name attributes: solo los 4 campos de identidad ----
tcase('name=: exactamente los 4 campos de identidad (ningun otro input)', () => {
  const tags = html.match(/<input[^>]*>/g) || [];
  const withName = tags.filter(t => /name="/.test(t));
  const ids = withName.map(t => (t.match(/id="([^"]*)"/) || [])[1]).sort();
  return withName.length === 4 &&
    JSON.stringify(ids) === JSON.stringify(['phone-input', 'regEmail', 'regFirstName', 'settings-username']);
});

// ---- 4. Ausencias justificadas (no-leads) ----
tcase('settings-account-email readonly+disabled: sin autocomplete (autofill inerte)', () => {
  const t = inputTag('settings-account-email');
  return t !== null && t.indexOf('readonly') >= 0 && t.indexOf('disabled') >= 0 &&
    t.indexOf('autocomplete=') < 0;
});
tcase('pickers de cumpleanos readonly x6: sin autocomplete', () => {
  const ids = ['regBdDay', 'regBdMonth', 'regBdYear',
    'settings-account-birthday-day', 'settings-account-birthday-month', 'settings-account-birthday-year'];
  return ids.every(id => {
    const t = inputTag(id);
    return t !== null && t.indexOf('readonly') >= 0 && t.indexOf('autocomplete=') < 0;
  });
});

// ---- 5. enterkeyhint en <textarea>: inventario x14, solo chat-edit-input honesto ----
tcase('textarea x15 (regex multiline, igual que C136)', () =>
  count(/<textarea[\s\S]*?>/g, html) === 15);
tcase('textarea: solo chat-edit-input tiene enterkeyhint (done, honesto con onkeydown)', () => {
  const tags = html.match(/<textarea[\s\S]*?>/g) || [];
  const withHint = tags.filter(t => t.indexOf('enterkeyhint=') >= 0);
  const withEnterAction = tags.filter(t => /onkeydown/i.test(t) && t.indexOf('Enter') >= 0);
  const chat = tags.find(t => t.indexOf('id="chat-edit-input"') >= 0) || '';
  return withHint.length === 1 && withEnterAction.length === 1 &&
    withHint[0] === withEnterAction[0] &&
    chat.indexOf('enterkeyhint="done"') >= 0 &&
    chat.indexOf('saveEditedChatMessage()') >= 0;
});
tcase('textarea: comment-input-main / edit-post-textarea / note-input sin Enter->submit (sin hint, no es UI mentirosa)', () => {
  const tags = html.match(/<textarea[\s\S]*?>/g) || [];
  return ['comment-input-main', 'edit-post-textarea', 'note-input'].every(id => {
    const t = tags.find(x => x.indexOf('id="' + id + '"') >= 0);
    return t && t.indexOf('enterkeyhint=') < 0 && t.indexOf('onkeydown') < 0;
  });
});

// ---- 6. falla-en-base: contra HEAD los 4 leads carecen de token y de name ----
tcase('base: en HEAD (sin el fix) los 4 leads NO tienen autocomplete ni name', () => {
  if (!isBase) return true; // solo se evalua con --base
  return ['regEmail', 'regFirstName', 'phone-input', 'settings-username'].every(id => {
    const t = inputTag(id);
    return t !== null && t.indexOf('autocomplete=') < 0 && t.indexOf('name=') < 0;
  });
});

console.log('---');
console.log(failures === 0 ? 'C137: ALL PASS' : 'C137: ' + failures + ' FAIL');
process.exit(failures === 0 ? 0 : 1);
