'use strict';
// Tests de DESTACADOS de perfil — fase 2 del Escaparate (Ciclo 87).
// Uso: node test-c87-destacados.js [--target <html>]
//   --target: HTML a probar (default: ../index.html, el parcheado).
// Diseñados para FALLAR contra la base sin parche.
//
// Verifica:
//  (a) drexFeaturedNormalize + DREX_FEATURED_MAX (extraídos verbatim del HTML
//      y ejecutados en sandbox): matriz de decisión, ids vacíos/ts inválidos
//      descartados, valores numéricos preservados;
//  (b) drexFeaturedSortPosts (extraído verbatim): destacados primero por
//      pinnedAt desc (desempate por timestamp), resto por timestamp desc,
//      marca _featuredAt, ids huérfanos ignorados;
//  (c) integración estática: botón feature-post-btn en la hoja (solo autor),
//      toggleFeaturedPost con guardia de autor y cap 3, limpieza en
//      cascadeDeleteNote, orden en los dos grids de perfil (propio y ajeno),
//      cabecera "Destacado" con wrapper fuera del .drex-post, claves i18n
//      EN/ZH/PT sin duplicados, superficie de BD acotada a users/.
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
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*([^;]+);').exec(src);
  if (!m) throw new Error('const no encontrada en el HTML: ' + name);
  return 'const ' + name + ' = ' + m[1] + ';';
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

let normalize, sortPosts, MAX;
try {
  const code =
    extractConst(html, 'DREX_FEATURED_MAX') + '\n' +
    extractFunction(html, 'drexFeaturedNormalize') + '\n' +
    extractFunction(html, 'drexFeaturedSortPosts') + '\n' +
    'module.exports = { drexFeaturedNormalize, drexFeaturedSortPosts, DREX_FEATURED_MAX };';
  const sandbox = { module: { exports: {} } };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'destacados-core.js' });
  const ex = sandbox.module.exports;
  normalize = ex.drexFeaturedNormalize;
  sortPosts = ex.drexFeaturedSortPosts;
  MAX = ex.DREX_FEATURED_MAX;
  ok(true, 'extracción verbatim del núcleo desde el HTML');
} catch (e) {
  ok(false, 'extracción verbatim del núcleo desde el HTML (' + e.message + ')');
  normalize = () => { throw e; };
  sortPosts = () => { throw e; };
  MAX = -1;
}

// ================= T1: constante =================
tcase('T1', () => {
  ok(MAX === 3, 'T1a DREX_FEATURED_MAX === 3');
});

// ================= T2: normalize — entradas inválidas =================
tcase('T2', () => {
  eq(normalize(null), {}, 'T2a null → {}');
  eq(normalize(undefined), {}, 'T2b undefined → {}');
  eq(normalize('n1'), {}, 'T2c string → {}');
  eq(normalize(42), {}, 'T2d número → {}');
  eq(normalize(['n1']), {}, 'T2e array → {}');
  eq(normalize({}), {}, 'T2f objeto vacío → {}');
});

// ================= T3: normalize — descarte fino =================
tcase('T3', () => {
  eq(normalize({ '': 100 }), {}, 'T3a id vacío descartado');
  eq(normalize({ '   ': 100 }), {}, 'T3b id solo-espacios descartado');
  eq(normalize({ n1: 0 }), {}, 'T3c ts 0 descartado');
  eq(normalize({ n1: -5 }), {}, 'T3d ts negativo descartado');
  eq(normalize({ n1: NaN }), {}, 'T3e ts NaN descartado');
  eq(normalize({ n1: 'abc' }), {}, 'T3f ts no-numérico descartado');
  eq(normalize({ n1: null }), {}, 'T3g ts null→0 descartado');
  eq(normalize({ n1: 1700000000000 }), { n1: 1700000000000 }, 'T3h ts válido preservado');
  eq(normalize({ n1: '1700000000000' }), { n1: 1700000000000 }, 'T3i ts string numérico aceptado');
  eq(normalize({ n1: 100, '': 200, n2: -1, n3: 300 }), { n1: 100, n3: 300 }, 'T3j mixto: solo válidos');
});

// ================= T4: sort — orden de destacados =================
tcase('T4', () => {
  const mk = (id, ts) => ({ id, timestamp: ts });
  const posts = [mk('a', 300), mk('b', 100), mk('c', 200)];
  const out = sortPosts(posts, { b: 500, c: 900 });
  eq(out.map(p => p.id), ['c', 'b', 'a'], 'T4a destacados primero por pinnedAt desc, resto por ts desc');
  ok(out[0]._featuredAt === 900 && out[1]._featuredAt === 500, 'T4b _featuredAt marcado en destacados');
  ok(!('_featuredAt' in out[2]), 'T4c no destacado sin marca _featuredAt');
  // destacado "viejo" (ts bajo) sigue ganando a no-destacado "nuevo"
  const out2 = sortPosts([mk('x', 9999), mk('y', 1)], { y: 10 });
  eq(out2.map(p => p.id), ['y', 'x'], 'T4d destacado con ts bajo va primero igual');
});

// ================= T5: sort — casos límite =================
tcase('T5', () => {
  const mk = (id, ts) => ({ id, timestamp: ts });
  eq(sortPosts([], { a: 1 }).map(p => p.id), [], 'T5a array vacío → []');
  eq(sortPosts(null, { a: 1 }), [], 'T5b null → []');
  eq(sortPosts([mk('a', 2), mk('b', 1)], null).map(p => p.id), ['a', 'b'], 'T5c sin mapa: orden ts desc intacto');
  eq(sortPosts([mk('a', 2), mk('b', 1)], {}).map(p => p.id), ['a', 'b'], 'T5d mapa vacío: orden ts desc intacto');
  // empate de pinnedAt → desempate por timestamp desc
  const out = sortPosts([mk('a', 50), mk('b', 90)], { a: 100, b: 100 });
  eq(out.map(p => p.id), ['b', 'a'], 'T5e empate pinnedAt → timestamp desc');
  // id destacado sin post correspondiente → ignorado, sin crash
  const out2 = sortPosts([mk('a', 5)], { fantasma: 999 });
  eq(out2.map(p => p.id), ['a'], 'T5f destacado huérfano ignorado');
  // posts sin id no rompen
  const out3 = sortPosts([{ timestamp: 5 }, mk('a', 1)], { a: 10 });
  eq(out3.map(p => p.id), ['a', undefined], 'T5g post sin id va al resto');
});

// ================= T6: integración — hoja de opciones =================
tcase('T6', () => {
  ok(html.includes('id="feature-post-btn"'), 'T6a botón feature-post-btn existe en el HTML');
  ok(html.includes('onclick="toggleFeaturedPost()"'), 'T6b botón llama a toggleFeaturedPost()');
  ok(html.includes('id="feature-post-btn-label"'), 'T6c etiqueta feature-post-btn-label existe');
  ok(/featureBtn\.classList\.toggle\('hidden', !isOwner\)/.test(html), 'T6d botón visible solo para el autor (patrón owner)');
  ok(html.includes("appT(map[noteId] ? 'Quitar destacado' : 'Destacar')"), 'T6e etiqueta refleja estado actual');
  ok(/if \(currentPostOptionsNoteId !== noteId\) return;/.test(html), 'T6f anti-carrera en la etiqueta');
});

// ================= T7: integración — toggleFeaturedPost =================
tcase('T7', () => {
  ok(/async function toggleFeaturedPost\(/.test(html), 'T7a toggleFeaturedPost definida');
  ok(/ownerId !== user\.uid\) return;/.test(html), 'T7b guardia: solo el autor puede destacar');
  ok(/Object\.keys\(map\)\.length >= DREX_FEATURED_MAX/.test(html), 'T7c cap de 3 antes de escribir');
  ok(html.includes("appT('Solo puedes destacar 3 publicaciones.')"), 'T7d toast al llegar al cap');
  ok(html.includes("appT('Publicación destacada.')"), 'T7e toast al destacar');
  ok(html.includes("appT('Se quitó la publicación destacada.')"), 'T7f toast al quitar');
  ok(/ref\('users\/' \+ user\.uid \+ '\/featuredPosts'\)/.test(html), 'T7g escrituras bajo users/<uid>/featuredPosts');
  const _t7block = html.split('async function toggleFeaturedPost(')[1].split('function _refreshOwnProfileGridIfOpen')[0];
  ok(!/communityNotes|notesByAuthor/.test(_t7block), 'T7h toggle no toca nodos de posts');
});

// ================= T8: integración — borrado en cascada =================
tcase('T8', () => {
  ok(/featuredPosts\/' \+ noteId\)\.remove\(\)/.test(html), 'T8a cascadeDeleteNote limpia featuredPosts/<noteId>');
});

// ================= T9: integración — grids de perfil =================
tcase('T9', () => {
  ok(/loadUserPostsGrid\(postsSnapshot, collabPosts, userId\)/.test(html), 'T9a grid propio recibe authorUid');
  ok(/const featuredMap = await drexFeaturedGet\(authorUid\);/.test(html), 'T9b grid propio lee el mapa de destacados');
  ok(/drexFeaturedSortPosts\(items, featuredMap\)/.test(html), 'T9c grid propio ordena con drexFeaturedSortPosts');
  ok(/orderedItems\.forEach\(post =>/.test(html), 'T9d grid propio renderiza el orden final');
  ok(/featuredPromise: DrexCloud\.database\(\)\.ref\('users\/' \+ authorId \+ '\/featuredPosts'\)/.test(html), 'T9e memo del autor incluye featuredPromise');
  ok(/drexFeaturedSortPosts\(posts, featuredSnap \? featuredSnap\.val\(\) : null\)/.test(html), 'T9f grid ajeno ordena con drexFeaturedSortPosts');
  ok(!/posts\.sort\(\(a, b\) => \(b\.timestamp \|\| 0\) - \(a\.timestamp \|\| 0\)\);[\s\S]{0,60}const voteMaps = await _getProfileVoteMaps\(\);\s+posts\.forEach/.test(html),
    'T9g ningún grid conserva el sort plano sin destacados');
});

// ================= T10: integración — cabecera Destacado =================
tcase('T10', () => {
  ok(html.includes('.profile-featured-head'), 'T10a CSS .profile-featured-head existe');
  ok(html.includes('body.theme-dark .profile-featured-head'), 'T10b regla de contraste en tema oscuro');
  ok(html.includes("wrap.className = 'profile-featured-wrap w-full'"), 'T10c wrapper fuera del .drex-post (patrón eco)');
  ok(html.includes("escapeHtml(appT('Destacado'))"), 'T10d texto de la cabecera escapado y traducido');
  ok(/post && post\._featuredAt/.test(html), 'T10e cabecera solo si _featuredAt');
});

// ================= T11: i18n (6 claves nuevas, 1× por idioma; Destacado ya existía) =================
tcase('T11', () => {
  const keys = {
    'Destacar': ['Feature', '置顶', 'Destacar'],
    'Quitar destacado': ['Remove feature', '取消置顶', 'Remover destaque'],
    'Publicación destacada.': ['Post featured.', '帖子已置顶。', 'Publicação em destaque.'],
    'Se quitó la publicación destacada.': ['Featured post removed.', '已取消帖子置顶。', 'Destaque da publicação removido.'],
    'Solo puedes destacar 3 publicaciones.': ['You can only feature 3 posts.', '最多只能置顶 3 个帖子。', 'Você só pode destacar 3 publicações.'],
    'No se pudo actualizar. Intenta de nuevo.': ["Couldn't update. Try again.", '更新失败，请重试。', 'Não foi possível atualizar. Tente novamente.']
  };
  // Cuenta la clave ES anclada por ":" (evita prefijos como "Destacados" y
  // valores PT idénticos a la clave): debe aparecer 1× por diccionario = 3.
  const keyCount = (es) => (i18n.match(new RegExp('"' + es.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:', 'g')) || []).length;
  const pairCount = (es, val) => {
    const a = '"' + es + '":"' + val + '"', b = '"' + es + '": "' + val + '"';
    return i18n.split(a).length - 1 + i18n.split(b).length - 1;
  };
  for (const [es, [en, zh, pt]] of Object.entries(keys)) {
    ok(keyCount(es) === 3, 'T11 clave ES 1× por idioma: ' + es + ' (got ' + keyCount(es) + ')');
    ok(pairCount(es, en) === 1, 'T11 EN: ' + es);
    ok(pairCount(es, zh) === 1, 'T11 ZH: ' + es);
    ok(pairCount(es, pt) === 1, 'T11 PT: ' + es);
  }
  ok(keyCount('Destacado') === 3, 'T11 "Destacado" preexistente sigue 1× por idioma (no duplicado)');
});

// ================= T12: superficie de BD acotada =================
tcase('T12', () => {
  const idx = html.indexOf('async function toggleFeaturedPost(');
  ok(idx > 0, 'T12a bloque toggle localizable');
  const block = html.slice(idx, html.indexOf('function _refreshOwnProfileGridIfOpen'));
  const refs = [...block.matchAll(/ref\('([^']+)'/g)].map(m => m[1]);
  ok(refs.length > 0 && refs.every(r => r.startsWith('users/')), 'T12b todos los refs del toggle empiezan en users/ (' + refs.join(', ') + ')');
});

console.log('PASS ' + pass + ' / FAIL ' + fail);
if (failures.length) {
  console.log('FALLOS:');
  failures.forEach(f => console.log(' - ' + f));
  process.exit(1);
}
