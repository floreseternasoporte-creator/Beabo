// C285 — encuestas/ecos, rendimiento y apariencia.
// Ejecutar: node tests/test-c285-errores.js
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

// ===== 1. Ecos de perfil filtrados por visibilidad =====
{
  const a = html.indexOf('function _loadAuthorEcosContent');
  const seg = html.slice(a, a + 4200);
  ok(seg.includes("!item.post.groupId"), 'ecos: fuera posts de grupo');
  ok(seg.includes('shouldHideNoteForCurrentUser(item.post.id, item.post)'), 'ecos: filtro de visibilidad');
  ok(seg.includes('isAccountPrivate(aid)'), 'ecos: cuentas privadas por lote');
  ok(seg.includes("blocks/' + aid + '/' + me"), 'ecos: bloqueo inverso');
}

// ===== 2. Votar exige ver el post =====
{
  const code = slice('  function drexPollHoursForPublish', '  function drexDraftHasPoll');
  ok(html.includes('function proceed() {'), 'existe la vía interna de voto');
  const a = html.indexOf('function voteInPoll');
  const seg = html.slice(a, a + 1500);
  ok(seg.includes('shouldHideNoteForCurrentUser(noteId, n)'), 'votar consulta visibilidad');
  ok(seg.includes('n.groupId'), 'votar no entra a posts de grupo');
  ok(html.includes("if (_c285Abort === 'closed') showMiniToast(appT('La votación ya está cerrada.'))"), 'voto tardío avisa del cierre');
  ok(html.includes('_c147PrevVoteIdx !== optIdx) showMiniToast'), 'misma opción no anuncia cambio');
}

// ===== 3. Puerta Orbit de encuestas al publicar =====
(async () => {
  const code = slice('  function drexPollHoursForPublish', '  function drexDraftHasPoll');
  const ctxA = vm.createContext({ console, showMiniToast: () => {}, DrexOrbit: undefined });
  vm.runInContext(code, ctxA);
  ok(ctxA.drexPollHoursForPublish(168) === 168, 'sin Orbit cargado no se toca el plazo');
  const ctxB = vm.createContext({ console, showMiniToast: () => {}, DrexOrbit: { enforced: () => true, trialPlan: () => null, hasAccess: () => false } });
  vm.runInContext(code, ctxB);
  ok(ctxB.drexPollHoursForPublish(168) === 24, 'sin beneficio: 1 semana cae a 1 día');
  ok(ctxB.drexPollHoursForPublish(24) === 24, '1 día gratis intacto');
  const ctxC = vm.createContext({ console, showMiniToast: () => {}, DrexOrbit: { enforced: () => true, trialPlan: () => null, hasAccess: () => true } });
  vm.runInContext(code, ctxC);
  ok(ctxC.drexPollHoursForPublish(72) === 72, 'con beneficio: 3 días se respeta');
})().catch(e => { ok(false, 'puerta Orbit ejecutable', e.message); });

// ===== 4. Porcentajes suman 100 =====
{
  const code = slice('  function pollTimeLeftText', '  function voteInPoll');
  const ctx = vm.createContext({
    console, DrexCloud: { auth: () => ({ currentUser: null }) },
    escapeHtml: s => String(s), escapeInlineSingleQuote: s => String(s),
    appT: s => s, DREX_POLL_CHECK_SVG: ''
  });
  vm.runInContext(code + '\n;renderPostPollHTML.__x = 1;', ctx);
  const poll = { options: [{ t: 'A', v: 1 }, { t: 'B', v: 1 }, { t: 'C', v: 1 }], total: 3, endsAt: Date.now() - 1000, voters: {} };
  const out = ctx.renderPostPollHTML({ id: 'n1', poll }, false);
  const pcts = [...out.matchAll(/drex-poll-pct">(\d+)%/g)].map(m => Number(m[1]));
  ok(pcts.length === 3 && pcts.reduce((a, b) => a + b, 0) === 100, '33/33/34 suma 100', JSON.stringify(pcts));
}

// ===== 5. Rendimiento: caché de mapas y muerte del feed =====
{
  ok(html.includes('function _feedUserMapsFresh') && html.includes("_feedUserMapsStore(user.uid, 'votes'"), 'mapas del feed cacheados 30 s');
  ok(html.includes('_feedUserMapsCache.ts = 0'), 'votar/eco invalida la caché');
  ok(html.includes('window.__drexFeedKillForLogout'), 'logout apaga la suscripción del feed');
  ok(html.includes('window.__drexFeedNotesRef'), 'la ref del feed queda localizable');
  const a = html.indexOf('function openHome()');
  ok(html.slice(a, a + 2600).includes('detachReadReceiptListener()'), 'salir por la barra inferior desengancha la sala entera');
  ok(html.includes('(Date.now() - _musicExploreLoadedAt) < 60000'), 'Explorar de Música cacheado 60 s');
  ok(html.includes('_featuredArtistsLoadedAt'), 'destacados cacheados');
  ok((html.match(/\.size > 400/g) || []).length >= 5, 'cachés de perfiles con tope');
}

// ===== 6. Temas de chat tiñen ambas burbujas =====
{
  ok(html.includes('function _chatBubbleThemeStyle(side)'), 'existe el estilo por burbuja');
  ok(html.includes('data-bubble-side="${mine ? \'mine\' : \'other\'}"'), 'burbujas marcadas por lado');
  ok(html.includes("b.getAttribute('data-bubble-side') === 'mine' ? (def.mine || '') : (def.other || '')"), 'aplicar tema usa ambos colores');
  ok(!html.includes("querySelectorAll('.msg-bubble.bg-"), 'el selector zombie desapareció');
}

// ===== 7. Idioma de la cuenta restaurado =====
{
  ok(html.includes('function drexRestoreAccountLanguage'), 'restaurador de idioma presente');
  ok(html.includes("userSettings/' + user.uid + '/appLanguage').once('value')"), 'lee el idioma de la cuenta');
  ok(html.includes('drexRestoreAccountLanguage(user)'), 'se invoca al entrar la sesión');
}

// ===== 8. Silencio nocturno no borra preferencias =====
{
  ok(html.includes('window.__notifSettingsLoaded = true'), 'carga de preferencias marcada');
  ok(html.includes('if (!window.__notifSettingsLoaded) return;'), 'sin lectura real no se toca nada');
  ok(html.includes('_quietModeDisableNotifs();\n      }\n      _scheduleQuietModeRestore();'), 'abrir en horario de silencio también pausa');
}

// ===== 9. Tema sin fogonazo + filtro fuerte al entrar =====
{
  ok(html.includes("localStorage.getItem('drex_theme') === 'dark'"), 'tema aplicado antes del primer pintado');
  ok(html.includes('_drexLoadParentalSensitiveFilter(user.uid)'), 'filtro de contenido fuerte cargado en la sesión');
}

// ===== i18n =====
{
  ['"Este contenido no está disponible."', '"La votación ya está cerrada."', '"Las encuestas de más de 1 día son de Drex Orbit: se ajustó a 1 día."'].forEach(k => {
    ok(i18n.includes(k), 'i18n ' + k);
  });
}

setTimeout(() => {
  console.log(`C285: ${pass} PASS, ${fail} FAIL`);
  if (fails.length) console.log('FALLOS:\n - ' + fails.join('\n - '));
  process.exit(fail ? 1 : 0);
}, 50);
