/* ================================================================
 * C154-notif — Drex Spotlight: AVISO AL ARTISTA DESTACADO.
 *
 * HALLAZGO (hueco real, re-verificado contra el código base fe9cde6):
 * Drex Spotlight calcula cada semana el top-3 de artistas
 * (drexSpotlightCompute -> spotlight/<semana> {artists[]}) y lo pinta en
 * la repisa "Sonando fuerte", pero el artista destacado NUNCA se enteraba:
 * ningún addNotification en todo el flujo. El interesado (el artista, con
 * uid real en cada entrada del record) no tenía forma de saber que fue
 * destacado salvo abrir la sección de música esa semana.
 *
 * CAMBIO (index.html; 404.html es copia exacta por convención del repo):
 *  - spotlightNotifyFlag(cur, nowMs): updater PURO de la transacción. Marca
 *    spotlightNotified/<semana>/<uid> solo si no existía (el perdedor de la
 *    carrera hace no-op con undefined). No toca el record de spotlight.
 *  - spotlightNotifyText(artist): texto del aviso, ES crudo como C147/C153
 *    (sin claves i18n nuevas).
 *  - maybeAnnounceSpotlight(data): trigger oportunista, patrón C153. Se
 *    invoca desde drexSpotlightPaint (hook único con guarda typeof, cubre
 *    los 4 call sites que pintan el record final). Por artista: transacción
 *    best-effort sobre spotlightNotified/<semana>/<uid>; el ganador dispara
 *    addNotification(uid, msg, 'music', {actionType:'profile', actionId:uid,
 *    actorId:uid, actorName}) — tipo 'music' para heredar el toggle de
 *    música del destinatario (notifTypeToPrefKey), igual que el aviso de
 *    canción nueva. Sin auto-aviso: si quien pinta es el propio artista no
 *    se marca el flag (otro cliente lo avisará después). Guarda de sesión
 *    _c154SpotlightTried por semana+artista. Sin índices RTDB nuevos:
 *    spotlightNotified es nodo plano best-effort; si las reglas lo deniegan,
 *    el Spotlight sigue intacto (degradación documentada).
 *
 * Ejecutar con: node tests/test-c154-notif-spotlight.js
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let failures = 0;
function tcase(name, fn) {
  try {
    const ok = fn();
    if (ok && typeof ok.then === 'function') {
      return ok.then(function (v) {
        console.log((v ? 'ok - ' : 'NOT OK - ') + name);
        if (!v) failures++;
      }).catch(function (e) {
        console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
        failures++;
      });
    }
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
const NOW = 1780000000000; // fijo y determinista para el updater puro
function mkRecord(over) {
  return Object.assign({
    week: '2026-W39', computedAt: NOW - 1000,
    artists: [
      { key: 'uA', uid: 'uA', name: 'Atenis', trackId: 't1', title: 'Luz', cover: '', plays: 120, tracks: 2, score: 300 },
      { key: 'uB', uid: 'uB', name: 'Nova', trackId: 't2', title: 'Mar', cover: '', plays: 90, tracks: 1, score: 200 }
    ]
  }, over || {});
}

// ---------- Parte A: estáticos ----------
tcase('A1 existen spotlightNotifyFlag, spotlightNotifyText y maybeAnnounceSpotlight', () => {
  return html.indexOf('function spotlightNotifyFlag(cur, nowMs)') !== -1
    && html.indexOf('function spotlightNotifyText(artist)') !== -1
    && html.indexOf('function maybeAnnounceSpotlight(data)') !== -1;
});
tcase('A2 hook único en drexSpotlightPaint con guarda typeof (sandboxes viejos)', () => {
  const fn = extractFn(html, 'drexSpotlightPaint');
  return fn.indexOf("typeof maybeAnnounceSpotlight === 'function'") !== -1
    && fn.indexOf('maybeAnnounceSpotlight(data)') !== -1;
});
tcase('A3 el aviso usa tipo music + meta profile/actorId del artista (hereda toggle de música)', () => {
  const fn = extractFn(html, 'maybeAnnounceSpotlight');
  return fn.indexOf("addNotification(uid, spotlightNotifyText(a), 'music', {") !== -1
    && fn.indexOf("actionType: 'profile', actionId: uid") !== -1
    && fn.indexOf('actorId: uid') !== -1;
});
tcase('A4 flag idempotente en spotlightNotified/<semana>/<uid> (nodo plano, sin índices nuevos)', () => {
  const fn = extractFn(html, 'maybeAnnounceSpotlight');
  return fn.indexOf("DrexCloud.database().ref('spotlightNotified/' + wid + '/' + uid).transaction(function (cur)") !== -1
    && fn.indexOf('return spotlightNotifyFlag(cur, Date.now());') !== -1
    && html.indexOf('spotlightNotified') !== -1;
});
tcase('A5 guarda de sesión: una tentativa por semana+artista (_c154SpotlightTried)', () => {
  const fn = extractFn(html, 'maybeAnnounceSpotlight');
  return html.indexOf('var _c154SpotlightTried = {};') !== -1
    && fn.indexOf('var gk = wid + \'/\' + uid;') !== -1
    && fn.indexOf('if (_c154SpotlightTried[gk]) return;') !== -1
    && fn.indexOf('_c154SpotlightTried[gk] = true;') !== -1;
});
tcase('A6 sin auto-aviso: el artista que pinta no se marca el flag', () => {
  const fn = extractFn(html, 'maybeAnnounceSpotlight');
  return fn.indexOf('if (!uid || uid === me.uid) return;') !== -1;
});
tcase('A7 mensaje ES fijo, sin appT ni claves i18n nuevas', () => {
  const fn = extractFn(html, 'spotlightNotifyText');
  return fn.indexOf('Fuiste destacado en el Drex Spotlight') !== -1
    && fn.indexOf('appT(') === -1;
});
tcase('A8 best-effort: trigger envuelto en try/catch y callbacks tolerantes', () => {
  const fn = extractFn(html, 'maybeAnnounceSpotlight');
  return fn.trim().startsWith('function maybeAnnounceSpotlight(data) {\n  try {')
    && fn.indexOf('} catch (_) {}') !== -1;
});
tcase('A9 no se inventó tipo nuevo: music ya existe en notifTypeToPrefKey', () => {
  return html.indexOf("if (type === 'music' || type === 'post') return 'followingPosts';") !== -1;
});

// ---------- Parte B: spotlightNotifyFlag (puro) ----------
function flagBox() {
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(extractFn(html, 'spotlightNotifyFlag'), sb);
  return sb;
}
tcase('B1 ausente -> marca {at: nowMs} determinista', () => {
  const sb = flagBox();
  const r = vm.runInContext('spotlightNotifyFlag(null, ' + NOW + ')', sb);
  return r && r.at === NOW;
});
tcase('B2 ya marcado -> undefined (el perdedor hace no-op)', () => {
  const sb = flagBox();
  vm.runInContext('this.__c = { at: 1 };', sb);
  const r = vm.runInContext('spotlightNotifyFlag(this.__c, ' + NOW + ')', sb);
  const kept = vm.runInContext('this.__c.at', sb);
  return r === undefined && kept === 1;
});

// ---------- Parte C: spotlightNotifyText (puro) ----------
function textBox() {
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(extractFn(html, 'spotlightNotifyText'), sb);
  return sb;
}
function notifText(artistObj) {
  const sb = textBox();
  vm.runInContext('this.__a = ' + JSON.stringify(artistObj) + ';', sb);
  return vm.runInContext('spotlightNotifyText(this.__a)', sb);
}
tcase('C1 con título: nombra la canción entre «»', () => {
  const t = notifText({ name: 'Atenis', title: 'Luz' });
  return t === '¡Felicidades! Fuiste destacado en el Drex Spotlight de esta semana con «Luz».';
});
tcase('C2 sin título: mensaje genérico válido', () => {
  const t = notifText({ name: 'Nova', title: '' });
  return t === '¡Felicidades! Fuiste destacado en el Drex Spotlight de esta semana.';
});
tcase('C3 null-safe: artist null no revienta', () => {
  const sb = textBox();
  const t = vm.runInContext('spotlightNotifyText(null)', sb);
  return t === '¡Felicidades! Fuiste destacado en el Drex Spotlight de esta semana.';
});
tcase('C4 título con espacios se recorta', () => {
  const t = notifText({ title: '  Mar  ' });
  return t.indexOf('con «Mar».') !== -1;
});

// ---------- Parte D: maybeAnnounceSpotlight (conductual, mocks) ----------
function triggerBox(opts) {
  // opts: {uid, serverFlags:{uid:true}, txnCommitted:null|bool}
  const counters = { txn: 0, notifs: [] };
  const sb = {};
  vm.createContext(sb);
  const mocks = [
    'var _c154SpotlightTried = {};',
    'var DrexCloud = {',
    '  auth: function(){ return { currentUser: ' + (opts.uid ? '{ uid: ' + JSON.stringify(opts.uid) + ' }' : 'null') + ' }; },',
    '  database: function(){ return { ref: function(path){ return __ref(path); } }; }',
    '};',
    'function __ref(path){',
    '  var m = /^spotlightNotified\\/([^/]+)\\/([^/]+)$/.exec(path);',
    '  if (m) {',
    '    var uid = m[2];',
    '    return {',
    '      transaction: function(updater, onComplete){',
    '        __counters.txn++;',
    '        var cur = __serverFlags[uid] ? { at: 1 } : null;',
    '        var res = updater(cur, 999);',
    '        var committed = (typeof __txnCommitted === "boolean") ? __txnCommitted : (res !== undefined);',
    '        if (committed && res !== undefined) __serverFlags[uid] = true;',
    '        onComplete(null, committed, { val: function(){ return res; } });',
    '      }',
    '    };',
    '  }',
    '  throw new Error("ruta inesperada: " + path);',
    '}',
    'function addNotification(userId, message, type, meta){',
    '  __counters.notifs.push({ userId: userId, message: message, type: type, meta: meta });',
    '  return Promise.resolve();',
    '}'
  ].join('\n');
  sb.__counters = counters;
  sb.__serverFlags = Object.assign({}, opts.serverFlags || {});
  sb.__txnCommitted = (opts.txnCommitted === undefined ? null : opts.txnCommitted);
  sb.setTimeout = setTimeout;
  sb.clearTimeout = clearTimeout;
  vm.runInContext(mocks, sb);
  vm.runInContext(extractFn(html, 'spotlightNotifyFlag'), sb);
  vm.runInContext(extractFn(html, 'spotlightNotifyText'), sb);
  vm.runInContext(extractFn(html, 'maybeAnnounceSpotlight'), sb);
  return { sb: sb, counters: counters };
}
function fire(trigger, recordObj) {
  const sb = trigger.sb;
  vm.runInContext('this.__r = ' + JSON.stringify(recordObj) + ';', sb);
  vm.runInContext('maybeAnnounceSpotlight(this.__r)', sb);
  return new Promise(function (res) { setTimeout(res, 30); });
}
tcase('D1 pinta un tercero: 2 artistas -> 2 transacciones y 2 avisos music', () => {
  const tr = triggerBox({ uid: 'viewer1' });
  return fire(tr, mkRecord()).then(function () {
    const ns = tr.counters.notifs;
    return tr.counters.txn === 2 && ns.length === 2
      && ns[0].userId === 'uA' && ns[0].type === 'music'
      && ns[0].meta && ns[0].meta.actionType === 'profile' && ns[0].meta.actionId === 'uA'
      && ns[0].meta.actorId === 'uA' && ns[0].message.indexOf('«Luz»') !== -1
      && ns[1].userId === 'uB' && tr.sb.__serverFlags.uA === true && tr.sb.__serverFlags.uB === true;
  });
});
tcase('D2 artista ya avisado en servidor -> sin aviso (carrera ya ganada)', () => {
  const tr = triggerBox({ uid: 'viewer1', serverFlags: { uA: true } });
  return fire(tr, mkRecord()).then(function () {
    const ns = tr.counters.notifs;
    return tr.counters.txn === 2 && ns.length === 1 && ns[0].userId === 'uB';
  });
});
tcase('D3 el propio artista pinta: no se auto-avisa ni se marca el flag', () => {
  const tr = triggerBox({ uid: 'uA' });
  return fire(tr, mkRecord()).then(function () {
    const ns = tr.counters.notifs;
    return tr.counters.txn === 1 && ns.length === 1 && ns[0].userId === 'uB'
      && tr.sb.__serverFlags.uA !== true;
  });
});
tcase('D4 sin sesión -> sin transacciones', () => {
  const tr = triggerBox({ uid: null });
  return fire(tr, mkRecord()).then(function () {
    return tr.counters.txn === 0 && tr.counters.notifs.length === 0;
  });
});
tcase('D5 segunda pintada en la sesión no reintenta', () => {
  const tr = triggerBox({ uid: 'viewer1' });
  return fire(tr, mkRecord()).then(function () {
    return fire(tr, mkRecord()).then(function () {
      return tr.counters.txn === 2 && tr.counters.notifs.length === 2;
    });
  });
});
tcase('D6 carrera perdida (commit false) -> sin aviso', () => {
  const tr = triggerBox({ uid: 'viewer1', txnCommitted: false });
  return fire(tr, mkRecord()).then(function () {
    return tr.counters.txn === 2 && tr.counters.notifs.length === 0
      && tr.sb.__serverFlags.uA !== true;
  });
});
tcase('D7 artista sin uid se salta (agrupado por nombre)', () => {
  const tr = triggerBox({ uid: 'viewer1' });
  const rec = mkRecord({ artists: [{ key: 'name:X', uid: '', name: 'X', title: 'Y' }] });
  return fire(tr, rec).then(function () {
    return tr.counters.txn === 0 && tr.counters.notifs.length === 0;
  });
});
tcase('D8 record sin semana o sin artistas -> nada', () => {
  const tr = triggerBox({ uid: 'viewer1' });
  return fire(tr, mkRecord({ week: '', artists: [] })).then(function () {
    return tr.counters.txn === 0;
  });
});

// ---------- Parte E: sandbox viejo (sin anunciador) no revienta ----------
tcase('E1 drexSpotlightPaint sin maybeAnnounceSpotlight definido: pinta igual', () => {
  const sb = {};
  vm.createContext(sb);
  const mocks = [
    'var drexSpotlightTracks = [];',
    'var drexSpotlightData = null;',
    'var __box = { classList: { add: function(){}, remove: function(){} }, __html: "", set innerHTML(v){ this.__html = v; }, get innerHTML(){ return this.__html; } };',
    'var document = { getElementById: function(){ return __box; } };',
    'function appT(s){ return s; }',
    'function musicEsc(s){ return String(s); }',
    'function musicEscJs(s){ return String(s); }',
    'function musicFmtNum(n){ return String(n); }',
    'function drexSpotlightPlay(i){}'
  ].join('\n');
  vm.runInContext(mocks, sb);
  vm.runInContext(extractFn(html, 'drexSpotlightNote'), sb);
  vm.runInContext(extractFn(html, 'drexSpotlightPaint'), sb);
  vm.runInContext('this.__r = ' + JSON.stringify(mkRecord()) + ';', sb);
  vm.runInContext('drexSpotlightPaint(this.__r)', sb);
  const painted = vm.runInContext('__box.__html', sb);
  // Sin anunciador no hay excepción (guarda typeof) y la repisa se pinta igual.
  return typeof painted === 'string' && painted.indexOf('Atenis') !== -1 && painted.indexOf('Sonando fuerte') !== -1;
});
tcase('E2 con anunciador mock: el hook se invoca al pintar', () => {
  const sb = {};
  vm.createContext(sb);
  const mocks = [
    'var drexSpotlightTracks = [];',
    'var drexSpotlightData = null;',
    'var __hookCalls = 0;',
    'function maybeAnnounceSpotlight(d){ __hookCalls++; }',
    'var document = { getElementById: function(){ return { classList: { add: function(){}, remove: function(){} }, set innerHTML(v){ this.__html = v; }, get innerHTML(){ return this.__html; } }; } };',
    'function appT(s){ return s; }',
    'function musicEsc(s){ return String(s); }',
    'function musicEscJs(s){ return String(s); }',
    'function musicFmtNum(n){ return String(n); }',
    'function drexSpotlightPlay(i){}'
  ].join('\n');
  vm.runInContext(mocks, sb);
  vm.runInContext(extractFn(html, 'drexSpotlightNote'), sb);
  vm.runInContext(extractFn(html, 'drexSpotlightPaint'), sb);
  vm.runInContext('this.__r = ' + JSON.stringify(mkRecord()) + ';', sb);
  vm.runInContext('drexSpotlightPaint(this.__r)', sb);
  return vm.runInContext('__hookCalls', sb) === 1;
});

setTimeout(function () {
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
}, 500);
