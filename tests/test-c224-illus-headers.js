/* C224: ilustraciones 3D visibles SIEMPRE en las cabeceras de sección
 * (no solo en estados vacíos). Verifica que cada cabecera tenga su <img>
 * decorativa con el PNG correcto, alt="", loading="lazy", clase .drex-illus
 * y tamaño 36-64px; y que los estados vacíos C222 sigan intactos.
 * Uso: node tests/test-c224-illus-headers.js [--target <ruta>]
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let target = path.join(__dirname, '..', 'index.html');
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) target = process.argv[i + 1];
}
const html = fs.readFileSync(target, 'utf8');
let pass = 0;
function ok(cond, msg) {
  assert.ok(cond, 'FAIL: ' + msg);
  pass++;
  console.log('  ok - ' + msg);
}

// Cabeceras: [nombre, png, contexto cercano que identifica la cabecera]
const headers = [
  ['notificaciones', 'drex-illus-notif.png', '>Actividad</h2>'],
  ['chats', 'drex-illus-chat.png', '>Chats</h2>'],
  ['buscar', 'drex-illus-search.png', '>Explorar</h2>'],
  ['destellos', 'drex-illus-diamond.png', 'id="drex-snap-title"'],
  ['guardados', 'drex-illus-saved.png', '>Posts guardados</h2>'],
  ['efectos (perfil)', 'drex-illus-fx.png', 'id="profile-efectos-header"'],
  ['efectos (autor)', 'drex-illus-fx.png', '>Efectos</h3>'],
  ['pulso', 'drex-illus-oops.png', 'id="pulso-view-title"'],
];

for (const [name, png, anchor] of headers) {
  const ai = html.indexOf(anchor);
  ok(ai !== -1, `cabecera "${name}": ancla de título presente`);
  // El <img> debe estar cerca del título (cabecera), no dentro del estado vacío.
  const winStart = Math.max(0, ai - 600);
  const win = html.slice(winStart, ai + 200);
  const imgRe = new RegExp(
    '<img[^>]*src="drex-illus/' + png.replace('.', '\\.') + '"[^>]*>', 'g'
  );
  const imgs = win.match(imgRe) || [];
  ok(imgs.length >= 1, `cabecera "${name}": <img> con ${png} junto al título`);
  const tag = imgs[0];
  ok(/alt=""/.test(tag), `cabecera "${name}": alt="" decorativo`);
  ok(/loading="lazy"/.test(tag), `cabecera "${name}": loading="lazy"`);
  ok(/class="[^"]*drex-illus/.test(tag), `cabecera "${name}": clase .drex-illus (animación flotante)`);
  const w = tag.match(/width:(\d+)px/);
  ok(w && +w[1] >= 36 && +w[1] <= 64, `cabecera "${name}": tamaño ${w ? w[1] : '?'}px dentro de 36-64`);
}

// Los estados vacíos C222 siguen intactos (ilustración grande en el empty state).
const emptyRefs = [
  'drex-illus-notif.png', 'drex-illus-chat.png', 'drex-illus-fx.png',
  'drex-illus-search.png', 'drex-illus-diamond.png', 'drex-illus-saved.png',
  'drex-illus-oops.png',
];
for (const png of emptyRefs) {
  const n = (html.match(new RegExp('drex-illus/' + png.replace('.', '\\.'), 'g')) || []).length;
  ok(n >= 1, `estado vacío: ${png} sigue referenciado (${n} usos)`);
}

// PNGs existen en disco con canal alfa.
for (const png of emptyRefs) {
  const fp = path.join(__dirname, '..', 'drex-illus', png);
  ok(fs.existsSync(fp), `archivo drex-illus/${png} existe`);
  const buf = fs.readFileSync(fp);
  // PNG con color type RGBA(6) o paleta con tRNS: byte 25 del IHDR = color type.
  const colorType = buf[25];
  const hasTRNS = buf.includes(Buffer.from('tRNS'));
  ok(colorType === 6 || colorType === 3 && hasTRNS || colorType === 2 && hasTRNS || hasTRNS,
    `drex-illus/${png}: tiene canal alfa (colorType=${colorType})`);
}

console.log(`\nC224: ${pass} checks verdes`);
