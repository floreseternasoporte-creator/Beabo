// test-c52-fiesta-zombie.js — fiesta zombi (C52-F1).
// C52-F1 (Fiestas/expiración): si el anfitrión muere abruptamente (sin
// leaveFiesta), su onDisconnect solo borra su registro de fiestaMembers;
// el status de fiestas/<id> quedaba 'live' PARA SIEMPRE: la tarjeta del
// feed seguía ofreciendo "Unirse" y joinFiesta aceptaba, metiendo usuarios
// en una sala muerta sin anfitrión. Fix: (1) gate de entrada en joinFiesta
// (anfitrión ausente + creada hace >60 s -> rechaza y marca 'ended'
// best-effort; el margen de 60 s cubre la ventana aviso-feed -> registro
// del anfitrión); (2) _fiestaCheckHostAbsent() en el watcher de miembros
// (ausencia continua >90 s -> sale de la sala y marca 'ended'); (3) rearme
// del rastreador en fiestaFullCleanup.
// Convención: estático + funcional contra el archivo del repo, sin rutas
// absolutas ni historial de git. Los checks SOLO pasan con el fix presente
// (en base fallan: el gate y el helper no existen).
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
const join = extractFn(html, 'joinFiesta');
check('C1: joinFiesta tiene el gate de fiesta zombi (anfitrión ausente)',
  /members\[f\.hostId\]/.test(join) && /C52-F1/.test(join));
check('C1: el gate usa createdAt con margen de 60 s (sin falsos positivos al crear)',
  /\(f\.createdAt \|\| 0\)\)\s*>\s*60000/.test(join));
check('C1: el gate marca status ended + markFiestaNotesEnded (best-effort)',
  /fiestas\/' \+ id \+ '\/status'\)\.set\('ended'\)/.test(join) && /markFiestaNotesEnded\(id\)/.test(join));
check('C1: existe _fiestaCheckHostAbsent con umbral de 90 s',
  /function _fiestaCheckHostAbsent\(\)/.test(html) && /_fiestaHostAbsentSince\)\s*>\s*90000/.test(html));
check('C1: el watcher de miembros invoca el reaper y sale de la sala muerta',
  /_fiestaCheckHostAbsent\(\)\)/.test(html) && /leaveFiesta\(true\)/.test(html));
check('C1: fiestaFullCleanup rearma el rastreador',
  /_fiestaHostAbsentSince = 0; \/\/ C52-F1/.test(html));
check('C1: el gate rechaza con return false (no entra a la sala muerta)',
  (() => {
    const i = join.indexOf('members[f.hostId]');
    const tail = join.slice(i, i + 700);
    return /return false;/.test(tail);
  })());

// ---------- funcional ----------
function makeCtx(fiestaDoc, membersMap) {
  const writes = [];
  const toasts = [];
  const calls = [];
  const refFor = (p) => ({
    once: () => {
      if (p === 'fiestas/z1') return Promise.resolve({ val: () => fiestaDoc });
      if (p === 'fiestaKicked/z1/guest1') return Promise.resolve({ exists: () => false });
      if (p === 'fiestaMembers/z1') return Promise.resolve({ val: () => membersMap });
      return Promise.resolve({ val: () => null, exists: () => false });
    },
    set: (v) => { writes.push({ path: p, set: v }); return Promise.resolve({ catch() {} }); },
    update: (v) => { writes.push({ path: p, update: v }); return Promise.resolve({ catch() {} }); },
    remove: () => { writes.push({ path: p, remove: true }); return Promise.resolve({ catch() {} }); },
    push: () => ({}),
    child: (c) => refFor(p + '/' + c),
    onDisconnect: () => ({ remove() {}, cancel() {} }),
  });
  const sandbox = {
    console, JSON, Object, Array, Promise, Date, Math, String, Number, setTimeout,
    DrexCloud: { auth: () => ({ currentUser: { uid: 'guest1' } }), database: () => ({ ref: refFor }) },
    document: { getElementById: () => null, visibilityState: 'visible' },
    showMiniToast: (t) => { toasts.push(t); },
    appT: (s) => s,
    fiestaMyProfile: async () => ({ name: 'G', photo: '' }),
    fiestaShowRoom: () => {}, fiestaWatchRoom: () => {}, fiestaEnsureMic: async () => true,
    fiestaPaintControls: () => {}, fiestaSyncPeers: () => {}, _fiestaCancelDisconnect: () => {},
    markFiestaNotesEnded: async (id) => { calls.push('markEnded:' + id); },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    'let fiestaCur = null, fiestaJoining = false, fiestaMyUid = null,' +
    ' fiestaMyRole = "listener", fiestaAmHost = false, fiestaMuted = false,' +
    ' fiestaHostMutedLocal = false, fiestaMembers = {}, fiestaDisconnectHandle = null,' +
    ' fiestaRefs = {}, fiestaPCs = {}, fiestaLocalStream = null, _fiestaHostAbsentSince = 0;',
    ctx);
  vm.runInContext(join, ctx);
  if (/function _fiestaCheckHostAbsent\(/.test(html))
    vm.runInContext(extractFn(html, '_fiestaCheckHostAbsent'), ctx);
  return { ctx, writes, toasts, calls };
}

(async () => {
  const now = Date.now();
  const noHost = { guestX: { name: 'X', role: 'listener' } };
  const withHost = { host1: { name: 'H', role: 'speaker' } };

  // Fiesta zombi vieja: se rechaza la entrada y se marca terminada.
  {
    const { ctx, writes, toasts, calls } = makeCtx(
      { status: 'live', hostId: 'host1', createdAt: now - 120000, maxSpeakers: 6 }, noHost);
    const r = await vm.runInContext('joinFiesta("z1", false)', ctx);
    check('F1: fiesta zombi vieja -> joinFiesta devuelve false', r === false);
    check('F1: toast "Esta fiesta ya terminó."', toasts.some(t => t.includes('Esta fiesta ya terminó.')));
    check('F1: marca fiestas/z1/status = ended', writes.some(w => w.path === 'fiestas/z1/status' && w.set === 'ended'));
    check('F1: markFiestaNotesEnded caduca las tarjetas del feed', calls.includes('markEnded:z1'));
  }

  // Fiesta recién creada: el margen de 60 s evita falsos positivos.
  {
    const { ctx, toasts } = makeCtx(
      { status: 'live', hostId: 'host1', createdAt: now - 10000, maxSpeakers: 6 }, noHost);
    const r = await vm.runInContext('joinFiesta("z1", false)', ctx);
    check('F2: fiesta fresca sin anfitrión aún -> entra (gracia 60 s)', r === true);
    check('F2: sin toast de terminada', toasts.length === 0);
  }

  // Anfitrión presente: sin cambios.
  {
    const { ctx } = makeCtx(
      { status: 'live', hostId: 'host1', createdAt: now - 120000, maxSpeakers: 6 }, withHost);
    const r = await vm.runInContext('joinFiesta("z1", false)', ctx);
    check('F3: anfitrión presente -> entra', r === true);
  }

  // Reaper: ausencia continua del anfitrión.
  if (/function _fiestaCheckHostAbsent\(/.test(html)) {
    const { ctx } = makeCtx({ status: 'live', hostId: 'host1', createdAt: now - 120000 }, noHost);
    vm.runInContext('fiestaCur = { id: "z1", data: { hostId: "host1" } }; fiestaAmHost = false; fiestaMembers = { guestX: {} };', ctx);
    check('F4: 1ª detección de ausencia -> false (inicia el temporizador)',
      vm.runInContext('_fiestaCheckHostAbsent()', ctx) === false);
    vm.runInContext('_fiestaHostAbsentSince = Date.now() - 91000;', ctx);
    check('F4: ausente 91 s -> true (sala zombi)',
      vm.runInContext('_fiestaCheckHostAbsent()', ctx) === true);
    vm.runInContext('fiestaMembers = { host1: {} }; _fiestaHostAbsentSince = 0;', ctx);
    check('F4: anfitrión de vuelta -> false (rearme)',
      vm.runInContext('_fiestaCheckHostAbsent()', ctx) === false);
  } else {
    check('F4: helper presente', false);
  }

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
