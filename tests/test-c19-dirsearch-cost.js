'use strict';
/* PERF 2026-09-23 (ciclo 19) — caché de perfiles en searchUserDirectoryByPrefix.
 *
 * La búsqueda de directorio hidrataba hasta 30 perfiles COMPLETOS por cada
 * pausa del usuario (~15 RCU por búsqueda, medido con el código real). Con el
 * caché de sesión (TTL 120 s, cap 300), la repetición de la misma búsqueda
 * solo paga la consulta al índice usernames/ (1 op, 0.5 RCU).
 *
 * FALLA en la base sin el fix: la 2ª búsqueda idéntica cuesta 31 ops en vez
 * de 1 (el test extrae la función real de index.html; sin las declaraciones
 * del caché usa un stub sin aciertos).
 *
 * Uso: node tests/test-c19-dirsearch-cost.js
 */
const path = require('path');
const fs = require('fs');
const SRC = path.join(__dirname, '..');
const { DrexCloud, __internals: I } = require(path.join(SRC, 'drex-cloud.js'));

function cmpSk(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
function makeInstrumentedFake() {
  const items = [];
  const stats = { ops: 0, bytes: 0, rcu: 0 };
  function put(pk, sk, v) { items.push({ pk, sk, v: JSON.stringify(v) }); }
  function charge(returned) {
    let bytes = 0;
    returned.forEach(it => {
      bytes += Buffer.byteLength(it.sk || '', 'utf8') + Buffer.byteLength(it.v || '', 'utf8');
    });
    stats.ops++;
    stats.bytes += bytes;
    stats.rcu += Math.max(0.5, Math.ceil(bytes / 4096) * 0.5);
  }
  function runQuery(params) {
    const vals = params.ExpressionAttributeValues || {};
    let arr = items.filter(it => it.pk === vals[':pk']);
    const kc = params.KeyConditionExpression || '';
    if (kc.includes('begins_with(sk, :pfx)')) {
      arr = arr.filter(it => it.sk.indexOf(vals[':pfx']) === 0);
    } else {
      throw new Error('KC no soportada: ' + kc);
    }
    arr.sort((a, b) => params.ScanIndexForward === false ? cmpSk(b.sk, a.sk) : cmpSk(a.sk, b.sk));
    if (params.ExclusiveStartKey) {
      const idx = arr.findIndex(it => it.sk === params.ExclusiveStartKey.sk);
      arr = idx >= 0 ? arr.slice(idx + 1) : [];
    }
    if (params.Limit && arr.length > params.Limit) arr = arr.slice(0, params.Limit);
    const out = arr.map(it => ({ pk: it.pk, sk: it.sk, v: it.v }));
    charge(out);
    return { Items: out };
  }
  return {
    query(params) { return { promise() { return Promise.resolve(runQuery(params)); } }; },
    get(params) {
      return {
        promise() {
          const it = items.find(x => x.pk === params.Key.pk && x.sk === params.Key.sk);
          charge(it ? [{ pk: it.pk, sk: it.sk, v: it.v }] : []);
          return Promise.resolve({ Item: it ? { pk: it.pk, sk: it.sk, v: it.v } : undefined });
        }
      };
    },
    _put: put,
    _stats: stats,
    _reset() { stats.ops = 0; stats.bytes = 0; stats.rcu = 0; }
  };
}

const fake = makeInstrumentedFake();
const put = fake._put;
function seedUser(uid, uname) {
  const f = (k, v) => put('users', uid + '/' + k, v);
  f('username', uname);
  f('displayName', 'Nombre de ' + uname);
  f('profileImage', 'https://cdn.drex.app/avatars/' + uid + '.png');
  f('bio', 'Bio del usuario ' + uname + ' con texto para ocupar bytes realistas.');
  f('email', uname + '@example.com');
  f('verified', uid.endsWith('0'));
  f('followersCount', 1234);
  f('followingCount', 321);
  f('postCount', 57);
  f('createdAt', 1700000000000);
  f('lastSeen', 1758600000000);
  f('language', 'es');
  f('isPrivate', false);
  f('accountTier', 'standard');
  f('theme', 'system');
  f('notifSound', true);
}
const names = [];
for (let i = 0; i < 400; i++) names.push('alguien_' + i);
for (let i = 0; i < 400; i++) names.push('narayan_fan_' + i);
names.forEach((uname, i) => {
  const uid = 'uid_' + String(i).padStart(5, '0');
  put('usernames', uname.toLowerCase(), uid);
  seedUser(uid, uname);
});
I.setDocClient(fake);

// Extrae la función REAL de index.html (con su caché si existe).
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
let pre = html.match(/const _dirSearchProfileCache = new Map\(\);[\s\S]*?function searchUserDirectoryByPrefix\(q, limit\) \{[\s\S]*?\n\}/);
let cachePresent = true;
if (!pre) {
  cachePresent = false;
  const m2 = html.match(/function searchUserDirectoryByPrefix\(q, limit\) \{[\s\S]*?\n\}/);
  if (!m2) { console.error('FAIL: no se encontró searchUserDirectoryByPrefix'); process.exit(1); }
  pre = ['var _dirSearchProfileCache = { get: function () {}, set: function () {},',
    'delete: function () {}, clear: function () {}, get size() { return 0; },',
    'keys: function () { return [][Symbol.iterator](); } };',
    'var DIR_SEARCH_PROFILE_CACHE_TTL = 120000;',
    'var DIR_SEARCH_PROFILE_CACHE_MAX = 300;',
    m2[0]].join('\n');
} else {
  pre = pre[0];
}
const real = new Function('DrexCloud', pre + '\nreturn { searchUserDirectoryByPrefix: searchUserDirectoryByPrefix, ttl: DIR_SEARCH_PROFILE_CACHE_TTL };')(DrexCloud);
const search = real.searchUserDirectoryByPrefix;

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? '  OK  ' : '  FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
}
const norm = arr => arr.map(o => [o.uid, o.username, o.profileImage].join('|')).join('\n');

(async () => {
  check('caché de sesión presente en index.html', cachePresent);

  fake._reset();
  const cold = await search('a', 30);
  const opsCold = fake._stats.ops;
  check('búsqueda fría: 30 hits', cold.length === 30, 'hits=' + cold.length);
  check('búsqueda fría: 31 ops (índice + 30 perfiles)', opsCold === 31, 'ops=' + opsCold);

  fake._reset();
  const hot = await search('a', 30);
  const opsHot = fake._stats.ops;
  check('búsqueda caliente: solo la consulta al índice (<=2 ops)', opsHot <= 2, 'ops=' + opsHot);
  check('equivalencia frío/caliente (uids, orden, username, foto)', norm(cold) === norm(hot));

  fake._reset();
  const other = await search('nar', 30);
  check('otro prefijo: 30 hits (miss del caché, hidrata)', other.length === 30, 'hits=' + other.length);

  fake._reset();
  const empty = await search('', 30);
  check('query vacía: 0 hits y 0 ops', empty.length === 0 && fake._stats.ops === 0);

  fake._reset();
  const none = await search('zzz', 30);
  check('sin coincidencias: 0 hits, 1 op (índice)', none.length === 0 && fake._stats.ops === 1);

  check('TTL del caché = 120000 ms', real.ttl === 120000, 'ttl=' + real.ttl);

  console.log(failures ? `\n${failures} FALLO(S)` : '\nTodos los tests pasaron');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
