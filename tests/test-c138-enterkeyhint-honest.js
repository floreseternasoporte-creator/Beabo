// C138: sintesis "enterkeyhint honesto repo-wide" (C116/C135/C137).
//
// AUDITORIA (2026-09-24, base d9bf9c856a8952e33e2a451df81f85b5c9f46309,
// hit por hit, index.html + recovery-codes.js + *.js raiz):
//
// 1. Inventario: 28 enterkeyhint (27 en index.html + 1 en recovery-codes.js).
//    Un hint es HONESTO si Enter tiene efecto real:
//    a) onkeydown inline con event.key==='Enter' (patron C135),
//    b) dentro de <form> (submit implicito),
//    c) listener JS registrado (chat-room-input: keydown->sendChatMessage),
//    d) hint="search" con filtrado en vivo (oninput inline, .oninput asignado
//       por JS, o addEventListener('input')): la busqueda ya se ejecuto al
//       escribir; Enter completa/descarta el teclado con resultados aplicados.
// 2. LEADS (4 hints mentirosos, corregidos):
//    - emailInput (next): FUERA de #authForm, sin onkeydown -> Enter no hacia
//      nada. Fix: Enter->focus passwordInput (el "next" ahora cumple).
//    - regEmail (next): sin form, sin onkeydown -> Enter mudo.
//      Fix: Enter->focus regPassword.
//    - regPassword (next): idem -> Fix: Enter->focus regPasswordConfirm.
//    - regUsername (next): ultimo campo, sin accion -> Fix: hint "go" +
//      Enter->click en regUsernameContinue (mismo efecto que Continuar).
// 3. Completitud de cadena (2 campos sin hint): regFirstName y
//    regPasswordConfirm reciben enterkeyhint="next" + onkeydown para que la
//    cadena de "next" no muera a mitad del registro.
// 4. Ya honestos (sin cambio): passwordInput (go, en form->submit),
//    chat-room-input (send, keydown->sendChatMessage), fiesta-chat-input
//    (send, onkeydown), chat-edit-input (done, onkeydown, C137),
//    twofactor-setup/disable-code (go, onkeydown, C135), recovery-regen-code
//    (go, onkeydown, C135), 17x search con filtrado en vivo (diseno honesto).
// 5. Familia "sandbox/allow en iframes" (nunca auditada): CERO iframes propios
//    en todo el arbol (0 "<iframe", 0 createElement('iframe'), 0 sandbox=,
//    0 allow=). Los 24 "iframe" del codigo son la mediacion Adsterra:
//    iframes de terceros inyectados por el ad network, solo consultados via
//    querySelector para shimmer/deteccion. Nada que blindar sin romper
//    anuncios -> auditoria documentada, SIN CAMBIO.
// 6. Familia "capture en file inputs" (nunca auditada): 2 inputs con
//    capture="environment" (note-image-fullscreen-camera,
//    comment-photo-camera-input), ambas variantes "camara" deliberadas
//    pareadas con variantes "galeria" (note-media-fullscreen,
//    comment-photo-input). El resto son pickers de galeria/archivo donde
//    forzar camara seria incorrecto -> consistente, SIN CAMBIO.
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
const rcSrc = fs.readFileSync(path.join(repoRoot, 'recovery-codes.js'), 'utf8');
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

// Tag <input|textarea que contiene la posicion pos (ids unicos, sin anidar).
function tagAt(pos) {
  const s = Math.max(html.lastIndexOf('<input', pos), html.lastIndexOf('<textarea', pos));
  if (s < 0) return null;
  const e = html.indexOf('>', pos);
  return html.slice(s, e + 1);
}
function tagFor(id) {
  const i = html.indexOf('id="' + id + '"');
  return i < 0 ? null : tagAt(i);
}
function hasEnterKeydown(tag) {
  return tag !== null && /onkeydown\s*=/i.test(tag) && tag.indexOf("event.key==='Enter'") >= 0;
}
function insideForm(pos) {
  const open = html.lastIndexOf('<form', pos);
  if (open < 0) return false;
  const close = html.indexOf('</form>', open);
  return close > pos;
}
function liveSearchWired(id) {
  const t = tagFor(id);
  if (t !== null && /oninput\s*=/i.test(t)) return true;
  return html.indexOf("getElementById('" + id + "').oninput") >= 0 ||
    html.indexOf('getElementById("' + id + '").oninput') >= 0 ||
    html.indexOf("getElementById('" + id + "').addEventListener('input'") >= 0;
}
function chatRoomEnterWired() {
  return /getElementById\('chat-room-input'\)[\s\S]{0,300}addEventListener\('keydown'[\s\S]{0,300}event\.key === 'Enter'[\s\S]{0,160}sendChatMessage\(\)/.test(html);
}
// Regla de honestidad: el hint promete una accion de Enter que existe.
function isHonest(id, hint, tag, pos) {
  if (hasEnterKeydown(tag)) return true;
  if (insideForm(pos)) return true; // submit implicito del form
  if (id === 'chat-room-input' && chatRoomEnterWired()) return true;
  if (hint === 'search' && liveSearchWired(id)) return true; // filtrado en vivo
  return false;
}
function hintOf(tag) {
  const m = tag && tag.match(/enterkeyhint="([^"]*)"/);
  return m ? m[1] : null;
}

// ---- 1. Los 6 leads: cada hint declarado ahora tiene accion real de Enter ----
tcase('lead: emailInput next + Enter->focus passwordInput', () => {
  const t = tagFor('emailInput');
  return hintOf(t) === 'next' && hasEnterKeydown(t) &&
    t.indexOf("getElementById('passwordInput').focus()") >= 0;
});
tcase('lead: regFirstName next + Enter->focus regEmail', () => {
  const t = tagFor('regFirstName');
  return hintOf(t) === 'next' && hasEnterKeydown(t) &&
    t.indexOf("getElementById('regEmail').focus()") >= 0;
});
tcase('lead: regEmail next + Enter->focus regPassword', () => {
  const t = tagFor('regEmail');
  return hintOf(t) === 'next' && hasEnterKeydown(t) &&
    t.indexOf("getElementById('regPassword').focus()") >= 0;
});
tcase('lead: regPassword next + Enter->focus regPasswordConfirm', () => {
  const t = tagFor('regPassword');
  return hintOf(t) === 'next' && hasEnterKeydown(t) &&
    t.indexOf("getElementById('regPasswordConfirm').focus()") >= 0;
});
tcase('lead: regPasswordConfirm next + Enter->focus regUsername', () => {
  const t = tagFor('regPasswordConfirm');
  return hintOf(t) === 'next' && hasEnterKeydown(t) &&
    t.indexOf("getElementById('regUsername').focus()") >= 0;
});
tcase('lead: regUsername go + Enter->click regUsernameContinue', () => {
  const t = tagFor('regUsername');
  return hintOf(t) === 'go' && hasEnterKeydown(t) &&
    t.indexOf("getElementById('regUsernameContinue').click()") >= 0;
});

// ---- 2. Barrido honesto repo-wide: inventario cerrado + honestidad hit por hit ----
const EXPECTED_IDS = [
  'help-center-search', 'emailInput', 'passwordInput',
  'regFirstName', 'regEmail', 'regPassword', 'regPasswordConfirm', 'regUsername',
  'onb-country-search', 'chat-search-input', 'new-chat-search-input',
  'group-chat-search-input', 'chat-message-search-input', 'chat-room-input',
  'chat-edit-input', 'chat-forward-search', 'group-search-input',
  'add-member-search-input', 'share-post-search-input',
  'fiesta-chat-input', 'fiesta-games-search', 'gif-search-input',
  'sticker-search', 'search-input', 'settings-search-input',
  'twofactor-setup-code', 'twofactor-disable-code',
  'settings-country-search', 'music-explore-input',
  'baro-input'
];
function inventory() {
  const out = [];
  let from = 0;
  for (;;) {
    const p = html.indexOf('enterkeyhint="', from);
    if (p < 0) break;
    const tag = tagAt(p);
    const idm = tag && tag.match(/id="([^"]*)"/);
    const hm = tag && tag.match(/enterkeyhint="([^"]*)"/);
    out.push({ id: idm ? idm[1] : null, hint: hm ? hm[1] : null, tag: tag, pos: p });
    from = p + 1;
  }
  return out;
}
tcase('inventario cerrado: 30 enterkeyhint en index.html, ids exactos', () => {
  if (isBase) return true; // en base el inventario es 27 (se evalua aparte)
  const inv = inventory();
  if (inv.length !== 30) return false;
  const ids = inv.map(x => x.id).sort();
  return JSON.stringify(ids) === JSON.stringify(EXPECTED_IDS.slice().sort());
});
tcase('honestidad hit por hit: los 30 hints tienen accion real de Enter', () => {
  if (isBase) return true; // en base hay 4 mentirosos (se demuestra en seccion 4)
  const bad = inventory().filter(x => !isHonest(x.id, x.hint, x.tag, x.pos));
  if (bad.length) console.error('   mentirosos: ' + bad.map(x => x.id).join(', '));
  return bad.length === 0;
});
tcase('distribucion de hints: next x5, go x4, search x17, send x3, done x1', () => {
  if (isBase) return true;
  return count(/enterkeyhint="next"/g, html) === 5 &&
    count(/enterkeyhint="go"/g, html) === 4 &&
    count(/enterkeyhint="search"/g, html) === 17 &&
    count(/enterkeyhint="send"/g, html) === 3 &&
    count(/enterkeyhint="done"/g, html) === 1;
});
tcase('recovery-codes.js: recovery-regen-code go + onkeydown Enter->confirmRegenerate', () => {
  return rcSrc.indexOf('id="recovery-regen-code"') >= 0 &&
    rcSrc.indexOf('enterkeyhint="go"') >= 0 &&
    rcSrc.indexOf("event.key===\\'Enter\\'") >= 0 &&
    rcSrc.indexOf('DrexRecoveryCodes.confirmRegenerate()') >= 0;
});

// ---- 3. Ceros documentados: iframes propios y capture ----
tcase('iframes: cero <iframe en index.html (mediacion Adsterra es de terceros)', () =>
  count(/<iframe/g, html) === 0);
tcase('iframes: cero createElement(iframe) en *.js raiz', () => {
  const jsFiles = fs.readdirSync(repoRoot).filter(f => f.endsWith('.js'));
  return jsFiles.every(f => {
    const s = fs.readFileSync(path.join(repoRoot, f), 'utf8');
    return s.indexOf("createElement('iframe'") < 0 && s.indexOf('createElement("iframe"') < 0;
  });
});
tcase('capture: capture="environment" x2 solo en variantes camara', () => {
  if (count(/capture="environment"/g, html) !== 2) return false;
  const cam1 = tagFor('note-image-fullscreen-camera');
  const cam2 = tagFor('comment-photo-camera-input');
  const gal1 = tagFor('note-media-fullscreen');
  const gal2 = tagFor('comment-photo-input');
  return cam1 && cam1.indexOf('capture="environment"') >= 0 &&
    cam2 && cam2.indexOf('capture="environment"') >= 0 &&
    gal1 && gal1.indexOf('capture=') < 0 &&
    gal2 && gal2.indexOf('capture=') < 0;
});

// ---- 4. falla-en-base: contra HEAD los 4 leads no tienen accion de Enter ----
tcase('base: en HEAD los 4 leads carecen de onkeydown de Enter', () => {
  if (!isBase) return true; // solo se evalua con --base
  return ['emailInput', 'regEmail', 'regPassword', 'regUsername'].every(id => {
    const t = tagFor(id);
    return t !== null && !hasEnterKeydown(t);
  });
});

console.log('---');
console.log(failures === 0 ? 'C138: ALL PASS' : 'C138: ' + failures + ' FAIL');
process.exit(failures === 0 ? 0 : 1);
