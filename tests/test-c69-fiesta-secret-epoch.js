/* ================================================================
 * C69-F1: la palabra secreta del invitado no debe quedar stale cuando el
 * dueño pulsa "Jugar de nuevo" desde la pantalla final.
 *
 * Defecto (base, PoC con BASE_POC=1): `fiestaGameRemoteUpdate()` solo
 * limpiaba `fiestaGameMySecret` cuando el doc del juego pasaba por null.
 * Pero "Jugar de nuevo" hace `set()` SOBRE el doc existente (status 'final'
 * -> 'deal', nuevo `startedAt`): el invitado nunca veía null, el re-read se
 * saltaba (secreto no-null) y la tarjeta "Tu palabra secreta" mostraba la
 * palabra de la PARTIDA ANTERIOR. El invitado describía la palabra
 * equivocada (el tally del dueño usa los secretos frescos de DB, así que el
 * juego seguía con datos correctos salvo la vista del jugador).
 *
 * Fix: `fiestaGameSecretEpoch` = `startedAt` de la partida a la que
 * pertenece el secreto cacheado. En `fiestaGameRemoteUpdate`, si el epoch
 * cambia se invalida el secreto y se dispara el re-read. Resets
 * acompañantes en `fiestaGameStartNow`, `fiestaGameCleanup` y el handler de
 * anfitrión caído.
 *
 * Extrae la función REAL de ../index.html (sin rutas absolutas ni git).
 * Ejecutar con: node tests/test-c69-fiesta-secret-epoch.js
 * Con BASE_POC=1 se corre el PoC contra la base sin fix.
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

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

const BASELINE = process.env.BASE_POC === '1';

if (BASELINE) {
  // PoC: en la base no existe el epoch -> el secreto sobrevive al set() de
  // "Jugar de nuevo" (el re-read solo se dispara con secreto null).
  assert(HTML.indexOf('fiestaGameSecretEpoch') === -1,
    'PoC base: se esperaba ausencia de fiestaGameSecretEpoch');
  const f = extractFn(HTML, 'fiestaGameRemoteUpdate');
  assert(/if \(!fiestaGame\) \{\s*\n?\s*fiestaGameMySecret = null;/.test(f),
    'PoC base: el secreto solo se limpia cuando el doc es null');
  console.log('PoC OK (base): "Jugar de nuevo" (set sin null) deja la palabra anterior en el invitado (defecto presente)');
  process.exit(0);
}

/* ---------- Checks estáticos sobre el código real ---------- */
const remoteSrc = extractFn(HTML, 'fiestaGameRemoteUpdate');
assert(/var fiestaGameSecretEpoch = null;/.test(HTML), 'debe declararse fiestaGameSecretEpoch');
assert(/_secretEpoch !== fiestaGameSecretEpoch/.test(remoteSrc),
  'remoteUpdate debe invalidar el secreto cuando cambia el startedAt');
assert(/fiestaGameSecretEpoch = _secretEpoch;\s*\n?\s*fiestaGameMySecret = null;/.test(remoteSrc),
  'al cambiar de partida el secreto debe limpiarse para forzar el re-read');
const startNowSrc = extractFn(HTML, 'fiestaGameStartNow');
assert(/fiestaGameSecretEpoch = null;/.test(startNowSrc), 'fiestaGameStartNow debe resetear el epoch');
const cleanupSrc = extractFn(HTML, 'fiestaGameCleanup');
assert(/fiestaGameSecretEpoch = null;/.test(cleanupSrc), 'fiestaGameCleanup debe resetear el epoch');
console.log('OK  estaticos: epoch declarado, invalidación en remoteUpdate + resets');

/* ---------- Escenario funcional con la función real en vm ---------- */
const FN = extractFn(HTML, 'fiestaGameRemoteUpdate');

// Secreto que "vive" en DB por partida (el dueño lo sobrescribe al iniciar).
let dbSecret = { w: 'Gato', liar: false };
let rereadCalls = 0;
function makeSandbox() {
  const sandbox = {
    fiestaGame: null,
    _fiestaGameStaleNotified: false,
    fiestaGameMyVote: null,
    fiestaGameHostBusy: false,
    fiestaGameMySecret: null,
    fiestaGameSecretEpoch: null,
    fiestaCur: { id: 'F1' },
    fiestaMyUid: 'GUEST1',
    fiestaMembers: { HOST1: { name: 'Host' }, GUEST1: { name: 'Invitado' }, A: {}, B: {} },
    fiestaAmHost: false, // invitado
    fiestaGameHostInt: null,
    fiestaGameHiddenLocal: false,
    fiestaGameTickInt: null,
    // Stubs
    fiestaGameStartHostLoop: () => {},
    fiestaGameStopHostLoop: () => {},
    fiestaGameHideAll: () => {},
    fiestaGameShowFab: () => {},
    fiestaGameShow: () => {},
    fiestaGameRender: () => {},
    appT: (s) => s,
    document: { getElementById: () => null },
    DrexCloud: {
      database: () => ({
        ref: (p) => ({
          once: () => {
            if (/fiestaGameSecrets\/F1\/GUEST1$/.test(p)) {
              rereadCalls++;
              const v = dbSecret;
              return Promise.resolve({ val: () => v });
            }
            return Promise.resolve({ val: () => null });
          }
        })
      })
    },
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(FN, sandbox, { filename: 'remote-under-test.js' });
  return sandbox;
}

const flush = () => new Promise(r => setImmediate(r));

(async () => {
  const sb = makeSandbox();
  const remoteUpdate = (game) =>
    vm.runInContext('fiestaGameRemoteUpdate(' + JSON.stringify(game) + ');', sb);
  const state = () => vm.runInContext(
    '({ w: fiestaGameMySecret && fiestaGameMySecret.w, epoch: fiestaGameSecretEpoch, rereads: null })', sb);

  // T1: partida 1 -> el invitado lee su palabra.
  remoteUpdate({ status: 'deal', players: ['HOST1', 'GUEST1', 'A', 'B'], startedAt: 1000 });
  await flush(); await flush();
  let st = state();
  assert(st.w === 'Gato' && st.epoch === 1000, 'T1: el invitado lee la palabra de la partida 1');
  assert(rereadCalls === 1, 'T1: un solo re-read del secreto');
  console.log('OK  T1: partida 1 -> palabra "Gato" leída');

  // T2: update de la MISMA partida (fase describe) -> el secreto se conserva, sin re-read.
  dbSecret = { w: 'Perro', liar: true }; // la DB ya tendría la nueva... pero es la misma partida
  remoteUpdate({ status: 'describe', players: ['HOST1', 'GUEST1', 'A', 'B'], startedAt: 1000, turnIndex: 0 });
  await flush(); await flush();
  st = state();
  assert(st.w === 'Gato' && st.epoch === 1000, 'T2: misma partida -> se conserva la palabra');
  assert(rereadCalls === 1, 'T2: sin re-read redundante en la misma partida');
  console.log('OK  T2: misma partida -> sin re-read, palabra conservada');

  // T3: "Jugar de nuevo" (set sobre el doc, SIN pasar por null, nuevo startedAt).
  dbSecret = { w: 'Perro', liar: true }; // el dueño repartió palabras nuevas
  remoteUpdate({ status: 'deal', players: ['HOST1', 'GUEST1', 'A', 'B'], startedAt: 2000 });
  await flush(); await flush();
  st = state();
  assert(st.w === 'Perro' && st.epoch === 2000,
    'T3: partida nueva -> el secreto stale se invalida y se lee la palabra nueva (recibido: ' + st.w + ')');
  assert(rereadCalls === 2, 'T3: el re-read se disparó tras la invalidación');
  console.log('OK  T3: "Jugar de nuevo" -> palabra nueva "Perro" (defecto corregido)');

  // T4: fin del juego (doc null) -> limpieza total como antes.
  remoteUpdate(null);
  await flush();
  st = state();
  assert(st.w === null, 'T4: doc null -> secreto limpiado');
  console.log('OK  T4: doc null -> limpieza como antes');

  console.log('\nC69-F1: 4/4 escenarios OK');
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
