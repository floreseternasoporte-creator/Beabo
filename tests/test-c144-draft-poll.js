/* ================================================================
 * C144 — VOTACIONES EN BORRADORES Y POSTS PROGRAMADOS (función nueva).
 *
 * HALLAZGO (hueco real, re-verificado contra el código): el composer
 * permite crear una encuesta (toggle Votación) y el flujo de borradores
 * permite guardar/programar el texto, pero la encuesta se PERDÍA en
 * silencio en tres puntos:
 *   1. collectCurrentNoteDraft() no guardaba notePostPoll (solo content,
 *      format, audience, seriesSel).
 *   2. loadCurrentNoteDraft() no restauraba la encuesta al retomar.
 *   3. drexSchedBuildNote() publicaba el post programado SIN poll:
 *      programar un post con encuesta la eliminaba sin aviso.
 * Además el toast de openScheduleSheetFromComposer decía "solo admite
 * texto" aunque ahora las encuestas sí viajan.
 *
 * CAMBIO (index.html):
 *  - Helpers puros en el bloque DREX-SCHEDULED-POSTS:
 *    drexDraftPollHours / drexDraftPollFromEditor (normaliza el estado
 *    crudo del editor para el borrador, conserva opciones a medio
 *    escribir) / drexDraftPollForPublish (construye note.poll con endsAt
 *    calculado AL PUBLICAR; >=2 opciones válidas) / drexDraftHasPoll.
 *  - collectCurrentNoteDraft: guarda draft.poll (+ pollScriptVote si era
 *    la votación del guion de la serie).
 *  - loadCurrentNoteDraft: restaura notePostPoll + re-render del editor y
 *    del botón Votación.
 *  - drexSchedBuildNote: adjunta note.poll (con q regenerada si era
 *    votación de guion de serie).
 *  - renderDraftsList: insignia "🗳️ Votación" en borradores con encuesta.
 *  - openScheduleSheetFromComposer: mensaje actualizado (las encuestas ya
 *    viajan; solo fotos/videos siguen sin admitirse) + i18n ES/EN/ZH/PT.
 *
 * Ejecutar con: node tests/test-c144-draft-poll.js
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
    const ok = fn();
    console.log((ok ? 'ok - ' : 'NOT OK - ') + name);
    if (!ok) failures++;
  } catch (e) {
    console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
    failures++;
  }
}

// ---------- Extracción del bloque DREX-SCHEDULED-POSTS (mismo patrón que
// tests/scheduled-posts.test.mjs) ----------
const START = '// === DREX-SCHEDULED-POSTS: INICIO ===';
const END = '// === DREX-SCHEDULED-POSTS: FIN ===';
const si = html.indexOf(START);
const ei = html.indexOf(END);
if (si === -1 || ei === -1 || ei < si) {
  console.error('FALLO: bloque DREX-SCHEDULED-POSTS ausente.');
  process.exit(1);
}
const blockCode = html.slice(si, ei + END.length);

function makeBox(extra) {
  const sandbox = Object.assign({ console, appT: s => s }, extra || {});
  vm.createContext(sandbox);
  vm.runInContext(blockCode, sandbox, { filename: 'sched-poll-block.js' });
  // drexSchedResolveAudience vive en el bloque; se expone para los tests.
  return sandbox;
}
function call(sb, expr) {
  return vm.runInContext('(' + expr + ')', sb);
}
const jEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- Parte A: drexDraftPollFromEditor ----------
tcase('A1 estado normal se conserva íntegro', () => {
  const sb = makeBox();
  const r = call(sb, "drexDraftPollFromEditor({options:['A','B',''],hours:72})");
  return jEq(r, { options: ['A', 'B', ''], hours: 72 });
});
tcase('A2 opciones a medio escribir se conservan para retomar', () => {
  const sb = makeBox();
  const r = call(sb, "drexDraftPollFromEditor({options:['Sí',''],hours:1})");
  return r && r.options[0] === 'Sí' && r.options[1] === '';
});
tcase('A3 nulo / sin options -> null', () => {
  const sb = makeBox();
  return call(sb, 'drexDraftPollFromEditor(null)') === null
    && call(sb, 'drexDraftPollFromEditor({hours:24})') === null;
});
tcase('A4 todo vacío -> null (no ensucia el borrador)', () => {
  const sb = makeBox();
  return call(sb, "drexDraftPollFromEditor({options:['','  '],hours:24})") === null;
});
tcase('A5 hours fuera de rango -> 24', () => {
  const sb = makeBox();
  const r1 = call(sb, "drexDraftPollFromEditor({options:['A','B'],hours:999})");
  const r2 = call(sb, "drexDraftPollFromEditor({options:['A','B']})");
  return r1 && r1.hours === 24 && r2 && r2.hours === 24;
});
tcase('A6 >4 opciones se truncan a 4; opción >60 chars se corta', () => {
  const sb = makeBox();
  const r = call(sb, "drexDraftPollFromEditor({options:['a','b','c','" + 'x'.repeat(70) + "','e'],hours:24})");
  return r && r.options.length === 4 && r.options[3] === 'x'.repeat(60);
});

// ---------- Parte B: drexDraftPollForPublish ----------
tcase('B1 construye note.poll publicable con endsAt al publicar', () => {
  const sb = makeBox();
  const NOW = 1787000000000;
  const r = call(sb, 'drexDraftPollForPublish({options:["A","B"],hours:24}, ' + NOW + ', null)');
  return r && r.endsAt === NOW + 24 * 3600000
    && jEq(r.options, [{ t: 'A', v: 0 }, { t: 'B', v: 0 }])
    && r.total === 0 && jEq(r.voters, {}) && !('q' in r);
});
tcase('B2 <2 opciones válidas -> null', () => {
  const sb = makeBox();
  return call(sb, 'drexDraftPollForPublish({options:["A","","  "]}, 1000, null)') === null
    && call(sb, 'drexDraftPollForPublish(null, 1000, null)') === null;
});
tcase('B3 q se adjunta cuando se pasa', () => {
  const sb = makeBox();
  const r = call(sb, 'drexDraftPollForPublish({options:["A","B"],hours:1}, 1000, "¿Qué pasa?")');
  return r && r.q === '¿Qué pasa?' && r.endsAt === 1000 + 3600000;
});
tcase('B4 hours inválido -> ventana de 24h', () => {
  const sb = makeBox();
  const r = call(sb, 'drexDraftPollForPublish({options:["A","B"],hours:-5}, 1000, null)');
  return r && r.endsAt === 1000 + 24 * 3600000;
});
tcase('B5 nowMs inválido -> usa Date.now() como base', () => {
  const sb = makeBox();
  const before = Date.now();
  const r = call(sb, 'drexDraftPollForPublish({options:["A","B"],hours:1}, "NaN", null)');
  const after = Date.now();
  return r && r.endsAt >= before + 3600000 && r.endsAt <= after + 3600000;
});

// ---------- Parte C: drexDraftHasPoll ----------
tcase('C1 hasPoll verdadero/falso', () => {
  const sb = makeBox();
  return call(sb, 'drexDraftHasPoll({poll:{options:["A","B"],hours:24}})') === true
    && call(sb, 'drexDraftHasPoll({poll:{options:["",""],hours:24}})') === false
    && call(sb, 'drexDraftHasPoll({})') === false;
});

// ---------- Parte D: drexSchedBuildNote con encuesta ----------
function schedBox() {
  const sb = makeBox({
    drexSerieGet: () => ({ id: 's1', title: 'Saga', onda: '#onda' }),
    drexSerieNextChapter: () => 3,
    drexSerieEnsureOndaInText: (t) => t
  });
  return sb;
}
tcase('D1 programado con encuesta -> note.poll adjunta, endsAt futuro', () => {
  const sb = schedBox();
  const r = call(sb, `drexSchedBuildNote(
    {content:'hola',audience:'public',poll:{options:['Sí','No'],hours:24}},
    {uid:'u1'}, {}
  )`);
  const now = Date.now();
  return r && r.poll && r.poll.endsAt > now && r.poll.endsAt <= now + 24 * 3600000
    && jEq(r.poll.options, [{ t: 'Sí', v: 0 }, { t: 'No', v: 0 }])
    && r.poll.total === 0 && r.drexScheduled === true;
});
tcase('D2 sin encuesta -> note sin poll (compat intacta)', () => {
  const sb = schedBox();
  const r = call(sb, `drexSchedBuildNote({content:'hola',audience:'public'}, {uid:'u1'}, {})`);
  return r && !('poll' in r);
});
tcase('D3 encuesta con <2 opciones válidas -> se publica sin poll', () => {
  const sb = schedBox();
  const r = call(sb, `drexSchedBuildNote(
    {content:'hola',audience:'public',poll:{options:['Solo una',''],hours:24}},
    {uid:'u1'}, {}
  )`);
  return r && !('poll' in r);
});
tcase('D4 votación de guion de serie -> q regenerada al publicar', () => {
  const sb = schedBox();
  const r = call(sb, `drexSchedBuildNote(
    {content:'cap 3',audience:'public',poll:{options:['A','B'],hours:168},pollScriptVote:true,seriesSel:{id:'s1',title:'Saga',onda:'#onda'}},
    {uid:'u1'}, {}
  )`);
  return r && r.poll && r.poll.q === '¿Qué pasa en el próximo capítulo?' && !!r.series;
});
tcase('D5 endsAt se calcula al publicar, no al programar', () => {
  // draft.poll no trae endsAt: la ventana empieza cuando se publica.
  const sb = schedBox();
  const r = call(sb, `drexSchedBuildNote(
    {content:'h',audience:'public',poll:{options:['A','B'],hours:1}},
    {uid:'u1'}, {}
  )`);
  return r && r.poll && !('endsAt' in r.poll === false) && Math.abs(r.poll.endsAt - (Date.now() + 3600000)) < 60000;
});

// ---------- Parte E: puntos de integración estáticos en index.html ----------
tcase('E1 collectCurrentNoteDraft guarda la encuesta', () => {
  return html.includes('drexDraftPollFromEditor(notePostPoll)') && html.includes('draft.poll = _pp');
});
tcase('E2 loadCurrentNoteDraft restaura la encuesta y re-renderiza', () => {
  return html.includes('drexDraftPollFromEditor(draft.poll)') && html.includes('notePostPoll = { options: _rp.options.slice(), hours: _rp.hours }');
});
tcase('E3 renderDraftsList muestra la insignia de votación', () => {
  return html.includes('drexDraftHasPoll(draft)') && html.includes('🗳️');
});
tcase('E4 mensaje de programación actualizado (las encuestas ya viajan)', () => {
  return !html.includes('La programación aún solo admite texto')
    && html.includes('La programación aún no admite fotos ni videos. Publica normal o quita los adjuntos.');
});
tcase('E5 i18n del mensaje nuevo en EN/ZH/PT', () => {
  const key = 'La programación aún no admite fotos ni videos. Publica normal o quita los adjuntos.';
  return (html.split(key).length - 1) >= 4; // ES base + 3 traducciones
});
tcase('E6 helpers viven dentro del bloque DREX-SCHEDULED-POSTS (sandbox)', () => {
  return blockCode.includes('function drexDraftPollFromEditor')
    && blockCode.includes('function drexDraftPollForPublish')
    && blockCode.includes('function drexDraftHasPoll');
});

console.log('----------------------------------------');
console.log(failures === 0 ? 'C144 draft-poll: ALL PASS' : 'C144 draft-poll: ' + failures + ' FAIL');
process.exit(failures === 0 ? 0 : 1);
