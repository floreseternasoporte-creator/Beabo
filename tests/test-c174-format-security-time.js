#!/usr/bin/env node
/*
 * test-c174-format-security-time — C174: formatSecurityTime faltaba en el bundle.
 * Hallazgo: renderSecuritySessions, renderSecurityEvents, renderLoginHistory y
 * renderDrexKnownDevices llaman a formatSecurityTime(ts) con datos reales, pero la
 * función nunca se definió (4 llamadas, 0 definiciones en origin/main 013d7ee) →
 * ReferenceError y el Centro de Seguridad quedaba sin sesiones activas, actividad
 * reciente ni historial de accesos (openSecurityCenter solo muestra un toast genérico).
 * Parche: define formatSecurityTime (tiempo relativo ES/EN/ZH, patrón formatRelativeTime)
 * justo antes de renderSecuritySessions.
 *
 * Uso: node tests/test-c174-format-security-time.js [archivo-base]
 *   Sin args: corre contra index.html del árbol (convención DREX_HTML).
 *   Con arg: corre contra ese archivo como "base" (falla-en-base: exit 1 porque la
 *   función no existe en la base).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TREE_FILE = path.join(__dirname, '..', 'index.html');
const SRC_FILE = process.argv[2] || TREE_FILE;
const SRC = fs.readFileSync(SRC_FILE, 'utf8');
const IS_BASE = !!process.argv[2];

// ---- extractor verbatim con tokenizer (strings, comentarios, templates, regex) ----
function blockEnd(src, openIdx) {
  const stack = [];
  let i = openIdx, depth = 0, prevSig = '{', ctx = '';
  const isRe = () => /[=(:,[!&|?{};+\-*~^<>]/.test(prevSig) || prevSig === '' ||
    /(^|\W)(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else)$/.test(' ' + ctx);
  while (i < src.length) {
    const c = src[i], top = stack.length ? stack[stack.length - 1] : null;
    if (top && top.t === 'str') { if (c === '\\') { i += 2; continue; } if (c === top.q) stack.pop(); i++; continue; }
    if (top && top.t === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); i++; prevSig = '`'; ctx += '`'; continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push({ t: 'code', depth: 0 }); i += 2; prevSig = '{'; ctx += '${'; continue; }
      i++; continue;
    }
    if (top && top.t === 're') {
      if (c === '\\') { i += 2; continue; }
      if (c === '[') { top.cls = true; i++; continue; }
      if (c === ']' && top.cls) { top.cls = false; i++; continue; }
      if (c === '/' && !top.cls) { stack.pop(); i++; while (i < src.length && /[a-z]/i.test(src[i])) i++; prevSig = 'x'; ctx += 're'; continue; }
      i++; continue;
    }
    if (c === '"' || c === "'") { stack.push({ t: 'str', q: c }); i++; prevSig = c; ctx += c; continue; }
    if (c === '`') { stack.push({ t: 'tpl' }); i++; prevSig = c; ctx += c; continue; }
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n === -1 ? src.length : n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n === -1 ? src.length : n + 2; continue; }
    if (c === '/') { if (isRe()) { stack.push({ t: 're', cls: false }); i++; continue; } i++; prevSig = '/'; ctx += '/'; continue; }
    if (c === '{') { if (top && top.t === 'code') top.depth++; else depth++; i++; prevSig = '{'; ctx += '{'; continue; }
    if (c === '}') {
      if (top && top.t === 'code') { top.depth--; if (top.depth < 0) { stack.pop(); i++; prevSig = '}'; ctx += '}'; continue; } }
      else { depth--; if (depth === 0 && !stack.length) return i + 1; if (depth < 0) throw new Error('brace negativo'); }
      i++; prevSig = '}'; ctx += '}'; continue;
    }
    if (!/\s/.test(c)) { prevSig = c; ctx = (ctx + c).slice(-12); }
    i++;
  }
  throw new Error('sin cierre');
}
function extractFn(name) {
  const pats = ['function ' + name + '(', 'window.' + name + ' = function', 'const ' + name + ' = function'];
  let idx = -1;
  for (const p of pats) { const j = SRC.indexOf(p); if (j !== -1 && (idx === -1 || j < idx)) idx = j; }
  if (idx === -1) throw new Error('no encontrada en ' + SRC_FILE + ': ' + name);
  let p = SRC.indexOf('(', idx), depth = 0, inS = null, esc = false;
  let bodyOpen = -1;
  for (let i = p; i < SRC.length && bodyOpen === -1; i++) {
    const c = SRC[i];
    if (inS) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inS) inS = null; continue; }
    if (c === '"' || c === "'") { inS = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { bodyOpen = SRC.indexOf('{', i); break; } }
  }
  if (bodyOpen === -1) throw new Error('sin cuerpo: ' + name);
  return SRC.slice(idx, blockEnd(SRC, bodyOpen));
}

// ---- la función debe EXISTIR (en la base no existe → falla-en-base) ----
const fnSrc = extractFn('formatSecurityTime');

// ---- harness: appT identidad, idioma configurable ----
let LANG = 'es';
const appT = s => s;
const getAppLanguage = () => LANG;
const factory = new Function('appT', 'getAppLanguage', 'Date', fnSrc + '\nreturn formatSecurityTime;');
const formatSecurityTime = factory(appT, getAppLanguage, Date);

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('FAIL: ' + name); } };

const NOW = Date.now();
const ago = ms => NOW - ms;

// falsy / inválidos → 'Fecha desconocida'
ok(formatSecurityTime(0) === 'Fecha desconocida', 'ts=0');
ok(formatSecurityTime(undefined) === 'Fecha desconocida', 'ts=undefined');
ok(formatSecurityTime(null) === 'Fecha desconocida', 'ts=null');
ok(formatSecurityTime(NaN) === 'Fecha desconocida', 'ts=NaN');
ok(formatSecurityTime('abc') === 'Fecha desconocida', 'ts=abc');
// español
LANG = 'es';
ok(formatSecurityTime(NOW) === 'hace un momento', 'es: ahora');
ok(formatSecurityTime(NOW + 60000) === 'hace un momento', 'es: futuro se clampéa');
ok(formatSecurityTime(ago(5 * 60000)) === 'hace 5 min', 'es: 5 min');
ok(formatSecurityTime(ago(59 * 60000)) === 'hace 59 min', 'es: 59 min');
ok(formatSecurityTime(ago(3 * 3600000)) === 'hace 3 h', 'es: 3 h');
ok(formatSecurityTime(ago(23 * 3600000)) === 'hace 23 h', 'es: 23 h');
ok(formatSecurityTime(ago(86400000)) === 'hace 1 día', 'es: 1 día');
ok(formatSecurityTime(ago(2 * 86400000)) === 'hace 2 días', 'es: 2 días');
ok(formatSecurityTime(ago(29 * 86400000)) === 'hace 29 días', 'es: 29 días');
ok(formatSecurityTime(String(ago(5 * 60000))) === 'hace 5 min', 'es: string numérico');
const oldEs = formatSecurityTime(ago(60 * 86400000));
ok(typeof oldEs === 'string' && oldEs.length > 0, 'es: fecha vieja → locale date');
// inglés
LANG = 'en';
ok(formatSecurityTime(NOW) === 'just now', 'en: ahora');
ok(formatSecurityTime(ago(5 * 60000)) === '5 min ago', 'en: 5 min');
ok(formatSecurityTime(ago(3 * 3600000)) === '3 h ago', 'en: 3 h');
ok(formatSecurityTime(ago(86400000)) === '1 day ago', 'en: 1 day');
ok(formatSecurityTime(ago(2 * 86400000)) === '2 days ago', 'en: 2 days');
// chino
LANG = 'zh';
ok(formatSecurityTime(NOW) === '刚刚', 'zh: ahora');
ok(formatSecurityTime(ago(5 * 60000)) === '5 分钟前', 'zh: 5 min');
ok(formatSecurityTime(ago(3 * 3600000)) === '3 小时前', 'zh: 3 h');
ok(formatSecurityTime(ago(2 * 86400000)) === '2 天前', 'zh: 2 días');

// ---- integración: el render que antes lanzaba ahora pinta ----
LANG = 'es';
const renderSrc = extractFn('renderSecuritySessions');
const escSrc = extractFn('escapeHtml');
// escapeHtml del bundle llama a escapeHTML: stub fiel (misma cadena de reemplazos)
const escapeHTML = t => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const escapeHtml = new Function('escapeHTML', escSrc + '\nreturn escapeHtml;')(escapeHTML);
let painted = '';
const document = { getElementById: id => id === 'security-sessions-list' ? { set innerHTML(v) { painted = v; }, get innerHTML() { return painted; } } : null };
const DrexCloud = { getActiveDrexSessionId: () => 'sess-current' };
let threw = null;
try {
  new Function('document', 'DrexCloud', 'escapeHtml', 'appT', 'formatSecurityTime',
    renderSrc + '\nrenderSecuritySessions({ "sess-other": { deviceLabel: "iPhone", form: "mobile", lastActivity: ' + ago(60000) + ' } });'
  )(document, DrexCloud, escapeHtml, appT, formatSecurityTime);
} catch (e) { threw = e; }
ok(threw === null, 'renderSecuritySessions con datos ya no lanza (antes: ReferenceError)');
ok(painted.includes('iPhone'), 'renderSecuritySessions pinta la etiqueta');

console.log((fail === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + pass + '/' + (pass + fail) + (IS_BASE ? ' [base]' : ''));
process.exit(fail ? 1 : 0);
