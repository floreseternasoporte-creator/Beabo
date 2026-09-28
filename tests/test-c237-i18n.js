/* Test C237-L1 (i18n): la clave nueva existe en ES/EN/ZH/PT.
 * Uso: node tests/test-c237-i18n.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'drex-i18n.js'), 'utf8');

function dictRange(name) {
  const start = src.indexOf('var ' + name + ' = {');
  assert(start >= 0, 'ROJO: no existe ' + name);
  const order = ['APP_ENGLISH_TEXT', 'APP_CHINESE_TEXT', 'APP_PORTUGUESE_TEXT'];
  const nextIdx = order.indexOf(name);
  let end = src.length;
  for (let i = nextIdx + 1; i < order.length; i++) {
    const p = src.indexOf('var ' + order[i] + ' = {', start + 1);
    if (p > 0) { end = p; break; }
  }
  return src.slice(start, end);
}

const KEY = 'Vista previa del en vivo';
const en = dictRange('APP_ENGLISH_TEXT');
const zh = dictRange('APP_CHINESE_TEXT');
const pt = dictRange('APP_PORTUGUESE_TEXT');
assert(en.includes('"' + KEY + '"'), 'ROJO: falta la clave en EN');
assert(en.includes('"Live preview"'), 'ROJO: falta traduccion EN');
assert(zh.includes('"' + KEY + '"'), 'ROJO: falta la clave en ZH');
assert(zh.includes('"直播预览"'), 'ROJO: falta traduccion ZH');
assert(pt.includes('"' + KEY + '"'), 'ROJO: falta la clave en PT');
assert(pt.includes('"Prévia ao vivo"'), 'ROJO: falta traduccion PT');
console.log('OK i18n ES/EN/ZH/PT: "' + KEY + '"');
console.log('C237-L1-I18N VERDE');
