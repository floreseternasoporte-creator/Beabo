/* ================================================================
 * Código por correo al iniciar sesión (Cognito Email MFA).
 * Verifica, con Cognito y fetch falsificados, que:
 *  1) el adaptador sobre CognitoUser reconoce EMAIL_OTP/EMAIL_MFA y
 *     SELECT_MFA_TYPE (prefiere TOTP sobre correo) y MFA_SETUP,
 *  2) sendEmailMfaCode manda EMAIL_OTP_CODE con la sesión del desafío,
 *  3) el login por correo presenta el desafío kind='email-otp' a la UI,
 *     el código correcto completa el login y el incorrecto es reintentable,
 *  4) el login por nombre de usuario con mfaType:'email' usa el paso 2 con
 *     {username, session, code, mfaType:'email'} y "reenviar" repite el paso 1,
 *  5) sin desafío (Cognito aún sin MFA) el login normal NO cambia.
 * Ejecutar con: node tests/test-login-otp-email.js
 * ================================================================ */
'use strict';
var path = require('path');
var pass = 0, failCount = 0;
function ok(c, n) { if (c) { pass++; console.log('  ok  ' + n); } else { failCount++; console.log('  FAIL ' + n); } }
function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fakeJwt() { return b64url({ alg: 'none' }) + '.' + b64url({ sub: 'uid-otp', email: 'user@example.com', email_verified: 'true' }) + '.sig'; }
function fakeResp(status, data) { return { status: status, ok: status >= 200 && status < 300, json: function () { return Promise.resolve(data); } }; }
function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 30); }); }

async function main() {
  console.log('Código por correo en el login');
  var step1Mode = 'email';
  var fetchCalls = [];
  globalThis.fetch = function (url, opts) {
    var body = {}; try { body = JSON.parse(opts.body); } catch (e) {}
    fetchCalls.push({ url: url, body: body });
    if (body.code) {
      if (body.code === '000000') return Promise.resolve(fakeResp(401, { error: 'bad' }));
      return Promise.resolve(fakeResp(200, { tokens: { idToken: fakeJwt(), accessToken: 'AT', refreshToken: 'RT' } }));
    }
    if (step1Mode === 'plain') return Promise.resolve(fakeResp(200, { tokens: { idToken: fakeJwt(), accessToken: 'AT', refreshToken: 'RT' } }));
    return Promise.resolve(fakeResp(200, { challenge: 'mfa', mfaType: 'email', destination: 'u***@e***.com', session: 'EMAIL_OTP|SESS-1' }));
  };

  function Tok(v) { this.t = v; } Tok.prototype.getToken = function () { return this.t; };
  function FakeSession() {}
  FakeSession.prototype.isValid = function () { return true; };
  FakeSession.prototype.getIdToken = function () { return { getJwtToken: fakeJwt, getExpiration: function () { return Math.floor(Date.now() / 1000) + 3600; } }; };
  FakeSession.prototype.getRefreshToken = function () { return { getToken: function () { return 'RT'; } }; };

  var requests = [];
  var nextResponses = [];
  var authBehavior = 'email-challenge';
  function FakeUser(o) { this.username = o.Username; this.pool = { getClientId: function () { return 'CID'; }, getUserPoolName: function () { return 'pool'; } }; this.client = { request: function (op, req, cb) { requests.push({ op: op, req: req }); var r = nextResponses.shift(); if (r instanceof Error) return cb(r); cb(null, r); } }; this.session = null; }
  FakeUser.prototype.setSignInUserSession = function (s) { this.session = s; };
  FakeUser.prototype.getSignInUserSession = function () { return this.session; };
  FakeUser.prototype.getUsername = function () { return this.username; };
  FakeUser.prototype.getUserAttributes = function (cb) { setTimeout(function () { cb(null, []); }, 0); };
  FakeUser.prototype.signOut = function () {};
  FakeUser.prototype.getCachedDeviceKeyAndPassword = function () {};
  FakeUser.prototype.setDeviceStatusRemembered = function (cb) { cb.onSuccess('SUCCESS'); };
  // "original" de la librería: solo entiende AuthenticationResult
  FakeUser.prototype.authenticateUserInternal = function (data, helper, cb) {
    if (data && data.AuthenticationResult) { this.session = new FakeSession(); return cb.onSuccess(this.session, false); }
    if (data && data.ChallengeName === 'SOFTWARE_TOKEN_MFA') return cb.totpRequired(data.ChallengeName, data.ChallengeParameters);
    return cb.onFailure(new Error('desafío no soportado por la librería: ' + (data && data.ChallengeName)));
  };
  FakeUser.prototype.authenticateUser = function (details, cb) {
    var self = this;
    setTimeout(function () {
      if (authBehavior === 'email-challenge') return self.authenticateUserInternal({ ChallengeName: 'EMAIL_OTP', Session: 'S-A', ChallengeParameters: { CODE_DELIVERY_DESTINATION: 'u***@e***.com' } }, {}, cb);
      return self.authenticateUserInternal({ AuthenticationResult: { IdToken: 'x' } }, {}, cb);
    }, 0);
  };
  function Pool() { this.getCurrentUser = function () { return null; }; }
  globalThis.AmazonCognitoIdentity = {
    CognitoUserPool: Pool, CognitoUser: FakeUser, CognitoUserSession: FakeSession,
    CognitoIdToken: function (o) { Tok.call(this, o.IdToken); }, CognitoAccessToken: function (o) { Tok.call(this, o.AccessToken); },
    CognitoRefreshToken: function (o) { Tok.call(this, o.RefreshToken); }, AuthenticationDetails: function () {},
    AuthenticationHelper: function () {}
  };
  ['CognitoIdToken', 'CognitoAccessToken', 'CognitoRefreshToken'].forEach(function (k) { globalThis.AmazonCognitoIdentity[k].prototype = Object.create(Tok.prototype); });

  var captured = null;
  globalThis.__drexMfaUi = function (ch) { captured = ch; globalThis.__drexMfaChallenge = ch; };
  var M = require(path.join(__dirname, '..', 'drex-cloud.js'));
  var DrexCloud = M.DrexCloud;
  var auth = DrexCloud.auth();

  // ---- 2) login por correo: desafío -> código ----
  var loginP = auth.signInWithEmailAndPassword('user@example.com', 'pw123456');
  loginP.catch(function () {});
  await tick(50);
  ok(!!captured && captured.kind === 'email-otp', 'el login por correo presenta kind=email-otp a la UI');
  ok(captured && captured.destination === 'u***@e***.com', 'el destino enmascarado llega a la UI');
  ok(captured && captured.canRemember === true, 'el login por correo permite "recordar este dispositivo"');
  requests.length = 0;
  nextResponses = [new Error('x')];
  nextResponses[0].code = 'CodeMismatchException';
  var badErr = null;
  try { await captured.onCode('000000', { remember: false }); } catch (e) { badErr = e; }
  ok(!!badErr, 'un código incorrecto rechaza la promesa (la UI deja reintentar)');
  ok(requests[0] && requests[0].op === 'RespondToAuthChallenge' && requests[0].req.ChallengeName === 'EMAIL_OTP' && requests[0].req.ChallengeResponses.EMAIL_OTP_CODE === '000000' && requests[0].req.Session === 'S-A',
    'el código viaja con RespondToAuthChallenge/EMAIL_OTP y la sesión del desafío');
  nextResponses = [{ AuthenticationResult: { IdToken: 'x' } }];
  var res = await captured.onCode('123456', { remember: true });
  var loginRes = await loginP;
  ok(!!(loginRes && loginRes.user), 'el código correcto completa el login');

  // ---- 1) adaptador a nivel de librería ----
  var proto = globalThis.AmazonCognitoIdentity.CognitoUser.prototype;
  var u = new FakeUser({ Username: 'a@b.com' });
  var got = null;
  proto.authenticateUserInternal.call(u, { ChallengeName: 'EMAIL_MFA', Session: 'SX', ChallengeParameters: { CODE_DELIVERY_DESTINATION: 'a***' } }, {}, { emailMfaRequired: function (p) { got = p; }, onFailure: function () {} });
  // la prueba solo se parchea tras cognitoLib(); la API ya lo disparó con auth()
  ok(proto.__drexEmailMfa === true || got !== null, 'el adaptador de Email MFA está instalado sobre CognitoUser');
  ok(!!got && got.CODE_DELIVERY_DESTINATION === 'a***', 'EMAIL_MFA se entrega como emailMfaRequired con el destino');
  var fail1 = null;
  proto.authenticateUserInternal.call(u, { ChallengeName: 'EMAIL_OTP', Session: 'SX', ChallengeParameters: {} }, {}, { onFailure: function (e) { fail1 = e; } });
  ok(!!fail1 && fail1.code === 'DrexMfaUnsupported', 'sin manejador, EMAIL_OTP falla con DrexMfaUnsupported (no TypeError)');
  var fail2 = null;
  proto.authenticateUserInternal.call(u, { ChallengeName: 'MFA_SETUP', Session: 'SX', ChallengeParameters: {} }, {}, { onFailure: function (e) { fail2 = e; } });
  ok(!!fail2 && fail2.code === 'DrexMfaSetupRequired', 'MFA_SETUP sin manejador -> DrexMfaSetupRequired');
  requests.length = 0;
  nextResponses = [{ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'S2', ChallengeParameters: {} }];
  var totp = false;
  var u2 = new FakeUser({ Username: 'a@b.com' });
  proto.authenticateUserInternal.call(u2, { ChallengeName: 'SELECT_MFA_TYPE', Session: 'S1', ChallengeParameters: { MFAS_CAN_CHOOSE: '["EMAIL_OTP","SOFTWARE_TOKEN_MFA"]' } }, {}, { totpRequired: function () { totp = true; }, onFailure: function () {} });
  ok(requests.length === 1 && requests[0].req.ChallengeResponses.ANSWER === 'SOFTWARE_TOKEN_MFA' && totp, 'SELECT_MFA_TYPE: prefiere TOTP sobre correo');
  requests.length = 0;
  nextResponses = [{ ChallengeName: 'EMAIL_OTP', Session: 'S2', ChallengeParameters: {} }];
  var mail = false;
  var u3 = new FakeUser({ Username: 'a@b.com' });
  proto.authenticateUserInternal.call(u3, { ChallengeName: 'SELECT_MFA_TYPE', Session: 'S1', ChallengeParameters: { MFAS_CAN_CHOOSE: '["EMAIL_OTP"]' } }, {}, { emailMfaRequired: function () { mail = true; }, onFailure: function () {} });
  ok(requests.length === 1 && requests[0].req.ChallengeResponses.ANSWER === 'EMAIL_OTP' && mail, 'SELECT_MFA_TYPE: solo correo -> pide el código por correo');

  // ---- 3) sin desafío: el login sigue igual ----
  captured = null; authBehavior = 'plain';
  var plain = await auth.signInWithEmailAndPassword('user@example.com', 'pw123456');
  ok(!captured && !!(plain && plain.user), 'sin desafío de Cognito el login normal no cambia');

  // ---- 4) login por nombre de usuario con correo ----
  fetchCalls.length = 0; captured = null;
  var up = auth.signInWithUsernameAndPassword('testuser', 'pw123456');
  up.catch(function () {});
  await tick(50);
  ok(!!captured && captured.kind === 'email-otp' && captured.destination === 'u***@e***.com', 'username: la Lambda pide código por correo -> kind=email-otp');
  ok(captured && captured.canRemember === false, 'username: no ofrece recordar dispositivo (la Lambda no puede registrarlo)');
  ok(typeof captured.onResend === 'function', 'username: expone reenviar');
  var rr = await captured.onResend();
  ok(fetchCalls.length === 2 && fetchCalls[1].body.username === 'testuser' && fetchCalls[1].body.password === 'pw123456' && !fetchCalls[1].body.code, 'reenviar repite el paso 1 de la Lambda');
  fetchCalls.length = 0;
  await captured.onCode('123456', {});
  var s2 = fetchCalls[0];
  ok(!!s2 && s2.body.code === '123456' && s2.body.mfaType === 'email' && s2.body.username === 'testuser' && /SESS-1/.test(s2.body.session) && !('password' in s2.body), 'username: paso 2 = {username, session, code, mfaType:"email"} sin contraseña');
  var lr = await up;
  ok(!!(lr && lr.user), 'username: el login completa tras el código');
  var wrong = null;
  fetchCalls.length = 0; captured = null;
  var up2 = auth.signInWithUsernameAndPassword('testuser', 'pw123456'); up2.catch(function () {});
  await tick(50);
  try { await captured.onCode('000000', {}); } catch (e) { wrong = e; }
  ok(!!wrong && wrong.code === 'auth/invalid-mfa-code', 'username: 401 en el paso 2 -> auth/invalid-mfa-code reintentable');

  // ---- 5) API pública ----
  ok(DrexCloud.loginOtp && typeof DrexCloud.loginOtp.seen === 'function' && typeof DrexCloud.loginOtp.forgetDevice === 'function', 'DrexCloud.loginOtp expone seen/remembered/forgetDevice');

  console.log('\nLOGIN-OTP: ' + pass + ' ok, ' + failCount + ' fallos');
  process.exit(failCount ? 1 : 0);
}
main().catch(function (e) { console.error('FALLO inesperado:', e); process.exit(1); });
