'use strict';
/*
 * test-c253-sched-remind.js — Recordatorios PUSH de en vivos programados (C253).
 *
 * Cubre:
 *  T1-T2: lógica pura del ticket (buildTicket, isTicketDue/isTicketStale/shouldFireTicket).
 *  T3: programar -> ticket liveReminders/<liveId> creado (+ wiring en drexLiveSchedule).
 *  T4: tiempo simulado llega a remindAt -> notificaciones type 'live' a seguidores,
 *      mensaje en el idioma de cada destinatario, opt-out 'fiestas' respetado,
 *      ticket marcado 'sent'.
 *  T5: cancelar -> ticket borrado y sin notificaciones (+ wiring en drexSchedDoCancel).
 *  T6: catch-up al abrir: recordatorio vencido con live futuro SÍ dispara;
 *      ticket vencido con live pasado NO dispara (+ wiring tick/boot).
 *  T7: claim atómico: ticket ya reclamado por otro dispositivo no reenvía.
 *  T8: i18n ES/EN/ZH/PT con marcador /* ITEM4-SCHEDREM *\/.
 *  T9: wiring misceláneo (bucket 'fiestas' para type 'live', msgFor, deep-link
 *      'live' en el parche lambda pendiente de deploy).
 *
 * El módulo se extrae del index.html real entre los marcadores C253 y se
 * evalúa con `new Function` (convención de tests/test-c94-ondas-tendencias.js).
 * La BD es un fake a nivel Ref de DrexCloud (set/update/remove/once/transaction,
 * forEach de hijos); addNotification/notifyFollowersOfNewContent se sustituyen
 * por fakes fieles a la semántica real (opt-out 'fiestas' para type 'live').
 *
 * Uso: node tests/test-c253-sched-remind.js [--target otro.html]
 * Contra la base sin el parche (git show HEAD:index.html) debe fallar en ROJO.
 */
process.chdir(__dirname + '/..');
const fs = require('fs');
const assert = require('assert');

let target = 'index.html';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) target = process.argv[++i];
}
const html = fs.readFileSync(target, 'utf8');

const START = '// ===== C253 recordatorios push de en vivos programados — inicio =====';
const END = '// ===== C253 recordatorios push de en vivos programados — fin =====';
const si = html.indexOf(START), ei = html.indexOf(END);
assert.ok(si >= 0 && ei > si, 'ROJO: bloque C253 ausente en ' + target);

/* ---------- i18n real (drex-i18n.js es solo datos) ---------- */
const i18nSrc = fs.readFileSync('drex-i18n.js', 'utf8');
const DICTS = new Function(i18nSrc + '\n;return {en:APP_ENGLISH_TEXT,zh:APP_CHINESE_TEXT,pt:APP_PORTUGUESE_TEXT};')();

/* ---------- stubs globales ---------- */
global.window = {};
global.DrexSchedPure = { REMIND_MS: 10 * 60 * 1000, EXPIRE_MS: 60 * 60 * 1000 };
global.getAppTextDict = (l) => DICTS[l] || null;
global.t = (s) => s;
global.toast = () => {};
global.liveUser = () => ({ uid: 'host1' });

/* ---------- fake DrexCloud a nivel Ref ---------- */
function setDeep(obj, segs, v) {
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[segs[segs.length - 1]] = v;
}
function makeFakeDb() {
  const store = new Map(); // path exacto -> valor JS
  const norm = (p) => String(p).replace(/^\/+|\/+$/g, '');
  function valAt(p) {
    // Funde el objeto de la ruta exacta con las hojas descendientes
    // (las hojas ganan), como el reensamblado de DrexCloud tras update().
    let base = null;
    if (store.has(p)) {
      const v = store.get(p);
      base = (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
    }
    let found = base !== null && base !== undefined;
    for (const [k, v] of store) {
      if (k.startsWith(p + '/')) {
        found = true;
        if (base === null || typeof base !== 'object') base = {};
        setDeep(base, k.slice(p.length + 1).split('/'), v);
      }
    }
    return found ? base : null;
  }
  function childrenOf(p) {
    const out = [];
    const seen = new Set();
    for (const k of store.keys()) {
      if (k === p || k.startsWith(p + '/')) {
        const rest = k === p ? '' : k.slice(p.length + 1);
        const head = rest.split('/')[0];
        if (head && !seen.has(head)) { seen.add(head); out.push(head); }
      }
    }
    // también soporta valores-objeto guardados en la ruta exacta
    if (store.has(p)) {
      const v = store.get(p);
      if (v && typeof v === 'object') for (const k of Object.keys(v)) if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
    return out;
  }
  function delSubtree(p) {
    for (const k of [...store.keys()]) if (k === p || k.startsWith(p + '/')) store.delete(k);
  }
  const db = {
    _store: store,
    ref(path) {
      const p = norm(path);
      const snap = () => ({
        val: () => valAt(p),
        exists: () => valAt(p) !== null,
        forEach: (cb) => { for (const k of childrenOf(p)) cb({ key: k }); },
      });
      return {
        _p: p,
        once: () => Promise.resolve(snap()),
        set: (v) => { delSubtree(p); store.set(p, v); return Promise.resolve(); },
        update: (obj) => {
          for (const k of Object.keys(obj || {})) {
            const fp = p + '/' + k;
            delSubtree(fp);
            if (obj[k] !== null && obj[k] !== undefined) store.set(fp, obj[k]);
          }
          return Promise.resolve();
        },
        remove: () => { delSubtree(p); return Promise.resolve(); },
        transaction: (fn) => {
          const cur = valAt(p);
          const next = fn(cur && typeof cur === 'object' ? JSON.parse(JSON.stringify(cur)) : cur);
          if (next === undefined) return Promise.resolve({ committed: false });
          delSubtree(p);
          store.set(p, next);
          return Promise.resolve({ committed: true });
        },
      };
    },
  };
  return db;
}

/* ---------- fakes fieles de notificaciones ----------
 * addNotification real: respeta shouldSkipNotificationFor -> para type 'live'
 * el prefKey es 'fiestas' (index.html: notifTypeToPrefKey). El fake replica
 * esa semántica leyendo userSettings/<uid>/notifications. */
const db = makeFakeDb();
const writes = []; // {uid, message, type, meta}
let notifSeq = 0;
async function fakeAddNotification(userId, message, type = 'info', meta = {}) {
  const s = await db.ref('userSettings/' + userId + '/notifications').once('value');
  const prefs = s.val() || {};
  const key = type === 'live' ? 'fiestas' : null;
  if (key && prefs[key] === false) return; // opt-out respetado
  const nid = 'n' + (++notifSeq);
  await db.ref('notifications/' + userId + '/' + nid).set(
    Object.assign({ message, timestamp: Date.now(), read: false, type, notificationId: nid }, meta));
  writes.push({ uid: userId, message, type, meta });
}
async function fakeNotifyFollowersOfNewContent(authorId, authorName, type, message, meta, msgFor) {
  const s = await db.ref('followers/' + authorId).once('value');
  const jobs = [];
  s.forEach((ch) => {
    const fid = ch.key;
    if (!fid || fid === authorId) return;
    jobs.push(
      Promise.resolve()
        .then(() => (typeof msgFor === 'function' ? msgFor(fid) : message))
        .then((m) => fakeAddNotification(fid, (m == null || m === '') ? message : m, type, meta || {}))
        .catch(() => {})
    );
  });
  await Promise.all(jobs);
}
global.addNotification = fakeAddNotification;
global.notifyFollowersOfNewContent = fakeNotifyFollowersOfNewContent;
global.DrexCloud = { database: () => db, auth: () => ({ currentUser: { uid: 'host1' } }) };

/* ---------- cargar el módulo C253 ---------- */
const src = html.slice(si, ei);
let API = null, loadErr = null;
try {
  API = new Function(src + '\n;return DrexSchedRemind;')();
} catch (e) { loadErr = e; }
assert.ok(API && !loadErr, 'carga del módulo C253: ' + (loadErr && loadErr.message));
const RP = API.pure;
assert.ok(RP && typeof RP.buildTicket === 'function', 'DrexSchedRemindPure no expuesto');

const T0 = 1780000000000; // tiempo simulado fijo
const MIN = 60 * 1000;
function ticketAt(scheduledAt, extra) {
  return Object.assign(
    RP.buildTicket({ id: 'sched1', hostUid: 'host1', hostName: 'Ana', title: 'Charla', scheduledAt, nowMs: T0 - MIN }),
    extra || {});
}
function seedBase(sched) {
  db._store.clear(); writes.length = 0; notifSeq = 0;
  return Promise.all([
    db.ref('liveReminders/sched1').set(ticketAt(sched.scheduledAt, sched.ticketExtra)),
    db.ref('scheduledByHost/host1').set({ sched1: true }),
    db.ref('scheduledLives/sched1').set({
      id: 'sched1', hostUid: 'host1', hostName: 'Ana', title: 'Charla',
      scheduledAt: sched.scheduledAt, status: 'scheduled',
    }),
    db.ref('followers/host1').set({ f1: true, f2: true, f3: true }),
    db.ref('userSettings/f1/appLanguage').set('en'),
    db.ref('userSettings/f2/appLanguage').set('zh'),
    db.ref('userSettings/f3/appLanguage').set('pt'),
    db.ref('userSettings/f3/notifications').set({ fiestas: false }), // f3 con opt-out
  ]);
}

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, 'FALLO: ' + label);
  passed++;
  console.log('  ok - ' + label);
}

(async () => {
  console.log('T1: lógica pura del ticket');
  const b = RP.buildTicket({ id: 'sched1', hostUid: 'host1', hostName: 'Ana', title: 'Charla', scheduledAt: T0 + 3600000, nowMs: T0 });
  ok(b.remindAt === T0 + 3600000 - 10 * MIN, 'remindAt = scheduledAt - 10 min');
  ok(b.status === 'pending' && b.attempts === 0, 'status pending, attempts 0');
  ok(RP.ticketPath('sched1') === 'liveReminders/sched1', 'ticketPath');
  ok(RP.sanitizeId('a/b.c') === 'abc', 'sanitizeId limpia la ruta');

  console.log('T2: due / stale / shouldFire');
  ok(RP.isTicketDue(ticketAt(T0 + MIN), T0) === true, 'due cuando remindAt <= now');
  ok(RP.isTicketDue(ticketAt(T0 + 60 * MIN), T0) === false, 'no due si remindAt futuro');
  ok(RP.isTicketDue(ticketAt(T0 + MIN, { status: 'sent' }), T0) === false, 'no due si ya enviado');
  ok(RP.isTicketStale(ticketAt(T0 + MIN), T0) === false, 'no stale si el live es futuro');
  ok(RP.isTicketStale(ticketAt(T0 - 61 * MIN), T0) === true, 'stale si el live pasó hace >60 min');
  ok(RP.shouldFireTicket(ticketAt(T0 + MIN), T0) === true, 'dispara: due y vigente');
  ok(RP.shouldFireTicket(ticketAt(T0 + 5 * MIN, {}), T0 - 30 * MIN) === false, 'no dispara antes de remindAt');
  // catch-up: remindAt venció hace 30 min con la app cerrada, pero el live aún no empezó
  const catchTicket = ticketAt(T0 + 5 * MIN);
  ok(RP.shouldFireTicket(catchTicket, T0) === true, 'catch-up: vencido pero live futuro -> dispara');
  ok(RP.shouldFireTicket(ticketAt(T0 - 120 * MIN), T0) === false, 'vencido con live pasado -> no dispara');

  console.log('T3: programar -> ticket creado');
  db._store.clear();
  const rec = { id: 'sched9', hostUid: 'host1', hostName: 'Ana', title: 'Noche de juegos', scheduledAt: T0 + 7200000 };
  const tk = await API.writeReminderTicket(db, 'sched9', rec);
  const stored = db._store.get('liveReminders/sched9');
  ok(stored && stored.status === 'pending', 'ticket persistido como pending');
  ok(stored.remindAt === rec.scheduledAt - 10 * MIN, 'remindAt correcto en el ticket');
  ok(stored.hostUid === 'host1' && stored.title === 'Noche de juegos', 'ticket con host y título');
  ok(tk && tk.id === 'sched9', 'writeReminderTicket devuelve el ticket');
  ok(html.indexOf('window.drexSchedWriteReminderTicket(d, sid, rec)') >= 0,
    'drexLiveSchedule escribe el ticket al programar');

  console.log('T4: remindAt alcanzado -> notificaciones a seguidores en su idioma');
  await seedBase({ scheduledAt: T0 + 10 * MIN }); // remindAt == T0
  const r4 = await API.pushCheck({ nowMs: T0, db, uid: 'host1' });
  ok(r4.fired === 1, 'pushCheck disparó 1 recordatorio (fired=' + r4.fired + ')');
  const w1 = writes.find((w) => w.uid === 'f1');
  const w2 = writes.find((w) => w.uid === 'f2');
  const w3 = writes.find((w) => w.uid === 'f3');
  ok(!!w1, 'f1 (en) recibió notificación');
  ok(w1.message === 'Ana goes live in a few minutes: Charla', 'mensaje EN correcto: ' + JSON.stringify(w1.message));
  ok(!!w2, 'f2 (zh) recibió notificación');
  ok(w2.message === 'Ana 将在几分钟后开始直播: Charla', 'mensaje ZH correcto: ' + JSON.stringify(w2.message));
  ok(!w3, 'f3 con opt-out fiestas=false NO recibió notificación');
  ok(w1.type === 'live', "type 'live'");
  ok(w1.meta && w1.meta.actionType === 'live' && w1.meta.schedId === 'sched1', 'meta con actionType live + schedId');
  const tAfter = await db.ref('liveReminders/sched1').once('value').then((s) => s.val());
  ok(tAfter && tAfter.status === 'sent', 'ticket marcado sent tras el envío');

  console.log('T5: cancelar -> sin notificaciones');
  await seedBase({ scheduledAt: T0 + 10 * MIN });
  await API.cancelReminderTicket(db, 'sched1');
  ok(!db._store.has('liveReminders/sched1'), 'ticket borrado al cancelar');
  const r5 = await API.pushCheck({ nowMs: T0, db, uid: 'host1' });
  ok(r5.fired === 0 && writes.length === 0, 'sin ticket no hay notificaciones');
  ok(html.indexOf('window.drexSchedCancelReminderTicket(d, schedId)') >= 0,
    'drexSchedDoCancel borra el ticket');
  // el programado cancelado tampoco debe disparar aunque el ticket sobreviviera
  // (ticket huérfano: el checker solo lee tickets de programados vigentes,
  // así que un huérfano jamás dispara; el cancel/start/end lo borra además).
  await seedBase({ scheduledAt: T0 + 10 * MIN });
  await db.ref('scheduledLives/sched1').update({ status: 'cancelled' });
  const r5b = await API.pushCheck({ nowMs: T0, db, uid: 'host1' });
  ok(r5b.fired === 0 && writes.length === 0, 'programado cancelado no dispara: sin recordatorios fantasma');

  console.log('T6: catch-up al abrir la app');
  await seedBase({ scheduledAt: T0 + 5 * MIN }); // remindAt = T0-5min (vencido), live en +5min
  const r6 = await API.pushCheck({ nowMs: T0, db, uid: 'host1' });
  ok(r6.fired === 1 && writes.length === 2, 'recordatorio vencido con live futuro dispara al abrir');
  await seedBase({ scheduledAt: T0 - 120 * MIN }); // live hace 2h
  const r6b = await API.pushCheck({ nowMs: T0, db, uid: 'host1' });
  ok(r6b.fired === 0 && writes.length === 0, 'live pasado hace 2h no dispara');
  ok(html.indexOf('window.drexSchedPushCheck()') >= 0, 'el tick invoca drexSchedPushCheck');
  ok(html.indexOf('window.drexSchedBoot = function') >= 0, 'drexSchedBoot existe (corre el tick al abrir)');

  console.log('T7: claim atómico (dos dispositivos del anfitrión)');
  await seedBase({ scheduledAt: T0 + 10 * MIN, ticketExtra: { status: 'sending', claimedAt: T0 } });
  const r7 = await API.pushCheck({ nowMs: T0, db, uid: 'host1' });
  ok(r7.fired === 0 && writes.length === 0, 'ticket ya reclamado no reenvía');

  console.log('T8: i18n ES/EN/ZH/PT marcadas /* ITEM4-SCHEDREM */');
  const pairs = [
    ['"{n} empieza en vivo en unos minutos":"{n} goes live in a few minutes"', 'EN mensaje'],
    ['"{n} empieza en vivo en unos minutos":"{n} 将在几分钟后开始直播"', 'ZH mensaje'],
    ['"{n} empieza en vivo en unos minutos":"{n} entra ao vivo em alguns minutos"', 'PT mensaje'],
    ['"Recordatorio enviado a tus seguidores":"Reminder sent to your followers"', 'EN toast'],
    ['"Recordatorio enviado a tus seguidores":"已向你的粉丝发送提醒"', 'ZH toast'],
    ['"Recordatorio enviado a tus seguidores":"Lembrete enviado aos seus seguidores"', 'PT toast'],
  ];
  for (const [p, label] of pairs) ok(i18nSrc.indexOf(p) >= 0, label);
  const marks = i18nSrc.split('/* ITEM4-SCHEDREM */').length - 1;
  ok(marks === 6, '6 marcas ITEM4-SCHEDREM en drex-i18n.js (hay ' + marks + ')');
  // las traducciones reales resuelven vía appTForLang
  ok(API.appTForLang('{n} empieza en vivo en unos minutos', 'en') === '{n} goes live in a few minutes', 'appTForLang EN');
  ok(API.appTForLang('{n} empieza en vivo en unos minutos', 'zh') === '{n} 将在几分钟后开始直播', 'appTForLang ZH');
  ok(API.appTForLang('{n} empieza en vivo en unos minutos', 'pt') === '{n} entra ao vivo em alguns minutos', 'appTForLang PT');
  ok(API.appTForLang('{n} empieza en vivo en unos minutos', 'es') === '{n} empieza en vivo en unos minutos', 'appTForLang ES = clave');

  console.log('T9: wiring misceláneo');
  ok(html.indexOf("if (type === 'live') return 'fiestas';") >= 0, "type 'live' respeta el bucket 'fiestas'");
  ok(html.indexOf('msgFor(fid)') >= 0, 'notifyFollowersOfNewContent soporta msgFor por destinatario');
  ok(html.indexOf("actionType: 'live'") >= 0, "meta actionType 'live' en el envío");
  ok(html.indexOf("await __sdb.ref('liveReminders/' + __schedId).remove();") >= 0, 'ticket limpiado al arrancar el live');
  ok(html.indexOf("await __edb.ref('liveReminders/' + __esched).remove();") >= 0, 'ticket limpiado al terminar el live');

  /* ---------- T10: parche Lambda (entrega diferida) ---------- */
  console.log('T10: parche Lambda para la entrega diferida real');
  const patchPath = require('path').join(__dirname, '..', 'docs', 'C253-LAMBDA-SCHEDREMINDERS.patch');
  const patch = fs.readFileSync(patchPath, 'utf8');
  ok(patch.includes("at === 'live'") && patch.includes('envivo/'),
    'el parche añade el deep-link live en deepLink()');
  ok(patch.includes('schedulerHandler'),
    'el parche añade el handler de EventBridge Scheduler');
  ok(patch.includes('PENDIENTE DE DEPLOY'),
    'el parche queda marcado PENDIENTE DE DEPLOY');

  console.log('\nVERDE: test-c253-sched-remind.js (' + passed + ' checks)');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
