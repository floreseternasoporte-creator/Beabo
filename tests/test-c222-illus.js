#!/usr/bin/env node
/* C222: ilustraciones 3D sin fondo en estados vacios.
   Verifica que los 7 PNG existan con canal alfa, que index.html los
   referencie en los 7 estados vacios, que los placeholders viejos hayan
   desaparecido y que el CSS .drex-illus exista. */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = '/home/hatch/workspace/beabo';
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

const PNGS = ['notif', 'chat', 'fx', 'search', 'diamond', 'saved', 'oops'];
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

// 1. Archivos PNG existen y tienen canal alfa (firma PNG + chunk IHDR color type 6/4)
for (const n of PNGS) {
  const fp = path.join(REPO, 'drex-illus', 'drex-illus-' + n + '.png');
  let hasAlpha = false, size = 0;
  try {
    const buf = fs.readFileSync(fp);
    size = buf.length;
    // IHDR: bytes 16-29; color type en offset 25 (6=RGBA, 4=gray+alpha)
    const ct = buf[25];
    hasAlpha = buf[0] === 0x89 && buf[1] === 0x50 && (ct === 6 || ct === 4);
  } catch (_) {}
  ok(size > 20000 && hasAlpha, 'PNG drex-illus-' + n + ' existe con alfa (' + Math.round(size / 1024) + ' KB)');
  ok(size < 400 * 1024, 'PNG drex-illus-' + n + ' peso moderado <400KB');
}

// 2. index.html referencia cada ilustracion
for (const n of PNGS) {
  ok(html.includes('drex-illus/drex-illus-' + n + '.png'), 'index.html referencia drex-illus-' + n);
}

// 3. Placeholders viejos eliminados de los estados vacios
ok(!html.includes('<i class="fas fa-bell text-2xl"></i>'), 'placeholder fa-bell de notificaciones eliminado');
ok(!html.includes('>\\u2726</div>') && !html.includes('>\u2726</div>'), 'placeholder \u2726 de efectos eliminado');
ok(!html.includes('<svg class="drex-snap-empty-dia"'), 'SVG diamante de Destellos vacio reemplazado');
ok(!html.includes('text-[#cbd5e1]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6.5 3.5h11'), 'SVG marcador de guardados (estado vacio) reemplazado');

// 4. CSS base + animacion
ok(html.includes('.drex-illus'), 'CSS .drex-illus presente');
ok(html.includes('drex-illus-float'), 'animacion float presente');
ok(html.includes('prefers-reduced-motion'), 'respeta reduced-motion');

// 5. Ubicaciones: cada estado vacio contiene su ilustracion cerca del texto
// (C224: el PNG también se usa en cabeceras, así que se busca CUALQUIER
// ocurrencia cercana al texto del estado vacío, no solo la primera.)
function near(img, text) {
  let i = -1;
  while ((i = html.indexOf(img, i + 1)) >= 0) {
    const win = html.slice(Math.max(0, i - 200), i + 600);
    if (win.includes(text)) return true;
  }
  return false;
}
ok(near('drex-illus-notif.png', 'Sin actividad por ahora'), 'notif: ilustracion junto a "Sin actividad por ahora"');
ok(near('drex-illus-chat.png', 'Sin conversaciones'), 'inbox: ilustracion junto a "Sin conversaciones"');
ok(near('drex-illus-fx.png', 'drexFxEscapeHtml(emptyTitle)'), 'fx: ilustracion en drexFxRenderList');
ok(near('drex-illus-search.png', 'Sin resultados para'), 'search: ilustracion junto a "Sin resultados para"');
ok(near('drex-illus-diamond.png', 'Sin destellos'), 'snap: ilustracion junto a "Sin destellos"');
ok(near('drex-illus-saved.png', 'Todav\u00eda no guardaste nada'), 'saved: ilustracion junto a "Todav\u00eda no guardaste nada"');
ok(near('drex-illus-oops.png', 'No se pudo cargar tu Pulso'), 'oops: ilustracion en drexPulsoRenderError');

// 6. Atributos de accesibilidad/rendimiento
const imgs = html.match(/<img[^>]*drex-illus[^>]*>/g) || [];
ok(imgs.length >= 8, 'al menos 8 <img> drex-illus (' + imgs.length + ')');
ok(imgs.every(t => t.includes('loading="lazy"')), 'todas con loading="lazy"');
ok(imgs.every(t => t.includes('alt=""')), 'todas con alt vacio (decorativas)');

console.log('\nC222: ' + pass + ' ok, ' + fail + ' fallos');
process.exit(fail ? 1 : 0);
