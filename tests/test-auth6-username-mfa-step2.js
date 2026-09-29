/* ================================================================
 * AUTH-6 (2026-09-28): el segundo paso TOTP con login por nombre de
 * usuario funciona (estado del bug conocido).
 *
 * Contexto: el pool Cognito solo acepta correo, así que el login por
 * username pasa por la Lambda drex-username-resolve. El paso 1 devuelve
 * {challenge:'mfa', session} y el paso 2 envía {username, session, code}
 * para completar el TOTP. El canje de códigos de respaldo va por el
 * paso R ({username, password, recoveryCode}).
 *
 * Prueba: fetch falsificado; se verifica que (1) el paso 1 pide el
 * desafío MFA, (2) un TOTP de 6 dígitos viaja al paso 2 con la sesión
 * del desafío y el login completa, (3) un texto con forma de código de
 * respaldo se enruta al paso R y resuelve con recoveryUsed=true,
 * (4) un 401 en el paso 2 se mapea a auth/invalid-mfa-code reintentable.
 * Ejecutar con: node tests/test-auth6-username-mfa-step2.js
 * ================================================================ */
'use strict';
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
    b64url({ sub: 'uid-test-2', email: 'user@example.com', email_verified: 'true' }) + '.sig';
}
function fakeTokens(extra) {
  var t = { idToken: fakeJwt(), accessToken: 'AT', refreshToken: 'RT' };
  if (extra) Object.keys(extra).forEach(function (k) { t[k] = extra[k]; });
  return { tokens: t };
}
function fakeResp(status, data) {
  return { status: status, ok: status >= 200 && status < 300, json: function () { return Promise.resolve(data); } };
}

async function main() {
  console.log('AUTH-6 — paso 2 TOTP con login por nombre de usuario');

  var fetchCalls = [];
  var step2Behavior = 'ok'; // 'ok' | 'unauthorized'
  globalThis.fetch = function (url, opts) {
    var body = {};
    try { body = JSON.parse(opts.body); } catch (e) {}
    fetchCalls.push({ url: url, body: body });
    if (body.code || body.recoveryCode) {
      if (step2Behavior === 'unauthorized') return Promise.resolve(fakeResp(401, { error: 'bad' }));
      if (body.recoveryCode) return Promise.resolve(fakeResp(200, fakeTokens({ recoveryUsed: true })));
      return Promise.resolve(fakeResp(200, fakeTokens()));
    }
    return Promise.resolve(fakeResp(200, { challenge: 'mfa', session: 'CHSESS-123' }));
  };

  function fakeTokenCls(v) { this.t = v; }
  fakeTokenCls.prototype.getToken = function () { return this.t; };
  function FakeSession(o) { this.o = o; }
  FakeSession.prototype.isValid = function () { return true; };
  FakeSession.prototype.getIdToken = function () {
    return { getJwtToken: function () { return fakeJwt(); }, getExpiration: function () { return Math.floor(Date.now() / 1000) + 3600; } };
  };
  FakeSession.prototype.getRefreshToken = function () { return { getToken: function () { return 'RT'; } }; };
  function FakeCognitoUser(o) { this.username = o.Username; this.session = null; }
  FakeCognitoUser.prototype.setSignInUserSession = function (s) { this.session = s; };
  FakeCognitoUser.prototype.getSignInUserSession = function () { return this.session; };
  FakeCognitoUser.prototype.getUsername = function () { return this.username; };
  FakeCognitoUser.prototype.getUserAttributes = function (cb) { setTimeout(function () { cb(null, []); }, 0); };
  FakeCognitoUser.prototype.signOut = function () {};
  globalThis.AmazonCognitoIdentity = {
    CognitoUserPool: function () { return {}; },
    CognitoUser: FakeCognitoUser,
    CognitoUserSession: FakeSession,
    CognitoIdToken: function (o) { fakeTokenCls.call(this, o.IdToken); },
    CognitoAccessToken: function (o) { fakeTokenCls.call(this, o.AccessToken); },
    CognitoRefreshToken: function (o) { fakeTokenCls.call(this, o.RefreshToken); },
    AuthenticationDetails: function () {}
  };
  globalThis.AmazonCognitoIdentity.CognitoIdToken.prototype = Object.create(fakeTokenCls.prototype);
  globalThis.AmazonCognitoIdentity.CognitoAccessToken.prototype = Object.create(fakeTokenCls.prototype);
  globalThis.AmazonCognitoIdentity.CognitoRefreshToken.prototype = Object.create(fakeTokenCls.prototype);

  var captured = null;
  globalThis.__drexMfaUi = function (ch) { captured = ch; globalThis.__drexMfaChallenge = ch; };

  var M = require(path.join(__dirname, '..', 'drex-cloud.js'));
  var DrexCloud = M.DrexCloud;

  // --- 1) paso 1: el login por username pide el desafío MFA ---
  var loginP = DrexCloud.auth().signInWithUsernameAndPassword('testuser', 'pw123456');
  loginP.catch(function () {});
  await new Promise(function (r) { setTimeout(r, 50); });
  ok(fetchCalls.length === 1 && fetchCalls[0].body.username === 'testuser' && fetchCalls[0].body.password === 'pw123456',
    'el paso 1 envía {username, password} a la Lambda');
  ok(!!captured && captured.kind === 'username', 'se presenta el desafío MFA kind=username a la UI');
  ok(typeof captured.onCode === 'function', 'el desafío expone onCode');

  // --- 2) TOTP de 6 dígitos -> paso 2 con la sesión del desafío ---
  var onCodeResult = captured.onCode('123456');
  var codeRes = await onCodeResult;
  var step2 = fetchCalls[1];
  ok(!!step2 && step2.body.username === 'testuser' && step2.body.session === 'CHSESS-123' && step2.body.code === '123456',
    'el TOTP viaja al paso 2 como {username, session, code}');
  ok(!('password' in (step2.body || {})), 'el paso 2 TOTP no reenvía la contraseña');
  var loginRes = await loginP;
  ok(!!(loginRes && loginRes.user), 'el login completa tras el paso 2 TOTP (bug conocido: RESUELTO en código)');
  ok(!(codeRes && codeRes.recoveryUsed), 'sin recoveryUsed en el camino TOTP normal');

  // --- 3) código de respaldo -> paso R ---
  fetchCalls.length = 0; captured = null;
  var loginP2 = DrexCloud.auth().signInWithUsernameAndPassword('testuser', 'pw123456');
  loginP2.catch(function () {});
  await new Promise(function (r) { setTimeout(r, 50); });
  var codeRes2 = await captured.onCode('ABCD-1234');
  var pasoR = fetchCalls[1];
  ok(!!pasoR && pasoR.body.username === 'testuser' && pasoR.body.password === 'pw123456' && pasoR.body.recoveryCode === 'ABCD-1234',
    'el código de respaldo se enruta al paso R {username, password, recoveryCode}');
  ok(!!(codeRes2 && codeRes2.recoveryUsed), 'el paso R resuelve con recoveryUsed=true');
  var loginRes2 = await loginP2;
  ok(!!(loginRes2 && loginRes2.user), 'el login completa tras canjear el código de respaldo');

  // --- 4) 401 en el paso 2 -> error reintentable, la UI puede reintentar ---
  fetchCalls.length = 0; captured = null; step2Behavior = 'unauthorized';
  var loginP3 = DrexCloud.auth().signInWithUsernameAndPassword('testuser', 'pw123456');
  loginP3.catch(function () {});
  await new Promise(function (r) { setTimeout(r, 50); });
  var err3 = null;
  try { await captured.onCode('000000'); } catch (e) { err3 = e; }
  ok(!!err3 && err3.code === 'auth/invalid-mfa-code' && err3.retryable === true,
    'el 401 del paso 2 se mapea a auth/invalid-mfa-code reintentable (recibido: ' + (err3 && err3.code) + ')');

  console.log('\nAUTH-6: ' + pass + ' ok, ' + failCount + ' fallos');
  process.exit(failCount ? 1 : 0);
}
main().catch(function (e) { console.error('FALLO inesperado:', e); process.exit(1); });
