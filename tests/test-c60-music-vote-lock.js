// test-c60-music-vote-lock.js — música/votos: el lock se liberaba antes de que
// el registro del voto aterrizara en el servidor (C60-M1).
//
// Flujo del bug: voteMusicTrack tomaba _musicVoteLock, leía serverVote con
// once('value'), aplicaba la transacción sobre musicTracks/<id> y liberaba el
// lock INMEDIATAMENTE, con el set()/remove() de musicVotes/<uid>/<id> aún en
// vuelo. Un segundo voto inmediato (doble-tap) leía serverVote stale (null) y
// la transacción sumaba de nuevo sin restar el voto previo: upvotes/downvotes
// inflados de forma permanente (verificado: doble 'up' dejaba up=12 en vez de
// up=10 tras el toggle-off).
//
// Fix: el lock se libera cuando el registro del voto confirma en el servidor
// (promesa del set/remove encadenada), con timeout de seguridad de 10 s para
// no bloquear los votos si la escritura se cuelga.
//
// Convención: estático + funcional contra el archivo del repo, sin rutas
// absolutas ni historial de git. Los checks SOLO pasan con el fix presente.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repoRoot = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf-8');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

// Extrae el bloque real: desde `var _musicVoteLock` hasta el fin de
// window.voteMusicTrack (respeta strings/comments/template literals).
function extractBlock(src, startMarker) {
  const start = src.indexOf(startMarker);
  assert(start !== -1, 'no se encontró: ' + startMarker);
  let i = src.indexOf('{', start);
  let depth = 0, inStr = null, inLine = false, inBlock = false, prev = '';
  for (; i < src.length; i++) {
    const c = src[i], nx = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; }
    else if (inBlock) { if (c === '*' && nx === '/') { inBlock = false; i++; } }
    else if (inStr) { if (c === inStr && prev !== '\\') inStr = null; }
    else if (c === '/' && nx === '/') inLine = true;
    else if (c === '/' && nx === '*') { inBlock = true; i++; }
    else if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
    prev = c;
  }
  return src.slice(start, i + 1);
}

const lockIdx = html.indexOf('var _musicVoteLock = false;');
assert(lockIdx !== -1, 'no se encontró _musicVoteLock');
const voteMarker = 'window.voteMusicTrack = function (voteType)';
const voteStart = html.indexOf(voteMarker);
assert(voteStart !== -1, 'no se encontró voteMusicTrack');
const voteFn = extractBlock(html, voteMarker);
const block = html.slice(lockIdx, voteStart + voteFn.length);
assert(block.includes('_musicVoteRepaint'), 'bloque incompleto');

// ---------- estático ----------
check('C60: existe el helper _releaseVoteLock',
  /const _releaseVoteLock = \(\) => \{ _musicVoteLock = false; \};/.test(block));
check('C60: el .then(res => ya NO libera el lock de inmediato',
  !/\}\)\.then\(res => \{\s*\n\s*_musicVoteLock = false;/.test(block));
check('C60: el write del registro del voto se captura en promesa',
  /_voteWriteP = \(newVote === null\) \? userVoteRef\.remove\(\) : userVoteRef\.set\(newVote\)/.test(block));
check('C60: la liberación se encadena a la confirmación del write',
  /_voteWriteP\.then\(_relVoteLock, _relVoteLock\)/.test(block));
check('C60: timeout de seguridad anti-deadlock (10 s)',
  /setTimeout\(_relVoteLock, 10000\)/.test(block));
check('C60: el catch externo sigue liberando de inmediato (fail-safe)',
  /\}\)\.catch\(\(\) => \{ _musicVoteLock = false;/.test(block));

// ---------- funcional: funciones reales en vm con BD falsa ----------
const delay = ms => new Promise(r => setTimeout(r, ms));

function makeWorld(delays) {
  const server = {
    track: { upvotes: 10, downvotes: 2, authorId: 'author1' },
    userVote: null,
  };
  const snap = v => ({ val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))) });
  function refFor(p) {
    const isTrack = p === 'musicTracks/t1';
    const isVote = p === 'musicVotes/u1/t1';
    return {
      once: async () => { await delay(delays.read); return snap(isTrack ? server.track : isVote ? server.userVote : { username: 'tester' }); },
      set: async v => { await delay(delays.write); if (isVote) server.userVote = v; },
      remove: async () => { await delay(delays.write); if (isVote) server.userVote = null; },
      transaction: async updateFn => {
        await delay(delays.read);
        const cur = isTrack ? JSON.parse(JSON.stringify(server.track)) : null;
        const nv = updateFn(cur);
        await delay(delays.txWrite);
        if (nv === undefined) return { committed: false };
        if (isTrack) server.track = nv;
        return { committed: true, snapshot: snap(nv) };
      },
      transactionBlind: async () => { await delay(delays.write); return { committed: true }; },
      child: c => refFor(p + '/' + c),
    };
  }
  const sandbox = {
    window: {},
    console,
    Promise,
    // setTimeout con unref: el timeout de seguridad del fix no debe mantener
    // vivo el proceso del test.
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    clearTimeout,
    musicQueue: [{ id: 't1', upvotes: 10, downvotes: 2 }],
    musicQueueIdx: 0,
    musicCurrentTrackId: () => 't1',
    musicWeekId: () => '2026-W39',
    musicDb: () => ({ ref: refFor }),
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'u1', displayName: 'Tester' } }),
      database: () => ({ ref: refFor }),
    },
    document: { getElementById: () => null },
    showMiniToast: () => {}, appT: s => s, addNotification: () => {}, formatVoteScore: String,
    __server: server,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox, { filename: 'vote-block-c60.js' });
  return sandbox;
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (!fn()) {
    assert(Date.now() - t0 < timeoutMs, 'timeout esperando: ' + label);
    await delay(5);
  }
}

(async () => {
  // 1) Voto simple: funciona y el lock se libera al final.
  {
    const sb = makeWorld({ read: 20, txWrite: 20, write: 60 });
    sb.window.voteMusicTrack('up');
    await waitFor(() => sb._musicVoteLock === false, 5000, 'lock voto simple');
    await delay(120);
    const t = sb.__server;
    check('C60: voto simple aplica +1 y registra el voto', t.track.upvotes === 11 && t.userVote === 'up');
  }

  // 2) El lock se MANTIENE tomado mientras el registro del voto está en vuelo
  //    (transacción del track ya commiteada, set() aún sin aterrizar).
  {
    const sb = makeWorld({ read: 10, txWrite: 10, write: 600 });
    sb.window.voteMusicTrack('up');
    await waitFor(() => sb.__server.track.upvotes === 11, 5000, 'commit de la transacción');
    await delay(50);
    const heldDuringFlight = sb._musicVoteLock === true && sb.__server.userVote === null;
    check('C60: el lock sigue tomado con el set() en vuelo', heldDuringFlight);
    await waitFor(() => sb._musicVoteLock === false, 5000, 'liberación tras el set');
    check('C60: el lock se libera cuando el registro aterriza', sb.__server.userVote === 'up');
  }

  // 3) Doble-tap rápido up,up (toggle-off): sin el fix deja up=12 (stale).
  {
    const sb = makeWorld({ read: 30, txWrite: 30, write: 300 });
    sb.window.voteMusicTrack('up');
    await waitFor(() => sb._musicVoteLock === false, 5000, 'lock voto 1');
    sb.window.voteMusicTrack('up'); // toggle: el usuario toca otra vez de inmediato
    await waitFor(() => sb._musicVoteLock === false, 5000, 'lock voto 2');
    await delay(400);
    const t = sb.__server;
    check('C60: doble-tap up,up deja contadores consistentes (up=10, voto=null)',
      t.track.upvotes === 10 && t.track.downvotes === 2 && t.userVote === null);
  }

  // 4) Cambio rápido up -> down: el segundo voto ve el primero.
  {
    const sb = makeWorld({ read: 30, txWrite: 30, write: 300 });
    sb.window.voteMusicTrack('up');
    await waitFor(() => sb._musicVoteLock === false, 5000, 'lock voto up');
    sb.window.voteMusicTrack('down');
    await waitFor(() => sb._musicVoteLock === false, 5000, 'lock voto down');
    await delay(400);
    const t = sb.__server;
    check('C60: cambio rápido up->down queda consistente (up=10, down=3, voto=down)',
      t.track.upvotes === 10 && t.track.downvotes === 3 && t.userVote === 'down');
  }

  console.log(`\n${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
