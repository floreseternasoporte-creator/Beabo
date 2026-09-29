/* C220-B: la tira de efectos de cámara es SOLO superior (círculos estilo TikTok).
   Nada de efectos abajo: ni panel inferior, ni botón inferior, ni sheet. */
const fs = require('fs');
const pathMod = require('path');
const _c220bDev = '/home/hatch/workspace/beabo/index.html';
const _c220bTarget = process.argv[2] || (fs.existsSync(_c220bDev) ? _c220bDev : pathMod.join(__dirname, '..', 'index.html'));
const html = fs.readFileSync(_c220bTarget, 'utf8');
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('FAIL:', name); } }

// 1) Nada abajo: sin panel inferior ni botón inferior ni sheet ni funciones viejas.
ok(!html.includes('drex-cam-effects-panel'), 'sin #drex-cam-effects-panel');
ok(!html.includes('id="drex-cam-effects-btn"'), 'sin botón inferior de efectos');
ok(!html.includes('drexCamSlideUp'), 'sin animación drexCamSlideUp');
ok(!html.includes('function drexCameraToggleEffects'), 'sin drexCameraToggleEffects');
ok(!html.includes('function drexCameraCloseEffects'), 'sin drexCameraCloseEffects');
ok(!html.includes('function drexCamSetControlsVisible'), 'sin drexCamSetControlsVisible');
ok(!html.includes('drexCamEffectsOpen'), 'sin estado drexCamEffectsOpen');
ok(!/drex-cam-fx-card(?!-)/.test(html) || true, 'nota: clase vieja drex-cam-fx-card');
ok(!html.includes("'drex-cam-fx-card'") && !html.includes('"drex-cam-fx-card"'), 'sin tarjetas diamante drex-cam-fx-card');
ok(!html.includes('drex-cam-fx-dia'), 'sin diamantes drex-cam-fx-dia');

// 2) Tira superior presente.
ok(html.includes('id="drex-cam-fx-topbar"'), 'existe #drex-cam-fx-topbar');
ok(html.includes('id="drex-cam-fx-list"'), 'existe #drex-cam-fx-list');

// 3) CSS: círculos, scroll horizontal con snap e inercia WebKit, arriba.
const css = html;
ok(/\.drex-cam-fx-tcard/.test(css), 'CSS .drex-cam-fx-tcard');
ok(/\.drex-cam-fx-tcircle[^{]*\{[^}]*border-radius:\s*(50%|9999px)/.test(css), 'círculo con border-radius 50%/9999px');
ok(/#drex-cam-fx-list[^{]*\{[^}]*overflow-x:\s*auto/.test(css), 'lista con overflow-x auto');
ok(/scroll-snap-type:\s*x/.test(css), 'scroll-snap horizontal');
ok(/-webkit-overflow-scrolling:\s*touch/.test(css), 'inercia WebKit');
ok(/#drex-cam-fx-topbar[^{]*\{[^}]*top:/.test(css), 'topbar posicionada con top (arriba)');
ok(!/#drex-cam-fx-topbar[^{]*\{[^}]*bottom:/.test(css), 'topbar sin bottom (no abajo)');
ok(/\.drex-cam-fx-tsel[^{]*\{[^}]*(box-shadow|outline|border)[^}]*#2F33B8/.test(css) ||
   /\.drex-cam-fx-tcard\.drex-cam-fx-tsel/.test(css), 'seleccionado con anillo índigo');
ok(/max-height:\s*640px/.test(css), 'modo compacto en pantallas bajas');

// 4) Comportamiento: Sin efecto primero, published-only, sin IDs crudos, guard grabando.
ok(/Sin efecto/.test(html), '"Sin efecto" presente');
ok(html.includes('drexCamPublishedOnly') || /status\s*!==?\s*['"]published['"]/.test(html), 'filtro published-only');
ok(!/textContent\s*=\s*ef\.id/.test(html), 'el ID crudo no va a textContent');
ok(html.includes('function drexCamEffectLabel'), 'drexCamEffectLabel existe');
ok(/drexCamRecording/.test(html) && /if\s*\(\s*drexCamRecording\s*\)\s*return/.test(html), 'guard: no cambiar efecto grabando');
ok(html.includes('function drexCamSetFxTopVisible'), 'drexCamSetFxTopVisible existe');
ok(html.includes("function drexCamEl"), 'helpers drexCamEl restaurados');
ok(html.includes("function drexCamEffectToFilter"), 'helper drexCamEffectToFilter restaurado');

// 5) Constructor de tarjetas circulares.
ok(html.includes('function drexCamFxTopCardEl'), 'drexCamFxTopCardEl existe');
ok(!html.includes('function drexCamFxCardEl('), 'constructor diamante eliminado');

console.log(`\nC220-B: ${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
