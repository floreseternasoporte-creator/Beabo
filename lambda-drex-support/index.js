// Drex Support — Lambda (Node 20): soporte real con casos.
//
// Casos (tabla drex-support-tickets, índice userId-index):
//   POST /support/cases          {idToken, subject, message, category, priority}
//   POST /support/cases/list     {idToken}
//   POST /support/cases/reply    {idToken, ticketId, message}
//   POST /support/cases/close    {idToken, ticketId}
//   POST /support/admin/list     {idToken}                 (solo dueño)
//   POST /support/admin/reply    {idToken, ticketId, message} (solo dueño)
//   POST /support/admin/status   {idToken, ticketId, status}  (solo dueño)
// Avisos por correo (SES):
//   POST /support-notify         {idToken, kind:'report', reference}
//   GET  /health
//
// El cliente nunca toca la tabla: todo pasa por aquí con el ID token de
// Cognito validado (JWKS). Al crear un caso se envía confirmación al
// usuario y aviso al buzón; al responder el equipo se avisa al usuario;
// al responder el usuario se avisa al buzón.

const crypto = require('crypto');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || '';
const FROM = process.env.SUPPORT_FROM || '';
const INBOX = process.env.SUPPORT_INBOX || '';
const SUPPORT_TABLE = process.env.SUPPORT_TABLE || 'drex-support-tickets';

const ses = new SESv2Client({ region: 'us-east-1' });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));

const ALLOWED_ORIGINS = new Set([
  'https://floreseternasoporte-creator.github.io',
  'https://drex.glamworksapps.workers.dev',
  'https://getdrex.com',
  'https://www.getdrex.com',
]);

function corsHeaders(origin) {
  const o = ALLOWED_ORIGINS.has(origin) ? origin : 'https://floreseternasoporte-creator.github.io';
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}
function resp(status, body, origin) {
  return { statusCode: status, headers: corsHeaders(origin), body: JSON.stringify(body) };
}
function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

let jwksCache = null;
let jwksCacheTs = 0;
async function getJwks() {
  const now = Date.now();
  if (jwksCache && now - jwksCacheTs < 3600_000) return jwksCache;
  const region = POOL_ID.split('_')[0];
  const res = await fetch(`https://cognito-idp.${region}.amazonaws.com/${POOL_ID}/.well-known/jwks.json`);
  if (!res.ok) throw new Error('jwks_fetch_failed');
  jwksCache = await res.json();
  jwksCacheTs = now;
  return jwksCache;
}

async function verifyIdToken(token) {
  if (!POOL_ID || !CLIENT_ID) throw Object.assign(new Error('cognito_not_configured'), { status: 503 });
  if (typeof token !== 'string' || token.split('.').length !== 3) throw Object.assign(new Error('invalid_token'), { status: 401 });
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
  if (payload.iss !== `https://cognito-idp.${region}.amazonaws.com/${POOL_ID}`) throw Object.assign(new Error('invalid_token'), { status: 401 });
  if (payload.token_use !== 'id') throw Object.assign(new Error('invalid_token'), { status: 401 });
  if (payload.aud !== CLIENT_ID) throw Object.assign(new Error('invalid_token'), { status: 401 });
  if (!payload.sub || typeof payload.sub !== 'string') throw Object.assign(new Error('invalid_token'), { status: 401 });
  return payload;
}

async function sendMail(to, subject, text) {
  if (!FROM || !to) return false;
  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: FROM,
      Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } },
    }));
    return true;
  } catch (_) {
    return false;
  }
}

function newTicketId() {
  return Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
}
function shortId(id) { return String(id || '').slice(-6).toUpperCase(); }
function cleanText(v, max) { return String(v || '').slice(0, max); }
function isOwner(claims) {
  return typeof claims.email === 'string' && claims.email.toLowerCase() === INBOX.toLowerCase();
}

async function getTicket(ticketId) {
  const r = await ddb.send(new GetCommand({ TableName: SUPPORT_TABLE, Key: { ticketId } }));
  return r.Item || null;
}

async function createCase(claims, body) {
  const message = cleanText(body.message, 4000).trim();
  if (message.length < 10) return { status: 400, body: { error: 'message_too_short' } };
  const now = new Date().toISOString();
  const item = {
    ticketId: newTicketId(),
    userId: claims.sub,
    userEmail: typeof claims.email === 'string' ? claims.email : '',
    subject: cleanText(body.subject, 120).trim() || 'Soporte',
    category: cleanText(body.category, 40) || 'other',
    priority: !!body.priority,
    messages: [{ from: 'user', text: message, at: now }],
    status: 'received',
    createdAt: now,
    updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: SUPPORT_TABLE, Item: item }));
  const emailSent = item.userEmail
    ? await sendMail(item.userEmail, 'Drex: recibimos tu caso de soporte',
        'Hola,\n\nRecibimos tu caso de soporte en Drex (referencia: ' + shortId(item.ticketId) + '). Nuestro equipo lo revisará y te responderemos en la app y por este correo.\n\nGracias por escribirnos.\n— Equipo Drex')
    : false;
  await sendMail(INBOX, '[Drex soporte] Nuevo caso ' + shortId(item.ticketId),
    'Tipo: caso de soporte\nReferencia: ' + item.ticketId + '\nCategoría: ' + item.category + '\nAsunto: ' + item.subject + '\nUsuario (sub): ' + claims.sub + '\nCorreo del usuario: ' + (item.userEmail || '-') + '\nFecha: ' + now + '\n\nMensaje:\n' + message);
  return { status: 200, body: { ok: true, ticket: item, emailSent } };
}

async function listMyCases(claims) {
  const r = await ddb.send(new QueryCommand({
    TableName: SUPPORT_TABLE,
    IndexName: 'userId-index',
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': claims.sub },
    ScanIndexForward: false,
    Limit: 25,
  }));
  return { status: 200, body: { ok: true, tickets: r.Items || [] } };
}

async function replyCase(claims, body) {
  const ticketId = cleanText(body.ticketId, 80);
  const message = cleanText(body.message, 4000).trim();
  if (!ticketId || !message) return { status: 400, body: { error: 'invalid_request' } };
  const ticket = await getTicket(ticketId);
  if (!ticket || ticket.userId !== claims.sub) return { status: 404, body: { error: 'not_found' } };
  const now = new Date().toISOString();
  const r = await ddb.send(new UpdateCommand({
    TableName: SUPPORT_TABLE,
    Key: { ticketId },
    UpdateExpression: 'SET #m = list_append(if_not_exists(#m, :empty), :nm), #s = :st, updatedAt = :now',
    ExpressionAttributeNames: { '#m': 'messages', '#s': 'status' },
    ExpressionAttributeValues: { ':empty': [], ':nm': [{ from: 'user', text: message, at: now }], ':st': 'received', ':now': now },
    ReturnValues: 'ALL_NEW',
  }));
  await sendMail(INBOX, '[Drex soporte] Respuesta en el caso ' + shortId(ticketId),
    'El usuario respondió en su caso de soporte.\nReferencia: ' + ticketId + '\nCorreo del usuario: ' + (ticket.userEmail || '-') + '\nFecha: ' + now + '\n\nMensaje:\n' + message);
  return { status: 200, body: { ok: true, ticket: r.Attributes } };
}

async function closeCase(claims, body) {
  const ticketId = cleanText(body.ticketId, 80);
  const ticket = await getTicket(ticketId);
  if (!ticket || ticket.userId !== claims.sub) return { status: 404, body: { error: 'not_found' } };
  const r = await ddb.send(new UpdateCommand({
    TableName: SUPPORT_TABLE,
    Key: { ticketId },
    UpdateExpression: 'SET #s = :st, updatedAt = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':st': 'resolved', ':now': new Date().toISOString() },
    ReturnValues: 'ALL_NEW',
  }));
  return { status: 200, body: { ok: true, ticket: r.Attributes } };
}

async function adminList(claims) {
  if (!isOwner(claims)) return { status: 403, body: { error: 'not_owner' } };
  const r = await ddb.send(new ScanCommand({ TableName: SUPPORT_TABLE, Limit: 100 }));
  const tickets = (r.Items || []).sort((a, b) => String(b.updatedAt || '') < String(a.updatedAt || '') ? -1 : 1);
  return { status: 200, body: { ok: true, tickets } };
}

async function adminReply(claims, body) {
  if (!isOwner(claims)) return { status: 403, body: { error: 'not_owner' } };
  const ticketId = cleanText(body.ticketId, 80);
  const message = cleanText(body.message, 4000).trim();
  if (!ticketId || !message) return { status: 400, body: { error: 'invalid_request' } };
  const ticket = await getTicket(ticketId);
  if (!ticket) return { status: 404, body: { error: 'not_found' } };
  const now = new Date().toISOString();
  const r = await ddb.send(new UpdateCommand({
    TableName: SUPPORT_TABLE,
    Key: { ticketId },
    UpdateExpression: 'SET #m = list_append(if_not_exists(#m, :empty), :nm), #s = :st, updatedAt = :now',
    ExpressionAttributeNames: { '#m': 'messages', '#s': 'status' },
    ExpressionAttributeValues: { ':empty': [], ':nm': [{ from: 'team', text: message, at: now }], ':st': 'reviewing', ':now': now },
    ReturnValues: 'ALL_NEW',
  }));
  if (ticket.userEmail) {
    await sendMail(ticket.userEmail, 'Drex: el equipo respondió a tu caso',
      'Hola,\n\nEl equipo de Drex respondió a tu caso' + (ticket.subject ? ' «' + ticket.subject + '»' : '') + ' (referencia: ' + shortId(ticketId) + '). Entra a Drex, en Soporte, para verlo y responder.\n\n— Equipo Drex');
  }
  return { status: 200, body: { ok: true, ticket: r.Attributes } };
}

async function adminStatus(claims, body) {
  if (!isOwner(claims)) return { status: 403, body: { error: 'not_owner' } };
  const ticketId = cleanText(body.ticketId, 80);
  const status = body.status;
  if (!['received', 'reviewing', 'resolved'].includes(status)) return { status: 400, body: { error: 'bad_status' } };
  const ticket = await getTicket(ticketId);
  if (!ticket) return { status: 404, body: { error: 'not_found' } };
  const r = await ddb.send(new UpdateCommand({
    TableName: SUPPORT_TABLE,
    Key: { ticketId },
    UpdateExpression: 'SET #s = :st, updatedAt = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':st': status, ':now': new Date().toISOString() },
    ReturnValues: 'ALL_NEW',
  }));
  if (status === 'resolved' && ticket.userEmail) {
    await sendMail(ticket.userEmail, 'Drex: tu caso fue resuelto',
      'Hola,\n\nMarcamos tu caso de soporte' + (ticket.subject ? ' «' + ticket.subject + '»' : '') + ' como resuelto. Si el problema sigue, responde en tu caso dentro de Drex y lo reabrimos.\n\n— Equipo Drex');
  }
  return { status: 200, body: { ok: true, ticket: r.Attributes } };
}

async function reportNotify(claims, body) {
  const reference = cleanText(body.reference, 80);
  const userEmail = typeof claims.email === 'string' && claims.email.includes('@') ? claims.email : '';
  const userEmailSent = userEmail
    ? await sendMail(userEmail, 'Drex: recibimos tu reporte',
        'Hola,\n\nRecibimos tu reporte en Drex' + (reference ? ' (referencia: ' + reference + ')' : '') + '. Nuestro equipo lo revisará.\n\nGracias por escribirnos.\n— Equipo Drex')
    : false;
  const inboxSent = await sendMail(INBOX, '[Drex soporte] Nuevo reporte' + (reference ? ' ' + reference : ''),
    'Tipo: reporte\nReferencia: ' + (reference || '-') + '\nUsuario (sub): ' + claims.sub + '\nCorreo del usuario: ' + (userEmail || '-') + '\nFecha: ' + new Date().toISOString());
  return { status: 200, body: { ok: true, userEmailSent, inboxSent } };
}

exports.handler = async (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || '';
  const path = (event.requestContext && event.requestContext.http && event.requestContext.http.path) || event.rawPath || '';
  if (method === 'OPTIONS') return resp(204, {}, origin);
  if (method === 'GET' && path.endsWith('/health')) return resp(200, { ok: true }, origin);
  if (method !== 'POST') return resp(404, { error: 'not_found' }, origin);

  let body;
  try {
    let raw = event.body || '';
    if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
    body = JSON.parse(raw || '{}');
  } catch (_) {
    return resp(400, { error: 'invalid_request' }, origin);
  }

  let claims;
  try {
    claims = await verifyIdToken(body.idToken);
  } catch (e) {
    return resp(e.status || 401, { error: 'invalid_token' }, origin);
  }

  try {
    let out;
    if (path.endsWith('/support/cases/list')) out = await listMyCases(claims);
    else if (path.endsWith('/support/cases/reply')) out = await replyCase(claims, body);
    else if (path.endsWith('/support/cases/close')) out = await closeCase(claims, body);
    else if (path.endsWith('/support/cases')) out = await createCase(claims, body);
    else if (path.endsWith('/support/admin/list')) out = await adminList(claims);
    else if (path.endsWith('/support/admin/reply')) out = await adminReply(claims, body);
    else if (path.endsWith('/support/admin/status')) out = await adminStatus(claims, body);
    else if (path.endsWith('/support-notify')) out = await reportNotify(claims, body);
    else return resp(404, { error: 'not_found' }, origin);
    return resp(out.status, out.body, origin);
  } catch (e) {
    return resp(500, { error: 'internal' }, origin);
  }
};
