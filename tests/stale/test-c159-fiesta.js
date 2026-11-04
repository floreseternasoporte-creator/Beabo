/* ================================================================
 * C159 — XSS almacenado en "Quién es el mentiroso" vía UID forjado
 *
 * HALLAZGO: en `fiestaGameHTMLVote` (pantalla de votación del juego de
 * fiestas) el UID de cada jugador se interpolaba CRUDO en
 *   <button onclick="fiestaGameVote('<UID>')">
 * Los `players` del doc `fiestas/<sala>/game` los escribe el dueño (su
 * cliente hace `db.ref('fiestas/'+sid+'/game').set({players: uids, ...})`
 * en fiestaGameStartNow), así que un dueño malicioso puede forjarlos con
 * escritura directa a RTDB sin pasar por la UI: las keys de RTDB admiten
 * comilla simple (solo se prohíben . $ # [ ] / y controles). El filtro
 * `fiestaGameActivePlayers` exige además que el UID exista en
 * `fiestaMembers/<sala>` (el dueño también lo escribe al crear la sala).
 * Con players=["<victima>", "');window.__XSS=1;//"] y status 'vote', TODAS
 * las víctimas renderizan
 *   onclick="fiestaGameVote('');window.__XSS=1;//')"
 * y al tocar el botón del atacante se ejecuta JS arbitrario en su sesión
 * (PoC verificado en Chromium 152 real con las funciones REALES extraídas
 * de index.html: title=PWNED tras el click).
 *
 * FIX (mínimo, patrón escapeInlineSingleQuote): nuevo helper
 * `fiestaGameEscJs` (primero escape JS de \ y ', luego entidades HTML
 * & " < > — las entidades solas NO bastan porque el parser HTML las
 * decodifica ANTES de compilar el handler) y su uso en el único sink:
 * `fiestaGameVote('` + fiestaGameEscJs(uid) + `')`. Post-fix el payload
 * queda como `\'` dentro del literal: el handler ya no compila
 * (SyntaxError) y nada se ejecuta (verificado en Chromium real: SAFE).
 *
 * Ejecutar con: node tests/test-c159-fiesta.js [ruta-index.html]
 * (sin argumento usa el index.html del repo; con la copia vulnerable
 *  el test FALLA, demostrando que cubre el vector).
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const htmlPath = process.argv[2] || path.join(ROOT, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

let failures = 0;
function tcase(name, fn) {
  try {
    const ok = fn();
    console.log((ok ? 'ok - ' : 'NOT OK - ') + name);
    if (!ok) failures++;
  } catch (e) {
    console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
    failures++;
  }
}

// Extrae el cuerpo de `function name(` con balance de llaves.
function extractFn(src, name) {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no encontrada: ' + name);
  let j = src.indexOf('{', i), depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}

const EVIL_UID = "');window.__XSS_C159=1;//";
const VICTIM_UID = 'victimid123';

function buildSandbox() {
  const sandbox = {
    window: {},
    appT: (s) => s,
    fiestaMyUid: VICTIM_UID,
    fiestaCur: { id: 'room1' },
    fiestaAmHost: false,
    fiestaGameMyVote: null,
    fiestaMembers: { [VICTIM_UID]: { name: 'Victima' }, [EVIL_UID]: { name: 'Atacante' } },
    fiestaGame: { status: 'vote', players: [VICTIM_UID, EVIL_UID], out: [], voteCount: 1, round: 1, turnIndex: 0 },
  };
  vm.createContext(sandbox);
  const fns = ['fiestaGameEsc', 'fiestaGameMember', 'fiestaGameName',
    'fiestaGameAvatarHTML', 'fiestaGameActivePlayers', 'fiestaGameHTMLVote'];
  for (const fn of fns) vm.runInContext(extractFn(html, fn), sandbox);
  // En el código vulnerable el helper no existe: el sink interpola el uid
  // crudo. Definirlo como identidad reproduce fielmente ese comportamiento
  // para que los checks conductuales demuestren el exploit pre-fix.
  if (html.indexOf('function fiestaGameEscJs(') !== -1) {
    vm.runInContext(extractFn(html, 'fiestaGameEscJs'), sandbox);
  } else {
    vm.runInContext('function fiestaGameEscJs(s) { return String(s == null ? "" : s); }', sandbox);
  }
  return sandbox;
}

// ---- 1. Anclaje: el fix existe y cubre el sink ----
tcase('existe el helper `function fiestaGameEscJs(s)`', () =>
  /function fiestaGameEscJs\(s\)/.test(html));

tcase('el sink usa `fiestaGameEscJs(uid)` (no el uid crudo)', () =>
  /fiestaGameVote\(\\'' \+ fiestaGameEscJs\(uid\) \+ '\\'\)/.test(html));

tcase('no queda interpolación cruda `+ uid +` en el onclick del voto', () =>
  !/fiestaGameVote\(\\'' \+ uid \+ '\\'\)/.test(html));

// ---- 2. Comportamiento: el payload ya no es ejecutable ----
function evilOnclickAttr() {
  const sandbox = buildSandbox();
  const out = vm.runInContext('fiestaGameHTMLVote()', sandbox);
  const attrs = [];
  const re = /onclick="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(out)) !== null) attrs.push(m[1]);
  return attrs.find(a => a.indexOf('XSS_C159') !== -1) || null;
}

tcase('el botón del UID forjado se renderiza (el vector es alcanzable)', () =>
  evilOnclickAttr() !== null);

tcase('EJECUTAR el handler del payload no define la flag (payload inertizado como string)', () => {
  const attr = evilOnclickAttr();
  if (attr === null) return false;
  const sandbox = { window: {}, fiestaGameVote: () => {} };
  vm.createContext(sandbox);
  try {
    vm.runInContext(attr, sandbox);
  } catch (e) { /* SyntaxError también vale: nada se ejecutó */ }
  return sandbox.window.__XSS_C159 !== 1;
});

tcase('el handler es exactamente UNA llamada con UN string (todas sus comillas escapadas)', () => {
  const attr = evilOnclickAttr();
  // Pre-fix: fiestaGameVote('');window.__XSS_C159=1;//')  -> no casa
  // Post-fix: fiestaGameVote('\');window.__XSS_C159=1;//') -> casa
  return attr !== null && /^fiestaGameVote\('(?:\\'|[^'])*'\)$/.test(attr);
});

// ---- 3. Sin regresión: UIDs legítimos intactos ----
tcase('UID normal `abc123` produce `fiestaGameVote(\'abc123\')` intacto', () => {
  const sandbox = buildSandbox();
  sandbox.fiestaMembers = { abc123: { name: 'Ana' }, xyz789: { name: 'Beto' } };
  vm.runInContext('fiestaMembers = ' + JSON.stringify(sandbox.fiestaMembers) + ';', sandbox);
  sandbox.fiestaGame = { status: 'vote', players: ['abc123', 'xyz789'], out: [], voteCount: 0, round: 1, turnIndex: 0 };
  vm.runInContext('fiestaMyUid = "abc123"; fiestaGame = ' + JSON.stringify(sandbox.fiestaGame) + ';', sandbox);
  const out = vm.runInContext('fiestaGameHTMLVote()', sandbox);
  return out.indexOf("fiestaGameVote('xyz789')") !== -1;
});

tcase('UID con `"` no rompe el atributo (una sola tokenización onclick)', () => {
  const sandbox = buildSandbox();
  const q = 'a"b';
  sandbox.fiestaMembers = { [VICTIM_UID]: { name: 'V' }, [q]: { name: 'Q' } };
  sandbox.fiestaGame = { status: 'vote', players: [VICTIM_UID, q], out: [], voteCount: 0, round: 1, turnIndex: 0 };
  vm.runInContext('fiestaMembers = ' + JSON.stringify(sandbox.fiestaMembers) + ';', sandbox);
  vm.runInContext('fiestaGame = ' + JSON.stringify(sandbox.fiestaGame) + ';', sandbox);
  const out = vm.runInContext('fiestaGameHTMLVote()', sandbox);
  const attrs = [];
  const re = /([a-zA-Z-]+)="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(out)) !== null) attrs.push(m[1]);
  const onclicks = attrs.filter(a => a === 'onclick');
  // 1 botón (el propio se filtra) con su onclick íntegro
  return onclicks.length === 1 && out.indexOf('fiestaGameVote(\'a&quot;b\')') !== -1;
});

console.log(failures ? `\n${failures} FALLOS` : '\nTODOS LOS CHECKS PASARON');
process.exit(failures ? 1 : 0);
