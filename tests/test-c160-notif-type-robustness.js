/* ================================================================
 * C160 — Robustez de tipos en el render de notificaciones (base 8dec90c).
 *
 * HALLAZGO (auditoría C160, familia notificaciones/push — observación O1):
 * `notifications/<uid>` es escribible por terceros vía RTDB directa, y
 * `mergeNotificationsSnapshot` copia el objeto crudo al caché local sin
 * coaccionar tipos. Dos sumideros asumían string y lanzaban TypeError:
 *  1. renderNotificationsList: `notification.actorName.trim()` — con
 *     actorName: 123 (truthy no-string) el forEach abortaba ANTES del
 *     appendChild: la lista quedaba VACÍA de forma persistente (el
 *     TypeError lo tragaba el catch (_) {} de los llamadores). DoS del
 *     panel, silencioso.
 *  2. paintNotifName: `msg.indexOf(...)` con message: 12345 — mismo
 *     efecto (el mensaje también lo escribe el atacante).
 * FIX (2 líneas, estilo de la casa — la normalización legacy de repost
 * ya usaba `typeof _notifMsg === 'string'` en esta misma función):
 *  1. `} else if (typeof notification.actorName === 'string' && notification.actorName) {`
 *  2. `let msg = (typeof message === 'string' && message) ? message : 'Notificación';`
 * Sin el parche este test FALLA (TypeError); con el parche, ALL PASS.
 *
 * Ejecutar: node tests/test-c160-notif-type-robustness.js
 * Falla-en-base: DREX_HTML=/ruta/a/index.base.html node tests/test-c160-notif-type-robustness.js
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function resolveHtml() {
  if (process.env.DREX_HTML && fs.existsSync(process.env.DREX_HTML)) return process.env.DREX_HTML;
  const cands = [
    path.join(__dirname, '..', 'index.html'),
    path.join(__dirname, '..', 'beabo', 'index.html')
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('no se encontró index.html');
}
const html = fs.readFileSync(resolveHtml(), 'utf8');

let failures = 0;
function tcase(name, fn) {
  try {
    const ok = fn();
    console.log((ok ? 'ok - ' : 'NOT OK - ') + name);
    if (!ok) failures++;
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

/* ---------- Parte A: el fix está aplicado (estático) ---------- */
tcase('A1 avatar: rama solo para actorName string no vacío', () => {
  const b = extractFn(html, 'renderNotificationsList');
  return b.indexOf("typeof notification.actorName === 'string' && notification.actorName") !== -1;
});
tcase('A2 paintNotifName: message se coacciona a string con fallback', () => {
  const b = extractFn(html, 'paintNotifName');
  return b.indexOf("typeof message === 'string'") !== -1;
});

/* ---------- Parte B: conductual — la lista nunca revienta ---------- */
function makeBox(items) {
  const sb = {};
  vm.createContext(sb);
  const fns = ['escapeHTML', 'escapeHtml', 'escapeInlineSingleQuote', 'resolveNotifActorUid',
               'formatRelativeTime', 'paintNotifName', 'renderNotificationsList'];
  fns.forEach(n => vm.runInContext(extractFn(html, n), sb));
  vm.runInContext('function getVerificationIconByAuthor(){ return ""; }', sb);
  vm.runInContext('function appT(s){ return s; }', sb);
  vm.runInContext('var __items = ' + JSON.stringify(items) + ';', sb);
  vm.runInContext('function getLocalNotifications(uid){ return __items; }', sb);
  vm.runInContext(`
    var __appended = 0, __thrown = null;
    function __fakeEl() {
      return {
        _html: '', _text: '',
        set innerHTML(v) { this._html = String(v); },
        get innerHTML() { return this._html; },
        set textContent(v) { this._text = String(v); },
        get textContent() { return this._text; },
        className: '',
        querySelector: function () { return __fakeEl(); },
        addEventListener: function () {},
        appendChild: function () {},
        isConnected: true
      };
    }
    var document = {
      getElementById: function () {
        var el = __fakeEl();
        el.appendChild = function () { __appended++; };
        return el;
      },
      createElement: function () { return __fakeEl(); },
      createDocumentFragment: function () { return { appendChild: function () {} }; }
    };
    try {
      renderNotificationsList('victim1');
    } catch (e) { __thrown = String(e && e.message || e); }
  `, sb);
  return {
    appended: vm.runInContext('__appended', sb),
    thrown: vm.runInContext('__thrown', sb)
  };
}
function rendersFine(items) {
  const r = makeBox(items);
  return r.thrown === null && r.appended > 0;
}
function note(over) {
  return Object.assign({
    notificationId: 'n1',
    type: 'follow',
    actorName: 'María',
    message: 'María te comenzó a seguir',
    timestamp: Date.now(),
    read: false
  }, over);
}

tcase('B1 actorName numérico (123) no revienta la lista', () => {
  return rendersFine([note({ actorName: 123 })]);
});
tcase('B2 message numérico (12345) no revienta la lista', () => {
  return rendersFine([note({ message: 12345 })]);
});
tcase('B3 actorName objeto ({}) no revienta la lista', () => {
  return rendersFine([note({ actorName: { x: 1 } })]);
});
tcase('B4 actorName booleano (true) no revienta la lista', () => {
  return rendersFine([note({ actorName: true })]);
});
tcase('B5 envenenada + legítima: la legítima sigue pintándose', () => {
  return rendersFine([note({ actorName: 123 }), note({ notificationId: 'n2' })]);
});
tcase('B6 no-regresión: notificación legítima se pinta', () => {
  return rendersFine([note({})]);
});
tcase('B7 no-regresión: actorName vacío usa la rama del icono', () => {
  return rendersFine([note({ actorName: '' })]);
});
tcase('B8 no-regresión: message vacío usa el fallback', () => {
  return rendersFine([note({ message: '' })]);
});

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
