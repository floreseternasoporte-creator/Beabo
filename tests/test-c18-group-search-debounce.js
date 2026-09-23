// test-c18-group-search-debounce.js
// Regresión ciclo 18: el buscador de "crear grupo de chat" debe tener debounce.
// Sin él, cada tecla disparaba 1 query al índice usernames + hasta 20 lecturas
// completas de perfil. El harness extrae la función REAL de index.html, la
// ejecuta en vm con timers falsos y simula 4 teclas rápidas: la BD solo debe
// verse UNA vez (con la última query), no 4.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function findIndexHtml() {
  const cands = [
    path.join(__dirname, '..', 'index.html'),
    path.join(__dirname, '..', 'src', 'index.html'),
  ];
  for (const c of cands) { if (fs.existsSync(c)) return c; }
  throw new Error('index.html no encontrado');
}

function extractFunction(src) {
  const decl = 'let _groupChatSearchDebounceTimer = null;';
  const di = src.indexOf(decl);
  assert.ok(di !== -1, 'declaración del timer de debounce ausente (regresión)');
  const fi = src.indexOf('function searchUsersForGroupChat(query) {', di);
  assert.ok(fi !== -1, 'searchUsersForGroupChat no encontrada');
  const open = src.indexOf('{', fi);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0, 'no se pudo cerrar la función');
  return decl + '\n' + src.slice(fi, i + 1);
}

const html = fs.readFileSync(findIndexHtml(), 'utf8');
const fnSrc = extractFunction(html);

const sandbox = {
  __dbCalls: [],
  __results: { innerHTML: '' },
  __timers: [],
  __nextTimerId: 1,
  document: null, // se asigna abajo (necesita referenciar sandbox)
  DrexCloud: { auth: () => ({ currentUser: { uid: 'me' } }) },
  searchUserDirectoryByPrefix: (q, limit) => {
    sandbox.__dbCalls.push([q, limit]);
    return Promise.resolve([]);
  },
  groupChatSelectedUsers: [],
};
sandbox.document = {
  getElementById: (id) => (id === 'group-chat-search-results' ? sandbox.__results : null),
};
sandbox.setTimeout = (fn, ms) => {
  const id = sandbox.__nextTimerId++;
  sandbox.__timers.push({ id, fn, ms });
  return id;
};
sandbox.clearTimeout = (id) => {
  sandbox.__timers = sandbox.__timers.filter(t => t.id !== id);
};
sandbox.__flushTimers = () => {
  const n = sandbox.__timers.length;
  while (sandbox.__timers.length) { const t = sandbox.__timers.shift(); t.fn(); }
  return n;
};
sandbox.__pendingCount = () => sandbox.__timers.length;
vm.createContext(sandbox);

const driver = `
  // 4 teclas rápidas (da -> dar -> dare -> darel)
  searchUsersForGroupChat('da');
  searchUsersForGroupChat('dar');
  searchUsersForGroupChat('dare');
  searchUsersForGroupChat('darel');
  __keystrokesDone = __dbCalls.length;   // debe ser 0: nada antes del flush
  __flushed = __flushTimers();            // dispara solo el último timer
`;
sandbox.__keystrokesDone = -1;
sandbox.__flushed = -1;
vm.runInContext(fnSrc + '\n' + driver, sandbox, { filename: 'searchUsersForGroupChat.js' });

assert.strictEqual(sandbox.__keystrokesDone, 0,
  `la BD se tocó ${sandbox.__keystrokesDone} veces ANTES del debounce (esperado 0)`);
assert.strictEqual(sandbox.__flushed, 1,
  `quedaron ${sandbox.__flushed} timers tras 4 teclas (esperado 1: solo el último)`);
assert.strictEqual(sandbox.__dbCalls.length, 1,
  `la BD se consultó ${sandbox.__dbCalls.length} veces (esperado 1)`);
assert.deepStrictEqual(sandbox.__dbCalls[0], ['darel', 20],
  `query final inesperada: ${JSON.stringify(sandbox.__dbCalls[0])}`);

// Query corta (<2 chars) no debe programar nada y limpia resultados
vm.runInContext(`
  __results.innerHTML = 'algo';
  searchUsersForGroupChat('d');
  __shortPending = __pendingCount();
  __shortHtml = __results.innerHTML;
`, sandbox);
assert.strictEqual(sandbox.__shortPending, 0, 'query corta programó un timer');
assert.strictEqual(sandbox.__shortHtml, '', 'query corta no limpió los resultados');

// El "Buscando..." se pinta sincrónico (UX intacta) antes del flush
vm.runInContext(`
  __results.innerHTML = '';
  searchUsersForGroupChat('darel');
  __syncHtml = __results.innerHTML;
  __syncPending = __pendingCount();
`, sandbox);
assert.ok(sandbox.__syncHtml.includes('Buscando'), 'el indicador Buscando... no se pinta sincrónico');
assert.strictEqual(sandbox.__syncPending, 1, 'la query válida no programó el timer');

console.log('test-c18-group-search-debounce: OK (1 consulta DB tras 4 teclas; corta sin red; UX intacta)');
