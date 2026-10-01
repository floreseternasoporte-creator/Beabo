'use strict';
// Tests de Lane 1 — Baro inteligencia (cerebro profesional).
// Cubre: scoring con contexto + calibración (3), follow-ups conversacionales (4),
// re-rank/desambiguación contextual (2), follow-ups sugeridos (3),
// nuevos intents resumir/recordar/redactar/traducir/explicar (6),
// KB de la app + fallback (4), i18n ES/EN/ZH/PT (2), tools registradas (5),
// ausencia del literal de cierre de script (1).
//
// Construye un composite en memoria: index.html del repo + bloques de la lane
// insertados en el ancla (dentro del IIFE 6b, antes de "exposición global").
// Extrae la región 6b (patrón c121/c122) y la carga con vm en sandbox.
// Uso: node tests/test-c220-baro-inteligencia.js [--target <ruta-a-index.html>]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LANE_DIR = path.join(__dirname, '..');
const BLOCKS = [
  'l1-g-i18n.js', 'l1-a-context-scoring.js', 'l1-h-rich.js', 'l1-f-kb.js',
  'l1-e-intents.js', 'l1-b-followups.js', 'l1-c-disambiguation.js', 'l1-d-suggest.js'
];
const ANCHOR = '/* ---------- exposición global ---------- */';
/* Post-integración: el CI corre desde la raíz del repo, donde los bloques ya
 * viven dentro de index.html y no existe el directorio blocks/ de la lane. */
const BLOCKS_MISSING = BLOCKS.some(f => !fs.existsSync(path.join(LANE_DIR, 'blocks', f)));

const argv = process.argv.slice(2);
let target = null;
const ti = argv.indexOf('--target');
if (ti !== -1 && argv[ti + 1]) target = argv[ti + 1];
if (!target) {
  const cands = [
    path.join(process.env.HOME || '/home/hatch', 'workspace', 'beabo', 'index.html'),
    'index.html'
  ];
  target = cands.find(p => fs.existsSync(p)) || null;
}
if (!target) { console.error('FALLO: no existe el target'); process.exit(2); }

function buildComposite(t) {
  const html = fs.readFileSync(t, 'utf8');
  /* Adaptación del integrador (2026-09-30): en el repo los bloques ya están
   * integrados en index.html; si el directorio blocks/ no existe, el target
   * se usa tal cual (los bloques ya viven dentro de la región 6b). */
  if (BLOCKS_MISSING) return html;
  const ai = html.indexOf(ANCHOR);
  if (ai === -1) throw new Error('ancla de inserción ausente en el target');
  const blocks = BLOCKS.map(f => {
    return fs.readFileSync(path.join(LANE_DIR, 'blocks', f), 'utf8');
  }).join('\n');
  return html.slice(0, ai) + blocks + '\n' + html.slice(ai);
}
function extract6b(html) {
  const START = '/* ================= BARO · sub-bloque 6b';
  const END = '/* ================= BARO · integración: enlaces';
  const si = html.indexOf(START);
  if (si === -1) throw new Error('marcador de inicio 6b ausente');
  const ei = html.indexOf('\n' + END, si);
  if (ei === -1 || ei <= si) throw new Error('marcador de fin ausente');
  return html.slice(si, ei);
}
const src = extract6b(buildComposite(target));

let fails = 0, oks = 0;
const CASES = [];
function tcase(name, fn) { CASES.push([name, fn]); }
function assert(cond, label) { if (!cond) throw new Error('assert: ' + label); }
function eqJ(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(label + ' esperado=' + e + ' actual=' + a);
}

/* ---------- 0. sin literal de cierre de script ---------- */
tcase('bloques y test sin literal de cierre de script', () => {
  let blockSources;
  if (BLOCKS_MISSING) {
    /* Post-integración: los bloques se extraen de los marcadores en el target. */
    const html = fs.readFileSync(target, 'utf8');
    const a = html.indexOf('LANE 1 (C220 inteligencia) — INICIO');
    const b = html.indexOf('LANE 1 (C220 inteligencia) — FIN');
    assert(a !== -1 && b !== -1 && b > a, 'bloques lane1 integrados en el target');
    blockSources = [html.slice(a, b)];
  } else {
    blockSources = BLOCKS.map(f => fs.readFileSync(path.join(LANE_DIR, 'blocks', f), 'utf8'));
  }
  blockSources.forEach((b, i) => {
    assert(b.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en bloque ' + i);
  });
  const tsrc = fs.readFileSync(__filename, 'utf8');
  assert(tsrc.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en el test');
});

/* ---------- sandbox + carga ---------- */
const __ls = {};
const userSaid = [], baroSaid = [], registered = {};
const sandbox = {
  console,
  window: {},
  APP_ENGLISH_TEXT: {}, APP_CHINESE_TEXT: {}, APP_PORTUGUESE_TEXT: {},
  baroTools: {},
  baroRegisterTool: function (n, d) { registered[n] = d; },
  baroAddUserMessage: function (t) { userSaid.push(String(t)); return null; },
  baroAddBaroMessage: function (h) { baroSaid.push(String(h)); return null; },
  baroMakeV2Ctx: function () {
    return {
      user: { uid: 'test-user' },
      t: function (k) { return String(k); },
      esc: function (s) { return String(s == null ? '' : s); },
      step: function () { return 'st'; },
      stepDone: function () {}
    };
  },
  baroV2FlowStepKey: function () { return 'baro.v2.step.working'; },
  baroResolvePostTarget: async function () { return { status: 'resolved', postId: 'ORIGINAL' }; },
  localStorage: {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(__ls, k) ? __ls[k] : null; },
    setItem: function (k, v) { __ls[k] = String(v); },
    removeItem: function (k) { delete __ls[k]; }
  }
};
sandbox.baro6dExpose = function (n, f) { sandbox.window[n] = f; };
sandbox.window.APP_ENGLISH_TEXT = sandbox.APP_ENGLISH_TEXT;
sandbox.window.APP_CHINESE_TEXT = sandbox.APP_CHINESE_TEXT;
sandbox.window.APP_PORTUGUESE_TEXT = sandbox.APP_PORTUGUESE_TEXT;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'block-6b-lane1.js' });
const api = sandbox.window.baroBrain;
assert(api && typeof api === 'object', 'seam window.baroBrain ausente');
assert(api.__l1Extended === true, 'la lane no extendió el seam (l1-d no cargó)');
const TCTX = { t: function (k) { return String(k); }, esc: function (s) { return String(s == null ? '' : s); }, lang: 'es' };

/* ---------- 1-3. scoring con contexto + calibración ---------- */
tcase('contexto: el turno queda registrado en el seam', () => {
  const d = api.detect('busca gatitos');
  assert(d.intent === 'preguntar', 'intent esperado preguntar, fue ' + d.intent);
  const turns = api.ctxTurns();
  assert(turns.length >= 1 && turns[0].intent === 'preguntar', 'turno no registrado');
});
tcase('contexto: boost conversacional visible en scoreAll (sig.ctx)', () => {
  api.detect('busca gatitos');
  const all = api.scoreAll('busca perritos');
  const p = all.find(function (e) { return e.rule.intent === 'preguntar'; });
  assert(p, 'preguntar ausente en scoreAll');
  assert(p.sig && p.sig.ctx === 0.5, 'boost esperado 0.5, sig=' + JSON.stringify(p.sig));
});
tcase('calibración: confianza reescalada pero sobre el umbral', () => {
  const d = api.detect('bsucar gatitos');
  assert(d.intent === 'preguntar', 'intent fue ' + d.intent);
  assert(d.confidence >= 0.35 && d.confidence < 1, 'conf fuera de rango: ' + d.confidence);
});

/* ---------- 4-7. follow-ups conversacionales ---------- */
tcase('follow-up: "cuéntame más" repite la intención anterior', () => {
  api.detect('busca recetas de pan');
  const d = api.detect('cuéntame más');
  assert(d.intent === 'preguntar', 'intent fue ' + d.intent);
  assert(d.l1followup === 'more', 'marcador l1followup ausente');
});
tcase('follow-up: "el segundo" tras buscar resuelve a resumir_hilo con referencia', () => {
  api.memGet().posts.push({ id: 'p1' }, { id: 'p2' });
  api.detect('busca recetas de pan');
  const d = api.detect('el segundo');
  assert(d.intent === 'resumir_hilo', 'intent fue ' + d.intent);
  assert(d.args && d.args.targetDesc === 'el segundo', 'targetDesc=' + JSON.stringify(d.args));
});
tcase('follow-up: "ese" demostrativo también resuelve', () => {
  api.detect('busca recetas de pan');
  const d = api.detect('ese');
  assert(d.intent === 'resumir_hilo', 'intent fue ' + d.intent);
});
tcase('follow-up: sin turno previo no intercepta ("cuéntame más" solo)', () => {
  api.ctxClear();
  const f = api.followup('cuéntame más');
  assert(f === null, 'sin historial debería ser null, fue ' + JSON.stringify(f && f.intent));
});

/* ---------- 8-9. re-rank / desambiguación contextual ---------- */
tcase('re-rank: sin contexto previo el clarify mantiene el orden original', () => {
  api.ctxClear();
  const d = api.detect('zzz qqq xxx');
  assert(d.intent === 'ayuda' && d.args && d.args.clarify, 'se esperaba clarify');
  assert(d.args.candidates[0] === 'preguntar', 'candidates[0]=' + d.args.candidates[0]);
  assert(!d.args.intelCtx, 'intelCtx no debería estar activo');
});
tcase('re-rank: con contexto, el intent previo sube al frente del clarify', () => {
  api.ctxClear();
  api.detect('publica: hola mundo');
  const d = api.detect('zzz qqq xxx');
  assert(d.intent === 'ayuda' && d.args && d.args.clarify, 'se esperaba clarify');
  assert(d.args.candidates[0] === 'publicar', 'candidates[0]=' + d.args.candidates[0]);
  assert(d.args.intelCtx === true, 'intelCtx debería estar activo');
});

/* ---------- 10-12. follow-ups sugeridos ---------- */
tcase('suggest: publicar devuelve 2-3 items con labelKey y cmd', () => {
  const s = api.suggest('publicar');
  assert(Array.isArray(s) && s.length >= 2 && s.length <= 3, 'longitud=' + s.length);
  for (const it of s) {
    assert(typeof it.labelKey === 'string' && typeof it.cmd === 'string', 'forma inválida');
  }
});
tcase('suggest: explicar con feature resuelve cmd dinámico', () => {
  const s = api.suggest('explicar', { feature: 'ondas' });
  assert(s[0].cmd === 'busca ondas', 'cmd=' + s[0].cmd);
});
tcase('suggest: todas las labelKey existen en i18n ES/EN/ZH/PT', () => {
  const keys = {};
  const table = api.suggestTable;
  for (const k in table) table[k].forEach(function (p) { keys[p[0]] = 1; });
  keys['baro.suggest.probar_busqueda'] = 1;
  keys['baro.suggest.ver_ayuda'] = 1;
  for (const k in keys) {
    const e = api.i18n[k];
    assert(e, 'clave i18n ausente: ' + k);
    for (const L of ['es', 'en', 'zh', 'pt']) {
      assert(typeof e[L] === 'string' && e[L].length > 0, 'sin ' + L + ' en ' + k);
    }
  }
});

/* ---------- 13-18. nuevos intents ---------- */
tcase('intent resumir: /resumir con texto', () => {
  const d = api.detect('/resumir este texto: los gatos duermen mucho');
  assert(d.intent === 'resumir', 'intent fue ' + d.intent);
  assert(d.args && d.args.texto, 'sin texto en args');
});
tcase('intent recordar: fecha parseada del mismo mensaje', () => {
  const d = api.detect('/recordar comprar pan mañana a las 9');
  assert(d.intent === 'recordar', 'intent fue ' + d.intent);
  assert(d.args && d.args.accion === 'add', 'accion=' + JSON.stringify(d.args));
  assert(typeof d.args.cuando === 'number', 'cuando no parseado');
  assert(/pan/.test(d.args.texto), 'texto=' + d.args.texto);
});
tcase('intent redactar: tema extraído', () => {
  const d = api.detect('/redactar un post sobre el mar');
  assert(d.intent === 'redactar', 'intent fue ' + d.intent);
  assert(d.args && /mar/.test(d.args.tema), 'tema=' + JSON.stringify(d.args));
});
tcase('intent traducir: texto y target', () => {
  const d = api.detect('/traducir hello al ingles');
  assert(d.intent === 'traducir', 'intent fue ' + d.intent);
  assert(d.args && d.args.texto === 'hello' && d.args.target === 'en',
    'args=' + JSON.stringify(d.args));
});
tcase('intent explicar: "cómo publico una foto" -> KB foto', () => {
  const d = api.detect('cómo publico una foto');
  assert(d.intent === 'explicar', 'intent fue ' + d.intent);
  assert(d.args && d.args.kb === 'foto', 'kb=' + JSON.stringify(d.args));
});
tcase('intent explicar: "qué son las ondas" -> KB ondas', () => {
  const d = api.detect('qué son las ondas');
  assert(d.intent === 'explicar', 'intent fue ' + d.intent);
  assert(d.args && d.args.kb === 'ondas', 'kb=' + JSON.stringify(d.args));
});

/* ---------- 19-22. KB + fallback + ayuda ---------- */
tcase('kbMatch: coincidencias y nulos', () => {
  assert(api.kbMatch('dónde están las ondas') === 'ondas', 'ondas');
  assert(api.kbMatch('cómo configuro los ajustes') === 'ajustes', 'ajustes');
  assert(api.kbMatch('zzz qqq xxx') === null, 'debería ser null');
});
tcase('KB fallback: "háblame de las ondas" explica en vez de rendirse', () => {
  const d = api.detect('háblame de las ondas');
  assert(d.intent === 'explicar', 'intent fue ' + d.intent);
  assert(d.args && d.args.kb === 'ondas' && d.args.viaKb === true, 'args=' + JSON.stringify(d.args));
});
tcase('KB fallback: gibberish sigue rindiéndose al clarify', () => {
  const d = api.detect('zzz qqq xxx');
  assert(d.intent === 'ayuda' && d.args && d.args.clarify, 'se esperaba clarify');
});
tcase('ayuda con tema: "ayuda con las ondas" -> explicar', () => {
  const d = api.detect('ayuda con las ondas');
  assert(d.intent === 'explicar', 'intent fue ' + d.intent);
  assert(d.args && d.args.kb === 'ondas', 'kb=' + JSON.stringify(d.args));
});

/* ---------- 23-27. tools registradas (el wrapper 8M-B las vuelve async) ---------- */
tcase('tool resumir_texto: resume texto libre', async () => {
  const t = registered['resumir_texto'];
  assert(t, 'tool no registrada');
  const txt = 'El café es una bebida popular. Se cultiva en regiones tropicales de todo el mundo. ' +
    'Brasil es el mayor productor mundial de café. El café contiene cafeína, un estimulante natural. ' +
    'Millones de personas lo toman cada mañana. Su comercio mueve miles de millones al año.';
  const h = String(await t.run({ texto: txt }, TCTX));
  assert(h.indexOf('baro-tool-card') !== -1, 'sin tarjeta');
  assert(h.indexOf('<li>') !== -1, 'sin puntos');
});
tcase('tool recordatorios: alta, listado y persistencia', async () => {
  const t = registered['recordatorios'];
  assert(t, 'tool no registrada');
  const h1 = String(await t.run({ accion: 'add', texto: 'comprar pan' }, TCTX));
  assert(h1.indexOf('comprar pan') !== -1, 'alta sin texto');
  const h2 = String(await t.run({ accion: 'list' }, TCTX));
  assert(h2.indexOf('comprar pan') !== -1, 'listado sin el item');
  assert((__ls['baro_reminders_v1'] || '').indexOf('comprar pan') !== -1, 'sin persistencia');
});
tcase('tool recordatorios: fecha pendiente se completa con el siguiente mensaje', async () => {
  const t = registered['recordatorios'];
  await t.run({ accion: 'add', texto: 'llamar al banco' }, TCTX);
  const d = api.detect('mañana a las 9');
  assert(d.intent === 'recordar', 'intent fue ' + d.intent);
  assert(d.args && d.args.accion === 'when' && typeof d.args.cuando === 'number',
    'args=' + JSON.stringify(d.args));
});
tcase('tool traducir: frase conocida y frase desconocida honesta', async () => {
  const t = registered['traducir'];
  assert(t, 'tool no registrada');
  const h1 = String(await t.run({ texto: 'hello', target: 'es' }, TCTX));
  assert(h1.indexOf('hola') !== -1, 'sin traducción: ' + h1.slice(0, 120));
  const h2 = String(await t.run({ texto: 'supercalifragilistico', target: 'es' }, TCTX));
  assert(h2.toLowerCase().indexOf('diccionario') !== -1, 'debería admitir el límite');
});
tcase('tool explicar: tarjeta con pasos y deep-link verificado', async () => {
  const t = registered['explicar'];
  assert(t, 'tool no registrada');
  const h = String(await t.run({ kb: 'ondas' }, TCTX));
  assert(h.indexOf('baro-steps') !== -1, 'sin pasos');
  assert(h.indexOf("baroKbGo('ondas')") !== -1, 'sin deep-link verificado');
});
tcase('tool redactar: borrador honesto con botón de uso', async () => {
  const t = registered['redactar'];
  assert(t, 'tool no registrada');
  const h = String(await t.run({ tema: 'el mar' }, TCTX));
  assert(h.indexOf('baroRedactarUsar(') !== -1, 'sin botón de uso');
  assert(h.toLowerCase().indexOf('borrador') !== -1 || h.toLowerCase().indexOf('draft') !== -1,
    'sin etiqueta honesta');
});

/* ---------- 28. regresión puntual: 'resume' no lo roba el nuevo intent ---------- */
tcase('regresión: "resume" sigue cayendo al clarify con resumir_hilo al frente', () => {
  const d = api.detect('resume');
  assert(d.intent === 'ayuda' && d.args && d.args.clarify, 'se esperaba clarify');
  assert(d.args.candidates[0] === 'resumir_hilo', 'candidates[0]=' + d.args.candidates[0]);
});

/* ---------- runner ---------- */
(async function () {
  for (const [name, fn] of CASES) {
    try { await fn(); oks++; }
    catch (e) { fails++; console.error('FALLO [' + name + ']: ' + e.message); }
  }
  console.log('c220: ' + oks + ' ok, ' + fails + ' fallos (' + CASES.length + ' casos)');
  process.exit(fails ? 1 : 0);
})();
