#!/usr/bin/env node
/* C236: tests de la fusión Fiestas + En vivo -> sección única "En vivo".
 * Lee los candidatos generados (index.html, drex-i18n.js, 404.html).
 * Verifica: una sola sección pública, tabs Video|Fiestas de voz, Video por
 * defecto, ruta canónica + alias legacy, ausencia de textos públicos legacy,
 * i18n sin duplicados fuente, compatibilidad de BD interna y juego intacto. */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const DIR = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(DIR, 'drex-i18n.js'), 'utf8');
const html404 = fs.readFileSync(path.join(DIR, '404.html'), 'utf8');

let n = 0;
function t(name, cond) {
  n++;
  assert(cond, 'C236 FAIL: ' + name);
  console.log('ok ' + n + ' - ' + name);
}

// 1. Una sola sección pública "En vivo"
t('existe envivo-view una vez', (html.match(/id="envivo-view"/g) || []).length === 1);
t('no existe fiesta-view', !html.includes('id="fiesta-view"'));
t('header de la vista dice En vivo', html.includes('<h2 id="envivo-title" class="text-lg font-extrabold">En vivo</h2>'));
t('no hay function openFiestaSection', !html.includes('function openFiestaSection'));
t('existe function openEnVivoSection', html.includes('function openEnVivoSection'));
t('existe function closeEnVivoSection', html.includes('function closeEnVivoSection'));

// 2. Tabs Video | Fiestas de voz
t('tab Video existe', html.includes('id="envivo-tab-btn-video"'));
t('tab Fiestas de voz existe', html.includes('id="envivo-tab-btn-voz"'));
t('tab Video marcado activo por defecto', /id="envivo-tab-btn-video"[^>]*aria-selected="true"[^>]*class="[^"]*drex-live-tab-active/.test(html));
t('etiqueta Fiestas de voz visible', html.includes('>Fiestas de voz</span>'));
t('panel video existe', html.includes('id="envivo-pane-video"'));
t('panel voz existe', html.includes('id="envivo-pane-voz"'));
t('existe drexEnVivoSwitchTab', html.includes('window.drexEnVivoSwitchTab = function'));
t('alias drexFiestaSwitchTab existe', html.includes('window.drexFiestaSwitchTab = function'));

// 3. Video abre por defecto (bug rojo->verde: open forzaba tab fiesta)
t('openEnVivoSection abre tab video', /function openEnVivoSection\(\)[\s\S]{0,2500}?drexEnVivoSwitchTab\('video'\)/.test(html));
t('ningun open fuerza tab fiesta', !/drexFiestaSwitchTab\('fiesta'\)/.test(html));
t('switch: video muestra lista de en vivos', /function \(tab\) \{\s*\n?\s*var isVideo = \(tab !== 'voz'\)/.test(html));

// 4. Ruta canónica + alias legacy (sin doble entrada DREX_ROUTES)
t('una sola entrada envivo en DREX_ROUTES', (html.match(/path: 'envivo'/g) || []).length === 1);
t('ninguna entrada path fiestas en DREX_ROUTES', !/path: 'fiestas'/.test(html));
t('alias /^fiestas$/ -> envivo (V9)', html.includes("[/^fiestas$/, 'envivo']"));
t('alias /^fiestas$/ -> envivo (V8)', (html.match(/\[\/\^fiestas\$\/, 'envivo'\]/g) || []).length === 2);
t('regex acepta en vivo / en-vivo', html.includes('[/^en[ -]?vivo$/, \'envivo\']'));

// 5. Textos públicos legacy ausentes
for (const s of ['>Fiestas</p>', '<h3>Fiestas</h3>', 'aria-label="Toggle fiestas"',
                 'Buscar fiestas en vivo', 'Fiestas de seguidos',
                 'Juegos de la fiesta<', 'Oyentes de la fiesta<']) {
  t('sin texto público legacy: ' + s.slice(0, 28), !html.includes(s));
}
t('sin texto público legacy: Crear fiesta', !/Crear fiesta(?! de voz)/.test(html));
t('Baro route label es En vivo', i18n.includes("'baro.v10.route.fiestas'") || html.includes("'baro.v10.route.fiestas'"));
t('notif header En vivo', html.includes('>En vivo</p>'));

// 6. i18n: sin duplicados fuente, paridad, claves nuevas/viejas
function dictKeys(src, varName) {
  const st = src.indexOf('var ' + varName + ' = {');
  assert(st >= 0, 'falta ' + varName);
  const next = src.indexOf('var APP_', st + 10);
  const body = src.slice(st, next < 0 ? undefined : next);
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"\s*:|'((?:[^'\\]|\\.)*)'\s*:/g;
  let m;
  while ((m = re.exec(body))) out.push(m[1] || m[2]);
  return out;
}
for (const v of ['APP_ENGLISH_TEXT', 'APP_CHINESE_TEXT', 'APP_PORTUGUESE_TEXT',
                 'APP_ENGLISH_ATTRS', 'APP_CHINESE_ATTRS', 'APP_PORTUGUESE_ATTRS']) {
  const ks = dictKeys(i18n, v);
  const seen = new Set();
  let dups = 0;
  for (const k of ks) { if (seen.has(k)) dups++; seen.add(k); }
  t('sin duplicados fuente en ' + v, dups === 0);
}
const enT = new Set(dictKeys(i18n, 'APP_ENGLISH_TEXT'));
const zhT = new Set(dictKeys(i18n, 'APP_CHINESE_TEXT'));
const ptT = new Set(dictKeys(i18n, 'APP_PORTUGUESE_TEXT'));
t('paridad TEXT EN=ZH=PT', enT.size === zhT.size && zhT.size === ptT.size);
for (const k of ['Fiesta de voz', 'Unirse a la fiesta de voz', 'Fiesta de voz terminada',
                 'Crear fiesta de voz', 'En vivo de seguidos']) {
  t('clave nueva TEXT: ' + k, enT.has(k) && zhT.has(k) && ptT.has(k));
}
t('clave vieja eliminada: Crear fiesta', !enT.has('Crear fiesta'));
t('clave vieja eliminada: Fiestas de seguidos', !enT.has('Fiestas de seguidos'));
const enA = new Set(dictKeys(i18n, 'APP_ENGLISH_ATTRS'));
t('attr nuevo: Activar En vivo', enA.has('Activar En vivo'));

// 7. Compatibilidad interna: paths, campos, intents
for (const p of ['fiestaMembers/', 'fiestaSignals/', 'fiestaReactions/', 'fiestaKicked/',
                 'fiestaGameSecrets/', 'postsByFiesta/', 'lives/', 'liveChat/',
                 'liveViewers/', 'liveGifts/', 'liveSignals/']) {
  t('path BD conservado: ' + p, html.includes(p));
}
for (const f of ['fiestaId', 'fiestaTitle', 'fiestaLang', 'fiestaDesc', 'fiestaStatus', 'fiestaMax']) {
  t('campo conservado: ' + f, html.includes(f));
}
t("type === 'fiesta' conservado", html.includes("type === 'fiesta'"));
t('pref notifications.fiestas conservada', html.includes("'fiestas'") && html.includes('notif-toggle-fiestas'));
t('intents Baro fiesta_* conservados', /fiesta_crear|fiesta_unirse|fiesta_salir/.test(html));

// 8. Juego "Quién es el mentiroso" intacto
t('juego mentiroso presente', html.includes('mentiroso'));
t('fiestaGameSecrets presente', html.includes('fiestaGameSecrets'));
t('hoja juegos de la sala de voz', html.includes('Juegos de la sala de voz'));

// 9. 404.html byte-idéntico
t('404.html idéntico a index.html', html404 === html);

// 10. Cero SpaceX
t('cero SpaceX en index.html', !/spacex/i.test(html));
t('cero SpaceX en drex-i18n.js', !/spacex/i.test(i18n));

console.log('\nC236: ' + n + ' checks verdes');
