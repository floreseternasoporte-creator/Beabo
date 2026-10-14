// test-c331-img-dims.js — reserva de proporción del shimmer (sin saltos de layout)
//  1. imageDims en la nota -> aspect-ratio exacto
//  2. sin imageDims pero con _noteDimsMem -> usa la memoria
//  3. panorámica extrema (4:1) -> se acota a 2.2
//  4. vertical extrema (1:5) -> se acota a 0.5
//  5. sin datos -> '' (shimmer clásico de 180px)
//  6. measureImageDims con URLs inválidas -> [null, null], nunca rechaza
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const s = html.indexOf('function measureImageDims(urls) {');
assert(s >= 0, 'inicio no encontrado');
const e = html.indexOf('\n  const _noteImagesCache = {};', s);
assert(e >= 0, 'fin no encontrado');
const src = html.slice(s, e);

const sandbox = { setTimeout: () => 0, clearTimeout: () => {}, Promise };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const style = sandbox.noteShimmerAspectStyle;
assert(typeof style === 'function');

(async () => {
  let r = style({ imageDims: [{ w: 1200, h: 800 }] }, 'a');
  assert(r.includes('aspect-ratio:1.500'), 'proporción exacta 3:2, fue: ' + r);
  assert(r.includes('min-height:0') && r.includes('max-height:560px'));

  sandbox._noteDimsMem = {}; // var global reasignable
  r = style({}, 'b');
  assert.strictEqual(r, '', 'sin datos debe devolver vacío');

  sandbox._noteDimsMem['b'] = [{ w: 600, h: 600 }];
  r = style({}, 'b');
  assert(r.includes('aspect-ratio:1.000'), 'debió usar _noteDimsMem, fue: ' + r);

  r = style({ imageDims: [{ w: 4000, h: 1000 }] }, 'c');
  assert(r.includes('aspect-ratio:2.200'), 'panorámica se acota a 2.2, fue: ' + r);

  r = style({ imageDims: [{ w: 200, h: 1000 }] }, 'd');
  assert(r.includes('aspect-ratio:0.500'), 'vertical se acota a 0.5, fue: ' + r);

  r = style({ imageDims: [{ w: 0, h: 0 }] }, 'e');
  assert.strictEqual(r, '', 'dims inválidas -> vacío');

  const dims = await sandbox.measureImageDims(['no-es-url', null]);
  assert.deepStrictEqual(dims, [null, null], 'URLs inválidas -> nulls sin rechazar');

  console.log('test-c331-img-dims OK: proporción reservada verificada');
})().catch(err => { console.error('FALLO:', err); process.exit(1); });
