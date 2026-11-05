// C203 — regresión: teenUid forjado en linkParentalSupervision.
//
// HALLAZGO (PoC C1/C2, Chromium real vía CDP): `data.teenUid` (= VALOR del
// payload del servidor en parentalLinkCodes/<code>, escrito por el dueño del
// código) llegaba CRUDO como segmento de ruta en el update multi-path:
//   updates['users/' + data.teenUid + '/supervisedBy'] = user.uid;
//   updates['users/' + user.uid + '/supervising/' + data.teenUid] = true;
// La VÍCTIMA vincula con un código del atacante: el atacante escribe
// parentalLinkCodes/654321 = { teenUid: 'a/b/c', … } y la víctima teclea
// 654321 → su cliente escribía users/a/b/c/supervisedBy +
// users/<víctima>/supervising/a/b/c anidados (inyección estructural).
//
// Parche: `if (!isValidChatUid(data.teenUid))` tras la expiración → se trata
// como código inválido (se registra el intento, no se escribe nada).
// Nota residual (clase C201, server-side, fuera del repo): con un uid VÁLIDO
// ajeno el gate de segmento no aplica — se necesitaría regla RTDB.
//
// Test híbrido: asserts estáticos (fallan en base) + conductuales en sandbox
// vm con DrexCloud programable que registra escrituras (FAIL en base, PASS
// con parche). Uso: node tests/test-c203-parental-link-gate.js [--target=html]
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
const fnSrc = extractFn(html, 'function linkParentalSupervision() {');
ok('estático: el gate valida data.teenUid con isValidChatUid',
  /isValidChatUid\(data\.teenUid\)/.test(fnSrc));
ok('estático: el gate va ANTES del update multi-path con users/<teenUid>',
  fnSrc.indexOf('isValidChatUid(data.teenUid)') >= 0 &&
  fnSrc.indexOf('isValidChatUid(data.teenUid)') < fnSrc.indexOf("users/' + data.teenUid"));
ok('estático: el gate trata el código forjado como inválido (registra intento)',
  /if\s*\(!isValidChatUid\(data\.teenUid\)\)\s*\{[\s\S]*?recordParentalAttempt\(prev, now\)[\s\S]*?throw new Error\('invalid'\)/.test(fnSrc));

// ---------- conductuales en vm ----------
const INVALID_SEG = /[.#$\[\]\x00-\x1F\x7F]/;
function validateFull(p) {
  const segs = String(p).split('/').filter(s => s !== '');
  if (!segs.length || segs.some(s => INVALID_SEG.test(s))) throw new Error('RTDB_INVALID_KEY:' + p);
}

function makeCtx(codeData) {
  const writes = [];
  const db = {
    'parentalLinkAttempts/victim7x': null,
    'parentalLinkCodes/654321': codeData
  };
  const refStub = (p) => {
    const base = (p == null ? '' : String(p));
    return {
      once: async () => ({ val: () => (base in db ? JSON.parse(JSON.stringify(db[base])) : null), exists: () => (base in db && db[base] != null) }),
      set: async (v) => { validateFull(base); writes.push({ op: 'set', base }); db[base] = v; },
      update: async (u) => {
        const keys = Object.keys(u || {});
        for (const k of keys) validateFull(base ? base + '/' + k : k);
        writes.push({ op: 'update', base, keys: keys.slice() });
      },
      remove: async () => { validateFull(base); writes.push({ op: 'remove', base }); }
    };
  };
  const input = { value: '654321' };
  const errBox = { textContent: '', classList: { add: () => {}, remove: () => {} } };
  const sandbox = {
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'victim7x' } }),
      database: () => ({ ref: refStub })
    },
    document: { getElementById: (id) => id === 'parental-link-code-input' ? input : (id === 'parental-link-error' ? errBox : null) },
    showMiniToast: () => {},
    appT: (s) => s,
    renderSupervisedAccountsList: () => {},
    console
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(extractFn(html, 'function isValidChatUid(uid)') + '\nthis.__g = isValidChatUid;', ctx);
  vm.runInContext(fnSrc + '\nthis.__link = linkParentalSupervision;', ctx);
  return { ctx, writes, errBox };
}

const now = Date.now();
const mkData = (teenUid) => ({ teenUid, createdAt: now - 3600000, expiresAt: now + 23 * 3600000 });
const usersKeys = (writes) => writes.filter(w => w.op === 'update').flatMap(w => w.keys).filter(k => k.indexOf('users/') === 0);
const nestedKeys = (writes) => writes.filter(w => w.op === 'update').flatMap(w => w.keys)
  .filter(k => !/^(users\/[^/]+\/supervisedBy|users\/[^/]+\/supervising\/[^/]+|parentalLinkCodes\/\d{6}|parentalLinkAttempts\/[^/]+)$/.test(k));

async function runScenario(teenUid) {
  const { ctx, writes, errBox } = makeCtx(mkData(teenUid));
  let threw = null;
  try { await vm.runInContext('this.__link()', ctx); }
  catch (e) { threw = String((e && e.message) || e).slice(0, 120); }
  await new Promise(r => setTimeout(r, 300));
  return { writes, errBox, threw };
}

(async () => {
  // 1. benigno: uid de un segmento → vinculación completa (sin regresión)
  {
    const { writes, errBox, threw } = await runScenario('teenUid9x');
    const uk = usersKeys(writes);
    ok('conductual: benigno escribe users/teenUid9x/supervisedBy',
      threw === null && uk.some(k => k === 'users/teenUid9x/supervisedBy'));
    ok('conductual: benigno escribe users/victim7x/supervising/teenUid9x',
      uk.some(k => k === 'users/victim7x/supervising/teenUid9x'));
    ok('conductual: benigno consume el código', writes.some(w => w.op === 'update' && (w.keys || []).some(k => k === 'parentalLinkCodes/654321')));
    ok('conductual: benigno no deja claves anidadas', nestedKeys(writes).length === 0 && errBox.textContent === '');
  }
  // 2. forjado 'a/b/c' → 0 escrituras en users/, intento registrado, mensaje inválido
  {
    const { writes, errBox, threw } = await runScenario('a/b/c');
    ok('conductual: forjado a/b/c no escribe en users/', threw === null && usersKeys(writes).length === 0);
    ok('conductual: forjado a/b/c no deja claves anidadas', nestedKeys(writes).length === 0);
    ok('conductual: forjado a/b/c registra el intento',
      writes.some(w => w.op === 'set' && w.base === 'parentalLinkAttempts/victim7x'));
    ok('conductual: forjado a/b/c muestra código inválido',
      /no existe o ya fue usado/.test(errBox.textContent));
  }
  // 3. forjado profundo 'p/q/r/s' → 0 escrituras en users/
  {
    const { writes, errBox, threw } = await runScenario('p/q/r/s');
    ok('conductual: forjado p/q/r/s no escribe en users/',
      threw === null && usersKeys(writes).length === 0 && nestedKeys(writes).length === 0);
  }
  // 4. teenUid no-string (número) → inválido, sin escrituras
  {
    const { writes, threw } = await runScenario(12345);
    ok('conductual: teenUid numérico no escribe en users/',
      threw === null && usersKeys(writes).length === 0);
  }
  // 5. auto-vinculación (teenUid propio) → sigue rechazada con mensaje propio
  {
    const { writes, errBox, threw } = await runScenario('victim7x');
    ok('conductual: self-link sigue rechazado sin escrituras',
      threw === null && usersKeys(writes).length === 0 && /propia cuenta/.test(errBox.textContent));
  }

  console.log(failures === 0 ? 'PASS' : 'FAIL(' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL: ' + (e && e.message)); process.exit(1); });
