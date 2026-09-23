'use strict';
// QA ciclo 16 — R2-1: LOGIN CSRF EN OAUTH SOCIAL.
// Regresión permanente del fix anti login-CSRF (state + nonce + PKCE).
//
// Before/after real:
//   BEFORE (base 783c1ff sin el fix): este test FALLA — el ?code= plantado por
//     un atacante se canjea sin pedir state (fetch al /oauth2/token sí ocurre)
//     y la URL /oauth2/authorize sale sin state/nonce/code_challenge.
//   AFTER (con el fix): PASA — el callback sin state válido se rechaza sin
//     tocar la red, el flujo legítimo canjea con PKCE y el nonce del id_token.
//
// Reglas del repo: el test resuelve el layout primero (../drex-cloud.js) con
// fallback por env; sin rutas absolutas cableadas; sin dependencia de git.
const fs = require('fs');
const path = require('path');

const CLOUD = process.env.DREX_CLOUD_PATH || path.join(__dirname, '..', 'drex-cloud.js');
if (!fs.existsSync(CLOUD)) {
  console.error('No se encontró drex-cloud.js en: ' + CLOUD);
  process.exit(2);
}

const realSetTimeout = setTimeout;
// El flush de arranque (1500 ms, programado al cargar el módulo) se anula
// UNA vez por boot; el resto de timers son reales.
let armStartupSwallow = false;
global.setTimeout = (fn, ms, ...a) => {
  if (ms === 1500 && armStartupSwallow) { armStartupSwallow = false; return 0; }
  return realSetTimeout(fn, ms, ...a);
};
global.clearTimeout = clearTimeout;
process.on('unhandledRejection', () => { /* fire-and-forget del módulo en el harness */ });

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FALLA ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => realSetTimeout(r, ms));

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function installFakes() {
  const ssStore = new Map();
  const lsStore = new Map();
  const calls = { urls: [], fetches: [], events: [], replaced: [] };
  const ctl = {
    calls,
    // nonce que el token endpoint falso "devuelve" dentro del id_token
    tokenNonce: undefined,
    // ver: oauthRandomString falla cerrado si no hay sessionStorage
    noSessionStorage: false,
  };
  globalThis.location = {
    href: 'https://drex.glamworksapps.workers.dev/',
    search: '', pathname: '/', hash: '',
    assign(url) { calls.urls.push(url); },
  };
  globalThis.history = {
    replaceState() { calls.replaced.push(true); globalThis.location.search = ''; },
  };
  globalThis.document = {
    dispatchEvent(ev) { calls.events.push(ev && ev.type); return true; },
    addEventListener() {},
    hidden: false,
  };
  globalThis.localStorage = {
    getItem: k => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => lsStore.set(k, String(v)),
    removeItem: k => lsStore.delete(k),
  };
  if (ctl.noSessionStorage) { delete globalThis.sessionStorage; }
  else {
    globalThis.sessionStorage = {
      getItem: k => (ssStore.has(k) ? ssStore.get(k) : null),
      setItem: (k, v) => ssStore.set(k, String(v)),
      removeItem: k => ssStore.delete(k),
    };
  }
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, userAgent: 'qa-node' }, configurable: true, writable: true });
  globalThis.fetch = (url, opts) => {
    calls.fetches.push({ url: String(url), body: String((opts && opts.body) || '') });
    const payload = { sub: 'user-sub-1', email: 'usuario1@drex.app', 'cognito:username': 'usuario1' };
    if (ctl.tokenNonce !== undefined) payload.nonce = ctl.tokenNonce;
    const jwt = b64u({ alg: 'none' }) + '.' + b64u(payload) + '.sig';
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ id_token: jwt, access_token: 'AT', refresh_token: 'RT' }) });
  };
  globalThis.AmazonCognitoIdentity = {
    CognitoUserPool: class { constructor(cfg) { this.cfg = cfg; } getCurrentUser() { return null; } },
    CognitoUser: class {
      constructor(o) { this.username = o && o.Username; this.session = null; }
      setSignInUserSession(s) { this.session = s; }
      getUsername() { return this.username; }
      getUserAttributes(cb) {
        cb(null, [
          { getName: () => 'sub', getValue: () => 'user-sub-1' },
          { getName: () => 'email', getValue: () => 'usuario1@drex.app' },
          { getName: () => 'email_verified', getValue: () => 'true' },
        ]);
      }
      refreshSession(rt, cb) { cb(null, this.session); }
    },
    CognitoUserSession: class {
      constructor(t) { this.id = t.IdToken; this.acc = t.AccessToken; this.ref = t.RefreshToken; }
      getIdToken() { return this.id; } getRefreshToken() { return this.ref; }
    },
    CognitoIdToken: class {
      constructor(t) { this.jwt = t.IdToken; }
      getJwtToken() { return this.jwt; }
      getExpiration() { return Math.floor(Date.now() / 1000) + 3600; }
    },
    CognitoAccessToken: class { constructor(t) { this.t = t.AccessToken; } getJwtToken() { return this.t; } },
    CognitoRefreshToken: class { constructor(t) { this.t = t.RefreshToken; } getToken() { return this.t; } },
  };
  return ctl;
}

function freshModule() {
  armStartupSwallow = true;
  delete require.cache[require.resolve(CLOUD)];
  return require(CLOUD);
}

function readState(ctl) {
  try {
    const raw = globalThis.sessionStorage.getItem('drex.oauth.state');
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}
function param(url, name) {
  const m = new RegExp('[?&]' + name + '=([^&]+)').exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

async function scenarioAuthorizeUrl() {
  console.log('\n[1] federatedSignIn: la URL /oauth2/authorize lleva state+nonce+PKCE');
  const ctl = installFakes();
  const mod = freshModule();
  const OA = mod.__internals && mod.__internals.oauth;
  check('superficie de pruebas oauth expuesta (fix aplicado)', !!OA, 'sin __internals.oauth el fix no está');
  if (!OA) return;
  OA.federatedSignIn('Google');
  await sleep(150); // oauthCodeChallenge es asíncrono (subtle.digest)
  const url = ctl.calls.urls[0] || '';
  const st = param(url, 'state'), nonce = param(url, 'nonce');
  const chall = param(url, 'code_challenge'), method = param(url, 'code_challenge_method');
  const rec = readState(ctl);
  check('se redirige a /oauth2/authorize', /oauth2\/authorize/.test(url));
  check('URL incluye state criptográfico (≥128 bits)', !!st && st.length >= 22, st);
  check('URL incluye nonce', !!nonce && nonce.length >= 22, nonce);
  check('URL incluye code_challenge PKCE', !!chall && chall.length >= 43, chall);
  check('code_challenge_method es S256', method === 'S256', method);
  check('state guardado en sessionStorage coincide con el de la URL', !!(rec && rec.state === st));
  check('nonce guardado coincide', !!(rec && rec.nonce === nonce));
  check('code_verifier guardado (≥43 chars)', !!(rec && rec.verifier && rec.verifier.length >= 43));
  check('state expira pronto (TTL corto, ≤15 min)', !!(rec && rec.createdAt && (Date.now() - rec.createdAt) < 15 * 60 * 1000));
}

async function scenarioAttackPlantedCode() {
  console.log('\n[2] ATAQUE (PoC R2-1): ?code= plantado sin login previo -> NO se canjea');
  const ctl = installFakes();
  const mod = freshModule();
  const OA = mod.__internals && mod.__internals.oauth;
  if (!OA) { check('fix R2-1 aplicado (__internals.oauth presente)', false, 'el módulo no trae el fix'); return; }
  // La víctima abre el link del atacante: hay ?code= pero JAMÁS hubo federatedSignIn.
  globalThis.location.search = '?code=codigo-del-atacante-plantado-en-link';
  OA.handleOAuthRedirect();
  await sleep(200);
  check('NO se llama al /oauth2/token (el code plantado no se canjea)', ctl.calls.fetches.length === 0,
    ctl.calls.fetches.length + ' llamadas a la red');
  check('se avisa error a la app (drex:oauth-error)', ctl.calls.events.includes('drex:oauth-error'));
  check('la URL se limpia (no reprocesa el code)', globalThis.location.search === '');
  check('no hay sesión establecida', !mod.DrexCloud.auth().currentUser);
}

async function scenarioAttackStateMismatch() {
  console.log('\n[3] ATAQUE: ?code= con state ajeno -> NO se canjea');
  const ctl = installFakes();
  const mod = freshModule();
  const OA = mod.__internals && mod.__internals.oauth;
  if (!OA) { check('fix R2-1 aplicado (__internals.oauth presente)', false, 'el módulo no trae el fix'); return; }
  OA.federatedSignIn('Google');
  await sleep(150);
  const legitState = param(ctl.calls.urls[0], 'state');
  // El atacante planta su code con UN STATE QUE NO ES EL NUESTRO.
  globalThis.location.search = '?code=codigo-del-atacante&state=' + encodeURIComponent('state-del-atacante-xxxx');
  OA.handleOAuthRedirect();
  await sleep(200);
  check('state legítimo existía antes del callback', !!legitState);
  check('NO se llama al /oauth2/token', ctl.calls.fetches.length === 0,
    ctl.calls.fetches.length + ' llamadas a la red');
  check('se avisa error a la app', ctl.calls.events.includes('drex:oauth-error'));
  check('el state se consumió (single-use aunque falle)', readState(ctl) === null);
}

async function scenarioLegitRoundtrip() {
  console.log('\n[4] FLUJO LEGÍTIMO: ida y vuelta con state correcto -> sesión OK con PKCE');
  const ctl = installFakes();
  const mod = freshModule();
  const OA = mod.__internals && mod.__internals.oauth;
  if (!OA) { check('fix R2-1 aplicado (__internals.oauth presente)', false, 'el módulo no trae el fix'); return; }
  OA.federatedSignIn('Google');
  await sleep(150);
  const url = ctl.calls.urls[0] || '';
  const st = param(url, 'state');
  const rec = readState(ctl);
  // El proveedor devuelve el code CON el state que enviamos y el nonce en el id_token.
  ctl.tokenNonce = rec && rec.nonce;
  globalThis.location.search = '?code=LEGITCODE&state=' + encodeURIComponent(st);
  OA.handleOAuthRedirect();
  await sleep(400); // intercambio + establishSession
  check('state válido: SÍ se llama al /oauth2/token', ctl.calls.fetches.length === 1,
    ctl.calls.fetches.length + ' llamadas');
  const body = (ctl.calls.fetches[0] && ctl.calls.fetches[0].body) || '';
  check('el POST incluye code_verifier (PKCE)', /code_verifier=[^&]{43,}/.test(body), body.slice(0, 120));
  check('el verifier enviado es el guardado en la ida', rec && body.includes('code_verifier=' + encodeURIComponent(rec.verifier)));
  check('no hay error de oauth', !ctl.calls.events.includes('drex:oauth-error'));
  check('sesión establecida', !!(mod.DrexCloud.auth().currentUser && mod.DrexCloud.auth().currentUser.uid === 'user-sub-1'));
  check('el state se consumió tras usarlo (single-use)', readState(ctl) === null);
}

async function scenarioReplay() {
  console.log('\n[5] REPLAY: reutilizar el mismo ?code=&state= -> rechazado');
  const ctl = installFakes();
  const mod = freshModule();
  const OA = mod.__internals && mod.__internals.oauth;
  if (!OA) { check('fix R2-1 aplicado (__internals.oauth presente)', false, 'el módulo no trae el fix'); return; }
  OA.federatedSignIn('Google');
  await sleep(150);
  const st = param(ctl.calls.urls[0], 'state');
  const rec = readState(ctl);
  ctl.tokenNonce = rec && rec.nonce;
  globalThis.location.search = '?code=LEGITCODE&state=' + encodeURIComponent(st);
  OA.handleOAuthRedirect();
  await sleep(400);
  const firstFetches = ctl.calls.fetches.length;
  // El atacante reenvía la MISMA URL de callback.
  globalThis.location.search = '?code=LEGITCODE&state=' + encodeURIComponent(st);
  OA.handleOAuthRedirect();
  await sleep(200);
  check('primer uso sí canjeó', firstFetches === 1);
  check('replay NO genera un segundo canje', ctl.calls.fetches.length === 1,
    ctl.calls.fetches.length + ' llamadas');
  check('replay avisa error', ctl.calls.events.includes('drex:oauth-error'));
}

async function scenarioExpiredState() {
  console.log('\n[6] STATE EXPIRADO: callback con state viejo -> rechazado');
  const ctl = installFakes();
  const mod = freshModule();
  const OA = mod.__internals && mod.__internals.oauth;
  if (!OA) { check('fix R2-1 aplicado (__internals.oauth presente)', false, 'el módulo no trae el fix'); return; }
  const old = { state: 'state-viejo-abc123', nonce: 'nonce-viejo', verifier: 'v'.repeat(64), createdAt: Date.now() - 11 * 60 * 1000 };
  globalThis.sessionStorage.setItem('drex.oauth.state', JSON.stringify(old));
  globalThis.location.search = '?code=LEGITCODE&state=' + encodeURIComponent(old.state);
  OA.handleOAuthRedirect();
  await sleep(200);
  check('NO se llama al /oauth2/token con state expirado', ctl.calls.fetches.length === 0);
  check('se avisa error', ctl.calls.events.includes('drex:oauth-error'));
}

async function scenarioBadNonce() {
  console.log('\n[7] NONCE MANIPULADO en el id_token -> sesión rechazada');
  const ctl = installFakes();
  const mod = freshModule();
  const OA = mod.__internals && mod.__internals.oauth;
  if (!OA) { check('fix R2-1 aplicado (__internals.oauth presente)', false, 'el módulo no trae el fix'); return; }
  OA.federatedSignIn('Google');
  await sleep(150);
  const st = param(ctl.calls.urls[0], 'state');
  // El token trae un nonce distinto al enviado (token rejugado de otro flujo).
  ctl.tokenNonce = 'nonce-que-no-enviamos';
  globalThis.location.search = '?code=LEGITCODE&state=' + encodeURIComponent(st);
  OA.handleOAuthRedirect();
  await sleep(400);
  check('el canje sí ocurrió (el state era válido)', ctl.calls.fetches.length === 1);
  check('pero NO hay sesión: nonce inválido', !mod.DrexCloud.auth().currentUser);
  check('se avisa error', ctl.calls.events.includes('drex:oauth-error'));
}

async function main() {
  await scenarioAuthorizeUrl();
  await scenarioAttackPlantedCode();
  await scenarioAttackStateMismatch();
  await scenarioLegitRoundtrip();
  await scenarioReplay();
  await scenarioExpiredState();
  await scenarioBadNonce();
  console.log('\n' + (failures === 0 ? 'TODO OK' : failures + ' FALLA(S)'));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('ERROR del harness:', e); process.exit(1); });
