// C129: invariantes del back-forward cache (bfcache).
//
// Con `beforeunload`/`pagehide` barridos en C128 quedaba un ángulo nuevo: el
// bfcache restaura el DOM + el heap JS SIN re-ejecutar scripts. Eso implica:
//  1. `pagehide` SÍ dispara al entrar a bfcache (con `event.persisted=true`),
//     así que el flush del borrador de C128 y la persistencia del recomendador
//     corren también ahí — no se pierde nada.
//  2. Los listeners registrados una sola vez al evaluar NO se duplican al
//     restaurar (el script no vuelve a correr).
//  3. Los timers se congelan y reanudan; `visibilitychange` hidden→visible ya
//     detiene/reinicia la sesión de tiempo de pantalla (idempotente).
//  4. Nada bloquea la elegibilidad de bfcache: sin listeners `unload`, sin
//     WebSocket (drex-cloud.js usa polling), y el `beforeunload` de tiempo de
//     pantalla no toca `returnValue`/`preventDefault`.
//  5. No existe ningún listener `pageshow`: no hay nada que re-inicializar al
//     restaurar (cero intencional, documentado aquí para no re-descubrirlo).
//
// Este test fija esos invariantes: estáticos contra index.html/drex-cloud.js y
// conductuales en sandbox vm (entrada a bfcache simulada con persisted=true).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(__dirname, '..', 'index.html');
const cloudPath = path.join(__dirname, '..', 'drex-cloud.js');
let html, cloud;
try { html = fs.readFileSync(htmlPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer index.html'); process.exit(1); }
try { cloud = fs.readFileSync(cloudPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer drex-cloud.js'); process.exit(1); }

let failures = 0;
function ok(name, cond) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name); }
}
function tcase(name, fn) {
  try { ok(name, fn()); }
  catch (e) { failures++; console.error('FAIL - ' + name + ' (throw: ' + (e && e.message) + ')'); }
}
function extractFnBody(src, fnName) {
  const start = src.indexOf('function ' + fnName + '(');
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

// ---------- 1. Elegibilidad de bfcache ----------
ok('sin listeners unload (bloquean bfcache)',
  !/addEventListener\s*\(\s*['"]unload['"]/.test(html) && !/onunload\s*=/.test(html));
ok('sin WebSocket en index.html (bloquea bfcache)',
  !/new\s+WebSocket\s*\(/.test(html));
ok('sin WebSocket en drex-cloud.js (polling, no bloquea bfcache)',
  !/new\s+WebSocket\s*\(/.test(cloud));

const stBody = extractFnBody(html, 'stopScreenTimeTracking');
ok('stopScreenTimeTracking existe', stBody !== null);
if (stBody) {
  ok('beforeunload no toca returnValue/preventDefault (no bloquea bfcache)',
    !/returnValue|preventDefault/.test(stBody));
  ok('stopScreenTimeTracking es idempotente (guarda _stSessionStart)',
    /if\s*\(\s*_stSessionStart\s*\)/.test(stBody));
}

// ---------- 2. Listeners pagehide: registrados una vez, no se duplican ----------
ok('pagehide -> drexFlushNoteDraftOnPageHide registrado una sola vez',
  (html.match(/addEventListener\s*\(\s*['"]pagehide['"]\s*,\s*drexFlushNoteDraftOnPageHide/g) || []).length === 1);
ok('pagehide -> persistencia del recomendador registrada',
  /window\.addEventListener\s*\(\s*['"]pagehide['"]/.test(html)
  && /_drexRecPersistNow\s*\(\s*\)/.test(html));
ok('cero listeners pageshow (restaurar no re-ejecuta scripts; nada que re-init)',
  !/pageshow/.test(html));

// ---------- 3. Sesiones sobreviven a bfcache vía visibilitychange ----------
ok('visibilitychange hidden detiene tiempo de pantalla',
  /visibilitychange[\s\S]{0,400}?visibilityState\s*===\s*['"]hidden['"][\s\S]{0,200}?stopScreenTimeTracking\s*\(/.test(html));
ok('visibilitychange visible reinicia la sesión (bfcache restore)',
  /else\s*\{\s*_stSessionStart\s*=\s*Date\.now\(\)/.test(html));

// ---------- 4. Re-auditoría de ceros (C103/C121/C122) ----------
ok('BroadcastChannel sigue en cero', !/BroadcastChannel/.test(html));
ok('document.fonts/FontFace siguen en cero', !/document\.fonts|FontFace/i.test(html));
ok('getUserMedia: solo el mic de Fiestas (1 hit)',
  (html.match(/getUserMedia/g) || []).length === 1);
ok('sin strings "voice" huérfanos',
  !/["'][^"'<>]*voice[^"'<>]*["']/i.test(html.replace(/voiceover/gi, '')));

// ---------- 5. Conductuales en sandbox ----------
const flushBody = extractFnBody(html, 'drexFlushNoteDraftOnPageHide');
ok('drexFlushNoteDraftOnPageHide existe', flushBody !== null);

tcase('conductual: entrada a bfcache (pagehide persisted=true) hace flush del borrador', () => {
  const cleared = [];
  let savedArg = 'NOT_CALLED';
  const sb = {
    _noteDraftSaveTimer: { pending: true },
    clearTimeout(t) { cleared.push(t); },
    document: { getElementById(id) {
      if (id !== 'note-content-fullscreen') return null;
      return { value: 'texto tecleado antes del back' };
    } },
    saveCurrentNoteDraft(showToast) { savedArg = showToast; },
    console: { warn() {}, error() {} }
  };
  vm.createContext(sb);
  // La entrada a bfcache dispara pagehide con persisted=true; el handler no
  // usa el evento, pero lo pasamos para documentar el camino real.
  vm.runInContext('(function(event){' + flushBody + '})({type:"pagehide",persisted:true})', sb);
  return cleared.length === 1 && sb._noteDraftSaveTimer === null && savedArg === false;
});

tcase('conductual: stopScreenTimeTracking doble llamada suma minutos una sola vez', () => {
  let addedCalls = 0;
  let addedMins = 0;
  const sb = {
    _stSessionStart: Date.now() - 60000,
    _stAddMinutes() { addedCalls++; addedMins = arguments[1]; },
    _stDateKey() { return '2026-09-24'; },
    _stClearBreakReminder() {},
    Date
  };
  vm.createContext(sb);
  vm.runInContext('(function(){' + stBody + '})()', sb);
  vm.runInContext('(function(){' + stBody + '})()', sb);
  return addedCalls === 1 && addedMins > 0.9 && addedMins < 1.1 && sb._stSessionStart === null;
});

if (failures) { console.error(failures + ' FAIL(s)'); process.exit(1); }
console.log('C129 bfcache: todo OK');
