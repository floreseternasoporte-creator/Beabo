// C131: auditoría hit por hit de familias NUNCA auditadas — visualViewport API,
// NetworkInformation (navigator.connection/saveData) y Constructable Stylesheets.
//
// INVENTARIO repo-wide (grep -rln sobre *.js + *.html, C130 obliga repo-wide):
//  - visualViewport: 2 archivos — index.html y 404.html (copia exacta). Único
//    uso: IIFE que encoge `chat-room-view` a la altura del visualViewport y
//    ancla su `top` a vv.offsetTop cuando iOS abre el teclado (bug 2026-09-19).
//  - navigator.connection / saveData / effectiveType: 1 archivo — drex-cloud.js.
//    Único uso: `adaptivePollMs` (polling adaptativo a la red, 2026-09-21) +
//    listener `change` que recalcula intervalos. Nada en index.html.
//  - adoptedStyleSheets / CSSStyleSheet: CERO en todo el árbol (index, 404,
//    drex-cloud.js, drex-rec-engine.js, sw.js, server.js) → cero explícito
//    documentado para no "redescubrirlo" (regla de C122/C125).
//
// CONCLUSIONES (sin lead → sin cambios, brief C131):
//  - visualViewport: IIFE corre una vez por vida de página; guarda `if (!vv)
//    return` (feature-detect); registra EXACTAMENTE 2 listeners (resize+scroll)
//    que colapsan vía un único rAF pendiente (cancelAnimationFrame antes de
//    reprogramar: máximo 1 rAF en vuelo, sin acumulación). applyChatViewport
//    es no-op si la sala está ausente u oculta; resetChatViewport limpia los
//    estilos inline. Los listeners viven con la página (mismo patrón que los
//    listeners message/storage de C98): no hay fuga que liberar.
//  - navigator.connection: todo con feature-detect + try/catch (si el
//    navegador no expone NetworkInformation, la cadencia base no cambia);
//    saveData fuerza ≥10000 ms, 2g/slow-2g → ≥10000 ms, 3g → ≥5000 ms. El
//    listener `change` llama a restartPollTimers(), que limpia y re-crea
//    intervalos sin perder oyentes (ensurePolling sigue exigiendo
//    listeners.length). Registro único por evaluación del módulo: no se
//    acumula. Sin escritura de red nueva: solo cambia la CADENCIA del polling
//    ya existente (auditoría de rendimiento, no funcional).
//  - Adopted stylesheets: cero. Drex no usa estilos construibles; todos los
//    <style> son estáticos o inline determinista.
//
// Este test fija el inventario: un visualViewport/addEventListener nuevo, un
// navigator.connection nuevo, o cualquier adoptedStyleSheets rompe el test y
// obliga a re-auditar la familia.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(__dirname, '..', 'index.html');
const copyPath = path.join(__dirname, '..', '404.html');
const cloudPath = path.join(__dirname, '..', 'drex-cloud.js');
const recPath = path.join(__dirname, '..', 'drex-rec-engine.js');
const swPath = path.join(__dirname, '..', 'sw.js');
const serverPath = path.join(__dirname, '..', 'server.js');
let html, copy, cloud, rec, sw, server;
try { html = fs.readFileSync(htmlPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer index.html'); process.exit(1); }
try { copy = fs.readFileSync(copyPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer 404.html'); process.exit(1); }
try { cloud = fs.readFileSync(cloudPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer drex-cloud.js'); process.exit(1); }
try { rec = fs.readFileSync(recPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer drex-rec-engine.js'); process.exit(1); }
try { sw = fs.readFileSync(swPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer sw.js'); process.exit(1); }
try { server = fs.readFileSync(serverPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer server.js'); process.exit(1); }

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
function count(re, src) { return (src.match(re) || []).length; }
// Extrae la IIFE del visualViewport: el "(function () {" más cercano antes de
// "var vv = window.visualViewport;" hasta su cierre balanceado + "()".
function extractViewportIIFE(src) {
  const anchor = 'var vv = window.visualViewport;';
  const ai = src.indexOf(anchor);
  if (ai === -1) return null;
  const start = src.lastIndexOf('(function () {', ai);
  if (start === -1) return null;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) return null;
  const tail = src.slice(i, i + 6);
  if (!/^}\)\(\);/.test(tail)) return null;
  return src.slice(start, i + 1) + ')();';
}

// ---------- 1. visualViewport: inventario ----------
ok('index.html: exactamente 1 lectura de window.visualViewport',
  count(/window\.visualViewport/g, html) === 1);
ok('index.html: exactamente 2 vv.addEventListener (resize + scroll)',
  count(/vv\.addEventListener\s*\(/g, html) === 2);
ok('visualViewport: listener resize -> scheduleApply',
  /vv\.addEventListener\(\s*['"]resize['"]\s*,\s*scheduleApply\s*\)/.test(html));
ok('visualViewport: listener scroll -> scheduleApply',
  /vv\.addEventListener\(\s*['"]scroll['"]\s*,\s*scheduleApply\s*\)/.test(html));
ok('visualViewport: feature-detect con salida limpia (if (!vv) return)',
  /var vv = window\.visualViewport;\s*\n\s*if\s*\(\s*!vv\s*\)\s*return;/.test(html));
ok('visualViewport: scheduleApply colapsa con rAF (cancel antes de reprogramar)',
  /function scheduleApply\(\)\s*\{\s*cancelAnimationFrame\(rafId\);\s*rafId = requestAnimationFrame\(applyChatViewport\);\s*\}/
    .test(html));
ok('applyChatViewport es no-op si la sala está ausente u oculta',
  /function applyChatViewport\(\)\s*\{\s*var v = document\.getElementById\(['"]chat-room-view['"]\);\s*if\s*\(\s*!v\s*\|\|\s*v\.classList\.contains\(['"]hidden['"]\)\s*\)\s*return;/
    .test(html));
ok('applyChatViewport fija top/height del visualViewport',
  /v\.style\.top = vv\.offsetTop \+ ['"]px['"];\s*v\.style\.bottom = ['"]auto['"];\s*v\.style\.height = vv\.height \+ ['"]px['"];/
    .test(html));
ok('resetChatViewport limpia los estilos inline (top/bottom/height)',
  /function resetChatViewport\(\)\s*\{\s*var v = document\.getElementById\(['"]chat-room-view['"]\);\s*if\s*\(\s*!v\s*\)\s*return;\s*v\.style\.top = ['"]['"];\s*v\.style\.bottom = ['"]['"];\s*v\.style\.height = ['"]['"];\s*\}/
    .test(html));
ok('visualViewport: ningún removeEventListener (listeners de vida de página, patrón C98)',
  count(/visualViewport[\s\S]{0,2000}?removeEventListener/g, html) === 0 ||
  !/vv\.removeEventListener/.test(html));
ok('404.html: mismo bloque visualViewport (copia exacta del inventario)',
  count(/window\.visualViewport/g, copy) === 1 && count(/vv\.addEventListener\s*\(/g, copy) === 2);

// ---------- 2. navigator.connection / saveData: inventario ----------
const adaptBody = extractFnBody(cloud, 'adaptivePollMs');
ok('adaptivePollMs existe', adaptBody !== null);
if (adaptBody) {
  ok('adaptivePollMs: feature-detect (navigator.connection puede no existir)',
    /\(typeof navigator !== ['"]undefined['"] && navigator\.connection\) \|\| null/.test(adaptBody));
  ok('adaptivePollMs: todo dentro de try/catch (fallback a cadencia base)',
    /try\s*\{[\s\S]*navigator\.connection[\s\S]*\}\s*catch/.test(adaptBody));
  ok('adaptivePollMs: saveData fuerza mínimo 10000 ms',
    /if\s*\(\s*c\.saveData\s*\)\s*return Math\.max\(baseMs,\s*10000\)/.test(adaptBody));
  ok('adaptivePollMs: 2g/slow-2g fuerza mínimo 10000 ms',
    /t === ['"]slow-2g['"] \|\| t === ['"]2g['"]\)\s*return Math\.max\(baseMs,\s*10000\)/.test(adaptBody));
  ok('adaptivePollMs: 3g fuerza mínimo 5000 ms',
    /t === ['"]3g['"]\)\s*return Math\.max\(baseMs,\s*5000\)/.test(adaptBody));
  ok('adaptivePollMs: 4g/desconocido devuelve la base sin tocar',
    /return baseMs;/.test(adaptBody));
}
ok('drex-cloud.js: exactamente 1 listener change de NetworkInformation',
  count(/addEventListener\(\s*['"]change['"]/g, cloud) === 1);
ok('change de red -> restartPollTimers (recalcula sin perder oyentes)',
  /addEventListener\(\s*['"]change['"]\s*,\s*function\s*\(\s*\)\s*\{\s*restartPollTimers\(\);\s*\}\)/.test(cloud));
const restartBody = extractFnBody(cloud, 'restartPollTimers');
ok('restartPollTimers existe', restartBody !== null);
if (restartBody) {
  ok('restartPollTimers limpia ambos timers antes de re-crear',
    /clearInterval\(pollTimer\)[\s\S]{0,80}?clearInterval\(fastTimer\)/.test(restartBody));
  ok('restartPollTimers re-arma vía ensurePolling',
    /ensurePolling\(\)/.test(restartBody));
}
ok('navigator.connection/saveData/effectiveType: 0 ocurrencias en index.html (familia solo en drex-cloud.js)',
  count(/navigator\.connection|\.saveData|effectiveType/g, html) === 0);

// ---------- 3. Constructable Stylesheets: cero explícito ----------
const cssRe = /adoptedStyleSheets|new CSSStyleSheet|CSSStyleSheet/g;
ok('adoptedStyleSheets/CSSStyleSheet: 0 en index.html', count(cssRe, html) === 0);
ok('adoptedStyleSheets/CSSStyleSheet: 0 en 404.html', count(cssRe, copy) === 0);
ok('adoptedStyleSheets/CSSStyleSheet: 0 en drex-cloud.js', count(cssRe, cloud) === 0);
ok('adoptedStyleSheets/CSSStyleSheet: 0 en drex-rec-engine.js', count(cssRe, rec) === 0);
ok('adoptedStyleSheets/CSSStyleSheet: 0 en sw.js', count(cssRe, sw) === 0);
ok('adoptedStyleSheets/CSSStyleSheet: 0 en server.js', count(cssRe, server) === 0);

// ---------- 4. Conductuales: visualViewport en sandbox ----------
const iife = extractViewportIIFE(html);
ok('IIFE del visualViewport extraíble', iife !== null);
function viewportSandbox(viewHidden, vvProps) {
  const handlers = {};
  const vv = {
    offsetTop: vvProps.offsetTop, height: vvProps.height,
    addEventListener(ev, fn) { handlers[ev] = fn; }
  };
  const view = { style: {}, classList: { contains() { return viewHidden; } } };
  const rafs = [];
  const cancelled = [];
  const sb = {
    window: { visualViewport: vv },
    document: { getElementById(id) { return id === 'chat-room-view' ? view : null; } },
    requestAnimationFrame(cb) { rafs.push(cb); return rafs.length; },
    cancelAnimationFrame(id) { cancelled.push(id); },
    console: { warn() {}, error() {} }
  };
  vm.createContext(sb);
  vm.runInContext(iife, sb);
  return { sb, view, handlers, rafs, cancelled };
}
tcase('conductual: resize con sala visible aplica top/height del viewport', () => {
  const s = viewportSandbox(false, { offsetTop: 40, height: 500 });
  s.handlers.resize();
  s.rafs.forEach(cb => cb());
  return s.view.style.top === '40px' && s.view.style.height === '500px' && s.view.style.bottom === 'auto';
});
tcase('conductual: resize con sala oculta no toca estilos', () => {
  const s = viewportSandbox(true, { offsetTop: 40, height: 500 });
  s.handlers.resize();
  s.rafs.forEach(cb => cb());
  return Object.keys(s.view.style).length === 0;
});
tcase('conductual: dos resize seguidos colapsan en rAF (se cancela el anterior)', () => {
  const s = viewportSandbox(false, { offsetTop: 0, height: 600 });
  s.handlers.resize();
  s.handlers.scroll();
  return s.cancelled.indexOf(1) !== -1 && s.rafs.length === 2;
});
tcase('conductual: resetChatViewport limpia los estilos inline', () => {
  const s = viewportSandbox(false, { offsetTop: 40, height: 500 });
  s.handlers.resize();
  s.rafs.forEach(cb => cb());
  if (s.view.style.top !== '40px') return false;
  s.sb.window._resetChatViewport();
  return s.view.style.top === '' && s.view.style.bottom === '' && s.view.style.height === '';
});
tcase('conductual: sin visualViewport la IIFE sale sin registrar nada', () => {
  const sb = {
    window: {},
    document: { getElementById() { return null; } },
    requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {},
    console: { warn() {}, error() {} }
  };
  vm.createContext(sb);
  vm.runInContext(iife, sb);
  return typeof sb.window._applyChatViewport === 'undefined'
    && typeof sb.window._resetChatViewport === 'undefined';
});

// ---------- 5. Conductuales: adaptivePollMs en sandbox ----------
function pollWith(connDesc, baseMs) {
  const sb = {};
  if (connDesc === 'THROW') {
    Object.defineProperty(sb, 'navigator', { get() { throw new Error('no network info'); } });
  } else if (connDesc === 'NULL') {
    sb.navigator = { connection: null };
  } else if (connDesc) {
    sb.navigator = { connection: connDesc };
  }
  vm.createContext(sb);
  return vm.runInContext('(function adaptivePollMs(baseMs){' + adaptBody + '})(' + baseMs + ')', sb);
}
tcase('conductual: sin navigator.connection devuelve la base', () => pollWith(null, 3000) === 3000);
tcase('conductual: connection null devuelve la base', () => pollWith('NULL', 3000) === 3000);
tcase('conductual: saveData fuerza 10000 (base 3000)', () => pollWith({ saveData: true, effectiveType: '4g' }, 3000) === 10000);
tcase('conductual: saveData respeta base mayor (base 15000)', () => pollWith({ saveData: true, effectiveType: '4g' }, 15000) === 15000);
tcase('conductual: slow-2g/2g fuerzan 10000', () =>
  pollWith({ effectiveType: 'slow-2g' }, 3000) === 10000 && pollWith({ effectiveType: '2g' }, 3000) === 10000);
tcase('conductual: 3g fuerza 5000', () => pollWith({ effectiveType: '3g' }, 3000) === 5000);
tcase('conductual: 4g devuelve la base sin tocar', () => pollWith({ effectiveType: '4g' }, 3000) === 3000);
tcase('conductual: acceso a navigator que lanza usa la base (try/catch)', () => pollWith('THROW', 3000) === 3000);

if (failures) { console.error(failures + ' FAIL(s)'); process.exit(1); }
console.log('C131 viewport-netinfo: todo OK');
