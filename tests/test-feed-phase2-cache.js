'use strict';
/* PERF ciclo 8 H4 — harness de equivalencia del caché de fase 2 del feed.
 * Compara el camino NUEVO (readLeavesBounded con válvula de huella para
 * pk='communityNotes') contra el camino VIEJO (misma función con el caché
 * invalidado antes de cada lectura = "fase 2 siempre").
 * Los resultados deben ser byte-idénticos; solo se permite el retraso
 * acotado documentado para cambios puros de valor (válvula 30 s).
 * Ejecutar con: node tests/test-feed-phase2-cache.js
 */
const path = require('path');
const { __internals: I } = require(path.join(__dirname, '..', 'drex-cloud.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

// --- Tabla falsa -----------------------------------------------------------
const items = []; // {pk, sk, v}
const BASE_TS = 1750000000000;
const N_POSTS = 600;
function pushKey(i) { return I.pushIdLowerBound(BASE_TS + i * 1000); }
function add(pk, sk, v) { items.push({ pk, sk, v: JSON.stringify(v) }); }
function delSk(pk, sk) {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].pk === pk && items[i].sk === sk) items.splice(i, 1);
}
function setV(pk, sk, v) {
  const it = items.find(x => x.pk === pk && x.sk === sk);
  if (it) it.v = JSON.stringify(v); else add(pk, sk, v);
}

const POST_ATTRS = ['text', 'authorId', 'authorName', 'timestamp', 'upvotes', 'downvotes', 'commentsCount', 'postType'];
function seedPost(i) {
  const pid = pushKey(i), ts = BASE_TS + i * 1000;
  add('communityNotes', pid + '/text', 'post ' + i);
  add('communityNotes', pid + '/authorId', 'u' + (i % 37));
  add('communityNotes', pid + '/authorName', 'Autor ' + (i % 37));
  add('communityNotes', pid + '/timestamp', ts);
  add('communityNotes', pid + '/upvotes', i % 91);
  add('communityNotes', pid + '/downvotes', i % 7);
  add('communityNotes', pid + '/commentsCount', i % 13);
  add('communityNotes', pid + '/postType', 'text');
  if (i % 3 === 0) { add('communityNotes', pid + '/imageCount', 2); add('communityNotes', pid + '/imageUrls/0', 'img0'); add('communityNotes', pid + '/imageUrls/1', 'img1'); }
  if (i % 5 === 0) add('communityNotes', pid + '/poll', { q: 'q' + i, options: [{ t: 'a', v: 3 }] });
  return pid;
}
const pids = [];
for (let i = 0; i < N_POSTS; i++) pids.push(seedPost(i));

function cmpSk(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
let phase1Items = 0, phase2Items = 0, phase1Q = 0, phase2Q = 0;
const fakeClient = {
  query(params) {
    const isPhase1 = params.ProjectionExpression === 'sk';
    return {
      promise() {
        const vals = params.ExpressionAttributeValues || {};
        let arr = items.filter(it => it.pk === vals[':pk']);
        const kc = params.KeyConditionExpression || '';
        if (kc.includes('begins_with(sk, :pfx)')) arr = arr.filter(it => it.sk.indexOf(vals[':pfx']) === 0);
        else if (kc.includes('sk < :endSk')) arr = arr.filter(it => it.sk < vals[':endSk']);
        if (params.FilterExpression && params.FilterExpression.includes('NOT contains(sk, :img)')) {
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
        const out = arr.map(it => (isPhase1 ? { sk: it.sk } : { pk: it.pk, sk: it.sk, v: it.v }));
        if (isPhase1) { phase1Items += out.length; phase1Q++; } else { phase2Items += out.length; phase2Q++; }
        const res = { Items: out };
        if (lek) res.LastEvaluatedKey = lek;
        return Promise.resolve(res);
      }
    };
  },
  get(params) { return { promise() { return Promise.resolve({ Item: null }); } }; }
};
I.setDocClient(fakeClient);

const Q = { orderBy: 'timestamp', limitLast: 50 };
function resetCounters() { phase1Items = 0; phase2Items = 0; phase1Q = 0; phase2Q = 0; }
// Camino VIEJO: lee y DESPUÉS invalida ("fase 2 siempre", sin repoblar útil)
// para que newPath() arranque frío de verdad.
async function oldPath(query) {
  resetCounters();
  const leaves = await I.readLeaves(['communityNotes'], query || Q);
  const out = { leaves, p1: phase1Items, p2: phase2Items };
  I.invalidateBoundedPrefixCache(['communityNotes', '__old__']);
  return out;
}
// Camino NUEVO: deja el caché como esté
async function newPath(query) {
  resetCounters();
  const leaves = await I.readLeaves(['communityNotes'], query || Q);
  return { leaves, p1: phase1Items, p2: phase2Items, p2q: phase2Q };
}
const canon = (leaves) => JSON.stringify(leaves);
// Resultado tal como lo consume la UI: unflatten + applyQuery
function uiResult(leaves, query) {
  const val = I.unflatten(leaves, ['communityNotes']);
  return JSON.stringify(I.applyQuery(val, query || Q));
}
const realNow = Date.now;
function forceStale(ms) { Date.now = () => realNow() + (ms || 31000); }
function unforceStale() { Date.now = realNow; }

async function main() {
  // 1. Idle: 3 ciclos sin cambios -> byte-idénticos, fase 2 solo en el 1º
  const r0 = await oldPath();
  const n1 = await newPath();
  check('1a. ciclo frío == camino viejo (byte-idéntico)', canon(n1.leaves) === canon(r0.leaves));
  check('1b. ciclo frío corre fase 2', n1.p2 > 0, 'p2=' + n1.p2);
  check('1c. UI (unflatten+applyQuery) idéntica', uiResult(n1.leaves) === uiResult(r0.leaves));
  const n2 = await newPath();
  check('1d. 2º ciclo idle salta la fase 2', n2.p2q === 0 && n2.p2 === 0, 'p2q=' + n2.p2q);
  check('1e. 2º ciclo byte-idéntico al 1º', canon(n2.leaves) === canon(n1.leaves));
  const n3 = await newPath();
  check('1f. 3er ciclo idle salta la fase 2', n3.p2q === 0);
  check('1g. fase 1 acotada con Limit (<= ~900 items, no página 1MB)', n3.p1 <= 900, 'p1=' + n3.p1);

  // 2. Post nuevo -> fase 2 inmediata, resultado correcto
  const newPid = pushKey(N_POSTS);
  ['text', 'authorId', 'timestamp', 'upvotes'].forEach((f, j) =>
    add('communityNotes', newPid + '/' + f, f === 'timestamp' ? BASE_TS + N_POSTS * 1000 : 'nv' + j));
  const exp2 = await oldPath();
  const got2 = await newPath();
  check('2a. post nuevo: fase 2 corre en el mismo ciclo', got2.p2q > 0);
  check('2b. post nuevo: byte-idéntico al camino viejo', canon(got2.leaves) === canon(exp2.leaves));
  check('2c. post nuevo: aparece en el resultado UI', uiResult(got2.leaves).indexOf(newPid) !== -1);

  // 3. Borrado de post (el más nuevo) -> fase 2 inmediata
  POST_ATTRS.concat(['imageCount', 'imageUrls/0', 'imageUrls/1', 'poll']).forEach(f => delSk('communityNotes', newPid + '/' + f));
  ['text', 'authorId', 'timestamp', 'upvotes'].forEach(f => delSk('communityNotes', newPid + '/' + f));
  const exp3 = await oldPath();
  const got3 = await newPath();
  check('3a. borrado: fase 2 corre en el mismo ciclo', got3.p2q > 0);
  check('3b. borrado: byte-idéntico al camino viejo', canon(got3.leaves) === canon(exp3.leaves));
  check('3c. borrado: el post ya no aparece', uiResult(got3.leaves).indexOf(newPid) === -1);

  // 4. Atributo nuevo (imagen) en un post de la ventana -> fase 2 inmediata + _imgKeys
  const targetPid = pids[N_POSTS - 2];
  add('communityNotes', targetPid + '/imageCount', 1);
  add('communityNotes', targetPid + '/imageUrls/0', 'nueva-foto');
  const exp4 = await oldPath();
  const got4 = await newPath();
  check('4a. imagen nueva: fase 2 corre en el mismo ciclo', got4.p2q > 0);
  check('4b. imagen nueva: byte-idéntico al camino viejo', canon(got4.leaves) === canon(exp4.leaves));
  const imgLeaf = got4.leaves.find(l => l.segs[2] === '_imgKeys' && l.segs[1] === targetPid);
  check('4c. _imgKeys del post incluye la foto nueva',
    !!(imgLeaf && imgLeaf.value.indexOf('imageUrls/0') !== -1), JSON.stringify(imgLeaf && imgLeaf.value));

  // 5. Cambio PURO de valor (contador de votos) -> staleness acotada documentada
  const votePid = pids[N_POSTS - 5];
  const before5 = canon((await newPath()).leaves);
  setV('communityNotes', votePid + '/upvotes', 424242);
  const stale5 = await newPath();
  check('5a. cambio de valor: la huella NO se mueve (ciclo sirve caché)', stale5.p2q === 0);
  check('5b. cambio de valor: resultado == pre-cambio (retraso, no pérdida)', canon(stale5.leaves) === before5);
  forceStale();
  const exp5 = await oldPath();
  const got5 = await newPath();
  unforceStale();
  check('5c. tras válvula 30s: fase 2 corre', got5.p2q > 0);
  check('5d. tras válvula 30s: byte-idéntico al camino viejo', canon(got5.leaves) === canon(exp5.leaves));
  check('5e. tras válvula 30s: el voto nuevo llegó', uiResult(got5.leaves).indexOf('424242') !== -1);

  // 6. Edición de texto (valor puro) -> mismo tratamiento. La válvula se
  // refrescó en el escenario 5, así que aquí se fuerza con +120 s para
  // vencerla con certeza respecto al ts guardado.
  setV('communityNotes', votePid + '/text', 'texto editado remoto');
  const stale6 = await newPath();
  check('6a. edición: ciclo inmediato sirve caché (válvula)', stale6.p2q === 0);
  forceStale(120000);
  const exp6 = await oldPath();
  const got6 = await newPath();
  unforceStale();
  check('6b. edición tras válvula: byte-idéntico al camino viejo', canon(got6.leaves) === canon(exp6.leaves));

  // 7. Paginación endAt: clave separada, correcta y cacheada
  const pageQ = { orderBy: 'timestamp', limitLast: 50, endAt: BASE_TS + 400 * 1000 };
  const exp7 = await oldPath(pageQ);
  const got7 = await newPath(pageQ);
  check('7a. endAt: byte-idéntico al camino viejo', canon(got7.leaves) === canon(exp7.leaves));
  const got7b = await newPath(pageQ);
  check('7b. endAt repetido: salta fase 2 (caché por cursor)', got7b.p2q === 0 && canon(got7b.leaves) === canon(got7.leaves));
  const pageQ2 = { orderBy: 'timestamp', limitLast: 50, endAt: BASE_TS + 300 * 1000 };
  const exp7c = await oldPath(pageQ2);
  const got7c = await newPath(pageQ2);
  check('7c. otro cursor: clave distinta, resultado correcto', canon(got7c.leaves) === canon(exp7c.leaves));
  check('7d. paginación trae posts más viejos que la 1ª página',
    uiResult(got7.leaves).indexOf(pids[399]) !== -1 && uiResult(got7.leaves).indexOf(pids[N_POSTS - 1]) === -1);

  // 8. Invalidación por escritura LOCAL (notifyLocal -> invalidateBoundedPrefixCache)
  await newPath(); // calienta
  I.invalidateBoundedPrefixCache(['communityNotes', votePid, 'text']); // como haría notifyLocal tras editar
  const inv8 = await newPath();
  check('8a. escritura local invalida el caché del feed', inv8.p2q > 0);
  const inv8b = await newPath();
  check('8b. tras invalidar, el siguiente ciclo vuelve a cachear', inv8b.p2q === 0);

  // 9. Aislamiento: escrituras bajo OTRO pk no tocan el caché del feed
  await newPath(); // calienta
  I.invalidateBoundedPrefixCache(['userVotes', 'u1', 'x']);
  const iso9 = await newPath();
  check('9a. escritura en otro pk NO invalida el feed', iso9.p2q === 0);

  // 10. Fase 1 multipágina con Limit (post gigante como el más nuevo)
  const megaPid = pushKey(N_POSTS + 1);
  for (let j = 0; j < 1200; j++) add('communityNotes', megaPid + '/attr' + j, 'v' + j);
  add('communityNotes', megaPid + '/timestamp', BASE_TS + (N_POSTS + 1) * 1000);
  add('communityNotes', megaPid + '/text', 'mega');
  const exp10 = await oldPath();
  const got10 = await newPath();
  check('10a. post gigante: byte-idéntico al camino viejo', canon(got10.leaves) === canon(exp10.leaves));
  check('10b. post gigante: fase 1 NO leyó el pk entero (Limit activo)',
    got10.p1 < items.length, 'p1=' + got10.p1 + ' de ' + items.length + ' items totales');

  console.log(failures === 0 ? '\nTODOS LOS CHECKS PASARON' : '\n' + failures + ' CHECKS FALLARON');
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
