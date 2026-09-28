/* Test C237-L5: retransmitir video es exclusivo del estudio (PC), nunca en móvil.
 * Verifica:
 *  1. Estáticos: drexLiveOpenSetup invoca la puerta; el HTML del selector de
 *     fuente sigue existiendo (el estudio lo necesita); i18n de la fuente intacto.
 *  2. En contexto MÓVIL (fromStudio=false): la puerta oculta label+segmento+panel,
 *     fuerza el estado a cámara, y drexLiveSetSource('video') se degrada a cámara.
 *  3. En contexto ESTUDIO (fromStudio=true): la puerta muestra el selector y
 *     drexLiveSetSource('video') selecciona video de verdad.
 * Uso: node tests/test-c237l5-mobile-nosource.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const W = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(W, 'index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(W, 'drex-i18n.js'), 'utf8');

// ---------- 1. estáticos ----------
assert(!/SpaceX/.test(html), 'SpaceX en index.html');
const openSetupIdx = html.indexOf('window.drexLiveOpenSetup = async function');
assert(openSetupIdx > 0, 'no se encontró drexLiveOpenSetup');
assert(
  html.slice(openSetupIdx, openSetupIdx + 1200).includes('drexLiveSetupGateSource()'),
  'drexLiveOpenSetup no invoca drexLiveSetupGateSource()'
);
// El HTML del selector sigue existiendo: el flujo del estudio lo necesita.
for (const id of ['drex-live-src-label', 'drex-live-srcseg', 'drex-live-srcbtn-video',
                  'drex-live-video-pane', 'drex-live-video-file']) {
  assert(html.includes('id="' + id + '"'), 'falta #' + id + ' (el estudio lo necesita)');
}
// i18n de la fuente intacto (el estudio lo usa).
for (const k of ['Fuente', 'Cámara', 'Elige un video', 'Cargar', 'Repetir al terminar', 'Quitar video']) {
  assert(i18n.includes('"' + k + '"'), 'clave i18n perdida: ' + k);
}
console.log('OK estáticos: puerta invocada, selector intacto para el estudio, i18n intacto');

// ---------- 2. sandbox ----------
function makeEl() {
  const classes = new Set();
  return {
    style: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, f) => {
        if (f === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); }
        else if (f) classes.add(c); else classes.delete(c);
      },
      contains: (c) => classes.has(c),
    },
    _classes: classes,
    querySelectorAll: () => [],
    textContent: '', value: '', disabled: false, srcObject: null,
  };
}

function loadContext(fromStudio) {
  const els = {};
  const sb = {
    console,
    LS: {},
    URL: {},
    navigator: {},
    drexLiveStopStream: function () {},
    drexLiveRebroadcastBadgeHTML: function () { return '<span>Retransmisión</span>'; },
    document: { getElementById: (id) => (els[id] || (els[id] = makeEl())) },
  };
  sb.window = {};
  sb.window.__drexStudioTx = { fromStudio: !!fromStudio };
  vm.createContext(sb);
  const a = html.indexOf('/* ---------------- estado (cuelga de LS');
  const endMark = '/* C237-L5: fin del bloque de fuente */';
  const b = html.indexOf(endMark);
  assert(a > 0 && b > a, 'no se encontró el bloque de fuente para el sandbox');
  vm.runInContext(html.slice(a, b + endMark.length), sb, { filename: 'fuente-block.js' });
  // Sustituir la adquisición real de cámara por un stub.
  sb.window.drexLiveAcquireCamera = async function () { sb.__camCalled = true; };
  return { sb, els };
}

// ---------- 3. contexto MÓVIL ----------
{
  const { sb, els } = loadContext(false);
  vm.runInContext('drexLiveSetupGateSource();', sb);
  assert(els['drex-live-src-label'].style.display === 'none', 'móvil: label Fuente visible');
  assert(els['drex-live-srcseg'].style.display === 'none', 'móvil: segmento Cámara|Video visible');
  assert(els['drex-live-video-pane'].style.display === 'none', 'móvil: panel de video visible');
  assert(els['drex-live-video-pane']._classes.has('hidden'), 'móvil: panel sin clase hidden');
  const kind = vm.runInContext('(function(){ var st = drexLiveVideoState(); return st && st.kind; })()', sb);
  assert(kind === 'camera', 'móvil: el estado no quedó en cámara (kind=' + kind + ')');
  // Intentar forzar video en móvil se degrada a cámara.
  vm.runInContext("window.drexLiveSetSource('video');", sb);
  const kind2 = vm.runInContext('(function(){ return drexLiveVideoState().kind; })()', sb);
  assert(kind2 === 'camera', 'móvil: drexLiveSetSource(video) no se degradó (kind=' + kind2 + ')');
  assert(els['drex-live-video-pane'].style.display === 'none', 'móvil: el panel se mostró tras setSource(video)');
  console.log('OK móvil: sin selector de fuente, siempre cámara');
}

// ---------- 4. contexto ESTUDIO ----------
{
  const { sb, els } = loadContext(true);
  vm.runInContext('drexLiveSetupGateSource();', sb);
  assert(els['drex-live-src-label'].style.display === '', 'estudio: label Fuente oculto');
  assert(els['drex-live-srcseg'].style.display === '', 'estudio: segmento oculto');
  assert(els['drex-live-video-pane'].style.display === '', 'estudio: panel con display none');
  // En el estudio, elegir video funciona de verdad.
  vm.runInContext("window.drexLiveSetSource('video');", sb);
  const kind = vm.runInContext('(function(){ return drexLiveVideoState().kind; })()', sb);
  assert(kind === 'video', 'estudio: no se pudo elegir video (kind=' + kind + ')');
  assert(!els['drex-live-video-pane']._classes.has('hidden'), 'estudio: panel sigue oculto tras elegir video');
  assert(els['drex-live-setup-rebc'].style.display === '', 'estudio: insignia Retransmisión no se mostró en el setup');
  // Volver a cámara también funciona.
  vm.runInContext("window.drexLiveSetSource('camera');", sb);
  const kind2 = vm.runInContext('(function(){ return drexLiveVideoState().kind; })()', sb);
  assert(kind2 === 'camera', 'estudio: no se pudo volver a cámara');
  console.log('OK estudio: selector visible, video seleccionable');
}

console.log('C237-L5 VERDE');
