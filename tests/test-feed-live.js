'use strict';
/* Feed estilo X: lógica pura (drex-feed-live.js) + cableado en index.html/sw.js.
 * Ejecutar con: node tests/test-feed-live.js */
const fs = require('fs');
const path = require('path');
const FL = require(path.join(__dirname, '..', 'drex-feed-live.js'));
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

(async () => {
  // dedupe: 50 llamadas simultáneas para el mismo autor = 1 sola lectura
  const store = new Map();
  let reads = 0;
  const slowRead = () => new Promise((r) => setTimeout(() => { reads++; r({ v: 1 }); }, 20));
  const res = await Promise.all(Array.from({ length: 50 }, () => FL.dedupe(store, 'priv:u1', slowRead)));
  check('dedupe: 50 notas del mismo autor -> 1 lectura', reads === 1 && res.every((x) => x.v === 1));
  check('dedupe: limpia la clave al terminar', store.size === 0);
  await FL.dedupe(store, 'priv:u1', slowRead);
  check('dedupe: después de resolver vuelve a leer (TTL lo maneja el caché)', reads === 2);
  await FL.dedupe(store, 'k', () => Promise.reject(new Error('x'))).catch(() => {});
  check('dedupe: un rechazo también libera la clave', store.size === 0);
  const r2 = await Promise.all([FL.dedupe(store, 'a', () => 1), FL.dedupe(store, 'b', () => 2)]);
  check('dedupe: claves distintas no se mezclan', r2[0] === 1 && r2[1] === 2);

  // buffer
  const b = FL.createBuffer();
  check('buffer: add nueva', b.add({ id: 'n2', timestamp: 200 }) === true);
  check('buffer: no duplica', b.add({ id: 'n2', timestamp: 200 }) === false);
  b.add({ id: 'n3', timestamp: 300 }); b.add({ id: 'n1', timestamp: 100 });
  check('buffer: count', b.count() === 3);
  check('buffer: has/remove', b.has('n1') && b.remove('n1') && !b.has('n1') && b.count() === 2);
  const ids = b.drain().map((n) => n.id);
  check('buffer: drain de vieja a nueva (prepend deja la nueva arriba)', ids.join() === 'n2,n3');
  check('buffer: drain vacía', b.count() === 0);
  check('buffer: ignora notas sin id', b.add(null) === false && b.add({}) === false);

  // decisión de encolar
  check('encola si ya bajaste', FL.shouldBufferNewPost({ scrollTop: 800 }) === true);
  check('NO encola si estás arriba', FL.shouldBufferNewPost({ scrollTop: 40 }) === false);
  check('NO encola lo que publico yo', FL.shouldBufferNewPost({ scrollTop: 800, isOwn: true }) === false);
  check('NO encola actualizaciones de tarjetas ya visibles', FL.shouldBufferNewPost({ scrollTop: 800, alreadyShown: true }) === false);
  check('vuelca al volver arriba con pendientes', FL.shouldFlushOnScroll(10, 3) === true);
  check('no vuelca sin pendientes', FL.shouldFlushOnScroll(10, 0) === false);
  check('no vuelca si sigues abajo', FL.shouldFlushOnScroll(500, 3) === false);

  // pull to refresh
  let s = FL.pullState(0);
  check('pull: 0 -> sin progreso', s.distance === 0 && s.progress === 0 && !s.ready);
  s = FL.pullState(60);
  check('pull: 60px de dedo = 30px (resistencia) y aún no listo', s.distance === 30 && !s.ready && s.progress > 0.4 && s.progress < 0.5);
  s = FL.pullState(128);
  check('pull: 128px de dedo llega al umbral', s.distance === 64 && s.ready && s.progress === 1);
  s = FL.pullState(10000);
  check('pull: tope máximo', s.distance === FL.PULL_MAX);
  check('pull: valores negativos/NaN seguros', FL.pullState(-5).distance === 0 && FL.pullState(NaN).distance === 0);

  // Mi gente
  const fm = { me: true, a: { followedAt: 10 }, b: { followedAt: 30 }, c: true, d: { followedAt: 20 }, z: null };
  check('autores: excluye a uno mismo y vacíos, más recientes primero',
    FL.pickFollowedAuthors(fm, 'me', 10).join() === 'b,d,a,c');
  check('autores: respeta el tope', FL.pickFollowedAuthors(fm, 'me', 2).join() === 'b,d');
  check('autores: entrada inválida', FL.pickFollowedAuthors(null, 'me', 5).length === 0);

  // barra inferior
  check('nav: cerca del tope siempre visible', FL.navShouldHide(10, 40) === false);
  check('nav: scroll mínimo no cambia', FL.navShouldHide(300, 303) === null);
  check('nav: baja -> oculta', FL.navShouldHide(300, 330) === true);
  check('nav: sube -> muestra', FL.navShouldHide(330, 300) === false);

  // cableado
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  check('index.html carga drex-feed-live.js', html.includes('<script defer src="drex-feed-live.js"></script>'));
  check('sw.js precachea drex-feed-live.js', sw.includes("'./drex-feed-live.js'"));
  check('existe la píldora #feed-new-posts-pill', html.includes('id="feed-new-posts-pill"') && html.includes('onclick="drexFeedFlushNewPosts()"'));
  check('el feed encola publicaciones en vivo', html.includes('ctx._newBuf.add(note)') && html.includes('shouldBufferNewPost'));
  check('loadNotes devuelve una promesa ligada a la carga real', html.includes('const _feedDone=_subscribeNotesFeed(') && html.includes('return _feedDone'));
  check('PTR ya no usa el temporizador fijo de 900 ms', !html.includes('indicator.innerHTML="";isPullRefreshing=false},900)'));
  check('N+1: lecturas del autor comparten petición en vuelo', html.includes('drexInflight("priv:"+uid') && html.includes('drexInflight("prof:"+authorId') && html.includes('drexInflight("fr:"+targetUserId'));
  check('Mi gente: relleno por notesByAuthor', html.includes('drexFeedBackfillFollowing') && html.includes('"notesByAuthor/"+uid'));
  check('404.html sincronizado', html === fs.readFileSync(path.join(__dirname, '..', '404.html'), 'utf8'));

  console.log(failures ? failures + ' FALLOS' : 'todo OK');
  process.exit(failures ? 1 : 0);
})();
