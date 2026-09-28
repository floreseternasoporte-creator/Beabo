/* ================================================================
 * AUTH-4: aviso visible al cerrar la sesion de forma remota
 * (2026-09-28).
 *
 * Causa raiz: drexSessionsHandleRemoteRevoke (drex-cloud.js) dejaba la
 * marca `drex_session_revoked_notice` en sessionStorage, pero NADA la
 * leia: al usuario se le cerraba la sesion desde otro dispositivo sin
 * ninguna explicacion (parecia un fallo de la app).
 *
 * Comportamiento esperado: al iniciar la vista de login, si la marca
 * existe se limpia y se muestra en el formulario:
 * "Tu sesión se cerró desde otro dispositivo. Inicia sesión de nuevo."
 *
 * El test extrae el bloque AUTH-4 de index.html y lo ejecuta con
 * sessionStorage/authError/appT falsificados, en los dos casos
 * (marca presente / ausente).
 * Ejecutar con: node tests/test-auth4-remote-revoke-notice.js
 * ================================================================ */
'use strict';
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var path = require('path');

var pass = 0, failCount = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { failCount++; console.log('  FAIL ' + name); }
}

function fakeClassList() {
  var added = [], removed = [];
  return {
    added: added, removed: removed,
    add: function (c) { added.push(c); },
    remove: function (c) { removed.push(c); }
  };
}

function extractBlock() {
  var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  var marker = '// AUTH-4 (2026-09-28)';
  var start = html.indexOf(marker);
  assert(start !== -1, 'bloque AUTH-4 no encontrado en index.html');
  var endMarker = '} catch (_) {}';
  var end = html.indexOf(endMarker, start);
  assert(end !== -1, 'fin del bloque AUTH-4 no encontrado');
  return html.slice(start, end + endMarker.length);
}

function runBlock(flagValue) {
  var store = flagValue === null ? {} : { drex_session_revoked_notice: flagValue };
  var authError = { textContent: '', classList: fakeClassList() };
  var sandbox = {
    sessionStorage: {
      getItem: function (k) { return (k in store) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    authError: authError,
    appT: function (s) { return s; }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractBlock(), sandbox, { filename: 'auth4-block.js' });
  return { store: store, authError: authError };
}

function main() {
  // 1. El backend deja la marca al revocar (contrato que la UI consume).
  var cloud = fs.readFileSync(path.join(__dirname, '..', 'drex-cloud.js'), 'utf8');
  ok(cloud.indexOf("sessionStorage.setItem('drex_session_revoked_notice', '1')") !== -1,
    'drex-cloud.js deja la marca drex_session_revoked_notice al revocar');

  // 2. Marca presente -> se muestra el aviso y se limpia la marca.
  var withFlag = runBlock('1');
  ok(withFlag.authError.textContent.indexOf('otro dispositivo') !== -1,
    'con la marca, el formulario muestra el aviso de cierre remoto');
  ok(withFlag.authError.classList.removed.indexOf('hidden') !== -1,
    'con la marca, el aviso se hace visible');
  ok(!('drex_session_revoked_notice' in withFlag.store),
    'con la marca, la marca se limpia (no se muestra dos veces)');

  // 3. Marca ausente -> el formulario no se toca.
  var withoutFlag = runBlock(null);
  ok(withoutFlag.authError.textContent === '',
    'sin la marca, el formulario no muestra ningun aviso');
  ok(withoutFlag.authError.classList.removed.length === 0,
    'sin la marca, no se altera la visibilidad del error');

  console.log('\nAUTH-4: ' + pass + ' ok, ' + failCount + ' fallos');
  process.exit(failCount ? 1 : 0);
}
main();
