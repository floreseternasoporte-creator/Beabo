// Ciclo 126 — Badging API (drexSyncAppBadge).
// Extrae la función EXACTA (verbatim) de index.html y la evalúa en un sandbox
// con un navigator falso. Sin red, determinista.
// Uso: node tests/test-c126-badging.js [ruta-a-index.html]
// Sale 0 si todo pasa, 1 si algo falla.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX = process.argv[2] || path.join(__dirname, '..', 'index.html');
const SRC = fs.readFileSync(INDEX, 'utf8');

// ---------- extracción verbatim ----------
function fnBlock(startSig) {
  const i = SRC.indexOf(startSig);
  if (i < 0) throw new Error('no encontrado: ' + startSig);
  const j = SRC.indexOf('\n  }\n', i);
  if (j < 0) throw new Error('sin cierre: ' + startSig);
  return SRC.slice(i, j + '\n  }\n'.length);
}
const CODE = fnBlock('  function drexSyncAppBadge(unread) {');
if (!CODE.includes('setAppBadge') || !CODE.includes('clearAppBadge')) {
  throw new Error('extracción incompleta: falta setAppBadge/clearAppBadge');
}

// ---------- sandbox ----------
function freshNav() {
  const calls = [];
  return {
    calls,
    navigator: {
      setAppBadge: (n) => { calls.push(['set', n]); return Promise.resolve(); },
      clearAppBadge: () => { calls.push(['clear']); return Promise.resolve(); },
    },
  };
}
function runWith(nav) {
  const sandbox = { navigator: nav.navigator, console, Math, JSON, Promise };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'badging.js' });
  return (code) => vm.runInContext(code, sandbox);
}

// ---------- mini framework (tcase con try/catch, como manda la regla) ----------
let passed = 0, failed = 0;
const pending = [];
function tcase(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { passed++; console.log('  ✅ ' + name); },
        (e) => { failed++; console.log('  ❌ ' + name + ' — ' + e.message); }
      ));
    } else { passed++; console.log('  ✅ ' + name); }
  } catch (e) { failed++; console.log('  ❌ ' + name + ' — ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert falló'); }

console.log('== Ciclo 126 — Badging API ==');
console.log('   index.html:', INDEX);

tcase('n>0 llama setAppBadge con el entero', () => {
  const nav = freshNav();
  const run = runWith(nav);
  run('drexSyncAppBadge(7)');
  assert(nav.calls.length === 1 && nav.calls[0][0] === 'set' && nav.calls[0][1] === 7,
    'calls=' + JSON.stringify(nav.calls));
});

tcase('decimal se trunca a entero (7.9 → 7)', () => {
  const nav = freshNav();
  const run = runWith(nav);
  run('drexSyncAppBadge(7.9)');
  assert(nav.calls.length === 1 && nav.calls[0][1] === 7, 'calls=' + JSON.stringify(nav.calls));
});

tcase('n=0 llama clearAppBadge y NO setAppBadge', () => {
  const nav = freshNav();
  const run = runWith(nav);
  run('drexSyncAppBadge(0)');
  assert(nav.calls.length === 1 && nav.calls[0][0] === 'clear', 'calls=' + JSON.stringify(nav.calls));
});

tcase('negativo se trata como 0 (clear)', () => {
  const nav = freshNav();
  const run = runWith(nav);
  run('drexSyncAppBadge(-5)');
  assert(nav.calls.length === 1 && nav.calls[0][0] === 'clear', 'calls=' + JSON.stringify(nav.calls));
});

tcase('no-numérico (NaN, "abc") se trata como 0 (clear)', () => {
  const nav = freshNav();
  const run = runWith(nav);
  run('drexSyncAppBadge(NaN)');
  run('drexSyncAppBadge("abc")');
  assert(nav.calls.length === 2 && nav.calls.every(c => c[0] === 'clear'),
    'calls=' + JSON.stringify(nav.calls));
});

tcase('string numérico "12" se acepta (set 12)', () => {
  const nav = freshNav();
  const run = runWith(nav);
  run('drexSyncAppBadge("12")');
  assert(nav.calls.length === 1 && nav.calls[0][0] === 'set' && nav.calls[0][1] === 12,
    'calls=' + JSON.stringify(nav.calls));
});

tcase('API ausente (navigator vacío) = no-op sin throw', () => {
  const run = runWith({ navigator: {} });
  run('drexSyncAppBadge(9)');
  run('drexSyncAppBadge(0)');
});

tcase('setAppBadge que lanza sync se traga (sin throw)', () => {
  const run = runWith({ navigator: { setAppBadge: () => { throw new Error('x'); }, clearAppBadge: () => {} } });
  run('drexSyncAppBadge(4)');
});

tcase('setAppBadge que rechaza la promesa se traga', async () => {
  const run = runWith({ navigator: {
    setAppBadge: () => Promise.reject(new Error('denied')),
    clearAppBadge: () => Promise.resolve(),
  } });
  run('drexSyncAppBadge(3)');
  await new Promise(r => setImmediate(r));
});

tcase('clearAppBadge que lanza sync se traga (sin throw)', () => {
  const run = runWith({ navigator: { setAppBadge: () => {}, clearAppBadge: () => { throw new Error('x'); } } });
  run('drexSyncAppBadge(0)');
});

tcase('hook: paintNotifUnreadBadge invoca drexSyncAppBadge(unread)', () => {
  const i = SRC.indexOf('  function paintNotifUnreadBadge(unread) {');
  assert(i >= 0, 'no encontrada paintNotifUnreadBadge');
  const j = SRC.indexOf('\n  }\n', i);
  const body = SRC.slice(i, j);
  assert(body.includes('drexSyncAppBadge(unread)'), 'falta el hook con guarda typeof');
  assert(body.includes('typeof drexSyncAppBadge'), 'falta la guarda typeof (harness c9)');
});

tcase('hook: clearNotificationsBadge limpia con drexSyncAppBadge(0)', () => {
  const i = SRC.indexOf('  function clearNotificationsBadge() {');
  assert(i >= 0, 'no encontrada clearNotificationsBadge');
  const j = SRC.indexOf('\n  }\n', i);
  const body = SRC.slice(i, j);
  assert(body.includes('drexSyncAppBadge(0)'), 'falta la limpieza en logout');
});

tcase('drexSyncAppBadge vive FUERA del bloque H2 (test-c9 intacto)', () => {
  const i = SRC.indexOf('  function drexSyncAppBadge(unread) {');
  const b = SRC.indexOf('// H2-FNS-BEGIN');
  const e = SRC.indexOf('// H2-FNS-END');
  assert(i > e, 'la función quedó dentro del bloque H2');
  assert(b >= 0 && e > b, 'marcadores H2 no encontrados');
});

(async () => {
  await Promise.all(pending);
  console.log(`\n${passed} pasados, ${failed} fallados`);
  process.exit(failed ? 1 : 0);
})();
