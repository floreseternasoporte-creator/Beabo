#!/usr/bin/env node
/* Drex Orbit — disponibilidad de planes (carril 3, 2026-10-01).
 * Regresión del error "Error al iniciar el pago. Inténtalo de nuevo.":
 * el cliente ofrecía "Suscribirme" para planes que la Lambda drex-payments
 * no conoce (400 invalid_plan).
 * Verifica:
 *  1. ORBIT_BACKEND_PLANS = los planes que el backend acepta hoy
 *     (monthly/quarterly/semiannual/yearly); weekly/biennial/lifetime
 *     quedan fuera.
 *  2. Las tarjetas de planes sin precio se renderizan deshabilitadas:
 *     data-plan-id + clase plan-coming-soon + data-unavailable="true",
 *     SIN botón orbitSubscribe y con la etiqueta i18n orbit_coming_soon.
 *  3. orbitSubscribe rechaza planes no disponibles SIN tocar la red.
 *  4. Toasts específicos: red/timeout, servidor, plan no disponible,
 *     no-token (sin genérico donde hay causa conocida).
 *  5. Paridad i18n de las 4 claves nuevas en ES/EN/ZH/PT.
 *  6. "Desde" del paywall = precio más barato disponible ($4.99). */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = process.env.ORBIT_TEST_ROOT || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('  FAIL:', name); }
}

const mCore = html.match(/\/\* =+\n \* DREX ORBIT — suscripción Orbit de Drex[\s\S]*?window\.DREX_ORBIT_ENFORCE = false;/);
ok(!!mCore, 'bloque core DrexOrbit presente');
const mUI = html.match(/\/\* =+ Drex Orbit: vista, paywall, temas, analíticas[\s\S]*?\nasync function orbitManage\(\)/);
ok(!!mUI, 'bloque UI DrexOrbit presente (extendido hasta orbitSubscribe)');
const UI_SRC = mUI[0].replace(/\nasync function orbitManage\(\)\s*$/, '');

/* DOM mínimo: captura el innerHTML de la vista Orbit. */
let capturedHtml = '';
const viewEl = {};
Object.defineProperty(viewEl, 'innerHTML', {
  set(v) { capturedHtml = String(v); },
  get() { return capturedHtml; },
});

const toasts = [];
let fetchCalls = 0;
let fetchImpl = async () => { throw new Error('no-network-in-test'); };

const sandbox = {
  console,
  /* setTimeout inmediato: los backoff del _post no cuelgan el test. */
  setTimeout: (fn) => { try { fn(); } catch (_) {} return 0; },
  clearTimeout: () => {},
  localStorage: { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
  location: { origin: 'https://x.test', pathname: '/Beabo/', href: 'https://x.test/Beabo/', search: '' },
  document: {
    readyState: 'complete', addEventListener() {},
    getElementById(id) { return id === 'orbit-view-content' ? viewEl : null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
  },
  window: {},
  fetch: async (url, init) => { fetchCalls++; return fetchImpl(url, init); },
  toast: (m) => { toasts.push(String(m)); },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
sandbox.t = (s) => s; // identidad: se prueban las claves ES
sandbox.orbitIconSVG = () => ''; // definido fuera del bloque extraído
sandbox.renderOrbitThemesRow = async () => {}; // idem: sección de temas
sandbox.orbitToast = (m) => { sandbox.toast(m); }; // definido después del core
sandbox.DREX_PAYMENTS_ENDPOINT = 'https://x.test/'; // declarado antes del core
sandbox.escapeHtml = (s) => String(s == null ? '' : s);
sandbox.DrexCloud = { auth: () => ({ currentUser: null }) }; // sin getIdToken -> no-token
vm.runInContext(mCore[0], sandbox);
vm.runInContext(UI_SRC, sandbox);

const BACKEND = sandbox.ORBIT_BACKEND_PLANS;
const avail = sandbox.orbitPlanAvailable;

/* ---- 1. Catálogo de disponibilidad del backend ---- */
ok(Array.isArray(BACKEND), 'ORBIT_BACKEND_PLANS definido');
const sorted = (BACKEND || []).slice().sort().join(',');
ok(sorted === ['monthly', 'quarterly', 'semiannual', 'yearly'].sort().join(','),
   'ORBIT_BACKEND_PLANS = monthly/quarterly/semiannual/yearly (verificado contra la Lambda real)');
ok(typeof avail === 'function', 'orbitPlanAvailable definido');
for (const id of ['monthly', 'quarterly', 'semiannual', 'yearly']) ok(avail(id) === true, id + ' disponible');
for (const id of ['weekly', 'biennial', 'lifetime']) ok(avail(id) === false, id + ' NO disponible (sin precio en backend)');

/* ---- 2. Tarjetas: planes sin precio -> deshabilitadas ---- */
(async () => {
  await sandbox.renderOrbitView();
  ok(capturedHtml.length > 500, 'renderOrbitView pinta la vista');
  const starts = [];
  const re = /<div class="orbit-plan-card/g;
  let m;
  while ((m = re.exec(capturedHtml)) !== null) starts.push(m.index);
  ok(starts.length === 7, 'se renderizan las 7 tarjetas de la escalera');
  const cardFor = (id) => {
    const i = starts.findIndex((s) => capturedHtml.slice(s, s + 300).includes('data-plan-id="' + id + '"'));
    return i === -1 ? '' : capturedHtml.slice(starts[i], starts[i + 1] || capturedHtml.length);
  };
  const UNAVAIL = ['weekly', 'biennial', 'lifetime'];
  const AVAIL = ['monthly', 'quarterly', 'semiannual', 'yearly'];
  for (const id of UNAVAIL) {
    const c = cardFor(id);
    ok(c.includes('data-plan-id="' + id + '"'), id + ': tarjeta lleva data-plan-id');
    ok(c.includes('plan-coming-soon'), id + ': tarjeta lleva clase plan-coming-soon');
    ok(c.includes('data-unavailable="true"'), id + ': tarjeta lleva data-unavailable="true"');
    ok(!c.includes("orbitSubscribe('" + id + "')"), id + ': SIN botón Suscribirme');
    ok(c.includes('Próximamente'), id + ': muestra la etiqueta orbit_coming_soon');
    /* C243-A: tampoco seleccionable. */
    ok(!c.includes("orbitSelectPlan('" + id + "')"), id + ': NO seleccionable (C243)');
    ok(!c.includes('role="radio"'), id + ': sin role=radio (C243)');
  }
  for (const id of AVAIL) {
    const c = cardFor(id);
    ok(c.includes('data-plan-id="' + id + '"'), id + ': tarjeta lleva data-plan-id');
    ok(!c.includes('plan-coming-soon'), id + ': tarjeta NO marcada coming-soon');
    ok(!c.includes('data-unavailable="true"'), id + ': tarjeta NO marcada unavailable');
    /* C243-A: la tarjeta se selecciona; un solo CTA cobra (Meta). */
    ok(c.includes("orbitSelectPlan('" + id + "')"), id + ': tocarla selecciona el plan');
    ok(c.includes('role="radio"'), id + ': tarjeta role=radio');
    ok(!c.includes("orbitSubscribe('" + id + "')"), id + ': la tarjeta no cobra por su cuenta');
  }
  /* C243-A: un único botón de suscripción bajo el selector. */
  {
    const ctas = html.match(/id="orbit-subscribe-cta"/g) || [];
    ok(ctas.length === 1, 'exactamente un boton de suscripcion, hay ' + ctas.length);
    ok(html.includes('onclick="orbitSubscribeSelected()"'), 'el CTA cobra el plan seleccionado');
    ok(capturedHtml.includes('id="orbit-subscribe-cta"'), 'el CTA se renderiza en la vista');
    ok(capturedHtml.includes('$49.99'), 'el CTA muestra el precio del recomendado por defecto (Anual $49.99)');
  }
  ok(sandbox.orbitCheapestAvailablePrice() === '$4.99', '"Desde" del paywall = $4.99 (weekly en Próximamente no cuenta)');

  /* ---- 3. orbitSubscribe: planes no disponibles no tocan la red ---- */
  const tokenAuth = { auth: () => ({ getIdToken: async () => 'tok-test' }) };
  sandbox.DrexCloud = tokenAuth;
  fetchCalls = 0; toasts.length = 0;
  await sandbox.orbitSubscribe('biennial');
  ok(fetchCalls === 0, 'biennial: orbitSubscribe no hace fetch');
  ok(toasts[0] === 'Este plan aún no está disponible. Estará listo muy pronto.',
     'biennial: toast específico de plan no disponible');
  toasts.length = 0;
  await sandbox.orbitSubscribe('lifetime');
  ok(fetchCalls === 0, 'lifetime: orbitSubscribe no hace fetch');
  ok(toasts[0] === 'Este plan aún no está disponible. Estará listo muy pronto.',
     'lifetime: toast específico de plan no disponible');
  toasts.length = 0;
  await sandbox.orbitSubscribe('weekly');
  ok(fetchCalls === 0, 'weekly: orbitSubscribe no hace fetch');

  /* ---- 4. Toasts específicos por tipo de fallo ---- */
  const withFetch = async (impl, plan) => {
    fetchImpl = impl; fetchCalls = 0; toasts.length = 0;
    await sandbox.orbitSubscribe(plan);
    return toasts[toasts.length - 1]; // el último: antes va 'Procesando…'
  };
  let msg = await withFetch(async () => { throw new Error('boom'); }, 'monthly');
  ok(toasts.includes('Revisando tu conexión…'),
     'fallo de red -> aviso de diagnóstico (no genérico)');
  await new Promise((r) => setImmediate(r));
  msg = toasts[toasts.length - 1];
  ok(/^No pudimos contactar el servidor de pagos\. \[.*\] Mándanos captura de este mensaje/.test(msg),
     'fallo de red -> toast con diagnóstico (App/Internet/Pagos)');
  const abortErr = new Error('aborted'); abortErr.name = 'AbortError';
  msg = await withFetch(async () => { throw abortErr; }, 'monthly');
  ok(toasts.includes('Revisando tu conexión…'),
     'timeout -> aviso de diagnóstico (no genérico)');
  await new Promise((r) => setImmediate(r));
  msg = toasts[toasts.length - 1];
  ok(/^No pudimos contactar el servidor de pagos\. \[.*\] Mándanos captura de este mensaje/.test(msg),
     'timeout -> toast con diagnóstico (App/Internet/Pagos)');
  msg = await withFetch(async () => ({ ok: false, status: 502, json: async () => ({ error: 'payment_provider_error' }) }), 'monthly');
  ok(msg === 'El servidor de pagos falló. Inténtalo de nuevo en unos minutos.',
     '502 del backend -> toast de servidor (no genérico)');
  msg = await withFetch(async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_plan' }) }), 'monthly');
  ok(msg === 'Este plan aún no está disponible. Estará listo muy pronto.',
     'invalid_plan del backend -> toast de plan no disponible');
  msg = await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ url: 'https://checkout.stripe.test/x' }) }), 'monthly');
  ok(sandbox.location.href === 'https://checkout.stripe.test/x', 'checkout OK redirige a la URL de Stripe');
  /* no-token (sin sesión): */
  sandbox.DrexCloud = { auth: () => ({ currentUser: null }) };
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
  fetchCalls = 0; toasts.length = 0;
  await sandbox.orbitSubscribe('monthly');
  ok(toasts[toasts.length - 1] === 'Inicia sesión para suscribirte a Drex Orbit.', 'sin token -> toast de iniciar sesión');
  ok(fetchCalls === 0, 'sin token: no se hace fetch');

  /* ---- 5. Paridad i18n ES/EN/ZH/PT ---- */
  const NEW_KEYS = [
    ['orbit_coming_soon', 'Coming soon', '即将推出', 'Em breve'],
    ['Este plan aún no está disponible. Estará listo muy pronto.',
     "This plan isn't available yet. It'll be ready very soon.",
     '此方案暂不可用，很快就会上线。', 'Este plano ainda não está disponível. Estará pronto em breve.'],
    ['No pudimos contactar el servidor de pagos.',
     "We couldn't reach the payment server.",
     '无法连接到支付服务器。', 'Não conseguimos alcançar o servidor de pagamentos.'],
    ['El servidor de pagos falló. Inténtalo de nuevo en unos minutos.',
     'The payment server failed. Try again in a few minutes.',
     '支付服务器出错，请几分钟后再试。', 'O servidor de pagamentos falhou. Tente de novo em alguns minutos.'],
  ];
  for (const [es, en, zh, pt] of NEW_KEYS) {
    const q = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    ok(new RegExp('"' + q(es) + '":"' + q(en) + '"').test(i18n), 'EN: ' + es.slice(0, 30) + '…');
    ok(new RegExp('"' + q(es) + '":"' + q(zh) + '"').test(i18n), 'ZH: ' + es.slice(0, 30) + '…');
    ok(new RegExp('"' + q(es) + '":"' + q(pt) + '"').test(i18n), 'PT: ' + es.slice(0, 30) + '…');
  }
  /* ES: el helper devuelve el literal en español; en otros idiomas usa la clave. */
  delete sandbox.getAppLanguage;
  ok(sandbox.orbitComingSoonLabel() === 'Próximamente', "orbit_coming_soon en ES = 'Próximamente'");
  sandbox.getAppLanguage = () => 'en';
  ok(sandbox.orbitComingSoonLabel() === 'orbit_coming_soon', 'orbit_coming_soon en EN resuelve la clave (t identidad)');
  sandbox.getAppLanguage = () => 'pt';
  ok(sandbox.orbitComingSoonLabel() === 'orbit_coming_soon', 'orbit_coming_soon en PT resuelve la clave (t identidad)');

  console.log(`\nRESULTADO: ${pass} ok, ${fail} fallos`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR en test:', e); process.exit(2); });
