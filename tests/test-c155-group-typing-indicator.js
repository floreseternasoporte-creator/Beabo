/* ================================================================
 * C155 — indicador de "escribiendo..." mudo en grupos
 * (familia `chat`, foco de la rotación C155).
 *
 * HALLAZGO: en `subscribeChatTyping`, la rama de grupo construye la
 * variable `msg` ("X está escribiendo...") pero NUNCA la asigna a
 * ningún elemento: el `.then` solo quita 'hidden' al indicador.
 * Además `textEl` no estaba declarado en el scope de la función (ni
 * existe el span en el markup), así que las ramas 1-a-1 y de catch
 * lanzaban ReferenceError al evaluar `if (textEl)`.
 *
 * PoC: extraer la función REAL del bundle y ejecutarla en sandbox
 * node/vm con mocks de document + RTDB. Con un evento de typing en
 * grupo, `textContent` del span NUNCA se actualiza en la base
 * (queda '').
 *
 * FIX (mínimo, estilo del código vecino):
 *   1. span `#chat-typing-text` dentro de la burbuja del indicador;
 *   2. `const textEl = document.getElementById('chat-typing-text')`
 *      al inicio del callback (ya no es identificador indefinido);
 *   3. `if (textEl) textEl.textContent = msg;` en el `.then` de grupo
 *      (mismo patrón `if (textEl) ...` de las ramas vecinas).
 *
 * Ejecutar con: node tests/test-c155-group-typing-indicator.js
 * (o DREX_HTML=/ruta/index.html node test-c155-group-typing-indicator.js)
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Resolución del HTML bajo prueba: env explícito > convención del repo
// (tests/../index.html) > respaldo local del worker.
function resolveHtml() {
  const cands = [
    process.env.DREX_HTML,
    path.join(__dirname, '..', 'index.html'),
    path.join(__dirname, 'patched.html'),
    '/tmp/pristine_37e54fe.html',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('no se encontró ningún index.html candidato');
}
const HTML_PATH = resolveHtml();
const html = fs.readFileSync(HTML_PATH, 'utf8');
console.log('HTML bajo prueba: ' + HTML_PATH);

let failures = 0;
// En la base prístina, el `.catch` de la rama de grupo y la rama 1-a-1
// lanzan ReferenceError (textEl indefinido) como promesas flotantes sin
// handler: registrarlas como fallo en vez de tumbar el proceso.
process.on('unhandledRejection', reason => {
  console.log('NOT OK - promesa flotante rechazada [excepción: ' +
    (reason && reason.message ? reason.message : reason) + ']');
  failures++;
});
function tcase(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(ok => {
      console.log((ok ? 'ok - ' : 'NOT OK - ') + name);
      if (!ok) failures++;
    })
    .catch(e => {
      console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
      failures++;
    });
}

// Extrae el cuerpo de `function name(` con balance de llaves (patrón C154).
function extractFn(src, name) {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no encontrada: ' + name);
  let j = src.indexOf('{', i), depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}

// Entorno sandbox: document + RTDB mínimos para la función REAL.
function makeEnv(profileMap, profileFails) {
  let indicatorHidden = true;
  const textEl = { textContent: '' };
  const els = {
    'chat-typing-indicator': {
      classList: {
        add: c => { if (c === 'hidden') indicatorHidden = true; },
        remove: c => { if (c === 'hidden') indicatorHidden = false; },
      },
    },
    'chat-typing-text': textEl,
  };
  const capture = {};
  const ref = { on: (ev, cb) => { capture.cb = cb; }, off: () => {} };
  const sandbox = {
    document: { getElementById: id => els[id] || null },
    DrexCloud: {
      auth: () => ({ currentUser: { uid: 'me' } }),
      database: () => ({ ref: () => ref }),
    },
    getChatUserProfile: uid => profileFails
      ? Promise.reject(new Error('boom'))
      : Promise.resolve({ name: (profileMap || {})[uid] || 'Alguien' }),
    detachChatTypingListener: () => {},
    currentChatIsGroup: false,
    chatTypingListener: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(html, 'subscribeChatTyping'), sandbox);
  return {
    sandbox,
    fire: (isGroup, typingData) => {
      vm.runInContext('currentChatIsGroup = ' + (isGroup ? 'true' : 'false') + ';', sandbox);
      vm.runInContext("subscribeChatTyping('room1');", sandbox);
      capture.cb({ val: () => typingData });
    },
    textEl,
    isHidden: () => indicatorHidden,
  };
}

// Deja correr la cadena Promise.all(...).then(...) flotante.
const flush = () => new Promise(r => setImmediate(r));

const NOW = () => Date.now();
const profiles = { u2: 'Ana Gómez', u3: 'Beto Ruiz', u4: 'Ceci Paz' };

async function main() {
  // ---- 1. Comportamiento: la rama de grupo muestra el nombre ----
  await tcase('grupo, 1 escribiendo: textContent = "Ana está escribiendo..."', async () => {
    const e = makeEnv(profiles);
    e.fire(true, { u2: NOW(), me: NOW() });
    await flush();
    return e.textEl.textContent === 'Ana está escribiendo...' && !e.isHidden();
  });

  await tcase('grupo, 2 escribiendo: "Ana y Beto están escribiendo..."', async () => {
    const e = makeEnv(profiles);
    e.fire(true, { u2: NOW(), u3: NOW(), me: NOW() });
    await flush();
    return e.textEl.textContent === 'Ana y Beto están escribiendo...';
  });

  await tcase('grupo, 3+ escribiendo: "Ana, Beto y más están escribiendo..."', async () => {
    const e = makeEnv(profiles);
    e.fire(true, { u2: NOW(), u3: NOW(), u4: NOW(), me: NOW() });
    await flush();
    return e.textEl.textContent === 'Ana, Beto y más están escribiendo...';
  });

  await tcase('grupo, falla getChatUserProfile: fallback "Alguien está escribiendo..." sin excepción', async () => {
    const e = makeEnv(profiles, true);
    e.fire(true, { u2: NOW() });
    await flush(); await flush();
    return e.textEl.textContent === 'Alguien está escribiendo...' && !e.isHidden();
  });

  // ---- 2. Sin regresión: rama 1-a-1 y apagado ----
  await tcase('1-a-1: textContent = "escribiendo..." sin excepción', async () => {
    const e = makeEnv(profiles);
    e.fire(false, { u2: NOW() });
    await flush();
    return e.textEl.textContent === 'escribiendo...' && !e.isHidden();
  });

  await tcase('sin nadie escribiendo: el indicador se oculta', async () => {
    const e = makeEnv(profiles);
    e.fire(true, {});
    await flush();
    return e.isHidden();
  });

  // ---- 3. Estático: el span y la asignación existen en el bundle ----
  await tcase('markup: existe <span id="chat-typing-text"> dentro del indicador', () => {
    const i = html.indexOf('id="chat-typing-indicator"');
    const j = html.indexOf('chat-reply-preview', i);
    return i > 0 && html.slice(i, j).includes('id="chat-typing-text"');
  });

  await tcase('código: la rama de grupo asigna msg a textEl.textContent', () => {
    const fn = extractFn(html, 'subscribeChatTyping');
    return /textEl\.textContent\s*=\s*msg/.test(fn);
  });

  await tcase('código: textEl está declarado en el scope de subscribeChatTyping', () => {
    const fn = extractFn(html, 'subscribeChatTyping');
    return /(const|let|var)\s+textEl\s*=/.test(fn);
  });

  console.log(failures ? `\n${failures} FALLOS` : '\nTODOS LOS CHECKS PASARON');
  process.exit(failures ? 1 : 0);
}

main();
