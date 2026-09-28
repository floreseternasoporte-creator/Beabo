/* ================================================================
 * AUTH-1: los codigos de respaldo deben funcionar en el login con
 * correo (2026-09-28).
 *
 * Causa raiz: en el desafio TOTP del login con correo
 * (signInWithEmailAndPassword -> totpRequired -> beginMfaChallenge
 * kind 'email'), la UI ofrece "Usar codigo de respaldo" y
 * submitTwoFactorChallenge encamina el codigo a ch.onCode(). Pero el
 * submitCode del camino de correo llama directo a
 * cognitoUser.sendMFACode(codigo) SIN distinguir un codigo de
 * respaldo de un TOTP: Cognito lo rechaza siempre ("Codigo
 * incorrecto") aunque el codigo de respaldo sea valido. El usuario
 * que pierde su app de autenticacion queda sin via de recuperacion
 * en el login con correo (el canje en servidor solo existe para
 * login con nombre de usuario, paso R de la Lambda).
 *
 * Comportamiento esperado: si el texto tiene forma de codigo de
 * respaldo, el camino de correo NO debe enviarlo a Cognito como
 * TOTP; debe rechazar con un error claro y accionable
 * (auth/recovery-needs-username) que indique usar el nombre de
 * usuario para canjearlo.
 *
 * Simula el flujo REAL con el SDK de Cognito falsificado:
 * authenticateUser -> totpRequired -> onCode('ABCD-EFGH').
 * Ejecutar con: node tests/test-auth1-email-backup-code.js
 * ================================================================ */
'use strict';
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var path = require('path');

var cloudSrc = fs.readFileSync(path.join(__dirname, '..', 'drex-cloud.js'), 'utf8');

var sentMfaCodes = [];      // codigos que llegaron a sendMFACode (Cognito)
var capturedChallenge = null;

var fakeCognitoUser = {
  authenticateUser: function (details, cbs) {
    setTimeout(function () { cbs.totpRequired('SOFTWARE_TOKEN_MFA', {}); }, 0);
  },
  sendMFACode: function (code, cbs) {
    sentMfaCodes.push(String(code));
    // Cognito rechaza cualquier cosa que no sea un TOTP valido.
    setTimeout(function () {
      cbs.onFailure({ code: 'CodeMismatchException', message: 'Invalid code' });
    }, 0);
  },
  getUsername: function () { return 'user@example.com'; }
};

var sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Promise: Promise,
  Math: Math,
  JSON: JSON,
  localStorage: {
    getItem: function () { return null; },
    setItem: function () {},
    removeItem: function () {}
  },
  AmazonCognitoIdentity: {
    CognitoUserPool: function () {
      return { getCurrentUser: function () { return null; } };
    },
    CognitoUser: function () { return fakeCognitoUser; },
    AuthenticationDetails: function () {}
  },
  __drexMfaUi: function (ch) { capturedChallenge = ch; }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(cloudSrc, sandbox, { filename: 'drex-cloud.js' });

var DrexCloud = sandbox.DrexCloud;
assert(DrexCloud && DrexCloud.auth, 'DrexCloud.auth expuesto');

var pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

async function main() {
  // 1. Login con correo dispara el desafio TOTP (kind 'email').
  var loginPromise = DrexCloud.auth().signInWithEmailAndPassword('user@example.com', 'pw123456');
  // Evita unhandled rejection del login (el desafio queda pendiente a proposito).
  loginPromise.catch(function () {});
  await new Promise(function (r) { setTimeout(r, 50); });
  ok(!!capturedChallenge, 'el desafio MFA se presenta a la UI');
  ok(capturedChallenge && capturedChallenge.kind === 'email', 'el desafio es kind=email');

  // 2. El usuario elige "codigo de respaldo" y escribe uno valido.
  var err = null, res = null;
  try {
    res = await capturedChallenge.onCode('ABCD-EFGH');
  } catch (e) { err = e; }

  // 3. El codigo de respaldo NUNCA debe viajar a Cognito como TOTP.
  ok(sentMfaCodes.indexOf('ABCD-EFGH') === -1,
    'el codigo de respaldo NO se envia a Cognito como TOTP (no llega a sendMFACode)');

  // 4. Se rechaza con un error claro y accionable (usar nombre de usuario).
  ok(!!err, 'onCode rechaza el codigo de respaldo en el camino de correo');
  ok(err && err.code === 'auth/recovery-needs-username',
    'el error es auth/recovery-needs-username (recibido: ' + (err && err.code) + ')');
  ok(err && /nombre de usuario/i.test(err.message || ''),
    'el mensaje indica usar el nombre de usuario');

  // 5. Un TOTP normal de 6 digitos SIGUE yendo a Cognito (sin regresion).
  sentMfaCodes.length = 0;
  var err2 = null;
  try { await capturedChallenge.onCode('123456'); } catch (e) { err2 = e; }
  ok(sentMfaCodes.indexOf('123456') !== -1,
    'un TOTP de 6 digitos sigue enviandose a Cognito (sendMFACode)');
  ok(err2 && err2.code === 'auth/invalid-mfa-code',
    'el TOTP invalido se mapea a auth/invalid-mfa-code (recibido: ' + (err2 && err2.code) + ')');

  // Limpieza: cancela el desafio para apagar el temporizador MFA (5 min).
  try { capturedChallenge.onCancel(); } catch (_) {}

  console.log('\nAUTH-1: ' + pass + ' ok, ' + fail + ' fallos');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error('FALLO inesperado:', e); process.exit(1); });
