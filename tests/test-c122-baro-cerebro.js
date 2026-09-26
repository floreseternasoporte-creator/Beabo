'use strict';
// Tests del carril 8M-D (BARO v4 — "cerebro": router, memoria, multi-acción).
// Cubre: baroBrainTie puro (5), integración detect+tie (2), pickTie/forzado (4),
// memoria conversacional + wrapper de baroResolvePostTarget (6),
// baroBrainSplit (3), baroBrainRunMulti + chain prefill (3),
// i18n ES/EN/ZH/PT (2) y ausencia del literal de cierre de script (1).
//
// La región se EXTRAE del HTML (patrón c121): desde
// '/* ================= BARO · sub-bloque 6b' hasta
// '/* ================= BARO · integración: enlaces' (así incluye el 8M
// insertado justo antes de la exposición global). Carga con vm en sandbox.
// Uso: node test-c122-baro-cerebro.js [--target <ruta-a-index.html>]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DEFAULT_TARGET = '/tmp/baro8m/index-8m.html';
const argv = process.argv.slice(2);
let target = DEFAULT_TARGET;
const ti = argv.indexOf('--target');
if (ti !== -1 && argv[ti + 1]) target = argv[ti + 1];
else if (!fs.existsSync(target)) {
  // CI-safe como c119: si el scratch no existe, el integrado.
  const alt = path.join(__dirname, '..', 'index.html');
  target = fs.existsSync(alt) ? alt
    : path.join(process.env.HOME || '/home/hatch', 'workspace', 'beabo', 'index.html');
}
if (!fs.existsSync(target)) { console.error('FALLO: no existe el target: ' + target); process.exit(2); }

function extract6b(html) {
  const START = '/* ================= BARO · sub-bloque 6b';
  const END = '/* ================= BARO · integración: enlaces';
  const si = html.indexOf(START);
  if (si === -1) throw new Error('marcador de inicio 6b ausente en el target');
  const ei = html.indexOf(END, si);
  if (ei === -1 || ei <= si) throw new Error('marcador de fin (integración: enlaces) ausente');
  return html.slice(si, ei);
}
const html = fs.readFileSync(target, 'utf8');
const src = extract6b(html);

let fails = 0, oks = 0;
const CASES = [];
function tcase(name, fn) { CASES.push([name, fn]); }
function assert(cond, label) { if (!cond) throw new Error('assert: ' + label); }
function eqJ(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(label + ' esperado=' + e + ' actual=' + a);
}

/* ---------- 0. sin literal de cierre de script ---------- */
tcase('bloque y test sin literal de cierre de script', () => {
  assert(src.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en el bloque extraido (6b+8M)');
  const tsrc = fs.readFileSync(__filename, 'utf8');
  assert(tsrc.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en test-c122-baro-cerebro.js');
});

/* ---------- sandbox + carga ---------- */
const userSaid = [], baroSaid = [], stepCalls = [], rptCalls = [], registered = {};
const sandbox = {
  console,
  window: {},
  APP_ENGLISH_TEXT: {},
  APP_CHINESE_TEXT: {},
  APP_PORTUGUESE_TEXT: {},
  baroTools: {},
  baroRegisterTool: function (n, d) { registered[n] = d; },
  baroAddUserMessage: function (t) { userSaid.push(String(t)); return null; },
  baroAddBaroMessage: function (h) { baroSaid.push(String(h)); return null; },
  // NOTA: el handler 6b llama baroMakeV2Ctx() y baroV2FlowStepKey() SIN guard;
  // son globales reales del base (líneas 53388 y 53411). Réplicas fieles aquí.
  baroMakeV2Ctx: function () {
    return {
      user: { uid: 'test-user' },
      t: function (k) { return String(k); },
      esc: function (s) { return String(s == null ? '' : s); },
      step: function (k) { stepCalls.push(String(k)); return 'st' + stepCalls.length; },
      stepDone: function () {}
    };
  },
  baroV2FlowStepKey: function (phase, intent) {
    if (phase === 'detect') return 'baro.intent.step.detect';
    if (phase === 'help') return 'baro.intent.step.help';
    if (phase === 'login') return 'baro.intent.step.login_required';
    if (phase === 'tool') return 'baro.intent.step.' + String(intent == null ? '' : intent);
    return 'baro.v2.step.working';
  },
  // baroResolvePostTarget existe en el base (script-level, línea 55247): el
  // wiring B lo envuelve. Stub que REGISTRA llamadas para verificar
  // delegación/no-llamada.
  baroResolvePostTarget: async function (desc) {
    rptCalls.push(String(desc));
    return { status: 'resolved', postId: 'ORIGINAL' };
  }
};
sandbox.baro6dExpose = function (n, f) { sandbox.window[n] = f; };
/* En producción APP_*_TEXT son props de window (var de script clásico); el
 * fuse del carril A los lee vía window. Se replican aquí. */
sandbox.window.APP_ENGLISH_TEXT = sandbox.APP_ENGLISH_TEXT;
sandbox.window.APP_CHINESE_TEXT = sandbox.APP_CHINESE_TEXT;
sandbox.window.APP_PORTUGUESE_TEXT = sandbox.APP_PORTUGUESE_TEXT;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'block-6b-8m.js' });
const api = sandbox.window.baroBrain;
assert(api && typeof api === 'object',
  'seam window.baroBrain ausente: el sub-bloque 8M no está insertado en el target');

/* Reglas sintéticas (patrones STRING: sin problemas de realm con RegExp). */
function pushRule(intent, patternStr) {
  vm.runInContext(
    'window.baroIntentRules.push({intent:' + JSON.stringify(intent) +
    ',patterns:[' + JSON.stringify(patternStr) + '],langs:["es"],' +
    'extract:function(t){return {q:String(t)};}});',
    sandbox);
}

/* ---------- 1-5. baroBrainTie puro ---------- */
tcase('tie: empate exacto -> candidates con los 3 intents', () => {
  const r = api.tie([
    { rule: { intent: 'a' }, score: 5 },
    { rule: { intent: 'b' }, score: 5 },
    { rule: { intent: 'c' }, score: 4 }
  ]);
  eqJ(r, { candidates: ['a', 'b', 'c'] }, 'empate exacto');
});
tcase('tie: diferencia > EPS -> null', () => {
  eqJ(api.tie([
    { rule: { intent: 'a' }, score: 10 },
    { rule: { intent: 'b' }, score: 5 }
  ]), null, 'dif 5 > EPS(1)');
});
tcase('tie: mismo intent en top-2 -> null', () => {
  eqJ(api.tie([
    { rule: { intent: 'a' }, score: 5 },
    { rule: { intent: 'a' }, score: 5 }
  ]), null, 'mismo intent no es ambigüedad');
});
tcase('tie: segundo score 0 -> null', () => {
  eqJ(api.tie([
    { rule: { intent: 'a' }, score: 5 },
    { rule: { intent: 'b' }, score: 0 }
  ]), null, 'sin señal en el segundo');
});
tcase('tie: top score 0 -> null', () => {
  eqJ(api.tie([
    { rule: { intent: 'a' }, score: 0 },
    { rule: { intent: 'b' }, score: 0 }
  ]), null, 'sin señal');
});

/* ---------- 6-7. integración detect + tie ---------- */
pushRule('zz_intenta', 'alfabravo');
pushRule('zz_intentb', 'alfabravo');
pushRule('zz_claro', 'clarisimo');

tcase('detect: empate real -> ayuda con args.tie y candidates', () => {
  const det = api.detect('alfabravo');
  assert(det && det.intent === 'ayuda', 'debe caer a ayuda, fue: ' + (det && det.intent));
  assert(det.args && det.args.tie === true, 'args.tie debe ser true');
  eqJ(det.args.candidates, ['zz_intenta', 'zz_intentb'], 'candidates');
  assert(det.args.rawText === 'alfabravo', 'rawText preservado');
  assert(det.args.clarify === true, 'clarify true');
});
tcase('detect: ganador claro -> pasa el intent original sin tie', () => {
  const det = api.detect('clarisimo');
  assert(det && det.intent === 'zz_claro', 'debe pasar zz_claro, fue: ' + (det && det.intent));
  assert(!(det.args && det.args.tie), 'no debe traer tie');
});

/* ---------- 8-11. pickTie / forzado ---------- */
tcase('pickTie: intent inválido no setea forzado', () => {
  api.memClear();
  api.pickTie('foo;bar', encodeURIComponent('x'));
  assert(api.peekForced() == null, 'forzado debe seguir null');
});
/* pickTie llama a baroHandleUserMessage SIN await: el pipeline consume el
 * forzado en el mismo tick. Con texto vacío el handler retorna temprano
 * (sin detectar), así el forzado queda observable para peek/detect. */
tcase('pickTie: válido -> peekForced() con intent y texto', () => {
  api.pickTie('zz_intenta', '');
  const f = api.peekForced();
  assert(f && f.intent === 'zz_intenta', 'intent forzado');
  assert(f.text === '', 'texto vacío preservado');
});
tcase('detect consume el forzado -> {intent, confidence:1} y lo limpia', () => {
  const det = api.detect('lo que sea');
  eqJ(det.intent, 'zz_intenta', 'intent forzado');
  eqJ(det.confidence, 1, 'confianza 1');
  assert(api.peekForced() == null, 'forzado consumido');
});
tcase('e2e: pickTie con texto atraviesa el pipeline y llama al tool fake', async () => {
  let fakeCalls = 0, fakeArgs = null;
  sandbox.baroTools['buscar_profundo'] = {
    run: async function (args, ctx) { fakeCalls++; fakeArgs = args; return { html: '<p>ok</p>' }; }
  };
  sandbox.window.baroIntentToTool['preguntar'] = 'buscar_profundo';
  pushRule('zz_preg_e2e', 'preguntae2e');
  sandbox.window.baroBrainPickTie('preguntar', encodeURIComponent('preguntae2e hola'));
  await new Promise((r) => setTimeout(r, 80));
  assert(fakeCalls === 1, 'el fake run debió llamarse 1 vez, fue: ' + fakeCalls);
  assert(fakeArgs && typeof fakeArgs === 'object', 'args pasados al tool');
});

/* ---------- 12-17. memoria ---------- */
function seedMem3() {
  api.memClear();
  api.recordResult('buscar', {}, { data: { posts: [
    { id: 'id1', content: 't1' },
    { id: 'id2', content: 't2' },
    { id: 'id3', content: 't3' }
  ] } });
  return api.memGet();
}
tcase('memoria: recordResult guarda posts y resolveRef("el segundo") -> id2', () => {
  const mem = seedMem3();
  assert(mem.posts.length === 3, '3 posts en memoria');
  eqJ(api.resolveRef('el segundo', mem), { postId: 'id2' }, 'el segundo');
});
tcase('memoria: "" -> el más reciente', () => {
  const mem = seedMem3(); // unshift: [id3,id2,id1]
  eqJ(api.resolveRef('', mem), { postId: 'id3' }, 'vacío = reciente');
});
tcase('memoria: "el de ayer" -> post de ayer (ts fijo)', () => {
  const noon = (off) => { const d = new Date(); d.setDate(d.getDate() + off); d.setHours(12, 0, 0, 0); return d.getTime(); };
  const mem = { posts: [
    { id: 'hoy1', title: 'h', ts: noon(0) },
    { id: 'ayer1', title: 'a', ts: noon(-1) }
  ], actions: [] };
  eqJ(api.resolveRef('el de ayer', mem), { postId: 'ayer1' }, 'ayer');
  eqJ(api.resolveRef('el de hoy', mem), { postId: 'hoy1' }, 'hoy');
});
tcase('memoria: ordinal fuera de rango -> null', () => {
  const mem = { posts: [{ id: 'solo', title: 's', ts: Date.now() }], actions: [] };
  eqJ(api.resolveRef('el quinto', mem), null, 'quinto sin 5 posts');
});
tcase('memoria: texto libre -> null (delega al original)', () => {
  const mem = seedMem3();
  eqJ(api.resolveRef('hola mundo', mem), null, 'sin referencia');
});
tcase('wrapper resolvePostTarget: con referencia NO llama al original; sin referencia delega', async () => {
  seedMem3(); // posts [id3,id2,id1]
  rptCalls.length = 0;
  const wrapped = sandbox.baroResolvePostTarget;
  assert(typeof wrapped === 'function', 'el wrapper B debe estar instalado');
  const r1 = await wrapped('borra el segundo');
  eqJ(r1, { status: 'resolved', postId: 'id2' }, 'referencia resuelta por memoria');
  assert(rptCalls.length === 0, 'el original NO debió llamarse');
  const r2 = await wrapped('hola mundo');
  eqJ(r2, { status: 'resolved', postId: 'ORIGINAL' }, 'delega al original');
  assert(rptCalls.length === 1 && rptCalls[0] === 'hola mundo', 'el original se llamó 1 vez');
});

/* ---------- 18-20. split ---------- */
/* zz_a/zz_b usan patrones DISTINTOS a 'alfabravo' para no contaminar el tie. */
pushRule('zz_a', 'kappagamma');
pushRule('zz_b', 'deltazeta');
tcase('split: "kappagamma y deltazeta" -> 2 segmentos', () => {
  const segs = api.split('kappagamma y deltazeta');
  assert(Array.isArray(segs) && segs.length === 2, '2 segmentos, fue: ' + JSON.stringify(segs));
  eqJ(segs.map((s) => s.text), ['kappagamma', 'deltazeta'], 'textos');
});
tcase('split: "hola" -> null', () => {
  eqJ(api.split('hola'), null, 'un segmento no es multi');
});
tcase('split: 3 acciones -> 3 segmentos', () => {
  const segs = api.split('kappagamma y deltazeta y clarisimo');
  assert(Array.isArray(segs) && segs.length === 3, '3 segmentos, fue: ' + JSON.stringify(segs));
});

/* ---------- 21-23. runMulti + chain prefill ---------- */
tcase('runMulti: ejecuta tools fake en orden', async () => {
  const order = [];
  sandbox.baroTools['zz_tool_a'] = { run: async function () { order.push('a'); return { html: '<p>A</p>' }; } };
  sandbox.baroTools['zz_tool_b'] = { run: async function () { order.push('b'); return { html: '<p>B</p>' }; } };
  sandbox.window.baroIntentToTool['zz_a'] = 'zz_tool_a';
  sandbox.window.baroIntentToTool['zz_b'] = 'zz_tool_b';
  stepCalls.length = 0;
  const r = await api.runMulti([{ text: 'kappagamma' }, { text: 'deltazeta' }], 'kappagamma y deltazeta');
  assert(r && r.ok === true && r.n === 2, 'resultado ok con n=2');
  eqJ(order, ['a', 'b'], 'orden de ejecución');
});
tcase('runMulti: un paso ctx.step por acción', () => {
  const toolSteps = stepCalls.filter((k) => k === 'baro.intent.step.zz_a' || k === 'baro.intent.step.zz_b');
  eqJ(toolSteps, ['baro.intent.step.zz_a', 'baro.intent.step.zz_b'], 'un step por acción');
});
tcase('chain prefill: publicar recibe args.texto con los títulos de la búsqueda', async () => {
  api.memClear();
  api.recordResult('buscar', {}, { data: { posts: [
    { id: 'p1', content: 'Título Uno' },
    { id: 'p2', content: 'Título Dos' }
  ] } });
  let pubArgs = null;
  sandbox.baroTools['zz_tool_pub'] = { run: async function (a) { pubArgs = a; return { html: '<p>P</p>' }; } };
  sandbox.window.baroIntentToTool['publicar'] = 'zz_tool_pub';
  pushRule('publicar', 'zzpublicar9');
  const r = await api.runMulti([{ text: 'zzpublicar9 ya' }], 'zzpublicar9 ya');
  assert(r && r.ok === true, 'multi ok');
  assert(pubArgs && typeof pubArgs.texto === 'string', 'publicar recibió args.texto');
  assert(pubArgs.texto.indexOf('Título Uno') !== -1 && pubArgs.texto.indexOf('Título Dos') !== -1,
    'texto con los 2 títulos, fue: ' + pubArgs.texto);
});

/* ---------- 24-25. i18n ---------- */
tcase('i18n: claves baro.brain.* en EN/ZH/PT', () => {
  const keys = ['baro.brain.tie_intro', 'baro.brain.multi_intro', 'baro.brain.multi_summary',
    'baro.brain.multi_ok', 'baro.brain.multi_fail', 'baro.brain.multi_clarify', 'baro.brain.chain_prefill'];
  const dicts = { en: sandbox.APP_ENGLISH_TEXT, zh: sandbox.APP_CHINESE_TEXT, pt: sandbox.APP_PORTUGUESE_TEXT };
  for (const k of keys) {
    for (const lg of Object.keys(dicts)) {
      const v = dicts[lg][k];
      assert(typeof v === 'string' && v.length > 0 && v !== k, 'clave ' + k + ' en ' + lg);
    }
  }
  assert(sandbox.APP_ENGLISH_TEXT['baro.brain.tie_intro'] === 'Which of these did you mean? Tap an option.', 'EN tie_intro');
  assert(sandbox.APP_CHINESE_TEXT['baro.brain.tie_intro'] === '你指的是哪一个？点一个选项。', 'ZH tie_intro');
  assert(sandbox.APP_PORTUGUESE_TEXT['baro.brain.multi_ok'] === 'feita', 'PT multi_ok');
});
tcase('i18n: mecanismo ES honesto (fallback sin diccionario)', () => {
  api.memClear();
  api.recordResult('buscar', {}, { data: { posts: [{ id: 'p1', content: 'Algo' }] } });
  const out = api.chainPrefill({});
  assert(typeof out.texto === 'string' && out.texto.indexOf('Comparto lo que encontré') === 0,
    'prefill en ES, fue: ' + out.texto);
});

/* ---------- runner ---------- */
(async () => {
  for (const [name, fn] of CASES) {
    try { await fn(); oks++; }
    catch (e) { fails++; console.error('FALLO [' + name + ']: ' + (e && e.message)); }
  }
  console.log('c122: ' + oks + ' OK, ' + fails + ' FALLO de ' + CASES.length + ' casos (target: ' + target + ')');
  process.exit(fails ? 1 : 0);
})();
