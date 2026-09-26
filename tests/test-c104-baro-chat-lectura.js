'use strict';
// Tests del carril A (oleada 1, BARO v4): 5 herramientas de LECTURA de chat.
//   chat_listar, chat_leer, chat_buscar, chat_marcar_leida, chat_resolver_usuario
// Carga block-lane-a.js en un sandbox (vm) con DrexCloud simulado y verifica:
// registro de tools, iconos, intents (ES/EN/ZH/PT), i18n en 4 idiomas y
// comportamiento real de cada herramienta (conteos reales, respetos de
// borrado, anclas markChatConversationRead / searchUserDirectoryByPrefix).
// Uso: node test-lane-a.js
const fs = require('fs');
const path = require('path');

/* Carga del bloque v4 desde index.html (patrón c103): --target opcional. */
let __v4ExplicitTarget = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) __v4ExplicitTarget = process.argv[++i];
}
function __v4ExtractBlock(m) {
  const html = fs.readFileSync(__v4ExplicitTarget || path.join(__dirname, '..', 'index.html'), 'utf8');
  let si = html.indexOf('/* ================= ' + m);
  if (si === -1) si = html.indexOf(m);
  if (si === -1) throw new Error('marcador ausente en target: ' + m);
  const slice = html.slice(si);
  const ni = slice.indexOf('/* ================= BARO \u00b7 sub-bloque 8', 1);
  const ei = slice.indexOf('</script>');
  let end = slice.length;
  if (ni !== -1) end = Math.min(end, ni);
  if (ei !== -1) end = Math.min(end, ei);
  return slice.slice(0, end);
}
const vm = require('vm');

const BLOCK_CODE = __v4ExtractBlock('BARO · sub-bloque 8A');

let fails = 0, oks = 0;
const CASES = [];
function tcase(name, fn) { CASES.push([name, fn]); }
function assert(cond, label) { if (!cond) throw new Error('assert: ' + label); }

/* ---------- DrexCloud simulado (in-memory) ---------- */
function makeDb(data, writes) {
  function getNode(p) {
    const parts = String(p).split('/').filter(Boolean);
    let node = data;
    for (const part of parts) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[part];
    }
    return node;
  }
  function snapOf(node, key) {
    return {
      key: key == null ? null : key,
      val() { return node === undefined ? null : node; },
      forEach(cb) {
        if (!node || typeof node !== 'object') return false;
        for (const k of Object.keys(node).sort()) {
          if (cb(snapOf(node[k], k)) === true) return true;
        }
        return false;
      }
    };
  }
  function ref(p) {
    let startAtV = null, limitFirst = null, limitLast = null;
    const r = {
      orderByKey() { return r; },
      orderByChild() { return r; },
      startAt(v) { startAtV = v; return r; },
      limitToFirst(n) { limitFirst = n; return r; },
      limitToLast(n) { limitLast = n; return r; },
      once() {
        let node = getNode(p);
        if (node && typeof node === 'object') {
          let keys = Object.keys(node).sort();
          if (startAtV != null) keys = keys.filter(k => k >= startAtV);
          if (limitFirst != null) keys = keys.slice(0, limitFirst);
          if (limitLast != null) keys = keys.slice(Math.max(0, keys.length - limitLast));
          const sub = {};
          keys.forEach(k => { sub[k] = node[k]; });
          node = sub;
        }
        return Promise.resolve(snapOf(node));
      },
      set(v) { writes.push({ op: 'set', path: p, v }); return Promise.resolve(); },
      transactionBlind(fn) {
        const cur = getNode(p);
        const next = fn(cur === undefined ? null : cur);
        const parts = String(p).split('/').filter(Boolean);
        let o = data;
        for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] || {}; o = o[parts[i]]; }
        o[parts[parts.length - 1]] = next;
        writes.push({ op: 'tx', path: p, v: next });
        return Promise.resolve({ committed: true });
      }
    };
    return r;
  }
  return { ref };
}

function mockData() {
  const NOW = Date.now();
  return {
    userConversations: {
      u1: {
        convA: { otherUid: 'u2', lastMessage: 'nos vemos mañana', updatedAt: NOW - 60000, pinnedAt: 0 },
        convB: { isGroup: true, groupName: 'Familia', lastMessage: 'Juan: hola a todos', updatedAt: NOW - 3600000, pinnedAt: 0 },
        convC: { otherUid: 'u9', lastMessage: 'ok', updatedAt: NOW - 7200000 },
        convD: { otherUid: 'u3', lastMessage: 'hey', updatedAt: NOW - 90000, pinnedAt: 0 }
      }
    },
    chatUnread: { u1: { convA: { c: 0, r: NOW - 60000 }, convB: { c: 3, r: NOW - 3600000 } } },
    users: {
      u2: { username: 'maria', displayName: 'María López', profileImage: '' },
      u3: { username: 'mario', displayName: 'Mario', profileImage: '' },
      u4: { username: 'ana', displayName: 'Ana', profileImage: '' }
    },
    usernames: { ana: 'u4', maria: 'u2', mario: 'u3' },
    conversationMessages: {
      convA: {
        m1: { senderId: 'u1', text: 'hola María', timestamp: NOW - 120000 },
        m2: { senderId: 'u2', text: 'hola! qué tal todo por allá', timestamp: NOW - 60000 },
        m3: { senderId: 'u2', text: 'esto lo borré', timestamp: NOW - 30000, deletedForAll: true },
        m4: { senderId: 'u2', text: '', timestamp: NOW - 10000, image: 'https://x/foto.jpg' }
      },
      convB: {}
    },
    chatDeletedForMe: { u1: { convA: { m2: true } } }
  };
}

/* ---------- carga del bloque en sandbox ---------- */
function loadBlock(opts) {
  opts = opts || {};
  const code = BLOCK_CODE;
  const registered = {};
  const writes = [];
  const markReadCalls = [];
  const dirSearchCalls = [];
  const data = opts.data || mockData();
  const storage = {};
  const sandbox = {
    console,
    Buffer,
    baroRegisterTool(name, def) { registered[name] = def; },
    BARO_ICONS: {},
    baroIntentRules: [],
    baroIntentToTool: {},
    APP_ENGLISH_TEXT: {},
    APP_CHINESE_TEXT: {},
    APP_PORTUGUESE_TEXT: {},
    getAppLanguage: () => opts.lang || 'es',
    DrexCloud: {
      database: () => makeDb(data, writes),
      auth: () => ({ currentUser: { uid: 'u1' } })
    },
    localStorage: {
      getItem: k => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); }
    }
  };
  if (opts.withMarkRead) {
    sandbox.markChatConversationRead = id => { markReadCalls.push(id); };
  }
  if (opts.withDirSearch) {
    sandbox.searchUserDirectoryByPrefix = (q, limit) => {
      dirSearchCalls.push([q, limit]);
      return Promise.resolve([
        { uid: 'u2', username: 'maria', displayName: 'María López', profileImage: '' }
      ]);
    };
  }
  if (opts.preEnglish) sandbox.APP_ENGLISH_TEXT['baro.chat.label_listar'] = 'PREEXISTENTE';
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'block-lane-a.js' });
  return { sandbox, registered, writes, markReadCalls, dirSearchCalls, data, storage };
}

function makeCtx(user, stepLog, v1) {
  let seq = 0;
  const ctx = {
    user: user === undefined ? { uid: 'u1' } : user,
    t: k => k,
    esc: s => String(s)
  };
  if (v1) {
    ctx.step = label => { const id = 's' + (++seq); stepLog.push({ ev: 'start', id, label }); return id; };
    ctx.stepDone = (id) => { stepLog.push({ ev: 'done', id }); };
  } else {
    ctx.stepStart = label => { const id = 's' + (++seq); stepLog.push({ ev: 'start', id, label }); return id; };
    ctx.stepUpdate = (id, o) => { stepLog.push({ ev: 'update', id, label: o && o.label }); };
    ctx.stepDone = (id) => { stepLog.push({ ev: 'done', id }); };
  }
  return ctx;
}

const TOOLS5 = ['chat_listar', 'chat_leer', 'chat_buscar', 'chat_marcar_leida', 'chat_resolver_usuario'];

/* ---------- estáticos ---------- */
tcase('bloque: sin referencias a Series ni giveaway', () => {
  const code = BLOCK_CODE;
  assert(!/serie/i.test(code), 'menciona serie');
  assert(!/giveaway/i.test(code), 'menciona giveaway');
});

tcase('carga sin errores y expone gancho de test', () => {
  const { sandbox } = loadBlock();
  assert(sandbox.__baro8a, 'falta __baro8a');
  assert(typeof sandbox.__baro8a.norm === 'function', 'falta norm');
  assert(typeof sandbox.baroChat8aPickRoom === 'function', 'falta pick handler global');
});

tcase('registro: las 5 herramientas con label y run', () => {
  const { registered, sandbox } = loadBlock();
  for (const name of TOOLS5) {
    assert(registered[name], 'no registrada: ' + name);
    assert(typeof registered[name].run === 'function', 'sin run: ' + name);
    const key = registered[name].label;
    assert(typeof key === 'string' && key.indexOf('baro.chat.') === 0, 'label raro en ' + name);
    const e = sandbox.__baro8a.I18N[key];
    assert(e && e.es && e.en && e.zh && e.pt, 'i18n incompleta para ' + key);
  }
});

tcase('iconos: 5 SVG propios en BARO_ICONS, sin emoji', () => {
  const { sandbox } = loadBlock();
  const names = ['chat-lista', 'chat-leer', 'chat-buscar', 'chat-leida', 'chat-usuario'];
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
  for (const n of names) {
    const svg = sandbox.BARO_ICONS[n];
    assert(typeof svg === 'string' && svg.length > 50, 'icono ausente: ' + n);
    assert(svg.indexOf('<svg') !== -1, 'no es svg: ' + n);
    assert(svg.indexOf('viewBox="0 0 24 24"') !== -1, 'grilla no 24: ' + n);
    assert(svg.indexOf('stroke="currentColor"') !== -1, 'sin currentColor: ' + n);
    assert(!emojiRe.test(svg), 'emoji en icono: ' + n);
  }
});

tcase('i18n: fusión a APP_*_TEXT en EN/ZH/PT', () => {
  const { sandbox } = loadBlock();
  assert(sandbox.APP_ENGLISH_TEXT['baro.chat.label_listar'] === 'Chat list', 'EN listar');
  assert(sandbox.APP_CHINESE_TEXT['baro.chat.label_leer'] === '读取聊天', 'ZH leer');
  assert(sandbox.APP_PORTUGUESE_TEXT['baro.chat.label_buscar'] === 'Buscar no chat', 'PT buscar');
  assert(sandbox.APP_ENGLISH_TEXT['baro.chat.login_needed'] === 'Sign in to use chat.', 'EN login');
});

tcase('i18n: no pisa claves preexistentes', () => {
  const { sandbox } = loadBlock({ preEnglish: true });
  assert(sandbox.APP_ENGLISH_TEXT['baro.chat.label_listar'] === 'PREEXISTENTE', 'pisó clave existente');
});

tcase('intents: 5 reglas ES/EN/ZH/PT + mapeo intent->tool', () => {
  const { sandbox } = loadBlock();
  assert(sandbox.baroIntentRules.length === 5, 'reglas: ' + sandbox.baroIntentRules.length);
  for (const r of sandbox.baroIntentRules) {
    assert(['es', 'en', 'zh', 'pt'].every(l => r.langs.indexOf(l) !== -1), 'langs incompletos en ' + r.intent);
    assert(Array.isArray(r.patterns) && r.patterns.length >= 4, 'pocos patterns en ' + r.intent);
    // Nota: instanceof RegExp falla entre reinos (vm); se usa toString.
    assert(r.patterns.every(p => Object.prototype.toString.call(p) === '[object RegExp]'), 'pattern no-RegExp en ' + r.intent);
    assert(typeof r.extract === 'function', 'sin extract en ' + r.intent);
    assert(TOOLS5.indexOf(r.intent) !== -1, 'intent desconocido: ' + r.intent);
    assert(sandbox.baroIntentToTool[r.intent] === r.intent, 'mapeo roto: ' + r.intent);
  }
});

/* ---------- scoring a nivel de patterns ---------- */
function ruleHits(rule, text) {
  let hits = 0;
  for (const p of rule.patterns) if (p.test(text)) hits++;
  return hits;
}
function bestRule(rules, text) {
  let best = null, bh = -1;
  for (const r of rules) {
    const h = ruleHits(r, text);
    if (h > bh) { bh = h; best = r; }
  }
  return { rule: best, hits: bh };
}

tcase('intent chat_listar en ES/EN/ZH/PT', () => {
  const { sandbox } = loadBlock();
  const samples = ['muéstrame mis chats', 'ver mis chats', 'show my chats', 'lista de chats', '聊天列表', '我的聊天'];
  for (const s of samples) {
    const b = bestRule(sandbox.baroIntentRules, s);
    assert(b.rule.intent === 'chat_listar', s + ' -> ' + b.rule.intent);
    assert(b.hits >= 1, s + ' sin hits');
  }
});

tcase('intent: sin robo entre reglas de chat', () => {
  const { sandbox } = loadBlock();
  const cases = [
    ['lee el chat con María', 'chat_leer'],
    ['busca "hola" en el chat con María', 'chat_buscar'],
    ['marca como leído el chat', 'chat_marcar_leida'],
    ['mark the chat as read', 'chat_marcar_leida'],
    ['busca al usuario @maria', 'chat_resolver_usuario'],
    ['quiero un nuevo chat con Ana', 'chat_resolver_usuario'],
    ['¿qué me dijo María?', 'chat_leer']
  ];
  for (const [text, want] of cases) {
    const b = bestRule(sandbox.baroIntentRules, text);
    assert(b.rule.intent === want, text + ' -> ' + b.rule.intent + ' (esperado ' + want + ')');
  }
});

tcase('intent chat_leer + extract de nombre', () => {
  const { sandbox } = loadBlock();
  const b = bestRule(sandbox.baroIntentRules, 'lee el chat con María');
  assert(b.rule.intent === 'chat_leer', 'ganó ' + b.rule.intent);
  const args = b.rule.extract('lee el chat con María');
  assert(args.nombre === 'María', 'nombre=' + JSON.stringify(args));
});

tcase('intent chat_buscar gana a lectura genérica + extract q/sala', () => {
  const { sandbox } = loadBlock();
  const b = bestRule(sandbox.baroIntentRules, 'busca "hola" en el chat con María');
  assert(b.rule.intent === 'chat_buscar', 'ganó ' + b.rule.intent);
  const args = b.rule.extract('busca "hola" en el chat con María');
  assert(args.q === 'hola', 'q=' + JSON.stringify(args));
  assert(args.nombre === 'María', 'nombre=' + JSON.stringify(args));
});

tcase('intent chat_marcar_leida', () => {
  const { sandbox } = loadBlock();
  const b = bestRule(sandbox.baroIntentRules, 'marca como leído el chat con María');
  assert(b.rule.intent === 'chat_marcar_leida', 'ganó ' + b.rule.intent);
  const args = b.rule.extract('marca como leído el chat');
  assert(!args.nombre && !args.roomId, 'debería ir a candidatos: ' + JSON.stringify(args));
});

tcase('intent chat_resolver_usuario (@ y "nuevo chat")', () => {
  const { sandbox } = loadBlock();
  let b = bestRule(sandbox.baroIntentRules, 'busca al usuario @maria');
  assert(b.rule.intent === 'chat_resolver_usuario', 'ganó ' + b.rule.intent);
  assert(b.rule.extract('busca al usuario @maria').q === 'maria', 'q mal');
  b = bestRule(sandbox.baroIntentRules, 'quiero un nuevo chat con Ana');
  assert(b.rule.intent === 'chat_resolver_usuario', 'nuevo chat -> ' + b.rule.intent);
  assert(b.rule.extract('quiero un nuevo chat con Ana').q === 'Ana', 'q=' + JSON.stringify(b.rule.extract('quiero un nuevo chat con Ana')));
  assert(b.rule.extract('@mario').q === 'mario', 'q @mario mal');
});

tcase('extract: "¿qué me dijo María?" deja el nombre limpio', () => {
  const { sandbox } = loadBlock();
  const t = sandbox.__baro8a.extractTarget('¿qué me dijo María?');
  assert(t.nombre === 'María', 'nombre=' + JSON.stringify(t));
});

tcase('tolerancia básica: sin acentos y variantes', () => {
  const { sandbox } = loadBlock();
  const h = sandbox.__baro8a;
  assert(h.norm('María López') === 'maria lopez', 'norm con acentos');
  let b = bestRule(sandbox.baroIntentRules, 'muestrame mis chats');
  assert(b.rule.intent === 'chat_listar', 'sin acento -> ' + b.rule.intent);
  b = bestRule(sandbox.baroIntentRules, 'mark the chat as read');
  assert(b.rule.intent === 'chat_marcar_leida', 'EN mark read -> ' + b.rule.intent);
  b = bestRule(sandbox.baroIntentRules, '在聊天中搜索');
  assert(b.rule.intent === 'chat_buscar', 'ZH -> ' + b.rule.intent);
});

/* ---------- herramientas: comportamiento real ---------- */
tcase('chat_listar: lista real con no-leídos y orden', async () => {
  const { registered } = loadBlock();
  const stepLog = [];
  const res = await registered.chat_listar.run({}, makeCtx(undefined, stepLog));
  assert(res.html.indexOf('Familia') !== -1, 'falta grupo Familia');
  assert(res.html.indexOf('María López') !== -1 || res.html.indexOf('@maria') !== -1, 'falta María');
  assert(res.html.indexOf('3 sin leer') !== -1, 'falta badge 3 sin leer');
  assert(res.html.indexOf('baroChat8aPickRoom') !== -1, 'items no tocables');
  const upd = stepLog.find(e => e.ev === 'update');
  assert(upd && upd.label === '4 conversaciones', 'conteo real en paso: ' + (upd && upd.label));
  assert(res.stats && res.stats.count === 4, 'stats.count');
  // orden: convA (más reciente) antes que convB
  assert(res.html.indexOf('convA') < res.html.indexOf('convB'), 'orden no reciente-primero');
});

tcase('chat_listar sin sesión: mensaje honesto', async () => {
  const { registered } = loadBlock();
  const res = await registered.chat_listar.run({}, makeCtx(null, []));
  assert(res.html.indexOf('Inicia sesión') !== -1, 'no pide login: ' + res.html.slice(0, 80));
});

tcase('chat_listar en inglés', async () => {
  const { registered } = loadBlock({ lang: 'en' });
  const res = await registered.chat_listar.run({}, makeCtx(undefined, []));
  assert(res.html.indexOf('conversations') !== -1, 'no en inglés');
  assert(res.html.indexOf('unread') !== -1, 'badge no en inglés');
});

tcase('chat_leer con roomId: respeta borrados y muestra remitentes', async () => {
  const { registered } = loadBlock();
  const stepLog = [];
  const res = await registered.chat_leer.run({ roomId: 'convA' }, makeCtx(undefined, stepLog));
  assert(res.html.indexOf('hola María') !== -1, 'falta m1');
  assert(res.html.indexOf('qué tal todo') === -1, 'm2 (deletedForMe) no se filtró');
  assert(res.html.indexOf('Mensaje eliminado') !== -1, 'falta placeholder deletedForAll');
  assert(res.html.indexOf('[Foto]') !== -1, 'falta indicador de foto');
  assert(res.html.indexOf('Tú') !== -1, 'falta "Tú" en mensaje propio');
  const upd = stepLog.find(e => e.ev === 'update');
  assert(upd && upd.label === '3 mensajes', 'conteo real: ' + (upd && upd.label));
});

tcase('chat_leer por nombre de contacto', async () => {
  const { registered } = loadBlock();
  const res = await registered.chat_leer.run({ nombre: 'María' }, makeCtx(undefined, []));
  assert(res.html.indexOf('hola María') !== -1, 'no resolvió a convA');
});

tcase('chat_leer sin objetivo: candidatos tocables', async () => {
  const { registered } = loadBlock();
  const res = await registered.chat_leer.run({}, makeCtx(undefined, []));
  assert(res.html.indexOf('¿Cuál chat leo?') !== -1, 'falta pregunta');
  assert(res.html.indexOf("baroChat8aPickRoom('chat_leer'") !== -1, 'falta pick handler');
});

tcase('chat_leer nombre ambiguo: candidatos', async () => {
  const { registered } = loadBlock();
  const res = await registered.chat_leer.run({ nombre: 'mari' }, makeCtx(undefined, []));
  assert(res.html.indexOf('¿Cuál chat leo?') !== -1, 'debería pedir desambiguación');
});

tcase('chat_leer roomId inválido', async () => {
  const { registered } = loadBlock();
  const res = await registered.chat_leer.run({ roomId: '../../etc' }, makeCtx(undefined, []));
  assert(res.html.indexOf('no es válido') !== -1, 'no rechaza id');
});

tcase('chat_buscar: coincidencias con conteo real', async () => {
  const { registered } = loadBlock();
  const stepLog = [];
  const res = await registered.chat_buscar.run({ roomId: 'convA', q: 'hola' }, makeCtx(undefined, stepLog));
  assert(res.html.indexOf('hola María') !== -1, 'falta coincidencia');
  assert(res.html.indexOf('1 coincidencias en 3 mensajes revisados') !== -1, 'conteo: ' + res.html.slice(0, 200));
  assert(res.stats && res.stats.count === 1, 'stats');
});

tcase('chat_buscar: insensible a acentos/mayúsculas', async () => {
  const { registered } = loadBlock();
  const res = await registered.chat_buscar.run({ roomId: 'convA', q: 'HOLA' }, makeCtx(undefined, []));
  assert(res.stats.count === 1, 'mayúsculas no matchean');
});

tcase('chat_buscar sin query: mensaje honesto', async () => {
  const { registered } = loadBlock();
  const res = await registered.chat_buscar.run({ roomId: 'convA', q: '  ' }, makeCtx(undefined, []));
  assert(res.html.indexOf('Dime qué quieres buscar') !== -1, 'no pide query');
});

tcase('chat_buscar por nombre de sala sin mensajes', async () => {
  const { registered } = loadBlock();
  const res = await registered.chat_buscar.run({ nombre: 'Familia', q: 'hola' }, makeCtx(undefined, []));
  assert(res.html.indexOf('Sin coincidencias') !== -1, 'debería decir sin coincidencias');
  assert(res.html.indexOf('0 mensajes revisados') !== -1, 'conteo cero honesto');
});

tcase('chat_marcar_leida: usa el ancla directa', async () => {
  const { registered, markReadCalls } = loadBlock({ withMarkRead: true });
  const res = await registered.chat_marcar_leida.run({ roomId: 'convA' }, makeCtx(undefined, []));
  assert(markReadCalls.length === 1 && markReadCalls[0] === 'convA', 'no llamó al ancla: ' + JSON.stringify(markReadCalls));
  assert(res.html.indexOf('marcado como leído') !== -1, 'falta confirmación');
});

tcase('chat_marcar_leida: réplica sin el ancla global', async () => {
  const { registered, writes, storage } = loadBlock({ withMarkRead: false });
  const res = await registered.chat_marcar_leida.run({ nombre: 'Familia' }, makeCtx(undefined, []));
  const tx = writes.find(w => w.op === 'tx' && w.path === 'chatUnread/u1/convB');
  assert(tx && tx.v.c === 0, 'no reseteó chatUnread: ' + JSON.stringify(writes));
  assert(storage['drexChatLastRead_u1_convB'], 'no guardó lastRead local');
  assert(res.html.indexOf('Familia') !== -1 && res.html.indexOf('marcado como leído') !== -1, 'confirmación');
});

tcase('chat_marcar_leida sin objetivo: candidatos', async () => {
  const { registered } = loadBlock();
  const res = await registered.chat_marcar_leida.run({}, makeCtx(undefined, []));
  assert(res.html.indexOf('¿Cuál chat marco como leído?') !== -1, 'falta pregunta');
});

tcase('chat_resolver_usuario: ancla searchUserDirectoryByPrefix', async () => {
  const { registered, dirSearchCalls } = loadBlock({ withDirSearch: true });
  const stepLog = [];
  const res = await registered.chat_resolver_usuario.run({ q: '@maria' }, makeCtx(undefined, stepLog));
  assert(dirSearchCalls.length === 1 && dirSearchCalls[0][0] === 'maria', 'no usó el ancla: ' + JSON.stringify(dirSearchCalls));
  assert(res.html.indexOf('@maria') !== -1, 'falta @maria');
  assert(res.html.indexOf('ver perfil') !== -1, 'falta enlace de perfil');
  assert(res.html.indexOf('#/u/maria') !== -1, 'falta href de perfil');
  const upd = stepLog.find(e => e.ev === 'update');
  assert(upd && upd.label === '1 usuarios:', 'conteo: ' + (upd && upd.label));
});

tcase('chat_resolver_usuario: réplica por prefijo en usernames/', async () => {
  const { registered } = loadBlock({ withDirSearch: false });
  const res = await registered.chat_resolver_usuario.run({ q: 'mar' }, makeCtx(undefined, []));
  assert(res.html.indexOf('@maria') !== -1, 'falta maria');
  assert(res.html.indexOf('@mario') !== -1, 'falta mario (prefijo)');
  assert(res.html.indexOf('@ana') === -1, 'ana no debería salir con prefijo mar');
});

tcase('chat_resolver_usuario sin query: mensaje honesto', async () => {
  const { registered } = loadBlock();
  const res = await registered.chat_resolver_usuario.run({ q: '' }, makeCtx(undefined, []));
  assert(res.html.indexOf('¿A quién busco?') !== -1, 'no pide nombre');
});

tcase('ctx v1 (step/stepDone sin stepStart) también funciona', async () => {
  const { registered } = loadBlock();
  const stepLog = [];
  const res = await registered.chat_listar.run({}, makeCtx(undefined, stepLog, true));
  assert(res.html.indexOf('4 conversaciones') !== -1, 'falló con ctx v1');
  assert(stepLog.some(e => e.ev === 'start'), 'no hubo step');
});

tcase('pick handler re-ejecuta la herramienta con la sala tocada', async () => {
  const { sandbox, registered } = loadBlock();
  let painted = null;
  sandbox.baroTools = registered; // el handler real lee el registro de la app
  sandbox.baroAddBaroMessage = html => { painted = html; };
  sandbox.baroMakeCtx = () => makeCtx(undefined, []);
  const b64 = Buffer.from(JSON.stringify({})).toString('base64');
  // simula el onclick de una tarjeta de candidatos
  await new Promise(resolve => {
    sandbox.baroChat8aPickRoom('chat_leer', 'convA', b64);
    setTimeout(resolve, 50);
  });
  assert(painted && painted.indexOf('hola María') !== -1, 'el pick no leyó la sala');
});

tcase('privacidad: roomId fuera del inbox no se lee', async () => {
  const { registered } = loadBlock();
  const res = await registered.chat_leer.run({ roomId: 'convZzz999' }, makeCtx(undefined, []));
  assert(res.html.indexOf('No encontré ese chat') !== -1, 'leyó sala ajena: ' + res.html.slice(0, 120));
});

tcase('lista: ordena antes de recortar (inbox > límite)', async () => {
  const data = mockData();
  const NOW = Date.now();
  data.userConversations.u1 = {};
  // 25 salas: las claves k01..k20 son viejas, k21..k25 son las más recientes.
  // Con slice-antes-de-sort, k21..k25 se perderían (chat_listar recorta a 20).
  for (let i = 1; i <= 25; i++) {
    const id = 'k' + String(i).padStart(2, '0');
    data.userConversations.u1[id] = {
      isGroup: true, groupName: 'Grupo ' + id,
      lastMessage: 'x', updatedAt: NOW - (26 - i) * 60000, pinnedAt: 0
    };
  }
  const { registered } = loadBlock({ data });
  const res = await registered.chat_listar.run({}, makeCtx(undefined, []));
  assert(res.html.indexOf('Grupo k25') !== -1, 'la sala más reciente quedó fuera del top 20');
  assert(res.html.indexOf('Grupo k01') === -1, 'la sala más vieja no debería estar en el top 20');
  assert(res.stats.count === 20, 'stats.count=' + res.stats.count);
});

/* ---------- correr ---------- */
(async () => {
  for (const [name, fn] of CASES) {
    try { await fn(); oks++; }
    catch (e) { fails++; console.error('FAIL ' + name + ' :: ' + e.message); }
  }
  console.log('test-lane-a: ' + oks + ' OK, ' + fails + ' FAIL');
  process.exit(fails ? 1 : 0);
})();
