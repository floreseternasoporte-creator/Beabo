// Tests de drex-payments (lógica real, dependencias externas con stubs).
// Ejecutar: node --loader ./test/loader.mjs --test test/payments.test.mjs
// (o: npm test)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DREX_TABLE = 'drex-kv';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_123';
process.env.COGNITO_USER_POOL_ID = 'us-east-1_kDSYEBsnY';
process.env.COGNITO_CLIENT_ID = 'test-client-123';
process.env.ALLOWED_ORIGINS = 'https://app.test,https://otro.test';
process.env.RL_MAX = '2';
process.env.RL_WINDOW_SEC = '600';

// --- JWKS falso (fetch interceptado) ---
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
  ddbStub.__stubReset();
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

function webhookEvent(payloadObj, secret = 'whsec_test_123') {
  const payload = JSON.stringify(payloadObj);
  const sig = stripeStub.signTestPayload(payload, secret);
  return httpEvent({ method: 'POST', path: '/webhook', body: payload, headers: { 'stripe-signature': sig }, ip: '9.9.9.9' });
}
function sessionCompleted({ eventId = 'evt_test_1', packageId = 'coins_100', sub = 'user-abc', paid = true, coinsMeta = '100' } = {}) {
  return {
    id: eventId, type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_abc123', payment_status: paid ? 'paid' : 'unpaid', client_reference_id: sub,
      metadata: { drex_user_sub: sub, drex_package_id: packageId, drex_coins: coinsMeta } } },
  };
}

// ---------- health ----------
test('GET /health responde ok', async () => {
  const res = await handler(httpEvent({ path: '/health' }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).ok, true);
});

// ---------- C263: /create-checkout-session retirado (todo pago dentro de Drex) ----------
test('C263: create-checkout-session ya no existe (sin token -> 404, no 401)', async () => {
  const res = await handler(httpEvent({ method: 'POST', path: '/create-checkout-session',
    body: { packageId: 'coins_100', returnUrl: 'https://app.test/' }, ip: '1.1.1.1' }));
  assert.equal(res.statusCode, 404);
  assert.equal(parse(res).error, 'not_found');
});

test('C263: create-checkout-session ya no existe (con token válido -> 404)', async () => {
  const res = await handler(httpEvent({ method: 'POST', path: '/create-checkout-session',
    body: { packageId: 'coins_550', idToken: validToken('user-abc'), returnUrl: 'https://app.test/tienda' }, ip: '1.1.1.6' }));
  assert.equal(res.statusCode, 404);
  assert.equal(parse(res).error, 'not_found');
});

// ---------- webhook ----------
test('firma inválida -> 400 y no acredita', async () => {
  ddbStub.__stubReset();
  const res = await handler(webhookEvent(sessionCompleted(), 'whsec_otro'));
  assert.equal(res.statusCode, 400);
  assert.equal(ddbStub.__stubGet('wallets', 'user-abc/coins'), undefined);
});

test('checkout.session.completed válido acredita 100 monedas + recibo', async () => {
  ddbStub.__stubReset();
  const res = await handler(webhookEvent(sessionCompleted()));
  assert.equal(res.statusCode, 200);
  const data = parse(res);
  assert.equal(data.credited, true);
  const coins = ddbStub.__stubGet('wallets', 'user-abc/coins');
  assert.equal(JSON.parse(coins.v), 100);
  const txid = 'stripe_' + 'evt_test_1'.replace(/[^A-Za-z0-9]/g, '').slice(-24);
  const type = ddbStub.__stubGet('transactions', `user-abc/${txid}/type`);
  assert.equal(JSON.parse(type.v), 'purchase');
  const amount = ddbStub.__stubGet('transactions', `user-abc/${txid}/amount`);
  assert.equal(JSON.parse(amount.v), 100);
  const balance = ddbStub.__stubGet('transactions', `user-abc/${txid}/balance`);
  assert.equal(JSON.parse(balance.v), 100);
  const meta = ddbStub.__stubGet('transactions', `user-abc/${txid}/meta`);
  assert.equal(JSON.parse(meta.v).provider, 'stripe');
  const evt = ddbStub.__stubGet('stripe_events', 'evt_test_1');
  assert.ok(evt, 'evento registrado para idempotencia');
});

test('reintento del mismo evento NO duplica el abono', async () => {
  const res = await handler(webhookEvent(sessionCompleted()));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).duplicate, true);
  const coins = ddbStub.__stubGet('wallets', 'user-abc/coins');
  assert.equal(JSON.parse(coins.v), 100); // sigue en 100
});

test('las monedas salen de la lista canónica, no del metadata', async () => {
  ddbStub.__stubReset();
  // metadata miente: dice 999999 monedas para coins_100
  const res = await handler(webhookEvent(sessionCompleted({ eventId: 'evt_test_2', coinsMeta: '999999' })));
  assert.equal(res.statusCode, 200);
  const coins = ddbStub.__stubGet('wallets', 'user-abc/coins');
  assert.equal(JSON.parse(coins.v), 100); // canónico, no 999999
});

test('segunda compra distinta suma sobre el saldo existente', async () => {
  const res = await handler(webhookEvent(sessionCompleted({ eventId: 'evt_test_3', packageId: 'coins_550' })));
  assert.equal(res.statusCode, 200);
  const coins = ddbStub.__stubGet('wallets', 'user-abc/coins');
  assert.equal(JSON.parse(coins.v), 650); // 100 + 550
});

test('evento de otro tipo se acusa sin acreditar', async () => {
  ddbStub.__stubReset();
  const res = await handler(webhookEvent({ id: 'evt_x', type: 'payment_intent.created', data: { object: {} } }));
  assert.equal(res.statusCode, 200);
  assert.equal(ddbStub.__stubGet('wallets', 'user-abc/coins'), undefined);
});

test('metadata con paquete desconocido se ignora sin acreditar', async () => {
  const res = await handler(webhookEvent(sessionCompleted({ eventId: 'evt_test_4', packageId: 'coins_666' })));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).ignored, 'bad_metadata');
  assert.equal(ddbStub.__stubGet('wallets', 'user-abc/coins'), undefined);
});

test('sesión no pagada se ignora', async () => {
  const res = await handler(webhookEvent(sessionCompleted({ eventId: 'evt_test_5', paid: false })));
  assert.equal(res.statusCode, 200);
  assert.equal(ddbStub.__stubGet('wallets', 'user-abc/coins'), undefined);
});
