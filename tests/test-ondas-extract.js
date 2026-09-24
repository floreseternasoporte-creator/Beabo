'use strict';
// Tests del extractor de Ondas (drexExtractOndas) — Laboratorio de Funciones.
// Uso: node tests/test-ondas-extract.js  (cwd = src/)
// Extrae el módulo ONDAS de ../index.html; si el parche no está aplicado,
// FALLA con salida distinta de cero (verificado contra la base).
process.chdir(__dirname + '/..');
const fs = require('fs');

const START = '// ===== ONDAS (Descubrimiento) v1 — inicio =====';
const END = '// ===== ONDAS (Descubrimiento) v1 — fin =====';
const html = fs.readFileSync('index.html', 'utf8');
const si = html.indexOf(START), ei = html.indexOf(END);
if (si < 0 || ei < 0 || ei <= si) {
  console.error('FAIL modulo ONDAS ausente en index.html: el parche no esta aplicado');
  process.exit(1);
}

// Stub mínimo de localStorage para el init del módulo.
global.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); }
};

const src = html.slice(si, ei);
const M = new Function(src + '\n;return { DREX_ONDA, drexExtractOndas };')();
const { DREX_ONDA, drexExtractOndas } = M;

let fails = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const okc = a === e;
  console.log((okc ? 'OK   ' : 'FAIL ') + label + (okc ? '' : '  esperado=' + e + ' actual=' + a));
  if (!okc) fails++;
}

// 1. Básico + dedup insensible a mayúsculas (orden de primera aparición).
eq(drexExtractOndas('Me encanta #drex y #Drex'), ['drex'], 'dedup case-insensitive');
// 2. Unicode: latín con tilde, CJK, árabe, eñe.
eq(drexExtractOndas('#café #日本語 #العربية #ñoño'), ['café', '日本語', 'العربية', 'ñoño'], 'unicode-aware');
// 3. Longitud mínima 2.
eq(drexExtractOndas('#a #ab #abc'), ['ab', 'abc'], 'min len 2');
// 4. Longitud máxima 48.
const t48 = 't'.repeat(48), t49 = 't'.repeat(49);
eq(drexExtractOndas('#' + t48), [t48], 'max len 48 aceptado');
eq(drexExtractOndas('#' + t49), [], 'len 49 rechazado');
// 5. Duplicados exactos y por caso.
eq(drexExtractOndas('#Hola #hola #HOLA #hola'), ['hola'], 'duplicados colapsan');
// 6. Puntuación no forma parte del tag.
eq(drexExtractOndas('#tag! #otro, (#fin).'), ['tag', 'otro', 'fin'], 'borde con puntuación');
// 7. Sin falsos positivos.
eq(drexExtractOndas('user@dom.com sin tags'), [], 'email no es tag');
eq(drexExtractOndas('# solo almohadilla'), [], '# sola no es tag');
eq(drexExtractOndas('##xx'), ['xx'], 'doble #');
// 8. Entradas no string.
eq(drexExtractOndas(null), [], 'null -> []');
eq(drexExtractOndas(undefined), [], 'undefined -> []');
eq(drexExtractOndas(123), [], 'numero -> []');
eq(drexExtractOndas(''), [], 'vacio -> []');
// 9. Números y guion bajo.
eq(drexExtractOndas('#top10 #mi_tag #_priv'), ['top10', 'mi_tag', '_priv'], 'numeros y underscore');
// 10. Coherencia con renderTextWithMentions: el guion NO es parte del token
//     (#[\p{L}\p{N}_]+), así que '#mi-onda' indexa 'mi' como el enlace.
eq(drexExtractOndas('#mi-onda'), ['mi'], 'guion corta el token (igual que el renderer)');
// 11. Normalización NFC: e + acento combinante == é precompuesto.
// La marca combinante U+0301 no es \p{L}: termina el token igual que en
// renderTextWithMentions. NFC genuino: jamo coreanos -> silaba precompuesta.
eq(drexExtractOndas('#\u1100\u1161\u1100\u1161'), ['\uAC00\uAC00'], 'NFC compone jamo');
// 12. Varios tags mezclados con texto.
eq(drexExtractOndas('Hoy #Día soleado #día #SOL #playa2026!'), ['día', 'sol', 'playa2026'], 'mezcla realista');
// 13. Constantes del módulo (VERSION 2 desde C94: el formato persistido
// incluye cubetas diarias `d` por onda para Tendencias).
eq([DREX_ONDA.MIN_LEN, DREX_ONDA.MAX_LEN, DREX_ONDA.VERSION], [2, 48, 2], 'constantes DREX_ONDA');

console.log(fails === 0 ? 'TODOS OK' : fails + ' FALLOS');
process.exit(fails === 0 ? 0 : 1);
