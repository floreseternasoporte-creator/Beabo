// C134: familia NUEVA "pistas de entrada móvil" (inputmode + autocomplete repo-wide)
// + re-verifies: sendBeacon/keepalive (flujos no-terminación), target=_blank
// sin noopener, y ceros de familias de navegación nunca auditadas.
//
// AUDITORÍA (2026-09-24, HEAD 15505ea, hit por hit, repo-wide):
// - inputmode ×15 en index.html (0 en drex-cloud.js y demás .js): todos con
//   valor válido y semántica acorde al campo. LEAD 1: twofactor-challenge-input
//   declaraba inputmode="text" maxlength="12" en el HTML estático (el JS lo
//   corregía a numeric/6 al mostrar la vista, pero el markup mentía) →
//   alineado a numeric/6.
// - autocomplete: 9× "off" → 8 correctos (6 search/chat + 2 search de país) y
//   2 leads: twofactor-challenge-input con off → "one-time-code" (autofill de
//   OTP del SO en iOS/Android); regUsername con off → "username" (pareja de
//   new-password en regPassword para gestores de contraseñas).
// - sendBeacon: 1 único uso (drex-cloud.js relBeaconSend, 0 en index.html):
//   con guarda typeof + try/catch, nunca lanza; flujos pagehide (terminación)
//   + visibilitychange-hidden + setInterval por lotes + lote lleno
//   (no-terminación); endpoint DREX_ERROR_INGEST_URL sin desplegar → respaldo
//   local. Sin leads.
// - fetch keepalive:true: 1 único hit (announceMusicOnDiscord → webhook de
//   Discord, fire-and-forget con campos sanitizados safe() + URL https
//   validada). Uso legítimo, sin leads.
// - <a target="_blank"> ×7: TODOS con rel="noopener" (1 además noreferrer).
//   window.open(u,'_blank',...) ×4: TODOS con feature 'noopener'. Sin leads.
// - Ceros documentados (familias de navegación nunca auditadas): ping=0,
//   <object>/<embed>=0, window.opener=0, document.domain=0, <base>=0,
//   meta http-equiv=0, fetch credentials:=0 (default same-origin en todo el
//   árbol), mode:'no-cors' ×1 (sonda anti-adblock a favicon de la red de
//   anuncios, intencional), <form> ×1 (authForm: sin action + preventDefault
//   en el submit → sin envío externo).
'use strict';
const fs = require('fs');
const path = require('path');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

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
// Devuelve el valor del atributo `attr` en el primer tag que contenga id="id".
function attrOf(id, attr) {
  const re = new RegExp('<[^>]*\\bid="' + id + '"[^>]*>', 'g');
  const m = html.match(re);
  if (!m || !m.length) return null;
  const a = new RegExp('\\b' + attr + '="([^"]*)"').exec(m[0]);
  return a ? a[1] : undefined;
}

// ---- 1. inputmode: inventario completo (15 hits) ----
tcase('inputmode: 15 ocurrencias en index.html', () =>
  count(/inputmode/g, html) === 15);
tcase('inputmode válidos: solo email|numeric|text|url (estáticos + setAttribute)', () => {
  const dq = (html.match(/inputmode="([^"]*)"/g) || []).map(s => s.slice(11, -1));
  const sq = (html.match(/setAttribute\('inputmode', '([^']*)'\)/g) || []).map(s => s.slice(27, -2));
  const vals = dq.concat(sq);
  return vals.length === 15 && vals.every(v => ['email', 'numeric', 'text', 'url'].includes(v));
});
tcase('emailInput: inputmode=email', () => attrOf('emailInput', 'inputmode') === 'email');
tcase('recoveryCodeInput: inputmode=numeric (one-time-code)', () =>
  attrOf('recoveryCodeInput', 'inputmode') === 'numeric' &&
  attrOf('recoveryCodeInput', 'autocomplete') === 'one-time-code');
tcase('regVerifyCode: inputmode=numeric (one-time-code)', () =>
  attrOf('regVerifyCode', 'inputmode') === 'numeric' &&
  attrOf('regVerifyCode', 'autocomplete') === 'one-time-code');
tcase('parental-link-code-input: inputmode=numeric', () =>
  attrOf('parental-link-code-input', 'inputmode') === 'numeric');
tcase('LEAD 1: twofactor-challenge-input inputmode=numeric (era text en estático)', () =>
  attrOf('twofactor-challenge-input', 'inputmode') === 'numeric');
tcase('LEAD 1: twofactor-challenge-input maxlength=6 (era 12 en estático)', () =>
  attrOf('twofactor-challenge-input', 'maxlength') === '6');
tcase('LEAD 2: twofactor-challenge-input autocomplete=one-time-code (era off)', () =>
  attrOf('twofactor-challenge-input', 'autocomplete') === 'one-time-code');
tcase('twofactor-setup-code: inputmode=numeric', () =>
  attrOf('twofactor-setup-code', 'inputmode') === 'numeric');
tcase('twofactor-disable-code: inputmode=numeric', () =>
  attrOf('twofactor-disable-code', 'inputmode') === 'numeric');
tcase('cpw-code: inputmode=numeric (one-time-code)', () =>
  attrOf('cpw-code', 'inputmode') === 'numeric' &&
  attrOf('cpw-code', 'autocomplete') === 'one-time-code');
tcase('settings-showcase-u-0/1/2: inputmode=url', () =>
  attrOf('settings-showcase-u-0', 'inputmode') === 'url' &&
  attrOf('settings-showcase-u-1', 'inputmode') === 'url' &&
  attrOf('settings-showcase-u-2', 'inputmode') === 'url');
tcase('toggleMfaBackupMode: modo respaldo=text/24, modo TOTP=numeric/6 (×3 sets)', () =>
  /input\.setAttribute\('inputmode', 'text'\); input\.setAttribute\('maxlength', '24'\)/.test(html) &&
  count(/setAttribute\('inputmode', 'numeric'\)/g, html) === 3);

// ---- 2. autocomplete: leads + "off" residual justificado ----
tcase('LEAD 3: regUsername autocomplete=username (era off)', () =>
  attrOf('regUsername', 'autocomplete') === 'username');
tcase('regPassword: autocomplete=new-password (pareja de regUsername)', () =>
  attrOf('regPassword', 'autocomplete') === 'new-password');
tcase('autocomplete="off" residual: 7, todos en search/chat (nada de identidad)', () => {
  const tags = html.match(/<[^>]*autocomplete="off"[^>]*>/g) || [];
  if (tags.length !== 7) return false;
  return tags.every(t =>
    /enterkeyhint="search"|fiesta-chat-input/.test(t) &&
    !/password|username|email|twofactor|code/i.test(t.replace('fiesta-chat-input', '')));
});
tcase('new-password: 7 en flujos de creación/cambio (C112 intacto)', () =>
  count(/autocomplete="new-password"/g, html) === 7);
tcase('emailInput: autocomplete=username (login email-o-usuario)', () =>
  attrOf('emailInput', 'autocomplete') === 'username');

// ---- 3. sendBeacon / keepalive (flujos no-terminación) ----
tcase('sendBeacon: 0 en index.html (el único uso vive en drex-cloud.js relBeaconSend)', () =>
  count(/sendBeacon/g, html) === 0);
tcase('keepalive: 1 único hit (announceMusicOnDiscord, webhook Discord)', () =>
  count(/keepalive: true/g, html) === 1 &&
  /function announceMusicOnDiscord[\s\S]{0,2500}keepalive: true/.test(html));

// ---- 4. target=_blank / window.open: sin tabnabbing ----
tcase('target="_blank": 7 anclas, TODAS con rel noopener', () => {
  const tags = html.match(/<a [^>]*target="_blank"[^>]*>/g) || [];
  return tags.length === 7 && tags.every(t => /rel="[^"]*noopener/.test(t));
});
tcase("window.open(...,'_blank',...): 6, TODOS con feature 'noopener'", () => {
  const noopenerCalls = (html.match(/,'_blank','noopener'\)/g) || []).length;
  return noopenerCalls === 6;
});
tcase("a.target='_blank' programático: 1 (saveCarouselPhoto, download+getSafeMediaUrlRaw → sin navegación, sin opener)", () =>
  count(/\.target = '_blank'/g, html) === 1 &&
  /function saveCarouselPhoto\(\)[\s\S]{0,600}\.target = '_blank'/.test(html) &&
  /function saveCarouselPhoto\(\)[\s\S]{0,600}a\.download = /.test(html) &&
  /function saveCarouselPhoto\(\)[\s\S]{0,600}getSafeMediaUrlRaw\(url\)/.test(html));

// ---- 5. Ceros de familias de navegación nunca auditadas ----
tcase('ping=: 0 (sin hyperlink auditing)', () => count(/ping=/g, html) === 0);
tcase('<object>/<embed>: 0', () => count(/<object|<embed/g, html) === 0);
tcase('window.opener: 0 (sin lectura inversa de tabnabbing)', () => count(/window\.opener/g, html) === 0);
tcase('document.domain: 0', () => count(/document\.domain/g, html) === 0);
tcase('<base: 0', () => count(/<base[\s>]/g, html) === 0);
tcase('meta http-equiv: 0', () => count(/http-equiv/g, html) === 0);
tcase("fetch credentials:: 0 (default same-origin en todo el árbol)", () =>
  count(/credentials:\s*['"]/, html) === 0);
tcase("mode:'no-cors': 1 (sonda anti-adblock intencional a favicon)", () =>
  count(/mode: 'no-cors'/g, html) === 1 &&
  /highrevenueformat\.com\/favicon\.ico/.test(html));
tcase('<form: 1 (authForm sin action + preventDefault en submit)', () =>
  count(/<form/g, html) === 1 &&
  /<form id="authForm"[^>]*>/.test(html) && !/id="authForm"[^>]*action=/.test(html) &&
  /authForm\.addEventListener\('submit', e => \{\s*e\.preventDefault\(\)/.test(html));

process.exit(failures ? 1 : 0);
