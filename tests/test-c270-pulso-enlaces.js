'use strict';
/* C270 — Tres arreglos del perfil pedidos por el usuario (2026-10-06):
 *  1) Los enlaces del perfil "no se eliminaban": la causa probada en el
 *     código es el campo heredado `website` — nadie lo escribía ya, pero
 *     el editor se sembraba desde ahí al quedar el escaparate vacío y el
 *     perfil lo repintaba. El guardado ahora borra también `website`.
 *  2) Volver desde Pulso dejaba la pantalla en blanco: openPulsoView
 *     ocultaba la vista de origen y closePulsoView no restauraba nada.
 *     Ahora se anota origen + estado de la barra y se restaura tal cual;
 *     sin origen conocido se vuelve al inicio (nunca blanco).
 *  3) El botón Pulso va AL LADO del botón de compartir perfil (móvil y
 *     escritorio), en la misma fila.
 * Ejecutar: node tests/test-c270-pulso-enlaces.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

console.log('== (1) Enlaces: el guardado apaga el heredado ==');
ok(html.includes("update({ showcaseLinks: links.length ? links : null, website: null })"),
  'saveLinkConfig borra website en la misma escritura');
ok(!html.includes("child('showcaseLinks').set("),
  'ya no queda la escritura que dejaba vivo el campo viejo');
ok(html.includes("if (!links.length && d.website)"),
  'la siembra única desde website sigue (migración de cuentas viejas)');

console.log('== (2) Pulso: volver restaura la vista de origen ==');
function extractFn(name) {
  const m = html.match(new RegExp('function ' + name + '\\b[\\s\\S]*?\\n\\}', 'm'));
  if (!m) throw new Error('no encontrada: ' + name);
  return m[0];
}
ok(html.includes('var _pulsoReturnState = null;'), 'estado de retorno de Pulso declarado');

function makeEl(id, visible) {
  const classes = new Set(visible ? [] : ['hidden']);
  return {
    id, scrollTop: 0,
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      contains: c => classes.has(c)
    }
  };
}
function buildScene(originVisible) {
  const els = {};
  ['profile-view', 'creator-hub-view', 'search-view', 'envivo-view', 'pulso-view', 'main-app', 'bottom-nav', 'pulso-view-title']
    .forEach(id => { els[id] = makeEl(id, false); });
  if (originVisible) els[originVisible].classList.remove('hidden');
  els['bottom-nav'].classList.remove('hidden'); // barra visible al inicio
  const navCalls = [];
  const sandbox = {
    console, Set,
    window: {},
    document: { getElementById: id => els[id] || null },
    setBottomNavVisibility: v => { navCalls.push(v); els['bottom-nav'].classList[v ? 'remove' : 'add']('hidden'); },
    appT: s => s,
    openPulsoPanel: () => {},
    drexLoadSectionAds: () => {}
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFn('openPulsoView'),
    extractFn('closePulsoView'),
    'var _pulsoReturnState = null;'
  ].join('\n'), sandbox);
  return { els, navCalls, open: sandbox.openPulsoView, close: sandbox.closePulsoView };
}

// La variable se declara DENTRO del extracto de openPulsoView precedida de
// comentarios; se re-declara en el sandbox para aislar cada escena.

// Escena A: entro a Pulso desde Mi perfil (barra oculta ahí) y vuelvo.
{
  const s = buildScene('profile-view');
  s.els['bottom-nav'].classList.add('hidden'); // en Mi perfil la barra está oculta
  s.open();
  ok(s.els['profile-view'].classList.contains('hidden'), 'A: al abrir Pulso, el perfil se oculta');
  ok(!s.els['pulso-view'].classList.contains('hidden'), 'A: Pulso se muestra');
  ok(s.navCalls[s.navCalls.length - 1] === false, 'A: la barra queda oculta dentro de Pulso');
  s.close();
  ok(s.els['pulso-view'].classList.contains('hidden'), 'A: al volver, Pulso se oculta');
  ok(!s.els['profile-view'].classList.contains('hidden'), 'A: al volver, el perfil REGRESA (sin blanco)');
  ok(s.navCalls[s.navCalls.length - 1] === false, 'A: la barra vuelve oculta, como estaba en el perfil');
}

// Escena B: sin origen visible, volver cae al inicio (nunca blanco).
{
  const s = buildScene(null);
  s.open();
  s.close();
  ok(!s.els['main-app'].classList.contains('hidden'), 'B: sin origen, se muestra el inicio');
  ok(s.navCalls[s.navCalls.length - 1] === true, 'B: la barra vuelve visible en el inicio');
}

console.log('== (3) Pulso junto a compartir ==');
const rowRe = /flex items-center justify-center gap-2 mt-4 w-full max-w-xs/;
ok(rowRe.test(html), 'la fila de acciones del perfil existe');
const iRow = html.search(rowRe);
const rowBlock = html.slice(iRow, iRow + 1600);
ok(rowBlock.includes('shareMyProfile()') && rowBlock.includes('openPulsoView()'),
  'móvil: compartir y Pulso están en la MISMA fila');
ok(rowBlock.indexOf('shareMyProfile()') < rowBlock.indexOf('openPulsoView()'),
  'móvil: primero compartir, Pulso al lado');
ok(!html.includes('mt-2 w-full max-w-xs min-h-[44px] flex items-center justify-center gap-2 py-2.5 rounded-full'),
  'móvil: fuera el botón Pulso ancho y solo de antes');
const iDesk = html.indexOf('flex items-center gap-2 mt-4 w-full max-w-xs');
ok(iDesk > -1, 'escritorio: fila compartir + Pulso presente');
if (iDesk > -1) {
  const deskBlock = html.slice(iDesk, iDesk + 1600);
  ok(deskBlock.includes('shareMyProfile()') && deskBlock.includes('openPulsoView()'),
    'escritorio: compartir y Pulso en la misma fila');
}

console.log(failures ? '\nRESULTADO: ' + failures + ' FALLO(S)' : '\nRESULTADO: TODO VERDE');
process.exit(failures ? 1 : 0);
