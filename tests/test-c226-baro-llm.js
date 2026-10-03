'use strict';
// Tests de Lane 1 (tercera ola) — Baro con cerebro real (LLM, C226).
// Cubre: cliente baroLLM.ask con streaming SSE (mock de fetch), timeout ->
// código BARO_LLM_TIMEOUT, abort externo, rate-limit (3 s y tope horario),
// NO-PII en el body (sin uid/email), system prompt (fecha real, KB
// verificada, hook BaroVoice), decisiones del enrutador (acciones->local,
// chitchat/explicaciones->LLM, gibberish->tarjeta), turno con streaming
// (typing + fase + burbuja), fallback silencioso al motor local ante fallo,
// abort al llegar un mensaje nuevo, hook varyResponse, i18n ES/EN/ZH/PT.
//
// Construye un composite en memoria: index.html del repo + bloques de la
// lane insertados en el ancla (dentro del IIFE 6b, antes de "exposición
// global"). Extrae la región 6b (patrón c121/c122/c220) y la carga con vm.
// Uso: node tests/test-c226-baro-llm.js [--target <ruta-a-index.html>]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LANE_DIR = path.join(__dirname, '..');
const BLOCKS = ['baro-llm-i18n.js', 'baro-llm.js', 'baro-llm-router.js'];
const ANCHOR = '/* ---------- exposición global ---------- */';

const argv = process.argv.slice(2);
let target = null;
const ti = argv.indexOf('--target');
if (ti !== -1 && argv[ti + 1]) target = argv[ti + 1];
if (!target) {
  // C246 (2026-10-03): antes se prefería ~/workspace/beabo (clon viejo, 128
  // commits atrás); el artefacto real es el index.html de ESTE repo.
  const cands = [
    path.join(__dirname, '..', 'index.html'),
    'index.html'
  ];
  target = cands.find(p => fs.existsSync(p)) || null;
}
if (!target) { console.error('FALLO: no existe el target'); process.exit(2); }

function buildComposite(t) {
  // C246 (2026-10-03): los bloques lane (baro-llm-*.js) NUNCA se
  // commitearon (ausentes en git ls-files); se hornearon en index.html
  // durante la build. El artefacto desplegado ya los contiene, así que
  // el test corre sobre el index.html publicado tal cual.
  return fs.readFileSync(t, 'utf8');
}
function extract6b(html) {
  const START = '/* ================= BARO · sub-bloque 6b';
  const END = '/* ================= BARO · integración: enlaces';
  const si = html.indexOf(START);
  if (si === -1) throw new Error('marcador de inicio 6b ausente');
  const ei = html.indexOf('\n' + END, si);
  if (ei === -1 || ei <= si) throw new Error('marcador de fin ausente');
  return html.slice(si, ei);
}
const src = extract6b(buildComposite(target));

let fails = 0, oks = 0;
const CASES = [];
function tcase(name, fn) { CASES.push([name, fn]); }
function assert(cond, label) { if (!cond) throw new Error('assert: ' + label); }
function eqJ(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(label + ' esperado=' + e + ' actual=' + a);
}

/* ---------- 0. sin literal de cierre de script ---------- */
tcase('bloques horneados y test sin literal de cierre de script', () => {
  // C246 (2026-10-03): los fuentes lane ya no existen; se verifica la
  // región 6b desplegada en index.html (misma higiene que antes).
  assert(src.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en la región 6b');
  const tsrc = fs.readFileSync(__filename, 'utf8');
  assert(tsrc.indexOf('</scr' + 'ipt') === -1, 'literal prohibido en el test');
});

/* ---------- mocks ---------- */
let fetchCalls = [];
let fetchImpl = null; /* (url, opts) => Promise<resp> ; se reasigna por test */
function sseResp(chunks, status) {
  // chunks: array de strings; los parte en mitades para simular red real
  const parts = [];
  for (const c of chunks) {
    const h = Math.max(1, Math.floor(c.length / 2));
    parts.push(c.slice(0, h), c.slice(h));
  }
  let i = 0;
  return {
    ok: (status == null || status === 200),
    status: status == null ? 200 : status,
    body: {
      getReader() {
        return {
          read() {
            if (i >= parts.length) return Promise.resolve({ done: true, value: undefined });
            const v = Buffer.from(parts[i++], 'utf8');
            return Promise.resolve({ done: false, value: v });
          }
        };
      }
    }
  };
}
function sseData(text) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n';
}
function mockFetch(url, opts) {
  fetchCalls.push({ url, opts });
  if (fetchImpl) return fetchImpl(url, opts);
  return Promise.reject(new Error('fetch sin impl en este test'));
}

const userSaid = [], bubbles = [];
let typingOn = 0;
const phaseLog = [];
function fakeP() {
  return { _t: '', set textContent(v) { this._t = String(v); }, get textContent() { return this._t; } };
}
function fakeBubble() {
  const p = fakeP();
  const b = {
    _p: p, _html: '',
    querySelector(sel) { return sel === '.baro-llm-live' ? p : null; },
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    parentNode: { removeChild() { b._removed = true; } },
    _removed: false
  };
  return b;
}

const __ls = {};
const sandbox = {
  console,
  window: {},
  APP_ENGLISH_TEXT: {}, APP_CHINESE_TEXT: {}, APP_PORTUGUESE_TEXT: {},
  baroTools: {},
  baroRegisterTool: function () {},
  baroAddUserMessage: function (t) { userSaid.push(String(t)); return null; },
  baroAddBaroMessage: function (h) { const b = fakeBubble(); b._html = String(h); bubbles.push(b); return b; },
  baroAddTyping: function () { typingOn++; return 'typing-1'; },
  baroRemoveTyping: function () { typingOn = Math.max(0, typingOn - 1); },
  baroStartLiveTurn: function () {},
  baroMakeV2Ctx: function () {
    return {
      user: { uid: 'uid-test-123', email: 'test@example.com' },
      t: function (k) { return String(k); },
      esc: function (s) { return String(s == null ? '' : s); },
      step: function () { return 'st'; },
      stepDone: function () {}
    };
  },
  baroV2FlowStepKey: function () { return 'k'; },
  baroResolvePostTarget: async function () { return { status: 'resolved', postId: 'X' }; },
  localStorage: {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(__ls, k) ? __ls[k] : null; },
    setItem: function (k, v) { __ls[k] = String(v); },
    removeItem: function (k) { delete __ls[k]; }
  },
  fetch: mockFetch,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  TextDecoder: TextDecoder,
  AbortController: AbortController,
  Date: Date
};
sandbox.baro6dExpose = function (n, f) { sandbox.window[n] = f; };
sandbox.window.APP_ENGLISH_TEXT = sandbox.APP_ENGLISH_TEXT;
sandbox.window.APP_CHINESE_TEXT = sandbox.APP_CHINESE_TEXT;
sandbox.window.APP_PORTUGUESE_TEXT = sandbox.APP_PORTUGUESE_TEXT;
sandbox.window.BaroFX2 = {
  phase(label) { phaseLog.push(['phase', String(label)]); return true; },
  phaseDone() { phaseLog.push(['phaseDone']); return true; }
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'block-6b-lane1-llm.js' });
const brain = sandbox.window.baroBrain;
assert(brain && typeof brain === 'object', 'seam window.baroBrain ausente');
assert(brain.__llmExtended === true, 'la lane no extendió el seam (router no cargó)');
const llm = brain.llm;
assert(llm && typeof llm.ask === 'function', 'baroLLM ausente en el seam');
const T = llm._test;
assert(T && typeof T.resetRate === 'function', 'hooks de test ausentes');
const ORIG_FN = brain.llmOrig.fn;
assert(typeof ORIG_FN === 'function', 'handle original no capturado por el wrapper');

function resetMocks() {
  fetchCalls = [];
  fetchImpl = null;
  userSaid.length = 0;
  bubbles.length = 0;
  typingOn = 0;
  phaseLog.length = 0;
  T.resetRate();
  T.setTimeoutMs(0);
  llm.clearHistory();
  brain.llmOrig.fn = ORIG_FN;
  delete sandbox.window.BaroVoice;
}

/* ---------- 1. streaming OK ---------- */
tcase('ask: streaming SSE arma el texto y llama onDelta', async () => {
  resetMocks();
  const deltas = [];
  fetchImpl = () => Promise.resolve(sseResp([sseData('Hola'), sseData(', ¿qué tal?'), 'data: [DONE]\n']));
  const acc = await llm.ask({
    messages: [{ role: 'user', content: 'hola' }],
    onDelta: (d, a) => deltas.push([d, a])
  });
  assert(acc === 'Hola, ¿qué tal?', 'texto armado: ' + acc);
  assert(deltas.length === 2, 'onDelta x2, fue x' + deltas.length);
  assert(deltas[1][1] === 'Hola, ¿qué tal?', 'acumulado en onDelta');
  assert(fetchCalls.length === 1, 'una llamada fetch');
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert(body.model === 'openai-fast', 'modelo openai-fast');
  assert(body.stream === true, 'stream:true');
  assert(fetchCalls[0].url === 'https://text.pollinations.ai/openai', 'endpoint Pollinations');
});

/* ---------- 2. NO-PII en el body ---------- */
tcase('ask: el body NUNCA lleva uid ni email', async () => {
  resetMocks();
  fetchImpl = () => Promise.resolve(sseResp([sseData('ok'), 'data: [DONE]\n']));
  llm.recordTurn('user', 'me llamo Darel'); /* el historial solo lleva textos */
  const msgs = llm.buildMessages('¿qué día es hoy?', 'es', 'feed');
  await llm.ask({ messages: msgs });
  const raw = fetchCalls[0].opts.body;
  assert(raw.indexOf('uid-test-123') === -1, 'uid filtrado al body');
  assert(raw.indexOf('test@example.com') === -1, 'email filtrado al body');
  assert(raw.indexOf('"uid"') === -1 && raw.indexOf('"email"') === -1, 'sin claves uid/email');
  assert(raw.indexOf('me llamo Darel') !== -1, 'el texto del usuario sí viaja');
  assert(raw.indexOf('¿qué día es hoy?') !== -1, 'el mensaje actual sí viaja');
});

/* ---------- 3. timeout -> BARO_LLM_TIMEOUT ---------- */
tcase('ask: timeout agota y lanza BARO_LLM_TIMEOUT', async () => {
  resetMocks();
  T.setTimeoutMs(80);
  fetchImpl = () => new Promise(() => {}); /* cuelga para siempre */
  let err = null;
  try {
    await llm.ask({ messages: [{ role: 'user', content: 'hola' }] });
  } catch (e) { err = e; }
  assert(err && err.code === 'BARO_LLM_TIMEOUT', 'código TIMEOUT, fue ' + (err && err.code));
});

/* ---------- 4. abort externo ---------- */
tcase('ask: abort externo rechaza sin código de timeout', async () => {
  resetMocks();
  const ctrl = new AbortController();
  fetchImpl = (url, opts) => new Promise((_, rej) => {
    const s = opts.signal;
    if (s) s.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
  });
  const p = llm.ask({ messages: [{ role: 'user', content: 'hola' }], signal: ctrl.signal });
  ctrl.abort();
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, 'debió rechazar');
  assert(err.code !== 'BARO_LLM_TIMEOUT', 'no es timeout');
});

/* ---------- 5. rate-limit ---------- */
tcase('ask: segunda llamada inmediata -> BARO_LLM_RATE', async () => {
  resetMocks();
  fetchImpl = () => Promise.resolve(sseResp([sseData('ok'), 'data: [DONE]\n']));
  await llm.ask({ messages: [{ role: 'user', content: 'uno' }] });
  let err = null;
  try {
    await llm.ask({ messages: [{ role: 'user', content: 'dos' }] });
  } catch (e) { err = e; }
  assert(err && err.code === 'BARO_LLM_RATE', 'código RATE, fue ' + (err && err.code));
  const st = llm.rateState();
  assert(st.ok === false && st.retryInMs > 0, 'rateState refleja el bloqueo');
});

/* ---------- 6. system prompt ---------- */
tcase('system prompt: fecha real, KB verificada y directiva de idioma', () => {
  resetMocks();
  const sp = llm.buildSystemPrompt('es');
  const hoy = new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  assert(sp.indexOf(hoy) !== -1, 'fecha real de hoy en el prompt');
  assert(sp.indexOf('no sabes qué día es') !== -1 || sp.indexOf('Nunca digas que no sabes') !== -1, 'prohibición de decir que no sabe el día');
  assert(sp.indexOf('- ondas') !== -1, 'KB verificada incluye ondas');
  assert(sp.indexOf('todavía no lo conozco') !== -1, 'anti-alucinación: honestidad ante lo desconocido');
  assert(sp.indexOf('Responde siempre en español.') !== -1, 'directiva ES');
  const spEn = llm.buildSystemPrompt('en');
  assert(spEn.indexOf('Always reply in English.') !== -1, 'directiva EN');
  const spZh = llm.buildSystemPrompt('zh');
  assert(spZh.indexOf('始终用中文回答') !== -1, 'directiva ZH');
});
tcase('system prompt: hook BaroVoice.systemPromptExtra se anexa (guard)', () => {
  resetMocks();
  const sin = llm.buildSystemPrompt('es');
  sandbox.window.BaroVoice = { systemPromptExtra: () => 'EXTRA-VOZ-123' };
  const con = llm.buildSystemPrompt('es');
  assert(con.indexOf('EXTRA-VOZ-123') !== -1, 'extra anexado');
  assert(con.length > sin.length, 'el prompt creció con el hook');
  delete sandbox.window.BaroVoice;
  const roto = llm.buildSystemPrompt('es'); /* sin hook no lanza */
  assert(typeof roto === 'string' && roto.length > 100, 'sin hook sigue funcionando');
});

/* ---------- 7. decisiones del enrutador ---------- */
tcase('router: acciones de alta confianza van al motor local', () => {
  resetMocks();
  const use = brain.llmUse;
  const d1 = brain.detect('busca gatitos');
  assert(d1.intent === 'preguntar', 'sanity: preguntar');
  assert(use(d1, 'busca gatitos') === false, 'preguntar -> local');
  assert(use({ intent: 'publicar', args: { lang: 'es' }, confidence: 0.9 }, 'publicar esto') === false, 'publicar -> local');
  assert(use({ intent: 'recordar', args: {}, confidence: 0.8 }, '/recordar comprar pan') === false, 'comando / -> local');
  assert(use(brain.detect('/ayuda'), '/ayuda') === false, '/ayuda -> local');
  assert(use({ intent: 'votar', args: {}, confidence: 0.9 }, 'vota por este post') === false, 'votar -> local');
});
tcase('router: chitchat, opiniones y explicaciones van al LLM', () => {
  resetMocks();
  const use = brain.llmUse;
  assert(use(brain.detect('hola'), 'hola') === true, 'hola -> LLM');
  assert(use(brain.detect('cuéntame un chiste'), 'cuéntame un chiste') === true, 'chiste -> LLM');
  assert(use(brain.detect('qué opinas de Drex'), 'qué opinas de Drex') === true, 'opinión -> LLM');
  const dExp = brain.detect('cómo publico una foto');
  assert(dExp.intent === 'explicar', 'sanity: explicar');
  assert(use(dExp, 'cómo publico una foto') === true, 'explicar -> LLM (KB en el prompt)');
});
tcase('router: gibberish conserva la tarjeta local; det nulo va a local', () => {
  resetMocks();
  const use = brain.llmUse;
  assert(use(brain.detect('zzz qqq xxx'), 'zzz qqq xxx') === false, 'gibberish -> tarjeta local');
  assert(use(null, 'qué día es hoy') === false, 'det nulo -> local (blindaje existente)');
  assert(use({ intent: 'ayuda', args: { clarify: true, candidates: ['x'] } }, 'zzz') === false, 'clarify sin palabras -> local');
});

/* ---------- 8. turno con streaming: typing + fase + burbuja ---------- */
tcase('runTurn: streaming pinta typing, fase y burbuja final sanitizada', async () => {
  resetMocks();
  fetchImpl = () => Promise.resolve(sseResp([sseData('Hola '), sseData('Darel <b>¡bienvenido!</b>'), 'data: [DONE]\n']));
  const det = { intent: 'ayuda', args: { lang: 'es' }, confidence: 0 };
  const out = await brain.llmRunTurn('hola', det);
  assert(out === 'Hola Darel <b>¡bienvenido!</b>', 'devuelve el texto');
  eqJ(userSaid, ['hola'], 'usuario pintado una vez');
  assert(typingOn === 0, 'typing retirado al final');
  assert(phaseLog.some(e => e[0] === 'phase'), 'fase "pensando" activada');
  assert(phaseLog[phaseLog.length - 1][0] === 'phaseDone', 'fase cerrada al final');
  assert(bubbles.length === 1, 'una burbuja de Baro');
  assert(bubbles[0]._html.indexOf('&lt;b&gt;') !== -1, 'HTML del LLM escapado (sin inyección)');
  assert(bubbles[0]._html.indexOf('<b>') === -1, 'sin tags crudos del modelo');
  assert(T.historyLen() === 2, 'historial: user + assistant');
});

/* ---------- 9. fallo -> fallback silencioso al motor local ---------- */
tcase('runTurn: ante fallo, delega al motor local sin error visible', async () => {
  resetMocks();
  let origCalls = 0;
  brain.llmOrig.fn = async (t) => { origCalls++; return 'LOCAL:' + t; };
  fetchImpl = () => Promise.reject(new Error('red caída'));
  const det = { intent: 'ayuda', args: { lang: 'es' }, confidence: 0 };
  const out = await brain.llmRunTurn('hola', det);
  assert(out === 'LOCAL:hola', 'delegó al original');
  assert(origCalls === 1, 'original llamado una vez');
  eqJ(userSaid, ['hola'], 'usuario pintado una vez (muteado en el fallback)');
  assert(bubbles.length === 0, 'sin burbuja parcial ni error visible');
  assert(typingOn === 0, 'typing retirado');
});

/* ---------- 10. mensaje nuevo aborta el turno anterior ---------- */
tcase('runTurn: un mensaje nuevo aborta el anterior en silencio', async () => {
  resetMocks();
  fetchImpl = (url, opts) => new Promise((_, rej) => { /* cuelga pero respeta abort */
    const s = opts.signal;
    if (s) s.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
  });
  const det = { intent: 'ayuda', args: { lang: 'es' }, confidence: 0 };
  const p1 = brain.llmRunTurn('hola', det);
  await new Promise(r => setTimeout(r, 30)); /* deja que el turno 1 arranque */
  T.resetRate(); /* simula que pasaron los 3 s entre llamadas */
  fetchImpl = () => Promise.resolve(sseResp([sseData('segundo ok'), 'data: [DONE]\n']));
  const p2 = brain.llmRunTurn('otra cosa', det);
  const r2 = await p2;
  const r1 = await p1;
  assert(r1 === null, 'turno 1 abortado en silencio (null)');
  assert(r2 === 'segundo ok', 'turno 2 completó');
  assert(bubbles.length === 1, 'solo la burbuja del turno 2');
});

/* ---------- 11. hook varyResponse ---------- */
tcase('runTurn: BaroVoice.varyResponse transforma el texto final (guard)', async () => {
  resetMocks();
  fetchImpl = () => Promise.resolve(sseResp([sseData('texto plano'), 'data: [DONE]\n']));
  sandbox.window.BaroVoice = { varyResponse: (t) => t + ' ✨' };
  const det = { intent: 'ayuda', args: { lang: 'es' }, confidence: 0 };
  const out = await brain.llmRunTurn('hola', det);
  assert(out === 'texto plano ✨', 'hook aplicado');
  delete sandbox.window.BaroVoice;
});

/* ---------- 12. i18n ---------- */
tcase('i18n ES/EN/ZH/PT de las cadenas nuevas', () => {
  resetMocks();
  const t = brain.llmT;
  assert(t('baro.llm.thinking', 'es') === 'Pensando…', 'ES');
  assert(t('baro.llm.thinking', 'en') === 'Thinking…', 'EN');
  assert(t('baro.llm.thinking', 'zh') === '思考中…', 'ZH');
  assert(t('baro.llm.thinking', 'pt') === 'Pensando…', 'PT');
  assert(t('baro.llm.thinking', 'xx') === 'Pensando…', 'idioma raro -> ES');
});

/* ---------- 13. end-to-end por el handle envuelto ---------- */
tcase('e2e: "hola" por baroHandleUserMessage llega al LLM con streaming', async () => {
  resetMocks();
  fetchImpl = () => Promise.resolve(sseResp([sseData('¡Hola! ¿Cómo estás?'), 'data: [DONE]\n']));
  await brain.llmHandle('hola');
  eqJ(userSaid, ['hola'], 'usuario pintado');
  assert(bubbles.length === 1, 'una burbuja de Baro, fue ' + bubbles.length);
  assert(bubbles[0]._html.indexOf('¡Hola! ¿Cómo estás?') !== -1, 'texto del LLM pintado');
});
tcase('e2e: "busca gatitos" por baroHandleUserMessage sigue al motor local', async () => {
  resetMocks();
  fetchImpl = () => { throw new Error('no debería llamarse al LLM'); };
  await brain.llmHandle('busca gatitos');
  eqJ(userSaid, ['busca gatitos'], 'usuario pintado por el motor local');
  assert(fetchCalls.length === 0, 'cero llamadas de red en la ruta local');
  assert(bubbles.length >= 1, 'el motor local pintó su respuesta');
});

/* ---------- runner ---------- */
(async () => {
  for (const [name, fn] of CASES) {
    try {
      await fn();
      oks++;
      console.log('ok - ' + name);
    } catch (e) {
      fails++;
      console.log('FALLO - ' + name + ' :: ' + (e && e.message));
    }
  }
  console.log('\n' + oks + ' ok, ' + fails + ' fallos (' + CASES.length + ' casos)');
  process.exit(fails ? 1 : 0);
})();
