/* ================================================================
 * Tests: tab "Notas" del perfil propio (CRASH-HUNT 2026-09-28)
 * El handler del tab llamaba a loadUserNotes() pero la función no
 * existía: el guard typeof evitaba el crash pero el tab quedaba
 * muerto (solo encabezado estático). Estos tests fijan que la
 * función existe, sigue el patrón de loadProfileEcosTab, tiene sus
 * 6 claves i18n en EN/ZH/PT dentro de los dicts TEXT correctos y
 * que 404.html sigue siendo copia exacta de index.html.
 * Ejecutar: node tests/test-profile-notes-tab.js [--target <dir-repo>]
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var repoDir = path.join(__dirname, '..');
for (var i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) repoDir = process.argv[i + 1];
}
function read(f) { return fs.readFileSync(path.join(repoDir, f), 'utf8'); }

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

var html = read('index.html');
var i18n = read('drex-i18n.js');

// ---- 1. loadUserNotes definida globalmente ----
test('loadUserNotes está definida en index.html', function () {
  assert(html.indexOf('async function loadUserNotes()') !== -1, 'no se encontró la definición');
});

// ---- 2. guard del tab intacto ----
test('el handler del tab conserva el guard typeof', function () {
  assert(html.indexOf("tabName === 'notes' && typeof loadUserNotes === 'function'") !== -1,
    'guard del tab modificado o ausente');
});

// ---- 3. contenedor de la lista dentro del tab ----
test('#profile-notes-list existe dentro de #notes-tab-content', function () {
  var tabIdx = html.indexOf('id="notes-tab-content"');
  var listIdx = html.indexOf('id="profile-notes-list"');
  assert(tabIdx !== -1 && listIdx !== -1 && listIdx > tabIdx, 'contenedor ausente o fuera del tab');
});

// ---- 4. encabezado con id para el conteo ----
test('#profile-notes-header existe', function () {
  assert(html.indexOf('id="profile-notes-header"') !== -1, 'header ausente');
});

// ---- 5. patrón de carga: communityNotes por authorId + tarjetas de perfil ----
test('loadUserNotes consulta communityNotes por authorId y usa createProfilePostCard', function () {
  var fnIdx = html.indexOf('async function loadUserNotes()');
  var fnBody = html.slice(fnIdx, fnIdx + 4000);
  assert(fnBody.indexOf("ref('communityNotes')") !== -1, 'sin ref communityNotes');
  assert(fnBody.indexOf("orderByChild('authorId')") !== -1, 'sin orderByChild authorId');
  assert(fnBody.indexOf('createProfilePostCard') !== -1, 'sin createProfilePostCard');
  assert(fnBody.indexOf('_getProfileVoteMaps') !== -1, 'sin _getProfileVoteMaps');
});

// ---- 6. ramas sin-sesión y de error ----
test('loadUserNotes maneja sin-sesión y errores sin lanzar', function () {
  var fnIdx = html.indexOf('async function loadUserNotes()');
  var fnBody = html.slice(fnIdx, fnIdx + 4000);
  assert(fnBody.indexOf('Inicia sesión para ver tus notas.') !== -1, 'falta rama sin-sesión');
  assert(fnBody.indexOf('catch (error)') !== -1, 'falta catch');
  assert(fnBody.indexOf('Error al cargar las notas.') !== -1, 'falta mensaje de error');
});

// ---- 7/8/9. 6 claves en cada dict TEXT correcto ----
var KEYS = ['Inicia sesión para ver tus notas.', 'Aún no tienes notas',
  'Publica tu primera nota desde el botón de crear.', 'Error al cargar las notas.',
  'nota', 'notas'];
function dictRange(src, startMarker, endMarker) {
  var a = src.indexOf(startMarker);
  var b = src.indexOf(endMarker, a);
  assert(a !== -1 && b !== -1 && b > a, 'rango no encontrado: ' + startMarker);
  return src.slice(a, b);
}
test('las 6 claves están en APP_ENGLISH_TEXT', function () {
  var dict = dictRange(i18n, 'var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {');
  KEYS.forEach(function (k) { assert(dict.indexOf('"' + k + '":') !== -1, 'falta en EN: ' + k); });
});
test('las 6 claves están en APP_CHINESE_TEXT', function () {
  var dict = dictRange(i18n, 'var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {');
  KEYS.forEach(function (k) { assert(dict.indexOf('"' + k + '":') !== -1, 'falta en ZH: ' + k); });
});
test('las 6 claves están en APP_PORTUGUESE_TEXT', function () {
  var dict = dictRange(i18n, 'var APP_PORTUGUESE_TEXT = {', 'var APP_CHINESE_ATTRS = {');
  KEYS.forEach(function (k) { assert(dict.indexOf('"' + k + '":') !== -1, 'falta en PT: ' + k); });
});

// ---- 10. 404.html idéntico ----
test('404.html idéntico a index.html', function () {
  assert(read('404.html') === html, '404.html difiere de index.html');
});

console.log('\n' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
