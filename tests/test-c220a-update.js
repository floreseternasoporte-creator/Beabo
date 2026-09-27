/* ================================================================
 * Tests: mecanismo de actualización C220a (2026-09-27)
 * version.json existe con build; index.html embebe el MISMO build;
 * sw.js excluye version.json de la caché (network-only, nunca se
 * cachea ni se sirve de caché); banner y chequeador presentes;
 * el chequeador compara DESIGUALDAD (j.build !== DREX_BUILD) —
 * errores de red y respuestas inválidas no muestran el banner
 * (sin falsos positivos).
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

// ---- 2. index.html embebe el MISMO build ----
var html = read('index.html');
var embed = html.match(/window\.DREX_BUILD\s*=\s*'(\d{12})'/);
test('index.html embebe window.DREX_BUILD', function () {
  assert(embed, 'no se encontró window.DREX_BUILD');
});
test('build embebido coincide con version.json', function () {
  assert(embed && embed[1] === vj.build, 'embebido=' + (embed && embed[1]) + ' vs version.json=' + vj.build);
});
test('index.html termina con </body></html>', function () {
  assert(/<\/body>\s*<\/html>\s*$/.test(html), 'final del archivo roto');
});

// ---- 3. sw.js: version.json network-only ----
var sw = read('sw.js');
test('sw.js subió DREX_SW_VERSION a drex-v16', function () {
  assert(/DREX_SW_VERSION\s*=\s*'drex-v16'/.test(sw), 'versión no es drex-v16');
});
test('sw.js excluye version.json de la caché (network-only)', function () {
  var anchor = sw.indexOf("pathname.endsWith('/version.json')");
  assert(anchor !== -1, 'sin exclusión por pathname.endsWith(\'/version.json\')');
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

// ---- 4. banner y chequeador en index.html ----
test('banner fijo de actualización presente (z-index 9999, oculto por defecto)', function () {
  assert(html.indexOf('id="drex-update-banner"') !== -1, 'sin #drex-update-banner');
  assert(/z-index:\s*9999/.test(html), 'sin z-index 9999');
  assert(/drex-update-banner[^>]*display:\s*none/.test(html), 'banner no oculto por defecto');
});
test('textos del banner usan patrón appT con fallback en español', function () {
  assert(html.indexOf("typeof appT==='function'") !== -1, 'sin patrón appT');
  assert(html.indexOf('Hay una nueva versión de Drex') !== -1, 'sin texto del banner');
});
test('chequeador consulta version.json con no-store', function () {
  assert(/fetch\(\s*['"]\.\/version\.json['"]\s*,\s*\{\s*cache\s*:\s*['"]no-store['"]\s*\}/.test(html),
    'fetch de version.json sin {cache:no-store}');
});
test('chequeador compara DESIGUALDAD (sin falsos positivos)', function () {
  assert(/j\.build\s*!==\s*window\.DREX_BUILD/.test(html), 'sin comparación !==');
});
test('errores de red son silencio (catch vacío)', function () {
  var m = html.match(/fetch\(\s*['"]\.\/version\.json['"][\s\S]{1,1100}?\.catch\s*\(\s*function\s*\(\s*\)\s*\{\s*\}\s*\)/);
  assert(m, 'catch no silencioso tras el fetch de version.json');
});
test('respuestas inválidas (sin build) no muestran el banner', function () {
  assert(/typeof\s+j\.build\s*!==\s*['"]string['"]/.test(html), 'sin guarda de j.build string');
});
test('chequeador corre al boot', function () {
  assert(/checkUpdate\s*\(\s*true\s*\)/.test(html), 'sin checkUpdate(true) al boot');
});
test('chequeador corre en pageshow cuando e.persisted (bfcache iOS)', function () {
  assert(/pageshow/.test(html) && /e\.persisted/.test(html), 'sin pageshow/persisted');
});
test('chequeador corre en visibilitychange al volver a visible (con throttle)', function () {
  assert(/visibilitychange/.test(html) && /document\.hidden/.test(html), 'sin visibilitychange');
  assert(/5\s*\*\s*60\s*\*\s*1000/.test(html), 'sin throttle de 5 min');
});
test('botón Actualizar borra cachés drex-* y recarga con ?drexb=', function () {
  assert(/caches\.keys\(\)/.test(html), 'sin caches.keys()');
  assert(/indexOf\(['"]drex-['"]\)\s*===\s*0/.test(html), 'sin filtro drex-*');
  assert(/\?drexb=/.test(html), 'sin query ?drexb=');
  assert(/location\.pathname\s*\+/.test(html), 'no usa location.pathname');
});
test('comentario en español explica la cadena de staleness', function () {
  assert(/cadena de staleness/.test(html) || /max-age=600/.test(html), 'sin explicación de staleness');
});

// ---- 5. El bloque JS del chequeador pasa node --check ----
test('scripts del bloque C220a son JS válido', function () {
  var scripts = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
  var c220 = scripts.filter(function (s) { return s.indexOf('DREX_BUILD') !== -1 || s.indexOf('drex-update-banner') !== -1; });
  assert(c220.length >= 2, 'bloques C220a no encontrados (' + c220.length + ')');
  var vm = require('vm');
  c220.forEach(function (s) {
    var code = s.replace(/<\/?script>/g, '');
    new vm.Script(code); // lanza si hay error de sintaxis
  });
});

console.log('\n' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
