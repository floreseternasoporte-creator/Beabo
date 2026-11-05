/* ================================================================
 * C70: la búsqueda de chat debe normalizar ligaduras y caracteres de
 * ancho completo (NFKD, no solo NFD).
 *
 * Defecto (base, PoC): `normalizeForMatch()` (la que usa
 * `searchMessagesInCurrentChat`) aplicaba lowercase + NFD + strip de
 * diacríticos. NFD no descompone ligaduras de compatibilidad (ﬁ/ﬂ) ni
 * caracteres de ancho completo (ＡＢＣ, ｱｲｳｴｵ de katakana): pegar
 * "ﬁesta" desde un documento o buscar カタカナ cuando el mensaje trae
 * ｶﾀｶﾅ (medio ancho, común en IMEs japoneses) no daba ningún resultado.
 *
 * Fix: `.normalize('NFD')` -> `.normalize('NFKD')` en
 * `normalizeForMatch`. NFKD incluye la descomposición canónica (los
 * diacríticos siguen pelándose igual) y añade la de compatibilidad.
 * Blast radius analizado: los dos call-sites normalizan query y corpus
 * de forma simétrica (búsqueda de chat) o el texto contra patrones ASCII
 * (filtro de contenido adulto: el fullwidth/compatibilidad ya no evade
 * el filtro — dirección segura). Sin strings UI, sin esquema, sin globals.
 *
 * Alcance deliberado: œ/Œ y ß no tienen descomposición Unicode (ni NFKD
 * los toca); mapearlos exigiría tablas explícitas, fuera de este fix.
 *
 * Extrae la función REAL de ../index.html (sin rutas absolutas ni git).
 * Ejecutar con: node tests/test-c70-search-normalize-nfkd.js
 * Con BASE_POC=1 se corre el PoC contra la base sin fix.
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFn(src, name) {
  const m = new RegExp('(async\\s+)?function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('no encontrada: ' + name);
  let i = src.indexOf('{', m.index);
  const start = m.index;
  let depth = 0, str = null, tpl = 0, lineC = false, blockC = false, esc = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (lineC) { if (c === '\n') lineC = false; continue; }
    if (blockC) { if (c === '*' && n === '/') { blockC = false; i++; } continue; }
    if (str) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (str === '`' && c === '$' && n === '{') { tpl++; i++; continue; }
      if (c === str && tpl === 0) { str = null; continue; }
      if (str === '`' && c === '}' && tpl > 0) { tpl--; continue; }
      continue;
    }
    if (c === '/' && n === '/') { lineC = true; i++; continue; }
    if (c === '/' && n === '*') { blockC = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { str = c; tpl = 0; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('llaves sin cerrar: ' + name);
}

const BASELINE = process.env.BASE_POC === '1';
const fnSrc = extractFn(HTML, 'normalizeForMatch');

if (BASELINE) {
  // PoC: en la base la función usa NFD -> los casos del lead fallan.
  assert(/\.normalize\('NFD'\)/.test(fnSrc), 'PoC base: se esperaba NFD en normalizeForMatch');
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(fnSrc + '\nglobalThis.n = normalizeForMatch;', sb);
  const n = sb.n;
  assert.notStrictEqual(n('ﬁesta'), n('fiesta'), 'PoC: ﬁ no se normaliza con NFD');
  assert.notStrictEqual(n('ＡＢＣ'), n('abc'), 'PoC: fullwidth no se normaliza con NFD');
  assert.notStrictEqual(n('ｱｲｳｴｵ'), n('アイウエオ'), 'PoC: katakana de medio ancho no se normaliza con NFD');
  console.log('PoC OK (base): ligaduras y ancho completo no normalizan (defecto presente)');
  process.exit(0);
}

/* ---------- Checks estáticos sobre el código real ---------- */
assert(/\.normalize\('NFKD'\)/.test(fnSrc), 'normalizeForMatch debe usar NFKD');
assert(!/\.normalize\('NFD'\)/.test(fnSrc), 'normalizeForMatch ya no debe usar NFD');
// La búsqueda de chat sigue usando esta función en query y corpus.
assert(/searchMessagesInCurrentChat[\s\S]{0,600}normalizeForMatch\(query/.test(HTML),
  'searchMessagesInCurrentChat debe normalizar la query con normalizeForMatch');
assert(/normalizeForMatch\(el\.textContent\)/.test(HTML),
  'searchMessagesInCurrentChat debe normalizar el texto con normalizeForMatch');
console.log('OK  estaticos: NFKD en normalizeForMatch, usada en query y corpus de la búsqueda');

/* ---------- Funcional: la función real en vm ---------- */
const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fnSrc + '\nglobalThis.n = normalizeForMatch;', sandbox, { filename: 'normalize-under-test.js' });
const n = sandbox.n;

function t(text, q, label) {
  assert.strictEqual(n(text), n(q), label + ': ' + JSON.stringify(text) + ' vs ' + JSON.stringify(q));
  // Simetría de búsqueda: el includes que usa searchMessagesInCurrentChat.
  assert.ok(n(text).includes(n(q)), label + ' (includes)');
  console.log('OK  ' + label);
}

// Casos del lead del ciclo 70.
t('ﬁ', 'fi', 'ligadura ﬁ -> fi');
t('ﬂ', 'fl', 'ligadura ﬂ -> fl');
t('ﬁesta', 'fiesta', 'palabra con ligadura ﬁ');
t('ＡＢＣ', 'abc', 'fullwidth ASCII -> ASCII');
t('ｱｲｳｴｵ', 'アイウエオ', 'katakana de medio ancho -> ancho completo');
// Regresión: lo que NFD ya cubría sigue igual.
t('café', 'cafe', 'diacrítico precompuesto (regresión NFD)');
t('niño', 'nino', 'ñ (regresión NFD)');
t('Fiesta', 'fiesta', 'case-insensitive (regresión)');
t('hola mundo', 'HOLA MUNDO', 'frase normal (regresión)');

console.log('\nC70-SEARCH: 9/9 casos OK');
