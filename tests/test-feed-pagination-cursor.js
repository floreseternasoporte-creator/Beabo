// test-feed-pagination-cursor.js
// Regresión: la paginación del feed no debe saltar posts que comparten el
// milisegundo del límite de la página anterior (bug: endAt(ts - 1)).
// Usa las funciones REALES extraídas de index.html (snfCursorAdvance) y
// drex-cloud.js (applyQuery con endAtKey).
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const ROOT = __dirname + '/..';

// ---- extraer snfCursorAdvance de index.html ----
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
{
  const i = inline.indexOf('function snfCursorAdvance(ctx, ts, key) {');
  assert(i >= 0, 'snfCursorAdvance no encontrado en index.html');
  // extraer por balance de llaves
  let d = 0, j = inline.indexOf('{', i);
  for (; j < inline.length; j++) {
    if (inline[j] === '{') d++;
    else if (inline[j] === '}') { d--; if (!d) break; }
  }
  vm.runInThisContext(inline.slice(i, j + 1).replace(/^function snfCursorAdvance/, 'function snfCursorAdvance'));
}

// ---- extraer typeRank/compareVals/applyQuery de drex-cloud.js ----
const dc = fs.readFileSync(ROOT + '/drex-cloud.js', 'utf8');
{
  const i = dc.indexOf('function typeRank(v) {');
  assert(i >= 0, 'typeRank no encontrado');
  const endMark = 'function applyQuery';
  const ai = dc.indexOf(endMark, i);
  // fin de applyQuery: la primera línea que sea "  }" tras su inicio y que
  // cierre la función (balance de llaves desde su inicio)
  let d = 0, j = dc.indexOf('{', ai);
  for (; j < dc.length; j++) {
    if (dc[j] === '{') d++;
    else if (dc[j] === '}') { d--; if (!d) break; }
  }
  const chunk = dc.slice(i, j + 1);
  vm.runInThisContext(chunk);
}

// ============ 1. snfCursorAdvance: semántica del par (ts, key) ============
{
  const ctx = { oldestLoadedTs: Infinity, oldestLoadedKey: null };
  snfCursorAdvance(ctx, 100, 'k5');
  assert.deepStrictEqual([ctx.oldestLoadedTs, ctx.oldestLoadedKey], [100, 'k5']);
  snfCursorAdvance(ctx, 100, 'k3'); // mismo ts, clave menor -> avanza
  assert.deepStrictEqual([ctx.oldestLoadedTs, ctx.oldestLoadedKey], [100, 'k3']);
  snfCursorAdvance(ctx, 100, 'k9'); // mismo ts, clave mayor -> no avanza
  assert.deepStrictEqual([ctx.oldestLoadedTs, ctx.oldestLoadedKey], [100, 'k3']);
  snfCursorAdvance(ctx, 50, 'k1'); // ts menor -> avanza y resetea clave
  assert.deepStrictEqual([ctx.oldestLoadedTs, ctx.oldestLoadedKey], [50, 'k1']);
  snfCursorAdvance(ctx, 0, 'k2'); // ts inválido -> se ignora
  assert.deepStrictEqual([ctx.oldestLoadedTs, ctx.oldestLoadedKey], [50, 'k1']);
  snfCursorAdvance(ctx, 50, null); // sin clave no desempata
  assert.deepStrictEqual([ctx.oldestLoadedTs, ctx.oldestLoadedKey], [50, 'k1']);
  snfCursorAdvance(ctx, 200, 'k9'); // más nuevo -> no mueve el cursor
  assert.deepStrictEqual([ctx.oldestLoadedTs, ctx.oldestLoadedKey], [50, 'k1']);
  console.log('ok 1: snfCursorAdvance respeta el par (timestamp, key)');
}

// ============ 2. applyQuery: endAt(v, k) es estricto en (valor, clave) ============
{
  const obj = {
    k1: { timestamp: 5 }, k2: { timestamp: 10 }, k3: { timestamp: 10 },
    k4: { timestamp: 10 }, k5: { timestamp: 15 },
  };
  const r1 = applyQuery(obj, { orderBy: 'timestamp', endAt: 10, endAtKey: 'k3', limitLast: 10 });
  assert.deepStrictEqual(Object.keys(r1), ['k1', 'k2'], 'endAt(v,k) debe excluir k3 y k4, incluir k1,k2');
  const r2 = applyQuery(obj, { orderBy: 'timestamp', endAt: 10, limitLast: 10 });
  assert.deepStrictEqual(Object.keys(r2), ['k1', 'k2', 'k3', 'k4'], 'sin clave: camino viejo intacto');
  console.log('ok 2: applyQuery endAt(v,k) estricto; sin k el comportamiento no cambia');
}

// ============ 3. Paginación completa: 120 posts, 60 comparten el ms T ============
{
  const T = 1000000;
  const posts = [];
  for (let n = 0; n < 120; n++) {
    posts.push({ key: 'k' + String(n).padStart(3, '0'), timestamp: n < 60 ? T - (60 - n) : T });
  }
  const byKey = {};
  posts.forEach(p => { byKey[p.key] = { timestamp: p.timestamp }; });

  // Simula readLeavesBounded+applyQuery: candidatos con (ts,key) < cursor, ordenados, limitToLast(50)
  function page(cursorTs, cursorKey) {
    const spec = { orderBy: 'timestamp', limitLast: 50 };
    if (cursorTs !== undefined) { spec.endAt = cursorTs; if (cursorKey) spec.endAtKey = cursorKey; }
    const snap = applyQuery(byKey, spec);
    return Object.keys(snap).map(k => ({ key: k, timestamp: byKey[k].timestamp }));
  }

  // --- camino NUEVO: cursor compuesto ---
  const seen = new Set();
  let cTs, cKey, pages = 0, dupes = 0;
  for (;;) {
    const pg = page(cTs, cKey);
    if (!pg.length) break;
    pages++;
    const ctx = { oldestLoadedTs: cTs === undefined ? Infinity : cTs, oldestLoadedKey: cKey === undefined ? null : cKey };
    for (const p of pg) { if (seen.has(p.key)) dupes++; seen.add(p.key); snfCursorAdvance(ctx, p.timestamp, p.key); }
    if (pg.length < 50) break;
    if (ctx.oldestLoadedTs === cTs && ctx.oldestLoadedKey === cKey) break; // sin progreso
    cTs = ctx.oldestLoadedTs; cKey = ctx.oldestLoadedKey;
    assert(pages < 10, 'demasiadas páginas: posible bucle');
  }
  assert.strictEqual(seen.size, 120, `camino nuevo: se esperaban 120 posts únicos, se vieron ${seen.size}`);
  assert.strictEqual(dupes, 0, `camino nuevo: ${dupes} duplicados`);

  // --- camino VIEJO: endAt(ts - 1), para demostrar el bug que se corrige ---
  const seenOld = new Set();
  let oTs, oPages = 0;
  for (;;) {
    const spec = { orderBy: 'timestamp', limitLast: 50 };
    if (oTs !== undefined) spec.endAt = oTs - 1;
    const pg = Object.keys(applyQuery(byKey, spec)).map(k => ({ key: k, timestamp: byKey[k].timestamp }));
    if (!pg.length) break;
    oPages++;
    let m = Infinity;
    for (const p of pg) { seenOld.add(p.key); if (p.timestamp < m) m = p.timestamp; }
    if (pg.length < 50) break;
    if (m === oTs) break;
    oTs = m;
    assert(oPages < 10, 'bucle en camino viejo');
  }
  assert(oTs !== undefined);
  assert(seenOld.size < 120, 'el camino viejo debería perder posts (si no, el escenario no reproduce el bug)');
  console.log(`ok 3: camino nuevo recupera los 120 posts en ${pages} páginas sin duplicados; ` +
    `camino viejo pierde ${120 - seenOld.size} (bug reproducido y corregido)`);
}

// ============ 4. Ref.endAt(v, k) guarda endAtKey (patrón en fuente) ============
{
  const i = dc.indexOf('Ref.prototype.endAt = function (v, k)');
  assert(i >= 0, 'Ref.prototype.endAt debe aceptar (v, k)');
  const frag = dc.slice(i, i + 600);
  assert(frag.includes('endAtKey'), 'endAt debe propagar endAtKey al query');
  assert(frag.includes("delete q.endAtKey"), 'sin clave debe limpiar endAtKey (inmutabilidad)');
  const j = dc.indexOf('return readLeavesBounded(pk, query.limitLast, query.endAt, query.endAtKey);');
  assert(j >= 0, 'el dispatch debe pasar query.endAtKey a readLeavesBounded');
  const k = dc.indexOf("function readLeavesBounded(pk, limitN, endAt, endAtKey)");
  assert(k >= 0, 'readLeavesBounded debe recibir endAtKey');
  console.log('ok 4: Ref.endAt(v,k) -> query.endAtKey -> readLeavesBounded cableado en fuente');
}

console.log('\ntest-feed-pagination-cursor: TODO VERDE');
