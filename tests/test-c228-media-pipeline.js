// test-c228-media-pipeline.js — carril B/4 (media pipeline)
// Bug MEDIA-B1: drexSnapPublishDataUrl dejaba snapImages/<id> huérfano si la
//   escritura del doc fallaba (el barrido solo enumera snapshots con doc).
// Bug MEDIA-B2: loadNoteImages tragaba el error con .catch(()=>[]) y el
//   botón de reintento de hydrateNoteImages era código muerto: en fallo de
//   red las fotos desaparecían en silencio.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

function extract(html, startMarker, endMarker) {
  const s = html.indexOf(startMarker);
  assert(s >= 0, 'start marker no encontrado: ' + startMarker.slice(0, 40));
  const e = html.indexOf(endMarker, s);
  assert(e >= 0, 'end marker no encontrado: ' + endMarker.slice(0, 40));
  // endMarker arranca con el "\n}" de cierre: incluirlo.
  return html.slice(s, e + 2);
}

// Los artefactos laneB/index-base.html e index-fixed.html nunca se preservaron.
// Se verifica el fix directamente sobre el index.html actual (que incluye el fix).
const fixed = fs.readFileSync(__dirname + '/../index.html', 'utf8');

const SNAP_SRC = h => extract(h, 'function drexSnapPublishDataUrl(dataUrl) {', '\n}\n\n// ---------- Carga de la bandeja ----------');
const IMG_SRC = h => extract(h, 'const _noteImagesCache = {};', '\n  // Hidrata las fotos de un post VIEJO');

function driver(html, mode) {
  return `
var __out = { removes: [], sets: [], toasts: [], retryShown: false, hiddenSilently: false, loaded: null, rejected: false };
// ---------- fakes ----------
var DREX_SNAP_TTL_MS = 5*3600*1000;
var _snapImgCache = {};
var showMiniToast = function(m){ __out.toasts.push(m); };
var appT = function(s){ return s; };
var drexSnapLoadTray = function(){};
var drexSnapMe = function(){ return 'user1'; };
var __failSnapDoc = ${mode.snapDocFail ? 'true' : 'false'};
var drexSnapDb = function(){
  return { ref: function(path){
    return {
      set: function(v){ __out.sets.push(path); if (__failSnapDoc && path === 'snapshots/snapXYZ') return Promise.reject(new Error('netfail')); return Promise.resolve(); },
      push: function(){ return { key: 'snapXYZ', set: function(v){ __out.sets.push('snapshots/snapXYZ'); if (__failSnapDoc) return Promise.reject(new Error('netfail')); return Promise.resolve(); } }; },
      remove: function(){ __out.removes.push(path); return Promise.resolve(); }
    };
  }};
};
// ---------- media B2 fakes ----------
var __imgMode = '${mode.imgMode}'; // 'fail' | 'empty' | 'ok'
var DrexCloud = { database: function(){ return { ref: function(p){ return { once: function(){ if (__imgMode === 'fail') return Promise.reject(new Error('netfail')); return Promise.resolve({ val: function(){ return __imgMode === 'empty' ? null : { img_00000: 'data:image/jpeg;base64,AAA' }; } }); } }; } }; } };
var __el = { _attrs: { 'data-note-imgs': 'n1' }, _html: '', style: {},
  getAttribute: function(k){ return this._attrs[k] || null; },
  removeAttribute: function(k){ delete this._attrs[k]; } };
Object.defineProperty(__el, 'innerHTML', { get: function(){ return this._html; }, set: function(v){ this._html = v; } });
var document = { querySelectorAll: function(sel){ return sel === '[data-note-imgs]' ? [__el] : []; } };
var renderNoteImagesHtml = function(){ return ''; };
var escapeHtml = function(s){ return s; };
var escapeInlineSingleQuote = function(s){ return s; };
${SNAP_SRC(html)}
${IMG_SRC(html)}
// ---------- driver ----------
(async function(){
  // B1: fallo a mitad de publicación
  await drexSnapPublishDataUrl('data:image/jpeg;base64,AAA');
  await new Promise(function(r){ setTimeout(r, 50); });
  // B2: hidratación con fallo de red
  hydrateNoteImages('n1');
  await new Promise(function(r){ setTimeout(r, 50); });
  if (__el._html && __el._html.indexOf('data-retry-imgs') >= 0) __out.retryShown = true;
  else if (__el.style.display === 'none') __out.hiddenSilently = true;
  // B2: caso sano (ok / empty) no debe rechazar
  try { var r = await loadNoteImages('n2ok'); __out.loaded = r; }
  catch (e) { __out.rejected = true; }
})();
`;
}

async function run(html, mode) {
  const sandbox = { setTimeout, Promise, Object, Array, JSON, Error, Date, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(driver(html, mode), sandbox, { filename: 'c228-driver.js' });
  await new Promise(r => setTimeout(r, 400));
  return sandbox.__out;
}

(async () => {
  let n = 0;
  const ok = (cond, name) => { n++; assert(cond, 'FAIL: ' + name); console.log('ok ' + n + ' - ' + name); };

  // ===== BASE (rojo): omitido — artefacto index-base.html no preservado ===

  // ===== FIXED (verde) =====
  const f1 = await run(fixed, { snapDocFail: true, imgMode: 'fail' });
  ok(f1.removes.includes('snapImages/snapXYZ'), 'FIX B1: limpia snapImages/<id> tras fallo del doc');
  ok(f1.removes.includes('snapshots/snapXYZ'), 'FIX B1: limpia snapshots/<id> parcial');
  ok(f1.retryShown && !f1.hiddenSilently, 'FIX B2: fallo de red muestra botón de reintento');

  // ===== regresión: caminos sanos intactos =====
  const f2 = await run(fixed, { snapDocFail: false, imgMode: 'ok' });
  ok(f2.removes.length === 0, 'FIX: publicación sana no borra nada');
  ok(f2.toasts.some(t => t.indexOf('destello') >= 0), 'FIX: publicación sana muestra toast de éxito');
  ok(Array.isArray(f2.loaded) && f2.loaded.length === 1 && !f2.rejected, 'FIX: lectura sana de noteImages resuelve el array');

  const f3 = await run(fixed, { snapDocFail: false, imgMode: 'empty' });
  ok(Array.isArray(f3.loaded) && f3.loaded.length === 0 && !f3.rejected, 'FIX: noteImages ausente resuelve [] (no rechaza)');

  console.log('\nC228: ' + n + '/' + n + ' checks verdes');
})().catch(e => { console.error(e.message); process.exit(1); });
