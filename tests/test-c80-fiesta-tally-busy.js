// test-c80-fiesta-tally-busy.js — Mentiroso: el guarda anti-doble-tally debe
// liberarse si la escritura del tally falla (C80-F2).
//
// Defecto: fiestaGameHostTick pone fiestaGameHostBusy=true y llama a
// fiestaGameHostTally; los ref.update() del tally no tenían .catch. Con red
// a medias tras reconectar (lecturas OK, escrituras fallidas) el update
// rechazaba, busy quedaba en true para siempre y el juego se congelaba en
// fase 'vote' (el tick siguiente se bloquea por el guarda).
// Fix: cada update terminal del tally lleva .catch que rearma
// fiestaGameHostBusy=false; el próximo tick reintenta el tally (idempotente:
// el doc nunca salió de 'vote').
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
const tallySrc = extractFn(html, 'function fiestaGameHostTally(ref, g, votes)');
const elimSrc = extractFn(html, 'function fiestaGameHostEliminate(ref, g, uid, word, isLiar, liars, pair)');
check('F2: los updates terminales del tally rearman fiestaGameHostBusy al fallar',
  (tallySrc.match(/fiestaGameHostBusy = false/g) || []).length >= 3 &&
  (elimSrc.match(/fiestaGameHostBusy = false/g) || []).length >= 2);

// ---------- funcional: red a medias => busy se libera y el retry avanza ----------
const verbatim = [
  extractFn(html, 'function fiestaGameVoteTarget(vt, epoch)'),
  tallySrc,
  elimSrc,
].join('\n');
let updateCalls = 0;
const dbStub = {
  ref() {
    return {
      update() { updateCalls++; return Promise.reject(new Error('write fail')); },
      remove() { return Promise.resolve(); },
      once() { return Promise.resolve({ val: () => ({}) }); },
    };
  },
};
const EPOCH = 1727000000000;
const sandbox = {
  console,
  fiestaGameHostBusy: false,
  fiestaCur: { id: 'f1' },
  fiestaGameActivePlayers: () => ['a', 'b', 'c', 'd'],
  fiestaGameFirstActive: () => 0,
  fiestaGameHostReadSecrets: () => Promise.resolve({
    pair: ['playa', 'montaña'], liars: ['b'],
    byUid: { a: { w: 'playa' }, b: { w: 'montaña', liar: true } },
  }),
  DrexCloud: { database: () => dbStub },
};
vm.createContext(sandbox);
vm.runInContext(verbatim, sandbox);
process.on('unhandledRejection', () => {});
const flush = () => new Promise(r => setTimeout(r, 50));
const busy = () => vm.runInContext('fiestaGameHostBusy', sandbox);

(async () => {
  const g = { status: 'vote', round: 1, out: [], players: ['a', 'b', 'c', 'd'], startedAt: EPOCH };
  const votes = { a: { t: 'b', e: EPOCH }, b: { t: 'c', e: EPOCH }, c: { t: 'b', e: EPOCH }, d: { t: 'b', e: EPOCH } };
  // tick 1 (réplica de fiestaGameHostTick en fase vote)
  if (!busy()) {
    vm.runInContext('fiestaGameHostBusy = true', sandbox);
    try { vm.runInContext('fiestaGameHostTally(__ref, __g, __votes)', Object.assign(sandbox, { __ref: dbStub.ref(), __g: g, __votes: votes })); }
    catch (e) { vm.runInContext('fiestaGameHostBusy = false', sandbox); }
  }
  await flush(); await flush();
  check('F2: tras fallar la escritura del tally, el guarda se libera', busy() === false);
  // tick 2: el guarda libre permite reintentar
  let retried = false;
  if (!busy()) {
    vm.runInContext('fiestaGameHostBusy = true', sandbox);
    try { vm.runInContext('fiestaGameHostTally(__ref, __g, __votes)', Object.assign(sandbox, { __ref: dbStub.ref(), __g: g, __votes: votes })); retried = true; }
    catch (e) { vm.runInContext('fiestaGameHostBusy = false', sandbox); }
  }
  await flush(); await flush();
  check('F2: el tick siguiente reintenta el tally', retried && updateCalls >= 2);
  console.log(fail ? `\n${fail} FALLO(S), ${pass} ok` : `\n${pass} ok`);
  process.exit(fail ? 1 : 0);
})();
