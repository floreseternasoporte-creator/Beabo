// C116 · BARO sub-bloque 8G (OLEADA 3 v4 — fiestas)
// Prueba el bloque autocontenido de fiestas extraído de una copia privada de index.html.
// Uso: node test-c116-baro-fiestas.js [--target ruta/al/index.html]
// No modifica ~/workspace/beabo.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DIR = __dirname;
const MARKER = "/* ================= BARO · sub-bloque 8G — OLEADA 3 v4 (fiestas) ================= */";
const FORBIDDEN = "</" + "script";

let target = path.join(DIR, "8G-inserted-c26397e.html");
if (!fs.existsSync(target)) target = path.join(DIR, "..", "index.html"); // CI: el integrado
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--target" && process.argv[i + 1]) target = process.argv[i + 1];
}
const html = fs.readFileSync(target, "utf8");
const si = html.indexOf(MARKER);
if (si < 0) { console.error("FAIL: marcador 8G no encontrado en", target); process.exit(1); }
const eiScript = html.indexOf(FORBIDDEN, si);
if (eiScript < 0) { console.error("FAIL: cierre de script no encontrado tras el bloque 8G"); process.exit(1); }
// En el index integrado, tras 8G vienen 8H..8L en el mismo <script>: cortar en el siguiente marcador.
const eiNext = html.indexOf("/* ================= BARO · sub-bloque 8", si + MARKER.length);
const ei = (eiNext !== -1 && eiNext < eiScript) ? eiNext : eiScript;
const code = html.slice(si, ei);
if (!code.includes("(function () {")) { console.error("FAIL: el bloque 8G no parece una IIFE"); process.exit(1); }

// ---------- IDs de prueba ----------
const me = "MEUID" + "0".repeat(23);      // 28 chars
const host = "HOSTUID" + "0".repeat(21);   // 28 chars
const other = "OTHERUID" + "0".repeat(20);// 28 chars
const uid3 = "UID3AAA" + "0".repeat(21);   // 28 chars
const LIVE = "fiestaLive123";
const ZOMBIE = "fiestaZombie00";
const DISFRAZ = "fiestaDisfraz1";
const ENDED = "fiestaEnded456";

function seed() {
  return {
    communityNotes: {
      note1: { fiestaId: LIVE, fiestaStatus: "live", title: "Noche de Karaoke", description: "Cantamos éxitos de los 80", hostId: host, host: "ana", timestamp: 30 },
      note2: { fiestaId: ZOMBIE, fiestaStatus: "live", title: "Fiesta Zombie", description: "música oscura", hostId: other, host: "luis", timestamp: 20 },
      note4: { fiestaId: DISFRAZ, fiestaStatus: "live", title: "Fiesta de Disfraces", description: "ven disfrazado", hostId: other, host: "luis", timestamp: 15 },
      note3: { fiestaId: ENDED, fiestaStatus: "ended", title: "Tarde de Juegos", description: "juegos de mesa", hostId: host, host: "ana", timestamp: 10 }
    },
    fiestas: {
      [LIVE]: { title: "Noche de Karaoke", description: "Cantamos éxitos de los 80", hostId: host, status: "live", createdAt: 1 },
      [ZOMBIE]: { title: "Fiesta Zombie", description: "música oscura", hostId: other, status: "live", createdAt: 1 },
      [DISFRAZ]: { title: "Fiesta de Disfraces", description: "ven disfrazado", hostId: other, status: "live", createdAt: 1 },
      [ENDED]: { title: "Tarde de Juegos", hostId: host, status: "ended", createdAt: 1 }
    },
    fiestaMembers: {
      [LIVE]: {
        [host]: { name: "ana", photo: "", role: "host", joinedAt: 1 },
        [uid3]: { name: "pedro", photo: "", role: "speaker", joinedAt: 5 },
        [me]: { name: "yo", photo: "", role: "listener", joinedAt: 10 }
      }
    }
  };
}

// ---------- Fake RTDB (DrexCloud) ----------
function makeStore(seedData) {
  const store = JSON.parse(JSON.stringify(seedData));
  const log = [];
  function getP(p) {
    const parts = String(p).split("/").filter(Boolean);
    let node = store;
    for (const x of parts) { if (node == null || typeof node !== "object") return undefined; node = node[x]; }
    return node;
  }
  function setP(p, v) {
    const parts = String(p).split("/").filter(Boolean);
    let node = store;
    for (let i = 0; i < parts.length - 1; i++) {
      if (node[parts[i]] == null || typeof node[parts[i]] !== "object") node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = v;
  }
  function delP(p) {
    const parts = String(p).split("/").filter(Boolean);
    let node = store;
    for (let i = 0; i < parts.length - 1; i++) { if (node == null) return; node = node[parts[i]]; }
    if (node) delete node[parts[parts.length - 1]];
  }
  function forEachable(obj) {
    return {
      exists: () => obj != null && Object.keys(obj).length > 0,
      val: () => obj,
      forEach(cb) { if (obj) for (const k of Object.keys(obj)) cb({ key: k, val: () => obj[k] }); return false; }
    };
  }
  function snapOf(p) {
    const v = getP(p);
    return { exists: () => v !== undefined && v !== null, val: () => (v === undefined ? null : v), forEach: forEachable(v && typeof v === "object" ? v : null).forEach };
  }
  function snapOfOrdered(p, child, n) {
    const v = getP(p);
    const kids = v && typeof v === "object" ? Object.keys(v) : [];
    kids.sort((a, b) => (((v[a] || {})[child]) || 0) - (((v[b] || {})[child]) || 0));
    const last = kids.slice(-n);
    const sub = {}; for (const k of last) sub[k] = v[k];
    return forEachable(last.length ? sub : null);
  }
  function snapOfEqual(p, child, val) {
    const v = getP(p);
    const sub = {};
    if (v && typeof v === "object") for (const k of Object.keys(v)) { if (String((v[k] || {})[child]) === String(val)) sub[k] = v[k]; }
    return forEachable(Object.keys(sub).length ? sub : null);
  }
  let pushN = 0;
  function ref(p) {
    const base = String(p == null ? "" : p).replace(/^\/+|\/+$/g, "");
    return {
      once: async () => snapOf(base),
      set: async (v) => { log.push(["set", base]); setP(base, JSON.parse(JSON.stringify(v))); },
      remove: async () => { log.push(["remove", base]); delP(base); },
      update: async (o) => { log.push(["update", base]); setP(base, Object.assign({}, getP(base) || {}, o)); },
      transactionBlind: async () => ({ committed: true }),
      push: async (v) => { pushN++; const k = "k" + pushN; log.push(["push", base + "/" + k]); setP(base + "/" + k, v === undefined ? null : JSON.parse(JSON.stringify(v))); return { key: k }; },
      orderByChild: (child) => ({
        limitToLast: (n) => ({ once: async () => snapOfOrdered(base, child, n) }),
        equalTo: (val) => ({ once: async () => snapOfEqual(base, child, val) })
      })
    };
  }
  return { ref, store, log };
}

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function makeCtx(user) {
  return { user, t: (k) => k, step: () => {}, stepDone: () => {}, esc };
}

function buildSandbox(user) {
  const st = makeStore(seed());
  const confirmCalls = [];
  let nextConfirm = { confirmed: true };
  const painted = [];
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Math, Date, RegExp, Object, Array, String, Number, Boolean, Error, Symbol,
    btoa: (s) => Buffer.from(String(s), "utf8").toString("base64"),
    atob: (s) => Buffer.from(String(s), "base64").toString("utf8"),
    unescape, escape, encodeURIComponent, decodeURIComponent,
    BARO_UI_I18N: {}, APP_ENGLISH_TEXT: {}, APP_CHINESE_TEXT: {}, APP_PORTUGUESE_TEXT: {},
    BARO_ICONS: {}, baroIntentRules: [], baroIntentToTool: {}, registeredTools: {},
    getAppLanguage: () => "es",
    baroAskConfirm: (ctx, opts) => { confirmCalls.push(opts || {}); return nextConfirm == null ? {} : nextConfirm; },
    baroAddBaroMessage: (h) => { painted.push(String(h)); },
    baroMakeCtx: () => makeCtx(user),
    DrexCloud: st
  };
  sandbox.baroRegisterTool = (name, def) => { sandbox.registeredTools[name] = def; };
  return { sandbox, st, confirmCalls, painted, setNextConfirm(v) { nextConfirm = v; } };
}

// ---------- harness ----------
let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { passed++; }
  else { failed++; failures.push(name + (extra ? " :: " + extra : "")); console.error("FAIL:", name, extra || ""); }
}
function eq(a, b, name) { ok(a === b, name, "esperado " + JSON.stringify(b) + ", obtenido " + JSON.stringify(a)); }
function has(h, s, name) { ok(String(h || "").includes(s), name, "no contiene: " + s); }

(async () => {
  const meUser = { uid: me, displayName: "yo", username: "yo", photoURL: "" };
  const hostUser = { uid: host, displayName: "ana", username: "ana", photoURL: "" };
  const anonCtx = makeCtx(null);

  // ---------- 1. Registro, reglas, mapas, i18n, iconos ----------
  {
    const { sandbox } = buildSandbox(meUser);
    vm.runInNewContext(code, sandbox, { filename: "baro-8g.js" });
    const T = sandbox.baroFiesta8gTest;
    ok(!!T, "8G expone baroFiesta8gTest en el sandbox");
    eq(Object.keys(sandbox.registeredTools).sort().join(","), "fiesta_asistentes,fiesta_gestionar,fiesta_invitar,fiesta_salir,fiesta_unirse", "registra las 5 tools fiesta_*");
    for (const n of ["fiesta_unirse", "fiesta_salir", "fiesta_invitar", "fiesta_gestionar", "fiesta_asistentes"]) {
      ok(typeof sandbox.registeredTools[n].run === "function", "tool " + n + " tiene run");
    }
    eq(sandbox.baroIntentRules.length, 5, "fusiona 5 reglas en baroIntentRules");
    const intents = sandbox.baroIntentRules.map((r) => r.intent).sort().join(",");
    eq(intents, "fiesta_asistentes,fiesta_gestionar,fiesta_invitar,fiesta_salir,fiesta_unirse", "intents fiesta_*");
    for (const r of sandbox.baroIntentRules) {
      eq(r.langs.join(","), "es,en,zh,pt", "regla " + r.intent + " cubre ES/EN/ZH/PT");
      ok(typeof r.extract === "function", "regla " + r.intent + " tiene extract");
      ok(Array.isArray(r.patterns) && r.patterns.length > 0, "regla " + r.intent + " tiene patterns");
    }
    for (const i of ["fiesta_unirse", "fiesta_salir", "fiesta_invitar", "fiesta_gestionar", "fiesta_asistentes"]) {
      eq(sandbox.baroIntentToTool[i], i, "baroIntentToTool[" + i + "]");
    }
    // i18n: prefijo baro.tool.fiesta.* completo en 4 idiomas
    const keys = Object.keys(T.BARO_I18N_G);
    ok(keys.length >= 40, "i18n con claves baro.tool.fiesta.* (" + keys.length + ")");
    ok(keys.every((k) => k.indexOf("baro.tool.fiesta.") === 0), "todas las claves usan el prefijo baro.tool.fiesta.");
    ok(keys.every((k) => { const e = T.BARO_I18N_G[k]; return e.es && e.en && e.zh && e.pt; }), "cada clave tiene ES/EN/ZH/PT");
    // fusión a diccionarios de la app
    ok(sandbox.BARO_UI_I18N["baro.tool.fiesta.unirse.label"], "fusiona en BARO_UI_I18N");
    eq(sandbox.APP_ENGLISH_TEXT["baro.tool.fiesta.unirse.label"], "Join a party", "fusiona EN en APP_ENGLISH_TEXT");
    eq(sandbox.APP_CHINESE_TEXT["baro.tool.fiesta.unirse.label"], "加入聚会", "fusiona ZH en APP_CHINESE_TEXT");
    eq(sandbox.APP_PORTUGUESE_TEXT["baro.tool.fiesta.unirse.label"], "Entrar em uma festa", "fusiona PT en APP_PORTUGUESE_TEXT");
    // iconos: 5 SVG índigo, sin emoji
    const icons = T.BARO_ICONS_G;
    eq(Object.keys(icons).sort().join(","), "fiesta-asistentes,fiesta-gestionar,fiesta-invitar,fiesta-salir,fiesta-unirse", "5 iconos fiesta-*");
    for (const k of Object.keys(icons)) {
      const svg = icons[k];
      ok(svg.indexOf("<svg") === 0 && svg.indexOf("</svg>") > 0, "icono " + k + " es SVG");
      ok(svg.indexOf("#2F33B8") !== -1, "icono " + k + " usa el índigo #2F33B8");
      ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(svg), "icono " + k + " sin emoji");
      ok(sandbox.BARO_ICONS[k] === svg, "icono " + k + " fusionado en BARO_ICONS");
    }
    // handler global de candidatas
    ok(typeof sandbox.baroFiesta8gPick === "function", "expone baroFiesta8gPick global");
    // literal prohibido
    ok(code.indexOf(FORBIDDEN) === -1, "el bloque no contiene el literal </script>");
    // pure expuestos
    for (const fn of ["baroGExtractUnirse", "baroGExtractSalir", "baroGExtractInvitar", "baroGExtractGestionar", "baroGExtractAsistentes", "baroGJoinPayload", "baroGIsUid", "baroGSafeId"]) {
      ok(typeof T.pure[fn] === "function", "pure expone " + fn);
    }
  }

  // ---------- 2. Extractores ES/EN/ZH/PT + rechazos cruzados ----------
  {
    const { sandbox } = buildSandbox(meUser);
    vm.runInNewContext(code, sandbox, { filename: "baro-8g.js" });
    const P = sandbox.baroFiesta8gTest.pure;
    const u1 = P.baroGExtractUnirse("únete a la fiesta Noche de Karaoke");
    ok(u1 && u1.fiesta === "Noche de Karaoke", "unirse ES extrae nombre", JSON.stringify(u1));
    const u2 = P.baroGExtractUnirse("join the Fiesta Zombie party");
    ok(u2 && /zombie/i.test(u2.fiesta || ""), "unirse EN extrae nombre", JSON.stringify(u2));
    const u3 = P.baroGExtractUnirse("加入派对狂欢夜");
    ok(u3 && u3.fiesta, "unirse ZH extrae nombre", JSON.stringify(u3));
    const u4 = P.baroGExtractUnirse("entrar na festa Junina");
    ok(u4 && /junina/i.test(u4.fiesta || ""), "unirse PT extrae nombre", JSON.stringify(u4));
    const u5 = P.baroGExtractUnirse("únete a la fiesta");
    ok(u5 && u5.ambiguous === true && u5.reason === "missing_fiesta", "unirse sin nombre → ambiguo missing_fiesta");
    eq(P.baroGExtractUnirse("sal de la fiesta"), null, "unirse rechaza «sal de la fiesta»");
    eq(P.baroGExtractUnirse("cierra la fiesta"), null, "unirse rechaza «cierra la fiesta»");
    eq(P.baroGExtractUnirse("invita a juan a la fiesta"), null, "unirse rechaza invitar");
    eq(P.baroGExtractUnirse("crea una fiesta"), null, "unirse rechaza crear");
    eq(P.baroGExtractUnirse("busca fiestas"), null, "unirse rechaza buscar");

    const s1 = P.baroGExtractSalir("sal de la fiesta Karaoke");
    ok(s1 && /karaoke/i.test(s1.fiesta || ""), "salir ES extrae nombre", JSON.stringify(s1));
    const s2 = P.baroGExtractSalir("leave the party now");
    ok(s2 && s2.ambiguous === true, "salir EN sin nombre → ambiguo", JSON.stringify(s2));
    const s3 = P.baroGExtractSalir("离开派对");
    ok(s3 && s3.ambiguous === true, "salir ZH sin nombre → ambiguo");
    const s4 = P.baroGExtractSalir("sair da festa Junina");
    ok(s4 && /junina/i.test(s4.fiesta || ""), "salir PT extrae nombre", JSON.stringify(s4));
    eq(P.baroGExtractSalir("únete a la fiesta"), null, "salir rechaza unirse");
    eq(P.baroGExtractSalir("cierra la fiesta"), null, "salir rechaza cerrar");

    const i1 = P.baroGExtractInvitar("invita a @juan a la fiesta Karaoke");
    ok(i1 && /karaoke/i.test(i1.fiesta || "") && i1.invitados && i1.invitados[0] === "juan", "invitar ES extrae nombre + @mención", JSON.stringify(i1));
    const i2 = P.baroGExtractInvitar("invite Ana to the party");
    ok(i2 && i2.fiesta, "invitar EN extrae nombre", JSON.stringify(i2));
    const i3 = P.baroGExtractInvitar("邀请小王加入派对");
    ok(i3 && i3.fiesta, "invitar ZH extrae nombre", JSON.stringify(i3));
    const i4 = P.baroGExtractInvitar("convida a Maria para a festa Junina");
    ok(i4 && /junina/i.test(i4.fiesta || ""), "invitar PT extrae nombre", JSON.stringify(i4));

    const g1 = P.baroGExtractGestionar("cierra la fiesta Karaoke");
    ok(g1 && g1.accion === "cerrar" && /karaoke/i.test(g1.fiesta || ""), "gestionar ES cerrar", JSON.stringify(g1));
    const g2 = P.baroGExtractGestionar("close the party");
    ok(g2 && g2.accion === "cerrar" && !g2.ambiguous, "gestionar EN close genérico → ruta propia sin ambigüedad", JSON.stringify(g2));
    const g3 = P.baroGExtractGestionar("结束派对");
    ok(g3 && g3.accion === "cerrar", "gestionar ZH 结束派对", JSON.stringify(g3));
    const g4 = P.baroGExtractGestionar("encerra a festa Junina");
    ok(g4 && g4.accion === "cerrar" && /junina/i.test(g4.fiesta || ""), "gestionar PT encerra", JSON.stringify(g4));
    const g5 = P.baroGExtractGestionar("cambia el título de la fiesta Karaoke");
    ok(g5 && g5.accion === "titulo", "gestionar detecta edición de título", JSON.stringify(g5));
    const g6 = P.baroGExtractGestionar("cambia la descripción de la fiesta Karaoke");
    ok(g6 && g6.accion === "descripcion", "gestionar detecta edición de descripción", JSON.stringify(g6));
    const g7 = P.baroGExtractGestionar("gestiona mi fiesta Karaoke");
    ok(g7 && /karaoke/i.test(g7.fiesta || ""), "gestiona mi fiesta <nombre> resuelve nombre", JSON.stringify(g7));
    const g8 = P.baroGExtractGestionar("gestiona mi fiesta");
    ok(g8 && !g8.ambiguous, "gestiona mi fiesta (genérico) va a ruta de fiestas propias", JSON.stringify(g8));

    const a1 = P.baroGExtractAsistentes("quién está en la fiesta Karaoke");
    ok(a1 && /karaoke/i.test(a1.fiesta || ""), "asistentes ES extrae nombre", JSON.stringify(a1));
    const a2 = P.baroGExtractAsistentes("who is in the party");
    ok(a2 && a2.ambiguous === true, "asistentes EN sin nombre → ambiguo", JSON.stringify(a2));
    const a3 = P.baroGExtractAsistentes("谁在派对里");
    ok(a3 && a3.ambiguous === true, "asistentes ZH sin nombre → ambiguo", JSON.stringify(a3));
    const a4 = P.baroGExtractAsistentes("quem está na festa Junina");
    ok(a4 && /junina/i.test(a4.fiesta || ""), "asistentes PT extrae nombre", JSON.stringify(a4));
    const a5 = P.baroGExtractAsistentes("miembros de la fiesta Karaoke");
    ok(a5 && /karaoke/i.test(a5.fiesta || ""), "asistentes «miembros de la fiesta»", JSON.stringify(a5));
    eq(P.baroGExtractAsistentes("qué fiestas hay"), null, "asistentes rechaza «qué fiestas hay» (búsqueda)");
    eq(P.baroGExtractAsistentes("busca fiestas de música"), null, "asistentes rechaza buscar");
  }

  // ---------- 3. Sin sesión: cero escrituras ----------
  {
    const { sandbox, st } = buildSandbox(null);
    vm.runInNewContext(code, sandbox, { filename: "baro-8g.js" });
    const T = sandbox.baroFiesta8gTest;
    const before = JSON.stringify(st.store);
    for (const [name, args] of [
      ["fiesta_unirse", { fiesta: "Karaoke" }],
      ["fiesta_salir", { fiesta: "Karaoke" }],
      ["fiesta_invitar", { fiesta: "Karaoke" }],
      ["fiesta_gestionar", { fiesta: "Karaoke", accion: "cerrar" }],
      ["fiesta_asistentes", { fiesta: "Karaoke" }]
    ]) {
      const r = await T.tools[name](args, anonCtx);
      has(r.html, "iniciar sesión", name + " sin sesión pide login");
    }
    eq(JSON.stringify(st.store), before, "sin sesión: cero escrituras en la BD");
    eq(st.log.length, 0, "sin sesión: cero llamadas de escritura al store");
  }

  // ---------- 4. Unirse: confirmación por toque + escritura real ----------
  {
    const b = buildSandbox(meUser);
    vm.runInNewContext(code, b.sandbox, { filename: "baro-8g.js" });
    const T = b.sandbox.baroFiesta8gTest;
    const ctx = makeCtx(meUser);
    // 4a. revisión por toque: sin confirmar no escribe
    b.setNextConfirm(null);
    const r0 = await T.tools.fiesta_unirse({ fiesta: "Zombie" }, ctx);
    eq(r0.html, "", "unirse sin confirmar devuelve vacío (revisión por toque)");
    ok(!b.st.store.fiestaMembers[ZOMBIE] || !b.st.store.fiestaMembers[ZOMBIE][me], "unirse sin confirmar no escribe miembro");
    // 4b. confirmado: escribe fiestaMembers con payload real
    const confirmsBefore = b.confirmCalls.length;
    b.setNextConfirm({ confirmed: true });
    const r1 = await T.tools.fiesta_unirse({ fiesta: "Zombie" }, ctx);
    has(r1.html, "Te uniste a", "unirse confirmado muestra mensaje de éxito");
    has(r1.html, "Fiesta Zombie", "unirse confirmado nombra la fiesta");
    const m = b.st.store.fiestaMembers[ZOMBIE] && b.st.store.fiestaMembers[ZOMBIE][me];
    ok(!!m, "unirse escribe fiestaMembers/<fiesta>/<uid>");
    eq(m.role, "listener", "payload: role listener");
    eq(m.name, "yo", "payload: name del perfil");
    eq(m.muted, false, "payload: muted false");
    ok(typeof m.joinedAt === "number", "payload: joinedAt numérico");
    eq(b.confirmCalls.length, confirmsBefore + 1, "unirse pidió confirmación una vez más");
    ok(b.confirmCalls[b.confirmCalls.length - 1].danger === false, "unirse: confirmación no destructiva");
    has(b.confirmCalls[b.confirmCalls.length - 1].title, "Unirte", "confirmación de unirse con título");
    // 4c. ya miembro: no duplica
    const writesBefore = b.st.log.filter((l) => l[0] === "set" && l[1].indexOf("fiestaMembers/" + ZOMBIE) === 0).length;
    const r2 = await T.tools.fiesta_unirse({ fiesta: "Zombie" }, ctx);
    has(r2.html, "Ya estás en", "unirse de nuevo dice ya_miembro");
    const writesAfter = b.st.log.filter((l) => l[0] === "set" && l[1].indexOf("fiestaMembers/" + ZOMBIE) === 0).length;
    eq(writesAfter, writesBefore, "ya miembro: no reescribe");
    // 4d. fiesta inexistente: mensaje honesto
    const r3 = await T.tools.fiesta_unirse({ fiesta: "Fantasma Inexistente" }, ctx);
    has(r3.html, "No encontré ninguna fiesta llamada", "fiesta inexistente → mensaje honesto");
    // 4e. nombre ambiguo («fiesta» coincide con Zombie y Disfraces): candidatas tocables
    const r4 = await T.tools.fiesta_unirse({ fiesta: "fiesta" }, ctx);
    const links = (r4.html.match(/baroResolvePickTarget\('fiesta_unirse','[^']+'/g) || []);
    const flat4 = r4.html.replace(/\\/g, "");
    ok(/baroResolvePickTarget\('fiesta_unirse','[A-Za-z0-9_-]+','fiestaId',/.test(flat4), "candidatas usan baroResolvePickTarget con idKey fiestaId");
    eq(links.length, 2, "«fiesta» ambiguo → 2 candidatas tocables");
    ok(links.some((l) => l.indexOf(ZOMBIE) !== -1) && links.some((l) => l.indexOf(DISFRAZ) !== -1), "candidatas son las 2 fiestas en vivo coincidentes");
    // 4f. fiesta terminada (por nombre y por id)
    const r5 = await T.tools.fiesta_unirse({ fiesta: "Juegos" }, ctx);
    has(r5.html, "ya terminó", "fiesta terminada por nombre → mensaje honesto");
    const r5b = await T.tools.fiesta_unirse({ fiestaId: ENDED }, ctx);
    has(r5b.html, "ya terminó", "fiesta terminada por id → mensaje honesto");
    // 4g. sin nombre: lista en vivo
    const r6 = await T.tools.fiesta_unirse({ ambiguous: true }, ctx);
    has(r6.html, "baroResolvePickTarget('fiesta_unirse'", "sin nombre → lista de fiestas en vivo tocables");
  }

  // ---------- 5. Salir: confirmación + baja real ----------
  {
    const b = buildSandbox(meUser);
    vm.runInNewContext(code, b.sandbox, { filename: "baro-8g.js" });
    const T = b.sandbox.baroFiesta8gTest;
    const ctx = makeCtx(meUser);
    // 5a. sin nombre: ofrece solo las fiestas donde soy miembro
    const r0 = await T.tools.fiesta_salir({ ambiguous: true }, ctx);
    const links = (r0.html.match(/baroResolvePickTarget\('fiesta_salir','[^']+'/g) || []);
    eq(links.length, 1, "salir sin nombre → 1 candidata (donde soy miembro)");
    ok(links[0].indexOf(LIVE) !== -1, "la candidata es la fiesta donde soy miembro");
    // 5b. salir confirmado: elimina miembro + señales
    const r1 = await T.tools.fiesta_salir({ fiesta: "Karaoke" }, ctx);
    has(r1.html, "Saliste de", "salir confirmado muestra mensaje");
    has(r1.html, "Noche de Karaoke", "salir nombra la fiesta");
    ok(!b.st.store.fiestaMembers[LIVE][me], "salir elimina fiestaMembers/<fiesta>/<uid>");
    ok(b.st.store.fiestaMembers[LIVE][uid3], "salir no toca a otros miembros");
    eq(b.confirmCalls.length, 1, "salir pidió confirmación");
    ok(b.confirmCalls[0].danger === false, "salir: confirmación no destructiva");
    // 5c. salir de nuevo: no_miembro honesto
    const r2 = await T.tools.fiesta_salir({ fiesta: "Karaoke" }, ctx);
    has(r2.html, "No estás en la fiesta", "salir sin membresía → mensaje honesto");
  }

  // ---------- 6. Invitar: hueco honesto, cero escrituras ----------
  {
    const b = buildSandbox(meUser);
    vm.runInNewContext(code, b.sandbox, { filename: "baro-8g.js" });
    const T = b.sandbox.baroFiesta8gTest;
    const ctx = makeCtx(meUser);
    const before = JSON.stringify(b.st.store);
    const r = await T.tools.fiesta_invitar({ fiesta: "Karaoke", invitados: ["juan"] }, ctx);
    has(r.html, "Aún no existe una forma de invitar", "invitar dice el hueco con honestidad");
    has(r.html, "Noche de Karaoke", "invitar sugiere compartir el nombre");
    eq(JSON.stringify(b.st.store), before, "invitar: cero escrituras (no finge invitaciones)");
    eq(b.confirmCalls.length, 0, "invitar no pide confirmación (no hace nada destructivo)");
  }

  // ---------- 7. Gestionar: anfitrión, danger:true, edición honesta ----------
  {
    // 7a. no anfitrión: no puede cerrar la fiesta ajena
    const b1 = buildSandbox(meUser);
    vm.runInNewContext(code, b1.sandbox, { filename: "baro-8g.js" });
    const T1 = b1.sandbox.baroFiesta8gTest;
    const r0 = await T1.tools.fiesta_gestionar({ fiesta: "Zombie", accion: "cerrar" }, makeCtx(meUser));
    has(r0.html, "Solo el anfitrión", "no anfitrión no puede cerrar");
    eq(b1.st.store.fiestas[ZOMBIE].status, "live", "fiesta ajena sigue en vivo");
    eq(b1.confirmCalls.length, 0, "no anfitrión: ni siquiera pide confirmación");
    // 7b. edición de título: hueco honesto, cero escrituras (como anfitrión)
    const b2 = buildSandbox(hostUser);
    vm.runInNewContext(code, b2.sandbox, { filename: "baro-8g.js" });
    const T2 = b2.sandbox.baroFiesta8gTest;
    const before2 = JSON.stringify(b2.st.store);
    const r1 = await T2.tools.fiesta_gestionar({ fiesta: "Karaoke", accion: "titulo" }, makeCtx(hostUser));
    has(r1.html, "todavía no permite cambiar el título", "edición de título → hueco honesto");
    eq(JSON.stringify(b2.st.store), before2, "editar título: cero escrituras");
    // 7c. cerrar como anfitrión: confirmación danger + cierre real
    const r2 = await T2.tools.fiesta_gestionar({ fiesta: "Karaoke", accion: "cerrar" }, makeCtx(hostUser));
    eq(b2.confirmCalls.length, 1, "cerrar pide confirmación");
    ok(b2.confirmCalls[0].danger === true, "cerrar usa danger:true");
    has(b2.confirmCalls[0].message, "no se puede deshacer", "cerrar advierte irreversibilidad");
    eq(b2.st.store.fiestas[LIVE].status, "ended", "cerrar pone fiestas/<id>/status=ended");
    eq(b2.st.store.communityNotes.note1.fiestaStatus, "ended", "cerrar marca avisos de communityNotes como ended");
    has(r2.html, "quedó cerrada", "cerrar muestra mensaje de éxito");
    // 7d. gestionar sin nombre como anfitrión: resuelve su propia fiesta
    const b3 = buildSandbox(hostUser);
    vm.runInNewContext(code, b3.sandbox, { filename: "baro-8g.js" });
    const T3 = b3.sandbox.baroFiesta8gTest;
    const r3 = await T3.tools.fiesta_gestionar({ ambiguous: true }, makeCtx(hostUser));
    has(r3.html, "¿Qué quieres hacer con la fiesta", "gestionar genérico como anfitrión → pregunta acción (sin_accion)");
    // 7e. gestionar sin fiesta propia
    const b4 = buildSandbox(meUser);
    vm.runInNewContext(code, b4.sandbox, { filename: "baro-8g.js" });
    const T4 = b4.sandbox.baroFiesta8gTest;
    const r4 = await T4.tools.fiesta_gestionar({ ambiguous: true }, makeCtx(meUser));
    has(r4.html, "No tienes ninguna fiesta en vivo", "sin fiesta propia → mensaje honesto");
  }

  // ---------- 8. Asistentes: conteo real + roles ----------
  {
    const b = buildSandbox(meUser);
    vm.runInNewContext(code, b.sandbox, { filename: "baro-8g.js" });
    const T = b.sandbox.baroFiesta8gTest;
    const ctx = makeCtx(meUser);
    const r = await T.tools.fiesta_asistentes({ fiesta: "Karaoke" }, ctx);
    has(r.html, "(3)", "asistentes muestra el conteo real (3)");
    has(r.html, "ana", "asistentes incluye a la anfitriona");
    has(r.html, "pedro", "asistentes incluye al orador");
    has(r.html, "yo", "asistentes incluye al oyente");
    has(r.html, "Anfitrión", "etiqueta de rol Anfitrión");
    has(r.html, "Orador", "etiqueta de rol Orador");
    has(r.html, "Oyente", "etiqueta de rol Oyente");
    const iAna = r.html.indexOf("ana"), iPedro = r.html.indexOf("pedro"), iYo = r.html.indexOf(">yo<");
    ok(iAna !== -1 && iAna < iPedro && iPedro < iYo, "orden: anfitrión, orador, oyente");
    // fiesta sin asistentes
    const r2 = await T.tools.fiesta_asistentes({ fiesta: "Zombie" }, ctx);
    has(r2.html, "aún no tiene asistentes", "fiesta vacía → mensaje honesto");
    // ambigua
    const r3 = await T.tools.fiesta_asistentes({ fiesta: "fiesta" }, ctx);
    has(r3.html, "baroResolvePickTarget('fiesta_asistentes'", "asistentes ambiguo → candidatas tocables");
  }

  // ---------- 9. Pick global: baroFiesta8gPick ----------
  {
    const b = buildSandbox(meUser);
    vm.runInNewContext(code, b.sandbox, { filename: "baro-8g.js" });
    const T = b.sandbox.baroFiesta8gTest;
    b.sandbox.baroTools = {
      fiesta_unirse: { run: T.tools.fiesta_unirse },
      fiesta_asistentes: { run: T.tools.fiesta_asistentes }
    };
    b.sandbox.baroResolvePickTarget = undefined;
    b.setNextConfirm({ confirmed: true });
    b.sandbox.baroFiesta8gPick("fiesta_unirse", ZOMBIE, "");
    await new Promise((r) => setTimeout(r, 60));
    ok(b.painted.length === 1, "pick pinta un mensaje en el chat");
    has(b.painted[0], "Te uniste a", "pick de unirse ejecuta la tool con fiestaId");
    ok(!!(b.st.store.fiestaMembers[ZOMBIE] && b.st.store.fiestaMembers[ZOMBIE][me]), "pick de unirse escribe el miembro");
    b.sandbox.baroFiesta8gPick("fiesta_asistentes", LIVE, "");
    await new Promise((r) => setTimeout(r, 60));
    eq(b.painted.length, 2, "pick de asistentes pinta segundo mensaje");
    has(b.painted[1], "(3)", "pick de asistentes muestra conteo real");
    // id inválido: no hace nada
    b.sandbox.baroFiesta8gPick("fiesta_unirse", "id malo!!", "");
    await new Promise((r) => setTimeout(r, 60));
    eq(b.painted.length, 2, "pick con id inválido no pinta nada");
  }

  // ---------- 10. pure: validaciones ----------
  {
    const b = buildSandbox(meUser);
    vm.runInNewContext(code, b.sandbox, { filename: "baro-8g.js" });
    const P = b.sandbox.baroFiesta8gTest.pure;
    ok(P.baroGIsUid(me), "isUid acepta uid de 28");
    ok(!P.baroGIsUid("corto"), "isUid rechaza corto");
    ok(P.baroGSafeId(LIVE), "safeId acepta id de fiesta");
    ok(!P.baroGSafeId("id malo!!"), "safeId rechaza id con espacios/signos");
    const pay = P.baroGJoinPayload("yo", "", 123);
    eq(pay.role, "listener", "joinPayload role");
    eq(pay.joinedAt, 123, "joinPayload joinedAt");
    eq(P.baroGNorm("Únete a la FIESTA"), "unete a la fiesta", "norm minúsculas + sin tildes");
  }

  console.log("\nC116: " + passed + " OK, " + failed + " FAIL");
  if (failed) { console.error("Fallos:\n - " + failures.join("\n - ")); process.exit(1); }
  console.log("PASS");
})().catch((e) => { console.error("ERROR:", e && e.stack || e); process.exit(1); });
