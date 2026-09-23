// C14: fugas de identidad entre cuentas al logout/cambio de cuenta.
// Cada fuga tiene un caso que FALLA sin el fix (la rama de logout no invoca
// clearAccountScopedState()) y PASA con él. Además ejecuta la función REAL
// extraída del HTML en un sandbox vm con estado de la cuenta A precargado y
// verifica que tras la limpieza nada de A sobrevive para la cuenta B.
// Uso: node tests/test-c14-identity-leaks.js [ruta/index.html]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}

// ---------- Parte A: la rama de logout invoca la limpieza centralizada ----------
const c11Anchor = 'clearChatConversationCache(); // C11-2: sin fugas entre cuentas';
const ai = html.indexOf(c11Anchor);
check('ancla C11-2 presente (base sana)', ai !== -1);
const branchSlice = ai !== -1 ? html.slice(ai, ai + 3000) : '';
const hasCall = branchSlice.includes('clearAccountScopedState();');
check('rama de logout invoca clearAccountScopedState() [falla sin el fix C14]', hasCall);

// Extracción de la función REAL (brace-matching) para la parte conductual.
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
const fnSrc = extractFn(html, 'clearAccountScopedState');
check('clearAccountScopedState() definida en el HTML [falla sin el fix C14]', !!fnSrc);

// ---------- Parte B: veredicto por fuga (ancla de limpieza por cada hallazgo) ----------
const leaks = [
  ['L1 fiesta: micrófono/WebRTC/listeners/intervalos se apagan', 'fiestaFullCleanup()'],
  ['L1 fiesta: variables de sala reseteadas', 'fiestaCur = null; fiestaMyUid = null;'],
  ['L2 feed: snapshot de DrexCache invalidado', "DrexCache.invalidate('feed')"],
  ['L3 chat: mensajes en memoria limpiados', 'chatMessagesMemoryCache.clear()'],
  ['L3 chat: namespace chat de DrexCache invalidado', "DrexCache.invalidate('chat')"],
  ['L4 música: historial en memoria limpiado', 'musicHistoryCache = [];'],
  ['L4 música: clave global drex_music_history eliminada', "removeItem('drex_music_history')"],
  ['L5 búsquedas: clave global drex_recent_searches eliminada', "removeItem('drex_recent_searches')"],
  ['L6 posts ocultos: clave global drex_hidden_posts eliminada', "removeItem('drex_hidden_posts')"],
  ['L7 reproducción: player detenido y oculto', 'window.musicStopAndHide()'],
  ['L7 reproducción: cola vaciada', 'musicQueue = []; musicQueueIdx = -1;'],
  ['L7 reproducción: blob URLs revocadas', 'URL.revokeObjectURL(u)'],
  ['L8 sala de chat: teardown al cerrar sesión', 'closeChatRoomView()'],
  ['L8 sala de chat: listener de mensajes desuscrito', 'detachChatMessagesListener()'],
  ['L9 bloqueos: listener desuscrito', 'blockedAccountsRef.off()'],
  ['L10 screen-time: tracking detenido', 'stopScreenTimeTracking()'],
  ['L10 screen-time: timer de restore del modo silencio matado', '_quietModeRestoreTimer = null'],
  ['L10 screen-time: backup de notifs de A eliminado', "removeItem('drex_st_notif_backup')"],
  ['L11 notificaciones: toggles en memoria reseteados', 'notifSettings = {};'],
  ['L12 borradores de chat: claves drex_chat_draft_* eliminadas', 'drex_chat_draft_'],
];
for (const [name, anchor] of leaks) {
  check(name + ' [falla sin el fix C14]', hasCall && !!fnSrc && fnSrc.includes(anchor));
}

// ---------- Parte C: conductual — función REAL en sandbox con estado de A ----------
if (fnSrc) {
  const prelude = `
    'use strict';
    var calls = [];
    var __store = new Map([
      ['drex_music_history', JSON.stringify([{id:'t1', title:'Track de A'}])],
      ['drex_recent_searches', JSON.stringify(['busqueda secreta de A'])],
      ['drex_hidden_posts', JSON.stringify(['postA1'])],
      ['drex_notification_settings_v1', JSON.stringify({likes:false})],
      ['drex_st_notif_backup', JSON.stringify({likes:false})],
      ['drex_chat_draft_group1', 'texto sin enviar de A en el grupo'],
      ['selectedLanguage', 'es'],
      ['drex_last_login_method', 'email'],
      ['drex_st_settings', '{}']
    ]);
    var localStorage = new Proxy({
      getItem: k => __store.has(k) ? __store.get(k) : null,
      setItem: (k, v) => __store.set(k, String(v)),
      removeItem: k => { __store.delete(k); }
    }, {
      // Como el localStorage real: las claves son propiedades propias
      // enumerables (Object.keys las ve; lo necesita clearAllChatDrafts).
      ownKeys: () => Array.from(__store.keys()),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
    });
    var window = {};
    window.DrexCache = { invalidated: [], invalidate(ns) { this.invalidated.push(ns); } };
    window.musicStopAndHide = function () { calls.push('musicStopAndHide'); };
    var document = { getElementById(id) { calls.push('getElementById:' + id); return { classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } }; } };
    var URL = { revoked: [], revokeObjectURL(u) { this.revoked.push(u); } };
    var __clearedTimeouts = [];
    function clearTimeout(t) { __clearedTimeouts.push(t); }
    // Colaboradores reales sustituidos por stubs que registran la llamada.
    function fiestaFullCleanup() { calls.push('fiestaFullCleanup'); }
    function _fiestaCancelDisconnect() { calls.push('_fiestaCancelDisconnect'); }
    function closeChatRoomView() { calls.push('closeChatRoomView'); currentChatRoomId = null; }
    function detachChatMessagesListener() { calls.push('detachChatMessagesListener'); }
    function stopScreenTimeTracking() { calls.push('stopScreenTimeTracking'); }
    // Estado de la cuenta A precargado.
    var fiestaCur = { id: 'fiestaA' }, fiestaMyUid = 'uidA', fiestaMyRole = 'speaker',
        fiestaPeerDownSince = { x: 1 }, fiestaMuted = true, fiestaMembers = { uidA: {} },
        fiestaAmHost = true, fiestaHostMutedLocal = false, fiestaReasserting = false;
    var currentChatRoomId = 'roomA';
    var chatMessagesMemoryCache = new Map([['roomA', [{ id: 'm1', text: 'hola de A' }]]]);
    var musicUrlCache = new Map([['t1', 'blob:abc']]);
    var musicQueue = [{ id: 't1' }], musicQueueIdx = 0;
    var musicExploreCache = [1], musicSearchCache = [1], musicMineCache = [1],
        musicHistoryCache = [{ id: 't1' }], musicFavoritesCache = [{ id: 't1' }],
        musicTopCache = [1], musicArtistCache = [1], musicPlaylistsCache = [1],
        musicAuthorBlockCache = [{ id: 'tA' }], musicAuthorBlockUid = 'uidA',
        musicPlaylistDetailCache = { id: 'p1' }, musicAdBreakPending = {},
        musicLyricsState = { original: 'x' },
        musicUploadState = { audioFile: {}, audioDataUrl: 'data:audio/A', audioName: 'a.mp3', duration: 10, coverDataUrl: 'data:img/A', editingId: null, artistName: 'A' };
    var blockedAccountsRef = { off() { calls.push('blockedAccountsRef.off'); } };
    var blockedAccountsSet = new Set(['bloqueadoPorA']);
    var _quietModeRestoreTimer = 999;
    var notifSettings = { likes: false };
  `;
  const epilogue = `
    clearAccountScopedState();
    clearAccountScopedState(); // idempotencia: segunda corrida no debe lanzar
    function assert(c, msg) { if (!c) throw new Error('ASSERT: ' + msg); }
    ['fiestaFullCleanup', '_fiestaCancelDisconnect', 'closeChatRoomView',
     'detachChatMessagesListener', 'stopScreenTimeTracking', 'musicStopAndHide',
     'blockedAccountsRef.off'].forEach(n => assert(calls.includes(n), 'no se llamo a ' + n));
    assert(fiestaCur === null && fiestaMyUid === null && fiestaMyRole === 'listener' &&
           fiestaAmHost === false && fiestaMuted === false && fiestaReasserting === false,
           'estado de fiesta no reseteado');
    assert(Object.keys(fiestaMembers).length === 0, 'fiestaMembers no vaciado');
    assert(chatMessagesMemoryCache.size === 0, 'chatMessagesMemoryCache no limpiado');
    assert(window.DrexCache.invalidated.includes('chat') && window.DrexCache.invalidated.includes('feed'),
           'DrexCache chat/feed no invalidados');
    assert(musicQueue.length === 0 && musicQueueIdx === -1, 'cola de música no vaciada');
    assert(musicUrlCache.size === 0 && URL.revoked.includes('blob:abc'), 'blob URLs no revocadas');
    assert(musicHistoryCache.length === 0 && musicFavoritesCache.length === 0 &&
           musicExploreCache.length === 0 && musicMineCache.length === 0 &&
           musicTopCache.length === 0 && musicArtistCache.length === 0 &&
           musicAuthorBlockCache.length === 0 && musicAuthorBlockUid === null &&
           musicPlaylistsCache.length === 0, 'caches de música no limpiados');
    assert(musicPlaylistDetailCache === null && musicAdBreakPending === null, 'detalle/ad música no reseteados');
    assert(musicUploadState.audioDataUrl === null && musicUploadState.audioFile === null, 'draft de subida no limpiado');
    assert(musicLyricsState.original === '' && musicLyricsState.showing === 'original', 'lyrics no reseteados');
    ['drex_music_history', 'drex_recent_searches', 'drex_hidden_posts',
     'drex_notification_settings_v1', 'drex_st_notif_backup'].forEach(k =>
       assert(localStorage.getItem(k) === null, 'localStorage ' + k + ' sobrevive'));
    assert(blockedAccountsRef === null && blockedAccountsSet.size === 0, 'bloqueos de A sobreviven');
    assert(localStorage.getItem('drex_chat_draft_group1') === null, 'borrador de chat de A sobrevive');
    assert(_quietModeRestoreTimer === null && __clearedTimeouts.includes(999), 'quiet-mode timer sobrevive');
    assert(Object.keys(notifSettings).length === 0, 'notifSettings de A sobrevive');
    // Regresión: el flujo normal no se rompe — claves de dispositivo intactas.
    assert(localStorage.getItem('selectedLanguage') === 'es', 'selectedLanguage tocada');
    assert(localStorage.getItem('drex_last_login_method') === 'email', 'drex_last_login_method tocada');
    assert(localStorage.getItem('drex_st_settings') === '{}', 'drex_st_settings tocados');
    'BEHAVIORAL-OK';
  `;
  try {
    const ctx = vm.createContext({});
    const out = vm.runInContext(prelude + '\n' + fnSrc + '\n' + epilogue, ctx, { timeout: 5000 });
    check('conductual: estado de A eliminado tras clearAccountScopedState() (doble corrida)', out === 'BEHAVIORAL-OK');
  } catch (e) {
    check('conductual: estado de A eliminado tras clearAccountScopedState() (doble corrida) :: ' + e.message, false);
  }
} else {
  check('conductual: (omitido, función ausente)', false);
}

if (failures) { console.error(`\n${failures} checks FAILED`); process.exit(1); }
console.log('\nAll C14 identity-leak checks passed');
