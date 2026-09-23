#!/usr/bin/env node
/* test_push_invariant.js — Guardia estática del inventario del ciclo 15.
 *
 * Escanea index.html y FALLA si encuentra un `await X.push(valor)` crudo, es
 * decir: el await aplicado al Ref que devuelve push(), sin `._writePromise`,
 * sin pushAsync() y sin `.set()` encadenado (patrón que no espera la escritura
 * y traga errores — ver INVENTARIO.md).
 *
 * Layout: resuelve ../index.html primero, fallback a ../src/index.html.
 * No depende del historial de git. Acepta un archivo objetivo opcional como
 * argv[2] (para el before/after contra un fixture).
 *
 * Uso: node tests/test_push_invariant.js [ruta-objetivo-opcional]
 */
'use strict';
const fs = require('fs');
const path = require('path');

function resolveTarget() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const here = __dirname;
  const cands = [path.join(here, '..', 'index.html'), path.join(here, '..', 'src', 'index.html')];
  for (const c of cands) { if (fs.existsSync(c)) return c; }
  console.error('FAIL: no se encontró index.html (../index.html ni ../src/index.html)');
  process.exit(2);
}

// Devuelve el índice del paréntesis de cierre que balancea el '(' en openIdx.
function matchParen(s, openIdx) {
  let depth = 0, inStr = null;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function isCommentLine(src, idx) {
  const ls = src.lastIndexOf('\n', idx) + 1;
  const line = src.slice(ls, src.indexOf('\n', idx) === -1 ? src.length : src.indexOf('\n', idx)).trim();
  return line.startsWith('//') || line.startsWith('*');
}

function scan(src, label) {
  // flat + mapa flat->original para números de línea exactos (array+join: O(n))
  const flatToOrig = [];
  const parts = [];
  let lastWasSpace = true;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      if (!lastWasSpace) { parts.push(' '); flatToOrig.push(i); lastWasSpace = true; }
    } else { parts.push(ch); flatToOrig.push(i); lastWasSpace = false; }
  }
  const flat = parts.join('');
  const lineOf = flatIdx => src.slice(0, flatToOrig[flatIdx]).split('\n').length;
  const problems = [];
  const okSites = [];
  // El operando no puede cruzar comentarios (// ni /* */): evita que un `await`
  // dentro de un comentario "coma" el .push() real de la línea siguiente.
  const re = /await\s+((?:(?!\/\/|\/\*)[^;{}]){1,220}?)\.(push|pushAsync)\s*\(/g;
  let m;
  while ((m = re.exec(flat)) !== null) {
    const operand = m[1];
    const callee = m[2];
    const lineNo = lineOf(m.index);
    if (isCommentLine(src, flatToOrig[m.index])) continue;
    if (!operand.includes('.ref(')) continue; // Array.push u otros: fuera de alcance

    if (callee === 'pushAsync') { okSites.push({ lineNo, kind: 'pushAsync' }); continue; }

    // push() crudo: ver qué sigue al paréntesis de cierre (ignorando espacios).
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = matchParen(flat, openIdx);
    const suffix = (closeIdx === -1 ? '' : flat.slice(closeIdx + 1, closeIdx + 24)).trimStart();
    if (suffix.startsWith('._writePromise')) { okSites.push({ lineNo, kind: '_writePromise' }); continue; }
    if (/^\.set\s*\(/.test(suffix)) { okSites.push({ lineNo, kind: 'await-al-set' }); continue; }
    problems.push({ lineNo, snippet: m[0].slice(0, 110), suffix: suffix.slice(0, 40) });
  }
  return { problems, okSites, label };
}

function main() {
  const target = resolveTarget();
  const src = fs.readFileSync(target, 'utf8');
  const { problems, okSites } = scan(src, target);
  console.log(`Objetivo: ${target}`);
  console.log(`Call-sites awaited-push clasificados como seguros: ${okSites.length}`);
  const kinds = {};
  okSites.forEach(s => { kinds[s.kind] = (kinds[s.kind] || 0) + 1; });
  console.log('  por patrón:', JSON.stringify(kinds));
  if (problems.length) {
    console.error(`\nFAIL: ${problems.length} await X.push() crudo(s) (clase c — pérdida potencial):`);
    problems.forEach(p => console.error(`  L${p.lineNo}: ${p.snippet} ... -> "${p.suffix}"`));
    process.exit(1);
  }
  console.log('PASS: ningún await X.push(valor) crudo. Inventario intacto.');
}

main();
