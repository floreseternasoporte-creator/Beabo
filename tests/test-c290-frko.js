/* C290 — Francés (FR) y coreano (KO) completos. */
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const i18nSrc = fs.readFileSync(__dirname + '/../drex-i18n.js', 'utf8');
const s = {}; vm.createContext(s); vm.runInContext(i18nSrc.replace(/^\/\*[\s\S]*?\*\//, ''), s);
const EN = s.APP_ENGLISH_TEXT, FR = s.APP_FRENCH_TEXT, KO = s.APP_KOREAN_TEXT;
const ENa = s.APP_ENGLISH_ATTRS, FRa = s.APP_FRENCH_ATTRS, KOa = s.APP_KOREAN_ATTRS;
for (const [n, d] of [['FR', FR], ['KO', KO]]) assert(d && Object.keys(d).length > 100, 'APP_' + n + ' existe');
assert.strictEqual(Object.keys(FR).length, Object.keys(EN).length, 'paridad FR=EN');
assert.strictEqual(Object.keys(KO).length, Object.keys(EN).length, 'paridad KO=EN');
for (const k of Object.keys(EN)) { assert(k in FR, 'falta en FR: ' + k.slice(0, 50)); assert(k in KO, 'falta en KO: ' + k.slice(0, 50)); }
for (const k of Object.keys(ENa)) { assert(k in FRa, 'falta attr FR: ' + k.slice(0, 50)); assert(k in KOa, 'falta attr KO: ' + k.slice(0, 50)); }
const ph = x => (String(x).match(/\{[a-zA-Z0-9_]+\}|%s/g) || []).filter(p => p !== '{c}').sort().join(',');
for (const k of Object.keys(EN)) { assert.strictEqual(ph(FR[k]), ph(EN[k]), 'ph FR: ' + k.slice(0, 50)); assert.strictEqual(ph(KO[k]), ph(EN[k]), 'ph KO: ' + k.slice(0, 50)); }
let koHits = 0; for (const k of Object.keys(KO)) if (/[\uac00-\ud7af]/.test(KO[k])) koHits++;
assert(koHits / Object.keys(KO).length > 0.9, 'cobertura coreana baja');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
assert(html.includes('id="app-language-fr"'), 'botón FR');
assert(html.includes('id="app-language-ko"'), 'botón KO');
assert(html.includes("stored === 'ko'"), 'getAppLanguage acepta ko');
assert(html.includes('APP_FRENCH_TEXT') && html.includes('APP_KOREAN_TEXT'), 'index usa FR/KO');
const fg = { window: {} }; vm.createContext(fg); vm.runInContext(fs.readFileSync(__dirname + '/../fiesta-games-data.js', 'utf8'), fg);
const W = fg.window.FIESTA_GAME_WORDS;
for (const l of ['es', 'en', 'zh', 'pt', 'ja', 'fr', 'ko']) assert.strictEqual(W[l].length, 165, 'banco fiesta ' + l);
console.log('C290 FR/KO: diccionarios completos, selector y juegos en verde');
