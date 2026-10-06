/* C269 — Perfiles por pestañas (Mi perfil + autor): Publicaciones,
   Respuestas, Multimedia, Ecos (+ Música en el propio). Ya no un scroll. */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'drex-i18n.js'), 'utf8');

// Barra de pestañas en AMBOS perfiles
for (const attr of ['data-myptab', 'data-aptab']) {
  for (const tab of ['posts', 'replies', 'media', 'ecos']) {
    assert(html.includes(`${attr}="${tab}"`), `pestaña ${tab} en ${attr}`);
  }
}
assert(html.includes('data-myptab="music"'), 'Mi perfil también tiene pestaña Música');

// Secciones propias
for (const id of ['myptab-posts', 'myptab-replies', 'myptab-media', 'myptab-ecos', 'myptab-music',
  'my-profile-replies-list', 'my-profile-media-grid', 'my-profile-ecos-list']) {
  assert(html.includes('id="' + id + '"'), 'sección propia: #' + id);
}
// Secciones del autor
for (const id of ['aptab-posts', 'aptab-replies', 'aptab-media', 'aptab-ecos',
  'author-profile-replies-list', 'author-profile-media-grid', 'author-profile-tabs']) {
  assert(html.includes('id="' + id + '"'), 'sección autor: #' + id);
}

// Lo que ya existía sigue vivo dentro de su pestaña
assert(html.includes('id="user-posts"'), 'posts propios');
assert(html.includes('id="user-music-mobile"'), 'música propia');
assert(html.includes('id="author-profile-posts-list"'), 'posts del autor');
assert(html.includes('id="author-profile-ecos-list"'), 'ecos del autor');
assert(html.includes('id="profile-posts-title"'), 'contador de posts propio (oculto)');

// Motor
assert(html.includes('function switchMyProfileTab(tab)'), 'switchMyProfileTab');
assert(html.includes('function switchAuthorProfileTab(tab)'), 'switchAuthorProfileTab');
assert(html.includes('function loadProfileRepliesInto(container, uid, isMine)'), 'cargador de respuestas');
assert(html.includes("ref('userComments/' + uid)"), 'respuestas desde userComments/<uid>');
assert(html.includes('function loadProfileMediaInto(grid, uid)'), 'cargador de multimedia');
assert(html.includes("ref('notesByAuthor/' + uid)"), 'multimedia desde notesByAuthor/<uid>');
assert(html.includes('function loadMyProfileEcosMobile()'), 'ecos móviles del perfil propio');
assert(html.includes('createProfileEcoCard(payload, post'), 'las tarjetas de eco se reutilizan');
assert(html.includes("switchMyProfileTab('posts')"), 'Mi perfil abre en Publicaciones');
assert(html.includes("switchAuthorProfileTab('posts')"), 'el autor abre en Publicaciones');
assert(html.includes("switchAuthorProfileTab('posts'); document.getElementById('author-profile-tabs')"), 'el contador de posts del autor lleva a su pestaña');

// i18n de las pestañas nuevas
for (const k of ['Respuestas', 'En la publicación de', 'Aún no ha comentado publicaciones.', 'Aún no hay fotos ni videos aquí.']) {
  assert(i18n.includes('"' + k + '"'), 'i18n: ' + k);
}
assert((html.match(/data-drex-i18n="Respuestas"/g) || []).length === 2, 'las dos barras traducen Respuestas');

console.log('test-c269-perfil-pestanas: OK');
