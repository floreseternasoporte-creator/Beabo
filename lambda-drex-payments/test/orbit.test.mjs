// Tests de Drex Orbit (suscripciones) en drex-payments.
// Ejecutar: node --loader ./test/loader.mjs --test test/orbit.test.mjs
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DREX_TABLE = 'drex-kv';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_y';
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
const authed = (path, extra = {}) => httpEvent({
  path, body: { idToken: validToken(), returnUrl: 'https://app.test/ajustes', ...extra },
});

function webhookEvent(type, object, id = 'evt_test_1') {
  const payload = JSON.stringify({ id, type, data: { object } });
  const sig = stripeStub.signTestPayload(payload, process.env.STRIPE_WEBHOOK_SECRET);
  return httpEvent({ path: '/webhook', body: payload, headers: { 'stripe-signature': sig } });
}
const orbitRecord = (sub = 'user-abc') => {
  const it = ddbStub.__stubGet('users', sub + '/orbit');
  return it ? JSON.parse(it.v) : null;
};

// ---------- /create-subscription-session ----------

test('Orbit: sesión mensual -> Checkout mode subscription con el price de env', async () => {
  const res = await handler(authed('/create-subscription-session', { plan: 'monthly' }));
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.ok(data.url);
  assert.equal(data.plan, 'monthly');
  const p = stripeStub.lastSessionParams;
  assert.equal(p.mode, 'subscription');
  assert.deepEqual(p.line_items, [{ price: 'price_monthly_test', quantity: 1 }]);
  assert.equal(p.metadata.drex_user_sub, 'user-abc');
  assert.equal(p.metadata.drex_orbit_plan, 'monthly');
  assert.equal(p.subscription_data.metadata.drex_orbit_plan, 'monthly');
  assert.ok(p.success_url.includes('?orbit=success'));
});

test('Orbit: sesión anual usa el price anual', async () => {
  const res = await handler(authed('/create-subscription-session', { plan: 'yearly' }));
  assert.equal(res.statusCode, 200);
  assert.equal(stripeStub.lastSessionParams.line_items[0].price, 'price_yearly_test');
});

test('Orbit: plan inválido -> 400', async () => {
  const res = await handler(authed('/create-subscription-session', { plan: 'lifetime' }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'invalid_plan');
});

test('Orbit: sin token -> 401', async () => {
  const res = await handler(httpEvent({ path: '/create-subscription-session', body: { plan: 'monthly', returnUrl: 'https://app.test/' } }));
  assert.equal(res.statusCode, 401);
});

test('Orbit: sin price configurado -> 503 honesto (no inventa precio)', async () => {
  // index.js lee las env vars al cargar el módulo: importar una instancia
  // fresca con la variable ausente para cubrir la rama 503 de verdad.
  const saved = process.env.STRIPE_PRICE_ORBIT_MONTHLY;
  delete process.env.STRIPE_PRICE_ORBIT_MONTHLY;
  try {
    const fresh = await import('../index.js?orbit_noprice=' + Date.now());
    const res = await fresh.handler(authed('/create-subscription-session', { plan: 'monthly' }));
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).error, 'subscription_not_configured');
  } finally {
    process.env.STRIPE_PRICE_ORBIT_MONTHLY = saved;
  }
});

// ---------- /subscription-status (fail closed) ----------

test('Orbit: sin registro -> active:false (fail closed)', async () => {
  const res = await handler(authed('/subscription-status'));
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.active, false);
  assert.equal(data.status, 'none');
  assert.equal(data.plan, null);
});

test('Orbit: sin token -> 401', async () => {
  const res = await handler(httpEvent({ path: '/subscription-status', body: {} }));
  assert.equal(res.statusCode, 401);
});
test('Orbit: subscription-status incluye configured:true con prices en env', async () => {
  const res = await handler(authed('/subscription-status'));
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.configured, true);
  assert.equal(data.active, false);
});

test('Orbit: subscription-status configured:false sin prices (honesto)', async () => {
  const m = process.env.STRIPE_PRICE_ORBIT_MONTHLY;
  const y = process.env.STRIPE_PRICE_ORBIT_YEARLY;
  delete process.env.STRIPE_PRICE_ORBIT_MONTHLY;
  delete process.env.STRIPE_PRICE_ORBIT_YEARLY;
  try {
    const res = await handler(authed('/subscription-status'));
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.configured, false);
    assert.equal(data.active, false);
  } finally {
    process.env.STRIPE_PRICE_ORBIT_MONTHLY = m;
    process.env.STRIPE_PRICE_ORBIT_YEARLY = y;
  }
});

test('Transactions: POST con idToken en el cuerpo -> 200 (sin preflight)', async () => {
  const res = await handler(httpEvent({ method: 'POST', path: '/transactions', body: { idToken: validToken() } }));
  assert.equal(res.statusCode, 200);
  const b = JSON.parse(res.body);
  assert.ok(Array.isArray(b.transactions), 'transactions es arreglo');
});

test('Transactions: POST sin token -> 401', async () => {
  const res = await handler(httpEvent({ method: 'POST', path: '/transactions', body: {} }));
  assert.equal(res.statusCode, 401);
});

// ---------- /create-customer-portal ----------

test('Orbit: portal sin suscripción -> 404 honesto', async () => {
  const res = await handler(authed('/create-customer-portal'));
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, 'no_subscription');
});

test('Orbit: portal con customer -> url del portal', async () => {
  ddbStub.__stubStore.set('users|user-abc/orbit', {
    pk: 'users', sk: 'user-abc/orbit',
    v: JSON.stringify({ status: 'active', plan: 'monthly', stripeCustomerId: 'cus_test_1', stripeSubscriptionId: 'sub_1', currentPeriodEnd: nowSec() + 99999, cancelAtPeriodEnd: false, updatedAt: Date.now() }),
  });
  const res = await handler(authed('/create-customer-portal'));
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.ok(data.url.includes('billing.stripe.com'));
  assert.equal(stripeStub.lastPortalParams.customer, 'cus_test_1');
});

// ---------- webhook: activación ----------

test('Orbit: checkout.session.completed subscription -> activa', async () => {
  const subId = 'sub_test_1';
  stripeStub.__setSubscription(subId, {
    id: subId, status: 'active', customer: 'cus_test_1',
    current_period_end: nowSec() + 2592000, cancel_at_period_end: false,
    metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'yearly' },
  });
  const res = await handler(webhookEvent('checkout.session.completed', {
    id: 'cs_test_1', mode: 'subscription', payment_status: 'paid', status: 'complete',
    subscription: subId, customer: 'cus_test_1', client_reference_id: 'user-abc',
    metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'yearly' },
  }, 'evt_orbit_1'));
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.activated, true);
  const rec = orbitRecord();
  assert.equal(rec.status, 'active');
  assert.equal(rec.plan, 'yearly');
  assert.equal(rec.stripeCustomerId, 'cus_test_1');
  assert.equal(rec.stripeSubscriptionId, subId);
  assert.ok(rec.currentPeriodEnd > nowSec());
  // /subscription-status ahora dice active:true
  const st = await handler(authed('/subscription-status'));
  const sdata = JSON.parse(st.body);
  assert.equal(sdata.active, true);
  assert.equal(sdata.plan, 'yearly');
});

test('Orbit: evento duplicado -> idempotente (duplicate:true)', async () => {
  const subId = 'sub_test_dup';
  stripeStub.__setSubscription(subId, {
    id: subId, status: 'active', customer: 'cus_test_1',
    current_period_end: nowSec() + 2592000, cancel_at_period_end: false,
    metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'monthly' },
  });
  const obj = {
    id: 'cs_test_dup', mode: 'subscription', payment_status: 'paid', status: 'complete',
    subscription: subId, customer: 'cus_test_1', client_reference_id: 'user-abc',
    metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'monthly' },
  };
  const r1 = await handler(webhookEvent('checkout.session.completed', obj, 'evt_dup_1'));
  assert.equal(JSON.parse(r1.body).activated, true);
  const r2 = await handler(webhookEvent('checkout.session.completed', obj, 'evt_dup_1'));
  assert.equal(r2.statusCode, 200);
  assert.equal(JSON.parse(r2.body).duplicate, true);
});

test('Orbit: checkout subscription sin metadata válida -> se ignora sin activar', async () => {
  const res = await handler(webhookEvent('checkout.session.completed', {
    id: 'cs_bad', mode: 'subscription', payment_status: 'paid', subscription: 'sub_x',
    metadata: {},
  }, 'evt_bad_1'));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ignored, 'bad_metadata');
  assert.equal(orbitRecord(), null);
});

// ---------- webhook: updated / deleted ----------

test('Orbit: subscription.updated past_due -> past_due', async () => {
  const res = await handler(webhookEvent('customer.subscription.updated', {
    id: 'sub_test_2', status: 'past_due', customer: 'cus_test_1',
    current_period_end: nowSec() + 2592000, cancel_at_period_end: false,
    metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'monthly' },
  }, 'evt_upd_1'));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).status, 'past_due');
  assert.equal(orbitRecord().status, 'past_due');
  const st = await handler(authed('/subscription-status'));
  assert.equal(JSON.parse(st.body).active, false, 'past_due no es activo (fail closed)');
});

test('Orbit: subscription.deleted -> canceled', async () => {
  // Primero activa...
  await handler(webhookEvent('customer.subscription.updated', {
    id: 'sub_test_3', status: 'active', customer: 'cus_test_1',
    current_period_end: nowSec() + 2592000, cancel_at_period_end: false,
    metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'monthly' },
  }, 'evt_upd_2'));
  assert.equal(orbitRecord().status, 'active');
  // ...luego cancela.
  const res = await handler(webhookEvent('customer.subscription.deleted', {
    id: 'sub_test_3', status: 'canceled', customer: 'cus_test_1',
    current_period_end: nowSec() + 100, cancel_at_period_end: false,
    metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'monthly' },
  }, 'evt_del_1'));
  assert.equal(res.statusCode, 200);
  const rec = orbitRecord();
  assert.equal(rec.status, 'canceled');
  const st = await handler(authed('/subscription-status'));
  assert.equal(JSON.parse(st.body).active, false);
});

// ---------- webhook: invoice.* ----------

test('Orbit: invoice.payment_failed -> past_due', async () => {
  const subId = 'sub_test_4';
  stripeStub.__setSubscription(subId, {
    id: subId, status: 'active', customer: 'cus_test_1',
    current_period_end: nowSec() + 2592000, cancel_at_period_end: false,
    metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'monthly' },
  });
  const res = await handler(webhookEvent('invoice.payment_failed', {
    id: 'in_test_1', subscription: subId, customer: 'cus_test_1',
  }, 'evt_inv_fail_1'));
  assert.equal(res.statusCode, 200);
  assert.equal(orbitRecord().status, 'past_due');
});

test('Orbit: invoice.payment_succeeded renueva el periodo', async () => {
  const subId = 'sub_test_5';
  const newEnd = nowSec() + 5184000;
  stripeStub.__setSubscription(subId, {
    id: subId, status: 'active', customer: 'cus_test_1',
    current_period_end: newEnd, cancel_at_period_end: false,
    metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'monthly' },
  });
  const res = await handler(webhookEvent('invoice.payment_succeeded', {
    id: 'in_test_2', subscription: subId, customer: 'cus_test_1',
  }, 'evt_inv_ok_1'));
  assert.equal(res.statusCode, 200);
  const rec = orbitRecord();
  assert.equal(rec.status, 'active');
  assert.equal(rec.currentPeriodEnd, newEnd);
});

// ---------- no regresión: Coins intacto ----------

test('Orbit: checkout de Coins (payment) sigue acreditando', async () => {
  const res = await handler(webhookEvent('checkout.session.completed', {
    id: 'cs_coins_1', mode: 'payment', payment_status: 'paid',
    client_reference_id: 'user-abc',
    metadata: { drex_user_sub: 'user-abc', drex_package_id: 'coins_100', drex_coins: '100' },
  }, 'evt_coins_1'));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).credited, true);
  // Y no tocó Drex Orbit.
  assert.equal(orbitRecord(), null);
});

test('Orbit: evento desconocido se acusa sin hacer nada', async () => {
  const res = await handler(webhookEvent('customer.created', { id: 'cus_x' }, 'evt_unk_1'));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ignored, 'customer.created');
});

test('Orbit: firma inválida -> 400', async () => {
  const res = await handler(httpEvent({
    path: '/webhook', body: '{"id":"x"}', headers: { 'stripe-signature': 't=1,v1=mala' },
  }));
  assert.equal(res.statusCode, 400);
});

// ---------- GET /transactions ----------

const authedGet = (headers = {}) => httpEvent({
  method: 'GET', path: '/transactions',
  headers: { authorization: 'Bearer ' + validToken(), ...headers },
});

test('Transactions: sin Authorization -> 401', async () => {
  const res = await handler(httpEvent({ method: 'GET', path: '/transactions' }));
  assert.equal(res.statusCode, 401);
});

test('Transactions: token inválido -> 401', async () => {
  const res = await handler(httpEvent({
    method: 'GET', path: '/transactions', headers: { authorization: 'Bearer xxx' },
  }));
  assert.equal(res.statusCode, 401);
});

test('Transactions: sin datos -> listas vacías honestas', async () => {
  const res = await handler(authedGet());
  assert.equal(res.statusCode, 200);
  const b = JSON.parse(res.body);
  assert.deepEqual(b.transactions, []);
  assert.equal(b.subscription.active, false);
  assert.equal(b.subscription.status, 'none');
});

test('Transactions: compra de Coins aparece en el historial', async () => {
  // Simula el webhook de compra acreditada.
  const wres = await handler(webhookEvent('checkout.session.completed', {
    id: 'cs_tx_1', mode: 'payment', payment_status: 'paid',
    client_reference_id: 'user-abc',
    metadata: { drex_user_sub: 'user-abc', drex_package_id: 'coins_550', drex_coins: '550' },
  }, 'evt_tx_1'));
  assert.equal(wres.statusCode, 200);
  const res = await handler(authedGet());
  assert.equal(res.statusCode, 200);
  const b = JSON.parse(res.body);
  assert.equal(b.transactions.length, 1);
  const tx = b.transactions[0];
  assert.equal(tx.type, 'coins');
  assert.equal(tx.amount, 550);
  assert.equal(tx.status, 'completed');
  assert.ok(tx.ts > 0);
  assert.ok(tx.label.includes('550'));
});

test('Transactions: facturas de Stripe aparecen como pagos Orbit', async () => {
  ddbStub.__stubStore.set('users|user-abc/orbit', {
    pk: 'users', sk: 'user-abc/orbit',
    v: JSON.stringify({ status: 'active', plan: 'monthly', stripeCustomerId: 'cus_orbit_1',
      stripeSubscriptionId: 'sub_orbit_1', currentPeriodEnd: Math.floor(Date.now()/1000)+2592000,
      cancelAtPeriodEnd: false, updatedAt: Date.now() }),
  });
  globalThis.__fakeInvoices = [
    { id: 'in_orbit_1', customer: 'cus_orbit_1', created: 1700000000, amount_paid: 499, currency: 'usd', status: 'paid' },
  ];
  const res = await handler(authedGet());
  assert.equal(res.statusCode, 200);
  const b = JSON.parse(res.body);
  const orb = b.transactions.find((t) => t.type === 'orbit');
  assert.ok(orb, 'debe incluir el pago Orbit');
  assert.equal(orb.amount, 499);
  assert.equal(orb.status, 'completed');
  assert.ok(orb.label.includes('Mensual'));
  assert.equal(b.subscription.active, true);
  assert.equal(b.subscription.plan, 'monthly');
  delete globalThis.__fakeInvoices;
});
