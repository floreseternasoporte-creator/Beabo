'use strict';
// Tests del carril 8L (OLEADA 3 v4 — MODERACIÓN PROPIA) de BARO v4:
// 4 herramientas: mod_silenciar_usuario, mod_quitar_silencio,
// mod_ocultar_post, mod_mostrar_post.
// Cubre: registro (baroRegisterTool/BARO_ICONS/baroIntentRules/baroIntentToTool),
// intents ES/EN/ZH/PT (extract puros + declinación de contexto chat),
// i18n en 4 idiomas, confirmación obligatoria en silenciar/ocultar (y en los
// reversos), escrituras reales en el almacenamiento de la app
// ('drex_hidden_authors' / 'drex_hidden_posts'), conteos reales en los mensajes,
// mensaje honesto sin sesión con cero escrituras, y ausencia del literal de
// cierre de script en el bloque.
// El bloque se EXTRAE de index.html (patron oleada 1 / c110), no del archivo
// del carril: marcador 'BARO · sub-bloque 8L'.
// HUECO HONESTO: no existe mod_silenciar_palabra (la app no tiene filtro de
// palabras); el test fija que el bloque NO la registra.
// Uso: node test-c121-baro-moderacion.js [--target <ruta-a-index.html>]
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
const src = __v4ExtractBlock('BARO · sub-bloque 8L');

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
  assert(src.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en el bloque extraido (8L)');
  const tsrc = fs.readFileSync(__filename, 'utf8');
  assert(tsrc.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en test-c121-baro-moderacion.js');
});

/* ---------- stubs de plataforma + carga del bloque en sandbox (vm) ---------- */
const registered = {};
const said = [];
const confirmCalls = [];
const __dModule = { exports: {} };
function makeLocalStorage(seed) {
  const store = Object.assign({}, seed || {});
  const writes = [];
  return {
    _store: store,
    _writes: writes,
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { writes.push([String(k), String(v)]); store[String(k)] = String(v); },
    removeItem(k) { delete store[String(k)]; }
  };
}
const sandbox = {
  console,
  Buffer,
  module: __dModule,
  APP_ENGLISH_TEXT: {},
  APP_CHINESE_TEXT: {},
  APP_PORTUGUESE_TEXT: {},
  baroRegisterTool: function (name, def) { registered[name] = def; },
  BARO_ICONS: {},
  baroIntentRules: [],
  baroIntentToTool: {},
  baroAddBaroMessage: function (html) { said.push(String(html)); },
  baroAskConfirm: function (opts) { confirmCalls.push(opts); return {}; },
  localStorage: makeLocalStorage(),
  baroResolveForTool: async function () { return { postId: 'notePOST123456789' }; }
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'block-lane-8l.js' });
const M = __dModule.exports;
assert(M && M.pure && M.tools && M.BARO_I18N_L && M.BARO_L_RULES,
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
function setPlatform(seed, lsSeed) {
  said.length = 0;
  confirmCalls.length = 0;
  sandbox.localStorage = makeLocalStorage(lsSeed);
  const fake = makeStore(seed);
  sandbox.DrexCloud = { database: () => fake };
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
function lsWrites() { return sandbox.localStorage._writes.slice(); }
function lsList(key) {
  const raw = sandbox.localStorage.getItem(key);
  try { const p = raw ? JSON.parse(raw) : []; return Array.isArray(p) ? p : []; }
  catch (_) { return []; }
}

const P = M.pure, T = M.tools;

/* ---------- 1. registro ---------- */
const TOOL_NAMES = ['mod_silenciar_usuario', 'mod_quitar_silencio', 'mod_ocultar_post', 'mod_mostrar_post'];

tcase('registro: 4 herramientas con label i18n y run (sin mod_silenciar_palabra)', () => {
  TOOL_NAMES.forEach((n) => {
    assert(registered[n], 'no registrada: ' + n);
    assert(typeof registered[n].run === 'function', 'run no es funcion: ' + n);
    assert(M.BARO_I18N_L[registered[n].label], 'label sin i18n: ' + n);
  });
  eqJ(Object.keys(registered).sort(), TOOL_NAMES.slice().sort(), 'nombres registrados');
  assert(!registered.mod_silenciar_palabra, 'mod_silenciar_palabra no debe existir (hueco honesto)');
});
tcase('registro: BARO_ICONS con 4 svg propios índigo sin emoji', () => {
  const want = ['mod-silenciar-usuario', 'mod-quitar-silencio', 'mod-ocultar-post', 'mod-mostrar-post'];
  want.forEach((k) => {
    const svg = sandbox.BARO_ICONS[k];
    assert(typeof svg === 'string' && svg.indexOf('<svg') === 0, 'icono ausente/invalido: ' + k);
    assert(svg.indexOf('#2F33B8') !== -1, 'icono sin índigo #2F33B8: ' + k);
    assert(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(svg), 'icono con emoji: ' + k);
  });
});
tcase('registro: 4 reglas en baroIntentRules + mapa intent->tool', () => {
  assert(sandbox.baroIntentRules.length === 4, 'reglas: ' + sandbox.baroIntentRules.length);
  sandbox.baroIntentRules.forEach((r) => {
    eqJ(r.langs, ['es', 'en', 'zh', 'pt'], 'langs de ' + r.intent);
    assert(Array.isArray(r.patterns) && r.patterns.length > 0, 'patterns vacios: ' + r.intent);
    r.patterns.forEach((p) => assert(Object.prototype.toString.call(p) === '[object RegExp]', 'pattern no RegExp en ' + r.intent));
    assert(typeof r.extract === 'function', 'extract no es funcion: ' + r.intent);
    assert(typeof r.intent === 'string' && r.intent.indexOf('mod_') === 0, 'intent raro: ' + r.intent);
  });
  TOOL_NAMES.forEach((n) => assert(sandbox.baroIntentToTool[n] === n, 'mapa sin ' + n));
});
tcase('BARO_L_RULES exportadas coinciden con lo registrado', () => {
  eqJ(M.BARO_L_RULES.map((r) => r.intent).sort(), TOOL_NAMES.slice().sort(), 'intents de reglas');
});
tcase('quitar va antes que silenciar y mostrar antes que ocultar (desambiguación)', () => {
  const order = M.BARO_L_RULES.map((r) => r.intent);
  assert(order.indexOf('mod_quitar_silencio') < order.indexOf('mod_silenciar_usuario'), 'orden quitar/silenciar');
  assert(order.indexOf('mod_mostrar_post') < order.indexOf('mod_ocultar_post'), 'orden mostrar/ocultar');
});

/* ---------- 2. i18n 4 idiomas ---------- */
tcase('i18n: toda clave baro.tool.mod.* tiene es/en/zh/pt no vacios', () => {
  const keys = Object.keys(M.BARO_I18N_L);
  assert(keys.length >= 30, 'pocas claves: ' + keys.length);
  keys.forEach((k) => {
    assert(k.indexOf('baro.tool.mod.') === 0, 'clave fuera de prefijo: ' + k);
    const e = M.BARO_I18N_L[k];
    ['es', 'en', 'zh', 'pt'].forEach((l) => {
      assert(e && typeof e[l] === 'string' && e[l].trim().length > 0, k + ' sin ' + l);
    });
  });
});
tcase('i18n: traducciones difieren del ES en puntos clave', () => {
  const e = M.BARO_I18N_L['baro.tool.mod.silenciar_usuario.label'];
  assert(e.en !== e.es && e.zh !== e.es && e.pt !== e.es, 'label silenciar sin traducir');
  const b = M.BARO_I18N_L['baro.tool.mod.ocultar_post.ok'];
  assert(b.en !== b.es && b.zh !== b.es && b.pt !== b.es, 'ocultar_post.ok sin traducir');
});

/* ---------- 3. intents / extract puros ---------- */
tcase('extract silenciar_usuario ES/EN/ZH/PT', () => {
  eqJ(P.baroLExtractSilenciarUsuario('silencia las publicaciones de @ana').usuario, '@ana', 'ES');
  eqJ(P.baroLExtractSilenciarUsuario('mute the posts of @bob').usuario, '@bob', 'EN');
  eqJ(P.baroLExtractSilenciarUsuario('不想看到 @ana 的动态').usuario, '@ana', 'ZH');
  eqJ(P.baroLExtractSilenciarUsuario('não quero ver as publicações de @ana').usuario, '@ana', 'PT');
  eqJ(P.baroLExtractSilenciarUsuario('no quiero ver los posts de @ana').usuario, '@ana', 'ES no-quiero-ver');
});
tcase('extract silenciar_usuario: declina contexto chat, ambiguo sin mencion', () => {
  assert(P.baroLExtractSilenciarUsuario('silencia el chat con @ana') === null, 'debió declinar al chat');
  assert(P.baroLExtractSilenciarUsuario('silencia la conversación con @ana') === null, 'debió declinar conversación');
  const amb = P.baroLExtractSilenciarUsuario('silencia las publicaciones de esa persona');
  assert(amb && amb.ambiguous === true && amb.candidates[0] === 'mod_silenciar_usuario', 'debió ser ambiguo');
});
tcase('extract quitar_silencio ES/EN/ZH/PT', () => {
  eqJ(P.baroLExtractQuitarSilencio('deja de silenciar a @ana').usuario, '@ana', 'ES');
  eqJ(P.baroLExtractQuitarSilencio('unmute @ana').usuario, '@ana', 'EN');
  eqJ(P.baroLExtractQuitarSilencio('取消静音 @ana').usuario, '@ana', 'ZH');
  eqJ(P.baroLExtractQuitarSilencio('deixa de silenciar @ana').usuario, '@ana', 'PT');
  assert(P.baroLExtractQuitarSilencio('deja de silenciar el chat con @ana') === null, 'debió declinar al chat');
});
tcase('extract ocultar_post ES/EN/ZH/PT (puro, sin resolver)', () => {
  const r1 = P.baroLExtractOcultarPost('oculta este post');
  assert(r1 && r1.rawText === 'oculta este post' && r1.targetDesc === 'oculta este post', 'ES');
  const r2 = P.baroLExtractOcultarPost('hide that post please');
  assert(r2 && r2.rawText === 'hide that post please', 'EN');
  const r3 = P.baroLExtractOcultarPost('隐藏这条帖子');
  assert(r3 && r3.rawText === '隐藏这条帖子', 'ZH');
  const r4 = P.baroLExtractOcultarPost('oculta esse post');
  assert(r4 && r4.rawText === 'oculta esse post', 'PT');
  assert(P.baroLExtractOcultarPost('oculta el chat') === null, 'debió declinar al chat');
});
tcase('extract mostrar_post ES/EN/ZH/PT', () => {
  const r1 = P.baroLExtractMostrarPost('muestra ese post');
  assert(r1 && r1.rawText === 'muestra ese post', 'ES');
  assert(P.baroLExtractMostrarPost('show that post').rawText === 'show that post', 'EN');
  assert(P.baroLExtractMostrarPost('显示这条帖子').rawText === '显示这条帖子', 'ZH');
  assert(P.baroLExtractMostrarPost('quita lo oculto de ese post').rawText === 'quita lo oculto de ese post', 'ES quita-oculto');
});
tcase('puras: uid, postId, menciones, norma', () => {
  assert(P.baroLIsUid('uidAna123-_') === true, 'uid valido rechazado');
  assert(P.baroLIsUid('a/b') === false, 'uid con / aceptado');
  assert(P.baroLIsUid('') === false, 'uid vacio aceptado');
  assert(P.baroLIsPostId('notePOST123456789') === true, 'postId valido rechazado');
  assert(P.baroLIsPostId('ab') === false, 'postId corto aceptado');
  eqJ(P.baroLMentions('hola @Ana y @bob, @ana otra vez'), ['ana', 'bob'], 'menciones');
});

/* ---------- 4. reglas: patrones disparan el intent correcto ---------- */
function ruleFor(intent) { return M.BARO_L_RULES.filter((r) => r.intent === intent)[0]; }
function hits(intent, text) {
  const r = ruleFor(intent);
  return r.patterns.some((p) => p.test(text));
}
tcase('patrones: cada intent dispara con su frase y no roba al vecino', () => {
  assert(hits('mod_silenciar_usuario', 'silencia las publicaciones de @ana'), 'silenciar ES');
  assert(hits('mod_silenciar_usuario', "don't want to see @ana's posts"), 'silenciar EN');
  assert(hits('mod_quitar_silencio', 'deja de silenciar a @ana'), 'quitar ES');
  assert(hits('mod_quitar_silencio', 'unmute @ana'), 'quitar EN');
  assert(hits('mod_ocultar_post', 'oculta este post'), 'ocultar ES');
  assert(hits('mod_ocultar_post', 'hide that post'), 'ocultar EN');
  assert(hits('mod_ocultar_post', '隐藏这条帖子'), 'ocultar ZH');
  assert(hits('mod_mostrar_post', 'muestra ese post'), 'mostrar ES');
  assert(hits('mod_mostrar_post', 'show that post'), 'mostrar EN');
  assert(!hits('mod_ocultar_post', 'muestra ese post'), 'ocultar robó "muestra"');
  assert(!hits('mod_mostrar_post', 'oculta este post'), 'mostrar robó "oculta"');
});

/* ---------- 5. confirmacion obligatoria + escrituras reales ---------- */
tcase('silenciar_usuario: pide confirmacion y al confirmar escribe drex_hidden_authors', async () => {
  setPlatform({
    usernames: { ana: 'uidAna' },
    users: { uidAna: { username: 'ana' }, me: { username: 'yo' } }
  });
  const before = lsWrites().length;
  const res = await T.mod_silenciar_usuario({ usuario: '@ana' }, makeCtx('me'));
  assert(confirmCalls.length === 1, 'sin tarjeta de confirmacion');
  assert(!confirmCalls[0].danger, 'silenciar no es danger');
  assert(String(confirmCalls[0].titleKey).indexOf('ana') !== -1, 'titulo sin ana');
  assert(String(confirmCalls[0].previewHtml).indexOf('este dispositivo') !== -1, 'preview sin honestidad local');
  assert(String(res.html).indexOf('confirmar') !== -1, 'debió devolver texto revisar');
  assert(lsWrites().length === before, 'escribió antes de confirmar');
  await confirmCalls[0].onConfirm();
  const list = lsList('drex_hidden_authors');
  eqJ(list, ['uidAna'], 'lista de autores silenciados');
  assert(said.some((m) => m.indexOf('@ana') !== -1 && m.indexOf('silenciado') !== -1), 'mensaje ok ausente: ' + JSON.stringify(said));
  assert(said.some((m) => m.indexOf('(1 silenciados)') !== -1), 'conteo real ausente en ok');
});
tcase('silenciar_usuario: ya silenciado / a si mismo / inexistente -> honesto sin confirmar', async () => {
  setPlatform({
    usernames: { ana: 'uidAna', yo: 'me' },
    users: { uidAna: { username: 'ana' }, me: { username: 'yo' } }
  }, { drex_hidden_authors: JSON.stringify(['uidAna']) });
  const r1 = await T.mod_silenciar_usuario({ usuario: '@ana' }, makeCtx('me'));
  assert(String(r1.html).indexOf('Ya tienes silenciado a @ana.') !== -1, 'ya ausente: ' + r1.html);
  assert(confirmCalls.length === 0, 'confirmó debiendo avisar (ya)');
  const r2 = await T.mod_silenciar_usuario({ usuario: '@yo' }, makeCtx('me'));
  assert(String(r2.html).indexOf('ti mismo') !== -1, 'no_self ausente');
  assert(confirmCalls.length === 0, 'confirmó debiendo avisar (self)');
  setPlatform({ usernames: {}, users: {} });
  const before = lsWrites().length;
  const r3 = await T.mod_silenciar_usuario({ usuario: '@nadiex' }, makeCtx('me'));
  assert(String(r3.html).indexOf('No encontré a @nadiex en Drex') !== -1, 'usuario_no ausente');
  assert(confirmCalls.length === 0, 'confirmó con usuario inexistente');
  assert(lsWrites().length === before, 'hubo escrituras con usuario inexistente');
});
tcase('quitar_silencio: confirma y elimina de drex_hidden_authors con conteo real', async () => {
  setPlatform({
    usernames: { ana: 'uidAna', beto: 'uidBeto' },
    users: { uidAna: { username: 'ana' }, uidBeto: { username: 'beto' } }
  }, { drex_hidden_authors: JSON.stringify(['uidAna', 'uidBeto']) });
  await T.mod_quitar_silencio({ usuario: '@ana' }, makeCtx('me'));
  assert(confirmCalls.length === 1, 'sin confirmacion de quitar');
  await confirmCalls[0].onConfirm();
  eqJ(lsList('drex_hidden_authors'), ['uidBeto'], 'no eliminó solo a uidAna');
  assert(said.some((m) => m.indexOf('(1 silenciados)') !== -1), 'conteo real ausente en ok');
});
tcase('quitar_silencio: no silenciado -> honesto sin confirmar', async () => {
  setPlatform({
    usernames: { ana: 'uidAna' },
    users: { uidAna: { username: 'ana' } }
  }, { drex_hidden_authors: JSON.stringify([]) });
  const r = await T.mod_quitar_silencio({ usuario: '@ana' }, makeCtx('me'));
  assert(String(r.html).indexOf('no está en tu lista de silenciados') !== -1, 'no-silenciado ausente');
  assert(confirmCalls.length === 0, 'confirmó debiendo avisar');
});
tcase('ocultar_post: pide confirmacion y al confirmar escribe drex_hidden_posts', async () => {
  setPlatform({});
  const before = lsWrites().length;
  const res = await T.mod_ocultar_post({ rawText: 'oculta ese post', targetDesc: 'ese post' }, makeCtx('me'));
  assert(confirmCalls.length === 1, 'sin tarjeta de confirmacion');
  assert(!confirmCalls[0].danger, 'ocultar no es danger');
  assert(String(confirmCalls[0].previewHtml).indexOf('No se elimina') !== -1, 'preview sin honestidad');
  assert(String(res.html).indexOf('confirmar') !== -1, 'debió devolver texto revisar');
  assert(lsWrites().length === before, 'escribió antes de confirmar');
  await confirmCalls[0].onConfirm();
  eqJ(lsList('drex_hidden_posts'), ['notePOST123456789'], 'lista de posts ocultos');
  assert(said.some((m) => m.indexOf('Tienes 1 posts ocultos') !== -1), 'conteo real ausente en ok: ' + JSON.stringify(said));
});
tcase('ocultar_post: ya oculto -> honesto sin confirmar', async () => {
  setPlatform({}, { drex_hidden_posts: JSON.stringify(['notePOST123456789']) });
  const r = await T.mod_ocultar_post({ rawText: 'oculta ese post' }, makeCtx('me'));
  assert(String(r.html).indexOf('ya está oculto') !== -1, 'ya-oculto ausente');
  assert(confirmCalls.length === 0, 'confirmó debiendo avisar');
});
tcase('mostrar_post: confirma y elimina de drex_hidden_posts', async () => {
  setPlatform({}, { drex_hidden_posts: JSON.stringify(['notePOST123456789', 'noteOTRO987654321']) });
  await T.mod_mostrar_post({ rawText: 'muestra ese post' }, makeCtx('me'));
  assert(confirmCalls.length === 1, 'sin confirmacion de mostrar');
  await confirmCalls[0].onConfirm();
  eqJ(lsList('drex_hidden_posts'), ['noteOTRO987654321'], 'no eliminó solo el post');
  assert(said.some((m) => m.indexOf('Tienes 1 posts ocultos') !== -1), 'conteo real ausente en ok');
});
tcase('mostrar_post: no oculto -> honesto sin confirmar', async () => {
  setPlatform({}, { drex_hidden_posts: JSON.stringify([]) });
  const r = await T.mod_mostrar_post({ rawText: 'muestra ese post' }, makeCtx('me'));
  assert(String(r.html).indexOf('no está en tu lista de ocultos') !== -1, 'no-oculto ausente');
  assert(confirmCalls.length === 0, 'confirmó debiendo avisar');
});
tcase('ocultar_post sin resolver: mensaje honesto, cero escrituras', async () => {
  const old = sandbox.baroResolveForTool;
  sandbox.baroResolveForTool = async function () { return { html: '<p>candidatos</p>' }; };
  setPlatform({});
  const before = lsWrites().length;
  const r = await T.mod_ocultar_post({ rawText: 'oculta el post de la playa' }, makeCtx('me'));
  assert(String(r.html).indexOf('candidatos') !== -1, 'debió devolver el html del resolvedor');
  assert(confirmCalls.length === 0, 'confirmó sin post resuelto');
  assert(lsWrites().length === before, 'hubo escrituras sin post resuelto');
  sandbox.baroResolveForTool = old;
});

/* ---------- 6. sin sesion: honesto, cero escrituras ---------- */
tcase('sin sesion: mensaje honesto y cero escrituras en las 4', async () => {
  const fake = setPlatform({
    usernames: { ana: 'uidAna' },
    users: { uidAna: { username: 'ana' } }
  }, { drex_hidden_authors: JSON.stringify([]), drex_hidden_posts: JSON.stringify([]) });
  const beforeDb = JSON.stringify(fake._root);
  const beforeLs = lsWrites().length;
  const calls = [
    ['mod_silenciar_usuario', { usuario: '@ana' }],
    ['mod_quitar_silencio', { usuario: '@ana' }],
    ['mod_ocultar_post', { rawText: 'oculta ese post' }],
    ['mod_mostrar_post', { rawText: 'muestra ese post' }]
  ];
  for (const [name, args] of calls) {
    const r = await T[name](args, makeCtx(null));
    assert(String(r.html).indexOf('Inicia sesión') !== -1, name + ' sin need_login');
  }
  assert(confirmCalls.length === 0, 'se pidió confirmación sin sesión');
  assert(JSON.stringify(fake._root) === beforeDb, 'hubo escrituras en BD sin sesión');
  assert(lsWrites().length === beforeLs, 'hubo escrituras en localStorage sin sesión');
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
  console.log('c121-baro-moderacion: ' + oks + ' ok, ' + fails + ' fallos, ' + CASES.length + ' casos');
  process.exit(fails ? 1 : 0);
})();
