/* ================================================================
 * AUTH-3: al vencer la ventana del codigo MFA (5 min), el desafio de
 * la UI debe cerrarse (2026-09-28).
 *
 * Causa raiz: el temporizador MFA en drex-cloud.js (login con correo
 * y con nombre de usuario) llamaba fail(mfaExpiredError()) y con eso
 * solo rechazaba la promesa del login. El overlay
 * #twofactor-challenge-view quedaba ABIERTO sobre un login ya muerto:
 * el usuario quedaba atrapado — cualquier codigo posterior se traga
 * en silencio (done=true) o falla con un mensaje confuso, sin forma
 * de volver al formulario.
 *
 * Comportamiento esperado: al vencer, drex-cloud.js invoca
 * challenge.onExpired() (gancho que expone installMfaChallengeUi) y
 * la vista se oculta; el mensaje de vencimiento lo muestra el
 * formulario de login.
 *
 * Parte A: drex-cloud.js con el SDK de Cognito falsificado y
 * setTimeout espiado (se dispara a mano el temporizador de 5 min).
 * Parte B: installMfaChallengeUi extraido de index.html con DOM
 * falsificado: el desafio expuesto debe traer onExpired y al
 * invocarlo la vista se oculta y __drexMfaChallenge queda en null.
 * Ejecutar con: node tests/test-auth3-mfa-expiry-closes-challenge.js
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

function fakeClassList() {
  var added = [], removed = [];
  return {
    added: added, removed: removed,
    add: function (c) { added.push(c); },
    remove: function (c) { removed.push(c); },
    contains: function (c) { return added.indexOf(c) !== -1; }
  };
}

async function partA() {
  console.log('Parte A — drex-cloud.js avisa el vencimiento al desafio');
  var cloudSrc = fs.readFileSync(path.join(__dirname, '..', 'drex-cloud.js'), 'utf8');

  var timers = []; // {fn, ms}
  var timerId = 0;
  var capturedChallenge = null;
  var onExpiredCalls = [];

  var fakeCognitoUser = {
    authenticateUser: function (details, cbs) {
      setTimeout(function () { cbs.totpRequired('SOFTWARE_TOKEN_MFA', {}); }, 0);
    },
    sendMFACode: function () {},
    getUsername: function () { return 'user@example.com'; }
  };

  var sandbox = {
    console: console,
    setTimeout: function (fn, ms) { timerId++; timers.push({ id: timerId, fn: fn, ms: ms }); return timerId; },
    clearTimeout: function () {},
    Promise: Promise, Math: Math, JSON: JSON,
    localStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
    AmazonCognitoIdentity: {
      CognitoUserPool: function () { return { getCurrentUser: function () { return null; } }; },
      CognitoUser: function () { return fakeCognitoUser; },
      AuthenticationDetails: function () {}
    },
    // Imita installMfaChallengeUi: presenta el desafio y expone onExpired.
    __drexMfaUi: function (ch) {
      capturedChallenge = ch;
      ch.onExpired = function (err) { onExpiredCalls.push(err); };
      sandbox.__drexMfaChallenge = ch;
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(cloudSrc, sandbox, { filename: 'drex-cloud.js' });

  var DrexCloud = sandbox.DrexCloud;
  var loginErr = null;
  var loginPromise = DrexCloud.auth().signInWithEmailAndPassword('user@example.com', 'pw123456');
  loginPromise.catch(function (e) { loginErr = e; });
  await new Promise(function (r) { setTimeout(r, 50); });

  ok(!!capturedChallenge, 'el desafio MFA se presenta a la UI');
  var mfaTimer = timers.filter(function (t) { return t.ms === 5 * 60 * 1000; })[0];
  ok(!!mfaTimer, 'existe el temporizador de vencimiento de 5 minutos');

  // Dispara el vencimiento a mano.
  mfaTimer.fn();
  await new Promise(function (r) { setTimeout(r, 50); });

  ok(onExpiredCalls.length === 1, 'al vencer se invoca challenge.onExpired() en la UI');
  ok(onExpiredCalls[0] && onExpiredCalls[0].code === 'auth/mfa-expired',
    'onExpired recibe el error auth/mfa-expired');
  ok(loginErr && loginErr.code === 'auth/mfa-expired',
    'la promesa del login rechaza con auth/mfa-expired (recibido: ' + (loginErr && loginErr.code) + ')');
}

function partB() {
  console.log('Parte B — installMfaChallengeUi expone onExpired que cierra la vista');
  var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  var startMarker = 'window.__drexMfaChallenge = null;';
  var start = html.indexOf(startMarker);
  assert(start !== -1, 'puente MFA no encontrado en index.html');
  var endMarker = '// Red de seguridad legacy';
  var end = html.indexOf(endMarker, start);
  assert(end !== -1 && end > start, 'fin del puente MFA no encontrado');
  var code = html.slice(start, end);
  assert(code.indexOf('function installMfaChallengeUi()') !== -1, 'installMfaChallengeUi no esta en el bloque');

  var viewClasses = fakeClassList();
  var els = {
    'twofactor-challenge-view': { classList: viewClasses },
    'twofactor-challenge-input': {
      classList: fakeClassList(), value: '',
      setAttribute: function () {}, focus: function () {}
    },
    'twofactor-challenge-error': { classList: fakeClassList(), textContent: '' },
    'twofactor-challenge-backup-link': { classList: fakeClassList(), textContent: '' }
  };
  var sandbox = {
    console: console,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    document: { getElementById: function (id) { return els[id] || null; } },
    appT: function (s) { return s; }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'mfa-bridge.js' });

  assert(typeof sandbox.installMfaChallengeUi === 'function', 'installMfaChallengeUi extraido');
  sandbox.installMfaChallengeUi();
  assert(typeof sandbox.__drexMfaUi === 'function', '__drexMfaUi instalado');

  var challenge = { kind: 'email' };
  sandbox.__drexMfaUi(challenge);
  ok(sandbox.__drexMfaChallenge === challenge, 'el desafio queda en window.__drexMfaChallenge');
  ok(typeof challenge.onExpired === 'function', 'el desafio expone onExpired()');

  // Vence la ventana: la vista debe ocultarse y el desafio liberarse.
  viewClasses.added.length = 0;
  challenge.onExpired({ code: 'auth/mfa-expired' });
  ok(viewClasses.added.indexOf('hidden') !== -1, 'onExpired oculta #twofactor-challenge-view');
  ok(sandbox.__drexMfaChallenge === null, 'onExpired libera window.__drexMfaChallenge');
}

async function main() {
  await partA();
  partB();
  console.log('\nAUTH-3: ' + pass + ' ok, ' + failCount + ' fallos');
  process.exit(failCount ? 1 : 0);
}
main().catch(function (e) { console.error('FALLO inesperado:', e); process.exit(1); });
