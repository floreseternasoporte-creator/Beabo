// C104: regresión — cleanup() de transcodeVideoFile debe detener drawTimer,
// MediaRecorder y las pistas en TODOS los caminos (error/timeout), no solo
// en video.onended. Test estático estructural (la función requiere
// MediaRecorder/canvas.captureStream del navegador).
'use strict';
const fs = require('fs');
const path = require('path');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(__dirname, '..', 'index.html');
let html;
try { html = fs.readFileSync(htmlPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer index.html'); process.exit(1); }

// Extraer la función transcodeVideoFile(file, onProgress) por balance de llaves.
function extractFn(src, declLine) {
  const declIdx = src.indexOf(declLine);
  if (declIdx < 0) throw new Error('declaración no encontrada');
  const braceIdx = src.indexOf('{', declIdx);
  let depth = 0;
  for (let i = braceIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(declIdx, i + 1); }
  }
  throw new Error('cierre de función no encontrado');
}

let failures = 0;
function ok(name, cond) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name); }
}

let fn;
try { fn = extractFn(html, 'function transcodeVideoFile(file, onProgress)'); }
catch (e) { console.error('FAIL: ' + e.message); process.exit(1); }

// 1. drawTimer/rec/stream hoisted al alcance de cleanup() (let en el cuerpo
//    de la función, ANTES de video.onloadedmetadata).
const metaIdx = fn.indexOf('video.onloadedmetadata');
const preMeta = fn.slice(0, metaIdx);
ok('drawTimer hoisted (let drawTimer = null) antes de onloadedmetadata',
  /let\s+drawTimer\s*=\s*null/.test(preMeta));
ok('rec hoisted (let rec = null) antes de onloadedmetadata',
  /let\s+rec\s*=\s*null/.test(preMeta));
ok('stream hoisted (let stream = null) antes de onloadedmetadata',
  /let\s+stream\s*=\s*null/.test(preMeta));
ok('sin const drawTimer local dentro de onloadedmetadata',
  !/const\s+drawTimer\s*=/.test(fn));
ok('sin const rec local dentro de onloadedmetadata',
  !/const\s+rec\s*=/.test(fn));

// 2. cleanup() detiene los tres recursos.
const cleanupIdx = fn.indexOf('const cleanup = () =>');
const cleanupBody = fn.slice(cleanupIdx, fn.indexOf('};', cleanupIdx) + 2);
ok('cleanup detiene drawTimer', /clearInterval\s*\(\s*drawTimer\s*\)/.test(cleanupBody));
ok('cleanup detiene MediaRecorder (con guarda de estado)',
  /rec\.state\s*!==\s*['"]inactive['"]/.test(cleanupBody) && /rec\.stop\(\)/.test(cleanupBody));
ok('cleanup detiene las pistas del stream',
  /stream\.getTracks\(\)/.test(cleanupBody) && /t\.stop\(\)/.test(cleanupBody));

console.log(failures === 0 ? 'ALL OK' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
