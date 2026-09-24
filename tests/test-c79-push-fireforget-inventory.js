/* ================================================================
 * C79-A1: inventario pineado de los `.push(valor)` restantes contra la
 * base de datos (fire-and-forget o await-crudo sobre el Ref).
 *
 * La auditoría del ciclo 79 revisó call-site por call-site todos los
 * writes primarios restantes con `push(valor)` y concluyó que ninguno
 * pierde datos del usuario de forma demostrable:
 *
 *  - 9× `conversationMessages/` con payload `system: true`: mensajes
 *    decorativos de administración de grupos (crear, renombrar, foto,
 *    promover/degradar admin, expulsar, salir, agregar miembro) +
 *    "se unió al grupo" (grupo público). Excluidos deliberadamente
 *    desde C75: la acción primaria ya se persistió antes; convertir el
 *    aviso en error bloqueante generaría falsos errores post-acción.
 *  - 2× `fiestas/<id>/chat` (`sys: true`, entrar/salir de sala):
 *    broadcast cosmético, fire-and-forget documentado en el código.
 *  - 1× `fiestaReactions/`: cosmético efímero (el flotante local de
 *    2.7 s es feedback del emisor, no estado persistente).
 *  - 1× `notesRef.push(note)`: rama else legacy tras comprobar
 *    pushAsync (el shim siempre lo tiene); además encadena
 *    `._writePromise`, así que es honesto.
 *  - 1× `pushAsync` en `communityNotes` (anuncio de música): auxiliar
 *    envuelto en try/catch propio (C79-F1); un fallo ya no reporta
 *    "No se pudo publicar" para una canción guardada.
 *
 * Este test FALLA si aparece un `.push(valor)` nuevo contra la DB que
 * no encaje en el inventario, o si un sitio decorativo deja de llevar
 * su marca `sys`/`system` (un mensaje real colado en la lista).
 *
 * Ejecutar con: node tests/test-c79-push-fireforget-inventory.js
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function matchParen(s, openIdx) {
  let depth = 0, str = null;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (str) {
      if (ch === '\\') { i++; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const sites = [];
// `.push(` encadenado DIRECTAMENTE a `.ref(...)` (misma sentencia, con
// balanceo de paréntesis para paths dinámicos): descarta los Array.push
// (posts.push, entries.push, etc.).
{
  const re = /\.ref\(/g;
  let m;
  while ((m = re.exec(HTML)) !== null) {
    const refOpen = m.index + 4; // el '(' de .ref(
    const refClose = matchParen(HTML, refOpen);
    if (refClose < 0) continue;
    const pm = /^\s*\.push\(/.exec(HTML.slice(refClose + 1, refClose + 60));
    if (!pm) continue;
    const pushOpen = refClose + 1 + pm[0].length - 1;
    const pushClose = matchParen(HTML, pushOpen);
    if (pushClose < 0) continue;
    const arg = HTML.slice(pushOpen + 1, pushClose).trim();
    if (!arg) continue; // reserva de key (.push() sin valor): fuera de alcance
    const refArg = HTML.slice(refOpen + 1, refClose);
    const lit = /^'([^']*)'/.exec(refArg);
    const lineNo = HTML.slice(0, m.index).split('\n').length;
    sites.push({ lineNo, refPath: lit ? lit[1] : '(ref dinámico)', refArg, arg });
  }
}
// Caso especial: notesRef.push(note) (receiver es variable, no .ref literal).
{
  const idx = HTML.indexOf('notesRef.push(note)');
  if (idx >= 0) sites.push({ lineNo: HTML.slice(0, idx).split('\n').length, refPath: 'notesRef', arg: 'note', legacy: true });
}

function classify(site) {
  const decorative = /\bsys\s*:\s*true\b|\bsystem\s*:\s*true\b/.test(site.arg);
  if (site.legacy && /_writePromise/.test(HTML.slice(HTML.indexOf('notesRef.push(note)'), HTML.indexOf('notesRef.push(note)') + 120))) {
    return 'legacy-fallback';
  }
  // Rama else legacy del anuncio de música: push crudo pero con await al
  // _writePromise (honesto); el shim siempre expone pushAsync, así que es
  // código muerto defensivo.
  if (site.refPath === 'communityNotes' && site.arg === 'note' &&
      /await noteRef\._writePromise/.test(HTML.slice(HTML.indexOf("ref('communityNotes').push(note)"), HTML.indexOf("ref('communityNotes').push(note)") + 130))) {
    return 'legacy-fallback';
  }
  if (site.refPath.startsWith('conversationMessages/') && decorative) return 'decorative-c75';
  if (/^'fiestas\/'/.test(site.refArg) && /\/chat/.test(site.refArg) && decorative) return 'cosmetic-broadcast';
  if (site.refPath.startsWith('fiestaReactions/')) return 'cosmetic-ephemeral';
  return null;
}

let failed = 0;
const counts = {};
for (const s of sites) {
  const kind = classify(s);
  if (!kind) {
    failed++;
    console.log(`FALLO - sitio no clasificado L${s.lineNo}: ref=${s.refPath} arg=${s.arg.slice(0, 70).replace(/\n/g, ' ')}`);
  } else {
    counts[kind] = (counts[kind] || 0) + 1;
  }
}

const EXPECTED = {
  'decorative-c75': 9,
  'cosmetic-broadcast': 2,
  'cosmetic-ephemeral': 1,
  'legacy-fallback': 2, // notesRef.push(note) + else del anuncio de música
};
for (const [kind, n] of Object.entries(EXPECTED)) {
  try {
    assert.strictEqual(counts[kind] || 0, n, `${kind}: hay ${counts[kind] || 0}, se esperaban ${n}`);
    console.log(`ok - ${kind}: ${n}`);
  } catch (e) { failed++; console.log('FALLO - ' + e.message); }
}

// El anuncio de música usa pushAsync (API honesta) y debe llevar la guarda C79-F1.
{
  try {
    const re = /musicDb\(\)\.ref\('communityNotes'\)\.pushAsync\(/g;
    let m, idx = -1;
    while ((m = re.exec(HTML)) !== null) { idx = m.index; }
    assert.ok(idx >= 0, 'no se encontró el pushAsync del anuncio de música');
    const ctx = HTML.slice(Math.max(0, idx - 700), idx);
    assert.ok(/C79-F1/.test(ctx), 'el anuncio de música debe llevar la guarda C79-F1 (try/catch best-effort)');
    console.log('ok - announce-best-effort: pushAsync con guarda C79-F1');
  } catch (e) { failed++; console.log('FALLO - ' + e.message); }
}

console.log(failed ? `\n${failed} FALLO(S)` : '\nInventario fire-and-forget intacto y clasificado.');
process.exit(failed ? 1 : 0);
