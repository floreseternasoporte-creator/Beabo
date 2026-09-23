'use strict';
/* PERF 2026-09-23 (ciclo 10) — costo del ciclo de polling de fiesta y de la
 * apertura de sala de chat, medido con el código REAL de drex-cloud.js.
 *
 * - Fiesta: los 10 grupos de polling que registra fiestaWatchRoom en el ciclo
 *   normal de 3 s (7 hojas del doc + miembros + reacciones limitToLast(30) +
 *   chat limitToLast(50)). Un ciclo = un readRefValue por grupo (pollGroup);
 *   aquí se mide con ref.once('value'), que es exactamente readRefValue.
 * - Chat: las 12 lecturas que hace openChatRoomFromInbox al abrir
 *   (header, ensureConversationExists x3, deletedForMe, mensajes
 *   limitToLast(80), pinned, presencia, readReceipt, tema, disappearing,
 *   typing). El badge ya no toca la sala (agregado chatUnread).
 *
 * Modelo RCU: lectura de consistencia eventual (la que usa queryAll):
 * por operación (query-página o get): max(0.5, ceil(bytes/4096)*0.5).
 *
 * Uso:
 *   node tests/test-c10-fiesta-chat-cost.js [--out=resultados.json]
 * Con --out escribe snapshots+costos para comparar antes/después con:
 *   node tests/test-c10-fiesta-chat-cost.js --compare=antes.json,despues.json
 */
const path = require('path');
const fs = require('fs');
const SRC = path.join(__dirname, '..');
const { DrexCloud, __internals: I } = require(path.join(SRC, 'drex-cloud.js'));

// --- DynamoDB falso instrumentado -------------------------------------------
function cmpSk(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

function makeInstrumentedFake() {
  const items = []; // {pk, sk, v}
  const stats = { ops: 0, bytes: 0, rcu: 0 };
  function put(pk, sk, v) { items.push({ pk, sk, v: JSON.stringify(v) }); }
  function charge(returned) {
    let bytes = 0;
    returned.forEach(it => {
      bytes += Buffer.byteLength(it.sk || '', 'utf8') + Buffer.byteLength(it.v || '', 'utf8');
    });
    const rcu = Math.max(0.5, Math.ceil(bytes / 4096) * 0.5);
    stats.ops++; stats.bytes += bytes; stats.rcu += rcu;
  }
  function runQuery(params) {
    const vals = params.ExpressionAttributeValues || {};
    let arr = items.filter(it => it.pk === vals[':pk']);
    const kc = params.KeyConditionExpression || '';
    if (kc.includes('begins_with(sk, :pfx)')) {
      arr = arr.filter(it => it.sk.indexOf(vals[':pfx']) === 0);
    } else if (kc.includes('sk BETWEEN :lo AND :hi')) {
      arr = arr.filter(it => it.sk >= vals[':lo'] && it.sk <= vals[':hi']);
    } else if (kc.includes('sk < :endSk')) {
      arr = arr.filter(it => it.sk < vals[':endSk']);
    } else if (kc.includes('begins_with(sk,')) {
      throw new Error('KC no soportada: ' + kc);
    }
    arr.sort((a, b) => params.ScanIndexForward === false ? cmpSk(b.sk, a.sk) : cmpSk(a.sk, b.sk));
    if (params.ExclusiveStartKey) {
      const esk = params.ExclusiveStartKey.sk;
      const idx = arr.findIndex(it => it.sk === esk);
      arr = idx >= 0 ? arr.slice(idx + 1) : [];
    }
    let lek = null;
    if (params.Limit && arr.length > params.Limit) {
      const page = arr.slice(0, params.Limit);
      lek = { pk: page[page.length - 1].pk, sk: page[page.length - 1].sk };
      arr = page;
    }
    const proj = params.ProjectionExpression === 'sk';
    const out = arr.map(it => (proj ? { sk: it.sk } : { pk: it.pk, sk: it.sk, v: it.v }));
    charge(out);
    const res = { Items: out };
    if (lek) res.LastEvaluatedKey = lek;
    return res;
  }
  const dc = {
    query(params) { return { promise() { return Promise.resolve(runQuery(params)); } }; },
    get(params) {
      return {
        promise() {
          const it = items.find(x => x.pk === params.Key.pk && x.sk === params.Key.sk);
          const out = it ? [{ pk: it.pk, sk: it.sk, v: it.v }] : [];
          charge(out);
          return Promise.resolve({ Item: it ? { pk: it.pk, sk: it.sk, v: it.v } : undefined });
        }
      };
    },
    _put: put,
    _stats: stats,
    _reset() { stats.ops = 0; stats.bytes = 0; stats.rcu = 0; }
  };
  return dc;
}

// --- Fixture ------------------------------------------------------------------
const BASE_TS = 1750000000000;
const F1 = 'fiesta1', U1 = 'user_me_001', U2 = 'user_other_002', C1 = U1 + '__' + U2;
function pushKey(i) { return I.pushIdLowerBound(BASE_TS + i * 1000); }

function seedFiesta(put) {
  put('fiestas', F1 + '/status', 'live');
  put('fiestas', F1 + '/title', 'Noche de juegos con amigos');
  put('fiestas', F1 + '/languageName', 'Español');
  put('fiestas', F1 + '/hostId', U1);
  put('fiestas', F1 + '/hostName', 'Anfitrión Uno');
  put('fiestas', F1 + '/maxSpeakers', 8);
  // Subárbol game (como lo escribe el host al iniciar "Quién es el mentiroso")
  const players = [];
  for (let i = 0; i < 12; i++) players.push('player_' + String(i).padStart(3, '0'));
  put('fiestas', F1 + '/game/status', 'describe');
  players.forEach((p, i) => put('fiestas', F1 + '/game/players/' + i, p));
  put('fiestas', F1 + '/game/liars/0', players[0]);
  put('fiestas', F1 + '/game/liars/1', players[1]);
  put('fiestas', F1 + '/game/round', 2);
  put('fiestas', F1 + '/game/turnIndex', 3);
  put('fiestas', F1 + '/game/turnEndsAt', BASE_TS + 30000);
  put('fiestas', F1 + '/game/dealEndsAt', BASE_TS - 60000);
  put('fiestas', F1 + '/game/startedAt', BASE_TS - 120000);
  put('fiestas', F1 + '/game/pair/0', 'manzana');
  put('fiestas', F1 + '/game/pair/1', 'pera');
  // 12 miembros x 8 hojas
  for (let i = 0; i < 12; i++) {
    const uid = i === 0 ? U1 : 'player_' + String(i).padStart(3, '0');
    const pre = 'fiestaMembers/' + F1 + '/' + uid;
    put('fiestaMembers', F1 + '/' + uid + '/role', i < 4 ? 'speaker' : 'listener');
    put('fiestaMembers', F1 + '/' + uid + '/name', 'Miembro ' + i);
    put('fiestaMembers', F1 + '/' + uid + '/photo', 'https://cdn.drex.app/avatars/member_' + i + '.png');
    put('fiestaMembers', F1 + '/' + uid + '/muted', i % 5 === 0);
    put('fiestaMembers', F1 + '/' + uid + '/mutedByHost', false);
    put('fiestaMembers', F1 + '/' + uid + '/lastSeen', BASE_TS + i * 1000);
    put('fiestaMembers', F1 + '/' + uid + '/joinedAt', BASE_TS - 3600000 + i * 5000);
    put('fiestaMembers', F1 + '/' + uid + '/device', 'iphone');
    void pre;
  }
  // 30 reacciones x 3 hojas
  const EMO = ['❤️', '🔥', '👏', '😂', '🎉'];
  for (let i = 0; i < 30; i++) {
    const k = pushKey(i);
    put('fiestaReactions', F1 + '/' + k + '/e', EMO[i % EMO.length]);
    put('fiestaReactions', F1 + '/' + k + '/from', 'player_' + String(i % 12).padStart(3, '0'));
    put('fiestaReactions', F1 + '/' + k + '/at', BASE_TS + i * 2000);
  }
  // 200 mensajes de chat x 5 hojas
  for (let i = 0; i < 200; i++) {
    const k = pushKey(i);
    put('fiestas', F1 + '/chat/' + k + '/uid', 'player_' + String(i % 12).padStart(3, '0'));
    put('fiestas', F1 + '/chat/' + k + '/name', 'Miembro ' + (i % 12));
    put('fiestas', F1 + '/chat/' + k + '/photo', 'https://cdn.drex.app/avatars/member_' + (i % 12) + '.png');
    put('fiestas', F1 + '/chat/' + k + '/text', 'Mensaje de la fiesta número ' + i + ' hola a todos');
    put('fiestas', F1 + '/chat/' + k + '/ts', BASE_TS + i * 3000);
  }
  // Bandeja de señales (ciclo rápido 800 ms, onDelta)
  for (let i = 0; i < 3; i++) {
    const k = pushKey(i);
    put('fiestaSignals', F1 + '/' + U1 + '/' + k + '/type', i === 0 ? 'offer' : 'ice');
    put('fiestaSignals', F1 + '/' + U1 + '/' + k + '/sdp', 'v=0\r\no=- 123 456 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n');
    put('fiestaSignals', F1 + '/' + U1 + '/' + k + '/from', 'player_001');
    put('fiestaSignals', F1 + '/' + U1 + '/' + k + '/ts', BASE_TS + i * 100);
  }
}

function seedChat(put) {
  // Perfil del otro (header de la sala)
  put('users', U2 + '/profileImage', 'https://cdn.drex.app/avatars/other.png');
  put('users', U2 + '/username', 'otro_usuario');
  put('users', U2 + '/displayName', 'Otro Usuario');
  put('users', U2 + '/email', 'otro@example.com');
  put('users', U2 + '/bio', 'Bio de prueba del otro usuario para la cabecera del chat');
  put('users', U2 + '/followersCount', 1234);
  put('users', U2 + '/followingCount', 321);
  put('users', U2 + '/verified', true);
  put('users', U2 + '/createdAt', BASE_TS - 80000000);
  put('users', U2 + '/postCount', 57);
  put('users', U2 + '/lastActiveAt', BASE_TS - 60000);
  put('users', U2 + '/language', 'es');
  // ensureConversationExists: 3 lecturas
  put('conversations', C1 + '/participants/' + U1, true);
  put('conversations', C1 + '/participants/' + U2, true);
  put('conversations', C1 + '/createdAt', BASE_TS - 7000000);
  put('conversations', C1 + '/updatedAt', BASE_TS - 1000);
  put('conversations', C1 + '/lastMessage', 'Nos vemos mañana entonces');
  put('userConversations', U1 + '/' + C1 + '/otherUid', U2);
  put('userConversations', U1 + '/' + C1 + '/updatedAt', BASE_TS - 1000);
  put('userConversations', U1 + '/' + C1 + '/lastMessage', 'Otro: Nos vemos mañana entonces');
  put('userConversations', U2 + '/' + C1 + '/otherUid', U1);
  put('userConversations', U2 + '/' + C1 + '/updatedAt', BASE_TS - 1000);
  put('userConversations', U2 + '/' + C1 + '/lastMessage', 'Tú: Nos vemos mañana entonces');
  // Borrados para mí
  put('chatDeletedForMe', U1 + '/' + C1 + '/-OldMsgA', true);
  put('chatDeletedForMe', U1 + '/' + C1 + '/-OldMsgB', true);
  // 300 mensajes x 7 hojas
  const LOREM = 'Este es el texto del mensaje de prueba para medir el costo de apertura de la sala de chat ';
  for (let i = 0; i < 300; i++) {
    const k = pushKey(i);
    const mine = i % 3 === 0;
    put('conversationMessages', C1 + '/' + k + '/senderId', mine ? U1 : U2);
    put('conversationMessages', C1 + '/' + k + '/senderName', mine ? 'Yo' : 'Otro Usuario');
    put('conversationMessages', C1 + '/' + k + '/text', LOREM + i);
    put('conversationMessages', C1 + '/' + k + '/timestamp', BASE_TS + i * 5000);
    put('conversationMessages', C1 + '/' + k + '/createdAt', BASE_TS + i * 5000);
    put('conversationMessages', C1 + '/' + k + '/reactions', i % 7 === 0 ? { '❤️': [U2] } : {});
    put('conversationMessages', C1 + '/' + k + '/replyTo', i % 11 === 0 ? pushKey(Math.max(0, i - 5)) : null);
  }
  put('conversationPinned', C1 + '/msgId', pushKey(299));
  put('conversationPinned', C1 + '/text', 'Mensaje fijado importante');
  put('conversationPinned', C1 + '/senderName', 'Otro Usuario');
  put('conversationPinned', C1 + '/timestamp', BASE_TS + 299 * 5000);
  put('userPresence', U2 + '/online', true);
  put('userPresence', U2 + '/lastSeen', BASE_TS - 5000);
  put('userPresence', U2 + '/device', 'iphone');
  put('conversationReadAt', C1 + '/' + U2, BASE_TS - 2000);
  put('chatThemes', C1 + '/' + U1, 'oceano');
  put('chatSettings', C1 + '/disappearing/enabled', false);
  put('chatSettings', C1 + '/disappearing/durationMs', 604800000);
  put('typing', C1 + '/' + U2, BASE_TS - 1000);
}

// --- Medición ------------------------------------------------------------------
const fake = makeInstrumentedFake();
seedFiesta(fake._put);
seedChat(fake._put);
I.setDocClient(fake);

const db = () => DrexCloud.database();
const snapshots = {}; // clave -> JSON del snap.val() (equivalencia antes/después)
const costs = {};     // clave -> {ops, bytes, rcu}

async function measure(key, refThunk) {
  fake._reset();
  const snap = await refThunk().once('value');
  const val = snap.val();
  snapshots[key] = JSON.stringify(val === undefined ? null : val);
  costs[key] = { ops: fake._stats.ops, bytes: fake._stats.bytes, rcu: Math.round(fake._stats.rcu * 100) / 100 };
  return val;
}

const FIESTA_GROUPS = [
  ['fiesta.doc.status', () => db().ref('fiestas/' + F1 + '/status')],
  ['fiesta.doc.game', () => db().ref('fiestas/' + F1 + '/game')],
  ['fiesta.doc.title', () => db().ref('fiestas/' + F1 + '/title')],
  ['fiesta.doc.languageName', () => db().ref('fiestas/' + F1 + '/languageName')],
  ['fiesta.doc.hostId', () => db().ref('fiestas/' + F1 + '/hostId')],
  ['fiesta.doc.hostName', () => db().ref('fiestas/' + F1 + '/hostName')],
  ['fiesta.doc.maxSpeakers', () => db().ref('fiestas/' + F1 + '/maxSpeakers')],
  ['fiesta.members', () => db().ref('fiestaMembers/' + F1)],
  ['fiesta.reactions', () => db().ref('fiestaReactions/' + F1).limitToLast(30)],
  ['fiesta.chat', () => db().ref('fiestas/' + F1 + '/chat').limitToLast(50)],
];

const CHAT_OPEN_READS = [
  ['chat.header.users', () => db().ref('users/' + U2)],
  ['chat.ensure.conversations', () => db().ref('conversations/' + C1)],
  ['chat.ensure.userConvA', () => db().ref('userConversations/' + U1 + '/' + C1)],
  ['chat.ensure.userConvB', () => db().ref('userConversations/' + U2 + '/' + C1)],
  ['chat.deletedForMe', () => db().ref('chatDeletedForMe/' + U1 + '/' + C1)],
  ['chat.messages', () => db().ref('conversationMessages/' + C1).limitToLast(80)],
  ['chat.pinned', () => db().ref('conversationPinned/' + C1)],
  ['chat.presence', () => db().ref('userPresence/' + U2)],
  ['chat.readReceipt', () => db().ref('conversationReadAt/' + C1 + '/' + U2)],
  ['chat.theme', () => db().ref('chatThemes/' + C1 + '/' + U1)],
  ['chat.disappearing', () => db().ref('chatSettings/' + C1 + '/disappearing')],
  ['chat.typing', () => db().ref('typing/' + C1)],
];

function sumCosts(prefix) {
  const t = { ops: 0, bytes: 0, rcu: 0 };
  Object.keys(costs).forEach(k => {
    if (k.indexOf(prefix) === 0) { t.ops += costs[k].ops; t.bytes += costs[k].bytes; t.rcu += costs[k].rcu; }
  });
  t.rcu = Math.round(t.rcu * 100) / 100;
  return t;
}

// Ráfaga de attach de _startChatListeners: ref.on('child_added') +
// ref.on('child_changed') sincrónicos sobre el mismo grupo. Antes de OPT-6
// son 2 lecturas iniciales; después, la 2ª reutiliza la 1ª en vuelo.
async function measureAttachBurst() {
  fake._reset();
  const ref = db().ref('conversationMessages/' + C1).limitToLast(80);
  let added = 0;
  const off1 = ref.on('child_added', () => { added++; });
  const off2 = ref.on('child_changed', () => {});
  await new Promise(r => setTimeout(r, 400));
  off1(); off2();
  await new Promise(r => setTimeout(r, 50));
  const rcu = Math.round(fake._stats.rcu * 100) / 100;
  costs['open.burst.messages'] = { ops: fake._stats.ops, bytes: fake._stats.bytes, rcu };
  snapshots['open.burst.messages'] = JSON.stringify({ added });
  // Dejar el caché H3 frío para la pasada 'open.' (como una apertura real)
  I.invalidateBoundedPrefixCache(['conversationMessages']);
  return added;
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const outFile = outIdx >= 0 ? process.argv[outIdx + 1] : null;

  // 1. Ciclo de fiesta en FRÍO (caché H3 vacío: como al entrar a la sala)
  for (const [key, thunk] of FIESTA_GROUPS) await measure('cold.' + key, thunk);
  const fiestaCold = sumCosts('cold.fiesta.');
  // 2. Ciclo de fiesta en IDLE (2º ciclo sin cambios: la válvula H3 salta fase 2)
  for (const [key, thunk] of FIESTA_GROUPS) await measure('idle.' + key, thunk);
  const fiestaIdle = sumCosts('idle.fiesta.');
  // 3. Ciclo de fiesta ACTIVO (1 mensaje + 1 reacción nuevos)
  const nk = pushKey(200), rk = pushKey(30);
  fake._put('fiestas', F1 + '/chat/' + nk + '/uid', U1);
  fake._put('fiestas', F1 + '/chat/' + nk + '/name', 'Yo');
  fake._put('fiestas', F1 + '/chat/' + nk + '/photo', 'https://cdn.drex.app/avatars/me.png');
  fake._put('fiestas', F1 + '/chat/' + nk + '/text', 'Mensaje nuevo en ciclo activo');
  fake._put('fiestas', F1 + '/chat/' + nk + '/ts', BASE_TS + 200 * 3000);
  fake._put('fiestaReactions', F1 + '/' + rk + '/e', '🔥');
  fake._put('fiestaReactions', F1 + '/' + rk + '/from', U1);
  fake._put('fiestaReactions', F1 + '/' + rk + '/at', BASE_TS + 31 * 2000);
  for (const [key, thunk] of FIESTA_GROUPS) await measure('active.' + key, thunk);
  const fiestaActive = sumCosts('active.fiesta.');

  // 4. Ráfaga de attach de la sala (child_added + child_changed sincrónicos)
  const burstAdded = await measureAttachBurst();

  // 5. Apertura de sala de chat (frío: H3 vacío para conversationMessages)
  for (const [key, thunk] of CHAT_OPEN_READS) await measure('open.' + key, thunk);
  const chatOpen = sumCosts('open.chat.');

  function row(label, t) {
    console.log('  ' + label.padEnd(34) + String(t.ops).padStart(4) + ' ops  ' +
      (t.bytes / 1024).toFixed(1).padStart(8) + ' KB  ' + t.rcu.toFixed(1).padStart(7) + ' RCU');
  }
  console.log('--- ciclo de polling de fiesta (3 s) ---');
  row('frío (al entrar a la sala)', fiestaCold);
  row('idle (sin cambios)', fiestaIdle);
  row('activo (1 msg + 1 reacción nuevos)', fiestaActive);
  console.log('--- apertura de sala de chat ---');
  row('apertura (12 lecturas)', chatOpen);
  row('ráfaga attach mensajes (added=' + burstAdded + ')', sumCosts('open.burst.'));
  console.log('--- detalle por grupo (RCU) ---');
  Object.keys(costs).sort().forEach(k => {
    if (k.indexOf('cold.') === 0 || k.indexOf('open.') === 0)
      console.log('  ' + k.padEnd(40) + costs[k].rcu.toFixed(1) + ' RCU (' + costs[k].ops + ' ops)');
  });

  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify({ snapshots, costs }, null, 1));
    console.log('\nResultados escritos en ' + outFile);
  }
  process.exit(0);
}

// --- Comparador antes/después ---------------------------------------------------
function deepEqual(a, b) { return a === b; }

if (process.argv.some(a => a.indexOf('--compare=') === 0)) {
  const [fa, fb] = process.argv.find(a => a.indexOf('--compare=') === 0).slice(10).split(',');
  const A = JSON.parse(fs.readFileSync(fa, 'utf8'));
  const B = JSON.parse(fs.readFileSync(fb, 'utf8'));
  let failures = 0;
  const keys = Object.keys(A.snapshots).sort();
  keys.forEach(k => {
    if (!deepEqual(A.snapshots[k], B.snapshots[k])) {
      failures++;
      console.log('  FAIL snapshot distinto: ' + k);
    }
  });
  if (!keys.length || Object.keys(B.snapshots).length !== keys.length) {
    failures++; console.log('  FAIL número de snapshots distinto');
  }
  console.log(failures === 0 ? 'EQUIVALENCIA OK: ' + keys.length + ' snapshots idénticos' : failures + ' FALLOS de equivalencia');
  function tot(costs, prefix) {
    let r = 0, o = 0;
    Object.keys(costs).forEach(k => { if (k.indexOf(prefix) === 0) { r += costs[k].rcu; o += costs[k].ops; } });
    return { rcu: r, ops: o };
  }
  [['cold.fiesta.', 'fiesta frío'], ['idle.fiesta.', 'fiesta idle'], ['active.fiesta.', 'fiesta activo'], ['open.chat.', 'chat apertura'], ['open.burst.', 'ráfaga attach']].forEach(([p, label]) => {
    const a = tot(A.costs, p), b = tot(B.costs, p);
    console.log('  ' + label.padEnd(14) + ' ANTES ' + a.rcu.toFixed(1) + ' RCU/' + a.ops + ' ops  →  DESPUÉS ' +
      b.rcu.toFixed(1) + ' RCU/' + b.ops + ' ops  (' + (a.rcu > 0 ? (100 * (a.rcu - b.rcu) / a.rcu).toFixed(1) : '0') + '% menos)');
  });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
