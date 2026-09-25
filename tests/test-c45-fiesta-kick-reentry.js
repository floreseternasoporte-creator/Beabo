// CICLO 45 (C45-F1) — joinFiesta no respetaba la lista de expulsados.
// fiestaKickMember escribe fiestaKicked/<id>/<uid>, pero el gate solo existía
// en fiestaReassertMembership (para quien ya estaba dentro): un expulsado
// volvía a tocar "Unirse" y reentraba al instante.
//
// El fix lee fiestaKicked/<id>/<uid> en joinFiesta antes de escribir la
// membresía: si existe, toast 'Fuiste expulsado de la fiesta.' y return false.
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

const jfSrc = extractFn('joinFiesta');
// C196: joinFiesta ahora depende de isValidChatUid (gate de forma del id);
// se inyecta la función REAL en el sandbox.
const vcuSrc = extractFn('isValidChatUid');

// ---- 1. Estático ------------------------------------------------------------
check('joinFiesta lee fiestaKicked/<id>/<uid>', /fiestaKicked\//.test(jfSrc));
check('el gate de expulsados va ANTES de escribir la membresía',
  jfSrc.indexOf('fiestaKicked/') >= 0 &&
  jfSrc.indexOf('fiestaKicked/') < jfSrc.indexOf("child(user.uid).set("));
check('expulsado: avisa con el toast de expulsión',
  /Fuiste expulsado de la fiesta/.test(jfSrc));

// ---- 2. Funcional: función REAL en sandbox -----------------------------------
function runCase(kicked) {
  const writes = [], toasts = [], reads = [];
  const server = {
    // C52-F1: las fiestas reales siempre llevan createdAt (createFiesta lo
    // escribe); sin él, el gate zombi trataría la sala como antiquísima.
    'fiestas/f1': { status: 'live', hostId: 'alice', createdAt: Date.now(), maxSpeakers: 6 },
    'fiestaMembers/f1': {},
  };
  if (kicked) server['fiestaKicked/f1/bob'] = { at: Date.now(), by: 'alice' };
  const ref = p => ({
    once: () => { reads.push(p); const v = Object.prototype.hasOwnProperty.call(server, p) ? server[p] : null;
      return Promise.resolve({ val: () => v, exists: () => v !== null && v !== undefined }); },
    child: c => ref(p + '/' + c),
    set: v => { writes.push(p); return Promise.resolve(); },
    update: v => { writes.push(p); return Promise.resolve(); },
    remove: () => Promise.resolve(),
    onDisconnect: () => ({ remove: () => Promise.resolve() }),
    push: () => ({ key: 'k1' }),
  });
  const sb = {
    console, setTimeout, clearTimeout, Promise, Date,
    DrexCloud: { auth: () => ({ currentUser: { uid: 'bob' } }), database: () => ({ ref }) },
    document: { getElementById: () => ({ classList: { add() {}, remove() {}, toggle() {} } }), visibilityState: 'visible' },
    showMiniToast: t => toasts.push(String(t)),
    appT: s => s,
    fiestaShowRoom: () => {}, fiestaWatchRoom: () => {},
    fiestaMyProfile: async () => ({ name: 'Bob', photo: '' }),
    fiestaEnsureMic: async () => false, fiestaPaintControls: () => {},
    fiestaCur: null, fiestaJoining: false, fiestaMyUid: null, fiestaMyRole: 'listener',
    fiestaAmHost: false, fiestaMuted: false, fiestaHostMutedLocal: false,
    fiestaMembers: {}, fiestaDisconnectHandle: null, fiestaReasserting: false, fiestaLocalStream: null,
  };
  vm.createContext(sb);
  vm.runInContext(vcuSrc, sb, { timeout: 10000 });
  const expr = jfSrc.replace(/^(async\s+)?function joinFiesta/, '$1function __jf');
  vm.runInContext('var joinFiesta = (' + expr + ');', sb, { timeout: 10000 });
  return (async () => {
    const entered = await vm.runInContext('joinFiesta("f1", false)', sb, { timeout: 10000 });
    await new Promise(r => setTimeout(r, 150));
    return { entered, writes, toasts, reads };
  })();
}

(async () => {
  const kicked = await runCase(true);
  check('expulsado: NO escribe la membresía',
    !kicked.writes.some(w => w === 'fiestaMembers/f1/bob'));
  check('expulsado: joinFiesta devuelve false',
    kicked.entered === false);
  check('expulsado: avisa con toast de expulsión',
    kicked.toasts.some(t => /expulsado/i.test(t)));

  const legit = await runCase(false);
  check('no expulsado: SÍ escribe la membresía (entrada normal intacta)',
    legit.writes.some(w => w === 'fiestaMembers/f1/bob'));
  check('no expulsado: joinFiesta devuelve true',
    legit.entered === true);

  if (failures) { console.error(`\n${failures} checks FAILED`); process.exit(1); }
  console.log('\nAll C45-F1 checks passed');
})();
