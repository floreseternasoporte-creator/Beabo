// Test C200 — gate isValidChatUid en _releaseChatFileRef (fileId forjado).
//
// HALLAZGO: _releaseChatFileRef(fileId, msgId) usaba `msg.files[].fileId`
// —valor forjado por el remitente en el payload del mensaje de chat
// (cualquiera que pueda escribir en la conversación)— CRUDO como segmento de
// ruta en ESCRITURAS:
//   ref('chatFiles/' + fileId + '/rel_' + msgId).transaction(...)
//   ref('chatFiles/' + fileId + '/refs').transaction(...)
//   ref('chatFiles/' + fileId).remove()
// Con fileId='peerB/evil', el cliente SIN MODIFICAR de la víctima, al expirar
// el mensaje temporal (_expireChatMessage: ruta countdown y ruta barrido) o
// al abrir el ver-una-vez (openViewOnceMessage → _releaseChatFileRefsOfMsg),
// escribía anidado en chatFiles/peerB/evil/… y el remove() BORRABA el
// subárbol de OTRO archivo (inyección estructural, familia C191–C199).
// PoC en Chromium real: base B1/B2/B4 PWNED → parche 6/6 SAFE.
//
// Parche: `if (!isValidChatUid(fileId)) return;` tras el guarda existente,
// antes de cualquier uso de fileId en rutas.
//
// Test híbrido: asserts estáticos (fallan en base) + conductuales en sandbox
// vm con DrexCloud programable (mock RTDB en memoria con transaction fiel y
// registro de escrituras). FAIL en base, PASS con parche.
// Uso: node tests/test-c200-chatfile-fileid-gate.js [--target=html]
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
function ok(name, cond, extra) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name + (extra ? ' :: ' + extra : '')); }
}
function extractFn(src, declLine) {
  const declIdx = src.indexOf(declLine);
  if (declIdx < 0) throw new Error('declaración no encontrada: ' + declLine);
  let paren = 0, i = src.indexOf('(', declIdx);
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')') { paren--; if (paren === 0) break; }
  }
  let j = src.indexOf('{', i), depth = 0;
  const n = src.length;
  let inStr = null;
  for (; j < n; j++) {
    const c = src[j];
    if (inStr) {
      if (c === '\\') { j++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '`') { inStr = c; continue; }
    if (c === '/' && src[j + 1] === '/') { const k = src.indexOf('\n', j); j = k < 0 ? n : k; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(declIdx, j + 1); }
  }
  throw new Error('cierre no encontrado: ' + declLine);
}

// ---- 1. Estático ------------------------------------------------------------
const relSrc = extractFn(html, 'function _releaseChatFileRef(fileId, msgId) {');
ok('_releaseChatFileRef existe', relSrc.length > 100);
ok('C200: _releaseChatFileRef valida fileId con isValidChatUid',
  relSrc.includes('isValidChatUid(fileId)'));
ok('C200: el gate está ANTES del primer uso de fileId en una ruta',
  relSrc.indexOf('isValidChatUid(fileId)') !== -1 &&
  relSrc.indexOf('isValidChatUid(fileId)') < relSrc.indexOf("'chatFiles/' + fileId"));
ok('C200: el sink sigue escribiendo chatFiles/<fileId>/rel_<msgId> (ruta intacta)',
  relSrc.includes("ref('chatFiles/' + fileId + '/rel_' + msgId)"));
ok('C200: _releaseChatFileRefsOfMsg despacha cada files[].fileId al sink',
  extractFn(html, 'function _releaseChatFileRefsOfMsg(msg, msgId) {')
    .includes('_releaseChatFileRef(f.fileId, msgId)'));

// ---- 2. Conductual ----------------------------------------------------------
function makeCtx() {
  const writes = [];
  const db = {};
  const segs = p => String(p).split('/').filter(s => s.length > 0);
  function get(p) { let n = db; for (const s of segs(p)) { if (n == null || typeof n !== 'object') return undefined; n = n[s]; } return n; }
  function set(p, v) {
    const ss = segs(p); let n = db;
    for (let i = 0; i < ss.length - 1; i++) { if (n[ss[i]] == null || typeof n[ss[i]] !== 'object') n[ss[i]] = {}; n = n[ss[i]]; }
    n[ss[ss.length - 1]] = v;
  }
  function del(p) {
    const ss = segs(p); let n = db;
    for (let i = 0; i < ss.length - 1; i++) { n = n[ss[i]]; if (n == null || typeof n !== 'object') return; }
    delete n[ss[ss.length - 1]];
  }
  const snap = v => ({ exists: () => v !== undefined && v !== null, val: () => (v === undefined || v === null) ? null : JSON.parse(JSON.stringify(v)) });
  function mkRef(rpath) {
    return {
      _p: rpath,
      once: async () => snap(get(rpath)),
      set: async v => { writes.push('set ' + rpath); set(rpath, v); },
      update: async u => { writes.push('update ' + rpath); for (const k of Object.keys(u || {})) set(rpath + '/' + k, u[k]); },
      remove: async () => { writes.push('remove ' + rpath); del(rpath); },
      transaction: fn => {
        const cur = get(rpath);
        let res;
        try { res = fn(cur === undefined ? null : JSON.parse(JSON.stringify(cur))); }
        catch (e) { return Promise.resolve({ committed: false, snapshot: snap(cur) }); }
        if (res === undefined) return Promise.resolve({ committed: false, snapshot: snap(cur) });
        writes.push('txn ' + rpath);
        if (res === null) del(rpath); else set(rpath, res);
        return Promise.resolve({ committed: true, snapshot: snap(res) });
      },
    };
  }
  const sb = {
    console,
    setTimeout, clearTimeout, Promise, JSON, Object, Math, Number,
    // seams documentadas (lección C199): cachés de sesión que la función
    // limpia en try/catch; sin ellas el caso benigno fallaría por
    // ReferenceError (falso PWNED).
    _chatFileMetaCache: {},
    _chatFileDataUrlCache: {},
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'victimZZZ' } }),
      database: () => ({ ref: p => mkRef(String(p)) }),
    },
  };
  vm.createContext(sb);
  const decls = [
    'function isValidChatUid(uid) {',
    'function _releaseChatFileRef(fileId, msgId) {',
    'function _releaseChatFileRefsOfMsg(msg, msgId) {',
    'function _expireChatMessage(conversationId, msgId, msg) {',
  ];
  for (const d of decls) vm.runInContext(extractFn(html, d), sb, { timeout: 10000 });
  return { sb, writes, get };
}

// Ground truth EXPLÍCITO con .test() (lección C198): tras 'chatFiles/', la
// ruta legítima es <un-solo-segmento> + opcional /rel_<msgId> | /refs.
function nestedWrites(writes) {
  return writes
    .map(w => w.split(' ').slice(1).join(' '))
    .filter(k => k.startsWith('chatFiles/'))
    .filter(k => !/^chatFiles\/[^\/]+(\/rel_[^\/]+|\/refs)?$/.test(k));
}

(async () => {
  // T1: benigno — la liberación SÍ ocurre en la ruta de un segmento.
  {
    // Siembra chatFiles/cf_m8x2kq con refs:2 vía el propio mock.
    const { sb, writes, get } = makeCtx();
    const msg = { senderId: 'attacker1', text: 'hola', autoDestroyAt: 1, files: [{ fileId: 'cf_m8x2kq', name: 'f.jpg', size: 10, mime: 'image/jpeg', chunks: 1 }] };
    let threw = null;
    try {
      await vm.runInContext(
        `(async () => {
           await DrexCloud.database().ref('chatFiles/cf_m8x2kq/refs').set(2);
           await DrexCloud.database().ref('chatFiles/cf_m8x2kq/chunk_00000').set('d1');
         })()`,
        sb, { timeout: 15000 });
      writes.length = 0; // descarta la siembra: solo cuentan las escrituras del SUT
      await vm.runInContext(
        `(async () => {
           _expireChatMessage('conv1', 'm1', ${JSON.stringify(msg)});
           await new Promise(r => setTimeout(r, 150));
         })()`,
        sb, { timeout: 15000 });
    } catch (e) { threw = String((e && e.message) || e); }
    const cf = writes.filter(w => w.split(' ').slice(1).join(' ').startsWith('chatFiles/'));
    const nested = nestedWrites(writes);
    ok('T1 benigno: sin throw', threw === null, threw);
    ok('T1 benigno: la liberación SÍ ocurre (txn chatFiles/cf_m8x2kq/rel_m1)',
      cf.includes('txn chatFiles/cf_m8x2kq/rel_m1'), cf.join(';'));
    ok('T1 benigno: refs decrementado 2→1 (protocolo intacto)', get('chatFiles/cf_m8x2kq/refs') === 1, String(get('chatFiles/cf_m8x2kq/refs')));
    ok('T1 benigno: 0 escrituras anidadas', nested.length === 0, nested.join(','));
  }
  // T2: forjado 'peerB/evil' — 0 escrituras anidadas y el subárbol ajeno intacto.
  {
    const { sb, writes, get } = makeCtx();
    const msg = { senderId: 'attacker1', text: 'mira', autoDestroyAt: 1, files: [{ fileId: 'peerB/evil', name: 'x', size: 1, mime: 'image/jpeg', chunks: 1 }] };
    let threw = null;
    try {
      await vm.runInContext(
        `(async () => {
           await DrexCloud.database().ref('chatFiles/peerB/evil/refs').set(1);
           await DrexCloud.database().ref('chatFiles/peerB/evil/chunk_00000').set('TROZO_AJENO');
         })()`,
        sb, { timeout: 15000 });
      writes.length = 0; // descarta la siembra
      await vm.runInContext(
        `(async () => {
           _expireChatMessage('conv1', 'm1', ${JSON.stringify(msg)});
           await new Promise(r => setTimeout(r, 150));
         })()`,
        sb, { timeout: 15000 });
    } catch (e) { threw = String((e && e.message) || e); }
    const nested = nestedWrites(writes);
    ok('T2 forjado: sin throw', threw === null, threw);
    ok("T2 forjado: 0 escrituras anidadas (no 'chatFiles/peerB/evil/…')",
      nested.length === 0, nested.join(','));
    ok('T2 forjado: chatFiles/peerB/evil NO borrado (trozos ajenos intactos)',
      get('chatFiles/peerB/evil/chunk_00000') === 'TROZO_AJENO', JSON.stringify(get('chatFiles/peerB/evil')));
  }
  // T3: forjado profundo 'a/b/c'.
  {
    const { sb, writes } = makeCtx();
    const msg = { senderId: 'attacker1', text: 'mira', autoDestroyAt: 1, files: [{ fileId: 'a/b/c', name: 'x', size: 1, mime: 'image/jpeg', chunks: 1 }] };
    let threw = null;
    try {
      await vm.runInContext(
        `(async () => {
           _expireChatMessage('conv1', 'm1', ${JSON.stringify(msg)});
           await new Promise(r => setTimeout(r, 150));
         })()`,
        sb, { timeout: 15000 });
    } catch (e) { threw = String((e && e.message) || e); }
    const nested = nestedWrites(writes);
    ok('T3 forjado profundo: sin throw', threw === null, threw);
    ok('T3 forjado profundo: 0 escrituras anidadas', nested.length === 0, nested.join(','));
  }
  // T4: ruta ver-una-vez (el despachador exacto que llama openViewOnceMessage).
  {
    const { sb, writes, get } = makeCtx();
    let threw = null;
    try {
      await vm.runInContext(
        `(async () => {
           await DrexCloud.database().ref('chatFiles/v/w/refs').set(1);
           await DrexCloud.database().ref('chatFiles/v/w/chunk_00000').set('AJENO2');
         })()`,
        sb, { timeout: 15000 });
      writes.length = 0; // descarta la siembra
      await vm.runInContext(
        `(async () => {
           _releaseChatFileRefsOfMsg({ senderId: 'attacker1', files: [{ fileId: 'v/w', name: 'x', size: 1, mime: 'image/jpeg', chunks: 1 }] }, 'm9');
           await new Promise(r => setTimeout(r, 150));
         })()`,
        sb, { timeout: 15000 });
    } catch (e) { threw = String((e && e.message) || e); }
    const nested = nestedWrites(writes);
    ok('T4 ver-una-vez: sin throw', threw === null, threw);
    ok('T4 ver-una-vez: 0 escrituras anidadas', nested.length === 0, nested.join(','));
    ok('T4 ver-una-vez: chatFiles/v/w NO borrado',
      get('chatFiles/v/w/chunk_00000') === 'AJENO2', JSON.stringify(get('chatFiles/v/w')));
  }

  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(1); });
