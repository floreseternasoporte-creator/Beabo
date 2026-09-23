// test-c47-chat-forward.js — reenvío de mensajes de chat (C47-F1, C47-F2).
// C47-F1 (privacidad): reenviar un mensaje viewOnce creaba una copia PERMANENTE
// (el payload nunca llevaba el flag viewOnce) → la promesa "ver una vez" quedaba
// rota. Fix: triggerChatForward bloquea con toast + doForwardMessage tiene guard
// defensivo (fail-closed).
// C47-F2 (funcional): reenviar un mensaje con archivos producía una burbuja VACÍA
// (files nunca se copiaban al payload) y reenviar un post compartido igual
// (type/sharedPost no se copiaban). Fix: se copian las metas de files
// (el contenido vive en chatFiles/<fileId>) y type/sharedPost; preview con
// '📎 Archivo' / '📌 Publicación'.
// Convención: estático + funcional contra el archivo del repo, sin rutas
// absolutas ni historial de git. Los checks SOLO pasan con el fix presente
// (en base fallan: el gate/guard y las copias no existen).
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
check('F1: triggerChatForward bloquea viewOnce con toast',
  /_fwdMsgData\.viewOnce/.test(trig) && /No puedes reenviar un mensaje de ver una vez/.test(trig));
check('F1: doForwardMessage tiene guard defensivo para viewOnce',
  /if\s*\(\s*fwdData\.viewOnce\s*\)/.test(dof));
check('F2: doForwardMessage copia las metas de files',
  /payload\.files\s*=\s*fwdData\.files\.map/.test(dof) && /fileId:\s*f\.fileId/.test(dof));
check('F2b: doForwardMessage copia type/sharedPost',
  /payload\.type\s*=\s*'sharedPost'/.test(dof) && /payload\.sharedPost\s*=\s*fwdData\.sharedPost/.test(dof));
check('F2: preview de lastMessage para archivos y posts compartidos',
  /'📎 Archivo'/.test(dof) && /'📌 Publicación'/.test(dof));
check('F3: doForwardMessage captura el dato ANTES de cerrar el diálogo',
  /const fwdData = _fwdMsgData;/.test(dof));
check('F3: doForwardMessage ya no lee _fwdMsgData después de closeChatForwardDialog()',
  (() => { const after = dof.slice(dof.indexOf('closeChatForwardDialog();')); return !/_fwdMsgData\./.test(after); })());
check('i18n: clave de bloqueo en EN/ZH/PT',
  (i18n.match(/"No puedes reenviar un mensaje de ver una vez\."/g) || []).length === 3);

// ---------- funcional: extraer funciones reales y ejecutarlas ----------
const writes = [];
const toasts = [];
let dialogOpened = false;
const sandbox = {
  console, JSON, Object, Array, Promise, Date, Math, String, Number,
  DrexCloud: {
    auth: () => ({ currentUser: { uid: 'uidA' } }),
    database: () => ({
      ref: (p) => ({
        once: () => Promise.resolve({ val: () => ({ text: 'x', viewOnce: true }), exists: () => true }),
        push: () => ({ key: 'k1', set: (payload) => { writes.push({ path: p, payload }); return Promise.resolve(); } }),
        update: (u) => { writes.push({ path: p, update: u }); return Promise.resolve(); },
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
  // F1 funcional: trigger con mensaje viewOnce → toast + sin diálogo
  vm.runInContext("activeReactionMsgId='m1'; currentChatRoomId='room1';", sandbox);
  vm.runInContext('triggerChatForward();', sandbox);
  await new Promise(r => setTimeout(r, 60));
  check('F1 funcional: trigger bloquea viewOnce (toast, sin diálogo)',
    toasts.some(t => /ver una vez/.test(t)) && !dialogOpened);

  // F1 funcional: doForwardMessage directo con viewOnce → sin writes
  vm.runInContext("_fwdMsgData = { text: 'secreto', viewOnce: true };", sandbox);
  const w0 = writes.length;
  await vm.runInContext("doForwardMessage('convX','uidB')", sandbox);
  check('F1 funcional: doForwardMessage directo con viewOnce no escribe', writes.length === w0);

  // F2 funcional: reenvío de archivo copia files y pone preview
  vm.runInContext("_fwdMsgData = { text: '', files: [{ fileId: 'cf_abc', name: 'a.pdf', size: 10, mime: 'application/pdf', chunks: 2 }] };", sandbox);
  const w1 = writes.length;
  await vm.runInContext("doForwardMessage('convX','uidB')", sandbox);
  const fw = writes.slice(w1);
  check('F2 funcional: payload incluye files (solo metas)',
    fw.length >= 1 && Array.isArray(fw[0].payload.files) && fw[0].payload.files[0].fileId === 'cf_abc');
  check('F2 funcional: payload files NO duplica contenido (solo metas)',
    fw.length >= 1 && fw[0].payload.files && Object.keys(fw[0].payload.files[0]).sort().join(',') === 'chunks,fileId,mime,name,size');
  const upd = fw.find(w => w.update);
  check('F2 funcional: lastMessage = 📎 Archivo',
    !!(upd && upd.update.lastMessage === '📎 Archivo'));

  // F2b funcional: reenvío de post compartido copia type/sharedPost
  vm.runInContext("_fwdMsgData = { text: '', type: 'sharedPost', sharedPost: { noteId: 'n1', kind: 'post', authorName: 'U', content: 'hola' } };", sandbox);
  const w2 = writes.length;
  await vm.runInContext("doForwardMessage('convX','uidB')", sandbox);
  const fw2 = writes.slice(w2);
  check('F2b funcional: payload copia type/sharedPost',
    fw2.length >= 1 && fw2[0].payload.type === 'sharedPost' &&
    fw2[0].payload.sharedPost && fw2[0].payload.sharedPost.noteId === 'n1');

  console.log(`\n${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
