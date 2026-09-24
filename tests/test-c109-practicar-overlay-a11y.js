// C109: el composer de Practicar (practicar-composer-overlay, z-[200]) y el
// overlay de idiomas (practicar-lang-overlay, z-[200]) no estaban registrados
// en el sistema central de overlays: el botón Atrás del teléfono y Escape los
// ignoraban (navegaban con el overlay abierto encima) y el Tab escapaba a la
// app detrás. Fix: entradas en _drexOverlayCandidates() + TRAPPABLE (trampa de
// Tab) + _pushOverlayBackGuard() al abrir + SHEET_LABELS (role=dialog). El
// gestor de foco central los cubre por estar en candidatos (pila save/restore).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(__dirname, '..', 'index.html');
let html;
try { html = fs.readFileSync(htmlPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer index.html'); process.exit(1); }

let failures = 0;
function ok(name, cond) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name); }
}
// tcase: las llamadas al núcleo van envueltas en try/catch para que la base
// reporte FAILs limpios en vez de crashear el runner.
function tcase(name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') return r.then(
    () => console.log('ok - ' + name),
    (e) => { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); });
    console.log('ok - ' + name); return Promise.resolve(); }
  catch (e) { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); return Promise.resolve(); }
}

// Extrae una función top-level por balance de llaves.
function extractFn(name) {
  const i = html.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no encontrada: ' + name);
  let j = html.indexOf('{', i), depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}') { depth--; if (!depth) return html.slice(i, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}

// ---------- 1. Estáticos (fallan en base) ----------
ok('candidates: incluye practicar-composer-overlay',
  html.includes("'practicar-composer-overlay', () => typeof closePracticarComposer"));
ok('TRAPPABLE: incluye practicar-composer-overlay',
  html.includes("'practicar-composer-overlay',"));
ok('openPracticarComposer: empuja guard de Atrás',
  /function openPracticarComposer\(\)[\s\S]{0,900}_pushOverlayBackGuard/.test(html));
ok('SHEET_LABELS: practicar-composer-overlay con role=dialog',
  html.includes("'practicar-composer-overlay': 'Nuevo ejercicio'"));
ok('candidates: incluye practicar-lang-overlay',
  html.includes("'practicar-lang-overlay', () => typeof closePracticarLang"));
ok('TRAPPABLE: incluye practicar-lang-overlay',
  (html.match(/'practicar-lang-overlay',/g) || []).length >= 2);
ok('openPracticarLang: empuja guard de Atrás',
  /function openPracticarLang\(\)[\s\S]{0,700}_pushOverlayBackGuard/.test(html));
ok('SHEET_LABELS: practicar-lang-overlay con role=dialog',
  html.includes("'practicar-lang-overlay': 'Configura tus idiomas'"));

// ---------- 2. Conductuales en vm ----------
tcase('topmost: con el composer abierto, Atrás/Esc lo cierran a él', () => {
  const src = extractFn('_drexOverlayCandidates') + '\n'
    + extractFn('_drexIsOverlayOpen') + '\n'
    + extractFn('_drexTopmostOverlay') + '\n'
    + 'this.__top = _drexTopmostOverlay();';
  const els = {
    'comment-actions-sheet': { classList: { contains: (c) => c !== 'active' }, style: {} },
    // El composer está abierto (sin 'hidden').
    'practicar-composer-overlay': { classList: { contains: () => false }, style: {} },
    'share-post-overlay': { classList: { contains: () => true }, style: {} },
  };
  const sandbox = {
    document: { getElementById: (id) => els[id] || null },
    closeCommentActionsSheet: () => 'closed-comment',
    closePracticarComposer: () => 'closed-practicar',
    closeSharePostSheet: () => 'closed-share',
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const top = sandbox.__top;
  if (!top || top.id !== 'practicar-composer-overlay')
    throw new Error('topmost no es el composer: ' + (top && top.id));
  if (typeof top.closeFn !== 'function' || top.closeFn() !== 'closed-practicar')
    throw new Error('closeFn no cierra el composer');
});

tcase('topmost: composer cerrado -> no se reporta como abierto', () => {
  const src = extractFn('_drexOverlayCandidates') + '\n'
    + extractFn('_drexIsOverlayOpen') + '\n'
    + extractFn('_drexTopmostOverlay') + '\n'
    + 'this.__top = _drexTopmostOverlay();';
  const sandbox = {
    document: { getElementById: () => ({ classList: { contains: (c) => c === 'hidden' || c === 'active' }, style: {} }) },
    closeCommentActionsSheet: () => 0, closePracticarComposer: () => 0, closeSharePostSheet: () => 0,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  if (sandbox.__top && sandbox.__top.id === 'practicar-composer-overlay')
    throw new Error('reporta el composer como abierto estando cerrado');
});

tcase('topmost: con solo el overlay de idiomas abierto, lo cierra a él', () => {
  const src = extractFn('_drexOverlayCandidates') + '\n'
    + extractFn('_drexIsOverlayOpen') + '\n'
    + extractFn('_drexTopmostOverlay') + '\n'
    + 'this.__top = _drexTopmostOverlay();';
  const sandbox = {
    document: { getElementById: (id) => id === 'practicar-lang-overlay'
      ? { classList: { contains: () => false }, style: {} }
      : { classList: { contains: (c) => c === 'hidden' }, style: {} } },
    closePracticarComposer: () => 'closed-practicar',
    closePracticarLang: () => 'closed-lang',
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const top = sandbox.__top;
  if (!top || top.id !== 'practicar-lang-overlay')
    throw new Error('topmost no es el overlay de idiomas: ' + (top && top.id));
  if (typeof top.closeFn !== 'function' || top.closeFn() !== 'closed-lang')
    throw new Error('closeFn no cierra el overlay de idiomas');
});

tcase('orden: el composer (z-200) cierra antes que share-post-overlay', () => {
  const src = extractFn('_drexOverlayCandidates') + '\nthis.__ids = _drexOverlayCandidates().map(c => c[0]);';
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const ids = sandbox.__ids;
  const a = ids.indexOf('practicar-composer-overlay');
  const b = ids.indexOf('share-post-overlay');
  if (a < 0) throw new Error('composer no está en candidatos');
  if (!(a < b)) throw new Error('orden incorrecto: composer debe ir antes que share');
});

process.on('exit', () => { if (failures) { console.error(failures + ' FAIL(s)'); process.exitCode = 1; } });
