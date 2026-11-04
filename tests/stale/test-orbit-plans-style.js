#!/usr/bin/env node
/* Drex Orbit — carril 5: reestilizado de tarjetas de planes al design system.
 * Verifica sobre el markup/CSS generado:
 *  1. Cada tarjeta lleva data-plan-id (contrato con otro carril).
 *  2. Sin degradados morados (#9D4EDD / #6D28D9) en las tarjetas de planes
 *     ni en sus botones: acento único índigo #2F33B8.
 *  3. El plan recomendado se distingue con borde índigo + etiqueta discreta
 *     (sin píldoras multicolor de "Ahorra X%": el ahorro va como texto).
 *  4. Los botones usan la clase primaria .orbit-plan-btn (índigo sólido,
 *     texto blanco, patrón del botón primario de la plataforma).
 *  5. Estado "Próximamente": CSS para .plan-coming-soon / [data-unavailable]
 *     (tarjeta atenuada, botón deshabilitado, etiqueta discreta .orbit-plan-soon).
 *  6. Paridad i18n de la clave orbit_coming_soon en EN/ZH/PT.
 *  7. Sanidad a 390px: tarjetas en una sola columna, sin anchos fijos ni
 *     desbordes evidentes en el markup de la escalera.
 */
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

const PLAN_IDS = ['weekly', 'monthly', 'quarterly', 'semiannual', 'yearly', 'biennial', 'lifetime'];
const PURPLE = /#9[Dd]4[Ee][Dd][Dd]|#6[Dd]28[Dd]9|157,78,221|109,40,217/;

/* ---- 1. Extrae la función card(planId) del template y ejecútala en sandbox ---- */
const cardStart = html.indexOf('var card = function (planId) {');
ok(cardStart !== -1, 'template card(planId) presente en renderOrbitView');
const cardEnd = html.indexOf('\n    };', cardStart);
ok(cardEnd !== -1, 'cierre de card(planId) localizable');
const cardSrc = html.slice(cardStart, cardEnd + '\n    };'.length)
  .replace(/^var card = /, '').replace(/;$/, '');

const sandbox = {
  console,
  ORBIT_PLANS: {
    weekly:     { id: 'weekly',     price: '$1.99',   per: 'semana',    mode: 'recurring' },
    monthly:    { id: 'monthly',    price: '$4.99',   per: 'mes',       mode: 'recurring' },
    quarterly:  { id: 'quarterly',  price: '$12.99',  per: 'trimestre', mode: 'recurring' },
    semiannual: { id: 'semiannual', price: '$24.99',  per: 'semestre',  mode: 'recurring' },
    yearly:     { id: 'yearly',     price: '$49.99',  per: 'año',       mode: 'recurring' },
    biennial:   { id: 'biennial',   price: '$89.99',  per: '2 años',    mode: 'recurring' },
    lifetime:   { id: 'lifetime',   price: '$149.99', per: 'pago único', mode: 'one_time' },
  },
  ORBIT_RECOMMENDED_PLAN: 'yearly',
  ORBIT_BACKEND_PLANS: ['monthly', 'quarterly', 'semiannual', 'yearly'],
  orbitPlanAvailable: (id) => ['monthly', 'quarterly', 'semiannual', 'yearly'].indexOf(id) !== -1,
  orbitComingSoonLabel: () => 'Próximamente',
  t: (s) => s,
  escFn: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  orbitPlanName: (id) => ({ weekly: 'Semanal', monthly: 'Mensual', quarterly: 'Trimestral', semiannual: 'Semestral', yearly: 'Anual', biennial: '2 años', lifetime: 'De por vida' }[id] || id),
  orbitPlanBadge: (id) => ({ quarterly: 'Ahorra 13%', semiannual: 'Ahorra 17%', yearly: 'Ahorra 2 meses', biennial: 'Ahorra 25%', lifetime: 'Para siempre' }[id] || null),
  orbitPlanMonthlyPrice: (id) => (id === 'monthly' ? '' : '$4.17'),
  orbitPlanSavingsPct: (id) => ({ quarterly: 13, semiannual: 17, yearly: 17, biennial: 25 }[id] || 0),
};
vm.createContext(sandbox);
const card = vm.runInContext('(' + cardSrc + ')', sandbox);
ok(typeof card === 'function', 'card(planId) evaluable en sandbox');

const cards = {};
for (const id of PLAN_IDS) {
  try { cards[id] = card(id); } catch (e) { cards[id] = ''; ok(false, 'card(' + id + ') no lanza: ' + (e && e.message)); }
}

/* ---- 2. data-plan-id en cada tarjeta ---- */
for (const id of PLAN_IDS) {
  ok(cards[id].indexOf('data-plan-id="' + id + '"') !== -1, id + ': tarjeta con data-plan-id="' + id + '"');
}

/* ---- 3. Sin degradados ni morados en las tarjetas ---- */
for (const id of PLAN_IDS) {
  ok(cards[id].indexOf('linear-gradient') === -1, id + ': sin linear-gradient en la tarjeta');
  ok(!PURPLE.test(cards[id]), id + ': sin morados #9D4EDD/#6D28D9 en la tarjeta');
  ok(cards[id].indexOf('style="background:') === -1, id + ': sin fondos inline en la tarjeta');
}
ok(cardSrc.indexOf('linear-gradient') === -1, 'template card(): sin linear-gradient');
ok(!PURPLE.test(cardSrc), 'template card(): sin morados');

/* ---- 4. Botón primario de la plataforma (solo planes disponibles) ---- */
const AVAILABLE_IDS = ['monthly', 'quarterly', 'semiannual', 'yearly'];
const SOON_IDS = ['weekly', 'biennial', 'lifetime'];
for (const id of AVAILABLE_IDS) {
  /* C243-A: la tarjeta ES el control: tocarla selecciona (role=radio) y el
   * unico boton .orbit-plan-btn (tactil) vive bajo el selector. */
  ok(cards[id].indexOf('role="radio"') !== -1, id + ': tarjeta seleccionable (role=radio)');
  ok(cards[id].indexOf("orbitSelectPlan('" + id + "')") !== -1, id + ': tocarla selecciona con orbitSelectPlan');
  ok(cards[id].indexOf('orbitSubscribe(') === -1, id + ': la tarjeta no cobra por su cuenta');
}
/* ---- 4b. Planes sin precio: sin botón de pago, estado Próximamente ---- */
for (const id of SOON_IDS) {
  ok(cards[id].indexOf("orbitSubscribe('" + id + "')") === -1, id + ': SIN botón de pago (no lleva a error)');
  ok(cards[id].indexOf('plan-coming-soon') !== -1, id + ': tarjeta con clase plan-coming-soon');
  ok(cards[id].indexOf('data-unavailable="true"') !== -1, id + ': tarjeta con data-unavailable="true"');
  ok(cards[id].indexOf('Próximamente') !== -1, id + ': etiqueta Próximamente visible');
}
/* C248: el botón por tarjeta (.orbit-plan-btn) murió con el CTA único de
 * la barra fija; C263 eliminó su CSS legado. El contrato vivo es el CTA
 * único #orbit-subscribe-cta (clase .orbit-cta) y la píldora Próximamente. */
const ctaN = (html.match(/id="orbit-subscribe-cta"/g) || []).length;
ok(ctaN >= 1, 'CTA único #orbit-subscribe-cta presente (forma C248)');
ok(html.indexOf('.orbit-plan-btn{') === -1, 'CSS legado .orbit-plan-btn eliminado (C263)');
ok(html.indexOf('.orbit-subscribe-cta{') === -1, 'CSS legado .orbit-subscribe-cta eliminado (C263)');
const ctaCss = html.match(/\.orbit-cta\{[^}]*\}/);
ok(!!ctaCss, 'regla CSS .orbit-cta presente');
ok(ctaCss && /min-height:/.test(ctaCss[0]), '.orbit-cta: alto táctil');

/* ---- 5. Plan recomendado: borde índigo + etiqueta discreta ---- */
ok(cards.yearly.indexOf('orbit-plan-card best') !== -1, 'yearly: clase best');
ok(cards.yearly.indexOf('orbit-plan-rec') !== -1, 'yearly: etiqueta .orbit-plan-rec');
ok(cards.yearly.indexOf('Recomendado') !== -1, 'yearly: texto "Recomendado"');
for (const id of PLAN_IDS) {
  if (id === 'yearly') continue;
  ok(cards[id].indexOf('orbit-plan-rec') === -1, id + ': sin etiqueta Recomendado');
}
const bestCss = html.match(/\.orbit-plan-card\.best\{[^}]*\}/);
ok(!!bestCss, 'regla CSS .orbit-plan-card.best presente');
ok(bestCss && !PURPLE.test(bestCss[0]), '.best: sin morados');
ok(bestCss && /(var\(--drex-brand\)|#2F33B8)/i.test(bestCss[0]), '.best: borde índigo');
/* El ahorro como texto discreto, no píldora multicolor */
ok(cards.semiannual.indexOf('orbit-plan-save') !== -1, 'semiannual: ahorro como .orbit-plan-save (texto discreto)');
/* C243: el ahorro se computa de los datos del plan (Ahorras {n}%). */
ok(cards.semiannual.indexOf('Ahorras 17%') !== -1, 'semiannual: dato del ahorro conservado');
ok(cards.yearly.indexOf('Ahorras 17%') !== -1, 'yearly: ahorro computado como texto (17%)');
ok(cards.lifetime.indexOf('Para siempre') !== -1, 'lifetime: conserva "Para siempre" como texto');
const saveCss = html.match(/\.orbit-plan-save\{[^}]*\}/);
ok(!!saveCss && saveCss[0].indexOf('linear-gradient') === -1, '.orbit-plan-save: sin degradado (texto discreto)');

/* ---- 6. Estado "Próximamente" (contrato con otro carril) ---- */
ok(html.indexOf('.orbit-plan-card.plan-coming-soon') !== -1, 'CSS: selector .plan-coming-soon presente');
ok(html.indexOf('[data-unavailable="true"]') !== -1, 'CSS: selector [data-unavailable="true"] presente');
const soonCardCss = html.match(/\.orbit-plan-card\.plan-coming-soon,[^}]*\}/);
ok(!!soonCardCss && /opacity:\s*\.55/.test(soonCardCss[0]), 'coming-soon: tarjeta atenuada (opacity .55)');
ok(html.indexOf('.orbit-plan-soon{') !== -1, 'coming-soon: píldora .orbit-plan-soon presente (C248+)');
ok(/\.orbit-plan-soon\{[^}]*\}/.test(html), 'CSS: clase .orbit-plan-soon para la etiqueta discreta');
ok(!/\.orbit-plan-soon\{[^}]*linear-gradient/.test(html), '.orbit-plan-soon: sin degradado');

/* ---- 7. Paridad i18n de orbit_coming_soon ---- */
function dictHas(dictStart, dictEnd, key) {
  const seg = i18n.slice(i18n.indexOf(dictStart), i18n.indexOf(dictEnd));
  return seg.indexOf('"' + key + '":"') !== -1;
}
ok(dictHas('var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {', 'orbit_coming_soon'), 'i18n EN: orbit_coming_soon');
ok(dictHas('var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {', 'orbit_coming_soon'), 'i18n ZH: orbit_coming_soon');
ok(dictHas('var APP_PORTUGUESE_TEXT = {', 'var APP_CHINESE_ATTRS = {', 'orbit_coming_soon'), 'i18n PT: orbit_coming_soon');
ok(i18n.indexOf('"orbit_coming_soon":"Coming soon"') !== -1, 'i18n EN: "Coming soon"');
ok(i18n.indexOf('"orbit_coming_soon":"即将推出"') !== -1, 'i18n ZH: "即将推出"');
ok(i18n.indexOf('"orbit_coming_soon":"Em breve"') !== -1, 'i18n PT: "Em breve"');

/* ---- 8. Sanidad a 390px (inspección estática del markup/CSS) ---- */
ok(html.indexOf("'<div class=\"px-4 mt-5\"><h3") !== -1, 'sección de planes dentro de contenedor px-4 (C264)');
ok(/grid grid-cols-1 gap-3/.test(html), 'escalera en una sola columna (grid-cols-1)');
for (const id of PLAN_IDS) {
  ok(!/width:\s*\d{3,}px/.test(cards[id]), id + ': sin anchos fijos en la tarjeta');
  ok(cards[id].indexOf('whitespace-nowrap') === -1 || id === 'yearly' || id === 'semiannual',
     id + ': sin nowrap que provoque desborde en textos largos');
}
const tagCss = html.match(/\.orbit-plan-tagwrap\{[^}]*\}/);
ok(!!tagCss && /left:\s*14px/.test(tagCss[0]), 'etiqueta Recomendado dentro de la tarjeta (left:14px)');
const recCss = html.match(/\.orbit-plan-rec\{[^}]*\}/);
ok(!!recCss && /white-space:\s*nowrap/.test(recCss[0]) && /text-transform:\s*uppercase/.test(recCss[0]),
   '.orbit-plan-rec: etiqueta compacta y discreta');

console.log(`\nOrbit plans style (carril 5): ${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
