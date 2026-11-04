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
const names = ['drexChatLocale', 'drexInboxIsPlaceholderMsg', 'drexInboxDisplayName', 'drexInboxUnreadCount', 'drexInboxRowHtml', 'renderAntesalaRequestsSection',
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

const dm = { id: 'c1', isGroup: false, otherUid: 'u2', otherName: 'ana_l', otherDisplayName: 'Ana', otherHandle: 'ana_l', otherImage: 'a.png', updatedAt: 1, pinnedAt: 5, lastMessage: 'hola <b>', lastMessageSenderId: 'me' };
let out = render([dm]);
check('DM: nombre en negrita + @usuario + "· hora" en la misma línea', /<p class="truncate shrink-0[^"]*font-(?:extra)?bold[^"]*"[^>]*>Ana<\/p><span class="[^"]*">@ana_l<\/span><span class="[^"]*">&middot; 10:30<\/span>/.test(out));
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
check('no leído: insignia con el número de mensajes sin leer', />2<\/span><\/div>/.test(out) && out.includes('rounded-full bg-[var(--drex-brand)] text-white'));
check('no leído: nombre extranegrita', /font-extrabold text-\[var\(--theme-text\)\]"[^>]*>Ana/.test(out));
ctx.chatUnreadAggCache = { c1: { c: 150, r: 0 } };
check('no leído: más de 99 se muestra como 99+', render([{ ...dm, pinnedAt: 0, lastMessageSenderId: 'u2' }]).includes('>99+</span>'));
ctx.chatUnreadAggCache = { c1: { c: 0, u: 5, r: 1 } };
check('no leído sin contador (grupos grandes): queda el punto', /<span class="w-2\.5 h-2\.5 rounded-full bg-\[var\(--drex-brand\)\] shrink-0" role="img"/.test(render([{ ...dm, pinnedAt: 0, lastMessageSenderId: 'u2' }])));
ctx.chatUnreadAggCache = { c1: { c: 2, r: 0 } };
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
check('solicitudes: ya no se mezclan en la lista; van a una entrada y vista propia (ver test-mensajeria-reddit.js)', !out.includes('drex-antesala-tag') && out.includes('openChatRequestsView()'));
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
check('sala: recibo con tilde "Visto · hora" / "Enviado" y colores del tema', html.includes('chat-seen-badge flex items-center gap-1 text-[11px]') && html.includes('appT("Visto")+" · "') && html.includes('appT("Enviado")') && html.includes('if(mine&&_readReceiptListener)_renderReadReceipt(_drexLastReadAt)'));
check('sala: pastilla de sistema y mensaje eliminado sin colores fijos',
  !html.includes('bg-white border border-[#e5e9ee]') && !html.includes('border border-[#dce1e5] text-[#b6c0d1] text-xs italic'));
check('sala: texto de "eliminado" en vivo pasa por appT', html.includes('${isMine?appT("Eliminaste este mensaje"):appT("Mensaje eliminado")}'));
check('estados de error/vacío de la bandeja con variables del tema',
  !html.includes('bg-white border border-[#dce1e5] rounded-2xl p-5 text-center text-[#6b7280]">No pudimos cargar') );
check('no se tocaron estilos globales: ningún bloque <style> nuevo con reglas de chat-x',
  !/chat-x-|\.dm-x-/.test(html));

// ---------- C. v2: cabecera, presentación, compositor ----------
check('cabecera: @usuario bajo el nombre (elemento + carga + oculto en grupos)', html.includes('id="chat-room-handle"') && html.includes('_h1.textContent="@"+data.username') && html.includes('getElementById("chat-room-handle")?.classList.add("hidden")'));
check('datos: el perfil de chat expone username y displayName por separado', html.includes('username:data.username||"",displayName:data.displayName||""') && html.includes('otherHandle:other.username||""'));
check('sala: tarjeta de presentación (avatar, nombre, @usuario) solo en DMs y se retira si hay mensajes anteriores',
  html.includes('try{drexChatIntroCreate(container)}catch(_){}') && html.includes('if(currentChatIsGroup||!currentChatRecipient)return;const d=document.createElement("div");d.id="chat-room-intro"') && html.includes('document.getElementById("chat-room-intro")?.remove()'));
check('compositor: foto y GIF dentro del campo redondeado, enviar aparece al escribir (ids y handlers intactos)',
  html.includes('id="chat-photo-btn"') && html.includes('id="chat-gif-btn" onclick="openGifPanel()"') && html.includes('id="chat-send-btn" onclick="sendChatMessage()" class="hidden') && html.includes('id="chat-voice-btn" onclick="drexVoiceStartRecording()"') && html.includes('id="chat-room-input"'));
const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
check('sw.js: versión de caché drex-v134', sw.includes("const DREX_SW_VERSION = 'drex-v134'"));
check('404.html sincronizado con index.html', fs.readFileSync(path.join(__dirname, '..', '404.html'), 'utf8') === html);

console.log('\nRESULTADO: ' + (failures ? failures + ' FALLO(S)' : 'OK'));
process.exit(failures ? 1 : 0);
