'use strict';
/* Prueba de DrexCache (index.html) en Node: verifica que la caché L1/LRU
   nunca sirva el perfil de OTRO usuario (claves, invalidación, TTL).
   Extrae el IIFE real de window.DrexCache del index.html y lo evalúa con
   un localStorage falso.
   Ejecutar: node tests/test-drexcache-isolation.js
*/
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const startMarker = 'window.DrexCache = (function () {';
const start = html.indexOf(startMarker);
if (start < 0) { console.error('no se encontró DrexCache'); process.exit(2); }
// El IIFE termina en el primer "  })();" a partir del inicio (indentado a 2 espacios)
const endMarker = '\n  })();';
const end = html.indexOf(endMarker, start);
if (end < 0) { console.error('no se encontró el fin del IIFE'); process.exit(2); }
const src = html.slice(start, end + endMarker.length);

// localStorage falso
function makeStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
    key: i => Array.from(map.keys())[i] || null,
    get length() { return map.size; }
  };
}
global.localStorage = makeStorage();
const window = {};
global.window = window;

eval(src); // define window.DrexCache
const DrexCache = window.DrexCache;
if (!DrexCache) { console.error('DrexCache no definido tras eval'); process.exit(2); }

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

const profileA = { username: 'alice', profileImage: 'https://img/a.png' };
const profileB = { username: 'bob', profileImage: 'https://img/b.png' };

// 1. Aislamiento básico entre uids
DrexCache.set('profile', 'uidA', profileA, 300000);
DrexCache.set('profile', 'uidB', profileB, 300000);
const ga = DrexCache.get('profile', 'uidA');
const gb = DrexCache.get('profile', 'uidB');
check('get(uidA) trae a alice', ga && ga.username === 'alice', JSON.stringify(ga));
check('get(uidB) trae a bob', gb && gb.username === 'bob', JSON.stringify(gb));

// 2. Invalidación puntual no toca al otro
DrexCache.invalidate('profile', 'uidA');
check('tras invalidate(uidA), get(uidA) es null', DrexCache.get('profile', 'uidA') === null);
const gb2 = DrexCache.get('profile', 'uidB');
check('tras invalidate(uidA), get(uidB) sigue siendo bob', gb2 && gb2.username === 'bob', JSON.stringify(gb2));

// 3. TTL vencido no sirve datos viejos (TTL 1ms)
DrexCache.set('profile', 'uidC', { username: 'carol' }, 1);
setTimeout(() => {
  check('entrada con TTL vencido devuelve null', DrexCache.get('profile', 'uidC') === null);

  // 4. Sobrescritura: set nuevo reemplaza al viejo para la misma clave
  DrexCache.set('profile', 'uidB', { username: 'bob2' }, 300000);
  const gb3 = DrexCache.get('profile', 'uidB');
  check('set(uidB,bob2) reemplaza, no mezcla', gb3 && gb3.username === 'bob2' && !gb3.profileImage, JSON.stringify(gb3));

  // 5. Claves con caracteres raros (uid con ':' o '/') no colisionan
  DrexCache.set('profile', 'a:b', { username: 'colon' }, 300000);
  DrexCache.set('profile', 'a', { username: 'plain-a' }, 300000);
  const gc1 = DrexCache.get('profile', 'a:b');
  const gc2 = DrexCache.get('profile', 'a');
  check("clave 'a:b' aislada de 'a'", gc1 && gc1.username === 'colon' && gc2 && gc2.username === 'plain-a',
    JSON.stringify([gc1, gc2]));

  // 6. invalidate(ns) sin clave limpia todo el namespace pero no otros
  DrexCache.set('feed', 'snapshot:foryou', [{ id: 1 }], 120000);
  DrexCache.invalidate('profile');
  check('invalidate(profile) limpia perfiles', DrexCache.get('profile', 'uidB') === null);
  const fsnap = DrexCache.get('feed', 'snapshot:foryou');
  check('invalidate(profile) no toca feed', Array.isArray(fsnap) && fsnap.length === 1, JSON.stringify(fsnap));

  console.log(failures ? ('\nRESULTADO: ' + failures + ' FALLOS') : '\nRESULTADO: TODO OK');
  process.exit(failures ? 1 : 0);
}, 20);
