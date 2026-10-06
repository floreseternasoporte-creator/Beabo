// C252: el panel "Burbujas del chat" (temas) no debe lanzar TypeError al abrir.
// Causa raíz cazada en runtime (rastreo jsdom de 118 abridores): la burbuja de
// vista previa #theme-preview-bubble-mine nace en el HTML SIN atributo style, y
// _updateThemeLivePreview hacía getAttribute('style').replace(...) sobre null.
// Todo usuario que abría el panel recibía el error y la vista previa no se
// actualizaba. La guarda (|| '') lo resuelve; este test la protege.
const fs = require('fs');
let ok = 0, fail = 0;
function check(name, cond) {
  if (cond) { ok++; }
  else { fail++; console.log('  ✗ FALLO:', name); }
}

const html = fs.readFileSync('index.html', 'utf8');

// El elemento existe y abre el panel desde dos botones reales.
check('el panel de temas existe (#chat-bubbles-panel)', html.includes('id="chat-bubbles-panel"'));
check('la burbuja de vista previa existe', html.includes('id="theme-preview-bubble-mine"'));
check('hay botones reales que abren el panel',
  (html.match(/onclick="openChatBubblesPanel\(\)"/g) || []).length >= 2);
check('openChatBubblesPanel está definida', /function openChatBubblesPanel\(\)/.test(html));
check('_updateThemeLivePreview está definida', /function _updateThemeLivePreview\(theme\)/.test(html));

// La guarda contra null está presente y el patrón peligroso ya no existe.
check('lectura de style protegida contra null',
  html.includes("(mineBubble.getAttribute('style') || '').replace("));
check('el patrón sin guarda desapareció',
  !html.includes("mineBubble.getAttribute('style').replace("));

// La función sigue aplicando el tema a la vista previa (no se amputó la lógica).
const fnStart = html.indexOf('function _updateThemeLivePreview');
const fnBody = html.slice(fnStart, fnStart + 900);
check('la vista previa sigue recibiendo el fondo del tema',
  fnBody.includes("preview.style.background = def.bg"));
check('la burbuja propia sigue recibiendo el estilo del tema',
  fnBody.includes("';' + def.mine"));

console.log(`test-c252-chat-theme-preview: ${ok} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
