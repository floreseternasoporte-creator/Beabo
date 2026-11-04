'use strict';
// QA ciclo 14 — CONTRATO DE RESEAL, cláusula (a): usar ref.key tras await set() (C14-03).
//
// writeCommentCore/writeReplyCore (index.html) devolvían la variable léxica
// pre-generada (_newCommentKey/_newReplyKey) en vez de la key post-reseal:
// el comentario real quedaba en postComments/<note>/K_new pero el índice
// userComments/<uid>/K_old era un fantasma y la UI optimista pintaba un ghost.
//
// Fix: conservar el childRef y devolver childRef.key tras el set; la ruta de
// deduplicado (_commentCoreDone) resuelve la key final vía _commentKeyFinal.
//
// Este test EXTRAE las funciones reales de ../src/index.html (balance de llaves
// con tokenizer de strings/comentarios) y las ejecuta contra drex-cloud.js
// real con la red simulada. Regresión: ANTES del fix devuelven la key vieja
// (T1/T2/T3 FALLAN); DESPUÉS pasan.
//   BEFORE: DREX_CLOUD_PATH=../src-base/drex-cloud.js DREX_INDEX_PATH=<base> node test-c14-reseal-03-comment-key.js
//   AFTER:  node test-c14-reseal-03-comment-key.js
const fs = require('fs');
const path = require('path');

function findRepoFile(cands) {
  for (const c of cands) { const p = path.join(__dirname, c); if (fs.existsSync(p)) return p; }
  throw new Error('archivo no encontrado: ' + cands.join(' / '));
}
// Layout del repo (tests/ en raíz) primero; layout de dir aislado del worker como fallback.
const CLOUD = process.env.DREX_CLOUD_PATH || findRepoFile(['../drex-cloud.js', '../src/drex-cloud.js']);
const SRC_INDEX = process.env.DREX_INDEX_PATH || findRepoFile(['../index.html', '../src/index.html']);

// ---------- stubs de entorno ----------
const realSetTimeout = setTimeout;
global.setTimeout = (fn, ms, ...a) => (ms === 1500 ? 0 : realSetTimeout(fn, ms, ...a));
global.clearTimeout = clearTimeout;
let online = true;
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
Object.defineProperty(globalThis.navigator, 'onLine', { get: () => online, configurable: true });
const lsStore = new Map();
global.localStorage = {
  getItem: k => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: k => lsStore.delete(k),
};

function makeFakeDb() {
  const store = new Map();
  const dc = {
    query(params) {
      return { promise: () => new Promise((resolve) => {
        realSetTimeout(() => {
          const vals = params.ExpressionAttributeValues || {};
          const kce = params.KeyConditionExpression || '';
          let items = [];
          for (const it of store.values()) if (it.pk === vals[':pk']) items.push(it);
          if (kce.indexOf('BETWEEN') >= 0) {
            const lo = vals[':lo'], hi = vals[':hi'];
            items = items.filter(it => it.sk >= lo && it.sk <= hi);
          } else if (kce.indexOf('begins_with') >= 0) {
            const pfx = vals[':pfx'];
            items = items.filter(it => it.sk.indexOf(pfx) === 0);
          }
          items.sort((a, b) => (a.sk < b.sk ? -1 : (a.sk > b.sk ? 1 : 0)));
          resolve({ Items: items.map(it => ({ pk: it.pk, sk: it.sk, v: it.v })), LastEvaluatedKey: null });
        }, 0);
      }) };
    },
    batchWrite(params) {
      return { promise: () => new Promise((resolve) => {
        realSetTimeout(() => {
          const tableReqs = params.RequestItems[Object.keys(params.RequestItems)[0]] || [];
          tableReqs.forEach(r => {
            if (r.PutRequest) { const it = r.PutRequest.Item; store.set(it.pk + '\0' + it.sk, { pk: it.pk, sk: it.sk, v: it.v }); }
            else if (r.DeleteRequest) store.delete(r.DeleteRequest.Key.pk + '\0' + r.DeleteRequest.Key.sk);
          });
          resolve({ UnprocessedItems: {} });
        }, 0);
      }) };
    },
  };
  return { dc, store,
    childKeys(pk, prefix) {
      const out = new Set();
      for (const it of store.values()) {
        if (it.pk !== pk) continue;
        if (it.sk.indexOf(prefix) !== 0) continue;
        out.add(it.sk.slice(prefix.length).split('/')[0]);
      }
      return [...out].sort();
    } };
}

function freshModule() {
  delete require.cache[require.resolve(CLOUD)];
  return require(CLOUD);
}
const sleep = (ms) => new Promise(r => realSetTimeout(r, ms));
async function settle(n) { for (let i = 0; i < (n || 10); i++) await sleep(25); }
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FALLA ' + name + (extra ? ' :: ' + extra : '')); }
}

// ---------- extractor del código REAL de index.html ----------
// Extrae `const <name> = () => { ... };` por balance de llaves, saltando
// strings ('...' "..." `...` con ${}), comentarios // y /* */.
function extractArrowBlock(src, name) {
  const marker = 'const ' + name + ' = () => {';
  const mi = src.indexOf(marker);
  if (mi === -1) throw new Error('bloque no encontrado: ' + marker);
  let i = mi + marker.length - 1; // en el '{' de apertura
  let depth = 0;
  const stack = []; // [{st, depth}] para `...${...}`
  let st = 'code';
  let j = i;
  while (j < src.length) {
    const c = src[j], n = src[j + 1];
    if (st === 'code') {
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { j++; break; }
        const top = stack[stack.length - 1];
        if (top && top.st === 'tpl' && top.depth === depth) { stack.pop(); st = 'tpl'; }
      }
      else if (c === "'") st = 'sq';
      else if (c === '"') st = 'dq';
      else if (c === '`') st = 'tpl';
      else if (c === '/' && n === '/') st = 'lc';
      else if (c === '/' && n === '*') st = 'bc';
    } else if (st === 'sq' || st === 'dq') {
      if (c === '\\') j++;
      else if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"')) st = 'code';
    } else if (st === 'tpl') {
      if (c === '\\') j++;
      else if (c === '`') st = 'code';
      else if (c === '$' && n === '{') { stack.push({ st: 'tpl', depth }); depth++; st = 'code'; j++; }
    } else if (st === 'lc') { if (c === '\n') st = 'code'; }
    else if (st === 'bc') { if (c === '*' && n === '/') { st = 'code'; j++; } }
    j++;
  }
  if (depth !== 0) throw new Error('balance de llaves roto en ' + name);
  return src.slice(mi, j);
}

async function main() {
  console.log('== C14-03: writeCommentCore/writeReplyCore devuelven la key post-reseal');
  const html = fs.readFileSync(SRC_INDEX, 'utf8');
  const commentSrc = extractArrowBlock(html, 'writeCommentCore');
  const replySrc = extractArrowBlock(html, 'writeReplyCore');
  check('T0 bloques reales extraídos de index.html', commentSrc.length > 100 && replySrc.length > 100);

  const fake = makeFakeDb();
  const M = freshModule();
  M.__internals.setDocClient(fake.dc);
  const db = () => M.DrexCloud.database();
  const noteId = 'note1', uid = 'u1', ts = Date.now();

  // T1: comentario raíz offline -> flush con reseal.
  online = true;
  const _newCommentKey = db().ref('postComments/' + noteId).push().key;
  const commentFactory = new Function('commentsRef', '_newCommentKey', 'payload', '_commentCoreDone', '_commentKeyFinal',
    commentSrc + '\nreturn writeCommentCore;');
  const done1 = new Set(), final1 = new Map();
  const payload = { authorId: uid, content: 'hola', timestamp: ts };
  online = false;
  const writeCommentCore = commentFactory(db().ref('postComments/' + noteId), _newCommentKey, payload, done1, final1);
  const p1 = writeCommentCore();
  await settle(2);
  online = true;
  M.DrexCloud._outbox.flush();
  const res1 = await p1;
  await settle(6);
  const realKeys = fake.childKeys('postComments', noteId + '/');
  check('T1 writeCommentCore devuelve la key real escrita (post-reseal)',
    realKeys.length === 1 && res1.key === realKeys[0],
    'devuelta=' + res1.key + ' real=' + JSON.stringify(realKeys));
  // Lo que la app hace con la key devuelta (index.html:20382): índice userComments.
  await db().ref('userComments/' + uid + '/' + res1.key).set({ noteId, content: 'hola', timestamp: ts });
  await settle(4);
  const idxKeys = fake.childKeys('userComments', uid + '/');
  check('T1 índice userComments coincide con el comentario real (sin fantasma)',
    idxKeys.length === 1 && idxKeys[0] === realKeys[0],
    'índice=' + JSON.stringify(idxKeys) + ' real=' + JSON.stringify(realKeys));

  // T2: respuesta offline -> flush con reseal.
  online = true;
  const parentKey = 'pc_parent';
  await db().ref('postComments/' + noteId + '/' + parentKey).set({ authorId: 'u2', content: 'padre', timestamp: ts });
  await settle(4);
  const _newReplyKey = db().ref('postComments/' + noteId + '/' + parentKey + '/replies').push().key;
  const replyFactory = new Function('repliesRef', '_newReplyKey', 'payload', '_commentCoreDone', '_commentKeyFinal',
    replySrc + '\nreturn writeReplyCore;');
  const done2 = new Set(), final2 = new Map();
  online = false;
  const writeReplyCore = replyFactory(db().ref('postComments/' + noteId + '/' + parentKey + '/replies'), _newReplyKey, payload, done2, final2);
  const p2 = writeReplyCore();
  await settle(2);
  online = true;
  M.DrexCloud._outbox.flush();
  const res2 = await p2;
  await settle(6);
  const realReplyKeys = fake.childKeys('postComments', noteId + '/' + parentKey + '/replies/');
  check('T2 writeReplyCore devuelve la key real escrita (post-reseal)',
    realReplyKeys.length === 1 && res2.key === realReplyKeys[0],
    'devuelta=' + res2.key + ' real=' + JSON.stringify(realReplyKeys));
  await db().ref('userComments/' + uid + '/' + res2.key).set({ noteId, content: 'hola', timestamp: ts });
  await settle(4);
  const idxKeys2 = fake.childKeys('userComments', uid + '/');
  check('T2 índice de la respuesta coincide con la respuesta real',
    idxKeys2.indexOf(realReplyKeys[0]) !== -1 && idxKeys2.indexOf(_newReplyKey) === -1,
    'índice=' + JSON.stringify(idxKeys2));

  // T3: reintento tras éxito con reseal -> la ruta de dedup devuelve la key FINAL.
  online = false;
  const _k3 = db().ref('postComments/' + noteId).push().key;
  const done3 = new Set(), final3 = new Map();
  const wcc3a = commentFactory(db().ref('postComments/' + noteId), _k3, payload, done3, final3);
  const p3 = wcc3a();
  await settle(2);
  online = true;
  M.DrexCloud._outbox.flush();
  const res3a = await p3;
  await settle(6);
  // Segundo intento (como _runWithAutoRetry tras un fallo tardío): nueva
  // instancia de la función, mismos sets de dedup.
  const wcc3b = commentFactory(db().ref('postComments/' + noteId), _k3, payload, done3, final3);
  const res3b = await wcc3b();
  check('T3 dedup tras reintento devuelve la key final (no la pre-generada)',
    res3b.key === res3a.key && res3a.key !== _k3,
    'intento1=' + res3a.key + ' intento2=' + res3b.key + ' pre=' + _k3);

  // T4 (estático): el código ya no retorna la variable léxica.
  const hasStaleReturn = /return\s*\{\s*key:\s*_newCommentKey\s*\}/.test(commentSrc) ||
                         /return\s*\{\s*key:\s*_newReplyKey\s*\}/.test(replySrc);
  check('T4 writeCommentCore/writeReplyCore no retornan la key léxica', !hasStaleReturn);
  check('T4 usan childRef.key y el mapa _commentKeyFinal',
    /childRef\.key/.test(commentSrc) && /childRef\.key/.test(replySrc) &&
    /_commentKeyFinal/.test(commentSrc) && /_commentKeyFinal/.test(replySrc));

  console.log(failures ? `\n${failures} FALLA(S)` : '\nTODOS OK');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
