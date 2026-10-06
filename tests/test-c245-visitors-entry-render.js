#!/usr/bin/env node
/* =====================================================================
 * C245 — "Quién vio tu perfil" INVISIBLE en el perfil real (QA en vivo).
 *
 * Causa raíz probada (no suposición): #profile-view contiene DOS layouts
 * hermanos excluyentes por breakpoint — móvil `block lg:hidden` (línea
 * ~10912) y escritorio `hidden lg:block` (~11044, con las tabs que vio
 * QA). El botón estático de C244 quedó SOLO en el layout móvil junto a
 * Pulso; el layout de escritorio jamás recibió ni Pulso ni la entrada,
 * así que en la vista real (QA de escritorio) la entrada no existía. La
 * prueba de C244 era un grep de presencia y pasaba igual: grep solo ya
 * NO es evidencia aceptable aquí.
 *
 * Fix: la entrada se RENDERIZA por JS (orbitVisitorsEntryHTML +
 * mountOrbitVisitorsEntry) y se monta en los dos layouts de #profile-view
 * al abrir el perfil propio (openProfile) y en cada refresco Orbit
 * (renderOrbitVisitorsEntryPreview). Los perfiles ajenos viven en
 * #author-profile-modal: sin montajes, la entrada no puede aparecer.
 *
 * Este test EJECUTA el render en vm (Node) contra un DOM mínimo:
 *  - perfil propio -> la entrada aparece renderizada en ambos montajes
 *  - perfil ajeno (sin montajes) -> no se inyecta nada
 *  - el título sale de t() (i18n), el onclick queda cableado
 *
 * Uso: node tests/test-c245-visitors-entry-render.js
 *
 * ENMIENDA C253 (2026-10-06, orden del usuario con capturas): la entrada
 * ya no es la píldora completa bajo Pulso — ese era el estorbo reportado.
 * Ahora es un chip compacto de ojo + contador pegado a la FOTO (estilo
 * TikTok) en ambos layouts, su onclick abre el router de activación
 * openProfileVisitorsEntry() (Ajustes › Privacidad) y la etiqueta "Orbit"
 * salió del chip (la puerta orbitGate sigue intacta en openOrbitVisitors).
 * Las aserciones tocadas por ese rediseño llevan comentario C253.
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const html404 = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');
const i18nJs = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + msg); } };
const eq = (a, b, msg) => ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ============ 1. La vista propia y sus dos layouts ============ */
console.log('-- C245.1: estructura de #profile-view (perfil propio) --');
const iProfileView = html.indexOf('id="profile-view"');
const iAuthorModal = html.indexOf('id="author-profile-modal"');
const iOrbitView = html.indexOf('id="orbit-view"', iAuthorModal);
ok(iProfileView !== -1 && iAuthorModal !== -1 && iOrbitView !== -1, 'vistas localizables');
const profileSeg = html.slice(iProfileView, iAuthorModal);
const authorSeg = html.slice(iAuthorModal, iOrbitView);

const iMob = profileSeg.indexOf('class="block lg:hidden');
const iDesk = profileSeg.indexOf('class="hidden lg:block');
const iMountMob = profileSeg.indexOf('id="profile-visitors-entry-mount"');
const iMountDesk = profileSeg.indexOf('id="profile-visitors-entry-mount-desktop"');
ok(iMob !== -1 && iDesk !== -1, 'existen los dos layouts (móvil lg:hidden / escritorio lg:block)');
ok(iMountMob !== -1, 'montaje móvil presente dentro de #profile-view');
ok(iMountDesk !== -1, 'montaje de escritorio presente dentro de #profile-view');
ok(iMob < iMountMob && iMountMob < iDesk && iDesk < iMountDesk,
  'cada montaje vive dentro de su propio layout (excluyentes por breakpoint: nunca se ven dos entradas)');
/* C253: los montajes salieron de bajo de Pulso (ese era el estorbo).
   C254 (corrección del usuario con la captura de TikTok señalada): los
   montajes viven en el ENCABEZADO SUPERIOR — móvil entre el nombre de
   cuenta y el engranaje; escritorio en la barra superior — y el chip ya
   no lleva icono de ojo: mini foto de perfil + contador, como TikTok. */
ok(iMountMob < profileSeg.indexOf('openPulsoView()'), 'el montaje móvil sigue lejos de Pulso');
ok(profileSeg.indexOf('onclick="openAccountSwitcher()"') < iMountMob && iMountMob < profileSeg.indexOf('onclick="openProfileSettings()"'),
  'C254: móvil — la entrada vive en la esquina superior, antes del engranaje');
ok(iMountDesk < profileSeg.indexOf('id="profile-image-desktop"'),
  'C254: escritorio — la entrada vive en la barra superior, antes de la foto');
ok(!profileSeg.includes('id="profile-visitors-entry"'),
  'el botón estático C244 ya NO está en el markup (lo sustituye el render JS)');
ok(!authorSeg.includes('profile-visitors-entry'),
  'el perfil AJENO (#author-profile-modal) no contiene entrada ni montajes');

/* openProfile: el camino real de apertura monta la entrada */
const iOpen = html.indexOf('function openProfile()');
const iOpenEnd = html.indexOf('function openProfileSettings', iOpen);
const openSeg = html.slice(iOpen, iOpenEnd);
ok(openSeg.includes("getElementById('profile-view')"), 'openProfile abre #profile-view (la vista del perfil propio)');
ok(openSeg.includes('mountOrbitVisitorsEntry()'), 'openProfile monta la entrada al abrir el perfil propio');

/* ============ 2. Render en vm: ejecutar el camino real ============ */
console.log('-- C245.2: render ejecutado en vm --');
const iRnd = html.indexOf('function orbitVisitorsEntryHTML(');
const iRndEnd = html.indexOf('function closeOrbitVisitors()', iRnd);
ok(iRnd !== -1 && iRndEnd !== -1, 'bloque del render C245 localizable');
const rendererSrc = html.slice(iRnd, iRndEnd);

function makeEl() { return { innerHTML: '', textContent: '' }; }
function buildDom(knownIds, tFn) {
  const els = {};
  const sandbox = {
    console, Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set,
    escapeHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    document: {
      /* Como el DOM real: un id que no existe devuelve null (no lo inventa). */
      getElementById: (id) => (knownIds.indexOf(id) !== -1 ? (els[id] = els[id] || makeEl()) : null),
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  if (tFn) sandbox.t = tFn;
  vm.createContext(sandbox);
  vm.runInContext(rendererSrc, sandbox);
  return { sandbox, els };
}

/* A. Perfil propio (los dos montajes existen): la entrada se renderiza */
const own = buildDom(['profile-visitors-entry-mount', 'profile-visitors-entry-mount-desktop']);
eq(own.sandbox.mountOrbitVisitorsEntry(), 2, 'perfil propio: se montan las 2 variantes (móvil + escritorio)');
for (const id of ['profile-visitors-entry-mount', 'profile-visitors-entry-mount-desktop']) {
  const h = own.els[id].innerHTML;
  ok(h.includes('id="profile-visitors-entry"'), id + ': botón renderizado');
  /* C253: el chip abre el router de activación (no la lista directa). */
  ok(h.includes('onclick="openProfileVisitorsEntry()"'), id + ': onclick cableado al router C253');
  ok(h.includes('Quién vio tu perfil'), id + ': título visible');
  /* C254/C257: como TikTok — sin icono de ojo, sin número; solo la mini foto. */
  ok(!h.includes('M1 12s4-8'), id + ': C254 sin icono de ojo');
  ok(h.includes('pv-mini-photo'), id + ': C254 mini foto de perfil');
  ok(!h.includes('pv-count'), id + ': C257 sin número junto a la foto');
  ok(!h.includes('>Orbit<'), id + ': sin etiqueta Orbit en el chip compacto');
  ok(!h.includes('w-full max-w-xs'), id + ': ya no es la píldora completa de fila entera');
  eq(h.split('id="profile-visitors-entry"').length - 1, 1, id + ': exactamente UNA entrada por montaje');
}
/* el preview (refresco Orbit / cambio de idioma) remonta sin duplicar */
own.sandbox.renderOrbitVisitorsEntryPreview();
eq(own.els['profile-visitors-entry-mount'].innerHTML.split('id="profile-visitors-entry"').length - 1, 1,
  'el preview remonta sin duplicar la entrada');

/* B. Perfil ajeno (sin montajes): no se inyecta nada */
const other = buildDom(['author-profile-name', 'author-profile-posts-list']);
eq(other.sandbox.mountOrbitVisitorsEntry(), 0, 'perfil ajeno: 0 montajes (la entrada no puede aparecer)');
other.sandbox.renderOrbitVisitorsEntryPreview();
ok(Object.keys(other.els).length === 0, 'perfil ajeno: ningún elemento recibe la entrada');

/* C. i18n: el título sale de t(), no va fijo en español */
const en = buildDom(['profile-visitors-entry-mount'], (s) => (s === 'Quién vio tu perfil' ? 'Who saw your profile' : s));
const enHtml = en.sandbox.orbitVisitorsEntryHTML();
ok(enHtml.includes('Who saw your profile'), 'con t() en inglés el render sale traducido');
ok(!enHtml.includes('Quién vio tu perfil'), 'sin restos del español fijo en el render');
eq((i18nJs.match(new RegExp(escRe('"Quién vio tu perfil"'), 'g')) || []).length >= 3, true,
  'la clave "Quién vio tu perfil" tiene EN/ZH/PT en drex-i18n.js');

/* D. onclick destino real: la hoja y su puerta siguen intactos */
ok(html.includes('window.openOrbitVisitors = openOrbitVisitors'), 'openOrbitVisitors exportado para el onclick');
const iGate = html.indexOf('async function openOrbitVisitors()');
const gateSeg = html.slice(iGate, iGate + 400);
ok(gateSeg.includes("orbitGate('profile_visitors')"), 'la lista sigue pasando por orbitGate(profile_visitors)');

/* ============ 3. Sintaxis de los scripts inline + 404 ============ */
console.log('-- C245.3: sintaxis + identidad 404 --');
const scripts = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
ok(scripts.length >= 30, 'scripts inline localizables: ' + scripts.length);
let badBlock = -1;
scripts.forEach((sc, i) => {
  try { new vm.Script(sc.replace(/<\/?script>/g, '')); }
  catch (e) { if (badBlock === -1) { badBlock = i; console.log('  syntax: bloque ' + i + ': ' + e.message); } }
});
ok(badBlock === -1, 'todos los scripts inline compilan (node --check)');
eq(html404, html, '404.html byte-idéntico a index.html');

console.log('\nC245: ' + pass + ' ok, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
