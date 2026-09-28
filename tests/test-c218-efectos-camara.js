/* ================================================================
 * Tests de regresión: C218 efectos de la cámara (2026-09-27;
 * C220: el panel inferior se eliminó por orden del usuario — la tira
 * ahora es superior, circular y estilo TikTok; estos tests cubren el
 * contrato nuevo (los checks del panel viejo viven en git, no aquí)
 * - El normalizador leía `e.name` pero el contrato real de Studio
 *   guarda `nombre` (además de `portada`, `autorUid`, `definicion`):
 *   `nombre` normalizado es contract-compatible (e.nombre || e.name || id)
 *   y el flag `tieneNombre` decide el render: sin nombre NUNCA se muestra
 *   el ID crudo ("Efecto de @usuario" o "Efecto sin título").
 * - El botón azul de captura tapaba las tarjetas: al abrir el panel
 *   se ocultan los controles; al cerrar se restauran.
 * - Tarjetas en diamante (mismo lenguaje que Destellos C215), tira
 *   horizontal con scroll-snap, anillo índigo #2F33B8 en la elegida.
 * - Solo `status:'published'` llega al catálogo (legacy = publicado).
 * Ejecutar con: node tests/test-c218-efectos-camara.js [--target <ruta>]
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
/* C218/C219: sus claves viven inline en index.html (IIFE drexFxC218C219I18nMerge);
 * drex-i18n.js queda intacto respecto a origin/main. */

var start = src.indexOf('/* === DREX-CAM v1');
var end = src.indexOf('/* === FIN DREX-CAM v1 === */');
assert(start !== -1 && end !== -1 && end > start, 'bloque DREX-CAM no encontrado');
var code = src.slice(start, end);

/* ---------- mini-DOM ---------- */
function makeEl(tag) {
  var el = {
    tagName: tag, children: [], _attrs: {}, _cls: [], style: {},
    dataset: {}, textContent: '', _innerHTML: '', offsetWidth: 0,
    _parent: null, _handlers: {},
    classList: {
      add: function (c) { if (el._cls.indexOf(c) === -1) el._cls.push(c); },
      remove: function (c) { el._cls = el._cls.filter(function (x) { return x !== c; }); },
      toggle: function (c, f) {
        var has = el._cls.indexOf(c) !== -1;
        var want = (f === undefined) ? !has : !!f;
        if (want && !has) el._cls.push(c);
        if (!want && has) el._cls = el._cls.filter(function (x) { return x !== c; });
        return want;
      },
      contains: function (c) { return el._cls.indexOf(c) !== -1; }
    },
    appendChild: function (ch) { ch._parent = el; el.children.push(ch); return ch; },
    removeChild: function (ch) {
      el.children = el.children.filter(function (x) { return x !== ch; }); return ch;
    },
    setAttribute: function (k, v) {
      el._attrs[k] = String(v);
      var m = /^data-([a-z0-9-]+)$/.exec(k);
      if (m) el.dataset[m[1].replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] = String(v);
    },
    getAttribute: function (k) { return (k in el._attrs) ? el._attrs[k] : null; },
    addEventListener: function (t, fn) { el._handlers[t] = fn; },
    closest: function (sel) {
      var node = el;
      while (node) {
        var m = /^\[data-([a-z0-9-]+)\]$/.exec(sel);
        if (m) { if (node._attrs && ('data-' + m[1] in node._attrs)) return node; }
        else if (sel.charAt(0) === '.') {
          if (node._cls && node._cls.indexOf(sel.slice(1)) !== -1) return node;
        }
        node = node._parent || null;
      }
      return null;
    },
    querySelectorAll: function (sel) {
      var out = [];
      var m = /^\[data-([a-z0-9-]+)(="([^"]*)")?\]$/.exec(sel);
      (function walk(n) {
        if (m && n._attrs && ('data-' + m[1] in n._attrs)) {
          if (m[2] === undefined || n._attrs['data-' + m[1]] === m[3]) out.push(n);
        }
        n.children.forEach(walk);
      })(el);
      return out;
    }
  };
  Object.defineProperty(el, 'firstChild', { get: function () { return el.children[0] || null; } });
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
var fakeDocument = {
  getElementById: function (id) { return registry[id] || null; },
  createElement: function (tag) { return makeEl(tag); },
  addEventListener: function () {}
};
function reg(id) { var el = makeEl('div'); registry[id] = el; return el; }

var sandbox = {
  console: console, Math: Math, Date: Date, JSON: JSON, Promise: Promise,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  setInterval: setInterval, clearInterval: clearInterval,
  window: {}, document: fakeDocument
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'drex-cam-c218.js' });

var passed = 0, failed = 0;
var pending = [];
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
function run(expr) { return vm.runInContext(expr, sandbox); }
function finish() {
  console.log('\n' + passed + ' ok, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
}

/* ---------- normalizador: nombre/portada/autorUid/status ---------- */
test('normaliza: `nombre` tiene prioridad sobre `name` legacy', function () {
  var out = run('drexCamNormalizeEffects({a:{nombre:"Brillo", name:"Viejo"}})');
  assert.strictEqual(out[0].nombre, 'Brillo');
  assert.strictEqual(out[0].name, 'Brillo', 'alias legacy sigue el nombre real');
});

test('normaliza: acarrea portada, autorUid y status', function () {
  var out = run('drexCamNormalizeEffects({a:{nombre:"X", portada:"https://x/p.png", autorUid:"u1", status:"pending"}})');
  assert.strictEqual(out[0].portada, 'https://x/p.png');
  assert.strictEqual(out[0].autorUid, 'u1');
  assert.strictEqual(out[0].status, 'pending');
});

test('normaliza: lee filter/overlay de `definicion` (contrato Studio)', function () {
  var out = run('drexCamNormalizeEffects({a:{nombre:"X", definicion:{filter:"sepia(.5)", overlay:"linear-gradient(red,blue)"}}})');
  assert.strictEqual(out[0].filter, 'sepia(.5)');
  assert.strictEqual(out[0].overlay, 'linear-gradient(red,blue)');
});

test('normaliza: legacy sin status => published; sin nombre => nombre=ID (contrato) + tieneNombre=false', function () {
  var out = run('drexCamNormalizeEffects({fx9:{filter:"grayscale(1)"}})');
  assert.strictEqual(out[0].status, 'published');
  assert.strictEqual(out[0].nombre, 'fx9', 'contrato: nombre = e.nombre || e.name || id');
  assert.strictEqual(out[0].tieneNombre, false, 'el flag preserva que no hay nombre real');
  assert.strictEqual(out[0].name, 'fx9', 'alias legacy contract-compatible');
  assert.strictEqual(out[0].id, 'fx9');
});

test('normaliza: con nombre real => tieneNombre=true y el nombre se conserva', function () {
  var out = run('drexCamNormalizeEffects({a:{nombre:"Brillo"}})');
  assert.strictEqual(out[0].nombre, 'Brillo');
  assert.strictEqual(out[0].tieneNombre, true);
});

test('compat: el caso legacy de c209 sigue verde (name/filter a raíz)', function () {
  var out = run('drexCamNormalizeEffects({a:{name:"Neon"},b:{id:"custom",name:"Retro",filter:"sepia(.8)"}})');
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].name, 'Neon');
  assert.strictEqual(out[1].id, 'custom');
  assert.strictEqual(out[1].filter, 'sepia(.8)');
});

/* ---------- filtro published ---------- */
test('drexCamPublishedOnly: filtra pending/rejected, conserva published y legacy', function () {
  var n = run('drexCamPublishedOnly([{status:"published"},{status:"pending"},{status:"rejected"},{}]).length');
  assert.strictEqual(n, 2);
});

/* ---------- etiqueta visible: nunca el ID crudo ---------- */
test('etiqueta: con nombre devuelve el nombre', function () {
  assert.strictEqual(run('drexCamEffectLabel("Neon","juan")'), 'Neon');
});
test('etiqueta: sin nombre + usuario => "Efecto de @usuario"', function () {
  assert.strictEqual(run('drexCamEffectLabel("","juan")'), 'Efecto de @juan');
});
test('etiqueta: sin nombre ni usuario => "Efecto sin título", jamás el ID', function () {
  var label = run('drexCamEffectLabel("","")');
  assert.strictEqual(label, 'Efecto sin título');
  assert(label.indexOf('fx-9f3') === -1, 'el ID no debe filtrarse');
});

/* ---------- C220: tira superior (reemplaza el panel inferior) ---------- */
test('tira: drexCamSetFxTopVisible muestra/oculta la tira superior', function () {
  var top = reg('drex-cam-fx-topbar');
  top.classList.add('hidden');
  run('drexCamSetFxTopVisible(true)');
  assert(!top.classList.contains('hidden'), 'tira visible');
  run('drexCamSetFxTopVisible(false)');
  assert(top.classList.contains('hidden'), 'tira oculta');
});
test('tira: con error de cámara la tira se oculta', function () {
  reg('drex-cam-error'); reg('drex-cam-controls'); reg('drex-cam-topbar');
  var top = reg('drex-cam-fx-topbar');
  run('drexCamShowError()');
  assert(top.classList.contains('hidden'), 'tira oculta en error');
});
test('guard: grabando no se puede cambiar de efecto (como TikTok)', function () {
  var list = reg('drex-cam-fx-list');
  run('drexCamRecording = true');
  run('drexCamSelectedEffect = null');
  run('drexCamEffects = drexCamNormalizeEffects({fx1:{nombre:"Neon"}})');
  run('drexCamRenderEffects()');
  var card = list.children[1];
  card._handlers.click();
  assert.strictEqual(run('drexCamSelectedEffect'), null, 'no cambia grabando');
  run('drexCamRecording = false');
});
test('abrir/cerrar cámara deja la tira visible solo con la cámara abierta', function () {
  var modal = reg('drex-cam-modal');
  var preview = reg('drex-cam-preview');
  preview.play = function () { return Promise.resolve(); };
  sandbox.navigator = { mediaDevices: { getUserMedia: function () {
    return Promise.resolve({ getTracks: function () { return []; } });
  } } };
  var top = reg('drex-cam-fx-topbar');
  run('drexCameraOpen({})');
  return new Promise(function (res) { setTimeout(res, 30); }).then(function () {
    assert(!top.classList.contains('hidden'), 'tira visible al abrir');
    assert(!modal.classList.contains('hidden'), 'open muestra el modal');
    run('drexCameraClose()');
    assert(modal.classList.contains('hidden'), 'close oculta el modal (y con él la tira)');
    assert(top.classList.contains('hidden') || modal.classList.contains('hidden'), 'tira fuera de vista al cerrar');
  });
});

/* ---------- render: círculos estilo TikTok ---------- */
test('render: tarjetas circulares con foto; la elegida con anillo índigo', function () {
  /* fx2 pasa por el normalizador real: nombre='fx2' (contrato) + tieneNombre=false */
  run('drexCamEffects = drexCamNormalizeEffects({fx1:{nombre:"Neon", portada:"https://x/p.png", autorUid:""}, fx2:{portada:"", autorUid:"u9"}})');
  run('drexCamSelectedEffect = null');
  run('drexCamRenderEffects()');
  var list = registry['drex-cam-fx-list'];
  assert.strictEqual(list.children.length, 3, 'Sin efecto + 2 efectos');
  var none = list.children[0];
  assert(none.className.indexOf('drex-cam-fx-tsel') !== -1, '"Sin efecto" seleccionada por defecto');
  var card = list.children[1];
  assert(card.className.indexOf('drex-cam-fx-tcard') !== -1, 'clase de tarjeta circular');
  assert(card.children[0].className === 'drex-cam-fx-tcircle', 'círculo primero');
  var img = card.children[0].children[0];
  assert.strictEqual(img.tagName, 'img', 'la portada va en <img>');
  assert.strictEqual(card.children[1].className, 'drex-cam-fx-tname');
  assert.strictEqual(card.children[1].textContent, 'Neon');
});

test('render: sin nombre muestra fallback (nunca ID)', function () {
  var list = registry['drex-cam-fx-list'];
  var card = list.children[2];
  var nameEl = card.children[1];
  assert.strictEqual(nameEl.textContent, 'Efecto sin título');
  assert(nameEl.textContent.indexOf('fx2') === -1, 'el ID crudo no aparece');
});

test('render: click selecciona el efecto y mueve el anillo', function () {
  var list = registry['drex-cam-fx-list'];
  var card = list.children[1]; // fx1
  card._handlers.click();
  var sel = run('drexCamSelectedEffect && drexCamSelectedEffect.id');
  assert.strictEqual(sel, 'fx1');
  run('drexCamRenderEffects()');
  var card2 = registry['drex-cam-fx-list'].children[2];
  assert(card2.className.indexOf('drex-cam-fx-tsel') === -1, 'la no elegida no tiene anillo');
  var card1 = registry['drex-cam-fx-list'].children[1];
  assert(card1.className.indexOf('drex-cam-fx-tsel') !== -1, 'la elegida tiene anillo índigo');
});

test('resolveUsername: resuelve y cachea (una sola lectura)', function () {
  var reads = 0;
  sandbox.DrexCloud = {
    database: function () {
      return { ref: function (p) {
        return { once: function () {
          reads++;
          return Promise.resolve({ val: function () { return p === 'users/u9' ? { username: 'juan9' } : null; } });
        } };
      } };
    }
  };
  return run('drexCamResolveUsername("u9")').then(function (n) {
    assert.strictEqual(n, 'juan9');
    return run('drexCamResolveUsername("u9")');
  }).then(function (n2) {
    assert.strictEqual(n2, 'juan9');
    assert.strictEqual(reads, 1, 'la segunda resolución usa caché');
  });
});

test('render: tras resolver, la etiqueta pasa a "Efecto de @usuario"', function () {
  sandbox.DrexCloud = {
    database: function () {
      return { ref: function () {
        return { once: function () {
          return Promise.resolve({ val: function () { return { username: 'juan9' }; } });
        } };
      } };
    }
  };
  /* nombre='fx2' (truthy por contrato) pero tieneNombre=false: el fallback
   * async debe aplicarse por el flag, no por !ef.nombre */
  run('drexCamEffects = drexCamNormalizeEffects({fx2:{portada:"", autorUid:"u9"}})');
  run('drexCamSelectedEffect = null');
  run('drexCamRenderEffects()');
  return new Promise(function (res) { setTimeout(res, 40); }).then(function () {
    var list = registry['drex-cam-fx-list'];
    var nodes = list.querySelectorAll('[data-drexfx-eflabel="fx2"]');
    assert(nodes.length > 0, 'nodo de etiqueta encontrado');
    assert.strictEqual(nodes[0].textContent, 'Efecto de @juan9');
    delete sandbox.DrexCloud;
  });
});

/* ---------- markup + CSS (C220: tira superior) ---------- */
test('markup: la tira de efectos va arriba (topbar), nada abajo', function () {
  assert(src.indexOf('id="drex-cam-fx-topbar"') !== -1, 'topbar presente');
  assert(src.indexOf('id="drex-cam-fx-list"') !== -1, 'lista presente');
  assert(src.indexOf('id="drex-cam-effects-panel"') === -1, 'sin panel inferior');
  assert(src.indexOf('id="drex-cam-effects-btn"') === -1, 'sin botón inferior');
});
test('markup: la lista es tira horizontal con scroll-snap', function () {
  assert(src.indexOf('#drex-cam-fx-list') !== -1, 'selector de lista');
  assert(src.indexOf('overflow-x: auto') !== -1 || src.indexOf('overflow-x:auto') !== -1, 'scroll horizontal');
});
test('CSS: snap horizontal obligatorio + inercia WebKit', function () {
  assert(src.indexOf('scroll-snap-type: x mandatory') !== -1, 'snap mandatory');
  assert(src.indexOf('-webkit-overflow-scrolling: touch') !== -1, 'inercia iOS');
});
test('CSS: círculo + anillo índigo #2F33B8 en la elegida', function () {
  var i = src.indexOf('.drex-cam-fx-tcard.drex-cam-fx-tsel .drex-cam-fx-tcircle');
  assert(i !== -1, 'regla de seleccionada');
  var rule = src.slice(i, i + 160);
  assert(rule.indexOf('#2F33B8') !== -1, 'anillo índigo #2F33B8');
});
test('CSS: en pantallas bajas la tira se compacta', function () {
  var i = src.indexOf('@media (max-height: 640px)');
  assert(i !== -1, 'media query de altura');
  var rule = src.slice(i, i + 400);
  assert(rule.indexOf('#drex-cam-fx-topbar') !== -1, 'topbar en el media');
});

test('cámara: el catálogo filtra por status published', function () {
  var i = src.indexOf('function drexCameraLoadEffects()');
  var body = src.slice(i, i + 900);
  /* C223: el filtro published-only se aplica sobre el catalogo fusionado
   * (canonico effects/ + legado public/effects/ de Studio). */
  assert(body.indexOf('drexCamPublishedOnly(drexCamNormalizeEffects(') !== -1,
    'drexCameraLoadEffects filtra publicados');
});

/* ---------- i18n ---------- */
['Efecto sin título', 'Efecto de @{u}'].forEach(function (k) {
  test('i18n inline: "' + k + '" con paridad EN/ZH/PT', function () {
    var n = src.split('"' + k + '"').length - 1;
    assert(n >= 3, 'aparece ' + n + ' veces en index.html, se esperaban >=3');
  });
});

Promise.all(pending).then(finish);
