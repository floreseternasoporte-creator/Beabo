// Tests de la verificación de $1 de Chiripa (2026-11-24).
// Rutas: POST /create-verification-payment y /bank-verification-status,
// más el webhook payment_intent.succeeded.
// Ejecutar: node --loader ./test/loader.mjs --test test/bank-verification.test.mjs
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DREX_TABLE = 'drex-kv';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_123';
process.env.STRIPE_PRICE_ORBIT_MONTHLY = 'price_monthly_test';
process.env.STRIPE_PRICE_ORBIT_YEARLY = 'price_yearly_test';
process.env.COGNITO_USER_POOL_ID = 'us-east-1_kDSYEBsnY';
process.env.COGNITO_CLIENT_ID = 'test-client-123';
process.env.ALLOWED_ORIGINS = 'https://app.test,https://otro.test';
process.env.RL_MAX = '100';
process.env.RL_WINDOW_SEC = '600';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubJwk = publicKey.export({ format: 'jwk' });
pubJwk.kid = 'test-kid-1';
pubJwk.alg = 'RS256';
const privJwk = privateKey.export({ format: 'jwk' });
globalThis.fetch = async (url) => {
  if (String(url).includes('/.well-known/jwks.json')) {
    return { ok: true, json: async () => ({ keys: [pubJwk] }) };
  }
  throw new Error('fetch inesperado en test: ' + url);
};

function signJwt(payload) {
  const header = { alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const key = crypto.createPrivateKey({ key: privJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), key).toString('base64url');
  return `${h}.${p}.${sig}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
function validToken(sub = 'user-abc', overrides = {}) {
  return signJwt({
    iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_kDSYEBsnY',
    aud: 'test-client-123', token_use: 'id', sub,
    iat: nowSec(), exp: nowSec() + 3600, ...overrides,
  });
}

let handler, stripeStub, ddbStub;
before(async () => {
  ({ handler } = await import('../index.js'));
  stripeStub = await import('./stubs/stripe.mjs');
  ddbStub = await import('./stubs/ddb.mjs');
});

beforeEach(() => {
  ddbStub.__stubReset();
  stripeStub.__clearPaymentIntents();
});

function httpEvent({ method = 'GET', path = '/', body = null, headers = {}, ip = '9.9.9.9' }) {
  return {
    rawPath: path,
    requestContext: { http: { method, sourceIp: ip } },
    headers,
    body: body === null ? '' : (typeof body === 'string' ? body : JSON.stringify(body)),
    isBase64Encoded: false,
  };
}
const parse = (res) => JSON.parse(res.body);
const post = (path, body, ip = '9.9.9.9') => handler(httpEvent({ method: 'POST', path, body, ip }));

function webhookEvent(payloadObj, secret = 'whsec_test_123') {
  const payload = JSON.stringify(payloadObj);
  const sig = stripeStub.signTestPayload(payload, secret);
  return httpEvent({ method: 'POST', path: '/webhook', body: payload, headers: { 'stripe-signature': sig }, ip: '9.9.9.9' });
}
const bankRecord = (sub = 'user-abc') => {
  const it = ddbStub.__stubGet('users', sub + '/bankVerification');
  return it ? JSON.parse(it.v) : null;
};

test('create-verification-payment: crea un PaymentIntent de $1 con metadata de Chiripa', async () => {
  const res = await post('/create-verification-payment', { idToken: validToken() });
  assert.equal(res.statusCode, 200);
  const data = parse(res);
  assert.equal(data.paymentIntentId, 'pi_test_1');
  assert.ok(data.clientSecret);
  const params = stripeStub.lastPaymentIntentParams;
  assert.equal(params.amount, 100);
  assert.equal(params.currency, 'usd');
  assert.equal(params.metadata.drex_bank_verification, '1');
  assert.equal(params.metadata.drex_user_sub, 'user-abc');
  assert.equal(params.automatic_payment_methods.enabled, true);
});

test('create-verification-payment: sin token -> 401, no crea nada en Stripe', async () => {
  stripeStub.__clearLastPaymentIntentParams();
  const res = await post('/create-verification-payment', {});
  assert.equal(res.statusCode, 401);
  assert.equal(stripeStub.lastPaymentIntentParams, null);
});

test('bank-verification-status: sin pago -> verified false', async () => {
  const res = await post('/bank-verification-status', { idToken: validToken() });
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).verified, false);
});

test('bank-verification-status: con PI succeeded y metadata correcta -> verified true y guarda el registro', async () => {
  stripeStub.__setPaymentIntent('pi_test_1', {
    id: 'pi_test_1', status: 'succeeded',
    metadata: { drex_bank_verification: '1', drex_user_sub: 'user-abc' },
  });
  const res = await post('/bank-verification-status', { idToken: validToken(), paymentIntentId: 'pi_test_1' });
  assert.equal(res.statusCode, 200);
  const data = parse(res);
  assert.equal(data.verified, true);
  assert.ok(data.verifiedAt);
  const rec = bankRecord();
  assert.equal(rec.status, 'verified');
  assert.equal(rec.amountCents, 100);
  assert.equal(rec.paymentIntentId, 'pi_test_1');
});

test('bank-verification-status: PI de OTRO usuario -> verified false, no guarda nada', async () => {
  stripeStub.__setPaymentIntent('pi_test_1', {
    id: 'pi_test_1', status: 'succeeded',
    metadata: { drex_bank_verification: '1', drex_user_sub: 'user-otro' },
  });
  const res = await post('/bank-verification-status', { idToken: validToken('user-abc'), paymentIntentId: 'pi_test_1' });
  assert.equal(parse(res).verified, false);
  assert.equal(bankRecord(), null);
});

test('bank-verification-status: PI aun sin pagar -> verified false', async () => {
  stripeStub.__setPaymentIntent('pi_test_1', {
    id: 'pi_test_1', status: 'requires_payment_method',
    metadata: { drex_bank_verification: '1', drex_user_sub: 'user-abc' },
  });
  const res = await post('/bank-verification-status', { idToken: validToken(), paymentIntentId: 'pi_test_1' });
  assert.equal(parse(res).verified, false);
  assert.equal(parse(res).paymentIntentStatus, 'requires_payment_method');
  assert.equal(bankRecord(), null);
});

test('bank-verification-status: segunda llamada con el mismo PI -> verified true sin duplicar (idempotente)', async () => {
  stripeStub.__setPaymentIntent('pi_test_1', {
    id: 'pi_test_1', status: 'succeeded',
    metadata: { drex_bank_verification: '1', drex_user_sub: 'user-abc' },
  });
  const r1 = await post('/bank-verification-status', { idToken: validToken(), paymentIntentId: 'pi_test_1' });
  assert.equal(parse(r1).verified, true);
  const r2 = await post('/bank-verification-status', { idToken: validToken(), paymentIntentId: 'pi_test_1' });
  assert.equal(parse(r2).verified, true);
  assert.equal(parse(r2).duplicate, true);
});

test('create-verification-payment: ya verificado -> alreadyVerified, no crea otro PI', async () => {
  stripeStub.__setPaymentIntent('pi_test_1', {
    id: 'pi_test_1', status: 'succeeded',
    metadata: { drex_bank_verification: '1', drex_user_sub: 'user-abc' },
  });
  await post('/bank-verification-status', { idToken: validToken(), paymentIntentId: 'pi_test_1' });
  stripeStub.__clearLastPaymentIntentParams();
  const res = await post('/create-verification-payment', { idToken: validToken() });
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).alreadyVerified, true);
  assert.equal(stripeStub.lastPaymentIntentParams, null);
});

test('webhook payment_intent.succeeded con metadata de Chiripa -> guarda el registro', async () => {
  const evt = {
    id: 'evt_bank_1', type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_test_9', status: 'succeeded', metadata: { drex_bank_verification: '1', drex_user_sub: 'user-abc' } } },
  };
  const res = await handler(webhookEvent(evt));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).verified, true);
  assert.equal(bankRecord().paymentIntentId, 'pi_test_9');
});

test('webhook payment_intent.succeeded SIN metadata de Chiripa -> se ignora, no guarda nada', async () => {
  const evt = {
    id: 'evt_bank_2', type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_test_8', status: 'succeeded', metadata: {} } },
  };
  const res = await handler(webhookEvent(evt));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).ignored, 'not_bank_verification');
  assert.equal(bankRecord(), null);
});

test('webhook payment_intent.succeeded repetido -> duplicate, un solo registro', async () => {
  const evt = {
    id: 'evt_bank_3', type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_test_7', status: 'succeeded', metadata: { drex_bank_verification: '1', drex_user_sub: 'user-abc' } } },
  };
  const r1 = await handler(webhookEvent(evt));
  assert.equal(parse(r1).verified, true);
  const r2 = await handler(webhookEvent(evt));
  assert.equal(parse(r2).duplicate, true);
  assert.equal(bankRecord().paymentIntentId, 'pi_test_7');
});
