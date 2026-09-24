// test-c80-fiesta-secrets-cleanup.js — Mentiroso: los secretos del juego no
// deben quedar huérfanos al terminar la fiesta (C80-F3).
//
// Defecto: fiestaGameSecrets/<sid> (palabras secretas, flags de mentiroso,
// votos) solo se borraba en fiestaGameEndForAll ("Terminar el juego para
// todos"). Al terminar la fiesta con endFiesta() o con la limpieza de
// anfitrión caído (fiestaGameCheckHostGone), los secretos quedaban
// abandonados para siempre: fuga de almacenamiento y de datos sensibles del
// juego.
// Fix: endFiesta() y fiestaGameCheckHostGone() borran fiestaGameSecrets/<id>
// (best-effort, como el resto de la limpieza).
//
// Convención: estático + funcional contra el archivo del repo, sin rutas
// absolutas ni historial de git. Los checks SOLO pasan con el fix presente.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf-8');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}
function extractFn(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marcador no encontrado: ' + marker);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(start, i + 1);
}

// ---------- estático ----------
const endFiestaSrc = extractFn(html, 'async function endFiesta()');
const hostGoneSrc = extractFn(html, 'function fiestaGameCheckHostGone()');
check('F3: endFiesta borra fiestaGameSecrets/<id>',
  endFiestaSrc.includes("ref('fiestaGameSecrets/' + id).remove()"));
check('F3: fiestaGameCheckHostGone borra fiestaGameSecrets/<id>',
  hostGoneSrc.includes("ref('fiestaGameSecrets/' + fiestaCur.id).remove()"));

// ---------- funcional: anfitrión caído => se emite el remove de secretos ----------
(async () => {
  const removed = [];
  const dbStub = {
    ref(p) {
      return {
        remove() { removed.push(p); return Promise.resolve(); },
        once() { return Promise.resolve({ val: () => null }); },
      };
    },
  };
  const sandbox = {
    console,
    _fiestaGameStaleNotified: false,
    fiestaGame: { status: 'vote', voteEndsAt: Date.now() - 60000 },
    fiestaAmHost: false,
    fiestaCur: { id: 'f9', data: { hostId: 'host1' } },
    fiestaGameMember: () => null, // anfitrión ausente
    fiestaGamePhaseEndsAt: () => Date.now() - 60000,
    fiestaGameMySecret: null,
    fiestaGameSecretEpoch: null,
    fiestaGameHideAll: () => {},
    appT: s => s,
    showMiniToast: () => {},
    DrexCloud: { database: () => dbStub },
  };
  vm.createContext(sandbox);
  vm.runInContext(hostGoneSrc, sandbox);
  vm.runInContext('fiestaGameCheckHostGone()', sandbox);
  await new Promise(r => setTimeout(r, 50));
  check('F3: con anfitrión caído se borra el doc del juego',
    removed.includes('fiestas/f9/game'));
  check('F3: con anfitrión caído se borran los secretos',
    removed.includes('fiestaGameSecrets/f9'));
  console.log(fail ? `\n${fail} FALLO(S), ${pass} ok` : `\n${pass} ok`);
  process.exit(fail ? 1 : 0);
})();
