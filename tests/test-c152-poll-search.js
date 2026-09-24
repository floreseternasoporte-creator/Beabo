/* ================================================================
 * C152 — BÚSQUEDA POR CONTENIDO DE ENCUESTA.
 *
 * HALLAZGO (hueco real, re-verificado contra el código, continuación de
 * la línea C143–C151): performRealTimeSearch matcheaba content /
 * authorName / url / title pero era CIEGA al contenido de la votación.
 * Buscar "pizza" nunca encontraba la encuesta "¿Qué cenamos?" con opciones
 * pizza/pasta, y un post de solo-encuesta (C145: sin texto) solo aparecía
 * buscando por nombre de autor. C151 hizo visible la encuesta en los
 * resultados (avance + insignia 🗳️), pero seguía siendo imposible
 * ENCONTRARLA por su contenido: el dato se pintaba pero no se buscaba.
 *
 * CAMBIO (index.html):
 *  - Funciones puras nuevas drexPollSearchText(poll) (pregunta + títulos
 *    de opciones unidos) y drexPollMatchesQuery(poll, queryLower) (mismo
 *    criterio de dos niveles que el contenido: includes directo y luego
 *    palabra-por-palabra).
 *  - Cableado en performRealTimeSearch DESPUÉS del chequeo de título:
 *    solo matchea por encuesta si content/autor/url/título no matchearon
 *    (fallback, con guarda typeof). Sin claves i18n nuevas (no pinta
 *    texto), sin cambios de forma en la BD, sin índices nuevos.
 *
 * Ejecutar con: node tests/test-c152-poll-search.js [--target base.html]
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

// ---------- A. Estáticos: cableado ----------
const searchBody = extractFnBody(html, 'performRealTimeSearch');
tcase('A1 performRealTimeSearch existe', searchBody !== null);
tcase('A2 drexPollSearchText definida en index.html',
  extractFnBody(html, 'drexPollSearchText') !== null);
tcase('A3 drexPollMatchesQuery definida en index.html',
  extractFnBody(html, 'drexPollMatchesQuery') !== null);
if (searchBody) {
  tcase('A4 performRealTimeSearch cablea drexPollMatchesQuery(note.poll, query)',
    searchBody.indexOf('drexPollMatchesQuery(note.poll, query)') !== -1);
  tcase('A5 guarda typeof del matcher (extracción segura)',
    searchBody.indexOf("typeof drexPollMatchesQuery === 'function'") !== -1);
  tcase('A6 la encuesta es fallback: va DESPUÉS del chequeo de título',
    searchBody.indexOf('note.title') !== -1 &&
    searchBody.indexOf('drexPollMatchesQuery') > searchBody.indexOf('note.title'));
  tcase('A7 solo corre si nada matcheó antes (!matches)',
    searchBody.indexOf('!matches && note.poll') !== -1);
}
const textBody = extractFnBody(html, 'drexPollSearchText');
const matchBody = extractFnBody(html, 'drexPollMatchesQuery');
tcase('A8 las funciones puras no tocan i18n/DOM (sin appT ni document)',
  textBody !== null && matchBody !== null &&
  textBody.indexOf('appT(') === -1 && textBody.indexOf('document') === -1 &&
  matchBody.indexOf('appT(') === -1 && matchBody.indexOf('document') === -1);

// ---------- B. Conductuales: funciones puras en sandbox ----------
function makeCtx() {
  const ctx = {};
  vm.createContext(ctx);
  if (textBody === null || matchBody === null) return null;
  const src = '(function(){' +
    'function drexPollSearchText(poll) {' + textBody + '}' +
    'function drexPollMatchesQuery(poll, queryLower) {' + matchBody + '}' +
    'return {t: drexPollSearchText, m: drexPollMatchesQuery};})()';
  return vm.runInContext(src, ctx);
}
const F = makeCtx();
tcase('B0 las funciones puras se extraen y ejecutan', F !== null && typeof F.t === 'function' && typeof F.m === 'function');

const POLL_Q = { q: '¿Qué cenamos?', options: [{ t: 'Pizza', v: 3 }, { t: 'Pasta', v: 5 }], endsAt: 9999999999999, total: 8, voters: {} };
const POLL_NOQ = { options: [{ t: 'Rojo' }, { t: 'Azul' }] };

if (F) {
  tcase('B1 pregunta + opciones -> texto unido con espacios',
    () => F.t(POLL_Q) === '¿Qué cenamos? Pizza Pasta');
  tcase('B2 sin pregunta -> solo opciones',
    () => F.t(POLL_NOQ) === 'Rojo Azul');
  tcase('B3 opciones vacías/blancas se saltan',
    () => F.t({ options: [{ t: '  ' }, { t: '' }, { t: 'Sí' }] }) === 'Sí');
  tcase('B4 poll sin options -> cadena vacía',
    () => F.t({}) === '' && F.t({ options: 'no-array' }) === '');
  tcase('B5 poll null/undefined -> cadena vacía',
    () => F.t(null) === '' && F.t(undefined) === '');
  tcase('B6 match directo en opción: "pizza"',
    () => F.m(POLL_Q, 'pizza') === true);
  tcase('B7 match parcial por palabra: "piz" (igual que el contenido)',
    () => F.m(POLL_Q, 'piz') === true);
  tcase('B8 match en la pregunta: "cenamos"',
    () => F.m(POLL_Q, 'cenamos') === true);
  tcase('B9 multi-palabra: basta que UNA matchee ("qué sushi")',
    () => F.m(POLL_Q, 'qué sushi') === true);
  tcase('B10 sin coincidencia -> false',
    () => F.m(POLL_Q, 'hamburguesa') === false);
  tcase('B11 query vacía -> false',
    () => F.m(POLL_Q, '') === false && F.m(POLL_Q, '   ') === false);
  tcase('B12 insensible a mayúsculas (query ya minúscula, texto se baja)',
    () => F.m({ options: [{ t: 'PIZZA' }] }, 'pizza') === true);
  tcase('B13 poll null -> false (sin excepción)',
    () => F.m(null, 'pizza') === false);
  tcase('B14 encuesta de 1 opción también matchea (el matcher es de texto)',
    () => F.m({ options: [{ t: 'Solo' }] }, 'solo') === true);
  tcase('B15 pureza: el matcher no muta el poll',
    () => {
      const p = { q: 'Q?', options: [{ t: 'A', v: 1 }] };
      const before = JSON.stringify(p);
      F.m(p, 'a');
      return JSON.stringify(p) === before;
    });
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASARON' : '\nFALLARON ' + failures + ' TESTS');
process.exit(failures === 0 ? 0 : 1);
