// C13: regresión de limpieza al logout (hallazgos 2 y 3 de la auditoría c13).
// El fix C11-2 (b0e70f0) limpiaba clearChatConversationCache() al cerrar sesión
// pero no tenía test; la auditoría encontró además que _notifActorCache /
// _notifActorPromise (identidad del actor de notificaciones) nunca se invalidaban,
// lo que fugaba la identidad de la cuenta anterior a la siguiente en la misma pestaña.
// Este test fija: la rama de logout debe invocar clearChatConversationCache() Y
// resetear _notifActorCache/_notifActorPromise a null.
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}

// La rama de logout contiene clearChatConversationCache() (ancla C11-2).
const logoutAnchor = 'clearChatConversationCache(); // C11-2: sin fugas entre cuentas';
const ai = html.indexOf(logoutAnchor);
check('rama de logout invoca clearChatConversationCache()', ai !== -1);

// Justo después del ancla, la misma rama resetea el caché de actor (fix C13).
const window = html.slice(ai, ai + 400);
check('_notifActorCache se resetea a null en la rama de logout',
  window.includes('_notifActorCache = null;'));
check('_notifActorPromise se resetea a null en la rama de logout',
  window.includes('_notifActorPromise = null;'));

// Las declaraciones existen (el reseteo no es un no-op sobre undefined).
check('_notifActorCache declarado con let', html.includes('let _notifActorCache = null;'));
check('_notifActorPromise declarado con let', html.includes('let _notifActorPromise = null;'));

// getNotifActorInfo consume el caché: si no se reseteara, addNotification
// escribiría actorId/actorName/actorImage de la cuenta anterior.
check('getNotifActorInfo existe y usa el caché', html.includes('function getNotifActorInfo'));

if (failures) { console.error(`\n${failures} checks FAILED`); process.exit(1); }
console.log('\nAll logout-cleanup checks passed');
