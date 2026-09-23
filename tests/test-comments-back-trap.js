// Harness: trampa del botón Atrás en comentarios.
// Reproduce con el código REAL de index.html (evaluado en vm) la secuencia:
//   abrir comentarios -> Atrás -> Atrás -> ...
// El bug: openCommentsView() hace doble push (ruta dinámica + guard de overlay)
// y closeCommentsView() no normaliza la URL, así que el segundo Atrás relee la
// URL (post/:id/comentarios) y REABRE los comentarios: trampa infinita.
//
// Sale 0 si el flujo es correcto (el 2º Atrás vuelve al feed sin reabrir),
// sale 1 si se reproduce la trampa.
//
// Uso: node test-comments-back-trap.js [ruta-a-index.html]
'use strict';
const fs = require('fs');
const vm = require('vm');

const HTML_PATH = process.argv[2] || '/home/hatch/workspace/beabo/index.html';
const html = fs.readFileSync(HTML_PATH, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
console.log('scripts inline extraídos:', scripts.length);

// ---------- stubs ----------
function makeClassList() {
  const s = new Set();
  return {
    add(...c) { c.forEach(x => s.add(x)); },
    remove(...c) { c.forEach(x => s.delete(x)); },
    contains(c) { return s.has(c); },
    toggle(c, force) {
      const want = force === undefined ? !s.has(c) : !!force;
      if (want) s.add(c); else s.delete(c);
      return want;
    },
  };
}
function makeEl(id) {
  const el = {
    id, classList: makeClassList(), style: {}, dataset: {},
    _innerHTML: '', _textContent: '',
    value: '', checked: false, files: [], disabled: false,
    contains() { return false; },
    addEventListener() {}, removeEventListener() {},
    focus() {}, click() {}, blur() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {}, prepend() {}, remove() {},
    getAttribute() { return null; }, setAttribute() {}, removeAttribute() {},
    closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._innerHTML; }, set(v) { this._innerHTML = String(v); },
  });
  Object.defineProperty(el, 'textContent', {
    get() { return this._textContent; }, set(v) { this._textContent = String(v); },
  });
  return el;
}
const els = {};
function getEl(id) {
  if (!els[id]) { els[id] = makeEl(id); els[id].classList.add('hidden'); }
  return els[id];
}
const qsEls = {};
function qsEl(sel) {
  if (!qsEls[sel]) { qsEls[sel] = makeEl('qs:' + sel); qsEls[sel].classList.add('hidden'); }
  return qsEls[sel];
}

// history + location
const popHandlers = [];
const locationStub = {
  href: 'https://test.local/Beabo/', pathname: '/Beabo/',
  search: '', hash: '', hostname: 'test.local', protocol: 'https:',
};
function syncLocation(url) {
  const u = new URL(url, locationStub.href);
  locationStub.href = u.href; locationStub.pathname = u.pathname;
  locationStub.search = u.search; locationStub.hash = u.hash;
  locationStub.hostname = u.hostname;
}
const historyStub = {
  entries: [{ state: null, url: locationStub.href }],
  index: 0,
  pushState(state, _t, url) {
    this.entries.length = this.index + 1;
    const u = new URL(url, this.entries[this.index].url);
    this.entries.push({ state: state || null, url: u.href });
    this.index++;
    syncLocation(u.href);
  },
  replaceState(state, _t, url) {
    const u = new URL(url, this.entries[this.index].url);
    this.entries[this.index] = { state: state || null, url: u.href };
    syncLocation(u.href);
  },
  back() {
    if (this.index > 0) { this.index--; syncLocation(this.entries[this.index].url); firePop(); }
  },
  get length() { return this.entries.length; },
  get state() { return this.entries[this.index].state; },
};
function firePop() {
  for (const fn of popHandlers) {
    try { fn({}); } catch (e) { console.log('  [popstate handler lanzó]', e.message); }
  }
}

const neverThen = { then() { return neverThen; }, catch() { return neverThen; } };
// cadena de queries encadenable: cualquier método devuelve la cadena;
// los terminales (once/get) devuelven un thenable que nunca resuelve.
const queryStub = new Proxy(function () {}, {
  get(t, p) {
    if (p === 'once' || p === 'get') return () => neverThen;
    if (p === 'then' || p === 'catch') return undefined;
    if (p === Symbol.toPrimitive) return () => 0;
    return (..._a) => queryStub;
  },
  apply() { return queryStub; },
});
const dbRefStub = queryStub;

const sandbox = {
  console, process, setTimeout, clearTimeout, setInterval, clearInterval,
  URL, URLSearchParams, JSON, Math, Date, RegExp, Promise,
  location: locationStub,
  history: historyStub,
  document: {
    getElementById: getEl,
    querySelector: (sel) => qsEl(String(sel)),
    querySelectorAll: () => [],
    createElement: (tag) => makeEl('created-' + tag),
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
    body: makeEl('body'),
    head: makeEl('head'),
    documentElement: makeEl('html'),
    hidden: false, visibilityState: 'visible',
  },
  DrexCloud: {
    auth: () => ({ currentUser: null, onAuthStateChanged() {} }),
    database: () => ({ ref: () => dbRefStub }),
  },
  drexAppChromeAllowed: () => true,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  navigator: { userAgent: 'harness' },
  MutationObserver: class { constructor() {} observe() {} disconnect() {} },
  IntersectionObserver: class { constructor() {} observe() {} disconnect() {} },
  ResizeObserver: class { constructor() {} observe() {} disconnect() {} },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  fetch: () => Promise.reject(new Error('sin red en harness')),
  alert() {}, confirm: () => false,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
// capturar popstate
const _addEL = () => {};
sandbox.window.addEventListener = (type, fn) => { if (type === 'popstate' && typeof fn === 'function') popHandlers.push(fn); };
vm.createContext(sandbox);

let failed = 0;
scripts.forEach((code, i) => {
  try {
    vm.runInContext(code, sandbox, { filename: `inline_${i}.js` });
  } catch (e) {
    failed++;
    console.log(`  [script ${i} lanzó al evaluar] ${e.message}`);
    console.log('   ' + (e.stack || '').split('\n').slice(1, 4).join('\n   '));
  }
});
console.log('scripts con error al evaluar:', failed);

// ---------- driver (corre dentro del mismo contexto) ----------
const driver = `
;(function () {
  const out = [];
  const visible = (id) => {
    const el = document.getElementById(id);
    return !!(el && !el.classList.contains('hidden') && el.style.display !== 'none');
  };
  const show = (id) => document.getElementById(id).classList.remove('hidden');
  const state = () => ({
    url: location.pathname + location.search + location.hash,
    histLen: history.entries.length, histIdx: history.index,
    comments: visible('comments-view'), main: visible('main-app'),
  });
  const log = (tag) => out.push(tag + ' ' + JSON.stringify(state()));

  // estado inicial: feed visible
  show('main-app');
  log('init        ');
  if (history.entries.length !== 1) { out.push('FALLO: historial inicial != 1'); }

  // 1) abrir comentarios del post AAA (código real)
  openCommentsView('AAA');
  log('open        ');
  const afterOpen = state();
  const pushes = afterOpen.histLen - 1;

  // 2) Atrás #1 -> debe cerrar comentarios
  history.back();
  log('back#1      ');
  const closed1 = !state().comments;

  // 3) Atrás #2 -> debe volver al feed SIN reabrir comentarios
  history.back();
  log('back#2      ');
  const s2 = state();

  // 4) dos Atrás más para detectar ciclo infinito
  history.back();
  log('back#3      ');
  const s3 = state();
  history.back();
  log('back#4      ');
  const s4 = state();

  // 5) caso X: reabrir y cerrar por X (closeCommentsView directo), luego Atrás
  openCommentsView('BBB');
  log('openB       ');
  closeCommentsView();
  log('x-close     ');
  const afterX = state();
  history.back();
  log('backX       ');
  const sX = state();

  return { out, pushes, closed1, s2, s3, s4, url2: s2.url, afterX, sX };
})();
`;
const r = vm.runInContext(driver, sandbox, { filename: 'driver.js' });
r.out.forEach(l => console.log(l));
console.log('pushes al abrir comentarios:', r.pushes, '(bug = 2: ruta + guard)');
console.log('atrás #1 cerró comentarios:', r.closed1);

let trap = false;
if (r.s2.comments) {
  trap = true;
  console.log('TRAMPA: atrás #2 REABRIÓ los comentarios en vez de volver al feed. URL=' + r.url2);
}
if (r.s3.comments || r.s4.comments) {
  trap = true;
  console.log('TRAMPA: ciclo reapertura en atrás #3/#4 (comments visibles)');
}
if (!trap) {
  const atFeed = /\/Beabo\/?$/.test(r.url2) && !r.s2.comments;
  console.log(atFeed
    ? 'OK: atrás #2 volvió al feed sin reabrir comentarios.'
    : 'OK parcial: sin reapertura, pero URL final=' + r.url2);
}
// caso X: tras cerrar por X la URL debe normalizarse y el Atrás no reabrir
console.log('tras X: url=' + r.afterX.url + ' histLen=' + r.afterX.histLen + ' comments=' + r.afterX.comments);
if (r.afterX.comments) { trap = true; console.log('TRAMPA: X no cerró los comentarios'); }
if (r.sX.comments) { trap = true; console.log('TRAMPA: Atrás tras X REABRIÓ los comentarios. URL=' + r.sX.url); }
if (!/\/Beabo\/?$/.test(r.afterX.url)) { trap = true; console.log('TRAMPA: X dejó URL stale=' + r.afterX.url); }
if (!trap) console.log('OK: X normaliza la URL y el Atrás siguiente no reabre.');
process.exit(trap ? 1 : 0);
