/* ================================================================
 * C63-F1: el reenvío debe verificar que el mensaje original siga vivo
 * ANTES de compartir sus fileIds por referencia.
 *
 * Defecto (base, PoC S1): `doForwardMessage()` capturaba `_fwdMsgData` al
 * abrir el diálogo de destino, pero entre la apertura y el envío el
 * original podía desaparecer (borrado para todos en otra pestaña/sesión
 * con el diálogo obsoleto, o red lenta + borrado impaciente). El reenvío
 * copiaba igual los fileIds, pero los trozos ya habían sido liberados por
 * el refcount -> la copia nacía con el adjunto roto en silencio (y el
 * incremento de refs dejaba refs=2 fantasma sin trozos).
 *
 * Fix: `triggerChatForward()` fija `_fwdMsgId`/`_fwdSrcConvId` y
 * `doForwardMessage()` re-lee el original antes de escribir nada; si está
 * eliminado/ausente aborta con aviso honesto (fail-closed). La lectura es
 * best-effort (S3): si la red falla se intenta igual que antes.
 *
 * Alcance deliberado: el chequeo cierra el caso demostrado (el original
 * YA estaba borrado al enviar). Un borrado que caiga exactamente entre el
 * set() y el incremento de refs (C57) seguiría dejando refs fantasma;
 * cerrarlo exigiría reordenar acquire->set con rollback o transacciones
 * sobre el nodo padre (descargaría los trozos en cada reenvío) — fuera del
 * alcance de un fix pequeño y seguro. Queda documentado en el log.
 *
 * Extrae las funciones REALES de ../index.html (sin rutas absolutas ni git).
 * Ejecutar con: node tests/test-c63-forward-ref-freshness.js
 * Con BASE_POC=1 se omiten los checks estáticos (para el PoC en la base).
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Extracción por balanceo de llaves (respeta strings y comentarios).
function extractFn(src, name) {
  const m = new RegExp('(async\\s+)?function ' + name + '\\s*\\(').exec(src);
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

/* ---------- Checks estáticos sobre el código real ---------- */
// (se omiten con BASE_POC=1 para el PoC contra la base sin fix)
const BASELINE = process.env.BASE_POC === '1';
if (!BASELINE) {
// 1. triggerChatForward fija los ids del original al abrir el diálogo.
const triggerSrc = extractFn(HTML, 'triggerChatForward');
assert(/_fwdMsgId\s*=\s*msgId/.test(triggerSrc), 'triggerChatForward debe fijar _fwdMsgId');
assert(/_fwdSrcConvId\s*=\s*currentChatRoomId/.test(triggerSrc), 'triggerChatForward debe fijar _fwdSrcConvId');
// 2. closeChatForwardDialog los limpia (no reusar ids obsoletos).
const closeSrc = extractFn(HTML, 'closeChatForwardDialog');
assert(/_fwdMsgId\s*=\s*null/.test(closeSrc), 'closeChatForwardDialog debe limpiar _fwdMsgId');
assert(/_fwdSrcConvId\s*=\s*null/.test(closeSrc), 'closeChatForwardDialog debe limpiar _fwdSrcConvId');
// 3. doForwardMessage re-verifica el original antes de escribir.
const fwdSrc = extractFn(HTML, 'doForwardMessage');
assert(/conversationMessages\/'\s*\+\s*fwdSrcConvId\s*\+\s*'\/'\s*\+\s*fwdMsgId/.test(fwdSrc),
  'doForwardMessage debe re-leer el mensaje original');
assert(/ov\.deletedForAll/.test(fwdSrc), 'doForwardMessage debe detectar el borrado para todos');
assert(/El mensaje original fue eliminado\./.test(fwdSrc), 'doForwardMessage debe avisar con la clave i18n');
console.log('OK  estaticos: trigger fija ids, close los limpia, doForward re-verifica');
}

/* ---------- DrexCloud falso ---------- */
const failReads = new Set(); // paths cuya lectura once() debe fallar (red caída)
const db = {};
function segs(p) { return p.split('/').filter(Boolean); }
function dbGet(p) {
  let n = db;
  for (const s of segs(p)) { if (n == null || typeof n !== 'object') return undefined; n = n[s]; }
  return n;
}
function dbSet(p, v) {
  const ss = segs(p); let n = db;
  for (let i = 0; i < ss.length - 1; i++) { if (typeof n[ss[i]] !== 'object' || n[ss[i]] === null) n[ss[i]] = {}; n = n[ss[i]]; }
  n[ss[ss.length - 1]] = v;
}
function dbRemove(p) {
  const ss = segs(p); let n = db;
  for (let i = 0; i < ss.length - 1; i++) { if (typeof n[ss[i]] !== 'object' || n[ss[i]] === null) return; n = n[ss[i]]; }
  delete n[ss[ss.length - 1]];
}
function dbUpdate(p, o) {
  const cur = dbGet(p);
  dbSet(p, Object.assign({}, (cur && typeof cur === 'object') ? cur : {}, o));
}
const snapOf = v => ({ val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))), exists: () => v !== undefined });

let pushCtr = 0;
function fakeRef(path) {
  const ref = {
    key: segs(path).pop(),
    child: c => fakeRef(path + '/' + c),
    push() { pushCtr++; return fakeRef(path + '/k' + pushCtr); },
    set(v) { return Promise.resolve().then(() => { dbSet(path, v); }); },
    update(o) { return Promise.resolve().then(() => { dbUpdate(path, o); }); },
    remove() { return Promise.resolve().then(() => { dbRemove(path); }); },
    once() {
      if (failReads.has(path)) return Promise.reject(new Error('simulated network failure'));
      return Promise.resolve(snapOf(dbGet(path)));
    },
    _txn(fn, blind) {
      return Promise.resolve().then(() => {
        const cur = dbGet(path);
        const r = fn(cur === undefined ? null : cur);
        if (r === undefined) return { committed: false, snapshot: snapOf(null) };
        if (r === null) dbRemove(path); else dbSet(path, r);
        return { committed: true, snapshot: blind ? null : snapOf(dbGet(path)) };
      });
    },
    transaction(fn, cb) { const p = this._txn(fn, false); if (cb) p.then(r => cb(null, r.committed, r.snapshot)); return p; },
    transactionBlind(fn, cb) { const p = this._txn(fn, true); if (cb) p.then(r => cb(null, r.committed, r.snapshot)); return p; },
  };
  return ref;
}
const toasts = [];
const sandbox = {
  console,
  DrexCloud: {
    auth: () => ({ currentUser: { uid: 'u1' } }),
    database: () => ({ ref: p => fakeRef(p) }),
  },
  document: { getElementById: () => ({ classList: { add() {}, remove() {} } }) },
  showMiniToast: m => { toasts.push(String(m)); },
  appT: s => s,
  setTimeout, clearTimeout, Promise,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const PRELUDE = 'let _fwdMsgData = null;\nlet _fwdMsgId = null;\nlet _fwdSrcConvId = null;\n';
const CODE = PRELUDE + ['isValidChatUid', 'doForwardMessage', 'closeChatForwardDialog', '_releaseChatFileRefsOfMsg', '_releaseChatFileRef'] // C200: isValidChatUid = dependencia transitiva del parche
  .map(n => extractFn(HTML, n)).join('\n');
vm.runInContext(CODE, sandbox, { filename: 'fwd-under-test.js' });

function resetDb() { for (const k of Object.keys(db)) delete db[k]; toasts.length = 0; pushCtr = 0; failReads.clear(); }
function seedFileMessage(conv, msgId, fileId) {
  // Mensaje con adjunto + trozos + refs implícito (=1, sin nodo refs).
  const files = [{ fileId, name: 'a.bin', size: 10, mime: 'application/octet-stream', chunks: 2 }];
  dbSet('conversationMessages/' + conv + '/' + msgId,
    { senderId: 'u1', timestamp: 1, text: 'hola', files });
  dbSet('chatFiles/' + fileId + '/chunk_00000', 'DATOS0');
  dbSet('chatFiles/' + fileId + '/chunk_00001', 'DATOS1');
  return files;
}
function setFwdContext(files, msgId, conv) {
  vm.runInContext(
    `_fwdMsgData = ${JSON.stringify({ text: 'hola', files })}; _fwdMsgId = ${JSON.stringify(msgId)}; _fwdSrcConvId = ${JSON.stringify(conv)};`,
    sandbox);
}
function convBMessages() {
  const c = dbGet('conversationMessages/convB');
  return c && typeof c === 'object' ? Object.values(c) : [];
}
function chunksLive(fileId) { return dbGet('chatFiles/' + fileId + '/chunk_00000') !== undefined; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function flushNet(n = 6) { for (let i = 0; i < n; i++) await sleep(10); }
// Reproduce la ruta de borrado de deleteChatMessageForAll (datos + release + lápida).
async function deleteOriginalForAll(conv, msgId) {
  const snap = await fakeRef('conversationMessages/' + conv + '/' + msgId).once('value');
  vm.runInContext(`_releaseChatFileRefsOfMsg(${JSON.stringify(snap.val())}, ${JSON.stringify(msgId)})`, sandbox);
  await fakeRef('conversationMessages/' + conv + '/' + msgId)
    .update({ deletedForAll: true, text: '', files: null, type: 'deleted' });
  await flushNet();
}

(async () => {
  /* ===== S1: el original se borra ANTES del envío (diálogo obsoleto) ===== */
  resetDb();
  const files1 = seedFileMessage('convA', 'msgM', 'f1');
  setFwdContext(files1, 'msgM', 'convA');
  await deleteOriginalForAll('convA', 'msgM');
  assert(!chunksLive('f1'), 'S1: el borrado debió liberar los trozos');
  await vm.runInContext('doForwardMessage("convB","u2")', sandbox);
  await flushNet();
  assert.strictEqual(convBMessages().length, 0,
    'S1: con el original eliminado el reenvío NO debe crearse (adjunto nacería roto)');
  assert(toasts.some(t => t.includes('El mensaje original fue eliminado.')),
    'S1: debe avisar con honestidad en vez de fallar en silencio');
  console.log('OK  S1 dialogo obsoleto: reenvío abortado con aviso, sin adjunto roto');

  /* ===== S2: ruta feliz intacta (el fix no rompe el reenvío normal) ===== */
  resetDb();
  const files2 = seedFileMessage('convA', 'msgM2', 'f2');
  setFwdContext(files2, 'msgM2', 'convA');
  await vm.runInContext('doForwardMessage("convB","u2")', sandbox);
  await flushNet();
  const msgs = convBMessages();
  assert.strictEqual(msgs.length, 1, 'S2: el reenvío normal debe crearse');
  assert.strictEqual(msgs[0].files[0].fileId, 'f2', 'S2: el reenvío referencia el fileId');
  assert.strictEqual(msgs[0].forwarded, true, 'S2: marca forwarded');
  assert(chunksLive('f2'), 'S2: los trozos siguen vivos');
  assert.strictEqual(dbGet('chatFiles/f2/refs'), 2, 'S2: refs=2 (original + reenvío)');
  assert.strictEqual(dbGet('conversations/convB/lastMessage'), '📎 Archivo', 'S2: preview de la conversación');
  assert.strictEqual(toasts.length, 0, 'S2: sin toasts en la ruta feliz');
  console.log('OK  S2 ruta feliz: reenvío creado, refs=2, trozos vivos, preview ok');

  /* ===== S3: la verificación es best-effort (si la red falla, se intenta igual) ===== */
  resetDb();
  const files3 = seedFileMessage('convA', 'msgM3', 'f3');
  setFwdContext(files3, 'msgM3', 'convA');
  failReads.add('conversationMessages/convA/msgM3'); // la lectura de frescura falla
  await vm.runInContext('doForwardMessage("convB","u2")', sandbox);
  await flushNet();
  assert.strictEqual(convBMessages().length, 1,
    'S3: si la verificación no puede leer, el reenvío debe intentarse (best-effort, como antes)');
  assert(chunksLive('f3'), 'S3: los trozos siguen vivos');
  console.log('OK  S3 best-effort: sin lectura de red el reenvío procede como antes');

  console.log('PASS test-c63-forward-ref-freshness');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
