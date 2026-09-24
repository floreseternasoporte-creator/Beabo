'use strict';
// Tests de la función CONTENIDO FUERTE (Drex Feature Lab).
// Uso: node test-sensitive-content.js [--target <html>]
//   --target: HTML a probar (default: ../index.html, el parcheado).
// Diseñados para FALLAR contra la base sin parche (ver PATCH_NOTES.md).
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

// Región del payload de escritura: desde "const note = {" dentro de
// publishNoteFromFullscreen() hasta antes de "const publishWithAudienceScope".
function extractNotePayload(src) {
  const fnIdx = src.indexOf('function publishNoteFromFullscreen()');
  if (fnIdx < 0) throw new Error('publishNoteFromFullscreen no encontrado');
  const noteIdx = src.indexOf('const note = {', fnIdx);
  if (noteIdx < 0) throw new Error('const note = { no encontrado en el composer');
  const endIdx = src.indexOf('const publishWithAudienceScope', noteIdx);
  if (endIdx < 0 || endIdx < noteIdx) throw new Error('fin del payload no encontrado');
  return src.slice(noteIdx, endIdx);
}

// ---- sandbox ----
const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const escapeInlineSingleQuote = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function makeSandbox(extra) {
  const sandbox = {
    console,
    appT: (s) => s, // idioma base ES
    escapeHtml,
    escapeInlineSingleQuote,
    DREX_EYE_OFF_SVG: '<svg class="eye-off"></svg>',
    CSS: { escape: (s) => String(s).replace(/"/g, '\\"') },
    document: { querySelectorAll: () => [] },
    getHiddenPosts: () => [],
    getAdultContentPreference: () => true,
    isAdultContentNote: () => false,
    isAccountBlockedForCurrentUser: () => false,
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'viewer1' } }),
      database: () => ({ ref: () => ({ once: () => Promise.resolve({ val: () => null }) }) }),
    },
    ...extra,
  };
  vm.createContext(sandbox);
  return sandbox;
}

function runIn(sandbox, code) {
  return vm.runInContext(code, sandbox, { timeout: 5000 });
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

// ============ T1: el flag viaja en el payload de escritura ============
console.log('T1 · flag note.sensitive en el payload de escritura');
try {
  const payload = extractNotePayload(html);
  check('payload extraído del composer', payload.includes('const note = {'));

  const composerStubs = {
    content: 'hola mundo',
    user: { uid: 'u1', displayName: 'Autor' },
    userData: {},
    currentNoteFormat: 'post',
    selectedNoteFlair: null,
    getValidPollOptions: () => null,
    notePostPoll: null,
    getCurrentAudienceConfig: () => ({ id: 'public', label: 'Público' }),
    selectedGroupForPost: null,
  };

  // Flag activado -> note.sensitive === true
  const sbOn = makeSandbox({ ...composerStubs });
  runIn(sbOn, 'let notePostIsSpoiler = false; let notePostIsSensitive = true;\n' + payload + '\nthis.__note = note;');
  check('toggle ON escribe note.sensitive === true', sbOn.__note && sbOn.__note.sensitive === true,
    'obtenido: ' + JSON.stringify(sbOn.__note && sbOn.__note.sensitive));

  // Flag apagado -> el campo NO existe (no se ensucia la BD con false)
  const sbOff = makeSandbox({ ...composerStubs });
  runIn(sbOff, 'let notePostIsSpoiler = false; let notePostIsSensitive = false;\n' + payload + '\nthis.__note = note;');
  check('toggle OFF no escribe el campo (ausente)', sbOff.__note && !('sensitive' in sbOff.__note),
    'obtenido: ' + JSON.stringify(sbOff.__note && sbOff.__note.sensitive));

  // El payload canónico sigue intacto
  check('campos canónicos intactos', sbOn.__note && sbOn.__note.upvotes === 0 && sbOn.__note.authorId === 'u1');
} catch (e) {
  check('T1 ejecutable', false, e.message);
}
console.log('');

// ============ T2: el velo se aplica solo cuando sensitive === true ============
console.log('T2 · velo índigo (sensitiveVeilWrap)');
try {
  const fnSrc = extractFunction(html, 'sensitiveVeilWrap');
  check('sensitiveVeilWrap existe en el HTML', fnSrc.includes('drex-sensitive-veil'));
  const sb = makeSandbox();
  runIn(sb, fnSrc + '\nthis.__wrap = sensitiveVeilWrap;');
  const wrap = sb.__wrap;
  const BODY = '<p>cuerpo del post</p>';

  const out = wrap({ id: 'n1', sensitive: true }, BODY);
  check('sensitive=true aplica el velo', typeof out === 'string' && out.includes('drex-sensitive-veil'));
  check('el velo conserva el cuerpo tapado', out.includes('drex-sensitive-blur') && out.includes(BODY));
  check('botón Mostrar presente', out.includes('drex-sensitive-cover') && out.includes('>Mostrar<'));
  check('etiqueta "Contenido fuerte" presente', out.includes('>Contenido fuerte<'));
  check('data-sensitive-card con id', out.includes('data-sensitive-card="n1"'));
  check('onclick usa drexSensitiveReveal', out.includes("drexSensitiveReveal('n1')"));

  check('sensitive ausente: sin velo (devuelve el HTML intacto)', wrap({ id: 'n2' }, BODY) === BODY);
  check('sensitive=false: sin velo', wrap({ id: 'n3', sensitive: false }, BODY) === BODY);
  check('note null: sin velo', wrap(null, BODY) === BODY);

  // XSS: el id llega crudo de la BD (forjable vía router /post/:id)
  const evil = wrap({ id: `a'b"><img src=x onerror=alert(1)>`, sensitive: true }, BODY);
  // Doble escape en el handler: \' protege el literal JS, &quot; el atributo HTML.
  check('id forjado no rompe el handler inline', evil.includes("drexSensitiveReveal('a\\'b&quot;&gt;&lt;img") && !evil.includes('"><img src=x onerror'));
  // En el data-attr (entre comillas dobles) basta escapar " < > &: el ' crudo es seguro ahí.
  check('id con HTML escapado en el data-attr',
    evil.includes('data-sensitive-card="a\'b&quot;&gt;&lt;img') && !evil.includes('"><img src=x onerror'));

  check('drexSensitiveReveal existe en el HTML', html.includes('function drexSensitiveReveal'));
} catch (e) {
  check('T2 ejecutable', false, e.message);
}
console.log('');

// ============ T3: el filtro parental excluye del feed ============
console.log('T3 · filtro parental "Ocultar contenido sensible"');
try {
  const fnSrc = extractFunction(html, 'shouldHideNoteForCurrentUser');
  const hasBranch = fnSrc.includes('_drexSensitiveFilterSession');
  check('shouldHideNoteForCurrentUser cablea el filtro parental', hasBranch,
    'sin la rama _drexSensitiveFilterSession el toggle sigue muerto');

  const mkSb = (sessionVal, viewerUid) => {
    const sb = makeSandbox();
    if (viewerUid !== undefined) {
      sb.DrexCloud = { auth: () => ({ currentUser: viewerUid ? { uid: viewerUid } : null }), database: sb.DrexCloud.database };
    }
    runIn(sb, 'let _drexSensitiveFilterSession = ' + JSON.stringify(sessionVal) + ';\n' + fnSrc + '\nthis.__hide = shouldHideNoteForCurrentUser;');
    return sb.__hide;
  };

  const hideOn = mkSb(true, 'viewer1');
  check('post sensible de otro autor: EXCLUIDO del feed', hideOn('p1', { sensitive: true, authorId: 'autor9' }) === true);
  check('post sensible del propio autor: visible (gestionable)', hideOn('p2', { sensitive: true, authorId: 'viewer1' }) === false);
  check('post sensible, autor por userId legacy: visible si es el visor', hideOn('p3', { sensitive: true, userId: 'viewer1' }) === false);
  check('post NO sensible con filtro ON: visible', hideOn('p4', { authorId: 'autor9' }) === false);
  check('post sensible=false con filtro ON: visible', hideOn('p5', { sensitive: false, authorId: 'autor9' }) === false);
  check('sensitive como string "true": NO filtra (booleano estricto)', hideOn('p6', { sensitive: 'true', authorId: 'autor9' }) === false);

  const hideOff = mkSb(false, 'viewer1');
  check('filtro parental OFF: post sensible visible', hideOff('p1', { sensitive: true, authorId: 'autor9' }) === false);

  const hideNull = mkSb(null, 'viewer1');
  check('caché sin cargar (null): fail-open, sin filtrar', hideNull('p1', { sensitive: true, authorId: 'autor9' }) === false);

  // Comportamiento previo intacto: post desactivado por moderación sigue oculto
  check('deactivated sigue oculto (regresión)', hideOff('p7', { deactivated: true, authorId: 'autor9' }) === true);
} catch (e) {
  check('T3 ejecutable', false, e.message);
}
console.log('');

console.log(`Resultado: ${passed} PASS, ${failed} FAIL`);
if (failed) { console.log('Fallos: ' + failures.join(' | ')); process.exit(1); }
