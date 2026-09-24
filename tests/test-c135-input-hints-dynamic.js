// C135: familia NUEVA "inputs creados dinámicamente por JS" (createElement('input')
// + literales '<input' en .js) + barridos type="number" vs inputmode="numeric"
// y readonly/disabled en flujos sensibles (2FA/MFA/códigos de respaldo).
//
// AUDITORÍA (2026-09-24, HEAD 5af4cdf, hit por hit, repo-wide):
// - document.createElement('input') ×3 (index.html): TODOS son fallbacks de
//   portapapeles (copySerieLink/copyAuthorUsername/copyAuthorProfileLink):
//   input invisible, select(), execCommand('copy'), removeChild() en el mismo
//   tick. Nunca muestran teclado ni reciben foco de usuario → sin hints que
//   auditar. LEAD: ninguno.
// - document.createElement('textarea') ×1 (recovery-codes.js legacyCopy):
//   mismo patrón de fallback invisible. Sin leads.
// - Literales '<input' en .js: EXACTAMENTE 1 en todo el árbol
//   (recovery-codes.js renderRegenerate → 'recovery-regen-code'): es el ÚNICO
//   input real construido por JS, un TOTP de 6 dígitos para confirmar la
//   regeneración de códigos de respaldo. LEADS: autocomplete="off" (el SO no
//   ofrece autofill OTP; C134 ya corrigió su campo hermano estático
//   twofactor-challenge-input con "one-time-code") y sin enterkeyhint.
//   → autocomplete="one-time-code" + enterkeyhint="go".
// - Hermanos estáticos del mismo flujo TOTP (simetría del token):
//   twofactor-setup-code (alta de 2FA) y twofactor-disable-code (baja de 2FA)
//   no declaraban autocomplete ni enterkeyhint → "one-time-code" + "go".
//   twofactor-challenge-input (C134) y recoveryCodeInput/regVerifyCode ya OK.
// - type="number" ×3 (fiesta-max, timer-hours, timer-minutes): numéricos con
//   min/max donde los spinners de escritorio son útiles y el teclado numérico
//   móvil ya aparece por el tipo. NINGÚN type=number en identidad/OTP
//   (esos usan inputmode="numeric"). Sin leads.
// - readonly estático ×7: regBdDay/Month/Year + settings-account-birthday
//   day/month/year (set por picker) + settings-account-email (readonly +
//   disabled, display-only). Ninguno en flujos 2FA/MFA. Sin leads.
// - Doble-submit en flujos sensibles: submitTwoFactorChallenge deshabilita
//   input+btn antes del verify y los reactiva en TODOS los caminos de error
//   (legacy then/catch, nativo catch, reintento por timer); confirmRegenerate
//   usa confirm() NATIVO (bloqueante) antes del async → sin ventana de
//   doble-envío. Sin leads.
// - Códigos de respaldo revelados: tarjetas con select-all + botones
//   "Copiar todos" y "Descargar .txt" (copyText con fallback execCommand) →
//   no hay readonly-sin-copia. Sin leads.
'use strict';
const fs = require('fs');
const path = require('path');

function pickTarget(def, flag) {
  const a = process.argv.find(x => x.startsWith(flag + '='));
  return a ? a.slice(flag.length + 1) : path.join(__dirname, '..', def);
}
const htmlPath = pickTarget('index.html', '--target');
const rcPath = pickTarget('recovery-codes.js', '--rc-target');
const html = fs.readFileSync(htmlPath, 'utf8');
const rc = fs.readFileSync(rcPath, 'utf8');
const isBase = process.argv.includes('--base');
const repoRoot = path.join(__dirname, '..');

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
function attrOf(src, id, attr) {
  const tagRe = new RegExp('<[^>]*\\bid="' + id + '"[^>]*>', 'g');
  const m = src.match(tagRe);
  if (!m || !m.length) return null;
  const a = new RegExp('\\b' + attr + '="([^"]*)"').exec(m[0]);
  return a ? a[1] : undefined;
}

// ---- 1. createElement('input')/('textarea'): inventario y contexto ----
tcase('createElement input: 3 ocurrencias en index.html', () =>
  count(/createElement\(['"]input['"]\)/g, html) === 3);
tcase('createElement input: las 3 viven en fallbacks de portapapeles (execCommand copy + removeChild)', () => {
  const lines = html.split('\n');
  const idxs = [];
  lines.forEach((l, i) => { if (/createElement\(['"]input['"]\)/.test(l)) idxs.push(i); });
  if (idxs.length !== 3) return false;
  return idxs.every(i => {
    const win = lines.slice(Math.max(0, i - 14), i + 8).join('\n');
    return /execCommand\(['"]copy['"]\)/.test(win) && /removeChild/.test(win) && /\.select\(\)/.test(win);
  });
});
tcase('createElement textarea: 1 ocurrencia (recovery-codes.js legacyCopy)', () =>
  count(/createElement\(['"]textarea['"]\)/g, rc) === 1);

// ---- 2. literales '<input' en JS: el único input real construido por JS ----
tcase("'<input' literal en .js: exactamente 1 (recovery-regen-code)", () => {
  const files = ['recovery-codes.js', 'drex-cloud.js', 'drex-sheet.js', 'drex-i18n.js',
    'fiesta-games-data.js', 'drex-data-export.js', 'drex-rec-engine.js'];
  let hits = [];
  for (const f of files) {
    const p = path.join(repoRoot, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const m = src.match(/['"]<input\b[^"']*id="([^"]*)"/g) || [];
    m.forEach(x => hits.push(f + ' :: ' + x.slice(0, 60)));
  }
  return hits.length === 1 && hits[0].startsWith('recovery-codes.js') &&
    hits[0].includes('recovery-regen-code');
});
tcase('LEAD: recovery-regen-code autocomplete=one-time-code (era off)', () => {
  const line = rc.split('\n').find(l => l.indexOf('recovery-regen-code') >= 0) || '';
  return line.indexOf('autocomplete="one-time-code"') >= 0;
});
tcase('LEAD: recovery-regen-code enterkeyhint=go', () => {
  const line = rc.split('\n').find(l => l.indexOf('recovery-regen-code') >= 0) || '';
  return line.indexOf('enterkeyhint="go"') >= 0;
});

// ---- 3. hermanos TOTP estáticos: mismo token ----
tcase('LEAD: twofactor-setup-code autocomplete=one-time-code + enterkeyhint=go', () =>
  attrOf(html, 'twofactor-setup-code', 'autocomplete') === 'one-time-code' &&
  attrOf(html, 'twofactor-setup-code', 'enterkeyhint') === 'go');
tcase('LEAD: twofactor-disable-code autocomplete=one-time-code + enterkeyhint=go', () =>
  attrOf(html, 'twofactor-disable-code', 'autocomplete') === 'one-time-code' &&
  attrOf(html, 'twofactor-disable-code', 'enterkeyhint') === 'go');
tcase('enterkeyhint honesto: setup/disable-code con onkeydown Enter → submit', () =>
  (attrOf(html, 'twofactor-setup-code', 'onkeydown') || '').indexOf('confirmTwoFactorSetup()') >= 0 &&
  (attrOf(html, 'twofactor-disable-code', 'onkeydown') || '').indexOf('confirmDisableTwoFactor()') >= 0);
tcase('enterkeyhint honesto: recovery-regen-code con onkeydown Enter → confirmRegenerate', () => {
  const line = rc.split('\n').find(l => l.indexOf('recovery-regen-code') >= 0) || '';
  return line.indexOf('DrexRecoveryCodes.confirmRegenerate()') >= 0 &&
    line.indexOf("event.key===") >= 0;
});
tcase('twofactor-challenge-input (C134) sigue intacto', () =>
  attrOf(html, 'twofactor-challenge-input', 'autocomplete') === 'one-time-code' &&
  attrOf(html, 'twofactor-challenge-input', 'inputmode') === 'numeric' &&
  attrOf(html, 'twofactor-challenge-input', 'maxlength') === '6');

// ---- 4. type="number": inventario cerrado ----
tcase('type="number": exactamente 3 (fiesta-max, timer-hours, timer-minutes)', () => {
  const tags = html.match(/<input[^>]*type="number"[^>]*>/g) || [];
  if (tags.length !== 3) return false;
  const ids = tags.map(t => /id="([^"]*)"/.exec(t)[1]).sort().join(',');
  return ids === 'fiesta-max,timer-hours,timer-minutes';
});
tcase('type="number": ninguno en identidad/OTP (esos usan inputmode=numeric)', () => {
  const tags = html.match(/<input[^>]*type="number"[^>]*>/g) || [];
  return !tags.some(t => /id="(twofactor|regVerify|recoveryCode|recovery-regen|email|password|username)/.test(t));
});

// ---- 5. readonly/disabled en flujos sensibles ----
tcase('readonly estático: 7 conocidos, ninguno en 2FA/MFA', () => {
  const tags = html.match(/<input[^>]*\breadonly\b[^>]*>/g) || [];
  if (tags.length !== 7) return false;
  const ids = tags.map(t => /id="([^"]*)"/.exec(t)[1]).sort();
  const known = ['regBdDay', 'regBdMonth', 'regBdYear',
    'settings-account-birthday-day', 'settings-account-birthday-month',
    'settings-account-birthday-year', 'settings-account-email'].sort();
  if (ids.join(',') !== known.join(',')) return false;
  return !tags.some(t => /twofactor|recovery|mfa/i.test(t));
});
tcase('settings-account-email: readonly + disabled (display-only)', () => {
  const m = /<input[^>]*id="settings-account-email"[^>]*>/.exec(html);
  return m && /\breadonly\b/.test(m[0]) && /\bdisabled\b/.test(m[0]);
});
tcase('submitTwoFactorChallenge: input+btn deshabilitados antes del verify', () => {
  const fn = extractFn(html, 'function submitTwoFactorChallenge()', 'function submitTwoFactorChallengeLegacy');
  if (!fn) return false;
  return /input\.disabled\s*=\s*true/.test(fn) && /btn\.disabled\s*=\s*true/.test(fn);
});
tcase('submitTwoFactorChallenge: reactivación en todos los caminos de error', () => {
  const fn = extractFn(html, 'function submitTwoFactorChallenge()', 'function submitTwoFactorChallengeLegacy');
  if (!fn) return false;
  return count(/input\.disabled\s*=\s*false/g, fn) >= 3;
});
tcase('confirmRegenerate: confirm() nativo bloqueante antes del async (anti doble-envío)', () => {
  const i = rc.indexOf('function confirmRegenerate()');
  if (i < 0) return false;
  const j = rc.indexOf('verifyCurrentTotp(', i);
  if (j < 0 || j < i) return false;
  const head = rc.slice(i, j);
  return /if\s*\(!confirm\(/.test(head);
});
tcase('códigos revelados: copiar + descargar + select-all (sin readonly-sin-copia)', () =>
  /DrexRecoveryCodes\.copyPending\(\)/.test(rc) &&
  /DrexRecoveryCodes\.downloadPending\(\)/.test(rc) &&
  /select-all/.test(rc));

// ---- 6. falla en base ----
tcase('falla-en-base: contra HEAD los 4 asserts de leads FALLAN', () => {
  if (!isBase) return true; // solo se evalúa con --base
  // En base: recovery-regen-code con autocomplete="off", sin enterkeyhint;
  // setup/disable-code sin autocomplete ni enterkeyhint.
  const rcLine = (rc.split('\n').find(l => l.indexOf('recovery-regen-code') >= 0) || '');
  const leadRcOff = rcLine.indexOf('autocomplete="off"') >= 0;
  const leadRcNoEk = rcLine.indexOf('enterkeyhint=') < 0;
  const leadSetup = attrOf(html, 'twofactor-setup-code', 'autocomplete') === undefined &&
    attrOf(html, 'twofactor-setup-code', 'enterkeyhint') === undefined;
  const leadDisable = attrOf(html, 'twofactor-disable-code', 'autocomplete') === undefined &&
    attrOf(html, 'twofactor-disable-code', 'enterkeyhint') === undefined &&
    attrOf(html, 'twofactor-disable-code', 'onkeydown') === undefined;
  const leadNoEnter = (attrOf(html, 'twofactor-setup-code', 'onkeydown') === undefined) &&
    (rc.split('\n').find(l => l.indexOf('recovery-regen-code') >= 0) || '').indexOf('onkeydown=') < 0;
  return leadRcOff && leadRcNoEk && leadSetup && leadDisable && leadNoEnter;
});

function extractFn(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return null;
  let j = endMarker ? src.indexOf(endMarker, i + startMarker.length) : -1;
  if (j < 0) j = src.length;
  return src.slice(i, j);
}

console.log('---');
console.log(failures === 0 ? 'C135: ALL PASS' : 'C135: ' + failures + ' FAIL');
process.exit(failures === 0 ? 0 : 1);
