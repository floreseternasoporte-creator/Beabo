/* Pruebas de regresión: diagnóstico de red en fallos de pago (drexPayNetDiag).
 *
 * Historia (2026-10-02): el usuario tocó "Suscribirme" y recibió el error de
 * red aunque el servidor de pagos estaba sano (verificado directo: 200 en /,
 * 400/401 correctos, CORS OK). La causa raíz estaba en la red de su iPhone
 * hacia *.lambda-url.us-east-1.on.aws, pero el mensaje descartaba los
 * detalles del fallo real.
 *
 * Lo que fija este test:
 *  1. Existe la función global drexPayNetDiag().
 *  2. Prueba 3 puntos: App (origen propio), Internet (general) y Pagos
 *     (endpoint de la Lambda), en paralelo y con timeout.
 *  3. La rama network/timeout de orbitSubscribe (Orbit) la invoca y muestra
 *     el resultado en el toast.
 *  4. La rama network/timeout del flujo de Drex Coins hace lo mismo.
 *  5. Las claves ES nuevas existen traducidas en EN/ZH/PT.
 *  6. La función parsea sin errores de sintaxis.
 *
 * Uso: node tests/test-pay-net-diag.js   (código 0 = todo OK)
 */
var fs = require('fs');
var path = require('path');
var assert = require('assert');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var i18n = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

function diagFnSource() {
  var start = html.indexOf('function drexPayNetDiag()');
  assert(start !== -1, 'no se encontró function drexPayNetDiag()');
  // Cortar hasta el cierre del bloque: buscar "}\n\nasync function orbitSubscribe"
  var end = html.indexOf('async function orbitSubscribe(planId)', start);
  assert(end !== -1, 'no se encontró el fin de drexPayNetDiag');
  return html.slice(start, end);
}

/* 1. La función existe y es global. */
test('drexPayNetDiag existe como función global', function () {
  assert(html.indexOf('function drexPayNetDiag()') !== -1, 'ausente en index.html');
});

/* 2. Prueba los 3 puntos en paralelo con timeout. */
test('drexPayNetDiag prueba App, Internet y Pagos', function () {
  var src = diagFnSource();
  assert(src.indexOf("probe('App'") !== -1, 'falta probe App');
  assert(src.indexOf("probe('Internet'") !== -1, 'falta probe Internet');
  assert(src.indexOf("probe('Pagos'") !== -1, 'falta probe Pagos');
  assert(/Promise\.all\(tests\)/.test(src), 'las pruebas deben correr en paralelo');
  assert(/setTimeout/.test(src), 'debe tener timeout por prueba');
  assert(/mode:\s*'no-cors'/.test(src), 'debe usar no-cors para no contaminar con CORS');
});

/* 2b. v2: además hace un POST real al checkout (como el pago de verdad). */
test('drexPayNetDiag v2 incluye prueba POST real al checkout', function () {
  var src = diagFnSource();
  assert(src.indexOf('postProbe') !== -1, 'falta postProbe');
  assert(src.indexOf('/create-subscription-session') !== -1, 'el POST debe ir al endpoint de checkout');
  assert(/method:\s*'POST'/.test(src), 'postProbe debe usar POST');
  assert(/'Content-Type':\s*'text\/plain/.test(src), 'postProbe debe usar text/plain como el pago real');
});

/* 3. orbitSubscribe invoca el diagnóstico en fallos de red. */
test('orbitSubscribe usa drexPayNetDiag en network/timeout', function () {
  var start = html.indexOf('async function orbitSubscribe(planId)');
  assert(start !== -1, 'no se encontró orbitSubscribe');
  var seg = html.slice(start, start + 2200);
  assert(seg.indexOf('drexPayNetDiag()') !== -1, 'orbitSubscribe no invoca el diagnóstico');
  assert(seg.indexOf('Mándanos captura de este mensaje para arreglarlo.') !== -1,
    'no pide captura del diagnóstico');
});

/* 4. El flujo de Drex Coins también lo usa. */
test('flujo Drex Coins usa drexPayNetDiag en network/timeout', function () {
  var key = 'No se pudo contactar el servidor de pagos.';
  var idx = html.indexOf("toast(t('" + key + "')");
  assert(idx !== -1, 'no se encontró la rama de diagnóstico en coins');
  var seg = html.slice(Math.max(0, idx - 400), idx + 200);
  assert(seg.indexOf('drexPayNetDiag()') !== -1, 'coins no invoca el diagnóstico');
});

/* 5. Claves traducidas en EN/ZH/PT. */
test('claves del diagnóstico traducidas en EN/ZH/PT', function () {
  var keys = [
    'Revisando tu conexión…',
    'No pudimos contactar el servidor de pagos.',
    'Mándanos captura de este mensaje para arreglarlo.',
    'No se pudo contactar el servidor de pagos.'
  ];
  var en = ['Checking your connection…',
    "We couldn't reach the payment server.",
    'Send us a screenshot of this message so we can fix it.',
    "The payment server couldn't be reached."];
  var zh = ['正在检查你的连接…', '无法连接到支付服务器。',
    '请截图此消息发送给我们以便修复。', '无法连接到支付服务器。'];
  var pt = ['Verificando sua conexão…',
    'Não conseguimos alcançar o servidor de pagamentos.',
    'Envie-nos uma captura de tela desta mensagem para corrigirmos.',
    'Não foi possível alcançar o servidor de pagamentos.'];
  keys.forEach(function (k, i) {
    assert(i18n.indexOf('"' + k + '":"' + en[i] + '"') !== -1, 'falta EN: ' + k);
    assert(i18n.indexOf('"' + k + '":"' + zh[i] + '"') !== -1, 'falta ZH: ' + k);
    assert(i18n.indexOf('"' + k + '":"' + pt[i] + '"') !== -1, 'falta PT: ' + k);
  });
});

/* 6. La función parsea sin errores de sintaxis. */
test('drexPayNetDiag tiene sintaxis válida', function () {
  var src = diagFnSource();
  vm.compileFunction(src, [], { parsingContext: vm.createContext({}) });
});

console.log('\n' + passed + ' pasadas, ' + failed + ' fallidas.');
process.exit(failed ? 1 : 0);
