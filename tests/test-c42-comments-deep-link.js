// CICLO 42 (C42-D1) — Gate de audiencia/bloqueos en la vista de comentarios.
//
// PoC del defecto original: openCommentsView(noteId) se abre por enlace
// profundo (ruta post/:id/comentarios) y por posts compartidos en el chat
// (openSharedPostFromChat) con CUALQUIER id, sin verificar audiencia ni
// bloqueos. openPostPermalink sí verifica audienceAllowedViewerIds +
// isAccountBlockedForCurrentUser y openGroupPostsView aplica
// shouldHideNoteForCurrentUser (C25): un post privado / solo-seguidores /
// de autor bloqueado se filtraba por el permalink pero se veía COMPLETO
// (post + comentarios) por la ruta de comentarios.
//
// El fix aplica shouldHideNoteForCurrentUser(noteId, note) (la misma
// política del feed) tras cargar la nota: falla cerrado con toast + cierre.
//
// Convención del repo: resuelve ../index.html con fallback a ../src/index.html;
// no depende del historial de git; sin rutas absolutas.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function findFile(names) {
  const cands = [];
  for (const n of names) {
    cands.push(path.join(__dirname, '..', n));
    cands.push(path.join(__dirname, '..', 'src', n));
  }
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('no encontrado: ' + names.join(' / '));
}
const html = fs.readFileSync(findFile(['index.html']), 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}

// Extrae "function NAME(...) {...}" balanceando llaves.
function extractFn(anchor) {
  const i = html.indexOf(anchor);
  if (i < 0) throw new Error('ancla no encontrada: ' + anchor);
  const j = html.indexOf('{', i);
  let depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}') { depth--; if (!depth) return html.slice(i, k + 1); }
  }
  throw new Error('sin cierre: ' + anchor);
}

const openCommentsSrc = extractFn('function openCommentsView(noteId)');
const hideFnSrc = extractFn('function shouldHideNoteForCurrentUser(noteId, note)');

// ---- 1. Estático: el gate está presente y es fail-closed --------------------
check('openCommentsView aplica shouldHideNoteForCurrentUser',
  openCommentsSrc.includes('shouldHideNoteForCurrentUser(noteId, note)'));
check('gate defensivo con typeof (no rompe si el helper falta)',
  /typeof shouldHideNoteForCurrentUser === 'function'/.test(openCommentsSrc));
check('gate ANTES del render de la tarjeta (buildDrexPostCardHTML)',
  openCommentsSrc.indexOf('shouldHideNoteForCurrentUser(noteId, note)') < openCommentsSrc.indexOf('buildDrexPostCardHTML(note'));
check('gate falla cerrado: toast + closeCommentsView + return',
  /shouldHideNoteForCurrentUser\(noteId, note\)\)\s*\{\s*showMiniToast\(appT\('Esta publicación no está disponible\.'\)\);\s*closeCommentsView\(\);\s*return;/.test(openCommentsSrc));
check('la clave del toast existe en los diccionarios i18n',
  /['"]Esta publicación no está disponible\.['"]/.test(
    fs.readFileSync(findFile(['drex-i18n.js']), 'utf8')));

// ---- 2. Funcional: el gate discrimina ----------------------------------------
function makeEl() {
  return {
    innerHTML: '', textContent: '', scrollTop: 0, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [],
    contains: () => false, focus: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
  };
}

async function runScenario(note, viewerUid, blockedAuthorIds) {
  const els = {};
  const calls = { toast: [], closed: 0 };
  const doc = {
    getElementById: (id) => (els[id] = els[id] || makeEl()),
    activeElement: null, body: makeEl(), createElement: () => makeEl(),
  };
  const sandbox = {
    console,
    document: doc,
    DrexCloud: {
      auth: () => ({ currentUser: viewerUid ? { uid: viewerUid } : null }),
      database: () => ({
        ref: (p) => ({
          once: () => Promise.resolve(
            p === 'communityNotes/' + note.key
              ? { exists: () => true, val: () => ({ ...note.val }) }
              : { exists: () => false, val: () => null }),
        }),
      }),
    },
    drexRecTrainById: () => {},
    _commentsPrevFocus: null,
    commentsOriginView: 'main',
    currentPostId: null,
    currentPostAuthorId: null,
    currentPostStoredCommentsCount: null,
    drexPushDynamicRoute: () => {},
    setBottomNavVisibility: () => {},
    showMiniToast: (m) => calls.toast.push(String(m)),
    appT: (s) => s,
    getVerificationIconByAuthor: () => '',
    buildDrexPostCardHTML: (n) => `<div>TARJETA:${n.content || ''}</div>`,
    escapeHtml: (s) => String(s == null ? '' : s),
    _enhancePostCard: () => {},
    hydrateQuickFollowButtons: () => {},
    loadCommentsInView: () => {},
    closeCommentsView: () => { calls.closed++; sandbox.currentPostId = null; },
    getHiddenPosts: () => [],
    _drexSensitiveFilterSession: null, // global del filtro parental "Contenido fuerte" (C81)
    getAdultContentPreference: () => true,
    isAdultContentNote: () => false,
    isAccountBlockedForCurrentUser: (id) => (blockedAuthorIds || []).includes(id),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(hideFnSrc, sandbox);
  vm.runInContext(openCommentsSrc, sandbox);
  await vm.runInContext(`openCommentsView(${JSON.stringify(note.key)})`, sandbox);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  const rendered = (els['original-post'] && els['original-post'].innerHTML) || '';
  return { rendered: rendered.includes('SECRETO'), toast: calls.toast, closed: calls.closed };
}

const followingNote = {
  key: 'post-following-1',
  val: {
    authorId: 'author-uid', authorName: 'Víctima', content: 'SECRETO',
    audience: { id: 'following' }, audienceAllowedViewerIds: { 'author-uid': true },
    commentsCount: 1, upvotes: 0, downvotes: 0,
  },
};
const publicNote = {
  key: 'post-public-1',
  val: { authorId: 'author-uid', authorName: 'Víctima', content: 'SECRETO', commentsCount: 0, upvotes: 0, downvotes: 0 },
};

(async () => {
  // 1) Post solo-seguidores, visor NO seguidor -> bloqueado
  {
    const r = await runScenario(followingNote, 'viewer-uid', []);
    check('following ajeno: NO se renderiza', !r.rendered);
    check('following ajeno: toast de no disponible', r.toast.some((t) => t.includes('no está disponible')));
    check('following ajeno: la vista se cierra', r.closed >= 1);
  }
  // 2) Post público -> se renderiza normal
  {
    const r = await runScenario(publicNote, 'viewer-uid', []);
    check('post público: se renderiza', r.rendered);
    check('post público: sin cierre', r.closed === 0);
  }
  // 3) Autor bloqueado -> bloqueado aunque el post sea público
  {
    const r = await runScenario(publicNote, 'viewer-uid', ['author-uid']);
    check('autor bloqueado: NO se renderiza', !r.rendered);
    check('autor bloqueado: la vista se cierra', r.closed >= 1);
  }
  // 4) El propio autor SÍ ve su post privado
  {
    const r = await runScenario(followingNote, 'author-uid', []);
    check('autor propio: se renderiza su post following', r.rendered);
  }
  // 5) Post privado (audience.id=private), otro usuario -> bloqueado
  {
    const n = { key: 'post-private-1', val: { ...followingNote.val, audience: { id: 'private' } } };
    const r = await runScenario(n, 'viewer-uid', []);
    check('post privado: NO se renderiza para terceros', !r.rendered);
  }

  console.log(failures ? `\n${failures} FALLAS` : '\nTODOS OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e && e.stack || e); process.exit(1); });
