#!/usr/bin/env node
/* C227: el visor de Destellos no debe pintar datos rancios al navegar rápido.
   Bug 1: drexSnapRenderViewer carga la imagen async sin guarda — si el usuario
   pasa al siguiente destello antes de que cargue, la imagen vieja sobrescribe
   la actual.
   Bug 2: drexSnapRenderReactions pinta innerHTML sin verificar que el destello
   actual siga siendo el mismo — las reacciones del anterior pisan al actual.
   Rojo antes del fix, verde después. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const REPO = process.env.LANE2_REPO || '/tmp/lane2';
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

function extractFn(name) {
  const startMark = 'function ' + name + '(';
  const start = html.indexOf(startMark);
  assert(start !== -1, 'no se encontró ' + name);
  let i = html.indexOf('{', start);
  let depth = 0, inStr = null, esc = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  throw new Error('llaves sin cerrar en ' + name);
}

function makeSandbox() {
  const els = {};
  function el(id) {
    if (!els[id]) {
      els[id] = {
        id, src: '', innerHTML: '', textContent: '', style: {},
        dataset: {},
        classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
        setAttribute() {}, getAttribute() { return null; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        appendChild() {}, remove() {}, addEventListener() {},
      };
    }
    return els[id];
  }
  const sb = {
    console,
    _snapImgCache: {},
    _snapAuthorCache: {},
    _snapViewerList: [],
    _snapViewerIndex: 0,
    _current: null,
    _imgResolvers: [],
    _reactResolvers: [],
    appT: (s) => s,
    escapeHtml: (s) => String(s == null ? '' : s),
    showMiniToast: () => {},
    drexSnapMe: () => 'me1',
    drexSnapIsExpired: () => false,
    drexSnapRemainingText: () => 'x',
    drexSnapSeenSet: () => {},
    drexSnapRefreshViews: () => {},
    drexSnapCloseViewer: () => {},
    drexSnapLoadTray: () => {},
    drexSnapLoadImage: function (sid) {
      return new Promise((res) => { sb._imgResolvers.push({ sid, res }); });
    },
    drexSnapDb: function () {
      return { ref: () => ({ once: () => new Promise((res) => { sb._reactResolvers.push(res); }) }) };
    },
    DREX_SNAP_EMOJIS: ['❤️'],
    document: { getElementById: el, body: { classList: { add() {}, remove() {} } }, activeElement: null },
    window: {},
    setTimeout: (fn) => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  };
  sb.drexSnapCurrent = function () { return sb._current; };
  // drexSnapRenderReactions real se inyecta aparte; por defecto noop
  sb.drexSnapRenderReactions = function () {};
  vm.createContext(sb);
  return { sb, els };
}

async function testImageRace() {
  const { sb, els } = makeSandbox();
  vm.runInContext(extractFn('drexSnapRenderViewer'), sb);
  const A = { id: 'snapA', a: 'u1', expiresAt: Date.now() + 3600000 };
  const B = { id: 'snapB', a: 'u2', expiresAt: Date.now() + 3600000 };
  sb._current = A;
  sb.drexSnapRenderViewer();           // A sin caché: carga async pendiente
  assert.strictEqual(sb._imgResolvers.length, 1, 'A debe disparar carga de imagen');
  sb._current = B;                     // el usuario pasa al siguiente destello
  sb._snapImgCache['snapB'] = 'DATAURL_B';
  sb.drexSnapRenderViewer();           // B se pinta (cacheado)
  assert.strictEqual(els['drex-snap-viewer-img'].src, 'DATAURL_B', 'B visible');
  sb._imgResolvers[0].res('DATAURL_A'); // la imagen lenta de A por fin llega
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(els['drex-snap-viewer-img'].src, 'DATAURL_B',
    'BUG: la imagen rancia de A sobrescribió a B');
  console.log('  ok  imagen del visor: no pinta datos rancios al navegar rápido');
}

async function testReactionsRace() {
  const { sb, els } = makeSandbox();
  vm.runInContext(extractFn('drexSnapRenderReactions'), sb);
  const A = { id: 'snapA', a: 'u1', expiresAt: Date.now() + 3600000 };
  const B = { id: 'snapB', a: 'u2', expiresAt: Date.now() + 3600000 };
  sb._current = A;
  sb.drexSnapRenderReactions();        // lectura lenta de reacciones de A
  assert.strictEqual(sb._reactResolvers.length, 1, 'A debe disparar lectura de reacciones');
  sb._current = B;                     // el usuario pasa al siguiente destello
  sb._reactResolvers[0]({ val: () => ({ '❤️': { u9: true } }) }); // llegan las de A
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(els['drex-snap-reactions'].innerHTML.indexOf('>1<') === -1,
    'BUG: las reacciones rancias de A se pintaron viendo B');
  console.log('  ok  reacciones del visor: no pinta datos rancios al navegar rápido');
}

(async () => {
  let pass = 0, fail = 0;
  for (const t of [testImageRace, testReactionsRace]) {
    try { await t(); pass++; }
    catch (e) { fail++; console.log('  FAIL ' + e.message); }
  }
  console.log(`\nC227: ${pass} ok, ${fail} fallos`);
  process.exit(fail ? 1 : 0);
})();
