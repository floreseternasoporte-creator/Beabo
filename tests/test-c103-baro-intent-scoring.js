'use strict';
// Tests del scoring de intenciones + ranking de búsqueda — BARO v3, Carril 4 (C103).
// C103-F1: baroDetectIntent por SCORING (pesos: pattern/keyword/entidad/idioma/typo)
//          en vez de first-match-wins; umbral mínimo de confianza.
// C103-F2: tolerancia a typos (Levenshtein ≤2 en palabras ≥5 letras).
// C103-F3: sinónimos ES/EN/PT/ZH por intent.
// C103-F4: detección de entidades (@usuario, #onda, canción, "mi post", ayer/hoy).
// C103-F5: ranking de búsqueda: título > contenido > autor; desempate por
//          recencia y votos; deduplicación.
// C103-F6: baja confianza → repregunta con opciones TOCABLES (botones), no texto.
// Extrae los módulos de index.html; --target permite correr contra otro HTML.
// Uso: node tests/test-c103-baro-intent-scoring.js [--target otro.html]
const fs = require('fs');
const path = require('path');

let explicitTarget = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) explicitTarget = process.argv[++i];
}
function hasC103(p) {
  try { return fs.readFileSync(p, 'utf8').indexOf('baroRankSearchPosts') !== -1; }
  catch (_) { return false; }
}
let target = explicitTarget;
if (!target) {
  // CI-safe: primero el index.html del repo (cwd), luego la copia de desarrollo del carril.
  const cands = [
    'index.html',
    '/tmp/lane4-index.html',
    path.join(__dirname, '..', '..', '..', 'beabo', 'index.html')
  ];
  target = cands.find(hasC103) || null;
}
if (!target) {
  console.error('FAIL: no se encontró un index.html con el parche C103 (usa --target <html>)');
  process.exit(1);
}
const html = fs.readFileSync(target, 'utf8');

let fails = 0, oks = 0;
const CASES = [];
function tcase(name, fn) { CASES.push([name, fn]); }
function assert(cond, label) { if (!cond) throw new Error('assert: ' + label); }
function eqJ(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(label + ' esperado=' + e + ' actual=' + a);
}

// --- Extracción del sub-bloque 6b (router de intenciones) ---
const M6B_START = '/* ================= BARO · sub-bloque 6b: router de intenciones ================= */';
const M6B_END = '/* ================= BARO · integración: enlaces de fuentes';
let B6 = null;
function load6b() {
  if (B6) return B6;
  const si = html.indexOf(M6B_START);
  assert(si !== -1, 'marcador 6b ausente (¿sin parche C103?)');
  const iife = html.indexOf('(function () {', si);
  const end = html.indexOf(M6B_END, si);
  assert(iife !== -1 && end > iife, 'límites del IIFE 6b no encontrados');
  let code = html.slice(iife, end);
  const closeAt = code.lastIndexOf('})();');
  assert(closeAt !== -1, 'cierre del IIFE 6b no encontrado');
  // Exponer los helpers internos para el test (viven dentro del IIFE).
  const expose = '\n;global.__c103 = { baroLevenshtein: baroLevenshtein, baroWords: baroWords, ' +
    'baroExtractEntities: baroExtractEntities, baroGuessLangExt: baroGuessLangExt, ' +
    'baroScoreRule: baroScoreRule, baroClarifyHtml: baroClarifyHtml, ' +
    'BARO_INTENT_CONF_THRESHOLD: BARO_INTENT_CONF_THRESHOLD, ' +
    'BARO_INTENT_KEYWORDS: BARO_INTENT_KEYWORDS, BARO_ALL_INTENTS: BARO_ALL_INTENTS };\n';
  code = code.slice(0, closeAt) + expose + code.slice(closeAt);
  // En la app real, los extract de 6b usan el global baroResolveTargetDesc (bloque
  // puro C102 de lane 3). Cargarlo en el sandbox para fidelidad con producción.
  const C102_START = '/* BARO-C102-RESOLVE-PURE-START */';
  const C102_END = '/* BARO-C102-RESOLVE-PURE-END */';
  const c102si = html.indexOf(C102_START), c102ei = html.indexOf(C102_END);
  let prelude = '';
  if (c102si !== -1 && c102ei > c102si) prelude = html.slice(c102si, c102ei + C102_END.length) + '\n';
  const fakeGlobal = {};
  new Function('global', 'window', prelude + code)(fakeGlobal, undefined);
  assert(fakeGlobal.baroDetectIntent, 'baroDetectIntent no exportado');
  B6 = fakeGlobal;
  return B6;
}

// --- Extracción de los helpers puros de búsqueda del 6c (ranking) ---
let RS = null;
function loadRank() {
  if (RS) return RS;
  const s = html.indexOf('  function baroNormQ(q)');
  assert(s !== -1, 'baroNormQ ausente (¿sin parche C103?)');
  const endMark = '    return ranked.map(function (r) { return r.p; });\n  }';
  const e = html.indexOf(endMark, s);
  assert(e !== -1, 'baroRankSearchPosts ausente (¿sin parche C103?)');
  const code = html.slice(s, e + endMark.length) +
    '\n;return { baroNormQ, baroTextMatches, baroPostZoneScore, baroPostVotes, baroRankSearchPosts };';
  RS = new Function(code)();
  return RS;
}

// --- Estáticos: el parche está y el first-match-wins se fue ---
tcase('C103 presente: motor de scoring en el HTML', () => {
  assert(html.indexOf('Reemplaza el first-match-wins') !== -1, 'cabecera C103 ausente');
  assert(html.indexOf('function baroScoreRule(') !== -1, 'baroScoreRule ausente');
  assert(html.indexOf('BARO_INTENT_CONF_THRESHOLD') !== -1, 'umbral ausente');
  assert(html.indexOf('function baroRankSearchPosts(') !== -1, 'ranking ausente');
  assert(html.indexOf("langs: ['es', 'en', 'zh', 'pt']") !== -1, 'langs sin pt');
});

tcase('first-match-wins eliminado (no queda el return con confidence 0.9)', () => {
  assert(html.indexOf('confidence: 0.9 };') === -1, 'queda el detector viejo');
});

tcase('extracción 6b + ranking OK', () => {
  const b = load6b(), r = loadRank();
  assert(typeof b.baroDetectIntent === 'function', 'sin baroDetectIntent');
  assert(typeof r.baroRankSearchPosts === 'function', 'sin baroRankSearchPosts');
});

// --- C103-F1: scoring multi-señal, gana el mejor (no el primero) ---
// NOTA DE INTEGRACIÓN (lanes 3+4): el extract de eliminar_post ya no declina por
// falta de ID: devuelve targetDesc y la herramienta `eliminar` resuelve el objetivo
// sola con baroResolvePostTarget (candidatos con foto si hay ambigüedad). Por eso
// este caso ahora resuelve eliminar_post en vez de pedir aclaración.
tcase('scoring: "qué puedes hacer para eliminar mi post" → eliminar_post con targetDesc (C102 resuelve, no pide enlace)', () => {
  const b = load6b();
  const d = b.baroDetectIntent('¿qué puedes hacer para eliminar mi post?');
  assert(d.intent === 'eliminar_post', 'fue ' + d.intent);
  assert(d.args.postId == null, 'no debe inventar un postId');
  assert(typeof d.args.targetDesc === 'string' && d.args.targetDesc.length > 0,
    'debe traer targetDesc para que la herramienta resuelva sola');
  assert(d.confidence >= 0.35, 'confianza bajo umbral: ' + d.confidence);
});

tcase('scoring: "delete my post #/post/abc123" → eliminar_post', () => {
  const b = load6b();
  const d = b.baroDetectIntent('delete my post #/post/abc123');
  assert(d.intent === 'eliminar_post', 'fue ' + d.intent);
  assert(d.args.postId === 'abc123', 'postId no extraído');
  assert(d.confidence >= 0.35, 'confianza bajo umbral: ' + d.confidence);
});

tcase('scoring: "busca mi post de ayer de la playa" → preguntar (keyword + ownPost + timeRef)', () => {
  const b = load6b();
  const d = b.baroDetectIntent('busca mi post de ayer de la playa');
  assert(d.intent === 'preguntar', 'fue ' + d.intent);
  assert(typeof d.args.q === 'string' && d.args.q.length > 0, 'falta q');
});

tcase('forma del resultado: {intent, args, confidence} con intents conocidos', () => {
  const b = load6b();
  const names = b.__c103.BARO_ALL_INTENTS;
  ['ayuda', 'busca gatitos', 'publica: hola', 'resume', ''].forEach((msg) => {
    const d = b.baroDetectIntent(msg);
    assert(names.indexOf(d.intent) !== -1, 'intent desconocido: ' + d.intent);
    assert(d.args && typeof d.args === 'object', 'args no es objeto');
    assert(typeof d.confidence === 'number' && d.confidence >= 0 && d.confidence <= 1,
      'confidence fuera de rango: ' + d.confidence);
  });
});

tcase('"ayuda" explícita sigue devolviendo la ayuda completa', () => {
  const b = load6b();
  const d = b.baroDetectIntent('ayuda');
  assert(d.intent === 'ayuda' && d.args.showFullHelp === true, 'no es ayuda completa');
});

// --- C103-F2: typos ---
tcase('levenshtein: distancias conocidas', () => {
  const b = load6b();
  const lev = b.__c103.baroLevenshtein;
  assert(lev('elminar', 'eliminar', 2) === 1, 'elminar/eliminar debe ser 1');
  assert(lev('bsucar', 'buscar', 2) === 2, 'bsucar/buscar debe ser 2');
  assert(lev('pubicar', 'publicar', 2) === 1, 'pubicar/publicar debe ser 1');
  assert(lev('gato', 'perro', 2) > 2, 'gato/perro debe superar el tope');
});

tcase('typo: "elminar mi post #/post/abc123" → eliminar_post', () => {
  const b = load6b();
  const d = b.baroDetectIntent('elminar mi post #/post/abc123');
  assert(d.intent === 'eliminar_post', 'fue ' + d.intent);
});

tcase('typo: "bsucar gatitos" → preguntar', () => {
  const b = load6b();
  const d = b.baroDetectIntent('bsucar gatitos');
  assert(d.intent === 'preguntar', 'fue ' + d.intent);
});

tcase('typo: "pubicar hola mundo" → publicar', () => {
  const b = load6b();
  const d = b.baroDetectIntent('pubicar hola mundo');
  assert(d.intent === 'publicar', 'fue ' + d.intent);
});

tcase('sin falso positivo: palabra corta "bus" no dispara typo a "buscar"', () => {
  const b = load6b();
  const d = b.baroDetectIntent('bus');
  assert(d.intent === 'ayuda' && d.args.clarify === true, '"bus" no debe ganar un intent (fue ' + d.intent + ')');
});

// --- C103-F3: sinónimos ES/EN/PT/ZH ---
const SYN_CASES = [
  ['quita ese post', 'eliminar_post'],
  ['exclui minha publicação #/post/abc123', 'eliminar_post'], // PT
  ['删除我的帖子 #/post/abc123', 'eliminar_post'],               // ZH
  ['hay nuevos posts de recetas', 'preguntar'],
  ['encontra perfis de música', 'preguntar'],                 // PT
  ['搜索面包食谱', 'preguntar'],                                 // ZH
  ['denunciar este usuario @juan123', 'reportar'],            // PT/ES
  ['report this post #/post/abc123', 'reportar'],              // EN
  ['resume este hilo #/post/abc123', 'resumir_hilo'],
  ['总结这个帖子 #/post/abc123', 'resumir_hilo'],                // ZH
  ['programa hola para mañana a las 9', 'programar'],
  ['publica: hoy es un gran día', 'publicar'],
  ['发布：今天是美好的一天', 'publicar'],                        // ZH
  ['investiga qué opinan de la actualización', 'investigar_tema'],
];
SYN_CASES.forEach(([msg, want]) => {
  tcase('sinónimo: "' + msg + '" → ' + want, () => {
    const b = load6b();
    const d = b.baroDetectIntent(msg);
    const got = (d.intent === 'ayuda' && d.args.clarify) ? (d.args.candidates || [])[0] : d.intent;
    assert(got === want, 'fue ' + d.intent + ' (candidatos: ' + JSON.stringify(d.args.candidates) + ')');
  });
});

tcase('PT "agendar" puntúa programar (aunque falte la hora, el candidato es programar)', () => {
  const b = load6b();
  const d = b.baroDetectIntent('agendar olá para amanhã');
  const got = (d.intent === 'ayuda' && d.args.clarify) ? (d.args.candidates || [])[0] : d.intent;
  assert(got === 'programar', 'fue ' + d.intent);
});

// --- C103-F4: entidades ---
tcase('entidades: @usuario, #onda, canción, mi post, ayer/hoy', () => {
  const b = load6b();
  const E = b.__c103.baroExtractEntities;
  const e1 = E('reporta al usuario @juan_99 por favor');
  assert(e1.mention === 'juan_99', 'mention: ' + e1.mention);
  const e2 = E('busca posts de #cocina');
  assert(e2.wave === 'cocina', 'wave: ' + e2.wave);
  const e3 = E('busca la canción Despacito');
  assert(e3.song === 'Despacito', 'song: ' + e3.song);
  const e4 = E('busca "Bohemian Rhapsody"');
  assert(e4.song === 'Bohemian Rhapsody', 'song entrecomillada: ' + e4.song);
  const e5 = E('elimina mi post de ayer');
  assert(e5.ownPost === true && e5.timeRef === 'ayer', 'ownPost/timeRef: ' + JSON.stringify(e5));
  const e6 = E('publica hoy algo bonito');
  assert(e6.timeRef === 'hoy', 'hoy: ' + e6.timeRef);
  const e7 = E('resume este hilo #/post/abc123');
  assert(e7.postId === 'abc123', 'postId: ' + e7.postId);
});

tcase('entidad @usuario impulsa reportar: "reporta al usuario @juan123"', () => {
  const b = load6b();
  const d = b.baroDetectIntent('reporta al usuario @juan123');
  assert(d.intent === 'reportar', 'fue ' + d.intent);
  assert(d.args.tipo === 'user' && d.args.id === 'juan123', 'args: ' + JSON.stringify(d.args));
});

tcase('entidad canción: "busca la canción Despacito" → preguntar', () => {
  const b = load6b();
  const d = b.baroDetectIntent('busca la canción Despacito');
  assert(d.intent === 'preguntar', 'fue ' + d.intent);
});

// --- C103-F5: ranking ---
function mkPosts() {
  return [
    { id: 'p1', title: 'recetas de pan', content: 'algo de cocina', authorName: 'ana', timestamp: 100, upvotes: 0 },
    { id: 'p2', title: 'mi día', content: 'recetas de pan casero aquí', authorName: 'luis', timestamp: 300, upvotes: 0 },
    { id: 'p3', title: 'fotos', content: 'nada que ver', authorName: 'recetas de pan', timestamp: 500, upvotes: 0 },
  ];
}
tcase('ranking: título > contenido > autor (aunque el autor sea más reciente)', () => {
  const r = loadRank();
  const out = r.baroRankSearchPosts(mkPosts(), 'recetas de pan').map(p => p.id);
  eqJ(out, ['p1', 'p2', 'p3'], 'orden incorrecto: ' + JSON.stringify(out));
});

tcase('zona: score título(40) > contenido(25) > autor(12)', () => {
  const r = loadRank();
  const q = 'recetas de pan';
  const zt = r.baroPostZoneScore({ title: 'recetas de pan' }, q);
  const zc = r.baroPostZoneScore({ content: 'recetas de pan' }, q);
  const za = r.baroPostZoneScore({ authorName: 'recetas de pan' }, q);
  assert(zt > zc && zc > za, 'zonas: t=' + zt + ' c=' + zc + ' a=' + za);
});

tcase('desempate: a igual zona gana el más reciente', () => {
  const r = loadRank();
  const posts = [
    { id: 'a', title: 'x', content: 'recetas de pan', authorName: 'u1', timestamp: 100, upvotes: 0 },
    { id: 'b', title: 'y', content: 'recetas de pan', authorName: 'u2', timestamp: 900, upvotes: 0 },
  ];
  const out = r.baroRankSearchPosts(posts, 'recetas de pan').map(p => p.id);
  eqJ(out, ['b', 'a'], 'debe ganar el más reciente');
});

tcase('desempate: a igual zona y fecha ganan los votos', () => {
  const r = loadRank();
  const posts = [
    { id: 'a', title: 'x', content: 'recetas de pan', authorName: 'u1', timestamp: 100, upvotes: 1 },
    { id: 'b', title: 'y', content: 'recetas de pan', authorName: 'u2', timestamp: 100, upvotes: 42 },
  ];
  const out = r.baroRankSearchPosts(posts, 'recetas de pan').map(p => p.id);
  eqJ(out, ['b', 'a'], 'debe ganar el más votado');
});

tcase('deduplicación: el mismo id sale una sola vez', () => {
  const r = loadRank();
  const posts = mkPosts().concat([mkPosts()[0], mkPosts()[1]]);
  const out = r.baroRankSearchPosts(posts, 'recetas de pan').map(p => p.id);
  eqJ(out, ['p1', 'p2', 'p3'], 'hay duplicados: ' + JSON.stringify(out));
});

// --- C103-F6: baja confianza → botones tocables ---
tcase('sin señal ("zzz qqq xxx") → aclaratoria con TODAS las opciones y confianza 0', () => {
  const b = load6b();
  const d = b.baroDetectIntent('zzz qqq xxx');
  assert(d.intent === 'ayuda' && d.args.clarify === true, 'debe pedir aclaración');
  eqJ(d.args.candidates, b.__c103.BARO_ALL_INTENTS, 'debe ofrecer todas las opciones');
  assert(d.confidence === 0, 'confianza debe ser 0, fue ' + d.confidence);
});

tcase('señal débil con extract declinado ("resume") → top candidatos, no todas', () => {
  const b = load6b();
  const d = b.baroDetectIntent('resume');
  assert(d.intent === 'ayuda' && d.args.clarify === true, 'debe pedir aclaración');
  assert(d.args.candidates.indexOf('resumir_hilo') !== -1, 'resumir_hilo debe estar entre candidatos');
  assert(d.args.candidates.length < b.__c103.BARO_ALL_INTENTS.length, 'no debe listar las 8');
  assert(d.args.lowConfidence === true, 'debe marcar lowConfidence');
  assert(d.confidence < b.__c103.BARO_INTENT_CONF_THRESHOLD, 'confianza debe estar bajo el umbral');
});

tcase('la aclaratoria pinta BOTONES tocables (no texto libre)', () => {
  const b = load6b();
  const fakeCtx = { t: (k) => k, esc: (s) => String(s) };
  const d = b.baroDetectIntent('zzz qqq');
  const h = b.__c103.baroClarifyHtml(d.args, fakeCtx);
  assert(h.indexOf('<button') !== -1, 'sin botones en la aclaratoria');
  assert(h.indexOf('data-baro-intent="preguntar"') !== -1, 'falta botón preguntar');
  assert(h.indexOf('data-baro-intent="eliminar_post"') !== -1, 'falta botón eliminar_post');
  assert(h.indexOf('onclick="baroClarifyIntent(') !== -1, 'botón sin handler de toque');
});

tcase('umbral de confianza = 0.35', () => {
  const b = load6b();
  assert(b.__c103.BARO_INTENT_CONF_THRESHOLD === 0.35, 'umbral distinto');
});

for (const [name, fn] of CASES) {
  try { fn(); oks++; }
  catch (e) { fails++; console.error('FAIL ' + name + ' :: ' + e.message); }
}
console.log('c103-baro-intent-scoring: ' + oks + ' OK, ' + fails + ' FAIL (target: ' + target + ')');
process.exit(fails ? 1 : 0);
