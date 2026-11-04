'use strict';
// Tests del carril 8H (OLEADA 3 v4 — BORRADORES/GUARDADOS/HISTORIAL) de BARO.
// Cubre: registro (baroRegisterTool/BARO_ICONS/baroIntentRules/baroIntentToTool),
// intents ES/EN/ZH/PT (extract puros + declinaciones), i18n en 4 idiomas,
// confirmacion obligatoria en quitar de guardados, retomar borrador con el
// ancla real resumeNoteDraft (hueco honesto si falta), mensaje honesto sin
// sesion con cero escrituras (borradores = dato local del dispositivo y
// funcionan sin sesion), y ausencia del literal de cierre de script.
// El bloque se EXTRAE de index.html (patron oleada 1 / c103-c110), no del
// archivo del carril: marcador 'BARO · sub-bloque 8H'.
// Uso: node test-c117-baro-borradores.js [--target <ruta-a-index.html>]
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
const src = __v4ExtractBlock('BARO · sub-bloque 8H');

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
  assert(src.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en el bloque extraido (8H)');
  const tsrc = fs.readFileSync(__filename, 'utf8');
  assert(tsrc.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en test-c117-baro-borradores.js');
});

/* ---------- stubs de plataforma + carga del bloque en sandbox (vm) ---------- */
const registered = {};
const said = [];
const confirmCalls = [];
const resumed = [];
const __dModule = { exports: {} };
function makeLocalStorage() {
  const dict = {};
  return {
    _dict: dict,
    getItem: (k) => (k in dict ? dict[k] : null),
    setItem: (k, v) => { dict[k] = String(v); },
    removeItem: (k) => { delete dict[k]; }
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
  baroAskConfirm: function (opts) { confirmCalls.push(opts); return { card: true }; },
  localStorage: makeLocalStorage()
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'block-lane-8h.js' });
const M = __dModule.exports;
assert(M && M.pure && M.tools && M.BARO_I18N_H && M.BARO_H_RULES,
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
  resumed.length = 0;
  sandbox.localStorage = makeLocalStorage();
  const fake = makeStore(seed);
  sandbox.DrexCloud = { database: () => fake };
  delete sandbox.baro6dGetDrafts;
  delete sandbox.getAllNoteDrafts;
  delete sandbox.resumeNoteDraft;
  return fake;
}
function seedDrafts(uid, list) {
  sandbox.localStorage.setItem('drex_note_drafts_v3_' + (uid || 'guest'), JSON.stringify(list));
}
let stepSeq = 0;
function makeCtx(uid) {
  return {
    user: uid ? { uid } : null,
    step: (l) => 's' + (++stepSeq),
    stepDone: () => {},
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  };
}

const P = M.pure, T = M.tools;

/* ---------- 1. registro ---------- */
const TOOL_NAMES = ['borradores_listar', 'borrador_retomar', 'guardados_listar',
  'guardados_quitar', 'historial_ver'];

tcase('registro: 5 herramientas con label i18n y run', () => {
  TOOL_NAMES.forEach((n) => {
    assert(registered[n], 'no registrada: ' + n);
    assert(typeof registered[n].run === 'function', 'run no es funcion: ' + n);
    assert(M.BARO_I18N_H[registered[n].label], 'label sin i18n: ' + n);
  });
  eqJ(Object.keys(registered).sort(), TOOL_NAMES.slice().sort(), 'nombres registrados');
});
tcase('registro: BARO_ICONS con 5 svg propios indigo sin emoji', () => {
  const want = ['borradores', 'borrador-retomar', 'guardados', 'guardados-quitar', 'historial'];
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  want.forEach((k) => {
    const svg = sandbox.BARO_ICONS[k];
    assert(typeof svg === 'string' && svg.indexOf('<svg') === 0, 'icono ausente/invalido: ' + k);
    assert(svg.indexOf('#2F33B8') !== -1, 'icono sin indigo #2F33B8: ' + k);
    assert(!emojiRe.test(svg), 'icono con emoji: ' + k);
  });
});
tcase('registro: 5 reglas en baroIntentRules + mapa intent->tool', () => {
  assert(sandbox.baroIntentRules.length === 5, 'reglas: ' + sandbox.baroIntentRules.length);
  sandbox.baroIntentRules.forEach((r) => {
    eqJ(r.langs, ['es', 'en', 'zh', 'pt'], 'langs de ' + r.intent);
    assert(Array.isArray(r.patterns) && r.patterns.length > 0, 'patterns vacios: ' + r.intent);
    r.patterns.forEach((p) => assert(Object.prototype.toString.call(p) === '[object RegExp]', 'pattern no RegExp en ' + r.intent));
    assert(typeof r.extract === 'function', 'extract no es funcion: ' + r.intent);
  });
  TOOL_NAMES.forEach((n) => assert(sandbox.baroIntentToTool[n] === n, 'mapa sin ' + n));
  eqJ(sandbox.baroIntentToTool.drafts_list, 'borradores_listar', 'alias EN drafts_list');
  eqJ(sandbox.baroIntentToTool.resume_draft, 'borrador_retomar', 'alias EN resume_draft');
  eqJ(sandbox.baroIntentToTool.saved_list, 'guardados_listar', 'alias EN saved_list');
  eqJ(sandbox.baroIntentToTool.unsave, 'guardados_quitar', 'alias EN unsave');
  eqJ(sandbox.baroIntentToTool.history_view, 'historial_ver', 'alias EN history_view');
});
tcase('BARO_H_RULES exportadas coinciden con lo registrado', () => {
  eqJ(M.BARO_H_RULES.map((r) => r.intent).sort(), TOOL_NAMES.slice().sort(), 'intents de reglas');
});
tcase('fusion i18n: BARO_UI_I18N y APP_*_TEXT reciben las claves', () => {
  sandbox.BARO_UI_I18N = {};
  vm.runInContext(src, sandbox, { filename: 'block-lane-8h-refuse.js' });
  assert(sandbox.BARO_UI_I18N['baro.tool.borr.label_listar'], 'BARO_UI_I18N sin fusion');
  eqJ(sandbox.APP_ENGLISH_TEXT['baro.tool.guard.label_listar'], 'My saved posts', 'APP_ENGLISH_TEXT');
  eqJ(sandbox.APP_CHINESE_TEXT['baro.tool.hist.label'], '我的历史记录', 'APP_CHINESE_TEXT');
  eqJ(sandbox.APP_PORTUGUESE_TEXT['baro.tool.borr.label_retomar'], 'Retomar um rascunho', 'APP_PORTUGUESE_TEXT');
  delete sandbox.BARO_UI_I18N;
});

/* ---------- 2. i18n 4 idiomas ---------- */
tcase('i18n: toda clave tiene es/en/zh/pt no vacios', () => {
  const keys = Object.keys(M.BARO_I18N_H);
  assert(keys.length > 30, 'pocas claves: ' + keys.length);
  keys.forEach((k) => {
    assert(k.indexOf('baro.tool.borr.') === 0 || k.indexOf('baro.tool.guard.') === 0 || k.indexOf('baro.tool.hist.') === 0, 'prefijo raro: ' + k);
    const e = M.BARO_I18N_H[k];
    ['es', 'en', 'zh', 'pt'].forEach((l) => {
      assert(e && typeof e[l] === 'string' && e[l].trim().length > 0, k + ' sin ' + l);
    });
  });
});
tcase('i18n: traducciones difieren del ES en puntos clave', () => {
  const b = M.BARO_I18N_H['baro.tool.borr.label_listar'];
  assert(b.en !== b.es && b.zh !== b.es && b.pt !== b.es, 'borr.label_listar sin traducir');
  const g = M.BARO_I18N_H['baro.tool.guard.label_quitar'];
  assert(g.en !== g.es && g.zh !== g.es && g.pt !== g.es, 'guard.label_quitar sin traducir');
  const h = M.BARO_I18N_H['baro.tool.hist.label'];
  assert(h.en !== h.es && h.zh !== h.es && h.pt !== h.es, 'hist.label sin traducir');
});

/* ---------- 3. intents / extract puros ---------- */
tcase('extract borradores ES/EN/ZH/PT + declina retomar', () => {
  eqJ(P.baroHExtractBorradores('ver mis borradores'), {}, 'ES');
  eqJ(P.baroHExtractBorradores('show my drafts'), {}, 'EN');
  eqJ(P.baroHExtractBorradores('查看我的草稿'), {}, 'ZH');
  eqJ(P.baroHExtractBorradores('ver meus rascunhos'), {}, 'PT');
  assert(P.baroHExtractBorradores('retoma el borrador 2') === null, 'listar robo "retoma el borrador"');
  assert(P.baroHExtractBorradores('resume draft 1') === null, 'listar robo "resume draft"');
  assert(P.baroHExtractBorradores('hola') === null, 'listar acepto texto sin borrador');
});
tcase('extract retomar: indice/id en 4 idiomas + declina sin verbo', () => {
  eqJ(P.baroHExtractRetomar('retoma el borrador 2'), { indice: 2 }, 'ES indice');
  eqJ(P.baroHExtractRetomar('abre el segundo borrador'), { indice: 2 }, 'ES ordinal');
  eqJ(P.baroHExtractRetomar('resume draft 1'), { indice: 1 }, 'EN');
  eqJ(P.baroHExtractRetomar('open the first draft'), { indice: 1 }, 'EN ordinal');
  eqJ(P.baroHExtractRetomar('继续编辑第3个草稿'), { indice: 3 }, 'ZH');
  eqJ(P.baroHExtractRetomar('retomar o rascunho 2'), { indice: 2 }, 'PT');
  eqJ(P.baroHExtractRetomar('retoma el borrador draft_9x_ab12'), { id: 'draft_9x_ab12' }, 'id directo');
  assert(P.baroHExtractRetomar('mis borradores') === null, 'retomar robo "mis borradores"');
});
tcase('extract guardados ES/EN/ZH/PT + declinaciones', () => {
  eqJ(P.baroHExtractGuardados('ver mis guardados'), {}, 'ES');
  eqJ(P.baroHExtractGuardados('show my saved posts'), {}, 'EN');
  eqJ(P.baroHExtractGuardados('查看我的收藏'), {}, 'ZH');
  eqJ(P.baroHExtractGuardados('ver meus salvos'), {}, 'PT');
  assert(P.baroHExtractGuardados('quita el segundo guardado') === null, 'listar robo "quita el guardado"');
  assert(P.baroHExtractGuardados('unsave the first one from saved') === null, 'listar robo unsave');
  assert(P.baroHExtractGuardados('guarda este post') === null, 'listar robo accion guardar');
  assert(P.baroHExtractGuardados('historial de guardados') === null, 'listar robo historial');
});
tcase('extract quitar: indice/id + exige verbo de quitar', () => {
  eqJ(P.baroHExtractQuitar('quita el guardado 2'), { indice: 2 }, 'ES indice');
  eqJ(P.baroHExtractQuitar('elimina el primer guardado'), { indice: 1 }, 'ES ordinal');
  eqJ(P.baroHExtractQuitar('unsave the second saved post'), { indice: 2 }, 'EN');
  eqJ(P.baroHExtractQuitar('取消收藏第1个'), { indice: 1 }, 'ZH');
  eqJ(P.baroHExtractQuitar('remover o salvo 3'), { indice: 3 }, 'PT');
  eqJ(P.baroHExtractQuitar('quita de guardados el post -Nabc123XYZ_-'), { id: '-Nabc123XYZ_-' }, 'noteId');
  assert(P.baroHExtractQuitar('ver mis guardados') === null, 'quitar robo listar');
  assert(P.baroHExtractQuitar('guarda este post') === null, 'quitar robo guardar');
});
tcase('extract historial: resumen y secciones + declina borrar', () => {
  eqJ(P.baroHExtractHistorial('ver mi historial'), {}, 'resumen ES');
  eqJ(P.baroHExtractHistorial('show my history'), {}, 'resumen EN');
  eqJ(P.baroHExtractHistorial('查看历史记录'), {}, 'resumen ZH');
  eqJ(P.baroHExtractHistorial('ver meu histórico'), {}, 'resumen PT');
  eqJ(P.baroHExtractHistorial('historial de mis votos'), { seccion: 'votos' }, 'sec votos');
  eqJ(P.baroHExtractHistorial('historial de ecos'), { seccion: 'ecos' }, 'sec ecos');
  eqJ(P.baroHExtractHistorial('historial de comentarios'), { seccion: 'comentarios' }, 'sec comentarios');
  eqJ(P.baroHExtractHistorial('historial de guardados'), { seccion: 'guardados' }, 'sec guardados');
  assert(P.baroHExtractHistorial('borra mi historial') === null, 'historial robo borrar');
});

/* ---------- 4. borradores: listar ---------- */
const D1 = { id: 'draft_1', content: 'Hola mundo, este es mi primer borrador de prueba', updatedAt: 1000 };
const D2 = { id: 'draft_2', content: 'Segundo borrador con encuesta', poll: { options: [{ t: 'a' }] }, updatedAt: 2000 };
const D3 = { id: 'draft_3', content: '', updatedAt: 3000 };
const D4 = { id: 'draft_4', content: '   ', poll: { options: [{ t: 'x' }, { t: 'y' }] }, updatedAt: 4000 };

tcase('borradores_listar: conteo real + vistas previas (fallback localStorage)', async () => {
  setPlatform({});
  seedDrafts('me', [D1, D2, D4]);
  const r = await T.borradores_listar({}, makeCtx('me'));
  const h = String(r.html);
  assert(h.indexOf('Tus borradores (3)') !== -1, 'conteo real ausente: ' + h);
  assert(h.indexOf('Hola mundo') !== -1, 'preview D1 ausente');
  assert(h.indexOf('[Solo encuesta]') !== -1, 'preview encuesta ausente');
  assert(confirmCalls.length === 0, 'lectura no debe confirmar');
});
tcase('borradores_listar: vacios honesto', async () => {
  setPlatform({});
  const r = await T.borradores_listar({}, makeCtx('me'));
  assert(String(r.html).indexOf('No tienes borradores') !== -1, 'vacios ausente');
});
tcase('borradores_listar: prefiere el helper BARO baro6dGetDrafts si existe', async () => {
  setPlatform({});
  sandbox.baro6dGetDrafts = () => [D2];
  const r = await T.borradores_listar({}, makeCtx('me'));
  assert(String(r.html).indexOf('Tus borradores (1)') !== -1, 'no uso el helper preferido');
  delete sandbox.baro6dGetDrafts;
});
tcase('borradores_listar: funciona sin sesion (dato local), cero escrituras', async () => {
  const fake = setPlatform({});
  seedDrafts('guest', [D1]);
  const before = JSON.stringify(fake._root) + JSON.stringify(sandbox.localStorage._dict);
  const r = await T.borradores_listar({}, makeCtx(null));
  assert(String(r.html).indexOf('Tus borradores (1)') !== -1, 'sin sesion debio listar: ' + r.html);
  assert(JSON.stringify(fake._root) + JSON.stringify(sandbox.localStorage._dict) === before, 'hubo escrituras sin sesion');
});

/* ---------- 5. borrador_retomar ---------- */
tcase('borrador_retomar: usa el ancla real resumeNoteDraft con el id', async () => {
  setPlatform({});
  seedDrafts('me', [D1, D2]);
  sandbox.resumeNoteDraft = (id) => { resumed.push(id); };
  const r = await T.borrador_retomar({ indice: 1 }, makeCtx('me'));
  eqJ(resumed, ['draft_2'], 'debió retomar el mas reciente (indice 1)');
  assert(String(r.html).indexOf('Abriendo tu borrador') !== -1, 'mensaje abriendo ausente');
  assert(confirmCalls.length === 0, 'retomar no debe confirmar');
});
tcase('borrador_retomar: por id directo', async () => {
  setPlatform({});
  seedDrafts('me', [D1, D2]);
  sandbox.resumeNoteDraft = (id) => { resumed.push(id); };
  await T.borrador_retomar({ id: 'draft_1' }, makeCtx('me'));
  eqJ(resumed, ['draft_1'], 'id directo');
});
tcase('borrador_retomar: sin objetivo -> pregunta con lista numerada', async () => {
  setPlatform({});
  seedDrafts('me', [D1, D2]);
  sandbox.resumeNoteDraft = (id) => { resumed.push(id); };
  const r = await T.borrador_retomar({}, makeCtx('me'));
  const h = String(r.html);
  assert(h.indexOf('¿Cuál borrador retomo?') !== -1, 'pregunta ausente');
  assert(h.indexOf('1.') !== -1 && h.indexOf('2.') !== -1, 'lista numerada ausente');
  assert(resumed.length === 0, 'abrio composer sin objetivo');
});
tcase('borrador_retomar: id inexistente -> honesto, sin abrir', async () => {
  setPlatform({});
  seedDrafts('me', [D1]);
  sandbox.resumeNoteDraft = (id) => { resumed.push(id); };
  const r = await T.borrador_retomar({ id: 'draft_nope' }, makeCtx('me'));
  assert(String(r.html).indexOf('¿Cuál borrador retomo?') !== -1 || String(r.html).indexOf('No encontré') !== -1, 'honesto ausente: ' + r.html);
  assert(resumed.length === 0, 'abrio composer con id inexistente');
});
tcase('borrador_retomar: sin ancla -> hueco honesto, sin throw', async () => {
  setPlatform({});
  seedDrafts('me', [D1]);
  const r = await T.borrador_retomar({ indice: 1 }, makeCtx('me'));
  assert(String(r.html).indexOf('Mis borradores') !== -1, 'hueco honesto ausente: ' + r.html);
});
tcase('borrador_retomar: cero escrituras (solo abre el composer)', async () => {
  const fake = setPlatform({});
  seedDrafts('me', [D1]);
  sandbox.resumeNoteDraft = (id) => { resumed.push(id); };
  const before = JSON.stringify(fake._root) + JSON.stringify(sandbox.localStorage._dict);
  await T.borrador_retomar({ indice: 1 }, makeCtx('me'));
  assert(JSON.stringify(fake._root) + JSON.stringify(sandbox.localStorage._dict) === before, 'hubo escrituras');
});

/* ---------- 6. guardados: listar ---------- */
tcase('guardados_listar: conteo real + previews de communityNotes', async () => {
  setPlatform({
    savedPosts: { me: { n2: { savedAt: 200 }, n1: { savedAt: 100 } } },
    communityNotes: {
      n1: { content: 'Primer post guardado con texto largo de prueba', author: 'ana' },
      n2: { content: '', poll: { options: [{ t: 'x' }] }, authorName: 'beto' }
    }
  });
  const r = await T.guardados_listar({}, makeCtx('me'));
  const h = String(r.html);
  assert(h.indexOf('Tus guardados (2)') !== -1, 'conteo real ausente: ' + h);
  assert(h.indexOf('Primer post guardado') !== -1, 'preview n1 ausente');
  assert(h.indexOf('@ana') !== -1, 'autor n1 ausente');
  assert(h.indexOf('[Solo encuesta]') !== -1, 'preview encuesta ausente');
  assert(confirmCalls.length === 0, 'lectura no debe confirmar');
});
tcase('guardados_listar: vacios honesto', async () => {
  setPlatform({});
  const r = await T.guardados_listar({}, makeCtx('me'));
  assert(String(r.html).indexOf('Aún no tienes posts guardados') !== -1, 'vacios ausente');
});

/* ---------- 7. guardados_quitar: confirmacion + escrituras ---------- */
tcase('guardados_quitar: pide confirmacion y NO escribe antes', async () => {
  const fake = setPlatform({
    savedPosts: { me: { n1: { savedAt: 100 }, n2: { savedAt: 200 } } },
    postSavedBy: { n1: { me: true } },
    communityNotes: { n1: { content: 'Post a quitar', author: 'ana' } }
  });
  const res = await T.guardados_quitar({ indice: 2 }, makeCtx('me'));
  assert(confirmCalls.length === 1, 'sin tarjeta de confirmacion');
  assert(String(confirmCalls[0].titleKey).indexOf('Quitar de guardados') !== -1, 'titulo confirm ausente');
  assert(String(confirmCalls[0].previewHtml).indexOf('Post a quitar') !== -1, 'preview sin texto del post');
  assert(String(res.card) === 'true' || res, 'debio devolver la tarjeta');
  assert(fake._get('savedPosts/me/n1') !== undefined, 'escribio antes de confirmar');
  assert(typeof confirmCalls[0].onConfirm === 'function' && typeof confirmCalls[0].onCancel === 'function', 'faltan onConfirm/onCancel');
});
tcase('guardados_quitar: al confirmar borra savedPosts + postSavedBy', async () => {
  const fake = setPlatform({
    savedPosts: { me: { n1: { savedAt: 100 }, n2: { savedAt: 200 } } },
    postSavedBy: { n1: { me: true }, n2: { me: true } },
    communityNotes: { n1: { content: 'Post a quitar' } }
  });
  await T.guardados_quitar({ indice: 2 }, makeCtx('me'));
  await confirmCalls[0].onConfirm();
  assert(fake._get('savedPosts/me/n1') === undefined, 'no borro savedPosts');
  assert(fake._get('postSavedBy/n1/me') === undefined, 'no borro el espejo postSavedBy');
  assert(fake._get('savedPosts/me/n2') !== undefined, 'borro un guardado ajeno');
  assert(said.some((m) => m.indexOf('Quitado de tus guardados.') !== -1), 'mensaje ok ausente: ' + JSON.stringify(said));
});
tcase('guardados_quitar: cancelar no escribe', async () => {
  const fake = setPlatform({
    savedPosts: { me: { n1: { savedAt: 100 } } },
    communityNotes: { n1: { content: 'Post a quitar' } }
  });
  const before = JSON.stringify(fake._root);
  await T.guardados_quitar({ indice: 1 }, makeCtx('me'));
  await confirmCalls[0].onCancel();
  assert(JSON.stringify(fake._root) === before, 'hubo escrituras al cancelar');
  assert(said.some((m) => m.indexOf('Cancelado, sigue en tus guardados.') !== -1), 'mensaje cancelado ausente');
});
tcase('guardados_quitar: sin objetivo -> lista numerada y pregunta', async () => {
  setPlatform({
    savedPosts: { me: { n1: { savedAt: 100 } } },
    communityNotes: { n1: { content: 'Post dudoso' } }
  });
  const r = await T.guardados_quitar({}, makeCtx('me'));
  const h = String(r.html);
  assert(h.indexOf('¿Cuál quito de guardados?') !== -1, 'pregunta ausente');
  assert(h.indexOf('1.') !== -1, 'lista numerada ausente');
  assert(confirmCalls.length === 0, 'confirmo sin objetivo');
});
tcase('guardados_quitar: indice fuera de rango -> honesto sin confirmar', async () => {
  setPlatform({
    savedPosts: { me: { n1: { savedAt: 100 } } },
    communityNotes: { n1: { content: 'Post' } }
  });
  const r = await T.guardados_quitar({ indice: 9 }, makeCtx('me'));
  assert(String(r.html).indexOf('¿Cuál quito de guardados?') !== -1, 'honesto ausente');
  assert(confirmCalls.length === 0, 'confirmo con indice invalido');
});

/* ---------- 8. historial_ver ---------- */
tcase('historial_ver: resumen con 4 conteos reales', async () => {
  setPlatform({
    savedPosts: { me: { n1: { savedAt: 1 }, n2: { savedAt: 2 } } },
    userVotes: { me: { n1: 'up', n3: 'down' } },
    userPollVotes: { me: { n4: 123 } },
    userEcos: { me: { n5: { timestamp: 1 } } },
    userReposts: { me: { n5: { timestamp: 1 }, n6: { timestamp: 2 } } },
    userComments: { me: { c1: { content: 'Buen post', timestamp: 50, noteId: 'n1', postAuthorName: 'ana' } } }
  });
  const r = await T.historial_ver({}, makeCtx('me'));
  const h = String(r.html);
  assert(h.indexOf('Tu historial') !== -1, 'titulo ausente');
  assert(h.indexOf('Guardados (2)') !== -1, 'conteo guardados ausente: ' + h);
  assert(h.indexOf('Votos (2)') !== -1, 'conteo votos ausente (1 up + 1 poll)');
  assert(h.indexOf('Ecos (2)') !== -1, 'conteo ecos ausente (merge sin duplicados)');
  assert(h.indexOf('Comentarios (1)') !== -1, 'conteo comentarios ausente');
  assert(h.indexOf('Buen post') !== -1, 'preview de comentario ausente');
  assert(confirmCalls.length === 0, 'lectura no debe confirmar');
});
tcase('historial_ver: seccion votos detalla con previews', async () => {
  setPlatform({
    userVotes: { me: { n1: 'up' } },
    communityNotes: { n1: { content: 'Post votado por mi', author: 'carlos' } }
  });
  const r = await T.historial_ver({ seccion: 'votos' }, makeCtx('me'));
  const h = String(r.html);
  assert(h.indexOf('Votos (1)') !== -1, 'seccion votos ausente');
  assert(h.indexOf('Post votado por mi') !== -1, 'preview del voto ausente');
  assert(h.indexOf('Guardados') === -1, 'seccion filtro fugo otras secciones');
});
tcase('historial_ver: vacio honesto', async () => {
  setPlatform({});
  const r = await T.historial_ver({}, makeCtx('me'));
  assert(String(r.html).indexOf('Aún no hay actividad') !== -1, 'vacio ausente');
});

/* ---------- 9. sin sesion: honesto, cero escrituras ---------- */
tcase('sin sesion: guardados e historial honestos con cero escrituras', async () => {
  const fake = setPlatform({
    savedPosts: { me: { n1: { savedAt: 100 } } },
    userVotes: { me: { n1: 'up' } }
  });
  seedDrafts('guest', [{ id: 'draft_g', content: 'borrador invitado', updatedAt: 1 }]);
  const before = JSON.stringify(fake._root) + JSON.stringify(sandbox.localStorage._dict);
  const calls = [
    ['guardados_listar', {}],
    ['guardados_quitar', { indice: 1 }],
    ['historial_ver', {}]
  ];
  for (const [name, args] of calls) {
    const r = await T[name](args, makeCtx(null));
    assert(String(r.html).indexOf('Inicia sesión') !== -1, name + ' sin need_login: ' + r.html);
  }
  const rb = await T.borradores_listar({}, makeCtx(null));
  assert(String(rb.html).indexOf('Tus borradores (1)') !== -1, 'borradores sin sesion debio listar (dato local)');
  assert(confirmCalls.length === 0, 'se pidio confirmacion sin sesion');
  assert(JSON.stringify(fake._root) + JSON.stringify(sandbox.localStorage._dict) === before, 'hubo escrituras sin sesion');
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
  console.log('c117-baro-borradores: ' + oks + ' ok, ' + fails + ' fallos, ' + CASES.length + ' casos');
  process.exit(fails ? 1 : 0);
})();
