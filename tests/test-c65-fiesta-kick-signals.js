/* ================================================================
 * C65-F1: expulsar de una fiesta debe limpiar la bandeja de señales
 * WebRTC del expulsado (fiestaSignals/<id>/<uid>).
 *
 * Defecto (base, PoC): `fiestaKickMember()` escribía
 * `fiestaKicked/<id>/<uid>` y borraba `fiestaMembers/<id>/<uid>`, pero no
 * tocaba `fiestaSignals/<id>/<uid>`. Con la app del expulsado cerrada o en
 * segundo plano su cliente nunca llegaba a `leaveFiesta()` (que sí limpia
 * su inbox) y la bandeja quedaba huérfana hasta el fin de la fiesta. Las
 * señales llevan IPs en SDP/ICE (ver C53-F1) y los miembros restantes
 * podían seguir escribiendo candidatos en ese inbox durante la ventana de
 * caída del peer (~12 s del heal loop).
 *
 * Fix: `fiestaKickMember()` también hace
 * `fiestaSignals/<id>/<uid>.remove()` (best-effort, como sus hermanos).
 * Los miembros restantes ya sueltan sus RTCPeerConnection vía
 * `fiestaSyncPeers()` al actualizarse la lista de miembros.
 *
 * Extrae la función REAL de ../index.html (sin rutas absolutas ni git).
 * Ejecutar con: node tests/test-c65-fiesta-kick-signals.js
 * Con BASE_POC=1 se corre el PoC contra la base sin fix.
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Extracción por balanceo de llaves (respeta strings y comentarios).
function extractFn(src, name) {
  const m = new RegExp('(async\\s+)?function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('no encontrada: ' + name);
  let i = src.indexOf('{', m.index);
  const start = m.index;
  let depth = 0, str = null, tpl = 0, lineC = false, blockC = false, esc = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (lineC) { if (c === '\n') lineC = false; continue; }
    if (blockC) { if (c === '*' && n === '/') { blockC = false; i++; } continue; }
    if (str) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (str === '`' && c === '$' && n === '{') { tpl++; i++; continue; }
      if (c === str && tpl === 0) { str = null; continue; }
      if (str === '`' && c === '}' && tpl > 0) { tpl--; continue; }
      continue;
    }
    if (c === '/' && n === '/') { lineC = true; i++; continue; }
    if (c === '/' && n === '*') { blockC = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { str = c; tpl = 0; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('llaves sin cerrar: ' + name);
}

/* ---------- DrexCloud falso (BD en memoria) ---------- */
const db = {};
function segs(p) { return p.split('/').filter(Boolean); }
function dbGet(p) {
  let n = db;
  for (const s of segs(p)) { if (n == null || typeof n !== 'object') return undefined; n = n[s]; }
  return n;
}
function dbSet(p, v) {
  const ss = segs(p); let n = db;
  for (let i = 0; i < ss.length - 1; i++) { if (typeof n[ss[i]] !== 'object' || n[ss[i]] === null) n[ss[i]] = {}; n = n[ss[i]]; }
  n[ss[ss.length - 1]] = v;
}
function dbRemove(p) {
  const ss = segs(p); let n = db;
  for (let i = 0; i < ss.length - 1; i++) { if (typeof n[ss[i]] !== 'object' || n[ss[i]] === null) return; n = n[ss[i]]; }
  delete n[ss[ss.length - 1]];
}
const snapOf = v => ({ val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))), exists: () => v !== undefined });
function fakeRef(path) {
  return {
    key: segs(path).pop(),
    set(v) { return Promise.resolve().then(() => { dbSet(path, v); }); },
    remove() { return Promise.resolve().then(() => { dbRemove(path); }); },
    once() { return Promise.resolve(snapOf(dbGet(path))); },
  };
}
const toasts = [];
const sandbox = {
  console,
  DrexCloud: { database: () => ({ ref: p => fakeRef(p) }) },
  showMiniToast: m => { toasts.push(String(m)); },
  appT: s => s,
  confirm: () => true,
  setTimeout, clearTimeout, Promise,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const PRELUDE = [
  'let fiestaCur = { id: "f1" };',
  'let fiestaAmHost = true;',
  'let fiestaMyUid = "u1";',
  ''
].join('\n');
vm.runInContext(PRELUDE + extractFn(HTML, 'fiestaKickMember'), sandbox, { filename: 'kick-under-test.js' });

function resetDb() { for (const k of Object.keys(db)) delete db[k]; toasts.length = 0; }

async function main() {
  resetDb();
  // Estado previo: miembro activo con señales WebRTC en vuelo en su inbox.
  dbSet('fiestaMembers/f1/u2', { name: 'Bob', role: 'speaker' });
  dbSet('fiestaSignals/f1/u2/k1', { type: 'offer', from: 'u1', sdp: 'v=0...' });
  dbSet('fiestaSignals/f1/u2/k2', { type: 'candidate', from: 'u3', candidate: { ip: '10.0.0.9' } });

  await vm.runInContext('fiestaKickMember("u2")', sandbox);

  const kicked = dbGet('fiestaKicked/f1/u2');
  const member = dbGet('fiestaMembers/f1/u2');
  const signals = dbGet('fiestaSignals/f1/u2');

  assert(kicked && kicked.by === 'u1', 'fiestaKicked debe registrar la expulsión');
  assert(member === undefined, 'el miembro debe salir de fiestaMembers');

  if (process.env.BASE_POC === '1') {
    // PoC: en la base el inbox de señales sobrevive a la expulsión.
    assert(signals !== undefined, 'PoC base: se esperaba el inbox huérfano');
    assert(signals.k1 && signals.k2, 'PoC base: las señales en vuelo siguen ahí');
    console.log('PoC OK (base): fiestaSignals/f1/u2 huérfano tras la expulsión (defecto presente)');
    return;
  }
  assert(signals === undefined, 'fiestaSignals/f1/u2 debe limpiarse al expulsar');
  console.log('OK  expulsión: kick registrado + miembro removido + inbox de señales limpio');
}

main().then(() => console.log('C65-F1: PASS'), err => { console.error('FAIL:', err.message); process.exit(1); });
