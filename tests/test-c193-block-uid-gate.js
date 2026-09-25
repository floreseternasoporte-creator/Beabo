// C193 — regresión: target forjado en blockUserFromUserActions /
// breakFollowRelationsOnBlock.
//
// HALLAZGO (PoC D1/D2, Chromium real vía CDP, base a648c89b): un targetId
// forjado con '/' (note.authorId manipulado por el autor del post; llega a
// currentPostOptionsAuthorId al abrir la hoja de opciones) llegaba CRUDO a:
//   blocks/<me>/foo/bar                        (set anidado: corrompe la forma
//                                               de la lista — el snapshot
//                                               superior ve 'foo' como UID)
//   followers/foo/bar/<me>=null                (tombstones en namespace
//   following/<me>/foo/bar=null                 compartido)
//   followRequests/foo/bar/<me>=null, followRequests/<me>/foo/bar=null
//   users/foo/bar/followersCount (transaction)  (basura bajo users/foo)
//   users/<me>/followingCount (transaction)
// ANTES de cualquier validación. Parche: gate `isValidChatUid` al inicio de
// blockUserFromUserActions (antes del set en blocks/) y a nivel del sink en
// breakFollowRelationsOnBlock (cubre los 5 call sites).
//
// Decisión documentada (PoC D3): confirmSharePost lee blocks/…/<otherUid>
// ANTES del gate C191, pero son solo LECTURAS anidadas contenidas y la ruta
// de escritura ya la estrangula ensureConversationExists/getDirectConversationId
// (0 escrituras con otherUid forjado) → NO se parchea. El assert estático
// 'sin-gate' fija esa decisión: si se toca, re-auditar.
//
// Test híbrido: asserts estáticos (fallan en base) + conductuales en sandbox
// vm con DrexCloud programable que registra escrituras (FAIL en base, PASS
// con parche). Uso: node tests/test-c193-block-uid-gate.js [--target=html]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(__dirname, '..', 'index.html');
let html;
try { html = fs.readFileSync(htmlPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer index.html'); process.exit(1); }

let failures = 0;
function ok(name, cond) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name); }
}
function tcase(name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') return r.then(
    () => console.log('ok - ' + name),
    (e) => { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); });
    console.log('ok - ' + name); return Promise.resolve(); }
  catch (e) { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); return Promise.resolve(); }
}
function extractFn(src, declLine) {
  const declIdx = src.indexOf(declLine);
  if (declIdx < 0) throw new Error('declaración no encontrada: ' + declLine);
  // balancear parámetros (puede haber '{}' en defaults) y luego el cuerpo
  let paren = 0, i = src.indexOf('(', declIdx);
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')') { paren--; if (paren === 0) break; }
  }
  const braceIdx = src.indexOf('{', i);
  let depth = 0;
  for (let j = braceIdx; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(declIdx, j + 1); }
  }
  throw new Error('cierre no encontrado: ' + declLine);
}

// ---------- asserts estáticos (fallan en base) ----------
const blockSrc = extractFn(html, 'function blockUserFromUserActions()');
const breakSrc = extractFn(html, 'async function breakFollowRelationsOnBlock(myUid, targetId)');
const shareSrc = extractFn(html, 'async function confirmSharePost()');
ok('estático: blockUserFromUserActions valida targetId con isValidChatUid',
  /isValidChatUid\(targetId\)/.test(blockSrc));
ok('estático: el gate va ANTES del set en blocks/<me>/<targetId>',
  blockSrc.indexOf('isValidChatUid(targetId)') >= 0 &&
  blockSrc.indexOf('isValidChatUid(targetId)') < blockSrc.indexOf("'blocks/' + user.uid + '/' + targetId"));
ok('estático: breakFollowRelationsOnBlock valida myUid y targetId',
  /isValidChatUid\(myUid\)/.test(breakSrc) && /isValidChatUid\(targetId\)/.test(breakSrc));
ok('estático: el gate del sink va ANTES de la primera lectura de followers/',
  breakSrc.indexOf('isValidChatUid(targetId)') < breakSrc.indexOf("db.ref('followers/'"));
ok('estático: confirmSharePost NO lleva gate (decisión D3 documentada: solo lecturas contenidas, escritura ya estrangulada por C191)',
  !/isValidChatUid/.test(shareSrc));

// ---------- conductuales en vm ----------
const INVALID_SEG = /[.#$\[\]\x00-\x1F\x7F]/;
function fullKeys(base, keys) {
  return keys.map(k => (k === '<set>' || k === '<remove>') ? base : (base ? base + '/' + k : k));
}
function validateFull(p) {
  const segs = String(p).split('/').filter(s => s !== '');
  if (!segs.length || segs.some(s => INVALID_SEG.test(s))) throw new Error('RTDB_INVALID_KEY:' + p);
}

function makeCtx() {
  const writes = [], tx = [];
  const refStub = (p) => {
    const base = (p == null ? '' : String(p)); // ref() sin args = raíz (update atómico)
    return {
      once: async () => ({ exists: () => false, val: () => null }),
      update: async (u) => {
        const ks = fullKeys(base, Object.keys(u || {}));
        ks.forEach(validateFull);
        writes.push({ op: 'update', base, keys: Object.keys(u || {}) });
      },
      set: async () => { validateFull(base); writes.push({ op: 'set', base, keys: ['<set>'] }); },
      remove: async () => { validateFull(base); writes.push({ op: 'remove', base, keys: ['<remove>'] }); },
      transactionBlind: async (fn) => { validateFull(base); tx.push(base); },
      push: () => ({ set: async () => {} })
    };
  };
  const sandbox = {
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'u1' } }),
      database: () => ({ ref: refStub })
    },
    document: { querySelectorAll: () => [] },
    showMiniToast: () => {},
    appT: (s) => s,
    askBlockConfirmation: (uname, cb) => { try { cb(); } catch (_) {} },
    closeUserActionsSheet: () => {},
    console
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext('var currentPostOptionsAuthorId = null;\nvar currentPostOptionsAuthorData = null;\nvar blockedAccountsSet = new Set();', ctx);
  vm.runInContext(extractFn(html, 'function isValidChatUid(uid)') + '\nthis.__isValid = isValidChatUid;', ctx);
  vm.runInContext(blockSrc + '\nthis.__block = blockUserFromUserActions;', ctx);
  vm.runInContext(breakSrc + '\nthis.__break = breakFollowRelationsOnBlock;', ctx);
  return { ctx, writes, tx };
}
const allKeys = (writes, tx) =>
  writes.flatMap(w => fullKeys(w.base, w.keys)).concat(tx);

(async () => {
  await tcase('conductual: block con target "foo/bar" -> 0 escrituras y no entra al set local', async () => {
    const { ctx, writes, tx } = makeCtx();
    vm.runInContext('currentPostOptionsAuthorId = "foo/bar"; currentPostOptionsAuthorData = { username: "x" };', ctx);
    vm.runInContext('__block();', ctx);
    await new Promise(r => setTimeout(r, 50));
    const keys = allKeys(writes, tx);
    if (keys.length !== 0) throw new Error('hubo escrituras: ' + keys.join(',').slice(0, 200));
    const inSet = vm.runInContext('Array.from(blockedAccountsSet)', ctx);
    if (inSet.length !== 0) throw new Error('el uid forjado entró al set local');
  });

  await tcase('conductual: breakFollowRelationsOnBlock(u1,"foo/bar") -> 0 escrituras/tx', async () => {
    const { ctx, writes, tx } = makeCtx();
    await vm.runInContext('__break("u1", "foo/bar")', ctx);
    const keys = allKeys(writes, tx);
    if (keys.length !== 0) throw new Error('hubo escrituras: ' + keys.join(',').slice(0, 200));
  });

  await tcase('conductual: breakFollowRelationsOnBlock con myUid forjado -> 0 escrituras', async () => {
    const { ctx, writes, tx } = makeCtx();
    await vm.runInContext('__break("a/b", "alice123")', ctx);
    const keys = allKeys(writes, tx);
    if (keys.length !== 0) throw new Error('hubo escrituras: ' + keys.join(',').slice(0, 200));
  });

  await tcase('conductual: block benigno intacto (set en blocks/u1/alice123 + entra al set)', async () => {
    const { ctx, writes } = makeCtx();
    vm.runInContext('currentPostOptionsAuthorId = "alice123"; currentPostOptionsAuthorData = { username: "alice" };', ctx);
    vm.runInContext('__block();', ctx);
    await new Promise(r => setTimeout(r, 50));
    const keys = writes.flatMap(w => fullKeys(w.base, w.keys));
    if (!keys.includes('blocks/u1/alice123')) throw new Error('falta el set benigno: ' + keys.join(',').slice(0, 160));
    const inSet = vm.runInContext('Array.from(blockedAccountsSet)', ctx);
    if (!inSet.includes('alice123')) throw new Error('el uid benigno no entró al set local');
  });

  await tcase('conductual: break benigno intacto (tombstones de un solo segmento)', async () => {
    const { ctx, writes } = makeCtx();
    await vm.runInContext('__break("u1", "alice123")', ctx);
    const keys = writes.flatMap(w => fullKeys(w.base, w.keys));
    // el mock once() dice que no hay follows: solo los followRequests incondicionales
    if (!keys.includes('followRequests/alice123/u1')) throw new Error('falta tombstone benigna: ' + keys.join(',').slice(0, 160));
    if (keys.some(k => k.split('/').some(s => s.includes('foo')))) throw new Error('fragmento forjado inesperado');
  });

  console.log(failures === 0 ? 'C193 block-uid-gate: TODOS OK' : 'C193 block-uid-gate: ' + failures + ' FALLOS');
  process.exit(failures === 0 ? 0 : 1);
})();
