'use strict';
/* C263 — Pagos Orbit dentro de Drex (cliente). Errores de la auditoría
 * (informe Marco, inv. ecddddee…):
 *  1. Un fallo transitorio de refresh() ponía _serverConfigured=false y
 *     orbitGate quedaba ABIERTO. Ahora solo reset()/logout limpian el flag.
 *  2. El segmentado superior no tenía Semestral (nada quedaba marcado).
 *  3. La barra de precio no respetaba el safe-area del iPhone.
 *  4. renderOrbitView, si el estado tardaba >12 s, le enseñaba el selector
 *     de planes a quien ya es miembro. Ahora pinta con el último estado.
 *  5. Tras pagar se anunciaba "ya está activa" antes del webhook. Ahora:
 *     "Pago recibido…" y el saludo solo al verificarse activa.
 *  6. Ajustes decía "Miembro activo" con los beneficios apagados.
 *  Y en la Lambda: rutas que sacaban al usuario de Drex retiradas (404),
 *  cancelar/reactivar sobre suscripción cancelada responde 200 honesto,
 *  la fuente del repo y la desplegable quedan idénticas (md5).
 * Ejecutar: node tests/test-c263-pagos-orbit-cliente.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let failures = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// ---------- 1: refresh no desconfigura el servidor ----------
ok(!html.includes('self._st = fail; self._serverConfigured = false;'),
  'refresh() no borra _serverConfigured en fallos');
const resetBlock = html.slice(html.indexOf('reset: function () {'), html.indexOf('reset: function () {') + 400);
ok(html.includes('reset: function () {\n    this._st = null; this._ts = 0; this._serverConfigured = false;'),
  'reset() sigue limpiando _serverConfigured');

// ---------- 2: segmentado con Semestral ----------
ok(html.includes("segBtn('monthly') + segBtn('quarterly') + segBtn('semiannual') + segBtn('yearly')"),
  'el segmentado superior incluye Semestral');
ok(html.includes('.orbit-seg-btn{flex:1;min-height:40px;border-radius:9999px;font-size:13px;font-weight:800'),
  'los 4 segmentos caben a 390px (13px)');

// ---------- 3: safe-area ----------
ok(html.includes('.orbit-footer{background:var(--theme-surface);border-top:1px solid var(--theme-border);padding:16px;padding-bottom:max(16px, env(safe-area-inset-bottom))'),
  'C264: el pie fijo de compra respeta el safe-area');
ok((html.match(/padding-bottom:max\(1\.75rem,env\(safe-area-inset-bottom\)\)/g) || []).length >= 2,
  'hojas de pago y de gestión respetan el safe-area');

// ---------- 4: miembro en red lenta conserva su vista ----------
ok(html.includes('if (!st) { try { st = DrexOrbit.status(); } catch (_) { st = null; } }'),
  'renderOrbitView pinta con el último estado si el refresh vence');

// ---------- 5: nada de "ya está activa" antes del webhook ----------
ok(html.includes("orbitToast(t('Pago recibido. Tu suscripción se activará en unos segundos.'))"),
  'tras pagar: "Pago recibido…"');
ok(html.includes('_orbitCelebrated') && html.includes('celebrateIfActive') && html.includes('DrexOrbit.verifiedActive()'),
  'el saludo de bienvenida solo al verificarse la suscripción');

// ---------- 6: Ajustes = estado verificado ----------
ok(html.includes(": t('Tus beneficios Orbit están desactivados');"),
  'Ajustes distingue "pagada pero beneficios OFF" de miembro activo');

// ---------- limpieza: CSS muerto ----------
ok(!html.includes('.orbit-plan-btn{') && !html.includes('.orbit-subscribe-cta{'),
  'CSS legado de botones viejos eliminado');

// ---------- Lambda: rutas y arreglos ----------
const lamPath = path.join(root, 'lambda-drex-payments', 'index.js');
const lam = fs.readFileSync(lamPath, 'utf8');
ok(!lam.includes("path === '/create-checkout-session'"), 'Lambda: ruta Coins Checkout retirada');
ok(!lam.includes("path === '/create-subscription-session'"), 'Lambda: ruta Checkout Orbit retirada');
ok(!lam.includes("path === '/create-customer-portal'"), 'Lambda: ruta portal de Stripe retirada');
ok(!lam.includes('handleCustomerPortal') && !lam.includes('handleCreateSubscriptionSession'), 'Lambda: handlers retirados eliminados');
ok(lam.includes("cur.status === 'canceled'"), 'Lambda: cancelar/reactivar con suscripción cancelada responde 200');
ok(lam.includes('subscriptions.retrieve(subId)'), 'Lambda: se lee la suscripción antes de actualizarla');
ok(lam.includes('invoicePaymentIntent'), 'Lambda: el secreto se lee de latest_invoice.payments (API Basil+)');
ok(lam.includes("drex_cust_") && lam.includes("drex_sub_"), 'Lambda: idempotencia en customers/subscriptions');

// ---------- fuente del repo == fuente desplegable ----------
const buildPath = path.join(root, '..', 'drex-payments-build', 'index.js');
const md5 = f => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
ok(md5(lamPath) === md5(buildPath), 'Lambda: fuente del repo idéntica a la desplegable');

console.log(failures ? `\n${failures} FALLO(S)` : '\nC263: cliente + Lambda en verde');
process.exit(failures ? 1 : 0);
