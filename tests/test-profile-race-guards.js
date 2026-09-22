'use strict';
/* Prueba de las guardias anti-carrera de superficies de identidad (index.html):
   abre el chat A (lectura lenta) y luego el chat B (lectura rápida); la
   respuesta tardía de A NO debe pintar la foto/nombre sobre B.
   Extrae las funciones REALES del index.html y las ejecuta con un DOM y un
   DrexCloud falsos, controlando el orden de resolución de las lecturas.
   Ejecutar: node tests/test-profile-race-guards.js
*/
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// ---------- DOM falso ----------
const els = {};
function fakeEl() {
  return {
    src: '', textContent: '', innerHTML: '', value: '', onclick: null,
    disabled: false, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, appendChild() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; }
  };
}
global.document = { getElementById: id => els[id] || (els[id] = fakeEl()) };

// ---------- DrexCloud falso con lecturas controlables ----------
const pendingReads = []; // { path, resolve, reject }
function snapOf(data) { return { val: () => data, exists: () => data != null }; }
global.DrexCloud = {
  auth: () => ({ currentUser: { uid: 'me' } }),
  database: () => ({
    ref: p => ({
      once: () => new Promise((resolve, reject) => pendingReads.push({ path: p, resolve, reject }))
    })
  })
};
function readFor(pathPrefix) {
  const i = pendingReads.findIndex(r => r.path.indexOf(pathPrefix) === 0);
  if (i < 0) throw new Error('no hay lectura pendiente para ' + pathPrefix + ' (hay: ' + pendingReads.map(r => r.path).join(', ') + ')');
  return pendingReads.splice(i, 1)[0];
}

// ---------- utilidades globales que usan las funciones ----------
global.escapeHtml = s => String(s == null ? '' : s);
global.getVerificationIconByAuthor = () => '';
global.appT = s => s;
global.showMiniToast = () => {};
global.getSpinnerMarkup = () => '';
global.getSafeMediaUrlRaw = u => u;
global.getSafeMediaUrl = u => u;
global.loadChatMediaGrid = () => {};
global.openGroupInfoPanel = () => {};
global._syncThemeCheckmarks = () => {};
global._chatMediaGridPhotos = [];
global.currentChatRecipient = null;
global.currentChatRoomId = null;
global.currentChatIsGroup = false;

// ---------- extracción de código real con balanceo de llaves ----------
function matchBrace(src, openIdx) {
  let i = openIdx, depth = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"') {
      const q = c; i++;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '`') {
      i++;
      let tplDepth = 0;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '`' && tplDepth === 0) { i++; break; }
        if (src[i] === '$' && src[i + 1] === '{') { tplDepth++; i += 2; continue; }
        if (src[i] === '}' && tplDepth > 0) { tplDepth--; i++; continue; }
        if (src[i] === '{' && tplDepth > 0) {
          // bloque dentro de ${}: balancearlo aparte
          const end = matchBrace(src, i); i = end + 1; continue;
        }
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  throw new Error('llave sin cerrar');
}
function extractFrom(src, anchor, extraPrefix) {
  const a = src.indexOf(anchor);
  if (a < 0) throw new Error('ancla no encontrada: ' + anchor);
  const open = src.indexOf('{', a);
  const end = matchBrace(src, open);
  return (extraPrefix || '') + src.slice(a, end + 1);
}

const headerSrc = extractFrom(html, 'function loadChatRoomHeader(otherUid) {', 'let _chatRoomHeaderGen = 0;\n');
// Stubs de helpers del header 1:1 (definidos fuera de la función extraída)
global._CHAT_DEFAULT_AVATAR = 'default-avatar';
global._currentChatOtherImage = '';
global._setDmAvatars = src => { global._currentChatOtherImage = src || ''; };
const infoSrc = extractFrom(html, 'function openChatRoomInfo() {', '');

// eval directo: devuelve las funciones del ámbito del eval
const headerHarness = eval(headerSrc + '\n;({ loadChatRoomHeader });');
const infoHarness = eval(infoSrc + '\n;({ openChatRoomInfo });');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
const tick = () => new Promise(r => setTimeout(r, 5));

(async () => {
  const img = () => document.getElementById('chat-room-user-image');
  const name = () => document.getElementById('chat-room-username');

  // --- Carrera en el encabezado del chat: A lenta, B rápida ---
  headerHarness.loadChatRoomHeader('uidA'); // lectura lenta de A
  headerHarness.loadChatRoomHeader('uidB'); // lectura rápida de B
  readFor('users/uidB').resolve(snapOf({ username: 'bob', profileImage: 'https://img/b.png' }));
  await tick(); await tick();
  check('tras resolver B, el encabezado muestra a bob', name().innerHTML.indexOf('bob') >= 0, name().innerHTML);
  check('tras resolver B, la foto es la de bob', img().src === 'https://img/b.png', img().src);
  // llega tarde la respuesta de A: debe ignorarse
  readFor('users/uidA').resolve(snapOf({ username: 'alice', profileImage: 'https://img/a.png' }));
  await tick(); await tick();
  check('respuesta tardía de A NO pisa el nombre', name().innerHTML.indexOf('bob') >= 0 && name().innerHTML.indexOf('alice') < 0, name().innerHTML);
  check('respuesta tardía de A NO pisa la foto', img().src === 'https://img/b.png', img().src);

  // --- Carrera en el panel de info del chat ---
  const infoName = () => document.getElementById('chat-info-name');
  const infoAvatar = () => document.getElementById('chat-info-avatar');
  global.currentChatRecipient = 'uidA';
  infoHarness.openChatRoomInfo(); // lectura lenta de A
  global.currentChatRecipient = 'uidB';
  infoHarness.openChatRoomInfo(); // lectura rápida de B
  readFor('users/uidB').resolve(snapOf({ username: 'bob', profileImage: 'https://img/b.png' }));
  await tick(); await tick();
  check('panel info: tras resolver B muestra a bob', (infoName().textContent || '').indexOf('bob') >= 0, infoName().textContent);
  readFor('users/uidA').resolve(snapOf({ username: 'alice', profileImage: 'https://img/a.png' }));
  await tick(); await tick();
  const finalName = infoName().textContent || '';
  check('panel info: respuesta tardía de A NO pisa el nombre', finalName.indexOf('bob') >= 0 && finalName.indexOf('alice') < 0, finalName);
  check('panel info: respuesta tardía de A NO pisa la foto', infoAvatar().src === 'https://img/b.png', infoAvatar().src);

  console.log(failures ? ('\nRESULTADO: ' + failures + ' FALLOS') : '\nRESULTADO: TODO OK');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('ERROR en la prueba:', e); process.exit(2); });
