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
// - <a target="_blank"> ×8: TODOS con rel="noopener" (1 además noreferrer; C220: +1 baroL1Link runtime).
//   window.open(u,'_blank',...) ×4: TODOS con feature 'noopener'. Sin leads.
// - Ceros documentados (familias de navegación nunca auditadas): ping=0,
//   <object>/<embed>=0, window.opener=0, document.domain=0, <base>=0,
//   meta http-equiv=0, fetch credentials:=0 (default same-origin en todo el
//   árbol), mode:'no-cors' ×1 (sonda anti-adblock a favicon de la red de
//   anuncios, intencional), <form> ×2 (authForm + baro-form: sin action + preventDefault
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

// C240-L3 (2026-09-29): +1 inputmode="numeric" en #dl3-goal-input (meta del
// host, campo de diamantes: type=number min=1 max=1000000; semantica correcta).
// C246 (2026-10-03): el bloque de vivos dl1/dl2/dl3 y Drex Studio se eliminaron
// (Fase 3 / C240) → el inventario bajó de 17 a 15. Mismos valores válidos.
// Nuevo inventario: 15, todos con valor valido.
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
// C246 (2026-10-03): 13→8 — los 5 "off" de Drex Studio/directo
// (dswout-rtmp, dswout-rtmpkey, drex-live-video-url, host/viewer chat) se
// fueron con la eliminación de Fase 3; quedan solo buscadores y chats.
tcase('autocomplete="off" residual: 8, todos en search/chat/stream (nada de identidad)', () => {
  const tags = html.match(/<[^>]*autocomplete="off"[^>]*>/g) || [];
  if (tags.length !== 8) return false;
  return tags.every(t =>
    /enterkeyhint="search"|fiesta-chat-input|fiesta-games-search|baro-input|gif-search-input|sticker-search|settings-search-input|onb-country-search|settings-country-search/.test(t) &&
    !/regUsername|regPassword|emailInput|recoveryCodeInput|twofactor/i.test(t));
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
tcase('target="_blank": 8 anclas, TODAS con rel noopener (C220: +1 baroL1Link runtime, con noopener)', () => {
  const tags = html.match(/<a [^>]*target="_blank"[^>]*>/g) || [];
  return tags.length === 8 && tags.every(t => /rel="[^"]*noopener/.test(t));
});
tcase("window.open(...,'_blank',...): 7, TODOS con feature 'noopener'", () => {
  const noopenerCalls = (html.match(/,'_blank','noopener'\)/g) || []).length;
  return noopenerCalls === 7;
});
tcase("a.target='_blank' programático: 1 (saveCarouselPhoto, descarga vía blob + fallback con opener nulo)", () =>
  count(/\.target = '_blank'/g, html) === 1 &&
  /function saveCarouselPhoto\(\)[\s\S]{0,2400}\.target = '_blank'/.test(html) &&
  /function saveCarouselPhoto\(\)[\s\S]{0,2400}a\.download = /.test(html) &&
  /function saveCarouselPhoto\(\)[\s\S]{0,2400}getSafeMediaUrlRaw\(url\)/.test(html) &&
  /function saveCarouselPhoto\(\)[\s\S]{0,2400}URL\.createObjectURL\(await res\.blob\(\)\)/.test(html) &&
  /function saveCarouselPhoto\(\)[\s\S]{0,2400}new AbortController\(\)/.test(html) &&
  /function saveCarouselPhoto\(\)[\s\S]{0,2400}window\.open\(safeUrl,'_blank','noopener'\)/.test(html));

// ---- 5. Ceros de familias de navegación nunca auditadas ----
tcase('ping=: 0 (sin hyperlink auditing)', () => count(/ping=/g, html) === 0);
tcase('<object>/<embed>: 0', () => count(/<object|<embed/g, html) === 0);
tcase('window.opener: 0 (sin lectura inversa de tabnabbing)', () => count(/window\.opener/g, html) === 0);
tcase('document.domain: 0', () => count(/document\.domain/g, html) === 0);
tcase('<base: 0', () => count(/<base[\s>]/g, html) === 0);
tcase('meta http-equiv: 0', () => count(/http-equiv/g, html) === 0);
// C246 (2026-10-03): el contrato ya no es "cero credentials:", sino "ningún
// fetch envía credenciales": los 2 únicos usos son credentials:'omit'
// deliberados (version.json del updater y la sonda de pagos drexPayNetDiag).
tcase("fetch credentials:: nunca 'include'; los únicos 2 son 'omit' deliberados", () =>
  count(/credentials:\s*'include'/g, html) === 0 &&
  count(/credentials:\s*'omit'/g, html) === 2);
tcase("mode:'no-cors': 2 (sonda anti-adblock a favicon + sonda de pagos C244)", () =>
  count(/mode: 'no-cors'/g, html) === 2 &&
  /highrevenueformat\.com\/favicon\.ico/.test(html));
tcase('<form: 2 (authForm + baro-form, ambas sin action + preventDefault)', () =>
  count(/<form/g, html) === 2 &&
  /<form id="authForm"[^>]*>/.test(html) && !/id="authForm"[^>]*action=/.test(html) &&
  /authForm\.addEventListener\('submit', e => \{\s*e\.preventDefault\(\)/.test(html) &&
  /<form id="baro-form"[^>]*onsubmit="return baroSubmit\(event\)"/.test(html));

process.exit(failures ? 1 : 0);
