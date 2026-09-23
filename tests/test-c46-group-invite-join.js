// CICLO 46 (C46-G1) — el enlace de invitación de grupo (?joinGroup=<id>) era un
// callejón sin salida para no-miembros: consumePendingDeepLinks solo abría la
// sala si ya eras miembro; si no, un toast sin forma de unirse, aunque el
// botón promete "Comparte el grupo con un enlace".
//
// El fix agrega joinGroupViaInviteLink: si el grupo existe y no eres miembro,
// te une (members/<uid>, userConversations/<uid>/<gid>, mensaje sistema) y
// abre la sala; si ya eres miembro solo abre; si no existe, toast.
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

function extractFn(name, isAsync) {
  const re = new RegExp((isAsync ? 'async\\s+' : '') + 'function ' + name + '\\(');
  const mm = re.exec(html);
  if (!mm) throw new Error('ancla no encontrada: ' + name);
  const a = mm.index, j = html.indexOf('{', a);
  let depth = 0, inS = null, esc = false;
  for (let k = j; k < html.length; k++) {
    const c = html[k];
    if (inS) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inS) inS = null; continue; }
    if (c === "'" || c === '"' || c === '`') { inS = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (!depth) return html.slice(a, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}

// ---- 1. Estático ------------------------------------------------------------
const joinSrc = extractFn('joinGroupViaInviteLink', true);
check('joinGroupViaInviteLink existe', joinSrc.length > 100);
check('escribe members/<uid> en groupChats', /groupChats\/" \+ groupId \+ "\/members\/" \+ me\.uid/.test(joinSrc) ||
  joinSrc.includes("groupChats/' + groupId + '/members/' + me.uid"));
check('escribe la entrada userConversations', joinSrc.includes('userConversations/'));
check('mensaje sistema "se unió al grupo"', joinSrc.includes('se unió al grupo'));
check('abre la sala tras unirse', joinSrc.includes('openGroupChatRoom(groupId)'));
check('caso ya-miembro abre sin escribir', /members\[me\.uid\]/.test(joinSrc) && joinSrc.includes('openGroupChatRoom(groupId)'));
check('consumePendingDeepLinks delega en joinGroupViaInviteLink',
  extractFn('consumePendingDeepLinks', false).includes('joinGroupViaInviteLink(pendingGroup)'));

function makeDb(groupVal) {
  const writes = [];
  const db = {
    ref: (p) => ({
      once: () => Promise.resolve({
        val: () => {
          if (p === 'groupChats/G1') return groupVal;
          if (p === 'users/u1') return { username: 'ana' };
          return null;
        },
        exists: () => !!groupVal && p === 'groupChats/G1'
      }),
      update: (u) => { writes.push({ type: 'update', updates: u }); return Promise.resolve(); },
      push: (obj) => { writes.push({ type: 'push', path: p, obj }); return { _writePromise: Promise.resolve(), key: 'k1' }; }
    })
  };
  return { writes, db };
}

async function runCase(groupVal) {
  const { writes, db } = makeDb(groupVal);
  const toasts = [];
  let openedRoom = null;
  const store = { drex_pending_join_group: 'G1' };
  const sandbox = {
    console,
    DrexCloud: {
      database: () => db,
      auth: () => ({ currentUser: { uid: 'u1', displayName: 'Ana' } })
    },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; }
    },
    openGroupChatRoom: (id) => { openedRoom = id; },
    openAuthorProfileByUsername: () => {},
    showMiniToast: (m) => { toasts.push(m); },
    appT: (s) => s
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(extractFn('joinGroupViaInviteLink', true) + '\n' + extractFn('consumePendingDeepLinks', false), sandbox);
  vm.runInContext('consumePendingDeepLinks()', sandbox);
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  return { writes, toasts, openedRoom };
}

(async () => {
  // ---- 2. Funcional: no-miembro se une ----
  const r1 = await runCase({ name: 'Grupo X', members: { u9: true } });
  check('no-miembro: escribe members/u1', r1.writes.some(w => w.type === 'update' && w.updates['groupChats/G1/members/u1'] === true));
  check('no-miembro: escribe userConversations/u1/G1 con isGroup', r1.writes.some(w => w.type === 'update' && w.updates['userConversations/u1/G1'] && w.updates['userConversations/u1/G1'].isGroup === true));
  check('no-miembro: mensaje sistema en conversationMessages', r1.writes.some(w => w.type === 'push' && w.path === 'conversationMessages/G1' && w.obj && w.obj.system === true));
  check('no-miembro: abre la sala', r1.openedRoom === 'G1');
  check('no-miembro: sin toast de error', r1.toasts.length === 0);

  // ---- 3. Funcional: ya-miembro abre sin escribir ----
  const r2 = await runCase({ name: 'Grupo X', members: { u1: true } });
  check('miembro: abre la sala sin writes', r2.openedRoom === 'G1' && r2.writes.length === 0 && r2.toasts.length === 0);

  // ---- 4. Funcional: grupo inexistente ----
  const r3 = await runCase(null);
  check('inexistente: toast y sin writes ni sala', r3.toasts.length === 1 && r3.writes.length === 0 && r3.openedRoom === null);

  console.log(failures ? '\nFAIL (' + failures + ')' : '\nOK');
  process.exit(failures ? 1 : 0);
})();
