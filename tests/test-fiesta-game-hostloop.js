'use strict';
// Test de regresión C55: el anfitrión que recarga a mitad del juego del
// mentiroso y reingresa debe reanudar su host loop. Sin el fix (solo
// fiestaGameStartNow arrancaba el loop), las fases quedaban congeladas para
// siempre: los invitados ven al anfitrión en fiestaMembers y no disparan la
// detección de anfitrión caído.
// Extrae las funciones REALES de ../index.html (sin rutas absolutas ni git).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Extracción por balanceo de llaves (respeta strings y comentarios).
function extractFn(src, name) {
  const m = new RegExp('function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('no encontrada: ' + name);
  let i = src.indexOf('{', m.index);
  const start = m.index;
  let depth = 0, str = null, tpl = 0, lineC = false, blockC = false, esc = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (lineC) { if (c === '\n') lineC = false; continue; }
    if (blockC) { if (c === '*' && n === '/') { blockC = false; i++; } continue; }
    if (str) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (str === '`' && c === '$' && n === '{') { tpl++; i++; continue; }
      if (c === str && tpl === 0) { str = null; continue; }
      if (str === '`' && c === '}' && tpl > 0) { tpl--; continue; }
      continue;
    }
    if (c === '/' && n === '/') { lineC = true; i++; continue; }
    if (c === '/' && n === '*') { blockC = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { str = c; tpl = 0; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('llaves sin cerrar: ' + name);
}

const FNS = ['fiestaGameRemoteUpdate', 'fiestaGameStartHostLoop', 'fiestaGameStopHostLoop']
  .map(n => extractFn(HTML, n)).join('\n');

function makeSandbox() {
  const intervals = [];
  let nextId = 1;
  const sandbox = {
    // Estado de módulo (como en index.html)
    fiestaGame: null,
    _fiestaGameStaleNotified: false,
    fiestaGameMyVote: null,
    fiestaGameHostBusy: false,
    fiestaGameMySecret: null,
    fiestaGameSecretEpoch: null, // C69-F1: preámbulo actualizado (lección C63)
    fiestaCur: { id: 'FIESTA1' },
    fiestaMyUid: 'HOST1',
    fiestaAmHost: true,
    fiestaGameHostInt: null,
    fiestaGameHiddenLocal: false,
    fiestaGameTickInt: null,
    // Stubs
    setInterval: (fn) => { intervals.push(fn); return nextId++; },
    clearInterval: (id) => { const i = intervals.indexOf(id); },
    fiestaGameHostTick: () => {},
    fiestaGameStopTick: () => {},
    fiestaGameHideAll: () => {},
    fiestaGameShowFab: () => {},
    fiestaGameShow: () => {},
    fiestaGameRender: () => {},
    appT: (s) => s,
    document: { getElementById: () => null },
    DrexCloud: { database: () => ({ ref: () => ({ once: () => Promise.resolve({ val: () => null }) }) }) },
    console,
    _intervals: intervals,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(FNS, sandbox, { filename: 'fiesta-game-fns.js' });
  return sandbox;
}

function remoteUpdate(sb, game) {
  vm.runInContext('fiestaGameRemoteUpdate(' + JSON.stringify(game) + ');', sb);
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; /* console.log('ok -', name); */ }
  else { fail++; console.error('FALLO -', name); }
}

// T1: anfitrión reingresa tras reload (loop muerto) con juego activo -> reanuda.
{
  const sb = makeSandbox(); // fiestaGameHostInt = null, fiestaAmHost = true
  remoteUpdate(sb, { status: 'vote', players: ['HOST1', 'A', 'B', 'C'], voteEndsAt: Date.now() + 30000 });
  check('T1: el host loop se reanuda al reingresar con juego activo',
    sb.fiestaGameHostInt !== null && sb._intervals.length === 1);
}

// T2: loop ya corriendo -> no se reinicia (sin churn de intervalos).
{
  const sb = makeSandbox();
  remoteUpdate(sb, { status: 'describe', players: ['HOST1', 'A'], turnEndsAt: Date.now() + 30000 });
  const id1 = sb.fiestaGameHostInt;
  remoteUpdate(sb, { status: 'describe', players: ['HOST1', 'A'], turnEndsAt: Date.now() + 29000 });
  check('T2: no se crea un segundo intervalo si el loop ya corre',
    sb.fiestaGameHostInt === id1 && sb._intervals.length === 1);
}

// T3: el doc del juego se elimina -> el loop se detiene.
{
  const sb = makeSandbox();
  remoteUpdate(sb, { status: 'vote', players: ['HOST1', 'A'] });
  check('T3a: loop corriendo antes del borrado', sb.fiestaGameHostInt !== null);
  remoteUpdate(sb, null);
  check('T3b: loop detenido al borrarse el juego', sb.fiestaGameHostInt === null && sb.fiestaGame === null);
}

// T4: estado final -> no se arranca el loop.
{
  const sb = makeSandbox();
  remoteUpdate(sb, { status: 'final', players: ['HOST1', 'A'], winner: 'civiles' });
  check('T4: sin loop en estado final', sb.fiestaGameHostInt === null && sb._intervals.length === 0);
}

// T5: invitado -> nunca arranca el host loop.
{
  const sb = makeSandbox();
  sb.fiestaAmHost = false;
  sb.fiestaMyUid = 'GUEST1';
  remoteUpdate(sb, { status: 'vote', players: ['HOST1', 'GUEST1', 'A', 'B'] });
  check('T5: el invitado no arranca host loop', sb.fiestaGameHostInt === null && sb._intervals.length === 0);
}

// T6: el secreto propio se sigue re-leyendo al reingresar (sin regresión).
{
  const sb = makeSandbox();
  const readPaths = [];
  sb.DrexCloud = { database: () => ({ ref: (p) => { readPaths.push(p); return {
    once: () => Promise.resolve({ val: () => ({ w: 'Gato', liar: false }) })
  }; } }) };
  vm.runInContext('fiestaGameMySecret = null;', sb);
  remoteUpdate(sb, { status: 'describe', players: ['HOST1', 'A', 'B', 'C'] });
  check('T6: al reingresar se re-lee el secreto propio',
    readPaths.some(p => p === 'fiestaGameSecrets/FIESTA1/HOST1'));
}

console.log(pass + '/' + (pass + fail) + ' asserts OK');
process.exit(fail ? 1 : 0);
