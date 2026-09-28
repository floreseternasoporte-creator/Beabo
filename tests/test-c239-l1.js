/* C239-L1 — tests del mezclador de audio profesional.
 * node tests/test-c239-l1.js
 * Lee el HTML/i18n REALES del carril: asserts estáticos por bloques + pruebas
 * de comportamiento en un sandbox vm con DOM y WebAudio simulados. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');
const I18N = path.join(ROOT, 'drex-i18n.js');
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; } else { fail++; console.error('FAIL:', name); } }
function eq(a, b, name) { ok(a === b, name + ' (got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + ')'); }
function count(s, sub) { return s.split(sub).length - 1; }

ok(fs.existsSync(HTML), 'L1 existe index.html');
ok(fs.existsSync(I18N), 'L1 existe drex-i18n.js');
const html = fs.readFileSync(HTML, 'utf8');
const i18n = fs.readFileSync(I18N, 'utf8');

const JS_BEG = '/* ============ C239-L1: mezclador de audio profesional ============';
const JS_END = '/* ============ fin C239-L1 ============ */';
const CSS_BEG = '/* C239-L1: mezclador de audio profesional (strips con vúmetro, master, monitoreo) */';
const CSS_END = '/* fin C239-L1 */';
ok(html.indexOf(JS_BEG) >= 0 && html.indexOf(JS_END) > html.indexOf(JS_BEG), 'L1 bloque JS delimitado');
ok(html.indexOf(CSS_BEG) >= 0 && html.indexOf(CSS_END) > html.indexOf(CSS_BEG), 'L1 bloque CSS delimitado');
const jsBlock = html.slice(html.indexOf(JS_BEG), html.indexOf(JS_END) + JS_END.length);
const cssBlock = html.slice(html.indexOf(CSS_BEG), html.indexOf(CSS_END) + CSS_END.length);

// ---------- A: vúmetros reales ----------
ok(count(html, 'createAnalyser') >= 4, 'A createAnalyser: mic + capa + master (+ testMic preexistente)');
ok(count(html, '.fftSize = DSWMX_FFT') >= 3, 'A fftSize 256 en vúmetros (mic + capa + master)');
ok(jsBlock.indexOf('getByteTimeDomainData') >= 0, 'A lectura time-domain para el nivel');
ok(jsBlock.indexOf('frequencyBinCount') >= 0, 'A buffer según frequencyBinCount');
ok(jsBlock.indexOf('requestAnimationFrame') >= 0, 'A medidor por rAF');
ok(jsBlock.indexOf('holdUntil') >= 0, 'A picos con hold');
ok(cssBlock.indexOf('.dswmx-meter') >= 0 && cssBlock.indexOf('.dswmx-fill') >= 0 && cssBlock.indexOf('.dswmx-peak') >= 0, 'A CSS de vúmetro (meter/fill/peak)');
ok(jsBlock.indexOf('dswmxDb') >= 0, 'A lectura en dB por strip');
ok(count(html, "d.className = 'dsw-mixrow'") === 0, 'A mezclador básico reemplazado');

// ---------- B: strips por fuente ----------
['dswmxCollectStrips', 'dswmxStripEl', 'dswmxMasterStrip', 'dswmxMeterState'].forEach(fn => ok(jsBlock.indexOf('function ' + fn) >= 0, 'B fn ' + fn));
ok(jsBlock.indexOf("'__mic'") >= 0, 'B strip de micrófono');
ok(jsBlock.indexOf("'__master'") >= 0, 'B strip master');
ok(jsBlock.indexOf('M.activeScene') >= 0, 'B strips desde la escena activa');
ok(/gain\.connect\(an\)/.test(html), 'B cadena: gain(strip) -> analyser');
ok(/an\.connect\(G\.audio\.master\)/.test(html), 'B cadena: analyser -> master');
ok(jsBlock.indexOf('dswmxLiveVol') >= 0, 'B ganancia en vivo sin re-render al arrastrar');
ok(/\.gain\.value\s*=\s*m\s*\?\s*0\s*:/.test(html), 'B mute pone ganancia 0 conservando el valor');
ok(jsBlock.indexOf('aria-pressed') >= 0, 'B mute con aria-pressed');
ok(jsBlock.indexOf('dswmxIconFor') >= 0 && /drexIcon\('mic'\)/.test(jsBlock), 'B iconos SVG con drexIcon()');

// ---------- C: master ----------
ok(jsBlock.indexOf('masterAn') >= 0, 'C AnalyserNode propio del master');
ok(/master\.connect\(masterAn\)/.test(html), 'C master -> masterAn');
ok(/masterAn\.connect\(dest\)/.test(html), 'C masterAn -> dest (el analyser pasa el audio)');
ok(/t\('Master'\)/.test(jsBlock), 'C etiqueta Master i18n');

// ---------- D: MediaStreamDestination intacto ----------
ok(html.indexOf('createMediaStreamDestination') >= 0, 'D MediaStreamDestination existe');
ok(/function buildProgramStream\(\)[\s\S]{0,800}G\.audio\.dest\.stream/.test(html), 'D buildProgramStream lee G.audio.dest');

// ---------- E: grafo limpio ----------
eq(count(html, 'gain.connect(G.audio.mon)'), 0, 'E sin doble ruta directa al monitor');
ok(/master\.connect\(mon\)[\s\S]{0,120}mon\.connect\(ctx\.destination\)/.test(html), 'E ruta master -> mon -> destination');

// ---------- F: monitoreo ----------
ok(jsBlock.indexOf('function dswmxSetMonitor') >= 0, 'F fn dswmxSetMonitor');
ok(html.indexOf('id="dswmx-monbtn"') >= 0, 'F botón de monitoreo en el HTML');
ok(/mon\.gain\.value\s*=\s*0;/.test(html), 'F monitoreo apagado por defecto (evita feedback)');
ok(jsBlock.indexOf('setTargetAtTime') >= 0, 'F transición suave al conmutar');
ok(jsBlock.indexOf('monitorOn') >= 0, 'F estado monitorOn');
ok(html.indexOf('data-dsx-t="Monitoreo local"') >= 0, 'F etiqueta del botón con data-dsx-t');

// ---------- G: i18n ----------
eq(count(i18n, '"Vista previa del en vivo"'), 3, 'G ancla aparece 1 vez por dict');
const NEW_KEYS = {
  'Master': { en: 'Master', zh: '主控', pt: 'Master' },
  'Sin fuentes de audio': { en: 'No audio sources', zh: '暂无音频源', pt: 'Sem fontes de áudio' },
  'Monitoreo local': { en: 'Local monitoring', zh: '本地监听', pt: 'Monitoramento local' },
  'Escuchar el audio del programa en este dispositivo': { en: 'Listen to the program audio on this device', zh: '在此设备上监听节目音频', pt: 'Ouvir o áudio do programa neste dispositivo' }
};
const dictStarts = ['var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {'];
const dicts = dictStarts.map((s, k) => {
  const a = i18n.indexOf(s);
  const b = k < 2 ? i18n.indexOf(dictStarts[k + 1]) : i18n.length;
  return i18n.slice(a, b);
});
ok(dicts.every(d => d.length > 100), 'G 3 dicts TEXT localizados');
['en', 'zh', 'pt'].forEach((lg, di) => {
  Object.keys(NEW_KEYS).forEach(es => {
    ok(dicts[di].indexOf('"' + es + '":"' + NEW_KEYS[es][lg] + '"') >= 0, 'G i18n[' + lg + '] ' + es);
  });
});

// ---------- H: init resiliente ----------
ok(html.indexOf('dsw:studio-ready') >= 0, 'H escucha dsw:studio-ready');
ok(jsBlock.indexOf('window.DrexStudioWeb._state') >= 0, 'H fallback chequea DrexStudioWeb._state()');
ok(/st\s*&&\s*st\.inited/.test(jsBlock), 'H fallback exige inited');
ok(jsBlock.indexOf('setInterval') >= 0, 'H fallback con intervalo');

// ---------- I: re-render al cambiar de escena ----------
ok(/function switchScene\([\s\S]*?renderMixer\(\)[\s\S]*?\nfunction renderLayers/.test(html), 'I switchScene re-renderiza el mezclador');

// ---------- J: API compatible ----------
['function setRowVol', 'function setRowMute', 'function ensureAudio', 'function ensureMic', 'function hookLayerAudio', 'function goLive'].forEach(fn => ok(html.indexOf(fn) >= 0, 'J conserva ' + fn));

// ---------- K: ES5 / prefijo / higiene ----------
ok(!/[^=!<>-]=>(?!=)/.test(jsBlock), 'K bloque JS sin arrow functions (ES5)');
ok(jsBlock.indexOf('`') < 0, 'K bloque JS sin template literals (ES5)');
ok(!/\b(const|let)\b/.test(jsBlock), 'K bloque JS sin const/let (ES5)');
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
ok(!EMOJI_RE.test(jsBlock) && !EMOJI_RE.test(cssBlock), 'K sin emojis en código nuevo');
ok(html.toLowerCase().indexOf('spacex') < 0, 'K sin SpaceX');
ok(cssBlock.split('{').length === cssBlock.split('}').length, 'K CSS con llaves balanceadas');
['drexstudioweb-panel', 'dsw-program', 'DrexStudioWeb', 'drexStudioTxSwitchTab'].forEach(m => ok(html.indexOf(m) >= 0, 'K conserva ' + m));

// ---------- L: sintaxis del bloque JS ----------
ok(jsBlock.indexOf('function renderMixer') >= 0 && jsBlock.indexOf('dswmxInit') >= 0, 'L bloque extraído íntegro');
try {
  const tmp = path.join(ROOT, 'tests', '.dswmx-check.js');
  fs.writeFileSync(tmp, jsBlock);
  execSync('node --check ' + tmp, { stdio: 'pipe' });
  fs.unlinkSync(tmp);
  ok(true, 'L sintaxis JS del bloque');
} catch (e) { ok(false, 'L sintaxis JS del bloque: ' + (e.message || e)); }

// ---------- M: comportamiento real en sandbox vm ----------
function mkEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], className: '', style: {},
    _attrs: {}, _html: '', textContent: '', title: '', type: '', min: '', max: '', value: '',
    _clsT: {},
    classList: { toggle: function (c, f) { el._clsT[c] = !!f; } },
    setAttribute: function (k, v) { el._attrs[k] = v; },
    getAttribute: function (k) { return el._attrs[k]; },
    appendChild: function (c) { el.children.push(c); return c; },
    addEventListener: function () {},
  };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return el._html; },
    set: function (v) {
      el._html = v;
      el.children = [];
      if (v === '') return;
      // mini-parser: solo necesita las etiquetas con class del mezclador
      var re = /<(div|span|i|button|input)\b[^>]*?class="([^"]*)"[^>]*?>/g, m;
      while ((m = re.exec(v))) {
        var c = mkEl(m[1]);
        c.className = m[2];
        el.children.push(c);
      }
    }
  });
  function matches(n, sel) {
    if (sel[0] === '.') return (' ' + (n.className || '') + ' ').indexOf(' ' + sel.slice(1) + ' ') >= 0;
    const m = /^\[data-dswmx-id="([^"]+)"\]$/.exec(sel);
    if (m) return n._attrs['data-dswmx-id'] === m[1];
    return false;
  }
  el.querySelector = function (sel) {
    let found = null;
    (function walk(n) {
      if (found) return;
      if (matches(n, sel)) { found = n; return; }
      n.children.forEach(walk);
    })(el);
    return found;
  };
  return el;
}
function fakeAn() {
  return {
    fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 128, _lvl: 255,
    getByteTimeDomainData: function (buf) { buf.fill(this._lvl); }
  };
}
const winListeners = {};
const monBtn = mkEl('button');
const mixerBox = mkEl('div');
const G = {
  P: { master: { vol: 0.7, muted: false } },
  els: { mixerrows: mixerBox },
  inited: true,
  audio: {
    ctx: { state: 'running', currentTime: 0, resume: function () {} },
    master: { gain: { value: 0.7 } },
    mon: { gain: { value: 0, _t: null, setTargetAtTime: function (v) { this._t = v; } } },
    masterAn: fakeAn(),
    mic: { vol: 0.8, muted: false, gain: { gain: { value: 0.8 } }, an: fakeAn() },
    nodes: { layer1: { gain: { gain: { value: 0.5 } }, an: fakeAn() } },
    monitorOn: false, dswmxMeters: {}
  }
};
const M = {
  activeScene: function () {
    return { layers: [
      { id: 'layer1', type: 'video', name: 'Clip 1', vol: 0.5, muted: false },
      { id: 'layer2', type: 'image', name: 'Foto', vol: 1, muted: false }
    ] };
  }
};
const sandbox = {
  console: console,
  window: {
    requestAnimationFrame: function () { return 1; },
    addEventListener: function (ev, fn) { winListeners[ev] = fn; },
    performance: { now: function () { return 1000; } },
    DrexStudioWeb: { _state: function () { return G; } }
  },
  document: {
    createElement: mkEl,
    getElementById: function (id) { return id === 'dswmx-monbtn' ? monBtn : null; }
  },
  setInterval: function () { return 7; },
  clearInterval: function () {},
  G: G, M: M,
  t: function (k) { return k; },
  esc: function (s) { return String(s); },
  drexIcon: function (n) { return '<svg data-ic="' + n + '"></svg>'; },
  dswIcon: function (n) { return '<svg data-ic="' + n + '"></svg>'; },
  setRowMute: function () {},
  setRowVol: function () {},
  ensureAudio: function () { return G.audio; },
  Uint8Array: Uint8Array, Math: Math, Object: Object, String: String, Date: Date
};
vm.createContext(sandbox);
try {
  vm.runInContext(jsBlock, sandbox, { filename: 'dswmx-block.js' });
  ok(true, 'M bloque ejecuta en sandbox');
} catch (e) { ok(false, 'M bloque ejecuta en sandbox: ' + (e && e.message)); }

if (sandbox.renderMixer) {
  // M1: strips = mic + layer1(video con audio) + master; layer2 (imagen) no tiene strip
  const strips = sandbox.dswmxCollectStrips();
  eq(strips.length, 2, 'M1 collect: 2 strips (mic + capa con audio)');
  eq(strips.map(s => s.id).join(','), '__mic,layer1', 'M1 ids de strips');
  sandbox.renderMixer();
  eq(mixerBox.children.length, 3, 'M1 render: 3 hijos (2 strips + master)');
  const first = mixerBox.children[0], last = mixerBox.children[2];
  ok(first.className.indexOf('dswmx-strip') >= 0 && first._attrs['data-dswmx-id'] === '__mic', 'M1 primer strip = mic');
  ok(last.className.indexOf('dswmx-master') >= 0, 'M1 último strip = master');
  ok(first.querySelector('.dswmx-fill') && first.querySelector('.dswmx-peak') && first.querySelector('.dswmx-db'), 'M1 strip con vúmetro (fill/peak/db)');
  eq(Object.keys(G.audio.dswmxMeters).length, 3, 'M1 3 medidores registrados');

  // M2: vúmetro real con señal (buf=255 -> pico ~0.99)
  sandbox.dswmxUpdateMeters(0.016, 1000);
  const m0 = G.audio.dswmxMeters.__mic;
  eq(m0.fill.style.width, '100.0%', 'M2 nivel a tope con señal fuerte');
  eq(m0.pk.style.left, '100.0%', 'M2 pico marcado a tope');
  eq(m0.db.textContent, '-0.1', 'M2 dB del pico ≈ -0.1');

  // M3: peak hold — silencio dentro de la ventana de hold mantiene el pico
  G.audio.mic.an._lvl = 128;
  sandbox.dswmxUpdateMeters(0.016, 1500);
  eq(G.audio.dswmxMeters.__mic.fill.style.width, '0.0%', 'M3 nivel cae a 0 en silencio');
  eq(G.audio.dswmxMeters.__mic.db.textContent, '-0.1', 'M3 pico retenido (hold)');

  // M4: tras el hold, el pico decae
  sandbox.dswmxUpdateMeters(0.016, 3000);
  ok(G.audio.dswmxMeters.__mic.db.textContent !== '-0.1', 'M4 pico decae tras el hold (ahora ' + G.audio.dswmxMeters.__mic.db.textContent + ')');

  // M5: dswmxDb casos borde
  eq(sandbox.dswmxDb(0), '-∞', 'M5 dB silencio = -∞');
  eq(sandbox.dswmxDb(1), '0.0', 'M5 dB fondo de escala = 0.0');
  eq(sandbox.dswmxDb(0.0009), '-∞', 'M5 dB por debajo de -60 = -∞');

  // M6: monitoreo
  sandbox.dswmxSetMonitor(true);
  eq(G.audio.monitorOn, true, 'M6 monitorOn = true');
  eq(G.audio.mon.gain._t, 0.8, 'M6 mon.gain -> 0.8 con rampa');
  eq(monBtn._clsT.on, true, 'M6 botón con clase on');
  sandbox.dswmxSetMonitor(false);
  eq(G.audio.mon.gain._t, 0, 'M6 mon.gain -> 0 al apagar');
  eq(monBtn._clsT.on, false, 'M6 botón sin clase on');

  // M7: init por evento + idempotente
  G.audio.mic.an._lvl = 255;
  winListeners['dsw:studio-ready']();
  eq(mixerBox.children.length, 3, 'M7 init por evento re-renderiza');
  sandbox.dswmxInit();
  eq(mixerBox.children.length, 3, 'M7 init idempotente');

  // M8: estado vacío
  G.audio.mic = null; G.audio.nodes = {};
  sandbox.renderMixer();
  eq(mixerBox.children.length, 2, 'M8 sin fuentes: aviso + master');
  eq(mixerBox.children[0].className, 'dswmx-empty', 'M8 aviso de estado vacío');
  eq(mixerBox.children[0].textContent, 'Sin fuentes de audio', 'M8 texto del aviso');
} else {
  ok(false, 'M sandbox expone renderMixer');
}

console.log('\nC239-L1: ' + pass + ' verdes, ' + fail + ' rojos');
process.exit(fail ? 1 : 0);
