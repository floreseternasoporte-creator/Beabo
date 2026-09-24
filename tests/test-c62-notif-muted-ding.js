/* ================================================================
 * C62-N1: un chat silenciado no debe sonar ni avisar por la campana.
 *
 * Defecto (base): announceNewestNotification() (rama de crecimiento del
 * agregado notifUnread) suprime el aviso completo del sistema para la
 * notificación más reciente si es de un chat silenciado
 * (isChatNotificationMuted), PERO la rama H2-DING-3 igual dispara
 * drexPlayNotificationSound() ("aviso genérico por las demás").
 * Resultado: silencias un chat y aun así suena el ding cuando llega un
 * mensaje suyo. La ayuda del producto promete lo contrario:
 * "Dejarás de recibir avisos de esa conversación durante el tiempo que
 * elijas." La rama de decrecimiento (announceNewestNotificationIfNew,
 * C9-A) ya aplica la política correcta: no avisar si la más reciente
 * está silenciada.
 *
 * PoC: la notificación más reciente es un mensaje de chat de un
 * contacto silenciado → el ding NO debe sonar.
 * En base falla (ding = 1); con el fix pasa (ding = 0).
 * Controles: la más reciente no silenciada sí avisa (sistema), y la más
 * reciente ya leída no silenciada conserva el ding genérico H2-DING-3.
 *
 * Extrae las funciones REALES de ../index.html (sin rutas absolutas ni git).
 * Ejecutar con: node tests/test-c62-notif-muted-ding.js
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

const FNS = ['announceNewestNotification', 'isChatNotificationMuted', 'isMuteActive']
  .map(n => extractFn(HTML, n)).join('\n');

function makeSandbox(newestNotif, mutedUids) {
  const now = 2000000;
  const state = { ding: 0, sys: 0 };
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
    drexPlayNotificationSound: () => { state.ding++; },
    fireDrexSystemNotification: () => { state.sys++; },
    console,
    _state: state,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(FNS, sandbox, { filename: 'notif-ding-fns.js' });
  return sandbox;
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
}

function chatMsg(uid) {
  return { notificationId: 'n-' + uid, read: false, type: 'message', actionType: 'chat', actionId: uid, timestamp: 1999999, message: 'hola' };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

(async () => {
  await test('chat silenciado: la más reciente NO suena (ding = 0, sin aviso del sistema)', async () => {
    const sb = makeSandbox(chatMsg('OTHER'), ['OTHER']);
    vm.runInContext("announceNewestNotification('ME')", sb);
    await flush();
    assert.strictEqual(sb._state.ding, 0, 'ding sonó ' + sb._state.ding + ' vez/veces');
    assert.strictEqual(sb._state.sys, 0, 'aviso del sistema disparado ' + sb._state.sys + ' vez/veces');
    assert.strictEqual(sb.notifUnreadLastAnnouncedId, 'n-OTHER', 'debe recordar la avisada para no re-sonar');
  });

  await test('control: chat NO silenciado sí dispara el aviso del sistema', async () => {
    const sb = makeSandbox(chatMsg('STRANGER'), []);
    vm.runInContext("announceNewestNotification('ME')", sb);
    await flush();
    assert.strictEqual(sb._state.sys, 1, 'sys=' + sb._state.sys);
  });

  await test('control: la más reciente ya leída (no silenciada) conserva el ding genérico H2-DING-3', async () => {
    const n = chatMsg('STRANGER'); n.read = true;
    const sb = makeSandbox(n, []);
    vm.runInContext("announceNewestNotification('ME')", sb);
    await flush();
    assert.strictEqual(sb._state.ding, 1, 'ding=' + sb._state.ding);
    assert.strictEqual(sb._state.sys, 0, 'sys=' + sb._state.sys);
  });

  console.log(failed ? `\n${failed} FALLO(S), ${passed} ok` : `\n${passed} ok`);
  process.exit(failed ? 1 : 0);
})();
