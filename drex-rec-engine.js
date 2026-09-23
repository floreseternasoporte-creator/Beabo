/* ================================================================
 * DrexRecEngine v2 — Motor de recomendación de nueva generación.
 *
 * Arquitectura modular (cliente, vanilla JS, sin dependencias):
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │                    DrexRecEngine                          │
 *   │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐   │
 *   │  │ ProfileStore │  │ SignalTracker │  │ ContentAnalyzer│   │
 *   │  │ (V2: per-   │  │ (dwell, scroll│  │ (TF-IDF, n-   │   │
 *   │  │  signal     │  │  viewport,    │  │  grams, topic │   │
 *   │  │  decay)     │  │  media)       │  │  vectors)      │   │
 *   │  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘   │
 *   │         │                 │                  │            │
 *   │  ┌──────▼─────────────────▼──────────────────▼──────┐    │
 *   │  │              RankingModel                         │    │
 *   │  │  recency + popularity + personal + session +      │    │
 *   │  │  trend + quality + social + novelty + exploration │    │
 *   │  └──────────────────────┬───────────────────────────┘    │
 *   │  ┌──────────────────────▼───────────────────────────┐    │
 *   │  │            DiversityMixer                         │    │
 *   │  │  anti-repetición + topic spread + author spread   │    │
 *   │  └──────────────────────┬───────────────────────────┘    │
 *   │  ┌──────────────────────▼───────────────────────────┐    │
 *   │  │          BanditExplorer                           │    │
 *   │  │  70% exploit / 20% explore / 10% trending          │    │
 *   │  └──────────────────────┬───────────────────────────┘    │
 *   │  ┌──────────────────────▼───────────────────────────┐    │
 *   │  │          TrendingModel                            │    │
 *   │  │  velocity scoring + viral detection               │    │
 *   │  └──────────────────────┬───────────────────────────┘    │
 *   │  ┌──────────────────────▼───────────────────────────┐    │
 *   │  │          ColdStartModel                           │    │
 *   │  │  new-user fallback + new-post boost window        │    │
 *   │  └──────────────────────┬───────────────────────────┘    │
 *   │  ┌──────────────────────▼───────────────────────────┐    │
 *   │  │          SessionModel                             │    │
 *   │  │  gustos de la sesión actual (se resetea parcial)  │    │
 *   │  └──────────────────────┬───────────────────────────┘    │
 *   │  ┌──────────────────────▼───────────────────────────┐    │
 *   │  │          Explainability                           │    │
 *   │  │  explainPost() → { component, weight, ... }        │    │
 *   │  └──────────────────────────────────────────────────┘    │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Compatibilidad: las funciones globales antiguas (drexRecScore,
 * drexRecTrain, drexRecProfile, drexRecObserveCard, drexRecInsertForYou,
 * drexRecResortForYou) se puentean al motor nuevo. Los datos V1
 * (userInterests/<uid>) se migran a V2 (userInterestsV2/<uid>)
 * automáticamente en la primera carga.
 *
 * Copyright (c) 2026 Drex. Todos los derechos reservados.
 * ================================================================ */
(function (global) {
  'use strict';

  /* ================================================================
   * 0. Constantes y configuración global
   * ================================================================ */
  var ENGINE_VERSION = 2;
  var PROFILE_PATH_V2 = 'userInterestsV2';
  var PROFILE_PATH_V1 = 'userInterests'; // compatibilidad hacia atrás
  var BANDIT_PATH = 'recBandit';         // estado del multi-armed bandit
  var POST_STATS_PATH = 'postStats';     // estadísticas agregadas por post

  // Pesos de las señales de interacción (ajustables).
  // Incluye aliases V1 (view, deepView, up, down) para compatibilidad.
  var SIGNAL_WEIGHTS = {
    // Vistas
    view1s:        0.3,   // vista de ≥1 segundo
    view3s:        0.6,   // vista de ≥3 segundos
    view8s:        1.2,   // vista profunda ≥8s
    view20s:       2.0,   // vista muy profunda ≥20s
    scrollPast:   -0.15,  // hizo scroll rápido sin interactuar (skip)
    mediaClick:    0.8,   // abrió imagen/video del post
    openComments:  0.7,   // abrió la sección de comentarios
    // Interacciones sociales
    upvote:        3.0,
    downvote:     -3.5,
    unvote:       -1.0,
    save:          4.0,
    eco:           4.5,   // repost
    comment:       5.0,
    follow:        6.0,
    publish:       2.0,
    // Señales negativas
    hide:         -5.0,
    report:       -8.0,
    blockAuthor:  -7.0,
    // Aliases V1 (para compatibilidad con código que usa DREX_REC.weights.view, etc.)
    view:          0.3,
    deepView:      1.2,
    up:            3.0,
    down:         -3.5
  };

  // Vida media del decaimiento por categoría (días).
  var DECAY_HALF_LIFE = {
    flairs:    21,    // gustos por etiqueta decaen más lento
    authors:   14,    // afinidad por autor
    keywords:  10,    // palabras clave decaen más rápido (tendencias cambian)
    topics:    18,    // vectores de tema
    formats:   30,    // preferencia de formato (texto, imagen, video)
    times:     7,     // patrones por hora del día
    sessions:  2      // sesiones recientes decaen rápido
  };

  // Límites del perfil.
  var MAX_AUTHORS = 120;
  var MAX_KEYWORDS = 500;
  var MAX_TOPICS = 100;
  var MAX_FORMATS = 10;
  var MAX_TIME_SLOTS = 24;     // 24 horas
  var MAX_SESSION_ITEMS = 60;
  var MAX_NEGATIVE_AUTHORS = 30;
  var MAX_NEGATIVE_KEYWORDS = 50;

  // Pesos de los componentes del ranking final.
  var RANKING_WEIGHTS = {
    recency:        1.0,
    popularity:     0.8,
    personal:       1.5,
    session:        1.2,
    trend:          0.6,
    quality:        0.5,
    social:         0.7,
    novelty:        0.4,
    exploration:    0.3,
    diversity:      1.5,    // positivo: penaliza repetición (el componente es negativo)
    negative:      -2.0    // penalización fuerte por feedback negativo
  };

  // Configuración del multi-armed bandit.
  var BANDIT_CONFIG = {
    buckets: ['personal', 'trending', 'fresh', 'following', 'explore'],
    initialWeights: { personal: 0.55, trending: 0.15, fresh: 0.12, following: 0.10, explore: 0.08 },
    learningRate: 0.05,
    minWeight: 0.03,
    maxWeight: 0.70,
    rewardWindow: 50       // últimos N resultados para calcular recompensa
  };

  // Configuración del TrendingModel.
  var TRENDING_CONFIG = {
    velocityWindowHours: 6,     // ventana para calcular velocidad
    minInteractions: 3,         // mínimo para considerar trend
    velocityBoostMax: 25,      // boost máximo por velocidad
    freshPostWindowHours: 24,  // posts nuevos reciben boost
    freshPostBoost: 8,         // magnitud del boost de post nuevo
    viralMultiplier: 1.5,      // multiplicador para posts virales
    viralThreshold: 10         // interacciones/hora para considerar viral
  };

  // Configuración del DiversityMixer.
  var DIVERSITY_CONFIG = {
    maxConsecutiveSameAuthor: 2,
    maxConsecutiveSameFlair: 3,
    maxInWindow: {             // máximos en ventana deslizante de 10
      sameAuthor: 3,
      sameFlair: 4,
      sameFormat: 5
    },
    windowSize: 10,
    penaltyPerRepeat: 3.0,
    exploreRatio: 0.20,       // 20% del feed es exploración
    trendingRatio: 0.10,      // 10% del feed es trending
    exploitRatio: 0.70        // 70% del feed es explotación
  };

  // Stopwords ampliadas (ES, EN, ZH comunes).
  var STOPWORDS_ES = 'el,la,los,las,un,una,unos,unas,de,del,al,en,y,o,que,con,por,para,como,pero,si,mi,tu,su,sus,este,esta,esto,ese,esa,eso,lo,le,les,se,me,te,ya,muy,mas,tan,hay,son,es,era,fue,han,estoy,estas,estamos,estan,hecho,cosa,cosas,este,esta,aquel,aquella,aquellos,aquellas,nuestro,nuestra,vuestro,vuestra,su,sus,mio,mia,tuyo,tuya,suyo,suya,nada,algo,alguien,nadie,todos,todo,toda,todas,algun,alguna,algunos,algunas,ningun,ninguna,solo,sola,ambos,ambas,vez,veces,vez,vez,mismo,misma,mismos,mismas,tanto,tanta,tantos,tantas,poco,poca,pocos,pocas,mucho,mucha,muchos,muchas,demasiado,demasiada,otro,otra,otros,otras,tal,tan,segun,sin,sobre,tras,hasta,desde,durante,mediante,traves'.split(',');
  var STOPWORDS_EN = 'the,a,an,and,or,of,to,in,on,for,with,that,this,these,those,is,are,was,were,be,been,have,has,had,you,your,yours,my,mine,his,her,their,ours,not,but,from,at,by,as,it,its,so,if,then,than,too,very,can,will,just,about,into,over,after,before,up,out,do,did,done,what,when,where,which,who,how,all,also,there,here,would,could,should,may,might,must,shall,let,lets,us,we,they,them,him,she,he,i,me,am,being,having,doing,saying,going,getting,making,taking,giving,looking,coming,trying,want,need,feel,think,know,see,hear,say,tell,ask,find,use,make,want,need,way,thing,stuff,lot,bit,moment,people,someone,something,anything,nothing,everything,somewhere,anywhere,nowhere,everywhere'.split(',');
  var STOPWORDS = {};
  STOPWORDS_ES.forEach(function (w) { STOPWORDS[w] = true; });
  STOPWORDS_EN.forEach(function (w) { STOPWORDS[w] = true; });

  /* ================================================================
   * 1. Utilidades generales
   * ================================================================ */

  function _now() { return Date.now(); }
  function _hoursAgo(ts) { return Math.max(0, (_now() - Number(ts || 0)) / 3600000); }
  function _daysAgo(ts) { return Math.max(0, (_now() - Number(ts || 0)) / 86400000); }

  // Saturación 0..10 (y -10..0 en negativo): ningún gusto domina la frescura.
  function _sat(v) {
    v = Number(v) || 0;
    if (v >= 0) return 10 * v / (v + 12);
    return Math.max(-10, 10 * v / (12 - v));
  }

  // Saturación 0..1 para normalizar.
  function _sat01(v) {
    v = Number(v) || 0;
    if (v >= 0) return v / (v + 1);
    return 0;
  }

  // Hash determinístico FNV-1a.
  function _hash(s) {
    s = String(s == null ? '' : s);
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // Clampeo.
  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Logaritmo seguro.
  function _safeLog(v) { return Math.log10(Math.max(1, v)); }

  // Genera un ID push-style (20 chars, ordenado por tiempo).
  var PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  var _lastPushTime = 0;
  var _lastRandChars = [];
  function _newPushId() {
    var now = Date.now();
    var dup = (now === _lastPushTime);
    _lastPushTime = now;
    var ts = new Array(8);
    var i;
    for (i = 7; i >= 0; i--) { ts[i] = PUSH_CHARS.charAt(now % 64); now = Math.floor(now / 64); }
    var id = ts.join('');
    if (!dup) { for (i = 0; i < 12; i++) _lastRandChars[i] = Math.floor(Math.random() * 64); }
    else { for (i = 11; i >= 0 && _lastRandChars[i] === 63; i--) _lastRandChars[i] = 0; _lastRandChars[i]++; }
    for (i = 0; i < 12; i++) id += PUSH_CHARS.charAt(_lastRandChars[i]);
    return id;
  }

  function _isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function _deepClone(o) {
    if (o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(_deepClone);
    var r = {};
    for (var k in o) { if (o.hasOwnProperty(k)) r[k] = _deepClone(o[k]); }
    return r;
  }

  // Mezcla aleatoria determinista por semilla (Fisher-Yates).
  function _seededShuffle(arr, seed) {
    arr = arr.slice();
    var s = _hash(String(seed || ''));
    for (var i = arr.length - 1; i > 0; i--) {
      s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d);
      var j = (s >>> 0) % (i + 1);
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  // Hora del día actual (0-23).
  function _currentHour() {
    try { return new Date().getHours(); } catch (_) { return 12; }
  }

  // Día de la semana (0=domingo .. 6=sábado).
  function _currentDayOfWeek() {
    try { return new Date().getDay(); } catch (_) { return 0; }
  }

  /* ================================================================
   * 2. ContentAnalyzer — extracción de características de contenido
   *
   * Extrae: keywords, n-grams, topic vectors, formato, idioma detectado,
   * longitud, sentimiento aproximado, densidad de medios.
   * ================================================================ */

  var ContentAnalyzer = (function () {

    // Normaliza texto a minúsculas, sin acentos para ES/EN.
    function _normalize(text) {
      return String(text || '')
        .toLowerCase()
        .replace(/[áàäâ]/g, 'a').replace(/[éèëê]/g, 'e')
        .replace(/[íìïî]/g, 'i').replace(/[óòöô]/g, 'o')
        .replace(/[úùüû]/g, 'u').replace(/ñ/g, 'n')
        .replace(/[ç]/g, 'c');
    }

    // Frecuencias de términos en una sola pasada: normaliza el texto y corre
    // los regex una sola vez. Lo usan extractKeywords (con bigramas latinos)
    // y extractTopicVector (sin bigramas). Evita duplicar _normalize +
    // 3 regex por cada análisis.
    function _termFreq(text, withBigrams) {
      var freq = {};
      try {
        var t = _normalize(text);
        // Palabras latinas
        var words = (t.match(/[a-z]{4,}/g) || []);
        for (var i = 0; i < words.length; i++) {
          var w = words[i];
          if (w.length <= 20 && !STOPWORDS[w]) freq[w] = (freq[w] || 0) + 1;
        }
        // N-grams de 2 palabras (bigrams) en español/inglés
        if (withBigrams) {
          var bigrams = (t.match(/[a-z]+ [a-z]+/g) || []);
          for (var j = 0; j < bigrams.length; j++) {
            var parts = bigrams[j].split(' ');
            if (parts.length === 2 && !STOPWORDS[parts[0]] && !STOPWORDS[parts[1]] &&
                parts[0].length >= 3 && parts[1].length >= 3) {
              var bg = parts[0] + '_' + parts[1];
              freq[bg] = (freq[bg] || 0) + 0.7; // bigrams pesan un poco menos
            }
          }
        }
        // Bigramas CJK solapados
        var cjk = (t.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{2,}/g) || []);
        for (var k = 0; k < cjk.length; k++) {
          var seg = cjk[k];
          for (var m = 0; m + 1 < seg.length && m < 14; m++) {
            var bi = seg.slice(m, m + 2);
            freq[bi] = (freq[bi] || 0) + 1;
          }
        }
      } catch (_) {}
      return freq;
    }

    // Palabras clave: latinas (4+ letras, sin stopwords) + bigramas CJK.
    function extractKeywords(text) {
      var out = [];
      try {
        var freq = _termFreq(text, true);
        // Top 12 por frecuencia
        var keys = Object.keys(freq);
        keys.sort(function (a, b) { return freq[b] - freq[a]; });
        keys.slice(0, 12).forEach(function (w) { out.push(w); });
      } catch (_) {}
      return out;
    }

    // Extrae el vector de tema (topic vector) del post.
    // Un topic vector es un mapa { keyword: weight } normalizado.
    function extractTopicVector(text) {
      var tv = {};
      try {
        var freq = _termFreq(text, false);
        var total = 0;
        for (var k in freq) total += freq[k];
        if (total > 0) {
          for (var kk in freq) tv[kk] = freq[kk] / total;
        }
      } catch (_) {}
      return tv;
    }

    // Detecta el formato del post.
    function detectFormat(note) {
      try {
        var ic = Number(note.imageCount || 0);
        var vc = note.videoUrl ? 1 : 0;
        var hasPoll = note.poll && note.poll.options;
        var hasText = (note.content || note.text || '').trim().length > 0;
        if (vc > 0) return 'video';
        if (ic >= 4) return 'gallery';
        if (ic > 0) return 'image';
        if (hasPoll) return 'poll';
        if (hasText) return 'text';
        return 'other';
      } catch (_) { return 'text'; }
    }

    // Similitud coseno entre dos topic vectors.
    function cosineSim(tv1, tv2) {
      try {
        var dot = 0, mag1 = 0, mag2 = 0;
        for (var k in tv1) {
          if (tv2[k] !== undefined) {
            dot += tv1[k] * tv2[k];
          }
          mag1 += tv1[k] * tv1[k];
        }
        for (var kk in tv2) mag2 += tv2[kk] * tv2[kk];
        if (mag1 === 0 || mag2 === 0) return 0;
        return dot / (Math.sqrt(mag1) * Math.sqrt(mag2));
      } catch (_) { return 0; }
    }

    // Similitud de Jaccard entre dos listas de keywords.
    function jaccardSim(a, b) {
      try {
        var setA = {}, setB = {};
        a.forEach(function (k) { setA[k] = true; });
        b.forEach(function (k) { setB[k] = true; });
        var inter = 0, union = 0;
        var all = {};
        for (var k in setA) { all[k] = true; if (setB[k]) inter++; }
        for (var kk in setB) { all[kk] = true; }
        for (var u in all) union++;
        if (union === 0) return 0;
        return inter / union;
      } catch (_) { return 0; }
    }

    // Calcula la "calidad" del contenido: longitud, riqueza, multimedia.
    function contentQuality(note) {
      try {
        var text = String(note.content || note.text || '');
        var len = text.trim().length;
        var score = 0;
        // Longitud óptima: 50-500 caracteres
        if (len >= 50 && len <= 500) score += 2;
        else if (len > 500) score += 1.5;
        else if (len > 0) score += 0.5;
        // Multimedia aumenta calidad
        var ic = Number(note.imageCount || 0);
        if (ic > 0) score += 0.8;
        if (note.videoUrl) score += 1.2;
        if (note.poll && note.poll.options) score += 0.6;
        // Formato rico (galería)
        if (ic >= 3) score += 0.5;
        return score;
      } catch (_) { return 0; }
    }

    // Análisis completo de un post.
    function analyze(note) {
      var text = String(note.content || note.text || '');
      var kws = extractKeywords(text);
      var tv = extractTopicVector(text);
      var fmt = detectFormat(note);
      var ql = contentQuality(note);
      return {
        keywords: kws,
        topicVector: tv,
        format: fmt,
        quality: ql,
        textLength: text.trim().length
      };
    }

    return {
      extractKeywords: extractKeywords,
      extractTopicVector: extractTopicVector,
      detectFormat: detectFormat,
      cosineSim: cosineSim,
      jaccardSim: jaccardSim,
      contentQuality: contentQuality,
      analyze: analyze,
      normalize: _normalize
    };
  })();

  /* ================================================================
   * 3. ProfileStore — perfil de usuario V2 con decaimiento por señal
   *
   * Estructura del perfil V2:
   * {
   *   v: 2,
   *   updatedAt: timestamp,
   *   flairs: { flairId: weight },          // afinidad por etiqueta
   *   authors: { authorId: weight },        // afinidad por autor
   *   keywords: { keyword: weight },        // afinidad por palabra clave
   *   topics: { topicHash: weight },        // afinidad por vector de tema
   *   formats: { format: weight },           // preferencia de formato
   *   timeSlots: { hour: weight },          // patrones por hora
   *   negativeAuthors: { authorId: weight }, // autores con feedback negativo
   *   negativeKeywords: { keyword: weight }, // keywords negativas
   *   sessionItems: [{ flair, authorId, keywords, ts }], // sesión actual
   *   interactedPosts: { noteId: true },    // posts ya vistos/interactuados
   *   bandit: { bucket: { pulls, reward } }, // estado del bandit
   *   totalInteractions: number,
   *   firstSeen: timestamp,
   *   lastActive: timestamp
   * }
   * ================================================================ */

  var ProfileStore = (function () {
    var _profile = null;
    var _profileUid = null;
    var _profilePromise = null;
    var _saveTimer = null;
    var _analysisCache = {}; // noteId -> ContentAnalyzer.analyze result

    function _emptyProfile() {
      return {
        v: ENGINE_VERSION,
        updatedAt: _now(),
        firstSeen: _now(),
        lastActive: _now(),
        totalInteractions: 0,
        flairs: {},
        authors: {},
        keywords: {},
        topics: {},
        formats: {},
        timeSlots: {},
        negativeAuthors: {},
        negativeKeywords: {},
        sessionItems: [],
        interactedPosts: {},
        bandit: {}
      };
    }

    // Migra un perfil V1 a V2.
    function _migrateV1(v1) {
      var p = _emptyProfile();
      try {
        if (v1 && typeof v1 === 'object') {
          if (v1.flairs && typeof v1.flairs === 'object') p.flairs = _deepClone(v1.flairs);
          if (v1.authors && typeof v1.authors === 'object') p.authors = _deepClone(v1.authors);
          if (v1.keywords && typeof v1.keywords === 'object') p.keywords = _deepClone(v1.keywords);
          if (v1.updatedAt) p.lastActive = Number(v1.updatedAt);
        }
      } catch (_) {}
      return p;
    }

    // Aplica decaimiento por categoría con sus propias vidas medias.
    function _applyDecay(p) {
      try {
        var days = _daysAgo(p.updatedAt);
        if (days < 0.1) return p;
        var categories = [
          ['flairs', DECAY_HALF_LIFE.flairs],
          ['authors', DECAY_HALF_LIFE.authors],
          ['keywords', DECAY_HALF_LIFE.keywords],
          ['topics', DECAY_HALF_LIFE.topics],
          ['formats', DECAY_HALF_LIFE.formats],
          ['timeSlots', DECAY_HALF_LIFE.times],
          ['negativeAuthors', DECAY_HALF_LIFE.authors],
          ['negativeKeywords', DECAY_HALF_LIFE.keywords]
        ];
        categories.forEach(function (cat) {
          var key = cat[0], halfLife = cat[1];
          var factor = Math.pow(0.5, days / halfLife);
          var obj = p[key];
          if (!_isObj(obj)) return;
          for (var k in obj) {
            obj[k] = obj[k] * factor;
            if (Math.abs(obj[k]) < 0.03) delete obj[k];
          }
        });
        // Session items decaen muy rápido (se eliminan >48h)
        if (Array.isArray(p.sessionItems)) {
          var cutoff = _now() - 86400000 * 2;
          p.sessionItems = p.sessionItems.filter(function (item) {
            return (item.ts || 0) > cutoff;
          });
        }
        p.updatedAt = _now();
      } catch (_) {}
      return p;
    }

    // Recorta los mapas a sus límites.
    function _trim(p) {
      try {
        var _topN = function (obj, n) {
          var keys = Object.keys(obj || {});
          if (keys.length <= n) return;
          keys.sort(function (a, b) { return Math.abs(obj[b]) - Math.abs(obj[a]); });
          keys.slice(n).forEach(function (k) { delete obj[k]; });
        };
        _topN(p.authors, MAX_AUTHORS);
        _topN(p.keywords, MAX_KEYWORDS);
        _topN(p.topics, MAX_TOPICS);
        _topN(p.formats, MAX_FORMATS);
        _topN(p.negativeAuthors, MAX_NEGATIVE_AUTHORS);
        _topN(p.negativeKeywords, MAX_NEGATIVE_KEYWORDS);
        if (Array.isArray(p.sessionItems) && p.sessionItems.length > MAX_SESSION_ITEMS) {
          p.sessionItems = p.sessionItems.slice(-MAX_SESSION_ITEMS);
        }
      } catch (_) {}
    }

    function _getDB() {
      try {
        return global.DrexCloud ? global.DrexCloud.database() : null;
      } catch (_) { return null; }
    }

    function _getCurrentUid() {
      try {
        var user = global.DrexCloud ? global.DrexCloud.auth().currentUser : null;
        return user ? user.uid : null;
      } catch (_) { return null; }
    }

    // Carga el perfil (V2 o migra V1).
    // FIX carrera entre cuentas: el uid se captura al iniciar la lectura y
    // cada continuación asíncrona verifica que siga siendo el actual antes de
    // asignar _profile. Sin esto, si A cierra sesión y B entra mientras la
    // lectura de A vuela, el perfil de A quedaba bajo el UID de B (y un
    // flush() posterior lo persistía contaminado).
    function load() {
      var uid = _getCurrentUid();
      if (!uid) return Promise.resolve(_emptyProfile());
      if (_profile && _profileUid === uid) return Promise.resolve(_profile);
      if (_profilePromise && _profileUid === uid) return _profilePromise;

      _profileUid = uid;
      var requestedUid = uid;
      var db = _getDB();
      if (!db) { _profile = _emptyProfile(); return Promise.resolve(_profile); }

      function _stale() { return requestedUid !== _getCurrentUid(); }

      var p = db.ref(PROFILE_PATH_V2 + '/' + uid).once('value')
        .then(function (snap) {
          if (_stale()) { if (_profilePromise === p) _profilePromise = null; return _profile; }
          var raw = snap.val();
          if (raw && typeof raw === 'object' && raw.v === ENGINE_VERSION) {
            _profile = _applyDecay(_deepClone(raw));
          } else {
            // Intentar migrar V1
            return db.ref(PROFILE_PATH_V1 + '/' + uid).once('value')
              .then(function (v1snap) {
                if (_stale()) { if (_profilePromise === p) _profilePromise = null; return _profile; }
                var v1 = v1snap.val();
                _profile = _migrateV1(v1);
                // Guardar la migración inmediatamente
                _persistNow();
                return _profile;
              })
              .catch(function () {
                if (_stale()) { if (_profilePromise === p) _profilePromise = null; return _profile; }
                _profile = _emptyProfile();
                return _profile;
              });
          }
          return _profile;
        })
        .catch(function () {
          if (_stale()) { if (_profilePromise === p) _profilePromise = null; return _profile; }
          _profile = _emptyProfile();
          return _profile;
        });
      _profilePromise = p;

      return _profilePromise;
    }

    function _persistNow() {
      try {
        var uid = _getCurrentUid();
        if (!uid || !_profile || _profileUid !== uid) return;
        _profile.updatedAt = _now();
        _profile.lastActive = _now();
        _trim(_profile);
        var db = _getDB();
        if (db) db.ref(PROFILE_PATH_V2 + '/' + uid).set(_profile).catch(function () {});
      } catch (_) {}
    }

    function scheduleSave() {
      try {
        var uid = _getCurrentUid();
        if (!uid || !_profile || _profileUid !== uid) return;
        if (_saveTimer) return;
        _saveTimer = setTimeout(function () { _saveTimer = null; _persistNow(); }, 15000);
      } catch (_) {}
    }

    function flush() {
      try {
        if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
        _persistNow();
      } catch (_) {}
    }

    function get() { return _profile; }

    function reset() {
      _profile = null;
      _profileUid = null;
      _profilePromise = null;
      if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
      _analysisCache = {};
    }

    // Cachea el análisis de contenido de un post.
    function cacheAnalysis(noteId, analysis) {
      _analysisCache[noteId] = analysis;
    }

    function getCachedAnalysis(noteId) {
      return _analysisCache[noteId] || null;
    }

    // Registra que el usuario interactuó con un post.
    function markInteracted(noteId) {
      try {
        if (!_profile) return;
        if (!_profile.interactedPosts) _profile.interactedPosts = {};
        _profile.interactedPosts[noteId] = true;
        // Limitar tamaño
        var keys = Object.keys(_profile.interactedPosts);
        if (keys.length > 2000) {
          // Eliminar los más viejos (no tenemos timestamp por post, así que eliminamos aleatoriamente la mitad)
          keys.slice(0, 1000).forEach(function (k) { delete _profile.interactedPosts[k]; });
        }
      } catch (_) {}
    }

    function hasInteracted(noteId) {
      return _profile && _profile.interactedPosts && !!_profile.interactedPosts[noteId];
    }

    return {
      load: load,
      get: get,
      flush: flush,
      scheduleSave: scheduleSave,
      reset: reset,
      cacheAnalysis: cacheAnalysis,
      getCachedAnalysis: getCachedAnalysis,
      markInteracted: markInteracted,
      hasInteracted: hasInteracted,
      _emptyProfile: _emptyProfile,
      _applyDecay: _applyDecay
    };
  })();

  /* ================================================================
   * 4. SignalTracker — seguimiento granular de señales de interacción
   *
   * Registra: dwell time (1s/3s/8s/20s), scroll velocity, viewport ratio,
   * media clicks, open comments, y todas las interacciones sociales.
   * ================================================================ */

  var SignalTracker = (function () {
    var _viewObserver = null;
    var _viewTimers = new Map();    // element -> { t1, t2, t3, t4, trained: Set }
    var _scrollData = new Map();    // element -> { lastY, lastTs, velocity }
    var _sessionStartTime = _now();
    var _sessionInteractions = 0;
    var _scrollHandler = null;
    var _scrollAttached = false;

    // Entrena el perfil con una señal.
    function _trainSignal(noteId, weight, meta) {
      try {
        if (!noteId || !weight) return;
        var p = ProfileStore.get();
        if (!p) return;
        var noteMeta = meta || _getNoteMeta(noteId);
        if (!noteMeta) return;

        var bump = function (obj, key, w) {
          if (!key || !obj) return;
          obj[key] = _clamp((Number(obj[key]) || 0) + w, -15, 300);
        };

        // Flair
        if (noteMeta.flair) bump(p.flairs, String(noteMeta.flair), weight);
        // Author
        if (noteMeta.authorId) bump(p.authors, String(noteMeta.authorId), weight);
        // Keywords
        var kws = ContentAnalyzer.extractKeywords(noteMeta.text || '');
        kws.forEach(function (w) { bump(p.keywords, w, weight * 0.6); });
        // Topic vector
        var tv = ContentAnalyzer.extractTopicVector(noteMeta.text || '');
        var tvHash = _hash(JSON.stringify(Object.keys(tv).sort()));
        bump(p.topics, String(tvHash), weight * 0.5);
        // Format
        var fmt = ContentAnalyzer.detectFormat(noteMeta);
        bump(p.formats, fmt, weight * 0.4);
        // Time slot
        var hour = _currentHour();
        bump(p.timeSlots, String(hour), weight * 0.3);

        // Señales negativas
        if (weight < 0) {
          if (noteMeta.authorId) bump(p.negativeAuthors, String(noteMeta.authorId), Math.abs(weight));
          kws.forEach(function (w) { bump(p.negativeKeywords, w, Math.abs(weight) * 0.5); });
        }

        // Session items
        p.sessionItems.push({
          flair: noteMeta.flair || null,
          authorId: noteMeta.authorId || null,
          keywords: kws.slice(0, 4),
          ts: _now(),
          weight: weight
        });
        if (p.sessionItems.length > MAX_SESSION_ITEMS) {
          p.sessionItems = p.sessionItems.slice(-MAX_SESSION_ITEMS);
        }

        p.totalInteractions = (p.totalInteractions || 0) + 1;
        p.lastActive = _now();
        ProfileStore.markInteracted(noteId);
        ProfileStore.scheduleSave();
      } catch (_) {}
    }

    // Obtiene los metadatos de un post desde el cache del feed.
    function _getNoteMeta(noteId) {
      try {
        if (typeof global._drexNoteMeta !== 'undefined' && global._drexNoteMeta[noteId]) {
          return global._drexNoteMeta[noteId];
        }
      } catch (_) {}
      return null;
    }

    // Lee un post desde la DB si no está en caché.
    function _fetchNoteMeta(noteId) {
      try {
        var db = global.DrexCloud ? global.DrexCloud.database() : null;
        if (!db) return Promise.resolve(null);
        return db.ref('communityNotes/' + noteId).once('value').then(function (snap) {
          var n = snap.val() || {};
          var meta = {
            flair: n.flair || null,
            authorId: n.authorId || n.userId || null,
            text: n.content || n.text || '',
            ts: Number(n.timestamp || 0),
            up: Number(n.upvotes || 0),
            down: Number(n.downvotes || 0),
            cc: Number(n.commentsCount || 0)
          };
          if (typeof global._drexNoteMeta !== 'undefined') {
            global._drexNoteMeta[noteId] = meta;
          }
          return meta;
        }).catch(function () { return null; });
      } catch (_) { return Promise.resolve(null); }
    }

    // Entrena por ID de post.
    function trainById(noteId, weight) {
      try {
        if (!noteId || !weight) return;
        var meta = _getNoteMeta(noteId);
        if (meta) { _trainSignal(noteId, weight, meta); return; }
        _fetchNoteMeta(noteId).then(function (m) {
          if (m) _trainSignal(noteId, weight, m);
        });
      } catch (_) {}
    }

    // Observa una tarjeta para tracking de vistas.
    function observeCard(el) {
      try {
        if (!el || el.dataset.recObservedV2) return;
        el.dataset.recObservedV2 = '1';
        if (!_viewObserver) {
          _viewObserver = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
              var target = en.target;
              var st = _viewTimers.get(target);
              if (en.isIntersecting) {
                if (st) return;
                var rec = { trained: new Set(), timers: [] };
                _viewTimers.set(target, rec);
                // Scroll tracking
                _attachScroll();
                _scrollData.set(target, { lastY: window.scrollY, lastTs: _now(), velocity: 0, maxVel: 0 });
                // Dwell time escalonado: 1s, 3s, 8s, 20s
                var stages = [
                  { delay: 1000,  key: 'v1',  weight: SIGNAL_WEIGHTS.view1s },
                  { delay: 3000,  key: 'v3',  weight: SIGNAL_WEIGHTS.view3s },
                  { delay: 8000,  key: 'v8',  weight: SIGNAL_WEIGHTS.view8s },
                  { delay: 20000, key: 'v20', weight: SIGNAL_WEIGHTS.view20s }
                ];
                stages.forEach(function (stage) {
                  var t = setTimeout(function () {
                    try {
                      if (!target.isConnected) return;
                      var nid = target.dataset.noteId;
                      if (!nid || rec.trained.has(stage.key)) return;
                      rec.trained.add(stage.key);
                      _trainSignal(nid, stage.weight);
                    } catch (_) {}
                  }, stage.delay);
                  rec.timers.push(t);
                });
              } else {
                // Salió del viewport: limpiar timers y calcular skip
                if (st) {
                  if (st.timers) st.timers.forEach(function (t) { clearTimeout(t); });
                  // Si no fue entrenado ni siquiera con view1s, fue un skip rápido
                  var nid = target.dataset.noteId;
                  if (nid && st.trained.size === 0) {
                    _trainSignal(nid, SIGNAL_WEIGHTS.scrollPast);
                  }
                  _viewTimers.delete(target);
                  _scrollData.delete(target);
                }
              }
            });
          }, { threshold: 0.35 });
        }
        _viewObserver.observe(el);
      } catch (_) {}
    }

    // Scroll tracking: mide la velocidad de scroll para detectar skips.
    function _attachScroll() {
      if (_scrollAttached) return;
      _scrollAttached = true;
      _scrollHandler = function () {
        var now = _now();
        var y = window.scrollY;
        _viewTimers.forEach(function (rec, el) {
          var sd = _scrollData.get(el);
          if (!sd) return;
          var dt = Math.max(1, now - sd.lastTs);
          var dy = y - sd.lastY;
          var vel = Math.abs(dy) / dt; // px por ms
          sd.velocity = vel;
          sd.maxVel = Math.max(sd.maxVel, vel);
          sd.lastY = y;
          sd.lastTs = now;
        });
      };
      try {
        var target = document.getElementById('scrollable-content') || window;
        target.addEventListener('scroll', _scrollHandler, { passive: true });
      } catch (_) {}
    }

    // API pública de entrenamiento manual.
    function train(meta, weight) {
      try {
        if (!meta || !(weight = Number(weight))) return;
        var fakeNoteId = 'manual_' + _newPushId();
        var m = {
          flair: meta.flair || null,
          authorId: meta.authorId || null,
          text: meta.text || '',
          ts: _now(),
          up: 0, down: 0, cc: 0
        };
        if (typeof global._drexNoteMeta !== 'undefined') {
          global._drexNoteMeta[fakeNoteId] = m;
        }
        _trainSignal(fakeNoteId, weight, m);
      } catch (_) {}
    }

    function trainFollow(authorId) {
      if (authorId) train({ flair: null, authorId: String(authorId), text: '' }, SIGNAL_WEIGHTS.follow);
    }

    function getSessionInfo() {
      return {
        startTime: _sessionStartTime,
        duration: _now() - _sessionStartTime,
        interactions: _sessionInteractions
      };
    }

    function incrementSession() { _sessionInteractions++; }

    function cleanup() {
      try {
        if (_viewObserver) {
          _viewTimers.forEach(function (rec, el) {
            if (rec.timers) rec.timers.forEach(function (t) { clearTimeout(t); });
            try { _viewObserver.unobserve(el); } catch (_) {}
          });
          _viewTimers.clear();
          _scrollData.clear();
        }
      } catch (_) {}
    }

    return {
      observeCard: observeCard,
      train: train,
      trainById: trainById,
      trainFollow: trainFollow,
      getSessionInfo: getSessionInfo,
      incrementSession: incrementSession,
      cleanup: cleanup,
      SIGNAL_WEIGHTS: SIGNAL_WEIGHTS
    };
  })();

  /* ================================================================
   * 5. SessionModel — preferencias de la sesión actual
   *
   * A diferencia del perfil persistente, el SessionModel captura lo que
   * el usuario está haciendo AHORA. Da peso fuerte a interacciones
   * recientes (última hora) para adaptar el feed en tiempo real.
   * ================================================================ */

  var SessionModel = (function () {
    var _sessionStart = _now();
    var _interactions = []; // [{ flair, authorId, keywords, ts, weight }]

    function record(meta, weight) {
      try {
        if (!meta) return;
        var kws = ContentAnalyzer.extractKeywords(meta.text || '');
        _interactions.push({
          flair: meta.flair || null,
          authorId: meta.authorId || null,
          keywords: kws.slice(0, 4),
          ts: _now(),
          weight: weight
        });
        // Mantener solo las últimas 80
        if (_interactions.length > 80) _interactions = _interactions.slice(-80);
      } catch (_) {}
    }

    // Calcula afinidad de sesión con un post.
    function sessionAffinity(note) {
      try {
        if (!_interactions.length) return 0;
        var now = _now();
        var score = 0;

        // Solo usar interacciones de los últimos 60 minutos
        var recent = _interactions.filter(function (it) {
          return (now - it.ts) < 3600000;
        });
        if (!recent.length) return 0;

        var noteFlair = note.flair || null;
        var noteAuthor = note.authorId || note.userId || null;
        var noteKws = ContentAnalyzer.extractKeywords(note.content || note.text || '');

        // Peso decrece con el tiempo (las más recientes pesan más)
        recent.forEach(function (it, idx) {
          var ageFactor = 1 - (idx / Math.max(recent.length, 1)) * 0.5; // 1.0 -> 0.5
          var w = it.weight * ageFactor;

          if (noteFlair && it.flair === noteFlair) score += Math.abs(w) * 0.5;
          if (noteAuthor && it.authorId === noteAuthor) score += Math.abs(w) * 0.8;

          // Coincidencia de keywords
          var overlap = 0;
          it.keywords.forEach(function (k) {
            if (noteKws.indexOf(k) >= 0) overlap++;
          });
          if (overlap > 0) score += Math.abs(w) * 0.3 * Math.min(overlap, 3);

          // Interacciones negativas reducen afinidad
          if (w < 0) {
            if (noteAuthor && it.authorId === noteAuthor) score -= 2;
            if (overlap > 0) score -= 1;
          }
        });

        return _sat(score);
      } catch (_) { return 0; }
    }

    function reset() {
      _sessionStart = _now();
      _interactions = [];
    }

    function getStats() {
      return {
        duration: _now() - _sessionStart,
        interactionCount: _interactions.length,
        recentCount: _interactions.filter(function (it) { return (_now() - it.ts) < 3600000; }).length
      };
    }

    return {
      record: record,
      sessionAffinity: sessionAffinity,
      reset: reset,
      getStats: getStats
    };
  })();

  /* ================================================================
   * 6. TrendingModel — detección de tendencias y contenido viral
   *
   * Calcula la velocidad de interacciones (votos/comentarios/ecos por hora)
   * para detectar posts que están ganando tracción rápidamente.
   * ================================================================ */

  var TrendingModel = (function () {

    // Calcula el score de trending de un post.
    function trendingScore(note) {
      try {
        var ts = Number(note.timestamp || 0);
        var ageH = ts > 0 ? _hoursAgo(ts) : 72;
        if (ageH > 72) return 0; // más de 3 días: ya no es trending

        var upvotes = Number(note.upvotes || 0);
        var downvotes = Number(note.downvotes || 0);
        var comments = Number(note.commentsCount || 0);
        var ecos = Number(note.ecoCount || 0);
        var views = Number(note.viewsCount || 0);

        // Net engagement
        var net = Math.max(0, upvotes - downvotes);

        // Velocidad: interacciones por hora
        var effectiveAge = Math.max(0.5, ageH); // evitar división por 0
        var velocity = (net + comments * 1.5 + ecos * 2) / effectiveAge;

        // Boost de post fresco (primeras 24h)
        var freshBoost = 0;
        if (ageH < TRENDING_CONFIG.freshPostWindowHours) {
          var freshFactor = 1 - (ageH / TRENDING_CONFIG.freshPostWindowHours);
          freshBoost = TRENDING_CONFIG.freshPostBoost * freshFactor;
        }

        // Detección viral: interacciones/hora > umbral
        var viralBoost = 0;
        if (velocity > TRENDING_CONFIG.viralThreshold) {
          viralBoost = (velocity - TRENDING_CONFIG.viralThreshold) * TRENDING_CONFIG.viralMultiplier;
          viralBoost = Math.min(viralBoost, TRENDING_CONFIG.velocityBoostMax);
        }

        // Views dan signal de alcance pero no de calidad
        var reachScore = _safeLog(views) * 0.3;

        // Score total
        var score = _sat(velocity * 2 + freshBoost + viralBoost) + reachScore;

        return score;
      } catch (_) { return 0; }
    }

    // Determina si un post es "fresco" (recién publicado).
    function isFresh(note) {
      try {
        var ageH = _hoursAgo(Number(note.timestamp || 0));
        return ageH < TRENDING_CONFIG.freshPostWindowHours;
      } catch (_) { return false; }
    }

    // Determina si un post es "viral".
    function isViral(note) {
      try {
        var ts = Number(note.timestamp || 0);
        var ageH = ts > 0 ? _hoursAgo(ts) : 72;
        if (ageH > 48) return false;
        var upvotes = Number(note.upvotes || 0);
        var downvotes = Number(note.downvotes || 0);
        var comments = Number(note.commentsCount || 0);
        var ecos = Number(note.ecoCount || 0);
        var effectiveAge = Math.max(0.5, ageH);
        var velocity = (Math.max(0, upvotes - downvotes) + comments * 1.5 + ecos * 2) / effectiveAge;
        return velocity > TRENDING_CONFIG.viralThreshold;
      } catch (_) { return false; }
    }

    return {
      trendingScore: trendingScore,
      isFresh: isFresh,
      isViral: isViral
    };
  })();

  /* ================================================================
   * 7. ColdStartModel — manejo de usuarios nuevos y posts nuevos
   *
   * Usuario nuevo: usa trending + diversidad + flairs variados.
   * Post nuevo: le da una ventana inicial de exposición.
   * ================================================================ */

  var ColdStartModel = (function () {

    // Determina si el usuario es "nuevo" (pocas interacciones).
    function isColdStartUser(profile) {
      try {
        return !profile || (profile.totalInteractions || 0) < 15;
      } catch (_) { return true; }
    }

    // Score de cold start para un post (para usuarios nuevos).
    function coldStartScore(note) {
      try {
        var ts = Number(note.timestamp || 0);
        var ageH = ts > 0 ? _hoursAgo(ts) : 72;

        // Para cold start: mezclar frescura + popularidad + diversidad
        var recency = 60 * Math.exp(-ageH / 30);
        var net = Math.max(0, Number(note.upvotes || 0) - Number(note.downvotes || 0));
        var popularity = 10 * _safeLog(1 + net) + 4 * _safeLog(1 + Number(note.commentsCount || 0));

        // Boost de diversidad: posts con pocos votos pero recientes
        var diversityBoost = 0;
        if (net < 5 && ageH < 12) diversityBoost = 8;

        // Bonus por formato multimedia (más atractivo para nuevos)
        var fmt = ContentAnalyzer.detectFormat(note);
        var formatBonus = 0;
        if (fmt === 'video') formatBonus = 5;
        else if (fmt === 'gallery' || fmt === 'image') formatBonus = 3;

        return recency + popularity + diversityBoost + formatBonus;
      } catch (_) { return 0; }
    }

    // Boost de exposición para posts nuevos (independiente del usuario).
    function newPostBoost(note) {
      try {
        var ageH = _hoursAgo(Number(note.timestamp || 0));
        if (ageH > 24) return 0;
        // Decaimiento lineal: máximo boost al publicar, 0 a las 24h
        var factor = 1 - (ageH / 24);
        return TRENDING_CONFIG.freshPostBoost * factor * 0.5;
      } catch (_) { return 0; }
    }

    return {
      isColdStartUser: isColdStartUser,
      coldStartScore: coldStartScore,
      newPostBoost: newPostBoost
    };
  })();

  /* ================================================================
   * 8. RankingModel — modelo de ranking multi-componente
   *
   * Combina múltiples señales en un puntaje final:
   *   - Recencia (frescura temporal)
   *   - Popularidad global
   *   - Afinidad personal (perfil V2)
   *   - Afinidad de sesión
   *   - Trending / velocidad
   *   - Calidad del contenido
   *   - Social (following)
   *   - Novedad (posts no vistos)
   *   - Exploración (anti-burbuja)
   *   - Diversidad (penaliza repetición)
   *   - Feedback negativo
   * ================================================================ */

  var RankingModel = (function () {

    // Calcula el score completo de un post.
    function scorePost(note, ctx) {
      ctx = ctx || {};
      var profile = ctx.profile || ProfileStore.get();
      var followingMap = ctx.followingMap || {};
      var feedMode = ctx.feedMode || 'foryou';
      var windowState = ctx.windowState || []; // posts ya colocados en el feed

      var now = _now();
      var ts = Number(note.timestamp || 0);
      var ageH = ts > 0 ? _hoursAgo(ts) : 72;

      var components = {};

      // 1. Recencia: decaimiento exponencial.
      //    Vida media de 26 horas (como el sistema anterior).
      components.recency = 100 * Math.exp(-ageH / 26);

      // 2. Popularidad global.
      var net = Math.max(0, Number(note.upvotes || 0) - Number(note.downvotes || 0));
      var comments = Number(note.commentsCount || 0);
      var ecos = Number(note.ecoCount || 0);
      components.popularity = 14 * _safeLog(1 + net) + 5 * _safeLog(1 + comments) + 3 * _safeLog(1 + ecos);

      // 3. Afinidad personal (perfil V2).
      components.personal = 0;
      if (profile) {
        var noteFlair = note.flair || null;
        var noteAuthor = note.authorId || note.userId || null;
        var noteText = note.content || note.text || '';

        // Flair affinity
        var f = noteFlair ? (Number(profile.flairs[noteFlair]) || 0) : 0;
        // Author affinity
        var a = noteAuthor ? (Number(profile.authors[noteAuthor]) || 0) : 0;

        // Keyword affinity
        var kw = 0, n = 0;
        var words = ContentAnalyzer.extractKeywords(noteText);
        for (var i = 0; i < words.length && n < 4; i++) {
          var v = Number(profile.keywords[words[i]]) || 0;
          if (v) { kw += v; n++; }
        }

        // Topic vector similarity
        var topicSim = 0;
        try {
          var tv = ContentAnalyzer.extractTopicVector(noteText);
          var tvHash = _hash(JSON.stringify(Object.keys(tv).sort()));
          topicSim = Number(profile.topics[String(tvHash)]) || 0;
        } catch (_) {}

        // Format preference
        var fmt = ContentAnalyzer.detectFormat(note);
        var fmtPref = Number(profile.formats[fmt]) || 0;

        components.personal =
          3.5 * _sat(f) +        // flair
          5.0 * _sat(a) +        // author
          1.8 * _sat(kw) +       // keywords
          2.0 * _sat(topicSim) + // topic similarity
          1.2 * _sat(fmtPref);   // format preference

        // Exploración: impulso a lo totalmente nuevo (anti-burbuja).
        if (!a && !f) {
          var day = new Date(now).toDateString();
          if (_hash(String(note.id || '') + '|' + day) % 100 < 18) {
            components.exploration = 5;
          }
        }

        // Feedback negativo
        var negAuthor = noteAuthor ? (Number(profile.negativeAuthors[noteAuthor]) || 0) : 0;
        var negKw = 0;
        for (var j = 0; j < words.length; j++) {
          var nv = Number(profile.negativeKeywords[words[j]]) || 0;
          if (nv) negKw += nv;
        }
        if (negAuthor || negKw) {
          components.negative = -_sat(negAuthor + negKw) * 2;
        }
      }

      // 4. Afinidad de sesión.
      components.session = SessionModel.sessionAffinity(note);

      // 5. Trending / velocidad.
      components.trend = TrendingModel.trendingScore(note);

      // 6. Calidad del contenido.
      components.quality = ContentAnalyzer.contentQuality(note);

      // 7. Social boost (following).
      components.social = 0;
      if (noteAuthor && followingMap[noteAuthor]) {
        components.social = 8;
      }

      // 8. Novedad: posts que el usuario no ha visto.
      components.novelty = 0;
      if (profile && profile.interactedPosts && profile.interactedPosts[note.id]) {
        components.novelty = -3; // ya lo vio: penalizar ligeramente
      } else {
        components.novelty = 2; // post nuevo para el usuario: boost pequeño
      }

      // 9. Cold start boost para posts nuevos.
      components.coldStart = ColdStartModel.newPostBoost(note);

      // 10. Diversidad: penaliza repetición en el feed actual.
      components.diversity = _diversityPenalty(note, windowState);

      // Score final: suma ponderada de componentes.
      var total = 0;
      total += components.recency * RANKING_WEIGHTS.recency;
      total += components.popularity * RANKING_WEIGHTS.popularity;
      total += components.personal * RANKING_WEIGHTS.personal;
      total += components.session * RANKING_WEIGHTS.session;
      total += components.trend * RANKING_WEIGHTS.trend;
      total += components.quality * RANKING_WEIGHTS.quality;
      total += components.social * RANKING_WEIGHTS.social;
      total += components.novelty * RANKING_WEIGHTS.novelty;
      total += (components.exploration || 0) * RANKING_WEIGHTS.exploration;
      total += (components.negative || 0) * RANKING_WEIGHTS.negative;
      total += components.coldStart;
      total += components.diversity * RANKING_WEIGHTS.diversity;

      // Cold start user: usar coldStartScore como override parcial.
      if (ColdStartModel.isColdStartUser(profile)) {
        var cs = ColdStartModel.coldStartScore(note);
        // Mezclar 60% cold start + 40% ranking normal
        total = 0.6 * cs + 0.4 * total;
      }

      return {
        total: total,
        components: components
      };
    }

    // Calcula la penalización por diversidad.
    function _diversityPenalty(note, windowState) {
      try {
        if (!windowState || !windowState.length) return 0;
        var penalty = 0;
        var noteAuthor = note.authorId || note.userId || '';
        var noteFlair = note.flair || '';
        var noteFormat = ContentAnalyzer.detectFormat(note);

        // Ventana deslizante de los últimos N posts colocados.
        var recent = windowState.slice(-DIVERSITY_CONFIG.windowSize);

        // Contar repeticiones en la ventana.
        var sameAuthor = 0, sameFlair = 0, sameFormat = 0;
        recent.forEach(function (w) {
          if (w.authorId === noteAuthor && noteAuthor) sameAuthor++;
          if (w.flair === noteFlair && noteFlair) sameFlair++;
          if (w.format === noteFormat) sameFormat++;
        });

        // Penalizar exceder los límites.
        if (sameAuthor > DIVERSITY_CONFIG.maxInWindow.sameAuthor) {
          penalty += (sameAuthor - DIVERSITY_CONFIG.maxInWindow.sameAuthor) * DIVERSITY_CONFIG.penaltyPerRepeat;
        }
        if (sameFlair > DIVERSITY_CONFIG.maxInWindow.sameFlair) {
          penalty += (sameFlair - DIVERSITY_CONFIG.maxInWindow.sameFlair) * DIVERSITY_CONFIG.penaltyPerRepeat * 0.7;
        }
        if (sameFormat > DIVERSITY_CONFIG.maxInWindow.sameFormat) {
          penalty += (sameFormat - DIVERSITY_CONFIG.maxInWindow.sameFormat) * DIVERSITY_CONFIG.penaltyPerRepeat * 0.5;
        }

        return -penalty;
      } catch (_) { return 0; }
    }

    return {
      scorePost: scorePost
    };
  })();

  /* ================================================================
   * 9. DiversityMixer — mezcla el feed final con diversidad
   *
   * Estrategia: 70% explotación (mejor score personal), 20% exploración
   * (posts de autores/temas nuevos), 10% trending (posts con alta
   * velocidad de interacciones).
   * ================================================================ */

  var DiversityMixer = (function () {

    // Mezcla el feed ordenado con diversidad.
    function mixFeed(scoredPosts, ctx) {
      try {
        if (!scoredPosts || !scoredPosts.length) return [];

        var profile = ctx.profile || ProfileStore.get();
        var feedMode = ctx.feedMode || 'foryou';

        // Separar en buckets.
        var buckets = {
          personal: [],   // alta afinidad personal
          trending: [],   // alta velocidad
          fresh: [],       // posts nuevos (24h)
          following: [],   // de gente que sigues
          explore: []      // autores/temas nuevos
        };

        var followingMap = ctx.followingMap || {};

        scoredPosts.forEach(function (sp) {
          var note = sp.note;
          var score = sp.score;
          var components = sp.components || {};

          var noteAuthor = note.authorId || note.userId || '';
          var isFollowing = noteAuthor && followingMap[noteAuthor];

          // Trending: alta velocidad o viral.
          if (components.trend && components.trend > 8) {
            buckets.trending.push(sp);
          }

          // Fresh: menos de 24h.
          if (TrendingModel.isFresh(note)) {
            buckets.fresh.push(sp);
          }

          // Following.
          if (isFollowing) {
            buckets.following.push(sp);
          }

          // Personal: alta afinidad personal o de sesión.
          if ((components.personal && components.personal > 5) ||
              (components.session && components.session > 3)) {
            buckets.personal.push(sp);
          }

          // Explore: sin afinidad personal pero con popularidad.
          if ((!components.personal || components.personal < 3) && score.total > 20) {
            buckets.explore.push(sp);
          } else if (!isFollowing && (!components.personal || components.personal < 2)) {
            buckets.explore.push(sp);
          }
        });

        // Cada bucket se ordena por score descendente.
        for (var k in buckets) {
          buckets[k].sort(function (a, b) { return b.score.total - a.score.total; });
        }

        // Si no hay enough en un bucket, rellenar con el resto.
        var allSorted = scoredPosts.slice().sort(function (a, b) { return b.score.total - a.score.total; });
        var used = {}; // noteId -> true
        var result = [];
        var windowState = [];

        // Función para añadir un post al resultado.
        var _addPost = function (sp) {
          if (!sp || !sp.note || used[sp.note.id]) return false;
          // Verificar diversidad.
          var penalty = RankingModel.scorePost(sp.note, {
            profile: profile,
            followingMap: followingMap,
            feedMode: feedMode,
            windowState: windowState
          });
          // Si la penalización de diversidad es muy alta, skip.
          if (penalty.components.diversity < -15) return false;

          used[sp.note.id] = true;
          result.push(sp.note);
          windowState.push({
            authorId: sp.note.authorId || sp.note.userId || '',
            flair: sp.note.flair || '',
            format: ContentAnalyzer.detectFormat(sp.note)
          });
          return true;
        };

        // Ratios del mezclador.
        var total = scoredPosts.length;
        var personalTarget = Math.ceil(total * DIVERSITY_CONFIG.exploitRatio);
        var exploreTarget = Math.ceil(total * DIVERSITY_CONFIG.exploreRatio);
        var trendingTarget = Math.ceil(total * DIVERSITY_CONFIG.trendingRatio);
        var freshTarget = Math.floor(total * 0.10);
        var followingTarget = Math.floor(total * 0.10);

        // Índices de cada bucket.
        var idx = { personal: 0, trending: 0, fresh: 0, following: 0, explore: 0 };

        // Función para tomar el siguiente de un bucket.
        var _takeFrom = function (bucket, target) {
          var added = 0;
          while (added < target && idx[bucket] < buckets[bucket].length) {
            if (_addPost(buckets[bucket][idx[bucket]++])) added++;
          }
          return added;
        };

        // Mezcla intercalada: cada "ronda" toma de cada bucket.
        var rounds = Math.ceil(total / 5);
        for (var r = 0; r < rounds && result.length < total; r++) {
          // 2 personal, 1 explore, 1 trending, 1 fresh/following
          _takeFrom('personal', 2);
          _takeFrom('explore', 1);
          _takeFrom('trending', 1);

          // Alternar fresh y following cada ronda.
          if (r % 2 === 0) _takeFrom('fresh', 1);
          else _takeFrom('following', 1);
        }

        // Rellenar con lo que quede — forzar inclusión de todos los posts restantes
        // sin importar la penalización de diversidad (un ranking no debe perder candidatos).
        allSorted.forEach(function (sp) {
          if (result.length >= total) return;
          if (used[sp.note.id]) return;
          used[sp.note.id] = true;
          result.push(sp.note);
          windowState.push({
            authorId: sp.note.authorId || sp.note.userId || '',
            flair: sp.note.flair || '',
            format: ContentAnalyzer.detectFormat(sp.note)
          });
        });

        return result;
      } catch (_) {
        return scoredPosts.map(function (sp) { return sp.note; });
      }
    }

    return {
      mixFeed: mixFeed
    };
  })();

  /* ================================================================
   * 10. BanditExplorer — multi-armed bandit para exploración/explotación
   *
   * Mantiene un peso por bucket (personal, trending, fresh, following,
   * explore) que se ajusta según la recompensa observada.
   * ================================================================ */

  var BanditExplorer = (function () {
    var _state = null; // { bucket: { pulls, totalReward } }
    var _uid = null;

    function _initState() {
      var s = {};
      BANDIT_CONFIG.buckets.forEach(function (b) {
        s[b] = { pulls: 0, totalReward: 0, weight: BANDIT_CONFIG.initialWeights[b] || 0.1 };
      });
      return s;
    }

    function _load() {
      try {
        var uid = ProfileStore.get() ? null : null; // ya cargado
        // Cargar desde el perfil si existe.
        var p = ProfileStore.get();
        if (p && p.bandit && typeof p.bandit === 'object') {
          _state = _initState();
          for (var k in p.bandit) {
            if (_state[k]) {
              _state[k].pulls = p.bandit[k].pulls || 0;
              _state[k].totalReward = p.bandit[k].totalReward || 0;
            }
          }
          _normalizeWeights();
          return;
        }
        _state = _initState();
      } catch (_) {
        _state = _initState();
      }
    }

    function _normalizeWeights() {
      try {
        var total = 0;
        for (var k in _state) total += _state[k].weight;
        if (total === 0) {
          // Reset a valores iniciales.
          for (var kk in _state) _state[kk].weight = BANDIT_CONFIG.initialWeights[kk] || 0.1;
          return;
        }
        // Asegurar pesos mínimos.
        for (var k3 in _state) {
          _state[k3].weight = Math.max(BANDIT_CONFIG.minWeight, _state[k3].weight / total);
        }
        // Re-normalizar.
        var t2 = 0;
        for (var k4 in _state) t2 += _state[k4].weight;
        for (var k5 in _state) _state[k5].weight = _clamp(_state[k5].weight / t2, BANDIT_CONFIG.minWeight, BANDIT_CONFIG.maxWeight);
      } catch (_) {}
    }

    // Registra una recompensa para un bucket.
    function recordReward(bucket, reward) {
      try {
        if (!_state) _load();
        if (!_state[bucket]) return;
        _state[bucket].pulls++;
        _state[bucket].totalReward += reward;

        // Actualizar peso: recompensa promedio ajustada por learning rate.
        var avg = _state[bucket].pulls > 0 ? _state[bucket].totalReward / _state[bucket].pulls : 0;
        var oldWeight = _state[bucket].weight;
        _state[bucket].weight = oldWeight + BANDIT_CONFIG.learningRate * (reward - avg);
        _state[bucket].weight = _clamp(_state[bucket].weight, BANDIT_CONFIG.minWeight, BANDIT_CONFIG.maxWeight);

        _normalizeWeights();

        // Persistir en el perfil.
        var p = ProfileStore.get();
        if (p) {
          p.bandit = {};
          for (var k in _state) {
            p.bandit[k] = { pulls: _state[k].pulls, totalReward: _state[k].totalReward };
          }
          ProfileStore.scheduleSave();
        }
      } catch (_) {}
    }

    // Obtiene los pesos actuales del bandit.
    function getWeights() {
      if (!_state) _load();
      var w = {};
      for (var k in _state) w[k] = _state[k].weight;
      return w;
    }

    // Selecciona un bucket según los pesos (ruleta).
    function selectBucket() {
      if (!_state) _load();
      var total = 0;
      for (var k in _state) total += _state[k].weight;
      if (total === 0) return 'personal';
      var r = Math.random() * total;
      var acc = 0;
      for (var k2 in _state) {
        acc += _state[k2].weight;
        if (r <= acc) return k2;
      }
      return 'personal';
    }

    function reset() { _state = _initState(); }

    return {
      recordReward: recordReward,
      getWeights: getWeights,
      selectBucket: selectBucket,
      reset: reset
    };
  })();

  /* ================================================================
   * 11. SocialGraph — análisis del grafo social
   *
   * Calcula señales basadas en la red social del usuario:
     - Author authority (cuánta gente lo sigue)
     - Mutual following boost
     - Social distance
   * ================================================================ */

  var SocialGraph = (function () {

    // Author authority: followers count como proxy de authority.
    function authorAuthority(note, followingMap) {
      try {
        var fc = Number(note.authorFollowersCount || 0);
        var isVerified = note.authorVerified || false;
        var score = _safeLog(fc) * 2;
        if (isVerified) score += 3;
        return Math.min(score, 20);
      } catch (_) { return 0; }
    }

    // Social boost: post de alguien que sigues.
    function socialBoost(note, followingMap) {
      try {
        var authorId = note.authorId || note.userId || '';
        if (!authorId || !followingMap) return 0;
        if (followingMap[authorId]) {
          // Following: boost fuerte.
          var followedAt = followingMap[authorId].followedAt || 0;
          var days = _daysAgo(followedAt);
          // Boost más fuerte para follows recientes.
          var recencyBoost = Math.exp(-days / 30) * 5;
          return 8 + recencyBoost;
        }
        return 0;
      } catch (_) { return 0; }
    }

    return {
      authorAuthority: authorAuthority,
      socialBoost: socialBoost
    };
  })();

  /* ================================================================
   * 12. QualitySignals — señales de calidad del contenido
   *
   * Mide la calidad de la interacción: ratio de comentarios/votos,
     profundidad de comentarios, ratio de shares.
   * ================================================================ */

  var QualitySignals = (function () {

    // Ratio de engagement: (comentarios + ecos) / (votos + 1).
    function engagementRatio(note) {
      try {
        var upvotes = Number(note.upvotes || 0);
        var downvotes = Number(note.downvotes || 0);
        var comments = Number(note.commentsCount || 0);
        var ecos = Number(note.ecoCount || 0);
        var totalVotes = upvotes + downvotes;
        var totalEng = comments + ecos;
        if (totalVotes === 0) return _sat01(totalEng);
        return _sat01(totalEng / (totalVotes + 1));
      } catch (_) { return 0; }
    }

    // Score de controversia: posts con votos up y down balanceados.
    function controversyScore(note) {
      try {
        var up = Number(note.upvotes || 0);
        var down = Number(note.downvotes || 0);
        if (up + down < 3) return 0;
        var balance = Math.min(up, down) / Math.max(up, down);
        var magnitude = _safeLog(up + down);
        return balance * magnitude * 2;
      } catch (_) { return 0; }
    }

    // Score de calidad total.
    function qualityScore(note) {
      try {
        var content = ContentAnalyzer.contentQuality(note);
        var eng = engagementRatio(note);
        var cont = controversyScore(note);
        // Controversia es buena señal: genera discusión.
        return content * 0.4 + eng * 8 + cont * 0.3;
      } catch (_) { return 0; }
    }

    return {
      engagementRatio: engagementRatio,
      controversyScore: controversyScore,
      qualityScore: qualityScore
    };
  })();

  /* ================================================================
   * 13. Explainability — desglose del score para depuración
   * ================================================================ */

  var Explainability = (function () {
    function explainPost(note, ctx) {
      try {
        var result = RankingModel.scorePost(note, ctx);
        var comps = result.components;
        var lines = [];
        var order = ['recency', 'popularity', 'personal', 'session', 'trend',
                      'quality', 'social', 'novelty', 'exploration', 'negative',
                      'coldStart', 'diversity'];
        order.forEach(function (k) {
          if (comps[k] !== undefined && comps[k] !== 0) {
            var weight = RANKING_WEIGHTS[k] !== undefined ? RANKING_WEIGHTS[k] : 1;
            var weighted = comps[k] * weight;
            lines.push(k + ': ' + comps[k].toFixed(1) + ' × ' + weight.toFixed(1) + ' = ' + weighted.toFixed(1));
          }
        });
        return {
          total: result.total,
          breakdown: lines,
          components: comps
        };
      } catch (_) {
        return { total: 0, breakdown: [], components: {} };
      }
    }

    return { explainPost: explainPost };
  })();

  /* ================================================================
   * 14. DrexRecEngine — API pública del motor
   * ================================================================ */

  var Engine = {
    version: ENGINE_VERSION,
    ContentAnalyzer: ContentAnalyzer,
    ProfileStore: ProfileStore,
    SignalTracker: SignalTracker,
    SessionModel: SessionModel,
    TrendingModel: TrendingModel,
    ColdStartModel: ColdStartModel,
    RankingModel: RankingModel,
    DiversityMixer: DiversityMixer,
    BanditExplorer: BanditExplorer,
    SocialGraph: SocialGraph,
    QualitySignals: QualitySignals,
    Explainability: Explainability,
    SIGNAL_WEIGHTS: SIGNAL_WEIGHTS,
    RANKING_WEIGHTS: RANKING_WEIGHTS,
    DIVERSITY_CONFIG: DIVERSITY_CONFIG,
    TRENDING_CONFIG: TRENDING_CONFIG,

    // Inicializa el motor (carga el perfil).
    init: function () {
      try {
        return ProfileStore.load().then(function () {
          BanditExplorer.getWeights(); // inicializa bandit
          // Guardar al salir/ocultar.
          try {
            document.addEventListener('visibilitychange', function () {
              if (document.visibilityState === 'hidden') ProfileStore.flush();
            });
            window.addEventListener('pagehide', function () { ProfileStore.flush(); });
          } catch (_) {}
          return true;
        }).catch(function () { return false; });
      } catch (_) { return Promise.resolve(false); }
    },

    // Carga el perfil del usuario.
    loadProfile: function () { return ProfileStore.load(); },

    // Entrena con una interacción manual.
    train: function (meta, weight) {
      SignalTracker.train(meta, weight);
      SessionModel.record(meta, weight);
    },

    // Entrena por ID de post.
    trainById: function (noteId, weight) {
      SignalTracker.trainById(noteId, weight);
      // También registrar en sesión.
      try {
        var meta = null;
        if (typeof global._drexNoteMeta !== 'undefined' && global._drexNoteMeta[noteId]) {
          meta = global._drexNoteMeta[noteId];
        }
        if (meta) {
          SessionModel.record({
            flair: meta.flair || null,
            authorId: meta.authorId || null,
            text: meta.text || ''
          }, weight);
        }
      } catch (_) {}
    },

    // Entrena al seguir a un autor.
    trainFollow: function (authorId) {
      SignalTracker.trainFollow(authorId);
    },

    // Observa una tarjeta para tracking de vistas.
    observeCard: function (el) {
      SignalTracker.observeCard(el);
    },

    // Score de un post.
    scorePost: function (note, ctx) {
      var result = RankingModel.scorePost(note, ctx || {});
      return result.total;
    },

    // Explica el score de un post.
    explainPost: function (note, ctx) {
      return Explainability.explainPost(note, ctx);
    },

    // Rankea una lista de posts.
    rankFeed: function (posts, ctx) {
      try {
        ctx = ctx || {};
        var profile = ctx.profile || ProfileStore.get();
        if (!profile) {
          // Perfil no cargado: usar cold start.
          ctx.profile = ColdStartModel; // señal para RankingModel
        }

        // Scorear cada post.
        var scored = posts.filter(function (n) { return n && n.id; }).map(function (note) {
          var score = RankingModel.scorePost(note, ctx);
          return { note: note, score: score, components: score.components };
        });

        // Ordenar por score descendente.
        scored.sort(function (a, b) { return b.score.total - a.score.total; });

        // Mezclar con diversidad.
        var mixed = DiversityMixer.mixFeed(scored, ctx);

        return mixed;
      } catch (_) {
        return posts;
      }
    },

    // Inserta un post en el feed ordenado por score (para streaming en vivo).
    insertByScore: function (feedContainer, noteElement, note, ctx) {
      try {
        ctx = ctx || {};
        var score = RankingModel.scorePost(note, ctx);
        noteElement.dataset.recScore = String(score.total);
        var author = note.authorId || '';
        noteElement.dataset.recAuthor = author;
        noteElement.dataset.recFormat = ContentAnalyzer.detectFormat(note);

        var kids = feedContainer.querySelectorAll(':scope > div[id^="post-"]');
        for (var i = 0; i < kids.length; i++) {
          var kid = kids[i];
          if (score.total > parseFloat(kid.dataset.recScore || '0')) {
            // Diversidad: no más de 2 seguidos del mismo autor.
            if (author) {
              var same = 0;
              var sib = kid.previousElementSibling;
              while (sib && same < 2) {
                if (sib.matches && sib.matches('div[id^="post-"]')) {
                  if (sib.dataset.recAuthor === author) same++; else break;
                }
                sib = sib.previousElementSibling;
              }
              if (same >= 2) continue;
            }
            feedContainer.insertBefore(noteElement, kid);
            return;
          }
        }
        // Colocar al final.
        var sentinel = feedContainer.querySelector('#feed-older-sentinel');
        if (sentinel) feedContainer.insertBefore(noteElement, sentinel);
        else feedContainer.appendChild(noteElement);
      } catch (_) {
        try {
          var s = feedContainer.querySelector('#feed-older-sentinel');
          if (s) feedContainer.insertBefore(noteElement, s);
          else feedContainer.appendChild(noteElement);
        } catch (_) {}
      }
    },

    // Reordena el feed "Para ti" cuando el perfil llega tarde.
    resortForYou: function (feedContainer, ctx) {
      try {
        if (!feedContainer || feedContainer.dataset.feedMode !== 'foryou') return;
        var sentinel = feedContainer.querySelector('#feed-older-sentinel');
        var kids = Array.from(feedContainer.querySelectorAll(':scope > div[id^="post-"]'));
        if (!kids.length) return;

        // Recalcular scores.
        var windowState = [];
        kids.forEach(function (el) {
          var meta = (typeof global._drexNoteMeta !== 'undefined' && global._drexNoteMeta[el.dataset.noteId]) || {};
          var note = {
            id: el.dataset.noteId,
            timestamp: meta.ts,
            upvotes: meta.up,
            downvotes: meta.down,
            commentsCount: meta.cc,
            flair: meta.flair,
            authorId: meta.authorId,
            content: meta.text,
            text: meta.text
          };
          var score = RankingModel.scorePost(note, ctx || {});
          el.dataset.recScore = String(score.total);
          windowState.push({
            authorId: meta.authorId || '',
            flair: meta.flair || '',
            format: ContentAnalyzer.detectFormat(note)
          });
        });

        // Mover cada tarjeta junto con su bloque de anuncio.
        var groups = kids.map(function (el) {
          var g = [el];
          var sib = el.nextElementSibling;
          while (sib && sib.classList && sib.classList.contains('drex-ad-slot')) { g.push(sib); sib = sib.nextElementSibling; }
          return g;
        });
        groups.sort(function (ga, gb) {
          return parseFloat(gb[0].dataset.recScore || '0') - parseFloat(ga[0].dataset.recScore || '0');
        });
        groups.forEach(function (g) {
          g.forEach(function (el) { feedContainer.insertBefore(el, sentinel); });
        });
      } catch (_) {}
    },

    // Registra una recompensa en el bandit.
    recordBanditReward: function (bucket, reward) {
      BanditExplorer.recordReward(bucket, reward);
    },

    // Flush del perfil.
    flush: function () { ProfileStore.flush(); },

    // Reset del motor.
    reset: function () {
      ProfileStore.reset();
      SessionModel.reset();
      BanditExplorer.reset();
      SignalTracker.cleanup();
    }
  };

  // Exportar al scope global.
  global.DrexRecEngine = Engine;

  /* ================================================================
   * 15. Compatibilidad V1 — puentear funciones antiguas
   *
   * Las funciones globales drexRecScore, drexRecTrain, drexRecProfile,
   * drexRecObserveCard, drexRecInsertForYou, drexRecResortForYou,
   * drexRecTrainById, drexRecTrainFollow se puentean al motor nuevo.
   * Esto permite que el código existente en index.html siga funcionando
   * sin cambios.
   * ================================================================ */

  // Guardar referencias a las funciones V1 originales (por si el motor falla).
  var _v1 = {
    drexRecScore: (typeof global.drexRecScore === 'function') ? global.drexRecScore : null,
    drexRecTrain: (typeof global.drexRecTrain === 'function') ? global.drexRecTrain : null,
    drexRecProfile: (typeof global.drexRecProfile === 'function') ? global.drexRecProfile : null,
    drexRecObserveCard: (typeof global.drexRecObserveCard === 'function') ? global.drexRecObserveCard : null,
    drexRecInsertForYou: (typeof global.drexRecInsertForYou === 'function') ? global.drexRecInsertForYou : null,
    drexRecResortForYou: (typeof global.drexRecResortForYou === 'function') ? global.drexRecResortForYou : null,
    drexRecTrainById: (typeof global.drexRecTrainById === 'function') ? global.drexRecTrainById : null,
    drexRecTrainFollow: (typeof global.drexRecTrainFollow === 'function') ? global.drexRecTrainFollow : null
  };

  // Puentear drexRecScore al motor V2.
  global.drexRecScore = function (note) {
    if (global.DrexRecEngine) {
      var ctx = {};
      var p = ProfileStore.get();
      if (p) ctx.profile = p;
      return global.DrexRecEngine.scorePost(note, ctx);
    }
    return _v1.drexRecScore ? _v1.drexRecScore(note) : 0;
  };

  // Puentear drexRecTrain.
  global.drexRecTrain = function (meta, weight) {
    if (global.DrexRecEngine) { global.DrexRecEngine.train(meta, weight); return; }
    if (_v1.drexRecTrain) _v1.drexRecTrain(meta, weight);
  };

  // Puentear drexRecProfile.
  global.drexRecProfile = function () {
    if (global.DrexRecEngine) return ProfileStore.load();
    return _v1.drexRecProfile ? _v1.drexRecProfile() : Promise.resolve(null);
  };

  // Puentear drexRecObserveCard.
  global.drexRecObserveCard = function (el) {
    if (global.DrexRecEngine) { global.DrexRecEngine.observeCard(el); return; }
    if (_v1.drexRecObserveCard) _v1.drexRecObserveCard(el);
  };

  // Puentear drexRecInsertForYou.
  global.drexRecInsertForYou = function (feedContainer, noteElement, note) {
    if (global.DrexRecEngine) {
      var ctx = {};
      var p = ProfileStore.get();
      if (p) ctx.profile = p;
      global.DrexRecEngine.insertByScore(feedContainer, noteElement, note, ctx);
      return;
    }
    if (_v1.drexRecInsertForYou) _v1.drexRecInsertForYou(feedContainer, noteElement, note);
    else {
      var s = feedContainer.querySelector('#feed-older-sentinel');
      if (s) feedContainer.insertBefore(noteElement, s);
      else feedContainer.appendChild(noteElement);
    }
  };

  // Puentear drexRecResortForYou.
  global.drexRecResortForYou = function () {
    if (global.DrexRecEngine) {
      var feedContainer = document.getElementById('notes-feed');
      var ctx = {};
      var p = ProfileStore.get();
      if (p) ctx.profile = p;
      global.DrexRecEngine.resortForYou(feedContainer, ctx);
      return;
    }
    if (_v1.drexRecResortForYou) _v1.drexRecResortForYou();
  };

  // Puentear drexRecTrainById.
  global.drexRecTrainById = function (noteId, weight) {
    if (global.DrexRecEngine) { global.DrexRecEngine.trainById(noteId, weight); return; }
    if (_v1.drexRecTrainById) _v1.drexRecTrainById(noteId, weight);
  };

  // Puentear drexRecTrainFollow.
  global.drexRecTrainFollow = function (authorId) {
    if (global.DrexRecEngine) { global.DrexRecEngine.trainFollow(authorId); return; }
    if (_v1.drexRecTrainFollow) _v1.drexRecTrainFollow(authorId);
  };

  // Puentear DREX_REC para compatibilidad de código que usa sus constantes.
  if (typeof global.DREX_REC === 'undefined') {
    global.DREX_REC = {
      profilePath: PROFILE_PATH_V2,
      decayHalfLifeDays: DECAY_HALF_LIFE.flairs,
      viewMs: 1000,
      deepViewMs: 8000,
      maxAuthors: MAX_AUTHORS,
      maxKeywords: MAX_KEYWORDS,
      weights: SIGNAL_WEIGHTS
    };
  } else {
    // Actualizar DREX_REC existente para usar V2.
    global.DREX_REC.profilePath = PROFILE_PATH_V2;
    global.DREX_REC.weights = SIGNAL_WEIGHTS;
  }

  // Auto-inicializar cuando el DOM esté listo.
  try {
    var _initDone = false;
    var _doInit = function () {
      if (_initDone) return;
      _initDone = true;
      if (global.DrexCloud && global.DrexCloud.auth) {
        Engine.init().catch(function () {});
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _doInit);
    } else {
      _doInit();
    }
  } catch (_) {}

})(typeof window !== 'undefined' ? window : this);
