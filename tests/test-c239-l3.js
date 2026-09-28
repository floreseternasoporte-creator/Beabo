/* C239-L3 — tests: escenas y fuentes nivel pro (dswpro). node tests/test-c239-l3.js */
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

// ---------- T1: entregables del carril ----------
['index.html', 'drex-i18n.js', 'tests/test-c239-l3.js'].forEach(f => {
  ok(fs.existsSync(path.join(ROOT, f)), 'T1 existe ' + f);
});
if (fs.existsSync(path.join(ROOT, 'CHANGES.md'))) { pass++; } else { console.log('(T1 CHANGES.md ausente en el repo: omitido)'); }
ok(html.length > 4000000, 'T1 index.html es la base completa (~4.9MB)');

// ---------- T2: modelo (extraído del index.html, UMD) ----------
let M = null;
{
  const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
  const mb = blocks.find(b => b.indexOf('var DSModel = {') >= 0);
  ok(!!mb, 'T2 bloque del modelo encontrado');
  if (mb) {
    const code = mb.replace(/^<script>/, '').replace(/<\/script>$/, '');
    const sb = { module: { exports: {} }, console: console };
    try {
      vm.runInNewContext(code, sb, { filename: 'ds-model.js' });
      M = sb.module.exports;
    } catch (e) { ok(false, 'T2 modelo evalúa: ' + e.message); }
  }
}
ok(M && typeof M === 'object', 'T2 M exporta objeto');
if (M) {
  const p = M.newProject();
  const s2 = M.addScene(p, 'Dos');
  ok(typeof s2 === 'string', 'T2 addScene id');
  ok(M.renameScene(p, s2, '  Charla  '), 'T2 renameScene');
  eq(M.getScene(p, s2).name, 'Charla', 'T2 rename con trim');
  ok(!M.renameScene(p, s2, '   '), 'T2 rename vacío = false');
  const s3 = M.dupScene(p, s2);
  ok(s3 && s3 !== s2, 'T2 dupScene id nuevo');
  eq(M.getScene(p, s3).name, 'Charla copia', 'T2 dupScene nombre');
  ok(M.delScene(p, s3), 'T2 delScene ok');
  ok(!M.delScene(p, 'no-existe'), 'T2 delScene id malo = false');
  M.delScene(p, s2);
  ok(!M.delScene(p, p.scenes[0].id), 'T2 NO se puede eliminar la última escena');
  eq(p.scenes.length, 1, 'T2 queda 1 escena');
  // duplicar copia capas con ids nuevos
  const p2 = M.newProject();
  const l1 = M.addLayer(p2, p2.scenes[0].id, 'camera', {});
  const d2 = M.dupScene(p2, p2.scenes[0].id);
  const dl = M.getScene(p2, d2).layers;
  eq(dl.length, 1, 'T2 dup copia capas');
  ok(dl[0].id !== l1.id, 'T2 capa duplicada con id nuevo');
}

// ---------- T3: helpers puros dswpro ----------
let P8 = null;
{
  const ini = html.indexOf('/*__dswpro-puros-ini__*/');
  const fin = html.indexOf('/*__dswpro-puros-fin__*/');
  ok(ini >= 0 && fin > ini, 'T3 sección de puros extraíble');
  if (ini >= 0 && fin > ini) {
    const code = html.slice(ini, fin);
    const sb = {};
    try { vm.runInNewContext(code, sb, { filename: 'dswpro-puros.js' }); P8 = sb; }
    catch (e) { ok(false, 'T3 puros evalúan: ' + e.message); }
  }
}
if (P8) {
  eq(P8.dswproFxFilter(null), null, 'T3 fx null = null');
  eq(P8.dswproFxFilter({}), null, 'T3 fx vacío = null');
  eq(P8.dswproFxFilter({ brightness: 1, contrast: 1, saturate: 1, blur: 0 }), null, 'T3 fx neutro = null');
  eq(P8.dswproFxFilter({ brightness: 1.2, contrast: 0.8, saturate: 1.5, blur: 2 }),
    'brightness(1.2) contrast(0.8) saturate(1.5) blur(2px)', 'T3 fx string CSS');
  eq(P8.dswproFxFilter({ blur: 0 }), null, 'T3 blur 0 no emite');
  const cr = P8.dswproCropRect(1000, 500, { t: 0.1, r: 0.2, b: 0.1, l: 0.05 });
  eq(cr.sx, 50, 'T3 crop sx'); eq(cr.sy, 50, 'T3 crop sy');
  eq(cr.cw, 750, 'T3 crop cw'); eq(cr.ch, 400, 'T3 crop ch');
  const cr0 = P8.dswproCropRect(1000, 500, null);
  eq(cr0.sx, 0, 'T3 crop nulo = fuente completa');
  const crx = P8.dswproCropRect(100, 100, { t: 0.9, l: 0.9, r: 0.9, b: 0.9 });
  ok(crx.cw >= 1 && crx.ch >= 1, 'T3 crop extremo no colapsa');
  const ps = P8.dswproPropScale(0.4, 0.3, 0.8, 0.5);
  ok(Math.abs(ps.w / ps.h - 0.4 / 0.3) < 1e-9, 'T3 propScale conserva aspecto');
  eq(Math.round(ps.w * 1000), 800, 'T3 propScale eje dominante (w)');
  const ps2 = P8.dswproPropScale(0.4, 0.3, 0.5, 0.9);
  eq(Math.round(ps2.h * 1000), 900, 'T3 propScale eje dominante (h)');
  const keys = P8.DSWPRO_KEYCOLORS;
  ok(keys && keys.green && keys.blue && keys.magenta, 'T3 3 colores clave');
  eq(keys.green.join(','), '0,255,0', 'T3 verde');
  eq(keys.blue.join(','), '0,0,255', 'T3 azul');
  eq(keys.magenta.join(','), '255,0,255', 'T3 magenta');
  const near = P8.dswproChromaDist(10, 250, 10, keys.green);
  ok(near < 0.25 * 441.67, 'T3 píxel casi-verde bajo umbral');
  const far = P8.dswproChromaDist(255, 0, 0, keys.green);
  ok(far > 0.25 * 441.67 + 50, 'T3 píxel rojo sobre umbral');
}

// ---------- T4: patrones de cada función en index.html ----------
function has(s) { return html.indexOf(s) >= 0; }
// 4.1 CRUD escenas: duplicar/renombrar ya existían; L3 agrega confirmación + protección última
ok(has("confirm(t('Eliminar escena')"), 'T4 eliminar escena pide confirmación');
ok(has("t('No se puede eliminar la última escena')"), 'T4 aviso última escena');
ok(has('data-a="dup"') && has('data-a="ren"'), 'T4 botones duplicar/renombrar por escena');
// 4.2 transición slide
ok(has('id="dsw-tr-slide"'), 'T4 botón #dsw-tr-slide');
ok(has("G.P.transition.type = 'slide'"), 'T4 wiring tipo slide');
ok(has("ty === 'slide'"), 'T4 paintTransition pinta slide');
ok(has("G.trans.kind === 'slide'"), 'T4 tick rama slide');
ok(has('kind: G.P.transition.type'), 'T4 switchScene guarda kind');
ok(has('(1 - pe) * W'), 'T4 slide: nueva entra desde la derecha');
ok(has('-pe * W'), 'T4 slide: anterior sale por la izquierda');
ok(has('G.trans.dur || 500'), 'T4 slide respeta duración configurada');
// 4.3 hotkeys E/R
ok(has("k === 'e'"), 'T4 hotkey E');
ok(has('if (G.live) stopLive(); else goLive();'), 'T4 E alterna goLive/stopLive');
ok(has("k === 'r'"), 'T4 hotkey R');
ok(has("typeof window.__dswToggleRecord === 'function'"), 'T4 R con guard typeof');
ok(has("window.__dswToggleRecord()"), 'T4 R llama al toggle del otro carril');
ok(has("t('Grabación no disponible')"), 'T4 R avisa si no existe');
ok(has('/^(INPUT|TEXTAREA|SELECT)$/'), 'T4 hotkeys ignoran foco en inputs');
ok(has('ev.key >= \'1\' && ev.key <= \'9\''), 'T4 hotkeys 1-9 intactos');
// 4.4 transformar: 8 manijas
ok(has("['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w']"), 'T4 8 manijas');
ok(has('dswproPropScale(r.w0, r.h0, nw, nh)'), 'T4 esquinas proporcionales');
ok(has('r.corner.length === 2'), 'T4 bordes libres, esquinas proporcionales');
ok(has('dswproClampLayer(l)'), 'T4 clamp real tras mover/escalar');
ok(!has('M.clampRect(G.P.canvas'), 'T4 sin llamadas rotas a clampRect(canvas, layer)');
// 4.5 menú de capa
ok(has('dswproRenderLayerMenu(l);'), 'T4 renderLayered anexa menú pro');
ok(has("dswproFitBtn('contain'") && has("dswproFitBtn('cover'") && has("dswproFitBtn('stretch'") &&
  has("'Ajustar'") && has("'Rellenar'") && has("'Estirar'") && has("t('Encuadre')"),
  'T4 encuadre ajustar/rellenar/estirar');
ok(has('dswpro-crop-t') && has('dswpro-crop-apply') && has("t('Aplicar')"), 'T4 recorte numérico + aplicar');
ok(has("id=\"dswpro-lock\"") && has("id=\"dswpro-vis\""), 'T4 bloquear y ocultar/mostrar');
ok(has('drexIcon(') || has('dswproIcon('), 'T4 iconos SVG');
// 4.6 filtros + chroma
ok(has('ctx.filter'), 'T4 ctx.filter por capa');
ok(has("ctx.filter = 'none'"), 'T4 filter reseteado');
ok(has('function drawLayerBase('), 'T4 drawLayerBase renombrado');
ok(has('dswproFxFilter(l.cfg && l.cfg.fx)'), 'T4 wrapper aplica fx de la capa');
ok(has('dswproDrawMedia'), 'T4 ruta de dibujo pro (fit/crop/chroma)');
ok(has('dswproDrawChroma'), 'T4 chroma key');
ok(has('getImageData') && has('putImageData'), 'T4 chroma con loop de píxeles');
ok(has('dswproChromaCanvas'), 'T4 chroma con canvas offscreen reutilizado');
ok(has('Math.min(480'), 'T4 chroma tope de resolución (rendimiento)');
ok(has('dswpro-ch-tol') && has('dswpro-ch-color'), 'T4 tolerancia y color configurables');
ok(has('COSTO DE RENDIMIENTO'), 'T4 costo de rendimiento documentado en código');
// 4.7 init resiliente
ok(has("new CustomEvent('dsw:studio-ready')"), 'T4 evento dsw:studio-ready');
ok(has("document.addEventListener('dsw:studio-ready'"), 'T4 escucha del evento');
ok(has('DrexStudioWeb._state()') && has('setInterval(function ()'), 'T4 fallback por intervalo con _state().inited');
// 4.8 prefijo y reglas
ok(has('dswpro'), 'T4 prefijo dswpro presente');
ok(has('window.DrexStudioWeb = {'), 'T4 DrexStudioWeb intacto');

// ---------- T5: i18n ----------
let I18N = null;
{
  const sb = {};
  try { vm.runInNewContext(i18nSrc, sb, { filename: 'drex-i18n.js' }); I18N = sb; }
  catch (e) { ok(false, 'T5 i18n evalúa: ' + e.message); }
}
const NEWKEYS = ['Deslizar', 'Eliminar escena', 'No se puede eliminar la última escena',
  'Grabación no disponible', 'Encuadre', 'Ajustar', 'Rellenar', 'Estirar', 'Recorte',
  'Aplicar', 'Filtros', 'Brillo', 'Contraste', 'Saturación', 'Desenfoque', 'Restablecer',
  'Chroma key', 'Color clave', 'Tolerancia', 'Verde', 'Azul', 'Magenta',
  'Arriba', 'Derecha', 'Abajo', 'Izquierda', 'Puede afectar el rendimiento'];
const DICTS = { en: 'APP_ENGLISH_TEXT', zh: 'APP_CHINESE_TEXT', pt: 'APP_PORTUGUESE_TEXT' };
Object.keys(DICTS).forEach(lang => {
  const d = I18N && I18N[DICTS[lang]];
  ok(d && typeof d === 'object', 'T5 dict ' + lang + ' existe');
  if (!d) return;
  NEWKEYS.forEach(k => {
    ok(typeof d[k] === 'string' && d[k].trim().length > 0, 'T5 [' + lang + '] "' + k + '" traducida');
  });
  const keys = Object.keys(d);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  ok(dupes.length === 0, 'T5 [' + lang + '] sin claves duplicadas');
});
// las claves ES se usan vía t('...') en el index.html
['Deslizar', 'Eliminar escena', 'Encuadre', 'Ajustar', 'Rellenar', 'Estirar', 'Recorte',
 'Aplicar', 'Filtros', 'Brillo', 'Contraste', 'Saturación', 'Desenfoque', 'Restablecer',
 'Chroma key', 'Color clave', 'Tolerancia', 'Verde', 'Azul', 'Magenta',
 'Grabación no disponible', 'No se puede eliminar la última escena', 'Puede afectar el rendimiento'
].forEach(k => {
  ok(has("t('" + k + "')") || has("'" + k + "'") || has('data-dsx-t="' + k + '"'), 'T5 clave usada en UI: "' + k + '"');
});

// ---------- T6: higiene ----------
ok(html.toLowerCase().indexOf('spacex') < 0, 'T6 index.html sin SpaceX');
ok(i18nSrc.toLowerCase().indexOf('spacex') < 0, 'T6 i18n sin SpaceX');
{
  const ini = html.indexOf('/* ============ C239-L3 dswpro: escenas');
  const fin = html.indexOf('window.DrexStudioWeb = {');
  const sec = (ini >= 0 && fin > ini) ? html.slice(ini, fin) : '';
  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u2600-\u{27BF}\u2B00-\u{2BFF}\uFE0F]/u;
  ok(sec.length > 10000 && !EMOJI_RE.test(sec), 'T6 sección dswpro sin emojis');
  ok(sec.toLowerCase().indexOf('spacex') < 0, 'T6 sección dswpro sin SpaceX');
}

// ---------- T7: sintaxis de todos los bloques <script> ----------
{
  const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
  ok(blocks.length >= 5, 'T7 hay ' + blocks.length + ' bloques <script>');
  let bad = 0;
  blocks.forEach((b, i) => {
    const code = b.replace(/^<script>/, '').replace(/<\/script>$/, '');
    if (!code.trim()) return;
    try { new vm.Script(code, { filename: 'block' + i + '.js' }); }
    catch (e) { bad++; console.error('FAIL: sintaxis bloque', i, e.message.slice(0, 160)); }
  });
  ok(bad === 0, 'T7 todos los bloques compilan (vm.Script)');
}

console.log('\nC239-L3: ' + pass + ' verdes, ' + fail + ' rojos');
process.exit(fail ? 1 : 0);
