/* ================================================================
 * C151 — VISTA PREVIA DE ENCUESTA EN RESULTADOS DE BÚSQUEDA.
 *
 * HALLAZGO (hueco real, re-verificado contra el código, continuación de
 * la línea C143–C150): el post de solo-encuesta (C145: encuesta sin texto)
 * quedaba mudo en UNA superficie más: `renderPostsList` (resultados de
 * búsqueda) pintaba `post.content || 'Sin texto'` sin ninguna indicación
 * de que el post trae una votación. Alcanzable: un post sin texto, sin URL
 * y sin título SÍ matchea en la búsqueda por nombre de autor
 * (performRealTimeSearch matchea content/authorName/url/title), así que el
 * usuario veía "Sin texto" y no podía saber que era una encuesta.
 * Barrido completo de superficies que renderizan el mismo dato (lección
 * C150): la tarjeta compartida buildDrexPostCardHTML (feed, perfil, ecos,
 * visor, permalink) ya renderiza la encuesta vía renderPostPollHTML;
 * renderDraftsList (C145) y _buildHistorialCard/loadHistorialEcos (C150)
 * ya muestran el avance. La búsqueda era la única sin cubrir.
 *
 * CAMBIO (index.html, renderPostsList):
 *  - Si no hay texto pero hay encuesta válida, el avance usa
 *    drexHistorialPollPreview(post.poll) (mismo helper puro de C150, con
 *    guarda typeof) + insignia 🗳️ con appT('Votación') (clave ya existente
 *    en drex-i18n.js EN/ZH/PT; sin claves nuevas). El texto pasa por
 *    escapeHTML como antes; estilos inline deterministas (sin Tailwind
 *    arbitrary-value). Sin encuesta, el fallback 'Sin texto' queda intacto.
 *
 * Ejecutar con: node tests/test-c151-search-poll-preview.js [--target base.html]
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const _ti = process.argv.indexOf('--target');
const _target = _ti >= 0 && process.argv[_ti + 1] ? path.resolve(process.argv[_ti + 1]) : path.join(ROOT, 'index.html');
const html = fs.readFileSync(_target, 'utf8');

let failures = 0;
function tcase(name, fn) {
  try {
    const ok = (typeof fn === 'function') ? fn() : !!fn;
    console.log((ok ? 'ok - ' : 'NOT OK - ') + name);
    if (!ok) failures++;
  } catch (e) {
    console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
    failures++;
  }
}

// Extrae el cuerpo de `function NAME(...) { ... }` (patrón C146/C149/C150).
function extractFnBody(src, fnName) {
  const start = src.indexOf('function ' + fnName + '(');
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

// ---------- A. Estáticos: cableado en renderPostsList ----------
const listBody = extractFnBody(html, 'renderPostsList');
tcase('A1 renderPostsList existe', listBody !== null);
if (listBody) {
  tcase('A2 calcula _c151SearchText con trim del contenido',
    listBody.indexOf("let _c151SearchText = (post.content || '').trim();") !== -1);
  tcase('A3 usa drexHistorialPollPreview(post.poll) cuando no hay texto',
    listBody.indexOf('drexHistorialPollPreview(post.poll)') !== -1);
  tcase('A4 guarda typeof del helper (extracción segura)',
    listBody.indexOf("typeof drexHistorialPollPreview === 'function'") !== -1);
  tcase('A5 el avance pasa por escapeHTML (sin HTML inyectado)',
    listBody.indexOf("escapeHTML(_c151SearchText || 'Sin texto')") !== -1);
  tcase('A6 insignia con 🗳️ + appT(Votación) reutilizando la clave existente',
    listBody.indexOf('🗳️') !== -1 && listBody.indexOf("appT('Votación')") !== -1);
  tcase('A7 la insignia no usa clases Tailwind arbitrary-value',
    listBody.indexOf('_c151PollBadge') !== -1 && listBody.indexOf('style="color:#2F33B8"') !== -1);
  tcase('A8 pin de regresión: el fallback mudo ya no existe',
    listBody.indexOf("${escapeHTML(post.content || 'Sin texto')}") === -1);
  tcase('A9 el badge se pinta dentro de la tarjeta del resultado',
    listBody.indexOf('${_c151PollBadge}') !== -1);
}

// La clave 'Votación' ya existe en drex-i18n.js (EN/ZH/PT): sin claves nuevas.
const i18nSrc = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');
tcase('A10 sin claves i18n nuevas: Votación ya existe en drex-i18n.js',
  i18nSrc.indexOf('"Votación":"Poll"') !== -1 &&
  i18nSrc.indexOf('"Votación":"投票"') !== -1 &&
  i18nSrc.indexOf('"Votación":"Votação"') !== -1);

// ---------- B. Conductuales: lógica de selección en sandbox ----------
// Extrae la región C151 (cálculo de _c151SearchText/_c151PollBadge) y la
// ejecuta con `post` inyectado; devuelve {t, b, p}.
function runSelect(post, withHelper) {
  const start = html.indexOf('let _c151SearchText');
  const endMark = ": '';";
  const end = html.indexOf(endMark, start);
  if (start === -1 || end === -1) return null;
  const region = html.slice(start, end + endMark.length);
  const ctx = {
    post: post,
    escapeHTML: function (s) { return '[esc]' + s; },
    appT: function (s) { return s; }
  };
  if (withHelper) {
    const hb = extractFnBody(html, 'drexHistorialPollPreview');
    if (!hb) return null;
    vm.createContext(ctx);
    vm.runInContext('function drexHistorialPollPreview(poll) {' + hb + '}', ctx);
  } else {
    vm.createContext(ctx);
  }
  const wrapped = '(function(){' + region +
    ';return {t:_c151SearchText, b:_c151PollBadge, p:_c151IsPollPreview};})()';
  return vm.runInContext(wrapped, ctx);
}

const POLL2 = { options: [{ t: 'Rojo', v: 3 }, { t: 'Azul', v: 5 }], endsAt: 9999999999999, total: 8, voters: {} };
const POLL1 = { options: [{ t: 'Solo' }], endsAt: 9999999999999, total: 0, voters: {} };

tcase('B0 la región C151 se extrae y ejecuta', runSelect({ content: 'hola' }, true) !== null);
tcase('B1 post con texto (+encuesta) -> texto intacto, sin badge',
  () => { const r = runSelect({ content: 'hola mundo', poll: POLL2 }, true); return r.t === 'hola mundo' && r.b === '' && r.p === false; });
tcase('B2 post sin texto + encuesta válida -> avance de opciones + badge',
  () => { const r = runSelect({ content: '', poll: POLL2 }, true); return r.t === 'Rojo · Azul' && r.p === true && r.b.indexOf('🗳️') !== -1 && r.b.indexOf('[esc]Votación') !== -1; });
tcase('B3 post sin texto y sin encuesta -> vacío (fallback Sin texto en plantilla), sin badge',
  () => { const r = runSelect({ content: '' }, true); return r.t === '' && r.b === '' && r.p === false; });
tcase('B4 contenido de solo espacios + encuesta -> se trata como vacío',
  () => { const r = runSelect({ content: '   ', poll: POLL2 }, true); return r.t === 'Rojo · Azul' && r.p === true; });
tcase('B5 encuesta no publicable (1 opción) -> vacío, sin badge',
  () => { const r = runSelect({ content: '', poll: POLL1 }, true); return r.t === '' && r.b === '' && r.p === false; });
tcase('B6 el avance llega crudo al escapeHTML de la plantilla (sin doble escape)',
  () => { const r = runSelect({ content: '', poll: { options: [{ t: '<b>A</b>' }, { t: 'B' }] } }, true); return r.t === '<b>A</b> · B'; });
tcase('B7 sin el helper definido (typeof guard) no lanza excepción',
  () => { const r = runSelect({ content: '', poll: POLL2 }, false); return r.t === '' && r.b === ''; });
tcase('B8 post null-ish no rompe la guarda',
  () => { const r = runSelect({ content: '', poll: null }, true); return r.t === '' && r.b === ''; });

console.log(failures === 0 ? '\nTODOS LOS TESTS PASARON' : '\nFALLARON ' + failures + ' TESTS');
process.exit(failures === 0 ? 0 : 1);
