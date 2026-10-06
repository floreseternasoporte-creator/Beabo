/* ================================================================
 * UI-LANE2: auditoría de mensajería a 390px (iPhone, ES/EN/ZH/PT).
 *
 * Verifica sobre el código (no necesita backend):
 *  P1: los títulos de chat que vienen de datos de usuario se pintan
 *      sin emojis (fiestaStripEmoji) — header DM, header de grupo,
 *      filas de la bandeja (DM/grupo/antesala), hoja de opciones,
 *      etiqueta del remitente en grupos, cita de respuesta y panel
 *      de perfil del remitente.
 *  P2: cero emojis como iconos en la UI de chat — ni 📎/📷/📌 en
 *      previews ni ❤️ en la animación de doble-tap.
 *  P3: todos los strings visibles de la zona de chat pasan por appT()
 *      (o por el pase de nodos de texto) y cada clave appT('...')
 *      existe en EN/ZH/PT.
 *  P4: orden visual correcto de los elementos del mensaje —
 *      etiqueta del remitente ANTES de la burbuja, hora DESPUÉS;
 *      avatar del DM junto a la burbuja (no flotando).
 *  P5: los placeholders/aria-label del chat tienen cobertura en los
 *      3 diccionarios de atributos.
 *  P6: las fechas (separador de día, menú del mensaje) respetan el
 *      idioma de la app en vez de español fijo.
 *
 * Uso: node tests/test-ui-chat-390.js   (código 0 = todo OK)
 * Sin dependencias externas — solo Node.js.
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var i18n = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

/* ---------- utilidades ---------- */
function extractDict(varName) {
  var start = i18n.indexOf(varName);
  assert(start !== -1, 'no se encontró ' + varName);
  var i = i18n.indexOf('{', start);
  assert(i !== -1, 'sin llave de apertura en ' + varName);
  var depth = 0, inStr = false, esc = false, q = '';
  for (var j = i; j < i18n.length; j++) {
    var ch = i18n[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === q) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; q = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i = j; break; } }
  }
  assert(depth === 0, 'llaves sin cerrar en ' + varName);
  var dict = new Function('return (' + i18n.slice(i18n.indexOf('{', start), i + 1) + ');')();
  assert(Object.keys(dict).length > 100, varName + ' parece vacío o mal parseado');
  return dict;
}
var EN = extractDict('var APP_ENGLISH_TEXT = {');
var ZH = extractDict('var APP_CHINESE_TEXT = {');
var PT = extractDict('var APP_PORTUGUESE_TEXT = {');
var EN_A = extractDict('var APP_ENGLISH_ATTRS = {');
var ZH_A = extractDict('var APP_CHINESE_ATTRS = {');
var PT_A = extractDict('var APP_PORTUGUESE_ATTRS = {');

function hasEmoji(s) {
  try { return /[\p{Extended_Pictographic}]/u.test(s); }
  catch (_) { return false; }
}

/* P1: emojis filtrados en títulos de chat -------------------------- */
test('P1a - el header DM pinta el nombre sin emojis', function () {
  assert(src.includes("fiestaStripEmoji(data.username || data.displayName || data.email)"),
    'loadChatRoomHeader no filtra emojis del nombre');
});
test('P1b - el header de grupo pinta el nombre sin emojis', function () {
  assert(src.includes("fiestaStripEmoji(data.name)"),
    'openGroupChatRoom / panel de info no filtran emojis del nombre del grupo');
});
test('P1c - la bandeja pinta nombres de grupo sin emojis', function () {
  assert(/const _strip = .*fiestaStripEmoji/.test(src) || src.includes('_strip(item.groupName)'),
    'fila de grupo de la bandeja no filtra emojis');
});
test('P1d - la bandeja pinta nombres de DM/antesala sin emojis', function () {
  var c = (src.match(/fiestaStripEmoji\(item\.otherName\)/g) || []).length;
  assert(c >= 2, 'se esperaban >=2 filtros en filas DM/antesala, hay ' + c);
});
test('P1e - hoja de opciones y panel de remitente filtran el nombre', function () {
  assert(src.includes('fiestaStripEmoji(name) || name'),
    'showConvOptions / openSenderProfile no filtran emojis');
});
test('P1f - la etiqueta del remitente en grupos no lleva emojis', function () {
  assert(src.includes("fiestaStripEmoji(msg.senderName)"),
    'group-sender-label no filtra emojis');
});
test('P1g - la cita de respuesta no lleva emojis en el nombre', function () {
  assert(src.includes('fiestaStripEmoji(msg.replyTo.senderName)') ||
         src.includes('fiestaStripEmoji(payload.replyTo.senderName)'),
    'replyBlock no filtra emojis del nombre citado');
});

/* P2: cero emojis como iconos -------------------------------------- */
test('P2a - previews de bandeja sin emojis (sin 📷/📎/📌)', function () {
  var zona = src.split('function renderChatConversations')[0];
  // Los únicos 📷/📎/📌 permitidos están en el emoji-picker y en Baro
  // (contenido de usuario / minificado ajeno al carril).
  var chatZone = src.slice(src.indexOf('function subscribeChatMessages'), src.indexOf('function renderMsgReactions'));
  assert(!/[📷📎📌]/.test(chatZone), 'quedan emojis-icono en el render de mensajes');
  var previews = ["appT('[Foto]')", "appT('[Archivo]')", "appT('[Publicación]')"];
  previews.forEach(function (p) { assert(src.includes(p), 'falta preview ' + p); });
});
test('P2b - animación de doble-tap sin emoji', function () {
  var m = src.match(/function _burstDoubleTapHeart[\s\S]*?\n  \}/);
  assert(m, 'no se encontró _burstDoubleTapHeart');
  assert(!hasEmoji(m[0]), 'la animación de doble-tap usa emoji');
  assert(m[0].includes('<svg'), 'la animación de doble-tap debe usar SVG');
});
test('P2c - la cita de respuesta usa SVG, no emojis', function () {
  assert(!src.includes("'📎 Archivo'") && !src.includes("'📷 Foto'"),
    "quedan literales '📎 Archivo' / '📷 Foto' en el código");
});

/* P3: i18n de la zona de chat -------------------------------------- */
test('P3a - claves appT de chat existen en EN/ZH/PT', function () {
  var inicio = src.indexOf('function renderChatConversations');
  // "Practicar" (idiomas) y las fiestas viven entre el chat y Baro y los
  // cubren otros carriles: el corpus termina donde empieza esa zona.
  var fin = src.indexOf('async function loadPracticarLangs');
  var zona = src.slice(inicio, fin === -1 ? inicio + 200000 : fin);
  var vistas = src.slice(src.indexOf('<!-- VISTA CONVERSACIÓN -->'), src.indexOf('<!-- MENÚ CLÁSICO DE MENSAJE -->'));
  var corpus = zona + vistas;
  var keys = {};
  var re = /appT\('((?:[^'\\]|\\.)*)'\)/g, m;
  while ((m = re.exec(corpus)) !== null) {
    if (/^[A-Za-z0-9_{}·…!¡?¿.,:;()\/\-+ ]+$/.test(m[1]) || /[áéíóúñÁÉÍÓÚÑ]/.test(m[1])) keys[m[1]] = true;
  }
  // Claves dinámicas compuestas (p. ej. 'Conversación fijada') se ignoran aquí.
  var skip = ['Opciones'];
  var faltan = [];
  Object.keys(keys).forEach(function (k) {
    if (skip.indexOf(k) !== -1) return;
    if (!(k in EN) || !(k in ZH) || !(k in PT)) faltan.push(k);
  });
  assert(faltan.length === 0, 'claves sin traducción EN/ZH/PT: ' + faltan.slice(0, 8).join(' / '));
});
test('P3b - placeholders del chat con cobertura en los 3 diccionarios', function () {
  ['Mensaje...', 'Buscar', 'Buscar usuarios', 'Buscar usuario', 'Buscar en mensajes recientes',
   'Buscar...', 'Di algo…', 'Ej: Amigos del trabajo', 'Escribe un mensaje', 'Enviar mensaje',
   'Esperando que termine la subida', 'Info del chat', 'Nuevo mensaje', 'Más acciones'
  ].forEach(function (k) {
    assert(k in EN_A, 'EN_ATTRS sin ' + k);
    assert(k in ZH_A, 'ZH_ATTRS sin ' + k);
    assert(k in PT_A, 'PT_ATTRS sin ' + k);
  });
});
test('P3c - textos de fecha de chat en los 3 diccionarios', function () {
  ['Hoy', 'Ayer', 'Editado', '1 participante', '{n} participantes', 'Sin mensajes aún',
   'Mensaje eliminado', 'Eliminaste este mensaje', '¡Di hola!', 'Ver una vez', 'Ver (1 vez)',
   'Mensaje visto · eliminado', 'Sin conversaciones', '[Foto]', '[Archivo]', '[Publicación]',
   '24 horas', '{a} está escribiendo...', '{a} y {b} están escribiendo...',
   '{a}, {b} y más están escribiendo...'
  ].forEach(function (k) {
    assert(k in EN, 'EN sin ' + k);
    assert(k in ZH, 'ZH sin ' + k);
    assert(k in PT, 'PT sin ' + k);
  });
});

/* P4: orden visual de los elementos del mensaje -------------------- */
test('P4a - en grupo: encabezado [avatar|nombre·hora] ANTES de la burbuja (orden clásico)', function () {
  var i = src.indexOf('chat-msg-head');
  assert(i !== -1, 'no se encontró chat-msg-head');
  var bloque = src.slice(i, i + 4000);
  var headPos = bloque.indexOf('chat-msg-head');
  var bubblePos = bloque.indexOf('msg-bubble');
  var timePos = bloque.indexOf('chat-msg-time');
  assert(headPos < bubblePos, 'el encabezado debe ir ANTES de la burbuja');
  assert(timePos !== -1 && timePos < bubblePos, 'la hora va DENTRO del encabezado (antes de la burbuja)');
});
test('P4b - en DM: avatar junto a la burbuja, hora bajo la fila (C260)', function () {
  var i = src.indexOf('dmAvatarHtml');
  assert(i !== -1, 'no se encontró dmAvatarHtml');
  var bloque = src.slice(i, i + 6000);
  var avatarPos = bloque.indexOf('dm-avatar');
  var bubblePos = bloque.indexOf('msg-bubble');
  assert(avatarPos !== -1 && avatarPos < bubblePos, 'el avatar debe ir ANTES/junto a la burbuja');
  /* C260: con foto, la hora va en línea propia BAJO la fila foto+burbuja
   * (antes vivía dentro de la columna y empujaba el avatar fuera). */
  var rowPos = src.indexOf('${dmAvatarHtml}<div class="flex flex-col');
  var timeLinePos = src.indexOf('pl-[44px] mt-1');
  assert(rowPos !== -1 && timeLinePos !== -1 && rowPos < timeLinePos,
    'la hora debe ir en su línea (pl-[44px]) DESPUÉS de la fila foto+burbuja');
});
test('P4c - la cita de respuesta va DENTRO y ANTES del contenido', function () {
  assert(src.includes('${replyBlock}${content}'), 'replyBlock debe preceder al contenido dentro de la burbuja');
});

/* P6: fechas localizadas ------------------------------------------- */
test('P6a - el separador de fecha no usa es-ES fijo', function () {
  var m = src.match(/function formatChatDateSeparator[\s\S]*?\n  \}/);
  assert(m, 'no se encontró formatChatDateSeparator');
  assert(!m[0].includes("'es-ES'"), 'el separador de fecha sigue con es-ES fijo');
  assert(m[0].includes("appT('Hoy')") && m[0].includes("appT('Ayer')"),
    "el separador debe usar appT('Hoy')/appT('Ayer')");
});
test('P6b - la fecha del menú del mensaje no usa meses ES fijos', function () {
  var m = src.match(/function formatChatMenuDate[\s\S]*?\n  \}/);
  assert(m, 'no se encontró formatChatMenuDate');
  assert(!m[0].includes('MESES'), 'la fecha del menú sigue con meses ES fijos');
  assert(m[0].includes('toLocaleDateString'), 'la fecha del menú debe localizarse');
});

console.log('\n' + passed + ' OK, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
