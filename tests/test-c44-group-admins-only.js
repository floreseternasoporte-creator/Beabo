// CICLO 44 (C44-G1) — toggleGroupAdminsOnly usaba el caché stale
// currentGroupIsAdmin en vez de verifyGroupAdminFresh(false).
//
// Era la ÚNICA mutación de grupo que no seguía el patrón A30 (releer el rol
// del servidor antes de escribir): un admin degradado con el panel abierto
// (caché stale = true) podía accionar el toggle y cambiar el flag
// groupChats/<id>/adminsOnly ("Solo admins escriben") sin ser admin.
//
// El fix hace la función async y consulta verifyGroupAdminFresh(false) antes
// del write, igual que kick/promote/demote/clear/addMember.
//
// Convención del repo: resuelve ../index.html con fallback a ../src/index.html;
// no depende del historial de git; sin rutas absolutas.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function findFile(names) {
  const cands = [];
  for (const n of names) {
    cands.push(path.join(__dirname, '..', n));
    cands.push(path.join(__dirname, '..', 'src', n));
  }
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('no encontrado: ' + names.join(' / '));
}
const html = fs.readFileSync(findFile(['index.html']), 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}

function extractFn(name) {
  const re = new RegExp('(?:async\\s+)?function ' + name + '\\(');
  const mm = re.exec(html);
  if (!mm) throw new Error('ancla no encontrada: ' + name);
  const a = mm.index;
  const j = html.indexOf('{', a);
  let depth = 0, inS = null, esc = false;
  for (let k = j; k < html.length; k++) {
    const c = html[k];
    if (inS) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inS) inS = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inS = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return html.slice(a, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}

const toggleSrc = extractFn('toggleGroupAdminsOnly');
const vgaSrc = extractFn('verifyGroupAdminFresh');

// ---- 1. Estático ------------------------------------------------------------
check('toggleGroupAdminsOnly es async (await al gate)', /^\s*async function toggleGroupAdminsOnly/.test(toggleSrc));
check('toggleGroupAdminsOnly consulta verifyGroupAdminFresh(false)',
  /verifyGroupAdminFresh\s*\(\s*false\s*\)/.test(toggleSrc));
check('el gate va ANTES del write de adminsOnly',
  toggleSrc.indexOf('verifyGroupAdminFresh(false)') < toggleSrc.indexOf('adminsOnly'));
check('ya no usa el caché stale currentGroupIsAdmin como gate',
  !/if\s*\(\s*!currentGroupIsAdmin\s*\)/.test(toggleSrc));
check('verifyGroupAdminFresh relee groupChats/<id> del servidor',
  vgaSrc.includes("ref('groupChats/'") && vgaSrc.includes(".once('value')"));

// ---- 2. Funcional: función REAL en sandbox -----------------------------------
// serverAdmin=false: Bob fue degradado; serverAdmin=true: Bob sigue admin.
function runCase(serverAdmin) {
  const writes = [];
  const toasts = [];
  const serverGroup = serverAdmin
    ? { createdBy: 'alice', admins: { alice: true, bob: true } }
    : { createdBy: 'alice', admins: { alice: true } };
  const ref = p => ({
    once: () => Promise.resolve({
      val: () => (p === 'groupChats/g1' ? serverGroup : null),
      exists: () => p === 'groupChats/g1',
    }),
    set: v => { writes.push({ path: p, value: v }); return Promise.resolve(); },
  });
  const sb = {
    console, setTimeout, clearTimeout, Promise,
    currentChatRoomId: 'g1',
    currentGroupIsAdmin: true, // STALE a propósito en ambos casos
    currentGroupIsCreator: false,
    currentGroupCreatedBy: 'alice',
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'bob' } }),
      database: () => ({ ref }),
    },
    document: { getElementById: () => null },
    showMiniToast: t => toasts.push(t),
    appT: s => s,
  };
  vm.createContext(sb);
  const vgaExpr = vgaSrc.replace(/^async function verifyGroupAdminFresh/, 'async function __vga');
  vm.runInContext('var verifyGroupAdminFresh = (' + vgaExpr + ');', sb, { timeout: 5000 });
  const tglExpr = toggleSrc.replace(/^(async\s+)?function toggleGroupAdminsOnly/, '$1function __tgl');
  vm.runInContext('var toggleGroupAdminsOnly = (' + tglExpr + ');', sb, { timeout: 5000 });
  return (async () => {
    await vm.runInContext('toggleGroupAdminsOnly()', sb, { timeout: 5000 });
    await new Promise(r => setTimeout(r, 120));
    return { writes, toasts };
  })();
}

(async () => {
  const stale = await runCase(false);
  check('admin degradado (caché stale): NO escribe adminsOnly',
    !stale.writes.some(w => w.path === 'groupChats/g1/adminsOnly'));
  check('admin degradado (caché stale): avisa con toast',
    stale.toasts.some(t => /administradores/.test(t)));

  const admin = await runCase(true);
  check('admin real: el toggle escribe adminsOnly',
    admin.writes.some(w => w.path === 'groupChats/g1/adminsOnly'));

  if (failures) { console.error(`\n${failures} checks FAILED`); process.exit(1); }
  console.log('\nAll C44-G1 checks passed');
})();
