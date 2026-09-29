/* ================================================================
 * DATA-INTEGRITY — cascadeDeleteNote: la limpieza de medios y comentarios
 * debe ESPERARSE antes de reportar éxito.
 *
 * HALLAZGO (bug real, verificado en código): en cascadeDeleteNote
 * (index.html) el borrado del post principal se esperaba (await), pero las
 * limpiezas de `noteImages/<noteId>`, `noteVideos/<noteId>` y
 * `postComments/<noteId>` eran fire-and-forget
 * (`.remove().catch(() => {})` sin await). La función cerraba el visor y
 * devolvía `true` ("Publicación eliminada.") con esas escrituras aún en
 * vuelo: cerrar la app o navegar en ese instante dejaba medios y/o el
 * árbol completo de comentarios huérfanos en la BD.
 *
 * FIX (index.html, cascadeDeleteNote): las limpiezas se esperan con
 * `await Promise.allSettled(...)` antes de cerrar el visor y devolver
 * `true`. allSettled (no all): una limpieza lenta o fallida no cancela
 * las demás. El post ya está borrado, así que un fallo residual se traga
 * igual que el resto de la cascada, pero desaparece la ventana de
 * orfandad por no esperar. Además se borran los subárboles post-céntricos
 * postEcos/<noteId>, postSavedBy/<noteId> (solo-escritura, sin lectores) y
 * el legacy postReposts/<noteId>.
 *
 * Este test extrae cascadeDeleteNote del index.html real y la ejecuta en
 * sandbox con un DrexCloud falso donde el borrado de postComments tarda
 * 400 ms. Afirma que la promesa devuelta NO se resuelve antes de que las
 * tres limpiezas terminen y de que el visor se cierre después.
 *
 * Ejecutar con: node tests/test-dataintegrity-cascade-await.js
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let failures = 0;
function tcase(name, fn) {
  try {
    const ok = fn();
    console.log((ok ? 'ok - ' : 'NOT OK - ') + name);
    if (!ok) failures++;
  } catch (e) {
    console.log('NOT OK - ' + name + ' [excepción: ' + (e && e.message) + ']');
    failures++;
  }
}

// ---------- Extractor (misma técnica que los harnesses del ciclo) ----------
function extractFn(source, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(source);
  if (!m) throw new Error('no se encontró ' + name);
  const start = m.index;
  let i = source.indexOf('(', m.index), j, pdepth = 0, depth = 0, inStr = null, esc = false;
  for (j = i; j < source.length; j++) {
    const c = source[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(') pdepth++; else if (c === ')') { pdepth--; if (pdepth === 0) break; }
  }
  const bodyStart = source.indexOf('{', j);
  inStr = null; esc = false;
  for (j = bodyStart; j < source.length; j++) {
    const c = source[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(start, j + 1);
}

// ---------- DrexCloud falso ----------
const deep = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const store = {};
const events = []; // orden de eventos: 'removed:<path>', 'viewerClosed', 'resolved'
const slowPaths = {}; // path -> ms de retardo en remove()
const snapOf = (v) => ({ val: () => deep(v), exists: () => v !== undefined && v !== null });
function makeRef(p) {
  return {
    once: () => Promise.resolve(snapOf(store[p])),
    set: (v) => { store[p] = deep(v); return Promise.resolve(); },
    remove: () => {
      const delay = slowPaths[p] || 0;
      return new Promise((res) => setTimeout(() => {
        delete store[p];
        events.push('removed:' + p);
        res();
      }, delay));
    }
  };
}
const DrexCloud = {
  auth: () => ({ currentUser: { uid: 'u1' } }),
  database: () => ({ ref: (p) => makeRef(p) })
};

const sandbox = {
  console, DrexCloud,
  window: {},
  isValidChatUid: () => false,
  _closeViewerIfShowingNote: () => { events.push('viewerClosed'); },
  setTimeout, clearTimeout, Promise
};
vm.createContext(sandbox);
vm.runInContext(extractFn(html, 'cascadeDeleteNote'), sandbox);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // Semilla: post + índices + medios + comentarios.
  store['communityNotes/n1'] = { authorId: 'u1' };
  store['notesByAuthor/u1/n1'] = true;
  store['noteImages/n1'] = { img_1: true };
  store['noteVideos/n1'] = { vid_1: true };
  store['postComments/n1'] = { c1: true };
  store['postEcos/n1'] = { u9: { t: 1 } };
  store['postSavedBy/n1'] = { u9: true };
  store['postReposts/n1'] = { u9: true };
  // El borrado de comentarios es lento (400 ms): con el bug, la función ya
  // devolvió `true` mucho antes de que termine.
  slowPaths['postComments/n1'] = 400;

  const ret = vm.runInContext("cascadeDeleteNote('n1', { authorId: 'u1' })", sandbox);
  const result = await ret;
  events.push('resolved');
  // Dar margen a que las escrituras flotantes (si las hay) terminen.
  await sleep(700);

  const idx = (e) => events.indexOf(e);
  tcase('devuelve true', () => result === true);
  tcase('post principal borrado', () => store['communityNotes/n1'] === undefined);
  tcase('noteImages limpiado', () => store['noteImages/n1'] === undefined);
  tcase('noteVideos limpiado', () => store['noteVideos/n1'] === undefined);
  tcase('postComments limpiado', () => store['postComments/n1'] === undefined);
  tcase('postEcos limpiado (subárbol post-céntrico)', () => store['postEcos/n1'] === undefined);
  tcase('postSavedBy limpiado (índice solo-escritura)', () => store['postSavedBy/n1'] === undefined);
  tcase('postReposts limpiado (legacy)', () => store['postReposts/n1'] === undefined);
  tcase('la función NO se resuelve antes de terminar postComments',
    () => idx('removed:postComments/n1') !== -1 && idx('removed:postComments/n1') < idx('resolved'));
  tcase('el visor se cierra DESPUÉS de la limpieza (no antes)',
    () => idx('viewerClosed') !== -1 && idx('removed:postComments/n1') < idx('viewerClosed'));

  console.log(failures ? ('\n' + failures + ' prueba(s) en ROJO') : '\nTODO VERDE');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FALLO del harness:', e); process.exit(2); });
