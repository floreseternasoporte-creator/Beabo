/* C240 — estudio de transmisión: stickers animados, fuente web, plantillas de
 * escena, co-anfitrión (WebRTC), controles de cámara (espejo/rotar/zoom),
 * palabras prohibidas y overlays nuevos (marcos temáticos + cuenta regresiva
 * de inicio).  node tests/test-c240.js  */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name); }
}
function eq(a, b, name) { ok(a === b, name + ' (got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + ')'); }

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const i18nSrc = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');
const EMOJI_RE = /[\u001b\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

/* ---------- extracción del modelo DSModel (script "C233: DrexStudioWeb — modelo") ---------- */
let DSM = null;
try {
  const m = /<script>\s*\/\* ============ C233: DrexStudioWeb — modelo[\s\S]*?<\/script>/.exec(html);
  ok(!!m, 'M0 bloque del modelo presente');
  const body = m[0].replace(/^<script>/, '').replace(/<\/script>$/, '');
  const mod = { exports: {} };
  const ctx = { module: mod, console: console };
  vm.runInNewContext(body, ctx, { filename: 'ds-model.js' });
  DSM = mod.exports;
  ok(DSM && typeof DSM === 'object', 'M0 DSModel exportado');
} catch (e) { ok(false, 'M0 sandbox eval: ' + e.message); }

/* ---------- T1: tipos de capa nuevos ---------- */
if (DSM) {
  ['sticker', 'web', 'guest'].forEach(t => ok(DSM.LAYER_TYPES.indexOf(t) >= 0, 'T1 LAYER_TYPES incluye ' + t));
  ok(/SRC_TYPES[\s\S]{0,900}'sticker'[\s\S]{0,200}'web'[\s\S]{0,200}'guest'/.test(html), 'T1 SRC_TYPES incluye sticker/web/guest');
  ok(html.indexOf("sticker: 'Sticker'") >= 0 && html.indexOf("web: 'Fuente web'") >= 0 && html.indexOf("guest: 'Invitado'") >= 0, 'T1 SRC_LABEL nuevos');
}

/* ---------- T2: plantillas de escena ---------- */
if (DSM) {
  eq(DSM.applyTemplate(DSM.newProject(), 'inexistente'), null, 'T2 plantilla desconocida = null');
  const tplTests = [
    ['charla', 'Charla', 1],
    ['gaming', 'Gaming', 2],
    ['reaccion', 'Reacción', 2],
    ['preguntas', 'Preguntas', 3]
  ];
  tplTests.forEach(([key, name, nLayers]) => {
    const p = DSM.newProject();
    const sid = DSM.applyTemplate(p, key);
    ok(!!sid, 'T2 plantilla ' + key + ' crea escena');
    const sc = DSM.getScene(p, sid);
    eq(sc.name, name, 'T2 plantilla ' + key + ' nombre');
    eq(sc.layers.length, nLayers, 'T2 plantilla ' + key + ' capas');
    eq(p.activeSceneId, sid, 'T2 plantilla ' + key + ' queda activa');
  });
  /* rects de gaming: pantalla completa + cámara PiP */
  const p2 = DSM.newProject();
  const sid2 = DSM.applyTemplate(p2, 'gaming');
  const sc2 = DSM.getScene(p2, sid2);
  eq(sc2.layers[0].x, 0, 'T2 gaming screen x=0');
  eq(sc2.layers[0].w, 1, 'T2 gaming screen w=1');
  ok(sc2.layers[1].type === 'camera' && sc2.layers[1].y > 0.5 && sc2.layers[1].w < 0.4, 'T2 gaming cámara PiP');
  /* preguntas: chat con cfg.max */
  const p3 = DSM.newProject();
  const sid3 = DSM.applyTemplate(p3, 'preguntas');
  const sc3 = DSM.getScene(p3, sid3);
  ok(sc3.layers.some(l => l.type === 'chat' && l.cfg && l.cfg.max === 5), 'T2 preguntas chat cfg.max=5');
  /* HTML: botones de plantilla */
  ['charla', 'gaming', 'reaccion', 'preguntas'].forEach(k =>
    ok(html.indexOf('data-tpl="' + k + '"') >= 0, 'T2 botón plantilla ' + k));
}

/* ---------- T3: stickers animados ---------- */
ok(/var DSW_STICKERS = \[[\s\S]{0,900}'confeti'[\s\S]{0,80}\];/.test(html), 'T3 catálogo DSW_STICKERS (7)');
['corazon', 'estrella', 'fuego', 'corona', 'gema', 'nota', 'confeti'].forEach(id =>
  ok(html.indexOf("id: '" + id + "'") >= 0, 'T3 sticker ' + id));
ok(/var DSW_STICKER_ANIMS = \['fijo', 'rebote', 'giro', 'pulso', 'flotar'\];/.test(html), 'T3 animaciones');
['dswstkDraw', 'dswstkAnim', 'dswstkHeart', 'dswstkStar', 'dswstkFire', 'dswstkCrown', 'dswstkGem', 'dswstkNote', 'dswstkConfetti', 'dswstkPreviewSVG'].forEach(fn =>
  ok(html.indexOf('function ' + fn + '(') >= 0, 'T3 función ' + fn));
ok(/if \(ty === 'sticker'\) \{ dswstkDraw\(ctx, l, px, py, pw, ph, ts\); return; \}/.test(html), 'T3 drawLayerBase pinta sticker');
ok(/dswstk-grid/.test(html) && /data-stk=/.test(html), 'T3 galería en el menú de capa');
ok(html.indexOf('dswstk-cell') >= 0 && /dswstk-cell\.on/.test(html), 'T3 CSS galería stickers');

/* ---------- T4: controles de cámara (espejo/rotar/zoom) ---------- */
ok(/cfg\.mirror \|\| rot % 360 !== 0 \|\| zoom > 1\.001/.test(html), 'T4 drawLayer aplica transform');
ok(/ctx\.clip\(\);[\s\S]{0,200}ctx\.rotate\(rot \* Math\.PI \/ 180\)/.test(html), 'T4 clip + rotación');
ok(/if \(cfg\.mirror\) ctx\.scale\(-1, 1\);/.test(html), 'T4 espejo scaleX -1');
ok(/if \(zoom > 1\.001\) ctx\.scale\(zoom, zoom\);/.test(html), 'T4 zoom');
['dswpro-tf-mirror', 'dswpro-tf-rot', 'dswpro-fx-zoom', 'dswpro-tf-rotv'].forEach(id =>
  ok(html.indexOf("id=\"" + id + "\"") >= 0 || html.indexOf("q('" + id + "')") >= 0, 'T4 control ' + id));
ok(html.indexOf("t('Ajustes de cámara')") >= 0, 'T4 sección Ajustes de cámara');

/* ---------- T5: fuente web ---------- */
ok(html.indexOf('id="dsw-weblayers"') >= 0, 'T5 contenedor #dsw-weblayers');
ok(/function syncWebLayers\(\)/.test(html), 'T5 syncWebLayers existe');
ok(/fr\.sandbox = 'allow-scripts allow-same-origin allow-popups allow-forms';/.test(html), 'T5 iframe sandbox');
ok(/G\._webSyncT \|\| ts - G\._webSyncT > 250/.test(html), 'T5 sync con throttle en tick()');
ok(/if \(ty === 'web'\)/.test(html), 'T5 drawLayerBase caso web');
ok(html.indexOf("t('La fuente web se ve en la vista previa del estudio.") >= 0, 'T5 aviso de limitación');
ok(/\.dsw-weblayers iframe\{position:absolute/.test(html), 'T5 CSS iframes');

/* ---------- T6: co-anfitrión ---------- */
ok(/DrexLiveCore\.prototype\.joinAsGuest = function \(liveId, stream\)/.test(html), 'T6 core.joinAsGuest');
ok(/pc\.ontrack = function \(e\) \{[\s\S]{0,400}self\._emit\('remotetrack', \{ stream: stream, uid: uid \}\)/.test(html), 'T6 host ontrack emite remotetrack con uid');
ok(/msg\.type === 'guest-join'[\s\S]{0,300}this\._emit\('guestjoined', \{ uid: from, name:/.test(html), 'T6 señal guest-join -> guestjoined');
ok(/function dswGuestWire\(core\)/.test(html) && /function dswGuestLayer\(\)/.test(html), 'T6 estudio dswGuestWire/dswGuestLayer');
ok(/dswGuestWire\(core\);/.test(html), 'T6 goLive cablea el invitado');
ok(/if \(ty === 'guest'\)/.test(html), 'T6 drawLayerBase caso guest');
ok(/window\.drexLiveJoinAsGuest = async function/.test(html), 'T6 visor drexLiveJoinAsGuest');
ok(/window\.drexLiveStopGuest = function/.test(html), 'T6 visor drexLiveStopGuest');
ok(html.indexOf('id="drex-live-guestbadge"') >= 0, 'T6 badge co-anfitrión');
ok(/onclick="drexLiveJoinAsGuest\(\)"/.test(html), 'T6 botón co-anfitrión en el visor');
ok(/LS\.guestStream\) LS\.guestStream\.getTracks\(\)\.forEach\(function \(tr\) \{ tr\.stop\(\); \}\)/.test(html), 'T6 corta cámara al salir');
/* runtime del core: joinAsGuest rechaza stream inválido */
let CORE = null;
try {
  const m = /\/\* drexlive-core\.js — Núcleo DrexLive \(C232\)\.[\s\S]*?<\/script>/.exec(html);
  ok(!!m, 'T6 bloque del core presente');
  const body = m[0].replace(/<\/script>$/, '');
  const wctx = { window: {}, Promise: Promise, Error: Error };
  vm.runInNewContext(body, wctx, { filename: 'drexlive-core.js' });
  CORE = wctx.window.DrexLiveCore;
  ok(typeof CORE === 'function', 'T6 DrexLiveCore evaluable');
  if (CORE) {
    const inst = CORE({ db: { ref: function () { return {}; } }, RTC: {} });
    ok(inst.joinAsGuest('x'.repeat(70), null) instanceof Promise, 'T6 joinAsGuest rechaza y devuelve Promise');
  }
} catch (e) { ok(false, 'T6 sandbox eval core: ' + e.message); }

/* ---------- T7: palabras prohibidas ---------- */
let AM = null;
try {
  const m = /\/\*__DSWAUD_MODEL_BEGIN__\*\/([\s\S]*?)\/\*__DSWAUD_MODEL_END__\*\//.exec(html);
  ok(!!m, 'T7 bloque DswAudModel extraíble');
  const wctx = { window: {}, Date: Date, Math: Math };
  vm.runInNewContext(m[1] + '\n;window.DswAudModel = DswAudModel;', wctx, { filename: 'dswaud.js' });
  AM = wctx.window.DswAudModel;
  ok(!!AM, 'T7 DswAudModel evaluable');
} catch (e) { ok(false, 'T7 sandbox eval: ' + e.message); }
if (AM) {
  const st = AM.newState();
  eq(st.badwords.length, 0, 'T7 newState con badwords vacío');
  eq(AM.setBadWords(st, [' Tonto ', 'tonto', 'idiota!', '']),
     2, 'T7 setBadWords normaliza (trim, dedupe, descarta vacíos)');
  ok(AM.isBadText(st, 'Eres un TONTO'), 'T7 isBadText insensible a mayúsculas');
  ok(AM.isBadText(st, 'qué idiotas son'), 'T7 isBadText sin acentos (idiota~idiotas)');
  ok(!AM.isBadText(st, 'hola'), 'T7 texto limpio pasa');
  const now = Date.now();
  ok(AM.moderateText(st, 'u1', 'mensaje con tonto dentro', now), 'T7 moderateText detecta');
  ok(AM.isMuted(st, 'u1', now + 1000), 'T7 moderateText silencia al usuario');
  ok(!AM.moderateText(st, 'u2', 'mensaje normal', now), 'T7 moderateText deja pasar lo limpio');
  ok(AM.setBadWords(st, Array(250).fill('x').map((_, i) => 'palabra' + i)) <= 200, 'T7 tope de 200 palabras');
}
ok(html.indexOf('id="dswaud-badwords"') >= 0 && html.indexOf('dswaud-badwords-save') >= 0, 'T7 UI palabras prohibidas');
ok(/M\.moderateText\(ST, msg\.uid, msg\.text, now\)/.test(html), 'T7 onChat filtra con moderateText');
ok(/localStorage\.setItem\('dswaud_badwords_v1'/.test(html), 'T7 persistencia local');

/* ---------- T8: overlays nuevos (marcos + cuenta de inicio) ---------- */
ok(/function dswovFrame\(ctx, W, H, ts\)/.test(html), 'T8 dswovFrame');
ok(/function dswovStart\(ctx, W, H, ts\)/.test(html), 'T8 dswovStart');
['neon', 'fiesta', 'elegante', 'gamer'].forEach(mo =>
  ok(html.indexOf("mode === '" + mo + "'") >= 0, 'T8 marco ' + mo));
ok(html.indexOf('id="dswov-frame"') >= 0, 'T8 selector de marco');
['ninguno', 'neon', 'fiesta', 'elegante', 'gamer'].forEach(v =>
  ok(html.indexOf('value="' + v + '"') >= 0, 'T8 opción marco ' + v));
ok(html.indexOf('id="dsw-startcount"') >= 0, 'T8 botón Iniciar en 5 s');
ok(/st\.els\.golive && !st\.live\) st\.els\.golive\.click\(\)/.test(html), 'T8 al terminar dispara golive');
ok(/window\.__dswDrawHooks\.push\(dswovPoll[\s\S]*dswovFrame, dswovStart\);/.test(html), 'T8 hooks 9 registrados');
ok(/S\.start\.t0 = Date\.now\(\);\s*S\.start\.active = true;/.test(html), 'T8 botón arranca la cuenta');

/* ---------- T9: i18n ES/EN/ZH/PT ---------- */
const I18N_KEYS = ['Plantillas', 'Solo charla', 'Gaming', 'Reacción', 'Preguntas y respuestas',
  'Iniciar en 5 s', 'Marco', 'Neón', 'Elegante', 'Palabras prohibidas', 'Guardar palabras',
  'Co-anfitrión', 'Eres co-anfitrión', 'Espejo', 'Rotar', 'Zoom', 'Sticker', 'Animación',
  'Fuente web', 'Invitado', 'Esperando invitado…', 'Empieza el directo', 'Ajustes de cámara'];
const TEXT_DICTS = ['var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {']
  .map((mk, i) => {
    const a = i18nSrc.indexOf(mk);
    const b = i18nSrc.indexOf('var APP_', a + 10);
    return i18nSrc.slice(a, b < 0 ? i18nSrc.length : b);
  });
I18N_KEYS.forEach(k => {
  eq(TEXT_DICTS.filter(d => d.split('"' + k + '":').length - 1 === 1).length, 3, 'T9 clave "' + k + '" 1x en cada dict TEXT');
});
const SPOT = {
  'Co-anfitrión': ['Co-host', '联合主播', 'Co-apresentador'],
  'Palabras prohibidas': ['Banned words', '违禁词', 'Palavras proibidas'],
  'Espejo': ['Mirror', '镜像', 'Espelho']
};
Object.keys(SPOT).forEach(k => {
  SPOT[k].forEach((v, i) => ok(i18nSrc.indexOf('"' + k + '":"' + v + '"') >= 0, 'T9 "' + k + '" traducción ' + ['EN', 'ZH', 'PT'][i]));
});
ok(i18nSrc.split('"Separa con comas…":').length - 1 >= 3, 'T9 placeholder en ATTRS (3 dicts)');

/* ---------- T10: higiene (sin emojis) + sintaxis ---------- */
function betweenStr(a, b) {
  const i = html.indexOf(a), j = html.indexOf(b, i + 1);
  return (i >= 0 && j > i) ? html.slice(i, j) : null;
}
const C240_RANGES = [
  betweenStr('/* ---------------- C240: stickers animados', 'function drawLayerBase'),
  betweenStr('/* ---------------- C240: fuente web', 'function qualityH'),
  betweenStr('/* ---------------- C240: co-anfitrión', 'function goLive'),
  betweenStr('/* 7. C240: marcos', '/* ---------------- panel de control')
];
C240_RANGES.forEach((r, i) => {
  ok(r && !EMOJI_RE.test(r), 'T10 rango ' + i + ' sin emojis');
});
try { new vm.Script(i18nSrc, { filename: 'drex-i18n.js' }); ok(true, 'T10 drex-i18n.js compila'); }
catch (e) { ok(false, 'T10 drex-i18n.js: ' + e.message); }
(function () {
  const blocks = html.match(/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/g) || [];
  let bad = 0;
  blocks.forEach(b => {
    try { new vm.Script(b.replace(/<\/?script[^>]*>/g, '')); } catch (e) { bad++; }
  });
  eq(bad, 0, 'T10 todos los <script> inline compilan (' + blocks.length + ' bloques)');
})();
ok(fs.readFileSync(path.join(ROOT, '404.html'), 'utf8') === html, 'T10 404.html idéntico a index.html');

console.log('\nC240: ' + pass + ' verdes, ' + fail + ' rojos');
process.exit(fail ? 1 : 0);
