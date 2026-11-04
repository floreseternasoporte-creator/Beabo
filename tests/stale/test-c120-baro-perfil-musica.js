'use strict';
// Tests del carril 8K (OLEADA 3 v4 — perfil y música) de BARO v4: 4 herramientas.
// Cubre: registro (baroRegisterTool/BARO_ICONS/baroIntentRules/baroIntentToTool),
// intents ES/EN/ZH/PT (extracts puros con declinaciones), i18n en 4 idiomas,
// confirmación obligatoria en foto/portada/subir, cero escrituras sin sesión,
// hueco honesto de audio (sin subida falsa), consulta real de mis subidas, y
// ausencia del literal de cierre de script en el bloque.
// El bloque se EXTRAE de index.html (patron oleada 1 / c103-c110), no del
// archivo del carril: marcador 'BARO · sub-bloque 8K'.
// Uso: node test-c120-baro-perfil-musica.js [--target <ruta-a-index.html>]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = __dirname;
const SNIPPET = path.join(DIR, '8K-snippet.js');
const MARK8E = '/* ================= BARO · sub-bloque 8E';

/* Carga del bloque v4 desde index.html (patron oleada 1): --target opcional.
   Por defecto se construye un target temporal: base-c26397e.html + el bloque
   8K insertado antes del marcador 8E (sin tocar ~/workspace/beabo). */
let __v4ExplicitTarget = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--target' && process.argv[i + 1]) __v4ExplicitTarget = process.argv[++i];
}
function __v4DefaultTarget() {
  const priv = path.join(DIR, 'base-c26397e.html');
  if (!fs.existsSync(priv)) return path.join(DIR, '..', 'index.html'); // CI: el integrado
  const base = fs.readFileSync(priv, 'utf8');
  const snip = fs.readFileSync(SNIPPET, 'utf8');
  const at = base.indexOf(MARK8E);
  if (at === -1) throw new Error('marcador 8E ausente en base-c26397e.html');
  const out = '/tmp/baro8K-c120-target.html';
  fs.writeFileSync(out, base.slice(0, at) + '\n' + snip + '\n' + base.slice(at));
  return out;
}
function __v4ExtractBlock(m) {
  const html = fs.readFileSync(__v4ExplicitTarget || __v4DefaultTarget(), 'utf8');
  const START = '/* ================= ' + m;
  let si = html.indexOf(START);
  if (si === -1) si = html.indexOf(m);
  if (si === -1) throw new Error('marcador ausente en el target');
  const slice = html.slice(si);
  const ni = slice.indexOf('/* ================= BARO · sub-bloque 8', 1);
  const ei = slice.indexOf('</scr' + 'ipt>');
  let end = slice.length;
  if (ni !== -1) end = Math.min(end, ni);
  if (ei !== -1) end = Math.min(end, ei);
  return slice.slice(0, end);
}
const src = __v4ExtractBlock('BARO · sub-bloque 8K');

let fails = 0, oks = 0;
const CASES = [];
function tcase(name, fn) { CASES.push([name, fn]); }
function assert(cond, label) { if (!cond) throw new Error('assert: ' + label); }
function eqJ(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(label + ' esperado=' + e + ' actual=' + a);
}

/* ---------- 0. el bloque no trae el literal de cierre de script ---------- */
tcase('bloque sin literal de cierre de script', () => {
  assert(src.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en el bloque extraido (8K)');
  const tsrc = fs.readFileSync(__filename, 'utf8');
  assert(tsrc.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en test-c120-baro-perfil-musica.js');
  assert(src.indexOf('/* ================= BARO · sub-bloque 8K') === 0, 'el bloque debe empezar con su marcador');
});

/* ---------- stubs de plataforma + carga del bloque en sandbox (vm) ---------- */
const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const AUD1 = 'data:audio/mpeg;base64,' + 'A'.repeat(1000);

function makeDb(seed) {
  const store = seed ? JSON.parse(JSON.stringify(seed)) : {};
  const writes = [];
  let pushSeq = 0;
  const get = (p) => String(p || '').split('/').filter(Boolean).reduce((o, k) => (o && o[k] !== undefined) ? o[k] : undefined, store);
  const setP = (p, v) => {
    const ks = String(p).split('/').filter(Boolean);
    let o = store;
    for (let i = 0; i < ks.length - 1; i++) { if (typeof o[ks[i]] !== 'object' || o[ks[i]] === null) o[ks[i]] = {}; o = o[ks[i]]; }
    o[ks[ks.length - 1]] = v;
  };
  const delP = (p) => {
    const ks = String(p).split('/').filter(Boolean);
    let o = store;
    for (let i = 0; i < ks.length - 1; i++) { o = o[ks[i]]; if (!o) return; }
    delete o[ks[ks.length - 1]];
  };
  const snapOf = (v) => {
    const vv = (v === undefined) ? null : JSON.parse(JSON.stringify(v));
    return {
      val: () => vv,
      exists: () => vv !== null,
      forEach: (cb) => { if (vv && typeof vv === 'object') Object.keys(vv).forEach((k) => cb({ key: k, val: () => vv[k] })); return false; }
    };
  };
  function ref(base) {
    const B = base || '';
    const r = {
      _path: B,
      once: async () => snapOf(get(B)),
      set: async (v) => { writes.push({ op: 'set', path: B }); setP(B, JSON.parse(JSON.stringify(v))); },
      remove: async () => { writes.push({ op: 'remove', path: B }); delP(B); },
      update: async (map) => {
        Object.keys(map).forEach((k) => {
          const p = B ? B + '/' + k : k;
          const v = map[k];
          writes.push({ op: 'update', path: p });
          if (v === null || v === undefined) delP(p); else setP(p, JSON.parse(JSON.stringify(v)));
        });
      },
      transactionBlind: async (fn) => {
        writes.push({ op: 'transactionBlind', path: B });
        const cur = get(B);
        const nv = fn(cur === undefined ? null : JSON.parse(JSON.stringify(cur)));
        if (nv !== undefined) setP(B, JSON.parse(JSON.stringify(nv)));
        return { committed: true };
      },
      orderByChild: (k) => ({
        equalTo: (val) => ({
          once: async () => {
            const all = get(B) || {};
            const match = {};
            Object.keys(all).forEach((ck) => { if (all[ck] && all[ck][k] === val) match[ck] = all[ck]; });
            return snapOf(match);
          }
        })
      }),
      push: (val) => {
        const key = 'k' + (++pushSeq) + Math.random().toString(36).slice(2, 6);
        const full = B ? B + '/' + key : key;
        writes.push({ op: 'push', path: full });
        if (val !== undefined) { writes.push({ op: 'push.set', path: full }); setP(full, JSON.parse(JSON.stringify(val))); }
        const rr = ref(full);
        rr.key = key;
        return rr;
      },
      pushAsync: async (val) => {
        writes.push({ op: 'pushAsync', path: B });
        return r.push(val);
      }
    };
    return r;
  }
  return { store, writes, ref, database: () => ({ ref }) };
}

function makeCtx(uid) {
  const steps = [];
  return {
    user: uid ? { uid } : null,
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    stepStart: (label) => { const id = steps.length + 1; steps.push({ id, label, done: false }); return id; },
    stepUpdate: (id, patch) => { const st = steps.find((x) => x.id === id); if (st) Object.assign(st, patch); },
    stepDone: (id) => { const st = steps.find((x) => x.id === id); if (st) st.done = true; },
    _steps: steps
  };
}

function loadBlock(opts) {
  opts = opts || {};
  const registered = {};
  const said = [];
  const confirms = [];
  const seenFiles = [];
  const sandbox = {
    console,
    module: { exports: {} },
    APP_ENGLISH_TEXT: {}, APP_CHINESE_TEXT: {}, APP_PORTUGUESE_TEXT: {},
    baroRegisterTool: function (name, def) { registered[name] = def; },
    BARO_ICONS: {},
    baroIntentRules: [],
    baroIntentToTool: {},
    baroAddBaroMessage: function (html) { said.push(String(html)); },
    baroAskConfirm: function (o) { confirms.push(o); return {}; },
    baroTakePendingPhoto: opts.takePhoto || (() => null),
    processImageFile: opts.processImage || (async (f) => { seenFiles.push(f); return 'data:image/jpeg;base64,PROCESSED'; }),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    Blob, File,
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise, Uint8Array,
    setTimeout, clearTimeout
  };
  if (opts.noConfirm) delete sandbox.baroAskConfirm;
  if (opts.drexCloud !== undefined) sandbox.DrexCloud = opts.drexCloud;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: '8K-snippet.js' });
  return { M: sandbox.module.exports, registered, said, confirms, seenFiles, sandbox };
}

/* ---------- 1. registro exacto ---------- */
tcase('registro: 4 herramientas con label i18n', () => {
  const { M, registered } = loadBlock({ drexCloud: makeDb() });
  assert(M && M.pure && M.tools && M.BARO_I18N_K && M.BARO_ICONS_K && M.BARO_K_RULES, 'exports incompletos');
  eqJ(Object.keys(registered).sort(), ['musica_mis_subidas', 'musica_subir', 'perfil_foto', 'perfil_portada'], 'nombres registrados');
  eqJ(Object.keys(M.tools).sort(), ['musica_mis_subidas', 'musica_subir', 'perfil_foto', 'perfil_portada'], 'tools exportadas');
  Object.keys(registered).forEach((n) => {
    assert(typeof registered[n].run === 'function', 'run de ' + n);
    const lk = registered[n].label;
    const entry = M.BARO_I18N_K[lk];
    assert(entry && entry.es && entry.en && entry.zh && entry.pt, 'label i18n 4 idiomas: ' + lk);
  });
});

/* ---------- 2. iconos ---------- */
tcase('iconos SVG propios indigo sin emoji', () => {
  const { M, sandbox } = loadBlock({ drexCloud: makeDb() });
  const want = ['perfil-foto', 'perfil-portada', 'musica-subir', 'musica-mis-subidas'];
  want.forEach((k) => {
    const svg = M.BARO_ICONS_K[k];
    assert(typeof svg === 'string' && svg.indexOf('<svg viewBox="0 0 24 24"') === 0, 'svg ' + k);
    assert(svg.indexOf('currentColor') !== -1, 'currentColor en ' + k);
    assert(svg.indexOf('#2F33B8') !== -1, 'indigo en ' + k);
    assert(svg.trim().endsWith('</svg>'), 'cierre svg ' + k);
    assert(!/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF]/u.test(svg), 'sin emoji en ' + k);
    assert(sandbox.BARO_ICONS[k] === svg, 'fusionado en BARO_ICONS: ' + k);
  });
});

/* ---------- 3. reglas + extracts puros en 4 idiomas ---------- */
tcase('reglas del router: 4 intents con langs y patrones', () => {
  const { M, sandbox } = loadBlock({ drexCloud: makeDb() });
  eqJ(M.BARO_K_RULES.map((r) => r.intent), ['perfil_portada', 'perfil_foto', 'musica_subir', 'musica_mis_subidas'], 'orden de reglas');
  M.BARO_K_RULES.forEach((r) => {
    eqJ(r.langs, ['es', 'en', 'zh', 'pt'], 'langs de ' + r.intent);
    assert(r.patterns.length >= 6, 'patrones de ' + r.intent);
    r.patterns.forEach((p) => assert(Object.prototype.toString.call(p) === '[object RegExp]', 'patron RegExp en ' + r.intent));
    assert(typeof r.extract === 'function', 'extract de ' + r.intent);
  });
  eqJ(sandbox.baroIntentRules.map((r) => r.intent),
    ['perfil_portada', 'perfil_foto', 'musica_subir', 'musica_mis_subidas'], 'reglas fusionadas');
  eqJ(sandbox.baroIntentToTool.perfil_foto, 'perfil_foto', 'map perfil_foto');
  eqJ(sandbox.baroIntentToTool.perfil_portada, 'perfil_portada', 'map perfil_portada');
  eqJ(sandbox.baroIntentToTool.musica_subir, 'musica_subir', 'map musica_subir');
  eqJ(sandbox.baroIntentToTool.musica_mis_subidas, 'musica_mis_subidas', 'map musica_mis_subidas');
});

tcase('extracts: foto en 4 idiomas + declina portada', () => {
  const { M } = loadBlock({ drexCloud: makeDb() });
  const ex = M.BARO_K_RULES[1].extract;
  assert(ex('cambia mi foto de perfil'), 'es');
  assert(ex('change my profile photo'), 'en');
  assert(ex('换头像'), 'zh');
  assert(ex('trocar minha foto de perfil'), 'pt');
  assert(ex('cambia mi portada') === null, 'declina portada es');
  assert(ex('change my cover photo') === null, 'declina portada en');
  assert(ex('换封面') === null, 'declina portada zh');
  assert(ex('trocar minha capa') === null, 'declina portada pt');
  assert(ex('cuántos usuarios hay') === null, 'declina ruido');
});

tcase('extracts: portada en 4 idiomas + declina foto', () => {
  const { M } = loadBlock({ drexCloud: makeDb() });
  const ex = M.BARO_K_RULES[0].extract;
  assert(ex('cambia mi portada'), 'es');
  assert(ex('change my cover photo'), 'en');
  assert(ex('换封面'), 'zh');
  assert(ex('trocar minha capa'), 'pt');
  assert(ex('cambia mi foto de perfil') === null, 'declina foto es');
  assert(ex('change my profile photo') === null, 'declina foto en');
});

tcase('extracts: subir en 4 idiomas + declina consulta y publicar simple', () => {
  const { M } = loadBlock({ drexCloud: makeDb() });
  const ex = M.BARO_K_RULES[2].extract;
  assert(ex('sube mi canción'), 'es');
  assert(ex('upload my song'), 'en');
  assert(ex('上传歌曲'), 'zh');
  assert(ex('subir minha música'), 'pt');
  const withTitle = ex('sube mi canción «Mi Tema»');
  assert(withTitle && withTitle.titulo === 'Mi Tema', 'titulo entrecomillado');
  assert(ex('publica mi canción') !== null, 'publica mi cancion es subida');
  assert(ex('muéstrame mis canciones subidas') === null, 'declina mis subidas');
  assert(ex('publica este texto') === null, 'declina publicar simple');
  assert(ex('vota esta canción') === null, 'no roba votacion');
});

tcase('extracts: mis subidas en 4 idiomas + declina subida', () => {
  const { M } = loadBlock({ drexCloud: makeDb() });
  const ex = M.BARO_K_RULES[3].extract;
  assert(ex('muéstrame mis canciones subidas'), 'es');
  assert(ex('my uploaded songs'), 'en');
  assert(ex('我上传的歌曲'), 'zh');
  assert(ex('minhas músicas'), 'pt');
  assert(ex('sube mi canción') === null, 'declina subida es');
  assert(ex('upload my song') === null, 'declina subida en');
});

/* ---------- 4. i18n completo ---------- */
tcase('i18n: todas las claves en 4 idiomas no vacios', () => {
  const { M, sandbox } = loadBlock({ drexCloud: makeDb() });
  const keys = Object.keys(M.BARO_I18N_K);
  assert(keys.length >= 40, 'claves i18n >= 40, hay ' + keys.length);
  keys.forEach((k) => {
    assert(k.indexOf('baro.tool.perfil.') === 0 || k.indexOf('baro.tool.musica.') === 0, 'prefijo de ' + k);
    ['es', 'en', 'zh', 'pt'].forEach((l) => {
      const v = M.BARO_I18N_K[k][l];
      assert(typeof v === 'string' && v.length > 0, k + ' sin ' + l);
    });
  });
  let diffs = 0;
  keys.forEach((k) => { if (M.BARO_I18N_K[k].en !== M.BARO_I18N_K[k].es) diffs++; });
  assert(diffs > keys.length / 2, 'EN debe diferir de ES en la mayoria');
  assert(sandbox.APP_ENGLISH_TEXT['baro.tool.perfil.foto.label'] === M.BARO_I18N_K['baro.tool.perfil.foto.label'].en, 'fusion APP_ENGLISH_TEXT');
  assert(sandbox.APP_CHINESE_TEXT['baro.tool.musica.subir.label'] === M.BARO_I18N_K['baro.tool.musica.subir.label'].zh, 'fusion APP_CHINESE_TEXT');
  assert(sandbox.APP_PORTUGUESE_TEXT['baro.tool.musica.mias.label'] === M.BARO_I18N_K['baro.tool.musica.mias.label'].pt, 'fusion APP_PORTUGUESE_TEXT');
});

/* ---------- 5. funciones puras ---------- */
tcase('puras: audio/imagen/bytes/chunks/genero/titulo/mime', () => {
  const { M } = loadBlock({ drexCloud: makeDb() });
  const p = M.pure;
  assert(p.isAudioDataUrl(AUD1), 'audio mp3');
  assert(p.isAudioDataUrl('data:audio/ogg;base64,AAAA'), 'audio ogg');
  assert(!p.isAudioDataUrl(PNG1), 'png no es audio');
  assert(!p.isAudioDataUrl('hola'), 'ruido no es audio');
  assert(p.isImageDataUrl(PNG1), 'png es imagen');
  assert(!p.isImageDataUrl(AUD1), 'audio no es imagen');
  assert(!p.isImageDataUrl('data:image/png;base64,***'), 'base64 roto no es imagen');
  eqJ(p.audioBytes('data:audio/mpeg;base64,' + 'A'.repeat(1000)), 750, 'bytes base64');
  eqJ(p.audioBytes('nada'), 0, 'bytes sin coma');
  const ch = p.chunkString('abcdefghij', 4);
  eqJ(ch, ['abcd', 'efgh', 'ij'], 'chunks');
  eqJ(p.chunkString('', 4), [], 'chunks vacio');
  eqJ(p.genre('rock'), 'Rock', 'genero canonico');
  eqJ(p.genre('Techno'), 'Pop', 'genero desconocido -> Pop');
  eqJ(p.genre(''), 'Pop', 'genero vacio -> Pop');
  eqJ(p.quotedTitle('sube mi canción «Mi Tema»'), 'Mi Tema', 'titulo «»');
  eqJ(p.quotedTitle('upload "My Song"'), 'My Song', 'titulo ""');
  eqJ(p.quotedTitle('sin titulo'), null, 'sin titulo');
  eqJ(p.mime(AUD1), 'audio/mpeg', 'mime');
  eqJ(p.MAX_AUDIO, 15 * 1024 * 1024, 'limite 15MB');
  eqJ(p.DAILY_LIMIT, 2, 'limite diario 2');
});

/* ---------- 6-10. perfil_foto ---------- */
tcase('perfil_foto sin foto: pide adjuntar, cero escrituras', async () => {
  const db = makeDb();
  const { M, said, confirms } = loadBlock({ drexCloud: db });
  const r = await M.tools.perfil_foto({}, makeCtx('me1'));
  assert(r.html.indexOf(M.BARO_I18N_K['baro.tool.perfil.foto.sin_foto'].es) !== -1, 'mensaje sin_foto');
  eqJ(db.writes.length, 0, 'cero escrituras');
  eqJ(confirms.length, 0, 'sin confirmacion');
  eqJ(said.length, 0, 'nada dicho aun');
});

tcase('perfil_foto mala imagen: cero escrituras', async () => {
  const db = makeDb();
  const { M } = loadBlock({ drexCloud: db });
  const r = await M.tools.perfil_foto({ foto: 'not-a-data-url' }, makeCtx('me1'));
  assert(r.html.indexOf(M.BARO_I18N_K['baro.tool.perfil.foto.mala_foto'].es) !== -1, 'mensaje mala_foto');
  eqJ(db.writes.length, 0, 'cero escrituras');
});

tcase('perfil_foto: preview + confirmacion, escribe solo al confirmar', async () => {
  const db = makeDb();
  const seen = [];
  const { M, said, confirms } = loadBlock({
    drexCloud: db,
    processImage: async (f) => { seen.push(f); return 'data:image/jpeg;base64,PROCESSED'; }
  });
  const r = await M.tools.perfil_foto({ foto: PNG1 }, makeCtx('me1'));
  assert(r.html.indexOf('<img') !== -1, 'preview con img');
  assert(r.html.indexOf(M.BARO_I18N_K['baro.tool.perfil.foto.revisar'].es) !== -1, 'cta revisar');
  eqJ(confirms.length, 1, 'una confirmacion');
  eqJ(confirms[0].danger, false, 'no es peligrosa');
  assert(confirms[0].previewHtml.indexOf('<img') !== -1, 'preview en confirm');
  eqJ(db.writes.length, 0, 'cero escrituras antes de confirmar');
  await confirms[0].onConfirm();
  eqJ(seen.length, 1, 'processImageFile llamado');
  assert(seen[0] instanceof File || seen[0] instanceof Blob, 'convierte a File/Blob, no data URL cruda');
  const w = db.writes.find((x) => x.path === 'users/me1/profileImage');
  assert(w, 'escribe profileImage');
  eqJ(db.store.users.me1.profileImage, 'data:image/jpeg;base64,PROCESSED', 'valor procesado');
  assert(said.some((h) => h.indexOf(M.BARO_I18N_K['baro.tool.perfil.foto.ok'].es) !== -1), 'mensaje ok');
});

tcase('perfil_foto: puente baroTakePendingPhoto del turno', async () => {
  const db = makeDb();
  const env = loadBlock({ drexCloud: db, takePhoto: () => PNG1 });
  env.sandbox.baroTakePendingPhoto();
  const r = await env.M.tools.perfil_foto({}, makeCtx('me1'));
  eqJ(env.confirms.length, 1, 'usa la foto del turno sin args.foto');
  assert(env.sandbox.__baroKLastPhoto === null, 'la foto del turno se consume');
  await env.confirms[0].onConfirm();
  eqJ(db.store.users.me1.profileImage, 'data:image/jpeg;base64,PROCESSED', 'escribe profileImage del puente');
});

tcase('perfil_foto: foto stale del turno se ignora', async () => {
  const db = makeDb();
  const env = loadBlock({ drexCloud: db });
  env.sandbox.__baroKLastPhoto = { foto: PNG1, at: Date.now() - 60000 };
  const r = await env.M.tools.perfil_foto({}, makeCtx('me1'));
  assert(r.html.indexOf(env.M.BARO_I18N_K['baro.tool.perfil.foto.sin_foto'].es) !== -1, 'stale -> sin_foto');
  eqJ(env.confirms.length, 0, 'sin confirmacion');
});

/* ---------- 11-12. perfil_portada ---------- */
tcase('perfil_portada sin foto: pide adjuntar, cero escrituras', async () => {
  const db = makeDb();
  const { M, confirms } = loadBlock({ drexCloud: db });
  const r = await M.tools.perfil_portada({}, makeCtx('me1'));
  assert(r.html.indexOf(M.BARO_I18N_K['baro.tool.perfil.portada.sin_foto'].es) !== -1, 'mensaje sin_foto');
  eqJ(db.writes.length, 0, 'cero escrituras');
  eqJ(confirms.length, 0, 'sin confirmacion');
});

tcase('perfil_portada: confirmacion escribe coverPhoto', async () => {
  const db = makeDb();
  const { M, said, confirms } = loadBlock({ drexCloud: db });
  await M.tools.perfil_portada({ foto: PNG1 }, makeCtx('me1'));
  eqJ(confirms.length, 1, 'una confirmacion');
  eqJ(confirms[0].danger, false, 'no es peligrosa');
  eqJ(db.writes.length, 0, 'cero escrituras antes de confirmar');
  await confirms[0].onConfirm();
  eqJ(db.store.users.me1.coverPhoto, 'data:image/jpeg;base64,PROCESSED', 'escribe coverPhoto');
  assert(!db.store.users.me1.profileImage, 'no toca profileImage');
  assert(said.some((h) => h.indexOf(M.BARO_I18N_K['baro.tool.perfil.portada.ok'].es) !== -1), 'mensaje ok');
});

/* ---------- 13. sin sesion: las 4, cero escrituras ---------- */
tcase('sin sesion: las 4 herramientas honestas, cero escrituras', async () => {
  const db = makeDb();
  const { M, confirms, said } = loadBlock({ drexCloud: db });
  for (const n of ['perfil_foto', 'perfil_portada', 'musica_subir', 'musica_mis_subidas']) {
    const r = await M.tools[n]({ foto: PNG1, audio: AUD1, titulo: 'X' }, makeCtx(null));
    assert(r.html.indexOf('Inicia sesi') !== -1, n + ' pide login');
  }
  eqJ(db.writes.length, 0, 'cero escrituras');
  eqJ(confirms.length, 0, 'sin confirmaciones');
  eqJ(said.length, 0, 'nada dicho');
});

/* ---------- 14. confirmacion no disponible ---------- */
tcase('sin baroAskConfirm: mensaje honesto, cero escrituras', async () => {
  const db = makeDb();
  const { M } = loadBlock({ drexCloud: db, noConfirm: true });
  const r = await M.tools.perfil_foto({ foto: PNG1 }, makeCtx('me1'));
  assert(r.html.indexOf(M.BARO_I18N_K['baro.tool.perfil.confirm_unavailable'].es) !== -1, 'confirm_unavailable');
  eqJ(db.writes.length, 0, 'cero escrituras');
});

/* ---------- 15-20. musica_subir ---------- */
function __ymd() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
tcase('musica_subir sin audio: hueco honesto, cero escrituras', async () => {
  const db = makeDb();
  const { M, confirms } = loadBlock({ drexCloud: db });
  const r = await M.tools.musica_subir({ titulo: 'X' }, makeCtx('me1'));
  assert(r.html.indexOf(M.BARO_I18N_K['baro.tool.musica.subir.sin_audio'].es) !== -1, 'mensaje sin_audio honesto');
  eqJ(db.writes.length, 0, 'cero escrituras');
  eqJ(confirms.length, 0, 'sin confirmacion');
  assert(!db.store.communityNotes, 'no crea anuncio falso');
  assert(!db.store.musicTracks, 'no crea track falso');
});

tcase('musica_subir sin terminos: cero escrituras', async () => {
  const db = makeDb({ users: { me1: { username: 'art1' } } });
  const { M, confirms } = loadBlock({ drexCloud: db });
  const r = await M.tools.musica_subir({ audio: AUD1, titulo: 'T' }, makeCtx('me1'));
  assert(r.html.indexOf(M.BARO_I18N_K['baro.tool.musica.subir.sin_terminos'].es) !== -1, 'mensaje sin_terminos');
  eqJ(db.writes.length, 0, 'cero escrituras');
  eqJ(confirms.length, 0, 'sin confirmacion');
});

tcase('musica_subir sin titulo: pide titulo, cero escrituras', async () => {
  const db = makeDb({ users: { me1: { username: 'art1', musicTermsAccepted: true } } });
  const { M, confirms } = loadBlock({ drexCloud: db });
  const r = await M.tools.musica_subir({ audio: AUD1, rawText: 'sube mi cancion' }, makeCtx('me1'));
  assert(r.html.indexOf(M.BARO_I18N_K['baro.tool.musica.subir.sin_titulo'].es) !== -1, 'mensaje sin_titulo');
  eqJ(db.writes.length, 0, 'cero escrituras');
  eqJ(confirms.length, 0, 'sin confirmacion');
});

tcase('musica_subir limite diario: cero escrituras', async () => {
  const seed = { users: { me1: { username: 'art1', musicTermsAccepted: true } } };
  seed.musicDailyCount = { me1: {} };
  seed.musicDailyCount.me1[__ymd()] = 2;
  const db = makeDb(seed);
  const { M, confirms } = loadBlock({ drexCloud: db });
  const r = await M.tools.musica_subir({ audio: AUD1, titulo: 'T' }, makeCtx('me1'));
  assert(r.html.indexOf(M.BARO_I18N_K['baro.tool.musica.subir.limite'].es) !== -1, 'mensaje limite');
  eqJ(db.writes.length, 0, 'cero escrituras');
  eqJ(confirms.length, 0, 'sin confirmacion');
});

tcase('musica_subir audio gigante: cero escrituras', async () => {
  const db = makeDb({ users: { me1: { username: 'art1', musicTermsAccepted: true } } });
  const { M, confirms } = loadBlock({ drexCloud: db });
  const big = 'data:audio/mpeg;base64,' + 'A'.repeat(21000000);
  const r = await M.tools.musica_subir({ audio: big, titulo: 'T' }, makeCtx('me1'));
  assert(r.html.indexOf(M.BARO_I18N_K['baro.tool.musica.subir.muy_grande'].es) !== -1, 'mensaje muy_grande');
  eqJ(db.writes.length, 0, 'cero escrituras');
});

tcase('musica_subir feliz: confirmacion y nodos reales', async () => {
  const db = makeDb({ users: { me1: { username: 'art1', musicTermsAccepted: true } } });
  const { M, said, confirms } = loadBlock({ drexCloud: db });
  const r = await M.tools.musica_subir({ audio: AUD1, titulo: 'Mi Tema', artista: 'art1', genero: 'rock', duracion: 42 }, makeCtx('me1'));
  assert(r.html.indexOf('Mi Tema') !== -1, 'tarjeta con titulo');
  eqJ(confirms.length, 1, 'una confirmacion');
  eqJ(confirms[0].danger, false, 'no es peligrosa');
  assert(confirms[0].title.indexOf('Mi Tema') !== -1, 'titulo en confirm');
  eqJ(db.writes.length, 0, 'cero escrituras antes de confirmar');
  await confirms[0].onConfirm();
  const tracks = db.store.musicTracks || {};
  const tk = Object.keys(tracks);
  eqJ(tk.length, 1, 'un track');
  const meta = tracks[tk[0]];
  eqJ(meta.title, 'Mi Tema', 'titulo');
  eqJ(meta.authorId, 'me1', 'autor');
  eqJ(meta.genre, 'Rock', 'genero canonico');
  eqJ(meta.duration, 42, 'duracion');
  eqJ(meta.searchTitle, 'mi tema', 'indice de busqueda');
  eqJ(meta.mimeType, 'audio/mpeg', 'mime');
  const audioNodes = db.store.musicAudio || {};
  const ak = Object.keys(audioNodes);
  eqJ(ak.length, 1, 'un nodo de audio');
  assert(audioNodes[ak[0]].chunk_00000, 'chunk_00000 existe');
  assert(db.store.musicByAuthor && db.store.musicByAuthor.me1 && db.store.musicByAuthor.me1[tk[0]] === true, 'indice musicByAuthor');
  assert(db.store.musicSearch && db.store.musicSearch[tk[0]], 'indice musicSearch');
  eqJ(db.store.musicDailyCount.me1[__ymd()], 1, 'contador diario');
  const notes = db.store.communityNotes || {};
  const nk = Object.keys(notes);
  eqJ(nk.length, 1, 'un anuncio');
  eqJ(notes[nk[0]].kind, 'music', 'kind music (forma real de publishMusic)');
  eqJ(notes[nk[0]].trackId, tk[0], 'anuncio enlaza al track');
  eqJ(notes[nk[0]].musicTitle, 'Mi Tema', 'titulo de musica');
  eqJ(meta.announceNoteId, nk[0], 'track enlaza al anuncio');
  assert(db.store.notesByAuthor && db.store.notesByAuthor.me1 && typeof db.store.notesByAuthor.me1[nk[0]].t === 'number', 'indice notesByAuthor con timestamp');
  assert(said.some((h) => h.indexOf('Mi Tema') !== -1 && h.indexOf('ya está en tu música') !== -1), 'mensaje ok');
});

/* ---------- 21-22. musica_mis_subidas ---------- */
tcase('musica_mis_subidas: cuenta y lista reales', async () => {
  const db = makeDb({
    musicTracks: {
      t1: { title: 'Uno', artistName: 'art1', authorId: 'me1', plays: 5, createdAt: 100 },
      t2: { title: 'Dos', artistName: 'art1', authorId: 'me1', plays: 7, createdAt: 200 },
      t3: { title: 'Ajeno', artistName: 'otro', authorId: 'zz9', plays: 9, createdAt: 300 }
    }
  });
  const { M } = loadBlock({ drexCloud: db });
  const r = await M.tools.musica_mis_subidas({}, makeCtx('me1'));
  assert(r.html.indexOf('Mis canciones (2)') !== -1, 'conteo real 2');
  assert(r.html.indexOf('Uno') !== -1 && r.html.indexOf('Dos') !== -1, 'lista titulos');
  assert(r.html.indexOf('Ajeno') === -1, 'no lista ajenas');
  assert(r.html.indexOf('7') !== -1, 'muestra reproducciones');
  eqJ(db.writes.length, 0, 'cero escrituras (lectura)');
});

tcase('musica_mis_subidas vacia: estado honesto', async () => {
  const db = makeDb({ musicTracks: { t3: { title: 'Ajeno', authorId: 'zz9' } } });
  const { M } = loadBlock({ drexCloud: db });
  const r = await M.tools.musica_mis_subidas({}, makeCtx('me1'));
  assert(r.html.indexOf(M.BARO_I18N_K['baro.tool.musica.mias.vacia'].es) !== -1, 'estado vacio honesto');
  eqJ(db.writes.length, 0, 'cero escrituras');
});

/* ---------- runner ---------- */
(async () => {
  for (const [name, fn] of CASES) {
    try { await fn(); oks++; console.log('ok   - ' + name); }
    catch (err) { fails++; console.log('FAIL - ' + name + ' :: ' + (err && err.message)); }
  }
  console.log('\n' + oks + ' ok, ' + fails + ' fallos de ' + CASES.length + ' casos');
  process.exit(fails ? 1 : 0);
})();
