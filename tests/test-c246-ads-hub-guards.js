/* ================================================================
 * C246 (2026-10-03) — anuncios invisibles para miembros Orbit + hub
 * de crear sin monedas y sin overlays que bloqueen toques.
 *
 * Tres hallazgos de la QA en vivo y su contrato:
 *  1. "Gana Drex Coins" en el hub: NO existe en el build (probable
 *     service worker viejo en el teléfono). El guardia vive en
 *     test-c240-gifts-coins-removal.js.
 *  2. Cajas "ANUNCIO" visibles para un miembro Orbit verificado en el
 *     feed: BUG REAL. maybeInsertFeedAd creaba el contenedor SIEMPRE y
 *     solo se ocultaba al cargar el banner (perezoso). Fix C246:
 *     puerta en la creación (drexOrbitNoAds) + guardias en los dos
 *     caminos de revelado (drexWatchAdBody, done() de Adsterra).
 *  3. Tile "Live" del hub bloqueado por un overlay: NO reproducible en
 *     el build (no existe ese overlay dentro del hub; el editor a
 *     pantalla completa es pointer-events:none inactivo). Se fija la
 *     estructura para que no regrese.
 *
 * Ejecutar: node tests/test-c246-ads-hub-guards.js
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('ok - ' + name); }
  else { failed++; console.log('FAIL - ' + name); }
}

/* Extrae una función por nombre (brace-matching desde su firma). */
function extractFn(name) {
  const i = html.indexOf('function ' + name + '(');
  if (i === -1) return null;
  let depth = 0, j = html.indexOf('{', i);
  const start = j;
  for (; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) return html.slice(i, j + 1); }
  }
  return null;
}

/* ---------- 1. Miembro Orbit: maybeInsertFeedAd no crea ningún slot ---------- */

function runMaybeInsertFeedAd(member) {
  const src = extractFn('maybeInsertFeedAd');
  if (!src) throw new Error('maybeInsertFeedAd no encontrada');
  const frag = { appended: [], appendChild(el) { this.appended.push(el); } };
  const sandbox = {
    drexAdsBlocked: () => false,
    drexOrbitNoAds: () => member,
    monetagBannerActive: () => false,
    MONETAG: { feedProvider: 'adsterra' },
    ADSTERRA: { bannerKey: 'testkey', inFeedEveryN: 3, inFeedFirstAt: 2 },
    document: {
      createElement: () => ({
        className: '', dataset: {}, style: {}, _attrs: {},
        setAttribute(k, v) { this._attrs[k] = v; },
      }),
    },
    ensureMonetagInFeedObserver: () => null,
    ensureAdsterraInFeedObserver: () => null,
    loadMonetagInFeedSlot: () => {},
    loadAdsterraInFeedSlot: () => {},
    drexAdsActive: () => false,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.__fn = maybeInsertFeedAd;', sandbox);
  sandbox.__fn(frag, 1); // idx=2 == inFeedFirstAt: sería slot para no-miembro
  return frag.appended;
}

let memberAppended = null, guestAppended = null;
try { memberAppended = runMaybeInsertFeedAd(true); } catch (e) { /* abajo se reporta */ }
try { guestAppended = runMaybeInsertFeedAd(false); } catch (e) { /* abajo se reporta */ }

ok(Array.isArray(memberAppended) && memberAppended.length === 0,
  'miembro Orbit verificado: maybeInsertFeedAd NO crea contenedor de anuncio');
ok(Array.isArray(guestAppended) && guestAppended.length === 1 &&
   guestAppended[0].className === 'drex-ad-slot',
  'no-miembro: el slot del feed se sigue creando igual que antes');

/* ---------- 2. drexWatchAdBody nunca revela un slot a un miembro ---------- */

function runWatchAdBody(member) {
  const src = extractFn('drexWatchAdBody');
  if (!src) throw new Error('drexWatchAdBody no encontrada');
  const timers = [];
  const slot = { dataset: {}, style: { display: '' }, offsetParent: {}, getClientRects: () => [{}] };
  const body = { querySelector: () => null };
  const sandbox = {
    drexOrbitNoAds: () => member,
    drexAdHasFill: () => true,
    drexAdSlotFail: (s) => { s.dataset.adFailed = '1'; },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.__fn = drexWatchAdBody;', sandbox);
  sandbox.__fn(body, slot, 4000);
  let guard = 0;
  while (timers.length && guard++ < 6) timers.shift()();
  return slot.style.display;
}

ok(runWatchAdBody(true) === 'none',
  'miembro Orbit: drexWatchAdBody deja el slot en display:none aunque haya fill');
ok(runWatchAdBody(false) === '',
  'no-miembro: drexWatchAdBody revela el slot con fill (comportamiento intacto)');

/* ---------- 3. done() de Adsterra y gates estructurales ---------- */

(function () {
  const i = html.indexOf('function drexLoadAdsterraBannerInto');
  const seg = html.slice(i, i + 2600);
  // C264: en done() la guardia es SOLO el plan efectivo (drexOrbitNoAds
  // -> hasAccess('no_ads')); el premio de Halloween ya es un plan Orbit
  // de prueba, no un pase suelto que los anuncios consulten aparte.
  const guardAt = seg.indexOf("drexOrbitNoAds === 'function' && drexOrbitNoAds())");
  ok(!seg.includes('drexHalloweenPassActive'), 'done() ya no consulta el pase suelto de Halloween');
  const revealAt = seg.indexOf("if (ok) { try { slot.style.display = ''; }");
  ok(guardAt !== -1 && revealAt !== -1 && guardAt < revealAt,
    'done() de Adsterra: la guardia Orbit corre antes de revelar el slot');
})();

ok(/function drexLoadSectionAds\(root\) \{\s*try \{\s*if \(typeof drexOrbitNoAds === 'function' && drexOrbitNoAds\(\)\) return;/.test(html),
  'drexLoadSectionAds (slots estáticos) sigue gateado en cabecera');

(function () {
  // Solo markup estático: el wrap del feed se construye por JS (plantilla
  // con `' + label + '`) y lo gobierna la puerta de maybeInsertFeedAd.
  const tags = (html.match(/<div[^>]*class="[^"]*drex-ad-slot[^"]*"[^>]*>/g) || [])
    .filter(t => t.indexOf("' + label + '") === -1);
  const visibles = tags.filter(t => !/display:none/.test(t));
  ok(tags.length > 0 && visibles.length === 0,
    'todo slot .drex-ad-slot estático nace display:none (' + tags.length + ' slots)');
})();

ok(html.indexOf("document.querySelectorAll('.drex-ad-slot')") !== -1 ||
   /querySelectorAll\(['"]\.drex-ad-slot/.test(html),
  'drexOrbitApplyGates barre los .drex-ad-slot existentes');

/* ---------- 4. Hub de crear: tiles tappables, sin overlay ---------- */

(function () {
  const a = html.indexOf('id="creator-hub-view"');
  ok(a !== -1, 'creator-hub-view existe');
  // El hub termina donde empieza el editor a pantalla completa.
  const hub = html.slice(a, html.indexOf('id="note-creation-fullscreen"', a));
  const onclicks = [...hub.matchAll(/<button[^>]*onclick="([^"]+)"/g)].map(m => m[1]);
  ok(onclicks.some(o => o.indexOf("creatorHubSelectFormat('post')") === 0), 'tile Post con handler directo');
  ok(onclicks.some(o => o.indexOf('openEnVivoSection()') === 0), 'tile En vivo con handler directo');
  ok(onclicks.some(o => o.indexOf('musicCardTap') !== -1), 'tile Música abre la sección de música');
  ok(!/py-12 text-center/.test(hub), 'ningún overlay "py-12 text-center" dentro del hub');
  const tiles = hub.match(/<button[^>]*class="flex flex-col items-center/g) || [];
  ok(tiles.length >= 3, 'las tiles son botones de primer nivel (' + tiles.length + ')');
})();

ok(/#note-creation-fullscreen \{[^}]*pointer-events: none;/.test(html),
  '#note-creation-fullscreen inactivo no intercepta toques (pointer-events:none)');
ok(/#note-creation-fullscreen\.active \{[^}]*pointer-events: auto;/.test(html),
  '#note-creation-fullscreen activo sí recibe toques');

console.log('\n' + passed + ' ok, ' + failed + ' fallos — C246 ads/hub');
process.exit(failed ? 1 : 0);
