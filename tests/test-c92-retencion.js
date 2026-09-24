'use strict';
// Tests de RETENCIÓN DE PULSO — "cuántas vistas se quedaron 5+ segundos"
// (Ciclo 92, fase 3 del hueco #2 del roadmap: Pulso).
// Uso: node test-c92-retencion.js [--target <html>]
//   --target: HTML a probar (default: ../index.html, el parcheado).
// Diseñados para FALLAR contra la base sin parche (C91).
//
// Verifica:
//  (a) núcleo puro extraído verbatim y ejecutado en sandbox:
//      drexPulsoRetentionPct, drexPulsoRetentionCardHTML, drexRetainArm,
//      drexRetainRecord, _drexViewClearTimers, drexPulsoAggregate (retained);
//  (b) integración estática: bloque nuevo fuera de los marcadores viejos,
//      hooks en el observer (dwell → drexRetainArm, salida →
//      _drexViewClearTimers), refs acotadas a userViews//communityNotes/,
//      marcador idempotente + contador transaccional (anti-inflación);
//  (c) i18n: 2 claves nuevas 1× por idioma en el merge de Pulso;
//  (d) revisión adversarial: sin write-only, sin noteId crudo en refs,
//      invariantes C89/C90 intactos.
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
const timers = [];
const sandbox = {
  console,
  escapeHTML: escStub,
  escapeHtml: escStub,
  formatNumber: (n) => String(n),
  appT: (s) => s,
  // Núcleo C89 reutilizado (stubs fieles).
  drexViewCoreSafeId: (id) => {
    if (typeof id !== 'string') return '';
    const s = id.replace(/^\s+|\s+$/g, '');
    if (!s || s.length > 200) return '';
    if (/[.#$/\[\]]/.test(s)) return '';
    return s;
  },
  drexViewCoreShouldRecord: (viewed, noteId, uid) => {
    if (!uid || !noteId) return false;
    if (viewed && viewed[noteId]) return false;
    return true;
  },
  drexViewCoreMark: (viewed, noteId) => { if (viewed && noteId) viewed[noteId] = 1; },
  drexViewCoreMarkerUpdate: (cur, nowMs) => {
    if (cur !== null && cur !== undefined) return undefined;
    const n = Number(nowMs);
    return n > 0 ? n : Date.now();
  },
  drexViewCoreCountUpdate: (cur) => (Number(cur) || 0) + 1,
  _drexViewUid: () => sandbox.__uid,
  __uid: 'u1',
  _drexViewTimers: {},
  _drexRetainTimers: {},
  _drexRetainedSet: {},
  DREX_RETAIN_EXTRA_MS: 4000,
  PULSO_DAYS: 7,
  setTimeout: (fn, ms) => { timers.push({ fn, ms, dead: false }); return timers.length; },
  clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
  // DrexCloud falso: captura refs y simula transacciones.
  __dbCalls: [],
  __markerCur: null, // valor actual del marcador (null = no existe)
};
sandbox.DrexCloud = {
  database: () => ({
    ref: (p) => {
      sandbox.__dbCalls.push(p);
      return {
        transaction: (fn) => {
          const res = fn(sandbox.__markerCur);
          const committed = res !== undefined;
          return Promise.resolve({ committed });
        },
      };
    },
  }),
};
vm.createContext(sandbox);

let pct = null, card = null, arm = null, record = null, clearT = null, agg = null;
tcase('T0 extracción del núcleo', () => {
  const src =
    extractFunction(html, 'drexPulsoRetentionPct') + '\n' +
    extractFunction(html, 'drexPulsoRetentionCardHTML') + '\n' +
    extractFunction(html, 'drexRetainArm') + '\n' +
    extractFunction(html, 'drexRetainRecord') + '\n' +
    extractFunction(html, '_drexViewClearTimers') + '\n' +
    extractFunction(html, 'drexPulsoAggregate') + '\n' +
    'this.__fns = { drexPulsoRetentionPct, drexPulsoRetentionCardHTML, drexRetainArm, drexRetainRecord, _drexViewClearTimers, drexPulsoAggregate };';
  vm.runInContext(src, sandbox);
  const f = sandbox.__fns;
  pct = f.drexPulsoRetentionPct; card = f.drexPulsoRetentionCardHTML;
  arm = f.drexRetainArm; record = f.drexRetainRecord; clearT = f._drexViewClearTimers;
  agg = f.drexPulsoAggregate;
  ok(true, 'T0a núcleo extraído y evaluado');
});

// ================= T1: drexPulsoRetentionPct =================
tcase('T1 retentionPct', () => {
  eq(pct(5, 10), 50, 'T1a 5/10 → 50');
  eq(pct(10, 10), 100, 'T1b 10/10 → 100');
  eq(pct(0, 10), 0, 'T1c 0/10 → 0');
  eq(pct(3, 0), 0, 'T1d sin vistas → 0');
  eq(pct(0, 0), 0, 'T1e 0/0 → 0');
  eq(pct(12, 10), 100, 'T1f tope en 100 (sin >100%)');
  eq(pct(-3, 10), 0, 'T1g negativo → 0');
  eq(pct(1, 3), 33, 'T1h 1/3 → 33');
  eq(pct('x', 10), 0, 'T1i no-numérico → 0');
  eq(pct('NaN', 'NaN'), 0, 'T1j NaN → 0');
  eq(pct(5, -2), 0, 'T1k vistas negativas → 0');
  eq(pct(Infinity, 10), 0, 'T1l Infinity → 0');
});

// ================= T2: tarjeta de retención =================
tcase('T2 retentionCardHTML', () => {
  const h = card(35, 51);
  ok(h.includes('69%'), 'T2a pinta el % (35/51 → 69%)');
  ok(h.includes('35/51'), 'T2b pinta r/v');
  ok(h.includes('Retención') && h.includes('vistas') && h.includes('se quedaron 5+ segundos'),
    'T2c usa las 3 claves i18n');
  ok(!/onclick/i.test(h) && !/innerHTML/i.test(h), 'T2d sin onclick ni innerHTML');
  ok(!/\sid="/.test(h), 'T2e sin ids nuevos');
  // Palabras i18n hostiles deben salir escapadas.
  const sb2 = {
    console, escapeHTML: escStub, formatNumber: (n) => String(n),
    appT: (s) => (s === 'Retención' ? '<img src=x onerror=alert(1)>' : s),
  };
  vm.createContext(sb2);
  vm.runInContext(extractFunction(html, 'drexPulsoRetentionPct') + '\n' +
    extractFunction(html, 'drexPulsoRetentionCardHTML') +
    '\nthis.__card = drexPulsoRetentionCardHTML;', sb2);
  const hostile = sb2.__card(1, 2);
  ok(!hostile.includes('<img') && hostile.includes('&lt;img'),
    'T2f2 palabras hostiles escapadas');
  const zero = card(0, 0);
  ok(zero.includes('0%') && zero.includes('0/0'), 'T2g ceros → 0% y 0/0');
  const neg = card(-5, 'x');
  ok(neg.includes('0%'), 'T2h bordes saneados → 0%');
});

// ================= T3: drexRetainArm (temporizador) =================
tcase('T3 retainArm', () => {
  timers.length = 0;
  sandbox._drexRetainTimers = {};
  sandbox._drexRetainedSet = {};
  sandbox.__uid = 'u1';
  const before = timers.length;
  arm('postA');
  eq(timers.length, before + 1, 'T3a arma un temporizador');
  eq(timers[timers.length - 1].ms, 4000, 'T3b espera DREX_RETAIN_EXTRA_MS');
  arm('postA');
  eq(timers.length, before + 1, 'T3c no re-arma si ya hay temporizador');
  arm('');
  eq(timers.length, before + 1, 'T3d id vacío → no arma');
  arm('a.b');
  eq(timers.length, before + 1, 'T3e id inseguro → no arma');
  sandbox.__uid = '';
  arm('postB');
  eq(timers.length, before + 1, 'T3f sin uid → no arma');
  sandbox.__uid = 'u1';
  sandbox._drexRetainedSet = { postC: 1 };
  arm('postC');
  eq(timers.length, before + 1, 'T3g ya retenido en sesión → no arma');
});

// ================= T4: _drexViewClearTimers =================
tcase('T4 clearTimers', () => {
  timers.length = 0;
  sandbox._drexViewTimers = {};
  sandbox._drexRetainTimers = {};
  const t1 = sandbox.setTimeout(() => {}, 1000);
  const t2 = sandbox.setTimeout(() => {}, 4000);
  sandbox._drexViewTimers.x = t1;
  sandbox._drexRetainTimers.x = t2;
  clearT('x');
  ok(timers[t1 - 1].dead && timers[t2 - 1].dead, 'T4a cancela dwell y retención');
  ok(!('_drexViewTimers' in sandbox && sandbox._drexViewTimers.x) &&
     !sandbox._drexRetainTimers.x, 'T4b limpia ambos mapas');
  tcase('T4c sin temporizadores no tira', () => clearT('inexistente'));
});

// ================= T5: drexRetainRecord (anti-inflación, async) =================
async function t5async() {
  timers.length = 0;
  sandbox._drexRetainTimers = {};
  sandbox._drexRetainedSet = {};
  sandbox.__uid = 'u1';
  sandbox.__dbCalls = [];
  sandbox.__markerCur = null; // marcador no existe → commit
  record('postR');
  ok(sandbox._drexRetainedSet.postR === 1, 'T5a marca la sesión');
  ok(sandbox.__dbCalls.includes('userViews/u1/retained/postR'),
    'T5b marcador userViews/<uid>/retained/<noteId>');
  await new Promise((r) => setImmediate(r));
  ok(sandbox.__dbCalls.includes('communityNotes/postR/viewRetained'),
    'T5c contador communityNotes/<id>/viewRetained tras commit');
  // Segunda llamada en otra "sesión": el marcador ya existe → abort.
  sandbox._drexRetainedSet = {};
  sandbox.__dbCalls = [];
  sandbox.__markerCur = 1727650000000; // ya contado antes
  record('postR');
  await new Promise((r) => setImmediate(r));
  ok(sandbox.__dbCalls.includes('userViews/u1/retained/postR'),
    'T5d reintenta el marcador idempotente');
  ok(!sandbox.__dbCalls.includes('communityNotes/postR/viewRetained'),
    'T5e sin doble conteo: el contador NO se toca si el marcador existe');
  // Sin uid: fail-closed.
  sandbox.__dbCalls = [];
  sandbox.__uid = '';
  record('postS');
  ok(sandbox.__dbCalls.length === 0, 'T5f sin uid → cero escrituras');
  sandbox.__uid = 'u1';
}

// ================= T6: aggregate suma viewRetained =================
tcase('T6 aggregate retained', () => {
  const now = Date.now();
  const posts = [
    { timestamp: now - 1000, viewCount: 10, viewRetained: 4 },
    { timestamp: now - 2000, viewCount: 5 }, // sin viewRetained → 0
    { timestamp: now - 9 * 86400000, viewCount: 99, viewRetained: 99 }, // fuera de ventana
  ];
  const r = agg(posts, now);
  eq(r.totals.retained, 4, 'T6a suma viewRetained en ventana');
  eq(r.totals.views, 15, 'T6b views intacto');
  eq(agg([], now).totals.retained, 0, 'T6c vacío → 0');
  eq(agg(null, now).totals.retained, 0, 'T6d null → 0');
});

// ================= T7: integración estática =================
tcase('T7 integración', () => {
  const sec = extractBlock(html, '// ============ RETENCIÓN DE PULSO', '// ============ /RETENCIÓN DE PULSO');
  ok(sec.length > 500, 'T7a bloque nuevo existe');
  // Fuera de los marcadores viejos.
  const oldEnd = html.indexOf('// ============ /VISTAS DIARIAS DE PULSO ============');
  const newStart = html.indexOf('// ============ RETENCIÓN DE PULSO');
  const oldStart2 = html.indexOf('// ============ VISTAS DEL AUTOR');
  ok(newStart > oldEnd && newStart < oldStart2, 'T7b bloque nuevo fuera de los marcadores viejos');
  // Refs acotadas.
  const refs = (sec.match(/\.ref\('[^']+'/g) || []).map((s) => s.slice(6, -1));
  ok(refs.length === 2 && refs.every((r) => r.indexOf('userViews/') === 0 || r.indexOf('communityNotes/') === 0),
    'T7c refs acotadas (userViews/, communityNotes/): ' + refs.join(','));
  ok(/ref\('userViews\/' \+ uid \+ '\/retained\/' \+ id\)/.test(sec),
    'T7d marcador retained idempotente');
  ok(/ref\('communityNotes\/' \+ id \+ '\/viewRetained'\)/.test(sec),
    'T7e contador viewRetained');
  ok(!/ref\('[^']*' \+ [^)]*noteId[^)]*\)/.test(sec.replace(/drexViewCoreSafeId\(noteId\)/g, '')) ||
     /var id = drexViewCoreSafeId\(noteId\)/.test(sec),
    'T7f refs usan el id sanitizado, no el crudo');
  // Reutiliza el núcleo anti-inflación de C89 (sin caminos nuevos de conteo).
  ok(sec.includes('drexViewCoreMarkerUpdate') && sec.includes('drexViewCoreCountUpdate'),
    'T7g reutiliza marker/count update de C89');
  // Hooks en el observer del bloque viejo.
  ok(/delete _drexViewTimers\[id\];\s*drexViewRecord\(id\);\s*try \{ drexRetainArm\(id\); \} catch/.test(html),
    'T7h el dwell arma la retención tras registrar la vista');
  ok(/_drexViewClearTimers\(id\);/.test(html),
    'T7i la salida cancela dwell + retención');
  ok(/_drexRetainTimers\[id\]\]\) return; \/\/ dwell o retención ya en curso/.test(html) ||
     /_drexViewTimers\[id\] \|\| _drexRetainTimers\[id\]/.test(html),
    'T7j el observer conoce ambos temporizadores');
  // El panel pinta la tarjeta con los totales agregados.
  ok(/drexPulsoRetentionCardHTML\(t\.retained, t\.views\)/.test(html),
    'T7k el panel pinta la tarjeta de retención');
  // Invariantes C89/C90 intactos.
  ok(/setTimeout\(function \(\) \{\s*delete _drexViewTimers/.test(html),
    'T7l dwell C89 intacto (T9d del test viejo)');
  ok(extractFunction(html, 'drexViewRecord').includes(
    'if (!drexViewCoreShouldRecord(_drexViewedSet, id, uid)) return;'),
    'T7m record C89 intacto (T11e del test viejo)');
});

// ================= T8: i18n 1× por idioma =================
tcase('T8 i18n', () => {
  const iife = extractBlock(html, '(function drexPulsoI18nMerge() {', '})();');
  const count = (s) => (iife.match(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  eq(count("'Retención': 'Retention'"), 1, 'T8a EN Retención 1×');
  eq(count("'Retención': '留存'"), 1, 'T8b ZH Retención 1×');
  eq(count("'Retención': 'Retenção'"), 1, 'T8c PT Retención 1×');
  eq(count("'se quedaron 5+ segundos': 'stayed 5+ seconds'"), 1, 'T8d EN 1×');
  eq(count("'se quedaron 5+ segundos': '停留 5 秒以上'"), 1, 'T8e ZH 1×');
  eq(count("'se quedaron 5+ segundos': 'ficaram 5+ segundos'"), 1, 'T8f PT 1×');
  eq(count("'vistas': 'views'"), 1, 'T8g clave vieja vistas intacta');
});

// ================= T9: revisión adversarial =================
tcase('T9 adversarial', () => {
  ['drexRetainArm', 'drexRetainRecord', '_drexViewClearTimers',
   'drexPulsoRetentionPct', 'drexPulsoRetentionCardHTML'].forEach((n) => {
    const uses = html.split(n).length - 1;
    ok(uses >= 2, 'T9a ' + n + ' se usa (' + uses + ' menciones)');
  });
  const sec = extractBlock(html, '// ============ RETENCIÓN DE PULSO', '// ============ /RETENCIÓN DE PULSO');
  const writes = (sec.match(/\.(push|set|update|transaction|remove)\s*\(/g) || [])
    .filter((c) => c !== '.push(');
  eq(writes.length, 2, 'T9b exactamente 2 escrituras (marcador + contador), nada más');
  ok(!/noteViewers/.test(sec), 'T9c sin path noteViewers');
  ok(/DREX_RETAIN_TOTAL_MS = 5000/.test(sec), 'T9d umbral de retención = 5 s');
  const pulsoBlock = extractBlock(html, '// ============ PULSO:', '// ============ /PULSO');
  const pw = (pulsoBlock.match(/\.(push|set|update|transaction|remove)\s*\(/g) || [])
    .filter((c) => c !== '.push(');
  eq(pw.length, 0, 'T9e PULSO sigue sin escrituras a BD (T5i del test viejo)');
});

(async () => {
  try { await t5async(); }
  catch (e) { ok(false, 'T5 async (throw: ' + e.message + ')'); }
  console.log('\nRETENCIÓN DE PULSO (C92): ' + pass + ' ok, ' + fail + ' fallos');
  if (failures.length) {
    console.log('FALLOS:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
})();
