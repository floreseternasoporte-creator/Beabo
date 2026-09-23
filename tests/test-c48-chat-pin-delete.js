// test-c48-chat-pin-delete.js — chat/fijados: el pin sobrevive al "eliminar para todos" (C48-C1).
// deleteChatMessageForAll marcaba el mensaje como type:'deleted' (texto
// vaciado) pero NUNCA tocaba conversationPinned/<sala> → el banner seguía
// mostrando el texto ORIGINAL del mensaje eliminado para ambos participantes:
// el "eliminar para todos" quedaba derrotado por el pin. Además el pin
// apuntaba a un mensaje ya sin nodo en el DOM (scrollToPinnedMessage mudo).
// Fix: al eliminar para todos, si conversationPinned/<sala>.msgId coincide
// con el mensaje eliminado, se borra el pin (los pins de otros mensajes no
// se tocan).
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
const del = extractFn(html, 'deleteChatMessageForAll');
check('C1: deleteChatMessageForAll lee el pin de la conversación al eliminar',
  /conversationPinned\/' \+ currentChatRoomId\)\.once\('value'\)/.test(del));
check('C1: el pin se borra solo si apunta al mensaje eliminado',
  /pin\.msgId === msgId/.test(del) && /conversationPinned\/' \+ currentChatRoomId\)\.remove\(\)/.test(del));

// ---------- funcional: función real en vm con DB falsa ----------
let db;
function freshDb() {
  db = {
    'conversationMessages/room1/msg1': { text: 'secreto', senderId: 'uidA' },
    'conversationPinned/room1': { msgId: 'msg1', text: 'secreto', senderName: 'Tú', pinnedBy: 'uidA', timestamp: 1 },
  };
}
function snapOf(p) {
  const v = Object.prototype.hasOwnProperty.call(db, p) ? db[p] : null;
  return { val: () => v, exists: () => v !== null,
    forEach: (cb) => { if (v && typeof v === 'object') Object.keys(v).forEach(k => cb({ key: k, val: () => v[k] })); } };
}
function makeRef(p) {
  return {
    once: () => Promise.resolve(snapOf(p)),
    update: (u) => { db[p] = Object.assign({}, db[p] || {}, u); return Promise.resolve(); },
    remove: () => { delete db[p]; return Promise.resolve(); },
    set: (v) => { db[p] = v; return Promise.resolve(); },
    limitToLast: () => ({ once: () => Promise.resolve(snapOf(p)) }),
  };
}
const fakeEl = { closest: () => ({ remove: () => {} }) };
let funcsOk = true;
(async () => {
  try {
    const code = `
var activeReactionMsgId = null;
var currentChatRoomId = 'room1';
var currentChatIsGroup = true;
var currentChatRecipient = null;
function hideChatReactionPicker() {}
var window = {};
var document = { querySelector: function () { return fakeEl; }, getElementById: function () { return null; } };
var DrexCloud = {
  auth: function () { return { currentUser: { uid: 'uidA' } }; },
  database: function () { return { ref: function (p) { return makeRef(p); } }; },
};
` + extractFn(html, '_removeChatMsgNodeInstant') + '\n' + extractFn(html, 'deleteChatMessageForAll');
    const ctx = { console, JSON, Object, Array, Promise, Date, Math, String, Number, setTimeout, fakeEl, makeRef };
    vm.createContext(ctx);
    vm.runInContext(code, ctx);

    async function scenario(pinMsgId, delMsgId) {
      freshDb();
      if (pinMsgId !== 'msg1') db['conversationPinned/room1'] = { msgId: pinMsgId, text: 'otro', senderName: 'X', pinnedBy: 'uidA', timestamp: 1 };
      vm.runInContext('activeReactionMsgId = ' + JSON.stringify(delMsgId) + ';', ctx);
      vm.runInContext('deleteChatMessageForAll();', ctx);
      await new Promise(r => setTimeout(r, 100));
      const m = db['conversationMessages/room1/' + delMsgId];
      return {
        msgDeleted: !!(m && m.type === 'deleted'),
        pin: Object.prototype.hasOwnProperty.call(db, 'conversationPinned/room1') ? db['conversationPinned/room1'] : null,
      };
    }

    const r = await scenario('msg1', 'msg1');
    check('C1 funcional: el mensaje queda marcado como eliminado para todos', r.msgDeleted);
    check('C1 funcional: el pin huérfano se elimina junto al mensaje', r.pin === null);
    const r2 = await scenario('msg2', 'msg1');
    check('C1 funcional: el pin de otro mensaje no se toca', r2.pin !== null && r2.pin.msgId === 'msg2');
  } catch (e) { funcsOk = false; console.log('  (harness: ' + e.message + ')'); }
  check('C1 funcional: harness con función real ejecutado', funcsOk);
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
