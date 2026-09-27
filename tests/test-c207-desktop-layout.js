/* ================================================================
 * Tests de regresión: rediseño desktop C207 (2026-09-27)
 * Verifica sin navegador que el responsive layer
 * (<style id="drex-responsive-layer">) implementa el layout de
 * escritorio real: columna ancha y fluida, sidebar, panel derecho,
 * confinamiento de vistas/modales con sombra, visores de foto/video
 * a pantalla completa, tarjeta de login, drawer anclado a la columna,
 * toasts acotados y ausencia del bloque legacy body.desktop.
 * Todo el CSS responsive nuevo vive en @media (min-width:…): en móvil
 * (<768px) no cambia NADA.
 * Ejecutar con: node tests/test-c207-desktop-layout.js
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');

var src = fs.readFileSync(__dirname + '/../index.html', 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

function layer() {
  var m = src.match(/<style id="drex-responsive-layer">([\s\S]*?)<\/style>/);
  assert(m, 'no se encontró <style id="drex-responsive-layer">');
  return m[1];
}
var L = layer();

function layerWithoutMedia(css) {
  // Elimina bloques @media (...) { ... } balanceados (un nivel de anidación basta:
  // el layer solo anida :root/reglas simples dentro de cada @media).
  var out = '';
  var i = 0;
  while (i < css.length) {
    var at = css.indexOf('@media', i);
    if (at === -1) { out += css.slice(i); break; }
    out += css.slice(i, at);
    var open = css.indexOf('{', at);
    var depth = 1, j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    i = j;
  }
  return out;
}

/* ---------- El layer existe y todo vive en min-width ---------- */
test('el responsive layer existe y es el único sistema responsive', function () {
  assert(L.length > 4000, 'layer sospechosamente pequeño: ' + L.length);
  assert(L.length < 14000, 'layer creció sin control: ' + L.length + ' (presupuesto peso)');
});

test('todo el CSS del layer vive dentro de @media (min-width:…)', function () {
  var rest = layerWithoutMedia(L).replace(/\/\*[\s\S]*?\*\//g, '').trim();
  // Única excepción legítima: el oculto base del sidebar/panel en móvil.
  rest = rest.replace(/#desktop-sidebar,\s*#desktop-rightpanel\s*\{\s*display:\s*none;\s*\}/g, '').trim();
  assert(!/[a-z#.\[][a-z-]*\s*\{/.test(rest),
    'hay reglas fuera de @media (min-width): el móvil cambiaría: ' + rest.slice(0, 120));
});

test('breakpoints coherentes 768 / 1024 / 1360 sin sistemas paralelos', function () {
  assert(L.indexOf('@media (min-width: 768px)') !== -1, 'falta breakpoint 768');
  assert(L.indexOf('@media (min-width: 1024px)') !== -1, 'falta breakpoint 1024');
  assert(L.indexOf('@media (min-width: 1360px)') !== -1, 'falta breakpoint 1360');
  assert(L.indexOf('@media (min-width: 1024px) and (max-width: 1279.98px)') !== -1,
    'falta rango angosto 1024-1279.98 (sidebar solo-iconos)');
});

test('sin @media sueltos duplicando el layer fuera de él', function () {
  var noLayer = src.replace(/<style id="drex-responsive-layer">[\s\S]*?<\/style>/, '');
  // El CSS compilado de Tailwind (sus propias utilidades responsive sm:/md:/lg:)
  // no es un sistema paralelo del autor: se excluye del conteo.
  noLayer = noLayer.replace(/<style>[\s\S]*?tailwindcss v3[\s\S]*?<\/style>/, '');
  var n768 = (noLayer.match(/@media\s*\(\s*min-width:\s*768px\s*\)/g) || []).length;
  var n1024 = (noLayer.match(/@media\s*\(\s*min-width:\s*1024px\s*\)/g) || []).length;
  var n1360 = (noLayer.match(/@media\s*\(\s*min-width:\s*1360px\s*\)/g) || []).length;
  assert.strictEqual(n768 + n1024 + n1360, 0,
    'quedan @media sueltos fuera del layer (768:' + n768 + ' 1024:' + n1024 + ' 1360:' + n1360 + ')');
});

/* ---------- Bloque legacy body.desktop eliminado ---------- */
test('bloque legacy body.desktop eliminado del CSS', function () {
  assert(src.indexOf('body.desktop') === -1, 'aún existe CSS body.desktop');
});

test('clase desktop ya no se agrega por JS (era write-only)', function () {
  assert(src.indexOf("classList.add('desktop')") === -1 &&
         src.indexOf('classList.add("desktop")') === -1,
    'aún se agrega la clase desktop sin que nada la lea');
});

/* ---------- Confinamiento de vistas y modales ---------- */
var MEDIA_VIEWERS = ['chat-photo-carousel', 'image-modal', 'video-modal', 'cover-fullscreen-view'];

test('el confinamiento genérico excluye solo los visores de foto/video', function () {
  MEDIA_VIEWERS.forEach(function (id) {
    assert(L.indexOf(':not(#' + id + ')') !== -1,
      'el visor ' + id + ' no está en la lista de excepciones fullscreen');
  });
  assert(L.indexOf('[class*="bg-black"]') === -1,
    'la exclusión vieja por [class*="bg-black"] dejaría modales a pantalla completa');
});

test('los visores de foto/video son fixed inset-0 (la excepción es lo que los deja fullscreen)', function () {
  MEDIA_VIEWERS.forEach(function (id) {
    var m = src.match(new RegExp('<div id="' + id + '" class="([^"]*)"'));
    assert(m, 'markup del visor ' + id + ' no encontrado');
    assert(m[1].indexOf('fixed inset-0') !== -1,
      id + ' ya no es fixed inset-0: cambió el supuesto del confinamiento');
  });
});

var VIEWS = ['profile-view', 'search-view', 'baro-view', 'chat-inbox-view', 'comments-view', 'creator-hub-view'];

test('las 6 vistas fullscreen siguen siendo fixed inset-0 (las cubre el confinamiento)', function () {
  VIEWS.forEach(function (id) {
    var m = src.match(new RegExp('<div id="' + id + '" class="([^"]*)"'));
    assert(m, 'markup de la vista ' + id + ' no encontrado');
    assert(m[1].indexOf('fixed inset-0') !== -1,
      id + ' ya no es fixed inset-0: el confinamiento no la cubriría');
    assert(MEDIA_VIEWERS.indexOf(id) === -1, id + ' colisiona con un visor');
  });
});

test('los modales con backdrop oscuro quedan confinados (no excluidos)', function () {
  ['chat-edit-modal', 'chat-forward-dialog', 'block-confirm-modal', 'note-modal',
   'side-panel-overlay', 'new-device-alert-modal'].forEach(function (id) {
    var m = src.match(new RegExp('id="' + id + '" class="([^"]*)"'));
    assert(m, 'markup del modal ' + id + ' no encontrado');
    assert(m[1].indexOf('fixed inset-0') !== -1, id + ' no es fixed inset-0');
    assert(MEDIA_VIEWERS.indexOf(id) === -1, id + ' no debe ser excepción fullscreen');
  });
});

test('el confinamiento aplica max-width de columna + sombra', function () {
  assert(/max-width:\s*var\(--drex-col\)/.test(L), 'falta max-width: var(--drex-col)');
  assert(L.indexOf('box-shadow: 0 0 60px rgba(15, 35, 70, .10)') !== -1,
    'falta la sombra del contenedor en claro');
  assert(L.indexOf('box-shadow: 0 0 60px rgba(0, 0, 0, .45)') !== -1,
    'falta la sombra del contenedor en oscuro');
});

/* ---------- Columna ancha y fluida en escritorio ---------- */
test('columna 640px en 1024-1360 y fluida 700-760px en >=1360', function () {
  assert(/@media\s*\(\s*min-width:\s*1024px\s*\)[\s\S]*?:root\s*\{\s*--drex-col:\s*640px/.test(L),
    'falta --drex-col: 640px en el bloque >=1024px');
  assert(L.indexOf('--drex-col: clamp(700px, calc(100vw - 660px), 760px)') !== -1,
    'falta la columna fluida clamp(700px, 100vw-660px, 760px) en >=1360px');
});

test('sidebar 252px / 76px solo-iconos y panel derecho 300px en >=1360', function () {
  assert(/#desktop-sidebar\s*\{[^}]*width:\s*252px/.test(L), 'falta sidebar de 252px');
  assert(/max-width:\s*1279\.98px\)[\s\S]*?#desktop-sidebar\s*\{[^}]*width:\s*76px/.test(L),
    'falta sidebar solo-iconos de 76px en 1024-1279.98');
  assert(L.indexOf('#desktop-rightpanel') !== -1, 'falta el panel derecho');
  assert(/@media\s*\(\s*min-width:\s*1360px\s*\)[\s\S]*?width:\s*300px/.test(L),
    'el panel derecho debe ajustarse a 300px en >=1360 para que quepa con la columna ancha');
  // El posicionamiento del sidebar/panel deriva de --drex-col: si la columna
  // crece, ellos se desplazan solos (sin números duplicados).
  var sidePos = L.match(/#desktop-sidebar\s*\{[^}]*left:\s*calc\(50vw - \(var\(--drex-col\) \/ 2\)[^}]*\}/);
  assert(sidePos, 'el sidebar debe posicionarse con var(--drex-col)');
});

/* ---------- Auth como tarjeta en escritorio ---------- */
test('auth-form como tarjeta centrada en >=1024px', function () {
  var m = L.match(/@media\s*\(\s*min-width:\s*1024px\s*\)[\s\S]*?#auth-form\s*\{([\s\S]*?)\}/);
  assert(m, 'falta regla #auth-form en el bloque >=1024px');
  var body = m[1];
  assert(/max-width:\s*460px/.test(body), 'la tarjeta debe tener max-width 460px');
  assert(/height:\s*auto\s*!important/.test(body), 'falta height:auto !important (pisa el 100dvh en línea)');
  assert(/border-radius:\s*28px/.test(body), 'falta border-radius de tarjeta');
  assert(/box-shadow:\s*0 24px 80px/.test(body), 'falta sombra de tarjeta');
});

test('la tarjeta de auth no es franja en tablet (sigue confinada a la columna)', function () {
  var m = L.match(/@media\s*\(\s*min-width:\s*768px\s*\)[\s\S]*?#auth-form\s*\{([\s\S]*?)\}/);
  assert(m && /max-width:\s*var\(--drex-col\)/.test(m[1]),
    'en tablet el auth debe seguir confinado a la columna');
});

/* ---------- Drawer anclado a la columna ---------- */
test('drawer anclado al borde de la columna en escritorio', function () {
  assert(/#side-panel-drawer\s*\{\s*left:\s*calc\(50vw - \(var\(--drex-col\) \/ 2\)\)/.test(L),
    'falta el anclaje del drawer al borde de la columna en >=1024px');
});

test('el estado oculto del drawer compensa el anclaje (sin franja visible)', function () {
  var m = L.match(/#side-panel-drawer\.-translate-x-full\s*\{([^}]*)\}/);
  assert(m, 'falta la compensación del estado oculto del drawer');
  assert(m[1].indexOf('--tw-translate-x') !== -1 &&
         /calc\(-100% - \(50vw - \(var\(--drex-col\) \/ 2\)\)/.test(m[1]),
    'la compensación debe mover el drawer su ancho + el borde de la columna');
});

/* ---------- Toasts y profile-config ---------- */
test('toasts acotados al ancho de la columna', function () {
  var m = L.match(/#mini-toast\s*\{([^}]*)\}/);
  assert(m, 'falta regla #mini-toast en el layer');
  assert(/max-width:\s*calc\(var\(--drex-col\) - 48px\)\s*!important/.test(m[1]),
    'el toast debe acotarse a la columna con !important (pisa el estilo en línea)');
});

test('profile-config-view anclada al ancho de la columna', function () {
  assert(/#profile-config-view\s*\{\s*max-width:\s*var\(--drex-col\)/.test(L),
    'falta el ancla explícita de #profile-config-view a la columna');
  assert(src.indexOf('sm:max-w-[430px]') !== -1,
    'supuesto: el markup conserva sm:max-w-[430px] y el layer lo pisa');
});

/* ---------- Higiene: sin JS nuevo, sin onclick, peso acotado ---------- */
test('el layer no agrega onclick ni texto visible nuevo (sin i18n pendiente)', function () {
  // El selector preexistente [onclick="openSidePanel()"] oculta el botón
  // hamburguesa; lo prohibido es agregar manejadores (atributo onclick=).
  assert(!/\sonclick\s*=/.test(L), 'el layer no debe agregar atributos onclick=');
});

test('peso del layer acotado (delta neto ≈ 0)', function () {
  assert(L.length < 14000, 'layer: ' + L.length + ' bytes (techo 14KB)');
});

console.log('\nRESULTADO: ' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
