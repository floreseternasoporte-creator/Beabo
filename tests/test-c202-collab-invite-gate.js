// C202 — regresión: authorId forjado en inviteCollabFromOptions.
//
// HALLAZGO (PoC C1/C2, Chromium real vía CDP): `authorId` (= note.authorId ||
// note.userId, VALOR del payload del servidor) llegaba CRUDO como segmento de
// ruta en la escritura:
//   communityNotes/<noteId>/collabInvites/<authorId>   (.set de la invitación)
// La VÍCTIMA es el operador de drexcreators: abre las opciones del post del
// atacante y toca "Colaborar" → su cliente escribía collabInvites/a/b/c
// anidado (inyección estructural). Los efectos colaterales ya estaban
// cerrados: addNotification tiene gate C201 (el aviso no sale) y
// ensureConversationExists/getDirectConversationId gate C191 (sin DM); el
// .set() de la invitación era el único sumidero sin gate.
//
// Parche: `if (!isValidChatUid(authorId)) return;` al inicio de
// inviteCollabFromOptions (punto único; cubre el .set, el aviso y el DM).
//
// Test híbrido: asserts estáticos (fallan en base) + conductuales en sandbox
// vm con DrexCloud programable que registra escrituras (FAIL en base, PASS
// con parche). Uso: node tests/test-c202-collab-invite-gate.js [--target=html]
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
function extractFn(src, declLine) {
  const declIdx = src.indexOf(declLine);
  if (declIdx < 0) throw new Error('declaración no encontrada: ' + declLine);
  const braceIdx = src.indexOf('{', declIdx);
  let depth = 0;
  for (let i = braceIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(declIdx, i + 1); }
  }
  throw new Error('cierre no encontrado: ' + declLine);
}

// ---------- asserts estáticos (fallan en base) ----------
const fnSrc = extractFn(html, 'async function inviteCollabFromOptions()');
ok('estático: el gate valida authorId con isValidChatUid',
  /isValidChatUid\(authorId\)/.test(fnSrc));
ok('estático: el gate va ANTES de la escritura collabInvites/<authorId>',
  fnSrc.indexOf('isValidChatUid(authorId)') >= 0 &&
  fnSrc.indexOf('isValidChatUid(authorId)') < fnSrc.indexOf("collabInvites/' + authorId"));
ok('estático: el gate retorna temprano sin efectos',
  /if\s*\(!isValidChatUid\(authorId\)\)\s*return;/.test(fnSrc));

// ---------- conductuales en vm ----------
const INVALID_SEG = /[.#$\[\]\x00-\x1F\x7F]/;
function validateFull(p) {
  const segs = String(p).split('/').filter(s => s !== '');
  if (!segs.length || segs.some(s => INVALID_SEG.test(s))) throw new Error('RTDB_INVALID_KEY:' + p);
}

function makeCtx(isDrexCreators) {
  const writes = [];
  const calls = { notifs: [], convos: [] };
  const refStub = (p) => {
    const base = (p == null ? '' : String(p));
    return {
      once: async () => {
        if (base === 'usernames/drexcreators') return { val: () => (isDrexCreators ? 'uOp' : 'otherUid') };
        if (base.indexOf('users/') === 0) return { val: () => ({ username: 'drexcreators', displayName: 'Drex Creators' }) };
        if (base.indexOf('/collabInvites/') >= 0) return { val: () => null };
        return { val: () => null };
      },
      set: async (v) => { validateFull(base); writes.push({ op: 'set', base }); },
      update: async (u) => { writes.push({ op: 'update', base }); },
      push: () => { const k = 'push1'; return { key: k, set: async (v) => { writes.push({ op: 'push-set', base: base + '/' + k }); } }; },
      child: () => ({ set: async () => {}, remove: async () => {} })
    };
  };
  const sandbox = {
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'uOp' } }),
      database: () => ({ ref: refStub })
    },
    showMiniToast: () => {},
    appT: (s) => s,
    closePostOptionsSheet: () => {},
    addNotification: async (uid) => { calls.notifs.push(uid); },
    ensureConversationExists: async () => { calls.convos.push(1); return null; },
    console
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext('let currentPostOptionsNoteId = null;\nlet currentPostOptionsNoteData = null;\n' +
    'let _drexCreatorsUid = null;\nlet _drexCreatorsUidTs = 0;', ctx);
  vm.runInContext(extractFn(html, 'function isValidChatUid(uid)') + '\nthis.__g = isValidChatUid;', ctx);
  vm.runInContext(extractFn(html, 'function getDirectConversationId(uidA, uidB)') + '\nthis.__c = getDirectConversationId;', ctx);
  vm.runInContext(extractFn(html, 'async function getDrexCreatorsUid(forceRefresh)'), ctx);
  vm.runInContext(extractFn(html, 'async function isCurrentUserDrexCreators()'), ctx);
  vm.runInContext(fnSrc + '\nthis.__invite = inviteCollabFromOptions;', ctx);
  return { ctx, writes, calls };
}

async function runScenario(authorId, isDrexCreators) {
  const { ctx, writes, calls } = makeCtx(isDrexCreators);
  await vm.runInContext(
    'currentPostOptionsNoteId = "noteX";\n' +
    'currentPostOptionsNoteData = { authorId: ' + JSON.stringify(authorId) + ', content: "x" };', ctx);
  let threw = null;
  try { await vm.runInContext('this.__invite()', ctx); }
  catch (e) { threw = String((e && e.message) || e).slice(0, 120); }
  return { writes, calls, threw };
}

const collabSets = (writes) => writes.filter(w =>
  w.op === 'set' && w.base.indexOf('communityNotes/noteX/collabInvites/') === 0);

(async () => {
  // 1. benigno: uid de un segmento → la invitación SÍ se escribe (sin regresión)
  {
    const { writes, calls, threw } = await runScenario('creatorUid7x', true);
    const sets = collabSets(writes);
    ok('conductual: benigno escribe collabInvites/<uid> (un segmento)',
      threw === null && sets.length === 1 && sets[0].base === 'communityNotes/noteX/collabInvites/creatorUid7x');
    ok('conductual: benigno dispara el aviso al autor',
      calls.notifs.length === 1 && calls.notifs[0] === 'creatorUid7x');
  }
  // 2. forjado 'a/b/c' → 0 escrituras de invitación y 0 avisos
  {
    const { writes, calls, threw } = await runScenario('a/b/c', true);
    const sets = collabSets(writes);
    const nested = writes.some(w => w.base.split('/').length > 4);
    ok('conductual: forjado a/b/c no escribe invitación', threw === null && sets.length === 0);
    ok('conductual: forjado a/b/c no deja rutas anidadas', !nested);
    ok('conductual: forjado a/b/c no dispara aviso', calls.notifs.length === 0);
  }
  // 3. forjado profundo 'p/q/r/s' → 0 escrituras
  {
    const { writes, calls, threw } = await runScenario('p/q/r/s', true);
    ok('conductual: forjado p/q/r/s no escribe invitación',
      threw === null && collabSets(writes).length === 0 && calls.notifs.length === 0);
  }
  // 4. operador NO drexcreators → sin escritura (comportamiento previo intacto)
  {
    const { writes, threw } = await runScenario('creatorUid7x', false);
    ok('conductual: no-drexcreators no escribe invitación',
      threw === null && collabSets(writes).length === 0);
  }

  console.log(failures === 0 ? 'PASS' : 'FAIL(' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL: ' + (e && e.message)); process.exit(1); });
