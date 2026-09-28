// Drex C231 (carril errores/resiliencia): pop-ups de error y resiliencia — 24 checks.
//
// A: drexErrFriendly nunca filtra el message técnico crudo.
// B: getFriendlyErrorMessage mapea los códigos MFA.
// C: offline/online — overlay no destructivo + debounce anti-blips.
// D: guardas a nivel de fuente (sin fugas de .message crudo, sin wipe del body).
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

let passed = 0;
function ok(name, cond) { assert(cond, 'FALLO: ' + name); passed++; console.log('ok -', name); }

const SRC = fs.readFileSync('/home/hatch/workspace/drex-laneA-c230/work/index.html', 'utf8');

// ---------- A + B: helpers evaluados desde el archivo real ----------
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('función ' + name + ' no encontrada');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; ; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
}
const helpersSrc = extractFunction(SRC, 'drexErrFriendly');
const friendlySrc = extractFunction(SRC, 'getFriendlyErrorMessage');
const sandboxA = { appT: (s) => s, showMiniToast: () => {}, console };
vm.createContext(sandboxA);
vm.runInContext(helpersSrc, sandboxA);
vm.runInContext(friendlySrc, sandboxA);
const friendly = sandboxA.drexErrFriendly;
const gfem = sandboxA.getFriendlyErrorMessage;
ok('C231-A0 helpers extraídos del archivo real', typeof friendly === 'function' && typeof gfem === 'function');

ok('C231-A1 error técnico DynamoDB -> fallback, sin fuga',
  friendly({ message: 'Transaction cancelled: ConditionalCheckFailedException' }, 'FALLBACK') === 'FALLBACK');
ok('C231-A2 error sin message -> fallback', friendly({}, 'FALLBACK') === 'FALLBACK');
ok('C231-A3 err nulo -> fallback', friendly(null, 'FALLBACK') === 'FALLBACK');
ok('C231-A4 error de red -> mensaje de conexión',
  friendly({ message: 'Network request failed' }, 'FALLBACK').indexOf('Sin conexión') >= 0);
ok('C231-A5 timeout propio -> mensaje de conexión',
  friendly({ message: 'db-write-timeout' }, 'FALLBACK').indexOf('Sin conexión') >= 0);
ok('C231-A6 permiso denegado -> mensaje de permiso',
  friendly({ message: 'AccessDenied: not authorized' }, 'FALLBACK').indexOf('permiso') >= 0);
ok('C231-A7 throttling -> mensaje de servidor ocupado',
  friendly({ message: 'ProvisionedThroughputExceededException' }, 'FALLBACK').indexOf('ocupado') >= 0);
ok('C231-A8 auth/mfa-expired -> mensaje amable con i18n',
  friendly({ code: 'auth/mfa-expired' }, 'FALLBACK').indexOf('código venció') >= 0);
ok('C231-A9 nunca devuelve el message crudo en inglés',
  friendly({ message: 'Something broke badly' }, 'FALLBACK') === 'FALLBACK');

ok('C231-B1 auth/mfa-expired mapeado', gfem({ code: 'auth/mfa-expired' }).indexOf('venció') >= 0);
ok('C231-B2 auth/invalid-mfa-code mapeado', gfem({ code: 'auth/invalid-mfa-code' }).indexOf('incorrecto') >= 0);
ok('C231-B3 auth/mfa-cancelled mapeado', gfem({ code: 'auth/mfa-cancelled' }).indexOf('cancelada') >= 0);
ok('C231-B4 auth/session-expired mapeado', gfem({ code: 'auth/session-expired' }).indexOf('sesión') >= 0);
ok('C231-B5 código desconocido -> genérico, nunca el message crudo',
  gfem({ code: 'auth/xyz-desconocido', message: 'TECHNICAL-LEAK' }).indexOf('TECHNICAL-LEAK') < 0);

// ---------- C: offline/online con DOM falso ----------
function extractOfflineScript(src) {
  // El <script> del <head> que maneja 'offline' (viejo: 'offline-modal', nuevo: 'C231-offline')
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(src))) {
    const c = m[1];
    if (c.indexOf("addEventListener('offline'") >= 0 &&
        (c.indexOf('offline-modal') >= 0 || c.indexOf('C231-offline') >= 0)) return c;
  }
  throw new Error('script offline no encontrado');
}

function makeEnv() {
  const listeners = {};
  const timeouts = [];
  let reloads = 0;
  const registry = {};
  function el(tag) {
    return {
      tag, id: '', children: [], style: {}, innerHTML: '',
      setAttribute() {}, appendChild(c) { this.children.push(c); if (c.id) registry[c.id] = c; },
      addEventListener() {}, classList: { add() {}, remove() {} },
    };
  }
  const body = el('body');
  let bodyInnerHTMLWrites = 0;
  Object.defineProperty(body, 'innerHTML', {
    get() { return this._html || ''; },
    set(v) { bodyInnerHTMLWrites++; this._html = v; },
    configurable: true,
  });
  const document = {
    body,
    addEventListener() {},
    createElement(t) { return el(t); },
    getElementById(id) {
      const walk = (els) => {
        for (const c of els) {
          if (c && c.id === id) return c;
          const f = walk(c.children || []);
          if (f) return f;
        }
        return null;
      };
      return registry[id] || walk(body.children);
    },
  };
  const ctx = {
    document,
    window: {
      addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    },
    localStorage: { getItem: () => 'es', setItem: () => {} },
    location: { reload: () => { reloads++; } },
    setTimeout: (fn) => { timeouts.push({ fn, cleared: false }); return timeouts.length - 1; },
    clearTimeout: (id) => { if (timeouts[id]) timeouts[id].cleared = true; },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(extractOfflineScript(SRC), ctx);
  const fire = (ev) => { (listeners[ev] || []).forEach((fn) => fn()); };
  const runTimers = () => { timeouts.forEach((t) => { if (!t.cleared) t.fn(); }); };
  return { ctx, document, body, fire, runTimers, timeouts,
    get reloads() { return reloads; }, get bodyInnerHTMLWrites() { return bodyInnerHTMLWrites; } };
}

// C1: blip (offline -> online inmediato): sin overlay, sin recarga.
{
  const env = makeEnv();
  env.fire('offline');
  env.fire('online'); // vuelve la red antes del debounce
  env.runTimers();
  ok('C231-C1 blip: no hay overlay ni recarga tras online inmediato',
    env.reloads === 0 && env.document.getElementById('drex-offline-overlay') === null &&
    !env.timeouts.some((t) => !t.cleared));
}
// C2-C4: offline real (>1.5s): overlay no destructivo, body intacto.
{
  const env = makeEnv();
  env.fire('offline');
  env.runTimers(); // expira el debounce
  ok('C231-C2 offline real: body NO destruido (0 escrituras a innerHTML)', env.bodyInnerHTMLWrites === 0);
  const ov = env.document.getElementById('drex-offline-overlay');
  ok('C231-C3 overlay no destructivo visible con mensaje amable',
    !!ov && (ov.style.display === 'flex' || (ov.style.cssText || '').indexOf('display:flex') >= 0) &&
    ov.innerHTML.indexOf('Sin conexión') >= 0);
  ok('C231-C4 overlay tiene botón de reintento',
    ov.innerHTML.indexOf('drex-offline-retry') >= 0 && ov.innerHTML.indexOf('Reintentar ahora') >= 0);
}
// C5: online con overlay visible -> una recarga de recuperación.
{
  const env = makeEnv();
  env.fire('offline');
  env.runTimers();
  env.fire('online');
  ok('C231-C5 online con overlay visible -> recarga de recuperación', env.reloads === 1);
}

// ---------- D: guardas a nivel de fuente ----------
ok('C231-D1 sin fugas showMiniToast(error.message', SRC.indexOf('showMiniToast(error.message') < 0);
ok('C231-D2 sin fugas showMiniToast((err && err.message', SRC.indexOf('showMiniToast((err && err.message') < 0);
ok('C231-D3 sin fugas showErr((err && err.message', SRC.indexOf('showErr((err && err.message') < 0);
ok('C231-D4 sin showErr(err.message) crudo', SRC.indexOf('showErr(err.message)') < 0);
ok('C231-D5 el wipe del body en offline desapareció', SRC.indexOf('offline-modal') < 0);

console.log('\nC231: ' + passed + ' checks verdes');
