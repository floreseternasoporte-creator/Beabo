// tests/test-c21-liar-game-leak.js
// C21: "Quién es el mentiroso" — la información oculta (mentirosos, palabras,
// votos en vivo) NO debe publicarse en el doc compartido fiestas/<id>/game,
// que TODOS los miembros reciben. Extrae el CODIGO REAL de index.html y lo
// ejecuta en vm con stubs.
// Uso: node tests/test-c21-liar-game-leak.js [ruta/index.html]
// Debe FALLAR en la base (filtración) y PASAR con el fix.
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
  grab('function fiestaGameStartNow()', '\n}'),
  grab('function fiestaGameVote(target)', '\n}'),
  grab('function fiestaGameActivePlayers()', '\n}'),
].join('\n\n');

// ---- sandbox ----
const writes = {};   // path -> valor escrito
const dbRef = (p) => ({
  set(v) { writes[p] = v; return Promise.resolve(); },
  update(v) { writes[p] = Object.assign({}, writes[p], v); return Promise.resolve(); },
  remove() { writes[p] = null; return Promise.resolve(); },
  once() { return Promise.resolve({ val: () => null, forEach: () => {} }); },
});
const sandbox = {
  console,
  writes,
  DrexCloud: { database: () => ({ ref: dbRef }) },
  showMiniToast() {}, fiestaCloseGamesSheet() {},
  fiestaGameStartHostLoop() {},
  fiestaGamePickPair: () => ['Gato', 'Perro'],
  appT: (s) => s,
  fiestaCur: { id: 'sid1' },
  fiestaAmHost: true,
  fiestaMyUid: 'host1',
  fiestaMembers: { host1: { name: 'Host' }, u1: { name: 'A' }, u2: { name: 'B' }, u3: { name: 'C' } },
  fiestaGame: null,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const driver = `
var fiestaGameMySecret = null, fiestaGameHiddenLocal = false, fiestaGameMyVote = null;
var fiestaGameSecretEpoch = null; // C69-F1: preámbulo actualizado (lección C63)
globalThis.__T = {
  startAsHost: function () { fiestaGameStartNow(); },
  gameDoc: function () { return writes['fiestas/sid1/game']; },
  voteAs: function (uid, target) {
    fiestaAmHost = false; fiestaMyUid = uid;
    fiestaGame = { status: 'vote', players: ['host1', 'u1', 'u2', 'u3'], out: [] };
    fiestaGameVote(target);
  },
  writes: writes,
};
`;
vm.runInContext(code + '\n' + driver, sandbox, { filename: 'c21-extracted.js' });
const T = sandbox.__T;

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FALLA ' + name); }
}

console.log('index.html bajo prueba: ' + INDEX_PATH);

// 1) El dueño inicia el juego.
T.startAsHost();
const doc = T.gameDoc();
ok(!!doc, 'se escribió el doc fiestas/sid1/game');
const raw = JSON.stringify(doc || {});
ok(!('liars' in (doc || {})), 'el doc compartido NO publica la lista de mentirosos');
ok(!('pair' in (doc || {})), 'el doc compartido NO publica el par de palabras secretas');
ok(!raw.includes('Perro'), 'la palabra del mentiroso no es legible en el doc compartido');
ok(!('votes' in (doc || {})), 'el doc compartido NO incluye el mapa de votos');

// 2) Un jugador vota: su voto no debe quedar en el doc compartido.
T.voteAs('u1', 'u2');
ok(T.writes['fiestas/sid1/game/votes/u1'] === undefined,
  'el voto NO se escribe en el doc compartido (visible para todos)');
const _v1 = T.writes['fiestaGameSecrets/sid1/votes/u1'];
ok(_v1 && typeof _v1 === 'object' && _v1.t === 'u2' && typeof _v1.e === 'number',
  'el voto se escribe en el subárbol de secretos como {t, e} (C79-F2: con epoch de partida)');

// 3) Los secretos individuales sí se reparten (sanidad: el juego sigue funcionando).
const secKeys = Object.keys(T.writes).filter(k => /^fiestaGameSecrets\/sid1\/u\d$/.test(k));
ok(secKeys.length === 3, 'se repartieron secretos individuales a los 3 jugadores');

console.log('\n' + pass + ' ok, ' + fail + ' fallas');
process.exit(fail ? 1 : 0);
