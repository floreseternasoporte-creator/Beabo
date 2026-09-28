/* C239-L2 — tests de Overlays y widgets compuestos en el canvas del programa.
 * node tests/test-c239-l2.js  (se corre desde ~/workspace/c239/lanes/l2)
 * Cubre: hook en tick, evento dsw:studio-ready, panel Overlays, los 6 widgets,
 * cola de alertas, beep WebAudio (no TTS), metas de regalos con precios reales,
 * hitos de likes, i18n ES/EN/ZH/PT, cero emojis/SpaceX, sintaxis de <script>. */
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

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

// ---------- T1: hook de dibujo compartido en tick() ----------
const HOOK_LINE = 'if (window.__dswDrawHooks) { for (var __hi = 0; __hi < window.__dswDrawHooks.length; __hi++) { try { window.__dswDrawHooks[__hi](ctx, W, H, ts); } catch (__he) {} } }';
eq(html.split(HOOK_LINE).length - 1, 1, 'T1 hook __dswDrawHooks exacto 1 vez');
ok(/drawAlerts\(ctx, W, H, ts\);\n(?:.*\n){0,4}  if \(window\.__dswDrawHooks\)/.test(html),
  'T1 hook va justo después de drawAlerts en tick() (C240: admite sync de iframes web entre medias)');
ok(/  if \(window\.__dswDrawHooks\)[^\n]*\n  updateSelBox\(\);/.test(html),
  'T1 hook va antes de updateSelBox()');

// ---------- T2: evento dsw:studio-ready al final de init() ----------
const SR_LINE = "try { window.dispatchEvent(new CustomEvent('dsw:studio-ready')); } catch (__e) {}";
eq(html.split(SR_LINE).length - 1, 1, 'T2 dispatch dsw:studio-ready exacto 1 vez');
ok(/G\.inited = true;\n(?:.*\n)?  try \{ window\.dispatchEvent\(new CustomEvent\('dsw:studio-ready'\)\)/.test(html),
  'T2 dispatch va después de G.inited = true');

// ---------- T3: panel Overlays en .dsw-right ----------
const PANEL_IDS = ['dswov-t-alerts', 'dswov-t-goal', 'dswov-t-chat', 'dswov-t-ticker',
  'dswov-t-timer', 'dswov-t-sound', 'dswov-goal', 'dswov-lt-name', 'dswov-lt-title',
  'dswov-lt-show', 'dswov-lt-hide', 'dswov-timer-min', 'dswov-timer-start', 'dswov-timer-stop'];
PANEL_IDS.forEach(id => ok(html.indexOf('id="' + id + '"') >= 0, 'T3 panel tiene #' + id));
ok(/data-dsx-t="Overlays">Overlays<\/h3>/.test(html), 'T3 sección titulada Overlays');
ok(/<div id="dsw-alerts"[\s\S]{0,200}?<\/section>\s*<style>[\s\S]*?\.dswov-panel[\s\S]*?<section class="dsw-sec">\s*<h3 data-dsx-t="Overlays">/.test(html),
  'T3 sección Overlays va después de cerrar la sección Alertas de regalos');

// ---------- T4: bloque del módulo dswov ----------
const modStart = html.indexOf('/* ============ C239-L2: Overlays y widgets');
ok(modStart >= 0, 'T4 bloque del módulo presente en index.html');
const modEnd = html.indexOf('</script>', modStart);
const modSrc = html.slice(modStart, modEnd);
ok(modSrc.indexOf('dsw:studio-ready') >= 0, 'T4 módulo escucha dsw:studio-ready');
ok(!EMOJI_RE.test(modSrc), 'T4 módulo sin emojis');
ok(modSrc.toLowerCase().indexOf('spacex') < 0, 'T4 módulo sin SpaceX');
ok(modSrc.indexOf('TextToSpeech') < 0 && modSrc.indexOf('speechSynthesis') < 0, 'T4 beep WebAudio, sin TTS');

// ---------- T5: runtime del módulo en sandbox ----------
function makeCtx() {
  return {
    save: function () {}, restore: function () {}, beginPath: function () {},
    moveTo: function () {}, arcTo: function () {}, closePath: function () {},
    fill: function () {}, stroke: function () {}, fillRect: function () {},
    fillText: function () {}, strokeText: function () {},
    measureText: function () { return { width: 42 }; },
    fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, lineWidth: 1
  };
}
let sandbox = null;
try {
  const listeners = {};
  const els = {};
  function mkEl() {
    return { checked: false, value: '', addEventListener: function (ev, fn) { this['on_' + ev] = fn; } };
  }
  let oscStarts = 0;
  function ACStub() { this.currentTime = 0; this.destination = {}; }
  ACStub.prototype.createOscillator = function () {
    return { type: '', frequency: { value: 0 }, connect: function () {},
      start: function () { oscStarts++; }, stop: function () {} };
  };
  ACStub.prototype.createGain = function () {
    return { gain: { setValueAtTime: function () {}, exponentialRampToValueAtTime: function () {} },
      connect: function () {} };
  };
  const G = { inited: true, chatBuf: [], alerts: [], els: { vLikes: { textContent: '0' } } };
  const intervals = [];
  sandbox = {
    console: console,
    performance: { now: function () { return 1000; } },
    Date: Date, Math: Math, String: String, parseInt: parseInt, JSON: JSON,
    setInterval: function (fn) { intervals.push(fn); return intervals.length; },
    clearInterval: function (id) { intervals[id - 1] = null; },
    CustomEvent: function (t) { this.type = t; },
    window: {
      addEventListener: function (ev, fn) { listeners[ev] = fn; },
      AudioContext: ACStub, appT: undefined, t: undefined,
      dispatchEvent: function () {}
    },
    document: { getElementById: function (id) { return els[id] || (els[id] = mkEl()); } },
    DREX_GIFT_ASSET_BASE: 'assets/live-gifts/',
    __oscStarts: function () { return oscStarts; },
    __G: G, __intervals: intervals, __listeners: listeners, __els: els
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  sandbox.window.DrexStudioWeb = { _state: function () { return sandbox.__G; }, paint: function () {} };
  // manifest real de regalos + drexLiveGiftById extraídos del index base
  const giftsDecl = html.match(/var DREX_LIVE_GIFTS = \[[\s\S]*?\];/);
  const giftFn = html.match(/function drexLiveGiftById\(gid\) \{[\s\S]*?\n\}/);
  ok(!!giftsDecl && !!giftFn, 'T5 manifest y drexLiveGiftById extraíbles del index');
  if (giftsDecl && giftFn) {
    vm.runInContext(giftsDecl[0] + '\n' + giftFn[0], sandbox);
    vm.runInContext(modSrc, sandbox);
  }
} catch (e) { ok(false, 'T5 sandbox eval: ' + e.message); }

if (sandbox && sandbox.window.__dswov) {
  const D = sandbox.window.__dswov, S = D.S, G = sandbox.__G;
  // arranque vía boot (como lo haría dsw:studio-ready)
  D.boot();
  ok(S.inited === true, 'T5 boot marca inited');
  const hooks = sandbox.window.__dswDrawHooks;
  ok(Array.isArray(hooks) && hooks.length === 9, 'T5 9 hooks registrados (sondeo + 6 widgets + marco y cuenta de inicio C240)');
  ['poll', 'alerts', 'goal', 'timer', 'lower', 'chat', 'ticker'].forEach(k => {
    ok(hooks.indexOf(D.hooks[k]) >= 0, 'T5 hook registrado: ' + k);
  });

  // eventos reales: chat + regalo + likes
  G.chatBuf.push({ name: 'Ana', text: 'hola mundo' });
  G.alerts.push({ giftId: 'chispa', name: 'Beto', t0: 1 });
  G.els.vLikes.textContent = '150';
  const before = sandbox.__oscStarts();
  D.pollStudio();
  eq(S.chatBuf.length, 1, 'T5 chat real leído');
  eq(S.chatBuf[0].name, 'Ana', 'T5 nombre del chat');
  eq(S.giftCoins, 10, 'T5 giftCoins suma precio real de chispa (10)');
  eq(S.alerts.length, 2, 'T5 alertas: regalo + hito 100 likes');
  eq(S.nextMile, 200, 'T5 próximo hito = 200');
  ok(sandbox.__oscStarts() > before, 'T5 beep WebAudio sonó en alertas');
  ok(S.tickerEvts.length >= 2, 'T5 ticker recibió eventos');

  // el sondeo es idempotente: sin eventos nuevos no duplica
  const n0 = S.alerts.length, c0 = S.giftCoins;
  D.pollStudio();
  eq(S.alerts.length, n0, 'T5 poll idempotente (alertas)');
  eq(S.giftCoins, c0, 'T5 poll idempotente (coins)');

  // buffers podados con shift: el seguimiento por identidad no pierde eventos
  G.alerts = [{ giftId: 'flor_nebular', name: 'Ceci', t0: 2 }]; // drawAlerts podó el anterior
  D.pollStudio();
  eq(S.giftCoins, 30, 'T5 evento no se pierde tras poda del buffer (10+20)');

  // beep respeta el toggle de sonido
  S.tg.sound = false;
  const b1 = sandbox.__oscStarts();
  D.beep(880, 0.1);
  eq(sandbox.__oscStarts(), b1, 'T5 sin beep con sonido apagado');
  S.tg.sound = true;
  D.beep(880, 0.1);
  ok(sandbox.__oscStarts() > b1, 'T5 beep con sonido encendido');

  // dibujo de los 6 widgets no lanza
  const ctx = makeCtx();
  let threw = '';
  try {
    D.hooks.alerts(ctx, 1280, 720, 1100);
    D.hooks.goal(ctx, 1280, 720, 1100);
    S.tg.chat = true;
    D.hooks.chat(ctx, 1280, 720, 1100);
    D.pushTicker('evento de prueba');
    D.hooks.ticker(ctx, 1280, 720, 60000);
    S.lower.name = 'Narayan'; S.lower.title = 'En vivo'; S.lower.show = true;
    for (let i = 0; i < 30; i++) D.hooks.lower(ctx, 1280, 720, 1100 + i * 16);
    ok(S.lower.a > 0.9, 'T5 tercio inferior anima entrada');
    S.lower.show = false;
    for (let i = 0; i < 60; i++) D.hooks.lower(ctx, 1280, 720, 2000 + i * 16);
    ok(S.lower.a < 0.1, 'T5 tercio inferior anima salida');
    // alertas expiran tras 4.2s
    D.hooks.alerts(ctx, 1280, 720, 1000 + 5000);
    eq(S.alerts.length, 0, 'T5 alertas expiran');
  } catch (e) { threw = e.message; }
  ok(!threw, 'T5 dibujo de widgets sin excepciones' + (threw ? ': ' + threw : ''));

  // temporizador: formato y beep al llegar a cero
  eq(D.fmtTime(125), '02:05', 'T5 fmtTime 125s');
  eq(D.fmtTime(0), '00:00', 'T5 fmtTime 0s');
  S.timer.min = 1; S.timer.t0 = Date.now() - 61000; S.timer.running = true; S.timer.done = false;
  const b2 = sandbox.__oscStarts();
  D.hooks.timer(ctx, 1280, 720, 1100);
  eq(S.timer.running, false, 'T5 timer se detiene en cero');
  eq(S.timer.done, true, 'T5 timer marca done');
  ok(sandbox.__oscStarts() >= b2 + 3, 'T5 triple beep al llegar a cero');

  // precios del manifest real
  eq(D.giftPrice('nucleo_drex'), 15000, 'T5 precio real nucleo_drex=15000');
  eq(D.giftPrice('inexistente'), 0, 'T5 giftId desconocido = 0');

  // respaldo: parseGiftManifest extrae precios del texto del manifest real
  const mtxt = html.match(/var DREX_LIVE_GIFTS = \[[\s\S]*?\];/)[0];
  const pmap = D.parseGiftManifest(mtxt);
  eq(pmap['cafe_orbital'] && pmap['cafe_orbital'].price, 50, 'T5 parseGiftManifest precio cafe_orbital');
  eq(pmap['nucleo_drex'] && pmap['nucleo_drex'].label, 'Núcleo Drex', 'T5 parseGiftManifest label nucleo_drex');
  eq(Object.keys(pmap).length, 20, 'T5 parseGiftManifest 20 regalos');
  eq(D.giftLabel('chispa'), 'Chispa Índigo', 'T5 giftLabel usa manifest');

  // wiring del panel no lanza con elementos stub
  try { D.wirePanel(); ok(true, 'T5 wirePanel sin excepciones'); }
  catch (e) { ok(false, 'T5 wirePanel: ' + e.message); }
} else {
  ok(false, 'T5 __dswov expuesto');
}

// ---------- T6: i18n ES/EN/ZH/PT ----------
const NEWKEYS = {
  'Overlays': ['Overlays', '叠加层', 'Sobreposições'],
  'Alertas animadas': ['Animated alerts', '动画提醒', 'Alertas animados'],
  'Meta de regalos': ['Gift goal', '礼物目标', 'Meta de presentes'],
  'Chat en pantalla': ['On-screen chat', '屏幕聊天', 'Chat na tela'],
  'Cinta de eventos': ['Event ticker', '事件滚动条', 'Ticker de eventos'],
  'Cuenta regresiva': ['Countdown', '倒计时', 'Contagem regressiva'],
  'Sonido de alerta': ['Alert sound', '提醒声音', 'Som de alerta'],
  'Meta': ['Goal', '目标', 'Meta'],
  'Nombre en el tercio': ['Lower-third name', '下三分屏姓名', 'Nome no terço'],
  'Título en el tercio': ['Lower-third title', '下三分屏标题', 'Título no terço'],
  'Mostrar tercio': ['Show lower third', '显示下三分屏', 'Mostrar terço'],
  '¡Hito de likes!': ['Likes milestone!', '点赞里程碑！', 'Marco de curtidas!'],
  '¡Gracias por el apoyo!': ['Thank you for the support!', '感谢你的支持！', 'Obrigado pelo apoio!']
};
Object.keys(NEWKEYS).forEach(k => {
  eq(i18nSrc.split('"' + k + '":').length - 1, 3, 'T6 clave "' + k + '" exactamente 1x por dict');
});
let I18N = null;
try {
  const ictx = {};
  vm.createContext(ictx);
  vm.runInContext(i18nSrc, ictx);
  I18N = { en: ictx.APP_ENGLISH_TEXT, zh: ictx.APP_CHINESE_TEXT, pt: ictx.APP_PORTUGUESE_TEXT };
} catch (e) { ok(false, 'T6 eval drex-i18n.js: ' + e.message); }
if (I18N && I18N.en && I18N.zh && I18N.pt) {
  Object.keys(NEWKEYS).forEach(k => {
    eq(I18N.en[k], NEWKEYS[k][0], 'T6 EN ' + k);
    eq(I18N.zh[k], NEWKEYS[k][1], 'T6 ZH ' + k);
    eq(I18N.pt[k], NEWKEYS[k][2], 'T6 PT ' + k);
  });
  const used = ['Overlays', 'Alertas animadas', 'Meta de regalos', 'Chat en pantalla',
    'Cinta de eventos', 'Cuenta regresiva', 'Sonido de alerta', 'Meta', 'Nombre en el tercio',
    'Título en el tercio', 'Mostrar tercio', 'Ocultar', 'Minutos', 'Empezar', 'Detener',
    'Regalo recibido', 'envió', 'Drex Coins', '¡Hito de likes!', '¡Gracias por el apoyo!'];
  const dictNames = { en: 'APP_ENGLISH_TEXT', zh: 'APP_CHINESE_TEXT', pt: 'APP_PORTUGUESE_TEXT' };
  ['en', 'zh', 'pt'].forEach(l => {
    const missing = used.filter(k => !(k in I18N[l]));
    ok(missing.length === 0, 'T6 dict ' + dictNames[l] + ' tiene las claves usadas por el panel/canvas' +
      (missing.length ? ': faltan ' + missing.join(',') : ''));
  });
} else { ok(false, 'T6 dicts TEXT evaluables'); }

// ---------- T7: higiene ----------
ok(html.toLowerCase().split('spacex').length - 1 === 0, 'T7 index sin SpaceX');
const panelHtml = html.slice(html.indexOf('dswov-t-alerts') - 4000, html.indexOf('dswov-timer-stop') + 500);
ok(!EMOJI_RE.test(panelHtml), 'T7 panel Overlays sin emojis');

// ---------- T8: sintaxis de todos los bloques <script> ----------
const scripts = [];
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html)) !== null) scripts.push(m[1]);
ok(scripts.length > 10, 'T8 bloques <script> encontrados (' + scripts.length + ')');
let badSyntax = 0;
scripts.forEach((s, i) => {
  if (!s.trim()) return;
  try { new vm.Script(s, { filename: 'script-' + i + '.js' }); }
  catch (e) { badSyntax++; console.error('FAIL T8 script-' + i + ': ' + e.message); }
});
eq(badSyntax, 0, 'T8 todos los bloques <script> compilan');
try { new vm.Script(i18nSrc, { filename: 'drex-i18n.js' }); ok(true, 'T8 drex-i18n.js compila'); }
catch (e) { ok(false, 'T8 drex-i18n.js: ' + e.message); }

console.log('\nC239-L2: ' + pass + ' verdes, ' + fail + ' rojos');
process.exit(fail ? 1 : 0);
