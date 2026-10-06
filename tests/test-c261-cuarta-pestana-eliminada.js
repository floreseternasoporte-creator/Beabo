'use strict';
/* C261 — "Mi Marea" eliminada por completo de la plataforma (orden del
 * usuario, 2026-10-06): pestaña del feed, botón Seguir ondas, filtro y
 * ranking por ondas seguidas, vacíos propios, estilos, textos i18n y el
 * módulo entero (seguía ondas en localStorage). "Ondas" (#tags y la vista
 * de descubrimiento de ondas) NO es Marea y se conserva.
 * Ejecutar: node tests/test-c261-cuarta-pestana-eliminada.js
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
function ok(cond, name) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name); }
}

const root = path.join(__dirname, '..');
const files = ['index.html', '404.html', 'drex-i18n.js', 'drex-cloud.js'];
for (const f of files) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  ok(!/marea/i.test(src), f + ': cero referencias');
}
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

console.log('== El feed conserva sus tres órdenes ==');
for (const tab of ['foryou', 'following', 'popular']) {
  ok(html.includes('data-tab="' + tab + '"'), 'pestaña presente: ' + tab);
  ok(html.includes("switchFeedTab('" + tab + "')"), 'switchFeedTab presente: ' + tab);
}
ok(!html.includes('drex-marea-followbtn'), 'fuera el botón Seguir de ondas con su CSS');
ok(html.includes('drex_ondas_followed_v1') /* solo para limpiar dispositivos */, 'queda únicamente la limpieza de la clave local vieja');

console.log('== Ondas (#) NO es la pestaña eliminada y sigue viva ==');
ok(html.includes('id="ondas-view"') || html.includes('openOndasView'), 'la vista de descubrimiento de ondas sigue');
ok(html.includes('openHashtagSearch') || html.includes("hashtag"), 'los hashtags siguen funcionando');

console.log(failures ? '\nRESULTADO: ' + failures + ' FALLO(S)' : '\nRESULTADO: TODO VERDE');
process.exit(failures ? 1 : 0);
