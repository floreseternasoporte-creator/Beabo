/* C280 (2026-10-07): regresión de la segunda barrida de errores.
 * 1. La notificación de Halloween ya no es un toque muerto.
 * 2. El botón Mensaje del perfil abre la sala ENCIMA (no detrás del perfil).
 * 3. Deslizar/scrollear sobre una foto ya no la abre: solo el toque limpio.
 * 4. Backfill CSS de utilidades que el build estático nunca generó.
 * 5. "Solo admins escriben" se aplica al enviar (texto y stickers).
 * 6. Explorar de Música reproduce/guarda la canción tocada con búsqueda.
 * 7. Borrar un comentario borra también su espejo (Respuestas/Historial).
 * 8. Editar un mensaje se refleja en la sala abierta.
 * 9. Reenviar usa los campos reales y el ID canónico de conversación.
 * 10. Buscar y los perfiles respetan el filtro de visibilidad.
 * 11. Baro: sin claves crudas en la aclaratoria ni categoría zombi.
 * 12. Cambiar de pestaña en el feed no deja contenido de otra pestaña.
 * 13. Salir a la bandeja cierra la sala (no sigue marcando leído).
 * 14. Las opciones de un comentario multilínea vuelven a abrir.
 * 15. Enviar un comentario espera la foto que aún se procesa.
 */
var fs = require('fs');
var path = require('path');
var assert = require('assert');
var ROOT = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var i18n = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');
var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}
function sliceFrom(marker, len) {
  var i = html.indexOf(marker);
  assert(i !== -1, 'no se encontró: ' + marker);
  return html.slice(i, i + len);
}

test('la notificación de Halloween abre el evento', function () {
  var seg = sliceFrom('function handleNotificationNavigation', 6000);
  assert(seg.indexOf("case 'halloween_event':") !== -1, 'falta el caso halloween_event');
  assert(seg.indexOf('openHalloweenEvent()') !== -1, 'debe abrir el evento');
});

test('el botón Mensaje del perfil baja el perfil antes de abrir la sala', function () {
  var seg = sliceFrom('function openChatFromUserSelection(uid)', 1500);
  assert(seg.indexOf('author-profile-modal') !== -1, 'debe ocultar el perfil de autor');
  assert(seg.indexOf('openChatRoomFromInbox(uid)') !== -1, 'debe abrir la sala');
  assert(seg.indexOf('author-profile-modal') < seg.indexOf('openChatRoomFromInbox(uid)'), 'el perfil se baja ANTES de abrir la sala');
  var room = sliceFrom('function openChatRoomFromInbox(otherUid', 2600);
  assert(room.indexOf('author-profile-modal') !== -1, 'la sala no debe quedar bajo el perfil');
});

test('deslizar sobre una foto del feed no la abre', function () {
  var seg = sliceFrom('function drexFdEnhanceCard(card)', 6000);
  assert(seg.indexOf("addEventListener('touchmove'") !== -1, 'debe seguir el gesto');
  assert(seg.indexOf('touchMoved') !== -1 && seg.indexOf('> 10') !== -1, 'umbral de deslizamiento');
  assert(seg.indexOf('if (touchMoved) { touchMoved = false; clearSingle(); return; }') !== -1, 'el deslizamiento no dispara el toque');
  assert(html.indexOf('__drexScrollTapGuard') !== -1, 'guardia global para portadas/avatar/cuadrículas');
});

test('el backfill CSS trae las utilidades faltantes', function () {
  var needles = ['.bg-red-500{', '.-mb-px{', '.z-\\[9\\]{', '.bottom-3{', '.min-h-\\[46px\\]{',
    'color-mix(in srgb,var(--theme-bg) 95%,transparent)', '.sm\\:h-\\[136px\\]{',
    '.text-\\[\\#B45309\\]{', '.bg-\\[\\#F59E0B\\]{', '.p-\\[1\\.5px\\]{'];
  needles.forEach(function (n) {
    assert(html.indexOf(n) !== -1, 'falta la regla: ' + n);
  });
});

test('"Solo admins escriben" bloquea texto y stickers', function () {
  assert(html.indexOf('async function _groupAdminsOnlyBlocks()') !== -1, 'falta el candado de grupo');
  var send = sliceFrom('function sendChatMessage()', 1600);
  assert(send.indexOf('_groupAdminsOnlyBlocks()') !== -1, 'el texto debe consultarlo');
  var stk = sliceFrom('async function sendChatSticker(stickerId)', 2600);
  assert(stk.indexOf('_groupAdminsOnlyBlocks()') !== -1, 'el sticker debe consultarlo');
  assert(i18n.indexOf('Solo los administradores pueden escribir en este grupo') !== -1, 'el aviso debe estar traducido');
});

test('Explorar de Música resuelve contra la lista filtrada', function () {
  assert(html.indexOf('musicExploreRendered = arr;') !== -1, 'debe guardarse la lista pintada');
  assert(html.indexOf('musicExploreRendered && musicExploreRendered.length ? musicExploreRendered : musicExploreCache') !== -1, 'play/fav deben usar la lista pintada');
});

test('borrar un comentario borra su espejo userComments', function () {
  var seg = sliceFrom('function deleteComment(noteId, commentPath)', 3400);
  assert(seg.indexOf("'userComments/' + c.authorId + '/' + key") !== -1, 'debe borrar el espejo propio y el de respuestas');
  assert(seg.indexOf('pushMirror(comment') !== -1, 'debe recoger los espejos antes de borrar');
});

test('editar un mensaje se refleja en la sala abierta', function () {
  var seg = sliceFrom('const changedCallback = changedSnap => {', 4200);
  assert(seg.indexOf('renderMessageNode(changedMsg, changedKey)') !== -1, 'el child_changed debe re-pintar el mensaje editado');
  assert(seg.indexOf('chatMessagesMemoryCache.set(conversationId, updated)') !== -1, 'debe actualizar el caché');
});

test('reenviar usa campos reales, ID canónico y fan-out', function () {
  var list = sliceFrom('function renderForwardList(convs)', 2200);
  assert(list.indexOf('c.otherName') !== -1 && list.indexOf('c.groupName') !== -1, 'la lista debe pintar los campos reales');
  assert(list.indexOf('c.convId') === -1 && list.indexOf('c.displayName') === -1, 'no debe usar campos inexistentes');
  var fwd = sliceFrom('async function doForwardMessage(', 6800);
  assert(fwd.indexOf('getDirectConversationId') !== -1, 'el destino DM debe ser el ID canónico');
  assert(fwd.indexOf("ids[0] + '_' + ids[1]") === -1, 'el fallback con un solo guion bajo debe desaparecer');
  assert(fwd.indexOf('updateChatConversationPreview(preview, payload, {') !== -1, 'debe hacer el fan-out de bandejas');
});

test('Buscar y perfiles aplican el filtro de visibilidad', function () {
  var search = sliceFrom('function performRealTimeSearch()', 6500);
  assert(search.indexOf('shouldHideNoteForCurrentUser(note.id, note)') !== -1, 'Buscar debe ocultar lo que el feed oculta');
  var posts = sliceFrom('function _loadAuthorPostsContent(authorId, container)', 4200);
  assert(posts.indexOf('const visiblePosts = posts.filter') !== -1, 'Publicaciones del autor debe filtrar');
  assert(html.indexOf('const visibleNotes = orderedNotes.filter') !== -1, 'Multimedia del autor debe filtrar');
  assert(html.indexOf('function _authorTabLoad(tab, authorId)') !== -1, 'Respuestas/Multimedia deben pasar el candado de cuenta privada');
});

test('Baro no filtra claves crudas ni escribe la clave "null"', function () {
  assert(html.indexOf('function baroIntentLabelSafe(intent, ctx)') !== -1, 'falta el resolvedor seguro de nombres');
  assert(html.indexOf('typeof baroL1IntentName') === -1, 'baroL1IntentName no existe: no debe llamarse');
  var words = sliceFrom('var J_NOTIF_WORDS', 700);
  assert(words.indexOf('correccion') === -1, 'la categoría eliminada no debe mapear a null');
  assert(html.indexOf('function jApplyNotif(key) { if (!key) return false;') !== -1, 'jApplyNotif debe rechazar claves vacías');
});

test('la última pestaña del feed gana, no la última respuesta', function () {
  assert(html.indexOf('window.__drexLoadNotesGen') !== -1, 'falta la generación de carga');
  var seg = sliceFrom('function loadNotes(', 4200);
  assert(seg.indexOf('if (myLoadGen !== window.__drexLoadNotesGen) return;') !== -1, 'la carga superada no debe suscribirse');
});

test('salir a la bandeja cierra la sala de verdad', function () {
  var seg = sliceFrom('function openChatInboxView()', 1800);
  assert(seg.indexOf('closeChatRoomView()') !== -1, 'debe pasar por el cierre completo');
});

test('las opciones de un comentario multilínea pueden abrir', function () {
  var seg = sliceFrom('function escapeInlineSingleQuote(value)', 900);
  assert(seg.indexOf("\\n/g") !== -1 && seg.indexOf("\\r/g") !== -1, 'deben escaparse CR/LF para el literal inline');
});

test('enviar un comentario espera la foto en proceso', function () {
  assert(html.indexOf('let commentPhotoPromise = null;') !== -1, 'debe rastrearse el procesamiento');
  var seg = sliceFrom('async function submitComment()', 3200);
  assert(seg.indexOf('await commentPhotoPromise') !== -1, 'Enviar debe esperar la foto');
});

test('cambiar de sala no pinta cabecera ni fotos de la sala anterior', function () {
  assert(html.indexOf('if (currentChatRoomId !== groupId || !currentChatIsGroup) return;') !== -1, 'cabecera de grupo anti-carrera');
  assert(html.indexOf('const roomAtStart = currentChatRoomId;') !== -1, 'retícula de fotos anti-carrera');
});

console.log(passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
