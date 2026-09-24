// C148: auditoría hit por hit de familias de API NUNCA auditadas (brief C148):
// VirtualKeyboard API, View Transitions API, Speculation Rules API,
// Idle Detection API, Trusted Types / CSP, Compute Pressure / WebNN.
//
// INVENTARIO repo-wide (grep sobre index.html, drex-cloud.js,
// drex-rec-engine.js, sw.js, server.js; tests/ excluidos; C130 obliga
// repo-wide):
//  - virtualKeyboard (cualquier caso): 0
//  - startViewTransition / view-transition / @view-transition: 0
//  - speculationrules: 0
//  - IdleDetector: 0
//  - trustedTypes / trusted-types / require-trusted-types: 0
//  - Content-Security-Policy / http-equiv: 0
//  - PressureObserver / ComputePressure / navigator.ml / webnn / onnx: 0
//  - eval( / new Function: 0
//  - href="javascript: / src="javascript: / url(javascript:: 0
//
// ANCLAS EXISTENTES (por qué no hay hueco funcional):
//  - Teclado: <meta viewport interactive-widget="resizes-content"> (línea 15)
//    + fix visualViewport de la sala de chat (window._applyChatViewport,
//    C28-V1): la VirtualKeyboard API solo aporta show()/hide()
//    programático y geometrychange, que duplicarían lo ya resuelto sin
//    necesidad de producto. Chrome/Android: el meta resizes-content ya
//    redimensiona el layout viewport; iOS: el fix visualViewport ancla la
//    vista del chat. Nada que construir.
//  - View Transitions: el router v2 navega secciones del mismo documento;
//    las transiciones serían cosméticas (sin lead medido) y
//    prefers-reduced-motion está fuera de alcance por orden del usuario
//    (2026-09-15): descartado.
//  - Speculation Rules: Drex es un solo index.html (SPA por secciones);
//    no hay navegaciones de documento que prefetch: cero valor.
//  - Idle Detection: Drex no tiene sistema de presencia/estado; la API
//    exige permiso y es Chrome-only: sin ancla de producto.
//  - Trusted Types / CSP: NO desplegable hoy. Razones medidas:
//      * 847 atributos onclick= (958 handlers inline on*): cualquier
//        script-src sin 'unsafe-inline' rompería la app; con
//        'unsafe-inline' el CSP pierde su valor anti-XSS.
//      * 477 asignaciones .innerHTML: require-trusted-types-for 'script'
//        exigiría reescribir cada sumidero o una política por defecto
//        de identidad (que lo anula).
//    Los 4 'javascript:' del árbol son COMENTARIOS sobre sanitización,
//    no sumideros (grep: href/src/url(javascript: = 0). Sin eval/new
//    Function. La higiene sigue siendo: escapeHtml en HTML dinámico +
//    tests C132/C133 de sinks XSS e imágenes.
//  - Compute Pressure / WebNN: cero carga ML en cliente; sin ancla.
//
// CONCLUSIONES (sin lead → sin cambios en index.html):
//  - Las 6 familias están en cero repo-wide y 4 de ellas (View
//    Transitions, Speculation Rules, Idle Detection, Compute
//    Pressure/WebNN) no tienen superficie de producto donde anclarse.
//  - VirtualKeyboard: manejo existente suficiente; añadir la API sería
//    código muerto redundante.
//  - CSP estricto: bloqueado por arquitectura (handlers inline +
//    innerHTML masivo); documentar el "por qué no" es el entregable.
//    Si un ciclo futuro baja onclick= por debajo de ~800 o innerHTML
//    por debajo de ~400 (migración real a addEventListener/DOM), este
//    test LO CAZA y obliga a re-auditar la viabilidad de un CSP.
//
// Este test fija el inventario: cualquier uso nuevo de estas APIs rompe
// el test y obliga a re-auditar la familia; si desaparecen los handlers
// inline o los sumideros innerHTML, también rompe (re-auditoría CSP).
'use strict';
const fs = require('fs');
const path = require('path');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const repoRoot = path.join(__dirname, '..');
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(repoRoot, 'index.html');
const jsFiles = ['drex-cloud.js', 'drex-rec-engine.js', 'sw.js', 'server.js']
  .map(f => path.join(repoRoot, f));

let html;
try { html = fs.readFileSync(htmlPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer index.html'); process.exit(1); }
const jsBodies = jsFiles.map(p => {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
});
const all = [html].concat(jsBodies);

function countAll(re) {
  let n = 0;
  for (const b of all) {
    const m = b.match(re);
    if (m) n += m.length;
  }
  return n;
}
function countHtml(re) {
  const m = html.match(re);
  return m ? m.length : 0;
}

let passed = 0, failed = 0;
function tcase(name, fn) {
  try {
    fn();
    console.log('ok - ' + name);
    passed++;
  } catch (e) {
    console.log('FAIL - ' + name + ' :: ' + (e && e.message));
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }

// --- VirtualKeyboard API: cero repo-wide ---
tcase('virtualKeyboard: 0 hits repo-wide', () => {
  assert(countAll(/virtualKeyboard/gi) === 0, 'hay usos de navigator.virtualKeyboard');
});

// Ancla existente: manejo de teclado ya resuelto sin la API.
tcase('meta viewport con interactive-widget=resizes-content (manejo Android)', () => {
  const m = html.match(/<meta[^>]*name="viewport"[^>]*>/);
  assert(m, 'sin meta viewport');
  assert(/interactive-widget\s*=\s*resizes-content/.test(m[0]),
    'el viewport ya no redimensiona con el teclado');
});
tcase('fix visualViewport de la sala de chat intacto (manejo iOS)', () => {
  assert(countHtml(/window\._applyChatViewport\s*=\s*scheduleApply/) === 1,
    'falta el enganche _applyChatViewport del fix C28-V1');
  assert(/visualViewport/.test(html), 'sin referencias a visualViewport');
});

// --- View Transitions API: cero repo-wide ---
tcase('startViewTransition: 0 hits', () => {
  assert(countAll(/startViewTransition/g) === 0, 'hay startViewTransition');
});
tcase('view-transition (CSS/JS): 0 hits', () => {
  assert(countAll(/view-transition/gi) === 0, 'hay view-transition');
});

// --- Speculation Rules API: cero repo-wide ---
tcase('speculationrules: 0 hits', () => {
  assert(countAll(/speculationrules/gi) === 0, 'hay speculationrules');
});

// --- Idle Detection API: cero repo-wide ---
tcase('IdleDetector: 0 hits', () => {
  assert(countAll(/IdleDetector/g) === 0, 'hay IdleDetector');
});

// --- Trusted Types: cero repo-wide ---
tcase('trustedTypes: 0 hits', () => {
  assert(countAll(/trustedTypes|trusted-types|require-trusted-types/gi) === 0,
    'hay Trusted Types');
});

// --- CSP: sin meta ni cabecera inline; razones documentadas ---
tcase('sin meta http-equiv CSP repo-wide', () => {
  assert(countAll(/http-equiv|Content-Security-Policy/i) === 0,
    'hay rastro de CSP');
});
tcase('CSP script-src no desplegable: handlers inline masivos', () => {
  const n = countHtml(/onclick=/g);
  assert(n >= 800, 'onclick= bajó de 800 (' + n + '): re-auditar viabilidad de CSP script-src');
});
tcase('Trusted Types no desplegable: sumideros innerHTML masivos', () => {
  const n = countHtml(/\.innerHTML\s*=/g);
  assert(n >= 400, 'innerHTML bajó de 400 (' + n + '): re-auditar Trusted Types');
});
tcase('sin javascript: en href/src/url() (los 4 del árbol son comentarios)', () => {
  assert(countAll(/href\s*=\s*["']javascript:/gi) === 0, 'hay href javascript:');
  assert(countAll(/src\s*=\s*["']javascript:/gi) === 0, 'hay src javascript:');
  assert(countAll(/url\(\s*["']?javascript:/gi) === 0, 'hay url(javascript:');
});
tcase('sin eval/new Function repo-wide', () => {
  assert(countAll(/eval\s*\(|new\s+Function/g) === 0, 'hay eval/new Function');
});

// --- Compute Pressure / WebNN: cero repo-wide ---
tcase('PressureObserver/ComputePressure: 0 hits', () => {
  assert(countAll(/PressureObserver|ComputePressure/g) === 0, 'hay Compute Pressure');
});
tcase('WebNN (navigator.ml/webnn/onnx): 0 hits', () => {
  assert(countAll(/navigator\.ml|webnn|onnx/gi) === 0, 'hay WebNN/ONNX');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
