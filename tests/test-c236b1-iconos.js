/* Test C236-B1: iconografía SVG propia de En vivo.
 * Verifica: cero emojis visibles en la región En vivo, set completo de
 * iconos Drex, y que drexIcon() genera SVG válido.
 * Uso: node tests/test-c236b1-iconos.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const W = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(W, 'index.html'), 'utf8');
const lines = html.split('\n');

// 1. El bloque de iconos existe y define los 26 iconos esperados
const EXPECTED = ['eye','heart','thumbsup','laugh','party','fire','clap','radio','game',
  'users','gift','coin','diamond','wallet','share','x','send','chat','crown','zap',
  'mic','micOff','video','sparkles','check','bell'];
const m = html.match(/var DREX_ICONS = \{([\s\S]*?)\n\};/);
assert(m, 'no se encontró var DREX_ICONS');
for (const name of EXPECTED) {
  assert(new RegExp("['\"]?" + name + "['\"]?\\s*:").test(m[1]), 'falta icono: ' + name);
}
console.log('OK iconos definidos:', EXPECTED.length);

// 2. drexIcon() funciona en un sandbox
const iconSrc = html.slice(m.index, m.index + m[0].length);
const fnSrc = html.match(/function drexIcon\(name, cls\) \{[\s\S]*?\n\}/);
assert(fnSrc, 'no se encontró function drexIcon');
const sb = {};
vm.createContext(sb);
vm.runInContext(iconSrc + '\n' + fnSrc[0] + '\nthis.__out = drexIcon("heart", "w-7 h-7");', sb);
assert(sb.__out.includes('<svg'), 'drexIcon no genera svg');
assert(sb.__out.includes('w-7 h-7'), 'drexIcon no aplica la clase');
assert(sb.__out.includes('M20.84'), 'drexIcon heart: path inesperado');
vm.runInContext('this.__fb = drexIcon("inexistente", "x");', sb);
assert(sb.__fb.includes('<svg'), 'drexIcon sin fallback para nombre desconocido');
console.log('OK drexIcon() genera SVG válido con fallback');

// 3. Cero emojis visibles en la región En vivo (HTML tab + overlays + JS)
//    Excepción documentada: valores legacy en fiestaSendReaction('...') y
//    claves de DREX_REACTION_ICONS (compatibilidad de BD, nunca se renderizan).
const EM = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u{1F1E6}-\u{1F1FF}]/u;
const ranges = [[7997,8117],[80369,80605],[80654,81329],[81331,82462]];
const bad = [];
for (const [a,b] of ranges) {
  for (let i = a-1; i < b && i < lines.length; i++) {
    let ln = lines[i];
    let probe = ln.replace(/fiestaSendReaction\('[^']*'\)/g, '');
    probe = probe.replace(/'[^']*':\s*'(heart|clap|laugh|party|fire|thumbsup)'/g, '');
    const s = probe.trim();
    if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) continue;
    const hits = probe.match(EM);
    if (hits) bad.push((i+1) + ' ' + [...new Set(hits)].join('') + ' :: ' + s.slice(0,80));
  }
}
assert(bad.length === 0, 'emojis visibles en En vivo:\n' + bad.slice(0,10).join('\n'));
console.log('OK cero emojis visibles en la región En vivo');

// 4. Los botones de reacción conservan el valor legacy pero muestran SVG
const rline = lines.find(l => l.includes("fiestaSendReaction('❤️')") && l.includes('<button'));
assert(rline && rline.includes('<svg'), 'botón de reacción sin SVG');
assert(!/>[^<]*[\u{1F300}-\u{1FAFF}][^<]*<\/button>/u.test(rline), 'botón de reacción con emoji visible');
console.log('OK reacciones: valor legacy en BD, SVG visible');

console.log('C236-B1 VERDE');
