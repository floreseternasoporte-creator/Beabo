// Test C199 — gate isValidChatUid en fiestaOnSignal (msg.from forjado).
//
// HALLAZGO: fiestaOnSignal(key, msg) usaba `msg.from` —valor forjado por el
// autor de la señal WebRTC en el payload (cualquiera escribe en la bandeja
// fiestaSignals/<sid>/<uid>)— CRUDO como segmento de ruta en
// fiestaSendSignal → ref('fiestaSignals/' + fiestaCur.id + '/' + toUid).
// Con from='peerB/evil', el cliente de la víctima creaba una respuesta
// WebRTC REAL y la escribía en fiestaSignals/<sid>/peerB/evil/<push>
// (inyección estructural: anidado en la bandeja de OTRO miembro).
// PoC en Chromium real: base B1/B2 PWNED → parche 6/6 SAFE.
//
// Parche: `if (!isValidChatUid(from)) { done(); return; }` tras el guarda
// existente, antes de cualquier uso de `from` en rutas.
//
// Test híbrido: asserts estáticos (fallan en base) + conductuales en sandbox
// vm con RTCPeerConnection simulado y DrexCloud programable que registra
// escrituras (FAIL en base, PASS con parche).
// Uso: node tests/test-c199-signal-from-gate.js [--target=html]
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
  let inStr = null, inTpl = 0, inRe = false, prev = '';
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
    prev = c;
  }
  throw new Error('cierre no encontrado: ' + declLine);
}

// ---- 1. Estático ------------------------------------------------------------
const sigSrc = extractFn(html, 'async function fiestaOnSignal(key, msg) {');
ok('fiestaOnSignal existe', sigSrc.length > 100);
ok('C199: fiestaOnSignal valida msg.from con isValidChatUid antes de usarlo en rutas',
  sigSrc.includes('isValidChatUid(from)'));
ok('C199: el gate descarta la señal (done+return) sin llegar a fiestaSendSignal',
  sigSrc.indexOf('isValidChatUid(from)') !== -1 &&
  sigSrc.indexOf('isValidChatUid(from)') < sigSrc.indexOf("fiestaSendSignal(from,"));
ok('C199: fiestaSendSignal sigue construyendo la ruta con toUid (sink intacto)',
  extractFn(html, 'function fiestaSendSignal(toUid, payload) {')
    .includes("ref('fiestaSignals/' + fiestaCur.id + '/' + toUid)"));

// ---- 2. Conductual ----------------------------------------------------------
function makeCtx() {
  const writes = [];
  const refs = [];
  function mkRef(rpath) {
    const ref = {
      _p: rpath,
      child: c => mkRef(rpath ? rpath + '/' + c : String(c)),
      once: async () => ({ exists: () => false, val: () => null }),
      set: async v => { writes.push('set ' + rpath); },
      update: async u => { writes.push('update ' + rpath); },
      remove: async () => { writes.push('remove ' + rpath); },
      push: v => {
        const cp = rpath + '/push_x';
        const c = mkRef(cp); c.key = 'push_x';
        if (v !== undefined) writes.push('push ' + cp);
        return c;
      },
    };
    return ref;
  }
  // RTCPeerConnection simulado: la rama 'offer' lo usa de verdad
  // (signalingState 'stable' salta el guarda de glare; createAnswer resuelve).
  class FakePC {
    constructor() { this.signalingState = 'stable'; this.remoteDescription = null; this._pendingCands = []; }
    async setRemoteDescription(d) { this.remoteDescription = d; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nfake' }; }
    async setLocalDescription(d) { this.localDescription = d; }
    async addIceCandidate() {}
    close() {}
    set onicecandidate(_) {}
  }
  class FakeSessionDesc { constructor(init) { this.type = init.type; this.sdp = init.sdp; } }
  const sb = {
    console,
    setTimeout, clearTimeout, Promise, JSON, Object, Math,
    RTCPeerConnection: FakePC,
    RTCSessionDescription: FakeSessionDesc,
    RTCIceCandidate: class { constructor(c) { Object.assign(this, c); } },
    appT: s => s,
    showMiniToast: () => {},
    FIESTA_DEBUG: false,
    FIESTA_ICE: {},
    fiestaMembers: {},
    fiestaMyUid: 'victimZZZ',
    fiestaPCs: {},
    fiestaEarlyCands: {},
    fiestaLocalStream: null,
    fiestaCur: { id: 'sid9', data: {} },
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'victimZZZ' } }),
      database: () => ({ ref: p => { refs.push(String(p)); return mkRef(String(p)); } }),
    },
  };
  vm.createContext(sb);
  const decls = [
    'function isValidChatUid(uid) {',
    'async function fiestaOnSignal(key, msg) {',
    'function fiestaSendSignal(toUid, payload) {',
    'function fiestaSetupPC(uid, pc) {',
    'function fiestaPeerName(uid) {',
    'function fiestaDbg(t) {',
    'async function fiestaAddCandidate(pc, cand) {',
    'async function fiestaFlushCandidates(pc) {',
  ];
  for (const d of decls) vm.runInContext(extractFn(html, d), sb, { timeout: 10000 });
  return { sb, writes, refs };
}

// Ground truth EXPLÍCITO: tras 'fiestaSignals/<sid>/', la ruta legítima
// tiene exactamente 2 segmentos (uid + pushKey).
function nestedWrites(writes, sid) {
  const prefix = 'fiestaSignals/' + sid + '/';
  return writes
    .map(w => w.split(' ').slice(1).join(' '))
    .filter(k => k.startsWith(prefix))
    .filter(k => k.slice(prefix.length).split('/').length !== 2);
}

async function runOffer(from) {
  const { sb, writes } = makeCtx();
  const msg = { type: 'offer', from, sdp: { type: 'offer', sdp: 'v=0\r\nfake-offer' } };
  let threw = null;
  try {
    await vm.runInContext(
      `(async () => { await fiestaOnSignal('inboxKey1', ${JSON.stringify(msg)}); })()`,
      sb, { timeout: 15000 });
  } catch (e) { threw = String((e && e.message) || e); }
  return { writes, threw };
}

(async () => {
  // T1: benigno — la respuesta SÍ se escribe en la ruta de un segmento.
  {
    const { writes, threw } = await runOffer('peerB');
    const nested = nestedWrites(writes, 'sid9');
    ok('T1 benigno: sin throw', threw === null, threw);
    ok('T1 benigno: la answer se escribe en fiestaSignals/sid9/peerB/push_x',
      writes.includes('set fiestaSignals/sid9/peerB/push_x'), writes.join(';'));
    ok('T1 benigno: 0 escrituras anidadas', nested.length === 0, nested.join(','));
  }
  // T2: forjado 'peerB/evil' — 0 escrituras anidadas.
  {
    const { writes, threw } = await runOffer('peerB/evil');
    const nested = nestedWrites(writes, 'sid9');
    ok('T2 forjado: sin throw', threw === null, threw);
    ok("T2 forjado: 0 escrituras anidadas (no 'peerB/evil/<push>')",
      nested.length === 0, nested.join(','));
    ok('T2 forjado: la señal malformada se descarta sin escribir answer',
      !writes.some(w => w.startsWith('set fiestaSignals/sid9/peerB')), writes.join(';'));
  }
  // T3: forjado profundo 'a/b/c'.
  {
    const { writes, threw } = await runOffer('a/b/c');
    const nested = nestedWrites(writes, 'sid9');
    ok('T3 forjado profundo: sin throw', threw === null, threw);
    ok('T3 forjado profundo: 0 escrituras anidadas', nested.length === 0, nested.join(','));
  }

  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(1); });
