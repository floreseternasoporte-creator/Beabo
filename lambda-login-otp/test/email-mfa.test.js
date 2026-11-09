/* Pruebas de lambda-login-otp/email-mfa.js — node lambda-login-otp/test/email-mfa.test.js */
'use strict';
var assert = require('assert');
var M = require('../email-mfa.js');
var passed = 0, failed = 0, pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(function () { passed++; console.log('ok - ' + name); },
    function (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }));
}
var ctx = { userPoolId: 'pool', clientId: 'client', cognitoUsername: 'user@example.com' };

test('tokens directos (MFA todavía no activado en el pool)', async function () {
  var r = await M.classifyAuthResponse({}, ctx, { AuthenticationResult: { IdToken: 'x' } });
  assert.strictEqual(r.type, 'tokens');
});
test('desafío por correo -> mfa email con destino y sesión con prefijo', async function () {
  var r = await M.classifyAuthResponse({}, ctx, { ChallengeName: 'EMAIL_OTP', Session: 'S1', ChallengeParameters: { CODE_DELIVERY_DESTINATION: 'u***@e***.com' } });
  assert.strictEqual(r.type, 'mfa'); assert.strictEqual(r.mfaType, 'email');
  assert.strictEqual(r.session, 'EMAIL_OTP|S1'); assert.strictEqual(r.destination, 'u***@e***.com');
  assert.deepStrictEqual(M.challengeBody(r), { challenge: 'mfa', session: 'EMAIL_OTP|S1', mfaType: 'email', destination: 'u***@e***.com' });
});
test('TOTP queda igual que hoy (sin mfaType ni prefijo)', async function () {
  var r = await M.classifyAuthResponse({}, ctx, { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'S2' });
  assert.deepStrictEqual(M.challengeBody(r), { challenge: 'mfa', session: 'S2' });
});
test('SELECT_MFA_TYPE: elige TOTP si existe, si no el correo', async function () {
  var calls = [];
  var cog = { adminRespondToAuthChallenge: async function (p) { calls.push(p); return { ChallengeName: /SOFTWARE/.test(p.ChallengeResponses.ANSWER) ? 'SOFTWARE_TOKEN_MFA' : 'EMAIL_OTP', Session: 'S9', ChallengeParameters: {} }; } };
  var r1 = await M.classifyAuthResponse(cog, ctx, { ChallengeName: 'SELECT_MFA_TYPE', Session: 'S0', ChallengeParameters: { MFAS_CAN_CHOOSE: '["EMAIL_OTP","SOFTWARE_TOKEN_MFA"]' } });
  assert.strictEqual(calls[0].ChallengeResponses.ANSWER, 'SOFTWARE_TOKEN_MFA'); assert.strictEqual(r1.mfaType, 'totp');
  var r2 = await M.classifyAuthResponse(cog, ctx, { ChallengeName: 'SELECT_MFA_TYPE', Session: 'S0', ChallengeParameters: { MFAS_CAN_CHOOSE: '["EMAIL_OTP"]' } });
  assert.strictEqual(calls[1].ChallengeResponses.ANSWER, 'EMAIL_OTP'); assert.strictEqual(r2.mfaType, 'email');
});
test('desafíos desconocidos (MFA_SETUP, etc.) -> unsupported (la Lambda responde 401 genérico)', async function () {
  var r = await M.classifyAuthResponse({}, ctx, { ChallengeName: 'MFA_SETUP', Session: 'S' });
  assert.strictEqual(r.type, 'unsupported');
});
test('paso 2 correo: usa el desafío guardado en la sesión y manda el código', function () {
  var p = M.buildRespondParams(ctx, 'EMAIL_OTP|SESS', '123456');
  assert.strictEqual(p.ChallengeName, 'EMAIL_OTP'); assert.strictEqual(p.Session, 'SESS');
  assert.strictEqual(p.ChallengeResponses.EMAIL_OTP_CODE, '123456');
  assert.strictEqual(p.ChallengeResponses.USERNAME, 'user@example.com');
});
test('paso 2 TOTP: sesión sin prefijo = comportamiento de siempre', function () {
  var p = M.buildRespondParams(ctx, 'SESS', '654321');
  assert.strictEqual(p.ChallengeName, 'SOFTWARE_TOKEN_MFA');
  assert.strictEqual(p.ChallengeResponses.SOFTWARE_TOKEN_MFA_CODE, '654321');
  assert.strictEqual(p.Session, 'SESS');
});
test('paso 2: código con formato inválido -> null (sin llamar a Cognito)', function () {
  assert.strictEqual(M.buildRespondParams(ctx, 'EMAIL_OTP|S', '12ab56'), null);
  assert.strictEqual(M.buildRespondParams(ctx, 'EMAIL_OTP|S', ''), null);
});
Promise.all(pending).then(function () {
  console.log('\nRESULTADO: ' + passed + ' ok, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
});
