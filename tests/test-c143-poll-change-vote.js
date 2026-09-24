/* ================================================================
 * C143 — Votaciones: CAMBIO DE VOTO (función nueva construida).
 *
 * HALLAZGO (hueco real, re-verificado contra el código): la transacción de
 * voteInPoll abortaba si el usuario ya había votado
 * (`if (poll.voters[user.uid] !== undefined) return;`) y el renderer, tras
 * votar, pintaba las opciones como <div> estáticos. Un voto por error era
 * IRREVERSIBLE: ni siquiera la votación del guion de Series (note.poll.q)
 * permitía corregirlo.
 *
 * CAMBIO (index.html):
 *  - pollApplyVote(poll, uid, optIdx, nowMs): updater PURO de la
 *    transacción. Primer voto: suma opción + total + voters[uid]. Cambio:
 *    resta la opción anterior (Math.max(0,...)) y suma la nueva SIN tocar
 *    el total. No-op (undefined): mismo voto, encuesta cerrada, poll null
 *    u opción inválida.
 *  - renderPostPollHTML: si el usuario ya votó y la encuesta sigue abierta,
 *    las opciones se renderizan como <button> (onclick voteInPoll) con la
 *    marca 'mine' y un hint en el meta ("Toca otra opción para cambiar tu
 *    voto"). Cerrada o sin votar: comportamiento intacto (divs / botones).
 *  - voteInPoll: delega la transacción en pollApplyVote; si el DOM ya
 *    marcaba 'mine' (hadVoted), muestra toast "Voto actualizado" al
 *    confirmar el cambio.
 *  - i18n: bloque de merge C143 con las 2 claves nuevas en ES/EN/ZH/PT.
 *  - CSS: button.drex-poll-opt.voted con cursor:pointer + hover índigo.
 *
 * MICRO-FIX de la auditoría secundaria (Permissions API, ver
 * test-c143-permissions-api.js): openNotifications pedía
 * Notification.requestPermission() cada vez que permission !== 'granted',
 * incluido el estado 'denied' (no-op por spec). Ahora solo lo pide en
 * 'default'.
 *
 * Ejecutar con: node tests/test-c143-poll-change-vote.js
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const baseHtml = cp.execSync('git show HEAD:index.html', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');

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
function count(re, src) { return (src.match(re) || []).length; }

// ---------- Extractor (misma técnica que los harnesses del ciclo) ----------
function extractFn(source, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(source);
  if (!m) throw new Error('no se encontró ' + name);
  const start = m.index;
  let i = source.indexOf('(', m.index), j, pdepth = 0, depth = 0, inStr = null, esc = false;
  for (j = i; j < source.length; j++) {
    const c = source[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(') pdepth++; else if (c === ')') { pdepth--; if (pdepth === 0) break; }
  }
  const bodyStart = source.indexOf('{', j);
  inStr = null; esc = false;
  for (j = bodyStart; j < source.length; j++) {
    const c = source[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(start, j + 1);
}

// ---------- Sandbox para pollApplyVote (puro, sin mocks) ----------
function pollBox() {
  const code = extractFn(html, 'pollApplyVote');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}
function runApply(sandbox, poll, uid, optIdx, nowMs) {
  // nowMs siempre literal numérico; optIdx puede ser NaN (literal).
  const uidLit = JSON.stringify(uid);
  const pollLit = JSON.stringify(poll);
  const optLit = (typeof optIdx === 'number' && isNaN(optIdx)) ? 'NaN' : JSON.stringify(optIdx);
  vm.runInContext('this.__p = ' + pollLit + ';', sandbox);
  const r = vm.runInContext('(function(){ var out = pollApplyVote(this.__p, ' + uidLit + ', ' + optLit + ', ' + nowMs + '); return { out: out === undefined ? null : out, mutated: this.__p }; })();', sandbox);
  return { out: r.out, mutated: r.mutated };
}
function mkPoll(over) {
  const p = { options: [{ t: 'A', v: 5 }, { t: 'B', v: 3 }, { t: 'C', v: 0 }], total: 8, voters: {}, endsAt: Date.now() + 3600000 };
  return Object.assign(p, over || {});
}

// ---------- Parte A: pollApplyVote ----------
tcase('A1 primer voto: suma opción, total+1, voters[uid]=idx', () => {
  const sb = pollBox();
  const r = runApply(sb, mkPoll(), 'u1', 1, Date.now());
  return r.out !== null && r.mutated.options[1].v === 4 && r.mutated.total === 9
    && r.mutated.voters.u1 === 1 && r.mutated.options[0].v === 5;
});
tcase('A2 cambio de voto: resta anterior, suma nueva, total igual', () => {
  const sb = pollBox();
  const r = runApply(sb, mkPoll({ voters: { u1: 0 } }), 'u1', 2, Date.now());
  return r.out !== null && r.mutated.options[0].v === 4 && r.mutated.options[2].v === 1
    && r.mutated.total === 8 && r.mutated.voters.u1 === 2;
});
tcase('A3 mismo voto: no-op (undefined, sin mutar)', () => {
  const sb = pollBox();
  const before = mkPoll({ voters: { u1: 1 } });
  const r = runApply(sb, before, 'u1', 1, Date.now());
  return r.out === null && r.mutated.options[1].v === 3 && r.mutated.total === 8;
});
tcase('A4 encuesta cerrada: no-op aunque cambie de opción', () => {
  const sb = pollBox();
  const r = runApply(sb, mkPoll({ endsAt: Date.now() - 1000, voters: { u1: 0 } }), 'u1', 1, Date.now());
  return r.out === null && r.mutated.options[0].v === 5 && r.mutated.options[1].v === 3
    && r.mutated.total === 8 && r.mutated.voters.u1 === 0;
});
tcase('A5 poll null: no-op', () => {
  const sb = pollBox();
  const sandbox = sb;
  vm.runInContext('this.__n = pollApplyVote(null, "u1", 0, Date.now());', sandbox);
  return sandbox.__n === undefined;
});
tcase('A6 opción inexistente (idx fuera de rango / NaN): no-op', () => {
  const sb = pollBox();
  const r1 = runApply(sb, mkPoll(), 'u1', 9, Date.now());
  const r2 = runApply(sb, mkPoll(), 'u1', NaN, Date.now());
  return r1.out === null && r1.mutated.total === 8 && r2.out === null && r2.mutated.total === 8;
});
tcase('A7 prev corrupto (no-número): suma sin decrementar, total igual (ya contaba)', () => {
  const sb = pollBox();
  const r = runApply(sb, mkPoll({ voters: { u1: 'x' } }), 'u1', 1, Date.now());
  return r.out !== null && r.mutated.options[1].v === 4 && r.mutated.total === 8
    && r.mutated.voters.u1 === 1;
});
tcase('A8 prev fuera de rango: suma sin decrementar, total igual', () => {
  const sb = pollBox();
  const r = runApply(sb, mkPoll({ voters: { u1: 7 } }), 'u1', 0, Date.now());
  return r.out !== null && r.mutated.options[0].v === 6 && r.mutated.total === 8
    && r.mutated.voters.u1 === 0;
});
tcase('A9 cambio no deja negativos (opción anterior con v=0)', () => {
  const sb = pollBox();
  const r = runApply(sb, mkPoll({ voters: { u1: 2 } }), 'u1', 0, Date.now());
  return r.out !== null && r.mutated.options[2].v === 0 && r.mutated.options[0].v === 6
    && r.mutated.total === 8;
});
tcase('A10 otros votantes intactos tras el cambio', () => {
  const sb = pollBox();
  const r = runApply(sb, mkPoll({ voters: { u1: 0, u2: 1 } }), 'u1', 1, Date.now());
  return r.mutated.voters.u2 === 1 && r.mutated.options[1].v === 4 && r.mutated.total === 8;
});
tcase('A11 falla en base: pollApplyVote no existe en HEAD:index.html', () => {
  return baseHtml.indexOf('function pollApplyVote(') === -1
    && baseHtml.indexOf('pollApplyVote(poll, user.uid') === -1;
});

// ---------- Parte B: renderPostPollHTML (con mocks) ----------
function renderBox(uid) {
  const sandbox = {};
  vm.createContext(sandbox);
  const mocks = [
    'var DrexCloud = { auth: function(){ return { currentUser: ' + (uid ? '{ uid: ' + JSON.stringify(uid) + ' }' : 'null') + ' }; } };',
    'var DREX_POLL_CHECK_SVG = \'<svg class="chk"></svg>\';',
    'var CSS = { escape: function(s){ return String(s); } };',
    'function appT(s){ return s; }',
    'function escapeHtml(s){ return String(s).replace(/[&<>"\']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c]; }); }',
    'function escapeInlineSingleQuote(s){ return String(s).replace(/\\\\/g, "\\\\\\\\").replace(/\'/g, "\\\\\'"); }'
  ].join('\n');
  vm.runInContext(mocks, sandbox);
  vm.runInContext(extractFn(html, 'pollTimeLeftText'), sandbox);
  vm.runInContext(extractFn(html, 'renderPostPollHTML'), sandbox);
  return sandbox;
}
function renderPoll(uid, pollObj) {
  const sb = renderBox(uid);
  vm.runInContext('this.__n = ' + JSON.stringify(pollObj) + ';', sb);
  return vm.runInContext('renderPostPollHTML({ id: "n1", poll: this.__n }, false)', sb);
}
function votedPoll(over) {
  const p = mkPoll({ voters: { u1: 1 } });
  return Object.assign(p, over || {});
}
tcase('B1 votado+abierta: opciones son <button> con onclick voteInPoll + hint de cambio', () => {
  const out = renderPoll('u1', votedPoll());
  const btns = count(/<button[^>]*class="drex-poll-opt voted/g, out);
  const divs = count(/<div class="drex-poll-opt voted/g, out);
  return btns === 3 && divs === 0
    && out.indexOf('voteInPoll(') !== -1
    && out.indexOf('Toca otra opción para cambiar tu voto') !== -1
    && out.indexOf('mine') !== -1;
});
tcase('B2 votado+cerrada: opciones son <div> (sin onclick), sin hint', () => {
  const out = renderPoll('u1', votedPoll({ endsAt: Date.now() - 1000 }));
  const btns = count(/<button[^>]*drex-poll-opt/g, out);
  const divs = count(/<div class="drex-poll-opt voted/g, out);
  return btns === 0 && divs === 3
    && out.indexOf('voteInPoll(') === -1
    && out.indexOf('Toca otra opción para cambiar tu voto') === -1
    && out.indexOf('Votación cerrada') !== -1;
});
tcase('B3 no votado+abierta: botones sin .voted ni hint (comportamiento intacto)', () => {
  const out = renderPoll('u1', mkPoll());
  const voted = count(/drex-poll-opt voted/g, out);
  const btns = count(/<button[^>]*class="drex-poll-opt"/g, out);
  return voted === 0 && btns === 3
    && out.indexOf('Toca otra opción para cambiar tu voto') === -1;
});
tcase('B4 no votado+cerrada: divs votados sin mine', () => {
  const out = renderPoll('u1', mkPoll({ endsAt: Date.now() - 1000 }));
  return count(/<div class="drex-poll-opt voted/g, out) === 3
    && out.indexOf('mine') === -1;
});
tcase('B5 la opción votada conserva la marca mine y el check', () => {
  const out = renderPoll('u1', votedPoll());
  const mineBtns = count(/<button[^>]*class="drex-poll-opt voted mine"/g, out);
  return mineBtns === 1 && out.indexOf('<svg class="chk"></svg>') !== -1;
});
tcase('B6 pregunta q de Series intacta (test-c82 no se rompe)', () => {
  const sb = renderBox('u1');
  const srcFn = extractFn(html, 'renderPostPollHTML');
  const out = renderPoll('u1', votedPoll({ q: '¿Qué pasa en el próximo capítulo?' }));
  return srcFn.indexOf('poll.q') !== -1 && out.indexOf('¿Qué pasa en el próximo capítulo?') !== -1;
});

// ---------- Parte C: integración estática + i18n ----------
tcase('C1 voteInPoll delega la transacción en pollApplyVote', () => {
  const fn = extractFn(html, 'voteInPoll');
  return fn.indexOf('return pollApplyVote(poll, user.uid, optIdx, Date.now());') !== -1
    && fn.indexOf('poll.voters[user.uid] !== undefined') === -1;
});
tcase('C2 toast "Voto actualizado" solo cuando ya había votado (hadVoted)', () => {
  const fn = extractFn(html, 'voteInPoll');
  return fn.indexOf("if (hadVoted) showMiniToast(appT('Voto actualizado'))") !== -1
    && fn.indexOf("document.querySelector(sel + ' .drex-poll-opt.mine')") !== -1;
});
tcase('C3 CSS: button.drex-poll-opt.voted con cursor + hover (sin Tailwind arbitrary)', () => {
  return html.indexOf('button.drex-poll-opt.voted { cursor: pointer; }') !== -1
    && html.indexOf('button.drex-poll-opt.voted:hover { border-color: #2F33B8; }') !== -1;
});
tcase('C4 i18n C143: las 2 claves en ES/EN/ZH/PT del bloque de merge', () => {
  return html.indexOf("'Toca otra opción para cambiar tu voto': 'Tap another option to change your vote'") !== -1
    && html.indexOf("'Toca otra opción para cambiar tu voto': '点击其他选项可更改你的投票'") !== -1
    && html.indexOf("'Toca otra opción para cambiar tu voto': 'Toque em outra opção para mudar seu voto'") !== -1
    && html.indexOf("'Voto actualizado': 'Vote updated'") !== -1
    && html.indexOf("'Voto actualizado': '投票已更新'") !== -1
    && html.indexOf("'Voto actualizado': 'Voto atualizado'") !== -1;
});
tcase('C5 onclick de cambio usa el mismo safeId escapado (sin fuga de comilla)', () => {
  const out = renderPoll('u1', votedPoll());
  return !/[^\\]'\)\s*;/.test(out);
});
tcase('C6 el renderer sigue exportando poll.q y 404.html == index.html en esta familia', () => {
  const copy = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');
  return copy.indexOf('function pollApplyVote(') !== -1;
});

console.log('');
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
