// C235 — test de los fixes de Guardados/Carpetas.
// Uso: node tests/test-c235-saved.js <html-file>
// Extrae el bloque real de guardados del HTML y lo ejecuta en un sandbox
// con una base de datos falsa controlable.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const file = process.argv[2] || require('path').join(__dirname, '..', 'index.html');
const src = fs.readFileSync(file, 'utf8');

// --- extraer el bloque de guardados (funciones reales del HTML)
const startMarker = 'let _userSavedPosts = null;';
const endMarker = '// C231: convierte cualquier error técnico';
const si = src.indexOf(startMarker);
const ei = src.indexOf(endMarker);
assert.ok(si > 0 && ei > si, 'marcadores del bloque de guardados no hallados');
let block = src.slice(si, ei);
// ganchos de inspección (mismo scope)
block += `\n;globalThis.__c235 = {
  get userSavedPosts(){ return _userSavedPosts; },
  set userSavedPosts(v){ _userSavedPosts = v; },
  get userSavedFolders(){ return _userSavedFolders; },
  set userSavedFolders(v){ _userSavedFolders = v; },
  get savePostLocks(){ return _savePostLocks; },
  get folderGen(){ return typeof _savedFolderGen === 'undefined' ? -1 : _savedFolderGen; }
};`;

// --- sandbox
const toasts = [];
let fakeDb = {};
let dbBehavior = {};
let confirmValue = true;
let pushN = 0;
const manualOnces = [];
function makeEl(id) {
  return {
    id, _html: '', children: [], textContent: '', style: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); return c; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    closest() { return null; },
    addEventListener() {}, removeEventListener() {},
  };
}
const elCache = {};
function fakeRef(path) {
  return {
    child: (c) => fakeRef(path + '/' + c),
    once: (ev) => {
      if (dbBehavior.onceManual) return new Promise((res) => dbBehavior.onceManual.push({ path, res }));
      if (dbBehavior.onceFail) return Promise.reject(new Error('net-down'));
      const v = fakeDb[path];
      return Promise.resolve({ val: () => v, exists: () => v !== undefined && v !== null, forEach() {} });
    },
    set: (v) => { fakeDb[path] = v; return Promise.resolve(); },
    update: (u) => {
      if (dbBehavior.updateFail) return Promise.reject(new Error('net-down'));
      for (const k in u) fakeDb[path + '/' + k] = u[k];
      return Promise.resolve();
    },
    remove: () => {
      if (dbBehavior.removeFail) return Promise.reject(new Error('net-down'));
      delete fakeDb[path];
      return Promise.resolve();
    },
    push: () => { const k = 'push' + (++pushN); return { key: k, set: (v) => { fakeDb[path + '/' + k] = v; return Promise.resolve(); } }; },
  };
}
const sandbox = {
  console,
  DrexCloud: {
    auth: () => ({ currentUser: { uid: 'u1' } }),
    database: () => ({ ref: (p) => fakeRef(p) }),
  },
  document: {
    getElementById: (id) => elCache[id] || (elCache[id] = makeEl(id)),
    createElement: (t) => { const e = makeEl('dyn'); e.tagName = t; return e; },
    querySelectorAll: () => [],
    querySelector: () => null,
    body: { classList: { add() {}, remove() {} }, appendChild() {}, parentElement: null },
  },
  showMiniToast: (m) => toasts.push(String(m)),
  appT: (k) => k,
  escapeHtml: (s) => String(s),
  escapeInlineSingleQuote: (s) => String(s),
  getSpinnerMarkup: () => '<spinner>',
  getSafeMediaUrl: (x) => x,
  formatRelativeTime: () => '',
  hydrateIdentitySlots: () => {},
  lockBodyScroll: () => {}, unlockBodyScroll: () => {},
  setBottomNavVisibility: () => {},
  refreshHistorialIfVisible: () => {},
  drexRecTrainById: () => {},
  DREX_REC: { weights: { save: 1 } },
  drexErrFriendly: (e, fb) => fb,
  prompt: () => null,
  confirm: () => confirmValue,
  setTimeout: (fn) => 0, clearTimeout: () => {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(block, sandbox, { filename: 'c235-saved-block.js' });
} catch (e) {
  console.error('ERROR DE SINTAXIS en el bloque extraído:', e.message);
  process.exit(2);
}
const C = (name) => vm.runInContext(name, sandbox);
const G = () => sandbox.__c235;

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed++; console.log('  ✓ ' + name); },
    (e) => { failed++; console.log('  ✗ ' + name + ' — ' + e.message); }
  );
}
async function run() {
  console.log('C235 — tests de guardados (' + file + ')');

  // ---- T1 SAVED-1: fallo de la carga inicial → lock liberado + aviso
  await t('T1 lock liberado tras fallo de carga inicial', async () => {
    fakeDb = {}; dbBehavior = { onceFail: true }; toasts.length = 0;
    G().userSavedPosts = null;
    await C('toggleSavePost')('n1', null).catch(() => {});
    assert.ok(toasts.length > 0, 'debe avisar al usuario');
    assert.ok(!G().savePostLocks.has('n1'), 'el lock debe liberarse');
    dbBehavior = {};
    await C('toggleSavePost')('n1', null);
    assert.ok(fakeDb['savedPosts/u1/n1'], 'el reintento debe guardar en la BD');
  });

  // ---- T2 SAVED-2: deleteSavedFolder — sin mutación optimista ante fallo
  await t('T2 deleteSavedFolder no corrompe el caché si la red falla', async () => {
    fakeDb = {}; dbBehavior = { updateFail: true }; toasts.length = 0;
    G().userSavedFolders = { f1: { name: 'F', createdAt: 1 } };
    G().userSavedPosts = { n1: { savedAt: 1, folderId: 'f1' } };
    confirmValue = true;
    await C('deleteSavedFolder')('f1').catch(() => {});
    assert.strictEqual(G().userSavedPosts.n1.folderId, 'f1', 'folderId local intacto');
    assert.ok(G().userSavedFolders.f1, 'la carpeta sigue en el caché');
    assert.ok(toasts.length > 0, 'debe avisar del fallo');
  });

  // ---- T3 SAVED-3a: lecturas en vuelo de la carpeta anterior no pintan
  await t('T3 lectura en vuelo no pinta tarjetas de otra carpeta', async () => {
    fakeDb = {}; dbBehavior = { onceManual: manualOnces }; toasts.length = 0;
    for (const k in elCache) delete elCache[k];
    G().userSavedPosts = { n1: { savedAt: 1, folderId: 'fA' } };
    C('openSavedFolderContents')('fA'); // lecturas pendientes
    assert.ok(manualOnces.length > 0, 'debe haber lecturas en vuelo');
    const pendingA = manualOnces.splice(0);
    G().userSavedPosts = { n1: { savedAt: 1, folderId: 'fA' }, n2: { savedAt: 2, folderId: 'fB' } };
    C('openSavedFolderContents')('fB'); // cambia de carpeta
    pendingA.forEach(({ res }) => res({ val: () => ({ content: 'hola', authorId: 'a' }), exists: () => true, forEach() {} }));
    await new Promise((r) => setTimeout(r, 20));
    const listEl = sandbox.document.getElementById('saved-posts-list');
    assert.strictEqual(listEl.children.length, 0, 'no debe pintar tarjetas de la carpeta A');
    manualOnces.length = 0;
  });

  // ---- T3b SAVED-3b: post "perdido" de otra carpeta no limpia el caché
  await t('T3b post perdido en vuelo no limpia el caché actual', async () => {
    fakeDb = {}; dbBehavior = { onceManual: manualOnces }; toasts.length = 0;
    for (const k in elCache) delete elCache[k];
    G().userSavedPosts = { n1: { savedAt: 1, folderId: 'fA' } };
    C('openSavedFolderContents')('fA');
    const pendingA = manualOnces.splice(0);
    G().userSavedPosts = { n1: { savedAt: 1, folderId: 'fA' }, n2: { savedAt: 2, folderId: 'fB' } };
    C('openSavedFolderContents')('fB');
    pendingA.forEach(({ res }) => res({ val: () => null, exists: () => false, forEach() {} }));
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(G().userSavedPosts.n1, 'n1 no debe borrarse del caché');
    manualOnces.length = 0;
  });

  // ---- T4 SAVED-5: openSavedPostsView — error visible, no spinner eterno
  await t('T4 fallo de carga muestra error + Reintentar', async () => {
    fakeDb = {}; dbBehavior = { onceFail: true }; toasts.length = 0;
    for (const k in elCache) delete elCache[k];
    G().userSavedPosts = null; G().userSavedFolders = null;
    await C('openSavedPostsView')().catch(() => {});
    const gridEl = sandbox.document.getElementById('saved-folders-grid');
    assert.ok(gridEl._html.includes('Reintentar'), 'debe ofrecer Reintentar');
    assert.ok(!gridEl._html.includes('<spinner>'), 'el spinner debe desaparecer');
  });

  // ---- T5 SAVED-6: removeSavedPost — fallo visible, no silencioso
  await t('T5 removeSavedPost avisa si la red falla', async () => {
    fakeDb = {}; dbBehavior = { removeFail: true }; toasts.length = 0;
    for (const k in elCache) delete elCache[k];
    G().userSavedPosts = { n1: { savedAt: 1, folderId: null } };
    const card = { removed: false, remove() { this.removed = true; } };
    const btnEl = { closest: () => card };
    await C('removeSavedPost')('n1', btnEl).catch(() => {});
    assert.ok(toasts.length > 0, 'debe avisar del fallo');
    assert.ok(!card.removed, 'la tarjeta no debe desaparecer si no se borró');
  });

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
}
run();
