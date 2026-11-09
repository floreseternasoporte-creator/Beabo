/* Timbres de llamada: los mp3 existen, son pequeños, y index.html los usa con respaldo sintetizado.
   Ejecutar con: node tests/test-ringtone-llamadas.js */
'use strict';
var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('  FAIL ' + n); } }
var html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
['ring-in', 'ring-out'].forEach(function (n) {
  var f = path.join(root, 'assets/audio/' + n + '.mp3');
  var st = fs.existsSync(f) && fs.statSync(f);
  ok(st && st.size > 5000 && st.size < 80000, n + '.mp3 existe y es pequeño (' + (st && st.size) + ' B)');
  ok(html.indexOf('assets/audio/' + n + '.mp3') !== -1, 'index.html referencia ' + n + '.mp3');
  var b = fs.readFileSync(f);
  ok(b[0] === 0x49 && b[1] === 0x44 || b[0] === 0xFF, n + '.mp3 tiene cabecera MP3/ID3');
});
ok(html.indexOf('const DC_RING_SYNTH=') !== -1, 'hay melodía de respaldo sintetizada');
ok(html.indexOf('DC_MOTIF') === -1, 'ya no queda el motivo antiguo');
ok(/function dcStartRing\(incoming\)\{dcStopRing\(\);if\(dcSettings&&dcSettings\.sound===false\)return;/.test(html), 'el ajuste de sonido desactivado sigue silenciando el timbre');
ok(fs.readFileSync(path.join(root, '404.html'), 'utf8') === html, '404.html idéntico a index.html');
console.log('\nRINGTONE: ' + pass + ' ok, ' + fail + ' fallos');
process.exit(fail ? 1 : 0);
