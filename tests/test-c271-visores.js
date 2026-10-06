'use strict';
/* C271 — Visores modernos (pedido del usuario con foto de referencia):
 * fuera los controles de arriba; transporte + acciones del post (voto,
 * eco, comentarios, compartir) viven ABAJO; la línea de progreso se
 * corre con el dedo (tocar/arrastrar), como en Threads; las fotos igual.
 * Ejecutar: node tests/test-c271-visores.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

console.log('== Nada de controles arriba ==');
ok(!html.includes('id="video-modal-title"'), 'video: fuera el título "Video" de arriba');
ok(html.includes('id="video-modal-topbar"') && html.includes('bg-black/35'),
  'video: arriba solo la X flotante');
const iTopImg = html.indexOf('id="image-modal-info"');
const iActionsImg = html.indexOf('id="image-modal-actions"');
ok(iTopImg > iActionsImg && iActionsImg > -1, 'fotos: info/rotar bajaron a la fila de acciones');
ok(!/id="image-modal-topbar"[\s\S]{0,900}image-modal-info/.test(html),
  'fotos: el botón de detalles ya NO está en la barra superior');

console.log('== Acciones abajo en ambos visores ==');
for (const p of ['video', 'image']) {
  ok(html.includes('id="' + p + '-modal-action-up"'), p + ': botón voto arriba');
  ok(html.includes('id="' + p + '-modal-action-score"'), p + ': marcador del riel');
  ok(html.includes('id="' + p + '-modal-action-down"'), p + ': botón voto abajo');
  ok(html.includes('id="' + p + '-modal-action-eco"'), p + ': botón eco');
  ok(html.includes('id="' + p + '-modal-action-comments"'), p + ': botón comentarios');
  ok(html.includes('id="' + p + '-modal-action-share"'), p + ': botón compartir');
}
ok(html.includes("onclick=\"_viewerRowVote('video','up')\""), 'la fila usa votePost vía _viewerRowVote');
ok(html.includes("onclick=\"_viewerRowComments('image')\""), 'comentarios de fotos abren desde la fila');
ok(html.includes('_paintViewerActionRow(\'video\', noteId);'), 'el video pinta sus acciones al abrir');
ok(html.includes('_paintViewerActionRow(\'image\', _feedImageModalNoteId);'), 'las fotos pintan sus acciones al abrir');

console.log('== Reglas Drex reutilizadas (no reinventadas) ==');
const iPaint = html.indexOf('async function _paintViewerActionRow');
const paintBody = html.slice(iPaint, iPaint + 5200);
ok(paintBody.includes("up.id = 'upvote-' + noteId;"), 'el voto adopta el id canónico de votePost');
ok(paintBody.includes("score.id = 'score-' + noteId;"), 'el marcador adopta el id canónico');
ok(paintBody.includes("userVotes/' + user.uid"), 'lee el voto del usuario para pintar el estado');
ok(paintBody.includes('ecoCountOf'), 'el conteo de ecos sale de ecoCountOf');
ok(html.includes("function _viewerRowComments(prefix)"), 'comentarios reutilizan _openViewerComments');

console.log('== La línea que se corre: proporción pura ==');
function extractFn(name) {
  const m = html.match(new RegExp('function ' + name + '\\b[\\s\\S]*?\\n  \\}', 'm'));
  if (!m) throw new Error('no encontrada: ' + name);
  return m[0];
}
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(extractFn('_videoModalSeekRatio'), sandbox);
const ratio = sandbox._videoModalSeekRatio;
ok(ratio(150, 100, 200) === 0.25, 'toque al 25% de la línea → 0.25');
ok(ratio(100, 100, 200) === 0, 'toque al inicio → 0');
ok(ratio(300, 100, 200) === 1, 'toque al final → 1');
ok(ratio(40, 100, 200) === 0, 'toque antes de la línea se queda en 0');
ok(ratio(999, 100, 200) === 1, 'toque después de la línea se queda en 1');
ok(ratio(150, 100, 0) === 0, 'línea sin ancho no rompe nada');
ok(!html.includes('_videoModalNav'), 'fuera el salto entre publicaciones deslizando (no era lo pedido)');

console.log('== La línea de progreso se corre con el dedo (contratos) ==');
ok(/<div id="video-modal-seek" role="slider"/.test(html), 'la línea es un slider propio, no el input del navegador');
ok(!/<input id="video-modal-seek"/.test(html), 'fuera el input range nativo');
ok(html.includes('_videoModalScrubbing') && html.includes('!_videoModalScrubbing'),
  'mientras arrastras, el timeupdate no pelea con tu dedo');
ok(html.includes("seek.addEventListener('pointerdown'"), 'tocar la línea busca en el video');
ok(html.includes("seek.addEventListener('pointermove'"), 'arrastrar la línea corre el video');
ok(html.includes('setPointerCapture(e.pointerId)'), 'el arrastre no se pierde si el dedo sale de la línea');
ok(html.includes('player.currentTime = ratio * dur'), 'la posición sale de la proporción tocada');

console.log(failures ? '\nRESULTADO: ' + failures + ' FALLO(S)' : '\nRESULTADO: TODO VERDE');
process.exit(failures ? 1 : 0);
