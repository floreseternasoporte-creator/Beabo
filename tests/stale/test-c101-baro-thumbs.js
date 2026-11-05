'use strict';
// Tests de miniaturas en resultados de Baro — C101 (carril 2, BARO v3).
// C101-F1: baroPostThumb(note) — helper PURO: orden imageUrl > imageUrls[0] >
//          image > images[0]; null sin foto; rechaza URLs rotas/peligrosas.
// C101-F2: baroRenderPostItem — emite <img> con la foto cuando hay; la foto
//          va dentro del mismo enlace al post (tocarla abre el post); sin
//          foto, tarjeta de texto normal (sin <img> ni placeholder roto);
//          con imageCount>0 (formato nuevo noteImages/<id>) emite slot
//          data-baro-noteimg para hidratación async.
// C101-F3: baroRenderSources (tira de fuentes) — tarjeta de post con
//          s.thumb válido emite <img>; sin thumb emite slot
//          data-baro-noteimg; otros tipos no tocan miniaturas.
// C101-F4: i18n ES/EN/ZH/PT de las claves nuevas; CSS de miniaturas.
// Extrae los módulos de index.html; --target permite correr contra la
// base (git show HEAD:index.html) para verificar que el test FALLA sin el parche.
// Uso: node tests/test-c101-baro-thumbs.js [--target base.html]
process.chdir(__dirname + '/..');
const fs = require('fs');

let target = 'index.html';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) target = process.argv[++i];
}

const html = fs.readFileSync(target, 'utf8');

let fails = 0, oks = 0;
const CASES = [];
function tcase(name, fn) { CASES.push([name, fn]); }
function assert(cond, label) { if (!cond) throw new Error('assert: ' + label); }
function eqJ(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(label + ' esperado=' + e + ' actual=' + a);
}

// --- Extracción del bloque 6x (helper + baroRenderPostItem) ---
const S6 = '/* ---------------- C101: miniaturas en resultados de Baro';
const E6 = '\n  function baroRenderPollItem(p, esc) {';
const s6i = html.indexOf(S6), e6i = html.indexOf(E6);
const src6 = (s6i >= 0 && e6i > s6i) ? html.slice(s6i, e6i) : null;

// --- Extracción del bloque 7d (i18n + utilidades + tira de fuentes) ---
const S7 = '/* ================= 1. i18n baro.v2.* ================= */';
const E7 = '/* ================= 4. Citas enlazadas';
const s7i = html.indexOf(S7), e7i = html.indexOf(E7, s7i);
const src7 = (s7i >= 0 && e7i > s7i) ? html.slice(s7i, e7i) : null;

tcase('extracción de los bloques C101 (6x y 7d)', () => {
  assert(src6, 'bloque C101 del 6x ausente en ' + target + ' (sin parche?)');
  assert(src7, 'bloque de utilidades 7d ausente en ' + target);
  assert(src6.indexOf('function baroPostThumb(note)') >= 0, 'baroPostThumb ausente');
  assert(src6.indexOf('function baroRenderPostItem(p, esc)') >= 0, 'baroRenderPostItem ausente');
  assert(src7.indexOf('function baroRenderSources(sources)') >= 0, 'baroRenderSources ausente');
});

// --- Carga del módulo 6x con stubs mínimos ---
let M6 = null;
const scheduledTimeouts = [];
function loadM6() {
  if (M6) return M6;
  assert(src6, 'sin bloque 6x que cargar');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const stubs = {
    baroT6c: (k) => k,
    baroClip: (s, n) => String(s == null ? '' : s).slice(0, n),
    baroPostHref: (id) => '#/post/' + encodeURIComponent(String(id)),
    BARO_LINK_STYLE: 'color:#2F33B8;',
    BARO_META_STYLE: 'color:#999;',
    baroDb: () => null, // sin BD: la hidratación async resuelve null
    window: {},
    document: { getElementById: () => null },
    setTimeout: (fn) => { scheduledTimeouts.push(fn); return scheduledTimeouts.length; }
  };
  const names = Object.keys(stubs);
  const body = src6 + '\n;return { baroThumbUrl, baroPostThumb, baroRenderPostItem, baroHydrateNoteThumbs, baroFirstNoteImage };';
  M6 = new Function(...names, body)(...names.map((k) => stubs[k]));
  return M6;
}

// --- Carga del módulo 7d (tira de fuentes) con stubs mínimos ---
let M7 = null;
function loadM7(withWindowThumb) {
  assert(src7, 'sin bloque 7d que cargar');
  const timeouts = [];
  const fakeWindow = withWindowThumb ? { baroThumbUrl: loadM6().baroThumbUrl } : undefined;
  const body = src7 + '\n;return { baroRenderSources, baro7dThumbUrl };';
  // window indefinido -> el fallback local; con withWindowThumb se prueba la vía window.
  const fn = new Function('setTimeout', 'window', body);
  const m = fn((f) => { timeouts.push(f); return timeouts.length; }, fakeWindow);
  m._timeouts = timeouts;
  return m;
}

// ================= C101-F1: baroPostThumb =================
tcase('F1: imageUrl http(s) se devuelve tal cual', () => {
  const m = loadM6();
  eqJ(m.baroPostThumb({ imageUrl: 'https://cdn.drex.app/foto.jpg' }), 'https://cdn.drex.app/foto.jpg', 'imageUrl');
});

tcase('F1: orden (1) imageUrl gana a (3) imageUrls[0]', () => {
  const m = loadM6();
  eqJ(m.baroPostThumb({ imageUrl: 'https://a/1.jpg', imageUrls: ['https://b/2.jpg'] }), 'https://a/1.jpg', 'prioridad');
});

tcase('F1: (3) imageUrls[0] cuando no hay imageUrl', () => {
  const m = loadM6();
  eqJ(m.baroPostThumb({ imageUrls: ['https://b/2.jpg', 'https://c/3.jpg'] }), 'https://b/2.jpg', 'imageUrls[0]');
});

tcase('F1: (3) salta entradas vacías/rotas del arreglo', () => {
  const m = loadM6();
  eqJ(m.baroPostThumb({ imageUrls: ['', null, 'https://b/2.jpg'] }), 'https://b/2.jpg', 'salta rotas');
});

tcase('F1: (3) image e images[0] como último recurso del objeto', () => {
  const m = loadM6();
  eqJ(m.baroPostThumb({ image: 'https://i/x.png' }), 'https://i/x.png', 'image');
  eqJ(m.baroPostThumb({ images: ['https://i/y.png'] }), 'https://i/y.png', 'images[0]');
});

tcase('F1: null cuando no hay foto', () => {
  const m = loadM6();
  eqJ(m.baroPostThumb({}), null, 'objeto vacío');
  eqJ(m.baroPostThumb({ content: 'hola' }), null, 'solo texto');
  eqJ(m.baroPostThumb(null), null, 'null');
  eqJ(m.baroPostThumb(undefined), null, 'undefined');
  eqJ(m.baroPostThumb('https://a/b.jpg'), null, 'no-objeto');
  eqJ(m.baroPostThumb(42), null, 'número');
});

tcase('F1: sin URLs rotas — rechaza esquemas peligrosos y basura', () => {
  const m = loadM6();
  eqJ(m.baroPostThumb({ imageUrl: 'javascript:alert(1)' }), null, 'javascript:');
  eqJ(m.baroPostThumb({ imageUrl: 'data:text/html,<h1>x</h1>' }), null, 'data:text/html');
  eqJ(m.baroPostThumb({ imageUrl: 'ftp://a/b.jpg' }), null, 'ftp:');
  eqJ(m.baroPostThumb({ imageUrl: 'https://cdn/a/b c.jpg' }), null, 'con espacios');
  eqJ(m.baroPostThumb({ imageUrl: '   ' }), null, 'blancos');
  eqJ(m.baroPostThumb({ imageUrl: '' }), null, 'vacía');
  eqJ(m.baroPostThumb({ imageUrl: 123 }), null, 'número');
});

tcase('F1: data:image base64 SÍ es válida', () => {
  const m = loadM6();
  const d = 'data:image/png;base64,iVBORw0KGgo=';
  eqJ(m.baroPostThumb({ imageUrl: d }), d, 'data:image');
});

tcase('F1: recorta espacios alrededor de URL válida', () => {
  const m = loadM6();
  eqJ(m.baroPostThumb({ imageUrl: '  https://a/b.jpg  ' }), 'https://a/b.jpg', 'trim');
});

// ================= C101-F2: baroRenderPostItem =================
tcase('F2: con foto emite <img> dentro del enlace al post', () => {
  const m = loadM6();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const out = m.baroRenderPostItem({ id: 'p1', content: 'texto', authorName: 'ana', imageUrl: 'https://cdn/a.jpg' }, esc);
  assert(out.indexOf('<img') >= 0, 'debe emitir <img>');
  assert(out.indexOf('src="https://cdn/a.jpg"') >= 0, 'src correcto');
  assert(/<a[^>]*href="#\/post\/p1"[^>]*>\s*<img/.test(out), 'la foto va dentro del <a> al post (tocarla abre el post)');
  assert(out.indexOf('onerror') >= 0, 'onerror anti-404 presente');
  assert(out.indexOf('alt=') >= 0, 'alt accesible presente');
  assert(out.indexOf('@ana') >= 0 || out.indexOf('ana') >= 0, 'autor presente');
});

tcase('F2: sin foto, tarjeta de texto normal (sin <img>, sin slot, sin placeholder)', () => {
  const m = loadM6();
  const esc = (s) => String(s == null ? '' : s);
  const out = m.baroRenderPostItem({ id: 'p2', content: 'solo texto', authorName: 'bob' }, esc);
  assert(out.indexOf('<img') === -1, 'no debe emitir <img>');
  assert(out.indexOf('data-baro-noteimg') === -1, 'no debe emitir slot');
  assert(out.indexOf('href="#/post/p2"') >= 0, 'enlace al post intacto');
  assert(out.indexOf('solo texto') >= 0, 'texto presente');
  assert(out.indexOf('bob') >= 0, 'autor presente');
});

tcase('F2: imageCount>0 sin inline → slot data-baro-noteimg (hidratación async), sin <img>', () => {
  const m = loadM6();
  scheduledTimeouts.length = 0;
  const esc = (s) => String(s == null ? '' : s);
  const out = m.baroRenderPostItem({ id: 'p9', content: 'con fotos nuevas', imageCount: 2 }, esc);
  assert(out.indexOf('<img') === -1, 'no <img> hasta hidratar');
  assert(out.indexOf('data-baro-noteimg="p9"') >= 0, 'slot con el noteId');
  assert(/<a[^>]*href="#\/post\/p9"[^>]*>/.test(out), 'el slot también abre el post');
  assert(scheduledTimeouts.length >= 1, 'se agenda la hidratación async');
});

tcase('F2: la URL de la foto se escapa (sin breakout de atributo)', () => {
  const m = loadM6();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const evil = 'https://cdn/a.jpg"onmouseover="alert(1)';
  const out = m.baroRenderPostItem({ id: 'p3', content: 'x', imageUrl: evil }, esc);
  assert(out.indexOf('onmouseover="') === -1, 'el handler no debe quedar crudo');
  assert(out.indexOf('&quot;') >= 0, 'comillas escapadas');
});

tcase('F2: el texto del post sigue escapado', () => {
  const m = loadM6();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const out = m.baroRenderPostItem({ id: 'p4', content: '<b>hola</b>', authorName: '<i>mallory</i>' }, esc);
  assert(out.indexOf('&lt;b&gt;') >= 0, 'contenido escapado');
  assert(out.indexOf('<i>mallory</i>') === -1, 'autor escapado');
});

// ================= C101-F3: baroRenderSources =================
tcase('F3: fuente post con thumb válido emite <img> con has-thumb', () => {
  const m = loadM7(false);
  const out = m.baroRenderSources([{ type: 'post', id: 'abc123', title: 'Hola', thumb: 'https://cdn/x.jpg' }]);
  assert(out.indexOf('<img') >= 0, 'debe emitir <img>');
  assert(out.indexOf('src="https://cdn/x.jpg"') >= 0, 'src correcto');
  assert(out.indexOf('has-thumb') >= 0, 'clase has-thumb');
  assert(out.indexOf('href="#/post/abc123"') >= 0, 'enlace al post');
  // La foto queda dentro de la tarjeta-enlace: tocarla abre el post.
  const a0 = out.indexOf('<a class="baro-source-card');
  const img0 = out.indexOf('<img');
  const aClose = out.indexOf('</a>', img0);
  assert(a0 >= 0 && a0 < img0 && img0 < aClose, 'el <img> va dentro del <a> de la tarjeta');
});

tcase('F3: fuente post sin thumb emite slot data-baro-noteimg (sin <img>)', () => {
  const m = loadM7(false);
  const out = m.baroRenderSources([{ type: 'post', id: 'abc123', title: 'Hola' }]);
  assert(out.indexOf('<img') === -1, 'sin <img> hasta hidratar');
  assert(out.indexOf('data-baro-noteimg="abc123"') >= 0, 'slot con el noteId');
  assert(m._timeouts.length >= 1, 'se agenda la hidratación async');
});

tcase('F3: thumb inválido no emite <img> (cae al slot, sin imagen rota)', () => {
  const m = loadM7(false);
  const out = m.baroRenderSources([{ type: 'post', id: 'abc123', title: 'Hola', thumb: 'no es url' }]);
  assert(out.indexOf('<img') === -1, 'thumb inválido no se pinta');
  assert(out.indexOf('data-baro-noteimg="abc123"') >= 0, 'cae al slot async');
});

tcase('F3: thumb malicioso se escapa (sin breakout)', () => {
  const m = loadM7(false);
  const out = m.baroRenderSources([{ type: 'post', id: 'p1', title: 't', thumb: 'https://x/"><script>alert(1)</script>' }]);
  assert(out.indexOf('<script>alert') === -1, 'script crudo no debe aparecer');
  assert(out.indexOf('&quot;') >= 0 || out.indexOf('&lt;') >= 0, 'escapado');
});

tcase('F3: fuentes no-post no tocan miniaturas', () => {
  const m = loadM7(false);
  const out = m.baroRenderSources([{ type: 'perfil', id: 'juan', title: '@juan' }]);
  assert(out.indexOf('data-baro-noteimg') === -1, 'perfil sin slot');
  assert(out.indexOf('<img') === -1, 'perfil sin <img>');
});

tcase('F3: sin fuentes válidas devuelve cadena vacía (no se finge)', () => {
  const m = loadM7(false);
  eqJ(m.baroRenderSources([]), '', 'vacío');
  eqJ(m.baroRenderSources(null), '', 'null');
});

tcase('F3: el validador del 7d usa window.baroThumbUrl cuando existe (misma regla)', () => {
  const m = loadM7(true);
  eqJ(m.baro7dThumbUrl('https://a/b.jpg'), 'https://a/b.jpg', 'vía window');
  eqJ(m.baro7dThumbUrl('javascript:x'), null, 'vía window rechaza');
});

// ================= C101-F4: i18n + CSS =================
tcase('F4: clave baro.thumb.alt en BARO_I18N_6C (ES/EN/ZH/PT)', () => {
  const i = html.indexOf("'baro.thumb.alt'");
  assert(i >= 0, 'clave ausente en BARO_I18N_6C');
  const seg = html.slice(i, i + 220);
  assert(seg.indexOf('Foto del post') >= 0, 'ES');
  assert(seg.indexOf('Post photo') >= 0, 'EN');
  assert(seg.indexOf('帖子图片') >= 0, 'ZH');
  assert(seg.indexOf('Foto da publicação') >= 0, 'PT');
});

tcase('F4: clave baro.v2.thumb_alt en BARO_V2_I18N (ES/EN/ZH/PT)', () => {
  const i = html.indexOf("'baro.v2.thumb_alt'");
  assert(i >= 0, 'clave ausente en BARO_V2_I18N');
  const seg = html.slice(i, i + 220);
  assert(seg.indexOf('Foto del post') >= 0, 'ES');
  assert(seg.indexOf('Post photo') >= 0, 'EN');
  assert(seg.indexOf('帖子图片') >= 0, 'ZH');
  assert(seg.indexOf('Foto da publicação') >= 0, 'PT');
});

tcase('F4: CSS de miniaturas presente y consistente con el diseño índigo', () => {
  assert(html.indexOf('.baro-source-thumb') >= 0, '.baro-source-thumb ausente');
  assert(html.indexOf('.baro-source-card.has-thumb .baro-source-icon') >= 0, 'regla has-thumb ausente');
  assert(html.indexOf('.baro-thumb-slot:empty') >= 0, 'regla anti-hueco ausente');
  assert(html.indexOf('object-fit:cover') >= 0, 'object-fit:cover para recorte limpio');
});

tcase('F4: contrato de fuentes documenta el campo thumb (C101)', () => {
  assert(html.indexOf('thumb: (C101, opcional)') >= 0, 'contrato sin documentar');
});

for (const [name, fn] of CASES) {
  try { fn(); oks++; }
  catch (e) { fails++; console.error('FAIL ' + name + ' :: ' + e.message); }
}
console.log('c101-baro-thumbs: ' + oks + ' OK, ' + fails + ' FAIL');
process.exit(fails ? 1 : 0);
