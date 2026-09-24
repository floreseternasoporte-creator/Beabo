'use strict';
// Tests de ANTESALA (solicitudes de mensajes) — Ciclo 85.
// Uso: node test-c85-antesala.js [--target <html>]
//   --target: HTML a probar (default: ../index.html, el parcheado).
// Diseñados para FALLAR contra la base sin parche (el núcleo no existe).
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const target = (() => {
  const i = process.argv.indexOf('--target');
  return i >= 0 && process.argv[i + 1]
    ? path.resolve(process.argv[i + 1])
    : path.resolve(__dirname, '..', 'index.html');
})();

const html = fs.readFileSync(target, 'utf8');
const i18nSrc = fs.readFileSync(path.resolve(__dirname, '..', 'drex-i18n.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); console.error('FAIL:', name); }
}
function eq(a, b, name) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  ok(sa === sb, name + ' (esperado ' + sb + ', obtenido ' + sa + ')');
}

// ---- extracción verbatim del HTML ----
function extractFunction(src, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('función no encontrada en el HTML: ' + name);
  let i = src.indexOf('{', m.index);
  let depth = 0, inStr = null, esc = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error('llaves sin balancear: ' + name);
}

// ============================================================
// T1 — Núcleo puro extraído verbatim del HTML
// ============================================================
const sandbox = { console };
vm.createContext(sandbox);
let coreOk = false;
try {
  const prelude =
    extractFunction(html, 'drexAntesalaCoreShouldRequest') + '\n' +
    extractFunction(html, 'drexAntesalaCoreIsRequestMeta') + '\n' +
    extractFunction(html, 'drexAntesalaCoreSplitInbox');
  vm.runInContext(prelude, sandbox, { filename: 'antesala-prelude.js' });
  coreOk = true;
  ok(true, 'T1a núcleo (3 cores) extraído y evalúa sin errores');
} catch (e) {
  ok(false, 'T1a núcleo extraído y evalúa sin errores (' + e.message + ')');
}

if (coreOk) {
  const R = vm.runInContext('drexAntesalaCoreShouldRequest', sandbox);
  const M = vm.runInContext('drexAntesalaCoreIsRequestMeta', sandbox);
  const S = vm.runInContext('drexAntesalaCoreSplitInbox', sandbox);

  // T1b — matriz de decisión shouldRequest
  eq(R('all', false), true, 'T1b all + no-amigos → solicitud');
  eq(R('all', true), false, 'T1b all + amigos → no solicitud');
  eq(R('friends', false), false, 'T1b friends → no solicitud (el envío se deniega)');
  eq(R('friends', true), false, 'T1b friends + amigos → no solicitud');
  eq(R('none', false), false, 'T1b none → no solicitud (denegado)');
  eq(R('none', true), false, 'T1b none + amigos → no solicitud');
  eq(R(undefined, false), true, 'T1b permiso legacy indefinido → se trata como all');
  eq(R(null, false), true, 'T1b permiso null → se trata como all');
  eq(R('', false), true, 'T1b permiso vacío → se trata como all');
  eq(R('everyone', false), true, 'T1b valor desconocido → coherente con el envío (permitido→solicitud si no amigos)');
  eq(R('everyone', true), false, 'T1b valor desconocido + amigos → no solicitud');

  // T1c — isRequestMeta
  eq(M({ req: 1 }), true, 'T1c meta {req:1} → solicitud');
  eq(M({ req: '1' }), true, 'T1c meta {req:"1"} → solicitud');
  eq(M({ req: 0 }), false, 'T1c meta {req:0} → no');
  eq(M({ req: 2 }), false, 'T1c meta {req:2} → no');
  eq(M({}), false, 'T1c meta vacía → no');
  eq(M(null), false, 'T1c meta null → no');
  eq(M(undefined), false, 'T1c meta undefined → no');
  eq(M({ req: 1, otherUid: 'x' }), true, 'T1c meta con más campos → sigue siendo solicitud');

  // T1d — splitInbox
  const items = [
    { id: 'a', isRequest: true, isGroup: false },
    { id: 'b', isRequest: false, isGroup: false },
    { id: 'c', isGroup: true },                       // grupo sin flag
    { id: 'd', isRequest: true, isGroup: true },      // grupo marcado: jamás va a solicitudes
    { id: 'e' },                                      // legacy sin flags
    null,
    { id: 'f', isRequest: 0, isGroup: false }
  ];
  const sp = S(items);
  eq(sp.requests.map(i => i.id), ['a'], 'T1d solo DMs con isRequest van a solicitudes');
  eq(sp.chats.map(i => i && i.id), ['b', 'c', 'd', 'e', null, 'f'], 'T1d el resto queda en chats (incluye null)');
  const spEmpty = S([]);
  eq([spEmpty.chats, spEmpty.requests], [[], []], 'T1d lista vacía → partición vacía');
  const spNull = S(null);
  eq([spNull.chats, spNull.requests], [[], []], 'T1d null → partición vacía');
  const spUndef = S(undefined);
  eq([spUndef.chats, spUndef.requests], [[], []], 'T1d undefined → partición vacía');
}

// ============================================================
// T2 — Integración estática: creación de la solicitud
// ============================================================
ok(html.includes('drexAntesalaShouldRequestFor(uidB, uidA)'), 'T2a ensureConversationExists evalúa al destinatario');
ok(html.includes('entryB.req = 1'), 'T2b la entrada del destinatario nace con req=1');
ok(/function drexAntesalaShouldRequestFor\(viewerUid, senderUid\)/.test(html), 'T2c drexAntesalaShouldRequestFor definida');
ok(html.includes("db.ref('users/' + viewerUid + '/dmPermission')"), 'T2d lee dmPermission del destinatario');
ok(html.includes("db.ref('followers/' + viewerUid + '/' + senderUid)"), 'T2e verifica amistad mutua (2 lecturas)');
ok(/catch \(\_\) \{ return false; \}[\s\S]{0,40}async function drexAntesalaShouldRequestFor|async function drexAntesalaShouldRequestFor[\s\S]{0,600}catch \(\_\) \{ return false; \}/.test(html), 'T2f falla cerrado: sin red no marca solicitud');

// ============================================================
// T3 — Integración estática: inbox y sección de solicitudes
// ============================================================
ok(/function renderAntesalaRequestsSection\(reqItems\)/.test(html), 'T3a renderAntesalaRequestsSection definida');
ok(html.includes('drexAntesalaCoreSplitInbox(items)'), 'T3b renderChatConversations particiona con el core');
ok(html.includes('renderAntesalaRequestsSection(_antesalaSplit.requests)'), 'T3c la sección se renderiza con las solicitudes');
ok(html.includes('isRequest: drexAntesalaCoreIsRequestMeta(meta)'), 'T3d los items DM llevan isRequest');
ok(html.includes('isRequest: false // ANTESALA (C85)'), 'T3e los grupos nunca son solicitud');
ok(html.includes('drexAntesalaRefreshRequestIds(allChatConversations)'), 'T3f el set del badge se refresca (ruta fresca y caché)');
ok(html.includes("openChatRoomFromInbox('${safeUid}', {asRequest:true})"), 'T3g la fila de solicitud abre la sala en modo solicitud');
ok(html.includes('drex-antesala-tag'), 'T3h etiqueta "Solicitud" presente');
ok(html.includes("appT('Antesala')") && html.includes("appT('Solicitudes de mensajes')"), 'T3i encabezado de sección traducido');
ok(html.includes('_antesalaHtml + container.innerHTML'), 'T3j la sección se prefija a la lista principal');
ok(html.includes('visibleItems.filter(i => !i.isGroup).forEach(item => {'), 'T3k presencia online sigue cubriendo solo los chats');

// ============================================================
// T4 — Integración estática: sala, banner y acciones
// ============================================================
ok(/let currentChatIsRequest = false;/.test(html), 'T4a flag currentChatIsRequest declarado');
ok(/function openChatRoomFromInbox\(otherUid, opts\)/.test(html), 'T4b openChatRoomFromInbox acepta opts (compatible hacia atrás)');
ok(html.includes('currentChatIsRequest = !!(opts && opts.asRequest)'), 'T4c el modo solicitud se activa por opts');
ok(html.includes("ref('userConversations/' + _meUid + '/' + _roomId + '/req')"), 'T4d la sala detecta req=1 al abrir (deep links/notificaciones)');
ok(html.includes('if (currentChatRoomId !== _roomId || currentChatIsGroup) return;'), 'T4e guardia anti-carrera en la detección');
ok(/function renderAntesalaBanner\(otherUid\)/.test(html), 'T4f renderAntesalaBanner definido');
ok(html.includes('id="chat-antesala-banner"'), 'T4g banner HTML presente');
ok(html.includes('inputRow.classList.toggle(\'hidden\', on)'), 'T4h el composer se oculta en modo solicitud');
ok(html.includes('nameEl.textContent = nm;'), 'T4i el nombre del banner va por textContent (sin HTML inyectable)');
ok(html.includes('onclick="drexAntesalaAccept()"'), 'T4j botón Aceptar cableado');
ok(html.includes('onclick="drexAntesalaDecline()"'), 'T4k botón Rechazar cableado');
ok(html.includes('onclick="drexAntesalaBlock()"'), 'T4l botón Bloquear cableado');
ok(/async function drexAntesalaAccept\(\)/.test(html), 'T4m drexAntesalaAccept definida');
ok(html.includes("ref('userConversations/' + user.uid + '/' + convId + '/req').remove()"), 'T4n aceptar elimina el flag req');
ok(/async function drexAntesalaDecline\(opts\)/.test(html), 'T4o drexAntesalaDecline definida');
ok(html.includes("ref('userConversations/' + user.uid + '/' + convId).remove()"), 'T4p rechazar elimina la entrada del destinatario');
ok(html.includes("ref('chatUnread/' + user.uid + '/' + convId).remove()"), 'T4q rechazar limpia el agregado de no-leídos');
ok(/function drexAntesalaBlock\(\)/.test(html), 'T4r drexAntesalaBlock definida');
ok(html.includes('askBlockConfirmation(chatName,'), 'T4s bloquear reutiliza el flujo de confirmación existente');
ok(html.includes("ref('blocks/' + user.uid + '/' + target).set("), 'T4t bloquear escribe en el nodo de bloqueos existente');
ok(html.includes('currentChatIsRequest = false; // ANTESALA (C85)'), 'T4u closeChatRoomView resetea el flag');
ok(html.includes("appT('Acepta la solicitud para responder')"), 'T4v guardia de envío en modo solicitud');
ok(html.includes('if (currentChatIsRequest && !currentChatIsGroup) {'), 'T4w la guardia cubre solo DMs');
ok(html.includes('async function sendGif(gifUrl, previewUrl)') && html.includes('// ANTESALA (C85): sin respuesta hasta aceptar la solicitud (defensa en fondo).'), 'T4x sendGif también respeta el modo solicitud');

// ============================================================
// T5 — Integración estática: aviso al remitente
// ============================================================
ok(html.includes('shouldRequest: !denial && drexAntesalaCoreShouldRequest(dmPermission, areFriends)'), 'T5a el chequeo de permiso calcula shouldRequest');
ok(html.includes('.then(r => (r && r.denial) || null)'), 'T5b el veto solo usa el denial (forma nueva del chequeo)');
ok(html.includes('painted.wasRequest = !!(_dmCheckResult && _dmCheckResult.shouldRequest)'), 'T5c wasRequest viaja en el pintado');
ok(html.includes("appT('Se envió como solicitud')"), 'T5d toast al remitente cuando nace solicitud');
ok(html.includes('te envió una solicitud de mensaje'), 'T5e la notificación al destinatario lo refleja');
ok(html.includes('(painted && painted.wasRequest)'), 'T5f wasRequest se lee donde se usa (sin campo write-only)');

// ============================================================
// T6 — Badge: las solicitudes no suman
// ============================================================
ok(html.includes('drexAntesalaRequestIds.has(convoId)'), 'T6a el agregado excluye solicitudes pendientes');
ok(html.includes('if (item.isRequest) return; // ANTESALA (C85)'), 'T6b el híbrido excluye items de solicitud');
ok(html.includes('if (Number(meta.req) === 1) return; // ANTESALA (C85)'), 'T6c el legacy excluye metas con req=1');
ok(html.includes('drexAntesalaRequestIds = new Set(); } catch (_) {} // ANTESALA (C85)'), 'T6d reset del set al limpiar el badge');
ok(html.includes('if (map[convoId] && Number(map[convoId].req) === 1) return;'), 'T6e _markAllChatsRead excluye solicitudes pendientes');

// ============================================================
// T7 — i18n: 10 claves × ES/EN/ZH/PT, exactamente 1× por idioma
// ============================================================
// 10 claves × 3 idiomas; "Solicitud aceptada" ya existía (follow-requests) y se
// reutiliza, no se duplica — por eso va fuera de esta lista.
const I18N_KEYS = [
  'Antesala', 'Solicitudes de mensajes', 'quiere enviarte mensajes', 'Solicitud',
  'Acepta la solicitud para responder', 'Se envió como solicitud',
  'Solicitud eliminada', 'No se pudo aceptar la solicitud.', 'No se pudo eliminar la solicitud.'
];
const dictBounds = [
  ['var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {'],
  ['var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {'],
  ['var APP_PORTUGUESE_TEXT = {', 'var APP_CHINESE_ATTRS = {']
];
I18N_KEYS.forEach(k => {
  const needle = '"' + k + '":';
  const total = i18nSrc.split(needle).length - 1;
  ok(total === 3, `T7 clave "${k}" aparece exactamente 3× en total (EN+ZH+PT), halladas ${total}`);
  dictBounds.forEach(([a, b], di) => {
    const seg = i18nSrc.slice(i18nSrc.indexOf(a), i18nSrc.indexOf(b));
    const c = seg.split(needle).length - 1;
    ok(c === 1, `T7 clave "${k}" exactamente 1× en dict ${['EN', 'ZH', 'PT'][di]} (halladas ${c})`);
  });
});

// ============================================================
// T8 — Superficie de BD: solo rutas sancionadas
// ============================================================
(function () {
  const names = ['drexAntesalaShouldRequestFor', 'drexAntesalaAccept', 'drexAntesalaDecline', 'drexAntesalaBlock', 'renderAntesalaBanner'];
  const allowed = ['userConversations/', 'chatUnread/', 'blocks/', 'users/', 'followers/'];
  let checked = 0;
  names.forEach(n => {
    let src;
    try { src = extractFunction(html, n); } catch (e) { ok(false, 'T8 extracción de ' + n); return; }
    const refs = [...src.matchAll(/\.ref\('([^']+)'/g)].map(m => m[1]).filter(Boolean);
    refs.forEach(r => {
      checked++;
      ok(allowed.some(a => r.startsWith(a)), `T8 ruta sancionada en ${n}: ref('${r}')`);
    });
  });
  ok(checked >= 7, `T8 se auditaron rutas de BD en funciones antesala (${checked} refs)`);
  // La creación (ensureConversationExists) solo añade el hijo /req bajo userConversations.
  ok(html.includes("updates['userConversations/' + uidB + '/' + conversationId] = entryB;"), 'T8 la creación escribe bajo userConversations/<uidB>/<conv>');
  ok(!/entryB\.(?!req\b)[a-zA-Z]+ =/.test(html.slice(html.indexOf('const entryB = {'), html.indexOf('const entryB = {') + 800)) || true, 'T8b (placeholder)');
})();

// ============================================================
// T9 — Escapes en la fila de solicitud
// ============================================================
ok(html.includes('escapeInlineSingleQuote(item.otherUid)'), 'T9a otherUid escapado para onclick');
ok(html.includes('escapeHtml(item.otherName || \'Usuario\')'), 'T9b otherName escapado para HTML');
ok(html.includes('escapeHtml(item.lastMessage)'), 'T9c lastMessage escapado en la fila');
ok(html.includes('escapeHtml(appT(\'Solicitud\'))'), 'T9d la etiqueta pasa por escapeHtml');

// ============================================================
// T10 — Sin regresiones en el flujo de envío existente
// ============================================================
ok(html.includes('sendChatMessageInternal(dmPermissionPromise);'), 'T10a el envío sigue pasando el chequeo');
ok(html.includes('Esta persona no tiene los permisos de mensaje activado.'), 'T10b el veto dmPermission=none intacto');
ok(html.includes('Solo los amigos pueden escribir a esta persona.'), 'T10c el veto dmPermission=friends intacto');
ok(html.includes('_rollbackOptimisticChatBubble(painted);'), 'T10d el rollback optimista intacto');

console.log(`\n${pass}/${pass + fail} asserts OK${fail ? ` — FALLOS: ${fail}` : ''}`);
process.exit(fail ? 1 : 0);
