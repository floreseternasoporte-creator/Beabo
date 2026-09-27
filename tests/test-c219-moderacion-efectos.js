/* ================================================================
 * Tests de regresión: C219 moderación de efectos (2026-09-27)
 * - Contrato: el EMISOR decide `status` (Studio oficial => published,
 *   terceros => pending). El cliente web NUNCA auto-publica efectos
 *   ajenos: solo muestra `published` (legacy = publicado).
 * - El autor ve TODO su catálogo (badges Publicado/En revisión/
 *   Rechazado, "Usar" deshabilitado fuera de publicados); otros solo
 *   lo publicado. La cámara solo consume publicados.
 * - La bandeja "Solicitudes de efectos" de Drex Studio es visible
 *   SOLO para la cuenta oficial (userEmails/darelvega20@gmail.com =>
 *   UID resuelto) y `drexStudioReviewDecide` exige esa misma cuenta
 *   con guarda fail-closed DENTRO de la función: un no-oficial no
 *   puede aprobar/rechazar ni disparar avisos.
 * - Aprobar => status published + reviewedAt/reviewedBy; rechazar =>
 *   status rejected + reviewNote. Ambos notifican al autor con tipo
 *   'effect_review' y la bandeja se refresca.
 * Ejecutar con: node tests/test-c219-moderacion-efectos.js [--target <ruta>]
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var path = require('path');

var target = path.join(__dirname, '..', 'index.html');
var ti = process.argv.indexOf('--target');
if (ti !== -1 && process.argv[ti + 1]) target = process.argv[ti + 1];
var src = fs.readFileSync(target, 'utf8');

var start = src.indexOf('/* === DREX-EFFECTS v1');
var end = src.indexOf('/* === FIN DREX-EFFECTS v1 === */');
assert(start !== -1 && end !== -1 && end > start, 'bloque DREX-EFFECTS no encontrado');
var code = src.slice(start, end);

/* ---------- mini-DOM ---------- */
function makeEl(tag, id) {
  var el = {
    tagName: tag, id: id || '', children: [], _attrs: {}, _cls: [], style: {},
    dataset: {}, textContent: '', _innerHTML: '', value: '', _parent: null,
    _handlers: {}, disabled: false,
    classList: {
      add: function (c) { if (el._cls.indexOf(c) === -1) el._cls.push(c); },
      remove: function (c) { el._cls = el._cls.filter(function (x) { return x !== c; }); },
      contains: function (c) { return el._cls.indexOf(c) !== -1; }
    },
    appendChild: function (ch) { ch._parent = el; el.children.push(ch); return ch; },
    setAttribute: function (k, v) { el._attrs[k] = String(v); },
    getAttribute: function (k) { return (k in el._attrs) ? el._attrs[k] : null; },
    addEventListener: function (t, fn) { el._handlers[t] = fn; },
    closest: function (sel) {
      var node = el;
      while (node) {
        var m = /^\[data-([a-z0-9-]+)\]$/.exec(sel);
        if (m && node._attrs && ('data-' + m[1] in node._attrs)) return node;
        node = node._parent || null;
      }
      return null;
    },
    querySelectorAll: function () { return []; }
  };
  Object.defineProperty(el, 'className', {
    get: function () { return el._cls.join(' '); },
    set: function (v) { el._cls = String(v).split(/\s+/).filter(Boolean); }
  });
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return el._innerHTML; },
    set: function (v) { el._innerHTML = String(v); }
  });
  return el;
}
var registry = {};
var clickHandlers = [];
var noteInputs = {};
var fakeDocument = {
  getElementById: function (id) { return registry[id] || null; },
  createElement: function (tag) { return makeEl(tag); },
  addEventListener: function (t, fn) { if (t === 'click') clickHandlers.push(fn); },
  querySelector: function (sel) {
    var m = /^\[data-drexfx-review-note="([^"]+)"\]$/.exec(sel);
    if (m && noteInputs[m[1]]) return noteInputs[m[1]];
    return null;
  }
};
function reg(id) { var el = makeEl('div', id); registry[id] = el; return el; }
function dispatchClick(target) {
  var ev = { target: target, preventDefault: function () {} };
  var ps = [];
  clickHandlers.forEach(function (h) {
    try { var r = h(ev); if (r && typeof r.then === 'function') ps.push(r); } catch (e) {}
  });
  return Promise.all(ps);
}

/* ---------- DrexCloud simulado ---------- */
var OFFICIAL = 'uid-oficial-123';
var db = {
  effects: {
    fx_pub: { id: 'fx_pub', nombre: 'Sol', autorUid: 'u1', portada: '', tipo: 'cara',
      definicion: { filter: 'sepia(.5)' }, createdAt: 100, usos: 3, status: 'published' },
    fx_pen: { id: 'fx_pen', nombre: 'Luna', autorUid: 'u1', portada: '', tipo: 'fondo',
      definicion: { filter: 'hue-rotate(90deg)' }, createdAt: 200, usos: 0, status: 'pending' },
    fx_rej: { id: 'fx_rej', nombre: 'Mar', autorUid: 'u2', portada: '', tipo: 'juego',
      definicion: {}, createdAt: 50, usos: 0, status: 'rejected' },
    fx_leg: { id: 'fx_leg', nombre: 'Legacy', autorUid: 'u2', portada: '', createdAt: 10, usos: 1 }
  },
  userEmails: { 'darelvega20@gmail.com': OFFICIAL },
  users: { u1: { username: 'creador1' } }
};
function getPath(p) {
  var parts = String(p).split('/').filter(Boolean);
  var cur = db;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[parts[i]];
  }
  return (cur === undefined) ? null : JSON.parse(JSON.stringify(cur));
}
var updates = [];      // {path, obj}
var notifs = [];       // args de addNotification
var toasts = [];
var camCalls = [];     // llamadas a window.drexCameraOpen
var uidActual = OFFICIAL;

var sandbox = {
  console: console, Math: Math, Date: Date, JSON: JSON, Promise: Promise,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  window: {},
  document: fakeDocument,
  DrexCloud: {
    database: function () {
      return {
        ref: function (p) {
          return {
            once: function () { return Promise.resolve({ val: function () { return getPath(p); } }); },
            update: function (obj) { updates.push({ path: p, obj: obj }); return Promise.resolve(); },
            set: function (v) { updates.push({ path: p, obj: v, set: true }); return Promise.resolve(); }
          };
        }
      };
    },
    auth: function () { return { currentUser: uidActual ? { uid: uidActual } : null }; }
  },
  addNotification: function () { notifs.push(Array.prototype.slice.call(arguments)); return Promise.resolve(); },
  showMiniToast: function (m) { toasts.push(m); },
  getSpinnerMarkup: undefined
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'drex-effects-c219.js' });
sandbox.window.drexCameraOpen = function (def) { camCalls.push(def); };

var passed = 0, failed = 0;
var pending = [];   // tests puros/paralelos
var seq = Promise.resolve(); // tests con estado compartido: secuenciales
function test(name, fn) {
  try {
    var r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        function () { passed++; console.log('ok - ' + name); },
        function (e) { failed++; console.log('FALLO - ' + name + ': ' + (e && e.message)); }
      ));
    } else { passed++; console.log('ok - ' + name); }
  } catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}
function testSeq(name, fn) {
  seq = seq.then(function () { return fn(); }).then(
    function () { passed++; console.log('ok - ' + name); },
    function (e) { failed++; console.log('FALLO - ' + name + ': ' + (e && e.message)); }
  );
}
function run(expr) { return vm.runInContext(expr, sandbox); }
function ids(list) { return JSON.stringify(list.map(function (e) { return e.id; })); }
function resetOfficial() { uidActual = OFFICIAL; run('drexFxOfficialUidCache = null'); }
function finish() {
  console.log('\n' + passed + ' ok, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
}

/* ---------- normalización con status ---------- */
test('normaliza: status explícito se conserva; ausente => published (legacy)', function () {
  assert.strictEqual(run('drexFxNormalizeEffect({id:"a", status:"pending"}).status'), 'pending');
  assert.strictEqual(run('drexFxNormalizeEffect({id:"b"}).status'), 'published');
  assert.strictEqual(run('drexFxNormalizeEffect({id:"c", nombre:"X", definicion:{filter:"sepia(1)"}}).filter'), 'sepia(1)');
});

/* ---------- listados por autor (funciones puras) ---------- */
test('publishedByAuthor: solo publicados del autor, ordenados por fecha', function () {
  var normExpr = 'drexFxNormalizeEffects(' + JSON.stringify(db.effects) + ')';
  var u1 = vm.runInContext('drexFxPublishedByAuthor(' + normExpr + ', "u1")', sandbox);
  assert.strictEqual(ids(u1), '["fx_pub"]');
  var u2 = vm.runInContext('drexFxPublishedByAuthor(' + normExpr + ', "u2")', sandbox);
  assert.strictEqual(ids(u2), '["fx_leg"]', 'u2: solo el legacy cuenta como publicado');
  var all1 = vm.runInContext('drexFxEffectsByAuthor(' + normExpr + ', "u1")', sandbox);
  assert.strictEqual(ids(all1), '["fx_pen","fx_pub"]', 'el dueño ve todos los estados');
});

/* ---------- tarjeta: badges y Usar ---------- */
test('tarjeta: pending => badge "En revisión" + Usar deshabilitado', function () {
  var html = run('drexFxCardHTML({id:"fx_pen", nombre:"Luna", autorUid:"u1", portada:"", tipo:"fondo", filter:"", overlay:"", status:"pending", usos:0, createdAt:1}, {showStatus:true})');
  assert(html.indexOf('En revisión') !== -1, 'badge En revisión');
  assert(html.indexOf('disabled') !== -1, 'botón Usar deshabilitado');
});
test('tarjeta: rejected => badge "Rechazado" + Usar deshabilitado', function () {
  var html = run('drexFxCardHTML({id:"fx_rej", nombre:"Mar", autorUid:"u2", portada:"", tipo:"juego", filter:"", overlay:"", status:"rejected", usos:0, createdAt:1}, {showStatus:true})');
  assert(html.indexOf('Rechazado') !== -1, 'badge Rechazado');
  assert(html.indexOf('disabled') !== -1, 'botón Usar deshabilitado');
});
test('tarjeta: published => badge "Publicado" + Usar habilitado', function () {
  var html = run('drexFxCardHTML({id:"fx_pub", nombre:"Sol", autorUid:"u1", portada:"", tipo:"cara", filter:"", overlay:"", status:"published", usos:3, createdAt:1}, {showStatus:true})');
  assert(html.indexOf('Publicado') !== -1, 'badge Publicado');
  assert(html.indexOf('disabled') === -1, 'Usar habilitado');
  assert(html.indexOf('data-drexfx-usar="fx_pub"') !== -1, 'data attr para usar');
});
test('tarjeta: sin showStatus no hay insignia (vista de otro autor)', function () {
  var html = run('drexFxCardHTML({id:"fx_pub", nombre:"Sol", autorUid:"u1", portada:"", tipo:"cara", filter:"", overlay:"", status:"published", usos:3, createdAt:1})');
  assert(html.indexOf('En revisión') === -1 && html.indexOf('>Publicado<') === -1, 'sin badges en vista ajena');
});

/* ---------- markup y contrato ---------- */
test('markup: la sección de revisión existe y está oculta por defecto', function () {
  var i = src.indexOf('id="drexstudio-review"');
  assert(i !== -1, 'sección presente');
  assert(src.slice(i - 80, i + 40).indexOf('hidden') !== -1, 'oculta por defecto');
});
test('markup: la sección se evalúa en cada apertura de Drex Studio', function () {
  var i = src.indexOf('function initDrexStudioView(');
  assert(i !== -1, 'init encontrado');
  assert(src.slice(i, i + 4000).indexOf('drexStudioReviewMaybeInit') !== -1, 'init evalúa la bandeja');
});
test('contrato: el emisor decide status; el web nunca auto-publica terceros', function () {
  assert(src.indexOf('lo decide el EMISOR') !== -1, 'el emisor decide status');
  assert(src.indexOf('NUNCA auto-publica efectos ajenos') !== -1, 'prohibición explícita');
});
test('cuenta oficial: email y ruta del índice userEmails', function () {
  assert(src.indexOf("var drexFxOfficialEmail = 'darelvega20@gmail.com'") !== -1, 'email oficial');
  var i = src.indexOf('function drexFxOfficialUid(');
  assert(i !== -1, 'resolutor presente');
  assert(src.slice(i, i + 700).indexOf("'userEmails/' + drexFxOfficialEmail") !== -1, 'ruta userEmails/<email>');
});

/* ---------- i18n inline ---------- */
['Efecto sin título', 'Efecto de @{u}', 'Solicitudes de efectos',
 'En revisión', 'Rechazado', 'Publicado', 'Aprobar', 'Motivo (opcional)',
 'Este efecto aún no está publicado.', 'No hay solicitudes pendientes.',
 'Efecto aprobado.', 'Efecto rechazado.', 'Sin vista previa disponible.',
 'Revisa los efectos enviados por la comunidad antes de publicarlos.'
].forEach(function (k) {
  test('i18n: "' + k + '" inline con paridad EN/ZH/PT', function () {
    var n = src.split('"' + k + '"').length - 1;
    assert(n >= 3, 'aparece ' + n + ' veces en index.html, se esperaban >=3 (EN/ZH/PT)');
  });
});

/* ---------- secuencia con estado compartido ---------- */
testSeq('fetchAuthorEffects: propio => todo; ajeno => solo publicados', function () {
  return run('drexFxFetchAuthorEffects("u1", false)').then(function (pub) {
    assert.strictEqual(ids(pub), '["fx_pub"]', 'vista ajena: solo publicados');
    return run('drexFxFetchAuthorEffects("u1", true)');
  }).then(function (all) {
    assert.strictEqual(ids(all), '["fx_pen","fx_pub"]', 'dueño: todos, recientes primero');
  });
});

testSeq('useEffect: pending en caché NO abre la cámara y avisa', function () {
  run('drexFxCache = {fx_pen:{id:"fx_pen", nombre:"Luna", autorUid:"u1", portada:"", filter:"hue-rotate(90deg)", overlay:"", status:"pending"}}');
  toasts.length = 0; camCalls.length = 0;
  run('drexFxUseEffect("fx_pen")'); // ruta de caché: síncrona
  assert.strictEqual(camCalls.length, 0, 'la cámara no se abrió');
  assert(toasts.some(function (t) { return t.indexOf('aún no está publicado') !== -1; }), 'toast de no publicado');
  return Promise.resolve();
});

testSeq('useEffect: rejected en caché tampoco abre la cámara', function () {
  run('drexFxCache = {fx_rej:{id:"fx_rej", nombre:"Mar", autorUid:"u2", portada:"", filter:"", overlay:"", status:"rejected"}}');
  toasts.length = 0; camCalls.length = 0;
  run('drexFxUseEffect("fx_rej")'); // ruta de caché: síncrona
  assert.strictEqual(camCalls.length, 0, 'la cámara no se abrió');
  assert(toasts.some(function (t) { return t.indexOf('aún no está publicado') !== -1; }), 'toast de no publicado');
  return Promise.resolve();
});

testSeq('useEffect: published abre la cámara con la definición', function () {
  run('drexFxCache = {fx_pub:{id:"fx_pub", nombre:"Sol", autorUid:"u1", portada:"", filter:"sepia(.5)", overlay:"", status:"published"}}');
  camCalls.length = 0;
  run('drexFxUseEffect("fx_pub")'); // ruta de caché: síncrona
  assert.strictEqual(camCalls.length, 1, 'la cámara se abrió');
  assert.strictEqual(camCalls[0].effect.filter, 'sepia(.5)', 'definición completa');
  return Promise.resolve();
});

testSeq('useEffect: pending del servidor tampoco abre la cámara', function () {
  run('drexFxCache = {}'); // fuerza lectura del servidor
  toasts.length = 0; camCalls.length = 0;
  run('drexFxUseEffect("fx_pen")'); // rama de fetch: fire-and-forget
  return new Promise(function (res) { setTimeout(res, 40); }).then(function () {
    assert.strictEqual(camCalls.length, 0, 'bloqueado también en la rama de fetch');
    assert(toasts.some(function (t) { return t.indexOf('aún no está publicado') !== -1; }), 'toast de no publicado');
  });
});

testSeq('isOfficialAccount: solo el UID resuelto del email oficial', function () {
  resetOfficial();
  return run('drexFxIsOfficialAccount()').then(function (ok) {
    assert.strictEqual(ok, true, 'el UID oficial sí es oficial');
    uidActual = 'u1';
    run('drexFxOfficialUidCache = null');
    return run('drexFxIsOfficialAccount()');
  }).then(function (ok2) {
    assert.strictEqual(ok2, false, 'un UID común no es oficial');
    resetOfficial();
  });
});

testSeq('decidir: aprueba un pendiente (campos + notificación + refresco)', function () {
  resetOfficial();
  var list = reg('drexstudio-review-list');
  var n0 = updates.length, m0 = notifs.length;
  return run('drexStudioReviewDecide("fx_pen", true, "")').then(function (ok) {
    assert.strictEqual(ok, true, 'decisión exitosa');
    assert.strictEqual(updates.length - n0, 1, 'una escritura');
    var u = updates[updates.length - 1];
    assert.strictEqual(u.path, 'effects/fx_pen');
    assert.strictEqual(u.obj.status, 'published');
    assert.strictEqual(typeof u.obj.reviewedAt, 'number', 'reviewedAt numérico');
    assert.strictEqual(u.obj.reviewedBy, OFFICIAL);
    assert.strictEqual(notifs.length - m0, 1, 'una notificación');
    var n = notifs[notifs.length - 1];
    assert.strictEqual(n[0], 'u1', 'notificación al autor');
    assert(n[1].indexOf('aprobado') !== -1, 'mensaje de aprobación');
    assert.strictEqual(n[2], 'effect_review', 'tipo effect_review');
    assert.strictEqual(n[3].effectId, 'fx_pen');
    assert.strictEqual(n[3].decision, 'approved');
    return new Promise(function (res) { setTimeout(res, 40); });
  }).then(function () {
    assert(list.innerHTML.indexOf('fx_pen') !== -1, 'la bandeja se refrescó tras decidir');
  });
});

testSeq('decidir: rechaza con motivo (status rejected + reviewNote)', function () {
  resetOfficial();
  var n0 = updates.length, m0 = notifs.length;
  return run('drexStudioReviewDecide("fx_pen", false, "No cumple la guía")').then(function (ok) {
    assert.strictEqual(ok, true, 'decisión exitosa');
    assert.strictEqual(updates.length - n0, 1, 'una escritura');
    var u = updates[updates.length - 1];
    assert.strictEqual(u.obj.status, 'rejected');
    assert.strictEqual(u.obj.reviewNote, 'No cumple la guía');
    assert.strictEqual(u.obj.reviewedBy, OFFICIAL);
    assert.strictEqual(notifs.length - m0, 1, 'una notificación');
    var n = notifs[notifs.length - 1];
    assert.strictEqual(n[2], 'effect_review');
    assert.strictEqual(n[3].decision, 'rejected');
    assert(n[1].indexOf('no fue aprobado') !== -1, 'mensaje de rechazo');
  });
});

testSeq('decidir: un efecto que ya no está pendiente NO se toca', function () {
  resetOfficial();
  var n0 = updates.length, m0 = notifs.length;
  return run('drexStudioReviewDecide("fx_pub", true, "")').then(function (ok) {
    assert.strictEqual(ok, false, 'no decide sobre un publicado');
    assert.strictEqual(updates.length - n0, 0, 'sin escritura');
    assert.strictEqual(notifs.length - m0, 0, 'sin notificación');
  });
});

testSeq('decidir: FAIL-CLOSED — un no-oficial no puede decidir', function () {
  uidActual = 'u1'; // intruso
  run('drexFxOfficialUidCache = null');
  var n0 = updates.length, m0 = notifs.length;
  toasts.length = 0;
  return run('drexStudioReviewDecide("fx_pen", true, "")').then(function (ok) {
    assert.strictEqual(ok, false, 'decisión bloqueada');
    assert.strictEqual(updates.length - n0, 0, 'cero escrituras del intruso');
    assert.strictEqual(notifs.length - m0, 0, 'cero notificaciones del intruso');
    resetOfficial();
  });
});

testSeq('decidir: la guarda oficial vive DENTRO de la función', function () {
  var i = src.indexOf('function drexStudioReviewDecide(');
  assert(i !== -1, 'función encontrada');
  var body = src.slice(i, i + 900);
  assert(body.indexOf('drexFxIsOfficialAccount()') !== -1, 'la función verifica la cuenta oficial');
  assert(body.indexOf('return false') !== -1, 'falla cerrada');
  return Promise.resolve();
});

testSeq('bandeja: click en Aprobar aprueba (con motivo del input)', function () {
  resetOfficial();
  var n0 = updates.length, m0 = notifs.length;
  var btn = makeEl('button');
  btn.setAttribute('data-drexfx-review-approve', 'fx_pen');
  var inp = makeEl('input'); inp.value = 'Se ve bien';
  noteInputs['fx_pen'] = inp;
  return dispatchClick(btn).then(function () {
    return new Promise(function (res) { setTimeout(res, 60); });
  }).then(function () {
    assert.strictEqual(updates.length - n0, 1, 'el click aprobó');
    var u = updates[updates.length - 1];
    assert.strictEqual(u.path, 'effects/fx_pen');
    assert.strictEqual(u.obj.status, 'published');
    assert.strictEqual(notifs.length - m0, 1, 'notificación enviada');
    assert.strictEqual(notifs[notifs.length - 1][2], 'effect_review');
    delete noteInputs['fx_pen'];
  });
});

testSeq('bandeja: click en Rechazar rechaza con el motivo', function () {
  resetOfficial();
  var n0 = updates.length;
  var btn = makeEl('button');
  btn.setAttribute('data-drexfx-review-reject', 'fx_pen');
  var inp = makeEl('input'); inp.value = 'Falta portada';
  noteInputs['fx_pen'] = inp;
  return dispatchClick(btn).then(function () {
    return new Promise(function (res) { setTimeout(res, 60); });
  }).then(function () {
    assert.strictEqual(updates.length - n0, 1, 'el click rechazó');
    var u = updates[updates.length - 1];
    assert.strictEqual(u.obj.status, 'rejected');
    assert.strictEqual(u.obj.reviewNote, 'Falta portada');
    delete noteInputs['fx_pen'];
  });
});

Promise.all(pending.concat([seq])).then(finish);
