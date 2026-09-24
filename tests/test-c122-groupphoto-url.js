// C122: fix de fuga de object URL en la foto del grupo de chat.
// `closeCreateGroupChatView()` no revocaba `groupChatSelectedPhotoPreviewUrl`:
// tras crear el grupo (o cerrar con ✕) el blob URL + el File quedaban
// retenidos en memoria toda la sesión. El fix revoca + nullea ambos al cerrar.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
function tcase(name, fn) {
  try { ok(name, fn()); }
  catch (e) { failures++; console.error('FAIL - ' + name + ' (throw: ' + (e && e.message) + ')'); }
}

// Extrae el cuerpo de `function closeCreateGroupChatView() { ... }` con balance de llaves.
function extractFnBody(src, fnName) {
  const start = src.indexOf('function ' + fnName + '(');
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

const body = extractFnBody(html, 'closeCreateGroupChatView');
ok('closeCreateGroupChatView existe', body !== null);

// ---------- 1. Aserciones estáticas sobre el cuerpo ----------
if (body) {
  ok('revoca groupChatSelectedPhotoPreviewUrl',
    /revokeObjectURL\s*\(\s*groupChatSelectedPhotoPreviewUrl\s*\)/.test(body));
  ok('nullea groupChatSelectedPhotoPreviewUrl',
    /groupChatSelectedPhotoPreviewUrl\s*=\s*null/.test(body));
  ok('nullea groupChatSelectedPhotoFile',
    /groupChatSelectedPhotoFile\s*=\s*null/.test(body));
  ok('el revoke va blindado con try/catch',
    /try\s*\{\s*URL\.revokeObjectURL\s*\(\s*groupChatSelectedPhotoPreviewUrl\s*\)/.test(body));
}

// ---------- 2. Prueba conductual en sandbox vm ----------
tcase('conductual: al cerrar se revoca la URL y se nullea todo', () => {
  if (!body) return false;
  const revoked = [];
  const sandbox = {
    document: { getElementById: () => ({ classList: { add() {} } }) },
    URL: { revokeObjectURL(u) { revoked.push(u); } },
  };
  vm.createContext(sandbox);
  const probe =
    'var groupChatSelectedPhotoPreviewUrl = "blob:fake-123";\n' +
    'var groupChatSelectedPhotoFile = { name: "foto.jpg" };\n' +
    'function closeCreateGroupChatView() {' + body + '}\n' +
    'closeCreateGroupChatView();\n' +
    'JSON.stringify({ urlNull: groupChatSelectedPhotoPreviewUrl === null, fileNull: groupChatSelectedPhotoFile === null });';
  const out = JSON.parse(vm.runInContext(probe, sandbox));
  return revoked.length === 1 && revoked[0] === 'blob:fake-123' && out.urlNull === true && out.fileNull === true;
});

// ---------- 3. Regresión: los revokes pre-existentes siguen intactos ----------
const openBody = extractFnBody(html, 'openCreateGroupChatView');
ok('openCreateGroupChatView sigue revocando al abrir (red de seguridad)',
  !!openBody && /revokeObjectURL\s*\(\s*groupChatSelectedPhotoPreviewUrl\s*\)/.test(openBody));
const selBody = extractFnBody(html, 'handleGroupChatPhotoSelected');
ok('handleGroupChatPhotoSelected sigue revocando antes de re-crear',
  !!selBody && /revokeObjectURL\s*\(\s*groupChatSelectedPhotoPreviewUrl\s*\)/.test(selBody));

// ---------- 4. El fix vive fuera de bloques delimitados por marcadores viejos ----------
// (ningún test viejo delimita closeCreateGroupChatView; aserción de cordura)
ok('sin duplicados de la función', (html.match(/function closeCreateGroupChatView\(\)/g) || []).length === 1);

if (failures) { console.error(failures + ' FAIL(s)'); process.exit(1); }
console.log('TODOS OK');
