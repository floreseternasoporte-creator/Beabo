/* Prueba de regresión: manejo de errores en acciones async de la plataforma.
 *
 * Historia (auditoría 2026-10-01): varias funciones async llamadas desde
 * onclick no tenían try/catch; un fallo de red dejaba la UI en estado
 * mentiroso (switch pintado sin guardar, toast de éxito incondicional,
 * modal mudo) o mutaba estado local antes del ack del servidor.
 * Este test fija que cada una avisa al usuario y no miente.
 *
 * Uso: node tests/test-ui-error-handling.js   (código 0 = todo OK)
 */
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var ROOT = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

/* Extrae el cuerpo de una función (desde su declaración hasta el cierre
 * del bloque que la contiene, aproximado por balance de llaves). */
function fnBody(startMarker) {
  var i = src.indexOf(startMarker);
  assert(i !== -1, 'no encontrada: ' + startMarker);
  var open = src.indexOf('{', i);
  var depth = 0, j = open;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(open, j + 1);
}

test('toggleSecurityPreference tiene try/catch', function () {
  var b = fnBody('async function toggleSecurityPreference(key)');
  assert(b.indexOf('try {') !== -1 && b.indexOf('catch') !== -1, 'sin try/catch');
  assert(b.indexOf('securityToast') !== -1, 'no avisa del error');
});

test('createSavedFolder no muta caché sin ack', function () {
  var b = fnBody('async function createSavedFolder()');
  assert(b.indexOf('try {') !== -1 && b.indexOf('catch') !== -1, 'sin try/catch');
  var t = b.indexOf('try {'), c = b.indexOf('_userSavedFolders[newRef.key]');
  assert(t !== -1 && c !== -1 && t < c, 'la caché se toca antes del ack');
});

test('renameSavedFolder no muta caché sin ack', function () {
  var b = fnBody('async function renameSavedFolder(folderId)');
  assert(b.indexOf('try {') !== -1 && b.indexOf('catch') !== -1, 'sin try/catch');
  var t = b.indexOf('try {'), c = b.indexOf('_userSavedFolders[folderId].name = name');
  assert(t !== -1 && c !== -1 && t < c, 'la caché se toca antes del ack');
});

test('moveSavedPostToFolder no muta caché sin ack', function () {
  var b = fnBody('async function moveSavedPostToFolder(noteId, folderId, btnEl)');
  assert(b.indexOf('try {') !== -1 && b.indexOf('catch') !== -1, 'sin try/catch');
  var t = b.indexOf('try {'), c = b.indexOf('_userSavedPosts[noteId].folderId');
  assert(t !== -1 && c !== -1 && t < c, 'la caché se toca antes del ack');
});

test('joinFiestaFromFeed avisa si falla la lectura', function () {
  var b = fnBody('async function joinFiestaFromFeed(fiestaId)');
  assert(b.indexOf('try {') !== -1 && b.indexOf('catch') !== -1, 'sin try/catch');
  assert(b.indexOf('showMiniToast') !== -1, 'no avisa del error');
});

test('fiestaWantToSpeak muta el rol solo tras el ack', function () {
  var b = fnBody('async function fiestaWantToSpeak()');
  var upd = b.indexOf(".update({ role: 'speaker' })");
  var mut = b.indexOf("fiestaMyRole = 'speaker'");
  assert(upd !== -1 && mut !== -1, 'falta update o mutación');
  assert(upd < mut, 'el rol local se muta antes del ack del servidor');
  assert(b.indexOf('catch') !== -1, 'sin catch ante fallo de red');
});

test('markAllChatsReadAndRefresh no miente el éxito', function () {
  var b = fnBody('async function markAllChatsReadAndRefresh()');
  assert(b.indexOf('try {') !== -1 && b.indexOf('catch') !== -1, 'sin try/catch');
});

test('saveNote tiene .catch() con mensaje', function () {
  var b = fnBody('function saveNote()');
  assert(b.indexOf('.catch(') !== -1, 'sin .catch()');
  assert(b.indexOf('No se pudo guardar la nota') !== -1, 'sin mensaje de error');
});

console.log('\n' + passed + ' pasadas, ' + failed + ' fallidas.');
process.exit(failed ? 1 : 0);
