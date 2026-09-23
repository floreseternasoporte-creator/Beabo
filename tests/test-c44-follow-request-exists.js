// CICLO 44 (C44-C1) — respondToFollowRequest aceptaba sin verificar que la
// solicitud siguiera existiendo.
//
// La vista de solicitudes se carga con once('value') (snapshot, no en vivo).
// Si el solicitante cancelaba su solicitud DESPUÉS de que el dueño abrió la
// vista, "Aceptar" sobre la fila stale creaba la relación de seguimiento
// (followers/ + following/ + contadores + notificación) contra la retirada
// explícita del solicitante.
//
// El fix lee followRequests/<uid>/<requesterUid> antes de aceptar: si ya no
// existe, retira la fila stale, avisa con toast y NO crea la relación.
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
  const anchor = 'async function ' + name + '(';
  const a = html.indexOf(anchor);
  if (a < 0) throw new Error('ancla no encontrada: ' + anchor);
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
  throw new Error('sin cierre: ' + anchor);
}

const fnSrc = extractFn('respondToFollowRequest');

// ---- 1. Estático ------------------------------------------------------------
check('verifica la existencia de la solicitud antes de aceptar',
  /requestRef\.once\('value'\)/.test(fnSrc) && /\.exists\(\)/.test(fnSrc));
check('si no existe: no crea la relación (return antes del set de followers)',
  fnSrc.indexOf('.exists()') < fnSrc.indexOf("ref('followers/'"));
check('si no existe: retira la fila stale del DOM',
  fnSrc.includes("getElementById('follow-request-row-'"));
check('si no existe: avisa con toast dedicado',
  fnSrc.includes("appT('Esta solicitud ya no existe')"));

// ---- 2. Funcional: función REAL en sandbox -----------------------------------
// requestExists=false: el solicitante canceló tras abrirse la vista (fila stale).
// requestExists=true: la solicitud sigue vigente.
function runCase(requestExists) {
  const writes = [];
  const toasts = [];
  const removedRows = [];
  const db = requestExists
    ? { 'followRequests/owner1/req9': { requestedAt: 1, requesterName: 'R' } }
    : {};
  const ref = p => ({
    once: () => Promise.resolve({
      exists: () => Object.prototype.hasOwnProperty.call(db, p),
      val: () => db[p] || null,
    }),
    set: v => { writes.push({ op: 'set', path: p }); return Promise.resolve(); },
    remove: () => { writes.push({ op: 'remove', path: p }); return Promise.resolve(); },
    transactionBlind: () => { writes.push({ op: 'txn', path: p }); return Promise.resolve(); },
  });
  const sb = {
    console, setTimeout, clearTimeout, Promise,
    _followRequestBusy: new Set(),
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'owner1' } }),
      database: () => ({ ref }),
    },
    document: {
      getElementById: id => (id && id.startsWith('follow-request-row-')
        ? { remove: () => removedRows.push(id) } : null),
    },
    showMiniToast: t => toasts.push(t),
    appT: s => s,
    addNotification: () => Promise.resolve(),
    _invalidatePrivacyCaches: () => {},
    updateFollowRequestsCountLabel: () => {},
  };
  vm.createContext(sb);
  const expr = fnSrc.replace('async function respondToFollowRequest', 'async function __resp');
  vm.runInContext('var respondToFollowRequest = (' + expr + ');', sb, { timeout: 5000 });
  return (async () => {
    await vm.runInContext('respondToFollowRequest("req9", true)', sb, { timeout: 5000 });
    await new Promise(r => setTimeout(r, 120));
    return { writes, toasts, removedRows };
  })();
}

(async () => {
  const stale = await runCase(false);
  check('solicitud retirada: NO se crea followers/<dueño>/<solicitante>',
    !stale.writes.some(w => w.op === 'set' && w.path === 'followers/owner1/req9'));
  check('solicitud retirada: NO se tocan los contadores',
    !stale.writes.some(w => w.op === 'txn'));
  check('solicitud retirada: la fila stale se retira del DOM',
    stale.removedRows.includes('follow-request-row-req9'));
  check('solicitud retirada: toast "Esta solicitud ya no existe"',
    stale.toasts.includes('Esta solicitud ya no existe'));

  const live = await runCase(true);
  check('solicitud vigente: SÍ se crea la relación de seguimiento',
    live.writes.some(w => w.op === 'set' && w.path === 'followers/owner1/req9'));
  check('solicitud vigente: la solicitud se elimina',
    live.writes.some(w => w.op === 'remove' && w.path === 'followRequests/owner1/req9'));

  if (failures) { console.error(`\n${failures} checks FAILED`); process.exit(1); }
  console.log('\nAll C44-C1 checks passed');
})();
