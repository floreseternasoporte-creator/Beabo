// Drex C333 — controles "Cómo interactúan contigo": auditoría y reparación.
// Fija con evidencia:
//  1. Presencia: heartbeat escribe userPresence/<uid> {online,lastSeen} (update,
//     nunca set); drexPresenceOnline respeta showActivityStatus; el toggle
//     escribe online de inmediato; el toggle refleja la BD (multi-dispositivo).
//  2. Comentarios: gating proactivo del composer al abrir (aviso + disabled);
//     el chequeo al publicar sigue como red de seguridad.
//  3. Palabras ocultas: las respuestas también se filtran (pintado y conteo).
//  4. Las 3 vistas cierran con closeAllSettingsSubViews.
//  5. Las 3 vistas ya no llevan el combo frágil "hidden flex" en clase.
// Uso: node tests/test-c333-interaction-controls.js
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let failures = 0;
function ok(name, cond) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name); }
}

// 1. Presencia
ok('existe drexPresenceHeartbeatTick', html.includes('function drexPresenceHeartbeatTick()'));
ok('heartbeat usa update (no set)', /function drexPresenceHeartbeatTick\(\)[\s\S]{0,600}\.update\(\{\s*online/.test(html));
ok('heartbeat arranca en onAuthStateChanged', html.includes('drexStartPresenceHeartbeat();'));
ok('heartbeat cada 60s', html.includes('setInterval(drexPresenceHeartbeatTick, 60000)'));
ok('pagehide apaga presencia', html.includes("window.addEventListener('pagehide', drexPresenceHeartbeatStop)"));
ok('drexPresenceOnline respeta showActivityStatus', /ref\('userPresence\/' \+ uid\)\.once\('value'\)[\s\S]{0,200}showActivityStatus !== false/.test(html));
ok('toggle escribe online inmediato', /update\(\{ showActivityStatus: on \}\)[\s\S]{0,200}update\(\{ online: on, lastSeen: Date\.now\(\) \}\)/.test(html));
ok('toggle refleja BD multi-dispositivo', html.includes("localStorage.setItem('drex_activity_status', data.showActivityStatus ? '1' : '0')"));

// 2. Comentarios: gating proactivo
ok('existe lockCommentComposer', html.includes('function lockCommentComposer(msg)'));
ok('existe unlockCommentComposer', html.includes('function unlockCommentComposer()'));
ok('existe gateCommentComposerByPermission', html.includes('function gateCommentComposerByPermission(noteId, authorId)'));
ok('openCommentsView llama al gating', html.includes('gateCommentComposerByPermission(noteId, originalAuthorId)'));
ok('closeCommentsView resetea el composer', /function closeCommentsView\(\) \{\s*try \{ if \(typeof unlockCommentComposer/.test(html));
ok('existe el aviso comment-permission-notice', html.includes('id="comment-permission-notice"'));
ok('chequeo al publicar sigue (red de seguridad)', /if \(!canUserCommentOnPost\(user\.uid, authorId, authorData\)\)/.test(html));

// 3. Palabras ocultas en respuestas
ok('collectFlatReplies filtra palabras ocultas', /function collectFlatReplies[\s\S]{0,400}commentHasHiddenWord/.test(html));
ok('countVisibleReplies filtra palabras ocultas', /function countVisibleReplies[\s\S]{0,400}commentHasHiddenWord/.test(html));

// 4. Cierre de vistas
ok('closeAllSettingsSubViews incluye comment-permission-view', html.includes("'comment-permission-view',"));
ok('closeAllSettingsSubViews incluye mention-permission-view', html.includes("'mention-permission-view',"));
ok('closeAllSettingsSubViews incluye hidden-words-view', html.includes("'hidden-words-view'"));

// 5. Sin combo hidden+flex en las 3 vistas
for (const vid of ['comment-permission-view', 'hidden-words-view', 'mention-permission-view']) {
  ok(vid + ' sin "hidden flex" en clase', !new RegExp('id="' + vid + '"[^>]*hidden flex ').test(html));
  ok(vid + ' conserva hidden', new RegExp('id="' + vid + '"[^>]*hidden').test(html));
}

// 6. Menciones: enforcement a nivel notificación sigue intacto
ok('sendMentionNotifications respeta mentionPermission', /users\/' \+ uid \+ '\/mentionPermission/.test(html));

if (failures) { console.error(failures + ' FALLOS'); process.exit(1); }
console.log('VERDE: C333 controles de interacción');
