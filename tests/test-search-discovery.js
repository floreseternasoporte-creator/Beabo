'use strict';
// Tests de "Buscar: Tendencias + Últimos vídeos" (descubrimiento en Buscar).
// Extrae el módulo ONDAS y el bloque de render de descubrimiento de index.html
// y los ejecuta con jsdom + mocks (sin tocar la BD real).
// Uso: NODE_PATH=~/workspace/cdc-test/node_modules node tests/test-search-discovery.js
process.chdir(__dirname + '/..');
const fs = require('fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('index.html', 'utf8');

// Reloj fijo: 23-nov-2026 mediodía UTC (evita bordes de día).
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
Date.now = () => NOW;
const DAY = 86400000;
const H = 3600000;
const today = (h) => NOW - h * H;
const yesterday = (h) => NOW - DAY - h * H;
const daysAgo = (d, h) => NOW - d * DAY - (h || 1) * H;

function makeLS() {
  return {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); }
  };
}

// Documento real de index.html (sin ejecutar scripts) para pintar sobre el
// marcado auténtico de Buscar.
const dom = new JSDOM(html);
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = makeLS();
global.window.APP_ENGLISH_TEXT = {};
global.window.APP_CHINESE_TEXT = {};
global.window.APP_PORTUGUESE_TEXT = {};

global.__testLang = 'es';
global.appT = (es) => {
  const lang = global.__testLang || 'es';
  if (lang === 'es') return es;
  const dicts = { en: global.window.APP_ENGLISH_TEXT, zh: global.window.APP_CHINESE_TEXT, pt: global.window.APP_PORTUGUESE_TEXT };
  const d = dicts[lang];
  if (d && d[es]) return d[es];
  const en = global.window.APP_ENGLISH_TEXT;
  return (en && en[es]) || es;
};
global.escapeHTML = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const calls = { hashtag: [], recent: [], comments: [], closeSearch: 0 };
global.saveRecentSearch = (q) => { calls.recent.push(q); };
global.openHashtagSearch = (tag) => { calls.hashtag.push(tag); };
global.closeSearch = () => { calls.closeSearch++; };
global.openCommentsView = (id) => { calls.comments.push(id); };
let mockRawPosts = [];
let mockRawError = null;
global._getSearchPostsRaw = () => (mockRawError ? Promise.reject(mockRawError) : Promise.resolve(mockRawPosts));
let blockedUids = new Set();
global.isAccountBlockedForCurrentUser = (uid) => blockedUids.has(uid);
global.shouldHideNoteForCurrentUser = () => false;
// Miniatura real de vídeo (resolvePostThumb/fillHistorialThumb) en los tests
// de vídeos: se evalúa con el código extraído de index.html (ver abajo).
global.getSafeMediaUrlRaw = (u) => String(u || '');

const START = '// ===== ONDAS (Descubrimiento) v1 — inicio =====';
const END = '// ===== ONDAS (Descubrimiento) v1 — fin =====';
const si = html.indexOf(START), ei = html.indexOf(END);
if (si < 0 || ei < 0 || ei <= si) {
  console.error('FAIL modulo ONDAS ausente en index.html');
  process.exit(1);
}
const rs = html.indexOf('function drexPaintSearchTrends');
const re = html.indexOf('function renderRecentSearches');
if (rs < 0 || re < 0 || re <= rs) {
  console.error('FAIL bloque de render de descubrimiento ausente en index.html');
  process.exit(1);
}
const thumbStart = html.indexOf('function resolvePostThumb');
const thumbEnd = html.indexOf('function _histStickerUrl');
if (thumbStart < 0 || thumbEnd < 0 || thumbEnd <= thumbStart) {
  console.error('FAIL funciones de miniatura ausentes en index.html');
  process.exit(1);
}
const src = html.slice(si, ei)
  + '\n' + html.slice(rs, re)
  + '\n' + html.slice(thumbStart, thumbEnd);
let M = null, loadErr = null;
try {
  M = new Function(src + '\n;return { DREX_ONDA, ondaIndex, drexExtractOndas, drexOndaDay, ondaMergeI18n, drexOndaInteractions, drexSearchTrendsFromPosts, drexSearchLatestVideosFromPosts, drexPaintSearchTrends, drexRenderSearchTrends, drexRefreshSearchDiscovery, drexPaintSearchLatestVideos };')();
} catch (e) { loadErr = e; }
if (!M || loadErr) {
  console.error('FAIL carga del modulo de descubrimiento :: ' + (loadErr && loadErr.message));
  process.exit(1);
}
const { ondaIndex, drexSearchTrendsFromPosts, drexSearchLatestVideosFromPosts,
  drexPaintSearchTrends, drexRenderSearchTrends, drexRefreshSearchDiscovery,
  drexPaintSearchLatestVideos } = M;

let fails = 0, oks = 0;
const CASES = [];
function tcase(name, fn) { CASES.push([name, fn]); }
function assert(cond, label) { if (!cond) throw new Error('assert: ' + label); }
function eqJ(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(label + ' esperado=' + e + ' actual=' + a);
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };
function trendRows() {
  return Array.from(document.querySelectorAll('#search-trends-list > button')).map((b) => ({
    label: (b.querySelector('span span') || {}).textContent || '',
    tag: b.textContent,
    aria: b.getAttribute('aria-label')
  }));
}
function videoTiles() {
  return Array.from(document.querySelectorAll('#search-latest-videos-grid > button'));
}

// Mock de plataforma: #delta con votos, #alpha solo volumen, #beta repartido,
// #gamma viejo, #solo por debajo del umbral.
function mockTrendPosts() {
  return [
    { id: 'd1', content: 'Vamos #delta', timestamp: today(1), upvotes: 12, downvotes: 2, commentsCount: 0, ecosCount: 0, authorId: 'u1' },
    { id: 'd2', content: 'Otro #delta', timestamp: today(2), upvotes: 10, downvotes: 0, commentsCount: 0, ecosCount: 0, authorId: 'u1' },
    { id: 'a1', content: '#alpha', timestamp: today(1), upvotes: 0, downvotes: 0, commentsCount: 0, ecosCount: 0, authorId: 'u2' },
    { id: 'a2', content: '#alpha', timestamp: today(2), upvotes: 0, downvotes: 0, commentsCount: 0, ecosCount: 0, authorId: 'u2' },
    { id: 'a3', content: '#alpha', timestamp: today(3), upvotes: 0, downvotes: 0, commentsCount: 0, ecosCount: 0, authorId: 'u2' },
    { id: 'b1', content: '#beta', timestamp: today(1), upvotes: 0, downvotes: 0, commentsCount: 0, ecosCount: 0, authorId: 'u3' },
    { id: 'b2', content: '#beta', timestamp: yesterday(2), upvotes: 0, downvotes: 0, commentsCount: 0, ecosCount: 0, authorId: 'u3' },
    { id: 'g1', content: '#gamma', timestamp: daysAgo(3), upvotes: 50, downvotes: 0, commentsCount: 0, ecosCount: 0, authorId: 'u4' },
    { id: 's1', content: '#solo', timestamp: today(1), upvotes: 0, downvotes: 0, commentsCount: 0, ecosCount: 0, authorId: 'u5' }
  ];
}

// T1: orden por actividad reciente (posts + votos, hoy pesa doble); lo viejo
// y lo de 1 solo post no entran.
tcase('T1 tendencias: orden por score con votos y ventana 48h', () => {
  const tr = drexSearchTrendsFromPosts(mockTrendPosts(), NOW);
  eqJ(tr.map((w) => w.onda), ['delta', 'alpha', 'beta'], 'orden delta,alpha,beta');
  eqJ([tr[0].d0, tr[0].v0, tr[0].score], [2, 20, 44], 'delta d0=2 v0=20 score=44');
  eqJ([tr[1].d0, tr[1].d1, tr[1].score], [3, 0, 6], 'alpha d0=3 score=6');
  eqJ([tr[2].d0, tr[2].d1, tr[2].score], [1, 1, 3], 'beta d0=1 d1=1 score=3');
  assert(!tr.some((w) => w.onda === 'gamma'), 'gamma (3 días, 50 votos) excluida');
  assert(!tr.some((w) => w.onda === 'solo'), 'solo (1 post) bajo umbral');
});

// T2: entradas inválidas -> [].
tcase('T2 tendencias: entradas inválidas', () => {
  eqJ(drexSearchTrendsFromPosts(null, NOW), [], 'null');
  eqJ(drexSearchTrendsFromPosts([], NOW), [], 'vacío');
  eqJ(drexSearchTrendsFromPosts(mockTrendPosts(), 'NaN'), [], 'now inválido');
  eqJ(drexSearchTrendsFromPosts(mockTrendPosts(), 0), [], 'now 0');
  eqJ(drexSearchTrendsFromPosts([{ content: '#xx', timestamp: today(1) }, { content: '#xx', timestamp: today(2) }], NOW).map((w) => w.onda), ['xx'], 'sin contadores también cuenta');
});

// T3: tope 10 tendencias.
tcase('T3 tendencias: tope 10', () => {
  const posts = [];
  for (let i = 0; i < 12; i++) {
    posts.push({ id: 'c' + i + 'a', content: '#w' + i, timestamp: today(1), authorId: 'u' });
    posts.push({ id: 'c' + i + 'b', content: '#w' + i, timestamp: today(2), authorId: 'u' });
  }
  eqJ(drexSearchTrendsFromPosts(posts, NOW).length, 10, 'tope 10');
});

// T4: autor bloqueado no aporta a tendencias.
tcase('T4 tendencias: autor bloqueado excluido', () => {
  blockedUids = new Set(['u1']);
  const tr = drexSearchTrendsFromPosts(mockTrendPosts(), NOW);
  eqJ(tr.map((w) => w.onda), ['alpha', 'beta'], 'sin delta (autor bloqueado)');
  blockedUids = new Set();
});

// T5: painter estilo X: etiqueta, hashtag en negrita y "N publicaciones".
tcase('T5 painter: filas estilo X con conteo 48h', () => {
  global.__testLang = 'es';
  drexPaintSearchTrends([
    { onda: 'alpha', count: 9, d0: 3, d1: 0 },
    { onda: 'beta', count: 4, d0: 1, d1: 1 }
  ]);
  const rows = document.querySelectorAll('#search-trends-list > button');
  eqJ(rows.length, 2, '2 filas');
  assert(rows[0].textContent.includes('Tendencia en Drex'), 'etiqueta Tendencia en Drex');
  assert(rows[0].textContent.includes('#alpha'), 'hashtag #alpha');
  assert(rows[0].textContent.includes('3 publicaciones'), 'conteo 48h = 3 publicaciones');
  assert(rows[1].textContent.includes('2 publicaciones'), 'beta = 2 publicaciones');
  eqJ(document.getElementById('search-trends-title').textContent, 'Tendencias', 'título ES');
  eqJ(document.getElementById('search-trends-sub').textContent, 'Lo más destacado en Drex.', 'subtítulo ES');
  eqJ(document.getElementById('search-trends-more-label').textContent, 'Ver destacados', 'botón ES');
});

// T6: tocar una tendencia abre su búsqueda y la guarda en recientes.
tcase('T6 painter: clic en tendencia abre la búsqueda', () => {
  calls.hashtag = []; calls.recent = [];
  drexPaintSearchTrends([{ onda: 'alpha', count: 9, d0: 3, d1: 0 }]);
  document.querySelector('#search-trends-list > button').click();
  eqJ(calls.hashtag, ['alpha'], 'openHashtagSearch(alpha)');
  eqJ(calls.recent, ['#alpha'], 'saveRecentSearch(#alpha)');
});

// T7: sin datos, estado vacío honesto (nada inventado).
tcase('T7 painter: vacío honesto sin tendencias', () => {
  drexPaintSearchTrends([]);
  assert(document.getElementById('search-trends-list').textContent.includes('Aún no hay tendencias'), 'texto vacío');
  eqJ(document.querySelectorAll('#search-trends-list > button').length, 0, 'sin filas');
});

// T8: i18n: claves nuevas llegan a EN/ZH/PT y el painter traduce.
tcase('T8 i18n: claves de tendencias en EN/ZH/PT', () => {
  global.window.APP_ENGLISH_TEXT = {};
  global.window.APP_CHINESE_TEXT = {};
  global.window.APP_PORTUGUESE_TEXT = {};
  M.ondaMergeI18n();
  const keys = ['Lo más destacado en Drex.', 'Tendencia en Drex', '{n} publicaciones',
    'Aún no hay tendencias', 'Las tendencias con más actividad reciente aparecerán aquí.', 'Ver destacados'];
  keys.forEach((k) => {
    assert(typeof global.window.APP_ENGLISH_TEXT[k] === 'string' && global.window.APP_ENGLISH_TEXT[k].length > 0, 'en:' + k);
    assert(typeof global.window.APP_CHINESE_TEXT[k] === 'string' && global.window.APP_CHINESE_TEXT[k].length > 0, 'zh:' + k);
    assert(typeof global.window.APP_PORTUGUESE_TEXT[k] === 'string' && global.window.APP_PORTUGUESE_TEXT[k].length > 0, 'pt:' + k);
  });
  eqJ(global.window.APP_ENGLISH_TEXT['Tendencia en Drex'], 'Trending in Drex', 'en Tendencia en Drex');
  global.__testLang = 'en';
  drexPaintSearchTrends([{ onda: 'alpha', count: 9, d0: 3, d1: 0 }]);
  const row = document.querySelector('#search-trends-list > button');
  assert(row.textContent.includes('Trending in Drex'), 'fila EN');
  assert(row.textContent.includes('3 posts'), 'conteo EN');
  drexPaintSearchTrends([]);
  assert(document.getElementById('search-trends-list').textContent.includes('No trends yet'), 'vacío EN');
  global.__testLang = 'es';
});

// T9: ruta síncrona (índice local): pinta desde ondaIndex.trending().
tcase('T9 render síncrono desde ondaIndex', () => {
  ondaIndex._resetMemory();
  ondaIndex.feed(mockTrendPosts());
  drexRenderSearchTrends();
  eqJ(trendRows().map((r) => r.aria), ['#alpha', '#delta', '#beta'], 'orden local alpha,delta,beta (solo posts)');
});

// T10: refresh asíncrono con datos frescos de la plataforma (mock).
tcase('T10 refresh: repinta tendencias desde _getSearchPostsRaw', async () => {
  mockRawError = null;
  mockRawPosts = mockTrendPosts();
  document.getElementById('search-initial-section').classList.remove('hidden');
  drexPaintSearchTrends([]);
  assert(document.querySelectorAll('#search-trends-list > button').length === 0, 'empieza vacío');
  drexRefreshSearchDiscovery();
  await flush();
  eqJ(trendRows().map((r) => r.aria), ['#delta', '#alpha', '#beta'], 'orden fresco con votos');
});

// T11: refresh no pinta si Buscar ya no está en su estado inicial.
tcase('T11 refresh: no pinta con la vista inicial oculta', async () => {
  mockRawPosts = mockTrendPosts();
  drexPaintSearchTrends([]);
  document.getElementById('search-initial-section').classList.add('hidden');
  drexRefreshSearchDiscovery();
  await flush();
  eqJ(document.querySelectorAll('#search-trends-list > button').length, 0, 'sigue vacío');
  document.getElementById('search-initial-section').classList.remove('hidden');
});

// Mock de vídeos: v1/v2/vn con miniatura o sin ella, v3 viejo, p1 foto,
// v0 sin trozos, vg de grupo.
const THUMB = 'data:image/jpeg;base64,AAAA';
function mockVideoPosts() {
  return [
    { id: 'v1', content: 'Mira esto', timestamp: today(1), video: { chunks: 3, thumb: THUMB }, authorId: 'u1' },
    { id: 'v2', content: 'Otro vídeo', timestamp: today(5), video: { chunks: 1, thumb: THUMB }, authorId: 'u2' },
    { id: 'v3', content: 'Vídeo viejo', timestamp: daysAgo(5), video: { chunks: 2, thumb: THUMB }, authorId: 'u3' },
    { id: 'p1', content: 'Foto', timestamp: today(0.5), image: THUMB, authorId: 'u4' },
    { id: 'v0', content: 'Sin trozos', timestamp: today(0.25), video: { chunks: 0, thumb: THUMB }, authorId: 'u5' },
    { id: 'vg', content: 'De grupo', timestamp: today(0.1), video: { chunks: 2, thumb: THUMB }, groupId: 'g1', authorId: 'u6' },
    { id: 'vn', content: 'Sin miniatura', timestamp: today(3), video: { chunks: 2 }, authorId: 'u7' }
  ];
}

// T12: solo posts con vídeo (chunks>0), ordenados por fecha descendente.
tcase('T12 vídeos: solo vídeos, fecha descendente', () => {
  const vids = drexSearchLatestVideosFromPosts(mockVideoPosts());
  eqJ(vids.map((v) => v.id), ['v1', 'vn', 'v2', 'v3'], 'orden v1,vn,v2,v3');
  assert(!vids.some((v) => v.id === 'p1'), 'foto excluida');
  assert(!vids.some((v) => v.id === 'v0'), 'chunks 0 excluido');
  assert(!vids.some((v) => v.id === 'vg'), 'grupo excluido');
  eqJ(drexSearchLatestVideosFromPosts(null), [], 'null');
  eqJ(drexSearchLatestVideosFromPosts([]), [], 'vacío');
});

// T13: tope 9 vídeos.
tcase('T13 vídeos: tope 9', () => {
  const posts = [];
  for (let i = 0; i < 12; i++) posts.push({ id: 'vv' + i, content: 'v', timestamp: today(i + 1), video: { chunks: 1, thumb: THUMB }, authorId: 'u' });
  eqJ(drexSearchLatestVideosFromPosts(posts).length, 9, 'tope 9');
});

// T14: autor bloqueado no aporta vídeos.
tcase('T14 vídeos: autor bloqueado excluido', () => {
  blockedUids = new Set(['u1']);
  eqJ(drexSearchLatestVideosFromPosts(mockVideoPosts()).map((v) => v.id), ['vn', 'v2', 'v3'], 'sin v1');
  blockedUids = new Set();
});

// T15: painter: miniatura real + botón de play; clic abre la publicación.
tcase('T15 painter vídeos: miniatura, play y clic', async () => {
  global.__testLang = 'es';
  calls.comments = []; calls.closeSearch = 0;
  const byId = {};
  mockVideoPosts().forEach((p) => { byId[p.id] = p; });
  drexPaintSearchLatestVideos([byId.v1, byId.vn, byId.v2]);
  await flush();
  const tiles = videoTiles();
  eqJ(tiles.length, 3, '3 baldosas');
  const img = tiles[0].querySelector('img');
  assert(img && img.getAttribute('src') === THUMB, 'miniatura real en v1');
  assert(tiles[0].innerHTML.includes('M8 5.5v13l11-6.5z'), 'botón play en v1');
  assert(!tiles[1].querySelector('img'), 'vn sin miniatura no tiene img');
  assert(tiles[1].innerHTML.includes('M8 5.5v13l11-6.5z'), 'vn muestra play sobre fondo oscuro');
  eqJ(document.getElementById('search-latest-videos-title').textContent, 'Últimos vídeos', 'título ES');
  eqJ(document.getElementById('search-latest-videos-sub').textContent, 'Los vídeos más recientes de toda la plataforma.', 'subtítulo ES');
  eqJ(tiles[0].getAttribute('aria-label'), 'Ver vídeo', 'aria Ver vídeo');
  tiles[0].click();
  eqJ(calls.comments, ['v1'], 'openCommentsView(v1)');
  assert(calls.closeSearch === 1, 'closeSearch al abrir');
});

// T16: sin vídeos, estado vacío honesto.
tcase('T16 painter vídeos: vacío honesto', () => {
  drexPaintSearchLatestVideos([]);
  assert(document.getElementById('search-latest-videos-grid').textContent.includes('Aún no hay vídeos'), 'texto vacío');
  eqJ(videoTiles().length, 0, 'sin baldosas');
});

// T17: refresh pinta vídeos y tendencias juntos; si falla, error honesto.
tcase('T17 refresh: vídeos + tendencias, y error de carga', async () => {
  mockRawError = null;
  mockRawPosts = mockTrendPosts().concat(mockVideoPosts());
  document.getElementById('search-initial-section').classList.remove('hidden');
  drexPaintSearchLatestVideos([]);
  drexRefreshSearchDiscovery();
  await flush();
  const tiles = videoTiles();
  eqJ(tiles.length, 4, '4 vídeos');
  tiles[0].click();
  eqJ(calls.comments[calls.comments.length - 1], 'v1', 'primer vídeo = el más reciente');
  eqJ(trendRows().map((r) => r.aria), ['#delta', '#alpha', '#beta'], 'tendencias también refrescadas');
  mockRawError = new Error('sin red');
  drexRefreshSearchDiscovery();
  await flush();
  assert(document.getElementById('search-latest-videos-grid').textContent.includes('No se pudieron cargar los vídeos.'), 'texto de error');
  mockRawError = null;
});

// T18: i18n de vídeos en EN/ZH/PT.
tcase('T18 i18n: claves de vídeos en EN/ZH/PT', () => {
  global.window.APP_ENGLISH_TEXT = {};
  global.window.APP_CHINESE_TEXT = {};
  global.window.APP_PORTUGUESE_TEXT = {};
  M.ondaMergeI18n();
  const keys = ['Últimos vídeos', 'Los vídeos más recientes de toda la plataforma.',
    'Aún no hay vídeos', 'Cuando alguien publique un vídeo, aparecerá aquí.',
    'No se pudieron cargar los vídeos.', 'Ver vídeo'];
  keys.forEach((k) => {
    assert(typeof global.window.APP_ENGLISH_TEXT[k] === 'string' && global.window.APP_ENGLISH_TEXT[k].length > 0, 'en:' + k);
    assert(typeof global.window.APP_CHINESE_TEXT[k] === 'string' && global.window.APP_CHINESE_TEXT[k].length > 0, 'zh:' + k);
    assert(typeof global.window.APP_PORTUGUESE_TEXT[k] === 'string' && global.window.APP_PORTUGUESE_TEXT[k].length > 0, 'pt:' + k);
  });
  eqJ(global.window.APP_ENGLISH_TEXT['Últimos vídeos'], 'Latest videos', 'en Últimos vídeos');
  global.__testLang = 'en';
  drexPaintSearchLatestVideos([]);
  assert(document.getElementById('search-latest-videos-grid').textContent.includes('No videos yet'), 'vacío EN');
  eqJ(document.getElementById('search-latest-videos-title').textContent, 'Latest videos', 'título EN');
  global.__testLang = 'es';
});

(async () => {
  for (const [name, fn] of CASES) {
    try { await fn(); oks++; console.log('OK   ' + name); }
    catch (e) { fails++; console.log('FAIL ' + name + ' :: ' + (e && e.message)); }
  }
  console.log(fails === 0 ? 'TODOS OK (' + oks + ')' : fails + ' FALLOS de ' + (oks + fails));
  process.exit(fails === 0 ? 0 : 1);
})();
