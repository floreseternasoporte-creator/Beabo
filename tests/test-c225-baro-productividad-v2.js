/* Tests C225 — Baro Productividad v2.
   Patron vm en memoria (sin DOM real): sandbox con stubs minimos de
   window/document/navigator/localStorage y las funciones host que el
   bloque espera (baroRegisterTool, baro6dExpose, baroBuildPalette,
   baroRenderDraftCard, baroCopyToClipboard, openSearchView,
   performRealTimeSearch, baroCloseView, baroLang, baroAddBaroMessage).
   node tests/test-c225-baro-productividad-v2.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LANE = path.join(__dirname, '..');
const TESTSELF = fs.readFileSync(__filename, 'utf8');
const REPO_HTML = fs.readFileSync(path.join(process.env.HOME || '/home/hatch', 'workspace', 'beabo', 'index.html'), 'utf8');
/* Post-integración (ronda 2, 2026-09-30): en el repo el bloque C225 ya vive
 * dentro de index.html; si los archivos de la lane no existen junto al test
 * se extraen de sus marcadores. */
function c225ExtractMarked(html, ini, fin) {
  const a = html.indexOf(ini), b = html.indexOf(fin, a === -1 ? 0 : a);
  if (a === -1 || b === -1) throw new Error('marcador C225 ausente: ' + ini);
  return [a, b];
}
function c225LoadBlock() {
  const p = path.join(LANE, 'c225-baro-productividad-v2.js');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  const ini = '/* ================= BARO · PRODUCTIVIDAD v2 (C225) — INICIO ================= */';
  const fin = '/* ================= BARO · PRODUCTIVIDAD v2 (C225) — FIN ================= */';
  const ab = c225ExtractMarked(REPO_HTML, ini, fin);
  const close = REPO_HTML.indexOf('}', ab[1] + fin.length); /* cierre } del guard tras el FIN */
  if (close === -1) throw new Error('cierre del guard C225 ausente');
  return REPO_HTML.slice(ab[0], close + 1);
}
function c225LoadCSS() {
  const p = path.join(LANE, 'c225-baro-productividad-v2.css');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  const ab = c225ExtractMarked(REPO_HTML,
    '/* ===== BARO · CSS productividad v2 (C225) — INICIO ===== */',
    '/* ===== BARO · CSS productividad v2 (C225) — FIN ===== */');
  return REPO_HTML.slice(ab[0], ab[1]);
}
const BLOCK = c225LoadBlock();
const CSS = c225LoadCSS();

let PASS = 0, FAIL = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { PASS++; }
  else { FAIL++; failures.push(name); console.error('FAIL:', name); }
}

/* ---------- contexto fresco ---------- */
function freshContext(opts) {
  opts = opts || {};
  const store = {};
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    _store: store
  };
  const threadChildren = opts.threadChildren || [];
  const paletteGrid = {
    childNodes: opts.gridPainted ? [{ tagName: 'BUTTON' }] : [],
    innerHTML: '',
  };
  const searchInput = { value: '' };
  const flags = {
    clipboard: null, textareaUsed: false,
    openSearchView: 0, performRealTimeSearch: 0, baroCloseView: 0,
    baroBuildPalette: 0, baroAddBaroMessage: 0,
    draftCardText: null, copiedText: null, lang: opts.lang || 'es',
    lastView: null
  };
  const elements = {
    'baro-thread': { children: threadChildren, childNodes: threadChildren },
    'baro-palette-grid': paletteGrid,
    'search-input': searchInput,
    'baro-view': { classList: { add() {}, remove() {} } }
  };
  const document = {
    getElementById: id => elements[id] || null,
    createElement: tag => ({
      tagName: String(tag).toUpperCase(), value: '',
      style: {}, setAttribute() {}, select() {},
      focus() {}
    }),
    body: { appendChild() {}, removeChild() {} },
    execCommand: cmd => { if (cmd === 'copy') flags.textareaUsed = true; return true; }
  };
  const navigator = {};
  if (!opts.noClipboard) {
    navigator.clipboard = { writeText: t => { flags.clipboard = String(t); return Promise.resolve(); } };
  }
  const sandbox = {
    console,
    window: {},
    document,
    navigator,
    localStorage,
    setTimeout: (fn) => 0, clearTimeout: () => {},
    baroIntentRules: [],
    baroIntentToTool: {},
    BARO_L1_SUGGEST: {},
    baroQuickActions: (opts.quickActions || []).slice(),
    BARO_UI_I18N: {},
    baroBrain: {},
    baroRegisterTool: null, // se instala abajo (captor)
    baro6dExpose: (n, f) => { sandbox.window[n] = f; },
    baroLang: () => flags.lang,
    baroAddBaroMessage: html => { flags.baroAddBaroMessage++; flags.lastSaid = String(html); return true; },
    baroCloseView: () => { flags.baroCloseView++; },
    openSearchView: () => { flags.openSearchView++; },
    performRealTimeSearch: () => { flags.performRealTimeSearch++; },
    baroBuildPalette: () => { flags.baroBuildPalette++; },
    __flags: flags, __elements: elements
  };
  sandbox.window.baroIntentRules = sandbox.baroIntentRules;
  sandbox.window.baroIntentToTool = sandbox.baroIntentToTool;
  sandbox.window.BARO_L1_SUGGEST = sandbox.BARO_L1_SUGGEST;
  sandbox.window.baroQuickActions = sandbox.baroQuickActions;
  sandbox.window.BARO_UI_I18N = sandbox.BARO_UI_I18N;
  sandbox.window.baroBrain = sandbox.baroBrain;
  sandbox.window.__baroC225Done = false;
  const tools = {};
  sandbox.baroRegisterTool = (name, def) => { tools[name] = def; };
  sandbox.__tools = tools;
  if (!opts.noDraftCard) {
    sandbox.baroRenderDraftCard = text => { flags.draftCardText = String(text); return { html: '<div class="draft">DRAFT</div>' }; };
  }
  if (!opts.noCopyHelper) {
    sandbox.baroCopyToClipboard = text => { flags.copiedText = String(text); return true; };
  }
  vm.createContext(sandbox);
  return sandbox;
}
function load(sandbox) {
  vm.runInContext(BLOCK, sandbox, { filename: 'c225-baro-productividad-v2.js' });
}
function rulesFor(sandbox, intent) {
  return sandbox.baroIntentRules.filter(r => r.intent === intent);
}

/* ---------- burbujas falsas para exportar ---------- */
function bubble(cls, text) {
  return {
    classList: { contains: c => cls.split(' ').indexOf(c) !== -1 },
    textContent: text,
    querySelector: () => null
  };
}
function msgV2(text) {
  const inner = bubble('baro-bubble-baro', text);
  return {
    classList: { contains: c => c === 'baro-msg-v2' },
    textContent: text,
    querySelector: sel => (sel === '.baro-bubble-baro' ? inner : null)
  };
}

/* ---------- iconos reales del registro BARO_ICONS ---------- */
function realIconKeys() {
  const i = REPO_HTML.indexOf('var BARO_ICONS = {');
  const slice = REPO_HTML.slice(i, i + 40000);
  const keys = new Set();
  const re = /^\s{2}'([a-z0-9-]+)':\s*$/gm;
  let m;
  while ((m = re.exec(slice))) keys.add(m[1]);
  return keys;
}

/* ================= §0 literales ================= */
ok(!BLOCK.includes('<' + '/script'), 'bloque: sin literal de cierre de script');
ok(!CSS.includes('<' + '/script'), 'css: sin literal de cierre de script');
ok(!TESTSELF.includes('<' + '/script'), 'test: sin literal de cierre de script');
ok(!/TODO|FIXME|XXX|HACK/.test(BLOCK), 'bloque: sin marcadores TODO/FIXME');

/* ================= §1 carga e idempotencia ================= */
const ctx = freshContext();
load(ctx);
ok(ctx.window.__baroC225Done === true, 'carga: master guard __baroC225Done');
const rulesCount = ctx.baroIntentRules.length;
const qaCount = ctx.baroQuickActions.length;
const toolNames = Object.keys(ctx.__tools);
load(ctx); // segunda carga: debe ser idempotente
ok(ctx.baroIntentRules.length === rulesCount, 'idempotencia: sin intents duplicados');
ok(ctx.baroQuickActions.length === qaCount, 'idempotencia: sin acciones de paleta duplicadas');
ok(Object.keys(ctx.__tools).length === toolNames.length, 'idempotencia: sin tools duplicadas');

/* ================= §2 intents registrados ================= */
const INTENTS = ['nota', 'lista', 'buscar', 'estadisticas', 'plantilla', 'exportar'];
for (const it of INTENTS) {
  const rs = rulesFor(ctx, it);
  ok(rs.length === 1, 'intent registrado una vez: ' + it);
  ok(rs[0].langs.join(',') === 'es,en,zh,pt', 'intent langs 4 idiomas: ' + it);
  ok(rs[0].patterns.every(p => Object.prototype.toString.call(p) === '[object RegExp]'), 'intent patterns son RegExp: ' + it);
  ok(typeof rs[0].extract === 'function', 'intent extract es funcion: ' + it);
  const src = rs[0].patterns.map(p => p.source).join(' ');
  ok(/\\b/.test(src), 'intent patterns con word-boundary: ' + it);
}
ok(ctx.baroIntentToTool.nota === 'notas', 'mapeo nota->notas');
ok(ctx.baroIntentToTool.lista === 'tareas', 'mapeo lista->tareas');
ok(ctx.baroIntentToTool.buscar === 'buscar_app', 'mapeo buscar->buscar_app');
ok(ctx.baroIntentToTool.estadisticas === 'mi_panel', 'mapeo estadisticas->mi_panel (tool real existente)');
ok(ctx.baroIntentToTool.plantilla === 'plantillas', 'mapeo plantilla->plantillas');
ok(ctx.baroIntentToTool.exportar === 'exportar_chat', 'mapeo exportar->exportar_chat');

/* ================= §3 extract: nota ================= */
{
  const ex = rulesFor(ctx, 'nota')[0].extract;
  let a = ex('/nota comprar pan');
  ok(a.accion === 'add' && a.texto === 'comprar pan', 'nota extract: /nota comprar pan -> add');
  a = ex('/notas');
  ok(a.accion === 'list', 'nota extract: /notas (plural) -> list');
  a = ex('/nota borrar 2');
  ok(a.accion === 'del' && a.idx === 2, 'nota extract: /nota borrar 2 -> del idx 2');
  a = ex('anótame la cita del dentista');
  ok(a.accion === 'add' && a.texto === 'la cita del dentista', 'nota extract: anótame … -> add sin prefijo');
  a = ex('toma nota de llamar a mamá');
  ok(a.accion === 'add' && a.texto === 'llamar a mamá', 'nota extract: toma nota de … -> add');
  a = ex('mis notas');
  ok(a.accion === 'list', 'nota extract: mis notas -> list');
}

/* ================= §4 extract: lista ================= */
{
  const ex = rulesFor(ctx, 'lista')[0].extract;
  let a = ex('/lista pagar la luz');
  ok(a.accion === 'add' && a.texto === 'pagar la luz', 'lista extract: /lista pagar la luz -> add');
  a = ex('/listas');
  ok(a.accion === 'list', 'lista extract: /listas (plural) -> list');
  a = ex('/lista marcar 1 como hecha');
  ok(a.accion === 'toggle' && a.idx === 1, 'lista extract: marcar 1 como hecha -> toggle idx 1');
  a = ex('/lista 3 hecha');
  ok(a.accion === 'toggle' && a.idx === 3, 'lista extract: "3 hecha" -> toggle idx 3');
  a = ex('/lista borrar 2');
  ok(a.accion === 'del' && a.idx === 2, 'lista extract: /lista borrar 2 -> del idx 2');
  a = ex('agrega a mi lista comprar leche');
  ok(a.accion === 'add' && a.texto === 'comprar leche', 'lista extract: agrega a mi lista … -> add');
  a = ex('mi lista');
  ok(a.accion === 'list', 'lista extract: mi lista -> list');
}

/* ================= §5 extract: buscar ================= */
{
  const ex = rulesFor(ctx, 'buscar')[0].extract;
  let a = ex('/buscar recetas de pan');
  ok(a.q === 'recetas de pan', 'buscar extract: /buscar recetas de pan -> q');
  a = ex('/buscar');
  ok(a.q === '', 'buscar extract: /buscar solo -> q vacia (abre buscador)');
  a = ex('busca en drex fotos de playa');
  ok(a.q === 'fotos de playa', 'buscar extract: busca en drex … -> q');
}

/* ================= §6 extract: estadisticas / exportar ================= */
ok(rulesFor(ctx, 'estadisticas')[0].extract('lo que sea') && true, 'estadisticas extract: no revienta');
ok(rulesFor(ctx, 'exportar')[0].extract('exporta la conversación') && true, 'exportar extract: no revienta');
{
  const r = rulesFor(ctx, 'exportar')[0];
  ok(r.patterns.some(p => p.test('exporta la conversación')), 'exportar pattern: "exporta la conversación"');
  ok(r.patterns.some(p => p.test('/exportar')), 'exportar pattern: /exportar');
}

/* ================= §7 extract: plantilla ================= */
{
  const ex = rulesFor(ctx, 'plantilla')[0].extract;
  let a = ex('/plantilla anuncio fiesta de fin de año');
  ok(a.accion === 'use' && a.kind === 'anuncio' && a.tema === 'fiesta de fin de año', 'plantilla extract: /plantilla anuncio … -> use');
  a = ex('/plantilla pregunta');
  ok(a.accion === 'need_topic' && a.kind === 'pregunta', 'plantilla extract: /plantilla pregunta -> need_topic');
  a = ex('/plantilla');
  ok(a.accion === 'choose', 'plantilla extract: /plantilla -> choose');
  a = ex('/plantilla mi evento');
  ok(a.accion === 'choose' && a.tema === 'mi evento', 'plantilla extract: /plantilla mi evento -> choose con tema pendiente');
  a = ex('plantilla de historia');
  ok(a.accion === 'need_topic' && a.kind === 'historia', 'plantilla extract natural: plantilla de historia -> need_topic');
}

/* ================= §8 i18n ================= */
{
  const ui = ctx.BARO_UI_I18N;
  const keys = Object.keys(ui).filter(k => k.indexOf('baro.') === 0);
  ok(keys.length >= 48, 'i18n: al menos 48 claves fusionadas (hay ' + keys.length + ')');
  let all4 = true, nonEmpty = true;
  for (const k of keys) {
    const v = ui[k];
    for (const L of ['es', 'en', 'zh', 'pt']) {
      if (!(L in v)) all4 = false;
      if (typeof v[L] !== 'string' || !v[L]) nonEmpty = false;
    }
  }
  ok(all4, 'i18n: todas las claves tienen es/en/zh/pt');
  ok(nonEmpty, 'i18n: ningun valor vacio');
  for (const it of INTENTS) {
    ok(typeof ui['baro.intent.name.' + it] === 'object', 'i18n: baro.intent.name.' + it);
    ok(typeof ui['baro.intent.need.' + it] === 'object', 'i18n: baro.intent.need.' + it);
  }
  for (const s of ['ver_notas', 'ver_tareas', 'usar_plantilla', 'probar_busqueda', 'ver_ayuda', 'nuevo_borrador']) {
    ok(typeof ui['baro.suggest.' + s] === 'object', 'i18n: baro.suggest.' + s);
  }
  // fallback: idioma desconocido -> ES
  const ctxFr = freshContext({ lang: 'fr' });
  load(ctxFr);
  ok(ctxFr.BARO_UI_I18N['baro.intent.name.nota'].fr === undefined, 'i18n: no hay clave fr inventada');
}

/* ================= §9 tools: notas ================= */
{
  const t = ctx.__tools.notas;
  ok(!!t && typeof t.run === 'function', 'tool registrada: notas');
  let r = t.run({ accion: 'add', texto: 'comprar pan' }, null);
  ok(typeof r.html === 'string' && r.html.indexOf('Nota guardada') !== -1, 'notas: add confirma');
}
/* (roundtrip real con el localStorage del sandbox) */
{
  const sandbox = freshContext();
  load(sandbox);
  const t = sandbox.__tools.notas;
  t.run({ accion: 'add', texto: 'comprar pan' }, null);
  t.run({ accion: 'add', texto: 'llamar al banco' }, null);
  const raw = sandbox.localStorage.getItem('baro_notes_v1');
  const arr = JSON.parse(raw);
  ok(arr.length === 2 && arr[0].texto === 'llamar al banco' && arr[1].texto === 'comprar pan',
    'notas: roundtrip localStorage (2 notas, la mas nueva primero)');
  const list = t.run({ accion: 'list' }, null);
  ok(list.html.indexOf('comprar pan') !== -1 && list.html.indexOf('onclick="baroNoteDel(') !== -1,
    'notas: list pinta notas con onclick a global expuesta');
  const del = t.run({ accion: 'del', idx: 1 }, null);
  ok(del.html.indexOf('eliminada') !== -1, 'notas: del confirma');
  ok(JSON.parse(sandbox.localStorage.getItem('baro_notes_v1')).length === 1, 'notas: del borra del store');
  const delNoIdx = t.run({ accion: 'del', idx: null }, null);
  ok(delNoIdx.html.indexOf('✕') !== -1, 'notas: del sin numero muestra lista + hint (no borra a ciegas)');
}

/* ================= §10 tools: tareas ================= */
{
  const sandbox = freshContext();
  load(sandbox);
  const t = sandbox.__tools.tareas;
  ok(!!t && typeof t.run === 'function', 'tool registrada: tareas');
  t.run({ accion: 'add', texto: 'pagar la luz' }, null);
  let arr = JSON.parse(sandbox.localStorage.getItem('baro_tasks_v1'));
  ok(arr.length === 1 && arr[0].done === false, 'tareas: add guarda pendiente');
  const tog = t.run({ accion: 'toggle', idx: 1 }, null);
  arr = JSON.parse(sandbox.localStorage.getItem('baro_tasks_v1'));
  ok(arr[0].done === true && tog.html.indexOf('hecha') !== -1, 'tareas: toggle marca hecha');
  const list = t.run({ accion: 'list' }, null);
  ok(list.html.indexOf('onclick="baroTaskToggle(') !== -1 && list.html.indexOf('onclick="baroTaskDel(') !== -1,
    'tareas: list con botones a globales expuestas');
  t.run({ accion: 'del', idx: 1 }, null);
  ok(JSON.parse(sandbox.localStorage.getItem('baro_tasks_v1')).length === 0, 'tareas: del vacia el store');
  const empty = t.run({ accion: 'list' }, null);
  ok(empty.html.indexOf('vacía') !== -1, 'tareas: list vacia con hint');
}

/* ================= §11 tools: buscar_app ================= */
{
  const sandbox = freshContext();
  load(sandbox);
  const t = sandbox.__tools.buscar_app;
  ok(!!t && typeof t.run === 'function', 'tool registrada: buscar_app');
  const r = t.run({ q: 'fotos de playa' }, null);
  ok(sandbox.__flags.openSearchView === 1, 'buscar_app: invoca openSearchView real');
  ok(sandbox.__flags.performRealTimeSearch === 1, 'buscar_app: invoca performRealTimeSearch real');
  ok(sandbox.__elements['search-input'].value === 'fotos de playa', 'buscar_app: escribe la query en #search-input');
  ok(typeof r.html === 'string', 'buscar_app: devuelve html');
  const sandbox2 = freshContext();
  load(sandbox2);
  sandbox2.__tools.buscar_app.run({ q: '' }, null);
  ok(sandbox2.__flags.openSearchView === 1, 'buscar_app: sin query abre el buscador igual');
}

/* ================= §12 tools: plantillas ================= */
{
  const sandbox = freshContext();
  load(sandbox);
  const t = sandbox.__tools.plantillas;
  ok(!!t && typeof t.run === 'function', 'tool registrada: plantillas');
  const choose = t.run({ accion: 'choose' }, null);
  const btns = (choose.html.match(/onclick="baroUseTemplate\(/g) || []).length;
  ok(btns === 3, 'plantillas: choose muestra 3 botones (anuncio/pregunta/historia)');
  const use = t.run({ accion: 'use', kind: 'anuncio', tema: 'fiesta de fin de año' }, null);
  ok(sandbox.__flags.draftCardText !== null && sandbox.__flags.draftCardText.indexOf('fiesta de fin de año') !== -1,
    'plantillas: use alimenta baroRenderDraftCard con el tema');
  ok(use.html.indexOf('lista') !== -1, 'plantillas: use confirma tarjeta lista');
  const need = t.run({ accion: 'need_topic', kind: 'pregunta' }, null);
  ok(typeof need === 'string' && need.indexOf('/plantilla') !== -1, 'plantillas: need_topic pide el tema (string need)');
  // degradacion: sin baroRenderDraftCard, cae a tarjeta propia
  const sandboxNo = freshContext({ noDraftCard: true });
  load(sandboxNo);
  const use2 = sandboxNo.__tools.plantillas.run({ accion: 'use', kind: 'historia', tema: 'mi viaje' }, null);
  ok(use2.html.indexOf('mi viaje') !== -1 && use2.html.indexOf('baro-draft') !== -1,
    'plantillas: sin baroRenderDraftCard degrada a tarjeta propia');
  // tema pendiente: choose con tema -> use posterior lo usa
  const sandbox3 = freshContext();
  load(sandbox3);
  sandbox3.__tools.plantillas.run({ accion: 'choose', tema: 'gran evento' }, null);
  sandbox3.window.baroUseTemplate('anuncio');
  ok(sandbox3.__flags.draftCardText !== null && sandbox3.__flags.draftCardText.indexOf('gran evento') !== -1,
    'plantillas: tema pendiente se usa al elegir tipo');
  // baroUseTemplate sin tema -> pide el tema en el chat
  sandbox3.window.baroUseTemplate('pregunta');
  ok(sandbox3.__flags.lastSaid && sandbox3.__flags.lastSaid.indexOf('/plantilla') !== -1,
    'baroUseTemplate sin tema pide el tema en el chat');
}

/* ================= §13 tools: exportar_chat ================= */
{
  const kids = [
    bubble('baro-bubble-user', 'hola'),
    msgV2('¡Hola! ¿En qué te ayudo?'),
    bubble('baro-bubble-baro baro-typing-wrap', 'escribiendo…'),
    bubble('baro-bubble-user', 'exporta esto')
  ];
  const sandbox = freshContext({ threadChildren: kids });
  load(sandbox);
  const t = sandbox.__tools.exportar_chat;
  ok(!!t && typeof t.run === 'function', 'tool registrada: exportar_chat');
  const r = t.run({}, null);
  ok(sandbox.__flags.copiedText !== null, 'exportar: copio al portapapeles');
  const clip = sandbox.__flags.copiedText;
  ok(clip.indexOf('Tú: hola') !== -1, 'exportar: incluye mensaje del usuario con prefijo Tú:');
  ok(clip.indexOf('Baro: ¡Hola!') !== -1, 'exportar: incluye respuesta de Baro con prefijo');
  ok(clip.indexOf('escribiendo') === -1, 'exportar: excluye burbuja de typing');
  ok(r.html.indexOf('copiada') !== -1, 'exportar: confirma copia');
  // vacio
  const sandboxE = freshContext({ threadChildren: [] });
  load(sandboxE);
  const re = sandboxE.__tools.exportar_chat.run({}, null);
  ok(re.html.indexOf('exportar') !== -1, 'exportar: hilo vacio avisa');
  // sin clipboard API: fallback textarea
  const sandboxF = freshContext({ threadChildren: kids, noClipboard: true, noCopyHelper: true });
  load(sandboxF);
  sandboxF.__tools.exportar_chat.run({}, null);
  ok(sandboxF.__flags.textareaUsed === true, 'exportar: sin clipboard usa fallback textarea+execCommand');
}

/* ================= §14 paleta ================= */
{
  const fresh = freshContext({ quickActions: [{ id: 'x', icon: 'check', labelKey: 'k', cmd: '/x' }] });
  load(fresh);
  const ids = fresh.baroQuickActions.map(a => a.id);
  for (const id of ['nota', 'lista', 'buscar', 'estadisticas', 'exportar']) {
    ok(ids.indexOf(id) !== -1, 'paleta: accion nueva ' + id);
  }
  ok(fresh.baroQuickActions.length === 6, 'paleta: 5 nuevas + 1 previa (sin duplicar previas)');
  const icons = realIconKeys();
  ok(icons.size >= 20, 'registro BARO_ICONS real extraido del repo (' + icons.size + ' iconos)');
  for (const a of fresh.baroQuickActions) {
    if (['nota', 'lista', 'buscar', 'estadisticas', 'exportar'].indexOf(a.id) !== -1) {
      ok(icons.has(a.icon), 'paleta: icono "' + a.icon + '" existe en BARO_ICONS real');
      ok(typeof a.labelKey === 'string' && fresh.BARO_UI_I18N[a.labelKey], 'paleta: labelKey i18n existe: ' + a.labelKey);
    }
  }
  // rebuild si el grid ya estaba pintado
  const painted = freshContext({ gridPainted: true });
  load(painted);
  ok(painted.__flags.baroBuildPalette === 1, 'paleta: grid ya pintado -> reconstruye con baroBuildPalette');
  const notPainted = freshContext({ gridPainted: false });
  load(notPainted);
  ok(notPainted.__flags.baroBuildPalette === 0, 'paleta: grid vacio -> no reconstruye (pinta C222 despues)');
}

/* ================= §15 globales expuestas ================= */
for (const g of ['baroNoteDel', 'baroTaskToggle', 'baroTaskDel', 'baroGoSearch', 'baroExportThread', 'baroUseTemplate']) {
  ok(typeof ctx.window[g] === 'function', 'global expuesta: ' + g);
}
{
  // baroGoSearch con query: escribe y dispara busqueda real
  const sandbox = freshContext();
  load(sandbox);
  sandbox.window.baroGoSearch('gatos');
  ok(sandbox.__elements['search-input'].value === 'gatos' && sandbox.__flags.performRealTimeSearch === 1,
    'baroGoSearch: escribe query y dispara busqueda');
  // baroNoteDel / baroTaskToggle / baroTaskDel operan por id sobre stores reales
  sandbox.__tools.notas.run({ accion: 'add', texto: 'n1' }, null);
  var nid = JSON.parse(sandbox.localStorage.getItem('baro_notes_v1'))[0].id;
  sandbox.window.baroNoteDel(nid);
  ok(JSON.parse(sandbox.localStorage.getItem('baro_notes_v1')).length === 0, 'baroNoteDel: borra la nota por id');
  sandbox.__tools.tareas.run({ accion: 'add', texto: 't1' }, null);
  var tid = JSON.parse(sandbox.localStorage.getItem('baro_tasks_v1'))[0].id;
  sandbox.window.baroTaskToggle(tid);
  ok(JSON.parse(sandbox.localStorage.getItem('baro_tasks_v1'))[0].done === true, 'baroTaskToggle: alterna done');
  sandbox.window.baroTaskDel(tid);
  ok(JSON.parse(sandbox.localStorage.getItem('baro_tasks_v1')).length === 0, 'baroTaskDel: borra la tarea por id');
}

/* ================= §16 suggests + brain ================= */
{
  const s = ctx.BARO_L1_SUGGEST;
  for (const it of INTENTS) {
    ok(Array.isArray(s[it]) && s[it].length > 0, 'suggest extendido: ' + it);
    for (const pair of s[it]) {
      ok(typeof ctx.BARO_UI_I18N[pair[0]] === 'object', 'suggest labelKey i18n: ' + pair[0]);
    }
  }
  const b = ctx.baroBrain;
  ok(typeof b.notes === 'function' && typeof b.tasks === 'function', 'brain: notes/tasks');
  ok(typeof b.exportThread === 'function' && typeof b.goSearch === 'function', 'brain: exportThread/goSearch');
  ok(typeof b.tplBody === 'function', 'brain: tplBody');
  const n0n = b.notes().length, n0t = b.tasks().length;
  ctx.__tools.notas.run({ accion: 'add', texto: 'x' }, null);
  ok(b.notes().length === n0n + 1 && b.tasks().length === n0t, 'brain.notes(): lee el store real');
}

/* ================= §17 CSS ================= */
{
  const needed = ['baro-c225-list', 'baro-c225-item', 'baro-c225-done', 'baro-c225-text',
    'baro-c225-check', 'baro-c225-tpls', 'baro-c225-tplbtn', 'baro-c225-tplname', 'baro-c225-tpluse'];
  for (const c of needed) {
    ok(CSS.indexOf('.' + c) !== -1, 'css: clase .' + c + ' definida');
  }
  const clsRe = /\.[a-z][a-z0-9-]*/gi;
  let m, bad = [];
  while ((m = clsRe.exec(CSS))) {
    if (m[0].indexOf('.baro-') !== 0 && m[0].indexOf('.baro') !== 0) bad.push(m[0]);
  }
  ok(bad.length === 0, 'css: solo clases baro-* (sin Tailwind)');
  // html generado por las tools solo usa esas clases + baro-draft existente
  const sandbox = freshContext();
  load(sandbox);
  sandbox.__tools.notas.run({ accion: 'add', texto: 'n' }, null);
  const html = sandbox.__tools.notas.run({ accion: 'list' }, null).html +
    sandbox.__tools.tareas.run({ accion: 'list' }, null).html +
    sandbox.__tools.plantillas.run({ accion: 'choose' }, null).html;
  const used = new Set();
  const ure = /class="([^"]*)"/g;
  let um;
  while ((um = ure.exec(html))) {
    for (const c of um[1].split(/\s+/)) if (c) used.add(c);
  }
  const missing = [];
  for (const c of used) {
    if (c.indexOf('baro-c225-') === 0 && CSS.indexOf('.' + c) === -1) missing.push(c);
  }
  ok(missing.length === 0, 'css: cubre todas las clases baro-c225-* del html generado');
}

/* ================= resumen ================= */
console.log('\nC225: ' + PASS + ' pasadas, ' + FAIL + ' fallidas.');
if (failures.length) { console.log('Fallos:'); for (const f of failures) console.log(' - ' + f); }
process.exit(FAIL ? 1 : 0);
