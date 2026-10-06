/* ================================================================
 * Tests UI carril 3 — Ajustes, Perfil y Navegación (390px)
 * Ejecutar con: node tests/test-ui-settings-390.js
 * Sin dependencias externas — solo Node.js.
 *
 * Verifica (análisis estático sobre index.html + drex-i18n.js):
 *  A. Cada tarjeta de Ajustes abre su vista (la función del onclick
 *     existe y el view destino existe en el DOM).
 *  B. openHome() repone la barra inferior (bug carril 3: tras visitar
 *     el perfil propio, el botón Atrás dejaba la nav oculta).
 *  C. closeSavedPostsView() oculta la vista, desbloquea el scroll y
 *     repone la nav (bug carril 3: el botón Volver de Guardados no
 *     hacía nada visible).
 *  D. Sin emojis usados como iconos en las vistas de la zona.
 *  E. i18n ES/EN/ZH/PT: "Mensaje" y "Uso estimado: {s}" existen en
 *     los tres diccionarios; refreshCacheUsageUI usa appT (no ES
 *     hardcodeado).
 *  F. El perfil ajeno tiene Seguir + Mensaje + Bloquear.
 *  G. data-nav-index de la barra inferior es secuencial (0,1,2,3,4).
 *  H. Todas las vistas de la zona tienen botón atrás (chevron).
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var i18nSrc = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');

var passed = 0, failed = 0, failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; failures.push(name + ': ' + e.message); console.log('FALLO - ' + name + ': ' + e.message); }
}
function defined(fnName) {
  return new RegExp('function\\s+' + fnName + '\\s*\\(').test(src) ||
         new RegExp('window\\.' + fnName + '\\s*=').test(src);
}
function viewRegion(vid) {
  var m = src.indexOf('id="' + vid + '"');
  assert(m !== -1, 'vista ' + vid + ' no encontrada en el DOM');
  var ts = src.lastIndexOf('<', m);
  var depth = 0, i = ts;
  while (i < src.length) {
    if (src.indexOf('</div', i) === i) {
      depth--;
      if (depth === 0) { var e = src.indexOf('>', i); return src.slice(ts, e + 1); }
      i += 6;
    } else if (src.indexOf('<div', i) === i && ' >/\n'.indexOf(src[i + 4]) !== -1) { depth++; i += 4; }
    else i++;
  }
  assert(false, 'no se pudo delimitar la vista ' + vid);
}
function fnBody(fnName) {
  var m = new RegExp('function\\s+' + fnName + '\\s*\\([^)]*\\)\\s*\\{').exec(src) ||
          new RegExp('window\\.' + fnName + '\\s*=\\s*function\\s*\\([^)]*\\)\\s*\\{').exec(src);
  assert(m, 'función ' + fnName + ' no encontrada');
  var i = m.index + m[0].length, depth = 1;
  while (i < src.length && depth) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(m.index + m[0].length, i - 1);
}

/* ---------- A. tarjetas de Ajustes abren su vista ---------- */
var SETTINGS_CARDS = [
  ['openOrbitView', 'orbit-view'],
  ['openPaymentsView', 'payments-view'],
  ['openAccountConfig', 'account-config-view'],
  ['openSecurityCenter', 'security-center-view'],
  ['openPrivacyConfigView', 'privacy-config-view'],
  ['openChatPrivacySettings', 'chat-privacy-settings-view'],
  ['openNotificationSettings', 'notification-settings-view'],
  ['openThemeConfig', 'theme-config-view'],
  ['openAppLanguageSettings', 'app-language-settings-view'],
  ['openTranslationsConfig', 'translations-config-view'],
  ['openCacheConfigView', 'cache-config-view'],
  ['openScreenTimeView', 'screentime-view'],
  ['openSubpageView', 'sleepmode-view'],       // openSubpageView('sleep-mode')
  ['openSupportModal', null],                   // modal, no es vista
  ['openSubpageView', 'empresa-view'],          // openSubpageView('empresa')
  ['openSubpageView', 'terms-view'],            // openSubpageView('terminos')
  ['openSubpageView', 'privacy-view'],          // openSubpageView('privacidad')
  ['signOutUser', null],
  ['closeSettingsView', null],
];
SETTINGS_CARDS.forEach(function (pair) {
  var fn = pair[0], view = pair[1];
  test('tarjeta ajustes -> ' + fn + (view ? ' abre ' + view : ''), function () {
    assert(defined(fn), 'onclick ' + fn + '() no está definido');
    if (view) {
      assert(src.indexOf('id="' + view + '"') !== -1, 'vista destino ' + view + ' no existe en el DOM');
      var b = fnBody(fn);
      assert(b.indexOf(view) !== -1 || fn === 'openSubpageView',
        fn + ' no referencia la vista ' + view);
    }
  });
});
test('openSubpageView mapea sleep-mode/empresa/terminos/privacidad', function () {
  var b = fnBody('openSubpageView');
  ['sleepmode-view', 'empresa-view', 'terms-view', 'privacy-view'].forEach(function (v) {
    assert(b.indexOf(v) !== -1 || src.indexOf("'" + v + "'") !== -1, 'SUBPAGE_VIEWS no mapea ' + v);
  });
  var map = src.slice(src.indexOf('const SUBPAGE_VIEWS'));
  ['sleep-mode', 'empresa', 'terminos', 'privacidad'].forEach(function (k) {
    assert(map.indexOf("'" + k + "'") !== -1, 'falta clave ' + k + ' en SUBPAGE_VIEWS');
  });
});

/* ---------- B. openHome repone la barra inferior ---------- */
test('openHome() restaura la barra inferior', function () {
  var b = fnBody('openHome');
  assert(b.indexOf('setBottomNavVisibility(true)') !== -1,
    'openHome no repone la barra inferior tras openProfile()');
});

/* ---------- C. closeSavedPostsView cierra de verdad ---------- */
test('closeSavedPostsView() oculta vista, desbloquea scroll y repone nav', function () {
  var b = fnBody('closeSavedPostsView');
  assert(b.indexOf("getElementById('saved-posts-view')") !== -1 &&
         b.indexOf("classList.add('hidden')") !== -1,
    'no oculta #saved-posts-view');
  assert(b.indexOf('unlockBodyScroll') !== -1, 'no desbloquea el scroll');
  assert(b.indexOf('setBottomNavVisibility(true)') !== -1, 'no repone la barra inferior');
});

/* ---------- D. sin emojis como iconos en la zona ---------- */
test('sin emojis-icono en vistas de ajustes/perfil/nav', function () {
  var views = ['settings-view', 'account-config-view', 'profile-view',
    'security-center-view', 'notification-settings-view', 'theme-config-view',
    'cache-config-view', 'chat-privacy-settings-view', 'app-language-settings-view',
    'screentime-view', 'side-panel-drawer', 'bottom-nav', 'top-nav',
    'author-profile-modal', 'orbit-view', 'payments-view'];
  var emojiRe = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF]/gu;
  var bad = [];
  views.forEach(function (v) {
    var r;
    try { r = viewRegion(v); } catch (e) { return; }
    var noSvg = r.replace(/<svg[\s\S]*?<\/svg>/g, '');
    // Se permite ✓ (U+2713) como marca de selección tipográfica, no como icono.
    var found = (noSvg.match(emojiRe) || []).filter(function (ch) { return ch !== '✓'; });
    if (found.length) bad.push(v + ' ' + found[0]);
  });
  assert(bad.length === 0, 'emojis como icono en: ' + bad.join(', '));
});

/* ---------- E. i18n de la zona ---------- */
function dictHas(lang, key) {
  var varName = lang === 'en' ? 'var APP_ENGLISH_TEXT = {' :
    lang === 'zh' ? 'var APP_CHINESE_TEXT = {' : 'var APP_PORTUGUESE_TEXT = {';
  var nextVar = lang === 'en' ? 'var APP_CHINESE_TEXT = {' :
    lang === 'zh' ? 'var APP_PORTUGUESE_TEXT = {' : 'var APP_CHINESE_ATTRS = {';
  var sec = i18nSrc.slice(i18nSrc.indexOf(varName), i18nSrc.indexOf(nextVar, i18nSrc.indexOf(varName)));
  return sec.indexOf('"' + key + '":') !== -1;
}
['Mensaje', 'Uso estimado: {s}'].forEach(function (key) {
  test('i18n ES/EN/ZH/PT: "' + key + '"', function () {
    ['en', 'zh', 'pt'].forEach(function (lang) {
      assert(dictHas(lang, key), 'clave "' + key + '" falta en ' + lang);
    });
  });
});
test('refreshCacheUsageUI usa appT (no ES hardcodeado)', function () {
  var b = fnBody('refreshCacheUsageUI');
  assert(b.indexOf("appT('Uso estimado: {s}')") !== -1,
    'el preview de caché sigue fijando el texto en español');
  assert(b.indexOf('`Uso estimado:') === -1, 'queda template literal en español');
});

/* ---------- F. perfil ajeno: seguir + mensaje + bloquear ---------- */
test('perfil ajeno tiene Seguir, Mensaje y Bloquear', function () {
  var r = viewRegion('author-profile-modal');
  assert(/id="follow-button"[^>]*onclick="followAuthor\(\)"/.test(r), 'falta botón Seguir');
  assert(/id="message-author-button"[^>]*onclick="openChatFromUserSelection\(currentViewedAuthorId\)"/.test(r),
    'falta botón Mensaje');
  assert(/id="block-button"[^>]*onclick="blockAuthor\(\)"/.test(r), 'falta botón Bloquear');
  assert(defined('openChatFromUserSelection'), 'openChatFromUserSelection no está definido');
});

/* ---------- G. data-nav-index secuencial ---------- */
test('data-nav-index de la barra inferior es 0,1,2,3,4', function () {
  var idx = [];
  var re = /id="nav-btn[^"]*" data-nav-index="(\d)"/g, m;
  while ((m = re.exec(src)) !== null) idx.push(m[1]);
  assert.deepStrictEqual(idx, ['0', '1', '2', '3', '4'], 'índices: ' + JSON.stringify(idx));
});

/* ---------- H. botón atrás en todas las vistas de la zona ---------- */
/* C249 (2026-10-03): orbit-view ya no lleva chevron atrás: por orden del
 * usuario su cabecera sigue la referencia Grok (X circular flotante que
 * llama closeOrbitView). Se acepta la X como control de salida válido;
 * el resto de vistas conserva el chevron. */
var ORBIT_CLOSE_RE = /orbit-x-btn[^>]*onclick="closeOrbitView\(\)"|onclick="closeOrbitView\(\)"/;
test('todas las vistas de la zona tienen botón atrás', function () {
  var views = ['settings-view', 'account-config-view', 'profile-config-view', 'profile-view',
    'security-center-view', 'notification-settings-view', 'theme-config-view', 'cache-config-view',
    'chat-privacy-settings-view', 'app-language-settings-view',
    'translations-config-view', 'screentime-view', 'sleepmode-view', 'terms-view', 'privacy-view',
    'orbit-view', 'payments-view', 'blocked-accounts-view', 'follow-requests-view', 'twofactor-view',
    'recovery-codes-view', 'changepassword-view', 'deactivate-delete-account-view',
    'username-config-view', 'email-config-view', 'password-config-view', 'birthday-config-view',
    'phone-config-view', 'direct-messages-config-view', 'parental-control-view', 'info-config-view',
    'pronouns-config-view', 'location-config-view', 'link-config-view', 'name-config-view',
    'author-profile-modal', 'saved-posts-view'];
  var chev = /M15\.75 19\.5L8\.25 12|M8\.25 4\.5l7\.5 7\.5|points="15 18 9 12 15 6"|M15 18l-6-6 6-6/;
  var missing = [];
  views.forEach(function (v) {
    var r;
    try { r = viewRegion(v); } catch (e) { missing.push(v + ' (sin DOM)'); return; }
    var head = r.slice(0, 5000);
    if (v === 'orbit-view') { if (!ORBIT_CLOSE_RE.test(head)) missing.push(v); return; }
    if (!chev.test(head)) missing.push(v);
  });
  assert(missing.length === 0, 'sin botón atrás: ' + missing.join(', '));
});

console.log('\n' + passed + ' pasados, ' + failed + ' fallidos');
if (failed > 0) { console.log('ROJO: hay fallos en carril 3'); process.exit(1); }
else { console.log('VERDE: carril 3 (ajustes/perfil/nav)'); }
