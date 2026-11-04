'use strict';
/* test-c15-pushfix-r10-1.js — Regresión del hallazgo R10-1 (push hijack / phishing).
 *
 * Un `data.url` con origen atacante en una notificación push no debe navegar
 * fuera de la app: ni clients.openWindow() en sw.js ni location.href en el
 * manejador in-app. El test ejecuta el CÓDIGO REAL:
 *  - Parte A: extrae el manejador 'message' de index.html y lo corre con stubs.
 *  - Parte B: carga sw.js completo en vm y dispara 'notificationclick'.
 * No depende del historial de git. Layout: ../index.html, ../sw.js.
 *
 * Uso: node tests/test-c15-pushfix-r10-1.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function resolveRepoFile(name) {
  const cands = [path.join(__dirname, '..', name), path.join(__dirname, '..', 'src', name)];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  console.error('FAIL: no se encontró ' + name);
  process.exit(2);
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

const APP_ORIGIN = 'https://floreseternasoporte-creator.github.io';
const APP_ROOT = APP_ORIGIN + '/Beabo/';
const EVIL = 'https://evil-phish.example/x';

// Extrae un bloque balanceado desde el índice de '{' dado.
function extractBlock(src, openIdx) {
  let depth = 0, inStr = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  throw new Error('bloque no balanceado');
}

async function partA() {
  console.log('== Parte A: manejador in-app (index.html) ==');
  const html = fs.readFileSync(resolveRepoFile('index.html'), 'utf8');
  check('A0. marcador R10-1 presente', html.indexOf('R10-1 (push hijack)') !== -1);
  const marker = "navigator.serviceWorker.addEventListener('message'";
  const mi = html.indexOf(marker);
  check('A0b. manejador message existe', mi !== -1);
  if (mi === -1) return;
  const braceIdx = html.indexOf('{', html.indexOf('=>', mi) !== -1 && html.indexOf('=>', mi) < html.indexOf('{', mi) + 200 ? html.indexOf('=>', mi) : mi);
  // El listener es: addEventListener('message', event => { ... });
  const arrowIdx = html.indexOf('=>', mi);
  const openIdx = html.indexOf('{', arrowIdx);
  const body = extractBlock(html, openIdx); // "{ try { ... } catch ... }"
  const code = 'navigator.serviceWorker.addEventListener(\'message\', function (event) ' + body + ');';

  let assignedHref = null;
  let routedPath = null;
  const handlers = {};
  const fakeLocation = {};
  Object.defineProperty(fakeLocation, 'href', {
    get() { return APP_ROOT; },
    set(v) { assignedHref = v; },
    configurable: true
  });
  fakeLocation.origin = APP_ORIGIN;
  const sandbox = {
    navigator: { serviceWorker: { addEventListener(t, fn) { handlers[t] = fn; } } },
    location: fakeLocation,
    drexOpenRoutePath(p) { routedPath = p; },
    URL
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  function fire(url) {
    assignedHref = null; routedPath = null;
    handlers['message']({ data: { type: 'drex-push-open', url } });
  }
  fire(EVIL);
  check('A1. url cross-origin: se ignora (sin location.href)', assignedHref === null, 'href=' + assignedHref);
  check('A1b. url cross-origin: sin ruteo', routedPath === null);
  fire('javascript:alert(1)');
  check('A2. url javascript:: se ignora', assignedHref === null && routedPath === null, 'href=' + assignedHref);
  fire(APP_ROOT + '#chat');
  check('A3. url legítima del app: se rutea', routedPath === 'chat' || assignedHref !== null,
    'routed=' + routedPath + ' href=' + assignedHref);
  fire(APP_ORIGIN + '/Beabo/post/abc123');
  check('A4. url legítima sin hash: se rutea dentro del origen',
    routedPath === 'post/abc123' && assignedHref === null,
    'routed=' + routedPath + ' href=' + assignedHref);
}

async function partB() {
  console.log('== Parte B: service worker (sw.js) ==');
  const swCode = fs.readFileSync(resolveRepoFile('sw.js'), 'utf8');
  check('B0. marcador R10-1 presente', swCode.indexOf('R10-1 (push hijack)') !== -1);

  const listeners = {};
  let waitPromise = null;
  const opened = [];
  const posted = [];
  let clientsImpl = null;
  const sandbox = {
    self: {
      addEventListener(t, fn) { listeners[t] = fn; },
      registration: { scope: APP_ROOT },
      location: { origin: APP_ORIGIN }
    },
    URL,
    console
  };
  Object.defineProperty(sandbox, 'clients', { get() { return clientsImpl; }, configurable: true });
  vm.createContext(sandbox);
  vm.runInContext(swCode, sandbox, { filename: 'sw.js' });
  check('B0b. handlers push/notificationclick registrados', !!(listeners['push'] && listeners['notificationclick']));

  async function clickWith(url, withWindow) {
    opened.length = 0; posted.length = 0; waitPromise = null;
    const fakeClient = withWindow ? {
      focus() {},
      postMessage(msg) { posted.push(msg); }
    } : null;
    clientsImpl = {
      matchAll: async () => (fakeClient ? [fakeClient] : []),
      openWindow: async (u) => { opened.push(u); return {}; }
    };
    const event = {
      notification: { close() {}, data: { url } },
      waitUntil(p) { waitPromise = Promise.resolve(p); }
    };
    listeners['notificationclick'](event);
    await waitPromise;
  }

  await clickWith(EVIL, false);
  check('B1. url cross-origin sin ventana: openWindow NO va a evil',
    opened.length === 1 && opened[0].indexOf('evil-phish') === -1, 'abrió ' + opened[0]);
  check('B1b. url cross-origin sin ventana: cae a la raíz de la app',
    opened.length === 1 && opened[0] === APP_ROOT, 'abrió ' + opened[0]);
  await clickWith(EVIL, true);
  check('B2. url cross-origin con ventana: postMessage NO lleva evil',
    posted.length === 1 && String(posted[0].url).indexOf('evil-phish') === -1, JSON.stringify(posted[0]));
  await clickWith('javascript:alert(1)', false);
  check('B3. url javascript:: cae a la raíz',
    opened.length === 1 && opened[0] === APP_ROOT, 'abrió ' + opened[0]);
  const legit = APP_ROOT + '#post/abc123';
  await clickWith(legit, false);
  check('B4. url legítima: openWindow la conserva',
    opened.length === 1 && opened[0] === legit, 'abrió ' + opened[0]);
  await clickWith(legit, true);
  check('B5. url legítima con ventana: postMessage la conserva',
    posted.length === 1 && posted[0].url === legit, JSON.stringify(posted[0]));
}

(async function main() {
  await partA();
  await partB();
  console.log(failures === 0 ? '\nPUSHFIX R10-1 OK' : '\nPUSHFIX R10-1 CON ' + failures + ' FALLOS');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
