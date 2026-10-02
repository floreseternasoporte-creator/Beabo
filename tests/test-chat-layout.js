// Regresión de layout del chat (CARRIL-2 — mensajería).
// Verificaciones a nivel de fuente sobre index.html + drex-i18n.js:
//  1. El template de fiestaAppendChatMsg ordena: avatar (izquierda) -> encabezado
//     "nombre · hora" (.fiesta-chat-head) -> texto (.fiesta-chat-bubble).
//  2. El título de la sala se pinta sin emojis (fiestaStripEmoji): "Hablar 🗣️" -> "Hablar".
//  3. Los placeholders de los inputs de mensaje salen de i18n (nada hardcodeado en
//     inglés): "Mensaje..." y "Di algo…" existen en ES/EN/ZH/PT.
//  4. Claves de la bandeja de chats ("Fijado", estados vacíos) en ES/EN/ZH/PT.
//  5. Guardia del template de chat DM/grupo: nombre -> avatar -> burbuja -> hora.
// Uso: node tests/test-chat-layout.js [ruta-a-index.html]
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
// Extrae una function declarada del fuente y la devuelve callable
// (new Function evita el scope propio del eval en strict mode).
function loadFn(name) {
  const m = SRC.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
  assert(m, 'no se encontró function ' + name + ' en index.html');
  return new Function(m[0] + '\nreturn ' + name + ';')();
}

console.log('== Layout del chat: orden, título sin emojis, placeholders i18n ==');

// --- 1. Orden del template del chat de fiesta ---
const _fi = SRC.indexOf('function fiestaAppendChatMsg');
assert(_fi !== -1, 'no se encontró fiestaAppendChatMsg');
const fiestaBlk = SRC.slice(_fi, _fi + 2600);

test('fiesta: avatar antes que encabezado antes que burbuja', () => {
  // lastIndexOf: el comentario CARRIL-2 nombra las clases antes que el template real.
  const iAvatar = fiestaBlk.lastIndexOf('rounded-full object-cover shrink-0 mt-0.5');
  const iHead = fiestaBlk.lastIndexOf('fiesta-chat-head');
  const iBubble = fiestaBlk.lastIndexOf('fiesta-chat-bubble');
  assert(iAvatar !== -1 && iHead !== -1 && iBubble !== -1, 'faltan piezas del template');
  assert(iAvatar < iHead, 'el avatar debe ir ANTES del encabezado');
  assert(iHead < iBubble, 'el encabezado (nombre·hora) debe ir ANTES del texto');
});
test('fiesta: encabezado con nombre + hora juntos', () => {
  mustContain(fiestaBlk, 'fiesta-chat-head', 'clase del encabezado');
  mustContain(fiestaBlk, 'fiesta-chat-time', 'hora dentro del encabezado');
  mustContain(fiestaBlk, '+ name + (headTime', 'el nombre y la hora se concatenan en el <p> del encabezado');
  mustContain(SRC, 'function fiestaChatTime(ts)', 'helper de hora declarado');
});
test('fiestaChatTime: formatea hoy y tolera entradas vacías', () => {
  const fiestaChatTime = loadFn('fiestaChatTime');
  const t = fiestaChatTime(Date.now());
  assert(/^\d{1,2}:\d{2}/.test(t), 'hora de hoy con formato HH:MM, dio: ' + t);
  assert.strictEqual(fiestaChatTime(null), '');
  assert.strictEqual(fiestaChatTime(undefined), '');
  assert.strictEqual(fiestaChatTime('no-es-fecha'), '');
});

// --- 2. Título de la sala sin emojis ---
test('fiesta: el título se pinta con fiestaStripEmoji', () => {
  mustContain(SRC, 'fiestaStripEmoji(fiestaCur.data.title)', 'pintado sanitizado del título');
  mustNotContain(SRC, "textContent = fiestaCur.data.title;", 'pintado crudo del título');
});
test('fiestaStripEmoji: "Hablar 🗣️" -> "Hablar"', () => {
  const fiestaStripEmoji = loadFn('fiestaStripEmoji');
  assert.strictEqual(fiestaStripEmoji('Hablar 🗣️'), 'Hablar');
  assert.strictEqual(fiestaStripEmoji('Fiesta 🎉 de prueba 🔥'), 'Fiesta de prueba');
  assert.strictEqual(fiestaStripEmoji('Sin emojis'), 'Sin emojis');
  assert.strictEqual(fiestaStripEmoji(null), '');
});

// --- 3. Placeholders desde i18n (nada en inglés hardcodeado) ---
test('ningún placeholder hardcodeado en inglés', () => {
  mustNotContain(SRC, 'placeholder="Message', 'placeholder inglés');
  mustNotContain(SRC, 'placeholder="Type a message', 'placeholder inglés');
  mustNotContain(SRC, 'placeholder="Write a message', 'placeholder inglés');
  mustNotContain(SRC, 'placeholder="Say something', 'placeholder inglés');
});
test('input DM: placeholder "Mensaje..." (fuente ES del diccionario)', () => {
  const m = SRC.match(/<input id="chat-room-input"[^>]*placeholder="([^"]*)"/);
  assert(m, 'no se encontró #chat-room-input');
  assert.strictEqual(m[1], 'Mensaje...', 'el HTML usa la fuente ES, la traducción la pone el diccionario');
});
test('input fiesta: placeholder "Di algo…" (fuente ES del diccionario)', () => {
  const m = SRC.match(/<input id="fiesta-chat-input"[^>]*placeholder="([^"]*)"/);
  assert(m, 'no se encontró #fiesta-chat-input');
  assert.strictEqual(m[1], 'Di algo…', 'el HTML usa la fuente ES, la traducción la pone el diccionario');
});
test('diccionarios EN/ZH/PT cubren los placeholders de mensajería', () => {
  const pairs = [
    ['"Mensaje...":"Message..."', 'EN Mensaje...'],
    ['"Mensaje...":"消息…"', 'ZH Mensaje...'],
    ['"Mensaje...":"Mensagem..."', 'PT Mensaje...'],
    ['"Di algo…":"Say something…"', 'EN Di algo…'],
  ];
  for (const [needle, what] of pairs) mustContain(I18N_SRC, needle, what);
  // ZH/PT de "Di algo…" (escritos con caracteres literales en el fuente)
  mustContain(I18N_SRC, '"Di algo…":"说点什么…"', 'ZH Di algo…');
  mustContain(I18N_SRC, '"Di algo…":"Diga algo…"', 'PT Di algo…');
});
test('claves nuevas de la bandeja en ES/EN/ZH/PT', () => {
  for (const key of ['"Fijado"', '"No hay conversaciones con ese filtro."', '"Todavía no tienes chats. Toca el botón de escribir para iniciar uno."']) {
    const n = I18N_SRC.split(key).length - 1;
    assert(n >= 3, key + ' aparece ' + n + ' veces (se esperan EN+ZH+PT)');
  }
});

// --- 5. Guardia del template DM/grupo (no era el reportado; solo orden) ---
test('DM grupo: nombre -> avatar -> burbuja -> hora', () => {
  const i = SRC.indexOf('group-sender-label');
  assert(i !== -1, 'no se encontró el template de grupo');
  const blk = SRC.slice(i - 200, i + 2200);
  const iName = blk.indexOf('group-sender-label');
  const iAvatar = blk.indexOf('group-sender-avatar');
  const iBubble = blk.indexOf('msg-bubble');
  const iTime = blk.indexOf('chat-msg-time');
  assert(iName !== -1 && iAvatar !== -1 && iBubble !== -1 && iTime !== -1, 'faltan piezas del template DM');
  assert(iName < iAvatar && iAvatar < iBubble && iBubble < iTime, 'orden DM alterado');
});

console.log(failed === 0 ? `\nRESULTADO: ${passed} ok, 0 fallos` : `\nRESULTADO: ${passed} ok, ${failed} FALLOS`);
process.exit(failed === 0 ? 0 : 1);
