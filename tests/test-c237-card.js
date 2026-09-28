/* Test C237-L1 (card): la tarjeta de En vivo del feed incluye preview de video real.
 * Extrae buildDrexLiveCardHTML de index.html y la ejecuta en vm con stubs.
 * Uso: node tests/test-c237-card.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const W = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(W, 'index.html'), 'utf8');

const m = html.match(/function buildDrexLiveCardHTML\(note, ctx\) \{[\s\S]*?\n  \}/);
assert(m, 'ROJO: no se encontro buildDrexLiveCardHTML');

const sb = {
  escapeHtml: function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); },
  window: {}
};
sb.esc = sb.escapeHtml;
sb.t = function (s) { return s; };
vm.createContext(sb);
vm.runInContext(m[0] + '\nthis.__build = buildDrexLiveCardHTML;', sb);
const build = sb.__build;

const EMOJI = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u{1F1E6}-\u{1F1FF}]/u;

// 1. Tarjeta live: video con autoplay/muted/playsinline/cover + data attrs
const liveNote = { kind: 'live', liveId: 'LIVE123', liveStatus: 'live', liveTitle: 'Hola', authorName: 'Ana', authorImage: '' };
const out = build(liveNote, {});
assert(out.includes('<video'), 'ROJO: la tarjeta live no incluye <video>');
assert(/<video[^>]*\bmuted\b/.test(out), 'ROJO: video sin muted');
assert(/<video[^>]*\bplaysinline\b/.test(out), 'ROJO: video sin playsinline');
assert(/<video[^>]*\bautoplay\b/.test(out), 'ROJO: video sin autoplay');
assert(out.includes('data-live-preview="1"'), 'ROJO: falta data-live-preview');
assert(out.includes('data-live-id="LIVE123"'), 'ROJO: falta data-live-id');
assert(out.includes('data-live-status="live"'), 'ROJO: falta data-live-status');
assert(out.includes('EN VIVO'), 'ROJO: falta badge EN VIVO');
assert(!EMOJI.test(out), 'ROJO: emoji visible en la tarjeta');
console.log('OK tarjeta live con video autoplay/muted/playsinline');

// 2. CSS: object-fit cover para el video del preview
assert(/\.dlc-live-preview-video\s*\{[^}]*object-fit\s*:\s*cover/.test(html), 'ROJO: falta CSS object-fit:cover para .dlc-live-preview-video');
assert(/\.dlc-live-preview\s*\{[^}]*aspect-ratio/.test(html), 'ROJO: falta CSS .dlc-live-preview con aspect-ratio');
console.log('OK CSS del preview (cover + aspect-ratio)');

// 3. Tarjeta terminada: sin video ni preview
const outEnd = build({ kind: 'live', liveId: 'LIVE9', liveStatus: 'ended', liveTitle: 'X', authorName: 'A' }, {});
assert(!outEnd.includes('<video'), 'ROJO: tarjeta terminada no debe llevar video');
assert(!outEnd.includes('data-live-preview'), 'ROJO: tarjeta terminada no debe llevar data-live-preview');
assert(outEnd.includes('Transmisión terminada'), 'ROJO: tarjeta terminada sin texto');
console.log('OK tarjeta terminada sin preview');

// 4. liveId con comilla no rompe el atributo (XSS)
const outX = build({ kind: 'live', liveId: "a'b", liveStatus: 'live', liveTitle: 'T', authorName: 'A' }, {});
assert(!outX.includes('data-live-id="a\'b"'), 'ROJO: liveId sin sanitizar en atributo');
console.log('OK liveId sanitizado');

console.log('C237-L1-CARD VERDE');
