'use strict';
/* PERF ciclo 15 (C14-07) — harness de equivalencia de la fase 2 batched.
 *
 * Compara el camino NUEVO (una sola query `sk BETWEEN :lo AND :hi` sobre el
 * rango contiguo de prefijos) contra el VIEJO (N queries begins_with, una
 * por post), cargando AMBOS drex-cloud.js en el mismo proceso (pristine vs
 * src, cada uno con su propio DynamoDB falso sembrado idéntico):
 * las hojas devueltas deben ser BYTE-IDÉNTICAS en todos los escenarios
 * (mismo orden, mismos _imgKeys). Solo cambia el costo
 * (ver test-c15-feed-poll-cost.js).
 *
 * Parte 2 (timed, timer real de 3 s): el contrato del ciclo de polling no
 * cambia — detección ≤ 1 ciclo en activo, 0 callbacks en idle, pausa total
 * en background (document.hidden) y reanudación al volver — antes y después.
 *
 * Uso: node tests/test-c15-feed-poll-equivalence.js
 * Resolución de layout: ../index.html primero, fallback ../src/index.html.
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
  throw new Error('no se encontró el dir src');
}
const SRC = resolveSrcDir();
const PRISTINE = path.resolve(SRC, '..', 'pristine', 'drex-cloud.js');
const HAVE_PRISTINE = fs.existsSync(PRISTINE);

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

// --- DynamoDB falso (igual al de cost, + flag para romper el BETWEEN) --------
function cmpSk(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
function makeFake() {
  const items = [];
  const stats = { ops: 0 };
  const self = {
    failBetween: false,
    _put(pk, sk, v) { items.push({ pk, sk, v: JSON.stringify(v) }); },
    _setV(pk, sk, v) {
      const it = items.find(x => x.pk === pk && x.sk === sk);
      if (it) it.v = JSON.stringify(v); else self._put(pk, sk, v);
    },
    _delSk(pk, sk) { for (let i = items.length - 1; i >= 0; i--) if (items[i].pk === pk && items[i].sk === sk) items.splice(i, 1); },
    _reset() { stats.ops = 0; },
    _ops() { return stats.ops; },
    query(params) {
      return {
        promise() {
          const vals = params.ExpressionAttributeValues || {};
          const kc = params.KeyConditionExpression || '';
          if (self.failBetween && kc.indexOf('sk BETWEEN :lo AND :hi') !== -1) {
            return Promise.reject(new Error('BETWEEN roto a propósito'));
          }
          let arr = items.filter(it => it.pk === vals[':pk']);
          if (kc.indexOf('begins_with(sk, :pfx)') !== -1) arr = arr.filter(it => it.sk.indexOf(vals[':pfx']) === 0);
          else if (kc.indexOf('sk BETWEEN :lo AND :hi') !== -1) arr = arr.filter(it => it.sk >= vals[':lo'] && it.sk <= vals[':hi']);
          else if (kc.indexOf('sk < :endSk') !== -1) arr = arr.filter(it => it.sk < vals[':endSk']);
          else if (kc.indexOf('begins_with(sk,') !== -1) throw new Error('KC no soportada: ' + kc);
          if (params.FilterExpression && params.FilterExpression.indexOf('NOT contains(sk, :img)') !== -1) {
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
          stats.ops++;
          const res = { Items: out };
          if (lek) res.LastEvaluatedKey = lek;
          return Promise.resolve(res);
        }
      };
    },
    get(params) {
      return {
        promise() {
          const it = items.find(x => x.pk === params.Key.pk && x.sk === params.Key.sk);
          stats.ops++;
          return Promise.resolve({ Item: it ? { pk: it.pk, sk: it.sk, v: it.v } : undefined });
        }
      };
    }
  };
  return self;
}

// --- Fixture idéntica para ambas instancias ----------------------------------
const BASE_TS = 1750000000000;
const N_POSTS = 600;
let pushKey;
function seedFeed(put) {
  for (let i = 0; i < N_POSTS; i++) {
    const pid = pushKey(i), ts = BASE_TS + i * 1000;
    put('communityNotes', pid + '/text', 'post numero ' + i);
    put('communityNotes', pid + '/authorId', 'u' + (i % 37));
    put('communityNotes', pid + '/authorName', 'Autor ' + (i % 37));
    put('communityNotes', pid + '/timestamp', ts);
    put('communityNotes', pid + '/upvotes', i % 91);
    put('communityNotes', pid + '/downvotes', i % 7);
    put('communityNotes', pid + '/commentsCount', i % 13);
    put('communityNotes', pid + '/postType', 'text');
    if (i % 3 === 0) { put('communityNotes', pid + '/imageCount', 2); put('communityNotes', pid + '/imageUrls/0', 'img0'); put('communityNotes', pid + '/imageUrls/1', 'img1'); }
    if (i % 5 === 0) put('communityNotes', pid + '/poll', { q: 'q' + i, options: [{ t: 'a', v: 3 }] });
  }
}
function seedMusic(put) {
  for (let i = 0; i < 40; i++) {
    const tid = pushKey(i);
    put('musicTracks', tid + '/title', 'track ' + i);
    put('musicTracks', tid + '/artistId', 'a' + (i % 5));
    put('musicTracks', tid + '/createdAt', BASE_TS + i * 7000);
    put('musicTracks', tid + '/duration', 180 + i);
  }
}
const FEED_Q = { orderBy: 'timestamp', limitLast: 50 };
const canon = leaves => JSON.stringify(leaves);

function loadPair() {
  // Dos instancias independientes del módulo (pristine y src), cada una con
  // su fake sembrado idéntico.
  const oldM = require(HAVE_PRISTINE ? PRISTINE : path.join(SRC, 'drex-cloud.js'));
  delete require.cache[require.resolve(path.join(SRC, 'drex-cloud.js'))];
  const newM = require(path.join(SRC, 'drex-cloud.js'));
  pushKey = i => oldM.__internals.pushIdLowerBound(BASE_TS + i * 1000);
  const fo = makeFake(), fn = makeFake();
  seedFeed(fo._put); seedFeed(fn._put);
  seedMusic(fo._put); seedMusic(fn._put);
  oldM.__internals.setDocClient(fo);
  newM.__internals.setDocClient(fn);
  return {
    old: { M: oldM, I: oldM.__internals, fake: fo, db: () => oldM.DrexCloud.database() },
    new: { M: newM, I: newM.__internals, fake: fn, db: () => newM.DrexCloud.database() },
  };
}
async function readFeed(side, q) {
  return side.I.readLeaves(['communityNotes'], q || FEED_Q);
}
function uiResult(I, leaves, q) {
  const val = I.unflatten(leaves, ['communityNotes']);
  return JSON.stringify(I.applyQuery(val, q || FEED_Q));
}
const realNow = Date.now;

async function partReadLevel() {
  console.log('== Parte 1: hojas byte-idénticas (pristine vs parcheado) ==');
  const { old, new: nw } = loadPair();
  const O = old.fake, N = nw.fake;

  // 1. Lectura en frío
  let lo = await readFeed(old), ln = await readFeed(nw);
  check('1. frío: hojas byte-idénticas', canon(ln) === canon(lo));
  check('1b. frío: UI (unflatten+applyQuery) idéntica', uiResult(nw.I, ln) === uiResult(old.I, lo));
  check('1c. frío: 50 posts en el resultado UI', (uiResult(nw.I, ln).match(/post numero/g) || []).length >= 40);

  // 2. Post nuevo -> fase 2 inmediata en ambos, mismo resultado
  const npid = pushKey(N_POSTS);
  [[O], [N]].forEach(([f]) => {
    f._put('communityNotes', npid + '/text', 'nuevo!');
    f._put('communityNotes', npid + '/authorId', 'u1');
    f._put('communityNotes', npid + '/timestamp', BASE_TS + N_POSTS * 1000);
    f._put('communityNotes', npid + '/upvotes', 0);
  });
  lo = await readFeed(old); ln = await readFeed(nw);
  check('2. post nuevo: hojas byte-idénticas', canon(ln) === canon(lo));
  check('2b. post nuevo visible en ambos', uiResult(nw.I, ln).indexOf('nuevo!') !== -1 && uiResult(old.I, lo).indexOf('nuevo!') !== -1);

  // 3. Borrado del más nuevo
  ['text', 'authorId', 'timestamp', 'upvotes'].forEach(f => { O._delSk('communityNotes', npid + '/' + f); N._delSk('communityNotes', npid + '/' + f); });
  lo = await readFeed(old); ln = await readFeed(nw);
  check('3. borrado: hojas byte-idénticas', canon(ln) === canon(lo));
  check('3b. borrado: ya no aparece', uiResult(nw.I, ln).indexOf('nuevo!') === -1);

  // 4. Atributo nuevo (imagen) en un post de la ventana + _imgKeys
  const tpid = pushKey(N_POSTS - 2);
  [O, N].forEach(f => { f._put('communityNotes', tpid + '/imageCount', 1); f._put('communityNotes', tpid + '/imageUrls/0', 'foto-nueva'); });
  lo = await readFeed(old); ln = await readFeed(nw);
  check('4. imagen nueva: hojas byte-idénticas', canon(ln) === canon(lo));
  const imgLeaf = ln.find(l => l.segs[2] === '_imgKeys' && l.segs[1] === tpid);
  check('4b. _imgKeys idéntico y con la foto', JSON.stringify(imgLeaf) === JSON.stringify(lo.find(l => l.segs[2] === '_imgKeys' && l.segs[1] === tpid)));

  // 5. Cambio puro de valor (voto) + válvula de staleness
  const vpid = pushKey(N_POSTS - 5);
  O._setV('communityNotes', vpid + '/upvotes', 424242);
  N._setV('communityNotes', vpid + '/upvotes', 424242);
  lo = await readFeed(old); ln = await readFeed(nw);
  check('5. voto sin válvula: ambos sirven caché (idénticos)', canon(ln) === canon(lo));
  Date.now = () => realNow() + 31000;
  lo = await readFeed(old); ln = await readFeed(nw);
  Date.now = realNow;
  check('5b. tras válvula: hojas byte-idénticas', canon(ln) === canon(lo));
  check('5c. tras válvula: el voto llegó en ambos', uiResult(nw.I, ln).indexOf('424242') !== -1 && uiResult(old.I, lo).indexOf('424242') !== -1);

  // 6. Paginación endAt (cursor): clave separada
  const pageQ = { orderBy: 'timestamp', limitLast: 50, endAt: BASE_TS + 400 * 1000 };
  lo = await readFeed(old, pageQ); ln = await readFeed(nw, pageQ);
  check('6. endAt: hojas byte-idénticas', canon(ln) === canon(lo));
  lo = await readFeed(old, pageQ); ln = await readFeed(nw, pageQ);
  check('6b. endAt repetido (caché): idénticas', canon(ln) === canon(lo));

  // 7. Invalidación por escritura local
  old.I.invalidateBoundedPrefixCache(['communityNotes', vpid, 'text']);
  nw.I.invalidateBoundedPrefixCache(['communityNotes', vpid, 'text']);
  lo = await readFeed(old); ln = await readFeed(nw);
  check('7. tras invalidación local: hojas byte-idénticas', canon(ln) === canon(lo));

  // 8. Ruta NO-feed (musicTracks, lightImages=false): mismo camino BETWEEN
  const MQ = { orderBy: 'createdAt', limitLast: 20 };
  const mo = await old.I.readLeaves(['musicTracks'], MQ);
  const mn = await nw.I.readLeaves(['musicTracks'], MQ);
  check('8. musicTracks (no-feed): hojas byte-idénticas', canon(mn) === canon(mo));

  // 9. Fallback: BETWEEN roto en el parcheado -> camino por prefijo, mismo resultado
  N.failBetween = true;
  old.I.invalidateBoundedPrefixCache(['communityNotes', '__x__']);
  nw.I.invalidateBoundedPrefixCache(['communityNotes', '__x__']);
  // (la invalidación con segmento '__x__' fuerza fase 2 en la próxima lectura)
  lo = await readFeed(old); ln = await readFeed(nw);
  N.failBetween = false;
  check('9. fallback por prefijo: hojas byte-idénticas', canon(ln) === canon(lo), 'ops new=' + N._ops());

  // 10. Post gigante como el más nuevo (fase 1 multipágina + BETWEEN ancho)
  const mpid = pushKey(N_POSTS + 1);
  [O, N].forEach(f => {
    for (let j = 0; j < 1200; j++) f._put('communityNotes', mpid + '/attr' + j, 'v' + j);
    f._put('communityNotes', mpid + '/timestamp', BASE_TS + (N_POSTS + 1) * 1000);
  });
  lo = await readFeed(old); ln = await readFeed(nw);
  check('10. post gigante: hojas byte-idénticas', canon(ln) === canon(lo));

  // 11. Ítem exacto huérfano en el feed (modo light): el camino viejo
  // (readLeavesLight = begins_with con '/') nunca lo devolvía; el nuevo
  // tampoco debe (filtro lightImages).
  const pidNew = pushKey(N_POSTS + 100);
  [O, N].forEach(f => { f._put('communityNotes', pidNew, 'primitiva-huerfana'); });
  old.I.invalidateBoundedPrefixCache(['communityNotes', '__x__']);
  nw.I.invalidateBoundedPrefixCache(['communityNotes', '__x__']);
  lo = await readFeed(old); ln = await readFeed(nw);
  check('11. exacto huérfano (light): hojas byte-idénticas', canon(ln) === canon(lo));
  check('11b. exacto huérfano: no viaja en ninguno',
    !ln.some(l => l.segs[1] === pidNew) && !lo.some(l => l.segs[1] === pidNew));

  // 12. Exacto+hijos (viola el invariante que set/update mantienen):
  // el viejo lo descartaba en light; el nuevo también.
  // (pid dentro de la ventana del feed: pushKey(599) es de los 50 newest)
  const pidB = pushKey(N_POSTS - 1);
  [O, N].forEach(f => { f._put('communityNotes', pidB, 'primitiva-con-hijos'); });
  old.I.invalidateBoundedPrefixCache(['communityNotes', '__x__']);
  nw.I.invalidateBoundedPrefixCache(['communityNotes', '__x__']);
  lo = await readFeed(old); ln = await readFeed(nw);
  check('12. exacto+hijos (light): hojas byte-idénticas', canon(ln) === canon(lo));
  check('12b. exacto+hijos: el exacto no viaja, los hijos sí',
    !ln.some(l => l.segs[1] === pidB && l.segs.length === 2) &&
    ln.some(l => l.segs[1] === pidB && l.segs[2] === 'text'));

  // 13. Ruta no-light (musicTracks): el exacto SÍ viaja, al FINAL del grupo
  // (el camino viejo hacía rest.concat([exact])).
  const tid = pushKey(5);
  [O, N].forEach(f => { f._put('musicTracks', tid, 'exact-track'); });
  old.I.invalidateBoundedPrefixCache(['musicTracks', '__x__']);
  nw.I.invalidateBoundedPrefixCache(['musicTracks', '__x__']);
  const mo2 = await old.I.readLeaves(['musicTracks'], MQ);
  const mn2 = await nw.I.readLeaves(['musicTracks'], MQ);
  check('13. exacto (no-light): hojas byte-idénticas', canon(mn2) === canon(mo2));
  const grpN = mn2.filter(l => l.segs[1] === tid);
  const grpO = mo2.filter(l => l.segs[1] === tid);
  check('13b. exacto al final del grupo en ambos',
    grpN.length > 1 && grpO.length === grpN.length &&
    grpN[grpN.length - 1].segs.length === 2 &&
    JSON.stringify(grpN[grpN.length - 1]) === JSON.stringify(grpO[grpO.length - 1]));

  old.I.resetListeners(); nw.I.resetListeners();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Contrato del ciclo de polling con el timer REAL (3 s), antes y después:
// - idle: 0 callbacks tras el burst inicial
// - activo: un post nuevo se detecta en <= 1 ciclo (3.5 s de margen)
// - tab oculta: 0 lecturas; al volver: se reanuda
async function timedContract(side, label) {
  console.log('== Parte 2' + label + ': contrato del ciclo (timer real 3 s) ==');
  const { I, fake, db } = side;
  const t0 = Date.now();
  const evts = [];
  const ref = db().ref('communityNotes').orderByChild('timestamp').limitToLast(50);
  const offs = [
    ref.on('child_added', s => evts.push(['added', s.key])),
    ref.on('child_changed', s => evts.push(['changed', s.key])),
    ref.on('child_removed', s => evts.push(['removed', s.key])),
  ];
  await sleep(400); // burst inicial asentado
  const initialAdds = evts.filter(e => e[0] === 'added').length;
  check('idle: burst inicial de 50 child_added', initialAdds === 50, 'fueron ' + initialAdds);
  evts.length = 0;

  // ACTIVO: post nuevo a ~1.2 s; debe detectarse en el ciclo de ~3 s
  const npid = pushKey(N_POSTS + 50);
  const tPost = Date.now();
  fake._put('communityNotes', npid + '/text', 'en vivo ' + label);
  fake._put('communityNotes', npid + '/authorId', 'u1');
  fake._put('communityNotes', npid + '/timestamp', BASE_TS + (N_POSTS + 50) * 1000);
  fake._put('communityNotes', npid + '/upvotes', 0);
  let foundAt = -1;
  for (let w = 0; w < 40 && foundAt === -1; w++) {
    await sleep(250);
    const e = evts.find(e => e[0] === 'added' && e[1] === npid);
    if (e) foundAt = Date.now();
  }
  check('activo: child_added del post nuevo', foundAt !== -1);
  if (foundAt !== -1) {
    const delay = foundAt - tPost;
    check('activo: detectado en <= 1 ciclo (3.5 s)', delay <= 3500, delay + ' ms');
  }
  // Voto remoto (cambio puro de valor): la válvula lo trae (aquí se invalida
  // como haría notifyLocal ante escritura; el punto es que el contenido llega)
  evts.length = 0;
  const vpid = pushKey(N_POSTS - 7);
  fake._setV('communityNotes', vpid + '/upvotes', 777001);
  I.invalidateBoundedPrefixCache(['communityNotes', vpid, 'upvotes']);
  let chAt = -1;
  for (let w = 0; w < 40 && chAt === -1; w++) {
    await sleep(250);
    if (evts.find(e => e[0] === 'changed' && e[1] === vpid)) chAt = Date.now();
  }
  check('activo: child_changed del voto llega', chAt !== -1);

  // IDLE: 3.5 s sin cambios -> 0 callbacks (ni added ni changed ni removed)
  evts.length = 0;
  await sleep(3500);
  check('idle: 0 callbacks en un ciclo sin cambios', evts.length === 0, JSON.stringify(evts.slice(0, 3)));

  // TAB OCULTA: no debe haber lecturas del ciclo normal
  global.document = { hidden: true };
  fake._reset();
  await sleep(3600);
  const opsHidden = fake._ops();
  check('oculta: 0 lecturas del ciclo con document.hidden', opsHidden === 0, 'ops=' + opsHidden);
  // TAB VISIBLE de nuevo: se reanuda en <= 1 ciclo
  delete global.document;
  fake._reset();
  await sleep(3600);
  const opsVisible = fake._ops();
  check('visible: el ciclo se reanuda', opsVisible > 0, 'ops=' + opsVisible);

  offs.forEach(o => o());
  I.resetListeners();
  if (global.document) delete global.document;
}

async function main() {
  await partReadLevel();
  if (!HAVE_PRISTINE) {
    console.log('(sin copia pristine: parte 2 solo contra src)');
    const { new: nw } = loadPair();
    await timedContract(nw, ' [parcheado]');
  } else {
    const pair1 = loadPair();
    await timedContract(pair1.old, ' [pristine]');
    const pair2 = loadPair();
    await timedContract(pair2.new, ' [parcheado]');
  }
  console.log(failures === 0 ? '\nEQUIVALENCIA OK' : '\nEQUIVALENCIA CON ' + failures + ' FALLOS');
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('FALLO:', e); process.exit(1); });
