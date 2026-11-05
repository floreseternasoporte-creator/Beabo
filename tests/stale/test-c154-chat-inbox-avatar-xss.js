/* ================================================================
 * C154 — XSS almacenado en el inbox de chat vía profileImage forjado
 * (familia `chat`, foco de la rotación C154).
 *
 * HALLAZGO: `users/<uid>/profileImage` lo escribe el propio dueño (forjable
 * con un cliente directo, sin pasar por la UI). Llegaba CRUDO a
 * `getChatUserProfile().image` → `item.otherImage` → dos plantillas del
 * inbox:
 *   1. fila de solicitud (Antesala): renderAntesalaRequestsSection
 *   2. fila DM: renderChatConversations (rama openChatRoomFromInbox)
 * ambas con `<img src="${safeImage}" ... onerror="this.src='...'">` donde
 * `safeImage = item.otherImage` sin escape.
 *
 * PoC (Chromium 152 real, CDP): profileImage = `x" onerror="window.__XSS_C154=1`
 * → el navegador parsea onerror="window.__XSS_C154=1" (el atributo inyectado
 * GANA al legítimo: primer duplicado vence) y al disparar el error de carga
 * el handler SE EJECUTA (flag = 1). En la fila de Antesala el atacante ni
 * siquiera necesita conversación aceptada: basta una solicitud de mensaje.
 *
 * FIX: `getSafeMediaUrl(item.otherImage, <fallback>)` en los dos sinks
 * (valida esquema http(s)/data:image + escapa entidades HTML). Post-fix el
 * mismo payload deja un único onerror legítimo y flag = 0 (verificado en
 * Chromium real).
 *
 * Ejecutar con: node tests/test-c154-chat-inbox-avatar-xss.js
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

// Funciones REALES del bundle, ejecutadas en sandbox (contadores por closure: n/a,
// aquí el invariante es el valor devuelto).
const sandbox = { window: { location: { origin: 'https://drex.test' } }, URL };
vm.createContext(sandbox);
for (const fn of ['escapeHTML', 'getSafeMediaUrl']) vm.runInContext(extractFn(html, fn), sandbox);
const safeUrl = (u, fb) => vm.runInContext(
  `getSafeMediaUrl(${JSON.stringify(u)}, ${JSON.stringify(fb)})`, sandbox);

const FORGED = 'x" onerror="window.__XSS_C154=1';
const FALLBACK = 'data:image/svg+xml;base64,AAA';

// ---- 1. Provenance: los dos sinks del inbox sanitizan otherImage ----
tcase('2 plantillas de fila con src="${safeImage}" en el inbox (Antesala + DM)', () =>
  (html.match(/<img src="\$\{safeImage\}"/g) || []).length === 2);

tcase('fila Antesala: safeImage pasa por getSafeMediaUrl(item.otherImage, ...)', () => {
  const i = html.indexOf('function renderAntesalaRequestsSection(');
  const j = html.indexOf('function renderChatConversations(');
  const body = html.slice(i, j);
  return /const safeImage = getSafeMediaUrl\(item\.otherImage,/.test(body);
});

tcase('fila DM: safeImage pasa por getSafeMediaUrl(item.otherImage, ...)', () => {
  const i = html.indexOf('function renderChatConversations(');
  const body = html.slice(i, i + 9000);
  return /const safeImage = getSafeMediaUrl\(item\.otherImage,/.test(body);
});

tcase('ningún `item.otherImage ||` crudo queda en las filas del inbox', () => {
  const i = html.indexOf('function renderAntesalaRequestsSection(');
  const j = html.indexOf('function showConvOptions(');
  const body = html.slice(i, j);
  return !/item\.otherImage \|\|/.test(body);
});

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
  // `x&quot;...` como URL relativa no contiene javascript: ni rompe el atributo
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

console.log(failures ? `\n${failures} FALLOS` : '\nTODOS LOS CHECKS PASARON');
process.exit(failures ? 1 : 0);
