#!/usr/bin/env node
/* =====================================================================
 * C243 — Orbit: selector de precios estilo Meta + 4 privilegios nuevos
 * (hd_uploads, longer_posts, pin_post, profile_visitors) + detectores de
 * ciclo de vida con OFF/ON instantáneo (Part D).
 *
 * Sandbox vm al estilo test-orbit-plans-availability: núcleo DrexOrbit +
 * bloque UI (vista/paywall) evaluados, renderOrbitView() renderizada a
 * mano, transiciones de estado vía DrexOrbit._setTestState.
 * Fail-closed: seleccionar planes no concede nada; todo privilegio pasa
 * por DrexOrbit.hasAccess/isActive.
 *
 * Uso: node tests/test-c243-orbit-pricing-privileges.js
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const html404 = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');
const i18nJs = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + msg); } };
const eq = (a, b, msg) => ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

/* ---------- sandbox ---------- */
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
    location: { origin: 'http://localhost', pathname: '/', search: '', href: 'http://localhost/', assign() {} },
    navigator: { userAgent: 'test' },
    document: {
      readyState: 'complete', hidden: false, visibilityState: 'visible',
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
  vm.createContext(sandbox);
  const mCore = html.match(/\/\* =+\n \* DREX ORBIT — suscripción Orbit de Drex[\s\S]*?window\.DREX_ORBIT_ENFORCE = false;/);
  ok(!!mCore, 'núcleo DrexOrbit localizable');
  vm.runInContext(mCore[0], sandbox);
  const mUi = html.match(/\/\* ============ Drex Orbit: vista, paywall, temas, analíticas ============ [\s\S]*?\nasync function orbitManage\(\)/);
  ok(!!mUi, 'bloque UI de Orbit localizable');
  vm.runInContext(mUi[0].replace(/\nasync function orbitManage\(\)$/, ''), sandbox);
  return { sandbox, els };
}
function evalWith(src, globals) {
  const ctx = Object.assign({ console }, globals);
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}
function extractFn(name) {
  const i = html.indexOf('function ' + name + '(');
  ok(i !== -1, 'existe function ' + name);
  const j = html.indexOf('\nfunction ', i + 10);
  return html.slice(i, j === -1 ? undefined : j);
}
function segment(from, to) {
  const i = html.indexOf(from);
  ok(i !== -1, 'segmento: ' + from.slice(0, 48));
  const j = to ? html.indexOf(to, i + from.length) : -1;
  return html.slice(i, j === -1 ? undefined : j);
}

const { sandbox, els } = buildSandbox();
const K = sandbox.DrexOrbit;
ok(!!K, 'DrexOrbit definido');

(async () => {

/* ================= A. Pricing estilo Meta ================= */
console.log('-- A: selector de planes (Meta) --');
eq(sandbox.orbitPlanMonthlyCents('monthly'), 499, 'mensual: 499¢/mes');
eq(sandbox.orbitPlanMonthlyCents('quarterly'), 433, 'trimestral: 1299/3 = 433¢/mes');
eq(sandbox.orbitPlanMonthlyCents('semiannual'), 417, 'semestral: 2499/6 = 417¢/mes');
eq(sandbox.orbitPlanMonthlyCents('yearly'), 417, 'anual: 4999/12 = 417¢/mes');
eq(sandbox.orbitPlanSavingsPct('monthly'), 0, 'mensual: 0% de ahorro');
eq(sandbox.orbitPlanSavingsPct('quarterly'), 13, 'trimestral ahorra 13% vs mensual');
eq(sandbox.orbitPlanSavingsPct('semiannual'), 17, 'semestral ahorra 17% vs mensual');
eq(sandbox.orbitPlanSavingsPct('yearly'), 17, 'anual ahorra 17% vs mensual');
eq(sandbox.orbitPlanMonthlyPrice('quarterly'), '$4.33', 'trimestral ≈ $4.33/mes');

await sandbox.renderOrbitView();
const r = els['orbit-view-content'].innerHTML + '\n' + (els['orbit-view-footer'] ? els['orbit-view-footer'].innerHTML : '');
ok(r.length > 500, 'la vista Orbit se renderiza sin sesión');
eq((r.match(/orbit-plan-card/g) || []).length, 7, 'se renderizan las 7 tarjetas');
for (const id of ['monthly', 'quarterly', 'semiannual', 'yearly']) {
  ok(r.includes("orbitSelectPlan('" + id + "')"), id + ': tarjeta seleccionable');
  ok(r.includes('role="radio"'), id + ': role=radio presente');
  ok(!r.includes("orbitSubscribe('" + id + "')"), id + ': la tarjeta no cobra por su cuenta');
}
for (const id of ['weekly', 'biennial', 'lifetime']) {
  ok(!r.includes("orbitSelectPlan('" + id + "')"), id + ': NO seleccionable');
  ok(r.includes('plan-coming-soon'), id + ': marcado Próximamente');
}
eq((r.match(/id="orbit-subscribe-cta"/g) || []).length, 1, 'un único botón de suscripción');
ok(r.includes('orbitSubscribeSelected()'), 'el CTA cobra el plan seleccionado');
ok(r.includes('Anual') && r.includes('$49.99'), 'CTA por defecto: Anual $49.99 (recomendado)');
ok(r.includes('Recomendado'), 'el anual lleva la etiqueta Recomendado');
ok(r.includes('Ahorras 17%'), 'el anual muestra el ahorro calculado (17%)');
ok(r.includes('$4.99') && r.includes('$12.99') && r.includes('$24.99'), 'precios visibles sin sesión');

/* checklist de privilegios: matriz única por nivel (C264), tocable */
const FEATS16 = ['no_ads', 'badge', 'profile_themes', 'fiesta_boost', 'limits', 'analytics', 'priority_support', 'hd_uploads', 'longer_posts', 'pin_post', 'profile_visitors', 'photo_downloads', 'chat_themes', 'instant_username', 'long_polls', 'big_parties'];
ok(r.includes('Todo lo que incluye'), 'sección checklist presente');
for (const f of FEATS16) ok(r.includes("orbitBenefitTap('" + f + "')"), 'checklist incluye ' + f);
eq((r.match(/orbit-benefit-check/g) || []).length, 16, 'con el plan Anual elegido, la matriz marca los 16 incluidos');

/* selección: comportamiento Meta + fail-closed */
sandbox.orbitSelectPlan('monthly');
eq(sandbox.orbitSelectedPlan(), 'monthly', 'tocar Mensual lo selecciona');
ok(els['orbit-subscribe-cta'].textContent.includes('Mensual'), 'el CTA refleja Mensual');
ok(els['orbit-subscribe-cta'].textContent.includes('$4.99'), 'el CTA refleja $4.99');
sandbox.orbitSelectPlan('weekly');
eq(sandbox.orbitSelectedPlan(), 'monthly', 'weekly (Próximamente) no se puede seleccionar');
let captured = null;
sandbox.orbitSubscribe = (p) => { captured = p; };
sandbox.orbitSubscribeSelected();
eq(captured, 'monthly', 'orbitSubscribeSelected cobra el plan elegido');
eq(K.isActive(), false, 'fail-closed: seleccionar no activa nada');
eq(K.hasAccess('hd_uploads'), false, 'fail-closed: seleccionar no concede privilegios');

/* ================= B. Privilegios nuevos ================= */
console.log('-- B: privilegios nuevos --');
ok(html.includes("var ORBIT_FEATURES = ['no_ads', 'badge', 'profile_themes', 'fiesta_boost', 'limits', 'analytics', 'priority_support', 'hd_uploads', 'longer_posts', 'pin_post', 'profile_visitors', 'photo_downloads', 'chat_themes', 'instant_username', 'long_polls', 'big_parties'];"), 'ORBIT_FEATURES tiene los 16 privilegios (C264)');
sandbox.window.DREX_ORBIT_ENFORCE = true;
const FUTURE = Math.floor(Date.now() / 1000) + 30 * 86400;
K._setTestState({ active: true, plan: 'monthly', currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false, status: 'active' });
for (const f of ['no_ads', 'badge', 'limits', 'hd_uploads', 'photo_downloads', 'chat_themes', 'instant_username']) eq(K.hasAccess(f), true, 'Mensual (N1): hasAccess(' + f + ')');
for (const f of ['longer_posts', 'profile_themes', 'long_polls', 'pin_post', 'fiesta_boost', 'big_parties', 'analytics', 'priority_support', 'profile_visitors']) eq(K.hasAccess(f), false, 'Mensual (N1) sin niveles superiores: ' + f);
K._setTestState({ active: true, plan: 'quarterly', currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false, status: 'active' });
for (const f of ['longer_posts', 'profile_themes', 'long_polls']) eq(K.hasAccess(f), true, 'Trimestral (N2): hasAccess(' + f + ')');
eq(K.hasAccess('pin_post'), false, 'Trimestral (N2) aún sin pin_post (N3)');
K._setTestState({ active: true, plan: 'semiannual', currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false, status: 'active' });
for (const f of ['pin_post', 'fiesta_boost', 'big_parties']) eq(K.hasAccess(f), true, 'Semestral (N3): hasAccess(' + f + ')');
eq(K.hasAccess('analytics'), false, 'Semestral (N3) aún sin analytics (N4)');
K._setTestState({ active: true, plan: 'yearly', currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false, status: 'active' });
for (const f of FEATS16) eq(K.hasAccess(f), true, 'Anual (N4): hasAccess(' + f + ')');
eq(K.hasAccess('exclusive_gifts'), false, 'exclusive_gifts sigue eliminado (C240)');

/* (a) HD: escalera mayor solo con acceso verificado; tope de storage intacto */
ok(html.includes('drexOrbitHdUploadsOn()'), 'el pipeline de fotos consulta el beneficio HD');
ok(html.includes('maxSide: 2048'), 'escalera HD llega a 2048px');
ok(html.includes('const MAX_URL_LENGTH = 300 * 1024;'), 'el tope de almacenamiento (DynamoDB) NO se tocó');
ok(html.includes('id="tool-hd"'), 'chip HD en el composer');
const hdSrc = extractFn('drexOrbitHdUploadsOn');
eq(evalWith(hdSrc, { DrexOrbit: { hasAccess: () => false } }).drexOrbitHdUploadsOn(), false, 'HD off sin acceso');
eq(evalWith(hdSrc, { DrexOrbit: { hasAccess: () => true } }).drexOrbitHdUploadsOn(), true, 'HD on con acceso');
eq(evalWith(hdSrc, { DrexOrbit: { hasAccess: () => true }, _drexHdUploads: false }).drexOrbitHdUploadsOn(), false, 'el chip HD puede apagarlo');
const hdToggle = extractFn('toggleComposerHdUploads');
ok(hdToggle.includes("openOrbitPaywall('hd_uploads')"), 'el chip HD sin Orbit abre el paywall hd_uploads');
ok(hdToggle.includes("hasAccess('hd_uploads')"), 'el chip HD verifica el acceso');
const vidSrc = extractFn('drexOrbitVideoDirectMaxBytes');
eq(evalWith(vidSrc, { VIDEO_POSTS_DIRECT_MAX_BYTES: 8 * 1024 * 1024, DrexOrbit: { hasAccess: () => true } }).drexOrbitVideoDirectMaxBytes(), 12 * 1024 * 1024, 'video Orbit: directo hasta 12MB');
eq(evalWith(vidSrc, { VIDEO_POSTS_DIRECT_MAX_BYTES: 8 * 1024 * 1024, DrexOrbit: { hasAccess: () => false } }).drexOrbitVideoDirectMaxBytes(), 8 * 1024 * 1024, 'video sin Orbit: directo hasta 8MB');
ok(html.includes('file.size > ((typeof drexOrbitVideoDirectMaxBytes'), 'la decisión de subida directa usa el beneficio HD');

/* (b) publicaciones más largas: único punto del límite */
const charsSeg = segment('function drexOrbitPostMaxChars', 'function onNoteFormatChange');
eq(evalWith(charsSeg, { DrexOrbit: { hasAccess: (f) => f === 'longer_posts' } }).getCurrentNoteMaxLength(), 2000, 'con longer_posts (N2+): 2000 caracteres');
eq(evalWith(charsSeg, { DrexOrbit: { hasAccess: () => false } }).getCurrentNoteMaxLength(), 200, 'sin longer_posts: 200 caracteres');

/* (c) marco Orbit en avatares (feed/posts/comentarios/perfil) */
ok(html.includes('.orbit-avatar-frame'), 'CSS del marco Orbit');
ok(html.includes('img[data-author-avatar]'), 'el hidratador recorre avatares de tarjetas');
ok(html.includes('hydrateOrbitAvatarFrames(document)'), 'applyGates hidrata el marco en toda la UI');
ok(html.includes("st.status === 'active' && st.cancelAtPeriodEnd !== true"), 'la insignia pública respeta la cancelación (Part D)');

/* (d) pin: puerta al fijar, fail-closed al render, tope 3 de C87 intacto */
const pinSeg = segment('async function toggleFeaturedPost', '\n}\n');
ok(pinSeg.includes("orbitGate('pin_post')"), 'fijar pasa por orbitGate(pin_post)');
ok(pinSeg.indexOf("orbitGate('pin_post')") < pinSeg.indexOf('DREX_FEATURED_MAX'), 'la puerta se evalúa antes del tope');
ok(html.includes('let DREX_FEATURED_MAX = 3;') || html.includes('DREX_FEATURED_MAX = 3'), 'el tope de destacados sigue en 3 (C87)');
ok((html.match(/drexOrbitPinsVisible\(author/g) || []).length >= 2, 'el render de destacados es fail-closed en perfil propio y ajeno');

/* (e) visitantes: write mínimo honesto + puerta */
ok(html.includes("'/profileVisitors/'"), 'se registra la visita en users/<dueño>/profileVisitors');
ok(html.includes('drexRecordProfileVisit(authorId)'), 'la visita se registra al abrir un perfil ajeno');
ok(html.includes('me.uid === ownerUid') || html.includes('me.uid===ownerUid'), 'nadie se registra a sí mismo');
ok(html.includes('id="orbit-visitors-sheet"'), 'hoja de visitantes presente');
ok(!html.includes('id="visitantes-settings-card"'), 'C244: la entrada de visitantes ya NO está en Ajustes');
ok(html.includes('id="profile-visitors-entry"'), 'C244: la entrada de visitantes vive en el perfil propio');
ok(segment('async function openOrbitVisitors', '\nasync function ').includes("orbitGate('profile_visitors')"), 'la lista pasa por orbitGate(profile_visitors)');

/* (f) programadas: tope extendido por el beneficio limits */
const schedSeg = segment('function confirmSchedulePost', '\n}\n');
ok(schedSeg.includes('drexOrbitScheduledPostsMax'), 'confirmar programa respeta el tope de la cola');
const schedSrc = extractFn('drexOrbitScheduledPostsMax');
eq(evalWith(schedSrc, { DrexOrbit: { enforced: () => false, hasAccess: () => false } }).drexOrbitScheduledPostsMax(), Infinity, 'sin puertas: sin tope (como hoy)');
eq(evalWith(schedSrc, { DrexOrbit: { enforced: () => true, hasAccess: () => false } }).drexOrbitScheduledPostsMax(), 3, 'sin limits: 3 programadas');
eq(evalWith(schedSrc, { DrexOrbit: { enforced: () => true, hasAccess: (f) => f === 'limits' } }).drexOrbitScheduledPostsMax(), 25, 'con limits (N1): 25 programadas');

/* paywall: copia para los 4 privilegios nuevos */
const copySrc = segment('function orbitPaywallCopy', 'function openOrbitPaywall');
const cctx = evalWith(copySrc, { t: (s) => s, DrexOrbit: { status: () => null } });
eq(cctx.orbitPaywallCopy('hd_uploads').title, 'Fotos y videos en HD', 'paywall hd_uploads');
eq(cctx.orbitPaywallCopy('longer_posts').title, 'Publicaciones más largas', 'paywall longer_posts');
eq(cctx.orbitPaywallCopy('pin_post').title, 'Publicaciones fijadas', 'paywall pin_post');
eq(cctx.orbitPaywallCopy('profile_visitors').title, 'Quién vio tu perfil', 'paywall profile_visitors');

/* ================= D. Ciclo de vida: OFF/ON instantáneo ================= */
console.log('-- D: detectores + off/on instantáneo --');
K._setTestState({ active: true, plan: 'monthly', currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false, status: 'active' });
eq(K.isActive(), true, 'D: activo -> beneficios ON');
K._setTestState({ active: true, plan: 'monthly', currentPeriodEnd: FUTURE, cancelAtPeriodEnd: true, status: 'active' });
eq(K.isActive(), false, 'D: cancelAtPeriodEnd -> beneficios OFF al instante');
eq(K.verifiedActive(), false, 'D: verifiedActive también OFF');
eq(K.hasAccess('profile_visitors'), false, 'D: puertas cerradas con cancelación');
{
  const st = K.status();
  eq(st.active, true, 'D: el estado crudo sigue pagado (active=true)');
  eq(st.currentPeriodEnd, FUTURE, 'D: la fecha pagada sigue disponible para la copia honesta');
  eq(st.cancelAtPeriodEnd, true, 'D: cancelAtPeriodEnd visible en el estado');
}
K._setTestState({ active: true, plan: 'monthly', currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false, status: 'active' });
eq(K.isActive(), true, 'D: reactivada -> beneficios ON en el siguiente refresh');
K._setTestState({ active: true, plan: 'monthly', currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false, status: 'past_due' });
eq(K.isActive(), false, 'D: past_due -> OFF');
K._setTestState({ active: true, plan: 'monthly', currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false, status: 'canceled' });
eq(K.isActive(), false, 'D: canceled -> OFF');
K._setTestState({ active: true, plan: 'monthly', currentPeriodEnd: Math.floor(Date.now() / 1000) - 3600, cancelAtPeriodEnd: false, status: 'active' });
eq(K.isActive(), false, 'D: periodo vencido -> OFF');
K._setTestState(null);
eq(K.isActive(), false, 'D: sin estado -> OFF (fail-closed intacto)');

/* detectores: cada hook fuerza refresh (rompe la caché de 60s) */
ok(html.includes("document.addEventListener('visibilitychange'"), 'detector: visibilitychange');
ok(html.includes("window.addEventListener('focus'"), 'detector: focus');
ok(html.includes("window.addEventListener('pageshow'"), 'detector: pageshow (vuelta del portal)');
ok(html.includes('10 * 60 * 1000'), 'detector: revalidación cada 10 minutos');
const revSeg = segment('function drexOrbitRevalidate', '\n/* ------');
ok(revSeg.includes('DrexOrbit.refresh(true)'), 'los detectores fuerzan refresh(true): la caché de 60s no retrasa la revocación');
ok(html.includes('DrexOrbit.restore()'), 'Restaurar = refresh forzado + re-aplicar puertas');
const gatesSeg = segment('window.drexOrbitApplyGates = (function () {', '\n})();');
ok(gatesSeg.includes('refreshOrbitProfileBadge()'), 'al cambiar el estado: insignia/marco se re-aplica');
ok(gatesSeg.includes('hydrateOrbitAvatarFrames(document)'), 'al cambiar el estado: marcos de posts se re-aplican');

/* copia honesta del OFF en vista Orbit y paywall */
ok(html.includes('verified && !DrexOrbit.verifiedActive()'), 'la vista Orbit tiene rama de beneficios desactivados');
ok(html.includes("t('Tus beneficios Orbit están desactivados')"), 'copia honesta: beneficios desactivados');
ok(segment('function openOrbitPaywall', 'function closeOrbitPaywall').includes('cancelAtPeriodEnd'), 'el paywall detecta la suscripción cancelada');
ok(segment('function openOrbitPaywall', 'function closeOrbitPaywall').includes("t('Reactivar suscripción')"), 'el paywall ofrece Reactivar');
ok(segment('function openOrbitPaywall', 'function closeOrbitPaywall').includes('orbitManage()'), 'Reactivar abre el portal de Stripe');

/* ================= i18n + 404 ================= */
console.log('-- i18n / 404 --');
const NEW_KEYS = ['Ahorras {n}%', 'Todo lo que incluye', 'Fotos y videos en HD', 'Sube tus fotos con menos compresión y más detalle.', 'Publicaciones más largas', 'Escribe publicaciones de hasta 2000 caracteres.', 'Publicaciones fijadas', 'Fija tus mejores publicaciones en la parte superior de tu perfil.', 'Quién vio tu perfil', 'Descubre quién visita tu perfil.', 'Mira quién entra a tu perfil', 'Solo tú puedes ver esta lista.', 'Aún nadie ha visitado tu perfil.', 'Cargando visitantes…', 'No pudimos cargar tus visitantes. Inténtalo de nuevo.', 'Inicia sesión para ver tus visitantes.', 'Subidas en HD activadas', 'Subidas en HD desactivadas', 'Alcanzaste el máximo de {n} publicaciones programadas.', 'Tus beneficios Orbit están desactivados', 'Tu suscripción sigue pagada hasta el {fecha}, pero cancelaste la renovación: los beneficios Orbit están desactivados desde ahora.', 'Tu suscripción sigue pagada, pero cancelaste la renovación: los beneficios Orbit están desactivados desde ahora.', 'Tu suscripción sigue pagada hasta el {fecha}, pero cancelaste la renovación.', 'Tu suscripción sigue pagada, pero cancelaste la renovación.', 'Tu último pago falló: los beneficios Orbit están desactivados hasta que actualices tu método de pago.', 'Tu suscripción venció: los beneficios Orbit están desactivados.', 'Reactivar suscripción'];
const dictSeg = (marker) => {
  const i = i18nJs.indexOf(marker);
  const j = i18nJs.indexOf('\n};', i);
  return i18nJs.slice(i, j);
};
const segs = { EN: dictSeg('var APP_ENGLISH_TEXT = {'), ZH: dictSeg('var APP_CHINESE_TEXT = {'), PT: dictSeg('var APP_PORTUGUESE_TEXT = {') };
for (const [lang, seg] of Object.entries(segs)) {
  for (const k of NEW_KEYS) ok(seg.includes(JSON.stringify(k) + ':'), lang + ' tiene ' + JSON.stringify(k));
}
ok(html404 === html, '404.html es copia byte-idéntica de index.html');

console.log('\nC243: ' + pass + ' ok, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('C243 test crashed:', e); process.exit(1); });
