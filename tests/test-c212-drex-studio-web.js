#!/usr/bin/env node
/* ================================================================
 * Tests de regresión: Drex Studio (web) v1 — subpágina en la app
 * (2026-09-27)
 *
 * Cubre:
 *  1. Registro en SUBPAGE_VIEWS ('drex-studio' -> 'drexstudio-view') y
 *     en DREX_LEGACY_HASH_ROUTES ('drex-studio' -> 'drex-studio').
 *  2. Botón "Drex Studio" en Configuración > Legal y empresa con
 *     onclick="openSubpageView('drex-studio')" y subtítulo i18n.
 *  3. Vista #drexstudio-view: fixed inset-0 z-[200] hidden, con botón
 *     cerrar que llama closeSubpageView().
 *  4. Botón de descarga con la URL exacta del zip de Windows y etiqueta
 *     "Descargar para Windows".
 *  5. La palabra "SpaceX" (case-insensitive) NO aparece en el bloque nuevo.
 *  6. Paridad i18n ES/EN/ZH/PT de las 18 claves nuevas (+ placeholders).
 *  7. three.js es perezoso: ningún <script src> global de three en el
 *     <head>; la carga es dinámica dentro de initDrexStudioView.
 *  8. window.__drexStudioStopAnim existe y se llama en openSubpageView
 *     (al cambiar de vista) y en closeSubpageView.
 *  9. Sintaxis válida del bloque <script> de initDrexStudioView (vm.Script).
 * 10. Los getElementById del bloque de init existen como ids en el HTML.
 *
 * Ejecutar con: node tests/test-c212-drex-studio-web.js [--target <ruta-index.html>]
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var path = require('path');

var target = path.join(__dirname, '..', 'index.html');
var ti = process.argv.indexOf('--target');
if (ti !== -1 && process.argv[ti + 1]) target = process.argv[ti + 1];
var src = fs.readFileSync(target, 'utf8');

var i18nPath = path.join(path.dirname(target), 'drex-i18n.js');
if (!fs.existsSync(i18nPath)) i18nPath = path.join(__dirname, '..', 'drex-i18n.js');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

var DOWNLOAD_URL = 'https://floreseternasoporte-creator.github.io/Beabo/Drex-Studio-1.5-Windows.zip';

var NEW_KEYS = [
  'Drex Studio',
  'Crea efectos para la cámara de Drex',
  'Herramienta de escritorio para creadores',
  'Drex Studio es la herramienta de escritorio para crear, probar y publicar efectos para la cámara de Drex: filtros, lentes y juegos interactivos.',
  'Nuevo proyecto',
  'Empieza desde plantillas listas para filtros, lentes AR y juegos.',
  'Preview 3D',
  'Previsualiza tu efecto en tiempo real antes de publicarlo.',
  'Detección facial',
  'Seguimiento de rostro y manos para efectos interactivos.',
  'Plantillas de juego',
  'Lógica de juego lista para crear minijuegos en la cámara.',
  'Editor de código',
  'Ajusta cada detalle con un editor de código integrado.',
  'Envía tu efecto',
  'Publica tu efecto y compártelo con toda la comunidad Drex.',
  'Descargar para Windows',
  'Requiere Windows 10 o superior.'
];

test('SUBPAGE_VIEWS registra drex-studio', function () {
  var m = src.match(/const SUBPAGE_VIEWS = \{([\s\S]*?)\};/);
  assert(m, 'no se encontró SUBPAGE_VIEWS');
  assert(/'drex-studio'\s*:\s*'drexstudio-view'/.test(m[1]), 'falta el registro drex-studio -> drexstudio-view');
});

test('DREX_LEGACY_HASH_ROUTES registra drex-studio', function () {
  var m = src.match(/const DREX_LEGACY_HASH_ROUTES = \{([\s\S]*?)\};/);
  assert(m, 'no se encontró DREX_LEGACY_HASH_ROUTES');
  assert(/'drex-studio'\s*:\s*'drex-studio'/.test(m[1]), 'falta la ruta legacy drex-studio');
});

test('DREX_ROUTES registra la ruta limpia drex-studio', function () {
  assert(/path:\s*'drex-studio'[\s\S]{0,200}?view:\s*'drexstudio-view'/.test(src),
    'falta la entrada { path: drex-studio, view: drexstudio-view } en DREX_ROUTES');
});

test('botón Drex Studio en Configuración > Legal y empresa', function () {
  assert(src.indexOf("openSubpageView('drex-studio')") !== -1, 'no hay botón con openSubpageView(\'drex-studio\')');
  // El botón vecino de empresa existe (el nuevo va justo después de él).
  var emp = src.indexOf("openSubpageView('empresa')");
  var stu = src.indexOf("openSubpageView('drex-studio')");
  assert(emp !== -1 && stu !== -1 && stu > emp, 'el botón debe ir después del de Nuestra Empresa');
  assert(src.indexOf('Crea efectos para la cámara de Drex') !== -1, 'falta el subtítulo del botón');
  assert(/openSubpageView\('drex-studio'\)"[^>]*>[\s\S]{0,400}?text-\[#2F33B8\]/.test(src), 'el icono del botón debe usar el índigo #2F33B8');
});

test('vista #drexstudio-view con cierre', function () {
  var m = src.match(/<div id="drexstudio-view"([^>]*)>/);
  assert(m, 'no existe el div #drexstudio-view');
  ['fixed', 'inset-0', 'z-[200]', 'hidden'].forEach(function (c) {
    assert(m[1].indexOf(c) !== -1, 'la vista debe incluir la clase ' + c);
  });
  var start = src.indexOf('<div id="drexstudio-view"');
  var closeBtn = src.indexOf('onclick="closeSubpageView()"', start);
  var nextView = src.indexOf('<div id="privacy-view"', start);
  assert(closeBtn !== -1 && closeBtn < nextView, 'la vista debe tener un botón que llame closeSubpageView()');
});

test('botón de descarga Windows con URL exacta', function () {
  assert(src.indexOf(DOWNLOAD_URL) !== -1, 'falta la URL de descarga del zip');
  var href = src.indexOf('href="' + DOWNLOAD_URL + '"');
  assert(href !== -1, 'la URL debe ir en un href');
  assert(src.indexOf('Descargar para Windows') !== -1, 'falta la etiqueta "Descargar para Windows"');
});

test('sin la palabra "SpaceX" en el bloque nuevo', function () {
  var start = src.indexOf('<div id="drexstudio-view"');
  assert(start !== -1, 'vista no encontrada');
  var scriptEnd = src.indexOf('</script>', src.indexOf('function initDrexStudioView'));
  assert(scriptEnd !== -1, 'script de init no encontrado');
  var block = src.slice(start, scriptEnd);
  assert(!/spacex/i.test(block), 'el bloque nuevo menciona SpaceX');
  // El botón de ajustes tampoco.
  var btn = src.indexOf("openSubpageView('drex-studio')");
  assert(!/spacex/i.test(src.slice(btn - 200, btn + 1200)), 'el botón de ajustes menciona SpaceX');
});

test('i18n: paridad ES/EN/ZH/PT de las 18 claves nuevas', function () {
  var i18n = fs.readFileSync(i18nPath, 'utf8');
  function dict(varName, nextName) {
    var s = i18n.indexOf(varName), e = i18n.indexOf(nextName, s);
    var sec = i18n.slice(s, e === -1 ? i18n.length : e);
    var closeIdx = sec.lastIndexOf('\n};');
    var objText = sec.slice(sec.indexOf('{'), closeIdx + 2);
    return new Function('return (' + objText + ');')();
  }
  var EN = dict('var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {');
  var ZH = dict('var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {');
  var PT = dict('var APP_PORTUGUESE_TEXT = {', 'var APP_CHINESE_ATTRS = {');
  function ph(s) { var o = [], r = /\{[^}]*\}/g, m; while ((m = r.exec(s)) !== null) o.push(m[0]); return o.sort().join('|'); }
  assert(NEW_KEYS.length === 18, 'se esperaban 18 claves nuevas');
  NEW_KEYS.forEach(function (k) {
    assert(k in EN, 'falta en EN: ' + k);
    assert(k in ZH, 'falta en ZH: ' + k);
    assert(k in PT, 'falta en PT: ' + k);
    assert(ph(EN[k]) === ph(ZH[k]) && ph(ZH[k]) === ph(PT[k]), 'placeholders distintos en: ' + k);
    assert(EN[k].length > 0 && ZH[k].length > 0 && PT[k].length > 0, 'valor vacío en: ' + k);
  });
});

test('three.js solo se carga de forma perezosa (sin script global)', function () {
  var head = src.slice(0, src.indexOf('</head>'));
  assert(!/three/i.test(head), 'hay una referencia a three en el <head>');
  assert(!/<script[^>]+src=["'][^"']*three[^"']*["']/.test(src), 'hay un <script src> estático de three.js');
  assert(src.indexOf("document.createElement('script')") !== -1, 'falta la inyección dinámica del script');
  assert(src.indexOf('three@0.149.0/build/three.min.js') !== -1, 'el CDN pineado de three.js debe estar en el loader');
  assert(src.indexOf("s.onerror") !== -1, 'el loader debe manejar el fallo del CDN (fallback)');
});

test('__drexStudioStopAnim expuesta y llamada al cambiar/cerrar', function () {
  assert(src.indexOf('window.__drexStudioStopAnim') !== -1, 'no se expone window.__drexStudioStopAnim');
  assert(/name !== 'drex-studio' && typeof window\.__drexStudioStopAnim === 'function'/.test(src),
    'openSubpageView debe detener la animación al cambiar de vista');
  var closeFn = src.match(/function closeSubpageView\(\) \{([\s\S]*?)\n\}/);
  assert(closeFn && closeFn[1].indexOf('__drexStudioStopAnim') !== -1,
    'closeSubpageView debe detener la animación');
  assert(/if \(name === 'drex-studio' && typeof initDrexStudioView === 'function'\) initDrexStudioView\(\);/.test(src),
    'openSubpageView debe inicializar la vista drex-studio');
});

test('sintaxis válida del script de initDrexStudioView', function () {
  var s = src.indexOf('function initDrexStudioView');
  var scriptOpen = src.lastIndexOf('<script', s);
  var scriptClose = src.indexOf('</script>', s);
  assert(scriptOpen !== -1 && scriptClose !== -1, 'bloque script no encontrado');
  var code = src.slice(src.indexOf('>', scriptOpen) + 1, scriptClose);
  new vm.Script(code, { filename: 'drexstudio-init.js' });
});

test('ids usados por initDrexStudioView existen en el HTML', function () {
  var s = src.indexOf('function initDrexStudioView');
  var scriptClose = src.indexOf('</script>', s);
  var code = src.slice(s, scriptClose);
  var re = /getElementById\('([^']+)'\)/g, m, missing = [];
  while ((m = re.exec(code)) !== null) {
    if (src.indexOf('id="' + m[1] + '"') === -1) missing.push(m[1]);
  }
  assert(missing.length === 0, 'ids sin elemento: ' + missing.join(', '));
});

test('vista confinada a la columna en desktop (responsive layer)', function () {
  assert(/body div\.fixed\.inset-0:not\(#chat-photo-carousel\)/.test(src),
    'falta la regla de confinamiento desktop para vistas fixed inset-0');
  // La vista usa fixed inset-0, así que la regla la confina automáticamente.
});

console.log('\n' + passed + ' pasados, ' + failed + ' fallidos');
process.exit(failed ? 1 : 0);
