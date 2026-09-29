/* ================================================================
 * AUTH-5 (2026-09-28): la revocación remota de sesión debe invalidar
 * los tokens en Cognito, no solo borrar la sesión local.
 *
 * Causa raíz: drexSessionsHandleRemoteRevoke() llamaba a
 * drexSessionsTeardown() + DrexCloud.auth().signOut() sin revocar el
 * refresh token. El comentario de diseño lo admitía ("los tokens siguen
 * siendo técnicamente válidos hasta expirar"): un dispositivo revocado
 * conservaba un refresh token válido y podía seguir refrescando su
 * sesión. FIX-URG-1: antes del teardown se llama a
 * currentCognitoUser.revokeToken(refreshToken) (best-effort); en Cognito
 * RevokeToken invalida el refresh token y toda su familia (access + ID).
 *
 * Prueba: drex-cloud.js requerido en node con SDK de Cognito
 * falsificado; login por correo exitoso -> handleRemoteRevoke() ->
 * se verifica que revokeToken se llamó con el refresh token, que se
 * hizo signOut y que quedó la marca de aviso.
 * Ejecutar con: node tests/test-auth5-remote-revoke.js
 * ================================================================ */
'use strict';
var assert = require('assert');
var path = require('path');

var pass = 0, failCount = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { failCount++; console.log('  FAIL ' + name); }
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt() {
  return b64url({ alg: 'none' }) + '.' +
    b64url({ sub: 'uid-test-1', email: 'user@example.com', email_verified: 'true' }) + '.sig';
}

async function main() {
  console.log('AUTH-5 — la revocación remota invalida los tokens en Cognito');

  var revokeCalls = [];
  var signOutCalls = [];
  var storage = {};
  var fakeRefreshToken = { getToken: function () { return 'FAKE-REFRESH-TOKEN'; } };
  var fakeSession = {
    getIdToken: function () {
      return { getJwtToken: function () { return fakeJwt(); }, getExpiration: function () { return Math.floor(Date.now() / 1000) + 3600; } };
    },
    getRefreshToken: function () { return fakeRefreshToken; },
    getAccessToken: function () { return { getJwtToken: function () { return 'x'; }, getExpiration: function () { return 0; } }; }
  };
  var fakeCognitoUser = {
    authenticateUser: function (details, cbs) { setTimeout(function () { cbs.onSuccess(fakeSession); }, 0); },
    getUsername: function () { return 'user@example.com'; },
    getUserAttributes: function (cb) { setTimeout(function () { cb(null, []); }, 0); },
    getSignInUserSession: function () { return fakeSession; },
    signOut: function () { signOutCalls.push(1); },
    revokeToken: function (rt, cb) { revokeCalls.push(rt); if (typeof cb === 'function') cb(null, {}); }
  };
  globalThis.AmazonCognitoIdentity = {
    CognitoUserPool: function () { return { getCurrentUser: function () { return null; } }; },
    CognitoUser: function () { return fakeCognitoUser; },
    AuthenticationDetails: function () {}
  };
  globalThis.sessionStorage = {
    getItem: function (k) { return (k in storage) ? storage[k] : null; },
    setItem: function (k, v) { storage[k] = String(v); },
    removeItem: function (k) { delete storage[k]; }
  };
  globalThis.localStorage = {
    getItem: function () { return null; },
    setItem: function () {}, removeItem: function () {}
  };

  var M = require(path.join(__dirname, '..', 'drex-cloud.js'));
  var DrexCloud = M.DrexCloud;
  var I = M.__internals;

  var user = await DrexCloud.auth().signInWithEmailAndPassword('user@example.com', 'pw123456');
  ok(!!(user && user.user), 'login por correo exitoso en el harness');

  var S = I.drexSessions;
  assert(S && typeof S.handleRemoteRevoke === 'function', 'drexSessions.handleRemoteRevoke exportado');

  S.handleRemoteRevoke();

  ok(revokeCalls.length === 1, 'revokeToken se llamó exactamente una vez al revocar (recibido: ' + revokeCalls.length + ')');
  ok(revokeCalls[0] === 'FAKE-REFRESH-TOKEN', 'revokeToken recibió el refresh token de la sesión');
  ok(signOutCalls.length === 1, 'se hizo signOut local tras revocar');
  ok(storage['drex_session_revoked_notice'] === '1', 'quedó la marca de aviso de cierre remoto');
  ok(S.state.uid === null && S.state.sessionId === null, 'el estado de sesión se limpió (teardown)');

  // Segunda llamada: idempotente (no debe revocar dos veces).
  S.handleRemoteRevoke();
  ok(revokeCalls.length === 1, 'segunda revocación no duplica el revokeToken');

  console.log('\nAUTH-5: ' + pass + ' ok, ' + failCount + ' fallos');
  process.exit(failCount ? 1 : 0);
}
main().catch(function (e) { console.error('FALLO inesperado:', e); process.exit(1); });
