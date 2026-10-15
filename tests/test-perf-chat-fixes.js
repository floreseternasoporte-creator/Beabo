'use strict';
/* PERF-CHAT: valida los fixes 1 (reacciones consolidadas) y 3 (debounce de
 * persist) extrayendo el código REAL del index.html y ejecutándolo en vm
 * contra un DrexCloud/DrexCache falsos.
 * Uso: node tests/test-perf-chat-fixes.js [--target <html>]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let TARGET = path.join(ROOT, 'index.html');
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) TARGET = process.argv[i + 1];
}
const src = fs.readFileSync(TARGET, 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

// ---- extracción por balanceo de llaves ----
function extractBlock(source, startRe) {
  const m = startRe.exec(source);
  if (!m) return null;
  let i = source.indexOf('{', m.index);
  let depth = 0, inStr = null;
  for (; i < source.length; i++) {
    const c = source[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return source.slice(m.index, i + 1); }
  }
  return null;
}

// ================= FIX 1: reacciones =================
const fix1src = [
  extractBlock(src, /let msgReactionListeners = new Map\(\);/),
  extractBlock(src, /let _msgReactionsConvRef = null;/),
  extractBlock(src, /function _ensureMsgReactionsConvSub\(conversationId\)/),
  extractBlock(src, /function subscribeMsgReactions\(conversationId, msgId\)/),
  extractBlock(src, /function detachAllMsgReactionListeners\(\)/),
].filter(Boolean).join('\n');
check('FIX1: funciones extraídas del HTML', fix1src.length > 500, String(fix1src.length));

{
  const subscriptions = []; // {path, event, cb}
  const renders = []; // [msgId, data]
  const fakeDb = {
    database: () => ({
      ref: (p) => ({
        path: p,
        on: (ev, cb) => { subscriptions.push({ path: p, event: ev, cb }); },
        off: (ev, cb) => {
          const i = subscriptions.findIndex(s => s.path === p && s.event === ev && s.cb === cb);
          if (i >= 0) subscriptions.splice(i, 1);
        },
      }),
    }),
  };
  const sandbox = {
    DrexCloud: fakeDb,
    renderMsgReactions: (id, data) => renders.push([id, data]),
    setTimeout, clearTimeout,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fix1src + '\nthis.__api = { subscribeMsgReactions, detachAllMsgReactionListeners };', sandbox);
  const api = sandbox.__api;

  // Abrir sala con 80 mensajes
  for (let i = 0; i < 80; i++) api.subscribeMsgReactions('sala1', 'msg' + i);
  const convSubs = subscriptions.filter(s => s.path === 'msgReactions/sala1');
  check('FIX1: 80 mensajes -> 1 sola suscripción', subscriptions.length === 1 && convSubs.length === 1,
    'subs=' + subscriptions.length);
  check('FIX1: sin suscripciones por mensaje', !subscriptions.some(s => /^msgReactions\/sala1\/msg/.test(s.path)));

  // Llega el snapshot inicial con reacciones en msg3 y msg70
  const snapData = { msg3: { u1: 'me gusta', u2: 'me gusta' }, msg70: { u9: 'fuego' } };
  convSubs[0].cb({ val: () => snapData });
  const painted = new Set(renders.map(r => r[0]));
  check('FIX1: snapshot inicial pinta msg3 y msg70', painted.has('msg3') && painted.has('msg70'));
  check('FIX1: no re-pinta los otros 78', renders.length === 2, 'renders=' + renders.length);
  const r3 = renders.find(r => r[0] === 'msg3');
  check('FIX1: datos de msg3 intactos', r3 && r3[1].u1 === 'me gusta' && r3[1].u2 === 'me gusta');

  // Mensaje nuevo tras el snapshot: pintado inmediato con su dato
  renders.length = 0;
  const snapData2 = { msg3: { u1: 'me gusta', u2: 'me gusta' }, msg70: { u9: 'fuego' }, msg81: { u5: 'jaja' } };
  subscriptions[0].cb({ val: () => snapData2 }); // refresca payload
  renders.length = 0;
  api.subscribeMsgReactions('sala1', 'msg81');
  check('FIX1: mensaje tardío se pinta de inmediato con su dato',
    renders.length === 1 && renders[0][0] === 'msg81' && renders[0][1].u5 === 'jaja',
    'renders=' + JSON.stringify(renders));

  // Cambio solo en msg3 -> solo msg3 se re-pinta
  renders.length = 0;
  const snap2 = { msg3: { u1: 'me gusta', u2: 'me gusta', u3: 'jaja' }, msg70: { u9: 'fuego' }, msg81: { u5: 'jaja' } };
  subscriptions[0].cb({ val: () => snap2 });
  check('FIX1: cambio en msg3 re-pinta SOLO msg3', renders.length === 1 && renders[0][0] === 'msg3',
    'renders=' + JSON.stringify(renders.map(r => r[0])));

  // Borrar reacciones de msg70 (remove()) -> se limpia con {}
  renders.length = 0;
  const snap3 = { msg3: { u1: 'me gusta', u2: 'me gusta', u3: 'jaja' }, msg81: { u5: 'jaja' } };
  subscriptions[0].cb({ val: () => snap3 });
  const r70 = renders.find(r => r[0] === 'msg70');
  check('FIX1: reacciones borradas limpian el contenedor', renders.length === 1 && r70 && Object.keys(r70[1]).length === 0);

  // Cambio de sala: se desuscribe la anterior y se suscribe la nueva
  renders.length = 0;
  api.subscribeMsgReactions('sala2', 'mx');
  check('FIX1: cambio de sala desuscribe la anterior', subscriptions.length === 1 && subscriptions[0].path === 'msgReactions/sala2',
    JSON.stringify(subscriptions.map(s => s.path)));

  // Detach al cerrar
  api.detachAllMsgReactionListeners();
  check('FIX1: detach elimina la suscripción', subscriptions.length === 0);
}

// ================= FIX 3: debounce de persist =================
const fix3src = [
  extractBlock(src, /function _persistChatMessagesNow\(conversationId, arr\)/),
  extractBlock(src, /let _persistChatMessagesTimer = null;/),
  extractBlock(src, /function _flushPersistChatMessages\(\)/),
  extractBlock(src, /function _persistChatMessages\(conversationId, arr\) \{/),
].filter(Boolean).join('\n');
check('FIX3: funciones extraídas del HTML', fix3src.length > 300, String(fix3src.length));

{
  const writes = [];
  const sandbox = {
    window: {
      DrexCache: { set: (ns, key, v, ttl) => writes.push({ ns, key, n: v.length, ttl }) },
      addEventListener: () => {},
    },
    setTimeout, clearTimeout,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fix3src + '\nthis.__api = { _persistChatMessages, _flushPersistChatMessages };', sandbox);
  const api = sandbox.__api;
  const mk = n => Array.from({ length: n }, (_, i) => ({ id: 'm' + i, text: 'hola ' + i }));

  // Ráfaga de apertura: 80 llamadas seguidas
  for (let i = 0; i < 80; i++) api._persistChatMessages('sala1', mk(30));
  check('FIX3: 80 llamadas en ráfaga -> 0 escrituras síncronas', writes.length === 0, 'writes=' + writes.length);

  setTimeout(() => {
    check('FIX3: tras 1.5s colapsa en 1 escritura', writes.length === 1, 'writes=' + writes.length);
    check('FIX3: escribe los últimos 30', writes[0] && writes[0].n === 30 && writes[0].key === 'msgs:sala1');

    // Flush en pagehide: escribe lo pendiente de inmediato
    writes.length = 0;
    api._persistChatMessages('sala9', mk(10));
    api._flushPersistChatMessages();
    check('FIX3: flush vuelca lo pendiente', writes.length === 1 && writes[0].key === 'msgs:sala9');

    console.log(`\nPERF-CHAT: ${pass} ok, ${fail} fallos`);
    process.exit(fail ? 1 : 0);
  }, 1800);
}
