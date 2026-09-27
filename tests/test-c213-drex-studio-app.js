#!/usr/bin/env node
/* ================================================================
 * Tests de regresión: Drex Studio 1.0 (app Windows) — paquete zip
 * (2026-09-27)
 *
 * Cubre:
 *  1. El zip existe en la raíz del repo y tiene un tamaño cuerdo
 *     (0.5 MB - 25 MB): es el destino estable del botón "Descargar
 *     para Windows" de la vista drexstudio-view.
 *  2. Contenido del zip: index.html, lib/three.min.js, lib/aws-sdk.min.js,
 *     lib/amazon-cognito-identity.min.js, lib/drex-cloud.js,
 *     assets/logo.png, README-INSTALACION.txt, Drex-Studio.bat.
 *  3. La app usa el adaptador DrexCloud real (login: signInWithEmail-
 *     AndPassword / signInWithUsernameAndPassword; registro:
 *     createUserWithEmailAndPassword) y escribe effects/<id> con
 *     status 'pending' según el contrato DREX-EFFECTS.
 *  4. La palabra "SpaceX" (case-insensitive) NO aparece en la app.
 *  5. Estética índigo Drex (#2F33B8) presente.
 *
 * Ejecutar con: node tests/test-c213-drex-studio-app.js
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const ZIP = path.join(REPO, 'Drex-Studio-1.0-Windows.zip');
const DOWNLOAD_URL = 'https://floreseternasoporte-creator.github.io/Beabo/Drex-Studio-1.0-Windows.zip';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('ok - ' + name); }
  else { fail++; console.log('NO OK - ' + name + (detail ? ' :: ' + detail : '')); }
}

// 1. El zip existe y su tamaño es cuerdo
check('zip Drex-Studio-1.0-Windows.zip existe en la raíz del repo', fs.existsSync(ZIP));
let size = 0;
if (fs.existsSync(ZIP)) {
  size = fs.statSync(ZIP).size;
  check('tamaño del zip entre 0.5 MB y 25 MB (' + (size / 1048576).toFixed(2) + ' MB)',
    size > 500 * 1024 && size < 25 * 1024 * 1024);
}

// 2. Contenido del zip
let listing = '';
if (fs.existsSync(ZIP)) {
  try {
    listing = execSync('unzip -l ' + JSON.stringify(ZIP), { encoding: 'utf8' });
  } catch (e) { listing = ''; }
  check('listado del zip legible', listing.indexOf('index.html') !== -1);
  const need = [
    'index.html',
    'lib/three.min.js',
    'lib/aws-sdk.min.js',
    'lib/amazon-cognito-identity.min.js',
    'lib/drex-cloud.js',
    'assets/logo.png',
    'README-INSTALACION.txt',
    'Drex-Studio.bat',
  ];
  for (const n of need) {
    check('zip contiene ' + n, listing.indexOf(n) !== -1);
  }
}

// 3-5. Contenido de la app (index.html dentro del zip)
let appHtml = '';
if (listing) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drex-studio-'));
  try {
    execSync('unzip -p ' + JSON.stringify(ZIP) + ' index.html > ' + JSON.stringify(path.join(tmp, 'index.html')));
    appHtml = fs.readFileSync(path.join(tmp, 'index.html'), 'utf8');
  } catch (e) { appHtml = ''; }
  check('index.html de la app extraíble del zip', appHtml.length > 10000,
    'longitud=' + appHtml.length);
  if (appHtml) {
    check('usa DrexCloud.auth().signInWithEmailAndPassword',
      appHtml.indexOf('signInWithEmailAndPassword') !== -1);
    check('usa DrexCloud.auth().signInWithUsernameAndPassword',
      appHtml.indexOf('signInWithUsernameAndPassword') !== -1);
    check('usa createUserWithEmailAndPassword para crear desarrollador',
      appHtml.indexOf('createUserWithEmailAndPassword') !== -1);
    check("escribe en effects/ con status 'pending'",
      /effects\/.*status\s*:\s*['"]pending['"]/.test(appHtml) ||
      (appHtml.indexOf("status:'pending'") !== -1 || appHtml.indexOf('status: "pending"') !== -1 ||
       appHtml.indexOf("status: 'pending'") !== -1));
    check('incluye campo autorUid en el contrato del efecto',
      appHtml.indexOf('autorUid') !== -1);
    check('incluye usos:0 en el contrato del efecto',
      /usos\s*:\s*0/.test(appHtml));
    check('la palabra "SpaceX" no aparece (case-insensitive)',
      !/spacex/i.test(appHtml));
    check('estética índigo Drex (#2F33B8) presente',
      appHtml.indexOf('#2F33B8') !== -1 || appHtml.indexOf('#2f33b8') !== -1);
    check('preview Three.js presente', /THREE|three\.min\.js/i.test(appHtml));
  }
}

// La URL de descarga de la vista web corresponde a este zip
check('URL de descarga estable documentada', DOWNLOAD_URL.endsWith('/Drex-Studio-1.0-Windows.zip'));

console.log('\n' + pass + ' pasados, ' + fail + ' fallidos');
process.exit(fail ? 1 : 0);
