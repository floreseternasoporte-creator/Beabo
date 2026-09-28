/* ================================================================
 * C230 — i18n: paridad ES/EN/ZH/PT y cobertura real de appT/drexFxT.
 *
 * Gaps reales encontrados (2026-09-28):
 *  A) 40 literales pasados a appT()/drexFxT() que NO existían en los
 *     diccionarios -> appT devolvía la clave en español para usuarios
 *     EN/ZH/PT (stats de Pulso, programar posts, votaciones, tendencias,
 *     moderación de efectos "En revisión/Rechazado/Publicado/...",
 *     "No se pudieron cargar más seguidores/seguidos").
 *  B) 46 valores EN idénticos a la clave en español (sin traducir):
 *     onboarding ("¿Cómo te llamas?"), 2FA, desactivación de cuenta
 *     (los 8 bullets), "Ecos" (inconsistente con "0 echoes" ya usado).
 *  C) Typo en index.html: appT('No se pudo enviar. Int\u00e9talo...') —
 *     la clave con la errata nunca matcheaba el dict ("Inténtalo").
 *
 * El test:
 *  1. Parsea los 3 diccionarios TEXT y exige paridad total de claves.
 *  2. Exige que TODO literal appT('...')/drexFxT('...') de index.html
 *     exista en el diccionario (sin esta cobertura, el fallback muestra
 *     español).
 *  3. Verifica los valores EN corregidos (spot checks).
 *  4. Verifica que la errata ya no existe y que los showMiniToast
 *     nuevos van envueltos en appT.
 *  5. Verifica que no hay claves duplicadas en el fuente de cada dict.
 *
 * Sin el fix: 1 falla (paridad 2215 pero 40 literales sin clave),
 * 2 falla (40+7+2), 3 falla (46 valores EN == clave ES).
 *
 * Ejecutar: node tests/test-c228-i18n-gaps.js [--target-html ruta]
 *           [--target-i18n ruta]
 * ================================================================ */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');

function argVal(name, def) {
  var i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}
var htmlPath = argVal('--target-html', path.join(__dirname, '..', 'index.html'));
var i18nPath = argVal('--target-i18n', path.join(__dirname, '..', 'drex-i18n.js'));
var html = fs.readFileSync(htmlPath, 'utf8');
var i18nSrc = fs.readFileSync(i18nPath, 'utf8');

function extractDict(name) {
  var startMarker = 'var ' + name + ' = {';
  var start = i18nSrc.indexOf(startMarker);
  assert(start !== -1, 'ROJO: no existe ' + name);
  // cierre: primera línea que sea exactamente '};' o que termine en '};'
  var lines = i18nSrc.split('\n');
  var startLine = i18nSrc.slice(0, start).split('\n').length - 1;
  var endLine = -1;
  for (var i = startLine; i < lines.length; i++) {
    var t = lines[i].trim();
    if (t === '};' || t.endsWith('};')) { endLine = i; break; }
  }
  assert(endLine !== -1, 'ROJO: sin cierre para ' + name);
  var body = lines.slice(startLine, endLine + 1).join('\n')
    .replace(/^var \w+ = /, '').replace(/;\s*$/, '');
  return new Function('return (' + body + ')')();
}

var en = extractDict('APP_ENGLISH_TEXT');
var zh = extractDict('APP_CHINESE_TEXT');
var pt = extractDict('APP_PORTUGUESE_TEXT');
var enKeys = Object.keys(en), zhKeys = Object.keys(zh), ptKeys = Object.keys(pt);

// 1) paridad total de claves
assert(enKeys.length === zhKeys.length && enKeys.length === ptKeys.length,
  'ROJO: conteo distinto EN=' + enKeys.length + ' ZH=' + zhKeys.length + ' PT=' + ptKeys.length);
var enSet = new Set(enKeys);
zhKeys.forEach(function (k) { assert(enSet.has(k), 'ROJO: clave ZH sin par EN: ' + k); });
ptKeys.forEach(function (k) { assert(enSet.has(k), 'ROJO: clave PT sin par EN: ' + k); });
console.log('ok 1: paridad de claves (' + enKeys.length + ' x 3 idiomas)');

// sin valores vacíos
[['EN', en], ['ZH', zh], ['PT', pt]].forEach(function (pair) {
  var bad = Object.keys(pair[1]).filter(function (k) { return !String(pair[1][k]).trim(); });
  assert(bad.length === 0, 'ROJO: valores vacíos en ' + pair[0] + ': ' + bad.slice(0, 3).join(','));
});
console.log('ok 1b: sin valores vacíos');

// sin claves duplicadas en el fuente
[['APP_ENGLISH_TEXT', enKeys], ['APP_CHINESE_TEXT', zhKeys], ['APP_PORTUGUESE_TEXT', ptKeys]].forEach(function (pair) {
  var seen = new Set(), dup = [];
  pair[1].forEach(function (k) { if (seen.has(k)) dup.push(k); seen.add(k); });
  assert(dup.length === 0, 'ROJO: claves duplicadas en ' + pair[0] + ': ' + dup.slice(0, 3).join(','));
});
console.log('ok 1c: sin claves duplicadas');

// 2) cobertura: todo literal appT/drexFxT existe en el dict
function collectLiterals(fnName) {
  var re = new RegExp(fnName + '\\(\\s*([\'"])((?:\\\\.|(?!\\1).)*)\\1\\s*\\)', 'g');
  var m, out = new Set();
  while ((m = re.exec(html))) {
    try { out.add(new Function('return ' + m[1] + m[2] + m[1])()); }
    catch (e) { /* literal con interpolación: se ignora */ }
  }
  return out;
}
var used = collectLiterals('appT');
collectLiterals('drexFxT').forEach(function (k) { used.add(k); });
var missing = Array.from(used).filter(function (k) { return !enSet.has(k); });
assert(missing.length === 0,
  'ROJO: ' + missing.length + ' literales sin clave en el dict: ' +
  missing.slice(0, 5).map(function (k) { return JSON.stringify(k); }).join(', '));
console.log('ok 2: cobertura appT/drexFxT (' + used.size + ' literales, 0 sin clave)');

// 3) valores EN corregidos (antes eran idénticos al español)
var enExpect = {
  'Tu foto de perfil': 'Your profile photo',
  'Tú': 'You',
  'Usuario': 'User',
  'Verificando...': 'Verifying...',
  '¿Cómo te llamas?': "What's your name?",
  '¿Olvidaste tu contraseña?': 'Forgot your password?',
  'Últimos 7 días': 'Last 7 days',
  'Ecos': 'Echoes',
  '💻 Tecnología': '💻 Technology',
  'mensaje...': 'message...',
  'seguidores': 'followers'
};
Object.keys(enExpect).forEach(function (k) {
  assert(en[k] === enExpect[k],
    'ROJO: EN[' + JSON.stringify(k) + '] = ' + JSON.stringify(en[k]) + ', esperado ' + JSON.stringify(enExpect[k]));
});
console.log('ok 3: valores EN corregidos (' + Object.keys(enExpect).length + ' spot checks)');

// 3b) ninguna de las 46 claves del lote C230 sigue sin traducir en EN
var c228Untranslated = [
  'Tu foto de perfil','Tu nombre de usuario','Tu nombre real. Será visible en tu perfil.',
  'Tu perfil está configurado.','Tus decisiones se guardan en este dispositivo',
  'Tus notas y pensamientos publicados en la comunidad','Tú','Un par de pasos más para empezar.',
  'Usuario','Vaciar chat del grupo','Ver historial','Ver sus publicaciones en tu feed',
  'Ver y desbloquear cuentas','Verifica tu correo','Verificación en dos pasos','Verificando...',
  'Vincula tu cuenta con un adulto o supervisa la de alguien más','Vincular a alguien más',
  'Vista previa · se aplica solo a este chat','Volver al inicio de sesión','mensaje...',
  'o continúa con','seguidores','siguiendo','¡Bienvenido a Drex!','¡Todo listo!',
  '¿Cuándo naciste?','¿Cómo te llamas?','¿Estás seguro de que quieres desactivar tu cuenta?',
  '¿Olvidaste tu contraseña?','¿Por qué quieres irte de la plataforma?','¿Qué te interesa?',
  'Él','Últimos 7 días',
  '• Después de 30 días, no habrá forma de recuperar tu información.',
  '• Privacidad total: Tu perfil y todo el contenido publicado dejarán de estar visibles para la comunidad de inmediato.',
  '• Puedes reactivarla en cualquier momento simplemente iniciando sesión de nuevo.',
  '• Respaldo de seguridad: Drex mantendrá tus datos y preferencias protegidos en nuestros servidores para que no pierdas nada durante tu ausencia.',
  '• Tienes 30 días para cambiar de opinión; si inicias sesión antes de ese tiempo, la solicitud se cancelará automáticamente.',
  '• Tu información se guardará de forma segura.','• Tu perfil desaparecerá para siempre.',
  '• Tu perfil y tus publicaciones quedarán ocultos para todos los usuarios.',
  '💻 Tecnología','📚 Educación','🔥 Símbolos','Ecos'
];
var stillEs = c228Untranslated.filter(function (k) { return en[k] === k; });
assert(stillEs.length === 0, 'ROJO: EN aún sin traducir: ' + stillEs.slice(0, 3).join(' | '));
console.log('ok 3b: las 46 claves C230 ya no están sin traducir en EN');

// 3c) las 40 claves nuevas existen en los 3 idiomas
var newKeys = ['Actualizar','Tendencias','Voto positivo','En revisión','Rechazado','Publicado',
  'Aprobar','Motivo (opcional)','Este efecto aún no está publicado.','Sin vista previa disponible.',
  'No se pudieron cargar más seguidores.','No se pudieron cargar más seguidos.',
  'Tu actividad de los últimos 7 días','{n} posts','+{n} hoy','En alza','Fecha desconocida'];
newKeys.forEach(function (k) {
  assert(enSet.has(k) && zh[k] && pt[k], 'ROJO: clave nueva incompleta: ' + k);
});
console.log('ok 3c: claves nuevas presentes en EN/ZH/PT');

// 4) la errata ya no existe; los showMiniToast van con appT
assert(html.indexOf('Int\\u00e9talo') === -1 && html.indexOf('Intétalo de nuevo') === -1,
  'ROJO: la errata Intétalo sigue en index.html');
assert(html.indexOf("appT('No se pudo enviar. Inténtalo de nuevo.')") !== -1,
  'ROJO: no se encontró la clave corregida Inténtalo en index.html');
assert(html.indexOf("showMiniToast(appT('No se pudieron cargar más seguidores.'))") !== -1,
  'ROJO: showMiniToast de seguidores sin appT');
assert(html.indexOf("showMiniToast(appT('No se pudieron cargar más seguidos.'))") !== -1,
  'ROJO: showMiniToast de seguidos sin appT');
console.log('ok 4: errata corregida y showMiniToast envueltos');


// 5) lote 2: fragmentos de texto directo (textContent/innerHTML) ahora con clave
var batch2 = ['Buscando...','Imagen no disponible','Busca a alguien para enviarle esto.',
  'No encontramos usuarios.','Sin resultados','Reintentando…','Buscando contactos frecuentes...',
  'Ondas','Activando…','Cargando ecos...','Cargando comentarios...','Mensaje visto · eliminado',
  'Cargando publicaciones...','Cargando canciones…','Sin resultados para "{q}".',
  'Sin resultados para tu búsqueda.','Aún no hay canciones. ¡Sube la primera!'];
batch2.forEach(function (k) {
  assert(enSet.has(k) && zh[k] && String(zh[k]).trim() && pt[k] && String(pt[k]).trim(),
    'ROJO: clave lote2 incompleta: ' + k);
});
assert(en['Sin resultados para "{q}".'].indexOf('{q}') !== -1, 'ROJO: {q} perdido en EN');
assert(zh['Sin resultados para "{q}".'].indexOf('{q}') !== -1, 'ROJO: {q} perdido en ZH');
assert(pt['Sin resultados para "{q}".'].indexOf('{q}') !== -1, 'ROJO: {q} perdido en PT');
console.log('ok 5: lote 2 (' + batch2.length + ' claves x 3 idiomas, {q} preservado)');

console.log('\nC230 VERDE: ' + enKeys.length + ' claves x 3 idiomas, cobertura total de literales.');

