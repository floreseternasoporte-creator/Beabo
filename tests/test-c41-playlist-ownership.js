// CICLO 41 (C41-D1) — Gate de propiedad en playlists de música.
//
// PoC del defecto original: la vista de detalle de playlist se abre por
// enlace profundo (ruta musica/lista/:id) con CUALQUIER id, y
// musicRemoveTrackFromPlaylist / musicDeletePlaylist mutaban sin verificar
// que la playlist fuera del usuario actual (musicAddTrackToPlaylist sí lo
// hacía). El fix exige propiedad (falla cerrado) en ambas funciones, guarda
// el uid del dueño en el caché del detalle y vuelve la vista ajena de solo
// lectura (botón eliminar oculto, botón quitar no renderizado).
//
// Convención del repo: resuelve ../index.html con fallback a ../src/index.html;
// no depende del historial de git; sin rutas absolutas.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function findFile(names) {
  const cands = [];
  for (const n of names) {
    cands.push(path.join(__dirname, '..', n));
    cands.push(path.join(__dirname, '..', 'src', n));
  }
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('no encontrado: ' + names.join(' / '));
}
const html = fs.readFileSync(findFile(['index.html']), 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}

// Extrae "window.NAME = async function(...) {...}" balanceando llaves.
function extractWindowFn(name) {
  const anchor = 'window.' + name + ' = ';
  const i = html.indexOf(anchor);
  if (i < 0) throw new Error('no encontrada: ' + name);
  const j = html.indexOf('{', i);
  let depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}') { depth--; if (!depth) return html.slice(i, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}

// ---- 1. Estático: el fix está presente --------------------------------------
const srcRemove = extractWindowFn('musicRemoveTrackFromPlaylist');
const srcDelete = extractWindowFn('musicDeletePlaylist');

check('remove: verifica musicCurrentUid() ANTES de la primera mutación',
  srcRemove.indexOf('musicCurrentUid()') < srcRemove.indexOf('.remove('));
check('remove: falla cerrado si falta el uid del dueño',
  /if\s*\(\s*!d\.uid\s*\|\|\s*d\.uid\s*!==\s*musicCurrentUid\(\)\s*\)/.test(srcRemove));
check('delete: verifica musicCurrentUid() ANTES de la primera mutación',
  srcDelete.indexOf('musicCurrentUid()') < srcDelete.indexOf('.remove('));
check('delete: falla cerrado si falta el uid del dueño',
  /if\s*\(\s*!d\.uid\s*\|\|\s*d\.uid\s*!==\s*musicCurrentUid\(\)\s*\)/.test(srcDelete));
check('detalle: el caché guarda el uid del dueño (pl.uid)',
  html.includes("musicPlaylistDetailCache = { id, name: pl.name || 'Playlist', uid: pl.uid || null, tracks };"));
check('vista: el botón eliminar tiene id para ocultarse en playlists ajenas',
  html.includes('id="music-playlist-delete-btn" onclick="musicDeletePlaylist()"'));
check('vista: musicOpenPlaylist oculta el botón eliminar si no es el dueño',
  html.includes("_plDelBtn.classList.toggle('hidden', !_plMine)"));
check('vista: el botón quitar solo se renderiza si se puede editar',
  html.includes('_plCanEdit') && html.includes('musicRemoveTrackFromPlaylist'));
check('add (patrón de referencia) conserva su verificación de propiedad',
  html.includes('pl.uid !== musicCurrentUid()'));

// ---- 2. Funcional: el gate discrimina dueño vs ajeno -------------------------
function makeSandbox() {
  const calls = { confirm: 0, toast: [], db: [] };
  const sandbox = {
    appT: (s) => s,
    showMiniToast: (m) => calls.toast.push(m),
    confirm: () => { calls.confirm++; return true; },
    musicCurrentUid: () => sandbox.__uid,
    musicPlaylistDetailCache: null,
    musicDb: () => ({
      ref: (p) => ({
        remove: async () => { calls.db.push('remove:' + p); },
        update: async () => { calls.db.push('update:' + p); },
      }),
    }),
    renderPlaylistDetailTracks: () => {},
    loadMusicPlaylists: () => {},
    musicClosePlaylist: () => {},
    document: { getElementById: () => ({ textContent: '' }) },
    __uid: 'attacker-uid',
    __calls: calls,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(srcRemove + '\n' + srcDelete, sandbox);
  return sandbox;
}

(async () => {
  // remove/track: playlist AJENA -> bloqueado (sin confirm, sin DB)
  {
    const sb = makeSandbox();
    sb.musicPlaylistDetailCache = { id: 'pl-victim', uid: 'victim-uid', tracks: [] };
    await sb.window.musicRemoveTrackFromPlaylist('track-1');
    check('remove ajena: bloqueada sin confirm()', sb.__calls.confirm === 0);
    check('remove ajena: sin escrituras a la BD', sb.__calls.db.length === 0);
    check('remove ajena: avisa con toast', sb.__calls.toast.length === 1);
  }
  // remove/track: playlist PROPIA -> permitida (llega a confirm y a la BD)
  {
    const sb = makeSandbox();
    sb.musicPlaylistDetailCache = { id: 'pl-mine', uid: 'attacker-uid', tracks: [{ id: 'track-1' }] };
    await sb.window.musicRemoveTrackFromPlaylist('track-1');
    check('remove propia: pasa el gate (confirm llamado)', sb.__calls.confirm === 1);
    check('remove propia: ejecuta el remove en la BD', sb.__calls.db.some(c => c.startsWith('remove:musicPlaylists/pl-mine/tracks/')));
  }
  // remove/track: uid ausente (legacy) -> falla cerrado
  {
    const sb = makeSandbox();
    sb.musicPlaylistDetailCache = { id: 'pl-legacy', uid: null, tracks: [] };
    await sb.window.musicRemoveTrackFromPlaylist('track-1');
    check('remove sin uid: falla cerrado (sin confirm, sin DB)', sb.__calls.confirm === 0 && sb.__calls.db.length === 0);
  }
  // delete: playlist AJENA -> bloqueada
  {
    const sb = makeSandbox();
    sb.musicPlaylistDetailCache = { id: 'pl-victim', uid: 'victim-uid', tracks: [] };
    await sb.window.musicDeletePlaylist();
    check('delete ajena: bloqueada sin confirm()', sb.__calls.confirm === 0);
    check('delete ajena: sin escrituras a la BD', sb.__calls.db.length === 0);
  }
  // delete: playlist PROPIA -> permitida
  {
    const sb = makeSandbox();
    sb.musicPlaylistDetailCache = { id: 'pl-mine', uid: 'attacker-uid', tracks: [] };
    await sb.window.musicDeletePlaylist();
    check('delete propia: pasa el gate (confirm llamado)', sb.__calls.confirm === 1);
    check('delete propia: ejecuta el remove en la BD', sb.__calls.db.some(c => c === 'remove:musicPlaylists/pl-mine'));
  }

  console.log(failures ? `\n${failures} FALLAS` : '\nTODOS OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e && e.message); process.exit(1); });
