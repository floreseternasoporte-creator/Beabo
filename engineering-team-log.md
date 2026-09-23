# Bitácora del equipo de ingeniería — Drex

## 2026-09-23 — Rendimiento: Tailwind Play CDN → CSS purgado inline

**Agente:** Rendimiento (Boone) · **Repo:** floreseternasoporte-creator/Beabo · **Rama:** main

### Rebase sobre origin/main e91e349
Entre el inicio del trabajo (base 498182be) y el push, otros agentes publicaron
11 commits (i18n appT, solape onDelta 15s, allowlist emojis fiesta, eliminación
del script muerto de hCaptcha en `<head>`, controles táctiles 44px, limpieza de
rama muerta appT3 en drex-data-export.js). El único cambio en `<head>` fue la
eliminación de 2 líneas de hCaptcha, sin tocar el área de Tailwind; el último
commit solo tocó drex-data-export.js (index.html byte-idéntico). Rebase
mecánico: las 3 ediciones (quitar preconnect, quitar script Play CDN, insertar
CSS purgado antes de `</head>`) se reaplicaron limpiamente sobre la nueva base;
el checker confirma 0 clases sin regla en la base nueva (986 clases en el
bloque, 1818 tokens, 0 dinámicos). Smoke visual re-ejecutado sobre la base
nueva: 1/329160 píxeles (borde antialiased de un botón, imperceptible).

### Cambio
Se eliminó el `<script src="https://cdn.tailwindcss.com/3.4.17">` bloqueante y su
`<link rel="preconnect">`. En su lugar, el `<head>` termina ahora con un bloque
`<style>` con el CSS de Tailwind 3.4.17 purgado y minificado (63,289 bytes),
generado a partir de las clases reales usadas en `index.html` + 7 JS externos.
La app sigue siendo un solo HTML; no se usa `<link>` para Tailwind. El bloque
purgado es el último nodo del `<head>` para conservar el orden de cascada.

### Verificación
- Cobertura build: CSS purgado vs oráculo (Tailwind real sobre candidatos
  extraídos) — **1052/1052 reglas, 0 faltantes**.
- Checker nuevo `tools/check-tailwind-coverage.py`: verifica que cada clase
  usada como clase tenga regla en el bloque purgado y que no haya construcción
  dinámica de clases (`'bg-' + x`). Pasa en el código actual (0 sin regla,
  0 dinámicos); falla ante `bg-fuchsia-987` sintética y ante `'bg-' + x`.
- Smoke visual (Chromium headless, portada sin sesión): **píxel-idéntico**
  (0/329160 píxeles diferentes) contra la base con Play CDN ejecutándose.
- QA: `node --check` 24/24 scripts inline OK; 5 checkers existentes OK;
  `check-page-weight.py` OK; suites JS 10/11 (1 fallo preexistente en
  `test-ondelta-overlap.js`: la API `pushIdTime` no existe en `drex-cloud.js`
  actual — no relacionado con este cambio).
- Sin selectores `.drex-*` generados en el purgado; `cdn.tailwindcss.com`
  eliminado por completo.

### Archivos
- `index.html`, `404.html` (byte-idénticos)
- `tools/check-tailwind-coverage.py` (nuevo)
