// test-c331-img-errui.js — estados de error/reintento de fotos (nunca blanco eterno)
//  1. hydrateNoteImages: la nota ANUNCIA fotos (data-img-count>0) pero la
//     lectura vuelve vacía -> muestra reintento (antes: se ocultaba en silencio)
//  2. hydrateNoteImages: sin fotos anunciadas y lectura vacía -> se oculta (ok)
//  3. hydrateNoteImages: fallo de red -> muestra reintento y conserva data-note-imgs
//  4. retryNoteImages: el botón restaura el shimmer y re-hidrata con éxito
//  5. hydrateLegacyNoteImages: fallo total -> muestra reintento (antes: shimmer eterno)
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const s = html.indexOf('const _noteImagesCache = {};');
assert(s >= 0, 'inicio no encontrado');
const e = html.indexOf('\n  // Muda las fotos inline', s);
assert(e >= 0, 'fin no encontrado');
const src = html.slice(s, e);

let dbMode = 'ok'; // 'ok' | 'empty' | 'fail'
function makeEnv() {
  const els = [];
  function makeEl(attrs) {
    const el = {
      attrs: Object.assign({}, attrs),
      _html: '<div class="drex-imgs-shimmer"></div>',
      style: {},
      replacedWith: null,
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      setAttribute(k, v) { this.attrs[k] = v; },
      removeAttribute(k) { delete this.attrs[k]; },
      closest(sel) { return (sel === '[data-note-imgs]' && ('data-note-imgs' in this.attrs)) ? this : null; },
      replaceWith(node) { this.replacedWith = node; },
    };
    Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; }, configurable: true });
    els.push(el);
    return el;
  }
  const sandbox = {
    setTimeout: () => 0, clearTimeout: () => {},
    _noteDimsMem: {},
    DrexCloud: { database: () => ({ ref: () => ({ once: () => {
      if (dbMode === 'fail') return Promise.reject(new Error('net'));
      return Promise.resolve({ val: () => (dbMode === 'empty' ? null : { img_00000: 'data:image/jpeg;base64,AAA' }) });
    } }) }) },
    document: {
      querySelectorAll: sel => (sel === '[data-note-imgs]' ? els.filter(x => 'data-note-imgs' in x.attrs) : []),
      createElement: () => ({ _h: '', set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; }, get firstElementChild() { return this._h ? {} : null; } }),
    },
    renderNoteImagesHtml: () => '<div>PINTADO</div>',
    escapeHtml: x => x, escapeInlineSingleQuote: x => x, appT: x => x,
    migrateNoteImagesToSeparate: () => Promise.resolve(),
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  // reintento directo (sin esperas) para los tests de UI; la lógica de
  // backoff ya la cubre test-c331-img-retry.js
  sandbox.drexReadWithRetry = fn => fn();
  return { sandbox, makeEl };
}
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

(async () => {
  // 1. anunciadas pero vacías -> reintento visible, atributo conservado
  let env = makeEnv(); dbMode = 'empty';
  let el = env.makeEl({ 'data-note-imgs': 'n1', 'data-img-count': '2' });
  env.sandbox.hydrateNoteImages('n1');
  await tick();
  assert(el.innerHTML.includes('reintentar'), 'debió mostrar el botón de reintento');
  assert('data-note-imgs' in el.attrs, 'debió conservar data-note-imgs para reintentar');

  // 2. no anunciadas y vacías -> se oculta (comportamiento correcto)
  env = makeEnv(); dbMode = 'empty';
  el = env.makeEl({ 'data-note-imgs': 'n2' });
  env.sandbox.hydrateNoteImages('n2');
  await tick();
  assert.strictEqual(el.style.display, 'none');
  assert(!('data-note-imgs' in el.attrs));

  // 3. fallo de red -> reintento
  env = makeEnv(); dbMode = 'fail';
  el = env.makeEl({ 'data-note-imgs': 'n3', 'data-img-count': '1' });
  env.sandbox.hydrateNoteImages('n3');
  await tick();
  assert(el.innerHTML.includes('reintentar'), 'fallo de red debió mostrar reintento');

  // 4. el botón reintenta: restaura shimmer y pinta al tener éxito
  dbMode = 'ok';
  env.sandbox.retryNoteImages({ closest: () => el }, 'n3', 0);
  assert(el.innerHTML.includes('drex-imgs-shimmer'), 'el botón debió restaurar el shimmer');
  await tick();
  assert(el.replacedWith, 'tras el reintento exitoso debió pintar las fotos');

  // 5. legacy con fallo total -> reintento (no shimmer eterno)
  env = makeEnv(); dbMode = 'fail';
  el = env.makeEl({ 'data-note-imgs': 'n4', 'data-img-keys': '["imageUrl"]' });
  env.sandbox.hydrateLegacyNoteImages('n4', ['imageUrl']);
  await tick();
  assert(el.innerHTML.includes('reintentar'), 'legacy en fallo debió mostrar reintento');
  assert(el.innerHTML.includes('drex-imgs-shimmer') === false);

  console.log('test-c331-img-errui OK: error/reintento sin blancos eternos verificado');
})().catch(err => { console.error('FALLO:', err); process.exit(1); });
