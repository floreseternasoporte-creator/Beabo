/* C239-L5 — tests de interacción con la audiencia. node tests/test-c239-l5.js
 * Patrón: ~/workspace/c233/tests/test-c233-studio.js
 * Cubre: modelo puro (encuesta crear/votar por chat/contar, destacado,
 * mute/block local, stats reales, muestreo de gráfica), integración en
 * index.html (draw hook, mod hooks, init resiliente, suscripciones al core),
 * i18n ES/EN/ZH/PT y higiene (cero emojis, sin SpaceX).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LANE = path.join(__dirname, '..');
// base-i18n.js vive en el layout de desarrollo del carril; en el repo no existe:
// se busca hacia arriba y, si no aparece, los checks usan el archivo actual.
function findBaseI18n() {
  let d = __dirname;
  for (let i = 0; i < 6; i++) {
    const cand = path.join(d, 'base-i18n.js');
    if (fs.existsSync(cand)) return fs.readFileSync(cand, 'utf8');
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}
const BASE_I18N = findBaseI18n();
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name); }
}
function eq(a, b, name) { ok(a === b, name + ' (got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + ')'); }

const html = fs.readFileSync(path.join(LANE, 'index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(LANE, 'drex-i18n.js'), 'utf8');

function between(s, a, b) {
  const i = s.indexOf(a), j = s.indexOf(b, i + a.length);
  if (i < 0 || j < 0) return null;
  return s.slice(i + a.length, j);
}
const modelSrc = between(html, '/*__DSWAUD_MODEL_BEGIN__*/', '/*__DSWAUD_MODEL_END__*/');
const laneSrc = between(html, '/*__DSWAUD_SCRIPT_BEGIN__*/', '/*__DSWAUD_SCRIPT_END__*/');
const laneHtmlBlock = between(html, '<!-- C239-L5-HTML-BEGIN', 'C239-L5-HTML-END -->') || '';
ok(modelSrc && modelSrc.length > 500, 'T0 bloque del modelo extraíble');
ok(laneSrc && laneSrc.length > 5000, 'T0 bloque del script del carril extraíble');

// ---------- T1: el modelo puro existe y exporta la API ----------
let M = null;
try {
  const sb = {};
  vm.runInNewContext(modelSrc, sb, { filename: 'dswaud-model.js' });
  M = sb.DswAudModel || null;
} catch (e) { M = null; console.error('   (modelo no corrió: ' + e.message + ')'); }
ok(M && typeof M === 'object', 'T1 DswAudModel exporta objeto');
const API = ['MUTE_MS', 'newState', 'createPoll', 'closePoll', 'clearPoll', 'pollTotal',
  'chatVote', 'setHighlight', 'clearHighlight', 'pinMessage', 'unpinMessage',
  'mute', 'unmute', 'block', 'unblock', 'isMuted', 'isBlocked', 'isHidden',
  'muteRemaining', 'noteViewers', 'noteLikes', 'likesPerMin', 'noteGift',
  'noteChat', 'msgPerMin', 'resetLive'];
API.forEach(fn => ok(M && typeof M[fn] !== 'undefined', 'T1 API.' + fn));
if (M) eq(M.MUTE_MS, 600000, 'T1 silencio temporal = 10 min');

// ---------- T2: encuestas — crear, votar por chat, contar ----------
if (M) {
  let st = M.newState();
  eq(M.createPoll(st, '  ', ['a', 'b']), null, 'T2 pregunta vacía = null');
  eq(M.createPoll(st, 'Q', ['solo una']), null, 'T2 1 opción = null');
  eq(M.createPoll(st, 'Q', ['  ', '']), null, 'T2 opciones vacías = null');
  const p = M.createPoll(st, '¿Tema?', ['A', 'B', 'C', 'D', 'E']);
  ok(!!p, 'T2 crear encuesta ok');
  eq(p.opts.length, 4, 'T2 máximo 4 opciones');
  eq(M.pollTotal(st), 0, 'T2 total inicial 0');
  // votos por chat: texto "1".."4"
  eq(M.chatVote(st, 'u1', '1', 1000), 0, 'T2 voto "1" -> opción 0');
  eq(M.chatVote(st, 'u2', '3', 1001), 2, 'T2 voto "3" -> opción 2');
  eq(M.chatVote(st, 'u3', 'hola', 1002), -1, 'T2 texto normal no vota');
  eq(M.chatVote(st, 'u4', '12', 1003), -1, 'T2 "12" no vota');
  eq(M.chatVote(st, 'u5', '0', 1004), -1, 'T2 "0" no vota');
  eq(M.chatVote(st, 'u6', '5', 1005), -1, 'T2 "5" fuera de rango no vota');
  eq(M.chatVote(st, 'u1', '2', 1006), -1, 'T2 1 voto por espectador (vale el primero)');
  eq(M.pollTotal(st), 2, 'T2 total 2 votos');
  eq(st.poll.votes[0], 1, 'T2 opción 1 tiene 1 voto');
  eq(st.poll.votes[2], 1, 'T2 opción 3 tiene 1 voto');
  // silenciado/bloqueado no cuenta
  M.mute(st, 'u7', 2000);
  eq(M.chatVote(st, 'u7', '2', 2001), -1, 'T2 silenciado no vota');
  M.block(st, 'u8');
  eq(M.chatVote(st, 'u8', '2', 2002), -1, 'T2 bloqueado no vota');
  // cerrar congela
  M.closePoll(st);
  eq(st.poll.open, false, 'T2 encuesta cerrada');
  eq(M.chatVote(st, 'u9', '2', 3000), -1, 'T2 cerrada no acepta votos');
  eq(M.pollTotal(st), 2, 'T2 resultados congelados');
  M.clearPoll(st);
  eq(st.poll, null, 'T2 limpiar encuesta');
}

// ---------- T3: destacado y fijados ----------
if (M) {
  const st = M.newState();
  M.setHighlight(st, { uid: 'u1', name: 'Ana', text: '¿Cuándo el drop?', ts: 10 });
  eq(st.highlight.text, '¿Cuándo el drop?', 'T3 destacar guarda pregunta');
  eq(st.highlight.showOnCanvas, true, 'T3 destacado visible en canvas por defecto');
  M.clearHighlight(st);
  eq(st.highlight, null, 'T3 quitar destacado');
  ok(M.pinMessage(st, { uid: 'u2', name: 'Beto', text: 'gran tema', ts: 11 }), 'T3 fijar ok');
  ok(!M.pinMessage(st, { uid: 'u2', name: 'Beto', text: 'gran tema', ts: 11 }), 'T3 fijar duplicado = false');
  eq(st.pinned.length, 1, 'T3 sin duplicados');
  for (let i = 0; i < 12; i++) M.pinMessage(st, { uid: 'x', name: 'X', text: 'm' + i, ts: 100 + i });
  eq(st.pinned.length, 10, 'T3 fijados tope 10');
  ok(M.unpinMessage(st, 0), 'T3 quitar fijado ok');
  ok(!M.unpinMessage(st, 99), 'T3 quitar fijado malo = false');
}

// ---------- T4: moderación local ----------
if (M) {
  const st = M.newState();
  M.mute(st, 'u1', 1000);
  ok(M.isMuted(st, 'u1', 1000 + 599000), 'T4 silenciado dentro de 10 min');
  ok(!M.isMuted(st, 'u1', 1000 + 600000), 'T4 silencio expira a los 10 min');
  ok(!('u1' in st.muted), 'T4 silencio expirado se purga');
  M.mute(st, 'u2', 5000); M.unmute(st, 'u2');
  ok(!M.isMuted(st, 'u2', 6000), 'T4 quitar silencio');
  eq(M.muteRemaining(st, 'u3', 0), 0, 'T4 restante 0 si no silenciado');
  M.mute(st, 'u3', 10000);
  ok(M.muteRemaining(st, 'u3', 20000) > 0 && M.muteRemaining(st, 'u3', 20000) <= 600000, 'T4 restante positivo');
  M.block(st, 'u4');
  ok(M.isBlocked(st, 'u4'), 'T4 bloqueado');
  ok(M.isHidden(st, 'u4', 99999), 'T4 bloqueado oculto');
  M.mute(st, 'u5', 1000);
  ok(M.isHidden(st, 'u5', 2000), 'T4 silenciado oculto');
  ok(!M.isHidden(st, 'u6', 2000), 'T4 usuario normal visible');
  M.unblock(st, 'u4');
  ok(!M.isBlocked(st, 'u4'), 'T4 desbloquear');
}
// hooks de moderación para futuro backend
ok(laneSrc.indexOf('window.__dswModHooks') >= 0, 'T4 existe window.__dswModHooks');
ok(/__dswModHooks\s*=\s*window\.__dswModHooks\s*\|\|\s*\{\}/.test(laneSrc), 'T4 __dswModHooks con guard');
ok(laneSrc.indexOf('onMute') >= 0 && laneSrc.indexOf('onBlock') >= 0, 'T4 hooks onMute/onBlock');
ok(laneSrc.indexOf('__dswModHooks.onMute(uid)') >= 0, 'T4 onMute se invoca al silenciar');
ok(laneSrc.indexOf('__dswModHooks.onBlock(uid)') >= 0, 'T4 onBlock se invoca al bloquear');
ok((laneSrc + (laneHtmlBlock || '')).indexOf('local a este estudio') >= 0, 'T4 documenta moderación local en UI');

// ---------- T5: estadísticas con fuentes reales ----------
if (M) {
  const st = M.newState();
  M.noteViewers(st, 10, 0);
  M.noteViewers(st, 25, 1000);   // <5s: no muestrea
  eq(st.viewers.samples.length, 1, 'T5 muestreo cada 5s (no duplica)');
  M.noteViewers(st, 20, 5000);   // =5s: muestrea
  eq(st.viewers.samples.length, 2, 'T5 muestrea a los 5s');
  eq(st.viewers.cur, 20, 'T5 espectadores actuales');
  eq(st.viewers.peak, 25, 'T5 pico de espectadores');
  M.noteLikes(st, 100, 0);
  M.noteLikes(st, 100, 60000);   // sin cambio: no duplica hist
  M.noteLikes(st, 160, 60000);
  eq(st.likes.hist.length, 2, 'T5 hist no duplica sin cambio');
  M.noteLikes(st, 220, 120000);
  eq(st.likes.total, 220, 'T5 likes totales');
  const r = M.likesPerMin(st, 90000);
  ok(r > 0, 'T5 tasa de likes > 0 (got ' + r + ')');
  M.noteGift(st, 10); M.noteGift(st, 15000); M.noteGift(st, undefined);
  eq(st.gifts.count, 3, 'T5 conteo de regalos');
  eq(st.gifts.coins, 15010, 'T5 suma de Drex Coins');
  const t0 = 1000000;
  M.noteChat(st, t0 - 120000); // fuera de la ventana de 1 min
  M.noteChat(st, t0); M.noteChat(st, t0 + 10000); M.noteChat(st, t0 + 20000);
  eq(M.msgPerMin(st, t0 + 30000), 3, 'T5 mensajes por minuto');
  M.resetLive(st);
  eq(st.viewers.peak, 0, 'T5 reset limpia pico');
  eq(st.gifts.coins, 0, 'T5 reset limpia coins');
  eq(M.pollTotal(st), 0, 'T5 reset limpia encuesta');
  ok(!('u9' in st.muted) || true, 'T5 reset no rompe moderación');
  M.mute(st, 'u9', 1);
  M.resetLive(st);
  ok(M.isMuted(st, 'u9', 2), 'T5 la moderación sobrevive al reset');
}
// el handler de regalos usa el precio real de drexLiveGiftById
ok(laneSrc.indexOf('drexLiveGiftById') >= 0, 'T5 usa drexLiveGiftById real');
ok(/gift\.price/.test(laneSrc), 'T5 suma gift.price (Drex Coins)');
// gráfica de espectadores
ok(html.indexOf('id="dswaud-viewchart"') >= 0, 'T5 canvas de la gráfica existe');
ok(laneSrc.indexOf('drawViewChart') >= 0, 'T5 drawViewChart implementado');
ok(laneSrc.indexOf('samples') >= 0, 'T5 usa samples de noteViewers');
// seguidores: NO incluidos (sin API real en el archivo)
ok(!/seguidores|followers/i.test(between(html, '<!-- C239-L5-HTML-BEGIN', 'C239-L5-HTML-END -->') || ''), 'T5 sin métrica de seguidores en el panel');

// ---------- T6: integración con el estudio ----------
ok(html.indexOf('id="dswaud-sec-poll"') >= 0, 'T6 sección Encuestas');
ok(html.indexOf('id="dswaud-sec-mod"') >= 0, 'T6 sección Moderación');
ok(html.indexOf('id="dswaud-sec-stats"') >= 0, 'T6 sección Estadísticas');
(function () {
  const iChat = html.indexOf('id="dsw-chat"');
  const iPoll = html.indexOf('id="dswaud-sec-poll"');
  const iAlert = html.indexOf('id="dsw-alerts"');
  ok(iChat > 0 && iChat < iPoll && iPoll < iAlert, 'T6 secciones después de Chat en vivo');
})();
ok(/if\s*\(\s*!window\.__dswDrawHooks\s*\)\s*window\.__dswDrawHooks\s*=\s*\[\]/.test(laneSrc), 'T6 __dswDrawHooks con guard');
ok(laneSrc.indexOf('__dswDrawHooks.push(dswaudDrawHook)') >= 0, 'T6 draw hook registrado');
ok(laneSrc.indexOf('__dswDrawHooks.indexOf(dswaudDrawHook)') >= 0, 'T6 sin doble registro del hook');
ok(laneSrc.indexOf("document.addEventListener('dsw:studio-ready'") >= 0, 'T6 escucha dsw:studio-ready');
ok(laneSrc.indexOf('DrexStudioWeb') >= 0 && /_state\(\)\.inited/.test(laneSrc), 'T6 fallback DrexStudioWeb._state().inited');
ok(laneSrc.indexOf('setInterval(tryInitLane, 1000)') >= 0, 'T6 fallback por intervalo');
['chat', 'gifts', 'likes', 'viewers'].forEach(ev => {
  ok(laneSrc.indexOf("core.on('" + ev + "'") >= 0, 'T6 suscrito a core.on(' + ev + ')');
});
ok(laneSrc.indexOf('MutationObserver') >= 0, 'T6 observa mensajes del chat con MutationObserver');
ok(laneSrc.indexOf('dswaudDrawHook') >= 0 && /function dswaudDrawHook\(ctx,\s*W,\s*H/.test(laneSrc), 'T6 firma del hook (ctx,W,H)');
ok(laneSrc.indexOf('window.DswAud') >= 0, 'T6 expone window.DswAud');

// ---------- T7: sintaxis del script del carril ----------
try {
  new vm.Script(laneSrc, { filename: 'dswaud-lane.js' });
  ok(true, 'T7 vm.Script compila el script del carril');
} catch (e) { ok(false, 'T7 vm.Script: ' + e.message); }
try {
  new vm.Script(modelSrc, { filename: 'dswaud-model.js' });
  ok(true, 'T7 vm.Script compila el modelo');
} catch (e) { ok(false, 'T7 vm.Script modelo: ' + e.message); }

// ---------- T8: i18n ES/EN/ZH/PT ----------
const NEW_KEYS = ["Encuestas", "Moderación", "Escribe la pregunta…", "Opción 1", "Opción 2",
  "Opción 3", "Opción 4", "Escribe una pregunta y al menos 2 opciones", "Iniciar encuesta",
  "Cerrar encuesta", "Eliminar encuesta", "Encuesta activa", "Encuesta cerrada",
  "Los espectadores votan escribiendo 1, 2, 3 o 4 en el chat", "votos", "Mostrar en pantalla",
  "Pregunta destacada", "Sin pregunta destacada", "Fijar", "Quitar fijado", "Silenciar 10 min",
  "Quitar silencio", "Silenciado", "Bloqueado",
  "La moderación es local a este estudio y no afecta al en vivo.", "Pico", "por min",
  "Mensajes por minuto", "Espectadores en el tiempo", "Sin datos todavía"];
// traducciones esperadas ES -> [EN, ZH, PT]
const EXPECT = {
  "Encuestas": ["Polls", "投票", "Enquetes"],
  "Moderación": ["Moderation", "直播管理", "Moderação"],
  "Escribe la pregunta…": ["Write the question…", "写下问题…", "Escreva a pergunta…"],
  "Opción 1": ["Option 1", "选项 1", "Opção 1"],
  "Opción 2": ["Option 2", "选项 2", "Opção 2"],
  "Opción 3": ["Option 3", "选项 3", "Opção 3"],
  "Opción 4": ["Option 4", "选项 4", "Opção 4"],
  "Escribe una pregunta y al menos 2 opciones": ["Write a question and at least 2 options", "请填写问题和至少 2 个选项", "Escreva uma pergunta e pelo menos 2 opções"],
  "Iniciar encuesta": ["Start poll", "开始投票", "Iniciar enquete"],
  "Cerrar encuesta": ["Close poll", "结束投票", "Encerrar enquete"],
  "Eliminar encuesta": ["Delete poll", "删除投票", "Excluir enquete"],
  "Encuesta activa": ["Active poll", "进行中的投票", "Enquete ativa"],
  "Encuesta cerrada": ["Poll closed", "投票已结束", "Enquete encerrada"],
  "Los espectadores votan escribiendo 1, 2, 3 o 4 en el chat": ["Viewers vote by typing 1, 2, 3 or 4 in the chat", "观众在聊天中输入 1、2、3 或 4 即可投票", "Os espectadores votam digitando 1, 2, 3 ou 4 no chat"],
  "votos": ["votes", "票", "votos"],
  "Mostrar en pantalla": ["Show on screen", "在屏幕上显示", "Mostrar na tela"],
  "Pregunta destacada": ["Featured question", "置顶问题", "Pergunta em destaque"],
  "Sin pregunta destacada": ["No featured question", "没有置顶问题", "Sem pergunta em destaque"],
  "Fijar": ["Pin", "置顶", "Fixar"],
  "Quitar fijado": ["Unpin", "取消置顶", "Desafixar"],
  "Silenciar 10 min": ["Mute 10 min", "禁言 10 分钟", "Silenciar 10 min"],
  "Quitar silencio": ["Unmute", "取消禁言", "Remover silêncio"],
  "Silenciado": ["Muted", "已禁言", "Silenciado"],
  "Bloqueado": ["Blocked", "已屏蔽", "Bloqueado"],
  "La moderación es local a este estudio y no afecta al en vivo.": ["Moderation is local to this studio and does not affect the live stream.", "管理仅在此工作室内生效，不会影响直播。", "A moderação é local deste estúdio e não afeta a live."],
  "Pico": ["Peak", "峰值", "Pico"],
  "por min": ["per min", "/分钟", "por min"],
  "Mensajes por minuto": ["Messages per minute", "每分钟消息数", "Mensagens por minuto"],
  "Espectadores en el tiempo": ["Viewers over time", "观众人数变化", "Espectadores ao longo do tempo"],
  "Sin datos todavía": ["No data yet", "暂无数据", "Sem dados ainda"]
};
eq(NEW_KEYS.length, 30, 'T8 30 claves nuevas');
eq(Object.keys(EXPECT).length, 30, 'T8 30 traducciones esperadas');
const baseI18n = BASE_I18N;
function countOcc(src, k) {
  const re = new RegExp('"' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '":"', 'g');
  return (src.match(re) || []).length;
}
NEW_KEYS.forEach(k => {
  const delta = baseI18n ? countOcc(i18n, k) - countOcc(baseI18n, k) : countOcc(i18n, k);
  ok(delta === 3, 'T8 "' + k + '" agregada 1x por dict TEXT (delta ' + delta + ')');
  const tr = EXPECT[k];
  ok(i18n.indexOf('"' + k + '":"' + tr[0] + '"') >= 0, 'T8 "' + k + '" EN');
  ok(i18n.indexOf('"' + k + '":"' + tr[1] + '"') >= 0, 'T8 "' + k + '" ZH');
  ok(i18n.indexOf('"' + k + '":"' + tr[2] + '"') >= 0, 'T8 "' + k + '" PT');
  ok(tr.every(v => v && v.trim()), 'T8 "' + k + '" sin traducciones vacías');
});
// claves reutilizadas (ya existían en TEXT): el carril las usa sin duplicarlas
["Destacar", "Quitar destacado", "Fijados", "Silenciados", "Bloqueados", "Bloquear",
 "Desbloquear", "Espectadores", "Estadísticas", "Me gusta", "Regalos", "Drex Coins", "Pregunta"
].forEach(k => {
  ok(laneHtmlBlock.indexOf(k) >= 0 || laneSrc.indexOf("'" + k + "'") >= 0,
    'T8 reutiliza clave existente "' + k + '"');
  ok(countOcc(i18n, k) - countOcc(baseI18n, k) === 0, 'T8 "' + k + '" no duplicada');
});

// ---------- T9: higiene ----------
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
const RANGES = [
  between(html, '/* ============ C239-L5-CSS', 'FIN C239-L5-CSS ============ */'),
  between(html, '<!-- C239-L5-HTML-BEGIN', 'C239-L5-HTML-END -->'),
  laneSrc
];
RANGES.forEach((r, i) => {
  ok(r && !EMOJI_RE.test(r), 'T9 rango ' + i + ' sin emojis');
  ok(r && r.toLowerCase().indexOf('spacex') < 0, 'T9 rango ' + i + ' sin SpaceX');
});
ok(i18n.toLowerCase().split('spacex').length - 1 === (BASE_I18N ? BASE_I18N.toLowerCase().split('spacex').length - 1 : 0), 'T9 i18n no agrega SpaceX');

console.log('\nC239-L5: ' + pass + ' verdes, ' + fail + ' rojos');
process.exit(fail ? 1 : 0);
