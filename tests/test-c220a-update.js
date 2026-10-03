/* ================================================================
 * Tests: mecanismo de actualización (C220/C220a → C241)
 * version.json existe con build; sw.js excluye version.json de la
 * caché (network-only, nunca se cachea ni se sirve de caché).
 * C246 (2026-10-03): este test esperaba la consolidación "sin banner ni
 * DREX_BUILD" que NUNCA se publicó. El mecanismo real desplegado es el
 * DREX-UPDATER (2026-10-01, conservado a petición del usuario): sello
 * ISO idéntico en version.json y window.DREX_BUILD, chequeo en
 * carga/visibility/pageshow y banner creado por JS SOLO si difieren
 * (no existe markup estático). Los tests fijan ESE contrato.
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
test('version.json: build es el sello ISO del deploy y coincide con window.DREX_BUILD', function () {
  var m = /window\.DREX_BUILD = '([^']*)'/.exec(read('index.html'));
  assert(m, 'sin window.DREX_BUILD');
  assert(typeof vj.build === 'string' && vj.build.length > 0, 'build vacío');
  assert(vj.build === m[1], 'build de version.json (' + vj.build + ') != DREX_BUILD (' + m[1] + ')');
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

// ---- 4. DREX-UPDATER (2026-10-01): banner solo por JS ante desync ----
test('sin banner estático: #drex-update-banner no existe en el markup (lo crea el JS solo si difieren los sellos)', function () {
  assert(!/<[^>]*id="drex-update-banner"/.test(html), 'hay markup estático del banner');
  assert(/el\.id = 'drex-update-banner'/.test(html), 'el JS ya no crea el banner');
});
test('window.DREX_BUILD y el chequeador existen y recargan con ?drexv=', function () {
  assert(/window\.DREX_BUILD = '[^']+'/.test(html), 'falta window.DREX_BUILD');
  assert(/function check\(\)/.test(html) && /DrexForceUpdate/.test(html), 'falta el chequeador/actualizador');
  assert(html.indexOf("searchParams.set('drexv'") !== -1, 'falta la recarga con ?drexv=');
  assert(html.indexOf('?drexb=') === -1, 'queda la recarga vieja con ?drexb=');
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
