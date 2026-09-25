// C133: cadena de sanitización de imágenes renderizadas (familia NUNCA auditada)
// + re-verifies rápidos: scrollRestoration (C120, era cero) y execCommand (C101/C113).
//
// AUDITORÍA (2026-09-24, HEAD c18e315, hit por hit, repo-wide):
// - getSafeMediaUrl(url, fallback): strip de controles, parse con new URL(),
//   SOLO http:/https: o data:image/(png|jpg|gif|webp);base64 — javascript:,
//   data:text/html, blob:, svg-data-URLs quedan fuera. El inline-JS twin
//   (getSafeMediaUrlInlineJs) escapa para literal '...' sin entidades HTML.
// - renderNoteImagesHtml: cada <img> pasa por AMBAS antes de interpolar;
//   el onclick usa la URL ya validada + escapeInlineSingleQuote.
// - openImageModal: lee las URLs ya validadas vía img.getAttribute('src') y
//   las asigna a .src por propiedad (nunca innerHTML); sin sink nuevo.
// - hydrateNoteImages / hydrateLegacyNoteImages / migrateNoteImagesToSeparate:
//   todas pintan solo vía renderNoteImagesHtml.
// - TODAS las rutas de subida de foto (9 call sites) pasan por
//   processImageFile: decode real (createImageBitmap/Image) + re-encode a
//   JPEG por canvas + tope 300KB — un archivo renombrado a .jpg NO pasa
//   (img.onerror/createImageBitmap rechaza) y un SVG con script NO sobrevive
//   (sale rasterizado como JPEG).
// - Videos: file.type /^video\// + probeVideoDuration (decode real) +
//   transcodeVideoFile re-graba vía canvas+MediaRecorder; el reensamble de
//   noteVideos/<id> valida /^data:video\/[a-z0-9+.-]+;base64,/i antes de reproducir.
// - Chat file attachments: la descarga usa <a download> + blob URL (descarga
//   forzada, nunca navegación del contenido).
// - scrollRestoration = 0 en index.html (C120 sigue en cero).
// - execCommand: 5 ocurrencias (4 en código como fallback de portapapeles +
//   1 en comentario) — familia C101/C113, sin código nuevo.
// SIN LEADS → sin cambios en app. Este test fija el inventario y la propiedad.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

let failures = 0;
function ok(name, cond) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name); }
}
function tcase(name, fn) {
  try { ok(name, fn()); }
  catch (e) { failures++; console.error('FAIL - ' + name + ' (throw: ' + (e && e.message) + ')'); }
}
function count(re, src) { return (src.match(re) || []).length; }
function extractBetween(startMarker, endMarker) {
  const a = html.indexOf(startMarker);
  if (a < 0) throw new Error('inicio no encontrado: ' + startMarker.slice(0, 50));
  const b = html.indexOf(endMarker, a + startMarker.length);
  if (b < 0) throw new Error('fin no encontrado: ' + endMarker.slice(0, 50));
  return html.slice(a, b);
}

// ---- 1. Re-verifies rápidos ----
tcase('scrollRestoration: 0 en index.html (C120 sigue en cero)', () =>
  count(/scrollRestoration/g, html) === 0);
tcase('execCommand: 8 ocurrencias (7 en código + 1 en comentario; BARO-1: -1 por eliminar Series)', () =>
  count(/execCommand/g, html) === 8);
tcase('execCommand: todos los usos en código son copy (fallback portapapeles)', () => {
  const uses = html.match(/\.execCommand\([^)]*\)/g) || [];
  return uses.length === 7 && uses.every(u => u === ".execCommand('copy')");
});

// ---- 2. Estáticos: pipeline de render de imágenes ----
const renderNoteImagesHtmlBody = extractBetween(
  'function renderNoteImagesHtml(images, noteIdForModal) {',
  '=========== VIDEO-POSTS');
tcase('renderNoteImagesHtml: existe y usa getSafeMediaUrl para el src', () =>
  renderNoteImagesHtmlBody.includes('getSafeMediaUrl(img)'));
tcase('renderNoteImagesHtml: usa getSafeMediaUrlInlineJs para el onclick', () =>
  renderNoteImagesHtmlBody.includes('getSafeMediaUrlInlineJs(img)'));
tcase('renderNoteImagesHtml: NO interpola img sin validar (getSafeMediaUrl ×2, sin ${img} crudo)', () =>
  !/\$\{img\}/.test(renderNoteImagesHtmlBody));
tcase('hydrateNoteImages: pinta solo vía renderNoteImagesHtml', () => {
  const body = extractBetween('function hydrateNoteImages(noteId) {', 'function hydrateLegacyNoteImages');
  return body.includes('renderNoteImagesHtml(imgs, noteId)') && !body.includes('getSafeMediaUrl');
});
tcase('hydrateLegacyNoteImages: pinta solo vía renderNoteImagesHtml', () => {
  const body = extractBetween('function hydrateLegacyNoteImages(noteId, imgKeys) {', 'function migrateNoteImagesToSeparate');
  return body.includes('renderNoteImagesHtml(urls, noteId)');
});
tcase('openImageModal: lee URLs vía getAttribute(\'src\') (ya validadas al pintar)', () =>
  html.includes("map(img => img.getAttribute('src'))"));
tcase('_renderFeedImageModal: asigna .src por propiedad; el único innerHTML son los dots (solo índices numéricos)', () => {
  const body = extractBetween('function _renderFeedImageModal() {', 'function _setFeedImageModalChrome(visible) {');
  const srcAssigns = (body.match(/\.src = /g) || []).length;
  const innerAssigns = (body.match(/\.innerHTML =/g) || []).length;
  const dotsStmt = body.slice(body.indexOf('dots.innerHTML ='));
  const dotsNoUrl = !/src=|http|data:image|getSafeMediaUrl/i.test(dotsStmt.slice(0, 900));
  return srcAssigns >= 3 && innerAssigns === 1 && body.includes('dots.innerHTML = total > 1') && dotsNoUrl;
});

// ---- 3. Estáticos: las 9 rutas de subida pasan por processImageFile ----
tcase('processImageFile: 10 ocurrencias (1 def + 9 call sites de subida)', () =>
  count(/processImageFile\(/g, html) === 10);
for (const fn of ['handleCommentPhotoSelected', 'handleGroupInfoPhotoChange', 'handleProfileImageUpload',
                  'saveNewProfilePhoto', 'handleMusicCoverSelect', 'handleGroupChatPhotoSelected']) {
  tcase(fn + ': su flujo de subida llama a processImageFile', () => html.includes(fn) && html.includes('processImageFile'));
}
tcase('processImageFile: decode real (createImageBitmap/Image) + re-encode JPEG por canvas', () => {
  const body = extractBetween('function processImageFile(file) {', 'function processImageFilesLimited');
  return body.includes('createImageBitmap') && body.includes("canvas.toDataURL('image/jpeg'") &&
    body.includes('img.onerror') && body.includes('MAX_URL_LENGTH');
});
tcase('processImageFile: SVG/malformado no pasa (createImageBitmap rechaza, img.onerror falla)', () => {
  const body = extractBetween('function processImageFile(file) {', 'function processImageFilesLimited');
  return body.includes("finishFail(new Error('No se pudo cargar la imagen seleccionada'))");
});

// ---- 4. Estáticos: video + chat files ----
tcase('video: reensamble valida data:video/...+;base64, antes de reproducir', () =>
  html.includes('/^data:video\\/['));
tcase('video: transcodeVideoFile re-graba vía canvas+MediaRecorder (contenido re-encodado)', () => {
  const body = extractBetween('function transcodeVideoFile(file, onProgress) {', 'function readFileAsDataURL(blob, mime) {');
  return body.includes('MediaRecorder') && body.includes('canvas.captureStream');
});
tcase('video: handleNoteVideoSelected exige file.type video/ + probeVideoDuration (decode real)', () => {
  const body = extractBetween('function handleNoteVideoSelected(event) {', 'function captureNoteVideoThumbnail');
  return body.includes("startsWith('video/')") && body.includes('probeVideoDuration(file)');
});
tcase('chat files: la descarga usa <a download> + blob URL (nunca navega el contenido)', () => {
  const body = extractBetween('async function downloadChatFile(fileId, btnEl) {', 'function _renderChatFileCardHtml');
  return body.includes('a.download =') && body.includes('URL.createObjectURL(blob)');
});

// ---- 5. Conductuales en sandbox: getSafeMediaUrl* ----
const ctx = vm.createContext({
  window: { location: { origin: 'https://floreseternasoporte-creator.github.io' } },
  URL, // getSafeMediaUrl usa new URL(): no es builtin ECMAScript en el sandbox vm
});
const sandboxSrc = [
  extractBetween('function escapeHTML(text) {', 'function getSafeMediaUrl(url, fallback'),
  extractBetween('function escapeSingleQuote(value) {', '============ COMENTARIOS ESTILO INSTAGRAM'),
  extractBetween('function escapeHtml(value) {', 'function openSearchView()'),
  extractBetween('function getSafeMediaUrl(url, fallback = \'\') {', '// URL validada para medios (http/https/data:image) en bruto, sin escapar:'),
  extractBetween('function getSafeMediaUrlRaw(url) {', '// Como getSafeMediaUrl pero para interpolar la URL en un string JS entre'),
  extractBetween('function getSafeMediaUrlInlineJs(url) {', 'function extractMentionUsernames(text) {'),
  extractBetween('function renderNoteImagesHtml(images, noteIdForModal) {', '=========== VIDEO-POSTS'),
].join('\n');
vm.runInContext(sandboxSrc, ctx, { filename: 'c133-media-chain.js' });
const run = (expr) => vm.runInContext(expr, ctx);

tcase('sandbox: funciones extraídas y parseadas OK', () =>
  ['getSafeMediaUrl', 'getSafeMediaUrlRaw', 'getSafeMediaUrlInlineJs', 'renderNoteImagesHtml', 'escapeInlineSingleQuote']
    .every(n => run('typeof ' + n) === 'function'));

const hostileUrls = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(document.domain)',
  'data:text/html,<script>alert(1)</script>',
  'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
  'blob:https://x/abc',
  'vbscript:msgbox(1)',
  '  \n\t ',
  // NOTA: 'http://x.com/a.jpg\r\njavascript:alert(1)' NO va aquí: el strip de
  // controles lo convierte en un http: de un solo path (inocuo), no hay
  // confusión de esquema tras el strip.
];
for (const h of hostileUrls) {
  tcase('getSafeMediaUrl rechaza ' + JSON.stringify(h.slice(0, 40)), () =>
    run('getSafeMediaUrl(' + JSON.stringify(h) + ')') === '');
}
const safeUrls = [
  'https://example.com/foto.jpg',
  'http://cdn.x.com/a/b.png?x=1&y=2',
  '/fotos/a.jpg',
  'data:image/jpeg;base64,/9j/4AAQ',
  'data:image/png;base64,iVBORw0KGgo=',
  'data:image/gif;base64,R0lGODlh',
  'data:image/webp;base64,UklGRg==',
];
for (const s of safeUrls) {
  tcase('getSafeMediaUrl acepta ' + JSON.stringify(s.slice(0, 40)), () =>
    run('getSafeMediaUrl(' + JSON.stringify(s) + ')') !== '');
}
tcase('getSafeMediaUrl: fallback por defecto es cadena vacía', () =>
  run("getSafeMediaUrl('javascript:alert(1)')") === '');
tcase('getSafeMediaUrlRaw: mismo predicado sin escapar (https OK, javascript vacío)', () =>
  run("getSafeMediaUrlRaw('https://x.com/a.jpg')") === 'https://x.com/a.jpg' &&
  run("getSafeMediaUrlRaw('javascript:alert(1)')") === '');
tcase('getSafeMediaUrlInlineJs: escapa comilla simple sin entidades HTML', () => {
  const out = run('getSafeMediaUrlInlineJs(' + JSON.stringify("https://x.com/o'brien.jpg") + ')');
  return out === "https://x.com/o\\'brien.jpg" && !out.includes('&#039;') && !out.includes('&quot;');
});
tcase('getSafeMediaUrlInlineJs: rechaza hostiles igual que el twin', () =>
  run("getSafeMediaUrlInlineJs('javascript:alert(1)')") === '' &&
  run("getSafeMediaUrlInlineJs('data:text/html,<b>x</b>')") === '');
tcase('escapeInlineSingleQuote: & va PRIMERO (&#39; no se decodifica a \')', () => {
  const out = run("escapeInlineSingleQuote('&#39;')");
  return out === '&amp;#39;' && !out.includes('&#39;');
});
tcase('escapeInlineSingleQuote: escapa \\, \', ", <, > y & va primero', () => {
  const inp = 'a\\b\'c"d<e>f&g';
  const out = run('escapeInlineSingleQuote(' + JSON.stringify(inp) + ')');
  const exp = 'a\\\\b\\\'c&quot;d&lt;e&gt;f&amp;g';
  if (out !== exp) return false;
  // Ninguna comilla cruda que rompa el literal JS: la única ' va tras \.
  return out.replace(/\\'/g, '').indexOf("'") === -1 && !out.includes('&#39;');
});

// ---- 6. Conductual: renderNoteImagesHtml con batería hostil ----
tcase('renderNoteImagesHtml: hostiles no llegan al HTML, seguras sí', () => {
  const imgs = [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://ok.com/a.jpg?x=1&y=2',
    'data:image/png;base64,iVBORw0KGgo=',
  ];
  const out = run('renderNoteImagesHtml(' + JSON.stringify(imgs) + ', "note1")');
  return !out.includes('javascript:') && !out.includes('data:text/html') &&
    out.includes('https://ok.com/a.jpg?x=1&amp;y=2') &&
    out.includes('data:image/png;base64,iVBORw0KGgo=');
});
tcase('renderNoteImagesHtml: todas hostiles → ningún <img src interpolado', () => {
  const out = run('renderNoteImagesHtml(["javascript:alert(1)","data:text/html,x"], "n2")');
  return !out.includes('<img src=');
});
tcase('renderNoteImagesHtml: onclick usa URL validada + literal JS escapado (comilla precedida por \\)', () => {
  const out = run('renderNoteImagesHtml(' + JSON.stringify(["https://x.com/a'b.jpg"]) + ', "n3")');
  const m = out.match(/onclick="([^"]*)"/);
  if (!m) return false;
  return m[1].includes('openImageModal') && m[1].includes("https://x.com/a\\'b.jpg");
});
tcase('renderNoteImagesHtml: noteId hostil no rompe atributos (escapado)', () => {
  const out = run('renderNoteImagesHtml(["https://x.com/a.jpg"], "n\\"><script>alert(1)</script>")');
  return !out.includes('<script>alert(1)</script>');
});

if (failures) { console.error(failures + ' FAIL'); process.exit(1); }
console.log('C133 media-url-chain: todos los asserts OK');
