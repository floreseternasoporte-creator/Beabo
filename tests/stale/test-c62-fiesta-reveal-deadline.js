/* ================================================================
 * C62-F1: el deadline del revelado debe anclarse a la PUBLICACIÓN,
 * no al inicio del tally.
 *
 * Defecto (base): fiestaGameHostTally() captura `var now = Date.now()`
 * ANTES de la lectura asíncrona de secretos
 * (fiestaGameHostReadSecrets: N lecturas a fiestaGameSecrets/<sid>/<uid>),
 * y luego fiestaGameHostEliminate() publica `revealEndsAt: now + 9000`.
 * Con latencia de red, el revelado queda acortado en lo que tarde la
 * lectura; con latencia >= 9 s, revealEndsAt nace VENCIDO y el host loop
 * (g.status === 'reveal' → now >= revealEndsAt → afterReveal) salta la
 * fase de revelado en el siguiente tick: los jugadores no ven quién
 * salió ni su palabra.
 *
 * PoC determinista: reloj falso + lectura de secretos con 12 s de
 * latencia simulada. Se exige revealEndsAt - instante_de_publicación
 * dentro de [8500, 9500] ms.
 * En base falla (slack = -3000 ms); con el fix pasa (slack = 9000 ms).
 *
 * Extrae las funciones REALES de ../index.html (sin rutas absolutas ni git).
 * Ejecutar con: node tests/test-c62-fiesta-reveal-deadline.js
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Extracción por balanceo de llaves (respeta strings y comentarios).
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

const FNS = ['fiestaGameHostTally', 'fiestaGameHostEliminate', 'fiestaGameHostReadSecrets']
  .map(n => extractFn(HTML, n)).join('\n');
// C79-F2: el tally normaliza votos vía fiestaGameVoteTarget (tolerante si el
// árbol bajo prueba aún no trae el helper: shim identidad = payload escalar).
let VOTE_TARGET_FN = '';
try { VOTE_TARGET_FN = extractFn(HTML, 'fiestaGameVoteTarget'); }
catch (_) { VOTE_TARGET_FN = 'function fiestaGameVoteTarget(vt, epoch) { return vt || null; }'; }
const FNS_ALL = VOTE_TARGET_FN + '\n' + FNS;

const SECRET_LATENCY_MS = 12000; // latencia simulada de la lectura de secretos

function makeSandbox() {
  let now = 1000000;
  const updates = [];
  let readAdvanced = false; // Promise.all = lecturas en paralelo: un solo RTT
  const sandbox = {
    Date: { now: () => now },
    fiestaCur: { id: 'FIESTA1' },
    fiestaGameActivePlayers: () => ['A', 'B', 'C'],
    fiestaGameFirstActive: (out) => ['A', 'B', 'C'].find(u => (out || []).indexOf(u) === -1),
    DrexCloud: {
      database: () => ({
        ref: (p) => ({
          once: () => {
            if (!readAdvanced) { readAdvanced = true; now += SECRET_LATENCY_MS; }
            const uid = String(p).split('/').pop();
            return Promise.resolve({ val: () => ({ w: 'manzana', liar: uid === 'C' }) });
          },
          update: (obj) => { updates.push({ at: now, obj }); return Promise.resolve(); },
          remove: () => Promise.resolve(),
        }),
      }),
    },
    console,
    _clock: () => now,
    _updates: updates,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(FNS_ALL, sandbox, { filename: 'fiesta-tally-fns.js' });
  return sandbox;
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

(async () => {
  await test('el revelado concede ~9 s desde su publicación aunque la lectura de secretos tarde 12 s', async () => {
    const sb = makeSandbox();
    const ref = { update: (obj) => sb.DrexCloud.database().ref('x').update(obj) };
    const g = { players: ['A', 'B', 'C'], out: [], round: 1 };
    const votes = { A: 'B', C: 'B' }; // B eliminado (2 votos)
    vm.runInContext('fiestaGameHostTally(ref, g, votes)', Object.assign(sb, { ref, g, votes }));
    await flush();
    assert.strictEqual(sb._updates.length, 1, 'se esperaba 1 publicación, hubo ' + sb._updates.length);
    const pub = sb._updates[0];
    assert.strictEqual(pub.obj.status, 'reveal', 'status=' + pub.obj.status);
    assert.strictEqual(pub.obj.revealed.uid, 'B', 'eliminado=' + pub.obj.revealed.uid);
    const slack = pub.obj.revealEndsAt - pub.at;
    assert(slack >= 8500 && slack <= 9500,
      'revealEndsAt quedó a ' + slack + ' ms de la publicación (se esperaban ~9000 ms)');
  });

  await test('el eliminado sigue siendo B y su palabra viaja en el revelado', async () => {
    const sb = makeSandbox();
    const ref = { update: (obj) => sb.DrexCloud.database().ref('x').update(obj) };
    const g = { players: ['A', 'B', 'C'], out: [], round: 1 };
    const votes = { A: 'B', C: 'B' };
    vm.runInContext('fiestaGameHostTally(ref, g, votes)', Object.assign(sb, { ref, g, votes }));
    await flush();
    const pub = sb._updates[0];
    assert.strictEqual(pub.obj.revealed.word, 'manzana', 'palabra=' + pub.obj.revealed.word);
    assert.deepStrictEqual(pub.obj.out, ['B'], 'out=' + JSON.stringify(pub.obj.out));
  });

  console.log(failed ? `\n${failed} FALLO(S), ${passed} ok` : `\n${passed} ok`);
  process.exit(failed ? 1 : 0);
})();
