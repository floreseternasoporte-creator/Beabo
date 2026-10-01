#!/usr/bin/env python3
"""Drex Orbit — frontend (index.html). Aplica todos los hunks con conteo exacto.
Regla: un solo script por archivo; cada reemplazo exige count==1 o aborta."""
import sys

P = '/home/hatch/workspace/beabo/index.html'
src = open(P, encoding='utf-8').read()
orig_len = len(src)
n_applied = [0]

def rep(old, new, tag):
    c = src.count(old)
    if c != 1:
        print(f'ABORT [{tag}]: count={c} (esperado 1)')
        sys.exit(1)
    globals()['src'] = src.replace(old, new, 1)
    n_applied[0] += 1
    print(f'ok [{tag}]')

# ================= H1: CSS Drex Orbit =================
ORBIT_CSS = """/* ============ Drex Orbit (suscripción orbit) ============ */
.orbit-avatar-frame{box-shadow:0 0 0 2px #fff,0 0 0 5px #c9a227,0 0 22px rgba(255,190,60,.65)!important}
.orbit-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:9999px;font-size:12px;font-weight:800;color:#3a2b00;background:linear-gradient(135deg,#ffe9a8,#ffd257 45%,#f0b429);box-shadow:0 2px 10px rgba(240,180,41,.45);white-space:nowrap}
.orbit-badge svg{width:14px;height:14px}
.orbit-theme-pick{position:relative;border-radius:14px;overflow:hidden;cursor:pointer;border:2px solid transparent;min-height:64px;display:flex;align-items:flex-end;padding:8px}
.orbit-theme-pick.sel{border-color:var(--drex-brand)}
.orbit-theme-lock{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:4px;background:rgba(0,0,0,.38);color:#fff;font-size:11px;font-weight:800}
.orbit-plan-card{border:2px solid var(--theme-border);border-radius:18px;padding:18px;position:relative;transition:border-color .15s}
.orbit-plan-card.best{border-color:#9D4EDD;box-shadow:0 8px 28px rgba(157,78,221,.25)}
"""
rep('.drex-ad-slot {\n  margin: 12px 16px;', ORBIT_CSS + '.drex-ad-slot {\n  margin: 12px 16px;', 'H1-css')

# ================= H2: núcleo DrexOrbit =================
ORBIT_CORE = r"""/* ============================================================
 * DREX ORBIT — suscripción Orbit de Drex (un nivel: mensual/anual)
 * ------------------------------------------------------------
 * El estado de suscriptor SOLO lo confirma el backend
 * (POST /subscription-status). Sin backend, sin sesión o sin
 * verificar -> NO suscriptor (fail closed). El cliente nunca se
 * auto-declara orbit: ningún flag local otorga acceso.
 * Stripe opera en modo prueba (sandbox).
 * Puertas: window.DREX_ORBIT_ENFORCE === true (apagado en
 * producción hasta que exista una ruta de compra en vivo aprobada).
 * ============================================================ */
var ORBIT_PLANS = {
  monthly: { id: 'monthly', price: '$4.99', per: 'mes' },
  yearly:  { id: 'yearly',  price: '$49.99', per: 'año' }
};
var ORBIT_FEATURES = ['ads_free', 'badge_frame', 'profile_themes', 'live_boost', 'limits_boost', 'analytics', 'gifts', 'priority_support'];

var DrexOrbit = {
  _st: null,
  _ts: 0,
  _endpoint: function () {
    try { return String((typeof DREX_PAYMENTS_ENDPOINT !== 'undefined') ? DREX_PAYMENTS_ENDPOINT : '').replace(/\/+$/, ''); } catch (_) { return ''; }
  },
  isConfigured: function () { return !!this._endpoint(); },
  enforced: function () {
    try { return window.DREX_ORBIT_ENFORCE === true; } catch (_) { return false; }
  },
  _idToken: async function () {
    try { if (typeof DrexCloud !== 'undefined' && DrexCloud.auth) return await DrexCloud.auth().getIdToken(); } catch (_) {}
    return null;
  },
  /* Lee el estado verificado del backend (caché 60 s). Cualquier fallo
   * -> no suscriptor (fail closed). */
  refresh: async function (force) {
    var self = this;
    if (!force && self._st && (Date.now() - self._ts) < 60000) return self._st;
    var fail = { active: false, plan: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, status: 'none' };
    try {
      var endpoint = self._endpoint();
      if (!endpoint) throw new Error('no-endpoint');
      var idToken = await self._idToken();
      if (!idToken) throw new Error('no-token');
      var res = await fetch(endpoint + '/subscription-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: idToken })
      });
      var data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (!res.ok || !data || typeof data.active === 'undefined') throw new Error('bad-status');
      var cpe = data.currentPeriodEnd ? Number(data.currentPeriodEnd) : null;
      self._st = {
        active: data.active === true,
        plan: (data.plan === 'monthly' || data.plan === 'yearly') ? data.plan : null,
        currentPeriodEnd: cpe,
        cancelAtPeriodEnd: !!data.cancelAtPeriodEnd,
        status: String(data.status || 'none')
      };
    } catch (_) { self._st = fail; }
    self._ts = Date.now();
    try { if (typeof window.drexOrbitApplyGates === 'function') window.drexOrbitApplyGates(); } catch (_) {}
    return self._st;
  },
  /* Suscripción verificada en el backend (para mostrar estado). */
  verifiedActive: function () {
    try { return !!(this._st && this._st.active); } catch (_) { return false; }
  },
  /* Acceso real: verificada Y puertas activas. */
  isActive: function () {
    try { return this.enforced() && this.verifiedActive(); } catch (_) { return false; }
  },
  hasAccess: function (feature) {
    try {
      if (ORBIT_FEATURES.indexOf(feature) === -1) return false;
      return this.isActive();
    } catch (_) { return false; }
  },
  /* Solo para pruebas: inyecta un estado ya normalizado como lo haría refresh(). */
  _setTestState: function (st) {
    var fail = { active: false, plan: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, status: 'none' };
    if (!st || typeof st !== 'object') { this._st = fail; }
    else {
      var cpe = st.currentPeriodEnd ? Number(st.currentPeriodEnd) : null;
      this._st = {
        active: st.status === 'canceled' ? false : st.active === true,
        plan: (st.plan === 'monthly' || st.plan === 'yearly') ? st.plan : null,
        currentPeriodEnd: cpe,
        cancelAtPeriodEnd: !!st.cancelAtPeriodEnd,
        status: String(st.status || 'none')
      };
    }
    this._ts = Date.now();
    return this._st;
  },
  plan: function () { return (this._st && this._st.plan) || null; },
  status: function () { return this._st; },
  /* Inicia el Checkout de la suscripción en Stripe. */
  subscribe: async function (planId) {
    var endpoint = this._endpoint();
    if (!endpoint) throw new Error('no-provider');
    if (planId !== 'monthly' && planId !== 'yearly') throw new Error('invalid_plan');
    var idToken = await this._idToken();
    if (!idToken) throw new Error('no-token');
    var returnUrl = '';
    try { returnUrl = location.origin + location.pathname; } catch (_) {}
    var res = await fetch(endpoint + '/create-subscription-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: planId, idToken: idToken, returnUrl: returnUrl })
    });
    var data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok || !data || !data.url) throw new Error(String((data && data.error) || ('http_' + res.status)));
    location.href = data.url;
    return { redirected: true };
  },
  /* Historial real de pagos: GET /transactions con el ID token en Authorization.
   * Devuelve {transactions[], subscription{}}. Listas vacías si no hay datos. */
  transactions: async function () {
    var endpoint = this._endpoint();
    if (!endpoint) throw new Error('no-provider');
    var idToken = await this._idToken();
    if (!idToken) throw new Error('no-token');
    var res = await fetch(endpoint + '/transactions', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + idToken }
    });
    var data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok || !data) throw new Error(String((data && data.error) || ('http_' + res.status)));
    if (!Array.isArray(data.transactions)) data.transactions = [];
    return data;
  },
  /* Abre el portal de facturación de Stripe (gestionar/cancelar). */
  manage: async function () {
    var endpoint = this._endpoint();
    if (!endpoint) throw new Error('no-provider');
    var idToken = await this._idToken();
    if (!idToken) throw new Error('no-token');
    var returnUrl = '';
    try { returnUrl = location.origin + location.pathname; } catch (_) {}
    var res = await fetch(endpoint + '/create-customer-portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: idToken, returnUrl: returnUrl })
    });
    var data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok || !data || !data.url) throw new Error(String((data && data.error) || ('http_' + res.status)));
    location.href = data.url;
    return { redirected: true };
  },
  restore: async function () { return this.refresh(true); }
};

/* Enforcement: las puertas Orbit solo actúan si este flag es true.
 * Permanece en false hasta que exista una ruta de suscripción en vivo válida. */
window.DREX_ORBIT_ENFORCE = false;

/* Puerta central: true = acceso permitido. Si las puertas están activas y
 * no hay suscripción verificada, abre el paywall y devuelve false. */
function orbitGate(feature) {
  try {
    if (typeof DrexOrbit === 'undefined') return true;
    if (!DrexOrbit.enforced()) return true;
    if (DrexOrbit.isActive()) return true;
    if (typeof openOrbitPaywall === 'function') openOrbitPaywall(feature || '');
    return false;
  } catch (_) { return true; }
}

function orbitToast(msg) {
  try {
    if (typeof toast === 'function') { toast(msg); return; }
    if (typeof showMiniToast === 'function') { showMiniToast(msg); return; }
  } catch (_) {}
}

/* Límites vinculados a Drex Orbit. Sin puertas activas no cambia nada. */
function drexOrbitVideoPostMaxSec() { try { return DrexOrbit.isActive() ? 180 : 60; } catch (_) { return 60; } }
function drexOrbitCamMaxSec() { try { return DrexOrbit.isActive() ? 180 : 60; } catch (_) { return 60; } }
function drexOrbitPhotosMax() { try { return DrexOrbit.isActive() ? 40 : 20; } catch (_) { return 20; } }
function drexOrbitSchedLivesMax() {
  try {
    if (DrexOrbit.isActive()) return 10;
    if (DrexOrbit.enforced()) return 3;
  } catch (_) {}
  return Infinity;
}
function drexOrbitLiveMaxMs() {
  try {
    if (DrexOrbit.isActive()) return 12 * 3600 * 1000;
    if (DrexOrbit.enforced()) return 4 * 3600 * 1000;
  } catch (_) {}
  return 0;
}

/* Aplica las puertas globales (anuncios, vista previa en ajustes). */
window.drexOrbitApplyGates = function () {
  try {
    var on = (typeof DrexOrbit !== 'undefined') && DrexOrbit.isActive();
    document.querySelectorAll('.drex-ad-slot').forEach(function (el) {
      el.style.display = on ? 'none' : '';
    });
  } catch (_) {}
  try { if (typeof renderOrbitSettingsPreview === 'function') renderOrbitSettingsPreview(); } catch (_) {}
};

function orbitIconSVG(cls) {
  return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 8.2 7.2 11 12 4.5 16.8 11 21 8.2 19.4 17.5H4.6L3 8.2zm.7 10.6h16.6v1.7H3.7v-1.7z"/></svg>';
}
function orbitBadgeHTML() {
  return '<span class="orbit-badge">' + orbitIconSVG('') + '<span>Drex Orbit</span></span>';
}

/* Insignia + marco en el perfil propio. */
async function refreshOrbitProfileBadge() {
  var badgeEl = document.getElementById('orbit-profile-badge');
  var imgEl = document.getElementById('profile-image');
  var active = false;
  try { active = (typeof DrexOrbit !== 'undefined') && DrexOrbit.isActive(); } catch (_) {}
  if (badgeEl) {
    if (active) { badgeEl.classList.remove('hidden'); badgeEl.innerHTML = orbitBadgeHTML(); }
    else { badgeEl.classList.add('hidden'); badgeEl.innerHTML = ''; }
  }
  try { if (imgEl) imgEl.classList.toggle('orbit-avatar-frame', !!active); } catch (_) {}
  try { if (typeof applyOrbitProfileTheme === 'function') applyOrbitProfileTheme(); } catch (_) {}
}

/* Insignia + marco en el perfil de otro autor (lee su estado público). */
async function refreshOrbitAuthorBadge(authorId) {
  var badgeEl = document.getElementById('orbit-author-badge');
  var imgEl = document.getElementById('author-profile-image');
  var active = false;
  try {
    if (authorId && typeof DrexOrbit !== 'undefined' && DrexOrbit.enforced()) {
      var cache = window._orbitBadgeCache || (window._orbitBadgeCache = {});
      var c = cache[authorId];
      if (!c || (Date.now() - c.ts) > 300000) {
        var v = null;
        try {
          var snap = await DrexCloud.database().ref('users/' + authorId + '/orbit').once('value');
          v = snap && snap.val();
        } catch (_) { v = null; }
        var st = null;
        if (v && typeof v === 'object') st = v;
        else if (typeof v === 'string' && v) { try { st = JSON.parse(v); } catch (_) {} }
        var ok = !!(st && st.status === 'active');
        if (ok && st.currentPeriodEnd) { try { ok = Number(st.currentPeriodEnd) * 1000 > Date.now(); } catch (_) {} }
        c = { active: ok, ts: Date.now() };
        cache[authorId] = c;
      }
      active = !!c.active;
    }
  } catch (_) { active = false; }
  if (badgeEl) {
    if (active) { badgeEl.classList.remove('hidden'); badgeEl.innerHTML = orbitBadgeHTML(); }
    else { badgeEl.classList.add('hidden'); badgeEl.innerHTML = ''; }
  }
  try { if (imgEl) imgEl.classList.toggle('orbit-avatar-frame', !!active); } catch (_) {}
}

"""
old_core = """  location.href = data.url; /* Stripe Checkout; el retorno trae ?coins=success */
  return { redirected: true };
}

var DrexCoins = {"""
rep(old_core, old_core.replace('var DrexCoins = {', ORBIT_CORE + 'var DrexCoins = {'), 'H2-core')

# ================= H2b: UI de Drex Orbit (vista, paywall, temas, analíticas) =================
ORBIT_UI = r"""
/* ============ Drex Orbit: vista, paywall, temas, analíticas ============ */
function orbitPlanName(plan) {
  return plan === 'yearly' ? t('Anual') : t('Mensual');
}
function orbitPlanPrice(plan) {
  return (ORBIT_PLANS[plan] || ORBIT_PLANS.monthly).price + ' ' + t(plan === 'yearly' ? 'al año' : 'al mes');
}
function orbitFmtDate(ms) {
  try {
    var lang = (typeof getAppLanguage === 'function') ? getAppLanguage() : 'es';
    var loc = lang === 'zh' ? 'zh-CN' : (lang === 'en' ? 'en-US' : (lang === 'pt' ? 'pt-BR' : 'es-ES'));
    return new Date(ms).toLocaleDateString(loc, { day: 'numeric', month: 'long', year: 'numeric' });
  } catch (_) { return ''; }
}
function orbitBenefits() {
  return [
    { f: 'no_ads',           e: '🚫', title: t('Sin anuncios'),               desc: t('Navega Drex sin publicidad.') },
    { f: 'badge',            e: '👑', title: t('Insignia y marco exclusivos'), desc: t('Distintivo dorado Drex Orbit y marco en tu foto.') },
    { f: 'profile_themes',   e: '🎨', title: t('Temas de perfil Orbit'),    desc: t('Fondos exclusivos para tu portada.') },
    { f: 'live_pro',         e: '📡', title: t('En vivos potenciados'),       desc: t('Más duración, calidad HD y más en vivos programados.') },
    { f: 'limits',           e: '🧩', title: t('Límites elevados'),           desc: t('Videos más largos, más fotos y publicaciones programadas.') },
    { f: 'analytics',        e: '📊', title: t('Analíticas de creador'),      desc: t('Estadísticas avanzadas de tu contenido.') },
    { f: 'exclusive_gifts',  e: '🎁', title: t('Regalos exclusivos'),         desc: t('Regalos originales solo para miembros Drex Orbit.') },
    { f: 'priority_support',  e: '🎧', title: t('Soporte prioritario'),        desc: t('Tus reportes se atienden primero.') }
  ];
}

function openOrbitView() {
  var v = document.getElementById('orbit-view');
  if (!v) return;
  if (v.parentElement !== document.body) document.body.appendChild(v);
  v.classList.remove('hidden');
  try { if (typeof window._pushOverlayBackGuard === 'function') window._pushOverlayBackGuard(); } catch (_) {}
  renderOrbitView();
}
function closeOrbitView() {
  var v = document.getElementById('orbit-view');
  if (v) v.classList.add('hidden');
}

function renderOrbitSettingsPreview() {
  var el = document.getElementById('orbit-settings-preview');
  if (!el) return;
  var txt = t('Sin anuncios, insignia exclusiva y mucho más.');
  try {
    var s = (typeof DrexOrbit !== 'undefined') ? DrexOrbit.status() : null;
    if (s && s.active) txt = t('Miembro activo') + ' · ' + orbitPlanName(s.plan);
  } catch (_) {}
  el.textContent = txt;
}
/* La tarjeta de Ajustes muestra el subtítulo traducido desde el arranque. */
try {
  var __orbitPrevBoot = function () { try { renderOrbitSettingsPreview(); } catch (_) {} };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __orbitPrevBoot);
  else __orbitPrevBoot();
} catch (_) {}

async function renderOrbitView() {
  var body = document.getElementById('orbit-view-content');
  if (!body) return;
  var titleEl = document.getElementById('orbit-view-title');
  if (titleEl) titleEl.textContent = 'Drex Orbit';
  var st = null;
  try { st = await DrexOrbit.refresh(); } catch (_) { st = null; }
  var configured = DrexOrbit.isConfigured();
  var verified = !!(st && st.active);
  var escFn = (typeof escapeHtml === 'function') ? escapeHtml : function (s) { return String(s == null ? '' : s); };

  var html = '<div class="px-5 pt-2 pb-4 text-center">'
    + '<div class="mx-auto w-20 h-20 rounded-3xl flex items-center justify-center text-white mb-3" style="background:linear-gradient(135deg,#2F33B8,#9D4EDD);box-shadow:0 10px 30px rgba(109,40,217,.45)">'
    + orbitIconSVG('w-10 h-10') + '</div>'
    + '<h2 class="text-2xl font-black text-[var(--theme-text)]">Drex Orbit</h2>'
    + '<p class="text-sm text-[var(--theme-muted)] mt-1">' + escFn(t('El plan Orbit de Drex')) + '</p></div>';

  if (!configured) {
    html += '<div class="mx-5 rounded-2xl p-5 text-center text-sm text-[var(--theme-muted)] bg-[var(--theme-surface-subtle)]">'
      + escFn(t('Drex Orbit no está disponible en este momento. Inténtalo más tarde.')) + '</div>';
  } else if (verified) {
    var renewTxt = st.currentPeriodEnd ? orbitFmtDate(st.currentPeriodEnd * 1000) : '';
    html += '<div class="mx-5 rounded-2xl p-5 text-white" style="background:linear-gradient(135deg,#2F33B8,#6D28D9)">'
      + '<div class="flex items-center gap-2 text-white/90">' + orbitIconSVG('w-5 h-5') + '<span class="font-black text-lg">' + escFn(t('Tu suscripción')) + '</span></div>'
      + '<div class="text-white/85 text-sm mt-1 font-semibold">' + escFn(orbitPlanName(st.plan)) + ' · ' + escFn(orbitPlanPrice(st.plan)) + '</div>'
      + (renewTxt ? '<div class="text-white/75 text-xs mt-1">' + escFn(st.cancelAtPeriodEnd ? t('Se cancela al final del periodo') : (t('Se renueva el') + ' ' + renewTxt)) + '</div>' : '')
      + (st.status === 'past_due' ? '<div class="mt-3 text-xs font-bold bg-yellow-400/20 rounded-xl px-3 py-2">' + escFn(t('Tu último pago falló. Actualiza tu método de pago para mantener Drex Orbit.')) + '</div>' : '')
      + '<div class="flex gap-2 mt-4">'
      + '<button onclick="orbitManage()" class="tap44 flex-1 min-h-[44px] rounded-xl bg-white text-[#2F33B8] font-extrabold text-sm active:opacity-80">' + escFn(t('Gestionar suscripción')) + '</button>'
      + '<button onclick="orbitRestore()" class="tap44 min-h-[44px] px-4 rounded-xl bg-white/15 text-white font-bold text-sm active:opacity-80">' + escFn(t('Restaurar compra')) + '</button>'
      + '</div></div>';
    html += '<div class="px-5 mt-5"><h3 class="font-extrabold text-[var(--theme-text)] text-[15px]">' + escFn(t('Tus beneficios')) + '</h3>'
      + '<div class="grid grid-cols-1 gap-2 mt-2">'
      + orbitBenefits().map(function (b) {
          return '<div class="flex items-center gap-3 rounded-2xl border border-[var(--theme-border)] p-3">'
            + '<span class="text-2xl">' + b.e + '</span>'
            + '<span class="min-w-0"><span class="block font-bold text-[var(--theme-text)] text-sm">' + escFn(b.title) + '</span>'
            + '<span class="block text-xs text-[var(--theme-muted)]">' + escFn(b.desc) + '</span></span></div>';
        }).join('')
      + '</div></div>';
  } else {
    html += '<div class="px-5 grid grid-cols-1 gap-2">'
      + orbitBenefits().map(function (b) {
          return '<div class="flex items-center gap-3 rounded-2xl border border-[var(--theme-border)] p-3">'
            + '<span class="text-2xl">' + b.e + '</span>'
            + '<span class="min-w-0"><span class="block font-bold text-[var(--theme-text)] text-sm">' + escFn(b.title) + '</span>'
            + '<span class="block text-xs text-[var(--theme-muted)]">' + escFn(b.desc) + '</span></span></div>';
        }).join('')
      + '</div>';
    var card = function (planId, best) {
      var p = ORBIT_PLANS[planId];
      return '<div class="orbit-plan-card' + (best ? ' best' : '') + ' bg-[var(--theme-surface)]">'
        + (best ? '<span class="absolute -top-3 left-4 text-[11px] font-black text-white px-2.5 py-1 rounded-full" style="background:linear-gradient(135deg,#9D4EDD,#6D28D9)">' + escFn(t('Ahorra 2 meses')) + '</span>' : '')
        + '<div class="font-extrabold text-[var(--theme-text)]">' + escFn(orbitPlanName(planId)) + '</div>'
        + '<div class="mt-1"><span class="text-3xl font-black text-[var(--theme-text)]">' + escFn(p.price) + '</span>'
        + '<span class="text-sm text-[var(--theme-muted)]"> ' + escFn(p.price + ' ' + t(planId === 'yearly' ? 'al año' : 'al mes')) + '</span></div>'
        + '<button onclick="orbitSubscribe(\'' + planId + '\')" class="tap44 w-full min-h-[48px] mt-3 rounded-xl font-extrabold text-white active:opacity-80" style="background:linear-gradient(135deg,#2F33B8,#9D4EDD)">' + escFn(t('Suscribirme')) + '</button>'
        + '</div>';
    };
    html += '<div class="px-5 mt-5"><h3 class="font-extrabold text-[var(--theme-text)] text-[15px] mb-2">' + escFn(t('Elegir plan')) + '</h3>'
      + '<div class="grid grid-cols-1 gap-3">' + card('monthly', false) + card('yearly', true) + '</div>'
      + '<p class="text-[11px] text-[var(--theme-muted)] text-center mt-3 leading-relaxed">'
      + escFn(t('Pago 100% seguro con Stripe. Sin permanencia. Cancela cuando quieras.')) + '</p></div>';
  }

  /* Tema de perfil */
  html += '<div class="px-5 mt-6"><h3 class="font-extrabold text-[var(--theme-text)] text-[15px]">' + escFn(t('Tema de perfil')) + '</h3>'
    + '<p class="text-xs text-[var(--theme-muted)] mt-0.5">' + escFn(t('Elige el fondo de tu portada')) + '</p>'
    + '<div id="orbit-themes-row" class="grid grid-cols-3 gap-2.5 mt-3"></div></div>';

  /* Analíticas */
  html += '<div class="px-5 mt-6 mb-10"><button onclick="orbitOpenAnalytics()" class="tap44 w-full min-h-[52px] rounded-2xl border border-[var(--theme-border)] flex items-center gap-3 px-4 active:opacity-70 text-left">'
    + '<span class="text-2xl">📊</span><span class="min-w-0"><span class="block font-bold text-[var(--theme-text)] text-sm">' + escFn(t('Analíticas de creador')) + '</span>'
    + '<span class="block text-xs text-[var(--theme-muted)]">' + escFn(t('Tus números reales, actualizados al abrir.')) + '</span></span>'
    + '<span class="ml-auto text-[var(--theme-muted)]">›</span></button></div>';

  body.innerHTML = html;
  renderOrbitThemesRow();
}

async function orbitSubscribe(planId) {
  orbitToast(t('Procesando…'));
  try { await DrexOrbit.subscribe(planId); }
  catch (e) {
    var m = String((e && e.message) || '');
    if (m === 'no-provider' || m === 'subscription_not_configured' || m === 'http_503') orbitToast(t('Drex Orbit no está disponible en este momento. Inténtalo más tarde.'));
    else if (m === 'no-token') orbitToast(t('Inicia sesión para suscribirte a Drex Orbit.'));
    else orbitToast(t('Error al iniciar el pago. Inténtalo de nuevo.'));
  }
}
async function orbitManage() {
  orbitToast(t('Procesando…'));
  try { await DrexOrbit.manage(); }
  catch (e) {
    var m = String((e && e.message) || '');
    if (m === 'no_subscription') orbitToast(t('No tienes una suscripción activa.'));
    else orbitToast(t('No se pudo abrir la gestión de la suscripción. Inténtalo de nuevo.'));
  }
}
async function orbitRestore() {
  orbitToast(t('Procesando…'));
  try {
    var s = await DrexOrbit.restore();
    if (s && s.active) orbitToast(t('¡Bienvenido a Drex Orbit! Tu suscripción ya está activa.'));
    else orbitToast(t('No encontramos una suscripción activa en tu cuenta.'));
  } catch (_) { orbitToast(t('No se pudo verificar tu suscripción. Inténtalo de nuevo.')); }
  renderOrbitView();
}

/* ---------- paywall ---------- */
function orbitPaywallCopy(feature) {
  var map = {
    live_pro:        { e: '📡', title: t('En vivos potenciados'),        desc: t('Más duración, calidad HD y más en vivos programados.') },
    limits:          { e: '🧩', title: t('Límites elevados'),            desc: t('Videos más largos, más fotos y publicaciones programadas.') },
    analytics:       { e: '📊', title: t('Analíticas de creador'),       desc: t('Estadísticas avanzadas de tu contenido.') },
    exclusive_gifts: { e: '🎁', title: t('Regalos exclusivos'),          desc: t('Regalos originales solo para miembros Drex Orbit.') },
    profile_themes:  { e: '🎨', title: t('Temas de perfil Orbit'),     desc: t('Fondos exclusivos para tu portada.') },
    no_ads:          { e: '🚫', title: t('Sin anuncios'),                desc: t('Navega Drex sin publicidad.') },
    badge:           { e: '👑', title: t('Insignia y marco exclusivos'), desc: t('Distintivo dorado Drex Orbit y marco en tu foto.') },
    priority_support:{ e: '🎧', title: t('Soporte prioritario'),         desc: t('Tus reportes se atienden primero.') }
  };
  return map[feature] || { e: '👑', title: 'Drex Orbit', desc: t('El plan Orbit de Drex') };
}
function openOrbitPaywall(feature) {
  var sheet = document.getElementById('orbit-paywall');
  var card = document.getElementById('orbit-paywall-card');
  if (!sheet || !card) return;
  var c = orbitPaywallCopy(feature);
  var escFn = (typeof escapeHtml === 'function') ? escapeHtml : function (s) { return String(s == null ? '' : s); };
  card.innerHTML = '<div class="w-10 h-1.5 rounded-full bg-[var(--theme-border)] mx-auto mb-4"></div>'
    + '<div class="text-center"><div class="text-5xl">' + c.e + '</div>'
    + '<h3 class="text-xl font-black text-[var(--theme-text)] mt-3">' + escFn(t('Esta función es de Drex Orbit')) + '</h3>'
    + '<p class="text-sm text-[var(--theme-muted)] mt-1.5 leading-relaxed"><b class="text-[var(--theme-text)]">' + escFn(c.title) + '.</b> ' + escFn(c.desc) + '<br>' + escFn(t('Suscríbete para desbloquearla y apoyar a Drex.')) + '</p>'
    + '<div class="mt-3 inline-flex items-center gap-2 rounded-full bg-[var(--theme-surface-subtle)] px-4 py-2 text-sm font-extrabold text-[var(--theme-text)]">$4.99 ' + escFn(t('al mes')) + ' · $49.99 ' + escFn(t('al año')) + '</div>'
    + '<button onclick="closeOrbitPaywall();openOrbitView()" class="tap44 w-full min-h-[52px] mt-4 rounded-2xl font-extrabold text-white active:opacity-80" style="background:linear-gradient(135deg,#2F33B8,#9D4EDD)">' + escFn(t('Ver planes')) + '</button>'
    + '<button onclick="closeOrbitPaywall()" class="tap44 w-full min-h-[44px] mt-1 rounded-2xl font-bold text-[var(--theme-muted)] active:opacity-70">' + escFn(t('Ahora no')) + '</button>'
    + '<p class="text-[11px] text-[var(--theme-muted)] mt-2">' + escFn(t('Sin permanencia. Cancela cuando quieras.')) + '</p></div>';
  if (sheet.parentElement !== document.body) document.body.appendChild(sheet);
  sheet.classList.remove('hidden');
  try { if (typeof window._pushOverlayBackGuard === 'function') window._pushOverlayBackGuard(); } catch (_) {}
}
function closeOrbitPaywall() {
  var sheet = document.getElementById('orbit-paywall');
  if (sheet) sheet.classList.add('hidden');
}

/* ---------- temas de perfil ---------- */
var ORBIT_PROFILE_THEMES = [
  { id: 'default',   pro: false, css: 'radial-gradient(120% 170% at 15% 0%, #33507f 0%, #1c2b4a 48%, #0e1a33 100%)' },
  { id: 'indigo',    pro: false, css: 'linear-gradient(135deg,#2F33B8,#6D28D9)' },
  { id: 'midnight',  pro: false, css: 'linear-gradient(135deg,#0b0e1a,#1a2140)' },
  { id: 'dorado',    pro: true,  css: 'linear-gradient(135deg,#8a6d1a,#f0b429 45%,#fff3c4)' },
  { id: 'oceano',    pro: true,  css: 'linear-gradient(135deg,#062a4a,#0e7c86 60%,#37e0c8)' },
  { id: 'atardecer', pro: true,  css: 'linear-gradient(135deg,#3b1d5e,#d6407a 55%,#ffb35c)' },
  { id: 'galaxia',   pro: true,  css: 'radial-gradient(120% 170% at 80% 10%, #5b2a86 0%, #1c1440 55%, #0a0620 100%)' },
  { id: 'esmeralda', pro: true,  css: 'linear-gradient(135deg,#06382b,#0e9f6e 60%,#7cf5c8)' },
  { id: 'neon',      pro: true,  css: 'linear-gradient(135deg,#12041f,#7b1fa2 50%,#00e5ff)' }
];
function orbitThemeById(id) {
  for (var i = 0; i < ORBIT_PROFILE_THEMES.length; i++) if (ORBIT_PROFILE_THEMES[i].id === id) return ORBIT_PROFILE_THEMES[i];
  return ORBIT_PROFILE_THEMES[0];
}
function orbitThemeName(id) {
  var map = { default: t('Predeterminado'), indigo: t('Índigo'), midnight: t('Medianoche'), dorado: t('Dorado'), oceano: t('Océano'), atardecer: t('Atardecer'), galaxia: t('Galaxia'), esmeralda: t('Esmeralda'), neon: t('Neón') };
  return map[id] || id;
}
async function orbitCurrentThemeId() {
  try {
    var me = (typeof liveUser === 'function') ? liveUser() : ((typeof DrexCloud !== 'undefined' && DrexCloud.auth().currentUser) || null);
    if (!me || !me.uid) return 'default';
    var snap = await DrexCloud.database().ref('users/' + me.uid + '/profileTheme').once('value');
    var v = snap && snap.val();
    if (typeof v === 'string' && orbitThemeById(v)) return v;
  } catch (_) {}
  return 'default';
}
async function renderOrbitThemesRow() {
  var row = document.getElementById('orbit-themes-row');
  if (!row) return;
  var cur = await orbitCurrentThemeId();
  var escFn = (typeof escapeHtml === 'function') ? escapeHtml : function (s) { return String(s == null ? '' : s); };
  row.innerHTML = ORBIT_PROFILE_THEMES.map(function (th) {
    return '<div class="orbit-theme-pick' + (cur === th.id ? ' sel' : '') + '" style="background:' + th.css + '" onclick="setOrbitProfileTheme(\'' + th.id + '\')" role="button" tabindex="0">'
      + (th.pro ? '<span class="orbit-theme-lock">👑 ' + escFn(t('Solo Drex Orbit')) + '</span>' : '')
      + '<span class="relative text-[11px] font-extrabold text-white drop-shadow">' + escFn(orbitThemeName(th.id)) + '</span></div>';
  }).join('');
}
async function setOrbitProfileTheme(id) {
  var th = orbitThemeById(id);
  if (th.pro && typeof orbitGate === 'function' && !orbitGate('profile_themes')) return;
  try {
    var me = (typeof liveUser === 'function') ? liveUser() : ((typeof DrexCloud !== 'undefined' && DrexCloud.auth().currentUser) || null);
    if (!me || !me.uid) { orbitToast(t('Inicia sesión para personalizar tu perfil.')); return; }
    await DrexCloud.database().ref('users/' + me.uid + '/profileTheme').set(id);
    applyOrbitProfileTheme();
    renderOrbitThemesRow();
    orbitToast(t('Tema aplicado'));
  } catch (_) { orbitToast(t('No se pudo guardar el tema. Inténtalo de nuevo.')); }
}
async function applyOrbitProfileTheme() {
  try {
    var me = (typeof liveUser === 'function') ? liveUser() : ((typeof DrexCloud !== 'undefined' && DrexCloud.auth().currentUser) || null);
    if (!me || !me.uid) return;
    var tid = await orbitCurrentThemeId();
    var th = orbitThemeById(tid);
    if (th.pro && !((typeof DrexOrbit !== 'undefined') && DrexOrbit.isActive())) th = ORBIT_PROFILE_THEMES[0];
    ['my-profile-cover', 'my-profile-cover-desktop'].forEach(function (cid) {
      var cover = document.getElementById(cid);
      if (cover) cover.style.background = th.css;
    });
  } catch (_) {}
}

/* ---------- analíticas de creador ---------- */
function orbitOpenAnalytics() {
  if (typeof orbitGate === 'function' && !orbitGate('analytics')) return;
  var v = document.getElementById('orbit-analytics-view');
  if (!v) return;
  if (v.parentElement !== document.body) document.body.appendChild(v);
  v.classList.remove('hidden');
  try { if (typeof window._pushOverlayBackGuard === 'function') window._pushOverlayBackGuard(); } catch (_) {}
  renderOrbitAnalytics();
}
function orbitCloseAnalytics() {
  var v = document.getElementById('orbit-analytics-view');
  if (v) v.classList.add('hidden');
}
async function renderOrbitAnalytics() {
  var body = document.getElementById('orbit-analytics-content');
  if (!body) return;
  var titleEl = document.getElementById('orbit-analytics-title');
  if (titleEl) titleEl.textContent = t('Analíticas de creador');
  var escFn = (typeof escapeHtml === 'function') ? escapeHtml : function (s) { return String(s == null ? '' : s); };
  body.innerHTML = '<p class="text-sm text-[var(--theme-muted)] text-center py-8">' + escFn(t('Cargando…')) + '</p>';
  var me = null;
  try { me = (typeof liveUser === 'function') ? liveUser() : ((typeof DrexCloud !== 'undefined' && DrexCloud.auth().currentUser) || null); } catch (_) {}
  var posts = '—', followers = '—', following = '—';
  if (me && me.uid) {
    try {
      var q = await DrexCloud.database().ref('communityNotes').orderByChild('authorId').equalTo(me.uid).once('value');
      posts = q ? q.numChildren() : 0;
    } catch (_) {}
    try {
      var f1 = await DrexCloud.database().ref('followers/' + me.uid).once('value');
      followers = f1 ? f1.numChildren() : 0;
    } catch (_) {}
    try {
      var f2 = await DrexCloud.database().ref('following/' + me.uid).once('value');
      following = f2 ? f2.numChildren() : 0;
    } catch (_) {}
  }
  var fmt = function (n) { try { return (typeof formatNumber === 'function' && typeof n === 'number') ? formatNumber(n) : String(n); } catch (_) { return String(n); } };
  var cardStat = function (label, val) {
    return '<div class="rounded-2xl border border-[var(--theme-border)] p-4 text-center">'
      + '<div class="text-2xl font-black text-[var(--theme-text)]">' + escFn(fmt(val)) + '</div>'
      + '<div class="text-xs text-[var(--theme-muted)] mt-1">' + escFn(label) + '</div></div>';
  };
  body.innerHTML = '<p class="text-xs text-[var(--theme-muted)] px-5 pt-1 pb-3">' + escFn(t('Tus números reales, actualizados al abrir.')) + '</p>'
    + '<div class="px-5 grid grid-cols-3 gap-2.5">'
    + cardStat(t('Publicaciones'), posts)
    + cardStat(t('Seguidores'), followers)
    + cardStat(t('Siguiendo'), following)
    + '</div>'
    + '<div class="mx-5 mt-4 rounded-2xl p-4 text-center text-xs text-[var(--theme-muted)] bg-[var(--theme-surface-subtle)]">'
    + '🔜 ' + escFn(t('Próximamente: alcance, visitas al perfil y votos por publicación.')) + '</div>';
}
/* ============ Pagos: historial real + gestión de suscripción ============ */
function openPaymentsView() {
  var v = document.getElementById('payments-view');
  if (!v) return;
  if (v.parentElement !== document.body) document.body.appendChild(v);
  v.classList.remove('hidden');
  try { if (typeof window._pushOverlayBackGuard === 'function') window._pushOverlayBackGuard(); } catch (_) {}
  renderPaymentsView();
}
function closePaymentsView() {
  var v = document.getElementById('payments-view');
  if (v) v.classList.add('hidden');
}
function renderPagosSettingsPreview() {
  try {
    var tEl = document.getElementById('pagos-settings-title');
    if (tEl && typeof t === 'function') tEl.textContent = t('Pagos');
    var sEl = document.getElementById('pagos-settings-preview');
    if (sEl && typeof t === 'function') sEl.textContent = t('Historial de pagos y compras');
  } catch (_) {}
}
try {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderPagosSettingsPreview);
  else renderPagosSettingsPreview();
} catch (_) {}
function orbitTxStatusLabel(status) {
  if (status === 'completed') return t('Completado');
  if (status === 'failed') return t('Fallido');
  return String(status || '');
}
function orbitTxAmount(tx) {
  try {
    if (tx.type === 'coins') {
      if (tx.cents != null) return '$' + (tx.cents / 100).toFixed(2) + ' · ' + tx.amount + ' ' + t('monedas');
      return tx.amount + ' ' + t('monedas');
    }
    var cur = String(tx.currency || 'usd').toUpperCase();
    var sym = cur === 'USD' ? '$' : (cur + ' ');
    return sym + (Number(tx.amount || 0) / 100).toFixed(2);
  } catch (_) { return ''; }
}
async function renderPaymentsView() {
  var body = document.getElementById('payments-view-content');
  if (!body) return;
  var titleEl = document.getElementById('payments-view-title');
  if (titleEl) titleEl.textContent = t('Pagos');
  var escFn = (typeof escapeHtml === 'function') ? escapeHtml : function (s) { return String(s == null ? '' : s); };
  body.innerHTML = '<div class="px-5 py-10 text-center text-sm text-[var(--theme-muted)]">' + escFn(t('Cargando tu historial…')) + '</div>';

  var data = null, err = null;
  try { data = await DrexOrbit.transactions(); }
  catch (e) { err = e; data = null; }

  if (err || !data) {
    body.innerHTML = '<div class="px-5 py-10 text-center">'
      + '<p class="text-sm text-[var(--theme-muted)]">' + escFn(t('No pudimos cargar tu historial. Inténtalo de nuevo.')) + '</p>'
      + '<button onclick="renderPaymentsView()" class="tap44 mt-4 min-h-[44px] px-6 rounded-2xl font-extrabold text-white active:opacity-80" style="background:linear-gradient(135deg,#2F33B8,#9D4EDD)">' + escFn(t('Reintentar')) + '</button></div>';
    return;
  }

  var html = '<div class="px-5 pt-4"><p class="text-[13px] text-[var(--theme-muted)]">' + escFn(t('Tus movimientos reales de Drex Coins y Drex Orbit.')) + '</p></div>';

  /* Suscripción activa: plan, renovación y gestión vía portal de Stripe. */
  var sub = data.subscription || {};
  if (sub.active) {
    var renewTxt = sub.currentPeriodEnd ? orbitFmtDate(sub.currentPeriodEnd * 1000) : '';
    html += '<div class="mx-5 mt-4 rounded-2xl p-5 text-white" style="background:linear-gradient(135deg,#2F33B8,#6D28D9)">'
      + '<div class="flex items-center gap-2 text-white/90">' + orbitIconSVG('w-5 h-5') + '<span class="font-black text-[16px]">' + escFn(t('Suscripción Drex Orbit')) + '</span></div>'
      + '<div class="text-white/85 text-sm mt-1 font-semibold">' + escFn(t('Plan actual')) + ': ' + escFn(orbitPlanName(sub.plan)) + ' · ' + escFn(orbitPlanPrice(sub.plan)) + '</div>'
      + (renewTxt ? '<div class="text-white/75 text-xs mt-1">' + escFn(sub.cancelAtPeriodEnd ? t('Se cancela al final del periodo') : (t('Se renueva el') + ' ' + renewTxt)) + '</div>' : '')
      + '<button onclick="orbitManage()" class="tap44 w-full min-h-[44px] mt-4 rounded-xl bg-white text-[#2F33B8] font-extrabold text-sm active:opacity-80">' + escFn(t('Gestionar en el portal seguro de Stripe')) + '</button>'
      + '<p class="text-white/60 text-[11px] mt-2 text-center">' + escFn(t('Cancelar suscripción')) + ' · ' + escFn(t('Cambiar de plan')) + ' · ' + escFn(t('Actualizar método de pago')) + '</p>'
      + '</div>';
  }

  /* Historial de transacciones reales. */
  html += '<div class="px-5 mt-6"><h3 class="font-extrabold text-[var(--theme-text)] text-[15px]">' + escFn(t('Historial de pagos y compras')) + '</h3>';
  var txs = data.transactions || [];
  if (!txs.length) {
    html += '<div class="mt-3 rounded-2xl border border-dashed border-[var(--theme-border)] p-8 text-center">'
      + '<div class="text-4xl mb-2">🧾</div>'
      + '<p class="font-bold text-[var(--theme-text)] text-sm">' + escFn(t('Aún no tienes movimientos')) + '</p>'
      + '<p class="text-xs text-[var(--theme-muted)] mt-1">' + escFn(t('Tus compras y pagos aparecerán aquí automáticamente.')) + '</p></div>';
  } else {
    html += '<div class="grid grid-cols-1 gap-2 mt-3">';
    txs.forEach(function (tx) {
      var icon = tx.type === 'coins' ? '🪙' : '🪐';
      var label = tx.type === 'coins' ? t('Compra de Drex Coins') : t('Pago de Drex Orbit');
      var dt = tx.ts ? orbitFmtDate(Number(tx.ts)) : '';
      var stLbl = orbitTxStatusLabel(tx.status);
      var stColor = tx.status === 'completed' ? 'text-green-600' : (tx.status === 'failed' ? 'text-red-500' : 'text-[var(--theme-muted)]');
      html += '<div class="flex items-center gap-3 rounded-2xl border border-[var(--theme-border)] p-3 bg-[var(--theme-surface)]">'
        + '<span class="text-2xl shrink-0">' + icon + '</span>'
        + '<span class="flex-1 min-w-0"><span class="block font-bold text-[var(--theme-text)] text-sm truncate">' + escFn(label) + '</span>'
        + '<span class="block text-xs text-[var(--theme-muted)] truncate">' + escFn(tx.label || '') + (dt ? ' · ' + escFn(dt) : '') + '</span></span>'
        + '<span class="text-right shrink-0"><span class="block font-extrabold text-[var(--theme-text)] text-sm">' + escFn(orbitTxAmount(tx)) + '</span>'
        + '<span class="block text-[11px] font-semibold ' + stColor + '">' + escFn(stLbl) + '</span></span></div>';
    });
    html += '</div>';
  }
  html += '</div>';
  body.innerHTML = html;
}

"""
old_core2 = "var DrexCoins = {"
rep(old_core2, ORBIT_UI + old_core2, 'H2b-ui')

# ================= H3: retorno ?orbit=success =================
ORBIT_RETURN = r"""// Retorno de Stripe Checkout (Drex Orbit): ?orbit=success | ?orbit=cancelled.
// La suscripción la activa el webhook en el servidor; aquí solo se avisa,
// se refresca el estado verificado y se limpia la URL.
(function captureOrbitReturn() {
  try {
    var q = new URLSearchParams(location.search);
    var st = q.get('orbit');
    if (st !== 'success' && st !== 'cancelled') return;
    try { var url = new URL(location.href); url.search = ''; history.replaceState(null, '', url.toString()); } catch (_) {}
    var show = function () {
      try {
        if (st === 'success') {
          if (typeof DrexOrbit !== 'undefined') DrexOrbit.refresh(true).then(function (s) {
            try {
              if (s && s.active) {
                orbitToast(t('¡Bienvenido a Drex Orbit! Tu suscripción ya está activa.'));
                if (typeof openOrbitView === 'function') openOrbitView();
              } else {
                orbitToast(t('Pago recibido. Tu suscripción se activará en unos segundos.'));
              }
            } catch (_) {}
          });
        } else {
          orbitToast(t('Suscripción cancelada. No se realizó ningún cargo.'));
        }
      } catch (_) {}
    };
    if (document.readyState === 'complete') setTimeout(show, 900);
    else window.addEventListener('load', function () { setTimeout(show, 900); });
  } catch (_) {}
})();

// C46-G1: unirse a un grupo desde su enlace de invitacion (?joinGroup=<id>)."""
rep("// C46-G1: unirse a un grupo desde su enlace de invitacion (?joinGroup=<id>).", ORBIT_RETURN, 'H3-return')

# ================= H4: refresco al autenticar =================
old_auth = """  else detachDrexSecuritySession(null);"""
new_auth = """  else detachDrexSecuritySession(null);
  try { if (user && typeof DrexOrbit !== 'undefined') setTimeout(function () { DrexOrbit.refresh(); }, 1500); } catch (_) {} /* Drex Orbit: refresh tras login */"""
rep(old_auth, new_auth, 'H4-auth')

# ================= H5: puerta de anuncios =================
old_ads = """  function drexAdsActive() {
    return !!(DREX_ADS && DREX_ADS.enabled && DREX_ADS.publisherId);"""
new_ads = """  function drexAdsActive() {
    try { if (typeof DrexOrbit !== 'undefined' && DrexOrbit.isActive()) return false; } catch (_) {}
    return !!(DREX_ADS && DREX_ADS.enabled && DREX_ADS.publisherId);"""
rep(old_ads, new_ads, 'H5-ads')

# ================= H6: tarjeta Drex Orbit en Ajustes =================
ORBIT_CARD = """        <div class="px-4 pt-3">
          <button id="orbit-settings-card" onclick="openOrbitView()" class="tap44 w-full text-left rounded-2xl p-4 flex items-center gap-4 active:opacity-80 transition" style="background:linear-gradient(135deg,#2F33B8 0%,#6D28D9 60%,#9D4EDD 100%);box-shadow:0 8px 24px rgba(47,51,184,.35);">
            <span class="w-12 h-12 rounded-2xl bg-white/15 flex items-center justify-center text-white shrink-0">
              <svg class="w-7 h-7" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 8.2 7.2 11 12 4.5 16.8 11 21 8.2 19.4 17.5H4.6L3 8.2zm.7 10.6h16.6v1.7H3.7v-1.7z"/></svg>
            </span>
            <span class="flex-1 min-w-0">
              <span class="block text-white font-black text-[17px]">Drex Orbit</span>
              <span id="orbit-settings-preview" class="block text-white/80 text-[13px] mt-0.5">Funciones orbit de Drex</span>
            </span>
            <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-white/70 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
          </button>
        </div>
"""

# ================= H6b: tarjeta Pagos en Ajustes =================
PAGOS_CARD = """        <div class="px-4 pt-3">
          <button id="pagos-settings-card" onclick="openPaymentsView()" class="tap44 w-full text-left rounded-2xl p-4 flex items-center gap-4 active:opacity-80 transition bg-[var(--theme-surface)] border border-[var(--theme-border)]">
            <span class="w-12 h-12 rounded-2xl flex items-center justify-center text-white shrink-0" style="background:linear-gradient(135deg,#2F33B8,#6D28D9)">
              <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 18.75a60.68 60.68 0 0115.748-2.581l-4.528-4.53m-6.626 7.11c-.645.098-1.289.195-1.936.293m15.748-2.581a60.68 60.68 0 00-15.748-2.581m15.748 2.581l-4.529-4.53m6.625 7.11c.645.098 1.289.195 1.936.293M4.5 8.25V6.75A2.25 2.25 0 016.75 4.5h12A2.25 2.25 0 0121 6.75v1.5m-18 0h18M4.5 8.25v7.5A2.25 2.25 0 006.75 18h12a2.25 2.25 0 002.25-2.25v-7.5"/></svg>
            </span>
            <span class="flex-1 min-w-0">
              <span id="pagos-settings-title" class="block text-[var(--theme-text)] font-black text-[17px]">Pagos</span>
              <span id="pagos-settings-preview" class="block text-[var(--theme-muted)] text-[13px] mt-0.5">Historial de pagos y compras</span>
            </span>
            <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-[var(--theme-muted)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
          </button>
        </div>
"""

old_cuenta = '<div>\n<div>\n<p class="px-4 pt-3 pb-1.5 text-[17px] font-semibold text-[var(--theme-text)]">Cuenta</p>'
rep(old_cuenta, ORBIT_CARD + old_cuenta, 'H6-card')
rep(old_cuenta, PAGOS_CARD + old_cuenta, 'H6b-pagos-card')

# ================= H7: vistas Drex Orbit (antes de settings-view) =================
ORBIT_VIEWS = """  <!-- ============ Drex Orbit: vista de suscripción ============ -->
  <div id="orbit-view" class="fixed inset-0 bg-[var(--theme-bg)] z-[120] hidden flex flex-col">
    <div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--theme-border)] bg-[var(--theme-header-bg)] shrink-0">
      <button onclick="closeOrbitView()" class="tap44 w-10 h-10 flex items-center justify-center rounded-full text-[var(--theme-text)] active:bg-[var(--theme-surface-subtle)] transition" aria-label="Volver">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <h2 id="orbit-view-title" class="text-base font-extrabold text-[var(--theme-text)]">Drex Orbit</h2>
    </div>
    <div id="orbit-view-content" class="flex-1 overflow-y-auto scrollbar-hide pb-6"></div>
  </div>

  <!-- ============ Drex Orbit: paywall ============ -->
  <div id="orbit-paywall" class="fixed inset-0 z-[130] hidden">
    <div class="absolute inset-0 bg-black/55" onclick="closeOrbitPaywall()"></div>
    <div class="absolute bottom-0 left-0 right-0 flex justify-center pointer-events-none">
      <div id="orbit-paywall-card" class="pointer-events-auto w-full max-w-md bg-[var(--theme-surface)] rounded-t-3xl px-6 pt-2 pb-8 shadow-2xl" style="padding-bottom:max(2rem,env(safe-area-inset-bottom))"></div>
    </div>
  </div>

  <!-- ============ Drex Orbit: analíticas de creador ============ -->
  <div id="orbit-analytics-view" class="fixed inset-0 bg-[var(--theme-bg)] z-[120] hidden flex flex-col">
    <div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--theme-border)] bg-[var(--theme-header-bg)] shrink-0">
      <button onclick="orbitCloseAnalytics()" class="tap44 w-10 h-10 flex items-center justify-center rounded-full text-[var(--theme-text)] active:bg-[var(--theme-surface-subtle)] transition" aria-label="Volver">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <h2 id="orbit-analytics-title" class="text-base font-extrabold text-[var(--theme-text)]">Analíticas</h2>
    </div>
    <div id="orbit-analytics-content" class="flex-1 overflow-y-auto scrollbar-hide pb-6"></div>
  </div>

  <!-- ============ Pagos: historial y suscripción ============ -->
  <div id="payments-view" class="fixed inset-0 bg-[var(--theme-bg)] z-[120] hidden flex flex-col">
    <div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--theme-border)] bg-[var(--theme-header-bg)] shrink-0">
      <button onclick="closePaymentsView()" class="tap44 w-10 h-10 flex items-center justify-center rounded-full text-[var(--theme-text)] active:bg-[var(--theme-surface-subtle)] transition" aria-label="Volver">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <h2 id="payments-view-title" class="text-base font-extrabold text-[var(--theme-text)]">Pagos</h2>
    </div>
    <div id="payments-view-content" class="flex-1 overflow-y-auto scrollbar-hide pb-6"></div>
  </div>

"""
rep('  <div id="settings-view"', ORBIT_VIEWS + '  <div id="settings-view"', 'H7-views')

# ================= H8: insignia Drex Orbit en perfiles =================
old_badge_own = '<div id="profile-avatar-badges-mobile" class="profile-identity-badges mt-1.5 flex justify-center"></div>'
rep(old_badge_own, old_badge_own + '\n        <div id="orbit-profile-badge" class="hidden mt-1.5 flex justify-center"></div>', 'H8a-badge-own')

old_badge_author = '<h2 id="author-profile-name" class="mt-3 text-lg font-extrabold text-[var(--theme-text)] cursor-pointer select-none" title="Copiar usuario"></h2>'
rep(old_badge_author, old_badge_author + '\n        <div id="orbit-author-badge" class="hidden mt-1.5 flex justify-center"></div>', 'H8b-badge-author')

old_openprofile = "    try { var __u3 = (DrexCloud.auth().currentUser || {}).uid; if (__u3 && typeof window.drexLiveRefreshProfileBanner === 'function') window.drexLiveRefreshProfileBanner(__u3, 'profile-live-banner'); } catch (_) {}"
rep(old_openprofile, old_openprofile + "\n    try { if (typeof refreshOrbitProfileBadge === 'function') refreshOrbitProfileBadge(); } catch (_) {}", 'H8c-hook-own')

old_openauthor = "    try { if (typeof window.drexLiveRefreshProfileBanner === 'function') window.drexLiveRefreshProfileBanner(authorId, 'author-live-banner'); } catch (_) {}"
rep(old_openauthor, old_openauthor + "\n    try { if (typeof refreshOrbitAuthorBadge === 'function') refreshOrbitAuthorBadge(authorId); } catch (_) {}", 'H8d-hook-author')

# ================= H9: límites de video/foto =================
rep("if (duration > VIDEO_POSTS_MAX_DURATION_S) throw new Error('El video debe durar máximo 60 segundos.');",
    "if (duration > drexOrbitVideoPostMaxSec()) throw new Error('El video puede durar hasta ' + drexOrbitVideoPostMaxSec() + ' segundos.');",
    'H9a-video-post')
rep("      if (d > VIDEO_POSTS_MAX_DURATION_S) {\n        showMiniToast(appT('El video debe durar máximo 60 segundos. Elige un clip más corto.'));",
    "      if (d > drexOrbitVideoPostMaxSec()) {\n        showMiniToast(appT('El video puede durar hasta {s} segundos. Elige un clip más corto.').replace('{s}', drexOrbitVideoPostMaxSec()));",
    'H9b-video-post2')
rep("const room = 20 - notePostImageFiles.length;",
    "const room = drexOrbitPhotosMax() - notePostImageFiles.length;",
    'H9c-photos')
rep("showMiniToast(appT('Solo puedes subir un máximo de 20 fotos por publicación.'));",
    "showMiniToast(appT('Solo puedes subir un máximo de {n} fotos por publicación.').replace('{n}', drexOrbitPhotosMax()));",
    'H9d-photos-msg')
rep("  const max = DREX_CAM_MAX_VIDEO_SEC;",
    "  const max = drexOrbitCamMaxSec();",
    'H9e-cam')
rep("setTimeout(function () { if (drexCamRecording) drexCamStopRecording(true); }, DREX_CAM_MAX_VIDEO_SEC * 1000 + 400);",
    "setTimeout(function () { if (drexCamRecording) drexCamStopRecording(true); }, drexOrbitCamMaxSec() * 1000 + 400);",
    'H9f-cam2')

# ================= H10: programar publicación (composer) =================
old_sched_composer = """  function openScheduleSheetFromComposer() {
    const content = ((document.getElementById('note-content-fullscreen') || {}).value || '').trim();"""
new_sched_composer = """  function openScheduleSheetFromComposer() {
    try { if (typeof orbitGate === 'function' && !orbitGate('limits')) return; } catch (_) {}
    const content = ((document.getElementById('note-content-fullscreen') || {}).value || '').trim();"""
rep(old_sched_composer, new_sched_composer, 'H10-sched-composer')

# ================= H11: tope de en vivos programados =================
old_sched_cap = """    var d = db();
    // 1. Registro scheduledLives/<schedId>"""
new_sched_cap = """    var d = db();
    /* Drex Orbit: tope de en vivos programados simultáneos (gratis 3, Drex Orbit 10).
     * Sin puertas activas no hay tope. */
    try {
      var __maxSched = (typeof drexOrbitSchedLivesMax === 'function') ? drexOrbitSchedLivesMax() : Infinity;
      if (isFinite(__maxSched)) {
        var __mine = null;
        try { __mine = await d.ref('scheduledByHost/' + prof.uid).once('value'); } catch (_) {}
        var __vv = (__mine && __mine.val()) || {};
        if (Object.keys(__vv).length >= __maxSched) {
          var __e3 = new Error('drex-sched-limit');
          __e3.code = 'sched-limit';
          throw __e3;
        }
      }
    } catch (__ce) { if (__ce && __ce.code === 'sched-limit') throw __ce; }
    // 1. Registro scheduledLives/<schedId>"""
rep(old_sched_cap, new_sched_cap, 'H11-sched-cap')

old_sched_catch = """    } catch (e) {
      schedShowErr(e && e.code);
    }"""
new_sched_catch = """    } catch (e) {
      if (e && e.code === 'sched-limit') {
        try { if (typeof openOrbitPaywall === 'function') openOrbitPaywall('live_pro'); } catch (_) {}
      }
      schedShowErr(e && e.code);
    }"""
rep(old_sched_catch, new_sched_catch, 'H11b-sched-catch')

old_sched_err = """      'no-auth': 'Inicia sesión para transmitir.'
    };"""
new_sched_err = """      'no-auth': 'Inicia sesión para transmitir.',
      'sched-limit': 'Límite de en vivos programados alcanzado'
    };"""
rep(old_sched_err, new_sched_err, 'H11c-sched-err')

# ================= H12: duración del en vivo =================
old_starthost = "    this._hostStarted = true;"
new_starthost = """    this._hostStarted = true;
    /* Drex Orbit: límite de duración del en vivo (gratis 4 h, Drex Orbit 12 h).
     * Sin puertas activas no hay límite. */
    try {
      if (this._orbitLiveTimer) { clearTimeout(this._orbitLiveTimer); this._orbitLiveTimer = null; }
      if (this._orbitLiveWarn) { clearTimeout(this._orbitLiveWarn); this._orbitLiveWarn = null; }
      var __maxMs = (typeof drexOrbitLiveMaxMs === 'function') ? drexOrbitLiveMaxMs() : 0;
      if (__maxMs > 0) {
        var __self = this;
        if (__maxMs > 15 * 60 * 1000) {
          this._orbitLiveWarn = setTimeout(function () {
            try { orbitToast(t('Tu en vivo terminará en 15 minutos.')); } catch (_) {}
          }, __maxMs - 15 * 60 * 1000);
        }
        this._orbitLiveTimer = setTimeout(function () {
          try { orbitToast(t('Tu en vivo alcanzó el límite de duración.')); } catch (_) {}
          try { __self.endLive(); } catch (_) {}
        }, __maxMs);
      }
    } catch (_) {}"""
rep(old_starthost, new_starthost, 'H12a-live-timer')

old_endlive = """  DrexLiveCore.prototype.endLive = function () {
    if (this._role !== 'host' || !this._liveId) {"""
new_endlive = """  DrexLiveCore.prototype.endLive = function () {
    try {
      if (this._orbitLiveTimer) { clearTimeout(this._orbitLiveTimer); this._orbitLiveTimer = null; }
      if (this._orbitLiveWarn) { clearTimeout(this._orbitLiveWarn); this._orbitLiveWarn = null; }
    } catch (_) {}
    if (this._role !== 'host' || !this._liveId) {"""
rep(old_endlive, new_endlive, 'H12b-live-clear')

# ================= H13: HD en en vivos =================
old_constraints = "video: { facingMode: drexCamFacing, width: { ideal: 1280 }, height: { ideal: 720 } }"
new_constraints = "video: { facingMode: drexCamFacing, width: { ideal: ((typeof DrexOrbit !== 'undefined' && DrexOrbit.isActive()) ? 1920 : 1280) }, height: { ideal: ((typeof DrexOrbit !== 'undefined' && DrexOrbit.isActive()) ? 1080 : 720) } } /* Drex Orbit: HD 1080p */"
rep(old_constraints, new_constraints, 'H13-hd')

# ================= H14: bitrate de grabación del estudio =================
rep("rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1000000 });",
    "rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: ((typeof DrexOrbit !== 'undefined' && DrexOrbit.isActive()) ? 2500000 : 1000000) /* Drex Orbit: alta calidad */ });",
    'H14-bitrate')

# ================= H15: plantillas pro del estudio =================
old_tpl = """  preguntas: { name: 'Preguntas', layers: [ { type: 'camera', x: 0, y: 0, w: 0.62, h: 1 },
                                           { type: 'chat', x: 0.62, y: 0, w: 0.38, h: 0.72 },
                                           { type: 'alerts', x: 0.62, y: 0.72, w: 0.38, h: 0.28 } ] }
};"""
new_tpl = """  preguntas: { name: 'Preguntas', layers: [ { type: 'camera', x: 0, y: 0, w: 0.62, h: 1 },
                                           { type: 'chat', x: 0.62, y: 0, w: 0.38, h: 0.72 },
                                           { type: 'alerts', x: 0.62, y: 0.72, w: 0.38, h: 0.28 } ] },
  /* Drex Orbit: plantillas profesionales (requieren suscripción activa) */
  entrevista_pro: { name: 'Entrevista Pro', pro: true, layers: [ { type: 'camera', x: 0, y: 0, w: 0.62, h: 1 },
                                           { type: 'chat', x: 0.62, y: 0, w: 0.38, h: 0.6 },
                                           { type: 'text', x: 0.62, y: 0.62, w: 0.38, h: 0.12 } ] },
  noticiero_pro:  { name: 'Noticiero Pro', pro: true, layers: [ { type: 'camera', x: 0, y: 0, w: 1, h: 0.68 },
                                           { type: 'alerts', x: 0, y: 0.7, w: 1, h: 0.3 } ] },
  podcast_pro:     { name: 'Podcast Pro', pro: true, layers: [ { type: 'camera', x: 0.1, y: 0.12, w: 0.8, h: 0.68 },
                                           { type: 'text', x: 0.1, y: 0.02, w: 0.8, h: 0.08 } ] }
};"""
rep(old_tpl, new_tpl, 'H15a-templates')

old_tplbtns = """            <button type="button" class="dsw-tplbtn" data-tpl="preguntas"><span data-dsx-t="Preguntas y respuestas">Preguntas y respuestas</span></button>"""
new_tplbtns = """            <button type="button" class="dsw-tplbtn" data-tpl="preguntas"><span data-dsx-t="Preguntas y respuestas">Preguntas y respuestas</span></button>
            <button type="button" class="dsw-tplbtn" data-tpl="entrevista_pro"><span>👑 Entrevista Pro</span></button>
            <button type="button" class="dsw-tplbtn" data-tpl="noticiero_pro"><span>👑 Noticiero Pro</span></button>
            <button type="button" class="dsw-tplbtn" data-tpl="podcast_pro"><span>👑 Podcast Pro</span></button>"""
rep(old_tplbtns, new_tplbtns, 'H15b-template-btns')

old_tplclick = """    b.addEventListener('click', function () {
      var key = b.getAttribute('data-tpl');
      var sid = M.applyTemplate(G.P, key);"""
new_tplclick = """    b.addEventListener('click', function () {
      var key = b.getAttribute('data-tpl');
      var __tpl = (typeof SCENE_TEMPLATES !== 'undefined') ? SCENE_TEMPLATES[key] : null;
      if (__tpl && __tpl.pro && typeof orbitGate === 'function' && !orbitGate('studio_pro')) return;
      var sid = M.applyTemplate(G.P, key);"""
rep(old_tplclick, new_tplclick, 'H15c-template-gate')

# ================= H16: soporte prioritario =================
rep("    const mailSubject = '[Drex] ' + subject.slice(0, 120);",
    "    const mailSubject = ((typeof DrexOrbit !== 'undefined' && DrexOrbit.isActive()) ? '[Drex Orbit · Prioritario] ' : '[Drex] ') + subject.slice(0, 120);",
    'H16-priority')

# ================= H17: regalos exclusivos Drex Orbit =================
old_gift_anchor = "  { id: 'leon_astral',       price: 12000, tier: 'leyenda', label: 'León Astral',       img: DREX_GIFT_ASSET_BASE + 'leon_astral.png' },"
new_gift_anchor = old_gift_anchor + """
  /* Drex Orbit: regalos exclusivos de miembros (requieren suscripción activa) */
  { id: 'orbit_corona',  price: 500,   tier: 'orbit', label: 'Corona Índigo',  img: DREX_GIFT_ASSET_BASE + 'orbit_corona.png', orbit: true },
  { id: 'orbit_nucleo',  price: 1000,  tier: 'orbit', label: 'Núcleo Drex',    img: DREX_GIFT_ASSET_BASE + 'orbit_nucleo.png', orbit: true },
  { id: 'orbit_cristal', price: 2000,  tier: 'orbit', label: 'Cristal Prisma', img: DREX_GIFT_ASSET_BASE + 'orbit_cristal.png', orbit: true },
  { id: 'orbit_portal',  price: 3000,  tier: 'orbit', label: 'Portal Estelar', img: DREX_GIFT_ASSET_BASE + 'orbit_portal.png', orbit: true },
  { id: 'orbit_cometa',  price: 5000,  tier: 'orbit', label: 'Cometa Dorado',  img: DREX_GIFT_ASSET_BASE + 'orbit_cometa.png', orbit: true },
  { id: 'orbit_fenix',   price: 10000, tier: 'orbit', label: 'Fénix Cósmico',  img: DREX_GIFT_ASSET_BASE + 'orbit_fenix.png', orbit: true },"""
rep(old_gift_anchor, new_gift_anchor, 'H17a-gifts')

rep("return { bronce: 'Bronce', plata: 'Plata', oro: 'Oro', leyenda: 'Leyenda' }[tier] || tier;",
    "return { bronce: 'Bronce', plata: 'Plata', oro: 'Oro', leyenda: 'Leyenda', orbit: 'Drex Orbit 🪐' }[tier] || tier;",
    'H17b-tierlabel')

rep("    var tiers = ['bronce', 'plata', 'oro', 'leyenda'];",
    "    var tiers = ['orbit', 'bronce', 'plata', 'oro', 'leyenda'];",
    'H17c-tiers')

old_giftclick = "      (function (btn) { btn.onclick = function () { window.drexLiveSendGift(btn.getAttribute('data-gid')); }; })(btns[b]);"
new_giftclick = """      (function (btn) { btn.onclick = function () {
        var __gid = btn.getAttribute('data-gid');
        var __g = null;
        try { for (var __gi = 0; __gi < DREX_LIVE_GIFTS.length; __gi++) { if (DREX_LIVE_GIFTS[__gi].id === __gid) { __g = DREX_LIVE_GIFTS[__gi]; break; } } } catch (_) {}
        if (__g && __g.orbit && typeof orbitGate === 'function' && !orbitGate('exclusive_gifts')) return;
        window.drexLiveSendGift(__gid);
      }; })(btns[b]);"""
rep(old_giftclick, new_giftclick, 'H17d-giftclick')

old_sendgift = """window.drexLiveSendGift = async function (gid) {
  var gift = (typeof drexLiveGiftById === 'function') ? drexLiveGiftById(gid) : null;
  if (!gift) return;"""
new_sendgift = """window.drexLiveSendGift = async function (gid) {
  var gift = (typeof drexLiveGiftById === 'function') ? drexLiveGiftById(gid) : null;
  if (!gift) return;
  /* Drex Orbit: los regalos exclusivos exigen suscripción verificada (fail closed). */
  try {
    if (gift.orbit) {
      var __ok = (typeof DrexOrbit !== 'undefined') && DrexOrbit.isActive();
      if (!__ok) { if (typeof orbitGate === 'function') orbitGate('exclusive_gifts'); return; }
    }
  } catch (_) { if (gift.orbit) return; }"""
rep(old_sendgift, new_sendgift, 'H17e-sendgift')

# ================= escritura =================
open(P, 'w', encoding='utf-8').write(src)
print(f'LISTO: {n_applied[0]} hunks aplicados. {orig_len} -> {len(src)} bytes.')
