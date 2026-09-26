'use strict';
// Tests del carril 8F (OLEADA 3 — POSTS PROPIOS) de BARO v4: 3 herramientas.
// Cubre: registro (baroRegisterTool/BARO_ICONS/baroIntentRules/baroIntentToTool),
// intents ES/EN/ZH/PT (extract puros), i18n en 4 idiomas, confirmacion
// obligatoria en editar/fijar/desfijar (+ regla de maximo 3 fijados y
// verificacion de autoria), moderacion antes de editar, mensaje honesto sin
// sesion con cero escrituras, resolucion del objetivo por targetDesc (Baro
// nunca pide enlaces) y ausencia del literal de cierre de script en el bloque.
// El bloque se EXTRAE de index.html (patron oleada 1 / c103-c110), no del
// archivo del carril: marcador 'BARO · sub-bloque 8F'.
// Uso: node test-c115-baro-posts-propios.js [--target <ruta-a-index.html>]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* Carga del bloque v4 desde index.html (patron oleada 1): --target opcional. */
let __v4ExplicitTarget = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) __v4ExplicitTarget = process.argv[++i];
}
function __v4ExtractBlock(m) {
  const html = fs.readFileSync(__v4ExplicitTarget || path.join(__dirname, '..', 'index.html'), 'utf8');
  const START = '/* ================= ' + m;
  let si = html.indexOf(START);
  if (si === -1) si = html.indexOf(m);
  assert(si !== -1, 'marcador ausente en el target');
  const slice = html.slice(si);
  const ni = slice.indexOf('/* ================= BARO · sub-bloque 8', 1);
  const ei = slice.indexOf('</scr' + 'ipt>');
  let end = slice.length;
  if (ni !== -1) end = Math.min(end, ni);
  if (ei !== -1) end = Math.min(end, ei);
  return slice.slice(0, end);
}
const src = __v4ExtractBlock('BARO · sub-bloque 8F');

let fails = 0, oks = 0;
const CASES = [];
function tcase(name, fn) { CASES.push([name, fn]); }
function assert(cond, label) { if (!cond) throw new Error('assert: ' + label); }
function eqJ(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(label + ' esperado=' + e + ' actual=' + a);
}

/* ---------- 0. el bloque no trae el literal de cierre de script ---------- */
tcase('bloque sin literal de cierre de script', () => {
  assert(src.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en el bloque extraido (8F)');
  const tsrc = fs.readFileSync(__filename, 'utf8');
  assert(tsrc.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en test-c115-baro-posts-propios.js');
});

/* ---------- stubs de plataforma + carga del bloque en sandbox (vm) ---------- */
const registered = {};
const said = [];
const confirmCalls = [];
const resolveCalls = [];
const __fModule = { exports: {} };
const sandbox = {
  console,
  Buffer,
  module: __fModule,
  APP_ENGLISH_TEXT: {},
  APP_CHINESE_TEXT: {},
  APP_PORTUGUESE_TEXT: {},
  baroRegisterTool: function (name, def) { registered[name] = def; },
  BARO_ICONS: {},
  baroIntentRules: [],
  baroIntentToTool: {},
  baroAddBaroMessage: function (html) { said.push(String(html)); },
  baroAskConfirm: function (opts) { confirmCalls.push(opts); return {}; },
  /* Resolucion C102 simulada: devuelve el post semilla n1 por targetDesc. */
  baroResolveForTool: async function (toolName, args, ctx, opts) {
    resolveCalls.push({ toolName: toolName, targetDesc: args && args.targetDesc, opts: opts });
    return { postId: 'n1' };
  },
  evaluateContentModeration: function () { return { flagged: false }; }
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'block-lane-8f.js' });
const M = __fModule.exports;
assert(M && M.pure && M.tools && M.BARO_I18N_F && M.BARO_F_RULES,
  'el bloque extraido no exporto pure/tools/i18n/reglas (module.exports)');

// Fake RTDB con rutas anidadas (como la real): get/set/del por segmentos.
function makeStore(seed) {
  const root = (seed && typeof seed === 'object') ? seed : {};
  function parts(p) { return String(p == null ? '' : p).split('/').filter((x) => x !== ''); }
  function get(p) {
    let node = root;
    for (const part of parts(p)) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[part];
    }
    return node;
  }
  function set(p, v) {
    const ps = parts(p);
    let node = root;
    for (let i = 0; i < ps.length - 1; i++) {
      if (node[ps[i]] == null || typeof node[ps[i]] !== 'object') node[ps[i]] = {};
      node = node[ps[i]];
    }
    if (ps.length) node[ps[ps.length - 1]] = v;
  }
  function del(p) {
    const ps = parts(p);
    let node = root;
    for (let i = 0; i < ps.length - 1; i++) {
      if (node == null || typeof node[ps[i]] !== 'object') return;
      node = node[ps[i]];
    }
    if (node && ps.length) delete node[ps[ps.length - 1]];
  }
  function snapOf(p) {
    const v = get(p);
    const ex = v !== null && v !== undefined;
    return { exists: () => ex, val: () => (ex ? v : null) };
  }
  return {
    _root: root,
    _get: get,
    ref(p) {
      const base = String(p == null ? '' : p);
      return {
        once: async () => snapOf(base),
        set: async (v) => { set(base, v); },
        remove: async () => { del(base); },
        update: async (map) => {
          Object.keys(map).forEach((k) => {
            if (map[k] === null || map[k] === undefined) del(k);
            else set(k, map[k]);
          });
        }
      };
    }
  };
}
function setPlatform(seed) {
  said.length = 0;
  confirmCalls.length = 0;
  resolveCalls.length = 0;
  const fake = makeStore(seed);
  sandbox.DrexCloud = { database: () => fake };
  sandbox.evaluateContentModeration = function () { return { flagged: false }; };
  sandbox.baroResolveForTool = async function (toolName, args, ctx, opts) {
    resolveCalls.push({ toolName: toolName, targetDesc: args && args.targetDesc, opts: opts });
    return { postId: 'n1' };
  };
  return fake;
}
let stepSeq = 0;
function makeCtx(uid) {
  return {
    user: uid ? { uid } : null,
    t: (k) => k,
    step: (l) => 's' + (++stepSeq),
    stepDone: () => {},
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  };
}
function seedNote(authorId, extra) {
  const n = { authorId: authorId, content: 'texto viejo', timestamp: 100 };
  if (extra) Object.keys(extra).forEach((k) => { n[k] = extra[k]; });
  return { communityNotes: { n1: n }, users: { me: { username: 'yo' } } };
}

const P = M.pure, T = M.tools;

/* ---------- 1. registro ---------- */
const TOOL_NAMES = ['post_editar', 'post_fijar', 'post_desfijar'];

tcase('registro: 3 herramientas con label i18n y run', () => {
  TOOL_NAMES.forEach((n) => {
    assert(registered[n], 'no registrada: ' + n);
    assert(typeof registered[n].run === 'function', 'run no es funcion: ' + n);
    assert(M.BARO_I18N_F[registered[n].label], 'label sin i18n: ' + n);
  });
  eqJ(Object.keys(registered).sort(), TOOL_NAMES.slice().sort(), 'nombres registrados');
});
tcase('registro: BARO_ICONS con 3 svg propios', () => {
  const want = ['post-editar', 'post-fijar', 'post-desfijar'];
  want.forEach((k) => {
    const svg = sandbox.BARO_ICONS[k];
    assert(typeof svg === 'string' && svg.indexOf('<svg') === 0, 'icono ausente/invalido: ' + k);
    assert(svg.indexOf('currentColor') !== -1, 'icono sin currentColor: ' + k);
  });
});
tcase('registro: 3 reglas en baroIntentRules + mapa intent->tool', () => {
  assert(sandbox.baroIntentRules.length === 3, 'reglas: ' + sandbox.baroIntentRules.length);
  sandbox.baroIntentRules.forEach((r) => {
    eqJ(r.langs, ['es', 'en', 'zh', 'pt'], 'langs de ' + r.intent);
    assert(Array.isArray(r.patterns) && r.patterns.length > 0, 'patterns vacios: ' + r.intent);
    // Nota: instanceof RegExp falla entre reinos (vm); se usa toString (patron c110).
    r.patterns.forEach((p) => assert(Object.prototype.toString.call(p) === '[object RegExp]', 'pattern no RegExp en ' + r.intent));
    assert(typeof r.extract === 'function', 'extract no es funcion: ' + r.intent);
    assert(typeof r.intent === 'string' && r.intent.indexOf('post_') === 0, 'intent raro: ' + r.intent);
  });
  TOOL_NAMES.forEach((n) => assert(sandbox.baroIntentToTool[n] === n, 'mapa sin ' + n));
});
tcase('BARO_F_RULES exportadas coinciden con lo registrado', () => {
  eqJ(M.BARO_F_RULES.map((r) => r.intent).sort(), TOOL_NAMES.slice().sort(), 'intents de reglas');
});

/* ---------- 2. i18n 4 idiomas ---------- */
tcase('i18n: toda clave tiene es/en/zh/pt no vacios y prefijo baro.tool.post.', () => {
  const keys = Object.keys(M.BARO_I18N_F);
  assert(keys.length > 30, 'pocas claves: ' + keys.length);
  keys.forEach((k) => {
    assert(k.indexOf('baro.tool.post.') === 0, 'clave sin prefijo: ' + k);
    const e = M.BARO_I18N_F[k];
    ['es', 'en', 'zh', 'pt'].forEach((l) => {
      assert(e && typeof e[l] === 'string' && e[l].trim().length > 0, k + ' sin ' + l);
    });
  });
});
tcase('i18n: traducciones difieren del ES en puntos clave', () => {
  const e = M.BARO_I18N_F['baro.tool.post.editar.label'];
  assert(e.en !== e.es && e.zh !== e.es && e.pt !== e.es, 'label editar sin traducir');
  const f = M.BARO_I18N_F['baro.tool.post.fijar.ok'];
  assert(f.en !== f.es && f.zh !== f.es && f.pt !== f.es, 'fijar.ok sin traducir');
  const d = M.BARO_I18N_F['baro.tool.post.desfijar.ok'];
  assert(d.en !== d.es && d.zh !== d.es, 'desfijar.ok sin traducir');
});
tcase('i18n: fusiono en los textos de la app (EN/ZH/PT)', () => {
  assert(sandbox.APP_ENGLISH_TEXT['baro.tool.post.editar.ok'], 'sin fusion EN');
  assert(sandbox.APP_CHINESE_TEXT['baro.tool.post.fijar.ok'], 'sin fusion ZH');
  assert(sandbox.APP_PORTUGUESE_TEXT['baro.tool.post.desfijar.ok'], 'sin fusion PT');
});

/* ---------- 3. intents / extract puros ---------- */
tcase('extract editar ES/EN/ZH/PT', () => {
  const es = P.baroFExtractEditar('edita mi post del partido y pon "vamos equipo"');
  eqJ(es.nuevoTexto, 'vamos equipo', 'ES texto');
  eqJ(es.targetDesc, 'partido', 'ES desc');
  const en = P.baroFExtractEditar('edit my post about the game to: great match');
  eqJ(en.nuevoTexto, 'great match', 'EN texto');
  eqJ(en.targetDesc, 'the game', 'EN desc');
  const zh = P.baroFExtractEditar('把关于比赛的帖子改成"比赛很精彩"');
  eqJ(zh.nuevoTexto, '比赛很精彩', 'ZH texto');
  eqJ(zh.targetDesc, '关于比赛', 'ZH desc');
  const pt = P.baroFExtractEditar('edita minha publicação do jogo para: vamos time');
  eqJ(pt.nuevoTexto, 'vamos time', 'PT texto');
  eqJ(pt.targetDesc, 'jogo', 'PT desc');
});
tcase('extract editar: sin texto -> ambiguo; declina fijar/chat', () => {
  const amb = P.baroFExtractEditar('edita mi post del partido');
  assert(amb && amb.ambiguous === true && amb.reason === 'missing_text', 'debió ser ambiguo');
  assert(P.baroFExtractEditar('fija mi publicación') === null, 'editar robó "fija"');
  assert(P.baroFExtractEditar('pin my post') === null, 'editar robó "pin"');
  assert(P.baroFExtractEditar('desfija mi publicación') === null, 'editar robó "desfija"');
  assert(P.baroFExtractEditar('edita el mensaje que me envió Ana') === null, 'editar robó chat');
});
tcase('extract fijar ES/EN/ZH/PT', () => {
  eqJ(P.baroFExtractFijar('fija mi publicación del concierto en mi perfil').targetDesc, 'concierto', 'ES');
  eqJ(P.baroFExtractFijar('pin my post about the game').targetDesc, 'the game', 'EN');
  eqJ(P.baroFExtractFijar('把这条帖子置顶').targetDesc, '这条', 'ZH');
  eqJ(P.baroFExtractFijar('fixa minha publicação do jogo').targetDesc, 'jogo', 'PT');
});
tcase('extract fijar: declina editar/desfijar/chat', () => {
  assert(P.baroFExtractFijar('edita mi post y pon "hola"') === null, 'fijar robó "edita"');
  assert(P.baroFExtractFijar('desfija mi publicación') === null, 'fijar robó "desfija"');
  assert(P.baroFExtractFijar('unpin my post') === null, 'fijar robó "unpin"');
  assert(P.baroFExtractFijar('fija este mensaje') === null, 'fijar robó chat');
});
tcase('extract desfijar ES/EN/ZH/PT', () => {
  eqJ(P.baroFExtractDesfijar('desfija mi publicación del perfil').targetDesc, 'perfil', 'ES');
  eqJ(P.baroFExtractDesfijar('unpin my post').targetDesc, '', 'EN sin desc');
  eqJ(P.baroFExtractDesfijar('取消置顶这条帖子').targetDesc, '这条', 'ZH');
  eqJ(P.baroFExtractDesfijar('desafixa minha publicação').targetDesc, '', 'PT sin desc');
});
tcase('extract desfijar: declina editar/chat', () => {
  assert(P.baroFExtractDesfijar('edita mi post y pon "hola"') === null, 'desfijar robó "edita"');
  assert(P.baroFExtractDesfijar('desfija ese mensaje del chat') === null, 'desfijar robó chat');
});

/* ---------- 4. utilidades puras ---------- */
tcase('puras: norm, clip, featured-norm y contexto chat/post', () => {
  eqJ(P.baroFNorm('Publicación Édita FÍJALO'), 'publicacion edita fijalo', 'norm');
  eqJ(P.baroFFeatNorm({ n1: 123, bad: 'x', n2: 0, n3: -5 }), { n1: 123 }, 'featNorm filtra');
  eqJ(P.baroFFeatNorm(null), {}, 'featNorm null');
  assert(P.baroFIsChat('edita el mensaje que me envió Ana') === true, 'isChat ES');
  assert(P.baroFIsChat('edita mi publicación') === false, 'isChat falso positivo');
  assert(P.baroFPostCtx('fija mi publicación en mi perfil') === true, 'postCtx');
});

/* ---------- 5. editar: confirmacion obligatoria + escritura real ---------- */
tcase('editar: pide confirmacion y al confirmar escribe (resolucion por targetDesc)', async () => {
  const fake = setPlatform(seedNote('me'));
  const res = await T.post_editar({ targetDesc: 'el del partido', nuevoTexto: 'texto nuevo' }, makeCtx('me'));
  assert(confirmCalls.length === 1, 'sin tarjeta de confirmacion');
  assert(String(confirmCalls[0].titleKey).indexOf('Editar') !== -1, 'titulo raro: ' + confirmCalls[0].titleKey);
  assert(String(confirmCalls[0].previewHtml).indexOf('texto nuevo') !== -1, 'preview sin texto nuevo');
  assert(String(confirmCalls[0].previewHtml).indexOf('texto viejo') !== -1, 'preview sin texto anterior');
  assert(String(res.html).indexOf('Revisa') !== -1, 'debió devolver texto revisar: ' + res.html);
  assert(resolveCalls.length === 1, 'no resolvió el objetivo');
  eqJ(resolveCalls[0].targetDesc, 'el del partido', 'resolvió con otra descripcion');
  eqJ(resolveCalls[0].toolName, 'post_editar', 'toolName de resolucion');
  assert(fake._get('communityNotes/n1/content') === 'texto viejo', 'escribió antes de confirmar');
  await confirmCalls[0].onConfirm();
  assert(fake._get('communityNotes/n1/content') === 'texto nuevo', 'no escribió al confirmar');
  assert(said.some((m) => m.indexOf('Publicación actualizada.') !== -1), 'mensaje ok ausente: ' + JSON.stringify(said));
});
tcase('editar: postId directo salta la resolucion', async () => {
  const fake = setPlatform(seedNote('me'));
  await T.post_editar({ postId: 'n1', nuevoTexto: 'directo' }, makeCtx('me'));
  assert(resolveCalls.length === 0, 'resolvió con postId válido');
  assert(confirmCalls.length === 1, 'sin confirmacion con postId');
  await confirmCalls[0].onConfirm();
  assert(fake._get('communityNotes/n1/content') === 'directo', 'no escribió con postId');
});
tcase('editar: mismo texto / moderacion / ajeno -> honesto sin confirmar', async () => {
  setPlatform(seedNote('me'));
  const r1 = await T.post_editar({ targetDesc: 'x', nuevoTexto: 'texto viejo' }, makeCtx('me'));
  assert(String(r1.html).indexOf('El texto nuevo es igual al actual') !== -1, 'sin_cambios ausente');
  assert(confirmCalls.length === 0, 'confirmó sin cambios');
  const fake2 = setPlatform(seedNote('me'));
  sandbox.evaluateContentModeration = function () { return { flagged: true }; };
  const r2 = await T.post_editar({ targetDesc: 'x', nuevoTexto: 'texto malo' }, makeCtx('me'));
  assert(String(r2.html).indexOf('contenido inapropiado') !== -1, 'moderacion ausente');
  assert(confirmCalls.length === 0, 'confirmó con texto moderado');
  assert(fake2._get('communityNotes/n1/content') === 'texto viejo', 'escribió texto moderado');
  const fake3 = setPlatform(seedNote('other'));
  const before = JSON.stringify(fake3._root);
  const r3 = await T.post_editar({ targetDesc: 'x', nuevoTexto: 'hack' }, makeCtx('me'));
  assert(String(r3.html).indexOf('Solo puedes hacerlo con tus propias publicaciones') !== -1, 'not_owner ausente');
  assert(confirmCalls.length === 0, 'confirmó post ajeno');
  assert(JSON.stringify(fake3._root) === before, 'hubo escrituras en post ajeno');
});
tcase('editar: sin texto / resolucion caida -> honesto, cero escrituras', async () => {
  const fake = setPlatform(seedNote('me'));
  const before = JSON.stringify(fake._root);
  const r1 = await T.post_editar({ targetDesc: 'x', nuevoTexto: '   ' }, makeCtx('me'));
  assert(String(r1.html).indexOf('Dime el texto nuevo') !== -1, 'sin_texto ausente');
  assert(confirmCalls.length === 0, 'confirmó sin texto');
  sandbox.baroResolveForTool = async function () { return null; };
  const r2 = await T.post_editar({ targetDesc: 'x', nuevoTexto: 'y' }, makeCtx('me'));
  assert(String(r2.html).indexOf('No pude buscar tu publicación') !== -1, 'resolve_unavailable ausente');
  assert(confirmCalls.length === 0, 'confirmó sin resolver');
  assert(JSON.stringify(fake._root) === before, 'hubo escrituras');
});
tcase('editar: respeta el campo text cuando no hay content (espejo saveEditedPost)', async () => {
  const fake = setPlatform(seedNote('me', { content: undefined, text: 'viejo text' }));
  delete fake._root.communityNotes.n1.content;
  await T.post_editar({ targetDesc: 'x', nuevoTexto: 'nuevo text' }, makeCtx('me'));
  assert(confirmCalls.length === 1, 'sin confirmacion');
  await confirmCalls[0].onConfirm();
  assert(fake._get('communityNotes/n1/text') === 'nuevo text', 'no escribió en /text');
  assert(fake._get('communityNotes/n1/content') === undefined, 'creó /content indebido');
});

/* ---------- 6. fijar: confirmacion + maximo 3 ---------- */
tcase('fijar: confirma y guarda Date.now() en users/<uid>/featuredPosts', async () => {
  const fake = setPlatform(seedNote('me'));
  const res = await T.post_fijar({ targetDesc: 'el del concierto' }, makeCtx('me'));
  assert(confirmCalls.length === 1, 'sin tarjeta de confirmacion');
  assert(String(confirmCalls[0].previewHtml).indexOf('quedará fijada arriba de tu perfil (1/3)') !== -1, 'preview sin conteo: ' + confirmCalls[0].previewHtml);
  assert(String(res.html).indexOf('Revisa') !== -1, 'debió devolver texto revisar');
  eqJ(resolveCalls[0].targetDesc, 'el del concierto', 'resolvió con otra descripcion');
  assert(fake._get('users/me/featuredPosts/n1') === undefined, 'escribió antes de confirmar');
  const t0 = Date.now();
  await confirmCalls[0].onConfirm();
  const ts = fake._get('users/me/featuredPosts/n1');
  assert(typeof ts === 'number' && ts >= t0, 'timestamp malo: ' + ts);
  assert(said.some((m) => m.indexOf('Publicación fijada en tu perfil.') !== -1), 'mensaje ok ausente');
});
tcase('fijar: ya fijada / tope 3 / ajena -> honesto sin confirmar', async () => {
  const s1 = seedNote('me');
  s1.users.me.featuredPosts = { n1: 111 };
  setPlatform(s1);
  const r1 = await T.post_fijar({ targetDesc: 'x' }, makeCtx('me'));
  assert(String(r1.html).indexOf('Esa publicación ya está fijada en tu perfil.') !== -1, 'ya ausente');
  assert(confirmCalls.length === 0, 'confirmó ya fijada');
  const s2 = seedNote('me');
  s2.users.me.featuredPosts = { a: 1, b: 2, c: 3 };
  s2.communityNotes.n2 = { authorId: 'me', content: 'otra' };
  setPlatform(s2);
  sandbox.baroResolveForTool = async function () { return { postId: 'n2' }; };
  const r2 = await T.post_fijar({ targetDesc: 'x' }, makeCtx('me'));
  assert(String(r2.html).indexOf('Ya tienes 3 publicaciones fijadas.') !== -1, 'lleno ausente: ' + r2.html);
  assert(confirmCalls.length === 0, 'confirmó con tope lleno');
  const fake3 = setPlatform(seedNote('other'));
  const before = JSON.stringify(fake3._root);
  const r3 = await T.post_fijar({ targetDesc: 'x' }, makeCtx('me'));
  assert(String(r3.html).indexOf('Solo puedes hacerlo con tus propias publicaciones') !== -1, 'not_owner ausente');
  assert(confirmCalls.length === 0, 'confirmó post ajeno');
  assert(JSON.stringify(fake3._root) === before, 'hubo escrituras en post ajeno');
});

/* ---------- 7. desfijar: confirmacion + borrado real ---------- */
tcase('desfijar: confirma y elimina de users/<uid>/featuredPosts', async () => {
  const s = seedNote('me');
  s.users.me.featuredPosts = { n1: 111, n2: 222 };
  const fake = setPlatform(s);
  const res = await T.post_desfijar({ targetDesc: 'la del perfil' }, makeCtx('me'));
  assert(confirmCalls.length === 1, 'sin tarjeta de confirmacion');
  assert(String(res.html).indexOf('Revisa') !== -1, 'debió devolver texto revisar');
  assert(fake._get('users/me/featuredPosts/n1') === 111, 'borró antes de confirmar');
  await confirmCalls[0].onConfirm();
  assert(fake._get('users/me/featuredPosts/n1') === undefined, 'no borró al confirmar');
  assert(fake._get('users/me/featuredPosts/n2') === 222, 'borró otra fijada');
  assert(said.some((m) => m.indexOf('Publicación desfijada de tu perfil.') !== -1), 'mensaje ok ausente');
});
tcase('desfijar: no fijada / ajena -> honesto sin confirmar', async () => {
  setPlatform(seedNote('me'));
  const r1 = await T.post_desfijar({ targetDesc: 'x' }, makeCtx('me'));
  assert(String(r1.html).indexOf('no está fijada en tu perfil') !== -1, 'no ausente: ' + r1.html);
  assert(confirmCalls.length === 0, 'confirmó no fijada');
  const fake2 = setPlatform(seedNote('other'));
  const before = JSON.stringify(fake2._root);
  const r2 = await T.post_desfijar({ targetDesc: 'x' }, makeCtx('me'));
  assert(String(r2.html).indexOf('Solo puedes hacerlo con tus propias publicaciones') !== -1, 'not_owner ausente');
  assert(confirmCalls.length === 0, 'confirmó post ajeno');
  assert(JSON.stringify(fake2._root) === before, 'hubo escrituras en post ajeno');
});

/* ---------- 8. sin sesion: honesto, cero escrituras ---------- */
tcase('sin sesion: mensaje honesto y cero escrituras en las 3', async () => {
  const fake = setPlatform(seedNote('me'));
  const before = JSON.stringify(fake._root);
  const calls = [
    ['post_editar', { targetDesc: 'x', nuevoTexto: 'y' }],
    ['post_fijar', { targetDesc: 'x' }],
    ['post_desfijar', { targetDesc: 'x' }]
  ];
  for (const [name, args] of calls) {
    const r = await T[name](args, makeCtx(null));
    assert(String(r.html).indexOf('Inicia sesión') !== -1, name + ' sin need_login: ' + r.html);
  }
  assert(confirmCalls.length === 0, 'se pidió confirmación sin sesión');
  assert(resolveCalls.length === 0, 'se resolvió sin sesión');
  assert(JSON.stringify(fake._root) === before, 'hubo escrituras sin sesión');
});

/* ---------- runner ---------- */
(async () => {
  for (const [name, fn] of CASES) {
    try {
      await fn();
      oks++;
      console.log('ok   ' + name);
    } catch (e) {
      fails++;
      console.log('FAIL ' + name + ' :: ' + e.message);
    }
  }
  console.log('----');
  console.log('c115-baro-posts-propios: ' + oks + ' ok, ' + fails + ' fallos, ' + CASES.length + ' casos');
  process.exit(fails ? 1 : 0);
})();
