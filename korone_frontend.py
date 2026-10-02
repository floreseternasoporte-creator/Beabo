#!/usr/bin/env python3
"""Kor One — frontend (index.html). Aplica todos los hunks con conteo exacto.
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

# ================= H1: CSS Kor One =================
KORONE_CSS = """/* ============ Kor One (suscripción premium) ============ */
.korone-avatar-frame{box-shadow:0 0 0 2px #fff,0 0 0 5px #c9a227,0 0 22px rgba(255,190,60,.65)!important}
.korone-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:9999px;font-size:12px;font-weight:800;color:#3a2b00;background:linear-gradient(135deg,#ffe9a8,#ffd257 45%,#f0b429);box-shadow:0 2px 10px rgba(240,180,41,.45);white-space:nowrap}
.korone-badge svg{width:14px;height:14px}
.korone-theme-pick{position:relative;border-radius:14px;overflow:hidden;cursor:pointer;border:2px solid transparent;min-height:64px;display:flex;align-items:flex-end;padding:8px}
.korone-theme-pick.sel{border-color:var(--drex-brand)}
.korone-theme-lock{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:4px;background:rgba(0,0,0,.38);color:#fff;font-size:11px;font-weight:800}
.korone-plan-card{border:2px solid var(--theme-border);border-radius:18px;padding:18px;position:relative;transition:border-color .15s}
.korone-plan-card.best{border-color:#9D4EDD;box-shadow:0 8px 28px rgba(157,78,221,.25)}
"""
rep('.drex-ad-slot {\n  margin: 12px 16px;', KORONE_CSS + '.drex-ad-slot {\n  margin: 12px 16px;', 'H1-css')

# ================= H2: núcleo DrexKorOne =================
KORONE_CORE = r"""/* ============================================================
 * KOR ONE — suscripción premium de Drex (un nivel: mensual/anual)
 * ------------------------------------------------------------
 * El estado de suscriptor SOLO lo confirma el backend
 * (POST /subscription-status). Sin backend, sin sesión o sin
 * verificar -> NO suscriptor (fail closed). El cliente nunca se
 * auto-declara premium: ningún flag local otorga acceso.
 * Stripe opera en modo prueba (sandbox).
 * Puertas: window.DREX_KORONE_ENFORCE === true (apagado en
 * producción hasta que exista una ruta de compra en vivo aprobada).
 * ============================================================ */
var KORONE_PLANS = {
  monthly: { id: 'monthly', price: '$4.99', per: 'mes' },
  yearly:  { id: 'yearly',  price: '$49.99', per: 'año' }
};
var KORONE_FEATURES = ['ads_free', 'badge_frame', 'profile_themes', 'fiesta_boost', 'limits_boost', 'analytics', 'gifts', 'priority_support'];

var DrexKorOne = {
  _st: null,
  _ts: 0,
  _endpoint: function () {
    try { return String((typeof DREX_PAYMENTS_ENDPOINT !== 'undefined') ? DREX_PAYMENTS_ENDPOINT : '').replace(/\/+$/, ''); } catch (_) { return ''; }
  },
  isConfigured: function () { return !!this._endpoint(); },
  enforced: function () {
    try { return window.DREX_KORONE_ENFORCE === true; } catch (_) { return false; }
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
    try { if (typeof window.drexKorOneApplyGates === 'function') window.drexKorOneApplyGates(); } catch (_) {}
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
      if (KORONE_FEATURES.indexOf(feature) === -1) return false;
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

/* Enforcement: las puertas premium solo actúan si este flag es true.
 * Permanece en false hasta que exista una ruta de suscripción en vivo válida. */
window.DREX_KORONE_ENFORCE = false;

/* Puerta central: true = acceso permitido. Si las puertas están activas y
 * no hay suscripción verificada, abre el paywall y devuelve false. */
function korOneGate(feature) {
  try {
    if (typeof DrexKorOne === 'undefined') return true;
    if (!DrexKorOne.enforced()) return true;
    if (DrexKorOne.isActive()) return true;
    if (typeof openKorOnePaywall === 'function') openKorOnePaywall(feature || '');
    return false;
  } catch (_) { return true; }
}

function korOneToast(msg) {
  try {
    if (typeof toast === 'function') { toast(msg); return; }
    if (typeof showMiniToast === 'function') { showMiniToast(msg); return; }
  } catch (_) {}
}

/* Límites vinculados a Kor One. Sin puertas activas no cambia nada. */
function drexKorOneVideoPostMaxSec() { try { return DrexKorOne.isActive() ? 180 : 60; } catch (_) { return 60; } }
function drexKorOneCamMaxSec() { try { return DrexKorOne.isActive() ? 180 : 60; } catch (_) { return 60; } }
function drexKorOnePhotosMax() { try { return DrexKorOne.isActive() ? 40 : 20; } catch (_) { return 20; } }
function drexKorOneSchedLivesMax() {
  try {
    if (DrexKorOne.isActive()) return 10;
    if (DrexKorOne.enforced()) return 3;
  } catch (_) {}
  return Infinity;
}
function drexKorOneLiveMaxMs() {
  try {
    if (DrexKorOne.isActive()) return 12 * 3600 * 1000;
    if (DrexKorOne.enforced()) return 4 * 3600 * 1000;
  } catch (_) {}
  return 0;
}

/* Aplica las puertas globales (anuncios, vista previa en ajustes). */
window.drexKorOneApplyGates = function () {
  try {
    var on = (typeof DrexKorOne !== 'undefined') && DrexKorOne.isActive();
    document.querySelectorAll('.drex-ad-slot').forEach(function (el) {
      el.style.display = on ? 'none' : '';
    });
  } catch (_) {}
  try { if (typeof renderKorOneSettingsPreview === 'function') renderKorOneSettingsPreview(); } catch (_) {}
};

function koroneCrownSVG(cls) {
  return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 8.2 7.2 11 12 4.5 16.8 11 21 8.2 19.4 17.5H4.6L3 8.2zm.7 10.6h16.6v1.7H3.7v-1.7z"/></svg>';
}
function koroneBadgeHTML() {
  return '<span class="korone-badge">' + koroneCrownSVG('') + '<span>Kor One</span></span>';
}

/* Insignia + marco en el perfil propio. */
async function refreshKorOneProfileBadge() {
  var badgeEl = document.getElementById('korone-profile-badge');
  var imgEl = document.getElementById('profile-image');
  var active = false;
  try { active = (typeof DrexKorOne !== 'undefined') && DrexKorOne.isActive(); } catch (_) {}
  if (badgeEl) {
    if (active) { badgeEl.classList.remove('hidden'); badgeEl.innerHTML = koroneBadgeHTML(); }
    else { badgeEl.classList.add('hidden'); badgeEl.innerHTML = ''; }
  }
  try { if (imgEl) imgEl.classList.toggle('korone-avatar-frame', !!active); } catch (_) {}
  try { if (typeof applyKorOneProfileTheme === 'function') applyKorOneProfileTheme(); } catch (_) {}
}

/* Insignia + marco en el perfil de otro autor (lee su estado público). */
async function refreshKorOneAuthorBadge(authorId) {
  var badgeEl = document.getElementById('korone-author-badge');
  var imgEl = document.getElementById('author-profile-image');
  var active = false;
  try {
    if (authorId && typeof DrexKorOne !== 'undefined' && DrexKorOne.enforced()) {
      var cache = window._korOneBadgeCache || (window._korOneBadgeCache = {});
      var c = cache[authorId];
      if (!c || (Date.now() - c.ts) > 300000) {
        var v = null;
        try {
          var snap = await DrexCloud.database().ref('users/' + authorId + '/korOne').once('value');
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
    if (active) { badgeEl.classList.remove('hidden'); badgeEl.innerHTML = koroneBadgeHTML(); }
    else { badgeEl.classList.add('hidden'); badgeEl.innerHTML = ''; }
  }
  try { if (imgEl) imgEl.classList.toggle('korone-avatar-frame', !!active); } catch (_) {}
}

"""
old_core = """  location.href = data.url; /* Stripe Checkout; el retorno trae ?coins=success */
  return { redirected: true };
}

var DrexCoins = {"""
rep(old_core, old_core.replace('var DrexCoins = {', KORONE_CORE + 'var DrexCoins = {'), 'H2-core')

# ================= H2b: UI de Kor One (vista, paywall, temas, analíticas) =================
KORONE_UI = r"""
/* ============ Kor One: vista, paywall, temas, analíticas ============ */
function korOnePlanName(plan) {
  return plan === 'yearly' ? t('Anual') : t('Mensual');
}
function korOnePlanPrice(plan) {
  return (KORONE_PLANS[plan] || KORONE_PLANS.monthly).price + ' ' + t(plan === 'yearly' ? 'al año' : 'al mes');
}
function korOneFmtDate(ms) {
  try {
    var lang = (typeof getAppLanguage === 'function') ? getAppLanguage() : 'es';
    var loc = lang === 'zh' ? 'zh-CN' : (lang === 'en' ? 'en-US' : (lang === 'pt' ? 'pt-BR' : 'es-ES'));
    return new Date(ms).toLocaleDateString(loc, { day: 'numeric', month: 'long', year: 'numeric' });
  } catch (_) { return ''; }
}
function korOneBenefits() {
  return [
    { f: 'no_ads',           e: '🚫', title: t('Sin anuncios'),               desc: t('Navega Drex sin publicidad.') },
    { f: 'badge',            e: '👑', title: t('Insignia y marco exclusivos'), desc: t('Distintivo dorado Kor One y marco en tu foto.') },
    { f: 'profile_themes',   e: '🎨', title: t('Temas de perfil premium'),    desc: t('Fondos exclusivos para tu portada.') },
    { f: 'fiesta_boost',     ic: 'mic', title: t('Impulso en fiestas'),        desc: t('Tus fiestas de voz destacan y llegan a más gente.') },
    { f: 'limits',           e: '🧩', title: t('Límites elevados'),           desc: t('Videos más largos, más fotos y publicaciones programadas.') },
    { f: 'analytics',        e: '📊', title: t('Analíticas de creador'),      desc: t('Estadísticas avanzadas de tu contenido.') },
    { f: 'exclusive_gifts',  e: '🎁', title: t('Regalos exclusivos'),         desc: t('Regalos originales solo para miembros Kor One.') },
    { f: 'priority_support',  e: '🎧', title: t('Soporte prioritario'),        desc: t('Tus reportes se atienden primero.') }
  ];
}

function openKorOneView() {
  var v = document.getElementById('korone-view');
  if (!v) return;
  if (v.parentElement !== document.body) document.body.appendChild(v);
  v.classList.remove('hidden');
  try { if (typeof window._pushOverlayBackGuard === 'function') window._pushOverlayBackGuard(); } catch (_) {}
  renderKorOneView();
}
function closeKorOneView() {
  var v = document.getElementById('korone-view');
  if (v) v.classList.add('hidden');
}

function renderKorOneSettingsPreview() {
  var el = document.getElementById('korone-settings-preview');
  if (!el) return;
  var txt = t('Sin anuncios, insignia exclusiva y mucho más.');
  try {
    var s = (typeof DrexKorOne !== 'undefined') ? DrexKorOne.status() : null;
    if (s && s.active) txt = t('Miembro activo') + ' · ' + korOnePlanName(s.plan);
  } catch (_) {}
  el.textContent = txt;
}
/* La tarjeta de Ajustes muestra el subtítulo traducido desde el arranque. */
try {
  var __koronePrevBoot = function () { try { renderKorOneSettingsPreview(); } catch (_) {} };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __koronePrevBoot);
  else __koronePrevBoot();
} catch (_) {}

async function renderKorOneView() {
  var body = document.getElementById('korone-view-content');
  if (!body) return;
  var titleEl = document.getElementById('korone-view-title');
  if (titleEl) titleEl.textContent = 'Kor One';
  var st = null;
  try { st = await DrexKorOne.refresh(); } catch (_) { st = null; }
  var configured = DrexKorOne.isConfigured();
  var verified = !!(st && st.active);
  var escFn = (typeof escapeHtml === 'function') ? escapeHtml : function (s) { return String(s == null ? '' : s); };

  var html = '<div class="px-5 pt-2 pb-4 text-center">'
    + '<div class="mx-auto w-20 h-20 rounded-3xl flex items-center justify-center text-white mb-3" style="background:linear-gradient(135deg,#2F33B8,#9D4EDD);box-shadow:0 10px 30px rgba(109,40,217,.45)">'
    + koroneCrownSVG('w-10 h-10') + '</div>'
    + '<h2 class="text-2xl font-black text-[var(--theme-text)]">Kor One</h2>'
    + '<p class="text-sm text-[var(--theme-muted)] mt-1">' + escFn(t('El plan premium de Drex')) + '</p></div>';

  if (!configured) {
    html += '<div class="mx-5 rounded-2xl p-5 text-center text-sm text-[var(--theme-muted)] bg-[var(--theme-surface-subtle)]">'
      + escFn(t('Kor One no está disponible en este momento. Inténtalo más tarde.')) + '</div>';
  } else if (verified) {
    var renewTxt = st.currentPeriodEnd ? korOneFmtDate(st.currentPeriodEnd * 1000) : '';
    html += '<div class="mx-5 rounded-2xl p-5 text-white" style="background:linear-gradient(135deg,#2F33B8,#6D28D9)">'
      + '<div class="flex items-center gap-2 text-white/90">' + koroneCrownSVG('w-5 h-5') + '<span class="font-black text-lg">' + escFn(t('Tu suscripción')) + '</span></div>'
      + '<div class="text-white/85 text-sm mt-1 font-semibold">' + escFn(korOnePlanName(st.plan)) + ' · ' + escFn(korOnePlanPrice(st.plan)) + '</div>'
      + (renewTxt ? '<div class="text-white/75 text-xs mt-1">' + escFn(st.cancelAtPeriodEnd ? t('Se cancela al final del periodo') : (t('Se renueva el') + ' ' + renewTxt)) + '</div>' : '')
      + (st.status === 'past_due' ? '<div class="mt-3 text-xs font-bold bg-yellow-400/20 rounded-xl px-3 py-2">' + escFn(t('Tu último pago falló. Actualiza tu método de pago para mantener Kor One.')) + '</div>' : '')
      + '<div class="flex gap-2 mt-4">'
      + '<button onclick="korOneManage()" class="tap44 flex-1 min-h-[44px] rounded-xl bg-white text-[#2F33B8] font-extrabold text-sm active:opacity-80">' + escFn(t('Gestionar suscripción')) + '</button>'
      + '<button onclick="korOneRestore()" class="tap44 min-h-[44px] px-4 rounded-xl bg-white/15 text-white font-bold text-sm active:opacity-80">' + escFn(t('Restaurar compra')) + '</button>'
      + '</div></div>';
    html += '<div class="px-5 mt-5"><h3 class="font-extrabold text-[var(--theme-text)] text-[15px]">' + escFn(t('Tus beneficios')) + '</h3>'
      + '<div class="grid grid-cols-1 gap-2 mt-2">'
      + korOneBenefits().map(function (b) {
          return '<div class="flex items-center gap-3 rounded-2xl border border-[var(--theme-border)] p-3">'
            + '<span class="text-2xl">' + b.e + '</span>'
            + '<span class="min-w-0"><span class="block font-bold text-[var(--theme-text)] text-sm">' + escFn(b.title) + '</span>'
            + '<span class="block text-xs text-[var(--theme-muted)]">' + escFn(b.desc) + '</span></span></div>';
        }).join('')
      + '</div></div>';
  } else {
    html += '<div class="px-5 grid grid-cols-1 gap-2">'
      + korOneBenefits().map(function (b) {
          return '<div class="flex items-center gap-3 rounded-2xl border border-[var(--theme-border)] p-3">'
            + '<span class="text-2xl">' + b.e + '</span>'
            + '<span class="min-w-0"><span class="block font-bold text-[var(--theme-text)] text-sm">' + escFn(b.title) + '</span>'
            + '<span class="block text-xs text-[var(--theme-muted)]">' + escFn(b.desc) + '</span></span></div>';
        }).join('')
      + '</div>';
    var card = function (planId, best) {
      var p = KORONE_PLANS[planId];
      return '<div class="korone-plan-card' + (best ? ' best' : '') + ' bg-[var(--theme-surface)]">'
        + (best ? '<span class="absolute -top-3 left-4 text-[11px] font-black text-white px-2.5 py-1 rounded-full" style="background:linear-gradient(135deg,#9D4EDD,#6D28D9)">' + escFn(t('Ahorra 2 meses')) + '</span>' : '')
        + '<div class="font-extrabold text-[var(--theme-text)]">' + escFn(korOnePlanName(planId)) + '</div>'
        + '<div class="mt-1"><span class="text-3xl font-black text-[var(--theme-text)]">' + escFn(p.price) + '</span>'
        + '<span class="text-sm text-[var(--theme-muted)]"> ' + escFn(p.price + ' ' + t(planId === 'yearly' ? 'al año' : 'al mes')) + '</span></div>'
        + '<button onclick="korOneSubscribe(\'' + planId + '\')" class="tap44 w-full min-h-[48px] mt-3 rounded-xl font-extrabold text-white active:opacity-80" style="background:linear-gradient(135deg,#2F33B8,#9D4EDD)">' + escFn(t('Suscribirme')) + '</button>'
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
    + '<div id="korone-themes-row" class="grid grid-cols-3 gap-2.5 mt-3"></div></div>';

  /* Analíticas */
  html += '<div class="px-5 mt-6 mb-10"><button onclick="korOneOpenAnalytics()" class="tap44 w-full min-h-[52px] rounded-2xl border border-[var(--theme-border)] flex items-center gap-3 px-4 active:opacity-70 text-left">'
    + '<span class="text-2xl">📊</span><span class="min-w-0"><span class="block font-bold text-[var(--theme-text)] text-sm">' + escFn(t('Analíticas de creador')) + '</span>'
    + '<span class="block text-xs text-[var(--theme-muted)]">' + escFn(t('Tus números reales, actualizados al abrir.')) + '</span></span>'
    + '<span class="ml-auto text-[var(--theme-muted)]">›</span></button></div>';

  body.innerHTML = html;
  renderKorOneThemesRow();
}

async function korOneSubscribe(planId) {
  korOneToast(t('Procesando…'));
  try { await DrexKorOne.subscribe(planId); }
  catch (e) {
    var m = String((e && e.message) || '');
    if (m === 'no-provider' || m === 'subscription_not_configured' || m === 'http_503') korOneToast(t('Kor One no está disponible en este momento. Inténtalo más tarde.'));
    else if (m === 'no-token') korOneToast(t('Inicia sesión para suscribirte a Kor One.'));
    else korOneToast(t('Error al iniciar el pago. Inténtalo de nuevo.'));
  }
}
async function korOneManage() {
  korOneToast(t('Procesando…'));
  try { await DrexKorOne.manage(); }
  catch (e) {
    var m = String((e && e.message) || '');
    if (m === 'no_subscription') korOneToast(t('No tienes una suscripción activa.'));
    else korOneToast(t('No se pudo abrir la gestión de la suscripción. Inténtalo de nuevo.'));
  }
}
async function korOneRestore() {
  korOneToast(t('Procesando…'));
  try {
    var s = await DrexKorOne.restore();
    if (s && s.active) korOneToast(t('¡Bienvenido a Kor One! Tu suscripción ya está activa.'));
    else korOneToast(t('No encontramos una suscripción activa en tu cuenta.'));
  } catch (_) { korOneToast(t('No se pudo verificar tu suscripción. Inténtalo de nuevo.')); }
  renderKorOneView();
}

/* ---------- paywall ---------- */
function korOnePaywallCopy(feature) {
  var map = {
    fiesta_boost:    { ic: 'mic', title: t('Impulso en fiestas'),         desc: t('Tus fiestas de voz destacan y llegan a más gente.') },
    limits:          { e: '🧩', title: t('Límites elevados'),            desc: t('Videos más largos, más fotos y publicaciones programadas.') },
    analytics:       { e: '📊', title: t('Analíticas de creador'),       desc: t('Estadísticas avanzadas de tu contenido.') },
    exclusive_gifts: { e: '🎁', title: t('Regalos exclusivos'),          desc: t('Regalos originales solo para miembros Kor One.') },
    profile_themes:  { e: '🎨', title: t('Temas de perfil premium'),     desc: t('Fondos exclusivos para tu portada.') },
    no_ads:          { e: '🚫', title: t('Sin anuncios'),                desc: t('Navega Drex sin publicidad.') },
    badge:           { e: '👑', title: t('Insignia y marco exclusivos'), desc: t('Distintivo dorado Kor One y marco en tu foto.') },
    priority_support:{ e: '🎧', title: t('Soporte prioritario'),         desc: t('Tus reportes se atienden primero.') }
  };
  return map[feature] || { e: '👑', title: 'Kor One', desc: t('El plan premium de Drex') };
}
function openKorOnePaywall(feature) {
  var sheet = document.getElementById('korone-paywall');
  var card = document.getElementById('korone-paywall-card');
  if (!sheet || !card) return;
  var c = korOnePaywallCopy(feature);
  var escFn = (typeof escapeHtml === 'function') ? escapeHtml : function (s) { return String(s == null ? '' : s); };
  card.innerHTML = '<div class="w-10 h-1.5 rounded-full bg-[var(--theme-border)] mx-auto mb-4"></div>'
    + '<div class="text-center"><div class="text-5xl">' + c.e + '</div>'
    + '<h3 class="text-xl font-black text-[var(--theme-text)] mt-3">' + escFn(t('Esta función es de Kor One')) + '</h3>'
    + '<p class="text-sm text-[var(--theme-muted)] mt-1.5 leading-relaxed"><b class="text-[var(--theme-text)]">' + escFn(c.title) + '.</b> ' + escFn(c.desc) + '<br>' + escFn(t('Suscríbete para desbloquearla y apoyar a Drex.')) + '</p>'
    + '<div class="mt-3 inline-flex items-center gap-2 rounded-full bg-[var(--theme-surface-subtle)] px-4 py-2 text-sm font-extrabold text-[var(--theme-text)]">$4.99 ' + escFn(t('al mes')) + ' · $49.99 ' + escFn(t('al año')) + '</div>'
    + '<button onclick="closeKorOnePaywall();openKorOneView()" class="tap44 w-full min-h-[52px] mt-4 rounded-2xl font-extrabold text-white active:opacity-80" style="background:linear-gradient(135deg,#2F33B8,#9D4EDD)">' + escFn(t('Ver planes')) + '</button>'
    + '<button onclick="closeKorOnePaywall()" class="tap44 w-full min-h-[44px] mt-1 rounded-2xl font-bold text-[var(--theme-muted)] active:opacity-70">' + escFn(t('Ahora no')) + '</button>'
    + '<p class="text-[11px] text-[var(--theme-muted)] mt-2">' + escFn(t('Sin permanencia. Cancela cuando quieras.')) + '</p></div>';
  if (sheet.parentElement !== document.body) document.body.appendChild(sheet);
  sheet.classList.remove('hidden');
  try { if (typeof window._pushOverlayBackGuard === 'function') window._pushOverlayBackGuard(); } catch (_) {}
}
function closeKorOnePaywall() {
  var sheet = document.getElementById('korone-paywall');
  if (sheet) sheet.classList.add('hidden');
}

/* ---------- temas de perfil ---------- */
var KORONE_PROFILE_THEMES = [
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
function koroneThemeById(id) {
  for (var i = 0; i < KORONE_PROFILE_THEMES.length; i++) if (KORONE_PROFILE_THEMES[i].id === id) return KORONE_PROFILE_THEMES[i];
  return KORONE_PROFILE_THEMES[0];
}
function koroneThemeName(id) {
  var map = { default: t('Predeterminado'), indigo: t('Índigo'), midnight: t('Medianoche'), dorado: t('Dorado'), oceano: t('Océano'), atardecer: t('Atardecer'), galaxia: t('Galaxia'), esmeralda: t('Esmeralda'), neon: t('Neón') };
  return map[id] || id;
}
async function koroneCurrentThemeId() {
  try {
    var me = (typeof liveUser === 'function') ? liveUser() : ((typeof DrexCloud !== 'undefined' && DrexCloud.auth().currentUser) || null);
    if (!me || !me.uid) return 'default';
    var snap = await DrexCloud.database().ref('users/' + me.uid + '/profileTheme').once('value');
    var v = snap && snap.val();
    if (typeof v === 'string' && koroneThemeById(v)) return v;
  } catch (_) {}
  return 'default';
}
async function renderKorOneThemesRow() {
  var row = document.getElementById('korone-themes-row');
  if (!row) return;
  var cur = await koroneCurrentThemeId();
  var escFn = (typeof escapeHtml === 'function') ? escapeHtml : function (s) { return String(s == null ? '' : s); };
  row.innerHTML = KORONE_PROFILE_THEMES.map(function (th) {
    return '<div class="korone-theme-pick' + (cur === th.id ? ' sel' : '') + '" style="background:' + th.css + '" onclick="setKorOneProfileTheme(\'' + th.id + '\')" role="button" tabindex="0">'
      + (th.pro ? '<span class="korone-theme-lock">👑 ' + escFn(t('Solo Kor One')) + '</span>' : '')
      + '<span class="relative text-[11px] font-extrabold text-white drop-shadow">' + escFn(koroneThemeName(th.id)) + '</span></div>';
  }).join('');
}
async function setKorOneProfileTheme(id) {
  var th = koroneThemeById(id);
  if (th.pro && typeof korOneGate === 'function' && !korOneGate('profile_themes')) return;
  try {
    var me = (typeof liveUser === 'function') ? liveUser() : ((typeof DrexCloud !== 'undefined' && DrexCloud.auth().currentUser) || null);
    if (!me || !me.uid) { korOneToast(t('Inicia sesión para personalizar tu perfil.')); return; }
    await DrexCloud.database().ref('users/' + me.uid + '/profileTheme').set(id);
    applyKorOneProfileTheme();
    renderKorOneThemesRow();
    korOneToast(t('Tema aplicado'));
  } catch (_) { korOneToast(t('No se pudo guardar el tema. Inténtalo de nuevo.')); }
}
async function applyKorOneProfileTheme() {
  try {
    var me = (typeof liveUser === 'function') ? liveUser() : ((typeof DrexCloud !== 'undefined' && DrexCloud.auth().currentUser) || null);
    if (!me || !me.uid) return;
    var tid = await koroneCurrentThemeId();
    var th = koroneThemeById(tid);
    if (th.pro && !((typeof DrexKorOne !== 'undefined') && DrexKorOne.isActive())) th = KORONE_PROFILE_THEMES[0];
    ['my-profile-cover', 'my-profile-cover-desktop'].forEach(function (cid) {
      var cover = document.getElementById(cid);
      if (cover) cover.style.background = th.css;
    });
  } catch (_) {}
}

/* ---------- analíticas de creador ---------- */
function korOneOpenAnalytics() {
  if (typeof korOneGate === 'function' && !korOneGate('analytics')) return;
  var v = document.getElementById('korone-analytics-view');
  if (!v) return;
  if (v.parentElement !== document.body) document.body.appendChild(v);
  v.classList.remove('hidden');
  try { if (typeof window._pushOverlayBackGuard === 'function') window._pushOverlayBackGuard(); } catch (_) {}
  renderKorOneAnalytics();
}
function korOneCloseAnalytics() {
  var v = document.getElementById('korone-analytics-view');
  if (v) v.classList.add('hidden');
}
async function renderKorOneAnalytics() {
  var body = document.getElementById('korone-analytics-content');
  if (!body) return;
  var titleEl = document.getElementById('korone-analytics-title');
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
"""
old_core2 = "var DrexCoins = {"
rep(old_core2, KORONE_UI + old_core2, 'H2b-ui')

# ================= H3: retorno ?korone=success =================
KORONE_RETURN = r"""// Retorno de Stripe Checkout (Kor One): ?korone=success | ?korone=cancelled.
// La suscripción la activa el webhook en el servidor; aquí solo se avisa,
// se refresca el estado verificado y se limpia la URL.
(function captureKorOneReturn() {
  try {
    var q = new URLSearchParams(location.search);
    var st = q.get('korone');
    if (st !== 'success' && st !== 'cancelled') return;
    try { var url = new URL(location.href); url.search = ''; history.replaceState(null, '', url.toString()); } catch (_) {}
    var show = function () {
      try {
        if (st === 'success') {
          if (typeof DrexKorOne !== 'undefined') DrexKorOne.refresh(true).then(function (s) {
            try {
              if (s && s.active) {
                korOneToast(t('¡Bienvenido a Kor One! Tu suscripción ya está activa.'));
                if (typeof openKorOneView === 'function') openKorOneView();
              } else {
                korOneToast(t('Pago recibido. Tu suscripción se activará en unos segundos.'));
              }
            } catch (_) {}
          });
        } else {
          korOneToast(t('Suscripción cancelada. No se realizó ningún cargo.'));
        }
      } catch (_) {}
    };
    if (document.readyState === 'complete') setTimeout(show, 900);
    else window.addEventListener('load', function () { setTimeout(show, 900); });
  } catch (_) {}
})();

// C46-G1: unirse a un grupo desde su enlace de invitacion (?joinGroup=<id>)."""
rep("// C46-G1: unirse a un grupo desde su enlace de invitacion (?joinGroup=<id>).", KORONE_RETURN, 'H3-return')

# ================= H4: refresco al autenticar =================
old_auth = """  else detachDrexSecuritySession(null);"""
new_auth = """  else detachDrexSecuritySession(null);
  try { if (user && typeof DrexKorOne !== 'undefined') setTimeout(function () { DrexKorOne.refresh(); }, 1500); } catch (_) {} /* Kor One: refresh tras login */"""
rep(old_auth, new_auth, 'H4-auth')

# ================= H5: puerta de anuncios =================
old_ads = """  function drexAdsActive() {
    return !!(DREX_ADS && DREX_ADS.enabled && DREX_ADS.publisherId);"""
new_ads = """  function drexAdsActive() {
    try { if (typeof DrexKorOne !== 'undefined' && DrexKorOne.isActive()) return false; } catch (_) {}
    return !!(DREX_ADS && DREX_ADS.enabled && DREX_ADS.publisherId);"""
rep(old_ads, new_ads, 'H5-ads')

# ================= H6: tarjeta Kor One en Ajustes =================
KORONE_CARD = """        <div class="px-4 pt-3">
          <button id="korone-settings-card" onclick="openKorOneView()" class="tap44 w-full text-left rounded-2xl p-4 flex items-center gap-4 active:opacity-80 transition" style="background:linear-gradient(135deg,#2F33B8 0%,#6D28D9 60%,#9D4EDD 100%);box-shadow:0 8px 24px rgba(47,51,184,.35);">
            <span class="w-12 h-12 rounded-2xl bg-white/15 flex items-center justify-center text-white shrink-0">
              <svg class="w-7 h-7" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 8.2 7.2 11 12 4.5 16.8 11 21 8.2 19.4 17.5H4.6L3 8.2zm.7 10.6h16.6v1.7H3.7v-1.7z"/></svg>
            </span>
            <span class="flex-1 min-w-0">
              <span class="block text-white font-black text-[17px]">Kor One</span>
              <span id="korone-settings-preview" class="block text-white/80 text-[13px] mt-0.5">Funciones premium de Drex</span>
            </span>
            <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-white/70 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
          </button>
        </div>
"""
old_cuenta = '<div>\n<div>\n<p class="px-4 pt-3 pb-1.5 text-[17px] font-semibold text-[var(--theme-text)]">Cuenta</p>'
rep(old_cuenta, KORONE_CARD + old_cuenta, 'H6-card')

# ================= H7: vistas Kor One (antes de settings-view) =================
KORONE_VIEWS = """  <!-- ============ Kor One: vista de suscripción ============ -->
  <div id="korone-view" class="fixed inset-0 bg-[var(--theme-bg)] z-[120] hidden flex flex-col">
    <div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--theme-border)] bg-[var(--theme-header-bg)] shrink-0">
      <button onclick="closeKorOneView()" class="tap44 w-10 h-10 flex items-center justify-center rounded-full text-[var(--theme-text)] active:bg-[var(--theme-surface-subtle)] transition" aria-label="Volver">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <h2 id="korone-view-title" class="text-base font-extrabold text-[var(--theme-text)]">Kor One</h2>
    </div>
    <div id="korone-view-content" class="flex-1 overflow-y-auto scrollbar-hide pb-6"></div>
  </div>

  <!-- ============ Kor One: paywall ============ -->
  <div id="korone-paywall" class="fixed inset-0 z-[130] hidden">
    <div class="absolute inset-0 bg-black/55" onclick="closeKorOnePaywall()"></div>
    <div class="absolute bottom-0 left-0 right-0 flex justify-center pointer-events-none">
      <div id="korone-paywall-card" class="pointer-events-auto w-full max-w-md bg-[var(--theme-surface)] rounded-t-3xl px-6 pt-2 pb-8 shadow-2xl" style="padding-bottom:max(2rem,env(safe-area-inset-bottom))"></div>
    </div>
  </div>

  <!-- ============ Kor One: analíticas de creador ============ -->
  <div id="korone-analytics-view" class="fixed inset-0 bg-[var(--theme-bg)] z-[120] hidden flex flex-col">
    <div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--theme-border)] bg-[var(--theme-header-bg)] shrink-0">
      <button onclick="korOneCloseAnalytics()" class="tap44 w-10 h-10 flex items-center justify-center rounded-full text-[var(--theme-text)] active:bg-[var(--theme-surface-subtle)] transition" aria-label="Volver">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <h2 id="korone-analytics-title" class="text-base font-extrabold text-[var(--theme-text)]">Analíticas</h2>
    </div>
    <div id="korone-analytics-content" class="flex-1 overflow-y-auto scrollbar-hide pb-6"></div>
  </div>

"""
rep('  <div id="settings-view"', KORONE_VIEWS + '  <div id="settings-view"', 'H7-views')

# ================= H8: insignia Kor One en perfiles =================
old_badge_own = '<div id="profile-avatar-badges-mobile" class="profile-identity-badges mt-1.5 flex justify-center"></div>'
rep(old_badge_own, old_badge_own + '\n        <div id="korone-profile-badge" class="hidden mt-1.5 flex justify-center"></div>', 'H8a-badge-own')

old_badge_author = '<h2 id="author-profile-name" class="mt-3 text-lg font-extrabold text-[var(--theme-text)] cursor-pointer select-none" title="Copiar usuario"></h2>'
rep(old_badge_author, old_badge_author + '\n        <div id="korone-author-badge" class="hidden mt-1.5 flex justify-center"></div>', 'H8b-badge-author')

old_openprofile = "    try { var __u3 = (DrexCloud.auth().currentUser || {}).uid; if (__u3 && typeof window.drexLiveRefreshProfileBanner === 'function') window.drexLiveRefreshProfileBanner(__u3, 'profile-live-banner'); } catch (_) {}"
rep(old_openprofile, old_openprofile + "\n    try { if (typeof refreshKorOneProfileBadge === 'function') refreshKorOneProfileBadge(); } catch (_) {}", 'H8c-hook-own')

old_openauthor = "    try { if (typeof window.drexLiveRefreshProfileBanner === 'function') window.drexLiveRefreshProfileBanner(authorId, 'author-live-banner'); } catch (_) {}"
rep(old_openauthor, old_openauthor + "\n    try { if (typeof refreshKorOneAuthorBadge === 'function') refreshKorOneAuthorBadge(authorId); } catch (_) {}", 'H8d-hook-author')

# ================= H9: límites de video/foto =================
rep("if (duration > VIDEO_POSTS_MAX_DURATION_S) throw new Error('El video debe durar máximo 60 segundos.');",
    "if (duration > drexKorOneVideoPostMaxSec()) throw new Error('El video puede durar hasta ' + drexKorOneVideoPostMaxSec() + ' segundos.');",
    'H9a-video-post')
rep("      if (d > VIDEO_POSTS_MAX_DURATION_S) {\n        showMiniToast(appT('El video debe durar máximo 60 segundos. Elige un clip más corto.'));",
    "      if (d > drexKorOneVideoPostMaxSec()) {\n        showMiniToast(appT('El video puede durar hasta {s} segundos. Elige un clip más corto.').replace('{s}', drexKorOneVideoPostMaxSec()));",
    'H9b-video-post2')
rep("const room = 20 - notePostImageFiles.length;",
    "const room = drexKorOnePhotosMax() - notePostImageFiles.length;",
    'H9c-photos')
rep("showMiniToast(appT('Solo puedes subir un máximo de 20 fotos por publicación.'));",
    "showMiniToast(appT('Solo puedes subir un máximo de {n} fotos por publicación.').replace('{n}', drexKorOnePhotosMax()));",
    'H9d-photos-msg')
rep("  const max = DREX_CAM_MAX_VIDEO_SEC;",
    "  const max = drexKorOneCamMaxSec();",
    'H9e-cam')
rep("setTimeout(function () { if (drexCamRecording) drexCamStopRecording(true); }, DREX_CAM_MAX_VIDEO_SEC * 1000 + 400);",
    "setTimeout(function () { if (drexCamRecording) drexCamStopRecording(true); }, drexKorOneCamMaxSec() * 1000 + 400);",
    'H9f-cam2')

# ================= H10: programar publicación (composer) =================
old_sched_composer = """  function openScheduleSheetFromComposer() {
    const content = ((document.getElementById('note-content-fullscreen') || {}).value || '').trim();"""
new_sched_composer = """  function openScheduleSheetFromComposer() {
    try { if (typeof korOneGate === 'function' && !korOneGate('limits')) return; } catch (_) {}
    const content = ((document.getElementById('note-content-fullscreen') || {}).value || '').trim();"""
rep(old_sched_composer, new_sched_composer, 'H10-sched-composer')

# ================= H11: tope de en vivos programados =================
old_sched_cap = """    var d = db();
    // 1. Registro scheduledLives/<schedId>"""
new_sched_cap = """    var d = db();
    /* Kor One: tope de en vivos programados simultáneos (gratis 3, Kor One 10).
     * Sin puertas activas no hay tope. */
    try {
      var __maxSched = (typeof drexKorOneSchedLivesMax === 'function') ? drexKorOneSchedLivesMax() : Infinity;
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
        try { if (typeof openKorOnePaywall === 'function') openKorOnePaywall('fiesta_boost'); } catch (_) {}
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
    /* Kor One: límite de duración del en vivo (gratis 4 h, Kor One 12 h).
     * Sin puertas activas no hay límite. */
    try {
      if (this._korOneLiveTimer) { clearTimeout(this._korOneLiveTimer); this._korOneLiveTimer = null; }
      if (this._korOneLiveWarn) { clearTimeout(this._korOneLiveWarn); this._korOneLiveWarn = null; }
      var __maxMs = (typeof drexKorOneLiveMaxMs === 'function') ? drexKorOneLiveMaxMs() : 0;
      if (__maxMs > 0) {
        var __self = this;
        if (__maxMs > 15 * 60 * 1000) {
          this._korOneLiveWarn = setTimeout(function () {
            try { korOneToast(t('Tu en vivo terminará en 15 minutos.')); } catch (_) {}
          }, __maxMs - 15 * 60 * 1000);
        }
        this._korOneLiveTimer = setTimeout(function () {
          try { korOneToast(t('Tu en vivo alcanzó el límite de duración.')); } catch (_) {}
          try { __self.endLive(); } catch (_) {}
        }, __maxMs);
      }
    } catch (_) {}"""
rep(old_starthost, new_starthost, 'H12a-live-timer')

old_endlive = """  DrexLiveCore.prototype.endLive = function () {
    if (this._role !== 'host' || !this._liveId) {"""
new_endlive = """  DrexLiveCore.prototype.endLive = function () {
    try {
      if (this._korOneLiveTimer) { clearTimeout(this._korOneLiveTimer); this._korOneLiveTimer = null; }
      if (this._korOneLiveWarn) { clearTimeout(this._korOneLiveWarn); this._korOneLiveWarn = null; }
    } catch (_) {}
    if (this._role !== 'host' || !this._liveId) {"""
rep(old_endlive, new_endlive, 'H12b-live-clear')

# ================= H13: HD en en vivos =================
old_constraints = "video: { facingMode: drexCamFacing, width: { ideal: 1280 }, height: { ideal: 720 } }"
new_constraints = "video: { facingMode: drexCamFacing, width: { ideal: ((typeof DrexKorOne !== 'undefined' && DrexKorOne.isActive()) ? 1920 : 1280) }, height: { ideal: ((typeof DrexKorOne !== 'undefined' && DrexKorOne.isActive()) ? 1080 : 720) } } /* Kor One: HD 1080p */"
rep(old_constraints, new_constraints, 'H13-hd')

# ================= H14: bitrate de grabación del estudio =================
rep("rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1000000 });",
    "rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: ((typeof DrexKorOne !== 'undefined' && DrexKorOne.isActive()) ? 2500000 : 1000000) /* Kor One: alta calidad */ });",
    'H14-bitrate')

# ================= H15: plantillas pro del estudio =================
old_tpl = """  preguntas: { name: 'Preguntas', layers: [ { type: 'camera', x: 0, y: 0, w: 0.62, h: 1 },
                                           { type: 'chat', x: 0.62, y: 0, w: 0.38, h: 0.72 },
                                           { type: 'alerts', x: 0.62, y: 0.72, w: 0.38, h: 0.28 } ] }
};"""
new_tpl = """  preguntas: { name: 'Preguntas', layers: [ { type: 'camera', x: 0, y: 0, w: 0.62, h: 1 },
                                           { type: 'chat', x: 0.62, y: 0, w: 0.38, h: 0.72 },
                                           { type: 'alerts', x: 0.62, y: 0.72, w: 0.38, h: 0.28 } ] },
  /* Kor One: plantillas profesionales (requieren suscripción activa) */
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
      if (__tpl && __tpl.pro && typeof korOneGate === 'function' && !korOneGate('studio_pro')) return;
      var sid = M.applyTemplate(G.P, key);"""
rep(old_tplclick, new_tplclick, 'H15c-template-gate')

# ================= H16: soporte prioritario =================
rep("    const mailSubject = '[Drex] ' + subject.slice(0, 120);",
    "    const mailSubject = ((typeof DrexKorOne !== 'undefined' && DrexKorOne.isActive()) ? '[Kor One · Prioritario] ' : '[Drex] ') + subject.slice(0, 120);",
    'H16-priority')

# ================= H17: regalos exclusivos Kor One =================
old_gift_anchor = "  { id: 'leon_astral',       price: 12000, tier: 'leyenda', label: 'León Astral',       img: DREX_GIFT_ASSET_BASE + 'leon_astral.png' },"
new_gift_anchor = old_gift_anchor + """
  /* Kor One: regalos exclusivos de miembros (requieren suscripción activa) */
  { id: 'korone_corona',  price: 500,   tier: 'korone', label: 'Corona Índigo',  img: DREX_GIFT_ASSET_BASE + 'korone_corona.png', korOne: true },
  { id: 'korone_nucleo',  price: 1000,  tier: 'korone', label: 'Núcleo Drex',    img: DREX_GIFT_ASSET_BASE + 'korone_nucleo.png', korOne: true },
  { id: 'korone_cristal', price: 2000,  tier: 'korone', label: 'Cristal Prisma', img: DREX_GIFT_ASSET_BASE + 'korone_cristal.png', korOne: true },
  { id: 'korone_portal',  price: 3000,  tier: 'korone', label: 'Portal Estelar', img: DREX_GIFT_ASSET_BASE + 'korone_portal.png', korOne: true },
  { id: 'korone_cometa',  price: 5000,  tier: 'korone', label: 'Cometa Dorado',  img: DREX_GIFT_ASSET_BASE + 'korone_cometa.png', korOne: true },
  { id: 'korone_fenix',   price: 10000, tier: 'korone', label: 'Fénix Cósmico',  img: DREX_GIFT_ASSET_BASE + 'korone_fenix.png', korOne: true },"""
rep(old_gift_anchor, new_gift_anchor, 'H17a-gifts')

rep("return { bronce: 'Bronce', plata: 'Plata', oro: 'Oro', leyenda: 'Leyenda' }[tier] || tier;",
    "return { bronce: 'Bronce', plata: 'Plata', oro: 'Oro', leyenda: 'Leyenda', korone: 'Kor One 👑' }[tier] || tier;",
    'H17b-tierlabel')

rep("    var tiers = ['bronce', 'plata', 'oro', 'leyenda'];",
    "    var tiers = ['korone', 'bronce', 'plata', 'oro', 'leyenda'];",
    'H17c-tiers')

old_giftclick = "      (function (btn) { btn.onclick = function () { window.drexLiveSendGift(btn.getAttribute('data-gid')); }; })(btns[b]);"
new_giftclick = """      (function (btn) { btn.onclick = function () {
        var __gid = btn.getAttribute('data-gid');
        var __g = null;
        try { for (var __gi = 0; __gi < DREX_LIVE_GIFTS.length; __gi++) { if (DREX_LIVE_GIFTS[__gi].id === __gid) { __g = DREX_LIVE_GIFTS[__gi]; break; } } } catch (_) {}
        if (__g && __g.korOne && typeof korOneGate === 'function' && !korOneGate('exclusive_gifts')) return;
        window.drexLiveSendGift(__gid);
      }; })(btns[b]);"""
rep(old_giftclick, new_giftclick, 'H17d-giftclick')

old_sendgift = """window.drexLiveSendGift = async function (gid) {
  var gift = (typeof drexLiveGiftById === 'function') ? drexLiveGiftById(gid) : null;
  if (!gift) return;"""
new_sendgift = """window.drexLiveSendGift = async function (gid) {
  var gift = (typeof drexLiveGiftById === 'function') ? drexLiveGiftById(gid) : null;
  if (!gift) return;
  /* Kor One: los regalos exclusivos exigen suscripción verificada (fail closed). */
  try {
    if (gift.korOne) {
      var __ok = (typeof DrexKorOne !== 'undefined') && DrexKorOne.isActive();
      if (!__ok) { if (typeof korOneGate === 'function') korOneGate('exclusive_gifts'); return; }
    }
  } catch (_) { if (gift.korOne) return; }"""
rep(old_sendgift, new_sendgift, 'H17e-sendgift')

# ================= escritura =================
open(P, 'w', encoding='utf-8').write(src)
print(f'LISTO: {n_applied[0]} hunks aplicados. {orig_len} -> {len(src)} bytes.')
