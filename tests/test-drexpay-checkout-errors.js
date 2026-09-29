/* ================================================================
 * Tests del checkout de Drex Coins: errores estructurados.
 * - Fallo de red (fetch lanza) -> Error('network') tras 1 reintento.
 * - Backend 4xx/5xx -> Error('backend:<code>') con .status.
 * - Respuesta ok con url -> redirige (location.href).
 * - Sin endpoint -> Error('no-provider'); sin token -> Error('no-token').
 * - Paridad i18n de los 3 mensajes nuevos en EN/ZH/PT.
 * Ejecutar con: node tests/test-drexpay-checkout-errors.js
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

function makeSandbox(opts) {
  opts = opts || {};
  var fetchCalls = 0;
  var sandbox = {
    DREX_PAYMENTS_ENDPOINT: opts.endpoint === undefined ? 'https://pay.example/' : opts.endpoint,
    DrexCloud: {
      auth: function () {
        return { getIdToken: async function () { return opts.token === undefined ? 'tok123' : opts.token; } };
      }
    },
    location: { origin: 'https://app.example', pathname: '/index.html', href: '' },
    fetch: async function () {
      fetchCalls++;
      return opts.fetchImpl(fetchCalls);
    },
    setTimeout: setTimeout,
    console: console,
    Promise: Promise
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox);
  return { sandbox: sandbox, fetchCalls: function () { return fetchCalls; } };
}

var passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + (e && e.message)); }
}

(async function () {
  await test('fallo de red: reintenta 1 vez y lanza network', async function () {
    var s = makeSandbox({
      fetchImpl: async function () { throw new TypeError('Failed to fetch'); }
    });
    var err = null;
    try { await s.sandbox.drexStripeCheckout({ id: 'coins_100' }); }
    catch (e) { err = e; }
    assert(err && err.message === 'network', 'esperaba network, fue: ' + (err && err.message));
    assert(s.fetchCalls() === 2, 'esperaba 2 intentos, fueron ' + s.fetchCalls());
  });

  await test('red inestable: 1er intento falla, 2do ok -> redirige', async function () {
    var s = makeSandbox({
      fetchImpl: async function (n) {
        if (n === 1) throw new TypeError('Failed to fetch');
        return { ok: true, status: 200, json: async function () { return { url: 'https://checkout.stripe/x' }; } };
      }
    });
    await s.sandbox.drexStripeCheckout({ id: 'coins_100' });
    assert(s.sandbox.location.href === 'https://checkout.stripe/x', 'no redirigió');
    assert(s.fetchCalls() === 2, 'esperaba 2 intentos');
  });

  await test('backend 401 -> backend:invalid_token con status 401', async function () {
    var s = makeSandbox({
      fetchImpl: async function () {
        return { ok: false, status: 401, json: async function () { return { error: 'invalid_token' }; } };
      }
    });
    var err = null;
    try { await s.sandbox.drexStripeCheckout({ id: 'coins_100' }); }
    catch (e) { err = e; }
    assert(err && err.message === 'backend:invalid_token', 'mensaje: ' + (err && err.message));
    assert(err.status === 401, 'status: ' + err.status);
  });

  await test('backend 500 sin json -> backend:http_500 con status 500', async function () {
    var s = makeSandbox({
      fetchImpl: async function () {
        return { ok: false, status: 500, json: async function () { throw new Error('no json'); } };
      }
    });
    var err = null;
    try { await s.sandbox.drexStripeCheckout({ id: 'coins_100' }); }
    catch (e) { err = e; }
    assert(err && err.message === 'backend:http_500', 'mensaje: ' + (err && err.message));
    assert(err.status === 500, 'status: ' + err.status);
  });

  await test('sin endpoint -> no-provider', async function () {
    var s = makeSandbox({ endpoint: '' });
    var err = null;
    try { await s.sandbox.drexStripeCheckout({ id: 'coins_100' }); }
    catch (e) { err = e; }
    assert(err && err.message === 'no-provider', 'mensaje: ' + (err && err.message));
  });

  await test('sin token -> no-token', async function () {
    var s = makeSandbox({ token: null });
    var err = null;
    try { await s.sandbox.drexStripeCheckout({ id: 'coins_100' }); }
    catch (e) { err = e; }
    assert(err && err.message === 'no-token', 'mensaje: ' + (err && err.message));
  });

  await test('i18n: los 3 mensajes nuevos existen en EN/ZH/PT', function () {
    var src = fs.readFileSync(__dirname + '/../drex-i18n.js', 'utf8');
    var keys = [
      'No se pudo conectar con el servidor de pagos. Revisa tu conexión a internet e inténtalo de nuevo.',
      'Tu sesión expiró. Cierra sesión y vuelve a entrar para comprar.',
      'Demasiados intentos. Espera un minuto e inténtalo de nuevo.'
    ];
    function dict(name, next) {
      var a = src.indexOf(name), b = src.indexOf(next, a);
      var sec = src.slice(a, b);
      return sec.slice(sec.indexOf('{'), sec.lastIndexOf('\n};') + 2);
    }
    var EN = dict('var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {');
    var ZH = dict('var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {');
    var PT = dict('var APP_PORTUGUESE_TEXT = {', 'var APP_CHINESE_ATTRS = {');
    keys.forEach(function (k) {
      assert(EN.indexOf(JSON.stringify(k)) !== -1, 'falta en EN: ' + k.slice(0, 30));
      assert(ZH.indexOf(JSON.stringify(k)) !== -1, 'falta en ZH: ' + k.slice(0, 30));
      assert(PT.indexOf(JSON.stringify(k)) !== -1, 'falta en PT: ' + k.slice(0, 30));
    });
  });

  await test('index.html: el catch mapea network/401-403/429 a toasts distintos', function () {
    var i = html.indexOf('var st = (e && e.status) || 0;');
    assert(i !== -1, 'no se encontró el catch granular');
    var sec = html.slice(i, i + 1200);
    assert(sec.indexOf("m === 'network'") !== -1, 'falta rama network');
    assert(sec.indexOf('st === 401 || st === 403') !== -1, 'falta rama 401/403');
    assert(sec.indexOf('st === 429') !== -1, 'falta rama 429');
    assert(sec.indexOf('DrexPay.lastError') !== -1, 'falta lastError para diagnóstico');
  });

  console.log('\n' + passed + ' ok, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
})();
