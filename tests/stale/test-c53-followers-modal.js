// test-c53-followers-modal.js — modal seguidores/seguidos (C53-P1 + C53-P2).
// C53-P1 (carrera): abrir seguidores(A), cerrar y abrir seguidores(B) dejaba
// que la respuesta tardía de A pintara su lista sobre la de B (sin guarda de
// generación). Fix: _followersModalTarget/_followingModalTarget; las respuestas
// tardías se descartan.
// C53-P2 (paginación): el modal leía la lista completa y lanzaba N lecturas
// users/<uid> en paralelo + N filas al DOM (medido: 2000 -> 2000 paralelas).
// Fix: paginación por keyset (orderByKey/startAt/limitToFirst, 50/página,
// botón "Cargar más"); cada página hidrata solo sus 50 perfiles.
// Convención: estático + funcional contra el archivo del repo, sin rutas
// absolutas ni historial de git. Los checks SOLO pasan con el fix presente.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repoRoot = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf-8');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

function extractFn(src, name) {
  const m = src.match(new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\('));
  assert(m, 'funcion no encontrada: ' + name);
  const start = m.index;
  let brace = src.indexOf('{', start);
  let depth = 0, i = brace;
  for (;;) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return src.slice(start, i + 1);
}

// ---------- estático ----------
// P1: guardas anti-carrera
check('C1: openFollowersModal fija _followersModalTarget',
  /openFollowersModal\(uid\)[\s\S]{0,300}_followersModalTarget = targetId/.test(html));
check('C1: la respuesta del once() se descarta si el target cambió',
  /_followersModalTarget !== targetId\) return;/.test(html));
check('C1: closeFollowersModal limpia el target',
  /closeFollowersModal\(\)[\s\S]{0,200}_followersModalTarget = null/.test(html));
check('C1: mismo esquema en el modal de seguidos',
  /_followingModalTarget = targetId/.test(html) &&
  /_followingModalTarget !== targetId\) return;/.test(html) &&
  /_followingModalTarget = null/.test(html));
// P2: paginación
check('C2: existe _loadFollowersPage con keyset (orderByKey/startAt/limitToFirst)',
  /function _loadFollowersPage\(\)/.test(html) &&
  /orderByKey\(\)/.test(html) && /startAt\(st\.lastKey\)/.test(html) &&
  /limitToFirst\(FOLLOWERS_PAGE_SIZE \+ 1\)/.test(html));
check('C2: página de 50 y botón "Cargar más"',
  /FOLLOWERS_PAGE_SIZE = 50/.test(html) && /followers-more-btn/.test(html) &&
  /Cargar más/.test(html));
check('C2: mismo esquema en el modal de seguidos',
  /function _loadFollowingPage\(\)/.test(html) && /FOLLOWING_PAGE_SIZE = 50/.test(html));
// C2b: el botón "Cargar más" genera marcado válido (regresión C53: la
// generación inicial producía class="... " + 'border...' con '+' literales
// dentro del atributo y el atributo mal cerrado).
for (const btn of ['followers-more-btn', 'following-more-btn']) {
  const m = html.match(new RegExp("id=\"" + btn + "\"[^>]*class=\"([^\"]+)\""));
  check('C2b: botón ' + btn + ' con atributo class bien formado',
    !!m && !/["'+]/.test(m[1]) && /\brounded-xl\b/.test(m[1]) &&
    /border-\[var\(--theme-border\)\]/.test(m[1]));
}

// ---------- funcional ----------
const TOTAL = 120;
const allIds = Array.from({ length: TOTAL }, (_, i) => 'uid_' + String(i).padStart(4, '0')).sort();
let profileReads = 0;
let resolveA = null;

function pageOnce(ids, slow) {
  const snap = { forEach: cb => ids.forEach(k => cb({ key: k })) };
  if (slow && ids.length === 1 && ids[0] === 'uid_seguidor_de_A')
    return new Promise(res => { resolveA = () => res(snap); });
  return Promise.resolve(snap);
}
function makeQuery(ids, slow) {
  return {
    orderByKey() { return makeQuery(ids, slow); },
    startAt(k) { return makeQuery(ids.filter(id => id >= k), slow); },
    limitToFirst(n) { return makeQuery(ids.slice(0, n), slow); },
    once: () => pageOnce(ids, slow),
  };
}
const profilesDB = {
  uid_seguidor_de_A: { username: 'seguidor_de_A' },
  uid_seguidor_de_B: { username: 'seguidor_de_B' },
};
const DrexCloud = {
  database: () => ({ ref: p => {
    if (p === 'followers/BIG') return makeQuery(allIds, false);
    if (p === 'followers/A') return makeQuery(['uid_seguidor_de_A'], true);
    if (p === 'followers/B') return makeQuery(['uid_seguidor_de_B'], false);
    const m = p.match(/^users\/(.+)$/);
    if (m) {
      profileReads++;
      const un = profilesDB[m[1]] ? profilesDB[m[1]].username : m[1];
      return { once: () => Promise.resolve({ val: () => ({ username: un }) }) };
    }
    throw new Error('ref inesperado: ' + p);
  } }),
  auth: () => ({ currentUser: { uid: 'me' } }),
};

const dom = { listHtml: '', moreBtn: null };
function renderMoreBtn() {
  const btn = { id: 'followers-more-btn', disabled: false,
    parentElement: { remove() { dom.moreBtn = null; } } };
  dom.moreBtn = btn;
  return btn;
}
const fakeList = {
  set innerHTML(v) { dom.listHtml = v;
    dom.moreBtn = v.includes('followers-more-btn') ? renderMoreBtn() : null; },
  get innerHTML() { return dom.listHtml; },
  insertAdjacentHTML(pos, v) { dom.listHtml += v;
    if (v.includes('followers-more-btn')) renderMoreBtn(); },
};
const fakeModal = { classList: { add() {}, remove() {} } };
const document = { getElementById: id =>
  id === 'followers-list' ? fakeList :
  id === 'followers-more-btn' ? dom.moreBtn : fakeModal };

const sandbox = {
  DrexCloud, document, window: {}, console,
  _drexProfileCache: new Map(), DREX_PROFILE_CACHE_TTL: 120000,
  currentViewedAuthorId: null,
  getSpinnerMarkup: () => 'SPIN',
  buildAuthorRelationRow: (uid, data) => '<row:' + (data.username || uid) + '>',
  showMiniToast: () => {},
  FOLLOWERS_PAGE_SIZE: 50,
};
sandbox.window.paintLoadError = () => {};
vm.createContext(sandbox);
for (const fn of ['_getCachedAuthorProfiles', 'openFollowersModal',
                  'closeFollowersModal', '_loadFollowersPage']) {
  vm.runInContext(extractFn(html, fn), sandbox);
}

const rows = () => (dom.listHtml.match(/<row:/g) || []).length;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // P1: carrera
  sandbox.openFollowersModal('A');
  await sleep(10);
  sandbox.closeFollowersModal();
  sandbox.openFollowersModal('B');
  await sleep(50);
  resolveA();
  await sleep(50);
  check('C3: la respuesta tardía de A no sobrescribe la lista de B',
    dom.listHtml.includes('seguidor_de_B') && !dom.listHtml.includes('seguidor_de_A'));

  // P2: paginación (reset de estado)
  profileReads = 0;
  dom.listHtml = ''; dom.moreBtn = null;
  sandbox._drexProfileCache = new Map();
  sandbox.openFollowersModal('BIG');
  await sleep(50);
  check('C4: página 1 pinta 50 filas (no 120)', rows() === 50);
  check('C4: página 1 emite 50 lecturas de perfil (no 120)', profileReads === 50);
  check('C4: botón "Cargar más" presente', !!dom.moreBtn);
  sandbox._loadFollowersPage();
  await sleep(50);
  check('C4: página 2 acumula 100 filas', rows() === 100);
  sandbox._loadFollowersPage();
  await sleep(50);
  check('C4: página 3 completa 120 filas y retira el botón',
    rows() === 120 && !dom.moreBtn);
  const seen = {};
  let dup = false;
  (dom.listHtml.match(/<row:(uid_\d+)>/g) || []).forEach(m => {
    const id = m.slice(5, -1); if (seen[id]) dup = true; seen[id] = 1;
  });
  check('C4: sin duplicados ni faltantes entre páginas',
    !dup && Object.keys(seen).length === 120);

  console.log(`\nC53-P1/P2: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
