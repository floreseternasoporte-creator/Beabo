/* ================================================================
 * Tests del service worker (sw.js): networkFirst y fallback offline
 * Ejecutar con: node tests/test-sw.js
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */

var assert = require('assert');
var fs = require('fs');

// --- Mocks del entorno del SW ---
var handlers = {};
var store = new Map(); // "caché" en memoria: key -> {ok, type, body}
function cacheKeyOf(req) { return typeof req === 'string' ? req : req.url; }

global.self = {
  addEventListener: function (type, fn) { handlers[type] = fn; },
  skipWaiting: function () { return Promise.resolve(); },
  clients: { claim: function () { return Promise.resolve(); } },
  registration: { scope: 'https://x.test/Beabo/' }
};
global.caches = {
  open: function () {
    return Promise.resolve({
      put: function (req, res) { store.set(cacheKeyOf(req), res); return Promise.resolve(); },
      add: function (url) {
        return global.fetch(url).then(function (res) {
          if (!res.ok) throw new Error('bad');
          store.set(cacheKeyOf(url), res);
        });
      },
      match: function (req) { return Promise.resolve(store.get(cacheKeyOf(req)) || undefined); }
    });
  },
  keys: function () { return Promise.resolve(['drex-sw-test']); },
  delete: function () { return Promise.resolve(true); },
  match: function (req) { return Promise.resolve(store.get(cacheKeyOf(req)) || undefined); }
};
// fetch programable: url -> {ok, type, body} o rechazo
var fetchRoutes = {};
global.fetch = function (req) {
  var url = cacheKeyOf(req);
  if (fetchRoutes[url] === 'REJECT') return Promise.reject(new Error('offline'));
  var r = fetchRoutes[url] || { ok: true, type: 'basic', body: 'OK:' + url };
  return Promise.resolve({
    ok: !!r.ok, type: r.type || 'basic', url: url,
    clone: function () { return { ok: !!r.ok, type: r.type || 'basic', url: url, body: r.body }; }
  });
};
function fakeRequest(url, mode) {
  return { method: 'GET', mode: mode || '', url: url, headers: { get: function () { return ''; } } };
}
function dispatchFetch(req) {
  var responded = null;
  handlers['fetch']({ request: req, respondWith: function (p) { responded = p; } });
  return Promise.resolve(responded);
}

eval(fs.readFileSync(__dirname + '/../sw.js', 'utf8'));

var passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(function () {
    console.log('  \u2713 ' + name); passed++;
  }).catch(function (e) {
    console.log('  \u2717 ' + name + ': ' + e.message); failed++;
  });
}

async function runAll() {
  console.log('\nsw.js — networkFirst y fallback:');

  await test('navegación online 200 se cachea', async function () {
    store.clear();
    fetchRoutes = { 'https://x.test/Beabo/': { ok: true, body: '<html>' } };
    var res = await dispatchFetch(fakeRequest('https://x.test/Beabo/', 'navigate'));
    assert(res && res.ok, 'debe devolver la respuesta');
    assert(store.get('https://x.test/Beabo/'), 'debe quedar en caché');
  });

  await test('respuesta 500 NO se cachea (no envenena la caché)', async function () {
    store.clear();
    fetchRoutes = { 'https://x.test/Beabo/': { ok: false, body: 'Error' } };
    var res = await dispatchFetch(fakeRequest('https://x.test/Beabo/', 'navigate'));
    assert(res && !res.ok, 'devuelve el 500 tal cual');
    assert(!store.get('https://x.test/Beabo/'), 'el 500 no debe cachearse');
  });

  await test('navegación offline con copia en caché la sirve', async function () {
    store.clear();
    store.set('https://x.test/Beabo/', { ok: true, body: '<html>cached' });
    fetchRoutes = { 'https://x.test/Beabo/': 'REJECT' };
    var res = await dispatchFetch(fakeRequest('https://x.test/Beabo/', 'navigate'));
    assert(res && res.body === '<html>cached', 'sirve la copia en caché');
  });

  await test('ruta profunda offline sin caché cae a ./index.html', async function () {
    store.clear();
    store.set('./index.html', { ok: true, body: '<html>app' });
    fetchRoutes = { 'https://x.test/Beabo/algun/ruta': 'REJECT' };
    var res = await dispatchFetch(fakeRequest('https://x.test/Beabo/algun/ruta', 'navigate'));
    assert(res && res.body === '<html>app', 'fallback a index.html, obtuvo: ' + (res && res.body));
  });

  await test('.js offline sin caché NO recibe HTML (sigue siendo error)', async function () {
    store.clear();
    store.set('./index.html', { ok: true, body: '<html>app' });
    fetchRoutes = { 'https://x.test/Beabo/drex-cloud.js': 'REJECT' };
    var res = await dispatchFetch(fakeRequest('https://x.test/Beabo/drex-cloud.js', ''));
    assert(res === undefined, 'un .js sin caché no debe recibir el HTML');
  });

  await test('estático 404 no se guarda en caché', async function () {
    store.clear();
    fetchRoutes = { 'https://x.test/Beabo/icon-192.png': { ok: false, body: 'nf' } };
    var res = await dispatchFetch(fakeRequest('https://x.test/Beabo/icon-192.png', ''));
    assert(res && !res.ok, 'devuelve el 404');
    assert(!store.get('https://x.test/Beabo/icon-192.png'), 'el 404 no debe cachearse');
  });

  console.log('\n========================================');
  console.log('Resumen: ' + passed + ' pasados, ' + failed + ' fallidos');
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(function (e) { console.error(e); process.exit(1); });
