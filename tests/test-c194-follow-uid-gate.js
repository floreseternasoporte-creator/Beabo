// C194 — regresión: uid forjado en requestOrFollowUser / followAuthor.
//
// HALLAZGO (PoC D1/D2, Chromium real vía CDP, base a83ee0d5): un targetUserId
// forjado con '/' (note.authorId / comment.authorId manipulado por el autor;
// llega crudo a getQuickFollowButtonMarkup → quickFollowUser →
// requestOrFollowUser, y a currentViewedAuthorId vía openAuthorProfile) llegaba
// CRUDO a:
//   D1 requestOrFollowUser('foo/bar'):
//     set followers/foo/bar/<me>              (anidado: corrompe la forma de
//     set following/<me>/foo/bar               la lista — el snapshot superior
//     transactionBlind users/foo/bar/          ve 'foo' como UID)
//       followersCount                        (basura bajo users/foo)
//     push notifications/foo/bar/<id>         (aviso en namespace forjado)
//     transactionBlind notifUnread/foo/bar
//   D2 followAuthor() unfollow con currentViewedAuthorId='foo/bar':
//     remove followers/foo/bar/<me>           (DESTRUCTIVO: borra bajo
//     remove following/<me>/foo/bar            users/foo)
//     transaction users/foo/bar/followersCount
// ANTES de cualquier validación. Parche: gate `isValidChatUid` al inicio de
// requestOrFollowUser (cubre feed, perfil y quick-follow: punto único de
// "seguir") y al inicio de followAuthor (cubre la rama unfollow con writes
// directos).
//
// Decisiones documentadas (PoC D3/D4, sin parche):
// - respondToFollowRequest: el requesterUid real viene de child.key
//   (las keys RTDB no admiten '/'); además la guarda C44-C1 (lectura previa
//   de followRequests/<me>/<requesterUid>) hace early-return con uid forjado
//   → 0 escrituras. El assert estático 'sin-gate' fija la decisión.
// - hydrateQuickFollowButtons: solo once('value') (lecturas); 0 escrituras.
// - recipientUid/currentChatRecipient y viewerUid (drexAntesalaShouldRequestFor):
//   solo lecturas; la escritura de mensajes la estrangula el gate C191.
//
// Test híbrido: asserts estáticos (fallan en base) + conductuales en sandbox
// vm con DrexCloud programable que registra escrituras (FAIL en base, PASS
// con parche). Uso: node tests/test-c194-follow-uid-gate.js [--target=html]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(__dirname, '..', 'index.html');
let html;
try { html = fs.readFileSync(htmlPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer index.html'); process.exit(1); }

let failures = 0;
function ok(name, cond) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name); }
}
function tcase(name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') return r.then(
    () => console.log('ok - ' + name),
    (e) => { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); });
    console.log('ok - ' + name); return Promise.resolve(); }
  catch (e) { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); return Promise.resolve(); }
}
function extractFn(src, declLine) {
  const declIdx = src.indexOf(declLine);
  if (declIdx < 0) throw new Error('declaración no encontrada: ' + declLine);
  // balancear parámetros (puede haber '{}' en defaults) y luego el cuerpo
  // (string-aware: ignora llaves dentro de strings/templates/comentarios)
  let paren = 0, i = src.indexOf('(', declIdx);
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')') { paren--; if (paren === 0) break; }
  }
  let j = src.indexOf('{', i), depth = 0;
  const n = src.length;
  for (; j < n; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; j++;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === q) break;
        if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
          let dd = 1; j += 2;
          while (j < n && dd > 0) { if (src[j] === '{') dd++; else if (src[j] === '}') dd--; j++; }
          continue;
        }
        j++;
      }
      continue;
    }
    if (c === '/' && (src[j + 1] === '/' || src[j + 1] === '*')) {
      if (src[j + 1] === '/') { const k = src.indexOf('\n', j); j = k < 0 ? n : k; }
      else { const k = src.indexOf('*/', j + 2); j = k < 0 ? n : k + 1; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(declIdx, j + 1); }
  }
  throw new Error('cierre no encontrado: ' + declLine);
}

// ---------- asserts estáticos (fallan en base) ----------
const followSrc = extractFn(html, 'async function requestOrFollowUser(targetUserId,');
const authorSrc = extractFn(html, 'function followAuthor()');
const respondSrc = extractFn(html, 'async function respondToFollowRequest(requesterUid, accept)');
const hydrateSrc = extractFn(html, 'function hydrateQuickFollowButtons(root');
ok('estático: requestOrFollowUser valida targetUserId con isValidChatUid',
  /isValidChatUid\(targetUserId\)/.test(followSrc));
ok('estático: el gate va ANTES del primer ref con targetUserId',
  followSrc.indexOf('isValidChatUid(targetUserId)') >= 0 &&
  followSrc.indexOf('isValidChatUid(targetUserId)') < followSrc.indexOf("'followers/' + targetUserId"));
ok('estático: followAuthor valida currentViewedAuthorId con isValidChatUid',
  /isValidChatUid\(currentViewedAuthorId\)/.test(authorSrc));
ok('estático: el gate de followAuthor va ANTES del primer ref con currentViewedAuthorId',
  authorSrc.indexOf('isValidChatUid(currentViewedAuthorId)') >= 0 &&
  authorSrc.indexOf('isValidChatUid(currentViewedAuthorId)') < authorSrc.indexOf("'followers/' + currentViewedAuthorId"));
ok('estático: respondToFollowRequest NO lleva gate (decisión D3: guarda C44-C1 de lectura previa; uid real = child.key)',
  !/isValidChatUid/.test(respondSrc) && /!reqSnap \|\| !reqSnap\.exists\(\)/.test(respondSrc));
ok('estático: hydrateQuickFollowButtons NO lleva gate (decisión D4: 0 escrituras DB)',
  !/\.set\(|\.update\(|transactionBlind\(|transaction\(|[A-Za-z_$][\w$]*Ref\.remove\(/.test(hydrateSrc));

// ---------- conductuales en vm ----------
function fullKey(base, key) {
  return (key === '<set>' || key === '<remove>') ? base : (base ? base + '/' + key : base);
}
function makeCtx(existingPaths) {
  const writes = [], tx = [];
  const refStub = (p) => {
    const base = (p == null ? '' : String(p));
    return {
      once: async () => {
        const ex = existingPaths.has(base);
        return { exists: () => ex, val: () => (ex ? {} : null) };
      },
      update: async (u) => {
        const ks = Object.keys(u || {});
        ks.forEach(k => writes.push({ op: 'update', base, key: k }));
      },
      set: async () => { writes.push({ op: 'set', base, key: '<set>' }); },
      remove: async () => { writes.push({ op: 'remove', base, key: '<remove>' }); },
      transactionBlind: async () => { tx.push(base); },
      transaction: async () => { tx.push(base); return { committed: true, snapshot: { val: () => 0 } }; },
      push: function () {
        const c = refStub(base + '/pushid1'); c.key = 'pushid1'; return c;
      }
    };
  };
  const sandbox = {
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'u1', displayName: 'T', photoURL: '' } }),
      database: () => ({ ref: refStub })
    },
    document: { getElementById: () => null },
    window: {},
    showMiniToast: () => {},
    appT: (s) => s,
    formatNumber: (n) => String(n),
    updateFollowIcon: () => {},
    translations: { es: { followSelfError: 'SELF' } },
    currentLanguage: 'es',
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    console
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext('let _notifActorCache = null, _notifActorPromise = null;\nconst _notifPrefCache = {};', ctx);
  vm.runInContext('const _privacyAccountCache = new Map();\nconst _followApprovedCache = new Map();', ctx);
  vm.runInContext('const _followBusyByTarget = new Set();\nlet currentViewedAuthorId = null;', ctx);
  const load = (decl, fnName, alias) => vm.runInContext(extractFn(html, decl) + '\nthis.' + alias + ' = ' + fnName + ';', ctx);
  load('function isValidChatUid(uid)', 'isValidChatUid', '__v');
  load('function notifTypeToPrefKey(type, meta)', 'notifTypeToPrefKey', '__ntk');
  load('function _isRetryableNetError(err)', '_isRetryableNetError', '__ret');
  load('function _runWithAutoRetry(operation, label)', '_runWithAutoRetry', '__retry');
  load('async function isAccountPrivate(uid)', 'isAccountPrivate', '__priv');
  load('function _invalidatePrivacyCaches(authorId)', '_invalidatePrivacyCaches', '__inv');
  load('async function shouldSkipNotificationFor(userId, type, meta)', 'shouldSkipNotificationFor', '__skip');
  load('function bumpNotifUnread(userId)', 'bumpNotifUnread', '__bump');
  load('function getNotifActorInfo()', 'getNotifActorInfo', '__actor');
  load('async function addNotification(', 'addNotification', '__notif');
  load('async function requestOrFollowUser(targetUserId,', 'requestOrFollowUser', '__follow');
  load('function followAuthor()', 'followAuthor', '__author');
  return { ctx, writes, tx };
}
const allKeys = (writes, tx) =>
  writes.map(w => fullKey(w.base, w.key)).concat(tx);

(async () => {
  await tcase('conductual: requestOrFollowUser("foo/bar") -> 0 escrituras con uid anidado', async () => {
    const { ctx, writes, tx } = makeCtx(new Set());
    vm.runInContext('__follow("foo/bar", {});', ctx);
    await new Promise(r => setTimeout(r, 300));
    const nested = allKeys(writes, tx).filter(k => k.includes('foo/bar'));
    if (nested.length) throw new Error('escrituras anidadas: ' + nested.join(','));
    if (writes.length || tx.length) throw new Error('se escribió con uid inválido: ' + allKeys(writes, tx).join(','));
  });
  await tcase('conductual: requestOrFollowUser(uid real) sigue escribiendo (sin regresión)', async () => {
    const { ctx, writes, tx } = makeCtx(new Set());
    vm.runInContext('__follow("uidreal999", {});', ctx);
    await new Promise(r => setTimeout(r, 300));
    const keys = allKeys(writes, tx);
    if (!keys.includes('followers/uidreal999/u1')) throw new Error('falta followers: ' + keys.join(','));
    if (!keys.includes('following/u1/uidreal999')) throw new Error('falta following: ' + keys.join(','));
    if (!tx.includes('users/uidreal999/followersCount')) throw new Error('falta tx: ' + tx.join(','));
  });
  await tcase('conductual: followAuthor unfollow con currentViewedAuthorId="foo/bar" -> 0 escrituras', async () => {
    const { ctx, writes, tx } = makeCtx(new Set(['followers/foo/bar/u1']));
    vm.runInContext('currentViewedAuthorId = "foo/bar"; __author();', ctx);
    await new Promise(r => setTimeout(r, 400));
    const nested = allKeys(writes, tx).filter(k => k.includes('foo/bar'));
    if (nested.length) throw new Error('escrituras anidadas: ' + nested.join(','));
    if (writes.length || tx.length) throw new Error('se escribió con uid inválido: ' + allKeys(writes, tx).join(','));
  });
  await tcase('conductual: followAuthor(uid real) delega a requestOrFollowUser (sin regresión)', async () => {
    const { ctx, writes, tx } = makeCtx(new Set());
    vm.runInContext('currentViewedAuthorId = "uidreal999"; __author();', ctx);
    await new Promise(r => setTimeout(r, 400));
    const keys = allKeys(writes, tx);
    if (!keys.includes('followers/uidreal999/u1')) throw new Error('falta followers: ' + keys.join(','));
  });
  console.log(failures === 0 ? 'ALL PASS' : 'FAILURES=' + failures);
  process.exit(failures === 0 ? 0 : 1);
})();
