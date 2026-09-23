// PERF ciclo 9: H3 (paginación del grid del perfil) + H4 (debounce de búsqueda).
// Verifica con las funciones REALES extraídas de index.html:
//  H3a. El query del listener del perfil lleva limitToLast(30).
//  H3b. Snapshot con n < página → total exacto en vivo; n == página y total
//       desconocido → dispara once('value') para el total (una vez).
//  H3c. "Cargar más" sube la página a 60 y re-adjunta con el nuevo límite.
//  H3d. _paintProfileLoadMore: visible solo si la página va llena y (total
//       desconocido o página < total).
//  H3e. _paintProfilePostsCount pinta total+collab en los 4 destinos.
//  H3f. Carrera de cambio de perfil: el callback no pinta si _userStatsUid cambió.
//  H4a. Input con texto → performRealTimeSearch NO corre de inmediato, corre
//       1 vez tras ~350 ms aunque haya 5 teclas.
//  H4b. Vaciar el campo → corre de inmediato (sin debounce).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}
function extractFromTo(startMarker, endMarker) {
  const i = html.indexOf(startMarker);
  if (i < 0) throw new Error('no encontrado: ' + startMarker);
  const j = html.indexOf(endMarker, i);
  if (j < 0) throw new Error('fin no encontrado: ' + endMarker);
  return html.slice(i, j + endMarker.length);
}
function extractFn(name) {
  const i = html.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no encontrada: ' + name);
  let j = html.indexOf('{', i), depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}') { depth--; if (!depth) return html.slice(i, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}

// ---------- Stubs ----------
const painted = {};   // id -> textContent
const hiddenState = {}; // id -> hidden bool
function mkEl(id) {
  return {
    id,
    set textContent(v) { painted[id] = String(v); },
    get textContent() { return painted[id]; },
    classList: {
      toggle: (cls, force) => { if (cls === 'hidden') hiddenState[id] = !!force; },
      contains: (cls) => cls === 'hidden' ? !!hiddenState[id] : false,
      add: () => {}, remove: () => {},
    },
    style: {},
  };
}
const els = {};
const queryLog = [];   // {op, arg}
let valueCb = null;
let onceCalled = 0;
const fakeRef = {
  orderByChild: (c) => { queryLog.push(['orderByChild', c]); return fakeRef; },
  equalTo: (v) => { queryLog.push(['equalTo', v]); return fakeRef; },
  limitToLast: (n) => { queryLog.push(['limitToLast', n]); return fakeRef; },
  on: (ev, cb) => { if (ev === 'value') valueCb = cb; },
  off: () => { valueCb = null; },
  once: () => { onceCalled++; return Promise.resolve({ numChildren: () => 47 }); },
};
const sandbox = {
  document: { getElementById: (id) => (els[id] || (els[id] = mkEl(id))) },
  DrexCloud: { database: () => ({ ref: () => fakeRef }) },
  fetchCollabPosts: () => Promise.resolve([{ id: 'c1' }, { id: 'c2' }]),
  loadUserPostsGrid: () => {},
  appT: (k) => k,
  formatNumber: (n) => String(n),
  console,
  setTimeout, clearTimeout,
  Promise,
  _profilePostsRef: null,
  _userStatsRefs: [],
  _userStatsUid: 'u1',
  _profilePostsPage: undefined, // los define el bloque H3
};
vm.createContext(sandbox);

// Cargar el bloque H3 completo (consts + lets + funciones) tal cual está en el archivo.
const h3src = (() => {
  // tomar desde el comentario PERF H3 hasta el cierre de _attachProfilePostsListener
  const start = html.indexOf('// PERF ciclo 9 H3: paginación del grid de publicaciones');
  // _attachProfilePostsListener es la última función del bloque; termina antes de
  // "// H5: el perfil se abre/cierra" — extraer con balance de llaves desde "const PROFILE_POSTS_PAGE"
  const i = html.indexOf('const PROFILE_POSTS_PAGE = 30;');
  // encontrar el fin de _attachProfilePostsListener: buscar "  }\n" tras su inicio
  const fnStart = html.indexOf('function _attachProfilePostsListener() {', i);
  let j = html.indexOf('{', fnStart), depth = 0, end = -1;
  for (let k = j; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}') { depth--; if (!depth) { end = k + 1; break; } }
  }
  return html.slice(i, end);
})();
vm.runInContext(h3src, sandbox);
vm.runInContext(extractFn('_detachProfilePostsListener'), sandbox);

function snap(n) { return { numChildren: () => n }; }
const tick = () => new Promise(r => setTimeout(r, 20));

(async () => {
  // H3a: el query lleva limitToLast(30)
  queryLog.length = 0;
  vm.runInContext('_attachProfilePostsListener()', sandbox);
  const lim = queryLog.find(q => q[0] === 'limitToLast');
  check('H3a query con limitToLast(30)', !!lim && lim[1] === 30);

  // H3b1: n < página → total exacto en vivo
  await valueCb(snap(20));
  await tick();
  check('H3b n<página → total=20 en vivo', vm.runInContext('_profilePostsTotal', sandbox) === 20);
  check('H3e pinta "22 posts" (20+2 collab)', painted['profile-posts-title'] === '22 posts');
  check('H3e header/sidebar/mobile', painted['profile-posts-header'] === '22 publicaciones' && painted['sidebar-posts-count'] === '22' && painted['profile-posts-count-mobile'] === '22');
  check('H3d botón oculto si la página no va llena', hiddenState['profile-load-more-area'] === true);

  // H3b2: n == página y total desconocido → once('value') una vez
  vm.runInContext('_detachProfilePostsListener()', sandbox);
  queryLog.length = 0; onceCalled = 0;
  vm.runInContext('_attachProfilePostsListener()', sandbox);
  await valueCb(snap(30));
  await tick(); await tick();
  check('H3b página llena → once() para el total', onceCalled === 1);
  check('H3b total=47 tras el once()', vm.runInContext('_profilePostsTotal', sandbox) === 47);
  check('H3e pinta "49 posts" (47+2)', painted['profile-posts-title'] === '49 posts');
  check('H3d botón visible si página llena y total>page', hiddenState['profile-load-more-area'] === false);

  // H3c: cargar más → página 60 y re-query con limitToLast(60)
  queryLog.length = 0;
  vm.runInContext('_profilePostsLoadMore()', sandbox);
  check('H3c página sube a 60', vm.runInContext('_profilePostsPage', sandbox) === 60);
  const lim2 = queryLog.find(q => q[0] === 'limitToLast');
  check('H3c re-query con limitToLast(60)', !!lim2 && lim2[1] === 60);
  check('H3c conserva el total conocido', vm.runInContext('_profilePostsTotal', sandbox) === 47);

  // H3f: carrera — cambia el perfil antes de que resuelva el callback
  vm.runInContext('_detachProfilePostsListener()', sandbox);
  vm.runInContext('_attachProfilePostsListener()', sandbox);
  const cb = valueCb;
  const p = cb(snap(5)); // inicia (await fetchCollabPosts)
  vm.runInContext('_userStatsUid = "otro"', sandbox);
  await p; await tick();
  check('H3f no pinta si el perfil cambió', painted['profile-posts-title'] !== '7 posts');

  // H3: detach resetea
  vm.runInContext('_userStatsUid = "u1"', sandbox);
  vm.runInContext('_detachProfilePostsListener()', sandbox);
  check('H3 detach resetea página/total', vm.runInContext('_profilePostsPage', sandbox) === 30 && vm.runInContext('_profilePostsTotal', sandbox) === null);

  // ---------- H4 ----------
  let searchCalls = 0;
  const sbox2 = {
    document: {
      getElementById: (id) => id === 'search-input' ? fakeInput : mkEl(id),
    },
    performRealTimeSearch: () => { searchCalls++; },
    setTimeout, clearTimeout,
  };
  const fakeInput = { value: '', _handlers: {}, addEventListener(ev, fn) { this._handlers[ev] = fn; } };
  vm.createContext(sbox2);
  const h4start = html.indexOf("let _mainSearchDebounceTimer = null;");
  let k = html.indexOf('{', html.indexOf('addEventListener', h4start)), d2 = 0, e2 = -1;
  // el addEventListener('input', () => { ... }); — balancear desde la llave de la arrow
  for (let m = k; m < html.length; m++) {
    if (html[m] === '{') d2++;
    else if (html[m] === '}') { d2--; if (!d2) { e2 = m + 1; break; } }
  }
  const h4src = html.slice(h4start, html.indexOf(');', e2) + 2);
  vm.runInContext(h4src, sbox2);
  const fire = () => fakeInput._handlers['input']();

  searchCalls = 0; fakeInput.value = 'a'; fire();
  fakeInput.value = 'ab'; fire();
  fakeInput.value = 'abc'; fire();
  await new Promise(r => setTimeout(r, 120));
  check('H4a 3 teclas rápidas → 0 llamadas antes de 350ms', searchCalls === 0);
  await new Promise(r => setTimeout(r, 350));
  check('H4a 1 sola llamada tras el debounce', searchCalls === 1);

  searchCalls = 0; fakeInput.value = ''; fire();
  await new Promise(r => setTimeout(r, 60));
  check('H4b vaciar → llamada inmediata', searchCalls === 1);
  await new Promise(r => setTimeout(r, 400));
  check('H4b sin llamada extra del timer', searchCalls === 1);

  console.log(failures ? `\n${failures} FALLOS` : '\nTODOS LOS CHECKS PASARON');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('ERROR harness:', e); process.exit(1); });
