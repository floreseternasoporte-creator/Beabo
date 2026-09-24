/* ================================================================
 * C150 — VISTA PREVIA DE ENCUESTA EN TARJETAS DEL HISTORIAL.
 *
 * HALLAZGO (hueco real, re-verificado contra el código, continuación de
 * la línea C143–C149): el post de solo-encuesta (C145: encuesta sin texto)
 * quedaba INVISIBLE en el Historial:
 *  - _buildHistorialCard (pestañas "Mis votos" y "Guardados") pintaba
 *    `post.content` vacío -> tarjeta con solo el nombre del autor y un
 *    párrafo en blanco; el usuario no podía identificar qué encuesta votó
 *    o guardó (C146/C149 acaban de llenar "Mis votos" de encuestas y
 *    comentarios votados, pero las tarjetas de solo-encuesta seguían
 *    mudas).
 *  - loadHistorialEcos (pestaña "Ecos") decía "Publicación sin texto" para
 *    el eco de un post de solo-encuesta.
 * C145 ya había cerrado el mismo hueco en la lista de borradores
 * (renderDraftsList muestra las opciones como avance); el Historial no.
 *
 * CAMBIO (index.html):
 *  - drexHistorialPollPreview(poll): helper PURO — devuelve los títulos de
 *    las opciones unidos con ' · ', o '' si la encuesta no es publicable
 *    (mismo estándar C145: >=2 opciones válidas).
 *  - _buildHistorialCard: si no hay texto pero hay encuesta válida, usa el
 *    avance + insignia 🗳️ con appT('Votación') (clave ya existente en
 *    drex-i18n.js EN/ZH/PT; sin claves nuevas). El texto pasa por
 *    escapeHtml como antes.
 *  - loadHistorialEcos: mismo avance cuando post.content está vacío; el
 *    meta suma ' · 🗳️ Votación'.
 *
 * Ejecutar con: node tests/test-c150-historial-poll-preview.js [--target base.html]
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

// Extrae el cuerpo de `function NAME(...) { ... }` (patrón C146/C149).
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

// ---------- A. Estáticos: la función existe y está cableada ----------
tcase('A1 drexHistorialPollPreview existe', html.indexOf('function drexHistorialPollPreview(poll)') !== -1);

const cardBody = extractFnBody(html, '_buildHistorialCard');
tcase('A2 _buildHistorialCard existe', cardBody !== null);
if (cardBody) {
  tcase('A3 usa drexHistorialPollPreview(post.poll) cuando no hay texto',
    cardBody.indexOf('drexHistorialPollPreview(post.poll)') !== -1);
  tcase('A4 el avance pasa por escapeHtml (sin HTML inyectado)',
    cardBody.indexOf('escapeHtml(content)') !== -1);
  tcase('A5 insignia con appT(Votación) reutilizando la clave existente',
    cardBody.indexOf("appT('Votación')") !== -1);
  tcase('A6 la insignia no usa clases Tailwind arbitrary-value',
    cardBody.indexOf('_c150PollBadge') !== -1 && cardBody.indexOf('style="color:#2F33B8"') !== -1);
  tcase('A7 pin de regresión: ya no pinta content vacío sin fallback',
    cardBody.indexOf("const content = (post.content || '').substring(0, 180);") === -1);
}

const ecosBody = extractFnBody(html, 'loadHistorialEcos');
tcase('A8 loadHistorialEcos existe', ecosBody !== null);
if (ecosBody) {
  tcase('A9 el eco de solo-encuesta usa el avance en vez de "Publicación sin texto"',
    ecosBody.indexOf('drexHistorialPollPreview(post.poll)') !== -1 &&
    ecosBody.indexOf("text: _c150EcoText || 'Publicación sin texto'") !== -1);
  tcase('A10 el meta del eco marca la votación',
    ecosBody.indexOf("appT('Votación')") !== -1);
}

// La clave 'Votación' ya existe en drex-i18n.js (EN/ZH/PT): sin claves nuevas.
const i18nSrc = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');
tcase('A11 sin claves i18n nuevas: Votación ya existe en drex-i18n.js',
  i18nSrc.indexOf('"Votación":"Poll"') !== -1 &&
  i18nSrc.indexOf('"Votación":"投票"') !== -1 &&
  i18nSrc.indexOf('"Votación":"Votação"') !== -1);

// ---------- B. Conductuales: helper puro en sandbox ----------
function loadPure() {
  const body = extractFnBody(html, 'drexHistorialPollPreview');
  if (!body) return null;
  const sb = {};
  vm.createContext(sb);
  vm.runInContext('function drexHistorialPollPreview(poll) {' + body + '}', sb);
  return sb;
}
const sb = loadPure();
tcase('B0 helper carga en sandbox', sb !== null);
if (sb) {
  const run = (src, vars) => {
    const c = vm.createContext(Object.assign({}, vars));
    vm.runInContext('function drexHistorialPollPreview(poll) {' + extractFnBody(html, 'drexHistorialPollPreview') + '}', c);
    return vm.runInContext(src, c);
  };
  const P2 = '{options:[{t:"Rojo",v:3},{t:"Azul",v:5}],endsAt:9999999999999,total:8,voters:{}}';
  tcase('B1 encuesta válida -> opciones unidas con ·',
    () => run('drexHistorialPollPreview(' + P2 + ')', {}) === 'Rojo · Azul');
  tcase('B2 recorta espacios y filtra opciones vacías',
    () => run('drexHistorialPollPreview({options:[{t:"  A  "},{t:""},{t:"B"}]})', {}) === 'A · B');
  tcase('B3 menos de 2 opciones válidas -> vacío',
    () => run('drexHistorialPollPreview({options:[{t:"Solo"}]})', {}) === '');
  tcase('B4 poll null/undefined -> vacío',
    () => run('drexHistorialPollPreview(null)', {}) === '' && run('drexHistorialPollPreview(undefined)', {}) === '');
  tcase('B5 options no-array -> vacío',
    () => run('drexHistorialPollPreview({options:"x"})', {}) === '');
  tcase('B6 títulos no-string se convierten sin romper',
    () => run('drexHistorialPollPreview({options:[{t:7},{t:"B"}]})', {}) === '7 · B');
  tcase('B7 opciones sin t se ignoran',
    () => run('drexHistorialPollPreview({options:[{v:1},{t:"B"},{t:"C"}]})', {}) === 'B · C');
  tcase('B8 no muta el objeto poll',
    () => run('(function(){var p={options:[{t:"A"},{t:"B"}]};drexHistorialPollPreview(p);return p.options.length===2 && p.options[0].t==="A";})()', {}));
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASARON' : '\nFALLARON ' + failures + ' TESTS');
process.exit(failures === 0 ? 0 : 1);
