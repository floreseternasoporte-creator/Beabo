// Harness ciclo 10 — fixes de la auditoría C9 (commit be45e7a, antes sin
// cobertura): C9-A ding coalescado + guard de sesión en las notificaciones,
// C9-B carrera de paginación del perfil ("Cargar más" re-adjunta mientras un
// callback viejo sigue en `await`).
// Extrae la lógica EXACTA (verbatim) de index.html y la evalúa en un sandbox
// con DrexCloud/DOM falsos. Sin red, determinista.
// Uso: node tests/test-c10-audit-fixes.js [ruta-a-index.html]
// Sale 0 si todo pasa, 1 si algo falla.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX = process.argv[2] || path.join(__dirname, '..', 'index.html');
const SRC = fs.readFileSync(INDEX, 'utf8');

// ---------- extracción verbatim (find() != -1 antes de rebanar) ----------
function between(a, b, opts) {
  const i = SRC.indexOf(a);
  if (i < 0) throw new Error('no encontrado: ' + a);
  const j = SRC.indexOf(b, i);
  if (j < 0) throw new Error('no encontrado: ' + b);
  const inc = !opts || opts.includeEnd !== false;
  return SRC.slice(i, j + (inc ? b.length : 0));
}
function fnBlock(startSig) {
  const i = SRC.indexOf(startSig);
  if (i < 0) throw new Error('no encontrado: ' + startSig);
  const j = SRC.indexOf('\n  }\n', i);
  if (j < 0) throw new Error('sin cierre: ' + startSig);
  return SRC.slice(i, j + '\n  }\n'.length);
}
function lineOf(startSig) {
  const i = SRC.indexOf(startSig);
  if (i < 0) throw new Error('no encontrado: ' + startSig);
  const j = SRC.indexOf('\n', i);
  return SRC.slice(i, j);
}

// --- Parte A: estado + announceNewestNotification + announceNewestNotificationIfNew ---
const A_STATE = lineOf('  let notifUnreadLastAnnouncedId = null;');
const A_FN = fnBlock('  function announceNewestNotification(userId) {');
const A_IFNEW = fnBlock('  function announceNewestNotificationIfNew(userId) {');

// --- Parte B: paginación del perfil (C9-B): estado + paints + detach/loadMore/attach ---
const B_STATE = between('  const PROFILE_POSTS_PAGE = 30;', '  function _profilePostsLoadMore() {', { includeEnd: false });
const B_DETACH = fnBlock('  function _detachProfilePostsListener() {');
const B_LOADMORE = fnBlock('  function _profilePostsLoadMore() {');
const B_ATTACH = fnBlock('  function _attachProfilePostsListener() {');

for (const [name, probe] of [
  ['A_STATE', 'notifUnreadLastAnnouncedId'],
  ['A_FN', 'notifUnreadLastAnnouncedId = newest.notificationId'],
  ['A_IFNEW', 'notifUnreadLastAnnouncedId !== notifUnreadLastAnnouncedId'],
  ['B_STATE', '_profilePostsGen'],
  ['B_ATTACH', 'if (_gen !== _profilePostsGen) return;'],
  ['B_ATTACH', '_pageAtAttach'],
]) {
  // sanity: la extracción trae el mecanismo del fix
}
// (A_IFNEW contiene "newest.notificationId !== notifUnreadLastAnnouncedId")
if (!A_IFNEW.includes('!== notifUnreadLastAnnouncedId')) throw new Error('C9-A no extraído: falta la comparación de id');
if (!B_ATTACH.includes('const _gen = ++_profilePostsGen')) throw new Error('C9-B no extraído: falta el guard de generación');

// ---------- mini framework ----------
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ok - ' + name); }
  else { failed++; console.log('  FALLO - ' + name); }
}
const tick = () => new Promise(r => setTimeout(r, 0));

// =====================================================================
// PARTE A — C9-A: ding coalescado + guard de sesión
// =====================================================================
async function parteA() {
  console.log('== Parte A: ding coalescado + guard de sesión (C9-A) ==');
  let ME_UID = 'u1';
  let notifData = {}; // notifications/u1 -> {nid: {...}}
  const counters = { sys: 0, sound: 0 };
  let muted = false;

  const snapOf = (v) => ({
    val: () => v,
    exists: () => v !== undefined && v !== null,
    forEach: (cb) => { if (v && typeof v === 'object') Object.keys(v).forEach(k => cb({ val: () => v[k], key: k })); },
  });
  const ctx = vm.createContext({
    console,
    DrexCloud: {
      auth: () => ({ currentUser: ME_UID ? { uid: ME_UID } : null }),
      database: () => ({
        ref: (p) => ({
          orderByChild: () => ({ limitToLast: () => ({ once: () => Promise.resolve(snapOf(notifData)) }) }),
        }),
      }),
    },
    fireDrexSystemNotification: () => { counters.sys++; },
    drexPlayNotificationSound: () => { counters.sound++; },
    isChatNotificationMuted: () => muted,
  });
  vm.runInContext(A_STATE + '\n' + A_FN + '\n' + A_IFNEW, ctx);

  async function announce(uid) { await ctx.announceNewestNotification(uid); await tick(); await tick(); }
  async function announceIfNew(uid) { await ctx.announceNewestNotificationIfNew(uid); await tick(); await tick(); }

  // 1. Rama de crecimiento: la más nueva (unread, no silenciada) avisa y queda registrada.
  notifData = { n1: { notificationId: 'n1', read: false, message: 'hola', timestamp: 100 } };
  await announce('u1');
  ok(counters.sys === 1 && counters.sound === 0, 'crecimiento: la notificación nueva suena (system)');
  ok(vm.runInContext('notifUnreadLastAnnouncedId', ctx) === 'n1', 'crecimiento: la id avisada queda registrada');

  // 2. Reset remoto + bump coalescados (el polling trae {c:1} y la rama de
  //    decrecimiento llama a IfNew): la id NUEVA sí debe sonar.
  notifData = { n2: { notificationId: 'n2', read: false, message: 'nueva', timestamp: 200 } };
  await announceIfNew('u1');
  ok(counters.sys === 2, 'decrecimiento coalescado: la notificación jamás avisada sí suena');
  ok(vm.runInContext('notifUnreadLastAnnouncedId', ctx) === 'n2', 'decrecimiento: la id avisada se actualiza a n2');

  // 3. Reset remoto puro: la más nueva ya fue avisada → NO re-suena.
  await announceIfNew('u1');
  ok(counters.sys === 2, 'reset remoto puro: la misma id ya avisada no re-suena');

  // 4. La más nueva leída no suena en la rama condicional.
  notifData = { n3: { notificationId: 'n3', read: true, message: 'leída', timestamp: 300 } };
  await announceIfNew('u1');
  ok(counters.sys === 2, 'IfNew: la más nueva leída no suena');
  ok(vm.runInContext('notifUnreadLastAnnouncedId', ctx) === 'n2', 'IfNew: la id registrada no cambia con leídas');

  // 5. Guard de sesión: si la sesión cambió mientras tanto, nada suena.
  ME_UID = 'otro';
  notifData = { n4: { notificationId: 'n4', read: false, message: 'x', timestamp: 400 } };
  await announce('u1');
  await announceIfNew('u1');
  ok(counters.sys === 2, 'guard de sesión: announce e IfNew no avisan con uid distinto');
  ME_UID = 'u1';

  // 6. H2-DING-3 (comportamiento previo conservado): la más nueva silenciada
  //    → aviso genérico + la id queda registrada (evita re-ding futuro).
  muted = true;
  notifData = { n5: { notificationId: 'n5', read: false, message: 'sil', timestamp: 500 } };
  await announce('u1');
  ok(counters.sound === 1 && counters.sys === 2, 'DING-3: silenciada → solo sonido genérico');
  ok(vm.runInContext('notifUnreadLastAnnouncedId', ctx) === 'n5', 'DING-3: la id silenciada queda registrada');
  muted = false;
}

// =====================================================================
// PARTE B — C9-B: carrera de paginación del perfil
// =====================================================================
async function parteB() {
  console.log('== Parte B: carrera de paginación del perfil (C9-B) ==');
  const collabWaiters = [];
  let gridPaints = 0;
  const refs = [];

  class FakePostsRef {
    constructor() { this.cb = null; this.detached = false; refs.push(this); }
    on(ev, cb) { this.cb = cb; return this; }
    off() { this.detached = true; }
    fire(n) { const p = this.cb({ numChildren: () => n }); return p; }
  }
  const ctx = vm.createContext({
    console,
    DrexCloud: {
      database: () => ({
        ref: () => ({
          orderByChild: () => ({ equalTo: () => ({ limitToLast: () => new FakePostsRef() }) }),
        }),
      }),
    },
    document: {
      getElementById: (id) => id === 'profile-view'
        ? { classList: { contains: () => false } }
        : null,
    },
    fetchCollabPosts: () => new Promise(res => collabWaiters.push(res)),
    loadUserPostsGrid: () => { gridPaints++; },
    appT: (s) => s,
    formatNumber: (n) => String(n),
    _userStatsUid: 'u1',
    _userStatsRefs: [],
    _profilePostsRef: null,
  });
  vm.runInContext(B_STATE + '\n' + B_DETACH + '\n' + B_LOADMORE + '\n' + B_ATTACH, ctx);

  // Los `let` extraídos no son props del objeto ctx: se leen evaluando dentro.
  const g = (name) => vm.runInContext(name, ctx);

  // Adjunta (gen 1, página 30) y dispara el snapshot con la página llena.
  ctx._attachProfilePostsListener();
  const ref1 = refs[refs.length - 1];
  ok(ref1 && !ref1.detached, 'attach inicial crea el listener (gen 1)');
  ref1.fire(30); // página llena; el callback queda en `await fetchCollabPosts`
  await tick(); await tick();
  ok(collabWaiters.length === 1, 'el callback gen-1 espera fetchCollabPosts');
  ok(g('_profilePostsGridN') === 0, 'antes de resolver, nada pintado');

  // "Cargar más": página 60, re-adjunta (gen 2).
  ctx._profilePostsLoadMore();
  const ref2 = refs[refs.length - 1];
  ok(ref1.detached, '"Cargar más" desadjunta el listener viejo');
  ok(ref2 !== ref1 && !ref2.detached, 're-adjunta con página 60 (gen 2)');
  ok(g('_profilePostsPage') === 60, 'la página subió a 60');
  ref2.fire(30); // página NO llena contra _pageAtAttach=60
  await tick(); await tick();
  ok(collabWaiters.length === 2, 'el callback gen-2 también espera su fetch');

  // El callback VIEJO (gen 1) resuelve tarde: debe morir sin pintar.
  collabWaiters[0]([]);
  await tick(); await tick(); await tick();
  ok(g('_profilePostsGridN') === 0, 'callback viejo (gen 1) invalidado: no pinta el grid');
  ok(g('_profilePostsTotal') === null, 'callback viejo invalidado: no fija un total erróneo (30<60 en vivo)');

  // El callback NUEVO (gen 2) resuelve: pinta con la página pedida (60).
  collabWaiters[1]([]);
  await tick(); await tick(); await tick();
  ok(g('_profilePostsGridN') === 30, 'callback gen-2 pinta el grid');
  ok(g('_profilePostsTotal') === 30, 'total exacto en vivo: 30 < página pedida (60)');
  ok(gridPaints === 1, 'loadUserPostsGrid llamado una sola vez (solo el gen vigente)');
}

(async () => {
  await parteA();
  await parteB();
  console.log(failed === 0 ? `\nRESULTADO: ${passed} ok, 0 fallos` : `\nRESULTADO: ${passed} ok, ${failed} FALLOS`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR del harness:', e.message); process.exit(1); });
