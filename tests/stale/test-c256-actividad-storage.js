'use strict';
/* C256 — Actividad "avisa pero no se ve": causa raíz reproducida con la app
 * real en jsdom (~/workspace/c256-tools/repro-actividad-dom.js, MODE=quota):
 * la lista de Actividad se pintaba SOLO de localStorage, y si el guardado
 * local fallaba (cuota/bloqueo, p. ej. iPhone), saveLocalNotifications lo
 * tragaba en silencio → Actividad vacía para siempre mientras el badge y
 * el sonido sí anunciaban cada llegada. Además, las filas escritas sin la
 * hoja notificationId (clientes viejos) se descartaban en el merge.
 *
 * Fix verificado aquí sobre las funciones REALES de index.html:
 *  1. mergeNotificationsSnapshot devuelve la lista fusionada y rescata
 *     filas sin notificationId usando su clave como identidad.
 *  2. renderNotificationsList(userId, itemsOverride) pinta de la fusión
 *     en memoria cuando se le pasa; sin override lee localStorage igual.
 *  3. saveLocalNotifications reintenta aligerado (sin actorImage, tope 50)
 *     si el guardado completo falla.
 * Ejecutar: node tests/test-c256-actividad-storage.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extractFn(name) {
  const m = html.match(new RegExp('function ' + name + '\\b[\\s\\S]*?\\n  \\}', 'm'));
  if (!m) throw new Error('no encontrada: ' + name);
  return m[0];
}

// ---------- DOM mínimo ----------
class El {
  constructor(tag) {
    this.tagName = tag || 'div';
    this.children = [];
    this._html = '';
    this._text = '';
    this.className = '';
    this.style = {};
    this.dataset = {};
    this._q = {};
    this.classList = {
      _s: new Set(),
      add: (...c) => c.forEach(x => this.classList._s.add(x)),
      remove: (...c) => c.forEach(x => this.classList._s.delete(x)),
      toggle: (c, f) => { if (f) this.classList._s.add(c); else this.classList._s.delete(c); },
      contains: (c) => this.classList._s.has(c)
    };
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  appendChild(c) { this.children.push(c); return c; }
  querySelector(sel) { return this._q[sel] || (this._q[sel] = new El('span')); }
  querySelectorAll() { return []; }
  setAttribute() {}
  getAttribute() { return null; }
  addEventListener() {}
}

// ---------- localStorage configurable ----------
// mode: 'ok' | 'size' (falla si payload > LIMIT) | 'dead' (siempre falla)
function makeLocalStorage(mode, LIMIT) {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      const s = String(v);
      if (mode === 'dead' || (mode === 'size' && s.length > LIMIT)) throw new Error('QuotaExceededError');
      store.set(k, s);
    },
    removeItem: (k) => store.delete(k),
    _store: store
  };
}

function makeSandbox(localStorage) {
  const listEl = new El('div');
  const sandbox = {
    console, Date, Math, JSON, Map, Set, Array, Object, Number, String, Boolean, Promise, RegExp, Error,
    localStorage,
    document: {
      getElementById: (id) => (id === 'notifications-list' ? listEl : null),
      createElement: (t) => new El(t),
      createDocumentFragment: () => new El('#frag')
    },
    appT: (s) => s,
    formatRelativeTime: () => 'ahora',
    escapeHtml: (s) => String(s == null ? '' : s),
    getVerificationIconByAuthor: () => '',
    escapeInlineSingleQuote: (s) => String(s == null ? '' : s).replace(/'/g, "\\'"),
    hydrateNotifActor: () => {},
    fireDrexSystemNotification: () => {},
    isChatNotificationMuted: () => false,
    NOTIF_BADGE_LIMIT: 100,
    __listEl: listEl
  };
  vm.createContext(sandbox);
  const code = [
    extractFn('getLocalNotifications'),
    extractFn('saveLocalNotifications'),
    extractFn('mergeNotificationsSnapshot'),
    extractFn('resolveNotifActorUid'),
    extractFn('paintNotifName'),
    extractFn('renderNotificationsList')
  ].join('\n');
  vm.runInContext(code, sandbox);
  return sandbox;
}

function snapOf(rows) {
  return { exists: () => rows.length > 0, forEach: (cb) => rows.forEach(r => cb({ key: r._key, val: () => r })) };
}
function paintedRows(sandbox) {
  const listEl = sandbox.__listEl;
  const frag = listEl.children[listEl.children.length - 1];
  if (!frag) return [];
  return frag.children.filter(c => String(c._html || '').includes('notif-msg') || (c._q && c._q['.notif-msg']));
}

const UID = 'userTest1';

async function main() {
  const bigImg = 'data:image/jpeg;base64,' + 'A'.repeat(4000);

  console.log('== S1: guardado que falla por TAMAÑO (cuota realista) ==');
  let sb = makeSandbox(makeLocalStorage('size', 3000));
  const hist = { _key: 'k-old', message: 'vieja con foto', timestamp: Date.now() - 7200000, read: true, type: 'like', notificationId: 'k-old', actorName: 'Bob', actorImage: bigImg };
  const fresh = { _key: 'k-new', message: 'Ana le dio me gusta a tu publicación', timestamp: Date.now(), read: false, type: 'like', notificationId: 'k-new', actorId: 'ana1', actorName: 'Ana' };
  const merged1 = sb.mergeNotificationsSnapshot(UID, snapOf([hist, fresh]), null);
  ok(Array.isArray(merged1) && merged1.length === 2, 'S1: la fusión devuelve las 2 notificaciones');
  const persisted1 = sb.getLocalNotifications(UID);
  ok(persisted1.some(n => n.notificationId === 'k-new'), 'S1: el reintento aligerado SÍ persistió la nueva');
  ok(persisted1.every(n => !n.actorImage), 'S1: la copia persistida va sin fotos de actor');
  sb.renderNotificationsList(UID, merged1);
  let rows = paintedRows(sb);
  ok(rows.length === 2, 'S1: se pintan 2 filas', rows.length + '');
  ok(rows.some(r => (r._q['.notif-msg'] || {})._text.includes('me gusta')), 'S1: la fila nueva muestra su mensaje');

  console.log('== S2: almacenamiento MUERTO (toda escritura falla) — el bug reportado ==');
  sb = makeSandbox(makeLocalStorage('dead', 0));
  const merged2 = sb.mergeNotificationsSnapshot(UID, snapOf([fresh]), null);
  ok(Array.isArray(merged2) && merged2.length === 1, 'S2: la fusión vive en memoria aunque nada persista');
  ok(sb.getLocalNotifications(UID).length === 0, 'S2: localStorage quedó vacío (persistencia imposible)');
  sb.renderNotificationsList(UID, merged2);
  rows = paintedRows(sb);
  ok(rows.length === 1 && (rows[0]._q['.notif-msg'] || {})._text.includes('me gusta'), 'S2: Actividad SÍ muestra la llegada (pinta de memoria)');

  console.log('== S3: fila legacy sin hoja notificationId ==');
  sb = makeSandbox(makeLocalStorage('ok', 1e9));
  const legacy = { _key: 'k-legacy', message: 'legacy sin id', timestamp: Date.now() - 60000, read: false, type: 'like' };
  const merged3 = sb.mergeNotificationsSnapshot(UID, snapOf([legacy]), null);
  ok((merged3 || []).some(n => n.notificationId === 'k-legacy'), 'S3: la legacy se rescata con su clave');
  sb.renderNotificationsList(UID, merged3);
  rows = paintedRows(sb);
  ok(rows.length === 1, 'S3: la legacy se pinta', rows.length + '');

  console.log('== S4: sin override, el render sigue leyendo el caché local ==');
  sb = makeSandbox(makeLocalStorage('ok', 1e9));
  sb.saveLocalNotifications(UID, [fresh]);
  sb.renderNotificationsList(UID);
  rows = paintedRows(sb);
  ok(rows.length === 1, 'S4: render clásico desde localStorage intacto');

  console.log('== S5: contrato de hidratación en el código (modal pinta la fusión) ==');
  ok(/renderNotificationsList\(userId, Array\.isArray\(merged\)/.test(html), 'hydrate pasa la fusión al render');
  ok(!/CONSOLE_OK/.test(html), 'sanidad');

  console.log(failures ? '\nRESULTADO: ' + failures + ' FALLO(S)' : '\nRESULTADO: TODO VERDE');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('ERROR', e && e.stack || e); process.exit(2); });
