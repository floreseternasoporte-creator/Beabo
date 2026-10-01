/* ================================================================
 * Tests Drex C228 — rediseño del feed (carril 3, 2026-10-01)
 * Ejecutar con: node tests/test-c228-feed-redesign.js
 * Sin dependencias externas — solo Node.js.
 *
 * Verifica:
 *  A. Las anclas verbatim de patch.html existen byte-exactas en
 *     index.html (el patch aplica limpio).
 *  B. Los fragmentos NUEVOS conservan todos los hooks que lee el
 *     algoritmo de ranking y el resto del JS.
 *  C. El CSS/JS/i18n nuevos contienen lo comprometido.
 *  D. Regresión: el ranking (drexRecScore/drexRecResortForYou) y los
 *     lectores de estado de tarjeta siguen intactos en index.html.
 *  E. Lógica DOM del doble toque (stubs): simple->visor, doble->voto,
 *     voto activo->no alterna, touch->preventDefault.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var LANE = path.join(__dirname, '..');
var BEABO = '/home/hatch/workspace/beabo';
var src = fs.readFileSync(path.join(BEABO, 'index.html'), 'utf8');
var i18nSrc = fs.readFileSync(path.join(BEABO, 'drex-i18n.js'), 'utf8');
var css = fs.readFileSync(path.join(LANE, 'feed-redesign.css'), 'utf8');
var js = fs.readFileSync(path.join(LANE, 'feed-redesign.js'), 'utf8');
var i18nNew = fs.readFileSync(path.join(LANE, 'feed-redesign-i18n.js'), 'utf8');
var newHeader = fs.readFileSync(path.join(LANE, 'fragments/new-header.html'), 'utf8');
var newActions = fs.readFileSync(path.join(LANE, 'fragments/new-actions.html'), 'utf8');
var newEmpty = fs.readFileSync(path.join(LANE, 'fragments/new-empty.js'), 'utf8');
var newToggle = fs.readFileSync(path.join(LANE, 'fragments/new-toggle.js'), 'utf8');

var passed = 0, failed = 0, failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; failures.push(name + ': ' + e.message); console.log('FALLO - ' + name + ': ' + e.message); }
}
function mustContain(hay, needle, label) {
  assert(hay.indexOf(needle) !== -1, (label || 'fragmento') + ' no encontrado');
}

/* ---------- A. anclas verbatim ---------- */
var anchors = {
  'old-header.txt': 'F1 encabezado',
  'old-actions.txt': 'F2 acciones',
  'old-enhance.txt': 'F3 hook _enhancePostCard',
  'old-empty.txt': 'F4 snfFeedEmptyHTML',
  'old-toggle.txt': 'F5 toggleNoteContentExpand',
  'old-vermas-btn.txt': 'F6 botón Ver más',
  'old-video-wrap.txt': 'F7 wrapper video',
  'old-follow-aria.txt': 'F8 aria seguir'
};
Object.keys(anchors).forEach(function (f) {
  test('ancla verbatim ' + anchors[f] + ' existe en index.html', function () {
    var a = fs.readFileSync(path.join(LANE, 'anchors', f), 'utf8');
    assert(a.length > 20, 'ancla vacía');
    mustContain(src, a, 'ancla ' + f);
  });
});
test('ancla CSS (old-css.txt) existe en index.html', function () {
  mustContain(src, fs.readFileSync(path.join(LANE, 'anchors/old-css.txt'), 'utf8'), 'ancla CSS');
});
test('cola de drex-i18n.js (old-i18n-tail.txt) coincide', function () {
  mustContain(i18nSrc, fs.readFileSync(path.join(LANE, 'anchors/old-i18n-tail.txt'), 'utf8'), 'cola i18n');
});

/* ---------- B. hooks preservados en los fragmentos nuevos ---------- */
test('nuevo header conserva hooks de identidad y algoritmo', function () {
  ['drex-post-meta', 'data-author-id="${safeAuthorId}"', 'data-author-avatar',
   'id="${authorAvatarId}"', 'drex-post-author', 'data-author-name',
   'drex-post-time', 'formatRelativeTime(safeTimestamp)',
   'renderPostFlairPill(note)', 'renderAuthorLanguageBadges(note, true)',
   'drex-collab-avatars', 'openAuthorProfile', 'drexLiveRing',
   'getQuickFollowButtonMarkup(note.authorId', 'safeAuthorVerifiedIcon'
  ].forEach(function (h) { mustContain(newHeader, h, h); });
});
test('nuevo header trae estructura propia drex-fd-*', function () {
  ['drex-fd-head', 'drex-fd-idrow', 'drex-fd-id', 'drex-fd-ava',
   'drex-fd-names', 'drex-fd-name', 'drex-fd-sub', 'drex-fd-follow'
  ].forEach(function (h) { mustContain(newHeader, h, h); });
});
test('nuevas acciones conservan ids, clases y handlers', function () {
  ['id="commentscount-${safeId}"', 'id="eco-${safeId}"', 'id="save-${safeId}"',
   'drex-action-pill', 'drex-action-icon', 'eco-btn', 'save-btn',
   'aria-pressed', "openCommentsView('${safeId}')", "toggleEco('${safeId}')",
   "openPostShareMenu('${safeId}')", "toggleSavePost('${safeId}', this)",
   'drexViewsOwnBadgeForNote(note, user)', 'hasEchoed'
  ].forEach(function (h) { mustContain(newActions, h, h); });
});
test('nuevas acciones tienen etiquetas i18n', function () {
  ["appT('Comentar')", "appT('Eco')", "appT('Compartir')", "appT('Guardar')",
   "appT('Ver comentarios')", "appT('Hacer eco de la publicación')",
   "appT('Guardar publicación')", 'drex-fd-act-label'
  ].forEach(function (h) { mustContain(newActions, h, h); });
});
test('nuevo vacío conserva clase feed-empty-state y ramas', function () {
  ['feed-empty-state', "feedMode === 'marea'", "feedMode === 'following'",
   'openOndasView()', 'drexMareaReadFollowed',
   "appT('Tu marea está vacía')", "appT('Descubrir ondas')",
   "appT('Sin posts en tus ondas todavía')",
   "appT('Aún no sigues a nadie')", "appT('Todo tranquilo por aquí')",
   "appT('Aún no hay posts. Sé la primera persona en publicar.')",
   'drex-fd-empty'
  ].forEach(function (h) { mustContain(newEmpty, h, h); });
});
test('toggle "Ver más" usa appT y clase drex-fd-open', function () {
  ["appT('Ver más')", "appT('Ver menos')", 'drex-fd-open',
   'note-expandable-content', 'note-content-preview', 'note-content-full'
  ].forEach(function (h) { mustContain(newToggle, h, h); });
});

/* ---------- C. CSS / JS / i18n nuevos ---------- */
test('CSS define el sistema drex-fd-* completo', function () {
  ['.drex-fd-head', '.drex-fd-idrow', '.drex-fd-follow .quick-follow-btn',
   '.drex-fd-actions', '.drex-fd-act', '.drex-fd-act-label',
   '.drex-fd-heart', '.drex-fd-empty', '.drex-fd-empty-wave',
   '.drex-fd-empty-cta', '.drex-fd-more', '.drex-fd-video'
  ].forEach(function (h) { mustContain(css, h, h); });
});
test('CSS respeta prefers-reduced-motion', function () {
  mustContain(css, '@media (prefers-reduced-motion: reduce)', 'media query');
  mustContain(css, '.drex-fd-heart { display: none; }', 'corazón oculto');
});
test('CSS no redefine destructivamente clases compartidas con comentarios', function () {
  // El riel solo se retoca acotado a .drex-post; las filas de comentario
  // usan las mismas clases fuera de .drex-post.
  assert(css.indexOf('.drex-vote-rail {') === -1, 'no debe redefinir .drex-vote-rail global');
  assert(css.indexOf('.drex-action-pill {') === -1, 'no debe redefinir .drex-action-pill global');
  mustContain(css, '.drex-post .drex-vote-btn', 'retoque acotado a .drex-post');
});
test('JS expone drexFdEnhanceCard y vota sin quitar voto activo', function () {
  mustContain(js, 'window.drexFdEnhanceCard = drexFdEnhanceCard', 'export');
  mustContain(js, "votePost(noteId, 'up')", 'voto positivo');
  mustContain(js, 'anyUpvoteActive(noteId)', 'chequeo de voto activo');
  mustContain(js, 'prefers-reduced-motion', 'reduced motion');
  mustContain(js, "addEventListener('click'", 'delegación click');
  mustContain(js, "addEventListener('touchend'", 'delegación touch');
  mustContain(js, '.feed-post-media img, .drex-media-grid img', 'selector de fotos');
});
test('JS es sintaxis válida', function () {
  require('child_process').execSync('node --check ' + JSON.stringify(path.join(LANE, 'feed-redesign.js')));
});
test('i18n trae las 13 claves en EN/ZH/PT', function () {
  var keys = ['"Eco":"', '"Compartir":"', '"Guardar":"', '"Guardar publicación":"',
    '"Ver comentarios":"', '"Hacer eco de la publicación":"', '"Dejar de seguir":"',
    '"Solicitud de seguimiento enviada":"', '"Seguir usuario":"',
    '"Aún no sigues a nadie":"', '"Todo tranquilo por aquí":"',
    '"Aún no hay posts. Sé la primera persona en publicar.":"',
    '"Todavía no sigues a nadie que haya publicado.'];
  ['APP_ENGLISH_TEXT', 'APP_CHINESE_TEXT', 'APP_PORTUGUESE_TEXT'].forEach(function (dict) {
    var start = i18nNew.indexOf('Object.assign(' + dict);
    assert(start !== -1, dict + ' no encontrado');
    var end = i18nNew.indexOf('});', start);
    var block = i18nNew.slice(start, end);
    keys.forEach(function (k) { mustContain(block, k, dict + ' ' + k); });
  });
});
test('i18n no colisiona con claves TEXT existentes', function () {
  var keys = ['"Eco":', '"Dejar de seguir":', '"Solicitud de seguimiento enviada":',
    '"Aún no sigues a nadie":', '"Todo tranquilo por aquí":'];
  keys.forEach(function (k) {
    assert(i18nSrc.indexOf(k) === -1, 'colisión: ' + k + ' ya existe en drex-i18n.js');
  });
});

/* ---------- D. regresión: ranking y lectores intactos ---------- */
test('drexRecScore intacto', function () {
  var start = src.indexOf('function drexRecScore(note)');
  assert(start !== -1, 'drexRecScore no encontrada');
  var body = src.slice(start, start + 900);
  mustContain(body, '100 * Math.exp(-ageH / 26)', 'recencia');
  mustContain(body, '14 * Math.log10(1 + net)', 'popularidad');
});
test('drexRecResortForYou intacto', function () {
  var start = src.indexOf('function drexRecResortForYou()');
  assert(start !== -1, 'no encontrada');
  var body = src.slice(start, start + 700);
  mustContain(body, 'if (window.DREX_FORYOU_CHRONO === true) return;', 'salida cronológica');
  mustContain(body, 'el.dataset.recScore', 'dataset.recScore');
  mustContain(body, ':scope > div[id^="post-"]', 'selector de tarjetas');
});
test('snfFeedWindowHarvestUI sigue leyendo los mismos ids', function () {
  var start = src.indexOf('function snfFeedWindowHarvestUI(cardEl, noteId)');
  assert(start !== -1, 'no encontrada');
  var body = src.slice(start, start + 800);
  ["querySelector('#upvote-' + noteId)", "querySelector('#downvote-' + noteId)",
   "querySelector('#eco-' + noteId)", "classList.contains('active')"
  ].forEach(function (h) { mustContain(body, h, h); });
});
test('hydrateSaveButtons sigue leyendo [id^="save-"]', function () {
  mustContain(src, "container.querySelectorAll('[id^=\"save-\"]')", 'selector save-');
});
test('riel de votos del template intacto (up/score/down)', function () {
  ["id=\"upvote-${safeId}\"", "id=\"score-${safeId}\"", "id=\"downvote-${safeId}\"",
   "votePost('${safeId}', 'up')", "votePost('${safeId}', 'down')",
   'drex-vote-rail', 'drex-vote-btn drex-up', 'drex-vote-btn drex-down', 'drex-vote-score'
  ].forEach(function (h) { mustContain(src, h, h); });
});
test('mosaico de fotos intacto (renderNoteImagesHtml)', function () {
  ['drex-media-grid--', 'drex-media-cell', 'drex-media-more', 'data-note-imgs',
   'feed-post-media', 'drex-media-single'
  ].forEach(function (h) { mustContain(src, h, h); });
});
test('_observeCommenters sigue usando [data-commenters-for]', function () {
  mustContain(src, 'data-commenters-for', 'hook commenters');
});

/* ---------- E. lógica DOM del doble toque (stubs: ver bloque async abajo) ---------- */

console.log('---');
console.log('A-D: ' + passed + ' ok, ' + failed + ' fallos');

/* Bloque E asíncrono */
(function runAsync() {
  var handlers = {}, voteCalls = [], relayClicks = 0, heartAppends = 0;
  var fakeImg = {
    closest: function (sel) {
      if (sel.indexOf('img') !== -1) return fakeImg;
      return { appendChild: function () { heartAppends++; } };
    },
    click: function () { relayClicks++; }
  };
  var fakeCard = {
    __drexFdWired: false, dataset: { noteId: 'post123' },
    contains: function () { return true; },
    addEventListener: function (t, fn) { handlers[t] = fn; }
  };
  var fakeDoc = {
    querySelectorAll: function () { return []; },
    createElement: function () { return { className: '', setAttribute: function () {}, innerHTML: '' }; }
  };
  var g = (typeof globalThis !== 'undefined') ? globalThis : global;
  var saveWin = g.window, saveDoc = g.document, saveCSS = g.CSS, saveVote = g.votePost;
  g.window = { matchMedia: function () { return { matches: false }; } };
  g.document = fakeDoc; g.CSS = undefined;
  g.votePost = function (id, v) { voteCalls.push([id, v]); };
  try {
    eval(js);
    var _exported = g.window.drexFdEnhanceCard;
    assert(typeof _exported === 'function', 'drexFdEnhanceCard no exportada');
    _exported(fakeCard);
  } catch (e) {
    g.window = saveWin; g.document = saveDoc; g.CSS = saveCSS; g.votePost = saveVote;
    console.log('FALLO - E: no se pudo cargar el JS: ' + e.message);
    process.exit(1);
  }
  assert(handlers.click && handlers.touchend, 'listeners no cableados');

  function tap(target) {
    var r = { pd: false, sp: false };
    handlers.click({ target: target, cancelable: true,
      preventDefault: function () { r.pd = true; }, stopPropagation: function () { r.sp = true; } });
    return r;
  }
  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  (async function () {
    // E1: toque simple -> relay tras la espera (abre el visor)
    voteCalls = []; relayClicks = 0;
    var r1 = tap(fakeImg);
    assert(r1.pd && r1.sp, 'el toque simple debe consumirse');
    await wait(340);
    assert(relayClicks === 1, 'toque simple: 1 relay esperado, hubo ' + relayClicks);
    assert(voteCalls.length === 0, 'toque simple no vota');
    console.log('ok - E1 toque simple re-dispara el click (visor)');

    // E2: doble toque -> vota up + corazón, sin relay
    voteCalls = []; relayClicks = 0; heartAppends = 0;
    tap(fakeImg); await wait(80); tap(fakeImg); await wait(340);
    assert(voteCalls.length === 1 && voteCalls[0][0] === 'post123' && voteCalls[0][1] === 'up',
      'doble toque debe votar up: ' + JSON.stringify(voteCalls));
    assert(relayClicks === 0, 'doble toque no re-dispara');
    assert(heartAppends === 1, 'doble toque muestra 1 corazón');
    console.log('ok - E2 doble toque vota up + corazón');

    // E3: voto ya activo -> no alterna
    fakeDoc.querySelectorAll = function () { return [{ classList: { contains: function () { return true; } } }]; };
    voteCalls = []; heartAppends = 0;
    tap(fakeImg); await wait(80); tap(fakeImg); await wait(340);
    assert(voteCalls.length === 0, 'con voto activo no debe votar');
    assert(heartAppends === 1, 'el corazón sí aparece');
    console.log('ok - E3 doble toque con voto activo no lo quita');

    // E4: touchend hace preventDefault
    fakeDoc.querySelectorAll = function () { return []; };
    relayClicks = 0;
    var te = { target: fakeImg, cancelable: true,
      preventDefault: function () { this._pd = true; }, stopPropagation: function () { this._sp = true; } };
    handlers.touchend(te);
    assert(te._pd && te._sp, 'touchend debe consumirse');
    await wait(340);
    assert(relayClicks === 1, 'touch simple re-dispara tras la espera');
    console.log('ok - E4 touchend consume el evento');

    // E5: click fuera de fotos no se intercepta
    var r5 = tap({ closest: function () { return null; } });
    assert(!r5.pd && !r5.sp, 'click fuera de fotos no se toca');
    console.log('ok - E5 clicks fuera de las fotos intactos');

    g.window = saveWin; g.document = saveDoc; g.CSS = saveCSS; g.votePost = saveVote;
    console.log('---');
    console.log('TOTAL: ' + (passed + 5) + ' ok, ' + failed + ' fallos');
    process.exit(failed ? 1 : 0);
  })().catch(function (e) {
    g.window = saveWin; g.document = saveDoc; g.CSS = saveCSS; g.votePost = saveVote;
    console.log('FALLO - E: ' + (e && e.message));
    process.exit(1);
  });
})();
