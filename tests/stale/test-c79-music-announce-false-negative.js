/* ================================================================
 * C79-F1: publicar música — un fallo en el ANUNCIO del feed no debe
 * reportarse como "No se pudo publicar" cuando la canción YA quedó
 * guardada.
 *
 * Defecto (base, PoC con BASE_POC=1): en `publishMusic`, el push del
 * anuncio (`communityNotes`) corre DENTRO del mismo try que la subida
 * del audio y el meta. Si ese push auxiliar falla DESPUÉS de que
 * `musicAudio/<trackId>` y `musicTracks/<trackId>` ya se guardaron
 * (metaSaved = true), el catch muestra "No se pudo publicar. Revisa tu
 * conexión e inténtalo de nuevo." — un FALSO NEGATIVO: la canción SÍ
 * está publicada. El usuario reintenta → `push()` reserva una key
 * NUEVA → la misma canción queda DUPLICADA (dos musicTracks, audio
 * subido dos veces) y el reintento fallido consume el límite diario
 * de 2 canciones.
 *
 * Fix: el anuncio es auxiliar (precedente C75): se envuelve en
 * try/catch propio; si falla, el flujo sigue al éxito normal porque la
 * acción primaria (publicar la canción) ya se completó.
 *
 * Extrae la función REAL de ../index.html (sin rutas absolutas ni git).
 * Ejecutar con: node tests/test-c79-music-announce-false-negative.js
 * Con BASE_POC=1 se corre el PoC contra la base sin fix.
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const BASELINE = process.env.BASE_POC === '1';

// publishMusic está asignada: window.publishMusic = async function () {...};
function extractPublishMusic(src) {
  const marker = 'window.publishMusic = async function ()';
  const m = src.indexOf(marker);
  if (m < 0) throw new Error('no encontrada: window.publishMusic');
  let i = src.indexOf('{', m);
  const start = m;
  let depth = 0, str = null, tpl = 0, lineC = false, blockC = false, esc = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (lineC) { if (c === '\n') lineC = false; continue; }
    if (blockC) { if (c === '*' && n === '/') { blockC = false; i++; } continue; }
    if (str) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (str === '`' && c === '$' && n === '{') { tpl++; i++; continue; }
      if (c === str && tpl === 0) { str = null; continue; }
      if (str === '`' && c === '}' && tpl > 0) { tpl--; continue; }
      continue;
    }
    if (c === '/' && n === '/') { lineC = true; i++; continue; }
    if (c === '/' && n === '*') { blockC = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { str = c; tpl = 0; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 2); }
  }
  throw new Error('llaves sin cerrar: publishMusic');
}

const FN_SRC = extractPublishMusic(HTML);

// --- Sandbox: mocks mínimos para correr publishMusic de verdad ---
function makeSandbox(failAnnounce) {
  const toasts = [];
  const writes = {};   // path -> valor (set/update)
  const removed = [];
  const notified = [];
  let pushN = 0;

  function makeRef(p, fixedKey) {
    return {
      key: fixedKey || ('k' + (++pushN)),
      child: (c) => makeRef(p + '/' + c),
      once: (ev) => {
        if (p === 'users/ME') return Promise.resolve({ val: () => ({ username: 'me', profileImage: '' }) });
        if (p === 'users') return Promise.resolve({ val: () => ({}) });
        if (p.startsWith('musicTracks/')) return Promise.resolve({ val: () => null });
        return Promise.resolve({ val: () => null });
      },
      set: (v) => { writes[p] = v; return Promise.resolve(); },
      update: (v) => { Object.keys(v).forEach(k => { writes[p + '/' + k] = v[k]; }); return Promise.resolve(); },
      remove: () => { removed.push(p); return Promise.resolve(); },
      push: () => { const k = 'k' + (++pushN); return makeRef(p + '/' + k, k); },
      pushAsync: (v) => {
        if (failAnnounce && p === 'communityNotes') return Promise.reject(new Error('boom: communityNotes'));
        const k = 'k' + (++pushN);
        writes[p + '/' + k] = v;
        return Promise.resolve({ key: k });
      },
    };
  }
  const elStub = (id) => ({ disabled: false, innerHTML: '', textContent: '',
    value: id === 'music-title' ? 'Mi canción' : (id === 'music-genre' ? 'Pop' : ''),
    classList: { add() {}, remove() {}, toggle() {} } });
  const sandbox = {
    console,
    musicCurrentUid: () => 'ME',
    musicUploading: false,
    MUSIC_CHUNK_CHARS: 1000,
    MUSIC_DAILY_LIMIT: 2,
    MUSIC_GENRES: ['Pop'],
    musicUploadState: {
      audioDataUrl: 'data:audio/mpeg;base64,' + 'A'.repeat(3000),
      editingId: null, artistName: 'Art', coverDataUrl: '', duration: 120, audioFile: null,
    },
    document: { getElementById: (id) => elStub(id) },
    appT: (s) => s,
    showMiniToast: (m) => { toasts.push(m); },
    musicUploadsToday: async () => 0,
    musicSetProgress: () => {},
    closeMusicUpload: () => {}, musicSwitchTab: () => {},
    loadMyMusic: () => {}, loadProfileMusic: () => {}, loadNotes: () => {},
    getActiveMusicProfileUid: () => 'ME',
    addNotification: (u, n) => { notified.push([u, n]); },
    getSpinnerMarkup: () => '',
    musicDb: () => ({ ref: (p) => makeRef(p) }),
    window: {},
    _toasts: toasts, _writes: writes, _removed: removed, _notified: notified,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(FN_SRC + '\nthis.__publishMusic = window.publishMusic;', sandbox, { filename: 'publishMusic.js' });
  return sandbox;
}

async function flush() { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); }

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }
}

(async () => {
  if (BASELINE) {
    // --- PoC del defecto en la base ---
    await test('BASE: el anuncio falla pero el track SÍ quedó guardado (falso negativo)', async () => {
      const sb = makeSandbox(true);
      await vm.runInContext('__publishMusic()', sb);
      await flush();
      const trackWrites = Object.keys(sb._writes).filter(k => k.startsWith('musicTracks/k'));
      const audioWrites = Object.keys(sb._writes).filter(k => k.startsWith('musicAudio/k'));
      assert.ok(trackWrites.length > 0, 'el meta del track debería estar guardado');
      assert.ok(audioWrites.length > 0, 'el audio debería estar guardado');
      const lastToast = sb._toasts[sb._toasts.length - 1] || '';
      assert.ok(/No se pudo publicar/.test(lastToast),
        'la base muestra el falso negativo; toast=' + JSON.stringify(lastToast));
    });
    await test('BASE: el reintento del usuario DUPLICA la canción (nueva key)', async () => {
      const sb = makeSandbox(true);
      await vm.runInContext('__publishMusic()', sb); await flush();
      const tracks1 = Object.keys(sb._writes).filter(k => /^musicTracks\/k\d+$/.test(k));
      await vm.runInContext('__publishMusic()', sb); await flush();
      const tracks2 = Object.keys(sb._writes).filter(k => /^musicTracks\/k\d+$/.test(k));
      assert.ok(tracks2.length > tracks1.length,
        'el reintento crea otro track: ' + tracks1.length + ' -> ' + tracks2.length);
    });
  } else {
    // --- Comportamiento correcto con el fix ---
    await test('anuncio fallido: la canción se publica igual (éxito honesto)', async () => {
      const sb = makeSandbox(true);
      await vm.runInContext('__publishMusic()', sb);
      await flush();
      const trackWrites = Object.keys(sb._writes).filter(k => /^musicTracks\/k\d+$/.test(k));
      assert.ok(trackWrites.length > 0, 'el meta del track debe estar guardado');
      const lastToast = sb._toasts[sb._toasts.length - 1] || '';
      assert.ok(/¡Canción publicada!/.test(lastToast),
        'debe mostrar éxito (la canción SÍ se publicó); toast=' + JSON.stringify(lastToast));
      assert.ok(!/No se pudo publicar/.test(lastToast), 'no debe mostrar el falso negativo');
    });
    await test('anuncio fallido: no se deja announceNoteId colgado ni índices del anuncio', async () => {
      const sb = makeSandbox(true);
      await vm.runInContext('__publishMusic()', sb);
      await flush();
      const trackKey = Object.keys(sb._writes).find(k => /^musicTracks\/k\d+$/.test(k));
      const meta = sb._writes[trackKey];
      assert.ok(!meta.announceNoteId, 'sin anuncio no hay announceNoteId que limpiar al borrar');
    });
    await test('control: anuncio exitoso sigue creando la nota del feed', async () => {
      const sb = makeSandbox(false);
      await vm.runInContext('__publishMusic()', sb);
      await flush();
      const notes = Object.keys(sb._writes).filter(k => k.startsWith('communityNotes/'));
      assert.ok(notes.length > 0, 'debe existir la nota de anuncio en el feed');
      const lastToast = sb._toasts[sb._toasts.length - 1] || '';
      assert.ok(/¡Canción publicada!/.test(lastToast), 'éxito normal; toast=' + JSON.stringify(lastToast));
    });
  }
  console.log(failed ? `\n${failed} FALLO(S), ${passed} ok` : `\n${passed} ok`);
  process.exit(failed ? 1 : 0);
})();
