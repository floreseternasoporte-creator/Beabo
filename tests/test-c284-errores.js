// C284 — errores de ingreso, grupos/ondas y moderación.
// Ejecutar: node tests/test-c284-errores.js
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');
let pass = 0, fail = 0; const fails = [];
function ok(c, name, extra) { if (c) { pass++; } else { fail++; fails.push(name + (extra ? ' :: ' + extra : '')); } }
function slice(from, to) { const a = html.indexOf(from); if (a < 0) throw new Error('marcador no encontrado: ' + from); const b = html.indexOf(to, a); if (b < 0) throw new Error('cierre no encontrado: ' + to); return html.slice(a, b); }

// ===== 1. Completar registro conserva los ajustes de la cuenta =====
{
  const a = html.indexOf('regData.username = username;');
  const seg = html.slice(a, a + 4000);
  ok(seg.includes("_existingUserData.isPrivate === 'boolean' ? _existingUserData.isPrivate : false"), 'conserva isPrivate al completar registro');
  ok(seg.includes("_existingUserData.dmPermission || 'all'"), 'conserva dmPermission');
  ok(seg.includes("_existingUserData.registrationTimestamp || Date.now()"), 'conserva la fecha de registro');
  ok(seg.includes("_existingUserData.founder === true"), 'conserva founder');
  ok(seg.includes("isMinorRestricted ? true"), 'los menores conservan su protección');
}

// ===== 2. Contraseña: mínimo 8 en todas partes =====
{
  ok(html.includes("password.length < 8) { err.textContent = 'La contraseña debe tener al menos 8 caracteres.'"), 'registro exige 8');
  ok(html.includes("Usa al menos 8 caracteres.';"), 'mensaje de contraseña débil dice 8');
  ok(html.includes('nextPassword.length < 8'), 'cambio en Ajustes exige 8');
  ok(html.includes('placeholder="Mínimo 8 caracteres"'), 'placeholder dice 8');
  ok(!html.includes('al menos 6 caracteres'), 'no queda ninguna promesa de 6');
}

// ===== 3. Foto del registro que falla: aviso =====
{
  const a = html.indexOf('Tu cuenta se creó, pero la foto no se pudo subir.');
  ok(a > 0, 'el fallo de la foto avisa');
  ok(i18n.includes('"Tu cuenta se creó, pero la foto no se pudo subir. Puedes agregarla desde tu perfil."'), 'i18n del aviso de foto');
}

// ===== 4. Reenviar código de recuperación avisa =====
{
  const a = html.indexOf("sendPasswordResetEmail(recoveryEmail)");
  const seg = html.slice(a, a + 900);
  ok(seg.includes('Código reenviado. Revisa tu correo.'), 'reenvío confirma');
  ok(seg.includes('No se pudo reenviar el código.'), 'reenvío fallido avisa');
}

// ===== 5. Publicar desde el Creator Hub lleva al feed =====
{
  const a = html.indexOf('// C284: tras PUBLICAR se va al feed');
  ok(a > 0 && html.slice(a, a + 200).includes('noteCreationCameFromHub = false'), 'publicar apaga el retorno al hub');
}

// ===== 6. Publicaciones del grupo muestran el texto =====
{
  ok(html.includes("String(item.content || item.text || '')"), 'la vista del grupo lee content');
}

// ===== 7. Menciones con puntos =====
{
  const code = slice('  function extractMentionUsernames(text) {', '  function renderTextWithMentions(text) {');
  const ctx = vm.createContext({ console });
  vm.runInContext(code, ctx);
  const out = ctx.extractMentionUsernames('@maria.paz saludó a @bob. y a @ana_maria-2');
  ok(out.includes('maria.paz') && out.includes('bob') && out.includes('ana_maria-2') && !out.includes('maria'),
    'menciones con punto resuelven completas', JSON.stringify(out));
  ok(html.includes("(?:\\.[\\p{L}\\p{N}_-]+)*|#"), 'render enlaza menciones con punto');
}

// ===== 8. Buscar excluye posts de grupo =====
{
  ok(html.includes('posts.filter(p => !p.groupId && !hiddenPrivateSearchAuthors.has'), 'texto libre excluye grupos');
  ok(html.includes('!_groupPostIds.has(ph.postId)'), 'fotos excluyen grupos');
}

// ===== 9. Selector de grupo del borrador sincronizado =====
{
  ok(html.includes('function _syncNoteGroupSelector()'), 'existe la sincronización');
  ok(html.slice(html.indexOf('selectedGroupForPost = draft.groupId'), html.indexOf('selectedGroupForPost = draft.groupId') + 500).includes('_syncNoteGroupSelector'), 'el borrador sincroniza el selector');
  ok(html.slice(html.indexOf('function loadGroupsForNotePost()'), html.indexOf('function loadGroupsForNotePost()') + 1600).includes('_syncNoteGroupSelector'), 'la carga de grupos re-sincroniza');
}

// ===== 10. El eco no filtra posts velados =====
{
  const code = slice('  async function shareEco(note', '  let _sharePostTargetNoteId');
  let shared = null;
  const ctx = vm.createContext({
    console,
    appT: s => s,
    location: { origin: 'https://drex.app', pathname: '/' },
    navigator: { share: async o => { shared = o; }, clipboard: { writeText: async () => {} } },
    showMiniToast: () => {}
  });
  vm.runInContext(code, ctx);
  (async () => {
    await ctx.shareEco({ id: 'n1', spoiler: true, content: 'EL_FINAL_SECRETO_DEL_POST' }, 'Ana');
    ok(shared && !String(shared.text).includes('EL_FINAL_SECRETO_DEL_POST'), 'eco de spoiler no filtra el texto', shared && shared.text);
    shared = null;
    await ctx.shareEco({ id: 'n2', sensitive: true, content: 'TEXTO_FUERTE_SECRETO' }, 'Ana');
    ok(shared && !String(shared.text).includes('TEXTO_FUERTE_SECRETO'), 'eco de contenido fuerte no filtra el texto');
    shared = null;
    await ctx.shareEco({ id: 'n3', content: 'Texto público normal' }, 'Ana');
    ok(shared && String(shared.text).includes('Texto público normal'), 'eco normal sí lleva el texto');
    console.log(`C284: ${pass} PASS, ${fail} FAIL`);
    if (fails.length) console.log('FALLOS:\n - ' + fails.join('\n - '));
    process.exit(fail ? 1 : 0);
  })().catch(e => { console.error(e); process.exit(2); });
}

// ===== 11. Menciones respetan bloqueos (fuente) =====
{
  const a = html.indexOf('function sendMentionNotifications');
  const seg = html.slice(a, a + 3200);
  ok(seg.includes("blocks/' + fromUserId + '/' + uid") && seg.includes("blocks/' + uid + '/' + fromUserId"), 'menciones revisan bloqueo en ambos sentidos');
  ok(seg.includes('actorId: fromUserId'), 'la notificación de mención lleva el actor');
}

// ===== 12. Grupos: no agregar con bloqueos =====
{
  const a = html.indexOf('async function addMemberToGroup');
  const seg = html.slice(a, a + 2600);
  ok(seg.includes("blocks/' + user.uid + '/' + uid") && seg.includes("blocks/' + uid + '/' + user.uid"), 'agregar a grupo revisa bloqueos');
  ok(seg.includes('No puedes agregar a este usuario a un grupo contigo.'), 'aviso al bloquear la agregación');
}

// ===== 13. Comentarios desactivados por moderación no se pintan =====
{
  const occurrences = html.split("!(c && c.deactivated === true) && !isAccountBlockedForCurrentUser").length - 1;
  ok(occurrences === 3, 'las 3 rutas de comentarios filtran desactivados', 'n=' + occurrences);
}

// ===== 14. Índice de Ondas sin posts invisibles =====
{
  const a = html.indexOf('function ondaIndexBulkFeed');
  ok(html.slice(a, a + 1500).includes('!p.groupId'), 'índice en bloque sin grupos');
  const b = html.indexOf('function ondaIndexFeedOne');
  ok(html.slice(b, b + 1200).includes('note.groupId'), 'índice individual sin grupos');
}
