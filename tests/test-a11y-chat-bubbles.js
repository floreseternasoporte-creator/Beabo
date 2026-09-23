// Harness de regresión a11y — burbujas del chat operables por teclado
// (cambios R8 de los ciclos recientes + fixes de este lote).
// Verificaciones a nivel de fuente sobre index.html (rápidas, robustas):
//  - la burbuja tiene anillo de foco visible (fix: Tailwind hacía el outline transparente)
//  - el nombre accesible incluye un recorte del mensaje (no solo "Opciones")
//  - la tecla Menú dedicada (ContextMenu) abre el menú, igual que las filas
//  - Shift+F10 documentado vía aria-keyshortcuts
//  - contraste AA del .msg-menu-date
//  - el picker de reacciones recibe role=dialog + nombre (centralizado)
//  - el badge de no-leídos usa role=status
// Uso: node tests/test-a11y-chat-bubbles.js [ruta-a-index.html]
// Sale 0 si todo pasa, 1 si algo falla.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const INDEX = process.argv[2] || path.join(__dirname, '..', 'index.html');
const SRC = fs.readFileSync(INDEX, 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.log('  FALLO - ' + name + ': ' + e.message); }
}
function mustContain(hay, needle, what) {
  assert(hay.indexOf(needle) !== -1, 'no se encontró ' + (what || needle));
}

// --- luminancia relativa / contraste WCAG ---
function lum(hex) {
  const rgb = [1, 3, 5].map(function (i) { return parseInt(hex.slice(i, i + 2), 16) / 255; });
  const lin = rgb.map(function (v) { return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a, b) {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

console.log('== A11y: burbujas del chat y componentes recientes ==');

// 1. Foco visible en la burbuja (div con role=button, tabindex=0).
test('anillo :focus-visible para .msg-bubble[role="button"]', () => {
  mustContain(SRC, '.msg-bubble[role="button"]:focus-visible', 'regla focus-visible');
  mustContain(SRC, '.msg-bubble[role="button"]:focus-visible { outline: none; box-shadow:', 'anillo tipo box-shadow');
});

// 2. Nombre accesible con recorte del mensaje.
test('aria-label de la burbuja incluye el texto del mensaje', () => {
  mustContain(SRC, "_bubbleLbl += ': ' + _snippet", 'etiqueta con snippet');
  mustContain(SRC, "slice(0, 60)", 'recorte acotado a 60 chars');
  mustContain(SRC, "appT('Opciones')", 'reusa la clave i18n Opciones (sin claves nuevas)');
});

// 3. Teclas de apertura del menú del mensaje.
test('keydown de la burbuja: Enter / Espacio / Shift+F10 / ContextMenu', () => {
  const i = SRC.indexOf('const openMsgMenu = (e.key');
  assert(i !== -1, 'no se encontró el guard openMsgMenu de la burbuja');
  const blk = SRC.slice(i, i + 300);
  for (const k of ["e.key === 'Enter'", "e.key === ' '", "e.shiftKey && e.key === 'F10'", "e.key === 'ContextMenu'"]) {
    assert(blk.indexOf(k) !== -1, 'falta tecla: ' + k);
  }
});
test('aria-keyshortcuts="Shift+F10" en la burbuja', () => {
  mustContain(SRC, "bubble.setAttribute('aria-keyshortcuts', 'Shift+F10')", 'aria-keyshortcuts en burbuja');
});

// 4. Contraste AA del .msg-menu-date (12px, necesita 4.5:1).
test('.msg-menu-date con contraste AA sobre blanco', () => {
  const m = SRC.match(/\.msg-menu-date\s*\{\s*color:\s*(#[0-9a-fA-F]{6})/);
  assert(m, 'no se encontró la regla .msg-menu-date');
  const c = contrast(m[1], '#ffffff');
  assert(c >= 4.5, m[1] + ' da ' + c.toFixed(2) + ':1 (< 4.5)');
  assert(SRC.indexOf('.msg-menu-date { color: #8e8e93') === -1, 'el gris viejo 3.26:1 sigue presente');
});

// 5. Picker de reacciones como diálogo nombrado (rol centralizado).
test('chat-reaction-picker con role=dialog + nombre accesible', () => {
  mustContain(SRC, "'chat-reaction-picker': 'Opciones del mensaje'", 'etiqueta en SHEET_LABELS');
  mustContain(SRC, 'function _drexApplySheetsDialogRoles()', 'aplicador centralizado de roles');
  mustContain(SRC, "'chat-reaction-picker',", 'TRAPPABLE incluye el picker (trampa de Tab)');
});

// 6. Badge de no-leídos como live region.
test('badge con role=status en el markup', () => {
  mustContain(SRC, 'id="chat-unread-badge" role="status"', 'badge móvil');
  mustContain(SRC, 'id="chat-unread-badge-desktop" role="status"', 'badge desktop');
});
test('el badge no reescribe el DOM si el conteo no cambió (anti anuncio espurio)', () => {
  mustContain(SRC, 'if (badge.dataset.a11yCount === txt) {', 'guard de dedup del anuncio');
});

console.log(failed === 0 ? `\nRESULTADO: ${passed} ok, 0 fallos` : `\nRESULTADO: ${passed} ok, ${failed} FALLOS`);
process.exit(failed === 0 ? 0 : 1);
