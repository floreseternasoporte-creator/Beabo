/* C282 (2026-10-07): regresión de la cuarta barrida de errores.
 * 1. Un post programado conserva grupo, etiqueta, spoiler y "contenido
 *    fuerte" del editor (antes salía público y al descubierto).
 * 2. Al retomar un borrador, el editor recupera esas mismas opciones.
 * 3. Programar una encuesta ya no deja un borrador duplicado fantasma.
 * 4. Salir del editor con fotos/video/GIF avisa que el borrador no los
 *    incluye (antes se perdían en silencio).
 * 5. Silenciar un chat detiene también sus avisos e insignia, no solo
 *    el sonido.
 * 6. La limpieza de 30 días ya no borra notificaciones sin leer.
 * 7. Apagar una categoría de avisos se refleja en menos de un minuto.
 * 8. La notificación de "nueva canción" siempre tiene destino.
 * 9. Actividad conserva el desplazamiento al llegar avisos nuevos.
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

test('el borrador guarda grupo, etiqueta y velos del editor', function () {
  var seg = sliceFrom('function collectCurrentNoteDraft()', 1600);
  assert(seg.indexOf('draft.groupId = selectedGroupForPost.id') !== -1, 'grupo');
  assert(seg.indexOf('draft.flair = selectedNoteFlair') !== -1, 'etiqueta');
  assert(seg.indexOf('draft.sensitive = true') !== -1, 'contenido fuerte');
  assert(seg.indexOf('draft.spoiler = true') !== -1, 'spoiler');
});

test('el post programado publica con grupo, etiqueta y velos', function () {
  var seg = sliceFrom('function drexSchedBuildNote(draft, user, userData)', 2200);
  assert(seg.indexOf("_note.groupId = draft.groupId") !== -1, 'grupo');
  assert(seg.indexOf('_note.flair = draft.flair') !== -1, 'etiqueta');
  assert(seg.indexOf('_note.sensitive = true') !== -1, 'contenido fuerte');
  assert(seg.indexOf('_note.spoiler = true') !== -1, 'spoiler');
});

test('al retomar un borrador, el editor recupera sus opciones', function () {
  var seg = sliceFrom('function loadCurrentNoteDraft(', 3200);
  assert(seg.indexOf('selectedGroupForPost = draft.groupId ?') !== -1, 'grupo');
  assert(seg.indexOf('notePostIsSensitive = !!draft.sensitive') !== -1, 'contenido fuerte');
  assert(seg.indexOf('notePostIsSpoiler = !!draft.spoiler') !== -1, 'spoiler');
});

test('programar una encuesta no deja duplicado fantasma', function () {
  var seg = sliceFrom('function confirmSchedulePost()', 4200);
  assert(seg.indexOf("notePostPoll = { options: [], hours: 24 }") !== -1, 'el cierre no debe re-guardar la encuesta');
  assert(seg.indexOf('notePostPoll = { options: [], hours: 24 }') < seg.indexOf('closeNoteCreationFullscreen();'), 'se vacía ANTES de cerrar');
});

test('salir con adjuntos avisa que el borrador no los guarda', function () {
  var seg = sliceFrom('function closeNoteCreationFullscreen()', 1100);
  assert(seg.indexOf('notePostImageFiles') !== -1 && seg.indexOf('selectedNotePostGif') !== -1, 'debe detectar adjuntos');
  assert(seg.indexOf("appT('El borrador guarda solo el texto: las fotos y el video no se incluyen.')") !== -1, 'debe avisar');
  assert(i18n.indexOf('photos and video are not included') !== -1, 'aviso traducido');
});

test('silenciar un chat detiene sus avisos, no solo el sonido', function () {
  assert(html.indexOf('async function isChatMutedForNotify(userId, meta)') !== -1, 'falta la consulta de silencio');
  var seg = sliceFrom('async function addNotification(', 800);
  assert(seg.indexOf("type === 'message' && await isChatMutedForNotify(userId, meta)") !== -1, 'addNotification debe respetar el silencio');
});

test('la limpieza de 30 días conserva las notificaciones sin leer', function () {
  var seg = sliceFrom('const NOTIF_MAX_AGE_MS', 700);
  assert(seg.indexOf('if (v && v.read === true) child.ref.remove()') !== -1, 'solo se borran las leídas');
});

test('apagar una categoría se refleja en menos de un minuto', function () {
  var seg = sliceFrom('async function shouldSkipNotificationFor(', 1400);
  assert(seg.indexOf('now - cached.ts < 60 * 1000') !== -1, 'caché de preferencias a 60 s');
});

test('la notificación de nueva canción siempre tiene destino', function () {
  assert(html.indexOf(": { actionType: 'profile', actionId: uid }") !== -1, 'sin anuncio en el feed, la fila lleva al artista');
});

test('Actividad conserva el desplazamiento al re-pintar', function () {
  var seg = sliceFrom('function renderNotificationsList(userId, itemsOverride)', 700);
  assert(seg.indexOf('const _prevScrollTop = notificationsList.scrollTop || 0;') !== -1, 'captura el desplazamiento');
  assert(html.indexOf('if (_prevScrollTop) { try { notificationsList.scrollTop = _prevScrollTop; } catch (_) {} }') !== -1, 'lo restaura tras pintar');
});

test('el enlace directo respeta la privacidad de la cuenta', function () {
  var seg = sliceFrom('function openPostPermalink(', 3800);
  assert(seg.indexOf('await isAccountPrivate(authorId) && !(await canCurrentUserViewPrivateAccount(authorId))') !== -1, 'puerta de cuenta privada');
  assert(seg.indexOf('Esta cuenta es privada. Sigue a esta persona para ver sus publicaciones.') !== -1, 'mensaje privado');
});

test('los comentarios por enlace profundo respetan la cuenta privada', function () {
  var seg = sliceFrom('C282: shouldHideNoteForCurrentUser no mira', 1600); // C286: entre medias vive el bloqueo inverso
  assert(seg.indexOf('await isAccountPrivate(_cvAuthor) && !(await canCurrentUserViewPrivateAccount(_cvAuthor))') !== -1, 'puerta en comentarios');
});

test('las listas de seguidores/seguidos exigen poder ver la cuenta', function () {
  assert(html.indexOf('async function _drexRelationListPrivateBlocked(targetId)') !== -1, 'helper de puerta');
  var f = sliceFrom('async function openFollowersModal(', 1100);
  var g = sliceFrom('async function openFollowingModal(', 1100);
  assert(f.indexOf('_drexRelationListPrivateBlocked(targetId)') !== -1, 'seguidores');
  assert(g.indexOf('_drexRelationListPrivateBlocked(targetId)') !== -1, 'seguidos');
});

test('ser aceptado por una cuenta privada se refleja sin reiniciar', function () {
  assert(html.indexOf('var _PRIV_CACHE_TTL_MS = 60 * 1000;') !== -1, 'TTL definido');
  var seg = sliceFrom('async function canCurrentUserViewPrivateAccount(', 900);
  assert(seg.indexOf('(Date.now() - hitF.ts) < _PRIV_CACHE_TTL_MS') !== -1, 'aprobación caduca');
  var seg2 = sliceFrom('async function isAccountPrivate(', 700);
  assert(seg2.indexOf('(Date.now() - hit.ts) < _PRIV_CACHE_TTL_MS') !== -1, 'privacidad caduca');
});

test('dejar de seguir desde el perfil apaga los botones rápidos', function () {
  assert(html.indexOf('function _syncQuickFollowButtonsAfterProfileToggle(targetUserId, state)') !== -1, 'helper de sincronía');
  assert(html.indexOf("_syncQuickFollowButtonsAfterProfileToggle(currentViewedAuthorId, 'none')") !== -1, 'perfil: dejar de seguir');
  assert(html.indexOf("_syncQuickFollowButtonsAfterProfileToggle(targetId, 'following')") !== -1, 'hoja: seguir');
});

test('la hoja de acciones dice "Cancelar solicitud" con solicitud viva', function () {
  var seg = sliceFrom('function openUserActionsSheet()', 2600);
  assert(seg.indexOf('followRequests/') !== -1 && seg.indexOf("'Cancelar solicitud'") !== -1, 'etiqueta honesta');
});

test('si te bloquearon, el perfil no abre ni deja visita', function () {
  var seg = sliceFrom('async function openAuthorProfile(authorId, origin = ', 900);
  assert(seg.indexOf("'blocks/' + authorId + '/' + _cu0.uid") !== -1, 'bloqueo inverso al abrir');
  var v = sliceFrom('async function drexRecordProfileVisit(', 1500);
  assert(v.indexOf("blocks/' + ownerUid + '/' + me.uid") !== -1, 'sin registro de visita con bloqueo');
});

console.log(passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
