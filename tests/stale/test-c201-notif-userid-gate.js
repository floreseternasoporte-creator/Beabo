// Test C201 — gate isValidChatUid en addNotification (userId forjado).
//
// HALLAZGO (PoC en Chromium real vía CDP, base 752df729):
// addNotification(userId, …) usaba `userId` CRUDO como segmento de ruta en
// ESCRITURAS:
//   ref('notifications/' + userId).push().set(…)   (+ .update({actorId…}))
//   ref('notifUnread/' + userId).transactionBlind(…) (vía bumpNotifUnread)
// y en la LECTURA userSettings/<userId>/notifications.
// El userId llega de VALORES del payload del servidor (note.authorId,
// updatedNote.authorId, parentComment.authorId, updatedComment.authorId,
// un.authorId de canciones) en flujos que ejecuta la VÍCTIMA sin modificar:
// voteInPoll (L18380), maybeAnnouncePollClose (L18435, AUTOMÁTICO al
// renderizar una encuesta cerrada), votePost (L20970), toggleEco (L21802),
// submitReply (L24140/24153), voteComment (L24573), music vote (L52376),
// milestone (L11784), exercises (L47190/47264). El autor forja su propio
// authorId (valor libre que su cliente fija; mismo modelo que C200/fileId).
// Con authorId='a/b/c', el cliente de la víctima escribía anidado en
// notifications/a/b/c/<push> y notifUnread/a/b/c (inyección estructural,
// familia C191–C200). PoC: base B1/B2/B3 PWNED → parche 6/6 SAFE.
//
// Parche: `if (!isValidChatUid(userId)) return;` al inicio de addNotification
// (punto único: shouldSkipNotificationFor y bumpNotifUnread solo se llaman
// desde ahí).
//
// Riesgo residual DOCUMENTADO (no lo cubre el gate, fuera del alcance del
// parche cliente): authorId = uid válido de OTRO usuario → el aviso cae en
// su inbox ("A X le dio un voto a tu publicación"). Requiere validación
// server-side de authorId (regla RTDB authorId == auth.uid al crear el post).
//
// Test híbrido: asserts estáticos (fallan en base) + conductuales en sandbox
// vm con DrexCloud programable (mock RTDB en memoria con transaction fiel,
// onComplete y registro de escrituras). FAIL en base, PASS con parche.
// Uso: node tests/test-c201-notif-userid-gate.js [--target=html]
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
const notifSrc = extractFn(html, 'async function addNotification(userId, message, type = ');
ok('estático: addNotification valida userId con isValidChatUid',
  /isValidChatUid\(userId\)/.test(notifSrc));
ok('estático: el gate va ANTES del primer uso en ruta',
  notifSrc.indexOf('isValidChatUid(userId)') >= 0 &&
  notifSrc.indexOf('isValidChatUid(userId)') < notifSrc.indexOf("'notifications/' + userId"));
ok('estático: el gate hace early-return (no escribe nada con uid inválido)',
  /if\s*\(!isValidChatUid\(userId\)\)\s*return;/.test(notifSrc));

// ---------- sandbox conductual ----------
function makeCtx() {
  const writes = [];
  const db = {};
  const segsOf = p => String(p).split('/').filter(s => s.length > 0);
  const get = p => { let n = db; for (const s of segsOf(p)) { if (n == null || typeof n !== 'object') return undefined; n = n[s]; } return n; };
  const set = (p, v) => { const sgs = segsOf(p); let n = db; for (let i = 0; i < sgs.length - 1; i++) { if (n[sgs[i]] == null || typeof n[sgs[i]] !== 'object') n[sgs[i]] = {}; n = n[sgs[i]]; } n[sgs[sgs.length - 1]] = v; };
  const snap = v => ({ exists: () => v !== undefined && v !== null, val: () => (v === undefined || v === null) ? null : JSON.parse(JSON.stringify(v)) });
  let pushN = 0;
  function mkRef(rpath) {
    return {
      _p: rpath,
      once: async () => snap(get(rpath)),
      set: async (v) => { writes.push({ op: 'set', base: rpath }); set(rpath, v); },
      update: async (u) => { writes.push({ op: 'update', base: rpath }); for (const k of Object.keys(u || {})) set(rpath + '/' + k, u[k]); },
      remove: async () => { writes.push({ op: 'remove', base: rpath }); },
      transaction: (fn, onComplete) => {
        const cur = get(rpath);
        let res;
        try { res = fn(cur === undefined ? null : JSON.parse(JSON.stringify(cur))); }
        catch (e) { if (typeof onComplete === 'function') onComplete(e, false, snap(cur)); return Promise.resolve({ committed: false }); }
        if (res === undefined) { if (typeof onComplete === 'function') onComplete(null, false, snap(cur)); return Promise.resolve({ committed: false }); }
        writes.push({ op: 'txn', base: rpath }); set(rpath, res);
        if (typeof onComplete === 'function') onComplete(null, true, snap(res));
        return Promise.resolve({ committed: true });
      },
      transactionBlind: (fn) => {
        const cur = get(rpath);
        let res;
        try { res = fn(cur === undefined ? null : JSON.parse(JSON.stringify(cur))); } catch (e) { return Promise.resolve({ committed: false }); }
        if (res === undefined) return Promise.resolve({ committed: false });
        writes.push({ op: 'txnBlind', base: rpath }); set(rpath, res);
        return Promise.resolve({ committed: true });
      },
      push: () => { const k = 'push_t' + (++pushN); const c = mkRef(rpath + '/' + k); c.key = k; return c; },
    };
  }
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'u1', displayName: 'Uno', photoURL: '' } }),
      database: () => ({ ref: (p) => mkRef(String(p)) }),
    },
    __db: db, __writes: writes,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext('let _notifActorCache = null, _notifActorPromise = null;\nconst _notifPrefCache = {};', ctx);
  vm.runInContext('var _c153PollCloseTried = {};', ctx);
  const load = (decl, fnName, alias) => vm.runInContext(extractFn(html, decl) + '\nthis.' + alias + ' = ' + fnName + ';', ctx);
  load('function isValidChatUid(uid)', 'isValidChatUid', '__v');
  load('function notifTypeToPrefKey(type, meta)', 'notifTypeToPrefKey', '__ntk');
  load('function _isRetryableNetError(err)', '_isRetryableNetError', '__ret');
  load('function _runWithAutoRetry(operation, label)', '_runWithAutoRetry', '__retry');
  load('async function shouldSkipNotificationFor(userId, type, meta)', 'shouldSkipNotificationFor', '__skip');
  load('function bumpNotifUnread(userId)', 'bumpNotifUnread', '__bump');
  load('function getNotifActorInfo()', 'getNotifActorInfo', '__actor');
  load('async function addNotification(', 'addNotification', '__notif');
  load('function pollCloseAnnounce(poll, nowMs)', 'pollCloseAnnounce', '__ann');
  load('function pollCloseResultText(poll)', 'pollCloseResultText', '__txt');
  load('function maybeAnnouncePollClose(noteId, poll)', 'maybeAnnouncePollClose', '__chain');
  return { ctx, writes, db };
}
const nestedNotifWrites = (writes) => writes.filter(w => {
  const p = String(w.base);
  if (p.indexOf('notifications/') === 0) return !/^notifications\/[^\/]+\/[^\/]+$/.test(p);
  if (p.indexOf('notifUnread/') === 0) return !/^notifUnread\/[^\/]+$/.test(p);
  return false;
});
const notifWrites = (writes) => writes.filter(w => {
  const p = String(w.base);
  return p.indexOf('notifications/') === 0 || p.indexOf('notifUnread/') === 0;
});

(async () => {
  await tcase('conductual B0: uid benigno de un segmento SÍ escribe (sin regresión)', async () => {
    const { ctx, writes } = makeCtx();
    vm.runInContext('__notif("uidreal123", "A X le dio un voto a tu publicación.", "vote", {actionType:"post", actionId:"n1"});', ctx);
    await new Promise(r => setTimeout(r, 400));
    const nw = notifWrites(writes);
    if (!nw.some(w => /^set$/.test(w.op) && /^notifications\/uidreal123\/push_/.test(w.base)))
      throw new Error('falta set en inbox propio: ' + JSON.stringify(nw));
    if (!nw.some(w => w.op === 'txnBlind' && w.base === 'notifUnread/uidreal123'))
      throw new Error('falta badge: ' + JSON.stringify(nw));
    if (nestedNotifWrites(writes).length) throw new Error('anidado inesperado');
  });

  await tcase('conductual B1: userId="a/b/c" → 0 escrituras de aviso (base: anidadas)', async () => {
    const { ctx, writes } = makeCtx();
    vm.runInContext('__notif("a/b/c", "A X le dio un voto a tu publicación.", "vote", {actionType:"post", actionId:"n1"});', ctx);
    await new Promise(r => setTimeout(r, 400));
    const nw = notifWrites(writes);
    if (nw.length) throw new Error('se escribió con uid forjado: ' + JSON.stringify(nw));
  });

  await tcase('conductual B2: userId="x/y" (eco) → 0 escrituras de aviso', async () => {
    const { ctx, writes } = makeCtx();
    vm.runInContext('__notif("x/y", "E hizo eco de tu publicación.", "eco", {actionType:"post", actionId:"n1"});', ctx);
    await new Promise(r => setTimeout(r, 400));
    if (notifWrites(writes).length) throw new Error('se escribió: ' + JSON.stringify(notifWrites(writes)));
  });

  await tcase('conductual B3: userId="p/q/r/s" (profundo) → 0 escrituras de aviso', async () => {
    const { ctx, writes } = makeCtx();
    vm.runInContext('__notif("p/q/r/s", "A X le dio un voto a tu comentario.", "vote");', ctx);
    await new Promise(r => setTimeout(r, 400));
    if (notifWrites(writes).length) throw new Error('se escribió: ' + JSON.stringify(notifWrites(writes)));
  });

  await tcase('conductual B4: cadena automática maybeAnnouncePollClose con authorId forjado → 0 avisos, closeAnnounced intacto', async () => {
    const { ctx, writes, db } = makeCtx();
    const past = Date.now() - 60000;
    vm.runInContext(
      '__db.communityNotes = { nX: { authorId: "a/b/c", poll: { endsAt: ' + past + ', options: [{t:"A",v:3}], total: 3, voters: {} } } };' +
      '__chain("nX", __db.communityNotes.nX.poll);', ctx);
    await new Promise(r => setTimeout(r, 500));
    if (notifWrites(writes).length) throw new Error('aviso anidado: ' + JSON.stringify(notifWrites(writes)));
    const marked = db.communityNotes && db.communityNotes.nX && db.communityNotes.nX.poll && db.communityNotes.nX.poll.closeAnnounced;
    if (!marked) throw new Error('el protocolo se rompió: closeAnnounced no se marcó');
  });

  await tcase('conductual B5: userId="" y null → 0 escrituras (gate, no throw)', async () => {
    const { ctx, writes } = makeCtx();
    vm.runInContext('__notif("", "m", "vote", {});', ctx);
    vm.runInContext('__notif(null, "m", "vote", {});', ctx);
    await new Promise(r => setTimeout(r, 400));
    if (notifWrites(writes).length) throw new Error('se escribió con uid vacío: ' + JSON.stringify(notifWrites(writes)));
  });

  console.log(failures === 0 ? '\nC201: 6 conductuales + 3 estáticos PASS' : '\nC201: ' + failures + ' FALLOS');
  process.exit(failures === 0 ? 0 : 1);
})();
