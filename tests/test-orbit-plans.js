#!/usr/bin/env node
/* Drex Orbit — escalera de planes: test de regresión del catálogo.
 * Verifica: los 7 planes existen con precios > 0, los 4 planes históricos
 * siguen presentes con sus precios, intervalos coherentes (Stripe),
 * exactamente un plan de pago único ('lifetime'), la UI renderiza la
 * escalera completa, paridad i18n de las claves nuevas, y que el frontend
 * no contiene price IDs de Stripe (viven en la Lambda). */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = process.env.ORBIT_TEST_ROOT || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('  FAIL:', name); }
}

const EXPECTED_IDS = ['weekly', 'monthly', 'quarterly', 'semiannual', 'yearly', 'biennial', 'lifetime'];
const EXPECTED_CENTS = {
  weekly: 199, monthly: 499, quarterly: 1299, semiannual: 2499,
  yearly: 4999, biennial: 8999, lifetime: 14999,
};
/* Coste mensual equivalente esperado (centavos), calculado contra el ciclo. */
const EXPECTED_MONTHLY_CENTS = {
  weekly: 862, monthly: 499, quarterly: 433, semiannual: 417,
  yearly: 417, biennial: 375, lifetime: null,
};

/* ---- 1. Extrae core + UI y ejecútalos en sandbox (igual que test-drex-orbit-frontend) ---- */
const mCore = html.match(/\/\* =+\n \* DREX ORBIT — suscripción Orbit de Drex[\s\S]*?window\.DREX_ORBIT_ENFORCE = false;/);
ok(!!mCore, 'bloque core DrexOrbit presente');
const mUI = html.match(/\/\* =+ Drex Orbit: vista, paywall, temas, analíticas[\s\S]*?else __orbitPrevBoot\(\);\n\} catch \(\_\) \{\}/);
ok(!!mUI, 'bloque UI DrexOrbit presente');

const sandbox = {
  console, setTimeout: () => 0, clearTimeout: () => {},
  localStorage: { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
  location: { origin: 'https://x.test', pathname: '/Beabo/', href: 'https://x.test/Beabo/', search: '' },
  document: { readyState: 'complete', addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } },
  window: {},
  fetch: async () => { throw new Error('no-network-in-test'); },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
sandbox.t = (s) => s; // identidad: el test de formato usa las claves ES
sandbox.DrexCloud = { auth: () => ({ currentUser: null }) };
vm.runInContext(mCore[0], sandbox);
vm.runInContext(mUI[0], sandbox);

const PLANS = sandbox.ORBIT_PLANS;
const IDS = sandbox.ORBIT_PLAN_IDS;
const LADDER = sandbox.ORBIT_LADDER;
ok(PLANS && typeof PLANS === 'object', 'ORBIT_PLANS definido');

/* ---- 2. Los 7 planes esperados, ni más ni menos ---- */
ok(Array.isArray(IDS) && IDS.length === EXPECTED_IDS.length &&
   EXPECTED_IDS.every((id) => IDS.indexOf(id) !== -1), 'ORBIT_PLAN_IDS = los 7 planes');
for (const id of EXPECTED_IDS) ok(PLANS[id], 'plan presente en catálogo: ' + id);

/* ---- 3. Planes históricos intactos (no romper lo existente) ---- */
for (const [id, cents] of Object.entries({ monthly: 499, quarterly: 1299, semiannual: 2499, yearly: 4999 })) {
  ok(PLANS[id] && PLANS[id].cents === cents, 'plan histórico intacto: ' + id + ' $' + (cents / 100).toFixed(2));
}
ok(html.includes('$4.99'), 'precio mensual $4.99 visible');
ok(html.includes('$49.99'), 'precio anual $49.99 visible');

/* ---- 4. Todo precio > 0 y coherente ---- */
for (const id of EXPECTED_IDS) {
  const p = PLANS[id];
  ok(typeof p.cents === 'number' && p.cents > 0, id + ': cents > 0');
  ok(p.price === '$' + (p.cents / 100).toFixed(2), id + ': price coincide con cents (' + p.price + ')');
  ok(p.id === id, id + ': id coincide con la clave');
  ok(p.mode === 'recurring' || p.mode === 'one_time', id + ': mode válido');
  ok(typeof p.per === 'string' && p.per.length > 0, id + ': per definido');
}

/* ---- 5. Exactamente un plan de pago único: lifetime ---- */
const oneTime = EXPECTED_IDS.filter((id) => PLANS[id].mode === 'one_time');
ok(oneTime.length === 1 && oneTime[0] === 'lifetime', 'único one_time = lifetime');
ok(PLANS.lifetime.cents === 14999 && PLANS.lifetime.price === '$149.99', 'lifetime $149.99');

/* ---- 6. Intervalos Stripe coherentes (lo que la Lambda debe cablear) ---- */
const INTERVALS = { week: 1, month: 1, year: 1 };
for (const id of EXPECTED_IDS) {
  const p = PLANS[id];
  if (p.mode === 'one_time') {
    ok(!p.stripeInterval, id + ': one_time sin intervalo Stripe');
    continue;
  }
  ok(INTERVALS[p.stripeInterval] === 1, id + ': stripeInterval válido (' + p.stripeInterval + ')');
  ok(Number.isInteger(p.stripeIntervalCount) && p.stripeIntervalCount >= 1, id + ': stripeIntervalCount >= 1');
}
ok(PLANS.weekly.stripeInterval === 'week' && PLANS.weekly.stripeIntervalCount === 1, 'weekly: week x1');
ok(PLANS.quarterly.stripeInterval === 'month' && PLANS.quarterly.stripeIntervalCount === 3, 'quarterly: month x3');
ok(PLANS.semiannual.stripeInterval === 'month' && PLANS.semiannual.stripeIntervalCount === 6, 'semiannual: month x6');
ok(PLANS.biennial.stripeInterval === 'year' && PLANS.biennial.stripeIntervalCount === 2, 'biennial: year x2 (recurrente cada 2 años)');
ok(PLANS.yearly.stripeInterval === 'year' && PLANS.yearly.stripeIntervalCount === 1, 'yearly: year x1');

/* ---- 7. Coste mensual equivalente ---- */
for (const id of EXPECTED_IDS) {
  ok(sandbox.orbitPlanMonthlyCents(id) === EXPECTED_MONTHLY_CENTS[id], id + ': mensual equiv ' + EXPECTED_MONTHLY_CENTS[id]);
}

/* ---- 8. Escalera ordenada por precio ascendente ---- */
ok(Array.isArray(LADDER) && LADDER.length === EXPECTED_IDS.length &&
   EXPECTED_IDS.every((id) => LADDER.indexOf(id) !== -1), 'ORBIT_LADDER contiene los 7 planes');
let asc = true;
for (let i = 1; i < LADDER.length; i++) {
  if (!(PLANS[LADDER[i]].cents > PLANS[LADDER[i - 1]].cents)) asc = false;
}
ok(asc, 'escalera en precio ascendente');
ok(sandbox.ORBIT_RECOMMENDED_PLAN === 'yearly' && PLANS[sandbox.ORBIT_RECOMMENDED_PLAN], 'plan recomendado = yearly (existe)');

/* ---- 9. Nombres/precios/badges para los 7 (sin lanzar) ---- */
for (const id of EXPECTED_IDS) {
  let nm = '', pr = '';
  try { nm = sandbox.orbitPlanName(id); pr = sandbox.orbitPlanPrice(id); } catch (e) { nm = ''; pr = ''; }
  ok(typeof nm === 'string' && nm.length > 0, id + ': orbitPlanName no vacío');
  ok(typeof pr === 'string' && pr.indexOf(PLANS[id].price) === 0, id + ': orbitPlanPrice empieza con el precio');
}
ok(sandbox.orbitPlanPrice('lifetime').indexOf('pago único') !== -1, 'lifetime: precio "pago único"');
ok(sandbox.orbitPlanPrice('biennial').indexOf('2 años') !== -1, 'biennial: precio "cada 2 años"');
ok(sandbox.orbitPlanBadge('yearly') === 'Ahorra 2 meses', 'yearly conserva insignia "Ahorra 2 meses"');
ok(typeof sandbox.orbitPlanBadge('lifetime') === 'string', 'lifetime tiene insignia');

/* ---- 10. La UI renderiza la escalera completa (no solo mensual/anual) ---- */
ok(html.includes('ORBIT_LADDER'), 'renderOrbitView itera ORBIT_LADDER');
ok(!html.includes("card('monthly', false) + card('yearly', true)"), 'sin tarjetas hardcodeadas solo mensual/anual');
ok(html.includes("t('Recomendado')"), 'insignia "Recomendado" en la UI');
ok(html.includes("t('Comprar')"), 'botón "Comprar" para pago único');

/* ---- 11. La suscripción embebida manda {plan} a /subscribe-embedded ---- */
/* C247 (2026-10-03): el redirect LEGADO (DrexOrbit.subscribe ->
 * /create-subscription-session con returnUrl) se eliminó; el contrato
 * vivo es subscribeEmbedded (C244): {plan} a /subscribe-embedded. */
ok(mCore[0].includes("this._postData('/subscribe-embedded', { plan: planId })"),
   'subscribeEmbedded envía {plan} a /subscribe-embedded (sin redirect)');
ok(!mCore[0].includes('/create-subscription-session') && !mCore[0].includes('/create-customer-portal'),
   'C247 (2026-10-03): el core ya no conoce los endpoints LEGADO de redirect');
ok(!mCore[0].includes('subscribe: async function') && !mCore[0].includes('manage: async function'),
   'C247 (2026-10-03): DrexOrbit.subscribe/manage eliminados');
ok(!html.includes('STRIPE_PRICE_'), 'sin price IDs de Stripe en el frontend');

/* ---- 12. Fail-closed con los planes nuevos ---- */
const K = sandbox.DrexOrbit;
K._setTestState({ active: true, plan: 'lifetime', status: 'active' });
ok(K.plan() === 'lifetime', 'plan lifetime reconocido del backend');
K._setTestState({ active: true, plan: 'weekly', status: 'active' });
ok(K.plan() === 'weekly', 'plan weekly reconocido del backend');
K._setTestState({ active: true, plan: 'plan_inexistente', status: 'active' });
ok(K.plan() === null, 'fail-closed: plan desconocido -> null');

async function main() {
  /* C247 (2026-10-03): DrexOrbit.subscribe/manage (redirect LEGADO) ya no
   * existen; el contrato vivo es subscribeEmbedded (C244): valida el plan,
   * postea {plan} a /subscribe-embedded y devuelve el clientSecret SIN
   * salir de Drex (cero redirects, cero returnUrl). */
  ok(typeof K.subscribe === 'undefined' && typeof K.manage === 'undefined',
     'C247 (2026-10-03): DrexOrbit.subscribe/manage eliminados (métodos LEGADO fuera)');
  /* subscribeEmbedded con plan inválido rechaza sin tocar la red */
  let threw = false;
  try { await K.subscribeEmbedded('plan_inexistente'); } catch (e) { threw = String(e && e.message) === 'invalid_plan'; }
  ok(threw, 'subscribeEmbedded(plan inválido) -> invalid_plan (fail fast)');
  /* plan válido de la escalera llega a la Lambda embebida (red simulada) */
  sandbox.DREX_PAYMENTS_ENDPOINT = 'https://pay.test';
  let postedBody = null;
  sandbox.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    postedBody = body;
    if (url.endsWith('/subscribe-embedded') && EXPECTED_IDS.indexOf(body.plan) !== -1) {
      return { ok: true, json: async () => ({ clientSecret: 'cs_test_' + body.plan }) };
    }
    throw new Error('unexpected-fetch ' + url);
  };
  sandbox.DrexCloud = { auth: () => ({ getIdToken: async () => 'tok' }) };
  let redir = null;
  sandbox.location = new Proxy(sandbox.location, { set(t, k, v) { if (k === 'href') redir = v; t[k] = v; return true; } });
  let emb = null;
  try { emb = await K.subscribeEmbedded('biennial'); } catch (e) { ok(false, 'subscribeEmbedded(biennial) no debe fallar: ' + (e && e.message)); }
  ok(emb && emb.clientSecret === 'cs_test_biennial', 'subscribeEmbedded(biennial) devuelve el clientSecret de la Lambda');
  ok(postedBody && postedBody.plan === 'biennial' && !('returnUrl' in postedBody), 'subscribeEmbedded envía {plan} sin returnUrl (nada de redirect)');
  ok(redir === null, 'C247 (2026-10-03): la suscripción embebida NUNCA redirige fuera de Drex');

  /* ---- 13. Paridad i18n de las claves nuevas de planes ---- */
  const pySrc = fs.readFileSync(path.join(ROOT, 'drex_orbit_i18n.py'), 'utf8');
  const escBlock = pySrc.slice(pySrc.indexOf('--- Escalera de planes Drex Orbit'));
  const newKeys = [];
  const re = /^\("((?:[^"\\]|\\.)*)",/gm;
  let m;
  while ((m = re.exec(escBlock))) newKeys.push(m[1].replace(/\\"/g, '"'));
  ok(newKeys.length >= 17, 'claves nuevas de planes en drex_orbit_i18n.py (' + newKeys.length + ')');
  const i18n = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');
  function dictKeys(src, start, end) {
    const seg = src.slice(src.indexOf(start), src.indexOf(end));
    const keys = new Set();
    const kr = /"((?:[^"\\]|\\.)*)":"(?:[^"\\]|\\.)*"/g;
    let mm, count = 0;
    while ((mm = kr.exec(seg))) { keys.add(mm[1]); count++; if (count > 200000) break; }
    return keys;
  }
  const enK = dictKeys(i18n, 'var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {');
  const zhK = dictKeys(i18n, 'var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {');
  const ptK = dictKeys(i18n, 'var APP_PORTUGUESE_TEXT = {', 'var APP_CHINESE_ATTRS = {');
  const missing = [];
  for (const k of newKeys) {
    if (!enK.has(k)) missing.push('EN:' + k);
    if (!zhK.has(k)) missing.push('ZH:' + k);
    if (!ptK.has(k)) missing.push('PT:' + k);
  }
  ok(missing.length === 0, 'paridad i18n claves de planes (faltantes: ' + missing.slice(0, 5).join(', ') + ')');

  console.log(`\nOrbit plans: ${pass} ok, ${fail} fallos`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('ERROR inesperado:', e); process.exit(1); });
