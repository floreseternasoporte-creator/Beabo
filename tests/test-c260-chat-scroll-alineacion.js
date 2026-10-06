'use strict';
/* C260 — Chats deslizando "todo junto" + mensajes desalineados de la foto
 * (capturas del usuario 2026-10-06, sala 1:1 con "gilchiquitin").
 *
 * Causa raíz: al deslizar dentro de la conversación, el gesto se
 * encadenaba al documento; iOS corre el visualViewport y el ancla iOS del
 * chat (offsetTop) movía la sala ENTERA (encabezado, mensajes, composer).
 * Y la hora vivía dentro de la columna de la burbuja: el avatar quedaba
 * pegado a la hora, no al mensaje, y se veía corrido de la foto.
 *
 * Fix: overscroll-behavior contain/none en lista/vista/inbox, bloqueo del
 * documento mientras la sala está abierta (observador del class) y la
 * hora como línea propia bajo la fila foto+burbuja.
 * Ejecutar: node tests/test-c260-chat-scroll-alineacion.js
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

console.log('== La sala no arrastra el documento ==');
ok(/id="chat-room-view"[^>]*overscroll-behavior:none/.test(html), 'vista de la sala: overscroll-behavior:none');
ok(/id="chat-room-messages"[^>]*overscroll-behavior:contain/.test(html), 'lista de mensajes: overscroll-behavior:contain');
ok(/id="chat-room-messages"[^>]*touch-action:pan-y/.test(html), 'lista de mensajes: el gesto vertical es de la lista');
ok(/id="chat-inbox-view"[^>]*overscroll-behavior:contain/.test(html), 'bandeja de chats: overscroll-behavior:contain');
ok(html.includes('_chatLockSync') && html.includes('attributeFilter'), 'observador de visibilidad presente');
ok(/visible && !_chatBodyLocked\) \{ _chatBodyLocked = true; try \{ lockBodyScroll/.test(html), 'al abrir la sala se bloquea el documento');
ok(/!visible && _chatBodyLocked\) \{ _chatBodyLocked = false; try \{ unlockBodyScroll/.test(html), 'al cerrar la sala se desbloquea el documento');

console.log('== Mensajes alineados con la foto ==');
ok(html.includes("${showDmAvatar ? '' : timeHtml}"), 'con avatar, la hora ya no vive dentro de la columna');
ok(html.includes('pl-[44px] mt-1'), 'la hora va bajo la fila, alineada con la burbuja (foto 36 + hueco 8)');
ok((html.match(/id="chat-room-messages"/g) || []).length === 1, 'una sola lista de mensajes');
ok(html.includes("dmAvatarHtml}<div class=\"flex flex-col items-start min-w-0\">"), 'la burbuja sigue junto al avatar con items-end');

console.log(failures ? '\nRESULTADO: ' + failures + ' FALLO(S)' : '\nRESULTADO: TODO VERDE');
process.exit(failures ? 1 : 0);
