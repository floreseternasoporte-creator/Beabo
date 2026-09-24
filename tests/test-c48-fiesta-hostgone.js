// test-c48-fiesta-hostgone.js — Fiestas/mentiroso: juego congelado si el anfitrión muere (C48-F1).
// El host loop (fiestaGameHostTick cada 2 s) corre SOLO en el cliente del
// anfitrión y es lo único que avanza las fases (deal→describe→vote→reveal→
// final). Si su app muere sin leaveFiesta, status queda 'live', el doc
// fiestas/<id>/game queda congelado en la fase actual y los invitados no
// tienen recuperación (fiestaGameStartNow/fiestaGameEndForAll exigen
// fiestaAmHost). El overlay quedaba con la cuenta atrás en 0 para siempre.
// Fix: fiestaGameCheckHostGone() —invocado desde el tick del invitado—
// detecta fase vencida +15 s con el anfitrión ausente de fiestaMembers y
// entonces oculta el juego localmente con aviso (appT) e intenta limpiar el
// doc huérfano (best-effort). El flag se rearma en cada actualización remota
// y en fiestaGameCleanup (logout vía clearAccountScopedState).
// Convención: estático + funcional contra el archivo del repo, sin rutas
// absolutas ni historial de git. Los checks SOLO pasan con el fix presente.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repoRoot = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf-8');
const i18n = fs.readFileSync(path.join(repoRoot, 'drex-i18n.js'), 'utf-8');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

function extractFn(src, name) {
  const m = src.match(new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\('));
  assert(m, 'funcion no encontrada: ' + name);
  const start = m.index;
  let brace = src.indexOf('{', start);
  let depth = 0, i = brace;
  for (;;) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return src.slice(start, i + 1);
}

// ---------- estático ----------
check('F1: existe fiestaGameCheckHostGone', /function\s+fiestaGameCheckHostGone\s*\(\)/.test(html));
check('F1: el tick del invitado invoca la detección', /typeof fiestaGameCheckHostGone === 'function'\) fiestaGameCheckHostGone\(\);/.test(html));
check('F1: la detección exige fase vencida con margen y anfitrión ausente de fiestaMembers',
  /fiestaGamePhaseEndsAt\(fiestaGame\)/.test(html) && /fiestaGameMember\(hostUid\)/.test(html));
check('F1: el flag anti-doble-aviso se rearma en fiestaGameRemoteUpdate',
  (() => { const f = extractFn(html, 'fiestaGameRemoteUpdate'); return /_fiestaGameStaleNotified = false/.test(f); })());
check('F1: el flag se resetea en fiestaGameCleanup (logout vía clearAccountScopedState)',
  (() => { const f = extractFn(html, 'fiestaGameCleanup'); return /_fiestaGameStaleNotified = false/.test(f); })());
check('F1: best-effort de limpieza del doc huérfano con catch',
  /fiestas\/' \+ fiestaCur\.id \+ '\/game'\)\.remove\(\)\.catch/.test(html));
check('i18n: clave del aviso en EN/ZH/PT',
  (i18n.match(/"El juego se detuvo: el anfitrión se desconectó\."/g) || []).length === 3);

// ---------- funcional: funciones reales en vm ----------
const removes = [], toasts = [];
function makeEl() {
  const cls = new Set();
  return { classList: {
    add: (c) => cls.add(c), remove: (c) => cls.delete(c),
    toggle: (c, f) => { if (f) cls.add(c); else cls.delete(c); },
    contains: (c) => cls.has(c),
  }, _cls: cls, textContent: '' };
}
const els = { 'fiesta-game-view': makeEl(), 'fiesta-game-fab': makeEl() };
let funcsOk = true, loadErr = '';
try {
  const code = `
var fiestaGame = null, fiestaGameMySecret = null, fiestaGameTickInt = null;
var fiestaGameHiddenLocal = false, fiestaAmHost = false, fiestaCur = null;
var fiestaMembers = {}, fiestaGameMyVote = null, fiestaGameHostBusy = false;
var _fiestaGameStaleNotified = false;
var fiestaGameSecretEpoch = null; // C69-F1: preámbulo actualizado (lección C63)
var document = { getElementById: function (id) { return els[id] || null; } };
var window = {};
var DrexCloud = { database: function () { return { ref: function (p) { return {
  remove: function () { removes.push(p); return { catch: function () {} }; } }; } }; } };
function showMiniToast(t) { toasts.push(t); }
function appT(s) { return s; }
` + ['fiestaGameMember', 'fiestaGameShowFab', 'fiestaGameStopTick', 'fiestaGameHideAll',
      'fiestaGamePhaseEndsAt', 'fiestaGameCheckHostGone'].map(n => extractFn(html, n)).join('\n');
  const ctx = { console, JSON, Object, Array, Promise, Date, Math, String, Number,
    setInterval, clearInterval, els, removes, toasts };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  vm.runInContext(`
    fiestaGame = { status: 'describe', turnEndsAt: Date.now() - 60000, players: ['h','a'], out: [], round: 1 };
    fiestaGameMySecret = { w: 'Gato', liar: false };
    fiestaAmHost = false;
    fiestaCur = { id: 'sid1', data: { hostId: 'h' } };
    fiestaMembers = { a: { name: 'A' } }; // 'h' (anfitrión) ausente: su app murió
    fiestaGameCheckHostGone();
  `, ctx);
  const st = vm.runInContext(`({ notified: _fiestaGameStaleNotified,
    viewHidden: els['fiesta-game-view']._cls.has('hidden'),
    secretGone: fiestaGameMySecret === null })`, ctx);
  check('F1 funcional: fase vencida + anfitrión ausente → toast de aviso', toasts.length === 1 && /anfitrión se desconectó/.test(toasts[0]));
  check('F1 funcional: overlay ocultado localmente', st.viewHidden === true);
  check('F1 funcional: intento de limpiar el doc huérfano', removes.indexOf('fiestas/sid1/game') !== -1);
  check('F1 funcional: secreto local olvidado y flag activado', st.secretGone && st.notified);
  // Negativo: anfitrión presente → sin acción.
  vm.runInContext(`toasts.length = 0; removes.length = 0; _fiestaGameStaleNotified = false;
    els['fiesta-game-view']._cls.delete('hidden');
    fiestaGame = { status: 'describe', turnEndsAt: Date.now() - 60000, players: ['h','a'], out: [] };
    fiestaMembers = { h: { name: 'Host' }, a: { name: 'A' } };
    fiestaGameCheckHostGone();`, ctx);
  const st2 = vm.runInContext(`({ t: toasts.length, r: removes.length,
    hidden: els['fiesta-game-view']._cls.has('hidden') })`, ctx);
  check('F1 funcional: anfitrión presente → sin acción', st2.t === 0 && st2.r === 0 && !st2.hidden);
} catch (e) { funcsOk = false; loadErr = e.message; }
check('F1 funcional: harness con funciones reales ejecutado', funcsOk);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
