/* ================================================================
 * AUTH-7 (2026-09-28):
 *  Parte A (FIX-URG-2): "No fui yo" en la alerta de dispositivo nuevo
 *   debe cerrar de verdad la sesión del intruso. Antes solo borraba el
 *   registro del dispositivo y pedía cambiar la contraseña: el atacante
 *   seguía con sesión válida. Ahora además llama a
 *   DrexCloud.revokeOtherDrexSessions() (marca revoked:true en todas las
 *   demás sesiones; el otro dispositivo cierra sesión y revoca tokens).
 *  Parte B (FIX-URG-3): anti-enumeración de cuentas en el login por
 *   correo. Cognito distingue UserNotFoundException de
 *   NotAuthorizedException y la UI mostraba mensajes distintos
 *   ("no se encontró ninguna cuenta con este correo" vs "contraseña
 *   incorrecta"): un atacante podía probar qué correos están
 *   registrados. Ahora ambas devuelven el mismo mensaje genérico
 *   (estándar Meta).
 * Prueba: funciones extraídas del index.html real en vm con fakes.
 * Ejecutar con: node tests/test-auth7-nofuiyo-antienumeracion.js
 * ================================================================ */
'use strict';
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var path = require('path');

var pass = 0, failCount = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { failCount++; console.log('  FAIL ' + name); }
}

function extract(html, startMarker, endMarker) {
  var start = html.indexOf(startMarker);
  assert(start !== -1, 'no se encontró: ' + startMarker);
  var end = html.indexOf(endMarker, start + startMarker.length);
  assert(end !== -1 && end > start, 'no se encontró fin para: ' + startMarker);
  return html.slice(start, end + endMarker.length);
}

async function partA() {
  console.log('Parte A — "No fui yo" cierra las demás sesiones');
  var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  var code = extract(html, 'async function drexDenyNewDevice() {', '\n}\n');
  assert(code.indexOf('revokeOtherDrexSessions') !== -1, 'drexDenyNewDevice llama a revokeOtherDrexSessions');

  var removed = [], events = [], revokedOthers = 0, hidden = 0, opened = 0;
  var sandbox = {
    console: console,
    window: { _drexPendingNewDevice: { fpHash: 'abc123', label: 'iPhone · Safari' } },
    drexHideNewDeviceAlert: function () { hidden++; },
    DrexCloud: {
      auth: function () { return { currentUser: { uid: 'u1' } }; },
      database: function () {
        return { ref: function (p) { return { remove: function () { removed.push(p); return Promise.resolve(); } }; } };
      },
      revokeOtherDrexSessions: function () { revokedOthers++; return Promise.resolve(); }
    },
    recordSecurityEvent: function (t, d) { events.push({ title: t, detail: d }); return Promise.resolve(); },
    openSecurityCenter: function () { opened++; },
    securityToast: function () {},
    appT: function (s) { return s; }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'deny-device.js' });

  await sandbox.drexDenyNewDevice();

  ok(removed.indexOf('users/u1/devices/abc123') !== -1, 'se elimina el registro del dispositivo no reconocido');
  ok(revokedOthers === 1, '"No fui yo" revoca todas las demás sesiones (el intruso sale)');
  ok(events.length === 1 && events[0].detail.indexOf('Se cerraron las demás sesiones') !== -1,
    'el evento de seguridad refleja el cierre de sesiones');
  ok(sandbox.window._drexPendingNewDevice === null, 'se limpia el dispositivo pendiente');
  ok(hidden === 1, 'se oculta la alerta');
}

function partB() {
  console.log('Parte B — el login por correo no distingue cuenta inexistente');
  var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  var gfe = extract(html, 'function getFriendlyErrorMessage(error) {', '\n  }\n');
  var ffi = extract(html, 'const friendlyForId = (err) => {', '\n        };');

  var sandbox = { console: console, appT: function (s) { return s; } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(gfe, sandbox, { filename: 'gfe.js' });

  function runWith(isUsername, err) {
    var s2 = { console: console, appT: function (x) { return x; }, isUsername: isUsername,
      getFriendlyErrorMessage: sandbox.getFriendlyErrorMessage };
    s2.globalThis = s2;
    vm.createContext(s2);
    vm.runInContext(ffi + '\nthis.__r = friendlyForId(' + JSON.stringify(err) + ');', s2, { filename: 'ffi.js' });
    return s2.__r;
  }

  var notFound = runWith(false, { code: 'auth/user-not-found' });
  var wrongPw = runWith(false, { code: 'auth/wrong-password' });
  ok(notFound === wrongPw, 'correo: cuenta inexistente y contraseña incorrecta devuelven el mismo mensaje ("' + notFound + '")');
  ok(notFound === 'Correo o contraseña incorrectos.', 'el mensaje genérico es el esperado');
  var userPath = runWith(true, { code: 'auth/user-not-found' });
  ok(userPath === 'No se encontró ninguna cuenta con ese nombre de usuario.',
    'la ruta de usuario conserva su mensaje (la Lambda ya es genérica: 401 único)');
}

async function main() {
  await partA();
  partB();
  console.log('\nAUTH-7: ' + pass + ' ok, ' + failCount + ' fallos');
  process.exit(failCount ? 1 : 0);
}
main().catch(function (e) { console.error('FALLO inesperado:', e); process.exit(1); });
