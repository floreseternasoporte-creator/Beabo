#!/usr/bin/env node
/* Kor One — pruebas frontend (lógica pura, sin DOM).
 * Verifica: fail-closed, normalización del backend, matriz de funciones,
 * enforcement desactivado por defecto, checkout/portal, retorno ?korone=,
 * paridad i18n y catálogo de regalos. */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = '/home/hatch/workspace/beabo';
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; /* console.log('  ok', name); */ }
  else { fail++; console.error('  FAIL:', name); }
}

/* ---- 1. Extrae el bloque DrexKorOne (core) y ejecútalo en sandbox ---- */
const mCore = html.match(/\/\* =+\n \* KOR ONE — suscripción premium de Drex[\s\S]*?window\.DREX_KORONE_ENFORCE = false;/);
ok(!!mCore, 'bloque core DrexKorOne presente en index.html');

const mUI = html.match(/\/\* =+ Kor One: vista, paywall, temas, analíticas[\s\S]*?else __koronePrevBoot\(\);\n\} catch \(\_\) \{\}/);
ok(!!mUI, 'bloque UI Kor One presente');

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
const K = sandbox.DrexKorOne;
ok(!!K, 'DrexKorOne definido');

/* ---- 2. Fail closed: sin estado -> no activo ---- */
ok(K.isActive() === false, 'fail-closed: isActive() false sin estado');
ok(K.hasAccess('ads_free') === false, 'fail-closed: hasAccess(ads_free) false');
ok(K.hasAccess('tema_x') === false, 'fail-closed: hasAccess(feature) false');
ok(K.hasAccess('whatever') === false, 'fail-closed: hasAccess desconocido false');

/* ---- 2b. Enforcement OFF: ni siquiera verificado otorga acceso ---- */
sandbox.window.DREX_KORONE_ENFORCE = false;
K._setTestState({ active: true, plan: 'monthly', currentPeriodEnd: 9999999999, cancelAtPeriodEnd: false, status: 'active' });
ok(K.verifiedActive() === true, 'verificado: backend dice activo');
ok(K.isActive() === false, 'enforcement OFF: isActive false aunque verificado');
ok(K.hasAccess('ads_free') === false, 'enforcement OFF: sin acceso aunque verificado');

/* ---- 2c. Enforcement ON: la matriz de funciones aplica ---- */
sandbox.window.DREX_KORONE_ENFORCE = true;

/* ---- 3. Normalización del backend ---- */
K._setTestState({ active: true, plan: 'monthly', currentPeriodEnd: 9999999999, cancelAtPeriodEnd: false, status: 'active' });
ok(K.isActive() === true, 'normaliza: active=true -> isActive true');
ok(K.hasAccess('ads_free') === true, 'normaliza: premium accede a ads_free');
ok(K.hasAccess('gifts') === true, 'normaliza: premium accede a gifts');
K._setTestState({ active: false, plan: 'none' });
ok(K.isActive() === false, 'normaliza: active=false -> isActive false');
// estado malformado
K._setTestState({ active: 'yes', plan: 123 });
ok(K.isActive() === false, 'fail-closed: estado malformado -> false');
K._setTestState(null);
ok(K.isActive() === false, 'fail-closed: null -> false');
K._setTestState({ active: true, plan: 'monthly', status: 'past_due' });
ok(K.isActive() === true, 'past_due con active=true sigue activo (lo decide el backend)');
K._setTestState({ active: true, plan: 'monthly', status: 'canceled' });
ok(K.isActive() === false, 'canceled -> inactivo aunque active=true (fail closed)');

/* ---- 4. Matriz de funciones (9 grupos) ---- */
K._setTestState({ active: true, plan: 'yearly', status: 'active' });
const FEATURES = ['ads_free','badge_frame','profile_themes','fiesta_boost','limits_boost','analytics','gifts','priority_support'];
for (const f of FEATURES) ok(K.hasAccess(f) === true, 'premium accede a ' + f);
K._setTestState({ active: false, plan: 'none' });
for (const f of FEATURES) ok(K.hasAccess(f) === false, 'no-premium bloqueado en ' + f);
// Desconocido aunque sea premium
K._setTestState({ active: true, plan: 'monthly', status: 'active' });
ok(K.hasAccess('admin_panel') === false, 'feature desconocida -> false aunque sea premium');

/* ---- 5. Enforcement desactivado por defecto ---- */
sandbox.window.DREX_KORONE_ENFORCE = false; // restaura el default
ok(mCore[0].includes('window.DREX_KORONE_ENFORCE = false;'), 'flag de enforcement asignado a false en el core');
// Los gates consultan el flag
ok(html.includes("window.DREX_KORONE_ENFORCE === true"), 'los gates consultan el flag explícito');

/* ---- 6. Precios visibles ---- */
ok(html.includes('$4.99'), 'precio mensual $4.99 presente');
ok(html.includes('$49.99'), 'precio anual $49.99 presente');
ok(html.includes('STRIPE_PRICE_KORONE_MONTHLY') === false, 'sin price IDs en frontend (solo backend)');

/* ---- 7. Retorno ?korone= ---- */
ok(html.includes("korone=success") || html.includes("'korone'"), 'manejo de ?korone= presente');
ok(html.includes('captureKorOneReturn'), 'captureKorOneReturn definido');

/* ---- 8. Checkout/portal usan el backend ---- */
ok(html.includes('/create-subscription-session'), 'checkout usa /create-subscription-session');
ok(html.includes('/create-customer-portal'), 'portal usa /create-customer-portal');
ok(html.includes('korOneSubscribe'), 'korOneSubscribe definido');

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
// Claves ES de Kor One: la lista autoritativa vive en korone_i18n.py (T)
const pySrc = fs.readFileSync(path.join(ROOT, 'korone_i18n.py'), 'utf8');
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
ok(korKeys.length >= 70, 'lista de claves Kor One extraída (' + korKeys.length + ')');
let missing = [];
for (const k of korKeys) {
  if (!enK.has(k)) missing.push('EN:' + k.slice(0, 40));
  if (!zhK.has(k)) missing.push('ZH:' + k.slice(0, 40));
  if (!ptK.has(k)) missing.push('PT:' + k.slice(0, 40));
}
ok(missing.length === 0, 'paridad i18n Kor One (faltantes: ' + missing.slice(0, 5).join(', ') + ')');

/* ---- 10. Regalos: 6 Kor One, tier korone, PNG transparentes ---- */
const giftIds = ['korone_corona', 'korone_nucleo', 'korone_portal', 'korone_cometa', 'korone_cristal', 'korone_fenix'];
for (const id of giftIds) {
  ok(html.includes(`id: '${id}'`), 'regalo en catálogo: ' + id);
  ok(fs.existsSync(path.join(ROOT, 'assets/live-gifts', id + '.png')), 'PNG existe: ' + id);
}
ok(html.includes("tier: 'korone'"), "tier 'korone' presente");
ok(html.includes("tierLabel('korone')") || html.includes("'korone'"), 'etiqueta de tier korone');
// Los PNG son realmente PNG con alfa
const { execSync } = require('child_process');
for (const id of giftIds) {
  const info = execSync(`python3 -c "
from PIL import Image
im = Image.open('/home/hatch/workspace/beabo/assets/live-gifts/${id}.png')
print(im.size, im.mode)"`, { encoding: 'utf8' }).trim();
  ok(info.startsWith('(512, 512)') && info.includes('RGBA'), 'PNG 512x512 RGBA: ' + id + ' (' + info + ')');
}

/* ---- 11. Sin simulación de estado ---- */
ok(!html.includes('DrexKorOne._simulate') && !html.includes('simulatePremium'), 'sin simulación de premium');
ok(mCore[0].includes('fail closed') || mCore[0].includes('fail-closed') || mCore[0].includes(' Backend es la única fuente'), 'documenta fail-closed');

/* ---- 12. Puertas: temas/analytics/en vivos no bloquean sin enforcement ---- */
ok(html.includes('DREX_KORONE_ENFORCE'), 'UI respeta el flag de enforcement');

console.log(`\nKor One frontend: ${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
