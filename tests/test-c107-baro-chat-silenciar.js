/* ============================================================================
 * BARO v4 · Oleada 1 · Carril C2 — tests del carril (silenciar + permisos DM)
 * Ejecución: node test-lane-c2.js   (código de salida 0 = todo OK)
 *
 * Cubre:
 *  A. Extracción de la sección pura (marcadores BARO-LANE-C2-PURE).
 *  B. i18n: las 4 lenguas en cada clave, sin copias ES pegadas en EN/ZH/PT,
 *     claves de nombre/necesidad del router.
 *  C. Reglas de intención: 3 intents, parseo ES/EN/ZH/PT, casos ambiguos,
 *     declinación, duraciones, sin disparos falsos.
 *  D. Sandbox de integración (vm): registro exacto, iconos, reglas en el
 *     router, fusión i18n, escritura SOLO tras baroAskConfirm, veto
 *     minor_restricted, lista de silenciados con datos reales del mock.
 *  E. Sin sesión -> mensaje honesto en las 3 herramientas, cero escrituras.
 *  F. Contrato estático: sin giveaway/Series, sin APIs externas.
 * ========================================================================== */
'use strict';
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

const src = __v4ExtractBlock('BARO · sub-bloque 8C2');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? ' :: ' + extra : '')); console.error('FAIL:', name, extra || ''); }
}
function eq(a, b, name) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  ok(sa === sb, name, 'esperado ' + sb + ' recibido ' + sa);
}

/* ================= A. sección pura ================= */
const PURE_START = '/* ============================ BARO-LANE-C2-PURE-START ============================';
const PURE_END = '/* ============================ BARO-LANE-C2-PURE-END ============================';
ok(src.includes(PURE_START), 'A1 marcadores: existe PURE-START');
ok(src.includes(PURE_END), 'A2 marcadores: existe PURE-END');
let pureSrc = src.split(PURE_START)[1].split(PURE_END)[0];
/* Quitar la cola del comentario del marcador (las líneas " * ..." y su cierre). */
pureSrc = pureSrc.replace(/^[\s\S]*?\*\//, '');
ok(/^\s*(\/\*|var|function)/.test(pureSrc) && !/^\s*\*[^/]/.test(pureSrc), 'A3 la sección pura empieza en código (sin restos del comentario)');

let P = null;
try {
  const loader = new Function(pureSrc + ';return {BARO_I18N_LC2:BARO_I18N_LC2,baroLc2Norm:baroLc2Norm,baroLc2Fill:baroLc2Fill,baroLc2T:baroLc2T,baroLc2Mentions:baroLc2Mentions,baroLc2SafeId:baroLc2SafeId,baroLc2ParseDuration:baroLc2ParseDuration,baroLc2DurText:baroLc2DurText,baroLc2ExtractGroupName:baroLc2ExtractGroupName,baroLc2ParseSilence:baroLc2ParseSilence,baroLc2ParseDmPerm:baroLc2ParseDmPerm,baroLc2CollectMutes:baroLc2CollectMutes,baroLc2IntentRules:baroLc2IntentRules};');
  P = loader();
  ok(true, 'A4 la sección pura carga en Node sin errores');
} catch (e) {
  ok(false, 'A4 la sección pura carga en Node sin errores', String(e && e.message));
}

/* ================= B. i18n ================= */
if (P) {
  const keys = Object.keys(P.BARO_I18N_LC2);
  ok(keys.length >= 40, 'B1 al menos 40 claves i18n', String(keys.length));
  let bad = [];
  keys.forEach(k => {
    const e = P.BARO_I18N_LC2[k];
    ['es', 'en', 'zh', 'pt'].forEach(l => {
      if (!e || typeof e[l] !== 'string' || !e[l].trim()) bad.push(k + ':' + l);
    });
  });
  ok(bad.length === 0, 'B2 toda clave tiene ES/EN/ZH/PT no vacíos', bad.slice(0, 5).join('; '));
  /* B3: EN/ZH/PT no son la cadena ES copiada (muestra representativa). */
  const sample = ['baro.c2.silenciar.label', 'baro.c2.silenciados_ver.label',
    'baro.c2.permiso_dm.label', 'baro.c2.silenciar.ok_dm', 'baro.c2.permiso_dm.ok',
    'baro.c2.silenciar.sin_objetivo', 'baro.intent.name.chat_permiso_dm',
    'baro.c2.permiso_dm.minor_blocked', 'baro.c2.silenciados_ver.vacio'];
  let copied = [];
  sample.forEach(k => {
    const e = P.BARO_I18N_LC2[k];
    if (e.en === e.es) copied.push(k + ':en==es');
    if (e.zh === e.es) copied.push(k + ':zh==es');
    if (e.pt === e.es) copied.push(k + ':pt==es');
  });
  ok(copied.length === 0, 'B3 EN/ZH/PT traducidos (no copias del ES)', copied.join('; '));
  /* B4: claves del router presentes. */
  ['chat_silenciar', 'chat_silenciados_ver', 'chat_permiso_dm'].forEach(n => {
    ok(!!P.BARO_I18N_LC2['baro.intent.name.' + n], 'B4 intent name ' + n);
    ok(!!P.BARO_I18N_LC2['baro.intent.need.' + n], 'B4 intent need ' + n);
  });
  /* B5: interpolación. */
  eq(P.baroLc2Fill(P.baroLc2T('baro.c2.silenciar.ok_dm', 'es'), { u: 'ana', d: '8 horas' }),
    'Chat con @ana silenciado (8 horas). 🔇', 'B5 fill ES');
}

/* ================= C. reglas de intención ================= */
function ruleFor(intent) {
  return P.baroLc2IntentRules().filter(r => r.intent === intent)[0];
}
if (P) {
  const rules = P.baroLc2IntentRules();
  eq(rules.map(r => r.intent).sort(),
    ['chat_permiso_dm', 'chat_silenciados_ver', 'chat_silenciar'],
    'C1 tres reglas con los intents exactos');
  let meta = [];
  rules.forEach(r => {
    if (JSON.stringify(r.langs) !== JSON.stringify(['es', 'en', 'zh', 'pt'])) meta.push(r.intent + ':langs');
    if (!Array.isArray(r.patterns) || r.patterns.length < 4) meta.push(r.intent + ':patterns');
    if (typeof r.extract !== 'function') meta.push(r.intent + ':extract');
  });
  ok(meta.length === 0, 'C2 cada regla: 4 lenguas, >=4 patrones, extract fn', meta.join('; '));

  /* --- chat_silenciar --- */
  let r = ruleFor('chat_silenciar');
  eq(r.extract('silencia a @ana por 8 horas'), { tipo: 'dm', objetivo: 'ana', duracionMs: 28800000 }, 'C3 silenciar DM 8h ES');
  eq(r.extract('silencia el grupo Viaje para siempre'), { tipo: 'grupo', objetivo: 'Viaje', duracionMs: -1 }, 'C4 silenciar grupo siempre');
  eq(r.extract('mute @ana for a week'), { tipo: 'dm', objetivo: 'ana', duracionMs: 604800000 }, 'C5 silenciar EN week');
  eq(r.extract('silencia a @ana'), { tipo: 'dm', objetivo: 'ana', duracionMs: null }, 'C6 silenciar sin duración -> null');
  eq(r.extract('silencia este chat'), { ambiguous: true, candidates: ['chat_silenciar'], reason: 'missing_target' }, 'C7 silenciar sin objetivo -> ambiguo');
  eq(r.extract('静音@ana'), { tipo: 'dm', objetivo: 'ana', duracionMs: null }, 'C8 silenciar ZH');
  eq(r.extract('silencia o grupo Viagem por 8 horas'), { tipo: 'grupo', objetivo: 'Viagem', duracionMs: 28800000 }, 'C9 silenciar PT grupo');
  eq(r.extract('静音群组旅行'), { tipo: 'grupo', objetivo: '旅行', duracionMs: null }, 'C9b silenciar ZH grupo');

  /* --- chat_silenciados_ver --- */
  r = ruleFor('chat_silenciados_ver');
  eq(r.extract('ver chats silenciados'), {}, 'C10 silenciados ver ES');
  eq(r.extract('muéstrame los silenciados'), {}, 'C11 silenciados mostrar ES');
  eq(r.extract('show my muted chats'), {}, 'C12 silenciados ver EN');
  eq(r.extract('查看已静音的聊天'), {}, 'C13 silenciados ver ZH');
  eq(r.extract('ver conversas silenciadas'), {}, 'C14 silenciados ver PT');
  eq(r.extract('ver mis posts'), null, 'C15 "ver mis posts" declina (sin señal de silencio)');
  /* "ver chats silenciados" NO debe casar con la regla de silenciar. */
  ok(!ruleFor('chat_silenciar').patterns.some(p => p.test('ver chats silenciados')), 'C16 ver-silenciados no dispara silenciar');

  /* --- chat_permiso_dm --- */
  r = ruleFor('chat_permiso_dm');
  eq(r.extract('pon mis mensajes en solo amigos'), { permiso: 'friends' }, 'C17 permiso friends ES');
  eq(r.extract('que nadie pueda escribirme'), { permiso: 'none' }, 'C18 permiso none ES');
  eq(r.extract('que todos puedan escribirme'), { permiso: 'all' }, 'C19 permiso all ES');
  eq(r.extract('who can message me: friends only'), { permiso: 'friends' }, 'C20 permiso EN');
  eq(r.extract('quién puede escribirme'), { ambiguous: true, candidates: ['chat_permiso_dm'], reason: 'missing_permiso' }, 'C21 permiso sin valor -> ambiguo');
  eq(r.extract('所有人都可以给我发消息'), { permiso: 'all' }, 'C22 permiso all ZH');
  eq(r.extract('不允许任何人给我发消息'), { permiso: 'none' }, 'C23 permiso none ZH');
  eq(r.extract('仅限好友可以给我发私信'), { permiso: 'friends' }, 'C24 permiso friends ZH');
  eq(r.extract('ninguém pode me escrever'), { permiso: 'none' }, 'C25 permiso none PT');
  eq(r.extract('todos podem me escrever'), { permiso: 'all' }, 'C26 permiso all PT');
  eq(r.extract('quem pode me escrever'), { ambiguous: true, candidates: ['chat_permiso_dm'], reason: 'missing_permiso' }, 'C27 permiso PT sin valor -> ambiguo');

  /* --- duraciones --- */
  eq(P.baroLc2ParseDuration('por 8 horas'), 28800000, 'C28 duración 8h');
  eq(P.baroLc2ParseDuration('una semana'), 604800000, 'C29 duración 1 semana');
  eq(P.baroLc2ParseDuration('para siempre'), -1, 'C30 duración siempre');
  eq(P.baroLc2ParseDuration('30 minutos'), 1800000, 'C31 duración 30min');
  eq(P.baroLc2ParseDuration('por 2 días'), 172800000, 'C32 duración 2 días');
  eq(P.baroLc2ParseDuration('8小时'), 28800000, 'C33 duración ZH 8h');
  eq(P.baroLc2ParseDuration(''), null, 'C34 sin duración -> null');

  /* --- nombre de grupo --- */
  eq(P.baroLc2ExtractGroupName('silencia el grupo Viaje por 8 horas'), 'Viaje', 'C35 grupo ES');
  eq(P.baroLc2ExtractGroupName('mute the group Road Trip'), 'Road Trip', 'C36 grupo EN');
  eq(P.baroLc2ExtractGroupName('silencia o grupo Viagem'), 'Viagem', 'C37 grupo PT');

  /* --- núcleo de silenciados --- */
  const now = Date.now();
  const col = P.baroLc2CollectMutes(
    { u2: { muteUntil: now + 3600000 }, u3: { muteUntil: 1 } },
    { g1: { muteUntil: 9999999999999 } }, now);
  eq(col.map(e => e.kind + ':' + e.id), ['group:g1', 'user:u2'], 'C38 collect: activos ordenados (siempre primero), vencidos fuera');

  /* --- etiquetas de duración --- */
  eq(P.baroLc2DurText(28800000, 'es'), '8 horas', 'C39 durText ES');
  eq(P.baroLc2DurText(-1, 'zh'), '永久', 'C40 durText ZH siempre');
  eq(P.baroLc2DurText(604800000, 'pt'), '1 semana', 'C41 durText PT');

  /* --- no disparos falsos --- */
  const neutral = ['hola, ¿cómo estás?', 'qué hora es', 'cuéntame un chiste', 'ver mis posts'];
  let misfire = [];
  P.baroLc2IntentRules().forEach(rr => {
    neutral.forEach(t => {
      if (rr.patterns.some(p => p.test(t))) misfire.push(rr.intent + ' <- ' + t);
    });
  });
  ok(misfire.length === 0, 'C42 texto neutro no dispara reglas', misfire.join('; '));
  ok(P.baroLc2SafeId('abc123-_'), 'C43 safeId acepta id simple');
  ok(!P.baroLc2SafeId('a/b') && !P.baroLc2SafeId('a.b') && !P.baroLc2SafeId(''), 'C44 safeId rechaza . / y vacío');
  eq(P.baroLc2Mentions('hola @ana y @Luis_99.'), ['ana', 'Luis_99'], 'C45 menciones únicas');
}

/* ================= D. sandbox de integración ================= */
async function runIntegration() {
  /* --- DrexCloud simulado --- */
  const store = {};
  const events = []; // orden: 'confirm' vs 'write:...'
  function getPath(p) {
    return String(p).split('/').filter(Boolean).reduce((o, k) => (o && typeof o === 'object') ? o[k] : undefined, store);
  }
  function setPath(p, v) {
    const ks = String(p).split('/').filter(Boolean);
    let o = store;
    for (let i = 0; i < ks.length - 1; i++) { if (!o[ks[i]] || typeof o[ks[i]] !== 'object') o[ks[i]] = {}; o = o[ks[i]]; }
    o[ks[ks.length - 1]] = v;
  }
  function delPath(p) {
    const ks = String(p).split('/').filter(Boolean);
    let o = store;
    for (let i = 0; i < ks.length - 1; i++) { o = o[ks[i]]; if (!o) return; }
    delete o[ks[ks.length - 1]];
  }
  const mockDb = {
    ref(p) {
      return {
        once: async () => ({ val: () => { const v = getPath(p); return v === undefined ? null : JSON.parse(JSON.stringify(v)); } }),
        set: async (v) => { events.push('write:set:' + p); setPath(p, v); },
        update: async (v) => { events.push('write:update:' + p); const cur = getPath(p) || {}; setPath(p, Object.assign({}, cur, v)); },
        remove: async () => { events.push('write:remove:' + p); delPath(p); }
      };
    }
  };

  /* --- plataforma simulada --- */
  const registered = {};
  const confirmCalls = [];
  const said = [];
  const sandbox = {
    console,
    baroRegisterTool(name, def) { registered[name] = def; },
    async baroAskConfirm(opts) {
      confirmCalls.push(opts && opts.titleKey);
      events.push('confirm');
      if (opts && typeof opts.onConfirm === 'function') await opts.onConfirm();
      return null;
    },
    baroAddBaroMessage(html) { said.push(html); },
    baroLang() { return 'es'; },
    escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
    BARO_UI_I18N: {},
    BARO_ICONS: {},
    baroIntentRules: [],
    baroIntentToTool: {},
    DrexCloud: { database() { return mockDb; } }
  };
  sandbox.window = undefined;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'block-lane-c2.js' });

  function makeCtx(user) {    const steps = [];
    return {
      ctx: {
        user: user || null,
        t(key) { const e = sandbox.BARO_UI_I18N[key]; return (e && e.es) ? e.es : key; },
        step(label) { steps.push(['step', label]); return 's' + steps.length; },
        stepDone(id) { steps.push(['done', id]); },
        esc(s) { return sandbox.escapeHtml(s); }
      },
      steps
    };
  }
  const flush = () => new Promise(r => setTimeout(r, 30));

  /* --- D1: registro exacto --- */
  const names = Object.keys(registered).sort();
  eq(names, ['chat_permiso_dm', 'chat_silenciados_ver', 'chat_silenciar'], 'D1 tres herramientas registradas con nombres exactos');
  [['chat_silenciar', 'c2-silenciar'], ['chat_silenciados_ver', 'c2-silenciados'], ['chat_permiso_dm', 'c2-permiso']].forEach(([n, icon]) => {
    const d = registered[n] || {};
    ok(typeof d.run === 'function', 'D2 run es función: ' + n);
    ok(typeof d.label === 'string' && d.label.indexOf('baro.c2.') === 0, 'D3 label con clave i18n: ' + n, d.label);
    ok(d.icon === icon, 'D4 icono propio: ' + n + ' -> ' + icon, d.icon);
  });

  /* --- D5: iconos índigo propios en BARO_ICONS --- */
  ['c2-silenciar', 'c2-silenciados', 'c2-permiso'].forEach(k => {
    const svg = sandbox.BARO_ICONS[k] || '';
    ok(svg.indexOf('<svg') === 0 && svg.indexOf('viewBox="0 0 24 24"') !== -1, 'D5 icono registrado ' + k);
  });
  ok(sandbox.BARO_ICONS['c2-silenciar'] !== sandbox.BARO_ICONS['c2-silenciados'], 'D6 iconos distintos entre sí');

  /* --- D7: router 6b --- */
  eq(sandbox.baroIntentToTool.chat_silenciar, 'chat_silenciar', 'D7 intent->tool chat_silenciar');
  eq(sandbox.baroIntentToTool.chat_silenciados_ver, 'chat_silenciados_ver', 'D7 intent->tool chat_silenciados_ver');
  eq(sandbox.baroIntentToTool.chat_permiso_dm, 'chat_permiso_dm', 'D7 intent->tool chat_permiso_dm');
  const ruleIntents = sandbox.baroIntentRules.map(r => r.intent).sort();
  eq(ruleIntents, ['chat_permiso_dm', 'chat_silenciados_ver', 'chat_silenciar'], 'D8 reglas agregadas al router');

  /* --- D9: fusión i18n --- */
  ok(sandbox.BARO_UI_I18N['baro.c2.silenciar.label'] && sandbox.BARO_UI_I18N['baro.c2.silenciar.label'].pt === 'Silenciar conversa', 'D9 i18n fusionada a BARO_UI_I18N');

  /* --- D10: toques expuestos --- */
  ok(typeof sandbox.baroLc2SilencePick === 'function', 'D10 expuesto baroLc2SilencePick');
  ok(typeof sandbox.baroLc2PermPick === 'function', 'D10 expuesto baroLc2PermPick');
  ok(typeof sandbox.baroLc2Unmute === 'function', 'D10 expuesto baroLc2Unmute');

  /* --- D11: silenciar DM con duración -> confirmación ANTES de escribir --- */
  setPath('usernames/ana', 'u2');
  setPath('users/u1', { dmPermission: 'all', accountTier: null });
  events.length = 0;
  let { ctx } = makeCtx({ uid: 'u1' });
  let res = await registered.chat_silenciar.run({ tipo: 'dm', objetivo: 'ana', duracionMs: 28800000 }, ctx);
  await flush();
  eq(res, { html: '' }, 'D11 silenciar DM: la tarjeta de confirmación no devuelve burbuja');
  const mute = getPath('chatMutes/u1/u2');
  ok(mute && Math.abs(mute.muteUntil - (Date.now() + 28800000)) < 60000, 'D11 escrito chatMutes/u1/u2 con muteUntil ≈ +8h');
  ok(events.indexOf('confirm') !== -1 && events.indexOf('confirm') < events.findIndex(e => e.indexOf('write:') === 0),
    'D11 confirmación por toque ANTES de la escritura', events.join(','));
  ok(said.some(h => h.indexOf('silenciado') !== -1 && h.indexOf('@ana') !== -1), 'D11 mensaje de éxito con @ana');

  /* --- D12: sin duración -> 3 toques, cero escrituras hasta elegir --- */
  events.length = 0; said.length = 0;
  ({ ctx } = makeCtx({ uid: 'u1' }));
  res = await registered.chat_silenciar.run({ tipo: 'dm', objetivo: 'ana' }, ctx);
  ok(res.html.indexOf('baroLc2SilencePick') !== -1, 'D12 sin duración: mensaje con toques de duración');
  ok((res.html.match(/baroLc2SilencePick/g) || []).length === 3, 'D12 tres botones de duración');
  ok(!events.some(e => e.indexOf('write:') === 0), 'D12 cero escrituras antes de elegir duración');
  const pidM = res.html.match(/baroLc2SilencePick\('([^']+)',-1\)/);
  ok(!!pidM, 'D12 pid extraíble del botón "siempre"');
  await sandbox.baroLc2SilencePick(pidM[1], -1);
  await new Promise(r => setTimeout(r, 20));
  const muteForever = getPath('chatMutes/u1/u2');
  eq(muteForever && muteForever.muteUntil, 9999999999999, 'D12 tras elegir "siempre": muteUntil = 9999999999999');

  /* --- D13: usuario inexistente -> honesto, sin escritura --- */
  events.length = 0;
  ({ ctx } = makeCtx({ uid: 'u1' }));
  res = await registered.chat_silenciar.run({ tipo: 'dm', objetivo: 'nadie99', duracionMs: 28800000 }, ctx);
  ok(res.html.indexOf('nadie99') !== -1, 'D13 usuario inexistente: mensaje honesto con el nombre');
  ok(!events.some(e => e.indexOf('write:') === 0), 'D13 cero escrituras');

  /* --- D14: silenciar grupo --- */
  setPath('userConversations/u1', { g1: true, dmX: true });
  setPath('groupChats/g1', { name: 'Viaje', members: { u1: true } });
  events.length = 0; said.length = 0;
  ({ ctx } = makeCtx({ uid: 'u1' }));
  res = await registered.chat_silenciar.run({ tipo: 'grupo', objetivo: 'Viaje', duracionMs: 604800000 }, ctx);
  await flush();
  const gmute = getPath('groupMutes/u1/g1');
  ok(gmute && Math.abs(gmute.muteUntil - (Date.now() + 604800000)) < 60000, 'D14 escrito groupMutes/u1/g1 con muteUntil ≈ +1sem');
  ok(said.some(h => h.indexOf('Viaje') !== -1), 'D14 mensaje de éxito con el nombre del grupo');

  /* --- D15: grupo inexistente -> honesto --- */
  ({ ctx } = makeCtx({ uid: 'u1' }));
  res = await registered.chat_silenciar.run({ tipo: 'grupo', objetivo: 'Inexistente', duracionMs: 1 }, ctx);
  ok(res.html.indexOf('Inexistente') !== -1, 'D15 grupo inexistente: mensaje honesto');

  /* --- D16: ver silenciados (activos sí, vencidos no) --- */
  const tnow = Date.now();
  setPath('chatMutes/u1', { u2: { muteUntil: tnow + 3600000 }, u9: { muteUntil: 1 } });
  setPath('groupMutes/u1', { g1: { muteUntil: 9999999999999 } });
  setPath('users/u2', { username: 'ana' });
  ({ ctx } = makeCtx({ uid: 'u1' }));
  const steps16 = [];
  ctx.step = (l) => { steps16.push(l); return 's' + steps16.length; };
  ctx.stepDone = () => {};
  res = await registered.chat_silenciados_ver.run({}, ctx);
  ok(res.html.indexOf('@ana') !== -1, 'D16 lista incluye @ana (activo)');
  ok(res.html.indexOf('Viaje') !== -1, 'D16 lista incluye el grupo Viaje');
  ok(res.html.indexOf('u9') === -1, 'D16 el vencido (u9) no aparece');
  ok(res.html.indexOf('baroLc2Unmute') !== -1, 'D16 botón reactivar presente');
  ok(steps16.some(l => /2 silenciados/.test(l) && /1 chats/.test(l) && /1 grupos/.test(l)), 'D16 paso con conteos reales', steps16.join(' | '));

  /* --- D17: reactivar quita el nodo --- */
  events.length = 0; said.length = 0;
  ({ ctx } = makeCtx({ uid: 'u1' }));
  await registered.chat_silenciados_ver.run({}, ctx); // fija baroLc2LastCtx
  sandbox.baroLc2Unmute('user', 'u2');
  await new Promise(r => setTimeout(r, 20));
  ok(getPath('chatMutes/u1/u2') === undefined, 'D17 reactivar elimina chatMutes/u1/u2');
  ok(said.some(h => h.indexOf('reactivado') !== -1), 'D17 aviso de reactivación');

  /* --- D18: permiso DM -> confirmación y escritura --- */
  setPath('users/u1', { dmPermission: 'all', accountTier: null });
  events.length = 0; said.length = 0;
  ({ ctx } = makeCtx({ uid: 'u1' }));
  res = await registered.chat_permiso_dm.run({ permiso: 'friends' }, ctx);
  await flush();
  eq(res, { html: '' }, 'D18 permiso: tarjeta de confirmación sin burbuja');
  eq(getPath('users/u1/dmPermission'), 'friends', 'D18 escrito users/u1/dmPermission = friends');
  ok(events.indexOf('confirm') < events.findIndex(e => e.indexOf('write:') === 0), 'D18 confirmación ANTES de la escritura');
  ok(confirmCalls.some(k => k === 'baro.c2.permiso_dm.confirm_title'), 'D18 título de confirmación correcto');

  /* --- D19: veto minor_restricted --- */
  setPath('users/u1', { dmPermission: 'friends', accountTier: 'minor_restricted' });
  events.length = 0;
  ({ ctx } = makeCtx({ uid: 'u1' }));
  res = await registered.chat_permiso_dm.run({ permiso: 'all' }, ctx);
  ok(/menores de 14/.test(res.html), 'D19 minor_restricted + all: mensaje honesto de veto');
  ok(!events.some(e => e.indexOf('write:') === 0), 'D19 cero escrituras ante el veto');
  eq(getPath('users/u1/dmPermission'), 'friends', 'D19 el permiso no cambió');

  /* --- D20: sin permiso -> 3 toques --- */
  ({ ctx } = makeCtx({ uid: 'u1' }));
  res = await registered.chat_permiso_dm.run({}, ctx);
  ok((res.html.match(/baroLc2PermPick/g) || []).length === 3, 'D20 sin valor: tres toques de opción');
  const pidP = res.html.match(/baroLc2PermPick\('([^']+)','none'\)/);
  events.length = 0;
  await sandbox.baroLc2PermPick(pidP[1], 'none');
  await new Promise(r => setTimeout(r, 20));
  eq(getPath('users/u1/dmPermission'), 'none', 'D20 tras elegir "nadie": dmPermission = none');
}

/* ================= E. sin sesión ================= */
async function runNoSession() {
  const sandbox = {
    console,
    baroRegisterTool() {},
    baroAskConfirm() { throw new Error('no debe pedir confirmación sin sesión'); },
    BARO_UI_I18N: {}, BARO_ICONS: {}, baroIntentRules: [], baroIntentToTool: {},
    DrexCloud: { database() { throw new Error('no debe tocar BD sin sesión'); } },
    baroLang() { return 'es'; }
  };
  sandbox.window = undefined; sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'block-lane-c2.js' });
  // Capturar las herramientas registradas
  const reg = {};
  sandbox.baroRegisterTool = (n, d) => { reg[n] = d; };
  vm.runInContext(src, sandbox, { filename: 'block-lane-c2.js' });
  const ctx = {
    user: null,
    t(key) { const e = sandbox.BARO_UI_I18N[key]; return (e && e.es) ? e.es : key; },
    step() { return 's'; }, stepDone() {},
    esc(s) { return String(s); }
  };
  for (const n of ['chat_silenciar', 'chat_silenciados_ver', 'chat_permiso_dm']) {
    let r = null, threw = false;
    try { r = await reg[n].run(n === 'chat_silenciar' ? { tipo: 'dm', objetivo: 'ana', duracionMs: 1 } : (n === 'chat_permiso_dm' ? { permiso: 'friends' } : {}), ctx); }
    catch (e) { threw = true; }
    ok(!threw, 'E1 ' + n + ': no lanza sin sesión');
    ok(r && /inicia sesi[oó]n/i.test(r.html), 'E2 ' + n + ': mensaje honesto de login', r && r.html);
  }
}

/* ================= F. contrato estático ================= */
(function staticContract() {
  const low = src.toLowerCase();
  ok(!low.includes('giveaway'), 'F1 sin giveaway');
  ok(!/serie/i.test(src), 'F2 sin Series');
  ok(!src.includes('fetch(') && !src.includes('XMLHttpRequest'), 'F3 sin APIs externas (fetch/XHR)');
  ok(!/https?:\/\//.test(src), 'F4 sin URLs externas');
  ok(/\(function\s*\(\s*\)\s*\{/.test(src) && src.trim().endsWith('})();'), 'F5 IIFE cerrada');
  ok(src.indexOf("'use strict'") !== -1 || src.indexOf('"use strict"') !== -1, 'F6 use strict');
})();

/* ================= correr ================= */
(async function main() {
  try { await runIntegration(); }
  catch (e) { ok(false, 'D sandbox de integración no lanzó', String(e && e.stack || e)); }
  try { await runNoSession(); }
  catch (e) { ok(false, 'E sin sesión no lanzó', String(e && e.stack || e)); }
  console.log('\n' + pass + ' OK, ' + fail + ' FAIL');
  if (fail) { console.error('Fallos:\n- ' + failures.join('\n- ')); process.exit(1); }
  console.log('ALL PASS');
})();
