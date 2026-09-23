// CICLO 45 (C45-C1) — el toggle de "Mensajes temporales" de la sala era
// decorativo: se guardaba en chatSettings/<roomId>/disappearing pero NINGÚN
// mensaje expiraba jamás (ningún consumidor del setting).
//
// El fix estampa autoDestroyAt en los mensajes enviados con el toggle activo
// (el mismo pipeline del temporizador del composer: cuenta regresiva +
// borrado al expirar). Semántica tipo WhatsApp: solo aplica a mensajes
// enviados DESPUÉS de activar el toggle; si el temporizador del composer
// también está puesto, gana el más cercano.
//
// Convención del repo: resuelve ../index.html con fallback a ../src/index.html;
// no depende del historial de git; sin rutas absolutas.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function findFile(names) {
  const cands = [];
  for (const n of names) {
    cands.push(path.join(__dirname, '..', n));
    cands.push(path.join(__dirname, '..', 'src', n));
  }
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('no encontrado: ' + names.join(' / '));
}
const html = fs.readFileSync(findFile(['index.html']), 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}

function extractFn(name) {
  const re = new RegExp('(?:async\\s+)?function ' + name + '\\(');
  const mm = re.exec(html);
  if (!mm) throw new Error('ancla no encontrada: ' + name);
  const a = mm.index, j = html.indexOf('{', a);
  let depth = 0, inS = null, esc = false;
  for (let k = j; k < html.length; k++) {
    const c = html[k];
    if (inS) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inS) inS = null; continue; }
    if (c === "'" || c === '"' || c === '`') { inS = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (!depth) return html.slice(a, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}

const pbSrc = extractFn('_paintOptimisticChatBubble');

// ---- 1. Estático ------------------------------------------------------------
check('_paintOptimisticChatBubble consulta el toggle de la sala (_disappearEnabled)',
  /_disappearEnabled/.test(pbSrc));
check('el toggle de la sala estampa autoDestroyAt en el payload',
  /payload\.autoDestroyAt\s*=/.test(pbSrc) && pbSrc.indexOf('_disappearEnabled') >= 0 &&
  pbSrc.indexOf('_disappearEnabled') < pbSrc.lastIndexOf('payload.autoDestroyAt'));

// ---- 2. Funcional: función REAL en sandbox -----------------------------------
function runCase(disappearEnabled, disappearMs) {
  const sb = {
    console, setTimeout, clearTimeout, Promise, Date, Map,
    window: {},
    DrexCloud: { database: () => ({ ref: () => ({ push: () => ({ key: 'm1' }) }) }) },
    chatReplyContext: null, chatViewOnceActive: false, _chatTimerSecs: 0,
    _disappearEnabled: disappearEnabled, _disappearDurationMs: disappearMs,
    chatFileAttachments: [], chatPhotoAttachments: [],
    CHAT_MESSAGES_LIMIT: 100,
    currentChatRoomId: 'r1', currentChatRecipient: 'u2', currentChatIsGroup: false,
    currentGroupMembers: {},
    chatMessagesMemoryCache: new Map(),
    _persistChatMessages: () => {}, updateChatToolbarMode: () => {},
    escapeHtml: s => String(s), getSafeMediaUrl: u => u, getSafeMediaUrlInlineJs: u => u,
    getSpinnerMarkup: () => '', _renderChatFileCardHtml: () => '',
    document: { getElementById: id => id === 'chat-room-input' ? { value: ' hola ', set value(v) {} } : null },
    showMiniToast: () => {}, appT: s => s,
  };
  vm.createContext(sb);
  const expr = pbSrc.replace(/^(async\s+)?function _paintOptimisticChatBubble/, '$1function __pb');
  vm.runInContext('var _paintOptimisticChatBubble = (' + expr + ');', sb, { timeout: 10000 });
  vm.runInContext('var __res = _paintOptimisticChatBubble({uid:"bob"}, "hola", [], []);', sb, { timeout: 10000 });
  return vm.runInContext('__res.payload.autoDestroyAt', sb);
}

const HOUR = 3600000;
const on = runCase(true, HOUR);
check('toggle activo: el payload lleva autoDestroyAt numérico', typeof on === 'number');
check('toggle activo: expira ≈ ahora + duración del toggle',
  typeof on === 'number' && Math.abs(on - (Date.now() + HOUR)) < 10000);

const off = runCase(false, HOUR);
check('toggle inactivo: el payload NO lleva autoDestroyAt', off === undefined || off === null);

if (failures) { console.error(`\n${failures} checks FAILED`); process.exit(1); }
console.log('\nAll C45-C1 checks passed');
