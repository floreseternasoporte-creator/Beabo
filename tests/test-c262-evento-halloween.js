'use strict';
/* C262 — Evento de Halloween: banner esquina a esquina sobre el feed,
 * sección propia, registro guardado en la BD, aceptación solo para los
 * elegidos (mensaje de Drex Creators a la bandeja + notificación).
 * C264: el premio ya no es un pase suelto: es un plan Drex Orbit de
 * prueba por 2 semanas y sus beneficios salen del nivel de ese plan.
 * Ejecutar: node tests/test-c262-evento-halloween.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function ok(cond, name) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extractFn(name) {
  const m = html.match(new RegExp('function ' + name + '\\b[\\s\\S]*?\\n  \\}', 'm'));
  if (!m) throw new Error('no encontrada: ' + name);
  return m[0];
}

// ---------- Núcleo puro: estados ----------
const sb = { console, Date, Number, String, Object, Math };
vm.createContext(sb);
vm.runInContext(extractFn('drexHalloweenStateOf'), sb);
const stateOf = sb.drexHalloweenStateOf;
const now = Date.now();
ok(stateOf(null, null, now) === 'visitor', 'sin registro ni aceptación: visitor');
ok(stateOf({ registeredAt: now - 1000 }, null, now) === 'registered', 'con registro guardado: registered');
ok(stateOf({ registeredAt: 1 }, { acceptedAt: 2, freeUntil: now + 9e8 }, now) === 'active', 'aceptado y vigente: active');
ok(stateOf({ registeredAt: 1 }, { acceptedAt: 2, freeUntil: now - 1 }, now) === 'ended', 'aceptado pero vencido: ended');
ok(stateOf(null, { acceptedAt: 2, freeUntil: now + 9e8 }, now) === 'active', 'la aceptación manda aunque falte el registro local');

console.log('== Superficie en el código ==');
ok(/id="halloween-banner"[^>]*onclick="openHalloweenEvent\(\)"/.test(html), 'banner esquina a esquina con tap al evento');
ok(html.indexOf('id="halloween-banner"') < html.indexOf('id="drex-sort-bar"'), 'el banner va ARRIBA del feed (antes de las pestañas)');
ok(html.includes('assets/halloween-event-2026.jpg'), 'usa la imagen de referencia subida por el usuario');
ok(html.includes('id="halloween-event-view"'), 'sección propia del evento');
for (const id of ['hw-state-visitor', 'hw-state-registered', 'hw-state-active', 'hw-state-ended', 'hw-register-btn']) {
  ok(html.includes('id="' + id + '"'), 'estado presente: #' + id);
}
ok(html.includes("ref('users/' + uid + '/eventRegistrations/' + DREX_HALLOWEEN_KEY)"), 'el registro se guarda bajo el usuario');
ok(html.includes("ref('eventRegistrations/' + DREX_HALLOWEEN_KEY + '/' + uid)"), 'y en el registro del evento (lista del equipo)');
ok(html.includes("type: 'event', timestamp") === false && html.includes("'halloween_event'"), 'la aceptación notifica dentro de la app');
ok(html.includes("ref('usernames/drexcreators')"), 'el mensaje llega firmado por Drex Creators');
ok(html.includes('conversationMessages/'), 'el mensaje entra a la bandeja de mensajería');
ok(html.includes("ref('users/' + uid + '/eventGrants/' + DREX_HALLOWEEN_KEY)"), 'el grant del equipo vive bajo el usuario');
ok(html.includes('function drexHalloweenTrialPlan()'), 'existe el plan de prueba del evento');
ok(html.includes('plan: plan'), 'la caché local guarda el plan otorgado junto a freeUntil');
ok(html.includes("'quarterly'"), 'sin plan escrito por el equipo, el otorgado es quarterly');
ok(!html.includes("typeof drexHalloweenPassActive === 'function' && drexHalloweenPassActive()"), 'los anuncios ya NO consultan un pase suelto');
ok(html.includes("DrexOrbit.hasAccess('no_ads')"), 'sin anuncios sale del plan efectivo (pagado o de prueba)');
ok(html.includes('drexHalloweenOnLogin(user.uid)'), 'al iniciar sesión se revisa la aceptación');
ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'halloween-event-2026.jpg')), 'la imagen del evento está en el repo');

console.log(failures ? '\nRESULTADO: ' + failures + ' FALLO(S)' : '\nRESULTADO: TODO VERDE');
process.exit(failures ? 1 : 0);
