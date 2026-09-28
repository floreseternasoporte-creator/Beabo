/* C233 — tests del estudio web (fase roja → verde). node tests/test-c233-studio.js */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const vm = require('vm');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name); }
}
function eq(a, b, name) { ok(a === b, name + ' (got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + ')'); }

// ---------- T1: el modelo puro existe y exporta la API ----------
/* C240: el modelo vive inline en index.html (script "C233: DrexStudioWeb — modelo")
 * desde que el estudio se integró a la app; se extrae y evalúa en sandbox. */
let M = null;
try {
  const m = /<script>\s*\/\* ============ C233: DrexStudioWeb — modelo[\s\S]*?<\/script>/.exec(html);
  ok(!!m, 'T1 bloque del modelo presente en index.html');
  const body = m[0].replace(/^<script>/, '').replace(/<\/script>$/, '');
  const mod = { exports: {} };
  vm.runInNewContext(body, { module: mod, console: console }, { filename: 'ds-model.js' });
  M = mod.exports;
  ok(M && typeof M === 'object', 'T1 DSModel exportado desde index.html');
} catch (e) { ok(false, 'T1 sandbox eval: ' + e.message); M = null; }
const API = ['newProject','addScene','renameScene','dupScene','delScene','setActiveScene',
  'getScene','activeScene','addLayer','updateLayer','delLayer','moveLayerZ','toggleVis',
  'hitTest','clampRect','fadeAlpha','giftAsset','validateSetup','setOrient','LAYER_TYPES','GIFT_IDS',
  'SCENE_TEMPLATES','applyTemplate'];
API.forEach(fn => ok(M && typeof M[fn] !== 'undefined', 'T1 API.' + fn));

// ---------- T2: comportamiento del modelo ----------
if (M) {
  const p = M.newProject();
  eq(p.scenes.length, 1, 'T2 proyecto inicia con 1 escena');
  eq(p.canvas.w, 1280, 'T2 canvas 1280');
  eq(p.canvas.h, 720, 'T2 canvas 720');
  eq(p.transition.type, 'cut', 'T2 transicion corte por defecto');

  const s2 = M.addScene(p, 'Entrevista');
  ok(typeof s2 === 'string' && s2.length > 0, 'T2 addScene devuelve id');
  eq(p.scenes.length, 2, 'T2 dos escenas');
  ok(M.renameScene(p, s2, 'Charla'), 'T2 renameScene');
  eq(M.getScene(p, s2).name, 'Charla', 'T2 nombre cambiado');
  const s3 = M.dupScene(p, s2);
  ok(s3 && s3 !== s2, 'T2 dupScene id nuevo');
  eq(p.scenes.length, 3, 'T2 tres escenas tras duplicar');
  ok(M.setActiveScene(p, s2), 'T2 setActiveScene');
  eq(M.activeScene(p).id, s2, 'T2 escena activa');
  ok(!M.delScene(p, 'no-existe'), 'T2 delScene id malo = false');
  ok(M.delScene(p, s3), 'T2 delScene ok');
  // no se puede borrar la última
  M.delScene(p, s2); M.delScene(p, p.scenes[0].id);
  eq(p.scenes.length, 1, 'T2 no borra la última escena');

  const sc = p.scenes[0].id;
  const l1 = M.addLayer(p, sc, 'camera', {});
  ok(l1 && l1.id, 'T2 addLayer camera');
  eq(l1.x, 0, 'T2 capa default x=0');
  const bad = M.addLayer(p, sc, 'nave-espacial', {});
  eq(bad, null, 'T2 tipo inválido = null');
  const l2 = M.addLayer(p, sc, 'text', { text: 'Hola' });
  ok(l2.id !== l1.id, 'T2 ids únicos');
  ok(M.updateLayer(p, sc, l1.id, { x: 0.1, w: 0.5 }), 'T2 updateLayer');
  eq(M.getScene(p, sc).layers[0].x, 0.1, 'T2 patch aplicado');
  // z-order: l2 está arriba (última). mover l1 arriba la pone al final
  ok(M.moveLayerZ(p, sc, l1.id, +1), 'T2 moveLayerZ up');
  const layers = M.getScene(p, sc).layers;
  eq(layers[layers.length - 1].id, l1.id, 'T2 l1 ahora arriba');
  ok(!M.moveLayerZ(p, sc, l1.id, +1), 'T2 no sube más allá del tope');
  const vis = M.toggleVis(p, sc, l2.id);
  eq(vis, false, 'T2 toggleVis apaga');
  // hitTest: punto dentro de l1 (x .1-.6, y 0-1 default h=1?) — usar rect explícito
  M.updateLayer(p, sc, l1.id, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
  M.toggleVis(p, sc, l2.id); // re-encender l2 (pero l1 sigue arriba en z)
  eq(M.hitTest(M.getScene(p, sc).layers, 0.2, 0.2), l1.id, 'T2 hitTest capa superior (l1)');
  M.delLayer(p, sc, l2.id);
  eq(M.hitTest(M.getScene(p, sc).layers, 0.2, 0.2), l1.id, 'T2 hitTest tras borrar');
  eq(M.hitTest(M.getScene(p, sc).layers, 0.9, 0.9), null, 'T2 hitTest fuera = null');
  // capa bloqueada no recibe hit
  M.updateLayer(p, sc, l1.id, { locked: true });
  eq(M.hitTest(M.getScene(p, sc).layers, 0.2, 0.2), null, 'T2 hitTest ignora bloqueada');
  M.updateLayer(p, sc, l1.id, { locked: false });

  const c = M.clampRect({ x: -0.5, y: 0.9, w: 2, h: 0.01 });
  ok(c.x >= 0 && c.y >= 0 && c.w <= 1 && c.h <= 1, 'T2 clampRect dentro de 0..1');
  ok(c.w >= 0.05 && c.h >= 0.05, 'T2 clampRect tamaño mínimo');

  eq(M.fadeAlpha(0, 500), 0, 'T2 fade inicio');
  eq(M.fadeAlpha(500, 500), 1, 'T2 fade fin');
  const mid = M.fadeAlpha(250, 500);
  ok(mid > 0.4 && mid < 0.6, 'T2 fade mitad ≈ 0.5');

  eq(M.GIFT_IDS.length, 20, 'T2 20 regalos');
  ok(M.GIFT_IDS.indexOf('nucleo_drex') >= 0, 'T2 incluye nucleo_drex');
  eq(M.giftAsset('chispa'), 'assets/live-gifts/chispa.png', 'T2 giftAsset ruta');
  eq(M.giftAsset('falso'), null, 'T2 giftAsset inválido = null');

  ok(M.setOrient(p, '9:16'), 'T2 setOrient 9:16');
  eq(p.canvas.w, 720, 'T2 9:16 w=720');
  eq(p.canvas.h, 1280, 'T2 9:16 h=1280');
  ok(!M.setOrient(p, '4:3'), 'T2 orientación inválida = false');

  const errs = M.validateSetup(M.newProject());
  ok(Array.isArray(errs) && errs.indexOf('escena-vacia') >= 0, 'T2 validateSetup detecta escena vacía');
}

// ---------- T3: el estudio vive inline en index.html (desde C238) ----------
['drexstudioweb-panel', 'dsw-program', 'DrexStudioWeb', 'drexStudioTxSwitchTab'].forEach(m =>
  ok(html.indexOf(m) >= 0, 'T3 index.html contiene ' + m));
try {
  const blocks = html.match(/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/g) || [];
  let bad = 0;
  blocks.forEach(b => { try { new vm.Script(b.replace(/<\/?script[^>]*>/g, '')); } catch (e) { bad++; } });
  eq(bad, 0, 'T3 todos los <script> inline compilan (' + blocks.length + ' bloques)');
} catch (e) { ok(false, 'T3 sintaxis: ' + e.message); }
ok(fs.readFileSync(path.join(ROOT, '404.html'), 'utf8') === html, 'T3 404.html idéntico a index.html');

// ---------- T4: claves del estudio en drex-i18n.js (ES/EN/ZH/PT) ----------
const i18nSrc = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');
['Estudio', 'Escenas', 'Fuentes', 'Capas', 'Mezclador', 'Chat en vivo'].forEach(k => {
  ok(i18nSrc.split('"' + k + '":').length - 1 >= 3, 'T4 clave "' + k + '" en los dicts');
});

// ---------- T5: higiene del estudio inline (sin SpaceX, sin emojis) ----------
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
{
  const i0 = html.indexOf('id="drexstudio-view"');
  const i1 = html.indexOf('</script>', html.indexOf('C233: DrexStudioWeb — modelo'));
  ok(i0 >= 0 && i1 > i0, 'T5 sección del estudio localizada');
  if (i0 >= 0) {
    const sec = html.slice(i0, Math.min(html.length, i0 + 60000)).replace(/data-dsx-ic="[^"]*"/g, '');
    ok(!EMOJI_RE.test(sec), 'T5 HTML del estudio sin emojis visibles');
    ok(sec.toLowerCase().indexOf('spacex') < 0, 'T5 HTML del estudio sin SpaceX');
  }
}

// ---------- T6: publish (solo si existe) ----------
const pubHtml = path.join(ROOT, 'publish', 'index.html');
if (fs.existsSync(pubHtml)) {
  const s = fs.readFileSync(pubHtml, 'utf8');
  ['drexstudioweb-panel', 'dsw-program', 'DrexStudioWeb', 'drexStudioTxSwitchTab'].forEach(m => {
    ok(s.indexOf(m) >= 0, 'T6 publish contiene ' + m);
  });
  const pub404 = path.join(ROOT, 'publish', '404.html');
  ok(fs.existsSync(pub404) && fs.readFileSync(pub404, 'utf8') === s, 'T6 404.html idéntico');
  try {
    const i18n = fs.readFileSync(path.join(ROOT, 'publish', 'drex-i18n.js'), 'utf8');
    ok(i18n.indexOf('"Estudio"') >= 0, 'T6 i18n publish tiene clave Estudio');
  } catch (e) { ok(false, 'T6 publish drex-i18n.js'); }
} else {
  console.log('(T6 omitido: publish/ aún no generado)');
}

console.log('\nC233: ' + pass + ' verdes, ' + fail + ' rojos');
process.exit(fail ? 1 : 0);
