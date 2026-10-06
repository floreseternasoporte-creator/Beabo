// Drex Payments — Lambda (Node 20) del backend REAL de pagos de Drex Coins.
//
// Endpoints (detrás de una Function URL con Auth NONE):
//   POST /create-checkout-session      {packageId, idToken, returnUrl} -> {url}
//   POST /create-subscription-session {plan, idToken, returnUrl} -> {url}
//                                     (Stripe Checkout mode:'subscription', planes Drex Orbit)
//   POST /create-customer-portal      {idToken, returnUrl?} -> {url}
//                                     (portal de facturación de Stripe)
//   POST /subscribe-embedded          {plan, idToken} -> {subscriptionId, clientSecret} | {alreadySubscribed:true}
//                                     (C244: pago SIN salir de la app — Payment Element;
//                                      suscripción default_incomplete, el webhook activa)
//   POST /subscription-cancel         {idToken} -> {ok, cancelAtPeriodEnd:true, currentPeriodEnd, status}
//   POST /subscription-reactivate     {idToken} -> {ok, cancelAtPeriodEnd:false, currentPeriodEnd, status}
//   POST /subscription-setup          {idToken} -> {clientSecret}
//                                     {idToken, paymentMethodId} -> {ok:true, updated:true}
//                                     (C244: Setup Element para cambiar la tarjeta)
//   POST /subscription-status         {idToken} -> {active, plan, currentPeriodEnd, cancelAtPeriodEnd, status}
//   GET  /transactions                Authorization: Bearer <idToken> -> {transactions[], subscription{}}
//                                     (fail closed: sin registro -> active:false)
//   POST /webhook                      (llamado por Stripe, firma verificada)
//   GET  /health                        {ok:true} (smoke test)
//
// Flujo:
//   1. La app pide una Checkout Session con el ID token de Cognito del
//      comprador. La Lambda valida el JWT (JWKS del user pool), valida el
//      paquete contra la lista canónica y crea la sesión en Stripe.
//   2. El navegador va a Stripe Checkout y paga.
//   3. Stripe llama a /webhook (checkout.session.completed). La Lambda
//      verifica la firma con STRIPE_WEBHOOK_SECRET, y acredita las monedas
//      en DynamoDB de forma TRANSACCIONAL e IDEMPOTENTE (un evento de
//      Stripe nunca acredita dos veces, aunque Stripe reintente).
//
// Formato DynamoDB (igual que escribe drex-cloud.js en el cliente):
//   wallets/<uid>            -> pk='wallets', sk='<uid>/coins|diamonds|updatedAt', v=JSON
//   transactions/<uid>/<tx>  -> pk='transactions', sk='<uid>/<txid>/<campo>', v=JSON
//   stripe_events/<eventId>  -> pk='stripe_events', sk='<eventId>' (idempotencia)
//   ratelimit/pay/...       -> interno de la Lambda (rate limiting)
//   users/<sub>/orbit      -> pk='users', sk='<sub>/orbit', v=JSON con
//                              {status, plan, stripeCustomerId, stripeSubscriptionId,
//                               currentPeriodEnd, cancelAtPeriodEnd, updatedAt}
//                              status: 'active' | 'past_due' | 'canceled' | 'none'.
//                              La app NUNCA escribe este nodo: solo la Lambda,
//                              y solo desde eventos firmados de Stripe.
//
// Despliegue: ver README.md y DEPLOY-CHECKLIST.md
// Variables de entorno requeridas:
//   STRIPE_SECRET_KEY      (sk_test_... / sk_live_... — SECRETO)
//   STRIPE_WEBHOOK_SECRET  (whsec_... — SECRETO)
//   STRIPE_PRICE_ORBIT_MONTHLY (price_... del plan mensual Drex Orbit; si falta -> 503 honesto)
//   STRIPE_PRICE_ORBIT_YEARLY  (price_... del plan anual Drex Orbit; si falta -> 503 honesto)
//   DREX_TABLE             (default: drex-kv)
//   COGNITO_USER_POOL_ID   (ej. us-east-1_kDSYEBsnY)
//   COGNITO_CLIENT_ID      (app client de Drex; público, vive en la app)
//   ALLOWED_ORIGINS        (coma-separado; ej. https://floreseternasoporte-creator.github.io,https://drex.glamworksapps.workers.dev)
//   RL_MAX / RL_WINDOW_SEC (opcional; default 30 / 600)
//
// REGLAS DE SEGURIDAD:
// - Los secretos SOLO viven en variables de entorno. Jamás se imprimen en
//   logs, jamás se devuelven en respuestas, jamás se escriben en DynamoDB.
// - El ID token de Cognito jamás se registra en logs.
// - Las monedas acreditadas SIEMPRE vienen de la lista canónica (nunca del
//   metadata de Stripe sin validar, nunca del cliente).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import crypto from 'node:crypto';

const TABLE = process.env.DREX_TABLE || 'drex-kv';
const POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || '';
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const RL_MAX = parseInt(process.env.RL_MAX || '30', 10);
const RL_WINDOW_SEC = parseInt(process.env.RL_WINDOW_SEC || '600', 10);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
let stripeClient = null;
function stripe() {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY || '';
    if (!key) throw Object.assign(new Error('stripe_not_configured'), { status: 503 });
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}

// Lista canónica de paquetes: la única fuente de verdad de precio/monedas.
// Debe coincidir con DREX_COIN_PACKAGES de la app (ids y monedas).
const PACKAGES = [
  { id: 'coins_100',   name: 'Paquete Inicial',  coins: 100,   cents: 99 },
  { id: 'coins_550',   name: 'Paquete Bronce',   coins: 550,   cents: 499 },
  { id: 'coins_1200',  name: 'Paquete Plata',    coins: 1200,  cents: 999 },
  { id: 'coins_3250',  name: 'Paquete Oro',      coins: 3250,  cents: 2499 },
  { id: 'coins_7000',  name: 'Paquete Leyenda',  coins: 7000,  cents: 4999 },
  { id: 'coins_15000', name: 'Paquete Universo', coins: 15000, cents: 9999 },
];
function packageById(id) {
  return PACKAGES.find((p) => p.id === id) || null;
}

// ---------- Drex Orbit: planes de suscripción orbit ----------
// Un solo nivel (Drex Orbit), cuatro planes. monthly/yearly usan price IDs
// de Stripe en env vars; quarterly/semiannual se crean con price_data inline
// (precio fijo en el código: no requieren configuración en el dashboard de
// Stripe). Si falta el price del plan pedido y no hay price_data, la ruta
// responde 503 honesto en vez de inventar un precio.
const ORBIT_PLANS = {
  monthly: { name: 'Drex Orbit Mensual' },
  quarterly: { name: 'Drex Orbit Trimestral', priceData: { unit_amount: 1299, interval_count: 3 } },
  semiannual: { name: 'Drex Orbit Semestral', priceData: { unit_amount: 2499, interval_count: 6 } },
  yearly: { name: 'Drex Orbit Anual' },
};
function orbitPriceId(plan) {
  if (plan === 'monthly') return process.env.STRIPE_PRICE_ORBIT_MONTHLY || '';
  if (plan === 'yearly') return process.env.STRIPE_PRICE_ORBIT_YEARLY || '';
  return '';
}
function orbitPlanDisplayName(plan) {
  return (ORBIT_PLANS[plan] && ORBIT_PLANS[plan].name) || 'Drex Orbit';
}
/* line_item de Stripe para el plan: price ID configurado o price_data inline.
 * Devuelve null si el plan no tiene precio disponible ( -> 503 honesto). */
function orbitLineItem(plan) {
  const spec = ORBIT_PLANS[plan];
  if (!spec) return null;
  const priceId = orbitPriceId(plan);
  if (priceId) return { price: priceId, quantity: 1 };
  if (spec.priceData) {
    return {
      price_data: {
        currency: 'usd',
        unit_amount: spec.priceData.unit_amount,
        recurring: { interval: 'month', interval_count: spec.priceData.interval_count },
        product_data: { name: spec.name },
      },
      quantity: 1,
    };
  }
  return null;
}
/* true cuando los Price IDs de Stripe están configurados en la Lambda.
 * La app lo usa para activar las puertas automáticamente (fail-closed). */
function orbitConfigured() {
  return !!(process.env.STRIPE_PRICE_ORBIT_MONTHLY && process.env.STRIPE_PRICE_ORBIT_YEARLY);
}

// ---------- utilidades HTTP ----------

function corsHeaders(origin) {
  const o = String(origin || '');
  const allow = ALLOWED_ORIGINS.includes(o) ? o : (ALLOWED_ORIGINS[0] || '');
  return {
    'Content-Type': 'application/json',
    ...(allow ? { 'Access-Control-Allow-Origin': allow, Vary: 'Origin' } : {}),
  };
}
function json(status, body, origin) {
  return { statusCode: status, headers: corsHeaders(origin), body: JSON.stringify(body) };
}
function clientIp(event) {
  try { return event.requestContext.http.sourceIp || 'unknown'; } catch (_) { return 'unknown'; }
}
function rawBody(event) {
  let b = event.body || '';
  if (event.isBase64Encoded) b = Buffer.from(b, 'base64').toString('utf8');
  return b;
}
function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ---------- verificación del ID token de Cognito ----------

let jwksCache = null;
let jwksCacheTs = 0;
async function getJwks() {
  const now = Date.now();
  if (jwksCache && now - jwksCacheTs < 3600_000) return jwksCache;
  const region = POOL_ID.split('_')[0];
  const url = `https://cognito-idp.${region}.amazonaws.com/${POOL_ID}/.well-known/jwks.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('jwks_fetch_failed');
  jwksCache = await res.json();
  jwksCacheTs = now;
  return jwksCache;
}

async function verifyIdToken(token) {
  if (!POOL_ID || !CLIENT_ID) throw Object.assign(new Error('cognito_not_configured'), { status: 503 });
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw Object.assign(new Error('invalid_token'), { status: 401 });
  }
  const [hB64, pB64, sB64] = token.split('.');
  let header, payload;
  try {
    header = JSON.parse(b64urlDecode(hB64).toString('utf8'));
    payload = JSON.parse(b64urlDecode(pB64).toString('utf8'));
  } catch (_) {
    throw Object.assign(new Error('invalid_token'), { status: 401 });
  }
  if (header.alg !== 'RS256' || !header.kid) throw Object.assign(new Error('invalid_token'), { status: 401 });
  const jwks = await getJwks();
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) throw Object.assign(new Error('invalid_token'), { status: 401 });
  let key;
  try {
    key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch (_) {
    throw Object.assign(new Error('invalid_token'), { status: 401 });
  }
  const ok = crypto.verify('sha256', Buffer.from(hB64 + '.' + pB64, 'utf8'), key, b64urlDecode(sB64));
  if (!ok) throw Object.assign(new Error('invalid_token'), { status: 401 });
  const now = Math.floor(Date.now() / 1000);
  const region = POOL_ID.split('_')[0];
  if (typeof payload.exp !== 'number' || payload.exp < now) throw Object.assign(new Error('expired_token'), { status: 401 });
  if (typeof payload.iat === 'number' && payload.iat > now + 120) throw Object.assign(new Error('invalid_token'), { status: 401 });
  if (payload.iss !== `https://cognito-idp.${region}.amazonaws.com/${POOL_ID}`) throw Object.assign(new Error('invalid_token'), { status: 401 });
  if (payload.token_use !== 'id') throw Object.assign(new Error('invalid_token'), { status: 401 });
  if (payload.aud !== CLIENT_ID) throw Object.assign(new Error('invalid_token'), { status: 401 });
  if (!payload.sub || typeof payload.sub !== 'string') throw Object.assign(new Error('invalid_token'), { status: 401 });
  return payload.sub;
}

// ---------- rate limiting (ventana fija, atómico) ----------

async function checkRateLimit(ip) {
  const win = Math.floor(Date.now() / 1000 / RL_WINDOW_SEC);
  const sk = `pay/${ip}/${win}`;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: 'ratelimit', sk },
      UpdateExpression: 'SET #c = if_not_exists(#c, :zero) + :one, #e = if_not_exists(#e, :exp)',
      ConditionExpression: 'attribute_not_exists(#c) OR #c < :max',
      ExpressionAttributeNames: { '#c': 'n', '#e': 'exp' },
      ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':max': RL_MAX, ':exp': Math.floor(Date.now() / 1000) + RL_WINDOW_SEC },
    }));
    return true;
  } catch (e) {
    if (e && e.name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

// ---------- POST /create-checkout-session ----------

function validReturnUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'https:') return null;
    const origin = u.origin;
    if (!ALLOWED_ORIGINS.includes(origin)) return null;
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch (_) {
    return null;
  }
}

async function handleCreateSession(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  let body;
  try {
    body = JSON.parse(rawBody(event) || '{}');
  } catch (_) {
    return json(400, { error: 'bad_json' }, origin);
  }
  const ip = clientIp(event);
  if (!(await checkRateLimit(ip))) return json(429, { error: 'rate_limited' }, origin);

  const pkg = packageById(body.packageId);
  if (!pkg) return json(400, { error: 'invalid_package' }, origin);
  const returnUrl = validReturnUrl(body.returnUrl);
  if (!returnUrl) return json(400, { error: 'invalid_return_url' }, origin);

  let userSub;
  try {
    userSub = await verifyIdToken(body.idToken);
  } catch (e) {
    const status = (e && e.status) || 401;
    return json(status, { error: status === 503 ? 'server_not_configured' : 'unauthorized' }, origin);
  }

  let session;
  try {
    session = await stripe().checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: pkg.cents,
          product_data: {
            name: `Drex Coins — ${pkg.name}`,
            description: `${pkg.coins} Drex Coins`,
          },
        },
        quantity: 1,
      }],
      metadata: {
        drex_user_sub: userSub,
        drex_package_id: pkg.id,
        drex_coins: String(pkg.coins),
      },
      client_reference_id: userSub,
      success_url: `${returnUrl}/?coins=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnUrl}/?coins=cancelled`,
    });
  } catch (e) {
    console.error('stripe session create failed:', e && e.message);
    return json(502, { error: 'payment_provider_error' }, origin);
  }
  // Nunca se registra el secreto; el session id no es sensible.
  console.log('checkout session created', session.id, 'pkg', pkg.id);
  return json(200, { url: session.url }, origin);
}

// ---------- Drex Orbit: suscripción orbit ----------

async function readOrbit(userSub) {
  try {
    const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: 'users', sk: userSub + '/orbit' } }));
    if (!r.Item || typeof r.Item.v === 'undefined') return null;
    const o = JSON.parse(String(r.Item.v));
    return (o && typeof o === 'object') ? o : null;
  } catch (e) {
    console.error('orbit read failed:', e && e.message);
    throw Object.assign(new Error('db_read_failed'), { status: 500 });
  }
}

// Fail closed: cualquier estado que no sea inequívocamente activo se trata
// como no suscriptor. Un periodo ya vencido nunca cuenta como activo.
function orbitIsActive(rec) {
  if (!rec) return false;
  if (rec.status !== 'active') return false;
  if (rec.currentPeriodEnd && Number(rec.currentPeriodEnd) * 1000 < Date.now()) return false;
  return true;
}

function mapSubscriptionStatus(s) {
  if (s === 'active' || s === 'trialing') return 'active';
  if (s === 'past_due' || s === 'unpaid' || s === 'incomplete') return 'past_due';
  return 'canceled'; // canceled | incomplete_expired | desconocido -> no activo
}

// Guarda el estado de Drex Orbit de forma idempotente por evento de Stripe:
// el mismo evento reintentado no escribe dos veces (condición sobre
// stripe_events dentro de la misma transacción que el Put del estado).
async function saveOrbitState({ userSub, status, plan, stripeCustomerId, stripeSubscriptionId, currentPeriodEnd, cancelAtPeriodEnd, eventId, eventType }) {
  const now = Date.now();
  let prev = null;
  try {
    prev = await readOrbit(userSub);
  } catch (e) {
    throw e;
  }
  const next = {
    status,
    plan: plan || (prev && prev.plan) || null,
    stripeCustomerId: stripeCustomerId || (prev && prev.stripeCustomerId) || null,
    stripeSubscriptionId: stripeSubscriptionId || (prev && prev.stripeSubscriptionId) || null,
    currentPeriodEnd: (currentPeriodEnd != null ? currentPeriodEnd : (prev && prev.currentPeriodEnd)) || null,
    cancelAtPeriodEnd: !!cancelAtPeriodEnd,
    updatedAt: now,
  };
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE,
            Item: { pk: 'users', sk: userSub + '/orbit', v: JSON.stringify(next) },
          },
        },
        {
          Put: {
            TableName: TABLE,
            Item: {
              pk: 'stripe_events',
              sk: eventId,
              v: JSON.stringify({ type: eventType, userSub, status, ts: now }),
            },
            ConditionExpression: 'attribute_not_exists(sk)',
          },
        },
      ],
    }));
  } catch (e) {
    if (e && e.name === 'TransactionCanceledException') {
      const reasons = e.CancellationReasons || [];
      if (reasons[1] && reasons[1].Code === 'ConditionalCheckFailed') {
        return { duplicate: true };
      }
    }
    console.error('orbit save failed:', e && e.message);
    throw Object.assign(new Error('db_write_failed'), { status: 500 });
  }
  return { saved: true, state: next };
}

/* Fin de periodo vigente de una suscripción. Desde la API 2025-03-31
 * (Basil), Stripe quitó current_period_end del nivel superior de la
 * suscripción y lo movió a cada ítem (items.data[].current_period_end);
 * el SDK aquí instalado (stripe@22, API 2026-08-26.dahlia) ya devuelve
 * esa forma nueva. Leer SOLO el campo superior dejaba currentPeriodEnd
 * en null para siempre (sin fecha de renovación y sin caducidad por
 * tiempo). Se lee el mayor fin de periodo entre los ítems, con el
 * campo superior heredado como respaldo. */
function subscriptionPeriodEnd(sub) {
  if (sub && sub.current_period_end != null) return sub.current_period_end;
  const items = (sub && sub.items && Array.isArray(sub.items.data)) ? sub.items.data : [];
  let end = null;
  for (const it of items) {
    if (it && it.current_period_end != null) {
      end = (end == null) ? it.current_period_end : Math.max(end, it.current_period_end);
    }
  }
  return end;
}

function subscriptionStateFrom(sub, planHint) {
  const md = (sub && sub.metadata) || {};
  return {
    status: mapSubscriptionStatus(sub && sub.status),
    plan: md.drex_orbit_plan || planHint || null,
    stripeCustomerId: (sub && sub.customer) || null,
    stripeSubscriptionId: (sub && sub.id) || null,
    currentPeriodEnd: subscriptionPeriodEnd(sub),
    cancelAtPeriodEnd: !!(sub && sub.cancel_at_period_end),
  };
}

// ---------- C263: rutas que sacaban al usuario de Drex retiradas ----------
// /create-subscription-session (Stripe Checkout hospedado) y
// /create-customer-portal (portal de Stripe) se eliminaron: el cliente
// ya no los invoca y todo el pago vive dentro de la app.

// ---------- C244: pago embebido y gestión sin salir de la app ----------
// El Checkout hospedado obligaba a salir de Drex para pagar y el portal
// de Stripe para gestionar. Estos endpoints dejan todo dentro de la app:
// la app monta el Payment Element con el clientSecret de la suscripción
// (default_incomplete) y la activación llega por los mismos webhooks de
// siempre (customer.subscription.updated / invoice.*), que identifican al
// usuario por el metadata drex_user_sub de la suscripción — por eso TODA
// suscripción creada aquí lleva ese metadata, igual que el flujo Checkout
// (subscription_data.metadata). Sin checkout.session.completed no pasa
// nada: la activación nunca dependió solo de él.

/* PaymentIntent confirmable de una factura de suscripción. Desde la API
 * 2025-03-31 (Basil), Invoice.payment_intent dejó de existir: el intent
 * vive en invoice.payments.data[].payment.payment_intent (type
 * 'payment_intent'). El campo legado solo se acepta como respaldo para
 * respuestas de cuentas fijadas a una API anterior. */
function invoicePaymentIntent(inv) {
  if (!inv || typeof inv !== 'object') return null;
  const pagos = (inv.payments && Array.isArray(inv.payments.data)) ? inv.payments.data : [];
  for (const p of pagos) {
    const pay = p && p.payment;
    if (!pay || (pay.type && pay.type !== 'payment_intent')) continue;
    const pi = pay.payment_intent;
    if (pi && typeof pi === 'object') return pi;
  }
  const legacy = inv.payment_intent;
  if (legacy && typeof legacy === 'object') return legacy;
  return null;
}

/* Resuelve el customer de Stripe del usuario sin duplicarlo: primero el
 * registro Orbit local; si aún no hay registro (ningún webhook ha
 * escrito), busca por metadata drex_user_sub — cubre clientes creados
 * por un intento embebido anterior cuyo pago nunca se completó. */
async function findOrbitCustomerId(userSub, rec) {
  if (rec && rec.stripeCustomerId) return rec.stripeCustomerId;
  try {
    const safeSub = String(userSub || '').replace(/['\\]/g, '');
    if (!safeSub) return null;
    const found = await stripe().customers.search({
      query: `metadata['drex_user_sub']:'${safeSub}'`,
      limit: 1,
    });
    if (found && Array.isArray(found.data) && found.data[0] && found.data[0].id) return found.data[0].id;
  } catch (e) {
    console.error('orbit customer search failed:', e && e.message);
  }
  return null;
}

/* Suscripción viva del usuario en Stripe (para gestión): la del registro
 * local o, si el registro aún no existe, la que el propio Stripe lista
 * para su customer con nuestro metadata. Nunca adivina por otro camino. */
async function resolveOrbitSubscriptionId(userSub, rec) {
  if (rec && rec.stripeSubscriptionId) return rec.stripeSubscriptionId;
  const customerId = await findOrbitCustomerId(userSub, rec);
  if (!customerId) return null;
  try {
    const subs = await stripe().subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
    const mine = ((subs && subs.data) || []).find(
      (s) => s && s.metadata && s.metadata.drex_user_sub === userSub && s.status !== 'canceled',
    );
    return mine ? mine.id : null;
  } catch (e) {
    console.error('orbit subscription list failed:', e && e.message);
    return null;
  }
}

/* Lee y valida el cuerpo + token de los endpoints Orbit autenticados.
 * Devuelve {body, userSub} o {response} con el error ya construido. */
async function orbitAuthedBody(event, origin) {
  let body;
  try {
    body = JSON.parse(rawBody(event) || '{}');
  } catch (_) {
    return { response: json(400, { error: 'bad_json' }, origin) };
  }
  const ip = clientIp(event);
  if (!(await checkRateLimit(ip))) return { response: json(429, { error: 'rate_limited' }, origin) };
  try {
    const userSub = await verifyIdToken(body.idToken);
    return { body, userSub };
  } catch (e) {
    const status = (e && e.status) || 401;
    return { response: json(status, { error: status === 503 ? 'server_not_configured' : 'unauthorized' }, origin) };
  }
}

// ---------- POST /subscribe-embedded ----------
// Crea (o reutiliza) la suscripción en default_incomplete y devuelve el
// clientSecret del PaymentIntent de la primera factura para montar el
// Payment Element DENTRO de la app. Idempotente frente a reintentos:
// activa/trialing -> alreadySubscribed; incomplete -> el mismo secreto;
// incomplete sin intent útil -> se cancela antes de crear otra (nunca
// dos suscripciones cobrables vivas para el mismo usuario).
async function handleSubscribeEmbedded(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const auth = await orbitAuthedBody(event, origin);
  if (auth.response) return auth.response;
  const { body, userSub } = auth;

  const plan = body.plan;
  if (!ORBIT_PLANS[plan]) return json(400, { error: 'invalid_plan' }, origin);
  const lineItem = orbitLineItem(plan);
  if (!lineItem) return json(503, { error: 'subscription_not_configured' }, origin);

  let rec = null;
  try {
    rec = await readOrbit(userSub);
  } catch (e) {
    return json(500, { error: 'db_read_failed' }, origin);
  }

  try {
    let customerId = await findOrbitCustomerId(userSub, rec);
    if (customerId) {
      const subs = await stripe().subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
      const mine = ((subs && subs.data) || []).filter(
        (s) => s && s.metadata && s.metadata.drex_user_sub === userSub,
      );
      const live = mine.find((s) => s.status === 'active' || s.status === 'trialing');
      if (live) {
        return json(200, {
          alreadySubscribed: true,
          subscriptionId: live.id,
          plan: (live.metadata && live.metadata.drex_orbit_plan) || plan,
        }, origin);
      }
      const open = mine.find((s) => s.status === 'incomplete' || s.status === 'past_due');
      if (open) {
        if (open.status === 'past_due') {
          // Suscripción real con deuda: no se duplica; la app ofrece
          // actualizar el método de pago (/subscription-setup).
          return json(200, {
            alreadySubscribed: true,
            subscriptionId: open.id,
            plan: (open.metadata && open.metadata.drex_orbit_plan) || plan,
            needsPaymentUpdate: true,
          }, origin);
        }
        const full = await stripe().subscriptions.retrieve(open.id, { expand: ['latest_invoice.payments'] });
        const pi = invoicePaymentIntent(full && full.latest_invoice);
        const secret = pi ? pi.client_secret : null;
        if (secret) {
          return json(200, { subscriptionId: open.id, clientSecret: secret, reused: true }, origin);
        }
        // Incomplete sin intent utilizable (expirado): se cancela para no
        // dejar dos suscripciones vivas y se crea una nueva abajo.
        try { await stripe().subscriptions.cancel(open.id); } catch (_) {}
      }
    }
    if (!customerId) {
      // Un solo customer por usuario en Stripe: la clave de idempotencia
      // estable evita duplicados si la búsqueda aún no lo ve y la app
      // reintenta.
      const cust = await stripe().customers.create(
        { metadata: { drex_user_sub: userSub } },
        { idempotencyKey: 'drex_cust_' + userSub },
      );
      customerId = cust.id;
    }
    const sub = await stripe().subscriptions.create({
      customer: customerId,
      items: [lineItem],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      metadata: { drex_user_sub: userSub, drex_orbit_plan: plan },
      expand: ['latest_invoice.payments'],
    }, {
      // Reintentos de red/app dentro de la misma hora no crean una segunda
      // suscripción: Stripe devuelve la primera respuesta. La ventana de
      // una hora no bloquea un intento genuinamente nuevo más tarde.
      idempotencyKey: 'drex_sub_' + userSub + '_' + plan + '_' + Math.floor(Date.now() / 3600000),
    });
    const pi = invoicePaymentIntent(sub && sub.latest_invoice);
    const secret = pi ? pi.client_secret : null;
    if (!secret) return json(502, { error: 'payment_provider_error' }, origin);
    console.log('orbit embedded subscription created', sub.id, 'plan', plan);
    return json(200, { subscriptionId: sub.id, clientSecret: secret }, origin);
  } catch (e) {
    console.error('orbit embedded subscribe failed:', e && e.message);
    return json(502, { error: 'payment_provider_error' }, origin);
  }
}

/* Refleja cancelAtPeriodEnd en el registro local al instante, sin esperar
 * al webhook customer.subscription.updated (que escribirá el mismo valor:
 * idempotente). Solo toca ese flag: status/plan/periodo quedan como los
 * dejó el último evento firmado. Sin registro previo no escribe nada —
 * el webhook creará el registro con el valor correcto. */
async function mergeOrbitCancelFlag(userSub, flag) {
  try {
    const prev = await readOrbit(userSub);
    if (!prev) return;
    const next = { ...prev, cancelAtPeriodEnd: !!flag, updatedAt: Date.now() };
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: 'users', sk: userSub + '/orbit' },
      UpdateExpression: 'SET v = :v',
      ExpressionAttributeValues: { ':v': JSON.stringify(next) },
    }));
  } catch (e) {
    console.error('orbit cancel flag merge failed:', e && e.message);
  }
}

// ---------- POST /subscription-cancel | /subscription-reactivate ----------
// Cancelar = cancel_at_period_end:true en Stripe (no cobra más; el
// periodo pagado corre hasta su fin y los beneficios se apagan en la app
// por la regla verifiedActive de C243). Reactivar lo deshace.
async function handleSubscriptionCancelFlag(event, cancelAtPeriodEnd) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const auth = await orbitAuthedBody(event, origin);
  if (auth.response) return auth.response;
  const { userSub } = auth;

  let rec = null;
  try {
    rec = await readOrbit(userSub);
  } catch (e) {
    return json(500, { error: 'db_read_failed' }, origin);
  }
  const subId = await resolveOrbitSubscriptionId(userSub, rec);
  if (!subId) return json(404, { error: 'no_subscription' }, origin);

  let sub;
  try {
    /* C263: si ya está cancelada, responder 200 con ese estado — Stripe
     * rechaza actualizar suscripciones canceladas y la app recibía un
     * 502 en vez del estado real del usuario. */
    const cur = await stripe().subscriptions.retrieve(subId);
    if (cur && cur.status === 'canceled') {
      return json(200, {
        ok: true,
        cancelAtPeriodEnd: typeof cur.cancel_at_period_end === 'boolean' ? cur.cancel_at_period_end : cancelAtPeriodEnd,
        currentPeriodEnd: subscriptionPeriodEnd(cur),
        status: mapSubscriptionStatus(cur.status),
      }, origin);
    }
    sub = await stripe().subscriptions.update(subId, { cancel_at_period_end: cancelAtPeriodEnd });
  } catch (e) {
    console.error('orbit subscription update failed:', e && e.message);
    return json(502, { error: 'payment_provider_error' }, origin);
  }
  await mergeOrbitCancelFlag(userSub, cancelAtPeriodEnd);
  return json(200, {
    ok: true,
    cancelAtPeriodEnd: typeof (sub && sub.cancel_at_period_end) === 'boolean' ? sub.cancel_at_period_end : cancelAtPeriodEnd,
    currentPeriodEnd: subscriptionPeriodEnd(sub),
    status: mapSubscriptionStatus(sub && sub.status),
  }, origin);
}
async function handleSubscriptionCancel(event) {
  return handleSubscriptionCancelFlag(event, true);
}
async function handleSubscriptionReactivate(event) {
  return handleSubscriptionCancelFlag(event, false);
}

// ---------- POST /subscription-setup ----------
// Dos pasos del mismo endpoint:
//  - sin paymentMethodId: crea el SetupIntent (Setup Element en la app).
//  - con paymentMethodId (tras confirmSetup): la tarjeta queda como
//    método predeterminado del cliente y de la suscripción, para que el
//    próximo cobro la use sin salir de Drex.
async function handleSubscriptionSetup(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const auth = await orbitAuthedBody(event, origin);
  if (auth.response) return auth.response;
  const { body, userSub } = auth;

  let rec = null;
  try {
    rec = await readOrbit(userSub);
  } catch (e) {
    return json(500, { error: 'db_read_failed' }, origin);
  }
  // Actualizar la tarjeta es cosa de suscriptores: sin suscripción
  // resoluble (registro local o lista de Stripe) es 404 honesto, igual
  // que cancelar/reactivar.
  const subId = await resolveOrbitSubscriptionId(userSub, rec);
  if (!subId) return json(404, { error: 'no_subscription' }, origin);
  const customerId = await findOrbitCustomerId(userSub, rec);
  if (!customerId) return json(404, { error: 'no_subscription' }, origin);

  try {
    const pmId = typeof body.paymentMethodId === 'string' && body.paymentMethodId ? body.paymentMethodId : null;
    if (pmId) {
      try {
        await stripe().paymentMethods.attach(pmId, { customer: customerId });
      } catch (e) {
        // Ya adjunto a este cliente (confirmSetup lo adjunta): se sigue.
        console.error('orbit payment method attach note:', e && e.message);
      }
      await stripe().customers.update(customerId, {
        invoice_settings: { default_payment_method: pmId },
      });
      try {
        await stripe().subscriptions.update(subId, { default_payment_method: pmId });
      } catch (e) {
        console.error('orbit subscription default pm update failed:', e && e.message);
      }
      return json(200, { ok: true, updated: true }, origin);
    }
    const si = await stripe().setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: { drex_user_sub: userSub },
    });
    if (!si || !si.client_secret) return json(502, { error: 'payment_provider_error' }, origin);
    return json(200, { clientSecret: si.client_secret }, origin);
  } catch (e) {
    console.error('orbit setup failed:', e && e.message);
    return json(502, { error: 'payment_provider_error' }, origin);
  }
}

// ---------- POST /subscription-status ----------
// NOTA: es POST (no GET) a propósito: el idToken en un query string de GET
// quedaría registrado en los logs de acceso de la Function URL. El cuerpo
// JSON no se registra.

async function handleSubscriptionStatus(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  let body;
  try {
    body = JSON.parse(rawBody(event) || '{}');
  } catch (_) {
    return json(400, { error: 'bad_json' }, origin);
  }
  const ip = clientIp(event);
  if (!(await checkRateLimit(ip))) return json(429, { error: 'rate_limited' }, origin);

  let userSub;
  try {
    userSub = await verifyIdToken(body.idToken);
  } catch (e) {
    const status = (e && e.status) || 401;
    return json(status, { error: status === 503 ? 'server_not_configured' : 'unauthorized' }, origin);
  }

  let rec = null;
  try {
    rec = await readOrbit(userSub);
  } catch (e) {
    return json(500, { error: 'db_read_failed' }, origin);
  }
  if (!rec) {
    return json(200, { active: false, plan: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, status: 'none', configured: orbitConfigured() }, origin);
  }
  return json(200, {
    active: orbitIsActive(rec),
    plan: rec.plan || null,
    currentPeriodEnd: rec.currentPeriodEnd || null,
    cancelAtPeriodEnd: !!rec.cancelAtPeriodEnd,
    status: rec.status || 'none',
    configured: orbitConfigured(),
  }, origin);
}


// ---------- GET|POST /transactions ----------
// Historial real de la cuenta: compras de Drex Coins (DynamoDB, lo que el
// webhook registró) + pagos de Drex Orbit (facturas de Stripe) + estado
// actual de la suscripción. Autenticado con Cognito ID token: en el cuerpo
// (POST, petición CORS simple sin preflight) o en el header Authorization
// (Bearer, GET). Si no hay registros, devuelve listas vacías:
// la app muestra un estado vacío honesto, nunca inventa movimientos.
async function handleTransactions(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const ip = clientIp(event);
  if (!(await checkRateLimit(ip))) return json(429, { error: 'rate_limited' }, origin);

  const txMethod = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || event.httpMethod || 'GET';
  let txToken = '';
  if (txMethod === 'POST') {
    try { txToken = String(JSON.parse(rawBody(event) || '{}').idToken || ''); } catch (_) { txToken = ''; }
  }
  if (!txToken) {
    const authH = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const m = /^Bearer\s+(.+)$/.exec(String(authH).trim());
    if (m) txToken = m[1];
  }
  if (!txToken) return json(401, { error: 'unauthorized' }, origin);
  let userSub;
  try {
    userSub = await verifyIdToken(txToken);
  } catch (e) {
    const status = (e && e.status) || 401;
    return json(status, { error: status === 503 ? 'server_not_configured' : 'unauthorized' }, origin);
  }

  // 1) Compras de Drex Coins desde DynamoDB (hojas transactions/<sub>/<txid>/<campo>)
  const txs = [];
  try {
    let lastKey = undefined;
    do {
      const q = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :pre)',
        ExpressionAttributeValues: { ':pk': 'transactions', ':pre': userSub + '/' },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      const byTx = {};
      for (const it of (q.Items || [])) {
        const parts = String(it.sk || '').split('/');
        if (parts.length < 3) continue;
        const txid = parts[1];
        const field = parts.slice(2).join('/');
        let v = null;
        try { v = JSON.parse(it.v); } catch (_) { v = it.v; }
        (byTx[txid] = byTx[txid] || {})[field] = v;
      }
      for (const txid of Object.keys(byTx)) {
        const r = byTx[txid];
        if (!r.ts) continue;
        const pkg = r.meta && r.meta.pkg ? packageById(r.meta.pkg) : null;
        txs.push({
          id: txid,
          type: 'coins',
          ts: Number(r.ts) || 0,
          amount: Number(r.amount) || 0,
          currency: 'coins',
          cents: pkg ? pkg.cents : null,
          label: pkg ? (pkg.name + ' — ' + pkg.coins + ' monedas') : 'Compra de Drex Coins',
          status: r.type === 'purchase' ? 'completed' : String(r.type || 'unknown'),
        });
      }
      lastKey = q.LastEvaluatedKey;
    } while (lastKey);
  } catch (e) {
    console.error('transactions query failed:', e && e.message);
    return json(500, { error: 'db_read_failed' }, origin);
  }

  // 2) Estado de la suscripción Drex Orbit (DynamoDB, fuente de verdad local)
  let rec = null;
  try {
    rec = await readOrbit(userSub);
  } catch (e) {
    return json(500, { error: 'db_read_failed' }, origin);
  }
  const subscription = rec ? {
    active: orbitIsActive(rec),
    plan: rec.plan || null,
    status: rec.status || 'none',
    currentPeriodEnd: rec.currentPeriodEnd || null,
    cancelAtPeriodEnd: !!rec.cancelAtPeriodEnd,
  } : { active: false, plan: null, status: 'none', currentPeriodEnd: null, cancelAtPeriodEnd: false };

  // 3) Pagos de Drex Orbit desde Stripe (facturas del cliente)
  if (rec && rec.stripeCustomerId) {
    try {
      const invs = await stripe().invoices.list({ customer: rec.stripeCustomerId, limit: 25 });
      for (const inv of (invs && invs.data) || []) {
        const planName = orbitPlanDisplayName(rec.plan);
        txs.push({
          id: String(inv.id || ''),
          type: 'orbit',
          ts: Number(inv.created || 0) * 1000,
          amount: Number(inv.amount_paid || 0),
          currency: String(inv.currency || 'usd'),
          label: planName,
          status: inv.status === 'paid' ? 'completed' : String(inv.status || 'unknown'),
        });
      }
    } catch (e) {
      // Stripe caído no rompe el historial: se devuelven las compras locales.
      console.error('stripe invoices failed:', e && e.message);
    }
  }

  txs.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return json(200, { transactions: txs, subscription }, origin);
}

// ---------- webhook: eventos de suscripción Drex Orbit ----------

function wok(body) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
function werr(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// checkout.session.completed con mode:'subscription': activa Drex Orbit.
// La suscripción se recupera de Stripe para datos autoritativos
// (periodo actual, customer id).
async function handleKoroneCheckoutCompleted(stripeEvent, session) {
  if (session.payment_status && session.payment_status !== 'paid' && session.status !== 'complete') {
    return wok({ received: true, ignored: 'unpaid' });
  }
  const md = session.metadata || {};
  const userSub = md.drex_user_sub || session.client_reference_id || null;
  const plan = md.drex_orbit_plan;
  /* Todos los planes que /create-subscription-session acepta (ORBIT_PLANS)
   * deben activar aquí. Antes solo entraban monthly/yearly y un pago
   * quarterly/semiannual cobrado se ignoraba como "bad_metadata": el
   * usuario pagaba y su suscripción nunca se activaba. */
  if (!userSub || !ORBIT_PLANS[plan]) {
    console.error('orbit webhook missing/invalid metadata', { hasSub: !!userSub, plan });
    return wok({ received: true, ignored: 'bad_metadata' });
  }
  const subRef = session.subscription;
  const subId = typeof subRef === 'string' ? subRef : (subRef && subRef.id);
  if (!subId) {
    console.error('orbit webhook without subscription id', { session: session.id });
    return wok({ received: true, ignored: 'no_subscription' });
  }
  let sub = null;
  try {
    sub = await stripe().subscriptions.retrieve(subId);
  } catch (e) {
    console.error('orbit subscription retrieve failed:', e && e.message);
    // 500 => Stripe reintenta; la idempotencia evita doble activación.
    return werr(500, { error: 'subscription_fetch_failed' });
  }
  const st = subscriptionStateFrom(sub, plan);
  if (!st.stripeCustomerId) st.stripeCustomerId = session.customer || null;
  if (!st.stripeSubscriptionId) st.stripeSubscriptionId = subId;
  try {
    const r = await saveOrbitState({ userSub, ...st, eventId: stripeEvent.id, eventType: stripeEvent.type });
    if (r.duplicate) {
      console.log('duplicate orbit webhook event ignored', stripeEvent.id);
      return wok({ received: true, duplicate: true });
    }
    console.log('orbit activated', { plan: st.plan, subscription: st.stripeSubscriptionId });
    return wok({ received: true, activated: true, plan: st.plan });
  } catch (e) {
    return werr(500, { error: 'orbit_save_failed' });
  }
}

// customer.subscription.updated / customer.subscription.deleted
async function handleKoroneSubscriptionEvent(stripeEvent, sub, type) {
  const md = (sub && sub.metadata) || {};
  const userSub = md.drex_user_sub || null;
  if (!userSub) {
    // Sin metadata no hay forma segura de identificar al usuario (no hay
    // índice customer->sub). Se registra y se ignora; no se adivina.
    console.error('orbit subscription event without drex_user_sub', { type, sub: sub && sub.id });
    return wok({ received: true, ignored: 'no_user' });
  }
  const st = subscriptionStateFrom(sub, null);
  if (type === 'customer.subscription.deleted') st.status = 'canceled';
  try {
    const r = await saveOrbitState({ userSub, ...st, eventId: stripeEvent.id, eventType: type });
    if (r.duplicate) {
      console.log('duplicate orbit webhook event ignored', stripeEvent.id);
      return wok({ received: true, duplicate: true });
    }
    console.log('orbit subscription event', { type, status: st.status, sub: st.stripeSubscriptionId });
    return wok({ received: true, updated: true, status: st.status });
  } catch (e) {
    return werr(500, { error: 'orbit_save_failed' });
  }
}

// invoice.payment_succeeded / invoice.payment_failed: renovaciones y fallos.
async function handleKoroneInvoiceEvent(stripeEvent, invoice, type) {
  const subRef = invoice.subscription
    || (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription)
    || null;
  const subId = typeof subRef === 'string' ? subRef : (subRef && subRef.id);
  if (!subId) return wok({ received: true, ignored: 'no_subscription' });
  let sub = null;
  try {
    sub = await stripe().subscriptions.retrieve(subId);
  } catch (e) {
    console.error('orbit invoice subscription retrieve failed:', e && e.message);
    return werr(500, { error: 'subscription_fetch_failed' });
  }
  const md = (sub && sub.metadata) || {};
  const userSub = md.drex_user_sub || null;
  if (!userSub) {
    console.error('orbit invoice event without drex_user_sub', { type, sub: subId });
    return wok({ received: true, ignored: 'no_user' });
  }
  const st = subscriptionStateFrom(sub, null);
  // Un pago fallido marca morosidad aunque la suscripción siga listada
  // como activa en este instante; el siguiente updated la corregirá.
  if (type === 'invoice.payment_failed') st.status = 'past_due';
  try {
    const r = await saveOrbitState({ userSub, ...st, eventId: stripeEvent.id, eventType: type });
    if (r.duplicate) {
      console.log('duplicate orbit webhook event ignored', stripeEvent.id);
      return wok({ received: true, duplicate: true });
    }
    console.log('orbit invoice event', { type, status: st.status, sub: subId });
    return wok({ received: true, updated: true, status: st.status });
  } catch (e) {
    return werr(500, { error: 'orbit_save_failed' });
  }
}

// checkout.session.completed de pago único (Drex Coins): lógica original,
// sin cambios de comportamiento.
async function handleCoinsCheckoutCompleted(stripeEvent, session) {
  if (session.payment_status && session.payment_status !== 'paid') {
    return wok({ received: true, ignored: 'unpaid' });
  }
  const md = session.metadata || {};
  const userSub = md.drex_user_sub || session.client_reference_id || null;
  const pkg = packageById(md.drex_package_id);
  if (!userSub || !pkg) {
    console.error('webhook missing/invalid metadata', { hasSub: !!userSub, pkgId: md.drex_package_id });
    return wok({ received: true, ignored: 'bad_metadata' });
  }
  // Las monedas vienen de la lista canónica, nunca del metadata.
  try {
    const r = await creditCoins({ userSub, packageId: pkg.id, coins: pkg.coins, sessionId: session.id, eventId: stripeEvent.id });
    if (r.duplicate) {
      console.log('duplicate webhook event ignored', stripeEvent.id);
      return wok({ received: true, duplicate: true });
    }
    console.log('coins credited', { pkg: pkg.id, coins: pkg.coins, session: session.id });
    return wok({ received: true, credited: true, coins: r.newCoins });
  } catch (e) {
    console.error('credit failed:', e && e.message);
    // 500 => Stripe reintenta el webhook; la idempotencia evita doble abono.
    return werr(500, { error: 'credit_failed' });
  }
}

// ---------- POST /webhook ----------


function receiptLeafPuts(userSub, receipt) {
  const base = `${userSub}/${receipt.txid}`;
  const fields = {
    txid: receipt.txid,
    type: receipt.type,
    amount: receipt.amount,
    currency: receipt.currency,
    balance: receipt.balance,
    ts: receipt.ts,
    meta: receipt.meta,
  };
  return Object.keys(fields).map((k) => ({
    Put: {
      TableName: TABLE,
      Item: { pk: 'transactions', sk: `${base}/${k}`, v: JSON.stringify(fields[k]) },
    },
  }));
}

async function creditCoins({ userSub, packageId, coins, sessionId, eventId }) {
  // txid determinista por evento: un reintento del mismo evento no duplica el recibo.
  const txid = 'stripe_' + String(eventId).replace(/[^A-Za-z0-9]/g, '').slice(-24);
  const coinsSk = `${userSub}/coins`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let oldV = null;
    try {
      const cur = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: 'wallets', sk: coinsSk } }));
      if (cur.Item && typeof cur.Item.v !== 'undefined') oldV = String(cur.Item.v);
    } catch (e) {
      console.error('wallet read failed:', e && e.message);
      throw Object.assign(new Error('db_read_failed'), { status: 500 });
    }
    let oldCoins = 0;
    if (oldV !== null) {
      try { oldCoins = parseInt(JSON.parse(oldV), 10) || 0; } catch (_) { oldCoins = 0; }
    }
    const newCoins = oldCoins + coins;
    const ts = Date.now();
    const receipt = {
      txid, type: 'purchase', amount: coins, currency: 'coins', balance: newCoins, ts,
      meta: { provider: 'stripe', pkg: packageId, txId: sessionId, event: eventId },
    };
    // Un solo Put condicional sobre la billetera: DynamoDB rechaza dos
    // operaciones sobre el mismo ítem en una transacción, así que la
    // condición anti-carrera va en el propio Put (no en un ConditionCheck
    // separado).
    const walletCond = oldV === null
      ? { ConditionExpression: 'attribute_not_exists(v)' }
      : { ConditionExpression: 'v = :oldV', ExpressionAttributeValues: { ':oldV': oldV } };
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          // 0: acreditación atómica — solo si la billetera no cambió desde
          // la lectura (si cambió, se reintenta con el valor fresco).
          {
            Put: {
              TableName: TABLE,
              Item: { pk: 'wallets', sk: coinsSk, v: String(newCoins) },
              ...walletCond,
            },
          },
          // 1: idempotencia — este evento de Stripe solo se procesa una vez.
          {
            Put: {
              TableName: TABLE,
              Item: {
                pk: 'stripe_events',
                sk: eventId,
                v: JSON.stringify({ type: 'checkout.session.completed', session: sessionId, userSub, packageId, coins, ts }),
              },
              ConditionExpression: 'attribute_not_exists(sk)',
            },
          },
          // 2: marca de actualización.
          { Put: { TableName: TABLE, Item: { pk: 'wallets', sk: `${userSub}/updatedAt`, v: String(ts) } } },
          // 3+: recibo en el libro (lo lee DrexCoins.history en la app).
          ...receiptLeafPuts(userSub, receipt),
        ],
      }));
      return { credited: true, newCoins };
    } catch (e) {
      if (e && e.name === 'TransactionCanceledException') {
        const reasons = e.CancellationReasons || [];
        // Índice 1 = el Put de idempotencia: el evento ya se procesó.
        if (reasons[1] && reasons[1].Code === 'ConditionalCheckFailed') {
          return { duplicate: true };
        }
        // Índice 0 = la billetera cambió entre lectura y escritura: reintentar.
        continue;
      }
      console.error('wallet transact failed:', e && e.message);
      throw Object.assign(new Error('db_write_failed'), { status: 500 });
    }
  }
  throw Object.assign(new Error('wallet_contention'), { status: 500 });
}

async function handleWebhook(event) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    return { statusCode: 503, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'webhook_not_configured' }) };
  }
  const headers = event.headers || {};
  const sig = headers['stripe-signature'] || headers['Stripe-Signature'] || '';
  const payload = rawBody(event);
  let stripeEvent;
  try {
    stripeEvent = stripe().webhooks.constructEvent(payload, sig, webhookSecret);
  } catch (e) {
    console.error('webhook signature invalid:', e && e.message);
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'invalid_signature' }) };
  }

  const type = stripeEvent.type;
  const obj = stripeEvent.data.object || {};

  if (type === 'checkout.session.completed') {
    // Suscripción Drex Orbit vs compra única de Coins: el modo manda.
    if (obj.mode === 'subscription') return handleKoroneCheckoutCompleted(stripeEvent, obj);
    return handleCoinsCheckoutCompleted(stripeEvent, obj);
  }
  if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
    // C244 (auditoría): con el pago embebido NO hay
    // checkout.session.completed, y no hace falta: este handler y el de
    // invoice.* ya guardan el mismo registro Orbit completo
    // (subscriptionStateFrom: status, plan, customer, subscription,
    // currentPeriodEnd vía items y cancelAtPeriodEnd) identificando al
    // usuario por el metadata drex_user_sub de la suscripción, que tanto
    // el flujo Checkout (subscription_data) como /subscribe-embedded
    // fijan al crearla. La activación embebida llega por aquí.
    return handleKoroneSubscriptionEvent(stripeEvent, obj, type);
  }
  if (type === 'invoice.payment_succeeded' || type === 'invoice.payment_failed') {
    return handleKoroneInvoiceEvent(stripeEvent, obj, type);
  }
  // Lo demás se acusa recibo sin hacer nada.
  return wok({ received: true, ignored: type });
}

// ---------- handler ----------

export const handler = async (event) => {
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || event.httpMethod || 'GET';
  const rawPath = event.rawPath || event.path || '/';
  const path = rawPath.replace(/\/+$/, '') || '/';
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }
  if (method === 'GET' && (path === '/health' || path === '' || path === '/')) {
    return json(200, { ok: true, service: 'drex-payments', time: new Date().toISOString() }, origin);
  }
  /* C263: create-checkout-session / create-subscription-session /
   * create-customer-portal retirados — sacaban al usuario de Drex
   * (Stripe Checkout / portal hospedado) y el cliente ya no los usa.
   * Todo el pago ocurre dentro de la app (endpoints embebidos). */
  if (method === 'POST' && path === '/subscribe-embedded') {
    return handleSubscribeEmbedded(event);
  }
  if (method === 'POST' && path === '/subscription-cancel') {
    return handleSubscriptionCancel(event);
  }
  if (method === 'POST' && path === '/subscription-reactivate') {
    return handleSubscriptionReactivate(event);
  }
  if (method === 'POST' && path === '/subscription-setup') {
    return handleSubscriptionSetup(event);
  }
  if (method === 'POST' && path === '/subscription-status') {
    return handleSubscriptionStatus(event);
  }
  if ((method === 'GET' || method === 'POST') && path === '/transactions') {
    return handleTransactions(event);
  }
  if (method === 'POST' && path === '/webhook') {
    return handleWebhook(event);
  }
  return json(404, { error: 'not_found' }, origin);
};
