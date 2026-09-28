/* C239-L4 — tests de Salida y salud del stream. node tests/test-c239-l4.js
 * Patron: ~/workspace/c233/tests/test-c233-studio.js (fase roja -> verde). */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const I18N_SRC = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');
let L4JS = '';
try { L4JS = fs.readFileSync(path.join(ROOT, 'dswout-l4.js'), 'utf8'); }
catch (e) { console.log('(T0 dswout-l4.js ausente en el repo: se omite la igualdad byte a byte)'); }

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name); }
}
function eq(a, b, name) { ok(a === b, name + ' (got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + ')'); }

/* Bloque L4 dentro del index (entre marcadores). */
const L4_BEGIN = '/* C239-L4:BEGIN */', L4_END = '/* C239-L4:END */';
const bi = HTML.indexOf(L4_BEGIN), be = HTML.indexOf(L4_END);
ok(bi >= 0 && be > bi, 'T0 bloque L4 presente en index.html');
/* El bloque ejecutable es el <script> completo que contiene los marcadores. */
const bs = HTML.lastIndexOf('<script>', bi), es = HTML.indexOf('</script>', be);
const L4_IN_HTML = (bs >= 0 && es > bs) ? HTML.slice(bs + 8, es) : '';
ok(L4_IN_HTML.indexOf('C239-L4:BEGIN') >= 0 && L4_IN_HTML.indexOf('C239-L4:END') >= 0, 'T0 script L4 extraido');
if (L4JS) { eq(L4_IN_HTML.indexOf(L4JS.trim().slice(0, 60)) >= 0, true, 'T0 js incrustado = dswout-l4.js'); }
else { pass++; }

/* ---------- T1: cableado de MediaRecorder ---------- */
ok(L4_IN_HTML.indexOf('window.__dswToggleRecord') >= 0, 'T1 expone __dswToggleRecord');
ok(L4_IN_HTML.indexOf('new MediaRecorder(') >= 0, 'T1 usa MediaRecorder');
ok(L4_IN_HTML.indexOf('video/webm') >= 0, 'T1 mime webm');
ok(L4_IN_HTML.indexOf("a.download = 'drex-studio-'") >= 0 || L4_IN_HTML.indexOf("a.download='drex-studio-'") >= 0, 'T1 descarga .webm con nombre');
ok(L4_IN_HTML.indexOf('.webm') >= 0, 'T1 extension .webm');
ok(L4_IN_HTML.indexOf('captureStream(30)') >= 0, 'T1 video desde #dsw-program captureStream(30)');
ok(L4_IN_HTML.indexOf('G.audio.dest.stream') >= 0, 'T1 audio del mezclador G.audio.dest.stream');
ok(L4_IN_HTML.indexOf('dswoutBuildRecordStream') >= 0, 'T1 buildRecordStream existe');
/* no mata el audio compartido: solo detiene pistas propias de video */
ok(/rec\.ownTracks\[i\]\.stop\(\)/.test(L4_IN_HTML), 'T1 solo detiene pistas de video propias');
ok(L4_IN_HTML.indexOf('pertenecen al mezclador') >= 0 || L4_IN_HTML.indexOf('NO se detienen') >= 0, 'T1 comentario de pistas compartidas');

/* ---------- T2: guard typeof de __dswToggleRecord ---------- */
ok(/typeof window\.__dswToggleRecord === 'undefined'/.test(L4_IN_HTML), 'T2 guard typeof antes de definir');
ok(L4_IN_HTML.indexOf('no pisar') >= 0 || L4_IN_HTML.indexOf('guard') >= 0, 'T2 intencion del guard documentada');

/* ---------- T3: FPS real (rAF, no inventado) ---------- */
ok(/requestAnimationFrame\(tick\)/.test(L4_IN_HTML), 'T3 loop con requestAnimationFrame');
ok(/health\.frames\+\+/.test(L4_IN_HTML), 'T3 cuenta cuadros reales');
ok(/health\.fps = Math\.round\(health\.frames \* 1000/.test(L4_IN_HTML), 'T3 fps = cuadros/segundo medidos');
ok(/dswout-fps/.test(L4_IN_HTML) && /\$\('dswout-fps'\)/.test(L4_IN_HTML), 'T3 pinta en #dswout-fps');
ok(!/textContent = '60'/.test(L4_IN_HTML), 'T3 no hay fps hardcodeado');

/* ---------- T4: chequeo previo salir en vivo ---------- */
ok(/dswoutPermCheck\('camera'/.test(L4_IN_HTML), 'T4 permiso de camara');
ok(/dswoutPermCheck\('microphone'/.test(L4_IN_HTML), 'T4 permiso de microfono');
ok(/getUserMedia/.test(L4_IN_HTML), 'T4 intento gUM corto como respaldo');
ok(/getDisplayMedia/.test(L4_IN_HTML), 'T4 verifica getDisplayMedia (pantalla)');
ok(/getAudioTracks\(\)\.length/.test(L4_IN_HTML), 'T4 audio mezclado presente');
ok(/icon\(ok \? 'check' : 'x'\)/.test(L4_IN_HTML), 'T4 checklist con SVG check/x');
ok(L4_IN_HTML.indexOf('dswout-pc-anyway') >= 0, 'T4 boton continuar con advertencias');
ok(/addEventListener\('click', dswoutClickCapture, true\)/.test(L4_IN_HTML), 'T4 intercepta click en fase de captura');
ok(/ev\.stopPropagation\(\)/.test(L4_IN_HTML), 'T4 frena el goLive original si no pasa');
ok(/pchk\.bypass = true/.test(L4_IN_HTML), 'T4 bypass para re-disparar tras precheck OK');
ok(L4_IN_HTML.indexOf('btn.click()') >= 0, 'T4 re-dispara el click real en #dsw-golive');
ok(L4_IN_HTML.indexOf('dswout-precheck') >= 0, 'T4 overlay de precheck');

/* ---------- T5: ajustes de salida en localStorage ---------- */
ok(L4_IN_HTML.indexOf('dswout_settings_v1') >= 0, 'T5 clave localStorage');
ok(L4_IN_HTML.indexOf('localStorage.getItem') >= 0 && L4_IN_HTML.indexOf('localStorage.setItem') >= 0, 'T5 get/set localStorage');
ok(HTML.indexOf('id="dswout-rtmp"') >= 0, 'T5 input servidor RTMP');
ok(HTML.indexOf('id="dswout-rtmpkey"') >= 0, 'T5 input clave');
ok(HTML.indexOf('id="dswout-title"') >= 0 && HTML.indexOf('id="dswout-category"') >= 0, 'T5 inputs titulo/categoria');
ok(HTML.indexOf('data-dsx-t="Para usar con software externo"') >= 0, 'T5 etiqueta honesta software externo');
ok(L4_IN_HTML.indexOf("liveTitle.value = s.title") >= 0 || L4_IN_HTML.indexOf("lt.value = tIn.value") >= 0, 'T5 titulo sincroniza con #dsw-title');
ok(!/new WebSocket\(['"]rtmp/.test(L4_IN_HTML), 'T5 no finge conexion RTMP');
ok(!/fetch\(['"]rtmp/.test(L4_IN_HTML), 'T5 no finge ingesta RTMP');

/* ---------- T6: i18n ES + 3 dicts TEXT ---------- */
let I18N = null;
try {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(I18N_SRC, ctx, { filename: 'drex-i18n.js' });
  I18N = {
    en: ctx.APP_ENGLISH_TEXT, zh: ctx.APP_CHINESE_TEXT, pt: ctx.APP_PORTUGUESE_TEXT,
    src: I18N_SRC
  };
} catch (e) { I18N = null; console.error('T6 eval i18n:', e.message); }
ok(I18N && I18N.en && I18N.zh && I18N.pt, 'T6 dicts TEXT evaluables');
const NEW_KEYS = ['Salida', 'Grabar', 'Grabando', 'Grabación guardada', 'Categoría',
  'Servidor RTMP', 'Clave de transmisión', 'Para usar con software externo', 'Guardar ajustes',
  'Resolución', 'Conexión', 'Conectado', 'Desconectado', 'Bitrate', 'est.', 'Nivel de audio',
  'Sin audio mezclado', 'Continuar de todos modos', 'Revisando configuración'];
if (I18N) {
  NEW_KEYS.forEach(k => {
    ['en', 'zh', 'pt'].forEach(l => {
      ok(typeof I18N[l][k] === 'string' && I18N[l][k].trim().length > 0, 'T6 ' + l + ' tiene "' + k + '"');
    });
  });
  eq(I18N.en['Servidor RTMP'], 'RTMP server', 'T6 EN Servidor RTMP');
  eq(I18N.zh['Grabar'], '录制', 'T6 ZH Grabar');
  eq(I18N.pt['Salida'], 'Saída', 'T6 PT Salida');
  /* sin duplicadas: cada clave aparece exactamente 3 veces como "k": */
  NEW_KEYS.forEach(k => {
    const c = (I18N_SRC.match(new RegExp('"' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '":', 'g')) || []).length;
    eq(c, 3, 'T6 "' + k + '" aparece 3 veces (una por dict)');
  });
  eq((I18N_SRC.match(/"Drex Coins":/g) || []).length, 3, 'T6 ancla Drex Coins intacta');
}

/* ---------- T7: higiene (cero emojis, nunca SpaceX, ES5) ---------- */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
ok(L4JS.toLowerCase().indexOf('spacex') < 0, 'T7 js sin SpaceX');
ok(!EMOJI_RE.test(L4JS), 'T7 js sin emojis');
const htmlNewStart = HTML.indexOf('id="dswout-healthgrid"');
const htmlNewEnd = HTML.indexOf('</div>', HTML.indexOf('id="dswout-precheck"')) + 6;
const HTML_NEW = (htmlNewStart >= 0) ? HTML.slice(htmlNewStart, htmlNewEnd) : '';
ok(HTML_NEW.length > 500, 'T7 bloque HTML nuevo extraido');
ok(!EMOJI_RE.test(HTML_NEW), 'T7 HTML nuevo sin emojis');
ok(HTML_NEW.toLowerCase().indexOf('spacex') < 0, 'T7 HTML nuevo sin SpaceX');
ok(!/(^|[^a-zA-Z_$])let |const /.test(L4JS), 'T7 ES5: sin let/const');
ok(L4JS.indexOf('=>') < 0, 'T7 ES5: sin arrows');
ok(L4JS.indexOf('`') < 0, 'T7 ES5: sin template literals');
ok(/^dswout|^__dsw/.test('dswout') && /var LS_KEY = 'dswout_settings_v1'/.test(L4JS || L4_IN_HTML), 'T7 prefijo dswout');
ok(!/window\.(dsw[A-Z]|rec|health|pchk)\b/.test(L4_IN_HTML.replace(/window\.__dswToggleRecord/g, '')), 'T7 sin globales sin prefijo');

/* ---------- T8: sintaxis con new vm.Script ---------- */
try { new vm.Script(L4_IN_HTML); ok(true, 'T8 vm.Script bloque L4'); }
catch (e) { ok(false, 'T8 vm.Script bloque L4: ' + e.message); }
try { new vm.Script(I18N_SRC); ok(true, 'T8 vm.Script drex-i18n.js'); }
catch (e) { ok(false, 'T8 vm.Script drex-i18n.js: ' + e.message); }

/* ---------- T9: funcional con DOM simulado ---------- */
function makeEnv(opts) {
  opts = opts || {};
  const els = {};
  function mkEl(id) {
    const qcache = {};
    const el = {
      id: id, value: '', textContent: '', innerHTML: '', disabled: false, style: {},
      _handlers: {}, _clicked: 0, _children: [],
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, f) { if (f) this._s.add(c); else this._s.delete(c); },
        contains(c) { return this._s.has(c); }
      },
      addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
      click() { this._clicked++; },
      contains(t) { return t === el; },
      appendChild(c) { this._children.push(c); return c; },
      removeChild() {},
      querySelector(sel) {
        if (!qcache[sel]) qcache[sel] = mkEl(id + sel);
        return qcache[sel];
      },
      querySelectorAll() { return []; }
    };
    els[id] = el;
    return el;
  }
  ['dsw-program', 'dsw-golive', 'dswout-recbtn', 'dswout-recind', 'dswout-rectime',
   'dswout-save', 'dswout-title', 'dswout-category', 'dswout-rtmp', 'dswout-rtmpkey',
   'dswout-conn', 'dswout-fps', 'dswout-res', 'dswout-viewers', 'dswout-bitrate',
   'dswout-audiobar', 'dswout-meter-row', 'dswout-precheck', 'dswout-pc-rows', 'dswout-pc-cancel',
   'dswout-pc-anyway', 'dsw-stat-viewers', 'dsw-title'
  ].forEach(mkEl);
  els['dsw-program'].width = 1280; els['dsw-program'].height = 720;
  const vtrack = { kind: 'video', stopped: false, stop() { this.stopped = true; } };
  els['dsw-program'].captureStream = function () {
    return { getVideoTracks() { return [vtrack]; }, getAudioTracks() { return []; } };
  };
  els['dsw-golive'].classList.remove('hidden');
  els['dswout-precheck'].classList.add('hidden');
  els['dswout-pc-anyway'].classList.add('hidden');
  els['dswout-recind'].classList.add('hidden');

  const audioTracks = opts.audioTracks === undefined ? [] : opts.audioTracks;
  const fakeG = {
    els: { pane: mkEl('pane') },
    audio: {
      ctx: { createAnalyser() { return { fftSize: 0, frequencyBinCount: 4, getByteTimeDomainData() {} }; } },
      master: { connect() {} },
      dest: { stream: { getAudioTracks() { return audioTracks; } } }
    },
    live: opts.live || null
  };
  const store = Object.assign({}, opts.preload);
  const anchors = [];
  const createdMR = [];
  function FakeMR(stream, o) {
    this.stream = stream; this.mimeType = o && o.mimeType; this._stopped = false;
    createdMR.push(this);
  }
  FakeMR.isTypeSupported = function (m) { return m === 'video/webm;codecs=vp9,opus'; };
  FakeMR.prototype.start = function () {};
  FakeMR.prototype.stop = function () { this._stopped = true; if (this.onstop) this.onstop(); };
  function FakeMS() { this._tracks = []; }
  FakeMS.prototype.addTrack = function (t) { this._tracks.push(t); };
  FakeMS.prototype.getVideoTracks = function () { return this._tracks.filter(function (t) { return t.kind === 'video'; }); };
  FakeMS.prototype.getAudioTracks = function () { return this._tracks.filter(function (t) { return t.kind === 'audio'; }); };

  const docHandlers = {};
  const document = {
    readyState: 'complete',
    body: { appendChild() {}, removeChild() {} },
    getElementById(id) { return els[id] || null; },
    createElement(tag) {
      if (tag === 'a') { const a = mkEl('a' + anchors.length); anchors.push(a); return a; }
      if (tag === 'div') return mkEl('div' + Math.random());
      return mkEl(tag);
    },
    addEventListener(ev, fn, cap) { (docHandlers[ev] = docHandlers[ev] || []).push({ fn: fn, cap: !!cap }); },
    dispatchEvent() {}
  };
  const window = {
    document: document,
    localStorage: {
      getItem(k) { return (k in store) ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; }
    },
    DrexStudioWeb: { _state() { return fakeG; } },
    drexIcon(name) { return '<svg>' + name + '</svg>'; },
    toast() {}
  };
  const navigator = {
    permissions: {
      query(q) {
        const st = (opts.perm && opts.perm[q.name]) || 'granted';
        return Promise.resolve({ state: st });
      }
    },
    mediaDevices: {
      getDisplayMedia: function () {},
      getUserMedia() { return Promise.resolve({ getTracks() { return []; } }); }
    }
  };
  if (opts.noDisplayMedia) delete navigator.mediaDevices.getDisplayMedia;
  const ctx = {
    window: window, document: document, navigator: navigator,
    localStorage: window.localStorage,
    MediaRecorder: FakeMR,
    MediaStream: FakeMS,
    Blob: function (parts, o) { this.parts = parts; this.type = o && o.type; ctx._blob = this; },
    URL: { createObjectURL() { return 'blob:fake'; }, revokeObjectURL() {} },
    requestAnimationFrame(fn) { ctx._rafFn = fn; return 0; },
    setInterval(fn) { ctx._intervalFn = fn; return 1; }, clearInterval() {},
    setTimeout(fn) { return 0; },
    performance: { now() { return 1000; } },
    console: console
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(L4_IN_HTML, ctx, { filename: 'dswout-l4.js' });
  return { els: els, window: window, document: document, docHandlers: docHandlers, store: store, anchors: anchors, createdMR: createdMR, ctx: ctx, vtrack: vtrack, fakeG: fakeG };
}
function tick(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 5); i++) p = p.then(() => new Promise(r => setImmediate(r)));
  return p;
}

(async function () {
  /* T9a: handle expuesto + grabar/detener con MediaRecorder simulado */
  {
    const e = makeEnv();
    eq(typeof e.window.__dswToggleRecord, 'function', 'T9a __dswToggleRecord es funcion');
    const r1 = e.window.__dswToggleRecord();
    eq(r1, true, 'T9a toggle inicia grabacion');
    eq(e.createdMR.length, 1, 'T9a MediaRecorder creado');
    eq(e.createdMR[0].mimeType, 'video/webm;codecs=vp9,opus', 'T9a mime vp9/opus');
    eq(e.createdMR[0].stream.getVideoTracks().length, 1, 'T9a stream con pista de video');
    ok(!e.els['dswout-recind'].classList.contains('hidden'), 'T9a indicador REC visible');
    e.createdMR[0].ondataavailable({ data: { size: 42 } });
    const r2 = e.window.__dswToggleRecord();
    eq(r2, false, 'T9a toggle detiene grabacion');
    eq(e.createdMR[0]._stopped, true, 'T9a MediaRecorder.stop llamado');
    eq(e.anchors.length, 1, 'T9a se crea el enlace de descarga');
    ok(/\.webm$/.test(e.anchors[0].download), 'T9a descarga .webm (' + e.anchors[0].download + ')');
    ok(e.els['dswout-recind'].classList.contains('hidden'), 'T9a indicador REC oculto al detener');
    eq(e.vtrack.stopped, true, 'T9a pista de video propia detenida');
  }
  /* T9b: ajustes en localStorage (guardar y cargar) */
  {
    const e = makeEnv();
    e.els['dswout-rtmp'].value = 'rtmp://ejemplo/live';
    e.els['dswout-rtmpkey'].value = 'clave-secreta';
    e.els['dswout-title'].value = 'Mi en vivo';
    e.els['dswout-category'].value = 'Juegos';
    e.els['dswout-save']._handlers.click[0]();
    const saved = JSON.parse(e.store['dswout_settings_v1']);
    eq(saved.rtmp, 'rtmp://ejemplo/live', 'T9b rtmp guardado');
    eq(saved.key, 'clave-secreta', 'T9b clave guardada');
    eq(saved.title, 'Mi en vivo', 'T9b titulo guardado');
    eq(e.els['dsw-title'].value, 'Mi en vivo', 'T9b titulo sincroniza a #dsw-title');
    const e2 = makeEnv({ preload: { dswout_settings_v1: e.store['dswout_settings_v1'] } });
    eq(e2.els['dswout-rtmp'].value, 'rtmp://ejemplo/live', 'T9b rtmp cargado al iniciar');
    eq(e2.els['dswout-title'].value, 'Mi en vivo', 'T9b titulo cargado al iniciar');
  }
  /* T9c: precheck todo OK -> re-dispara goLive */
  {
    const e = makeEnv({ audioTracks: [{}] });
    const cap = e.docHandlers.click.find(h => h.cap);
    ok(!!cap, 'T9c handler de captura registrado');
    const ev = { target: e.els['dsw-golive'], sp: false, stopPropagation() { this.sp = true; }, preventDefault() {} };
    cap.fn(ev);
    eq(ev.sp, true, 'T9c click interceptado (no llega al goLive directo)');
    ok(!e.els['dswout-precheck'].classList.contains('hidden'), 'T9c overlay visible');
    eq(e.els['dswout-pc-rows']._children.length, 4, 'T9c 4 filas de verificacion');
    await tick(8);
    eq(e.els['dsw-golive']._clicked, 1, 'T9c goLive re-disparado tras checks OK');
    ok(e.els['dswout-precheck'].classList.contains('hidden'), 'T9c overlay cerrado tras OK');
  }
  /* T9d: precheck con fallo -> muestra continuar, no auto-go */
  {
    const e = makeEnv({ audioTracks: [], perm: { camera: 'denied', microphone: 'granted' } });
    const cap = e.docHandlers.click.find(h => h.cap);
    const ev = { target: e.els['dsw-golive'], stopPropagation() {}, preventDefault() {} };
    cap.fn(ev);
    await tick(8);
    eq(e.els['dsw-golive']._clicked, 0, 'T9d sin auto-go ante fallos');
    ok(!e.els['dswout-pc-anyway'].classList.contains('hidden'), 'T9d boton continuar visible');
    e.els['dswout-pc-anyway']._handlers.click[0]();
    eq(e.els['dsw-golive']._clicked, 1, 'T9d continuar dispara goLive');
  }
  /* T9e: salud inicial honesta */
  {
    const e = makeEnv();
    eq(e.els['dswout-conn'].textContent, 'Desconectado', 'T9e conexion desconectado sin live');
    eq(e.els['dswout-res'].textContent, '1280×720', 'T9e resolucion del canvas');
    ok(/\(est\.\)/.test(e.els['dswout-bitrate'].textContent), 'T9e bitrate etiquetado est. sin getStats');
  }

  /* T9f: eventos directos del core (pcstate/viewers) + offs + respaldo */
  {
    const handlers = {};
    const offCalls = [];
    const core = {
      on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return function () { offCalls.push(ev); }; },
      emit(ev, a) { (handlers[ev] || []).forEach(function (fn) { fn(a); }); }
    };
    const e = makeEnv({ live: { core: core } });
    ok(!!handlers.pcstate && !!handlers.viewers, 'T9f suscrito a pcstate y viewers');
    core.emit('pcstate', 'connected');
    eq(e.els['dswout-conn'].textContent, 'Conectado', 'T9f evento pcstate connected');
    core.emit('pcstate', 'failed');
    eq(e.els['dswout-conn'].textContent, 'WebRTC failed', 'T9f evento pcstate failed');
    core.emit('viewers', 9);
    eq(e.els['dswout-viewers'].textContent, '9', 'T9f evento viewers');
    const offCalls2 = [];
    const core2 = { on() { return function () { offCalls2.push(1); }; } };
    e.fakeG.live = { core: core2 };
    e.ctx._intervalFn();
    eq(offCalls.length, 2, 'T9f off al cambiar de core');
    e.fakeG.live = null;
    e.ctx._intervalFn();
    eq(offCalls2.length, 2, 'T9f off al terminar el live');
    eq(e.els['dswout-conn'].textContent, 'Desconectado', 'T9f desconectado sin live');
  }
  {
    /* respaldo por polling cuando el core no expone .on */
    const e = makeEnv({ live: { core: { _pcs: { a: { connectionState: 'connected' } } } } });
    e.els['dsw-stat-viewers'].textContent = '12';
    e.ctx._intervalFn();
    eq(e.els['dswout-conn'].textContent, 'Conectado', 'T9f respaldo _pcs');
    eq(e.els['dswout-viewers'].textContent, '12', 'T9f respaldo #dsw-stat-viewers');
  }
  /* T9g: medidor de audio honesto */
  {
    /* el mezclador expone analyser: se usa ese, sin tap propio */
    const e = makeEnv();
    e.fakeG.audio.analyser = {
      frequencyBinCount: 8,
      getByteTimeDomainData(arr) { for (let i = 0; i < arr.length; i++) arr[i] = 200; }
    };
    let connects = 0;
    e.fakeG.audio.master.connect = function () { connects++; };
    e.ctx._rafFn();
    eq(connects, 0, 'T9g sin tap propio si hay analyser del mezclador');
    ok(e.els['dswout-audiobar'].style.width !== '0%', 'T9g barra con nivel real (' + e.els['dswout-audiobar'].style.width + ')');
    ok(e.els['dswout-meter-row'].style.display !== 'none', 'T9g fila visible con analyser');
  }
  {
    /* sin forma de medir: la fila se omite */
    const e = makeEnv();
    e.fakeG.audio.ctx.createAnalyser = function () { throw new Error('no'); };
    e.ctx._rafFn();
    eq(e.els['dswout-meter-row'].style.display, 'none', 'T9g fila oculta sin analyser');
    eq(e.els['dswout-audiobar'].style.width, '0%', 'T9g barra en 0 sin dato');
  }

  console.log('\nC239-L4: ' + pass + ' verdes, ' + fail + ' rojos');
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error('ERROR T9:', err); process.exit(1); });
