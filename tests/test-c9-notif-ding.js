// Harness ciclo 9 — hallazgos H2-DING-1/2/3, H2-DECR-2X (+ sanos).
// Extrae la lógica EXACTA (verbatim) de index.html y la evalúa en un sandbox
// con DrexCloud/DOM/localStorage falsos. Sin red, determinista.
// Uso: node tests/test-c9-notif-ding.js [ruta-a-index.html]
// Sale 0 si todo pasa, 1 si algo falla.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX = process.argv[2] || path.join(__dirname, '..', 'index.html');
const SRC = fs.readFileSync(INDEX, 'utf8');

// ---------- extracción verbatim ----------
function between(a, b, { includeEnd = true } = {}) {
  const i = SRC.indexOf(a);
  if (i < 0) throw new Error('no encontrado: ' + a);
  const j = SRC.indexOf(b, i);
  if (j < 0) throw new Error('no encontrado: ' + b);
  return SRC.slice(i, j + (includeEnd ? b.length : 0));
}
function fnBlock(startSig) {
  const i = SRC.indexOf(startSig);
  if (i < 0) throw new Error('no encontrado: ' + startSig);
  const j = SRC.indexOf('\n  }\n', i);
  if (j < 0) throw new Error('sin cierre: ' + startSig);
  return SRC.slice(i, j + '\n  }\n'.length);
}
const CODE_AUDIO = between('  function drexGetNotifAudioEl() {', '// H2-STATE-BEGIN', { includeEnd: false });
const CODE_STATE = between('// H2-STATE-BEGIN', '// H2-STATE-END');
// getLocalNotifications/saveLocalNotifications viven ENTRE H2-STATE-END y H2-FNS-BEGIN
const CODE_LOCAL = between('// H2-STATE-END', '// H2-FNS-BEGIN', { includeEnd: false });
const CODE_FNS = between('// H2-FNS-BEGIN', '// H2-FNS-END');
const CODE_COLLAB = fnBlock('  async function markCollabInviteNotificationsDone(noteId, status) {');
const CODE_SETUP = fnBlock('  function setupNotificationsBadge(userId) {');
const CODE_MUTED = fnBlock('  function isChatNotificationMuted(n) {');
const CODE_ISMUTE = fnBlock('  function isMuteActive(entry) {');
const EXTRACTED = [CODE_AUDIO, CODE_STATE, CODE_LOCAL, CODE_FNS, CODE_COLLAB, CODE_SETUP, CODE_MUTED, CODE_ISMUTE].join('\n');

// sanity: los bloques clave existen
for (const probe of ['function updateNotifUnreadBadge', 'function announceNewestNotification',
  'function getLocalNotifications', 'function saveLocalNotifications',
  'notifUnreadLastDingC', 'markCollabInviteNotificationsDone', 'decrementNotifUnread']) {
  if (!EXTRACTED.includes(probe)) throw new Error('extracción incompleta: falta ' + probe);
}

// ---------- sandbox ----------
function freshCtx(muteUsers = {}) {
  const store = {}; // 'notifUnread/u1' -> {c,r} ; 'notifications/u1' -> {nid: {...}}
  const ls = {};
  const counters = { dings: 0, sys: 0 };

  const getPath = (p) => p.split('/').filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), store);
  const setPath = (p, v) => {
    const ks = p.split('/').filter(Boolean);
    let o = store;
    for (let i = 0; i < ks.length - 1; i++) { if (typeof o[ks[i]] !== 'object' || o[ks[i]] === null) o[ks[i]] = {}; o = o[ks[i]]; }
    o[ks[ks.length - 1]] = v;
  };
  const snapOf = (v) => ({
    val: () => v,
    exists: () => v !== undefined && v !== null,
    forEach: (cb) => { if (v && typeof v === 'object') Object.keys(v).forEach(k => cb({ val: () => v[k], key: k, ref: { remove: () => Promise.resolve() } })); },
  });

  class FakeRef {
    constructor(p) { this.path = p; }
    on() {}
    off() {}
    once() { return Promise.resolve(snapOf(getPath(this.path))); }
    orderByChild(child) {
      const self = this;
      return {
        limitToLast(n) {
          return { once: () => {
            const v = getPath(self.path) || {};
            const arr = Object.keys(v).map(k => v[k]).sort((a, b) => (a[child] || 0) - (b[child] || 0));
            const last = {};
            arr.slice(-n).forEach((x, i) => { last['k' + i] = x; });
            return Promise.resolve(snapOf(last));
          }};
        },
        endAt() { return { once: () => Promise.resolve(snapOf(null)) }; },
      };
    }
    update(updates) {
      for (const k of Object.keys(updates)) {
        const full = this.path ? this.path + '/' + k.replace(/^\//, '') : k.replace(/^\//, '');
        setPath(full, updates[k]);
      }
      return Promise.resolve();
    }
    transactionBlind(fn) {
      const cur = getPath(this.path);
      setPath(this.path, fn(cur));
      return Promise.resolve();
    }
  }

  const badgeEls = {};
  const mkBadge = () => ({ textContent: '', classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
  const audioEl = { currentTime: 0, play() { counters.dings++; return { catch() {} }; }, pause() {} };
  const documentStub = {
    hidden: false,
    getElementById: (id) => {
      if (id === 'drex-notif-audio') return audioEl;
      if (id === 'notifications-modal') return { classList: { contains: () => true } }; // modal cerrado
      if (id === 'unread-notifications-count' || id === 'notif-unread-badge-desktop') {
        if (!badgeEls[id]) badgeEls[id] = mkBadge();
        return badgeEls[id];
      }
      return null;
    },
    addEventListener() {},
  };

  const sandbox = {
    console, Date, Math, JSON, Promise, setTimeout, setImmediate,
    document: documentStub,
    window: {},
    navigator: {},
    localStorage: {
      getItem: (k) => (k in ls ? ls[k] : null),
      setItem: (k, v) => { ls[k] = String(v); },
      removeItem: (k) => { delete ls[k]; },
    },
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'u1' } }),
      database: () => ({ ref: (p) => new FakeRef(p || '') }),
    },
    updateBadgeCount() {},
    appT: (s) => s,
    chatMuteCache: { users: muteUsers, groups: {} },
    drexNotifAudioEl: null,
    drexNotifAudioUnlocked: false,
    __sys: 0,
    __counters: counters,
    __store: store,
    __setPath: setPath,
    __getPath: getPath,
    __badgeEls: badgeEls,
  };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED, sandbox, { filename: 'extracted.js' });
  // instrumentar: contar mensajes del sistema por separado de los dings
  vm.runInContext(`
    var __origFire = fireDrexSystemNotification;
    fireDrexSystemNotification = function(m, f) { __counters.sys++; return __origFire(m, f); };
  `, sandbox);

  const run = (code) => vm.runInContext(code, sandbox);
  // instalar el listener como lo hace la app real (fija notifUnreadBadgeUid,
  // resetea el estado; el .on() del FakeRef es no-op y disparamos a mano)
  run(`setupNotificationsBadge('u1')`);
  const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
  const aggSnap = (c) => ({ val: () => ({ c, r: Date.now() }) });
  const aggSnapNull = () => ({ val: () => null });
  return { sandbox, run, flush, aggSnap, aggSnapNull,
    dings: () => counters.dings, sys: () => counters.sys,
    serverC: () => { const v = getPath('notifUnread/u1'); return v ? v.c : null; },
    setServerC: (c) => setPath('notifUnread/u1', { c, r: Date.now() }),
    delServerAgg: () => { delete store.notifUnread; },
    setServerNotifs: (obj) => setPath('notifications/u1', obj),
    setLocal: (arr) => { ls['drex_notifications_u1'] = JSON.stringify(arr); },
    getLocal: () => JSON.parse(ls['drex_notifications_u1'] || '[]'),
  };
}

// ---------- mini framework ----------
let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { passed++; results.push(`  ✅ ${name}`); }
  else { failed++; results.push(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---------- casos ----------
async function t_ding1() {
  // H2-DING-1: primera notificación post-deploy debe sonar.
  const t = freshCtx();
  // ventana LEGACY: nodo ausente; historial local con 2 no leídas
  t.setServerNotifs({
    a: { notificationId: 'a', message: 'h1', timestamp: 100, read: false },
    b: { notificationId: 'b', message: 'h2', timestamp: 90, read: false },
    c: { notificationId: 'c', message: 'h3', timestamp: 80, read: true },
  });
  t.delServerAgg();
  // ventana LEGACY: el listener recibe un snapshot con val()===null.
  t.run(`updateNotifUnreadBadge({ val: function(){ return null; } })`);
  await t.flush();
  const d0 = t.dings();

  // primer bump post-deploy: otro actor crea la notificación y el agregado
  t.setServerNotifs(Object.assign(t.sandbox.__getPath('notifications/u1'), {
    n: { notificationId: 'n', message: 'nueva', timestamp: 200, read: false },
  }));
  t.run(`updateNotifUnreadBadge({ val: function(){ return {c:1, r: Date.now()}; } })`);
  await t.flush();
  const d1 = t.dings();

  check('DING-1: legacy no suena por historial', d0 === 0, `dings=${d0}`);
  check('DING-1: primera notificación post-deploy SÍ suena', d1 === d0 + 1, `dings=${d1} (esperado ${d0 + 1})`);
}
async function t_ding2() {
  // H2-DING-2: reset remoto deja la marca atascada; la siguiente notificación debe sonar.
  const t = freshCtx();
  t.setServerC(5);
  t.setServerNotifs({ x: { notificationId: 'x', message: 'vieja', timestamp: 100, read: true } });
  t.run(`updateNotifUnreadBadge({ val: function(){ return {c:5, r: 1}; } })`); // primer snapshot = historial
  await t.flush();
  const dHist = t.dings();
  // reset REMOTO (otro dispositivo abre el modal): c -> 0 sin tocar lastDingC local
  t.run(`updateNotifUnreadBadge({ val: function(){ return {c:0, r: 2}; } })`);
  await t.flush();
  const dReset = t.dings();
  // nueva notificación
  t.setServerNotifs({ n: { notificationId: 'n', message: 'nueva', timestamp: 200, read: false } });
  t.run(`updateNotifUnreadBadge({ val: function(){ return {c:1, r: 3}; } })`);
  await t.flush();
  const d1 = t.dings();
  check('DING-2: historial inicial no suena', dHist === 0, `dings=${dHist}`);
  check('DING-2: reset remoto no suena', dReset === 0, `dings=${dReset}`);
  check('DING-2: notificación tras reset remoto SÍ suena', d1 === 1, `dings=${d1} (esperado 1)`);
}

async function t_ding3() {
  // H2-DING-3: c crece pero la más nueva está silenciada/leída → al menos ding genérico.
  const muteEntry = { muteUntil: Date.now() + 3600e3 };
  for (const variant of ['muted', 'read']) {
    const t = freshCtx(variant === 'muted' ? { convX: muteEntry } : {});
    t.run(`updateNotifUnreadBadge({ val: function(){ return {c:0, r: 1}; } })`);
    await t.flush();
    const newest = variant === 'muted'
      ? { notificationId: 'n1', message: 'chat silenciado', timestamp: 300, read: false, actionType: 'chat', actionId: 'convX' }
      : { notificationId: 'n1', message: 'ya leída', timestamp: 300, read: true };
    t.setServerNotifs({
      n1: newest,
      n2: { notificationId: 'n2', message: 'normal 2', timestamp: 200, read: false },
      n3: { notificationId: 'n3', message: 'normal 3', timestamp: 100, read: false },
    });
    t.run(`updateNotifUnreadBadge({ val: function(){ return {c:3, r: 2}; } })`);
    await t.flush();
    check(`DING-3 (${variant}): al menos 1 ding genérico`, t.dings() === 1, `dings=${t.dings()}`);
    check(`DING-3 (${variant}): sin mensaje del sistema`, t.sys() === 0, `sys=${t.sys()}`);
  }
}

async function t_decr2x() {
  // H2-DECR-2X: doble-tap en aceptar colaboración no debe decrementar 2×.
  const t = freshCtx();
  t.setServerC(2);
  t.setLocal([
    { notificationId: 'n1', type: 'collab_invite', collabNoteId: 'noteX', actionId: 'noteX', message: 'inv', read: false, timestamp: 100 },
    { notificationId: 'n2', type: 'like', message: 'otro', read: false, timestamp: 90 },
  ]);
  t.run(`updateNotifUnreadBadge({ val: function(){ return {c:2, r: 1}; } })`);
  await t.flush();
  await t.run(`markCollabInviteNotificationsDone('noteX', 'accepted')`); // tap 1
  const c1 = t.serverC();
  await t.run(`markCollabInviteNotificationsDone('noteX', 'accepted')`); // tap 2 (doble-tap)
  const c2 = t.serverC();
  check('DECR-2X: primer tap decrementa 1', c1 === 1, `c=${c1}`);
  check('DECR-2X: segundo tap NO decrementa de nuevo', c2 === 1, `c=${c2} (esperado 1)`);
  const local = t.getLocal();
  check('DECR-2X: local queda read=true', local.find(n => n.notificationId === 'n1').read === true);
}

// ---------- sanos (no deben romperse) ----------
async function t_healthy_reset_local() {
  const t = freshCtx();
  t.setServerC(3);
  t.setServerNotifs({ x: { notificationId: 'x', message: 'v', timestamp: 100, read: false } });
  t.run(`updateNotifUnreadBadge({ val: function(){ return {c:3, r: 1}; } })`);
  await t.flush();
  t.run(`resetNotifUnread('u1')`); // reset LOCAL
  const c0 = t.serverC();
  t.run(`updateNotifUnreadBadge({ val: function(){ return {c:0, r: 2}; } })`);
  await t.flush();
  const d0 = t.dings();
  // y la siguiente notificación sí suena
  t.setServerNotifs({ n: { notificationId: 'n', message: 'nueva', timestamp: 200, read: false } });
  t.run(`updateNotifUnreadBadge({ val: function(){ return {c:1, r: 3}; } })`);
  await t.flush();
  check('SANO reset-local: servidor queda en 0', c0 === 0, `c=${c0}`);
  check('SANO reset-local: no suena', d0 === 0, `dings=${d0}`);
  check('SANO reset-local: la siguiente sí suena', t.dings() === 1, `dings=${t.dings()}`);
}

async function t_healthy_decr_single() {
  const t = freshCtx();
  t.setServerC(2);
  t.setLocal([
    { notificationId: 'n1', type: 'collab_invite', collabNoteId: 'noteX', actionId: 'noteX', message: 'inv', read: false, timestamp: 100 },
    { notificationId: 'n2', type: 'like', message: 'otro', read: false, timestamp: 90 },
  ]);
  t.run(`updateNotifUnreadBadge({ val: function(){ return {c:2, r: 1}; } })`);
  await t.flush();
  await t.run(`markCollabInviteNotificationsDone('noteX', 'accepted')`);
  const c = t.serverC();
  t.run(`updateNotifUnreadBadge({ val: function(){ return {c:1, r: 2}; } })`);
  await t.flush();
  check('SANO decrement-single: c=1', c === 1, `c=${c}`);
  check('SANO decrement-single: no suena al decrementar', t.dings() === 0, `dings=${t.dings()}`);
}

async function t_healthy_normal_dings() {
  // N→1 aviso normal: cada bump suena con su mensaje.
  const t = freshCtx();
  t.setServerNotifs({ n: { notificationId: 'n', message: 'nueva', timestamp: 200, read: false } });
  for (const c of [0, 1, 2, 3]) {
    t.run(`updateNotifUnreadBadge({ val: function(){ return {c:${c}, r: ${c}}; } })`);
    await t.flush();
  }
  check('SANO normal: 3 bumps → 3 dings', t.dings() === 3, `dings=${t.dings()}`);
  check('SANO normal: 3 mensajes del sistema', t.sys() === 3, `sys=${t.sys()}`);
}

async function t_healthy_legacy_reset_window() {
  // reset durante la ventana legacy termina la ventana sin aviso.
  const t = freshCtx();
  t.delServerAgg();
  t.run(`updateNotifUnreadBadge({ val: function(){ return null; } })`);
  await t.flush();
  t.run(`resetNotifUnread('u1')`); // crea {c:0} y termina la ventana
  t.run(`updateNotifUnreadBadge({ val: function(){ return {c:0, r: 2}; } })`);
  await t.flush();
  check('SANO legacy-reset: no suena', t.dings() === 0, `dings=${t.dings()}`);
  check('SANO legacy-reset: servidor c=0', t.serverC() === 0, `c=${t.serverC()}`);
}

(async () => {
  console.log('== Harness ciclo 9 — notifUnread ding/decrement ==');
  console.log('   index.html:', INDEX);
  console.log('   bytes extraídos verbatim:', EXTRACTED.length);
  const groups = [
    ['H2-DING-1 (primera notificación post-deploy)', t_ding1],
    ['H2-DING-2 (marca atascada tras reset remoto)', t_ding2],
    ['H2-DING-3 (más nueva silenciada/leída)', t_ding3],
    ['H2-DECR-2X (doble-tap colaboración)', t_decr2x],
    ['SANOS', async () => {
      await t_healthy_reset_local();
      await t_healthy_decr_single();
      await t_healthy_normal_dings();
      await t_healthy_legacy_reset_window();
    }],
  ];
  for (const [name, fn] of groups) {
    console.log('\n-- ' + name);
    try { await fn(); } catch (e) { failed++; results.push('  ❌ EXCEPCIÓN: ' + e.message); }
  }
  console.log('\n' + results.join('\n'));
  console.log(`\n${passed} pasados, ${failed} fallados`);
  process.exit(failed ? 1 : 0);
})();
