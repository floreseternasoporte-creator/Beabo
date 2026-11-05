'use strict';
// Tests del carril lane2 (ronda 3) — Baro voz y personalidad (C227).
// Cubre: contrato window.BaroVoice (4 funciones requeridas + extras),
// guía de voz inyectable al LLM, anti-repetición (20 respuestas seguidas sin
// repetir plantilla), varyResponse sobre openers robot, reparación
// conversacional con 2 opciones tocables, proactividad por hora/pantalla/
// actividad, memoria referenciada (turnos + paso a paso), saludo con
// variedad y momento del día, rotación de follow-ups, i18n ES/EN/ZH/PT,
// higiene (sin literal de cierre de script ni marcadores de pendiente).
//
// Construye un composite en memoria: index.html del repo + bloques V3
// insertados en el ancla (dentro del IIFE 6b, antes de "exposición global").
// Extrae la región 6b (patrón c121/c122/c220/c223) y la carga con vm.
// Uso: node tests/test-c227-baro-voz.js [--target <ruta-a-index.html>]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LANE_DIR = path.join(__dirname, '..');
const BLOCKS = ['v3-a-voice.js', 'v3-b-wrappers.js'];
const ANCHOR = '/* ---------- exposición global ---------- */';

const argv = process.argv.slice(2);
let target = null;
const ti = argv.indexOf('--target');
if (ti !== -1 && argv[ti + 1]) target = argv[ti + 1];
if (!target) {
  // C246 (2026-10-03): antes se prefería ~/workspace/beabo (clon viejo, 128
  // commits atrás); el artefacto real es el index.html de ESTE repo.
  const cands = [
    path.join(__dirname, '..', 'index.html'),
    'index.html'
  ];
  target = cands.find(p => fs.existsSync(p)) || null;
}
if (!target) { console.error('FALLO: no existe el target'); process.exit(2); }

function buildComposite(t) {
  // C246 (2026-10-03): los bloques lane (v3-a-voice.js, v3-b-wrappers.js)
  // NUNCA se commitearon (ausentes en git ls-files); se hornearon en
  // index.html durante la build. El test corre sobre el artefacto publicado.
  return fs.readFileSync(t, 'utf8');
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

/* ---------- 0. higiene ---------- */
tcase('bloques horneados y test sin literal de cierre de script ni pendientes', () => {
  // C246 (2026-10-03): los fuentes lane ya no existen; se verifica la
  // región 6b desplegada en index.html (misma higiene que antes). El
  // chequeo de pendientes NO se aplica a la región: contiene copy en
  // español con mayúsculas que dispararía un falso positivo.
  assert(src.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en la región 6b');
  const tsrc = fs.readFileSync(__filename, 'utf8');
  assert(tsrc.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en el test');
  assert(!/TOD[O]/.test(tsrc) && tsrc.indexOf('FIX' + 'ME') === -1, 'pendiente marcado en el test');
});

/* ---------- sandbox + carga (patrón c223) ----------
 * La región 6b es un IIFE; en el navegador ve los top-level de <script>s
 * anteriores (BARO_UI_I18N, baroLang, baroT, baroResolveText). El sandbox los
 * provee como globales con las cadenas reales del repo (copiadas verbatim). */
const __ls = {};
const baroSaid = [];
const registered = {};
const sandbox = {
  console,
  window: {},
  APP_ENGLISH_TEXT: {}, APP_CHINESE_TEXT: {}, APP_PORTUGUESE_TEXT: {},
  BARO_UI_I18N: {
    'baro.intent.name.resumir':  { es: 'Resumir texto', en: 'Summarize text', zh: '总结文本', pt: 'Resumir texto' },
    'baro.intent.name.recordar': { es: 'Recordatorios', en: 'Reminders', zh: '提醒', pt: 'Lembretes' },
    'baro.intent.name.redactar': { es: 'Redactar', en: 'Draft', zh: '起草', pt: 'Redigir' },
    'baro.intent.name.traducir': { es: 'Traducir', en: 'Translate', zh: '翻译', pt: 'Traduzir' },
    'baro.intent.clarify_intro': { es: 'No estoy seguro de qué quieres hacer. Elige una opción:', en: 'I\'m not sure what you\'d like to do. Pick an option:', zh: '我不太确定你想做什么，请选择一个选项：', pt: 'Não tenho certeza do que você quer fazer. Escolha uma opção:' }
  },
  baroLang: function () { return 'es'; },
  baroT: function (key) {
    var m = sandbox.BARO_UI_I18N[key] || null;
    if (!m) return String(key);
    var l = sandbox.baroLang();
    return m[l] || m.es;
  },
  baroResolveText: function (k) {
    var t = sandbox.baroT(k);
    if (t !== k) return t;
    try { return sandbox.appT(k); } catch (_) {}
    return String(k);
  },
  appT: function (k) { return String(k); },
  escapeHtml: function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
  baroTools: {},
  baroRegisterTool: function (n, d) { registered[n] = d; },
  baroAddUserMessage: function (t) { return null; },
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
vm.runInContext(src, sandbox, { filename: 'block-6b-lane2-v3.js' });
const api = sandbox.window.baroBrain;
assert(api && typeof api === 'object', 'seam window.baroBrain ausente');
assert(api.__v3VoiceExtended === true, 'la lane no extendió el seam (v3-b no cargó)');
const BV = sandbox.window.BaroVoice;
assert(BV && typeof BV === 'object', 'window.BaroVoice ausente');
const TCTX = { t: function (k) { return String(k); }, esc: function (s) { return String(s == null ? '' : s); }, lang: 'es' };
/* ctx con t que resuelve (como el ctx real del router en producción). */
const R_TCTX = { t: function (k) { return sandbox.baroResolveText(k); }, esc: TCTX.esc, lang: 'es' };
async function runTool(name, args, ctx) {
  assert(registered[name] && typeof registered[name].run === 'function', 'tool ausente: ' + name);
  return String(await registered[name].run(args || {}, ctx || TCTX));
}

/* ---------- 1. contrato window.BaroVoice ---------- */
tcase('contrato: las 4 funciones requeridas existen y son funciones', () => {
  for (const fn of ['systemPromptExtra', 'varyResponse', 'repairPrompt', 'proactivityFor']) {
    assert(typeof BV[fn] === 'function', 'BaroVoice.' + fn + ' no es función');
  }
});
tcase('contrato: extras documentados (vary, memoryLine, momentoKey, recent, version)', () => {
  assert(typeof BV.vary === 'function', 'vary ausente');
  assert(typeof BV.memoryLine === 'function', 'memoryLine ausente');
  assert(typeof BV.momentoKey === 'function', 'momentoKey ausente');
  assert(typeof BV.recent === 'function', 'recent ausente');
  assert(BV.version === '1.0.0', 'version=' + BV.version);
});
tcase('seam extendido con la voz', () => {
  for (const fn of ['vary', 'repair', 'proactivity', 'memoryLine', 'systemPromptExtra', 'clarify']) {
    assert(typeof api[fn] === 'function', 'seam.' + fn + ' ausente');
  }
  assert(api.voice === BV, 'seam.voice no es window.BaroVoice');
});

/* ---------- 2. guía de voz ---------- */
tcase('systemPromptExtra: guía no vacía, prohíbe plantillas, ES por defecto', () => {
  const g = BV.systemPromptExtra();
  assert(typeof g === 'string' && g.length > 200, 'guía vacía o corta');
  assert(/robot/i.test(g), 'la guía no menciona lo robot');
  assert(/plantilla/i.test(g), 'la guía no prohíbe plantillas');
  assert(g.indexOf('1-2') !== -1, 'la guía no limita emojis');
});
tcase('systemPromptExtra: variante EN difiere de ES', () => {
  const es = BV.systemPromptExtra('es');
  const en = BV.systemPromptExtra('en');
  assert(en !== es && /warm/i.test(en), 'variante EN=' + en.slice(0, 60));
  assert(BV.systemPromptExtra('xx') === es, 'idioma inválido no cae a ES');
});

/* ---------- 3. anti-repetición ---------- */
tcase('20 respuestas seguidas de saludo sin repetir plantilla', () => {
  const outs = [];
  for (let i = 0; i < 20; i++) outs.push(BV.vary('saludo', 'es'));
  for (let i = 1; i < outs.length; i++) {
    assert(outs[i] !== outs[i - 1], 'repetición consecutiva en ' + i + ': ' + outs[i]);
  }
  const counts = {};
  outs.forEach(o => { counts[o] = (counts[o] || 0) + 1; });
  const keys = Object.keys(counts);
  assert(keys.length === 5, 'se esperaban 5 variantes, hubo ' + keys.length);
  keys.forEach(k => assert(counts[k] === 4, 'variante usada ' + counts[k] + ' veces: ' + k));
});
tcase('confirmaciones: 4 variantes, sin consecutivos iguales', () => {
  const outs = [];
  for (let i = 0; i < 8; i++) outs.push(BV.vary('confirm', 'es'));
  for (let i = 1; i < outs.length; i++) assert(outs[i] !== outs[i - 1], 'repetición en ' + i);
  assert(new Set(outs).size === 4, 'variantes=' + new Set(outs).size);
});
tcase('recent() refleja el ciclo de rotación', () => {
  const r = BV.recent();
  assert(typeof r.saludo === 'number' && r.saludo >= 0 && r.saludo < 5, 'recent=' + JSON.stringify(r));
});
tcase('vary con clave inexistente no rompe', () => {
  assert(BV.vary('no_existe', 'es') === '', 'debería ser cadena vacía');
});

/* ---------- 4. varyResponse (post-proceso LLM) ---------- */
tcase('varyResponse: opener robot ES se reemplaza con variante', () => {
  const out = BV.varyResponse('Soy Baro, tu asistente de Drex. Dime qué necesitas.', null, { nombre: 'Ana' });
  assert(out.indexOf('Soy Baro, tu asistente') === -1, 'opener sobrevive: ' + out);
  assert(out.indexOf('Ana') !== -1, 'no usó el nombre: ' + out);
});
tcase('varyResponse: "¿En qué puedo ayudarte?" se suaviza', () => {
  const out = BV.varyResponse('¿En qué puedo ayudarte?', null, {});
  assert(out !== '¿En qué puedo ayudarte?', 'sin cambio: ' + out);
  assert(out.length > 0, 'vacío');
});
tcase('varyResponse: auto-referencia "Como asistente de IA" se recorta', () => {
  const out = BV.varyResponse('Como asistente de IA, no tengo acceso a eso. Pero dime en qué te ayudo.', null, {});
  assert(out.indexOf('Como asistente de IA') === -1, 'sobrevive: ' + out);
  assert(out.indexOf('dime en qué te ayudo') !== -1, 'se comió el resto: ' + out);
});
tcase('varyResponse: texto normal queda intacto', () => {
  const plain = 'El recordatorio quedó guardado para mañana a las 9.';
  assert(BV.varyResponse(plain, null, {}) === plain, 'texto alterado');
  assert(BV.varyResponse('', null, {}) === '', 'vacío alterado');
});

/* ---------- 5. reparación conversacional ---------- */
tcase('repairPrompt: 2 opciones tocables con las mejores intenciones', () => {
  const html = BV.repairPrompt(['resumir', 'traducir']);
  assert(html.indexOf('data-baro-intent="resumir"') !== -1, 'falta botón resumir');
  assert(html.indexOf('data-baro-intent="traducir"') !== -1, 'falta botón traducir');
  assert(html.indexOf('data-baro-intent="recordar"') === -1, 'aparece una tercera intención');
  assert(html.indexOf("onclick=\"baroClarifyIntent('resumir')\"") !== -1, 'onclick sin contrato L1-C');
  assert(html.indexOf('«') !== -1, 'intro sin formato conversacional: ' + html.slice(0, 120));
  assert(html.indexOf('Resumir texto') !== -1, 'sin nombre visible de la intención');
});
tcase('repairPrompt: con menos de 2 intenciones devuelve vacío', () => {
  assert(BV.repairPrompt(['resumir']) === '', 'debería ser vacío');
  assert(BV.repairPrompt([]) === '', 'debería ser vacío');
  assert(BV.repairPrompt(null) === '', 'debería ser vacío');
});
tcase('repairPrompt: EN usa la plantilla en inglés', () => {
  const html = BV.repairPrompt(['resumir', 'traducir'], { lang: 'en' });
  assert(/Did you mean|didn't quite get|got a bit lost|see if I follow|not clear to me/i.test(html),
    'no está en inglés: ' + html.slice(0, 120));
});

/* ---------- 6. wrapper de baroClarifyHtml ---------- */
const DRY_INTRO = 'No estoy seguro de qué quieres hacer';
tcase('aclaratoria con 2+ candidatos: intro conversacional, botones intactos', () => {
  const html = api.clarify(
    { candidates: ['resumir', 'traducir', 'recordar', 'redactar'], clarify: true }, R_TCTX);
  assert(html.indexOf(DRY_INTRO) === -1, 'la intro seca sigue presente');
  assert(html.indexOf('«') !== -1, 'sin tono conversacional');
  assert(html.indexOf('data-baro-intent="resumir"') !== -1, 'se perdieron botones');
  assert(html.indexOf('baro-intent-btn') !== -1, 'contrato DOM roto');
});
tcase('aclaratoria con 1 candidato: HTML intacto (byte-idéntico al seco)', () => {
  const html = api.clarify({ candidates: ['resumir'], clarify: true }, R_TCTX);
  assert(html.indexOf(DRY_INTRO) !== -1, 'la intro seca debería conservarse: ' + html.slice(0, 120));
  assert(html.indexOf('baro-v3-repair') === -1, 'no debería reparar con 1 candidato');
});

/* ---------- 7. proactividad ---------- */
tcase('proactividad: por la mañana sugiere recordatorios', () => {
  const out = BV.proactivityFor({ hour: 8, lang: 'es', name: 'Ana' });
  assert(out.length >= 1 && /recordatorio/i.test(out[0]), 'mañana=' + JSON.stringify(out));
});
tcase('proactividad: tras publicar sugiere compartir', () => {
  const out = BV.proactivityFor({ hour: 15, lang: 'es', lastActivity: { kind: 'publicar' } });
  assert(out.length >= 1 && /compartir/i.test(out[0]), 'publicar=' + JSON.stringify(out));
});
tcase('proactividad: tras días fuera propone ponerse al día', () => {
  const out = BV.proactivityFor({ hour: 15, lang: 'es', daysAway: 5 });
  assert(out.length >= 1 && /5/.test(out[0]) && /días fuera/i.test(out[0]), 'catchup=' + JSON.stringify(out));
});
tcase('proactividad: según pantalla (ondas / perfil)', () => {
  const o = BV.proactivityFor({ hour: 15, lang: 'es', viewId: 'ondas' });
  assert(/Ondas/i.test(o[0]), 'ondas=' + JSON.stringify(o));
  const p = BV.proactivityFor({ hour: 15, lang: 'es', viewId: 'perfil' });
  assert(/perfil/i.test(p[0]), 'perfil=' + JSON.stringify(p));
});
tcase('proactividad: EN responde en inglés', () => {
  const out = BV.proactivityFor({ hour: 8, lang: 'en', name: 'Ana' });
  assert(/reminders/i.test(out[0]), 'en=' + JSON.stringify(out));
});
tcase('momentoKey: 8→mañana, 14→tarde, 22→noche, 3→noche', () => {
  assert(BV.momentoKey(8) === 'manana', '8=' + BV.momentoKey(8));
  assert(BV.momentoKey(14) === 'tarde', '14=' + BV.momentoKey(14));
  assert(BV.momentoKey(22) === 'noche', '22=' + BV.momentoKey(22));
  assert(BV.momentoKey(3) === 'noche', '3=' + BV.momentoKey(3));
});

/* ---------- 8. memoria referenciada ---------- */
tcase('memoryLine: cita el tema del último turno', () => {
  const brain = sandbox.window.baroBrain;
  const origTurns = brain.ctxTurns;
  brain.ctxTurns = function () {
    return [{ intent: 'explicar', lang: 'es', entities: {}, about: 'recetas de pan', ts: Date.now() }];
  };
  try {
    const line = BV.memoryLine();
    assert(line.indexOf('recetas de pan') !== -1, 'no cita el tema: ' + line);
  } finally { brain.ctxTurns = origTurns; }
});
tcase('memoryLine: sin turnos devuelve vacío', () => {
  assert(BV.memoryLine() === '', 'debería ser vacío sin memoria');
});
tcase('memoryLine: retoma el paso a paso donde quedó', () => {
  sandbox.window.__l2Step = { feature: 'ondas', idx: 1 };
  try {
    const line = BV.memoryLine();
    assert(/paso 2 de \d+/.test(line), 'no retoma el paso: ' + line);
  } finally { delete sandbox.window.__l2Step; }
});

/* ---------- 9. saludo con variedad ---------- */
tcase('saludo: usa el nombre, momento del día y no repite plantilla', async () => {
  await runTool('perfil_nombre', { nombre: 'Ana' });
  const s1 = api.saludo({ id: 'ondas', view: 'ondas-view' });
  const s2 = api.saludo({ id: 'ondas', view: 'ondas-view' });
  assert(s1.indexOf('Ana') !== -1, 'sin nombre: ' + s1);
  assert(s2.indexOf('Ana') !== -1, 'sin nombre: ' + s2);
  assert(/buenos días|buenas tardes|buenas noches/i.test(s1), 'sin momento del día: ' + s1);
  assert(s1 !== s2, 'el saludo no varía entre llamadas');
  assert(s1.indexOf('<p>') === 0, 'formato inesperado: ' + s1.slice(0, 40));
});
tcase('saludo: tras 5 días ausente muestra variante de reencuentro', async () => {
  __ls['baro_v3_visit'] = String(Date.now() - 5 * 86400000 - 3600000);
  const seen = [];
  for (let i = 0; i < 4; i++) seen.push(api.saludo({ id: 'feed', view: 'main-app' }));
  assert(seen.some(s => /Cuánto tiempo|volvió|de nuevo|Volviste|Por aquí/i.test(s)),
    'ninguna variante de reencuentro: ' + seen[0]);
  delete __ls['baro_v3_visit'];
});
tcase('saludo: EN respeta el idioma del perfil', async () => {
  await runTool('idioma', { idioma: 'en' });
  const s = api.saludo({ id: 'perfil', view: 'profile-view' });
  assert(/Hey|Good|morning|afternoon|evening/.test(s), 'no está en inglés: ' + s);
  await runTool('idioma', { idioma: 'es' });
});
tcase('saludo: sin nombre no intercepta (vacío como L2)', async () => {
  await runTool('perfil_nombre', { olvidar: true });
  assert(api.saludo(null) === '', 'debería ser vacío sin nombre');
  await runTool('perfil_nombre', { nombre: 'Ana' });
});

/* ---------- 10. follow-ups con rotación ---------- */
tcase('follow-ups: el orden rota por intención sin alterar el conjunto', () => {
  const k = s => s.map(x => x.labelKey).join('|');
  const s1 = k(api.suggest('resumir'));
  const s2 = k(api.suggest('resumir'));
  const s3 = k(api.suggest('resumir'));
  assert(s1.length > 0 && s2.length > 0, 'sugerencias vacías');
  assert(s1 !== s2 || s2 !== s3, 'el orden no rota: ' + s1);
  const set = a => a.split('|').sort().join('|');
  assert(set(s1) === set(s2) && set(s2) === set(s3), 'la rotación alteró el conjunto');
});

/* ---------- 11. i18n ---------- */
tcase('i18n: ZH/PT resuelven con la preferencia del perfil', async () => {
  await runTool('idioma', { idioma: 'zh' });
  const zh = BV.vary('confirm');
  assert(/[\u4e00-\u9fff]/.test(zh) && /✅|👍/.test(zh), 'ZH=' + zh);
  await runTool('idioma', { idioma: 'pt' });
  const pt = BV.proactivityFor({ hour: 8, name: 'Ana' });
  assert(/Bom dia/i.test(pt[0]), 'PT=' + JSON.stringify(pt));
  const ptc = BV.vary('confirm');
  assert(/Pronto|Feito|Já foi|anotado/.test(ptc), 'PT confirm=' + ptc);
  await runTool('idioma', { idioma: 'es' });
});

/* ---------- runner ---------- */
(async () => {
  for (const [name, fn] of CASES) {
    try { await fn(); oks++; console.log('  ok   ' + name); }
    catch (e) { fails++; console.error('  FALLO ' + name + '\n         ' + (e && e.message)); }
  }
  console.log('\n' + oks + ' ok, ' + fails + ' fallos (' + CASES.length + ' casos)');
  process.exit(fails ? 1 : 0);
})();
