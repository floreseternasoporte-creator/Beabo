/* ================================================================
 * C143 — auditoría hit por hit de la familia NUNCA auditada —
 * Permissions API (navigator.permissions.query/revoke, PermissionStatus,
 * onchange), con re-verify del plumbing de permisos de notificación
 * (Notification.requestPermission) ante código nuevo.
 *
 * INVENTARIO repo-wide (grep sobre index.html, 404.html, drex-cloud.js,
 * drex-rec-engine.js, sw.js, server.js; tests/ excluidos; C130 obliga
 * repo-wide):
 *  - navigator.permissions: 0
 *  - permissions.query / permissions.revoke: 0
 *  - PermissionStatus / "permission" onchange: 0
 *  - navigator["permissions"] / navigator['permissions']: 0
 *  - Familia vecina Permissions-Policy (header/meta): 0
 *
 * CONCLUSIONES:
 *  - navigator.permissions.query() no se usa y no tiene ancla donde
 *    usarse: el único flujo que pide un permiso (activar notificaciones
 *    push, ~línea 24524) ya lee Notification.permission ANTES de llamar a
 *    requestPermission() — la query no aportaría nada. La cámara/mic de
 *    Fiestas (getUserMedia, C129) se piden solo tras gesto explícito del
 *    usuario (unirse a la voz). Añadir queries sería código muerto.
 *  - MICRO-FIX con lead real: openNotifications llamaba
 *    Notification.requestPermission() cada vez que permission !==
 *    'granted' — incluido el estado 'denied', donde por spec resuelve
 *    'denied' sin volver a preguntar (no-op desperdiciado en cada
 *    apertura del panel). Ahora solo se pide en 'default'.
 *
 * Este test fija el inventario (cualquier navigator.permissions nuevo
 * rompe el test y obliga a re-auditar) y el guard corregido.
 *
 * Ejecutar con: node tests/test-c143-permissions-api.js
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const htmlPath = path.join(repoRoot, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const copy = fs.readFileSync(path.join(repoRoot, '404.html'), 'utf8');
const jsFiles = ['drex-cloud.js', 'drex-rec-engine.js', 'sw.js', 'server.js']
  .map(f => { try { return fs.readFileSync(path.join(repoRoot, f), 'utf8'); } catch (e) { return ''; } });
const all = [html, copy].concat(jsFiles);

function countAll(re) {
  let n = 0;
  for (const b of all) { const m = b.match(re); if (m) n += m.length; }
  return n;
}

let passed = 0, failed = 0;
function tcase(name, fn) {
  try { fn(); console.log('ok - ' + name); passed++; }
  catch (e) { console.log('FAIL - ' + name + ' :: ' + (e && e.message)); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }

// Familia NUEVA: Permissions API — cero repo-wide.
tcase('navigator.permissions: 0 hits repo-wide', () => {
  assert(countAll(/navigator\.permissions/g) === 0, 'hay navigator.permissions');
});
tcase('permissions.query / permissions.revoke: 0 hits', () => {
  assert(countAll(/permissions\.(query|revoke)/g) === 0, 'hay permissions.query/revoke');
});
tcase('PermissionStatus / permission onchange: 0 hits', () => {
  assert(countAll(/PermissionStatus/g) === 0, 'hay PermissionStatus');
  assert(countAll(/\.onchange\s*=\s*function[^{]*\{[^}]*permission/i) === 0, 'hay onchange de permiso');
});
tcase('bracket-notation navigator["permissions"]: 0 hits', () => {
  assert(countAll(/navigator\[["']permissions["']\]/g) === 0, 'hay bracket-notation');
});
tcase('Permissions-Policy (header/meta): 0 hits', () => {
  assert(countAll(/[Pp]ermissions-[Pp]olicy/g) === 0, 'hay Permissions-Policy');
});

// Re-verify: el flujo push ya lee Notification.permission antes de pedir
// (la query no aportaría nada) — el guard sigue intacto tras el fix.
tcase('flujo push: lee Notification.permission antes de requestPermission', () => {
  assert(/let perm = 'default';\s*\n\s*try \{ perm = Notification\.permission; \} catch/.test(html),
    'el guard del flujo push cambió');
  assert(html.indexOf("if (perm === 'default')") !== -1, 'falta el if (perm === default)');
});

// Micro-fix C143: openNotifications solo pide el permiso en 'default'.
tcase('openNotifications: requestPermission solo cuando permission === "default"', () => {
  assert(html.indexOf('Notification.permission === "default"') !== -1,
    'el guard no es === "default"');
  assert(html.indexOf('Notification.permission !== "granted"') === -1,
    'queda el guard viejo !== "granted"');
  assert(/C143: solo pedir el permiso cuando está en 'default'/.test(html),
    'falta el comentario C143');
});

// Los dos requestPermission de index.html son los únicos del árbol
// (404.html se sincroniza con cp antes de la suite).
tcase('requestPermission: exactamente 2 call sites en index.html (push + openNotifications)', () => {
  assert((html.match(/Notification\.requestPermission\(\)/g) || []).length === 2,
    'cambió el número de call sites en index.html');
});

console.log('');
console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILURES');
process.exit(failed === 0 ? 0 : 1);
