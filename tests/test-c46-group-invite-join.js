// CICLO 46 (C46-G1) — el enlace de invitación de grupo (?joinGroup=<id>) era un
// callejón sin salida para no-miembros: consumePendingDeepLinks solo abría la
// sala si ya eras miembro; si no, un toast sin forma de unirse, aunque el
// botón promete "Comparte el grupo con un enlace".
//
// El fix agrega joinGroupViaInviteLink: si el grupo existe y no eres miembro,
// te une (members/<uid>, userConversations/<uid>/<gid>, mensaje sistema) y
// abre la sala; si ya eres miembro solo abre; si no existe, toast.
//
// SEG (barrido 2026-10-19, carril anti-manipulación): abrir el enlace unía al
// usuario SIN confirmación — un enlace malicioso añadía a la víctima a un
// grupo atacante sin su consentimiento. Ahora el flujo pide confirmación con
// drexConfirm (muestra el nombre del grupo) antes de escribir la membresía;
// si el usuario cancela, no hay writes ni se abre la sala. Fail-closed: sin
// mecanismo de confirmación disponible no se une.
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
check('escribe members/<uid> en groupChats', joinSrc.includes('members/"+me.uid'));
check('escribe la entrada userConversations', joinSrc.includes('userConversations/'));
check('mensaje sistema "se unió al grupo"', joinSrc.includes('se unió al grupo'));
check('abre la sala tras unirse', joinSrc.includes('openGroupChatRoom(groupId)'));
check('caso ya-miembro abre sin escribir', /members\[me\.uid\]/.test(joinSrc) && joinSrc.includes('openGroupChatRoom(groupId)'));
check('consumePendingDeepLinks delega en joinGroupViaInviteLink',
  extractFn('consumePendingDeepLinks', false).includes('joinGroupViaInviteLink(pendingGroup)'));
const _dJ = joinSrc.indexOf('const doJoin');
const _wR = joinSrc.indexOf('members/"+me.uid');
const _cF = joinSrc.indexOf('drexConfirm(');
check('SEG: la escritura de membresía vive dentro de doJoin y solo se invoca tras drexConfirm',
  _dJ > 0 && _wR > _dJ && _cF > _dJ && joinSrc.indexOf('doJoin()', _cF) > _cF && joinSrc.includes('fail-closed'));

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

async function runCase(groupVal, autoConfirm, withConfirmFn) {
  const { writes, db } = makeDb(groupVal);
  const toasts = [];
  const confirms = [];
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
  if (withConfirmFn !== false) sandbox.drexConfirm = (msg, onYes) => { confirms.push(msg); if (autoConfirm) onYes(); };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(extractFn('joinGroupViaInviteLink', true) + '\n' + extractFn('consumePendingDeepLinks', false), sandbox);
  vm.runInContext('consumePendingDeepLinks()', sandbox);
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  return { writes, toasts, openedRoom, confirms };
}

(async () => {
  // ---- 2. Funcional: no-miembro confirma y se une ----
  const r1 = await runCase({ name: 'Grupo X', members: { u9: true } }, true);
  check('no-miembro: se muestra confirmación con el nombre del grupo',
    r1.confirms.length === 1 && r1.confirms[0].includes('Grupo X'));
  check('no-miembro confirma: escribe members/u1', r1.writes.some(w => w.type === 'update' && w.updates['groupChats/G1/members/u1'] === true));
  check('no-miembro confirma: escribe userConversations/u1/G1 con isGroup', r1.writes.some(w => w.type === 'update' && w.updates['userConversations/u1/G1'] && w.updates['userConversations/u1/G1'].isGroup === true));
  check('no-miembro confirma: mensaje sistema en conversationMessages', r1.writes.some(w => w.type === 'push' && w.path === 'conversationMessages/G1' && w.obj && w.obj.system === true));
  check('no-miembro confirma: abre la sala', r1.openedRoom === 'G1');
  check('no-miembro confirma: sin toast de error', r1.toasts.length === 0);

  // ---- 3. Funcional: no-miembro cancela -> sin writes ni sala ----
  const r1b = await runCase({ name: 'Grupo X', members: { u9: true } }, false);
  check('no-miembro cancela: se pidió confirmación', r1b.confirms.length === 1);
  check('no-miembro cancela: cero writes', r1b.writes.length === 0);
  check('no-miembro cancela: no abre la sala', r1b.openedRoom === null);
  check('no-miembro cancela: sin toast de error', r1b.toasts.length === 0);

  // ---- 4. Funcional: ya-miembro abre sin escribir ni confirmar ----
  const r2 = await runCase({ name: 'Grupo X', members: { u1: true } }, true);
  check('miembro: abre la sala sin writes ni confirmación', r2.openedRoom === 'G1' && r2.writes.length === 0 && r2.confirms.length === 0 && r2.toasts.length === 0);

  // ---- 5. Funcional: grupo inexistente ----
  const r3 = await runCase(null, true);
  check('inexistente: toast y sin writes ni sala ni confirmación', r3.toasts.length === 1 && r3.writes.length === 0 && r3.openedRoom === null && r3.confirms.length === 0);

  // ---- 6. SEG: fail-closed sin mecanismo de confirmación ----
  const r4 = await runCase({ name: 'Grupo X', members: { u9: true } }, true, false);
  check('sin drexConfirm: cero writes (fail-closed)', r4.writes.length === 0);
  check('sin drexConfirm: no abre la sala', r4.openedRoom === null);

  console.log(failures ? '\nFAIL (' + failures + ')' : '\nOK');
  process.exit(failures ? 1 : 0);
})();
