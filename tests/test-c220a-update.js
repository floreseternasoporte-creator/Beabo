/* ================================================================
 * Tests: mecanismo de actualización (C220/C220a → C241)
 * version.json existe con build; sw.js excluye version.json de la
 * caché (network-only, nunca se cachea ni se sirve de caché).
 * El banner fijo de actualización fue ELIMINADO el 2026-09-28 a
 * petición del usuario (estorbaba la UI): estos tests fijan su
 * ausencia para que no reaparezca por accidente.
 * Ejecutar: node tests/test-c220a-update.js [--target <dir-repo>]
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

// ---- 1. version.json existe y tiene build válido ----
var vjRaw = read('version.json');
var vj = JSON.parse(vjRaw);
test('version.json existe y es JSON válido', function () {
  assert(vj, 'no parseó');
});
test('version.json tiene build con formato YYYYMMDDHHMM', function () {
  assert(typeof vj.build === 'string' && /^\d{12}$/.test(vj.build), 'build=' + JSON.stringify(vj.build));
});
test('version.json tiene campo at ISO', function () {
  assert(typeof vj.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(vj.at), 'at=' + JSON.stringify(vj.at));
});

// ---- 2. index.html e 404.html sanos ----
var html = read('index.html');
test('index.html termina con </body></html>', function () {
  assert(/<\/body>\s*<\/html>\s*$/.test(html), 'final del archivo roto');
});
test('404.html idéntico a index.html', function () {
  assert(read('404.html') === html, '404.html difiere de index.html');
});

// ---- 3. sw.js: version.json network-only ----
var sw = read('sw.js');
test('sw.js subió DREX_SW_VERSION a drex-v16', function () {
  assert(/DREX_SW_VERSION\s*=\s*'drex-v16'/.test(sw), 'versión no es drex-v16');
});
test('sw.js excluye version.json de la caché (network-only)', function () {
  var anchor = sw.indexOf("pathname.endsWith('/version.json')");
  assert(anchor !== -1, "sin exclusión por pathname.endsWith('/version.json')");
  var block = sw.slice(anchor, anchor + 160);
  assert(/event\.respondWith\s*\(\s*fetch\s*\(\s*req\s*\)\s*\)/.test(block),
    'no hace respondWith(fetch(req)) directo: ' + JSON.stringify(block));
  assert(/\breturn\b/.test(block), 'no retorna tras la exclusión');
});
test('la exclusión está ANTES de la rama HTML dentro del fetch handler', function () {
  var listener = sw.indexOf("addEventListener('fetch'");
  assert(listener !== -1, 'sin fetch listener');
  var body = sw.slice(listener);
  var idxExcl = body.indexOf('/version.json');
  var idxHtml = body.indexOf("req.mode === 'navigate'");
  assert(idxExcl !== -1 && idxHtml !== -1 && idxExcl < idxHtml,
    'orden incorrecto (excl=' + idxExcl + ', html=' + idxHtml + ')');
});

// ---- 4. banner ELIMINADO (2026-09-28, petición del usuario) ----
test('banner de actualización eliminado del DOM', function () {
  assert(html.indexOf('drex-update-banner') === -1, 'queda #drex-update-banner');
  assert(html.indexOf('Hay una nueva versión de Drex') === -1, 'queda texto del banner');
});
test('window.DREX_BUILD y el chequeador fueron retirados', function () {
  assert(html.indexOf('DREX_BUILD') === -1, 'queda window.DREX_BUILD');
  assert(html.indexOf('checkUpdate') === -1, 'queda el chequeador');
  assert(html.indexOf('?drexb=') === -1, 'queda la recarga con ?drexb=');
});

// ---- 5. todos los <script> inline de index.html compilan ----
test('todos los scripts inline de index.html son JS válido', function () {
  var scripts = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
  assert(scripts.length >= 30, 'pocos scripts inline: ' + scripts.length);
  var vm = require('vm');
  scripts.forEach(function (sc) {
    new vm.Script(sc.replace(/<\/?script>/g, '')); // lanza si hay error de sintaxis
  });
});

console.log('\n' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
