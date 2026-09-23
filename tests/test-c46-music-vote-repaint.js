// CICLO 46 (C46-M1) — voteMusicTrack pintaba el resultado del voto aunque la
// canción actual hubiera cambiado mientras el voto volaba por la red: los
// botones de voto son globales al reproductor, así que el score/estado de la
// canción A se dibujaba sobre la canción B.
//
// El fix agrega _musicVoteRepaint(trackId, paintFn): si la canción actual ya
// no es la votada, repinta el estado de la canción ACTUAL (musicLoadVoteState)
// en vez del resultado stale.
//
// Convención del repo: resuelve ../index.html con fallback a ../src/index.html;
// no depende del historial de git; sin rutas absolutas.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function findFile(names) {
  const cands = [];
  for (const n of names) {
    cands.push(path.join(__dirname, '..', n));
    cands.push(path.join(__dirname, '..', 'src', n));
  }
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('no encontrado: ' + names.join(' / '));
}
const html = fs.readFileSync(findFile(['index.html']), 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}

function extractVoteBlock() {
  const a = html.indexOf('var _musicVoteLock = false;');
  if (a < 0) throw new Error('sin ancla lock');
  const fa = html.indexOf('window.voteMusicTrack = function (voteType) {', a);
  if (fa < 0) throw new Error('sin ancla voteMusicTrack');
  const j = html.indexOf('{', fa);
  let depth = 0, inS = null, esc = false;
  for (let k = j; k < html.length; k++) {
    const c = html[k];
    if (inS) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inS) inS = null; continue; }
    if (c === "'" || c === '"' || c === '`') { inS = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (!depth) return html.slice(a, k + 1); }
  }
  throw new Error('sin cierre voteMusicTrack');
}

const block = extractVoteBlock();

// ---- 1. Estático ------------------------------------------------------------
check('_musicVoteRepaint existe', block.includes('function _musicVoteRepaint(trackId, paintFn)'));
check('el guard compara contra musicCurrentTrackId()', block.includes('musicCurrentTrackId() !== trackId'));
check('en stale llama a musicLoadVoteState', /musicLoadVoteState\(\)/.test(block));
check('los 3 sitios async usan _musicVoteRepaint', (block.match(/_musicVoteRepaint\(trackId, \(\) =>/g) || []).length === 3);

function fakeEl() {
  const classes = new Set();
  return {
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, f) => { f ? classes.add(c) : classes.delete(c); },
      contains: (c) => classes.has(c)
    },
    setAttribute: () => {}, textContent: ''
  };
}

async function runCase() {
  const pending = [];
  const sandbox = {
    console,
    musicQueue: [
      { id: 'A', upvotes: 3, downvotes: 1 },
      { id: 'B', upvotes: 10, downvotes: 2 }
    ],
    musicQueueIdx: 0,
    musicAudioEl: null,
    document: { getElementById: () => fakeEl() },
    appT: (s) => s,
    showMiniToast: () => {},
    formatVoteScore: (s) => String(s),
    musicWeekId: () => 'W1',
    addNotification: () => {},
    musicDb: () => ({
      ref: (p) => ({
        once: () => new Promise((res) => pending.push({ kind: 'once', res })),
        transaction: (fn) => new Promise((res) => pending.push({ kind: 'tx', res })),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
        child: () => ({ transactionBlind: () => Promise.resolve() })
      })
    }),
    DrexCloud: {
      database: () => ({
        ref: (p) => ({ once: () => Promise.resolve({ val: () => ({ username: 'ana' }) }) })
      }),
      auth: () => ({ currentUser: { uid: 'u1', displayName: 'Ana' } })
    }
  };
  const sb = sandbox;
  sandbox.musicCurrentTrackId = () => { const t = sb.musicQueue[sb.musicQueueIdx]; return t ? t.id : null; };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  // Espías sobre las funciones REALES del bloque (definidas ahí; harían
  // sombra a propiedades del sandbox).
  vm.runInContext(
    'var __paintCalls = [];\n' +
    'var __realPaint = musicPaintVoteUI;\n' +
    'musicPaintVoteUI = function (u, d, s) { __paintCalls.push([u, d, s]); return __realPaint(u, d, s); };\n' +
    'var __loadCalls = 0;\n' +
    'var __realLoad = musicLoadVoteState;\n' +
    'musicLoadVoteState = function () { __loadCalls++; return __realLoad(); };',
    sandbox);
  const flush = async (n) => { for (let i = 0; i < (n || 6); i++) await new Promise(r => setImmediate(r)); };

  // 1. Voto 'up' en la canción A -> pintado optimista (correcto)
  vm.runInContext('voteMusicTrack("up")', sandbox);
  await flush();
  const optimistic = vm.runInContext('__paintCalls.length', sandbox);
  // 2. Cambio a B antes de que resuelva la red
  sb.musicQueueIdx = 1;
  // 3. Resuelve once -> sin voto previo
  pending.find(p => p.kind === 'once').res({ val: () => null });
  await flush();
  // 4. Resuelve la transacción de A (committed, up 4 / down 1 => score 3)
  pending.find(p => p.kind === 'tx').res({ committed: true, snapshot: { val: () => ({ upvotes: 4, downvotes: 1, authorId: 'a9' }) } });
  await flush(12);

  return {
    afterSwitch: vm.runInContext('__paintCalls', sandbox).slice(optimistic),
    loadCalls: vm.runInContext('__loadCalls', sandbox)
  };
}

(async () => {
  // ---- 2. Funcional: voto en A, cambio a B mid-flight ----
  const r = await runCase();
  check('NO pinta el resultado de A sobre la UI de B', !r.afterSwitch.some(p => p[2] === 3));
  check('repinta el estado de la canción actual (B, score 8)', r.loadCalls >= 1);

  console.log(failures ? '\nFAIL (' + failures + ')' : '\nOK');
  process.exit(failures ? 1 : 0);
})();
