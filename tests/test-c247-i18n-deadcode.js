#!/usr/bin/env node
/* =====================================================================
 * C247 (2026-10-03) — caza de defectos ronda 2: textos duros en runtime
 * (HUNT 1) + código muerto del checkout hospedado (HUNT 2) + referencias
 * colgadas nuevas (HUNT 3). Incluye el fold-in del censo en vivo:
 *  - las pestañas del feed (Descubre/Mi gente/Destacados/Mi Marea) se
 *    veían en español con la app en inglés: viven dentro de
 *    #home-community-feed, zona que el walker salta (contenido de
 *    usuarios), así que ahora las fija syncFeedTabsI18n() con appT.
 *  - por CADA baldosa del Creator Hub se prueba handler + vista destino
 *    (nada de "dead taps" por grep suelto).
 *
 * Lo que EJECUTA (no solo grep):
 *  - syncFeedTabsI18n REAL sobre un DOM mínimo en en/zh/pt/es.
 *  - translateAppTextNode REAL (el walker) sobre los textos del hub.
 *  - el core DrexOrbit REAL en VM: subscribe/manage ya no existen;
 *    subscribeEmbedded sí y no redirige.
 *  - appT REAL para las claves nuevas.
 *
 * Uso: node tests/test-c247-i18n-deadcode.js
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const html404 = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');
const i18nJs = fs.readFileSync(path.join(ROOT, 'drex-i18n.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + msg); } };
const eq = (a, b, msg) => ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

/* ---------- sandbox base con los diccionarios reales ---------- */
function makeLangSandbox() {
  const store = {};
  const sandbox = {
    console,
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; },
    },
    navigator: { language: 'en' },
    __store: store,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(i18nJs, sandbox, { filename: 'drex-i18n.js' });
  return sandbox;
}
const dec = (raw) => raw.replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');

/* ============ 1. 404 idéntico + scripts parsean ============ */
console.log('-- C247.1: identidad 404 y sintaxis --');
eq(html404, html, '404.html byte-idéntico a index.html');
const scriptBlocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok(scriptBlocks.length >= 25, 'bloques inline localizados (' + scriptBlocks.length + ')');
let parseFails = 0;
for (const b of scriptBlocks) { try { new vm.Script(b); } catch (e) { parseFails++; console.log('    parse: ' + e.message.slice(0, 100)); } }
eq(parseFails, 0, 'todos los scripts inline parsean (node --check equivalente)');
try { new vm.Script(i18nJs); ok(true, 'drex-i18n.js parsea'); } catch (e) { ok(false, 'drex-i18n.js parsea: ' + e.message); }

/* ============ 2. Diccionarios: paridad + claves C247 ============ */
console.log('-- C247.2: diccionarios y claves nuevas --');
const sb0 = makeLangSandbox();
const EN = sb0.APP_ENGLISH_TEXT, ZH = sb0.APP_CHINESE_TEXT, PT = sb0.APP_PORTUGUESE_TEXT;
ok(EN && ZH && PT, 'diccionarios cargados');
eq(Object.keys(EN).length, Object.keys(ZH).length, 'paridad EN=ZH');
eq(Object.keys(EN).length, Object.keys(PT).length, 'paridad EN=PT');
const C247_KEYS = [
  '¿Qué opinas?', 'Activar micrófono', 'Silenciar micrófono', 'Mi Marea',
  'No se pudo activar. Revisa tu conexión e inténtalo de nuevo.',
  'No hay publicaciones de tipo "{tipo}" todavía.',
  'hace {n} min', 'hace {n} h', 'hace {n} día', 'hace {n} días', 'hace {n} semana', 'hace {n} semanas',
  'Demasiados intentos fallidos. Inténtalo de nuevo en {n} minuto{s}.',
  'Demasiados intentos fallidos. Inténtalo de nuevo en {n}s.', 'Te quedan {n} intento{s}.',
  'Iniciando...', 'Mínimo 3 caracteres.', '@{u} ya está en uso. Prueba otro.', '@{u} está disponible ✓',
  'No se pudo verificar. Revisa tu conexión y edita el nombre para reintentarlo.',
  'Ese nombre de usuario acaba de ser tomado. Prueba otro.',
  'Tu sesión es válida, pero no encontramos tu perfil. Complétalo aquí para activar tu cuenta.',
  'Tu cuenta necesita un nombre de usuario para continuar. Elige el tuyo en el siguiente paso.',
  'A tu cuenta le faltan algunos datos. Complétalos aquí para entrar.',
  'No pudimos recuperar tu sesión automáticamente. Revisa tu conexión e inicia sesión de nuevo.',
  'Tu sesión ha expirado. Vuelve a iniciar sesión.', 'Quitar de este dispositivo',
  'Límite: {v}', 'Límite diario de {n} min', 'País: {p}',
  'Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Básica', 'Buena', 'Muy buena',
  '{n}/4 protecciones configuradas', 'Ya no exigís que su cuenta sea privada',
  'Ya no restringís sus mensajes directos', 'Publicación sin texto',
  'Este usuario aún no ha agregado información.', 'Guardando tu canción…', 'Lista de reproducción',
  '¿Por qué reportas {cosa}?', 'Podrás volver a entrar el {fecha}.',
  '🔒 Tu cuenta tiene protecciones activadas por ser menor de 14 años, así que debe permanecer privada.',
  '🔒 Un adulto está supervisando tu cuenta y activó que debe permanecer privada.',
  'Imágenes', 'Contenido sensible oculto', 'No se pudo guardar {cosa}. Revisa tu conexión.',
  '{n} eco', '{n} ecos',
];
eq(C247_KEYS.length, 56, '56 claves C247 listadas');
for (const k of C247_KEYS) {
  ok((k in EN) && (k in ZH) && (k in PT), 'clave C247 en EN+ZH+PT: ' + JSON.stringify(k.slice(0, 44)));
}

/* ============ 3. Cobertura appT total (HUNT 3: sin claves huérfanas) ============ */
console.log('-- C247.3: todo appT() resuelve en EN+ZH+PT --');
const appTRe = /(?:appT|[^A-Za-z]t)\(\s*'((?:[^'\\]|\\.)*)'/g;
const missingKeys = new Set();
for (const b of scriptBlocks) {
  let m;
  appTRe.lastIndex = 0;
  while ((m = appTRe.exec(b))) {
    const k = dec(m[1]);
    if (k.startsWith('baro.')) continue; // registro propio de Baro (BARO_UI_I18N)
    if (!(k in EN) || !(k in ZH) || !(k in PT)) missingKeys.add(k);
  }
}
/* 'Drex Orbit' es marca: appT cae a la fuente, idéntica en los 4 idiomas. */
eq([...missingKeys].filter((k) => k !== 'Drex Orbit').length, 0,
  'ningún literal appT sin clave (faltan: ' + [...missingKeys].slice(0, 5).join(' | ') + ')');
/* setI18nAttr: la clave debe existir en TEXT para que el atributo nazca traducido */
const siaRe = /setI18nAttr\([^,]+,\s*'[^']+',\s*'((?:[^'\\]|\\.)*)'\)/g;
const siaMissing = [];
{ let m; while ((m = siaRe.exec(html))) { const k = dec(m[1]); if (!(k in EN)) siaMissing.push(k); } }
eq(siaMissing.length, 0, 'toda clave setI18nAttr existe en TEXT EN (faltan: ' + siaMissing.join(' | ') + ')');

/* ============ 4. HUNT 2: código muerto del checkout hospedado ============ */
console.log('-- C247.4: LEGADO redirect eliminado --');
for (const gone of ['/create-subscription-session', '/create-customer-portal',
  'subscribe: async function', 'manage: async function', 'location.href = data.url',
  "'Límite: ' +", "return `hace ${min} min`", 'Demasiados intentos fallidos. Inténtalo de nuevo en ${mins}']) {
  ok(!html.includes(gone), 'fuera de index.html: ' + JSON.stringify(gone));
  ok(!html404.includes(gone), 'fuera de 404.html: ' + JSON.stringify(gone));
}
ok(html.includes("this._postData('/subscribe-embedded', { plan: planId })"), 'subscribeEmbedded postea {plan} a /subscribe-embedded');
for (const ep of ['/subscription-cancel', '/subscription-reactivate', '/subscription-setup', '/subscription-status', '/transactions']) {
  ok(html.includes(ep), 'endpoint vivo presente: ' + ep);
}
ok(/function orbitSubscribe\(planId\)[\s\S]{0,500}?openOrbitCheckout\(planId\)/.test(html), 'orbitSubscribe abre la hoja embebida');
ok(/async function orbitManage\(\)[\s\S]{0,300}?openOrbitManage\(\)/.test(html), 'orbitManage abre la hoja propia');
ok(html.includes("fetch(ep + '/subscribe-embedded'"), 'drexPayNetDiag sonda el endpoint embebido');

/* VM: el core real ya no trae los métodos muertos */
const mCore = html.match(/\/\* =+\n \* DREX ORBIT — suscripción Orbit de Drex[\s\S]*?window\.DREX_ORBIT_ENFORCE = false;/);
ok(!!mCore, 'bloque core DrexOrbit extraíble');
{
  const store = {};
  const sandbox = {
    console, setTimeout: () => 0, clearTimeout: () => {},
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    location: { origin: 'https://x.test', pathname: '/Beabo/', href: 'https://x.test/Beabo/', search: '' },
    document: { readyState: 'complete', addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } },
    fetch: async () => { throw new Error('no-network-in-test'); },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(mCore[0], sandbox);
  const K = sandbox.DrexOrbit;
  ok(K && typeof K === 'object', 'DrexOrbit cargado en VM');
  eq(typeof K.subscribe, 'undefined', 'DrexOrbit.subscribe ELIMINADO');
  eq(typeof K.manage, 'undefined', 'DrexOrbit.manage ELIMINADO');
  eq(typeof K.subscribeEmbedded, 'function', 'DrexOrbit.subscribeEmbedded vivo');
  eq(typeof K.subscriptionCancel, 'function', 'DrexOrbit.subscriptionCancel vivo');
  eq(typeof K.subscriptionReactivate, 'function', 'DrexOrbit.subscriptionReactivate vivo');
  eq(typeof K.subscriptionSetup, 'function', 'DrexOrbit.subscriptionSetup vivo');
}

/* ============ 5. Census: pestañas del feed en el idioma de la app ============ */
console.log('-- C247.5: feed tabs (censo en vivo) --');
for (const [tab, es] of [['foryou', 'Descubre'], ['following', 'Mi gente'], ['popular', 'Destacados'], ['marea', 'Mi Marea']]) {
  ok(html.includes('data-tab="' + tab + '"'), 'pestaña presente: ' + tab);
  ok(html.includes('<span>' + es + '</span>'), 'etiqueta ES fuente presente: ' + es);
}
ok(html.includes('function syncFeedTabsI18n()'), 'syncFeedTabsI18n definida');
ok(html.includes('syncAppLanguageUI(lang); syncFeedTabsI18n(); startAppLanguageObserver();'), 'applyAppLanguage fija las pestañas en cada cambio de idioma');
{
  /* Ejecuta el mecanismo i18n REAL (getAppLanguage/appT/setI18nAttr +
   * syncFeedTabsI18n extraídos de index.html) con los diccionarios reales. */
  const i0 = html.indexOf('const APP_LANGUAGE_STORAGE_KEY');
  const i1 = html.indexOf('function syncAppLanguageUI');
  ok(i0 !== -1 && i1 > i0, 'bloque i18n extraíble');
  const sb = makeLangSandbox();
  const spans = {};
  const ES0 = { foryou: 'Descubre', following: 'Mi gente', popular: 'Destacados', marea: 'Mi Marea' };
  sb.document = {
    querySelector(sel) {
      const mm = /data-tab="(\w+)"/.exec(sel);
      if (!mm) return null;
      const tab = mm[1];
      if (!spans[tab]) spans[tab] = { textContent: ES0[tab] };
      return { querySelector: () => spans[tab] };
    },
  };
  vm.runInContext(html.slice(i0, i1), sb, { filename: 'i18n-block.js' });
  eq(typeof sb.syncFeedTabsI18n, 'function', 'syncFeedTabsI18n ejecutable en VM');
  const expected = {
    en: { foryou: 'Discover', following: 'My people', popular: 'Featured', marea: 'My Marea' },
    zh: { foryou: '发现', following: '我的圈子', popular: '精选', marea: '我的 Marea' },
    pt: { foryou: 'Descubra', following: 'Minha gente', popular: 'Destaques', marea: 'Minha Marea' },
    es: ES0,
  };
  for (const lang of ['en', 'zh', 'pt', 'es']) {
    sb.localStorage.setItem('drex_app_language_v1', lang);
    for (const t of Object.keys(spans)) spans[t].textContent = ES0[t];
    sb.syncFeedTabsI18n();
    for (const tab of Object.keys(ES0)) eq(spans[tab].textContent, expected[lang][tab], 'tab ' + tab + ' en ' + lang);
  }
  sb.__store && delete sb.__store.drex_app_language_v1;
  sb.localStorage.removeItem('drex_app_language_v1');
  eq(sb.getAppLanguage(), 'en', 'sin idioma guardado, el default de la app es inglés (orden vigente)');
}

/* ============ 6. Census: Creator Hub — handler + destino por baldosa ============ */
console.log('-- C247.6: Creator Hub (handler + vista por baldosa) --');
const iHub = html.indexOf('id="creator-hub-view"');
const iPulso = html.indexOf('id="pulso-view"', iHub);
ok(iHub !== -1 && iPulso > iHub, 'bloque #creator-hub-view localizable');
const hub = html.slice(iHub, iPulso);
const fnDefined = (name) => new RegExp('function ' + name + '\\s*\\(').test(html) || html.includes('window.' + name + ' = function');
const idExists = (id) => html.includes('id="' + id + '"');

/* Baldosa Post */
ok(hub.includes('onclick="creatorHubSelectFormat(\'post\')"'), 'baldosa Post con onclick creatorHubSelectFormat');
ok(fnDefined('creatorHubSelectFormat'), 'creatorHubSelectFormat definida');
ok(/function creatorHubSelectFormat\(format\)[\s\S]{0,220}?openNoteCreationFullscreen\(format\)/.test(html), 'creatorHubSelectFormat abre el compositor');
ok(fnDefined('openNoteCreationFullscreen'), 'openNoteCreationFullscreen definida');
ok(idExists('note-creation-fullscreen'), 'vista #note-creation-fullscreen existe');
/* Baldosa En vivo */
ok(hub.includes('onclick="openEnVivoSection()"'), 'baldosa En vivo con onclick openEnVivoSection');
ok(fnDefined('openEnVivoSection'), 'openEnVivoSection definida');
ok(/function openEnVivoSection\(\)[\s\S]{0,220}?getElementById\('envivo-view'\)/.test(html), 'openEnVivoSection muestra #envivo-view');
ok(idExists('envivo-view'), 'vista #envivo-view existe');
/* Baldosa Música */
ok(hub.includes('window.musicCardTap'), 'baldosa Música con cadena musicCardTap/openMusicSection');
ok(html.includes('window.musicCardTap = function'), 'window.musicCardTap definida');
ok(html.includes('window.openMusicSection = function'), 'window.openMusicSection definida');
ok(idExists('music-view'), 'vista #music-view existe');
/* Botones del encabezado del hub */
ok(hub.includes('onclick="closeCreatorHub()"') && fnDefined('closeCreatorHub'), 'botón cerrar del hub cableado');
ok(hub.includes('onclick="openNoteCreation()"') && fnDefined('openNoteCreation'), 'botón crear del hub cableado');
/* Los textos del hub pasan por el walker REAL: en inglés no queda español */
{
  const sb = makeLangSandbox();
  const i0 = html.indexOf('const APP_LANGUAGE_STORAGE_KEY');
  const i1 = html.indexOf('function syncAppLanguageUI');
  sb.document = { querySelector: () => null };
  vm.runInContext(html.slice(i0, i1), sb, { filename: 'i18n-block.js' });
  const hubTexts = [
    'Crear contenido', 'Nuevo Post', 'Publica tus pensamientos, actualizaciones o anuncios. Haz que tu voz resuene.',
    'En vivo', 'Crea una llamada grupal en vivo para practicar idiomas hablando con otros usuarios.',
    'Música', 'Sube tu música, crea tu nombre de artista y deja que todos la escuchen.',
  ];
  for (const txt of hubTexts) {
    ok(hub.includes(txt), 'texto del hub presente en markup: ' + JSON.stringify(txt.slice(0, 30)));
    const node = { nodeValue: '  ' + txt + ' ', parentElement: { closest: () => null } };
    sb.translateAppTextNode(node, 'en');
    eq(node.nodeValue.trim(), EN[txt], 'walker traduce el texto del hub a EN: ' + JSON.stringify(txt.slice(0, 30)));
    ok(node.nodeValue.trim() !== txt, 'sin resto en español (EN): ' + JSON.stringify(txt.slice(0, 30)));
  }
}

/* ============ 7. Wraps C247: los sitios compuestos ya van por appT ============ */
console.log('-- C247.7: sitios corregidos (fuente) --');
const wraps = [
  ["appT('Estás al día')", 'sentinel de fin del feed'],
  ["appT('No hay publicaciones de tipo \"{tipo}\" todavía.')", 'vacío por tipo de feed'],
  ["appT('No hay mensajes aún.')", 'vacío del chat de grupo (zona saltada)'],
  ["appT('¿Por qué reportas {cosa}?')", 'marco de la pregunta de reporte'],
  ["appT('Podrás volver a entrar el {fecha}.')", 'fecha de regreso (cuenta desactivada)'],
  ["appT('Lista de reproducción')", 'nombre por defecto de playlist'],
  ["musicSetProgress(75, appT('Guardando tu canción…'))", 'progreso de subida de música'],
  ["appT('Demasiados intentos fallidos. Inténtalo de nuevo en {n} minuto{s}.')", 'bloqueo anti fuerza bruta'],
  ["appT('@{u} está disponible ✓')", 'usuario disponible'],
  ["'hace {n} semanas'", 'tiempo relativo'],
  ["appT('{n}/4 protecciones configuradas')", 'marcador de seguridad'],
  ["appT('Límite diario de {n} min')", 'chip de límite parental'],
  ["appT('País: {p}')", 'title de la bandera de país'],
  ["appT('No se pudo guardar {cosa}. Revisa tu conexión.')", 'toast de guardado onboarding'],
  ["appT('Publicación sin texto')", 'fallback del historial'],
];
for (const [needle, label] of wraps) ok(html.includes(needle), 'wrap presente (' + label + '): ' + needle.slice(0, 40));

/* ============ resumen ============ */
console.log('\nC247: ' + pass + ' ok, ' + fail + ' fallos');
process.exit(fail ? 1 : 0);
