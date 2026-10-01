'use strict';
/*
 * test-money-routes-idempotency.js — Triage rutas de dinero (cliente).
 * node, sin dependencias externas.
 *
 * Estrategia: extrae el objeto `var DrexCoins = {...}` del index.html real
 * (escaneo con balance de llaves que respeta strings y comentarios) y lo
 * evalua con un DrexCloud falso en memoria que implementa la semantica del
 * contrato: transaction() ejecuta updateFn en el cliente, aborta si devuelve
 * undefined, y permite inyectar el fallo documentado en drex-cloud.js:
 * "un fallo del re-read convierte un commit exitoso en promesa rechazada".
 *
 * Uso: node tests/test-money-routes-idempotency.js  -> exit 0 si todo pasa.
 */
var fs = require('fs');
var path = require('path');

var failures = 0;
function ok(cond, name) {
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.error('  ROJO: ' + name); }
}

/* ---------- extraccion del bloque DrexCoins del index.html real ---------- */
function extractDrexCoins(html) {
  var startMarker = 'var DrexCoins = {';
  var si = html.indexOf(startMarker);
  if (si < 0) throw new Error('bloque DrexCoins no encontrado');
  var i = si + startMarker.length - 1; // en el '{'
  var depth = 0, inStr = null, inLine = false, inBlock = false;
  for (; i < html.length; i++) {
    var c = html[i], n = html[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error('llaves sin balance en DrexCoins');
  return html.slice(si, i);
}

var htmlPath = path.join(__dirname, '..', 'index.html');
var html = fs.readFileSync(htmlPath, 'utf8');
var drexCoinsSrc = extractDrexCoins(html);
ok(drexCoinsSrc.indexOf('_verifyIdem') >= 0, 'el DrexCoins extraido incluye el fix de idempotencia');

/* ---------- FakeDB: semantica fiel del contrato ---------- */
function clone(v) {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}
function FakeDB() {
  this.store = {};          // path normalizado -> valor
  this.failTxReread = 0;    // prox. N transaction(): commitean pero RECHAZAN (fallo re-read)
  this.failReads = 0;       // prox. N once('value') rechazan
  this.pushN = 0;
}
FakeDB.prototype._norm = function (p) {
  return String(p || '').split('/').filter(function (s) { return s !== ''; });
};
FakeDB.prototype._get = function (segs) {
  var node = this.store;
  for (var i = 0; i < segs.length; i++) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[segs[i]];
  }
  return clone(node);
};
FakeDB.prototype._set = function (segs, v) {
  var node = this.store;
  for (var i = 0; i < segs.length - 1; i++) {
    if (node[segs[i]] === null || typeof node[segs[i]] !== 'object') node[segs[i]] = {};
    node = node[segs[i]];
  }
  node[segs[segs.length - 1]] = clone(v);
};
function snapOf(v, children) {
  return {
    val: function () { return clone(v); },
    forEach: function (cb) {
      if (!children) return;
      Object.keys(children).forEach(function (k) { cb({ val: function () { return clone(children[k]); } }); });
    }
  };
}
function FakeRef(db, segs) { this._db = db; this._segs = segs; this.key = segs[segs.length - 1] || null; }
FakeRef.prototype.child = function (p) { return new FakeRef(this._db, this._segs.concat(this._db._norm(p))); };
FakeRef.prototype.once = function () {
  var db = this._db;
  if (db.failReads > 0) { db.failReads--; return Promise.reject(new Error('read-fail')); }
  var v = db._get(this._segs);
  return Promise.resolve(snapOf(v === undefined ? null : v));
};
FakeRef.prototype.set = function (v) { this._db._set(this._segs, v); return Promise.resolve(); };
FakeRef.prototype.push = function () {
  var db = this._db; db.pushN++;
  var r = this.child('push' + db.pushN); r.key = 'push' + db.pushN; return r;
};
FakeRef.prototype.transaction = function (updateFn) {
  var db = this._db;
  var cur = db._get(this._segs);
  var newVal;
  try { newVal = updateFn(cur === undefined ? null : cur); }
  catch (e) { return Promise.reject(e); }
  if (newVal === undefined) {
    return Promise.resolve({ committed: false, snapshot: snapOf(cur === undefined ? null : cur) });
  }
  db._set(this._segs, newVal);
  if (db.failTxReread > 0) {
    db.failTxReread--;
    // El debito SE APLICO; solo falla la lectura posterior (caso documentado).
    return Promise.reject(new Error('re-read-fail'));
  }
  return Promise.resolve({ committed: true, snapshot: snapOf(clone(newVal)) });
};
FakeRef.prototype.orderByChild = function (child) {
  var self = this;
  return {
    limitToLast: function (n) {
      return {
        once: function () {
          var v = self._db._get(self._segs) || {};
          var arr = Object.keys(v).map(function (k) { return v[k]; });
          arr.sort(function (a, b) { return (a[child] || 0) - (b[child] || 0); });
          var last = arr.slice(-n);
          var obj = {}; last.forEach(function (e, i) { obj['k' + i] = e; });
          return Promise.resolve(snapOf(obj, obj));
        }
      };
    }
  };
};

var db = new FakeDB();
global.DrexCloud = { database: function () { return { ref: function (p) { return new FakeRef(db, db._norm(p)); } }; } };
global.liveUser = function () { return { uid: 'u1' }; };

/* eslint-disable no-eval */
var DrexCoins;
eval(drexCoinsSrc.replace('var DrexCoins =', 'DrexCoins ='));
/* eslint-enable no-eval */
if (!DrexCoins || typeof DrexCoins.spend !== 'function') { console.error('ROJO: DrexCoins no cargo'); process.exit(1); }

function walletOf(uid) { return db._get(db._norm('wallets/' + uid)) || {}; }
function txsOf(uid) { return db._get(db._norm('transactions/' + uid)) || {}; }
function setWallet(uid, w) { db._set(db._norm('wallets/' + uid), w); DrexCoins._cache[uid] = null; }

async function main() {
  console.log('-- atomicidad e idempotencia del debito --');

  // 1) spend normal: debita y asienta en el libro con clave determinista
  setWallet('u1', { coins: 100, diamonds: 0 });
  var r1 = await DrexCoins.spend(30, { type: 'gift_sent', giftId: 'chispa', liveId: 'L1', idem: 't1' });
  ok(r1 === true, 'spend(30) con saldo 100 -> true');
  ok(walletOf('u1').coins === 70, 'saldo queda en 70');
  var txs = txsOf('u1');
  var keys = Object.keys(txs);
  ok(keys.length === 1 && keys[0] === 'tx_t1', 'un solo asiento en el libro con clave determinista tx_t1');
  ok(txs[keys[0]].amount === -30 && txs[keys[0]].balance === 70, 'asiento con monto -30 y balance 70');

  // 2) saldo insuficiente: no debita, no asienta
  setWallet('u1', { coins: 10, diamonds: 0 });
  var r2 = await DrexCoins.spend(30, { type: 'gift_sent', giftId: 'chispa', liveId: 'L1', idem: 't2' });
  ok(r2 === false, 'spend(30) con saldo 10 -> false');
  ok(walletOf('u1').coins === 10, 'saldo intacto en 10');
  ok(Object.keys(txsOf('u1')).length === 1, 'sin asiento nuevo tras fallo');

  // 3) EL BUG: commit aplicado + re-read fallido.
  // Antes del fix: _apply devolvia null -> "No tienes suficientes" con el
  // cobro ya aplicado y sin rastro en el libro. Ahora debe reportar exito.
  setWallet('u1', { coins: 100, diamonds: 0 });
  db.failTxReread = 1;
  var r3 = await DrexCoins.spend(30, { type: 'gift_sent', giftId: 'chispa', liveId: 'L1', idem: 't3' });
  ok(r3 === true, 'spend con re-read fallido post-commit -> true (no miente)');
  ok(walletOf('u1').coins === 70, 'debito aplicado una sola vez (70)');
  var txs3 = txsOf('u1');
  ok(Object.keys(txs3).filter(function (k) { return k === 'tx_t3'; }).length === 1, 'el asiento tx_t3 existe pese al fallo de lectura');

  // 4) reintento con la MISMA idem tras resultado dudoso: exactamente una vez
  setWallet('u1', { coins: 100, diamonds: 0 });
  var a1 = await DrexCoins._apply('u1', -30, 0, { type: 'gift_sent', amount: -30, currency: 'coins', meta: { idem: 't4' } });
  var a2 = await DrexCoins._apply('u1', -30, 0, { type: 'gift_sent', amount: -30, currency: 'coins', meta: { idem: 't4' } });
  ok(!!a1 && !!a2, 'ambos intentos reportan exito');
  ok(walletOf('u1').coins === 70, 'el reintento NO debita dos veces (70, no 40)');
  var txs4 = txsOf('u1');
  ok(Object.keys(txs4).filter(function (k) { return k === 'tx_t4'; }).length === 1, 'un solo asiento tx_t4 tras reintento');

  // 5) doble-tap: dos spends concurrentes de 80 con saldo 100 -> uno pasa
  setWallet('u1', { coins: 100, diamonds: 0 });
  var p1 = DrexCoins.spend(80, { type: 'gift_sent', giftId: 'g1', liveId: 'L1', idem: 't5a' });
  var p2 = DrexCoins.spend(80, { type: 'gift_sent', giftId: 'g2', liveId: 'L1', idem: 't5b' });
  var rr = await Promise.all([p1, p2]);
  var okCount = rr.filter(Boolean).length;
  ok(okCount === 1, 'doble spend concurrente: exactamente uno tiene exito');
  var w5 = walletOf('u1');
  ok(w5.coins === 20 && w5.coins >= 0, 'saldo final 20, nunca negativo');

  // 6) balances negativos imposibles via _apply directo
  setWallet('u1', { coins: 5, diamonds: 0 });
  var r6 = await DrexCoins._apply('u1', -999999, 0, { type: 'gift_sent', amount: -999999, currency: 'coins', meta: { idem: 't6' } });
  ok(r6 === null && walletOf('u1').coins === 5, 'debito gigante aborta: null y saldo intacto');

  // 7) creditDiamonds acredita diamantes sin tocar coins
  setWallet('u1', { coins: 70, diamonds: 2 });
  var r7 = await DrexCoins.creditDiamonds('u1', 5, { type: 'gift_received', giftId: 'chispa', liveId: 'L1', from: 'u2', idem: 't7' });
  var w7 = walletOf('u1');
  ok(r7 === true && w7.diamonds === 7 && w7.coins === 70, 'diamantes 2 -> 7, coins intactas');

  // 8) history() ordena por ts descendente
  var h = await DrexCoins.history('u1', 20);
  var sorted = true;
  for (var i = 1; i < h.length; i++) if ((h[i - 1].ts | 0) - (h[i].ts | 0) < 0 && (h[i - 1].ts - h[i].ts) < 0) sorted = false;
  ok(sorted, 'history() devuelve asientos ordenados por ts descendente');

  console.log('-- matematica de paquetes y tasa de diamantes (desde index.html) --');

  // 9) paquetes: coins == base*(1+bonus/100), bonus creciente, USD/coin decreciente
  var pm = html.match(/var DREX_COIN_PACKAGES = \[([\s\S]*?)\];/);
  ok(!!pm, 'DREX_COIN_PACKAGES encontrado');
  var pkgs = [];
  var re = /\{ id: '([^']+)',\s*name: '[^']*',\s*coins: (\d+),\s*base: (\d+),\s*bonus: (\d+),\s*usd: ([\d.]+)/g, m;
  while ((m = re.exec(pm[1]))) pkgs.push({ id: m[1], coins: +m[2], base: +m[3], bonus: +m[4], usd: +m[5] });
  ok(pkgs.length === 6, '6 paquetes definidos');
  var mathOk = pkgs.every(function (p) { return p.coins === Math.round(p.base * (1 + p.bonus / 100)); });
  ok(mathOk, 'coins == base*(1+bonus/100) en los 6 paquetes');
  var bonusOk = pkgs.every(function (p, i) { return i === 0 || p.bonus > pkgs[i - 1].bonus; });
  ok(bonusOk, 'bonus estrictamente creciente: ' + pkgs.map(function (p) { return p.bonus; }).join(','));
  var valOk = pkgs.every(function (p, i) { return i === 0 || (p.usd / p.coins) < (pkgs[i - 1].usd / pkgs[i - 1].coins); });
  ok(valOk, 'USD por coin estrictamente decreciente (mejor valor al subir de tier)');

  // 10) tasa de diamantes; los regalos de en vivo se eliminaron en Fase 2/3
  var rate = html.match(/var DREX_DIAMOND_RATE = (\d+);/);
  ok(rate && +rate[1] === 10, 'DREX_DIAMOND_RATE = 10');
  ok(html.indexOf('var DREX_LIVE_GIFTS') === -1, 'DREX_LIVE_GIFTS eliminado con los regalos de en vivo (Fase 2/3)');

  // 11) el comentario viejo "20" ya no existe; el codigo y la UI dicen 10
  ok(html.indexOf('por cada 20 Drex Coins') < 0, 'comentario obsoleto "cada 20" eliminado');
  ok(html.indexOf('por cada 10 Drex Coins recibidas en regalos') >= 0, 'schema + UI coinciden en 10');

  console.log('-- drexLiveSendGift eliminado con los regalos de en vivo (Fase 2/3) --');
  ok(html.indexOf('window.drexLiveSendGift') === -1, 'drexLiveSendGift ya no existe');

  console.log(failures === 0 ? '\nVERDE: todo pasa' : '\nROJO: ' + failures + ' fallos');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(function (e) { console.error('ROJO: excepcion ' + (e && e.stack || e)); process.exit(1); });
