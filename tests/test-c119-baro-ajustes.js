#!/usr/bin/env node
/* test-c119-baro-ajustes.js — Carril 8J (oleada 3 v4): ajustes personales via Baro.
   Estilo test-c110-baro-social.js: marcador + --target, carga del bloque con vm,
   extractores puros en 4 idiomas, i18n completo, iconos índigo, anclas reales con
   guardas, cero escrituras sin sesión y sin literal de cierre de script.
   NO toca ~/workspace/beabo: corre contra una copia (--target) con el bloque ya insertado. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SNIPPET_PATH = path.join(__dirname, "8J-snippet.js");
const DEFAULT_TARGET = "/tmp/baro8J-test.html";
const MARK = "/* ================= BARO · sub-bloque 8J";
const HEADER = "/* ================= BARO · sub-bloque 8J — OLEADA 3 v4 (ajustes) ================= */";

const PLAN = [
  "T1  marcador 8J presente en el target y bloque extraíble (IIFE cerrada)",
  "T2  cabecera del sub-bloque exacta en la primera línea",
  "T3  i18n: 48 claves baro.tool.ajuste.* completas en ES/EN/ZH/PT, sin emoji",
  "T4  4 iconos SVG propios índigo (#2F33B8 + currentColor), sin emoji, sin sobrescribir",
  "T5  guardas typeof en todas las anclas reales (setAppLanguage/selectThemeOption/toggleAccountPrivacy/toggleChatPrivacySetting/toggleNotifSetting)",
  "T6  cero escrituras directas a la BD (sin .set/.update en el bloque)",
  "T7  4 tools registradas con label/icon/stepKey/run (async)",
  "T8  4 intents ES/EN/ZH/PT con extractores que matchean frases reales",
  "T9  extractores puros: idioma/tema/privacidad/notificaciones en 4 idiomas + vacío",
  "T10 ajuste_idioma: panel, cambio real, ya-activo, sin sesión, ancla ausente",
  "T11 ajuste_tema: panel, cambio real, 'sistema' honesto, sin sesión, ancla ausente",
  "T12 ajuste_privacidad: panel 3 toggles, toggles reales, no-op, sin sesión, ancla ausente, sin BD",
  "T13 ajuste_notificaciones: panel 10 categorías, toggle real, no-op, categoría desconocida, sin sesión",
  "T14 cero escrituras y cero llamadas a anclas sin sesión en los 4 tools",
  "T15 exports para pruebas + marcador global __baro8j + baroJPick expuesto",
  "T16 pasos en vivo: step/stepDone se invocan con el texto del idioma actual",
  "T17 baroIntentToTool mapea los 4 intents a sus tools",
  "T18 el snippet no contiene el literal de cierre de script",
];

function usage() {
  console.log("Uso: node test-c119-baro-ajustes.js [--target <html>] [--show] [--list] [--help]");
  console.log("  --target  copia HTML con el bloque 8J insertado (defecto: " + DEFAULT_TARGET + ")");
  console.log("  --show    imprime las primeras 60 líneas del bloque extraído");
  console.log("  --list    imprime el plan de pruebas");
}
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) { usage(); process.exit(0); }
if (argv.includes("--list")) { PLAN.forEach((p) => console.log(p)); process.exit(0); }
let target = DEFAULT_TARGET;
const ti = argv.indexOf("--target");
if (ti !== -1 && argv[ti + 1]) target = argv[ti + 1];
else if (!fs.existsSync(target)) target = path.join(__dirname, "..", "index.html"); // CI: el integrado
const SHOW = argv.includes("--show");

function readTarget(p) {
  if (!fs.existsSync(p)) { console.error("FALLO: no existe el target: " + p); process.exit(2); }
  return fs.readFileSync(p, "utf8");
}
/* Igual que c110: extrae desde el marcador hasta el siguiente sub-bloque o </script>. */
function extractBlock(html) {
  const start = html.indexOf(MARK);
  if (start === -1) return null;
  const nextBlock = html.indexOf("/* ================= BARO · sub-bloque 8", start + MARK.length);
  const closeScript = html.indexOf("</scr" + "ipt>", start);
  let end = html.length;
  if (nextBlock !== -1) end = Math.min(end, nextBlock);
  if (closeScript !== -1) end = Math.min(end, closeScript);
  return html.slice(start, end);
}

/* ---------- harness ---------- */
let pass = 0, fail = 0;
const failures = [];
function ok(name) { pass++; }
function no(name, why) { fail++; failures.push(name + " :: " + why); console.error("FALLO " + name + " :: " + why); }
function eq(name, a, b) { if (a === b) ok(name); else no(name, "esperaba " + JSON.stringify(b) + ", obtuvo " + JSON.stringify(a)); }
function eqJ(name, a, b) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x === y) ok(name); else no(name, "esperaba " + y + ", obtuvo " + x);
}
function has(name, s, sub) { if (String(s).indexOf(sub) !== -1) ok(name); else no(name, "no contiene: " + sub); }
function hasNo(name, s, sub) { if (String(s).indexOf(sub) === -1) ok(name); else no(name, "NO debería contener: " + sub); }
async function runCase(name, fn) { try { await fn(); } catch (e) { no(name, "excepción: " + (e && e.message)); } }

const html = readTarget(target);
const block = extractBlock(html);
let snippetSrc;
try { snippetSrc = fs.readFileSync(SNIPPET_PATH, "utf8"); }
catch (_) { snippetSrc = block; } // integrado: el bloque extraído de index.html es la fuente

/* sandbox con las anclas reales simuladas */
function makeStore() {
  return { users: { u1: { isPrivate: false } }, userSettings: { u1: { chatPrivacy: { saveDrafts: true, readReceipts: true }, notifications: { likes: true } } } };
}
let store = makeStore();
let anchorCalls;
function resetAnchors() { anchorCalls = { lang: 0, theme: 0, priv: 0, chat: 0, notif: 0 }; }
resetAnchors();
let currentLanguage = "es", fakeTheme = "light";
function makeDb(st) {
  function nodeAt(p, create) {
    const parts = String(p).split("/").filter(Boolean);
    let o = st;
    for (const k of parts) { if (!(k in o)) { if (!create) return undefined; o[k] = {}; } o = o[k]; }
    return o;
  }
  return { ref: (p) => ({ once: () => Promise.resolve({ val: () => { const v = nodeAt(p, false); return v === undefined ? null : JSON.parse(JSON.stringify(v)); } }) }) };
}
const regTools = {};
const sandbox = {};
sandbox.window = sandbox; sandbox.self = sandbox;
sandbox.baroRegisterTool = (name, def) => { regTools[name] = def; };
sandbox.baroIntentRules = [];
sandbox.baroIntentToTool = {};
sandbox.BARO_ICONS = { "ajuste-idioma": "PREEXISTENTE" };
sandbox.APP_ENGLISH_TEXT = { "baro.tool.ajuste.need_login": "PREEXISTENTE" };
sandbox.APP_CHINESE_TEXT = {};
sandbox.APP_PORTUGUESE_TEXT = {};
sandbox.DrexCloud = { database: () => makeDb(store) };
sandbox.getAppLanguage = () => currentLanguage;
sandbox.setAppLanguage = (l) => { anchorCalls.lang++; currentLanguage = l; };
sandbox.getSavedThemePreference = () => fakeTheme;
sandbox.selectThemeOption = (t) => { anchorCalls.theme++; fakeTheme = (t === "dark" ? "dark" : "light"); };
sandbox.toggleAccountPrivacy = async (cb) => { anchorCalls.priv++; store.users.u1.isPrivate = !!(cb && cb.checked); };
sandbox.toggleChatPrivacySetting = (key) => { anchorCalls.chat++; const c = store.userSettings.u1.chatPrivacy; c[key] = !c[key]; };
sandbox.toggleNotifSetting = (key) => { anchorCalls.notif++; const n = store.userSettings.u1.notifications; n[key] = !(n[key] !== false); };
const moduleObj = { exports: {} };
sandbox.module = moduleObj;

function escDefault(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function makeCtx(user, stepLog) {
  return {
    user: user || null,
    t: (k) => k,
    esc: escDefault,
    step: (label) => { const id = "s" + stepLog.length; stepLog.push(["step", label, id]); return id; },
    stepDone: (id) => { stepLog.push(["stepDone", id]); },
  };
}
const USER = { uid: "u1" };

vm.createContext(sandbox);
vm.runInContext(block, sandbox, { filename: "8J-block" });
const EXP = moduleObj.exports;

(async () => {
  /* T1 */
  await runCase("T1", async () => {
    eq("T1-marcador-en-target", html.indexOf(MARK) !== -1, true);
    eq("T1-bloque-extraible", !!block && block.length > 1000, true);
    eq("T1-cierra-IIFE", block.trimEnd().endsWith("})();"), true);
  });

  /* T2 */
  await runCase("T2", async () => {
    eq("T2-cabecera-exacta", block.split("\n")[0].trim(), HEADER);
  });

  /* T3 */
  await runCase("T3", async () => {
    const I = EXP.BARO_I18N_J;
    eq("T3-total-claves", Object.keys(I).length, 48);
    const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
    for (const k of Object.keys(I)) {
      if (!k.startsWith("baro.tool.ajuste.")) { no("T3-prefijo", k); break; }
      for (const l of ["es", "en", "zh", "pt"]) {
        const v = I[k][l];
        if (typeof v !== "string" || !v.trim()) { no("T3-completo", k + "/" + l); break; }
        if (emojiRe.test(v)) { no("T3-sin-emoji", k + "/" + l); break; }
      }
    }
    ok("T3-claves-48x4");
    has("T3-need_login-es", I["baro.tool.ajuste.need_login"].es, "Inicia sesión");
    has("T3-sin-sistema-zh", I["baro.tool.ajuste.tema.sin_sistema"].zh, "浅色");
  });

  /* T4 */
  await runCase("T4", async () => {
    const IC = EXP.BARO_ICONS_J;
    eqJ("T4-nombres", Object.keys(IC).sort(), ["ajuste-idioma", "ajuste-notificaciones", "ajuste-privacidad", "ajuste-tema"].sort());
    const seen = new Set(), emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    for (const k of Object.keys(IC)) {
      const s = IC[k];
      has("T4-svg-" + k, s, "<svg");
      has("T4-currentColor-" + k, s, 'stroke="currentColor"');
      has("T4-indigo-" + k, s, "#2F33B8");
      hasNo("T4-emoji-" + k, emojiRe.test(s) ? "EMOJI" : "ok", "EMOJI");
      if (seen.has(s)) no("T4-distintos", k); else { seen.add(s); ok("T4-distinto-" + k); }
    }
    eq("T4-no-sobrescribe-BARO_ICONS", sandbox.BARO_ICONS["ajuste-idioma"], "PREEXISTENTE");
    has("T4-fusiona-resto", sandbox.BARO_ICONS["ajuste-tema"] || "", "<svg");
  });

  /* T5 */
  await runCase("T5", async () => {
    for (const f of ["setAppLanguage", "selectThemeOption", "toggleAccountPrivacy", "toggleChatPrivacySetting", "toggleNotifSetting", "getAppLanguage", "baroRegisterTool", "BARO_ICONS", "getSavedThemePreference"]) {
      has("T5-guarda-" + f, snippetSrc, "typeof " + f);
    }
  });

  /* T6 */
  await runCase("T6", async () => {
    hasNo("T6-sin-set", snippetSrc, ".set(");
    hasNo("T6-sin-update", snippetSrc, ".update(");
    hasNo("T6-sin-remove", snippetSrc, ".remove(");
    hasNo("T6-sin-transaction", snippetSrc, ".transaction(");
  });

  /* T7 */
  await runCase("T7", async () => {
    eqJ("T7-4-tools", Object.keys(regTools).sort(), ["ajuste_idioma", "ajuste_notificaciones", "ajuste_privacidad", "ajuste_tema"].sort());
    const iconFor = { ajuste_idioma: "ajuste-idioma", ajuste_tema: "ajuste-tema", ajuste_privacidad: "ajuste-privacidad", ajuste_notificaciones: "ajuste-notificaciones" };
    for (const n of Object.keys(regTools)) {
      const d = regTools[n];
      eq("T7-run-async-" + n, d.run.constructor.name, "AsyncFunction");
      eq("T7-icon-" + n, d.icon, iconFor[n]);
      if (typeof d.label !== "string" || typeof d.stepKey !== "string") no("T7-label-stepKey-" + n, "faltan"); else ok("T7-label-stepKey-" + n);
      if (!d.label.startsWith("baro.tool.ajuste.")) no("T7-label-prefijo-" + n, d.label); else ok("T7-label-prefijo-" + n);
    }
  });

  /* T8 */
  await runCase("T8", async () => {
    const R = EXP.BARO_J_RULES;
    eq("T8-4-reglas", R.length, 4);
    const cases = [
      ["cambia el idioma a inglés", 0, { idioma: "en" }],
      ["change the app language to Chinese", 0, { idioma: "zh" }],
      ["切换语言到中文", 0, { idioma: "zh" }],
      ["mudar o idioma para português", 0, { idioma: "pt" }],
      ["pon el modo oscuro", 1, { tema: "oscuro" }],
      ["switch to dark mode", 1, { tema: "oscuro" }],
      ["切换到深色主题", 1, { tema: "oscuro" }],
      ["mudar para o tema claro", 1, { tema: "claro" }],
      ["usa el modo del sistema", 1, { tema: "sistema" }],
      ["haz mi cuenta privada", 2, { toggle: "privada", valor: true }],
      ["desactiva las confirmaciones de lectura", 2, { toggle: "lecturas", valor: false }],
      ["quiero cambiar mis ajustes de privacidad", 2, { toggle: null, valor: null }],
      ["desactiva las notificaciones de votos", 3, { categoria: "votos", valor: false }],
      ["turn on mentions notifications", 3, { categoria: "menciones", valor: true }],
      ["关闭评论通知", 3, { categoria: "comentarios", valor: false }],
      ["desativar notificações de festas", 3, { categoria: "fiestas", valor: false }],
    ];
    for (const [txt, ri, want] of cases) {
      const r = R[ri];
      const hit = r.patterns.some((p) => p.test(txt));
      if (!hit) { no("T8-pattern", txt); continue; }
      eqJ("T8-extract-" + txt.slice(0, 24), r.extract(txt), want);
      eqJ("T8-langs", r.langs, ["es", "en", "zh", "pt"]);
    }
  });

  /* T9 */
  await runCase("T9", async () => {
    const P = EXP.pure;
    eqJ("T9-idioma-en", P.baroJExtractIdioma("change language to english"), { idioma: "en" });
    eqJ("T9-idioma-pt", P.baroJExtractIdioma("mudar idioma para português"), { idioma: "pt" });
    eqJ("T9-idioma-es", P.baroJExtractIdioma("ponlo en español"), { idioma: "es" });
    eqJ("T9-tema-oscuro", P.baroJExtractTema("activa el modo oscuro"), { tema: "oscuro" });
    eqJ("T9-tema-sistema", P.baroJExtractTema("use system theme"), { tema: "sistema" });
    eqJ("T9-tema-amb", P.baroJExtractTema("cambia el tema"), {});
    eqJ("T9-priv-pub", P.baroJExtractPrivacidad("make my account public"), { toggle: "privada", valor: false });
    eqJ("T9-priv-bor", P.baroJExtractPrivacidad("desativa salvar rascunhos"), { toggle: "borradores", valor: false });
    eqJ("T9-priv-lec", P.baroJExtractPrivacidad("开启已读回执"), { toggle: "lecturas", valor: true });
    eqJ("T9-priv-panel", P.baroJExtractPrivacidad("muéstrame la privacidad"), { toggle: null, valor: null });
    eqJ("T9-notif-md", P.baroJExtractNotificaciones("silencia los mensajes directos"), { categoria: "md", valor: false });
    eqJ("T9-notif-grupo", P.baroJExtractNotificaciones("activa los mensajes de grupo"), { categoria: "grupo", valor: true });
    eqJ("T9-notif-corr", P.baroJExtractNotificaciones("desactiva las correcciones"), { categoria: "correcciones", valor: false });
    eqJ("T9-notif-panel", P.baroJExtractNotificaciones("revisa mis notificaciones"), { categoria: null, valor: null });
    eqJ("T9-vacio-idioma", P.baroJExtractIdioma("hola mundo"), {});
    eqJ("T9-vacio-tema", P.baroJExtractTema("hola mundo"), {});
    eqJ("T9-vacio-priv", P.baroJExtractPrivacidad("hola mundo"), {});
    eqJ("T9-vacio-notif", P.baroJExtractNotificaciones("hola mundo"), {});
  });

  function freshEnv() { store = makeStore(); resetAnchors(); currentLanguage = "es"; fakeTheme = "light"; }

  /* T10 */
  await runCase("T10", async () => {
    freshEnv();
    let log = [];
    let r = await regTools.ajuste_idioma.run({}, makeCtx(null, log));
    has("T10-sin-sesion", r.html, "Inicia sesión");
    r = await regTools.ajuste_idioma.run({}, makeCtx(USER, log));
    has("T10-panel-actual", r.html, "español");
    for (const b of ["Español", "English", "中文", "Português"]) has("T10-boton-" + b, r.html, b);
    has("T10-panel-onclick", r.html, "baroJPick(");
    r = await regTools.ajuste_idioma.run({ idioma: "en" }, makeCtx(USER, log));
    has("T10-ok", r.html, "English");
    eq("T10-ancla-llamada", anchorCalls.lang, 1);
    eq("T10-idioma-aplicado", currentLanguage, "en");
    /* El UI ahora habla inglés: el caso "ya activo" se prueba volviendo a español. */
    currentLanguage = "es";
    r = await regTools.ajuste_idioma.run({ idioma: "es" }, makeCtx(USER, log));
    has("T10-ya", r.html, "Ya estás usando");
    eq("T10-ya-no-rellama", anchorCalls.lang, 1);
    const keep = sandbox.setAppLanguage; delete sandbox.setAppLanguage;
    r = await regTools.ajuste_idioma.run({ idioma: "pt" }, makeCtx(USER, log));
    has("T10-ancla-ausente", r.html, "no está disponible");
    eq("T10-ausente-sin-cambio", currentLanguage, "es");
    sandbox.setAppLanguage = keep;
  });

  /* T11 */
  await runCase("T11", async () => {
    freshEnv();
    let log = [];
    let r = await regTools.ajuste_tema.run({}, makeCtx(null, log));
    has("T11-sin-sesion", r.html, "Inicia sesión");
    r = await regTools.ajuste_tema.run({}, makeCtx(USER, log));
    has("T11-panel-actual", r.html, "claro");
    has("T11-panel-onclick", r.html, "baroJPick(");
    r = await regTools.ajuste_tema.run({ tema: "oscuro" }, makeCtx(USER, log));
    has("T11-ok", r.html, "oscuro");
    eq("T11-ancla-llamada", anchorCalls.theme, 1);
    eq("T11-tema-aplicado", fakeTheme, "dark");
    r = await regTools.ajuste_tema.run({ tema: "sistema" }, makeCtx(USER, log));
    has("T11-sistema-honesto", r.html, "automático");
    eq("T11-sistema-no-llama", anchorCalls.theme, 1);
    r = await regTools.ajuste_tema.run({ tema: "oscuro" }, makeCtx(USER, log));
    has("T11-ya", r.html, "Ya estás usando");
    const keep = sandbox.selectThemeOption; delete sandbox.selectThemeOption;
    r = await regTools.ajuste_tema.run({ tema: "claro" }, makeCtx(USER, log));
    has("T11-ancla-ausente", r.html, "no está disponible");
    eq("T11-ausente-sin-cambio", fakeTheme, "dark");
    sandbox.selectThemeOption = keep;
  });

  /* T12 */
  await runCase("T12", async () => {
    freshEnv();
    let log = [];
    let r = await regTools.ajuste_privacidad.run({}, makeCtx(null, log));
    has("T12-sin-sesion", r.html, "Inicia sesión");
    eq("T12-sin-sesion-sin-anclas", anchorCalls.priv + anchorCalls.chat, 0);
    store.users.u1.isPrivate = true;
    store.userSettings.u1.chatPrivacy = { saveDrafts: false, readReceipts: true };
    r = await regTools.ajuste_privacidad.run({}, makeCtx(USER, log));
    has("T12-conteo", r.html, "2 de 3 activados");
    has("T12-cuenta", r.html, "Cuenta privada");
    has("T12-borradores", r.html, "Guardar borradores");
    has("T12-lecturas", r.html, "Confirmaciones de lectura");
    has("T12-desactivado", r.html, "desactivado");
    has("T12-onclick", r.html, "baroJPick(");
    r = await regTools.ajuste_privacidad.run({ toggle: "borradores", valor: true }, makeCtx(USER, log));
    has("T12-ok-borradores", r.html, "Guardar borradores");
    eq("T12-ancla-chat", anchorCalls.chat, 1);
    eq("T12-db-borradores", store.userSettings.u1.chatPrivacy.saveDrafts, true);
    r = await regTools.ajuste_privacidad.run({ toggle: "lecturas", valor: true }, makeCtx(USER, log));
    has("T12-noop", r.html, "ya estaba");
    eq("T12-noop-no-llama", anchorCalls.chat, 1);
    store.users.u1.isPrivate = false;
    r = await regTools.ajuste_privacidad.run({ toggle: "privada", valor: true }, makeCtx(USER, log));
    has("T12-ok-privada", r.html, "activado");
    eq("T12-ancla-priv", anchorCalls.priv, 1);
    eq("T12-db-privada", store.users.u1.isPrivate, true);
    r = await regTools.ajuste_privacidad.run({ toggle: "invento", valor: true }, makeCtx(USER, log));
    has("T12-toggle-no", r.html, "No reconocí");
    const keep = sandbox.toggleAccountPrivacy; delete sandbox.toggleAccountPrivacy;
    r = await regTools.ajuste_privacidad.run({ toggle: "privada", valor: false }, makeCtx(USER, log));
    has("T12-ancla-ausente", r.html, "no está disponible");
    eq("T12-ausente-sin-cambio", store.users.u1.isPrivate, true);
    sandbox.toggleAccountPrivacy = keep;
    const keepDb = sandbox.DrexCloud; delete sandbox.DrexCloud;
    r = await regTools.ajuste_privacidad.run({}, makeCtx(USER, log));
    has("T12-sin-db", r.html, "base de datos");
    sandbox.DrexCloud = keepDb;
  });

  /* T13 */
  await runCase("T13", async () => {
    freshEnv();
    let log = [];
    let r = await regTools.ajuste_notificaciones.run({}, makeCtx(null, log));
    has("T13-sin-sesion", r.html, "Inicia sesión");
    eq("T13-sin-sesion-sin-anclas", anchorCalls.notif, 0);
    store.userSettings.u1.notifications = { likes: false, comments: true };
    r = await regTools.ajuste_notificaciones.run({}, makeCtx(USER, log));
    has("T13-conteo", r.html, "9 de 10 activadas");
    has("T13-cat-votos", r.html, "Votos");
    has("T13-cat-comentarios", r.html, "Comentarios");
    has("T13-cat-fiestas", r.html, "Fiestas de seguidos");
    has("T13-cat-md", r.html, "Mensajes directos");
    has("T13-cat-corr", r.html, "Correcciones de ejercicios");
    has("T13-desactivadas", r.html, "desactivadas");
    has("T13-onclick", r.html, "baroJPick(");
    r = await regTools.ajuste_notificaciones.run({ categoria: "votos", valor: true }, makeCtx(USER, log));
    has("T13-ok-votos", r.html, "activadas");
    eq("T13-ancla-notif", anchorCalls.notif, 1);
    eq("T13-db-votos", store.userSettings.u1.notifications.likes, true);
    r = await regTools.ajuste_notificaciones.run({ categoria: "menciones", valor: true }, makeCtx(USER, log));
    has("T13-noop", r.html, "ya estaba");
    eq("T13-noop-no-llama", anchorCalls.notif, 1);
    r = await regTools.ajuste_notificaciones.run({ categoria: "deportes" }, makeCtx(USER, log));
    has("T13-cat-no", r.html, "No reconocí");
    const keep = sandbox.toggleNotifSetting; delete sandbox.toggleNotifSetting;
    r = await regTools.ajuste_notificaciones.run({ categoria: "fiestas", valor: false }, makeCtx(USER, log));
    has("T13-ancla-ausente", r.html, "no está disponible");
    eq("T13-ausente-sin-cambio", store.userSettings.u1.notifications.fiestas !== false, true);
    sandbox.toggleNotifSetting = keep;
  });

  /* T14 */
  await runCase("T14", async () => {
    freshEnv();
    const before = JSON.stringify(store);
    for (const n of ["ajuste_idioma", "ajuste_tema", "ajuste_privacidad", "ajuste_notificaciones"]) {
      await regTools[n].run({}, makeCtx(null, []));
      await regTools[n].run({ idioma: "en", tema: "oscuro", toggle: "privada", valor: true, categoria: "votos" }, makeCtx(null, []));
    }
    eqJ("T14-store-intacto", JSON.parse(JSON.stringify(store)), JSON.parse(before));
    eq("T14-cero-anclas", anchorCalls.lang + anchorCalls.theme + anchorCalls.priv + anchorCalls.chat + anchorCalls.notif, 0);
  });

  /* T15 */
  await runCase("T15", async () => {
    eq("T15-export-i18n", !!EXP.BARO_I18N_J, true);
    eq("T15-export-icons", !!EXP.BARO_ICONS_J, true);
    eq("T15-export-rules", Array.isArray(EXP.BARO_J_RULES), true);
    eq("T15-export-pure", Object.keys(EXP.pure).length, 6);
    eqJ("T15-export-tools", Object.keys(EXP.tools).sort(), ["ajuste_idioma", "ajuste_notificaciones", "ajuste_privacidad", "ajuste_tema"].sort());
    eq("T15-export-baroJPick", typeof EXP.helpers.baroJPick, "function");
    eq("T15-marcador-J", sandbox.__baro8j && sandbox.__baro8j.block, "J");
    eq("T15-baroJPick-global", typeof sandbox.baroJPick, "function");
    sandbox.baroJPick("inexistente", "x");
    ok("T15-baroJPick-noop");
    eq("T15-fusion-en", sandbox.APP_ENGLISH_TEXT["baro.tool.ajuste.need_login"], "PREEXISTENTE");
    has("T15-fusion-zh", sandbox.APP_CHINESE_TEXT["baro.tool.ajuste.tema.sin_sistema"], "浅色");
    has("T15-fusion-pt", sandbox.APP_PORTUGUESE_TEXT["baro.tool.ajuste.notificaciones.panel"], "notificações");
  });

  /* T16 */
  await runCase("T16", async () => {
    freshEnv();
    const stepsFor = async (name) => {
      const log = [];
      await regTools[name].run({}, makeCtx(USER, log));
      return log;
    };
    const want = { ajuste_idioma: "Revisando tu idioma", ajuste_tema: "Revisando tu tema", ajuste_privacidad: "Revisando tu privacidad", ajuste_notificaciones: "Revisando tus notificaciones" };
    for (const n of Object.keys(want)) {
      const log = await stepsFor(n);
      const s = log.find((e) => e[0] === "step");
      const d = log.find((e) => e[0] === "stepDone");
      if (!s || s[1].indexOf(want[n]) !== 0) { no("T16-step-" + n, JSON.stringify(log)); continue; }
      if (!d || d[1] !== s[2]) { no("T16-stepDone-" + n, JSON.stringify(log)); continue; }
      ok("T16-pasos-" + n);
    }
  });

  /* T17 */
  await runCase("T17", async () => {
    eqJ("T17-mapa", sandbox.baroIntentToTool, {
      ajuste_idioma: "ajuste_idioma",
      ajuste_tema: "ajuste_tema",
      ajuste_privacidad: "ajuste_privacidad",
      ajuste_notificaciones: "ajuste_notificaciones",
    });
    eq("T17-reglas-registradas", sandbox.baroIntentRules.length, 4);
  });

  /* T18 */
  await runCase("T18", async () => {
    hasNo("T18-sin-cierre-script", snippetSrc, "</scr" + "ipt>");
    hasNo("T18-bloque-sin-cierre", block, "</scr" + "ipt>");
  });

  if (SHOW) {
    console.log("---- primeras 60 líneas del bloque ----");
    console.log(block.split("\n").slice(0, 60).join("\n"));
  }
  console.log("c119: " + pass + " PASS, " + fail + " FAIL");
  if (fail > 0) { console.log("Fallos:"); failures.forEach((f) => console.log(" - " + f)); process.exit(1); }
})();
