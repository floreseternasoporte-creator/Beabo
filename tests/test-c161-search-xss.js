/* ================================================================
 * C161 — XSS por uid forjado en el render de cuentas de búsqueda
 * (base 2ac4f13, familia búsqueda/resultados).
 *
 * HALLAZGO: `renderAccountsList` interpolaba `account.uid` CRUDO en dos
 * atributos HTML (id="..." y data-author-id="..."). Un uid forjado con
 * comillas, ej. 'x" onmouseover="window.__pwned=true', rompía el atributo
 * e inyectaba un handler REAL en el DOM: la PoC en Chromium (poc.html,
 * caso T2, funciones REALES del bundle) demuestra ejecución —
 * dispatchEvent(mouseover) pone window.__pwned === true en la base.
 *
 * NOTA DE ALCANCE (honesta): en los flujos propios de la app, el uid que
 * llega aquí viene del índice `usernames/` y se escribe siempre como
 * Firebase Auth UID (alfanumérico). El vector es end-to-end solo si las
 * reglas RTDB permiten escribir valores arbitrarios en `usernames/`
 * (no verificable desde el repo) o si un futuro llamador pasa otro id.
 * El sumidero, en cambio, es incondicional: falta el escape que SÍ tiene
 * su función hermana `renderPostsList` para los mismos datos.
 *
 * FIX (estilo de la casa — idéntico patrón al de renderPostsList):
 *   id="${escapeHtml(accountAvatarId)}"
 *   data-author-id="${escapeHtml(account.uid || '')}"
 * El id CRUDO se conserva en la variable; solo se escapa en los puntos de
 * interpolación HTML (mismo patrón que renderPostsList).
 * Paridad index.html <-> 404.html (el router SPA exige copia exacta).
 *
 * Sin el parche este test FALLA; con el parche, ALL PASS.
 *
 * Ejecutar:            node tests/test-c161-search-xss.js
 * Falla-en-base:       DREX_HTML=fixtures/index.base.html node tests/test-c161-search-xss.js
 * Pasa-con-parche:     DREX_HTML=fixtures/index.patched.html node tests/test-c161-search-xss.js
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
tcase('A1 renderAccountsList escapa el id del avatar (escapeHtml(accountAvatarId))', () => {
  const b = extractFn(html, 'renderAccountsList');
  return b.indexOf('escapeHtml(accountAvatarId)') !== -1;
});
tcase("A2 renderAccountsList escapa data-author-id (escapeHtml(account.uid || ''))", () => {
  const b = extractFn(html, 'renderAccountsList');
  return b.indexOf("escapeHtml(account.uid || '')") !== -1;
});
tcase('A3 paridad 404.html: el mismo escape existe en la copia del router', () => {
  if (!html404) { console.log('    (sin 404.html hermano: se omite)'); return true; }
  const b = extractFn(html404, 'renderAccountsList');
  return b.indexOf('escapeHtml(accountAvatarId)') !== -1 &&
         b.indexOf("escapeHtml(account.uid || '')") !== -1;
});
tcase('A4 el id se construye crudo y solo se escapa al interpolar (sin doble-escape)', () => {
  const b = extractFn(html, 'renderAccountsList');
  return b.indexOf('`search-account-author-${account.uid}`') !== -1;
});

/* ---------- Parte B: conductual — uid forjado no inyecta atributos ---------- */
const EVIL_UID = 'x" onmouseover="window.__pwned=true';
function makeBox() {
  const sb = {};
  vm.createContext(sb);
  ['escapeHtml', 'escapeHTML', 'getSafeMediaUrl', 'renderAccountsList']
    .forEach(n => vm.runInContext(extractFn(html, n), sb));
  vm.runInContext('function getVerificationIconByAuthor(){ return ""; }', sb);
  vm.runInContext('function closeSearch(){} function openAuthorProfile(){} function loadUserFrame(){}', sb);
  sb.URL = URL;
  sb.window = { location: { origin: 'https://drex.test' } };
  vm.runInContext(`
    var __captured = [];
    function __fakeItem() {
      return {
        className: '', _html: '',
        set innerHTML(v) { this._html = String(v); __captured.push(this._html); },
        get innerHTML() { return this._html; },
        addEventListener: function () {}
      };
    }
    var document = {
      getElementById: function () {
        return { _html: '',
          set innerHTML(v) { this._html = String(v); },
          get innerHTML() { return this._html; },
          appendChild: function () {} };
      },
      createElement: function () { return __fakeItem(); }
    };
  `, sb);
  return sb;
}
function renderAccounts(accounts) {
  const sb = makeBox();
  vm.runInContext('var __accounts = ' + JSON.stringify(accounts) + ';', sb);
  let thrown = null;
  try { vm.runInContext('renderAccountsList(__accounts);', sb); }
  catch (e) { thrown = String((e && e.message) || e); }
  return { html: vm.runInContext('__captured.join("\\n")', sb), thrown };
}
const evilHtml = renderAccounts([{ uid: EVIL_UID, username: 'atacante', profileImage: '' }]).html;

tcase('B1 uid forjado no crea un atributo onmouseover real', () => {
  // En la base: id="search-account-author-x" onmouseover="window.__pwned=true"
  // Con el parche: &quot; neutraliza la comilla y no hay atributo real.
  return evilHtml.indexOf('" onmouseover="') === -1;
});
tcase('B2 el payload queda neutralizado como entidad (no como atributo ejecutable)', () => {
  return evilHtml.indexOf('onmouseover="window.__pwned') === -1 &&
         evilHtml.indexOf('window.__pwned') !== -1; // el texto sigue ahí, inerte
});
tcase('B3 uid benigno sigue renderizando data-author-id intacto', () => {
  const r = renderAccounts([{ uid: 'abc123', username: 'maria', profileImage: '' }]);
  return r.thrown === null && r.html.indexOf('data-author-id="abc123"') !== -1;
});
tcase('B4 uid ausente no revienta el render (data-author-id="")', () => {
  const r = renderAccounts([{ username: 'sinuid', profileImage: '' }]);
  return r.thrown === null && r.html.indexOf('data-author-id=""') !== -1;
});

console.log(failures === 0 ? 'ALL PASS' : failures + ' FALLOS');
process.exit(failures === 0 ? 0 : 1);
