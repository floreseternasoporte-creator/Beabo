'use strict';
/* C271 — Dos fallos que el usuario vio en su iPhone en las pestañas del
 * perfil (C269):
 *
 *  FALLO 1: Respuestas pintaba el payload crudo `__sticker__:<url>` como
 *  texto (captura: `__sticker__:https://i.ibb.co/MysRv7gF/IMG-9686.png`).
 *  Fix: clasificador puro `_drexClassifyProfileReply` con el mismo
 *  criterio que la vista de comentarios (renderContentWithSticker) y el
 *  historial (cPhoto/cGif/cSticker): sticker/foto se DIBUJAN, el texto
 *  sale limpio, el payload jamás aparece.
 *
 *  FALLO 2: Multimedia salía vacía teniendo fotos publicadas, porque
 *  solo leía los campos inline de la nota y las fotos actuales viven
 *  separadas en noteImages/<noteId> (la nota guarda imageCount).
 *  Fix: hidratar con loadNoteImages (la del feed) + respaldo acotado
 *  orderByChild('authorId') para posts viejos fuera del índice.
 *
 * Ejecutar: node tests/test-c271-perfil-respuestas-media.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/* ============ (a) clasificador puro, función real extraída ============ */
function extractFn(name) {
  const m = html.match(new RegExp('function ' + name + '\\b[\\s\\S]*?\\n  \\}', 'm'));
  if (!m) throw new Error('no encontrada: ' + name);
  return m[0];
}
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(extractFn('_drexClassifyProfileReply'), sandbox);
const classify = sandbox._drexClassifyProfileReply;
ok(typeof classify === 'function', 'clasificador extraído del index real');

console.log('== (a) Casos puros del clasificador ==');
// El caso EXACTO de la captura del usuario
let r = classify({ content: '__sticker__:https://i.ibb.co/MysRv7gF/IMG-9686.png' });
ok(r.kind === 'sticker' && r.url === 'https://i.ibb.co/MysRv7gF/IMG-9686.png' && r.text === '',
  'payload __sticker__:<url> -> sticker con su URL, sin texto basura', JSON.stringify(r));
// Sticker guardado en la entrada (cSticker), sin content
r = classify({ content: '', cSticker: 'https://i.ibb.co/abc/sticker.png' });
ok(r.kind === 'sticker' && r.url === 'https://i.ibb.co/abc/sticker.png', 'cSticker -> sticker', JSON.stringify(r));
// Sticker con texto acompañante
r = classify({ content: '__sticker__:https://i.ibb.co/a.png__text__:qué lindo' });
ok(r.kind === 'sticker' && r.url === 'https://i.ibb.co/a.png' && r.text === 'qué lindo',
  'sticker + __text__ -> sticker y su texto limpio', JSON.stringify(r));
// Sticker por id del catálogo Drex (sin URL)
r = classify({ content: '', cSticker: 'cara-feliz' });
ok(r.kind === 'sticker' && r.id === 'cara-feliz' && r.url === '', 'cSticker por id -> sticker (arte)', JSON.stringify(r));
// Texto normal pasa tal cual
r = classify({ content: 'La de Megan 1 jajaja porque Megan 2 no me gustó para nada' });
ok(r.kind === 'text' && r.text === 'La de Megan 1 jajaja porque Megan 2 no me gustó para nada', 'texto normal -> texto', JSON.stringify(r));
// Foto con su campo propio y la etiqueta placeholder que escribe la app
r = classify({ content: 'Foto', cPhoto: 'data:image/jpeg;base64,AAAA' });
ok(r.kind === 'media' && r.url.indexOf('data:image/jpeg') === 0 && r.text === '',
  'cPhoto -> media, y la etiqueta "Foto" no se pinta como texto', JSON.stringify(r));
// GIF propio
r = classify({ content: '', cGif: 'https://media.example.com/x.gif' });
ok(r.kind === 'media' && r.url.endsWith('.gif'), 'cGif -> media', JSON.stringify(r));
// URL de foto suelta como contenido
r = classify({ content: 'https://i.ibb.co/xyz/foto.jpg' });
ok(r.kind === 'media' && r.url === 'https://i.ibb.co/xyz/foto.jpg', 'URL de foto suelta -> media', JSON.stringify(r));
// URL que NO es imagen: sigue siendo texto
r = classify({ content: 'https://ejemplo.com/una-pagina' });
ok(r.kind === 'text' && r.text === 'https://ejemplo.com/una-pagina', 'URL sin imagen -> texto', JSON.stringify(r));
// Entrada vacía: texto vacío (el caller pone "Comentario sin texto")
r = classify({});
ok(r.kind === 'text' && r.text === '', 'entrada vacía -> texto vacío', JSON.stringify(r));
// El pie de foto real acompaña a la foto
r = classify({ content: 'mi foto nueva', cPhoto: 'https://i.ibb.co/p.png' });
ok(r.kind === 'media' && r.text === 'mi foto nueva', 'foto con pie -> media + texto', JSON.stringify(r));

/* ============ (b) contratos de código fuente ============ */
console.log('== (b) Contratos en el código fuente ==');
const iCard = html.indexOf('function _profileReplyCardHTML');
const iReplies = html.indexOf('async function loadProfileRepliesInto');
ok(iCard > -1 && iReplies > iCard, 'región de la tarjeta de respuesta localizada');
const cardSrc = html.slice(iCard, iReplies);
ok(cardSrc.includes('_drexClassifyProfileReply(item)'), 'la tarjeta clasifica antes de pintar');
ok(!cardSrc.includes('item.content'), 'la tarjeta YA NO pinta item.content crudo');
ok(cardSrc.includes('w-[72px] h-[72px]'), 'sticker/foto se dibujan a ~72px');

const iMedia = html.indexOf('async function loadProfileMediaInto');
const iEcos = html.indexOf('async function loadMyProfileEcosMobile');
ok(iMedia > -1 && iEcos > iMedia, 'región del cargador de multimedia localizada');
const mediaSrc = html.slice(iMedia, iEcos);
ok(mediaSrc.includes("ref('notesByAuthor/' + uid)"), 'Multimedia sigue partiendo del índice notesByAuthor');
ok(mediaSrc.includes('loadNoteImages'), 'Multimedia hidrata las fotos separadas (feed: loadNoteImages)');
ok(mediaSrc.includes('imageCount'), 'Multimedia usa imageCount como señal de fotos separadas');
ok(mediaSrc.includes("noteImages/<noteId>") || mediaSrc.includes('loadNoteImages(n.id)'),
  'Multimedia consulta el almacén noteImages de las fotos');
ok(mediaSrc.includes("orderByChild('authorId')"), 'Multimedia tiene el respaldo acotado para posts viejos');
ok(mediaSrc.includes('video: true') && mediaSrc.includes('n.video.thumb'),
  'Multimedia mantiene los videos con su miniatura y distintivo');

console.log(failures ? '\nRESULTADO: ' + failures + ' FALLO(S)' : '\nRESULTADO: TODO VERDE');
process.exit(failures ? 1 : 0);
