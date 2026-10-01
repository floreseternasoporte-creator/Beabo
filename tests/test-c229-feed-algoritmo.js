/* ================================================================
 * Tests del algoritmo del feed "Para ti" (carril 4, 2026-10-01)
 * C229: el ranking V2 ordena "Para ti" de forma personal.
 *
 * Cubre: afinidad (votar X → más de X), decaimiento por recencia,
 * diversidad (penalización por ventana + tope de racha por autor),
 * anti-repetición, cold start (usuario nuevo → frescura+popularidad),
 * calidad, boost social, pesos ajustables vía tune() y explainPost.
 *
 * Uso: node tests/test-c229-feed-algoritmo.js [--engine <ruta>]
 *   --engine permite probar un drex-rec-engine.js parcheado
 *   (bloques 06/07/08 del carril).
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */

// Mock mínimo de DrexCloud para tests.
var _mockDB = {};
var _mockAuth = { currentUser: { uid: 'test-user-229' } };

global.DrexCloud = {
  database: function () {
    return {
      ref: function (path) {
        return {
          once: function () {
            return Promise.resolve({ val: function () { return _mockDB[path] || null; } });
          },
          set: function (val) { _mockDB[path] = val; return Promise.resolve(); }
        };
      }
    };
  },
  auth: function () { return _mockAuth; }
};

global._drexNoteMeta = {};
global.document = {
  readyState: 'complete',
  addEventListener: function () {},
  visibilityState: 'visible'
};
global.window = global;
global.IntersectionObserver = function () {
  this.observe = function () {};
  this.unobserve = function () {};
};

var enginePath = '../drex-rec-engine.js';
for (var ai = 2; ai < process.argv.length; ai++) {
  if (process.argv[ai] === '--engine' && process.argv[ai + 1]) enginePath = process.argv[ai + 1];
}
require(enginePath);

var Engine = global.DrexRecEngine;
var assert = require('assert');

var passed = 0, failed = 0, skipped = 0;
function test(name, fn) {
  return Promise.resolve().then(function () { return fn(); }).then(function () {
    console.log('  ✓ ' + name); passed++;
  }).catch(function (e) {
    console.log('  ✗ ' + name + ': ' + e.message); failed++;
  });
}
function approx(a, b, eps) { return Math.abs(a - b) < (eps || 0.01); }

// Perfil sintético con la forma V2 que lee RankingModel.
function mkProfile(over) {
  var p = {
    v: 2, updatedAt: Date.now(),
    flairs: {}, authors: {}, keywords: {}, topics: {}, formats: {},
    timeSlots: {}, sessionItems: [], sessions: [],
    negativeAuthors: {}, negativeKeywords: {},
    interactedPosts: {}, totalInteractions: 50, lastActive: Date.now()
  };
  if (over) for (var k in over) p[k] = over[k];
  return p;
}
function mkNote(over) {
  var n = {
    id: 'n1', authorId: 'alice', flair: 'gaming',
    content: 'un post neutral sobre videojuegos y torneos',
    text: 'un post neutral sobre videojuegos y torneos',
    timestamp: Date.now(), upvotes: 5, downvotes: 0,
    commentsCount: 2, ecoCount: 0
  };
  if (over) for (var k in over) n[k] = over[k];
  return n;
}

// --- Stubs de DOM para insertByScore / resortForYou ---
function fakeCard(score, author, flair) {
  return {
    dataset: { recScore: String(score), recAuthor: author || '', recFlair: flair || '', recFormat: 'text', noteId: '' },
    previousElementSibling: null, nextElementSibling: null,
    matches: function () { return true; }
  };
}
function link(cards) {
  for (var i = 0; i < cards.length; i++) {
    cards[i].previousElementSibling = cards[i - 1] || null;
    cards[i].nextElementSibling = cards[i + 1] || null;
  }
  return cards;
}
function fakeFeed(cards) {
  var placements = [];
  return {
    _cards: cards,
    placements: placements,
    dataset: { feedMode: 'foryou' },
    querySelectorAll: function () { return this._cards; },
    querySelector: function () { return null; },
    insertBefore: function (el, ref) { placements.push({ el: el, ref: ref || null }); },
    appendChild: function (el) { placements.push({ el: el, ref: null }); }
  };
}

async function runAll() {
  console.log('\n========================================');
  console.log('C229 — Algoritmo del feed "Para ti"');
  console.log('engine: ' + enginePath);
  console.log('========================================\n');

  console.log('Afinidad y decaimiento:');

  await test('decaimiento: post viejo pierde contra gemelo reciente', function () {
    var prof = mkProfile();
    var now = mkNote({ id: 'fresh', timestamp: Date.now() });
    var old = mkNote({ id: 'old', timestamp: Date.now() - 72 * 3600 * 1000 });
    var rNow = Engine.RankingModel.scorePost(now, { profile: prof });
    var rOld = Engine.RankingModel.scorePost(old, { profile: prof });
    assert(approx(rNow.components.recency, 100, 1), 'recencia del nuevo ≈ 100, got ' + rNow.components.recency);
    assert(rOld.components.recency < 10, 'recencia del viejo < 10, got ' + rOld.components.recency);
    assert(rNow.total > rOld.total, 'el nuevo debe rankear más alto');
  });

  await test('afinidad por flair: el tema votado sube', function () {
    var prof = mkProfile({ flairs: { musica: 12 } });
    var a = mkNote({ id: 'a', flair: 'musica' });
    var b = mkNote({ id: 'b', flair: 'deportes' });
    var ra = Engine.RankingModel.scorePost(a, { profile: prof }).total;
    var rb = Engine.RankingModel.scorePost(b, { profile: prof }).total;
    assert(ra > rb + 5, 'flair afín debe subir el score (' + ra.toFixed(1) + ' vs ' + rb.toFixed(1) + ')');
  });

  await test('boost social: autor seguido sube (+8 × peso)', function () {
    var prof = mkProfile();
    var note = mkNote({ id: 's1' });
    var r0 = Engine.RankingModel.scorePost(note, { profile: prof, followingMap: {} });
    var r1 = Engine.RankingModel.scorePost(note, { profile: prof, followingMap: { alice: true } });
    assert.strictEqual(r0.components.social, 0, 'sin follows no hay boost');
    assert.strictEqual(r1.components.social, 8, 'con follow el boost es 8');
    assert(approx(r1.total - r0.total, 8 * Engine.RANKING_WEIGHTS.social, 0.01), 'el total refleja el peso social');
  });

  console.log('\nDiversidad y anti-repetición:');

  await test('diversidad: 4º post seguido del mismo autor se penaliza', function () {
    var prof = mkProfile();
    var note = mkNote({ id: 'd1' });
    var ws = [];
    for (var i = 0; i < 4; i++) ws.push({ authorId: 'alice', flair: 'gaming', format: 'text' });
    var r0 = Engine.RankingModel.scorePost(note, { profile: prof, windowState: [] });
    var r4 = Engine.RankingModel.scorePost(note, { profile: prof, windowState: ws });
    assert.strictEqual(r0.components.diversity, 0, 'sin ventana no hay penalización');
    assert(r4.components.diversity < 0, 'con 4 del mismo autor hay penalización, got ' + r4.components.diversity);
    assert(r4.total < r0.total - 4, 'el total baja por diversidad');
  });

  await test('diversidad: spread de flair también penaliza', function () {
    var prof = mkProfile();
    var note = mkNote({ id: 'd2', authorId: 'zz' });
    var ws = [];
    for (var i = 0; i < 6; i++) ws.push({ authorId: 'otro' + i, flair: 'gaming', format: 'text' });
    var r = Engine.RankingModel.scorePost(note, { profile: prof, windowState: ws });
    assert(r.components.diversity < 0, '6 del mismo flair penalizan, got ' + r.components.diversity);
  });

  console.log('\nCold start y calidad:');

  await test('cold start: usuario nuevo → frescura + popularidad', function () {
    assert(Engine.ColdStartModel.isColdStartUser(null), 'sin perfil es cold start');
    assert(Engine.ColdStartModel.isColdStartUser({ totalInteractions: 3 }), '<15 interacciones es cold start');
    assert(!Engine.ColdStartModel.isColdStartUser({ totalInteractions: 50 }), '50 interacciones ya no es cold start');
    var fresh = mkNote({ id: 'cs1', timestamp: Date.now(), upvotes: 30, commentsCount: 5 });
    var stale = mkNote({ id: 'cs2', timestamp: Date.now() - 100 * 3600 * 1000, upvotes: 200, commentsCount: 40 });
    assert(Engine.ColdStartModel.coldStartScore(fresh) > Engine.ColdStartModel.coldStartScore(stale),
      'en cold start lo fresco+popular le gana a lo viejo aunque tenga más votos históricos');
    var prof = mkProfile({ totalInteractions: 2 });
    var rf = Engine.RankingModel.scorePost(fresh, { profile: prof }).total;
    var rs = Engine.RankingModel.scorePost(stale, { profile: prof }).total;
    assert(rf > rs, 'el blend 60/40 preserva el orden cold start');
  });

  await test('newPostBoost: solo posts de menos de 24h', function () {
    var b1 = Engine.ColdStartModel.newPostBoost({ timestamp: Date.now() - 3600 * 1000 });
    var b2 = Engine.ColdStartModel.newPostBoost({ timestamp: Date.now() - 48 * 3600 * 1000 });
    assert(b1 > 0, 'post de 1h tiene boost, got ' + b1);
    assert.strictEqual(b2, 0, 'post de 48h no tiene boost');
  });

  await test('calidad: longitud óptima + multimedia suben', function () {
    var q1 = Engine.ContentAnalyzer.contentQuality({ content: 'hola' });
    var q2 = Engine.ContentAnalyzer.contentQuality({ content: new Array(202).join('x'), imageCount: 2 });
    assert(q2 > q1 + 1, 'post completo debe superar al corto (' + q2 + ' vs ' + q1 + ')');
    var e = Engine.QualitySignals.engagementRatio({ upvotes: 10, downvotes: 0, commentsCount: 5, ecoCount: 0 });
    // ratio = 5/11 saturado a 0..1 con v/(v+1)
    assert(approx(e, (5 / 11) / (1 + 5 / 11), 0.001), 'engagement ratio saturado, got ' + e);
    var e2 = Engine.QualitySignals.engagementRatio({ upvotes: 10, downvotes: 0, commentsCount: 1, ecoCount: 0 });
    assert(e > e2, 'más engagement → mayor ratio');
  });

  console.log('\nPesos ajustables y explicabilidad:');

  await test('tune(): los pesos se ajustan sin tocar código', function () {
    if (typeof Engine.tune !== 'function') throw new Error('REQUIERE bloque 08: DrexRecEngine.tune no existe');
    var prof = mkProfile({ authors: { alice: 20 } });
    var note = mkNote({ id: 't1' });
    var antes = Engine.scorePost(note, { profile: prof });
    var cfg = Engine.tune({ rankingWeights: { personal: 0 } });
    assert.strictEqual(cfg.rankingWeights.personal, 0, 'getConfig refleja el cambio');
    var despues = Engine.scorePost(note, { profile: prof });
    assert(despues < antes - 5, 'bajar personal a 0 debe bajar el score (' + antes.toFixed(1) + ' → ' + despues.toFixed(1) + ')');
    Engine.tune({ rankingWeights: { personal: 1.5 } });
    assert.strictEqual(Engine.getConfig().rankingWeights.personal, 1.5, 'restaurado a 1.5');
  });

  await test('explainPost: el desglose cuadra con el total', function () {
    var prof = mkProfile({ authors: { alice: 10 }, flairs: { gaming: 8 } });
    var note = mkNote({ id: 'e1' });
    var exp = Engine.explainPost(note, { profile: prof });
    var w = Engine.RANKING_WEIGHTS;
    var comp = exp.components;
    var suma = 0;
    ['recency', 'popularity', 'personal', 'session', 'trend', 'quality',
     'social', 'novelty', 'exploration', 'negative', 'diversity'].forEach(function (k) {
      suma += (comp[k] || 0) * (w[k] !== undefined ? w[k] : 1);
    });
    suma += comp.coldStart || 0;
    assert(approx(suma, exp.total, 0.05), 'suma ponderada ' + suma.toFixed(2) + ' ≈ total ' + exp.total.toFixed(2));
    assert(exp.breakdown.length > 3, 'el desglose tiene líneas útiles');
  });

  console.log('\nPerfil real (entrenamiento):');
  await Engine.ProfileStore.load();

  await test('votar X → el perfil aprende X y X sube en el ranking', function () {
    var antes = Engine.ProfileStore.get().authors.alice || 0;
    Engine.train({ flair: 'musica', authorId: 'alice', text: 'me encanta la musica bailable' }, 3.0);
    var p = Engine.ProfileStore.get();
    assert(p.authors.alice >= antes + 2.9, 'el autor entrenado sube en el perfil');
    assert(p.flairs.musica >= 2.9, 'el flair entrenado sube en el perfil');
    var prof = Engine.ProfileStore.get();
    var ra = Engine.RankingModel.scorePost(mkNote({ id: 'va', authorId: 'alice', flair: 'cocina', text: 'receta de cocina casera' }), { profile: prof }).total;
    var rb = Engine.RankingModel.scorePost(mkNote({ id: 'vb', authorId: 'bob', flair: 'cocina', text: 'receta de cocina casera' }), { profile: prof }).total;
    assert(ra > rb, 'tras votar a alice, sus posts rankean más alto (' + ra.toFixed(1) + ' vs ' + rb.toFixed(1) + ')');
    // Simular usuario con historial para que los tests de mecanismo no
    // pasen por el blend cold-start 60/40 (el cold start ya se probó arriba).
    Engine.ProfileStore.get().totalInteractions = 50;
  });

  await test('anti-repetición: post ya visto baja (novedad −3)', function () {
    var prof = Engine.ProfileStore.get();
    Engine.ProfileStore.markInteracted('seen1');
    var rs = Engine.RankingModel.scorePost(mkNote({ id: 'seen1', authorId: 'zz', flair: 'deportes', text: 'un post neutral sobre deportes' }), { profile: prof });
    var rf = Engine.RankingModel.scorePost(mkNote({ id: 'fresh9', authorId: 'zz', flair: 'deportes', text: 'un post neutral sobre deportes' }), { profile: prof });
    assert.strictEqual(rs.components.novelty, -3, 'visto → −3');
    assert.strictEqual(rf.components.novelty, 2, 'no visto → +2');
    assert(rs.total < rf.total, 'el visto rankea más bajo');
  });

  console.log('\nInserción en vivo y resort (requieren bloques 06/07):');

  await test('insertByScore: no crea racha de 3+ del mismo autor', function () {
    var cards = link([fakeCard(90, 'x', 'gaming'), fakeCard(80, 'x', 'gaming'), fakeCard(50, 'y', 'musica')]);
    var feed = fakeFeed(cards);
    var el = { dataset: {} };
    var prof = Engine.ProfileStore.get();
    var note = mkNote({ id: 'nx1', authorId: 'x', flair: 'gaming', timestamp: Date.now(), upvotes: 2, commentsCount: 0 });
    Engine.insertByScore(feed, el, note, { profile: prof });
    assert.strictEqual(feed.placements.length, 1, 'una sola inserción');
    assert.strictEqual(feed.placements[0].ref, null,
      'REQUIERE bloque 06: sin hueco válido va al final en vez de crear racha de 3 (ref=' +
      (feed.placements[0].ref ? feed.placements[0].ref.dataset.recScore : 'null') + ')');
    assert.strictEqual(el.dataset.recAuthor, 'x', 'dataset recAuthor');
    assert.strictEqual(el.dataset.recFlair, 'gaming', 'dataset recFlair (ventana de diversidad)');
  });

  await test('insertByScore: la ventana del DOM penaliza la repetición', function () {
    var cards = link([0, 1, 2, 3].map(function (i) { return fakeCard(50 - i, 'x', 'gaming'); }));
    var feed = fakeFeed(cards);
    var el = { dataset: {} };
    var prof = Engine.ProfileStore.get();
    var note = mkNote({ id: 'nx2', authorId: 'x', flair: 'gaming', timestamp: Date.now(), upvotes: 1, commentsCount: 0 });
    Engine.insertByScore(feed, el, note, { profile: prof });
    var conVentana = parseFloat(el.dataset.recScore);
    var sinVentana = Engine.scorePost(note, { profile: prof }); // scorePost ya devuelve el total
    assert(conVentana < sinVentana - 4,
      'REQUIERE bloque 06: con 4 del mismo autor en el DOM hay penalización (' +
      conVentana.toFixed(1) + ' vs ' + sinVentana.toFixed(1) + ')');
  });

  await test('resortForYou: re-puntúa con ventana de diversidad', function () {
    var now = Date.now();
    global._drexNoteMeta = {
      n1: { ts: now, up: 5, down: 0, cc: 1, flair: 'gaming', authorId: 'x', text: 'post gaming uno' },
      n2: { ts: now, up: 4, down: 0, cc: 1, flair: 'gaming', authorId: 'x', text: 'post gaming dos' },
      n3: { ts: now, up: 3, down: 0, cc: 0, flair: 'gaming', authorId: 'x', text: 'post gaming tres' },
      n4: { ts: now, up: 2, down: 0, cc: 0, flair: 'gaming', authorId: 'x', text: 'post gaming cuatro' }
    };
    var cards = link(['n1', 'n2', 'n3', 'n4'].map(function (id) {
      var c = fakeCard(0, '', ''); c.dataset.noteId = id; return c;
    }));
    var feedEl = {
      dataset: { feedMode: 'foryou' },
      querySelectorAll: function () { return cards; },
      querySelector: function () { return null; },
      insertBefore: function () {}
    };
    global.document.getElementById = function (id) { return id === 'notes-feed' ? feedEl : null; };
    var chronoAntes = global.DREX_FORYOU_CHRONO;
    global.DREX_FORYOU_CHRONO = false;
    try {
      global.drexRecResortForYou();
    } finally {
      global.DREX_FORYOU_CHRONO = chronoAntes;
    }
    var prof = Engine.ProfileStore.get();
    var s4 = parseFloat(cards[3].dataset.recScore);
    assert(s4 > 0, 'el resort recalculó scores');
    var ref = Engine.scorePost(
      { id: 'n4', timestamp: now, upvotes: 2, downvotes: 0, commentsCount: 0, flair: 'gaming', authorId: 'x', content: 'post gaming cuatro', text: 'post gaming cuatro' },
      { profile: prof }); // scorePost ya devuelve el total
    assert(s4 < ref - 4,
      'REQUIERE bloque 07: el 4º del mismo autor se re-puntúa con penalización (' +
      s4.toFixed(1) + ' vs ' + ref.toFixed(1) + ')');
  });

  console.log('\n========================================');
  console.log('RESULTADO: ' + passed + ' ok, ' + failed + ' fallos');
  console.log('========================================');
  process.exit(failed ? 1 : 0);
}

runAll().catch(function (e) { console.error(e); process.exit(1); });
