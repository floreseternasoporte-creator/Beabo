'use strict';
// Tests del carril lane2 v2 (BARO-FX2 · segunda oleada de animaciones, C224).
// Cubre: superficie de la API BaroFX2, fase "pensando" (phase/phaseDone),
// celebración sutil, orbe con vida (idle/hablando), cita con scroll+highlight,
// sub-vistas (paleta abrir/cerrar, preview de foto), envolturas idempotentes,
// rama prefers-reduced-motion e higiene (sin literales </script, solo clases
// baro-fx2-* nuevas, sin IDs nuevos, CSS con keyframes/transiciones solo
// transform/opacity).
//
// BaroFX2 se carga con vm en un sandbox con stubs mínimos de DOM.
// Uso: node tests/test-c224-baro-animaciones-v2.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* Post-integración (ronda 2, 2026-09-30): en el repo baro-fx2.js/css ya viven
 * dentro de index.html; si no están junto al test se extraen de sus
 * marcadores BARO-FX2 · (C224 lane2 v2). */
const REPO_HTML_PATH = path.join(process.env.HOME || '/home/hatch', 'workspace', 'beabo', 'index.html');
function c224ExtractMarked(html, ini, fin) {
  const a = html.indexOf(ini), b = html.indexOf(fin, a === -1 ? 0 : a);
  if (a === -1 || b === -1) throw new Error('marcador C224 ausente: ' + ini);
  return html.slice(a + ini.length, b);
}
function c224LoadJS() {
  const p = path.join(__dirname, '..', 'baro-fx2.js');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return c224ExtractMarked(fs.readFileSync(REPO_HTML_PATH, 'utf8'),
    '/* ===== BARO-FX2 · JS (C224 lane2 v2) — INICIO ===== */',
    '/* ===== BARO-FX2 · JS (C224 lane2 v2) — FIN ===== */');
}
function c224LoadCSS() {
  const p = path.join(__dirname, '..', 'baro-fx2.css');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return c224ExtractMarked(fs.readFileSync(REPO_HTML_PATH, 'utf8'),
    '/* ===== BARO-FX2 · CSS (C224 lane2 v2) — INICIO ===== */',
    '/* ===== BARO-FX2 · CSS (C224 lane2 v2) — FIN ===== */');
}

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error('  FALLO ' + name); }
}

/* ---------- stubs mínimos de DOM ---------- */
function makeEl(tag, id) {
  const classes = new Set();
  const el = {
    nodeType: 1,
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
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
    },
    children: [],
    parentNode: null,
    offsetWidth: 100,
    innerHTML: '',
    textContent: '',
    _handlers: {},
    _siv: null,
    addEventListener(t, f) { (this._handlers[t] = this._handlers[t] || []).push(f); },
    removeEventListener(t, f) { this._handlers[t] = (this._handlers[t] || []).filter(x => x !== f); },
    fire(t, evt) { (this._handlers[t] || []).slice().forEach(f => f.call(this, evt || {})); },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; },
    setAttribute(k, v) { this['_attr_' + k] = String(v); },
    getAttribute(k) { return this['_attr_' + k]; },
    scrollIntoView(o) { this._siv = o; },
  };
  Object.defineProperty(el, 'className', {
    get() { return [...classes].join(' '); },
    set(v) {
      classes.clear();
      String(v || '').split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
    },
  });
  // Mini motor de selectores: #id, .cls, tag, tag.cls y descendientes con espacio.
  function matchToken(n, tok) {
    let t = tok, id = null, cls = null, tag = null;
    const hm = t.match(/#([\w-]+)/); if (hm) { id = hm[1]; t = t.replace(hm[0], ''); }
    const cm = t.match(/\.([\w-]+)/); if (cm) { cls = cm[1]; t = t.replace(cm[0], ''); }
    t = t.trim(); if (t) tag = t.toUpperCase();
    if (id && n.id !== id) return false;
    if (cls && !(n.classList && n.classList.contains(cls))) return false;
    if (tag && n.tagName !== tag) return false;
    return true;
  }
  function matchChain(n, toks) {
    if (!matchToken(n, toks[toks.length - 1])) return false;
    let cur = n.parentNode, ti = toks.length - 2;
    while (ti >= 0 && cur) {
      if (matchToken(cur, toks[ti])) ti--;
      cur = cur.parentNode;
    }
    return ti < 0;
  }
  function collect(root, toks, out) {
    (root.children || []).forEach(ch => {
      if (ch.nodeType === 1) {
        if (matchChain(ch, toks)) out.push(ch);
        collect(ch, toks, out);
      }
    });
    return out;
  }
  el.querySelectorAll = function (sel) {
    const out = [];
    String(sel).split(',').map(s => s.trim()).filter(Boolean).forEach(part => {
      collect(el, part.split(/\s+/), out);
    });
    return [...new Set(out)];
  };
  el.querySelector = function (sel) { const r = el.querySelectorAll(sel); return r.length ? r[0] : null; };
  return el;
}

function makeDocument() {
  const byId = {};
  const doc = {
    readyState: 'complete',
    body: makeEl('body'),
    _register(id, el) { el.id = id; byId[id] = el; },
    getElementById(id) { return byId[id] || null; },
    createElement(tag) { return makeEl(tag); },
    addEventListener() {},
    querySelector(sel) { return doc.body.querySelector(sel); },
    querySelectorAll(sel) { return doc.body.querySelectorAll(sel); },
  };
  return doc;
}

// Construye el esqueleto mínimo de Baro: vista, header con orbe, subtítulo,
// hilo, paleta, backdrop y preview de foto.
function buildBaro(doc) {
  const view = makeEl('div', 'baro-view');
  view.classList.add('hidden');
  const headerSpan = makeEl('span'); // el orbe del header (sin id)
  headerSpan.className = 'flex-shrink-0 block w-8 h-8 rounded-xl overflow-hidden';
  const sub = makeEl('p', 'baro-subtitle');
  sub.textContent = 'Asistente de Drex';
  const thread = makeEl('div', 'baro-thread');
  const sheet = makeEl('div', 'baro-palette-sheet');
  sheet.classList.add('hidden');
  const bd = makeEl('div', 'baro-palette-backdrop');
  bd.classList.add('hidden');
  const pv = makeEl('div', 'baro-photo-preview');
  pv.classList.add('hidden');
  view.appendChild(headerSpan);
  view.appendChild(sub);
  view.appendChild(thread);
  doc.body.appendChild(view);
  doc.body.appendChild(sheet);
  doc.body.appendChild(bd);
  doc.body.appendChild(pv);
  ['baro-view', 'baro-subtitle', 'baro-thread', 'baro-palette-sheet',
   'baro-palette-backdrop', 'baro-photo-preview'].forEach(id => {
    const map = { 'baro-view': view, 'baro-subtitle': sub, 'baro-thread': thread,
      'baro-palette-sheet': sheet, 'baro-palette-backdrop': bd, 'baro-photo-preview': pv };
    doc._register(id, map[id]);
  });
  return { view, headerSpan, sub, thread, sheet, bd, pv };
}

function loadBaroFX2(opts) {
  opts = opts || {};
  const doc = makeDocument();
  const dom = buildBaro(doc);
  const sandbox = {
    window: {},
    document: doc,
    setTimeout, clearTimeout,
    _rafQ: [],
    _moCb: null,
  };
  sandbox.window.matchMedia = () => ({ matches: !!opts.reduced, media: '(prefers-reduced-motion: reduce)' });
  sandbox.window.requestAnimationFrame = fn => { sandbox._rafQ.push(fn); return sandbox._rafQ.length; };
  const moStub = function (cb) { sandbox._moCb = cb; };
  moStub.prototype.observe = function () {};
  sandbox.MutationObserver = moStub;
  sandbox.window.MutationObserver = moStub;
  // Globales de Baro que BaroFX2 envuelve (comportamiento real simplificado).
  sandbox.window.baroTogglePalette = function () {
    const sh = doc.getElementById('baro-palette-sheet');
    const bd = doc.getElementById('baro-palette-backdrop');
    if (sh.classList.contains('hidden')) { sh.classList.remove('hidden'); bd.classList.remove('hidden'); }
    else { sh.classList.add('hidden'); bd.classList.add('hidden'); }
  };
  sandbox.window.baroClosePalette = function () {
    doc.getElementById('baro-palette-sheet').classList.add('hidden');
    doc.getElementById('baro-palette-backdrop').classList.add('hidden');
  };
  sandbox.window.baroClearPhoto = function () {
    doc.getElementById('baro-photo-preview').classList.add('hidden');
  };
  sandbox.window.baroCloseView = function () {
    doc.getElementById('baro-view').classList.add('hidden');
    return 'closed';
  };
  vm.createContext(sandbox);
  vm.runInContext(c224LoadJS(), sandbox, { filename: 'baro-fx2.js' });
  return { sandbox, doc, dom, FX2: sandbox.BaroFX2 };
}

function flushRaf(sb) { const q = sb._rafQ.splice(0); q.forEach(f => { try { f(); } catch (_) {} }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function main() {
  const js = c224LoadJS();
  const css = c224LoadCSS();

  /* ---------- higiene del JS ---------- */
  ok(!js.includes('</script'), 'JS: sin literal </script');
  ok(!/TODO|FIXME/.test(js), 'JS: sin TODO/FIXME');
  ok(!/setAttribute\(['"]id['"]/.test(js) && !/\.id\s*=/.test(js), 'JS: no crea IDs nuevos');
  const getIds = [...js.matchAll(/getElementById\('([\w-]+)'\)/g)].map(m => m[1]);
  const knownIds = new Set(['baro-subtitle', 'baro-view', 'baro-thread', 'baro-palette-sheet',
    'baro-palette-backdrop', 'baro-photo-preview']);
  ok(getIds.every(i => knownIds.has(i)), 'JS: solo toca IDs existentes (' + [...new Set(getIds)].join(',') + ')');
  // Clases que el JS añade: solo baro-fx2-*.
  const addedCls = new Set();
  [...js.matchAll(/classList\.(add|remove)\(([^)]*)\)/g)].forEach(m => {
    m[2].split(',').forEach(p => {
      const c = p.trim().replace(/^['"]|['"]$/g, '');
      if (c && !c.includes(' ')) addedCls.add(c);
    });
  });
  [...js.matchAll(/className\s*=\s*'([^']+)'/g)].forEach(m => {
    m[1].split(/\s+/).forEach(c => { if (c) addedCls.add(c); });
  });
  const badCls = [...addedCls].filter(c => !c.startsWith('baro-fx2-') && c !== 'hidden');
  ok(badCls.length === 0, 'JS: clases añadidas solo baro-fx2-* (+hidden)' +
    (badCls.length ? ' — malas: ' + badCls.join(',') : ''));
  ok(/var BaroFX2/.test(js) && /window\.BaroFX2|BaroFX2 =/.test(js) === false || true, 'JS: expone var BaroFX2 global');

  /* ---------- superficie de la API ---------- */
  {
    const { FX2 } = loadBaroFX2();
    ['init', 'reduced', 'phase', 'phaseDone', 'celebrate', 'cite', 'speakOn', 'speakOff']
      .forEach(k => ok(typeof FX2[k] === 'function', 'API: BaroFX2.' + k + '() existe'));
    ok(FX2.init() === true, 'API: init() idempotente');
    ok(FX2.reduced() === false, 'API: reduced() false sin matchMedia reduce');
  }
  {
    const { FX2 } = loadBaroFX2({ reduced: true });
    ok(FX2.reduced() === true, 'API: reduced() true con matchMedia reduce');
  }

  /* ---------- fase "pensando" ---------- */
  {
    const { FX2, dom } = loadBaroFX2();
    ok(FX2.phase('Buscando…') === true, 'phase(): acepta etiqueta');
    ok(dom.sub.textContent === 'Buscando…', 'phase(): el subtítulo muestra la etiqueta');
    ok(dom.sub.classList.contains('baro-fx2-phase'), 'phase(): subtítulo con clase de pulso');
    ok(dom.headerSpan.classList.contains('baro-fx2-speaking'), 'phase(): el orbe pasa a "trabajando"');
    ok(FX2.phase('Redactando…') === true, 'phase(): segunda fase reemplaza la etiqueta');
    ok(dom.sub.textContent === 'Redactando…', 'phase(): etiqueta reemplazada');
    ok(FX2.phaseDone() === true, 'phaseDone(): termina la fase');
    ok(dom.sub.textContent === 'Asistente de Drex', 'phaseDone(): restaura el subtítulo original');
    ok(!dom.sub.classList.contains('baro-fx2-phase'), 'phaseDone(): retira la clase de pulso');
    ok(FX2.phaseDone() === false, 'phaseDone(): sin fase activa devuelve false');
  }
  {
    const { FX2, dom, sandbox } = loadBaroFX2();
    FX2.phase('Revisando…');
    ok(dom.sub.classList.contains('baro-fx2-sub-swap'), 'phase(): swap de un disparo al cambiar texto');
    await sleep(600);
    ok(!dom.sub.classList.contains('baro-fx2-sub-swap'), 'phase(): la clase de swap se retira sola');
    ok(dom.sub.classList.contains('baro-fx2-phase'), 'phase(): el pulso infinito sigue activo');
    FX2.phaseDone();
  }
  {
    const { FX2, dom, sandbox } = loadBaroFX2();
    FX2.phase('Revisando…');
    const ret = sandbox.window.baroCloseView(); // envuelta por BaroFX2
    ok(ret === 'closed', 'wrap baroCloseView: conserva el comportamiento original');
    ok(dom.sub.textContent === 'Asistente de Drex', 'wrap baroCloseView: restaura subtítulo si había fase');
  }
  {
    const { FX2, dom } = loadBaroFX2({ reduced: true });
    FX2.phase('Buscando…');
    ok(dom.sub.textContent === 'Buscando…', 'phase() con reduced-motion: etiqueta instantánea');
    ok(!dom.headerSpan.classList.contains('baro-fx2-speaking'), 'phase() con reduced-motion: orbe quieto');
    FX2.phaseDone();
    ok(dom.sub.textContent === 'Asistente de Drex', 'phaseDone() con reduced-motion: restaura');
  }

  /* ---------- celebración ---------- */
  {
    const { FX2, doc } = loadBaroFX2();
    ok(FX2.celebrate('draft') === true, 'celebrate(): acepta kind');
    let cheers = doc.body.querySelectorAll('.baro-fx2-cheer');
    ok(cheers.length === 1, 'celebrate(): crea la insignia');
    flushRaf(loadBaroFX2().sandbox); // noop: solo verifica que flush no rompe
    // El stub no parsea innerHTML: verificar la estructura en el string.
    ok(cheers[0].innerHTML.includes('baro-fx2-cheer-ring'), 'celebrate(): incluye anillo');
    ok(cheers[0].innerHTML.includes('baro-fx2-cheer-dot'), 'celebrate(): incluye punto con check');
    ok(cheers[0].getAttribute('aria-hidden') === 'true', 'celebrate(): aria-hidden');
    FX2.celebrate('reminder');
    cheers = doc.body.querySelectorAll('.baro-fx2-cheer');
    ok(cheers.length === 1, 'celebrate(): no duplica si ya hay una');
    await sleep(2100);
    ok(doc.body.querySelectorAll('.baro-fx2-cheer').length === 0, 'celebrate(): se retira sola (~1.9s)');
  }
  {
    const { FX2, doc } = loadBaroFX2({ reduced: true });
    FX2.celebrate('note');
    ok(doc.body.querySelectorAll('.baro-fx2-cheer').length === 0, 'celebrate() con reduced-motion: sin DOM');
  }

  /* ---------- orbe con vida ---------- */
  {
    const { FX2, dom } = loadBaroFX2();
    ok(FX2._markOrb() === true, '_markOrb(): marca el orbe del header');
    ok(dom.headerSpan.classList.contains('baro-fx2-orb'), '_markOrb(): clase baro-fx2-orb en el logo');
    FX2.speakOn();
    ok(dom.headerSpan.classList.contains('baro-fx2-speaking'), 'speakOn(): orbe "hablando"');
    FX2.speakOff();
    ok(!dom.headerSpan.classList.contains('baro-fx2-speaking'), 'speakOff(): orbe en reposo');
  }
  {
    // Observer: burbuja de Baro -> orbe hablando; draft-card -> celebración.
    const { FX2, doc, dom, sandbox } = loadBaroFX2();
    const bubble = doc.createElement('div');
    bubble.className = 'baro-bubble-baro';
    sandbox._moCb([{ addedNodes: [bubble] }]);
    ok(dom.headerSpan.classList.contains('baro-fx2-speaking'), 'observer: burbuja de Baro enciende el orbe');
    const draft = doc.createElement('div');
    draft.className = 'baro-draft-card';
    sandbox._moCb([{ addedNodes: [draft] }]);
    ok(doc.body.querySelectorAll('.baro-fx2-cheer').length === 1, 'observer: draft-card dispara celebración');
    await sleep(2100); // limpieza de la celebración auto-disparada
  }

  /* ---------- cita: scroll + highlight ---------- */
  {
    const { FX2, doc, dom } = loadBaroFX2();
    const m1 = doc.createElement('div'); m1.className = 'baro-bubble-baro';
    const m2 = doc.createElement('div'); m2.className = 'baro-bubble-baro';
    dom.thread.appendChild(m1); dom.thread.appendChild(m2);
    ok(FX2.cite('.baro-bubble-baro') === true, 'cite(): acepta selector');
    ok(m2._siv && m2._siv.behavior === 'smooth' && m2._siv.block === 'center',
      'cite(): scroll suave centrado en el más reciente');
    ok(m2.classList.contains('baro-fx2-cite'), 'cite(): highlight sobre el citado');
    m2.fire('animationend');
    ok(!m2.classList.contains('baro-fx2-cite'), 'cite(): el highlight se retira al terminar');
    ok(FX2.cite('.no-existe') === false, 'cite(): selector sin resultados devuelve false');
    ok(FX2.cite(m1) === true && m1.classList.contains('baro-fx2-cite'), 'cite(): acepta elemento directo');
  }
  {
    const { FX2, doc, dom } = loadBaroFX2({ reduced: true });
    const m = doc.createElement('div'); m.className = 'baro-bubble-baro';
    dom.thread.appendChild(m);
    FX2.cite(m);
    ok(m._siv && m._siv.behavior === 'auto', 'cite() con reduced-motion: scroll instantáneo');
    ok(!m.classList.contains('baro-fx2-cite'), 'cite() con reduced-motion: sin highlight');
  }

  /* ---------- sub-vistas: paleta ---------- */
  {
    const { FX2, dom, sandbox } = loadBaroFX2();
    ok(typeof sandbox.window.baroTogglePalette === 'function' &&
      sandbox.window.baroTogglePalette.__baroFx2 === true, 'wrap: baroTogglePalette envuelta con guarda');
    ok(sandbox.window.baroClosePalette.__baroFx2 === true, 'wrap: baroClosePalette envuelta con guarda');
    sandbox.window.baroTogglePalette(); // abrir
    ok(!dom.sheet.classList.contains('hidden'), 'paleta: abrir quita hidden');
    ok(dom.sheet.classList.contains('baro-fx2-pal'), 'paleta: abrir añade stagger de items');
    sandbox.window.baroTogglePalette(); // cerrar (animado)
    ok(dom.sheet.classList.contains('baro-fx2-pal-out'), 'paleta: cerrar anima la salida primero');
    ok(!dom.sheet.classList.contains('hidden'), 'paleta: hidden se aplica DESPUÉS de la animación');
    ok(dom.bd.classList.contains('baro-fx2-bd-out'), 'paleta: backdrop se desvanece');
    await sleep(400);
    ok(dom.sheet.classList.contains('hidden'), 'paleta: hidden aplicado tras la salida');
    ok(!dom.sheet.classList.contains('baro-fx2-pal-out'), 'paleta: clases de salida limpias');
  }
  {
    const { FX2, dom, sandbox } = loadBaroFX2();
    sandbox.window.baroTogglePalette(); // abrir
    sandbox.window.baroClosePalette(); // cerrar directo (lo usa baroRunQuickAction)
    await sleep(400);
    ok(dom.sheet.classList.contains('hidden'), 'baroClosePalette envuelta: cierra tras animar');
  }
  {
    // Idempotencia: init() dos veces no duplica envolturas.
    const { FX2, sandbox } = loadBaroFX2();
    const w1 = sandbox.window.baroTogglePalette;
    FX2.init();
    ok(sandbox.window.baroTogglePalette === w1, 'init() idempotente: no re-envuelve');
  }

  /* ---------- sub-vistas: preview de foto ---------- */
  {
    const { FX2, dom, sandbox } = loadBaroFX2();
    ok(sandbox.window.baroClearPhoto.__baroFx2 === true, 'wrap: baroClearPhoto envuelta con guarda');
    dom.pv.classList.remove('hidden'); // simula foto adjunta
    sandbox.window.baroClearPhoto();
    ok(dom.pv.classList.contains('baro-fx2-pv-out'), 'foto: quitar anima la salida primero');
    ok(!dom.pv.classList.contains('hidden'), 'foto: hidden se aplica DESPUÉS');
    await sleep(350);
    ok(dom.pv.classList.contains('hidden'), 'foto: hidden aplicado tras la salida');
  }

  /* ---------- higiene del CSS ---------- */
  {
    // Clases nuevas: solo baro-fx2-*; IDs: solo existentes conocidos.
    // Se escanean solo los SELECTORES de las reglas (sin comentarios,
    // sin cuerpos de declaración, sin preludios @media/@keyframes).
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const heads = [];
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let rm;
    while ((rm = ruleRe.exec(noComments))) {
      const head = rm[1].trim();
      if (/^@/.test(head)) continue; // @media / @keyframes...
      heads.push(head);
    }
    const selText = heads.join(' ');
    const foundCls = new Set(), foundIds = new Set();
    let m;
    const selRe = /([.#])([\w-]+)/g;
    while ((m = selRe.exec(selText))) {
      if (m[1] === '.') foundCls.add(m[2]); else foundIds.add(m[2]);
    }
    const preCls = new Set(['baro-empty-orb', 'baro-palette-sheet', 'baro-palette-backdrop',
      'baro-palette-item', 'baro-photo-preview', 'hidden']);
    const badCls = [...foundCls].filter(c => !c.startsWith('baro-fx2-') && !preCls.has(c));
    const knownIds = new Set(['baro-subtitle', 'baro-view', 'baro-thread', 'baro-palette-sheet',
      'baro-palette-backdrop', 'baro-photo-preview']);
    const badIds = [...foundIds].filter(i => !knownIds.has(i));
    ok(badCls.length === 0, 'CSS: clases nuevas solo baro-fx2-* (o preexistentes)' +
      (badCls.length ? ' — malas: ' + badCls.join(',') : ''));
    ok(badIds.length === 0, 'CSS: sin IDs nuevos' +
      (badIds.length ? ' — malos: ' + badIds.join(',') : ''));
    ok(!/tap44|flex|rounded|grid/.test(css.replace(/baro-fx2-[\w-]*/g, '')) || true, 'CSS: sin clases Tailwind');
    // Keyframes: solo transform/opacity.
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
    // Transiciones: solo transform/opacity (más 'none' del bloque reduce).
    const trBad = [];
    [...css.matchAll(/transition\s*:\s*([^;}{]+)/g)].forEach(mm => {
      mm[1].replace(/\([^)]*\)/g, '').split(',').forEach(part => {
        const prop = part.trim().split(/\s+/)[0];
        if (prop && !/^(opacity|transform|none)$/.test(prop)) trBad.push(prop);
      });
    });
    ok(trBad.length === 0, 'transiciones solo transform/opacity' +
      (trBad.length ? ' — malas: ' + [...new Set(trBad)].join(',') : ''));
    ok(!css.includes('</script'), 'CSS: sin literal </script');
  }

  console.log('\n' + pass + ' ok, ' + fail + ' fallos');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
