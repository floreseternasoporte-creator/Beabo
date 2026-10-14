// test-c331-img-lazy.js — hidratación perezosa de fotos del feed
// Verifica con un IntersectionObserver falso:
//  1. queueNoteImagesHydration observa los contenedores [data-note-imgs] una sola vez
//  2. al intersectar, hidrata por la vía nueva (hydrateNoteImages) o legacy
//     (hydrateLegacyNoteImages con las keys de data-img-keys)
//  3. sin IntersectionObserver, hidrata de inmediato (fallback)
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const s = html.indexOf('var _noteImgsObserver = null;');
assert(s >= 0, 'marcador del observer no encontrado');
const e = html.indexOf('\n  // Rellena los contenedores diferidos', s);
assert(e >= 0, 'fin del bloque no encontrado');
const src = html.slice(s, e);

function makeEnv(withIO) {
  const hydrated = [], hydratedLegacy = [];
  const observed = [];
  let ioInstance = null;
  const els = [
    { id: 'n1', attrs: { 'data-note-imgs': 'n1' } },
    { id: 'n2', attrs: { 'data-note-imgs': 'n2', 'data-img-keys': '["imageUrl","imageUrls/0"]' } },
  ];
  els.forEach(el => {
    el.getAttribute = k => (k in el.attrs ? el.attrs[k] : null);
    el.setAttribute = (k, v) => { el.attrs[k] = v; };
  });
  const sandbox = {
    setTimeout, clearTimeout, Promise, JSON,
    hydrateNoteImages: id => hydrated.push(id),
    hydrateLegacyNoteImages: (id, keys) => hydratedLegacy.push([id, keys]),
    document: { querySelectorAll: sel => (sel === '[data-note-imgs]' ? els : []) },
  };
  if (withIO) {
    sandbox.IntersectionObserver = function (cb) {
      ioInstance = { cb, observed, unobserve: el => { const i = observed.indexOf(el); if (i >= 0) observed.splice(i, 1); } };
      return { observe: el => observed.push(el), unobserve: ioInstance.unobserve };
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { sandbox, hydrated, hydratedLegacy, observed, els, fire: el => ioInstance.cb([{ isIntersecting: true, target: el }]) };
}

(async () => {
  // 1+2. con IO: se observan los 2, nadie hidrata hasta intersectar
  let env = makeEnv(true);
  env.sandbox.queueNoteImagesHydration();
  assert.strictEqual(env.observed.length, 2, 'debió observar 2 contenedores');
  assert.deepStrictEqual(env.hydrated, []);
  assert.deepStrictEqual(env.hydratedLegacy, []);
  // marcar como encolados: segunda llamada no re-observa
  env.sandbox.queueNoteImagesHydration();
  assert.strictEqual(env.observed.length, 2, 'no debió re-observar');
  // intersecta n1 (formato nuevo) y n2 (legacy con keys)
  env.fire(env.els[0]);
  env.fire(env.els[1]);
  assert.deepStrictEqual(env.hydrated, ['n1'], 'n1 debió hidratar por vía nueva');
  assert.strictEqual(env.hydratedLegacy.length, 1, 'n2 debió hidratar por vía legacy');
  assert.strictEqual(env.hydratedLegacy[0][0], 'n2');
  assert.deepStrictEqual(env.hydratedLegacy[0][1], ['imageUrl', 'imageUrls/0']);

  // 3. sin IO: hidrata de inmediato
  env = makeEnv(false);
  env.sandbox.queueNoteImagesHydration();
  assert.deepStrictEqual(env.hydrated, ['n1']);
  assert.strictEqual(env.hydratedLegacy.length, 1);

  console.log('test-c331-img-lazy OK: lazy hydration por viewport verificada');
})().catch(err => { console.error('FALLO:', err); process.exit(1); });
