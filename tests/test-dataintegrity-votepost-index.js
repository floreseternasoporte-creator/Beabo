/* ================================================================
 * DATA-INTEGRITY — votePost: el índice userVotes/<uid>/<noteId> no debe
 * ser fire-and-forget.
 *
 * HALLAZGO (bug real, verificado en código): en votePost (index.html) la
 * transacción del contador se comprometía y DESPUÉS se escribía el índice
 * con `userVoteRef.set(newVote)` / `userVoteRef.remove()` SIN await ni
 * encadenar (promesas flotantes). Si esa escritura se perdía (red
 * inestable, cierre de pestaña), el contador quedaba movido pero el índice
 * no. El siguiente voto leía `userVotes/<uid>/<noteId>` como currentVote
 * obsoleto y la transacción aplicaba la transición equivocada: el contador
 * se desincronizaba de forma PERMANENTE (+1 por cada escritura perdida).
 *
 * FIX (index.html, votePost): el índice se escribe ANTES de la transacción
 * del contador y DENTRO del flujo con reintento (_runWithAutoRetry). Si la
 * escritura del índice falla, el reintento la repite; si ya se había
 * aplicado todo pero se perdió la respuesta, el guard
 * `serverVote === intendedVote` evita el doble conteo. En postGone (A16) se
 * revierte el índice pre-escrito.
 *
 * Este test extrae votePost + _runWithAutoRetry + _isRetryableNetError del
 * index.html real y los ejecuta en sandbox con un DrexCloud falso:
 *  - Escenario A: un fallo de red mata la escritura del índice en el
 *    intento 1. Al converger, el contador Y el índice deben coincidir.
 *  - Escenario B: votar de nuevo (toggle-off). El contador debe volver
 *    exactamente al valor previo, sin deriva.
 *
 * Ejecutar con: node tests/test-dataintegrity-votepost-index.js
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let failures = 0;
function tcase(name, fn) {
  try {
    const ok = fn();
    console.log((ok ? 'ok - ' : 'NOT OK - ') + name);
    if (!ok) failures++;
  } catch (e) {
    console.log('NOT OK - ' + name + ' [excepción: ' + (e && e.message) + ']');
    failures++;
  }
}
function count(re, src) { return (src.match(re) || []).length; }

// ---------- Extractor (misma técnica que los harnesses del ciclo) ----------
function extractFn(source, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(source);
  if (!m) throw new Error('no se encontró ' + name);
  const start = m.index;
  let i = source.indexOf('(', m.index), j, pdepth = 0, depth = 0, inStr = null, esc = false;
  for (j = i; j < source.length; j++) {
    const c = source[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(') pdepth++; else if (c === ')') { pdepth--; if (pdepth === 0) break; }
  }
  const bodyStart = source.indexOf('{', j);
  inStr = null; esc = false;
  for (j = bodyStart; j < source.length; j++) {
    const c = source[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(start, j + 1);
}

// Captura los rejection sin manejar (el bug original deja uno flotando).
const unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(e); });

// ---------- DrexCloud falso (fuera del vm, referenciado desde el sandbox) ----------
const deep = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const store = {};
const failOnce = {}; // path -> nº de fallos a inyectar en set/remove
const snapOf = (v) => ({ val: () => deep(v), exists: () => v !== undefined && v !== null });
function makeRef(p) {
  return {
    once: () => Promise.resolve(snapOf(store[p])),
    set: (v) => {
      if (failOnce[p] > 0) { failOnce[p]--; return Promise.reject(new Error('network timeout')); }
      store[p] = deep(v);
      return Promise.resolve();
    },
    remove: () => {
      if (failOnce[p] > 0) { failOnce[p]--; return Promise.reject(new Error('network timeout')); }
      delete store[p];
      return Promise.resolve();
    },
    // Semántica mínima fiel de transaction(): aplica updateFn al valor
    // actual; undefined = aborta (committed:false).
    transaction: (updateFn) => {
      const cur = deep(store[p]);
      const next = updateFn(cur === undefined ? null : cur);
      if (next === undefined) return Promise.resolve({ committed: false, snapshot: null });
      store[p] = deep(next);
      return Promise.resolve({ committed: true, snapshot: snapOf(store[p]) });
    }
  };
}
const DrexCloud = {
  auth: () => ({ currentUser: { uid: 'u1', displayName: 'Tester' } }),
  database: () => ({ ref: (p) => makeRef(p) })
};

const sandbox = {
  console, DrexCloud,
  document: { querySelectorAll: () => [] },
  CSS: { escape: (s) => String(s) },
  showMiniToast: () => {},
  appT: (s) => s,
  formatVoteScore: (v) => String(v),
  addNotification: () => {},
  refreshHistorialIfVisible: () => {},
  _noteFail: () => {},
  _postVoteLocks: new Set(),
  _drexUpvoteActivatedAt: new Map(),
  _drexUpvoteActivatedSet: () => {},
  DREX_UPVOTE_DOUBLE_TAP_MS: 400,
  setTimeout, clearTimeout
};
vm.createContext(sandbox);
const srcFns = [
  extractFn(html, '_isRetryableNetError'),
  extractFn(html, '_runWithAutoRetry'),
  extractFn(html, 'votePost')
].join('\n');
vm.runInContext(srcFns, sandbox);

// El índice se escribe suelto (sin await) en el código con el bug.
tcase('estático: votePost no deja userVoteRef.set/remove flotando tras el commit', () => {
  const src = extractFn(html, 'votePost');
  const detached = (src.match(/^\s*userVoteRef\.(set|remove)\(/gm) || []).length;
  return detached === 0;
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitIdle() {
  const t0 = Date.now();
  while (sandbox._postVoteLocks.has('n1') && Date.now() - t0 < 15000) await sleep(100);
  return !sandbox._postVoteLocks.has('n1');
}

(async () => {
  // Escenario A: fallo de red mata la escritura del índice en el intento 1.
  store['communityNotes/n1'] = { upvotes: 5, downvotes: 0, authorId: 'author1' };
  failOnce['userVotes/u1/n1'] = 1;
  vm.runInContext("votePost('n1', 'up')", sandbox);
  const idleA = await waitIdle();
  const upA = store['communityNotes/n1'] && store['communityNotes/n1'].upvotes;
  const idxA = store['userVotes/u1/n1'];
  tcase('A1: el voto converge (lock liberado)', () => idleA === true);
  tcase('A2: contador = 6 (exactamente un voto aplicado)', () => upA === 6);
  tcase('A3: índice userVotes/u1/n1 = "up" (la escritura no se perdió)', () => idxA === 'up');

  // Escenario B: segundo toque = quitar el voto; el contador debe volver a 5.
  vm.runInContext("votePost('n1', 'up')", sandbox);
  const idleB = await waitIdle();
  const upB = store['communityNotes/n1'] && store['communityNotes/n1'].upvotes;
  const idxB = store['userVotes/u1/n1'];
  tcase('B1: converge (lock liberado)', () => idleB === true);
  tcase('B2: contador vuelve a 5 (sin deriva permanente)', () => upB === 5);
  tcase('B3: índice eliminado', () => idxB === undefined);

  if (unhandled.length) console.log('info: ' + unhandled.length + ' rejection(s) sin manejar durante la prueba');
  console.log(failures ? ('\n' + failures + ' prueba(s) en ROJO') : '\nTODO VERDE');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FALLO del harness:', e); process.exit(2); });
