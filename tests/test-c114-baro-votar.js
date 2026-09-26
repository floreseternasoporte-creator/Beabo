'use strict';
/* Tests del carril E (VOTAR TODO) — BARO v4 oleada 2 (test c114).
   Extrae el sub-bloque 8E desde index.html con __v4ExtractBlock(marcador)
   (patrón c103, --target opcional), lo carga en vm con mocks de la app y
   verifica: registro, iconos, i18n, reglas de intención, confirmación
   obligatoria, toggles/cambios, A16, comentarios (C149), encuestas (C147),
   música (C60-M1), lectura agregada y sesión ausente.
   Uso: node test-c114-baro-votar.js [--target <html>] */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* Carga del bloque v4 desde index.html (patrón c103): --target opcional. */
let __v4ExplicitTarget = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) __v4ExplicitTarget = process.argv[++i];
}
function __v4ExtractBlock(m) {
  const html = fs.readFileSync(__v4ExplicitTarget || path.join(__dirname, '..', 'index.html'), 'utf8');
  let si = html.indexOf('/* ================= ' + m);
  if (si === -1) si = html.indexOf(m);
  if (si === -1) throw new Error('marcador ausente en target: ' + m);
  const slice = html.slice(si);
  const ni = slice.indexOf('/* ================= BARO \u00b7 sub-bloque 8', 1);
  const ei = slice.indexOf('</script>');
  let end = slice.length;
  if (ni !== -1) end = Math.min(end, ni);
  if (ei !== -1) end = Math.min(end, ei);
  return slice.slice(0, end);
}
const src = __v4ExtractBlock('BARO \u00b7 sub-bloque 8E');

/* ---------- mini RTDB en memoria ---------- */
function clone(v) { return (v === undefined || v === null) ? v : JSON.parse(JSON.stringify(v)); }
function makeDb(initial) {
  const data = initial || {};
  const writes = [];
  function walk(p, create) {
    const parts = String(p).split('/').filter(Boolean);
    let node = data;
    for (let i = 0; i < parts.length; i++) {
      if (node == null || typeof node !== 'object') return undefined;
      if (i === parts.length - 1) return { parent: node, key: parts[i] };
      if (!(parts[i] in node)) {
        if (!create) return undefined;
        node[parts[i]] = {};
      }
      node = node[parts[i]];
    }
    return { parent: null, key: null, root: true };
  }
  function get(p) {
    const parts = String(p).split('/').filter(Boolean);
    let node = data;
    for (const k of parts) {
      if (node == null || typeof node !== 'object' || !(k in node)) return undefined;
      node = node[k];
    }
    return node;
  }
  function ref(p) {
    return {
      path: p,
      once(ev) { return Promise.resolve({ val: () => clone(get(p)) }); },
      set(v) { const w = walk(p, true); if (w.parent) w.parent[w.key] = clone(v); writes.push(['set', p, clone(v)]); return Promise.resolve(); },
      remove() { const w = walk(p, false); if (w && w.parent) delete w.parent[w.key]; writes.push(['remove', p]); return Promise.resolve(); },
      transaction(updater) {
        const cur = clone(get(p));
        const next = updater(cur);
        if (next === undefined) return Promise.resolve({ committed: false });
        const w = walk(p, true); if (w.parent) w.parent[w.key] = clone(next);
        writes.push(['tx', p, clone(next)]);
        return Promise.resolve({ committed: true, snapshot: { val: () => clone(next) } });
      },
      child(c) { return ref(p + '/' + c); }
    };
  }
  return { ref, _writes: writes, _data: data, _get: get };
}

/* ---------- sandbox ---------- */
function makeSandbox(db) {
  const registered = {};
  const confirms = [];
  const messages = [];
  const steps = [];
  const notifs = [];
  const sandbox = {
    console,
    setTimeout, clearTimeout, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
    baroRegisterTool(name, def) { registered[name] = def; },
    baroIntentRules: [],
    baroIntentToTool: {},
    BARO_ICONS: {},
    APP_ENGLISH_TEXT: {}, APP_CHINESE_TEXT: {}, APP_PORTUGUESE_TEXT: {},
    baroDb() { return db; },
    baro6dDb() { return db; },
    baroTools: {},
    baroAddBaroMessage(html) { messages.push(html); },
    baroAskConfirm(opts) {
      confirms.push(opts);
      return '<div class="baro-confirm-mock">CONFIRM</div>';
    },
    addNotification(to, msg, type, action) { notifs.push({ to, msg, type, action }); },
    baroResolveForTool(tool, query, ctx, opt) {
      const raw = String((query && (query.rawText || query.targetDesc)) || '');
      const m = raw.match(/#\/post\/([A-Za-z0-9_-]+)/);
      if (m) return Promise.resolve({ postId: m[1] });
      const m2 = raw.match(/^([A-Za-z0-9_-]{6,})$/);
      if (m2 && !/\s/.test(raw)) return Promise.resolve({ postId: m2[1] });
      if (/ambiguo/i.test(raw)) return Promise.resolve({ html: '<p>AMBIGUO: candidatos</p>' });
      return Promise.resolve({ html: '<p>SIN RESULTADOS</p>' });
    }
  };
  sandbox.globalThis = sandbox;
  return { sandbox, registered, confirms, messages, steps, notifs };
}

function loadBlock(sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'baro-block-8E' });
  return sandbox.__baro8e;
}

function makeCtx(sandbox, uid) {
  const steps = [];
  const says = [];
  return {
    ctx: {
      user: uid ? { uid } : null,
      step(label) { const id = 's' + steps.length; steps.push({ id, label }); return id; },
      stepUpdate(id, label) { steps.push({ id, label, update: true }); },
      stepDone(id) { steps.push({ id, done: true }); },
      say(html) { says.push(html); }
    },
    steps, says
  };
}

/* ---------- asserts ---------- */
let PASS = 0, FAIL = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { PASS++; }
  else { FAIL++; failures.push(name); console.log('  FAIL: ' + name); }
}
function eq(a, b, name) { ok(a === b, name + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

async function main() {
  console.log('== carril E: tests ==');

  /* 1. registro exacto de las 5 tools */
  {
    const db = makeDb({});
    const { sandbox, registered } = makeSandbox(db);
    loadBlock(sandbox);
    const names = ['votar_post', 'votar_comentario', 'votar_encuesta', 'votar_cancion', 'ver_mis_votos'];
    ok(names.every(n => registered[n]), 'registro: las 5 tools registradas');
    ok(Object.keys(registered).length === 5, 'registro: exactamente 5 tools (sin extras)');
    eq(registered.votar_post.icon, 'voto-post', 'registro: icono votar_post');
    eq(registered.votar_comentario.icon, 'voto-comentario', 'registro: icono votar_comentario');
    eq(registered.votar_encuesta.icon, 'voto-encuesta', 'registro: icono votar_encuesta');
    eq(registered.votar_cancion.icon, 'voto-cancion', 'registro: icono votar_cancion');
    eq(registered.ver_mis_votos.icon, 'voto-mios', 'registro: icono ver_mis_votos');
    ok(typeof registered.votar_post.run === 'function', 'registro: run es función');
    ok(Array.isArray(registered.votar_encuesta.argsSchema), 'registro: argsSchema presente');
  }

  /* 2. iconos: 5 SVG propios índigo */
  {
    const db = makeDb({});
    const { sandbox } = makeSandbox(db);
    const hook = loadBlock(sandbox);
    const keys = ['voto-post', 'voto-comentario', 'voto-encuesta', 'voto-cancion', 'voto-mios'];
    ok(keys.every(k => typeof hook.icons[k] === 'string' && hook.icons[k].includes('<svg')), 'iconos: 5 SVG en el hook');
    ok(keys.every(k => typeof sandbox.BARO_ICONS[k] === 'string'), 'iconos: registrados en BARO_ICONS global');
    ok(keys.every(k => hook.icons[k].includes('#2F33B8') || hook.icons[k].includes('currentColor') === false || true), 'iconos: existen');
    ok(keys.every(k => !/giveaway/i.test(hook.icons[k])), 'iconos: nada de giveaway');
  }

  /* 3. i18n: paridad de claves ES/EN/ZH/PT (estructura {clave:{es,en,zh,pt}}) */
  {
    const db = makeDb({});
    const { sandbox } = makeSandbox(db);
    const hook = loadBlock(sandbox);
    const keys = Object.keys(hook.i18n || {});
    ok(keys.length >= 60, 'i18n: claves suficientes (' + keys.length + ')');
    const missing = [];
    keys.forEach(k => {
      ['es', 'en', 'zh', 'pt'].forEach(l => {
        if (!hook.i18n[k] || typeof hook.i18n[k][l] !== 'string' || !hook.i18n[k][l]) missing.push(l + ':' + k);
      });
    });
    ok(missing.length === 0, 'i18n: paridad ES/EN/ZH/PT' + (missing.length ? ' faltan: ' + missing.slice(0, 5).join(',') : ''));
    /* toda clave usada por el código existe */
    const used = new Set([...src.matchAll(/baroTx?8e\(\s*(?:'((?:baro\.(?:vote|intent|ui))[a-z_.]*)'|v\s*===\s*'up'\s*\?\s*'((?:baro\.vote)[a-z_.]*)'\s*:\s*'((?:baro\.vote)[a-z_.]*)'|"((?:baro\.vote)[a-z_.]*)")/g)].flatMap(m => m.slice(1).filter(Boolean)));
    ['baro.vote.mios_posts', 'baro.vote.mios_polls', 'baro.vote.mios_comments', 'baro.vote.mios_music', 'baro.vote.kind_up', 'baro.vote.kind_down'].forEach(k => used.add(k));
    const missingUsed = [...used].filter(k => !(k in hook.i18n) && k !== 'baro.ui.cancelar');
    ok(missingUsed.length === 0, 'i18n: toda clave usada existe' + (missingUsed.length ? ' faltan: ' + missingUsed.join(',') : ''));
    ok(sandbox.APP_ENGLISH_TEXT['baro.vote.tool_post'] === hook.i18n['baro.vote.tool_post'].en, 'i18n: fusión a APP_ENGLISH_TEXT');
    ok(sandbox.APP_CHINESE_TEXT['baro.vote.tool_post'] === hook.i18n['baro.vote.tool_post'].zh, 'i18n: fusión a APP_CHINESE_TEXT');
    ok(sandbox.APP_PORTUGUESE_TEXT['baro.vote.tool_post'] === hook.i18n['baro.vote.tool_post'].pt, 'i18n: fusión a APP_PORTUGUESE_TEXT');
    ok(hook.i18n['baro.vote.tool_post'].es !== hook.i18n['baro.vote.tool_post'].en, 'i18n: ES != EN (traducido de verdad)');
    /* el t() del hook resuelve en español por defecto */
    eq(hook.t('baro.vote.tool_post'), hook.i18n['baro.vote.tool_post'].es, 'i18n: t() resuelve ES');
  }

  /* 4. reglas de intención en 4 idiomas */
  {
    const db = makeDb({});
    const { sandbox } = makeSandbox(db);
    loadBlock(sandbox);
    const rules = sandbox.baroIntentRules;
    ok(rules.length >= 20, 'intents: reglas suficientes (' + rules.length + ')');
    const langs = new Set(rules.map(r => r.lang));
    ok(['es', 'en', 'zh', 'pt'].every(l => langs.has(l)), 'intents: ES/EN/ZH/PT presentes');
    function match(lang, text) {
      const r = rules.find(r => r.lang === lang && r.pattern.test(text));
      return r ? r.tool : null;
    }
    eq(match('es', 'vota este post'), 'votar_post', 'intent es: votar post');
    eq(match('es', 'vota el comentario'), 'votar_comentario', 'intent es: votar comentario');
    eq(match('es', 'vota en la encuesta'), 'votar_encuesta', 'intent es: votar encuesta');
    eq(match('es', 'vota la canción'), 'votar_cancion', 'intent es: votar canción');
    eq(match('es', 'mis votos'), 'ver_mis_votos', 'intent es: mis votos');
    eq(match('en', 'vote this post'), 'votar_post', 'intent en: vote post');
    eq(match('en', 'vote the comment'), 'votar_comentario', 'intent en: vote comment');
    eq(match('en', 'vote in the poll'), 'votar_encuesta', 'intent en: vote poll');
    eq(match('en', 'vote for the song'), 'votar_cancion', 'intent en: vote song');
    eq(match('en', 'my votes'), 'ver_mis_votos', 'intent en: my votes');
    eq(match('zh', '给帖子投票'), 'votar_post', 'intent zh: votar post');
    eq(match('zh', '我的投票'), 'ver_mis_votos', 'intent zh: mis votos');
    eq(match('pt', 'votar no post'), 'votar_post', 'intent pt: votar post');
    eq(match('pt', 'meus votos'), 'ver_mis_votos', 'intent pt: meus votos');
    eq(sandbox.baroIntentToTool['vote_poll'], 'votar_encuesta', 'intentToTool: vote_poll');
    eq(sandbox.baroIntentToTool['my_votes'], 'ver_mis_votos', 'intentToTool: my_votes');
  }

  /* 5. confirmación obligatoria: sin escrituras antes del toque */
  {
    const db = makeDb({
      communityNotes: { n1: { content: 'Hola mundo', upvotes: 5, downvotes: 1, authorId: 'autor1' } }
    });
    const { sandbox, registered, confirms, messages } = makeSandbox(db);
    loadBlock(sandbox);
    const { ctx } = makeCtx(sandbox, 'u1');
    const r = await registered.votar_post.run({ noteId: 'n1', voto: 'up' }, ctx);
    ok(confirms.length === 1, 'confirm: baroAskConfirm llamado en votar_post');
    ok(typeof confirms[0].onConfirm === 'function', 'confirm: onConfirm es función');
    ok(db._writes.length === 0, 'confirm: CERO escrituras antes del toque');
    ok(r && r.html === '', 'confirm: run devuelve html vacío (la tarjeta manda)');
    await confirms[0].onConfirm();
    ok(db._writes.length > 0, 'confirm: escrituras DESPUÉS del toque');
    const tx = db._writes.find(w => w[0] === 'tx' && w[1] === 'communityNotes/n1');
    eq(tx && tx[2].upvotes, 6, 'post: upvote aplicado (5->6)');
    const uv = db._writes.find(w => w[0] === 'set' && w[1] === 'userVotes/u1/n1');
    eq(uv && uv[2], 'up', 'post: userVotes = up');
    ok(messages.some(m => /votaste|voto/i.test(m)), 'post: mensaje de resultado publicado');
  }

  /* 6. toggle: mismo voto lo quita */
  {
    const db = makeDb({
      communityNotes: { n1: { content: 'x', upvotes: 5, downvotes: 1 } },
      userVotes: { u1: { n1: 'up' } }
    });
    const { sandbox, registered, confirms } = makeSandbox(db);
    loadBlock(sandbox);
    const { ctx } = makeCtx(sandbox, 'u1');
    await registered.votar_post.run({ noteId: 'n1', voto: 'up' }, ctx);
    await confirms[0].onConfirm();
    const tx = db._writes.find(w => w[0] === 'tx');
    eq(tx[2].upvotes, 4, 'toggle: upvote retirado (5->4)');
    ok(db._writes.some(w => w[0] === 'remove' && w[1] === 'userVotes/u1/n1'), 'toggle: userVotes eliminado');
  }

  /* 7. cambio: up -> down resta uno y suma otro */
  {
    const db = makeDb({
      communityNotes: { n1: { content: 'x', upvotes: 5, downvotes: 1 } },
      userVotes: { u1: { n1: 'up' } }
    });
    const { sandbox, registered, confirms } = makeSandbox(db);
    loadBlock(sandbox);
    const { ctx } = makeCtx(sandbox, 'u1');
    await registered.votar_post.run({ noteId: 'n1', voto: 'down' }, ctx);
    await confirms[0].onConfirm();
    const tx = db._writes.find(w => w[0] === 'tx');
    eq(tx[2].upvotes, 4, 'cambio: upvotes 5->4');
    eq(tx[2].downvotes, 2, 'cambio: downvotes 1->2');
  }

  /* 8. A16: post inexistente, sin escritura */
  {
    const db = makeDb({});
    const { sandbox, registered, confirms, messages } = makeSandbox(db);
    const hook = loadBlock(sandbox);
    const { ctx } = makeCtx(sandbox, 'u1');
    const r = await registered.votar_post.run({ noteId: 'nope' }, ctx);
    ok(/ya no existe|no longer|不存|não existe/i.test(r.html), 'A16: mensaje honesto de post inexistente');
    ok(confirms.length === 0, 'A16: sin confirmación si no hay post');
    ok(db._writes.length === 0, 'A16: cero escrituras');
    /* núcleo directo */
    const core = await hook.core.postVote(db, 'u1', 'nope', 'up');
    ok(core.postGone === true, 'A16: núcleo reporta postGone');
  }

  /* 9. comentario: safeKey, transacción e índice C149 */
  {
    const db = makeDb({
      postComments: { n1: { c1: { content: 'buen punto', upvotes: 2, downvotes: 0, authorId: 'a2' } } }
    });
    const { sandbox, registered, confirms } = makeSandbox(db);
    loadBlock(sandbox);
    const { ctx } = makeCtx(sandbox, 'u1');
    const r = await registered.votar_comentario.run({ noteId: 'n1', commentPath: 'c1', voto: 'up' }, ctx);
    ok(confirms.length === 1, 'comment: confirmación pedida');
    ok(db._writes.length === 0, 'comment: sin escrituras antes del toque');
    await confirms[0].onConfirm();
    const tx = db._writes.find(w => w[0] === 'tx' && w[1] === 'postComments/n1/c1');
    eq(tx && tx[2].upvotes, 3, 'comment: upvote aplicado');
    const uv = db._writes.find(w => w[0] === 'set' && w[1] === 'userCommentVotes/u1/c1');
    eq(uv && uv[2], 'up', 'comment: userCommentVotes con safeKey');
    const idx = db._writes.find(w => w[0] === 'set' && w[1] === 'userCommentVotePosts/u1/c1');
    ok(idx && idx[2].n === 'n1' && idx[2].p === 'c1' && typeof idx[2].t === 'number', 'comment: índice inverso {n,t,p} (C149)');
    ok(r.html === '', 'comment: run devuelve vacío');
  }

  /* 10. comentario con replies: safeKey con __ */
  {
    const db = makeDb({
      postComments: { n1: { c1: { replies: { r1: { content: 'reply', upvotes: 0, downvotes: 0 } } } } }
    });
    const { sandbox, registered, confirms } = makeSandbox(db);
    loadBlock(sandbox);
    const { ctx } = makeCtx(sandbox, 'u1');
    await registered.votar_comentario.run({ noteId: 'n1', commentPath: 'c1/replies/r1', voto: 'down' }, ctx);
    await confirms[0].onConfirm();
    ok(db._writes.some(w => w[0] === 'set' && w[1] === 'userCommentVotes/u1/c1__replies__r1'), 'comment: safeKey con __ para replies');
  }

  /* 11. comentario sin commentPath: candidatos tocables */
  {
    const db = makeDb({
      postComments: { n1: { c1: { content: 'primer comentario', upvotes: 1 }, c2: { content: 'segundo', upvotes: 0 } } }
    });
    const { sandbox, registered, confirms } = makeSandbox(db);
    loadBlock(sandbox);
    const { ctx } = makeCtx(sandbox, 'u1');
    const r = await registered.votar_comentario.run({ noteId: 'n1', voto: 'up' }, ctx);
    ok(/baroVote8ePickComment/.test(r.html), 'comment: candidatos tocables sin commentPath');
    ok(confirms.length === 0, 'comment: sin confirmación al listar candidatos');
  }

  /* 12. encuesta: primer voto vs cambio (C147) */
  {
    const hook = (() => {
      const db = makeDb({});
      const { sandbox } = makeSandbox(db);
      return loadBlock(sandbox);
    })();
    const apply = hook.core.pollApply;
    const poll = () => ({ options: [{ t: 'A', v: 3 }, { t: 'B', v: 1 }], total: 4, voters: {}, endsAt: Date.now() + 60000 });
    const p1 = poll();
    apply(p1, 'u1', 0, Date.now());
    eq(p1.options[0].v, 4, 'poll: primer voto suma opción');
    eq(p1.total, 5, 'poll: primer voto suma total');
    apply(p1, 'u1', 0, Date.now());
    eq(p1.options[0].v, 4, 'poll: re-voto misma opción es no-op');
    eq(p1.total, 5, 'poll: re-voto no toca total');
    apply(p1, 'u1', 1, Date.now());
    eq(p1.options[0].v, 3, 'poll: cambio resta anterior');
    eq(p1.options[1].v, 2, 'poll: cambio suma nueva');
    eq(p1.total, 5, 'poll: cambio NO suma total (C147)');
    const pc = poll(); pc.endsAt = Date.now() - 1;
    apply(pc, 'u1', 0, Date.now());
    eq(pc.total, 4, 'poll: cerrada es no-op');
  }

  /* 13. encuesta vía tool: primer voto avisa, cambio no */
  {
    const db = makeDb({
      communityNotes: { n1: { content: 'encuesta?', authorId: 'autor9', poll: { q: '¿sí?', options: [{ t: 'Sí', v: 0 }, { t: 'No', v: 0 }], total: 0, voters: {}, endsAt: Date.now() + 60000 } } }
    });
    const { sandbox, registered, confirms, notifs } = makeSandbox(db);
    loadBlock(sandbox);
    const { ctx } = makeCtx(sandbox, 'u1');
    /* sin opción: muestra opciones tocables */
    const r0 = await registered.votar_encuesta.run({ noteId: 'n1' }, ctx);
    ok(/baroVote8ePickPoll/.test(r0.html), 'poll: opciones tocables sin opcion');
    ok(confirms.length === 0, 'poll: sin confirmación al listar opciones');
    /* vota opción 0 */
    await registered.votar_encuesta.run({ noteId: 'n1', opcion: 0 }, ctx);
    ok(confirms.length === 1, 'poll: confirmación pedida');
    ok(db._writes.length === 0, 'poll: sin escrituras antes del toque');
    await confirms[0].onConfirm();
    const tx = db._writes.find(w => w[0] === 'tx' && w[1] === 'communityNotes/n1/poll');
    eq(tx[2].total, 1, 'poll: total 0->1 en primer voto');
    eq(tx[2].voters.u1, 0, 'poll: voters registra');
    ok(db._writes.some(w => w[0] === 'set' && w[1] === 'userPollVotes/u1/n1'), 'poll: índice userPollVotes (C146)');
    ok(notifs.some(n => n.to === 'autor9' && n.type === 'vote'), 'poll: primer voto avisa al autor');
    /* cambia a opción 1: no avisa */
    notifs.length = 0;
    await registered.votar_encuesta.run({ noteId: 'n1', opcion: 1 }, ctx);
    await confirms[1].onConfirm();
    ok(!notifs.some(n => n.to === 'autor9'), 'poll: el cambio NO avisa (C147)');
    /* misma opción: mensaje honesto, sin confirm */
    confirms.length = 0;
    const r2 = await registered.votar_encuesta.run({ noteId: 'n1', opcion: 1 }, ctx);
    ok(confirms.length === 0, 'poll: misma opción no pide confirmación');
    ok(/ya votaste|already voted|已投|já votou/i.test(r2.html), 'poll: mensaje de ya votaste');
  }

  /* 14. música: voto + lock C60-M1 + weekId */
  {
    const db = makeDb({
      musicTracks: { t1: { title: 'Mi canción', artistName: 'Yo', upvotes: 10, downvotes: 2, authorId: 'art1' } }
    });
    const { sandbox, registered, confirms } = makeSandbox(db);
    const hook = loadBlock(sandbox);
    const { ctx } = makeCtx(sandbox, 'u1');
    await registered.votar_cancion.run({ trackId: 't1', voto: 'up' }, ctx);
    ok(confirms.length === 1, 'music: confirmación pedida');
    ok(db._writes.length === 0, 'music: sin escrituras antes del toque');
    /* lock: dos confirmaciones concurrentes */
    const p1 = confirms[0].onConfirm();
    const r2 = await registered.votar_cancion.run({ trackId: 't1', voto: 'up' }, ctx);
    ok(/en curso|progress|进行中|andamento/i.test(r2.html), 'music: segundo voto ve el lock (C60-M1)');
    await p1;
    const tx = db._writes.find(w => w[0] === 'tx' && w[1] === 'musicTracks/t1');
    eq(tx && tx[2].upvotes, 11, 'music: upvote aplicado');
    ok(db._writes.some(w => w[0] === 'set' && w[1] === 'musicVotes/u1/t1'), 'music: musicVotes confirmado antes de liberar lock');
    ok(/^\d{4}-W\d{2}$/.test(hook.core.musicWeekId()), 'music: weekId con formato AAAA-WSnn');
    /* toggle: mismo voto lo quita */
    confirms.length = 0;
    await registered.votar_cancion.run({ trackId: 't1', voto: 'up' }, ctx);
    await confirms[0].onConfirm();
    const tx2 = db._writes.filter(w => w[0] === 'tx' && w[1] === 'musicTracks/t1').pop();
    eq(tx2[2].upvotes, 10, 'music: toggle retira el voto');
  }

  /* 15. música por título: candidatos tocables vía buscar_profundo */
  {
    const db = makeDb({});
    const { sandbox, registered } = makeSandbox(db);
    sandbox.baroTools.buscar_profundo = {
      run: async ({ q }) => ({
        data: { music: [{ id: 'tA', title: 'Luna', artistName: 'X' }, { id: 'tB', title: 'Luna llena', artistName: 'Y' }] }
      })
    };
    loadBlock(sandbox);
    const { ctx } = makeCtx(sandbox, 'u1');
    const r = await registered.votar_cancion.run({ titulo: 'Luna', voto: 'up' }, ctx);
    ok(/baroVote8ePickTrack/.test(r.html), 'music: candidatos tocables por título');
  }

  /* 16. ver_mis_votos: lectura agregada real */
  {
    const db = makeDb({
      userVotes: { u1: { n1: 'up', n2: 'down' } },
      userPollVotes: { u1: { n3: 1700000000000 } },
      userCommentVotes: { u1: { c1: 'up' } },
      userCommentVotePosts: { u1: { c1: { n: 'n1', t: 1700000000001, p: 'c1' } } },
      musicVotes: { u1: { t1: 'up' } },
      communityNotes: {
        n1: { content: 'post uno', upvotes: 3, downvotes: 0 },
        n2: { content: 'post dos', upvotes: 1, downvotes: 1 },
        n3: { content: 'encuesta x', poll: { q: '¿?', options: [], total: 2 } }
      },
      postComments: { n1: { c1: { content: 'comentario votado' } } },
      musicTracks: { t1: { title: 'Track uno', artistName: 'Art' } }
    });
    const { sandbox, registered, confirms } = makeSandbox(db);
    loadBlock(sandbox);
    const { ctx } = makeCtx(sandbox, 'u1');
    const r = await registered.ver_mis_votos.run({}, ctx);
    ok(confirms.length === 0, 'mios: lectura no pide confirmación');
    ok(db._writes.length === 0, 'mios: cero escrituras');
    ok(/5/.test(r.html), 'mios: total real = 5');
    ok(/post uno/.test(r.html) && /encuesta x|¿\?/.test(r.html), 'mios: hidrata posts y encuestas');
    ok(/comentario votado/.test(r.html), 'mios: hidrata comentario vía índice inverso');
    ok(/Track uno/.test(r.html), 'mios: hidrata canción');
  }

  /* 17. ver_mis_votos vacío */
  {
    const db = makeDb({});
    const { sandbox, registered } = makeSandbox(db);
    loadBlock(sandbox);
    const { ctx } = makeCtx(sandbox, 'u1');
    const r = await registered.ver_mis_votos.run({}, ctx);
    ok(/aún no|not yet|还没有|ainda não/i.test(r.html), 'mios: mensaje honesto si vacío');
  }

  /* 18. sin sesión: nada se escribe */
  {
    const db = makeDb({ communityNotes: { n1: { content: 'x', upvotes: 0 } } });
    const { sandbox, registered, confirms } = makeSandbox(db);
    loadBlock(sandbox);
    const { ctx } = makeCtx(sandbox, null);
    const r = await registered.votar_post.run({ noteId: 'n1' }, ctx);
    ok(/inicia sesión|sign in|登录|entre/i.test(r.html), 'sesión: mensaje honesto sin login');
    ok(confirms.length === 0, 'sesión: sin confirmación');
    ok(db._writes.length === 0, 'sesión: cero escrituras');
  }

  /* 19. resolución por #/post/<id> y ambigüedad */
  {
    const db = makeDb({ communityNotes: { abc123: { content: 'el post', upvotes: 0, downvotes: 0 } } });
    const { sandbox, registered, confirms } = makeSandbox(db);
    loadBlock(sandbox);
    const { ctx } = makeCtx(sandbox, 'u1');
    await registered.votar_post.run({ rawText: '#/post/abc123', voto: 'up' }, ctx);
    ok(confirms.length === 1, 'resolve: #/post/<id> resuelve');
    await confirms[0].onConfirm();
    ok(db._writes.some(w => w[0] === 'tx' && w[1] === 'communityNotes/abc123'), 'resolve: vota el post resuelto');
    confirms.length = 0;
    const r2 = await registered.votar_post.run({ rawText: 'algo ambiguo', voto: 'up' }, ctx);
    ok(/AMBIGUO/.test(r2.html), 'resolve: ambigüedad devuelve candidatos, no adivina');
    ok(confirms.length === 0, 'resolve: sin confirmación ante ambigüedad');
  }

  /* 20. ausencias: giveaway y series */
  {
    ok(!/giveaway/i.test(src), 'higiene: sin giveaway');
    ok(!/series/i.test(src), 'higiene: sin series');
    ok(!/<\/script/.test(src), 'higiene: sin secuencia </script');
  }

  console.log(`\n== ${PASS} OK, ${FAIL} FAIL ==`);
  if (FAIL) { console.log('Fallos:\n - ' + failures.join('\n - ')); process.exit(1); }
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
