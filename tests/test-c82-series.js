'use strict';
// Tests de SERIES DREX (v1) — Ciclo 82.
// Uso: node test-c82-series.js [--target <html>]
//   --target: HTML a probar (default: ../index.html, el parcheado).
// Diseñados para FALLAR contra la base sin parche.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const target = (() => {
  const i = process.argv.indexOf('--target');
  return i >= 0 && process.argv[i + 1]
    ? path.resolve(process.argv[i + 1])
    : path.resolve(__dirname, '..', 'index.html');
})();

const html = fs.readFileSync(target, 'utf8');

// ---- extracción de código fuente del HTML ----
function extractFunction(src, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('función no encontrada en el HTML: ' + name);
  let i = src.indexOf('{', m.index);
  if (i < 0) throw new Error('sin cuerpo: ' + name);
  let depth = 0, inStr = null, esc = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error('llaves sin balancear: ' + name);
}
function extractConstObject(src, name) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*\\{').exec(src);
  if (!m) throw new Error('const no encontrada en el HTML: ' + name);
  let i = src.indexOf('{', m.index);
  let depth = 0, inStr = null, esc = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error('llaves sin balancear: ' + name);
}
// Región del payload de Series: desde `var _serieSel` hasta antes de
// `const publishWithAudienceScope` (incluye const note = {...} y la votación).
function extractSeriePayload(src) {
  const fnIdx = src.indexOf('function publishNoteFromFullscreen()');
  if (fnIdx < 0) throw new Error('publishNoteFromFullscreen no encontrado');
  const start = src.indexOf('var _serieSel =', fnIdx);
  if (start < 0) throw new Error('selección de serie (_serieSel) no encontrada en el composer');
  const endIdx = src.indexOf('const publishWithAudienceScope', start);
  if (endIdx < 0 || endIdx < start) throw new Error('fin del payload no encontrado');
  return src.slice(start, endIdx);
}

// ---- sandbox ----
const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const escapeInlineSingleQuote = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function makeLocalStorage() {
  const store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _dump: () => store,
  };
}
function makeSandbox(extra) {
  const sandbox = {
    console,
    appT: (s) => s,
    escapeHtml,
    escapeInlineSingleQuote,
    localStorage: makeLocalStorage(),
    ...extra,
  };
  vm.createContext(sandbox);
  return sandbox;
}
function runIn(sandbox, code) {
  return vm.runInContext(code, sandbox, { timeout: 5000 });
}
const PURE_FNS = [
  'drexSerieNewId', 'drexSerieNormalizeOnda',
  '_drexSerieStore', '_drexSerieLoadList', '_drexSerieSaveList',
  'drexSerieLoadMine', 'drexSerieSaveMine',
  'drexSerieLoadFollowed', 'drexSerieSaveFollowed',
  'drexSerieGet', 'drexSerieCreate', 'drexSerieNextChapter', 'drexSerieBumpChapter',
  'drexSerieFollow', 'drexSerieUnfollow', 'drexSerieIsFollowed', 'drexSerieTouchSeen',
  'drexSerieOf', 'drexSerieChaptersFromPosts', 'drexSerieGroupById', 'drexSerieNewCount',
  'drexSerieAttachToNote', 'drexSerieEnsureOndaInText',
];
function loadPure(sb) {
  runIn(sb, extractConstObject(html, 'DREX_SERIE'));
  PURE_FNS.forEach((n) => runIn(sb, extractFunction(html, n)));
  return sb;
}

// ---- runner ----
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; failures.push(name); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('Target: ' + target);
console.log('');

// ============ T1: normalización de onda ============
console.log('T1 · drexSerieNormalizeOnda');
try {
  const sb = loadPure(makeSandbox());
  const f = (x) => runIn(sb, `drexSerieNormalizeOnda(${JSON.stringify(x)})`);
  check('añade # si falta', f('mihistoria') === '#mihistoria', f('mihistoria'));
  check('minúsculas + quita espacios/símbolos', f('#Hola Mundo!') === '#holamundo', f('#Hola Mundo!'));
  check('unicode-aware (ño, acentos)', f('#cañón_2') === '#cañón_2', f('#cañón_2'));
  check('vacío -> ""', f('') === '' && f('   ') === '' && f('###') === '');
  check('límite 40 chars', f('#' + 'a'.repeat(50)).length === 41);
} catch (e) { check('T1 ejecutable', false, e.message); }
console.log('');

// ============ T2: registro de series propias ============
console.log('T2 · crear / leer / contar capítulos');
try {
  const sb = loadPure(makeSandbox());
  const s = runIn(sb, `drexSerieCreate('u1', '  Mi saga  ', '#MiOnda', 'desc')`);
  check('crea con título recortado', s && s.title === 'Mi saga');
  check('onda normalizada', s && s.onda === '#mionda', s && s.onda);
  check('id estable único', typeof s.id === 'string' && s.id.indexOf('ser') === 0);
  const s2 = runIn(sb, `drexSerieCreate('u1', 'Otra', '', '')`);
  check('ids distintos', s2 && s2.id !== s.id);
  check('título vacío -> null', runIn(sb, `drexSerieCreate('u1', '   ', '', '')`) === null);
  check('título >80 se recorta', runIn(sb, `drexSerieCreate('u1', '${'x'.repeat(90)}', '', '').title`).length === 80);
  check('nextChapter arranca en 1', runIn(sb, `drexSerieNextChapter('u1', ${JSON.stringify(s.id)})`) === 1);
  runIn(sb, `drexSerieBumpChapter('u1', ${JSON.stringify(s.id)})`);
  check('bump -> nextChapter 2', runIn(sb, `drexSerieNextChapter('u1', ${JSON.stringify(s.id)})`) === 2);
  check('bump en serie ajena -> false', runIn(sb, `drexSerieBumpChapter('u2', ${JSON.stringify(s.id)})`) === false);
  check('registro por usuario aislado', runIn(sb, `drexSerieLoadMine('u2')`).length === 0);
} catch (e) { check('T2 ejecutable', false, e.message); }
console.log('');

// ============ T3: capítulos desde posts ============
console.log('T3 · drexSerieChaptersFromPosts / GroupById / NewCount');
try {
  const sb = loadPure(makeSandbox());
  runIn(sb, `
    this.__posts = [
      { id: 'p1', authorId: 'u1', timestamp: 300, series: { id: 's1', title: 'Saga', chapter: 2 } },
      { id: 'p2', authorId: 'u1', timestamp: 100, series: { id: 's1', title: 'Saga', chapter: 1 } },
      { id: 'p3', authorId: 'u1', timestamp: 200, series: { id: 's1', title: 'Saga', chapter: 10 } },
      { id: 'p4', authorId: 'u1', timestamp: 50,  series: { id: 's2', title: 'Otra', chapter: 1 } },
      { id: 'p5', authorId: 'u1', timestamp: 400 },
      { id: 'p6', authorId: 'u1', timestamp: 10,  series: { id: 's1', title: 'Saga' } },
    ];
    this.__ch = drexSerieChaptersFromPosts(this.__posts, 's1');
    this.__groups = drexSerieGroupById(this.__posts);
  `);
  const order = runIn(sb, `this.__ch.map(p => p.id).join(',')`);
  check('filtra por serie y ordena por capítulo', order === 'p2,p1,p3,p6', order);
  check('sin chapter va al final', runIn(sb, `this.__ch[this.__ch.length-1].id`) === 'p6');
  const g1 = runIn(sb, `this.__groups.find(g => g.id === 's1')`);
  check('groupById cuenta capítulos', g1 && g1.chapterCount === 4, JSON.stringify(g1 && g1.chapterCount));
  check('groupById ignora posts sin serie', runIn(sb, `this.__groups.length`) === 2);
  const nc = runIn(sb, `drexSerieNewCount({ lastSeenChapter: 2 }, this.__ch)`);
  check('newCount cuenta > lastSeenChapter', nc === 1, String(nc));
  check('drexSerieOf null-safe', runIn(sb, `drexSerieOf(null) === null && drexSerieOf({}) === null`));
} catch (e) { check('T3 ejecutable', false, e.message); }
console.log('');

// ============ T4: attach + onda en texto ============
console.log('T4 · drexSerieAttachToNote / drexSerieEnsureOndaInText');
try {
  const sb = loadPure(makeSandbox());
  const note = runIn(sb, `
    this.__n = {};
    drexSerieAttachToNote(this.__n, { id: 's9', title: 'Título largo '.repeat(20), onda: '#onda9', chapter: 4 });
    this.__n;
  `);
  check('adjunta note.series', note && note.series && note.series.id === 's9' && note.series.chapter === 4);
  check('título recortado a 80', note.series.title.length <= 80, String(note.series.title.length));
  check('onda viaja en series', note.series.onda === '#onda9');
  check('sin sel -> false y no toca', runIn(sb, `drexSerieAttachToNote({}, null)`) === false);
  const t1 = runIn(sb, `drexSerieEnsureOndaInText('capítulo uno', '#MiOnda')`);
  check('añade el tag al final', t1 === 'capítulo uno #mionda', t1);
  const t2 = runIn(sb, `drexSerieEnsureOndaInText('texto #mionda fin', '#MiOnda')`);
  check('no duplica (case-insensitive)', t2 === 'texto #mionda fin', t2);
  check('onda vacía no toca el texto', runIn(sb, `drexSerieEnsureOndaInText('abc', '')`) === 'abc');
} catch (e) { check('T4 ejecutable', false, e.message); }
console.log('');

// ============ T5: seguir series ============
console.log('T5 · follow / unfollow / touchSeen');
try {
  const sb = loadPure(makeSandbox());
  runIn(sb, `drexSerieFollow('u9', { id: 'sx', authorUid: 'u1', title: 'Saga X', authorName: 'Ana' })`);
  check('isFollowed true', runIn(sb, `drexSerieIsFollowed('u9', 'sx')`) === true);
  runIn(sb, `drexSerieFollow('u9', { id: 'sx', authorUid: 'u1', title: 'Saga X' })`);
  check('doble follow no duplica', runIn(sb, `drexSerieLoadFollowed('u9').length`) === 1);
  runIn(sb, `drexSerieTouchSeen('u9', 'sx', 5)`);
  check('touchSeen guarda el mayor', runIn(sb, `drexSerieLoadFollowed('u9')[0].lastSeenChapter`) === 5);
  runIn(sb, `drexSerieTouchSeen('u9', 'sx', 2)`);
  check('touchSeen no retrocede', runIn(sb, `drexSerieLoadFollowed('u9')[0].lastSeenChapter`) === 5);
  runIn(sb, `drexSerieUnfollow('u9', 'sx')`);
  check('unfollow limpia', runIn(sb, `drexSerieIsFollowed('u9', 'sx')`) === false);
} catch (e) { check('T5 ejecutable', false, e.message); }
console.log('');

// ============ T6: payload del composer ============
console.log('T6 · note.series en el payload de escritura');
try {
  const payload = extractSeriePayload(html);
  check('payload de serie extraído', payload.includes('var _serieSel ='));

  const baseStubs = {
    imageFiles: [], gifUrl: null, notePostVideoFile: null,
    user: { uid: 'u1', displayName: 'Autor' },
    userData: {},
    currentNoteFormat: 'post',
    selectedNoteFlair: null,
    notePostPoll: null,
    getCurrentAudienceConfig: () => ({ id: 'public', label: 'Público' }),
    selectedGroupForPost: null,
  };
  function runPayload(opts) {
    const sb = makeSandbox({
      ...baseStubs,
      notePostPoll: opts.pollOptsFn ? { hours: 24 } : null,
      getValidPollOptions: opts.pollOptsFn || (() => null),
      drexSerieComposerSelection: opts.selectionFn || (() => null),
      drexSerieEnsureOndaInText: null, drexSerieAttachToNote: null,
    });
    loadPure(sb);
    runIn(sb, 'let notePostIsSpoiler = false; let notePostIsSensitive = false;');
    runIn(sb, 'let notePostSerieScriptVote = ' + (opts.scriptVote ? 'true' : 'false') + ';');
    runIn(sb, 'let content = ' + JSON.stringify(opts.text || 'capítulo uno') + ';');
    runIn(sb, payload + '\nthis.__note = note; this.__content = content;');
    return sb;
  }
  // Con serie seleccionada
  const sbOn = runPayload({
    selectionFn: () => ({ id: 's1', title: 'Saga', onda: '#mionda', chapter: 3 }),
  });
  check('note.series con id/title/chapter/onda',
    sbOn.__note.series && sbOn.__note.series.id === 's1' && sbOn.__note.series.chapter === 3 &&
    sbOn.__note.series.title === 'Saga' && sbOn.__note.series.onda === '#mionda',
    JSON.stringify(sbOn.__note.series));
  check('onda añadida al texto', sbOn.__content === 'capítulo uno #mionda', sbOn.__content);
  // Texto que ya trae la onda: no se duplica
  const sbDup = runPayload({
    text: 'ya trae #mionda aquí',
    selectionFn: () => ({ id: 's1', title: 'Saga', onda: '#mionda', chapter: 3 }),
  });
  check('payload no duplica la onda', sbDup.__content === 'ya trae #mionda aquí', sbDup.__content);
  // Sin serie: el campo no existe
  const sbOff = runPayload({});
  check('sin serie no hay note.series', !('series' in sbOff.__note));
  check('sin serie el texto no cambia', sbOff.__content === 'capítulo uno');
  // Votación de guion: pregunta visible
  const sbPoll = runPayload({
    scriptVote: true,
    pollOptsFn: () => ['Dragón', 'Fénix'],
    selectionFn: () => ({ id: 's1', title: 'Saga', onda: '', chapter: 1 }),
  });
  runIn(sbPoll, ''); // noop
  check('poll.q con la pregunta del guion',
    sbPoll.__note.poll && sbPoll.__note.poll.q === '¿Qué pasa en el próximo capítulo?',
    JSON.stringify(sbPoll.__note.poll && sbPoll.__note.poll.q));
  check('opciones de la votación intactas',
    sbPoll.__note.poll && sbPoll.__note.poll.options.length === 2 && sbPoll.__note.poll.total === 0);
} catch (e) { check('T6 ejecutable', false, e.message); }
console.log('');

// ============ T7: insignia con escaping (XSS) ============
console.log('T7 · renderSerieBadge escapa título e IDs');
try {
  const src = extractFunction(html, 'renderSerieBadge');
  check('renderSerieBadge existe', src.includes('drex-serie-badge'));
  check('escapa el título (escapeHtml)', src.includes('escapeHtml(label)'));
  check('escapa IDs en onclick (escapeInlineSingleQuote)',
    src.includes("escapeInlineSingleQuote(note.authorId") && src.includes('escapeInlineSingleQuote(s.id)'));
  const sb = makeSandbox();
  runIn(sb, extractFunction(html, 'drexSerieOf'));
  runIn(sb, "const DREX_SERIE_SVG = '<svg></svg>';");
  runIn(sb, src + '\nthis.__badge = renderSerieBadge;');
  const evil = { authorId: "u1';alert(1)//", series: { id: "s1');alert(2)//", title: '<img src=x onerror=alert(3)>', chapter: 2 } };
  const out = runIn(sb, `this.__badge(${JSON.stringify(evil)})`);
  check('sin serie -> cadena vacía', runIn(sb, `this.__badge({})`) === '');
  check('título escapado', out.includes('&lt;img') && !out.includes('<img src=x'), out.slice(0, 120));
  check('IDs sin romper el onclick (sin comilla sin escapar seguida de );',
    !/[^\\]'\)\s*;/.test(out), out.slice(0, 160));
  check('abre la vista de serie', out.includes("openSerieView("));
} catch (e) { check('T7 ejecutable', false, e.message); }
console.log('');

// ============ T8: i18n real EN/ZH/PT ============
console.log('T8 · DREX_SERIE_I18N completo');
try {
  const sb = makeSandbox();
  runIn(sb, extractConstObject(html, 'DREX_SERIE_I18N') + '\nthis.__i18n = DREX_SERIE_I18N;');
  const keys = runIn(sb, `Object.keys(this.__i18n)`);
  check('hay claves de serie', keys.length >= 20, String(keys.length));
  const missing = runIn(sb, `Object.keys(this.__i18n).filter(k => {
    const m = this.__i18n[k];
    return !(m && m.en && m.zh && m.pt);
  })`);
  check('todas con en/zh/pt', missing.length === 0, JSON.stringify(missing));
  const dupes = runIn(sb, `['Serie','Cap. {n}','Seguir serie','La audiencia vota el guion'].filter(k => !(k in this.__i18n))`);
  check('claves del flujo presentes', dupes.length === 0, JSON.stringify(dupes));
} catch (e) { check('T8 ejecutable', false, e.message); }
console.log('');

// ============ T9: integración estática ============
console.log('T9 · puntos de integración en el HTML');
try {
  check('div serie-view con z-[220]',
    html.includes('id="serie-view"') && /id="serie-view"[^>]*z-\[220\]/.test(html));
  check('ruta serie/:uid/:sid en DREX_ROUTES', html.includes("path: 'serie/:uid/:sid'"));
  check('insignia en buildDrexPostCardHTML', html.includes('renderSerieBadge(note)'));
  check('pregunta q en renderPostPollHTML', extractFunction(html, 'renderPostPollHTML').includes('poll.q'));
  check('panel note-serie-panel en el composer', html.includes('id="note-serie-panel"'));
  check('tab series-tab-content en el perfil', html.includes('id="series-tab-content"'));
  check('botón del tab con data-tab="series"', html.includes('data-tab="series"'));
  check('cargador del tab en el cambiador', html.includes("tabName === 'series'"));
  check('botón Serie en la fila del composer', html.includes('toggleSeriePicker()'));
  check('reset del composer limpia la serie', html.includes('drexSerieComposerReset()'));
  check('bump tras éxito (con id del note)', html.includes('drexSerieChapterBump(note.series'));
  check('onda al texto en el payload', html.includes('drexSerieEnsureOndaInText(content, _serieSel.onda)'));
} catch (e) { check('T9 ejecutable', false, e.message); }
console.log('');

// ============ T10: la serie viaja en borradores y programados ============
console.log('T10 · series en borradores/programados');
try {
  // 10a. collectCurrentNoteDraft guarda seriesSel (sin número: se calcula al disparar)
  const sbD = makeSandbox({
    document: { getElementById: () => ({ value: 'mi capítulo' }) },
    currentEditingDraftId: null,
    currentNoteFormat: 'post',
    currentNoteAudience: 'public',
  });
  loadPure(sbD);
  runIn(sbD, extractFunction(html, 'collectCurrentNoteDraft'));
  runIn(sbD, 'this.__sel = { id: "s77", title: "Saga 77", onda: "#onda77", chapter: 5 };');
  runIn(sbD, 'this.__d = (function(){ const _orig = null; return null; })();');
  // inyectar la selección simulando el composer
  runIn(sbD, 'drexSerieComposerSelection = () => this.__sel;');
  const d = runIn(sbD, 'collectCurrentNoteDraft()');
  check('draft guarda seriesSel', d.seriesSel && d.seriesSel.id === 's77' && d.seriesSel.onda === '#onda77',
    JSON.stringify(d.seriesSel));
  check('draft no congela el número de capítulo', d.seriesSel && !('chapter' in d.seriesSel),
    JSON.stringify(d.seriesSel));

  // 10b. drexSchedBuildNote adjunta la serie validada contra el registro
  const sbS = makeSandbox();
  loadPure(sbS);
  runIn(sbS, extractFunction(html, 'drexSchedResolveAudience'));
  const avLine = html.split('\n').find((l) => l.includes('const DREX_SCHED_DEFAULT_AVATAR ='));
  runIn(sbS, avLine.trim() + '\nthis.__av = DREX_SCHED_DEFAULT_AVATAR;');
  runIn(sbS, extractFunction(html, 'drexSchedBuildNote'));
  const created = runIn(sbS, `drexSerieCreate('u1', 'Saga Real', '#OndaReal', '')`);
  const sid = created.id;
  const noteSched = runIn(sbS, `drexSchedBuildNote(
    { content: 'capítulo uno', audience: 'public', seriesSel: { id: ${JSON.stringify(sid)}, title: 'Viejo', onda: '#vieja' } },
    { uid: 'u1' }, {}
  )`);
  check('programado adjunta note.series', noteSched.series && noteSched.series.id === sid,
    JSON.stringify(noteSched.series));
  check('capítulo = siguiente al disparar', noteSched.series && noteSched.series.chapter === 1,
    JSON.stringify(noteSched.series && noteSched.series.chapter));
  check('título/onda frescos del registro', noteSched.series && noteSched.series.title === 'Saga Real' && noteSched.series.onda === '#ondareal',
    JSON.stringify(noteSched.series));
  check('onda añadida al texto programado', noteSched.content === 'capítulo uno #ondareal', noteSched.content);
  check('marca drexScheduled intacta', noteSched.drexScheduled === true);

  // 10c. serie eliminada del registro -> se publica sin serie
  runIn(sbS, `drexSerieSaveMine('u1', [])`);
  const noteNoSerie = runIn(sbS, `drexSchedBuildNote(
    { content: 'capítulo x', audience: 'public', seriesSel: { id: ${JSON.stringify(sid)}, title: 'Saga Real', onda: '#ondareal' } },
    { uid: 'u1' }, {}
  )`);
  check('serie borrada no se adjunta', !('series' in noteNoSerie));
  check('sin serie el texto no cambia', noteNoSerie.content === 'capítulo x');

  // 10d. estático: el bump tras éxito lee el id del note persistido
  check('bump usa note.series.id', html.includes('drexSerieChapterBump(note.series && note.series.id)'));
} catch (e) { check('T10 ejecutable', false, e.message); }
console.log('');

// ---- resumen ----
console.log('----------------------------------------');
console.log(`Resultado: ${passed} PASS, ${failed} FAIL`);
if (failed) { console.log('Fallos: ' + failures.join(' | ')); process.exit(1); }
