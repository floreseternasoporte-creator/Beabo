// C108: regresión — la tarjeta Aceptar/Rechazar de invitación de colaboración
// en el chat pintaba "Colaboración aceptada" aunque la escritura en BD fallara
// (respondCollabInvite tragaba el error y el handler pintaba doneHTML(true)
// incondicionalmente), y los botones quedaban muertos sin reintento.
// Contrato nuevo: respondCollabInvite NUNCA rechaza y devuelve
// 'ok' | 'resolved' | 'error' | 'noop'; el handler solo pinta el estado final
// cuando el resultado no es error, y re-habilita los botones para reintentar.
// Test híbrido: asserts estáticos (fallan en base) + conductuales en sandbox
// vm con un DrexCloud programable.
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
// tcase: las llamadas al núcleo van envueltas en try/catch para que la base
// reporte FAILs limpios en vez de crashear el runner.
function tcase(name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') return r.then(
    () => console.log('ok - ' + name),
    (e) => { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); });
    console.log('ok - ' + name); return Promise.resolve(); }
  catch (e) { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); return Promise.resolve(); }
}
function tcasesync(name, fn) {
  try { fn(); console.log('ok - ' + name); }
  catch (e) { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); }
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

// ---------- asserts estáticos ----------
tcasesync('contrato: retorna ok', () => {
  if (!/async function respondCollabInvite[\s\S]{0,4000}return 'ok'/.test(html)) throw new Error('sin return ok');
});
tcasesync('contrato: retorna error', () => {
  if (!/async function respondCollabInvite[\s\S]{0,4000}return 'error'/.test(html)) throw new Error('sin return error');
});
tcasesync('contrato: retorna resolved', () => {
  if (!/async function respondCollabInvite[\s\S]{0,4000}return 'resolved'/.test(html)) throw new Error('sin return resolved');
});
tcasesync('contrato: retorna noop sin usuario/args', () => {
  if (!/if \(!me \|\| !noteId \|\| !inviterUid\) return 'noop'/.test(html)) throw new Error('sin return noop');
});
tcasesync('handler: re-habilita botones al fallar', () => {
  const i = html.indexOf('const paintCollabResult');
  if (i < 0) throw new Error('paintCollabResult no existe');
  const block = html.slice(i, i + 2200);
  if (!/btns\.forEach\(b => \{ b\.disabled = false; \}\)/.test(block)) throw new Error('sin re-habilitar');
});
tcasesync('handler: no pinta doneHTML incondicional tras await', () => {
  if (/await respondCollabInvite\(invite\.noteId, invite\.inviterUid, true\);\s*\n\s*card\.innerHTML = doneHTML\(true\)/.test(html))
    throw new Error('patrón viejo: pinta aceptada sin verificar');
});
tcasesync('handler: pinta doneHTML(finalAccepted) honesto', () => {
  if (html.indexOf('card.innerHTML = doneHTML(finalAccepted)') < 0) throw new Error('sin doneHTML honesto');
});
tcasesync('resolved: sincroniza notificación con estado real', () => {
  if (!/await markCollabInviteNotificationsDone\(noteId, invite && invite\.status === 'declined' \? 'declined' : 'accepted'\)/.test(html))
    throw new Error('sin sync de notificación en resolved');
});
tcasesync('llamador de notificaciones intacto', () => {
  if (html.indexOf('onclick="event.stopPropagation();respondCollabInvite(') < 0) throw new Error('onclick perdido');
});

// ---------- conductuales en vm ----------
function makeCtx(scenario) {
  const calls = { markDone: [], toasts: [] };
  const refStub = (p) => ({
    once: async () => {
      p = String(p == null ? '' : p);
      if (p.indexOf('/collabInvites/') >= 0) {
        if (scenario.inviteReadThrows) throw new Error('net down');
        return { val: () => scenario.invite };
      }
      if (p.indexOf('users/') === 0) return { val: () => ({ username: 'tester' }) };
      return { val: () => null };
    },
    update: async () => { if (scenario.updateThrows) throw new Error('db down'); },
    push: () => ({ set: async () => {} }),
    child: () => ({ set: async () => {}, remove: async () => {} }),
    set: async () => {}
  });
  const sandbox = {
    DrexCloud: {
      auth: () => ({ currentUser: scenario.noUser ? null : { uid: 'u1' } }),
      database: () => ({ ref: refStub })
    },
    showMiniToast: (m) => { calls.toasts.push(String(m)); },
    appT: (s) => s,
    markCollabInviteNotificationsDone: async (nid, st) => { calls.markDone.push([nid, st]); },
    addNotification: async () => {},
    ensureConversationExists: async () => {},
    getDirectConversationId: () => 'c1',
    updateChatConversationPreview: async () => {},
    renderNotificationsList: () => { calls.rendered = true; },
    refreshVisiblePostFeeds: () => {},
    console
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  // C192: respondCollabInvite ahora llama al isValidChatUid real (gate contra
  // inviterUid forjado). El sandbox debe exponer el validador verbatim; el
  // stub de getDirectConversationId se mantiene porque el gate ya rechazó
  // los uids inválidos antes de llegar al DM.
  try {
    vm.runInContext(extractFn(html, 'function isValidChatUid(uid)') + '\nthis.__isValid = isValidChatUid;', ctx);
  } catch (e) { /* base pre-C192: sin validador, los escenarios benignos no lo necesitan */ }
  const fnSrc = extractFn(html, 'async function respondCollabInvite(noteId, inviterUid, accept)');
  // new vm.Script rechaza 'return' a nivel de script: la declaración de
  // función no tiene return suelto, es segura para evaluar directo.
  vm.runInContext(fnSrc + '\nthis.__respond = respondCollabInvite;', ctx);
  return { ctx, calls };
}
async function runScenario(scenario) {
  const { ctx, calls } = makeCtx(scenario);
  const r = await vm.runInContext('__respond("n1","u2",true)', ctx);
  return { result: r, calls };
}

(async () => {
  await tcase('conductual: éxito -> ok', async () => {
    const { result } = await runScenario({ invite: { status: 'pending' } });
    if (result !== 'ok') throw new Error('esperaba ok, dio ' + JSON.stringify(result));
  });
  await tcase('conductual: fallo de escritura -> error (nunca rechaza)', async () => {
    const { result, calls } = await runScenario({ invite: { status: 'pending' }, updateThrows: true });
    if (result !== 'error') throw new Error('esperaba error, dio ' + JSON.stringify(result));
    if (!calls.toasts.some(t => t.indexOf('No se pudo procesar') >= 0)) throw new Error('sin toast de error');
  });
  await tcase('conductual: invitación ya resuelta -> resolved + sync notificación', async () => {
    const { result, calls } = await runScenario({ invite: { status: 'accepted' } });
    if (result !== 'resolved') throw new Error('esperaba resolved, dio ' + JSON.stringify(result));
    if (!calls.markDone.some(c => c[0] === 'n1' && c[1] === 'accepted')) throw new Error('sin sync accepted');
  });
  await tcase('conductual: invitación rechazada en otro lado -> resolved declined', async () => {
    const { result, calls } = await runScenario({ invite: { status: 'declined' } });
    if (result !== 'resolved') throw new Error('esperaba resolved, dio ' + JSON.stringify(result));
    if (!calls.markDone.some(c => c[0] === 'n1' && c[1] === 'declined')) throw new Error('sin sync declined');
  });
  await tcase('conductual: sin usuario -> noop', async () => {
    const { result } = await runScenario({ noUser: true });
    if (result !== 'noop') throw new Error('esperaba noop, dio ' + JSON.stringify(result));
  });
  await tcase('conductual: lectura de invitación falla -> resolved (trata como no disponible)', async () => {
    const { result } = await runScenario({ inviteReadThrows: true });
    if (result !== 'resolved') throw new Error('esperaba resolved, dio ' + JSON.stringify(result));
  });

  console.log(failures === 0 ? 'C108 collab-invite: TODOS OK' : 'C108 collab-invite: ' + failures + ' FALLOS');
  process.exit(failures === 0 ? 0 : 1);
})();
