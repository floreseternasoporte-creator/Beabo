// PULSO (ciclo lab) — analíticas de creador V1, solo lectura.
//
// Verifica:
//  (a) sondas presentes en el HTML: PULSO_DAYS, drexPulso, openPulsoPanel,
//      contenedores #drex-pulso-card / #drex-pulso-body, hook en openCreatorHub;
//  (b) el bloque Pulso NO escribe: ninguna llamada .push/.set/.update/
//      .transaction/.remove; la lectura es puntual (.once('value')) por el
//      mismo camino que el perfil (communityNotes orderByChild authorId);
//  (c) drexPulsoAggregate (extraída del HTML real y ejecutada en sandbox):
//      agregación de 7 días sobre fixtures + casos borde (0 posts, posts
//      fuera de ventana, campos ausentes, downvotes>upvotes, poll sin total);
//  (d) paridad i18n ES/EN/ZH/PT de las 12 claves nuevas (merge evaluado);
//  (e) paridad index.html == 404.html.
//
// Convención del repo: resuelve ../index.html con fallback a ../src/index.html;
// no depende del historial de git; sin rutas absolutas.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function findFile(names) {
  const cands = [];
  for (const n of names) {
    cands.push(path.join(__dirname, '..', n));
    cands.push(path.join(__dirname, '..', 'src', n));
  }
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('no encontrado: ' + names.join(' / '));
}
const htmlPath = findFile(['index.html']);
const htmlPath404 = findFile(['404.html']);
const html = fs.readFileSync(htmlPath, 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  OK  ' : '  FAIL ') + name);
  if (!cond) failures++;
}

function extractBlock(startMarker, endMarker) {
  const i = html.indexOf(startMarker);
  if (i < 0) throw new Error('no encontrado: ' + startMarker);
  const j = html.indexOf(endMarker, i);
  if (j < 0) throw new Error('no encontrado: ' + endMarker);
  return html.slice(i, j + endMarker.length);
}

function extractFn(name) {
  const i = html.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no encontrada: ' + name);
  let j = html.indexOf('{', i), depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}') { depth--; if (!depth) return html.slice(i, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}

// ---- 1. Sondas estáticas ----------------------------------------------------
check('sonda: var PULSO_DAYS = 7', html.includes('var PULSO_DAYS = 7;'));
check('sonda: var drexPulso (caché en memoria)', html.includes('var drexPulso = { cache: null };'));
check('sonda: function openPulsoPanel(force)', html.includes('function openPulsoPanel(force)'));
check('sonda: function drexPulsoAggregate (núcleo puro)', html.includes('function drexPulsoAggregate(posts, nowMs)'));
check('HTML: contenedor #drex-pulso-card existe', html.includes('id="drex-pulso-card"'));
check('HTML: contenedor #drex-pulso-body existe y nace vacío',
  html.includes('<div id="drex-pulso-body"></div>'));
check('HTML: #drex-pulso-card está dentro de #creator-hub-view',
  html.indexOf('id="drex-pulso-card"') > html.indexOf('id="creator-hub-view"') &&
  html.indexOf('id="drex-pulso-card"') < html.indexOf('id="fiesta-view"'));
check('JS: openCreatorHub dispara openPulsoPanel()',
  html.includes("try { if (typeof openPulsoPanel === 'function') openPulsoPanel(); } catch (_) {}"));
check('JS: caché con TTL corto', html.includes('var PULSO_CACHE_TTL_MS = 60000;'));

// ---- 2. Solo lectura: el bloque Pulso no escribe ----------------------------
const pulsoBlock = extractBlock('// ============ PULSO:', '// ============ /PULSO');
const writeCalls = (pulsoBlock.match(/\.(push|set|update|transaction|remove)\s*\(/g) || [])
  .filter(c => c !== '.push('); // posts.push() es un array en memoria, no escritura a BD
check('Pulso: sin escrituras a BD (solo posts.push en memoria)',
  writeCalls.length === 0);
check('Pulso: lectura puntual .once(\'value\') por el camino del perfil',
  pulsoBlock.includes("ref('communityNotes').orderByChild('authorId')") &&
  pulsoBlock.includes(".once('value')"));

// ---- 3. i18n: paridad ES/EN/ZH/PT del merge ---------------------------------
const iifeSrc = extractBlock('(function drexPulsoI18nMerge() {', '})();');
const i18nBox = { APP_ENGLISH_TEXT: {}, APP_CHINESE_TEXT: {}, APP_PORTUGUESE_TEXT: {} };
vm.createContext(i18nBox);
vm.runInContext(iifeSrc, i18nBox);
const EXPECTED = {
  'Tu actividad de los últimos 7 días': ['Your activity over the last 7 days', '过去 7 天的动态', 'Sua atividade dos últimos 7 dias'],
  'No se pudo cargar tu Pulso. Revisa tu conexión.': ["We couldn't load your Pulso. Check your connection.", '无法加载你的 Pulso，请检查网络连接。', 'Não foi possível carregar seu Pulso. Verifique sua conexão.'],
  'Reintentar': ['Retry', '重试', 'Tentar novamente'],
  'Todavía no hay Pulso': ['No Pulso yet', '还没有 Pulso', 'Ainda não há Pulso'],
  'Publica tu primer post y aquí verás cómo resuena.': ['Publish your first post and you’ll see how it resonates here.', '发布你的第一篇帖子，就能在这里看到它的反响。', 'Publique seu primeiro post e veja aqui como ele repercute.'],
  'Posts publicados por día': ['Posts published per day', '每日发布的帖子', 'Posts publicados por dia'],
  'Posts': ['Posts', '帖子', 'Posts'],
  'Votos recibidos': ['Votes received', '收到的投票', 'Votos recebidos'],
  'Ecos recibidos': ['Echoes received', '收到的回响', 'Ecos recebidos'],
  'Comentarios recibidos': ['Comments received', '收到的评论', 'Comentários recebidos'],
  'Votos en votaciones': ['Poll votes', '投票活动得票', 'Votos em votações'],
  'Actualizar': ['Refresh', '刷新', 'Atualizar'],
};
const dicts = [i18nBox.APP_ENGLISH_TEXT, i18nBox.APP_CHINESE_TEXT, i18nBox.APP_PORTUGUESE_TEXT];
const langNames = ['EN', 'ZH', 'PT'];
langNames.forEach((ln, li) => {
  const missing = Object.keys(EXPECTED).filter(k => dicts[li][k] !== EXPECTED[k][li]);
  check('i18n ' + ln + ': 12/12 claves del merge' + (missing.length ? ' (faltan: ' + missing.join(' | ') + ')' : ''), missing.length === 0);
});

// ---- 4. Agregación en sandbox (función REAL del HTML) -----------------------
const mDays = html.match(/var PULSO_DAYS = (\d+);/);
const sandbox = { PULSO_DAYS: mDays ? Number(mDays[1]) : 7, console };
vm.createContext(sandbox);
vm.runInContext(extractFn('drexPulsoAggregate'), sandbox);
const agg = (posts, now) => vm.runInContext('drexPulsoAggregate(' + JSON.stringify(posts) + ', ' + now + ')', sandbox);

const dayMs = 86400000;
const NOW = Date.now();
const sod = new Date(NOW); sod.setHours(0, 0, 0, 0);
const T0 = sod.getTime(); // inicio de hoy (hora local)
const ts = (daysAgo, msIntoDay) => T0 - daysAgo * dayMs + (msIntoDay == null ? 3600000 : msIntoDay);
// C192: los posts "de hoy" usaban T0+1h, que es FUTURO si el suite corre antes
// de la 01:00 local (drexPulsoAggregate excluye ts > now) — flake que tumbó el
// CI del push aa07b0b a las 00:09 UTC. tsToday: hoy, siempre en pasado.
const tsToday = Math.max(T0, NOW - 60000);

// (A) Agregación básica sobre 7 días
const rA = agg([
  { timestamp: tsToday, upvotes: 10, downvotes: 2, ecosCount: 3, commentsCount: 5, poll: { total: 7 } },
  { timestamp: tsToday, upvotes: 5 },
  { timestamp: ts(2), upvotes: 4, downvotes: 1, ecosCount: 2, commentsCount: 1 },
  { timestamp: ts(6), upvotes: 1 },
], NOW);
check('(A) days tiene 7 buckets', rA.days.length === 7);
check('(A) totales: posts=4, votos=17, ecos=5, comentarios=6, pollVotes=7',
  rA.totals.posts === 4 && rA.totals.votes === 17 && rA.totals.ecos === 5 &&
  rA.totals.comments === 6 && rA.totals.pollVotes === 7);
check('(A) buckets por día: hoy=2, hace-2=1, hace-6=1, resto=0',
  rA.days[6].count === 2 && rA.days[4].count === 1 && rA.days[0].count === 1 &&
  rA.days[1].count === 0 && rA.days[2].count === 0 && rA.days[3].count === 0 && rA.days[5].count === 0);
check('(A) empty=false', rA.empty === false);

// (B) Borde: 0 posts
const rB = agg([], NOW);
check('(B) 0 posts: todo en 0 y empty=true',
  rB.totals.posts === 0 && rB.totals.votes === 0 && rB.totals.ecos === 0 &&
  rB.totals.comments === 0 && rB.totals.pollVotes === 0 && rB.empty === true &&
  rB.days.every(d => d.count === 0));

// (C) Borde: fuera de ventana
const rC = agg([
  { timestamp: ts(7), upvotes: 100 },            // 7 días atrás: fuera
  { timestamp: ts(30), upvotes: 100 },           // 30 días atrás: fuera
  { timestamp: NOW + 3600000, upvotes: 100 },    // futuro: fuera
  { timestamp: T0 - 6 * dayMs, upvotes: 3 },     // borde exacto: dentro
], NOW);
check('(C) solo el post del borde exacto cuenta (posts=1, votos=3)',
  rC.totals.posts === 1 && rC.totals.votes === 3 && rC.empty === false);

// (D) Borde: campos ausentes / entradas nulas
const rD = agg([null, undefined, { timestamp: ts(1) }, { timestamp: 0, upvotes: 9 }], NOW);
check('(D) post sin contadores suma 0; sin timestamp se excluye (posts=1)',
  rD.totals.posts === 1 && rD.totals.votes === 0 && rD.totals.ecos === 0 &&
  rD.totals.comments === 0 && rD.totals.pollVotes === 0);

// (E) Borde: downvotes > upvotes no resta (convención de la tarjeta)
const rE = agg([{ timestamp: ts(1), upvotes: 2, downvotes: 5 }], NOW);
check('(E) votos netos con floor en 0 (2-5 → 0)', rE.totals.votes === 0 && rE.totals.posts === 1);

// (F) Borde: poll sin total / sin poll
const rF = agg([
  { timestamp: ts(1), poll: {} },
  { timestamp: ts(1), upvotes: 1 },
], NOW);
check('(F) poll sin total y post sin poll → pollVotes=0', rF.totals.pollVotes === 0 && rF.totals.posts === 2);

// ---- 5. Paridad index.html == 404.html --------------------------------------
const html404 = fs.readFileSync(htmlPath404, 'utf8');
check('index.html byte-idéntico a 404.html', html === html404);

console.log(failures ? `\n${failures} checks FAILED` : '\ntest-pulso-aggregate: TODO OK');
process.exit(failures ? 1 : 0);
