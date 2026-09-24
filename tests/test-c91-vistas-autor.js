'use strict';
// Tests de VISTAS DEL AUTOR — badge "N vistas" en la tarjeta del propio post
// (Ciclo 91, fase 2c del hueco #2 del roadmap: Pulso).
// Uso: node test-c91-vistas-autor.js [--target <html>]
//   --target: HTML a probar (default: ../index.html, el parcheado).
// Diseñados para FALLAR contra la base sin parche (C90).
//
// Verifica:
//  (a) núcleo puro extraído verbatim y ejecutado en sandbox:
//      drexViewsOwnShouldShow, drexViewsOwnCount, drexViewsOwnBadgeHTML,
//      drexViewsOwnBadgeForNote;
//  (b) integración estática: llamada en la fila de acciones de
//      buildDrexPostCardHTML, regla CSS .drex-views-stat, sección fuera de
//      los marcadores viejos, sin escrituras a BD, sin onclick/ids nuevos;
//  (c) i18n: reutiliza appT('vistas') del merge de Pulso (×3 idiomas).
//
// Convención del repo: resuelve ../index.html con fallback a ../src/index.html;
// no depende del historial de git; sin rutas absolutas.
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

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); }
}
function eq(a, b, name) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  ok(sa === sb, name + ' (got ' + sa + ', want ' + sb + ')');
}
function tcase(name, fn) {
  try { fn(); } catch (e) { ok(false, name + ' (throw: ' + e.message + ')'); }
}

function extractFunction(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no encontrada: ' + name);
  let j = src.indexOf('{', i), depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}
function extractBlock(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('no encontrado: ' + startMarker);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error('no encontrado: ' + endMarker);
  return src.slice(i, j + endMarker.length);
}

// ---- sandbox con el núcleo puro ----
const escStub = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sandbox = {
  console,
  escapeHtml: escStub,
  formatNumber: (n) => String(n),
  appT: (s) => s,
};
vm.createContext(sandbox);
let coreSrc = '';
tcase('T0 extracción del núcleo', () => {
  coreSrc =
    extractFunction(html, 'drexViewsOwnShouldShow') + '\n' +
    extractFunction(html, 'drexViewsOwnCount') + '\n' +
    extractFunction(html, 'drexViewsOwnBadgeHTML') + '\n' +
    extractFunction(html, 'drexViewsOwnBadgeForNote') + '\n' +
    'this.__c91 = { drexViewsOwnShouldShow, drexViewsOwnCount, drexViewsOwnBadgeHTML, drexViewsOwnBadgeForNote };';
  vm.runInContext(coreSrc, sandbox, { filename: 'c91-core.js' });
  ok(true, 'T0 núcleo extraído y compilado');
});
const C = sandbox.__c91 || null;

// ---- (a) drexViewsOwnShouldShow ----
tcase('T1 autor coincide', () => {
  eq(C.drexViewsOwnShouldShow({ authorId: 'u1' }, 'u1'), true, 'T1');
});
tcase('T2 otro usuario no ve', () => {
  eq(C.drexViewsOwnShouldShow({ authorId: 'u1' }, 'u2'), false, 'T2');
});
tcase('T3 nota nula/inválida', () => {
  eq(C.drexViewsOwnShouldShow(null, 'u1'), false, 'T3a');
  eq(C.drexViewsOwnShouldShow(undefined, 'u1'), false, 'T3b');
  eq(C.drexViewsOwnShouldShow({}, 'u1'), false, 'T3c sin authorId');
  eq(C.drexViewsOwnShouldShow('x', 'u1'), false, 'T3d nota no-objeto');
});
tcase('T4 viewerUid inválido', () => {
  eq(C.drexViewsOwnShouldShow({ authorId: 'u1' }, ''), false, 'T4a vacío');
  eq(C.drexViewsOwnShouldShow({ authorId: 'u1' }, null), false, 'T4b null');
  eq(C.drexViewsOwnShouldShow({ authorId: 'u1' }, undefined), false, 'T4c undefined');
  eq(C.drexViewsOwnShouldShow({ authorId: 'u1' }, 123), false, 'T4d número');
});
tcase('T5 fallback userId', () => {
  eq(C.drexViewsOwnShouldShow({ userId: 'u7' }, 'u7'), true, 'T5a userId coincide');
  eq(C.drexViewsOwnShouldShow({ authorId: 'u1', userId: 'u2' }, 'u2'), false, 'T5b authorId manda');
});
tcase('T6 fail-closed con tipos raros', () => {
  eq(C.drexViewsOwnShouldShow({ authorId: 123 }, '123'), false, 'T6a número vs string');
  eq(C.drexViewsOwnShouldShow({ authorId: 'u1 ' }, 'u1'), false, 'T6b sin trim');
});

// ---- (a) drexViewsOwnCount ----
tcase('T7 conteo normal', () => {
  eq(C.drexViewsOwnCount({ viewCount: 42 }), 42, 'T7a');
  eq(C.drexViewsOwnCount({ viewCount: '123' }), 123, 'T7b string numérico');
  eq(C.drexViewsOwnCount({ viewCount: 0 }), 0, 'T7c cero');
});
tcase('T8 conteo borde', () => {
  eq(C.drexViewsOwnCount({}), 0, 'T8a ausente');
  eq(C.drexViewsOwnCount(null), 0, 'T8b nota nula');
  eq(C.drexViewsOwnCount({ viewCount: NaN }), 0, 'T8c NaN');
  eq(C.drexViewsOwnCount({ viewCount: -5 }), 0, 'T8d negativo');
  eq(C.drexViewsOwnCount({ viewCount: 'abc' }), 0, 'T8e no-numérico');
  eq(C.drexViewsOwnCount({ viewCount: Infinity }), 0, 'T8f infinito');
  eq(C.drexViewsOwnCount({ viewCount: 4.7 }), 4, 'T8g piso');
  eq(C.drexViewsOwnCount({ viewCount: '1e3' }), 1000, 'T8h exponencial');
});

// ---- (a) drexViewsOwnBadgeHTML ----
tcase('T9 badge básico', () => {
  const h = C.drexViewsOwnBadgeHTML(7, 'vistas');
  ok(h.indexOf('drex-views-stat') >= 0, 'T9a clase');
  ok(h.indexOf('>7</span>') >= 0, 'T9b conteo');
  ok(h.indexOf('aria-label="7 vistas"') >= 0, 'T9c aria');
  ok(h.indexOf('title="7 vistas"') >= 0, 'T9d title');
  ok(h.indexOf('<svg') >= 0, 'T9e icono');
  ok(h.indexOf('onclick') < 0, 'T9f sin onclick');
  ok(h.indexOf('id=') < 0, 'T9g sin ids');
});
tcase('T10 badge escapa entrada hostil', () => {
  const h = C.drexViewsOwnBadgeHTML(3, 'vis"><img src=x onerror=alert(1)>');
  ok(h.indexOf('<img') < 0, 'T10a sin tag inyectado');
  ok(h.indexOf('&lt;img') >= 0, 'T10b escapado');
});
tcase('T11 badge normaliza conteo', () => {
  ok(C.drexViewsOwnBadgeHTML(-9, 'vistas').indexOf('>0</span>') >= 0, 'T11a negativo→0');
  ok(C.drexViewsOwnBadgeHTML('25', 'vistas').indexOf('>25</span>') >= 0, 'T11b string');
  ok(C.drexViewsOwnBadgeHTML(NaN, 'vistas').indexOf('>0</span>') >= 0, 'T11c NaN→0');
  ok(C.drexViewsOwnBadgeHTML(8, null).indexOf('aria-label="8 "') >= 0, 'T11d label nulo');
});

// ---- (a) drexViewsOwnBadgeForNote ----
tcase('T12 badgeForNote autor', () => {
  const h = C.drexViewsOwnBadgeForNote({ authorId: 'u1', viewCount: 15 }, { uid: 'u1' });
  ok(h.indexOf('drex-views-stat') >= 0 && h.indexOf('>15</span>') >= 0, 'T12a badge del autor');
});
tcase('T13 badgeForNote no-autor', () => {
  eq(C.drexViewsOwnBadgeForNote({ authorId: 'u1', viewCount: 15 }, { uid: 'u2' }), '', 'T13a otro');
  eq(C.drexViewsOwnBadgeForNote({ authorId: 'u1' }, null), '', 'T13b sin sesión');
  eq(C.drexViewsOwnBadgeForNote({ authorId: 'u1' }, {}), '', 'T13c sin uid');
  eq(C.drexViewsOwnBadgeForNote(null, { uid: 'u1' }), '', 'T13d nota nula');
});
tcase('T14 badgeForNote fail-closed', () => {
  const bad = { get authorId() { throw new Error('boom'); } };
  eq(C.drexViewsOwnBadgeForNote(bad, { uid: 'u1' }), '', 'T14a throw→""');
});

// ---- (b) integración estática ----
tcase('T15 sección nueva existe y está fuera de marcadores viejos', () => {
  const start = html.indexOf('// ============ VISTAS DEL AUTOR');
  const end = html.indexOf('// ============ /VISTAS DEL AUTOR');
  ok(start >= 0 && end > start, 'T15a marcadores');
  const oldEnd = html.indexOf('// ============ /VISTAS DE PULSO =');
  ok(oldEnd >= 0 && start > oldEnd, 'T15b fuera del bloque viejo VISTAS DE PULSO');
  const oldEnd2 = html.indexOf('// ============ /VISTAS DIARIAS DE PULSO');
  ok(oldEnd2 >= 0 && start > oldEnd2, 'T15c fuera del bloque C90');
});
tcase('T16 llamada en la fila de acciones del builder', () => {
  const bi = html.indexOf('function buildDrexPostCardHTML(');
  ok(bi >= 0, 'T16a builder existe');
  const call = html.indexOf('${drexViewsOwnBadgeForNote(note, user)}', bi);
  ok(call >= 0, 'T16b llamada interpolada');
  const actRow = html.indexOf('<div class="drex-post-actions">', bi);
  ok(actRow >= 0 && call > actRow, 'T16c dentro de la fila de acciones');
});
tcase('T17 CSS del badge', () => {
  ok(html.indexOf('.drex-views-stat') >= 0, 'T17a regla existe');
  ok(html.indexOf('margin-left: auto') >= 0 || html.indexOf('margin-left:auto') >= 0, 'T17b al final de la fila');
});
tcase('T18 sin escrituras a BD en la sección nueva', () => {
  const sec = extractBlock(html, '// ============ VISTAS DEL AUTOR', '// ============ /VISTAS DEL AUTOR');
  ok(sec.indexOf('DrexCloud.database()') < 0, 'T18a sin database()');
  ok(sec.indexOf('.set(') < 0 && sec.indexOf('.update(') < 0 && sec.indexOf('.remove(') < 0, 'T18b sin escrituras');
  ok(sec.indexOf('onclick') < 0, 'T18c sin onclick');
  ok(sec.indexOf('innerHTML') < 0, 'T18d sin innerHTML directo');
});
tcase('T19 sin campos write-only ni índices numéricos', () => {
  const sec = extractBlock(html, '// ============ VISTAS DEL AUTOR', '// ============ /VISTAS DEL AUTOR');
  ['drexViewsOwnShouldShow', 'drexViewsOwnCount', 'drexViewsOwnBadgeHTML', 'drexViewsOwnBadgeForNote'].forEach((fn) => {
    ok(html.split(fn).length - 1 >= 2, 'T19a ' + fn + ' se lee donde se define');
  });
  ok(!/\[\s*\d+\s*\]/.test(sec.replace(/r="3"|12\s*S|5\.7|18\.3/g, '')), 'T19b sin índices numéricos de datos');
});

// ---- (c) i18n ----
tcase('T20 appT("vistas") resuelve en los 3 idiomas del merge de Pulso', () => {
  const n = (html.match(/'vistas':/g) || []).length;
  ok(n >= 3, 'T20a vistas en EN/ZH/PT (' + n + ')');
  ok(html.indexOf("Object.assign(APP_ENGLISH_TEXT") >= 0, 'T20b merge a dict global');
  const sec = extractBlock(html, '// ============ VISTAS DEL AUTOR', '// ============ /VISTAS DEL AUTOR');
  ok(sec.indexOf("appT('vistas')") >= 0, 'T20c el badge usa la clave existente');
});

// ---- resumen ----
console.log('pass=' + pass + ' fail=' + fail);
if (failures.length) console.log('FAILURES:\n' + failures.join('\n'));
process.exit(fail ? 1 : 0);
