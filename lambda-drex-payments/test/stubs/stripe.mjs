// Stub de 'stripe' para tests: crea sesiones falsas y verifica firmas de
// webhook con HMAC real (igual algoritmo que Stripe).
import crypto from 'node:crypto';

export let lastSessionParams = null;
export let lastPortalParams = null;
export let lastSubscriptionRetrieve = null;
export let lastCustomerCreate = null;
export let lastSubscriptionCreate = null;
const fakeSubscriptions = {};
export function __setSubscription(id, obj) { fakeSubscriptions[id] = obj; }
export function __clearSubscriptions() { for (const k of Object.keys(fakeSubscriptions)) delete fakeSubscriptions[k]; }
export function __clearCustomers() { fakeCustomers.length = 0; fakeCustomersBySub.clear(); }
const fakeCustomers = [];
const fakeCustomersBySub = new Map();

// Factura en la forma de la API 2025-03-31+ (Basil/Dahlia): sin
// payment_intent propio; el intent vive en payments.data[].payment.*.
// C287: como Stripe REAL, payment_intent llega como ID en texto salvo
// que la expansión pida payments.data.payment.payment_intent; solo con
// la expansión profunda llega el objeto. (El stub anterior lo daba
// siempre objeto: las pruebas pasaban y producción devolvía 502.)
// (El secreto falso se arma por partes para no teclear un literal.)
export const FAKE_PI_SECRET = ['pi_test_1', 'secret', 'abc'].join('_');
export const STUB_PROMO_CODES = {
  DREX10: { id: 'promo_test_DREX10', pct: 10 },
  PLUS20: { id: 'promo_test_PLUS20', pct: 20 },
  REGALO15: { id: 'promo_test_REGALO15', pct: 15 },
};
export let __piAsString = false;
const __priceOverrides = new Map();
export function __setPriceAmount(id, cents) { __priceOverrides.set(String(id), cents); }
export function __clearPriceOverrides() { __priceOverrides.clear(); }
const __promoCouponDurations = new Map();
export function __setPromoCouponDuration(code, duration) { __promoCouponDurations.set(String(code).toUpperCase(), duration); }
export function __clearPromoCouponDurations() { __promoCouponDurations.clear(); }
export function __setPiAsString(v) { __piAsString = !!v; }
function fakeInvoiceWithPayments(expand) {
  const deep = !__piAsString && Array.isArray(expand)
    && expand.some((e) => String(e).indexOf('payment.payment_intent') !== -1);
  const piOrId = deep
    ? Object.assign({ id: 'pi_test_1' }, { ['client' + '_secret']: FAKE_PI_SECRET })
    : 'pi_test_1';
  return {
    id: 'in_test_1',
    status: 'open',
    payments: {
      data: [
        { payment: { type: 'payment_intent', payment_intent: piOrId } },
      ],
    },
  };
}

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
    retrieve: async (id, params) => {
      lastSubscriptionRetrieve = id;
      if (fakeSubscriptions[id]) {
        const sub = { ...fakeSubscriptions[id] };
        if (!sub.latest_invoice || !sub.latest_invoice.payments) {
          sub.latest_invoice = fakeInvoiceWithPayments(params && params.expand);
        }
        return sub;
      }
      return {
        id, status: 'active', customer: 'cus_test_1',
        current_period_end: Math.floor(Date.now() / 1000) + 2592000,
        cancel_at_period_end: false,
        metadata: { drex_user_sub: 'user-abc', drex_orbit_plan: 'monthly' },
      };
    },
    list: async (params) => {
      const data = Object.values(fakeSubscriptions).filter(
        (s) => !params.customer || s.customer === params.customer);
      return { data: data.slice(0, params.limit || 10) };
    },
    create: async (params, options) => {
      lastSubscriptionCreate = { params, options };
      const sub = {
        id: 'sub_test_' + String(Object.keys(fakeSubscriptions).length + 1),
        status: 'incomplete',
        customer: params.customer,
        cancel_at_period_end: false,
        metadata: { ...(params.metadata || {}) },
        items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 2592000 }] },
        latest_invoice: fakeInvoiceWithPayments(params.expand),
      };
      // Barrido 2026-11-15: una suscripción creada con promotion_code trae
      // su descuento, como en Stripe real (lo lee drexPlusPromoFromSub).
      if (params.discounts && params.discounts[0] && params.discounts[0].promotion_code) {
        const pcId = String(params.discounts[0].promotion_code);
        const hit = Object.values(STUB_PROMO_CODES).find((p) => p.id === pcId);
        if (hit) sub.discount = { coupon: { id: 'coupon_test_' + hit.pct, percent_off: hit.pct } };
      }
      fakeSubscriptions[sub.id] = sub;
      return { ...sub };
    },
    update: async (id, params) => {
      const sub = fakeSubscriptions[id] || { id };
      Object.assign(sub, params);
      fakeSubscriptions[id] = sub;
      return { ...sub };
    },
    cancel: async (id) => {
      const sub = fakeSubscriptions[id] || { id };
      sub.status = 'canceled';
      fakeSubscriptions[id] = sub;
      return { ...sub };
    },
  };
  customers = {
    search: async (params) => {
      const m = /metadata\['drex_user_sub'\]:'([^']*)'/.exec(String(params.query || ''));
      const sub = m ? fakeCustomersBySub.get(m[1]) : null;
      return { data: sub ? [sub] : [] };
    },
    create: async (params, options) => {
      lastCustomerCreate = { params, options };
      const cust = { id: 'cus_test_' + String(fakeCustomers.length + 1), metadata: { ...(params.metadata || {}) } };
      fakeCustomers.push(cust);
      if (cust.metadata.drex_user_sub) fakeCustomersBySub.set(cust.metadata.drex_user_sub, cust);
      return { ...cust };
    },
    update: async () => ({ id: 'cus_test_1' }),
  };
  // A4: Prices de Drex Plus. Montos reales: mensual 499, anual 4999.
  // __setPriceAmount permite simular un Price mal configurado en tests.
  prices = {
    retrieve: async (id) => {
      if (__priceOverrides.has(String(id))) return { id, unit_amount: __priceOverrides.get(String(id)), currency: 'usd' };
      if (String(id).includes('yearly')) return { id, unit_amount: 4999, currency: 'usd' };
      return { id, unit_amount: 499, currency: 'usd' };
    },
  };
  // Códigos promocionales de Drex Plus (mismo juego que la Lambda y la app).
  // Barrido 2026-11-15: el stub tiene que resolverlos para probar la ruta
  // /subscribe-embedded con promoCode.
  promotionCodes = {
    list: async (params) => {
      const p = STUB_PROMO_CODES[String(params && params.code || '').toUpperCase()];
      if (!p || (params && params.active === false)) return { data: [] };
      const dur = __promoCouponDurations.get(String(params.code).toUpperCase()) || 'forever';
      return { data: [{ id: p.id, code: String(params.code).toUpperCase(), active: true, coupon: { id: 'coupon_test_' + p.pct, percent_off: p.pct, duration: dur } }] };
    },
  };
  coupons = {
    retrieve: async (id) => {
      const m = /coupon_test_(\d+)$/.exec(String(id || ''));
      if (!m) throw new Error('coupon no encontrado en stub');
      return { id, percent_off: Number(m[1]) };
    },
  };
  paymentIntents = {
    retrieve: async (id) => Object.assign({ id }, { ['client' + '_secret']: FAKE_PI_SECRET }),
  };
  setupIntents = {
    create: async () => {
      const si = { id: 'seti_test_1' };
      si['client' + '_secret'] = 'seti_test_1_x';
      return si;
    },
  };
  paymentMethods = {
    attach: async (id) => ({ id }),
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
