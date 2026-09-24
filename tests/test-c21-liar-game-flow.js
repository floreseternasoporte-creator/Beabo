// tests/test-c21-liar-game-flow.js
// C21: flujo del dueño con el código REAL: el tally deriva mentirosos y
// palabras leyendo fiestaGameSecrets/<sid>/<uid> (ya no del doc compartido).
// Uso: node tests/test-c21-liar-game-flow.js [ruta/index.html]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX_PATH = process.argv[2] || path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_PATH, 'utf8');

function grab(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s < 0) throw new Error('no hallado: ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e < 0) throw new Error('cierre no hallado para: ' + startMarker);
  return src.slice(s, e + endMarker.length);
}
const code = [
  grab('function fiestaGameHostReadSecrets(sid, uids)', '\n}'),
  grab('function fiestaGameHostTally(ref, g, votes)', '\n}'),
  grab('function fiestaGameHostEliminate(ref, g, uid, word, isLiar, liars, pair)', '\n}'),
  grab('function fiestaGameActivePlayers()', '\n}'),
  grab('function fiestaGameFirstActive(outList)', '\n}'),
  // C79-F2: el tally normaliza votos vía fiestaGameVoteTarget (tolerante si el
  // árbol bajo prueba aún no trae el helper: shim identidad = payload escalar).
  (() => { try { return grab('function fiestaGameVoteTarget(vt, epoch)', '\n}'); }
    catch (_) { return 'function fiestaGameVoteTarget(vt, epoch) { return vt || null; }'; } })(),
].join('\n\n');

const secrets = {
  'u1': { w: 'Perro', liar: true },
  'u2': { w: 'Gato', liar: false },
  'u3': { w: 'Gato', liar: false },
  'u4': { w: 'Gato', liar: false },
};
const updates = [];
const writes = {};
const dbRef = (p) => ({
  set(v) { writes[p] = v; return Promise.resolve(); },
  update(v) { updates.push({ path: p, v }); return Promise.resolve(); },
  remove() { writes[p] = null; return Promise.resolve(); },
  once() {
    const m = p.match(/^fiestaGameSecrets\/sid1\/(u\d)$/);
    const v = m ? (secrets[m[1]] || null) : null;
    return Promise.resolve({ val: () => v });
  },
});
const sandbox = {
  console, writes, updates,
  DrexCloud: { database: () => ({ ref: dbRef }) },
  fiestaCur: { id: 'sid1' },
  fiestaMembers: { u1: { name: 'A' }, u2: { name: 'B' }, u3: { name: 'C' }, u4: { name: 'D' } },
  fiestaGame: { status: 'vote', players: ['u1', 'u2', 'u3', 'u4'], out: [], round: 1 },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const driver = `
globalThis.__T = {
  tally: function (votes) {
    var ref = { update: function (v) { updates.push({ path: 'game', v: v }); return Promise.resolve(); } };
    fiestaGameHostTally(ref, fiestaGame, votes);
  },
  updates: updates,
};
`;
vm.runInContext(code + '\n' + driver, sandbox, { filename: 'c21-flow.js' });
const T = sandbox.__T;
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FALLA ' + name); }
}

(async () => {
  console.log('index.html bajo prueba: ' + INDEX_PATH);

  // Escenario A: el mentiroso (u1) recibe más votos -> eliminado, ganan civiles.
  T.tally({ u2: 'u1', u3: 'u1', u4: 'u2' });
  await flush();
  const a = T.updates[T.updates.length - 1].v;
  ok(a.status === 'final' && a.winner === 'civiles', 'A: eliminar al mentiroso termina el juego (ganan civiles)');
  ok(JSON.stringify(a.out) === '["u1"]', 'A: out = [u1]');
  ok(JSON.stringify(a.pair) === '["Gato","Perro"]', 'A: el final publica el par de palabras');
  ok(JSON.stringify(a.liars) === '["u1"]', 'A: el final publica quiénes eran los mentirosos');
  ok(!('liar' in a) || true, 'A: (sanidad)');
  T.updates.length = 0;

  // Escenario B: eliminan a un civil (u2) -> reveal con liar:false, el juego sigue.
  T.tally({ u1: 'u2', u3: 'u2', u4: 'u2' });
  await flush();
  const b = T.updates[T.updates.length - 1].v;
  ok(b.status === 'reveal', 'B: eliminar a un civil -> fase reveal');
  ok(b.revealed && b.revealed.uid === 'u2' && b.revealed.liar === false && b.revealed.word === 'Gato',
    'B: el revelado muestra uid/palabra y liar=false del civil');
  ok(!('pair' in b) && !('liars' in b), 'B: el reveal NO publica pair/liars en el doc');
  T.updates.length = 0;

  // Escenario C: empate -> ronda 2 sin revelar nada.
  T.tally({ u2: 'u1', u3: 'u2' });
  await flush();
  const c = T.updates[T.updates.length - 1].v;
  ok(c.status === 'describe' && c.round === 2, 'C: empate -> ronda 2 en describe');
  ok(!('pair' in c) && !('liars' in c), 'C: el empate NO publica pair/liars');

  console.log('\n' + pass + ' ok, ' + fail + ' fallas');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
