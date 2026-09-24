'use strict';
// Tests de SILENCIADOS — lista central de chats silenciados (Ciclo 88).
// Uso: node test-c88-silenciados.js [--target <html>]
//   --target: HTML a probar (default: ../index.html, el parcheado).
// Diseñados para FALLAR contra la base sin parche.
//
// Verifica:
//  (a) drexMutedCoreIsActive + drexMutedCoreCollect + DREX_MUTED_INDEFINITE_UNTIL
//      (extraídos verbatim del HTML y ejecutados en sandbox): matriz de
//      actividad, filtrado de vencidos, orden "Siempre" primero, kinds user/group;
//  (b) drexMutedRemainingLabel (extraído verbatim, con appT/getAppLanguage
//      simulados): "Siempre" para el indefinido, "Hasta {d}" para temporales;
//  (c) integración estática: vista muted-chats-view + muted-chats-list,
//      openMutedChatsView/closeMutedChatsView/renderMutedChatsList/unmuteMutedChat,
//      entrada en Configuración > Privacidad, registro en las 3 listas de
//      vistas, superficie de BD acotada a chatMutes/groupMutes (escritura solo
//      .remove()) + lecturas users/groupChats, escapes en las filas,
//      claves i18n nuevas 1× por idioma, claves reutilizadas sin duplicar.
//
// Convención del repo: resuelve ../index.html con fallback a ../src/index.html;
// no depende del historial de git; sin rutas absolutas.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const target = (() => {
  const i = process.argv.indexOf('--target');
  return i >= 0 && process.argv[i + 1]
    ? path.resolve(process.argv[i + 1])
    : path.resolve(__dirname, '..', 'index.html');
})();
const i18nPath = path.resolve(__dirname, '..', 'drex-i18n.js');

const html = fs.readFileSync(target, 'utf8');
const i18n = fs.existsSync(i18nPath) ? fs.readFileSync(i18nPath, 'utf8') : '';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); }
}
function eq(a, b, name) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  ok(sa === sb, name + ' (got ' + sa + ', want ' + sb + ')');
}
function tcase(name, fn) {
  try { fn(); } catch (e) { ok(false, name + ' (throw: ' + e.message + ')'); }
}

// ---- extracción de código fuente del HTML ----
function extractConst(src, name) {
  const m = new RegExp('var\\s+' + name + '\\s*=\\s*([^;]+);').exec(src);
  if (!m) throw new Error('const no encontrada en el HTML: ' + name);
  return 'var ' + name + ' = ' + m[1] + ';';
}
function extractFunction(src, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('función no encontrada en el HTML: ' + name);
  let i = src.indexOf('{', m.index);
  if (i < 0) throw new Error('sin cuerpo: ' + name);
  let depth = 0, inStr = null, esc = false;
  const start = m.index;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

let isActive, collect, INDEF, remainingLabel;
tcase('T0 extracción del núcleo', () => {
  const code =
    extractConst(html, 'DREX_MUTED_INDEFINITE_UNTIL') + '\n' +
    extractFunction(html, 'drexMutedCoreIsActive') + '\n' +
    extractFunction(html, 'drexMutedCoreCollect') + '\n' +
    extractFunction(html, 'drexMutedRemainingLabel');
  const box = {
    appT: k => k,
    getAppLanguage: () => 'en',
  };
  vm.createContext(box);
  vm.runInContext(code, box);
  isActive = box.drexMutedCoreIsActive;
  collect = box.drexMutedCoreCollect;
  INDEF = box.DREX_MUTED_INDEFINITE_UNTIL;
  remainingLabel = box.drexMutedRemainingLabel;
  ok(typeof isActive === 'function' && typeof collect === 'function', 'T0 núcleo extraído y ejecutable');
});

// ================= T1: drexMutedCoreIsActive =================
tcase('T1 isActive', () => {
  const now = 1700000000000;
  ok(isActive({ muteUntil: now + 1000 }, now) === true, 'T1a futuro → activo');
  ok(isActive({ muteUntil: now - 1 }, now) === false, 'T1b pasado → inactivo');
  ok(isActive({ muteUntil: now }, now) === false, 'T1c igual a now → inactivo (>)');
  ok(isActive({ muteUntil: 9999999999999 }, now) === true, 'T1d indefinido → activo');
  ok(isActive(null, now) === false, 'T1e null → false');
  ok(isActive(undefined, now) === false, 'T1f undefined → false');
  ok(isActive({}, now) === false, 'T1g sin muteUntil → false');
  ok(isActive({ muteUntil: 0 }, now) === false, 'T1h cero → false');
  ok(isActive({ muteUntil: 'abc' }, now) === false, 'T1i no-numérico → false');
  ok(isActive({ muteUntil: String(now + 5000) }, now) === true, 'T1j string numérico → activo');
  eq(INDEF, 9999999999999, 'T1k INDEF coincide con muteChatUser(-1)');
});

// ================= T2: drexMutedCoreCollect =================
tcase('T2 collect', () => {
  const now = 1700000000000;
  eq(collect(null, null, now), [], 'T2a null/null → []');
  eq(collect(undefined, {}, now), [], 'T2b undefined → []');
  eq(collect([], [], now), [], 'T2c arrays rechazados → []');
  const users = {
    u1: { muteUntil: now + 8000 },
    u2: { muteUntil: now - 1000 },      // vencido
    u3: { muteUntil: 9999999999999 },   // siempre
    u4: {},                            // sin muteUntil
    '': { muteUntil: now + 5000 },      // id vacío
  };
  const groups = {
    g1: { muteUntil: now + 2000 },
    g2: { muteUntil: 0 },
  };
  const got = collect(users, groups, now);
  eq(got.map(e => e.id), ['u3', 'u1', 'g1'], 'T2d solo activos, "Siempre" primero, orden desc');
  eq(got.map(e => e.kind), ['user', 'user', 'group'], 'T2e kinds correctos');
  ok(got.every(e => typeof e.muteUntil === 'number'), 'T2f muteUntil numérico preservado');
  const single = collect({ a: { muteUntil: now + 10 } }, null, now);
  eq(single, [{ kind: 'user', id: 'a', muteUntil: now + 10 }], 'T2g forma de entrada');
});

// ================= T3: drexMutedRemainingLabel =================
tcase('T3 remainingLabel', () => {
  eq(remainingLabel(9999999999999), 'Siempre', 'T3a indefinido → appT(Siempre)');
  eq(remainingLabel(99999999999999), 'Siempre', 'T3b mayor que INDEF → Siempre');
  const now = Date.now();
  const lbl = remainingLabel(now + 8 * 3600000);
  ok(typeof lbl === 'string' && lbl.indexOf('Hasta ') === 0, 'T3c temporal → "Hasta <fecha>" (' + lbl + ')');
});

// ================= T4: vista HTML =================
tcase('T4 vista', () => {
  ok(html.indexOf('id="muted-chats-view"') > 0, 'T4a div muted-chats-view existe');
  ok(html.indexOf('id="muted-chats-list"') > 0, 'T4b div muted-chats-list existe');
  ok(html.indexOf('onclick="openMutedChatsView()"') > 0, 'T4c entrada en Privacidad con onclick');
  ok(html.indexOf('onclick="closeMutedChatsView()"') > 0, 'T4d botón volver cierra la vista');
  ok(/function openMutedChatsView\(\)/.test(html), 'T4e openMutedChatsView definida');
  ok(/function closeMutedChatsView\(\)/.test(html), 'T4f closeMutedChatsView definida');
  ok(/function renderMutedChatsList\(\)/.test(html), 'T4g renderMutedChatsList definida');
  ok(/function unmuteMutedChat\(kind, id\)/.test(html), 'T4h unmuteMutedChat definida');
  ok(html.indexOf('z-[130]') > 0 && html.indexOf('id="muted-chats-view" class="fixed inset-0 bg-[var(--theme-bg)] z-[130]') > 0, 'T4i z-[130] como blocked-accounts-view');
});

// ================= T5: registro en listas de vistas =================
tcase('T5 registries', () => {
  ok(html.indexOf("'muted-chats-view',") > 0, 'T5a presente en alguna lista de vistas');
  const closeAll = html.slice(html.indexOf('function closeAllSettingsSubViews()'), html.indexOf('function closeAllSettingsSubViews()') + 1500);
  ok(closeAll.indexOf("'muted-chats-view'") > 0, 'T5b en closeAllSettingsSubViews');
  ok(html.indexOf('#muted-chats-view,') > 0, 'T5c en la lista CSS de vistas');
  const musicClose = html.slice(html.indexOf('window.musicCloseCoveringViews = function'), html.indexOf('window.musicCloseCoveringViews = function') + 1500);
  ok(musicClose.indexOf("'muted-chats-view'") > 0, 'T5d en musicCloseCoveringViews');
});

// ================= T6: superficie de BD =================
tcase('T6 superficie BD', () => {
  const idx = html.indexOf('function renderMutedChatsList()');
  ok(idx > 0, 'T6a bloque localizable');
  const block = html.slice(idx, html.indexOf('function unmuteMutedChat('));
  const refs = [...block.matchAll(/\.ref\('([^']+)'/g)].map(m => m[1].replace(/' \+.*$/, ''));
  const allowed = ['chatMutes/', 'groupMutes/', 'groupChats/'];
  ok(refs.length > 0, 'T6b hay refs (' + refs.length + ')');
  ok(refs.every(r => allowed.some(a => r.indexOf(a) === 0)), 'T6c refs acotados a chatMutes/groupMutes/groupChats (' + refs.join('|') + ')');
  ok(block.indexOf('getChatUserProfile(') > 0, 'T6d perfiles de usuario por getChatUserProfile (users/ existente)');
  const uIdx = html.indexOf('function unmuteMutedChat(kind, id)');
  const uBlock = html.slice(uIdx, html.indexOf('}', html.indexOf("renderMutedChatsList();", html.indexOf("renderMutedChatsList();", uIdx)) + 30) + 1);
  ok(/\.remove\(\)/.test(uBlock), 'T6e unmute usa .remove()');
  ok(!/\.set\(|\.push\(|\.update\(/.test(uBlock), 'T6f unmute no escribe nada nuevo (sin set/push/update)');
  ok(uBlock.indexOf('chatMutes/') > 0 && uBlock.indexOf('groupMutes/') > 0, 'T6g unmute solo toca los nodos de silencio existentes');
});

// ================= T7: escapes en las filas =================
tcase('T7 escapes', () => {
  const idx = html.indexOf('function renderMutedChatsList()');
  const block = html.slice(idx, html.indexOf('function unmuteMutedChat('));
  ok(block.indexOf('escapeHTML(r.title)') > 0, 'T7a título escapado');
  ok(block.indexOf('escapeHTML(appT(') > 0, 'T7b textos i18n escapados');
  ok(block.indexOf('escapeInlineSingleQuote(r.entry.id)') > 0, 'T7c id escapado en el onclick');
  ok(block.indexOf('getSafeMediaUrl(r.image)') > 0, 'T7d imagen por getSafeMediaUrl');
});

// ================= T8: i18n =================
tcase('T8 i18n', () => {
  const newKeys = ['"Silenciados":"', '"Ver y reactivar chats silenciados":"',
    '"No tienes chats silenciados.":"', '"Inicia sesión para ver los chats silenciados.":"',
    '"Hasta {d}":"', '"Chat reactivado":"'];
  const regions = [
    i18n.slice(i18n.indexOf('var APP_ENGLISH_TEXT'), i18n.indexOf('var APP_CHINESE_TEXT')),
    i18n.slice(i18n.indexOf('var APP_CHINESE_TEXT'), i18n.indexOf('var APP_PORTUGUESE_TEXT')),
    i18n.slice(i18n.indexOf('var APP_PORTUGUESE_TEXT'), i18n.indexOf('var APP_CHINESE_ATTRS')),
  ];
  newKeys.forEach(k => {
    regions.forEach((r, i) => {
      const n = r.split(k).length - 1;
      ok(n === 1, 'T8 ' + k.slice(0, 28) + '… 1× en dict ' + ['EN', 'ZH', 'PT'][i] + ' (got ' + n + ')');
    });
  });
  // claves reutilizadas: siguen 1× por idioma (sin duplicados)
  ['"Siempre":"', '"Grupo":"', '"Desactivar silencio":"', '"No se pudo actualizar. Intenta de nuevo.":"'].forEach(k => {
    regions.forEach((r, i) => {
      const n = r.split(k).length - 1;
      ok(n === 1, 'T8r reutilizada ' + k.slice(0, 28) + '… 1× en ' + ['EN', 'ZH', 'PT'][i] + ' (got ' + n + ')');
    });
  });
});

// ================= T9: no-regresión =================
tcase('T9 no-regresión', () => {
  ok(html.indexOf('function muteChatUser(durationMs)') > 0, 'T9a muteChatUser intacto');
  ok(html.indexOf('function muteGroupChat(durationMs)') > 0, 'T9b muteGroupChat intacto');
  ok(html.indexOf('function isChatConversationMuted(') > 0, 'T9c isChatConversationMuted intacto');
  ok(html.indexOf('function openBlockedAccountsView()') > 0, 'T9d openBlockedAccountsView intacto');
  ok(html.indexOf("9999999999999") > 0, 'T9e el indefinido de los paneles coincide con el núcleo');
});

console.log('PASS ' + pass + ' / FAIL ' + fail);
if (failures.length) {
  console.log('FALLOS:');
  failures.forEach(f => console.log(' - ' + f));
  process.exit(1);
}
