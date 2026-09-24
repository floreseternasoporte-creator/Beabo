// C105: regresión — las escrituras de localStorage en rutas críticas deben
// estar blindadas ante QuotaExceededError / almacenamiento no disponible
// (modo privado, cuota llena). Sin blindaje, un throw en setItem rompía:
//   - registerFailedLogin/clearLoginAttempts -> cadena de promesas del login
//     (botón atascado en spinner tras un fallo; post-login rechazado)
//   - botones sociales de login (Facebook/X) quedaban en "cargando"
//   - flujos menores: tema, idioma, tiempo en pantalla, ocultar post
// Test híbrido: asserts estáticos (fallan en base) + conductuales en sandbox
// vm con un localStorage cuyo setItem SIEMPRE lanza.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(__dirname, '..', 'index.html');
let html;
try { html = fs.readFileSync(htmlPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer index.html'); process.exit(1); }

let failures = 0;
function ok(name, cond) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name); }
}
// tcase: las llamadas al núcleo van envueltas en try/catch para que la base
// reporte FAILs limpios en vez de crashear el runner.
function tcase(name, fn) {
  try { fn(); console.log('ok - ' + name); }
  catch (e) { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); }
}

function extractFn(src, declLine) {
  const declIdx = src.indexOf(declLine);
  if (declIdx < 0) throw new Error('declaración no encontrada: ' + declLine);
  const braceIdx = src.indexOf('{', declIdx);
  let depth = 0;
  for (let i = braceIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(declIdx, i + 1); }
  }
  throw new Error('cierre no encontrado: ' + declLine);
}
function extractConst(src, name) {
  const m = src.match(new RegExp('(?:const|var|let)\\s+' + name + '\\s*=\\s*[^;]+;'));
  if (!m) throw new Error('const no encontrada: ' + name);
  return m[0];
}

// ---------- 1. Asserts estáticos: el blindaje existe ----------
ok('saveLoginAttempts blindado',
  /try\s*\{\s*localStorage\.setItem\(LOGIN_ATTEMPTS_KEY, JSON\.stringify\(data\)\);\s*\}\s*catch\s*\(\s*_\s*\)\s*\{\}/.test(html));
ok('login .then() drex_last_login_method blindado',
  html.includes("try { localStorage.setItem('drex_last_login_method', isUsername ? 'username' : 'email'); } catch (_) {}"));
ok('facebook drex_last_login_method blindado',
  html.includes("try { localStorage.setItem('drex_last_login_method', 'facebook'); } catch (_) {}"));
ok('twitter drex_last_login_method blindado',
  html.includes("try { localStorage.setItem('drex_last_login_method', 'twitter'); } catch (_) {}"));
ok('applyTheme persist blindado',
  html.includes('try { localStorage.setItem(THEME_STORAGE_KEY, safeTheme); } catch (_) {}'));
ok('applyAppLanguage blindado',
  html.includes("try { localStorage.setItem('selectedLanguage', lang); localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, lang); } catch (_) {}"));
ok('_stAddMinutes blindado',
  /try\s*\{\s*localStorage\.setItem\(ST_PREFIX \+ dateKey,/.test(html));
ok('_stSaveSettings blindado',
  html.includes('try { localStorage.setItem(ST_SETTINGS_KEY, JSON.stringify(obj)); } catch (_) {}'));
ok('setHiddenPosts blindado',
  html.includes("try { localStorage.setItem('drex_hidden_posts', JSON.stringify(hiddenPostIds)); } catch (_) {}"));
ok('resetScreenTimeToday blindado',
  html.includes("try { localStorage.setItem(ST_PREFIX + _stDateKey(), '0'); } catch (_) {}"));

// ---------- 2. Conductuales: con setItem que SIEMPRE lanza, nada escapa ----------
const PRELUDE = `
'use strict';
var localStorage = {
  getItem: function (k) { return null; },
  setItem: function (k, v) { var e = new Error('QuotaExceededError (simulado)'); e.name = 'QuotaExceededError'; throw e; },
  removeItem: function (k) {}
};
var document = {
  body: { classList: { toggle: function (c, f) { __toggles.push([c, f]); } } },
  documentElement: { style: {} }
};
var __toggles = [];
function updateThemeOptionButtons(t) { __updateThemeCalled = t; }
var __updateThemeCalled = null;
`;

function runInShieldedSandbox(bundle, callExpr) {
  const script = new vm.Script(PRELUDE + '\n' + bundle + '\n;__result = (' + callExpr + ');');
  const ctx = vm.createContext({ __result: null });
  script.runInContext(ctx, { timeout: 5000 });
  return ctx.__result;
}

let loginBundle, stBundle, miscBundle;
try {
  loginBundle =
    extractConst(html, 'LOGIN_ATTEMPTS_KEY') + '\n' +
    extractFn(html, 'function getLoginAttempts()') + '\n' +
    extractFn(html, 'function saveLoginAttempts(data)') + '\n' +
    extractFn(html, 'function registerFailedLogin(email)') + '\n' +
    extractFn(html, 'function clearLoginAttempts(email)');
  stBundle =
    extractConst(html, 'ST_PREFIX') + '\n' +
    extractConst(html, 'ST_SETTINGS_KEY') + '\n' +
    extractFn(html, 'function _stGetMinutes(dateKey)') + '\n' +
    extractFn(html, 'function _stAddMinutes(dateKey, mins)') + '\n' +
    extractFn(html, 'function _stSaveSettings(obj)');
  miscBundle =
    extractFn(html, 'function setHiddenPosts(hiddenPostIds)') + '\n' +
    extractConst(html, 'THEME_STORAGE_KEY') + '\n' +
    extractFn(html, 'function applyTheme(theme, persist = true)');
} catch (e) {
  console.error('FAIL: extracción: ' + e.message);
  process.exit(1);
}

tcase('saveLoginAttempts no lanza con setItem roto', () => {
  runInShieldedSandbox(loginBundle, "saveLoginAttempts({})");
});
tcase('registerFailedLogin devuelve el registro sin lanzar', () => {
  const r = runInShieldedSandbox(loginBundle, "registerFailedLogin('a@b.c')");
  if (!r || r.count !== 1) throw new Error('registro inesperado: ' + JSON.stringify(r));
});
tcase('clearLoginAttempts no lanza con setItem roto', () => {
  runInShieldedSandbox(loginBundle, "clearLoginAttempts('a@b.c')");
});
tcase('setHiddenPosts no lanza con setItem roto', () => {
  runInShieldedSandbox(miscBundle, "setHiddenPosts(['p1','p2'])");
});
tcase('_stAddMinutes no lanza con setItem roto', () => {
  runInShieldedSandbox(stBundle, "_stAddMinutes('2026-09-24', 5)");
});
tcase('_stSaveSettings no lanza con setItem roto', () => {
  runInShieldedSandbox(stBundle, "_stSaveSettings({dailyLimit: 120})");
});
tcase('applyTheme aplica las clases aunque el persist falle', () => {
  const res = runInShieldedSandbox(miscBundle,
    "(applyTheme('dark', true), JSON.stringify({t: __toggles, u: __updateThemeCalled}))");
  const parsed = JSON.parse(res);
  const hasDark = parsed.t.some(p => p[0] === 'theme-dark' && p[1] === true);
  if (!hasDark) throw new Error('theme-dark no aplicado: ' + res);
  if (parsed.u !== 'dark') throw new Error('updateThemeOptionButtons no corrió: ' + res);
});

console.log(failures === 0 ? 'C105-STORAGE-SHIELD: ALL PASS' : 'C105-STORAGE-SHIELD: ' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
