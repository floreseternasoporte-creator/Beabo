#!/usr/bin/env node
/* =====================================================================
 * C253 — "Quién vio tu perfil" compacto estilo TikTok (orden del usuario
 * con capturas Drex vs TikTok, 2026-10-06):
 *
 *  - La píldora completa bajo Pulso "está abajo estorbando": fuera. En el
 *    perfil propio solo queda un CHIP compacto de ojo + contador pegado a
 *    la foto (ambos layouts; los montajes se movieron junto al avatar).
 *  - La ACTIVACIÓN vive ahora en Ajustes › Privacidad (interruptor
 *    #profile-views-toggle), como en TikTok: users/<uid>/profileViewsEnabled
 *    es opt-in. Sin activación NO se registran tus visitas en perfiles
 *    ajenos (opt-in recíproco) y el chip no pinta contador.
 *  - Tocar el chip sin activar abre el aviso con "Ir a Ajustes"; activado
 *    abre la lista tras la puerta Orbit de siempre (C243, intacta).
 *
 * Este test EJECUTA el bloque real en vm con DrexCloud/DOM falsos:
 * registro apagado→sin escritura, encendido→escritura (con reciclaje de
 * 30 min), contador sin auto-visita, router chip y pintura del switch.
 *
 * Uso: node tests/test-c253-visitors-compact.js
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

/* ============ 1. Estructura: montajes junto a la foto ============ */
console.log('-- C253.1: chip junto a la foto, píldora fuera --');
const iProfileView = html.indexOf('id="profile-view"');
const iAuthorModal = html.indexOf('id="author-profile-modal"');
const profileSeg = html.slice(iProfileView, iAuthorModal);
const iMountMob = profileSeg.indexOf('id="profile-visitors-entry-mount"');
const iMountDesk = profileSeg.indexOf('id="profile-visitors-entry-mount-desktop"');
ok(iMountMob !== -1 && iMountDesk !== -1, 'los dos montajes siguen existiendo');
ok(iMountMob < profileSeg.indexOf('onclick="openPulsoView()"'), 'móvil: el chip ya NO está bajo Pulso');
/* C254 (corrección del usuario): esquina superior del encabezado, como
   TikTok — nada sobre la foto grande. */
ok(profileSeg.indexOf('onclick="openAccountSwitcher()"') < iMountMob && iMountMob < profileSeg.indexOf('onclick="openProfileSettings()"'),
  'C254 móvil: esquina superior del encabezado, antes del engranaje');
ok(iMountDesk < profileSeg.indexOf('id="profile-image-desktop"'),
  'C254 escritorio: barra superior, antes de la foto');
eq((profileSeg.match(/id="profile-visitors-entry-mount"/g) || []).length, 1, 'exactamente un montaje móvil');
eq((profileSeg.match(/id="profile-visitors-entry-mount-desktop"/g) || []).length, 1, 'exactamente un montaje de escritorio');

/* Ajustes › Privacidad: interruptor de activación */
const iPriv = html.indexOf('id="privacy-config-view"');
const iPrivEnd = html.indexOf('id="chat-privacy-settings-view"', iPriv);
const privSeg = html.slice(iPriv, iPrivEnd);
ok(privSeg.includes('id="profile-views-toggle"'), 'Ajustes › Privacidad: interruptor #profile-views-toggle');
ok(privSeg.includes('onclick="toggleProfileViewsEnabled()"'), 'interruptor cableado a toggleProfileViewsEnabled()');
ok(privSeg.includes('role="switch"'), 'interruptor con rol switch (patrón de la app)');
ok(privSeg.includes('Ve quién visita tu perfil. Al activarlo'), 'descripción honesta del opt-in recíproco');
const iOpenPriv = html.indexOf('function openPrivacyConfigView()');
ok(html.slice(iOpenPriv, iOpenPriv + 2600).includes('paintProfileViewsToggle()'),
  'openPrivacyConfigView pinta el interruptor con el estado real');

/* exports globales para los onclick (dinámico + estático) */
for (const name of ['openProfileVisitorsEntry', 'toggleProfileViewsEnabled', 'paintProfileViewsToggle']) {
  ok(html.includes('window.' + name + ' = ' + name), 'export global: window.' + name);
}

/* claves nuevas traducidas en los 3 diccionarios */
const newKeys = [
  'Ve quién visita tu perfil. Al activarlo, también apareces en la lista de perfiles que visitas.',
  'Para ver quién visita tu perfil, activa primero las vistas de perfil en Ajustes › Privacidad.',
  'Ir a Ajustes',
  'Vistas de perfil activadas.',
  'Vistas de perfil desactivadas.',
];
for (const k of newKeys) {
  eq((i18nJs.match(new RegExp(escRe('"' + k + '"'), 'g')) || []).length, 4,
    'clave EN/ZH/PT: ' + k.slice(0, 42) + '…');
}

/* ============ 2. Ejecución en vm del bloque real ============ */
console.log('-- C253.2: comportamiento ejecutado en vm --');
const iStart = html.indexOf('async function drexRecordProfileVisit');
const iEnd = html.indexOf('function closeOrbitVisitors()', iStart);
ok(iStart !== -1 && iEnd !== -1, 'bloque de visitantes localizable');
const src = html.slice(iStart, iEnd);

function fakeEl() {
  const classes = new Set();
  const el = {
    innerHTML: '', textContent: '', attrs: {}, children: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => { if (on === undefined) on = !classes.has(c); if (on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => { el.attrs[k] = v; },
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    querySelector: (sel) => el.children[sel] || (el.children[sel] = fakeEl()),
    appendChild: () => {},
  };
  return el;
}

const db = {}; const writes = []; const toasts = []; let listOpens = 0; let privOpens = 0;
const knownIds = ['profile-visitors-entry-mount', 'profile-visitors-entry-mount-desktop',
  'profile-views-toggle', 'orbit-visitors-sheet', 'orbit-visitors-list',
  'orbit-visitors-title', 'orbit-visitors-note'];
const els = {};
const chips = [fakeEl(), fakeEl()];
const store = new Map();
const sandbox = {
  console, Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set,
  escapeHtml: (s) => String(s == null ? '' : s),
  t: (s) => s,
  liveUser: () => ({ uid: 'me1' }),
  DrexCloud: {
    database: () => ({
      ref: (p) => ({
        once: async () => ({ val: () => (p in db ? db[p] : null) }),
        set: async (v) => { writes.push([p, v]); db[p] = v; },
      }),
    }),
  },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
  securityToast: (m) => toasts.push(m),
  /* C255: perfiles de visitantes para la mini foto del último visitante */
  _getCachedAuthorProfiles: async (uids) => new Map(uids.map((u) => [u, { profileImage: 'foto-' + u }])),
  getSafeMediaUrl: (s) => s || '',
  openOrbitVisitors: () => { listOpens++; },
  openPrivacyConfigView: () => { privOpens++; },
  document: {
    getElementById: (id) => (knownIds.indexOf(id) !== -1 ? (els[id] = els[id] || fakeEl()) : null),
    querySelectorAll: (sel) => (sel === '.profile-visitors-chip' ? chips : []),
    body: fakeEl(),
    appendChild: () => {},
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

(async () => {
  /* A. Sin activar (default): NO se registra ninguna visita */
  eq(await sandbox.drexProfileViewsEnabled(), false, 'default opt-in: vistas apagadas');
  await sandbox.drexRecordProfileVisit('owner9');
  eq(writes.length, 0, 'apagado: visitar un perfil ajeno NO escribe nada');
  sandbox.mountOrbitVisitorsEntry();
  await sandbox.refreshProfileVisitorsChip();
  ok(chips[0].classList.contains('opacity-50'), 'chip apagado: atenuado');
  ok(chips[0].querySelector('.pv-mini-photo').src === undefined, 'C255 chip apagado: ninguna foto de visitante');

  /* B. Activar desde Ajustes: escribe el flag, pinta switch y avisa */
  await sandbox.toggleProfileViewsEnabled();
  eq(db['users/me1/profileViewsEnabled'], true, 'toggle ON escribe users/<uid>/profileViewsEnabled=true');
  eq(els['profile-views-toggle'].attrs['aria-checked'], 'true', 'switch pintado aria-checked=true');
  ok(toasts.includes('Vistas de perfil activadas.'), 'toast de activación');
  eq(await sandbox.drexProfileViewsEnabled(), true, 'estado encendido (caché tras toggle)');

  /* C. Encendido (visitante Y dueño): la visita se registra una vez
     (reciclaje 30 min). C286: el DUEÑO también debe tener las vistas
     activadas; si no, no se acumula historial en silencio. */
  db['users/owner9/profileViewsEnabled'] = true;
  await sandbox.drexRecordProfileVisit('owner9');
  eq(writes.filter((w) => w[0] === 'users/owner9/profileVisitors/me1').length, 1, 'encendido: visita registrada');
  await sandbox.drexRecordProfileVisit('owner9');
  eq(writes.filter((w) => w[0] === 'users/owner9/profileVisitors/me1').length, 1, 'reciclaje 30 min: sin doble escritura');
  await sandbox.drexRecordProfileVisit('me1');
  eq(writes.filter((w) => w[0] === 'users/me1/profileVisitors/me1').length, 0, 'auto-visita jamás se registra');
  await sandbox.drexRecordProfileVisit('ownerOff');
  eq(writes.filter((w) => w[0] === 'users/ownerOff/profileVisitors/me1').length, 0, 'C286: dueño con vistas apagadas no acumula visitas');

  /* D. Huella: la mini foto es la del ÚLTIMO visitante, nunca la mía */
  db['users/me1/profileVisitors'] = { a: 111, b: 222, me1: 333 };
  await sandbox.refreshProfileVisitorsChip();
  eq(chips[0].querySelector('.pv-mini-photo').src, 'foto-b', 'C255: mini foto = último visitante');
  ok(!chips[0].classList.contains('opacity-50'), 'chip encendido sin atenuar');

  /* E. Router del chip: encendido → lista; apagado → aviso a Ajustes */
  await sandbox.openProfileVisitorsEntry();
  eq(listOpens, 1, 'chip encendido abre la lista (puerta Orbit dentro)');
  await sandbox.toggleProfileViewsEnabled();
  eq(db['users/me1/profileViewsEnabled'], false, 'toggle OFF escribe false');
  ok(toasts.includes('Vistas de perfil desactivadas.'), 'toast de desactivación');
  await sandbox.openProfileVisitorsEntry();
  eq(listOpens, 1, 'chip apagado NO abre la lista');
  ok(els['orbit-visitors-list'].innerHTML.includes('Ir a Ajustes'), 'aviso con botón Ir a Ajustes');
  ok(els['orbit-visitors-list'].innerHTML.includes('Ajustes › Privacidad'), 'aviso explica dónde se activa');
  ok(els['orbit-visitors-list'].innerHTML.includes('closeOrbitVisitors(); openPrivacyConfigView()'),
    'el botón lleva directo a Ajustes › Privacidad');

  /* F. Chip renderizado: solo la foto, sin píldora ni número */
  const chip = sandbox.orbitVisitorsEntryHTML();
  ok(chip.includes('profile-visitors-chip'), 'chip con clase profile-visitors-chip');
  ok(chip.includes('onclick="openProfileVisitorsEntry()"'), 'chip abre el router C253');
  ok(!chip.includes('pv-count'), 'C257: chip SIN número junto a la foto');
  ok(!chip.includes('w-full max-w-xs'), 'chip NO es la píldora de fila entera');
  /* C254: como TikTok — mini foto, ningún icono de ojo. */
  ok(chip.includes('pv-mini-photo'), 'C254: chip con mini foto de perfil');
  ok(!chip.includes('M1 12s4-8'), 'C254: chip sin icono de ojo');
  /* C255: la huella va limpia, sin píldora de fondo, con su foto de reserva */
  ok(!chip.includes('shadow-sm'), 'C255: chip sin píldora (sin fondo ni sombra)');
  ok(chip.includes('data-default-src'), 'C255: silueta genérica de reserva presente');
  eq(sandbox.mountOrbitVisitorsEntry(), 2, 'montaje en los dos layouts');
  ok(els['profile-visitors-entry-mount'].innerHTML.includes('profile-visitors-entry'), 'montaje móvil relleno');
  ok(els['profile-visitors-entry-mount-desktop'].innerHTML.includes('profile-visitors-entry'), 'montaje escritorio relleno');

  /* ============ 3. Sintaxis + 404 ============ */
  console.log('-- C253.3: sintaxis + identidad 404 --');
  const scripts = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
  let badBlock = -1;
  scripts.forEach((sc, i) => {
    try { new vm.Script(sc.replace(/<\/?script>/g, '')); }
    catch (e) { if (badBlock === -1) { badBlock = i; console.log('  syntax: bloque ' + i + ': ' + e.message); } }
  });
  ok(badBlock === -1, 'todos los scripts inline compilan');
  eq(html404, html, '404.html byte-idéntico a index.html');

  console.log('\nC253: ' + pass + ' ok, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR: ' + (e && e.stack || e)); process.exit(1); });
