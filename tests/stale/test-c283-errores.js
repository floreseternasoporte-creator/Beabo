/* C283 (2026-10-07): regresión de la quinta barrida de errores.
 * Música: página de artista y seguidores con puerta de privacidad;
 * enlace de canción con bloqueo/privacidad; Explorar excluye
 * bloqueados; instantáneas completas (autor/letra/anuncio); duración
 * Infinity al publicar; botón "Solicitado" real; reproducciones que
 * se cuentan al sonar y sin reinicio al retocar la fila; Top semanal
 * con caché; género visible en las filas.
 * Perfil: portada visible en grande y en el editor; bio al momento;
 * comentarios guardados listados; eliminar cuenta cierra sesión;
 * foto nueva llega a la barra; @usuario real en desactivar/eliminar;
 * fallo al guardar avisa y no deja reservas de nombre cruzadas.
 * Destellos/Halloween: bandeja respeta privacidad y bloqueo inverso;
 * ventana mayor con filtro; evento responde a Atrás y cierra el
 * registro al terminar; el aviso de elegido no se pierde.
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

test('la página de artista de Música respeta cuentas privadas', function () {
  assert(html.indexOf('function _musicOpenArtistProfileImpl(authorId)') !== -1, 'impl presente');
  var seg = sliceFrom('window.musicOpenArtistProfile = function (authorId) {', 1500);
  assert(seg.indexOf('Esta cuenta es privada. Sigue a esta persona para ver su música.') !== -1, 'mensaje privado');
});

test('los seguidores del artista pasan por la puerta de privacidad', function () {
  assert(html.indexOf('function _musicOpenFollowersImpl()') !== -1, 'impl presente');
  var seg = sliceFrom('window.musicOpenFollowers = function () {', 900);
  assert(seg.indexOf('canCurrentUserViewPrivateAccount(uid)') !== -1, 'puerta');
});

test('el enlace de canción respeta bloqueo y privacidad', function () {
  var seg = sliceFrom('window.openMusicTrackFromFeed = function (trackId) {', 1700);
  assert(seg.indexOf('isAccountBlockedForCurrentUser(_aid)') !== -1, 'bloqueo');
  assert(seg.indexOf('await isAccountPrivate(_aid)') !== -1, 'privacidad');
});

test('Explorar excluye autores bloqueados', function () {
  var seg = sliceFrom('function loadExploreMusic() {', 1100);
  assert(seg.indexOf('musicExploreCache = arr.filter(') !== -1, 'filtro de bloqueados');
});

test('las instantáneas guardan autor, letra y anuncio', function () {
  var s1 = sliceFrom('function musicTrackSnapshot(t) {', 600);
  assert(s1.indexOf('authorId: t.authorId') !== -1 && s1.indexOf('announceNoteId: t.announceNoteId') !== -1, 'guardadas');
  var s2 = sliceFrom('function musicHistoryRecord(t) {', 700);
  assert(s2.indexOf('authorId: t.authorId') !== -1 && s2.indexOf('lyrics: t.lyrics') !== -1, 'historial');
  assert(html.indexOf("'/announceNoteId').once('value')") !== -1, 'búsqueda hidrata el anuncio');
});

test('duración Infinity al elegir audio ya no bloquea la publicación', function () {
  var seg = sliceFrom('window.handleMusicAudioSelect = function (event) {', 2600);
  assert(seg.indexOf("probe.addEventListener('durationchange', onDur)") !== -1, 'truco de duración real');
});

test('seguir a artista privado pinta "Solicitado"', function () {
  assert(html.indexOf("state === 'requested'") !== -1, 'estado pintado');
  var seg = sliceFrom('window.musicToggleFollowArtist = async function (artistId) {', 4500);
  assert(seg.indexOf("musicPaintFollowButtons('requested')") !== -1, 'repintado tras solicitar');
});

test('la reproducción se cuenta al sonar y la fila actual no reinicia', function () {
  var seg = sliceFrom('function musicStartTrack(t) {', 1700);
  assert(seg.indexOf("audio.addEventListener('playing', _countedPlay)") !== -1, 'conteo al sonar');
  assert(seg.indexOf('musicCurrentTrackId() === t.id && audio && audio.src') !== -1, 'sin reinicio');
});

test('el Top semanal no se relee en cada play/pausa', function () {
  var seg = sliceFrom('function renderMusicTop() {', 1600);
  assert(seg.indexOf('_musicTopWeeklyCache') !== -1, 'caché de 30 s');
});

test('el género se ve en las filas de canciones', function () {
  var seg = sliceFrom('function musicTrackRowHTML(t, i, ctx, withActions) {', 1200);
  assert(seg.indexOf('t.genre') !== -1, 'género visible');
});

test('la portada se puede ver en grande y el editor la reconoce', function () {
  var seg = sliceFrom('function openCoverFullscreen(src) {', 500);
  assert(seg.indexOf("!src.includes('data:')") === -1, 'sin rechazo de data URL');
  assert(seg.indexOf("src.startsWith('data:image/svg+xml')") !== -1, 'solo se bloquea el gris');
  assert(html.indexOf("currentCover.startsWith('data:image/svg+xml')") !== -1, 'editor reconoce la portada');
});

test('la bio guardada se refleja sin recargar', function () {
  var seg = sliceFrom('function saveProfileField(', 8200);
  assert(seg.indexOf("getElementById('profile-bio-display')") !== -1, 'pinta la bio');
});

test('los comentarios guardados se listan en Guardados', function () {
  assert(html.indexOf('async function renderSavedCommentsSection()') !== -1, 'sección presente');
  assert(html.indexOf('renderSavedCommentsSection();') !== -1, 'se pinta al abrir Guardados');
  assert(html.indexOf('async function removeSavedCommentByKey(') !== -1, 'quitar de la lista');
  assert(i18n.indexOf('Saved comments') !== -1, 'título traducido');
});

test('pedir eliminar la cuenta cierra la sesión', function () {
  var seg = sliceFrom('function confirmDeleteAccount() {', 1400);
  assert(seg.indexOf('DrexCloud.auth().signOut()') !== -1, 'cierra sesión');
});

test('la foto nueva llega a la barra inferior y el input se limpia', function () {
  var seg = sliceFrom('async function saveNewProfilePhoto() {', 2200);
  assert(seg.indexOf("getElementById('header-profile-image')") !== -1, 'barra actualizada');
  assert(seg.indexOf("fileInput.value = ''") !== -1, 'input limpio');
});

test('desactivar/eliminar muestran tu @usuario real', function () {
  assert(html.indexOf("getElementById('deactivate-username-display')") !== -1, 'desactivar');
  var seg = sliceFrom('function selectDeleteReason(reason) {', 700);
  assert(seg.indexOf("'/username').once('value')") !== -1, 'lee el usuario real');
});

test('si guardar el perfil falla, avisa y no cruza reservas de nombre', function () {
  var seg = sliceFrom('function saveProfileField(', 9500);
  assert(seg.indexOf('No se pudieron guardar los cambios.') !== -1, 'aviso de fallo');
  assert(seg.indexOf('se libera DESPUÉS de guardar') !== -1, 'liberación tras guardar');
});

test('los Destellos respetan privacidad y bloqueo inverso', function () {
  var seg = sliceFrom('async function drexSnapLoadTray() {', 3200);
  assert(seg.indexOf("'blocks/' + a + '/' + me") !== -1, 'bloqueo inverso');
  assert(seg.indexOf('canCurrentUserViewPrivateAccount(a)') !== -1, 'privacidad');
  assert(seg.indexOf('? 200 : DREX_SNAP_TRAY_LIMIT') !== -1, 'ventana mayor con filtro');
});

test('Halloween: Atrás cierra, el registro termina y el aviso no se pierde', function () {
  assert(html.indexOf("['halloween-event-view', () => typeof closeHalloweenEvent === 'function'") !== -1, 'registrada en capas');
  var reg = sliceFrom('async function registerHalloweenEvent() {', 700);
  assert(reg.indexOf('Date.now() > DREX_HALLOWEEN_ENDS') !== -1, 'registro cerrado al terminar');
  var ann = sliceFrom('async function drexHalloweenMaybeAnnounce(uid, grant) {', 2400);
  assert(ann.indexOf('if (!_announced) return;') !== -1, 'marca solo si avisó');
  assert(ann.indexOf('if (!_announced) return;') < ann.indexOf("child('notifiedAt').set(now)"), 'el aviso va antes de la marca');
});

console.log(passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
