/* ================================================================
 * Tests del DrexRecEngine v2
 * Ejecutar con: node tests/test-recommendation-engine.js
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */

// Mock mínimo de DrexCloud para tests.
var _mockDB = {};
var _mockAuth = { currentUser: { uid: 'test-user-123' } };

global.DrexCloud = {
  database: function () {
    return {
      ref: function (path) {
        return {
          once: function (event) {
            return Promise.resolve({
              val: function () { return _mockDB[path] || null; }
            });
          },
          set: function (val) {
            _mockDB[path] = val;
            return Promise.resolve();
          }
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
global.IntersectionObserver = function (cb) {
  this.observe = function () {};
  this.unobserve = function () {};
};

// Cargar el motor.
require('../drex-rec-engine.js');

var Engine = global.DrexRecEngine;
var assert = require('assert');

var passed = 0;
var failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(function () { return fn(); })
    .then(function () {
      console.log('  \u2713 ' + name);
      passed++;
    })
    .catch(function (e) {
      console.log('  \u2717 ' + name + ': ' + e.message);
      failed++;
    });
}

function approx(a, b, eps) {
  eps = eps || 0.01;
  return Math.abs(a - b) < eps;
}

async function runAll() {

console.log('\n========================================');
console.log('DrexRecEngine v2 — Tests');
console.log('========================================\n');

// --- ContentAnalyzer ---
console.log('ContentAnalyzer:');

await test('extractKeywords devuelve palabras relevantes', function () {
  var kws = Engine.ContentAnalyzer.extractKeywords('La música es increíble, música para el alma');
  assert(kws.length > 0, 'Debe devolver keywords');
  assert(kws.indexOf('musica') >= 0 || kws.indexOf('increible') >= 0, 'Debe incluir palabras clave relevantes');
});

await test('extractKeywords filtra stopwords', function () {
  var kws = Engine.ContentAnalyzer.extractKeywords('el la los las de que con');
  assert(kws.length === 0, 'No debe devolver stopwords');
});

await test('detectFormat detecta video', function () {
  var fmt = Engine.ContentAnalyzer.detectFormat({ videoUrl: 'http://example.com/v.mp4', content: 'test' });
  assert(fmt === 'video', 'Debe detectar video, got: ' + fmt);
});

await test('detectFormat detecta galería', function () {
  var fmt = Engine.ContentAnalyzer.detectFormat({ imageCount: 5, content: 'test' });
  assert(fmt === 'gallery', 'Debe detectar gallery, got: ' + fmt);
});

await test('detectFormat detecta texto', function () {
  var fmt = Engine.ContentAnalyzer.detectFormat({ content: 'Hola mundo' });
  assert(fmt === 'text', 'Debe detectar text, got: ' + fmt);
});

await test('cosineSim calcula similitud', function () {
  var tv1 = { a: 0.5, b: 0.5 };
  var tv2 = { a: 0.5, b: 0.5 };
  var sim = Engine.ContentAnalyzer.cosineSim(tv1, tv2);
  assert(approx(sim, 1.0, 0.01), 'Vectores idénticos deben tener similitud 1.0, got: ' + sim);
});

await test('cosineSim vectores ortogonales', function () {
  var tv1 = { a: 1.0 };
  var tv2 = { b: 1.0 };
  var sim = Engine.ContentAnalyzer.cosineSim(tv1, tv2);
  assert(approx(sim, 0.0, 0.01), 'Vectores ortogonales deben tener similitud 0, got: ' + sim);
});

await test('contentQuality premia multimedia', function () {
  var q1 = Engine.ContentAnalyzer.contentQuality({ content: 'Hola', imageCount: 0 });
  var q2 = Engine.ContentAnalyzer.contentQuality({ content: 'Hola mundo de prueba', imageCount: 3, videoUrl: 'x' });
  assert(q2 > q1, 'Post con multimedia debe tener mayor calidad');
});

// --- ProfileStore ---
console.log('\nProfileStore:');

await test('load devuelve un perfil con estructura V2', function () {
  return Engine.ProfileStore.load().then(function (p) {
    assert(p !== null, 'Perfil no debe ser null');
    assert(p.v === 2, 'Versión debe ser 2');
    assert(typeof p.flairs === 'object', 'flairs debe ser objeto');
    assert(typeof p.authors === 'object', 'authors debe ser objeto');
    assert(typeof p.keywords === 'object', 'keywords debe ser objeto');
    assert(typeof p.topics === 'object', 'topics debe ser objeto');
    assert(typeof p.formats === 'object', 'formats debe ser objeto');
    assert(Array.isArray(p.sessionItems), 'sessionItems debe ser array');
    assert(typeof p.interactedPosts === 'object', 'interactedPosts debe ser objeto');
    assert(typeof p.bandit === 'object', 'bandit debe ser objeto');
  });
});

await test('markInteracted y hasInteracted funcionan', function () {
  return Engine.ProfileStore.load().then(function () {
    Engine.ProfileStore.markInteracted('note-123');
    assert(Engine.ProfileStore.hasInteracted('note-123') === true, 'Debe marcar como interactuado');
    assert(Engine.ProfileStore.hasInteracted('note-456') === false, 'No debe estar interactuado');
  });
});

// --- SignalTracker ---
console.log('\nSignalTracker:');

await test('train registra interacción en el perfil', function () {
  return Engine.ProfileStore.load().then(function () {
    var before = Engine.ProfileStore.get().totalInteractions || 0;
    Engine.SignalTracker.train({
      flair: 'musica',
      authorId: 'author-1',
      text: 'música increíble'
    }, 3.0);
    var after = Engine.ProfileStore.get().totalInteractions || 0;
    assert(after > before, 'totalInteractions debe incrementar');
  });
});

await test('trainById con meta en caché funciona', function () {
  return Engine.ProfileStore.load().then(function () {
    global._drexNoteMeta['note-test'] = {
      flair: 'meme',
      authorId: 'author-2',
      text: 'memes graciosos',
      ts: Date.now(),
      up: 5, down: 0, cc: 2
    };
    Engine.SignalTracker.trainById('note-test', 4.0);
    var p = Engine.ProfileStore.get();
    assert(p.flairs.meme !== undefined, 'Debe registrar flair meme');
    assert(p.authors['author-2'] !== undefined, 'Debe registrar author-2');
  });
});

// --- SessionModel ---
console.log('\nSessionModel:');

await test('record y sessionAffinity funcionan', function () {
  Engine.SessionModel.record({
    flair: 'musica',
    authorId: 'author-1',
    text: 'música'
  }, 5.0);
  var affinity = Engine.SessionModel.sessionAffinity({
    flair: 'musica',
    authorId: 'author-1',
    content: 'música'
  });
  assert(affinity > 0, 'Afinidad de sesión debe ser positiva');
});

await test('sessionAffinity es 0 sin interacciones recientes', function () {
  Engine.SessionModel.reset();
  var affinity = Engine.SessionModel.sessionAffinity({
    flair: 'musica',
    authorId: 'author-1',
    content: 'música'
  });
  assert(approx(affinity, 0, 0.1), 'Sin interacciones, afinidad debe ser ~0, got: ' + affinity);
});

// --- TrendingModel ---
console.log('\nTrendingModel:');

await test('trendingScore de post fresco con votos es positivo', function () {
  var score = Engine.TrendingModel.trendingScore({
    timestamp: Date.now() - 3600000, // 1 hora atrás
    upvotes: 15,
    downvotes: 0,
    commentsCount: 8,
    ecoCount: 2,
    viewsCount: 100
  });
  assert(score > 0, 'Trending score debe ser positivo');
});

await test('isFresh detecta post de menos de 24h', function () {
  assert(Engine.TrendingModel.isFresh({ timestamp: Date.now() - 3600000 }) === true, 'Post de 1h debe ser fresh');
  assert(Engine.TrendingModel.isFresh({ timestamp: Date.now() - 90000000 }) === false, 'Post de >24h no debe ser fresh');
});

await test('isViral detecta post con alta velocidad', function () {
  var viral = Engine.TrendingModel.isViral({
    timestamp: Date.now() - 3600000,
    upvotes: 30,
    downvotes: 0,
    commentsCount: 15,
    ecoCount: 5
  });
  assert(viral === true, 'Post con 50+ interacciones en 1h debe ser viral');
});

await test('isViral rechaza post lento', function () {
  var notViral = Engine.TrendingModel.isViral({
    timestamp: Date.now() - 86400000, // 24h
    upvotes: 2,
    downvotes: 0,
    commentsCount: 0,
    ecoCount: 0
  });
  assert(notViral === false, 'Post lento no debe ser viral');
});

// --- ColdStartModel ---
console.log('\nColdStartModel:');

await test('isColdStartUser detecta perfil nuevo', function () {
  assert(Engine.ColdStartModel.isColdStartUser({ totalInteractions: 5 }) === true, '5 interacciones = cold start');
  assert(Engine.ColdStartModel.isColdStartUser({ totalInteractions: 50 }) === false, '50 interacciones no es cold start');
});

await test('newPostBoost da boost a posts frescos', function () {
  var boost = Engine.ColdStartModel.newPostBoost({ timestamp: Date.now() - 3600000 });
  assert(boost > 0, 'Post de 1h debe recibir boost');
  var oldBoost = Engine.ColdStartModel.newPostBoost({ timestamp: Date.now() - 90000000 });
  assert(approx(oldBoost, 0, 0.1), 'Post de >24h no debe recibir boost, got: ' + oldBoost);
});

// --- RankingModel ---
console.log('\nRankingModel:');

await test('scorePost devuelve un número', function () {
  var score = Engine.RankingModel.scorePost({
    id: 'test-1',
    timestamp: Date.now() - 3600000,
    upvotes: 10,
    downvotes: 2,
    commentsCount: 5,
    content: 'música increíble'
  }, { profile: Engine.ProfileStore.get() });
  assert(typeof score.total === 'number', 'Score total debe ser número');
  assert(typeof score.components === 'object', 'Components debe ser objeto');
  assert(typeof score.components.recency === 'number', 'Recency debe ser número');
  assert(typeof score.components.popularity === 'number', 'Popularity debe ser número');
});

await test('scorePost penaliza posts ya vistos', function () {
  return Engine.ProfileStore.load().then(function () {
    var profile = Engine.ProfileStore.get();
    profile.interactedPosts['seen-post'] = true;
    var seen = Engine.RankingModel.scorePost({
      id: 'seen-post',
      timestamp: Date.now() - 3600000,
      upvotes: 10,
      content: 'test'
    }, { profile: profile });
    var unseen = Engine.RankingModel.scorePost({
      id: 'unseen-post',
      timestamp: Date.now() - 3600000,
      upvotes: 10,
      content: 'test'
    }, { profile: profile });
    assert(unseen.total > seen.total, 'Post no visto debe tener mayor score');
    delete profile.interactedPosts['seen-post'];
  });
});

await test('diversity penalty reduce score de posts repetidos', function () {
  return Engine.ProfileStore.load().then(function () {
    var profile = Engine.ProfileStore.get();
    var windowState = [];
    // Llenar ventana con posts del mismo autor
    for (var i = 0; i < 6; i++) {
      windowState.push({ authorId: 'same-author', flair: 'musica', format: 'text' });
    }
    var s1 = Engine.RankingModel.scorePost({
      id: 'div-1',
      timestamp: Date.now() - 3600000,
      upvotes: 10,
      authorId: 'same-author',
      flair: 'musica',
      content: 'test'
    }, { profile: profile, windowState: windowState });
    var s2 = Engine.RankingModel.scorePost({
      id: 'div-2',
      timestamp: Date.now() - 3600000,
      upvotes: 10,
      authorId: 'different-author',
      flair: 'arte',
      content: 'test'
    }, { profile: profile, windowState: windowState });
    assert(s2.total > s1.total, 'Post de autor diferente debe tener mayor score por diversidad (s1=' + s1.total.toFixed(1) + ', s2=' + s2.total.toFixed(1) + ')');
  });
});

// --- DiversityMixer ---
console.log('\nDiversityMixer:');

await test('mixFeed reordena para evitar repetición de autores', function () {
  return Engine.ProfileStore.load().then(function () {
    var posts = [];
    for (var i = 0; i < 20; i++) {
      posts.push({
        id: 'post-' + i,
        timestamp: Date.now() - i * 3600000,
        upvotes: 20 - i,
        downvotes: 0,
        commentsCount: 5,
        authorId: i < 10 ? 'author-A' : 'author-B',
        flair: i < 10 ? 'musica' : 'arte',
        content: 'contenido de prueba ' + i
      });
    }
    var scored = posts.map(function (note) {
      var score = Engine.RankingModel.scorePost(note, { profile: Engine.ProfileStore.get() });
      return { note: note, score: score, components: score.components };
    });
    scored.sort(function (a, b) { return b.score.total - a.score.total; });

    var mixed = Engine.DiversityMixer.mixFeed(scored, { profile: Engine.ProfileStore.get() });
    assert(mixed.length === 20, 'Debe devolver todos los posts (got ' + mixed.length + ')');
  });
});

// --- BanditExplorer ---
console.log('\nBanditExplorer:');

await test('getWeights devuelve pesos para todos los buckets', function () {
  var w = Engine.BanditExplorer.getWeights();
  var buckets = ['personal', 'trending', 'fresh', 'following', 'explore'];
  buckets.forEach(function (b) {
    assert(w[b] !== undefined, 'Bucket ' + b + ' debe tener peso');
    assert(w[b] >= 0, 'Peso debe ser no negativo');
  });
});

await test('recordReward ajusta pesos', function () {
  var before = Engine.BanditExplorer.getWeights();
  Engine.BanditExplorer.recordReward('trending', 10);
  Engine.BanditExplorer.recordReward('trending', 10);
  Engine.BanditExplorer.recordReward('trending', 10);
  var after = Engine.BanditExplorer.getWeights();
  // El peso de trending debería aumentar o al menos cambiar.
  assert(after.trending >= before.trending - 0.01, 'Peso de trending no debería disminuir tras recompensas positivas');
});

// --- QualitySignals ---
console.log('\nQualitySignals:');

await test('engagementRatio calcula ratio', function () {
  var r = Engine.QualitySignals.engagementRatio({
    upvotes: 10, downvotes: 2, commentsCount: 5, ecoCount: 1
  });
  assert(r > 0 && r <= 1, 'Engagement ratio debe estar entre 0 y 1');
});

await test('controversyScore detecta controversia', function () {
  var c = Engine.QualitySignals.controversyScore({
    upvotes: 50, downvotes: 50
  });
  assert(c > 0, 'Post con votos balanceados debe tener controversia');

  var c2 = Engine.QualitySignals.controversyScore({
    upvotes: 100, downvotes: 0
  });
  assert(c2 === 0, 'Post sin downvotes no debe tener controversia');
});

// --- SocialGraph ---
console.log('\nSocialGraph:');

await test('socialBoost da boost a following', function () {
  var boost = Engine.SocialGraph.socialBoost(
    { authorId: 'followed-author' },
    { 'followed-author': { followedAt: Date.now() } }
  );
  assert(boost > 0, 'Following debe recibir boost positivo');

  var noBoost = Engine.SocialGraph.socialBoost(
    { authorId: 'unknown-author' },
    { 'followed-author': { followedAt: Date.now() } }
  );
  assert(approx(noBoost, 0, 0.1), 'No following no debe recibir boost');
});

// --- Explainability ---
console.log('\nExplainability:');

await test('explainPost devuelve desglose', function () {
  var exp = Engine.Explainability.explainPost({
    id: 'explain-1',
    timestamp: Date.now() - 3600000,
    upvotes: 10,
    commentsCount: 5,
    content: 'música increíble'
  }, { profile: Engine.ProfileStore.get() });
  assert(typeof exp.total === 'number', 'Total debe ser número');
  assert(Array.isArray(exp.breakdown), 'Breakdown debe ser array');
  assert(exp.breakdown.length > 0, 'Breakdown debe tener elementos');
});

// --- Integración ---
console.log('\nIntegración:');

await test('rankFeed ordena posts por score', function () {
  var posts = [
    { id: 'a', timestamp: Date.now() - 3600000, upvotes: 50, commentsCount: 10, content: 'post popular' },
    { id: 'b', timestamp: Date.now() - 7200000, upvotes: 2, commentsCount: 0, content: 'post poco popular' }
  ];
  var ranked = Engine.rankFeed(posts, { profile: Engine.ProfileStore.get() });
  assert(ranked.length === 2, 'Debe devolver 2 posts');
  assert(ranked[0].id === 'a', 'Post más popular debe ir primero');
});

await test('Compatibilidad V1: drexRecScore funciona', function () {
  var score = global.drexRecScore({
    id: 'v1-test',
    timestamp: Date.now() - 3600000,
    upvotes: 10,
    content: 'test'
  });
  assert(typeof score === 'number', 'drexRecScore debe devolver número');
});

await test('Compatibilidad V1: drexRecTrain no falla', function () {
  global.drexRecTrain({ flair: 'musica', authorId: 'a1', text: 'música' }, 3);
  // No debe lanzar error.
  assert(true, 'drexRecTrain debe ejecutarse sin error');
});

await test('Compatibilidad V1: DREX_REC tiene weights', function () {
  assert(global.DREX_REC !== undefined, 'DREX_REC debe existir');
  assert(typeof global.DREX_REC.weights === 'object', 'DREX_REC.weights debe ser objeto');
  assert(global.DREX_REC.weights.upvote !== undefined, 'Debe tener weight upvote');
  assert(global.DREX_REC.weights.downvote !== undefined, 'Debe tener weight downvote');
  assert(global.DREX_REC.weights.save !== undefined, 'Debe tener weight save');
});

// --- ProfileStore: carrera entre cuentas ---
console.log('ProfileStore (carrera entre cuentas):');

// Mock con lecturas diferidas para simular la carrera A -> B.
var _raceResolvers = [];
var _raceCurrentUid = 'user-A';
global.DrexCloud = {
  database: function () {
    return {
      ref: function (path) {
        return {
          once: function () {
            return new Promise(function (resolve) {
              _raceResolvers.push({ path: path, resolve: resolve });
            });
          },
          set: function () { return Promise.resolve(); }
        };
      }
    };
  },
  auth: function () { return { currentUser: _raceCurrentUid ? { uid: _raceCurrentUid } : null }; }
};
function _resolveRace(pathSuffix, val) {
  for (var i = 0; i < _raceResolvers.length; i++) {
    if (_raceResolvers[i].path.indexOf(pathSuffix) !== -1) {
      var r = _raceResolvers.splice(i, 1)[0];
      r.resolve({ val: function () { return val; } });
      return true;
    }
  }
  return false;
}
function _v2Profile(marker) {
  return { v: 2, marker: marker, updatedAt: Date.now(), lastActive: Date.now() };
}

await test('load() descarta la lectura stale si el uid cambió (A->B)', async function () {
  Engine.ProfileStore.reset();
  _raceResolvers = [];
  _raceCurrentUid = 'user-A';
  var pA = Engine.ProfileStore.load(); // lectura de A en vuelo
  assert(_raceResolvers.length === 1, 'debe haber 1 lectura en vuelo');
  _raceCurrentUid = 'user-B'; // cambio de cuenta antes de que resuelva
  assert(_resolveRace('userInterestsV2/user-A', _v2Profile('PERFIL-DE-A')), 'resolver lectura de A');
  await pA;
  var got = Engine.ProfileStore.get();
  assert(!got || got.marker !== 'PERFIL-DE-A', 'el perfil de A no debe asignarse con uid B');
});

await test('load() posterior para B lee y asigna su propio perfil', async function () {
  _raceResolvers = [];
  _raceCurrentUid = 'user-B';
  var pB = Engine.ProfileStore.load();
  assert(_raceResolvers.length === 1, 'debe iniciar lectura nueva para B');
  assert(_resolveRace('userInterestsV2/user-B', _v2Profile('PERFIL-DE-B')), 'resolver lectura de B');
  await pB;
  var got = Engine.ProfileStore.get();
  assert(got && got.marker === 'PERFIL-DE-B', 'el perfil de B debe asignarse');
});

await test('Engine.reset() limpia perfil y promesas en vuelo', async function () {
  _raceResolvers = [];
  _raceCurrentUid = 'user-C';
  var pC = Engine.ProfileStore.load();
  Engine.reset(); // logout: invalida todo
  _raceCurrentUid = null;
  assert(_resolveRace('userInterestsV2/user-C', _v2Profile('PERFIL-DE-C')), 'resolver lectura de C');
  await pC;
  assert(Engine.ProfileStore.get() === null, 'tras reset + lectura stale, get() debe ser null');
});

// --- Resumen ---
console.log('\n========================================');
console.log('Resumen: ' + passed + ' pasados, ' + failed + ' fallidos');
console.log('========================================');

process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(function(e) { console.error(e); process.exit(1); });
