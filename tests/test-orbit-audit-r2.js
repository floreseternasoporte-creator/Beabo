/* Test: correcciones de la auditoría profunda de Drex Orbit (ronda 2).
 * - Normalización de plan acepta los 4 planes (monthly/quarterly/semiannual/yearly).
 * - DrexOrbit.reset() existe y limpia _st/_ts/_serverConfigured.
 * - El reset se engancha en clearAccountScopedState() (logout).
 * - drexOrbitBoostActive respeta orbitBoostUntil (fail-closed sin fecha).
 * - Los ordenamientos usan el helper con guardia.
 * - Las filas de beneficios son botones con orbitBenefitTap expuesto en window.
 */
'use strict';
var fs = require('fs');
var ROOT = process.env.ORBIT_TEST_ROOT || '/home/hatch/workspace/drex-orbit2';
var src = fs.readFileSync(ROOT + '/index.html', 'utf8');

var ok = 0, bad = 0;
function t(name, cond) {
  if (cond) { ok++; console.log('ok - ' + name); }
  else { bad++; console.log('FALLO - ' + name); }
}

// 1. Normalización de planes: los 4 aceptados en refresh() y _setTestState().
var normCount = (src.match(/ORBIT_PLANS\[(data|st)\.plan\]\) \? \1\.plan : null/g) || []).length;
t('normalización acepta los 4 planes (2 sitios)', normCount === 2);
t('ya no hay normalización solo monthly/yearly',
  src.indexOf("(data.plan === 'monthly' || data.plan === 'yearly')") === -1 &&
  src.indexOf("(st.plan === 'monthly' || st.plan === 'yearly')") === -1);

// 2. DrexOrbit.reset().
var mReset = src.match(/reset: function \(\) \{\n    this\._st = null[\s\S]*?\n  \},/);
t('DrexOrbit.reset existe', !!mReset);
t('reset limpia _st, _ts y _serverConfigured',
  !!mReset && mReset[0].indexOf('this._st = null') !== -1 &&
  mReset[0].indexOf('this._ts = 0') !== -1 &&
  mReset[0].indexOf('this._serverConfigured = false') !== -1);

// 3. Hook en clearAccountScopedState().
t('clearAccountScopedState llama a DrexOrbit.reset',
  src.indexOf("DrexOrbit.reset === 'function') DrexOrbit.reset()") !== -1);

// 4. Reset al iniciar la rama login.
t('rama login resetea antes del refresh', src.indexOf('DrexOrbit.reset(); } catch (_) {} /* sin estado heredado') !== -1);

// 5. drexOrbitBoostActive.
var mBoost = src.match(/function drexOrbitBoostActive\(note\) \{[\s\S]*?\n\}/);
t('drexOrbitBoostActive existe', !!mBoost);
t('boost fail-closed sin fecha (no until -> false)', !!mBoost && mBoost[0].indexOf('if (!until) return false;') !== -1);
t('boost respeta expiración', !!mBoost && mBoost[0].indexOf('Date.now() < until') !== -1);
t('drexOrbitBoostActive expuesto en window', src.indexOf('window.drexOrbitBoostActive = drexOrbitBoostActive;') !== -1);

// 6. Los ordenamientos usan el helper.
var sortUses = (src.match(/window\.drexOrbitBoostActive\(note\)/g) || []).length;
t('los 2 ordenamientos usan el helper con guardia', sortUses === 2);
t('ya no hay (note.orbitBoost ? 25 : 0) directo', src.indexOf('(note.orbitBoost ? 25 : 0)') === -1);

// 7. Se marca orbitBoostUntil al publicar.
t('al publicar se marca orbitBoostUntil', src.indexOf('note.orbitBoostUntil = Number(__ost.currentPeriodEnd) * 1000') !== -1);

// 8. Filas de beneficios tocables.
t('filas de beneficios son <button>', src.indexOf('<button type="button" onclick="orbitBenefitTap') !== -1);
t('orbitBenefitTap existe', src.indexOf('function orbitBenefitTap(feature) {') !== -1);
t('orbitBenefitTap expuesto en window', src.indexOf('window.orbitBenefitTap = orbitBenefitTap;') !== -1);
t('sin membresía abre el paywall del beneficio',
  src.indexOf("openOrbitPaywall(feature); } catch (_) {}") !== -1);

// 9. Comportamiento del helper (evaluación real).
var fnSrc = mBoost[0];
var drexOrbitBoostActive = new Function('note', fnSrc.replace(/^function drexOrbitBoostActive\(note\) \{/, '').replace(/\}$/, ''));
var now = Date.now();
t('helper: boost futuro -> true', drexOrbitBoostActive({ orbitBoost: true, orbitBoostUntil: now + 99999 }) === true);
t('helper: boost vencido -> false', drexOrbitBoostActive({ orbitBoost: true, orbitBoostUntil: now - 1 }) === false);
t('helper: sin fecha -> false', drexOrbitBoostActive({ orbitBoost: true }) === false);
t('helper: sin marca -> false', drexOrbitBoostActive({}) === false);

console.log('\nRESULTADO ORBIT-AUDIT-R2: ' + ok + ' ok, ' + bad + ' fallos');
process.exit(bad ? 1 : 0);
