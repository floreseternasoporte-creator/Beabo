#!/usr/bin/env node
/*
 * test-c169-music-mentions — C169: menciones en el título de canciones.
 * Hueco: el anuncio musical del feed pinta @menciones como enlaces tocables
 * (renderContentWithSticker) pero publishMusic nunca llamaba a
 * sendMentionNotifications (gemelo del hueco C168 en comentarios).
 * Parche: hunk1 (publish: avisa tras publicar el anuncio) + hunk2 (edit:
 * delta de menciones nuevas con commentEditNewMentions, patrón C168).
 *
 * Uso: node tests/test-c169-music-mentions.js [archivo-base]
 *   Sin args: corre contra index.html del árbol (convención DREX_HTML).
 *   Con arg: corre contra ese archivo como "base" (falla-en-base explícito).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TREE_FILE = path.join(__dirname, '..', 'index.html');
const SRC_FILE = process.argv[2] || TREE_FILE;
const SRC = fs.readFileSync(SRC_FILE, 'utf8');
const IS_BASE = !!process.argv[2];

// ---- extractor verbatim con tokenizer (strings, comentarios, templates, regex) ----
function blockEnd(src, openIdx) {
  const stack = [];
  let i = openIdx, depth = 0, prevSig = '{', ctx = '';
  const isRe = () => /[=(:,[!&|?{};+\-*~^<>]/.test(prevSig) || prevSig === '' ||
    /(^|\W)(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else)$/.test(' ' + ctx);
  while (i < src.length) {
    const c = src[i], top = stack.length ? stack[stack.length - 1] : null;
    if (top && top.t === 'str') { if (c === '\\') { i += 2; continue; } if (c === top.q) stack.pop(); i++; continue; }
    if (top && top.t === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); i++; prevSig = '`'; ctx += '`'; continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push({ t: 'code', depth: 0 }); i += 2; prevSig = '{'; ctx += '${'; continue; }
      i++; continue;
    }
    if (top && top.t === 're') {
      if (c === '\\') { i += 2; continue; }
      if (c === '[') { top.cls = true; i++; continue; }
      if (c === ']' && top.cls) { top.cls = false; i++; continue; }
      if (c === '/' && !top.cls) { stack.pop(); i++; while (i < src.length && /[a-z]/i.test(src[i])) i++; prevSig = 'x'; ctx += 're'; continue; }
      i++; continue;
    }
    if (c === '"' || c === "'") { stack.push({ t: 'str', q: c }); i++; prevSig = c; ctx += c; continue; }
    if (c === '`') { stack.push({ t: 'tpl' }); i++; prevSig = c; ctx += c; continue; }
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n === -1 ? src.length : n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n === -1 ? src.length : n + 2; continue; }
    if (c === '/') { if (isRe()) { stack.push({ t: 're', cls: false }); i++; continue; } i++; prevSig = '/'; ctx += '/'; continue; }
    if (c === '{') { if (top && top.t === 'code') top.depth++; else depth++; i++; prevSig = '{'; ctx += '{'; continue; }
    if (c === '}') {
      if (top && top.t === 'code') { top.depth--; if (top.depth < 0) { stack.pop(); i++; prevSig = '}'; ctx += '}'; continue; } }
      else { depth--; if (depth === 0 && !stack.length) return i + 1; if (depth < 0) throw new Error('brace negativo'); }
      i++; prevSig = '}'; ctx += '}'; continue;
    }
    if (!/\s/.test(c)) { prevSig = c; ctx = (ctx + c).slice(-12); }
    i++;
  }
  throw new Error('sin cierre');
}
function extractFn(name) {
  const pats = ['function ' + name + '(', 'window.' + name + ' = function', 'const ' + name + ' = function'];
  let idx = -1;
  for (const p of pats) { const j = SRC.indexOf(p); if (j !== -1 && (idx === -1 || j < idx)) idx = j; }
  if (idx === -1) throw new Error('no encontrada en ' + SRC_FILE + ': ' + name);
  // Avanzar hasta el '{' del CUERPO: saltar la lista de parámetros con
  // matching de paréntesis (los defaults pueden traer '{', ej. extraMeta = {}).
  let p = SRC.indexOf('(', idx), depth = 0, inS = null, esc = false;
  let bodyOpen = -1;
  for (let i = p; i < SRC.length && bodyOpen === -1; i++) {
    const c = SRC[i];
    if (inS) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inS) inS = null; continue; }
    if (c === '"' || c === "'") { inS = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { const b = SRC.indexOf('{', i); bodyOpen = b; } }
  }
  if (bodyOpen === -1) throw new Error('sin cuerpo: ' + name);
  return SRC.slice(idx, blockEnd(SRC, bodyOpen));
}

// ---- harness ----
let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail) {
  if (cond) { pass++; } else { fail++; }
  results.push((cond ? 'ok' : 'NOT OK') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

// ---- stubs ----
const USERNAMES = { juan: 'uid-juan', maria: 'uid-maria', atenis: 'uid-author' };
const notifCalls = [];
const DrexCloud = {
  database: () => ({ ref: (p) => ({ once: () => Promise.resolve({ val: () => USERNAMES[String(p).split('/')[1]] || null }) }) }),
};
function addNotification(uid, message, type, meta) {
  notifCalls.push({ uid, message, type, meta });
  return Promise.resolve();
}

// ---- funciones verbatim del bundle ----
const fns = [
  extractFn('extractMentionUsernames'),
  extractFn('commentEditNewMentions'),
  extractFn('sendMentionNotifications'),
].join('\n');
// new Function (no-strict): las declaraciones quedan locales al factory y se retornan.
const factory = new Function('DrexCloud', 'addNotification',
  fns + '\nreturn { extractMentionUsernames: extractMentionUsernames, commentEditNewMentions: commentEditNewMentions, sendMentionNotifications: sendMentionNotifications };');
const { extractMentionUsernames, commentEditNewMentions, sendMentionNotifications } = factory(DrexCloud, addNotification);

async function main() {
  // 1. WIRING hunk1: publishMusic avisa menciones del anuncio (falla en base)
  const pmIdx = SRC.indexOf('window.publishMusic = async function');
  const pmBody = pmIdx === -1 ? '' : SRC.slice(pmIdx, blockEnd(SRC, SRC.indexOf('{', pmIdx)));
  ok('wiring-hunk1-publish-llama-sendMentionNotifications',
    pmBody.includes('sendMentionNotifications(note.content, uid, authorName'),
    IS_BASE ? 'esperado: falla en base' : 'hook tras publicar el anuncio');

  // 2. WIRING hunk2: edit usa delta commentEditNewMentions (falla en base)
  ok('wiring-hunk2-edit-usa-delta',
    pmBody.includes('commentEditNewMentions(_oldMusicContent, _newMusicContent)'),
    IS_BASE ? 'esperado: falla en base' : 'delta en edición de track');

  // 3. Publish: mención en el título avisa al mencionado (tipo 'mention', toggle 'mentions')
  notifCalls.length = 0;
  await sendMentionNotifications('Mi nueva canción @juan — Atenis', 'uid-author', 'Atenis', 'publicación', ['uid-author'], { postId: 'note1' });
  const c3 = notifCalls.find(c => c.uid === 'uid-juan');
  ok('publish-mencion-avisa', !!c3 && c3.type === 'mention' && c3.meta && c3.meta.actionType === 'post' && c3.meta.actionId === 'note1',
    JSON.stringify(notifCalls));

  // 4. Publish: sin menciones no hay avisos
  notifCalls.length = 0;
  await sendMentionNotifications('Mi nueva canción — Atenis', 'uid-author', 'Atenis', 'publicación', ['uid-author'], { postId: 'note1' });
  ok('publish-sin-menciones-silencio', notifCalls.length === 0);

  // 5. Publish: auto-mención excluida
  notifCalls.length = 0;
  await sendMentionNotifications('Dedicada a @atenis — Atenis', 'uid-author', 'Atenis', 'publicación', ['uid-author'], { postId: 'note1' });
  ok('publish-auto-mencion-excluida', notifCalls.length === 0);

  // 6. Publish: múltiples menciones, cada una una vez
  notifCalls.length = 0;
  await sendMentionNotifications('@juan y @maria en el coro @juan — Atenis', 'uid-author', 'Atenis', 'publicación', ['uid-author'], { postId: 'note1' });
  ok('publish-multiples-una-vez', notifCalls.length === 2 &&
    notifCalls.some(c => c.uid === 'uid-juan') && notifCalls.some(c => c.uid === 'uid-maria'));

  // 7. Publish: mención a usuario inexistente no avisa
  notifCalls.length = 0;
  await sendMentionNotifications('Para @nadie99 — Atenis', 'uid-author', 'Atenis', 'publicación', ['uid-author'], { postId: 'note1' });
  ok('publish-mencion-fantasma-silencio', notifCalls.length === 0);

  // 8. Edit: delta detecta solo la mención NUEVA
  const d8 = commentEditNewMentions('Vieja canción — Atenis', 'Nueva canción @juan — Atenis');
  ok('edit-delta-solo-nueva', JSON.stringify(d8) === JSON.stringify(['juan']), JSON.stringify(d8));

  // 9. Edit: reeditar sin agregar menciones no re-notifica
  const d9 = commentEditNewMentions('Canción @juan — Atenis', 'Canción @juan remaster — Atenis');
  ok('edit-sin-nuevas-vacio', Array.isArray(d9) && d9.length === 0, JSON.stringify(d9));

  // 10. Edit: quitar una mención no avisa
  const d10 = commentEditNewMentions('Canción @juan — Atenis', 'Canción — Atenis');
  ok('edit-quitar-no-avisa', Array.isArray(d10) && d10.length === 0, JSON.stringify(d10));

  // 11. Edit: delta insensible a mayúsculas
  const d11 = commentEditNewMentions('a — b', 'A @JUAN — b');
  ok('edit-delta-case-insensitive', JSON.stringify(d11) === JSON.stringify(['JUAN']) || JSON.stringify(d11) === JSON.stringify(['juan']), JSON.stringify(d11));

  // 12. Edit: el hook de edición pasa el delta como onlyUsernames (no re-extrae todo)
  notifCalls.length = 0;
  await sendMentionNotifications('Nueva @juan — Atenis', 'uid-author', 'Atenis', 'publicación', ['uid-author'], { postId: 'ann1' }, ['juan']);
  ok('edit-onlyUsernames-respeta-delta', notifCalls.length === 1 && notifCalls[0].uid === 'uid-juan' && notifCalls[0].meta.actionId === 'ann1');

  // 13. Contenido del anuncio: formato título — artista (superficie que pinta)
  ok('anuncio-formato-titulo-artista', pmBody.includes('`${title} — ${artistName}`') || pmBody.includes('note.content'),
    'el contenido notificado es el que se pinta');

  // 14. Guarda typeof: el hook no revienta si la función no existe (harness viejo)
  ok('wiring-guarda-typeof', pmBody.includes("typeof sendMentionNotifications === 'function'"));

  // 15. El aviso de edición solo corre si hay anuncio (annId)
  ok('wiring-edit-solo-con-annId', pmBody.includes('if (annId) {') || pmBody.includes('if (annId)'));

  console.log(results.join('\n'));
  console.log('\n' + pass + ' passed, ' + fail + ' failed (archivo: ' + SRC_FILE + ')');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(2); });
