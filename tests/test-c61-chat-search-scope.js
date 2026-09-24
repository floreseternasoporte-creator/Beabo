/* ================================================================
 * C61-C1: honestidad del alcance de búsqueda en el chat.
 * Decisión del ciclo 61: searchMessagesInCurrentChat solo filtra el DOM
 * ya renderizado (#chat-room-messages, ventana de ~80 mensajes). El
 * placeholder prometía "Buscar en esta conversación"; ahora promete
 * "Buscar en mensajes recientes".
 * 1. El input de búsqueda del cuarto usa el placeholder honesto.
 * 2. La cadena engañosa ya no aparece en index.html.
 * 3. La clave honesta existe en los 3 diccionarios ATTRS (EN/ZH/PT)
 *    con traducción no vacía.
 * 4. La clave engañosa sale de los 3 diccionarios ATTRS.
 * 5. Contrato de alcance: la función del cuarto solo toca el DOM
 *    renderizado, sin consultas al servidor (lo que el texto promete).
 * 6. La búsqueda de la vista de grupo conserva su etiqueta amplia
 *    ("Buscar en la conversación...") porque SÍ tiene respaldo de red
 *    (limitToLast(300)) cuando el caché no cubre el término.
 * Ejecutar con: node tests/test-c61-chat-search-scope.js
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
var i18n = fs.readFileSync(path.join(__dirname, '..', 'drex-i18n.js'), 'utf8');

function extractDict(varName, nextVarName) {
  var start = i18n.indexOf(varName);
  assert(start !== -1, 'no se encontró ' + varName);
  var end = nextVarName ? i18n.indexOf(nextVarName, start) : i18n.length;
  assert(end !== -1, 'no se encontró ' + nextVarName);
  var sec = i18n.slice(start, end);
  var closeIdx = sec.lastIndexOf('\n};');
  assert(closeIdx !== -1, 'cierre no encontrado para ' + varName);
  var objText = sec.slice(sec.indexOf('{'), closeIdx + 2);
  return new Function('return (' + objText + ');')();
}

var ZH_A = extractDict('var APP_CHINESE_ATTRS = {', 'var APP_ENGLISH_ATTRS = {');
var EN_A = extractDict('var APP_ENGLISH_ATTRS = {', 'var APP_PORTUGUESE_ATTRS = {');
var PT_A = extractDict('var APP_PORTUGUESE_ATTRS = {', null);

function extractFnBody(name) {
  var start = html.indexOf('function ' + name + '(');
  assert(start !== -1, 'no se encontró ' + name);
  var brace = html.indexOf('{', start);
  var depth = 0;
  for (var i = brace; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (!depth) return html.slice(brace, i + 1); }
  }
  throw new Error('cierre no encontrado para ' + name);
}

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

test('input de búsqueda del cuarto usa el placeholder honesto', function () {
  var m = html.match(/id="chat-message-search-input"[^>]*placeholder="([^"]*)"/);
  assert(m, 'input chat-message-search-input no encontrado');
  assert.strictEqual(m[1], 'Buscar en mensajes recientes');
});

test('cadena engañosa eliminada del HTML', function () {
  assert(html.indexOf('Buscar en esta conversación') === -1,
    'sigue presente la cadena engañosa en index.html');
});

test('clave honesta en los 3 diccionarios ATTRS con traducción', function () {
  [['EN', EN_A], ['ZH', ZH_A], ['PT', PT_A]].forEach(function (t) {
    var v = t[1]['Buscar en mensajes recientes'];
    assert(v, 'clave ausente en ATTRS ' + t[0]);
    assert(v.trim().length > 0, 'traducción vacía en ATTRS ' + t[0]);
  });
});

test('clave engañosa fuera de los 3 diccionarios ATTRS', function () {
  [['EN', EN_A], ['ZH', ZH_A], ['PT', PT_A]].forEach(function (t) {
    assert(!('Buscar en esta conversación' in t[1]), 'clave engañosa aún en ATTRS ' + t[0]);
  });
});

test('searchMessagesInCurrentChat es solo-DOM (sin red)', function () {
  var body = extractFnBody('searchMessagesInCurrentChat');
  assert(body.indexOf("getElementById('chat-room-messages')") !== -1,
    'no filtra el DOM del cuarto');
  assert(body.indexOf('DrexCloud.database(') === -1, 'hace consulta al servidor');
  assert(body.indexOf('limitToLast') === -1, 'hace consulta paginada al servidor');
  assert(body.indexOf('orderByChild') === -1, 'hace consulta ordenada al servidor');
});

test('búsqueda de grupo conserva etiqueta amplia con respaldo de red', function () {
  assert(html.indexOf('placeholder="Buscar en la conversación..."') !== -1,
    'placeholder de grupo cambiado sin motivo');
  var body = extractFnBody('searchInGroupConversation');
  assert(body.indexOf('limitToLast(300)') !== -1,
    'la búsqueda de grupo perdió su respaldo de red');
});

console.log('\nRESULTADO: ' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
