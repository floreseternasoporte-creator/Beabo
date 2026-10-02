#!/usr/bin/env node
/* CARRIL 5 — auditoría UI del composer CREAR/PUBLICAR a 390px (2026-10-02).
 * Verificaciones a nivel de fuente sobre index.html (+ drex-i18n.js):
 *  1. Pickers responden: los botones del carrusel (foto/video, cámara, GIF)
 *     y los toggles (votación, contenido fuerte, spoiler) llaman a funciones
 *     globales definidas fuera de IIFEs.
 *  2. Botón Publicar dentro del viewport a 390px: nowrap + la regla
 *     .is-publishing oculta las herramientas del header durante la subida
 *     (el botón con spinner+texto no cabe con los dos iconos visibles).
 *  3. Contador de caracteres: anillo + etiqueta existen, el progreso usa el
 *     índigo del design system (#2F33B8) y se actualiza al escribir.
 *  4. Previews de foto/video: secciones y reproductor existen; las fotos usan
 *     object-contain (sin deformar).
 *  5. Encuesta: 2-4 opciones (tope 4, mínimo 2), duraciones con pt.
 *  6. i18n ES/EN/ZH/PT: sin 'Publicar' hardcodeado en los resets, sin emojis
 *     en los toasts del composer, claves nuevas en drex-i18n.js.
 *  7. Header a 390px: título con truncate y columna central min-w-0.
 * Uso: node tests/test-ui-composer-390.js [ruta-a-index.html]
 * Sale 0 si todo pasa, 1 si algo falla.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.env.COMPOSER_TEST_ROOT || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');
const lines = html.split('\n');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('  FAIL:', name); }
}
function has(re, name) { ok(re.test(html), name); }

// ---- bloques <script> inline: detectar IIFEs ----
const blocks = [];
const reOpen = /^<script(?![^>]*\bsrc=)[^>]*>\s*$/;
for (let i = 0; i < lines.length; i++) {
  if (reOpen.test(lines[i])) {
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].includes('</script>')) { blocks.push([i + 1, j + 1]); break; }
    }
  }
}
function defLine(name) {
  const idx = lines.findIndex(l => new RegExp('function\\s+' + name + '\\s*\\(').test(l));
  return idx === -1 ? -1 : idx + 1;
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
function globalFn(name) {
  const ln = defLine(name);
  ok(ln !== -1, name + ' definida');
  if (ln !== -1) ok(!inIIFE(ln), name + ' fuera de IIFE (alcanzable por onclick)');
}

console.log('== Carril 5: composer crear/publicar a 390px ==');

// ---- 1. pickers responden ----
console.log('-- pickers y toggles');
globalFn('pickNoteMedia');
globalFn('handleNoteMediaSelected');
globalFn('drexCameraOpen');
globalFn('openNoteGifPicker');
globalFn('toggleNotePoll');
globalFn('toggleNoteSensitive');
globalFn('toggleNoteSpoiler');
globalFn('publishNoteFromFullscreen');
globalFn('updateNoteCharCounter');
globalFn('updateCharRing');
has(/id="tool-media"[^>]*onclick="pickNoteMedia\(\)"/, 'botón foto/video llama pickNoteMedia()');
has(/id="tool-camera"[^>]*onclick="drexCameraOpen\(\)"/, 'botón cámara llama drexCameraOpen()');
has(/id="tool-gif"[^>]*onclick="openNoteGifPicker\(\)"/, 'botón GIF llama openNoteGifPicker()');
has(/id="note-media-fullscreen"[^>]*onchange="handleNoteMediaSelected\(event\)"/, 'input de medios -> handleNoteMediaSelected');
has(/onclick="toggleNotePoll\(\)"/, 'toggle Votación en la fila de chips');
has(/onclick="toggleNoteSensitive\(\)"/, 'toggle Contenido fuerte en la fila de chips');
has(/onclick="toggleNoteSpoiler\(\)"/, 'toggle Spoiler en la fila de chips');

// ---- 2. botón Publicar a 390px ----
console.log('-- botón Publicar / estado busy');
has(/id="publish-btn-fullscreen"[^>]*whitespace-nowrap/, 'Publicar no hace wrap (whitespace-nowrap)');
has(/#note-creation-fullscreen\.is-publishing \.composer-hdr-tool\s*\{\s*display:\s*none/, 'is-publishing oculta herramientas del header');
has(/class="composer-hdr-tool[^"]*"\s*\n?\s*[^>]*openDraftsView|openDraftsView\(\)" class="composer-hdr-tool/, 'botón borradores marcado composer-hdr-tool');
ok((html.match(/setNotePublishBusy\(true\)/g) || []).length >= 1, 'busy=true al iniciar publicación');
ok((html.match(/setNotePublishBusy\(false\)/g) || []).length >= 7, 'busy=false en todas las salidas (>=7)');
ok(!/publishBtn\.innerHTML = 'Publicar'/.test(html), "sin resets hardcodeados a 'Publicar'");
ok((html.match(/appT\('Publicar'\)/g) || []).length >= 7, "resets usan appT('Publicar')");

// ---- 3. contador de caracteres ----
console.log('-- contador de caracteres');
has(/id="char-counter-fullscreen"/, 'etiqueta del contador existe');
has(/id="char-ring-progress"/, 'anillo de progreso existe');
has(/id="note-char-counter-wrap"/, 'contenedor del contador existe');
ok(!/stroke = document\.body\.classList\.contains\('theme-dark'\) \? '#8fa2c7' : '#24324c'/.test(html), 'anillo ya no usa #24324c');
has(/'#8fa2c7' : '#2F33B8'/, 'anillo usa índigo #2F33B8 en modo claro');
has(/oninput="updateNoteCharCounter\(\);/, 'textarea actualiza el contador al escribir');

// ---- 4. previews ----
console.log('-- previews foto/video');
has(/id="image-preview-fullscreen"/, 'sección preview de fotos existe');
has(/id="preview-grid-fullscreen"[^>]*grid-cols-2/, 'rejilla de fotos en 2 columnas');
has(/id="video-preview-fullscreen"/, 'sección preview de video existe');
has(/id="video-preview-player"[^>]*max-h-\[320px\]/, 'reproductor con altura máxima acotada');
has(/object-contain bg-black\/5 rounded-lg/, 'fotos con object-contain (sin deformar)');

// ---- 5. encuesta 2-4 opciones ----
console.log('-- encuesta');
has(/\.drex-poll-editor\s*\{/, 'CSS .drex-poll-editor');
has(/\.drex-poll-add\s*\{/, 'CSS .drex-poll-add');
has(/\.drex-poll-dur\s*\{/, 'CSS .drex-poll-dur');
has(/\.note-poll-toggle\s*\{/, 'CSS .note-poll-toggle');
has(/options\.length < 4/, 'tope de 4 opciones');
has(/options\.length > 2/, 'mínimo de 2 opciones');
ok((html.match(/pt: '1 hora'/g) || []).length >= 1, 'duraciones con etiqueta pt');
has(/d\[drexLang\(\)\] \|\| d\.es/, 'duraciones resuelven por idioma (incluye pt)');

// ---- 6. i18n ----
console.log('-- i18n ES/EN/ZH/PT');
ok(!/❌ Error: No puedes/.test(html), 'sin emoji ❌ en toasts del composer');
for (const key of ['Subiendo fotos…', 'Comprimiendo video…', '1 foto seleccionada (máximo {max})',
    '{n} fotos seleccionadas (máximo {max})', 'Video · {d} · {s} (máx. {secs} s y 12 MB)', 'No se pudo guardar']) {
  ok(i18n.indexOf('"' + key + '"') !== -1, 'drex-i18n.js tiene "' + key + '"');
}
ok((i18n.match(/LANE5-COMPOSER/g) || []).length >= 3, 'bloque LANE5-COMPOSER en los 3 diccionarios');
has(/appT\('Subiendo fotos…'\)/, "estado 'Subiendo fotos…' traducido");
has(/appT\('Comprimiendo video…'\)/, "estado 'Comprimiendo video…' traducido");
has(/appT\('GIF seleccionado'\)/, "'GIF seleccionado' traducido");
has(/drexOrbitPhotosMax\(\)/, 'contador de fotos usa el máximo dinámico');
has(/drexOrbitVideoPostMaxSec\(\)/, 'info de video usa la duración máxima dinámica');

// ---- 7. header a 390px ----
console.log('-- header 390px');
has(/id="note-creation-title"[^>]*truncate/, 'título con truncate (no rompe a 2 líneas)');
has(/leading-tight min-w-0 flex-1/, 'columna central flexible con min-w-0');

console.log(`\n${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
