// test-c56-chat-edit-pin-sync.js — chat/edición: el banner del pin cachea el
// texto del mensaje fijado y saveEditedChatMessage solo actualizaba
// conversationMessages/<sala>/<msgId> (C56-C1). Resultado: fijar "secreto",
// editarlo a "[redactado]" y el banner seguía revelando "secreto" para ambos
// participantes para siempre (misma familia que C48-C1/C49-C1, ahora por la
// ruta de edición). Fix: al guardar la edición, se sincroniza el texto del pin
// SOLO si pin.msgId === msgId (los pins de otros mensajes no se tocan).
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
const se = extractFn(html, 'saveEditedChatMessage');
check('C1: saveEditedChatMessage lee el pin de la sala al guardar la edicion',
  /conversationPinned\/' \+ currentChatRoomId\)\.once\('value'\)/.test(se));
check('C1: saveEditedChatMessage sincroniza el texto del pin solo si apunta al mensaje editado',
  /pin\.msgId === msgId/.test(se) &&
  /conversationPinned\/' \+ currentChatRoomId\)\.update\(\{ text: newText \}\)/.test(se));

// ---------- funcional: la función REAL en vm con DB falsa ----------
let db;
function freshDb() {
  db = {};
  db['conversationMessages/room1/m1'] = { text: 'secreto original', senderId: 'uidA' };
  db['conversationPinned/room1'] = { msgId: 'm1', text: 'secreto original', senderName: 'Tú', pinnedBy: 'uidA', timestamp: 1 };
  // Pin de OTRO mensaje en la misma sala: no debe tocarse.
  db['conversationPinned/room2'] = { msgId: 'mX', text: 'pin ajeno', senderName: 'Tú', pinnedBy: 'uidA', timestamp: 1 };
  db['conversationMessages/room2/mX'] = { text: 'pin ajeno', senderId: 'uidA' };
}
function makeRef(p) {
  return {
    once: () => Promise.resolve({ val: () => (Object.prototype.hasOwnProperty.call(db, p) ? db[p] : null) }),
    update: (v) => { db[p] = Object.assign({}, db[p] || {}, v); return Promise.resolve(); },
    remove: () => { delete db[p]; return Promise.resolve(); },
    set: (v) => { db[p] = v; return Promise.resolve(); },
  };
}

async function runEdit(room, msgId, newText, reset = true) {
  if (reset) freshDb();
  const modal = { dataset: { msgId }, classList: { add() {} } };
  const input = { value: newText };
  const ctx = {
    console, JSON, Object, Array, Promise, Date, Math, String, Number,
    setTimeout: () => 0,
    document: { getElementById: (id) => id === 'chat-edit-modal' ? modal : (id === 'chat-edit-input' ? input : null) },
    currentChatRoomId: room,
    showMiniToast: () => {},
    appT: (s) => s,
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'uidA' } }),
      database: () => ({ ref: (p) => makeRef(p) }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFn(html, 'saveEditedChatMessage'), ctx);
  vm.runInContext('saveEditedChatMessage()', ctx);
  for (let k = 0; k < 6; k++) await new Promise(r => setImmediate(r));
}

(async () => {
  // Caso 1: se edita el mensaje fijado -> el banner refleja el texto nuevo.
  await runEdit('room1', 'm1', 'texto redactado');
  check('C1: el mensaje queda con el texto nuevo',
    db['conversationMessages/room1/m1'].text === 'texto redactado');
  check('C1: el pin del mensaje editado sincroniza el texto nuevo',
    db['conversationPinned/room1'] && db['conversationPinned/room1'].text === 'texto redactado');
  check('C1: el pin conserva msgId y el resto de campos',
    db['conversationPinned/room1'] && db['conversationPinned/room1'].msgId === 'm1' &&
    db['conversationPinned/room1'].pinnedBy === 'uidA');
  check('C1: el pin de otro mensaje queda intacto',
    db['conversationPinned/room2'].text === 'pin ajeno');

  // Caso 2: se edita un mensaje NO fijado -> no se crea ni toca ningun pin.
  await runEdit('room1', 'm1', 'otro texto');
  delete db['conversationPinned/room1']; // simula sala sin pin
  await runEdit('room1', 'm1', 'tercer texto', false);
  check('C1: sin pin en la sala, la edicion no crea uno',
    !Object.prototype.hasOwnProperty.call(db, 'conversationPinned/room1'));

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})();
