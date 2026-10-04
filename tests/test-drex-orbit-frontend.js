#!/usr/bin/env node
/* Drex Orbit — pruebas frontend (lógica pura, sin DOM).
 * Verifica: fail-closed, normalización del backend, matriz de funciones,
 * enforcement desactivado por defecto, checkout/portal, retorno ?orbit=,
 * paridad i18n y catálogo de regalos. */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = process.env.ORBIT_TEST_ROOT || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; /* console.log('  ok', name); */ }
  else { fail++; console.error('  FAIL:', name); }
}

/* ---- 1. Extrae el bloque DrexOrbit (core) y ejecútalo en sandbox ---- */
const mCore = html.match(/\/\* =+\n \* DREX ORBIT — suscripción Orbit de Drex[\s\S]*?window\.DREX_ORBIT_ENFORCE = false;/);
ok(!!mCore, 'bloque core DrexOrbit presente en index.html');

const mUI = html.match(/\/\* =+ Drex Orbit: vista, paywall, temas, analíticas[\s\S]*?else __orbitPrevBoot\(\);\n\} catch \(\_\) \{\}/);
ok(!!mUI, 'bloque UI Drex Orbit presente');

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
// t() mínimo + DrexCloud stub para que el core cargue
sandbox.t = (s) => s;
sandbox.DrexCloud = { auth: () => ({ currentUser: null }) };
vm.runInContext(mCore[0], sandbox);
const K = sandbox.DrexOrbit;
ok(!!K, 'DrexOrbit definido');

/* ---- 2. Fail closed: sin estado -> no activo ---- */
ok(K.isActive() === false, 'fail-closed: isActive() false sin estado');
ok(K.hasAccess('no_ads') === false, 'fail-closed: hasAccess(no_ads) false');
ok(K.hasAccess('tema_x') === false, 'fail-closed: hasAccess(feature) false');
ok(K.hasAccess('whatever') === false, 'fail-closed: hasAccess desconocido false');

/* ---- 2b. Enforcement OFF: ni siquiera verificado otorga acceso ---- */
sandbox.window.DREX_ORBIT_ENFORCE = false;
K._setTestState({ active: true, plan: 'monthly', currentPeriodEnd: 9999999999, cancelAtPeriodEnd: false, status: 'active' });
ok(K.verifiedActive() === true, 'verificado: backend dice activo');
ok(K.isActive() === false, 'enforcement OFF: isActive false aunque verificado');
ok(K.hasAccess('no_ads') === false, 'enforcement OFF: sin acceso aunque verificado');

/* ---- 2c. Enforcement ON: la matriz de funciones aplica ---- */
sandbox.window.DREX_ORBIT_ENFORCE = true;

/* ---- 3. Normalización del backend ---- */
K._setTestState({ active: true, plan: 'monthly', currentPeriodEnd: 9999999999, cancelAtPeriodEnd: false, status: 'active' });
ok(K.isActive() === true, 'normaliza: active=true -> isActive true');
ok(K.hasAccess('no_ads') === true, 'normaliza: orbit accede a no_ads');
ok(K.hasAccess('exclusive_gifts') === false, 'C240: exclusive_gifts eliminado, ya no se concede');
K._setTestState({ active: false, plan: 'none' });
ok(K.isActive() === false, 'normaliza: active=false -> isActive false');
// estado malformado
K._setTestState({ active: 'yes', plan: 123 });
ok(K.isActive() === false, 'fail-closed: estado malformado -> false');
K._setTestState(null);
ok(K.isActive() === false, 'fail-closed: null -> false');
K._setTestState({ active: true, plan: 'monthly', status: 'past_due' });
ok(K.isActive() === false, 'C243-D: past_due apaga beneficios al instante (el backend tambien lo marca inactive)');
K._setTestState({ active: true, plan: 'monthly', status: 'canceled' });
ok(K.isActive() === false, 'canceled -> inactivo aunque active=true (fail closed)');

/* ---- 4. Matriz de funciones (7 grupos; studio_pro se eliminó en Fase 3 con Drex Studio y exclusive_gifts en C240 con la función de regalos) ---- */
K._setTestState({ active: true, plan: 'yearly', status: 'active' });
const FEATURES = ['no_ads','badge','profile_themes','fiesta_boost','limits','analytics','priority_support'];
for (const f of FEATURES) ok(K.hasAccess(f) === true, 'orbit accede a ' + f);
ok(K.hasAccess('studio_pro') === false, 'studio_pro eliminado: orbit ya no lo concede (Fase 3)');
K._setTestState({ active: false, plan: 'none' });
for (const f of FEATURES) ok(K.hasAccess(f) === false, 'no-orbit bloqueado en ' + f);
// Desconocido aunque sea orbit
K._setTestState({ active: true, plan: 'monthly', status: 'active' });
ok(K.hasAccess('admin_panel') === false, 'feature desconocida -> false aunque sea orbit');

/* ---- 5. Enforcement desactivado por defecto ---- */
sandbox.window.DREX_ORBIT_ENFORCE = false; // restaura el default
ok(mCore[0].includes('window.DREX_ORBIT_ENFORCE = false;'), 'flag de enforcement asignado a false en el core');
// Los gates consultan el flag
ok(html.includes("window.DREX_ORBIT_ENFORCE === true"), 'los gates consultan el flag explícito');

/* ---- 6. Precios visibles ---- */
ok(html.includes('$4.99'), 'precio mensual $4.99 presente');
ok(html.includes('$49.99'), 'precio anual $49.99 presente');
ok(html.includes('STRIPE_PRICE_ORBIT_MONTHLY') === false, 'sin price IDs en frontend (solo backend)');

/* ---- 7. Retorno ?orbit= ---- */
ok(html.includes("orbit=success") || html.includes("'orbit'"), 'manejo de ?orbit= presente');
ok(html.includes('captureOrbitReturn'), 'captureOrbitReturn definido');

/* ---- 8. Suscripción embebida + gestión propia usan el backend ---- */
/* C247 (2026-10-03): DrexOrbit.subscribe/manage (redirect a Checkout/portal)
 * se eliminaron; el contrato vivo es la hoja embebida de C244. */
ok(html.includes('/subscribe-embedded'), 'suscripción embebida usa /subscribe-embedded');
ok(html.includes('/subscription-cancel') && html.includes('/subscription-reactivate') && html.includes('/subscription-setup'), 'gestión propia usa /subscription-cancel|reactivate|setup');
ok(!html.includes('/create-subscription-session') && !html.includes('/create-customer-portal'), 'C247 (2026-10-03): sin endpoints LEGADO de redirect');
ok(html.includes('orbitSubscribe'), 'orbitSubscribe definido');

/* ---- 9. i18n: paridad ES/EN/ZH/PT ---- */
const i18n = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');
function dictKeys(src, start, end) {
  const seg = src.slice(src.indexOf(start), src.indexOf(end));
  const keys = new Set();
  const re = /"((?:[^"\\]|\\.)*)":"(?:[^"\\]|\\.)*"/g;
  let m, count = 0;
  while ((m = re.exec(seg))) { keys.add(m[1]); count++; if (count > 200000) break; }
  return keys;
}
const enK = dictKeys(i18n, 'var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {');
const zhK = dictKeys(i18n, 'var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {');
const ptK = dictKeys(i18n, 'var APP_PORTUGUESE_TEXT = {', 'var APP_CHINESE_ATTRS = {');
// Claves ES de Drex Orbit: la lista autoritativa vive en drex_orbit_i18n.py (T)
const pySrc = fs.readFileSync(path.join(ROOT, 'drex_orbit_i18n.py'), 'utf8');
const tArr = pySrc.slice(pySrc.indexOf('T = [') + 4, pySrc.indexOf(']\n\ndef esc') + 1);
const korKeys = [];
{
  const re = /^\(?"((?:[^"\\]|\\.)*)",/gm;
  let m;
  // el array T usa tuplas ("es", "en", "zh", "pt"): la primera cadena de cada tupla
  const lines = tArr.split('\n');
  for (const ln of lines) {
    const mm = ln.match(/^\("((?:[^"\\]|\\.)*)",/);
    if (mm) korKeys.push(mm[1].replace(/\\"/g, '"'));
  }
}
ok(korKeys.length >= 70, 'lista de claves Drex Orbit extraída (' + korKeys.length + ')');
let missing = [];
for (const k of korKeys) {
  if (!enK.has(k)) missing.push('EN:' + k.slice(0, 40));
  if (!zhK.has(k)) missing.push('ZH:' + k.slice(0, 40));
  if (!ptK.has(k)) missing.push('PT:' + k.slice(0, 40));
}
ok(missing.length === 0, 'paridad i18n Drex Orbit (faltantes: ' + missing.slice(0, 5).join(', ') + ')');

/* ---- 10. Regalos Orbit: el catálogo de regalos de en vivo se eliminó en Fase 2/3 ---- */
ok(html.includes("id: 'orbit_corona'") === false, 'catálogo de regalos orbit_corona eliminado con los en vivos');
ok(fs.existsSync(path.join(ROOT, 'assets/live-gifts')) === false, 'assets/live-gifts eliminado en Fase 3');

/* ---- 11. Sin simulación de estado ---- */
ok(!html.includes('DrexOrbit._simulate') && !html.includes('simulateOrbit'), 'sin simulación de orbit');
ok(mCore[0].includes('fail closed') || mCore[0].includes('fail-closed') || mCore[0].includes(' Backend es la única fuente'), 'documenta fail-closed');

/* ---- 12. Puertas: temas/analytics/en vivos no bloquean sin enforcement ---- */
ok(html.includes('DREX_ORBIT_ENFORCE'), 'UI respeta el flag de enforcement');

console.log(`\nDrex Orbit frontend: ${pass} ok, ${fail} fallos`);
/* ---- 13. Enforcement dinámico + peticiones sin preflight ---- */
K._serverConfigured = false;
sandbox.window.DREX_ORBIT_ENFORCE = false;
ok(K.enforced() === false, 'enforced() false por defecto (sin flag ni servidor)');
K._setTestState({ active: true, plan: 'monthly', currentPeriodEnd: 9999999999, cancelAtPeriodEnd: false, status: 'active' });
ok(K.isActive() === false, 'sin configured del servidor no hay acceso aunque verificado');
K._serverConfigured = true;
ok(K.enforced() === true, 'enforced() true con configured:true del servidor');
ok(K.isActive() === true, 'isActive true: verificado + configured');
K._serverConfigured = false;
ok(K.isActive() === false, 'fail-closed: configured false revoca acceso');
ok(mCore[0].includes('text/plain;charset=UTF-8'), 'peticiones orbit CORS simple (text/plain)');
ok(!mCore[0].includes("'Content-Type': 'application/json'"), 'sin application/json en el core orbit');
ok(!mCore[0].includes("'Authorization': 'Bearer '"), 'sin header Authorization en el core orbit');
ok(mCore[0].includes("this._post('/transactions'") && mCore[0].includes("method: 'POST'"), 'transactions por POST (via _post)');
console.log(`\nDrex Orbit frontend: ${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
