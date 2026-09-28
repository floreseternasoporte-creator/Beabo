#!/usr/bin/env node
/* C232: test de la UI de En vivo (parts_integration.js) con DOM/DB falsos.
 * Verifica: pestañas, lista, tarjetas (sin UIDs crudos, con escape),
 * estáticos i18n, regalos, suscripción/desuscripción de la lista. */
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

function makeClassList() {
  const s = new Set();
  return {
    add: (c) => s.add(c),
    remove: (c) => s.delete(c),
    toggle: (c, f) => { if (f === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else if (f) s.add(c); else s.delete(c); },
    contains: (c) => s.has(c),
    _set: s,
  };
}
function makeEl(id) {
  return {
    id, textContent: '', innerHTML: '', value: '', placeholder: '',
    style: {}, disabled: false, children: [],
    classList: makeClassList(),
    setAttribute(k, v) { this['attr_' + k] = v; },
    getAttribute(k) { return this['attr_' + k]; },
    _listeners: {},
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    _fire(ev, arg) { (this._listeners[ev] || []).forEach((fn) => fn(arg || {})); },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    removeAttribute() {},
    play() { return Promise.resolve(); },
    get firstChild() { return this.children[0]; },
  };
}

const elements = {};
function $(id) {
  if (!elements[id]) elements[id] = makeEl(id);
  return elements[id];
}

const toasts = [];
const coreCalls = [];
let listCb = null;
let listOffCalled = 0;
const fakeCore = {
  onLiveList(cb) { listCb = cb; cb([]); return () => { listOffCalled++; listCb = null; }; },
  on() { return () => {}; },
  setUser(u) { coreCalls.push(['setUser', u.uid]); },
  createLive(o) { coreCalls.push(['createLive', o.title]); return Promise.resolve({ liveId: 'lv1' }); },
  startHost(o) { coreCalls.push(['startHost', o.liveId]); return Promise.resolve(); },
  joinLive(id) { coreCalls.push(['joinLive', id]); return Promise.resolve(); },
  leaveLive() { coreCalls.push(['leaveLive']); },
  endLive() { coreCalls.push(['endLive']); return Promise.resolve(); },
  sendChat(t2) { coreCalls.push(['sendChat', t2]); return Promise.resolve(); },
  sendGift(g) { coreCalls.push(['sendGift', g]); return Promise.resolve(); },
  bumpLike() { coreCalls.push(['bumpLike']); return Promise.resolve(); },
};

const sandbox = {
  console,
  document: {
    getElementById: $,
    createElement: (tag) => makeEl('dyn-' + tag + '-' + Math.random().toString(36).slice(2, 7)),
  },
  window: {},
  navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [], getAudioTracks: () => [] }) } },
  DrexLiveCore: function () { return fakeCore; },
  DrexCloud: { auth: () => ({ currentUser: { uid: 'u-host-1' } }), database: () => ({ ref: () => ({}) }) },
  appT: (s) => 'T:' + s,
  showMiniToast: (m) => toasts.push(m),
  fiestaMyProfile: () => Promise.resolve({ name: 'Anfitrión', photo: '' }),
  drexCamEffects: [{ id: 'fx1', nombre: 'Neón', filter: 'saturate(1.5)' }],
  setTimeout: (fn) => 0,
  Math, Promise, String, Number, JSON, Date,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const code = fs.readFileSync('/home/hatch/workspace/c232/parts_integration.js', 'utf8');
vm.runInContext(code, sandbox, { filename: 'parts_integration.js' });

const UI = sandbox.DrexLiveUI;
assert.ok(UI, 'DrexLiveUI expuesto');
assert.strictEqual(typeof sandbox.drexFiestaSwitchTab, 'function', 'switchTab global');
assert.strictEqual(typeof sandbox.drexLiveJoin, 'function', 'join global');

// 1. Cambiar a En vivo: paneles, tabs, suscripción.
sandbox.drexFiestaSwitchTab('live');
assert.ok($('fiesta-pane-live').classList.contains('hidden') === false, 'pane-live visible');
assert.ok($('fiesta-pane-fiesta').classList.contains('hidden'), 'pane-fiesta oculto');
assert.ok($('fiesta-tab-btn-live').classList.contains('drex-live-tab-active'), 'tab live activa');
assert.ok(typeof listCb === 'function', 'onLiveList suscrito');
assert.strictEqual($('drex-live-tab-badge').textContent, '0', 'badge 0 con lista vacía');
assert.ok(!$('drex-live-empty').classList.contains('hidden'), 'empty state visible sin lives');

// 2. La lista renderiza tarjetas sin UIDs y con escape.
listCb([
  { id: 'lvA', hostUid: 'uid-secreto-123', hostName: 'María', hostAvatar: '', title: 'Charla <b>nocturna</b>', viewers: 12, status: 'live' },
  { id: 'lvB', hostUid: 'uid-otro-456', hostName: 'Pedro', hostAvatar: 'https://x/y.png', title: 'Música', viewers: 3, status: 'live' },
]);
const html = $('drex-live-list').innerHTML;
assert.ok(html.includes('Charla &lt;b&gt;nocturna&lt;/b&gt;'), 'título escapado');
assert.ok(!html.includes('<b>nocturna</b>'), 'sin HTML crudo');
assert.ok(!html.includes('uid-secreto-123') && !html.includes('uid-otro-456'), 'sin UIDs en la UI');
assert.ok(html.includes('María') && html.includes('Pedro'), 'nombres visibles');
assert.ok(html.includes('T:Unirse'), 'botón unirse traducido');
assert.ok(html.includes('data-lid="lvA"'), 'data-lid presente');
assert.ok($('drex-live-empty').classList.contains('hidden'), 'empty oculto con lives');
assert.strictEqual($('drex-live-tab-badge').textContent, '2', 'badge con conteo');

// 3. Volver a Fiesta: desuscribe.
sandbox.drexFiestaSwitchTab('fiesta');
assert.ok($('fiesta-pane-fiesta').classList.contains('hidden') === false, 'pane-fiesta visible');
assert.ok($('fiesta-pane-live').classList.contains('hidden'), 'pane-live oculto');
assert.strictEqual(listOffCalled, 1, 'lista desuscrita');

// 4. Estáticos i18n.
sandbox.drexFiestaSwitchTab('live');
UI.translateStatics();
assert.ok($('drex-live-go-label').textContent.startsWith('T:'), 'estáticos traducidos vía appT');
assert.strictEqual($('drex-live-title').placeholder, 'T:¿De qué va tu en vivo?', 'placeholder traducido');
assert.strictEqual($('drex-live-host-chat-input').placeholder, 'T:Escribe un mensaje...', 'placeholder chat host');
assert.ok(UI.statics.length >= 15, 'suficientes claves estáticas');

// 5. Regalos: 5 definidos, ids únicos, hoja se abre.
const ids = UI.gifts.map((g) => g.id);
assert.strictEqual(ids.length, 5, '5 regalos');
assert.strictEqual(new Set(ids).size, 5, 'ids únicos');
assert.ok(UI.gifts.every((g) => g.emoji && g.label), 'emoji+label en cada regalo');
sandbox.drexLiveOpenGifts('viewer');
assert.ok(!$('drex-live-gifts').classList.contains('hidden'), 'hoja de regalos abierta');
assert.strictEqual($('drex-live-gifts-grid').children.length, 5, '5 botones de regalo');
assert.strictEqual($('drex-live-gifts-t').textContent, 'T:Regalos', 'título regalos traducido');
sandbox.drexLiveCloseGifts();
assert.ok($('drex-live-gifts').classList.contains('hidden'), 'hoja de regalos cerrada');

// 6. Enviar regalo llama al núcleo con el id.
UI._ls.core = fakeCore; // simula núcleo ya creado
sandbox.drexLiveSendGift('rosa');
assert.ok(coreCalls.some((c) => c[0] === 'sendGift' && c[1] === 'rosa'), 'sendGift(rosa) al núcleo');

// 7. Like llama bumpLike.
sandbox.drexLiveLike('viewer');
assert.ok(coreCalls.some((c) => c[0] === 'bumpLike'), 'bumpLike llamado');

// 8. Chat: envío llama sendChat y limpia el input.
$('drex-live-viewer-chat-input').value = 'hola mundo';
sandbox.drexLiveSendChat('viewer');
assert.ok(coreCalls.some((c) => c[0] === 'sendChat' && c[1] === 'hola mundo'), 'sendChat llamado');
assert.strictEqual($('drex-live-viewer-chat-input').value, '', 'input limpio');

// 9. Doble toque en el stage del viewer → like flotante + bumpLike.
UI.initDom();
const floatLayer = $('drex-live-viewer-float');
const floatsBefore = floatLayer.children.length;
const stage = $('drex-live-viewer-stage');
stage._fire('click'); // un toque solo no dispara
assert.strictEqual(floatLayer.children.length, floatsBefore, 'un toque no genera flotante');
UI._ls.lastTap = 0; // aislar el par siguiente del toque anterior
stage._fire('click'); stage._fire('click'); // doble toque rápido (<350ms)
assert.strictEqual(floatLayer.children.length, floatsBefore + 1, 'doble toque genera flotante');
assert.strictEqual(floatLayer.children[floatLayer.children.length - 1].textContent, '❤️', 'el flotante es un corazón');
assert.ok(coreCalls.some((c) => c[0] === 'bumpLike'), 'doble toque llama bumpLike del núcleo');
assert.strictEqual(typeof UI.initDom, 'function', 'initDom expuesto en el handle');

console.log('C232 live UI: 9 grupos de checks verdes.');
