// test-c57-chat-forward-refs.js — chat/reenvío: el incremento de refs de los
// adjuntos compartidos era fire-and-forget (C57-C1).
//
// Flujo del bug: reenviar un mensaje con adjuntos -> msgRef.set() OK ->
// transactionBlind(refs+1) lanzado SIN await -> el usuario borra el original
// para-todos (o cierra la app) antes de que el incremento aterrice ->
// _releaseChatFileRef ve refs=1 -> borra los trozos -> el incremento tardío
// recrea refs=2 SIN trozos: el adjunto del reenvío queda roto para ambos.
// Fix: secuenciar los incrementos con await Promise.all antes de completar el
// reenvío (siguen siendo best-effort: no fallan el reenvío).
//
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
const cfwd = extractFn(html, 'doForwardMessage');
check('C57: el reenvío secuencia los incrementos de refs (await Promise.all)',
  /await Promise\.all\(fwdData\.files\.map/.test(cfwd));
check('C57: los incrementos siguen usando transactionBlind sobre chatFiles/<fileId>/refs',
  /chatFiles\/' \+ f\.fileId \+ '\/refs'\)\.transactionBlind/.test(cfwd));
check('C57: el incremento no falla el reenvío si la transacción falla (best-effort)',
  /try\s*\{[\s\S]*await Promise\.all\(fwdData\.files\.map[\s\S]*\} catch \(_\) \{\}/.test(cfwd));
check('C57: no queda el forEach fire-and-forget original',
  !/fwdData\.files\.forEach\(f => \{\s*\n?\s*if \(f && f\.fileId\) DrexCloud\.database\(\)\.ref\('chatFiles\/' \+ f\.fileId/.test(cfwd));

// ---------- funcional: funciones reales en vm con BD falsa y compuerta ----------
const store = {};
let gateOpen = true;
let gateWaiters = [];
function norm(p) { return String(p).replace(/^\/+|\/+$/g, ''); }
function readNested(p) {
  p = norm(p);
  if (store[p] !== undefined) return store[p];
  const out = {}; let found = false;
  for (const k of Object.keys(store)) {
    if (k === p || k.startsWith(p + '/')) {
      found = true;
      const rel = k.slice(p.length + 1).split('/');
      let o = out;
      rel.forEach((seg, i) => { if (i === rel.length - 1) o[seg] = store[k]; else o = o[seg] = o[seg] || {}; });
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
  return {
    push() {
      const key = 'msgFwd' + Math.random().toString(36).slice(2, 8);
      return { key, set(v) { writeNested(p + '/' + key, v); return Promise.resolve(); } };
    },
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
    transaction(fn) {
      return Promise.resolve().then(() => {
        const cur = readNested(p);
        const nv = fn(cur === undefined ? null : cur);
        if (nv === undefined) return { committed: false };
        writeNested(p, nv);
        return { committed: true, snapshot: { val: () => nv } };
      });
    },
    transactionBlind(fn) {
      // El incremento del reenvío pasa por la compuerta (simula latencia).
      if (/^chatFiles\/[^/]+\/refs$/.test(p) && !gateOpen) {
        return new Promise(res => gateWaiters.push(() => res(makeRef(p).transaction(fn))));
      }
      return makeRef(p).transaction(fn);
    },
  };
}
function openGate() {
  gateOpen = true;
  const w = gateWaiters; gateWaiters = [];
  w.forEach(fn => fn());
}
const sandbox = {
  console,
  _fwdMsgData: null,
  _fwdMsgId: null, // C63-F1
  _fwdSrcConvId: null, // C63-F1
  _chatFileMetaCache: {},
  _chatFileDataUrlCache: {},
  DrexCloud: {
    auth: () => ({ currentUser: { uid: 'uA' } }),
    database: () => ({ ref: (p) => makeRef(p) }),
  },
  closeChatForwardDialog() { sandbox._fwdMsgData = null; sandbox._fwdMsgId = null; sandbox._fwdSrcConvId = null; }, // C63-F1
  showMiniToast() {},
  appT: (s) => s,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  extractFn(html, '_releaseChatFileRef') + '\n' +
  extractFn(html, '_releaseChatFileRefsOfMsg') + '\n' +
  extractFn(html, 'doForwardMessage'),
  sandbox
);
async function flush(ticks = 40) {
  for (let i = 0; i < ticks; i++) await new Promise(r => setImmediate(r));
}
const refsOf = (fid) => readNested('chatFiles/' + fid + '/refs');
const chunksOf = (fid) => Object.keys(store).filter(k => k.startsWith('chatFiles/' + fid + '/chunk_'));

(async () => {
  // El reenvío NO retorna mientras el incremento de refs sigue en vuelo.
  writeNested('chatFiles/f1/chunk_00000', 'QUJD');
  writeNested('chatFiles/f1/chunk_00001', 'REVG');
  vm.runInContext(`_fwdMsgData = { files: [{ fileId: 'f1', name: 'a.pdf', size: 8, mime: 'application/pdf', chunks: 2 }] }`, sandbox);
  gateOpen = false;
  let completedBeforeOpen = false;
  const fwdP = vm.runInContext(`doForwardMessage('convB', 'uidB')`, sandbox);
  fwdP.then(() => { completedBeforeOpen = true; });
  await flush(5);
  check('C57: el reenvío no se completa con el incremento de refs en vuelo', !completedBeforeOpen);
  openGate(); // el incremento aterriza ANTES de que el reenvío retorne
  await fwdP;
  await flush();
  check('C57: al completar el reenvío, refs ya está en 2 (incremento comprometido)', refsOf('f1') === 2);

  // Borrar el original para-todos DESPUÉS del reenvío conserva el adjunto.
  vm.runInContext(`_releaseChatFileRefsOfMsg({ files: [{ fileId: 'f1' }] }, 'mOrig')`, sandbox);
  await flush();
  check('C57: el borrado posterior del original no borra los trozos del reenvío', chunksOf('f1').length === 2);
  check('C57: …y deja refs=1 (solo el reenvío)', refsOf('f1') === 1);

  // Liberar el reenvío sí borra los trozos (ciclo de vida completo).
  vm.runInContext(`_releaseChatFileRef('f1', 'mFwd')`, sandbox);
  await flush();
  check('C57: al liberar la última referencia se borran los trozos', chunksOf('f1').length === 0);

  console.log(`\n${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(3); });
