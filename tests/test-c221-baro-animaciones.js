'use strict';
// Tests del carril lane2 (BARO-FX · sistema de animación premium).
// Cubre: superficie de la API BaroFX, rama prefers-reduced-motion,
// mapeo del callback del observer (usuario vs Baro vs typing vs chips),
// stagger, init sin #baro-thread, send morph, skeleton, shake, scroll,
// empty state, delegación de typing, envolturas idempotentes e higiene
// (sin literales </script, solo clases baro-fx-* en el JS, CSS con
// selectores existentes permitidos).
//
// BaroFX se carga con vm en un sandbox con stubs mínimos de DOM.
// Uso: node tests/test-c221-baro-animaciones.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_PATH = path.join(__dirname, '..', 'baro-fx.js');
const CSS_PATH = path.join(__dirname, '..', 'baro-fx.css');
/* Adaptación del integrador (2026-09-30): en el repo el código ya está
 * integrado en index.html; si los archivos sueltos de la lane no existen,
 * se extraen de los marcadores de integración. */
function __extractBetween(html, a, b) {
  const i = html.indexOf(a);
  if (i === -1) throw new Error('marcador ausente: ' + a.slice(0, 50));
  const j = html.indexOf(b, i + a.length);
  if (j === -1) throw new Error('marcador de fin ausente: ' + b.slice(0, 50));
  return html.slice(i + a.length, j);
}
function __resolveLaneSrc(relPath, startMarker, endMarker) {
  const p = path.join(__dirname, '..', relPath);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  const repoHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  return __extractBetween(repoHtml, startMarker, endMarker);
}
const BAROFX_JS = __resolveLaneSrc('baro-fx.js',
  '/* ===== BARO-FX · JS (C221 lane2) — INICIO ===== */',
  '/* ===== BARO-FX · JS (C221 lane2) — FIN ===== */');
const BAROFX_CSS = __resolveLaneSrc('baro-fx.css',
  '/* ===== BARO-FX · CSS (C221 lane2) — INICIO ===== */',
  '/* ===== BARO-FX · CSS (C221 lane2) — FIN ===== */');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error('  FALLO ' + name); }
}

/* ---------- stubs mínimos de DOM ---------- */
function makeEl(tag, cls) {
  const classes = new Set();
  const el = {
    nodeType: 1,
    tagName: String(tag || 'div').toUpperCase(),
    classList: {
      add(...cs) { cs.forEach(c => classes.add(c)); },
      remove(...cs) { cs.forEach(c => classes.delete(c)); },
      contains(c) { return classes.has(c); },
    },
    _classes: classes,
    style: {
      _p: {},
      setProperty(k, v) { this._p[k] = v; },
      removeProperty(k) { delete this._p[k]; },
      getProperty(k) { return this._p[k]; },
    },
    children: [],
    parentNode: null,
    offsetWidth: 100,
    scrollTop: 0,
    scrollHeight: 500,
    innerHTML: '',
    _handlers: {},
    _scrolled: null,
    addEventListener(t, f) { (this._handlers[t] = this._handlers[t] || []).push(f); },
    removeEventListener(t, f) { this._handlers[t] = (this._handlers[t] || []).filter(x => x !== f); },
    fire(t, evt) { (this._handlers[t] || []).slice().forEach(f => f.call(this, evt || {})); },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; },
    setAttribute() {},
    scrollTo(o) { this._scrolled = o; },    querySelector(sel) { const r = this.querySelectorAll(sel); return r.length ? r[0] : null; },
    querySelectorAll(sel) {
      const out = [];
      const parts = String(sel).split(',').map(s => s.trim()).filter(Boolean);
      (function walk(n) {
        (n.children || []).forEach(ch => {
          if (ch.nodeType === 1) {
            for (const p of parts) {
              if (p[0] === '.' && ch.classList.contains(p.slice(1))) { out.push(ch); break; }
            }
            walk(ch);
          }
        });
      })(el);
      return out;
    },
  };
  // className sincronizado con classList, como en el DOM real.
  Object.defineProperty(el, 'className', {
    get() { return [...classes].join(' '); },
    set(v) {
      classes.clear();
      String(v || '').split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
    },
  });
  el.className = cls || '';
  return el;
}

function makeDocument() {
  const byId = {};
  const roots = [];
  const doc = {
    readyState: 'complete',
    _sendButton: null,
    _register(id, el) { byId[id] = el; roots.push(el); },
    getElementById(id) { return byId[id] || null; },
    createElement(tag) { return makeEl(tag); },
    addEventListener() {},
    querySelector(sel) {
      if (sel === '#baro-form button[type="submit"]') return doc._sendButton;
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      const parts = String(sel).split(',').map(s => s.trim()).filter(Boolean);
      roots.forEach(root => {
        (function walk(n) {
          for (const p of parts) {
            if (p[0] === '.' && n.classList.contains(p.slice(1))) { out.push(n); break; }
          }
          (n.children || []).forEach(walk);
        })(root);
      });
      return out;
    },
  };
  return doc;
}

function loadBaroFX(opts) {
  opts = opts || {};
  const doc = makeDocument();
  const win = {
    matchMedia: () => ({ matches: !!opts.reduced, media: '(prefers-reduced-motion: reduce)' }),
    requestAnimationFrame: fn => { sandbox._rafQ.push(fn); return sandbox._rafQ.length; },
  };
  const moStub = function (cb) { sandbox._moCb = cb; };
  moStub.prototype.observe = function () {};
  const sandbox = {
    window: win,
    document: doc,
    MutationObserver: moStub,
    setTimeout, clearTimeout,
    console,
    _rafQ: [],
    _moCb: null,
  };
  win.MutationObserver = moStub;
  // Elementos base opcionales
  if (opts.withThread !== false) {
    const thread = makeEl('div', '');
    doc._register('baro-thread', thread);
    sandbox._thread = thread;
  }
  const view = makeEl('div', 'hidden');
  doc._register('baro-view', view);
  sandbox._view = view;
  const form = makeEl('form', '');
  doc._register('baro-form', form);
  const sendBtn = makeEl('button', '');
  doc._sendButton = sendBtn;
  sandbox._sendButton = sendBtn;
  if (opts.preWindow) Object.assign(win, opts.preWindow);
  sandbox.flushRaf = () => { const q = sandbox._rafQ.splice(0); q.forEach(f => f()); };
  vm.createContext(sandbox);
  const src = BAROFX_JS;
  vm.runInContext(src + '\n;globalThis.__T = BaroFX;', sandbox, { filename: 'baro-fx.js' });
  sandbox.BaroFX = sandbox.__T;
  return sandbox;
}

/* ---------- 1. superficie de la API ---------- */
(function () {
  const s = loadBaroFX();
  const api = s.BaroFX;
  ok(api && typeof api === 'object', 'BaroFX global existe');
  ['init', 'reduced', 'animatePanel', 'showTyping', 'hideTyping', 'skeletonOn',
   'skeletonOff', 'sendStart', 'sendDone', 'shake', 'scrollBottom',
   'emptyOn', 'emptyOff', '_onMutations'].forEach(k =>
    ok(typeof api[k] === 'function', 'BaroFX.' + k + ' es función'));
})();

/* ---------- 2. reduced-motion ---------- */
(function () {
  ok(loadBaroFX({ reduced: false }).BaroFX.reduced() === false, 'reduced() false sin match');
  ok(loadBaroFX({ reduced: true }).BaroFX.reduced() === true, 'reduced() true con match');
})();

/* ---------- 3. observer: usuario vs Baro ---------- */
(function () {
  const s = loadBaroFX();
  const u = makeEl('div', 'baro-bubble-user');
  const b = makeEl('div', 'baro-bubble-baro');
  s.BaroFX._onMutations([{ addedNodes: [u, b] }]);
  ok(u.classList.contains('baro-fx-msg') && u.classList.contains('baro-fx-in-u'),
    'burbuja usuario: baro-fx-msg + baro-fx-in-u');
  ok(b.classList.contains('baro-fx-msg') && b.classList.contains('baro-fx-in-b'),
    'burbuja Baro: baro-fx-msg + baro-fx-in-b');
  ok(!u.classList.contains('baro-fx-in-b') && !b.classList.contains('baro-fx-in-u'),
    'no se cruzan las direcciones');
  s.flushRaf(); s.flushRaf();
  ok(u.classList.contains('baro-fx-on') && b.classList.contains('baro-fx-on'),
    'tras rAF se añade baro-fx-on');
  u.fire('transitionend', {}); b.fire('transitionend', {});
  ok(!u.classList.contains('baro-fx-msg') && !b.classList.contains('baro-fx-msg'),
    'tras transitionend se limpian las clases fx');
})();

/* ---------- 4. observer: v2, typing, chips, stagger ---------- */
(function () {
  const s = loadBaroFX();
  const v2 = makeEl('div', 'baro-msg-v2');
  const ty = makeEl('div', 'baro-bubble-baro baro-typing-wrap');
  const chips = makeEl('div', 'baro-v7-chips');
  chips.appendChild(makeEl('button', 'baro-v7-chip'));
  s.BaroFX._onMutations([{ addedNodes: [v2, ty, chips] }]);
  ok(v2.classList.contains('baro-fx-in-b'), 'wrap .baro-msg-v2 entra como Baro');
  ok(ty.classList.contains('baro-fx-typing'), 'typing recibe baro-fx-typing (bounce)');
  ok(ty.classList.contains('baro-fx-in-b'), 'typing también entra como burbuja Baro');
  ok(chips.classList.contains('baro-fx-chips'), 'contenedor de chips recibe baro-fx-chips');
})();

(function () {
  const s = loadBaroFX();
  const a = makeEl('div', 'baro-bubble-user');
  const b = makeEl('div', 'baro-bubble-user');
  s.BaroFX._onMutations([{ addedNodes: [a, b] }]);
  ok(a.style.getProperty('--baro-fx-d') === undefined, 'primer nodo sin delay');
  ok(b.style.getProperty('--baro-fx-d') === '70ms', 'segundo nodo con stagger 70ms');
})();

(function () {
  const s = loadBaroFX({ reduced: true });
  const u = makeEl('div', 'baro-bubble-user');
  s.BaroFX._onMutations([{ addedNodes: [u] }]);
  s.flushRaf(); s.flushRaf();
  ok(!u.classList.contains('baro-fx-msg') && !u.classList.contains('baro-fx-in-u'),
    'con reduced-motion no se animan entradas');
})();

/* ---------- 5. init sin #baro-thread no rompe ---------- */
(function () {
  const s = loadBaroFX({ withThread: false });
  let threw = false, r = null;
  try { r = s.BaroFX.init(); } catch (_) { threw = true; }
  ok(!threw && r === true, 'init() sin #baro-thread no lanza');
})();

/* ---------- 6. send morph ---------- */
(function () {
  const s = loadBaroFX();
  s.BaroFX.sendStart();
  ok(s._sendButton.classList.contains('baro-fx-sending'), 'sendStart añade baro-fx-sending');
  s.BaroFX.sendDone();
  ok(!s._sendButton.classList.contains('baro-fx-sending'), 'sendDone la retira');
  // auto-fin al llegar respuesta de Baro
  s.BaroFX.sendStart();
  const b = makeEl('div', 'baro-bubble-baro');
  s.BaroFX._onMutations([{ addedNodes: [b] }]);
  ok(!s._sendButton.classList.contains('baro-fx-sending'),
    'al llegar burbuja Baro termina el morph automáticamente');
})();

(function () {
  const s = loadBaroFX({ reduced: true });
  s.BaroFX.sendStart();
  ok(!s._sendButton.classList.contains('baro-fx-sending'),
    'con reduced-motion no hay morph de envío');
  s.BaroFX.sendDone();
})();

/* ---------- 7. skeleton ---------- */
(function () {
  const s = loadBaroFX();
  const th = s._thread;
  const n0 = th.children.length;
  const sk = s.BaroFX.skeletonOn();
  ok(sk && sk.classList.contains('baro-fx-skel'), 'skeletonOn inserta .baro-fx-skel');
  ok(th.children.length === n0 + 1, 'skeleton se añade al hilo');
  const sk2 = s.BaroFX.skeletonOn();
  ok(sk2 === sk && th.children.length === n0 + 1, 'skeletonOn no duplica');
  s.BaroFX.skeletonOff();
  ok(th.children.length === n0, 'skeletonOff lo retira');
  s.BaroFX.skeletonOff();
  ok(true, 'skeletonOff doble no rompe');
})();

/* ---------- 8. shake ---------- */
(function () {
  const s = loadBaroFX();
  const el = makeEl('div', 'baro-intent-btns');
  s.document._register('x-shake', el);
  ok(s.BaroFX.shake('.baro-intent-btns') === true, 'shake(selector) true');
  ok(el.classList.contains('baro-fx-shake'), 'shake añade la clase');
  el.fire('animationend', {});
  ok(!el.classList.contains('baro-fx-shake'), 'tras animationend se retira');
  ok(s.BaroFX.shake('.no-existe') === false, 'shake sin match → false');
  ok(s.BaroFX.shake(null) === false, 'shake(null) → false');
})();
(function () {
  const s = loadBaroFX({ reduced: true });
  ok(s.BaroFX.shake(makeEl('div', '')) === false, 'con reduced-motion shake → false');
})();

/* ---------- 9. scroll ---------- */
(function () {
  const s = loadBaroFX({ reduced: true });
  s.BaroFX.scrollBottom();
  ok(s._view.scrollTop === s._view.scrollHeight, 'reduced: scroll instantáneo');
})();
(function () {
  const s = loadBaroFX();
  s.BaroFX.scrollBottom();
  ok(s._view._scrolled && s._view._scrolled.behavior === 'smooth',
    'scroll suave con behavior smooth');
})();

/* ---------- 10. empty state ---------- */
(function () {
  const s = loadBaroFX();
  const e = s.BaroFX.emptyOn('<p>Hola</p>');
  ok(e && e.classList.contains('baro-fx-empty'), 'emptyOn crea .baro-fx-empty');
  ok(s._thread.children.includes(e), 'empty vive en el hilo');
  s.BaroFX.emptyOff();
  ok(!s._thread.children.includes(e), 'emptyOff lo retira');
})();

/* ---------- 11. typing delega ---------- */
(function () {
  let added = 0, removed = null;
  const s = loadBaroFX({ preWindow: {
    baroAddTyping: () => 'baro-typing-' + (++added),
    baroRemoveTyping: id => { removed = id; },
  }});
  const id = s.BaroFX.showTyping();
  ok(id === 'baro-typing-1', 'showTyping delega a baroAddTyping');
  ok(s.BaroFX.hideTyping(id) === true && removed === id, 'hideTyping delega a baroRemoveTyping');
})();
(function () {
  const s = loadBaroFX();
  ok(s.BaroFX.showTyping() === null, 'showTyping sin baroAddTyping → null sin romper');
  ok(s.BaroFX.hideTyping('x') === false, 'hideTyping sin baroRemoveTyping → false');
})();

/* ---------- 12. envolturas idempotentes ---------- */
(function () {
  let calls = 0;
  const orig = function () { calls++; return 'o'; };
  const s = loadBaroFX({ preWindow: { baroOpenView: orig } });
  // init ya corrió al cargar (readyState complete); forzar otra vez
  s.BaroFX.init(); s.BaroFX.init();
  ok(s.window.baroOpenView !== orig && s.window.baroOpenView.__baroFx === true,
    'baroOpenView envuelta con guarda __baroFx');
  s.window.baroOpenView();
  ok(calls === 1, 'la original se invoca una sola vez (sin doble envoltura)');
})();

/* ---------- 13. panel open/close ---------- */
(function () {
  const s = loadBaroFX();
  const v = s._view;
  ok(v.classList.contains('hidden'), 'vista parte oculta');
  s.BaroFX.animatePanel(true);
  ok(!v.classList.contains('hidden') && v.classList.contains('baro-fx-enter'),
    'open: quita hidden y aplica estado inicial');
  s.flushRaf();
  ok(v.classList.contains('baro-fx-enter-active'), 'open: activa la transición');
  v.fire('transitionend', { target: v });
  ok(!v.classList.contains('baro-fx-enter'), 'open: limpia clases al terminar');
})();

/* ---------- 14. higiene del entregable ---------- */
(function () {
  const src = BAROFX_JS;
  ok(!/<\/script/i.test(src), 'baro-fx.js sin literal </script');
  const adds = [...src.matchAll(/classList\.(?:add|remove|toggle)\(([^)]*)\)/g)]
    .flatMap(m => [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]))
    .flatMap(c => c.split(/\s+/));
  const bad = adds.filter(c => c && !c.startsWith('baro-fx-') && c !== 'hidden');
  ok(bad.length === 0, 'JS solo toca clases baro-fx-* (+hidden del panel)' +
    (bad.length ? ' — malas: ' + bad.join(',') : ''));
  ok(!/\b(tw-|flex|grid|hidden!|!important)/.test(src.replace(/baro-fx-/g, '')),
    'JS sin clases Tailwind');
})();

(function () {
  const raw = BAROFX_CSS;
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, ''); // sin comentarios (el ancla cita selectores)
  const allow = new Set(['baro-typing', 'baro-v7-chip', 'baro-intent-btn',
    'baro-action-btn', 'baro-confirm-actions']);
  const ids = new Set(['baro-view', 'baro-input', 'baro-form']);
  const classes = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));
  const badCls = [...classes].filter(c => !c.startsWith('baro-fx-') && !allow.has(c));
  const foundIds = new Set([...css.matchAll(/#([a-zA-Z_][\w-]*)/g)]
    .map(m => m[1])
    .filter(i => !/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(i))); // fuera hex
  const badIds = [...foundIds].filter(i => !ids.has(i));
  ok(badCls.length === 0, 'CSS: clases nuevas solo baro-fx-* (o existentes permitidas)' +
    (badCls.length ? ' — malas: ' + badCls.join(',') : ''));
  ok(badIds.length === 0, 'CSS: sin IDs nuevos' +
    (badIds.length ? ' — malos: ' + badIds.join(',') : ''));
  // Keyframes: solo transform/opacity en sus declaraciones.
  const kfBad = [];
  const kfRe = /@keyframes\s+([\w-]+)\s*\{/g;
  let km;
  while ((km = kfRe.exec(css))) {
    let depth = 1, i = kfRe.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    const body = css.slice(kfRe.lastIndex, i - 1);
    [...body.matchAll(/([a-z-]+)\s*:/g)].forEach(dm => {
      if (!/^(transform|opacity)$/.test(dm[1])) kfBad.push(km[1] + ':' + dm[1]);
    });
  }
  ok(kfBad.length === 0, 'keyframes solo con transform/opacity' +
    (kfBad.length ? ' — malos: ' + kfBad.join(',') : ''));
  // transition: solo transform/opacity (+box-shadow/border-color del glow de foco,
  // excepción documentada en CHANGES.md: transición de estado 200ms, sin layout).
  const trBad = [];
  [...css.matchAll(/transition\s*:\s*([^;}{]+)/g)].forEach(m => {
    m[1].replace(/\([^)]*\)/g, '').split(',').forEach(part => { // sin funciones (bezier)
      const prop = part.trim().split(/\s+/)[0];
      if (prop && !/^(opacity|transform|box-shadow|border-color)$/.test(prop)) trBad.push(prop);
    });
  });
  // Excluir la media query reduced-motion (transition: none) ya cubierta arriba.
  ok(trBad.filter(p => p !== 'none').length === 0, 'transiciones solo transform/opacity (+glow)' +
    (trBad.length ? ' — malas: ' + [...new Set(trBad)].join(',') : ''));
})();

console.log('\n' + pass + ' ok, ' + fail + ' fallos');
process.exit(fail ? 1 : 0);
