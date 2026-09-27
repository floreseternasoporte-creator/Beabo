/* ================================================================
 * Tests de regresión: C218 panel de efectos de la cámara (2026-09-27)
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

/* ---------- overlap: controles vs panel ---------- */
test('toggle: al abrir el panel se ocultan los controles', function () {
  reg('drex-cam-effects-panel'); reg('drex-cam-effects-panel-inner');
  reg('drex-cam-effects-list'); reg('drex-cam-effects-empty');
  var ctrls = reg('drex-cam-controls');
  run('drexCamEffectsOpen = false');
  run('drexCameraToggleEffects()');
  assert(ctrls.classList.contains('hidden'), 'controles ocultos con el panel abierto');
  assert.strictEqual(run('drexCamEffectsOpen'), true);
});
test('cerrar panel: se restauran los controles', function () {
  var ctrls = registry['drex-cam-controls'];
  run('drexCameraCloseEffects()');
  assert(!ctrls.classList.contains('hidden'), 'controles visibles al cerrar el panel');
  assert.strictEqual(run('drexCamEffectsOpen'), false);
});
test('cerrar panel con error visible: NO pisa el estado de error', function () {
  var ctrls = registry['drex-cam-controls'];
  var err = reg('drex-cam-error');
  err.classList.remove('hidden'); // error visible
  ctrls.classList.add('hidden');
  run('drexCameraToggleEffects()'); // abre -> oculta controles
  assert.strictEqual(run('drexCamEffectsOpen'), true, 'el panel se abrió');
  run('drexCameraCloseEffects()');  // cierra -> debe respetar el error
  assert(ctrls.classList.contains('hidden'), 'con error visible los controles siguen ocultos');
  err.classList.add('hidden');
});
test('abrir/cerrar cámara deja los controles visibles', function () {
  var ctrls = registry['drex-cam-controls'];
  var modal = reg('drex-cam-modal');
  var preview = reg('drex-cam-preview');
  preview.play = function () { return Promise.resolve(); };
  sandbox.navigator = { mediaDevices: { getUserMedia: function () {
    return Promise.resolve({ getTracks: function () { return []; } });
  } } };
  ctrls.classList.add('hidden');
  run('drexCameraOpen({})');
  assert(!ctrls.classList.contains('hidden'), 'open restaura controles');
  assert(!modal.classList.contains('hidden'), 'open muestra el modal');
  ctrls.classList.add('hidden');
  run('drexCameraClose()');
  assert(!ctrls.classList.contains('hidden'), 'close restaura controles');
  assert(modal.classList.contains('hidden'), 'close oculta el modal');
});

/* ---------- render: diamantes + carrusel ---------- */
test('render: tarjetas en diamante con anillo y foto; la elegida con anillo índigo', function () {
  /* fx2 pasa por el normalizador real: nombre='fx2' (contrato) + tieneNombre=false */
  run('drexCamEffects = drexCamNormalizeEffects({fx1:{nombre:"Neon", portada:"https://x/p.png", autorUid:""}, fx2:{portada:"", autorUid:"u9"}})');
  run('drexCamSelectedEffect = null');
  run('drexCamRenderEffects()');
  var list = registry['drex-cam-effects-list'];
  assert.strictEqual(list.children.length, 3, 'Sin efecto + 2 efectos');
  var none = list.children[0];
  assert(none.className.indexOf('drex-cam-fx-sel') !== -1, '"Sin efecto" seleccionada por defecto');
  assert(none.className.indexOf('drex-cam-chip-sel') === -1, 'sin chip legacy');
  var card = list.children[1];
  assert(card.className.indexOf('drex-cam-fx-card') !== -1, 'clase de tarjeta');
  var dia = card.children[0];
  assert.strictEqual(dia.className, 'drex-cam-fx-dia');
  assert.strictEqual(dia.children[0].className, 'drex-cam-fx-ring', 'anillo del diamante');
  assert.strictEqual(dia.children[1].className, 'drex-cam-fx-photo', 'foto enderezada dentro');
  var img = dia.children[1].children[0];
  assert.strictEqual(img.tagName, 'img', 'la portada va en <img>');
  assert.strictEqual(card.children[1].className, 'drex-cam-fx-name');
  assert.strictEqual(card.children[1].textContent, 'Neon');
});

test('render: sin nombre muestra fallback (nunca ID) y línea de autor vacía', function () {
  var list = registry['drex-cam-effects-list'];
  var card = list.children[2];
  var nameEl = card.children[1];
  assert.strictEqual(nameEl.textContent, 'Efecto sin título');
  assert(nameEl.textContent.indexOf('fx2') === -1, 'el ID crudo no aparece');
  assert.strictEqual(card.children[2].className, 'drex-cam-fx-author', 'línea de autor');
});

test('render: click selecciona el efecto y mueve el anillo', function () {
  var list = registry['drex-cam-effects-list'];
  var card = list.children[1]; // fx1
  card._handlers.click();
  var sel = run('drexCamSelectedEffect && drexCamSelectedEffect.id');
  assert.strictEqual(sel, 'fx1');
  var card2 = list.children[2];
  assert(card2.className.indexOf('drex-cam-fx-sel') === -1, 'la no elegida no tiene anillo');
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
    var list = registry['drex-cam-effects-list'];
    var nodes = list.querySelectorAll('[data-drexfx-eflabel="fx2"]');
    assert(nodes.length > 0, 'nodo de etiqueta encontrado');
    assert.strictEqual(nodes[0].textContent, 'Efecto de @juan9');
    var anodes = list.querySelectorAll('[data-drexfx-efauthor="fx2"]');
    assert(anodes.length > 0 && anodes[0].textContent === '@juan9', 'línea de autor con @usuario');
    delete sandbox.DrexCloud;
  });
});

/* ---------- markup + CSS ---------- */
test('markup: el panel va por encima de los controles (z-index)', function () {
  assert(src.indexOf('id="drex-cam-effects-panel" class="absolute bottom-0 left-0 right-0 hidden" style="z-index:30"') !== -1,
    'panel con z-index:30');
});
test('markup: la lista es tira horizontal, ya no grid de 4', function () {
  assert(src.indexOf('id="drex-cam-effects-list" class="drex-cam-fx-row pb-2"') !== -1, 'clase drex-cam-fx-row');
  assert(src.indexOf('id="drex-cam-effects-list" class="grid grid-cols-4') === -1, 'sin grid viejo');
});
test('CSS: snap horizontal obligatorio + scrollbar oculto', function () {
  assert(src.indexOf('scroll-snap-type: x mandatory') !== -1, 'snap mandatory');
  assert(src.indexOf('scroll-snap-align: center') !== -1, 'snap-align center');
  assert(src.indexOf('#drex-cam-effects-list.drex-cam-fx-row::-webkit-scrollbar') !== -1, 'scrollbar oculto');
});
test('CSS: diamante con clip-path + anillo índigo #2F33B8 en la elegida', function () {
  assert(src.indexOf('clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)') !== -1, 'clip-path diamante');
  assert(src.indexOf('.drex-cam-fx-sel .drex-cam-fx-ring') !== -1, 'regla de seleccionada');
  var i = src.indexOf('.drex-cam-fx-sel .drex-cam-fx-ring');
  var rule = src.slice(i, i + 160);
  assert(rule.indexOf('#2F33B8') !== -1, 'anillo índigo #2F33B8');
});
test('CSS: en pantallas bajas el panel no tapa el visor', function () {
  var i = src.indexOf('@media (max-height: 640px)');
  assert(i !== -1, 'media query de altura');
  var rule = src.slice(i, i + 220);
  assert(rule.indexOf('#drex-cam-effects-panel-inner') !== -1 && rule.indexOf('44%') !== -1,
    'max-height reducida en pantallas bajas');
});
test('cámara: el catálogo filtra por status published', function () {
  var i = src.indexOf('function drexCameraLoadEffects()');
  var body = src.slice(i, i + 700);
  assert(body.indexOf("drexCamPublishedOnly(drexCamNormalizeEffects(val))") !== -1,
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
