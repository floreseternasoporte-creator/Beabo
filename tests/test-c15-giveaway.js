// GIVEAWAY ciclo 15 — módulo "Artistas destacados" en el home.
//
// Verifica:
//  (a) sin config el módulo NO se renderiza (contenedor nace oculto y vacío;
//      featuredArtistsIsActive(null) === false),
//  (b) con config válida se renderizan 3 tarjetas con enlaces correctos
//      (openAuthorProfileByUsername por slot, ruta /u/<usuario>),
//  (c) fuera de ventana startsAt/endsAt no se muestra,
//  (d) nombres/URLs con HTML malicioso se escapan (XSS).
// Además: paridad i18n ES/EN/ZH de las claves nuevas y paridad index==404.
//
// Convención del repo: resuelve ../index.html con fallback a ../src/index.html;
// no depende del historial de git; sin rutas absolutas.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function findFile(names) {
  const cands = [];
  for (const n of names) {
    cands.push(path.join(__dirname, '..', n));
    cands.push(path.join(__dirname, '..', 'src', n));
  }
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('no encontrado: ' + names.join(' / '));
}
const htmlPath = findFile(['index.html']);
const htmlPath404 = findFile(['404.html']);
const i18nPath = findFile(['drex-i18n.js']);
const html = fs.readFileSync(htmlPath, 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}

function extractFn(name) {
  const i = html.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no encontrada: ' + name);
  let j = html.indexOf('{', i), depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}') { depth--; if (!depth) return html.slice(i, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}

// ---- 1. Estático: contenedor, hook y lectura del nodo -----------------------
check('HTML: contenedor #featured-artists existe', html.includes('id="featured-artists"'));
check('HTML: contenedor nace oculto y VACIO (sin ganadores inventados)',
  html.includes('<div id="featured-artists" class="hidden max-w-[680px] mx-auto px-4 pt-1 pb-2"></div>'));
check('HTML: el contenedor está dentro del home (antes del feed)',
  html.indexOf('id="featured-artists"') < html.indexOf('id="notes-feed"') &&
  html.indexOf('id="featured-artists"') > html.indexOf('id="drex-sort-bar"'));
check('JS: openHome invoca loadFeaturedArtists', html.includes('try { loadFeaturedArtists(); } catch (_) {}'));
check('JS: nodo de config es featuredArtists',
  html.includes("var FEATURED_ARTISTS_NODE = 'featuredArtists';"));
check('JS: lectura puntual del nodo de config',
  html.includes("db.ref(FEATURED_ARTISTS_NODE).once('value')"));
check('JS: resolución via índice usernames/<nombre>',
  html.includes("db.ref('usernames/' + uname.toLowerCase()).once('value')"));
check('JS: avatar desde users/<uid> (profileImage)',
  html.includes("db.ref('users/' + uid).once('value')"));
check('JS: sin config válida el módulo se oculta (hideFeaturedArtists)',
  html.includes("if (!featuredArtistsIsActive(cfg)) { hideFeaturedArtists(); return; }"));

// ---- 2. Sandbox con los escapers REALES del HTML ---------------------------
const sandbox = {
  window: { location: { origin: 'https://drex.test' } },
  URL, // el contexto vm no trae URL por defecto (en el navegador sí existe)
  // appT: en ES devuelve el original (comportamiento real para lang=es).
  appT: (s) => s,
  console,
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
for (const fn of ['escapeHTML', 'escapeSingleQuote', 'escapeInlineSingleQuote', 'getSafeMediaUrl']) {
  vm.runInContext(extractFn(fn), sandbox);
}
for (const fn of ['featuredArtistsIsActive', 'featuredArtistsNormalizeSlots',
                  'featuredArtistsCardHTML', 'featuredArtistsSectionHTML']) {
  vm.runInContext(extractFn(fn), sandbox);
}
vm.runInContext('var FEATURED_ARTISTS_MAX_SLOTS = 3;', sandbox);
const isActive = vm.runInContext('featuredArtistsIsActive', sandbox);
const normSlots = vm.runInContext('featuredArtistsNormalizeSlots', sandbox);
const cardHTML = vm.runInContext('featuredArtistsCardHTML', sandbox);
const sectionHTML = vm.runInContext('featuredArtistsSectionHTML', sandbox);

// ---- 3. featuredArtistsIsActive --------------------------------------------
const NOW = 1758854400000; // 2026-09-26 00:00 UTC aprox (fijo, no depende del reloj)
const cfgOk = {
  slots: [{ username: 'artista1' }, { username: 'artista2' }, { username: 'artista3' }],
  startsAt: NOW - 1000, endsAt: NOW + 7 * 86400000,
};
check('(a) sin config -> inactivo', isActive(null, NOW) === false);
check('(a) config undefined -> inactivo', isActive(undefined, NOW) === false);
check('(a) config {} -> inactivo', isActive({}, NOW) === false);
check('(a) slots vacío -> inactivo', isActive({ slots: [] }, NOW) === false);
check('(a) slots solo con usernames en blanco -> inactivo',
  isActive({ slots: [{ username: '   ' }, { username: '' }] }, NOW) === false);
check('(a) config no-objeto -> inactivo',
  isActive('featuredArtists', NOW) === false && isActive([{ username: 'a' }], NOW) === false);
check('(b) config válida dentro de ventana -> activo', isActive(cfgOk, NOW) === true);
check('(c) antes de startsAt -> inactivo',
  isActive({ ...cfgOk, startsAt: NOW + 1000 }, NOW) === false);
check('(c) después de endsAt -> inactivo',
  isActive({ ...cfgOk, endsAt: NOW - 1000 }, NOW) === false);
check('sin startsAt/endsAt -> activo (ventana abierta)',
  isActive({ slots: [{ username: 'a' }] }, NOW) === true);

// ---- 4. featuredArtistsNormalizeSlots --------------------------------------
const norm = normSlots({ slots: [
  { username: '  Ana ' }, { username: 'ANA', uid: 'u1' }, { username: '' },
  { username: 'beto' }, { username: 'Ceci' }, { username: 'dani' }, { username: 42 },
]});
check('normaliza: máx 3 slots', norm.length === 3);
check('normaliza: trim + dedup insensible a mayúsculas',
  norm[0].username === 'Ana' && norm[1].username === 'beto' && norm[2].username === 'Ceci');
check('normaliza: uid opcional se conserva cuando viene', normSlots({ slots: [{ username: 'x', uid: 'u9' }] })[0].uid === 'u9');
check('normaliza: uid ausente -> null', normSlots({ slots: [{ username: 'x' }] })[0].uid === null);

// ---- 5. Tarjetas: render + enlaces -----------------------------------------
const profiles = [
  { username: 'artista1', uid: 'u1', data: { displayName: 'Ana Beats', username: 'artista1', profileImage: 'https://cdn.test/a1.jpg' } },
  { username: 'artista2', uid: 'u2', data: { displayName: 'Beto Flow', username: 'artista2', profileImage: '' } },
  { username: 'artista3', uid: 'u3', data: {} },
];
const sec = sectionHTML(profiles, cfgOk);
check('(b) sección con 3 tarjetas (3 enlaces a perfil)',
  (sec.match(/openAuthorProfileByUsername\('/g) || []).length === 3);
check('(b) cada tarjeta enlaza a su usuario',
  sec.includes("openAuthorProfileByUsername('artista1')") &&
  sec.includes("openAuthorProfileByUsername('artista2')") &&
  sec.includes("openAuthorProfileByUsername('artista3')"));
check('(b) muestra nombre + @usuario', sec.includes('Ana Beats') && sec.includes('@artista1'));
check('(b) avatar http válido se usa tal cual',
  sec.includes('<img src="https://cdn.test/a1.jpg"'));
check('(b) sin foto -> inicial con fondo índigo (sin <img> roto)',
  (sec.match(/<img /g) || []).length === 1 && sec.includes('background:var(--drex-brand)'));
check('(b) título + píldora Giveaway presentes',
  sec.includes('Artistas destacados') && sec.includes('>Giveaway<'));
check('(b) título custom de la config se respeta (escapado)',
  sectionHTML(profiles, { ...cfgOk, title: 'Ganadores' }).includes('>Ganadores</h2>'));

// ---- 6. XSS: entradas maliciosas ------------------------------------------
const evil = {
  username: `x');alert('XSS-PWN');//`,
  uid: 'u9',
  data: {
    displayName: `<script>alert(2)</script>`,
    username: `<img src=x onerror=alert(3)>`,
    profileImage: 'javascript:alert(4)',
  },
};
const evilCard = cardHTML(evil);
check('(d) displayName con <script> se escapa', !evilCard.includes('<script>') && evilCard.includes('&lt;script&gt;'));
check('(d) no hay javascript: en src de imagen', !evilCard.includes('javascript:'));
check('(d) URL de avatar maliciosa -> sin <img> (fallback a inicial)', !evilCard.includes('<img '));
// El literal '...' del onclick debe redondear al username original.
function parseJsStringLiteral(handler, openIdx) {
  if (handler[openIdx] !== "'") return null;
  let out = '', i = openIdx + 1;
  while (i < handler.length) {
    const ch = handler[i];
    if (ch === '\\' && i + 1 < handler.length) { out += handler[i + 1]; i += 2; continue; }
    if (ch === "'") return { value: out, endIdx: i };
    out += ch; i++;
  }
  return null;
}
const onclickIdx = evilCard.indexOf('openAuthorProfileByUsername(');
const lit = parseJsStringLiteral(evilCard, evilCard.indexOf("'", onclickIdx));
check('(d) username malicioso en onclick: el literal redondea al original',
  !!lit && lit.value === evil.username);
// El atributo aria-label no debe romperse con comillas del username.
const ariaIdx = evilCard.indexOf('aria-label="');
const ariaVal = evilCard.slice(ariaIdx + 12, evilCard.indexOf('"', ariaIdx + 12));
check('(d) aria-label no contiene comilla cruda ni <', !ariaVal.includes('"') && !ariaVal.includes('<'));
const evilSec = sectionHTML([evil], { ...cfgOk, title: '<b>hack</b>' });
check('(d) título custom malicioso se escapa', !evilSec.includes('<b>hack</b>') && evilSec.includes('&lt;b&gt;hack&lt;/b&gt;'));

// ---- 7. i18n: paridad ES/EN/ZH ---------------------------------------------
const i18nSrc = fs.readFileSync(i18nPath, 'utf8');
const i18nBox = {};
vm.createContext(i18nBox);
vm.runInContext(i18nSrc, i18nBox);
const EN = i18nBox.APP_ENGLISH_TEXT, ZH = i18nBox.APP_CHINESE_TEXT;
check('i18n EN: "Artistas destacados" presente', EN && EN['Artistas destacados'] === 'Featured artists');
check('i18n EN: "Giveaway" presente', EN && EN['Giveaway'] === 'Giveaway');
check('i18n ZH: "Artistas destacados" presente', ZH && ZH['Artistas destacados'] === '精选艺术家');
check('i18n ZH: "Giveaway" presente', ZH && ZH['Giveaway'] === '赠奖活动');
check('i18n: "Ver perfil" ya existía en EN/ZH (aria-label)',
  EN['Ver perfil'] === 'View profile' && ZH['Ver perfil'] === '查看个人主页');
check('i18n: "Artista" ya existía en EN/ZH (fallback)',
  typeof EN['Artista'] === 'string' && typeof ZH['Artista'] === 'string');

// ---- 8. Paridad index.html == 404.html --------------------------------------
const html404 = fs.readFileSync(htmlPath404, 'utf8');
check('index.html byte-idéntico a 404.html', html === html404);

console.log(failures ? `\n${failures} checks FAILED` : '\ntest-c15-giveaway: TODO OK');
process.exit(failures ? 1 : 0);
