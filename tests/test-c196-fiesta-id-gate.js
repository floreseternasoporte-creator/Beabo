// C196 — regresión: fiestaId forjado en joinFiestaFromFeed/joinFiesta.
//
// HALLAZGO (PoC F1, Chromium real vía CDP, base a6e09cd1): el fiestaId viaja
// en el aviso del feed (note.fiestaId, forjable por el autor del aviso: el
// cliente arma la nota y RTDB es client-writable) y llegaba crudo a
// joinFiestaFromFeed/joinFiesta. Con fiestaId='foo/bar' + sub-objeto plantado
// por el anfitrión atacante en fiestas/foo/bar = {status:'live',...}, el
// cliente de la VÍCTIMA ejecutaba ESCRITURAS ANIDADAS:
//   remove fiestaSignals/foo/bar/<me>
//   set    fiestaMembers/foo/bar/<me>
//   push   fiestas/foo/bar/chat/<pushId>
// corrompiendo la forma de los árboles de la fiesta 'foo' (la clave 'bar'
// aparece entre las entradas de miembros).
// (C195 había revisado fiestaCur.id/sid solo por código y declarado "sin
// hallazgo": cubría las escrituras del dueño del juego, no el path de
// ENTRADA — este test fija el hueco real.)
// Parche: gate `isValidChatUid(fiestaId)` en joinFiestaFromFeed +
// `isValidChatUid(id)` en joinFiesta (defensa en profundidad: joinFiesta es
// quien ejecuta las escrituras). Los ids legítimos son push() keys (un solo
// segmento) → el gate no los toca.
//
// Decisiones documentadas SIN parche (PoC F2/F3/F4/F5, Chromium real):
// - groupId (postsByGroup): el sink lo ejecuta el PROPIO autor en su cliente
//   (writer==forger; las opciones del composer vienen de child.key,
//   key-safe). Sin víctima cross-client → contenido.
// - subId (pushSubscriptions): _drexPushSubId = 's'+djb2(endpoint).toString(36)
//   (charset [0-9a-z], sin '/'), bajo el uid propio → contenido.
// - commentPath/safeVoteKey: safeVoteKey = commentPath.replace(/\//g,'__')
//   (un solo segmento); la transaction de voteComment sobre un path forjado
//   es no-op; updateExistingComment aborta (updater→undefined) y exige
//   comment.authorId === user.uid; userCommentKey = pop() → contenido.
//
// Test híbrido: asserts estáticos (fallan en base) + conductuales en sandbox
// vm con DrexCloud programable que registra escrituras (FAIL en base, PASS
// con parche). Uso: node tests/test-c196-fiesta-id-gate.js [--target=html]
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
  const prevSig = (k) => {
    let p = k - 1;
    while (p >= 0 && ' \t\n\r'.includes(src[p])) p--;
    let w = '', q = p;
    while (q >= 0 && /[A-Za-z_$0-9]/.test(src[q])) { w = src[q] + w; q--; }
    return { ch: p >= 0 ? src[p] : '', word: w };
  };
  const skipRegex = (k) => {
    let p = k + 1, inClass = false;
    while (p < n) {
      const c = src[p];
      if (c === '\\') { p += 2; continue; }
      if (c === '\n') return -1;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) return p;
      p++;
    }
    return -1;
  };
  for (; j < n; j++) {
    const c = src[j];
    if (c === '"' || c === "'") {
      const q = c; j++;
      while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === q) break; j++; }
      continue;
    }
    if (c === '`') {
      j++;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') {
          let dd = 1; j += 2;
          while (j < n && dd > 0) { if (src[j] === '{') dd++; else if (src[j] === '}') dd--; j++; }
          continue;
        }
        j++;
      }
      continue;
    }
    if (c === '/' && src[j + 1] !== '/' && src[j + 1] !== '*') {
      const ps = prevSig(j);
      const isRegex = ps.ch === '' || '=(:,[!&|?{};+-*%~^<>'.includes(ps.ch) ||
        /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else)$/.test(ps.word);
      if (isRegex) { const e = skipRegex(j); if (e > 0) { j = e; continue; } }
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
const feedSrc = extractFn(html, 'async function joinFiestaFromFeed(fiestaId) {');
const joinSrc = extractFn(html, 'async function joinFiesta(id, asSpeaker) {');
ok('estático: joinFiestaFromFeed valida fiestaId con isValidChatUid',
  /isValidChatUid\(fiestaId\)/.test(feedSrc));
ok('estático: el gate va ANTES del primer ref con fiestaId',
  feedSrc.indexOf('isValidChatUid(fiestaId)') >= 0 &&
  feedSrc.indexOf('isValidChatUid(fiestaId)') < feedSrc.indexOf("'fiestas/' + fiestaId"));
ok('estático: joinFiesta valida id con isValidChatUid',
  /isValidChatUid\(id\)/.test(joinSrc));
ok('estático: el gate de joinFiesta va ANTES del primer ref con id',
  joinSrc.indexOf('isValidChatUid(id)') >= 0 &&
  joinSrc.indexOf('isValidChatUid(id)') < joinSrc.indexOf("'fiestaMembers/' + id"));

// ---------- decisiones sin parche (pasan en base y con parche) ----------
const voteSrc = extractFn(html, 'function voteComment(noteId, commentPath, voteType');
const editSrc = extractFn(html, 'function updateExistingComment(noteId, commentPath, newContent) {');
ok('estático: voteComment contiene safeVoteKey = commentPath con "/"->"__" (F4)',
  /safeVoteKey = commentPath\.replace\(\/\\\//.test(voteSrc));
ok('estático: updateExistingComment exige comment.authorId === user.uid (F5)',
  /comment\.authorId !== user\.uid/.test(editSrc));
ok('estático: las opciones de grupo del composer usan child.key (F2)',
  /items\.push\(\{ id: child\.key/.test(html));

// ---------- conductuales en vm ----------
function makeCtx(db) {
  const writes = [];
  const refStub = (p) => {
    const base = (p == null ? '' : String(p));
    const val = Object.prototype.hasOwnProperty.call(db, base) ? db[base] : undefined;
    return {
      child: (k) => refStub(base ? base + '/' + k : String(k)),
      once: async () => ({ exists: () => val !== undefined && val !== null,
        val: () => (val === undefined || val === null) ? null : JSON.parse(JSON.stringify(val)) }),
      set: async (v) => { writes.push({ op: 'set', base }); db[base] = v; },
      update: async (u) => { writes.push({ op: 'update', base }); },
      remove: async () => { writes.push({ op: 'remove', base }); delete db[base]; },
      push: function (v) { const c = refStub(base + '/pushid1'); c.key = 'pushid1'; writes.push({ op: 'push', base: base + '/pushid1' }); if (v !== undefined) db[base + '/pushid1'] = v; return c; },
      transaction: async (fn) => {
        const cur = (val === undefined || val === null) ? null : JSON.parse(JSON.stringify(val));
        const nv = fn(cur);
        if (nv === undefined) { writes.push({ op: 'transaction', base, aborted: true }); return { committed: false, snapshot: { val: () => cur } }; }
        writes.push({ op: 'transaction', base, aborted: false }); db[base] = nv;
        return { committed: true, snapshot: { val: () => JSON.parse(JSON.stringify(nv)) } };
      },
      transactionBlind: async (fn) => {
        const cur = (val === undefined || val === null) ? null : JSON.parse(JSON.stringify(val));
        const nv = fn(cur);
        if (nv === undefined) { writes.push({ op: 'transactionBlind', base, aborted: true }); return { committed: false, snapshot: null }; }
        writes.push({ op: 'transactionBlind', base, aborted: false }); db[base] = nv;
        return { committed: true, snapshot: null };
      },
      onDisconnect: () => ({ remove: async () => {}, set: async () => {}, cancel: () => {} }),
      orderByChild: function () { return this; }, equalTo: function () { return this; }, limitToLast: function () { return this; },
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
    fiestaMyProfile: async () => ({ name: 'T', photo: '' }),
    fiestaShowRoom: () => {}, fiestaWatchRoom: () => {}, fiestaPaintControls: () => {},
    renderFiestaRoom: () => {}, fiestaArmAudioUnlock: () => {}, fiestaLevelCtx: () => {},
    fiestaPaintRoomSub: () => {}, fiestaEnsureMic: async () => false,
    markFiestaNotesEnded: async () => {}, _fiestaCancelDisconnect: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    console
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext('let fiestaCur = null, fiestaMyUid = null, fiestaMyRole = "listener", fiestaJoining = false, fiestaMuted = false, fiestaHostMutedLocal = false, fiestaMembers = {}, fiestaAmHost = false, fiestaDisconnectHandle = null;', ctx);
  const load = (decl, fnName, alias) => vm.runInContext(extractFn(html, decl) + '\nthis.' + alias + ' = ' + fnName + ';', ctx);
  load('function isValidChatUid(uid)', 'isValidChatUid', '__v');
  load('async function joinFiestaFromFeed(fiestaId)', 'joinFiestaFromFeed', '__jfff');
  load('async function joinFiesta(id, asSpeaker)', 'joinFiesta', '__jf');
  load('function _drexPushSubId(endpoint)', '_drexPushSubId', '__subid');
  return { ctx, writes };
}
const nestedKeys = (writes) => writes.filter(w => !w.aborted).map(w => w.base).filter(k => k.includes('foo/bar'));
function plantedDb() {
  const now = Date.now();
  return {
    'fiestas/foo/bar': { status: 'live', hostId: 'attacker999', createdAt: now, title: 'Fake' },
    'fiestas/-Oabc123XYZpush': { status: 'live', hostId: 'host1', createdAt: now, title: 'T' },
  };
}

(async () => {
  await tcase('conductual: joinFiestaFromFeed("foo/bar") -> 0 escrituras anidadas', async () => {
    const { ctx, writes } = makeCtx(plantedDb());
    await vm.runInContext('__jfff("foo/bar")', ctx);
    await new Promise(r => setTimeout(r, 400));
    const nested = nestedKeys(writes);
    if (nested.length) throw new Error('escrituras anidadas: ' + nested.join(','));
    if (writes.length) throw new Error('se escribió con fiestaId inválido: ' + writes.map(w => w.base).join(','));
  });
  await tcase('conductual: joinFiesta("foo/bar", false) directo -> 0 escrituras anidadas', async () => {
    const { ctx, writes } = makeCtx(plantedDb());
    await vm.runInContext('__jf("foo/bar", false)', ctx);
    await new Promise(r => setTimeout(r, 400));
    const nested = nestedKeys(writes);
    if (nested.length) throw new Error('escrituras anidadas: ' + nested.join(','));
    if (writes.length) throw new Error('se escribió con id inválido: ' + writes.map(w => w.base).join(','));
  });
  await tcase('conductual: joinFiestaFromFeed(pushId real) sigue entrando (sin regresión)', async () => {
    const { ctx, writes } = makeCtx(plantedDb());
    await vm.runInContext('__jfff("-Oabc123XYZpush")', ctx);
    await new Promise(r => setTimeout(r, 400));
    const keys = writes.filter(w => !w.aborted).map(w => w.base);
    if (!keys.includes('fiestaMembers/-Oabc123XYZpush/u1')) throw new Error('falta members: ' + keys.join(','));
    if (!keys.some(k => k.startsWith('fiestas/-Oabc123XYZpush/chat/pushid1'))) throw new Error('falta push chat: ' + keys.join(','));
    if (keys.some(k => k.includes('foo/bar'))) throw new Error('anidación inesperada: ' + keys.join(','));
  });
  await tcase('conductual: _drexPushSubId(endpoint con slashes) -> un solo segmento [0-9a-z]', async () => {
    const { ctx } = makeCtx({});
    const sid = vm.runInContext('__subid("https://fcm.googleapis.com/fcm/send/abc/def")', ctx);
    if (typeof sid !== 'string' || !/^s[0-9a-z]+$/.test(sid) || sid.includes('/')) throw new Error('subId inseguro: ' + sid);
  });
  console.log(failures === 0 ? 'ALL PASS' : 'FAILURES=' + failures);
  process.exit(failures === 0 ? 0 : 1);
})();
