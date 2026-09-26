'use strict';
// Tests del cableado del feed v2 en el flujo principal de Baro (BARO v3, carril 1).
//
// C100-1: baroHandleUserMessage usa la maquinaria v2 (baroStartLiveTurn,
//          baroMakeV2Ctx, baroWrapRegisteredTools) y NO usa baroAddTyping,
//          baroRemoveTyping, typingId ni baroAddStep (cero typing, cero verde v1).
// C100-2: baroMakeV2Ctx rutea ctx.step->baroStepStart y ctx.stepDone->baroStepDone
//          (verificado con stubs, sin DOM).
// C100-3: baroV2FlowStepKey: lógica pura del mapeo fase -> clave i18n.
// C100-4: baro7cStep usa ctx.stepStart (ya no el global roto baroStepUpdate(label))
//          y baro7cStepUpdate existe y llama a ctx.stepUpdate.
// C100-5: baroWrapToolRun expone vctx.toolStepId y prefiere toolDef.label.
// C100-6: baroDeepSearch emite progreso con conteos reales (stepUpdate) y
//          adjunta groups.stats para el resumen del wrapper.
// C100-7: i18n ES/EN/ZH/PT de las claves nuevas de progreso.
//
// Uso: node tests/test-c100-baro-feed-v2-wiring.js [--target base.html]
// Con --target apuntando a la base sin parche, C100-1..C100-6 deben FALLAR.
process.chdir(__dirname + '/..');
const fs = require('fs');

let target = 'index.html';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) target = process.argv[++i];
}

const html = fs.readFileSync(target, 'utf8');

let fails = 0, oks = 0;
const CASES = [];
function tcase(name, fn) { CASES.push([name, fn]); }
function assert(cond, label) { if (!cond) throw new Error('assert: ' + label); }
function assertNot(src, sub, label) {
  if (src.indexOf(sub) !== -1) throw new Error('prohibido en flujo v2: ' + label);
}

// --- Extractor de funciones por balanceo de llaves (respeta strings y comentarios) ---
function extractFn(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  assert(m, 'función ' + name + ' ausente en ' + target);
  let i = src.indexOf('{', m.index);
  assert(i !== -1, 'sin cuerpo para ' + name);
  let depth = 0, j = i;
  let str = null, esc = false, lineC = false, blockC = false, tplDepth = 0;
  const tplStack = [];
  for (; j < src.length; j++) {
    const c = src[j], nx = src[j + 1];
    if (lineC) { if (c === '\n') lineC = false; continue; }
    if (blockC) { if (c === '*' && nx === '/') { blockC = false; j++; } continue; }
    if (str) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === str) {
        str = null;
        if (tplStack.length && c === '`') { depth = tplStack.pop(); }
        continue;
      }
      if (str === '`' && c === '$' && nx === '{') { tplStack.push(depth); str = null; j++; depth++; continue; }
      continue;
    }
    if (c === '/' && nx === '/') { lineC = true; j++; continue; }
    if (c === '/' && nx === '*') { blockC = true; j++; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (tplStack.length && depth === tplStack[tplStack.length - 1]) { str = '`'; }
      if (depth === 0) return src.slice(m.index, j + 1);
    }
  }
  throw new Error('llaves sin balancear en ' + name);
}

const flowSrc = extractFn(html, 'baroHandleUserMessage');

// --- C100-1: el flujo principal usa v2 y nada de typing/v1 ---
tcase('flujo usa maquinaria v2', () => {
  assert(flowSrc.indexOf('baroStartLiveTurn()') !== -1, 'falta baroStartLiveTurn()');
  assert(flowSrc.indexOf('baroMakeV2Ctx()') !== -1, 'falta baroMakeV2Ctx()');
  assert(flowSrc.indexOf('baroWrapRegisteredTools()') !== -1, 'falta baroWrapRegisteredTools()');
  assert(flowSrc.indexOf("baroV2FlowStepKey(") !== -1, 'falta baroV2FlowStepKey()');
});
tcase('flujo sin typing ni puntitos v1', () => {
  assertNot(flowSrc, 'baroAddTyping', 'baroAddTyping');
  assertNot(flowSrc, 'baroRemoveTyping', 'baroRemoveTyping');
  assertNot(flowSrc, 'typingId', 'typingId');
  assertNot(flowSrc, 'baroAddStep', 'baroAddStep');
  assertNot(flowSrc, "'baro.intent.step.' + intent", "ctx.step('baro.intent.step.'+intent) v1");
});

// --- C100-2: baroMakeV2Ctx rutea a v2 (stubs, sin DOM) ---
function loadV2Ctx(stubs) {
  const src = extractFn(html, 'baroMakeV2Ctx');
  const fn = new Function('baroMakeCtx', 'baroEnhanceCtx', 'baroStepStart', 'baroStepDone',
    src + '\nreturn baroMakeV2Ctx;');
  return fn(stubs.makeCtx, stubs.enhanceCtx, stubs.stepStart, stubs.stepDone)();
}
tcase('baroMakeV2Ctx existe y no usa v1', () => {
  const src = extractFn(html, 'baroMakeV2Ctx');
  assert(src.indexOf('baroEnhanceCtx') !== -1, 'no mejora el ctx con baroEnhanceCtx');
  assertNot(src, 'baroAddStep', 'baroAddStep');
  assertNot(src, 'baroAddTyping', 'baroAddTyping');
});
tcase('ctx.step -> baroStepStart, ctx.stepDone -> baroStepDone', () => {
  const calls = [];
  const ctx = loadV2Ctx({
    makeCtx: () => ({ user: null, t: (k) => k, step: () => 'v1-id', stepDone: () => {}, esc: (s) => s }),
    enhanceCtx: (c) => { const o = {}; for (const k in c) o[k] = c[k]; o.stepStart = () => {}; o.stepUpdate = () => {}; return o; },
    stepStart: (lk) => { calls.push(['start', lk]); return 'sid-9'; },
    stepDone: (id, opts) => { calls.push(['done', id, opts]); }
  });
  const sid = ctx.step('baro.intent.step.detect');
  assert(sid === 'sid-9', 'ctx.step no devolvió el id de baroStepStart');
  assert(calls[0][0] === 'start' && calls[0][1] === 'baro.intent.step.detect', 'ctx.step no llamó a baroStepStart con la clave');
  ctx.stepDone(sid, { summary: 'Buscar en Drex' });
  assert(calls[1][0] === 'done' && calls[1][1] === 'sid-9', 'ctx.stepDone no llamó a baroStepDone con el id');
  assert(calls[1][2] && calls[1][2].summary === 'Buscar en Drex', 'ctx.stepDone no pasó opts');
  ctx.stepDone('otro');
  assert(calls[2][2] && typeof calls[2][2] === 'object', 'opts undefined debe normalizarse a {}');
});
tcase('sin maquinaria v2 el ctx no revienta (retorna null)', () => {
  const ctx = loadV2Ctx({
    makeCtx: () => ({ user: null }),
    enhanceCtx: (c) => c,
    stepStart: undefined,
    stepDone: undefined
  });
  assert(ctx.step('x') === null, 'ctx.step sin v2 debe retornar null');
  ctx.stepDone('x'); // no debe lanzar
});

// --- C100-3: baroV2FlowStepKey (lógica pura) ---
function loadStepKey() {
  const src = extractFn(html, 'baroV2FlowStepKey');
  return new Function(src + '\nreturn baroV2FlowStepKey;')();
}
tcase('baroV2FlowStepKey mapea fases', () => {
  const f = loadStepKey();
  const eq = (a, b, l) => { if (a !== b) throw new Error(l + ' esperado=' + b + ' actual=' + a); };
  eq(f('detect'), 'baro.intent.step.detect', 'detect');
  eq(f('help'), 'baro.intent.step.help', 'help');
  eq(f('login'), 'baro.intent.step.login_required', 'login');
  eq(f('tool', 'preguntar'), 'baro.intent.step.preguntar', 'tool+intent');
  eq(f('tool', null), 'baro.intent.step.', 'tool sin intent');
  eq(f('otra'), 'baro.v2.step.working', 'fase desconocida');
});

// --- C100-4: baro7cStep* rutean a v2 ---
tcase('baro7cStep usa ctx.stepStart y existe baro7cStepUpdate', () => {
  const src = extractFn(html, 'baro7cStep');
  assert(src.indexOf('ctx.stepStart') !== -1, 'baro7cStep no usa ctx.stepStart');
  assertNot(src, 'baroStepUpdate(label)', 'llamada rota al global');
  const up = extractFn(html, 'baro7cStepUpdate');
  assert(up.indexOf('ctx.stepUpdate') !== -1, 'baro7cStepUpdate no llama a ctx.stepUpdate');
  const dn = extractFn(html, 'baro7cStepDone');
  assert(dn.indexOf('ctx.stepDone(id, opts)') !== -1, 'baro7cStepDone no pasa opts');
});

// --- C100-5: wrapper con toolStepId y label real ---
tcase('baroWrapToolRun expone toolStepId y usa label de la tool', () => {
  const src = extractFn(html, 'baroWrapToolRun');
  assert(src.indexOf('vctx.toolStepId = sid') !== -1, 'falta vctx.toolStepId = sid');
  assert(src.indexOf('toolDef.stepKey || toolDef.label') !== -1, 'no prefiere toolDef.label como stepKey');
});

// --- C100-6: baroDeepSearch con progreso real ---
tcase('baroDeepSearch reporta conteos reales durante el escaneo', () => {
  const src = extractFn(html, 'baroDeepSearch');
  assert(src.indexOf('ctx.stepUpdate') !== -1, 'sin ctx.stepUpdate en el escaneo');
  assert(src.indexOf('baro.tool.buscar.prog_posts') !== -1, 'sin plantilla prog_posts');
  assert(src.indexOf('baro.tool.buscar.prog_candidatos') !== -1, 'sin plantilla prog_candidatos');
  assert(src.indexOf('baro.tool.buscar.prog_comentarios') !== -1, 'sin plantilla prog_comentarios');
  assert(src.indexOf('groups.stats') !== -1, 'sin groups.stats para el resumen del wrapper');
  assert(src.indexOf('postsRaw.length') !== -1, 'el conteo no viene de postsRaw.length (real)');
});
tcase('tools de búsqueda devuelven stats reales', () => {
  for (const name of ['baroRunBuscarProfundo', 'baroRunInvestigar', 'baro7cRunBuscarMusica',
                      'baro7cRunBuscarFiestas', 'baro7cRunOndasTendencias', 'baro7cRunNotificaciones']) {
    const src = extractFn(html, name);
    assert(/stats:\s*\{\s*count:/.test(src), name + ' no devuelve stats {count:}');
  }
});

// --- C100-7: i18n ES/EN/ZH/PT de las claves nuevas ---
tcase('claves nuevas de progreso con 4 idiomas', () => {
  const keys = [
    'baro.tool.buscar.prog_posts', 'baro.tool.buscar.prog_candidatos',
    'baro.tool.buscar.prog_comentarios', 'baro.tool.buscar.prog_listo',
    'baro.tool.investigar.prog_comentarios', 'baro.tool.investigar.prog_comentarios_hecho'
  ];
  for (const k of keys) {
    const i = html.indexOf("'" + k + "'");
    assert(i !== -1, 'clave ausente: ' + k);
    const eol = html.indexOf('\n', i);
    const line = html.slice(i, eol);
    for (const lang of ['es:', 'en:', 'zh:', 'pt:']) {
      assert(line.indexOf(lang) !== -1, k + ' sin ' + lang);
    }
    assert(line.indexOf('{n}') !== -1 || line.indexOf('{i}') !== -1, k + ' sin placeholder');
  }
});

for (const [name, fn] of CASES) {
  try { fn(); oks++; console.log('ok - ' + name); }
  catch (e) { fails++; console.log('FALLO - ' + name + ': ' + e.message); }
}
console.log('\n' + oks + ' ok, ' + fails + ' fallos (' + target + ')');
process.exit(fails ? 1 : 0);
