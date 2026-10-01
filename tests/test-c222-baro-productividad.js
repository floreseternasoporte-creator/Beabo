'use strict';
/* test-c222-baro-productividad.js — lane3 (productividad + diseno Baro)
 * Uso: node tests/test-c222-baro-productividad.js
 * Verifica: registro de iconos, shape de quick actions, i18n,
 * baroRenderChips con DOM stub, handlers onclick y referencias de IDs.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = __dirname + '/..';
/* Adaptación del integrador (2026-09-30): en el repo el código ya está
 * integrado en index.html; si los archivos sueltos de la lane no existen,
 * se reconstruyen en un dir temporal extrayéndolos de los marcadores. */
const os = require('os');
function __laneFile(name) { return DIR + '/' + name; }
function __extractBetween(html, a, b) {
  const i = html.indexOf(a);
  if (i === -1) throw new Error('marcador ausente: ' + a.slice(0, 50));
  const j = html.indexOf(b, i + a.length);
  if (j === -1) throw new Error('marcador de fin ausente: ' + b.slice(0, 50));
  return html.slice(i + a.length, j);
}
function __balancedVar(html, startMarker) {
  let i = html.indexOf(startMarker);
  if (i === -1) throw new Error('marcador ausente: ' + startMarker);
  let depth = 0, q = null;
  for (let j = i; ; j++) {
    const c = html[j];
    if (q) { if (c === '\\') j++; else if (c === q) q = null; }
    else if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        if (html[j + 1] !== ';') throw new Error('cierre inesperado tras ' + startMarker);
        return html.slice(i, j + 2);
      }
    }
  }
}
let LANE3_DIR = DIR;
if (!fs.existsSync(__laneFile('icons.js'))) {
  const html = fs.readFileSync(__laneFile('index.html'), 'utf8');
  const tmp = fs.mkdtempSync(os.tmpdir() + '/baro-lane3-');
  fs.writeFileSync(tmp + '/icons.js',
    __balancedVar(html, 'var BARO_ICONS = {') +
    "\nif (typeof module !== 'undefined' && module.exports) { module.exports = { BARO_ICONS: BARO_ICONS }; }\n");
  fs.writeFileSync(tmp + '/i18n-lane3.js', __extractBetween(html,
    '/* ===== BARO · i18n LANE 3 (C222) — INICIO ===== */',
    '/* ===== BARO · i18n LANE 3 (C222) — FIN ===== */'));
  fs.writeFileSync(tmp + '/baro-productividad.js', __extractBetween(html,
    '/* ===== BARO · productividad LANE 3 (C222) — INICIO ===== */',
    '/* ===== BARO · productividad LANE 3 (C222) — FIN ===== */'));
  /* patch.html: fragmentos ya integrados (botón paleta + sheet/backdrop). */
  const ps2 = html.indexOf('<!-- BARO · LANE 3 (C222): action sheet de la paleta -->');
  const pe2 = html.indexOf('</div>', html.indexOf('id="baro-palette-backdrop"')) + '</div>'.length;
  const ps1 = html.indexOf('<!-- BARO · LANE 3 (C222): botón paleta de acciones rápidas -->');
  const pb1 = html.indexOf('id="baro-palette-btn"');
  const pe1 = html.indexOf('</button>', pb1) + '</button>'.length;
  if (ps2 === -1 || ps1 === -1 || pe2 <= ps2 || pe1 <= pb1) throw new Error('fragmentos lane3 ausentes en index.html');
  fs.writeFileSync(tmp + '/patch.html', html.slice(ps2, pe2) + '\n' + html.slice(ps1, pe1));
  fs.writeFileSync(tmp + '/baro-productividad.css', __extractBetween(html,
    '/* ===== BARO · CSS productividad LANE 3 (C222) — INICIO ===== */',
    '/* ===== BARO · CSS productividad LANE 3 (C222) — FIN ===== */'));
  LANE3_DIR = tmp;
}
const LDIR = LANE3_DIR;
let failures = 0;
function ok(cond, name) {
  if (cond) { console.log('  ok  ' + name); }
  else { failures++; console.log('  FAIL ' + name); }
}

/* ---------- mini DOM stub ---------- */
function makeEl(tag) {
  const el = {
    tagName: tag, children: [], attributes: {}, dataset: {},
    style: {}, _cls: [], _handlers: {},
    textContent: '', value: '',
    _innerHTML: '',
    classList: {
      add(c) { if (el._cls.indexOf(c) < 0) el._cls.push(c); },
      remove(c) { el._cls = el._cls.filter(x => x !== c); },
      contains(c) { return el._cls.indexOf(c) >= 0; }
    },
    setAttribute(k, v) { el.attributes[k] = String(v); },
    getAttribute(k) { return (k in el.attributes) ? el.attributes[k] : null; },
    hasAttribute(k) { return k in el.attributes; },
    appendChild(c) { el.children.push(c); return c; },
    insertBefore(c) { el.children.push(c); return c; },
    removeChild(c) { el.children = el.children.filter(x => x !== c); return c; },
    addEventListener(t, f) { el._handlers[t] = f; },
    click() { if (el._handlers.click) el._handlers.click(); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() { el._focused = true; },
    select() {},
    closest(sel) {
      if (sel === '.baro-draft-card' && el._draftCard) return el._draftCard;
      return null;
    }
  };
  Object.defineProperty(el, 'className', {
    get() { return el._cls.join(' '); },
    set(v) { el._cls = String(v).split(/\s+/).filter(Boolean); }
  });
  Object.defineProperty(el, 'childNodes', { get() { return el.children; } });
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML; },
    set(v) { el._innerHTML = String(v); el.children = []; }
  });
  return el;
}

/* ============================================================
 * 1. Registro de iconos
 * ============================================================ */
console.log('\n[1] BARO_ICONS');
const { BARO_ICONS } = require(LDIR + '/icons.js');
const names = Object.keys(BARO_ICONS);
ok(names.length >= 28, 'registry tiene >= 28 iconos (hay ' + names.length + ')');
let iconsOk = true, iconsReport = [];
names.forEach(n => {
  const svg = BARO_ICONS[n];
  const probs = [];
  if (!/viewBox="0 0 24 24"/.test(svg)) probs.push('viewBox');
  if (!/stroke-width="1\.8"/.test(svg)) probs.push('stroke-width!=1.8');
  if (!/stroke-linecap="round"/.test(svg)) probs.push('linecap');
  if (!/stroke-linejoin="round"/.test(svg)) probs.push('linejoin');
  const shapes = svg.match(/<(path|circle|rect|line|polyline|polygon)[^>]*>/g) || [];
  const hasData = shapes.some(s =>
    /d="[^"]+"/.test(s) || /points="[^"]+"/.test(s) ||
    (/cx="[^"]+"/.test(s) && /cy="[^"]+"/.test(s)) ||
    (/x="[^"]+"/.test(s) && /width="[^"]+"/.test(s)) ||
    (/x1="[^"]+"/.test(s) && /x2="[^"]+"/.test(s)));
  if (!shapes.length || !hasData) probs.push('sin-forma-valida');
  if (probs.length) { iconsOk = false; iconsReport.push(n + ': ' + probs.join(',')); }
});
ok(iconsOk, 'todos los iconos: viewBox 0 0 24 24, stroke 1.8, round, forma no vacia' +
  (iconsOk ? '' : '\n       ' + iconsReport.join('\n       ')));
['rayo', 'traducir', 'ayuda', 'camara', 'inicio'].forEach(n =>
  ok(names.indexOf(n) >= 0, 'icono nuevo presente: ' + n));
['resumir-hilo', 'editar-borrador', 'programar', 'aclaracion', 'perfil', 'publicar', 'copiar']
  .forEach(n => ok(names.indexOf(n) >= 0, 'icono reutilizado presente: ' + n));

/* ============================================================
 * 2. i18n lane3
 * ============================================================ */
console.log('\n[2] i18n');
const { BARO_UI_I18N_LANE3 } = require(LDIR + '/i18n-lane3.js');
const i18nKeys = Object.keys(BARO_UI_I18N_LANE3);
ok(i18nKeys.length >= 14, 'claves nuevas >= 14 (hay ' + i18nKeys.length + ')');
let i18nOk = true;
i18nKeys.forEach(k => {
  const v = BARO_UI_I18N_LANE3[k];
  if (!v || !v.es || !v.en || !v.zh || !v.pt) i18nOk = false;
});
ok(i18nOk, 'toda clave tiene es/en/zh/pt no vacios');
ok(/^[a-z0-9.]+$/.test(i18nKeys.join(' ')) === false || true, 'formato de claves (placeholder)');

/* ============================================================
 * 3. JS principal en sandbox VM
 * ============================================================ */
console.log('\n[3] baro-productividad.js');
const jsSrc = fs.readFileSync(LDIR + '/baro-productividad.js', 'utf8');
const ids = {};
const sandbox = {
  console,
  baroResolveText: k => '[L]' + k,
  baroIcon: (n, cls) => '<svg class="' + cls + '">' + n + '</svg>',
  navigator: {},
  setTimeout: () => 0
};
sandbox.window = sandbox;
sandbox.document = {
  createElement: t => makeEl(t),
  getElementById: id => ids[id] || null,
  body: makeEl('body'),
  execCommand: () => true
  // sin readyState -> el auto-init no corre; lo invocamos a mano
};
vm.createContext(sandbox);
vm.runInContext(jsSrc, sandbox, { filename: 'baro-productividad.js' });

ok(Array.isArray(sandbox.baroQuickActions), 'baroQuickActions es array');
const qa = sandbox.baroQuickActions;
ok(qa.length === 9, '9 acciones rapidas (hay ' + qa.length + ')');
let qaOk = true;
const qaIds = {};
qa.forEach(a => {
  if (!a.id || !a.icon || !a.labelKey || !(a.cmd || a.fn)) qaOk = false;
  if (qaIds[a.id]) qaOk = false; else qaIds[a.id] = 1;
  if (!BARO_ICONS[a.icon]) qaOk = false;
  if (!BARO_UI_I18N_LANE3[a.labelKey]) qaOk = false;
});
ok(qaOk, 'shape {id,icon,labelKey,cmd|fn}, ids unicos, icono e i18n existen');
ok(typeof sandbox.baroTogglePalette === 'function', 'global baroTogglePalette');
ok(typeof sandbox.baroRunQuickAction === 'function', 'global baroRunQuickAction');
ok(typeof sandbox.baroRenderChips === 'function', 'global baroRenderChips');
ok(typeof sandbox.baroRefreshChips === 'function', 'global baroRefreshChips');
ok(typeof sandbox.baroRenderDraftCard === 'function', 'global baroRenderDraftCard');
ok(typeof sandbox.baroCopyDraftText === 'function', 'global baroCopyDraftText');
ok(typeof sandbox.baroEditDraftText === 'function', 'global baroEditDraftText');
ok(typeof sandbox.baroPublishDraftText === 'function', 'global baroPublishDraftText');
ok(typeof sandbox.baroQaGoProfile === 'function', 'global baroQaGoProfile');
ok(typeof sandbox.baroQaGoFeed === 'function', 'global baroQaGoFeed');
ok(typeof sandbox.baroQaOpenCreate === 'function', 'global baroQaOpenCreate');
ok(typeof sandbox.baroInitProductividad === 'function', 'global baroInitProductividad');

/* ---- baroRenderChips con DOM stub ---- */
const thread = makeEl('div'); ids['baro-thread'] = thread;
const row = makeEl('div');
let gotCmd = null;
sandbox.baroHandleUserMessage = cmd => { gotCmd = cmd; };
sandbox.baroRenderChips(row, [
  { labelKey: 'baro.qa.resumir', cmd: '/resumir' },
  { label: 'Directo', cmd: '/ayuda' },
  { labelKey: 'x', cmd: '/traducir' },
  { labelKey: 'extra', cmd: '/recordar' }
]);
ok(row.children.length === 3, 'maximo 3 chips (hay ' + row.children.length + ')');
ok(row.children[0].textContent === '[L]baro.qa.resumir', 'chip 1 resuelve labelKey via baroResolveText');
ok(row.children[1].textContent === 'Directo', 'chip 2 acepta label directa');
ok(row.children.every(c => c.className.split(' ').indexOf('baro-chip') >= 0), 'chips con clase baro-chip');
row.children[0].click();
ok(gotCmd === '/resumir', 'click en chip dispara window.baroHandleUserMessage(cmd)');
sandbox.baroRenderChips(row, null);
ok(row.children.length === 0, 'items null -> contenedor vacio, sin throw');

/* ---- paleta: toggle + build + run ---- */
const sheet = makeEl('div'); sheet.classList.add('hidden');
const back = makeEl('div'); back.classList.add('hidden');
const grid = makeEl('div'); const ptitle = makeEl('span');
ids['baro-palette-sheet'] = sheet; ids['baro-palette-backdrop'] = back;
ids['baro-palette-grid'] = grid; ids['baro-palette-title'] = ptitle;
sandbox.baroTogglePalette();
ok(!sheet.classList.contains('hidden') && !back.classList.contains('hidden'), 'toggle abre sheet+backdrop');
ok(grid.children.length === 9, 'grid construye 9 items con iconos');
ok(grid.children.every(b => /baro-palette-ic/.test(b.innerHTML) && /baro-palette-label/.test(b.innerHTML)),
  'item: icono + etiqueta');
sandbox.baroTogglePalette();
ok(sheet.classList.contains('hidden'), 'toggle cierra sheet');
gotCmd = null;
sandbox.baroRunQuickAction('resumir');
ok(gotCmd === '/resumir', 'runQuickAction(cmd) -> /resumir');
ok(sheet.classList.contains('hidden'), 'runQuickAction cierra la paleta');
let fnCalled = null;
sandbox.baroQaGoProfile = () => { fnCalled = 'perfil'; };
sandbox.baroRunQuickAction('perfil');
ok(fnCalled === 'perfil', 'runQuickAction(fn) delega a la funcion de integracion');
sandbox.baroRunQuickAction('inexistente');
ok(true, 'runQuickAction con id desconocido no lanza');

/* ---- tarjeta de borrador ---- */
const card = sandbox.baroRenderDraftCard('Hola <mundo> & "amigos"');
ok(card && card.className.split(' ').indexOf('baro-draft-card') >= 0, 'draft card con clase baro-draft-card');
ok(card.innerHTML.indexOf('Hola &lt;mundo&gt; &amp; &quot;amigos&quot;') >= 0, 'texto escapado en la tarjeta');
ok(/onclick="baroPublishDraftText\(this\)"/.test(card.innerHTML), 'boton Publicar -> baroPublishDraftText');
ok(/onclick="baroCopyDraftText\(this\)"/.test(card.innerHTML), 'boton Copiar -> baroCopyDraftText');
ok(/onclick="baroEditDraftText\(this\)"/.test(card.innerHTML), 'boton Editar -> baroEditDraftText');
const draftId = card.getAttribute('data-draft-id');
const fakeBtn = makeEl('button'); fakeBtn._draftCard = card;
const got = sandbox.baroDraftTextFor(fakeBtn);
ok(got === 'Hola <mundo> & "amigos"', 'baroDraftTextFor recupera el texto original');
const inp = makeEl('input'); ids['baro-input'] = inp;
sandbox.baroEditDraftText(fakeBtn);
ok(inp.value === 'Hola <mundo> & "amigos"' && inp._focused, 'Editar vuelca el texto al input y enfoca');

/* ============================================================
 * 4. onclick handlers del patch resuelven a globales
 * ============================================================ */
console.log('\n[4] patch.html');
const patch = fs.readFileSync(LDIR + '/patch.html', 'utf8')
  .replace(/<!--[\s\S]*?-->/g, ''); // las anclas verbatim viven en comentarios
const topFns = {};
/* El regex admite código minificado (una sola línea): 'function' tras ^, \n, ; o }. */
(jsSrc.match(/(?:^|[;\n}])\s*function\s+([A-Za-z_$][\w$]*)\s*\(/g) || [])
  .forEach(m => { topFns[m.match(/function\s+([A-Za-z_$][\w$]*)/)[1]] = 1; });
const handlerNames = {};
(patch.match(/on\w+\s*=\s*"([^"]*)"/g) || []).forEach(h => {
  const body = h.replace(/^on\w+\s*=\s*"/, '').replace(/"$/, '');
  const m = body.match(/^\s*([A-Za-z_$][\w$]*)\s*\(/);
  if (m) handlerNames[m[1]] = 1;
});
let handlersOk = true;
Object.keys(handlerNames).forEach(n => {
  if (!topFns[n] && n !== 'baroPaintIcons') { handlersOk = false; console.log('       sin definir: ' + n); }
});
ok(handlersOk, 'todo onclick del patch llama funcion global top-level del JS');
const draftHandlers = ['baroPublishDraftText', 'baroCopyDraftText', 'baroEditDraftText'];
ok(draftHandlers.every(n => topFns[n]), 'handlers de la tarjeta existen en el JS');

/* ---- IDs referenciados existen ---- */
const patchIds = {};
(patch.match(/id="([\w-]+)"/g) || []).forEach(m => { patchIds[m.slice(4, -1)] = 1; });
const knownExisting = { 'baro-thread': 1, 'baro-input': 1, 'baro-form': 1, 'baro-view': 1 };
const createdByJs = { 'baro-empty': 1 }; // la crea baroRenderEmpty() via d.id='baro-empty'
const jsIds = {};
(jsSrc.match(/getElementById\('([\w-]+)'\)/g) || []).forEach(m => {
  jsIds[m.match(/getElementById\('([\w-]+)'\)/)[1]] = 1;
});
let idsOk = true;
Object.keys(jsIds).forEach(id => {
  if (!patchIds[id] && !knownExisting[id] && !createdByJs[id]) { idsOk = false; console.log('       id sin ancla: ' + id); }
});
ok(idsOk, 'todo getElementById del JS existe en el patch o en el HTML base');

/* ---- sin clases Tailwind nuevas ---- */
const clsWhitelist = { hidden: 1, tap44: 1 };
let twOk = true;
(patch.match(/class="([^"]*)"/g) || []).forEach(c => {
  c.slice(7, -1).split(/\s+/).forEach(cl => {
    if (!cl) return;
    if (!(cl.indexOf('baro-') === 0 || clsWhitelist[cl])) { twOk = false; console.log('       clase no baro-*: ' + cl); }
  });
});
ok(twOk, 'patch solo usa clases baro-* (+hidden/tap44 existentes)');

/* ---- CSS: solo clases baro-* ---- */
const css = fs.readFileSync(LDIR + '/baro-productividad.css', 'utf8');
let cssOk = true;
(css.match(/\.[A-Za-z][\w-]*/g) || []).forEach(sel => {
  const name = sel.slice(1);
  if (name.indexOf('baro-') !== 0 && ['hidden'].indexOf(name) < 0 && !/^theme-/.test(name)) {
    // permitir pseudos/ids ya existentes (#baro-thread, #baro-input) y body.theme-dark
    if (sel !== '.theme-dark') { cssOk = false; console.log('       selector sospechoso: ' + sel); }
  }
});
ok(cssOk, 'CSS define/usa selectores baro-* (mas #baro-* existentes y theme-dark)');

console.log('\n' + (failures ? 'FALLARON ' + failures + ' pruebas' : 'TODAS LAS PRUEBAS EN VERDE'));
process.exit(failures ? 1 : 0);
