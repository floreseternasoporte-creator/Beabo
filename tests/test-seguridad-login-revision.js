/* ================================================================
 * Tests: "Cerrar la fuga de cuentas" + "Revisión de seguridad".
 *  - security-checkup.js (lógica pura del puntaje y checklist)
 *  - signUpOrResendConfirmation: misma respuesta para correo nuevo,
 *    registro a medias y cuenta ya confirmada
 *  - el login ya no lee users/userEmails/usernames como invitado
 *  - mensajes genéricos, i18n, 404 idéntico, sw subido
 * Ejecutar con: node tests/test-seguridad-login-revision.js
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var root = path.join(__dirname, '..');
function read(f) { return fs.readFileSync(path.join(root, f), 'utf8'); }

var passed = 0, failed = 0, pending = [];
function test(name, fn) {
  var p;
  try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
  pending.push(p.then(function () { passed++; console.log('ok - ' + name); },
    function (e) { failed++; console.log('FALLO - ' + name + ': ' + e.message); }));
}

// ---------- 1) security-checkup.js ----------
var CK = require('../security-checkup.js');
var NOW = Date.UTC(2026, 10, 9);
var DAY = 86400000;
function byId(m, id) { return m.items.filter(function (i) { return i.id === id; })[0]; }

test('cuenta nueva sin 2FA: 2FA pendiente, respaldo "needs2fa" sin puntuar', function () {
  var m = CK.compute({ emailVerified: true, twoFactor: false, now: NOW, otherSessions: [] });
  assert.strictEqual(byId(m, 'twofactor').state, 'todo');
  assert.strictEqual(byId(m, 'backup').state, 'info');
  assert.strictEqual(byId(m, 'backup').reason, 'needs2fa');
  assert.strictEqual(byId(m, 'password').state, 'info');
  assert.strictEqual(m.total, 3); // correo, 2FA, sesiones
  assert.strictEqual(m.done, 2);
  assert.strictEqual(m.pct, 67);
});

test('todo en orden = 100% y nivel máximo', function () {
  var m = CK.compute({ emailVerified: true, twoFactor: true, backupCodes: { hasCodes: true, remaining: 8 },
    passwordChangedAt: NOW - 10 * DAY, otherSessions: [], now: NOW });
  assert.strictEqual(m.pct, 100);
  assert.strictEqual(m.level, 4);
  assert.strictEqual(m.total, 5);
});

test('2FA activo sin códigos o con pocos códigos queda pendiente', function () {
  var none = CK.compute({ emailVerified: true, twoFactor: true, backupCodes: { hasCodes: false, remaining: 0 }, now: NOW });
  assert.strictEqual(byId(none, 'backup').state, 'todo');
  var low = CK.compute({ emailVerified: true, twoFactor: true, backupCodes: { hasCodes: true, remaining: 2 }, now: NOW });
  assert.strictEqual(byId(low, 'backup').state, 'todo');
  assert.strictEqual(byId(low, 'backup').reason, 'low');
});

test('antigüedad de la contraseña: >365 días pendiente, sin dato no puntúa', function () {
  var old = CK.compute({ emailVerified: true, twoFactor: false, passwordChangedAt: NOW - 400 * DAY, now: NOW });
  assert.strictEqual(byId(old, 'password').state, 'todo');
  var fresh = CK.compute({ emailVerified: true, twoFactor: false, passwordChangedAt: NOW - 3 * DAY, now: NOW });
  assert.strictEqual(byId(fresh, 'password').state, 'ok');
  assert.strictEqual(byId(fresh, 'password').days, 3);
  var nodata = CK.compute({ emailVerified: true, twoFactor: false, now: NOW });
  assert.strictEqual(byId(nodata, 'password').state, 'info');
  var nul = CK.compute({ emailVerified: true, twoFactor: false, passwordChangedAt: null, now: NOW });
  assert.strictEqual(byId(nul, 'password').state, 'info', 'null no debe contar como 1970');
});

test('sesiones de otros dispositivos sin revisar bajan el puntaje; revisadas no', function () {
  var sess = { a: { lastActivity: NOW }, b: { lastActivity: NOW }, me: { lastActivity: NOW }, c: { revoked: true } };
  var others = CK.unreviewedSessions(sess, 'me', []);
  assert.strictEqual(others.length, 2);
  var m = CK.compute({ emailVerified: true, twoFactor: false, otherSessions: others, now: NOW });
  assert.strictEqual(byId(m, 'sessions').state, 'todo');
  assert.strictEqual(byId(m, 'sessions').pending, 2);
  var rev = CK.unreviewedSessions(sess, 'me', ['a', 'b']);
  var m2 = CK.compute({ emailVerified: true, twoFactor: false, otherSessions: rev, now: NOW });
  assert.strictEqual(byId(m2, 'sessions').state, 'ok');
  assert.strictEqual(byId(m2, 'sessions').count, 2);
});

test('correo sin verificar y 2FA no comprobable (null)', function () {
  var m = CK.compute({ emailVerified: false, twoFactor: null, now: NOW });
  assert.strictEqual(byId(m, 'email').state, 'todo');
  assert.strictEqual(byId(m, 'twofactor').state, 'info');
});

test('lastPasswordChange toma el evento más reciente (eventKey o texto en español)', function () {
  var ev = {
    x1: { eventKey: 'password_changed', timestamp: 1000 },
    x2: { type: 'Contraseña cambiada', ts: 5000 },
    x3: { eventKey: 'new_login', timestamp: 9000 }
  };
  assert.strictEqual(CK.lastPasswordChange(ev), 5000);
  assert.strictEqual(CK.lastPasswordChange(null), null);
  assert.strictEqual(CK.lastPasswordChange({}), null);
});

// ---------- 2) signUpOrResendConfirmation ----------
function loadSignup(opts) {
  var src = read('drex-cloud.js');
  function grab(name) {
    var a = src.indexOf('  function ' + name + '(');
    assert(a !== -1, 'no se encontró ' + name);
    var b = src.indexOf('\n  }\n', a);
    return src.slice(a, b + 5);
  }
  var code = grab('createUserWithEmailAndPassword') + grab('signUpOrResendConfirmation') +
    '\nreturn signUpOrResendConfirmation;';
  var factory = new Function('getAuth', 'cognitoLib', 'getUserPool', 'mapAuthError', 'signInWithEmailAndPassword', code);
  var C = {
    CognitoUserAttribute: function (o) { return o; },
    CognitoUser: function () {
      return { resendConfirmationCode: function (cb) { opts.resend(cb); } };
    }
  };
  var pool = { signUp: function (u, p, a, v, cb) { opts.signUp(cb); } };
  var mapAuthError = function (e) {
    var out = new Error(e.message || 'x');
    out.code = e.code === 'UsernameExistsException' ? 'auth/email-already-in-use'
      : e.code === 'LimitExceededException' ? 'auth/too-many-requests' : 'auth/unknown';
    return out;
  };
  return factory(function () {}, function () { return C; }, function () { return pool; }, mapAuthError,
    function () { return Promise.resolve({ user: {} }); });
}
var exists = { code: 'UsernameExistsException', message: 'exists' };

test('registro: correo nuevo -> needsConfirmation', function () {
  var fn = loadSignup({ signUp: function (cb) { cb(null, { userConfirmed: false }); }, resend: function () { throw new Error('no debe reenviar'); } });
  return fn('A@b.com', 'x').then(function (r) {
    assert.strictEqual(r.needsConfirmation, true); assert.strictEqual(r.email, 'a@b.com');
  });
});
test('registro: registro a medias -> misma respuesta (se reenvía el código)', function () {
  var sent = 0;
  var fn = loadSignup({ signUp: function (cb) { cb(exists); }, resend: function (cb) { sent++; cb(null, {}); } });
  return fn('a@b.com', 'x').then(function (r) {
    assert.strictEqual(sent, 1);
    assert.strictEqual(r.needsConfirmation, true); assert.strictEqual(r.email, 'a@b.com');
    assert.strictEqual(r.resumed, undefined, 'no debe delatar que era un registro previo');
  });
});
test('registro: cuenta ya confirmada -> misma respuesta, sin error ni envío', function () {
  var fn = loadSignup({ signUp: function (cb) { cb(exists); },
    resend: function (cb) { cb({ code: 'InvalidParameterException', message: 'User is already confirmed.' }); } });
  return fn('a@b.com', 'x').then(function (r) {
    assert.strictEqual(r.needsConfirmation, true); assert.strictEqual(r.email, 'a@b.com');
    assert.strictEqual(r.resumed, undefined);
  });
});
test('registro: los errores reales (límite de intentos) se siguen mostrando', function () {
  var fn = loadSignup({ signUp: function (cb) { cb(exists); }, resend: function (cb) { cb({ code: 'LimitExceededException', message: 'limit' }); } });
  return fn('a@b.com', 'x').then(function () { throw new Error('debía fallar'); },
    function (e) { assert.strictEqual(e.code, 'auth/too-many-requests'); });
});

// ---------- 3) index.html ----------
var html = read('index.html');
function between(start, end) {
  var a = html.indexOf(start); assert(a !== -1, 'no se encontró: ' + start);
  var b = html.indexOf(end, a); assert(b !== -1, 'no se encontró fin: ' + end);
  return html.slice(a, b);
}

test('el paso de contraseña del login ya no lee users/userEmails/usernames', function () {
  var seg = between('const userCard=document.getElementById("loginUserCard")', 'document.getElementById("backToEmailStep")');
  assert(!/database\(\)/.test(seg), 'quedan lecturas de base de datos en el paso de contraseña');
  assert(!/userEmails\//.test(seg) && !/usernames\//.test(seg) && !/"users\//.test(seg));
  assert(!/avatar\.src|loginUserAvatar\b/.test(seg));
  assert(!/profileQuery/.test(html));
});

test('mensajes genéricos: sin "no se encontró ninguna cuenta" ni "ya habías empezado"', function () {
  assert(!/No se encontró ninguna cuenta/.test(html));
  assert(!/Ya habías empezado este registro/.test(html));
  assert(/case"auth\/user-not-found":return"Correo o contraseña incorrectos\."/.test(html));
});

test('recuperar contraseña: los errores de estado de cuenta avanzan al paso del código', function () {
  var seg = between('function resetPassword(){', 'document.getElementById("confirmRecoveryCodeBtn")');
  ['auth/user-not-found', 'auth/invalid-credential', 'auth/invalid-email', 'auth/wrong-password',
    'auth/user-not-confirmed'].forEach(function (c) {
    assert(seg.indexOf('case"' + c + '"') !== -1, 'falta ' + c);
  });
  assert(/auth\/too-many-requests/.test(seg));
});

test('verificación del código: tras ALREADY_CONFIRMED el error es el genérico', function () {
  var seg = between('let codeConfirmedNow=false', 'let resendCodeCooldown');
  assert(/res!=="ALREADY_CONFIRMED"/.test(seg));
  assert(/El código no es válido o venció/.test(seg));
});

test('Centro de seguridad: sección Revisión de seguridad + aviso 2FA con tema', function () {
  assert(/id="security-checkup"/.test(html) && /id="security-checkup-list"/.test(html));
  assert(/function drexRenderSecurityCheckup\(/.test(html));
  assert(/function drexMaybeShowTwoFactorNudge\(/.test(html));
  assert(/src="security-checkup\.js\?v=/.test(html));
  var seg = between('function drexMaybeShowTwoFactorNudge', 'async function openSecurityCenter');
  assert(/var\(--theme-surface\)/.test(seg), 'el aviso debe usar variables del tema');
  assert(!/background:#fff|background:white|bg-white/.test(seg), 'sin fondos blancos fijos');
});

test('el aviso se pide tras login explícito y al terminar el registro', function () {
  var login = between('signInPromise.then(()=>{', '.catch(error=>{');
  assert(/drexRequestTwoFactorNudge\(\)/.test(login));
  var fin = between('function finishOnboarding(){', 'const user=DrexCloud.auth().currentUser');
  assert(/drexRequestTwoFactorNudge\(\)/.test(fin));
});

test('404.html idéntico a index.html y drex-cloud.v3.js idéntico a drex-cloud.js', function () {
  assert.strictEqual(read('404.html'), html);
  assert.strictEqual(read('drex-cloud.v3.js'), read('drex-cloud.js'));
});

test('comentario viejo de drex-cloud.js corregido', function () {
  var c = read('drex-cloud.js');
  assert(!/El User Pool no debería exigir verificación/.test(c));
  assert(/EXIGE verificar el correo/.test(c));
});

test('sw.js >= v141 y marca de versión de drex-cloud.js actualizada', function () {
  var m = /DREX_SW_VERSION = 'drex-v(\d+)'/.exec(read('sw.js'));
  assert(m && Number(m[1]) >= 141);
  assert(!/drex-cloud\.js\?v=2026-11-05T00:25:13Z/.test(html));
});

test('i18n: las claves nuevas existen en los 6 idiomas', function () {
  ['en', 'pt', 'fr', 'ja', 'ko', 'zh'].forEach(function (l) {
    var s = read('drex-i18n-' + l + '.js');
    ['Revisión de seguridad', 'Activar ahora', 'Cambiada hace {n} días',
      'Si este correo puede registrarse, te enviamos un código. Si ya tienes una cuenta, inicia sesión o recupera tu contraseña.',
      'Tu revisión de seguridad está al {n}%'].forEach(function (k) {
      assert(s.indexOf(JSON.stringify(k)) !== -1, l + ' sin: ' + k);
    });
  });
});

test('doc con el paso de AWS (Prevent user existence errors)', function () {
  var d = read('docs/SEGURIDAD-LOGIN-CUENTAS.md');
  assert(/Prevent user existence errors/i.test(d));
  assert(/7cm12q14tm12u8b3bnn6ksjqni/.test(d));
});

Promise.all(pending).then(function () {
  console.log('\nRESULTADO: ' + passed + ' ok, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
});
