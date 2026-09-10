/* DrexCloud — adaptador de backend AWS para Drex.
 *
 * Expone la misma API que usaba el proveedor anterior, para no reescribir la app:
 *   DrexCloud.database()  -> base de datos sobre DynamoDB (tabla drex-kv)
 *   DrexCloud.auth()      -> autenticación con Amazon Cognito
 *
 * Motor de datos: la tabla drex-kv emula un árbol de documentos.
 *   pk = primer segmento de la ruta, sk = resto unido con "/",
 *   atributo "v" = valor de la hoja serializado en JSON.
 *   Ej: ref('users/abc/name').set('Zed') -> pk='users', sk='abc/name', v='"Zed"'
 *
 * NOTA: la verificación de email por código la resuelve el backend, no este
 * archivo: el User Pool debe exigir verificación (sin lambda PreSignUp de
 * autoconfirmación) y usar la plantilla de correo de Drex
 * (ver ~/workspace/beabo-aws/verify-email-template.md).
 * Flujo en app: createUser -> { needsConfirmation: true } -> pantalla de
 * código -> confirmRegistration -> signIn. Login sin confirmar ->
 * error auth/needs-confirmation -> pantalla de código.
 */
(function (global) {
  'use strict';

  var AWS_CONFIG = {
    region: 'us-east-1',
    userPoolId: 'us-east-1_kDSYEBsnY',
    userPoolClientId: '7cm12q14tm12u8b3bnn6ksjqni',
    identityPoolId: 'us-east-1:92871635-d775-42e5-b161-8de1171d271a',
    tableName: 'drex-kv',
    // Login social via Cognito OAuth (se activa al desplegar el dominio + IdPs)
    oauthDomain: 'drex-voz-auth.auth.us-east-1.amazoncognito.com',
    oauthRedirectUri: 'https://drex.glamworksapps.workers.dev/',
    oauthScope: 'email openid profile'
  };
  var IDP_ISSUER = 'cognito-idp.us-east-1.amazonaws.com/us-east-1_kDSYEBsnY';

  // utilidades

  function normalizePath(path) {
    path = String(path == null ? '' : path).trim();
    path = path.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    return path;
  }
  function splitPath(path) {
    var p = normalizePath(path);
    return p === '' ? [] : p.split('/');
  }
  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) &&
      Object.prototype.toString.call(v) === '[object Object]';
  }

  // Generador de ids estilo push (20 caracteres, ordenados por tiempo)
  var PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  var lastPushTime = 0;
  var lastRandChars = [];
  function newPushId() {
    var now = Date.now();
    var duplicateTime = (now === lastPushTime);
    lastPushTime = now;
    var timeStampChars = new Array(8);
    var i;
    for (i = 7; i >= 0; i--) {
      timeStampChars[i] = PUSH_CHARS.charAt(now % 64);
      now = Math.floor(now / 64);
    }
    var id = timeStampChars.join('');
    if (!duplicateTime) {
      for (i = 0; i < 12; i++) lastRandChars[i] = Math.floor(Math.random() * 64);
    } else {
      for (i = 11; i >= 0 && lastRandChars[i] === 63; i--) lastRandChars[i] = 0;
      lastRandChars[i]++;
    }
    for (i = 0; i < 12; i++) id += PUSH_CHARS.charAt(lastRandChars[i]);
    return id;
  }

  // aplanado / reconstrucción

  // Marcador de "ahora mismo" (equivale al TIMESTAMP del proveedor anterior)
  var TIMESTAMP_SENTINEL = { '.sv': 'timestamp' };

  function resolveValue(v) {
    if (v === TIMESTAMP_SENTINEL) return Date.now();
    if (isPlainObject(v) && v['.sv'] === 'timestamp' && Object.keys(v).length === 1) return Date.now();
    return v;
  }

  // Aplana un valor a hojas: [{ segs: [...], value }]
  function flatten(value, baseSegs, out) {
    out = out || [];
    value = resolveValue(value);
    if (value === undefined) return out;
    if (Array.isArray(value)) {
      if (value.length === 0) return out; // [] equivale a subárbol vacío
      for (var i = 0; i < value.length; i++) flatten(value[i], baseSegs.concat([String(i)]), out);
      return out;
    }
    if (isPlainObject(value)) {
      var keys = Object.keys(value);
      if (keys.length === 0) return out; // {} equivale a borrar el subárbol
      for (var k = 0; k < keys.length; k++) {
        flatten(value[keys[k]], baseSegs.concat([keys[k]]), out);
      }
      return out;
    }
    out.push({ segs: baseSegs.slice(), value: value });
    return out;
  }

  // Reconstruye el subárbol a partir de hojas [{ segs, value }]
  function unflatten(items, baseSegs) {
    var result;
    var hasChildren = false;
    for (var i = 0; i < items.length; i++) {
      var rel = items[i].segs.slice(baseSegs.length);
      if (rel.length === 0) {
        result = items[i].value; // hoja exacta en la ruta base
      } else {
        hasChildren = true;
        if (result === undefined || result === null || typeof result !== 'object') result = {};
        var node = result;
        for (var d = 0; d < rel.length - 1; d++) {
          if (node[rel[d]] === undefined || node[rel[d]] === null || typeof node[rel[d]] !== 'object') {
            node[rel[d]] = {};
          }
          node = node[rel[d]];
        }
        node[rel[rel.length - 1]] = items[i].value;
      }
    }
    if (result === undefined) return hasChildren ? {} : null;
    return result;
  }

  // cliente DynamoDB (perezoso)

  var _docClient = null; // inyectable en pruebas
  var _awsCredentials = null;

  function awsLib() {
    return (typeof global.AWS !== 'undefined') ? global.AWS : null;
  }

  function ensureAwsConfigured() {
    var AWS = awsLib();
    if (!AWS) throw new Error('AWS SDK no cargado');
    if (!AWS.config.region) AWS.config.update({ region: AWS_CONFIG.region });
    return AWS;
  }

  function currentCredentials() {
    var AWS = ensureAwsConfigured();
    if (_awsCredentials) return _awsCredentials;
    _awsCredentials = new AWS.CognitoIdentityCredentials({ IdentityPoolId: AWS_CONFIG.identityPoolId });
    return _awsCredentials;
  }

  function getDocClient() {
    if (_docClient) return _docClient;
    var AWS = ensureAwsConfigured();
    var creds = currentCredentials();
    _docClient = new AWS.DynamoDB.DocumentClient({ region: AWS_CONFIG.region, credentials: creds });
    return _docClient;
  }

  function queryAll(params) {
    var dc = getDocClient();
    var items = [];
    function loop(lastKey) {
      var p = Object.assign({}, params, { ConsistentRead: true });
      if (lastKey) p.ExclusiveStartKey = lastKey;
      return dc.query(p).promise().then(function (res) {
        items = items.concat(res.Items || []);
        if (res.LastEvaluatedKey) return loop(res.LastEvaluatedKey);
        return items;
      });
    }
    return loop(null);
  }

  function batchWriteAll(requests) {
    if (!requests.length) return Promise.resolve();
    var dc = getDocClient();
    var TABLE = AWS_CONFIG.tableName;
    var attempt = 0;
    function sendBatch(batch) {
      var params = { RequestItems: {} };
      params.RequestItems[TABLE] = batch;
      return dc.batchWrite(params).promise().then(function (res) {
        var unp = (res.UnprocessedItems && res.UnprocessedItems[TABLE]) || [];
        if (unp.length && attempt < 3) { attempt++; return sendBatch(unp); }
        if (unp.length) throw new Error('DynamoDB: quedaron escrituras sin procesar');
      });
    }
    var chain = Promise.resolve();
    for (var i = 0; i < requests.length; i += 25) {
      (function (batch) { chain = chain.then(function () { return sendBatch(batch); }); })(requests.slice(i, i + 25));
    }
    return chain;
  }

  // DynamoDB no permite cadenas vacías en las claves: las rutas de un solo
  // segmento (p. ej. 'userCount') se guardan con este centinela como sort key,
  // y se traduce de vuelta al leer. Ningún segmento real usa '#'.
  var EMPTY_SK = '#';
  function normSk(sk) { return (sk === '' || sk === null || sk === undefined) ? EMPTY_SK : sk; }

  function putLeaf(pk, sk, value) {
    return {
      PutRequest: { Item: { pk: pk, sk: normSk(sk), v: JSON.stringify(value === undefined ? null : value) } }
    };
  }
  function deleteKey(pk, sk) {
    return { DeleteRequest: { Key: { pk: pk, sk: normSk(sk) } } };
  }

  // Lee todas las hojas bajo una ruta (hoja exacta + descendientes).
  // Usa begins_with(sk, 'ruta/') para no confundir 'abc' con 'abc2'.
  function readLeaves(segs) {
    if (!segs.length) return Promise.reject(new Error('Ruta vacía no soportada'));
    var pk = segs[0];
    var skExact = segs.slice(1).join('/');
    var jobs;
    if (skExact === '') {
      jobs = [queryAll({
        TableName: AWS_CONFIG.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk }
      })];
    } else {
      var dc = getDocClient();
      jobs = [
        queryAll({
          TableName: AWS_CONFIG.tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :pfx)',
          ExpressionAttributeValues: { ':pk': pk, ':pfx': skExact + '/' }
        }),
        dc.get({
          TableName: AWS_CONFIG.tableName,
          Key: { pk: pk, sk: skExact },
          ConsistentRead: true
        }).promise().then(function (res) { return res.Item ? [res.Item] : []; })
      ];
    }
    return Promise.all(jobs).then(function (parts) {
      var items = parts[0].concat(parts[1] || []);
      return items.map(function (it) {
        var rawSk = (it.sk === undefined || it.sk === null) ? '' : String(it.sk);
        if (rawSk === EMPTY_SK) rawSk = ''; // centinela de ruta de un segmento
        var skSegs = rawSk.split('/').filter(function (s) { return s !== ''; });
        var v;
        try { v = JSON.parse(it.v); } catch (e) { v = null; }
        return { segs: [pk].concat(skSegs), value: v };
      });
    });
  }

  // Borra todo el subárbol bajo una ruta (incluida la hoja exacta)
  function deleteSubtree(segs) {
    return readLeaves(segs).then(function (leaves) {
      var reqs = leaves.map(function (l) { return deleteKey(l.segs[0], l.segs.slice(1).join('/')); });
      return batchWriteAll(reqs);
    });
  }

  // DataSnapshot

  function DataSnapshot(value, key) {
    this._value = value === undefined ? null : value;
    this.key = key == null ? null : key;
  }
  DataSnapshot.prototype.val = function () { return this._value; };
  DataSnapshot.prototype.exists = function () { return this._value !== null && this._value !== undefined; };
  DataSnapshot.prototype.child = function (path) {
    var v = this._value;
    var segs = splitPath(path);
    for (var i = 0; i < segs.length; i++) {
      if (v === null || v === undefined || typeof v !== 'object') { v = null; break; }
      v = v[segs[i]];
      if (v === undefined) { v = null; break; }
    }
    return new DataSnapshot(v, segs.length ? segs[segs.length - 1] : this.key);
  };
  DataSnapshot.prototype.forEach = function (cb) {
    if (!this.exists() || typeof this._value !== 'object') return false;
    var keys = Object.keys(this._value);
    for (var i = 0; i < keys.length; i++) {
      var r = cb(new DataSnapshot(this._value[keys[i]], keys[i]));
      if (r === true) return true;
    }
    return false;
  };
  DataSnapshot.prototype.numChildren = function () {
    if (!this.exists() || typeof this._value !== 'object') return 0;
    return Object.keys(this._value).length;
  };

  // consultas del lado cliente

  function typeRank(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'boolean') return v ? 2 : 1;
    if (typeof v === 'number') return 3;
    if (typeof v === 'string') return 4;
    return 5;
  }
  function compareVals(a, b) {
    var ra = typeRank(a), rb = typeRank(b);
    if (ra !== rb) return ra - rb;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  // Aplica orderByChild/orderByKey + equalTo/startAt/endAt + limit sobre un objeto ya leído
  function applyQuery(obj, spec) {
    if (obj === null || obj === undefined || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    spec = spec || {};
    var entries = Object.keys(obj).map(function (k) { return [k, obj[k]]; });
    function dimVal(e) {
      if (spec.orderByKey) return e[0];
      if (spec.orderBy !== undefined) {
        var c = e[1];
        return (c !== null && typeof c === 'object' && !Array.isArray(c)) ? c[spec.orderBy] : undefined;
      }
      return e[0];
    }
    if (spec.equalTo !== undefined && (spec.orderBy !== undefined || spec.orderByKey)) {
      entries = entries.filter(function (e) { return dimVal(e) === spec.equalTo; });
    }
    if (spec.startAt !== undefined) {
      entries = entries.filter(function (e) {
        var d = dimVal(e);
        return d !== undefined && compareVals(d, spec.startAt) >= 0;
      });
    }
    if (spec.endAt !== undefined) {
      entries = entries.filter(function (e) {
        var d = dimVal(e);
        return d !== undefined && compareVals(d, spec.endAt) <= 0;
      });
    }
    var ordered = (spec.orderBy !== undefined || spec.orderByKey);
    entries.sort(function (x, y) {
      if (ordered) {
        var c = compareVals(dimVal(x), dimVal(y));
        if (c !== 0) return c;
      }
      return x[0] < y[0] ? -1 : (x[0] > y[0] ? 1 : 0);
    });
    if (spec.limitFirst !== undefined) entries = entries.slice(0, spec.limitFirst);
    if (spec.limitLast !== undefined) entries = entries.slice(Math.max(0, entries.length - spec.limitLast));
    var out = {};
    entries.forEach(function (e) { out[e[0]] = e[1]; });
    return out;
  }

  // oyentes (polling + eco local)

  var listeners = [];
  var pollTimer = null;

  function pathsOverlap(a, b) {
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function readRefValue(ref) {
    return readLeaves(ref._segs).then(function (leaves) {
      var val = unflatten(leaves, ref._segs);
      if (ref._query) val = applyQuery(val, ref._query);
      var key = ref._segs.length ? ref._segs[ref._segs.length - 1] : null;
      return new DataSnapshot(val, key);
    });
  }

  function safeJson(v) {
    try { return JSON.stringify(v); } catch (e) { return null; }
  }
  function callCb(cb, arg) {
    try { cb(arg); } catch (e) { setTimeout(function () { throw e; }, 0); }
  }

  function childEntriesOf(snap) {
    var v = snap.val();
    if (!v || typeof v !== 'object') return [];
    return Object.keys(v).map(function (k) { return [k, v[k]]; });
  }

  // Dispara un oyente según su tipo de evento ('value' | 'child_added' | 'child_changed')
  function fireListener(l) {
    return readRefValue(l.ref).then(function (snap) {
      if (l.eventType === 'value') {
        var j = safeJson(snap.val());
        if (j !== l.lastJson) { l.lastJson = j; callCb(l.cb, snap); }
        return;
      }
      var entries = childEntriesOf(snap);
      if (l.eventType === 'child_added') {
        if (!l.kids) {
          l.kids = {};
          entries.forEach(function (e) { l.kids[e[0]] = safeJson(e[1]); callCb(l.cb, snap.child(e[0])); });
        } else {
          var seen = {};
          entries.forEach(function (e) {
            seen[e[0]] = 1;
            var ej = safeJson(e[1]);
            if (!(e[0] in l.kids)) { l.kids[e[0]] = ej; callCb(l.cb, snap.child(e[0])); }
            else l.kids[e[0]] = ej;
          });
          Object.keys(l.kids).forEach(function (k) { if (!seen[k]) delete l.kids[k]; });
        }
      } else if (l.eventType === 'child_changed') {
        if (!l.kids) {
          l.kids = {};
          entries.forEach(function (e) { l.kids[e[0]] = safeJson(e[1]); });
        } else {
          entries.forEach(function (e) {
            var ej = safeJson(e[1]);
            if ((e[0] in l.kids) && l.kids[e[0]] !== ej) callCb(l.cb, snap.child(e[0]));
            l.kids[e[0]] = ej;
          });
        }
      }
    }).catch(function () { /* el próximo ciclo reintenta */ });
  }

  function ensurePolling() {
    if (!pollTimer && listeners.length) {
      pollTimer = setInterval(function () {
        listeners.slice().forEach(function (l) { fireListener(l); });
      }, 3000);
    }
  }
  function maybeStopPolling() {
    if (pollTimer && !listeners.length) { clearInterval(pollTimer); pollTimer = null; }
  }

  // Avisa a los oyentes afectados por una escritura propia (eco local inmediato)
  function notifyLocal(changedSegs) {
    listeners.forEach(function (l) {
      if (pathsOverlap(l.ref._segs, changedSegs)) {
        if (l._deb) clearTimeout(l._deb);
        l._deb = setTimeout(function () { l._deb = null; fireListener(l); }, 120);
      }
    });
  }

  // Ref

  function Ref(segs, query) {
    this._segs = segs;
    this._query = query || null;
  }

  Ref.prototype.child = function (path) {
    var extra = splitPath(path);
    return new Ref(this._segs.concat(extra), this._query);
  };

  Object.defineProperty(Ref.prototype, 'key', {
    get: function () { return this._segs.length ? this._segs[this._segs.length - 1] : null; }
  });

  Ref.prototype.toString = function () { return this._segs.join('/'); };

  Ref.prototype.set = function (value) {
    var segs = this._segs;
    var leaves = flatten(value, segs);
    return deleteSubtree(segs).then(function () {
      if (!leaves.length) return null;
      var reqs = leaves.map(function (l) {
        return putLeaf(l.segs[0], l.segs.slice(1).join('/'), l.value);
      });
      return batchWriteAll(reqs);
    }).then(function () { notifyLocal(segs); return null; });
  };

  Ref.prototype.update = function (obj) {
    var base = this._segs;
    if (!isPlainObject(obj)) return Promise.reject(new Error('update() requiere un objeto'));
    var leafReqs = [];
    var exactDeletes = {};
    var prefixDeletes = {};
    Object.keys(obj).forEach(function (k) {
      var relSegs = splitPath(k);
      var fullSegs = base.concat(relSegs);
      var leaves = flatten(obj[k], fullSegs);
      leaves.forEach(function (l) {
        leafReqs.push(l);
        // Al escribir una hoja, los ancestros exactos (primitivas) y los
        // descendientes deben desaparecer: así la mezcla equivale al árbol.
        for (var i = 1; i < l.segs.length; i++) {
          var a = l.segs.slice(0, i).join('/');
          exactDeletes[a] = l.segs.slice(0, i);
        }
        prefixDeletes[l.segs.join('/')] = l.segs;
      });
      if (!leaves.length) {
        // update({ruta: {}}) borra ese subárbol, como en el proveedor anterior
        prefixDeletes[fullSegs.join('/')] = fullSegs;
      }
    });
    var delReqs = [];
    Object.keys(exactDeletes).forEach(function (k) {
      var s = exactDeletes[k];
      delReqs.push(deleteKey(s[0], s.slice(1).join('/')));
    });
    var prefixLists = Object.keys(prefixDeletes).map(function (k) { return prefixDeletes[k]; });
    var chain = Promise.resolve();
    prefixLists.forEach(function (s) {
      chain = chain.then(function () { return deleteSubtree(s); });
    });
    return chain
      .then(function () { return batchWriteAll(delReqs); })
      .then(function () {
        var reqs = leafReqs.map(function (l) {
          return putLeaf(l.segs[0], l.segs.slice(1).join('/'), l.value);
        });
        return batchWriteAll(reqs);
      })
      .then(function () {
        leafReqs.forEach(function (l) { notifyLocal(l.segs); });
        return null;
      });
  };

  Ref.prototype.push = function (value) {
    var r = this.child(newPushId());
    if (value !== undefined) {
      r._writePromise = r.set(value).catch(function (e) {
        if (typeof console !== 'undefined' && console.warn) console.warn('push(): escritura fallida', e && e.message);
      });
    }
    return r;
  };

  Ref.prototype.remove = function () {
    var segs = this._segs;
    return deleteSubtree(segs).then(function () { notifyLocal(segs); return null; });
  };

  Ref.prototype.once = function (eventType) {
    if (eventType && eventType !== 'value') return Promise.reject(new Error('Solo se soporta once("value")'));
    return readRefValue(this);
  };

  Ref.prototype.get = function () { return this.once('value'); };

  Ref.prototype.on = function (eventType, cb) {
    if (eventType !== 'value' && eventType !== 'child_added' && eventType !== 'child_changed') {
      throw new Error('Evento no soportado: ' + eventType);
    }
    var l = { ref: this, eventType: eventType, cb: cb, lastJson: undefined, kids: null, _deb: null };
    listeners.push(l);
    ensurePolling();
    // Lectura inicial: en 'value' dispara el callback; en 'child_added' dispara
    // una vez por cada hijo existente (como el proveedor anterior).
    fireListener(l).catch(function () {});
    return function () {
      var i = listeners.indexOf(l);
      if (i !== -1) listeners.splice(i, 1);
      if (l._deb) clearTimeout(l._deb);
      maybeStopPolling();
    };
  };

  Ref.prototype.off = function (eventType, cb) {
    var path = this._segs.join('/');
    for (var i = listeners.length - 1; i >= 0; i--) {
      var l = listeners[i];
      var sameRef = l.ref._segs.join('/') === path;
      var sameEvent = !eventType || l.eventType === eventType;
      if (sameRef && sameEvent && (!cb || l.cb === cb)) {
        if (l._deb) clearTimeout(l._deb);
        listeners.splice(i, 1);
      }
    }
    maybeStopPolling();
  };

  Ref.prototype.orderByChild = function (k) {
    return new Ref(this._segs, { orderBy: k });
  };
  Ref.prototype.orderByKey = function () {
    return new Ref(this._segs, { orderByKey: true });
  };
  Ref.prototype.startAt = function (v) {
    var q = Object.assign({}, this._query, { startAt: v });
    return new Ref(this._segs, q);
  };
  Ref.prototype.endAt = function (v) {
    var q = Object.assign({}, this._query, { endAt: v });
    return new Ref(this._segs, q);
  };
  Ref.prototype.equalTo = function (v) {
    var q = Object.assign({}, this._query, { equalTo: v });
    return new Ref(this._segs, q);
  };
  Ref.prototype.limitToLast = function (n) {
    var q = Object.assign({}, this._query, { limitLast: n });
    return new Ref(this._segs, q);
  };
  Ref.prototype.limitToFirst = function (n) {
    var q = Object.assign({}, this._query, { limitFirst: n });
    return new Ref(this._segs, q);
  };

  // Transacción best-effort: leer, aplicar, escribir (sin atomicidad del servidor)
  Ref.prototype.transaction = function (updateFn, onComplete) {
    var ref = this;
    var p = ref.once('value').then(function (snap) {
      var newVal = updateFn(snap.val());
      if (newVal === undefined) return { committed: false, snapshot: snap };
      return ref.set(newVal).then(function () {
        return ref.once('value').then(function (s2) { return { committed: true, snapshot: s2 }; });
      });
    });
    if (typeof onComplete === 'function') {
      p = p.then(function (res) { onComplete(null, res.committed, res.snapshot); return res; },
                 function (err) { onComplete(err, false, null); throw err; });
    }
    return p;
  };

  // onDisconnect best-effort: intenta la escritura al ocultar/cerrar la página
  Ref.prototype.onDisconnect = function () {
    var ref = this;
    function arm(fn) {
      function handler() { try { var r = fn(); if (r && r.catch) r.catch(function () {}); } catch (e) {} }
      if (typeof global.addEventListener === 'function') {
        global.addEventListener('pagehide', handler);
        if (typeof global.document !== 'undefined' && global.document.addEventListener) {
          global.document.addEventListener('visibilitychange', function () {
            if (global.document.visibilityState === 'hidden') handler();
          });
        }
      }
    }
    return {
      set: function (v) { arm(function () { return ref.set(v); }); return Promise.resolve(); },
      update: function (o) { arm(function () { return ref.update(o); }); return Promise.resolve(); },
      remove: function () { arm(function () { return ref.remove(); }); return Promise.resolve(); },
      cancel: function () { return Promise.resolve(); } // documentado: no-op
    };
  };

  function createDatabase() {
    function database() { return database; }
    database.ref = function (path) { return new Ref(splitPath(path || '')); };
    database.ServerValue = { TIMESTAMP: TIMESTAMP_SENTINEL };
    return database;
  }

  // autenticación

  function cognitoLib() {
    return (typeof global.AmazonCognitoIdentity !== 'undefined') ? global.AmazonCognitoIdentity : null;
  }

  function mapAuthError(err) {
    var code = (err && err.code) || '';
    var message = (err && err.message) || 'Error de autenticación';
    var out = new Error(message);
    switch (code) {
      case 'UserNotFoundException': out.code = 'auth/user-not-found'; break;
      case 'NotAuthorizedException': out.code = 'auth/wrong-password'; out.message = 'Correo o contraseña incorrectos.'; break;
      case 'UsernameExistsException': out.code = 'auth/email-already-in-use'; break;
      case 'InvalidPasswordException': out.code = 'auth/weak-password'; out.message = 'La contraseña no cumple los requisitos mínimos.'; break;
      case 'InvalidParameterException': out.code = 'auth/invalid-email'; break;
      case 'UserNotConfirmedException': out.code = 'auth/user-not-confirmed'; out.message = 'Debes verificar tu correo antes de iniciar sesión.'; break;
      case 'CodeMismatchException': out.code = 'auth/invalid-verification-code'; out.message = 'El código de verificación no es válido.'; break;
      case 'ExpiredCodeException': out.code = 'auth/code-expired'; out.message = 'El código venció. Solicita uno nuevo.'; break;
      case 'LimitExceededException': out.code = 'auth/too-many-requests'; break;
      case 'TooManyRequestsException': out.code = 'auth/too-many-requests'; break;
      case 'PasswordResetRequiredException': out.code = 'auth/password-reset-required'; out.message = 'Debes restablecer tu contraseña.'; break;
      default: out.code = 'auth/unknown';
    }
    return out;
  }

  var userPool = null;
  function getUserPool() {
    if (userPool) return userPool;
    var C = cognitoLib();
    if (!C) throw new Error('AmazonCognitoIdentity no cargado');
    userPool = new C.CognitoUserPool({
      UserPoolId: AWS_CONFIG.userPoolId,
      ClientId: AWS_CONFIG.userPoolClientId
    });
    return userPool;
  }

  // Usuario actual estilo compat: { uid, email, emailVerified, displayName, photoURL, ... }
  function makeCurrentUser(cognitoUser, attrs) {
    var map = {};
    (attrs || []).forEach(function (a) { map[a.getName()] = a.getValue(); });
    var user = {
      uid: map.sub || cognitoUser.getUsername(),
      email: map.email || cognitoUser.getUsername(),
      emailVerified: map.email_verified === 'true',
      displayName: map.name || null,
      photoURL: map.picture || null,
      _cognitoUser: cognitoUser,
      reload: function () {
        return refreshCurrentUserAttributes().then(function () { return undefined; });
      },
      updateProfile: function (profile) {
        return updateAuthProfile(profile || {});
      },
      updatePassword: function (newPassword) {
        return changeAuthPassword(newPassword);
      },
      sendEmailVerification: function () {
        return new Promise(function (resolve, reject) {
          try {
            cognitoUser.resendConfirmationCode(function (err) {
              if (err) reject(mapAuthError(err)); else resolve();
            });
          } catch (e) { reject(mapAuthError(e)); }
        });
      }
    };
    return user;
  }

  var authInstance = null;
  var authListeners = [];
  var currentCognitoUser = null;
  var refreshTimer = null;

  function getAuth() {
    if (authInstance) return authInstance;
    authInstance = {
      currentUser: null,
      languageCode: 'es', // no-op: se conserva la asignación del código existente
      onAuthStateChanged: function (cb) {
        authListeners.push(cb);
        // Llamada inicial asíncrona, como en el proveedor anterior
        setTimeout(function () { try { cb(authInstance.currentUser); } catch (e) { setTimeout(function () { throw e; }, 0); } }, 0);
        return function () {
          var i = authListeners.indexOf(cb);
          if (i !== -1) authListeners.splice(i, 1);
        };
      },
      signInWithEmailAndPassword: signInWithEmailAndPassword,
      createUserWithEmailAndPassword: createUserWithEmailAndPassword,
      confirmRegistration: confirmRegistration,
      resendConfirmation: resendConfirmation,
      sendPasswordResetEmail: sendPasswordResetEmail,
      confirmPasswordReset: confirmPasswordReset,
      signOut: signOutUser,
      signInWithPopup: signInWithPopup
    };
    return authInstance;
  }

  function notifyAuthListeners() {
    var u = authInstance.currentUser;
    authListeners.slice().forEach(function (cb) {
      try { cb(u); } catch (e) { setTimeout(function () { throw e; }, 0); }
    });
  }

  function refreshCurrentUserAttributes() {
    return new Promise(function (resolve) {
      if (!currentCognitoUser || !authInstance.currentUser) return resolve();
      currentCognitoUser.getUserAttributes(function (err, attrs) {
        if (!err && attrs) {
          var fresh = makeCurrentUser(currentCognitoUser, attrs);
          authInstance.currentUser.uid = fresh.uid;
          authInstance.currentUser.email = fresh.email;
          authInstance.currentUser.emailVerified = fresh.emailVerified;
          authInstance.currentUser.displayName = fresh.displayName;
          authInstance.currentUser.photoURL = fresh.photoURL;
        }
        resolve();
      });
    });
  }

  function updateAuthProfile(profile) {
    var user = authInstance.currentUser;
    if (!user) return Promise.reject(Object.assign(new Error('Sin sesión'), { code: 'auth/no-current-user' }));
    var C = cognitoLib();
    var attrs = [];
    if (profile.displayName !== undefined) attrs.push(new C.CognitoUserAttribute({ Name: 'name', Value: String(profile.displayName || '') }));
    if (profile.photoURL !== undefined) attrs.push(new C.CognitoUserAttribute({ Name: 'picture', Value: String(profile.photoURL || '') }));
    if (profile.displayName !== undefined) user.displayName = profile.displayName || null;
    if (profile.photoURL !== undefined) user.photoURL = profile.photoURL || null;
    if (!attrs.length || !currentCognitoUser) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      currentCognitoUser.updateAttributes(attrs, function (err) {
        if (err) reject(mapAuthError(err)); else resolve();
      });
    });
  }

  // Puente temporal: Cognito exige la contraseña actual para cambiarla.
  function changeAuthPassword(newPassword) {
    var cognitoUser = currentCognitoUser;
    if (!cognitoUser) return Promise.reject(Object.assign(new Error('Sin sesión'), { code: 'auth/no-current-user' }));
    var oldPassword = (typeof global.prompt === 'function')
      ? global.prompt('Por seguridad, escribe tu contraseña actual para cambiarla:')
      : null;
    if (oldPassword === null || oldPassword === undefined) {
      return Promise.reject(Object.assign(new Error('Cancelado'), { code: 'auth/cancelled' }));
    }
    return new Promise(function (resolve, reject) {
      cognitoUser.changePassword(String(oldPassword), String(newPassword), function (err) {
        if (err) {
          var mapped = mapAuthError(err);
          if (err.code === 'NotAuthorizedException') mapped.code = 'auth/requires-recent-login';
          reject(mapped);
        } else resolve();
      });
    });
  }

  function configureAwsCredentials(idToken) {
    var AWS = ensureAwsConfigured();
    var logins = {};
    logins[IDP_ISSUER] = idToken.getJwtToken();
    _awsCredentials = new AWS.CognitoIdentityCredentials({
      IdentityPoolId: AWS_CONFIG.identityPoolId,
      Logins: logins
    });
    _docClient = null; // el próximo getDocClient usará las credenciales nuevas
    return new Promise(function (resolve, reject) {
      _awsCredentials.get(function (err) {
        if (err) reject(err); else resolve();
      });
    });
  }

  // C12: si el refresh del token falla, la sesión murió. Se limpia el
  // estado de auth, se avisa a los listeners (la app vuelve al login) y se
  // deja una marca para mostrar "sesión expirada" en el idioma de la app.
  function handleExpiredSession() {
    try { if (currentCognitoUser) currentCognitoUser.signOut(); } catch (e) {}
    currentCognitoUser = null;
    if (authInstance) authInstance.currentUser = null;
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    _awsCredentials = null;
    _docClient = null;
    try {
      var lang = 'es';
      try {
        var stored = (typeof localStorage !== 'undefined') && localStorage.getItem('drex_app_language_v1');
        if (stored === 'en') lang = 'en';
      } catch (e2) {}
      sessionStorage.setItem('drex_session_expired', lang);
    } catch (e3) {}
    notifyAuthListeners();
  }

  function scheduleTokenRefresh(cognitoUser, session) {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    try {
      var expMs = session.getIdToken().getExpiration() * 1000;
      var delay = expMs - Date.now() - 5 * 60 * 1000;
      if (delay < 60000) delay = 60000;
      refreshTimer = setTimeout(function () {
        cognitoUser.refreshSession(session.getRefreshToken(), function (err, newSession) {
          if (!err && newSession) {
            configureAwsCredentials(newSession.getIdToken()).catch(function () {});
            scheduleTokenRefresh(cognitoUser, newSession);
          } else {
            handleExpiredSession();
          }
        });
      }, delay);
    } catch (e) { /* best-effort */ }
  }

  function establishSession(cognitoUser, session) {
    currentCognitoUser = cognitoUser;
    return new Promise(function (resolve, reject) {
      cognitoUser.getUserAttributes(function (err, attrs) {
        if (err) { reject(mapAuthError(err)); return; }
        authInstance.currentUser = makeCurrentUser(cognitoUser, attrs);
        configureAwsCredentials(session.getIdToken()).then(function () {
          scheduleTokenRefresh(cognitoUser, session);
          notifyAuthListeners();
          resolve(authInstance.currentUser);
        }, function (credErr) {
          // Sesión válida aunque las credenciales AWS fallen: se reintentan al usar la BD
          _awsCredentials = null;
          scheduleTokenRefresh(cognitoUser, session);
          notifyAuthListeners();
          resolve(authInstance.currentUser);
        });
      });
    });
  }

  function signInWithEmailAndPassword(email, password) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var cognitoUser = new C.CognitoUser({ Username: String(email).trim(), Pool: getUserPool() });
    var authDetails = new C.AuthenticationDetails({ Username: String(email).trim(), Password: String(password) });
    return new Promise(function (resolve, reject) {
      cognitoUser.authenticateUser(authDetails, {
        onSuccess: function (session) {
          establishSession(cognitoUser, session).then(function (user) {
            resolve({ user: user });
          }, reject);
        },
        onFailure: function (err) {
          if (err && err.code === 'UserNotConfirmedException') {
            // La cuenta existe pero el email no está verificado: la app debe
            // llevar al usuario a la pantalla de código de verificación.
            var need = new Error('Tu correo aún no está verificado. Escribe el código que te enviamos.');
            need.code = 'auth/needs-confirmation';
            need.email = String(email).trim();
            reject(need);
            return;
          }
          reject(mapAuthError(err));
        },
        newPasswordRequired: function () {
          reject(Object.assign(new Error('Debes restablecer tu contraseña.'), { code: 'auth/password-reset-required' }));
        }
      });
    });
  }

  function createUserWithEmailAndPassword(email, password) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var cleanEmail = String(email).trim();
    var attrs = [new C.CognitoUserAttribute({ Name: 'email', Value: cleanEmail })];
    return new Promise(function (resolve, reject) {
      getUserPool().signUp(cleanEmail, String(password), attrs, null, function (err, result) {
        if (err) { reject(mapAuthError(err)); return; }
        if (result && result.userConfirmed) {
          // Autoconfirmado: entrar de inmediato
          signInWithEmailAndPassword(cleanEmail, String(password)).then(resolve, reject);
        } else {
          // Cognito envió el código de verificación al correo automáticamente.
          // La app muestra la pantalla de código y luego llama a confirmRegistration.
          resolve({ user: null, needsConfirmation: true, email: cleanEmail });
        }
      });
    });
  }

  // Confirma la cuenta con el código de 6 dígitos enviado al correo.
  // Resuelve con 'CONFIRMED' (o 'ALREADY_CONFIRMED' si ya estaba verificada).
  function confirmRegistration(email, code) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var cleanEmail = String(email).trim();
    var cleanCode = String(code).trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      var bad = new Error('Escribe el código de 6 dígitos que recibiste por correo.');
      bad.code = 'auth/invalid-verification-code';
      return Promise.reject(bad);
    }
    var cognitoUser = new C.CognitoUser({ Username: cleanEmail, Pool: getUserPool() });
    return new Promise(function (resolve, reject) {
      cognitoUser.confirmRegistration(cleanCode, true, function (err, result) {
        if (err) {
          // Si ya estaba confirmada (p. ej. doble envío), no es un error real.
          var msg = String((err && err.message) || '');
          if (err.code === 'NotAuthorizedException' && /confirm/i.test(msg)) {
            resolve('ALREADY_CONFIRMED');
            return;
          }
          reject(mapAuthError(err));
          return;
        }
        resolve(result || 'CONFIRMED');
      });
    });
  }

  function resendConfirmation(email) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var cleanEmail = String(email).trim();
    var cognitoUser = new C.CognitoUser({ Username: cleanEmail, Pool: getUserPool() });
    return new Promise(function (resolve, reject) {
      cognitoUser.resendConfirmationCode(function (err, result) {
        if (err) reject(mapAuthError(err)); else resolve(result);
      });
    });
  }

  // Cognito envía un CÓDIGO de 6 dígitos por correo (no un enlace).
  // Esta función solo envía el código; la app pide el PIN y la nueva
  // contraseña en su propia sección (login y Ajustes).
  function sendPasswordResetEmail(email) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var cleanEmail = String(email).trim();
    var cognitoUser = new C.CognitoUser({ Username: cleanEmail, Pool: getUserPool() });
    return new Promise(function (resolve, reject) {
      cognitoUser.forgotPassword({
        onSuccess: function () { resolve(); },
        onFailure: function (err) { reject(mapAuthError(err)); }
      });
    });
  }

  function confirmPasswordReset(email, code, newPassword) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var cognitoUser = new C.CognitoUser({ Username: String(email).trim(), Pool: getUserPool() });
    return new Promise(function (resolve, reject) {
      cognitoUser.confirmPassword(String(code).trim(), String(newPassword), {
        onSuccess: function () { resolve(); },
        onFailure: function (err) { reject(mapAuthError(err)); }
      });
    });
  }

  function signOutUser() {
    getAuth();
    return new Promise(function (resolve) {
      try { if (currentCognitoUser) currentCognitoUser.signOut(); } catch (e) {}
      currentCognitoUser = null;
      if (authInstance) authInstance.currentUser = null;
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      _awsCredentials = null;
      _docClient = null;
      notifyAuthListeners();
      resolve();
    });
  }

  // Login social real via Cognito OAuth (Google / Facebook)
  // Redirige a Cognito, que hace el baile OAuth con el proveedor y regresa
  // con ?code= ; aquí se canjea por tokens y se abre la sesión.
  var SOCIAL_IDP = { Google: 'Google', Facebook: 'Facebook' };

  function oauthAvailable() {
    return !!(AWS_CONFIG.oauthDomain && AWS_CONFIG.oauthRedirectUri && AWS_CONFIG.userPoolClientId);
  }

  function federatedSignIn(providerName) {
    getAuth();
    if (!oauthAvailable()) {
      var err = new Error('El login social aún no está activado en el servidor.');
      err.code = 'auth/operation-not-allowed';
      return Promise.reject(err);
    }
    var url = 'https://' + AWS_CONFIG.oauthDomain + '/oauth2/authorize'
      + '?identity_provider=' + encodeURIComponent(providerName)
      + '&redirect_uri=' + encodeURIComponent(AWS_CONFIG.oauthRedirectUri)
      + '&response_type=code'
      + '&client_id=' + encodeURIComponent(AWS_CONFIG.userPoolClientId)
      + '&scope=' + encodeURIComponent(AWS_CONFIG.oauthScope || 'email openid profile');
    try { global.location.assign(url); }
    catch (e) { global.location.href = url; }
    return new Promise(function () {}); // la página navega fuera
  }

  function base64UrlDecode(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    // atob maneja UTF-8 mal; los claims que leemos son ASCII
    return global.atob(s);
  }

  function exchangeCodeForSession(code) {
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var body = 'grant_type=authorization_code'
      + '&client_id=' + encodeURIComponent(AWS_CONFIG.userPoolClientId)
      + '&code=' + encodeURIComponent(code)
      + '&redirect_uri=' + encodeURIComponent(AWS_CONFIG.oauthRedirectUri);
    return global.fetch('https://' + AWS_CONFIG.oauthDomain + '/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body
    }).then(function (resp) { return resp.json(); }).then(function (tok) {
      if (!tok || !tok.id_token) throw new Error('oauth/token-failed');
      var payload;
      try { payload = JSON.parse(base64UrlDecode(String(tok.id_token).split('.')[1])); }
      catch (e) { throw new Error('oauth/bad-token'); }
      var username = payload['cognito:username'] || payload.sub;
      if (!username) throw new Error('oauth/no-username');
      var cu = new C.CognitoUser({ Username: username, Pool: getUserPool() });
      var session = new C.CognitoUserSession({
        IdToken: new C.CognitoIdToken({ IdToken: tok.id_token }),
        AccessToken: new C.CognitoAccessToken({ AccessToken: tok.access_token }),
        RefreshToken: new C.CognitoRefreshToken({ RefreshToken: tok.refresh_token })
      });
      cu.setSignInUserSession(session);
      return establishSession(cu, session).then(function (user) { return { user: user }; });
    });
  }

  // Procesa el regreso del login social (?code= o ?error=)
  function handleOAuthRedirect() {
    try {
      var loc = global.location;
      if (!loc || !loc.search) return;
      var qs = String(loc.search);
      var mErr = /[?&]error(?:_description)?=([^&]*)/.exec(qs);
      var mCode = /[?&]code=([^&]+)/.exec(qs);
      if (!mErr && !mCode) return;
      // Limpiar la URL para no reprocesar
      try {
        var clean = loc.pathname + loc.hash;
        global.history.replaceState(null, '', clean);
      } catch (e) {}
      if (mErr) {
        var desc = '';
        try { desc = decodeURIComponent(/error_description=([^&]*)/.exec(qs)[1]).replace(/\+/g, ' '); } catch (e) {}
        var msg = 'No se pudo entrar con esa cuenta.';
        if (/already/i.test(desc)) msg = 'Ese correo ya tiene una cuenta en Drex. Entra con tu correo y contraseña.';
        notifyAuthError(msg);
        return;
      }
      var code = decodeURIComponent(mCode[1]);
      notifyAuthPending();
      getAuth();
      exchangeCodeForSession(code).then(function () {
        // establishSession ya notificó a los listeners
      }, function (err) {
        notifyAuthError('No se pudo completar el inicio de sesión. Intenta de nuevo.');
      });
    } catch (e) { /* sin login social pendiente */ }
  }

  var authPendingListeners = [];
  function notifyAuthPending() {
    // Avisa a la app que hay un login social en curso (puede mostrar spinner)
    try {
      if (global.document) {
        global.document.dispatchEvent(new global.CustomEvent('drex:oauth-pending'));
      }
    } catch (e) {}
  }
  function notifyAuthError(msg) {
    try {
      if (global.document) {
        global.document.dispatchEvent(new global.CustomEvent('drex:oauth-error', { detail: { message: msg } }));
      }
    } catch (e) {}
    if (typeof global.alert === 'function') { try { global.alert(msg); } catch (e) {} }
  }

  // Login social: Google y Facebook van por Cognito; otros siguen pendientes
  var SOCIAL_NAMES = { GoogleAuthProvider: 'Google', FacebookAuthProvider: 'Facebook', TwitterAuthProvider: 'X (Twitter)' };
  function signInWithPopup(provider) {
    getAuth();
    var name = (provider && (provider._socialName || SOCIAL_NAMES[provider.constructor && provider.constructor.name])) || 'esta red social';
    if (SOCIAL_IDP[name]) return federatedSignIn(SOCIAL_IDP[name]);
    var msg = 'El inicio con ' + name + ' estará disponible próximamente en Drex. Usa tu correo, Google o Facebook por ahora.';
    if (typeof global.alert === 'function') { try { global.alert(msg); } catch (e) {} }
    var err = new Error(msg);
    err.code = 'auth/operation-not-allowed';
    return Promise.reject(err);
  }

  function restoreSession() {
    try {
      getAuth();
      var C = cognitoLib();
      if (!C) return;
      var cu = getUserPool().getCurrentUser();
      if (!cu) return;
      cu.getSession(function (err, session) {
        if (!err && session && session.isValid()) {
          establishSession(cu, session).catch(function () {});
        }
      });
    } catch (e) { /* inicio sin sesión */ }
  }

  // DrexCloud

  var databaseSingleton = null;
  var SUPPORT_TABLE = 'drex-support-tickets';
  var SUPPORT_OWNER_EMAIL = 'zam.contact@yahoo.com';

  // Soporte estilo Instagram: el usuario envia su solicitud, el equipo
  // la revisa y responde; el usuario ve el estado: Recibida / En revision / Resuelta.
  function supportDoc() { return getDocClient(); }
  function supportUser() {
    var u = null;
    try { u = getAuth().currentUser; } catch (e) {}
    return u || {};
  }
  function supportNow() { return new Date().toISOString(); }
  var supportApi = {
    // Crea una solicitud de soporte; el equipo la revisa y responde.
    createTicket: function (subject, message) {
      var u = supportUser();
      if (!u.uid) return Promise.reject(new Error('auth/no-user'));
      var now = supportNow();
      var item = {
        ticketId: newPushId(),
        userId: u.uid,
        userEmail: u.email || '',
        subject: String(subject || '').slice(0, 120),
        messages: [{ from: 'user', text: String(message || '').slice(0, 4000), at: now }],
        status: 'received',
        createdAt: now,
        updatedAt: now
      };
      return supportDoc().put({ TableName: SUPPORT_TABLE, Item: item }).promise().then(function () { return item; });
    },
    // Solicitudes del usuario actual, más recientes primero.
    listMyTickets: function () {
      var u = supportUser();
      if (!u.uid) return Promise.reject(new Error('auth/no-user'));
      return supportDoc().query({
        TableName: SUPPORT_TABLE,
        IndexName: 'byUser',
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': u.uid },
        ScanIndexForward: false,
        Limit: 25
      }).promise().then(function (r) { return r.Items || []; });
    },
    // El usuario agrega un mensaje a su solicitud (la reabre como Recibida).
    replyToTicket: function (ticketId, message) {
      var u = supportUser();
      if (!u.uid) return Promise.reject(new Error('auth/no-user'));
      var now = supportNow();
      return supportDoc().update({
        TableName: SUPPORT_TABLE,
        Key: { ticketId: ticketId },
        UpdateExpression: 'SET #m = list_append(if_not_exists(#m, :empty), :nm), #s = :st, updatedAt = :now',
        ConditionExpression: 'userId = :u',
        ExpressionAttributeNames: { '#m': 'messages', '#s': 'status' },
        ExpressionAttributeValues: {
          ':empty': [],
          ':nm': [{ from: 'user', text: String(message || '').slice(0, 4000), at: now }],
          ':st': 'received',
          ':now': now,
          ':u': u.uid
        },
        ReturnValues: 'ALL_NEW'
      }).promise().then(function (r) { return r.Attributes; });
    },
    // Lado del equipo (solo el dueno ve esta seccion en la app)
    isOwner: function () {
      var u = supportUser();
      return String(u.email || '').toLowerCase() === SUPPORT_OWNER_EMAIL;
    },
    adminListTickets: function () {
      if (!this.isOwner()) return Promise.reject(new Error('auth/not-owner'));
      return supportDoc().scan({ TableName: SUPPORT_TABLE, Limit: 50 }).promise()
        .then(function (r) {
          return (r.Items || []).sort(function (a, b) {
            return String(b.updatedAt || '') < String(a.updatedAt || '') ? -1 : 1;
          });
        });
    },
    // El equipo responde: agrega mensaje from=team y marca En revision.
    adminReply: function (ticketId, message) {
      if (!this.isOwner()) return Promise.reject(new Error('auth/not-owner'));
      var now = supportNow();
      return supportDoc().update({
        TableName: SUPPORT_TABLE,
        Key: { ticketId: ticketId },
        UpdateExpression: 'SET #m = list_append(if_not_exists(#m, :empty), :nm), #s = :st, updatedAt = :now',
        ExpressionAttributeNames: { '#m': 'messages', '#s': 'status' },
        ExpressionAttributeValues: {
          ':empty': [],
          ':nm': [{ from: 'team', text: String(message || '').slice(0, 4000), at: now }],
          ':st': 'reviewing',
          ':now': now
        },
        ReturnValues: 'ALL_NEW'
      }).promise().then(function (r) { return r.Attributes; });
    },
    adminSetStatus: function (ticketId, status) {
      if (!this.isOwner()) return Promise.reject(new Error('auth/not-owner'));
      if (['received', 'reviewing', 'resolved'].indexOf(status) < 0) {
        return Promise.reject(new Error('support/bad-status'));
      }
      return supportDoc().update({
        TableName: SUPPORT_TABLE,
        Key: { ticketId: ticketId },
        UpdateExpression: 'SET #s = :st, updatedAt = :now',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':st': status, ':now': supportNow() },
        ReturnValues: 'ALL_NEW'
      }).promise().then(function (r) { return r.Attributes; });
    }
  };

  var DrexCloud = {
    database: function () {
      if (!databaseSingleton) databaseSingleton = createDatabase();
      return databaseSingleton;
    },
    auth: getAuth,
    support: supportApi,
    // Inicialización opcional por compatibilidad (la config vive arriba)
    initializeApp: function () { return {}; }
  };
  // ServerValue también directo sobre DrexCloud.database (sin llamar),
  // porque el código migrado usa DrexCloud.database.ServerValue.TIMESTAMP
  DrexCloud.database.ServerValue = DrexCloud.database().ServerValue;

  // Clases de proveedor para `new DrexCloud.auth.GoogleAuthProvider()` etc.
  function makeProvider(socialName) {
    var P = function () { this._socialName = socialName; };
    return P;
  }
  DrexCloud.auth.GoogleAuthProvider = makeProvider('Google');
  DrexCloud.auth.FacebookAuthProvider = makeProvider('Facebook');
  DrexCloud.auth.TwitterAuthProvider = makeProvider('X (Twitter)');

  global.DrexCloud = DrexCloud;

  // Solo en navegador: procesar regreso del login social y restaurar sesión
  if (typeof global.window !== 'undefined' && typeof global.document !== 'undefined') {
    if (global.document.readyState === 'complete' || global.document.readyState === 'interactive') {
      setTimeout(function () { handleOAuthRedirect(); restoreSession(); }, 0);
    } else {
      global.document.addEventListener('DOMContentLoaded', function () { setTimeout(function () { handleOAuthRedirect(); restoreSession(); }, 0); });
    }
  }

  // exportaciones solo para pruebas en node
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      DrexCloud: DrexCloud,
      __internals: {
        normalizePath: normalizePath,
        splitPath: splitPath,
        flatten: flatten,
        unflatten: unflatten,
        applyQuery: applyQuery,
        newPushId: newPushId,
        mapAuthError: mapAuthError,
        DataSnapshot: DataSnapshot,
        Ref: Ref,
        TIMESTAMP_SENTINEL: TIMESTAMP_SENTINEL,
        AWS_CONFIG: AWS_CONFIG,
        setDocClient: function (dc) { _docClient = dc; },
        setAwsCredentials: function (c) { _awsCredentials = c; },
        resetListeners: function () {
          for (var i = listeners.length - 1; i >= 0; i--) {
            if (listeners[i]._deb) clearTimeout(listeners[i]._deb);
          }
          listeners.length = 0;
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        },
        listenerCount: function () { return listeners.length; }
      }
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
