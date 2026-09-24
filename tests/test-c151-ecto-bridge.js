/* ================================================================
 * C151 — AUDITORÍA DE LA SUPERFICIE "ECTO BRIDGE" (eliminación).
 *
 * INVENTARIO (verificado hit por hit contra index.html antes de C151;
 * copia del bloque eliminado en
 * goals/monitoreo-del-repositorio-beabo/hidden_files/c151-ecto-bridge-removed.txt):
 *
 * BLOQUE 1 — "link-click bridge" (~3.4KB, 1 línea):
 *  - Override de window.open: si parent !== window y la URL es http(s),
 *    publica {type:"ecto:usercontent-link-click", href:url} al padre con
 *    target "*" y DEVUELVE NULL (traga la apertura); si no, passthrough.
 *  - Listener document/click en fase de captura: si parent === window
 *    retorna (inerte top-level). Si está iframado: intercepta clicks en
 *    a[href] externos y en elementos [data-href]/[data-url], extrae
 *    productId de atributos data-* (ATTR_NAMES/DATASET_KEYS) y publica
 *    {type:"ecto-artifact-link-click", productId} o
 *    {type:"ecto:usercontent-link-click", href} al padre con target "*",
 *    con e.preventDefault() (el enlace NO se abre).
 *  - Helpers inertes sin el gate: readProductId/extractProductId,
 *    isInlineMediaSlotElement/findInlineMediaSlot/readInlineMediaUrl,
 *    stripHash/urlsMatch, isFirstPartyReelUrl, isInlineMediaUrlClick,
 *    findDataHref.
 *
 * BLOQUE 2 — "focus/close bridge" (~1.3KB, misma línea):
 *  - Listener window/message con gate ÚNICO event.source === window.parent
 *    (SIN chequeo de origin): ante {type:"ecto:artifact-focus-request"}
 *    fuerza window.focus() + body.focus().
 *  - Listener keydown Escape: publica {type:"ecto:artifact-close-request"}
 *    a window.parent con target "*".
 *
 * HALLAZGO: cuando Drex se iframa, el bloque 1 EXFILTRA cada URL externa
 * clicada (y cada window.open programático) al padre con targetOrigin "*":
 * cualquier sitio que embeba la página recibe las URLs que el usuario toca.
 * GitHub Pages no permite cabeceras X-Frame-Options/frame-ancestors (ni
 * meta http-equiv las soporta), así que el anti-framing no es desplegable
 * y el endurecimiento por origin del padre es imposible (el diseño del
 * puente asume padre de origin desconocido).
 *
 * DECISIÓN: ELIMINAR ambos bloques (criterio C142/C148: sin ancla de
 * producto en Drex — son tooling del host de artefactos "ecto", no una
 * función de la app; en producción top-level eran inertes por el gate
 * parent === window, así que la eliminación es neutra en comportamiento).
 * Precedente: el equipo ya los trató como cargo en 2228337 (dedup x4).
 * Este test fija la AUSENCIA: si el pipeline de export los reinyecta, el
 * test rompe y obliga a re-auditar (patrón de umbrales de C148).
 *
 * Ejecutar con: node tests/test-c151-ecto-bridge.js [--target base.html]
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

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

function count(hay, needle) {
  let n = 0, i = 0;
  for (;;) { i = hay.indexOf(needle, i); if (i === -1) return n; n++; i += needle.length; }
}

// ---------- A. Ausencia de los 4 tipos de mensaje del puente ----------
tcase('A1 sin ecto:usercontent-link-click (exfiltración de URLs clicadas)',
  count(html, 'ecto:usercontent-link-click') === 0);
tcase('A2 sin ecto-artifact-link-click',
  count(html, 'ecto-artifact-link-click') === 0);
tcase('A3 sin ecto:artifact-focus-request',
  count(html, 'ecto:artifact-focus-request') === 0);
tcase('A4 sin ecto:artifact-close-request',
  count(html, 'ecto:artifact-close-request') === 0);

// ---------- B. Ausencia de los mecanismos del puente ----------
tcase('B1 sin override de window.open (nativo restaurado)',
  html.indexOf('window.open=function') === -1);
tcase('B2 sin marcadores del bloque link-click (data-clippy-*)',
  html.indexOf('data-clippy-inline-media-slot') === -1 &&
  html.indexOf('data-clippy-inline-media-url') === -1);
tcase('B3 sin constantes del bloque focus/close',
  html.indexOf('FOCUS_TYPE="ecto:artifact-focus-request"') === -1 &&
  html.indexOf('CLOSE_TYPE="ecto:artifact-close-request"') === -1);
tcase('B4 sin helpers de extracción de productId del puente',
  html.indexOf('function extractProductId(') === -1 &&
  html.indexOf('function findDataHref(') === -1);
tcase('B5 cero llamadas postMessage en index.html (el puente era el único emisor)',
  count(html, 'postMessage(') === 0);

// ---------- C. La página sigue estructuralmente sana tras la eliminación ----------
tcase('C1 el comentario que seguía al bloque sigue presente',
  html.indexOf('VISTAS FUSIONADAS: empresa, privacidad, términos, sleep-mode, borrar cuenta') !== -1);
tcase('C2 el único listener message restante es el del service worker (legítimo)',
  count(html, "addEventListener('message'") + count(html, 'addEventListener("message"') === 1 &&
  html.indexOf("navigator.serviceWorker.addEventListener('message'") !== -1);
tcase('C3 los bloques <script> reales abren y cierran en pares: el único <script> sin cierre es un literal dentro de un comentario JS (preexistente, verificado en la base C151)',
  count(html, '<script') === count(html, '</script>') + 1 &&
  html.indexOf('del propio <script>. */') !== -1);

console.log(failures === 0 ? '\nTODOS LOS TESTS PASARON' : '\nFALLARON ' + failures + ' TESTS');
process.exit(failures === 0 ? 0 : 1);
