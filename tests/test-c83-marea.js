'use strict';
// Tests de MI MAREA (v1) — Ciclo 83.
// Uso: node test-c83-marea.js [--target <html>]
//   --target: HTML a probar (default: ../index.html, el parcheado).
// Diseñados para FALLAR contra la base sin parche.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const target = (() => {
  const i = process.argv.indexOf('--target');
  return i >= 0 && process.argv[i + 1]
    ? path.resolve(process.argv[i + 1])
    : path.resolve(__dirname, '..', 'index.html');
})();

const html = fs.readFileSync(target, 'utf8');
const i18nSrc = fs.readFileSync(path.resolve(__dirname, '..', 'drex-i18n.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); console.error('FAIL:', name); }
}
function eq(a, b, name) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  ok(sa === sb, name + ' (esperado ' + sb + ', obtenido ' + sa + ')');
}

// ---- extracción verbatim del HTML ----
function extractRegion(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  const j = src.indexOf(endMarker, i);
  if (i < 0 || j < 0) throw new Error('región no encontrada: ' + startMarker);
  // Incluir el '//' inicial de la línea del marcador (si no, el slice
  // empieza con '=====' crudo y el eval falla).
  const lineStart = src.lastIndexOf('\n', i) + 1;
  return src.slice(lineStart, j + endMarker.length);
}
function extractConstObject(src, name) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*\\{').exec(src);
  if (!m) throw new Error('const no encontrada en el HTML: ' + name);
  let i = src.indexOf('{', m.index);
  let depth = 0, inStr = null, esc = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error('llaves sin balancear: ' + name);
}
function extractFunction(src, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('función no encontrada en el HTML: ' + name);
  let i = src.indexOf('{', m.index);
  let depth = 0, inStr = null, esc = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error('llaves sin balancear: ' + name);
}

// Sandbox con stubs mínimos.
function makeSandbox() {
  const store = new Map();
  const localStorageStub = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    _store: store
  };
  const sandbox = { localStorage: localStorageStub, console };
  vm.createContext(sandbox);
  return sandbox;
}

// ============================================================
// T1 — Módulo MI MAREA existe y no escribe a BD (privacidad)
// ============================================================
let mareaRegion = null;
try {
  mareaRegion = extractRegion(html, '===== MI MAREA v1 — inicio =====', '===== MI MAREA v1 — fin =====');
  ok(true, 'T1a región MI MAREA presente en el HTML');
} catch (e) {
  ok(false, 'T1a región MI MAREA presente en el HTML: ' + e.message);
}
if (mareaRegion) {
  // Sin DrexCloud en el módulo = sin lecturas ni escrituras a BD: el
  // filtro de Mi Marea es 100 % local (el `.push(` de array es falso
  // positivo, por eso se busca la raíz del cliente de datos).
  ok(!/DrexCloud/.test(mareaRegion), 'T1b el módulo MI MAREA no toca la BD (sin DrexCloud: filtro 100 % local)');
  ok(mareaRegion.includes("drex_ondas_followed_v1"), 'T1c ondas seguidas en localStorage (clave drex_ondas_followed_v1)');
  ok(mareaRegion.includes('normaliz'), 'T1d el módulo documenta la normalización por nicho');
}

// ============================================================
// T2 — Funciones puras extraídas verbatim
// ============================================================
const sandbox = makeSandbox();
try {
  const prelude = extractConstObject(html, 'DREX_ONDA') + '\n' +
    extractFunction(html, 'drexExtractOndas') + '\n' +
    extractFunction(html, 'ecoCountOf') + '\n' +
    mareaRegion;
  vm.runInContext(prelude, sandbox, { filename: 'marea-prelude.js' });
  ok(true, 'T2a prelude (DREX_ONDA + extractor + ecoCountOf + MI MAREA) evalúa sin errores');
} catch (e) {
  ok(false, 'T2a prelude evalúa sin errores: ' + e.message);
}

function run(expr) { return vm.runInContext(expr, sandbox); }

// T2b — intersección ondas del post ∩ seguidas
try {
  run('var __set = new Set(["cine","terror"]);');
  eq(run('drexMareaNoteWaves({content:"Amé esta peli #Cine y #terror!"}, __set)'), ['cine', 'terror'], 'T2b intersección case-insensitive');
  eq(run('drexMareaNoteWaves({content:"sin tags"}, __set)'), [], 'T2c sin tags → vacío');
  eq(run('drexMareaNoteWaves({content:"#cine #cine"}, new Set(["cine"]))'), ['cine'], 'T2d dedup por tag');
  eq(run('drexMareaNoteWaves({content:"#café #日本語"}, new Set(["café","日本語"]))'), ['café', '日本語'], 'T2e unicode-aware');
  eq(run('drexMareaNoteWaves({content:"#x #cine"}, new Set(["cine"]))'), ['cine'], 'T2f tag corto (<2) ignorado por el extractor');
  eq(run('drexMareaNoteWaves({content:"#cine"}, new Set())'), [], 'T2g set vacío → vacío (no lee localStorage)');
  eq(run('drexMareaNoteWaves({content:"#cine"}, null)'), [], 'T2h localStorage vacío → vacío');
} catch (e) { ok(false, 'T2b-h intersección: ' + e.message); }

// T2i — persistencia de seguidas (round-trip, toggle, cap, limpieza)
try {
  run('drexMareaToggleFollow("cine")');
  run('drexMareaToggleFollow("terror")');
  eq(run('drexMareaReadFollowed()'), ['cine', 'terror'], 'T2i toggle agrega y persiste');
  ok(run('drexMareaIsFollowing("cine")') === true, 'T2j isFollowing true');
  run('drexMareaToggleFollow("cine")');
  eq(run('drexMareaReadFollowed()'), ['terror'], 'T2k toggle quita');
  ok(run('drexMareaIsFollowing("cine")') === false, 'T2l isFollowing false tras quitar');
  // Cap MAX_FOLLOWED
  run('var __big=[]; for (var i=0;i<300;i++) __big.push("onda"+i); drexMareaPersistFollowed(__big);');
  ok(run('drexMareaReadFollowed().length') === 200, 'T2m cap de 200 ondas seguidas');
  // Limpieza de basura
  run('localStorage.setItem("drex_ondas_followed_v1", JSON.stringify(["ok", 42, null, "x", "ok"]))');
  eq(run('drexMareaReadFollowed()'), ['ok'], 'T2n filtra no-strings, cortos y duplicados');
  run('localStorage.setItem("drex_ondas_followed_v1", "no-json{{{")');
  eq(run('drexMareaReadFollowed()'), [], 'T2o JSON corrupto → [] sin lanzar');
  run('localStorage.removeItem("drex_ondas_followed_v1")');
} catch (e) { ok(false, 'T2i-o persistencia: ' + e.message); }

// T2p — puntaje crudo: netos + 2*ecos + encuesta
try {
  eq(run('drexMareaRawScore({upvotes:10, downvotes:3, ecosCount:4, poll:{total:5}})'), 7 + 8 + 5, 'T2p fórmula net+2*ecos+poll');
  eq(run('drexMareaRawScore({upvotes:10, downvotes:3, repostsCount:4})'), 7 + 8, 'T2q ecoCountOf usa repostsCount legacy');
  eq(run('drexMareaRawScore({})'), 0, 'T2r nota vacía → 0');
  eq(run('drexMareaRawScore(null)'), 0, 'T2s null → 0');
} catch (e) { ok(false, 'T2p-s raw score: ' + e.message); }

// T2t — normalización por nicho y orden
try {
  run(`var __batch = [
    {id:'A', timestamp:100, upvotes:100, _mareaWaves:['gigante']},
    {id:'B', timestamp:300, upvotes:40,  _mareaWaves:['gigante']},
    {id:'C', timestamp:200, upvotes:8,   _mareaWaves:['nicho']}
  ];
  var __ctx = {};
  var __sorted = drexMareaSortBatch(__ctx, __batch);`);
  eq(run('__sorted.map(n=>n.id)'), ['C', 'A', 'B'], 'T2t orden: el mejor del nicho pequeño (C, norm 1.0) supera al gigante mediano (B, norm 0.4)');
  eq(run('__sorted.map(n=>n._mareaNorm)'), [1, 1, 0.4], 'T2u normas: C=1 (8/8), A=1 (100/100), B=0.4 (40/100)');
  eq(run('__ctx._mareaWaveMax'), { gigante: 100, nicho: 8 }, 'T2v waveMax por onda');
  // Nota multi-onda: se normaliza contra el MAYOR de los máximos de sus ondas.
  run(`var __ctx2 = {};
       var __sorted2 = drexMareaSortBatch(__ctx2, [
         {id:'A', timestamp:100, upvotes:100, _mareaWaves:['gigante']},
         {id:'D', timestamp:150, upvotes:20,  _mareaWaves:['gigante','nicho']},
         {id:'C', timestamp:200, upvotes:8,   _mareaWaves:['nicho']}
       ]);`);
  eq(run('__sorted2.map(n=>n.id+":"+n._mareaNorm)'), ['A:1', 'C:0.4', 'D:0.2'], 'T2u2 multi-onda: D=20/max(100,20)=0.2; C=8/20=0.4');
  // En vivo: nota que supera el máximo crece el máximo y mantiene norm 1
  run(`var __live = {id:'E', timestamp:500, upvotes:150, _mareaWaves:['gigante']};
       var __ln = drexMareaLiveNorm(__ctx, __live);`);
  eq(run('__ln'), 1, 'T2w live: supera el máximo → norm 1');
  eq(run('__ctx._mareaWaveMax.gigante'), 150, 'T2x live: el máximo del tab crece');
  run(`var __live2 = {id:'F', timestamp:600, upvotes:75, _mareaWaves:['gigante']};`);
  eq(run('drexMareaLiveNorm(__ctx, __live2)'), 0.5, 'T2y live: 75/150 = 0.5');
  run(`var __live3 = {id:'G', timestamp:700, upvotes:0, _mareaWaves:['nicho']};`);
  eq(run('drexMareaLiveNorm(__ctx, __live3)'), 0, 'T2z live: raw 0 → norm 0');
} catch (e) { ok(false, 'T2t-z ranking: ' + e.message); }

// ============================================================
// T3 — Integración estática en el HTML
// ============================================================
ok(html.includes('data-tab="marea"'), 'T3a cuarto tab data-tab="marea" en el HTML');
ok(/onclick="switchFeedTab\('marea'\)"/.test(html), 'T3b el tab llama switchFeedTab(\'marea\')');
// Orden sticky: marea va DESPUÉS de popular
{
  const iFor = html.indexOf('data-tab="foryou"');
  const iFol = html.indexOf('data-tab="following"');
  const iPop = html.indexOf('data-tab="popular"');
  const iMar = html.indexOf('data-tab="marea"');
  ok(iFor > -1 && iFor < iFol && iFol < iPop && iPop < iMar, 'T3c orden sticky: foryou < following < popular < marea');
}
ok(/tab === 'marea'\)\s*\{\s*loadNotes\(false, 'marea'\)/.test(html), 'T3d switchFeedTab rama marea → loadNotes(false, \'marea\')');
ok(html.includes("appT('Mostrando tu marea')"), 'T3e toast traducido al cambiar al tab');
ok(html.includes("ctx.feedMode === 'marea'") && html.includes('_mareaWaves = drexMareaNoteWaves'), 'T3f snfPrepareFeedNote filtra por ondas seguidas');
ok(html.includes('drexMareaSortBatch(ctx, ctx._initialBatch)'), 'T3g snfMountInitialBatch usa ranking propio en marea');
ok(html.includes("ctx.feedMode === 'popular' || ctx.feedMode === 'marea'"), 'T3h mount/counters tratan marea como modo ordenado por puntaje');
ok(html.includes('drexMareaLiveNorm(ctx, note)'), 'T3i reposición en vivo con norma re-normalizada');
ok(html.includes("feedMode === 'marea'") && html.includes('Tu marea está vacía'), 'T3j empty-state propio de marea');
ok(html.includes('drex-marea-cta') && html.includes('onclick="openOndasView()"'), 'T3k CTA del vacío abre la vista Ondas');
ok(html.includes('.drex-marea-followbtn'), 'T3l CSS del botón Seguir presente');
ok(html.includes('body.theme-dark .drex-marea-followbtn'), 'T3m CSS oscuro del botón Seguir presente');
ok(html.includes('drexMareaToggleFollow') && html.includes('stopPropagation'), 'T3n fila de Ondas: toggle Seguir sin abrir el hashtag');
ok(html.includes("aria-pressed"), 'T3o botón Seguir con aria-pressed');
ok(html.includes('_mareaFollowedSet'), 'T3p el set de seguidas se congela en el ctx de la suscripción');

// ============================================================
// T4 — i18n EN/ZH/PT en drex-i18n.js
// ============================================================
const MAREA_KEYS = [
  'Mostrando tu marea',
  'Tu marea está vacía',
  'Sigue ondas en Descubrir para llenarla con tus temas.',
  'Descubrir ondas',
  'Sin posts en tus ondas todavía'
];
function dictBlock(src, varName) {
  const i = src.indexOf('var ' + varName + ' = {');
  const j = src.indexOf('};', i);
  return src.slice(i, j);
}
['APP_ENGLISH_TEXT', 'APP_CHINESE_TEXT', 'APP_PORTUGUESE_TEXT'].forEach(vn => {
  const blk = dictBlock(i18nSrc, vn);
  MAREA_KEYS.forEach(k => {
    ok(blk.includes('"' + k + '":"') || blk.includes('"' + k + '": "'), 'T4 ' + vn + ' tiene "' + k + '"');
  });
});
// Sin duplicados de clave dentro de cada dict
['APP_ENGLISH_TEXT', 'APP_CHINESE_TEXT', 'APP_PORTUGUESE_TEXT'].forEach(vn => {
  const blk = dictBlock(i18nSrc, vn);
  MAREA_KEYS.forEach(k => {
    const n = blk.split('"' + k + '":').length - 1;
    ok(n === 1, 'T4dup ' + vn + ' "' + k + '" aparece exactamente 1 vez');
  });
});

// ============================================================
// T5 — Privacidad: el filtro es local (sin lectura de perfiles ajenos)
// ============================================================
ok(!/drexMareaNoteWaves\([^)]*user/.test(mareaRegion || ''), 'T5a el filtro no depende de datos de otros usuarios');

console.log('\n==== test-c83-marea: ' + pass + ' OK, ' + fail + ' FAIL ====');
if (failures.length) { console.log('Fallos:'); failures.forEach(f => console.log(' - ' + f)); }
process.exit(fail ? 1 : 0);
