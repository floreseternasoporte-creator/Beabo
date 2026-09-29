'use strict';
/*
 * test-wave2b-guestleft.js — Regresión de los fixes del carril B (wave2):
 * Z2-C: el core emite 'guestleft' cuando un co-anfitrión se va.
 * Z2-A: la grabación usa el mime real (blob + extensión).
 * Z2-B: cleanupLiveUI detiene el video del programa.
 * node, sin dependencias externas. El core se extrae de index.html.
 */
var fs = require('fs');
var path = require('path');
var os = require('os');
var assert = require('assert');

var ROOT = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ---- core extraído del index.html real ---- */
var m = /<script>\s*\/\* drexlive-core\.js — Núcleo DrexLive \(C232\)\.[\s\S]*?<\/script>/.exec(html);
assert.ok(m, 'bloque drexlive-core no encontrado en index.html');
var tmp = path.join(os.tmpdir(), 'drexlive-core-wave2b.js');
fs.writeFileSync(tmp, m[0].replace(/^<script>/, '').replace(/<\/script>$/, ''));
var DrexLiveCore = require(tmp);
assert.strictEqual(typeof DrexLiveCore, 'function', 'el core no exporta factory');

function fakePC() { return { closed: false, close: function () { this.closed = true; } }; }
function newCore() { return new DrexLiveCore({ db: {} }); }

/* ---- Z2-C: 'guestleft' se emite al soltar un co-anfitrión conocido ---- */
(function () {
  var core = newCore();
  var evts = [];
  core.on('guestleft', function (d) { evts.push(d); });
  core._guestUids.g1 = 1;
  core._pcs.g1 = fakePC();
  core._dropPeer('g1');
  assert.strictEqual(evts.length, 1, 'guestleft no emitido al dropear co-anfitrión');
  assert.strictEqual(evts[0].uid, 'g1', 'guestleft con uid incorrecto');
  assert.ok(!('g1' in core._guestUids), '_guestUids no se limpió');
  assert.ok(!('g1' in core._pcs), 'la PC no se soltó');
})();

/* ---- ya cerrado (alreadyClosed): también emite ---- */
(function () {
  var core = newCore();
  var evts = [];
  core.on('guestleft', function (d) { evts.push(d); });
  core._guestUids.g2 = 1;
  core._pcs.g2 = fakePC();
  core._dropPeer('g2', true);
  assert.strictEqual(evts.length, 1, 'guestleft no emitido con alreadyClosed=true');
})();

/* ---- re-oferta del host (silent): NO emite ---- */
(function () {
  var core = newCore();
  var evts = [];
  core.on('guestleft', function (d) { evts.push(d); });
  core._guestUids.g3 = 1;
  core._pcs.g3 = fakePC();
  core._dropPeer('g3', false, true);
  assert.strictEqual(evts.length, 0, 'guestleft emitido en re-oferta (silent=true)');
})();

/* ---- un viewer normal que se va NO emite guestleft ---- */
(function () {
  var core = newCore();
  var evts = [];
  core.on('guestleft', function (d) { evts.push(d); });
  core._pcs.v1 = fakePC();
  core._dropPeer('v1');
  assert.strictEqual(evts.length, 0, 'guestleft emitido para un viewer no invitado');
})();

/* ---- el estudio escucha 'guestleft' y suelta el medio de la capa ---- */
assert.ok(html.indexOf("core.on('guestleft'") >= 0, 'el estudio no escucha guestleft');
assert.ok(html.indexOf('delete G.media[l.id];') >= 0, 'el estudio no suelta el medio de la capa Invitado');
assert.ok(html.indexOf("t('El co-anfitrión salió')") >= 0, 'falta toast de salida del co-anfitrión');

/* ---- Z2-A: grabación con mime real ---- */
assert.ok(html.indexOf('var blobType = rec.mime || \'video/webm\';') >= 0, 'falta blobType del mime real');
assert.ok(html.indexOf('/mp4/i.test(String(blobType)) ? \'.mp4\' : \'.webm\'') >= 0, 'falta extensión según mime');
assert.ok(html.indexOf('rec.mime = (mr && mr.mimeType) || mime || \'\';') >= 0 ||
          html.indexOf('rec.mime = (mr && mr.mimeType)') >= 0, 'no se guarda rec.mime');

/* ---- Z2-B: cleanupLiveUI detiene el video del programa ---- */
var cm = /function cleanupLiveUI\(\) \{[\s\S]*?\n\}/.exec(html);
assert.ok(cm, 'cleanupLiveUI no encontrado');
assert.ok(cm[0].indexOf('getVideoTracks()') >= 0, 'cleanupLiveUI no detiene los video tracks');
assert.ok(cm[0].indexOf('getAudioTracks') < 0, 'cleanupLiveUI toca audio (no debe)');

/* ---- Z2-D: fallback a viewer si falla joinAsGuest ---- */
assert.ok(html.indexOf('await core.joinLive(LS.liveId);') >= 0, 'falta re-join como viewer en el catch de joinAsGuest');

console.log('VERDE: test-wave2b-guestleft.js (guestleft, grabación mime, cleanup video, fallback guest)');
