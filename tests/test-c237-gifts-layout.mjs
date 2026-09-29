// Test C237-L3: layout de la hoja de Regalos medido de verdad en Chromium.
// Uso: node test_gifts_layout.mjs <harness.html> <shot.png>
// Sale 0 si todo pasa, 1 si hay solapes/cortes. CDP en 127.0.0.1:9333.
import WebSocket from '/home/hatch/workspace/cdp-tools/node_modules/ws/lib/websocket.js';
import { writeFileSync } from 'fs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const [harness, shotPath] = process.argv.slice(2);

// Pestana fresca via PUT /json/new: no depender del estado ambiente del navegador
// (una pestana zombi de una corrida sin args dejaba el test colgado 90s).
const tab = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
let id = 0;
const pending = new Map();
ws.on('message', d => {
  const m = JSON.parse(d.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise(r => ws.on('open', r));
const send = (m, p = {}) => new Promise(res => { const c = ++id; pending.set(c, res); ws.send(JSON.stringify({ id: c, method: m, params: p })); });
const ev = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.result.value;

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: 'file://' + harness });
// Espera robusta: el index completo (~5MB) tarda mas de 1200ms en parsear/ejecutar.
for (let _wi = 0; _wi < 90; _wi++) {
  // NOTA: DrexCoins vive dentro de un IIFE (no es global); no se espera por el aqui.
  const _ready = await ev(`document.readyState === 'complete' && typeof drexLiveOpenGifts === 'function' && typeof DrexLiveUI !== 'undefined'`);
  if (_ready) break;
  await sleep(1000);
}
await sleep(500);
const _loaded = await ev(`typeof drexLiveOpenGifts === 'function'`);
if (!_loaded) {
  console.log('C237-L3 ROJO: la pagina no expuso drexLiveOpenGifts en 90s');
  try { await fetch('http://127.0.0.1:9333/json/close/' + tab.id, { method: 'PUT' }); } catch (_) {}
  ws.close();
  process.exit(1);
}

const M = await ev(`(() => {
  // Saldo de prueba via el handle DrexLiveUI (DrexCoins vive dentro de un IIFE y no es
  // alcanzable desde el scope global; sin sesion el saldo real seria 0).
  try { if (window.DrexLiveUI && DrexLiveUI._testSetCoinsBalance) DrexLiveUI._testSetCoinsBalance(1234); } catch (_) {}
  drexLiveOpenGifts('viewer');
  const R = el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
  const panel = document.querySelector('#drex-live-gifts > div:last-child');
  const cards = [...document.querySelectorAll('.drex-live-gift')];
  const heads = [...document.querySelectorAll('.dlgs-tier-head, p.drex-live-gift-tier')];
  const prices = [...document.querySelectorAll('.drex-live-gift .p')];
  const secs = [...document.querySelectorAll('.dlgs-tier')].map(s => ({ head: R(s.querySelector('.dlgs-tier-head')), grid: R(s.querySelector('.dlgs-tier-grid')) }));
  const sub = document.querySelector('.dlgs-sub');
  return {
    panel: R(panel), cards: cards.map(R), heads: heads.map(R),
    prices: prices.map(p => R(p)),
    secs, sub: sub ? R(sub) : null,
    balance: document.getElementById('drex-live-gift-balance-n').textContent,
    hidden: document.getElementById('drex-live-gifts').classList.contains('hidden'),
    nCards: cards.length, nHeads: heads.length,
    gids: cards.map(c => c.getAttribute('data-gid'))
  };
})()`);

const fails = [];
const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
                        Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

if (M.hidden) fails.push('la hoja no se abrió');
if (M.nCards !== 20) fails.push(`tarjetas: ${M.nCards} (esperado 20)`);
if (M.nHeads !== 4) fails.push(`encabezados de tier: ${M.nHeads} (esperado 4)`);
if (M.balance !== '1234') fails.push(`saldo no actualizado: '${M.balance}'`);
if (new Set(M.gids).size !== 20) fails.push('data-gid duplicados o faltantes');

// 1. Ninguna tarjeta se solapa con otra
for (let i = 0; i < M.cards.length; i++)
  for (let j = i + 1; j < M.cards.length; j++)
    if (inter(M.cards[i], M.cards[j]) > 1) { fails.push(`tarjetas ${i} y ${j} se solapan`); i = 99; break; }

// 2. Ningún encabezado se solapa con tarjetas
M.heads.forEach((h, hi) => M.cards.forEach((c, ci) => {
  if (inter(h, c) > 1) fails.push(`encabezado ${hi} se solapa con tarjeta ${ci}`);
}));

// 3. Tarjetas dentro del panel horizontalmente (nada cortado)
M.cards.forEach((c, i) => {
  if (c.x < M.panel.x - 1 || c.x + c.w > M.panel.x + M.panel.w + 1)
    fails.push(`tarjeta ${i} cortada por el borde (x=${c.x.toFixed(0)} w=${c.w.toFixed(0)} panel=${M.panel.w.toFixed(0)})`);
});

// 4. La hoja cabe en el viewport
if (M.panel.y < -1) fails.push(`hoja más alta que la pantalla (top=${M.panel.y.toFixed(0)})`);
if (M.panel.h > 844 * 0.87 + 2) fails.push(`hoja excede 86vh (h=${M.panel.h.toFixed(0)})`);

// 5. Precio dentro de su tarjeta
M.prices.forEach((p, i) => {
  const c = M.cards[i];
  if (p.x < c.x - 1 || p.x + p.w > c.x + c.w + 1 || p.y < c.y - 1 || p.y + p.h > c.y + c.h + 1)
    fails.push(`precio ${i} fuera de su tarjeta`);
});

// 6. Cada encabezado arriba de su propia rejilla
M.secs.forEach((s, i) => {
  if (s.head.y + s.head.h > s.grid.y + 1) fails.push(`encabezado ${i} no está arriba de su rejilla`);
});

// 7. Anchos de tarjeta uniformes (todas iguales ±1px)
const ws_ = M.cards.map(c => Math.round(c.w));
if (new Set(ws_).size > 1) fails.push(`anchos no uniformes: ${[...new Set(ws_)]}`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));

console.log(JSON.stringify({ panel: M.panel, fails }, null, 1));
console.log(fails.length === 0 ? 'C237-L3 VERDE' : `C237-L3 ROJO: ${fails.length} fallos`);
try { await fetch('http://127.0.0.1:9333/json/close/' + tab.id, { method: 'PUT' }); } catch (_) {}
ws.close();
process.exit(fails.length === 0 ? 0 : 1);
