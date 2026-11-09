/* ================================================================
 * Revisión de seguridad (estilo "Security Checkup").
 * Lógica pura, sin DOM ni red: recibe el estado de la cuenta y devuelve
 * la lista de comprobaciones y el porcentaje. La pantalla (Centro de
 * seguridad, index.html) solo pinta el resultado.
 *
 * Estados de cada ítem:
 *   ok       protección en orden (cuenta para el puntaje)
 *   todo     falta hacer algo (cuenta para el puntaje)
 *   info     sin dato / no aplica todavía (NO cuenta para el puntaje)
 * ================================================================ */
(function (root) {
  'use strict';

  var PASSWORD_MAX_AGE_DAYS = 365;
  var BACKUP_LOW_THRESHOLD = 2;
  var DAY_MS = 24 * 60 * 60 * 1000;

  function toNum(v) {
    if (v == null || v === '' || typeof v === 'boolean') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  // Última vez que se cambió la contraseña según los eventos de seguridad
  // (eventKey "password_changed"). Devuelve ms o null si no hay dato.
  function lastPasswordChange(events) {
    var best = null;
    if (!events || typeof events !== 'object') return null;
    Object.keys(events).forEach(function (k) {
      var e = events[k];
      if (!e || typeof e !== 'object') return;
      var isPw = e.eventKey === 'password_changed' || e.type === 'Contraseña cambiada';
      if (!isPw) return;
      var ts = toNum(e.timestamp != null ? e.timestamp : e.ts);
      if (ts != null && (best == null || ts > best)) best = ts;
    });
    return best;
  }

  // Sesiones de OTROS dispositivos que el usuario todavía no ha revisado.
  function unreviewedSessions(sessions, currentId, reviewedIds) {
    var reviewed = {};
    (reviewedIds || []).forEach(function (id) { reviewed[String(id)] = true; });
    var out = [];
    Object.keys(sessions || {}).forEach(function (id) {
      var s = sessions[id];
      if (!s || s.revoked === true || s.endedAt) return;
      if (String(id) === String(currentId)) return;
      out.push({ id: String(id), reviewed: !!reviewed[String(id)], lastActivity: toNum(s.lastActivity) });
    });
    return out;
  }

  function levelFor(pct, total) {
    if (!total) return 0;
    if (pct >= 100) return 4;
    if (pct >= 80) return 3;
    if (pct >= 60) return 2;
    if (pct >= 30) return 1;
    return 0;
  }

  /*
   * input: {
   *   emailVerified: boolean,
   *   twoFactor: boolean | null,           // null = no se pudo comprobar
   *   backupCodes: {hasCodes, remaining} | null,
   *   passwordChangedAt: number | null,     // ms
   *   otherSessions: [{id, reviewed, lastActivity}],
   *   now: number
   * }
   */
  function compute(input) {
    input = input || {};
    var now = toNum(input.now) != null ? Number(input.now) : Date.now();
    var items = [];

    items.push({
      id: 'email',
      state: input.emailVerified ? 'ok' : 'todo'
    });

    var tf = input.twoFactor;
    items.push({
      id: 'twofactor',
      state: tf === true ? 'ok' : tf === false ? 'todo' : 'info'
    });

    var bc = input.backupCodes;
    if (tf !== true) {
      items.push({ id: 'backup', state: 'info', reason: 'needs2fa' });
    } else if (!bc) {
      items.push({ id: 'backup', state: 'info', reason: 'unknown' });
    } else if (!bc.hasCodes) {
      items.push({ id: 'backup', state: 'todo', reason: 'none' });
    } else if (toNum(bc.remaining) != null && Number(bc.remaining) <= BACKUP_LOW_THRESHOLD) {
      items.push({ id: 'backup', state: 'todo', reason: 'low', remaining: Number(bc.remaining) });
    } else {
      items.push({ id: 'backup', state: 'ok', remaining: toNum(bc.remaining) });
    }

    var pwAt = toNum(input.passwordChangedAt);
    if (pwAt == null) {
      items.push({ id: 'password', state: 'info', reason: 'nodata' });
    } else {
      var days = Math.max(0, Math.floor((now - pwAt) / DAY_MS));
      items.push({ id: 'password', state: days > PASSWORD_MAX_AGE_DAYS ? 'todo' : 'ok', days: days });
    }

    var others = input.otherSessions || [];
    var pending = others.filter(function (s) { return !s.reviewed; });
    items.push({
      id: 'sessions',
      state: pending.length ? 'todo' : 'ok',
      count: others.length,
      pending: pending.length
    });

    var scored = items.filter(function (it) { return it.state === 'ok' || it.state === 'todo'; });
    var done = scored.filter(function (it) { return it.state === 'ok'; }).length;
    var total = scored.length;
    var pct = total ? Math.round(done / total * 100) : 0;
    return { items: items, done: done, total: total, pct: pct, level: levelFor(pct, total) };
  }

  var api = {
    compute: compute,
    lastPasswordChange: lastPasswordChange,
    unreviewedSessions: unreviewedSessions,
    PASSWORD_MAX_AGE_DAYS: PASSWORD_MAX_AGE_DAYS,
    BACKUP_LOW_THRESHOLD: BACKUP_LOW_THRESHOLD
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DrexSecurityCheckup = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
