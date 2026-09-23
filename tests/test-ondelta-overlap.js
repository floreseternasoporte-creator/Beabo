// Test determinista: ventana de solape anti clock-skew del delta-sync (onDelta).
// Verifica que:
//  1. pushIdTime decodifica el timestamp embebido en un push ID generado.
//  2. deltaFromSk(minSk) devuelve una cota ~15s por debajo del maximo visto,
//     de modo que una senal con timestamp menor (reloj atrasado) queda
//     DENTRO del rango re-pedido (sk >= cota), en vez de perderse.
//  3. Ante formato anomalo, deltaFromSk devuelve la cota original (fallback seguro).
//  4. pushIdLowerBound/UpperBound acotan correctamente por timestamp.
'use strict';
const path = require('path');
const { __internals: I } = require(path.join(__dirname, '..', 'drex-cloud.js'));

let fails = 0;
function ok(cond, name) {
  if (!cond) { fails++; console.error('FALLA:', name); }
  else console.log('ok:', name);
}

// 1. round-trip timestamp
const id = I.newPushId();
const t = I.pushIdTime(id);
ok(typeof t === 'number' && Math.abs(t - Date.now()) < 5000, 'pushIdTime decodifica ~ahora (' + t + ')');

// 2. escenario clock-skew: A escribe con reloj +10s (dentro de la ventana),
//    B con reloj correcto. El watermark avanza al id de A; la senal de B
//    (timestamp menor) debe quedar DENTRO del rango re-pedido.
function fakePushId(ts) {
  // construye un push ID valido con timestamp ts (sufijo minimo)
  return I.pushIdLowerBound(ts);
}
const now = Date.now();
const idA = fakePushId(now + 10000);   // dispositivo con reloj adelantado 10s
const idB = fakePushId(now);           // dispositivo con reloj correcto
ok(idB < idA, 'orden lexicografico respeta timestamp');
const bound = I.deltaFromSk(idA);      // cota con solape desde el maximo visto
ok(typeof bound === 'string' && bound <= idB,
  'senal atrasada 10s queda dentro del rango (bound <= idB)');
ok(bound < idA, 'la cota con solape es menor que el watermark');

// 2b. sin solape (comportamiento previo) la senal se perderia:
ok(!(idA <= idB), 'sin solape: idB < idA => BETWEEN(idA..) la excluiria (bug original)');

// 2c. limite documentado de la ventana: skew de 60s (>15s) sigue fuera.
const idA60 = fakePushId(now + 60000);
const bound60 = I.deltaFromSk(idA60);
ok(bound60 > idB, 'skew de 60s queda fuera de la ventana de 15s (limite conocido)');

// 3. fallback seguro ante formato anomalo
ok(I.deltaFromSk('corto') === 'corto', 'fallback: clave muy corta');
ok(I.deltaFromSk('!!!!!!!!') === '!!!!!!!!', 'fallback: chars fuera del alfabeto');
ok(I.deltaFromSk(null) === null, 'fallback: null');
ok(I.deltaFromSk(12345) === 12345, 'fallback: no string');

// 4. acotado por timestamp
const lo = I.pushIdLowerBound(now);
const hi = I.pushIdUpperBound(now);
ok(lo < hi, 'lower < upper para el mismo ts');
ok(I.pushIdLowerBound(now - 15000) < lo, 'lower(-15s) < lower(ahora)');
ok(I.pushIdTime(lo) === now || Math.abs(I.pushIdTime(lo) - now) <= 1,
  'pushIdTime(pushIdLowerBound(ts)) ~= ts');

// 5. la ventana es ~15s
const tBound = I.pushIdTime(bound);
ok(Math.abs((now + 10000 - 15000) - tBound) <= 1,
  'ventana de solape = 15s por debajo del maximo (' + tBound + ')');

// 6. DELTA_OVERLAP_MS expuesto
ok(I.DELTA_OVERLAP_MS === 15000, 'DELTA_OVERLAP_MS = 15000');

if (fails) { console.error(fails + ' FALLAS'); process.exit(1); }
console.log('test-ondelta-overlap: TODO OK');
