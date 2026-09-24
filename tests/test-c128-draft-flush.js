// C128: flush del borrador del composer al salir/ocultar la app.
// El autoguardado del composer corre con debounce de 450ms (`handleNoteDraftInput`
// -> `_noteDraftSaveTimer`); si el usuario cierra la pestaña antes de que el
// timer dispare, lo último tecleado se perdía. El fix registra
// `drexFlushNoteDraftOnPageHide` en `pagehide`: cancela el timer pendiente y
// guarda el borrador de inmediato (síncrono). Con el composer cerrado (sin
// textarea) no hace nada.
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
  try { ok(name, fn()); }
  catch (e) { failures++; console.error('FAIL - ' + name + ' (throw: ' + (e && e.message) + ')'); }
}

// Extrae el cuerpo de `function drexFlushNoteDraftOnPageHide() { ... }`.
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

const body = extractFnBody(html, 'drexFlushNoteDraftOnPageHide');
ok('drexFlushNoteDraftOnPageHide existe', body !== null);

// ---------- 1. Aserciones estáticas ----------
if (body) {
  ok('cancela el timer de debounce pendiente',
    /clearTimeout\s*\(\s*_noteDraftSaveTimer\s*\)/.test(body));
  ok('nullea _noteDraftSaveTimer tras cancelar',
    /_noteDraftSaveTimer\s*=\s*null/.test(body));
  ok('lee el textarea note-content-fullscreen',
    /getElementById\s*\(\s*['"]note-content-fullscreen['"]\s*\)/.test(body));
  ok('solo guarda si hay contenido no vacío',
    /\.trim\s*\(\s*\)\s*\)/.test(body));
  ok('guarda el borrador sin toast',
    /saveCurrentNoteDraft\s*\(\s*false\s*\)/.test(body));
  ok('todo blindado con try/catch',
    /try\s*\{/.test(body));
}
ok("listener registrado en window 'pagehide'",
  /addEventListener\s*\(\s*['"]pagehide['"]\s*,\s*drexFlushNoteDraftOnPageHide\s*\)/.test(html));

// ---------- 2. Pruebas conductuales en sandbox ----------
function runFlush(sandbox) {
  sandbox.console = { warn() {}, error() {} };
  vm.createContext(sandbox);
  vm.runInContext('(function(){' + body + '})()', sandbox);
  return sandbox;
}

tcase('conductual: con timer pendiente, lo cancela, nullea y guarda', () => {
  const cleared = [];
  let savedArg = 'NOT_CALLED';
  const sb = {
    _noteDraftSaveTimer: { pending: true },
    clearTimeout(t) { cleared.push(t); },
    document: { getElementById(id) {
      if (id !== 'note-content-fullscreen') return null;
      return { value: 'último texto tecleado' };
    } },
    saveCurrentNoteDraft(showToast) { savedArg = showToast; }
  };
  runFlush(sb);
  return cleared.length === 1 && cleared[0] && cleared[0].pending === true
    && sb._noteDraftSaveTimer === null && savedArg === false;
});

tcase('conductual: sin timer pendiente pero con texto, también guarda', () => {
  let saved = false;
  const sb = {
    _noteDraftSaveTimer: null,
    clearTimeout() { throw new Error('no debe llamar clearTimeout sin timer'); },
    document: { getElementById() { return { value: 'algo' }; } },
    saveCurrentNoteDraft() { saved = true; }
  };
  runFlush(sb);
  return saved === true;
});

tcase('conductual: composer cerrado (sin textarea) -> no guarda nada', () => {
  let saved = false;
  const sb = {
    _noteDraftSaveTimer: null,
    clearTimeout() {},
    document: { getElementById() { return null; } },
    saveCurrentNoteDraft() { saved = true; }
  };
  runFlush(sb);
  return saved === false;
});

tcase('conductual: textarea vacío/solo espacios -> no guarda nada', () => {
  let saved = false;
  const sb = {
    _noteDraftSaveTimer: { pending: true },
    clearTimeout() {},
    document: { getElementById() { return { value: '   ' }; } },
    saveCurrentNoteDraft() { saved = true; }
  };
  runFlush(sb);
  return saved === false && sb._noteDraftSaveTimer === null;
});

tcase('conductual: un throw interno no rompe la salida de la página', () => {
  const sb = {
    _noteDraftSaveTimer: { pending: true },
    clearTimeout() { throw new Error('boom'); },
    document: null,
    saveCurrentNoteDraft() { throw new Error('no debe llegar aquí'); }
  };
  runFlush(sb);
  return true;
});

if (failures > 0) { console.error(failures + ' FAILURES'); process.exit(1); }
console.log('TODOS OK');
