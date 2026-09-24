/* ================================================================
 * C156 — XSS almacenado en la tarjeta de post vía authorImage forjado
 *
 * HALLAZGO: `communityNotes/<id>/authorImage` se copia en el composer
 * desde `users/<uid>/profileImage` (L14462:
 * `authorImage: userData.profileImage || user.photoURL || ...`), nodo que
 * el dueño puede forjar con escritura directa a RTDB sin pasar por la UI
 * (ruta de forja ya probada en C154 para el inbox de chat). En
 * `buildDrexPostCardHTML` (L18424) llegaba CRUDO a DOS sinks:
 *   1. L18466 (variante colaboración): <img ... src="${safeAuthorImage}" ...>
 *   2. L18474 (variante normal):      <img ... src="${safeAuthorImage}" ...>
 * con `let safeAuthorImage = note.authorImage || '<placeholder>'` SIN
 * sanitizar. El payload `x" onerror="window.__XSS_C156=1` rompe el atributo
 * src y el onerror inyectado GANA al legítimo (primer duplicado vence);
 * al fallar la carga de `src="x"` el handler SE EJECUTA (flag=1 verificado
 * en Chromium 152 real con la función REAL extraída de index.html).
 *
 * FIX (1 línea, L18424): `getSafeMediaUrl(note.authorImage, <fallback>)`
 * — valida esquema http(s)/data:image + escapa entidades HTML + preserva
 * el fallback para vacío (mismo comportamiento que el `||` anterior).
 * Post-fix el mismo payload deja un único onerror legítimo y flag=0
 * (verificado en Chromium real). La rama de auto-vista
 * (L18429 `headerProfileImage.src`) usa asignación por propiedad DOM, no
 * HTML: no es vector.
 *
 * Ejecutar con: node tests/test-c156-postcard-authorimage-xss.js
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
    console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
    failures++;
  }
}

// Extrae el cuerpo de `function name(` con balance de llaves.
function extractFn(src, name) {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no encontrada: ' + name);
  let j = src.indexOf('{', i), depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}

// Funciones REALES del bundle, ejecutadas en sandbox.
const sandbox = { window: { location: { origin: 'https://drex.test' } }, URL };
vm.createContext(sandbox);
for (const fn of ['escapeHTML', 'getSafeMediaUrl']) vm.runInContext(extractFn(html, fn), sandbox);
const safeUrl = (u, fb) => vm.runInContext(
  `getSafeMediaUrl(${JSON.stringify(u)}, ${JSON.stringify(fb)})`, sandbox);

const FORGED = 'x" onerror="window.__XSS_C156=1';
const FALLBACK = 'data:image/svg+xml;base64,AAA';

// ---- 1. Anclaje: el fix está en buildDrexPostCardHTML y cubre los 2 sinks ----
tcase('asignación sanitizada: `let safeAuthorImage = getSafeMediaUrl(note.authorImage,`', () =>
  /let safeAuthorImage = getSafeMediaUrl\(note\.authorImage,/.test(html));

tcase('siguen existiendo exactamente 2 sinks `src="${safeAuthorImage}"` (collab + normal)', () =>
  (html.match(/src="\$\{safeAuthorImage\}"/g) || []).length === 2);

tcase('ningún `safeAuthorImage = note.authorImage ||` crudo queda en la tarjeta', () =>
  !/safeAuthorImage = note\.authorImage \|\|/.test(html));

// ---- 2. Comportamiento del sanitizador con el payload de la PoC ----
tcase('payload forjado: la salida no contiene comilla cruda (no rompe el atributo)', () => {
  const out = safeUrl(FORGED, FALLBACK);
  return !out.includes('"') && !out.includes('<') && !out.includes('>');
});

tcase('payload forjado: interpolar en <img src="..."> deja un solo onerror (el legítimo)', () => {
  const out = safeUrl(FORGED, FALLBACK);
  // El parser HTML tokeniza atributos ANTES de decodificar entidades: &quot;
  // dentro del valor de src no abre atributos nuevos. Simula esa tokenización.
  const row = `<img src="${out}" alt="x" onerror="this.src='fb'">`;
  const attrs = [];
  const re = /([a-zA-Z-]+)="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(row)) !== null) attrs.push(m[1]);
  return attrs.filter(a => a === 'onerror').length === 1 && attrs.includes('src');
});

tcase('payload forjado: el src sanitizado no es ejecutable como URL', () => {
  const out = safeUrl(FORGED, FALLBACK);
  return !/^\s*javascript:/i.test(out);
});

// ---- 3. Sin regresión: URLs legítimas y fallback intactos ----
tcase('URL https legítima pasa intacta', () =>
  safeUrl('https://res.cloudinary.com/drex/foto.png', FALLBACK) === 'https://res.cloudinary.com/drex/foto.png');

tcase('data:image base64 legítimo pasa intacto', () =>
  safeUrl('data:image/png;base64,iVBORw0KGgo=', FALLBACK) === 'data:image/png;base64,iVBORw0KGgo=');

tcase('vacío/ausente -> fallback (mismo comportamiento que `||` anterior)', () =>
  safeUrl('', FALLBACK) === FALLBACK && safeUrl(null, FALLBACK) === FALLBACK);

tcase('esquema javascript: -> fallback', () =>
  safeUrl('javascript:alert(1)', FALLBACK) === FALLBACK);

// ---- 4. Superficies hermanas de authorImage ya cubiertas (no regresan) ----
tcase('guardados: getSafeMediaUrl(note.authorImage)', () =>
  /src="\$\{getSafeMediaUrl\(note\.authorImage\)/.test(html));

tcase('búsqueda: getSafeMediaUrl(post.authorImage)', () =>
  /src="\$\{getSafeMediaUrl\(post\.authorImage\)/.test(html));

tcase('comentarios: safeAuthorImage vía getSafeMediaUrl(comment.authorImage,', () =>
  /safeAuthorImage: getSafeMediaUrl\(comment\.authorImage,/.test(html));

tcase('visor de foto: escapeHtmlAttr(avatar) con note.authorImage', () =>
  /src="\$\{escapeHtmlAttr\(avatar\)\}"/.test(html));

tcase('compartido en chat: escapeHtml(sp.authorImage', () =>
  /escapeHtml\(sp\.authorImage/.test(html));

console.log(failures ? `\n${failures} FALLOS` : '\nTODOS LOS CHECKS PASARON');
process.exit(failures ? 1 : 0);
