/* ================================================================
 * C79-F2: el voto del juego del mentiroso debe llevar el epoch de su
 * partida; el tally no debe contar votos de partidas anteriores.
 *
 * Defecto (base, PoC con BASE_POC=1): `fiestaGameVote` escribe
 * `fiestaGameSecrets/<sid>/votes/<uid> = <target>` (escalar, sin
 * identificar la partida). El dueño limpia `votes` al entrar en la
 * fase de votación y al iniciar cada partida, pero hay una ventana
 * real: un voto emitido durante la votación de la partida N que queda
 * ENCOLADO OFFLINE (Outbox de drex-cloud.js: el `set` se vacía al
 * recuperar la red) puede aterrizar DESPUÉS de la limpieza, ya durante
 * la votación de la partida N+1. El tally lo cuenta como voto fantasma
 * y puede eliminar a un jugador por un voto de la partida anterior.
 *
 * Fix: el voto se escribe como {t: target, e: startedAt de la partida}
 * y `fiestaGameHostTally` (y el espejo voteCount) solo cuentan votos
 * cuyo epoch coincide con el de la partida en curso. Los escalares
 * legacy (clientes sin refrescar) se siguen contando.
 *
 * Extrae las funciones REALES de ../index.html (sin rutas absolutas ni git).
 * Ejecutar con: node tests/test-c79-fiesta-vote-epoch.js
 * Con BASE_POC=1 se corre el PoC contra la base sin fix.
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const BASELINE = process.env.BASE_POC === '1';

function extractFn(src, name) {
  const m = new RegExp('function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('no encontrada: ' + name);
  let i = src.indexOf('{', m.index);
  const start = m.index;
  let depth = 0, str = null, tpl = 0, lineC = false, blockC = false, esc = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (lineC) { if (c === '\n') lineC = false; continue; }
    if (blockC) { if (c === '*' && n === '/') { blockC = false; i++; } continue; }
    if (str) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (str === '`' && c === '$' && n === '{') { tpl++; i++; continue; }
      if (c === str && tpl === 0) { str = null; continue; }
      if (str === '`' && c === '}' && tpl > 0) { tpl--; continue; }
      continue;
    }
    if (c === '/' && n === '/') { lineC = true; i++; continue; }
    if (c === '/' && n === '*') { blockC = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { str = c; tpl = 0; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('llaves sin cerrar: ' + name);
}

let FNS = ['fiestaGameVote', 'fiestaGameHostTally']
  .map(n => extractFn(HTML, n)).join('\n');
try { FNS += '\n' + extractFn(HTML, 'fiestaGameVoteTarget'); } catch (_) { /* base: no existe */ }

// --- Sandbox: DB en memoria + actores del juego ---
function makeSandbox() {
  const store = {};            // path -> valor
  const eliminated = [];       // uids eliminados por el tally
  const docUpdates = [];       // updates al doc del juego
  const E1 = 1000000, E2 = 2000000; // epochs de las partidas N y N+1
  const sb = {
    console,
    Date,
    fiestaCur: { id: 'SID' },
    fiestaMyUid: 'G',
    fiestaGame: { status: 'vote', startedAt: E1, players: ['A', 'B', 'G'], out: [], round: 1, voteEndsAt: Date.now() + 30000 },
    fiestaAmHost: false,
    fiestaGameMyVote: null,
    fiestaGameActivePlayers: () => ['A', 'B', 'G'],
    fiestaGameFirstActive: () => 0,
    fiestaGameRender: () => {},
    showMiniToast: () => {},
    appT: (s) => s,
    fiestaGameHostReadSecrets: () => Promise.resolve({ pair: ['x', 'y'], liars: [], byUid: {} }),
    fiestaGameHostEliminate: (ref, g, uid) => { eliminated.push(uid); },
    DrexCloud: {
      database: () => ({
        ref: (p) => ({
          set: (v) => { store[p] = v; return Promise.resolve(); },
          update: (v) => { docUpdates.push(v); return Promise.resolve(); },
          remove: () => { Object.keys(store).forEach(k => { if (k === p || k.startsWith(p + '/')) delete store[k]; }); return Promise.resolve(); },
          once: () => Promise.resolve({ val: () => null }),
        }),
      }),
    },
    _store: store, _eliminated: eliminated, _docUpdates: docUpdates, _E1: E1, _E2: E2,
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(FNS, sb, { filename: 'fiesta-vote-fns.js' });
  return sb;
}

async function flush() { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); }

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

(async () => {
  // Escenario común: G vota en la partida N (epoch E1) estando offline;
  // el write queda encolado y se vacía DURANTE la votación de la partida
  // N+1 (epoch E2), después de la limpieza de votes. Nadie vota en N+1.
  async function scenarioStaleFlush() {
    const sb = makeSandbox();
    // 1. G vota en la partida N (su cliente aún ve E1 en votación).
    vm.runInContext("fiestaGameVote('B')", sb);
    await flush();
    const queuedValue = sb._store['fiestaGameSecrets/SID/votes/G'];
    assert.ok(queuedValue !== undefined, 'el voto de G debe haberse escrito (encolado)');
    // 2. El dueño inicia la partida N+1: limpia votes (el flush aún no llegó).
    Object.keys(sb._store).forEach(k => { if (k.startsWith('fiestaGameSecrets/SID/votes')) delete sb._store[k]; });
    // 3. La partida N+1 entra en votación: el dueño vuelve a limpiar.
    Object.keys(sb._store).forEach(k => { if (k.startsWith('fiestaGameSecrets/SID/votes')) delete sb._store[k]; });
    // 4. La red vuelve: el voto encolado de la partida N aterriza AHORA.
    sb._store['fiestaGameSecrets/SID/votes/G'] = queuedValue;
    // 5. El dueño hace el tally de la partida N+1 (epoch E2), sin votos propios.
    const votes = {};
    Object.keys(sb._store).forEach(k => {
      const m = k.match(/^fiestaGameSecrets\/SID\/votes\/([^/]+)$/);
      if (m) votes[m[1]] = sb._store[k];
    });
    const g2 = { status: 'vote', startedAt: sb._E2, players: ['A', 'B', 'G'], out: [], round: 1 };
    const ref = { update: (v) => { sb._docUpdates.push(v); return Promise.resolve(); } }; // C80: update() real devuelve promesa
    vm.runInContext('fiestaGameHostTally(__ref, __g2, __votes)', Object.assign(sb, { __ref: ref, __g2: g2, __votes: votes }));
    await flush();
    return sb;
  }

  if (BASELINE) {
    await test('BASE: el voto stale de la partida N contamina el tally de N+1 (elimina a B)', async () => {
      const sb = await scenarioStaleFlush();
      assert.ok(sb._eliminated.includes('B'),
        'el tally eliminó a B por un voto de la partida anterior; eliminados=' + JSON.stringify(sb._eliminated));
    });
  } else {
    await test('voto stale de la partida N NO contamina el tally de N+1', async () => {
      const sb = await scenarioStaleFlush();
      assert.ok(!sb._eliminated.includes('B'),
        'B no debe ser eliminado por un voto stale; eliminados=' + JSON.stringify(sb._eliminated));
    });
    await test('control: un voto legítimo de la partida en curso SÍ cuenta', async () => {
      const sb = makeSandbox();
      sb.fiestaGame.startedAt = sb._E2; // votar ya dentro de N+1
      vm.runInContext("fiestaGameVote('B')", sb);
      await flush();
      const votes = { G: sb._store['fiestaGameSecrets/SID/votes/G'] };
      const g2 = { status: 'vote', startedAt: sb._E2, players: ['A', 'B', 'G'], out: [], round: 1 };
      const ref = { update: (v) => { sb._docUpdates.push(v); return Promise.resolve(); } }; // C80: update() real devuelve promesa
      vm.runInContext('fiestaGameHostTally(__ref, __g2, __votes)', Object.assign(sb, { __ref: ref, __g2: g2, __votes: votes }));
      await flush();
      assert.ok(sb._eliminated.includes('B'), 'el voto legítimo debe contar; eliminados=' + JSON.stringify(sb._eliminated));
    });
    await test('control: voto escalar legacy (cliente sin refrescar) se sigue contando', async () => {
      const sb = makeSandbox();
      const votes = { A: 'C' }; // escalar, formato anterior al fix
      const g2 = { status: 'vote', startedAt: sb._E2, players: ['A', 'B', 'C'], out: [], round: 1 };
      sb.fiestaGameActivePlayers = () => ['A', 'B', 'C'];
      const ref = { update: (v) => { sb._docUpdates.push(v); return Promise.resolve(); } }; // C80: update() real devuelve promesa
      vm.runInContext('fiestaGameHostTally(__ref, __g2, __votes)', Object.assign(sb, { __ref: ref, __g2: g2, __votes: votes }));
      await flush();
      assert.ok(sb._eliminated.includes('C'), 'el voto legacy debe contar; eliminados=' + JSON.stringify(sb._eliminated));
    });
  }
  console.log(failed ? `\n${failed} FALLO(S), ${passed} ok` : `\n${passed} ok`);
  process.exit(failed ? 1 : 0);
})();
