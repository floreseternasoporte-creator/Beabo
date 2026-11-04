// C142: auditoría hit por hit de la familia NUNCA auditada — Screen Orientation
// API (screen.orientation.lock/unlock, orientationchange), más re-verify de
// requestIdleCallback/scheduler (C107 los documentó en cero) y re-verify de
// Media Session (C141 enganchó handlers; este test fija los hooks contra
// regresiones sin duplicar test-c141).
//
// INVENTARIO repo-wide (grep sobre index.html, 404.html, drex-cloud.js,
// drex-rec-engine.js, sw.js, server.js; tests/ excluidos; C130 obliga
// repo-wide):
//  - screen.orientation: 0
//  - screen.lockOrientation / webkitLockOrientation / mozLockOrientation: 0
//  - orientationchange: 0
//  - CSS @media con (orientation:...): 0
//  - DeviceOrientationEvent / deviceorientation: 0 (familia vecina, cero)
//  - screen.width / screen.height (detección manual de orientación): 0
//  - requestFullscreen / webkitRequestFullscreen (C141: Fullscreen=0): 0
//  - requestIdleCallback / cancelIdleCallback: 0 (re-verify C107 con código
//    nuevo: sigue en cero)
//  - scheduler.postTask / navigator.scheduler: 0
//  - meta viewport sin bloqueo de orientación (sin "orientation=landscape").
//  - #video-modal ×1 + #video-modal-player ×1 con playsinline + object-contain
//    w-full h-full: el visor de video llena la pantalla y se adapta a la
//    rotación del dispositivo solo con CSS.
//
// CONCLUSIONES (sin lead → sin cambios en index.html):
//  - Screen Orientation API no se usa en ningún sitio y no tiene superficie
//    donde anclarse: Drex no usa la Fullscreen API (C141, decisión deliberada
//    documentada) y screen.orientation.lock() RECHAZA sin fullscreen activo
//    en Chrome/Safari (requiere documento en fullscreen por spec) → añadir
//    lock() sería código muerto que solo puede fallar.
//  - El visor de video (#video-modal: fixed inset-0, video object-contain)
//    ya maximiza el video al rotar el dispositivo: no necesita la API.
//  - Auto-fijar la orientación sería UX hostil (sobrescribe el bloqueo de
//    rotación del SO del usuario); queda descartado como decisión de
//    producto, no como bug.
//  - requestIdleCallback/scheduler: cero confirmado — Drex no programa trabajo
//    diferido; si un futuro ciclo lo introduce, este test lo caza.
//  - Media Session: musicEnsureAudio sigue enganchando
//    musicWireMediaSessionHandlers() y musicPaintTrackUI sigue llamando
//    musicSyncMediaSession(t) → sin regresión.
//
// Este test fija el inventario: cualquier screen.orientation,
// requestIdleCallback o scheduler nuevo rompe el test y obliga a re-auditar
// la familia; si los hooks de Media Session se mueven, también rompe.
'use strict';
const fs = require('fs');
const path = require('path');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const repoRoot = path.join(__dirname, '..');
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(repoRoot, 'index.html');
const copyPath = path.join(repoRoot, '404.html');
const jsFiles = ['drex-cloud.js', 'drex-rec-engine.js', 'sw.js', 'server.js']
  .map(f => path.join(repoRoot, f));

let html, copy;
try { html = fs.readFileSync(htmlPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer index.html'); process.exit(1); }
try { copy = fs.readFileSync(copyPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer 404.html'); process.exit(1); }
const jsBodies = jsFiles.map(p => {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
});
const all = [html].concat(jsBodies);

// Familia Screen Orientation + vecinos: multiconjunto exacto (0 hits).
function countAll(re) {
  let n = 0;
  for (const b of all) {
    const m = b.match(re);
    if (m) n += m.length;
  }
  return n;
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

// Familia NUEVA: Screen Orientation API — cero repo-wide.
tcase('screen.orientation: 0 hits repo-wide', () => {
  assert(countAll(/screen\.orientation/g) === 0, 'hay usos de screen.orientation');
});
tcase('lockOrientation (incl. vendor): 0 hits', () => {
  assert(countAll(/[a-zA-Z]*[Ll]ockOrientation/g) === 0, 'hay lockOrientation');
});
tcase('unlockOrientation: 0 hits', () => {
  assert(countAll(/[a-zA-Z]*[Uu]nlockOrientation/g) === 0, 'hay unlockOrientation');
});
tcase('orientationchange: 0 listeners', () => {
  assert(countAll(/orientationchange/g) === 0, 'hay orientationchange');
});
tcase('CSS @media (orientation): 0 reglas', () => {
  assert(countAll(/@media[^{]*\(\s*orientation/g) === 0, 'hay @media orientation');
});
tcase('DeviceOrientationEvent/deviceorientation: 0 (familia vecina)', () => {
  assert(countAll(/[dD]evice[oO]rientation/g) === 0, 'hay deviceorientation');
});
tcase('screen.width/height para detección de orientación: 0', () => {
  assert(countAll(/screen\.(width|height|availWidth|availHeight)/g) === 0,
    'hay detección manual por screen.width/height');
});

// Ancla inexistente: Fullscreen API sigue en cero (C141) → lock() sin
// fullscreen rechazaría por spec; no hay superficie donde usarlo.
tcase('Fullscreen API: 0 (C141 intacto; lock() no tendría ancla)', () => {
  assert(countAll(/[a-zA-Z]*[Rr]equestFullscreen/g) === 0, 'hay requestFullscreen');
  assert(countAll(/fullscreenchange/g) === 0, 'hay fullscreenchange');
});

// El visor de video existe y se adapta por CSS (sin API de orientación).
tcase('#video-modal existe ×1 (fixed inset-0)', () => {
  assert((html.match(/id="video-modal"/g) || []).length === 1, 'video-modal ausente o duplicado');
  assert(/id="video-modal"[^>]*class="[^"]*fixed inset-0/.test(html), 'video-modal no es pantalla completa');
});
tcase('#video-modal-player ×1 con playsinline + object-contain', () => {
  assert((html.match(/id="video-modal-player"/g) || []).length === 1, 'player ausente o duplicado');
  assert(/id="video-modal-player"[^>]*playsinline/.test(html), 'sin playsinline');
  assert(/id="video-modal-player"[^>]*object-contain/.test(html), 'sin object-contain');
});

// El viewport no bloquea orientación (correcto para una app social).
tcase('meta viewport sin bloqueo de orientación', () => {
  const m = html.match(/<meta[^>]*name="viewport"[^>]*>/);
  assert(m, 'sin meta viewport');
  assert(!/orientation\s*=\s*(landscape|portrait)/i.test(m[0]),
    'el viewport bloquea orientación');
});

// Re-verify C107: requestIdleCallback/scheduler siguen en cero con código nuevo.
tcase('requestIdleCallback/cancelIdleCallback: 0 (re-verify C107)', () => {
  assert(countAll(/[a-zA-Z]*[Ii]dleCallback/g) === 0, 'hay requestIdleCallback');
});
tcase('scheduler.postTask / navigator.scheduler: 0', () => {
  assert(countAll(/scheduler\.(postTask|yield)/g) === 0, 'hay scheduler.postTask');
  assert(countAll(/navigator\.scheduler/g) === 0, 'hay navigator.scheduler');
});

// Re-verify Media Session: hooks de C141 intactos (guardia de regresión).
tcase('Media Session: musicEnsureAudio engancha musicWireMediaSessionHandlers', () => {
  const i = html.indexOf('function musicEnsureAudio()');
  assert(i !== -1, 'musicEnsureAudio ausente');
  const body = html.slice(i, i + 900);
  assert(/musicWireMediaSessionHandlers\(\)/.test(body), 'hook C141 ausente en musicEnsureAudio');
});
tcase('Media Session: musicPaintTrackUI llama musicSyncMediaSession', () => {
  const i = html.indexOf('function musicPaintTrackUI(');
  assert(i !== -1, 'musicPaintTrackUI ausente');
  const body = html.slice(i, i + 700);
  assert(/musicSyncMediaSession\(t\)/.test(body), 'hook C141 ausente en musicPaintTrackUI');
});
tcase('Media Session: las 3 funciones C141 siguen definidas', () => {
  assert(/function musicMediaMetadataOf\(/.test(html), 'musicMediaMetadataOf ausente');
  assert(/function musicSyncMediaSession\(/.test(html), 'musicSyncMediaSession ausente');
  assert(/function musicWireMediaSessionHandlers\(/.test(html), 'musicWireMediaSessionHandlers ausente');
});

console.log('\nC142: ' + passed + ' pasaron, ' + failed + ' fallaron.');
process.exit(failed ? 1 : 0);
