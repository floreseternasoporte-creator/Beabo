'use strict';
/* C225: doble-tap ❤️ en el chat — la reacción debe ir al mensaje tocado.
 *
 * Bug real: había TRES detectores de doble-tap y ninguno dirigía la reacción
 * al mensaje correcto:
 *  1. _attachDoubleTapHeart (click delegado) escribía `_activeChatMsgId`,
 *     variable que NADIE leía (submitChatReaction lee activeReactionMsgId /
 *     window._lastReactionMsgId) → el corazón caía en otro mensaje o en ninguno.
 *  2. touchend doble-tap por burbuja → submitChatReaction('me gusta') sin id
 *     → usaba el último id del picker (mensaje equivocado) o null (no-op).
 *  3. dblclick por burbuja → mismo problema que (2).
 * Fix: submitChatReaction(emoji, msgIdOpt) acepta id explícito y los tres
 * atajos lo pasan (msgId / resolvedId).
 *
 * Este test EXTRAE la función real del index.html y la ejecuta en vm contra
 * un DrexCloud falso, más aserciones de patrón sobre los call sites.
 *
 * Uso: node tests/test-c225-chat-doubletap-reaction.js [--target <html>]
 *   --target: correr contra una copia prístina para dictaminar rojo/verde.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let TARGET = path.join(ROOT, 'index.html');
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) TARGET = process.argv[i + 1];
}
const src = fs.readFileSync(TARGET, 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

// ---- extracción por balanceo de llaves ----
function extractFunction(source, sigRe) {
  const m = sigRe.exec(source);
  if (!m) return null;
  let i = source.indexOf('{', m.index);
  let depth = 0;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return source.slice(m.index, i + 1); }
  }
  return null;
}

const fnSrc = extractFunction(src, /function submitChatReaction\(/);
check('submitChatReaction extraída del HTML', !!fnSrc);

// ---- harness funcional ----
function runReaction({ emoji, optId, activeId, lastId, snapVal }) {
  const writes = [];
  const prelude = `
    var __writes = [];
    var __snapVal = ${JSON.stringify(snapVal === undefined ? null : snapVal)};
    let activeReactionMsgId = ${JSON.stringify(activeId)};
    var window = { _lastReactionMsgId: ${JSON.stringify(lastId)} };
    var currentChatRoomId = 'room-1';
    function hideChatReactionPicker() {}
    var DrexCloud = {
      auth: function () { return { currentUser: { uid: 'uid-me' } }; },
      database: function () {
        return {
          ref: function (p) {
            return {
              path: p,
              once: function () {
                return { then: function (cb) { cb({ val: function () { return __snapVal; } }); return Promise.resolve(); } };
              },
              set: function (v) { __writes.push({ op: 'set', path: p, v: v }); return Promise.resolve(); },
              remove: function () { __writes.push({ op: 'remove', path: p }); return Promise.resolve(); }
            };
          }
        };
      }
    };
  `;
  const driver = `\nsubmitChatReaction(${JSON.stringify(emoji)}, ${optId === undefined ? 'undefined' : JSON.stringify(optId)});\n__writes;`;
  const sandbox = {};
  vm.createContext(sandbox);
  const result = vm.runInContext(prelude + '\n' + fnSrc + '\n' + driver, sandbox, { timeout: 5000 });
  return result.map(w => ({ op: w.op, path: w.path, v: w.v }));
}

if (fnSrc) {
  // F1 (el bug): doble-tap en msg-B con el picker manchado por msg-A.
  const w1 = runReaction({ emoji: 'me gusta', optId: 'msg-B', activeId: null, lastId: 'msg-A', snapVal: null });
  check('F1: doble-tap con id explícito escribe en msg-B (no en msg-A)',
    w1.length === 1 && w1[0].op === 'set' && w1[0].path === 'msgReactions/room-1/msg-B/uid-me' && w1[0].v === 'me gusta',
    JSON.stringify(w1));

  // F2: el picker sigue funcionando sin id explícito.
  const w2 = runReaction({ emoji: 'jaja', optId: undefined, activeId: 'msg-C', lastId: null, snapVal: null });
  check('F2: sin id explícito se usa activeReactionMsgId (picker intacto)',
    w2.length === 1 && w2[0].path === 'msgReactions/room-1/msg-C/uid-me',
    JSON.stringify(w2));

  // F3: sin ningún id no hay escritura (no-op elegante).
  const w3 = runReaction({ emoji: 'me gusta', optId: undefined, activeId: null, lastId: null, snapVal: null });
  check('F3: sin id no se escribe nada', w3.length === 0, JSON.stringify(w3));

  // F4: toggle — si ya reaccioné igual, se quita.
  const w4 = runReaction({ emoji: 'me gusta', optId: 'msg-D', activeId: null, lastId: null, snapVal: 'me gusta' });
  check('F4: toggle quita la reacción existente',
    w4.length === 1 && w4[0].op === 'remove' && w4[0].path === 'msgReactions/room-1/msg-D/uid-me',
    JSON.stringify(w4));
}

// ---- aserciones de patrón sobre los call sites ----
check('P1: _attachDoubleTapHeart pasa msgId a submitChatReaction',
  /_attachDoubleTapHeart[\s\S]{0,1200}?submitChatReaction\('me gusta',\s*msgId\)/.test(src));
check('P2: no queda referencia a _activeChatMsgId (variable fantasma)',
  !/_activeChatMsgId/.test(src));
check('P3: doble-tap táctil pasa resolvedId',
  /_tapTime < 300\)\s*\{\s*e\.preventDefault\(\);\s*submitChatReaction\('me gusta',\s*resolvedId\)/.test(src));
check('P4: dblclick pasa resolvedId',
  /addEventListener\('dblclick',\s*\(\)\s*=>\s*submitChatReaction\('me gusta',\s*resolvedId\)\)/.test(src));
check('P5: la firma acepta id explícito con prioridad',
  /function submitChatReaction\(\s*emoji\s*,\s*msgIdOpt\s*\)/.test(src) &&
  /msgIdOpt \|\| activeReactionMsgId \|\| window\._lastReactionMsgId/.test(src));

console.log(`\nC225: ${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
