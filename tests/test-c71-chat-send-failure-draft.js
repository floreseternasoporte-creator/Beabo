// C71-C2: tras un envío en vuelo FALLIDO, el texto se restaura al input pero
// el borrador (limpiado al iniciar el envío) quedaba en '': navegar o recargar
// antes de reintentar perdía el mensaje. El catch debe persistir el texto
// restaurado con saveChatDraft().
// Test de regresión estática: verifica que el bloque catch de
// _pushOptimisticChatMessage llama a saveChatDraft() después de restaurar
// inputEl.value = text.
// Uso: node tests/test-c71-chat-send-failure-draft.js [ruta/index.html]
'use strict';
const fs = require('fs');
const path = require('path');

const htmlPath = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}

// Localizar el catch del envío dentro de _pushOptimisticChatMessage.
const fnAnchor = 'function _pushOptimisticChatMessage(';
const fnIdx = html.indexOf(fnAnchor);
check('función _pushOptimisticChatMessage presente', fnIdx !== -1);
let catchBlock = '';
if (fnIdx !== -1) {
  const catchIdx = html.indexOf('}).catch((err) => {', fnIdx);
  check('bloque catch del envío presente', catchIdx !== -1);
  if (catchIdx !== -1) {
    // El catch termina con '});\n  }\n' antes del cierre de la función.
    const endIdx = html.indexOf('\n    });\n  }\n', catchIdx);
    catchBlock = endIdx !== -1 ? html.slice(catchIdx, endIdx) : html.slice(catchIdx, catchIdx + 2500);
  }
}
const restoreIdx = catchBlock.indexOf('inputEl.value = text');
// lastIndexOf: el comentario C71-C2 menciona saveChatDraft() antes de la llamada real.
const saveIdx = catchBlock.lastIndexOf('saveChatDraft()');
check('el catch restaura el texto al input', restoreIdx !== -1);
check('el catch persiste el borrador tras restaurar (C71-C2)', saveIdx !== -1 && restoreIdx !== -1 && saveIdx > restoreIdx);

console.log(failures ? '\nRESULTADO: FAIL' : '\nRESULTADO: OK');
process.exit(failures ? 1 : 0);
