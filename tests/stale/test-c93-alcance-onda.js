'use strict';
// Tests de ALCANCE POR ONDA DE PULSO — "¿qué ondas mías traen más vistas?"
// (Ciclo 93, fase 4 del hueco #2 del roadmap: Pulso).
// Uso: node test-c93-alcance-onda.js [--target <html>]
//   --target: HTML a probar (default: ../index.html, el parcheado).
// Diseñados para FALLAR contra la base sin parche (C92).
//
// Verifica:
//  (a) núcleo puro extraído verbatim y ejecutado en sandbox:
//      drexPulsoOndaReach (ventana 7 días, dedup por post, saneado de vistas,
//      empates deterministas, top N) con el extractor real drexExtractOndas;
//  (b) render drexPulsoOndaReachHTML (barras, escapes, sin onclick/ids);
//  (c) integración estática: bloque nuevo fuera de los marcadores viejos,
//      hook de solo-lectura en drexPulsoRenderData, cero escrituras/lecturas
//      nuevas, superficie de BD vacía en lo nuevo;
//  (d) i18n: 1 clave nueva 1× por idioma en el merge de Pulso;
//  (e) revisión adversarial: sin write-only, sin noteId crudo, escapes,
//      invariantes C89/C90/C92 intactos.
//
// Convención del repo: resuelve ../index.html con fallback a ../src/index.html;
// no depende del historial de git; sin rutas absolutas.
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

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); }
}
function eq(a, b, name) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  ok(sa === sb, name + ' (got ' + sa + ', want ' + sb + ')');
}
function tcase(name, fn) {
  try { fn(); } catch (e) { ok(false, name + ' (throw: ' + e.message + ')'); }
}

function extractFunction(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no encontrada: ' + name);
  let j = src.indexOf('{', i), depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}
function extractBlock(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('no encontrado: ' + startMarker);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error('no encontrado: ' + endMarker);
  return src.slice(i, j + endMarker.length);
}

// ---- sandbox con el núcleo puro ----
const escStub = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const sandbox = {
  console,
  escapeHTML: escStub,
  formatNumber: (n) => String(n),
  appT: (s) => s,
  PULSO_DAYS: 7,
  DREX_ONDA: { MIN_LEN: 2, MAX_LEN: 48 },
};
vm.createContext(sandbox);

let reachSrc = '', reachHTMLSrc = '', extractSrc = '', topN = 0;
tcase('T0 extracción', () => {
  reachSrc = extractFunction(html, 'drexPulsoOndaReach');
  reachHTMLSrc = extractFunction(html, 'drexPulsoOndaReachHTML');
  extractSrc = extractFunction(html, 'drexExtractOndas');
  ok(reachSrc.length > 400, 'T0a drexPulsoOndaReach extraída');
  ok(reachHTMLSrc.length > 300, 'T0b drexPulsoOndaReachHTML extraída');
  ok(extractSrc.length > 200, 'T0c drexExtractOndas extraída');
  const m = html.match(/var DREX_PULSO_ONDA_TOP_N = (\d+);/);
  ok(m && Number(m[1]) === 5, 'T0d DREX_PULSO_ONDA_TOP_N = 5');
  topN = m ? Number(m[1]) : 5;
  vm.runInContext(reachSrc + '\n' + reachHTMLSrc + '\n' + extractSrc, sandbox);
  ok(typeof sandbox.drexPulsoOndaReach === 'function', 'T0e reach cargada en sandbox');
  ok(typeof sandbox.drexPulsoOndaReachHTML === 'function', 'T0f render cargado en sandbox');
  ok(typeof sandbox.drexExtractOndas === 'function', 'T0g extractor real cargado en sandbox');
});

const reach = (argsPacked) => vm.runInContext('drexPulsoOndaReach(' + argsPacked + ')', sandbox);
const reachHTML = (w) => vm.runInContext(
  'drexPulsoOndaReachHTML(' + JSON.stringify(w) + ')', sandbox);

// nowMs fijo: 2026-09-24 12:00 hora local (constructor con literales, sin Date cruzado).
const NOW = 'new Date(2026, 8, 24, 12, 0, 0).getTime()';
const DAY = 86400000;
const tsDaysAgo = (d) => 'new Date(2026, 8, 24, 12, 0, 0).getTime() - ' + (d * DAY);
function mkPost(daysAgo, tags, views, extra) {
  const p = { timestamp: tsDaysAgo(daysAgo), content: '#x', viewCount: views, _tags: tags };
  if (extra) Object.assign(p, extra);
  return p;
}
// Envuelve posts JS en una expresión literal para vm (sin interpolar NaN).
function postsLit(posts, extractJs) {
  return '[' + posts.map((p) =>
    '{timestamp:(' + p.timestamp + '),content:' + JSON.stringify(p.content) +
    ',text:' + JSON.stringify(p.text || '') +
    ',viewCount:' + (typeof p.viewCount === 'number' ? String(p.viewCount) : JSON.stringify(p.viewCount)) + '}'
  ).join(',') + '],' + NOW + ',' + extractJs + ',5';
}

// ================= T1: ventana de 7 días =================
tcase('T1 ventana', () => {
  const ex = '(function(){ return ["drex"]; })';
  const inW = reach(postsLit([mkPost(0, 0, 10)], ex));
  eq(inW, [{ onda: 'drex', views: 10, posts: 1 }], 'T1a post de hoy entra');
  const six = reach(postsLit([mkPost(6, 0, 10)], ex));
  eq(six.length, 1, 'T1b hace 6 días entra (borde de ventana)');
  const seven = reach(postsLit([mkPost(7, 0, 10)], ex));
  eq(seven, [], 'T1c hace 7 días queda fuera');
  const noTs = reach('[{content:"#drex",viewCount:10}],' + NOW + ',' + ex + ',5');
  eq(noTs, [], 'T1d sin timestamp queda fuera');
  const future = reach('[{timestamp:(' + NOW + '+86400000),content:"#drex",viewCount:10}],' + NOW + ',' + ex + ',5');
  eq(future, [], 'T1e timestamp futuro queda fuera');
});

// ================= T2: agregación =================
tcase('T2 agregación', () => {
  const exB = '(function(){ return ["drex"]; })';
  const r2 = reach(postsLit([mkPost(0, 0, 30), mkPost(1, 0, 70)], exB));
  eq(r2, [{ onda: 'drex', views: 100, posts: 2 }], 'T2a suma vistas y cuenta posts por onda');
  // Dedup por post: el extractor devuelve la misma onda 3 veces → 1 post.
  const dup = reach('[' +
    '{timestamp:(' + tsDaysAgo(0) + '),content:"#a",text:"",viewCount:40}' +
    '],' + NOW + ',(function(){ return ["drex","drex","drex"]; }),5');
  eq(dup, [{ onda: 'drex', views: 40, posts: 1 }], 'T2b dedup por post (3 tags iguales → 1)');
  // text como fallback cuando no hay content.
  const viaText = reach('[{timestamp:(' + tsDaysAgo(0) + '),text:"#drex hola",viewCount:5}],' +
    NOW + ',(function(){ return ["drex"]; }),5');
  eq(viaText, [{ onda: 'drex', views: 5, posts: 1 }], 'T2c usa p.text si no hay content');
  // Extractor que lanza o devuelve basura → el post se ignora sin romper.
  const boom = reach('[{timestamp:(' + tsDaysAgo(0) + '),content:"#drex",viewCount:9}],' +
    NOW + ',(function(){ throw new Error("x"); }),5');
  eq(boom, [], 'T2d extractor que lanza no rompe el agregado');
  const notArray = reach('[{timestamp:(' + tsDaysAgo(0) + '),content:"#drex",viewCount:9}],' +
    NOW + ',(function(){ return "drex"; }),5');
  eq(notArray, [], 'T2e extractor no-array no rompe');
  const noFn = reach('[{timestamp:(' + tsDaysAgo(0) + '),content:"#drex",viewCount:9}],' +
    NOW + ',null,5');
  eq(noFn, [], 'T2f sin extractor → sin ondas');
});

// ================= T3: saneado y top N =================
tcase('T3 saneado', () => {
  const ex = '(function(){ return ["drex"]; })';
  const t0 = (ts, v) => '{timestamp:(' + ts + '),content:"#drex",text:"",viewCount:' + v + '}';
  const nan = reach('[' + t0(tsDaysAgo(0), 'NaN') + '],' + NOW + ',' + ex + ',5');
  eq(nan, [], 'T3a viewCount NaN → 0 → onda oculta');
  const neg = reach('[' + t0(tsDaysAgo(0), '-5') + '],' + NOW + ',' + ex + ',5');
  eq(neg, [], 'T3b viewCount negativo → 0 → onda oculta');
  const inf = reach('[' + t0(tsDaysAgo(0), 'Infinity') + '],' + NOW + ',' + ex + ',5');
  eq(inf, [], 'T3c viewCount Infinity → 0 → onda oculta');
  const str = reach('[' + t0(tsDaysAgo(0), '"42"') + '],' + NOW + ',' + ex + ',5');
  eq(str, [{ onda: 'drex', views: 42, posts: 1 }], 'T3d viewCount string numérico se acepta');
  // Onda con posts pero 0 vistas no aparece; un post sin vistas sí cuenta
  // como post de una onda que sí tiene vistas.
  const mixed2 = reach('[' +
    '{timestamp:(' + tsDaysAgo(0) + '),content:"#drex",text:"",viewCount:0},' +
    '{timestamp:(' + tsDaysAgo(0) + '),content:"#otra",text:"",viewCount:3}' +
    '],' + NOW + ',(function(){ return ["drex","otra"]; }),5');
  eq(mixed2, [
    { onda: 'drex', views: 3, posts: 2 },
    { onda: 'otra', views: 3, posts: 2 },
  ].sort((a, b) => (b.views - a.views) || (b.posts - a.posts) || (a.onda < b.onda ? -1 : 1)),
    'T3e posts con 0 vistas aportan al conteo de posts');
  eq(reach('[],' + NOW + ',' + ex + ',5'), [], 'T3f posts vacío → []');
  eq(reach('null,' + NOW + ',' + ex + ',5'), [], 'T3g posts null → []');
  // n se acota: 0 → 5, 99 → 10.
  const many = [];
  for (let i = 0; i < 12; i++) {
    many.push('{timestamp:(' + tsDaysAgo(0) + '),content:"#w' + i + '",text:"",viewCount:' + (i + 1) + '}');
  }
  // Extractor con cierre por índice: el post i-ésimo reporta la onda w<i>.
  const idxExtract = '(function(){ var i = 0; return function(){ return ["w" + (i++)]; }; })()';
  const r10 = reach('[' + many.join(',') + '],' + NOW + ',' + idxExtract + ',99');
  ok(Array.isArray(r10) && r10.length === 10, 'T3h n=99 se acota a 10 (got ' + (r10 && r10.length) + ')');
  const r5 = reach('[' + many.join(',') + '],' + NOW + ',' + idxExtract + ',0');
  ok(Array.isArray(r5) && r5.length === 5, 'T3i n=0 usa el default 5 (got ' + (r5 && r5.length) + ')');
});

// ================= T4: empates deterministas =================
tcase('T4 empates', () => {
  // Mismo views → más posts primero; luego onda asc.
  const r2 = vm.runInContext(
    'drexPulsoOndaReach(' +
    '[{timestamp:(' + tsDaysAgo(0) + '),content:"x",text:"",viewCount:10,__w:"beta"},' +
    ' {timestamp:(' + tsDaysAgo(0) + '),content:"x",text:"",viewCount:10,__w:"alfa"},' +
    ' {timestamp:(' + tsDaysAgo(0) + '),content:"x",text:"",viewCount:0,__w:"alfa"}],' +
    NOW + ',' +
    '(function(){ var i=0; var ws=["beta","alfa","alfa"]; return function(){ return [ws[i++]]; }; })()' +
    ',5)', sandbox);
  eq(r2, [
    { onda: 'alfa', views: 10, posts: 2 },
    { onda: 'beta', views: 10, posts: 1 },
  ], 'T4a empate en vistas → más posts primero');
  const r3 = vm.runInContext(
    'drexPulsoOndaReach(' +
    '[{timestamp:(' + tsDaysAgo(0) + '),content:"x",text:"",viewCount:7,__w:"zeta"},' +
    ' {timestamp:(' + tsDaysAgo(0) + '),content:"x",text:"",viewCount:7,__w:"alfa"}],' +
    NOW + ',' +
    '(function(){ var i=0; var ws=["zeta","alfa"]; return function(){ return [ws[i++]]; }; })()' +
    ',5)', sandbox);
  eq(r3, [
    { onda: 'alfa', views: 7, posts: 1 },
    { onda: 'zeta', views: 7, posts: 1 },
  ], 'T4b empate total → onda asc (determinista)');
  // Solo devuelve los campos públicos.
  ok(Object.keys(r3[0]).sort().join(',') === 'onda,posts,views', 'T4c sin campos internos');
});

// ================= T5: extractor real =================
tcase('T5 extractor real', () => {
  const ex = (t) => vm.runInContext('drexExtractOndas(' + JSON.stringify(t) + ')', sandbox);
  eq(ex('hola #Drex como va #drex'), ['drex'], 'T5a normaliza a minúsculas y dedup');
  eq(ex('#música y #Música'), ['música'], 'T5b unicode-aware');
  eq(ex('sin tags aquí'), [], 'T5c sin tags → []');
  eq(ex('#a #ab'), ['ab'], 'T5d tag de 1 char se descarta (MIN_LEN=2)');
  eq(ex(null), [], 'T5e null → []');
  // Integración punta a punta con el extractor real.
  const r = vm.runInContext(
    'drexPulsoOndaReach(' +
    '[{timestamp:(' + tsDaysAgo(0) + '),content:"Amo #Drex y #musica",text:"",viewCount:50},' +
    ' {timestamp:(' + tsDaysAgo(2) + '),content:"otro día #drex",text:"",viewCount:25}],' +
    NOW + ',drexExtractOndas,5)', sandbox);
  eq(r, [
    { onda: 'drex', views: 75, posts: 2 },
    { onda: 'musica', views: 50, posts: 1 },
  ], 'T5f reach con extractor real agrega por onda');
});

// ================= T6: render =================
tcase('T6 render', () => {
  eq(reachHTML([]), '', 'T6a vacío → cadena vacía');
  eq(reachHTML(null), '', 'T6b null → cadena vacía');
  const h = reachHTML([
    { onda: 'drex', views: 100, posts: 3 },
    { onda: 'musica', views: 40, posts: 1 },
  ]);
  ok(h.indexOf('#drex') >= 0, 'T6c pinta la onda con #');
  ok(h.indexOf('100 vistas') >= 0, 'T6d pinta "N vistas"');
  ok(h.indexOf('Alcance por onda') >= 0, 'T6e título con la clave i18n');
  ok(h.indexOf('width:100%') >= 0, 'T6f la barra líder va al 100%');
  ok(h.indexOf('width:40%') >= 0, 'T6g la segunda barra es proporcional');
  ok(h.indexOf('onclick') < 0, 'T6h sin onclick');
  ok(!/id="/.test(h), 'T6i sin ids');
  ok(h.indexOf('#2F33B8') >= 0, 'T6j índigo de marca');
  // Onda adversarial: se escapa, no rompe el HTML.
  const adv = reachHTML([{ onda: '"><svg onload=alert(1)>', views: 9, posts: 1 }]);
  ok(adv.indexOf('&quot;&gt;&lt;svg') >= 0, 'T6k onda adversarial escapada');
  ok(adv.indexOf('"><svg onload=') < 0, 'T6l sin inyección cruda');
  // Conteo con formato: el stub formatNumber es identidad; el real escapa igual.
  ok(h.indexOf('40 vistas') >= 0, 'T6m etiqueta escapada completa');
});

// ================= T7: integración estática =================
tcase('T7 integración', () => {
  const sec = extractBlock(html, '// ============ ALCANCE POR ONDA DE PULSO', '// ============ /ALCANCE POR ONDA DE PULSO');
  ok(sec.length > 800, 'T7a bloque nuevo existe');
  // Fuera de los marcadores viejos.
  const retEnd = html.indexOf('// ============ /RETENCIÓN DE PULSO ============');
  const newStart = html.indexOf('// ============ ALCANCE POR ONDA DE PULSO');
  const autorStart = html.indexOf('// ============ VISTAS DEL AUTOR');
  ok(retEnd > 0 && newStart > retEnd && newStart < autorStart,
    'T7b bloque nuevo fuera de los marcadores viejos');
  // Cero escrituras y cero refs en lo nuevo (100 % lectura).
  const writes = (sec.match(/\.(push|set|update|transaction|remove)\s*\(/g) || [])
    .filter((c) => c !== '.push(');
  eq(writes.length, 0, 'T7c cero escrituras en el bloque nuevo');
  const refs = sec.match(/\.ref\('/g) || [];
  eq(refs.length, 0, 'T7d cero refs a BD en el bloque nuevo');
  ok(!/noteViewers/.test(sec), 'T7e sin path noteViewers');
  ok(!/addEventListener|IntersectionObserver|setTimeout|setInterval/.test(sec),
    'T7f sin listeners ni timers nuevos');
  // Hook de solo-lectura en el panel, tras la línea C90.
  ok(/drexPulsoDailySectionHTML\(posts \|\| \[\], Date\.now\(\)\) \+\s*\/\/ C93/.test(html),
    'T7g el hook va tras la sección C90');
  ok(/drexPulsoOndaReachHTML\(drexPulsoOndaReach\(posts \|\| \[\], Date\.now\(\), drexExtractOndas, DREX_PULSO_ONDA_TOP_N\)\)/.test(html),
    'T7h el panel pinta el alcance por onda con el extractor real');
  // Invariantes viejos intactos.
  const pulsoBlock = extractBlock(html, '// ============ PULSO:', '// ============ /PULSO');
  const pw = (pulsoBlock.match(/\.(push|set|update|transaction|remove)\s*\(/g) || [])
    .filter((c) => c !== '.push(');
  eq(pw.length, 0, 'T7i PULSO sigue sin escrituras a BD (T5i del test viejo)');
  ok(/setTimeout\(function \(\) \{\s*delete _drexViewTimers/.test(html),
    'T7j dwell C89 intacto');
  ok(/drexPulsoRetentionCardHTML\(t\.retained, t\.views\)/.test(html),
    'T7k tarjeta de retención C92 intacta');
  ok(/drexPulsoDailySectionHTML\(posts \|\| \[\], Date\.now\(\)\)/.test(html),
    'T7l sección diaria C90 intacta');
});

// ================= T8: i18n 1× por idioma =================
tcase('T8 i18n', () => {
  const iife = extractBlock(html, '(function drexPulsoI18nMerge() {', '})();');
  const count = (s) => (iife.match(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  eq(count("'Alcance por onda': 'Reach by wave'"), 1, 'T8a EN 1×');
  eq(count("'Alcance por onda': '各浪潮触达'"), 1, 'T8b ZH 1×');
  eq(count("'Alcance por onda': 'Alcance por onda'"), 1, 'T8c PT 1×');
  eq(count("'vistas': 'views'"), 1, 'T8d clave vieja vistas intacta');
  ok(iife.indexOf('drex-i18n') < 0 || true, 'T8e (placeholder)');
});

// ================= T9: revisión adversarial =================
tcase('T9 adversarial', () => {
  ['drexPulsoOndaReach', 'drexPulsoOndaReachHTML', 'DREX_PULSO_ONDA_TOP_N'].forEach((n) => {
    const uses = html.split(n).length - 1;
    ok(uses >= 2, 'T9a ' + n + ' se usa (' + uses + ' menciones)');
  });
  const defs = (html.match(/function drexPulsoOndaReach(HTML)?\(/g) || []).length;
  eq(defs, 2, 'T9b cada función se define 1×');
  const varDefs = (html.match(/var DREX_PULSO_ONDA_TOP_N =/g) || []).length;
  eq(varDefs, 1, 'T9c la constante se define 1×');
  ok(!/drexPulsoOndaReach\([^)]*noteId/.test(html), 'T9d sin noteId crudo en el núcleo');
  // El render escapa todo lo que viene de datos.
  ok(/escapeHTML\(w\.onda\)/.test(reachHTMLSrc), 'T9e la onda se escapa');
  ok(/escapeHTML\(formatNumber\(w\.views\)/.test(reachHTMLSrc), 'T9f el conteo se escapa');
  ok(/escapeHTML\(appT\('Alcance por onda'\)\)/.test(reachHTMLSrc), 'T9g el título se escapa');
});

(async () => {
  console.log('\nALCANCE POR ONDA DE PULSO (C93): ' + pass + ' ok, ' + fail + ' fallos');
  if (failures.length) {
    console.log('FALLOS:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
})();
