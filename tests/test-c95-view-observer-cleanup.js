'use strict';
// Tests de LIMPIEZA DEL OBSERVER DE VISTAS (Ciclo 95).
// Uso: node test-c95-view-observer-cleanup.js [--target <html>]
//   --target: HTML a probar (default: ../index.html, el parcheado).
// Diseñados para FALLAR contra la base sin parche.
//
// Problema (lead de rendimiento medido): `_drexViewObserver` (C89) es GLOBAL
// pero los feeds se re-montan por generación/tab (`_subscribeNotesFeed`):
// cada cambio de tab / re-montaje dejaba las tarjetas desmontadas observadas
// PARA SIEMPRE (nunca `unobserve`), reteniendo nodos DOM muertos en el
// observer durante toda la sesión. El entry final de desconexión llega con
// isIntersecting=false y target.isConnected=false: el parche libera el
// target ahí.
//
// Verifica:
//  (a) núcleo real extraído verbatim (bloques C89 + C92) en sandbox con un
//      IntersectionObserver falso: observar 1 tarjeta, desmontarla y
//      disparar su entry de desconexión → el target queda liberado;
//  (b) 3 tarjetas (simula cambio de tab) → las 3 se liberan;
//  (c) sin regresión: una tarjeta conectada NO se libera por el entry de
//      otra; una tarjeta re-montada (nuevo elemento, mismo noteId) se vuelve
//      a observar;
//  (d) integración estática: el hook vive dentro de `_drexViewEnsureObserver`
//      y no toca el dwell C89 (regex T7h/T7l del test viejo siguen pasando).
//
// Convención del repo: resuelve ../index.html con fallback a ../src/index.html;
// no depende del historial de git; sin rutas absolutas.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const target = (() => {
  const i = process.argv.indexOf('--target');
  return i >= 0 && process.argv[i + 1]
    ? path.resolve(process.argv[i + 1])
    : path.resolve(__dirname, '..', 'index.html');
})();

const html = fs.readFileSync(target, 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); }
}
function eq(a, b, name) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  ok(sa === sb, name + ' (got ' + sa + ', want ' + sb + ')');
}
function tcase(name, fn) {
  try { fn(); } catch (e) { ok(false, name + ' (throw: ' + e.message + ')'); }
}

// ---- extracción de bloques por marcadores ----
function extractBlock(src, start, end) {
  const si = src.indexOf(start);
  const ei = src.indexOf(end, si);
  if (si === -1 || ei === -1) throw new Error('bloque no encontrado: ' + start);
  return src.slice(si, ei + end.length);
}

// ---- sandbox con IntersectionObserver falso ----
function makeWorld() {
  const targets = [];
  let cb = null;
  function FakeIO(callback) {
    cb = callback;
    this.observe = function (el) { if (targets.indexOf(el) === -1) targets.push(el); };
    this.unobserve = function (el) {
      const i = targets.indexOf(el);
      if (i !== -1) targets.splice(i, 1);
    };
    this.disconnect = function () { targets.length = 0; };
  }
  function fakeEl(noteId) {
    return {
      dataset: { noteId: noteId },
      id: 'post-' + noteId,
      isConnected: true,
      querySelector: function () { return null; }
    };
  }
  const sandbox = {
    console: console,
    IntersectionObserver: FakeIO,
    PULSO_DAYS: 7,
    DrexCloud: {
      auth: function () { return { currentUser: { uid: 'u1' } }; },
      database: function () { throw new Error('DB no debe tocarse en este test'); }
    },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  };
  vm.createContext(sandbox);
  const code89 = extractBlock(html,
    '// ============ VISTAS DE PULSO (C89',
    '// ============ /VISTAS DE PULSO ============');
  const code92 = extractBlock(html,
    '// ============ RETENCIÓN DE PULSO (C92',
    '// ============ /RETENCIÓN DE PULSO ============');
  try {
    vm.runInContext(code89 + '\n' + code92, sandbox, { filename: 'c89-c92-blocks.js' });
  } catch (e) {
    return { error: e };
  }
  return {
    sb: sandbox,
    targets: targets,
    fire: function (entries) { cb(entries); },
    el: fakeEl
  };
}

let W = null;
tcase('T0 el mundo se construye', () => {
  W = makeWorld();
  ok(!W.error, 'bloques C89+C92 cargan en sandbox' + (W.error ? ' (' + W.error.message + ')' : ''));
  ok(typeof W.sb.drexViewWatchEl === 'function', 'drexViewWatchEl exportada');
  ok(typeof W.sb._drexViewEnsureObserver === 'function', '_drexViewEnsureObserver exportada');
});

// ---- (a) una tarjeta desmontada se libera ----
tcase('T1 una tarjeta desmontada se libera del observer', () => {
  W = makeWorld();
  const el = W.el('n1');
  W.sb.drexViewWatchEl(el, 'n1');
  eq(W.targets.length, 1, 'T1a la tarjeta queda observada');
  el.isConnected = false; // el feed se re-montó: el nodo viejo sale del DOM
  W.fire([{ target: el, isIntersecting: false, intersectionRatio: 0 }]);
  eq(W.targets.length, 0, 'T1b el target desmontado se libera (unobserve)');
});

// ---- (b) cambio de tab: 3 tarjetas se liberan ----
tcase('T2 tres tarjetas desmontadas se liberan (cambio de tab)', () => {
  W = makeWorld();
  const els = [W.el('a'), W.el('b'), W.el('c')];
  els.forEach((el, i) => W.sb.drexViewWatchEl(el, 'id' + i));
  eq(W.targets.length, 3, 'T2a 3 tarjetas observadas');
  els.forEach((el) => { el.isConnected = false; });
  W.fire(els.map((el) => ({ target: el, isIntersecting: false, intersectionRatio: 0 })));
  eq(W.targets.length, 0, 'T2b las 3 se liberan (sin leak acumulado)');
});

// ---- (c) sin regresión ----
tcase('T3 sin regresión: conectadas no se tocan, re-montaje se re-observa', () => {
  W = makeWorld();
  const elA = W.el('x');
  const elB = W.el('y');
  W.sb.drexViewWatchEl(elA, 'x');
  W.sb.drexViewWatchEl(elB, 'y');
  eq(W.targets.length, 2, 'T3a 2 observadas');
  // Se desmonta solo A: B sigue conectada y observada.
  elA.isConnected = false;
  W.fire([{ target: elA, isIntersecting: false, intersectionRatio: 0 }]);
  eq(W.targets.length, 1, 'T3b solo A se libera');
  ok(W.targets[0] === elB, 'T3c la que queda es B');
  // Re-montaje: un NUEVO elemento con el mismo noteId se vuelve a observar
  // (el flag drexViewWatched es por elemento, no por noteId).
  const elA2 = W.el('x');
  W.sb.drexViewWatchEl(elA2, 'x');
  eq(W.targets.length, 2, 'T3d la tarjeta re-montada se observa de nuevo');
  ok(W.targets.indexOf(elA) === -1, 'T3e el nodo muerto no vuelve');
});

// ---- (d) integración estática: el hook vive en el observer y no rompe C89/C92 ----
tcase('T4 integración estática', () => {
  const sec = extractBlock(html,
    '// ============ VISTAS DE PULSO (C89',
    '// ============ /VISTAS DE PULSO ============');
  ok(sec.indexOf('isConnected') !== -1, 'T4a el bloque C89 conoce isConnected (hook C95)');
  ok(sec.indexOf('_drexViewObserver.unobserve') !== -1 || sec.indexOf('.unobserve(en.target)') !== -1,
    'T4b el hook libera el target');
  // Invariantes viejos intactos (T7h/T7l del test C92, T9d del C89).
  ok(/delete _drexViewTimers\[id\];\s*drexViewRecord\(id\);\s*try \{ drexRetainArm\(id\); \} catch/.test(html),
    'T4c dwell C89+C92 intacto (T7h)');
  ok(/setTimeout\(function \(\) \{\s*delete _drexViewTimers/.test(html),
    'T4d dwell C89 intacto (T7l/T9d)');
  ok(/_drexViewTimers\[id\] \|\| _drexRetainTimers\[id\]/.test(html),
    'T4e el observer conoce ambos temporizadores (T7j)');
});

console.log('\nC95 view-observer-cleanup: ' + pass + ' pass, ' + fail + ' fail');
if (failures.length) { console.log('FALLOS:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
