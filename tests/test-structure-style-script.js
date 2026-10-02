/* Pruebas de regresión: estructura HTML válida + filtro de notas fantasma.
 *
 * Historia (2026-10-01):
 *  BUG A — La eliminación de En vivo (e883ec6) dejó DOS heridas estructurales:
 *    1. Borró el `</style>` del CSS de DREX-CAM → el <style> tragó el HTML de
 *       la cámara y el <script> i18n C218/C219 (hasta el siguiente </style>).
 *    2. Dejó un `<style>` huérfano antes del comentario C237 → ese <style>
 *       nunca se cerró y tragó 3 <script> completos hasta el EOF: el bloque
 *       de Orbit/Pagos (window.openOrbitView, window.openPaymentsView,
 *       window.DrexOrbit...), y los 2 bloques C228 del feed (doble-toque).
 *  Resultado: tocar "Drex Orbit" o "Pagos" no hacía NADA (ReferenceError),
 *  sin ningún error visible. El grep y node --check no lo detectan: solo el
 *  parser HTML lo revela. Este test simula el parser (estados style/script).
 *  BUG B — Notas vacías de la BD (sin texto/media/autor) se pintaban como
 *  tarjetas "Usuario" · "just now". snfMountFeedPost ahora las filtra con
 *  drexNoteHasRenderableContent().
 *
 * Uso: node tests/test-structure-style-script.js   (código 0 = todo OK)
 */
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var ROOT = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var src404 = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

/* Simula el parser HTML para los elementos raw-text <style> y <script>:
 * devuelve { problems: [<script> dentro de <style>], unclosed: [...] }. */
function parseStyleScript(s) {
  var state = 'normal', i = 0, n = s.length;
  var problems = [], unclosed = [], styleStart = -1;
  var tagRe = /<\/?(style|script)\b/gi;
  while (i < n) {
    if (state === 'normal') {
      tagRe.lastIndex = i;
      var m = tagRe.exec(s);
      if (!m) break;
      var closing = m[0][1] === '/';
      var name = m[1].toLowerCase();
      var pos = m.index;
      if (!closing && name === 'style') { state = 'style'; styleStart = pos; }
      else if (!closing && name === 'script') { state = 'script'; }
      i = pos + m[0].length;
    } else if (state === 'style') {
      var closeIdx = s.toLowerCase().indexOf('</style>', i);
      var scriptIdx = s.toLowerCase().indexOf('<script', i);
      if (scriptIdx !== -1 && (closeIdx === -1 || scriptIdx < closeIdx)) {
        problems.push({ styleAt: styleStart, scriptAt: scriptIdx });
      }
      if (closeIdx === -1) { unclosed.push({ tag: 'style', at: styleStart }); break; }
      state = 'normal'; i = closeIdx + 8;
    } else {
      var closeS = s.toLowerCase().indexOf('</script>', i);
      if (closeS === -1) { unclosed.push({ tag: 'script', at: i }); break; }
      state = 'normal'; i = closeS + 9;
    }
  }
  return { problems: problems, unclosed: unclosed };
}

test('ningún <script> dentro de <style> (parser HTML)', function () {
  var r = parseStyleScript(src);
  assert(r.problems.length === 0,
    'scripts tragados por <style>: ' + JSON.stringify(r.problems));
});

test('ningún <style>/<script> sin cerrar al EOF', function () {
  var r = parseStyleScript(src);
  assert(r.unclosed.length === 0, 'sin cerrar: ' + JSON.stringify(r.unclosed));
});

test('exports de Orbit/Pagos viven en un <script> real', function () {
  // El export debe estar dentro de un bloque <script>...</script> parseado,
  // no dentro de un <style>.
  var blocks = [];
  var re = /<script(?![^>]*src=)[^>]*>/gi, m;
  while ((m = re.exec(src))) {
    var e = src.toLowerCase().indexOf('</script>', m.index);
    blocks.push(src.slice(m.index, e));
  }
  var withExport = blocks.filter(function (b) {
    return b.indexOf('window.openOrbitView = openOrbitView') !== -1;
  });
  assert(withExport.length === 1, 'export Orbit/Pagos en ' + withExport.length + ' bloques');
  assert(withExport[0].indexOf('<style>') === -1, 'el bloque export está dentro de un <style>');
});

test('</style> cierra el CSS de DREX-CAM antes del modal', function () {
  var i = src.indexOf('drex-cam-chip-sel > span:first-child');
  assert(i !== -1, 'CSS DREX-CAM no encontrado');
  var seg = src.slice(i, i + 400);
  assert(seg.indexOf('</style>') !== -1, 'falta </style> tras el CSS de DREX-CAM');
  assert(seg.indexOf('</style>') < seg.indexOf('<div id="drex-cam-modal"'),
    '</style> debe ir antes del HTML del modal');
});

test('sin <style> huérfano antes del comentario C237', function () {
  var i = src.indexOf('<!-- C237: hoja de regalos');
  assert(i !== -1, 'comentario C237 no encontrado');
  var seg = src.slice(Math.max(0, i - 60), i);
  assert(seg.indexOf('<style>') === -1, 'hay un <style> huérfano antes del comentario C237');
});

test('drexNoteHasRenderableContent existe y filtra notas vacías', function () {
  var i = src.indexOf('function drexNoteHasRenderableContent(note)');
  assert(i !== -1, 'helper no encontrado');
  var j = src.indexOf('}', src.indexOf('return false;', i));
  var body = src.slice(i, j);
  ['note.content', 'note.imageCount', 'note.video', 'note.poll', 'note.fiestaId', "note.kind === 'music'"]
    .forEach(function (f) { assert(body.indexOf(f) !== -1, 'falta chequeo de ' + f); });
});

test('snfMountFeedPost filtra notas sin contenido', function () {
  var i = src.indexOf('function snfMountFeedPost(');
  assert(i !== -1, 'snfMountFeedPost no encontrada');
  var body = src.slice(i, i + 600);
  assert(body.indexOf('drexNoteHasRenderableContent(note)') !== -1,
    'snfMountFeedPost no llama al filtro');
});

test('lógica del filtro: casos', function () {
  var i = src.indexOf('function drexNoteHasRenderableContent(note)');
  var end = src.indexOf('\n  }\n', i) + 5;
  var fnSrc = src.slice(i, end);
  var fn = new Function('note', fnSrc.replace(/^function drexNoteHasRenderableContent\(note\)\s*\{/, '').replace(/\}\s*$/, ''));
  assert(fn({ id: 'x' }) === false, 'nota vacía debe ser false');
  assert(fn({ id: 'x', content: '  ' }) === false, 'solo espacios debe ser false');
  assert(fn({ id: 'x', content: 'hola' }) === true, 'con texto debe ser true');
  assert(fn({ id: 'x', imageCount: 2 }) === true, 'con imageCount debe ser true');
  assert(fn({ id: 'x', imageUrls: ['a'] }) === true, 'con imageUrls debe ser true');
  assert(fn({ id: 'x', video: { chunks: 1 } }) === true, 'con video debe ser true');
  assert(fn({ id: 'x', poll: { options: [{ t: 'a' }] } }) === true, 'con encuesta debe ser true');
  assert(fn({ id: 'x', fiestaId: 'f1' }) === true, 'con fiesta debe ser true');
  assert(fn({ id: 'x', kind: 'music', trackId: 't1' }) === true, 'con música debe ser true');
  assert(fn({ id: 'x', url: 'https://x.com' }) === true, 'con url debe ser true');
  assert(fn(null) === false, 'null debe ser false');
});

test('404.html sincronizado con index.html', function () {
  assert(src === src404, '404.html difiere de index.html');
});

console.log('\n' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
