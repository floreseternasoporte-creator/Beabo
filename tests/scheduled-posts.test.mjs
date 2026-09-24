// Tests de POSTS PROGRAMADOS (Laboratorio de Funciones) — node con relojes falsos.
// Uso: node scheduled-posts.test.mjs [ruta-a-index.html]
// Extrae el bloque DREX-SCHEDULED-POSTS del HTML y lo evalúa en un sandbox con
// dependencias inyectadas (sin DOM). Si el HTML no trae el parche, FALLA.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || path.join(here, '..', 'index.html');
const html = readFileSync(target, 'utf8');

const START = '// === DREX-SCHEDULED-POSTS: INICIO ===';
const END = '// === DREX-SCHEDULED-POSTS: FIN ===';
const si = html.indexOf(START);
const ei = html.indexOf(END);
if (si === -1 || ei === -1 || ei < si) {
  console.error(`FALLO: ${target} no contiene el parche de posts programados (marcas DREX-SCHEDULED-POSTS ausentes).`);
  process.exit(1);
}
const code = html.slice(si, ei + END.length);

// Sandbox: appT identidad (ES base); NOTE_AUDIENCE_CONFIG ausente a propósito
// para probar la lista de audiencias por defecto del bloque.
const sandbox = { console, appT: s => s };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'scheduled-posts.block.js' });

const {
  drexSchedValidatePublishAt, drexSchedDueDrafts, drexSchedHasPending,
  drexSchedIsDue, drexSchedBuildNote, checkScheduledPosts, publishOneScheduledDraft,
} = sandbox;
for (const fn of [drexSchedValidatePublishAt, drexSchedDueDrafts, drexSchedHasPending,
  drexSchedIsDue, drexSchedBuildNote, checkScheduledPosts, publishOneScheduledDraft]) {
  assert.equal(typeof fn, 'function', 'el bloque debe exportar sus funciones al sandbox');
}

const MIN_LEAD = 5 * 60 * 1000;
const MAX_AHEAD = 30 * 24 * 3600 * 1000;
const NOW = 1_787_000_000_000; // reloj falso fijo

// Los objetos creados dentro del sandbox vm tienen otro prototipo: para
// compararlos se serializa a JSON en vez de deepStrictEqual.
const jEq = (actual, expected, msg) =>
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg || `esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);

function makeWorld(opts = {}) {
  const store = { list: (opts.drafts || []).map(d => ({ ...d })) };
  const published = [];
  const notified = [];
  const seenAtPublish = [];
  const user = opts.user === undefined ? { uid: 'u1', displayName: 'Tester' } : opts.user;
  const deps = {
    testMode: true,
    now: () => NOW,
    getDrafts: () => store.list.map(d => ({ ...d })),
    saveDrafts: l => { store.list = l.map(d => ({ ...d })); },
    currentUser: () => user,
    readUserData: async () => ({ username: 'tester_1', profileImage: 'img1' }),
    readFollowing: async () => ({ u1: true, u9: true }),
    moderate: () => ({ flagged: !!opts.flagged }),
    notify: m => notified.push(m),
    publishNote: (note, popts) => {
      seenAtPublish.push(store.list.map(d => ({ ...d })));
      published.push(note);
      const done = () => popts.onDone(opts.publishBehavior === 'fail' ? false : true);
      if (opts.publishBehavior === 'hang') return; // nunca resuelve
      if (opts.publishDelayMs) setTimeout(done, opts.publishDelayMs);
      else done();
    },
  };
  return { store, published, notified, seenAtPublish, deps };
}

const draftDue = (over = {}) => ({ id: 'd1', content: 'Hola programado', format: 'post', audience: 'public', updatedAt: NOW - 5000, publishAt: NOW - 1000, ...over });

// 1. Vencido se publica por el camino normal y sale de programados.
test('vencido se publica y sale de la lista', async () => {
  const w = makeWorld({ drafts: [draftDue()] });
  const res = await checkScheduledPosts(w.deps);
  assert.equal(res.ran, true);
  assert.equal(res.due, 1);
  assert.equal(res.results[0].status, 'published');
  assert.equal(w.published.length, 1);
  const note = w.published[0];
  assert.equal(note.content, 'Hola programado');
  assert.equal(note.authorId, 'u1');
  assert.equal(note.authorName, 'tester_1');
  assert.equal(note.drexScheduled, true); // sonda de origen
  assert.equal(note.audience.id, 'public');
  assert.deepEqual([note.upvotes, note.downvotes, note.commentsCount, note.ecosCount], [0, 0, 0, 0]);
  assert.equal(w.store.list.length, 0, 'el borrador publicado sale de programados');
});

// 2. Futuro no se publica.
test('futuro no se publica', async () => {
  const w = makeWorld({ drafts: [draftDue({ publishAt: NOW + 3600_000 })] });
  const res = await checkScheduledPosts(w.deps);
  assert.equal(w.published.length, 0);
  assert.equal(res.due, 0);
  assert.equal(w.store.list.length, 1, 'el borrador futuro se conserva');
  assert.equal(w.store.list[0].publishAt, NOW + 3600_000);
});

// 3. Borrado antes de la hora no se publica.
test('borrador eliminado antes de la hora no se publica', async () => {
  const w = makeWorld({ drafts: [draftDue()] });
  w.store.list = []; // el usuario lo borró
  const res = await checkScheduledPosts(w.deps);
  assert.equal(w.published.length, 0);
  assert.equal(res.due, 0);
  const direct = await publishOneScheduledDraft('d1', w.deps);
  assert.equal(direct.status, 'missing');
});

// 4. Doble chequeo concurrente no duplica (idempotencia: marca antes de publicar).
test('doble chequeo concurrente publica una sola vez', async () => {
  const w = makeWorld({ drafts: [draftDue()], publishDelayMs: 20 });
  const [r1, r2] = await Promise.all([checkScheduledPosts(w.deps), checkScheduledPosts(w.deps)]);
  assert.equal(w.published.length, 1, `se publicó ${w.published.length} veces`);
  assert.equal(r1.results[0].status, 'published');
  assert.equal(r2.due, 0, 'el segundo chequeo no ve el borrador ya marcado');
  // En el momento de publicar, el borrador ya estaba marcado como "publicando".
  assert.equal(w.seenAtPublish[0].find(d => d.id === 'd1').scheduledPublishing, true);
});

// 5. Sin sesión no se publica y queda pendiente.
test('sin sesión no se publica, queda pendiente', async () => {
  const w = makeWorld({ drafts: [draftDue()], user: null });
  const res = await checkScheduledPosts(w.deps);
  jEq(res, { ran: false, reason: 'no-session' });
  assert.equal(w.published.length, 0);
  assert.equal(w.store.list.length, 1);
  assert.equal(w.store.list[0].publishAt, NOW - 1000, 'conserva su fecha para cuando vuelva la sesión');
});

// 6. Ventana de validación: 5 min mínimo, 30 días máximo.
test('validación de fecha: pasado, muy pronto, ok, muy lejos, inválido', () => {
  jEq(drexSchedValidatePublishAt(NOW - 1, NOW), { ok: false, reason: 'past' });
  jEq(drexSchedValidatePublishAt(NOW + 60_000, NOW), { ok: false, reason: 'too-soon' });
  jEq(drexSchedValidatePublishAt(NOW + MIN_LEAD - 1, NOW), { ok: false, reason: 'too-soon' });
  assert.equal(drexSchedValidatePublishAt(NOW + MIN_LEAD + 1000, NOW).ok, true);
  assert.equal(drexSchedValidatePublishAt(NOW + MAX_AHEAD - 1000, NOW).ok, true);
  jEq(drexSchedValidatePublishAt(NOW + MAX_AHEAD + 1, NOW), { ok: false, reason: 'too-far' });
  jEq(drexSchedValidatePublishAt(NaN, NOW), { ok: false, reason: 'invalid' });
  jEq(drexSchedValidatePublishAt('mañana', NOW), { ok: false, reason: 'invalid' });
});

// 7. Contenido marcado por moderación: no se publica, se conserva como borrador.
test('flag de moderación conserva el borrador sin programar', async () => {
  const w = makeWorld({ drafts: [draftDue()], flagged: true });
  const res = await checkScheduledPosts(w.deps);
  assert.equal(w.published.length, 0);
  assert.equal(res.results[0].status, 'flagged');
  assert.equal(w.store.list.length, 1, 'no se pierde el contenido');
  assert.equal(w.store.list[0].publishAt, null, 'se quita la programación');
  assert.equal(w.notified.length, 1);
});

// 8. Fallo de publicación: el borrador se conserva (sin fecha), sin duplicar.
test('fallo de publicación conserva el borrador como normal', async () => {
  const w = makeWorld({ drafts: [draftDue()], publishBehavior: 'fail' });
  const res = await checkScheduledPosts(w.deps);
  assert.equal(res.results[0].status, 'failed');
  assert.equal(w.published.length, 1, 'se intentó una vez');
  assert.equal(w.store.list.length, 1);
  assert.equal(w.store.list[0].publishAt, null);
  assert.equal(w.store.list[0].scheduledPublishing, false);
  assert.equal(w.notified.length, 1);
});

// 9. Audiencias: private y following resuelven su alcance.
test('audiencia private/following en nota programada', async () => {
  const w1 = makeWorld({ drafts: [draftDue({ id: 'p1', audience: 'private' })] });
  await checkScheduledPosts(w1.deps);
  assert.equal(w1.published[0].audience.id, 'private');
  jEq(w1.published[0].audienceAllowedViewerIds, { u1: true });

  const w2 = makeWorld({ drafts: [draftDue({ id: 'f1', audience: 'following' })] });
  await checkScheduledPosts(w2.deps);
  assert.equal(w2.published[0].audience.id, 'following');
  jEq(w2.published[0].audienceAllowedViewerIds, { u1: true, u9: true });
});

// 10. Helpers de selección: due excluye en-vuelo y futuro; hasPending.
test('drexSchedDueDrafts y drexSchedHasPending', () => {
  const drafts = [
    { id: 'a', publishAt: NOW - 10 },
    { id: 'b', publishAt: NOW + 10_000 },
    { id: 'c', publishAt: NOW - 10, scheduledPublishing: true },
    { id: 'd' },
  ];
  jEq(drexSchedDueDrafts(drafts, NOW).map(d => d.id), ['a']);
  assert.equal(drexSchedHasPending(drafts), true);
  assert.equal(drexSchedHasPending([]), false);
  assert.equal(drexSchedHasPending([{ id: 'x', publishAt: NOW - 5, scheduledPublishing: true }]), false);
  assert.equal(drexSchedIsDue({ publishAt: NOW }, NOW), true, 'exactamente ahora = vencido');
});

// 11. Varios vencidos se publican todos, en orden.
test('varios vencidos se publican todos', async () => {
  const w = makeWorld({ drafts: [draftDue({ id: 'a' }), draftDue({ id: 'b' }), draftDue({ id: 'c', publishAt: NOW + 99999 })] });
  const res = await checkScheduledPosts(w.deps);
  assert.equal(res.due, 2);
  assert.equal(w.published.length, 2);
  assert.equal(w.store.list.length, 1);
  assert.equal(w.store.list[0].id, 'c');
});
