/* C279 (2026-10-07): regresión de la barrida de errores.
 * 1. Abrir la bandeja de Chats ya no marca todo como leído.
 * 2. Los comentarios abren ENCIMA de la sala de chat y del permalink.
 * 3. La notificación de voto a un comentario navega a la publicación.
 * 4. Los stickers cumplen bloqueo / permiso DM / anti-doble-envío
 *    y avisan al destinatario, como el texto.
 * 5. El regreso de Stripe tras verificar en el banco se recoge.
 * 6. La matriz de beneficios y la cuenta regresiva pintan todas
 *    sus copias vivas, no solo la primera.
 */
var fs = require('fs');
var path = require('path');
var assert = require('assert');
var ROOT = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
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

test('la bandeja de chats no marca todo leído al abrirla', function () {
  var a = html.indexOf('function openChatInboxView()');
  var b = html.indexOf('function _markAllChatsRead()', a);
  assert(a !== -1 && b !== -1, 'funciones no encontradas');
  var seg = html.slice(a, b);
  assert(seg.indexOf('_markAllChatsRead') === -1, 'openChatInboxView sigue llamando _markAllChatsRead');
  assert(html.indexOf('function _markAllChatsRead()') !== -1, 'la acción explícita debe seguir existiendo');
});

test('los comentarios se levantan sobre el chat y el permalink', function () {
  assert(html.indexOf("commentsView.style.zIndex = '220'") !== -1, 'falta el levantamiento de z');
  assert(html.indexOf('_overPermalink') !== -1 && html.indexOf('_overChatRoom') !== -1, 'faltan las sondas de contexto');
  var close = sliceFrom('function closeCommentsView()', 1600);
  assert(close.indexOf("_im2.style.zIndex = ''") !== -1, 'al cerrar se restaura el z de los visores');
});

test('el voto a un comentario notifica con destino a la publicación', function () {
  assert(html.indexOf("'vote', { actionType: 'post', actionId: noteId });") !== -1, 'falta el meta de navegación');
});

test('los stickers verifican bloqueos y permiso DM, con candado y aviso', function () {
  var seg = sliceFrom('async function sendChatSticker(stickerId)', 5200);
  assert(seg.indexOf("ref('blocks/' + user.uid + '/' + recipientId)") !== -1, 'falta chequeo de bloqueo');
  assert(seg.indexOf("ref('blocks/' + recipientId + '/' + user.uid)") !== -1, 'falta chequeo inverso de bloqueo');
  assert(seg.indexOf('dmPermission') !== -1, 'falta permiso DM');
  assert(seg.indexOf('window._drexChatSending = true') !== -1, 'falta el candado anti-doble-envío');
  assert(seg.indexOf('window._drexChatSending = false') !== -1, 'el candado debe liberarse');
  assert(seg.indexOf('addNotification(recipientId') !== -1, 'falta el aviso al destinatario');
});

test('el regreso de Stripe tras el banco se recoge y limpia la URL', function () {
  assert(html.indexOf('captureStripeRedirectReturn') !== -1, 'falta el capturador de retorno');
  assert(html.indexOf("redirect_status") !== -1 && html.indexOf("url.searchParams.delete(k)") !== -1, 'debe limpiar los parámetros');
});

test('la matriz de Orbit y la cuenta regresiva pintan todas sus copias', function () {
  var m = sliceFrom('function orbitRefreshBenefitsMatrix()', 700);
  assert(m.indexOf("querySelectorAll('#orbit-benefits-matrix')") !== -1, 'la matriz debe repintar todas');
  assert(html.indexOf("querySelectorAll('#fg-countdown')") !== -1, 'la cuenta regresiva debe pintar todas');
});

console.log(passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
