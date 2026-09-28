// C229: Fiestas / "Quién es el mentiroso".
//   F1: fiestaGameStartNow publicaba el doc del juego ANTES de confirmar los
//       secretos -> un invitado podía leer su secreto antes de que existiera.
//       Ahora: Promise.all(secretos) -> publicar; doble tap no duplica.
//   F2: la lectura del secreto no se reintentaba si llegaba vacía.
//       Ahora: fiestaGameFetchSecret con backoff acotado + guarda de epoch.
//   F3: si el hablante salía a mitad de su turno, hasta 30 s de aire muerto.
//       Ahora: el host loop avanza el turno de inmediato.
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const HTML_PATH = process.env.DREX_HTML || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const START = 'var FIESTA_GAME_WORDS_FALLBACK = [';
const END = '/* ===== FIESTA-JUEGOS-FIN ===== */';
const si = html.indexOf(START), ei = html.indexOf(END);
assert(si !== -1 && ei !== -1 && ei > si, 'bloque FIESTA-JUEGOS no encontrado en ' + HTML_PATH);
const src = html.slice(si, ei);

function deferred() {
  let res, rej;
  const p = new Promise((a, b) => { res = a; rej = b; });
  return { p, res, rej };
}
const flushMacrotask = () => new Promise(r => setImmediate(r));

function makeSandbox(opts) {
  opts = opts || {};
  const timers = [];
  const toasts = [];
  return {
    sb: {
      window: {},
      console,
      fiestaCur: { id: 's1' },
      fiestaMembers: opts.members || {},
      fiestaMyUid: 'u1',
      fiestaAmHost: true,
      DrexCloud: { database: () => opts.db },
      appT: (s) => s,
      showMiniToast: (m) => { toasts.push(String(m)); },
      fiestaCloseGamesSheet: () => {},
      fiestaGameStartHostLoop: () => {},
      document: {
        getElementById: () => ({
          classList: { add() {}, remove() {}, toggle() {} },
          textContent: '', innerHTML: '', value: '', placeholder: '',
        }),
      },
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
    },
    timers,
    toasts,
  };
}
function boot(opts) {
  const { sb, timers, toasts } = makeSandbox(opts);
  vm.runInNewContext(src, sb);
  return { sb, timers, toasts };
}

let passed = 0;
function ok(name, cond) {
  assert(cond, 'FALLO: ' + name);
  passed++;
  console.log('  ok - ' + name);
}

(async () => {
  console.log('== F1: el doc del juego se publica solo tras confirmar TODOS los secretos ==');
  {
    const events = [];
    const secrets = [];
    const db = {
      ref(p) {
        return {
          set(v) {
            if (p === 'fiestas/s1/game') { events.push('game:set'); return Promise.resolve(); }
            const d = deferred();
            secrets.push({ p, d, v });
            events.push('secret:queued');
            return d.p;
          },
          remove() { return Promise.resolve(); },
          update(u) { events.push('game:update'); return Promise.resolve(); },
          once() { return Promise.resolve({ val: () => null }); },
        };
      },
    };
    const members = { u1: {}, u2: {}, u3: {}, u4: {}, u5: {} };
    const { sb } = boot({ db, members });
    sb.fiestaGameStartNow();
    ok('game:set NO se publica en sincrónico (antes de confirmar secretos)',
      !events.includes('game:set'));
    assert.strictEqual(secrets.length, 5, 'se encolan 5 secretos');
    passed++; console.log('  ok - se encolan 5 escrituras de secreto');
    secrets.forEach(s => s.d.res());
    await flushMacrotask(); await flushMacrotask();
    ok('game:set se publica tras confirmar los 5 secretos', events.includes('game:set'));
    ok('el guarda fiestaGameStarting se libera', sb.fiestaGameStarting === false);
    // roles: 5 jugadores -> 1 mentiroso
    const liars = secrets.filter(s => s.v.liar);
    assert.strictEqual(liars.length, 1, 'exactamente 1 mentiroso con 5 jugadores');
    passed++; console.log('  ok - exactamente 1 mentiroso con 5 jugadores');
  }

  console.log('== F1: si un secreto falla, NO se publica nada y se avisa ==');
  {
    const events = [];
    const secrets = [];
    const db = {
      ref(p) {
        return {
          set(v) {
            if (p === 'fiestas/s1/game') { events.push('game:set'); return Promise.resolve(); }
            const d = deferred();
            secrets.push({ p, d });
            return d.p;
          },
          remove() { return Promise.resolve(); },
          update() { return Promise.resolve(); },
          once() { return Promise.resolve({ val: () => null }); },
        };
      },
    };
    const { sb, toasts } = boot({ db, members: { u1: {}, u2: {}, u3: {}, u4: {} } });
    sb.fiestaGameStartNow();
    secrets.forEach((s, i) => { if (i === 2) s.d.rej(new Error('net')); else s.d.res(); });
    await flushMacrotask(); await flushMacrotask();
    ok('game:set NO se publica si un secreto falla', !events.includes('game:set'));
    ok('se avisa al dueño', toasts.some(t => t.indexOf('conexi') !== -1));
    ok('el guarda se libera tras el fallo', sb.fiestaGameStarting === false);
  }

  console.log('== F1: doble tap en "Jugar" no publica dos partidas ==');
  {
    const events = [];
    const secrets = [];
    const db = {
      ref(p) {
        return {
          set(v) {
            if (p === 'fiestas/s1/game') { events.push('game:set'); return Promise.resolve(); }
            const d = deferred(); secrets.push({ p, d }); return d.p;
          },
          remove() { return Promise.resolve(); },
          update() { return Promise.resolve(); },
          once() { return Promise.resolve({ val: () => null }); },
        };
      },
    };
    const { sb } = boot({ db, members: { u1: {}, u2: {}, u3: {}, u4: {} } });
    sb.fiestaGameStartNow();
    sb.fiestaGameStartNow(); // segundo tap inmediato
    assert.strictEqual(secrets.length, 4, 'el segundo inicio no re-encola secretos');
    passed++; console.log('  ok - el segundo inicio no re-encola secretos');
    secrets.forEach(s => s.d.res());
    await flushMacrotask(); await flushMacrotask();
    const n = events.filter(e => e === 'game:set').length;
    assert.strictEqual(n, 1, 'una sola publicación del doc (n=' + n + ')');
    passed++; console.log('  ok - una sola publicación del doc del juego');
  }

  console.log('== F2: reintento con backoff si el secreto llega vacío ==');
  {
    const reads = [];
    const queue = [null, null, { w: 'Gato', liar: false }];
    const db = {
      ref(p) {
        return {
          once() { reads.push(p); const v = queue.shift(); return Promise.resolve({ val: () => v }); },
          set() { return Promise.resolve(); },
          update() {}, remove() {},
        };
      },
    };
    const { sb, timers } = boot({ db });
    let renders = 0;
    sb.fiestaGameRender = () => { renders++; };
    sb.fiestaGame = { status: 'describe', players: ['u1', 'u2', 'u3', 'u4'], startedAt: 111 };
    sb.fiestaGameSecretEpoch = 111;
    sb.fiestaGameMySecret = null;
    sb.fiestaGameSecretFetching = false;
    sb.fiestaGameFetchSecret('s1', 'u1', 111, 0);
    await flushMacrotask();
    assert.strictEqual(reads.length, 1);
    ok('tras lectura vacía se programa reintento', timers.length === 1);
    timers.shift()(); // intento 1 -> null
    await flushMacrotask();
    ok('segundo reintento programado', timers.length === 1);
    timers.shift()(); // intento 2 -> valor
    await flushMacrotask();
    ok('el secreto se guarda', !!(sb.fiestaGameMySecret && sb.fiestaGameMySecret.w === 'Gato'));
    ok('se re-renderiza al recibirlo', renders >= 1);
    ok('sin más reintentos tras el éxito', timers.length === 0);
  }

  console.log('== F2: un reintento tardío no pisa la partida nueva (epoch) ==');
  {
    const db = {
      ref() {
        return {
          once() { return Promise.resolve({ val: () => null }); },
          set() { return Promise.resolve(); }, update() {}, remove() {},
        };
      },
    };
    const { sb, timers } = boot({ db });
    let renders = 0;
    sb.fiestaGameRender = () => { renders++; };
    sb.fiestaGame = { status: 'describe', players: ['u1', 'u2'], startedAt: 111 };
    sb.fiestaGameSecretEpoch = 111;
    sb.fiestaGameMySecret = null;
    sb.fiestaGameSecretFetching = false;
    sb.fiestaGameFetchSecret('s1', 'u1', 111, 0);
    await flushMacrotask();
    assert.strictEqual(timers.length, 1);
    passed++; console.log('  ok - reintento programado');
    sb.fiestaGameSecretEpoch = 222; // el dueño pulsó "Jugar de nuevo"
    timers.shift()();
    await flushMacrotask();
    ok('el reintento viejo se aborta', timers.length === 0);
    ok('no se pisa nada de la partida nueva', sb.fiestaGameMySecret === null && renders === 0);
  }

  console.log('== F3: el turno avanza de inmediato si el hablante salió ==');
  {
    const updates = [];
    const db = {
      ref() {
        return {
          update(u) { updates.push(u); return undefined; },
          set() { return Promise.resolve(); }, remove() {},
          once() { return Promise.resolve({ val: () => null }); },
        };
      },
    };
    const { sb } = boot({ db, members: { u2: { name: 'B' }, u3: { name: 'C' } } }); // u1 salió
    sb.fiestaAmHost = true;
    sb.fiestaGame = {
      status: 'describe', turnIndex: 0, turnEndsAt: Date.now() + 25000,
      players: ['u1', 'u2', 'u3'], out: [], startedAt: 1,
    };
    sb.fiestaGameHostTick();
    ok('el turno salta al siguiente sin esperar el timer', updates.length === 1);
    assert.strictEqual(updates[0].turnIndex, 1, 'turnIndex avanza a 1');
    passed++; console.log('  ok - turnIndex avanza a 1');
  }

  console.log('== F3 (control): con hablante presente no se adelanta ==');
  {
    const updates = [];
    const db = {
      ref() {
        return {
          update(u) { updates.push(u); return undefined; },
          set() { return Promise.resolve(); }, remove() {},
          once() { return Promise.resolve({ val: () => null }); },
        };
      },
    };
    const { sb } = boot({ db, members: { u1: { name: 'A' }, u2: { name: 'B' }, u3: { name: 'C' } } });
    sb.fiestaAmHost = true;
    sb.fiestaGame = {
      status: 'describe', turnIndex: 0, turnEndsAt: Date.now() + 25000,
      players: ['u1', 'u2', 'u3'], out: [], startedAt: 1,
    };
    sb.fiestaGameHostTick();
    ok('sin avance prematuro cuando el hablante sigue en la sala', updates.length === 0);
  }

  console.log('\nC229: ' + passed + ' checks verdes');
})().catch(e => { console.error(e); process.exit(1); });
