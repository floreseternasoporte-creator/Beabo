// test-c331-img-idbcache.js — caché persistente de fotos en IndexedDB
//  1. put + get devuelve el registro guardado
//  2. get de nota inexistente -> null
//  3. nota gigante (> tope por nota) no entra al caché
//  4. poda LRU: con tope bajo, las más viejas se eliminan
//  5. dims: put + precarga de arranque puebla _noteDimsMem
//  6. sin indexedDB -> todo resuelve null / no revienta
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const s = html.indexOf('var DREX_IMG_IDB_NAME =');
assert(s >= 0, 'inicio no encontrado');
const e = html.indexOf('\n  // Rellena los contenedores diferidos', s);
assert(e >= 0, 'fin no encontrado');
const src = html.slice(s, e);

function fakeIDB() {
  const stores = { imgs: new Map(), dims: new Map() };
  return {
    open() {
      const req = {};
      setTimeout(() => {
        req.result = {
          objectStoreNames: { contains: n => n in stores },
          createObjectStore: () => {},
          transaction: (names) => {
            const map = stores[Array.isArray(names) ? names[0] : names];
            const os = {
              get: k => { const r = {}; setTimeout(() => { r.result = map.get(k) || null; r.onsuccess && r.onsuccess(); }, 0); return r; },
              put: v => { const r = {}; setTimeout(() => { map.set(v.noteId, v); r.onsuccess && r.onsuccess(); }, 0); return r; },
              getAll: () => { const r = {}; setTimeout(() => { r.result = [...map.values()]; r.onsuccess && r.onsuccess(); }, 0); return r; },
              delete: k => { const r = {}; setTimeout(() => { map.delete(k); r.onsuccess && r.onsuccess(); }, 0); return r; },
              clear: () => { const r = {}; setTimeout(() => { map.clear(); r.onsuccess && r.onsuccess(); }, 0); return r; },
            };
            return { objectStore: () => os };
          },
        };
        req.onupgradeneeded && req.onupgradeneeded();
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
  };
}
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

(async () => {
  // entorno con IDB falso
  const sandbox = { setTimeout, clearTimeout, Promise, indexedDB: fakeIDB(), _noteDimsMem: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  // 1. put + get
  sandbox.drexImgCachePut('n1', ['data:image/jpeg;base64,AAA'], [{ w: 4, h: 3 }]);
  await tick();
  let rec = await sandbox.drexImgCacheGet('n1');
  assert(rec && rec.urls[0] === 'data:image/jpeg;base64,AAA', 'put+get debió devolver el registro');

  // 2. inexistente -> null
  rec = await sandbox.drexImgCacheGet('nope');
  assert.strictEqual(rec, null);

  // 3. nota gigante no entra
  sandbox.DREX_IMG_IDB_NOTE_MAX_BYTES = 10;
  sandbox.drexImgCachePut('big', ['x'.repeat(100)], null);
  await tick();
  rec = await sandbox.drexImgCacheGet('big');
  assert.strictEqual(rec, null, 'la nota gigante no debió entrar al caché');
  sandbox.DREX_IMG_IDB_NOTE_MAX_BYTES = 6 * 1024 * 1024;

  // 4. poda LRU con tope bajo
  sandbox.DREX_IMG_IDB_MAX_BYTES = 30;
  sandbox.drexImgCachePut('old1', ['a'.repeat(20)], null);
  await tick(60);
  sandbox.drexImgCachePut('old2', ['b'.repeat(20)], null);
  await tick(120);
  const r1 = await sandbox.drexImgCacheGet('old1');
  const r2 = await sandbox.drexImgCacheGet('old2');
  assert.strictEqual(r1, null, 'la más vieja debió podarse');
  assert(r2 && r2.urls[0] === 'b'.repeat(20), 'la nueva debió conservarse');
  sandbox.DREX_IMG_IDB_MAX_BYTES = 24 * 1024 * 1024;

  // 5. dims: put + precarga de arranque puebla _noteDimsMem
  sandbox.drexImgDimsPut('d1', [{ w: 16, h: 9 }]);
  await tick();
  // simula un "arranque" nuevo: re-ejecuta el bloque completo (incluye la
  // precarga de dimensiones) sobre el mismo IDB falso
  const sandbox2 = { setTimeout, clearTimeout, Promise, indexedDB: sandbox.indexedDB, _noteDimsMem: {} };
  vm.createContext(sandbox2);
  vm.runInContext(src, sandbox2);
  await tick(80);
  assert.deepStrictEqual(sandbox2._noteDimsMem['d1'], [{ w: 16, h: 9 }], 'la precarga debió poblar _noteDimsMem');

  // 6. sin indexedDB: no revienta, get -> null
  const sandbox3 = { setTimeout, clearTimeout, Promise, _noteDimsMem: {} };
  vm.createContext(sandbox3);
  vm.runInContext(src, sandbox3);
  rec = await sandbox3.drexImgCacheGet('n1');
  assert.strictEqual(rec, null);
  sandbox3.drexImgCachePut('n1', ['x'], null); // no debe lanzar

  console.log('test-c331-img-idbcache OK: caché persistente verificado');
})().catch(err => { console.error('FALLO:', err); process.exit(1); });
