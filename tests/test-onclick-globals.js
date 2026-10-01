/* Prueba de regresión: todo handler usado en on* del HTML debe resolverse
 * en scope global.
 *
 * Historia (2026-10-01): el bloque <script> de Drex Orbit/Pagos era un IIFE
 * que no exportaba nada a window. Los onclick="openPaymentsView()" del HTML
 * resolvían en scope global -> ReferenceError silencioso -> el tap no abría
 * nada en el iPhone del usuario. El grep "veía" las funciones (existen en el
 * archivo) pero no su alcance. Este test fija la regla: si un nombre aparece
 * en un atributo on* del HTML estático, debe estar declarado a top-level de
 * algún <script> inline o asignado a window.
 *
 * La detección de "top-level" usa un lexer JS propio consciente de strings,
 * comentarios, literales regex y template literals con ${} anidados: un
 * simple contador de llaves se rompe con templates anidados (falsos positivos
 * como openSidePanel/closeNotifications/openProfileSettings en 2026-10-01).
 *
 * Uso: node tests/test-onclick-globals.js [archivo.html]   (código 0 = OK)
 * Sin argumento analiza index.html. Con argumento analiza ese archivo
 * (útil para comprobar que el test habría fallado antes del fix).
 */
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var ROOT = path.join(__dirname, '..');
var target = process.argv[2] || path.join(ROOT, 'index.html');
var src = fs.readFileSync(target, 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

/* Lexer mínimo de JS. Recorre un bloque <script> y devuelve:
 *   top: nombres declarados a top-level (function/var/let/const/class)
 *   win: nombres asignados a window.X / window['X'] / globalThis
 * Ignora correctamente strings, comentarios, regex y templates con ${}
 * anidados, así que "top-level" es el nivel superior real del bloque. */
function analyzeScript(code) {
  var top = new Set(), win = new Set();
  var depth = 0, pdepth = 0;       // llaves {}  |  paréntesis/corchetes ()[]
  var stack = [];                  // modos a los que volver: 'code' | 'tpl'
  var exprStack = [];              // profundidades guardadas por cada ${
  var mode = 'code', strQ = '';
  var prevSig = '';                // último char significativo (modo code)
  var varState = null;             // null | 'needName' | 'afterName' | 'init' | 'destr'
  var initDepth = 0, initPdepth = 0, destrDepth = 0;
  var i = 0, n = code.length;

  function isWs(c) {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
  }
  function isIdStart(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
  }
  function isIdPart(c) { return isIdStart(c) || (c >= '0' && c <= '9'); }
  function skipWs() {
    while (i < n) {
      var c = code[i];
      if (isWs(c)) { i++; continue; }
      if (c === '/' && code[i + 1] === '/') { while (i < n && code[i] !== '\n') i++; continue; }
      if (c === '/' && code[i + 1] === '*') {
        i += 2;
        while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
        i += 2; continue;
      }
      break;
    }
  }
  function readId() { var s = i; while (i < n && isIdPart(code[i])) i++; return code.slice(s, i); }
  function stmtStart() {
    return prevSig === '' || prevSig === ';' || prevSig === '{' || prevSig === '}';
  }
  function atTop() { return depth === 0 && exprStack.length === 0; }
  function isRegexStart() {
    return prevSig === '' || '=([{,:;!&|?+-*~^%<>'.indexOf(prevSig) >= 0;
  }
  function skipRegex() { // parados en '/'
    i++;
    var inClass = false;
    while (i < n) {
      var c = code[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') { inClass = true; i++; continue; }
      if (c === ']') { inClass = false; i++; continue; }
      if (c === '/' && !inClass) { i++; break; }
      if (c === '\n') break;
      i++;
    }
    while (i < n && /[a-z]/i.test(code[i])) i++; // flags
    prevSig = 'x';
  }
  var OP_LIKE = { // tras estas palabras, '/' abre regex, no divide
    return: 1, typeof: 1, case: 1, do: 1, else: 1, in: 1, of: 1,
    new: 1, delete: 1, void: 1, instanceof: 1, yield: 1, await: 1
  };
  // palabras que nunca son nombres declarados (guard en destructuring)
  var RESERVED = {
    function: 1, var: 1, let: 1, const: 1, class: 1, return: 1,
    typeof: 1, new: 1, delete: 1, void: 1, in: 1, of: 1, instanceof: 1,
    if: 1, else: 1, for: 1, while: 1, do: 1, switch: 1, case: 1,
    break: 1, continue: 1, throw: 1, try: 1, catch: 1, finally: 1,
    true: 1, false: 1, null: 1, undefined: 1, this: 1, async: 1, await: 1
  };

  while (i < n) {
    var c = code[i];
    if (mode === 'str') {
      if (c === '\\') { i += 2; continue; }
      if (c === strQ) { mode = stack.pop() || 'code'; i++; prevSig = 'x'; continue; }
      i++; continue;
    }
    if (mode === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { mode = stack.pop() || 'code'; i++; prevSig = 'x'; continue; }
      if (c === '$' && code[i + 1] === '{') {
        stack.push('tpl'); exprStack.push(depth);
        depth = 0; mode = 'code'; prevSig = '{'; i += 2; continue;
      }
      i++; continue;
    }
    // ---- modo code ----
    if (isWs(c)) { i++; continue; }
    if (c === '/' && code[i + 1] === '/') { while (i < n && code[i] !== '\n') i++; continue; }
    if (c === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2; continue;
    }
    if (c === "'" || c === '"') { strQ = c; stack.push('code'); mode = 'str'; i++; continue; }
    if (c === '`') { stack.push('code'); mode = 'tpl'; i++; continue; }
    if (c === '/' && isRegexStart()) { skipRegex(); continue; }
    if (c === '{') {
      depth++;
      if (varState === 'destr') destrDepth++;
      prevSig = '{'; i++; continue;
    }
    if (c === '}') {
      // cierra ${ ... } -> volver al template
      if (depth === 0 && exprStack.length && stack[stack.length - 1] === 'tpl') {
        depth = exprStack.pop(); stack.pop(); mode = 'tpl';
        prevSig = 'x'; i++; continue;
      }
      if (depth > 0) depth--;
      if (varState === 'destr') {
        destrDepth--;
        if (destrDepth === 0) varState = 'afterName';
      }
      prevSig = '}'; i++; continue;
    }
    if (c === '(') { pdepth++; prevSig = '('; i++; continue; }
    if (c === ')') { if (pdepth > 0) pdepth--; prevSig = ')'; i++; continue; }
    if (c === '[') {
      pdepth++;
      if (varState === 'destr') destrDepth++;
      prevSig = '['; i++; continue;
    }
    if (c === ']') {
      if (pdepth > 0) pdepth--;
      if (varState === 'destr') {
        destrDepth--;
        if (destrDepth === 0) varState = 'afterName';
      }
      prevSig = ']'; i++; continue;
    }
    if (c === ';') {
      if (atTop() && varState) varState = null;
      prevSig = ';'; i++; continue;
    }
    if (c === ',') {
      if (atTop() && (varState === 'init' || varState === 'afterName') &&
          depth === initDepth && pdepth === initPdepth) varState = 'needName';
      prevSig = ','; i++; continue;
    }
    if (c === '=') {
      if (atTop() && varState === 'afterName') {
        varState = 'init'; initDepth = depth; initPdepth = pdepth;
      }
      // '==' / '===' / '=>' no cambian varState
      prevSig = '='; i++; continue;
    }
    if (c >= '0' && c <= '9') {
      while (i < n && /[0-9a-zA-Z_.$]/.test(code[i])) i++;
      prevSig = 'x'; continue;
    }
    if (isIdStart(c)) {
      var id = readId();
      var wasStmtStart = stmtStart();
      if (atTop() && !varState) {
        if (id === 'function' && wasStmtStart) {
          skipWs();
          if (code[i] === '*') { i++; skipWs(); }
          var nm = isIdStart(code[i] || '') ? readId() : '';
          if (nm) top.add(nm);
          prevSig = 'x'; continue;
        }
        if (id === 'async' && wasStmtStart) {
          var svA = i; skipWs();
          if (code.slice(i, i + 8) === 'function' && !isIdPart(code[i + 8] || '')) {
            i += 8; skipWs();
            if (code[i] === '*') { i++; skipWs(); }
            var nmA = isIdStart(code[i] || '') ? readId() : '';
            if (nmA) top.add(nmA);
            prevSig = 'x'; continue;
          }
          i = svA;
        }
        if (id === 'var' || id === 'let' || id === 'const') {
          varState = 'needName'; prevSig = 'x'; continue;
        }
        if (id === 'class' && wasStmtStart) {
          skipWs();
          var cn = isIdStart(code[i] || '') ? readId() : '';
          if (cn) top.add(cn);
          prevSig = 'x'; continue;
        }
      }
      // window.X = ... crea un global ESTÉ DONDE ESTÉ (incluso dentro de un
      // IIFE): por eso no lleva el guard atTop(). Se exige que 'window' no
      // venga tras un '.' (obj.window.X no es global).
      if (!varState && (id === 'window' || id === 'globalThis') &&
          (wasStmtStart || '=({,;:!&|?'.indexOf(prevSig) >= 0)) {
          var svW = i; skipWs();
          if (code[i] === '.') {
            i++; skipWs();
            var wn = isIdStart(code[i] || '') ? readId() : '';
            if (wn) {
              skipWs();
              if (code[i] === '=' && code[i + 1] !== '=') win.add(wn);
            }
            prevSig = 'x'; continue;
          }
          if (code[i] === '[') {
            i++; skipWs();
            var q = code[i];
            if (q === "'" || q === '"') {
              i++;
              var s0 = i;
              while (i < n && code[i] !== q) { if (code[i] === '\\') i++; i++; }
              var wn2 = code.slice(s0, i);
              if (code[i] === q) i++;
              skipWs();
              if (code[i] === ']' ) {
                i++; skipWs();
                if (code[i] === '=' && code[i + 1] !== '=') win.add(wn2);
              }
            }
            prevSig = 'x'; continue;
          }
          i = svW;
        }
      if (atTop() && varState === 'needName') {
        if (c === '{' || c === '[') {
          // destructuring: var {a, b} = ... / var [a] = ...
          varState = 'destr'; destrDepth = 1;
          if (c === '{') depth++;
          pdepth++;
          prevSig = c; i++; continue;
        }
        top.add(id); varState = 'afterName'; prevSig = 'x'; continue;
      }
      if (atTop() && varState === 'destr') {
        var svD = i; skipWs();
        if (code[i] === ':') {
          i++; // clave de objeto: el valor (identificador) se lee en la vuelta
        } else if (!RESERVED[id]) {
          top.add(id);
        }
        prevSig = 'x'; continue;
      }
      prevSig = OP_LIKE[id] ? '=' : id[id.length - 1];
      continue;
    }
    prevSig = c; i++;
  }
  return { top: top, win: win };
}

/* Extraer bloques <script> inline y unir sus globales */
var globals = new Set();
var blockRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi, bm;
while ((bm = blockRe.exec(src))) {
  if (/src\s*=/i.test(bm[1])) continue; // script externo: no declara globales inline
  var r = analyzeScript(bm[2]);
  r.top.forEach(function (x) { globals.add(x); });
  r.win.forEach(function (x) { globals.add(x); });
}
function isGlobal(name) { return globals.has(name); }

// HTML estático (fuera de <script>)
var htmlStatic = src
  .replace(/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/g, '')
  .replace(/<script[^>]*src=[^>]*>\s*<\/script>/g, '');

var used = {};
var ur = /on[a-z]+\s*=\s*"([A-Za-z_$][\w$]*)\s*\(/g, um;
while ((um = ur.exec(htmlStatic))) {
  if (um[1] !== 'if') used[um[1]] = true;
}

var names = Object.keys(used);
var missing = names.filter(function (n) { return !isGlobal(n); });

test('todos los handlers on* del HTML resuelven en scope global (' +
     names.length + ' verificados)', function () {
  assert(missing.length === 0,
    'sin alcance global: ' + missing.slice(0, 12).join(', '));
});

test('handlers de Orbit/Pagos exportados a window', function () {
  ['openOrbitView', 'openPaymentsView', 'closeOrbitView', 'closePaymentsView',
   'closeOrbitPaywall', 'renderPaymentsView', 'orbitManage', 'orbitSubscribe',
   'orbitRestore', 'orbitBenefitTap', 'orbitOpenAnalytics', 'DrexOrbit',
   'DrexCoins', 'orbitGate'
  ].forEach(function (n) {
    assert(isGlobal(n), n + ' no es global');
  });
});

test('sanity del detector: casos conocidos', function () {
  assert(isGlobal('openProfileSettings'), 'openProfileSettings debería ser global');
  assert(isGlobal('drexCameraCapture'), 'drexCameraCapture debería ser global (top-level)');
});

test('el lexer distingue IIFE, templates anidados y regex', function () {
  var t = analyzeScript(
    'var g1 = 1;\n' +
    '(function(){\n' +
    '  var inner = 2;\n' +
    '  function foo(){}\n' +
    '  window.exp = foo;\n' +
    '})();\n' +
    'const tpl = `a ${`b ${inner2} c`} d`;\n' +
    'var re = /\\d{2,4}/, q = "}";\n' +
    'function top2(){}\n' +
    'let a1 = 1, a2 = 2;\n'
  );
  assert(t.top.has('g1'), 'g1');
  assert(t.top.has('top2'), 'top2');
  assert(t.top.has('a1') && t.top.has('a2'), 'lista var con comas');
  assert(!t.top.has('inner') && !t.top.has('foo'), 'nada del IIFE debe ser global');
  assert(!t.top.has('inner2'), 'nada de dentro de ${} debe ser global');
  assert(t.win.has('exp'), 'window.exp');
});

test('404.html sincronizado con index.html', function () {
  var idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  var s404 = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');
  assert(idx === s404, '404.html difiere de index.html');
});

console.log('---');
console.log('TOTAL: ' + passed + ' ok, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
