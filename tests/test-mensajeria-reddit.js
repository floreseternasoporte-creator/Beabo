// Mensajería estilo Reddit-chat: solicitudes, menú de cabecera, respuestas con cita,
// "escribiendo…", búsqueda en la conversación, editar/eliminar con marcas.
// Pruebas conductuales (funciones reales extraídas de index.html, ejecutadas en vm) + guardias de fuente.
// Uso: node tests/test-mensajeria-reddit.js [ruta/index.html]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
let failures = 0;
function check(name, cond) { console.log((cond ? '  OK  ' : '  FAIL ') + name); if (!cond) failures++; }
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
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- 1. Solicitudes: regla "no sigues al remitente" ----------
{
  const code = ['drexAntesalaCoreShouldRequest', 'drexAntesalaCoreSplitInbox'].map(n => extractFn(html, n)).join('\n');
  const c = {}; vm.createContext(c); vm.runInContext(code, c);
  check('solicitudes: remitente al que NO sigues y permiso "all" => solicitud', c.drexAntesalaCoreShouldRequest('all', false) === true);
  check('solicitudes: remitente al que sí sigues => chat normal', c.drexAntesalaCoreShouldRequest('all', true) === false);
  check('solicitudes: permisos "none"/"friends" no generan solicitud (se bloquean antes)', c.drexAntesalaCoreShouldRequest('none', false) === false && c.drexAntesalaCoreShouldRequest('friends', false) === false);
  const sp = c.drexAntesalaCoreSplitInbox([{ id: 'a' }, { id: 'b', isRequest: true }, { id: 'g', isRequest: true, isGroup: true }]);
  check('solicitudes: separa solicitudes de chats (grupos nunca son solicitud)', sp.requests.length === 1 && sp.requests[0].id === 'b' && sp.chats.length === 2);
  check('solicitudes: usa "el espectador sigue al remitente" (followers/{remitente}/{espectador})', html.includes('db.ref("followers/"+senderUid+"/"+viewerUid).once("value")') && html.includes('drexAntesalaCoreShouldRequest(dmPermission,viewerFollowsSender)'));
  check('solicitudes: vista propia con Aceptar / Ignorar / Reportar', html.includes('id="chat-requests-view"') && html.includes('onclick="drexRequestAccept(') && html.includes('onclick="drexRequestIgnore(') && html.includes('onclick="drexRequestReport('));
  check('solicitudes: la bandeja muestra una sola entrada que abre la vista', html.includes('onclick="openChatRequestsView()"') && html.includes('function closeChatRequestsView(){'));
  check('solicitudes: aceptar/ignorar aceptan un convId (sirven desde la lista)', html.includes('async function drexAntesalaAccept(convIdOpt){') && html.includes('async function drexAntesalaDecline(opts){') && html.includes('opts&&opts.convId||currentChatRoomId'));
  check('solicitudes: el banner de la sala ofrece Ignorar y Reportar', html.includes('id="chat-antesala-report" onclick="drexAntesalaReport()"') && html.includes('onclick="drexAntesalaDecline()" class="drex-antesala-decline">Ignorar<'));
  // render de la entrada
  const names = ['drexInboxDisplayName', 'drexInboxIsPlaceholderMsg', 'isLegacyChatConversationUnread', 'isChatConversationUnread', 'renderAntesalaRequestsSection'];
  const ctx = { appT: s => s, escapeHtml: esc, document: { getElementById: () => null }, localStorage: { getItem: () => null }, fiestaStripEmoji: x => x, drexChatLocale: () => 'es', getAppLanguage: () => 'es', drexRequestsViewRefresh() {}, chatUnreadAggActive: false, chatUnreadAggCache: {}, DrexCloud: { auth: () => ({ currentUser: { uid: 'me' } }) } };
  vm.createContext(ctx);
  try {
    vm.runInContext(names.map(n => extractFn(html, n)).filter(Boolean).join('\n'), ctx);
    const out = ctx.renderAntesalaRequestsSection([{ id: 'r1', otherName: 'marta', otherDisplayName: 'Marta' }, { id: 'r2', otherName: 'dani' }, { id: 'r3', otherName: 'x' }]);
    check('solicitudes: la entrada muestra título, contador y primeros nombres', out.includes('Solicitudes de mensajes') && out.includes('>3<') && out.includes('Marta'));
    check('solicitudes: sin solicitudes no se pinta nada', ctx.renderAntesalaRequestsSection([]) === '');
  } catch (e) { check('solicitudes: render de la entrada (' + e.message + ')', false); }
}

// ---------- 2. Menú de cabecera ----------
check('menú: kebab abre #chat-header-menu (el icono de info ya no ocupa la cabecera)', html.includes('onclick="openChatHeaderMenu()" class="msg-head-btn"') && html.includes('id="chat-header-menu"'));
check('menú: acciones buscar / silenciar / reportar / bloquear / detalles reutilizan las funciones existentes',
  ['toggleChatMessageSearch', 'openChatMutePanel()', 'blockUserFromChat()', 'reportUserFromChat()', 'openChatRoomInfo()'].every(f => extractFn(html, 'drexChatMenuAction').includes(f)));
check('menú: en grupos se ocultan las acciones solo-DM', html.includes('m.querySelectorAll("[data-dm-only]").forEach(el=>el.classList.toggle("hidden",!dm))'));

// ---------- 3. Respuesta con cita ----------
{
  const ctx = { appT: s => s, escapeHtml: esc, fiestaStripEmoji: x => x, document: {}, CSS: { escape: s => s } };
  vm.createContext(ctx);
  vm.runInContext(extractFn(html, 'drexReplyQuoteHtml'), ctx);
  const q = ctx.drexReplyQuoteHtml({ msgId: '-Abc_1', senderName: 'Ana', text: '<b>hola</b>' }, false, true);
  check('cita: nombre y texto escapados, con salto al mensaje original', q.includes('Ana') && q.includes('&lt;b&gt;hola') && !q.includes('<b>hola') && q.includes('data-reply-jump="-Abc_1"') && q.includes('drexJumpToChatMsg('));
  check('cita: sin id válido no es pulsable (no inyecta atributos)', !ctx.drexReplyQuoteHtml({ msgId: '"><x', senderName: 'A', text: 't' }, false, true).includes('data-reply-jump'));
  check('cita: foto y audio muestran etiqueta en vez de texto vacío', ctx.drexReplyQuoteHtml({ senderName: 'A', image: 'u' }, true, false).includes('Foto') && ctx.drexReplyQuoteHtml({ senderName: 'A', files: [{ voice: true }] }, true, false).includes('Audio'));
  check('cita: mensajes recibidos y optimistas usan el mismo generador', html.includes('const replyBlock=msg.replyTo?drexReplyQuoteHtml(msg.replyTo,mine,true):""') && html.includes('const replyHtml=payload.replyTo?drexReplyQuoteHtml(payload.replyTo,true,false):""'));
  check('cita: copiar toma el texto del mensaje, no el de la cita', html.includes('[data-msg-id="${msgId}"] .chat-msg-text`)||'));
  check('cita: saltar carga mensajes anteriores si hace falta y avisa si ya no existe', html.includes('El mensaje original ya no está disponible') && extractFn(html, 'drexJumpToChatMsg').includes('drexLoadOlderChatMessages'));
}

// ---------- 4. Escribiendo… ----------
check('escribiendo: el indicador caduca solo (sin eventos nuevos se oculta a los ~5 s)', html.includes('window._chatTypingStale=setTimeout(()=>{try{callback(snapshot)}catch(_){}},5200)') && html.includes('function detachChatTypingListener(){try{clearTimeout(window._chatTypingStale)}catch(_){}'));
check('escribiendo: enviar un mensaje borra el estado de escritura', html.includes('!pendingFilesEarly.length)return;try{stopChatTyping();_lastChatTypingSentAt=0}catch(_){}'));

// ---------- 5. Búsqueda en la conversación ----------
{
  const bubbles = [['x1', 'Hola Proyecto'], ['x2', 'nada'], ['x3', 'el PROYECTO final']].map(([id, t]) => ({ id, textContent: 'cita proyecto ' + t, classList: { add() {}, remove() {} }, style: {}, scrollIntoView() {}, querySelector: sel => (sel === '.chat-msg-text' ? { textContent: t } : null) }));
  const labels = { 'chat-search-results-count': { textContent: '' } };
  const container = { querySelectorAll: sel => (sel === '.msg-bubble' ? bubbles : []) };
  const ctx = { appT: s => s, document: { getElementById: id => (id === 'chat-room-messages' ? container : (labels[id] || null)), }, normalizeForMatch: s => String(s || '').toLowerCase(), currentChatRoomId: 'c', window: {} };
  vm.createContext(ctx);
  vm.runInContext('let _chatSearchHits=[],_chatSearchIdx=-1,_chatSearchSeq=0,_chatSearchQuery="";' + ['_chatSearchPaint', '_chatSearchCompute', 'searchMessagesInCurrentChat', 'drexChatSearchStep'].map(n => extractFn(html, n)).join('\n'), ctx);
  ctx.searchMessagesInCurrentChat('proyecto');
  check('búsqueda: solo cuenta el texto de cada mensaje (no la cita) y muestra "{a} de {b}"', labels['chat-search-results-count'].textContent === '2 de 2');
  vm.runInContext('drexChatSearchStep(-1)', ctx);
  check('búsqueda: anterior/siguiente recorre los resultados', labels['chat-search-results-count'].textContent === '1 de 2');
  ctx.searchMessagesInCurrentChat('zzz');
  check('búsqueda: sin coincidencias muestra "Sin resultados"', labels['chat-search-results-count'].textContent === 'Sin resultados');
  check('búsqueda: panel con anterior/siguiente/cerrar y sin cadena "resultado(s)" fija', html.includes('onclick="drexChatSearchStep(1)"') && html.includes('onclick="drexChatSearchStep(-1)"') && !html.includes('resultado(s)'));
}

// ---------- 6. Editar / eliminar ----------
check('editar: solo se ofrece en mensajes propios con texto', html.includes('editRow.classList.toggle("hidden",!(mine&&drexMsgHasText(msgId)))'));
check('editar: marca "Editado" dentro de la burbuja (también en mensajes que no son el último del grupo)', html.includes('_et.className="drex-edited-tag') && html.includes('_et.textContent=appT("Editado")'));
check('editar: sincroniza la vista previa de la bandeja si era el último mensaje', html.includes('modal.classList.add("hidden");drexSyncPreviewAfterEdit(msgId,newText);') && extractFn(html, 'drexSyncPreviewAfterEdit').includes('limitToLast(1)'));
check('eliminar para todos: deja la marca "Eliminaste este mensaje" en vez de desaparecer', html.includes('_tombstoneChatMsgNode(msgId);') && extractFn(html, '_tombstoneChatMsgNode').includes('Eliminaste este mensaje'));

// ---------- 7. Infra ----------
const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
check('sw.js: versión de caché drex-v134', sw.includes("const DREX_SW_VERSION = 'drex-v134'"));
check('404.html sincronizado con index.html', fs.readFileSync(path.join(__dirname, '..', '404.html'), 'utf8') === html);
const keys = ['Ignorar', 'El mensaje original ya no está disponible', '{a} de {b}', 'Mensajes de personas que no sigues. Acepta para responder.'];
['en', 'pt', 'fr', 'ja', 'ko', 'zh'].forEach(l => {
  const t = fs.readFileSync(path.join(__dirname, '..', 'drex-i18n-' + l + '.js'), 'utf8');
  check('i18n ' + l + ': claves nuevas de mensajería', keys.every(k => t.includes(JSON.stringify(k))));
});

console.log('\nRESULTADO: ' + (failures ? failures + ' FALLO(S)' : 'OK'));
process.exit(failures ? 1 : 0);
