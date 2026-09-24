/* ============================================================
 * DrexRecoveryCodes — Códigos de respaldo de la verificación
 * en dos pasos. Suite de Seguridad Drex — Ingeniero #2
 * (Códigos de Recuperación).
 *
 * Responsabilidad ÚNICA de este módulo: generar, guardar
 * (solo hashes SHA-256), mostrar una sola vez y canjear los
 * códigos de respaldo del 2FA. No toca el flujo TOTP del
 * servidor (Ingeniero #1) ni la ruta /totp/backup/regenerate
 * (Lambda inexistente: no se usa).
 *
 * Esquema en DynamoDB (tabla drex-kv, un ítem por atributo):
 *   pk='users', sk='<uid>/recoveryCodes'
 *   v = JSON { hashes: [sha256hex...], generatedAt: <ms>, usedCount: <n> }
 * NUNCA se guardan los códigos en texto plano.
 *
 * Canje durante el DESAFÍO DE LOGIN (2026-09-20): OBSOLETO aquí.
 * El canje se movió al SERVIDOR (Lambda drex-username-resolve, paso R):
 * el desafío de 2FA llama a ch.onCode(código) y drex-cloud.js decide la
 * ruta (TOTP de 6 dígitos -> paso 2; forma de respaldo -> paso R con
 * {username, password, recoveryCode}). redeem() se conserva únicamente
 * para contextos con sesión ya autenticada; ningún desafío de login lo
 * llama (currentUser es null antes de completar el MFA, así que ahí
 * siempre rechazaba con 'no-user').
 *
 * NOTA totpFunctionUrl / backupRegenerate: esos símbolos viven en
 * drex-cloud.js (módulo DrexCloud.totp) y apuntan a la DrexTotpFunction
 * (API /totp/* con Bearer JWT), un backend distinto aún no desplegado
 * ("Lambda inexistente: no se usa"). NO se configuran con la Function
 * URL de drex-username-resolve: no tiene rutas /totp/* y rompería el
 * respaldo legacy de verifyCurrentTotp. La UI de regeneración de aquí
 * funciona sin ese backend (verificación TOTP del servidor si está
 * configurado, si no, secreto legacy).
 * ============================================================ */
(function () {
  'use strict';

  var CODE_COUNT = 10;
  var CODE_GROUP_LEN = 4;
  // 30 símbolos sin caracteres ambiguos (sin 0/O, 1/I/L): ~4.9 bits/símbolo.
  // 8 símbolos ≈ 39.3 bits de entropía por código.
  var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var REJECT_ABOVE = 240; // 240 = 30*8: muestreo por rechazo sin sesgo de módulo
  var MAX_ATTEMPTS = 5; // intentos fallidos antes del bloqueo temporal
  var LOCK_MS = 15 * 60 * 1000; // 15 minutos de bloqueo

  var _pendingCodes = null; // texto plano: vive solo hasta que el usuario lo descarta
  var _memAttempts = {}; // uid -> { fails, lockedUntil } (caché en memoria)

  /* ---------------- utilidades ---------------- */

  function T(es) { return (typeof appT === 'function') ? appT(es) : es; }

  function esc(s) {
    if (typeof escapeHtml === 'function') return escapeHtml(s);
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg) {
    try {
      if (typeof securityToast === 'function') { securityToast(msg); return; }
      if (typeof showMiniToast === 'function') { showMiniToast(msg); return; }
    } catch (e) {}
  }

  function currentUser() {
    try { return (window.DrexCloud && DrexCloud.auth().currentUser) || null; }
    catch (e) { return null; }
  }

  function dbRef(path) { return DrexCloud.database().ref(path); }
  function codesPath(uid) { return 'users/' + uid + '/recoveryCodes'; }
  function attemptsPath(uid) { return 'users/' + uid + '/recoveryAttempts'; }

  /* ---------------- generación ---------------- */

  // Normaliza: mayúsculas, sin guiones ni espacios ni separadores.
  function normalize(code) {
    return String(code == null ? '' : code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // Un código: 8 símbolos de ALPHABET agrupados "XXXX-XXXX".
  // crypto.getRandomValues (nunca Math.random). Muestreo por rechazo:
  // se aceptan bytes < 240 para que (byte % 30) sea uniforme.
  function generateOne() {
    var chars = [];
    var buf = new Uint8Array(1);
    while (chars.length < 8) {
      crypto.getRandomValues(buf);
      if (buf[0] < REJECT_ABOVE) chars.push(ALPHABET[buf[0] % ALPHABET.length]);
    }
    return chars.slice(0, CODE_GROUP_LEN).join('') + '-' + chars.slice(CODE_GROUP_LEN).join('');
  }

  function generate(count) {
    var n = Math.max(1, count || CODE_COUNT);
    var out = [], seen = {}, c;
    while (out.length < n) {
      c = generateOne();
      if (!seen[c]) { seen[c] = 1; out.push(c); }
    }
    return out;
  }

  function sha256Hex(text) {
    if (!crypto.subtle) return Promise.reject(new Error('no-subtle-crypto'));
    var data = new TextEncoder().encode(String(text));
    return crypto.subtle.digest('SHA-256', data).then(function (buf) {
      return Array.from(new Uint8Array(buf)).map(function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    });
  }

  // Comparación en tiempo constante (los digests SHA-256 hex siempre
  // miden 64 caracteres; la longitud no filtra información útil).
  function hashEquals(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /* ---------------- almacenamiento ---------------- */

  // Genera 10 códigos, guarda SOLO sus hashes y devuelve el texto plano
  // (el llamador debe mostrarlo UNA sola vez y luego descartarlo).
  function generateAndStore(count) {
    var user = currentUser();
    if (!user || !user.uid) {
      var e = new Error('no-user'); e.code = 'no-user'; e.userMessage = T('Inicia sesión para ver esta sección.');
      return Promise.reject(e);
    }
    var codes = generate(count || CODE_COUNT);
    var chain = Promise.resolve();
    var hashes = [];
    codes.forEach(function (c) {
      chain = chain.then(function () { return sha256Hex(normalize(c)); })
        .then(function (h) { hashes.push(h); });
    });
    return chain.then(function () {
      return dbRef(codesPath(user.uid)).set({
        hashes: hashes,
        generatedAt: Date.now(),
        usedCount: 0
      });
    }).then(function () {
      return clearAttempts(user.uid).catch(function () {});
    }).then(function () {
      return codes;
    });
  }

  function getStatus() {
    var user = currentUser();
    if (!user || !user.uid) return Promise.resolve(null);
    return dbRef(codesPath(user.uid)).once('value').then(function (snap) {
      var data = (snap && snap.val()) || null;
      var hashes = (data && Array.isArray(data.hashes)) ? data.hashes : [];
      return {
        hasCodes: hashes.length > 0,
        remaining: hashes.length,
        generatedAt: (data && data.generatedAt) || 0,
        usedCount: (data && data.usedCount) || 0
      };
    }, function () { return null; });
  }

  /* ---------------- rate limit de redención ---------------- */

  function memRec(uid) {
    return _memAttempts[uid] || (_memAttempts[uid] = { fails: 0, lockedUntil: 0 });
  }

  function readAttempts(uid) {
    var rec = memRec(uid);
    return dbRef(attemptsPath(uid)).once('value').then(function (snap) {
      var d = (snap && snap.val()) || {};
      if (typeof d.fails === 'number') rec.fails = d.fails;
      if (typeof d.lockedUntil === 'number') rec.lockedUntil = d.lockedUntil;
      return rec;
    }, function () { return rec; }); // sin red: vale el registro en memoria
  }

  function lockedError(rec) {
    var mins = Math.max(1, Math.ceil((rec.lockedUntil - Date.now()) / 60000));
    var err = new Error('locked');
    err.code = 'locked';
    err.retryAfterMs = Math.max(0, rec.lockedUntil - Date.now());
    err.userMessage = T('Demasiados intentos. Espera {n} minutos e inténtalo de nuevo.').replace('{n}', String(mins));
    return err;
  }

  function assertNotLocked(uid) {
    return readAttempts(uid).then(function (rec) {
      var now = Date.now();
      if (rec.lockedUntil && now < rec.lockedUntil) throw lockedError(rec);
      if (rec.lockedUntil && now >= rec.lockedUntil) {
        rec.fails = 0; rec.lockedUntil = 0; // el bloqueo expiró: se reinicia
        return dbRef(attemptsPath(uid)).set({ fails: 0, lockedUntil: 0 }).catch(function () {}).then(function () { return rec; });
      }
      return rec;
    });
  }

  function registerFailure(uid) {
    var rec = memRec(uid);
    rec.fails = (rec.fails || 0) + 1;
    if (rec.fails >= MAX_ATTEMPTS) { rec.lockedUntil = Date.now() + LOCK_MS; rec.fails = 0; }
    return dbRef(attemptsPath(uid)).set({ fails: rec.fails, lockedUntil: rec.lockedUntil })
      .catch(function () {}).then(function () { return rec; });
  }

  function clearAttempts(uid) {
    delete _memAttempts[uid];
    return dbRef(attemptsPath(uid)).remove().catch(function () {});
  }

  function invalidError() {
    var err = new Error('invalid-code');
    err.code = 'invalid-code';
    err.userMessage = T('Código inválido. Revisa e inténtalo de nuevo.');
    return err;
  }

  /* ---------------- redención ---------------- */

  // OBSOLETO para el desafío de login (2026-09-20): el canje durante el
  // login ocurre en el SERVIDOR (Lambda drex-username-resolve, paso R)
  // porque currentUser es null antes de completar el MFA y esta función
  // siempre rechazaba con 'no-user'. Se conserva únicamente para
  // contextos con sesión ya autenticada.
  // Resuelve { ok:true, ... } o rechaza con err.code 'invalid-code'|'locked'|'no-user'.
  function redeem(code) {
    var user = currentUser();
    if (!user || !user.uid) {
      var e = new Error('no-user'); e.code = 'no-user'; e.userMessage = T('Inicia sesión para ver esta sección.');
      return Promise.reject(e);
    }
    var uid = user.uid;
    var norm = normalize(code);
    return assertNotLocked(uid).then(function () {
      return sha256Hex(norm);
    }).then(function (digest) {
      // 1) Tienda nueva: comparar + marcar como usado en UNA transacción
      //    atómica (evita doble uso concurrente del mismo código).
      return dbRef(codesPath(uid)).transaction(function (cur) {
        if (!cur || !Array.isArray(cur.hashes) || cur.hashes.length === 0) return undefined; // aborta
        var idx = -1;
        for (var i = 0; i < cur.hashes.length; i++) {
          if (hashEquals(String(cur.hashes[i]), digest)) { idx = i; break; }
        }
        if (idx < 0) return undefined; // no coincide: aborta
        cur.hashes.splice(idx, 1); // un código solo se usa una vez
        cur.usedCount = (cur.usedCount || 0) + 1;
        return cur;
      });
    }).then(function (res) {
      if (res && res.committed) return { store: 'v2' };
      // 2) Compatibilidad: tienda legacy twoFactorBackupCodes { hashHexMinusculas: false }
      return redeemLegacy(uid, norm).then(function (ok) {
        return ok ? { store: 'legacy' } : null;
      });
    }).then(function (hit) {
      if (!hit) {
        // 3) No coincide en ninguna tienda: intento fallido (rate limit) + error genérico.
        return registerFailure(uid).then(function () { throw invalidError(); });
      }
      // 4) Éxito: limpiar intentos y desactivar el MFA para que el login complete.
      return clearAttempts(uid).then(function () {
        return disableCognitoMfa(user);
      }).then(function (cognitoOk) {
        return dbRef('users/' + uid).update({ twoFactorEnabled: false }).catch(function () {}).then(function () {
          return cognitoOk;
        });
      }).then(function (cognitoOk) {
        // La inscripción 2FA terminó: los códigos restantes quedan huérfanos y se eliminan.
        return dbRef(codesPath(uid)).remove().catch(function () {}).then(function () { return cognitoOk; });
      }).then(function (cognitoOk) {
        try {
          if (typeof recordSecurityEvent === 'function')
            recordSecurityEvent('Código de respaldo usado', 'Se usó un código de respaldo para iniciar sesión y se desactivó la verificación en dos pasos.');
        } catch (e) {}
        try {
          if (typeof showSecurityAlertIfEnabled === 'function')
            showSecurityAlertIfEnabled('securityChangeAlerts', T('Se usó un código de respaldo. La verificación en dos pasos quedó desactivada.'));
        } catch (e) {}
        return { ok: true, cognitoMfaDisabled: !!cognitoOk, usedLegacyStore: hit.store === 'legacy', remaining: 0 };
      });
    });
  }

  // Tienda legacy: users/<uid>/twoFactorBackupCodes = { sha256(minúsculas): false|true }.
  // Marca atómicamente el hash como usado (false -> true).
  function redeemLegacy(uid, normUpper) {
    return sha256Hex(String(normUpper).toLowerCase()).then(function (digestLower) {
      return dbRef('users/' + uid + '/twoFactorBackupCodes').transaction(function (cur) {
        if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
        var keys = Object.keys(cur);
        for (var i = 0; i < keys.length; i++) {
          if (cur[keys[i]] === false && hashEquals(keys[i], digestLower)) {
            cur[keys[i]] = true;
            return cur;
          }
        }
        return undefined;
      });
    }).then(function (res) { return !!(res && res.committed); },
      function () { return false; });
  }

  // Desactiva el MFA TOTP en Cognito con la propia sesión del usuario
  // (SetUserMFAPreference; la variante Admin* requiere credenciales IAM y
  // no existe en el cliente). Best-effort: si falla, el gate de la app
  // (twoFactorEnabled=false) es lo que desbloquea el login.
  function disableCognitoMfa(user) {
    return new Promise(function (resolve) {
      var done = function (ok) { resolve(!!ok); };
      try {
        var cu = user && user._cognitoUser;
        if (!cu || typeof cu.setUserMfaPreference !== 'function') return done(false);
        var attempt = function () {
          try {
            cu.setUserMfaPreference(null, { Enabled: false, PreferredMfa: false }, function (err) {
              if (!err) return done(true);
              var msg = String((err && err.message) || '');
              // Token vencido: refrescar la sesión y reintentar una sola vez.
              if (/NotAuthorized|expired|invalid/i.test(msg) && typeof cu.getSession === 'function') {
                try {
                  cu.getSession(function (err2, session) {
                    if (err2 || !session || !session.isValid()) return done(false);
                    try {
                      cu.setUserMfaPreference(null, { Enabled: false, PreferredMfa: false }, function (err3) { done(!err3); });
                    } catch (e) { done(false); }
                  });
                  return;
                } catch (e) { return done(false); }
              }
              done(false);
            });
          } catch (e) { done(false); }
        };
        attempt();
      } catch (e) { done(false); }
    });
  }

  /* ---------------- verificación TOTP actual (para regenerar) ---------------- */

  function verifyCurrentTotp(code) {
    if (!/^\d{6}$/.test(String(code || '').trim())) return Promise.resolve(false);
    var c = String(code).trim();
    try {
      if (window.DrexCloud && DrexCloud.totp &&
          typeof DrexCloud.totp.configured === 'function' && DrexCloud.totp.configured() &&
          typeof DrexCloud.totp.verify === 'function') {
        return DrexCloud.totp.verify(c).then(function (res) { return !!(res && res.ok); }, function () { return false; });
      }
    } catch (e) { return Promise.resolve(false); }
    // Respaldo legacy: el secreto vivía en la app.
    var user = currentUser();
    if (!user || typeof verifyTotpCode !== 'function') return Promise.resolve(false);
    return dbRef('users/' + user.uid + '/twoFactorSecret').once('value').then(function (snap) {
      return verifyTotpCode(snap.val(), c);
    }, function () { return false; });
  }

  /* ---------------- UI: vista "Códigos de respaldo" ---------------- */

  var KEY_ICON = '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M15 7a3 3 0 1 0-5.83 1.02L4 13.19V17h3.81l5.17-5.17A3 3 0 0 0 15 7z"/><path stroke-linecap="round" stroke-linejoin="round" d="m12.5 9.5 2 2"/></svg>';

  function bodyEl() { return document.getElementById('recovery-codes-body'); }

  function openView(mode) {
    var view = document.getElementById('recovery-codes-view');
    if (!view) return;
    if (view.parentElement !== document.body) document.body.appendChild(view);
    view.classList.remove('hidden');
    renderView(mode || 'status');
  }

  function closeView() {
    clearPendingCodes();
    var view = document.getElementById('recovery-codes-view');
    if (view) view.classList.add('hidden');
  }

  function clearPendingCodes() {
    if (Array.isArray(_pendingCodes)) {
      for (var i = 0; i < _pendingCodes.length; i++) _pendingCodes[i] = '·';
    }
    _pendingCodes = null;
  }

  function spinnerHtml() {
    var inner = (typeof getSpinnerMarkup === 'function') ? getSpinnerMarkup() : esc(T('Cargando…'));
    return '<div class="py-10 flex justify-center">' + inner + '</div>';
  }

  function errorCard(msg) {
    return '<div class="bg-white rounded-2xl border border-[#dce1e5] p-5 shadow-sm text-center">' +
      '<p class="text-sm text-[#6b7280]">' + esc(msg) + '</p></div>';
  }

  function renderView(mode) {
    var body = bodyEl();
    if (!body) return;
    if (mode === 'reveal') { renderReveal(body); return; }
    if (mode === 'regenerate') { renderRegenerate(body); return; }
    body.innerHTML = spinnerHtml();
    var user = currentUser();
    if (!user) { body.innerHTML = errorCard(T('Inicia sesión para ver esta sección.')); return; }
    dbRef('users/' + user.uid).once('value').then(function (snap) {
      var data = (snap && snap.val()) || {};
      if (!data.twoFactorEnabled) { renderNo2fa(body); return; }
      return getStatus().then(function (st) { renderStatus(body, st); });
    }).catch(function () {
      body.innerHTML = errorCard(T('No se pudo cargar esta sección. Inténtalo de nuevo.'));
    });
  }

  function renderNo2fa(body) {
    body.innerHTML =
      '<div class="bg-white rounded-2xl border border-[#dce1e5] p-5 shadow-sm text-center">' +
      '<div class="w-12 h-12 rounded-2xl bg-[#eef2ff] text-[#2F33B8] flex items-center justify-center mx-auto mb-3">' + KEY_ICON + '</div>' +
      '<p class="font-extrabold text-[#1c2b4a] mb-1">' + esc(T('Códigos de respaldo')) + '</p>' +
      '<p class="text-sm text-[#6b7280] mb-5">' + esc(T('Activa primero la verificación en dos pasos para generar tus códigos de respaldo.')) + '</p>' +
      '<button onclick="DrexRecoveryCodes.closeView();openTwoFactorView()" class="w-full py-3 rounded-full bg-[#2F33B8] text-white font-bold active:opacity-80 transition">' + esc(T('Ir a la verificación en dos pasos')) + '</button>' +
      '</div>';
  }

  function renderStatus(body, st) {
    var remaining = st ? st.remaining : 0;
    var main;
    if (remaining > 0) {
      main =
        '<p class="text-5xl font-black text-[#1c2b4a]">' + remaining + '</p>' +
        '<p class="text-sm text-[#6b7280] mt-1 mb-1">' + esc(T('de 10 códigos disponibles')) + '</p>' +
        '<p class="text-xs text-[#8b96a5] mb-5">' + esc(T('Cada código sirve una sola vez. Guárdalos en un lugar seguro.')) + '</p>';
    } else {
      main =
        '<p class="font-extrabold text-[#1c2b4a] mb-1">' + esc(T('Aún no tienes códigos de respaldo')) + '</p>' +
        '<p class="text-sm text-[#6b7280] mb-5">' + esc(T('Te servirán para entrar si pierdes tu app de autenticación.')) + '</p>';
    }
    body.innerHTML =
      '<div class="bg-white rounded-2xl border border-[#dce1e5] p-5 shadow-sm text-center">' +
      '<div class="w-12 h-12 rounded-2xl bg-[#eef2ff] text-[#2F33B8] flex items-center justify-center mx-auto mb-3">' + KEY_ICON + '</div>' +
      main +
      '<button onclick="DrexRecoveryCodes.startRegenerate()" class="w-full mb-2 py-3 rounded-full bg-[#2F33B8] text-white font-bold active:opacity-80 transition">' +
      esc(remaining > 0 ? T('Generar nuevos códigos') : T('Generar códigos de respaldo')) + '</button>' +
      (remaining > 0 ? '<p class="text-[11px] text-[#8b96a5]">' + esc(T('Generar nuevos invalida los anteriores.')) + '</p>' : '') +
      '</div>';
  }

  // Paso de regeneración: advertencia + código TOTP actual.
  function renderRegenerate(body) {
    body = body || bodyEl();
    if (!body) return;
    body.innerHTML =
      '<div class="bg-white rounded-2xl border border-[#dce1e5] p-5 shadow-sm">' +
      '<div class="w-12 h-12 rounded-2xl bg-[#fef3c7] text-[#b45309] flex items-center justify-center mx-auto mb-3">' + KEY_ICON + '</div>' +
      '<p class="font-extrabold text-[#1c2b4a] mb-1 text-center">' + esc(T('Generar nuevos códigos')) + '</p>' +
      '<p class="text-sm text-[#6b7280] mb-4 text-center">' + esc(T('Esto invalida tus códigos de respaldo anteriores. Escribe un código actual de tu app de autenticación para confirmar.')) + '</p>' +
      '<input id="recovery-regen-code" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" enterkeyhint="go" onkeydown="if(event.key===\'Enter\'){event.preventDefault();DrexRecoveryCodes.confirmRegenerate();}" placeholder="000000" class="w-full p-3 mb-2 rounded-xl border border-[#dce1e5] bg-[#f0f4f9] text-center text-xl font-bold tracking-[0.3em] focus:outline-none focus:ring-2 focus:ring-[#2F33B8]">' +
      '<div id="recovery-regen-error" class="hidden text-red-500 text-xs mb-2 text-center"></div>' +
      '<button onclick="DrexRecoveryCodes.confirmRegenerate()" class="w-full py-3 rounded-full bg-[#2F33B8] text-white font-bold active:opacity-80 transition">' + esc(T('Generar códigos nuevos')) + '</button>' +
      '<button onclick="DrexRecoveryCodes.renderView()" class="w-full mt-2 py-2 text-sm font-bold text-[#6b7280] active:opacity-70">' + esc(T('Cancelar')) + '</button>' +
      '</div>';
    var input = document.getElementById('recovery-regen-code');
    if (input) input.focus();
  }

  function confirmRegenerate() {
    var body = bodyEl();
    if (!body) return;
    if (!confirm(T('Esto invalida tus códigos de respaldo anteriores. ¿Continuar?'))) return;
    var input = document.getElementById('recovery-regen-code');
    var errBox = document.getElementById('recovery-regen-error');
    var code = input ? input.value.trim() : '';
    var fail = function (msg) {
      renderRegenerate(body);
      var eb = document.getElementById('recovery-regen-error');
      if (eb) { eb.textContent = msg; eb.classList.remove('hidden'); }
    };
    if (!/^\d{6}$/.test(code)) { fail(T('Código incorrecto.')); return; }
    body.innerHTML = spinnerHtml();
    verifyCurrentTotp(code).then(function (ok) {
      if (!ok) { fail(T('Código incorrecto. Revisa e inténtalo de nuevo.')); return; }
      return generateAndStore(CODE_COUNT).then(function (codes) {
        _pendingCodes = codes;
        try {
          if (typeof recordSecurityEvent === 'function')
            recordSecurityEvent('Códigos de respaldo regenerados', 'Se generaron nuevos códigos de respaldo; los anteriores quedaron invalidados.');
        } catch (e) {}
        renderReveal(body);
      });
    }).catch(function () {
      fail(T('No se pudo generar. Inténtalo de nuevo.'));
    });
  }

  // Revelado único: muestra el texto plano una sola vez.
  function renderReveal(body) {
    body = body || bodyEl();
    var codes = _pendingCodes;
    if (!body) return;
    if (!codes || !codes.length) { renderView('status'); return; }
    var cards = codes.map(function (c) {
      return '<div class="bg-[#eef2ff] border border-[#dfe3ff] rounded-xl py-2.5 text-center font-mono text-[15px] font-bold tracking-[0.18em] text-[#1c2b4a] select-all">' + esc(c) + '</div>';
    }).join('');
    body.innerHTML =
      '<div class="bg-white rounded-2xl border border-[#dce1e5] p-5 shadow-sm">' +
      '<p class="font-extrabold text-[#1c2b4a] mb-1">✅ ' + esc(T('Códigos listos')) + '</p>' +
      '<p class="text-sm text-[#6b7280] mb-4">' + esc(T('Guárdalos ahora en un lugar seguro. Cada uno sirve una sola vez y no los volveremos a mostrar.')) + '</p>' +
      '<div class="grid grid-cols-2 gap-2 mb-4">' + cards + '</div>' +
      '<div class="flex gap-2 mb-2">' +
      '<button onclick="DrexRecoveryCodes.copyPending()" class="flex-1 py-3 rounded-full border-2 border-[#2F33B8] text-[#2F33B8] font-bold active:opacity-80 transition">' + esc(T('Copiar todos')) + '</button>' +
      '<button onclick="DrexRecoveryCodes.downloadPending()" class="flex-1 py-3 rounded-full border-2 border-[#2F33B8] text-[#2F33B8] font-bold active:opacity-80 transition">' + esc(T('Descargar .txt')) + '</button>' +
      '</div>' +
      '<button onclick="DrexRecoveryCodes.ackReveal()" class="w-full py-3 rounded-full bg-[#2F33B8] text-white font-bold active:opacity-80 transition">' + esc(T('Ya los guardé')) + '</button>' +
      '</div>';
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
      }
    } catch (e) {}
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (e) { return false; }
  }

  function copyPending() {
    if (!_pendingCodes || !_pendingCodes.length) return;
    copyText(_pendingCodes.join('\n')).then(function (ok) {
      toast(ok ? T('Códigos copiados al portapapeles') : T('No se pudo copiar. Inténtalo de nuevo.'));
    });
  }

  function downloadTxt(codes) {
    var lines = [
      T('Drex — Códigos de respaldo'),
      '===========================',
      '',
      T('Guarda estos códigos en un lugar seguro. Cada código sirve UNA SOLA VEZ.'),
      T('Si pierdes tu app de autenticación, usa uno para iniciar sesión.'),
      T('Generados: {d}').replace('{d}', new Date().toLocaleString()),
      ''
    ];
    codes.forEach(function (c, i) { lines.push((i + 1) + '. ' + c); });
    lines.push('', T('No compartas estos códigos con nadie. Drex nunca te los pedirá por correo o mensaje.'));
    var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'drex-codigos-respaldo.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) {} a.remove(); }, 1500);
  }

  function downloadPending() {
    if (!_pendingCodes || !_pendingCodes.length) return;
    downloadTxt(_pendingCodes);
    toast(T('Archivo descargado'));
  }

  function ackReveal() {
    clearPendingCodes();
    renderView('status');
  }

  /* ---------------- API pública ---------------- */

  window.DrexRecoveryCodes = {
    // Núcleo (usado por el hook del challenge de 2FA del Ingeniero #1)
    redeem: redeem,
    // Generación / consulta
    generate: generate,
    normalize: normalize,
    generateAndStore: generateAndStore,
    getStatus: getStatus,
    // UI
    openView: openView,
    closeView: closeView,
    renderView: function (mode) { renderView(mode || 'status'); },
    startRegenerate: function () { renderView('regenerate'); },
    confirmRegenerate: confirmRegenerate,
    copyPending: copyPending,
    downloadPending: downloadPending,
    ackReveal: ackReveal,
    // Constantes
    CODE_COUNT: CODE_COUNT,
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    LOCK_MS: LOCK_MS
  };
})();
