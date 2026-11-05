/* ================================================================
 * C154 — CANCIONES QUE VOTASTE EN "MIS VOTOS" (Historial).
 *
 * HALLAZGO (hueco real, re-verificado contra el código, candidato del
 * brief C154 — "auditar notificaciones buscando otros eventos silenciosos"
 * no dio ancla: la superficie de avisos está completa): la pestaña "Mis
 * votos" del Historial leía userVotes/<uid> (posts), userPollVotes (C146:
 * encuestas), userCommentVotes + userCommentVotePosts (C149: comentarios),
 * pero los VOTOS A CANCIONES (voteMusicTrack, con su propio índice
 * musicVotes/<uid>/<trackId> = 'up'|'down') no aparecían en ningún lado:
 * el usuario no tenía forma de reencontrar una canción a la que le dio
 * voto positivo, aunque el voto existe y hasta genera notificación al
 * autor (línea 51638). Mismo patrón de redescubrimiento que C146/C149.
 *
 * CAMBIO (index.html):
 *  - drexMergeHistorialMusicVotes(musicVotes): helper puro que filtra los
 *    trackIds con voto 'up'. La clave YA es el trackId, así que no hace
 *    falta ningún índice inverso nuevo (a diferencia de C149).
 *  - loadHistorialLikes: 5ª lectura en paralelo (best-effort) de
 *    musicVotes/<uid>; pinta la sección "Canciones que votaste" DESPUÉS de
 *    la de comentarios (orden garantizado, patrón C149); cada tarjeta lleva
 *    la portada (coverImage, sanitizada por getSafeMediaUrl dentro de
 *    _createHistorialFeedCard), título, artista y 'Voto positivo' +
 *    duración; al tocarla abre la canción en el reproductor
 *    (openMusicTrackFromFeed, con guarda typeof). Los estados vacío/error
 *    quedan intactos. Sin claves i18n nuevas salvo el encabezado
 *    ('Voto positivo' se reutiliza de C149).
 *  - voteMusicTrack: llama a refreshHistorialIfVisible() tras el voto
 *    (igual que votePost/voteInPoll/voteComment) para no dejar "Mis votos"
 *    desactualizado.
 *  - i18n: merge C154 con 'Canciones que votaste' en EN/ZH/PT (patrón de
 *    los merges de Pulso; sin duplicar 'Voto positivo').
 *
 * DEGRADACIÓN DOCUMENTADA: musicVotes es un nodo RTDB EXISTENTE (el
 * cliente ya lo lee/escribe por track en voteMusicTrack); no se agrega
 * ningún nodo nuevo ni índice nuevo, así que no hay superficie de reglas
 * nueva. La lectura es best-effort: si falla, la sección simplemente no se
 * pinta. Los votos hechos ANTES de este cambio SÍ aparecen (el índice ya
 * existía con el trackId como clave — sin backfill necesario).
 *
 * Ejecutar con: node tests/test-c154-music-votes-history.js [--target base.html]
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const _ti = process.argv.indexOf('--target');
const _target = _ti >= 0 && process.argv[_ti + 1] ? path.resolve(process.argv[_ti + 1]) : path.join(ROOT, 'index.html');
const html = fs.readFileSync(_target, 'utf8');

let failures = 0;
function tcase(name, fn) {
  try {
    const ok = (typeof fn === 'function') ? fn() : !!fn;
    console.log((ok ? 'ok - ' : 'NOT OK - ') + name);
    if (!ok) failures++;
  } catch (e) {
    console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
    failures++;
  }
}

// Extrae el cuerpo de `function NAME(...) { ... }` (mismo patrón que
// tests/test-c146-poll-votes-history.js).
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

// Extrae por brace-matching desde un marcador literal (para funciones
// asignadas a window, ej. window.voteMusicTrack = function (voteType) {).
function extractFromMarker(src, marker) {
  const start = src.indexOf(marker);
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

// Extrae los dicts EN/ZH/PT del bloque "// C154: i18n" y los evalúa.
function extractC154I18n(src) {
  const mark = src.indexOf('// C154: i18n');
  if (mark === -1) return null;
  const sec = src.slice(mark, mark + 2000);
  const out = {};
  ['EN', 'ZH', 'PT'].forEach(function (k) {
    const key = 'var ' + k + ' = {';
    const s = sec.indexOf(key);
    if (s === -1) { out[k] = null; return; }
    const open = sec.indexOf('{', s);
    let depth = 0, i = open;
    for (; i < sec.length; i++) {
      if (sec[i] === '{') depth++;
      else if (sec[i] === '}') { depth--; if (depth === 0) break; }
    }
    try { out[k] = new Function('return (' + sec.slice(open, i + 1) + ');')(); }
    catch (e) { out[k] = null; }
  });
  return out;
}

// ---------- A. Aserciones estáticas (hit por hit) ----------
const mergeBody = extractFnBody(html, 'drexMergeHistorialMusicVotes');
tcase('A1 drexMergeHistorialMusicVotes existe (helper puro)', mergeBody !== null);
if (mergeBody) {
  tcase('A2 el merge solo acepta up', mergeBody.indexOf("!== 'up'") !== -1);
  tcase('A3 el merge es null-safe', mergeBody.indexOf('musicVotes || {}') !== -1);
}

const voteMusicBody = extractFromMarker(html, 'window.voteMusicTrack = function (voteType)');
tcase('A4 voteMusicTrack existe', voteMusicBody !== null);
if (voteMusicBody) {
  tcase('A5 voteMusicTrack refresca el historial si está visible',
    voteMusicBody.indexOf('refreshHistorialIfVisible()') !== -1);
  tcase('A6 el refresh lleva guarda typeof (seguro en sandbox)',
    voteMusicBody.indexOf("typeof refreshHistorialIfVisible === 'function'") !== -1);
  tcase('A7 el shape del voto no cambia (set/remove de musicVotes intactos)',
    voteMusicBody.indexOf('userVoteRef.set(newVote)') !== -1 &&
    voteMusicBody.indexOf('userVoteRef.remove()') !== -1);
  tcase('A8 el refresh va DESPUÉS de confirmar el voto (tras _voteWriteP)',
    voteMusicBody.indexOf('refreshHistorialIfVisible()') > voteMusicBody.indexOf('_voteWriteP'));
}

const likesBody = extractFnBody(html, 'loadHistorialLikes');
tcase('A9 loadHistorialLikes existe', likesBody !== null);
if (likesBody) {
  tcase('A10 lee musicVotes/<uid> en paralelo',
    likesBody.indexOf("ref('musicVotes/' + user.uid)") !== -1);
  tcase('A11 la lectura es best-effort con catch',
    likesBody.indexOf("ref('musicVotes/' + user.uid).once('value').catch(() => null)") !== -1);
  tcase('A12 fusiona con drexMergeHistorialMusicVotes',
    likesBody.indexOf('drexMergeHistorialMusicVotes(') !== -1);
  tcase('A13 sección con encabezado traducido',
    likesBody.indexOf("appT('Canciones que votaste')") !== -1);
  tcase('A14 el encabezado usa textContent (sin HTML inyectado)',
    likesBody.indexOf('sec.textContent = appT(') !== -1);
  tcase('A15 el encabezado usa estilo inline determinista (sin Tailwind arbitrary)',
    likesBody.indexOf("sec.setAttribute('style',") !== -1);
  tcase('A16 hidrata cada track de musicTracks/<trackId>',
    likesBody.indexOf("ref('musicTracks/' + tid)") !== -1);
  tcase('A17 conserva el límite de 30 canciones',
    likesBody.indexOf('mVotes.slice(0, 30)') !== -1);
  tcase('A18 la tarjeta abre la canción en el reproductor',
    likesBody.indexOf('openMusicTrackFromFeed(') !== -1);
  tcase('A19 el open del reproductor lleva guarda typeof',
    likesBody.indexOf("typeof openMusicTrackFromFeed === 'function'") !== -1);
  tcase('A20 la tarjeta muestra la portada (coverImage sanitizada por el card)',
    likesBody.indexOf('t.coverImage') !== -1);
  tcase('A21 reutiliza la clave Voto positivo de C149 (sin duplicar)',
    likesBody.indexOf("appT('Voto positivo')") !== -1);
  tcase('A22 estado vacío intacto',
    likesBody.indexOf('Aún no has votado ninguna publicación') !== -1);
  tcase('A23 estado de error intacto',
    likesBody.indexOf('No se pudieron cargar tus votos.') !== -1);
  tcase('A24 la sección de canciones se pinta después de la de comentarios',
    likesBody.lastIndexOf('_c154RenderMusicVotes();') > likesBody.lastIndexOf('_c149RenderCommentVotes();'));
  tcase('A25 no inventa ningún nodo RTDB nuevo (musicVotes ya existía)',
    likesBody.indexOf('musicVotes') !== -1 && likesBody.indexOf('userMusicVotePosts') === -1);
}

// ---------- B. Conductuales: helper puro en sandbox ----------
function loadPure() {
  const sb = {};
  vm.createContext(sb);
  const mb = extractFnBody(html, 'drexMergeHistorialMusicVotes');
  if (!mb) return null;
  vm.runInContext('function drexMergeHistorialMusicVotes(musicVotes) {' + mb + '}', sb);
  return sb;
}
const sb = loadPure();
tcase('B0 helper carga en sandbox', sb !== null);
if (sb) {
  const run = (src, vars) => {
    const c = vm.createContext(Object.assign({}, vars));
    vm.runInContext('function drexMergeHistorialMusicVotes(musicVotes) {' +
      extractFnBody(html, 'drexMergeHistorialMusicVotes') + '}', c);
    return vm.runInContext(src, c);
  };

  tcase('B1 solo deja pasar up (down y ausentes fuera)',
    () => {
      const r = run('drexMergeHistorialMusicVotes({t1:"up", t2:"down", t3:"up", t4:null})', {});
      return r.length === 2 && r.indexOf('t1') !== -1 && r.indexOf('t3') !== -1;
    });
  tcase('B2 devuelve los trackIds tal cual',
    () => {
      const r = run('drexMergeHistorialMusicVotes({abc123:"up"})', {});
      return r.length === 1 && r[0] === 'abc123';
    });
  tcase('B3 inputs nulos -> vacío',
    () => {
      const a = run('drexMergeHistorialMusicVotes(null)', {});
      const b = run('drexMergeHistorialMusicVotes(undefined)', {});
      return Array.isArray(a) && a.length === 0 && Array.isArray(b) && b.length === 0;
    });
  tcase('B4 objeto vacío -> vacío',
    () => {
      const r = run('drexMergeHistorialMusicVotes({})', {});
      return Array.isArray(r) && r.length === 0;
    });
  tcase('B5 claves vacías se saltan',
    () => {
      const r = run('drexMergeHistorialMusicVotes({"":"up", t1:"up"})', {});
      return r.length === 1 && r[0] === 't1';
    });
  tcase('B6 no muta el input',
    () => {
      const c = vm.createContext({ inp: { t1: 'up', t2: 'down' } });
      vm.runInContext('function drexMergeHistorialMusicVotes(musicVotes) {' +
        extractFnBody(html, 'drexMergeHistorialMusicVotes') + '}', c);
      vm.runInContext('drexMergeHistorialMusicVotes(inp)', c);
      const after = vm.runInContext('JSON.stringify(inp)', c);
      return after === '{"t1":"up","t2":"down"}';
    });
}

// ---------- C. i18n del bloque C154 ----------
const i18n = extractC154I18n(html);
tcase('C1 bloque i18n C154 existe con EN/ZH/PT', !!(i18n && i18n.EN && i18n.ZH && i18n.PT));
if (i18n && i18n.EN && i18n.ZH && i18n.PT) {
  tcase('C2 clave "Canciones que votaste" en EN',
    typeof i18n.EN['Canciones que votaste'] === 'string' && i18n.EN['Canciones que votaste'].length > 0);
  tcase('C3 clave "Canciones que votaste" en ZH',
    typeof i18n.ZH['Canciones que votaste'] === 'string' && i18n.ZH['Canciones que votaste'].length > 0);
  tcase('C4 clave "Canciones que votaste" en PT',
    typeof i18n.PT['Canciones que votaste'] === 'string' && i18n.PT['Canciones que votaste'].length > 0);
  tcase('C5 no duplica Voto positivo (se reutiliza la de C149)',
    !('Voto positivo' in i18n.EN) && !('Voto positivo' in i18n.ZH) && !('Voto positivo' in i18n.PT));
  tcase('C6 el merge escribe en los dicts TEXT (no ATTRS)',
    html.indexOf('Object.assign(APP_ENGLISH_TEXT, EN)') !== -1 &&
    html.indexOf('Object.assign(APP_CHINESE_TEXT, ZH)') !== -1 &&
    html.indexOf('Object.assign(APP_PORTUGUESE_TEXT, PT)') !== -1);
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASARON' : '\nFALLARON ' + failures + ' TESTS');
process.exit(failures === 0 ? 0 : 1);
