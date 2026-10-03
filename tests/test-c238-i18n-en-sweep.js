/* ================================================================
 * C238 — barrido i18n EN (2026-10-02): cobertura total de textos
 * visibles en español fuera del chat de Baro.
 *
 * Hallazgos que corrige (auditoría tools/audit-i18n-en.js sobre main):
 *  - 14 literales appT() sin clave EN (errores de sticker/GIF/video,
 *    fiesta de voz, carpetas, "Los destellos son exclusivos de Drex
 *    Orbit", "Debes iniciar sesión para practicar.").
 *  - 826 textos dinámicos de UI (toasts, estados vacíos, títulos de
 *    vistas nuevas: Practicar, Orbit/Kor One, supervisión, música)
 *    sin traducción en EN/ZH/PT.
 *  - 7 claves de moderación de efectos que faltaban en los 3 idiomas.
 *
 * El test exige:
 *  1. Paridad total de claves EN/ZH/PT y conteo >= 3628.
 *  2. Todo literal appT()/drexFxT() de index.html existe en EN.
 *  3. Spot checks de claves nuevas del barrido en los 3 idiomas.
 *  4. Los atributos "Más horas"/"Más minutos" existen en *_ATTRS.
 * Ejecutar: node tests/test-c238-i18n-en-sweep.js
 * ================================================================ */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'drex-i18n.js'), 'utf8'), sandbox);
const EN = sandbox.APP_ENGLISH_TEXT, ZH = sandbox.APP_CHINESE_TEXT, PT = sandbox.APP_PORTUGUESE_TEXT;
const EN_A = sandbox.APP_ENGLISH_ATTRS, ZH_A = sandbox.APP_CHINESE_ATTRS, PT_A = sandbox.APP_PORTUGUESE_ATTRS;

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('ok - ' + name); }

ok('paridad y conteo >= 3628', () => {
  const e = Object.keys(EN).length, z = Object.keys(ZH).length, p = Object.keys(PT).length;
  assert(e >= 3628 && z === e && p === e, `conteos EN=${e} ZH=${z} PT=${p}`);
});

ok('cobertura appT/drexFxT total', () => {
  const re = /(?:appT|drexFxT)\(\s*'((?:[^'\\]|\\.)*)'\s*\)|(?:appT|drexFxT)\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g;
  let m; const miss = [];
  while ((m = re.exec(html)) !== null) {
    const s = (m[1] !== undefined ? m[1] : m[2]).replace(/\\u([0-9a-fA-F]{4})/g, (x, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\'/g, "'").replace(/\\"/g, '"');
    if (s && !(s in EN)) miss.push(s);
  }
  assert(miss.length === 0, 'sin clave EN: ' + miss.slice(0, 5).join(' | '));
});

const spots = [
  'Debes iniciar sesión para practicar.',
  'Los destellos son exclusivos de Drex Orbit.',
  'No se pudo conectar a la fiesta de voz. Revisa tu conexión.',
  'Dejar de seguir', 'Solicitud de seguimiento enviada',
  'En revisión', 'Rechazado', 'Publicado', 'Aprobar',
  'Practicar idiomas', 'Salas de voz en vivo para practicar idiomas y conocer gente.',
  'Inicia sesión para ver tus menciones.',
  '⚠️ Algo salió mal procesando tu mensaje. Inténtalo de nuevo.'
];
ok('spot checks del barrido en EN/ZH/PT', () => {
  for (const k of spots) {
    assert(EN[k] && ZH[k] && PT[k], 'falta: ' + k);
    assert(EN[k] !== k, 'EN sin traducir: ' + k);
  }
});

ok('atributos Más horas/minutos en *_ATTRS', () => {
  for (const k of ['Más horas', 'Más minutos']) assert(EN_A[k] && ZH_A[k] && PT_A[k], 'attr falta: ' + k);
});

console.log(`\nC238 VERDE: ${passed} checks, ${Object.keys(EN).length} claves x 3 idiomas.`);
