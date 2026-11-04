// C192 — regresión: inviterUid forjado en respondCollabInvite.
//
// HALLAZGO (PoC A1, Chromium real vía CDP): un inviterUid forjado con '/'
// (inyectable vía notificación 'collab_invite'.collabInviterUid o mensaje con
// collabInvite.inviterUid manipulado) llegaba CRUDO a:
//   communityNotes/<n>/collaborators/<forjado>   (anidada en el post real)
//   userCollabs/<forjado>/<n>                    (anidada en el índice)
//   notifications/<forjado>/<push>               (aviso a ruta fantasma)
// ANTES del gate C191. El gate solo cubría el DM y su throw 'invalid-uid'
// quedaba tragado por el try/catch interno: la víctima veía
// "Colaboración aceptada" aunque las escrituras anidadas ya habían ocurrido.
//
// Parche: `if (!isValidChatUid(inviterUid)) return 'noop';` al inicio de
// respondCollabInvite (antes de cualquier lectura/escritura/notificación).
// Contrato intacto: 'ok' | 'resolved' | 'error' | 'noop' (C108); el handler
// re-habilita los botones con 'noop' sin pintar éxito falso.
//
// Test híbrido: asserts estáticos (fallan en base) + conductuales en sandbox
// vm con DrexCloud programable que registra escrituras (FAIL en base, PASS
// con parche). Uso: node tests/test-c192-collab-uid-gate.js [--target=html]
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
  const braceIdx = src.indexOf('{', declIdx);
  let depth = 0;
  for (let i = braceIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(declIdx, i + 1); }
  }
  throw new Error('cierre no encontrado: ' + declLine);
}

// ---------- asserts estáticos (fallan en base) ----------
const fnSrc = extractFn(html, 'async function respondCollabInvite(noteId, inviterUid, accept)');
ok('estático: el gate valida inviterUid con isValidChatUid',
  /isValidChatUid\(inviterUid\)/.test(fnSrc));
ok('estático: el gate va ANTES de la primera escritura de collaborators',
  fnSrc.indexOf('isValidChatUid(inviterUid)') >= 0 &&
  fnSrc.indexOf('isValidChatUid(inviterUid)') < fnSrc.indexOf("/collaborators/' + inviterUid"));
ok('estático: el gate retorna noop (contrato C108, sin éxito falso)',
  /if\s*\(!isValidChatUid\(inviterUid\)\)\s*return 'noop'/.test(fnSrc));

// ---------- conductuales en vm ----------
const INVALID_SEG = /[.#$\[\]\x00-\x1F\x7F]/;
function fullKeys(base, keys) {
  return keys.map(k => (k === '<set>' || k === '<remove>') ? base : (base ? base + '/' + k : k));
}
function validateFull(path) {
  const segs = String(path).split('/').filter(s => s !== '');
  if (!segs.length || segs.some(s => INVALID_SEG.test(s))) throw new Error('RTDB_INVALID_KEY:' + path);
}

function makeCtx(scenario) {
  const writes = [];
  const calls = { toasts: [], markDone: [], notifs: [] };
  const refStub = (p) => {
    const base = (p == null ? '' : String(p)); // ref() sin args = raíz (update atómico)
    return {
    once: async () => {
      if (base.indexOf('/collabInvites/') >= 0) return { val: () => scenario.invite };
      if (base.indexOf('users/') === 0) return { val: () => ({ username: 'tester' }) };
      return { val: () => null };
    },
    update: async (u) => {
      const ks = fullKeys(base, Object.keys(u || {}));
      ks.forEach(validateFull);
      writes.push({ op: 'update', base, keys: Object.keys(u || {}) });
    },
    push: () => ({ set: async (v) => { writes.push({ op: 'push-set', base, keys: ['<set>'] }); } }),
    child: () => ({ set: async () => {}, remove: async () => {} }),
    set: async (v) => { validateFull(base); writes.push({ op: 'set', base, keys: ['<set>'] }); }
  };};
  const sandbox = {
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'u1' } }),
      database: () => ({ ref: refStub })
    },
    showMiniToast: (m) => { calls.toasts.push(String(m)); },
    appT: (s) => s,
    markCollabInviteNotificationsDone: async (nid, st) => { calls.markDone.push([nid, st]); },
    addNotification: async (uid, n) => { calls.notifs.push([uid, n && n.type]); },
    ensureConversationExists: async () => 'c1',
    updateChatConversationPreview: async () => {},
    renderNotificationsList: () => {},
    refreshVisiblePostFeeds: () => {},
    console
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(extractFn(html, 'function isValidChatUid(uid)') + '\nthis.__isValid = isValidChatUid;', ctx);
  vm.runInContext(extractFn(html, 'function getDirectConversationId(uidA, uidB)') + '\nthis.__conv = getDirectConversationId;', ctx);
  vm.runInContext(fnSrc + '\nthis.__respond = respondCollabInvite;', ctx);
  return { ctx, writes, calls };
}
async function runScenario(scenario, inviterUid, accept) {
  const { ctx, writes, calls } = makeCtx(scenario);
  const r = await vm.runInContext(`__respond("note1", ${JSON.stringify(inviterUid)}, ${accept})`, ctx);
  return { result: r, writes, calls };
}
const nestedOf = (writes, frag) => writes.flatMap(w => fullKeys(w.base, w.keys)).filter(k => k.indexOf(frag) >= 0);

(async () => {
  const invite = { status: 'pending' };

  await tcase('conductual: accept con inviterUid "foo/bar" -> noop y 0 escrituras', async () => {
    const { result, writes } = await runScenario({ invite }, 'foo/bar', true);
    if (result !== 'noop') throw new Error('esperaba noop, dio ' + JSON.stringify(result));
    if (writes.length !== 0) throw new Error('hubo escrituras: ' + JSON.stringify(writes).slice(0, 200));
  });

  await tcase('conductual: decline con inviterUid "foo/bar" -> noop y 0 escrituras (ni aviso fantasma)', async () => {
    const { result, writes, calls } = await runScenario({ invite }, 'foo/bar', false);
    if (result !== 'noop') throw new Error('esperaba noop, dio ' + JSON.stringify(result));
    if (writes.length !== 0) throw new Error('hubo escrituras: ' + JSON.stringify(writes).slice(0, 200));
    if (calls.notifs.length !== 0) throw new Error('se intentó notificar al uid forjado');
  });

  await tcase('conductual: accept benigno sigue funcionando (ok + escrituras reales, sin anidar)', async () => {
    const { result, writes } = await runScenario({ invite }, 'alice123', true);
    if (result !== 'ok') throw new Error('esperaba ok, dio ' + JSON.stringify(result));
    if (writes.length === 0) throw new Error('el parche rompió el flujo benigno: 0 escrituras');
    const allKeys = writes.flatMap(w => fullKeys(w.base, w.keys));
    if (!allKeys.some(k => k === 'communityNotes/note1/collaborators/alice123'))
      throw new Error('falta collaborators/alice123: ' + allKeys.join(',').slice(0, 200));
    if (!allKeys.some(k => k === 'userCollabs/alice123/note1'))
      throw new Error('falta userCollabs/alice123/note1');
    if (allKeys.some(k => k.indexOf('foo/bar') >= 0)) throw new Error('fragmento forjado inesperado');
  });

  await tcase('conductual: decline benigno sigue funcionando', async () => {
    const { result } = await runScenario({ invite }, 'alice123', false);
    if (result !== 'ok') throw new Error('esperaba ok, dio ' + JSON.stringify(result));
  });

  await tcase('conductual: base documentada — sin parche el forjado escribe anidado (sanity)', async () => {
    // Este caso solo documenta; el veredicto lo dan los asserts del gate.
    const { ctx } = makeCtx({ invite });
    const hasGate = /isValidChatUid\(inviterUid\)/.test(fnSrc);
    if (!hasGate) console.log('   (info) base sin gate: el flujo forjado llegaría a escribir anidado');
    ok('sanity vm', typeof ctx !== 'undefined');
  });

  console.log(failures === 0 ? 'C192 collab-uid-gate: TODOS OK' : 'C192 collab-uid-gate: ' + failures + ' FALLOS');
  process.exit(failures === 0 ? 0 : 1);
})();
