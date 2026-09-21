#!/usr/bin/env node
/* ============================================================================
 * Drex — Anuncio oficial: verificación de edad (IDV) — broadcast fan-out
 * ----------------------------------------------------------------------------
 * ¿Qué hace?
 *   Por cada usuario REAL de la tabla drex-kv (us-east-1):
 *     (a) escribe UNA notificación in-app remitida por la cuenta oficial, y
 *     (b) crea (o reutiliza) la conversación 1-a-1 con la cuenta oficial y
 *         envía UN mensaje con el anuncio.
 *
 * IDEMPOTENCIA:
 *   Antes de escribir nada para un usuario, se lee el marcador
 *     users/<sub>/idvAnnouncement   (hoja única, v = {"sent":true,"at":...})
 *   Si existe, el usuario se omite. En modo --execute el marcador se escribe
 *   dentro de la MISMA transacción DynamoDB con condición
 *   attribute_not_exists(pk), de modo que ni un reintento ni dos procesos
 *   en paralelo pueden duplicar el envío.
 *
 * MODO POR DEFECTO: --dry-run. NO escribe NADA (solo lecturas: Query y
 * BatchGetItem). --execute existe en el código pero SOLO lo corre el dueño
 * de Drex, DESPUÉS de publicar la función de verificación de edad, y exige
 * además la bandera --confirm. Este script nunca debe correrse con --execute
 * desde una tarea automatizada.
 *
 * Convenciones de la tabla (ver drex-cloud.js, verificado en el repo):
 *   pk = primer segmento de la ruta, sk = resto unido con "/",
 *   atributo "v" = hoja serializada en JSON.
 *   Los objetos se guardan APLANDOS en hojas (flatten), p. ej.
 *   ref('conversations/x').set({participants:{a:true}}) ->
 *     pk='conversations', sk='x/participants/a', v='true'.
 *   Este script replica ese aplanado para que la app lea los datos igual
 *   que si los hubiera escrito ella.
 *
 * Requisitos:  npm install   (instala @aws-sdk/client-dynamodb)
 * Credenciales: las estándar del entorno (AWS_ACCESS_KEY_ID /
 *   AWS_SECRET_ACCESS_KEY, ~/.aws/credentials o rol IAM). Región us-east-1.
 * ========================================================================== */
'use strict';

const TABLE = process.env.DREX_TABLE || 'drex-kv';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const MARKER_ATTR = 'idvAnnouncement';
const ANNOUNCEMENT_TAG = 'idv-age-verification-2026-09-21';

// ---------------------------------------------------------------------------
// Texto del anuncio (contenido aprobado; NO modificar sin orden del dueño)
// ---------------------------------------------------------------------------
const MESSAGES = {
  es: 'A partir del 21 de septiembre de 2026, todos los usuarios de Drex deberán verificar su edad en Configuración → Cumpleaños. Por ahora es solo un aviso informativo: la verificación con documento de identidad se solicitará si intentas cambiar tu fecha de nacimiento.',
  en: 'Starting September 21, 2026, all Drex users will need to verify their age in Settings → Birthday. For now, this is just an informational notice: ID document verification will be required if you try to change your date of birth.',
  zh: '自2026年9月21日起，所有 Drex 用户都需要在“设置 → 生日”中验证年龄。目前这只是一则通知：如果你尝试更改出生日期，将需要进行身份证件验证。',
};

// Patrones de cuentas QA/prueba a excluir (además de la cuenta oficial).
const DEFAULT_QA_PATTERNS = [/drexqa/i, /\+drexqa/i];

// ---------------------------------------------------------------------------
// Utilidades puras (sin AWS) — también cubiertas por --selftest
// ---------------------------------------------------------------------------

// Algoritmo de push ID de Firebase, copiado de drex-cloud.js (newPushId).
// Ordenable por tiempo: los IDs generados después ordenan después.
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
let _lastPushTime = 0;
let _lastRandChars = [];
function newPushId() {
  let now = Date.now();
  const duplicateTime = now === _lastPushTime;
  _lastPushTime = now;
  const timeStampChars = new Array(8);
  for (let i = 7; i >= 0; i--) {
    timeStampChars[i] = PUSH_CHARS.charAt(now % 64);
    now = Math.floor(now / 64);
  }
  let id = timeStampChars.join('');
  if (!duplicateTime) {
    for (let i = 0; i < 12; i++) _lastRandChars[i] = Math.floor(Math.random() * 64);
  } else {
    let i;
    for (i = 11; i >= 0 && _lastRandChars[i] === 63; i--) _lastRandChars[i] = 0;
    _lastRandChars[i]++;
  }
  for (let i = 0; i < 12; i++) id += PUSH_CHARS.charAt(_lastRandChars[i]);
  return id;
}

// Aplanado hoja-por-hoja idéntico a flatten() de drex-cloud.js:
// null/undefined/{} /[] no escriben hoja; arrays se indexan 0..n.
function isPlainObject(v) {
  return Object.prototype.toString.call(v) === '[object Object]';
}
function flatten(value, baseSegs, out) {
  out = out || [];
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    if (value.length === 0) return out;
    for (let i = 0; i < value.length; i++) flatten(value[i], baseSegs.concat([String(i)]), out);
    return out;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return out;
    for (const k of keys) flatten(value[k], baseSegs.concat([k]), out);
    return out;
  }
  out.push({ segs: baseSegs.slice(), value });
  return out;
}

// ID de conversación 1-a-1: idéntico a getDirectConversationId() de index.html
// (línea ~31237): los uids ordenados unidos con '__'.
function getDirectConversationId(uidA, uidB) {
  return [String(uidA), String(uidB)].sort().join('__');
}

function isValidSub(sub) {
  return typeof sub === 'string' && sub.length > 0 && !/[\s/]/.test(sub);
}

function looksLikeQa(username, email, patterns) {
  const hay = `${username || ''} ${email || ''}`;
  return patterns.some((re) => re.test(hay));
}

// Idioma del anuncio por usuario. Si el perfil no define idioma (el campo
// userSettings/<uid>/appLanguage solo existe si el usuario lo cambió alguna
// vez), se usa 'es', el idioma por defecto de la app.
function pickLang(rawLang) {
  const l = String(rawLang || '').toLowerCase();
  if (l === 'en' || l === 'zh') return l;
  return 'es';
}

// Notificación in-app. Esquema verificado en index.html (addNotification,
// ~línea 24880):
//   notifications/<uid>/<pushId> = { message, timestamp, read:false,
//     type, notificationId, ...meta }
// type:'announcement' NO está mapeado en notifTypeToPrefKey() -> la
// notificación nunca se salta por las preferencias del usuario (es un aviso
// oficial del sistema). actorId/actorName/actorImage hacen que la tarjeta
// muestre el nombre y avatar de la cuenta oficial.
function buildNotification(uid, pushId, official, text, now) {
  return {
    message: text,
    timestamp: now,
    read: false,
    type: 'announcement',
    notificationId: pushId,
    actorId: official ? official.sub : 'pending',
    actorName: official ? official.name : 'Drex',
    actorImage: official ? official.image : '',
    announcement: ANNOUNCEMENT_TAG,
  };
}

// Mensaje de chat. Esquema verificado en index.html (_sendChatMessageBuildAndPush,
// ~línea 33035): conversationMessages/<convoId>/<msgId> = { senderId, text,
// timestamp, ... }. senderId = cuenta oficial: el DM aparece como enviado
// por la cuenta oficial.
function buildMessagePayload(officialSub, text, now) {
  return {
    senderId: officialSub || 'pending',
    text,
    timestamp: now,
    systemAnnouncement: ANNOUNCEMENT_TAG,
  };
}

function preview(text, n) {
  const t = String(text || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = {
    dryRun: true,          // POR DEFECTO: no escribe nada
    execute: false,
    confirm: false,
    selftest: false,
    verifySub: null,
    officialUsername: 'drexcreators', // se resuelve vía índice usernames/<nombre>
    officialUid: null,     // si se pasa, no se consulta el índice
    qaPattern: null,       // regex extra (string) además de los patrones base
    limit: 0,              // 0 = sin límite (útil para pilotos: --limit 5)
    throttleMs: 120,       // pausa entre usuarios en --execute
    table: TABLE,
    region: REGION,
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry-run') { a.dryRun = true; a.execute = false; }
    else if (x === '--execute') { a.execute = true; a.dryRun = false; }
    else if (x === '--confirm') a.confirm = true;
    else if (x === '--selftest') a.selftest = true;
    else if (x === '--verify-sub') a.verifySub = argv[++i];
    else if (x === '--official-username') a.officialUsername = argv[++i];
    else if (x === '--official-uid') a.officialUid = argv[++i];
    else if (x === '--qa-pattern') a.qaPattern = argv[++i];
    else if (x === '--limit') a.limit = parseInt(argv[++i], 10) || 0;
    else if (x === '--throttle-ms') a.throttleMs = parseInt(argv[++i], 10) || 0;
    else if (x === '--table') a.table = argv[++i];
    else if (x === '--region') a.region = argv[++i];
    else if (x === '--help' || x === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Argumento desconocido: ${x}`); printHelp(); process.exit(2); }
  }
  return a;
}

function printHelp() {
  console.log(`
Uso:
  node broadcast.js [opciones]

Modos:
  (por defecto) --dry-run      Escanea usuarios, muestra conteos y 2-3 payloads
                               de ejemplo. NO escribe nada en DynamoDB.
  --selftest                   Pruebas unitarias de las funciones puras. No usa
                               red ni AWS. Código de salida 0 = todo OK.
  --verify-sub <sub>           Muestra el estado del marcador y del anuncio
                               para un usuario (solo lectura).
  --execute --confirm          ENVÍO REAL. Solo el dueño, tras publicar la
                               función de verificación. Requiere --confirm.

Opciones:
  --official-username <nombre>  Cuenta oficial remitente (índice usernames/<nombre>).
                               Por defecto: drexcreators (única cuenta oficial
                               referenciada en el repo).
  --official-uid <uid>         Usa este uid directamente (sin consultar índice).
  --qa-pattern <regex>         Regex adicional para excluir cuentas de prueba.
  --limit <n>                  Procesa como máximo n usuarios (pilotos).
  --throttle-ms <ms>           Pausa entre usuarios en --execute (def. 120).
  --table <nombre>             Tabla DynamoDB (def. drex-kv / $DREX_TABLE).
  --region <r>                 Región AWS (def. us-east-1).

Ejemplos:
  node broadcast.js --selftest
  node broadcast.js                       # dry-run contra drex-kv real
  node broadcast.js --limit 5             # dry-run piloto de 5 usuarios
  node broadcast.js --execute --confirm   # SOLO EL DUEÑO, tras publicar la función
`);
}

// ---------------------------------------------------------------------------
// Capa DynamoDB (carga perezosa del SDK: --selftest no necesita AWS)
// ---------------------------------------------------------------------------
let _ddb = null;
async function ddb(region) {
  if (_ddb) return _ddb;
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
  const client = new DynamoDBClient({ region });
  _ddb = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return _ddb;
}
async function sdk() {
  return import('@aws-sdk/client-dynamodb');
}

function leafItem(pk, segs, value) {
  return { pk, sk: segs.join('/'), v: JSON.stringify(value) };
}

async function queryAll(client, table, params) {
  const { QueryCommand } = await sdk();
  const items = [];
  let key;
  do {
    const res = await client.send(new QueryCommand({
      ...params, TableName: table, ExclusiveStartKey: key,
    }));
    if (res.Items) items.push(...res.Items);
    key = res.LastEvaluatedKey;
  } while (key);
  return items;
}

async function batchGetAll(client, table, keys) {
  const { BatchGetItemCommand } = await sdk();
  const out = [];
  let pending = keys.slice();
  let attempt = 0;
  while (pending.length) {
    const batch = pending.slice(0, 100);
    pending = pending.slice(100);
    const res = await client.send(new BatchGetItemCommand({
      RequestItems: { [table]: { Keys: batch } },
    }));
    if (res.Responses && res.Responses[table]) out.push(...res.Responses[table]);
    const unproc = (res.UnprocessedKeys && res.UnprocessedKeys[table] && res.UnprocessedKeys[table].Keys) || [];
    if (unproc.length) {
      attempt++;
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
      pending = unproc.concat(pending);
    } else {
      attempt = 0;
    }
  }
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Fase 1: enumerar usuarios (subs únicos de pk='users')
// ---------------------------------------------------------------------------
async function scanUserSubs(client, table) {
  const items = await queryAll(client, table, {
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': 'users' },
    ProjectionExpression: 'sk',
  });
  const subs = new Set();
  for (const it of items) {
    const sk = String(it.sk || '');
    const sub = sk.split('/')[0];
    if (sub) subs.add(sub);
  }
  return [...subs];
}

// ---------------------------------------------------------------------------
// Fase 2: atributos necesarios por usuario (un BatchGet por lote)
// ---------------------------------------------------------------------------
async function fetchUserAttrs(client, table, subs) {
  const keys = [];
  for (const sub of subs) {
    keys.push({ pk: 'users', sk: `${sub}/username` });
    keys.push({ pk: 'users', sk: `${sub}/email` });
    keys.push({ pk: 'users', sk: `${sub}/${MARKER_ATTR}` });
    keys.push({ pk: 'userSettings', sk: `${sub}/appLanguage` });
  }
  const items = await batchGetAll(client, table, keys);
  const bySub = new Map();
  const parseV = (v) => {
    if (v === undefined || v === null) return null;
    try { return JSON.parse(v); } catch { return null; }
  };
  for (const it of items) {
    const sk = String(it.sk || '');
    const slash = sk.indexOf('/');
    if (slash < 0) continue;
    const sub = sk.slice(0, slash);
    const attr = sk.slice(slash + 1);
    if (!bySub.has(sub)) bySub.set(sub, {});
    bySub.get(sub)[attr] = parseV(it.v);
  }
  return bySub;
}

// ---------------------------------------------------------------------------
// Cuenta oficial: se resuelve por el índice usernames/<nombre> en minúsculas
// (así lo escribe la app). v = sub en JSON.
// ---------------------------------------------------------------------------
async function resolveOfficial(client, table, args) {
  if (args.officialUid) {
    return await fetchOfficialProfile(client, table, args.officialUid, args.officialUsername);
  }
  const { GetItemCommand } = await sdk();
  const uname = String(args.officialUsername || '').toLowerCase();
  const res = await client.send(new GetItemCommand({
    TableName: table,
    Key: { pk: 'usernames', sk: uname },
    ProjectionExpression: 'v',
  }));
  if (!res.Item || res.Item.v === undefined) return null;
  let sub = null;
  try { sub = JSON.parse(res.Item.v); } catch { sub = null; }
  if (!sub) return null;
  return await fetchOfficialProfile(client, table, sub, uname);
}

async function fetchOfficialProfile(client, table, sub, fallbackName) {
  const items = await batchGetAll(client, table, [
    { pk: 'users', sk: `${sub}/username` },
    { pk: 'users', sk: `${sub}/displayName` },
    { pk: 'users', sk: `${sub}/profileImage` },
  ]);
  const vals = {};
  for (const it of items) {
    const attr = String(it.sk || '').split('/').slice(1).join('/');
    try { vals[attr] = JSON.parse(it.v); } catch { vals[attr] = null; }
  }
  return {
    sub,
    name: vals.username || vals.displayName || fallbackName || 'Drex',
    image: vals.profileImage || '',
  };
}

// ---------------------------------------------------------------------------
// Construcción del plan por usuario (puro; también usado por dry-run)
// ---------------------------------------------------------------------------
function planForUser(sub, attrs, official, qaPatterns) {
  const username = attrs.username || null;
  const email = attrs.email || null;
  const lang = pickLang(attrs.appLanguage);
  const marked = !!(attrs[MARKER_ATTR] && attrs[MARKER_ATTR].sent === true);
  const isOfficial = official && sub === official.sub;
  const isQa = looksLikeQa(username, email, qaPatterns);
  const valid = isValidSub(sub);
  const status = !valid ? 'invalid-sub'
    : isOfficial ? 'excluded-official'
    : isQa ? 'excluded-qa'
    : marked ? 'already-sent' : 'to-send';
  return { sub, username, email, lang, status, text: MESSAGES[lang] };
}

// Hojas DynamoDB a escribir para un usuario (modo --execute).
// Todo va en UNA transacción con el marcador condicional.
function buildTransactItems(plan, official, now) {
  const uid = plan.sub;
  const officialSub = official ? official.sub : 'pending';
  const convoId = getDirectConversationId(uid, officialSub);
  const notifId = newPushId();
  const msgId = newPushId();
  const text = plan.text;
  const prev = preview(text, 90);

  // (construcción explícita hoja por hoja, con el mismo aplanado que la app)
  const items = [];

  for (const l of flatten(buildNotification(uid, notifId, official, text, now), [])) {
    items.push({ Put: { Item: leafItem('notifications', [uid, notifId, ...l.segs], l.value) } });
  }
  for (const l of flatten(buildMessagePayload(officialSub, text, now), [])) {
    items.push({ Put: { Item: leafItem('conversationMessages', [convoId, msgId, ...l.segs], l.value) } });
  }

  // Conversación: crear si no existe, o refrescar lastMessage/updatedAt.
  // (la existencia se leyó antes; el plan trae la bandera)
  if (!plan.convoExists) {
    const convo = {
      participants: { [uid]: true, [officialSub]: true },
      createdAt: now,
      updatedAt: now,
      lastMessage: prev,
      lastSenderId: officialSub,
    };
    for (const l of flatten(convo, [])) {
      items.push({ Put: { Item: leafItem('conversations', [convoId, ...l.segs], l.value) } });
    }
  } else {
    for (const [k, v] of Object.entries({ updatedAt: now, lastMessage: prev, lastSenderId: officialSub })) {
      items.push({ Put: { Item: leafItem('conversations', [convoId, k], v) } });
    }
  }

  // Inbox de ambos lados (userConversations/<uid>/<convoId>)
  for (const [side, other] of [[uid, officialSub], [officialSub, uid]]) {
    if (!plan.userConvoExists[side]) {
      const entry = { otherUid: other, updatedAt: now, lastMessage: prev };
      for (const l of flatten(entry, [])) {
        items.push({ Put: { Item: leafItem('userConversations', [side, convoId, ...l.segs], l.value) } });
      }
    } else {
      for (const [k, v] of Object.entries({ updatedAt: now, lastMessage: prev })) {
        items.push({ Put: { Item: leafItem('userConversations', [side, convoId, k], v) } });
      }
    }
  }

  // Marcador de idempotencia (hoja única). La condición hace atómica la
  // garantía de "una sola vez": si el marcador ya existe, toda la
  // transacción se aborta y el usuario queda intacto.
  items.push({
    Put: {
      Item: leafItem('users', [uid, MARKER_ATTR], { sent: true, at: now, via: 'notification+dm', tag: ANNOUNCEMENT_TAG }),
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  });

  return { items, convoId, notifId, msgId };
}

// ---------------------------------------------------------------------------
// Modos
// ---------------------------------------------------------------------------
async function runSelftest() {
  let pass = 0, fail = 0;
  const t = (name, cond) => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}`); }
  };

  // 1. push IDs: 20 caracteres, alfabeto válido, orden temporal
  const a = newPushId(); await sleep(2); const b = newPushId();
  t('pushId longitud 20', a.length === 20 && b.length === 20);
  t('pushId alfabeto válido', /^[A-Za-z0-9_-]{20}$/.test(a));
  t('pushId orden temporal', a < b);
  t('pushId únicos', a !== b);

  // 2. flatten idéntico a drex-cloud.js
  const fl = flatten({ participants: { u1: true, u2: true }, updatedAt: 5, lastMessage: 'hola' }, []);
  const sks = fl.map((l) => l.segs.join('/')).sort();
  t('flatten participantes', sks.includes('participants/u1') && sks.includes('participants/u2'));
  t('flatten escalares', sks.includes('updatedAt') && sks.includes('lastMessage'));
  t('flatten ignora null/undefined', flatten({ a: null, b: undefined, c: 1 }, []).length === 1);

  // 3. conversación 1-a-1 simétrica
  t('convoId simétrico', getDirectConversationId('zzz', 'aaa') === getDirectConversationId('aaa', 'zzz'));
  t('convoId formato', getDirectConversationId('aaa', 'zzz') === 'aaa__zzz');

  // 4. detección QA
  const qp = DEFAULT_QA_PATTERNS;
  t('qa drexqa en email', looksLikeQa('juan', 'juan+drexqa@gmail.com', qp));
  t('qa drexqa en username', looksLikeQa('drexqa_02', 'x@y.com', qp));
  t('qa no marca reales', !looksLikeQa('darel', 'darel@gmail.com', qp));

  // 5. idioma
  t('lang en', pickLang('en') === 'en');
  t('lang zh', pickLang('zh') === 'zh');
  t('lang default es', pickLang(null) === 'es' && pickLang('fr') === 'es');

  // 6. notificación: esquema que espera la app
  const n = buildNotification('u1', 'pid1', { sub: 'off1', name: 'Drex', image: '' }, 'hola', 123);
  t('notif type announcement', n.type === 'announcement');
  t('notif read=false', n.read === false);
  t('notif notificationId=pushId', n.notificationId === 'pid1');
  t('notif actor oficial', n.actorId === 'off1' && n.actorName === 'Drex');

  // 7. mensaje: remitente oficial
  const m = buildMessagePayload('off1', 'hola', 123);
  t('msg senderId oficial', m.senderId === 'off1' && m.text === 'hola');

  // 8. subs válidos
  t('sub válido', isValidSub('abc-123_XYZ'));
  t('sub inválido (vacío)', !isValidSub(''));
  t('sub inválido (con /)', !isValidSub('a/b'));

  // 9. textos exactos del anuncio
  t('texto ES exacto', MESSAGES.es.startsWith('A partir del 21 de septiembre de 2026'));
  t('texto EN exacto', MESSAGES.en.startsWith('Starting September 21, 2026'));
  t('texto ZH exacto', MESSAGES.zh.startsWith('自2026年9月21日起'));

  // 10. plan: estados
  const p1 = planForUser('u1', {}, { sub: 'off' }, qp);
  t('plan to-send', p1.status === 'to-send' && p1.lang === 'es');
  const p2 = planForUser('u1', { idvAnnouncement: { sent: true, at: 1 } }, { sub: 'off' }, qp);
  t('plan already-sent', p2.status === 'already-sent');
  const p3 = planForUser('off', {}, { sub: 'off' }, qp);
  t('plan excluye oficial', p3.status === 'excluded-official');
  const p4 = planForUser('u9', { username: 'drexqa_1' }, { sub: 'off' }, qp);
  t('plan excluye qa', p4.status === 'excluded-qa');

  // 11. transacción: marcador condicional + hojas con pk/sk correctos
  const tx = buildTransactItems(
    { sub: 'u1', text: MESSAGES.es, convoExists: false, userConvoExists: {} }, { sub: 'off', name: 'Drex', image: '' }, 123
  );
  const marker = tx.items.find((i) => i.Put && i.Put.Item.sk === 'u1/idvAnnouncement');
  t('tx trae marcador', !!marker);
  t('tx marcador condicional', marker.Put.ConditionExpression === 'attribute_not_exists(pk)');
  t('tx marcador pk=users', marker.Put.Item.pk === 'users');
  const notifLeaf = tx.items.find((i) => i.Put && i.Put.Item.pk === 'notifications' && /\/message$/.test(i.Put.Item.sk));
  t('tx notificación aplanada', !!notifLeaf && JSON.parse(notifLeaf.Put.Item.v) === MESSAGES.es);
  const msgLeaf = tx.items.find((i) => i.Put && i.Put.Item.pk === 'conversationMessages' && /\/senderId$/.test(i.Put.Item.sk));
  t('tx mensaje remitente oficial', !!msgLeaf && JSON.parse(msgLeaf.Put.Item.v) === 'off');

  console.log(`\nselftest: ${pass} ok, ${fail} fallos`);
  process.exit(fail ? 1 : 0);
}

async function resolveQaPatterns(args) {
  const pats = DEFAULT_QA_PATTERNS.slice();
  if (args.qaPattern) pats.push(new RegExp(args.qaPattern, 'i'));
  return pats;
}

async function runDryRun(client, args) {
  console.log('=== DRY-RUN (no se escribe nada en DynamoDB) ===\n');
  const official = await resolveOfficial(client, args.table, args);
  if (!official) {
    console.log(`AVISO: no se pudo resolver la cuenta oficial (usernames/${String(args.officialUsername).toLowerCase()}).`);
    console.log('Los conteos se muestran igual; los payloads de ejemplo usan actor "Drex" provisional.');
    console.log('--execute se negará a correr sin cuenta oficial resuelta.\n');
  } else {
    console.log(`Cuenta oficial: @${official.name} (sub ${official.sub})\n`);
  }

  const subs = await scanUserSubs(client, args.table);
  console.log(`Subs únicos en pk='users': ${subs.length}`);
  const attrs = await fetchUserAttrs(client, args.table, subs);
  const qaPatterns = await resolveQaPatterns(args);

  const counts = { 'to-send': 0, 'already-sent': 0, 'excluded-official': 0, 'excluded-qa': 0, 'invalid-sub': 0 };
  const langCounts = { es: 0, en: 0, zh: 0 };
  const plans = [];
  for (const sub of subs) {
    const plan = planForUser(sub, attrs.get(sub) || {}, official, qaPatterns);
    counts[plan.status] = (counts[plan.status] || 0) + 1;
    if (plan.status === 'to-send') {
      langCounts[plan.lang]++;
      plans.push(plan);
      if (args.limit && plans.length >= args.limit) break;
    }
  }

  console.log('\n--- Resultado del escaneo ---');
  console.log(`  Alcanzaría (to-send):      ${counts['to-send']}`);
  console.log(`    por idioma: es=${langCounts.es} en=${langCounts.en} zh=${langCounts.zh}`);
  console.log(`  Ya enviados (marcador):    ${counts['already-sent']}`);
  console.log(`  Excluidos (cuenta oficial):${counts['excluded-official']}`);
  console.log(`  Excluidos (QA/prueba):     ${counts['excluded-qa']}`);
  console.log(`  Subs inválidos:            ${counts['invalid-sub']}`);

  console.log('\n--- Ejemplos de payload (2) ---');
  const now = Date.now();
  for (const plan of plans.slice(0, 2)) {
    const notifId = newPushId();
    const convoId = getDirectConversationId(plan.sub, official ? official.sub : 'pending');
    console.log(`\nUsuario: ${plan.sub}  lang=${plan.lang}  username=${plan.username || '(sin username)'}  email=${plan.email || '(sin email)'}`);
    console.log('Notificación  pk=notifications');
    console.log(`  sk=${plan.sub}/${notifId}/message  v=${JSON.stringify(plan.text)}`);
    const notif = buildNotification(plan.sub, notifId, official, plan.text, now);
    for (const l of flatten(notif, [])) {
      if (l.segs.join('/') === 'message') continue;
      console.log(`  sk=${plan.sub}/${notifId}/${l.segs.join('/')}  v=${JSON.stringify(l.value)}`);
    }
    console.log('Mensaje  pk=conversationMessages');
    console.log(`  sk=${convoId}/<msgId>/text  v=${JSON.stringify(plan.text)}`);
    console.log(`  sk=${convoId}/<msgId>/senderId  v=${JSON.stringify(official ? official.sub : 'pending')}`);
    console.log(`Marcador  pk=users sk=${plan.sub}/${MARKER_ATTR}  v={"sent":true,"at":<ahora>}`);
  }

  console.log('\n=== FIN DRY-RUN: 0 escrituras realizadas ===');
}

async function runVerifySub(client, args) {
  const sub = args.verifySub;
  const { GetItemCommand } = await sdk();
  const get = (pk, sk) => client.send(new GetItemCommand({
    TableName: args.table, Key: { pk, sk }, ProjectionExpression: 'v',
  }));
  const m = await get('users', `${sub}/${MARKER_ATTR}`);
  console.log(`Marcador users/${sub}/${MARKER_ATTR}:`, m.Item ? m.Item.v : '(ausente)');
  const notifs = await queryAll(client, args.table, {
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :pfx)',
    ExpressionAttributeValues: { ':pk': 'notifications', ':pfx': `${sub}/` },
    ProjectionExpression: 'sk',
  });
  console.log(`Notificaciones del usuario: ${notifs.length}`);
  for (const n of notifs.slice(0, 10)) console.log('  -', n.sk);
  {
    const official = args.officialUid ? { sub: args.officialUid } : await resolveOfficial(client, args.table, args);
    if (official) {
      const convoId = getDirectConversationId(sub, official.sub);
      const msgs = await queryAll(client, args.table, {
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :pfx)',
        ExpressionAttributeValues: { ':pk': 'conversationMessages', ':pfx': `${convoId}/` },
        ProjectionExpression: 'sk',
      });
      console.log(`Conversación ${convoId}: ${msgs.length} mensaje(s)`);
    }
  }
}

async function convoExists(client, table, pk, convoId) {
  const items = await queryAll(client, table, {
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :pfx)',
    ExpressionAttributeValues: { ':pk': pk, ':pfx': `${convoId}/` },
    ProjectionExpression: 'pk',
    Limit: 1,
  });
  return items.length > 0;
}

async function runExecute(client, args) {
  // Doble seguro: --execute sin --confirm se niega a correr.
  if (!args.confirm) {
    console.error('BLOQUEADO: --execute requiere --confirm. Lee docs/IDV-ANNOUNCEMENT.md antes.');
    process.exit(3);
  }
  const official = await resolveOfficial(client, args.table, args);
  if (!official) {
    console.error(`BLOQUEADO: no se resolvió la cuenta oficial (usernames/${String(args.officialUsername).toLowerCase()}).`);
    console.error('Pasa --official-uid <sub> con el uid verificado de la cuenta oficial.');
    process.exit(3);
  }
  console.log(`Cuenta oficial: @${official.name} (sub ${official.sub})`);
  console.log('*** ENVÍO REAL EN 5 SEGUNDOS — Ctrl+C para cancelar ***');
  await sleep(5000);

  const subs = await scanUserSubs(client, args.table);
  const attrs = await fetchUserAttrs(client, args.table, subs);
  const qaPatterns = await resolveQaPatterns(args);
  const { TransactWriteItemsCommand } = await sdk();

  let sent = 0, skipped = 0, failed = 0;
  const failures = [];
  for (const sub of subs) {
    if (args.limit && sent + skipped + failed >= args.limit) break;
    const plan = planForUser(sub, attrs.get(sub) || {}, official, qaPatterns);
    if (plan.status !== 'to-send') { skipped++; continue; }
    const now = Date.now();
    const convoId = getDirectConversationId(sub, official.sub);
    try {
      plan.convoExists = await convoExists(client, args.table, 'conversations', convoId);
      plan.userConvoExists = {
        [sub]: await convoExists(client, args.table, 'userConversations', `${sub}/${convoId}`),
        [official.sub]: await convoExists(client, args.table, 'userConversations', `${official.sub}/${convoId}`),
      };
      const { items } = buildTransactItems(plan, official, now);
      if (items.length > 100) throw new Error(`transacción excede 100 items (${items.length})`);
      await client.send(new TransactWriteItemsCommand({
        TableName: args.table,
        TransactItems: items.map((i) => ({
          Put: { TableName: args.table, ...i.Put },
        })),
      }));
      sent++;
      if (sent % 25 === 0) console.log(`  ... ${sent} enviados`);
    } catch (e) {
      // Si el marcador ya existía (carrera con otra ejecución), la
      // transacción se aborta con ConditionalCheckFailed: se cuenta como
      // omitido, no como fallo.
      if (e && (e.name === 'TransactionCanceledException')) {
        skipped++;
      } else {
        failed++;
        failures.push({ sub, error: String((e && e.message) || e) });
        console.error(`  ERROR ${sub}: ${String((e && e.message) || e)}`);
      }
    }
    if (args.throttleMs) await sleep(args.throttleMs);
  }

  console.log(`\n=== FIN --execute: enviados=${sent} omitidos=${skipped} fallidos=${failed} ===`);
  if (failures.length) {
    console.log('Fallos (re-ejecutar el script los reintentará; el marcador evita duplicados):');
    for (const f of failures.slice(0, 20)) console.log(`  ${f.sub}: ${f.error}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) { await runSelftest(); return; }
  const client = await ddb(args.region);
  if (args.verifySub) { await runVerifySub(client, args); return; }
  if (args.execute) { await runExecute(client, args); return; }
  await runDryRun(client, args); // por defecto
}

main().catch((e) => {
  console.error('ERROR:', (e && e.message) || e);
  if (e && e.name === 'CredentialsProviderError') {
    console.error('Sin credenciales AWS. Configura AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY o ~/.aws/credentials.');
  }
  if (e && /Cannot find module|Cannot find package/.test(String(e && e.message))) {
    console.error('Falta el SDK: corre `npm install` en scripts/idv-announcement/ primero.');
  }
  process.exit(1);
});
