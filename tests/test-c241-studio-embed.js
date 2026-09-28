/* ================================================================
 * C241 (2026-09-28): el Estudio va DENTRO de Drex Studio.
 * El panel del estudio (drexstudio-pane-estudio > drexstudioweb-panel)
 * quedó fuera del contenedor #drexstudio-view por un </div> mal
 * cerrado (C238): al abrir la pestaña Estudio aparecía suelto en el
 * body, sin posicionarse ni apilarse bien, y cualquier modal se le
 * interponía encima. Estos tests fijan la estructura correcta y que
 * en escritorio la vista use la pantalla completa (no la columna
 * móvil de 680px, porque el estudio es una herramienta de escritorio
 * con grid de 3 columnas).
 * Ejecutar: node tests/test-c241-studio-embed.js
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var repoDir = path.join(__dirname, '..');
function read(f) { return fs.readFileSync(path.join(repoDir, f), 'utf8'); }
var html = read('index.html');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

/* Balancea <div>...</div> desde el tag que contiene `id="..."` y
 * devuelve [inicio, fin] del elemento o null si el id no existe. */
function spanOf(id) {
  var i = html.indexOf('id="' + id + '"');
  if (i < 0) return null;
  var start = html.lastIndexOf('<div', i);
  var depth = 0, j = start;
  while (j < html.length) {
    var no = html.indexOf('<div', j), nc = html.indexOf('</div>', j);
    if (no !== -1 && (nc === -1 || no < nc)) { depth++; j = no + 4; }
    else if (nc !== -1) {
      depth--; j = nc + 6;
      if (depth === 0) return [start, nc + 6];
    } else break;
  }
  return null;
}

// ---- 1. el pane del estudio vive DENTRO de #drexstudio-view ----
test('drexstudio-pane-estudio existe', function () {
  assert(spanOf('drexstudio-pane-estudio'), 'no existe el pane');
});
test('drexstudio-pane-estudio está dentro de #drexstudio-view', function () {
  var v = spanOf('drexstudio-view'), p = spanOf('drexstudio-pane-estudio');
  assert(v && p && v[0] < p[0] && p[1] < v[1], 'pane fuera de la vista');
});
test('drexstudioweb-panel está dentro del pane de estudio', function () {
  var p = spanOf('drexstudio-pane-estudio'), w = spanOf('drexstudioweb-panel');
  assert(p && w && p[0] < w[0] && w[1] < p[1], 'panel fuera del pane');
});
test('los tres panes (efectos/transmitir/estudio) son hermanos dentro de la vista', function () {
  var v = spanOf('drexstudio-view');
  ['drexstudio-pane-efectos', 'drexstudio-pane-transmitir', 'drexstudio-pane-estudio'].forEach(function (id) {
    var p = spanOf(id);
    assert(p && v && v[0] < p[0] && p[1] < v[1], id + ' fuera de la vista');
  });
});

// ---- 2. en escritorio la vista del estudio NO se confina a la columna ----
test('la capa responsive excluye #drexstudio-view del confinamiento (4 selectores)', function () {
  var layer = html.slice(html.indexOf('id="drex-responsive-layer"'));
  layer = layer.slice(0, layer.indexOf('</style>'));
  var sel = /body div\.fixed\.inset-0((?::not\([^)]*\))+)/;
  var m1 = sel.exec(layer);
  assert(m1 && /:not\(#drexstudio-view\)/.test(m1[1]), 'falta :not(#drexstudio-view) en div.fixed.inset-0');
  var sel2 = /body div\.fixed\.left-0\.right-0((?::not\([^)]*\))+)/;
  var m2 = sel2.exec(layer);
  assert(m2 && /:not\(#drexstudio-view\)/.test(m2[1]), 'falta :not(#drexstudio-view) en div.fixed.left-0.right-0');
  // versión clara y oscura
  assert((layer.match(/:not\(#drexstudio-view\)/g) || []).length >= 4,
    'se esperaban >=4 exclusiones (claro+oscuro × 2 selectores)');
});

// ---- 3. el grid de 3 columnas del estudio sigue intacto ----
test('.dsw-main conserva el grid de escritorio (264px/1fr/300px)', function () {
  assert(/\.dsw-main\{[^}]*grid-template-columns:264px minmax\(0,1fr\) 300px/.test(html),
    'grid de .dsw-main cambió');
});
test('.dsw-main colapsa bajo 1100px (tablets)', function () {
  assert(/@media \(max-width:1100px\)\{\.dsw-main\{grid-template-columns:220px minmax\(0,1fr\)/.test(html),
    'falta el colapso responsive de .dsw-main');
});

// ---- 4. la vista sigue siendo overlay fijo con su z-index ----
test('#drexstudio-view conserva fixed inset-0 z-[200] y overflow-y-auto', function () {
  var i = html.indexOf('id="drexstudio-view"');
  var tag = html.slice(html.lastIndexOf('<div', i), html.indexOf('>', i) + 1);
  assert(/class="fixed inset-0 z-\[200\] hidden/.test(tag), 'clases base cambiaron: ' + tag);
  assert(/overflow-y-auto/.test(tag), 'sin overflow-y-auto');
});

console.log('\n' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
