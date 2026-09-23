'use strict';
/* DELTA-SYNC 2026-09-23 (ciclo 12) — harness de equivalencia de callbacks
 * para la migración de fiestaReactions/<id> de on('child_added') a onDelta.
 *
 * Patrón reusado de tests/test-ondelta-overlap.js y
 * tests/test-c11-bounded-prefix-window.js (docClient falso + internals de
 * drex-cloud.js). (Nota: tests/test-c11-fiesta-chat-ondelta.js no existe en
 * el repo; no se pudo reusar.)
 *
 * A diferencia de copiar el callback a mano, este harness EXTRAE el código
 * real del index.html:
 *   - versión VIEJA: git show cd12a873:index.html  (on('child_added', ...))
 *   - versión NUEVA: index.html (raiz del repo)    (onDelta(...))
 * y lo evalúa contra el PIPELINE REAL de drex-cloud.js (Ref.on / onDelta /
 * fireListener / dispatchSnapshot / pollGroup con delta) con un DynamoDB
 * falso. Así se prueba el código desplegado, no una copia.
 *
 * Escenario (fiesta 'fiestaX', 35 reacciones sembradas):
 *  1. VIEJA: registro con on('child_added') -> secuencia inicial S_old.
 *     Teardown con r.off() (lo que hace fiestaFullCleanup): se siembra una
 *     reacción nueva y se verifica que NO dispara (oyente dado de baja).
 *  2. NUEVA: registro con onDelta -> secuencia inicial S_new.
 *     CHECK: S_new === S_old (mismo orden, mismos filtros: 20s, allowlist,
 *     propias).
 *  3. Se siembran 5 reacciones nuevas y se deja correr UN ciclo de polling:
 *     CHECK: disparan exactamente las 5 nuevas, en orden de clave, SIN
 *     re-disparar la línea base (dedup del delta).
 *  4. remove() del nodo completo + re-push de 2 reacciones (como hacen
 *     leaveFiesta/endFiesta/cascadeDeleteNote): CHECK que las 2 nuevas
 *     disparan (las claves push nuevas son > watermark).
 *  5. Coste: el ciclo delta lee solo las hojas nuevas (<< re-lectura
 *     completa); se reportan los conteos de items leídos.
 *  6. Teardown del oyente delta con off('child_added') (forma documentada
 *     en drex-cloud.js): también silencia.
 *
 * Ejecutar con: node tests/test-c12-fiesta-reactions-ondelta.js
 */
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'index.html');
const { DrexCloud, __internals: I } = require(path.join(ROOT, 'drex-cloud.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(cond, timeoutMs, stepMs) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(stepMs || 100);
  }
}

// --- DynamoDB falso (misma lógica que test-c11-bounded-prefix-window.js) ---
const items = []; // {pk, sk, v}
const stats = { fullItems: 0, deltaItems: 0, deltaQueries: 0, deltaQuerySizes: [], phase1Queries: 0, betweenLos: [] };
function cmpSk(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
function runQuery(params) {
  const vals = params.ExpressionAttributeValues || {};
  let arr = items.filter(it => it.pk === vals[':pk']);
  const kc = params.KeyConditionExpression || '';
  const isDelta = kc.indexOf('sk BETWEEN :lo AND :hi') >= 0;
  if (kc.indexOf('begins_with(sk, :pfx)') >= 0 && kc.indexOf('sk < :endBound') >= 0) {
    arr = arr.filter(it => it.sk.indexOf(vals[':pfx']) === 0 && it.sk < vals[':endBound']);
  } else if (kc.indexOf('begins_with(sk, :pfx)') >= 0) {
    arr = arr.filter(it => it.sk.indexOf(vals[':pfx']) === 0);
  } else if (isDelta) {
    arr = arr.filter(it => it.sk >= vals[':lo'] && it.sk <= vals[':hi']);
  } else throw new Error('KC no soportada en el test: ' + kc);
  arr.sort((a, b) => params.ScanIndexForward === false ? cmpSk(b.sk, a.sk) : cmpSk(a.sk, b.sk));
  if (params.ExclusiveStartKey) {
    const ix = arr.findIndex(it => it.sk === params.ExclusiveStartKey.sk);
    arr = ix >= 0 ? arr.slice(ix + 1) : [];
  }
  let lek = null;
  if (params.Limit && arr.length > params.Limit) {
    const pg = arr.slice(0, params.Limit);
    lek = { pk: pg[pg.length - 1].pk, sk: pg[pg.length - 1].sk };
    arr = pg;
  }
  const out = arr.map(it => (params.ProjectionExpression === 'sk' ? { sk: it.sk } : { pk: it.pk, sk: it.sk, v: it.v }));
  const isPhase1 = kc.indexOf('begins_with(sk, :pfx)') >= 0 && params.ProjectionExpression === 'sk';
  if (isDelta) {
    stats.deltaItems += out.length; stats.deltaQueries++;
    stats.deltaQuerySizes.push(out.length);
    // :lo distingue la fase 2 acotada (prefix+minChild) del delta real
    // (prefix+deltaFromSk(watermark)): se guarda para clasificar.
    stats.betweenLos.push(String(vals[':lo']));
  } else {
    stats.fullItems += out.length;
    if (isPhase1) stats.phase1Queries++;
  }
  const res = { Items: out };
  if (lek) res.LastEvaluatedKey = lek;
  return Promise.resolve(res);
}
I.setDocClient({
  query(params) { return { promise() { return runQuery(params); } }; },
  get() { return { promise() { return Promise.resolve({ Item: null }); } }; },
});

// --- Siembra de reacciones (modelo real: fiestaReactions/<id>/<pushId>/{e,from,at}) ---
const FIESTA = 'fiestaX';
const MYUID = 'yo-mismo';
function seedReaction(key, e, from, at) {
  [['e', e], ['from', from], ['at', at]].forEach(([f, v]) =>
    items.push({ pk: 'fiestaReactions', sk: FIESTA + '/' + key + '/' + f, v: JSON.stringify(v) }));
}
function clearReactions() {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].pk === 'fiestaReactions') items.splice(i, 1);
}

// --- Extracción del código REAL del index.html ---
function extractRegistration(html) {
  const m = html.match(/fiestaRefs\.reactions = DrexCloud\.database\(\)\.ref\('fiestaReactions\/' \+ id\)\.limitToLast\(30\);\n[\s\S]*?\n  \}\);/);
  if (!m) throw new Error('no se encontro el bloque fiestaRefs.reactions');
  return m[0];
}
function extractAllowlist(html) {
  const m = html.match(/var FIESTA_ALLOWED_REACTIONS = [^;]+;/);
  if (!m) throw new Error('no se encontro FIESTA_ALLOWED_REACTIONS');
  return m[0] + "\nfunction fiestaIsAllowedReaction(e) { return FIESTA_ALLOWED_REACTIONS.indexOf(e) !== -1; }";
}
const oldHtml = cp.execSync('git -C ' + ROOT + ' show cd12a873:index.html', { maxBuffer: 16 * 1024 * 1024 }).toString('utf8');
const newHtml = fs.readFileSync(SRC, 'utf8');
const OLD_CODE = extractRegistration(oldHtml);
const NEW_CODE = extractRegistration(newHtml);
if (!/\.on\('child_added'/.test(OLD_CODE)) throw new Error('el codigo viejo no usa on(child_added)');
if (!/\.onDelta\(/.test(NEW_CODE)) throw new Error('el codigo nuevo no usa onDelta');

function makeCtx(shown) {
  const allowSrc = extractAllowlist(newHtml);
  const allowFn = new Function(allowSrc + '\nreturn { list: FIESTA_ALLOWED_REACTIONS, fn: fiestaIsAllowedReaction };')();
  return {
    fiestaRefs: {},
    id: FIESTA,
    DrexCloud,
    fiestaMyUid: MYUID,
    fiestaIsAllowedReaction: allowFn.fn,
    fiestaShowReaction: e => shown.push(e),
    allowed: allowFn.list,
  };
}
function runRegistration(code, ctx) {
  const fn = new Function('fiestaRefs', 'id', 'DrexCloud', 'fiestaMyUid',
    'fiestaIsAllowedReaction', 'fiestaShowReaction', code);
  fn(ctx.fiestaRefs, ctx.id, ctx.DrexCloud, ctx.fiestaMyUid,
    ctx.fiestaIsAllowedReaction, ctx.fiestaShowReaction);
}

async function main() {
  const ctx0 = makeCtx([]);
  const ALLOWED = ctx0.allowed;
  const DISALLOWED = '🚀';
  if (ALLOWED.indexOf(DISALLOWED) !== -1) throw new Error('emoji de prueba colisiona con la allowlist');

  const NOW = Date.now();
  const BASE = NOW - 40000; // hace 40s (las #0..#9 quedan "viejas" por el filtro de 20s)
  const keyOf = i => I.pushIdLowerBound(BASE + i * 1000);
  const keys = [];
  for (let i = 0; i < 35; i++) {
    const k = keyOf(i); keys.push(k);
    const fresh = i >= 10;
    const at = fresh ? NOW - 1000 : NOW - 60000;
    let e = ALLOWED[i % ALLOWED.length], from = 'peer1';
    if (i >= 20 && i < 25) { from = MYUID; }              // propias: se omiten
    else if (i >= 25 && i < 30) { e = DISALLOWED; from = 'peer3'; } // fuera de allowlist: se omiten
    else if (fresh && i % 2 === 0) from = 'peer2';
    seedReaction(k, e, from, at);
  }
  // Esperado en la lectura inicial: #10..#19 y #30..#34 (15), en orden de clave
  const expectedInitial = [];
  for (let i = 10; i < 35; i++) {
    if (i >= 20 && i < 30) continue;
    expectedInitial.push(ALLOWED[i % ALLOWED.length]);
  }

  // FASE 1 — código VIEJO (on('child_added'))
  let shown = [];
  let ctx = makeCtx(shown);
  runRegistration(OLD_CODE, ctx);
  check('viejo: registro con on(child_added) no lanza', true);
  await waitFor(() => shown.length >= expectedInitial.length, 5000);
  check('viejo: lectura inicial dispara las 15 esperadas', shown.length === expectedInitial.length,
    shown.length + ' disparos');
  check('viejo: orden y filtros identicos al esperado',
    JSON.stringify(shown) === JSON.stringify(expectedInitial));
  // Teardown como fiestaFullCleanup: r.off() sin argumentos
  ctx.fiestaRefs.reactions.off();
  const nBefore = shown.length;
  seedReaction(I.pushIdLowerBound(NOW + 5000), ALLOWED[0], 'peer9', NOW);
  await sleep(4200); // > 1 ciclo de polling normal (3s)
  check('viejo: tras r.off() no dispara (teardown funciona)', shown.length === nBefore,
    shown.length - nBefore + ' disparos extra');

  // FASE 2 — código NUEVO (onDelta). OJO: el callback cierra sobre el array
  // que se pasa a makeCtx; no reasignar después (usar índices/slices).
  const firedNew = [];
  ctx = makeCtx(firedNew);
  stats.fullItems = 0; stats.deltaItems = 0; stats.deltaQueries = 0; stats.deltaQuerySizes = [];
  runRegistration(NEW_CODE, ctx);
  check('nuevo: registro con onDelta no lanza', true);
  await waitFor(() => firedNew.length >= expectedInitial.length + 1, 5000);
  // (+1 por la reaccion sembrada en la fase 1, que es nueva para este oyente)
  check('nuevo: lectura inicial completa (36: baseline 35 + 1 nueva)',
    firedNew.length === expectedInitial.length + 1, firedNew.length + ' disparos');
  const seqNew = firedNew.slice(0, expectedInitial.length);
  check('nuevo: secuencia inicial IDENTICA a la del codigo viejo',
    JSON.stringify(seqNew) === JSON.stringify(expectedInitial));
  const fullReadCost = stats.fullItems; // coste de la lectura inicial (fase 1+2 acotada)

  // El primer ciclo de polling tras el registro hace UNA lectura completa
  // (establece el watermark _deltaSk); a partir de ahí todo es delta.
  // Se espera ese ciclo antes de medir el estado estacionario.
  await sleep(3800);

  // FASE 3 — estado estacionario: 5 reacciones nuevas, solo consultas delta.
  // :lo de la fase 2 acotada = 'fiestaX/' + hijo menor de la ventana (keys[6]);
  // el :lo delta real va pegado al maximo visto -> siempre mayor.
  const PHASE2_LO = FIESTA + '/' + keys[6];
  stats.fullItems = 0; stats.deltaItems = 0; stats.deltaQueries = 0;
  stats.deltaQuerySizes = []; stats.phase1Queries = 0; stats.betweenLos = [];
  const newKeys = [];
  for (let j = 0; j < 5; j++) {
    const k = I.pushIdLowerBound(NOW + 10000 + j * 1000); newKeys.push(k);
    seedReaction(k, ALLOWED[(j + 2) % ALLOWED.length], 'peer' + (j + 5), NOW);
  }
  const n2 = firedNew.length;
  await waitFor(() => firedNew.length >= n2 + 5, 10000);
  const deltaBatch = firedNew.slice(n2, n2 + 5);
  check('delta: disparan exactamente las 5 nuevas', firedNew.length === n2 + 5,
    (firedNew.length - n2) + ' disparos');
  check('delta: orden de claves en el lote nuevo',
    JSON.stringify(deltaBatch) === JSON.stringify([0, 1, 2, 3, 4].map(j => ALLOWED[(j + 2) % ALLOWED.length])));
  // Un ciclo idle más: sin re-disparos de la línea base
  const n3 = firedNew.length;
  await sleep(4200);
  check('delta: ciclo idle no re-dispara la linea base', firedNew.length === n3,
    (firedNew.length - n3) + ' re-disparos');
  check('delta: en estado estacionario no corre fase 1 (begins_with sk)',
    stats.phase1Queries === 0, stats.phase1Queries + ' consultas fase 1');
  const los = stats.betweenLos;
  check('delta: todas las consultas BETWEEN son delta real (ninguna fase 2 acotada)',
    los.length >= 1 && los.every(lo => lo > PHASE2_LO),
    JSON.stringify(los));
  const maxDeltaQuery = Math.max.apply(null, stats.deltaQuerySizes.concat([0]));
  check('delta: cada consulta delta lee acotado (<= 90 hojas; la lectura inicial completa leyo ' + fullReadCost + ')',
    maxDeltaQuery > 0 && maxDeltaQuery <= 90 && maxDeltaQuery < fullReadCost,
    'max consulta delta: ' + maxDeltaQuery + ' hojas');

  // FASE 4 — remove() del nodo completo + re-push (leaveFiesta/endFiesta)
  clearReactions();
  const n4 = firedNew.length;
  stats.deltaItems = 0; stats.deltaQueries = 0; stats.deltaQuerySizes = [];
  const rk = [I.pushIdLowerBound(NOW + 60000), I.pushIdLowerBound(NOW + 61000)];
  seedReaction(rk[0], ALLOWED[1], 'peerA', NOW);
  seedReaction(rk[1], ALLOWED[3], 'peerB', NOW);
  await waitFor(() => firedNew.length >= n4 + 2, 10000);
  const repushBatch = firedNew.slice(n4, n4 + 2);
  check('tras remove()+re-push: las 2 nuevas disparan (claves > watermark)',
    repushBatch.length === 2 && repushBatch[0] === ALLOWED[1] && repushBatch[1] === ALLOWED[3],
    JSON.stringify(repushBatch));

  // FASE 5 — teardown del oyente delta con off('child_added') (forma documentada)
  const n5 = firedNew.length;
  ctx.fiestaRefs.reactions.off('child_added');
  seedReaction(I.pushIdLowerBound(NOW + 70000), ALLOWED[0], 'peerZ', NOW);
  await sleep(4200);
  check("off('child_added') tambien desuscribe al oyente delta", firedNew.length === n5,
    (firedNew.length - n5) + ' disparos extra');

  console.log(failures === 0 ? 'test-c12-fiesta-reactions-ondelta: TODO OK'
    : failures + ' FALLOS');
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('ERROR:', e); process.exit(1); });
