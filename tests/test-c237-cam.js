/* Test C237-L4: encuadre de la cámara del host (sin zoom digital accidental).
 * 1. drexLivePickFit(vw,vh,cw,ch): 'cover' solo si el recorte es leve;
 *    'contain' cuando cover recortaría >35% del cuadro (caso iOS apaisado).
 * 2. Las dos adquisiciones piden aspectRatio 9/16 explícito.
 * 3. drexLiveAdaptPreview mide el cuadro real (loadedmetadata) y adapta.
 * 4. Zoom por pellizco solo con capabilities().zoom; degradado sin romper.
 * 5. El video del ESPECTADOR queda byte-idéntico a la base.
 * Uso: node tests/test-c237-cam.js  (W = dir del candidato)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { execSync } = require('child_process');

const W = '/home/hatch/workspace/c237-cam';
const html = fs.readFileSync(path.join(W, 'index.html'), 'utf8');
function grab(re, msg) {
  const m = html.match(re);
  assert(m, 'ROJO: ' + msg);
  return m[0];
}

// 1. Lógica pura de encuadre
const fitSrc = grab(/window\.drexLivePickFit = function \(vw, vh, cw, ch\) \{[\s\S]*?\n\};/, 'falta window.drexLivePickFit');
const sb = { window: {} };
sb.window = sb;
vm.createContext(sb);
vm.runInContext(fitSrc, sb);
const pick = sb.drexLivePickFit;
assert.strictEqual(pick(720, 1280, 390, 844), 'cover', 'portrait ideal en iPhone debe seguir cover');
assert.strictEqual(pick(1280, 720, 390, 844), 'contain', 'apaisado en iPhone NO debe recortarse');
assert.strictEqual(pick(1080, 1080, 390, 844), 'contain', 'cuadrado en iPhone NO debe recortarse');
assert.strictEqual(pick(720, 1280, 844, 390), 'contain', 'vertical en caja apaisada NO debe recortarse');
assert.strictEqual(pick(1920, 1080, 844, 390), 'cover', 'apaisado en caja apaisada sigue cover');
assert.strictEqual(pick(0, 0, 390, 844), 'cover', 'dimensiones desconocidas: default seguro cover');
console.log('OK drexLivePickFit: 6/6 decisiones correctas');

// 2. Constraints con aspectRatio en ambas adquisiciones
const acq = grab(/drexLiveAcquireCamera = async function \(\) \{[\s\S]*?getUserMedia\(\{[\s\S]*?\}\);/, 'falta drexLiveAcquireCamera');
assert(/aspectRatio/.test(acq) && /9\s*\/\s*16/.test(acq), 'ROJO: acquire sin aspectRatio 9/16');
const swc = grab(/drexLiveSwitchCamera = async function \(\) \{[\s\S]*?getUserMedia\(\{[\s\S]*?\}\);/, 'falta drexLiveSwitchCamera');
assert(/aspectRatio/.test(swc) && /9\s*\/\s*16/.test(swc), 'ROJO: switch sin aspectRatio 9/16');
console.log('OK constraints piden aspectRatio 9/16 en acquire + switch');

// 3. Adaptación al cuadro real
const adaptSrc = grab(/window\.drexLiveAdaptPreview = function \(videoId, bgId\) \{[\s\S]*?\n\};/, 'falta drexLiveAdaptPreview');
assert(/addEventListener\('loadedmetadata'/.test(adaptSrc), 'debe usar addEventListener, no pisar onloadedmetadata');
assert(/drexLivePickFit/.test(adaptSrc), 'adapt debe usar drexLivePickFit');
assert(/objectFit/.test(adaptSrc), 'adapt debe ajustar objectFit');
const nAdaptCalls = (html.match(/drexLiveAdaptPreview\('/g) || []).length;
assert(nAdaptCalls >= 3, 'ROJO: adapt debe llamarse en acquire, switch y go-live (hay ' + nAdaptCalls + ')');
console.log('OK drexLiveAdaptPreview cableado en ' + nAdaptCalls + ' sitios');

// 4. Zoom por pellizco con gating por capabilities
const zoomSrc = grab(/window\.drexLiveInitHostZoom = function \(videoId\) \{[\s\S]*?\n\};/, 'falta drexLiveInitHostZoom');
const zsb = { window: {} };
zsb.window = zsb;
const listeners = {};
const box = { __dlZoom: false, style: {}, addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); } };
const applied = [];
const zoomTrack = {
  getCapabilities: function () { return { zoom: { min: 1, max: 4 } }; },
  applyConstraints: function (c) { applied.push(c); return Promise.resolve(); }
};
zsb.$ = function (id) { return (id === 'drex-live-host-video') ? box : null; };
zsb.LS = { stream: { getVideoTracks: function () { return [zoomTrack]; } } };
vm.createContext(zsb);
vm.runInContext(zoomSrc, zsb);
zsb.drexLiveInitHostZoom('drex-live-host-video');
zsb.drexLiveInitHostZoom('drex-live-host-video');
assert.strictEqual(listeners['touchstart'].length, 1, 'init debe ser idempotente');
assert.strictEqual(box.style.touchAction, 'none', 'el video debe tener touch-action:none (evita zoom del navegador)');
listeners['touchstart'][0]({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }] });
listeners['touchmove'][0]({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 200, clientY: 0 }] });
assert.strictEqual(applied.length, 1, 'pellizco debe aplicar zoom');
assert.strictEqual(applied[0].advanced[0].zoom, 2, 'zoom 2x esperado, fue ' + JSON.stringify(applied[0]));
listeners['touchmove'][0]({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 1000, clientY: 0 }] });
assert.strictEqual(applied[1].advanced[0].zoom, 4, 'debe clampear al max del dispositivo');
// Degradado: track sin capabilities -> no rompe, no aplica
zsb.LS.stream = { getVideoTracks: function () { return [{}]; } };
listeners['touchstart'][0]({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }] });
listeners['touchmove'][0]({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 300, clientY: 0 }] });
assert.strictEqual(applied.length, 2, 'sin soporte de zoom no debe aplicar nada ni romper');
console.log('OK zoom por pellizco: aplica, clampa e idempotente; degradado sin soporte');

// 5. El espectador NO se toca
const base = execSync('git -C /home/hatch/workspace/beabo show origin/main:index.html', { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
function lineWith(s, id) { return s.split('\n').find(function (l) { return l.indexOf('id="' + id + '"') >= 0; }); }
assert.strictEqual(lineWith(html, 'drex-live-viewer-video'), lineWith(base, 'drex-live-viewer-video'), 'ROJO: video del espectador modificado');
console.log('OK espectador intacto');

// 6. Higiene
assert(!/SpaceX/.test(html), 'SpaceX presente');
console.log('C237-L4 VERDE');
