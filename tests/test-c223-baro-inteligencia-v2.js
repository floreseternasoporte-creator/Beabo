'use strict';
// Tests de Lane 1 (segunda ola) — Baro inteligencia v2 (C223).
// Cubre: perfil persistente + nombre/idioma (4), saludo personalizado (3),
// conciencia de pantalla (4), paso a paso (5), recuperación amable (3),
// i18n ES/EN/ZH/PT (2), seam extendido (2), reglas/tools registradas (2),
// ausencia del literal de cierre de script (1).
//
// Construye un composite en memoria: index.html del repo + bloques L2
// insertados en el ancla (dentro del IIFE 6b, antes de "exposición global").
// Extrae la región 6b (patrón c121/c122/c220) y la carga con vm en sandbox.
// Uso: node tests/test-c223-baro-inteligencia-v2.js [--target <ruta-a-index.html>]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LANE_DIR = path.join(__dirname, '..');
const BLOCKS = [
  'l2-g-i18n.js', 'l2-a-profile.js', 'l2-b-view.js',
  'l2-c-steps.js', 'l2-d-recovery.js', 'l2-e-seam.js'
];
const ANCHOR = '/* ---------- exposición global ---------- */';
/* Post-integración (ronda 2, 2026-09-30): en el repo los bloques L2 ya viven
 * dentro de index.html; si el directorio blocks/ de la lane no existe junto
 * al test, el target se usa tal cual (mismo patrón que test-c220). */
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
  if (BLOCKS_MISSING) return html; /* bloques ya integrados en el target */
  const first = html.indexOf(ANCHOR);
  if (first === -1) throw new Error('ancla de inserción ausente en el target');
  if (html.indexOf(ANCHOR, first + 1) !== -1) throw new Error('ancla duplicada en el target');
  const blocks = BLOCKS.map(f => {
    const p = path.join(LANE_DIR, 'blocks', f);
    if (!fs.existsSync(p)) throw new Error('bloque ausente: ' + f);
    return fs.readFileSync(p, 'utf8');
  }).join('\n');
  return html.slice(0, first) + blocks + '\n' + html.slice(first);
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

/* ---------- 0. sin literal de cierre de script ---------- */
tcase('bloques y test sin literal de cierre de script', () => {
  if (BLOCKS_MISSING) {
    /* Post-integración: los bloques L2 ya viven en la región 6b del target;
       se audita el tramo L2 (hasta el bloque C225 o el ancla). */
    const l2ini = src.indexOf('/* ================= BARO · L2-G');
    let l2fin = src.indexOf('/* ================= BARO · PRODUCTIVIDAD v2 (C225)');
    if (l2fin === -1) l2fin = src.indexOf(ANCHOR);
    assert(l2ini !== -1 && l2fin > l2ini, 'bloques L2 no encontrados en el target');
    const l2 = src.slice(l2ini, l2fin);
    assert(l2.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en bloques L2 integrados');
    assert(!/TODO|FIXME/.test(l2), 'TODO/FIXME en bloques L2 integrados');
  } else {
    for (const f of BLOCKS) {
      const b = fs.readFileSync(path.join(LANE_DIR, 'blocks', f), 'utf8');
      assert(b.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en ' + f);
      assert(!/TODO|FIXME/.test(b), 'TODO/FIXME en ' + f);
    }
  }
  const tsrc = fs.readFileSync(__filename, 'utf8');
  assert(tsrc.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en el test');
});

/* ---------- sandbox + carga ---------- */
const __ls = {};
const baroSaid = [];
const registered = {};
const sandbox = {
  console,
  window: {},
  APP_ENGLISH_TEXT: {}, APP_CHINESE_TEXT: {}, APP_PORTUGUESE_TEXT: {},
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
vm.runInContext(src, sandbox, { filename: 'block-6b-lane1-v2.js' });
const api = sandbox.window.baroBrain;
assert(api && typeof api === 'object', 'seam window.baroBrain ausente');
assert(api.__l2Extended === true, 'la lane no extendió el seam (l2-e no cargó)');
const TCTX = { t: function (k) { return String(k); }, esc: function (s) { return String(s == null ? '' : s); }, lang: 'es' };
/* baroIntentRules vive dentro del IIFE 6b (no es global): se lee vía el seam. */
const ruleIntents = api.rules() || [];
function findRule(intent) { return ruleIntents.indexOf(intent) !== -1; }
/* Las tools pasan por el wrap 8M-D: run es async (igual que en c220). */
async function runTool(name, args, ctx) {
  assert(registered[name] && typeof registered[name].run === 'function', 'tool ausente: ' + name);
  return String(await registered[name].run(args || {}, ctx || TCTX));
}

/* ---------- 1-2. reglas y tools registradas ---------- */
tcase('reglas perfil_nombre / idioma / contexto_vista registradas', () => {
  assert(findRule('perfil_nombre'), 'regla perfil_nombre ausente en ' + JSON.stringify(ruleIntents.slice(0, 8)));
  assert(findRule('idioma'), 'regla idioma ausente');
  assert(findRule('contexto_vista'), 'regla contexto_vista ausente');
});
tcase('tools perfil_nombre / idioma / ayuda_contextual / explicar_pasos registradas', () => {
  for (const n of ['perfil_nombre', 'idioma', 'ayuda_contextual', 'explicar_pasos']) {
    assert(registered[n] && typeof registered[n].run === 'function', 'tool ausente: ' + n);
  }
});

/* ---------- 3-6. perfil: nombre ---------- */
tcase('perfil: "me llamo Ana" detecta perfil_nombre y extrae el nombre', () => {
  const d = api.detect('me llamo Ana');
  assert(d.intent === 'perfil_nombre', 'intent fue ' + d.intent);
  assert(d.args && d.args.nombre === 'Ana', 'nombre=' + JSON.stringify(d.args));
});
tcase('perfil: la tool guarda el nombre y el saludo lo usa', async () => {
  const html = await runTool('perfil_nombre', { nombre: 'Ana' });
  assert(html.indexOf('Ana') !== -1, 'confirmación sin nombre: ' + html);
  assert(api.profile().nombre === 'Ana', 'perfil=' + JSON.stringify(api.profile()));
  const sal = api.saludo(null);
  /* C280: el saludo vivo es natural segun hora e idioma (con variedad);
     se exige idioma ES + nombre presente, no una frase exacta. */
  assert(sal.indexOf('Ana') !== -1, 'saludo sin nombre=' + sal);
  assert(/¡Hola|¡Ey|Buenas|buenos días|buenas tardes|buenas noches/i.test(sal), 'saludo ES no natural=' + sal);
});
tcase('perfil: "olvida mi nombre" limpia el perfil', async () => {
  const d = api.detect('olvida mi nombre');
  assert(d.intent === 'perfil_nombre', 'intent fue ' + d.intent);
  assert(d.args && d.args.olvidar === true, 'args=' + JSON.stringify(d.args));
  await runTool('perfil_nombre', { olvidar: true });
  assert(api.profile().nombre === '', 'nombre no limpiado');
  assert(api.saludo(null) === '', 'saludo debería ser vacío sin nombre');
});
tcase('perfil: "me llamo" sin nombre va a desambiguación con perfil_nombre', async () => {
  const d = api.detect('me llamo');
  assert(d.intent === 'ayuda' && d.args && d.args.clarify === true,
    'se esperaba clarify, fue ' + d.intent);
  assert(d.args.candidates.indexOf('perfil_nombre') !== -1,
    'candidates=' + JSON.stringify(d.args.candidates));
  const html = await runTool('perfil_nombre', d.args);
  assert(html.indexOf('me llamo') !== -1, 'need sin ejemplo: ' + html);
});

/* ---------- 7-8. idioma ---------- */
tcase('idioma: "háblame en inglés" guarda la preferencia', async () => {
  const d = api.detect('háblame en inglés');
  assert(d.intent === 'idioma', 'intent fue ' + d.intent);
  assert(d.args && d.args.idioma === 'en', 'idioma=' + JSON.stringify(d.args.idioma));
  api.learnName('Ana');
  const html = await runTool('idioma', { idioma: 'en' });
  assert(api.profile().idioma === 'en', 'idioma no guardado');
  assert(html.indexOf('inglés') !== -1, 'confirmación=' + html);
});
tcase('idioma: el saludo respeta la preferencia (EN) y sin objetivo ofrece opciones', async () => {
  const sal = api.saludo({ id: 'perfil', view: 'profile-view' });
  /* C280: saludo vivo natural por hora en EN (Good morning/afternoon/
     evening, Hey, Hi...), con el nombre; ya no se fija «Hi, Ana!» ni la
     coletilla exacta de la vista («your profile»). */
  assert(sal.indexOf('Ana') !== -1, 'saludo EN sin nombre=' + sal);
  assert(/Good morning|Good afternoon|Good evening|Hey|Hi|Hello|Good to see you/i.test(sal), 'saludo EN no natural=' + sal);
  assert(!/¡Hola|Buenas/i.test(sal), 'saludo EN mezcló ES=' + sal);
  const card = await runTool('idioma', {});
  assert(card.indexOf("baroL2Send('háblame en español')") !== -1, 'chip ES ausente');
  assert(card.indexOf("baroL2Send('háblame en inglés')") !== -1, 'chip EN ausente');
});

/* ---------- 9. intereses ---------- */
tcase('intereses: explicar una función de la KB queda registrado', () => {
  api.saveProfile({ nombre: '', idioma: '', intereses: [], visitas: 0 });
  const d = api.detect('explícame las ondas');
  assert(d.intent === 'explicar', 'intent fue ' + d.intent);
  assert(d.args && d.args.kb === 'ondas', 'kb=' + JSON.stringify(d.args));
  assert(api.profile().intereses[0] === 'ondas', 'intereses=' + JSON.stringify(api.profile().intereses));
});

/* ---------- 10-13. conciencia de pantalla ---------- */
function fakeEl(id, visible) {
  return {
    id: id,
    dataset: {},
    getBoundingClientRect: function () {
      return visible ? { width: 120, height: 200 } : { width: 0, height: 0 };
    },
    ownerDocument: null
  };
}
function fakeDoc(els) {
  return {
    querySelectorAll: function () { return els; },
    getElementById: function (id) {
      for (var i = 0; i < els.length; i++) if (els[i].id === id) return els[i];
      return null;
    }
  };
}
tcase('vista: detecta la vista visible antes de abrir Baro', () => {
  const v = api.detectView(fakeDoc([fakeEl('ondas-view', true), fakeEl('baro-view', true)]), null);
  assert(v && v.id === 'ondas', 'vista=' + JSON.stringify(v));
});
tcase('vista: solo baro-view visible -> null; main-app visible -> feed', () => {
  const v1 = api.detectView(fakeDoc([fakeEl('baro-view', true)]), null);
  assert(v1 === null, 'debería ser null, fue ' + JSON.stringify(v1));
  const main = fakeEl('main-app', true);
  const v2 = api.detectView(fakeDoc([main, fakeEl('baro-view', true)]), null);
  assert(v2 && v2.id === 'feed', 'vista=' + JSON.stringify(v2));
});
tcase('vista: fallback por ruta cuando el DOM no dice nada', () => {
  const v = api.detectView(fakeDoc([]), { pathname: '/perfil' });
  assert(v && v.id === 'perfil', 'vista=' + JSON.stringify(v));
  const v2 = api.detectView(fakeDoc([]), { pathname: '/xyz-desconocido' });
  assert(v2 === null, 'ruta desconocida debería ser null');
});
tcase('contexto_vista: "¿dónde estoy?" usa la última vista y muestra pasos + chips', async () => {
  const d = api.detect('¿dónde estoy?');
  assert(d.intent === 'contexto_vista', 'intent fue ' + d.intent);
  sandbox.window.__l2LastView = { id: 'ondas', view: 'ondas-view' };
  const html = await runTool('ayuda_contextual', {});
  assert(html.indexOf('ondas') !== -1, 'sin mención de ondas: ' + html.slice(0, 200));
  assert(html.indexOf('baro-kb-steps') !== -1, 'sin pasos de la KB');
  assert(html.indexOf('baroKbGo') !== -1, 'sin botón de apertura');
  assert(html.indexOf('baroL2Send') !== -1, 'sin chips relacionados');
  sandbox.window.__l2LastView = null;
  const unk = await runTool('ayuda_contextual', {});
  assert(unk.indexOf('No sé en qué pantalla') !== -1, 'fallback=' + unk.slice(0, 120));
});

/* ---------- 14-18. paso a paso ---------- */
tcase('pasos: "explícame paso a paso las ondas" -> explicar_pasos con kb', () => {
  const d = api.detect('explícame paso a paso las ondas');
  assert(d.intent === 'explicar_pasos', 'intent fue ' + d.intent);
  assert(d.args && d.args.kb === 'ondas', 'args=' + JSON.stringify(d.args));
  assert(d.confidence === 0.9, 'confidence=' + d.confidence);
});
tcase('pasos: la tool renderiza "Paso 1 de 3" con navegación', async () => {
  const html = await runTool('explicar_pasos', { kb: 'ondas' });
  assert(html.indexOf('Paso 1 de 3') !== -1, 'título=' + html.slice(0, 160));
  assert(html.indexOf("baroL2StepGo('ondas',1)") !== -1, 'sin botón siguiente');
  assert(html.indexOf("baroL2StepGo('ondas','all')") !== -1, 'sin botón ver todo');
});
tcase('pasos: baroL2StepGo avanza y agrega el paso con baroAddBaroMessage', () => {
  baroSaid.length = 0;
  const ok = api.stepGo('ondas', 1);
  assert(ok === true, 'stepGo devolvió false');
  assert(baroSaid.length === 1 && baroSaid[0].indexOf('Paso 2 de 3') !== -1,
    'mensaje=' + (baroSaid[0] || '').slice(0, 160));
  const okAll = api.stepGo('ondas', 'all');
  assert(okAll === true && baroSaid.length === 2, 'ver todo falló');
});
tcase('pasos: "cuéntame más" (followupMore) avanza desde el estado', async () => {
  sandbox.window.__l2Step = { feature: 'ondas', idx: 0 };
  baroSaid.length = 0;
  const html = await runTool('explicar_pasos', { followupMore: true });
  assert(html === '' && baroSaid.length === 1 && baroSaid[0].indexOf('Paso 2 de 3') !== -1,
    'followup no avanzó: html=' + html);
});
tcase('pasos: sin tema pide el tema con ejemplos', async () => {
  const d = api.detect('paso a paso');
  assert(d.intent === 'explicar_pasos', 'intent fue ' + d.intent);
  const html = await runTool('explicar_pasos', d.args);
  assert(html.indexOf('explícame paso a paso las ondas') !== -1, 'sin chip de ejemplo');
});

/* ---------- 19-21. recuperación amable ---------- */
const CLARIFY_HTML = '<div class="baro-clarify"><p>intro</p>' +
  '<div class="baro-intent-btns"><button type="button" class="baro-intent-btn" ' +
  "onclick=\"baroClarifyIntent('x')\">X</button></div></div>";
tcase('recovery: con >3 candidatos enriquece con descripciones + ver más', () => {
  const out = api.enrichClarify(CLARIFY_HTML,
    { candidates: ['preguntar', 'publicar', 'ayuda', 'traducir'] }, TCTX);
  assert(out.indexOf('baro-l2-more') !== -1, 'sin bloque expandible');
  assert(out.indexOf('<strong>') !== -1, 'sin chips enriquecidos');
  assert(out.indexOf('Busca en posts') !== -1, 'sin descripción ES');
  assert(out.indexOf('Ver todas las opciones') !== -1, 'sin botón ver más');
  assert(out.indexOf("baroL2ToggleMore(this)") !== -1, 'sin handler del toggle');
});
tcase('recovery: con ≤3 candidatos el HTML sale idéntico', () => {
  const out = api.enrichClarify(CLARIFY_HTML,
    { candidates: ['preguntar', 'publicar'] }, TCTX);
  assert(out === CLARIFY_HTML, 'HTML modificado con 2 candidatos');
});
tcase('recovery: sin candidatos o html roto no rompe', () => {
  assert(api.enrichClarify(CLARIFY_HTML, {}, TCTX) === CLARIFY_HTML, 'args vacíos');
  assert(api.enrichClarify('', { candidates: ['a', 'b', 'c', 'd'] }, TCTX) === '', 'html vacío');
});

/* ---------- 22-23. i18n completa ---------- */
tcase('i18n: todas las claves L2 tienen ES/EN/ZH/PT no vacías', () => {
  const dict = (typeof api.i18n === 'function') ? api.i18n() : api.i18n; /* fix ronda 2: el seam fusiona L2 en el diccionario L1 */
  const keys = Object.keys(dict);
  assert(keys.length >= 40, 'claves=' + keys.length);
  for (const k of keys) {
    for (const L of ['es', 'en', 'zh', 'pt']) {
      const v = dict[k][L];
      assert(typeof v === 'string' && v.length > 0, 'clave ' + k + ' sin ' + L);
    }
  }
});
tcase('i18n: descripciones para los 13 intents de desambiguación', () => {
  const dict = (typeof api.i18n === 'function') ? api.i18n() : api.i18n; /* fix ronda 2: el seam fusiona L2 en el diccionario L1 */
  const intents = ['preguntar', 'investigar_tema', 'publicar', 'programar', 'eliminar_post',
    'reportar', 'resumir_hilo', 'ayuda', 'resumir', 'recordar', 'redactar', 'traducir', 'explicar'];
  for (const it of intents) {
    assert(dict['baro.intent.desc.' + it], 'desc ausente: ' + it);
  }
});

/* ---------- 24-25. saludo al abrir ---------- */
tcase('saludo: wire antepone el saludo al mensaje de ayuda', () => {
  const els = [fakeEl('baro-view', true)];
  sandbox.document = fakeDoc(els);
  const calls = [];
  sandbox.window.baroAddBaroMessage = function (h) { calls.push(String(h)); };
  sandbox.window.baroOpenView = function () {
    const v = sandbox.document.getElementById('baro-view');
    if (v && !v.dataset.baroGreeted) {
      v.dataset.baroGreeted = '1';
      sandbox.window.baroAddBaroMessage('<p>HELP</p>');
    }
  };
  const wired = api.wireGreeting();
  assert(wired === true, 'wireGreeting devolvió false');
  api.saveProfile({ nombre: 'Ana', idioma: '', intereses: [], visitas: 0 });
  sandbox.window.baroOpenView();
  assert(calls.length === 2, 'llamadas=' + calls.length);
  /* C280: saludo vivo natural ES segun la hora, con el nombre. */
  assert(calls[0].indexOf('Ana') !== -1, 'saludo sin nombre=' + calls[0].slice(0, 120));
  assert(/¡Hola|¡Ey|Buenas|buenos días|buenas tardes|buenas noches/i.test(calls[0]), 'saludo ES no natural=' + calls[0].slice(0, 120));
  assert(calls[1] === '<p>HELP</p>', 'ayuda alterada');
  assert(api.profile().visitas === 1, 'visitas=' + api.profile().visitas);
  delete sandbox.document;
});
tcase('saludo: sin nombre no intercepta; baroL2Send llega al manejador', () => {
  const els = [fakeEl('baro-view', true)];
  sandbox.document = fakeDoc(els);
  const calls = [];
  sandbox.window.baroAddBaroMessage = function (h) { calls.push(String(h)); };
  api.saveProfile({ nombre: '', idioma: '', intereses: [], visitas: 0 });
  sandbox.window.baroOpenView();
  assert(calls.length === 1 && calls[0] === '<p>HELP</p>', 'interceptó sin nombre');
  let got = null;
  sandbox.window.baroHandleUserMessage = function (c) { got = c; };
  assert(sandbox.window.baroL2Send('hola') === true && got === 'hola', 'baroL2Send falló');
  delete sandbox.document;
});

/* ---------- runner ---------- */
(async function () {
  for (const [name, fn] of CASES) {
    try { await fn(); oks++; console.log('ok - ' + name); }
    catch (e) { fails++; console.log('FALLO - ' + name + ' :: ' + (e && e.message)); }
  }
  console.log('----');
  console.log('total=' + CASES.length + ' ok=' + oks + ' fallos=' + fails);
  process.exit(fails ? 1 : 0);
})();
