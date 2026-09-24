// C168 — Menciones agregadas al EDITAR un comentario.
// El mencionado nunca se enteraba: updateExistingComment no avisaba.
// Uso: node tests/test-c168.js [ruta-index.html]   (default: index.html del árbol)
// Debe FALLAR en base: node tests/test-c168.js index.base.html (exit 1)
// y PASAR con el parche (exit 0).
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(target, 'utf8');

// ---- extractor de una function: fase 1 salta la firma (defaults con {}),
//      fase 2 balancea llaves del cuerpo (cadenas, templates ${}, comentarios,
//      regex tenidos en cuenta) ----
function extractFunction(src, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) return null;
  const n = src.length;
  let i = m.index + m[0].length; // justo tras el '(' de la firma
  let state = 'code';
  const prevSig = () => {
    for (let k = i - 1; k >= 0; k--) {
      const c = src[k];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
      return c;
    }
    return '';
  };
  // FASE 1: fin de la firma (paréntesis balanceados; {} de defaults no cuentan como cuerpo)
  let pdepth = 1, sigEnd = -1;
  for (; i < n; i++) {
    const c = src[i], nx = src[i + 1];
    if (state === 'lineC') { if (c === '\n') state = 'code'; continue; }
    if (state === 'blockC') { if (c === '*' && nx === '/') { i++; state = 'code'; } continue; }
    if (state === 'sq') { if (c === '\\') i++; else if (c === "'") state = 'code'; continue; }
    if (state === 'dq') { if (c === '\\') i++; else if (c === '"') state = 'code'; continue; }
    if (state === 'tpl') {
      if (c === '\\') i++;
      else if (c === '`') state = 'code';
      else if (c === '$' && nx === '{') { pdepth++; state = 'code'; i++; }
      continue;
    }
    if (state === 'regex') {
      if (c === '\\') i++;
      else if (c === '[') state = 'regexCls';
      else if (c === '/') state = 'code';
      continue;
    }
    if (state === 'regexCls') { if (c === '\\') i++; else if (c === ']') state = 'regex'; continue; }
    if (c === "'") { state = 'sq'; continue; }
    if (c === '"') { state = 'dq'; continue; }
    if (c === '`') { state = 'tpl'; continue; }
    if (c === '/' && nx === '/') { state = 'lineC'; i++; continue; }
    if (c === '/' && nx === '*') { state = 'blockC'; i++; continue; }
    if (c === '/') {
      const p = prevSig();
      if (p === '' || '=,([{;:!&|?+-*~^%'.includes(p)) { state = 'regex'; continue; }
      continue;
    }
    if (c === '(' || c === '{') { pdepth++; continue; }
    if (c === ')' || c === '}') { pdepth--; if (pdepth === 0) { sigEnd = i; break; } continue; }
  }
  if (sigEnd < 0) return null;
  // FASE 2: cuerpo desde el primer '{' tras la firma
  i = src.indexOf('{', sigEnd);
  if (i < 0) return null;
  let depth = 0, started = false;
  state = 'code';
  const tplStack = [];
  for (; i < n; i++) {
    const c = src[i], nx = src[i + 1];
    if (state === 'lineC') { if (c === '\n') state = 'code'; continue; }
    if (state === 'blockC') { if (c === '*' && nx === '/') { i++; state = 'code'; } continue; }
    if (state === 'sq') { if (c === '\\') i++; else if (c === "'") state = 'code'; continue; }
    if (state === 'dq') { if (c === '\\') i++; else if (c === '"') state = 'code'; continue; }
    if (state === 'regex') {
      if (c === '\\') i++;
      else if (c === '[') state = 'regexCls';
      else if (c === '/') state = 'code';
      continue;
    }
    if (state === 'regexCls') { if (c === '\\') i++; else if (c === ']') state = 'regex'; continue; }
    if (state === 'tpl') {
      if (c === '\\') i++;
      else if (c === '`') state = 'code';
      else if (c === '$' && nx === '{') { tplStack.push(depth); depth++; state = 'code'; i++; }
      continue;
    }
    if (c === "'") { state = 'sq'; continue; }
    if (c === '"') { state = 'dq'; continue; }
    if (c === '`') { state = 'tpl'; continue; }
    if (c === '/' && nx === '/') { state = 'lineC'; i++; continue; }
    if (c === '/' && nx === '*') { state = 'blockC'; i++; continue; }
    if (c === '/') {
      const p = prevSig();
      if (p === '' || '=,([{;:!&|?+-*~^%'.includes(p)) { state = 'regex'; continue; }
      continue;
    }
    if (c === '{') { depth++; started = true; continue; }
    if (c === '}') {
      depth--;
      if (tplStack.length && depth === tplStack[tplStack.length - 1]) { tplStack.pop(); state = 'tpl'; continue; }
      if (depth === 0 && started && tplStack.length === 0) return src.slice(m.index, i + 1);
      continue;
    }
  }
  return null;
}

let passes = 0, failures = 0;
const failedLabels = [];
function check(label, cond, extra) {
  if (cond) { passes++; }
  else { failures++; failedLabels.push(label); console.log('FAIL:', label, extra || ''); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- 1. helper puro commentEditNewMentions ----
const helperSrc = extractFunction(src, 'commentEditNewMentions');
check('commentEditNewMentions está definida', !!helperSrc);

let newMentions = null;
if (helperSrc) {
  const emuSrc = extractFunction(src, 'extractMentionUsernames');
  check('extractMentionUsernames disponible para el helper', !!emuSrc);
  if (emuSrc) {
    const emu = new Function(emuSrc + '; return extractMentionUsernames;')();
    newMentions = new Function('extractMentionUsernames', helperSrc + '; return commentEditNewMentions;')(emu);
  }
}

const pureCases = [
  ['agrega mención nueva', 'hola mundo', 'hola @juan mundo', ['juan']],
  ['sin menciones', 'hola', 'hola mundo', []],
  ['mismas menciones, cambia texto', '@juan hola', 'hola @juan!', []],
  ['insensible a mayúsculas', '@Juan hola', 'hola @juan', []],
  ['quita mención, no avisa', '@juan hola', 'hola', []],
  ['varias nuevas', 'x', '@ana y @bob', ['ana', 'bob']],
  ['contenido previo vacío', '', '@ana hola', ['ana']],
  ['duplicada en el nuevo texto', '', '@ana @ana', ['ana']],
  ['mixta: una vieja + una nueva', '@ana hola', '@ana @bob chao', ['bob']],
  ['mención con guion/guion-bajo', 'x', '@maria-jose_2 ven', ['maria-jose_2']],
];
for (const [label, oldC, newC, want] of pureCases) {
  if (!newMentions) { check('delta: ' + label, false, '(helper ausente)'); continue; }
  let got;
  try { got = newMentions(oldC, newC); } catch (e) { got = 'THREW:' + e.message; }
  check('delta: ' + label, eq(got, want), 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

// ---- 2. sendMentionNotifications acepta onlyUsernames (7º parámetro) ----
const smnSrc = extractFunction(src, 'sendMentionNotifications');
check('sendMentionNotifications extraída', !!smnSrc);
check('sendMentionNotifications declara onlyUsernames', !!smnSrc && smnSrc.includes('onlyUsernames'));

async function behavioral() {
  const emuSrc = extractFunction(src, 'extractMentionUsernames');
  if (!smnSrc || !emuSrc) { check('behavioral: extracción', false); return; }
  const emu = new Function(emuSrc + '; return extractMentionUsernames;')();
  const uidByName = { ana: 'uid-ana', bob: 'uid-bob', ed: 'uid-ed' };
  let notified = [];
  const mockDb = {
    database: () => ({
      ref: (p) => {
        if (p.indexOf('usernames/') === 0) {
          const nm = p.slice('usernames/'.length);
          return { once: () => Promise.resolve({ val: () => uidByName[nm] || null }) };
        }
        throw new Error('ref inesperado: ' + p);
      }
    })
  };
  const mockAdd = (uid, msg, type, meta) => { notified.push({ uid, msg, type, meta }); return Promise.resolve(); };
  let smn;
  try {
    smn = new Function('extractMentionUsernames', 'DrexCloud', 'addNotification',
      smnSrc + '; return sendMentionNotifications;')(emu, mockDb, mockAdd);
  } catch (e) { check('behavioral: compila sendMentionNotifications', false, e.message); return; }

  // T1 (la que FALLA en base): con onlyUsernames=['bob'], @ana NO se re-notifica.
  notified = [];
  await smn('@ana mira esto @bob', 'uid-ed', 'Ed', 'comentario', ['uid-ed'], { postId: 'p1' }, ['bob']);
  const uids1 = notified.map(x => x.uid).sort();
  check('T1: onlyUsernames avisa SOLO el delta', eq(uids1, ['uid-bob']),
    'notified=' + JSON.stringify(uids1));
  check('T1: tipo mention', notified.length === 1 && notified[0].type === 'mention');
  check('T1: navegación post/p1',
    notified.length === 1 && notified[0].meta && notified[0].meta.actionType === 'post' && notified[0].meta.actionId === 'p1');
  check('T1: mensaje de comentario',
    notified.length === 1 && /mencionó en un comentario/.test(notified[0].msg),
    notified.length ? notified[0].msg : '(sin avisos)');

  // T2 (compatibilidad: pasa en base y con parche): sin 7º arg extrae del contenido.
  notified = [];
  await smn('@ana @bob hola', 'uid-ed', 'Ed', 'comentario', ['uid-ed'], { postId: 'p2' });
  check('T2: sin onlyUsernames extrae del contenido', eq(notified.map(x => x.uid).sort(), ['uid-ana', 'uid-bob']),
    JSON.stringify(notified.map(x => x.uid)));

  // T3: delta vacío → cero avisos.
  notified = [];
  await smn('hola @bob', 'uid-ed', 'Ed', 'comentario', ['uid-ed'], { postId: 'p3' }, []);
  check('T3: delta vacío no avisa', notified.length === 0, 'n=' + notified.length);

  // T4: el propio autor nunca se auto-avisa aunque esté en el delta.
  notified = [];
  await smn('x', 'uid-ed', 'Ed', 'comentario', ['uid-ed'], { postId: 'p4' }, ['ed']);
  check('T4: sin auto-aviso', notified.length === 0, 'n=' + notified.length);
}

behavioral().then(() => {
  console.log('----');
  console.log('target: ' + target);
  console.log('passes: ' + passes + '  failures: ' + failures);
  if (failures) { console.log('fallos:'); failedLabels.forEach(l => console.log('  - ' + l)); }
  process.exit(failures ? 1 : 0);
}).catch(e => { console.error('ERROR harness:', e); process.exit(2); });
