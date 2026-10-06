// C132: re-barrido residual de sinks XSS + familia NUNCA auditada <template>/<slot>.
//
// CONTEXTO: C106 auditó los sinks XSS de index.html (497 innerHTML, 8
// insertAdjacentHTML, 3 outerHTML) hit por hit con verificación de provenance.
// Desde entonces solo se añadió UN sink nuevo (C108, tarjeta de
// colaboración): `card.innerHTML = doneHTML(finalAccepted)`.
// Este test fija el inventario post-C106 y prueba la provenance del sink
// nuevo: doneHTML solo interpola ternarios booleanos sobre literales
// estáticos; ningún dato de usuario ni de BD llega al HTML.
//
// INVENTARIO verificado (2026-09-24, HEAD 4ae093e):
//  - index.html: .innerHTML 489, .outerHTML 3, insertAdjacentHTML 8,
//    document.write 0, <template 0, <slot[> ] 0 (los "slot" son ad-slot CSS
//    y un comentario "Time slot": cero shadow-DOM).
// RE-AUDITORÍA (2026-09-25, MISIÓN BARO Bloque 1): la función "Series" fue
// eliminada por orden del usuario; el módulo eliminado contenía 12 usos de
// .innerHTML (render del picker, badges y vista de serie). Nuevo inventario:
// .innerHTML 481, .outerHTML 3, insertAdjacentHTML 8.
// BARO-6: +4 por el agente Baro (burbuja, typing, pasos, preview de confirm).
// BARO v2 (2026-09-25): +5 por el modo Perplexity — feed de actividad en vivo,
// icono spinner, icono de tool, tira de fuentes, botones de acciones.
// Todos pintan HTML propio del agente (registro BARO_ICONS / plantillas
// internas); auditados sin interpolación cruda de datos de usuario.
// Nuevo inventario: .innerHTML 486, .outerHTML 3, insertAdjacentHTML 8.
// MISIÓN URGENTE 2026-09-29 (crash-hunt): +5 por loadUserNotes (tab Notas del
// perfil): estados sin-sesión/vacío/error con strings i18n estáticos,
// spinner interno y limpieza; las tarjetas usan createProfilePostCard (DOM)
// y header.textContent. Auditados: cero interpolación de datos de usuario.
// Nuevo inventario: .innerHTML 573, .outerHTML 3, insertAdjacentHTML 8.
// PRESENCIA LIVE GLOBAL 2026-09-29: +6 (banners feed/Buscar/perfil: rama
// oculta con box.innerHTML='' + rama visible con HTML propio; todo dato de
// live — titulo, nombre, avatar, viewers — pasa por esc(), y los textos por
// t(); cero interpolacion cruda de datos de usuario/BD). Nuevo inventario:
// .innerHTML 579, .outerHTML 3, insertAdjacentHTML 8.
//  - drex-rec-engine.js / sw.js: 0 sinks cada uno (0 hits en los 4 patrones).
//  - scrollIntoView({behavior:'smooth'}): 6 hits (9252, 23762, 23773, 33930,
//    37151 + BARO v2: scroll del feed de actividad al pie); scroll-behavior:smooth real: 1 (#empresa-view); la media query
//    prefers-reduced-motion EXISTE (2 hits) — verificar presencia, NO tocar
//    (a11y fuera de alcance por orden del usuario 2026-09-15).
//
// C240 LIVE (2026-09-29): +32 en tres carriles. Rebase 2026-09-29 sobre
// 9a967c7 (Drex Orbit aporto +9: 588 base) -> 620 final. Auditados hit por hit: L1 combo/leaderboard: esc_() en nombre,
// monedas, img del catalogo y strings t_(); re-envoltura de HTML propio sin
// datos nuevos. L3 meta/entrada/destacado/celebracion: dl3esc() en nombre,
// texto, titulo y conteo; ternarios booleanos y numeros en estilos; SVG
// interno via drexIcon (literal 'heart'). L2 cofre/encuesta/Q&A: esc() en
// nombres, preguntas, opciones y qids (data-qid); SVG interno DL2_SVG;
// strings t()/tf() escapados. Cero interpolacion cruda de datos de
// usuario/BD.
// Si cualquier conteo cambia, hay un sink nuevo sin auditar: re-auditar la
// familia antes de cerrar el ciclo.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(__dirname, '..', 'index.html');
const copyPath = path.join(__dirname, '..', '404.html');
const recPath = path.join(__dirname, '..', 'drex-rec-engine.js');
const swPath = path.join(__dirname, '..', 'sw.js');
let html, copy, rec, sw;
try { html = fs.readFileSync(htmlPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer index.html'); process.exit(1); }
try { copy = fs.readFileSync(copyPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer 404.html'); process.exit(1); }
try { rec = fs.readFileSync(recPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer drex-rec-engine.js'); process.exit(1); }
try { sw = fs.readFileSync(swPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer sw.js'); process.exit(1); }

let failures = 0;
function ok(name, cond) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name); }
}
function tcase(name, fn) {
  try { ok(name, fn()); }
  catch (e) { failures++; console.error('FAIL - ' + name + ' (throw: ' + (e && e.message) + ')'); }
}
function count(re, src) { return (src.match(re) || []).length; }

// ---- 1. Inventario de sinks en index.html (post-C106) ----
tcase('innerHTML: 579 ocurrencias en index.html (C269 2026-10-06: +13 — pestañas de perfil (respuestas/multimedia/ecos): contenido y autores con escapeHtml, URLs con getSafeMediaUrl, ids con escapeInlineSingleQuote en onclick; C268 2026-10-06: +4 — panel de stickers del chat (paquetes, rejilla y carrusel): todo nombre de sticker pasa por escapeHtml y el arte SVG/PNG es contenido propio del catálogo drex-stickers.js, cero datos de usuario sin escapar; auditoría UI: +6 de C243 — paywall cancelado y 5 estados de la lista de visitantes, todo dato de usuario escapado con escapeHtml/escapeInlineSingleQuote; C246 2026-10-03: +20 neto de C241–C245 — Orbit/checkout/transacciones/Pulso/visitas — auditados sink a sink: todo dato de usuario pasa por orbitEscText/escFn/escapeHTML/baroLLMEsc, el resto es markup estático o limpieza; C253 2026-10-06: +1 — el aviso de activación de vistas de perfil interpola SOLO escFn(t(clave estática)), sin datos de usuario; C264 2026-10-06: +5 — pie fijo de compra de Orbit y repintado de la matriz de beneficios: markup propio con escFn/t() y precios de constantes ORBIT_PLANS, cero datos de usuario sin escapar)', () => count(/\.innerHTML/g, html) === 579);
tcase('outerHTML: 3 ocurrencias en index.html', () => count(/\.outerHTML/g, html) === 3);
tcase('insertAdjacentHTML: 8 ocurrencias en index.html', () => count(/insertAdjacentHTML/g, html) === 8);
tcase('document.write: 0 en index.html', () => count(/document\.write/g, html) === 0);

// ---- 2. Paridad 404.html ----
tcase('404.html: mismos conteos de sinks que index.html', () =>
  count(/\.innerHTML/g, copy) === 579 &&
  count(/\.outerHTML/g, copy) === 3 &&
  count(/insertAdjacentHTML/g, copy) === 8 &&
  count(/document\.write/g, copy) === 0);

// ---- 3. drex-rec-engine.js y sw.js: cero sinks ----
for (const [name, src] of [['drex-rec-engine.js', rec], ['sw.js', sw]]) {
  tcase(name + ': 0 .innerHTML', () => count(/\.innerHTML/g, src) === 0);
  tcase(name + ': 0 .outerHTML', () => count(/\.outerHTML/g, src) === 0);
  tcase(name + ': 0 insertAdjacentHTML', () => count(/insertAdjacentHTML/g, src) === 0);
  tcase(name + ': 0 document.write', () => count(/document\.write/g, src) === 0);
  tcase(name + ': 0 <template', () => count(/<template/g, src) === 0);
}

// ---- 4. Familia nunca auditada: <template>/<slot> = cero en la app ----
tcase('index.html: 0 <template', () => count(/<template/g, html) === 0);
tcase('404.html: 0 <template', () => count(/<template/g, copy) === 0);
tcase('index.html: 0 <slot shadow-DOM', () => count(/<slot[\s>]/g, html) === 0);

// ---- 5. prefers-reduced-motion: verificar presencia (NO tocar) ----
tcase('prefers-reduced-motion: la media query existe (>=1)', () =>
  count(/prefers-reduced-motion/g, html) >= 1);
tcase('scrollIntoView smooth: 10 hits (inventario; studio/live agregaron scrolls)', () =>
  count(/scrollIntoView\(\{[^}]*behavior:\s*['"]smooth['"]/g, html) === 10);

// ---- 6. Provenance del único sink nuevo post-C106: doneHTML (C108) ----
// Extrae `const doneHTML = ok => `...`;` y lo evalúa en sandbox.
function extractDoneHTML(src) {
  const ai = src.indexOf('const doneHTML = ok =>');
  if (ai === -1) return null;
  const open = src.indexOf('`', ai);
  if (open === -1) return null;
  let i = open + 1;
  while (i < src.length && (src[i] !== '`' || src[i - 1] === '\\')) i++;
  if (i >= src.length) return null;
  const expr = src.slice(ai + 'const doneHTML = '.length, i + 1);
  return vm.runInNewContext('(' + expr + ')');
}
const doneHTML = extractDoneHTML(html);
tcase('doneHTML: extraíble y evaluable en sandbox', () => typeof doneHTML === 'function');
tcase('doneHTML(true): rama aceptada', () =>
  doneHTML(true).includes('🤝 Colaboración aceptada'));
tcase('doneHTML(false): rama rechazada', () =>
  doneHTML(false).includes('Invitación de colaboración rechazada'));
// Batería hostil: ningún dato de entrada puede aparecer en el HTML.
const hostile = [
  '<img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  '${7*7}',
  'accepted',
  'declined',
  '{{constructor}}',
  'javascript:alert(1)',
];
for (const h of hostile) {
  tcase('doneHTML(' + JSON.stringify(h) + '): sin fuga al HTML', () => {
    const out = doneHTML(h);
    return !out.includes(h);
  });
}
tcase('doneHTML({}): objeto truthy sin fuga', () => !doneHTML({}).includes('[object Object]'));
tcase('doneHTML(undefined/null/0): falsy sin fuga', () =>
  !doneHTML(undefined).includes('undefined') &&
  !doneHTML(null).includes('null') &&
  doneHTML(0).includes('Invitación de colaboración rechazada'));

// ---- 7. Call sites de doneHTML: exactamente los 2 de C108 ----
tcase('doneHTML: exactamente 2 call sites (C108)', () => {
  const sites = html.match(/doneHTML\((status === 'accepted'|finalAccepted)\)/g) || [];
  return sites.length === 2;
});
tcase('finalAccepted: solo ternarios booleanos (st comparado con ===, nunca interpolado)', () => {
  const lines = html.split('\n').filter(l => l.includes('finalAccepted'));
  const allowed = [
    /let finalAccepted = accept;/,
    /finalAccepted = st === 'declined' \? false : \(st === 'accepted' \? true : accept\);/,
    /card\.innerHTML = doneHTML\(finalAccepted\);/,
  ];
  return lines.length === 3 && lines.every((l, i) => allowed[i].test(l.trim()));
});

if (failures) { console.error(failures + ' FAIL'); process.exit(1); }
console.log('C132 residual-XSS: todos los asserts OK');
