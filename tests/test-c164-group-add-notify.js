/* ================================================================
 * C164 — Grupos: AVISO AL MIEMBRO AGREGADO ("te agregó al grupo").
 *
 * HALLAZGO (hueco real con ancla triple, verificado contra el código):
 *  - SE CALCULA: createGroupChat hace fan-out
 *    `userConversations/<uid>/<groupId>.set({isGroup:true, ...,
 *    lastMessage:'Grupo creado'})` por cada miembro (~34513); y
 *    addMemberToGroup escribe `userConversations/<uid>/<groupId>` con
 *    lastMessage 'Te han agregado al grupo' (~39423).
 *  - SE PINTA: loadChatConversations (35213) lee userConversations/<uid>
 *    y renderChatConversations pinta la entrada del grupo en el inbox.
 *  - SILENCIO: ningún call site avisa al agregado. El miembro no recibe
 *    push ni unread: solo descubre el grupo si abre el inbox. (En un DM,
 *    el primer mensaje sí genera aviso 'message'; en grupos, nada.)
 *
 * CAMBIO (index.html, 2 hunks mínimos):
 *  - createGroupChat: tras el fan-out, bloque best-effort fire-and-forget
 *    que avisa a cada miembro != creador.
 *  - addMemberToGroup: tras el push del mensaje de sistema, aviso al uid
 *    agregado (con guarda uid !== user.uid).
 *  - Tipo 'message' + isGroupChat:true → hereda el toggle 'groupMessages'
 *    del destinatario (notifTypeToPrefKey). Sin tipos nuevos.
 *  - Exactamente-una-vez: la creación y el agregado son acciones únicas;
 *    el aviso vive en el mismo flujo (sin listeners ni reintentos).
 *  - actionId = id del grupo, consistente con el aviso de mensaje en
 *    grupo existente (~37477).
 *
 * Ejecutar con: node tests/test-c164-group-add-notify.js
 * (DREX_HTML puede apuntar al index.html a evaluar.)
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function findHtml() {
  const cands = [
    process.env.DREX_HTML || null,
    path.join(__dirname, '..', 'index.html'),
    path.join(__dirname, '..', '..', 'beabo', 'index.html'),
  ];
  for (const c of cands) { if (c && fs.existsSync(c)) return c; }
  throw new Error('no se encontró index.html (usa DREX_HTML)');
}
const html = fs.readFileSync(findHtml(), 'utf8');

let failures = 0;
const pending = [];
function tcase(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(v => {
        console.log((v ? 'ok - ' : 'NOT OK - ') + name);
        if (!v) failures++;
      }).catch(e => {
        console.log('NOT OK - ' + name + ' [excepción: ' + (e && e.message) + ']');
        failures++;
      }));
    } else {
      console.log((r ? 'ok - ' : 'NOT OK - ') + name);
      if (!r) failures++;
    }
  } catch (e) {
    console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
    failures++;
  }
}
function extractFn(source, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(source);
  if (!m) throw new Error('no se encontró ' + name);
  let i = source.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(m.index, j + 1); }
  }
  throw new Error('llaves sin balance en ' + name);
}

// ---------- Parte A: estáticos (FALLAN sin el parche) ----------
tcase('A1 createGroupChat avisa a los agregados (message + isGroupChat, sin auto-aviso)', () => {
  const fn = extractFn(html, 'createGroupChat');
  return fn.indexOf('te agregó al grupo') !== -1
    && fn.indexOf("'message'") !== -1
    && fn.indexOf('isGroupChat: true') !== -1
    && fn.indexOf('.filter(mid => mid && mid !== user.uid)') !== -1
    && fn.indexOf('actionId: finalGroupId') !== -1;
});
tcase('A2 addMemberToGroup avisa al uid agregado (message + isGroupChat, sin auto-aviso)', () => {
  const fn = extractFn(html, 'addMemberToGroup');
  return fn.indexOf('te agregó al grupo') !== -1
    && fn.indexOf("'message'") !== -1
    && fn.indexOf('isGroupChat: true') !== -1
    && fn.indexOf('uid !== user.uid') !== -1
    && fn.indexOf('actionId: currentChatRoomId') !== -1;
});
tcase('A3 sin tipos nuevos: ambos avisos usan el tipo existente message', () => {
  const f1 = extractFn(html, 'createGroupChat');
  const f2 = extractFn(html, 'addMemberToGroup');
  const near1 = f1.slice(f1.indexOf('te agregó al grupo') - 200, f1.indexOf('te agregó al grupo') + 200);
  const near2 = f2.slice(f2.indexOf('te agregó al grupo') - 200, f2.indexOf('te agregó al grupo') + 200);
  return near1.indexOf("'message'") !== -1 && near2.indexOf("'message'") !== -1;
});
tcase('A4 best-effort: el aviso no bloquea (IIFE async fire-and-forget, sin await directo)', () => {
  const f1 = extractFn(html, 'createGroupChat');
  const f2 = extractFn(html, 'addMemberToGroup');
  const ok1 = f1.indexOf('(async () => {') !== -1 && f1.indexOf('await addNotification(mid') === -1;
  const ok2 = f2.indexOf('(async () => {') !== -1;
  return ok1 && ok2;
});
tcase('A5 el aviso corre UNA vez por flujo (no vive en listener .on ni en bucle de mensajes)', () => {
  const f1 = extractFn(html, 'createGroupChat');
  const f2 = extractFn(html, 'addMemberToGroup');
  const c1 = (f1.match(/te agregó al grupo/g) || []).length;
  const c2 = (f2.match(/te agregó al grupo/g) || []).length;
  return c1 === 1 && c2 === 1 && f1.indexOf(".on('value'") === -1 && f2.indexOf(".on('value'") === -1;
});

// ---------- Parte B: toggle heredado (código real en sandbox) ----------
tcase('B0 notifTypeToPrefKey(message, {isGroupChat:true}) === groupMessages (código real)', () => {
  const fn = extractFn(html, 'notifTypeToPrefKey');
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(fn, sb);
  const r1 = vm.runInContext("notifTypeToPrefKey('message', {isGroupChat: true})", sb);
  const r2 = vm.runInContext("notifTypeToPrefKey('message', {})", sb);
  return r1 === 'groupMessages' && r2 === 'messages';
});

// ---------- Parte C: conductual con mocks ----------
function mockDb(notifs, opts) {
  opts = opts || {};
  function ref(p) {
    return {
      push: function () {
        if (String(p) === 'groupChats') return { key: 'g1', set: function () { return Promise.resolve(); } };
        return { key: 'm1', _writePromise: Promise.resolve() };
      },
      set: function () { return Promise.resolve(); },
      update: function () { return Promise.resolve(); },
      once: function () {
        if (String(p).indexOf('users/') === 0) {
          return Promise.resolve({ val: function () { return { username: opts.creatorName || 'ana' }; } });
        }
        if (String(p).indexOf('groupChats/') === 0) {
          return Promise.resolve({ val: function () { return { name: opts.groupName || 'Mi Grupo', members: {} }; } });
        }
        return Promise.resolve({ val: function () { return null; } });
      }
    };
  }
  return { database: function () { return { ref: ref }; }, auth: function () { return { currentUser: { uid: 'u1', displayName: 'Ana' } }; } };
}
function runBox(fnName, globals) {
  const notifs = [];
  const sb = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Promise: Promise,
    DrexCloud: mockDb(notifs, globals.dbOpts || {}),
    document: { getElementById: function () { return null; } },
    showMiniToast: function () {},
    appT: function (s) { return s; },
    closeCreateGroupChatView: function () {},
    openChatInboxView: function () {},
    closeAddMemberToGroup: function () {},
    openGroupInfoPanel: function () {},
    processImageFile: async function () { return ''; },
    verifyGroupAdminFresh: async function () { return true; },
    addNotification: function (uid, msg, type, meta) {
      notifs.push({ uid: uid, msg: msg, type: type, meta: meta });
      return Promise.resolve();
    }
  };
  Object.assign(sb, globals.vars || {});
  vm.createContext(sb);
  vm.runInContext(extractFn(html, fnName), sb);
  return { sb: sb, notifs: notifs };
}
function flush(ms) { return new Promise(function (res) { setTimeout(res, ms || 60); }); }

tcase('C1 crear grupo con 2 miembros -> 2 avisos (uno por agregado), 0 al creador', () => {
  const box = runBox('createGroupChat', {
    vars: {
      groupChatSelectedUsers: [{ uid: 'u2' }, { uid: 'u3' }],
      groupChatSelectedPhotoFile: null,
    },
    dbOpts: { creatorName: 'ana', groupName: 'Mi Grupo' }
  });
  // document mock específico: input de nombre + botón
  box.sb.document = {
    getElementById: function (id) {
      if (id === 'group-chat-name-input') return { value: 'Mi Grupo' };
      if (id === 'create-group-chat-btn') return { disabled: false };
      return null;
    }
  };
  vm.runInContext('createGroupChat()', box.sb);
  return flush().then(function () {
    const ns = box.notifs;
    const toU2 = ns.filter(n => n.uid === 'u2');
    const toU3 = ns.filter(n => n.uid === 'u3');
    const toU1 = ns.filter(n => n.uid === 'u1');
    return ns.length === 2 && toU2.length === 1 && toU3.length === 1 && toU1.length === 0
      && toU2[0].type === 'message' && toU2[0].meta && toU2[0].meta.isGroupChat === true
      && toU2[0].meta.actionId === 'g1'
      && toU2[0].msg === 'ana te agregó al grupo "Mi Grupo"';
  });
});
tcase('C2 crear grupo solo con el creador -> 0 avisos', () => {
  const box = runBox('createGroupChat', { vars: { groupChatSelectedUsers: [], groupChatSelectedPhotoFile: null } });
  box.sb.document = {
    getElementById: function (id) {
      if (id === 'group-chat-name-input') return { value: 'Solo' };
      if (id === 'create-group-chat-btn') return { disabled: false };
      return null;
    }
  };
  // groupChatSelectedUsers.length < 1 muestra toast y retorna; forzamos 1 miembro == creador
  box.sb.groupChatSelectedUsers = [{ uid: 'u1' }];
  vm.runInContext('createGroupChat()', box.sb);
  return flush().then(function () { return box.notifs.length === 0; });
});
tcase('C3 agregar miembro a grupo existente -> 1 aviso al agregado, tipo/toggle correctos', () => {
  const box = runBox('addMemberToGroup', {
    vars: { currentChatRoomId: 'g9', currentGroupMembers: { u1: true } },
    dbOpts: { creatorName: 'ana', groupName: 'Club' }
  });
  vm.runInContext("addMemberToGroup('u7', 'Luis', 'img', null)", box.sb);
  return flush().then(function () {
    const ns = box.notifs;
    return ns.length === 1 && ns[0].uid === 'u7' && ns[0].type === 'message'
      && ns[0].meta && ns[0].meta.isGroupChat === true && ns[0].meta.actionId === 'g9'
      && ns[0].msg === 'ana te agregó al grupo "Club"';
  });
});

Promise.all(pending).then(function () {
  setTimeout(function () {
    console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
    process.exit(failures === 0 ? 0 : 1);
  }, 50);
});
