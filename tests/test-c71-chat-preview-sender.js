// C71-C1: updateChatConversationPreview atribuía el preview a la cuenta
// ACTUAL (currentUser fresco) en vez del remitente real. El .then() del envío
// puede resolver DESPUÉS de un cambio de cuenta (un set() cuelga hasta 25 s
// por dbTimeout y el switch pide password), creando entradas fantasma en
// userConversations/<cuenta-nueva>/, lastSenderId corrupto y bumps erróneos.
// El fix pasa options.senderUid y la función lo usa para toda la atribución.
// Cada caso conductual FALLA contra la versión base (atribución a currentUser)
// y PASA con el fix.
// Uso: node tests/test-c71-chat-preview-sender.js [ruta/index.html]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}

// ---------- Parte A: estática — el fix existe y los 4 call sites pasan senderUid ----------
check('fix C71-C1 presente (options.senderUid)', html.includes('const senderUid = options.senderUid || user.uid;'));
const callSites = [
  ['envío de mensaje (_pushOptimisticChatMessage)', 'senderUid: user.uid // C71-C1'],
  ['envío de GIF (sendGif)', "{ conversationId, recipientId, isGroup, groupMembers, senderUid: user.uid }"],
  ['invitación de colaboración', 'senderUid: me.uid }).catch'],
];
for (const [label, probe] of callSites) {
  check('call site pasa senderUid: ' + label, html.includes(probe));
}

// Extracción de la función REAL (el `{` de apertura se busca DESPUÉS del
// cierre de la lista de parámetros: el valor por defecto `payload = {}`
// confunde al brace-matching ingenuo).
function extractFn(src, name) {
  let sigStart = src.indexOf('function ' + name + '(');
  if (sigStart === -1) return null;
  if (src.slice(sigStart - 6, sigStart) === 'async ') sigStart -= 6; // conservar `async`
  const parenStart = src.indexOf('(', sigStart);
  let pdepth = 0, inStr = null;
  let i = parenStart;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === inStr && src[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '(') pdepth++;
    else if (c === ')') { pdepth--; if (pdepth === 0) break; }
  }
  if (pdepth !== 0) return null;
  const bodyStart = src.indexOf('{', i);
  let depth = 0;
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(sigStart, j + 1); }
  }
  return null;
}
const fnSrc = extractFn(html, 'updateChatConversationPreview');
check('función real extraída del HTML', !!fnSrc);
if (!fnSrc) { console.log(failures ? '\nRESULTADO: FAIL' : '\nRESULTADO: OK'); process.exit(failures ? 1 : 0); }

// ---------- Parte C: sandbox con cambio de cuenta simulado ----------
function makeCtx(currentUid) {
  const updatesLog = [];
  const bumpCalls = [];
  const sandbox = {
    console,
    Date,
    DrexCloud: {
      auth: () => ({ currentUser: currentUid ? { uid: currentUid } : null }),
      database: () => ({
        ref: () => ({
          update: (u) => { updatesLog.push(u); return Promise.resolve(); },
          once: () => Promise.resolve({ val: () => ({}) }),
        }),
      }),
    },
    currentChatRoomId: null,
    currentChatIsGroup: false,
    currentChatRecipient: null,
    currentGroupMembers: [],
    chatConversationCache: { loadedAt: 0 },
    CHAT_CONVERSATIONS_CACHE_KEY: 'drex_chat_conversations_cache',
    localStorage: { removeItem() {} },
    bumpChatUnread: (conversationId, memberUids, senderUid, msgTs) => {
      bumpCalls.push({ conversationId, memberUids, senderUid, msgTs });
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fnSrc, ctx);
  return { ctx, updatesLog, bumpCalls };
}
function mergedUpdates(updatesLog) {
  return Object.assign({}, ...updatesLog);
}
function hasPrefixKey(updates, prefix) {
  return Object.keys(updates).some(k => k.startsWith(prefix));
}

(async () => {
  // Caso 1 (DM): A envía a X; el .then resuelve ya como B (cambio de cuenta).
  {
    const { ctx, updatesLog, bumpCalls } = makeCtx('uidB');
    await ctx.updateChatConversationPreview('hola', { senderName: 'Ana' },
      { conversationId: 'convAX', recipientId: 'uidX', isGroup: false, senderUid: 'uidA' });
    const u = mergedUpdates(updatesLog);
    check('DM: sin entradas fantasma en userConversations/uidB/', !hasPrefixKey(u, 'userConversations/uidB/'));
    check('DM: preview escrito en el nodo de A', u['userConversations/uidA/convAX/lastMessage'] === 'hola');
    check('DM: otherUid de A apunta a X', u['userConversations/uidA/convAX/otherUid'] === 'uidX');
    check('DM: otherUid de X apunta a A', u['userConversations/uidX/convAX/otherUid'] === 'uidA');
    check('DM: lastSenderId del nodo compartido es A', u['conversations/convAX/lastSenderId'] === 'uidA');
    check('DM: bumpChatUnread excluye a A (remitente real)', bumpCalls.length === 1 && bumpCalls[0].senderUid === 'uidA');
    check('DM: bump no incluye a B', bumpCalls.length === 1 && !bumpCalls[0].memberUids.includes('uidB'));
  }

  // Caso 2 (grupo): mismo escenario; el prefijo 'Tú' debe leerse desde A.
  {
    const { ctx, updatesLog, bumpCalls } = makeCtx('uidB');
    await ctx.updateChatConversationPreview('buenas', { senderName: 'Ana' },
      { conversationId: 'g1', isGroup: true, groupMembers: ['uidA', 'uidX', 'uidY'], senderUid: 'uidA' });
    const u = mergedUpdates(updatesLog);
    check('grupo: sin entradas fantasma en userConversations/uidB/', !hasPrefixKey(u, 'userConversations/uidB/'));
    check("grupo: lastMessage de A usa 'Tú:'", (u['userConversations/uidA/g1/lastMessage'] || '').startsWith('Tú: '));
    check('grupo: lastMessage de X usa el nombre del remitente', (u['userConversations/uidX/g1/lastMessage'] || '').startsWith('Ana: '));
    check('grupo: bumpChatUnread con remitente A', bumpCalls.length === 1 && bumpCalls[0].senderUid === 'uidA');
  }

  // Caso 3 (legacy): sin senderUid y sin cambio de cuenta, comportamiento idéntico al anterior.
  {
    const { ctx, updatesLog, bumpCalls } = makeCtx('uidA');
    await ctx.updateChatConversationPreview('hola', { senderName: 'Ana' },
      { conversationId: 'convAX', recipientId: 'uidX', isGroup: false });
    const u = mergedUpdates(updatesLog);
    check('legacy: preview en el nodo de A', u['userConversations/uidA/convAX/lastMessage'] === 'hola');
    check('legacy: lastSenderId es A', u['conversations/convAX/lastSenderId'] === 'uidA');
    check('legacy: bump con remitente A', bumpCalls.length === 1 && bumpCalls[0].senderUid === 'uidA');
  }

  console.log(failures ? '\nRESULTADO: FAIL' : '\nRESULTADO: OK');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
