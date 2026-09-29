/* ================================================================
 * Tests del failover de red de DrexPay (2026-09-29).
 * - La petición usa Content-Type text/plain (CORS "simple": el navegador
 *   NO envía preflight OPTIONS, que en iOS falla de forma intermitente).
 * - Hasta 4 intentos con backoff; AbortError -> Error('timeout').
 * - Los errores HTTP del backend NO se reintentan (fail fast).
 * - Éxito en el intento N -> redirige a data.url.
 * - Paridad i18n del mensaje de timeout en EN/ZH/PT.
 * Ejecutar con: node tests/test-drexpay-failover.js
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');

var html = fs.readFileSync(__dirname + '/../index.html', 'utf8');

function extractFn(src, startMarker) {
  var i = src.indexOf(startMarker);
  assert(i !== -1, 'no se encontró ' + startMarker);
  var j = src.indexOf('{', i);
  var depth = 0, k = j;
  for (; k < src.length; k++) {
    var ch = src[k];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  assert(depth === 0, 'llaves desbalanceadas en ' + startMarker);
  return src.slice(i, k + 1);
}

var fnSrc = extractFn(html, 'async function drexStripeCheckout(pkg)');
var lastInit = null;

function makeSandbox(opts) {
  opts = opts || {};
  var fetchCalls = 0;
  var sandbox = {
    DREX_PAYMENTS_ENDPOINT: 'https://pay.example/',
    DrexCloud: {
      auth: function () {
        return { getIdToken: async function () { return 'tok123'; } };
      }
    },
    location: { origin: 'https://app.example', pathname: '/index.html', href: '' },
    fetch: async function (url, init) {
      fetchCalls++;
      lastInit = init || null;
      return opts.fetchImpl(fetchCalls);
    },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    AbortController: AbortController,
    console: console,
    Promise: Promise
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox);
  return { sandbox: sandbox, fetchCalls: function () { return fetchCalls; } };
}

function okUrl() {
  return { ok: true, status: 200, json: async function () { return { url: 'https://checkout.stripe/x' }; } };
}

var passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + (e && e.message)); }
}

(async function () {
  await test('usa Content-Type text/plain (petición CORS simple, sin preflight)', async function () {
    lastInit = null;
    var s = makeSandbox({ fetchImpl: async function () { return okUrl(); } });
    await s.sandbox.drexStripeCheckout({ id: 'coins_100' });
    var ct = String((lastInit && lastInit.headers && lastInit.headers['Content-Type']) || '');
    assert(ct.indexOf('text/plain') === 0, 'Content-Type fue: ' + ct);
    assert(ct.indexOf('application/json') === -1, 'no debe usar application/json');
  });

  await test('TypeError persistente: 4 intentos y lanza network', async function () {
    var s = makeSandbox({
      fetchImpl: async function () { throw new TypeError('Failed to fetch'); }
    });
    var err = null;
    try { await s.sandbox.drexStripeCheckout({ id: 'coins_100' }); }
    catch (e) { err = e; }
    assert(err && err.message === 'network', 'esperaba network, fue: ' + (err && err.message));
    assert(s.fetchCalls() === 4, 'esperaba 4 intentos, fueron ' + s.fetchCalls());
  });

  await test('AbortError (timeout) -> timeout con mensaje propio', async function () {
    var s = makeSandbox({
      fetchImpl: async function () { var e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    });
    var err = null;
    try { await s.sandbox.drexStripeCheckout({ id: 'coins_100' }); }
    catch (e) { err = e; }
    assert(err && err.message === 'timeout', 'esperaba timeout, fue: ' + (err && err.message));
    assert(s.fetchCalls() === 4, 'esperaba 4 intentos, fueron ' + s.fetchCalls());
  });

  await test('falla 2 veces, 3er intento ok -> redirige', async function () {
    var s = makeSandbox({
      fetchImpl: async function (n) {
        if (n < 3) throw new TypeError('Failed to fetch');
        return okUrl();
      }
    });
    await s.sandbox.drexStripeCheckout({ id: 'coins_100' });
    assert(s.sandbox.location.href === 'https://checkout.stripe/x', 'no redirigió');
    assert(s.fetchCalls() === 3, 'esperaba 3 intentos, fueron ' + s.fetchCalls());
  });

  await test('error HTTP del backend NO se reintenta (fail fast)', async function () {
    var s = makeSandbox({
      fetchImpl: async function () {
        return { ok: false, status: 500, json: async function () { throw new Error('no json'); } };
      }
    });
    var err = null;
    try { await s.sandbox.drexStripeCheckout({ id: 'coins_100' }); }
    catch (e) { err = e; }
    assert(err && err.message === 'backend:http_500', 'mensaje: ' + (err && err.message));
    assert(s.fetchCalls() === 1, 'no debió reintentar; intentos: ' + s.fetchCalls());
  });

  await test('i18n: el mensaje de timeout existe en EN/ZH/PT', function () {
    var src = fs.readFileSync(__dirname + '/../drex-i18n.js', 'utf8');
    var k = 'El servidor de pagos está tardando demasiado en responder. Revisa tu conexión e inténtalo de nuevo.';
    function dict(name, next) {
      var a = src.indexOf(name), b = src.indexOf(next, a);
      var sec = src.slice(a, b);
      return sec.slice(sec.indexOf('{'), sec.lastIndexOf('\n};') + 2);
    }
    var EN = dict('var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {');
    var ZH = dict('var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {');
    var PT = dict('var APP_PORTUGUESE_TEXT = {', 'var APP_CHINESE_ATTRS = {');
    assert(EN.indexOf(JSON.stringify(k)) !== -1, 'falta en EN');
    assert(ZH.indexOf(JSON.stringify(k)) !== -1, 'falta en ZH');
    assert(PT.indexOf(JSON.stringify(k)) !== -1, 'falta en PT');
  });

  await test('index.html: el catch mapea timeout a su toast', function () {
    var i = html.indexOf('var st = (e && e.status) || 0;');
    assert(i !== -1, 'no se encontró el catch granular');
    var sec = html.slice(i, i + 1400);
    assert(sec.indexOf("m === 'timeout'") !== -1, 'falta rama timeout');
    assert(sec.indexOf("m === 'network'") !== -1, 'falta rama network');
  });

  console.log('\n' + passed + ' ok, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
})();
