// test-c80-music-reseal-pin.js — Música: la key pre-reservada de publishMusic
// debe pinearse (C80-F1).
//
// Defecto: publishMusic reserva K = push() y acopla a esa key los chunks
// (musicAudio/<K>), el meta (musicTracks/<K>), los índices (musicByAuthor,
// musicSearch, notesByAuthor), el anuncio (note.trackId) y la variable local
// `trackId`. Los sets son awaits SECUENCIALES: si la red cae entre ellos, la
// op encolada viaja SOLA en su flush y resealQueue la re-sella K->K2 mientras
// la app sigue usando K => pista sin audio / meta huérfana / índices y
// anuncio rotos (el límite diario se consume por una canción inservible).
// Fix: { noReseal: true } en los 5 sets acoplados (contrato de reseal,
// cláusula c; mismo patrón que el fan-out de grupos y el pin de media C14).
// El anuncio (communityNotes) NO se pinea: su key se lee de noteRef.key.
//
// Convención: estático + funcional contra el archivo del repo, sin rutas
// absolutas ni historial de git. Los checks SOLO pasan con el fix presente.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repoRoot = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf-8');
const cloud = fs.readFileSync(path.join(repoRoot, 'drex-cloud.js'), 'utf-8');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}
function extractFn(src, marker) {
  const start = src.indexOf(marker);
  assert(start >= 0, 'marcador no encontrado: ' + marker);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(start, i + 1);
}

// ---------- estático: los 5 sets acoplados llevan el pin ----------
const pubStart = html.indexOf('window.publishMusic = async function ()');
assert(pubStart >= 0, 'publishMusic no encontrada');
const pubEnd = html.indexOf('/* ---------- Editar / eliminar ---------- */', pubStart);
const pub = html.slice(pubStart, pubEnd > 0 ? pubEnd : pubStart + 20000);
check('F1: chunks llevan { noReseal: true }',
  /ref\('musicAudio\(' \+ trackId\)\.set\(chunkObj, \{ noReseal: true \}\)/.test(pub) ||
  pub.includes("ref('musicAudio/' + trackId).set(chunkObj, { noReseal: true })"));
check('F1: meta lleva { noReseal: true }',
  pub.includes('await trackRef.set(meta, { noReseal: true })'));
check('F1: musicByAuthor lleva { noReseal: true }',
  pub.includes("ref('musicByAuthor/' + uid + '/' + trackId).set({ t: meta.createdAt }, { noReseal: true })"));
check('F1: musicSearch lleva { noReseal: true }',
  /ref\('musicSearch\/' \+ trackId\)\.set\(\{[\s\S]*?\}, \{ noReseal: true \}\)/.test(pub));
check('F1: notesByAuthor lleva { noReseal: true }',
  pub.includes("ref('notesByAuthor/' + uid + '/' + noteRef.key).set({ t: note.timestamp || Date.now() }, { noReseal: true })"));
check('F1: el anuncio (communityNotes) NO se pinea (su key se lee de noteRef.key)',
  !/communityNotes'\)\.pushAsync\([^)]*noReseal/.test(pub));

// ---------- funcional: resealQueue REAL respeta el pin ----------
const verbatim = [
  extractFn(cloud, 'var PUSH_CHARS ='),
  extractFn(cloud, 'function newPushId()'),
  extractFn(cloud, 'function pushIdTime(id)'),
  'var RESEAL_MIN_TS = 1577836800000;',
  'var RESEAL_FUTURE_SKEW_MS = 60000;',
  extractFn(cloud, 'function looksLikePushId(seg, now)'),
  extractFn(cloud, 'function resealQueue(qq, me)'),
].join('\n');
const sandbox = { console, opOwnedByOther: () => false, currentOutboxUid: () => 'u1' };
vm.createContext(sandbox);
vm.runInContext(verbatim + '\nthis.__rq = resealQueue; this.__np = newPushId;', sandbox);
const resealQueue = vm.runInContext('__rq', sandbox);
const newPushId = vm.runInContext('__np', sandbox);

function flushSim(ops) {
  const q = ops.map(o => Object.assign({}, o));
  resealQueue(q, 'u1');
  return q.map(o => o.path);
}
(function () {
  const K = newPushId();
  const pinned = [
    { type: 'set', path: 'musicAudio/' + K, noReseal: true },
    { type: 'set', path: 'musicTracks/' + K, noReseal: true },
  ];
  const out = flushSim(pinned);
  check('F1: ops pineadas conservan la key al vaciar',
    out[0] === 'musicAudio/' + K && out[1] === 'musicTracks/' + K);
  const plain = [
    { type: 'set', path: 'musicAudio/' + K },
    { type: 'set', path: 'musicTracks/' + K },
  ];
  const out2 = flushSim(plain);
  check('F1: sin pin, el reseal SÍ reescribe la key (motivo del fix)',
    out2[0] !== 'musicAudio/' + K && out2[1] !== 'musicTracks/' + K &&
    out2[0].split('/')[1] === out2[1].split('/')[1]);
})();

console.log(fail ? `\n${fail} FALLO(S), ${pass} ok` : `\n${pass} ok`);
process.exit(fail ? 1 : 0);
