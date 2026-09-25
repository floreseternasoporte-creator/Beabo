// C195 — regresión: artistId forjado en musicToggleFollowArtist.
//
// HALLAZGO (PoC D1, Chromium real vía CDP, base 6349e93f): musicToggleFollowArtist
// recibía el artistId crudo de t.authorId (musicQueue — el autor de la pista lo
// forja al subirla: el cliente arma `meta` y RTDB es client-writable) y con
// 'foo/bar' ejecutaba ESCRITURAS ANIDADAS antes de cualquier validación:
//   set followers/foo/bar/<me>
//   set following/<me>/foo/bar
//   transactionBlind users/foo/bar/followersCount
//   push notifications/foo/bar/<pushId>   (vía addNotification)
//   transactionBlind notifUnread/foo/bar  (vía bumpNotifUnread)
// (y en la rama unfollow: removes anidados + transaction destructiva).
// Parche: gate `isValidChatUid(artistId)` al inicio de musicToggleFollowArtist
// (punto único de "seguir artista" en música).
//
// Decisiones documentadas (PoC D2/D3/D4, sin parche):
// - voteMusicTrack: con t.id='foo/bar' la transaction sobre musicTracks/foo/bar
//   se ABORTA (updater devuelve undefined con tr null) → early-return, 0
//   escrituras; musicWeekly/<semana>/foo/bar es inalcanzable (solo tras commit
//   y un track con '/' no existe: las keys vienen de push()). El assert
//   estático 'sin-gate' fija la decisión.
// - deleteMusicTrack: la guarda `if (!t || t.authorId !== uid)` (lectura previa
//   del track) hace early-return con id forjado → 0 escrituras.
// - musicLoadFollowState: solo once('value') (lecturas); 0 escrituras.
// - groupId (postsByGroup): los ids de grupo vienen de push() (key-safe) y el
//   groupId publicado lo elige la propia víctima en el composer.
// - fiestaCur.id/sid: push keys + las escrituras de fiestaGameSecrets las hace
//   solo el dueño (fiestaAmHost).
// - subId (pushSubscriptions): '_drexPushSubId' es hash djb2 ('s'+base36,
//   sin '/') del endpoint del PROPIO dispositivo, bajo el uid propio.
// - commentPath/safeVoteKey: los commentId vienen de push().key; el único '/'
//   lo construye el código ('replies'); los votos viven bajo el uid propio y
//   updateExistingComment exige comment.authorId === user.uid en el updater.
//
// Test híbrido: asserts estáticos (fallan en base) + conductuales en sandbox
// vm con DrexCloud programable que registra escrituras (FAIL en base, PASS
// con parche). Uso: node tests/test-c195-music-artist-uid-gate.js [--target=html]
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
const toggleSrc = extractFn(html, 'window.musicToggleFollowArtist = async function (artistId) {');
const voteSrc = extractFn(html, 'window.voteMusicTrack = function (voteType) {');
const deleteSrc = extractFn(html, 'window.deleteMusicTrack = async function (trackId) {');
const loadFollowSrc = extractFn(html, 'function musicLoadFollowState() {');
ok('estático: musicToggleFollowArtist valida artistId con isValidChatUid',
  /isValidChatUid\(artistId\)/.test(toggleSrc));
ok('estático: el gate va ANTES del primer ref con artistId',
  toggleSrc.indexOf('isValidChatUid(artistId)') >= 0 &&
  toggleSrc.indexOf('isValidChatUid(artistId)') < toggleSrc.indexOf("'followers/' + artistId"));
ok('estático: voteMusicTrack NO lleva gate (decisión D2: tx abortada + early-return)',
  !/isValidChatUid/.test(voteSrc) && /if \(!tr\) return undefined;/.test(voteSrc));
ok('estático: deleteMusicTrack NO lleva gate (decisión D3: guarda t.authorId !== uid)',
  !/isValidChatUid/.test(deleteSrc) && /if \(!t \|\| t\.authorId !== uid\)/.test(deleteSrc));
ok('estático: musicLoadFollowState NO lleva gate (decisión D4: 0 escrituras DB)',
  !/\.set\(|\.update\(|transactionBlind\(|transaction\(|[A-Za-z_$][\w$]*Ref\.remove\(/.test(loadFollowSrc));

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
      },
      child: function (k) { return refStub(base ? base + '/' + k : k); }
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
    musicPaintFollowButtons: () => {},
    musicPaintFollowBtn: () => {},
    musicPaintArtistFollowBtn: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    console
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext('let _notifActorCache = null, _notifActorPromise = null;\nconst _notifPrefCache = {};', ctx);
  vm.runInContext('const _privacyAccountCache = new Map();\nconst _followApprovedCache = new Map();', ctx);
  vm.runInContext('let musicQueue = [], musicQueueIdx = 0;', ctx);
  const load = (decl, fnName, alias) => vm.runInContext(extractFn(html, decl) + '\nthis.' + alias + ' = ' + fnName + ';', ctx);
  load('function isValidChatUid(uid)', 'isValidChatUid', '__v');
  load('function notifTypeToPrefKey(type, meta)', 'notifTypeToPrefKey', '__ntk');
  load('function _isRetryableNetError(err)', '_isRetryableNetError', '__ret');
  load('function _runWithAutoRetry(operation, label)', '_runWithAutoRetry', '__retry');
  load('async function isAccountPrivate(uid)', 'isAccountPrivate', '__priv');
  load('async function shouldSkipNotificationFor(userId, type, meta)', 'shouldSkipNotificationFor', '__skip');
  load('function bumpNotifUnread(userId)', 'bumpNotifUnread', '__bump');
  load('function getNotifActorInfo()', 'getNotifActorInfo', '__actor');
  load('async function addNotification(', 'addNotification', '__notif');
  load('function musicDb()', 'musicDb', '__mdb');
  vm.runInContext(extractFn(html, 'window.musicToggleFollowArtist = async function (artistId) {') + '\nthis.__toggle = window.musicToggleFollowArtist;', ctx);
  return { ctx, writes, tx };
}
const allKeys = (writes, tx) =>
  writes.map(w => fullKey(w.base, w.key)).concat(tx);

(async () => {
  await tcase('conductual: musicToggleFollowArtist("foo/bar") -> 0 escrituras con artistId anidado', async () => {
    const { ctx, writes, tx } = makeCtx(new Set());
    vm.runInContext('__toggle("foo/bar");', ctx);
    await new Promise(r => setTimeout(r, 400));
    const nested = allKeys(writes, tx).filter(k => k.includes('foo/bar'));
    if (nested.length) throw new Error('escrituras anidadas: ' + nested.join(','));
    if (writes.length || tx.length) throw new Error('se escribió con artistId inválido: ' + allKeys(writes, tx).join(','));
  });
  await tcase('conductual: musicToggleFollowArtist("foo/bar") vía t.authorId forjado -> 0 escrituras', async () => {
    const { ctx, writes, tx } = makeCtx(new Set());
    vm.runInContext('musicQueue = [{ id: "trk1", authorId: "foo/bar" }]; musicQueueIdx = 0; __toggle(null);', ctx);
    await new Promise(r => setTimeout(r, 400));
    const nested = allKeys(writes, tx).filter(k => k.includes('foo/bar'));
    if (nested.length) throw new Error('escrituras anidadas: ' + nested.join(','));
    if (writes.length || tx.length) throw new Error('se escribió con artistId inválido: ' + allKeys(writes, tx).join(','));
  });
  await tcase('conductual: musicToggleFollowArtist(uid real) sigue escribiendo (sin regresión)', async () => {
    const { ctx, writes, tx } = makeCtx(new Set());
    vm.runInContext('__toggle("artistreal999");', ctx);
    await new Promise(r => setTimeout(r, 400));
    const keys = allKeys(writes, tx);
    if (!keys.includes('followers/artistreal999/u1')) throw new Error('falta followers: ' + keys.join(','));
    if (!keys.includes('following/u1/artistreal999')) throw new Error('falta following: ' + keys.join(','));
    if (!tx.includes('users/artistreal999/followersCount')) throw new Error('falta tx: ' + tx.join(','));
  });
  console.log(failures === 0 ? 'ALL PASS' : 'FAILURES=' + failures);
  process.exit(failures === 0 ? 0 : 1);
})();
