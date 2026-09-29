/* ================================================================
 * Tests: DrexLivePresence — presencia global de en vivos (2026-09-29)
 * Causa raíz: no existía watcher global; drexLiveIsHostLive era one-shot
 * contra liveByHost (stale si el host muere sin cierre limpio) y no había
 * anillos de presencia en la UI.
 * El fix: UN solo DrexLivePresence sobre lives/ (status === 'live'
 * canónico), componente window.drexLiveRing para avatares, banners de
 * perfil / Buscar / cuenta destacada (DREX_FEATURED_LIVE_EMAIL, sin
 * hardcodear UID: resolución email->uid en runtime vía userEmails/), y
 * actualización dirigida de nodos (sin re-renderizar el feed).
 * Ejecutar con: node tests/test-live-presence.js [--target <ruta>]
 * ================================================================ */
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var path = require('path');

var target = path.join(__dirname, '..', 'index.html');
var ti = process.argv.indexOf('--target');
if (ti !== -1 && process.argv[ti + 1]) target = process.argv[ti + 1];
var src = fs.readFileSync(target, 'utf8');

var start = src.indexOf('window.DREX_FEATURED_LIVE_EMAIL');
assert(start !== -1, 'bloque DrexLivePresence no encontrado (marcador window.DREX_FEATURED_LIVE_EMAIL)');
var end = src.indexOf('/* ===== FIN DREX LIVE PRESENCE ===== */');
assert(end !== -1 && end > start, 'fin del bloque no encontrado');
var code = src.slice(start, end);

/* ---------- stubs mínimos: DB, auth, DOM, i18n ---------- */
function FakeEl(tag) {
  this.tagName = tag;
  this.children = [];
  this.attrs = {};
  this.parentNode = null;
  this.style = {};
  this.innerHTML = '';
  this.textContent = '';
  var cls = {};
  this.classList = {
    add: function (c) { cls[c] = 1; },
    remove: function (c) { delete cls[c]; },
    contains: function (c) { return !!cls[c]; }
  };
  this._cls = cls;
}
FakeEl.prototype.setAttribute = function (k, v) { this.attrs[String(k)] = String(v); };
FakeEl.prototype.getAttribute = function (k) {
  var kk = String(k);
  return Object.prototype.hasOwnProperty.call(this.attrs, kk) ? this.attrs[kk] : null;
};
FakeEl.prototype.querySelector = function (sel) {
  for (var i = 0; i < this.children.length; i++) {
    var c = this.children[i];
    if (sel === '.drex-live-ring-label' && c._cls['drex-live-ring-label']) return c;
  }
  return null;
};
FakeEl.prototype.appendChild = function (c) { c.parentNode = this; this.children.push(c); return c; };
FakeEl.prototype.insertBefore = function (c, ref) { c.parentNode = this; this.children.push(c); return c; };

function makeSandbox(opts) {
  opts = opts || {};
  var liveCb = null, subCount = 0, offCount = 0;
  var livesData = null;
  var emailUid = (opts.emailUid === undefined) ? 'uid-featured-123' : opts.emailUid;
  var emailErr = !!opts.emailErr;
  var registry = {}; // uid -> [nodos con data-live-ring-uid]
  var byId = {};

  var db = {
    _subCount: function () { return subCount; },
    _offCount: function () { return offCount; },
    _push: function (val) { // simula un snapshot de lives/
      livesData = val;
      if (liveCb) liveCb({ val: function () { return val; } });
    },
    database: function () {
      return {
        ref: function (p) {
          p = String(p);
          if (p === 'lives') {
            return {
              on: function (ev, cb) { subCount++; liveCb = cb; },
              off: function () { offCount++; liveCb = null; }
            };
          }
          if (p.indexOf('userEmails/') === 0) {
            return {
              once: function () {
                if (emailErr) return Promise.reject(new Error('db-down'));
                return Promise.resolve({ val: function () { return emailUid; } });
              }
            };
          }
          return { on: function () {}, off: function () {}, once: function () { return Promise.resolve({ val: function () { return null; } }); } };
        }
      };
    },
    auth: function () {
      return {
        currentUser: { uid: 'me-1', email: 'DarelVega6@Yahoo.com' },
        onAuthStateChanged: function () {}
      };
    }
  };

  var doc = {
    _byId: byId,
    _registry: registry,
    getElementById: function (id) { return byId[id] || null; },
    querySelectorAll: function (sel) {
      var m = /^\[data-live-ring-uid="([^"]*)"\]$/.exec(String(sel));
      if (!m) return [];
      return registry[m[1]] ? registry[m[1]].slice() : [];
    },
    createElement: function (tag) { return new FakeEl(tag); }
  };

  var store = {};
  var sb = {
    DrexCloud: db,
    document: doc,
    localStorage: {
      getItem: function (k) { return store[k] || null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    console: console,
    t: function (s) { return s; },       // i18n identidad: no interfiere en asertos
    esc: function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); },
    _db: db,
    _doc: doc
  };
  sb.window = sb;
  return sb;
}

function boot(sb) {
  vm.createContext(sb);
  vm.runInContext(code, sb);
  return sb;
}

/* ---------- 1. email configurable, sin UID hardcodeado ---------- */
(function () {
  var sb = boot(makeSandbox());
  assert.strictEqual(sb.DREX_FEATURED_LIVE_EMAIL, 'darelvega6@yahoo.com', 'email destacado configurable');
  var live = sb.DrexLivePresence;
  assert(live, 'DrexLivePresence expuesto');
  assert.strictEqual(typeof live.isLive, 'function');
  assert.strictEqual(typeof live.getLive, 'function');
  assert.strictEqual(typeof live.onChange, 'function');
  console.log('ok 1: constante configurable + API pública');
})();

/* ---------- 2. UN solo watcher aunque se inicie dos veces ---------- */
(function () {
  var sb = boot(makeSandbox());
  assert(sb.DrexLivePresence.start(), 'start ok');
  assert(sb.DrexLivePresence.start(), 'segundo start idempotente');
  assert.strictEqual(sb._db._subCount(), 1, 'UNA sola suscripción lives/');
  console.log('ok 2: un solo watcher (no uno por avatar)');
})();

/* ---------- 3. live simulado: isLive/getLive + anti fantasma ---------- */
(function () {
  var sb = boot(makeSandbox());
  sb.DrexLivePresence.start();
  sb._db._push({
    L1: { hostUid: 'u1', title: 'T1', status: 'live', viewers: 5, hostName: 'Ana', hostAvatar: 'a.png' },
    L2: { hostUid: 'u2', title: 'T2', status: 'ended', viewers: 9 },   // terminado: invisible
    L3: { hostUid: 'u3', title: 'T3', status: 'live', viewers: 0, featured: true }
  });
  assert(sb.DrexLivePresence.isLive('u1'), 'u1 en vivo');
  assert(!sb.DrexLivePresence.isLive('u2'), 'u2 (ended) NO cuenta como live');
  var g = sb.DrexLivePresence.getLive('u1');
  assert.strictEqual(g.liveId, 'L1');
  assert.strictEqual(g.viewers, 5);
  assert.strictEqual(g.title, 'T1');
  assert.strictEqual(sb.DrexLivePresence.getFeaturedLive().uid, 'u3', 'featured por flag de doc');
  // el live termina -> desaparece de inmediato (anti anillos fantasma)
  sb._db._push({ L3: { hostUid: 'u3', title: 'T3', status: 'ended' } });
  assert(!sb.DrexLivePresence.isLive('u1'), 'u1 limpio tras snapshot sin su live');
  assert.strictEqual(sb.DrexLivePresence.getFeaturedLive(), null, 'sin live destacado al terminar');
  console.log('ok 3: estado canónico status=live + anti fantasma');
})();

/* ---------- 4. onChange: diff de uids y off sin duplicados ---------- */
(function () {
  var sb = boot(makeSandbox());
  var seen = [];
  var toHost = function (a) { return Array.prototype.slice.call(a); }; // arrays del realm vm fallan en deepStrictEqual
  var off1 = sb.DrexLivePresence.onChange(function (e) { seen.push(['a', toHost(e.changed).sort()]); });
  var off2 = sb.DrexLivePresence.onChange(function (e) { seen.push(['b', toHost(e.changed).sort()]); });
  sb.DrexLivePresence.start();
  sb._db._push({ L1: { hostUid: 'u1', status: 'live' }, L2: { hostUid: 'u2', status: 'live' } });
  assert.deepStrictEqual(seen.length, 2, 'ambos callbacks reciben el diff');
  assert.deepStrictEqual(seen[0][1], ['u1', 'u2']);
  off1(); // desuscribirse: la vista se fue
  sb._db._push({ L1: { hostUid: 'u1', status: 'live' }, L2: { hostUid: 'u2', status: 'live' }, L3: { hostUid: 'u3', status: 'live' } });
  assert.deepStrictEqual(seen.length, 3, 'solo el callback vivo recibe el segundo diff');
  assert.deepStrictEqual(seen[2][1], ['u3'], 'diff = solo el uid nuevo');
  off2();
  assert.strictEqual(sb._db._subCount(), 1, 'la BD sigue con UNA suscripción (los off son de vista)');
  console.log('ok 4: onChange diff + off sin duplicados');
})();

/* ---------- 5. drexLiveRing: anillo visible solo si hay live ---------- */
(function () {
  var sb = boot(makeSandbox());
  sb.DrexLivePresence.start();
  sb._db._push({ L1: { hostUid: 'u1', status: 'live' } });
  var on = sb.window.drexLiveRing('<img src="a.png">', 'u1');
  assert(on.indexOf('is-live') !== -1, 'anillo encendido para u1');
  assert(on.indexOf('data-live-id="L1"') !== -1, 'data-live-id con el live real');
  assert(on.indexOf('EN VIVO') !== -1, 'etiqueta presente');
  assert(on.indexOf('drexLiveRingGo') !== -1, 'tap cableado al visor');
  var off = sb.window.drexLiveRing('<img src="b.png">', 'u9');
  assert(off.indexOf('is-live') === -1, 'sin anillo para uid no en vivo');
  assert(off.indexOf('data-live-id=""') !== -1, 'data-live-id vacío');
  console.log('ok 5: drexLiveRing pinta solo con live activo');
})();

/* ---------- 6. tap: abre el visor; tap fantasma no abre nada ---------- */
(function () {
  var sb = boot(makeSandbox());
  sb.DrexLivePresence.start();
  sb._db._push({ L1: { hostUid: 'u1', status: 'live' } });
  var joined = [];
  sb.window.drexLiveJoin = function (id) { joined.push(id); };
  var stopped = false, prevented = false;
  var el = new FakeEl('span');
  el.setAttribute('data-live-ring-uid', 'u1');
  sb.window.drexLiveRingGo(el, { stopPropagation: function () { stopped = true; }, preventDefault: function () { prevented = true; } });
  assert.deepStrictEqual(joined, ['L1'], 'tap abre el visor con el liveId');
  assert(stopped && prevented, 'el tap no se propaga al botón padre');
  // live terminado después: el tap NO abre (anti fantasma)
  sb._db._push({});
  sb.window.drexLiveRingGo(el, null);
  assert.deepStrictEqual(joined, ['L1'], 'tap fantasma no reabre el visor');
  console.log('ok 6: tap abre visor; tap fantasma seguro');
})();

/* ---------- 7. refreshLiveRingNodes: solo nodos afectados ---------- */
(function () {
  var sb = boot(makeSandbox());
  sb.DrexLivePresence.start();
  var n1 = new FakeEl('span');
  n1.setAttribute('data-live-ring-uid', 'u1');
  n1.classList.add('is-live');
  n1.setAttribute('data-live-id', 'OLD');
  var n2 = new FakeEl('span'); // otro uid, no debe tocarse
  n2.setAttribute('data-live-ring-uid', 'u2');
  n2.classList.add('is-live');
  sb._doc._registry.u1 = [n1];
  sb._doc._registry.u2 = [n2];
  sb.refreshLiveRingNodes(['u1']); // u1 ya no está en vivo (cache vacío)
  assert(!n1.classList.contains('is-live'), 'anillo de u1 apagado');
  assert.strictEqual(n1.getAttribute('data-live-id'), '', 'data-live-id limpiado');
  assert(n2.classList.contains('is-live'), 'u2 intacto (no afectado)');
  console.log('ok 7: actualización dirigida de nodos');
})();

/* ---------- 8. cuenta destacada: resolución email->uid, aparece/desaparece ---------- */
(async function () {
  var sb = boot(makeSandbox());
  sb.DrexLivePresence.start();
  var uid = await sb.DrexLivePresence.resolveFeaturedUid();
  assert.strictEqual(uid, 'uid-featured-123', 'email->uid vía userEmails/');
  sb._db._push({ LF: { hostUid: 'uid-featured-123', title: 'Show', status: 'live', viewers: 12, hostName: 'Drex' } });
  var fl = sb.DrexLivePresence.getFeaturedLive();
  assert(fl && fl.uid === 'uid-featured-123' && fl.liveId === 'LF', 'banner destacado detecta su live');
  sb._db._push({});
  assert.strictEqual(sb.DrexLivePresence.getFeaturedLive(), null, 'banner desaparece al terminar');
  // drexLiveIsFeaturedHost: comparación case-insensitive del email propio
  assert.strictEqual(sb.drexLiveIsFeaturedHost(), true, 'email propio coincide (insensible a mayúsculas)');
  console.log('ok 8: cuenta destacada aparece y desaparece');
})().then(function () {

/* ---------- 9. resolución fallida: silenciosa, sin banner ni errores ---------- */
  var sb = boot(makeSandbox({ emailErr: true }));
  sb.DrexLivePresence.start();
  var logged = [];
  var origErr = console.error;
  console.error = function () { logged.push(Array.prototype.slice.call(arguments).join(' ')); };
  return sb.DrexLivePresence.resolveFeaturedUid().then(function (uid) {
    console.error = origErr;
    assert.strictEqual(uid, '', 'uid vacío en fallo');
    assert.deepStrictEqual(logged, [], 'sin errores en consola');
    assert.strictEqual(sb.DrexLivePresence.getFeaturedLive(), null, 'sin banner destacado');
    console.log('ok 9: fallo de resolución silencioso');
  });
}).then(function () {

/* ---------- 10. banner de perfil muestra/oculta ---------- */
  var sb = boot(makeSandbox());
  sb.DrexLivePresence.start();
  var box = new FakeEl('div');
  box.classList.add('hidden');
  sb._doc._byId['profile-live-banner'] = box;
  sb._db._push({ L1: { hostUid: 'me-1', title: 'Mi show', status: 'live' } });
  sb.window.drexLiveRefreshProfileBanner('me-1', 'profile-live-banner');
  assert(!box.classList.contains('hidden'), 'banner visible durante el live');
  assert(box.innerHTML.indexOf('drexLiveJoin') !== -1, 'banner abre el visor');
  assert(box.innerHTML.indexOf('Ver transmisi') !== -1, 'texto del banner');
  sb._db._push({});
  sb.window.drexLiveRefreshProfileBanner('me-1', 'profile-live-banner');
  assert(box.classList.contains('hidden'), 'banner oculto al terminar');
  assert.strictEqual(box.innerHTML, '', 'banner limpio');
  console.log('ok 10: banner de perfil muestra/oculta');
}).then(function () {

/* ---------- 11. stop/start: limpia caché, una sola suscripción activa ---------- */
  var sb = boot(makeSandbox());
  sb.DrexLivePresence.start();
  sb._db._push({ L1: { hostUid: 'u1', status: 'live' } });
  assert(sb.DrexLivePresence.isLive('u1'));
  sb.DrexLivePresence.stop();
  assert(!sb.DrexLivePresence.isLive('u1'), 'caché limpio al salir');
  assert.strictEqual(sb._db._offCount(), 1, 'watcher detenido');
  sb.DrexLivePresence.start();
  assert.strictEqual(sb._db._subCount(), 2, 're-suscripción única (una a la vez)');
  console.log('ok 11: stop limpia, start re-suscribe una vez');
}).then(function () {

/* ---------- 12. i18n: las 3 claves nuevas en EN/ZH/PT ---------- */
  var i18nSrc = fs.readFileSync(path.join(__dirname, '..', 'drex-i18n.js'), 'utf8');
  var keys = ['"Ver transmisión"', '"Ver ahora"', '"En vivo ahora"'];
  var vals = {
    '"Ver transmisión"': ['"Watch live stream"', '"观看直播"', '"Ver transmissão"'],
    '"Ver ahora"': ['"Watch now"', '"立即观看"', '"Ver agora"'],
    '"En vivo ahora"': ['"Live now"', '"正在直播"', '"Ao vivo agora"']
  };
  keys.forEach(function (k) {
    vals[k].forEach(function (v) {
      assert(i18nSrc.indexOf(k + ':' + v) !== -1, 'i18n ' + k + ' -> ' + v);
    });
  });
  console.log('ok 12: strings nuevos en EN/ZH/PT');

/* ---------- 13. fuente: hunks presentes una sola vez ---------- */
  var must = [
    "window.DREX_FEATURED_LIVE_EMAIL = 'darelvega6@yahoo.com'",
    'window.drexLiveRing = function',
    'window.drexLiveRingGo = function',
    'window.drexLiveRingWrapImg = function',
    'window.drexLiveRefreshProfileBanner = function',
    'id="drex-live-feed-banner"',
    'id="drex-live-search-section"',
    'id="profile-live-banner"',
    'id="author-live-banner"',
    "window.drexLiveRing(`<img id=\"${authorAvatarId}\"",
    'o.commentAuthorId, {fill:true})}',
    'drexLiveIsFeaturedHost()) doc.featured = true;'
  ];
  must.forEach(function (h) {
    var c = src.split(h).length - 1;
    assert.strictEqual(c, 1, 'hunk único en fuente: ' + h);
  });
  console.log('ok 13: hunks únicos en index.html');

  console.log('\nTESTS LIVE PRESENCE: 13/13 PASS');
}).catch(function (e) {
  console.error('FALLO:', e && e.message);
  process.exit(1);
});
