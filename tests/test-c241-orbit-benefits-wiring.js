/* ================================================================
 * C241 — beneficios Drex Orbit vinculados de verdad (2026-10-03).
 *
 * La suscripción ya se activaba en el servidor (DynamoDB active) y la app
 * mostraba "Active member", pero varios beneficios no se aplicaban. Este
 * test fija el cableado extremo a extremo de los beneficios vigentes
 * (ORBIT_FEATURES tras C240) y la semántica fail-closed:
 *
 *  no_ads ........... ningún cargador de anuncios inyecta con Orbit activo
 *                     (Adsterra, Monetag, AdSense, sticky, música) y los
 *                     contenedores visibles se ocultan al activar.
 *  badge ............ píldora Orbit junto al autor en posts y comentarios
 *                     (propios, con suscripción verificada en el cliente).
 *  profile_themes ... temas pro con puerta al aplicar y repliegue al
 *                     tema base si el estado verificado no es activo.
 *  fiesta_boost ..... la fiesta de un anfitrión suscrito nace marcada
 *                     (fiestaOrbit) y el ranking "Para ti" la impulsa.
 *  limits ........... videos 180s, fotos 40, cámara 180s: los helpers se
 *                     llaman en los puntos reales (composer, picker,
 *                     publicar, cámara) sin topes duros residuales.
 *  analytics ........ la vista de analíticas pasa por orbitGate.
 *  priority_support . el reporte nace con priority:true en reports/.
 *
 * Ejecutar: node tests/test-c241-orbit-benefits-wiring.js
 * ================================================================ */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const html404 = fs.readFileSync(path.join(root, '404.html'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'drex-i18n.js'), 'utf8');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('ok - ' + name); }
function has(s) { return html.includes(s); }
function count(s) { return html.split(s).length - 1; }

/* ---------- base: beneficios vigentes y el núcleo fail-closed ---------- */

ok('ORBIT_FEATURES sigue siendo la lista de 7 beneficios', () => {
  assert(has("var ORBIT_FEATURES = ['no_ads', 'badge', 'profile_themes', 'fiesta_boost', 'limits', 'analytics', 'priority_support', 'hd_uploads', 'longer_posts', 'pin_post', 'profile_visitors'];"));
});

ok('hasAccess rechaza funciones desconocidas (fail-closed)', () => {
  assert(has('if (ORBIT_FEATURES.indexOf(feature) === -1) return false;'));
});

ok('refresh ante cualquier fallo deja estado inactivo (fail-closed)', () => {
  // C263: un fallo transitorio ya NO desconfigura el servidor (orbitGate
  // permanecía abierto durante la caída); solo reset()/logout lo limpian.
  assert(has('self._st = fail; }'));
  assert(!has('self._st = fail; self._serverConfigured = false;'));
  assert(has("var fail = { active: false, plan: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, status: 'none' };"));
});

ok('el núcleo DrexOrbit no usa flags locales (localStorage) para activarse', () => {
  const start = html.indexOf('var DrexOrbit = {');
  const end = html.indexOf('window.DrexOrbit = DrexOrbit;');
  assert(start > 0 && end > start);
  const core = html.slice(start, end);
  assert(!core.includes('localStorage'), 'DrexOrbit no debe leer/escribir localStorage');
});

/* ---------- ciclo de vida ---------- */

ok('refresh() reaplica las puertas (beneficios sin recargar)', () => {
  const start = html.indexOf('refresh: async function (force)');
  const seg = html.slice(start, start + 1600);
  assert(seg.includes('window.drexOrbitApplyGates'), 'refresh debe llamar drexOrbitApplyGates');
});

ok('reset() limpia el estado y reaplica las puertas (beneficios fuera)', () => {
  const start = html.indexOf('reset: function () {', html.indexOf('var DrexOrbit = {'));
  const seg = html.slice(start, start + 400);
  assert(seg.includes('this._st = null;'));
  assert(seg.includes('window.drexOrbitApplyGates'));
});

ok('al iniciar sesión: reset + refresh del estado Orbit', () => {
  assert(has('DrexOrbit.reset(); } catch (_) {} setTimeout(function () { DrexOrbit.refresh(); }, 1500);'));
});

ok('al cerrar sesión se limpia el estado Orbit (clearAccountScopedState)', () => {
  const start = html.indexOf('function clearAccountScopedState() {');
  const seg = html.slice(start, start + 1200);
  assert(seg.includes('DrexOrbit.reset'), 'logout debe resetear Orbit');
});

ok('el retorno de Stripe (?orbit=success) fuerza refresh', () => {
  assert(has('DrexOrbit.refresh(true).then(function (s) {'));
});

/* ---------- no_ads ---------- */

ok('drexOrbitNoAds existe, usa hasAccess y está exportado', () => {
  assert(has('function drexOrbitNoAds() {'));
  assert(has("DrexOrbit.hasAccess('no_ads')"));
  assert(has('window.drexOrbitNoAds = drexOrbitNoAds;'));
});

const AD_GATES = [
  ['drexLoadSectionAds', "function drexLoadSectionAds(root) {\n    try {\n      if (typeof drexOrbitNoAds === 'function' && drexOrbitNoAds()) return;"],
  ['drexLoadMonetagIPP', "if (typeof drexOrbitNoAds === 'function' && drexOrbitNoAds()) return false;"],
  ['drexTryMonetagFallback', null],
  ['adsterraInjectBanners', null],
  ['drexStickyAdLoad', null],
  ['adsterraMaybeInterstitial', null],
  ['musicPreloadAdBreak', null],
  ['initDrexAds', null],
  ['getDrexAdSlotHTML', null],
  ['pushDrexAdSlots', null],
];
AD_GATES.forEach(([fn, exact]) => {
  ok('puerta no_ads en ' + fn, () => {
    const start = html.indexOf('function ' + fn);
    assert(start > 0, 'no se encontró ' + fn);
    const seg = html.slice(start, start + 900);
    assert(seg.includes('drexOrbitNoAds()'), fn + ' debe consultar drexOrbitNoAds al inicio');
    if (exact) assert(html.includes(exact));
  });
});

ok('los banners Adsterra/Monetag no se inyectan con Orbit activo', () => {
  assert.strictEqual(count("drexOrbitNoAds()) { try { if (slot) slot.style.display = 'none';"), 2,
    'drexLoadAdsterraBannerInto y drexLoadMonetagBannerInto deben ocultar el bloque y abortar');
});

ok('la pausa publicitaria de música no interrumpe con Orbit activo', () => {
  const start = html.indexOf('function musicMaybeAdBreak(next) {');
  const seg = html.slice(start, start + 300);
  assert(seg.includes('drexOrbitNoAds()) return false;'));
});

ok('el slot de música oculta su tarjeta con Orbit activo', () => {
  const start = html.indexOf('function adsterraInjectMusicSlot() {');
  const seg = html.slice(start, start + 400);
  assert(seg.includes('drexOrbitNoAds()'));
  assert(seg.includes("getElementById('adsterra-music-card')"));
});

ok('initAdsterra: no carga redes con Orbit y espera al refresh en el arranque', () => {
  const start = html.indexOf('function initAdsterra() {');
  const seg = html.slice(start, start + 1800);
  assert(seg.includes("DrexOrbit.hasAccess('no_ads')"));
  assert(seg.includes('__drexAdInitOrbitWait'), 'debe diferir la inyección hasta verificar el estado');
  assert(seg.includes('DrexOrbit.refresh().then(_oiRetry, _oiRetry);'));
});

ok('drexOrbitApplyGates oculta anuncios visibles, sticky y música al activar', () => {
  const start = html.indexOf('window.drexOrbitApplyGates = (function () {');
  const seg = html.slice(start, start + 2600);
  assert(seg.includes("querySelectorAll('.drex-ad-slot')"));
  assert(seg.includes("getElementById('drex-sticky-ad')"), 'el banner fijo no es .drex-ad-slot: se oculta aparte');
  assert(seg.includes("getElementById('adsterra-music-card')"));
  assert(seg.includes('musicCloseAdBreak'), 'una pausa publicitaria en curso se cierra');
  assert(seg.includes('data-orbit-ad-hidden'), 'solo se restaura lo que el gate ocultó (vuelta al vencer)');
});

/* ---------- badge ---------- */

ok('drexOrbitAuthorBadgeHTML: solo el propio usuario con Orbit verificado', () => {
  assert(has('function drexOrbitAuthorBadgeHTML(authorId, user) {'));
  assert(has('if (!authorId || !user || authorId !== user.uid) return \'\';'));
  assert(has('window.drexOrbitAuthorBadgeHTML = drexOrbitAuthorBadgeHTML;'));
});

ok('la píldora Orbit se renderiza en las tarjetas de publicación', () => {
  assert(has('const safeAuthorOrbitBadge = (typeof drexOrbitAuthorBadgeHTML === \'function\') ? drexOrbitAuthorBadgeHTML(safeAuthorId, user) : \'\';'));
  assert(has('${safeAuthorVerifiedIcon}${safeAuthorOrbitBadge}'));
});

ok('la píldora Orbit se renderiza en los comentarios', () => {
  assert(has('orbitBadge: (function () {'));
  assert(has('${o.commentVerifiedIcon}${o.orbitBadge || \'\'}'));
});

ok('existe el estilo compacto de la píldora', () => {
  assert(has('.orbit-badge-mini{'));
});

ok('la insignia de perfil propio y de autor se sigue refrescando', () => {
  assert(has('refreshOrbitProfileBadge()'));
  assert(has("getElementById('orbit-profile-badge')"));
  assert(has("getElementById('orbit-author-badge')"));
});

/* ---------- profile_themes ---------- */

ok('aplicar un tema pro pasa por orbitGate(profile_themes)', () => {
  const start = html.indexOf('async function setOrbitProfileTheme(id) {');
  const seg = html.slice(start, start + 300);
  assert(seg.includes("!orbitGate('profile_themes')"));
});

ok('un tema pro guardado se repliega al base si Orbit no está activo', () => {
  assert(has('if (th.pro && !((typeof DrexOrbit !== \'undefined\') && DrexOrbit.isActive())) th = ORBIT_PROFILE_THEMES[0];'));
});

/* ---------- limits ---------- */

ok('el composer valida el video con drexOrbitVideoPostMaxSec', () => {
  assert(has('if (duration > drexOrbitVideoPostMaxSec())'));
  assert(has('if (d > drexOrbitVideoPostMaxSec()) {'));
});

ok('al publicar ya no hay tope duro de 20 fotos: manda drexOrbitPhotosMax', () => {
  assert(has('notePostImageFiles.slice(0, (typeof drexOrbitPhotosMax === \'function\' ? drexOrbitPhotosMax() : 20))'));
  assert(!has('notePostImageFiles.slice(0, 20)'), 'el slice(0, 20) duro recortaba las fotos extra del suscriptor');
});

ok('el selector de fotos avisa el máximo real con drexOrbitPhotosMax', () => {
  assert(has('const room = drexOrbitPhotosMax() - notePostImageFiles.length;'));
});

ok('la cámara graba con drexOrbitCamMaxSec (tick + corte duro)', () => {
  assert(has('const max = drexOrbitCamMaxSec();'));
  assert(has('drexOrbitCamMaxSec() * 1000 + 400'));
});

ok('los bloqueos de límite sugieren Orbit solo a quien no lo tiene', () => {
  assert(has("appT('Con Drex Orbit puedes subir videos de hasta 180 segundos.')"));
  assert(has("appT('Con Drex Orbit puedes subir hasta 40 fotos por publicación.')"));
  assert(count('DrexOrbit.enforced() && !DrexOrbit.isActive()') >= 2);
});

ok('programar publicaciones pasa por orbitGate(limits)', () => {
  const start = html.indexOf('function openScheduleSheetFromComposer() {');
  const seg = html.slice(start, start + 300);
  assert(seg.includes("!orbitGate('limits')"));
});

/* ---------- analytics ---------- */

ok('las analíticas de creador pasan por orbitGate(analytics)', () => {
  const start = html.indexOf('function orbitOpenAnalytics() {');
  const seg = html.slice(start, start + 300);
  assert(seg.includes("!orbitGate('analytics')"));
});

/* ---------- fiesta_boost ---------- */

ok('la fiesta de un anfitrión Orbit nace marcada (fiestaOrbit)', () => {
  assert(has("if (typeof DrexOrbit !== 'undefined' && DrexOrbit.isActive()) note.fiestaOrbit = true;"));
});

ok('el ranking "Para ti" impulsa las fiestas Orbit en vivo', () => {
  assert(has("var fiestaBoost = (note.fiestaId && note.fiestaStatus === 'live' && note.fiestaOrbit === true) ? 25 : 0;"));
  assert(has('return recency + popularity + personal + fiestaBoost;'));
});

ok('la tarjeta de fiesta marcada muestra la píldora Orbit', () => {
  assert(has("${note.fiestaOrbit ? '<span class=\"orbit-badge orbit-badge-mini\">Drex Orbit</span>' : ''}"));
});

/* ---------- priority_support ---------- */

ok('el reporte calcula la prioridad con hasAccess(priority_support)', () => {
  assert(has("DrexOrbit.hasAccess('priority_support')"));
});

ok('el reporte se guarda con priority en reports/', () => {
  assert(has('priority: orbitPriority,'));
});

ok('la confirmación avisa la prioridad al miembro Orbit', () => {
  assert(has("_drexReportLastPriority) ? '<p class=\"drex-report-anon\">' + appT('Como miembro Drex Orbit, tu reporte tiene prioridad.')"));
});

/* ---------- i18n de los textos nuevos ---------- */

ok('los textos nuevos tienen EN/ZH/PT (patrón DREX-ORBIT)', () => {
  assert(i18n.includes('"Como miembro Drex Orbit, tu reporte tiene prioridad.":"As a Drex Orbit member, your report has priority."'));
  assert(i18n.includes('"Con Drex Orbit puedes subir videos de hasta 180 segundos.":"With Drex Orbit you can upload videos up to 180 seconds."'));
  assert(i18n.includes('"Con Drex Orbit puedes subir hasta 40 fotos por publicación.":"With Drex Orbit you can upload up to 40 photos per post."'));
  assert(i18n.includes('"Como miembro Drex Orbit, tu reporte tiene prioridad.":"作为 Drex Orbit 会员，你的举报享有优先处理。"'));
  assert(i18n.includes('"Como miembro Drex Orbit, tu reporte tiene prioridad.":"Como membro Drex Orbit, sua denúncia tem prioridade."'));
});

/* ---------- 404 idéntico ---------- */

ok('404.html es copia exacta de index.html', () => {
  assert.strictEqual(html404, html);
});

console.log('\nC241: ' + passed + ' comprobaciones OK');
