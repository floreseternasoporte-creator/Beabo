#!/usr/bin/env node
/* Kor One — pruebas frontend (lógica pura, sin DOM).
 *
 * C246 (2026-10-03): DrexKorOne fue el nombre original de la suscripción;
 * el usuario lo renombró Drex Orbit (2026-09-29) y el bloque KorOne se
 * retiró de index.html (0 ocurrencias). El test original ejecutaba el
 * bloque KorOne en sandbox y ya no tiene objeto. Este archivo fija el
 * contrato vigente: KorOne no debe reaparecer y su sucesor DrexOrbit
 * debe estar presente. La lógica de la suscripción la cubren
 * test-c241-orbit-benefits-wiring, test-c243 y test-c244.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok', name); }
  else { fail++; console.error('  FAIL:', name); }
}

ok(html.indexOf('DrexKorOne') === -1, 'DrexKorOne no existe en index.html');
ok(html.indexOf('Kor One') === -1 && i18n.indexOf('Kor One') === -1, 'sin copy "Kor One" en app ni i18n');
ok(html.indexOf('?korone=') === -1, 'sin retorno ?korone=');
ok(html.indexOf('DREX_KORONE_ENFORCE') === -1, 'sin flag DREX_KORONE_ENFORCE');
ok(html.indexOf('DrexOrbit') !== -1, 'sucesor DrexOrbit presente');
ok(html.indexOf('drex-orbit') !== -1 || html.indexOf('orbit-view') !== -1, 'superficie Orbit presente');

console.log('\nkorone-frontend: ' + pass + ' ok, ' + fail + ' fallos');
process.exit(fail ? 1 : 0);
