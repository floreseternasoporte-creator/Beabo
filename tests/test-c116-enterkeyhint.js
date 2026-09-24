// C116: auditoría de la familia `enterkeyhint` en campos móviles.
// Solo 2 campos la tenían (gif-search-input, sticker-search, ambos "search").
// El teclado móvil mostraba "return" genérico en vez de la acción real:
// "enviar" en los compositores de chat, "buscar" en los 15 campos de
// búsqueda, "siguiente"/"ir" en el flujo de auth/registro.
// El fix agrega enterkeyhint con el valor que refleja la acción real de Enter.
'use strict';
const fs = require('fs');
const path = require('path');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(__dirname, '..', 'index.html');
let html;
try { html = fs.readFileSync(htmlPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer index.html'); process.exit(1); }

let failures = 0;
function ok(name, cond) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name); }
}

function tagWithId(id) {
  const m = html.match(new RegExp('<(?:input|textarea)\\b[^>]*\\bid="' + id + '"[^>]*>', 'i'));
  return m ? m[0] : null;
}
function hasHint(id, value) {
  const tag = tagWithId(id);
  if (!tag) return false;
  const m = tag.match(/enterkeyhint="([^"]*)"/i);
  return !!m && m[1] === value;
}

// ---------- 1. Campos de envío: Enter envía (verificado en el JS) ----------
ok('chat-room-input enterkeyhint="send"', hasHint('chat-room-input', 'send'));
ok('fiesta-chat-input enterkeyhint="send"', hasHint('fiesta-chat-input', 'send'));
ok('chat-edit-input enterkeyhint="done"', hasHint('chat-edit-input', 'done'));

// ---------- 2. Campos de búsqueda: enterkeyhint="search" ----------
const SEARCH_IDS = [
  'search-input', 'chat-search-input', 'new-chat-search-input',
  'group-chat-search-input', 'chat-forward-search', 'chat-message-search-input',
  'group-search-input', 'add-member-search-input', 'share-post-search-input',
  'fiesta-games-search', 'settings-search-input', 'music-explore-input',
  'help-center-search', 'onb-country-search', 'settings-country-search',
  // pre-existentes (regresión: siguen intactos)
  'gif-search-input', 'sticker-search',
];
for (const id of SEARCH_IDS) {
  ok(id + ' enterkeyhint="search"', hasHint(id, 'search'));
}

// ---------- 3. Auth: email -> next, password -> go (authForm submit on Enter) ----------
ok('emailInput enterkeyhint="next"', hasHint('emailInput', 'next'));
ok('passwordInput enterkeyhint="go"', hasHint('passwordInput', 'go'));

// ---------- 4. Registro por pasos: intermedios -> next ----------
ok('regEmail enterkeyhint="next"', hasHint('regEmail', 'next'));
ok('regPassword enterkeyhint="next"', hasHint('regPassword', 'next'));
ok('regUsername enterkeyhint="next"', hasHint('regUsername', 'next'));

// ---------- 5. Los bindings de Enter que justifican "send"/"done" siguen en el JS ----------
ok('chat-room-input: keydown Enter -> sendChatMessage',
  /getElementById\('chat-room-input'\)[\s\S]{0,400}?event\.key === 'Enter'[\s\S]{0,200}?sendChatMessage\(\)/.test(html));
ok('fiesta-chat-input: onkeydown Enter -> fiestaSendChat',
  /id="fiesta-chat-input"[^>]*onkeydown="if\(event\.key==='Enter'\)[^"]*fiestaSendChat\(\)/.test(html));
ok('chat-edit-input: onkeydown Enter -> saveEditedChatMessage',
  /id="chat-edit-input"[^>]*onkeydown="if\(event\.key==='Enter'[^"]*saveEditedChatMessage\(\)/.test(html));
ok('authForm: listener submit (Enter envía el login)',
  /id="authForm"/.test(html) && /authForm\.addEventListener\('submit'/.test(html));

// ---------- 6. No-change documentados: multilínea sin binding de Enter ----------
const commentTag = tagWithId('comment-input-main');
ok('comment-input-main existe y NO lleva enterkeyhint (Enter = salto de línea)',
  !!commentTag && !/enterkeyhint=/i.test(commentTag));

// ---------- 7. Limpieza de console.log en producción (C116) ----------
ok('cero console.log en producción', !/console\.log\(/.test(html));
ok('console.error intactos (logging de errores conservado)', /console\.error\(/.test(html));

if (failures) { console.error(failures + ' FAIL(s)'); process.exit(1); }
console.log('ALL OK');
