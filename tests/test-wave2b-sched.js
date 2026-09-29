'use strict';
/*
 * test-wave2b-sched.js — Regresión de los fixes del carril B (wave2), área "Programados".
 * Z1-A: recordatorios solo "Tu en vivo..." para los propios.
 * Z1-B: _drexPendingSchedId se limpia al cerrar el setup.
 * Z1-C: DrexSchedPure.isExpired (ventana de inicio con cota superior).
 * node, sin dependencias externas.
 */
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var ROOT = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var i18n = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');

/* ---- DrexSchedPure extraído del index.html real ---- */
var m = /var DrexSchedPure = \(function \(\) \{[\s\S]*?\}\)\(\);/.exec(html);
assert.ok(m, 'bloque DrexSchedPure no encontrado en index.html');
var tmp = path.join(require('os').tmpdir(), 'drexsched-pure-wave2b.js');
fs.writeFileSync(tmp, m[0] + '\nif (typeof module !== "undefined" && module.exports) { module.exports = DrexSchedPure; }\n');
var P = require(tmp);
assert.strictEqual(typeof P.isExpired, 'function', 'DrexSchedPure.isExpired no exportado');
assert.strictEqual(P.EXPIRE_MS, 60 * 60 * 1000, 'EXPIRE_MS debe ser 60 min');

var T0 = Date.now();

function rec(scheduledAt, status) {
  return { id: 'x', title: 't', scheduledAt: scheduledAt, status: status || 'scheduled', hostUid: 'u1' };
}
function exp(scheduledAt, status) { return P.isExpired(rec(scheduledAt, status), T0); }

/* ---- Z1-C: isExpired ---- */
assert.strictEqual(exp(T0 + 60000), false, 'futuro: no vencido');
assert.strictEqual(exp(T0 - 59 * 60 * 1000), false, '59 min: no vencido');
assert.strictEqual(exp(T0 - 60 * 60 * 1000), false, 'exacto 60 min: no vencido (>)');
assert.strictEqual(exp(T0 - 61 * 60 * 1000), true, '61 min: vencido');
assert.strictEqual(exp(T0 - 24 * 3600 * 1000), true, '1 día: vencido');
assert.strictEqual(exp(T0 - 10 * 3600 * 1000, 'live'), false, 'status live: nunca vencido');
assert.strictEqual(exp(T0 - 10 * 3600 * 1000, 'cancelled'), false, 'status cancelled: nunca vencido');
assert.strictEqual(P.isExpired(null, T0), false, 'null: false');
/* isStartWindow sigue intacta (ventana de inicio = desde 15 min ANTES de la hora) */
assert.strictEqual(P.isStartWindow(rec(T0 + 16 * 60 * 1000), T0), false, '16 min en futuro: fuera de ventana');
assert.strictEqual(P.isStartWindow(rec(T0 + 14 * 60 * 1000), T0), true, '14 min en futuro: en ventana');

/* ---- Z1-C: la tarjeta usa la píldora de vencido y el badge lo excluye ---- */
assert.ok(html.indexOf('drex-sched-expired') >= 0, 'falta píldora .drex-sched-expired');
assert.ok(html.indexOf('var expired = P.isExpired(rec, now);') >= 0, 'schedCardHTML no computa expired');
assert.ok(html.indexOf('!P.isExpired(r, now) && (P.isRemindable(r, now) || P.isStartWindow(r, now))') >= 0,
  'drexSchedUpdateBadge no excluye vencidos');
assert.ok(html.indexOf('P.isExpired(rec, Date.now())') >= 0, 'drexSchedStartNow no bloquea vencidos');

/* ---- Z1-B: el setup limpia el id pendiente al cerrarse ---- */
var closeM = /window\.drexLiveCloseSetup = function \(\) \{[\s\S]*?\n\};/.exec(html);
assert.ok(closeM, 'drexLiveCloseSetup no encontrado');
assert.ok(closeM[0].indexOf('window._drexPendingSchedId = null;') >= 0,
  'drexLiveCloseSetup no limpia _drexPendingSchedId');

/* ---- Z1-A: recordatorio con dueño ---- */
assert.ok(html.indexOf("tt('{n} comienza en vivo pronto')") >= 0, 'falta clave de recordatorio ajeno');
assert.ok(html.indexOf('r.hostUid === myUid') >= 0, 'recordatorio no comprueba dueño');

/* ---- i18n: las 3 claves nuevas en EN/ZH/PT ---- */
var keys = ['"El co-anfitrión salió"', '"{n} comienza en vivo pronto"', '"Programación vencida"'];
keys.forEach(function (k) {
  var n = i18n.split(k).length - 1;
  assert.strictEqual(n, 3, 'clave ' + k + ' aparece ' + n + ' veces (esperaba 3: EN/ZH/PT)');
});
assert.ok(i18n.indexOf('"{n} comienza en vivo pronto":"{n} starts live soon"') >= 0, 'EN ajeno');
assert.ok(i18n.indexOf('"{n} comienza en vivo pronto":"{n} 即将开始直播"') >= 0, 'ZH ajeno');
assert.ok(i18n.indexOf('"{n} comienza en vivo pronto":"{n} começa ao vivo em breve"') >= 0, 'PT ajeno');
assert.ok(i18n.indexOf('"El co-anfitrión salió":"The co-host left"') >= 0, 'EN guestleft');
assert.ok(i18n.indexOf('"Programación vencida":"Schedule expired"') >= 0, 'EN expired');

console.log('VERDE: test-wave2b-sched.js (' + keys.length + ' claves i18n, isExpired, recordatorios, setup, badge, tarjeta)');
