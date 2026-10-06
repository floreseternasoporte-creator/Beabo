// QA de pagos Drex de punta a punta LOCAL (sin red ni cargos): recorre el
// handler real de la Lambda con Stripe/DynamoDB stubbeados y eventos
// webhook firmados con HMAC real, igual que Stripe.
// Cubre los fallos encontrados en la auditoría 2026-10-02:
//  - API Stripe post-Basil (2025-03-31+): current_period_end vive en
//    items.data[].current_period_end, NO en el nivel superior. El SDK
//    stripe@22 (API 2026-08-26.dahlia) ya devuelve esa forma: el webhook
//    debe registrar la fecha de renovación.
//  - Planes quarterly/semiannual: su checkout.session.completed debe
//    activar Orbit (antes se ignoraba como bad_metadata tras cobrar).
//  - invoice.*: la suscripción puede venir en
//    invoice.parent.subscription_details.subscription.
// Ejecutar: node --loader ./test/loader.mjs --test test/qa-pagos.test.mjs
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
function webhookEvent(type, object, id = 'evt_qa_1') {
  const payload = JSON.stringify({ id, type, data: { object } });
  const sig = stripeStub.signTestPayload(payload, process.env.STRIPE_WEBHOOK_SECRET);
  return httpEvent({ path: '/webhook', body: payload, headers: { 'stripe-signature': sig } });
}
const walletCoins = (sub = 'user-abc') => {
  const it = ddbStub.__stubGet('wallets', sub + '/coins');
  return it ? parseInt(JSON.parse(it.v), 10) : 0;
};
const orbitRecord = (sub = 'user-abc') => {
  const it = ddbStub.__stubGet('users', sub + '/orbit');
  return it ? JSON.parse(it.v) : null;
};

test('QA Coins $0.99: la ruta de Checkout salió de Drex (C263) y el webhook firmado sigue acreditando', async () => {
  const s = await handler(httpEvent({
    path: '/create-checkout-session',
    body: { packageId: 'coins_100', idToken: validToken(), returnUrl: 'https://app.test/Beabo/' },
  }));
  assert.equal(s.statusCode, 404);
  assert.equal(JSON.parse(s.body).error, 'not_found');

  const session = {
    id: 'cs_test_qa_1', mode: 'payment', payment_status: 'paid',
    client_reference_id: 'user-abc',
    metadata: { drex_user_sub: 'user-abc', drex_package_id: 'coins_100', drex_coins: '100' },
  };
  const w1 = await handler(webhookEvent('checkout.session.completed', session, 'evt_qa_coins_1'));
  assert.equal(w1.statusCode, 200);
  assert.equal(JSON.parse(w1.body).credited, true);
  assert.equal(walletCoins(), 100);
  assert.ok(ddbStub.__stubGet('transactions', 'user-abc/stripe_evtqacoins1/amount'), 'recibo: amount');
  assert.ok(ddbStub.__stubGet('stripe_events', 'evt_qa_coins_1'), 'idempotencia registrada');

  const w2 = await handler(webhookEvent('checkout.session.completed', session, 'evt_qa_coins_1'));
  assert.equal(JSON.parse(w2.body).duplicate, true);
  assert.equal(walletCoins(), 100, 'un reintento de Stripe no abona dos veces');
});

test('QA Orbit mensual con forma post-Basil: activa y guarda fin de periodo desde items', async () => {
  const periodEnd = nowSec() + 2592000;
  // Forma que devuelve el SDK stripe@22 (API dahlia): SIN current_period_end superior.
  stripeStub.__setSubscription('sub_qa_1', {
    id: 'sub_qa_1', status: 'active', customer: 'cus_qa_1',
    cancel_at_period_end: false,
    items: { data: [{ id: 'si_qa_1', current_period_start: nowSec(), current_period_end: periodEnd }] },
    metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'monthly' },
  });
  const session = {
    id: 'cs_test_qa_2', mode: 'subscription', payment_status: 'paid', status: 'complete',
    customer: 'cus_qa_1', subscription: 'sub_qa_1',
    client_reference_id: 'user-abc',
    metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'monthly' },
  };
  const w = await handler(webhookEvent('checkout.session.completed', session, 'evt_qa_orbit_1'));
  assert.equal(w.statusCode, 200);
  assert.equal(JSON.parse(w.body).activated, true);
  const rec = orbitRecord();
  assert.equal(rec.status, 'active');
  assert.equal(rec.plan, 'monthly');
  assert.equal(rec.currentPeriodEnd, periodEnd, 'currentPeriodEnd sale de items (Basil)');

  const st = await handler(httpEvent({ path: '/subscription-status', body: { idToken: validToken() } }));
  const stBody = JSON.parse(st.body);
  assert.equal(stBody.active, true);
  assert.equal(stBody.currentPeriodEnd, periodEnd);
  assert.equal(stBody.configured, true);
});

test('QA Orbit quarterly (price_data): el webhook ACTIVA la suscripción cobrada', async () => {
  const periodEnd = nowSec() + 7776000;
  stripeStub.__setSubscription('sub_qa_2', {
    id: 'sub_qa_2', status: 'active', customer: 'cus_qa_2',
    cancel_at_period_end: false,
    items: { data: [{ id: 'si_qa_2', current_period_end: periodEnd }] },
    metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'quarterly' },
  });
  const session = {
    id: 'cs_test_qa_3', mode: 'subscription', payment_status: 'paid', status: 'complete',
    customer: 'cus_qa_2', subscription: 'sub_qa_2',
    client_reference_id: 'user-abc',
    metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'quarterly' },
  };
  const w = await handler(webhookEvent('checkout.session.completed', session, 'evt_qa_orbit_2'));
  assert.equal(JSON.parse(w.body).activated, true);
  const rec = orbitRecord();
  assert.equal(rec.status, 'active');
  assert.equal(rec.plan, 'quarterly');
  assert.equal(rec.currentPeriodEnd, periodEnd);
});

test('QA invoice.payment_succeeded post-Basil renueva el periodo (parent.subscription_details)', async () => {
  const firstEnd = nowSec() + 2592000;
  const renewedEnd = firstEnd + 2592000;
  stripeStub.__setSubscription('sub_qa_3', {
    id: 'sub_qa_3', status: 'active', customer: 'cus_qa_3',
    cancel_at_period_end: false,
    items: { data: [{ id: 'si_qa_3', current_period_end: firstEnd }] },
    metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'monthly' },
  });
  // Estado inicial como lo dejaría el checkout.
  await handler(webhookEvent('checkout.session.completed', {
    id: 'cs_test_qa_4', mode: 'subscription', payment_status: 'paid', status: 'complete',
    customer: 'cus_qa_3', subscription: 'sub_qa_3',
    client_reference_id: 'user-abc',
    metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'monthly' },
  }, 'evt_qa_orbit_3'));
  assert.equal(orbitRecord().currentPeriodEnd, firstEnd);

  // La renovación: el retrieve ya trae el periodo nuevo.
  stripeStub.__setSubscription('sub_qa_3', {
    id: 'sub_qa_3', status: 'active', customer: 'cus_qa_3',
    cancel_at_period_end: false,
    items: { data: [{ id: 'si_qa_3', current_period_end: renewedEnd }] },
    metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'monthly' },
  });
  const inv = {
    id: 'in_qa_1', customer: 'cus_qa_3',
    parent: { subscription_details: { subscription: 'sub_qa_3' } },
  };
  const w = await handler(webhookEvent('invoice.payment_succeeded', inv, 'evt_qa_inv_1'));
  assert.equal(w.statusCode, 200);
  assert.equal(JSON.parse(w.body).updated, true);
  assert.equal(orbitRecord().status, 'active');
  assert.equal(orbitRecord().currentPeriodEnd, renewedEnd, 'el periodo avanzó con la renovación');
});

test('QA webhook con firma inválida -> 400 y no toca saldos', async () => {
  const payload = JSON.stringify({
    id: 'evt_qa_bad', type: 'checkout.session.completed',
    data: { object: { id: 'cs_x', mode: 'payment', payment_status: 'paid', metadata: { drex_user_sub: 'user-abc', drex_package_id: 'coins_100' } } },
  });
  const r = await handler(httpEvent({
    path: '/webhook', body: payload,
    headers: { 'stripe-signature': 't=1,v1=deadbeef' },
  }));
  assert.equal(r.statusCode, 400);
  assert.equal(walletCoins(), 0);
});
