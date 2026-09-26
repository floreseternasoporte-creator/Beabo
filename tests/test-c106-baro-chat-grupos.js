'use strict';
// Tests del carril C1 (BARO v4, OLEADA 1 — CHAT GRUPOS).
// Cubre: registro de las 3 herramientas, iconos propios, i18n ES/EN/ZH/PT,
// reglas de intencion (sinonimos 4 idiomas), confirmacion obligatoria en
// crear grupo y cambiar miembros (nada se escribe sin confirmar), verificacion
// de admin, y aceptar/rechazar de antesala con roomId explicito.
// Uso: node test-lane-c1.js [--target otro.html]
//   Sin --target corre contra block-lane-c1.js (mismo directorio).
const fs = require('fs');
const path = require('path');

let fails = 0, oks = 0;
function tcase(name, fn) { CASES.push([name, fn]); }
const CASES = [];
function assert(cond, label) { if (!cond) throw new Error('assert: ' + label); }
function eq(a, b, label) { if (a !== b) throw new Error(label + ' esperado=' + JSON.stringify(b) + ' actual=' + JSON.stringify(a)); }

let explicitTarget = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) explicitTarget = process.argv[++i];
}

let code;
{
  const html = fs.readFileSync(explicitTarget || path.join(__dirname, '..', 'index.html'), 'utf8');
  const START = 'BARO · sub-bloque 8C1';
  let si = html.indexOf('/* ================= ' + START);
  if (si === -1) si = html.indexOf(START);
  assert(si !== -1, 'marcador 8C1 ausente en el target');
  const slice = html.slice(si);
  const ni = slice.indexOf('/* ================= BARO \u00b7 sub-bloque 8', 1);
  const ei = slice.indexOf('</script>');
  let end = slice.length;
  if (ni !== -1) end = Math.min(end, ni);
  if (ei !== -1) end = Math.min(end, ei);
  code = slice.slice(0, end);
}
assert(code.indexOf('chat_grupo_crear') !== -1, 'el bloque no contiene chat_grupo_crear');

// Exponer internos para el test (solo en el sandbox, no en produccion).
const closeAt = code.lastIndexOf('})();');
assert(closeAt !== -1, 'cierre IIFE no encontrado');
const expose = '\n;try{global.__c1={BARO_I18N_C1:BARO_I18N_C1,baroTC1:baroTC1,baroTxC1:baroTxC1,baroLangC1:baroLangC1,' +
  'baroC1ExtractCrear:baroC1ExtractCrear,baroC1ExtractMiembros:baroC1ExtractMiembros,' +
  'baroC1ExtractAntesala:baroC1ExtractAntesala,baroC1RunCrearGrupo:baroC1RunCrearGrupo,' +
  'baroC1RunMiembros:baroC1RunMiembros,baroC1RunAntesala:baroC1RunAntesala};}catch(_){}\n';
code = code.slice(0, closeAt) + expose + code.slice(closeAt);

/* ---------- harness ---------- */
globalThis.APP_ENGLISH_TEXT = {};
globalThis.APP_CHINESE_TEXT = {};
globalThis.APP_PORTUGUESE_TEXT = {};
globalThis.BARO_ICONS = {};
globalThis.BARO_UI_I18N = {};
globalThis.baroIntentRules = [];
globalThis.baroIntentToTool = {};

const registered = {};
const confirmCalls = [];
const confirmPromises = [];
let autoConfirm = false;
const said = [];
const stepLog = [];
let testLang = 'es';
let stepSeq = 0;

function fakeRegisterTool(name, def) { registered[name] = def; }
function fakeAskConfirm(opts) {
  confirmCalls.push(opts || {});
  if (autoConfirm && opts && typeof opts.onConfirm === 'function') {
    const p = Promise.resolve().then(() => opts.onConfirm());
    confirmPromises.push(p);
    return p;
  }
  return null;
}
function fakeSay(html) { said.push(String(html)); }

function makeDb() {
  const root = {};
  const parts = (p) => String(p || '').split('/').filter((x) => x.length);
  const get = (path) => {
    const ps = parts(path); let n = root;
    for (const k of ps) { if (n == null || typeof n !== 'object' || !(k in n)) return undefined; n = n[k]; }
    return n;
  };
  const set = (path, v) => {
    const ps = parts(path); if (!ps.length) return;
    let n = root;
    for (let i = 0; i < ps.length - 1; i++) {
      if (n[ps[i]] == null || typeof n[ps[i]] !== 'object') n[ps[i]] = {};
      n = n[ps[i]];
    }
    const last = ps[ps.length - 1];
    if (v === null || v === undefined) delete n[last]; else n[last] = v;
  };
  const setOptsLog = [];
  let seq = 0;
  const snap = (v, key) => ({
    val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))),
    exists: () => v !== undefined && v !== null,
    key,
  });
  const mkRef = (path) => {
    const P = parts(path).join('/');
    return {
      key: parts(path).pop() || null,
      push: (v) => {
        seq++;
        const k = '-C1' + String(seq).padStart(3, '0') + 'testkey00000';
        if (v !== undefined) set(P + '/' + k, v);
        return {
          key: k,
          _writePromise: Promise.resolve(),
          set: (val, opts) => { setOptsLog.push({ path: P + '/' + k, opts: opts || null }); set(P + '/' + k, val); return Promise.resolve(); },
        };
      },
      set: (v, opts) => { setOptsLog.push({ path: P, opts: opts || null }); set(P, v); return Promise.resolve(); },
      update: (obj) => { Object.keys(obj).forEach((k) => set(k, obj[k])); return Promise.resolve(); },
      remove: () => { set(P, null); return Promise.resolve(); },
      once: () => Promise.resolve(snap(get(P), parts(path).pop() || null)),
    };
  };
  return { ref: mkRef, _get: get, _set: set, _setOpts: setOptsLog, _root: root };
}

let db = makeDb();
const DrexCloud = { database: () => db, auth: () => ({ currentUser: { uid: 'u_me' } }) };
const getAppLanguage = () => testLang;

new Function('baroRegisterTool', 'baroAskConfirm', 'baroAddBaroMessage', 'DrexCloud', 'getAppLanguage', code)(
  fakeRegisterTool, fakeAskConfirm, fakeSay, DrexCloud, getAppLanguage);

const C1 = global.__c1;
assert(C1, '__c1 no expuesto');

function mkCtx(user) {
  return {
    user: user === undefined ? { uid: 'u_me' } : user,
    t: (k) => k,
    step: (label) => { stepSeq++; const id = 's' + stepSeq; stepLog.push({ id, label }); return id; },
    stepDone: (id, opts) => { stepLog.push({ id, done: true, summary: opts && opts.summary }); },
    esc: (s) => String(s == null ? '' : s),
  };
}
function reset() {
  db = makeDb(); confirmCalls.length = 0; confirmPromises.length = 0;
  said.length = 0; stepLog.length = 0; autoConfirm = false; testLang = 'es'; stepSeq = 0;
}
const flush = () => Promise.all(confirmPromises).then(() => new Promise((r) => setTimeout(r, 10)));

/* ---------- 1. registro ---------- */
tcase('registro: 3 herramientas con run', () => {
  ['chat_grupo_crear', 'chat_grupo_miembros', 'chat_antesala'].forEach((n) => {
    assert(registered[n], 'no registrada: ' + n);
    assert(typeof registered[n].run === 'function', 'sin run: ' + n);
    assert(typeof registered[n].label === 'string' && registered[n].label.indexOf('baro.tool.') === 0, 'label mala: ' + n);
  });
  eq(Object.keys(registered).length, 3, 'registro inesperado');
});

tcase('iconos: 3 SVG propios en BARO_ICONS', () => {
  ['chat-grupo', 'chat-miembros', 'antesala'].forEach((k) => {
    const svg = globalThis.BARO_ICONS[k];
    assert(typeof svg === 'string' && svg.indexOf('<svg') === 0 && svg.indexOf('</svg>') !== -1, 'icono malo: ' + k);
  });
});

tcase('intents: 3 reglas + mapeo intent->tool', () => {
  eq(globalThis.baroIntentRules.length, 3, 'reglas');
  const intents = globalThis.baroIntentRules.map((r) => r.intent).sort();
  eq(JSON.stringify(intents), JSON.stringify(['chat_antesala', 'chat_grupo_crear', 'chat_grupo_miembros']), 'intents');
  globalThis.baroIntentRules.forEach((r) => {
    eq(JSON.stringify(r.langs), JSON.stringify(['es', 'en', 'zh', 'pt']), 'langs ' + r.intent);
    assert(r.patterns.length > 0 && typeof r.extract === 'function', 'regla incompleta ' + r.intent);
  });
  eq(globalThis.baroIntentToTool['chat_grupo_crear'], 'chat_grupo_crear', 'map crear');
  eq(globalThis.baroIntentToTool['chat_grupo_miembros'], 'chat_grupo_miembros', 'map miembros');
  eq(globalThis.baroIntentToTool['chat_antesala'], 'chat_antesala', 'map antesala');
});

/* ---------- 2. i18n 4 idiomas ---------- */
tcase('i18n: todas las claves con es/en/zh/pt no vacios', () => {
  const keys = Object.keys(C1.BARO_I18N_C1);
  assert(keys.length >= 50, 'pocas claves: ' + keys.length);
  keys.forEach((k) => {
    const e = C1.BARO_I18N_C1[k];
    ['es', 'en', 'zh', 'pt'].forEach((l) => {
      assert(typeof e[l] === 'string' && e[l].length > 0, 'falta ' + l + ' en ' + k);
    });
  });
});

tcase('i18n: fusion a BARO_UI_I18N y APP_*_TEXT (patron 6c/6a)', () => {
  assert(globalThis.BARO_UI_I18N['baro.tool.chatgrupo.label'], 'no en BARO_UI_I18N');
  eq(globalThis.BARO_UI_I18N['baro.tool.chatgrupo.label'].en, 'Create group chat', 'EN en BARO_UI_I18N');
  eq(globalThis.APP_ENGLISH_TEXT['baro.tool.chatgrupo.label'], 'Create group chat', 'merge 6c por clave');
  eq(globalThis.APP_ENGLISH_TEXT['Crear grupo de chat'], 'Create group chat', 'merge 6a por cadena ES');
  eq(globalThis.APP_CHINESE_TEXT['baro.tool.chatgrupo.label'], '创建群聊', 'ZH');
  eq(globalThis.APP_PORTUGUESE_TEXT['baro.tool.chatgrupo.label'], 'Criar grupo de conversa', 'PT');
});

tcase('i18n: baroTC1 respeta el idioma', () => {
  testLang = 'es'; eq(C1.baroTC1('baro.tool.chatgrupo.label'), 'Crear grupo de chat', 'es');
  testLang = 'en'; eq(C1.baroTC1('baro.tool.chatgrupo.label'), 'Create group chat', 'en');
  testLang = 'zh'; eq(C1.baroTC1('baro.tool.chatgrupo.label'), '创建群聊', 'zh');
  testLang = 'pt'; eq(C1.baroTC1('baro.tool.chatgrupo.label'), 'Criar grupo de conversa', 'pt');
  testLang = 'es';
  eq(C1.baroTxC1('baro.tool.chatgrupo.creado', { name: 'X', n: '3' }), 'Grupo «X» creado con 3 miembros.', 'tx vars');
});

/* ---------- 3. intenciones ---------- */
function detectIntent(text) {
  let best = null, bestScore = 0;
  globalThis.baroIntentRules.forEach((r) => {
    let s = 0;
    r.patterns.forEach((p) => { try { if (p instanceof RegExp ? p.test(text) : text.toLowerCase().indexOf(String(p).toLowerCase()) !== -1) s++; } catch (_) {} });
    if (s > bestScore) { bestScore = s; best = r; }
  });
  return best ? best.intent : null;
}

tcase('intent crear: sinonimos ES/EN/ZH/PT', () => {
  eq(detectIntent('crea el grupo "Amigos" con @ana y @bob'), 'chat_grupo_crear', 'es');
  eq(detectIntent('quiero crear un grupo de chat con @ana'), 'chat_grupo_crear', 'es2');
  eq(detectIntent('create a group named Coders with @ana'), 'chat_grupo_crear', 'en');
  eq(detectIntent('cria um grupo chamado Devs com @ana'), 'chat_grupo_crear', 'pt');
  eq(detectIntent('创建群聊“夜猫子”，加上 @ana'), 'chat_grupo_crear', 'zh');
});

tcase('intent crear: extract nombre + usuarios', () => {
  const a = C1.baroC1ExtractCrear('crea el grupo "Amigos del gym" con @ana y @bob');
  eq(a.name, 'Amigos del gym', 'nombre entrecomillado');
  eq(JSON.stringify(a.users), JSON.stringify(['ana', 'bob']), 'usuarios');
  const b = C1.baroC1ExtractCrear('crea un grupo llamado Fiesteros con @ana');
  eq(b.name, 'Fiesteros', 'llamado');
  const c = C1.baroC1ExtractCrear('crea un grupo con @ana');
  assert(c.ambiguous === true && c.reason === 'missing_name', 'sin nombre -> ambiguo');
  const d = C1.baroC1ExtractCrear('crea el grupo "Amigos"');
  assert(d.ambiguous === true && d.reason === 'missing_members', 'sin miembros -> ambiguo');
});

tcase('intent miembros: agregar/quitar ES/EN/PT/ZH', () => {
  let a = C1.baroC1ExtractMiembros('agrega @ana al grupo "Amigos"');
  eq(detectIntent('agrega @ana al grupo "Amigos"'), 'chat_grupo_miembros', 'es add');
  eq(a.accion, 'agregar', 'accion add'); eq(a.grupo, 'Amigos', 'grupo');
  a = C1.baroC1ExtractMiembros('saca a @bob del grupo "Amigos"');
  eq(detectIntent('saca a @bob del grupo "Amigos"'), 'chat_grupo_miembros', 'es remove');
  eq(a.accion, 'quitar', 'accion quitar');
  a = C1.baroC1ExtractMiembros('add @ana to the group "Friends"');
  eq(detectIntent('add @ana to the group "Friends"'), 'chat_grupo_miembros', 'en add');
  eq(a.accion, 'agregar', 'en accion');
  a = C1.baroC1ExtractMiembros('remove @bob from the group "Friends"');
  eq(a.accion, 'quitar', 'en quitar');
  a = C1.baroC1ExtractMiembros('adicionar @ana ao grupo "Amigos"');
  eq(detectIntent('adicionar @ana ao grupo "Amigos"'), 'chat_grupo_miembros', 'pt');
  eq(a.accion, 'agregar', 'pt accion');
  a = C1.baroC1ExtractMiembros('把 @bob 踢出“朋友们”群');
  eq(a.accion, 'quitar', 'zh quitar'); eq(a.grupo, '朋友们', 'zh grupo');
  eq(C1.baroC1ExtractMiembros('agrega @ana'), null, 'sin contexto de grupo -> declina');
  const amb = C1.baroC1ExtractMiembros('agrega @ana al grupo');
  assert(amb.ambiguous === true && amb.reason === 'missing_group', 'sin nombre de grupo -> ambiguo');
  eq(C1.baroC1ExtractMiembros('hola como estas'), null, 'sin contexto -> declina');
});

tcase('intent antesala: aceptar/rechazar ES/EN/PT/ZH', () => {
  eq(detectIntent('acepta la solicitud de chat u1__u2abcdef'), 'chat_antesala', 'es accept');
  let a = C1.baroC1ExtractAntesala('acepta la solicitud de chat u1__u2abcdef');
  eq(a.accion, 'aceptar', 'accion'); eq(a.roomId, 'u1__u2abcdef', 'roomId');
  a = C1.baroC1ExtractAntesala('rechaza la solicitud u1__u2abcdef');
  eq(detectIntent('rechaza la solicitud u1__u2abcdef'), 'chat_antesala', 'es decline');
  eq(a.accion, 'rechazar', 'rechazar');
  a = C1.baroC1ExtractAntesala('decline the chat request u1__u2abcdef');
  eq(detectIntent('decline the chat request u1__u2abcdef'), 'chat_antesala', 'en');
  eq(a.accion, 'rechazar', 'en rechazar');
  eq(detectIntent('aceita o pedido de conversa u1__u2abcdef'), 'chat_antesala', 'pt');
  eq(detectIntent('接受聊天请求 u1__u2abcdef'), 'chat_antesala', 'zh');
  const amb = C1.baroC1ExtractAntesala('acepta la solicitud de chat');
  assert(amb.ambiguous === true && amb.reason === 'missing_room', 'sin room -> ambiguo');
});

/* ---------- 4. crear grupo: confirmacion obligatoria ---------- */
tcase('crear: sin confirmar NO escribe nada', async () => {
  reset();
  db._set('usernames/ana', 'u_ana'); db._set('usernames/bob', 'u_bob');
  autoConfirm = false;
  const r = await C1.baroC1RunCrearGrupo({ name: 'Amigos', users: ['@ana', '@bob'] }, mkCtx());
  await flush();
  eq(confirmCalls.length, 1, 'se pidio confirmacion');
  eq(confirmCalls[0].titleKey, 'baro.tool.chatgrupo.confirm_title', 'titulo');
  assert(r.html.indexOf('Confirmar') !== -1, 'aviso de revision');
  assert(db._get('groupChats') === undefined, 'nada escrito sin confirmar');
  assert(stepLog.some((s) => s.label === 'Resolviendo 2 usuarios…'), 'step con conteo real');
});

tcase('crear: al confirmar escribe grupo + fan-out + sistema', async () => {
  reset();
  db._set('usernames/ana', 'u_ana'); db._set('usernames/bob', 'u_bob');
  db._set('users/u_me', { username: 'jefe' });
  autoConfirm = true;
  await C1.baroC1RunCrearGrupo({ name: 'Amigos', users: ['@ana', '@bob'] }, mkCtx());
  await flush();
  const groups = db._get('groupChats');
  const gids = Object.keys(groups || {});
  eq(gids.length, 1, 'un grupo');
  const g = groups[gids[0]];
  eq(g.name, 'Amigos', 'nombre');
  eq(JSON.stringify(Object.keys(g.members).sort()), JSON.stringify(['u_ana', 'u_bob', 'u_me']), 'miembros');
  eq(g.admins['u_me'], true, 'admin creador'); eq(g.createdBy, 'u_me', 'createdBy');
  ['u_me', 'u_ana', 'u_bob'].forEach((u) => {
    const c = db._get('userConversations/' + u + '/' + gids[0]);
    assert(c && c.isGroup === true && c.groupId === gids[0], 'fan-out ' + u);
  });
  const fanSets = db._setOpts.filter((e) => e.path.indexOf('userConversations/') === 0);
  eq(fanSets.length, 3, '3 fan-outs');
  fanSets.forEach((e) => eq(JSON.stringify(e.opts), JSON.stringify({ noReseal: true }), 'noReseal en ' + e.path));
  const msgs = db._get('conversationMessages/' + gids[0]);
  assert(msgs && Object.keys(msgs).some((k) => msgs[k].system === true), 'mensaje de sistema');
  assert(said.some((h) => h.indexOf('Amigos') !== -1 && h.indexOf('3 miembros') !== -1), 'mensaje de exito con conteo');
});

tcase('crear: sin sesion -> mensaje honesto', async () => {
  reset();
  const r = await C1.baroC1RunCrearGrupo({ name: 'X', users: ['@ana'] }, mkCtx(null));
  assert(r.html.indexOf('Inicia sesión') !== -1, 'honesto sin sesion');
  eq(confirmCalls.length, 0, 'sin confirmacion');
});

tcase('crear: usuario inexistente -> honesto, sin escribir', async () => {
  reset();
  db._set('usernames/ana', 'u_ana');
  autoConfirm = true;
  const r = await C1.baroC1RunCrearGrupo({ name: 'Amigos', users: ['@ana', '@fantasma'] }, mkCtx());
  await flush();
  assert(r.html.indexOf('@fantasma') !== -1, 'nombra al faltante');
  assert(db._get('groupChats') === undefined, 'no escribe');
});

/* ---------- 5. miembros: admin + confirmacion ---------- */
function seedGroup(adminUid) {
  db._set('groupChats/g1', {
    name: 'Amigos', createdBy: 'u_dueno',
    members: { u_me: true, u_dueno: true }, admins: { [adminUid]: true },
  });
  db._set('usernames/ana', 'u_ana');
  db._set('usernames/carlos', 'u_carlos');
}

tcase('miembros: no-admin no puede (ni con confirmacion)', async () => {
  reset(); seedGroup('u_dueno');
  autoConfirm = true;
  const r = await C1.baroC1RunMiembros({ accion: 'agregar', grupo: 'g1', users: ['@ana'] }, mkCtx());
  await flush();
  assert(r.html.indexOf('Solo un administrador') !== -1, 'mensaje no_admin');
  eq(confirmCalls.length, 0, 'no pide confirmar');
  assert(db._get('groupChats/g1/members/u_ana') === undefined, 'no escribe');
});

tcase('miembros: admin agrega con confirmacion', async () => {
  reset(); seedGroup('u_me');
  autoConfirm = true;
  await C1.baroC1RunMiembros({ accion: 'agregar', grupo: 'g1', users: ['@ana'] }, mkCtx());
  await flush();
  eq(confirmCalls.length, 1, 'confirmacion pedida');
  assert(confirmCalls[0].titleKey === 'baro.tool.chatmiembros.confirm_title_add', 'titulo add');
  eq(db._get('groupChats/g1/members/u_ana'), true, 'miembro agregado');
  const c = db._get('userConversations/u_ana/g1');
  assert(c && c.isGroup === true && c.groupName === 'Amigos', 'inbox del nuevo miembro');
  assert(said.some((h) => h.indexOf('agregados') !== -1), 'mensaje de exito');
});

tcase('miembros: sin confirmar no escribe', async () => {
  reset(); seedGroup('u_me');
  autoConfirm = false;
  await C1.baroC1RunMiembros({ accion: 'agregar', grupo: 'g1', users: ['@ana'] }, mkCtx());
  await flush();
  eq(confirmCalls.length, 1, 'confirmacion pedida');
  assert(db._get('groupChats/g1/members/u_ana') === undefined, 'nada sin confirmar');
});

tcase('miembros: quitar elimina member/admin/inbox/unread', async () => {
  reset(); seedGroup('u_me');
  db._set('groupChats/g1/members/u_carlos', true);
  db._set('groupChats/g1/admins/u_carlos', true);
  db._set('userConversations/u_carlos/g1', { isGroup: true });
  db._set('chatUnread/u_carlos/g1', { c: 2 });
  autoConfirm = true;
  // u_me es admin pero no creador: quitar a otro admin -> solo_creador_admin
  let r = await C1.baroC1RunMiembros({ accion: 'quitar', grupo: 'g1', users: ['@carlos'] }, mkCtx());
  await flush();
  assert(r.html.indexOf('Solo el creador puede eliminar a un administrador') !== -1, 'regla admin');
  assert(db._get('groupChats/g1/members/u_carlos') === true, 'no se quito al admin');
  // ahora como creador si puede
  reset(); seedGroup('u_me');
  db._set('groupChats/g1/createdBy', 'u_me');
  db._set('groupChats/g1/members/u_carlos', true);
  db._set('userConversations/u_carlos/g1', { isGroup: true });
  db._set('chatUnread/u_carlos/g1', { c: 2 });
  autoConfirm = true;
  await C1.baroC1RunMiembros({ accion: 'quitar', grupo: 'g1', users: ['@carlos'] }, mkCtx());
  await flush();
  assert(db._get('groupChats/g1/members/u_carlos') === undefined, 'member fuera');
  assert(db._get('userConversations/u_carlos/g1') === undefined, 'inbox fuera');
  assert(db._get('chatUnread/u_carlos/g1') === undefined, 'unread fuera');
  assert(said.some((h) => h.indexOf('eliminados') !== -1), 'mensaje de exito');
});

tcase('miembros: no se puede quitar al creador', async () => {
  reset(); seedGroup('u_me');
  db._set('usernames/dueno', 'u_dueno');
  autoConfirm = true;
  const r = await C1.baroC1RunMiembros({ accion: 'quitar', grupo: 'g1', users: ['@dueno'] }, mkCtx());
  await flush();
  assert(r.html.indexOf('No puedes eliminar al creador') !== -1, 'protege creador');
});

tcase('miembros: grupo por nombre (sin ID)', async () => {
  reset(); seedGroup('u_me');
  db._set('userConversations/u_me/g1', { isGroup: true, groupId: 'g1', groupName: 'Amigos' });
  autoConfirm = true;
  await C1.baroC1RunMiembros({ accion: 'agregar', grupo: '"Amigos"', users: ['@ana'] }, mkCtx());
  await flush();
  eq(db._get('groupChats/g1/members/u_ana'), true, 'resolvio por nombre');
});

/* ---------- 6. antesala ---------- */
tcase('antesala: aceptar elimina el nodo req', async () => {
  reset();
  db._set('userConversations/u_me/room12/req', { from: 'u_x', ts: 1 });
  const r = await C1.baroC1RunAntesala({ accion: 'aceptar', roomId: 'room12' }, mkCtx());
  assert(db._get('userConversations/u_me/room12/req') === undefined, 'req eliminado');
  assert(r.html.indexOf('Solicitud aceptada') !== -1, 'mensaje');
});

tcase('antesala: aceptar sin solicitud -> honesto', async () => {
  reset();
  const r = await C1.baroC1RunAntesala({ accion: 'aceptar', roomId: 'room99' }, mkCtx());
  assert(r.html.indexOf('No hay una solicitud') !== -1, 'honesto');
});

tcase('antesala: rechazar elimina conversacion + unread', async () => {
  reset();
  db._set('userConversations/u_me/room12', { req: { from: 'u_x' } });
  db._set('chatUnread/u_me/room12', { c: 1 });
  const r = await C1.baroC1RunAntesala({ accion: 'rechazar', roomId: 'room12' }, mkCtx());
  assert(db._get('userConversations/u_me/room12') === undefined, 'conversacion fuera');
  assert(db._get('chatUnread/u_me/room12') === undefined, 'unread fuera');
  assert(r.html.indexOf('eliminada') !== -1, 'mensaje');
});

tcase('antesala: roomId invalido y sin sesion', async () => {
  reset();
  let r = await C1.baroC1RunAntesala({ accion: 'aceptar', roomId: 'a/b' }, mkCtx());
  assert(r.html.indexOf('no es válido') !== -1, 'inyeccion rechazada');
  r = await C1.baroC1RunAntesala({ accion: 'aceptar', roomId: 'room12' }, mkCtx(null));
  assert(r.html.indexOf('Inicia sesión') !== -1, 'honesto sin sesion');
});

/* ---------- runner ---------- */
(async () => {
  for (const [name, fn] of CASES) {
    try { await fn(); oks++; console.log('ok   ' + name); }
    catch (e) { fails++; console.log('FAIL ' + name + ' :: ' + e.message); }
  }
  console.log('----');
  console.log(oks + ' ok, ' + fails + ' fallos');
  process.exit(fails ? 1 : 0);
})();
