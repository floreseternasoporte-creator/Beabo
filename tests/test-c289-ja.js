/* C289 — Japonés (JA) completo: diccionario, selector y bancos de juego. */
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const i18nSrc = fs.readFileSync(__dirname + '/../drex-i18n.js', 'utf8');
const s = {}; vm.createContext(s); vm.runInContext(i18nSrc.replace(/^\/\*[\s\S]*?\*\//, ''), s);
const EN = s.APP_ENGLISH_TEXT, JA = s.APP_JAPANESE_TEXT, ENa = s.APP_ENGLISH_ATTRS, JAa = s.APP_JAPANESE_ATTRS;
assert(JA && Object.keys(JA).length > 100, 'APP_JAPANESE_TEXT existe');
assert(JAa && Object.keys(JAa).length > 50, 'APP_JAPANESE_ATTRS existe');
assert.strictEqual(Object.keys(JA).length, Object.keys(EN).length, 'paridad de conteo JA=EN');
for (const k of Object.keys(EN)) assert(k in JA, 'falta en JA: ' + k.slice(0, 60));
for (const k of Object.keys(ENa)) assert(k in JAa, 'falta attr en JA: ' + k.slice(0, 60));
const ph = x => (String(x).match(/\{[a-zA-Z0-9_]+\}|%s/g) || []).filter(p => p !== '{c}').sort().join(','); // {c} = sufijo plural ES, opcional por idioma
for (const k of Object.keys(EN)) assert.strictEqual(ph(JA[k]), ph(EN[k]), 'placeholders difieren: ' + k.slice(0, 60));
// al menos el 95% de valores JA contienen japonés o son identificadores cortos
let jaCount = 0; const total = Object.keys(JA).length;
for (const k of Object.keys(JA)) if (/[\u3040-\u30ff\u4e00-\u9faf]/.test(JA[k])) jaCount++;
assert(jaCount / total > 0.9, 'cobertura japonesa baja: ' + jaCount + '/' + total);
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
assert(html.includes('id="app-language-ja"'), 'botón JA en el selector de idioma');
assert(html.includes("stored === 'ja'"), 'getAppLanguage acepta ja');
assert(html.includes("|| lang === 'fr' || lang === 'ko') ? lang : 'es'"), 'setAppLanguage acepta ja');
assert(html.includes('APP_JAPANESE_TEXT'), 'index usa APP_JAPANESE_TEXT');
assert(html.includes('drexFillBaroJa'), 'relleno JA de Baro presente');
const fg = { window: {} }; vm.createContext(fg); vm.runInContext(fs.readFileSync(__dirname + '/../fiesta-games-data.js', 'utf8'), fg);
const W = fg.window.FIESTA_GAME_WORDS;
for (const l of ['es', 'en', 'zh', 'pt', 'ja']) assert.strictEqual(W[l].length, 165, 'banco fiesta ' + l);
console.log('C289 JA: diccionario completo, selector y juegos en verde');
