/* ================================================================
 * Test carril 1: purga total de "en vivo" (video) en Drex Orbit.
 *
 * Historia: la transmisión en vivo en video, los efectos y Drex Studio
 * se eliminaron de la app; las fiestas de voz SÍ existen y se quedan.
 * El beneficio Orbit "live boost" / "En vivos potenciados" se reemplazó
 * por "Impulso en fiestas" (clave fiesta_boost, icono SVG mic).
 *
 * Este test falla si:
 *   - ORBIT_FEATURES contiene claves de live ('live_pro','live_boost',...)
 *   - la zona Orbit (orbitBenefits / paywall) menciona "en vivo(s)",
 *     "live boost", "transmitir" o "transmisión"
 *   - quedan restos del bloque de video-live en index.html
 *     (DrexLiveUI, "Iniciar transmisión", buildDrexLiveCardHTML,
 *     comentarios del bloque C4 "EN VIVO DESDE VIDEO")
 *   - las claves i18n viejas ("En vivos potenciados") siguen en
 *     drex-i18n.js o faltan las nuevas ("Impulso en fiestas")
 *   - el KB de Baro sigue hablando de "transmisiones activas" o de
 *     "transmitir" (ir en vivo en video)
 *   - la landing (empresa-view) sigue ofreciendo "haz en vivos"
 *
 * Lo que NO debe romper: fiestas de voz, Destellos, "en vivo" como
 * adjetivo de las fiestas ("fiesta en vivo de voz", "salas de voz
 * en vivo"), la ruta #/en-vivo (sección de fiestas) ni el anillo
 * EN VIVO de presencia.
 *
 * Ejecutar con: node tests/test-orbit-no-live.js   (código 0 = todo OK)
 * ================================================================ */
'use strict';
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var ROOT = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var i18n = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

function fnBlock(s, sig, label) {
  var i = s.indexOf(sig);
  assert(i !== -1, label + ': firma no encontrada');
  var j = s.indexOf('\n}\n', i);
  assert(j !== -1, label + ': cierre de función no encontrado');
  return s.slice(i, j + 3);
}

/* ---------- 1. ORBIT_FEATURES sin claves de live ---------- */
test('ORBIT_FEATURES no contiene claves de live', function () {
  var m = src.match(/var ORBIT_FEATURES = \[([^\]]*)\];/);
  assert(m, 'ORBIT_FEATURES no encontrado');
  var feats = m[1];
  assert(feats.indexOf('live_pro') === -1, 'ORBIT_FEATURES aún tiene live_pro');
  assert(feats.indexOf('live_boost') === -1, 'ORBIT_FEATURES aún tiene live_boost');
  assert(!/['"]live/.test(feats), 'ORBIT_FEATURES tiene una clave que empieza con live');
  assert(feats.indexOf("'fiesta_boost'") !== -1, 'ORBIT_FEATURES debe incluir fiesta_boost');
});

/* ---------- 2. orbitBenefits(): Impulso en fiestas, sin "en vivo" ---------- */
test('orbitBenefits() usa fiesta_boost sin mencionar en vivo', function () {
  var r = fnBlock(src, 'function orbitBenefits() {', 'orbitBenefits');
  assert(r.indexOf("f: 'fiesta_boost'") !== -1, 'falta el beneficio fiesta_boost');
  assert(r.indexOf('live_pro') === -1, 'orbitBenefits aún menciona live_pro');
  assert(r.indexOf('live_boost') === -1, 'orbitBenefits aún menciona live_boost');
  assert(!/en vivos?/i.test(r), 'orbitBenefits aún dice "en vivo(s)"');
  assert(!/live boost/i.test(r), 'orbitBenefits aún dice "live boost"');
  assert(r.indexOf("ic: 'mic'") !== -1, 'el beneficio debe usar el icono SVG mic del catálogo');
  assert(r.indexOf("t('Impulso en fiestas')") !== -1, 'falta el título "Impulso en fiestas"');
});

/* ---------- 3. paywall sin live ---------- */
test('orbitPaywallCopy() sin live', function () {
  var r = fnBlock(src, 'function orbitPaywallCopy(feature) {', 'orbitPaywallCopy');
  assert(r.indexOf('fiesta_boost:') !== -1, 'el paywall debe mapear fiesta_boost');
  assert(r.indexOf('live_pro') === -1, 'el paywall aún mapea live_pro');
  assert(!/en vivos?/i.test(r), 'el paywall aún dice "en vivo(s)"');
});

/* ---------- 4. sin restos del bloque de video-live ---------- */
test('sin handle DrexLiveUI (bloque En vivo eliminado)', function () {
  assert(src.indexOf('DrexLiveUI') === -1, 'queda referencia a window.DrexLiveUI');
});
test('sin textos de transmisión de video', function () {
  assert(src.indexOf('Iniciar transmisión') === -1, 'queda "Iniciar transmisión"');
  assert(src.indexOf('buildDrexLiveCardHTML') === -1, 'queda buildDrexLiveCardHTML');
  assert(src.indexOf('EN VIVO DESDE VIDEO') === -1, 'queda el comentario del bloque C4');
  assert(src.indexOf('retransmitir un video como live') === -1, 'queda descripción del bloque C4');
});
test('sin hojas de configuración del en vivo (placeholders C232)', function () {
  assert(src.indexOf('hoja de configuración del en vivo') === -1,
    'queda el placeholder de la hoja de configuración del en vivo');
  assert(src.indexOf('sala del anfitrión') === -1, 'queda el placeholder de sala del anfitrión');
  assert(src.indexOf('sala del espectador') === -1, 'queda el placeholder de sala del espectador');
});

/* ---------- 5. i18n: claves viejas fuera, nuevas dentro ---------- */
test('drex-i18n.js sin "En vivos potenciados" y con "Impulso en fiestas"', function () {
  assert(i18n.indexOf('En vivos potenciados') === -1,
    'drex-i18n.js aún tiene la clave "En vivos potenciados"');
  assert(i18n.indexOf('Más duración, calidad HD y más en vivos programados.') === -1,
    'drex-i18n.js aún tiene la descripción vieja del beneficio');
  assert(i18n.indexOf('"Impulso en fiestas":"Fiesta boost"') !== -1, 'falta EN de Impulso en fiestas');
  assert(i18n.indexOf('"Impulso en fiestas":"派对助推"') !== -1, 'falta ZH de Impulso en fiestas');
  assert(i18n.indexOf('"Impulso en fiestas":"Impulso em festas"') !== -1, 'falta PT de Impulso en fiestas');
});
test('drex-i18n.js sin huérfanos de live-push/Studio', function () {
  ['Añadir escena', 'Co-anfitrión', 'Espectadores', 'Salud del stream',
   'Supresión de ruido', 'Comparte el código del directo para invitar',
   'Teclas 1-9 cambian de escena', 'Palabras prohibidas', 'Solo charla',
   '{n} empieza en vivo en unos minutos', 'Recordatorio enviado a tus seguidores',
   'Top regaladores', 'Aún no hay regalos en este live',
   'Cuando alguien que sigues transmite en vivo'
  ].forEach(function (k) {
    assert(i18n.indexOf('"' + k + '"') === -1, 'drex-i18n.js aún tiene "' + k + '"');
  });
});

/* ---------- 6. Baro KB y landing sin video-live ---------- */
test('KB de Baro sin transmisiones de video', function () {
  assert(src.indexOf('las transmisiones activas') === -1,
    'baro.kb.en_vivo.s1 aún habla de transmisiones activas');
  assert(src.indexOf('Para transmitir necesitas haber iniciado sesión') === -1,
    'baro.kb.en_vivo.s2 aún habla de transmitir');
  assert(src.indexOf('las fiestas de voz activas') !== -1,
    'baro.kb.en_vivo.s1 debe describir las fiestas de voz activas');
});
test('landing (empresa-view) sin "haz en vivos"', function () {
  assert(src.indexOf('haz en vivos') === -1, 'la landing aún dice "haz en vivos"');
  assert(src.indexOf('música, en vivos y práctica') === -1, 'la landing aún lista "en vivos"');
  assert(src.indexOf('fiestas de voz y práctica de idiomas') !== -1,
    'la landing debe mencionar las fiestas de voz');
  assert(i18n.indexOf('haz en vivos y practica idiomas') === -1,
    'drex-i18n.js aún tiene la traducción vieja del hero');
  assert(i18n.indexOf('música, en vivos y práctica de idiomas') === -1,
    'drex-i18n.js aún tiene la traducción vieja de la tarjeta');
  assert(i18n.indexOf('únete a fiestas de voz y practica idiomas') !== -1,
    'drex-i18n.js debe tener el hero nuevo');
});

/* ---------- 7. lo que debe sobrevivir ---------- */
test('fiestas de voz intactas', function () {
  assert(/function createFiesta\b/.test(src), 'falta createFiesta');
  assert(src.indexOf('fiesta-room-view') !== -1, 'falta fiesta-room-view');
  assert(src.indexOf('envivo-pane-voz') !== -1, 'falta envivo-pane-voz');
  assert(src.indexOf('Salas de voz en vivo') !== -1, 'falta el texto "Salas de voz en vivo"');
});
test('Destellos intactos', function () {
  assert(i18n.indexOf('"Destellos":"Glimmers"') !== -1, 'falta la clave i18n de Destellos');
});
test('cámara propia intacta', function () {
  assert(/function drexCameraOpen\b/.test(src), 'falta drexCameraOpen');
});

console.log('\n' + passed + ' OK, ' + failed + ' fallos');
process.exit(failed ? 1 : 0);
