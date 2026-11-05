// test-c53-fiesta-signals-cleanup.js — limpieza de fiestaSignals/<id> (C53-F1).
// C53-F1 (Fiestas/señales WebRTC): al terminar una fiesta, los 4 caminos
// (endFiesta, leaveFiesta del anfitrión, cascadeDeleteNote al borrar el
// anuncio, y el reaper zombi C52-F1) limpiaban fiestaReactions + fiestaKicked
// pero NUNCA el subárbol fiestaSignals/<id>. Las señales pendientes
// (offers/answers/candidatos ICE, con IPs del par) quedaban huérfanas para
// siempre; peor si alguien crasheaba, porque el onDisconnect solo borra
// fiestaMembers. Fix: helper best-effort _fiestaRemoveSignals(id) invocado
// en los 4 caminos.
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
check('C1: existe el helper _fiestaRemoveSignals(id)',
  /function _fiestaRemoveSignals\(id\)/.test(html));
check('C1: el helper borra el subárbol completo fiestaSignals/<id> (best-effort)',
  /ref\('fiestaSignals\/' \+ id\)\.remove\(\)/.test(html));
check('C1: endFiesta invoca el helper',
  /function endFiesta\(\)[\s\S]{0,800}_fiestaRemoveSignals\(id\)/.test(html));
check('C1: leaveFiesta (rama anfitrión) invoca el helper',
  /wasHost && id\)[\s\S]{0,600}_fiestaRemoveSignals\(id\)/.test(html));
check('C1: cascadeDeleteNote invoca el helper al borrar el anuncio',
  /_fiestaRemoveSignals\(n\.fiestaId\)/.test(html));
check('C1: el reaper zombi invoca el helper (el invitado limpia sin anfitrión)',
  /_fiestaRemoveSignals\(_zid\)/.test(html));

// ---------- funcional ----------
const db = {
  fiestaSignals: { F1: {
    alice: { sig1: { type: 'offer', from: 'carol' } },
    bob: { sig9: { type: 'candidate', from: 'alice' } }, // Bob crasheó
  } },
  fiestas: { F1: { status: 'live' } },
};
function nodeAt(path, create) {
  const segs = path.split('/').filter(Boolean);
  let n = db;
  for (const s of segs) {
    if (!(s in n)) { if (!create) return undefined; n[s] = {}; }
    n = n[s];
  }
  return n;
}
function makeRef(path) {
  return {
    child: c => makeRef(path + '/' + c),
    set: v => { const p = path.split('/'); const k = p.pop();
      nodeAt(p.join('/'), true)[k] = v; return Promise.resolve(); },
    remove: () => { const p = path.split('/'); const k = p.pop();
      const parent = nodeAt(p.join('/')); if (parent) delete parent[k];
      return Promise.resolve(); },
    once: () => Promise.resolve({ val: () => nodeAt(path) }),
  };
}
const sandbox = {
  DrexCloud: {
    database: () => ({ ref: p => makeRef(p) }),
    auth: () => ({ currentUser: { uid: 'host1' } }),
  },
  confirm: () => true,
  appT: s => s,
  markFiestaNotesEnded: async () => {},
  fiestaCur: { id: 'F1' },
  fiestaAmHost: true,
  console,
};
vm.createContext(sandbox);
vm.runInContext(extractFn(html, '_fiestaRemoveSignals'), sandbox);
vm.runInContext(extractFn(html, 'endFiesta'), sandbox);

(async () => {
  await sandbox.endFiesta();
  const leftover = nodeAt('fiestaSignals/F1');
  check('C2: endFiesta elimina fiestaSignals/F1 completo (inbox del crasheado incluido)',
    !leftover || Object.keys(leftover).length === 0);

  db.fiestaSignals = { F2: { x: { a: 1 } } };
  await sandbox._fiestaRemoveSignals('F2');
  check('C2: el helper elimina el subárbol directo', !nodeAt('fiestaSignals/F2'));
  await sandbox._fiestaRemoveSignals(null);
  check('C2: el helper tolera id nulo', true);

  console.log(`\nC53-F1: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
