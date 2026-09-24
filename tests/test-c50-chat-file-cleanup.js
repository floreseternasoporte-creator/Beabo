// test-c50-chat-file-cleanup.js — chat/archivos: los trozos de
// `chatFiles/<fileId>` sobrevivían a TODAS las rutas de borrado y los
// adjuntos no enviados se filtraban a otra sala (C50-C1 + C50-C2).
//
// C50-C1 (privacidad): (a) eliminar-para-todos anulaba text/images/gif/sticker
// pero dejaba `files` y los trozos -> el destinatario podía seguir descargando
// el archivo; (b) la expiración de temporales y (c) el consumo de ver-una-vez
// borraban mensaje+pin+reacciones (C49-C1) pero no los trozos -> cualquiera con
// el fileId (ambos participantes lo reciben en el payload) leía el archivo
// "desaparecido" para siempre; (d) el fallo del msgRef.set() tras subir trozos
// dejaba huérfanos de hasta 40 MB por intento.
// Fix: conteo de referencias `chatFiles/<fileId>/refs` (base implícita 1); el
// reenvío (que comparte fileId, C47-F2) suma 1; cada borrado resta 1 con
// `rel_<msgId>` idempotente por mensaje; a 0 se borra el nodo.
//
// C50-C2: `chatFileAttachments` es global y nada lo limpiaba al cerrar/cambiar
// de sala -> un archivo adjuntado en la sala A se enviaba en la sala B.
// Fix: clearChatFileAttachment(dropUploaded); closeChatRoomView,
// openChatRoomFromInbox y openGroupChatRoom la llaman con true.
// Convención: estático + funcional contra el archivo del repo, sin rutas
// absolutas ni historial de git. Los checks SOLO pasan con el fix presente.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repoRoot = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf-8');

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
const rel = extractFn(html, '_releaseChatFileRef');
check('C1: existe _releaseChatFileRef con idempotencia por mensaje (rel_<msgId>)',
  /rel_' \+ msgId/.test(rel) && /\/refs'\)\.transaction/.test(rel));
check('C1: a refs=0 se borra el nodo chatFiles/<fileId> completo',
  /ref\('chatFiles\/' \+ fileId\)\.remove\(\)/.test(rel));
check('C1: se purgan los cachés en memoria del archivo liberado',
  /delete _chatFileMetaCache\[fileId\]/.test(rel) && /delete _chatFileDataUrlCache\[fileId\]/.test(rel));

const clr = extractFn(html, 'clearChatFileAttachment');
check('C2: clearChatFileAttachment acepta dropUploaded y libera no-enviados',
  /function clearChatFileAttachment\(dropUploaded\)/.test(clr) && /_releaseChatFileRef\(a\.fileId, a\.id\)/.test(clr));

for (const [fn, label] of [['closeChatRoomView', 'cerrar'], ['openChatRoomFromInbox', 'abrir DM'], ['openGroupChatRoom', 'abrir grupo']]) {
  const src = extractFn(html, fn);
  check(`C2: ${label} descarta adjuntos de archivo (dropUploaded)`, /clearChatFileAttachment\(true\)/.test(src));
}

const cdl = extractFn(html, '_startMsgCountdown');
// C58-C1: la limpieza de expiración vive en _expireChatMessage; el countdown delega.
const xcm50 = extractFn(html, '_expireChatMessage');
check('C1: la expiración del temporal libera sus archivos (vía _expireChatMessage)',
  /_expireChatMessage\(conversationId, msgId\)/.test(cdl) &&
  !!xcm50 && /_releaseChatFileRefsOfMsg\(_msg, msgId\)/.test(xcm50));
const cvo = extractFn(html, 'openViewOnceMessage');
check('C1: el consumo de ver-una-vez libera los archivos del mensaje',
  /_releaseChatFileRefsOfMsg\(msg, msgId\)/.test(cvo));
const cdel = extractFn(html, 'deleteChatMessageForAll');
check('C1: eliminar-para-todos anula `files` del mensaje',
  /files: null, type: 'deleted'/.test(cdel));
check('C1: eliminar-para-todos libera los archivos del mensaje',
  /_releaseChatFileRefsOfMsg\(msg, msgId\)/.test(cdel));
const cfwd = extractFn(html, 'doForwardMessage');
check('C1: el reenvío suma una referencia por archivo compartido',
  /chatFiles\/' \+ f\.fileId \+ '\/refs'\)\.transactionBlind/.test(cfwd));
const cpush = extractFn(html, '_pushOptimisticChatMessage');
check('C1: el fallo del set() libera los trozos ya subidos (no si el set funcionó)',
  /if \(!_chatSetOk\)/.test(cpush) && /_releaseChatFileRefsOfMsg\(\{ files: \(painted && painted\.fileMetas\)/.test(cpush));

// ---------- funcional: helpers reales en vm con BD falsa ----------
const store = {};
function norm(p) { return String(p).replace(/^\/+|\/+$/g, ''); }
function readNested(p) {
  p = norm(p);
  if (store[p] !== undefined) return store[p];
  const out = {}; let found = false;
  for (const k of Object.keys(store)) {
    if (k === p || k.startsWith(p + '/')) {
      found = true;
      const rel2 = k.slice(p.length + 1).split('/');
      let o = out;
      rel2.forEach((seg, i) => { if (i === rel2.length - 1) o[seg] = store[k]; else o = o[seg] = o[seg] || {}; });
    }
  }
  return found ? out : null;
}
function writeNested(p, v) {
  p = norm(p);
  for (const k of Object.keys(store)) if (k === p || k.startsWith(p + '/')) delete store[k];
  if (v === null || v === undefined) return;
  if (typeof v !== 'object') { store[p] = v; return; }
  (function flat(o, base) {
    const keys = Object.keys(o);
    if (!keys.length) { store[base] = {}; return; }
    keys.forEach(k => {
      const val = o[k];
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) flat(val, base + '/' + k);
      else store[base + '/' + k] = val;
    });
  })(v, p);
}
function makeRef(p) {
  p = norm(p);
  const ref = {
    set(v) { writeNested(p, v); return Promise.resolve(); },
    update(v) {
      const cur = readNested(p);
      const obj = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? { ...cur } : {};
      Object.keys(v).forEach(k => { if (v[k] === null || v[k] === undefined) delete obj[k]; else obj[k] = v[k]; });
      writeNested(p, obj);
      return Promise.resolve();
    },
    remove() {
      for (const k of Object.keys(store)) if (k === p || k.startsWith(p + '/')) delete store[k];
      return Promise.resolve();
    },
    once() {
      const v = readNested(p);
      return Promise.resolve({ val: () => (v === undefined ? null : v), exists: () => v !== null && v !== undefined });
    },
    transaction(fn) {
      return Promise.resolve().then(() => {
        const cur = readNested(p);
        const nv = fn(cur === undefined ? null : cur);
        if (nv === undefined) return { committed: false, snapshot: { val: () => cur } };
        writeNested(p, nv);
        return { committed: true, snapshot: { val: () => nv } };
      });
    },
    transactionBlind(fn) { return ref.transaction(fn); },
  };
  return ref;
}
const sandbox = {
  console,
  _chatFileMetaCache: {},
  _chatFileDataUrlCache: {},
  DrexCloud: { database: () => ({ ref: (p) => makeRef(p) }) },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(extractFn(html, '_releaseChatFileRef') + '\n' + extractFn(html, '_releaseChatFileRefsOfMsg'), sandbox);

async function flush(ticks = 30) {
  for (let i = 0; i < ticks; i++) await new Promise(r => setImmediate(r));
}
function fileKeys(fid) { return Object.keys(store).filter(k => k === 'chatFiles/' + fid || k.startsWith('chatFiles/' + fid + '/')); }

(async () => {
  // refcount: original + reenvío; borrar uno no rompe al otro
  writeNested('chatFiles/cfA/chunk_00000', 'QUJD');
  vm.runInContext(`_releaseChatFileRef('cfA','mOrig')`, sandbox); // simula que hubo reenvío: refs=2
  await flush();
  // (sin reenvío previo, refs implícito 1 -> 0: se borra)
  check('C1: sin reenvíos, liberar la única referencia borra los trozos', fileKeys('cfA').length === 0);

  writeNested('chatFiles/cfB/chunk_00000', 'QUJD');
  await vm.runInContext(`DrexCloud.database().ref('chatFiles/cfB/refs').transactionBlind(c => (Number(c) || 1) + 1)`, sandbox);
  await flush();
  check('C1: el reenvío deja refs=2', readNested('chatFiles/cfB/refs') === 2);
  vm.runInContext(`_releaseChatFileRef('cfB','mOrig')`, sandbox);
  await flush();
  check('C1: borrar el original con reenvío vivo conserva los trozos', fileKeys('cfB').filter(k => /chunk_/.test(k)).length === 1);
  check('C1: …pero ya no la marca de release del otro mensaje', readNested('chatFiles/cfB/rel_mOrig') === true);
  vm.runInContext(`_releaseChatFileRef('cfB','mFwd')`, sandbox);
  await flush();
  check('C1: al liberar la última referencia se borra el nodo completo', fileKeys('cfB').length === 0);

  // idempotencia: el mismo mensaje no descuenta dos veces
  writeNested('chatFiles/cfC/chunk_00000', 'QUJD');
  await vm.runInContext(`DrexCloud.database().ref('chatFiles/cfC/refs').transactionBlind(c => (Number(c) || 1) + 1)`, sandbox);
  await flush();
  vm.runInContext(`_releaseChatFileRef('cfC','mX'); _releaseChatFileRef('cfC','mX')`, sandbox);
  await flush();
  check('C1: doble release del mismo mensaje descuenta una sola vez (trozos intactos)', fileKeys('cfC').filter(k => /chunk_/.test(k)).length === 1);

  // _releaseChatFileRefsOfMsg barre todos los files del mensaje
  writeNested('chatFiles/cfD1/chunk_00000', 'QUJD');
  writeNested('chatFiles/cfD2/chunk_00000', 'QUJD');
  vm.runInContext(`_releaseChatFileRefsOfMsg({files:[{fileId:'cfD1'},{fileId:'cfD2'}]},'mD')`, sandbox);
  await flush();
  check('C1: se liberan todos los archivos del mensaje', fileKeys('cfD1').length === 0 && fileKeys('cfD2').length === 0);
  vm.runInContext(`_releaseChatFileRefsOfMsg({text:'sin files'},'mE'); _releaseChatFileRefsOfMsg(null,'mF')`, sandbox);
  await flush();
  check('C1: mensajes sin files no rompen la liberación', true);

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e); process.exit(2); });
