/* ================================================================
 * C162 — XSS almacenado por postType forjado en _buildHistorialCard
 * (base 7032a41, familia guardados/historial).
 *
 * HALLAZGO: `_buildHistorialCard` (index.html:33954) interpolaba
 * `post.postType` CRUDO en el innerHTML de la tarjeta. Un postType
 * forjado, ej. '</span><img src=x onerror="window.__pwned=true">',
 * inyecta un tag REAL con handler: la PoC en Chromium (poc.html, caso
 * T2, funciones REALES del bundle @ 7032a41) demuestra ejecución —
 * window.__pwned === true en la base.
 *
 * Vector: el atacante escribe communityNotes/<suNota>/postType por RTDB
 * directa en su propio post; la víctima lo guarda (Guardados) o lo vota
 * (Mis votos) y al abrir el Historial la tarjeta lo pinta crudo.
 * Las superficies hermanas del mismo dato son seguras: el feed lo filtra
 * por whitelist POST_TYPE_STYLES (renderNoteAnchoredMeta) y los demás
 * usos van por dataset (11126, 18991) o comparación (39801, 16865).
 *
 * NOTA DE ALCANCE (honesta): el campo postType no lo escribe el flujo
 * de publicación de la app (legacy / escritura directa). El vector es
 * end-to-end si las reglas RTDB permiten al autor escribir campos
 * arbitrarios en su propia nota (no verificable desde el repo, igual
 * que el índice usernames/ en C161). El sumidero, en cambio, es
 * incondicional: cualquier postType con HTML se inyecta.
 *
 * FIX (estilo de la casa — mismo escapeHtml que ya usan authorName y
 * content dos líneas más abajo):
 *   ${escapeHtml(post.postType)}
 * Paridad index.html <-> 404.html (el router SPA exige copia exacta).
 *
 * Sin el parche este test FALLA; con el parche, ALL PASS.
 *
 * Ejecutar:            node tests/test-c162-historial.js
 * Falla-en-base:       DREX_HTML=fixtures/index.base.html node tests/test-c162-historial.js
 * Pasa-con-parche:     DREX_HTML=fixtures/index.patched.html node tests/test-c162-historial.js
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function resolveHtml() {
  if (process.env.DREX_HTML && fs.existsSync(process.env.DREX_HTML)) return process.env.DREX_HTML;
  const cands = [
    path.join(__dirname, '..', 'fixtures', 'index.patched.html'),
    path.join(__dirname, '..', 'index.html'),
    path.join(__dirname, '..', 'beabo', 'index.html')
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('no se encontró HTML de Drex (usa DREX_HTML)');
}
const htmlPath = resolveHtml();
const html = fs.readFileSync(htmlPath, 'utf8');
// Paridad 404.html: el router SPA exige copia exacta de index.html.
const html404Path = htmlPath.replace(/index\.([^/]+)$/, '404.$1');
const html404 = fs.existsSync(html404Path) ? fs.readFileSync(html404Path, 'utf8') : null;

let failures = 0;
function tcase(name, fn) {
  try {
    const ok = fn();
    console.log((ok ? 'ok - ' : 'NOT OK - ') + name);
    if (!ok) failures++;
  } catch (e) {
    console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
    failures++;
  }
}
function extractFn(source, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(source);
  if (!m) throw new Error('no se encontró ' + name);
  let i = source.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(m.index, j + 1); }
  }
  throw new Error('llaves sin balance en ' + name);
}

/* ---------- Parte A: el fix está aplicado (estático) ---------- */
tcase('A1 _buildHistorialCard escapa postType (escapeHtml(post.postType))', () => {
  const b = extractFn(html, '_buildHistorialCard');
  return b.indexOf('escapeHtml(post.postType)') !== -1;
});
tcase('A2 no queda interpolación cruda ${post.postType} sin escapar', () => {
  const b = extractFn(html, '_buildHistorialCard');
  // La forma escapada es ${escapeHtml(post.postType)}: no contiene el
  // literal '${post.postType}', así que cualquier ocurrencia es cruda.
  let count = 0, p = -1;
  while ((p = b.indexOf('${post.postType}', p + 1)) !== -1) count++;
  return count === 0;
});
tcase('A3 paridad 404.html: el mismo escape existe en la copia del router', () => {
  if (!html404) { console.log('    (sin 404.html hermano: se omite)'); return true; }
  const b = extractFn(html404, '_buildHistorialCard');
  return b.indexOf('escapeHtml(post.postType)') !== -1;
});

/* ---------- Parte B: conductual — postType forjado no inyecta tags ---------- */
const EVIL_TYPE = '</span><img src="x" onerror="window.__pwned=true">';
function makeBox() {
  const sb = {};
  vm.createContext(sb);
  ['escapeHTML', 'escapeHtml', 'getSafeMediaUrlRaw', '_historialThumbSlotHTML',
   'resolvePostThumb', 'fillHistorialThumb', 'drexHistorialPollPreview',
   '_buildHistorialCard']
    .forEach(n => vm.runInContext(extractFn(html, n), sb));
  vm.runInContext('function appT(s){ return String(s == null ? "" : s); }', sb);
  vm.runInContext('var DrexCloud = { database: function(){ return { ref: function(){ return { once: function(){ return Promise.reject(new Error("stub")); } }; } }; } };', sb);
  sb.URL = URL;
  sb.window = { location: { origin: 'https://drex.test' } };
  vm.runInContext(`
    var __captured = [];
    function __fakeEl() {
      return {
        className: '', _html: '', _onclick: null,
        set innerHTML(v) { this._html = String(v); __captured.push(this._html); },
        get innerHTML() { return this._html; },
        set onclick(f) { this._onclick = f; },
        get onclick() { return this._onclick; },
        querySelector: function () { return { isConnected: false, remove: function(){}, innerHTML: '' }; },
        appendChild: function () {}
      };
    }
    var document = { createElement: function () { return __fakeEl(); } };
  `, sb);
  return sb;
}
function renderCard(post) {
  const sb = makeBox();
  vm.runInContext('var __post = ' + JSON.stringify(post) + ';', sb);
  let thrown = null;
  try { vm.runInContext('var __card = _buildHistorialCard("n1", __post, function(){});', sb); }
  catch (e) { thrown = String((e && e.message) || e); }
  return { html: vm.runInContext('__captured.join("\\n")', sb), thrown };
}
const evilHtml = renderCard({ authorName: 'atacante', content: 'post normal', postType: EVIL_TYPE }).html;

tcase('B1 postType forjado no inyecta un <img> real en la tarjeta', () => {
  // En la base: el <img src="x" onerror=...> queda como tag REAL.
  // Con el parche: &lt;img queda como texto inerte.
  return evilHtml.indexOf('<img src="x"') === -1;
});
tcase('B2 el payload queda neutralizado como entidades (no ejecutable)', () => {
  return evilHtml.indexOf('&lt;img') !== -1 && evilHtml.indexOf('onerror="window.__pwned') === -1;
});
tcase('B3 postType benigno sigue pintando la etiqueta intacta', () => {
  const r = renderCard({ authorName: 'ana', content: 'hola', postType: 'opinion' });
  return r.thrown === null && r.html.indexOf('>opinion</span>') !== -1;
});
tcase('B4 postType ausente no revienta el render (sin etiqueta)', () => {
  const r = renderCard({ authorName: 'ana', content: 'hola' });
  return r.thrown === null && r.html.indexOf('inline-block text-[10px]') === -1;
});
tcase('B5 postType con comillas no rompe el atributo class del span', () => {
  const r = renderCard({ authorName: 'ana', content: 'hola', postType: 'debate"x' });
  return r.thrown === null && r.html.indexOf('debate"x') === -1 && r.html.indexOf('debate&quot;x') !== -1;
});

console.log(failures === 0 ? 'ALL PASS' : failures + ' FALLOS');
process.exit(failures === 0 ? 0 : 1);
