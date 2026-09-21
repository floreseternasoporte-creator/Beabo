#!/usr/bin/env node
/**
 * tests/test-age-verification.js — Ingeniero #2 (cliente de verificación de edad).
 *
 * Harness de Node con mocks. Extrae el bloque real del módulo IDV
 * (/* === DREX-IDV-CLIENT-START === *\/ ... END) de index.html y 404.html,
 * lo evalúa en un sandbox vm con DrexCloud/document/DOM simulados y
 * verifica: render de estados, puerta de cambio de fecha, límite de
 * 2 cambios, historial, i18n ES/EN/ZH de las claves nuevas, mapeo de
 * países/documentos, contrato del backend y modo demo.
 *
 * Uso: node tests/test-age-verification.js
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['index.html', '404.html'];
const html = {};
for (const f of FILES) html[f] = fs.readFileSync(path.join(ROOT, f), 'utf-8');

function extractModule(src, file) {
  const m = src.match(/\/\* === DREX-IDV-CLIENT-START === \*\/([\s\S]*?)\/\* === DREX-IDV-CLIENT-END === \*\//);
  assert.ok(m, 'bloque IDV no encontrado en ' + file);
  return m[1];
}

const HOOKS_TAIL = `
;__idvTestHooks = {
  BIRTHDAY_MAX_CHANGES: BIRTHDAY_MAX_CHANGES,
  IDV_COUNTRIES: IDV_COUNTRIES,
  IDV_DOCS_BY_COUNTRY: IDV_DOCS_BY_COUNTRY,
  IDV_DOC_LABELS: IDV_DOC_LABELS,
  IDV_I18N_KEYS: IDV_I18N_KEYS,
  IDV_DEMO_DELAY_MS: IDV_DEMO_DELAY_MS,
  idvBackendConfigured: idvBackendConfigured,
  idvBadgeInfo: idvBadgeInfo,
  renderIdvBadge: renderIdvBadge,
  idvFormatDate: idvFormatDate,
  refreshBirthdayIdvSection: refreshBirthdayIdvSection,
  idvGateBirthdayChange: idvGateBirthdayChange,
  idvRecordBirthdayChange: idvRecordBirthdayChange,
  idvWriteVerification: idvWriteVerification,
  idvApi: idvApi,
  idvOnResolved: idvOnResolved,
  idvShowResult: idvShowResult,
  idvShowStep: idvShowStep,
  openIdvFlow: openIdvFlow,
  closeIdvFlow: closeIdvFlow,
  idvGoBack: idvGoBack,
  selectIdvCountry: selectIdvCountry,
  selectIdvDoc: selectIdvDoc,
  idvStartCurrent: idvStartCurrent,
  idvStartDemo: idvStartDemo,
  idvStartReal: idvStartReal,
  idvManualRefresh: idvManualRefresh,
  idvRefreshStatusFromBackend: idvRefreshStatusFromBackend,
  idvState: function () { return { country: _idvCountry, doc: _idvDoc, step: _idvStep }; }
};`;

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeWorld(opts = {}) {
  const db = opts.db ? clone(opts.db) : {};
  const toasts = [];
  const notifications = [];
  const fetchCalls = [];
  const openedUrls = [];
  const fetchImpl = opts.fetchImpl || (async () => ({ ok: true, json: async () => ({}) }));
  const elements = {};
  function mkEl(id) {
    const classes = new Set();
    return {
      id, textContent: '', innerHTML: '', value: '', disabled: false,
      style: {}, className: '', parentElement: null,
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, f) => {
          if (f === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); }
          else if (f) classes.add(c); else classes.delete(c);
        },
        contains: (c) => classes.has(c),
      },
      hasClass: (c) => classes.has(c),
    };
  }
  function el(id) { if (!elements[id]) elements[id] = mkEl(id); return elements[id]; }
  const uid = opts.uid === undefined ? 'testuid123' : opts.uid;
  const sandbox = {
    console,
    window: Object.assign({ open: (u) => openedUrls.push(u) }, opts.window),
    document: {
      getElementById: (id) => elements[id] || null,
      body: { appendChild() {} },
      createElement: () => mkEl('x'),
    },
    DrexCloud: {
      auth() {
        return {
          get currentUser() { return uid ? { uid } : null; },
          getIdToken: () => Promise.resolve('mock-jwt-token'),
        };
      },
      database() {
        return {
          ref: (p) => ({
            once: () => Promise.resolve({ val: () => clone(db[p]), exists: () => db[p] !== undefined }),
            set: (v) => { db[p] = clone(v); return Promise.resolve(); },
            update: (u) => { db[p] = Object.assign({}, db[p] || {}, clone(u)); return Promise.resolve(); },
          }),
        };
      },
    },
    showMiniToast: (m) => toasts.push(String(m)),
    addNotification: (u2, msg, type, meta) => { notifications.push({ uid: u2, msg, type, meta }); return Promise.resolve(); },
    appT: (s) => s,
    fetch: (...a) => { fetchCalls.push(a); return fetchImpl(...a); },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  const ctx = { sandbox, el, toasts, notifications, fetchCalls, openedUrls };
  ctx.db = db;
  return ctx;
}

function loadModule(world, moduleCode) {
  vm.runInNewContext(moduleCode + HOOKS_TAIL, world.sandbox);
  return world.sandbox.__idvTestHooks;
}

function extractDict(src, constName) {
  const start = src.indexOf('const ' + constName + ' = {');
  assert.ok(start !== -1, constName + ' no encontrado');
  const end = src.indexOf('\n};', start);
  assert.ok(end !== -1, constName + ' sin cierre');
  return src.slice(start, end);
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

/* ── 1. Módulo presente e idéntico en ambos espejos ── */
test('modulo presente e identico en index.html y 404.html', () => {
  const a = extractModule(html['index.html'], 'index.html');
  const b = extractModule(html['404.html'], '404.html');
  assert.strictEqual(a, b, 'el bloque IDV difiere entre index.html y 404.html');
  for (const f of FILES) {
    assert.ok(html[f].includes('idvGateBirthdayChange(nextBirthday)'), 'saveBirthdayConfig con puerta en ' + f);
    assert.ok(html[f].includes('refreshBirthdayIdvSection(); } catch (e) {}'), 'refresh al abrir en ' + f);
    assert.ok(html[f].includes('ef3menqtisejy2pjdrxg5zsc3q0wwthy.lambda-url.us-east-1.on.aws'), 'URL IDV cableada en ' + f);
    assert.ok(html[f].includes('id="idv-flow-view"'), 'modal idv-flow-view en ' + f);
    assert.ok(html[f].includes('id="idv-status-badge"'), 'badge en ' + f);
  }
});

/* Con la URL IDV cableada en el HTML, los tests que ejercitan la ruta
   local (sin backend) deben vaciarla tras cargar el módulo. */
function noBackend(w) { w.sandbox.window.DREX_IDV_BACKEND_URL = ''; }

/* ── 2. Constantes y mapeos ── */
test('constantes: limite 2 cambios y 5 paises', () => {
  const w = makeWorld();
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  assert.strictEqual(h.BIRTHDAY_MAX_CHANGES, 2);
  assert.strictEqual(JSON.stringify(h.IDV_COUNTRIES.map((c) => c.code)), JSON.stringify(['CU', 'US', 'CA', 'MX', 'BR']));
});

test('documentos por pais segun cobertura Veriff', () => {
  const w = makeWorld();
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  const j = (v) => JSON.stringify(v);
  assert.strictEqual(j(h.IDV_DOCS_BY_COUNTRY.CU), j(['passport', 'national_id', 'drivers_license']));
  assert.strictEqual(j(h.IDV_DOCS_BY_COUNTRY.US), j(['passport', 'drivers_license']));
  assert.strictEqual(j(h.IDV_DOCS_BY_COUNTRY.CA), j(['passport', 'drivers_license']));
  assert.strictEqual(j(h.IDV_DOCS_BY_COUNTRY.MX), j(['passport', 'national_id', 'drivers_license']));
  assert.strictEqual(j(h.IDV_DOCS_BY_COUNTRY.BR), j(['passport', 'national_id', 'drivers_license']));
  assert.strictEqual(j(Object.keys(h.IDV_DOC_LABELS).sort()), j(['drivers_license', 'national_id', 'passport']));
});

/* ── 3. i18n ES/EN/ZH de claves nuevas ── */
test('i18n: toda clave nueva existe en EN y ZH de ambos archivos', () => {
  const w = makeWorld();
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  assert.ok(h.IDV_I18N_KEYS.length >= 30, 'se esperan 30+ claves, hay ' + h.IDV_I18N_KEYS.length);
  for (const f of FILES) {
    const en = extractDict(html[f], 'APP_ENGLISH_TEXT');
    const zh = extractDict(html[f], 'APP_CHINESE_TEXT');
    assert.ok(en.includes('"Colaborar":"Collaborate",'), 'sanity EN ' + f);
    assert.ok(zh.includes('"Colaborar":"合作",'), 'sanity ZH ' + f);
    for (const k of h.IDV_I18N_KEYS) {
      assert.ok(en.includes('"' + k + '":'), `[${f}][EN] falta clave: ${k}`);
      assert.ok(zh.includes('"' + k + '":'), `[${f}][ZH] falta clave: ${k}`);
    }
  }
});

/* ── 4. Puerta de cambio de fecha ── */
const UID = 'testuid123';
const UKEY = 'users/' + UID;

test('gate: sin usuario permite (no rompe flujo anonimo)', async () => {
  const w = makeWorld({ uid: null });
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  const g = await h.idvGateBirthdayChange('2000-01-15');
  assert.strictEqual(g.allowed, true);
});

test('gate: misma fecha no exige verificacion ni cuenta cambio', async () => {
  const w = makeWorld({ db: { [UKEY]: { birthday: '2000-01-15' } } });
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  const g = await h.idvGateBirthdayChange('2000-01-15');
  assert.strictEqual(g.allowed, true);
  assert.ok(!g.recordChange);
  assert.strictEqual(w.toasts.length, 0);
});

test('gate: primera carga (sin fecha previa) no cuenta como cambio', async () => {
  const w = makeWorld({ db: { [UKEY]: { birthday: '' } } });
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  const g = await h.idvGateBirthdayChange('1999-05-05');
  assert.strictEqual(g.allowed, true);
  assert.ok(!g.recordChange);
});

test('gate: cambio sin verificar -> bloquea y pide verificacion', async () => {
  const w = makeWorld({ db: { [UKEY]: { birthday: '2000-01-15', birthdayHistory: [] } } });
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  const g = await h.idvGateBirthdayChange('1999-05-05');
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.openVerification, true);
  assert.ok(w.toasts.some((t) => t.includes('verifica tu identidad')), 'toast: ' + w.toasts.join('|'));
});

test('gate: cambio con verificacion vigente -> permite y registra', async () => {
  const w = makeWorld({ db: { [UKEY]: { birthday: '2000-01-15', birthdayVerification: { status: 'verified', provider: 'veriff' }, birthdayHistory: [] } } });
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  noBackend(w);
  const g = await h.idvGateBirthdayChange('1999-05-05');
  assert.strictEqual(g.allowed, true);
  assert.strictEqual(g.recordChange, true);
  assert.strictEqual(g.oldBirthday, '2000-01-15');
  assert.strictEqual(g.verifiedBy, 'veriff');
});

test('gate: con backend, registro local falsificado no abre la puerta (verdad del servidor)', async () => {
  // Ataque: el usuario escribe a mano birthdayVerification={status:'verified'} en su
  // propio registro. Con backend configurado la puerta consulta /status del servidor.
  const w = makeWorld({
    window: { DREX_IDV_BACKEND_URL: 'https://idv.example.com/' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'none', provider: null }) }),
    db: { [UKEY]: { birthday: '2000-01-15', birthdayVerification: { status: 'verified', provider: 'veriff' }, birthdayHistory: [] } },
  });
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  const g = await h.idvGateBirthdayChange('1999-05-05');
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.openVerification, true);
});

test('gate: con backend, servidor verified -> permite', async () => {
  const w = makeWorld({
    window: { DREX_IDV_BACKEND_URL: 'https://idv.example.com/' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'verified', provider: 'demo' }) }),
    db: { [UKEY]: { birthday: '2000-01-15', birthdayVerification: { status: 'none' }, birthdayHistory: [] } },
  });
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  const g = await h.idvGateBirthdayChange('1999-05-05');
  assert.strictEqual(g.allowed, true);
  assert.strictEqual(g.recordChange, true);
  assert.strictEqual(g.verifiedBy, 'demo');
});

test('gate: 2 cambios usados -> bloquea con mensaje de soporte', async () => {
  const hist = [
    { old: '2000-01-01', new: '2000-01-15', at: '2026-01-01T00:00:00.000Z', verifiedBy: 'veriff' },
    { old: '2000-01-15', new: '1999-05-05', at: '2026-02-01T00:00:00.000Z', verifiedBy: 'veriff' },
  ];
  const w = makeWorld({ db: { [UKEY]: { birthday: '1999-05-05', birthdayVerification: { status: 'verified', provider: 'veriff' }, birthdayHistory: hist } } });
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  const g = await h.idvGateBirthdayChange('1998-03-03');
  assert.strictEqual(g.allowed, false);
  assert.ok(!g.openVerification, 'con limite agotado no se abre verificacion');
  assert.ok(w.toasts.some((t) => t.includes('límite')), 'toast limite: ' + w.toasts.join('|'));
});

test('gate: 1 cambio usado + verificado -> permite el segundo', async () => {
  const hist = [{ old: '2000-01-01', new: '2000-01-15', at: '2026-01-01T00:00:00.000Z', verifiedBy: 'veriff' }];
  const w = makeWorld({ db: { [UKEY]: { birthday: '2000-01-15', birthdayVerification: { status: 'verified', provider: 'veriff' }, birthdayHistory: hist } } });
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  noBackend(w);
  const g = await h.idvGateBirthdayChange('1999-05-05');
  assert.strictEqual(g.allowed, true);
  assert.strictEqual(g.recordChange, true);
});

/* ── 5. Historial ── */
test('historial: registra {old,new,at,verifiedBy} en users/<uid>/birthdayHistory', async () => {
  const w = makeWorld({ db: { [UKEY]: { birthday: '2000-01-15', birthdayHistory: [] } } });
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  await h.idvRecordBirthdayChange('2000-01-15', '1999-05-05', 'demo');
  const hist = w.db[UKEY + '/birthdayHistory'];
  assert.ok(Array.isArray(hist) && hist.length === 1);
  assert.strictEqual(hist[0].old, '2000-01-15');
  assert.strictEqual(hist[0].new, '1999-05-05');
  assert.strictEqual(hist[0].verifiedBy, 'demo');
  assert.ok(!Number.isNaN(Date.parse(hist[0].at)), 'at es ISO: ' + hist[0].at);
});

test('historial: no se lee ni escribe la clave birthday existente (solo lectura)', async () => {
  const w = makeWorld({ db: { [UKEY]: { birthday: '2000-01-15' } } });
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  const before = JSON.stringify(w.db[UKEY]);
  await h.idvGateBirthdayChange('1999-05-05');
  await h.idvRecordBirthdayChange('2000-01-15', '1999-05-05', 'veriff');
  assert.strictEqual(w.db[UKEY].birthday, '2000-01-15', 'birthday no debe mutar por el modulo');
  assert.strictEqual(JSON.stringify({ birthday: w.db[UKEY].birthday }), JSON.stringify({ birthday: JSON.parse(before).birthday }));
});

/* ── 6. Modo demo ── */
test('demo: flujo completo pending -> verified con provider demo', async () => {
  const w = makeWorld({ db: { [UKEY]: { birthday: '2000-01-15' } }, window: { DREX_IDV_DEMO_DELAY_MS: 25 } });
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  noBackend(w);
  assert.strictEqual(h.idvBackendConfigured(), false);
  w.el('idv-status-badge'); w.el('idv-verify-btn');
  h.selectIdvCountry('MX');
  h.selectIdvDoc('national_id');
  assert.deepStrictEqual(h.idvState().country, 'MX');
  assert.deepStrictEqual(h.idvState().doc, 'national_id');
  h.idvStartDemo();
  await sleep(10);
  let v = w.db[UKEY + '/birthdayVerification'];
  assert.strictEqual(v.status, 'pending');
  assert.strictEqual(v.provider, 'demo', 'el demo se marca provider:demo, nunca verificado real');
  assert.strictEqual(v.country, 'MX');
  assert.strictEqual(v.documentType, 'national_id');
  await sleep(120);
  v = w.db[UKEY + '/birthdayVerification'];
  assert.strictEqual(v.status, 'verified');
  assert.strictEqual(v.provider, 'demo', 'verificado DEMO, no real');
  assert.strictEqual(w.notifications.length, 1);
  const n = w.notifications[0];
  assert.strictEqual(n.type, 'id_verification');
  assert.strictEqual(n.meta.provider, 'demo');
  assert.strictEqual(n.meta.category, 'age-verification');
  assert.ok(w.el('idv-status-badge').textContent.includes('Verificada'));
  assert.ok(w.el('idv-status-badge').textContent.includes('MODO DEMO'), 'badge demo etiquetado: ' + w.el('idv-status-badge').textContent);
});

test('demo: sin pais/documento no inicia', async () => {
  const w = makeWorld({ db: { [UKEY]: { birthday: '2000-01-15' } }, window: { DREX_IDV_DEMO_DELAY_MS: 25 } });
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  h.idvStartDemo();
  await sleep(60);
  assert.strictEqual(w.db[UKEY + '/birthdayVerification'], undefined);
  assert.ok(w.toasts.length > 0);
});

/* ── 7. Contrato backend ── */
test('backend: POST /session con Bearer y body {country, documentType}', async () => {
  let seen = null;
  const w = makeWorld({
    window: { DREX_IDV_BACKEND_URL: 'https://idv.example.com/' },
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ verificationUrl: 'https://demo.example/v?t=1', provider: 'demo', sessionId: 's1' }) }; },
  });
  w.el('idv-status-badge'); w.el('idv-verify-btn'); w.el('idv-launch-progress');
  w.el('idv-start-btn'); w.el('idv-refresh-btn');
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  assert.strictEqual(h.idvBackendConfigured(), true);
  h.selectIdvCountry('CU');
  h.selectIdvDoc('passport');
  h.idvStartReal();
  await sleep(20);
  assert.ok(seen, 'fetch no fue llamado');
  assert.strictEqual(seen.url, 'https://idv.example.com/session');
  assert.strictEqual(seen.opts.method, 'POST');
  assert.strictEqual(seen.opts.headers['Authorization'], 'Bearer mock-jwt-token');
  assert.deepStrictEqual(JSON.parse(seen.opts.body), { country: 'CU', documentType: 'passport' });
  assert.deepStrictEqual(w.openedUrls, ['https://demo.example/v?t=1']);
  // Ruta real: el servidor es la fuente de verdad; el cliente NO escribe el estado.
  assert.strictEqual(w.db[UKEY + '/birthdayVerification'], undefined);
});

test('backend: GET /status y normalizacion de trailing slash', async () => {
  const calls = [];
  const w = makeWorld({
    window: { DREX_IDV_BACKEND_URL: 'https://idv.example.com///' },
    fetchImpl: async (url, opts) => { calls.push([url, opts.method]); return { ok: true, json: async () => ({ status: 'verified', provider: 'veriff' }) }; },
  });
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  const data = await h.idvApi('/status', 'GET');
  assert.strictEqual(calls[0][0], 'https://idv.example.com/status');
  assert.strictEqual(calls[0][1], 'GET');
  assert.strictEqual(data.status, 'verified');
});

test('backend: sin URL configurada idvApi rechaza (modo demo)', async () => {
  const w = makeWorld();
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  noBackend(w);
  assert.strictEqual(h.idvBackendConfigured(), false);
  await assert.rejects(h.idvApi('/status', 'GET'), /idv-not-configured/);
});

/* ── 8. Badge de estados ── */
test('badge: etiquetas y visibilidad del boton por estado', () => {
  const w = makeWorld();
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  const badge = w.el('idv-status-badge');
  const btn = w.el('idv-verify-btn');
  const cases = [
    ['none', undefined, 'Sin verificar', true, 'bg-[#eef2f7]'],
    ['pending', 'demo', 'En revisión', false, 'bg-[#fef3c7]'],
    ['verified', 'veriff', 'Verificada ✓', false, 'bg-[#dcfce7]'],
    ['verified', 'demo', 'Verificada ✓ · MODO DEMO', false, 'bg-[#dcfce7]'],
    ['rejected', 'veriff', 'Rechazada', true, 'bg-[#fee2e2]'],
    ['expired', 'veriff', 'Vencida', true, 'bg-[#eef2f7]'],
  ];
  for (const [st, prov, label, btnVisible, cls] of cases) {
    h.renderIdvBadge(st, prov);
    assert.strictEqual(badge.textContent, label, 'label ' + st);
    assert.ok(badge.className.includes(cls), 'clase ' + st + ': ' + badge.className);
    assert.strictEqual(!btn.hasClass('hidden'), btnVisible, 'boton visible=' + btnVisible + ' en ' + st);
  }
});

test('badge: estado desconocido cae a Sin verificar', () => {
  const w = makeWorld();
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  const info = h.idvBadgeInfo('weird', 'x');
  assert.strictEqual(info.key, 'Sin verificar');
});

/* ── 9. Resolución y notificaciones ── */
test('resolucion rechazada: escribe estado y notifica in-app', async () => {
  const w = makeWorld({ db: { [UKEY]: {} } });
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  noBackend(w);
  w.el('idv-status-badge'); w.el('idv-verify-btn');
  h.idvOnResolved('rejected', 'veriff');
  await sleep(10);
  assert.strictEqual(w.db[UKEY + '/birthdayVerification'].status, 'rejected');
  assert.strictEqual(w.notifications.length, 1);
  assert.ok(w.notifications[0].msg.includes('rechazada'));
  assert.strictEqual(w.notifications[0].type, 'id_verification');
});

test('pasos del modal: country -> doc -> launch -> result', () => {
  const w = makeWorld();
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  for (const s of ['country', 'doc', 'launch', 'result']) w.el('idv-step-' + s);
  h.idvShowStep('doc');
  assert.ok(!w.el('idv-step-doc').hasClass('hidden'));
  assert.ok(w.el('idv-step-country').hasClass('hidden'));
  h.idvGoBack(); // doc -> country
  assert.ok(!w.el('idv-step-country').hasClass('hidden'));
});

/* ── 10. Utilidades ── */
test('idvFormatDate: YYYY-MM-DD -> DD/MM/YYYY', () => {
  const w = makeWorld();
  const h = loadModule(w, extractModule(html['index.html'], 'index.html'));
  assert.strictEqual(h.idvFormatDate('2000-01-15'), '15/01/2000');
  assert.strictEqual(h.idvFormatDate(''), '');
});

/* ── 11. Integridad: login / 2FA / Centro de Seguridad intactos ── */
test('integridad: funciones clave de login, 2FA y seguridad siguen presentes', () => {
  const must = [
    'signInWithEmailAndPassword',
    'signInWithUsernameAndPassword',
    'security-center-view',
    'security-2fa-status',
    'showLegacy2FAChallenge',
    'saveProfileField',
    'applyBirthdayAgeProtections',
    'openBirthdayConfigView',
    'function saveBirthdayConfig',
    'function addNotification',
    'DrexCloud.auth().getAccessToken',
  ];
  for (const f of FILES) {
    for (const id of must) assert.ok(html[f].includes(id), `[${f}] falta: ${id}`);
  }
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('ok   - ' + name); }
    catch (e) { fail++; console.log('FAIL - ' + name + '\n       ' + String(e.message).split('\n')[0]); }
  }
  console.log('\n' + pass + '/' + (pass + fail) + ' tests passed');
  process.exit(fail ? 1 : 0);
})();
