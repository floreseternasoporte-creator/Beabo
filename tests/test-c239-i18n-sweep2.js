/* ================================================================
 * C239 — barrido i18n 2 (2026-10-02): fragmentos de templates,
 * notificaciones y centro de ayuda + privacy.html bilingüe.
 *
 * El barrido C238 cubrió appT/estáticos/atributos. Este cubre los
 * textos que la app compone con template literals e innerHTML:
 *  - cuerpos de notificación ("te comenzó a seguir", "le dio un voto
 *    a tu publicación.", "fijó tu comentario en su publicación."...)
 *  - fragmentos del centro de ayuda ("Abre la pestaña", "Ve a
 *    Configuración >", instrucciones de notificaciones 1) 2) 3)...)
 *  - etiquetas de vistas ("Dejar de supervisar esta cuenta",
 *    "Limitar mensajes directos", "Cuenta siempre privada"...)
 *  - privacy.html ahora es bilingüe ES/EN (como child-safety.html).
 *
 * Exige: claves nuevas en EN/ZH/PT, EN distinto del español, y la
 * sección inglesa presente en privacy.html.
 * Ejecutar: node tests/test-c239-i18n-sweep2.js
 * ================================================================ */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'drex-i18n.js'), 'utf8'), sandbox);
const EN = sandbox.APP_ENGLISH_TEXT, ZH = sandbox.APP_CHINESE_TEXT, PT = sandbox.APP_PORTUGUESE_TEXT;

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('ok - ' + name); }

const spots = [
  'te comenzó a seguir',
  'aceptó tu solicitud de seguimiento',
  'le dio un voto a tu publicación.',
  'fijó tu comentario en su publicación.',
  'envió una foto en tu publicación.',
  'te agregó al grupo "',
  'Dejar de supervisar esta cuenta',
  'Limitar mensajes directos',
  'Cuenta siempre privada',
  'Esta cuenta es privada',
  'Demasiados intentos fallidos. Inténtalo de nuevo en',
  'Ve a Configuración >',
  'Abre la pestaña',
  'Sin resultados. Prueba con otras palabras o infórmanos de un problema.',
  'Canción · Drex Música',
  'Ver tendencias'
];
ok('claves del barrido 2 en EN/ZH/PT y EN traducido', () => {
  for (const k of spots) {
    assert(EN[k] && ZH[k] && PT[k], 'falta clave: ' + k);
    assert(EN[k] !== k, 'EN sin traducir: ' + k);
  }
});

ok('paridad EN/ZH/PT se mantiene', () => {
  const e = Object.keys(EN).length, z = Object.keys(ZH).length, p = Object.keys(PT).length;
  assert(z === e && p === e, `conteos EN=${e} ZH=${z} PT=${p}`);
});

ok('privacy.html bilingüe (ES + EN)', () => {
  const priv = fs.readFileSync(path.join(root, 'privacy.html'), 'utf8');
  assert(priv.includes('Política de Privacidad de Drex'), 'falta sección ES');
  assert(priv.includes('Drex Privacy Policy'), 'falta sección EN');
  assert(priv.includes('Last updated: September 9, 2026'), 'falta fecha EN');
});

console.log(`\nC239 VERDE: ${passed} checks.`);
