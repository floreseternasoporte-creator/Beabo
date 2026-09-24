'use strict';
// Tests de VISTAS DE PULSO — registro de vistas de posts (Ciclo 89, fase 2 del
// hueco #2 del roadmap: "los posts no registran vistas").
// Uso: node test-c89-vistas.js [--target <html>]
//   --target: HTML a probar (default: ../index.html, el parcheado).
// Diseñados para FALLAR contra la base sin parche.
//
// Verifica:
//  (a) núcleo puro extraído verbatim y ejecutado en sandbox:
//      drexViewCoreSafeId, drexViewCoreShouldRecord, drexViewCoreMark,
//      drexViewCoreMarkerUpdate, drexViewCoreCountUpdate, drexViewNoteIdOf,
//      consts DREX_VIEW_DWELL_MS / DREX_VIEW_THRESHOLD, drexPulsoAggregate
//      (extendido con views);
//  (b) integración estática: hook en _enhancePostCard, hook del permalink,
//      observer con dwell, superficie de BD acotada (userViews/ + viewCount),
//      stat "Vistas" en el panel de Pulso, clave i18n 1× por idioma;
//  (c) revisión adversarial: safeId antes de cada construcción de ruta.
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

// ---- extracción de código fuente del HTML ----
function extractConst(src, name) {
  const m = new RegExp('var\\s+' + name + '\\s*=\\s*([^;]+);').exec(src);
  if (!m) throw new Error('const no encontrada en el HTML: ' + name);
  return 'var ' + name + ' = ' + m[1] + ';';
}
function extractFunction(src, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('función no encontrada en el HTML: ' + name);
  let i = src.indexOf('{', m.index);
  if (i < 0) throw new Error('sin cuerpo: ' + name);
  let depth = 0, inStr = null, esc = false;
  const start = m.index;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

let safeId, shouldRecord, mark, markerUpdate, countUpdate, noteIdOf, aggregate;
let DWELL_MS, THRESHOLD, PULSO_DAYS_V;
tcase('T0 extracción del núcleo', () => {
  const code =
    extractConst(html, 'DREX_VIEW_DWELL_MS') + '\n' +
    extractConst(html, 'DREX_VIEW_THRESHOLD') + '\n' +
    extractConst(html, 'PULSO_DAYS') + '\n' +
    extractFunction(html, 'drexViewCoreSafeId') + '\n' +
    extractFunction(html, 'drexViewCoreShouldRecord') + '\n' +
    extractFunction(html, 'drexViewCoreMark') + '\n' +
    extractFunction(html, 'drexViewCoreMarkerUpdate') + '\n' +
    extractFunction(html, 'drexViewCoreCountUpdate') + '\n' +
    extractFunction(html, 'drexViewNoteIdOf') + '\n' +
    extractFunction(html, 'drexPulsoAggregate');
  const box = {};
  vm.createContext(box);
  vm.runInContext(code, box);
  safeId = box.drexViewCoreSafeId;
  shouldRecord = box.drexViewCoreShouldRecord;
  mark = box.drexViewCoreMark;
  markerUpdate = box.drexViewCoreMarkerUpdate;
  countUpdate = box.drexViewCoreCountUpdate;
  noteIdOf = box.drexViewNoteIdOf;
  aggregate = box.drexPulsoAggregate;
  DWELL_MS = box.DREX_VIEW_DWELL_MS;
  THRESHOLD = box.DREX_VIEW_THRESHOLD;
  PULSO_DAYS_V = box.PULSO_DAYS;
  ok(typeof safeId === 'function' && typeof shouldRecord === 'function' &&
     typeof aggregate === 'function',
     'T0 núcleo extraído y ejecutable');
});

// ================= T1: drexViewCoreSafeId =================
tcase('T1 safeId', () => {
  eq(safeId('-Nabc123_xyz'), '-Nabc123_xyz', 'T1a id push válido pasa');
  eq(safeId(''), '', 'T1b vacío → vacío');
  eq(safeId(null), '', 'T1c null → vacío');
  eq(safeId(undefined), '', 'T1d undefined → vacío');
  eq(safeId(123), '', 'T1e no-string → vacío');
  eq(safeId('a/b'), '', 'T1f slash → vacío (inyección de ruta)');
  eq(safeId('a.b'), '', 'T1g punto → vacío');
  eq(safeId('a#b'), '', 'T1h hash → vacío');
  eq(safeId('a$b'), '', 'T1i dólar → vacío');
  eq(safeId('a[b]'), '', 'T1j corchetes → vacío');
  eq(safeId('x'.repeat(201)), '', 'T1k >200 chars → vacío');
  eq(safeId('x'.repeat(200)), 'x'.repeat(200), 'T1l 200 chars → pasa');
  eq(safeId('  abc  '), 'abc', 'T1m trim de espacios');
  eq(safeId('../../secret'), '', 'T1n path traversal → vacío');
});

// ================= T2: drexViewCoreShouldRecord =================
tcase('T2 shouldRecord', () => {
  ok(shouldRecord({}, 'n1', 'u1') === true, 'T2a fresco → true');
  ok(shouldRecord({}, '', 'u1') === false, 'T2b sin noteId → false');
  ok(shouldRecord({}, 'n1', '') === false, 'T2c sin uid → false (anónimo no cuenta)');
  ok(shouldRecord({}, 'n1', null) === false, 'T2d uid null → false');
  ok(shouldRecord({ n1: 1 }, 'n1', 'u1') === false, 'T2e ya visto en sesión → false');
  const viewed = {};
  shouldRecord(viewed, 'n9', 'u1');
  eq(viewed, {}, 'T2f puro: no muta el set');
});

// ================= T3: drexViewCoreMark =================
tcase('T3 mark', () => {
  const v = {};
  mark(v, 'n1');
  eq(v, { n1: 1 }, 'T3a marca la sesión');
  mark(v, 'n1');
  eq(v, { n1: 1 }, 'T3b idempotente');
  mark(null, 'n1');
  ok(true, 'T3c set null no crashea');
});

// ================= T4: drexViewCoreMarkerUpdate =================
tcase('T4 markerUpdate', () => {
  eq(markerUpdate(null, 1700000000000), 1700000000000, 'T4a sin marcador → timestamp');
  eq(markerUpdate(undefined, 1700000000000), 1700000000000, 'T4b undefined → timestamp');
  eq(markerUpdate(1699999999999, 1700000000000), undefined, 'T4c marcador existente → abort');
  eq(markerUpdate(0, 1700000000000), undefined, 'T4d 0 → abort (conservador)');
  ok(typeof markerUpdate(null, 0) === 'number', 'T4e nowMs inválido → Date.now()');
});

// ================= T5: drexViewCoreCountUpdate =================
tcase('T5 countUpdate', () => {
  eq(countUpdate(null), 1, 'T5a null → 1');
  eq(countUpdate(undefined), 1, 'T5b undefined → 1');
  eq(countUpdate(0), 1, 'T5c 0 → 1');
  eq(countUpdate(5), 6, 'T5d 5 → 6');
  eq(countUpdate('3'), 4, 'T5e string numérico → 4');
  eq(countUpdate('abc'), 1, 'T5f no-numérico → 1');
});

// ================= T6: consts =================
tcase('T6 consts', () => {
  eq(DWELL_MS, 1000, 'T6a dwell 1000ms');
  eq(THRESHOLD, 0.5, 'T6b threshold 0.5');
  eq(PULSO_DAYS_V, 7, 'T6c PULSO_DAYS intacto');
});

// ================= T7: drexViewNoteIdOf =================
tcase('T7 noteIdOf', () => {
  const el1 = { dataset: { noteId: 'abc123' }, id: '', querySelector: null };
  eq(noteIdOf(el1), 'abc123', 'T7a dataset.noteId');
  const el2 = { dataset: {}, id: 'post-xyz789', querySelector: null };
  eq(noteIdOf(el2), 'xyz789', 'T7b id post-<id> del feed');
  const el3 = {
    dataset: {}, id: 'comments-host',
    querySelector: () => ({ dataset: { noteId: 'inner1' } }),
  };
  eq(noteIdOf(el3), 'inner1', 'T7c [data-note-id] interno (comentarios)');
  const el4 = { dataset: { noteId: 'a/b' }, id: '', querySelector: null };
  eq(noteIdOf(el4), '', 'T7d id malicioso → sanitizado a vacío');
  eq(noteIdOf(null), '', 'T7e null → vacío');
  const el6 = { dataset: {}, id: 'post-', querySelector: null };
  eq(noteIdOf(el6), '', 'T7f "post-" sin id → vacío');
});

// ================= T8: drexPulsoAggregate suma views =================
tcase('T8 aggregate views', () => {
  const now = 1700000000000;
  const posts = [
    { timestamp: now - 1000, upvotes: 2, downvotes: 0, commentsCount: 1, ecosCount: 0, viewCount: 10 },
    { timestamp: now - 2000, upvotes: 0, downvotes: 0, commentsCount: 0, ecosCount: 0, viewCount: 25 },
    { timestamp: now - 2000, upvotes: 0, downvotes: 0, commentsCount: 0, ecosCount: 0 }, // sin viewCount → 0
    { timestamp: now - 30 * 86400000, viewCount: 999 }, // fuera de ventana
  ];
  const agg = aggregate(posts, now);
  eq(agg.totals.views, 35, 'T8a suma viewCount en ventana');
  eq(agg.totals.posts, 3, 'T8b posts intacto');
  eq(aggregate([], now).totals.views, 0, 'T8c vacío → 0 vistas');
  eq(aggregate(null, now).totals.views, 0, 'T8d null → 0 vistas');
});

// ================= T9: integración estática =================
tcase('T9 integración', () => {
  ok(html.includes('drexViewWatchCard(el)') && /_enhancePostCard[\s\S]{0,400}drexViewWatchCard/.test(html),
    'T9a hook en _enhancePostCard');
  ok(/drexViewWatchEl\(body,\s*note\.id\)/.test(html),
    'T9b hook del permalink con note.id explícito');
  ok(html.includes('new IntersectionObserver') && html.includes('DREX_VIEW_THRESHOLD'),
    'T9c observer con threshold');
  ok(html.includes('DREX_VIEW_DWELL_MS') && /setTimeout\(function \(\) \{\s*delete _drexViewTimers/.test(html),
    'T9d dwell con setTimeout y limpieza');
  ok(/ref\('userViews\/' \+ uid \+ '\/' \+ id\)/.test(html),
    'T9e marcador userViews/<uid>/<noteId>');
  ok(/ref\('communityNotes\/' \+ id \+ '\/viewCount'\)/.test(html),
    'T9f contador communityNotes/<id>/viewCount');
  ok(!/noteViewers/.test(html), 'T9g sin path noteViewers (se usa userViews)');
  ok(/stat\(appT\('Vistas'\), t\.views\)/.test(html), 'T9h stat Vistas en el panel');
  ok(/totals\.views \+= Number\(p\.viewCount \|\| 0\)/.test(html), 'T9i aggregate suma viewCount');
});

// ================= T10: i18n 1× por idioma =================
tcase('T10 i18n', () => {
  const count = (s) => (html.match(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  eq(count("'Vistas': 'Views'"), 1, 'T10a EN 1×');
  eq(count("'Vistas': '浏览量'"), 1, 'T10b ZH 1×');
  eq(count("'Vistas': 'Visualizações'"), 1, 'T10c PT 1×');
  eq(count("appT('Vistas')"), 1, 'T10d un solo call site');
});

// ================= T11: revisión adversarial =================
tcase('T11 adversarial', () => {
  // Toda construcción de ruta con id de post pasa por safeId.
  const watchElBody = extractFunction(html, 'drexViewWatchEl');
  ok(watchElBody.includes('drexViewCoreSafeId(noteId)'), 'T11a watchEl sanitiza');
  const recordBody = extractFunction(html, 'drexViewRecord');
  ok(recordBody.includes('drexViewCoreSafeId(noteId)'), 'T11b record sanitiza');
  ok(!/ref\('userViews\/' \+ [^)]*noteId[^)]*\)/.test(recordBody.replace(/drexViewCoreSafeId\(noteId\)/g, '')) ||
     /var id = drexViewCoreSafeId\(noteId\)/.test(recordBody),
    'T11c rutas usan el id sanitizado, no el crudo');
  // Sin write-only: las funciones del núcleo se leen donde se definen.
  ['drexViewCoreSafeId', 'drexViewCoreShouldRecord', 'drexViewCoreMark',
   'drexViewCoreMarkerUpdate', 'drexViewCoreCountUpdate', 'drexViewNoteIdOf',
   'drexViewWatchCard', 'drexViewWatchEl', 'drexViewRecord'].forEach((n) => {
    const uses = html.split(n).length - 1;
    ok(uses >= 2, 'T11d ' + n + ' se usa (' + uses + ' menciones)');
  });
  // El observer no observa sin uid: el record falla cerrado.
  ok(recordBody.includes("if (!drexViewCoreShouldRecord(_drexViewedSet, id, uid)) return;"),
    'T11e record falla cerrado sin uid');
});

console.log('\nVISTAS DE PULSO (C89): ' + pass + ' ok, ' + fail + ' fallos');
if (failures.length) {
  console.log('FALLOS:');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(fail ? 1 : 0);
