'use strict';
// Tests del ESCAPARATE de perfil (Ciclo 86).
// Uso: node test-c86-escaparate.js [--target <html>]
//   --target: HTML a probar (default: ../index.html, el parcheado).
// Diseñados para FALLAR contra la base sin parche.
//
// Verifica:
//  (a) drexShowcaseNormalizeLinks (extraída verbatim del HTML y ejecutada en
//      sandbox con el sanitizeWebsiteUrl real): matriz de decisión, cap de 3,
//      títulos recortados a 40, URLs inválidas descartadas, entradas string,
//      nulos saltados, orden preservado;
//  (b) integración estática: renderOwnProfileShowcase, #profile-links-list,
//      6 inputs del editor, eliminación del input legacy settings-website,
//      hook en saveProfileField, regla de precedencia (escaparate gana al
//      website legacy en perfil propio y ajeno), escapes en títulos,
//      href solo desde URL sanitizada, rel=noopener, target=_blank,
//      regla de contraste en tema oscuro, superficie de BD (solo vía
//      saveProfileField).
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


// ---- extracción de código fuente del HTML ----
function extractConst(src, name) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*([^;]+);').exec(src);
  if (!m) throw new Error('const no encontrada en el HTML: ' + name);
  return 'const ' + name + ' = ' + m[1] + ';';
}
function extractFunction(src, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('función no encontrada en el HTML: ' + name);
  let i = src.indexOf('{', m.index);
  if (i < 0) throw new Error('sin cuerpo: ' + name);
  let depth = 0, inStr = null, esc = false;
  const start = m.index;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

let normalize, MAX_LINKS, MAX_TITLE, sanitizeWebsiteUrl;
try {
  const code =
    extractConst(html, 'DREX_SHOWCASE_MAX_LINKS') + '\n' +
    extractConst(html, 'DREX_SHOWCASE_MAX_TITLE') + '\n' +
    extractFunction(html, 'sanitizeWebsiteUrl') + '\n' +
    extractFunction(html, 'drexShowcaseNormalizeLinks') + '\n' +
    'module.exports = { drexShowcaseNormalizeLinks, sanitizeWebsiteUrl, DREX_SHOWCASE_MAX_LINKS, DREX_SHOWCASE_MAX_TITLE };';
  const sandbox = { module: { exports: {} }, URL: URL };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'escaparate-core.js' });
  const ex = sandbox.module.exports;
  normalize = ex.drexShowcaseNormalizeLinks;
  sanitizeWebsiteUrl = ex.sanitizeWebsiteUrl;
  MAX_LINKS = ex.DREX_SHOWCASE_MAX_LINKS;
  MAX_TITLE = ex.DREX_SHOWCASE_MAX_TITLE;
  ok(true, 'extracción verbatim del núcleo desde el HTML');
} catch (e) {
  ok(false, 'extracción verbatim del núcleo desde el HTML (' + e.message + ')');
  normalize = () => { throw e; };
  MAX_LINKS = -1; MAX_TITLE = -1; sanitizeWebsiteUrl = () => null;
}

// ================= T1: entradas no-array =================
tcase('T1', () => {
  eq(normalize(null, sanitizeWebsiteUrl), [], 'T1a null → []');
  eq(normalize(undefined, sanitizeWebsiteUrl), [], 'T1b undefined → []');
  eq(normalize('https://x.com', sanitizeWebsiteUrl), [], 'T1c string suelto → []');
  eq(normalize(42, sanitizeWebsiteUrl), [], 'T1d número → []');
  eq(normalize({ u: 'https://x.com' }, sanitizeWebsiteUrl), [], 'T1e objeto suelto → []');
  eq(normalize([], sanitizeWebsiteUrl), [], 'T1f array vacío → []');
});
// ================= T2: entradas válidas =================
tcase('T2', () => {
  eq(normalize([{ t: 'Mi tienda', u: 'https://tienda.com' }], sanitizeWebsiteUrl),
    [{ t: 'Mi tienda', u: 'https://tienda.com/' }], 'T2a objeto válido normalizado');
  eq(normalize(['tienda.com'], sanitizeWebsiteUrl),
    [{ t: '', u: 'https://tienda.com/' }], 'T2b string → {t:"",u} con https implícito');
  eq(normalize([{ t: 'A', u: 'http://a.com' }, { t: 'B', u: 'https://b.com/x' }], sanitizeWebsiteUrl).length,
    2, 'T2c dos válidas preservan orden y cantidad');
});
// ================= T3: cap de 3 =================
tcase('T3', () => {
  ok(MAX_LINKS === 3, 'T3a constante DREX_SHOWCASE_MAX_LINKS === 3');
  eq(normalize([
    { t: '1', u: 'https://a1.com' }, { t: '2', u: 'https://a2.com' },
    { t: '3', u: 'https://a3.com' }, { t: '4', u: 'https://a4.com' },
  ], sanitizeWebsiteUrl).map(e => e.t), ['1', '2', '3'], 'T3b se cortan a 3, se conserva el orden');
});
// ================= T4: URLs inválidas descartadas =================
tcase('T4', () => {
  eq(normalize([{ t: 'X', u: 'ftp://x.com' }], sanitizeWebsiteUrl), [], 'T4a ftp descartado');
  eq(normalize([{ t: 'X', u: 'javascript:alert(1)' }], sanitizeWebsiteUrl), [], 'T4b javascript: descartado');
  eq(normalize([{ t: 'X', u: '' }], sanitizeWebsiteUrl), [], 'T4c vacío descartado');
  eq(normalize([{ t: 'X', u: '   ' }], sanitizeWebsiteUrl), [], 'T4d solo espacios descartado');
  eq(normalize([{ t: 'X', u: null }], sanitizeWebsiteUrl), [], 'T4e null descartado');
  eq(normalize([{ t: 'X' }], sanitizeWebsiteUrl), [], 'T4f sin u descartado');
  eq(normalize([{ t: 'X', u: 'no es url' }], sanitizeWebsiteUrl), [], 'T4g texto sin dominio descartado');
  eq(normalize([
    { t: 'OK', u: 'https://ok.com' }, { t: 'MAL', u: 'ftp://mal.com' }, { t: 'OK2', u: 'https://ok2.com' },
  ], sanitizeWebsiteUrl).map(e => e.t), ['OK', 'OK2'], 'T4h mezcla: solo válidas, en orden');
});
// ================= T5: títulos =================
tcase('T5', () => {
  ok(MAX_TITLE === 40, 'T5a constante DREX_SHOWCASE_MAX_TITLE === 40');
  eq(normalize([{ t: '  Con espacios  ', u: 'https://x.com' }], sanitizeWebsiteUrl)[0].t,
    'Con espacios', 'T5b título con trim');
  eq(normalize([{ t: 'a'.repeat(100), u: 'https://x.com' }], sanitizeWebsiteUrl)[0].t,
    'a'.repeat(40), 'T5c título recortado a 40');
  eq(normalize([{ t: null, u: 'https://x.com' }], sanitizeWebsiteUrl)[0].t, '', 'T5d título null → ""');
  eq(normalize([{ t: 123, u: 'https://x.com' }], sanitizeWebsiteUrl)[0].t, '123', 'T5e título numérico → string');
});
// ================= T6: nulos y formas raras =================
tcase('T6', () => {
  eq(normalize([null, undefined, { t: 'A', u: 'https://a.com' }], sanitizeWebsiteUrl).map(e => e.t),
    ['A'], 'T6a nulos saltados');
  eq(normalize([0, false, ''], sanitizeWebsiteUrl), [], 'T6b falsy no-objeto descartados');
  eq(normalize([{ t: 'A', u: 'https://a.com', extra: 'zzz' }], sanitizeWebsiteUrl),
    [{ t: 'A', u: 'https://a.com/' }], 'T6c campos extra no se filtran al objeto');
});
// ================= S: integración estática =================
ok(/function\s+renderOwnProfileShowcase\s*\(/.test(html), 'S1 renderOwnProfileShowcase definida');
ok(html.includes('id="profile-links-list"'), 'S2 contenedor #profile-links-list en el HTML');
for (let i = 0; i < 3; i++) {
  ok(html.includes('id="settings-showcase-t-' + i + '"'), 'S3a input título ' + i);
  ok(html.includes('id="settings-showcase-u-' + i + '"'), 'S3b input URL ' + i);
}
ok(!html.includes('id="settings-website"'), 'S4 input legacy settings-website eliminado');
ok(/saveProfileField\(\{\s*showcaseLinks:/.test(html), 'S5 guardado vía saveProfileField({ showcaseLinks: … })');
ok(/hasOwnProperty\.call\(updates,\s*'showcaseLinks'\)/.test(html), 'S6 hook de re-render en saveProfileField para showcaseLinks');
ok(/renderOwnProfileShowcase\(data\.website \|\| '', data\.showcaseLinks\)/.test(html), 'S7 perfil propio llama renderOwnProfileShowcase');
// Precedencia: escaparate gana; website legacy solo como fallback.
ok(/if\s*\(links\.length\s*>\s*0\)\s*renderOwnProfileLink\(''\)/.test(html), 'S8a propio: con escaparate se oculta el enlace legacy');
ok(/if\s*\(!showcase\.length\s*&&\s*safeWebsite\)/.test(html), 'S8b ajeno: website legacy solo si no hay escaparate');
// Escapes: títulos siempre por escapeHtml; href desde URL sanitizada.
ok(/escapeHtml\(l\.t\)/.test(html), 'S9a título del propio escapado');
ok(/lLabel = l\.t \? escapeHtml\(l\.t\) : escapeHtml\(_shortLinkLabel\(l\.u\)\)/.test(html), 'S9b título del ajeno escapado');
ok(/href="' \+ l\.u \+ '"/.test(html), 'S10a href propio desde l.u sanitizada');
ok(/<a href="\$\{l\.u\}"/.test(html), 'S10b href ajeno desde l.u sanitizada');
ok((html.match(/rel="noopener"/g) || []).length >= 3, 'S11 rel=noopener en los anchors nuevos');
ok(/<a href="' \+ l\.u \+ '" target="_blank"/.test(html), 'S12 target=_blank en filas del escaparate propio');
ok(/body\.theme-dark #profile-links-list a/.test(html), 'S13 regla de contraste en tema oscuro');
ok(/slice\(0,\s*300\)/.test(html), 'S14 URLs recortadas a 300 chars al leer el editor');
// Superficie de BD: showcaseLinks solo se escribe vía saveProfileField (update
// en users/<uid>), nunca con .set/.push directos.
{
  const writes = [...html.matchAll(/showcaseLinks\s*:/g)].map(m => m.index);
  const viaSave = /saveProfileField\(\{\s*showcaseLinks:/.exec(html);
  ok(viaSave !== null && writes.length >= 1, 'S15a escritura de showcaseLinks presente vía saveProfileField');
  const directSets = [...html.matchAll(/\.set\(\s*\{[^}]*showcaseLinks|\.push\([^)]*showcaseLinks/g)];
  ok(directSets.length === 0, 'S15b sin .set/.push directos de showcaseLinks');
// Normalización al abrir el editor: website legacy migra a la fila 1.
ok(/if\s*\(!links\.length && d\.website\)/.test(html), 'S16 editor pre-llena fila 1 con website legacy');
}
// El editor valida cada URL antes de guardar (toast con la clave existente).
ok(/function saveLinkConfig\(\)[\s\S]{0,600}Ese enlace no es válido/.test(html), 'S17 saveLinkConfig valida URLs con la clave existente');

console.log('\nC86 escaparate: ' + pass + ' OK / ' + fail + ' FAIL (' + target + ')');
if (failures.length) {
  console.log('Fallos:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
