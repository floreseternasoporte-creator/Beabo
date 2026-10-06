#!/usr/bin/env node
/* =====================================================================
 * C264 — Orbit por niveles + Halloween = plan de prueba.
 *
 * - Cada plan vendible tiene nivel (monthly 1, quarterly 2, semiannual 3,
 *   yearly/biennial/lifetime 4) y cada privilegio pide un nivel mínimo.
 * - El plan EFECTIVO manda: pagado verificado > prueba del evento > nada.
 *   La prueba cuenta aunque el backend de pagos esté caído; si el pagado
 *   se cancela a mitad de la prueba, la prueba sigue hasta su fecha.
 * - Halloween ya no es un pase suelto: los anuncios solo leen
 *   hasAccess('no_ads') del plan efectivo.
 * - Puertas nuevas: photo_downloads, chat_themes, instant_username,
 *   long_polls y big_parties, cada una en su entrada real.
 *
 * Uso: node tests/test-c264-niveles-prueba-halloween.js
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const i18nJs = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + msg); } };
const eq = (a, b, msg) => ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');
const has = (needle, msg) => ok(html.includes(needle), msg || ('fuente incluye: ' + needle.slice(0, 64)));

function makeEl() {
  return {
    innerHTML: '', textContent: '', value: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {}, dataset: {}, parentElement: null,
    appendChild() {}, addEventListener() {}, setAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
}
function buildSandbox() {
  const els = {};
  const sandbox = {
    console, Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, URL, encodeURIComponent, decodeURIComponent,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    addEventListener() {},
    location: { origin: 'http://localhost', pathname: '/', search: '', href: 'http://localhost/' },
    navigator: { userAgent: 'test' },
    document: {
      readyState: 'complete', hidden: false,
      addEventListener() {},
      getElementById: (id) => { els[id] = els[id] || makeEl(); return els[id]; },
      createElement: () => makeEl(),
      createTextNode: (s) => String(s),
      querySelector() { return null; }, querySelectorAll() { return []; },
      body: makeEl(),
    },
    fetch: async () => { throw new Error('no-network-in-test'); },
    DREX_PAYMENTS_ENDPOINT: 'https://payments.test.invalid',
    DrexCloud: { auth: () => ({ currentUser: null }) },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.t = (s) => s;
  sandbox.escapeHtml = (s) => String(s == null ? '' : s);
  sandbox.renderOrbitThemesRow = () => '';
  sandbox.orbitToast = () => {};
  sandbox.orbitIconSVG = () => '<svg></svg>';
  sandbox.__trialPlan = null;
  sandbox.__paywallFeature = null;
  sandbox.drexHalloweenTrialPlan = () => sandbox.__trialPlan;
  sandbox.openOrbitPaywall = (f) => { sandbox.__paywallFeature = f || ''; };
  vm.createContext(sandbox);
  const mCore = html.match(/\/\* =+\n \* DREX ORBIT — suscripción Orbit de Drex[\s\S]*?window\.DREX_ORBIT_ENFORCE = false;/);
  ok(!!mCore, 'núcleo DrexOrbit localizable');
  vm.runInContext(mCore[0], sandbox);
  const gi = html.indexOf('function orbitGate(feature) {');
  ok(gi !== -1, 'orbitGate localizable');
  vm.runInContext(html.slice(gi, html.indexOf('\n}', gi) + 3), sandbox);
  return { sandbox, els };
}

const { sandbox } = buildSandbox();
const K = sandbox.DrexOrbit;
ok(!!K, 'DrexOrbit definido');
const FUTURE = Math.floor(Date.now() / 1000) + 30 * 86400;
const paid = (plan, extra) => K._setTestState(Object.assign({ active: true, plan, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false, status: 'active' }, extra || {}));
const none = () => K._setTestState(null);

console.log('-- C264.1: niveles por plan (pagado verificado) --');
sandbox.window.DREX_ORBIT_ENFORCE = true;
eq(sandbox.orbitPlanTier('monthly'), 1, 'monthly = N1');
eq(sandbox.orbitPlanTier('quarterly'), 2, 'quarterly = N2');
eq(sandbox.orbitPlanTier('semiannual'), 3, 'semiannual = N3');
eq(sandbox.orbitPlanTier('yearly'), 4, 'yearly = N4');
eq(sandbox.orbitFeatureTier('no_ads'), 1, 'no_ads en todos los niveles');
eq(sandbox.orbitFeatureTier('profile_visitors'), 4, 'profile_visitors solo N4');
eq(sandbox.orbitFirstPlanWithFeature('pin_post'), 'semiannual', 'upsell de pin_post preselecciona Semestral');
eq(sandbox.orbitFirstPlanWithFeature('analytics'), 'yearly', 'upsell de analytics preselecciona Anual');

paid('monthly');
for (const f of ['no_ads', 'badge', 'limits', 'hd_uploads', 'photo_downloads', 'chat_themes', 'instant_username']) eq(K.hasAccess(f), true, 'Mensual incluye ' + f);
for (const f of ['longer_posts', 'profile_themes', 'long_polls', 'pin_post', 'fiesta_boost', 'big_parties', 'analytics', 'priority_support', 'profile_visitors']) eq(K.hasAccess(f), false, 'Mensual NO incluye ' + f);
paid('quarterly');
eq(K.hasAccess('longer_posts'), true, 'Trimestral suma longer_posts');
eq(K.hasAccess('long_polls'), true, 'Trimestral suma long_polls');
eq(K.hasAccess('pin_post'), false, 'Trimestral aún sin pin_post');
paid('semiannual');
eq(K.hasAccess('pin_post'), true, 'Semestral suma pin_post');
eq(K.hasAccess('big_parties'), true, 'Semestral suma big_parties');
eq(K.hasAccess('analytics'), false, 'Semestral aún sin analytics');
paid('yearly');
for (const f of sandbox.ORBIT_FEATURES) eq(K.hasAccess(f), true, 'Anual incluye todo: ' + f);
eq(K.hasAccess('feature_que_no_existe'), false, 'feature desconocida = false (fail-closed)');

console.log('-- C264.2: plan de prueba del evento (Halloween) --');
none();
sandbox.__trialPlan = 'monthly';
eq(K.effectivePlan(), 'monthly', 'sin pagado, manda la prueba');
eq(K.hasAccess('no_ads'), true, 'prueba Mensual: sin anuncios al instante');
eq(K.hasAccess('analytics'), false, 'prueba Mensual: sin analytics (N4)');
eq(sandbox.orbitGate('no_ads'), true, 'orbitGate deja pasar lo del nivel de la prueba');
eq(sandbox.orbitGate('analytics'), false, 'orbitGate bloquea lo de niveles superiores');
eq(sandbox.__paywallFeature, 'analytics', 'el paywall se abre por analytics');
sandbox.__trialPlan = 'quarterly';
eq(K.hasAccess('profile_themes'), true, 'prueba Trimestral (default del evento): temas de perfil sí');
eq(K.hasAccess('pin_post'), false, 'prueba Trimestral: pin_post no');

/* La prueba cuenta aunque el backend de pagos esté caído. */
sandbox.window.DREX_ORBIT_ENFORCE = false;
K._serverConfigured = false;
eq(K.enforced(), false, 'backend caído: enforced() false');
eq(K.hasAccess('no_ads'), true, 'la prueba sigue dando no_ads sin backend');
eq(K.hasAccess('profile_visitors'), false, 'y sigue respetando su nivel sin backend');
sandbox.window.DREX_ORBIT_ENFORCE = true;

console.log('-- C264.3: precedencia pagado > prueba, y cancelación --');
paid('yearly');
sandbox.__trialPlan = 'monthly';
eq(K.effectivePlan(), 'yearly', 'pagado verificado manda sobre la prueba');
eq(K.hasAccess('analytics'), true, 'con Anual pagado, analytics sí');
paid('monthly', { cancelAtPeriodEnd: true });
eq(K.verifiedActive(), false, 'cancelar apaga el pagado al instante');
eq(K.effectivePlan(), 'monthly', 'la prueba sigue viva tras cancelar el pagado');
eq(K.hasAccess('no_ads'), true, 'la prueba mantiene no_ads');
sandbox.__trialPlan = 'quarterly';
eq(K.effectivePlan(), 'quarterly', 'cancelado el pagado, la prueba Trimestral toma el mando');
eq(K.hasAccess('longer_posts'), true, 'y da sus beneficios N2');
sandbox.__trialPlan = null;
eq(K.effectivePlan(), null, 'sin pagado válido ni prueba: nada');
eq(K.hasAccess('no_ads'), false, 'fail-closed total');

console.log('-- C264.4: Halloween cableado como plan (fuente) --');
has('function drexHalloweenTrialInfo()', 'existe drexHalloweenTrialInfo');
has('function drexHalloweenTrialPlan()', 'existe drexHalloweenTrialPlan');
has('JSON.stringify({ freeUntil: Number(grant.freeUntil), plan: plan })', 'la caché guarda {freeUntil, plan}');
has("? grant.plan : 'quarterly'", 'grant sin plan = quarterly por defecto');
has('Tu {plan} gratis está activo hasta el {d}', 'la vista del evento dice plan y fecha');
has('Evento de Halloween: fuiste elegido. Tu {plan} gratis está activo hasta el {fecha}.', 'la notificación dice plan y fecha');
has('Ganar 2 semanas de Drex Orbit gratis', 'el evento vende un plan Orbit, no un pase');
ok(!html.includes("typeof drexHalloweenPassActive === 'function' && drexHalloweenPassActive()"),
  'ninguna compuerta de anuncios consulta ya el pase suelto');
has('drexHalloweenOnLogin(user.uid)', 'el login refresca grant y anuncio');

console.log('-- C264.5: puertas nuevas en su entrada real (fuente) --');
(function () {
  const save = html.slice(html.indexOf('async function saveCarouselPhoto()'), html.indexOf('async function saveCarouselPhoto()') + 1600);
  ok(save.includes("orbitGate('photo_downloads')") && save.indexOf("orbitGate('photo_downloads')") < save.indexOf('fetch(safeUrl'), 'descargar foto pasa por photo_downloads antes de bajar');
})();
has("orbitGate('chat_themes')", 'temas de chat decorativos pasan por chat_themes');
has("DrexOrbit.hasAccess('instant_username')", 'el cooldown de @ se salta con instant_username');
has("orbitGate('long_polls')", 'votaciones de 3 días/1 semana pasan por long_polls');
has("orbitGate('big_parties')", 'fiestas de más de 6 asientos pasan por big_parties');
has("orbitGate('photo_downloads')", 'la puerta photo_downloads está cableada');

console.log('-- C264.6: vista Orbit (fuente) --');
has('id="orbit-view-footer"', 'la vista tiene pie fijo propio, fuera del scroll');
has('window._orbitFooterHTML', 'la barra de compra se pinta en el pie fijo');
has('orbitBenefitsMatrixHTML(', 'matriz única de beneficios en la vista');
has('assets/img/drex-orbit-3d-320.png', 'hero con imagen ligera (sin abanico de 1.27MB)');
has("t('Plan de prueba')", 'rama visible de Plan de prueba');
has('orbitContinueWithTrialPlan()', 'seguir con el plan de la prueba sin corte');

console.log('-- C264.7: i18n de lo nuevo --');
for (const k of ['Plan de prueba', 'Seguir con este plan', 'Tu {plan} gratis está activo hasta el {d}',
  'Descargar fotos', 'Temas de chat premium', 'Cambios de @ al instante', 'Votaciones largas', 'Fiestas de voz grandes']) {
  ok(i18nJs.includes('"' + k + '":"'), 'clave traducida presente: ' + k);
}

console.log('\nC264: ' + pass + ' ok, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
