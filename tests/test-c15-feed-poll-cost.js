'use strict';
/* PERF ciclo 15 (C14-07) — costo del ciclo de polling del feed.
 *
 * Mide con el drex-cloud.js REAL + DynamoDB falso instrumentado (patrón de
 * ciclos anteriores):
 *  - RCU por ciclo del grupo del feed: los 3 oyentes que registra
 *    _subscribeNotesFeed (child_added/changed/removed sobre
 *    communityNotes orderByChild('timestamp').limitToLast(50)) comparten UNA
 *    sola lectura por ciclo de polling (3 s). Un ciclo == un readRefValue ==
 *    un ref.once('value') sobre ese ref.
 *  - Escenarios: frío (fase 1+2), idle (solo fase 1 con válvula H4),
 *    válvula de staleness forzada (fase 2 cada 30 s), activo (post nuevo por
 *    ciclo), y contadores por tarjeta (oyentes 'value' de paginadas).
 *  - Proyección a RCU/hora: 1200 ciclos/hora (cada 3 s).
 *
 * Modelo RCU (el mismo del ciclo 10): lectura de consistencia eventual;
 * por operación (query-página o get): max(0.5, ceil(bytes/4096)*0.5), con
 * bytes = suma de byteLength(sk)+byteLength(v) de los ítems DEVUELTOS
 * (la proyección 'sk' de la fase 1 ya viene aplicada, como en DynamoDB real).
 *
 * Uso:
 *   node tests/test-c15-feed-poll-cost.js [--cloud=<ruta-drex-cloud.js>] [--out=f.json]
 *   node tests/test-c15-feed-poll-cost.js --compare=antes.json,despues.json
 *
 * Resolución de layout: primero ../index.html (+ ../drex-cloud.js, layout
 * del repo), con fallback a ../src/index.html (+ ../src/drex-cloud.js).
 */
const path = require('path');
const fs = require('fs');

function resolveSrcDir() {
  const cands = [path.join(__dirname, '..'), path.join(__dirname, '..', 'src')];
  for (const d of cands) {
    try {
      if (fs.existsSync(path.join(d, 'index.html')) && fs.existsSync(path.join(d, 'drex-cloud.js'))) return d;
    } catch (_) { /* seguir */ }
  }
  throw new Error('no se encontró el dir src (index.html + drex-cloud.js) en ../ ni ../src');
}
const SRC = resolveSrcDir();
const args = process.argv.slice(2);
function argVal(name) {
  const p = args.find(a => a === name || a.indexOf(name + '=') === 0);
  if (!p) return null;
  const i = p.indexOf('=');
  return i === -1 ? true : p.slice(i + 1);
}
const cloudPath = path.resolve(argVal('--cloud') || path.join(SRC, 'drex-cloud.js'));
const { DrexCloud, __internals: I } = require(cloudPath);

// --- DynamoDB falso instrumentado -------------------------------------------
function cmpSk(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

function makeInstrumentedFake() {
  const items = []; // {pk, sk, v}
  const stats = { ops: 0, bytes: 0, rcu: 0 };
  function put(pk, sk, v) { items.push({ pk, sk, v: JSON.stringify(v) }); }
  function setV(pk, sk, v) {
    const it = items.find(x => x.pk === pk && x.sk === sk);
    if (it) it.v = JSON.stringify(v); else put(pk, sk, v);
  }
  function delSk(pk, sk) {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].pk === pk && items[i].sk === sk) items.splice(i, 1);
  }
  function charge(returned, evaluated, projected) {
    let bytesRet = 0, bytesEval = 0;
    returned.forEach(it => {
      bytesRet += Buffer.byteLength(it.sk || '', 'utf8') + Buffer.byteLength(it.v || '', 'utf8');
    });
    (evaluated || returned).forEach(it => {
      bytesEval += Buffer.byteLength(it.sk || '', 'utf8') + Buffer.byteLength(it.v || '', 'utf8');
    });
    // Convención ciclo 10 (comparación antes/después): RCU sobre bytes DEVUELTOS.
    // RCU realista: ProjectionExpression sí reduce (fase 1: bytes devueltos);
    // FilterExpression NO reduce en DynamoDB real (fase 2: bytes EVALUADOS).
    const bytesRcu = projected ? bytesRet : bytesEval;
    stats.ops++;
    stats.bytes += bytesRet;
    stats.bytesEvaluated = (stats.bytesEvaluated || 0) + bytesEval;
    stats.rcu += Math.max(0.5, Math.ceil(bytesRet / 4096) * 0.5);
    stats.rcuRealistic = (stats.rcuRealistic || 0) + Math.max(0.5, Math.ceil(bytesRcu / 4096) * 0.5);
  }
  function runQuery(params) {
    const vals = params.ExpressionAttributeValues || {};
    let arr = items.filter(it => it.pk === vals[':pk']);
    const kc = params.KeyConditionExpression || '';
    if (kc.indexOf('begins_with(sk, :pfx)') !== -1) {
      arr = arr.filter(it => it.sk.indexOf(vals[':pfx']) === 0);
    } else if (kc.indexOf('sk BETWEEN :lo AND :hi') !== -1) {
      arr = arr.filter(it => it.sk >= vals[':lo'] && it.sk <= vals[':hi']);
    } else if (kc.indexOf('sk < :endSk') !== -1) {
      arr = arr.filter(it => it.sk < vals[':endSk']);
    } else if (kc.indexOf('begins_with(sk,') !== -1) {
      throw new Error('KC no soportada: ' + kc);
    }
    if (params.FilterExpression && params.FilterExpression.indexOf('NOT contains(sk, :img)') !== -1) {
      // OJO: en DynamoDB real el FilterExpression se aplica DESPUÉS de leer:
      // no reduce RCU. Se contabilizan los bytes evaluados (pre-filtro).
      var evaluatedPreFilter = arr.slice();
      arr = arr.filter(it => it.sk.indexOf(vals[':img']) === -1);
    }
    arr.sort((a, b) => params.ScanIndexForward === false ? cmpSk(b.sk, a.sk) : cmpSk(a.sk, b.sk));
    if (params.ExclusiveStartKey) {
      const esk = params.ExclusiveStartKey.sk;
      const idx = arr.findIndex(it => it.sk === esk);
      arr = idx >= 0 ? arr.slice(idx + 1) : [];
    }
    let lek = null;
    if (params.Limit && arr.length > params.Limit) {
      const page = arr.slice(0, params.Limit);
      lek = { pk: page[page.length - 1].pk, sk: page[page.length - 1].sk };
      arr = page;
    }
    const proj = params.ProjectionExpression === 'sk';
    const out = arr.map(it => (proj ? { sk: it.sk } : { pk: it.pk, sk: it.sk, v: it.v }));
    charge(out, typeof evaluatedPreFilter !== 'undefined' ? evaluatedPreFilter : null, proj);
    const res = { Items: out };
    if (lek) res.LastEvaluatedKey = lek;
    return res;
  }
  const dc = {
    query(params) { return { promise() { return Promise.resolve(runQuery(params)); } }; },
    get(params) {
      return {
        promise() {
          const it = items.find(x => x.pk === params.Key.pk && x.sk === params.Key.sk);
          const out = it ? [{ pk: it.pk, sk: it.sk, v: it.v }] : [];
          charge(out);
          return Promise.resolve({ Item: it ? { pk: it.pk, sk: it.sk, v: it.v } : undefined });
        }
      };
    },
    _put: put, _setV: setV, _delSk: delSk,
    _stats: stats,
    _reset() { stats.ops = 0; stats.bytes = 0; stats.bytesEvaluated = 0; stats.rcu = 0; stats.rcuRealistic = 0; }
  };
  return dc;
}

// --- Fixture: communityNotes realista ----------------------------------------
const BASE_TS = 1750000000000;
const N_POSTS = 600;
function pushKey(i) { return I.pushIdLowerBound(BASE_TS + i * 1000); }

function seedFeed(put) {
  for (let i = 0; i < N_POSTS; i++) {
    const pid = pushKey(i), ts = BASE_TS + i * 1000;
    put('communityNotes', pid + '/text', 'post numero ' + i + ' con algo de texto para simular tamano real');
    put('communityNotes', pid + '/authorId', 'u' + (i % 37));
    put('communityNotes', pid + '/authorName', 'Autor Numero ' + (i % 37));
    put('communityNotes', pid + '/timestamp', ts);
    put('communityNotes', pid + '/upvotes', i % 91);
    put('communityNotes', pid + '/downvotes', i % 7);
    put('communityNotes', pid + '/commentsCount', i % 13);
    put('communityNotes', pid + '/postType', 'text');
    if (i % 3 === 0) { put('communityNotes', pid + '/imageCount', 2); put('communityNotes', pid + '/imageUrls/0', 'https://img/x' + i); put('communityNotes', pid + '/imageUrls/1', 'https://img/y' + i); }
    if (i % 5 === 0) put('communityNotes', pid + '/poll', { q: 'pregunta ' + i, options: [{ t: 'a', v: 3 }, { t: 'b', v: 5 }] });
  }
}
function addPost(put, i) {
  const pid = pushKey(i), ts = BASE_TS + i * 1000;
  put('communityNotes', pid + '/text', 'post nuevo ' + i);
  put('communityNotes', pid + '/authorId', 'u9');
  put('communityNotes', pid + '/timestamp', ts);
  put('communityNotes', pid + '/upvotes', 0);
  return pid;
}

// --- Medición ------------------------------------------------------------------
const fake = makeInstrumentedFake();
seedFeed(fake._put);
I.setDocClient(fake);
const db = () => DrexCloud.database();
const FEED_Q_DESC = "communityNotes orderByChild('timestamp').limitToLast(50)";
const feedRef = () => db().ref('communityNotes').orderByChild('timestamp').limitToLast(50);

async function feedCycle() {
  fake._reset();
  await feedRef().once('value');
  const s = fake._stats;
  return {
    ops: s.ops, bytes: s.bytes,
    rcu: Math.round(s.rcu * 100) / 100,
    rcuRealistic: Math.round(s.rcuRealistic * 100) / 100,
  };
}
const mean = a => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const r2 = x => Math.round(x * 100) / 100;

const realNow = Date.now;
function withShiftedClock(ms, fn) {
  Date.now = () => realNow() + ms;
  return Promise.resolve().then(fn).then(
    v => { Date.now = realNow; return v; },
    e => { Date.now = realNow; throw e; }
  );
}

async function main() {
  const results = { cloud: cloudPath, feedQuery: FEED_Q_DESC, scenarios: {} };

  // 1. FRÍO: primer ciclo sin caché (fase 1 + fase 2)
  const cold = await feedCycle();
  results.scenarios.cold = { desc: 'primer ciclo: fase 1 (sk) + fase 2 (hojas)', perCycle: [cold] };

  // 2. IDLE: suscribir los 3 oyentes reales del feed y medir 12 ciclos.
  //    (El H4 ya está caliente por el ciclo frío: solo fase 1 por ciclo.)
  const events = [];
  const offs = [
    feedRef().on('child_added', s => events.push(['added', s.key])),
    feedRef().on('child_changed', s => events.push(['changed', s.key])),
    feedRef().on('child_removed', s => events.push(['removed', s.key])),
  ];
  await new Promise(res => setTimeout(res, 50)); // deja asentar lecturas iniciales
  const idleCycles = [];
  for (let c = 0; c < 12; c++) idleCycles.push(await feedCycle());
  results.scenarios.idle = {
    desc: '12 ciclos sin cambios (válvula H4 caliente): solo fase 1',
    perCycleRcu: idleCycles.map(c => c.rcu),
    meanRcu: r2(mean(idleCycles.map(c => c.rcu))),
    meanRcuRealistic: r2(mean(idleCycles.map(c => c.rcuRealistic))),
    meanOps: r2(mean(idleCycles.map(c => c.ops))),
    meanBytes: Math.round(mean(idleCycles.map(c => c.bytes))),
  };

  // 3. VÁLVULA: +31 s de reloj -> la válvula de staleness fuerza fase 2
  const valve = await withShiftedClock(31000, () => feedCycle());
  results.scenarios.valve = {
    desc: 'ciclo con válvula de staleness vencida (30 s): fase 1 + fase 2',
    perCycle: [valve],
  };
  // y el ciclo siguiente vuelve a ser solo fase 1
  const afterValve = await feedCycle();
  results.scenarios.afterValve = { desc: 'ciclo tras la válvula: vuelve a solo fase 1', perCycle: [afterValve] };

  // 4. ACTIVO: un post nuevo antes de cada ciclo -> fase 2 en cada ciclo
  const activeCycles = [];
  for (let c = 0; c < 6; c++) {
    addPost(fake._put, N_POSTS + c);
    activeCycles.push(await feedCycle());
  }
  results.scenarios.active = {
    desc: '6 ciclos con 1 post nuevo antes de cada uno: fase 1 + fase 2 siempre',
    perCycleRcu: activeCycles.map(c => c.rcu),
    meanRcu: r2(mean(activeCycles.map(c => c.rcu))),
    meanRcuRealistic: r2(mean(activeCycles.map(c => c.rcuRealistic))),
    meanOps: r2(mean(activeCycles.map(c => c.ops))),
    meanBytes: Math.round(mean(activeCycles.map(c => c.bytes))),
  };

  // 5. CONTADORES POR TARJETA: 3 on('value') por tarjeta paginada visible
  const cardPid = pushKey(N_POSTS - 60);
  const cardRefs = ['upvotes', 'downvotes', 'commentsCount'].map(f => db().ref('communityNotes/' + cardPid + '/' + f));
  const cardOffs = cardRefs.map(r => r.on('value', () => {}));
  await new Promise(res => setTimeout(res, 50));
  const cardCycles = [];
  for (let c = 0; c < 4; c++) {
    fake._reset();
    for (const r of cardRefs) await r.once('value'); // 3 grupos (1 por campo)
    cardCycles.push({ ops: fake._stats.ops, rcu: r2(fake._stats.rcu) });
  }
  cardOffs.forEach(off => off());
  results.scenarios.cardCounters = {
    desc: '1 tarjeta paginada visible: 3 lecturas puntuales por ciclo (up/down/comments)',
    perCycleRcu: cardCycles.map(c => c.rcu),
    meanRcu: r2(mean(cardCycles.map(c => c.rcu))),
  };

  offs.forEach(off => off());
  I.resetListeners();

  // Proyección horaria (ciclo de 3 s -> 1200 ciclos/hora; válvula cada 30 s -> 120/hora)
  const q = results.scenarios.idle.meanRcu, v = results.scenarios.valve.perCycle[0].rcu;
  const qr = results.scenarios.idle.meanRcuRealistic, vr = results.scenarios.valve.perCycle[0].rcuRealistic;
  const ar = results.scenarios.active.meanRcuRealistic;
  results.projection = {
    cyclesPerHour: 1200,
    valveCyclesPerHour: 120,
    idleRcuPerHour: Math.round(1080 * q + 120 * v),
    idleRcuPerHourPhase1Only: Math.round(1200 * q),
    activeRcuPerHour: Math.round(1200 * results.scenarios.active.meanRcu),
    cardCountersRcuPerHourPerCard: Math.round(1200 * results.scenarios.cardCounters.meanRcu),
    // Realista (fase 2 sobre bytes evaluados: el FilterExpression no ahorra
    // RCU en DynamoDB real; con fotos inline de ~300KB la fase 2 real es
    // mucho más cara que la convención de bytes devueltos).
    idleRcuRealisticPerHour: Math.round(1080 * qr + 120 * vr),
    activeRcuRealisticPerHour: Math.round(1200 * ar),
  };

  const out = argVal('--out');
  if (out) {
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log('escrito ' + out);
  }
  console.log('=== feed poll cost [' + path.basename(cloudPath) + '] ===');
  console.log('frio (fase1+2):      ' + cold.rcu + ' RCU (' + cold.rcuRealistic + ' realista), ' + cold.ops + ' ops, ' + cold.bytes + ' bytes');
  console.log('idle (solo fase 1):  ' + results.scenarios.idle.meanRcu + ' RCU/ciclo (' + results.scenarios.idle.meanRcuRealistic + ' realista; ' + results.scenarios.idle.meanOps + ' ops, ' + results.scenarios.idle.meanBytes + ' bytes)');
  console.log('valvula 30s (f1+f2): ' + v + ' RCU (' + vr + ' realista)');
  console.log('tras valvula:        ' + afterValve.rcu + ' RCU (vuelve a fase 1)');
  console.log('activo (post/ciclo): ' + results.scenarios.active.meanRcu + ' RCU/ciclo (' + results.scenarios.active.meanRcuRealistic + ' realista)');
  console.log('contadores/tarjeta:  ' + results.scenarios.cardCounters.meanRcu + ' RCU/ciclo por tarjeta visible');
  console.log('--- proyeccion/hora/usuario (peor caso, 1200 ciclos) ---');
  console.log('idle total:          ' + results.projection.idleRcuPerHour + ' RCU/h  (=1080x' + q + ' + 120x' + v + ')');
  console.log('idle realista:       ' + results.projection.idleRcuRealisticPerHour + ' RCU/h');
  console.log('activo total:        ' + results.projection.activeRcuPerHour + ' RCU/h');
  console.log('activo realista:     ' + results.projection.activeRcuRealisticPerHour + ' RCU/h');
  console.log('contadores/tarjeta:  ' + results.projection.cardCountersRcuPerHourPerCard + ' RCU/h por tarjeta paginada visible');
  return results;
}

// --- Modo compare -------------------------------------------------------------
function compare(aPath, bPath) {
  const a = JSON.parse(fs.readFileSync(aPath, 'utf8'));
  const b = JSON.parse(fs.readFileSync(bPath, 'utf8'));
  const rows = [
    ['frio RCU', a.scenarios.cold.perCycle[0].rcu, b.scenarios.cold.perCycle[0].rcu],
    ['frio RCU realista', a.scenarios.cold.perCycle[0].rcuRealistic, b.scenarios.cold.perCycle[0].rcuRealistic],
    ['frio ops', a.scenarios.cold.perCycle[0].ops, b.scenarios.cold.perCycle[0].ops],
    ['idle RCU/ciclo', a.scenarios.idle.meanRcu, b.scenarios.idle.meanRcu],
    ['valvula RCU', a.scenarios.valve.perCycle[0].rcu, b.scenarios.valve.perCycle[0].rcu],
    ['valvula RCU realista', a.scenarios.valve.perCycle[0].rcuRealistic, b.scenarios.valve.perCycle[0].rcuRealistic],
    ['valvula ops', a.scenarios.valve.perCycle[0].ops, b.scenarios.valve.perCycle[0].ops],
    ['activo RCU/ciclo', a.scenarios.active.meanRcu, b.scenarios.active.meanRcu],
    ['activo RCU realista', a.scenarios.active.meanRcuRealistic, b.scenarios.active.meanRcuRealistic],
    ['idle RCU/hora', a.projection.idleRcuPerHour, b.projection.idleRcuPerHour],
    ['idle realista/hora', a.projection.idleRcuRealisticPerHour, b.projection.idleRcuRealisticPerHour],
    ['activo RCU/hora', a.projection.activeRcuPerHour, b.projection.activeRcuPerHour],
  ];
  console.log('=== compare: ' + path.basename(aPath) + '  vs  ' + path.basename(bPath) + ' ===');
  // Expectativas: la fase 1 no se toca (idle idéntico); la fase 2 debe bajar
  // o quedar igual (nunca subir). La equivalencia de contenido la verifica
  // test-c15-feed-poll-equivalence.js (hojas byte-idénticas).
  const expect = {
    'frio RCU': 'down', 'frio RCU realista': 'down', 'frio ops': 'down',
    'idle RCU/ciclo': 'same',
    'valvula RCU': 'down', 'valvula RCU realista': 'down', 'valvula ops': 'down',
    'activo RCU/ciclo': 'down', 'activo RCU realista': 'down',
    'idle RCU/hora': 'down', 'idle realista/hora': 'down', 'activo RCU/hora': 'down',
  };
  let ok = true;
  rows.forEach(([name, x, y]) => {
    const d = Math.round((y - x) * 100) / 100, pct = x ? (100 * d / x).toFixed(1) + '%' : 'n/a';
    const e = expect[name] || 'down';
    let flag = '';
    if (e === 'same' && d !== 0) { flag = '  <-- DIFIERE (debería ser idéntico)'; ok = false; }
    if (e === 'down' && d > 0) { flag = '  <-- SUBIÓ (no debería)'; ok = false; }
    console.log(name.padEnd(20) + String(x).padStart(10) + '  ->  ' + String(y).padStart(10) + '   (' + (d >= 0 ? '+' : '') + d + ', ' + pct + ')' + flag);
  });
  console.log(ok ? 'OK: expectativas cumplidas' : 'FALLO: revisar diferencias marcadas');
  process.exit(ok ? 0 : 1);
}

const cmp = argVal('--compare');
if (cmp) compare(cmp.split(',')[0], cmp.split(',')[1]);
else main().then(() => process.exit(0)).catch(e => { console.error('FALLO:', e); process.exit(1); });
