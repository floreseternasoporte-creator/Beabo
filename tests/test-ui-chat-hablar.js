// Auditoría UI Drex — carril 2B (mensajería, chat "Hablar").
// Verificaciones a nivel de fuente sobre index.html + drex-i18n.js:
//  1. Template del mensaje de grupo: UNA fila de encabezado [avatar | nombre · hora]
//     (.chat-msg-head) ARRIBA y el texto (.msg-bubble) DEBAJO.
//  2. El título del grupo se pinta sin emojis: "Hablar 🗣️" -> "Hablar".
//  3. El placeholder del input sale de i18n: clave fuente "Mensaje..." declarada
//     con data-drex-i18n-placeholder y traducida en EN/ZH/PT (nada hardcodeado).
//  4. El panel de opciones del chat (overlay con fondo negro) usa la convención
//     .hidden — sin style.display inline que pueda dejarlo atascado visible.
// Uso: node tests/test-ui-chat-hablar.js [ruta-a-index.html]
// Sale 0 si todo pasa, 1 si algo falla.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const INDEX = process.argv[2] || path.join(__dirname, '..', 'index.html');
const I18N = path.join(__dirname, '..', 'drex-i18n.js');
const SRC = fs.readFileSync(INDEX, 'utf8');
const I18N_SRC = fs.readFileSync(I18N, 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.log('  FALLO - ' + name + ': ' + e.message); }
}
function mustContain(hay, needle, what) {
  assert(hay.indexOf(needle) !== -1, 'no se encontró ' + (what || needle));
}
function mustNotContain(hay, needle, what) {
  assert(hay.indexOf(needle) === -1, 'apareció ' + (what || needle) + ' (no debería)');
}
// Extrae una function declarada del fuente y la devuelve callable.
function loadFn(name) {
  const m = SRC.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
  assert(m, 'no se encontró function ' + name + ' en index.html');
  return new Function(m[0] + '\nreturn ' + name + ';')();
}

console.log('== Chat "Hablar": orden, título, placeholder i18n, overlay ==');

// --- 1. Orden clásico: encabezado [avatar|nombre·hora] -> texto ---
test('grupo: encabezado .chat-msg-head antes que la burbuja', () => {
  const i = SRC.indexOf('<div class="chat-msg-head');
  assert(i !== -1, 'no se encontró el encabezado en el template de grupo');
  const blk = SRC.slice(i, i + 2200);
  const iAvatar = blk.indexOf('group-sender-avatar');
  const iName = blk.indexOf('group-sender-label');
  const iTime = blk.indexOf('chat-msg-time');
  const iBubble = blk.indexOf('msg-bubble');
  assert(iAvatar !== -1 && iName !== -1 && iTime !== -1 && iBubble !== -1, 'faltan piezas');
  assert(iAvatar < iName && iName < iTime, 'orden del encabezado: avatar -> nombre -> hora');
  assert(iTime < iBubble, 'el encabezado completo va ANTES del texto');
});
test('grupo: la hora vive dentro del encabezado (no debajo del texto)', () => {
  const i = SRC.indexOf('<div class="chat-msg-head');
  const blk = SRC.slice(i, i + 2200);
  const iTime = blk.indexOf('chat-msg-time');
  const iCloseHead = blk.indexOf('</div>', blk.indexOf('group-sender-label'));
  assert(iTime !== -1 && iTime < iCloseHead, 'chat-msg-time debe estar dentro del encabezado');
});
test('grupo: mensajes agrupados ocultan el encabezado entero', () => {
  mustContain(SRC, "chat-msg-head flex items-center gap-2 mb-1 max-w-[85%]${_groupedWithPrev ? ' hidden' : ''}", 'toggle hidden');
  mustContain(SRC, "if (!_lastChatMsgNode.querySelector('.chat-msg-head'))", 'la agrupación respeta el encabezado previo');
});

// --- 2. Título sin emojis ---
test('grupo: el título se pinta con fiestaStripEmoji', () => {
  mustContain(SRC, 'fiestaStripEmoji(data.name', 'pintado sanitizado del título del grupo');
});
test('fiestaStripEmoji: "Hablar 🗣️" -> "Hablar"; normales intactos', () => {
  const fiestaStripEmoji = loadFn('fiestaStripEmoji');
  assert.strictEqual(fiestaStripEmoji('Hablar 🗣️'), 'Hablar');
  assert.strictEqual(fiestaStripEmoji('Amigos del trabajo'), 'Amigos del trabajo');
  assert.strictEqual(fiestaStripEmoji(''), '');
});

// --- 3. Placeholder desde i18n ---
test('input: clave fuente i18n declarada en el atributo', () => {
  const m = SRC.match(/<input id="chat-room-input"[^>]*>/);
  assert(m, 'no se encontró #chat-room-input');
  mustContain(m[0], 'placeholder="Mensaje..."', 'fuente ES en placeholder');
  mustContain(m[0], 'data-drex-i18n-placeholder="Mensaje..."', 'clave fuente i18n explícita');
});
test('ningún placeholder hardcodeado en inglés', () => {
  mustNotContain(SRC, 'placeholder="Message', 'placeholder inglés');
  mustNotContain(SRC, 'placeholder="Type a message', 'placeholder inglés');
});
test('diccionarios de atributos EN/ZH/PT cubren "Mensaje..."', () => {
  mustContain(I18N_SRC, '"Mensaje...":"Message..."', 'EN');
  mustContain(I18N_SRC, '"Mensaje...":"消息…"', 'ZH');
  mustContain(I18N_SRC, '"Mensaje...":"Mensagem..."', 'PT');
});

// --- 4. Overlay de opciones: convención .hidden (no style.display) ---
test('chat-options-panel usa la clase hidden', () => {
  const m = SRC.match(/<div id="chat-options-panel"[^>]*>/);
  assert(m, 'no se encontró #chat-options-panel');
  mustContain(m[0], 'hidden', 'clase hidden presente');
  mustNotContain(m[0], 'style="display:none"', 'sin display:none inline');
  mustContain(m[0], 'flex', 'display flex por clase');
});
test('open/close del panel usan classList (no style.display)', () => {
  const i = SRC.indexOf('function openChatOptionsPanel');
  assert(i !== -1, 'no se encontró openChatOptionsPanel');
  const blk = SRC.slice(i, i + 700);
  mustContain(blk, "classList.remove('hidden')", 'open por clase');
  mustContain(blk, "classList.add('hidden')", 'close por clase');
  mustNotContain(blk, 'style.display', 'sin style.display inline');
});

console.log(failed === 0 ? `\nRESULTADO: ${passed} ok, 0 fallos` : `\nRESULTADO: ${passed} ok, ${failed} FALLOS`);
process.exit(failed === 0 ? 0 : 1);
