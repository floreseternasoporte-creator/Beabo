/* C286 (2026-10-08): regresión de la octava barrida de errores.
 * Seguridad: activar el 2FA genera Y guarda los códigos de respaldo
 * (antes el generador puro reventaba con .then y los códigos jamás se
 * almacenaban); el campo de código se rehabilita tras cualquier error;
 * la puerta legacy solo aparece si la cuenta tiene secreto legacy
 * (quien usa MFA nativo ya no queda atrapado pidiendo un código
 * imposible en cada restauración); regenerar códigos funciona para
 * MFA nativo vía reautenticación; contraseña actual errónea se dice
 * como tal.
 * Historial/Guardados: las vistas previas aplican la visibilidad del
 * feed (privados/de grupo/desactivados/bloqueados en cualquier
 * dirección), Guardados ordena por savedAt, los comentarios de posts
 * borrados no muestran miniatura, el total de visitantes es real y
 * las visitas no se acumulan con las vistas del dueño apagadas.
 * Rutas: sin sesión ninguna ruta profunda queda sobre el login; el
 * bloqueo inverso cierra post/comentarios/canción por enlace; los
 * enlaces #/guardados, #/ondas y #/fiestas de Baro abren su vista;
 * compartir nace en la raíz del dominio actual; ?song= se consume
 * tras entrar; lista borrada y ruta inventada avisan. */
var fs = require('fs');
var path = require('path');
var assert = require('assert');
var ROOT = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var cloud = fs.readFileSync(path.join(ROOT, 'drex-cloud.js'), 'utf8');
var recov = fs.readFileSync(path.join(ROOT, 'recovery-codes.js'), 'utf8');
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

/* ---- Seguridad ---- */
test('activar el 2FA guarda los códigos de respaldo (generateAndStore)', function () {
  var seg = sliceFrom('function confirmTwoFactorSetup()', 3600);
  assert(seg.indexOf('generateAndStore') !== -1, 'usa generateAndStore');
  assert(seg.indexOf('DrexRecoveryCodes.generate().then') === -1, 'sin el generador puro');
  assert(seg.indexOf('drex2faVerified_') !== -1, 'marca la sesión verificada');
});
test('el campo de código del 2FA se rehabilita tras un error', function () {
  var seg = sliceFrom('function confirmTwoFactorSetup()', 4200);
  assert(/\.catch\(\(\) => \{\s*\n\s*\/\/ C286/.test(seg) || seg.indexOf('input.disabled = false') !== -1, 'rehabilita');
});
test('la puerta legacy exige secreto legacy (MFA nativo no se atasca)', function () {
  var seg = sliceFrom('// C286: la puerta legacy', 700);
  assert(seg.indexOf('data.twoFactorSecret') !== -1, 'secreto presente');
  assert(seg.indexOf('showLegacy2FAChallenge') !== -1, 'desafío legacy');
});
test('regenerar códigos funciona con MFA nativo', function () {
  var i = recov.indexOf('function verifyCurrentTotp');
  assert(i !== -1, 'verifyCurrentTotp presente');
  var seg = recov.slice(i, i + 2600);
  assert(seg.indexOf('reauthenticate') !== -1, 'reautenticación nativa');
  assert(seg.indexOf('twoFactorSecret') !== -1, 'respaldo legacy');
});
test('contraseña actual errónea no se disfraza de sesión vencida', function () {
  assert(cloud.indexOf("mapped.code = 'auth/wrong-password'") !== -1, 'mapeo correcto');
});

/* ---- Historial / Guardados ---- */
test('el Historial filtra por visibilidad con el helper compartido', function () {
  assert(html.indexOf('async function _drexHistoryHiddenIds(pairs)') !== -1, 'helper');
  var saved = sliceFrom('function loadHistorialSaved()', 3000);
  assert(saved.indexOf('_drexHistoryHiddenIds(pairs)') !== -1, 'guardados filtra');
  assert(saved.indexOf('savedAt') !== -1, 'ordena por savedAt');
  var ecos = sliceFrom('function loadHistorialEcos()', 3200);
  assert(ecos.indexOf('_drexHistoryHiddenIds') !== -1, 'ecos filtra');
  var comments = sliceFrom('function loadHistorialComments()', 3600);
  assert(comments.indexOf('_drexHistoryHiddenIds(postPairs)') !== -1, 'comentarios filtra posts');
});
test('las carpetas de Guardados respetan la visibilidad', function () {
  var seg = sliceFrom('async function openSavedFolderContents(folderId)', 4200);
  assert(seg.indexOf('_drexHistoryHiddenIds') !== -1, 'carpetas filtran');
});
test('visitantes: total real y registro solo si el dueño lo activó', function () {
  var seg = sliceFrom('async function openOrbitVisitors()', 3400);
  assert(seg.indexOf('allEntries.length') !== -1, 'total real');
  var rec = sliceFrom('async function drexRecordProfileVisit(ownerUid)', 4200);
  assert(rec.indexOf('profileViewsEnabled') !== -1, 'opt-in del dueño');
});

/* ---- Rutas / enlaces ---- */
test('sin sesión se cierran todas las rutas profundas', function () {
  assert(html.indexOf('// C286: sin sesión, ninguna vista de ruta profunda') !== -1, 'cierre presente');
  assert(html.indexOf('drexCloseAllRoutes()') !== -1, 'cierre');
});
test('bloqueo inverso en post, comentarios y canción por enlace', function () {
  var perma = sliceFrom('function openPostPermalink(noteId, options = {})', 6500);
  assert(perma.indexOf("'blocks/' + authorId + '/' + user.uid") !== -1, 'permalink inverso');
  assert(html.indexOf("'blocks/' + _cvAuthor + '/'") !== -1, 'comentarios inverso');
  assert(html.indexOf("'blocks/' + _aid + '/'") !== -1, 'canción inverso');
});
test('los enlaces #/seccion de Baro resuelven y abren', function () {
  assert(html.indexOf("window.addEventListener('hashchange', handleSubpageHash)") !== -1, 'hashchange');
  var seg = sliceFrom('function drexRouteFromLocation()', 900);
  assert(seg.indexOf('drexMatchRoute(h)') !== -1, 'hash interno resuelve');
});
test('compartir nace en la raíz del dominio actual', function () {
  var prof = sliceFrom('function shareMyProfile()', 600);
  assert(prof.indexOf("drexBasePath() : '') + '/?user='") !== -1, 'perfil raíz');
  assert(prof.indexOf('location.pathname') === -1, 'sin pathname');
  var song = sliceFrom('window.musicShareTrack = function ()', 600);
  assert(song.indexOf("drexBasePath() : '') + '/?song='") !== -1, 'canción raíz');
  assert(song.indexOf('github.io/Beabo/?song=') === -1, 'sin dominio fijo');
});
test('?song= se captura y se consume tras entrar', function () {
  assert(html.indexOf("sessionStorage.setItem('drex_pending_song', sharedSong)") !== -1, 'captura');
  assert(html.indexOf("sessionStorage.getItem('drex_pending_song')") !== -1, 'consumo en consumePendingDeepLinks');
  var boot = sliceFrom('(function musicDeepLinkBoot()', 1200);
  assert(boot.indexOf('DrexCloud.auth().currentUser') !== -1, 'espera sesión');
});
test('lista borrada y ruta inventada avisan', function () {
  var pl = sliceFrom('window.musicOpenPlaylist = async function (id)', 1400);
  assert(pl.indexOf('Esta lista ya no está disponible.') !== -1, 'lista avisa');
  assert(html.indexOf('Esa página no existe en Drex.') !== -1, 'ruta avisa');
});

console.log('C286: ' + passed + ' OK, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
