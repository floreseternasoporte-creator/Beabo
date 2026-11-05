/* ================================================================
 * C79-N1: fijar (pinning) el comportamiento documentado del ding de
 * notificaciones. No cambia código: documenta como sano el estado
 * actual para que futuros ciclos no lo "arreglen" por accidente.
 *
 * Matriz fijada (decisiones C9-A, C62, H2-DING-3):
 *  1. Ráfaga pura (la más reciente no leída y no silenciada):
 *     EXACTAMENTE un aviso (sonido + notificación del sistema).
 *  2. Ráfaga mixta con la más reciente de un chat silenciado:
 *     CERO avisos (decisión de producto C62: el panel de silenciar
 *     promete "dejarás de recibir avisos de esa conversación").
 *  3. La más reciente ya leída (no silenciada): ding genérico
 *     H2-DING-3 (suena por las demás no leídas de la ráfaga).
 *  4. Rama de decrecimiento (announceNewestNotificationIfNew, C9-A):
 *     no re-avisa una notificación ya avisada (mismo notificationId).
 *
 * Extrae las funciones REALES de ../index.html (sin rutas absolutas ni git).
 * Ejecutar con: node tests/test-c79-notif-ding-pinning.js
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFn(src, name) {
  const m = new RegExp('function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('no encontrada: ' + name);
  let i = src.indexOf('{', m.index);
  const start = m.index;
  let depth = 0, str = null, tpl = 0, lineC = false, blockC = false, esc = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (lineC) { if (c === '\n') lineC = false; continue; }
    if (blockC) { if (c === '*' && n === '/') { blockC = false; i++; } continue; }
    if (str) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (str === '`' && c === '$' && n === '{') { tpl++; i++; continue; }
      if (c === str && tpl === 0) { str = null; continue; }
      if (str === '`' && c === '}' && tpl > 0) { tpl--; continue; }
      continue;
    }
    if (c === '/' && n === '/') { lineC = true; i++; continue; }
    if (c === '/' && n === '*') { blockC = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { str = c; tpl = 0; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('llaves sin cerrar: ' + name);
}

const FNS = ['announceNewestNotification', 'announceNewestNotificationIfNew',
  'isChatNotificationMuted', 'isMuteActive']
  .map(n => extractFn(HTML, n)).join('\n');

function makeSandbox(newestNotif, mutedUids) {
  const now = 2000000;
  const state = { sound: 0, sys: 0 };
  const muteUsers = {};
  (mutedUids || []).forEach(u => { muteUsers[u] = { muteUntil: now + 3600000 }; });
  const snapshot = {
    exists: () => true,
    forEach: (cb) => { cb({ val: () => newestNotif }); },
  };
  const sandbox = {
    Date: { now: () => now },
    DrexCloud: {
      database: () => ({
        ref: () => ({
          orderByChild: () => ({ limitToLast: () => ({ once: () => Promise.resolve(snapshot) }) }),
        }),
      }),
      auth: () => ({ currentUser: { uid: 'ME' } }),
    },
    chatMuteCache: { users: muteUsers, groups: {} },
    notifUnreadLastAnnouncedId: null,
    // El aviso del sistema real también reproduce el sonido: contarlo como tal.
    drexPlayNotificationSound: () => { state.sound++; },
    fireDrexSystemNotification: () => { state.sound++; state.sys++; },
    console,
    _state: state,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(FNS, sandbox, { filename: 'notif-ding-fns.js' });
  return sandbox;
}

async function flush() { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); }

function chatMsg(uid, read) {
  return { notificationId: 'n-' + uid, read: !!read, type: 'message', actionType: 'chat', actionId: uid, timestamp: 1999999, message: 'hola' };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

(async () => {
  await test('1. ráfaga pura (más reciente no leída, no silenciada): exactamente UN aviso', async () => {
    const sb = makeSandbox(chatMsg('STRANGER'), []);
    vm.runInContext("announceNewestNotification('ME')", sb);
    await flush();
    assert.strictEqual(sb._state.sound, 1, 'sonido=' + sb._state.sound + ' (esperado exactamente 1)');
    assert.strictEqual(sb._state.sys, 1, 'sys=' + sb._state.sys);
  });

  await test('2. ráfaga mixta con la más reciente silenciada: CERO avisos (decisión C62)', async () => {
    const sb = makeSandbox(chatMsg('MUTED'), ['MUTED']);
    vm.runInContext("announceNewestNotification('ME')", sb);
    await flush();
    assert.strictEqual(sb._state.sound, 0, 'sonido=' + sb._state.sound);
    assert.strictEqual(sb._state.sys, 0, 'sys=' + sb._state.sys);
    assert.strictEqual(sb.notifUnreadLastAnnouncedId, 'n-MUTED', 'debe recordar la avisada');
  });

  await test('3. más reciente ya leída (no silenciada): ding genérico H2-DING-3, sin aviso del sistema', async () => {
    const sb = makeSandbox(chatMsg('STRANGER', true), []);
    vm.runInContext("announceNewestNotification('ME')", sb);
    await flush();
    assert.strictEqual(sb._state.sound, 1, 'sonido=' + sb._state.sound);
    assert.strictEqual(sb._state.sys, 0, 'sys=' + sb._state.sys);
  });

  await test('4a. decrecimiento: no re-avisa la misma notificación (C9-A)', async () => {
    const sb = makeSandbox(chatMsg('STRANGER'), []);
    sb.notifUnreadLastAnnouncedId = 'n-STRANGER'; // ya avisada antes del reset remoto
    vm.runInContext("announceNewestNotificationIfNew('ME')", sb);
    await flush();
    assert.strictEqual(sb._state.sound, 0, 'sonido=' + sb._state.sound);
    assert.strictEqual(sb._state.sys, 0, 'sys=' + sb._state.sys);
  });

  await test('4b. decrecimiento: SÍ avisa una notificación realmente nueva', async () => {
    const sb = makeSandbox(chatMsg('NEWBIE'), []);
    sb.notifUnreadLastAnnouncedId = 'n-OLD';
    vm.runInContext("announceNewestNotificationIfNew('ME')", sb);
    await flush();
    assert.strictEqual(sb._state.sound, 1, 'sonido=' + sb._state.sound);
    assert.strictEqual(sb._state.sys, 1, 'sys=' + sb._state.sys);
  });

  console.log(failed ? `\n${failed} FALLO(S), ${passed} ok` : `\n${passed} ok`);
  process.exit(failed ? 1 : 0);
})();
