// SEC ciclo 9 A1: XSS almacenado vía saveCarouselPhoto (URL `javascript:` en
// msg.images llegaba a _carouselPhotos y a.href + a.click() la ejecutaba).
// Harness con las funciones REALES extraídas de index.html:
//  1. getSafeMediaUrlRaw debe rechazar `javascript:` y aceptar https/data:image.
//  2. saveCarouselPhoto NO debe hacer click con href `javascript:` aunque
//     _carouselPhotos contenga una URL maliciosa (defensa en profundidad).
//  3. El pipeline de la burbuja (msgImages → JSON inline → parse) no debe
//     dejar pasar `javascript:` al carrusel.
//  4. Las URLs legítimas (https, data:image) siguen funcionando.
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFn(name) {
  const i = html.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no encontrada: ' + name);
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

// ---- Sandbox mínima (las funciones usan window/document) ----
const clicks = [];
const sandbox = {
  window: { location: { origin: 'https://app.drex.local' } },
  URL: URL, // el contexto vm no trae URL por defecto; inyectar la real
  document: {
    createElement: () => {
      const a = {};
      let href = '';
      Object.defineProperty(a, 'href', { get: () => href, set: v => { href = String(v); } });
      a.click = () => clicks.push(href);
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
vm.runInContext('saveCarouselPhoto()', sandbox);
const badClick = clicks.some(h => /^javascript:/i.test(h));
check('saveCarouselPhoto NO hace click con href javascript:', !badClick);

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

// 4. Caso sano: guardar foto válida sigue funcionando
sandbox._carouselPhotos = ['https://ok.jpg'];
sandbox._carouselIndex = 0;
clicks.length = 0;
vm.runInContext('saveCarouselPhoto()', sandbox);
check('foto https válida sí dispara la descarga', clicks.length === 1 && clicks[0] === 'https://ok.jpg');

console.log(failures ? `\n${failures} FALLOS` : '\nTODOS LOS CHECKS PASARON');
process.exit(failures ? 1 : 0);
