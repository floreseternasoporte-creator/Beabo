// C198 — regresión: fiestaId forjado en cascadeDeleteNote (borrar aviso de fiesta).
//
// HALLAZGO (PoC B1, Chromium real vía CDP, base 9a535873): el fiestaId viaja
// en el aviso del feed (note.fiestaId, forjable por el autor del aviso: el
// cliente arma la nota y RTDB es client-writable). Al borrar su propio aviso
// por la UI, `cascadeDeleteNote` releía la nota del servidor y usaba
// `n.fiestaId` CRUDO para "terminar la fiesta": con fiestaId='foo/chat' +
// sub-objeto real en fiestas/foo/chat (p.ej. el chat de la fiesta 'foo' de
// OTRO usuario), el cliente del ATACANTE ejecutaba ESCRITURAS ANIDADAS:
//   set    fiestas/foo/chat/status = 'ended'
//   remove fiestaReactions/foo/chat
//   remove fiestaKicked/foo/chat
//   remove fiestaSignals/foo/chat
// corrompiendo la forma de la fiesta 'foo' ajena (la clave 'status' aparece
// dentro del sub-objeto chat).
// Parche mínimo (1 gate + 6 líneas de comentario, estilo de la casa):
// `if (n.fiestaId && isValidChatUid(n.fiestaId))` en cascadeDeleteNote (antes
// de cualquier ref con n.fiestaId). Los ids legítimos son push() keys (un
// solo segmento) → el gate no los toca; el resto de la cascada (borrar la
// nota y sus índices) sigue corriendo igual.
//
// Decisiones documentadas SIN parche (contenidas, no se tocan):
// - `postsByFiesta/' + n.fiestaId + '/' + noteId` (remove): limpieza del
//   índice PROPIO del forjador (writer==forger); la clave incluye su propio
//   noteId → no toca datos ajenos (precedente C196-F2 groupId).
// - Lead A del ciclo (pintado del onclick `joinFiestaFromFeed('${fid}')` con
//   fid = escapeInlineSingleQuote(note.fiestaId)): 11/11 SAFE en Chromium
//   real — `escapeSingleQuote` escapa `\` antes que `'`, y el `&` va primero
//   para que `&#39;` no se doble-decodifique; `"`/`<`/`>` van a entidades.
//   Sin parche, verificado por PoC.
//
// Test híbrido: asserts estáticos (fallan en base) + conductuales en sandbox
// vm con DrexCloud programable que registra escrituras (FAIL en base, PASS
// con parche). Uso: node tests/test-c198-fiesta-delete-gate.js [--target=html]
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
const delSrc = extractFn(html, 'async function cascadeDeleteNote(noteId, note) {');
ok('estático: cascadeDeleteNote valida n.fiestaId con isValidChatUid',
  /isValidChatUid\(n\.fiestaId\)/.test(delSrc));
ok('estático: el gate va ANTES del primer ref con n.fiestaId',
  delSrc.indexOf('isValidChatUid(n.fiestaId)') >= 0 &&
  delSrc.indexOf('isValidChatUid(n.fiestaId)') < delSrc.indexOf("'fiestas/' + n.fiestaId"));

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
      orderByChild: function () { return this; }, equalTo: function () { return this; },
    };
  };
  const sandbox = {
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'u1', displayName: 'T', photoURL: '' } }),
      database: () => ({ ref: refStub })
    },
    window: {},
    _closeViewerIfShowingNote: () => {},
    setTimeout: (fn) => setTimeout(fn, 0),
    console
  };
  const ctx = vm.createContext(sandbox);
  const load = (decl, fnName, alias) => vm.runInContext(extractFn(html, decl) + '\nthis.' + alias + ' = ' + fnName + ';', ctx);
  load('function isValidChatUid(uid)', 'isValidChatUid', '__v');
  load('async function _fiestaRemoveSignals(id)', '_fiestaRemoveSignals', '__sig');
  load('async function cascadeDeleteNote(noteId, note)', 'cascadeDeleteNote', '__del');
  return { ctx, writes };
}
const NESTED = /^((fiestas|fiestaReactions|fiestaKicked|fiestaSignals)\/foo\/chat(\/|$))/;
const nestedWrites = (writes) => writes.filter(w => !w.aborted && NESTED.test(w.base)).map(w => w.op + ' ' + w.base);
const BENIGN = '-Oabc123XYZpush';

(async () => {
  await tcase('conductual: cascadeDeleteNote con fiestaId="foo/chat" -> 0 escrituras anidadas en la fiesta ajena', async () => {
    const db = {
      'communityNotes/n1': { fiestaId: 'foo/chat', authorId: 'u1', fiestaTitle: 'T' },
      'fiestas/foo/chat': { push_1: { m: 'hola' } }, // sub-objeto REAL de la fiesta 'foo' de otro usuario
    };
    const { ctx, writes } = makeCtx(db);
    const ret = await vm.runInContext('__del("n1")', ctx);
    const nested = nestedWrites(writes);
    if (nested.length) throw new Error('escrituras anidadas: ' + nested.join(' | '));
    if (ret !== true) throw new Error('la cascada debe seguir borrando la nota (ret=' + ret + ')');
    if (!writes.some(w => w.op === 'remove' && w.base === 'communityNotes/n1'))
      throw new Error('la nota forjada sí debe borrarse');
  });
  await tcase('conductual: cascadeDeleteNote con fiestaId benigno termina la fiesta real (sin regresión)', async () => {
    const db = {
      'communityNotes/n1': { fiestaId: BENIGN, authorId: 'u1', fiestaTitle: 'T' },
      ['fiestas/' + BENIGN]: { status: 'live', hostId: 'u1', title: 'T' },
    };
    const { ctx, writes } = makeCtx(db);
    const ret = await vm.runInContext('__del("n1")', ctx);
    if (ret !== true) throw new Error('ret=' + ret);
    const keys = writes.map(w => w.op + ' ' + w.base);
    if (!keys.includes('set fiestas/' + BENIGN + '/status'))
      throw new Error('falta set fiestas/<id>/status: ' + keys.join(';'));
    if (!keys.includes('remove fiestaSignals/' + BENIGN))
      throw new Error('falta remove fiestaSignals/<id>: ' + keys.join(';'));
  });
  await tcase('conductual: fiesta ya terminada no re-escribe (sin regresión)', async () => {
    const db = {
      'communityNotes/n1': { fiestaId: BENIGN, authorId: 'u1', fiestaTitle: 'T' },
      ['fiestas/' + BENIGN]: { status: 'ended', hostId: 'u1', title: 'T' },
    };
    const { ctx, writes } = makeCtx(db);
    await vm.runInContext('__del("n1")', ctx);
    if (writes.some(w => w.base === 'fiestas/' + BENIGN + '/status'))
      throw new Error('no debe re-escribir status de fiesta terminada');
  });
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  process.exit(failures ? 1 : 0);
})();
