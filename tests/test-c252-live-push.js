// Test C252 — Push "está en vivo" a seguidores (carril 1).
//
// Flujo: DrexLiveCore.prototype.createLive → .then() → drexLiveNotifyFollowers
// → reclama lives/<liveId>/livePushSent por transacción (UN solo fan-out por
// live) → notifyFollowersOfNewContent(type 'live') con mensaje redactado en
// el idioma del DESTINATARIO (userSettings/<uid>/appLanguage, caché 10 min).
// El opt-out 'fiestas' (notifTypeToPrefKey: 'live' → 'fiestas') se respeta vía
// shouldSkipNotificationFor dentro de addNotification. El tap en la
// notificación in-app (actionType 'live') abre el visor como espectador
// (handleNotificationNavigation → window.drexLiveJoin).
//
// Test híbrido: asserts estáticos (fallan en base) + conductuales en sandbox
// vm con DrexCloud programable (mock RTDB en memoria con transaction fiel,
// forEach en snapshots y registro de escrituras). FAIL en base, PASS con parche.
// Uso: node tests/test-c252-live-push.js [--target=html]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(__dirname, '..', 'index.html');
const i18nPath = path.join(path.dirname(htmlPath), 'drex-i18n.js');
let html;
try { html = fs.readFileSync(htmlPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer index.html'); process.exit(1); }

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name + (extra ? ' :: ' + extra : '')); }
}
function tcase(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(
      () => console.log('ok - ' + name),
      (e) => { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); });
    console.log('ok - ' + name); return Promise.resolve();
  } catch (e) { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); return Promise.resolve(); }
}
function extractFn(src, declLine) {
  const declIdx = src.indexOf(declLine);
  if (declIdx < 0) throw new Error('declaración no encontrada: ' + declLine);
  let paren = 0, i = src.indexOf('(', declIdx);
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')') { paren--; if (paren === 0) break; }
  }
  let j = src.indexOf('{', i), depth = 0;
  const n = src.length;
  let inStr = null;
  for (; j < n; j++) {
    const c = src[j];
    if (inStr) {
      if (c === '\\') { j++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(declIdx, j + 1); }
  }
  throw new Error('cierre no encontrado: ' + declLine);
}

// ---------- asserts estáticos (fallan en base) ----------
try {
  const liveFn = extractFn(html, 'async function drexLiveNotifyFollowers(liveId, hostUid, hostName, title)');
  ok('estático: existe drexLiveNotifyFollowers', true);
  ok('estático: reclama lives/<liveId>/livePushSent por transacción',
    /livePushSent/.test(liveFn) && /\.transaction\s*\(/.test(liveFn));
  ok('estático: aborta si ya fue reclamado (anti doble envío)',
    /if\s*\(cur\)\s*return undefined/.test(liveFn));
  ok('estático: fan-out vía notifyFollowersOfNewContent con type \'live\'',
    /notifyFollowersOfNewContent\s*\(\s*hostUid\s*,\s*hostName\s*,\s*'live'/.test(liveFn));
  ok('estático: meta lleva actionType/actionId para el tap',
    /actionType:\s*'live'/.test(liveFn) && /actionId:\s*liveId/.test(liveFn));
  ok('estático: el mensaje se redacta en el idioma del destinatario',
    /drexLiveRecipientLang/.test(liveFn) && /drexLiveNotifMessage/.test(liveFn));
} catch (e) { ok('estático: existe drexLiveNotifyFollowers', false, e.message); }

ok('estático: createLive llama a drexLiveNotifyFollowers en el .then() tras ref.set(doc)',
  (() => { try {
    const cl = extractFn(html, 'DrexLiveCore.prototype.createLive = function (o)');
    return /ref\.set\(doc\)\.then/.test(cl) && /drexLiveNotifyFollowers\(liveId,\s*self\._user\.uid/.test(cl);
  } catch (_) { return false; } })());
ok('estático: la llamada en createLive no está condicionada a featured (la cuenta destacada usa el mismo mecanismo)',
  (() => { try {
    const cl = extractFn(html, 'DrexLiveCore.prototype.createLive = function (o)');
    const i = cl.indexOf('drexLiveNotifyFollowers(liveId');
    return i > 0 && !/featured/i.test(cl.slice(Math.max(0, i - 200), i));
  } catch (_) { return false; } })());

ok('estático: type \'live\' respeta el opt-out \'fiestas\'',
  (() => { try {
    const k = extractFn(html, 'function notifTypeToPrefKey(type, meta)');
    return /type\s*===\s*'live'/.test(k) && /'fiestas'/.test(k);
  } catch (_) { return false; } })());

ok('estático: el tap en notificación \'live\' abre el visor como espectador',
  (() => { try {
    const h = extractFn(html, 'function handleNotificationNavigation(notification)');
    return /case\s*'live':/.test(h) && /drexLiveJoin\(actionId\)/.test(h);
  } catch (_) { return false; } })());

// i18n: la clave existe en los 3 diccionarios de drex-i18n.js
try {
  const i18n = fs.readFileSync(i18nPath, 'utf8');
  const keyRe = /"está en vivo ahora"/g;
  const count = (i18n.match(keyRe) || []).length;
  ok('estático: clave "está en vivo ahora" en EN/ZH/PT (drex-i18n.js)', count === 3, 'apariciones=' + count);
  ok('estático: inserts i18n marcados ITEM2-LIVEPUSH', (i18n.match(/ITEM2-LIVEPUSH/g) || []).length === 3);
} catch (e) { ok('estático: drex-i18n.js legible', false, e.message); }

// ---------- sandbox conductual ----------
function makeCtx() {
  const writes = [];
  const db = {};
  const segsOf = p => String(p).split('/').filter(s => s.length > 0);
  const deep = v => (v === undefined || v === null) ? v : JSON.parse(JSON.stringify(v));
  const get = p => { let n = db; for (const s of segsOf(p)) { if (n == null || typeof n !== 'object') return undefined; n = n[s]; } return n; };
  const set = (p, v) => { const sgs = segsOf(p); let n = db; for (let i = 0; i < sgs.length - 1; i++) { if (n[sgs[i]] == null || typeof n[sgs[i]] !== 'object') n[sgs[i]] = {}; n = n[sgs[i]]; } n[sgs[sgs.length - 1]] = v; };
  const snap = (v, rpath) => ({
    exists: () => v !== undefined && v !== null,
    val: () => (v === undefined || v === null) ? null : deep(v),
    forEach: (cb) => { if (v && typeof v === 'object') for (const k of Object.keys(v)) cb({ key: k }); },
  });
  let pushN = 0;
  function mkRef(rpath) {
    return {
      _p: rpath,
      once: async () => snap(get(rpath), rpath),
      set: async (v) => { writes.push({ op: 'set', base: rpath }); set(rpath, deep(v)); },
      update: async (u) => { writes.push({ op: 'update', base: rpath }); for (const k of Object.keys(u || {})) set(rpath + '/' + k, deep(u[k])); },
      remove: async () => { writes.push({ op: 'remove', base: rpath }); },
      transaction: (fn, onComplete) => {
        const cur = get(rpath);
        let res;
        try { res = fn(deep(cur === undefined ? null : cur)); }
        catch (e) { if (typeof onComplete === 'function') onComplete(e, false, snap(cur)); return Promise.resolve({ committed: false }); }
        if (res === undefined) { if (typeof onComplete === 'function') onComplete(null, false, snap(cur)); return Promise.resolve({ committed: false }); }
        writes.push({ op: 'txn', base: rpath }); set(rpath, deep(res));
        if (typeof onComplete === 'function') onComplete(null, true, snap(res));
        return Promise.resolve({ committed: true });
      },
      transactionBlind: (fn) => {
        const cur = get(rpath);
        let res;
        try { res = fn(deep(cur === undefined ? null : cur)); } catch (e) { return Promise.resolve({ committed: false }); }
        if (res === undefined) return Promise.resolve({ committed: false });
        writes.push({ op: 'txnBlind', base: rpath }); set(rpath, deep(res));
        return Promise.resolve({ committed: true });
      },
      push: () => { const k = 'push_t' + (++pushN); const c = mkRef(rpath + '/' + k); c.key = k; return c; },
    };
  }
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'h1', displayName: 'Host', photoURL: '' } }),
      database: () => ({ ref: (p) => mkRef(String(p)) }),
    },
    fireDrexSystemNotification: () => {},
    APP_ENGLISH_TEXT: { 'está en vivo ahora': 'is live now' },
    APP_CHINESE_TEXT: { 'está en vivo ahora': '正在直播' },
    APP_PORTUGUESE_TEXT: { 'está en vivo ahora': 'está ao vivo agora' },
    __db: db, __writes: writes,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext('let _notifActorCache = null, _notifActorPromise = null;\nconst _notifPrefCache = {};\nconst _drexLiveLangCache = {};', ctx);
  const load = (decl, fnName, alias) => vm.runInContext(extractFn(html, decl) + '\nthis.' + alias + ' = ' + fnName + ';', ctx);
  load('function isValidChatUid(uid)', 'isValidChatUid', '__v');
  load('function notifTypeToPrefKey(type, meta)', 'notifTypeToPrefKey', '__ntk');
  load('function _isRetryableNetError(err)', '_isRetryableNetError', '__ret');
  load('function _runWithAutoRetry(operation, label)', '_runWithAutoRetry', '__retry');
  load('async function shouldSkipNotificationFor(userId, type, meta)', 'shouldSkipNotificationFor', '__skip');
  load('function bumpNotifUnread(userId)', 'bumpNotifUnread', '__bump');
  load('function notifyFollowersOfNewContent(authorId, authorName, type, message, meta, msgFor)', 'notifyFollowersOfNewContent', '__fanout');
  load('async function addNotification(', 'addNotification', '__notif');
  load('function drexLiveNotifT(esText, lang)', 'drexLiveNotifT', '__livet');
  load('function drexLiveNotifMessage(hostName, title, lang)', 'drexLiveNotifMessage', '__msg');
  load('async function drexLiveRecipientLang(uid)', 'drexLiveRecipientLang', '__lang');
  load('async function drexLiveNotifyFollowers(liveId, hostUid, hostName, title)', 'drexLiveNotifyFollowers', '__live');
  return { ctx, writes, db };
}

function seedBase(ctx) {
  vm.runInContext(`
    __db.followers = { h1: { f_en: true, f_zh: true, f_pt: true, f_es: true, f_opt: true, h1: true } };
    __db.userSettings = {
      f_en: { appLanguage: 'en' },
      f_zh: { appLanguage: 'zh' },
      f_pt: { appLanguage: 'pt' },
      f_opt: { appLanguage: 'es', notifications: { fiestas: false } }
    };
  `, ctx);
}
const notifsFor = (db, fid) => {
  const box = db.notifications && db.notifications[fid];
  return box ? Object.values(box) : [];
};
const notifWrites = (writes) => writes.filter(w => w.op === 'set' && /^notifications\//.test(w.base));
function waitFor(cond, ms) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      let v = false;
      try { v = cond(); } catch (e) { return reject(e); }
      if (v) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('timeout esperando condición'));
      setTimeout(poll, 25);
    })();
  });
}

(async () => {
  await tcase('conductual U1: drexLiveNotifMessage redacta por idioma (stub dicts)', async () => {
    const { ctx } = makeCtx();
    const got = (n, t, l) => vm.runInContext(`__msg(${JSON.stringify(n)}, ${JSON.stringify(t)}, ${JSON.stringify(l)})`, ctx);
    if (got('Narayan', 'Charla', 'en') !== 'Narayan is live now: Charla') throw new Error('en: ' + got('Narayan', 'Charla', 'en'));
    if (got('Narayan', 'Charla', 'zh') !== 'Narayan 正在直播: Charla') throw new Error('zh');
    if (got('Narayan', 'Charla', 'pt') !== 'Narayan está ao vivo agora: Charla') throw new Error('pt');
    if (got('Narayan', 'Charla', 'es') !== 'Narayan está en vivo ahora: Charla') throw new Error('es');
    if (got('Narayan', '', 'en') !== 'Narayan is live now') throw new Error('sin título no lleva dos puntos');
    if (got('Narayan', 'T', 'fr') !== 'Narayan is live now: T') throw new Error('idioma desconocido cae a en (igual que appT)');
  });

  await tcase('conductual B1: live → cada seguidor recibe el push en SU idioma + meta live', async () => {
    const { ctx, writes, db } = makeCtx();
    seedBase(ctx);
    vm.runInContext(`__live('live1', 'h1', 'Narayan', 'Charla de prueba');`, ctx);
    await waitFor(() => notifsFor(db, 'f_en').length >= 1 && notifsFor(db, 'f_zh').length >= 1 &&
      notifsFor(db, 'f_pt').length >= 1 && notifsFor(db, 'f_es').length >= 1, 3000);
    const msg = fid => notifsFor(db, fid)[0].message;
    if (msg('f_en') !== 'Narayan is live now: Charla de prueba') throw new Error('f_en: ' + msg('f_en'));
    if (msg('f_zh') !== 'Narayan 正在直播: Charla de prueba') throw new Error('f_zh: ' + msg('f_zh'));
    if (msg('f_pt') !== 'Narayan está ao vivo agora: Charla de prueba') throw new Error('f_pt: ' + msg('f_pt'));
    if (msg('f_es') !== 'Narayan está en vivo ahora: Charla de prueba') throw new Error('f_es: ' + msg('f_es'));
    for (const fid of ['f_en', 'f_zh', 'f_pt', 'f_es']) {
      const n = notifsFor(db, fid)[0];
      if (n.type !== 'live') throw new Error(fid + ' type=' + n.type);
      if (n.actionType !== 'live' || n.actionId !== 'live1') throw new Error(fid + ' meta incompleta');
    }
    const claim = db.lives && db.lives.live1 && db.lives.live1.livePushSent;
    if (!claim || claim.by !== 'h1') throw new Error('claim no escrita: ' + JSON.stringify(claim));
  });

  await tcase('conductual B2: segundo aviso con el mismo liveId NO duplica (la transacción ya fue reclamada)', async () => {
    const { ctx, writes, db } = makeCtx();
    seedBase(ctx);
    vm.runInContext(`__live('live1', 'h1', 'Narayan', 'Charla');`, ctx);
    await waitFor(() => notifsFor(db, 'f_en').length >= 1, 3000);
    const before = notifWrites(writes).length;
    const claimsBefore = writes.filter(w => w.base === 'lives/live1/livePushSent').length;
    vm.runInContext(`__live('live1', 'h1', 'Narayan', 'Charla');`, ctx);
    await new Promise(r => setTimeout(r, 600));
    const after = notifWrites(writes).length;
    const claimsAfter = writes.filter(w => w.base === 'lives/live1/livePushSent').length;
    if (after !== before) throw new Error(`notificaciones duplicadas: ${before} → ${after}`);
    if (claimsAfter !== claimsBefore) throw new Error('el claim se reescribió');
  });

  await tcase('conductual B3: seguidor con opt-out fiestas=false NO recibe; el resto sí', async () => {
    const { ctx, writes, db } = makeCtx();
    seedBase(ctx);
    vm.runInContext(`__live('live1', 'h1', 'Narayan', 'Charla');`, ctx);
    await waitFor(() => notifsFor(db, 'f_en').length >= 1, 3000);
    await new Promise(r => setTimeout(r, 400));
    if (notifsFor(db, 'f_opt').length) throw new Error('f_opt recibió pese al opt-out');
    if (!notifsFor(db, 'f_es').length) throw new Error('f_es no recibió (regresión del fan-out)');
  });

  await tcase('conductual B4: el host no se auto-notifica', async () => {
    const { ctx, writes, db } = makeCtx();
    seedBase(ctx);
    vm.runInContext(`__live('live1', 'h1', 'Narayan', 'Charla');`, ctx);
    await waitFor(() => notifsFor(db, 'f_en').length >= 1, 3000);
    await new Promise(r => setTimeout(r, 400));
    if (notifsFor(db, 'h1').length) throw new Error('el host se auto-notificó');
  });

  await tcase('conductual B5: host sin seguidores → no falla, claim escrito, 0 avisos', async () => {
    const { ctx, writes, db } = makeCtx();
    vm.runInContext(`__live('liveX', 'h2', 'Otro', 'T');`, ctx);
    await new Promise(r => setTimeout(r, 500));
    if (notifWrites(writes).length) throw new Error('avisos inesperados: ' + JSON.stringify(notifWrites(writes)));
    const claim = db.lives && db.lives.liveX && db.lives.liveX.livePushSent;
    if (!claim || claim.by !== 'h2') throw new Error('claim no escrita para h2');
  });

  await tcase('conductual B6: notifyFollowersOfNewContent con string sigue igual (sin regresión)', async () => {
    const { ctx, writes, db } = makeCtx();
    seedBase(ctx);
    vm.runInContext(`__fanout('h1', 'Host', 'post', 'mensaje plano', {});`, ctx);
    await waitFor(() => notifsFor(db, 'f_en').length >= 1, 3000);
    if (notifsFor(db, 'f_en')[0].message !== 'mensaje plano') throw new Error('mensaje alterado');
    if (notifsFor(db, 'f_en')[0].type !== 'post') throw new Error('type alterado');
  });

  console.log(failures === 0 ? 'ALL OK' : 'FALLOS: ' + failures);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL (harness): ' + (e && e.message)); process.exit(1); });
