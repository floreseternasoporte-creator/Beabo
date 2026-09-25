// BARO Bloque 1 — regresión: la función "Series" fue eliminada por completo.
// El usuario ordenó quitar "Series" de la sección de crear y todas sus
// referencias (2026-09-25). Este test fija la ausencia: si algún identificador
// de Series reaparece en index.html, falla y obliga a re-auditar.
// Además verifica que el editor de Votaciones sobrevivió intacto.
// Uso: node tests/test-baro1-no-series.js [--target=html]
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

// 1. Identificadores técnicos de Series: cero ocurrencias.
const absent = [
  'drexSerie', 'DrexSerie', 'notePostSeriesId', 'notePostSerie',
  'SeriePicker', 'serie-panel', 'serie-toggle', 'renderSerieBadge',
  'DREX_SERIE_SVG', 'DREX_SERIE', 'drex-serie', 'note-serie',
  'serie-view', 'openSerieView', 'closeSerieView', 'serie/:uid',
  'toggleSeriePicker', 'selectNoteSerie', 'seriesSel', 'pollScriptVote',
  'loadProfileSeriesTab', 'series-tab-content', 'serie-kicker', 'serie-body',
];
for (const pat of absent) {
  ok('ausente: ' + pat, !html.includes(pat));
}
// La palabra "serie" (cualquier capitalización) no debe aparecer en absoluto.
ok('cero ocurrencias de /serie/i', !/serie/i.test(html));

// 2. El editor de Votaciones sobrevivió: funciones y CSS intactos.
const present = [
  'toggleNotePoll', 'renderNotePollEditor', 'notePostPoll',
  'drex-poll-q', 'publishNoteToDatabase', 'publishNoteFromFullscreen',
];
for (const pat of present) {
  ok('presente (votaciones): ' + pat, html.includes(pat));
}

// 3. El composer conserva sus toggles no-Series.
ok('toggleNoteSpoiler presente', html.includes('toggleNoteSpoiler'));
ok('toggleNoteSensitive presente', html.includes('toggleNoteSensitive'));

if (failures) { console.error(failures + ' fallos'); process.exit(1); }
console.log('ALL PASS');
