#!/usr/bin/env node
/* =====================================================================
 * C244 — "Nuestra propia página" también para PAGAR + reorganización
 * de Ajustes:
 *  A) Pago embebido: hoja propia con Stripe Payment Element; ningún
 *     botón lleva ya al Checkout hospedado ni al portal de Stripe.
 *     DREX_STRIPE_PK vacía -> estado honesto "Pago no disponible".
 *  B) "Quién vio tu perfil" sale de Ajustes y vive en el perfil propio.
 *  C) Todo lo de dinero baja a UNA sección "Drex Orbit y pagos" en la
 *     mitad inferior de Ajustes; arriba queda la cuenta de siempre.
 *
 * Uso: node tests/test-c244-embedded-checkout-settings.js
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

function segment(from, to) {
  const i = html.indexOf(from);
  ok(i !== -1, 'segmento: ' + from.slice(0, 48));
  const j = to ? html.indexOf(to, i + from.length) : -1;
  return html.slice(i, j === -1 ? undefined : j);
}
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ================= A. Hoja de pago embebida ================= */
console.log('-- A: pago embebido (Payment Element) --');
ok(html.includes('id="orbit-checkout-sheet"'), 'hoja de pago propia presente');
ok(html.includes('id="orbit-checkout-element"'), 'contenedor del Payment Element');
ok(html.includes('id="orbit-checkout-confirm"'), 'botón de confirmación en la hoja');
ok(html.includes('id="orbit-checkout-summary"'), 'resumen del plan en la hoja');
ok(html.includes('id="orbit-manage-sheet"'), 'hoja de gestión propia presente');
ok(html.includes('id="orbit-manage-content"') && html.includes('id="orbit-manage-actions"'), 'gestión: contenido + acciones');
ok(/var DREX_STRIPE_PK = '(pk_(test|live)_[A-Za-z0-9]+)?';/.test(html), 'DREX_STRIPE_PK existe (vacía o clave pública válida; relleno en despliegue)'); // C244 deploy: la clave se inserta al desplegar
ok(html.includes('https://js.stripe.com/v3'), 'Stripe.js se carga desde el CDN oficial');
ok(html.includes('function drexLoadStripeJs('), 'carga perezosa de Stripe.js');

/* métodos DrexOrbit nuevos contra la Lambda */
for (const p of ['/subscribe-embedded', '/subscription-cancel', '/subscription-reactivate', '/subscription-setup']) {
  ok(html.includes("'" + p + "'"), 'DrexOrbit llama a ' + p);
}
ok(html.includes('subscribeEmbedded: async function'), 'método subscribeEmbedded');
ok(html.includes('subscriptionCancel: async function'), 'método subscriptionCancel');
ok(html.includes('subscriptionReactivate: async function'), 'método subscriptionReactivate');
ok(html.includes('subscriptionSetup: async function'), 'método subscriptionSetup');

/* confirmación dentro de la hoja, sin salir de Drex */
const c244seg = segment('/* ============ C244: pago embebido', '/* ---------- paywall ---------- */');
ok(c244seg.includes("elements.create('payment')"), 'se crea el Payment Element');
ok(c244seg.includes('confirmPayment'), 'se confirma con confirmPayment');
ok(c244seg.includes("redirect: 'if_required'"), 'confirmPayment NO redirige (if_required)');
ok(c244seg.includes('confirmSetup'), 'la tarjeta nueva se confirma con confirmSetup (Setup Element)');
ok(c244seg.includes('orbitCheckoutShowUnavailable'), 'existe el estado honesto de pago no disponible');
ok(c244seg.includes("t('Pago no disponible por ahora')"), 'copia honesta cuando el pago embebido no está activo');
ok(c244seg.includes('La gestión dentro de Drex aún no está disponible'), 'copia honesta si la Lambda no tiene gestión embebida');

/* los botones ya NO llegan al redirect: orbitSubscribe/orbitManage enrutados */
const subSeg = segment('function orbitSubscribe(', '\nasync function orbitManage');
ok(subSeg.includes('openOrbitCheckout('), 'orbitSubscribe abre la hoja embebida');
ok(!subSeg.includes('DrexOrbit.subscribe'), 'orbitSubscribe ya NO llama al Checkout hospedado');
const manSeg = segment('async function orbitManage()', '\nasync function orbitRestore');
ok(manSeg.includes('openOrbitManage('), 'orbitManage abre la hoja de gestión propia');
ok(!manSeg.includes('DrexOrbit.manage('), 'orbitManage ya NO llama al portal de Stripe');
eq((html.match(/onclick="[^"]*DrexOrbit\.(subscribe|manage)\(/g) || []).length, 0, 'ningún onclick llega a DrexOrbit.subscribe/manage');
ok(html.includes('window.location'), 'sanity: el resto de la app no se tocó');

/* exports para los onclick inline */
for (const fn of ['openOrbitCheckout', 'closeOrbitCheckout', 'orbitCheckoutConfirm', 'openOrbitManage', 'closeOrbitManage',
  'orbitManageAskCancel', 'orbitManageDoCancel', 'orbitManageBack', 'orbitReactivateSubscription',
  'orbitManageUpdateCard', 'orbitManageSaveCard', 'orbitManageRestore']) {
  ok(html.includes('window.' + fn + ' = ' + fn), 'export window.' + fn);
}

/* fail-closed intacto (no se debilitó nada de C241/C243) */
ok(html.includes("var ORBIT_FEATURES = ['no_ads', 'badge', 'profile_themes', 'fiesta_boost', 'limits', 'analytics', 'priority_support', 'hd_uploads', 'longer_posts', 'pin_post', 'profile_visitors'];"), 'ORBIT_FEATURES intacto (11)');
ok(segment('verifiedActive: function', 'isActive: function').includes('cancelAtPeriodEnd'), 'verifiedActive sigue apagando beneficios al cancelar');

/* ================= B. Visitantes fuera de Ajustes ================= */
console.log('-- B: quién vio tu perfil en el perfil propio --');
ok(!html.includes('id="visitantes-settings-card"'), 'la entrada de visitantes YA NO está en Ajustes');
ok(html.includes('id="profile-visitors-entry"'), 'la entrada vive en el perfil propio');
ok(html.includes('id="profile-visitors-entry" onclick="openOrbitVisitors()"'), 'toca y abre la hoja (la puerta profile_visitors decide)');
ok(html.includes('function renderOrbitVisitorsEntryPreview('), 'el preview se actualiza sobre la entrada del perfil');
ok(!html.includes('renderOrbitVisitorsSettingsPreview'), 'ya no queda el preview de Ajustes');

/* ================= C. Ajustes reorganizado ================= */
console.log('-- C: sección de dinero en la mitad inferior --');
const iSearch = html.indexOf('id="settings-search-input"');
const iCuenta = html.indexOf('>Cuenta<', iSearch);
const iBienestar = html.indexOf('>Bienestar<', iSearch);
const iHeading = html.indexOf('id="orbit-pagos-settings-heading"');
const iOrbitCard = html.indexOf('id="orbit-settings-card"');
const iPagosCard = html.indexOf('id="pagos-settings-card"');
const iSesion = html.indexOf('>Sesión<', iSearch);
ok(iSearch !== -1 && iCuenta !== -1 && iHeading !== -1, 'marcas de Ajustes localizables');
ok(iCuenta < iHeading, 'la sección de dinero va DEBAJO de Cuenta');
ok(iBienestar !== -1 && iBienestar < iOrbitCard, 'las tarjetas de dinero están en la mitad inferior (bajo Bienestar)');
ok(iHeading < iOrbitCard && iHeading < iPagosCard, 'ambas tarjetas cuelgan de la sección "Drex Orbit y pagos"');
ok(iOrbitCard < iSesion && iPagosCard < iSesion, 'la sección queda antes de Sesión (mitad inferior)');
ok(!html.slice(iSearch, iCuenta).includes('orbit-settings-card') && !html.slice(iSearch, iCuenta).includes('pagos-settings-card'),
  'nada de pagos estorba arriba de Ajustes');
ok(html.includes('id="orbit-settings-preview"') && html.includes('id="pagos-settings-title"') && html.includes('id="pagos-settings-preview"'),
  'los ids que pintan los previews se conservan');
ok(html.includes('id="orbit-settings-card" onclick="openOrbitView()"'), 'tarjeta Orbit -> openOrbitView() intacto');
ok(html.includes('id="pagos-settings-card" onclick="openPaymentsView()"'), 'tarjeta Pagos -> openPaymentsView() intacto');

/* ================= i18n + 404 ================= */
console.log('-- i18n C244 + identidad 404 --');
const KEYS = [
  'Drex Orbit y pagos', 'Suscribirme a Drex Orbit', 'Pago no disponible por ahora',
  'Se renueva automáticamente. Cancela cuando quieras.', 'Cargando pago seguro…',
  'No se pudo completar el pago. Revisa los datos e inténtalo de nuevo.',
  'Ya tienes Drex Orbit activo.', 'Ver mi suscripción', '¿Cancelar tu suscripción?',
  'Sí, cancelar', 'Suscripción cancelada', 'Guardar tarjeta', 'Método de pago actualizado',
  'Suscríbete para desbloquear todo Drex Orbit.'
];
for (const k of KEYS) {
  const n = (i18nJs.match(new RegExp(escRe('"' + k + '"'), 'g')) || []).length;
  ok(n >= 3, 'i18n x3 (EN/ZH/PT): ' + k);
}
eq(html404, html, '404.html byte-idéntico a index.html');

/* ============ vm: comportamiento real de las hojas ============ */
function makeEl(id) {
  const el = {
    id, innerHTML: '', textContent: '', disabled: false, value: '',
    _classes: new Set(),
    classList: {
      add(...cs) { cs.forEach((c) => el._classes.add(c)); },
      remove(...cs) { cs.forEach((c) => el._classes.delete(c)); },
      toggle(c, force) { const on = force === undefined ? !el._classes.has(c) : !!force; on ? el._classes.add(c) : el._classes.delete(c); return on; },
      contains(c) { return el._classes.has(c); },
    },
    style: {}, dataset: {}, parentElement: null,
    appendChild() {}, addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
  return el;
}
(async () => {
  console.log('-- vm: comportamiento de las hojas C244 --');
  const els = {};
  const FUTURE = Math.floor(Date.now() / 1000) + 2592000;
  const activeSt = { active: true, plan: 'monthly', currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false, status: 'active' };
  const calls = { cancel: 0, reactivate: 0, setupSecret: 0, confirmPayment: null, confirmSetup: null, mounted: null };
  const toasts = [];
  const sandbox = {
    console, Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set,
    setTimeout: (fn) => { try { fn(); } catch (_) {} return 0; }, clearTimeout: () => {},
    addEventListener() {},
    location: { origin: 'https://app.test', pathname: '/Beabo/', href: 'https://app.test/Beabo/' },
    navigator: { userAgent: 'test' },
    DREX_STRIPE_PK: '',
    ORBIT_PLANS: {
      monthly: { price: '$4.99', cents: 499, per: 'mes', stripeInterval: 'month', stripeIntervalCount: 1, mode: 'recurring' },
      yearly: { price: '$49.99', cents: 4999, per: 'año', stripeInterval: 'year', stripeIntervalCount: 1, mode: 'recurring' },
    },
    orbitPlanAvailable: (id) => ['monthly', 'quarterly', 'semiannual', 'yearly'].indexOf(id) !== -1,
    orbitPlanName: (id) => (id === 'yearly' ? 'Anual' : 'Mensual'),
    orbitPlanPrice: (id) => (id === 'yearly' ? '$49.99 al año' : '$4.99 al mes'),
    orbitPlanMonthlyPrice: () => '$4.17',
    orbitPlanSavingsPct: (id) => (id === 'yearly' ? 17 : 0),
    drexTxSubStatus: (sub) => (!sub || !sub.active ? 'Sin suscripción' : (sub.cancelAtPeriodEnd ? 'Cancelada' : 'Activa')),
    orbitFmtDate: () => '2 de noviembre de 2026',
    orbitIconSVG: () => '<svg></svg>',
    t: (s) => s,
    escapeHtml: (s) => String(s == null ? '' : s),
    orbitToast: (m) => { toasts.push(String(m)); },
    renderOrbitView: () => {}, renderPaymentsView: () => {},
    DrexOrbit: {
      _idToken: async () => 'tok-test',
      subscribeEmbedded: async () => ({ subscriptionId: 'sub_x', clientSecret: 'cs_test_secret' }),
      subscriptionCancel: async () => { calls.cancel++; return { ok: true, cancelAtPeriodEnd: true }; },
      subscriptionReactivate: async () => { calls.reactivate++; return { ok: true, cancelAtPeriodEnd: false }; },
      subscriptionSetup: async (f) => { if (f && f.paymentMethodId) return { ok: true, updated: true }; calls.setupSecret++; return { clientSecret: 'seti_test_secret' }; },
      refresh: async () => activeSt,
      status: () => activeSt,
      restore: async () => activeSt,
      verifiedActive: () => !activeSt.cancelAtPeriodEnd,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = {
    readyState: 'complete',
    getElementById: (id) => { if (!els[id]) { els[id] = makeEl(id); els[id].parentElement = sandbox.document.body; } return els[id]; },
    createElement: () => makeEl('dyn'),
    querySelector() { return null; }, querySelectorAll() { return []; },
    body: makeEl('body'), head: makeEl('head'), documentElement: makeEl('html'),
  };
  vm.createContext(sandbox);
  vm.runInContext(c244segCode(), sandbox);

  function c244segCode() {
    const i = html.indexOf('/* ============ C244: pago embebido');
    const j = html.indexOf('/* ---------- paywall ---------- */', i);
    return html.slice(i, j);
  }

  /* 1) Sin clave publicable: estado honesto, nada de redirects. */
  await sandbox.openOrbitCheckout('monthly');
  ok(els['orbit-checkout-element'].innerHTML.includes('Pago no disponible por ahora'), 'vm: PK vacía -> "Pago no disponible por ahora"');
  ok(els['orbit-checkout-confirm'].classList.contains('hidden'), 'vm: PK vacía -> botón de pago oculto');
  ok(els['orbit-checkout-summary'].innerHTML.includes('Mensual'), 'vm: el resumen muestra el plan elegido');

  /* 2) Con clave + Stripe falso: monta y confirma SIN redirect. */
  sandbox.DREX_STRIPE_PK = 'pk_test_fake';
  sandbox.window.Stripe = function () {
    return {
      elements: (opts) => {
        calls.elementsOpts = opts;
        return {
          create: (type) => ({ mount: (el) => { calls.mounted = type; } }),
          submit: async () => ({}),
        };
      },
      confirmPayment: async (args) => { calls.confirmPayment = args; return { paymentIntent: { status: 'succeeded' } }; },
      confirmSetup: async (args) => { calls.confirmSetup = args; return { setupIntent: { payment_method: 'pm_new_1' } }; },
    };
  };
  await sandbox.openOrbitCheckout('yearly');
  eq(calls.elementsOpts && calls.elementsOpts.clientSecret, 'cs_test_secret', 'vm: Elements nace del clientSecret del backend');
  eq(calls.mounted, 'payment', 'vm: Payment Element montado en la hoja');
  eq(els['orbit-checkout-confirm'].disabled, false, 'vm: confirmar habilitado tras montar');
  await sandbox.orbitCheckoutConfirm();
  eq(calls.confirmPayment && calls.confirmPayment.redirect, 'if_required', 'vm: confirmPayment sin redirect');
  ok(toasts.some((m) => m.includes('Bienvenido a Drex Orbit')), 'vm: éxito dentro de la app (toast de bienvenida)');
  ok(els['orbit-checkout-sheet'].classList.contains('hidden'), 'vm: la hoja se cierra tras pagar');

  /* 3) orbitSubscribe enruta a la hoja (no al Checkout hospedado). */
  const subSrc = segment('function orbitSubscribe(', '\nasync function orbitManage');
  vm.runInContext(subSrc, sandbox);
  els['orbit-checkout-summary'].innerHTML = '';
  await sandbox.orbitSubscribe('monthly');
  await new Promise((r) => setTimeout(r, 10));
  ok(els['orbit-checkout-summary'].innerHTML.includes('Mensual'), 'vm: orbitSubscribe abre la hoja embebida con el plan');

  /* 4) Gestión: cancelar pide confirmación y llama al endpoint propio. */
  await sandbox.openOrbitManage();
  ok(els['orbit-manage-content'].innerHTML.includes('Activa'), 'vm: gestión muestra la suscripción activa');
  ok(els['orbit-manage-actions'].innerHTML.includes('Cancelar suscripción'), 'vm: botón Cancelar en la hoja');
  ok(els['orbit-manage-actions'].innerHTML.includes('Actualizar método de pago'), 'vm: botón Actualizar método de pago');
  sandbox.orbitManageAskCancel();
  ok(els['orbit-manage-actions'].innerHTML.includes('Sí, cancelar'), 'vm: cancelar pide confirmación explícita');
  activeSt.cancelAtPeriodEnd = true;
  sandbox.DrexOrbit.refresh = async () => activeSt;
  await sandbox.orbitManageDoCancel();
  eq(calls.cancel, 1, 'vm: cancelar llama a /subscription-cancel (endpoint propio)');
  ok(els['orbit-manage-actions'].innerHTML.includes('Reactivar suscripción'), 'vm: tras cancelar, la hoja ofrece Reactivar');
  ok(toasts.some((m) => m.includes('Suscripción cancelada')), 'vm: toast de cancelación');

  /* 5) Cambiar tarjeta: Setup Element dentro de la misma hoja. */
  activeSt.cancelAtPeriodEnd = false;
  await sandbox.orbitManageUpdateCard();
  eq(calls.setupSecret, 1, 'vm: /subscription-setup crea el SetupIntent');
  ok(!els['orbit-manage-element'].classList.contains('hidden'), 'vm: el Setup Element se ve en la hoja');
  await sandbox.orbitManageSaveCard();
  ok(calls.confirmSetup && calls.confirmSetup.redirect === 'if_required', 'vm: confirmSetup sin redirect');
  ok(toasts.some((m) => m.includes('Método de pago actualizado')), 'vm: tarjeta guardada sin salir de Drex');

  console.log('\nC244: ' + pass + ' ok, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR vm:', e && e.message); process.exit(1); });
