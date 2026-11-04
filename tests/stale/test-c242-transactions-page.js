/* ================================================================
 * C242 — página propia de transacciones de Drex (2026-10-03).
 *
 * La vista "Transacciones" (antes "Pagos") es nuestra de punta a punta:
 *
 *  tarjeta de suscripción ... plan + precio, estado (Activa / Vence
 *                     pronto / Cancelada / Sin suscripción), renovación
 *                     o "Se cancela el <fecha>", botones Gestionar /
 *                     Restaurar compra / Ver planes. Fail-closed: sin
 *                     datos verificados jamás se pinta un activo falso.
 *  historial ......... movimientos reales de /transactions; importe
 *                     SOLO desde tx.cents / tx.amount del backend.
 *  recibo ............ hoja propia dentro de Drex (concepto, fecha y
 *                     hora, monto, estado, método, ID truncado y
 *                     copiable). Sin enlaces al panel de Stripe.
 *  estados ........... esqueleto (shimmer estándar), vacío, error con
 *                     reintento y sin sesión (puerta de acceso).
 *  C240 .............. cero etiquetas/rama de la economía eliminada;
 *                     tipos históricos caen a la etiqueta genérica
 *                     "Pago" con importe crudo, sin símbolos inventados.
 *
 * Ejecutar: node tests/test-c242-transactions-page.js
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

/* Segmento de la vista de transacciones (C242). */
const segStart = html.indexOf('/* ---------- C242: página propia de transacciones de Drex');
const segEnd = html.indexOf('/* ---------- analíticas de creador ---------- */');
assert(segStart > 0 && segEnd > segStart, 'no se encontró el segmento C242');
const seg = html.slice(segStart, segEnd);

/* ---------- títulos y puntos de entrada ---------- */

ok('ajustes: la fila se titula "Pagos y transacciones"', () => {
  assert(has('id="pagos-settings-title"'), 'falta la fila de ajustes');
  assert(has("tEl.textContent = t('Pagos y transacciones');"), 'el preview no fija el título nuevo');
});

ok('la vista se titula "Transacciones"', () => {
  assert(has('id="payments-view-title"'), 'falta el título de la vista');
  assert(seg.includes("titleEl.textContent = t('Transacciones');"), 'renderPaymentsView no fija "Transacciones"');
});

ok('entrada desde Ajustes (openPaymentsView) intacta', () => {
  assert(has('id="pagos-settings-card" onclick="openPaymentsView()"'));
  assert(has('function openPaymentsView()'));
});

ok('entrada desde la vista de Orbit: "Ver mis transacciones"', () => {
  const oStart = html.indexOf('async function renderOrbitView()');
  const oEnd = html.indexOf('function drexPayNetDiag()');
  assert(oStart > 0 && oEnd > oStart);
  const oSeg = html.slice(oStart, oEnd);
  assert(oSeg.includes("t('Ver mis transacciones')"), 'falta el botón en la vista Orbit');
  assert(oSeg.includes('onclick="openPaymentsView()"'), 'el botón no abre Transacciones');
});

/* ---------- flujo de datos (se conserva el de C236/C240) ---------- */

ok('los datos siguen viniendo de DrexOrbit.transactions -> /transactions', () => {
  assert(has("this._post('/transactions', {})"), 'cambió el endpoint');
  assert(seg.includes('await DrexOrbit.transactions()'), 'la vista no pide el historial al backend');
  assert(seg.includes('data.subscription'), 'la tarjeta no lee el estado del backend');
  assert(seg.includes('data.transactions'), 'el historial no lee los movimientos del backend');
});

/* ---------- cuatro estados ---------- */

ok('estado cargando: esqueleto shimmer estándar + texto', () => {
  assert(seg.includes('feed-skeleton'), 'falta el esqueleto');
  assert(seg.includes("t('Cargando tu historial…')"));
});

ok('estado vacío: "Aún no tienes movimientos"', () => {
  assert(seg.includes("t('Aún no tienes movimientos')"));
  assert(seg.includes("t('Tus compras y pagos aparecerán aquí automáticamente.')"));
});

ok('estado error: mensaje + Reintentar (fail-closed, sin tarjeta falsa)', () => {
  assert(seg.includes("t('No pudimos cargar tu historial. Inténtalo de nuevo.')"));
  assert(seg.includes('onclick="renderPaymentsView()"'), 'falta el botón de reintento');
  const errAt = seg.indexOf('No pudimos cargar tu historial');
  const cardAt = seg.indexOf('html += drexTxSubCardHTML(sub, escFn);');
  assert(errAt > 0 && cardAt > errAt, 'la tarjeta debe pintarse solo tras el éxito');
});

ok('estado sin sesión: aviso + puerta de acceso de la app', () => {
  assert(seg.includes('function drexTxRenderSignedOut'));
  assert(seg.includes("t('Inicia sesión para ver tus pagos y transacciones.')"));
  assert(seg.includes("document.getElementById('auth-form')"), 'no abre la puerta de acceso');
  assert(seg.includes('drexTxPromptLogin()'), 'falta el handler de login');
  assert(seg.includes("err.message) || '') === 'no-token'"), 'no-token no cae al estado sin sesión');
});

ok('botón Actualizar (refresh) en la vista', () => {
  assert(seg.includes("t('Actualizar')"));
});

/* ---------- tarjeta de suscripción ---------- */

ok('tarjeta: plan + precio desde el estado verificado', () => {
  assert(seg.includes('function drexTxSubCardHTML'));
  assert(seg.includes('orbitPlanName(sub.plan)'), 'falta el nombre del plan');
  assert(seg.includes('orbitPlanPrice(sub.plan)'), 'falta el precio del plan');
});

ok('tarjeta: estados Activa / Vence pronto / Cancelada / Sin suscripción', () => {
  assert(seg.includes('function drexTxSubStatus'));
  for (const s of ['Activa', 'Vence pronto', 'Cancelada', 'Sin suscripción']) {
    assert(seg.includes("t('" + s + "')"), 'falta el estado ' + s);
  }
  assert(seg.includes('return t(\'Sin suscripción\');'), 'el repliegue por defecto debe ser Sin suscripción');
});

ok('tarjeta: renovación y "Se cancela el <fecha>"', () => {
  assert(seg.includes("t('Se renueva el') + ' '"), 'falta la línea de renovación');
  assert(seg.includes("t('Se cancela el') + ' '"), 'falta "Se cancela el <fecha>"');
  assert(seg.includes('sub.cancelAtPeriodEnd'), 'no se lee cancelAtPeriodEnd');
  assert(seg.includes('sub.currentPeriodEnd'), 'no se lee currentPeriodEnd');
});

ok('tarjeta: botones Gestionar / Restaurar compra / Ver planes', () => {
  assert(seg.includes('onclick="orbitManage()"'), 'falta Gestionar (portal)');
  assert(seg.includes('onclick="drexTxRestorePurchase()"'), 'falta Restaurar compra');
  assert(seg.includes('onclick="drexTxOpenPlans()"'), 'falta Ver planes');
  assert(seg.includes("t('Gestionar suscripción')") && seg.includes("t('Restaurar compra')") && seg.includes("t('Ver planes')"));
});

ok('restaurar compra verifica contra el backend y repinta esta vista', () => {
  const at = seg.indexOf('async function drexTxRestorePurchase()');
  assert(at > 0);
  const fn = seg.slice(at, at + 700);
  assert(fn.includes('DrexOrbit.restore()'), 'restore no verifica en el servidor');
  assert(fn.includes('renderPaymentsView()'), 'restore no repinta Transacciones');
});

/* ---------- historial e importes ---------- */

ok('importes solo desde el backend (tx.cents / tx.amount)', () => {
  const at = seg.indexOf('function orbitTxAmount(tx)');
  assert(at > 0);
  const fn = seg.slice(at, at + 900);
  assert(fn.includes('tx.cents'), 'no usa cents del backend');
  assert(fn.includes('tx.amount'), 'no usa amount del backend');
  assert(!/orbitPlanMonthlyCents|unit_amount|price_data/.test(fn), 'el cliente no debe recalcular dinero');
});

ok('título Orbit desde el backend; resto, etiqueta genérica "Pago"', () => {
  assert(seg.includes('function drexTxTitle(tx)'));
  assert(seg.includes("tx.type === 'orbit'"), 'la rama Orbit debe usar su descripción');
  assert(seg.includes("return t('Pago');"), 'falta el repliegue genérico honesto');
  assert(seg.includes('escFn(drexTxTitle(tx))'), 'el título no va escapado');
  assert(seg.includes('escFn(orbitTxAmount(tx))'), 'el importe no va escapado');
});

ok('cada movimiento abre su recibo', () => {
  assert(seg.includes('drexTxOpenReceipt('), 'las filas no abren recibo');
  assert(seg.includes('_drexTxList = Array.isArray(data.transactions)'), 'no se guarda la lista para el recibo');
});

/* ---------- C240: nada de la economía eliminada ---------- */

ok('cero etiquetas de Drex Coins en toda la app', () => {
  assert(count('Drex Coins') === 0, 'queda "Drex Coins"');
  assert(count('Compra de Drex Coins') === 0);
  assert(count('Tus movimientos reales de Drex Coins') === 0);
});

ok('el segmento de la vista no tiene ramas ni copia de monedas', () => {
  assert(!seg.includes("type === 'coins'"), 'queda la rama coins');
  assert(!seg.includes('monedas'), 'queda copia de monedas');
  assert(!seg.includes('diamante'), 'queda copia de diamantes');
  assert(!seg.includes('regalo'), 'queda copia de regalos');
});

/* ---------- recibo propio ---------- */

ok('existe la hoja de recibo dentro de Drex', () => {
  assert(has('id="tx-receipt-sheet"'), 'falta la hoja');
  assert(has('id="tx-receipt-content"'), 'falta el contenido del recibo');
  assert(has('id="tx-receipt-title"'), 'falta el título del recibo');
});

ok('recibo: concepto, fecha y hora, monto, estado, método e ID', () => {
  for (const k of ['Concepto', 'Fecha y hora', 'Monto', 'Estado', 'Método de pago', 'ID de transacción']) {
    assert(seg.includes("t('" + k + "')"), 'falta el campo ' + k);
  }
  assert(seg.includes("'Stripe'"), 'el método debe ser Stripe');
  assert(seg.includes('drexTxFmtDateTime'), 'falta fecha+hora localizada');
  assert(seg.includes('toLocaleTimeString'), 'la hora no se formatea');
});

ok('recibo: ID truncado y copiable, sin enlaces al panel de Stripe', () => {
  assert(seg.includes('drexTxShortId'), 'falta el truncado del ID');
  assert(seg.includes('navigator.clipboard.writeText'), 'falta copiar al portapapeles');
  assert(seg.includes("execCommand('copy')"), 'falta el respaldo de copiado');
  assert(!seg.includes('dashboard.stripe'), 'no debe enlazar al panel de Stripe');
  assert(!seg.includes('Ver en Stripe'), 'el recibo se queda en Drex');
});

ok('handlers del recibo exportados (onclick en scope global)', () => {
  for (const f of ['drexTxOpenReceipt', 'drexTxCloseReceipt', 'drexTxCopyId', 'drexTxRestorePurchase', 'drexTxOpenPlans', 'drexTxPromptLogin']) {
    assert(has('window.' + f + ' = ' + f + ';'), 'falta exportar ' + f);
  }
});

/* ---------- i18n: claves C242 en EN/ZH/PT ---------- */

ok('claves C242 presentes en los tres diccionarios', () => {
  assert(i18n.includes('/* C242:'), 'falta el bloque C242 en drex-i18n.js');
  const keys = [
    'Pagos y transacciones', 'Transacciones', 'Ver mis transacciones',
    'Tus movimientos reales de Drex Orbit.', 'Activa', 'Vence pronto',
    'Cancelada', 'Sin suscripción', 'Se cancela el', 'Pago',
    'Detalle del movimiento', 'Concepto', 'Monto', 'Estado',
    'Método de pago', 'ID de transacción',
    'Inicia sesión para ver tus pagos y transacciones.', 'Copiar'
  ];
  for (const k of keys) {
    const n = i18n.split('"' + k + '":').length - 1;
    assert(n >= 3, 'la clave "' + k + '" aparece ' + n + ' veces (esperado >=3: EN/ZH/PT)');
  }
});

/* ---------- 404 idéntico ---------- */

ok('404.html byte-idéntico a index.html', () => {
  assert(html === html404, '404.html difiere de index.html');
});

console.log('\nC242 OK — ' + passed + ' comprobaciones superadas');
