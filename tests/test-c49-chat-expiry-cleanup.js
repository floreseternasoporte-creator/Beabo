// test-c49-chat-expiry-cleanup.js — chat/expiración: el pin y las reacciones
// sobreviven a la expiración de mensajes temporales y al consumo de "ver una
// vez" (C49-C1).
// _startMsgCountdown borraba el nodo conversationMessages/<sala>/<msgId> al
// expirar el temporizador, pero NUNCA tocaba conversationPinned/<sala> (el
// banner cachea el texto y lo mostraba para siempre, derrotando la promesa
// de privacidad de los mensajes temporales — misma familia que C48-C1) ni
// msgReactions/<sala>/<msgId> (reacciones huérfanas en la BD).
// openViewOnceMessage tenía el mismo hueco al consumirse el mensaje.
// Fix: al expirar/consumirse, se borran las reacciones y el pin SOLO si
// pin.msgId === msgId (los pins de otros mensajes no se tocan).
// Convención: estático + funcional contra el archivo del repo, sin rutas
// absolutas ni historial de git. Los checks SOLO pasan con el fix presente.
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
  assert(m, 'funcion no encontrada: ' + name);
  const start = m.index;
  let brace = src.indexOf('{', start);
  let depth = 0, i = brace;
  for (;;) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return src.slice(start, i + 1);
}

// ---------- estático ----------
const cd = extractFn(html, '_startMsgCountdown');
// C58-C1: la limpieza de expiración vive en _expireChatMessage; el countdown delega.
const xcm = extractFn(html, '_expireChatMessage');
check('C1: _startMsgCountdown delega la expiración en _expireChatMessage',
  /_expireChatMessage\(conversationId, msgId\)/.test(cd));
check('C1: _expireChatMessage borra las reacciones del mensaje al expirar',
  !!xcm && /msgReactions\/' \+ conversationId \+ '\/' \+ msgId\)\.remove\(\)/.test(xcm));
check('C1: _expireChatMessage limpia el pin solo si apunta al mensaje expirado',
  !!xcm &&
  /conversationPinned\/' \+ conversationId\)\.once\('value'\)/.test(xcm) &&
  /pin\.msgId === msgId/.test(xcm) &&
  /conversationPinned\/' \+ conversationId\)\.remove\(\)/.test(xcm));

const vo = extractFn(html, 'openViewOnceMessage');
check('C1: openViewOnceMessage borra las reacciones del mensaje al consumirse',
  /msgReactions\/' \+ convoId \+ '\/' \+ msgId\)\.remove\(\)/.test(vo));
check('C1: openViewOnceMessage limpia el pin solo si apunta al mensaje consumido',
  /conversationPinned\/' \+ convoId\)\.once\('value'\)/.test(vo) &&
  /pin\.msgId === msgId/.test(vo) &&
  /conversationPinned\/' \+ convoId\)\.remove\(\)/.test(vo));

// ---------- funcional: funciones reales en vm con DB falsa ----------
let db;
const NOW = 1700000000000;
function freshDb(room, msgId) {
  db = {};
  db['conversationMessages/' + room + '/' + msgId] = { text: 'secreto temporal', autoDestroyAt: NOW - 1000 };
  db['msgReactions/' + room + '/' + msgId] = { uidB: 'me gusta' };
  db['conversationPinned/' + room] = { msgId: msgId, text: 'secreto temporal', senderName: 'Tú', pinnedBy: 'uidA', timestamp: 1 };
  // Pin de OTRO mensaje en otra sala: no debe tocarse.
  db['conversationPinned/roomOther'] = { msgId: 'zzz', text: 'otro pin', timestamp: 1 };
}
function makeRef(p) {
  return {
    once: () => Promise.resolve({ val: () => (Object.prototype.hasOwnProperty.call(db, p) ? db[p] : null) }),
    remove: () => { delete db[p]; return Promise.resolve(); },
    set: (v) => { db[p] = v; return Promise.resolve(); },
  };
}

(async () => {
  // Caso 1: expira el temporizador de un mensaje temporal fijado.
  freshDb('room1', 'm1');
  const ivCbs = [];
  const ctx1 = {
    console, JSON, Object, Array, Promise, Date, Math, String, Number,
    setInterval: (cb) => { ivCbs.push(cb); return ivCbs.length; },
    clearInterval: () => {},
    setTimeout: () => 0,
    document: { getElementById: () => null },
    _msgCountdownIntervals: {},
    _chatFileMetaCache: {},
    _chatFileDataUrlCache: {},
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'uidA' } }),
      database: () => ({ ref: (p) => makeRef(p) }),
    },
  };
  ctx1.Date = { now: () => NOW };
  vm.createContext(ctx1);
  // C50-C1: _startMsgCountdown libera los archivos del mensaje expirado.
  vm.runInContext(extractFn(html, '_releaseChatFileRef') + '\n' + extractFn(html, '_releaseChatFileRefsOfMsg') + '\n' + extractFn(html, '_expireChatMessage'), ctx1); // C58-C1
  vm.runInContext(extractFn(html, '_startMsgCountdown'), ctx1);
  vm.runInContext('_startMsgCountdown("m1",' + (NOW - 5000) + ',"room1")', ctx1);
  assert(ivCbs.length === 1, 'el intervalo del countdown arranca');
  ivCbs[0](); // primer tick: ya vencido -> rama de expiración
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  check('C1: el mensaje expirado se borra de conversationMessages',
    !Object.prototype.hasOwnProperty.call(db, 'conversationMessages/room1/m1'));
  check('C1: las reacciones huérfanas se borran (msgReactions/room1/m1)',
    !Object.prototype.hasOwnProperty.call(db, 'msgReactions/room1/m1'));
  check('C1: el pin del mensaje expirado se borra (conversationPinned/room1)',
    !Object.prototype.hasOwnProperty.call(db, 'conversationPinned/room1'));
  check('C1: el pin de otra sala queda intacto',
    Object.prototype.hasOwnProperty.call(db, 'conversationPinned/roomOther'));

  // Caso 2: se consume un mensaje "ver una vez" fijado.
  freshDb('room2', 'm9');
  const toCbs = [];
  const fakeTrigger = { closest: () => ({ set innerHTML(v) {}, get innerHTML() { return ''; } }) };
  const ctx2 = {
    console, JSON, Object, Array, Promise, Date, Math, String, Number,
    setTimeout: (cb) => { toCbs.push(cb); return toCbs.length; },
    setInterval: () => 0, clearInterval: () => {},
    document: { getElementById: () => null },
    escapeHtml: (s) => String(s),
    _t: fakeTrigger,
    _chatFileMetaCache: {},
    _chatFileDataUrlCache: {},
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'uidA' } }),
      database: () => ({ ref: (p) => makeRef(p) }),
    },
  };
  vm.createContext(ctx2);
  // C50-C1: openViewOnceMessage libera los archivos del mensaje consumido.
  vm.runInContext(extractFn(html, '_releaseChatFileRef') + '\n' + extractFn(html, '_releaseChatFileRefsOfMsg'), ctx2);
  vm.runInContext(extractFn(html, 'openViewOnceMessage'), ctx2);
  vm.runInContext('openViewOnceMessage("m9","room2",_t)', ctx2);
  await new Promise(r => setImmediate(r));
  assert(toCbs.length === 1, 'el borrado del viewOnce se programa');
  toCbs[0](); // dispara el borrado a los 5 s
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  check('C1: el mensaje viewOnce se borra de conversationMessages',
    !Object.prototype.hasOwnProperty.call(db, 'conversationMessages/room2/m9'));
  check('C1: las reacciones huérfanas se borran (msgReactions/room2/m9)',
    !Object.prototype.hasOwnProperty.call(db, 'msgReactions/room2/m9'));
  check('C1: el pin del mensaje consumido se borra (conversationPinned/room2)',
    !Object.prototype.hasOwnProperty.call(db, 'conversationPinned/room2'));

  console.log(`\n${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
