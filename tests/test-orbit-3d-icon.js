#!/usr/bin/env node
/* Drex Orbit — carril 4: icono 3D de MORA como identidad visual de Orbit.
 * Verifica:
 *  1. El asset assets/img/drex-orbit-3d.png existe y es un PNG válido.
 *  2. La tarjeta de ajustes #orbit-settings-card usa la imagen 3D
 *     (no un icono genérico) y ya no lleva el degradado morado.
 *  3. La cabecera de la vista Orbit (renderOrbitView) usa la imagen 3D
 *     en lugar del medallón con degradado + SVG.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.env.ORBIT_TEST_ROOT || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('  FAIL:', name); }
}

const IMG = 'assets/img/drex-orbit-3d.png';
const imgPath = path.join(ROOT, IMG);

/* ---- 1. El asset existe y es PNG ---- */
let isPng = false, size = 0;
try {
  const buf = fs.readFileSync(imgPath);
  size = buf.length;
  isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
} catch (_) { /* no existe */ }
ok(isPng, 'assets/img/drex-orbit-3d.png existe y es PNG válido');
ok(size > 50000, 'el icono 3D tiene tamaño razonable (' + size + ' bytes)');

/* ---- 2. Tarjeta de ajustes usa la imagen 3D ---- */
const cardStart = html.indexOf('id="orbit-settings-card"');
ok(cardStart !== -1, '#orbit-settings-card presente');
const cardEnd = html.indexOf('</button>', cardStart);
const cardHtml = cardStart !== -1 && cardEnd !== -1 ? html.slice(cardStart, cardEnd) : '';
ok(cardHtml.indexOf(IMG) !== -1, 'la tarjeta de ajustes referencia la imagen 3D');
ok(cardHtml.indexOf('<img') !== -1, 'la tarjeta de ajustes usa <img> (no icono genérico)');
ok(!/#6[Dd]28[Dd]9|#9[Dd]4[Ee][Dd][Dd]|linear-gradient/.test(cardHtml),
   'la tarjeta de ajustes ya no usa degradado morado');

/* ---- 3. Cabecera de la vista Orbit usa la imagen 3D ---- */
const heroIdx = html.indexOf('El plan Orbit de Drex');
ok(heroIdx !== -1, 'cabecera de la vista Orbit presente');
const heroSlice = heroIdx !== -1 ? html.slice(Math.max(0, heroIdx - 600), heroIdx) : '';
ok(heroSlice.indexOf(IMG) !== -1, 'la cabecera Orbit referencia la imagen 3D');
ok(!/linear-gradient\(135deg,#2F33B8,#9D4EDD\)/.test(heroSlice),
   'la cabecera Orbit ya no usa el medallón con degradado morado');

console.log(`\nOrbit 3D icon (carril 4): ${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
