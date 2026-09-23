/* ================================================================
 * Tests de paridad i18n (drex-i18n.js)
 * P1: toda clave ES presente en APP_ENGLISH_TEXT debe existir también
 * en APP_CHINESE_TEXT y APP_PORTUGUESE_TEXT (y viceversa): evita que un
 * idioma caiga a otro por clave faltante (la brecha PT que motivó la
 * migración appT3 -> appT).
 * P2: los placeholders {n}, {a}, {b}, {c}, {f}, {m}... de cada clave
 * deben ser idénticos en los tres idiomas (un placeholder faltante
 * deja "{n}" literal en la UI).
 * Ejecutar con: node tests/test-i18n-key-parity.js
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */

var assert = require('assert');
var fs = require('fs');
var src = fs.readFileSync(__dirname + '/../drex-i18n.js', 'utf8');

function extractDict(varName, nextVarName) {
  var start = src.indexOf(varName);
  assert(start !== -1, 'no se encontró ' + varName);
  var end = nextVarName ? src.indexOf(nextVarName, start) : src.length;
  assert(end !== -1, 'no se encontró ' + nextVarName);
  var sec = src.slice(start, end);
  // El objeto termina en el último "\n};" de la sección (los valores son
  // literales JS con escapes no-JSON, ej. \', así que se evalúa en vez de
  // parsear como JSON).
  var closeIdx = sec.lastIndexOf('\n};');
  assert(closeIdx !== -1, 'cierre no encontrado para ' + varName);
  var objText = sec.slice(sec.indexOf('{'), closeIdx + 2);
  var dict = new Function('return (' + objText + ');')();
  assert(Object.keys(dict).length > 100, varName + ' parece vacío o mal parseado');
  return dict;
}

var EN = extractDict('var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {');
var ZH = extractDict('var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {');
var PT = extractDict('var APP_PORTUGUESE_TEXT = {', 'var APP_CHINESE_ATTRS = {');

function placeholders(s) {
  var out = [];
  var re = /\{[^}]*\}/g;
  var m;
  while ((m = re.exec(s)) !== null) out.push(m[0]);
  return out.sort();
}

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

test('paridad de claves EN vs ZH', function () {
  var enK = Object.keys(EN), zhK = Object.keys(ZH);
  var onlyEn = enK.filter(function (k) { return !(k in ZH); });
  var onlyZh = zhK.filter(function (k) { return !(k in EN); });
  assert(onlyEn.length === 0, 'claves solo en EN: ' + onlyEn.slice(0, 5).join(' / '));
  assert(onlyZh.length === 0, 'claves solo en ZH: ' + onlyZh.slice(0, 5).join(' / '));
});

test('paridad de claves EN vs PT', function () {
  var enK = Object.keys(EN), ptK = Object.keys(PT);
  var onlyEn = enK.filter(function (k) { return !(k in PT); });
  var onlyPt = ptK.filter(function (k) { return !(k in EN); });
  assert(onlyEn.length === 0, 'claves solo en EN: ' + onlyEn.slice(0, 5).join(' / '));
  assert(onlyPt.length === 0, 'claves solo en PT: ' + onlyPt.slice(0, 5).join(' / '));
});

test('placeholders idénticos en EN/ZH/PT por clave', function () {
  // Excepciones documentadas (decisiones lingüísticas, no bugs):
  var EXCEPTIONS = {
    // ZH no marca plural: {p} es ''/'s' en ES/EN/PT.
    'No se pudieron subir {n} foto{p}. Verifica tu conexión e intenta con imágenes más livianas.': { zh: ['{p}'] },
    // Traductor ZH: conserva {d} (índices), omite {c} ("la foto"/"las fotos", redundante con 张).
    'Se publicarán {a} de {b} fotos (no se pudo procesar {c} {d}).': { zh: ['{c}'] },
    // {c} es marca de plural (''/'s'); EN/ZH/PT no la necesitan ("unavailable"/"indisponível" son invariables).
    'Enviado a {a}. {b} no disponible{c}.': { en: ['{c}'], zh: ['{c}'], pt: ['{c}'] }
  };
  var bad = [];
  Object.keys(EN).forEach(function (k) {
    var keyPh = placeholders(k);
    [['EN', EN[k], (EXCEPTIONS[k] || {}).en || []],
     ['ZH', ZH[k], (EXCEPTIONS[k] || {}).zh || []],
     ['PT', PT[k], (EXCEPTIONS[k] || {}).pt || []]].forEach(function (t) {
      var lang = t[0], val = t[1] || '', exc = t[2];
      var missing = keyPh.filter(function (p) {
        return placeholders(val).indexOf(p) === -1 && exc.indexOf(p) === -1;
      });
      if (missing.length) bad.push(lang + ':' + k.slice(0, 40) + ' falta ' + missing.join(','));
    });
  });
  assert(bad.length === 0, 'placeholders faltantes: ' + bad.slice(0, 5).join(' / '));
});

test('ningún valor vacío en los tres idiomas', function () {
  var bad = [];
  Object.keys(EN).forEach(function (k) {
    if (!EN[k] || !ZH[k] || !PT[k]) bad.push(k);
  });
  assert(bad.length === 0, 'valores vacíos en: ' + bad.slice(0, 5).join(' / '));
});

test('conteo de claves reportado (' + Object.keys(EN).length + ' EN / ' +
  Object.keys(ZH).length + ' ZH / ' + Object.keys(PT).length + ' PT)', function () {
  assert(Object.keys(EN).length === Object.keys(ZH).length, 'EN/ZH difieren en conteo');
  assert(Object.keys(EN).length === Object.keys(PT).length, 'EN/PT difieren en conteo');
});

console.log('\nRESULTADO: ' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
