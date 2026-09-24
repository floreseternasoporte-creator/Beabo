/* ================================================================
 * C140 — familia `download` en anchors + `ping` + `referrerpolicy`
 * (familia NUEVA, nunca auditada como barrido dedicado).
 *
 * HALLAZGO: `a.download` es INERTE en URLs cross-origin (el navegador lo
 * ignora en silencio y navega en vez de descargar). Inventario repo-wide de
 * los 5 sitios con `.download =`: 4 ya usaban blob: (mismo origen → el
 * atributo surte efecto); el 5º (saveCarouselPhoto) apuntaba la URL remota
 * cruda y se corrigió en C140 a fetch→blob con fallback window.open+noopener.
 *
 * `ping=` (hyperlink auditing): 0 en todo el árbol (re-confirma C134).
 * `referrerpolicy`: 0 atributos y 0 meta Referrer-Policy en todo el árbol;
 * la política efectiva es el default del navegador
 * (strict-origin-when-cross-origin), adecuada: ninguna URL externa lleva
 * datos sensibles en query (verificado en C118) y ningún href de navegación
 * a terceros incrusta secretos.
 * Ejecutar con: node tests/test-c140-download-referrerpolicy.js
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dataExportJs = fs.readFileSync(path.join(ROOT, 'drex-data-export.js'), 'utf8');
const recoveryJs = fs.readFileSync(path.join(ROOT, 'recovery-codes.js'), 'utf8');

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
function count(re, src) { return (src.match(re) || []).length; }

// Extrae el cuerpo de `function name(` con balance de llaves (conserva async).
function extractFn(src, name) {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no encontrada: ' + name);
  if (src.slice(Math.max(0, i - 6), i) === 'async ') i -= 6;
  let j = src.indexOf('{', i), depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}

// ---- 1. Inventario de la familia `download` (multiconjunto) ----
tcase('inventario .download = : 5 sitios en total (3 index.html + 1 drex-data-export.js + 1 recovery-codes.js)', () => {
  const n = count(/\.download\s*=/g, html) + count(/\.download\s*=/g, dataExportJs) + count(/\.download\s*=/g, recoveryJs);
  return n === 5;
});

tcase('downloadChatFile: descarga vía blob (createObjectURL en la misma función)', () => {
  const body = extractFn(html, 'downloadChatFile');
  return /\.download\s*=/.test(body) && /URL\.createObjectURL\(/.test(body) && /URL\.revokeObjectURL\(/.test(body);
});

tcase('saveCarouselPhoto (C140): descarga vía blob fetch→createObjectURL, nunca href remoto crudo', () => {
  const body = extractFn(html, 'saveCarouselPhoto');
  return /\.download\s*=/.test(body) &&
    /URL\.createObjectURL\(await res\.blob\(\)\)/.test(body) &&
    !/a\.href = safeUrl/.test(body) &&
    /window\.open\(safeUrl,'_blank','noopener'\)/.test(body);
});

tcase('downloadMySecurityData: descarga vía blob (createObjectURL en la misma función)', () => {
  const body = extractFn(html, 'downloadMySecurityData');
  return /\.download\s*=/.test(body) && /URL\.createObjectURL\(blob\)/.test(body) && /URL\.revokeObjectURL\(url\)/.test(body);
});

tcase('drex-data-export.js triggerDownloadBytes: a.download con blob URL', () => {
  const body = extractFn(dataExportJs, 'triggerDownloadBytes');
  return /a\.download = filename/.test(body) && /createObjectURL\(blob\)/.test(body) && /revokeObjectURL\(url\)/.test(body);
});

tcase('recovery-codes.js downloadTxt: a.download con blob URL', () => {
  const body = extractFn(recoveryJs, 'downloadTxt');
  return /a\.download = 'drex-codigos-respaldo\.txt'/.test(body) && /URL\.createObjectURL\(blob\)/.test(body) && /URL\.revokeObjectURL\(/.test(body);
});

tcase('<a download ...> estático en HTML: 0 (todos los usos son programáticos)', () =>
  count(/<a [^>]*\bdownload\b[^>]*>/g, html) === 0);

// ---- 2. ping= : cero repo-wide ----
tcase('ping=: 0 en index.html', () => count(/ping=/g, html) === 0);
tcase('ping=: 0 en todos los .js del repo (excl. tests)', () => {
  const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.js'));
  return files.every(f => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    // 'ping' como atributo/atributo-ish, no como subcadena (shipping, mapping…)
    return !/[<'"\s]ping=/.test(src);
  });
});

// ---- 3. referrerpolicy: cero + default documentado ----
tcase('referrerpolicy=: 0 atributos en index.html', () => count(/referrerpolicy=/gi, html) === 0);
tcase('referrerpolicy: 0 en todos los .js del repo (excl. tests)', () => {
  const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.js'));
  return files.every(f => !/referrerpolicy/i.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
});
tcase('meta Referrer-Policy: 0 (rige el default strict-origin-when-cross-origin)', () =>
  count(/name=["']referrer["']/i, html) === 0 && count(/Referrer-Policy/i, html) === 0);

tcase('ningún href de navegación a terceros incrusta token=/secret= en query', () => {
  const hrefs = html.match(/href="https?:\/\/[^"]*"/g) || [];
  const thirdParty = hrefs.filter(h => !/floreseternasoporte-creator\.github\.io/.test(h));
  return thirdParty.every(h => !/[?&](token|secret|key|auth)=/i.test(h));
});

console.log(failures ? `\n${failures} FALLOS` : '\nTODOS LOS CHECKS PASARON');
process.exit(failures ? 1 : 0);
