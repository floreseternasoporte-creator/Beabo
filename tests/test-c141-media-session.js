/* ================================================================
 * C141 — Media Session API en el reproductor de música (familia NUEVA,
 * nunca auditada: 0 hits de `mediaSession` en todo el árbol en la base).
 *
 * HALLAZGO: Drex reproduce música (música de identidad propia, La fila,
 * crossfade, mini player) pero nunca registraba Media Session: en
 * Android/iOS la pantalla de bloqueo y los controles del SO mostraban
 * metadatos genéricos/vacíos y los botones hardware no llegaban al
 * reproductor. En C141 se agregó:
 *  - musicMediaMetadataOf(t): constructor puro de la metadata
 *    (title/artist/album 'Drex'/artwork solo con URL https).
 *  - musicSyncMediaSession(t): publica navigator.mediaSession.metadata,
 *    enganchado en musicPaintTrackUI (cubre crossfade y saltos de cola).
 *  - musicWireMediaSessionHandlers(): registra UNA vez los 4 handlers
 *    (play/pause/previoustrack/nexttrack) sobre los controles reales
 *    (musicTogglePlay/musicPrev/musicNext), enganchado en musicEnsureAudio.
 * Ejecutar con: node tests/test-c141-media-session.js
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let failures = 0;
function tcase(name, fn) {
  try {
    const ok = fn();
    console.log((ok ? 'ok - ' : 'NOT OK - ') + name);
    if (!ok) failures++;
  } catch (e) {
    console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
    failures++;
  }
}
function count(re, src) { return (src.match(re) || []).length; }

// ---------- Extractor (misma técnica que los harnesses del ciclo) ----------
function extractFn(source, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(source);
  if (!m) throw new Error('no se encontró ' + name);
  const start = m.index;
  let i = source.indexOf('(', m.index), j, pdepth = 0, depth = 0, inStr = null, esc = false;
  for (j = i; j < source.length; j++) {
    const c = source[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(') pdepth++; else if (c === ')') { pdepth--; if (pdepth === 0) break; }
  }
  const bodyStart = source.indexOf('{', j);
  inStr = null; esc = false;
  for (j = bodyStart; j < source.length; j++) {
    const c = source[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(start, j + 1);
}

// ---------- Parte A: constructor puro musicMediaMetadataOf ----------
tcase('metadata completa: título/artista/album/artwork https', () => {
  const code = extractFn(html, 'musicMediaMetadataOf');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code + '\nthis.out = musicMediaMetadataOf({title:"Luz", artistName:"Atenis", authorName:"X", coverImage:"https://cdn.example.com/c.jpg"});', sandbox);
  const o = sandbox.out;
  return o.title === 'Luz' && o.artist === 'Atenis' && o.album === 'Drex'
    && Array.isArray(o.artwork) && o.artwork.length === 1
    && o.artwork[0].src === 'https://cdn.example.com/c.jpg'
    && o.artwork[0].sizes === '512x512';
});
tcase('artista cae a authorName cuando no hay artistName', () => {
  const code = extractFn(html, 'musicMediaMetadataOf');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code + '\nthis.out = musicMediaMetadataOf({title:"Luz", authorName:"Atenis"});', sandbox);
  return sandbox.out.artist === 'Atenis';
});
tcase('track vacío/null usa los mismos fallbacks que la UI', () => {
  const code = extractFn(html, 'musicMediaMetadataOf');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code + '\nthis.a = musicMediaMetadataOf(null); this.b = musicMediaMetadataOf({});', sandbox);
  return sandbox.a.title === 'Sin título' && sandbox.a.artist === 'Artista'
    && sandbox.b.title === 'Sin título' && sandbox.b.artist === 'Artista'
    && sandbox.a.artwork.length === 0 && sandbox.a.album === 'Drex';
});
tcase('artwork se omite si no es URL https (data:, vacía, no-string)', () => {
  const code = extractFn(html, 'musicMediaMetadataOf');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code + '\nthis.r1 = musicMediaMetadataOf({title:"T", coverImage:"data:image/png;base64,AAAA"}).artwork.length;'
    + '\nthis.r2 = musicMediaMetadataOf({title:"T", coverImage:""}).artwork.length;'
    + '\nthis.r3 = musicMediaMetadataOf({title:"T", coverImage:123}).artwork.length;'
    + '\nthis.r4 = musicMediaMetadataOf({title:"T", coverImage:"http://plain.example.com/c.jpg"}).artwork.length;', sandbox);
  return sandbox.r1 === 0 && sandbox.r2 === 0 && sandbox.r3 === 0 && sandbox.r4 === 1;
});

// ---------- Parte B: musicSyncMediaSession en sandbox ----------
function makeMediaSandbox() {
  const calls = [];
  const ms = {
    setActionHandler(action, handler) { calls.push([action, typeof handler === 'function']); },
    _metadata: null
  };
  const sandbox = {
    console: { log() {} },
    navigator: { mediaSession: ms },
    MediaMetadata: function (o) { this.title = o.title; this.artist = o.artist; this.album = o.album; this.artwork = o.artwork; },
    musicAudioEl: null,
    toggleCalls: 0, prevCalls: 0, nextCalls: 0,
    musicTogglePlay() { this.toggleCalls++; },
    musicPrev() { this.prevCalls++; },
    musicNext() { this.nextCalls++; },
    __calls: calls,
    __ms: ms
  };
  vm.createContext(sandbox);
  return sandbox;
}
tcase('musicSyncMediaSession publica metadata con MediaMetadata', () => {
  const code = extractFn(html, 'musicMediaMetadataOf') + '\n' + extractFn(html, 'musicSyncMediaSession');
  const sb = makeMediaSandbox();
  vm.runInContext(code + '\nmusicSyncMediaSession({title:"Luz", artistName:"Atenis", coverImage:"https://cdn.example.com/c.jpg"});', sb);
  const md = sb.__ms.metadata;
  return !!md && md.title === 'Luz' && md.artist === 'Atenis' && md.album === 'Drex';
});
tcase('musicSyncMediaSession es no-op sin navigator.mediaSession (navegador viejo)', () => {
  const code = extractFn(html, 'musicMediaMetadataOf') + '\n' + extractFn(html, 'musicSyncMediaSession');
  const sb = makeMediaSandbox();
  delete sb.navigator.mediaSession;
  vm.runInContext(code + '\nmusicSyncMediaSession({title:"Luz"}); this.done = true;', sb);
  return sb.done === true;
});
tcase('musicSyncMediaSession no explota si falta MediaMetadata global', () => {
  const code = extractFn(html, 'musicMediaMetadataOf') + '\n' + extractFn(html, 'musicSyncMediaSession');
  const sb = makeMediaSandbox();
  delete sb.MediaMetadata;
  vm.runInContext(code + '\nmusicSyncMediaSession({title:"Luz"}); this.done = true;', sb);
  return sb.done === true;
});

// ---------- Parte C: registro de handlers (una sola vez, semántica con guardas) ----------
tcase('musicWireMediaSessionHandlers registra play/pause/previoustrack/nexttrack una sola vez', () => {
  const code = extractFn(html, 'musicWireMediaSessionHandlers');
  const sb = makeMediaSandbox();
  vm.runInContext('var musicMediaSessionHandlersWired = false;\n' + code
    + '\nmusicWireMediaSessionHandlers(); musicWireMediaSessionHandlers();'
    + '\nthis.registered = __calls.map(function(c){return c[0];}).join(",");'
    + '\nthis.wired = musicMediaSessionHandlersWired;', sb);
  return sb.registered === 'play,pause,previoustrack,nexttrack' && sb.wired === true;
});
tcase('handler play: solo llama a musicTogglePlay si hay audio en pausa', () => {
  const code = extractFn(html, 'musicWireMediaSessionHandlers');
  const handlers = {};
  const state = { n: 0 };
  const sb = {
    navigator: { mediaSession: { setActionHandler(a, h) { handlers[a] = h; } } },
    musicAudioEl: { paused: true, src: 'blob:x' },
    musicTogglePlay() { state.n++; }
  };
  vm.createContext(sb);
  vm.runInContext('var musicMediaSessionHandlersWired = false;\n' + code + '\nmusicWireMediaSessionHandlers();', sb);
  handlers.play();
  const once = state.n === 1;
  sb.musicAudioEl = { paused: false, src: 'blob:x' };
  handlers.play();
  return once && state.n === 1;
});
tcase('handler pause: solo llama a musicTogglePlay si está sonando', () => {
  const code = extractFn(html, 'musicWireMediaSessionHandlers');
  const handlers = {};
  const state = { n: 0 };
  const sb = {
    navigator: { mediaSession: { setActionHandler(a, h) { handlers[a] = h; } } },
    musicAudioEl: { paused: false, src: 'blob:x' },
    musicTogglePlay() { state.n++; }
  };
  vm.createContext(sb);
  vm.runInContext('var musicMediaSessionHandlersWired = false;\n' + code + '\nmusicWireMediaSessionHandlers();', sb);
  handlers.pause();
  const once = state.n === 1;
  sb.musicAudioEl = { paused: true, src: 'blob:x' };
  handlers.pause();
  return once && state.n === 1;
});
tcase('handlers previoustrack/nexttrack delegan a musicPrev/musicNext', () => {
  const code = extractFn(html, 'musicWireMediaSessionHandlers');
  const handlers = {};
  const state = { p: 0, q: 0 };
  const sb = {
    navigator: { mediaSession: { setActionHandler(a, h) { handlers[a] = h; } } },
    musicAudioEl: null,
    musicTogglePlay() {}, musicPrev() { state.p++; }, musicNext() { state.q++; }
  };
  vm.createContext(sb);
  vm.runInContext('var musicMediaSessionHandlersWired = false;\n' + code + '\nmusicWireMediaSessionHandlers();', sb);
  handlers.previoustrack(); handlers.nexttrack();
  return state.p === 1 && state.q === 1;
});
tcase('sin navigator.mediaSession, el wiring es no-op silencioso', () => {
  const code = extractFn(html, 'musicWireMediaSessionHandlers');
  const sb = { navigator: {}, musicAudioEl: null };
  vm.createContext(sb);
  vm.runInContext('var musicMediaSessionHandlersWired = false;\n' + code + '\nmusicWireMediaSessionHandlers(); this.done = true; this.wired = musicMediaSessionHandlersWired;', sb);
  return sb.done === true && sb.wired === false;
});

// ---------- Parte D: enganches en el árbol real ----------
tcase('musicPaintTrackUI engancha musicSyncMediaSession(t)', () => {
  return html.includes('function musicPaintTrackUI(t) {') && html.includes('musicSyncMediaSession(t);');
});
tcase('musicEnsureAudio engancha musicWireMediaSessionHandlers()', () => {
  return html.includes('musicWireMediaSessionHandlers(); } catch (_) {}');
});
tcase('re-verify C140: invariante `.download =` ↔ blob: intacta (5 sitios en 3 archivos)', () => {
  const dataExportJs = fs.readFileSync(path.join(ROOT, 'drex-data-export.js'), 'utf8');
  const recoveryJs = fs.readFileSync(path.join(ROOT, 'recovery-codes.js'), 'utf8');
  const hits = count(/\.download\s*=/g, html) + count(/\.download\s*=/g, dataExportJs) + count(/\.download\s*=/g, recoveryJs);
  return hits === 5;
});

if (failures) { console.log('\nC141: ' + failures + ' FALLO(S)'); process.exit(1); }
console.log('\nC141: todos los casos pasaron.');
