/* ================================================================
 * C165 — Grupos: AVISO DE CAMBIO DE ROL DE ADMINISTRADOR.
 *
 * HALLAZGO (hueco real con ancla triple, verificado contra el código):
 *  - SE CALCULA: promoteGroupMember escribe
 *    `groupChats/<id>/admins/<uid> = true` (~39232); demoteGroupMember lo
 *    borra (~39252). Acción deliberada 1:1 del creador hacia un miembro.
 *  - SE PINTA: mensaje de sistema "X ahora es administrador" /
 *    "X ya no es administrador" en el chat (~39234, ~39254) + insignia de
 *    admin y controles de moderación en la info del grupo para el miembro.
 *  - SILENCIO: ningún call site avisa al afectado. El promovido no sabe
 *    que puede moderar; el degradado descubre que perdió el rol cuando sus
 *    acciones fallan. (Cero señal push/unread.)
 *  Límites respetados: la transferencia automática al salir el creador
 *  (leaveGroupChat ~39313) sigue silenciosa — es efecto colateral, no
 *  acción deliberada (descarte C164, no re-litigado).
 *
 * CAMBIO (index.html, 3 hunks mínimos):
 *  - groupRoleChangeText(actor, group, kind): núcleo puro (ES fijo).
 *  - notifyGroupRoleChange(uid, groupId, kind): envoltorio best-effort;
 *    sin auto-aviso; devuelve false si no hay nada que avisar.
 *  - Hooks en promoteGroupMember / demoteGroupMember tras confirmar la
 *    escritura del rol (fire-and-forget, con guarda typeof — patrón C153).
 *  - Tipo 'message' + isGroupChat:true → hereda el toggle 'groupMessages'
 *    del destinatario (notifTypeToPrefKey). Sin tipos nuevos.
 *  - Exactamente-una-vez por construcción: el evento es unitario (un
 *    set/remove por acción deliberada); la UI oculta el botón si el
 *    miembro ya es / ya no es admin.
 *
 * Ejecutar con: node tests/test-c165-group-role-notify.js
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
tcase('A1 promoteGroupMember avisa al promovido (helper + kind promoted)', () => {
  const fn = extractFn(html, 'promoteGroupMember');
  return fn.indexOf('notifyGroupRoleChange') !== -1
    && fn.indexOf("'promoted'") !== -1
    && fn.indexOf('target.uid') !== -1;
});
tcase('A2 demoteGroupMember avisa al degradado (helper + kind demoted)', () => {
  const fn = extractFn(html, 'demoteGroupMember');
  return fn.indexOf('notifyGroupRoleChange') !== -1
    && fn.indexOf("'demoted'") !== -1
    && fn.indexOf('target.uid') !== -1;
});
tcase('A3 el hook corre tras confirmar la escritura del rol (no antes)', () => {
  const f1 = extractFn(html, 'promoteGroupMember');
  const f2 = extractFn(html, 'demoteGroupMember');
  const ok1 = f1.indexOf('/admins/') !== -1
    && f1.indexOf('/admins/') < f1.indexOf('notifyGroupRoleChange');
  const ok2 = f2.indexOf('/admins/') !== -1
    && f2.indexOf('/admins/') < f2.indexOf('notifyGroupRoleChange');
  return ok1 && ok2;
});
tcase('A4 best-effort con guarda typeof (patrón C153): no bloquea el flujo', () => {
  const f1 = extractFn(html, 'promoteGroupMember');
  const f2 = extractFn(html, 'demoteGroupMember');
  const g = "typeof notifyGroupRoleChange === 'function'";
  return f1.indexOf(g) !== -1 && f2.indexOf(g) !== -1
    && f1.indexOf('await notifyGroupRoleChange') === -1
    && f2.indexOf('await notifyGroupRoleChange') === -1;
});
tcase('A5 tipo existente message + isGroupChat (sin tipos nuevos)', () => {
  const fn = extractFn(html, 'notifyGroupRoleChange');
  const near = fn.slice(fn.indexOf('addNotification'));
  return near.indexOf("'message'") !== -1 && near.indexOf('isGroupChat: true') !== -1;
});
tcase('A6 sin auto-aviso: el creador nunca se avisa a sí mismo', () => {
  const fn = extractFn(html, 'notifyGroupRoleChange');
  return fn.indexOf('targetUid === me.uid') !== -1;
});
tcase('A7 el payload del rol no cambia (lección C149): solo set/remove de admins/<uid>', () => {
  const f1 = extractFn(html, 'promoteGroupMember');
  const f2 = extractFn(html, 'demoteGroupMember');
  return f1.indexOf("'/admins/' + target.uid).set(true)") !== -1
    && f2.indexOf("'/admins/' + target.uid).remove()") !== -1;
});

// ---------- Parte B: núcleo puro + toggle (código real en sandbox) ----------
function runPure(fnName, callExpr) {
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(extractFn(html, fnName), sb);
  return vm.runInContext(callExpr, sb);
}
tcase('B1 groupRoleChangeText promoted (código real)', () => {
  const r = runPure('groupRoleChangeText', 'groupRoleChangeText("Ana", "Club", "promoted")');
  return r === 'Ana te hizo administrador del grupo "Club"';
});
tcase('B2 groupRoleChangeText demoted (código real)', () => {
  const r = runPure('groupRoleChangeText', 'groupRoleChangeText("Ana", "Club", "demoted")');
  return r === 'Ana te quitó el rol de administrador del grupo "Club"';
});
tcase('B3 groupRoleChangeText rechaza kind inválido', () => {
  const r = runPure('groupRoleChangeText', 'groupRoleChangeText("Ana", "Club", "owner")');
  return r === null;
});
tcase('B4 notifTypeToPrefKey(message, {isGroupChat:true}) === groupMessages (código real)', () => {
  const fn = extractFn(html, 'notifTypeToPrefKey');
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(fn, sb);
  return vm.runInContext("notifTypeToPrefKey('message', {isGroupChat: true})", sb) === 'groupMessages';
});

// ---------- Parte C: conductual con mocks ----------
function runBox(fnName, vars, dbOpts) {
  dbOpts = dbOpts || {};
  const notifs = [];
  const sb = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Promise: Promise,
    DrexCloud: {
      database: function () {
        return {
          ref: function (p) {
            return {
              set: function () { return Promise.resolve(); },
              remove: function () { return Promise.resolve(); },
              update: function () { return Promise.resolve(); },
              push: function () { return { key: 'm1', _writePromise: Promise.resolve() }; },
              once: function () {
                if (String(p).indexOf('users/u1') === 0) {
                  return Promise.resolve({ val: function () { return { username: dbOpts.actorName || 'ana' }; } });
                }
                if (String(p).indexOf('groupChats/g9') === 0) {
                  return Promise.resolve({ val: function () { return { name: dbOpts.groupName || 'Club' }; } });
                }
                return Promise.resolve({ val: function () { return null; } });
              }
            };
          }
        };
      },
      auth: function () { return { currentUser: { uid: 'u1', displayName: 'Ana' } }; }
    },
    addNotification: function (uid, msg, type, meta) {
      notifs.push({ uid: uid, msg: msg, type: type, meta: meta });
      return Promise.resolve();
    }
  };
  Object.assign(sb, vars || {});
  vm.createContext(sb);
  // notifyGroupRoleChange llama a groupRoleChangeText (misma scope top-level
  // en la página real); en el sandbox hay que inyectar ambas.
  try { vm.runInContext(extractFn(html, 'groupRoleChangeText'), sb); } catch (_) {}
  vm.runInContext(extractFn(html, fnName), sb);
  return { sb: sb, notifs: notifs };
}
function flush(ms) { return new Promise(function (res) { setTimeout(res, ms || 60); }); }

tcase('C1 promote -> 1 aviso al promovido, tipo/toggle/meta/texto exactos', () => {
  const box = runBox('notifyGroupRoleChange', {});
  return vm.runInContext("notifyGroupRoleChange('u7', 'g9', 'promoted')", box.sb).then(function (ok) {
    const ns = box.notifs;
    return ok === true && ns.length === 1 && ns[0].uid === 'u7' && ns[0].type === 'message'
      && ns[0].meta && ns[0].meta.isGroupChat === true
      && ns[0].meta.actionType === 'chat' && ns[0].meta.actionId === 'g9'
      && ns[0].msg === 'ana te hizo administrador del grupo "Club"';
  });
});
tcase('C2 demote -> 1 aviso al degradado, texto exacto', () => {
  const box = runBox('notifyGroupRoleChange', {});
  return vm.runInContext("notifyGroupRoleChange('u7', 'g9', 'demoted')", box.sb).then(function (ok) {
    const ns = box.notifs;
    return ok === true && ns.length === 1 && ns[0].uid === 'u7'
      && ns[0].msg === 'ana te quitó el rol de administrador del grupo "Club"';
  });
});
tcase('C3 sin auto-aviso: target == yo -> false, 0 avisos', () => {
  const box = runBox('notifyGroupRoleChange', {});
  return vm.runInContext("notifyGroupRoleChange('u1', 'g9', 'promoted')", box.sb).then(function (ok) {
    return ok === false && box.notifs.length === 0;
  });
});
tcase('C4 kind inválido -> false, 0 avisos', () => {
  const box = runBox('notifyGroupRoleChange', {});
  return vm.runInContext("notifyGroupRoleChange('u7', 'g9', 'owner')", box.sb).then(function (ok) {
    return ok === false && box.notifs.length === 0;
  });
});
tcase('C5 sin addNotification disponible -> false (degradación segura)', () => {
  const box = runBox('notifyGroupRoleChange', {});
  delete box.sb.addNotification;
  return vm.runInContext("notifyGroupRoleChange('u7', 'g9', 'promoted')", box.sb).then(function (ok) {
    return ok === false && box.notifs.length === 0;
  });
});

// ---------- Parte D: no-regresión ----------
tcase('D1 leaveGroupChat NO avisa (transferencia automática sigue silenciosa, descarte C164)', () => {
  const fn = extractFn(html, 'leaveGroupChat');
  return fn.indexOf('notifyGroupRoleChange') === -1 && fn.indexOf('addNotification') === -1;
});
tcase('D2 kickGroupMember NO avisa a la víctima (superficie eliminada: sin pata de pintura, precedente C164)', () => {
  const fn = extractFn(html, 'kickGroupMember');
  return fn.indexOf('notifyGroupRoleChange') === -1;
});

Promise.all(pending).then(function () {
  setTimeout(function () {
    console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
    process.exit(failures === 0 ? 0 : 1);
  }, 50);
});
