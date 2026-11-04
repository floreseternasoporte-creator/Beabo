/* Prueba de regresión: mecanismo de actualización forzada (DREX-UPDATER).
 *
 * Historia: el 2026-10-01 el usuario veía en su iPhone secciones ya eliminadas
 * del servidor (Efectos, Transmitir en vivo, Drex Studio) aunque el HTML servido
 * estaba limpio. Causa raíz: no existía ningún mecanismo de actualización —
 * version.json llevaba días desactualizado y NINGÚN código lo consultaba, así
 * que una página revivida de la caché de memoria/bfcache o de un SW viejo
 * mostraba la versión antigua sin aviso.
 *
 * Este test fija el estado intencional:
 *   1. window.DREX_BUILD existe en index.html (sello de build).
 *   2. El bloque DREX-UPDATER existe una sola vez.
 *   3. version.json existe, es JSON válido y su build == DREX_BUILD.
 *   4. El updater consulta version.json con no-store y compara sellos.
 *   5. El updater escucha visibilitychange y pageshow (reapertura en iOS).
 *   6. Existe window.DrexForceUpdate y el aviso tiene textos ES/EN/ZH/PT.
 *   7. 404.html contiene el mismo updater (sincronizado).
 *   8. sw.js sigue sin cachear version.json (siempre va a la red).
 *
 * Uso: node tests/test-forced-update.js   (código 0 = todo OK)
 */
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var ROOT = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var src404 = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');
var sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
var vjson = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

test('window.DREX_BUILD presente en index.html', function () {
  var m = src.match(/window\.DREX_BUILD\s*=\s*'([^']+)'/);
  assert(m, 'no se encontró window.DREX_BUILD');
  assert(m[1].length >= 10, 'sello vacío o inválido');
});

test('bloque DREX-UPDATER presente una sola vez', function () {
  var n = (src.match(/DREX-UPDATER/g) || []).length;
  assert(n >= 1, 'bloque ausente');
  assert((src.match(/window\.DrexForceUpdate\s*=/g) || []).length === 1, 'DrexForceUpdate debe definirse una vez');
});

test('version.json válido y su build == DREX_BUILD', function () {
  var m = src.match(/window\.DREX_BUILD\s*=\s*'([^']+)'/);
  assert(vjson.build, 'version.json sin build');
  assert(vjson.at, 'version.json sin at');
  assert.strictEqual(String(vjson.build), m[1], 'version.json.build != DREX_BUILD (regenerar en cada deploy)');
});

test('el updater consulta version.json con no-store y compara sellos', function () {
  assert(src.includes("fetch(url, { cache: 'no-store'"), 'fetch sin no-store');
  assert(src.includes('version.json'), 'no referencia version.json');
  assert(src.includes('String(d.build) !== String(BUILD)'), 'no compara sellos');
});

test('el updater escucha visibilitychange y pageshow', function () {
  assert(src.includes("document.addEventListener('visibilitychange'"), 'falta visibilitychange');
  assert(src.includes("window.addEventListener('pageshow'"), 'falta pageshow (bfcache iOS)');
});

test('aviso con textos ES/EN/ZH/PT y botón de actualización', function () {
  ['es:', 'en:', 'zh:', 'pt:'].forEach(function (k) {
    assert(src.includes(k + ' { t:'), 'falta idioma ' + k);
  });
  assert(src.includes('drex-update-banner'), 'falta el banner');
  assert(src.includes("searchParams.set('drexv'"), 'falta cache-busting ?drexv=');
});

test('404.html contiene el mismo updater', function () {
  var m = src.match(/window\.DREX_BUILD\s*=\s*'([^']+)'/);
  assert(src404.includes("window.DREX_BUILD = '" + m[1] + "'"), '404.html desincronizado');
  assert(src404.includes('window.DrexForceUpdate'), '404.html sin DrexForceUpdate');
});

test('sw.js no cachea version.json (siempre red)', function () {
  assert(sw.includes('version.json'), 'sw.js no menciona version.json');
  assert(/version\.json.*fetch\(req\)|fetch\(req\).*version\.json/s.test(sw) || sw.includes("endsWith('/version.json')"),
    'sw.js debe servir version.json siempre de la red');
});

console.log('\n' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
