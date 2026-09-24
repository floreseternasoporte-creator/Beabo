// C72-F1: si el destino del crossfade no carga (track eliminado o red caída),
// el begin ya había movido musicQueueIdx y pintado la UI del destino mientras
// el audio anterior seguía sonando -> desincronización UI/audio (la UI muestra
// una pista que nunca suena). El fix salta ya al siguiente con musicNext(true)
// en vez de dejar el estado a medias, con token anti-stale para no interferir
// con un next/startTrack manual posterior.
// Uso: node tests/test-c72-xfade-abort.js [ruta/index.html]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}

// ---------- Parte A: estática — el fix existe ----------
check('fix C72-F1 presente (var musicXfadeSeq)', /var musicXfadeSeq = 0;/.test(html));
check('helper musicXfadeSkipFailed definido', html.includes('function musicXfadeSkipFailed(mySeq, ni) {'));
check('begin incrementa el token', html.includes('musicXfadeSeq++; // C72-F1: este begin invalida'));
check('cancel incrementa el token', html.includes('musicXfadeSeq++; // C72-F1: invalida los catch'));
check('catch de getAudioUrl deriva al helper', html.includes('}).catch(() => { musicXfadeSkipFailed(mySeq, ni); });'));
check('catch de fadeEl.play deriva al helper', html.includes('fadeEl.play().catch(() => { musicXfadeSkipFailed(mySeq, ni); });'));
check('el catch viejo ya no deja solo musicXfading=false', !html.includes('}).catch(() => { musicXfading = false; });'));

// ---------- Parte B: extractor (misma técnica que los harnesses del ciclo) ----------
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

function makeSandbox() {
  const painted = [], nextCalls = [];
  const fakeAudioEl = {
    _playingId: 'A', src: 'blob:A', volume: 1, paused: false,
    duration: 200, currentTime: 195,
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
    removeAttribute() {},
  };
  const sb = {
    console, setInterval, clearInterval, setTimeout, clearTimeout, Promise,
    musicQueue: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    musicQueueIdx: 0, musicXfading: false, musicXfadeTimerId: null, musicXfadeSeq: 0,
    musicAudioEl: fakeAudioEl, musicFadeEl: null,
    musicEnsureAudio() { return fakeAudioEl; },
    musicEnsureFadeEl() { const f = { pause() {}, removeAttribute() {}, play() { return Promise.resolve(); } }; sb.musicFadeEl = f; return f; },
    musicGetAudioUrl(id) {
      if (id === 'B') return Promise.reject(new Error('sin audio')); // B eliminado
      return Promise.resolve('blob:' + id);
    },
    musicPaintTrackUI(t) { painted.push(t && t.id); },
    musicNext(auto) { nextCalls.push(auto); },
    musicDb() { throw new Error('no debería llamarse'); },
    window: {},
    __painted: painted, __nextCalls: nextCalls, __audioEl: fakeAudioEl,
  };
  sb.window = sb;
  return sb;
}

(async () => {
  // ---------- Parte C: conductual — aborto del crossfade ----------
  const code = extractFn(html, 'musicBeginCrossfade') + '\n'
    + extractFn(html, 'musicCancelCrossfade') + '\n'
    + extractFn(html, 'musicXfadeSkipFailed');
  const sb = makeSandbox();
  vm.createContext(sb);
  vm.runInContext(code, sb, { filename: 'music-xfade.js' });
  vm.runInContext('musicBeginCrossfade(1, 5);', sb);
  await new Promise(r => setTimeout(r, 60));
  await new Promise(r => setTimeout(r, 60));
  check('C1 el aborto fallido llama musicNext(true) (salta el destino)',
    sb.__nextCalls.length === 1 && sb.__nextCalls[0] === true);
  check('C2 el audio anterior no se pausa a la fuerza por el aborto',
    sb.__audioEl.paused === false);

  // ---------- Parte D: guardias anti-stale del helper ----------
  const code2 = extractFn(html, 'musicXfadeSkipFailed') + '\n' + extractFn(html, 'musicCancelCrossfade');
  function guardCtx(seq, idx, xf) {
    const s2 = makeSandbox();
    s2.musicXfadeSeq = seq; s2.musicQueueIdx = idx; s2.musicXfading = xf;
    vm.createContext(s2);
    vm.runInContext(code2, s2);
    return s2;
  }
  let g = guardCtx(7, 1, true);
  vm.runInContext('musicXfadeSkipFailed(7, 1);', g);
  check('D1 token vigente -> avanza', g.__nextCalls.length === 1);
  g = guardCtx(8, 1, true);
  vm.runInContext('musicXfadeSkipFailed(7, 1);', g);
  check('D2 token stale -> no interfiere', g.__nextCalls.length === 0);
  g = guardCtx(7, 2, false);
  vm.runInContext('musicXfadeSkipFailed(7, 1);', g);
  check('D3 idx ya movido -> no interfiere', g.__nextCalls.length === 0);
  g = guardCtx(7, 1, true);
  vm.runInContext('musicCancelCrossfade();', g); // next manual: invalida el catch
  vm.runInContext('musicXfadeSkipFailed(7, 1);', g);
  check('D4 catch tardío tras cancel manual -> sin doble avance', g.__nextCalls.length === 0);

  console.log(failures === 0 ? '\nC72-F1: 13/13 OK' : `\nC72-F1: ${13 - failures}/13 (${failures} FALLIDOS)`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
