'use strict';
// Tests del carril 8I (OLEADA 3 v4 — UTILIDADES) de BARO: util_traducir,
// util_resumir, util_recordatorio.
// Cubre: registro (baroRegisterTool/BARO_ICONS/baroIntentRules/baroIntentToTool),
// intents ES/EN/ZH/PT (extract puros), i18n en 4 idiomas, resumen extractivo
// real (scoring determinista), parseo de fecha/hora en 4 idiomas,
// HUECO HONESTO de traducir (mensaje honesto + cero llamadas de red),
// confirmación obligatoria en util_recordatorio (escritura) con cero
// escrituras antes de confirmar y sin sesión, y ausencia del literal de
// cierre de script en el bloque.
// El bloque se EXTRAE del target (patron oleada 1 / c103-c110): marcador
// 'BARO · sub-bloque 8I'. Sin APIs externas ni red en el bloque.
// Uso: node test-c118-baro-utilidades.js [--target <ruta-a-html-con-8I>]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let __v4ExplicitTarget = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) __v4ExplicitTarget = process.argv[++i];
}
function __v4ExtractBlock(m) {
  const __v4Priv8I = path.join(__dirname, 'target-8I.html');
const html = fs.readFileSync(__v4ExplicitTarget || (fs.existsSync(__v4Priv8I) ? __v4Priv8I : path.join(__dirname, '..', 'index.html')), 'utf8');
  const START = '/* ================= ' + m;
  let si = html.indexOf(START);
  if (si === -1) si = html.indexOf(m);
  assert(si !== -1, 'marcador ausente en el target');
  const slice = html.slice(si);
  const ni = slice.indexOf('/* ================= BARO · sub-bloque 8', 1);
  const ei = slice.indexOf('</scr' + 'ipt>');
  let end = slice.length;
  if (ni !== -1) end = Math.min(end, ni);
  if (ei !== -1) end = Math.min(end, ei);
  return slice.slice(0, end);
}
const src = __v4ExtractBlock('BARO · sub-bloque 8I');

let fails = 0, oks = 0;
const CASES = [];
function tcase(name, fn) { CASES.push([name, fn]); }
function assert(cond, label) { if (!cond) throw new Error('assert: ' + label); }
function eqJ(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(label + ' esperado=' + e + ' actual=' + a);
}

/* ---------- 0. el bloque no trae el literal de cierre de script ---------- */
tcase('bloque sin literal de cierre de script', () => {
  assert(src.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en el bloque extraido (8I)');
  const tsrc = fs.readFileSync(__filename, 'utf8');
  assert(tsrc.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en test-c118-baro-utilidades.js');
});

/* ---------- stubs de plataforma + carga del bloque en sandbox (vm) ---------- */
const registered = {};
const said = [];
const confirmCalls = [];
const netCalls = [];
const __dModule = { exports: {} };
let resolveStub = null; // configurado por test: baroResolveForTool
let draftsStore = [];
const sandbox = {
  console,
  Buffer,
  module: __dModule,
  BARO_UI_I18N: {}, // en produccion lo definen bloques anteriores; sin el, la fusion se salta por guarda
  APP_ENGLISH_TEXT: {},
  APP_CHINESE_TEXT: {},
  APP_PORTUGUESE_TEXT: {},
  baroRegisterTool: function (name, def) { registered[name] = def; },
  BARO_ICONS: {},
  baroIntentRules: [],
  baroIntentToTool: {},
  baroAddBaroMessage: function (html) { said.push(String(html)); },
  baroAskConfirm: function (opts) { confirmCalls.push(opts); return {}; },
  baroResolveForTool: async function () { return resolveStub; },
  getAllNoteDrafts: function () { return draftsStore.slice(); },
  saveAllNoteDrafts: function (list) { draftsStore = list.slice(); },
  fetch: function () { netCalls.push(Array.prototype.slice.call(arguments)); return Promise.reject(new Error('red prohibida')); }
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'block-lane-8I.js' });
const M = __dModule.exports;
assert(M && M.pure && M.tools && M.BARO_I18N_I && M.BARO_I_RULES,
  'el bloque extraido no exporto pure/tools/i18n/reglas (module.exports)');

// Fake RTDB mínimo con encadenado orderByKey().limitToLast().once() + forEach.
function makeStore(seed) {
  const root = (seed && typeof seed === 'object') ? seed : {};
  function parts(p) { return String(p == null ? '' : p).split('/').filter((x) => x !== ''); }
  function get(p) {
    let node = root;
    for (const part of parts(p)) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[part];
    }
    return node;
  }
  function snapOf(p) {
    const v = get(p);
    const ex = v !== null && v !== undefined;
    return {
      exists: () => ex,
      val: () => (ex ? v : null),
      forEach: (cb) => {
        if (v && typeof v === 'object') {
          Object.keys(v).sort().forEach((k) => cb({ key: k, val: () => v[k] }));
        }
      }
    };
  }
  const fake = {
    _root: root,
    ref(p) {
      const base = String(p == null ? '' : p);
      const refObj = {
        once: async () => snapOf(base),
        orderByKey: () => refObj,
        limitToLast: () => refObj
      };
      return refObj;
    }
  };
  return fake;
}
function setPlatform(seed) {
  said.length = 0;
  confirmCalls.length = 0;
  netCalls.length = 0;
  resolveStub = null;
  draftsStore = [];
  sandbox.DrexCloud = { database: () => makeStore(seed) };
  return sandbox.DrexCloud.database();
}
let stepSeq = 0;
function makeCtx(uid) {
  return {
    user: uid ? { uid } : null,
    t: (k) => k,
    step: (l) => 's' + (++stepSeq),
    stepDone: () => {},
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  };
}

const P = M.pure, T = M.tools;

/* ---------- 1. registro ---------- */
const TOOL_NAMES = ['util_traducir', 'util_resumir', 'util_recordatorio'];

tcase('registro: 3 herramientas con label i18n y run', () => {
  TOOL_NAMES.forEach((n) => {
    assert(registered[n], 'no registrada: ' + n);
    assert(typeof registered[n].run === 'function', 'run no es funcion: ' + n);
    assert(M.BARO_I18N_I[registered[n].label], 'label sin i18n: ' + n);
  });
  eqJ(Object.keys(registered).sort(), TOOL_NAMES.slice().sort(), 'nombres registrados');
});
tcase('registro: BARO_ICONS con 3 svg propios índigo', () => {
  const want = ['util-traducir', 'util-resumir', 'util-recordatorio'];
  want.forEach((k) => {
    const svg = sandbox.BARO_ICONS[k];
    assert(typeof svg === 'string' && svg.indexOf('<svg') === 0, 'icono ausente/invalido: ' + k);
    assert(svg.indexOf('#2F33B8') !== -1, 'icono sin índigo #2F33B8: ' + k);
  });
});
tcase('registro: 3 reglas en baroIntentRules + mapa intent->tool', () => {
  assert(sandbox.baroIntentRules.length === 3, 'reglas: ' + sandbox.baroIntentRules.length);
  sandbox.baroIntentRules.forEach((r) => {
    eqJ(r.langs, ['es', 'en', 'zh', 'pt'], 'langs de ' + r.intent);
    assert(Array.isArray(r.patterns) && r.patterns.length > 0, 'patterns vacios: ' + r.intent);
    r.patterns.forEach((p) => assert(Object.prototype.toString.call(p) === '[object RegExp]', 'pattern no RegExp en ' + r.intent));
    assert(typeof r.extract === 'function', 'extract no es funcion: ' + r.intent);
    assert(typeof r.intent === 'string' && r.intent.indexOf('util_') === 0, 'intent raro: ' + r.intent);
  });
  TOOL_NAMES.forEach((n) => assert(sandbox.baroIntentToTool[n] === n, 'mapa sin ' + n));
});
tcase('BARO_I_RULES exportadas coinciden con lo registrado', () => {
  eqJ(M.BARO_I_RULES.map((r) => r.intent).sort(), TOOL_NAMES.slice().sort(), 'intents de reglas');
});

/* ---------- 2. i18n 4 idiomas ---------- */
tcase('i18n: toda clave tiene es/en/zh/pt no vacios', () => {
  const keys = Object.keys(M.BARO_I18N_I);
  assert(keys.length >= 35, 'pocas claves: ' + keys.length);
  keys.forEach((k) => {
    const e = M.BARO_I18N_I[k];
    ['es', 'en', 'zh', 'pt'].forEach((l) => {
      assert(e && typeof e[l] === 'string' && e[l].trim().length > 0, k + ' sin ' + l);
    });
  });
});
tcase('i18n: traducciones clave difieren del ES', () => {
  const l = M.BARO_I18N_I['baro.tool.util.traducir.label'];
  assert(l.en !== l.es && l.zh !== l.es && l.pt !== l.es, 'label traducir sin traducir');
  const h = M.BARO_I18N_I['baro.tool.util.traducir.hueco'];
  assert(h.en !== h.es && h.zh !== h.es && h.pt !== h.es, 'hueco honesto sin traducir');
  const r = M.BARO_I18N_I['baro.tool.util.recordatorio.preview'];
  assert(r.en !== r.es && r.zh !== r.es && r.pt !== r.es, 'preview recordatorio sin traducir');
});
tcase('i18n: fusion en BARO_UI_I18N y APP_*_TEXT', () => {
  assert(sandbox.BARO_UI_I18N && sandbox.BARO_UI_I18N['baro.tool.util.resumir.label'], 'sin fusion en BARO_UI_I18N');
  assert(sandbox.APP_ENGLISH_TEXT['baro.tool.util.recordatorio.label'], 'sin fusion en APP_ENGLISH_TEXT');
  assert(sandbox.APP_CHINESE_TEXT['baro.tool.util.recordatorio.label'], 'sin fusion en APP_CHINESE_TEXT');
  assert(sandbox.APP_PORTUGUESE_TEXT['baro.tool.util.recordatorio.label'], 'sin fusion en APP_PORTUGUESE_TEXT');
});

/* ---------- 3. extracts puros ES/EN/ZH/PT ---------- */
tcase('extract traducir ES/EN/ZH/PT', () => {
  eqJ(P.baroIExtractTraducir('traduce este texto').texto, 'este texto', 'ES');
  eqJ(P.baroIExtractTraducir('translate this please').texto, 'this please', 'EN');
  eqJ(P.baroIExtractTraducir('翻译这段文字').texto, '这段文字', 'ZH');
  eqJ(P.baroIExtractTraducir('traduz este texto').texto, 'este texto', 'PT');
});
tcase('extract resumir: texto directo ES/EN/ZH/PT + topN', () => {
  const es = P.baroIExtractResumir('resume este texto: El sol brilla con fuerza en el cielo azul hoy.');
  assert(es && es.texto.indexOf('El sol brilla') === 0, 'ES texto directo');
  const en = P.baroIExtractResumir('summarize in 3 sentences: The sun is shining brightly over the quiet blue sea today.');
  assert(en && en.texto.indexOf('The sun') === 0, 'EN texto directo');
  eqJ(en.topN, 3, 'EN topN');
  const zh = P.baroIExtractResumir('用3句话总结：今天阳光明媚，海面平静，渔船陆续出海捕鱼了。');
  assert(zh && zh.texto.length > 10, 'ZH texto directo');
  eqJ(zh.topN, 3, 'ZH topN');
  const pt = P.baroIExtractResumir('resuma este texto: O sol brilha forte no céu azul e calmo de hoje.');
  assert(pt && pt.texto.indexOf('O sol brilha') === 0, 'PT texto directo');
});
tcase('extract resumir: declina hilos (los toma resumir_hilo)', () => {
  assert(P.baroIExtractResumir('resume el hilo de la receta de pan') === null, 'debió declinar ES');
  assert(P.baroIExtractResumir('summarize the thread about the trip') === null, 'debió declinar EN');
  assert(P.baroIExtractResumir('总结这个帖子的评论') === null, 'debió declinar ZH');
  // ...pero con marca extractiva sí lo toma
  const x = P.baroIExtractResumir('resume en 3 frases el hilo de la receta de pan');
  assert(x && x.topN === 3, 'marca extractiva no tomada');
});
tcase('extract recordatorio ES/EN/ZH/PT', () => {
  const NOW = new Date(2026, 8, 25, 10, 0, 0).getTime();
  const es = P.baroIExtractRecordatorio('recuérdame comprar pan mañana a las 8', NOW);
  eqJ(es.texto, 'comprar pan', 'ES texto');
  eqJ(es.at, new Date(2026, 8, 26, 8, 0, 0).getTime(), 'ES at');
  const en = P.baroIExtractRecordatorio('remind me to call mom in 2 hours', NOW);
  eqJ(en.texto, 'call mom', 'EN texto');
  eqJ(en.at, NOW + 2 * 3600 * 1000, 'EN at');
  const zh = P.baroIExtractRecordatorio('明天8点提醒我买面包', NOW);
  eqJ(zh.texto, '买面包', 'ZH texto');
  eqJ(zh.at, new Date(2026, 8, 26, 8, 0, 0).getTime(), 'ZH at');
  const pt = P.baroIExtractRecordatorio('lembra-me de comprar pão amanhã às 8', NOW);
  eqJ(pt.texto, 'comprar pão', 'PT texto');
  eqJ(pt.at, new Date(2026, 8, 26, 8, 0, 0).getTime(), 'PT at');
});
tcase('parseo de hora: bordes honestos', () => {
  const NOW = new Date(2026, 8, 25, 10, 0, 0).getTime();
  eqJ(P.baroIParseReminderTime('recuérdame X en 2 minutos', NOW).reason, 'too_soon', 'muy pronto');
  eqJ(P.baroIParseReminderTime('recuérdame X en 40 días', NOW).reason, 'too_far', 'muy lejos');
  eqJ(P.baroIParseReminderTime('recuérdame X hoy a las 8', NOW).reason, 'past', 'pasado');
  eqJ(P.baroIParseReminderTime('recuérdame algo', NOW).reason, 'no_time', 'sin fecha');
  const t = P.baroIParseReminderTime('recuérdame llamar a las 15:30', NOW);
  assert(t.ok === true, 'hora de hoy válida rechazada');
  eqJ(t.at, new Date(2026, 8, 25, 15, 30, 0).getTime(), 'hora de hoy');
  const t2 = P.baroIParseReminderTime('recuérdame llamar a las 8', NOW);
  eqJ(t2.at, new Date(2026, 8, 26, 8, 0, 0).getTime(), 'hora pasada -> mañana');
});

/* ---------- 4. resumen extractivo real ---------- */
tcase('extractivo: scoring determinista por posición+keywords', () => {
  const sum = P.baroIExtractiveSummary([{
    text: 'El volcán hizo erupción ayer. La erupción del volcán cubrió el pueblo de ceniza. ' +
          'Los vecinos huyeron. La erupción del volcán fue la mayor del siglo. Todo está tranquilo ahora.'
  }], 2);
  eqJ(sum.analyzed, 5, 'frases analizadas');
  eqJ(sum.sentences, [
    'El volcán hizo erupción ayer.',
    'La erupción del volcán cubrió el pueblo de ceniza.'
  ], 'top 2 por scoring');
});
tcase('extractivo: respeta orden original y votos de comentarios', () => {
  const sum = P.baroIExtractiveSummary([
    { text: 'Hoy hablo del clima en la ciudad.', votes: 0 },
    { text: 'El pronóstico anuncia lluvia toda la semana.', votes: 12 },
    { text: 'Adiós.', votes: 0 }
  ], 2);
  assert(sum.sentences.length === 2, 'debió devolver 2');
  assert(sum.sentences.some((s) => s.indexOf('lluvia') !== -1), 'el comentario votado debió entrar');
  assert(sum.sentences.indexOf('Adiós.') === -1, 'frase corta sin keywords no debió entrar');
});
tcase('extractivo: sin texto -> vacío honesto', () => {
  const sum = P.baroIExtractiveSummary([{ text: '   ' }], 5);
  eqJ(sum.sentences, [], 'sentences');
  eqJ(sum.analyzed, 0, 'analyzed');
});

/* ---------- 5. util_traducir: HUECO HONESTO ---------- */
tcase('traducir: mensaje honesto en ES, cero escrituras, cero red', async () => {
  setPlatform({});
  const before = JSON.stringify(draftsStore);
  const r = await T.util_traducir({ texto: 'hello world' }, makeCtx('me'));
  const html = String(r.html);
  assert(html.indexOf('No puedo traducir') !== -1, 'mensaje honesto ES ausente: ' + html);
  assert(html.indexOf('no voy a inventar una traducción') !== -1, 'anti-diccionario ausente');
  assert(html.indexOf('Traducciones') !== -1, 'guía a traducción automática ausente');
  assert(netCalls.length === 0, 'hubo llamadas de red: ' + JSON.stringify(netCalls));
  assert(JSON.stringify(draftsStore) === before, 'hubo escrituras');
  assert(confirmCalls.length === 0, 'no debe pedir confirmación');
});
tcase('traducir: honesto sin sesión también', async () => {
  setPlatform({});
  const r = await T.util_traducir({ texto: 'hello' }, makeCtx(null));
  assert(String(r.html).indexOf('No puedo traducir') !== -1, 'sin sesión debió responder honesto');
  assert(netCalls.length === 0, 'red sin sesión');
});
tcase('bloque: sin rastro de red ni diccionario de juguete', () => {
  // La cabecera DOCUMENTA la evidencia observada (p.ej. el endpoint real de
  // traducción de Drex) para justificar el hueco honesto: eso no es una
  // llamada. Se audita el código ejecutable, sin comentarios.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert(code.indexOf('translate.googleapis.com') === -1, 'endpoint de traducción en el código');
  assert(code.indexOf('fetch(') === -1, 'fetch en el código');
  assert(code.indexOf('XMLHttpRequest') === -1, 'XHR en el código');
  assert(!/https?:\/\//.test(code.replace(/drexcloud|firebaseio|#\/post/g, '')), 'URL externa en el código');
});

/* ---------- 6. util_resumir ---------- */
tcase('resumir texto directo: resumen real con conteos', async () => {
  setPlatform({});
  const r = await T.util_resumir({
    texto: 'El volcán hizo erupción ayer. La erupción del volcán cubrió el pueblo de ceniza. ' +
           'Los vecinos huyeron. La erupción del volcán fue la mayor del siglo. Todo está tranquilo ahora.',
    topN: 2
  }, makeCtx('me'));
  const html = String(r.html);
  assert(html.indexOf('Resumen') !== -1, 'título ausente');
  assert(html.indexOf('5 frases analizadas · 0 comentarios') !== -1, 'conteos reales ausentes: ' + html);
  assert(html.indexOf('El volcán hizo erupción ayer.') !== -1, 'frase top ausente');
  assert(html.indexOf('cubrió el pueblo de ceniza') !== -1, 'frase 2 ausente');
  assert(confirmCalls.length === 0, 'lectura no debe confirmar');
});
tcase('resumir post: lee BD real, pondera votos, enlaza el post', async () => {
  setPlatform({
    communityNotes: {
      post1: { content: 'Guía de la receta de pan casero paso a paso.', upvotes: 10, downvotes: 2 }
    },
    postComments: {
      post1: {
        c1: { text: 'La receta de pan salió perfecta con harina integral, la repetiré.', upvotes: 8, downvotes: 0 },
        c2: { text: 'ok', upvotes: 0, downvotes: 0 }
      }
    }
  });
  const r = await T.util_resumir({ postId: 'post1', topN: 3 }, makeCtx('me'));
  const html = String(r.html);
  assert(html.indexOf('2 comentarios') !== -1, 'conteo de comentarios ausente: ' + html);
  assert(html.indexOf('harina integral') !== -1, 'comentario votado ausente');
  assert(html.indexOf('#/post/post1') !== -1, 'enlace al post ausente');
  assert(html.indexOf('Ver el post') !== -1, 'cta ver post ausente');
});
tcase('resumir: sin postId y sin resolución -> mensaje honesto', async () => {
  setPlatform({});
  const r = await T.util_resumir({ rawText: 'resume algo' }, makeCtx('me'));
  assert(String(r.html).indexOf('Dime qué resumir') !== -1, 'sin_post ausente: ' + r.html);
});
tcase('resumir: usa baroResolveForTool cuando hay postId resuelto', async () => {
  setPlatform({
    communityNotes: { post9: { content: 'El mar estaba calmo y el cielo despejado durante toda la mañana de pesca.' } },
    postComments: { post9: {} }
  });
  resolveStub = { postId: 'post9' };
  const r = await T.util_resumir({ rawText: 'resume el post de pesca' }, makeCtx('me'));
  assert(String(r.html).indexOf('El mar estaba calmo') !== -1, 'no resumió el post resuelto: ' + r.html);
});
tcase('resumir: post inexistente -> honesto', async () => {
  setPlatform({});
  const r = await T.util_resumir({ postId: 'noexiste' }, makeCtx('me'));
  assert(String(r.html).indexOf('No encontré ese post') !== -1, 'not_found ausente');
});

/* ---------- 7. util_recordatorio ---------- */
tcase('recordatorio sin sesión: honesto, cero escrituras', async () => {
  setPlatform({});
  const before = JSON.stringify(draftsStore);
  const r = await T.util_recordatorio({ texto: 'comprar pan', at: Date.now() + 3600 * 1000 }, makeCtx(null));
  assert(String(r.html).indexOf('Inicia sesión') !== -1, 'need_login ausente');
  assert(confirmCalls.length === 0, 'confirmó sin sesión');
  assert(JSON.stringify(draftsStore) === before, 'hubo escrituras sin sesión');
});
tcase('recordatorio: pide confirmación con alcance honesto y al confirmar guarda el borrador', async () => {
  setPlatform({});
  const at = Date.now() + 2 * 3600 * 1000;
  const r = await T.util_recordatorio({ texto: 'comprar pan', at }, makeCtx('me'));
  assert(confirmCalls.length === 1, 'sin tarjeta de confirmación');
  const preview = String(confirmCalls[0].previewHtml);
  assert(preview.indexOf('publicación programada') !== -1, 'alcance honesto ausente en preview: ' + preview);
  assert(preview.indexOf('comprar pan') !== -1, 'texto ausente en preview');
  assert(draftsStore.length === 0, 'escribió antes de confirmar');
  assert(String(r.html).indexOf('Revisa y toca Confirmar') !== -1, 'revisar ausente');
  await confirmCalls[0].onConfirm();
  assert(draftsStore.length === 1, 'no guardó el borrador');
  const d = draftsStore[0];
  assert(d.content === 'comprar pan', 'contenido del borrador');
  assert(d.publishAt === at, 'publishAt del borrador');
  assert(d.baroReminder === true && d.baroScheduled === true, 'marcas baro ausentes');
  assert(d.scheduledPublishing === false, 'flag scheduledPublishing');
  assert(said.some((m) => m.indexOf('se publicará el') !== -1), 'mensaje ok ausente: ' + JSON.stringify(said));
});
tcase('recordatorio: parsea fecha del rawText en ES', async () => {
  setPlatform({});
  const r = await T.util_recordatorio({ rawText: 'recuérdame comprar pan mañana a las 8' }, makeCtx('me'));
  assert(confirmCalls.length === 1, 'sin confirmación');
  const preview = String(confirmCalls[0].previewHtml);
  assert(preview.indexOf('comprar pan') !== -1, 'texto parseado ausente: ' + preview);
  await confirmCalls[0].onConfirm();
  assert(draftsStore.length === 1 && draftsStore[0].content === 'comprar pan', 'borrador no guardado');
  const exp = new Date(); exp.setDate(exp.getDate() + 1); exp.setHours(8, 0, 0, 0);
  assert(Math.abs(draftsStore[0].publishAt - exp.getTime()) < 60000, 'publishAt no es mañana 8:00');
});
tcase('recordatorio: tiempos inválidos -> honesto sin confirmar', async () => {
  setPlatform({});
  const casos = [
    [{ rawText: 'recuérdame algo' }, 'No entendí la fecha'],
    [{ rawText: 'recuérdame X en 2 minutos' }, '5 minutos'],
    [{ rawText: 'recuérdame X en 40 días' }, '30 días'],
    [{ texto: 'llamar', at: Date.now() - 1000 }, 'ya pasó']
  ];
  for (const [args, frag] of casos) {
    const r = await T.util_recordatorio(args, makeCtx('me'));
    assert(String(r.html).indexOf(frag) !== -1, 'mensaje honesto ausente para ' + JSON.stringify(args) + ': ' + r.html);
  }
  assert(confirmCalls.length === 0, 'confirmó con tiempo inválido');
  assert(draftsStore.length === 0, 'escribió con tiempo inválido');
});
tcase('recordatorio: sin texto -> pide qué recordar', async () => {
  setPlatform({});
  const r = await T.util_recordatorio({}, makeCtx('me'));
  assert(String(r.html).indexOf('Dime qué quieres recordar') !== -1, 'sin_texto ausente');
  assert(confirmCalls.length === 0, 'confirmó sin texto');
});

/* ---------- 8. prohibiciones del carril ---------- */
tcase('bloque: sin Series, sin giveaway, sin emoji en iconos', () => {
  // La cabecera documenta las prohibiciones ("Sin Series", "Sin giveaway"):
  // se audita el código ejecutable, sin comentarios.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert(!/\bseries\b/i.test(code), 'mención a Series en el código');
  assert(!/giveaway/i.test(code), 'mención a giveaway en el código');
  Object.keys(sandbox.BARO_ICONS).filter((k) => k.indexOf('util-') === 0).forEach((k) => {
    assert(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(sandbox.BARO_ICONS[k]), 'emoji en icono ' + k);
  });
});

/* ---------- runner ---------- */
(async () => {
  for (const [name, fn] of CASES) {
    try {
      await fn();
      oks++;
      console.log('ok   ' + name);
    } catch (e) {
      fails++;
      console.log('FAIL ' + name + ' :: ' + e.message);
    }
  }
  console.log('----');
  console.log('c118-baro-utilidades: ' + oks + ' ok, ' + fails + ' fallos, ' + CASES.length + ' casos');
  process.exit(fails ? 1 : 0);
})();
