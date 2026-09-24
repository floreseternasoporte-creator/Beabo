// C130: inventario de escrituras de red durante la terminación de la página.
//
// Familia NUEVA auditada hit por hit (brief C130). Inventario completo de
// writes que corren en pagehide / beforeunload / visibilitychange-hidden:
//
//  #  Evento                        Qué escribe                              Transporte
//  1  pagehide + vis(hidden)        _drexRecPersistNow → userInterests/<uid>  DrexCloud set (plano, sin keepalive)
//  1b pagehide + vis(hidden)        ProfileStore.flush → userInterestsV2/<uid> DrexCloud set (plano, sin keepalive)
//     (drex-rec-engine.js, motor V2 cargado vía <script defer>; mismo patrón)
//  2  pagehide + vis(hidden)        relFlushErrors → telemetría de errores   navigator.sendBeacon (+ respaldo local)
//  3  beforeunload + vis(hidden)    stopScreenTimeTracking → minutos         localStorage (sin red)
//  4  pagehide                      drexFlushNoteDraftOnPageHide → borrador   localStorage (sin red)
//  5a pagehide + vis(hidden)*       typingRef.onDisconnect().remove()        DrexCloud remove (plano)
//  5b pagehide + vis(hidden)*       fiesta onDisconnect().remove() ×2        DrexCloud remove (plano)
//     * armado bajo demanda por llamada (handle cancelable), no permanente.
//
// Conclusiones de la auditoría (sin PoC de pérdida real → sin cambios, brief C130):
//  - (1) es el único write con pérdida teórica: si el navegador cancela el
//    fetch en pagehide, se pierden ≤15 s de entrenamiento (el mismo persist
//    corre en timer de 15 s y en visibilitychange-hidden, que dispara antes
//    con red plena). Dato best-effort con decay; se auto-repara con el uso.
//  - (2) ya es correcto: sendBeacon sobrevive a pagehide; si falla, el batch
//    vuelve al respaldo local (relWriteErrBuf).
//  - (3)(4) son locales: nada que perder en red.
//  - (5a) se auto-expira: los lectores filtran (now - ts) < 5000.
//  - (5b) deja un miembro fantasma solo en la carrera estrecha "cierre
//    ordenado donde el write de visibilitychange-hidden tampoco completó";
//    el heal loop lo trata como peer caído. Sin PoC determinista posible
//    desde aquí (requeriría cancelar un fetch en pagehide en un navegador
//    real) y sendBeacon no puede transportar el firmado SigV4 del SDK.
//  - El outbox (drex-outbox-v1) cubre SOLO !navigator.onLine (isOffline), no
//    fetches cancelados en vuelo: diseño documentado, no bug.
//  - Cadencia de polling (candidata secundaria): los timers ya son
//    adaptativos (adaptivePollMs por calidad de red), ensurePolling no arranca
//    sin listeners, el heartbeat de sesión se salta cuando hidden, y el flush
//    de errores de 30 s solo corre con cola no vacía. Sin lead medido.
//
// Este test fija el inventario: cualquier write nuevo/movido en caminos de
// terminación rompe el test y obliga a re-auditar la familia.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(__dirname, '..', 'index.html');
const cloudPath = path.join(__dirname, '..', 'drex-cloud.js');
const recPath = path.join(__dirname, '..', 'drex-rec-engine.js');
let html, cloud, rec;
try { html = fs.readFileSync(htmlPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer index.html'); process.exit(1); }
try { cloud = fs.readFileSync(cloudPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer drex-cloud.js'); process.exit(1); }
try { rec = fs.readFileSync(recPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer drex-rec-engine.js'); process.exit(1); }

let failures = 0;
function ok(name, cond) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name); }
}
function tcase(name, fn) {
  try { ok(name, fn()); }
  catch (e) { failures++; console.error('FAIL - ' + name + ' (throw: ' + (e && e.message) + ')'); }
}
function extractFnBody(src, fnName) {
  const start = src.indexOf('function ' + fnName + '(');
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}
function count(re, src) { return (src.match(re) || []).length; }

// ---------- 1. Inventario de listeners de terminación en index.html ----------
ok('index.html: exactamente 2 addEventListener(pagehide)',
  count(/addEventListener\(\s*['"]pagehide['"]/g, html) === 2);
ok('index.html: pagehide -> drexFlushNoteDraftOnPageHide (por nombre)',
  /addEventListener\(\s*['"]pagehide['"]\s*,\s*drexFlushNoteDraftOnPageHide\s*\)/.test(html));
ok('index.html: pagehide -> _drexRecPersistNow (recomendador)',
  /window\.addEventListener\(\s*['"]pagehide['"][\s\S]{0,400}?_drexRecPersistNow\s*\(\s*\)/.test(html));
ok('index.html: visibilitychange hidden -> _drexRecPersistNow',
  /addEventListener\(\s*['"]visibilitychange['"][\s\S]{0,300}?visibilityState\s*===\s*['"]hidden['"][\s\S]{0,300}?_drexRecPersistNow\s*\(\s*\)/.test(html));
ok('index.html: exactamente 1 addEventListener(beforeunload)',
  count(/addEventListener\(\s*['"]beforeunload['"]/g, html) === 1);
ok('index.html: beforeunload -> stopScreenTimeTracking',
  /addEventListener\(\s*['"]beforeunload['"]\s*,\s*stopScreenTimeTracking\s*\)/.test(html));

// ---------- 2. Colector de errores: pagehide vía sendBeacon ----------
ok('drex-cloud.js: 2 addEventListener(pagehide) (flushOnHide + onDisconnect arm)',
  count(/addEventListener\(\s*['"]pagehide['"]/g, cloud) === 2);
ok('drex-cloud.js: pagehide -> flushOnHide (colector de errores)',
  /addEventListener\(\s*['"]pagehide['"]\s*,\s*flushOnHide\s*\)/.test(cloud));
const flushBody = extractFnBody(cloud, 'relFlushErrors');
ok('relFlushErrors existe', flushBody !== null);
if (flushBody) {
  ok('relFlushErrors envía por relBeaconSend (no fetch plano)',
    /relBeaconSend\s*\(\s*url\s*,\s*batch\s*\)/.test(flushBody));
  ok('relFlushErrors: si el beacon falla, el batch vuelve al respaldo local',
    /relWriteErrBuf\s*\(\s*pending\s*\)/.test(flushBody));
}
const beaconBody = extractFnBody(cloud, 'relBeaconSend');
ok('relBeaconSend existe', beaconBody !== null);
if (beaconBody) {
  ok('relBeaconSend usa navigator.sendBeacon (sobrevive a pagehide)',
    /nav\.sendBeacon\s*\(/.test(beaconBody) || /\.sendBeacon\s*\(/.test(beaconBody));
}

// ---------- 3. Recomendador: guardas + cota de ventana de pérdida ----------
const persistBody = extractFnBody(html, '_drexRecPersistNow');
ok('_drexRecPersistNow existe', persistBody !== null);
if (persistBody) {
  ok('_drexRecPersistNow no persiste sin sesión/perfil/uid coincidente',
    /if\s*\(\s*!user\s*\|\|\s*!_drexRecProfile\s*\|\|\s*_drexRecProfileUid\s*!==\s*user\.uid\s*\)/.test(persistBody));
  ok('_drexRecPersistNow escribe userInterests/<uid> vía DrexCloud set',
    /DrexCloud\.database\(\)\.ref\(DREX_REC\.profilePath\s*\+\s*['"]\/['"]\s*\+\s*user\.uid\)\.set\(_drexRecProfile\)/.test(persistBody));
  ok('_drexRecPersistNow traga el fallo de red (best-effort)',
    /\.set\(_drexRecProfile\)\.catch\(\(\)\s*=>\s*\{\}\)/.test(persistBody));
}
const schedBody = extractFnBody(html, 'drexRecScheduleSave');
ok('drexRecScheduleSave existe', schedBody !== null);
if (schedBody) {
  ok('drexRecScheduleSave persiste cada 15 s (cota de pérdida ≤15 s de entrenamiento)',
    /setTimeout\([\s\S]{0,80}?,\s*15000\s*\)/.test(schedBody));
}

// ---------- 3b. Motor V2 (drex-rec-engine.js): ProfileStore.flush en terminación ----------
ok('engine cargado por index.html (<script defer src="drex-rec-engine.js">)',
  /<script[^>]*src=["']drex-rec-engine\.js["']/.test(html));
ok('engine: exactamente 1 addEventListener(pagehide)',
  count(/addEventListener\(\s*['"]pagehide['"]/g, rec) === 1);
ok('engine: pagehide -> ProfileStore.flush()',
  /addEventListener\(\s*['"]pagehide['"]\s*,\s*function\s*\(\s*\)\s*\{\s*ProfileStore\.flush\(\);\s*\}/.test(rec));
ok('engine: visibilitychange hidden -> ProfileStore.flush()',
  /addEventListener\(\s*['"]visibilitychange['"][\s\S]{0,200}?visibilityState\s*===\s*['"]hidden['"][\s\S]{0,80}?ProfileStore\.flush\(\);/.test(rec));
const engFlushBody = extractFnBody(rec, 'flush');
ok('engine ProfileStore.flush existe', engFlushBody !== null);
if (engFlushBody) {
  ok('engine flush cancela el timer y persiste de inmediato',
    /clearTimeout\(_saveTimer\)/.test(engFlushBody) && /_persistNow\s*\(\s*\)/.test(engFlushBody));
}
const engPersistBody = extractFnBody(rec, '_persistNow');
ok('engine _persistNow existe', engPersistBody !== null);
if (engPersistBody) {
  ok('engine _persistNow no persiste sin uid/perfil/uid coincidente',
    /if\s*\(\s*!uid\s*\|\|\s*!_profile\s*\|\|\s*_profileUid\s*!==\s*uid\s*\)/.test(engPersistBody));
  ok('engine _persistNow escribe userInterestsV2/<uid> vía DrexCloud set',
    /db\.ref\(PROFILE_PATH_V2\s*\+\s*['"]\/['"]\s*\+\s*uid\)\.set\(_profile\)/.test(engPersistBody));
  ok('engine _persistNow traga el fallo de red (best-effort)',
    /\.set\(_profile\)\.catch\(function\s*\(\s*\)\s*\{\}\)/.test(engPersistBody));
}
ok('engine PROFILE_PATH_V2 = userInterestsV2 (V1 queda como migración)',
  /var PROFILE_PATH_V2\s*=\s*['"]userInterestsV2['"]/.test(rec));
const engSchedBody = extractFnBody(rec, 'scheduleSave');
ok('engine scheduleSave existe', engSchedBody !== null);
if (engSchedBody) {
  ok('engine scheduleSave persiste cada 15 s (misma cota ≤15 s)',
    /setTimeout\([\s\S]{0,80}?,\s*15000\s*\)/.test(engSchedBody));
}
ok('keepalive: 0 ocurrencias en drex-rec-engine.js', count(/keepalive/g, rec) === 0);

// ---------- 4. Outbox: solo offline, no fetches cancelados en vuelo ----------
const queueBody = extractFnBody(cloud, 'shouldQueue');
ok('Outbox.shouldQueue existe', queueBody !== null);
if (queueBody) {
  ok('Outbox.shouldQueue solo encola sin red (!bypass && isOffline())',
    /!\s*bypass\s*&&\s*isOffline\s*\(\s*\)/.test(queueBody));
}
const offlineBody = extractFnBody(cloud, 'isOffline');
ok('isOffline existe', offlineBody !== null);
if (offlineBody) {
  ok('isOffline = navigator.onLine === false (documentado: no cubre cancelación en pagehide)',
    /navigator\.onLine\s*===\s*false/.test(offlineBody));
}

// ---------- 5. beforeunload y draft: locales, sin red ----------
const stAddBody = extractFnBody(html, '_stAddMinutes');
ok('_stAddMinutes existe', stAddBody !== null);
if (stAddBody) {
  ok('_stAddMinutes escribe solo a localStorage (beforeunload sin red)',
    /localStorage\.setItem/.test(stAddBody) && !/fetch\s*\(|DrexCloud\.database/.test(stAddBody));
}
const draftsBody = extractFnBody(html, 'saveAllNoteDrafts');
ok('saveAllNoteDrafts existe', draftsBody !== null);
if (draftsBody) {
  ok('saveAllNoteDrafts escribe solo a localStorage (pagehide sin red)',
    /localStorage\.setItem/.test(draftsBody) && !/fetch\s*\(|DrexCloud\.database/.test(draftsBody));
}

// ---------- 6. onDisconnect: inventario de armados ----------
const odCalls = html.match(/\w[\w.()]*\.onDisconnect\(\)\.remove\(\)/g) || [];
ok('index.html: exactamente 3 onDisconnect().remove() (typing + fiesta ×2)', odCalls.length === 3);
ok('onDisconnect typing indicator armado', /typingRef\.onDisconnect\(\)\.remove\(\)/.test(html));
ok('onDisconnect membresía fiesta armado (2 sitios)',
  count(/\.onDisconnect\(\)\.remove\(\)/g, html) - (/typingRef\.onDisconnect\(\)\.remove\(\)/.test(html) ? 1 : 0) === 2);
ok('typing: los lectores expiran el indicador a los 5 s (auto-reparación)',
  /\(now\s*-\s*Number\(ts\)\)\s*<\s*5000/.test(html));
ok('onDisconnect arm() registra pagehide + visibilitychange con handle cancelable',
  /function arm\(fn\)[\s\S]{0,900}?addEventListener\(\s*['"]pagehide['"]\s*,\s*handler\s*\)/.test(cloud)
  && /cancel:\s*function\s*\(\s*\)[\s\S]{0,300}?removeEventListener\(\s*['"]pagehide['"]\s*,\s*handler\s*\)/.test(cloud));

// ---------- 7. keepalive: inventario global (solo webhook de música) ----------
ok('keepalive: 1 sola ocurrencia en index.html (webhook Discord de publishMusic)',
  count(/keepalive/g, html) === 1);
ok('keepalive: 0 ocurrencias en drex-cloud.js', count(/keepalive/g, cloud) === 0);

// ---------- 8. Cadencia de polling (candidata secundaria): ya blindada ----------
const ensureBody = extractFnBody(cloud, 'ensurePolling');
ok('ensurePolling existe', ensureBody !== null);
if (ensureBody) {
  ok('ensurePolling no arranca timers sin listeners (sin polling ciego)',
    /if\s*\(\s*!listeners\.length\s*\)\s*return;/.test(ensureBody));
  ok('ensurePolling usa cadencia adaptativa (adaptivePollMs)',
    /currentNormalMs\(\)|currentFastMs\(\)/.test(ensureBody));
}
ok('heartbeat de sesión se salta cuando la pestaña está oculta',
  /hidden\s*=\s*\(typeof document[\s\S]{0,120}?if\s*\(\s*!hidden\s*\)\s*drexSessionsTouch\(false\)/.test(cloud));

// ---------- 9. Conductuales en sandbox ----------
tcase('conductual: _drexRecPersistNow sin sesión no toca la red', () => {
  let dbTouched = false;
  const sb = {
    DrexCloud: {
      auth() { return { currentUser: null }; },
      database() { dbTouched = true; throw new Error('no debe llamarse'); }
    },
    _drexRecProfile: { keywords: {} },
    _drexRecProfileUid: 'u1',
    DREX_REC: { profilePath: 'userInterests' },
    _drexRecTrim(p) { return p; },
    Date, console: { warn() {}, error() {} }
  };
  vm.createContext(sb);
  const r = vm.runInContext('(function(){' + persistBody + '})()', sb);
  return r === undefined && dbTouched === false;
});

tcase('conductual: _drexRecPersistNow con sesión persiste userInterests/<uid>', () => {
  let gotPath = null, gotValue = null, catchSeen = false;
  const sb = {
    DrexCloud: {
      auth() { return { currentUser: { uid: 'u1' } }; },
      database() {
        return { ref(p) { gotPath = p; return { set(v) { gotValue = v; return { catch(cb) { catchSeen = typeof cb === 'function'; } }; } }; } };
      }
    },
    _drexRecProfile: { keywords: { drex: 3 } },
    _drexRecProfileUid: 'u1',
    DREX_REC: { profilePath: 'userInterests' },
    _drexRecTrim(p) { return p; },
    Date, console: { warn() {}, error() {} }
  };
  vm.createContext(sb);
  vm.runInContext('(function(){' + persistBody + '})()', sb);
  return gotPath === 'userInterests/u1'
    && gotValue && typeof gotValue.updatedAt === 'number'
    && gotValue.keywords.drex === 3 && catchSeen === true;
});

tcase('conductual: _drexRecPersistNow con uid distinto no escribe (guarda anti-sesión-cruzada)', () => {
  let setCalled = false;
  const sb = {
    DrexCloud: {
      auth() { return { currentUser: { uid: 'u2' } }; },
      database() { return { ref() { return { set() { setCalled = true; return { catch() {} }; } }; } }; }
    },
    _drexRecProfile: { keywords: {} },
    _drexRecProfileUid: 'u1',
    DREX_REC: { profilePath: 'userInterests' },
    _drexRecTrim(p) { return p; },
    Date, console: { warn() {}, error() {} }
  };
  vm.createContext(sb);
  vm.runInContext('(function(){' + persistBody + '})()', sb);
  return setCalled === false;
});

const flushDraftBody = extractFnBody(html, 'drexFlushNoteDraftOnPageHide');
ok('drexFlushNoteDraftOnPageHide existe', flushDraftBody !== null);
tcase('conductual: pagehide sin composer abierto no guarda nada (no-op)', () => {
  let saved = 0;
  const sb = {
    _noteDraftSaveTimer: { pending: true },
    clearTimeout() {},
    document: { getElementById() { return null; } },
    saveCurrentNoteDraft() { saved++; },
    console: { warn() {}, error() {} }
  };
  vm.createContext(sb);
  vm.runInContext('(function(){' + flushDraftBody + '})()', sb);
  return saved === 0 && sb._noteDraftSaveTimer === null;
});

if (failures) { console.error(failures + ' FAIL(s)'); process.exit(1); }
console.log('C130 termination-writes: todo OK');
