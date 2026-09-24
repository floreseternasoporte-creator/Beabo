// test-c58-chat-expiry-sweep.js — chat/temporales: barrido de mensajes que
// expiraron sin que ningún cliente tuviera el chat abierto (C58-C1).
// El borrado de un mensaje temporal vivía SOLO en el countdown en vivo de
// _startMsgCountdown, que únicamente corre en la página que renderizó el
// mensaje aún vivo. Si nadie tenía el chat abierto al expirar (caso común
// con temporizadores de días), la fila sobrevivía en la BD con su contenido,
// el pin seguía revelando el texto "desaparecido" PARA SIEMPRE (misma familia
// que C49-C1), los trozos de adjuntos sobrevivían (C50-C1) y las reacciones
// quedaban huérfanas. El render solo mostraba la lápida "Mensaje eliminado"
// sin disparar ninguna limpieza.
// Fix: helper idempotente _expireChatMessage(conv, msgId, msg) usado por el
// countdown y por un barrido (una vez por sesión) en la rama de render de un
// mensaje ya expirado. El pin se borra SOLO si pin.msgId === msgId.
// Convención: estático + funcional contra el archivo del repo, sin rutas
// absolutas ni historial de git. Los checks SOLO pasan con el fix presente.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repoRoot = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf-8');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

function extractFn(src, name) {
  const m = src.match(new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\('));
  if (!m) return null;
  const start = m.index;
  let depth = 0, i = src.indexOf('{', start);
  for (;;) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return src.slice(start, i + 1);
}

// ---------- estático ----------
const helperSrc = extractFn(html, '_expireChatMessage');
check('C1: helper _expireChatMessage definido [falla en base]', !!helperSrc);
check('C1: el helper borra el mensaje expirado',
  !!helperSrc && /conversationMessages\/' \+ conversationId \+ '\/' \+ msgId\)\.remove\(\)/.test(helperSrc));
check('C1: el helper borra las reacciones del mensaje',
  !!helperSrc && /msgReactions\/' \+ conversationId \+ '\/' \+ msgId\)\.remove\(\)/.test(helperSrc));
check('C1: el helper limpia el pin SOLO si apunta al mensaje expirado',
  !!helperSrc && /conversationPinned\/' \+ conversationId\)\.once\('value'\)/.test(helperSrc) &&
  /pin\.msgId === msgId/.test(helperSrc));
check('C1: el helper libera los trozos de adjuntos del mensaje',
  !!helperSrc && /_releaseChatFileRefsOfMsg\(_msg, msgId\)/.test(helperSrc));

const cdSrc = extractFn(html, '_startMsgCountdown');
check('C1: el countdown delega la limpieza en _expireChatMessage [falla en base]',
  !!cdSrc && /_expireChatMessage\(conversationId, msgId\)/.test(cdSrc));

check('C1: existe el guarda anti-doble-barrido por sesión',
  /const _expiredSweepDone = new Set\(\);/.test(html));

// Rama de render de un mensaje YA expirado → dispara el barrido.
const tombIdx = html.indexOf("} else if (msg.autoDestroyAt && msg.autoDestroyAt <= Date.now()) {");
const tombEnd = tombIdx === -1 ? -1 : html.indexOf("} else if (msg.type === 'sticker'", tombIdx);
const tombBranch = (tombIdx !== -1 && tombEnd !== -1) ? html.slice(tombIdx, tombEnd) : '';
check('C1: el render ya-expirado dispara el barrido una vez por sesión [falla en base]',
  tombBranch.indexOf('_expireChatMessage(conversationId, resolvedId, msg)') !== -1 &&
  tombBranch.indexOf('_expiredSweepDone.has(') !== -1);

// ---------- funcional: helper real en vm con DB falsa ----------
function makeDb(seed) {
  const store = JSON.parse(JSON.stringify(seed));
  function get(p) {
    const ks = p.split('/').filter(Boolean);
    let o = store;
    for (const k of ks) { if (o == null || typeof o !== 'object') return undefined; o = o[k]; }
    return o;
  }
  function set(p, v) {
    const ks = p.split('/').filter(Boolean);
    let o = store;
    for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null) o[ks[i]] = {}; o = o[ks[i]]; }
    const last = ks[ks.length - 1];
    if (v === null || v === undefined) delete o[last]; else o[last] = v;
  }
  function ref(p) {
    return {
      once: () => Promise.resolve({ val: () => get(p), exists: () => get(p) !== undefined }),
      remove: () => { set(p, null); return Promise.resolve(); },
      set: v => { set(p, v); return Promise.resolve(); },
      transaction: fn => {
        const cur = get(p);
        const nv = fn(cur === undefined ? null : cur);
        if (nv === undefined) return Promise.resolve({ committed: false });
        set(p, nv);
        return Promise.resolve({ committed: true, snapshot: { val: () => (nv === null ? null : nv) } });
      }
    };
  }
  return { get, DrexCloud: { database: () => ({ ref }) } };
}

function makeCtx(db) {
  const ctx = { DrexCloud: db.DrexCloud, _chatFileMetaCache: {}, _chatFileDataUrlCache: {}, console };
  vm.createContext(ctx);
  for (const fn of ['_releaseChatFileRef', '_releaseChatFileRefsOfMsg', '_expireChatMessage']) {
    const src = extractFn(html, fn);
    assert(src, 'funcion no encontrada en el HTML: ' + fn);
    vm.runInContext(src, ctx);
  }
  return ctx;
}

const NOW = Date.now();
function seed(pinMsgId) {
  return {
    conversationMessages: { room1: { m1: { text: 'secreto', autoDestroyAt: NOW - 60000, files: [{ fileId: 'f1' }] } } },
    conversationPinned: { room1: { msgId: pinMsgId, text: pinMsgId === 'm1' ? 'secreto' : 'otro' } },
    msgReactions: { room1: { m1: { u9: '❤' } } },
    chatFiles: { f1: { refs: 1, chunk_00000: 'DATOS' } }
  };
}
const flush = () => new Promise(r => setTimeout(r, 120));

(async () => {
  if (!helperSrc) {
    check('C1: funcional omitido (sin helper en base)', false);
  } else {
    // F1: barrido con el mensaje en mano (ruta del render ya-expirado).
    {
      const db = makeDb(seed('m1'));
      const ctx = makeCtx(db);
      const msg = db.get('conversationMessages/room1/m1');
      vm.runInContext("_expireChatMessage('room1','m1'," + JSON.stringify(msg) + ')', ctx);
      await flush();
      check('F1: el barrido borra la fila del mensaje expirado', db.get('conversationMessages/room1/m1') === undefined);
      check('F1: el barrido borra las reacciones huérfanas', db.get('msgReactions/room1/m1') === undefined);
      check('F1: el barrido borra el pin que apuntaba al mensaje', db.get('conversationPinned/room1') === undefined);
      check('F1: el barrido libera los trozos del adjunto (refs→0)', db.get('chatFiles/f1') === undefined);
    }
    // F2: el pin de OTRO mensaje no se toca.
    {
      const db = makeDb(seed('m2'));
      const ctx = makeCtx(db);
      const msg = db.get('conversationMessages/room1/m1');
      vm.runInContext("_expireChatMessage('room1','m1'," + JSON.stringify(msg) + ')', ctx);
      await flush();
      check('F2: el pin ajeno sobrevive al barrido', db.get('conversationPinned/room1') !== undefined &&
        db.get('conversationPinned/room1').msgId === 'm2');
      check('F2: el mensaje y sus reacciones sí se limpian', db.get('conversationMessages/room1/m1') === undefined &&
        db.get('msgReactions/room1/m1') === undefined);
    }
    // F3: ruta del countdown (sin msg): lee antes de borrar y libera archivos.
    {
      const db = makeDb(seed('m1'));
      const ctx = makeCtx(db);
      vm.runInContext("_expireChatMessage('room1','m1')", ctx);
      await flush();
      check('F3: la ruta countdown borra fila+pin+reacciones', db.get('conversationMessages/room1/m1') === undefined &&
        db.get('conversationPinned/room1') === undefined && db.get('msgReactions/room1/m1') === undefined);
      check('F3: la ruta countdown libera los trozos (lectura previa al borrado)', db.get('chatFiles/f1') === undefined);
    }
    // F4: idempotencia — doble barrido no revienta ni deja residuos.
    {
      const db = makeDb(seed('m1'));
      const ctx = makeCtx(db);
      const msg = db.get('conversationMessages/room1/m1');
      let threw = false;
      try {
        vm.runInContext("_expireChatMessage('room1','m1'," + JSON.stringify(msg) + ')', ctx);
        await flush();
        vm.runInContext("_expireChatMessage('room1','m1'," + JSON.stringify(msg) + ')', ctx);
        await flush();
      } catch (e) { threw = true; }
      check('F4: el doble barrido es idempotente (sin excepciones)', !threw);
      check('F4: tras el doble barrido no quedan residuos', db.get('conversationMessages/room1/m1') === undefined &&
        db.get('conversationPinned/room1') === undefined && db.get('chatFiles/f1') === undefined);
    }
  }

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})();
