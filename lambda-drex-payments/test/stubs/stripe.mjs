// Stub de 'stripe' para tests: crea sesiones falsas y verifica firmas de
// webhook con HMAC real (igual algoritmo que Stripe).
import crypto from 'node:crypto';

export let lastSessionParams = null;
export let lastPortalParams = null;
export let lastSubscriptionRetrieve = null;
const fakeSubscriptions = {};
export function __setSubscription(id, obj) { fakeSubscriptions[id] = obj; }
export function __clearSubscriptions() { for (const k of Object.keys(fakeSubscriptions)) delete fakeSubscriptions[k]; }

function parseSigHeader(h) {
  const out = {};
  String(h || '').split(',').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}

export default class Stripe {
  constructor(key) {
    if (!key) throw new Error('stripe stub: falta secret key');
    this._key = key;
  }
  checkout = {
    sessions: {
      create: async (params) => {
        lastSessionParams = params;
        return { id: 'cs_test_abc123', url: 'https://checkout.stripe.com/c/pay/cs_test_abc123', ...params };
      },
    },
  };
  invoices = {
    list: async (params) => {
      const data = (globalThis.__fakeInvoices || []).filter(
        (inv) => !params.customer || inv.customer === params.customer);
      return { data: data.slice(0, params.limit || 10) };
    },
  };
  billingPortal = {
    sessions: {
      create: async (params) => {
        lastPortalParams = params;
        return { id: 'bps_test_1', url: 'https://billing.stripe.com/p/session/bps_test_1', ...params };
      },
    },
  };
  subscriptions = {
    retrieve: async (id) => {
      lastSubscriptionRetrieve = id;
      if (fakeSubscriptions[id]) return { ...fakeSubscriptions[id] };
      return {
        id, status: 'active', customer: 'cus_test_1',
        current_period_end: Math.floor(Date.now() / 1000) + 2592000,
        cancel_at_period_end: false,
        metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'monthly' },
      };
    },
  };
  webhooks = {
    constructEvent: (payload, sigHeader, secret) => {
      const { t, v1 } = parseSigHeader(sigHeader);
      if (!t || !v1 || !secret) {
        const e = new Error('Unable to extract timestamp and signatures from header');
        e.type = 'StripeSignatureVerificationError';
        throw e;
      }
      const expected = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
      const a = Buffer.from(String(v1));
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        const e = new Error('No signatures found matching the expected signature for payload.');
        e.type = 'StripeSignatureVerificationError';
        throw e;
      }
      return JSON.parse(payload);
    },
  };
}

// Firma un payload como lo haría Stripe (para los tests).
export function signTestPayload(payload, secret) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}
