/* C281 (2026-10-07): regresión de la tercera barrida de errores.
 * 1. El caché de videos del visor ya no crece sin límite (FIFO 5).
 * 2. El buscador de chats ya no re-lee la presencia por cada tecla.
 * 3. Un bache de red no "des-suscribe" en pantalla a quien ya pagó.
 * 4. "Guardar tarjeta" solo anuncia éxito si la tarjeta se adjuntó.
 * 5. La etiqueta de la suscripción ya no contradice el pago fallido.
 * 6. El plan de prueba de Halloween respeta el filtro de planes.
 * 7. El silencio del anfitrión en fiestas ahora alterna (y la etiqueta).
 * 8. El anfitrión ya puede expulsar a un oyente de la hoja de oyentes.
 * 9. La palabra secreta del juego llega en el idioma de cada jugador.
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

test('el caché de videos del visor tiene tope FIFO de 5', function () {
  assert(html.indexOf('const _VIDEO_MODAL_CACHE_MAX = 5;') !== -1, 'falta el tope');
  assert(html.indexOf('function _videoModalCachePut(nid, du)') !== -1, 'falta la escritura con expulsión');
  assert(html.indexOf('_videoModalCachePut(nid, du)') !== -1, 'la escritura al cargar debe usar el tope');
  assert(html.indexOf('_videoModalCacheDel(nid)') !== -1, 'el error debe expulsar de la cola');
});

test('la presencia de chats se lee con caché de 60 s y dedup', function () {
  var seg = sliceFrom('function drexPresenceOnline(uid)', 900);
  assert(seg.indexOf('_presenceCache[uid]') !== -1, 'debe cachear por uid');
  assert(seg.indexOf('60000') !== -1, 'TTL de 60 s');
  var render = sliceFrom('function renderChatConversations(items)', 9000);
  assert(render.indexOf('drexPresenceOnline(item.otherUid)') !== -1, 'el render debe pasar por la caché');
  assert(render.indexOf(".ref('userPresence/' + item.otherUid + '/online').once") === -1, 'sin lecturas directas por fila');
});

test('un fallo de red conserva el estado verificado de un miembro', function () {
  var seg = sliceFrom('refresh: async function (force)', 1900);
  assert(seg.indexOf('if (!(self._st && self._st.active === true)) self._st = fail;') !== -1, 'debe conservar el último estado bueno');
  assert(seg.indexOf('if (!self._keptStale) self._ts = Date.now();') !== -1, 'no debe cachear el fallo por 60 s');
});

test('"Guardar tarjeta" solo celebra si la tarjeta se adjuntó', function () {
  var seg = sliceFrom('async function orbitManageSaveCard()', 2200);
  assert(seg.indexOf('var attached = false;') !== -1, 'debe verificar el adjunto');
  assert(seg.indexOf('if (!attached)') !== -1 && seg.indexOf("orbitManageErr(t('No se pudo guardar la tarjeta. Inténtalo de nuevo.'))") !== -1, 'sin adjunto debe avisar el error');
  assert(seg.indexOf("orbitToast(t('Método de pago actualizado'))") > seg.indexOf('if (!attached)'), 'el éxito va después de la comprobación');
});

test('la etiqueta de la suscripción coincide con el aviso de pago fallido', function () {
  var seg = sliceFrom('function drexTxSubStatus(sub)', 800);
  assert(seg.indexOf("if (st === 'past_due') return t('Pago pendiente');") !== -1, 'past_due sin activar debe decir Pago pendiente');
  assert(seg.indexOf("String(sub.status || '') === 'past_due') return t('Pago pendiente')") !== -1, 'past_due activa debe decir Pago pendiente');
  assert(i18n.indexOf('"Pago pendiente":"Payment pending"') !== -1, 'traducción EN');
});

test('el plan de prueba de Halloween respeta el filtro de planes', function () {
  var seg = sliceFrom('function drexHalloweenTrialInfo()', 900);
  assert(seg.indexOf("if (typeof orbitPlanAvailable === 'function' && !orbitPlanAvailable(plan)) return null;") !== -1, 'debe aplicar el mismo filtro que la sincronización');
});

test('el silencio del anfitrión alterna y el botón lo refleja', function () {
  var seg = sliceFrom('async function fiestaMuteMember(uid)', 1100);
  assert(seg.indexOf('silenced ? { muted: false, mutedByHost: false } : { muted: true, mutedByHost: true }') !== -1, 'debe alternar el estado');
  assert(html.indexOf("m.mutedByHost ? appT('Quitar silencio') : appT('Silenciar')") !== -1, 'la etiqueta debe mostrar Quitar silencio');
  assert(i18n.indexOf('"Silencio retirado.":"Mute removed."') !== -1, 'aviso traducido');
});

test('el anfitrión puede expulsar a un oyente desde su hoja', function () {
  var seg = sliceFrom('liEl.innerHTML = listeners.map', 900);
  assert(seg.indexOf('fiestaAmHost && uid !== fiestaMyUid') !== -1, 'la acción solo para el anfitrión');
  assert(seg.indexOf('fiestaKickMember(') !== -1 && seg.indexOf("appT('Expulsar')") !== -1, 'botón Expulsar en oyentes');
});

test('la palabra del juego se localiza por índice de par', function () {
  assert(html.indexOf('function fiestaGameWordLocal(w, liar, pi)') !== -1, 'falta el localizador');
  assert(html.indexOf('sec.pi = picked.idx') !== -1, 'el secreto debe guardar el índice');
  assert(html.indexOf('fiestaGameWordLocal(fiestaGameMySecret.w, fiestaGameMySecret.liar, fiestaGameMySecret.pi)') !== -1, 'la carta de palabra lo usa');
  assert(html.indexOf('fiestaGameWordLocal(r.word, r.liar, r.pi)') !== -1, 'el revelado lo usa');
  assert(html.indexOf('fiestaGamePairLocal(g.pair') !== -1, 'el final lo usa');
  assert(html.indexOf('pairIdx: (typeof sec.pairIdx') !== -1, 'el anfitrión publica el índice');
});

console.log(passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
