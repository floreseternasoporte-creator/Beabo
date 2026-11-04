// Mensajería estilo X/Twitter (bandeja + sala) sin tocar estilos globales.
// Pruebas conductuales: se extraen las funciones REALES de index.html y se
// ejecutan en un vm con stubs mínimos; el resto son guardias de fuente.
// Uso: node tests/test-mensajeria-estilo-x.js [ruta/index.html]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
let failures = 0;
function check(name, cond) { console.log((cond ? '  OK  ' : '  FAIL ') + name); if (!cond) failures++; }

// Extrae `function name(...) {...}` probando cierres hasta que compile.
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let i = src.indexOf('{', src.indexOf(')', start));
  for (let end = src.indexOf('}', i); end !== -1; end = src.indexOf('}', end + 1)) {
    const code = src.slice(start, end + 1);
    try { new vm.Script(code); return code; } catch (_) { /* seguir */ }
  }
  return null;
}

// ---------- A. conductual: filas de la bandeja ----------
const names = ['drexChatLocale', 'drexInboxIsPlaceholderMsg', 'drexInboxRowHtml', 'renderAntesalaRequestsSection',
  'renderChatConversations', 'isLegacyChatConversationUnread', 'isChatConversationUnread'];
const code = names.map(n => extractFn(html, n)).filter(Boolean).join('\n');
check('se extraen las funciones reales (' + names.length + ')', names.every(n => code.includes('function ' + n + '(')));

const els = { 'chat-conversations-list': { innerHTML: '' } };
const store = {};
const ctx = {
  document: { getElementById: id => els[id] || null },
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem() {}, removeItem() {} },
  appT: s => s, escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  escapeInlineSingleQuote: s => String(s).replace(/'/g, "\\'"), getSafeMediaUrl: (u, d) => u || d,
  getVerificationIconByAuthor: () => '', fiestaStripEmoji: x => x, formatConvTime: () => '10:30',
  getAppLanguage: () => 'es', _CHAT_DEFAULT_AVATAR: 'data:x', renderChatInboxFilters() {},
  drexAntesalaCoreSplitInbox: items => ({ requests: items.filter(i => i.isRequest), chats: items.filter(i => !i.isRequest) }),
  filterChatInboxConversations: items => items, drexPresenceOnline: () => Promise.resolve(false),
  getChatLastReadKey: (u, id) => 'lr_' + u + '_' + id, chatUnreadAggActive: false, chatUnreadAggCache: {},
  DrexCloud: { auth: () => ({ currentUser: { uid: 'me' } }) },
};
vm.createContext(ctx);
vm.runInContext(code, ctx);
const render = items => { els['chat-conversations-list'].innerHTML = ''; ctx.renderChatConversations(items); return els['chat-conversations-list'].innerHTML; };

const dm = { id: 'c1', isGroup: false, otherUid: 'u2', otherName: 'Ana', otherImage: 'a.png', updatedAt: 1, pinnedAt: 5, lastMessage: 'hola <b>', lastMessageSenderId: 'me' };
let out = render([dm]);
check('DM: nombre y hora en la misma línea ("· 10:30")', /<p class="min-w-0 truncate[^"]*">Ana<\/p><span class="[^"]*">&middot; 10:30<\/span>/.test(out));
check('DM: vista previa con prefijo "Tú:" cuando el último mensaje es mío', out.includes('Tú: hola &lt;b&gt;'));
check('DM: la vista previa sigue escapada (XSS)', !out.includes('hola <b>'));
check('DM fijado muestra la etiqueta "Fijado" (antes solo grupos)', out.includes('>Fijado</span>'));
check('DM: avatar con punto de presencia con borde del tema', out.includes('presence-dot-u2') && out.includes('border-color:var(--theme-bg)'));
store['lr_me_c1'] = '100';
check('legado: mi propio último mensaje NO cuenta como no leído', !ctx.isChatConversationUnread({ ...dm, updatedAt: 200 }));
check('legado: mensaje ajeno más reciente SÍ es no leído', ctx.isChatConversationUnread({ ...dm, updatedAt: 200, lastMessageSenderId: 'u2' }));
delete store['lr_me_c1'];
check('legado: "marcar como no leída" (sin lastRead) sigue funcionando', ctx.isChatConversationUnread({ ...dm, updatedAt: 200 }));

ctx.chatUnreadAggActive = true; ctx.chatUnreadAggCache = { c1: { c: 2, r: 0 } };
out = render([{ ...dm, pinnedAt: 0, lastMessageSenderId: 'u2' }]);
check('no leído: punto de marca a la derecha de la vista previa', /<span class="w-2\.5 h-2\.5 rounded-full bg-\[var\(--drex-brand\)\] shrink-0" role="img"/.test(out));
check('no leído: nombre en negrita', /font-bold text-\[var\(--theme-text\)\]">Ana/.test(out));
check('sin "Tú:" cuando el último mensaje es del otro', !out.includes('Tú: '));
ctx.chatUnreadAggCache = {};

out = render([{ ...dm, pinnedAt: 0, lastMessage: 'Nueva conversación' }]);
check('placeholder "Nueva conversación" en cursiva y sin prefijo', out.includes('italic') && !out.includes('Tú: '));
out = render([{ ...dm, pinnedAt: 0, lastMessage: 'Sin mensajes aún' }]);
check('placeholder "Sin mensajes aún" también en cursiva', out.includes('italic'));

const grp = { id: 'g1', isGroup: true, groupId: 'g1', groupName: 'Equipo', groupImage: '', updatedAt: 1, pinnedAt: 0, lastMessage: 'Ana: hola' };
out = render([grp]);
check('grupo: onclick abre la sala del grupo y conserva menú contextual', out.includes("openGroupChatRoom('g1')") && out.includes('showConvOptions(\'group\',\'g1\''));
out = render([{ ...dm, pinnedAt: 0, isRequest: true }]);
check('solicitudes (antesala): misma fila con etiqueta "Solicitud"', out.includes('drex-antesala-tag') && out.includes("asRequest:true"));
const last = render([dm, { ...dm, id: 'c2', otherUid: 'u3' }]);
check('solo la última fila omite el separador', (last.match(/ml-\[76px\] h-px/g) || []).length === 1);

// ---------- B. guardias de fuente: datos y sala ----------
check('datos: userConversations guarda lastSenderId (emisor y receptor)',
  html.includes('"/lastSenderId"]=senderUid;updates["userConversations/"+recipientId') && html.includes('+"/lastSenderId"]=senderUid;aggMemberUids=[senderUid,recipientId]'));
check('datos: la bandeja lee lastSenderId y lo expone como lastMessageSenderId',
  html.includes('lastMessageSenderId:lastSender}') && html.includes('let lastSender=meta.lastSenderId||""'));
check('chips de filtro conservan min-h-[44px] + hover al repintar',
  html.includes('btn.className="chat-filter-chip min-h-[44px] flex items-center shrink-0') && html.includes('"hover:text-[var(--brand-indigo-text)] hover:border-[var(--drex-brand)] border-[var(--theme-border)]'));
check('sala: la hora de los mensajes usa el idioma de la app', html.includes('const _loc=drexChatLocale();'));
check('sala: burbujas con cola estilo X y se retira al agrupar', html.includes('bubble.dataset.tail="1"') && html.includes('_prevTail.style.borderBottomRightRadius=""'));
check('sala: "Visto" muestra la hora y usa colores del tema', html.includes('text-[10px] text-[var(--theme-muted)] px-1 self-end') && html.includes('appT("Visto")+" · "'));
check('sala: pastilla de sistema y mensaje eliminado sin colores fijos',
  !html.includes('bg-white border border-[#e5e9ee]') && !html.includes('border border-[#dce1e5] text-[#b6c0d1] text-xs italic'));
check('sala: texto de "eliminado" en vivo pasa por appT', html.includes('${isMine?appT("Eliminaste este mensaje"):appT("Mensaje eliminado")}'));
check('estados de error/vacío de la bandeja con variables del tema',
  !html.includes('bg-white border border-[#dce1e5] rounded-2xl p-5 text-center text-[#6b7280]">No pudimos cargar') );
check('no se tocaron estilos globales: ningún bloque <style> nuevo con reglas de chat-x',
  !/chat-x-|\.dm-x-/.test(html));

console.log('\nRESULTADO: ' + (failures ? failures + ' FALLO(S)' : 'OK'));
process.exit(failures ? 1 : 0);
