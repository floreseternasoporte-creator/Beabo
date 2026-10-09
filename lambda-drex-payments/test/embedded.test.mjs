// C260-pagos: /subscribe-embedded contra la forma de la API de Stripe
// vigente (2025-03-31 Basil / 2026 Dahlia). Antes el handler expandía
// latest_invoice.payment_intent — campo ELIMINADO en Basil — y el secreto
// siempre salía null -> 502: el pago dentro de Drex jamás funcionaba.
// La factura falsa del stub solo trae payments.data[].payment.payment_intent.
// Ejecutar: node --loader ./test/loader.mjs --test test/embedded.test.mjs
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DREX_TABLE = 'drex-kv';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_x';
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
  stripeStub.__clearSubscriptions();
  stripeStub.__clearCustomers();
});

function httpEvent({ method = 'POST', path = '/', body = null, headers = {}, ip = '9.9.9.9' }) {
  return {
    rawPath: path,
    requestContext: { http: { method, sourceIp: ip } },
    headers,
    body: body === null ? '' : (typeof body === 'string' ? body : JSON.stringify(body)),
    isBase64Encoded: false,
  };
}
const parse = (res) => JSON.parse(res.body);

test('POST /subscribe-embedded crea la suscripción y devuelve el clientSecret desde payments.data', async () => {
  const res = await handler(httpEvent({
    path: '/subscribe-embedded',
    body: { plan: 'monthly', idToken: validToken() },
  }));
  assert.equal(res.statusCode, 200);
  const body = parse(res);
  assert.equal(body.clientSecret, stripeStub.FAKE_PI_SECRET);
  assert.ok(body.subscriptionId && body.subscriptionId.startsWith('sub_test_'));
  assert.match(stripeStub.lastCustomerCreate.options.idempotencyKey, /^drex_cust_user-abc$/);
  assert.match(stripeStub.lastSubscriptionCreate.options.idempotencyKey, /^drex_sub_user-abc_monthly_\d+$/);
  assert.deepEqual(stripeStub.lastSubscriptionCreate.params.expand, ['latest_invoice.payments.data.payment.payment_intent']);
});

test('C287: si Stripe devuelve el intent como ID (sin expandir), el secreto se recupera igual', async () => {
  stripeStub.__setPiAsString(true);
  try {
    const res = await handler(httpEvent({
      path: '/subscribe-embedded',
      body: { plan: 'quarterly', idToken: validToken() },
    }));
    assert.equal(res.statusCode, 200);
    assert.equal(parse(res).clientSecret, stripeStub.FAKE_PI_SECRET);
  } finally {
    stripeStub.__setPiAsString(false);
  }
});

test('POST /subscribe-embedded reutiliza la suscripción incompleta (mismo secreto, sin crear otra)', async () => {
  const first = parse(await handler(httpEvent({
    path: '/subscribe-embedded',
    body: { plan: 'monthly', idToken: validToken() },
  })));
  const second = parse(await handler(httpEvent({
    path: '/subscribe-embedded',
    body: { plan: 'monthly', idToken: validToken() },
  })));
  assert.equal(second.subscriptionId, first.subscriptionId);
  assert.equal(second.clientSecret, stripeStub.FAKE_PI_SECRET);
  assert.equal(second.reused, true);
});

test('POST /subscribe-embedded con plan inexistente -> 400 invalid_plan (sin tocar Stripe)', async () => {
  const res = await handler(httpEvent({
    path: '/subscribe-embedded',
    body: { plan: 'weekly', idToken: validToken() },
  }));
  assert.equal(res.statusCode, 400);
  assert.equal(parse(res).error, 'invalid_plan');
});
