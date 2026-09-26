'use strict';
// Tests de resolución automática del post objetivo de Baro — Ciclo 102 (carril 3).
// C102: Baro NUNCA pide el enlace del post; lo resuelve solo:
//   1. Si el mensaje trae #/post/<id> o un ID de post, se usa directo (verificado en BD).
//   2. Si describe el post ("mi post de ayer de la playa"): posts propios recientes
//      primero, luego búsqueda profunda por texto.
//   3. Ambigüedad -> candidatos tocables CON FOTO (baroResolveCandidatesHtml).
//   4. Sin candidato -> mensaje honesto, jamás "pásame el enlace".
// Aplica a eliminar, comentar, reportar, eco, guardar, votar (votar aún no existe
// como herramienta en la base: cuando se cree debe usar baroResolveForTool).
// Extrae el bloque puro de index.html; --target permite correr contra la
// base (git show origin/main:index.html) para verificar que el test FALLA sin el parche.
// Uso: node tests/test-c102-baro-resolve-target.js [--target archivo.html]
const fs = require('fs');
const path = require('path');

let explicitTarget = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) explicitTarget = process.argv[++i];
}
function hasC102(p) {
  try {
    const h = fs.readFileSync(p, 'utf8');
    return h.indexOf('/* BARO-C102-RESOLVE-PURE-START */') !== -1;
  } catch (_) { return false; }
}
let target = explicitTarget;
if (!target) {
  // CI-safe: primero el index.html del repo (cwd), luego la copia de desarrollo del carril.
  const cands = ['index.html', '/tmp/lane3-index.html'];
  target = cands.find(hasC102) || null;
}
if (!target) {
  console.error('target no encontrado con el bloque BARO-C102 (usa --target archivo.html)');
  process.exit(2);
}

const html = fs.readFileSync(target, 'utf8');
const START = '/* BARO-C102-RESOLVE-PURE-START */';
const END = '/* BARO-C102-RESOLVE-PURE-END */';
const si = html.indexOf(START), ei = html.indexOf(END);
const src = (si >= 0 && ei > si) ? html.slice(si, ei) : null;

let fails = 0, oks = 0;
const CASES = [];
function tcase(name, fn) { CASES.push([name, fn]); }
function assert(cond, label) { if (!cond) throw new Error('assert: ' + label); }
function eqJ(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(label + ' esperado=' + e + ' actual=' + a);
}

// --- Módulo puro extraído (C102) ---
tcase('extracción del bloque puro C102', () => {
  assert(src, 'bloque BARO-C102-RESOLVE-PURE ausente en ' + target);
  assert(src.indexOf('function baroResolvePostTarget(') >= 0, 'baroResolvePostTarget ausente (sin parche?)');
  assert(src.indexOf('function baroResolveExtractId(') >= 0, 'baroResolveExtractId ausente');
  assert(src.indexOf('function baroResolveTargetDesc(') >= 0, 'baroResolveTargetDesc ausente');
  assert(src.indexOf('function baroResolveDecide(') >= 0, 'baroResolveDecide ausente');
});

let M = null;
function loadModule() {
  if (M) return M;
  assert(src, 'sin bloque que cargar');
  const body = src + '\n;return { baroResolveExtractId, baroResolveTargetDesc, baroResolveTokens,' +
    ' baroResolveTimeHint, baroResolveScorePost, baroResolveRank, baroResolveDecide, baroResolvePostTarget };';
  M = new Function(body)();
  return M;
}

// --- Extracción de ID ---
tcase('extractId: #/post/<id>', () => {
  const m = loadModule();
  assert(m.baroResolveExtractId('elimina este post #/post/abc123') === 'abc123', 'hash link');
});
tcase('extractId: /post/<id> y "post <id>"', () => {
  const m = loadModule();
  assert(m.baroResolveExtractId('revisa /post/xyz-9_A porfa') === 'xyz-9_A', '/post/');
  assert(m.baroResolveExtractId('elimina post ABCDEF123456') === 'ABCDEF123456', 'post <id>');
});
tcase('extractId: push ID suelto de 20 caracteres', () => {
  const m = loadModule();
  assert(m.baroResolveExtractId('borra KV9fGh2jKl4MnOpQrStU') === 'KV9fGh2jKl4MnOpQrStU', 'push id');
});
tcase('extractId: sin ID -> null', () => {
  const m = loadModule();
  assert(m.baroResolveExtractId('elimina mi post de la playa') === null, 'no debe inventar ID');
  assert(m.baroResolveExtractId('hola mundo') === null, 'texto libre');
});

// --- Descripción objetivo ---
tcase('targetDesc: recorta el verbo ES', () => {
  const m = loadModule();
  assert(m.baroResolveTargetDesc('elimina mi post de ayer de la playa') === 'mi post de ayer de la playa', 'elimina');
  assert(m.baroResolveTargetDesc('reporta el post donde hablan de X') === 'el post donde hablan de X', 'reporta');
  assert(m.baroResolveTargetDesc('resume el hilo de la receta') === 'el hilo de la receta', 'resume');
});
tcase('targetDesc: verbo ZH', () => {
  const m = loadModule();
  assert(m.baroResolveTargetDesc('删除我昨天在海滩发的帖子') === '我昨天在海滩发的帖子', '删除');
});
tcase('tokens: quita stopwords', () => {
  const m = loadModule();
  eqJ(m.baroResolveTokens('mi post de ayer de la playa'), ['ayer', 'playa'], 'stopwords ES');
});

// --- Mocks de BD ---
function dayAt(daysAgo, hour) {
  const d = new Date(); d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}
const YESTERDAY = dayAt(1, 12), WEEK_AGO = dayAt(7, 12), TWO_DAYS = dayAt(2, 12), THREE_DAYS = dayAt(3, 12);
function mockDeps(ownPosts, deepPosts, notesById) {
  return {
    readNote: async (id) => ((notesById || {})[id] || null),
    readOwnRecent: async (uid) => (ownPosts || []),
    deepSearch: async (q) => (deepPosts || [])
  };
}

// --- Orquestador: ID directo ---
tcase('resolve: ID directo verificado en BD -> resolved', async () => {
  const m = loadModule();
  const r = await m.baroResolvePostTarget('elimina este post #/post/abc123', {},
    mockDeps([], [], { abc123: { id: 'abc123', content: 'hola' } }));
  assert(r.status === 'resolved' && r.postId === 'abc123', 'debe resolver directo: ' + JSON.stringify(r));
});
tcase('resolve: ID que no existe -> id_not_found (honesto, no pide enlace)', async () => {
  const m = loadModule();
  const r = await m.baroResolvePostTarget('borra #/post/noexiste1', {}, mockDeps([], [], {}));
  assert(r.status === 'id_not_found', 'debe marcar id_not_found: ' + JSON.stringify(r));
});

// --- Orquestador: descripción -> propios recientes ---
tcase('resolve: "mi post de ayer de la playa" -> propio reciente', async () => {
  const m = loadModule();
  const own = [
    { id: 'p1', content: 'Ayer fui a la playa, qué día tan bueno', timestamp: YESTERDAY, authorId: 'u1' },
    { id: 'p2', content: 'Mi receta de pan casero favorita', timestamp: WEEK_AGO, authorId: 'u1' }
  ];
  const r = await m.baroResolvePostTarget('elimina mi post de ayer de la playa',
    { user: { uid: 'u1' } }, mockDeps(own, [], {}));
  assert(r.status === 'resolved' && r.postId === 'p1', 'debe elegir p1: ' + JSON.stringify(r));
});
tcase('resolve: ambigüedad -> candidates (tocables, no enlace)', async () => {
  const m = loadModule();
  const own = [
    { id: 'q1', content: 'fui a la playa con amigos', timestamp: TWO_DAYS, authorId: 'u1' },
    { id: 'q2', content: 'la playa estaba genial hoy', timestamp: THREE_DAYS, authorId: 'u1' }
  ];
  const r = await m.baroResolvePostTarget('haz eco al post de la playa',
    { user: { uid: 'u1' } }, mockDeps(own, [], {}));
  assert(r.status === 'candidates', 'debe pedir desambiguación: ' + JSON.stringify(r));
  assert(Array.isArray(r.posts) && r.posts.length === 2, 'dos candidatos');
});
tcase('resolve: cero candidatos -> none (mensaje honesto)', async () => {
  const m = loadModule();
  const r = await m.baroResolvePostTarget('borra el post del concierto',
    { user: { uid: 'u1' } }, mockDeps([], [], {}));
  assert(r.status === 'none', 'debe ser none: ' + JSON.stringify(r));
});
tcase('resolve: sin propios -> búsqueda profunda por texto', async () => {
  const m = loadModule();
  const deep = [{ id: 'd1', content: 'la playa estaba increíble este finde', timestamp: TWO_DAYS, authorName: 'alguien' }];
  const r = await m.baroResolvePostTarget('resume el hilo de la playa', {}, mockDeps([], deep, {}));
  assert(r.status === 'resolved' && r.postId === 'd1', 'deep search: ' + JSON.stringify(r));
});
tcase('resolve: nunca lanza excepción', async () => {
  const m = loadModule();
  const bad = { readNote: async () => { throw new Error('x'); }, readOwnRecent: async () => { throw new Error('x'); }, deepSearch: async () => { throw new Error('x'); } };
  const r = await m.baroResolvePostTarget('elimina mi post', { user: { uid: 'u1' } }, bad);
  assert(r && typeof r.status === 'string', 'siempre objeto con status');
});

// --- Estáticos: ni rastro de pedir enlace en el flujo Baro ---
tcase('grep: ningún "pásame el enlace" en el archivo', () => {
  assert(!/pásame el enlace/i.test(html), 'queda petición de enlace');
});
tcase('grep: ningún "Send me the link of the post"', () => {
  assert(html.indexOf('Send me the link of the post') < 0, 'queda petición EN');
});
tcase('grep: reglas sin reason missing_postId', () => {
  assert(html.indexOf("reason: 'missing_postId'") < 0, 'queda reason missing_postId');
});
tcase('i18n: need reescritos piden describir, no enlace', () => {
  const i = html.indexOf("'baro.intent.need.eliminar_post'");
  assert(i >= 0, 'clave ausente');
  const seg = html.slice(i, i + 400);
  assert(/describi/.test(seg), 'ES debe pedir describir');
  assert(!/enlace/i.test(seg) && !/link/i.test(seg), 'no debe mencionar enlace/link');
});
tcase('i18n: claves baro.resolve.* ES/EN/ZH/PT', () => {
  ['baro.resolve.searching', 'baro.resolve.candidates_title', 'baro.resolve.none',
   'baro.resolve.id_not_found', 'baro.resolve.ver_post'].forEach((k) => {
    const i = html.indexOf("'" + k + "'");
    assert(i >= 0, 'clave ausente: ' + k);
    const seg = html.slice(i, i + 500);
    ['es:', 'en:', 'zh:', 'pt:'].forEach((lg) => assert(seg.indexOf(lg) >= 0, k + ' sin ' + lg));
  });
});
tcase('cableado: 6 herramientas usan baroResolveForTool', () => {
  const calls = (html.match(/baroResolveForTool\('(?:eliminar|reportar|resumir_hilo|guardar_post|eco_post|comentar)'/g) || []);
  assert(calls.length === 6, 'esperaba 6 call sites, hay ' + calls.length);
});
tcase('candidatos: tarjetas con foto y pick por toque', () => {
  assert(html.indexOf('function baroResolveCandidatesHtml(') >= 0, 'falta baroResolveCandidatesHtml');
  assert(html.indexOf('onclick="baroResolvePickTarget(') >= 0, 'falta onclick de pick');
  assert(html.indexOf('function baroResolvePickTarget(') >= 0, 'falta baroResolvePickTarget');
  assert(html.indexOf('typeof baroPostThumbUrl') >= 0, 'falta typeof-check defensivo del helper del carril 2');
  assert(!/pásame el enlace/i.test(html.slice(html.indexOf('function baroResolveCandidatesHtml('), html.indexOf('function baroResolveCandidatesHtml(') + 3000)), 'candidatos no piden enlace');
});

(async () => {
  for (const [name, fn] of CASES) {
    try { await fn(); oks++; }
    catch (e) { fails++; console.error('FAIL ' + name + ' :: ' + (e && e.message)); }
  }
  console.log('c102-baro-resolve-target: ' + oks + ' OK, ' + fails + ' FAIL');
  process.exit(fails ? 1 : 0);
})();
