// CARRIL 3 (2026-10-01) — regresión: gating de Destellos para Drex Orbit.
//
// HALLAZGO: la orden del usuario (2026-09-29) dice que los Destellos son
// EXCLUSIVOS de suscriptores Drex Orbit, pero `drexSnapLoadTray()` hacía
// `tray.classList.remove('hidden')` para CUALQUIER usuario logueado, sin
// ningún chequeo premium. Ni `orbitGate('destellos')` ni 'destellos' en
// ORBIT_FEATURES existían: el gating genérico nunca se aplicó a Destellos.
// Por eso en su iPhone (no premium) se veía la sección completa
// ("No Destellos yet / Take a glimmer" + botón de crear).
//
// Parche (marcas CARRIL 3 en index.html):
//  1. `drexSnapCanView()` — gate fail-closed: true SOLO con suscripción
//     VERIFICADA por el backend (DrexOrbit.verifiedActive()). Sin DrexOrbit,
//     sin estado verificado, con error o con la verificación fallando -> false.
//     No depende del interruptor global DREX_ORBIT_ENFORCE.
//  2. `drexSnapLoadTray()` — sin premium: la sección queda con `hidden`
//     (display:none desde el primer pintado, sin parpadeo) y no toca la DB.
//  3. `drexSnapNew()` — sin premium: abre el paywall de Orbit, no la cámara.
//  4. `drexSnapOpenViewer()` — sin premium: no abre (defensa en profundidad).
//  5. Hook `window.drexOrbitApplyGates` (encadenado) — re-evalúa la bandeja
//     cuando DrexOrbit.refresh() resuelve (login, retorno de Stripe, logout).
//
// Test híbrido: asserts estáticos (fallan en base) + conductuales en sandbox
// vm con DrexOrbit programable (FAIL en base, PASS con parche).
// Uso: node tests/test-destellos-gating.js [--target=html]
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
function tcase(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(
      () => console.log('ok - ' + name),
      (e) => { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); });
    console.log('ok - ' + name); return Promise.resolve();
  } catch (e) { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); return Promise.resolve(); }
}
// Extrae una declaración de función balanceando llaves (mismo patrón que test-c193).
function extractFn(src, declLine) {
  const declIdx = src.indexOf(declLine);
  if (declIdx < 0) throw new Error('declaración no encontrada: ' + declLine);
  let paren = 0, i = src.indexOf('(', declIdx);
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')') { paren--; if (paren === 0) break; }
  }
  const braceIdx = src.indexOf('{', i);
  let depth = 0;
  for (let j = braceIdx; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(declIdx, j + 1); }
  }
  throw new Error('cierre no encontrado: ' + declLine);
}

// ---------- asserts estáticos (fallan en base) ----------
const canViewSrc = extractFn(html, 'function drexSnapCanView()');
const loadTraySrc = extractFn(html, 'async function drexSnapLoadTray()');
const snapNewSrc = extractFn(html, 'function drexSnapNew()');
const openViewerSrc = extractFn(html, 'function drexSnapOpenViewer()');

ok('estático: existe drexSnapCanView (fail-closed)',
  canViewSrc.startsWith('function drexSnapCanView()'));
ok('estático: drexSnapCanView delega en el plan efectivo (C264: pagado verificado o prueba del evento)',
  /DrexOrbit\.effectivePlan\(\) != null/.test(canViewSrc));
ok('estático: drexSnapCanView NO usa isActive() ni hasAccess() (no depende del interruptor global ENFORCE)',
  !/isActive\(\)/.test(canViewSrc) && !/hasAccess\(/.test(canViewSrc));
ok('estático: drexSnapCanView es fail-closed ante DrexOrbit ausente',
  /typeof DrexOrbit\s*===\s*['"]undefined['"]/.test(canViewSrc));
ok('estático: drexSnapCanView es fail-closed ante excepción',
  /catch\s*\(_\)\s*\{\s*return false/.test(canViewSrc));

ok('estático: drexSnapLoadTray gatea la bandeja con drexSnapCanView()',
  /if\s*\(!drexSnapCanView\(\)\)/.test(loadTraySrc));
ok('estático: el gate de la bandeja va ANTES de quitar `hidden`',
  loadTraySrc.indexOf('drexSnapCanView()') < loadTraySrc.indexOf("classList.remove('hidden')"));
ok('estático: sin premium la bandeja se queda oculta (add hidden)',
  /if\s*\(!drexSnapCanView\(\)\)\s*\{\s*tray\.classList\.add\('hidden'\)/.test(loadTraySrc));

ok('estático: drexSnapNew gatea la creación con drexSnapCanView()',
  /if\s*\(!drexSnapCanView\(\)\)/.test(snapNewSrc));
ok('estático: sin premium, crear destello abre el paywall de Orbit',
  /openOrbitPaywall\('destellos'\)/.test(snapNewSrc));
ok('estático: el gate de creación va ANTES de abrir la cámara',
  snapNewSrc.indexOf('drexSnapCanView()') < snapNewSrc.indexOf('drexCameraOpen'));

ok('estático: drexSnapOpenViewer gatea la vista con drexSnapCanView()',
  /if\s*\(!drexSnapCanView\(\)\)\s*return;/.test(openViewerSrc));
ok('estático: el gate del visor va ANTES de quitar `hidden` del modal',
  openViewerSrc.indexOf('drexSnapCanView()') < openViewerSrc.indexOf("classList.remove('hidden')"));

ok('estático: hook drexOrbitApplyGates re-evalúa la bandeja tras refresh',
  /window\.drexOrbitApplyGates\s*=/.test(html) &&
  html.indexOf('drexSnapLoadTray();', html.indexOf('window.drexOrbitApplyGates = function')) > 0);

// ---------- conductuales: drexSnapCanView ----------
function runCanView(drexOrbitValue, defineIt) {
  const sandbox = {};
  vm.createContext(sandbox);
  if (defineIt) sandbox.DrexOrbit = drexOrbitValue;
  vm.runInContext(canViewSrc, sandbox, { filename: 'drexSnapCanView.js' });
  return vm.runInContext('drexSnapCanView()', sandbox);
}
const realShape = (st) => ({ effectivePlan: function () { try { return (st && st.active === true) ? (st.plan || 'monthly') : null; } catch (_) { return null; } } });

tcase('conductual: sin DrexOrbit -> false (fail-closed)', () =>
  runCanView(undefined, false) === false || Promise.reject(new Error('esperaba false')));
tcase('conductual: DrexOrbit null -> false (fail-closed)', () =>
  runCanView(null, true) === false || Promise.reject(new Error('esperaba false')));
tcase('conductual: sin estado verificado (refresh pendiente) -> false', () =>
  runCanView(realShape(null), true) === false || Promise.reject(new Error('esperaba false')));
tcase('conductual: verificación fallida / sin suscripción -> false', () =>
  runCanView(realShape({ active: false, status: 'none' }), true) === false || Promise.reject(new Error('esperaba false')));
tcase('conductual: plan efectivo activo (pagado o de prueba) -> true', () =>
  runCanView(realShape({ active: true, status: 'active' }), true) === true || Promise.reject(new Error('esperaba true')));
tcase('conductual: effectivePlan lanza -> false (fail-closed)', () =>
  runCanView({ effectivePlan: () => { throw new Error('boom'); } }, true) === false || Promise.reject(new Error('esperaba false')));

// ---------- conductuales: drexSnapLoadTray ----------
function makeTrayCtx(canView) {
  const calls = { add: [], remove: [], db: 0 };
  const classList = {
    add: (c) => calls.add.push(c),
    remove: (c) => calls.remove.push(c),
  };
  const trayEl = { classList };
  const dbFake = {
    ref: () => ({
      orderByChild: () => ({ limitToLast: () => ({ once: async () => ({ forEach: () => {} }) }) }),
      once: async () => ({ val: () => ({}) }),
    }),
  };
  const sandbox = {
    document: { getElementById: (id) => (id === 'drex-snap-tray' ? trayEl : null) },
    drexSnapMe: () => 'u1',
    drexSnapCanView: () => canView,
    DREX_SNAP_TRAY_LIMIT: 60,
    drexSnapRenderStaticTexts: () => {},
    drexSnapGetFilter: () => 'all',
    drexSnapRenderSkeleton: () => {},
    drexSnapDb: () => { calls.db++; return dbFake; },
    drexSnapIsExpired: () => false,
    drexSnapApplyMute: (l) => l,
    drexSnapLatestByAuthor: () => ({ by: {}, latest: [] }),
    drexSnapSeenGet: () => ({}),
    drexSnapSortTray: (l) => l,
    drexSnapFillAuthors: async () => {},
    drexSnapLoadImage: async () => {},
    drexSnapRenderTray: () => {},
    drexSnapUpdateMutedBtn: () => {},
    drexSnapSweep: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(loadTraySrc, sandbox, { filename: 'drexSnapLoadTray.js' });
  return { sandbox, calls };
}
tcase('conductual: sin premium la bandeja queda oculta y NO lee la DB', async () => {
  const { sandbox, calls } = makeTrayCtx(false);
  await vm.runInContext('drexSnapLoadTray()', sandbox);
  if (calls.remove.indexOf('hidden') !== -1) throw new Error('se quitó hidden sin premium');
  if (calls.add.indexOf('hidden') === -1) throw new Error('no se aseguró hidden sin premium');
  if (calls.db !== 0) throw new Error('tocó la DB sin premium');
});
tcase('conductual: con premium la bandeja se muestra y lee la DB', async () => {
  const { sandbox, calls } = makeTrayCtx(true);
  await vm.runInContext('drexSnapLoadTray()', sandbox);
  if (calls.remove.indexOf('hidden') === -1) throw new Error('no se mostró con premium');
  if (calls.db === 0) throw new Error('no leyó la DB con premium');
});

// ---------- conductuales: drexSnapNew ----------
function makeNewCtx(canView) {
  const calls = { paywall: [], camera: 0 };
  const sandbox = {
    window: {},
    drexSnapMe: () => 'u1',
    drexSnapCanView: () => canView,
    appT: (s) => s,
    showMiniToast: () => {},
    openOrbitPaywall: (f) => { calls.paywall.push(f); },
    drexCameraOpen: () => { calls.camera++; },
    document: { getElementById: () => null },
  };
  vm.createContext(sandbox);
  vm.runInContext(snapNewSrc, sandbox, { filename: 'drexSnapNew.js' });
  return { sandbox, calls };
}
tcase('conductual: sin premium, crear destello abre el paywall (no la cámara)', () => {
  const { sandbox, calls } = makeNewCtx(false);
  vm.runInContext('drexSnapNew()', sandbox);
  if (calls.paywall.join(',') !== 'destellos') throw new Error('no abrió el paywall de destellos');
  if (calls.camera !== 0) throw new Error('abrió la cámara sin premium');
});
tcase('conductual: con premium, crear destello abre la cámara', () => {
  const { sandbox, calls } = makeNewCtx(true);
  vm.runInContext('drexSnapNew()', sandbox);
  if (calls.camera !== 1) throw new Error('no abrió la cámara con premium');
  if (calls.paywall.length !== 0) throw new Error('abrió el paywall con premium');
});

// ---------- conductuales: drexSnapOpenViewer (fail-closed sin DOM) ----------
tcase('conductual: sin premium, el visor no abre ni siquiera con DOM ausente', () => {
  const sandbox = { drexSnapCanView: () => false };
  vm.createContext(sandbox);
  vm.runInContext(openViewerSrc, sandbox, { filename: 'drexSnapOpenViewer.js' });
  // Si el gate faltara, esto lanzaría TypeError por `document` indefinido.
  vm.runInContext('drexSnapOpenViewer()', sandbox);
});

process.on('exit', () => {
  if (failures > 0) { console.error('\nRESULTADO: FAIL (' + failures + ' fallos)'); process.exitCode = 1; }
  else console.log('\nRESULTADO: PASS — gating de Destellos verificado');
});
