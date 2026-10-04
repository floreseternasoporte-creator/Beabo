#!/usr/bin/env node
/* =====================================================================
 * C248 — Orbit estilo referencia (layout tipo Grok) con piel Drex:
 * X circular, titulo centrado, segmentado Mensual/Trimestral/Anual,
 * tarjeta hero con abanico + 5 destacados, barra inferior fija con
 * precio grande + toggle Mensual/Anual + CTA unico degradado Drex.
 * Contratos C243 intactos: 7 tarjetas, CTA unico, checklist de 11.
 * Seleccionar solo pinta estado (fail-closed, nunca concede nada).
 * Uso: node tests/test-c248-orbit-grok-layout.js
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
  vm.createContext(sandbox);
  const mCore = html.match(/\/\* =+\n \* DREX ORBIT — suscripción Orbit de Drex[\s\S]*?window\.DREX_ORBIT_ENFORCE = false;/);
  ok(!!mCore, 'núcleo DrexOrbit localizable');
  vm.runInContext(mCore[0], sandbox);
  const mUi = html.match(/\/\* ============ Drex Orbit: vista, paywall, temas, analíticas ============ [\s\S]*?\nasync function orbitManage\(\)/);
  ok(!!mUi, 'bloque UI de Orbit localizable');
  vm.runInContext(mUi[0].replace(/\nasync function orbitManage\(\)$/, ''), sandbox);
  return { sandbox, els };
}

(async () => {
  console.log('-- C248.1: fuente (CSS + header X) --');
  eq(html404, html, '404.html byte-idéntico a index.html');
  for (const cls of ['orbit-x-btn', 'orbit-grok-title', 'orbit-seg-btn', 'orbit-hero-card', 'orbit-fan-center', 'orbit-feat-row', 'orbit-sticky-price', 'orbit-toggle-btn', 'orbit-cta']) {
    ok(html.includes('.' + cls), 'CSS presente: .' + cls);
  }
  ok(html.includes('class="orbit-x-btn tap44"'), 'header Orbit usa botón X circular');
  ok(html.includes('onclick="closeOrbitView()"'), 'la X cierra la vista Orbit');
  ok(html.includes('linear-gradient(135deg,#2F33B8,#6D28D9 60%,#9D4EDD)'), 'CTA con degradado Drex (índigo→violeta)');

  console.log('-- C248.2: render sin sesión (layout referencia) --');
  const { sandbox, els } = buildSandbox();
  await sandbox.renderOrbitView();
  const r = els['orbit-view-content'].innerHTML;
  ok(r.includes('orbit-grok-title'), 'título centrado estilo referencia');
  ok(r.includes('Crea más con Drex Orbit'), 'titular Drex presente');
  ok(r.includes('Elige el plan ideal para ti'), 'subtítulo presente');
  eq((r.match(/data-orbit-seg="monthly"/g) || []).length, 2, 'Mensual en segmentado + toggle');
  ok(r.includes('data-orbit-seg="quarterly"'), 'Trimestral en el segmentado superior');
  ok(r.includes('data-orbit-seg="yearly"'), 'Anual presente');
  ok(r.includes('orbit-hero-card'), 'tarjeta hero presente');
  ok(r.includes('orbit-fan-center'), 'abanico con imagen central Orbit');
  ok(r.includes('assets/img/drex-orbit-3d.png'), 'abanico usa el arte Orbit de Drex');
  ok(r.includes('Todo Drex, sin límites'), 'titular de la hero presente');
  ok(r.includes('También incluye:'), 'etiqueta "También incluye:" presente');
  eq((r.match(/orbit-feat-row/g) || []).length, 5, 'hero con 5 privilegios destacados');
  for (const f of ['no_ads', 'badge', 'hd_uploads', 'longer_posts', 'profile_visitors']) {
    ok(r.includes("orbitBenefitTap('" + f + "')"), 'destacado tocable: ' + f);
  }
  ok(r.includes('id="orbit-sticky-price"'), 'barra inferior con precio grande');
  ok(r.includes('id="orbit-sticky-billed"'), 'barra inferior con facturación');
  ok(r.includes('id="orbit-subscribe-cta"'), 'CTA único en la barra inferior');
  eq((r.match(/id="orbit-subscribe-cta"/g) || []).length, 1, 'un solo CTA de suscripción');
  ok(r.includes('orbitRestore()'), 'barra inferior enlaza Restaurar compra');
  eq((r.match(/orbit-plan-card/g) || []).length, 7, 'escalera completa: 7 tarjetas (C243 intacto)');
  eq((r.match(/orbit-benefit-check/g) || []).length, 11, 'checklist completa: 11 privilegios (C243 intacto)');

  console.log('-- C248.3: selección sincroniza precio/toggle (sin conceder) --');
  sandbox.orbitSelectPlan('monthly');
  eq(els['orbit-sticky-price'].textContent, '$4.99', 'precio grande refleja Mensual');
  ok(String(els['orbit-sticky-billed'].textContent).includes('$4.99'), 'facturación refleja Mensual');
  sandbox.orbitSelectPlan('quarterly');
  eq(els['orbit-sticky-price'].textContent, '$12.99', 'precio grande refleja Trimestral');
  eq(sandbox.DrexOrbit.isActive(), false, 'seleccionar NO concede acceso (fail-closed)');

  console.log('-- C248.4: i18n de los textos nuevos --');
  const sb = { console };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(i18nJs, sb);
  eq(Object.keys(sb.APP_ENGLISH_TEXT).length, Object.keys(sb.APP_CHINESE_TEXT).length, 'paridad EN=ZH');
  eq(Object.keys(sb.APP_ENGLISH_TEXT).length, Object.keys(sb.APP_PORTUGUESE_TEXT).length, 'paridad EN=PT');
  for (const k of ['Crea más con Drex Orbit', 'Elige el plan ideal para ti', 'Todo Drex, sin límites', 'También incluye:']) {
    ok(!!sb.APP_ENGLISH_TEXT[k], 'EN tiene: ' + k);
    ok(!!sb.APP_CHINESE_TEXT[k], 'ZH tiene: ' + k);
    ok(!!sb.APP_PORTUGUESE_TEXT[k], 'PT tiene: ' + k);
  }

  console.log('\nC248: ' + pass + ' ok, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  FAIL  excepción: ' + (e && e.message)); process.exit(1); });
