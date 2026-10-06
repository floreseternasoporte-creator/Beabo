'use strict';
/* C259 — Enlaces del perfil (Escaparate): el Guardar jamás debe obligar a
 * poner un enlace. Causa raíz probada con la app real en jsdom
 * (~/workspace/c256-tools/repro-c259-escaparate.js): si una fila traía una
 * URL no válida, saveLinkConfig ABORTABA todo el guardado ("Ese enlace no
 * es válido"), y al reducir de 2 a 1 enlaces, update() dejaba el índice
 * viejo: el enlace "quitado" reaparecía duplicado.
 *
 * Fix: la fila inválida se quita con un solo aviso suave, el resto se
 * guarda; y la escritura es un reemplazo completo del nodo (set).
 * Ejecutar: node tests/test-c259-escaparate-guardar.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extractFn(name) {
  const m = html.match(new RegExp('function ' + name + '\\b[\\s\\S]*?\\n  \\}', 'm'));
  if (!m) throw new Error('no encontrada: ' + name);
  return m[0];
}

const sandbox = { console, URL, String, Array, Object, Number, Set, Map };
vm.createContext(sandbox);
vm.runInContext([
  extractFn('sanitizeWebsiteUrl'),
  extractFn('drexShowcaseNormalizeLinks'),
  'var DREX_SHOWCASE_MAX_LINKS = 3; var DREX_SHOWCASE_MAX_TITLE = 40;'
].join('\n'), sandbox);

const norm = sandbox.drexShowcaseNormalizeLinks;
const sanitize = sandbox.sanitizeWebsiteUrl;

// ---------- compuerta (como el fix de saveLinkConfig): basura fuera ------
function clean(rows) {
  let dropped = 0;
  const cleanRows = rows.map(r => {
    const raw = String(r && r.u || '').trim().slice(0, 300);
    if (!raw) return { t: '', u: '' };
    if (!sanitize(raw)) { dropped++; return { t: '', u: '' }; }
    return { t: String(r && r.t || ''), u: raw };
  });
  return { links: norm(cleanRows, sanitize), dropped };
}

console.log('== Núcleo puro (funciones reales) ==');
ok(sanitize('esto no es una url') === null, 'sanitize descarta texto libre');
ok(sanitize('youtube.com/@drex') === 'https://youtube.com/@drex', 'sanitize agrega https:// si falta el esquema');

const onlyBad = clean([{ t: 'Mi canal', u: 'esto no es una url' }]);
ok(onlyBad.links.length === 0 && onlyBad.dropped === 1, 'una URL basura se quita y no bloquea nada');

const empty = clean([{ t: '', u: '' }, { t: '', u: '' }, { t: '', u: '' }]);
ok(empty.links.length === 0 && empty.dropped === 0, 'guardar SIN enlaces es válido (cero enlaces)');

const mixed = clean([
  { t: 'Canal', u: 'https://youtube.com/@drex' },
  { t: 'X', u: 'basura con espacios' },
  { t: 'Blog', u: 'blog.example.com' }
]);
ok(mixed.links.length === 2 && mixed.links[0].u === 'https://youtube.com/@drex' && mixed.links[1].u === 'https://blog.example.com/', 'válidos recompactados en orden, basura fuera');
ok(mixed.dropped === 1, 'un solo aviso por la basura');

const titleOnly = clean([{ t: 'Solo título', u: '' }]);
ok(titleOnly.links.length === 0, 'título sin URL no se guarda (como antes)');

console.log('== Contrato en el código fuente ==');
ok(html.includes("child('showcaseLinks').set(links.length ? links : null)"), 'el guardado reemplaza el nodo completo (set)');
ok(!html.includes('Ese enlace no es válido. Usa http://'), 'fuera el bloqueo duro de Guardar');
ok(html.includes('Se quitó un enlace que no era válido'), 'aviso suave único tras guardar');
ok(html.includes('Puedes guardar sin ningún enlace'), 'el texto dice que guardar vacío está bien');
ok((html.match(/id="settings-showcase-u-\d"/g) || []).length === 3, 'siguen siendo hasta 3 enlaces');
ok(!/id="settings-showcase-u-\d" type="url"/.test(html), 'los campos ya no son type=url (sin validaciones raras del sistema)');

console.log(failures ? '\nRESULTADO: ' + failures + ' FALLO(S)' : '\nRESULTADO: TODO VERDE');
process.exit(failures ? 1 : 0);
