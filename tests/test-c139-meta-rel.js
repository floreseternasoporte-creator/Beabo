// C139: familias NUEVAS "meta tags" + "<details>/<summary>" + "rel en enlaces".
//
// AUDITORIA (2026-09-24, base 5ccb14c5a9eed9b75b41ba6671a66e14e29e51e9,
// hit por hit, index.html + child-safety.html + privacy.html + *.js raiz):
//
// 1. meta tags (superficie compartir/preview, nunca auditada): el head ya
//    traia el bloque de 11 tags (C22: description, og:*, twitter:*);
//    og:image/twitter:image verificadas HTTP 200 en vivo (drex-logo.png).
//    LEADS (2): sin <link rel="canonical"> (0 hits) y sin og:locale (app
//    ES-primaria; OG defaultea a en_US). Fix: canonical a la raiz de Pages
//    + og:locale es_ES junto a og:site_name.
// 2. <details>/<summary> (nunca auditado): UN SOLO USO repo-wide, en
//    drex-data-export.js (linea 689): disclosure nativo "Ver datos" del
//    reporte HTML descargable de "Descargar mis datos". Nativamente
//    accesible por teclado; todo el contenido pasa por esc() (sin XSS);
//    es un reporte estatico descargado, no hay estado que persistir ->
//    uso legitimo, SIN CAMBIO.
// 3. rel en enlaces (mas alla del noopener de C112/C134):
//    - Inventario: 7 <a target="_blank"> en index.html; TODOS con noopener
//      (C134 aserta el conteo); 0 target=_blank en child-safety/privacy/*.js.
//      child-safety (cybertip/inhop) y privacy (aws) navegan en la misma
//      pestana -> sin tabnabbing, sin rel necesario -> SIN CAMBIO.
//    - LEADS (1): los 5 anchors con URLs GENERADAS POR USUARIOS no llevaban
//      el token semantico `ugc` (profile-link-anchor, escaparate propio
//      l.u, socialLinks l.u, website legacy, permalink note.url).
//      Fix: rel="noopener ugc" (y "noopener noreferrer ugc" en el permalink).
//      Los 2 de primera parte (banner Play Store, drp-btn play.google.com)
//      quedan con noopener puro a proposito.
'use strict';
const fs = require('fs');
const path = require('path');

function pickTarget(def, flag) {
  const a = process.argv.find(x => x.startsWith(flag + '='));
  return a ? a.slice(flag.length + 1) : path.join(__dirname, '..', def);
}
const htmlPath = pickTarget('index.html', '--target');
const html = fs.readFileSync(htmlPath, 'utf8');
const repoRoot = path.join(__dirname, '..');
function readOpt(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
const csHtml = readOpt(path.join(repoRoot, 'child-safety.html'));
const prHtml = readOpt(path.join(repoRoot, 'privacy.html'));

let failures = 0;
function tcase(name, fn) {
  try { fn() ? console.log('ok - ' + name) : (failures++, console.error('FAIL - ' + name)); }
  catch (e) { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); }
}

// ---------- META TAGS ----------
tcase('meta description presente', () =>
  html.includes('<meta name="description" content="Drex'));

tcase('bloque OG completo: type, site_name, title, description, image, url', () =>
  ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:image', 'og:url']
    .every(p => html.includes('property="' + p + '"')));

tcase('bloque Twitter completo: card, title, description, image', () =>
  ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']
    .every(p => html.includes('name="' + p + '"')));

tcase('og:locale es_ES presente (C139)', () =>
  html.includes('<meta property="og:locale" content="es_ES" />'));

tcase('canonical a la raiz de Pages (C139)', () =>
  html.includes('<link rel="canonical" href="https://floreseternasoporte-creator.github.io/Beabo/" />'));

tcase('og:image/twitter:image absolutas a drex-logo.png', () => {
  const imgs = [...html.matchAll(/og:image" content="([^"]+)"/g)].map(m => m[1])
    .concat([...html.matchAll(/twitter:image" content="([^"]+)"/g)].map(m => m[1]));
  return imgs.length >= 2 && imgs.every(u => u === 'https://floreseternasoporte-creator.github.io/Beabo/drex-logo.png');
});

tcase('titulos consistentes con la marca Drex', () =>
  html.includes('og:title" content="Drex') && html.includes('twitter:title" content="Drex'));

// ---------- DETAILS/SUMMARY (cero) ----------
tcase('<details> cero en index.html', () => !/<details[\s>]/i.test(html));
tcase('<summary> cero en index.html', () => !/<summary[\s>]/i.test(html));
tcase('<details>/<summary>: unico uso legitimo en drex-data-export.js (reporte descargable, escapado)', () => {
  const jsFiles = fs.readdirSync(repoRoot).filter(f => f.endsWith('.js'));
  const hits = [];
  jsFiles.forEach(f => {
    const s = fs.readFileSync(path.join(repoRoot, f), 'utf8');
    [...s.matchAll(/<details[\s>]/gi)].forEach(m => hits.push(f + ':' + m.index));
    [...s.matchAll(/<summary[\s>]/gi)].forEach(m => hits.push(f + ':' + m.index));
  });
  const expSrc = fs.readFileSync(path.join(repoRoot, 'drex-data-export.js'), 'utf8');
  const escaped = expSrc.includes("'<details><summary>' + esc(");
  return hits.length === 2 && hits.every(h => h.startsWith('drex-data-export.js:')) && escaped;
});

// ---------- REL EN ENLACES ----------
tcase('7 <a target="_blank">, TODOS con noopener', () => {
  const tags = html.match(/<a[^>]*target="_blank"[^>]*>/g) || [];
  return tags.length === 7 && tags.every(t => /rel="[^"]*noopener/.test(t));
});

tcase('token ugc en los 4 anchors UGC con noopener puro (C139)', () =>
  (html.match(/rel="noopener ugc"/g) || []).length === 4);

tcase('permalink UGC conserva noreferrer + ugc (C139)', () =>
  (html.match(/rel="noopener noreferrer ugc"/g) || []).length === 1);

tcase('anchors de primera parte (banner Play, drp-btn) SIN ugc', () => {
  const banner = (html.match(/<a[^>]*id="play-store-banner-link"[^>]*>/g) || [])[0] || '';
  const drp = (html.match(/<a[^>]*class="drp-btn"[^>]*>/g) || [])[0] || '';
  return banner.includes('rel="noopener"') && !/ugc/.test(banner)
      && drp.includes('rel="noopener"') && !/ugc/.test(drp);
});

tcase('profile-link-anchor UGC lleva ugc', () =>
  /<a[^>]*id="profile-link-anchor"[^>]*rel="[^"]*ugc/.test(html));

tcase('child-safety/privacy: enlaces externos SIN target=_blank (sin tabnabbing)', () => {
  if (csHtml === null || prHtml === null) return true; // fuera de la raiz del repo: no aplica
  const ext = s => (s.match(/<a[^>]*href="https?:\/\/[^"]*"[^>]*>/g) || []);
  return ext(csHtml).every(t => !/target=/.test(t)) && ext(prHtml).every(t => !/target=/.test(t));
});

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
