/* ================================================================
 * Test de remoción Fase 3: Efectos / En vivo (video) / Drex Studio
 * Verifica la AUSENCIA de los sistemas eliminados y la PRESENCIA
 * de lo que debe sobrevivir (Fiestas de voz, Destellos, cámara propia).
 * Ejecutar con: node tests/test-removal-efectos-envivo-studio.js
 * ================================================================ */
var fs = require('fs');
var path = require('path');

var target = path.join(__dirname, '..', 'index.html');
var src = fs.readFileSync(target, 'utf8');

var passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('ok - ' + name); }
  else { failed++; console.log('FALLO - ' + name); }
}

/* ---------- Ausentes: núcleo En vivo (video) ---------- */
ok('DrexLiveCore ausente', src.indexOf('DrexLiveCore') === -1);
ok('DREX_LIVE_SOURCE_KINDS ausente', src.indexOf('DREX_LIVE_SOURCE_KINDS') === -1);
ok('createLive ausente', !/function createLive\b/.test(src));
ok('drexLivePlatformLink ausente', src.indexOf('drexLivePlatformLink') === -1);
ok('drexLiveStartFromSetup ausente', src.indexOf('drexLiveStartFromSetup') === -1);
ok('drexLiveCleanupRoom ausente', src.indexOf('drexLiveCleanupRoom') === -1);
ok('drex-live-setup ausente', src.indexOf('drex-live-setup') === -1);
ok('envivo-pane-video ausente', src.indexOf('envivo-pane-video') === -1);

/* ---------- Ausentes: Efectos ---------- */
ok('DREX-EFFECTS ausente', src.indexOf('DREX-EFFECTS') === -1);
ok('drexCamEffects ausente', src.indexOf('drexCamEffects') === -1);
ok('drexCameraSelectEffect ausente', src.indexOf('drexCameraSelectEffect') === -1);
ok('drexCamRenderEffects ausente', src.indexOf('drexCamRenderEffects') === -1);
ok('drexApplyEffect ausente', src.indexOf('drexApplyEffect') === -1);
ok('drex-cam-fx-topbar ausente', src.indexOf('drex-cam-fx-topbar') === -1);
ok('drex-cam-effect-layer ausente', src.indexOf('drex-cam-effect-layer') === -1);

/* ---------- Ausentes: Drex Studio ---------- */
ok('DrexStudioWeb ausente', src.indexOf('DrexStudioWeb') === -1);
ok('drexStudioTx ausente', src.indexOf('drexStudioTx') === -1);
ok('drexstudio-view ausente', src.indexOf('drexstudio-view') === -1);
ok('DSModel ausente', src.indexOf('DSModel') === -1);
ok('DrexSchedPure ausente', src.indexOf('DrexSchedPure') === -1);
ok('studio_pro ausente', src.indexOf('studio_pro') === -1);
ok('dl2-style ausente', src.indexOf('dl2-style') === -1);
ok('DREX-EFFECTS (marcador studio) ausente', src.indexOf('DREX-EFFECTS') === -1);

/* ---------- Presentes: lo que sobrevive ---------- */
ok('createFiesta presente', /function createFiesta\b/.test(src));
ok('fiesta-room-view presente', src.indexOf('fiesta-room-view') !== -1);
ok('envivo-pane-voz presente', src.indexOf('envivo-pane-voz') !== -1);
ok('drexCameraOpen presente (cámara propia)', /function drexCameraOpen\b/.test(src));
ok('live_pro presente (carril Transmitir)', src.indexOf('live_pro') !== -1);

/* ---------- Assets ---------- */
ok('sin referencia a assets/live-gifts', src.indexOf('live-gifts') === -1);
ok('DREX_GIFT_ASSET_BASE ausente', src.indexOf('DREX_GIFT_ASSET_BASE') === -1);

console.log('\n' + passed + ' pasados, ' + failed + ' fallidos');
if (failed > 0) { console.log('ROJO: quedan restos de Fase 3'); process.exit(1); }
else { console.log('VERDE: Fase 3 limpia'); }
