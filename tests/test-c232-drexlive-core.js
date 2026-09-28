'use strict';
/*
 * test-c232-drexlive-core.js — Tests del núcleo DrexLive (C232).
 * node, sin dependencias externas.
 *
 * Estrategia: FakeDB en memoria (implementa fielmente la API ref del
 * contrato: child/push/pushAsync/set/update/remove/once/on/transaction,
 * con child_added inicial al suscribirse y off) + FakeRTC (dos
 * PeerConnection falsos que completan offer/answer/ICE en proceso y
 * entregan un FakeMediaStream al viewer).
 *
 * Uso: node test-c232-drexlive-core.js  → exit 0 si todo pasa.
 */
var path = require('path');

var DrexLiveCore = null;
try {
  DrexLiveCore = require(path.join('..', 'drexlive-core.js'));
} catch (e) {
  console.error('ROJO: no se pudo cargar ../drexlive-core.js: ' + (e && e.message));
  process.exit(1);
}
if (typeof DrexLiveCore !== 'function') {
  console.error('ROJO: drexlive-core.js no exporta una factory DrexLiveCore (function).');
  process.exit(1);
}

/* ================= FakeDB ================= */

function clone(v) {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}
function normPath(p) {
  return String(p == null ? '' : p).split('/').filter(function (s) { return s !== ''; }).join('/');
}

function FakeDB() {
  this._data = {};
  this._listeners = {}; // path -> { value: [], child_added: [], child_removed: [] }
  this._pushN = 0;
}
FakeDB.prototype._get = function (path) {
  if (!path) return this._data;
  var parts = path.split('/');
  var node = this._data;
  for (var i = 0; i < parts.length; i++) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[parts[i]];
  }
  return node;
};
FakeDB.prototype._setNode = function (path, v) {
  if (!path) { this._data = v || {}; return; }
  var parts = path.split('/');
  var node = this._data;
  for (var i = 0; i < parts.length - 1; i++) {
    if (node[parts[i]] == null || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = v;
};
FakeDB.prototype._delNode = function (path) {
  if (!path) { this._data = {}; return; }
  var parts = path.split('/');
  var node = this._data;
  for (var i = 0; i < parts.length - 1; i++) {
    if (node == null || typeof node[parts[i]] !== 'object') return;
    node = node[parts[i]];
  }
  if (node != null) delete node[parts[parts.length - 1]];
};
FakeDB.prototype._snap = function (path) {
  var self = this;
  var key = path ? path.split('/').pop() : null;
  return {
    key: key,
    val: function () {
      var n = self._get(path);
      return n === undefined ? null : clone(n);
    },
    exists: function () { return self._get(path) !== undefined; }
  };
};
FakeDB.prototype._emit = function (path, type, snap) {
  var L = this._listeners[path];
  if (!L || !L[type]) return;
  L[type].slice().forEach(function (cb) {
    try { cb(snap); } catch (e) { /* el oyente no debe romper el bus */ }
  });
};
FakeDB.prototype._on = function (path, type, cb) {
  var L = this._listeners[path] || (this._listeners[path] = { value: [], child_added: [], child_removed: [] });
  L[type].push(cb);
  var self = this;
  return function off() {
    var arr = (self._listeners[path] || {})[type] || [];
    var i = arr.indexOf(cb);
    if (i >= 0) arr.splice(i, 1);
  };
};
FakeDB.prototype._notifySet = function (path, existed) {
  var parts = path ? path.split('/') : [];
  var i, ap;
  for (i = parts.length; i >= 0; i--) {
    ap = parts.slice(0, i).join('/');
    this._emit(ap, 'value', this._snap(ap));
  }
  if (path && !existed) {
    var pp = parts.slice(0, -1).join('/');
    this._emit(pp, 'child_added', this._snap(path));
  }
};
FakeDB.prototype._notifyRemove = function (path, oldVal) {
  var self = this;
  var parts = path ? path.split('/') : [];
  var key = path ? parts[parts.length - 1] : null;
  var i, ap;
  for (i = parts.length; i >= 0; i--) {
    ap = parts.slice(0, i).join('/');
    this._emit(ap, 'value', this._snap(ap));
  }
  if (path) {
    var pp = parts.slice(0, -1).join('/');
    this._emit(pp, 'child_removed', {
      key: key,
      val: function () { return clone(oldVal); },
      exists: function () { return false; }
    });
  }
};
FakeDB.prototype.ref = function (p) { return new FakeRef(this, normPath(p)); };

function FakeRef(db, p) {
  this._db = db;
  this._path = p;
  this.key = p ? p.split('/').pop() : null;
}
FakeRef.prototype.child = function (p) {
  var np = this._path ? this._path + '/' + normPath(p) : normPath(p);
  return new FakeRef(this._db, np);
};
FakeRef.prototype.set = function (v) {
  var db = this._db;
  var existed = db._get(this._path) !== undefined;
  db._setNode(this._path, clone(v));
  db._notifySet(this._path, existed);
  return Promise.resolve();
};
FakeRef.prototype.update = function (obj) {
  var self = this;
  var keys = Object.keys(obj || {});
  var chain = Promise.resolve();
  keys.forEach(function (k) {
    chain = chain.then(function () { return self.child(k).set(obj[k]); });
  });
  return chain.then(function () { return undefined; });
};
FakeRef.prototype.push = function (v) {
  var db = this._db;
  var key = 'p' + (++db._pushN) + '_' + Date.now().toString(36);
  var r = this.child(key);
  if (v !== undefined) r.set(v);
  return r;
};
FakeRef.prototype.pushAsync = function (v) {
  var r = this.push(v);
  return Promise.resolve(r);
};
FakeRef.prototype.remove = function () {
  var db = this._db;
  var oldVal = clone(db._get(this._path));
  var existed = oldVal !== undefined;
  db._delNode(this._path);
  if (existed) db._notifyRemove(this._path, oldVal);
  else db._notifyRemove(this._path, null);
  return Promise.resolve();
};
FakeRef.prototype.once = function (type) {
  if (type !== 'value') return Promise.reject(new Error('FakeDB.once solo soporta value'));
  return Promise.resolve(this._db._snap(this._path));
};
FakeRef.prototype.on = function (type, cb) {
  var db = this._db, p = this._path;
  if (type === 'value') {
    var offV = db._on(p, 'value', cb);
    cb(db._snap(p)); // disparo inicial con estado actual
    return offV;
  }
  if (type === 'child_added') {
    var offA = db._on(p, 'child_added', cb);
    var node = db._get(p);
    if (node != null && typeof node === 'object') {
      Object.keys(node).forEach(function (k) { cb(db._snap(p ? p + '/' + k : k)); });
    }
    return offA;
  }
  if (type === 'child_removed') {
    return db._on(p, 'child_removed', cb);
  }
  throw new Error('FakeDB.on: tipo no soportado ' + type);
};
FakeRef.prototype.onDisconnect = function () {
  var self = this;
  return {
    set: function () { return { cancel: function () { return Promise.resolve(); } }; },
    update: function () { return { cancel: function () { return Promise.resolve(); } }; },
    remove: function () {
      self._odiscArmed = true;
      return { cancel: function () { self._odiscArmed = false; return Promise.resolve(); } };
    }
  };
};
FakeRef.prototype.transaction = function (fn) {
  var self = this;
  return Promise.resolve().then(function () {
    var cur = self._db._get(self._path);
    var nv = fn(cur === undefined ? null : clone(cur));
    if (nv === undefined) return { committed: false, snapshot: self._db._snap(self._path) };
    return self.set(nv).then(function () {
      return { committed: true, snapshot: self._db._snap(self._path) };
    });
  });
};

/* ================= FakeRTC ================= */

var _fmsN = 0;
function fakeTrack(kind, id) {
  return { kind: kind, id: id, enabled: true, stop: function () {} };
}
function FakeMediaStream(tracks) {
  this._tracks = (tracks || []).slice();
  this.id = 'fms-' + (++_fmsN);
}
FakeMediaStream.prototype.getTracks = function () { return this._tracks.slice(); };
FakeMediaStream.prototype.getVideoTracks = function () {
  return this._tracks.filter(function (t) { return t.kind === 'video'; });
};
FakeMediaStream.prototype.getAudioTracks = function () {
  return this._tracks.filter(function (t) { return t.kind === 'audio'; });
};
FakeMediaStream.prototype.addTrack = function (t) { this._tracks.push(t); };

function FakeSessionDescription(d) { this.type = d.type; this.sdp = d.sdp; }
function FakeIceCandidate(c) {
  var self = this;
  Object.keys(c || {}).forEach(function (k) { self[k] = c[k]; });
}

function FakeRTCPeerConnection(config) {
  this._config = config;
  this._senders = [];
  this.localDescription = null;
  this.remoteDescription = null;
  this.signalingState = 'stable';
  this.connectionState = 'new';
  this.onicecandidate = null;
  this.ontrack = null;
  this.onconnectionstatechange = null;
  this._closed = false;
  this._candsAdded = [];
  this._offerCount = 0;
}
FakeRTCPeerConnection.prototype.addTrack = function (track) {
  var sender = {
    track: track,
    replaceTrack: function (t) { this.track = t; return Promise.resolve(); }
  };
  this._senders.push(sender);
  return sender;
};
FakeRTCPeerConnection.prototype.getSenders = function () { return this._senders.slice(); };
FakeRTCPeerConnection.prototype.createOffer = function () {
  this._offerCount++;
  return Promise.resolve({ type: 'offer', sdp: 'fake-offer-sdp-' + this._offerCount });
};
FakeRTCPeerConnection.prototype.createAnswer = function () {
  return Promise.resolve({ type: 'answer', sdp: 'fake-answer-sdp' });
};
FakeRTCPeerConnection.prototype._setState = function (st) {
  this.connectionState = st;
  if (typeof this.onconnectionstatechange === 'function') {
    try { this.onconnectionstatechange(); } catch (e) {}
  }
};
FakeRTCPeerConnection.prototype.setLocalDescription = function (desc) {
  var self = this;
  this.localDescription = desc;
  this.signalingState = (desc && desc.type === 'offer') ? 'have-local-offer' : 'stable';
  return new Promise(function (res) {
    setTimeout(function () {
      if (self._closed) { res(); return; }
      // gathering simulado: un candidato
      if (typeof self.onicecandidate === 'function') {
        try {
          self.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 9 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
        } catch (e) {}
      }
      // handshake completo del lado answerer: llega el stream remoto
      if (desc && desc.type === 'answer' && typeof self.ontrack === 'function') {
        var stream = new FakeMediaStream([fakeTrack('video', 'remote-v'), fakeTrack('audio', 'remote-a')]);
        try { self.ontrack({ streams: [stream], track: stream.getTracks()[0] }); } catch (e) {}
        self._setState('connected');
      }
      res();
    }, 0);
  });
};
FakeRTCPeerConnection.prototype.setRemoteDescription = function (desc) {
  var self = this;
  this.remoteDescription = desc;
  this.signalingState = (desc && desc.type === 'offer') ? 'have-remote-offer' : 'stable';
  return new Promise(function (res) {
    setTimeout(function () {
      if (!self._closed && desc && desc.type === 'answer') self._setState('connected');
      res();
    }, 0);
  });
};
FakeRTCPeerConnection.prototype.addIceCandidate = function (cand) {
  this._candsAdded.push(cand);
  return Promise.resolve();
};
FakeRTCPeerConnection.prototype.close = function () {
  if (this._closed) return;
  this._closed = true;
  this._setState('closed');
};

var FakeRTC = {
  PeerConnection: FakeRTCPeerConnection,
  SessionDescription: FakeSessionDescription,
  IceCandidate: FakeIceCandidate,
  MediaStream: FakeMediaStream
};

/* ================= helpers de test ================= */

var failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error('  ✗ FAIL: ' + msg);
  } else {
    console.log('  ✓ ' + msg);
  }
}
function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 20); }); }
function waitFor(cond, timeoutMs, label) {
  var t0 = Date.now();
  return new Promise(function (resolve, reject) {
    (function poll() {
      var ok = false;
      try { ok = !!cond(); } catch (e) { ok = false; }
      if (ok) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout esperando: ' + label));
      setTimeout(poll, 15);
    })();
  });
}
function capture(core) {
  var evts = [];
  ['chat', 'viewers', 'likes', 'gifts', 'ended', 'remotetrack', 'pcstate', 'error'].forEach(function (e) {
    core.on(e, function (d) { evts.push({ e: e, d: d }); });
  });
  return evts;
}
function has(evts, e, pred) {
  return evts.some(function (x) { return x.e === e && (!pred || pred(x.d)); });
}
function expectReject(promise) {
  return promise.then(function () { return null; }, function (e) { return e || new Error('rechazo sin error'); });
}

/* ================= suite ================= */

async function main() {
  var nowMs = 1750000000000;
  var nowFn = function () { return nowMs; };
  var db = new FakeDB();
  var opts = { db: db, RTC: FakeRTC, now: nowFn };

  var host = new DrexLiveCore(opts);
  var viewer = new DrexLiveCore(opts);
  host.setUser({ uid: 'host1', name: 'Anfitrión', avatar: 'a.png' });
  viewer.setUser({ uid: 'viewer1', name: 'Espectador' });
  var hostEvts = capture(host);
  var viewerEvts = capture(viewer);

  console.log('\n[1] createLive');
  var cr = await host.createLive({ title: 'Mi live', effectId: 'fx1' });
  assert(cr && typeof cr.liveId === 'string' && cr.liveId.length > 0, 'createLive resuelve {liveId}');
  var liveId = cr.liveId;
  assert(liveId !== 'host1', 'liveId NO es el uid crudo (' + liveId + ')');
  var doc = (await db.ref('lives/' + liveId).once('value')).val();
  assert(doc && doc.id === liveId, 'doc incluye id');
  assert(doc.hostUid === 'host1' && doc.hostName === 'Anfitrión', 'doc hostUid/hostName');
  assert(doc.title === 'Mi live' && doc.effectId === 'fx1', 'doc title/effectId');
  assert(doc.status === 'live', "status 'live'");
  assert(doc.viewers === 0 && doc.likes === 0, 'viewers=0 likes=0');
  assert(doc.transport === 'mesh', "transport 'mesh'");
  assert(typeof doc.startedAt === 'number' && doc.endedAt === null, 'startedAt numérico, endedAt null');

  console.log('\n[2] listLives + onLiveList');
  var list = await host.listLives();
  assert(Array.isArray(list) && list.length === 1 && list[0].id === liveId, 'listLives muestra el live activo');
  var liveListCalls = [];
  var offLiveList = host.onLiveList(function (arr) { liveListCalls.push(arr); });
  await tick();
  assert(liveListCalls.length >= 1, 'onLiveList dispara al suscribirse (estado actual)');
  assert(liveListCalls[0].length === 1 && liveListCalls[0][0].status === 'live', 'onLiveList entrega objetos live completos con status live');

  console.log('\n[3] startHost + joinLive → offer/answer/ICE → remotetrack');
  var hostStream = new FakeMediaStream([fakeTrack('video', 'hv1'), fakeTrack('audio', 'ha1')]);
  await host.startHost({ liveId: liveId, stream: hostStream });
  await viewer.joinLive(liveId);
  assert((await db.ref('liveViewers/' + liveId + '/viewer1').once('value')).exists(), 'viewer registrado en liveViewers/<id>/<uid>');
  assert(viewer._odisc !== null, 'viewer armó onDisconnect().remove() para su presencia');
  var vw = (await db.ref('lives/' + liveId + '/viewers').once('value')).val();
  assert(vw === 1, 'contador viewers del doc = 1');

  await waitFor(function () { return has(viewerEvts, 'remotetrack'); }, 4000, 'remotetrack en viewer');
  var rt = viewerEvts.filter(function (x) { return x.e === 'remotetrack'; })[0].d;
  assert(rt && rt.stream && typeof rt.stream.getTracks === 'function', "evento 'remotetrack' → {stream}");
  assert(rt.stream.getTracks().length >= 1, 'stream remoto trae tracks');

  await waitFor(function () { return has(viewerEvts, 'pcstate', function (d) { return d.state === 'connected'; }); }, 4000, 'pcstate connected (viewer)');
  // El lado host procesa el answer DESPUÉS: esperar su estado antes de afirmar.
  await waitFor(function () {
    return host._pcs['viewer1'] && host._pcs['viewer1']._candsAdded.length >= 1;
  }, 4000, 'ICE del viewer drenado en el host');
  await waitFor(function () {
    return has(hostEvts, 'pcstate', function (d) { return d.peer === 'viewer1' && d.state === 'connected'; });
  }, 4000, 'pcstate connected (host)');
  var vpc = viewer._pc;
  assert(vpc && vpc.remoteDescription && vpc.remoteDescription.type === 'offer', 'viewer aplicó remoteDescription (offer)');
  assert(vpc._candsAdded.length >= 1, 'viewer recibió candidato(s) ICE del host');
  var hpc = host._pcs['viewer1'];
  assert(hpc && !hpc._closed, 'host creó PC para viewer1');
  assert(hpc.remoteDescription && hpc.remoteDescription.type === 'answer', 'host aplicó remoteDescription (answer)');
  assert(hpc._candsAdded.length >= 1, 'host recibió candidato(s) ICE del viewer (cola early drenada)');
  assert(hpc.getSenders().length === 2, 'PC del host tiene 2 senders (tracks del stream local)');
  assert(has(hostEvts, 'viewers', function (d) { return d.count === 1; }), "host emitió 'viewers' → {count:1}");
  assert(has(viewerEvts, 'viewers', function (d) { return d.count === 1; }), "viewer emitió 'viewers' → {count:1}");
  assert(has(hostEvts, 'pcstate', function (d) { return d.peer === 'viewer1' && d.state === 'connected'; }), "host emitió 'pcstate' → {peer, state}");

  console.log('\n[4] chat viewer → host');
  await viewer.sendChat('  hola host  ');
  await waitFor(function () { return has(hostEvts, 'chat', function (d) { return d.text === 'hola host'; }); }, 3000, 'chat en host');
  var chatEvt = hostEvts.filter(function (x) { return x.e === 'chat' && x.d.text === 'hola host'; })[0].d;
  assert(chatEvt.uid === 'viewer1' && chatEvt.name === 'Espectador', "chat → {uid, name} correctos");
  assert(typeof chatEvt.ts === 'number', "chat → {ts} numérico");
  await viewer.sendChat(new Array(302).join('x')); // 301 chars
  await waitFor(function () { return has(hostEvts, 'chat', function (d) { return d.text.length === 200; }); }, 3000, 'chat truncado a 200');
  assert(true, 'chat largo saneado a máx 200 caracteres');

  console.log('\n[5] gift');
  await viewer.sendGift('rosa');
  await waitFor(function () { return has(hostEvts, 'gifts', function (d) { return d.giftId === 'rosa'; }); }, 3000, 'gift en host');
  var giftEvt = hostEvts.filter(function (x) { return x.e === 'gifts' && x.d.giftId === 'rosa'; })[0].d;
  assert(giftEvt.uid === 'viewer1' && giftEvt.name === 'Espectador' && typeof giftEvt.ts === 'number', "gifts → {uid, name, giftId, ts}");

  console.log('\n[6] likes (transaction)');
  await viewer.bumpLike();
  await waitFor(function () {
    return has(hostEvts, 'likes', function (d) { return d.count === 1; }) &&
           has(viewerEvts, 'likes', function (d) { return d.count === 1; });
  }, 3000, 'likes=1 en ambos');
  await host.bumpLike();
  await waitFor(function () { return has(hostEvts, 'likes', function (d) { return d.count === 2; }); }, 3000, 'likes=2');
  assert((await db.ref('lives/' + liveId + '/likes').once('value')).val() === 2, 'likes=2 en BD (sin doble conteo)');

  console.log('\n[7] replaceLocalStream (host, sin renegociar)');
  var offersBefore = hpc._offerCount;
  var newStream = new FakeMediaStream([fakeTrack('video', 'hv2'), fakeTrack('audio', 'ha2')]);
  var rr = await host.replaceLocalStream(newStream);
  assert(rr && rr.replaced === 2, 'replaceLocalStream resuelve {replaced:2}');
  var senders = hpc.getSenders();
  var nv = newStream.getVideoTracks()[0], na = newStream.getAudioTracks()[0];
  senders.forEach(function (s) {
    if (s.track.kind === 'video') assert(s.track === nv, 'sender de video apunta al track NUEVO');
    if (s.track.kind === 'audio') assert(s.track === na, 'sender de audio apunta al track NUEVO');
  });
  assert(hpc._offerCount === offersBefore, 'sin renegociación (createOffer no se llamó de nuevo)');
  var errNoHost = await expectReject(viewer.replaceLocalStream(newStream));
  assert(errNoHost && errNoHost.code === 'not-host', 'replaceLocalStream en viewer rechaza not-host');

  console.log('\n[8] leaveLive del viewer');
  await viewer.leaveLive();
  await tick(60);
  assert(!(await db.ref('liveViewers/' + liveId + '/viewer1').once('value')).exists(), 'viewer borrado de liveViewers');
  assert(viewer._odisc === null, 'leaveLive canceló el handle onDisconnect');
  assert(vpc._closed === true, 'PC del viewer cerrada');
  assert(!host._pcs['viewer1'] || host._pcs['viewer1']._closed === true, 'PC del host para viewer1 cerrada/limpia');
  assert((await db.ref('lives/' + liveId + '/viewers').once('value')).val() === 0, 'contador viewers del doc = 0');
  await waitFor(function () { return has(hostEvts, 'viewers', function (d) { return d.count === 0; }); }, 3000, "viewers {count:0} tras leave");

  console.log('\n[9] segundo viewer se queda → endLive del host');
  var viewer2 = new DrexLiveCore(opts);
  viewer2.setUser({ uid: 'viewer2', name: 'Lurker' });
  var viewer2Evts = capture(viewer2);
  await viewer2.joinLive(liveId);
  await waitFor(function () { return has(viewer2Evts, 'remotetrack'); }, 4000, 'remotetrack en viewer2');
  assert(host._pcs['viewer2'] && !host._pcs['viewer2']._closed, 'host tiene PC para viewer2');
  await host.endLive();
  var edoc = (await db.ref('lives/' + liveId).once('value')).val();
  assert(edoc.status === 'ended', "status 'ended'");
  assert(typeof edoc.endedAt === 'number', 'endedAt numérico');
  assert(!(await db.ref('liveViewers/' + liveId).once('value')).exists(), 'liveViewers del live borrado');
  assert(!(await db.ref('liveSignals/' + liveId).once('value')).exists(), 'liveSignals del live borrado');
  await waitFor(function () { return has(viewer2Evts, 'ended', function (d) { return d.liveId === liveId; }); }, 3000, "viewer2 recibió 'ended' → {liveId}");
  assert(has(hostEvts, 'ended', function (d) { return d.liveId === liveId; }), "host recibió 'ended' → {liveId}");
  var list2 = await host.listLives();
  assert(list2.length === 0, 'listLives vacío tras endLive');
  await waitFor(function () { return liveListCalls.length > 1 && liveListCalls[liveListCalls.length - 1].length === 0; }, 3000, 'onLiveList se actualizó a vacío');
  assert(host._pcs['viewer2'] === undefined || host._pcs['viewer2']._closed, 'PCs del host cerradas tras endLive');
  offLiveList();

  console.log('\n[10] casos negativos');
  var e1 = await expectReject(viewer.joinLive('no-existe'));
  assert(e1 && e1.code === 'live-not-found', "join a live inexistente → 'live-not-found'");
  var e2 = await expectReject(viewer.joinLive(liveId));
  assert(e2 && e2.code === 'live-ended', "join a live terminado → 'live-ended'");
  var e2b = await expectReject(viewer.joinLive('a/b'));
  assert(e2b && e2b.code === 'live-not-found', 'join con id malformado → live-not-found');

  // señal con from malformado debe ignorarse (sin PC, sin crash)
  var cr2 = await host.createLive({ title: 'live2' });
  var liveId2 = cr2.liveId;
  await host.startHost({ liveId: liveId2, stream: hostStream });
  var pcsBefore = Object.keys(host._pcs).length;
  db.ref('liveSignals/' + liveId2).push({ type: 'viewer-join', from: 'a/b\\evil', to: 'host1', payload: {}, ts: nowMs });
  db.ref('liveSignals/' + liveId2).push({ type: 'viewer-join', from: 'host1', to: 'host1', payload: {}, ts: nowMs }); // from===me
  db.ref('liveSignals/' + liveId2).push({ type: 'viewer-join', from: 'otro', to: 'nadie', payload: {}, ts: nowMs }); // to!==me
  db.ref('liveSignals/' + liveId2).push({ type: 'offer', from: 'x'.repeat(65), to: 'host1', payload: { sdp: { type: 'offer', sdp: 'z' } }, ts: nowMs }); // from >64
  await tick(120);
  assert(Object.keys(host._pcs).length === pcsBefore, 'señales malformadas ignoradas (0 PCs nuevas, sin crash)');
  assert(!has(hostEvts, 'error'), 'sin errores emitidos por señales malformadas');
  // replay de la MISMA key: no se reprocesa
  var dupKey = 'p999_dup';
  db._setNode('liveSignals/' + liveId2 + '/' + dupKey, { type: 'viewer-join', from: 'replayer', to: 'host1', payload: {}, ts: nowMs });
  db._notifySet('liveSignals/' + liveId2 + '/' + dupKey, false);
  var pcsAfterFirst = Object.keys(host._pcs).length;
  db._emit('liveSignals/' + liveId2, 'child_added', db._snap('liveSignals/' + liveId2 + '/' + dupKey));
  await tick(60);
  assert(Object.keys(host._pcs).length === pcsAfterFirst, 'señal duplicada (misma key) no crea PC extra');

  var e3 = await expectReject(viewer.endLive());
  assert(e3 && e3.code === 'not-host', "endLive por no-host → 'not-host'");
  var e4 = await expectReject(viewer.sendChat('   '));
  assert(e4 && e4.code === 'empty-chat', 'sendChat vacío → rechazado');
  var e5 = await expectReject(viewer.sendGift('nuke'));
  assert(e5 && e5.code === 'invalid-gift', 'sendGift inválido → rechazado');
  var e6 = await expectReject(host.sendGift(''));
  assert(e6 && e6.code === 'invalid-gift', 'sendGift vacío → rechazado');
  var e7 = await expectReject(new DrexLiveCore(opts).sendChat('hola'));
  assert(e7 && e7.code === 'no-live', 'sendChat sin live → no-live');

  // gift válido de la lista cerrada pasa
  await host.sendChat('ok'); // host también puede chatear en su live
  await tick(40);

  await host.endLive(); // cierra live2
  host.dispose(); viewer.dispose(); viewer2.dispose();
  assert(true, 'dispose() sin errores');
}

main().then(function () {
  if (failures > 0) {
    console.error('\nROJO: ' + failures + ' check(s) fallaron.');
    process.exit(1);
  }
  console.log('\nVERDE: todos los checks pasaron.');
  process.exit(0);
}).catch(function (e) {
  console.error('\nROJO: excepción no controlada: ' + (e && e.stack || e));
  process.exit(1);
});
