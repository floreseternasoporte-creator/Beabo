/* Prueba de regresión: plantilla clásica de la tarjeta del feed.
 *
 * Historia: el rediseño C228 (ronda 3) dejó 2 </div> de más en el template
 * y cambió el diseño a píldoras con etiqueta que desbordaban a 390px.
 * El usuario pidió volver al diseño de antes. Este test fija el estado
 * intencional actual:
 *   - encabezado clásico compacto (drex-post-meta pr-10)
 *   - fila de acciones con botones de icono (drex-post-actions)
 *   - SIN clases drex-fd-head / drex-fd-act en la plantilla
 *   - balance de <div> por rama (lo que C228 rompió y sus tests no vieron)
 *   - mejoras invisibles conservadas: doble-toque, algoritmo, 404 sincronizado
 *
 * Uso: node tests/test-feed-card-template.js   (código 0 = todo OK)
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

var START = '            <div class="drex-post-body">\n              <div class="drex-post-meta pr-10" data-author-id="${safeAuthorId}">';
var END_MARK = '            ${commentsCount > 0 ? `<div class="drex-commenters"';

function templateRegion(s) {
  var i = s.indexOf(START);
  assert(i !== -1, 'plantilla clásica no encontrada');
  assert(s.indexOf(START, i + 1) === -1, 'plantilla duplicada');
  var j = s.indexOf(END_MARK, i);
  assert(j !== -1, 'fin de plantilla no encontrado');
  return s.slice(i, j);
}
function branches(region) {
  var t = region.indexOf('${primaryCollab ? `');
  assert(t !== -1, 'ternario primaryCollab no encontrado');
  var te = region.indexOf('` : `', t);
  var fe = region.indexOf('`}', te);
  assert(te !== -1 && fe !== -1, 'ramas del ternario no delimitadas');
  return {
    pre: region.slice(0, t),
    bt: region.slice(t, te),
    bf: region.slice(te + 4, fe),
    post: region.slice(fe + 2)
  };
}
function divBal(s) {
  return (s.match(/<div\b/g) || []).length - (s.match(/<\/div>/g) || []).length;
}

test('plantilla clásica presente una sola vez', function () {
  templateRegion(src);
});

test('encabezado clásico: drex-post-meta pr-10 con avatar compacto', function () {
  var r = templateRegion(src);
  assert(r.indexOf('class="drex-post-meta pr-10"') !== -1, 'sin drex-post-meta pr-10');
  assert(r.indexOf('class="relative flex-shrink-0"') !== -1, 'sin avatar compacto');
  assert(r.indexOf('drex-post-author') !== -1, 'sin nombre de autor');
});

test('acciones clásicas: botones de icono compactos', function () {
  var r = templateRegion(src);
  assert(r.indexOf('<div class="drex-post-actions">') !== -1, 'sin drex-post-actions clásico');
  assert(r.indexOf('class="drex-action-pill"') !== -1, 'sin drex-action-pill');
  assert(r.indexOf('class="drex-action-icon"') !== -1, 'sin drex-action-icon');
  assert(r.indexOf('id="commentscount-${safeId}"') !== -1, 'sin contador de comentarios');
  assert(r.indexOf('id="eco-${safeId}"') !== -1, 'sin botón eco');
  assert(r.indexOf('id="save-${safeId}"') !== -1, 'sin botón guardar');
});

test('sin rediseño C228 en la plantilla (no debe desbordar a 390px)', function () {
  var r = templateRegion(src);
  ['drex-fd-head', 'drex-fd-idrow', 'drex-fd-id', 'drex-fd-ava',
   'drex-fd-names', 'drex-fd-name', 'drex-fd-sub', 'drex-fd-follow',
   'drex-fd-actions', 'drex-fd-act', 'drex-fd-act-label'
  ].forEach(function (c) {
    assert(r.indexOf(c) === -1, 'clase del rediseño aún presente: ' + c);
  });
});

test('balance de <div> por rama: ninguna tarjeta puede cerrar el contenedor del feed', function () {
  var b = branches(templateRegion(src));
  // drex-post-body se cierra DESPUÉS de la región -> total esperado +1 en ambas ramas
  assert(divBal(b.pre + b.bt + b.post) === 1, 'rama colaboración desbalanceada');
  assert(divBal(b.pre + b.bf + b.post) === 1, 'rama normal desbalanceada');
});

test('mejoras invisibles conservadas: doble-toque para votar', function () {
  assert(src.indexOf('window.drexFdEnhanceCard = drexFdEnhanceCard') !== -1, 'drexFdEnhanceCard no exportada');
  assert(src.indexOf('drex-fd-heart') !== -1, 'sin CSS del corazón de doble-toque');
});

test('algoritmo del feed intacto (C229)', function () {
  assert(src.indexOf('function drexRecScore(note)') !== -1, 'drexRecScore ausente');
  assert(src.indexOf('DREX_FORYOU_CHRONO') !== -1, 'DREX_FORYOU_CHRONO ausente');
});

test('404.html sincronizado con index.html', function () {
  assert(src === src404, '404.html difiere de index.html');
});

console.log('---');
console.log('TOTAL: ' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
