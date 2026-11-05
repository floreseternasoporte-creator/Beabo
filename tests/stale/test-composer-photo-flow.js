#!/usr/bin/env node
/* CARRIL 6 (2026-10-02) — regresión del composer tras la eliminación del en-vivo.
 * Causa raíz del bug "la foto no se selecciona ni se publica": el bloque
 * <script> de Orbit/Pagos es un IIFE y 5 funciones que otros bloques llaman
 * en scope global nunca se exportaron a window -> ReferenceError silencioso
 * y el handler del composer moría sin preview ("nada pasa").
 * Verifica:
 *  1. Los 5 exports a window existen (drexOrbitPhotosMax,
 *     drexOrbitVideoPostMaxSec, drexOrbitCamMaxSec, orbitToast,
 *     openOrbitPaywall).
 *  2. Los handlers del flujo de foto del composer están definidos FUERA de
 *     cualquier IIFE (son globales y los onclick/onchange los alcanzan).
 *  3. Barrido sistemático: ninguna función definida dentro del IIFE de Orbit
 *     es referenciada fuera de él sin estar exportada a window (salvo
 *     nombres globales multi-bloque: t, $, esc, toast).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.env.COMPOSER_TEST_ROOT || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const lines = html.split('\n');
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('  FAIL:', name); }
}

/* ---- 1. Los 5 exports existen ---- */
const EXPORTS = [
  'drexOrbitPhotosMax',
  'drexOrbitVideoPostMaxSec',
  'drexOrbitCamMaxSec',
  'orbitToast',
  'openOrbitPaywall',
];
for (const name of EXPORTS) {
  ok(new RegExp('window\\.' + name + '\\s*=\\s*' + name + '\\s*;').test(html),
     'window.' + name + ' exportado desde el IIFE');
}
// C246 (2026-10-03): openProfile() llamaba mountOrbitVisitorsEntry con
// typeof-guard y el export no existía (el guard fallaba en silencio).
ok(/window\.mountOrbitVisitorsEntry\s*=\s*mountOrbitVisitorsEntry\s*;/.test(html),
   'window.mountOrbitVisitorsEntry exportado desde el IIFE (C246)');

/* ---- 2. Handlers del composer fuera de IIFEs ---- */
// Localiza bloques <script> inline y marca los que son IIFE.
const blocks = [];
const reOpen = /^<script(?![^>]*\bsrc=)[^>]*>\s*$/;
for (let i = 0; i < lines.length; i++) {
  if (reOpen.test(lines[i])) {
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].includes('</script>')) { blocks.push([i + 1, j + 1]); break; }
    }
  }
}
function inIIFE(lineNo) {
  for (const [o, c] of blocks) {
    if (lineNo >= o && lineNo <= c) {
      for (let j = o; j < Math.min(o + 6, c); j++) {
        const t = lines[j].trim();
        if (t.startsWith('(function') || t.startsWith('!function') || t.startsWith('(()')) return true;
      }
      return false;
    }
  }
  return false;
}
const HANDLERS = [
  'pickNoteMedia',
  'handleNoteMediaSelected',
  'handleNoteImagePreviewFullscreen',
  'renderNotePostPhotoPreviews',
  'publishNoteFromFullscreen',
  'drexCameraOpen',
  'drexCameraCapture',
];
for (const name of HANDLERS) {
  const idx = lines.findIndex(l => new RegExp('^\\s*(?:async\\s+)?function\\s+' + name + '\\s*\\(').test(l));
  ok(idx !== -1, name + ' definido en index.html');
  if (idx !== -1) ok(!inIIFE(idx + 1), name + ' es global (fuera de IIFE), línea ' + (idx + 1));
}

/* ---- 3. Barrido sistemático del IIFE de Orbit ---- */
let iife = null;
for (const [o, c] of blocks) {
  for (let j = o; j < Math.min(o + 6, c); j++) {
    const t = lines[j].trim();
    if (t.startsWith('(function')) { iife = [o, c]; break; }
  }
  // el IIFE de Orbit es el grande que contiene ORBIT_PLANS
  if (iife) {
    const txt = lines.slice(iife[0] - 1, iife[1]).join('\n');
    if (!txt.includes('var ORBIT_PLANS')) iife = null;
    else break;
  }
}
ok(!!iife, 'IIFE de Orbit localizado');
if (iife) {
  const [o, c] = iife;
  const blk = lines.slice(o - 1, c).join('\n');
  const rest = lines.slice(0, o - 1).join('\n') + '\n' + lines.slice(c).join('\n');
  const defined = new Set([...blk.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map(m => m[1]));
  const exported = new Set([...blk.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]));
  const GLOBAL_OK = new Set(['t', '$', 'esc', 'toast']);
  // C246 (2026-10-03): FALSO POSITIVO histórico "probe". El probe() del
  // diagnóstico de pagos vive dentro del IIFE y nadie lo llama desde fuera;
  // los hits externos son `const probe = new Audio()` de Música (54383) y
  // un comentario HTML. Una colisión de identificador NO es una función
  // atrapada. Si otro nombre colisiona así, se documenta aquí con prueba.
  const NAME_COLLISIONS = new Set(['probe']);
  let trapped = [];
  for (const name of defined) {
    if (exported.has(name) || GLOBAL_OK.has(name) || NAME_COLLISIONS.has(name)) continue;
    // ¿definido también fuera del IIFE?
    const outDef = new RegExp('^\\s*(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm').test(rest);
    if (outDef) continue;
    if (new RegExp('(?<![\\w$.])' + name + '(?![\\w$])').test(rest)) trapped.push(name);
  }
  ok(trapped.length === 0, 'ninguna función atrapada en el IIFE sin exportar (encontradas: ' + trapped.join(', ') + ')');
}

console.log(`\nComposer photo flow (carril 6): ${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
