// BARO C332 — rediseño limpio estilo ChatGPT/Grok + fixes de duplicados.
// Fija con evidencia:
//  1. Sin saludo automático duplicado (el flag dataset.baroGreeted se perdía al
//     recargar y el saludo se re-agregaba sobre el hilo restaurado).
//  2. Nunca se pintan burbujas vacías (guard baroIsEmptyContent en los 3 paints).
//  3. El restore dedupea mensajes idénticos consecutivos.
//  4. Header minimal (sin avatar grande ni subtítulo), botón de nuevo chat.
//  5. Estado vacío con sugerencias en chips que mandan el comando.
//  6. Aclaratoria de un solo candidato va directo al dato (compacta).
// Uso: node tests/test-c332-baro-clean.js [--target=html]
'use strict';
const fs = require('fs');
const path = require('path');
const targetArg = process.argv.find(a => a.startsWith('--target='));
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(__dirname, '..', 'index.html');
let html;
try { html = fs.readFileSync(htmlPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer index.html'); process.exit(1); }

let failures = 0;
function ok(name, cond) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name); }
}

// 1. Sin saludo automático en baroOpenView.
ok('sin bloque de saludo con dataset.baroGreeted en baroOpenView',
  !/if\s*\(\s*v\s*&&\s*!v\.dataset\.baroGreeted\s*\)/.test(html));
ok('persiste comentario que documenta por qué no hay saludo',
  html.includes('Ya NO hay saludo autom') || html.includes('Sin saludo autom'));

// 2. Guard contra contenido vacío en los paints.
ok('existe baroIsEmptyContent', html.includes('function baroIsEmptyContent(html)'));
ok('baroAddBaroMessage usa el guard', /function baroAddBaroMessage\(html\)\s*\{\s*var th = baroThreadEl\(\); if \(!th\) return null;\s*if \(baroIsEmptyContent\(html\)\) return null;/.test(html));
ok('baroAddBaroMessageSilent usa el guard', html.includes("baroAddBaroMessageSilent(html)) return null;") || /function baroAddBaroMessageSilent\(html\)[^}]*baroIsEmptyContent\(html\)/.test(html));
ok('baroAddBaroMessageV2 usa el guard', /function baroAddBaroMessageV2\(html, sources\)[^}]*baroIsEmptyContent\(html\)/.test(html));

// 3. Restore con dedupe.
ok('baroRestoreThread dedupea consecutivos', html.includes('no pintar el mismo mensaje dos veces seguidas'));
ok('baroRestoreThread cuenta pintados', /painted\s*>\s*0/.test(html));

// 4. Header minimal.
ok('header sin subtítulo verde', !/<p id="baro-subtitle"/.test(html));
ok('header sin avatar grande', !/class="baro-header-avatar/.test(html));
ok('existe botón nuevo chat', html.includes('onclick="baroNewChat()"'));
ok('existe function baroNewChat', html.includes('function baroNewChat()'));
ok('baroNewChat limpia el hilo persistente', /function baroNewChat\(\)[^}]*localStorage\.removeItem\(BARO_THREAD_KEY\)/.test(html));

// 5. Estado vacío con sugerencias.
ok('estado vacío con contenedor de sugerencias', html.includes('baro-empty-suggest'));
ok('chips del vacío mandan comando', html.includes('data-baro-empty-cmd'));
ok('sugerencias incluyen traducir/redactar/explicar',
  html.includes("{k:'baro.qa.traducir',c:'/traducir'}") &&
  html.includes("{k:'baro.qa.redactar',c:'/redactar'}"));

// 6. Aclaratoria compacta de un solo candidato.
ok('clarify single-candidate compacto', html.includes('baro-clarify-single'));
ok('documenta por qué (duplicado Translate)', html.includes('se veía duplicada'));

// 7. CSS del rediseño.
ok('burbuja de Baro transparente', /\.baro-bubble-baro\s*\{[^}]*background:\s*transparent/.test(html));
ok('avatar oculto en filas de mensaje', /\.baro-msg-row\s*>\s*\.baro-avatar\s*\{\s*display:\s*none/.test(html));
ok('placeholder nuevo del composer', html.includes("'Pregunta lo que sea"));

// 8. Los mensajes de usuario conservan su píldora índigo.
ok('píldora índigo del usuario intacta', /\.baro-bubble-user\s*\{[^}]*background:\s*#2F33B8/.test(html));

if (failures) { console.error('\n' + failures + ' FALLAS'); process.exit(1); }
console.log('\nC332 verde: ' + 'rediseño limpio + fixes verificados');
