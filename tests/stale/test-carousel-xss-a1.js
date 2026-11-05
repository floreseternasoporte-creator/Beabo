// SEC ciclo 9 A1: XSS almacenado vía saveCarouselPhoto (URL `javascript:` en
// msg.images llegaba a _carouselPhotos y a.href + a.click() la ejecutaba).
// Harness con las funciones REALES extraídas de index.html:
//  1. getSafeMediaUrlRaw debe rechazar `javascript:` y aceptar https/data:image.
//  2. saveCarouselPhoto NO debe hacer click con href `javascript:` aunque
//     _carouselPhotos contenga una URL maliciosa (defensa en profundidad).
//  3. El pipeline de la burbuja (msgImages → JSON inline → parse) no debe
//     dejar pasar `javascript:` al carrusel.
//  4. Las URLs legítimas (https, data:image) siguen funcionando.
// C140: saveCarouselPhoto ahora es async (fetch→blob para que `download` no sea
// inerte en URLs cross-origin). El harness inyecta fetch/AbortController/
// setTimeout en el sandbox y espera la promesa; la propiedad de seguridad
// (ningún click con href javascript:) se sigue asertando igual de estricta.
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFn(name) {
  let i = html.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no encontrada: ' + name);
  // C126: conservar el `async ` previo si existe (si no, `await` da SyntaxError)
  if (html.slice(Math.max(0, i - 6), i) === 'async ') i -= 6;
  let j = html.indexOf('{', i), depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}') { depth--; if (!depth) return html.slice(i, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}

// ---- Sandbox mínima (las funciones usan window/document/fetch) ----
const clicks = [];   // { href, download, target } por cada a.click()
const opened = [];   // args de window.open (fallback)
const sandbox = {
  window: {
    location: { origin: 'https://app.drex.local' },
    open: (...args) => { opened.push(args); },
  },
  URL: URL, // el contexto vm no trae URL por defecto; inyectar la real
  AbortController: AbortController,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  fetch: async () => ({ ok: true, blob: async () => new Blob(['fakejpeg'], { type: 'image/jpeg' }) }),
  document: {
    createElement: () => {
      const a = {};
      let href = '';
      Object.defineProperty(a, 'href', { get: () => href, set: v => { href = String(v); } });
      a.click = () => clicks.push({ href, download: a.download, target: a.target });
      return a;
    },
    body: { appendChild: () => {}, removeChild: () => {} },
  },
  _carouselPhotos: [],
  _carouselIndex: 0,
};
const vm = require('vm');
vm.createContext(sandbox);
vm.runInContext(extractFn('getSafeMediaUrlRaw'), sandbox);
vm.runInContext(extractFn('saveCarouselPhoto'), sandbox);
const raw = sandbox.getSafeMediaUrlRaw;

(async () => {
  // 1. Validador real
  check('javascript: -> rechazado', raw('javascript:alert(document.cookie)') === '');
  check('JaVaScRiPt: (mayúsculas) -> rechazado', raw('JaVaScRiPt:alert(1)') === '');
  check('https válido -> intacto', raw('https://foto-valida.jpg/x.jpg') === 'https://foto-valida.jpg/x.jpg');
  check('data:image válido -> intacto', raw('data:image/png;base64,iVBORw0KGgo=') === 'data:image/png;base64,iVBORw0KGgo=');
  check('data:text/html -> rechazado', raw('data:text/html,<script>alert(1)</script>') === '');

  // 2. Sumidero real: inyectar URL maliciosa directo en _carouselPhotos
  sandbox._carouselPhotos = ['https://ok.jpg', 'javascript:alert(document.cookie)'];
  sandbox._carouselIndex = 1;
  clicks.length = 0;
  opened.length = 0;
  await vm.runInContext('saveCarouselPhoto()', sandbox);
  const badClick = clicks.some(c => /^javascript:/i.test(c.href));
  const badOpen = opened.some(a => a[0] && /^javascript:/i.test(String(a[0])));
  check('saveCarouselPhoto NO hace click con href javascript:', !badClick);
  check('saveCarouselPhoto NO abre javascript: en fallback:', !badOpen);

  // 3. Pipeline real de la burbuja: msgImages debe filtrarse antes del JSON
  const lineMatch = html.match(/const msgImages = [\s\S]*?;/);
  check('línea msgImages encontrada', !!lineMatch);
  const filtersAtSource = /getSafeMediaUrlRaw/.test(lineMatch ? lineMatch[0] : '');
  check('msgImages se filtra con getSafeMediaUrlRaw en origen', filtersAtSource);
  // Simular el pipeline exacto con la línea real evaluada
  const msg = { images: ['https://foto-valida.jpg', 'javascript:alert(document.cookie)'] };
  sandbox.msg = msg;
  const msgImages = vm.runInContext(
    '(' + lineMatch[0].replace(/^const msgImages = /, '').replace(/;$/, '') + ')',
    sandbox
  );
  delete sandbox.msg;
  const safeImagesJson = JSON.stringify(msgImages).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
  const decoded = safeImagesJson.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const parsed = JSON.parse(decoded); // lo que recibe openPhotoCarousel
  check('el carrusel NO recibe javascript:', !parsed.some(u => /^javascript:/i.test(u)));
  check('el carrusel SÍ recibe la foto válida', parsed.includes('https://foto-valida.jpg'));

  // 4. Caso sano: guardar foto válida descarga vía blob (C140)
  sandbox._carouselPhotos = ['https://ok.jpg'];
  sandbox._carouselIndex = 0;
  clicks.length = 0;
  opened.length = 0;
  await vm.runInContext('saveCarouselPhoto()', sandbox);
  check('foto https válida sí dispara la descarga', clicks.length === 1);
  check('la descarga usa blob: (download ya no es inerte)',
    clicks.length === 1 && /^blob:/.test(clicks[0].href));
  check('el anchor lleva download=drex-photo-*.jpg',
    clicks.length === 1 && /^drex-photo-\d+\.jpg$/.test(clicks[0].download || ''));
  check('sin fallback a pestaña nueva en el caso sano', opened.length === 0);

  // 5. Fallback honesto: si el fetch falla (CORS), abre en pestaña con noopener
  sandbox.fetch = async () => { throw new Error('CORS bloqueado'); };
  clicks.length = 0;
  opened.length = 0;
  await vm.runInContext('saveCarouselPhoto()', sandbox);
  check('fallback: window.open con la URL segura',
    opened.length === 1 && opened[0][0] === 'https://ok.jpg');
  check('fallback: con feature noopener (sin tabnabbing)',
    opened.length === 1 && opened[0][1] === '_blank' && opened[0][2] === 'noopener');
  check('fallback: ningún click de descarga a medias', clicks.length === 0);

  console.log(failures ? `\n${failures} FALLOS` : '\nTODOS LOS CHECKS PASARON');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('ERROR en harness:', e); process.exit(1); });
