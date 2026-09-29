// Drex Payments — Lambda (Node 20) del backend REAL de pagos de Drex Coins.
//
// Endpoints (detrás de una Function URL con Auth NONE):
//   POST /create-checkout-session  {packageId, idToken, returnUrl} -> {url}
//   POST /webhook                  (llamado por Stripe, firma verificada)
//   GET  /health                    {ok:true} (smoke test)
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
//
// Despliegue: ver README.md y DEPLOY-CHECKLIST.md
// Variables de entorno requeridas:
//   STRIPE_SECRET_KEY      (sk_test_... / sk_live_... — SECRETO)
//   STRIPE_WEBHOOK_SECRET  (whsec_... — SECRETO)
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

  // Solo nos interesa el pago completado; lo demás se acusa recibo sin hacer nada.
  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ received: true, ignored: stripeEvent.type }) };
  }
  const session = stripeEvent.data.object || {};
  if (session.payment_status && session.payment_status !== 'paid') {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ received: true, ignored: 'unpaid' }) };
  }
  const md = session.metadata || {};
  const userSub = md.drex_user_sub || session.client_reference_id || null;
  const pkg = packageById(md.drex_package_id);
  if (!userSub || !pkg) {
    console.error('webhook missing/invalid metadata', { hasSub: !!userSub, pkgId: md.drex_package_id });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ received: true, ignored: 'bad_metadata' }) };
  }
  // Las monedas vienen de la lista canónica, nunca del metadata.
  try {
    const r = await creditCoins({ userSub, packageId: pkg.id, coins: pkg.coins, sessionId: session.id, eventId: stripeEvent.id });
    if (r.duplicate) {
      console.log('duplicate webhook event ignored', stripeEvent.id);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ received: true, duplicate: true }) };
    }
    console.log('coins credited', { pkg: pkg.id, coins: pkg.coins, session: session.id });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ received: true, credited: true, coins: r.newCoins }) };
  } catch (e) {
    console.error('credit failed:', e && e.message);
    // 500 => Stripe reintenta el webhook; la idempotencia evita doble abono.
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'credit_failed' }) };
  }
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
  if (method === 'POST' && path === '/create-checkout-session') {
    return handleCreateSession(event);
  }
  if (method === 'POST' && path === '/webhook') {
    return handleWebhook(event);
  }
  return json(404, { error: 'not_found' }, origin);
};
