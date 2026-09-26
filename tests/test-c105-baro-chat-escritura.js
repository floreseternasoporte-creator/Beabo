#!/usr/bin/env node
/* test-lane-b.js — tests del carril B (herramientas de escritura en chats).
   Ejecuta block-lane-b.js en una sandbox con RTDB en memoria y verifica:
   registro de las 6 herramientas, iconos, intenciones en ES/EN/ZH/PT,
   i18n en los 4 idiomas, confirmación obligatoria (enviar/eliminar) y
   compuertas de permiso/bloqueo. Sin DOM, sin red, sin ~/workspace/beabo. */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* Carga del bloque v4 desde index.html (patrón c103): --target opcional. */
let __v4ExplicitTarget = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) __v4ExplicitTarget = process.argv[++i];
}
function __v4ExtractBlock(m) {
  const html = fs.readFileSync(__v4ExplicitTarget || path.join(__dirname, '..', 'index.html'), 'utf8');
  let si = html.indexOf('/* ================= ' + m);
  if (si === -1) si = html.indexOf(m);
  if (si === -1) throw new Error('marcador ausente en target: ' + m);
  const slice = html.slice(si);
  const ni = slice.indexOf('/* ================= BARO \u00b7 sub-bloque 8', 1);
  const ei = slice.indexOf('</script>');
  let end = slice.length;
  if (ni !== -1) end = Math.min(end, ni);
  if (ei !== -1) end = Math.min(end, ei);
  return slice.slice(0, end);
}

/* ================= harness ================= */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? ' :: ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'esperado ' + JSON.stringify(b) + ', recibido ' + JSON.stringify(a)); }

/* ================= RTDB en memoria ================= */
let tree = {};
let writes = [];
let pushN = 0;
function clone(v) { return (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v; }
function segs(p) { return String(p || '').split('/').filter(s => s !== ''); }
function getAt(p) {
  let n = tree;
  for (const s of segs(p)) { if (n == null || typeof n !== 'object') return undefined; n = n[s]; }
  return n;
}
function setAt(p, v) {
  let n = tree;
  const ss = segs(p);
  for (let i = 0; i < ss.length - 1; i++) {
    if (typeof n[ss[i]] !== 'object' || n[ss[i]] === null) n[ss[i]] = {};
    n = n[ss[i]];
  }
  n[ss[ss.length - 1]] = v;
}
function delAt(p) {
  let n = tree;
  const ss = segs(p);
  for (let i = 0; i < ss.length - 1; i++) {
    if (typeof n[ss[i]] !== 'object' || n[ss[i]] === null) return;
    n = n[ss[i]];
  }
  delete n[ss[ss.length - 1]];
}
function ref(p) {
  return {
    once: async () => ({ val: () => clone(getAt(p)), exists: () => getAt(p) != null }),
    set: async (v) => { writes.push(['set', p]); setAt(p, clone(v)); },
    update: async (o) => {
      writes.push(['update', p]);
      for (const k of Object.keys(o || {})) {
        const v = o[k];
        if (v === null || v === undefined) delAt(p ? p + '/' + k : k);
        else setAt(p ? p + '/' + k : k, clone(v));
      }
    },
    remove: async () => { writes.push(['remove', p]); delAt(p); },
    push: () => {
      const key = 'msg_' + (++pushN);
      writes.push(['push', p + '/' + key]);
      return { key, set: async (v) => { setAt(p + '/' + key, clone(v)); } };
    },
    transaction: async (fn) => {
      const nv = fn(clone(getAt(p)));
      if (nv === undefined) return { committed: false };
      writes.push(['txn', p]);
      setAt(p, clone(nv));
      return { committed: true };
    }
  };
}
const dbMock = { ref };

/* ================= mocks del entorno Baro ================= */
const registered = {};
const said = [];
const confirmCalls = [];
const notifCalls = [];
/* El bloque define G = globalThis (como en la app real): los hooks de Baro
   son globales, así que los mocks van directo en el sandbox. */
const sandbox = {
  module: { exports: {} },
  baroRegisterTool: (name, def) => { registered[name] = def; },
  baroIntentRules: [],
  baroIntentToTool: {},
  BARO_ICONS: {},
  DrexCloud: { database: () => dbMock },
  baroAddBaroMessage: (html) => { said.push(String(html)); },
  baroAskConfirm: (opts) => { confirmCalls.push(opts); return { catch: () => {} }; },
  addNotification: async (uid, text, type, extra) => { notifCalls.push({ uid, text, type, extra }); }
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;

const src = __v4ExtractBlock('BARO · sub-bloque 8B');
vm.runInNewContext(src, sandbox, { filename: 'block-lane-b.js' });
const M = sandbox.module.exports;
const pure = M.pure;

/* ================= ctx ================= */
function mkCtx(lang, uid) {
  return {
    lang,
    user: uid ? { uid } : null,
    t: (key) => { const e = M.BARO_I18N_6BCHAT[key]; return (e && e[lang]) || key; },
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  };
}
const ALICE = 'uid_alice', BOB = 'uid_bob', CARL = 'uid_carl';
function seedBase() {
  tree = {}; writes = []; pushN = 0; confirmCalls.length = 0; notifCalls.length = 0; said.length = 0;
  setAt('usernames/juan', BOB);
  setAt('usernames/carlos', CARL);
  setAt('usernames/ana', ALICE);
  setAt('users/' + ALICE, { username: 'ana', displayName: 'Ana' });
  setAt('users/' + BOB, { username: 'juan', displayName: 'Bob' });
  setAt('users/' + CARL, { username: 'carlos', displayName: 'Carlos' });
  setAt('conversationMessages/room1/m1', { senderId: BOB, text: 'Hola Ana', timestamp: 1000 });
  setAt('conversationMessages/room1/m2', { senderId: ALICE, text: 'Mi mensaje', timestamp: 2000 });
  setAt('conversationMessages/room1/m3', { senderId: BOB, text: 'temporal', timestamp: 3000, viewOnce: true });
}
async function run(name, args, lang, uid) {
  return await registered[name].run(args || {}, mkCtx(lang || 'es', uid === undefined ? ALICE : uid));
}

/* ================= 1. registro ================= */
(async () => {
  const tools = ['chat_enviar', 'chat_reaccionar', 'chat_editar', 'chat_eliminar', 'chat_fijar', 'chat_reenviar'];
  tools.forEach(t => {
    ok(registered[t], 'registrada ' + t);
    ok(registered[t] && typeof registered[t].run === 'function', t + ' tiene run');
    ok(registered[t] && typeof registered[t].label === 'string', t + ' tiene label');
    ok(registered[t] && typeof registered[t].stepKey === 'string', t + ' tiene stepKey');
    ok(registered[t] && typeof registered[t].icon === 'string', t + ' tiene icon');
    ok(registered[t] && sandbox.BARO_ICONS[registered[t].icon], t + ' icono en BARO_ICONS');
    eq(sandbox.baroIntentToTool[t], t, t + ' en baroIntentToTool');
  });
  eq(Object.keys(M.BARO_ICONS_6BCHAT).length, 6, 'seis iconos propios');
  Object.keys(M.BARO_ICONS_6BCHAT).forEach(k => {
    const s = M.BARO_ICONS_6BCHAT[k];
    ok(s.indexOf('<svg') !== -1 && s.indexOf('stroke="currentColor"') !== -1, 'icono ' + k + ' es svg índigo válido');
    eq(sandbox.BARO_ICONS[k], s, 'icono ' + k + ' fusionado en BARO_ICONS');
  });
  eq(sandbox.baroIntentRules.length, 6, 'seis reglas de intención agregadas');

  /* ================= 2. intenciones ES/EN/ZH/PT ================= */
  function ruleOf(intent) { return M.BARO_6BCHAT_RULES.find(r => r.intent === intent); }
  function matches(intent, text) {
    const r = ruleOf(intent);
    return r.patterns.some(p => p.test(text));
  }
  // chat_enviar
  eq(matches('chat_enviar', 'Envíale un mensaje a @juan hola qué tal'), true, 'enviar ES detectado');
  eq(matches('chat_enviar', 'Send a message to @juan hey what is up'), true, 'enviar EN detectado');
  eq(matches('chat_enviar', '发送消息给 @juan 你好吗'), true, 'enviar ZH detectado');
  eq(matches('chat_enviar', 'Envia uma mensagem para @juan olá tudo bem'), true, 'enviar PT detectado');
  let ex = ruleOf('chat_enviar').extract('Envíale un mensaje a @juan hola qué tal');
  eq(ex.destinatario, '@juan', 'enviar ES extrae destinatario');
  ok(ex.texto && ex.texto.indexOf('hola') !== -1, 'enviar ES extrae texto: ' + ex.texto);
  ex = ruleOf('chat_enviar').extract('Send a message to @juan hey what is up');
  eq(ex.destinatario, '@juan', 'enviar EN extrae destinatario');
  ok(ex.texto && ex.texto.indexOf('hey') !== -1, 'enviar EN extrae texto: ' + ex.texto);
  ex = ruleOf('chat_enviar').extract('发送消息给 @juan 你好吗');
  eq(ex.destinatario, '@juan', 'enviar ZH extrae destinatario');
  ok(ex.texto && ex.texto.indexOf('你好吗') !== -1, 'enviar ZH extrae texto: ' + ex.texto);
  ex = ruleOf('chat_enviar').extract('Envia uma mensagem para @juan olá tudo bem');
  eq(ex.destinatario, '@juan', 'enviar PT extrae destinatario');
  ok(ex.texto && ex.texto.indexOf('olá') !== -1, 'enviar PT extrae texto: ' + ex.texto);
  ex = ruleOf('chat_enviar').extract('Envía un mensaje hola');
  ok(ex && ex.ambiguous === true && ex.reason === 'missing_dest', 'enviar sin destino -> ambigüedad');
  // chat_reaccionar
  eq(ruleOf('chat_reaccionar').extract('Reacciona con me gusta a este mensaje').emoji, 'me gusta', 'reaccionar ES');
  eq(ruleOf('chat_reaccionar').extract('React with fire to this message').emoji, 'fuego', 'reaccionar EN');
  eq(ruleOf('chat_reaccionar').extract('给这条消息点赞').emoji, 'me gusta', 'reaccionar ZH');
  eq(ruleOf('chat_reaccionar').extract('Reage com fogo a esta mensagem').emoji, 'fuego', 'reaccionar PT');
  // chat_editar
  ok(ruleOf('chat_editar').extract('Edita mi mensaje'), 'editar ES');
  ok(ruleOf('chat_editar').extract('Edit my message'), 'editar EN');
  ok(ruleOf('chat_editar').extract('编辑我的消息'), 'editar ZH');
  ok(ruleOf('chat_editar').extract('Edita a minha mensagem'), 'editar PT');
  eq(ruleOf('chat_editar').extract('Edita mi post'), null, 'editar post -> declina (no es chat)');
  // chat_eliminar
  eq(ruleOf('chat_eliminar').extract('Elimina ese mensaje para todos').modo, 'para_todos', 'eliminar ES para_todos');
  eq(ruleOf('chat_eliminar').extract('Delete that message for me').modo, 'para_mi', 'eliminar EN para_mi');
  ok(ruleOf('chat_eliminar').extract('删除这条消息'), 'eliminar ZH');
  eq(ruleOf('chat_eliminar').extract('Apaga essa mensagem para mim').modo, 'para_mi', 'eliminar PT para_mi');
  eq(ruleOf('chat_eliminar').extract('Elimina mi post'), null, 'eliminar post -> declina');
  eq(ruleOf('chat_eliminar').extract('Delete my post'), null, 'delete post EN -> declina');
  // chat_fijar
  eq(ruleOf('chat_fijar').extract('Fija este mensaje').accion, 'fijar', 'fijar ES');
  eq(ruleOf('chat_fijar').extract('Unpin the message').accion, 'desfijar', 'unpin EN');
  eq(ruleOf('chat_fijar').extract('置顶这条消息').accion, 'fijar', 'fijar ZH');
  eq(ruleOf('chat_fijar').extract('取消置顶这条消息').accion, 'desfijar', 'desfijar ZH');
  eq(ruleOf('chat_fijar').extract('Fixa esta mensagem').accion, 'fijar', 'fijar PT');
  // chat_reenviar
  eq(ruleOf('chat_reenviar').extract('Reenvía este mensaje a @carlos').destino, '@carlos', 'reenviar ES');
  eq(ruleOf('chat_reenviar').extract('Forward this message to @carlos').destino, '@carlos', 'reenviar EN');
  eq(ruleOf('chat_reenviar').extract('转发这条消息给@carlos').destino, '@carlos', 'reenviar ZH');
  eq(ruleOf('chat_reenviar').extract('Reencaminha esta mensagem para @carlos').destino, '@carlos', 'reenviar PT');

  /* ================= 3. i18n ES/EN/ZH/PT ================= */
  const keys = Object.keys(M.BARO_I18N_6BCHAT);
  ok(keys.length > 60, 'tabla i18n con suficientes claves (' + keys.length + ')');
  let missing = 0;
  keys.forEach(k => { ['es', 'en', 'zh', 'pt'].forEach(l => { if (!M.BARO_I18N_6BCHAT[k][l]) missing++; }); });
  eq(missing, 0, 'ninguna clave sin los 4 idiomas');
  const spot = [
    ['baro.tool.chat_enviar.label', { es: 'Enviar mensaje', en: 'Send message', zh: '发送消息', pt: 'Enviar mensagem' }],
    ['baro.tool.chat.eliminar.confirm_todos', { es: '¿Eliminar este mensaje para todos?', en: 'Delete this message for everyone?', zh: '为所有人删除这条消息？', pt: 'Excluir esta mensagem para todos?' }]
  ];
  spot.forEach(([k, want]) => {
    Object.keys(want).forEach(l => {
      const got = M.BARO_I18N_6BCHAT[k][l];
      eq(got, want[l], 'i18n ' + k + ' [' + l + ']');
    });
  });
  // baro6bT resuelve por idioma vía ctx.t
  ['es', 'en', 'zh', 'pt'].forEach(l => {
    eq(M.helpers.baro6bT(mkCtx(l, ALICE), 'baro.tool.chat_enviar.label'), M.BARO_I18N_6BCHAT['baro.tool.chat_enviar.label'][l], 'baro6bT [' + l + ']');
  });

  /* ================= 4. núcleo puro ================= */
  eq(pure.baro6bDirectRoomId('uid_alice', 'uid_bob'), ['uid_alice', 'uid_bob'].sort().join('__'), 'roomId DM ordenado');
  eq(pure.baro6bDirectRoomId('uid_bob', 'uid_alice'), pure.baro6bDirectRoomId('uid_alice', 'uid_bob'), 'roomId DM simétrico');
  eq(pure.baro6bDirectRoomId('uid_a/b', 'uid_b'), null, 'uid inválido -> null');
  eq(pure.baro6bEvaluateSendGate({ iBlocked: true }).denial, 'i_blocked', 'gate: yo bloqueé');
  eq(pure.baro6bEvaluateSendGate({ theyBlocked: true }).denial, 'they_blocked', 'gate: me bloquearon');
  eq(pure.baro6bEvaluateSendGate({ dmPermission: 'none' }).denial, 'dm_none', 'gate: dm none');
  eq(pure.baro6bEvaluateSendGate({ dmPermission: 'friends', areFriends: false }).denial, 'dm_friends', 'gate: friends sin amistad');
  let g = pure.baro6bEvaluateSendGate({ dmPermission: 'all', areFriends: false });
  ok(g.denial === null && g.asRequest === true, 'gate: all sin amistad -> solicitud');
  g = pure.baro6bEvaluateSendGate({ dmPermission: 'all', areFriends: true });
  ok(g.denial === null && g.asRequest === false, 'gate: all con amistad -> directo');
  eq(pure.baro6bCanForward({ viewOnce: true }).reason, 'viewonce', 'forward: viewOnce prohibido');
  eq(pure.baro6bCanForward({ autoDestroyAt: 1 }).reason, 'temp', 'forward: temporal prohibido');
  eq(pure.baro6bCanForward({ deletedForAll: true }).reason, 'deleted', 'forward: eliminado prohibido');
  eq(pure.baro6bCanForward(null).reason, 'not_found', 'forward: inexistente prohibido');
  eq(pure.baro6bCanForward({ text: 'hola' }).ok, true, 'forward: texto normal ok');
  eq(pure.baro6bEmojiFromText('dale me gusta'), 'me gusta', 'emoji sinónimo ES');
  eq(pure.baro6bEmojiFromText('fire!'), 'fuego', 'emoji sinónimo EN');
  eq(pure.baro6bParseModoEliminar('bórralo solo para mí').length > 0, true, 'parse modo para_mi');
  eq(pure.baro6bParseModoEliminar('elimínalo para todos'), 'para_todos', 'parse modo para_todos');
  eq(pure.baro6bParseAccionFijar('quita el fijado'), 'desfijar', 'parse desfijar');
  eq(pure.baro6bExtractMention('habla con @Juan_1 porfa'), 'Juan_1', 'extract mention');

  /* ================= 5. confirmación obligatoria: enviar ================= */
  seedBase();
  let r = await run('chat_enviar', { destinatario: '@juan', texto: 'Hola Bob' }, 'es');
  eq(confirmCalls.length, 1, 'enviar: pide confirmación');
  eq(writes.length, 0, 'enviar: CERO escrituras antes de confirmar');
  eq(notifCalls.length, 0, 'enviar: cero notificaciones antes de confirmar');
  await confirmCalls[0].onConfirm();
  ok(writes.length > 0, 'enviar: escribe tras confirmar (' + writes.length + ' escrituras)');
  const roomAB = ['uid_alice', 'uid_bob'].sort().join('__');
  const msgKeys = getAt('conversationMessages/' + roomAB) || {};
  const sent = msgKeys[Object.keys(msgKeys)[0]];
  eq(sent && sent.senderId, ALICE, 'enviar: senderId correcto');
  eq(sent && sent.text, 'Hola Bob', 'enviar: texto correcto');
  ok(getAt('conversations/' + roomAB + '/lastMessage') === 'Hola Bob', 'enviar: vista previa actualizada');
  eq(notifCalls.length, 1, 'enviar: notifica al destinatario');
  eq(notifCalls[0].uid, BOB, 'enviar: notificación va a @juan');
  ok(said.some(s => s.indexOf('Mensaje enviado') !== -1), 'enviar: mensaje de éxito');
  ok(said.some(s => s.indexOf('solicitud') !== -1), 'enviar: avisa que es solicitud (no amigos, permiso all)');

  // denegación por dmPermission=none: sin confirmación, sin escrituras
  seedBase();
  setAt('users/' + BOB + '/dmPermission', 'none');
  r = await run('chat_enviar', { destinatario: '@juan', texto: 'Hola' }, 'es');
  eq(confirmCalls.length, 0, 'enviar denegado: no pide confirmación');
  eq(writes.length, 0, 'enviar denegado: cero escrituras');
  ok(r.html.indexOf('permisos de mensaje') !== -1, 'enviar denegado: mensaje de permiso');

  // bloqueo: me bloquearon
  seedBase();
  setAt('blocks/' + BOB + '/' + ALICE, true);
  r = await run('chat_enviar', { destinatario: '@juan', texto: 'Hola' }, 'es');
  eq(writes.length, 0, 'enviar bloqueado: cero escrituras');
  ok(r.html.indexOf('No puedes enviar mensajes') !== -1, 'enviar bloqueado: mensaje de bloqueo');

  // usuario inexistente: nunca inventa
  seedBase();
  r = await run('chat_enviar', { destinatario: '@nadie000', texto: 'Hola' }, 'es');
  eq(writes.length, 0, 'enviar usuario inexistente: cero escrituras');
  ok(r.html.indexOf('nadie000') !== -1, 'enviar usuario inexistente: lo nombra');

  // sin sesión: mensaje de login, sin excepción
  seedBase();
  r = await run('chat_enviar', { destinatario: '@juan', texto: 'Hola' }, 'es', null);
  ok(r.html.indexOf('inicia sesión') !== -1 || r.html.length > 10, 'sin sesión: pide login');

  /* ================= 6. confirmación obligatoria: eliminar ================= */
  // para mí
  seedBase();
  r = await run('chat_eliminar', { roomId: 'room1', msgId: 'm1', modo: 'para_mi' }, 'es');
  eq(confirmCalls.length, 1, 'eliminar para mí: pide confirmación');
  eq(writes.length, 0, 'eliminar para mí: CERO escrituras antes de confirmar');
  await confirmCalls[0].onConfirm();
  eq(getAt('chatDeletedForMe/' + ALICE + '/room1/m1'), true, 'eliminar para mí: marca aplicada');
  eq(getAt('conversationMessages/room1/m1/text'), 'Hola Ana', 'eliminar para mí: no toca el mensaje original');
  // para todos (propio)
  seedBase();
  r = await run('chat_eliminar', { roomId: 'room1', msgId: 'm2', modo: 'para_todos' }, 'es');
  eq(confirmCalls.length, 1, 'eliminar para todos: pide confirmación');
  eq(writes.length, 0, 'eliminar para todos: CERO escrituras antes de confirmar');
  await confirmCalls[0].onConfirm();
  const del = getAt('conversationMessages/room1/m2');
  eq(del.deletedForAll, true, 'eliminar para todos: marca deletedForAll');
  eq(del.text, '', 'eliminar para todos: texto vaciado');
  // para todos ajeno: denegado sin confirmación
  seedBase();
  r = await run('chat_eliminar', { roomId: 'room1', msgId: 'm1', modo: 'para_todos' }, 'es');
  eq(confirmCalls.length, 0, 'eliminar ajeno: no pide confirmación');
  ok(r.html.indexOf('Solo el autor') !== -1, 'eliminar ajeno: mensaje de propiedad');

  /* ================= 7. reacciones (toggle real) ================= */
  seedBase();
  r = await run('chat_reaccionar', { roomId: 'room1', msgId: 'm1', emoji: 'me gusta' }, 'es');
  eq(getAt('msgReactions/room1/m1/' + ALICE), 'me gusta', 'reaccionar: guarda reacción');
  r = await run('chat_reaccionar', { roomId: 'room1', msgId: 'm1', emoji: 'me gusta' }, 'es');
  eq(getAt('msgReactions/room1/m1/' + ALICE), undefined, 'reaccionar: la misma quita (toggle)');
  r = await run('chat_reaccionar', { roomId: 'room1', msgId: 'm1', emoji: 'fuego' }, 'es');
  eq(getAt('msgReactions/room1/m1/' + ALICE), 'fuego', 'reaccionar: otra distinta la pone');
  r = await run('chat_reaccionar', { roomId: 'room1', msgId: 'm1', emoji: 'inventado' }, 'es');
  ok(r.html.indexOf('no existe') !== -1, 'reaccionar: emoji inválido rechazado');
  r = await run('chat_reaccionar', { roomId: 'room1', msgId: 'm9', emoji: 'me gusta' }, 'es');
  ok(r.html.indexOf('encontr') !== -1, 'reaccionar: mensaje inexistente rechazado');

  /* ================= 8. editar (propiedad + sync pin) ================= */
  seedBase();
  r = await run('chat_editar', { roomId: 'room1', msgId: 'm2', texto: 'Editado' }, 'es');
  eq(getAt('conversationMessages/room1/m2/text'), 'Editado', 'editar: actualiza texto');
  ok(getAt('conversationMessages/room1/m2/editedAt') > 0, 'editar: marca editedAt');
  r = await run('chat_editar', { roomId: 'room1', msgId: 'm1', texto: 'hack' }, 'es');
  ok(r.html.indexOf('tus propios mensajes') !== -1, 'editar ajeno: denegado');
  eq(getAt('conversationMessages/room1/m1/text'), 'Hola Ana', 'editar ajeno: intacto');
  setAt('conversationPinned/room1', { msgId: 'm2', text: 'Mi mensaje' });
  r = await run('chat_editar', { roomId: 'room1', msgId: 'm2', texto: 'Nuevo' }, 'es');
  eq(getAt('conversationPinned/room1/text'), 'Nuevo', 'editar: sincroniza texto del pin (C56-C1)');

  /* ================= 9. fijar (toggle real) ================= */
  seedBase();
  r = await run('chat_fijar', { roomId: 'room1', msgId: 'm1', accion: 'fijar' }, 'es');
  eq(getAt('conversationPinned/room1/msgId'), 'm1', 'fijar: guarda pin');
  r = await run('chat_fijar', { roomId: 'room1', msgId: 'm1', accion: 'toggle' }, 'es');
  eq(getAt('conversationPinned/room1'), undefined, 'fijar: toggle quita el mismo');
  r = await run('chat_fijar', { roomId: 'room1', msgId: 'm9', accion: 'fijar' }, 'es');
  ok(r.html.indexOf('encontr') !== -1, 'fijar: mensaje inexistente rechazado');

  /* ================= 10. reenviar (guardas + confirmación) ================= */
  seedBase();
  r = await run('chat_reenviar', { roomId: 'room1', msgId: 'm3', destino: '@carlos' }, 'es');
  ok(r.html.indexOf('una vez') !== -1, 'reenviar: viewOnce prohibido');
  eq(confirmCalls.length, 0, 'reenviar viewOnce: sin confirmación');
  r = await run('chat_reenviar', { roomId: 'room1', msgId: 'm1', destino: '@carlos' }, 'es');
  eq(confirmCalls.length, 1, 'reenviar: pide confirmación');
  eq(writes.length, 0, 'reenviar: CERO escrituras antes de confirmar');
  await confirmCalls[0].onConfirm();
  const roomAC = [ALICE, CARL].sort().join('__');
  const fwd = (getAt('conversationMessages/' + roomAC) || {});
  const fk = Object.keys(fwd)[0];
  eq(fwd[fk] && fwd[fk].forwarded, true, 'reenviar: marca forwarded');
  eq(fwd[fk] && fwd[fk].text, 'Hola Ana', 'reenviar: copia el texto');
  eq(fwd[fk] && fwd[fk].senderId, ALICE, 'reenviar: remitente es quien reenvía');
  eq(notifCalls.length, 1, 'reenviar: notifica al destino');

  /* ================= 11. conteos reales en stats ================= */
  seedBase();
  r = await run('chat_reaccionar', { roomId: 'room1', msgId: 'm1', emoji: 'me gusta' }, 'es');
  ok(r.stats && r.stats.count === 1, 'reaccionar devuelve conteo real');
  r = await run('chat_fijar', { roomId: 'room1', msgId: 'm1', accion: 'fijar' }, 'es');
  ok(r.stats && r.stats.results === 1, 'fijar devuelve conteo real');

  console.log('\n' + pass + ' OK, ' + fail + ' FALLOS');
  if (failures.length) {
    console.log('FALLOS:');
    failures.forEach(f => console.log(' - ' + f));
    process.exit(1);
  }
})().catch(e => { console.error('ERROR FATAL:', e); process.exit(2); });
