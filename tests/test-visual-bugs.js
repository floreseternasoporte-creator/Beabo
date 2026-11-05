'use strict';
/* Detalle de publicación + Buscar: comprobaciones de cableado en index.html / i18n / sw.
 * Ejecutar con: node tests/test-visual-bugs.js */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let failures = 0;
function check(name, cond) { if (cond) console.log('  OK  ' + name); else { failures++; console.log('  FAIL ' + name); } }

// Idioma por defecto: dispositivo, no "en" fijo
check('getAppLanguage usa drexResolveDeviceLang cuando no hay idioma guardado',
  html.includes('||(typeof window.drexResolveDeviceLang==="function"?window.drexResolveDeviceLang():"en");return stored==="en"'));
check('drexEnsureI18n usa el idioma del dispositivo por defecto',
  html.includes('localStorage.getItem("selectedLanguage")||(typeof window.drexResolveDeviceLang==="function"?window.drexResolveDeviceLang():"en")}catch(e){lang="en"}'));

// Detalle de publicación
check('la tarjeta del detalle usa el contenedor .drex-post del feed', html.includes('<div class="drex-post w-full" role="article" aria-label="${escapeHtml(note.authorName||"Usuario")}">${buildDrexPostCardHTML(note,'));
check('sección de respuestas', html.includes('id="permalink-replies-list"') && html.includes('function drexPermalinkMountReplies('));
check('respuestas leen postComments con límite', html.includes('"postComments/"+noteId).orderByKey().limitToLast(30)'));
check('respuestas filtran cuentas bloqueadas y palabras ocultas', html.includes('isAccountBlockedForCurrentUser(authorOf(c))') && html.includes('commentHasHiddenWord(drexPermalinkReplyText(c))'));
check('texto de respuestas escapado', html.includes('escapeHtml(text)') && html.includes('escapeHtml(c.authorName||"Usuario")'));
check('caja de respuesta abre el compositor existente', html.includes('id="permalink-reply-bar"') && html.includes('onclick="drexPermalinkOpenComments(true)"') && html.includes('function drexPermalinkOpenComments('));
check('la barra se oculta al cerrar / en mensajes de error', (html.match(/getElementById\("permalink-reply-bar"\)\?\.classList\.add\("hidden"\)/g) || []).length >= 3);
check('al cerrar comentarios se refrescan las respuestas', html.includes('drexPermalinkAfterComments()') && html.includes('function drexPermalinkAfterComments('));

// Buscar
check('tendencias usan el índice local de ondas (sin lecturas extra)', html.includes('function drexRenderSearchTrends(') && html.includes('ondaIndex.trending(Date.now())') && html.includes('id="search-trends-list"'));
check('estado vacío de tendencias', html.includes('appT("Sin tendencias todavía")'));
check('recientes con botón quitar', html.includes('function removeRecentSearch(') && html.includes('appT("Quitar de recientes")'));
check('estado vacío de resultados reutilizable', html.includes('function drexSearchEmptyHTML(') && (html.match(/drexSearchEmptyHTML\(appT\("No hay (posts|cuentas|fotos) que coincidan\."\)\)/g) || []).length === 3);

// i18n: las claves nuevas existen en los 6 idiomas
const keys = ['Respuestas', 'Contenido multimedia', 'Escribe tu respuesta…', 'Aún no hay respuestas', 'Sé la primera persona en responder.', 'Ver todas las respuestas', 'No se pudieron cargar las respuestas.', 'Revisa la ortografía o prueba con otras palabras.', 'Quitar de recientes'];
for (const l of ['en', 'pt', 'fr', 'ja', 'ko', 'zh']) {
  const src = fs.readFileSync(path.join(root, `drex-i18n-${l}.js`), 'utf8');
  check(`i18n ${l}: claves nuevas`, keys.every((k) => src.includes(JSON.stringify(k))));
}
check('404.html sincronizado', html === fs.readFileSync(path.join(root, '404.html'), 'utf8'));
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
check('sw.js >= drex-v139', Number((sw.match(/DREX_SW_VERSION = 'drex-v(\d+)'/) || [])[1]) >= 139);
console.log(failures ? failures + ' FALLOS' : 'todo OK');
process.exit(failures ? 1 : 0);
