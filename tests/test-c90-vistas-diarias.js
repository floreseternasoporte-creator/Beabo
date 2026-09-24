'use strict';
// Tests de VISTAS DIARIAS DE PULSO — desglose por día + top de posts (Ciclo 90,
// fase 2b del hueco #2 del roadmap).
// Uso: node test-c90-vistas-diarias.js [--target <html>]
//   --target: HTML a probar (default: ../index.html, el parcheado).
// Diseñados para FALLAR contra la base sin parche (C89).
//
// Verifica:
//  (a) núcleo puro extraído verbatim y ejecutado en sandbox:
//      drexViewCoreDayKey, drexPulsoViewsByDay, drexPulsoTopViewed,
//      drexViewCoreMarkerUpdate / drexViewCoreCountUpdate (reutilizados),
//      const DREX_PULSO_TOP_N;
//  (b) integración estática: llamada a drexViewRecordDay desde drexViewRecord,
//      marcador diario userViews/<uid>/<dayKey>/<noteId>, contador
//      communityNotes/<noteId>/viewDays/<dayKey>, sección diaria en el panel,
//      el bloque PULSO sigue sin escrituras, superficie de BD acotada;
//  (c) i18n: claves nuevas 1× por idioma en el merge de Pulso;
//  (d) revisión adversarial: dayKey con formato válido, ids sanitizados,
//      sin write-only, sin noteViewers.
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
function extractConst(src, name) {
  const m = src.match(new RegExp('var ' + name + ' = ([^;]+);'));
  if (!m) throw new Error('no encontrada const: ' + name);
  return 'var ' + name + ' = ' + m[1] + ';';
}
function extractBlock(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('no encontrado: ' + startMarker);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error('no encontrado: ' + endMarker);
  return src.slice(i, j + endMarker.length);
}

// ---- sandbox con el núcleo puro ----
const sandbox = { PULSO_DAYS: 7, console };
vm.createContext(sandbox);
let coreSrc = '';
tcase('T0 extracción del núcleo', () => {
  coreSrc =
    extractConst(html, 'PULSO_DAYS') + '\n' +
    extractConst(html, 'DREX_PULSO_TOP_N') + '\n' +
    extractFunction(html, 'drexViewCoreDayKey') + '\n' +
    extractFunction(html, 'drexViewCoreMarkerUpdate') + '\n' +
    extractFunction(html, 'drexViewCoreCountUpdate') + '\n' +
    extractFunction(html, 'drexPulsoViewsByDay') + '\n' +
    extractFunction(html, 'drexPulsoTopViewed') + '\n';
  vm.runInContext(coreSrc, sandbox);
});
const dayKey = (ts) => vm.runInContext('drexViewCoreDayKey(' + JSON.stringify(ts) + ')', sandbox);
const dayKeyRaw = (expr) => vm.runInContext('drexViewCoreDayKey(' + expr + ')', sandbox);
const viewsByDay = (posts, now) =>
  vm.runInContext('drexPulsoViewsByDay(' + JSON.stringify(posts) + ', ' + now + ')', sandbox);
const topViewed = (posts, n) =>
  vm.runInContext('drexPulsoTopViewed(' + JSON.stringify(posts) + ', ' + n + ')', sandbox);

const dayMs = 86400000;
const NOW = Date.now();
const sod = new Date(NOW); sod.setHours(0, 0, 0, 0);
const T0 = sod.getTime();
let K0 = '', K1 = '', K2 = '', K6 = '';
tcase('T0b claves de día', () => {
  K0 = dayKey(T0 + 3600000);
  K1 = dayKey(T0 - 1 * dayMs + 3600000);
  K2 = dayKey(T0 - 2 * dayMs + 3600000);
  K6 = dayKey(T0 - 6 * dayMs + 3600000);
  ok(/^\d{4}-\d{2}-\d{2}$/.test(K0), 'T0b formato de claves');
});

// ================= T1: drexViewCoreDayKey =================
tcase('T1 dayKey', () => {
  ok(/^\d{4}-\d{2}-\d{2}$/.test(dayKey(NOW)), 'T1a formato yyyy-mm-dd');
  ok(dayKeyRaw('NaN') === '' && dayKeyRaw('"basura"') === '' && dayKey('') === '', 'T1b inválido → vacío');
  const d = new Date(T0 + 3600000);
  const want = d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
  eq(dayKey(T0 + 3600000), want, 'T1c coincide con la fecha local');
  ok(!/[.#$/\[\]]/.test(K0), 'T1d sin chars prohibidos de ruta Firebase');
});

// ================= T2: drexPulsoViewsByDay =================
tcase('T2 viewsByDay', () => {
  const posts = [
    { timestamp: T0 + 1000, viewDays: { [K0]: 5, [K1]: 3 } },
    { timestamp: T0 - 2 * dayMs + 1000, viewDays: { [K2]: 7, [K6]: 2 } },
    { timestamp: T0 - 6 * dayMs + 1000, viewDays: { [K6]: 4 } },
    { timestamp: T0 + 2000 },                        // sin viewDays → 0
    { timestamp: T0 - 30 * dayMs, viewDays: { [K0]: 999 } }, // fuera de ventana
    null,
  ];
  const r = viewsByDay(posts, NOW);
  eq(r.length, 7, 'T2a 7 buckets');
  eq(r[6].views, 5, 'T2b hoy = 5');
  eq(r[5].views, 3, 'T2c ayer = 3');
  eq(r[4].views, 7, 'T2d hace-2 = 7');
  eq(r[0].views, 6, 'T2e hace-6 = 2+4');
  eq(r[1].views + r[2].views + r[3].views, 0, 'T2f resto en 0');
  ok(r.every((d) => d.date && typeof d.date.getTime === 'function'), 'T2g date es Date');
  const empty = viewsByDay([], NOW);
  ok(empty.length === 7 && empty.every((d) => d.views === 0), 'T2h vacío → ceros');
  const novd = viewsByDay([{ timestamp: T0 + 1, viewCount: 50 }], NOW);
  ok(novd.every((d) => d.views === 0), 'T2i post viejo sin viewDays → 0 (no usa viewCount)');
  const bad = viewsByDay([{ timestamp: T0 + 1, viewDays: { 'no-es-fecha': 9, [K0]: '4' } }], NOW);
  eq(bad[6].views, 4, 'T2j claves ajenas ignoradas, strings numéricos aceptados');
});

// ================= T3: drexPulsoTopViewed =================
tcase('T3 topViewed', () => {
  const posts = [
    { _pid: 'a', content: 'hola mundo', viewCount: 10, timestamp: T0 + 1 },
    { _pid: 'b', text: 'segundo', viewCount: 30, timestamp: T0 + 2 },
    { _pid: 'c', content: 'tercero', viewCount: 30, timestamp: T0 + 3 },
    { _pid: 'd', content: 'sin vistas', viewCount: 0, timestamp: T0 + 4 },
    { _pid: 'e', content: 'negativo', viewCount: -5, timestamp: T0 + 5 },
    null,
  ];
  const r = topViewed(posts, 5);
  eq(r.length, 3, 'T3a solo views>0');
  eq(r[0].pid, 'c', 'T3b empate → más reciente primero');
  eq(r[1].pid, 'b', 'T3c orden desc por vistas');
  eq(r[2].pid, 'a', 'T3d tercero');
  ok(!('ts' in r[0]), 'T3e sin campos internos (ts)');
  const r2 = topViewed(posts, 2);
  eq(r2.length, 2, 'T3f respeta el límite n');
  const r3 = topViewed([{ viewCount: 3, content: 'x', timestamp: T0 }], 5);
  eq(r3[0].pid, '', 'T3g sin _pid ni id → pid vacío (no rompe)');
  const r4 = topViewed([{ id: 'z9', text: 't', viewCount: 1, timestamp: T0 }], 5);
  eq(r4[0].pid, 'z9', 'T3h fallback a p.id');
});

// ================= T4: reutilización del núcleo C89 =================
tcase('T4 núcleo C89 reutilizado', () => {
  const mu = (cur, now) => vm.runInContext(
    'drexViewCoreMarkerUpdate(' + JSON.stringify(cur) + ', ' + now + ')', sandbox);
  const cu = (cur) => vm.runInContext(
    'drexViewCoreCountUpdate(' + JSON.stringify(cur) + ')', sandbox);
  eq(mu(null, 1700000000000), 1700000000000, 'T4a marcador diario aborta si existe');
  eq(mu(1699999999999, 1700000000000), undefined, 'T4b marcador existente → abort');
  eq(cu(null), 1, 'T4c contador diario +1 tolerante');
  eq(cu(41), 42, 'T4d contador diario suma');
});

// ================= T5: integración estática =================
tcase('T5 integración', () => {
  ok(/drexViewRecordDay\(db, uid, id\)/.test(html),
    'T5a drexViewRecord llama a drexViewRecordDay(db, uid, id)');
  ok(/ref\('userViews\/' \+ uid \+ '\/' \+ dayKey \+ '\/' \+ id\)/.test(html),
    'T5b marcador diario userViews/<uid>/<dayKey>/<noteId>');
  ok(/ref\('communityNotes\/' \+ id \+ '\/viewDays\/' \+ dayKey\)/.test(html),
    'T5c contador communityNotes/<id>/viewDays/<dayKey>');
  ok(/\.transaction\(drexViewCoreCountUpdate\)/.test(
    extractFunction(html, 'drexViewRecordDay')),
    'T5d el contador diario usa transacción (sin doble conteo)');
  ok(/drexPulsoDailySectionHTML\(posts \|\| \[\], Date\.now\(\)\)/.test(html),
    'T5e el panel pinta la sección diaria');
  ok(/child\.key/.test(html) && /v\._pid = child\.key/.test(html),
    'T5f readAuthorPosts adjunta _pid (id para el top)');
  ok(/openPostPermalink\(\\?'/.test(extractFunction(html, 'drexPulsoTopViewedHTML')),
    'T5g el top abre el permalink del post');
  ok(!/noteViewers/.test(html), 'T5h sin path noteViewers');
  // El bloque PULSO sigue sin escrituras (invariante del test viejo).
  const pulsoBlock = extractBlock(html, '// ============ PULSO:', '// ============ /PULSO');
  const writes = (pulsoBlock.match(/\.(push|set|update|transaction|remove)\s*\(/g) || [])
    .filter((c) => c !== '.push(');
  ok(writes.length === 0, 'T5i PULSO sigue sin escrituras a BD');
  // Superficie de BD acotada: solo userViews/ y communityNotes/ en lo nuevo.
  const c90 = extractBlock(html, '// ============ VISTAS DIARIAS DE PULSO', '// ============ /VISTAS DIARIAS DE PULSO');
  const refs = (c90.match(/\.ref\('[^']+'/g) || []).map((s) => s.slice(6, -1));
  ok(refs.every((r) => r.indexOf('userViews/') === 0 || r.indexOf('communityNotes/') === 0),
    'T5j refs del bloque C90 acotadas (userViews/, communityNotes/): ' + refs.join(','));
});

// ================= T6: i18n 1× por idioma =================
tcase('T6 i18n', () => {
  const iife = extractBlock(html, '(function drexPulsoI18nMerge() {', '})();');
  const count = (s) => (iife.match(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  eq(count("'Vistas por día': 'Views per day'"), 1, 'T6a EN Vistas por día 1×');
  eq(count("'Vistas por día': '每日浏览量'"), 1, 'T6b ZH Vistas por día 1×');
  eq(count("'Vistas por día': 'Visualizações por dia'"), 1, 'T6c PT Vistas por día 1×');
  eq(count("'Posts más vistos': 'Most viewed posts'"), 1, 'T6d EN Posts más vistos 1×');
  eq(count("'Posts más vistos': '浏览量最高的帖子'"), 1, 'T6e ZH Posts más vistos 1×');
  eq(count("'Posts más vistos': 'Posts mais vistos'"), 1, 'T6f PT Posts más vistos 1×');
  eq(count("'vistas': 'views'"), 1, 'T6g EN vistas 1×');
  eq(count("'vistas': '次浏览'"), 1, 'T6h ZH vistas 1×');
  eq(count("'vistas': 'visualizações'"), 1, 'T6i PT vistas 1×');
  // Las 12 claves viejas siguen intactas (paridad del test de Pulso).
  eq(count("'Vistas': 'Views'"), 1, 'T6j clave vieja Vistas intacta');
});

// ================= T7: revisión adversarial =================
tcase('T7 adversarial', () => {
  const recDay = extractFunction(html, 'drexViewRecordDay');
  ok(recDay.includes('drexViewCoreSafeId') || /var id = drexViewCoreSafeId\(noteId\)/.test(extractFunction(html, 'drexViewRecord')),
    'T7a el id llega sanitizado desde drexViewRecord');
  ok(!/\bnoteId\b/.test(recDay),
    'T7b drexViewRecordDay no toca el noteId crudo (solo id sanitizado)');
  ok(!/ref\('userViews\/' \+ [^)]*noteId[^)]*\)/.test(recDay),
    'T7c ningún ref usa el noteId crudo');
  // Sin write-only: las funciones nuevas se leen donde se definen.
  ['drexViewCoreDayKey', 'drexViewRecordDay', 'drexPulsoViewsByDay',
   'drexPulsoTopViewed', 'drexPulsoDailySectionHTML',
   'drexPulsoViewsChartHTML', 'drexPulsoTopViewedHTML'].forEach((n) => {
    const uses = html.split(n).length - 1;
    ok(uses >= 2, 'T7d ' + n + ' se usa (' + uses + ' menciones)');
  });
  // El dayKey nunca puede inyectar ruta: solo dígitos y guiones.
  ok(/^\d{4}-\d{2}-\d{2}$/.test(dayKey(Date.now())), 'T7e dayKey seguro para rutas');
  // drexViewRecord conserva sus invariantes C89.
  const rec = extractFunction(html, 'drexViewRecord');
  ok(rec.includes("if (!drexViewCoreShouldRecord(_drexViewedSet, id, uid)) return;"),
    'T7f record falla cerrado sin uid (C89 intacto)');
  ok(/ref\('userViews\/' \+ uid \+ '\/' \+ id\)/.test(html),
    'T7g marcador ever C89 intacto');
});

console.log('\nVISTAS DIARIAS DE PULSO (C90): ' + pass + ' ok, ' + fail + ' fallos');
if (failures.length) {
  console.log('FALLOS:');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(fail ? 1 : 0);
