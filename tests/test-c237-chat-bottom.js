/* Test C237-L2: chat del En vivo anclado ABAJO (paridad TikTok).
 * Verifica en index.html (bytes del candidato):
 *  1. Los contenedores de chat (host + espectador) usan .drex-live-chatlist,
 *     sin el top:120px ni bottom-40 viejos (los mensajes ya no nacen arriba).
 *  2. La regla CSS .drex-live-chatlist existe: columna flex con
 *     justify-content:flex-end (ancla abajo), bottom fijo y max-height.
 *  3. La barra inferior usa área segura (safe-area-inset-bottom).
 *  4. drexLiveAppendChat conserva scroll al último mensaje y tope de mensajes.
 *  5. Sin "SpaceX" en la región tocada.
 * Uso: node tests/test-c237-chat-bottom.js [ruta/index.html]
 */
const fs = require('fs');
const assert = require('assert');

const path = require('path');
const _c237chatDev = '/home/hatch/workspace/c237-chat/index.html';
const target = process.argv[2] || (fs.existsSync(_c237chatDev) ? _c237chatDev : path.join(__dirname, '..', 'index.html'));
const html = fs.readFileSync(target, 'utf8');

function cssRule(selector) {
  const m = html.match(new RegExp('\\.' + selector + '\\{([^}]*)\\}'));
  assert(m, 'falta regla CSS .' + selector);
  return m[1];
}

// 1. Contenedores de chat: clase nueva, sin posicionamiento viejo
for (const id of ['drex-live-host-chat', 'drex-live-viewer-chat']) {
  const m = html.match(new RegExp('<div id="' + id + '"[^>]*>'));
  assert(m, 'falta div #' + id);
  const tag = m[0];
  assert(tag.includes('drex-live-chatlist'), '#' + id + ' sin clase drex-live-chatlist: ' + tag.slice(0, 120));
  assert(!tag.includes('top:120px'), '#' + id + ' conserva top:120px (mensajes nacerian arriba)');
  assert(!tag.includes('bottom-40'), '#' + id + ' conserva bottom-40');
  assert(tag.includes('aria-live="polite"'), '#' + id + ' sin aria-live');
}
console.log('OK chat host+espectador usan .drex-live-chatlist, sin top:120px');

// 2. Regla CSS: ancla abajo
const chatCss = cssRule('drex-live-chatlist');
for (const prop of ['flex-direction:column', 'justify-content:flex-end', 'bottom:']) {
  assert(chatCss.includes(prop), '.drex-live-chatlist sin "' + prop + '"');
}
assert(/max-height\s*:\s*\d+%/.test(chatCss), '.drex-live-chatlist sin max-height en %');
const bottomPx = parseInt((chatCss.match(/bottom:\s*calc\(\s*(\d+)px/) || [])[1] || '0', 10);
assert(bottomPx >= 140, '.drex-live-chatlist bottom (' + bottomPx + 'px) no despeja la barra inferior (~135px)');
console.log('OK .drex-live-chatlist ancla abajo, bottom=' + bottomPx + 'px, con max-height');

// 3. Barra inferior respeta el área segura
const barCss = cssRule('drex-live-bottombar');
assert(barCss.includes('safe-area-inset-bottom'), '.drex-live-bottombar sin safe-area-inset-bottom');
assert(chatCss.includes('safe-area-inset-bottom'), '.drex-live-chatlist no compensa el área segura');
console.log('OK área segura inferior respetada');

// 4. El JS conserva scroll al último mensaje y tope
const fn = html.match(/function drexLiveAppendChat\(which, m\) \{[\s\S]*?\n\}/);
assert(fn, 'no se encontró drexLiveAppendChat');
assert(fn[0].includes('box.scrollTop = box.scrollHeight'), 'drexLiveAppendChat perdió el scroll al último mensaje');
assert(/children\.length > \d+/.test(fn[0]), 'drexLiveAppendChat perdió el tope de mensajes');
console.log('OK drexLiveAppendChat: scroll al último + tope de mensajes');

// 5. Región del live sin SpaceX
const liveRegion = html.slice(html.indexOf('id="drex-live-host"'), html.indexOf('id="drex-live-viewer"') + 20000);
assert(!/spacex/i.test(liveRegion), 'SpaceX en la región del En vivo');
console.log('OK cero SpaceX en la región del En vivo');

console.log('C237-L2 VERDE');
