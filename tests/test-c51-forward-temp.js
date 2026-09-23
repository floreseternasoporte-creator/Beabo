// test-c51-forward-temp.js — reenvío de mensajes temporales (C51-C1).
// C51-C1 (privacidad): reenviar un mensaje con autoDestroyAt (mensajes
// temporales de sala o del temporizador del composer) creaba una copia
// PERMANENTE en la otra sala (el payload nunca llevaba autoDestroyAt) →
// la promesa de "Mensajes temporales" quedaba rota. Misma familia que
// C47-F1 (viewOnce). Fix: triggerChatForward bloquea con toast fail-closed
// + guard defensivo en doForwardMessage (invocación directa).
// Convención: estático + funcional contra el archivo del repo, sin rutas
// absolutas ni historial de git. Los checks SOLO pasan con el fix presente
// (en base fallan: el gate/guard para temporales no existe).
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
const trig = extractFn(html, 'triggerChatForward');
const dof = extractFn(html, 'doForwardMessage');
check('C1: triggerChatForward bloquea autoDestroyAt con toast',
  /_fwdMsgData\.autoDestroyAt/.test(trig) && /No puedes reenviar un mensaje temporal/.test(trig));
check('C1: el bloqueo de temporales es fail-closed (nulla el dato y retorna)',
  (() => {
    const i = trig.indexOf('autoDestroyAt');
    const tail = trig.slice(i, i + 400);
    return /_fwdMsgData\s*=\s*null/.test(tail) && /return;/.test(tail);
  })());
check('C1: el bloqueo de temporales ocurre ANTES de abrir el diálogo',
  trig.indexOf('autoDestroyAt') < trig.indexOf('openChatForwardDialog();'));
check('C1: doForwardMessage tiene guard defensivo para autoDestroyAt',
  /fwdData\.autoDestroyAt/.test(dof));
check('C1: doForwardMessage NO propaga autoDestroyAt al payload del reenvío',
  !/payload\.autoDestroyAt/.test(dof));
check('i18n: clave de bloqueo de temporales en EN/ZH/PT',
  (i18n.match(/"No puedes reenviar un mensaje temporal\."/g) || []).length === 3);

// ---------- funcional ----------
const writes = [];
const toasts = [];
let dialogOpened = false;
const tempMsg = {
  text: 'secreto temporal',
  autoDestroyAt: Date.now() + 3600000,
  files: [{ fileId: 'cf_tmp', name: 'd.pdf', size: 10, mime: 'application/pdf', chunks: 1 }]
};
const sandbox = {
  console, JSON, Object, Array, Promise, Date, Math, String, Number,
  DrexCloud: {
    auth: () => ({ currentUser: { uid: 'uidA' } }),
    database: () => ({
      ref: (p) => ({
        once: () => Promise.resolve({ val: () => tempMsg, exists: () => true }),
        push: () => ({ key: 'k1', set: (payload) => { writes.push({ path: p, payload }); return Promise.resolve(); } }),
        update: (u) => { writes.push({ path: p, update: u }); return Promise.resolve(); },
        transactionBlind: () => ({ catch: () => {} }),
      }),
    }),
  },
  activeReactionMsgId: null, currentChatRoomId: 'room1',
  hideChatReactionPicker: () => {},
  showMiniToast: (t) => { toasts.push(t); },
  appT: (s) => s,
  openChatForwardDialog: () => { dialogOpened = true; },
  closeChatForwardDialog: () => { sandbox._fwdMsgData = null; },
  window: {},
  document: { getElementById: () => null },
};
vm.createContext(sandbox);
vm.runInContext(trig + '\n' + dof, sandbox);

(async () => {
  // trigger con mensaje temporal → toast + sin diálogo
  vm.runInContext("activeReactionMsgId='m1'; currentChatRoomId='room1';", sandbox);
  vm.runInContext('triggerChatForward();', sandbox);
  await new Promise(r => setTimeout(r, 60));
  check('C1 funcional: trigger bloquea temporal (toast, sin diálogo)',
    toasts.some(t => /temporal/.test(t)) && !dialogOpened);

  // doForwardMessage directo con autoDestroyAt → sin writes
  vm.runInContext("_fwdMsgData = { text: 'secreto', autoDestroyAt: Date.now() + 5000 };", sandbox);
  const w0 = writes.length;
  await vm.runInContext("doForwardMessage('convX','uidB')", sandbox);
  check('C1 funcional: doForwardMessage directo con autoDestroyAt no escribe', writes.length === w0);

  // viewOnce sigue bloqueado (regresión de C47-F1)
  vm.runInContext("activeReactionMsgId='m2';", sandbox);
  vm.runInContext('triggerChatForward();', sandbox);
  await new Promise(r => setTimeout(r, 60));
  check('C1 funcional: viewOnce sigue bloqueado (C47-F1 intacto)', !dialogOpened);

  // mensaje normal: el flujo sigue intacto (diálogo se abre)
  sandbox.DrexCloud = {
    auth: () => ({ currentUser: { uid: 'uidA' } }),
    database: () => ({
      ref: (p) => ({
        once: () => Promise.resolve({ val: () => ({ text: 'hola normal' }), exists: () => true }),
        push: () => ({ key: 'k2', set: (payload) => { writes.push({ path: p, payload }); return Promise.resolve(); } }),
        update: (u) => { writes.push({ path: p, update: u }); return Promise.resolve(); },
        transactionBlind: () => ({ catch: () => {} }),
      }),
    }),
  };
  dialogOpened = false;
  vm.runInContext("activeReactionMsgId='m3';", sandbox);
  vm.runInContext('triggerChatForward();', sandbox);
  await new Promise(r => setTimeout(r, 60));
  check('C1 funcional: mensaje normal sí abre el diálogo', dialogOpened);

  console.log(`\n${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
