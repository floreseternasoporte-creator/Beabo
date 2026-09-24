/* ================================================================
 * C145 — ENCUESTA SIN TEXTO (post de solo-encuesta; función nueva).
 *
 * HALLAZGO (hueco real, re-verificado contra el código): el composer
 * permite armar una encuesta (toggle Votación) pero el flujo la trataba
 * como accesorio del texto: un post de SOLO-encuesta era imposible en
 * 6 puntos:
 *   1. publishNoteFromFullscreen() exigía texto/foto/video/GIF: la
 *      encuesta sola mostraba "Por favor escribe algo..." y no publicaba.
 *   2. saveCurrentNoteDraft() exigía texto: el borrador de solo-encuesta
 *      no se guardaba ("Nada que guardar").
 *   3. drexFlushNoteDraftOnPageHide() solo miraba el textarea: al salir,
 *      una encuesta sin texto se perdía.
 *   4. openScheduleSheetFromComposer() exigía texto ("Escribe algo primero
 *      para programarlo."): no se podía programar una solo-encuesta.
 *   5. publishOneScheduledDraft() descartaba como 'empty' todo borrador
 *      sin texto, aunque trajera encuesta válida.
 *   6. Editar las opciones de la encuesta (setPollOption/add/remove/
 *      setPollDuration/toggleNotePoll) no disparaba el autoguardado del
 *      borrador: teclear solo opciones nunca persistía nada.
 * Además renderDraftsList() mostraba "Borrador vacío" aunque el borrador
 * trajera votación (ahora muestra las opciones como avance).
 *
 * CAMBIO (index.html):
 *  - publishNoteFromFullscreen: pollOpts se calcula antes de la puerta;
 *    la puerta admite encuesta válida; toast actualizado + i18n EN/ZH/PT.
 *  - saveCurrentNoteDraft / drexFlushNoteDraftOnPageHide: también guardan
 *    cuando el editor solo trae encuesta (drexDraftPollFromEditor con
 *    guardas typeof para extracciones de tests viejos).
 *  - openScheduleSheetFromComposer: admite solo-encuesta; mensaje nuevo.
 *  - publishOneScheduledDraft: el chequeo 'empty' exige encuesta
 *    PUBLICABLE (drexDraftPollForPublish >=2 opciones): una encuesta a
 *    medio escribir no publica un post vacío y se descarta como antes.
 *  - pollEditorAutosave(): helper que dispara handleNoteDraftInput()
 *    (debounce 450ms), llamado desde las 5 funciones del editor.
 *  - renderDraftsList: avance = opciones de la encuesta si no hay texto.
 *
 * Ejecutar con: node tests/test-c145-poll-only-post.js [--target base.html]
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const _ti = process.argv.indexOf('--target');
const _target = _ti >= 0 && process.argv[_ti + 1] ? path.resolve(process.argv[_ti + 1]) : path.join(ROOT, 'index.html');
const html = fs.readFileSync(_target, 'utf8');

let failures = 0;
function tcase(name, fn) {
  try {
    const ok = (typeof fn === 'function') ? fn() : !!fn;
    console.log((ok ? 'ok - ' : 'NOT OK - ') + name);
    if (!ok) failures++;
  } catch (e) {
    console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
    failures++;
  }
}
const asyncTests = [];
function tcaseAsync(name, fn) { asyncTests.push([name, fn]); }

// Extrae el cuerpo de `function NAME(...) { ... }` (mismo patrón que
// tests/test-c128-draft-flush.js).
function extractFnBody(src, fnName) {
  const start = src.indexOf('function ' + fnName + '(');
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

// ---------- A. Aserciones estáticas (hit por hit) ----------
const publishBody = extractFnBody(html, 'publishNoteFromFullscreen');
tcase('A1 publishNoteFromFullscreen existe', publishBody !== null);
if (publishBody) {
  tcase('A2 la puerta de publicación admite encuesta (pollOpts)', /!\s*_c145GatePollOpts/.test(publishBody));
  tcase('A3 el gate calcula la encuesta antes de la puerta', publishBody.indexOf('_c145GatePollOpts = getValidPollOptions()') !== -1 && publishBody.indexOf('_c145GatePollOpts = getValidPollOptions()') < publishBody.indexOf('Por favor escribe algo'));
  tcase('A4 toast nuevo menciona la votación', publishBody.includes('Por favor escribe algo, agrega una foto, video o GIF, o crea una votación'));
  tcase('A5 el toast viejo ya no se usa', !html.includes("appT('Por favor escribe algo o agrega una foto, video o GIF')"));
}
tcase('A6 el payload de Series conserva su propio pollOpts (tests viejos por marcadores)',
  (html.match(/const pollOpts = getValidPollOptions\(\);/g) || []).length === 1 &&
  (html.match(/const _c145GatePollOpts = getValidPollOptions\(\);/g) || []).length === 1);

const saveBody = extractFnBody(html, 'saveCurrentNoteDraft');
tcase('A7 saveCurrentNoteDraft existe', saveBody !== null);
if (saveBody) {
  tcase('A8 el guardado manual admite solo-encuesta (drexDraftPollFromEditor)', /drexDraftPollFromEditor/.test(saveBody));
  tcase('A9 la guarda typeof protege extracciones viejas', /typeof drexDraftPollFromEditor/.test(saveBody));
}

const flushBody = extractFnBody(html, 'drexFlushNoteDraftOnPageHide');
tcase('A10 drexFlushNoteDraftOnPageHide existe', flushBody !== null);
if (flushBody) {
  tcase('A11 el flush en pagehide admite solo-encuesta', /drexDraftPollFromEditor/.test(flushBody));
  tcase('A12 el flush sigue mirando el textarea', /getElementById\s*\(\s*['"]note-content-fullscreen['"]/.test(flushBody));
}

const schedSheetBody = extractFnBody(html, 'openScheduleSheetFromComposer');
tcase('A13 openScheduleSheetFromComposer existe', schedSheetBody !== null);
if (schedSheetBody) {
  tcase('A14 programar desde el composer admite solo-encuesta', /getValidPollOptions/.test(schedSheetBody));
  tcase('A15 mensaje nuevo de programar sin contenido', schedSheetBody.includes('Escribe algo o crea una votación para programarlo.'));
  tcase('A16 el mensaje viejo ya no se usa', !html.includes("appT('Escribe algo primero para programarlo.')"));
}

const schedPubBody = extractFnBody(html, 'publishOneScheduledDraft');
tcase('A17 publishOneScheduledDraft existe', schedPubBody !== null);
if (schedPubBody) {
  tcase("A18 el descarte 'empty' exige encuesta publicable (>=2 opciones)", /drexDraftPollForPublish\s*\(\s*draft\.poll/.test(schedPubBody));
}

const editorFns = ['toggleNotePoll', 'setPollOption', 'addPollOption', 'removePollOption', 'setPollDuration'];
editorFns.forEach(fnName => {
  const b = extractFnBody(html, fnName);
  tcase('A19 ' + fnName + ' dispara el autoguardado', !!b && /pollEditorAutosave\s*\(\s*\)/.test(b));
});
const autosaveBody = extractFnBody(html, 'pollEditorAutosave');
tcase('A20 pollEditorAutosave existe', autosaveBody !== null);
if (autosaveBody) {
  tcase('A21 pollEditorAutosave llama handleNoteDraftInput con guarda typeof',
    /typeof handleNoteDraftInput/.test(autosaveBody) && /handleNoteDraftInput\s*\(\s*\)/.test(autosaveBody));
}

const draftsListBody = extractFnBody(html, 'renderDraftsList');
tcase('A22 renderDraftsList existe', draftsListBody !== null);
if (draftsListBody) {
  tcase('A23 el avance del borrador muestra las opciones de la encuesta', /drexDraftPollFromEditor/.test(draftsListBody) && /\.join\(['"] · ['"]\)/.test(draftsListBody));
}

// i18n ES/EN/ZH/PT de las 2 cadenas nuevas.
const K1 = 'Por favor escribe algo, agrega una foto, video o GIF, o crea una votación';
const K2 = 'Escribe algo o crea una votación para programarlo.';
tcase('A24 i18n EN de las 2 cadenas', html.includes("'" + K1 + "': 'Please write something") && html.includes("'" + K2 + "': 'Write something or create a poll"));
tcase('A25 i18n ZH de las 2 cadenas', html.includes("'" + K1 + "': '请写点内容") && html.includes("'" + K2 + "': '写点内容或创建一个投票"));
tcase('A26 i18n PT de las 2 cadenas', html.includes("'" + K1 + "': 'Escreva algo") && html.includes("'" + K2 + "': 'Escreva algo ou crie"));

// ---------- B. Conductuales en sandbox (bloque DREX-SCHEDULED-POSTS) ----------
const START = '// === DREX-SCHEDULED-POSTS: INICIO ===';
const END = '// === DREX-SCHEDULED-POSTS: FIN ===';
const si = html.indexOf(START);
const ei = html.indexOf(END);
tcase('B0 bloque DREX-SCHEDULED-POSTS extraíble', si !== -1 && ei !== -1 && ei > si);

let block = null;
if (si !== -1 && ei !== -1 && ei > si) {
  block = html.slice(si, ei + END.length);
  const sandbox = { console, appT: s => s };
  vm.createContext(sandbox);
  try {
    vm.runInContext(block, sandbox, { filename: 'c145-sched-block.js' });
    sandbox.__ok = true;
  } catch (e) {
    sandbox.__ok = false;
    sandbox.__err = e.message;
  }
  tcase('B1 el bloque corre en sandbox', () => sandbox.__ok === true);

  const NOW = 1_787_000_000_000; // reloj falso fijo
  function makeWorld(drafts) {
    const store = { list: drafts.map(d => ({ ...d })) };
    const published = [];
    const notified = [];
    const user = { uid: 'u1', displayName: 'Tester' };
    const deps = {
      testMode: true,
      now: () => NOW,
      getDrafts: () => store.list.map(d => ({ ...d })),
      saveDrafts: l => { store.list = l.map(d => ({ ...d })); },
      currentUser: () => user,
      readUserData: async () => ({ username: 'tester_1' }),
      readFollowing: async () => ({ u1: true }),
      moderate: () => ({ flagged: false }),
      notify: m => notified.push(m),
      publishNote: (note, popts) => { published.push(note); popts.onDone(true); }
    };
    return { store, published, notified, deps };
  }
  const duePollOnly = (over = {}) => ({
    id: 'd1', content: '', poll: { options: ['Opción A', 'Opción B'], hours: 24 },
    format: 'post', audience: 'public', updatedAt: NOW - 5000, publishAt: NOW - 1000, ...over
  });

  if (sandbox.__ok && typeof sandbox.publishOneScheduledDraft === 'function') {
    tcaseAsync('B2 solo-encuesta vencida SE PUBLICA (no se descarta)', async () => {
      const w = makeWorld([duePollOnly()]);
      const r = await sandbox.publishOneScheduledDraft('d1', w.deps);
      if (r.status !== 'published') return false;
      if (w.published.length !== 1) return false;
      const note = w.published[0];
      return note.content === '' && note.poll && note.poll.options.length === 2 &&
        note.poll.total === 0 && Number(note.poll.endsAt) > NOW && w.store.list.length === 0;
    });
    tcaseAsync('B3 solo-encuesta con 1 opción válida se descarta (empty)', async () => {
      const w = makeWorld([duePollOnly({ poll: { options: ['Solo una', ''], hours: 24 } })]);
      const r = await sandbox.publishOneScheduledDraft('d1', w.deps);
      return r.status === 'empty' && w.published.length === 0 && w.store.list.length === 0;
    });
    tcaseAsync('B4 borrador vacío de verdad sigue descartándose (empty)', async () => {
      const w = makeWorld([duePollOnly({ content: '', poll: null })]);
      const r = await sandbox.publishOneScheduledDraft('d1', w.deps);
      return r.status === 'empty' && w.published.length === 0;
    });
    tcaseAsync('B5 texto normal sigue publicándose (sin regresión)', async () => {
      const w = makeWorld([duePollOnly({ content: 'Hola', poll: null })]);
      const r = await sandbox.publishOneScheduledDraft('d1', w.deps);
      return r.status === 'published' && w.published.length === 1 && !w.published[0].poll;
    });
    tcaseAsync('B6 texto + encuesta publica ambos (sin regresión)', async () => {
      const w = makeWorld([duePollOnly({ content: 'Voten' })]);
      const r = await sandbox.publishOneScheduledDraft('d1', w.deps);
      return r.status === 'published' && w.published[0].content === 'Voten' &&
        w.published[0].poll && w.published[0].poll.options.length === 2;
    });
    tcase('B7 drexDraftHasPoll: true con encuesta, false sin ella', () => {
      const f = sandbox.drexDraftHasPoll;
      return typeof f === 'function' &&
        f({ poll: { options: ['A', 'B'], hours: 24 } }) === true &&
        f({ poll: { options: ['  ', ''], hours: 24 } }) === false &&
        f({ content: 'x' }) === false;
    });
  }
}

// ---------- C. Conductuales del flush (extracción como test-c128) ----------
if (flushBody) {
  function runFlush(sandbox) {
    sandbox.console = { warn() {}, error() {} };
    vm.createContext(sandbox);
    vm.runInContext('(function(){' + flushBody + '})()', sandbox);
    return sandbox;
  }
  tcase('C1 flush: textarea vacío + encuesta válida -> SÍ guarda', () => {
    let saved = false;
    const sb = {
      _noteDraftSaveTimer: null,
      clearTimeout() {},
      document: { getElementById() { return { value: '   ' }; } },
      saveCurrentNoteDraft() { saved = true; },
      // El editor trae encuesta con 2 opciones: drexDraftPollFromEditor real
      // no está en el sandbox; se inyecta el helper mínimo equivalente.
      drexDraftPollFromEditor(raw) {
        if (!raw || !Array.isArray(raw.options)) return null;
        const options = raw.options.slice(0, 4).map(t => String(t == null ? '' : t).slice(0, 60));
        if (!options.some(t => t.trim())) return null;
        return { options, hours: 24 };
      },
      notePostPoll: { options: ['A', 'B'], hours: 24 }
    };
    runFlush(sb);
    return saved === true;
  });
  tcase('C2 flush: textarea vacío + sin encuesta -> NO guarda (sin regresión)', () => {
    let saved = false;
    const sb = {
      _noteDraftSaveTimer: null,
      clearTimeout() {},
      document: { getElementById() { return { value: '   ' }; } },
      saveCurrentNoteDraft() { saved = true; }
      // Sin drexDraftPollFromEditor en el sandbox: la guarda typeof lo salta.
    };
    runFlush(sb);
    return saved === false;
  });
  tcase('C3 flush: textarea con texto -> SÍ guarda (sin regresión)', () => {
    let saved = false;
    const sb = {
      _noteDraftSaveTimer: null,
      clearTimeout() {},
      document: { getElementById() { return { value: 'algo' }; } },
      saveCurrentNoteDraft() { saved = true; }
    };
    runFlush(sb);
    return saved === true;
  });
}

(async () => {
  for (const [name, fn] of asyncTests) {
    try {
      const ok = await fn();
      console.log((ok ? 'ok - ' : 'NOT OK - ') + name);
      if (!ok) failures++;
    } catch (e) {
      console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
      failures++;
    }
  }
  if (failures > 0) { console.error(failures + ' FAILURES'); process.exit(1); }
  console.log('TODOS OK');
})();
