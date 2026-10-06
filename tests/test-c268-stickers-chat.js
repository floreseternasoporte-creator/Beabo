/* C268 — Stickers en mensajería: catálogo 50+ (vectorial + Mora), panel
   hasta la mitad con buscador/paquetes/carrusel, envío type:'sticker'. */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'drex-i18n.js'), 'utf8');

const g = { window: {} };
new Function('window', fs.readFileSync(path.join(root, 'drex-stickers.js'), 'utf8'))(g.window);
const all = g.window.DREX_STICKERS;
assert(Array.isArray(all), 'drex-stickers.js expone window.DREX_STICKERS');
assert(all.length >= 50, 'catálogo con 50+ stickers');

const ids = new Set(all.map(s => s.id));
assert(ids.size === all.length, 'ids únicos');
for (const s of all) {
  assert(s.id && s.name && s.pack, 'cada sticker trae id/name/pack: ' + s.id);
  if (s.img) {
    assert(fs.existsSync(path.join(root, s.img)), 'existe el archivo del sticker: ' + s.img);
  } else {
    assert(s.svg && s.svg.includes('viewBox="0 0 120 120"'), 'svg válido: ' + s.id);
    assert(!/xlink:href|<image|href="http|url\(\s*http/.test(s.svg), 'sin referencias externas: ' + s.id);
  }
  if (s.anim) assert(html.includes('@keyframes stk' + s.anim[0].toUpperCase() + s.anim.slice(1)) || html.includes('stk-a-' + s.anim), 'animación CSS presente: ' + s.anim);
}
const packs = new Set(all.map(s => s.pack));
for (const p of ['mora', 'caras', 'animales', 'amor', 'fiesta', 'comida', 'drex']) assert(packs.has(p), 'pack presente: ' + p);
assert(all.filter(s => s.anim).length >= 15, 'variedad animada (15+)');
const mora = all.filter(s => s.pack === 'mora');
assert(mora.length >= 4 && mora.every(s => s.img), 'pack Mora con PNG sin fondo');

// Panel del chat (mitad de pantalla, buscador, paquetes, carrusel)
for (const id of ['chat-sticker-overlay', 'chat-sticker-panel', 'chat-sticker-search', 'chat-sticker-packs', 'chat-sticker-grid', 'chat-sticker-carousel']) {
  assert(html.includes('id="' + id + '"'), 'panel: #' + id);
}
assert(html.includes('height:54vh'), 'la hoja sube hasta ~la mitad');
assert(html.includes('onclick="openChatStickerPicker()"'), 'botón de stickers en el campo de mensaje');
assert(html.includes('toggleChatQuickActions(); openChatStickerPicker()'), 'fila Stickers en acciones rápidas');

// Motor de envío y render
assert(html.includes('function openChatStickerPicker()'), 'openChatStickerPicker');
assert(html.includes('function closeChatStickerPicker()'), 'closeChatStickerPicker');
assert(html.includes("type: 'sticker',"), 'el envío es un mensaje type sticker');
assert(html.includes('stickerId: sticker.id'), 'el mensaje guarda stickerId');
assert(html.includes('function drexStickerMessageHTML(stickerId)'), 'render del sticker por id');
assert(html.includes("msg.type === 'sticker' && (msg.stickerId || msg.sticker)"), 'la burbuja pinta catálogo y lega el formato viejo');
assert(html.includes('drexStickerRecents'), 'recientes del carrusel');
assert(html.includes('<script defer src="./drex-stickers.js"></script>'), 'index.html carga el catálogo');
assert(html.includes('.stk-art svg'), 'el arte SVG llena su celda');
assert(html.includes("sticker: '<path d=\"M15 3H6a3"), "icono 'sticker' en el catálogo de iconos");

// i18n del panel
for (const k of ['Buscar stickers', 'Sin stickers por aquí', 'Populares', 'Caras', 'Animales', 'Comida']) {
  assert(i18n.includes('"' + k + '"'), 'i18n: ' + k);
}

console.log('test-c268-stickers-chat: OK (' + all.length + ' stickers, ' + all.filter(s => s.anim).length + ' animados)');
