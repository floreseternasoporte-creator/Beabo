/* ================================================================
 * Tests de regresión: DREX-EFFECTS v1 — pestaña "Efectos" en perfiles
 * + botón "Usar" (2026-09-27)
 *
 * Cubre:
 *  1. El bloque /* === DREX-EFFECTS v1 === *\/ existe una sola vez y su JS
 *     tiene sintaxis válida (vm.Script).
 *  2. Lógica pura en sandbox: normalización al contrato
 *     {id,nombre,autorUid,portada,tipo,definicion,createdAt,usos,status},
 *     filtro published+autor (ordenados), update atómico de `usos`,
 *     saneado de ids y etiquetas de tipo.
 *  3. Flujo "Usar" con DrexCloud simulado: resuelve la definición y llama
 *     window.drexCameraOpen({effect: <def>}) con el OBJETO (con id), nunca
 *     con el id suelto; no abre efectos 'pending'.
 *  4. drexFxBumpUsos: transacción sobre effects/<id>/usos (5->6, null->1).
 *  5. Cableado en index.html: botón data-tab="efectos", contenido del tab,
 *     lista y header del perfil propio, sección del autor, hooks en el
 *     cambiador de tabs, en el cargador del autor y en
 *     publishNoteToDatabase (incremento de usos).
 *  6. Validadores: id-references (todo getElementById del bloque existe),
 *     sin onclick inline en el bloque (delegación por data-drexfx-usar),
 *     sin overlays fixed nuevos, tokens var(--*) usados existen en CSS,
 *     paridad i18n ES/EN/ZH/PT de las claves nuevas.
 *
 * Ejecutar con: node tests/test-c210-effects.js [--target <ruta-index.html>]
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

var i18nPath = path.join(path.dirname(target), 'drex-i18n.js');
if (!fs.existsSync(i18nPath)) i18nPath = path.join(__dirname, '..', 'drex-i18n.js');

var START = '/* === DREX-EFFECTS v1';
var END = '/* === FIN DREX-EFFECTS v1 === */';
var start = src.indexOf(START);
var end = src.indexOf(END);
assert(start !== -1 && end !== -1 && end > start, 'bloque DREX-EFFECTS v1 no encontrado en ' + target);
assert(src.indexOf(START, start + 1) === -1, 'el bloque DREX-EFFECTS v1 aparece más de una vez (inicio)');
assert(src.indexOf(END, end + 1) === -1, 'el bloque DREX-EFFECTS v1 aparece más de una vez (fin)');
var code = src.slice(start, end + END.length);

var passed = 0, failed = 0;
var pending = [];
function test(name, fn) {
  try {
    var r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(function () { passed++; console.log('ok - ' + name); },
        function (e) { failed++; console.log('FALLO - ' + name + ': ' + (e && e.message)); }));
    } else { passed++; console.log('ok - ' + name); }
  }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

/* ---------- 1. Sintaxis ---------- */
test('sintaxis JS del bloque válida', function () {
  new vm.Script(code, { filename: 'drex-effects-v1.js' });
});

var sandbox = {
  console: console, Math: Math, Date: Date, JSON: JSON, Promise: Promise,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  setInterval: setInterval, clearInterval: clearInterval,
  window: {}
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'drex-effects-v1.js' });
function run(expr) { return vm.runInContext(expr, sandbox); }

/* ---------- 2. Lógica pura ---------- */
test('drexFxNormalizeEffect: mapea el contrato completo', function () {
  var fx = run("drexFxNormalizeEffect({nombre:'Neón',autorUid:'u1',portada:'https://x/y.png',tipo:'cara',definicion:{filter:'sepia(.8)'},createdAt:123,usos:7,status:'published'},'fx1')");
  assert.strictEqual(fx.id, 'fx1');
  assert.strictEqual(fx.nombre, 'Neón');
  assert.strictEqual(fx.autorUid, 'u1');
  assert.strictEqual(fx.portada, 'https://x/y.png');
  assert.strictEqual(fx.tipo, 'cara');
  assert.strictEqual(fx.filter, 'sepia(.8)');
  assert.strictEqual(fx.createdAt, 123);
  assert.strictEqual(fx.usos, 7);
  assert.strictEqual(fx.status, 'published');
});

test('drexFxNormalizeEffect: acepta alias del catálogo DREX-CAM v1', function () {
  var fx = run("drexFxNormalizeEffect({name:'Retro',authorUid:'u2',icon:'i.png',filter:'grayscale(1)'},'fx2')");
  assert.strictEqual(fx.nombre, 'Retro');
  assert.strictEqual(fx.autorUid, 'u2');
  assert.strictEqual(fx.portada, 'i.png');
  assert.strictEqual(fx.filter, 'grayscale(1)');
});

test('drexFxNormalizeEffect: tipo inválido -> "", status ausente -> published, usos NaN -> 0', function () {
  var fx = run("drexFxNormalizeEffect({tipo:'raro',usos:'xx'},'fx3')");
  assert.strictEqual(fx.tipo, '');
  assert.strictEqual(fx.status, 'published');
  assert.strictEqual(fx.usos, 0);
});

test('drexFxNormalizeEffects: null/no-objeto -> []', function () {
  assert.strictEqual(run('drexFxNormalizeEffects(null).length'), 0);
  assert.strictEqual(run("drexFxNormalizeEffects('x').length"), 0);
});

test('drexFxPublishedByAuthor: solo published del autor, recientes primero', function () {
  var list = run("[{id:'a',autorUid:'u1',status:'published',createdAt:1}," +
    "{id:'b',autorUid:'u1',status:'pending',createdAt:99}," +
    "{id:'c',autorUid:'u2',status:'published',createdAt:50}," +
    "{id:'d',autorUid:'u1',status:'published',createdAt:10}]");
  var out = run('drexFxPublishedByAuthor(' + JSON.stringify(list).replace(/'/g, "\\'") + ",'u1')");
  // Nota: el array cruza realms; se verifica por JSON.
  var ids = JSON.parse(run('JSON.stringify(drexFxPublishedByAuthor(' +
    JSON.stringify(list) + ",'u1').map(function(f){return f.id;}))"));
  assert.deepStrictEqual(ids, ['d', 'a']);
});

test('drexFxCountUpdate: 5->6, null->1, "x"->1, -3->1', function () {
  assert.strictEqual(run('drexFxCountUpdate(5)'), 6);
  assert.strictEqual(run('drexFxCountUpdate(null)'), 1);
  assert.strictEqual(run("drexFxCountUpdate('x')"), 1);
  assert.strictEqual(run('drexFxCountUpdate(-3)'), 1);
  assert.strictEqual(run('drexFxCountUpdate(0)'), 1);
});

test('drexFxSanitizeId: quita caracteres peligrosos de path', function () {
  assert.strictEqual(run("drexFxSanitizeId('a.b/c#d$e[f]g')"), 'a_b_c_d_e_f_g');
});

test('drexFxTypeLabel: los 4 tipos tienen etiqueta no vacía', function () {
  ['cara', 'fondo', 'juego', 'codigo'].forEach(function (t) {
    var lbl = run("drexFxTypeLabel('" + t + "')");
    assert(lbl && lbl.length > 0, 'sin etiqueta para ' + t);
  });
  assert.strictEqual(run("drexFxTypeLabel('otro')"), '');
});

test('drexFxCardHTML: escapa el nombre y expone data-drexfx-usar', function () {
  var html = run("drexFxCardHTML({id:'fx1',nombre:'<img onerror=x>',tipo:'cara',usos:3,portada:'',filter:'',overlay:''})");
  assert(html.indexOf('<img onerror=x>') === -1, 'nombre sin escapar');
  assert(html.indexOf('&lt;img') !== -1, 'nombre escapado');
  assert(html.indexOf('data-drexfx-usar="fx1"') !== -1, 'botón Usar con data attr');
  assert(html.indexOf('3') !== -1, 'contador de usos visible');
});

test('drexFxSafeImg: rechaza javascript: y acepta https/data', function () {
  assert.strictEqual(run("drexFxSafeImg('javascript:alert(1)')"), '');
  assert.strictEqual(run("drexFxSafeImg('https://x/y.png')"), 'https://x/y.png');
  assert(run("drexFxSafeImg('data:image/png;base64,xx')").indexOf('data:image') === 0);
});

/* ---------- 3. Flujo "Usar" (mocks) ---------- */
var __mockSeq = 0;
function installMocks() {
  __mockSeq++;
  var arr = '__calls' + __mockSeq;
  run('var ' + arr + ' = [];');
  run('window.drexCameraOpen = function (opts) { ' + arr + '.push(opts); };');
  run('DrexCloud = { database: function () { return { ref: function (p) { return __refFor(p); } }; } };');
  return arr;
}

test('drexFxUseEffect: con def en caché abre la cámara con el OBJETO (no el id)', function () {
  var arr = installMocks();
  run("drexFxCache['fx9'] = {id:'fx9',nombre:'N',filter:'sepia(1)',overlay:'',autorUid:'u1',status:'published'};");
  run("drexFxUseEffect('fx9');");
  var got = run(arr + '[0]');
  assert(got && got.effect, 'drexCameraOpen no fue llamado con {effect}');
  assert.strictEqual(got.effect.id, 'fx9', 'debe pasar el objeto definición con id');
  assert.strictEqual(got.effect.filter, 'sepia(1)');
});

/* ---------- 4. Bump de usos ---------- */
test('drexFxBumpUsos: transacción sobre effects/<id>/usos', function () {
  installMocks();
  run('var __txPath = null, __txFn = null;');
  run("__refFor = function (p) { return { transaction: function (fn) { __txPath = p; __txFn = fn; return Promise.resolve({committed:true}); } }; };");
  run("drexFxBumpUsos('fx1');");
  assert.strictEqual(run('__txPath'), 'effects/fx1/usos');
  assert.strictEqual(run('__txFn(41)'), 42, 'la fn de transacción suma 1');
});

test('drexFxBumpUsos: id vacío o sin DrexCloud no revienta', function () {
  run("drexFxBumpUsos('');");
  run("DrexCloud = undefined; drexFxBumpUsos('fx1');");
});

test('drexFxUseEffect: fetch published abre / pending no abre (secuencial)', function () {
  var arr = installMocks();
  run("__refFor = function (p) { return { once: function () { return Promise.resolve({ val: function () { return p === 'effects/fxP' ? {nombre:'P',autorUid:'u1',status:'published',definicion:{filter:'x'}} : {nombre:'Q',status:'pending'}; } }); } }; };");
  return run("(async function(){ var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms);});}; drexFxUseEffect('fxP'); await sleep(60); drexFxUseEffect('fxQ'); await sleep(60); })()").then(function () {
    var n = run(arr + '.length');
    assert.strictEqual(n, 1, 'solo el publicado debe abrir la cámara');
    assert.strictEqual(run(arr + '[0].effect.id'), 'fxP', 'debió abrir con la def publicada');
  });
});


/* ---------- 5. Cableado en index.html ---------- */
test('botón de tab Efectos en la navegación del perfil', function () {
  assert(src.indexOf('data-tab="efectos"') !== -1, 'falta button data-tab="efectos"');
});

test('contenido del tab: #efectos-tab-content con lista y header', function () {
  assert(src.indexOf('id="efectos-tab-content"') !== -1, 'falta #efectos-tab-content');
  assert(src.indexOf('id="profile-efectos-list"') !== -1, 'falta #profile-efectos-list');
  assert(src.indexOf('id="profile-efectos-header"') !== -1, 'falta #profile-efectos-header');
});

test('sección de efectos en el modal de perfil de autor', function () {
  assert(src.indexOf('id="author-profile-efectos-list"') !== -1, 'falta #author-profile-efectos-list');
});

test('hook: el cambiador de tabs carga la pestaña efectos', function () {
  assert(src.indexOf("tabName === 'efectos'") !== -1, 'el switch de tabs no maneja efectos');
  assert(src.indexOf('drexFxLoadProfileTab') !== -1, 'falta llamada a drexFxLoadProfileTab');
});

test('hook: el cargador del autor pinta la sección de efectos', function () {
  assert(src.indexOf('drexFxLoadAuthorTab') !== -1, 'falta llamada a drexFxLoadAuthorTab');
  assert(src.indexOf("getElementById('author-profile-efectos-list')") !== -1, 'no se referencia la lista del autor');
});

test('hook: publishNoteToDatabase incrementa usos con note.effectId', function () {
  var i = src.indexOf('function publishNoteToDatabase');
  assert(i !== -1, 'publishNoteToDatabase no encontrada');
  var body = src.slice(i, i + 12000);
  assert(body.indexOf('drexFxBumpUsos(note.effectId)') !== -1, 'falta el hook de usos en publishNoteToDatabase');
});

/* ---------- 6. Validadores ---------- */
test('id-references: todo getElementById del bloque existe en el HTML', function () {
  var re = /getElementById\('([^']+)'\)/g, m, missing = [];
  var seen = {};
  while ((m = re.exec(code)) !== null) {
    var id = m[1];
    if (seen[id]) continue;
    seen[id] = 1;
    if (src.indexOf('id="' + id + '"') === -1) missing.push(id);
  }
  assert(missing.length === 0, 'ids sin elemento: ' + missing.join(', '));
});

test('onclick-handlers: el bloque no usa onclick inline (delegación)', function () {
  assert(code.indexOf('onclick=') === -1, 'el bloque no debe usar onclick inline');
  assert(code.indexOf('data-drexfx-usar') !== -1, 'falta el data attr delegado');
  assert(code.indexOf("closest('[data-drexfx-usar]')") !== -1, 'falta el listener delegado');
});

test('overlay-guard: el bloque no crea overlays fixed nuevos', function () {
  assert(code.indexOf('fixed inset-0') === -1, 'el bloque no debe crear overlays');
  assert(code.indexOf('position:fixed') === -1, 'el bloque no debe crear overlays');
});

test('tailwind-coverage: tokens var(--*) del bloque definidos en CSS', function () {
  var css = src + fs.readFileSync(path.join(__dirname, '..', 'drex-sheet.css'), 'utf8');
  var re = /var\(--[a-zA-Z0-9-]+\)/g, m, missing = [], seen = {};
  while ((m = re.exec(code)) !== null) {
    var tok = m[0].slice(4, -1);
    if (seen[tok]) continue;
    seen[tok] = 1;
    if (css.indexOf(tok + ':') === -1 && css.indexOf(tok + ' :') === -1) missing.push(tok);
  }
  assert(missing.length === 0, 'tokens sin definir: ' + missing.join(', '));
});

test('i18n: claves nuevas con paridad ES/EN/ZH/PT y placeholders iguales', function () {
  var i18n = fs.readFileSync(i18nPath, 'utf8');
  function dict(varName, nextName) {
    var s = i18n.indexOf(varName), e = i18n.indexOf(nextName, s);
    var sec = i18n.slice(s, e === -1 ? i18n.length : e);
    var objText = sec.slice(sec.indexOf('{'), sec.lastIndexOf('\n};') + 2);
    return new Function('return (' + objText + ');')();
  }
  var EN = dict('var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {');
  var ZH = dict('var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {');
  var PT = dict('var APP_PORTUGUESE_TEXT = {', 'var APP_CHINESE_ATTRS = {');
  var keys = ['Usar', 'Aún no has creado efectos', 'Tus efectos aparecerán aquí cuando crees el primero.',
    'Aún no ha creado efectos', 'Los efectos que cree aparecerán aquí.',
    'Error al cargar los efectos.', 'Cara', 'Fondo', 'Juego', 'Código', '{n} usos', 'Efectos'];
  function ph(s) { var o = [], r = /\{[^}]*\}/g, m; while ((m = r.exec(s)) !== null) o.push(m[0]); return o.sort().join('|'); }
  keys.forEach(function (k) {
    assert(k in EN, 'falta en EN: ' + k);
    assert(k in ZH, 'falta en ZH: ' + k);
    assert(k in PT, 'falta en PT: ' + k);
    assert(ph(EN[k]) === ph(ZH[k]) && ph(ZH[k]) === ph(PT[k]), 'placeholders distintos en: ' + k);
  });
  // Toda appT('...') literal del bloque con texto nuevo debe tener clave.
  var re = /drexFxT\('((?:[^'\\]|\\.)*)'\)/g, m, missing = [];
  while ((m = re.exec(code)) !== null) {
    var k = m[1].replace(/\\'/g, "'");
    if (k === 'Efectos') continue; // preexistente
    if (!(k in EN)) missing.push(k);
  }
  assert(missing.length === 0, 'appT sin clave i18n: ' + missing.join(' / '));
});

console.log('\n' + passed + ' pasados, ' + failed + ' fallidos');
Promise.all(pending).then(function () {
  console.log('total: ' + passed + ' pasados, ' + failed + ' fallidos');
  process.exit(failed ? 1 : 0);
});
