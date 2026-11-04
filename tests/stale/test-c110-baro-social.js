'use strict';
// Tests del carril D (OLEADA 2 — SOCIAL) de BARO v4: 7 herramientas sociales.
// Cubre: registro (baroRegisterTool/BARO_ICONS/baroIntentRules/baroIntentToTool),
// intents ES/EN/ZH/PT (extract puros), i18n en 4 idiomas, confirmacion
// obligatoria en seguir/dejar de seguir/bloquear/desbloquear (+ aceptar y
// rechazar solicitudes), mensaje honesto sin sesion con cero escrituras, y
// ausencia del literal de cierre de script en el bloque.
// El bloque se EXTRAE de index.html (patron oleada 1 / c103-c109), no del
// archivo del carril: marcador 'BARO · sub-bloque 8D'.
// Uso: node test-c110-baro-social.js [--target <ruta-a-index.html>]
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
const src = __v4ExtractBlock('BARO · sub-bloque 8D');

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
  assert(src.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en el bloque extraido (8D)');
  const tsrc = fs.readFileSync(__filename, 'utf8');
  assert(tsrc.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en test-c110-baro-social.js');
});

/* ---------- stubs de plataforma + carga del bloque en sandbox (vm) ---------- */
const registered = {};
const said = [];
const confirmCalls = [];
const __dModule = { exports: {} };
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
  baroAskConfirm: function (opts) { confirmCalls.push(opts); return {}; }
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'block-lane-d.js' });
const M = __dModule.exports;
assert(M && M.pure && M.tools && M.BARO_I18N_D && M.BARO_D_RULES,
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
        },
        transactionBlind: (fn) => { set(base, fn(get(base))); }
      };
    }
  };
}
function setPlatform(seed) {
  said.length = 0;
  confirmCalls.length = 0;
  const fake = makeStore(seed);
  sandbox.DrexCloud = { database: () => fake };
  delete sandbox.requestOrFollowUser;
  delete sandbox.respondToFollowRequest;
  delete sandbox.breakFollowRelationsOnBlock;
  delete sandbox.unblockAccountFromPrivacy;
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

const P = M.pure, T = M.tools;

/* ---------- 1. registro ---------- */
const TOOL_NAMES = ['social_seguir', 'social_dejar_seguir', 'social_solicitudes',
  'social_seguidores', 'social_bloquear', 'social_desbloquear', 'social_bloqueados_ver'];

tcase('registro: 7 herramientas con label i18n y run', () => {
  TOOL_NAMES.forEach((n) => {
    assert(registered[n], 'no registrada: ' + n);
    assert(typeof registered[n].run === 'function', 'run no es funcion: ' + n);
    assert(M.BARO_I18N_D[registered[n].label], 'label sin i18n: ' + n);
  });
  eqJ(Object.keys(registered).sort(), TOOL_NAMES.slice().sort(), 'nombres registrados');
});
tcase('registro: BARO_ICONS con 7 svg propios', () => {
  const want = ['social-seguir', 'social-dejar-seguir', 'social-solicitudes',
    'social-seguidores', 'social-bloquear', 'social-desbloquear', 'social-bloqueados'];
  want.forEach((k) => {
    const svg = sandbox.BARO_ICONS[k];
    assert(typeof svg === 'string' && svg.indexOf('<svg') === 0, 'icono ausente/invalido: ' + k);
    assert(svg.indexOf('currentColor') !== -1, 'icono sin currentColor: ' + k);
  });
});
tcase('registro: 7 reglas en baroIntentRules + mapa intent->tool', () => {
  assert(sandbox.baroIntentRules.length === 7, 'reglas: ' + sandbox.baroIntentRules.length);
  sandbox.baroIntentRules.forEach((r) => {
    eqJ(r.langs, ['es', 'en', 'zh', 'pt'], 'langs de ' + r.intent);
    assert(Array.isArray(r.patterns) && r.patterns.length > 0, 'patterns vacios: ' + r.intent);
    // Nota: instanceof RegExp falla entre reinos (vm); se usa toString (patron c104).
    r.patterns.forEach((p) => assert(Object.prototype.toString.call(p) === '[object RegExp]', 'pattern no RegExp en ' + r.intent));
    assert(typeof r.extract === 'function', 'extract no es funcion: ' + r.intent);
    assert(typeof r.intent === 'string' && r.intent.indexOf('social_') === 0, 'intent raro: ' + r.intent);
  });
  TOOL_NAMES.forEach((n) => assert(sandbox.baroIntentToTool[n] === n, 'mapa sin ' + n));
});
tcase('BARO_D_RULES exportadas coinciden con lo registrado', () => {
  eqJ(M.BARO_D_RULES.map((r) => r.intent).sort(), TOOL_NAMES.slice().sort(), 'intents de reglas');
});

/* ---------- 2. i18n 4 idiomas ---------- */
tcase('i18n: toda clave tiene es/en/zh/pt no vacios', () => {
  const keys = Object.keys(M.BARO_I18N_D);
  assert(keys.length > 60, 'pocas claves: ' + keys.length);
  keys.forEach((k) => {
    const e = M.BARO_I18N_D[k];
    ['es', 'en', 'zh', 'pt'].forEach((l) => {
      assert(e && typeof e[l] === 'string' && e[l].trim().length > 0, k + ' sin ' + l);
    });
  });
});
tcase('i18n: traducciones difieren del ES en puntos clave', () => {
  const e = M.BARO_I18N_D['baro.tool.social.seguir.label'];
  assert(e.en !== e.es && e.zh !== e.es && e.pt !== e.es, 'label seguir sin traducir');
  const b = M.BARO_I18N_D['baro.tool.social.bloquear.ok'];
  // PT "bloqueado" es cognado válido (= ES); EN y ZH sí deben diferir.
  assert(b.en !== b.es && b.zh !== b.es, 'bloquear.ok sin traducir');
});

/* ---------- 3. intents / extract puros ---------- */
tcase('extract seguir ES/EN/ZH/PT', () => {
  eqJ(P.baroDExtractSeguir('sigue a @ana'), { usuario: '@ana', rawText: 'sigue a @ana' }, 'ES');
  eqJ(P.baroDExtractSeguir('follow @bob please').usuario, '@bob', 'EN');
  eqJ(P.baroDExtractSeguir('关注 @ana').usuario, '@ana', 'ZH');
  eqJ(P.baroDExtractSeguir('seguir @ana').usuario, '@ana', 'PT');
});
tcase('extract seguir: sin mencion -> ambiguo; "dejar de seguir" declina', () => {
  const amb = P.baroDExtractSeguir('sigue a esa persona');
  assert(amb && amb.ambiguous === true && amb.reason === 'missing_user', 'debió ser ambiguo');
  assert(P.baroDExtractSeguir('deja de seguir a @ana') === null, 'seguir robó "dejar de seguir"');
  assert(P.baroDExtractSeguir('unfollow @ana') === null, 'seguir robó "unfollow"');
  assert(P.baroDExtractSeguir('取关 @ana') === null, 'seguir robó "取关"');
});
tcase('extract dejar de seguir ES/EN/ZH/PT', () => {
  eqJ(P.baroDExtractDejarSeguir('deja de seguir a @ana').usuario, '@ana', 'ES');
  eqJ(P.baroDExtractDejarSeguir('unfollow @ana').usuario, '@ana', 'EN');
  eqJ(P.baroDExtractDejarSeguir('取关 @ana').usuario, '@ana', 'ZH');
  eqJ(P.baroDExtractDejarSeguir('deixar de seguir @ana').usuario, '@ana', 'PT');
});
tcase('extract bloquear/desbloquear + declinaciones', () => {
  eqJ(P.baroDExtractBloquear('bloquea a @ana').usuario, '@ana', 'ES bloquear');
  eqJ(P.baroDExtractBloquear('block @ana').usuario, '@ana', 'EN bloquear');
  eqJ(P.baroDExtractBloquear('拉黑 @ana').usuario, '@ana', 'ZH bloquear');
  eqJ(P.baroDExtractDesbloquear('desbloquea a @ana').usuario, '@ana', 'ES desbloquear');
  eqJ(P.baroDExtractDesbloquear('unblock @ana').usuario, '@ana', 'EN desbloquear');
  assert(P.baroDExtractBloquear('desbloquea a @ana') === null, 'bloquear robó "desbloquea"');
  assert(P.baroDExtractBloquear('unblock @ana') === null, 'bloquear robó "unblock"');
  eqJ(P.baroDExtractBloqueados('muéstrame mis bloqueados'), {}, 'bloqueados_ver');
});
tcase('extract solicitudes: ver/aceptar/rechazar + declina chat', () => {
  eqJ(P.baroDExtractSolicitudes('ver mis solicitudes de seguimiento').accion, 'ver', 'ver');
  const a = P.baroDExtractSolicitudes('acepta la solicitud de seguimiento de @ana');
  eqJ(a.accion, 'aceptar', 'aceptar'); eqJ(a.usuario, '@ana', 'usuario aceptar');
  const r = P.baroDExtractSolicitudes('rechaza la solicitud de @ana');
  eqJ(r.accion, 'rechazar', 'rechazar'); eqJ(r.usuario, '@ana', 'usuario rechazar');
  const amb = P.baroDExtractSolicitudes('acepta la solicitud');
  assert(amb && amb.ambiguous === true, 'aceptar sin usuario debió ser ambiguo');
  assert(P.baroDExtractSolicitudes('acepta la solicitud de chat abc123') === null, 'solicitudes robó chat');
});
tcase('extract seguidores: lista correcta y declina solicitudes', () => {
  const s1 = P.baroDExtractSeguidores('seguidores de @ana');
  eqJ(s1.lista, 'seguidores', 'lista'); eqJ(s1.usuario, '@ana', 'usuario');
  eqJ(P.baroDExtractSeguidores('followers of @ana').lista, 'seguidores', 'EN');
  const s2 = P.baroDExtractSeguidores('a quién sigo');
  eqJ(s2.lista, 'seguidos', 'seguidos ES'); eqJ(s2.usuario, null, 'sin usuario = yo');
  eqJ(P.baroDExtractSeguidores('quién me sigue').lista, 'seguidores', 'quien me sigue');
  eqJ(P.baroDExtractSeguidores('我关注了谁').lista, 'seguidos', 'ZH seguidos');
  assert(P.baroDExtractSeguidores('ver solicitudes de seguimiento') === null, 'seguidores robó solicitudes');
});

/* ---------- 4. utilidades puras ---------- */
tcase('puras: uid, menciones, payloads y rutas', () => {
  assert(P.baroDIsUid('uidAna123-_') === true, 'uid valido rechazado');
  assert(P.baroDIsUid('a/b') === false, 'uid con / aceptado');
  assert(P.baroDIsUid('') === false, 'uid vacio aceptado');
  eqJ(P.baroDMentions('hola @Ana y @bob, @ana otra vez'), ['ana', 'bob'], 'menciones');
  const bp = P.baroDBlockPayload('beto');
  assert(typeof bp.blockedAt === 'number' && bp.username === 'beto', 'payload bloqueo');
  eqJ(P.baroDUnfollowPaths('me', 't'), {
    follower: 'followers/t/me', following: 'following/me/t', request: 'followRequests/t/me'
  }, 'rutas unfollow');
  const br = P.baroDBreakPaths('me', 't', { iFollowThem: true, theyFollowMe: false });
  assert(br['followers/t/me'] === null && br['following/me/t'] === null, 'break iFollowThem');
  assert(br['followRequests/t/me'] === null && br['followRequests/me/t'] === null, 'break requests');
  assert(!('followers/me/t' in br), 'break no debia incluir theyFollowMe');
});

/* ---------- 5. confirmacion obligatoria + escrituras reales ---------- */
tcase('seguir: pide confirmacion (no danger) y al confirmar escribe', async () => {
  const fake = setPlatform({
    usernames: { ana: 'uidAna' },
    users: { uidAna: { username: 'ana', isPrivate: false }, me: { username: 'yo' } }
  });
  const res = await T.social_seguir({ usuario: '@ana' }, makeCtx('me'));
  assert(confirmCalls.length === 1, 'sin tarjeta de confirmacion');
  assert(!confirmCalls[0].danger, 'seguir no es danger');
  assert(String(confirmCalls[0].titleKey).indexOf('@ana') !== -1, 'titulo sin @ana');
  assert(String(res.html).length > 0, 'debió devolver texto revisar');
  assert(fake._get('followers/uidAna/me') === undefined, 'escribió antes de confirmar');
  await confirmCalls[0].onConfirm();
  const f = fake._get('followers/uidAna/me');
  assert(f && f.followedAt, 'falta followers');
  assert(fake._get('following/me/uidAna'), 'falta following');
  assert(fake._get('users/uidAna/followersCount') === 1, 'contador followers');
  assert(fake._get('users/me/followingCount') === 1, 'contador following');
  assert(said.some((m) => m.indexOf('Ahora sigues a @ana.') !== -1), 'mensaje ok ausente: ' + JSON.stringify(said));
});
tcase('seguir: cuenta privada -> solicitud (no follow directo)', async () => {
  const fake = setPlatform({
    usernames: { priv: 'uidPriv' },
    users: { uidPriv: { username: 'priv', isPrivate: true }, me: { username: 'yo' } }
  });
  await T.social_seguir({ usuario: '@priv' }, makeCtx('me'));
  assert(String(confirmCalls[0].previewHtml).indexOf('cuenta privada') !== -1, 'preview sin aviso de privada');
  await confirmCalls[0].onConfirm();
  assert(fake._get('followRequests/uidPriv/me'), 'falta la solicitud');
  assert(fake._get('followers/uidPriv/me') === undefined, 'siguió directo a una privada');
  assert(said.some((m) => m.indexOf('Solicitud enviada a @priv.') !== -1), 'mensaje solicitud ausente');
});
tcase('seguir: ya siguiendo / ya solicitado -> mensaje honesto sin confirmar', async () => {
  setPlatform({
    usernames: { ana: 'uidAna' },
    users: { uidAna: { username: 'ana' } },
    followers: { uidAna: { me: { followedAt: 1 } } }
  });
  const r1 = await T.social_seguir({ usuario: '@ana' }, makeCtx('me'));
  assert(String(r1.html).indexOf('Ya sigues a @ana.') !== -1, 'ya_sigue ausente: ' + r1.html);
  assert(confirmCalls.length === 0, 'confirmó debiendo avisar');
});
tcase('dejar de seguir: confirma y borra relacion + contadores', async () => {
  const fake = setPlatform({
    usernames: { ana: 'uidAna' },
    users: { uidAna: { username: 'ana', followersCount: 5 }, me: { followingCount: 3 } },
    followers: { uidAna: { me: { followedAt: 1 } } },
    following: { me: { uidAna: { followedAt: 1 } } }
  });
  await T.social_dejar_seguir({ usuario: '@ana' }, makeCtx('me'));
  assert(confirmCalls.length === 1 && !confirmCalls[0].danger, 'confirmacion dejar de seguir');
  await confirmCalls[0].onConfirm();
  assert(fake._get('followers/uidAna/me') === undefined, 'no borró followers');
  assert(fake._get('following/me/uidAna') === undefined, 'no borró following');
  assert(fake._get('users/uidAna/followersCount') === 4, 'contador followers no bajó');
  assert(fake._get('users/me/followingCount') === 2, 'contador following no bajó');
  assert(said.some((m) => m.indexOf('Dejaste de seguir a @ana.') !== -1), 'mensaje ok ausente');
});
tcase('dejar de seguir: cancela solicitud pendiente', async () => {
  const fake = setPlatform({
    usernames: { ana: 'uidAna' },
    users: { uidAna: { username: 'ana' } },
    followRequests: { uidAna: { me: { requestedAt: 1 } } }
  });
  await T.social_dejar_seguir({ usuario: '@ana' }, makeCtx('me'));
  assert(String(confirmCalls[0].previewHtml).indexOf('solicitud pendiente') !== -1, 'preview solicitud');
  await confirmCalls[0].onConfirm();
  assert(fake._get('followRequests/uidAna/me') === undefined, 'no canceló la solicitud');
});
tcase('bloquear: confirmacion danger + rompe follows mutuos', async () => {
  const fake = setPlatform({
    usernames: { beto: 'uidBeto' },
    users: {
      uidBeto: { username: 'beto', followersCount: 2, followingCount: 2 },
      me: { followersCount: 2, followingCount: 2 }
    },
    followers: { uidBeto: { me: { followedAt: 1 } }, me: { uidBeto: { followedAt: 1 } } },
    following: { me: { uidBeto: { followedAt: 1 } }, uidBeto: { me: { followedAt: 1 } } }
  });
  await T.social_bloquear({ usuario: '@beto' }, makeCtx('me'));
  assert(confirmCalls.length === 1, 'sin confirmacion de bloqueo');
  assert(confirmCalls[0].danger === true, 'bloquear debe ser danger');
  await confirmCalls[0].onConfirm();
  const bp = fake._get('blocks/me/uidBeto');
  assert(bp && bp.username === 'beto' && typeof bp.blockedAt === 'number', 'payload blocks malo');
  assert(fake._get('followers/uidBeto/me') === undefined, 'no rompió iFollowThem');
  assert(fake._get('followers/me/uidBeto') === undefined, 'no rompió theyFollowMe');
  assert(fake._get('following/me/uidBeto') === undefined, 'no rompió espejo following');
  assert(said.some((m) => m.indexOf('@beto bloqueado.') !== -1), 'mensaje bloqueo ausente');
});
tcase('bloquear: ya bloqueado / a si mismo -> honesto sin confirmar', async () => {
  setPlatform({
    usernames: { beto: 'uidBeto' },
    users: { uidBeto: { username: 'beto' } },
    blocks: { me: { uidBeto: { blockedAt: 1, username: 'beto' } } }
  });
  const r = await T.social_bloquear({ usuario: '@beto' }, makeCtx('me'));
  assert(String(r.html).indexOf('ya está en tu lista de bloqueados') !== -1, 'ya-bloqueado ausente');
  assert(confirmCalls.length === 0, 'confirmó debiendo avisar');
  setPlatform({ usernames: { yo: 'me' }, users: { me: { username: 'yo' } } });
  const r2 = await T.social_bloquear({ usuario: '@yo' }, makeCtx('me'));
  assert(String(r2.html).indexOf('ti mismo') !== -1, 'no_self ausente');
});
tcase('desbloquear: confirma y elimina el bloque', async () => {
  const fake = setPlatform({
    usernames: { beto: 'uidBeto' },
    users: { uidBeto: { username: 'beto' } },
    blocks: { me: { uidBeto: { blockedAt: 1, username: 'beto' } } }
  });
  await T.social_desbloquear({ usuario: '@beto' }, makeCtx('me'));
  assert(confirmCalls.length === 1 && !confirmCalls[0].danger, 'confirmacion desbloquear');
  await confirmCalls[0].onConfirm();
  assert(fake._get('blocks/me/uidBeto') === undefined, 'no eliminó el bloque');
  assert(said.some((m) => m.indexOf('@beto desbloqueado.') !== -1), 'mensaje desbloqueo ausente');
});
tcase('desbloquear: no bloqueado -> honesto sin confirmar', async () => {
  setPlatform({ usernames: { beto: 'uidBeto' }, users: { uidBeto: { username: 'beto' } } });
  const r = await T.social_desbloquear({ usuario: '@beto' }, makeCtx('me'));
  assert(String(r.html).indexOf('no está en tu lista de bloqueados') !== -1, 'no-bloqueado ausente');
  assert(confirmCalls.length === 0, 'confirmó debiendo avisar');
});
tcase('solicitudes aceptar: confirma y crea la relacion (replica)', async () => {
  const fake = setPlatform({
    usernames: { ana: 'uidAna' },
    users: { uidAna: { username: 'ana' }, me: { username: 'yo' } },
    followRequests: { me: { uidAna: { requestedAt: 1, requesterName: 'ana' } } }
  });
  await T.social_solicitudes({ accion: 'aceptar', usuario: '@ana' }, makeCtx('me'));
  assert(confirmCalls.length === 1, 'aceptar sin confirmacion');
  await confirmCalls[0].onConfirm();
  assert(fake._get('followRequests/me/uidAna') === undefined, 'no eliminó la solicitud');
  assert(fake._get('followers/me/uidAna'), 'no creó followers');
  assert(fake._get('following/uidAna/me'), 'no creó following');
  assert(said.some((m) => m.indexOf('Aceptaste la solicitud de @ana.') !== -1), 'mensaje aceptada ausente');
});
tcase('solicitudes rechazar: confirma y solo elimina', async () => {
  const fake = setPlatform({
    usernames: { ana: 'uidAna' },
    users: { uidAna: { username: 'ana' } },
    followRequests: { me: { uidAna: { requestedAt: 1 } } }
  });
  await T.social_solicitudes({ accion: 'rechazar', usuario: '@ana' }, makeCtx('me'));
  assert(confirmCalls.length === 1, 'rechazar sin confirmacion');
  await confirmCalls[0].onConfirm();
  assert(fake._get('followRequests/me/uidAna') === undefined, 'no eliminó la solicitud');
  assert(fake._get('followers/me/uidAna') === undefined, 'creó relacion al rechazar');
  assert(said.some((m) => m.indexOf('Rechazaste la solicitud de @ana.') !== -1), 'mensaje rechazada ausente');
});
tcase('solicitudes ver: lista con conteo real', async () => {
  setPlatform({
    followRequests: { me: { uidA: { requestedAt: 1 }, uidB: { requestedAt: 2 } } },
    users: { uidA: { username: 'aaa' }, uidB: { username: 'bbb' } }
  });
  const r = await T.social_solicitudes({ accion: 'ver' }, makeCtx('me'));
  assert(String(r.html).indexOf('Solicitudes de seguimiento (2)') !== -1, 'conteo real ausente: ' + r.html);
  assert(String(r.html).indexOf('@aaa') !== -1 && String(r.html).indexOf('@bbb') !== -1, 'nombres ausentes');
  assert(confirmCalls.length === 0, 'ver no debe confirmar');
});
tcase('solicitudes ver: vacia honesta', async () => {
  setPlatform({});
  const r = await T.social_solicitudes({}, makeCtx('me'));
  assert(String(r.html).indexOf('No tienes solicitudes') !== -1, 'vacia ausente');
});
tcase('seguidores: lista con conteo real + perfilado', async () => {
  setPlatform({
    usernames: { ana: 'uidAna' },
    users: { uidAna: { username: 'ana' }, u1: { username: 'carlos' }, u2: { username: 'diana' } },
    followers: { uidAna: { u1: { followedAt: 1 }, u2: { followedAt: 2 } } }
  });
  const r = await T.social_seguidores({ lista: 'seguidores', usuario: '@ana' }, makeCtx('me'));
  assert(String(r.html).indexOf('Seguidores de @ana (2)') !== -1, 'titulo/conteo ausente: ' + r.html);
  assert(String(r.html).indexOf('@carlos') !== -1, 'perfilado ausente');
  assert(confirmCalls.length === 0, 'lectura no debe confirmar');
});
tcase('bloqueados ver: lista con conteo real', async () => {
  setPlatform({
    blocks: { me: { uidX: { blockedAt: 1, username: 'x' } } },
    users: { uidX: { username: 'equis' } }
  });
  const r = await T.social_bloqueados_ver({}, makeCtx('me'));
  assert(String(r.html).indexOf('Cuentas bloqueadas (1)') !== -1, 'titulo/conteo ausente');
  assert(String(r.html).indexOf('@equis') !== -1, 'nombre ausente');
});
tcase('usuario inexistente -> mensaje honesto, cero escrituras', async () => {
  const fake = setPlatform({});
  const before = JSON.stringify(fake._root);
  const r = await T.social_seguir({ usuario: '@nadiex' }, makeCtx('me'));
  assert(String(r.html).indexOf('No encontré a @nadiex en Drex') !== -1, 'usuario_no ausente');
  assert(confirmCalls.length === 0, 'confirmó con usuario inexistente');
  assert(JSON.stringify(fake._root) === before, 'hubo escrituras');
});

/* ---------- 6. sin sesion: honesto, cero escrituras ---------- */
tcase('sin sesion: mensaje honesto y cero escrituras en las 7', async () => {
  const fake = setPlatform({ usernames: { ana: 'uidAna' }, users: { uidAna: { username: 'ana' } } });
  const before = JSON.stringify(fake._root);
  const calls = [
    ['social_seguir', { usuario: '@ana' }],
    ['social_dejar_seguir', { usuario: '@ana' }],
    ['social_solicitudes', { accion: 'ver' }],
    ['social_seguidores', { lista: 'seguidores' }],
    ['social_bloquear', { usuario: '@ana' }],
    ['social_desbloquear', { usuario: '@ana' }],
    ['social_bloqueados_ver', {}]
  ];
  for (const [name, args] of calls) {
    const r = await T[name](args, makeCtx(null));
    assert(String(r.html).indexOf('Inicia sesión') !== -1, name + ' sin need_login');
  }
  assert(confirmCalls.length === 0, 'se pidió confirmación sin sesión');
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
  console.log('c110-baro-social: ' + oks + ' ok, ' + fails + ' fallos, ' + CASES.length + ' casos');
  process.exit(fails ? 1 : 0);
})();
