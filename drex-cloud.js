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
 * NOTA (verificado 2026-09-17): el User Pool SÍ exige verificación de email en
 * el registro ("Cognito-assisted verification: verify email address"); las
 * cuentas quedan UNCONFIRMED hasta ingresar el código de 6 dígitos y la app
 * (web y nativa) muestra la pantalla de código con reenvío. Los correos los
 * envía Cognito con su remitente por defecto (COGNITO_DEFAULT,
 * no-reply@verificationemail.com): límite de 50/día y entregabilidad pobre
 * (suele caer en spam en Gmail). Si los códigos dejan de llegar, revisar ese
 * límite o migrar el pool a SES con remitente propio verificado.
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
    oauthScope: 'email openid profile',
    // URL de DrexTotpFunction (verificación TOTP del lado servidor).
    // Se rellena con el Output TotpFunctionUrl tras desplegar el backend.
    totpFunctionUrl: '',
    // URL de la Lambda drex-username-resolve (login con nombre de usuario).
    // Se rellena con la Function URL real tras crear la Lambda en AWS.
    usernameLoginUrl: 'https://opyy2nl5x66xhu5uy4n4dwjzui0wkuas.lambda-url.us-east-1.on.aws/'
  };
  var IDP_ISSUER = 'cognito-idp.us-east-1.amazonaws.com/us-east-1_kDSYEBsnY';

  // Restauración de sesión estilo Instagram: en <head> ya sabemos si hay un
  // usuario guardado en localStorage. Mientras restorePending sea true, la
  // app no debe mostrar el login: la sesión aún se está restaurando.
  var restoreSeq = 0;
  function quickHasStoredUser() {
    try {
      if (typeof localStorage === 'undefined') return false;
      return !!localStorage.getItem('CognitoIdentityServiceProvider.' + AWS_CONFIG.userPoolClientId + '.LastAuthUser');
    } catch (e) { return false; }
  }
  var restorePending = quickHasStoredUser();
  function setRestorePending(v) { restorePending = !!v; }

  // Extrae sub/email/etc. del ID token (JWT) sin usar la red: permite
  // establecer la sesión aunque getUserAttributes falle (p. ej. abriendo la
  // app sin conexión, con una sesión válida en caché).
  function attrsFromIdToken(session) {
    try {
      var jwt = session.getIdToken().getJwtToken();
      var parts = String(jwt).split('.');
      if (parts.length < 2) return null;
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var payload = JSON.parse(decodeURIComponent(escape(atob(b64))));
      var out = [];
      ['sub', 'email', 'email_verified', 'name'].forEach(function (n) {
        if (payload[n] === undefined || payload[n] === null) return;
        out.push({
          getName: function () { return n; },
          getValue: function () { return String(payload[n]); }
        });
      });
      return out.length ? out : null;
    } catch (e) { return null; }
  }

  // Marca la sesión como expirada/no recuperada. Usa localStorage (además de
  // sessionStorage) para que el aviso sobreviva al cierre de la pestaña y el
  // usuario sí se entere de por qué volvió al login.
  function flagSessionExpired(reason) {
    var lang = 'es';
    try {
      var stored = (typeof localStorage !== 'undefined') && localStorage.getItem('drex_app_language_v1');
      if (stored === 'en') lang = 'en';
    } catch (e) {}
    try { sessionStorage.setItem('drex_session_expired', lang); } catch (e2) {}
    try { sessionStorage.setItem('drex_session_expired_reason', reason); } catch (e3) {}
    try { localStorage.setItem('drex_session_expired', lang); } catch (e4) {}
    try { localStorage.setItem('drex_session_expired_reason', reason); } catch (e5) {}
  }

  function clearSessionExpiredFlag() {
    try { sessionStorage.removeItem('drex_session_expired'); } catch (e) {}
    try { sessionStorage.removeItem('drex_session_expired_reason'); } catch (e2) {}
    try { localStorage.removeItem('drex_session_expired'); } catch (e3) {}
    try { localStorage.removeItem('drex_session_expired_reason'); } catch (e4) {}
  }

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
  // null equivale a BORRAR la clave (semántica de borrado con null): no genera hoja y,
  // si se pasa nullPaths, registra la ruta para que quien escriba la borre.
  function flatten(value, baseSegs, out, nullPaths) {
    out = out || [];
    value = resolveValue(value);
    if (value === undefined) return out;
    if (value === null) {
      if (Array.isArray(nullPaths)) nullPaths.push(baseSegs.slice());
      return out; // null borra la clave, no escribe tumba
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return out; // [] equivale a subárbol vacío
      for (var i = 0; i < value.length; i++) flatten(value[i], baseSegs.concat([String(i)]), out, nullPaths);
      return out;
    }
    if (isPlainObject(value)) {
      var keys = Object.keys(value);
      if (keys.length === 0) return out; // {} equivale a borrar el subárbol
      for (var k = 0; k < keys.length; k++) {
        flatten(value[keys[k]], baseSegs.concat([keys[k]]), out, nullPaths);
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
    return arraysBack(result);
  }

  // Los arrays se aplanan como claves numéricas ("0","1",...); al reconstruir,
  // los objetos con claves 0..n-1 consecutivas vuelven a ser arrays (comportamiento
  // estándar de la plataforma). Sin esto las encuestas nunca se podían votar.
  function arraysBack(node) {
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) node[i] = arraysBack(node[i]);
      return node;
    }
    if (!isPlainObject(node)) return node;
    var keys = Object.keys(node);
    var isSeq = keys.length > 0;
    for (var i = 0; i < keys.length && isSeq; i++) {
      if (keys[i] !== String(i)) isSeq = false;
    }
    if (isSeq) {
      var arr = [];
      for (var j = 0; j < keys.length; j++) arr.push(arraysBack(node[String(j)]));
      return arr;
    }
    for (var k = 0; k < keys.length; k++) node[keys[k]] = arraysBack(node[keys[k]]);
    return node;
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

  // --- Auto-reparación de credenciales AWS (fix 2026-09-17) ---
  // Causa del bug "No se pudo enviar el mensaje": si el configure inicial de
  // credenciales fallaba (red inestable al abrir la app) o el refresh del
  // token no lograba reconfigurarlas, el usuario quedaba "logueado" pero con
  // credenciales anónimas/rotas cacheadas: TODA lectura y escritura a DynamoDB
  // fallaba con AccessDenied hasta reinstalar o reloguear. El comentario viejo
  // decía "se reintentan al usar la BD" pero nada lo implementaba.
  // Ahora: cualquier operación que falle por credenciales refresca la sesión
  // Cognito, reconfigura las credenciales y reintenta la operación UNA vez.
  var _credsRefreshPromise = null;

  function isCredError(err) {
    if (!err) return false;
    var code = String((err && err.code) || '');
    var msg = String((err && err.message) || '');
    return /CredentialsError|AccessDenied|UnrecognizedClient|InvalidSignature|ExpiredToken|TokenRefresh/i.test(code)
        || /credential/i.test(msg);
  }

  function refreshAwsCredentialsNow() {
    if (_credsRefreshPromise) return _credsRefreshPromise;
    _credsRefreshPromise = promiseTimeout(new Promise(function (resolve, reject) {
      try {
        if (!currentCognitoUser) return reject(new Error('no-session'));
        // getSession refresca solo con el refresh token si el ID token venció
        currentCognitoUser.getSession(function (err, session) {
          if (err || !session) return reject(err || new Error('no-session'));
          resolve(configureAwsCredentials(session.getIdToken()));
        });
      } catch (e) { reject(e); }
    }), 20000, 'aws-creds-timeout');
    function clear() { _credsRefreshPromise = null; }
    _credsRefreshPromise.then(clear, clear);
    return _credsRefreshPromise;
  }

  function withCredRetry(opFn) {
    function run() {
      try { return opFn(); }
      catch (e) { return Promise.reject(e); }
    }
    return run().catch(function (err) {
      if (!isCredError(err)) throw err;
      if (!currentCognitoUser) throw err;
      return refreshAwsCredentialsNow().then(run, function () { throw err; });
    });
  }

  function queryAll(params) {
    return withCredRetry(function () {
      var dc = getDocClient();
      var items = [];
      function loop(lastKey) {
        var p = Object.assign({}, params, { ConsistentRead: true });
        if (lastKey) p.ExclusiveStartKey = lastKey;
        return dbTimeout(dc.query(p).promise(), 'db-query-timeout').then(function (res) {
          items = items.concat(res.Items || []);
          if (res.LastEvaluatedKey) return loop(res.LastEvaluatedKey);
          return items;
        });
      }
      return loop(null);
    });
  }

  function batchWriteAll(requests) {
    if (!requests.length) return Promise.resolve();
    return withCredRetry(function () {
      var dc = getDocClient();
      var TABLE = AWS_CONFIG.tableName;
      var attempt = 0;
      function sendBatch(batch) {
        var params = { RequestItems: {} };
        params.RequestItems[TABLE] = batch;
        return dbTimeout(dc.batchWrite(params).promise(), 'db-write-timeout').then(function (res) {
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
    });
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
  // Put condicional de una hoja: solo escribe si el valor actual en 'v' sigue
  // siendo expectedJson (o si la hoja no existe cuando expectedJson es null).
  // Es la primitiva que da atomicidad real a transaction() en hojas escalares.
  function putLeafConditional(pk, sk, jsonValue, expectedJson) {
    var params = {
      TableName: AWS_CONFIG.tableName,
      Item: { pk: pk, sk: normSk(sk), v: jsonValue },
      ExpressionAttributeNames: { '#v': 'v' },
      ExpressionAttributeValues: { ':exp': expectedJson }
    };
    if (expectedJson === null) {
      // snap.val() devuelve null tanto si la hoja no existe como si guarda
      // el JSON null; en ambos casos la v almacenada es inexistente o la
      // cadena "null" (JSON.stringify(null)). Comparar contra la cadena,
      // no contra el tipo NULL de DynamoDB (una v='null' nunca iguala NULL).
      params.ExpressionAttributeValues = { ':exp': 'null' };
      params.ConditionExpression = 'attribute_not_exists(pk) OR #v = :exp';
    } else {
      params.ConditionExpression = '#v = :exp';
    }
    return withCredRetry(function () { return dbTimeout(getDocClient().put(params).promise(), 'db-put-timeout'); });
  }

  // Transacción multi-hoja con atomicidad real (DynamoDB transact_write_items):
  // cada hoja se escribe o borra solo si su valor crudo sigue siendo el que
  // se leyó; si otra escritura se adelantó, toda la transacción se aborta de
  // forma atómica. Límite de DynamoDB: 100 hojas por transacción.
  function transactObjectLeaves(segs, oldLeaves, newValue) {
    var oldMap = {}; // sk relativo a segs -> json crudo almacenado
    oldLeaves.forEach(function (l) {
      oldMap[l.segs.slice(segs.length).join('/')] = JSON.stringify(l.value);
    });
    var newMap = {};
    flatten(newValue, []).forEach(function (l) {
      newMap[l.segs.join('/')] = JSON.stringify(l.value);
    });
    var items = [];
    var sk;
    var skPrefix = segs.slice(1).join('/');
    function fullSk(rel) { return normSk(skPrefix ? skPrefix + '/' + rel : rel); }
    for (sk in newMap) {
      var put = { Put: {
        TableName: AWS_CONFIG.tableName,
        Item: { pk: segs[0], sk: fullSk(sk), v: newMap[sk] }
      } };
      if (Object.prototype.hasOwnProperty.call(oldMap, sk)) {
        put.Put.ConditionExpression = '#v = :old';
        put.Put.ExpressionAttributeNames = { '#v': 'v' };
        put.Put.ExpressionAttributeValues = { ':old': oldMap[sk] };
      } else {
        put.Put.ConditionExpression = 'attribute_not_exists(pk)';
      }
      items.push(put);
    }
    for (sk in oldMap) {
      if (Object.prototype.hasOwnProperty.call(newMap, sk)) continue;
      items.push({ Delete: {
        TableName: AWS_CONFIG.tableName,
        Key: { pk: segs[0], sk: fullSk(sk) },
        ConditionExpression: '#v = :old',
        ExpressionAttributeNames: { '#v': 'v' },
        ExpressionAttributeValues: { ':old': oldMap[sk] }
      } });
    }
    if (!items.length) return Promise.resolve();
    return withCredRetry(function () {
      return dbTimeout(getDocClient().transactWrite({ TransactItems: items }).promise(), 'db-transact-timeout');
    });
  }

  // Lee todas las hojas bajo una ruta (hoja exacta + descendientes).
  // Usa begins_with(sk, 'ruta/') para no confundir 'abc' con 'abc2'.
  // Fase 1: localiza los prefijos (push IDs) más recientes con un Query en
  // reversa proyectando SOLO sk (items de ~30 bytes: 1 página típica).
  // Fase 2: lee en paralelo solo las hojas de esos prefijos. Costo acotado
  // por N, independiente del tamaño total de la tabla.
  function readLeavesBounded(pk, limitN) {
    var want = Math.ceil(limitN * 1.5) + 10;
    // communityNotes: los posts viejos guardan las fotos como data URLs inline
    // (hasta ~300KB c/u, 20 por post). Descargarlas en cada polling (cada 3 s)
    // saturaba la red del telefono y el feed tardaba una eternidad en cargar.
    // La fase 2 EXCLUYE esos bytes con FilterExpression; la fase 1 anota solo
    // las KEYS de imagen por post (pocos bytes) y las fotos se cargan bajo
    // demanda al pintar la tarjeta (ver hydrateLegacyNoteImages en index.html).
    var lightImages = (pk === 'communityNotes');
    var wantScan = lightImages ? want + 3 : want;
    var prefixes = [];
    var seen = {};
    var imgKeysByPrefix = {}; // pfx -> ['imageUrls/0', ...] o ['imageUrl']
    function phase1(lastKey) {
      var p = {
        TableName: AWS_CONFIG.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ProjectionExpression: 'sk',
        ScanIndexForward: false
      };
      if (lastKey) p.ExclusiveStartKey = lastKey;
      return withCredRetry(function () {
        return dbTimeout(getDocClient().query(p).promise(), 'db-query-timeout');
      }).then(function (res) {
        var arr = res.Items || [];
        for (var i = 0; i < arr.length; i++) {
          var sk = (arr[i].sk === undefined || arr[i].sk === null) ? '' : String(arr[i].sk);
          var first = sk.split('/')[0];
          if (first && !seen[first]) { seen[first] = 1; prefixes.push(first); }
          if (lightImages && first) {
            var rel = sk.slice(first.length + 1);
            if (rel === 'imageUrl' || rel === 'imageUrls' || rel.indexOf('imageUrls/') === 0) {
              (imgKeysByPrefix[first] = imgKeysByPrefix[first] || []).push(rel);
            }
          }
          if (prefixes.length >= wantScan) break;
        }
        if (prefixes.length < wantScan && res.LastEvaluatedKey) return phase1(res.LastEvaluatedKey);
        // Con +3 de margen, las keys de imagen de los primeros `want` prefijos
        // estan completas: en orden descendente de sk, todas las hojas de un
        // prefijo vienen antes que la primera hoja del siguiente.
        if (lightImages) prefixes = prefixes.slice(0, want);
        return prefixes;
      });
    }
    function phase2() {
      if (!prefixes.length) return Promise.resolve([]);
      return Promise.all(prefixes.map(function (pfx) {
        var pr = lightImages
          ? readLeavesLight([pk, pfx]).catch(function () { return readLeaves([pk, pfx]); })
          : readLeaves([pk, pfx]);
        return pr.then(function (leaves) {
          if (lightImages && imgKeysByPrefix[pfx] && imgKeysByPrefix[pfx].length) {
            leaves.push({ segs: [pk, pfx, '_imgKeys'], value: sortImgKeys(imgKeysByPrefix[pfx]) });
          }
          return leaves;
        });
      })).then(function (lists) {
        var out = [];
        lists.forEach(function (ll) { out = out.concat(ll); });
        return out;
      });
    }
    return phase1(null).then(phase2);
  }

  // Orden natural para las keys de imagen: imageUrls/0, imageUrls/1, ...,
  // imageUrls/10 (no lexicografico, que pondria el 10 antes que el 2).
  function sortImgKeys(keys) {
    return keys.slice().sort(function (a, b) {
      var na = parseInt(String(a).split('/')[1], 10);
      var nb = parseInt(String(b).split('/')[1], 10);
      var aNum = !isNaN(na), bNum = !isNaN(nb);
      if (aNum && bNum && na !== nb) return na - nb;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
  }

  // Variante liviana de readLeaves para el feed: lee las hojas bajo el prefijo
  // EXCLUYENDO los bytes de imagen inline (imageUrl*), que son los que volvian
  // lento cada polling. Las fotos se cargan bajo demanda al ver el post.
  function readLeavesLight(segs) {
    var pk = segs[0];
    var skExact = segs.slice(1).join('/');
    return queryAll({
      TableName: AWS_CONFIG.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :pfx)',
      FilterExpression: 'NOT contains(sk, :img)',
      ExpressionAttributeValues: { ':pk': pk, ':pfx': skExact + '/', ':img': '/imageUrl' }
    }).then(function (items) {
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

  function readLeaves(segs, query) {
    if (!segs.length) return Promise.reject(new Error('Ruta vacía no soportada'));
    var pk = segs[0];
    var skExact = segs.slice(1).join('/');
    // Lectura ACOTADA "últimos N por tiempo": orderByChild('timestamp'|
    // 'createdAt') + limitToLast(N), sin otros filtros. Los push IDs ordenan
    // lexicográficamente por tiempo de creación (newPushId), así que los N
    // más recientes por pushId son los N más recientes por timestamp. En vez
    // de descargar el pk COMPLETO en cada polling (crece sin cota con la
    // tabla), se localizan los prefijos más nuevos con un escaneo ligero
    // (solo sk) y luego se leen únicamente esos posts/pistas. El applyQuery
    // posterior ordena por el campo real y aplica el límite exacto.
    if (segs.length === 1 && query && typeof query.limitLast === 'number' && query.limitLast > 0 &&
        !query.limitFirst && !query.orderByKey &&
        (query.orderBy === 'timestamp' || query.orderBy === 'createdAt') &&
        query.equalTo === undefined && query.startAt === undefined && query.endAt === undefined) {
      return readLeavesBounded(pk, query.limitLast);
    }
    var jobs;
    if (skExact === '') {
      jobs = [queryAll({
        TableName: AWS_CONFIG.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk }
      })];
    } else {
      jobs = [
        queryAll({
          TableName: AWS_CONFIG.tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :pfx)',
          ExpressionAttributeValues: { ':pk': pk, ':pfx': skExact + '/' }
        }),
        withCredRetry(function () {
          return dbTimeout(getDocClient().get({
            TableName: AWS_CONFIG.tableName,
            Key: { pk: pk, sk: skExact },
            ConsistentRead: true
          }).promise(), 'db-get-timeout').then(function (res) { return res.Item ? [res.Item] : []; });
        })
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
    // Sin coincidencias se devuelve val() === null y exists() === false
    // (nunca un objeto vacío). Devolver {} aquí rompía la verificación de
    // disponibilidad de usernames (todo aparecía "en uso"), los estados
    // "vacío" de solicitudes/notas y el bloqueo de correcciones duplicadas.
    if (!entries.length) return null;
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
    var q = ref._query || {};
    // Índice musicByAuthor: las consultas "pistas de un autor" descargaban
    // musicTracks COMPLETO (todas las canciones de todos) y filtraban en el
    // cliente, lo que dejaba "Tu música" en "Cargando..." eterno. Ahora se
    // lee el índice pequeño del autor y solo se descargan sus pistas.
    if (ref._segs.length === 1 && ref._segs[0] === 'musicTracks' &&
        q.orderBy === 'authorId' && q.equalTo !== undefined &&
        q.startAt === undefined && q.endAt === undefined) {
      return readMusicTracksByAuthor(q.equalTo).then(function (val) {
        val = applyQuery(val, ref._query);
        return new DataSnapshot(val, 'musicTracks');
      });
    }
    return readLeaves(ref._segs, ref._query).then(function (leaves) {
      var val = unflatten(leaves, ref._segs);
      if (ref._query) val = applyQuery(val, ref._query);
      var key = ref._segs.length ? ref._segs[ref._segs.length - 1] : null;
      return new DataSnapshot(val, key);
    });
  }

  // Lee las pistas de un autor vía el índice musicByAuthor/<uid>/<trackId>.
  // El índice se escribe al subir cada canción; para canciones anteriores al
  // índice se hace UN backfill (escaneo legacy) y se marca _indexed para no
  // repetirlo. Sin índice ni marca y sin pistas => {} (applyQuery -> null).
  function readMusicTracksByAuthor(uid) {
    uid = String(uid);
    return readLeaves(['musicByAuthor', uid]).then(function (leaves) {
      var idx = unflatten(leaves, ['musicByAuthor', uid]) || {};
      var ids = Object.keys(idx).filter(function (k) { return k.charAt(0) !== '_'; });
      // Ordenar por t desc: con limitToLast(N) basta leer los primeros N.
      ids.sort(function (a, b) {
        var ta = (idx[a] && idx[a].t) || 0, tb = (idx[b] && idx[b].t) || 0;
        return tb - ta;
      });
      if (!ids.length && !idx._indexed) {
        return readLeaves(['musicTracks']).then(function (allLeaves) {
          var all = unflatten(allLeaves, ['musicTracks']) || {};
          var reqs = [];
          var obj = {};
          Object.keys(all).forEach(function (tid) {
            var t = all[tid];
            if (t && typeof t === 'object' && String(t.authorId) === uid) {
              obj[tid] = t;
              reqs.push(putLeaf('musicByAuthor', uid + '/' + tid, { t: t.createdAt || 0 }));
            }
          });
          reqs.push(putLeaf('musicByAuthor', uid + '/_indexed', true));
          batchWriteAll(reqs).catch(function () {});
          return obj;
        });
      }
      return Promise.all(ids.map(function (tid) {
        return readLeaves(['musicTracks', tid]).then(function (ll) {
          return [tid, unflatten(ll, ['musicTracks', tid]) || {}];
        });
      })).then(function (pairs) {
        var obj = {};
        pairs.forEach(function (pr) { obj[pr[0]] = pr[1]; });
        return obj;
      });
    });
  }

  function safeJson(v) {
    try { return JSON.stringify(v); } catch (e) { return null; }
  }
  // Huella de cambio liviana para oyentes: las fotos se guardan como data
  // URLs en base64 (hasta ~300 KB cada una) y un feed con posts de varias
  // fotos suma decenas de MB. Comparar con JSON.stringify del snapshot
  // completo en cada ciclo de polling (3 s) reventaba la memoria y el CPU
  // del iPhone: los ciclos se apilaban, los .catch tragaban los fallos y el
  // feed dejaba de actualizarse (posts recién publicados que "no aparecían").
  // La huella reemplaza cada cadena larga por longitud+hash de sus bordes;
  // los campos escalares (votos, timestamps, contenido) se comparan exactos.
  function _hashStr(s) {
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
      h2 = Math.imul(h2 + s.charCodeAt(i), 31);
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
  }
  function _fingerprintValue(v) {
    if (typeof v === 'string') {
      if (v.length > 2048) return '~BLOB:' + v.length + ':' + _hashStr(v.slice(0, 64) + v.slice(-64));
      return v;
    }
    if (Array.isArray(v)) {
      var a = new Array(v.length);
      for (var i = 0; i < v.length; i++) a[i] = _fingerprintValue(v[i]);
      return a;
    }
    if (v !== null && typeof v === 'object') {
      var o = {};
      var ks = Object.keys(v);
      for (var k = 0; k < ks.length; k++) o[ks[k]] = _fingerprintValue(v[ks[k]]);
      return o;
    }
    return v;
  }
  function _changeFingerprint(v) {
    try { return JSON.stringify(_fingerprintValue(v)); } catch (e) { return null; }
  }
  function callCb(cb, arg) {
    try { cb(arg); } catch (e) { setTimeout(function () { throw e; }, 0); }
  }

  function childEntriesOf(snap) {
    var v = snap.val();
    if (!v || typeof v !== 'object') return [];
    return Object.keys(v).map(function (k) { return [k, v[k]]; });
  }

  // Dispara un oyente según su tipo de evento ('value' | 'child_added' | 'child_changed' | 'child_removed')
  // Reparte un snapshot ya leído entre la lógica de eventos de UN oyente
  // ('value' | 'child_added' | 'child_changed' | 'child_removed').
  function dispatchSnapshot(l, snap) {
      if (l.eventType === 'value') {
        var j = _changeFingerprint(snap.val());
        if (j !== l.lastJson) { l.lastJson = j; callCb(l.cb, snap); }
        return;
      }
      var entries = childEntriesOf(snap);
      if (l.eventType === 'child_added') {
        if (!l.kids) {
          l.kids = {};
          entries.forEach(function (e) { l.kids[e[0]] = _changeFingerprint(e[1]); callCb(l.cb, snap.child(e[0])); });
        } else {
          var seen = {};
          entries.forEach(function (e) {
            seen[e[0]] = 1;
            var ej = _changeFingerprint(e[1]);
            if (!(e[0] in l.kids)) { l.kids[e[0]] = ej; callCb(l.cb, snap.child(e[0])); }
            else l.kids[e[0]] = ej;
          });
          Object.keys(l.kids).forEach(function (k) { if (!seen[k]) delete l.kids[k]; });
        }
      } else if (l.eventType === 'child_changed') {
        if (!l.kids) {
          l.kids = {};
          entries.forEach(function (e) { l.kids[e[0]] = _changeFingerprint(e[1]); });
        } else {
          entries.forEach(function (e) {
            var ej = _changeFingerprint(e[1]);
            if ((e[0] in l.kids) && l.kids[e[0]] !== ej) callCb(l.cb, snap.child(e[0]));
            l.kids[e[0]] = ej;
          });
        }
      } else if (l.eventType === 'child_removed') {
        // Primera lectura: línea base, sin disparar (igual que child_changed).
        // Después: todo hijo que estaba y ya no está => eliminado.
        if (!l.kids) {
          l.kids = {};
          entries.forEach(function (e) { l.kids[e[0]] = _changeFingerprint(e[1]); });
        } else {
          var seenR = {};
          entries.forEach(function (e) { seenR[e[0]] = 1; l.kids[e[0]] = _changeFingerprint(e[1]); });
          Object.keys(l.kids).forEach(function (k) {
            if (!seenR[k]) { delete l.kids[k]; callCb(l.cb, snap.child(k)); }
          });
        }
      }
      }

  function fireListener(l) {
    // No apilar lecturas: si la anterior aún no terminó (lectura pesada con
    // muchas fotos), se marca un re-disparo pendiente en vez de lanzar otra
    // lectura encima. Sin esto, los ciclos de polling se solapaban y la
    // pestaña del iPhone se quedaba sin memoria.
    if (l._reading) { l._pendingFire = true; return Promise.resolve(); }
    l._reading = true;
    return readRefValue(l.ref).then(function (snap) {
      dispatchSnapshot(l, snap);
    }).catch(function () { /* el próximo ciclo reintenta */ }).then(function () {
      l._reading = false;
      if (l._pendingFire) { l._pendingFire = false; fireListener(l); }
    });
  }

  // Clave de agrupación: oyentes sobre la MISMA ruta y la MISMA consulta
  // comparten una sola lectura por ciclo de polling.
  function pollGroupKey(l) {
    return l.ref._segs.join('/') + '|' + JSON.stringify(l.ref._query || null);
  }

  // Dispara un grupo de oyentes con UNA sola lectura compartida.
  function pollGroup(ls) {
    var busy = false;
    for (var i = 0; i < ls.length; i++) { if (ls[i]._reading) { busy = true; break; } }
    if (busy) { ls.forEach(function (l) { l._pendingFire = true; }); return; }
    ls.forEach(function (l) { l._reading = true; });
    readRefValue(ls[0].ref).then(function (snap) {
      ls.forEach(function (l) { dispatchSnapshot(l, snap); });
    }).catch(function () { /* el próximo ciclo reintenta */ }).then(function () {
      var again = false;
      ls.forEach(function (l) {
        l._reading = false;
        if (l._pendingFire) { l._pendingFire = false; again = true; }
      });
      if (again) pollGroup(ls);
    });
  }

  // Un ciclo de polling agrupa los oyentes por (ruta + consulta): el feed
  // tenía 3 oyentes (child_added/changed/removed) sobre la misma consulta y
  // cada uno descargaba communityNotes COMPLETO cada 3 s. Ahora los 3
  // comparten el mismo snapshot: ~3x menos lecturas al servidor.
  function pollListenersGrouped() {
    // En segundo plano no se sondea (ahorra batería y datos en el iPhone);
    // al volver a primer plano el siguiente ciclo (<=3 s) refresca. La
    // señalización de fiestas (polling rápido de WebRTC) sigue activa.
    if (!fastPolling && typeof document !== 'undefined' && document.hidden) return;
    var groups = {};
    listeners.slice().forEach(function (l) {
      var k = pollGroupKey(l);
      (groups[k] = groups[k] || []).push(l);
    });
    Object.keys(groups).forEach(function (k) { pollGroup(groups[k]); });
  }

  var fastPolling = false;
  function ensurePolling() {
    if (!pollTimer && listeners.length) {
      pollTimer = setInterval(pollListenersGrouped, fastPolling ? 800 : 3000);
    }
  }
  function maybeStopPolling() {
    if (pollTimer && !listeners.length) { clearInterval(pollTimer); pollTimer = null; }
  }
  // Activa/desactiva polling rápido (800ms) para señalización WebRTC en fiestas.
  // El polling normal de 3s es muy lento para offers/answers/ICE candidates.
  function setFastPolling(enabled) {
    fastPolling = !!enabled;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      ensurePolling();
    }
  }

  // Avisa a los oyentes afectados por una escritura propia (eco local inmediato)
  function notifyLocal(changedSegs) {
    // Eco local inmediato tras una escritura propia, agrupado por
    // (ruta + consulta) para no repetir la misma lectura N veces.
    var groups = {};
    listeners.forEach(function (l) {
      if (!pathsOverlap(l.ref._segs, changedSegs)) return;
      var k = pollGroupKey(l);
      (groups[k] = groups[k] || []).push(l);
    });
    Object.keys(groups).forEach(function (k) {
      var ls = groups[k];
      ls.forEach(function (l) { if (l._deb) { clearTimeout(l._deb); l._deb = null; } });
      var rep = ls[0];
      rep._deb = setTimeout(function () { rep._deb = null; pollGroup(ls); }, 120);
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
      var nullSegs = [];
      var leaves = flatten(obj[k], fullSegs, [], nullSegs);
      // null (en cualquier nivel) borra esa ruta
      nullSegs.forEach(function (ns) { prefixDeletes[ns.join('/')] = ns; });
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
      if (!leaves.length && !nullSegs.length) {
        // update({ruta: {}}) o update({ruta: []}) borra ese subárbol, como en
        // el proveedor anterior. (null se borra vía nullSegs, arriba.)
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

  // pushAsync(value): como push(), pero DEVUELVE la promesa de la escritura
  // real: resuelve con el Ref hijo cuando la escritura termina de verdad y
  // RECHAZA si la escritura falla. (push() traga el error en un .catch que
  // solo avisa por consola: el llamador mostraba "éxito" aunque nada se
  // hubiera guardado, p. ej. publicar 9 fotos veía "¡Publicación creada
  // exitosamente!" y el post no aparecía en el feed ni en ningún lado.)
  Ref.prototype.pushAsync = function (value) {
    var r = this.child(newPushId());
    if (value === undefined) return Promise.resolve(r);
    r._writePromise = r.set(value);
    return r._writePromise.then(function () { return r; });
  };

  // NOTA: se eliminó Ref.prototype.then (hacía al Ref "thenable" y provocaba
  // asimilación recursiva infinita: `await ref.push(x)` nunca resolvía).
  // Para esperar la escritura: `await ref.push(valor)._writePromise`.

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
    if (eventType !== 'value' && eventType !== 'child_added' && eventType !== 'child_changed' && eventType !== 'child_removed') {
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
    var query = JSON.stringify(this._query || null);
    for (var i = listeners.length - 1; i >= 0; i--) {
      var l = listeners[i];
      var sameRef = l.ref._segs.join('/') === path;
      var sameQuery = JSON.stringify(l.ref._query || null) === query;
      var sameEvent = !eventType || l.eventType === eventType;
      if (sameRef && sameQuery && sameEvent && (!cb || l.cb === cb)) {
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

  // Transacción con atomicidad real del lado servidor (sin backend nuevo):
  // - Hojas escalares (contadores, reservas): Put condicional sobre el valor
  //   leído; si otro escritor se adelantó, reintenta la lectura completa.
  // - Objetos (p. ej. el voto de encuestas): transact_write_items multi-hoja;
  //   cada hoja se escribe/borra solo si su valor sigue siendo el leído, así
  //   que los votos concurrentes ya no se pierden. Si el objeto supera el
  //   límite de DynamoDB (90 hojas) se usa optimistic locking: releer y solo
  //   escribir si nadie cambió los datos; si no, reintentar con datos frescos.
  // Huella canónica de un conjunto de hojas para comparar lecturas
  // (el orden de readLeaves no es determinista, por eso se ordena).
  function leavesFingerprint(leaves) {
    return (leaves || [])
      .map(function (l) { return l.segs.join('/') + '=' + JSON.stringify(l.value); })
      .sort()
      .join('\n');
  }

  Ref.prototype.transaction = function (updateFn, onComplete) {
    var ref = this;
    var MAX_ATTEMPTS = 6;
    var MAX_TRANSACT_ITEMS = 90; // margen bajo el límite de 100 de DynamoDB
    function isScalar(v) { return v === null || v === undefined || typeof v !== 'object'; }
    function isConditionalCancel(err) {
      if (!err) return false;
      if (err.code === 'ConditionalCheckFailedException') return true;
      if (err.code === 'TransactionCanceledException' && err.CancellationReasons) {
        return err.CancellationReasons.some(function (r) { return r && r.Code === 'ConditionalCheckFailed'; });
      }
      return false;
    }
    function run(attempt) {
      return readLeaves(ref._segs).then(function (leaves) {
        var cur = unflatten(leaves, ref._segs);
        var newVal = updateFn(cur);
        if (newVal === undefined) {
          var key = ref._segs.length ? ref._segs[ref._segs.length - 1] : null;
          return { committed: false, snapshot: new DataSnapshot(cur, key) };
        }
        var segs = ref._segs;
        if (isScalar(cur) && isScalar(newVal) && segs.length) {
          var expectedJson = (cur === null || cur === undefined) ? null : JSON.stringify(cur);
          return putLeafConditional(segs[0], segs.slice(1).join('/'), JSON.stringify(newVal), expectedJson)
            .then(function () {
              notifyLocal(segs);
              return ref.once('value').then(function (s2) { return { committed: true, snapshot: s2 }; });
            })
            .catch(function (err) {
              if (isConditionalCancel(err) && attempt < MAX_ATTEMPTS) return run(attempt + 1);
              throw err;
            });
        }
        if (segs.length) {
          var newLeaves = flatten(newVal, []);
          if (leaves.length + newLeaves.length <= MAX_TRANSACT_ITEMS) {
            return transactObjectLeaves(segs, leaves, newVal)
              .then(function () {
                notifyLocal(segs);
                return ref.once('value').then(function (s2) { return { committed: true, snapshot: s2 }; });
              })
              .catch(function (err) {
                if (isConditionalCancel(err) && attempt < MAX_ATTEMPTS) return run(attempt + 1);
                throw err;
              });
          }
        }
        // Más de 90 hojas: no cabe en una TransactWriteItems de DynamoDB.
        // Optimistic locking en vez de set() ciego: releer y escribir solo si
        // nadie modificó los datos; si hubo cambios concurrentes, reintentar
        // con datos frescos en lugar de sobrescribirlos en silencio.
        return readLeaves(ref._segs).then(function (freshLeaves) {
          if (leavesFingerprint(freshLeaves) !== leavesFingerprint(leaves)) {
            if (attempt < MAX_ATTEMPTS) return run(attempt + 1);
            throw new Error('transaction(): contención excesiva, intente de nuevo');
          }
          return ref.set(newVal).then(function () {
            return ref.once('value').then(function (s2) { return { committed: true, snapshot: s2 }; });
          });
        });
      });
    }
    var p = run(1);
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
      signInWithUsernameAndPassword: signInWithUsernameAndPassword,
      createUserWithEmailAndPassword: createUserWithEmailAndPassword,
      signUpOrResendConfirmation: signUpOrResendConfirmation,
      confirmRegistration: confirmRegistration,
      resendConfirmation: resendConfirmation,
      sendPasswordResetEmail: sendPasswordResetEmail,
      confirmPasswordReset: confirmPasswordReset,
      signOut: signOutUser,
      signInWithPopup: signInWithPopup,
      // JWT del ID token de Cognito (para autenticar llamadas a lambdas propias)
      getIdToken: function () {
        return new Promise(function (resolve) {
          try {
            var C = cognitoLib();
            if (!C) return resolve(null);
            var cu = getUserPool().getCurrentUser();
            if (!cu) return resolve(null);
            cu.getSession(function (err, session) {
              if (err || !session || !session.isValid()) return resolve(null);
              try { resolve(session.getIdToken().getJwtToken()); }
              catch (e) { resolve(null); }
            });
          } catch (e) { resolve(null); }
        });
      }
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
    restoreSeq++;
    setRestorePending(false);
    flagSessionExpired('expired');
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
            configureAwsCredentials(newSession.getIdToken()).catch(function (credErr) {
              // Fix 2026-09-17: NO tragar el fallo en silencio. Se anulan las
              // credenciales para no dejar un objeto a medias cacheado; la
              // próxima operación de BD las reconstruye vía withCredRetry
              // (auto-reparación sin reloguear).
              _awsCredentials = null;
              _docClient = null;
              try { if (typeof console !== 'undefined' && console.warn) console.warn('[DrexCloud] configureAwsCredentials falló tras refresh:', credErr && (credErr.code || credErr.message)); } catch (_) {}
            });
            scheduleTokenRefresh(cognitoUser, newSession);
          } else {
            handleExpiredSession();
          }
        });
      }, delay);
    } catch (e) { /* best-effort */ }
  }

  // Una promesa con tiempo límite: si la red se queda colgada, se continúa
  // con el flujo en vez de dejar la sesión atascada.
  function promiseTimeout(promise, ms, label) {    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; reject(new Error(label || 'timeout')); }
      }, ms);
      promise.then(function (v) {
        if (!settled) { settled = true; clearTimeout(timer); resolve(v); }
      }, function (e) {
        if (!settled) { settled = true; clearTimeout(timer); reject(e); }
      });
    });
  }

  // FIX 2026-09-18: las operaciones de DynamoDB no tenían ningún timeout.
  // Si la red se colgaba a mitad de la petición (típico en datos móviles),
  // la promesa jamás se resolvía y el login se quedaba en "Iniciando..."
  // para siempre, sin mostrar ningún error. Ahora fallan a los 25 s y el
  // flujo de login muestra el error con botón Reintentar en vez de atorarse.
  function dbTimeout(promise, label) {
    return promiseTimeout(promise, 25000, label || 'db-timeout');
  }

  // Reparación del índice de login por username (2026-09-20): las cuentas
  // creadas antes de la función "iniciar sesión con nombre de usuario"
  // tienen perfil con username pero NUNCA se escribió su entrada
  // `usernames/<normalizado>` en la tabla, que es lo que la Lambda
  // drex-username-resolve consulta. Sin esa entrada el login por username
  // devuelve "incorrecta" aunque la contraseña sea correcta.
  // Tras cada autenticación exitosa se asegura, SIN bloquear el login:
  //   1. `usernames/<normalizado>` -> uid (transacción suave: solo si está
  //      libre o ya apunta a este uid; jamás se roba el de otro usuario)
  //   2. `users/<uid>/email` -> email de Cognito (la Lambda lo necesita para
  //      resolver el correo sin exponerlo; Cognito es la fuente autoritativa)
  // No indexa usernames temporales (usernameIsFallback). Idempotente y
  // silencioso: cualquier fallo se ignora, el login no depende de esto.
  function ensureUsernameLoginIndex(user) {
    try {
      if (!user || !user.uid) return;
      var uid = String(user.uid);
      var email = user.email ? String(user.email) : '';
      new Ref(splitPath('users/' + uid + '/username')).once('value').then(function (snap) {
        var username = snap.val();
        if (!username || typeof username !== 'string') return null;
        username = username.trim().toLowerCase().replace(/^@+/, '').replace(/\s+/g, '');
        if (username.length < 3 || username.length > 30) return null;
        return new Ref(splitPath('users/' + uid + '/usernameIsFallback')).once('value').then(function (fb) {
          if (fb.val() === true) return null; // temporal: no se indexa
          return new Ref(splitPath('usernames/' + username)).transaction(function (cur) {
            return (cur === null || cur === uid) ? uid : undefined;
          });
        });
      }).then(function (claim) {
        if (claim && claim.committed && email) {
          return new Ref(splitPath('users/' + uid + '/email')).set(email).catch(function () {});
        }
        return null;
      }).catch(function () { /* silencioso */ });
    } catch (e) { /* nunca bloquear el login */ }
  }

  function establishSession(cognitoUser, session) {
    currentCognitoUser = cognitoUser;
    restoreSeq++;
    return new Promise(function (resolve) {
      // Los atributos enriquecen el usuario, pero una sesión válida no debe
      // morir si esta llamada falla o se cuelga (sin red al abrir la app):
      // se usan los datos del ID token como respaldo.
      var tokenAttrs = attrsFromIdToken(session);
      var finished = false;
      function finish(useAttrs, usedFallback) {
        if (finished) return;
        finished = true;
        if (usedFallback) {
          try { console.warn('[DrexCloud] getUserAttributes no disponible; sesión establecida con datos del token.'); } catch (_) {}
        }
        authInstance.currentUser = makeCurrentUser(cognitoUser, useAttrs || []);
        // Reparación no bloqueante del índice de login por username
        // (cuentas creadas antes de esa función). Corre en segundo plano;
        // el login no espera ni depende de ella.
        try { setTimeout(function () { ensureUsernameLoginIndex(authInstance.currentUser); }, 0); } catch (_) {}
        var credPromise = promiseTimeout(Promise.resolve().then(function () {
          return configureAwsCredentials(session.getIdToken());
        }), 15000, 'aws-creds-timeout');
        credPromise.then(function () {
          scheduleTokenRefresh(cognitoUser, session);
          clearSessionExpiredFlag();
          setRestorePending(false);
          notifyAuthListeners();
          resolve(authInstance.currentUser);
        }, function (credErr) {
          // Sesión válida aunque las credenciales AWS fallen o tarden:
          // se reintentan al usar la BD.
          _awsCredentials = null;
          scheduleTokenRefresh(cognitoUser, session);
          clearSessionExpiredFlag();
          setRestorePending(false);
          notifyAuthListeners();
          resolve(authInstance.currentUser);
        });
      }
      var attrTimer = setTimeout(function () { finish(tokenAttrs, true); }, 10000);
      try {
        cognitoUser.getUserAttributes(function (err, attrs) {
          clearTimeout(attrTimer);
          var ok = (!err && attrs && attrs.length);
          finish(ok ? attrs : tokenAttrs, !ok);
        });
      } catch (e) {
        clearTimeout(attrTimer);
        finish(tokenAttrs, true);
      }
    });
  }

  function signInWithEmailAndPassword(email, password) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var cleanEmail = String(email).trim();
    var lowerEmail = cleanEmail.toLowerCase();
    // Cognito distingue mayúsculas/minúsculas en el nombre de usuario: si el
    // correo se escribió con distintas mayúsculas que en el registro, el
    // primer intento devuelve "no autorizado" y la app lo mostraba como
    // "contraseña incorrecta". Se reintenta una vez en minúsculas antes de
    // reportar el error, sin cambiar el comportamiento de cuentas existentes.
    return attemptSignIn(cleanEmail).catch(function (err) {
      var wrongPw = err && (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential' || err.code === 'auth/invalid-login-credentials');
      if (wrongPw && lowerEmail !== cleanEmail) return attemptSignIn(lowerEmail);
      throw err;
    });
    function attemptSignIn(em) {
      var cognitoUser = new C.CognitoUser({ Username: em, Pool: getUserPool() });
      var authDetails = new C.AuthenticationDetails({ Username: em, Password: String(password) });
      // FIX 2026-09-18: authenticateUser no tenía timeout. Si el endpoint de
      // Cognito se colgaba, el botón se quedaba en "Iniciando..." para
      // siempre sin mostrar ningún error. Ahora falla a los 30 s con mensaje
      // de conexión.
      return promiseTimeout(new Promise(function (resolve, reject) {
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
              need.email = em;
              reject(need);
              return;
            }
            reject(mapAuthError(err));
          },
          newPasswordRequired: function () {
            reject(Object.assign(new Error('Debes restablecer tu contraseña.'), { code: 'auth/password-reset-required' }));
          }
        });
      }), 30000, 'auth-timeout').catch(function (err) {
        // El timeout se reporta como error de red para que la UI muestre
        // "Error de conexión. Revisa tu internet." en vez de un error genérico.
        if (err && err.message === 'auth-timeout') {
          var t = new Error('Tiempo de espera agotado. Revisa tu conexión.');
          t.code = 'auth/network-request-failed';
          throw t;
        }
        throw err;
      });
    }
  }

  // Inicio de sesión con nombre de usuario (2026-09-20).
  // El User Pool solo acepta el correo como identificador (los aliases son
  // inmutables del pool), así que la autenticación ocurre en el servidor:
  // la Lambda drex-username-resolve normaliza el username, lo resuelve a
  // email en DynamoDB y autentica con Cognito (ADMIN_NO_SRP_AUTH),
  // devolviendo SOLO los tokens. El correo jamás sale del servidor y los
  // errores son genéricos (sin enumeración de cuentas).
  // Aquí se reconstruye la sesión de Cognito con esos tokens para que todo
  // lo demás (refresh, credenciales AWS, listeners) funcione igual que con
  // el login por correo.
  function signInWithUsernameAndPassword(username, password) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var url = (AWS_CONFIG.usernameLoginUrl || '').replace(/\/$/, '');
    if (!url) {
      var nc = new Error('Error de conexión. Revisa tu internet.');
      nc.code = 'auth/network-request-failed';
      return Promise.reject(nc);
    }
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (_) {} }, 20000);
    function clearTimer() { try { clearTimeout(timer); } catch (_) {} }
    var fetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: String(username || ''), password: String(password || '') })
    };
    if (ctrl) fetchOpts.signal = ctrl.signal;
    return promiseTimeout(fetch(url, fetchOpts).then(function (resp) {
      clearTimer();
      if (resp.status === 429) {
        var e429 = new Error('Demasiados intentos. Inténtalo de nuevo en un minuto.');
        e429.code = 'auth/too-many-requests';
        throw e429;
      }
      if (resp.status === 403) {
        return resp.json().then(function (data) {
          var code = (data && data.error) || '';
          if (code === 'unconfirmed') {
            // Sin correo conocido (el servidor no lo revela): la app pide
            // al usuario iniciar sesión con su correo para verificarla.
            var need = new Error('Tu cuenta aún no está verificada. Inicia sesión con tu correo electrónico para verificarla.');
            need.code = 'auth/needs-confirmation';
            throw need;
          }
          var rst = new Error('Debes restablecer tu contraseña.');
          rst.code = 'auth/password-reset-required';
          throw rst;
        });
      }
      if (!resp.ok) {
        throw Object.assign(new Error('Nombre de usuario o contraseña incorrectos.'), { code: 'auth/invalid-credential' });
      }
      return resp.json();
    }).then(function (data) {
      var t = (data && data.tokens) || {};
      if (!t.idToken || !t.accessToken || !t.refreshToken) {
        throw Object.assign(new Error('Error de conexión. Revisa tu internet.'), { code: 'auth/network-request-failed' });
      }
      // El username de Cognito es el correo: se lee del claim `email` del
      // ID token (respaldo: `cognito:username`). El servidor nunca lo envía.
      var claims = null;
      try {
        var parts = String(t.idToken).split('.');
        if (parts.length >= 2) claims = JSON.parse(base64UrlDecode(parts[1]));
      } catch (e) { claims = null; }
      var cognitoUsername = (claims && (claims.email || claims['cognito:username'])) || '';
      if (!cognitoUsername) {
        throw Object.assign(new Error('Error de conexión. Revisa tu internet.'), { code: 'auth/network-request-failed' });
      }
      var session = new C.CognitoUserSession({
        IdToken: new C.CognitoIdToken({ IdToken: t.idToken }),
        AccessToken: new C.CognitoAccessToken({ AccessToken: t.accessToken }),
        RefreshToken: new C.CognitoRefreshToken({ RefreshToken: t.refreshToken })
      });
      if (!session.isValid()) {
        throw Object.assign(new Error('Nombre de usuario o contraseña incorrectos.'), { code: 'auth/invalid-credential' });
      }
      var cognitoUser = new C.CognitoUser({ Username: cognitoUsername, Pool: getUserPool() });
      cognitoUser.setSignInUserSession(session);
      return establishSession(cognitoUser, session).then(function (user) {
        return { user: user };
      });
    }).catch(function (err) {
      clearTimer();
      if (err && err.name === 'AbortError') {
        var te = new Error('Tiempo de espera agotado. Revisa tu conexión.');
        te.code = 'auth/network-request-failed';
        throw te;
      }
      throw err;
    }), 30000, 'auth-timeout').catch(function (err) {
      if (err && err.message === 'auth-timeout') {
        var t2 = new Error('Tiempo de espera agotado. Revisa tu conexión.');
        t2.code = 'auth/network-request-failed';
        throw t2;
      }
      throw err;
    });
  }

  function createUserWithEmailAndPassword(email, password) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    // El correo se guarda en minúsculas: Cognito distingue mayúsculas en el
    // nombre de usuario y Gmail (y la mayoría de proveedores) no.
    var cleanEmail = String(email).trim().toLowerCase();
    var attrs = [new C.CognitoUserAttribute({ Name: 'email', Value: cleanEmail })];
    return new Promise(function (resolve, reject) {
      getUserPool().signUp(cleanEmail, String(password), attrs, null, function (err, result) {
        if (err) { reject(mapAuthError(err)); return; }
        if (result && result.userConfirmed) {
          // Autoconfirmado: entrar de inmediato
          signInWithEmailAndPassword(cleanEmail, String(password)).then(resolve, reject);
        } else {
          // El User Pool no debería exigir verificación (está desactivada),
          // pero si algún día vuelve a exigirla, la app muestra un error.
          resolve({ user: null, needsConfirmation: true, email: cleanEmail });
        }
      });
    });
  }

  // Registro tolerante a registros abandonados: si el correo ya existe en
  // Cognito pero la cuenta sigue SIN confirmar (el usuario abandonó el
  // registro en la pantalla del código, cerró la app o el código venció),
  // reenvía el código de verificación y retoma el registro en vez de
  // mostrar "correo ya registrado". Solo si la cuenta ya está confirmada
  // se conserva el error auth/email-already-in-use (ahí sí pertenece a
  // otra cuenta y corresponde iniciar sesión / recuperar contraseña).
  // Resuelve igual que createUserWithEmailAndPassword, con `resumed: true`
  // cuando se retomó un registro previo sin confirmar.
  function signUpOrResendConfirmation(email, password) {
    return createUserWithEmailAndPassword(email, password).catch(function (err) {
      if (!err || err.code !== 'auth/email-already-in-use') throw err;
      var C = cognitoLib();
      if (!C) throw err;
      var cleanEmail = String(email).trim().toLowerCase();
      var cognitoUser = new C.CognitoUser({ Username: cleanEmail, Pool: getUserPool() });
      return new Promise(function (resolve, reject) {
        cognitoUser.resendConfirmationCode(function (rerr) {
          if (!rerr) {
            resolve({ user: null, needsConfirmation: true, email: cleanEmail, resumed: true });
            return;
          }
          // Cuenta ya confirmada: el correo pertenece a una cuenta existente.
          var msg = String((rerr && rerr.message) || '').toLowerCase();
          if (rerr.code === 'InvalidParameterException' || /already confirm/i.test(msg)) {
            reject(err);
            return;
          }
          reject(mapAuthError(rerr));
        });
      });
    });
  }

  // Confirma la cuenta con el código de 6 dígitos enviado al correo.
  // Resuelve con 'CONFIRMED' (o 'ALREADY_CONFIRMED' si ya estaba verificada).
  function confirmRegistration(email, code) {
    getAuth();
    var C = cognitoLib();
    if (!C) return Promise.reject(new Error('AmazonCognitoIdentity no cargado'));
    var cleanEmail = String(email).trim().toLowerCase();
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
    var cleanEmail = String(email).trim().toLowerCase();
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
    var cleanEmail = String(email).trim().toLowerCase();
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
    var cognitoUser = new C.CognitoUser({ Username: String(email).trim().toLowerCase(), Pool: getUserPool() });
    return new Promise(function (resolve, reject) {
      cognitoUser.confirmPassword(String(code).trim(), String(newPassword), {
        onSuccess: function () { resolve(); },
        onFailure: function (err) { reject(mapAuthError(err)); }
      });
    });
  }

  function signOutUser() {
    getAuth();
    restoreSeq++;
    setRestorePending(false);
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
    // FIX 2026-09-18: el fetch al token endpoint no tenía timeout. Si se
    // colgaba, el login social se quedaba en spinner eterno (se había
    // disparado drex:oauth-pending pero la promesa jamás se resolvía).
    return promiseTimeout(global.fetch('https://' + AWS_CONFIG.oauthDomain + '/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body
    }), 25000, 'oauth-token-timeout').then(function (resp) { return resp.json(); }).then(function (tok) {
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
  var SOCIAL_NAMES = { GoogleProvider: 'Google', FacebookProvider: 'Facebook', TwitterProvider: 'X (Twitter)' };
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
      if (!C) { setRestorePending(false); return; }
      var cu;
      try { cu = getUserPool().getCurrentUser(); } catch (e) { cu = null; }
      if (!cu) { setRestorePending(false); return; }
      var runId = ++restoreSeq;
      attemptRestore(cu, 0, runId);
    } catch (e) { setRestorePending(false); /* inicio sin sesión */ }
  }

  function attemptRestore(cu, attempt, runId) {
    if (runId !== restoreSeq) return; // un login manual o signOut tomó el control
    try {
      // FIX 2026-09-18: getSession no tenía timeout. Si la red se colgaba,
      // el callback jamás llegaba, restorePending quedaba en true y el
      // splash se quedaba visible para siempre ("app atorada en el logo").
      var _rsSettled = false;
      var _rsTimer = setTimeout(function () {
        if (_rsSettled || runId !== restoreSeq) return;
        _rsSettled = true;
        retryOrFail(cu, attempt, runId, 'network');
      }, 20000);
      cu.getSession(function (err, session) {
        if (_rsSettled) return;
        _rsSettled = true;
        clearTimeout(_rsTimer);
        if (runId !== restoreSeq) return;
        try { if (getAuth().currentUser) { setRestorePending(false); return; } } catch (e) {}
        if (!err && session && session.isValid()) {
          establishSession(cu, session).then(function () {
            setRestorePending(false);
          }, function () {
            retryOrFail(cu, attempt, runId, 'network');
          });
          return;
        }
        var msg = String((err && (err.message || '')) || '');
        var reason = (err && (err.code === 'NotAuthorizedException' || /not authorized/i.test(msg))) ? 'expired' : 'network';
        retryOrFail(cu, attempt, runId, reason);
      });
    } catch (e) {
      retryOrFail(cu, attempt, runId, 'network');
    }
  }

  function retryOrFail(cu, attempt, runId, reason) {
    if (runId !== restoreSeq) return;
    if (attempt < 1) {
      // Un reintento: la red del teléfono a veces aún no está lista al abrir la app.
      setTimeout(function () { attemptRestore(cu, attempt + 1, runId); }, 4000);
      return;
    }
    signalRestoreFailed(reason);
  }

  function signalRestoreFailed(reason) {
    setRestorePending(false);
    try { if (getAuth().currentUser) return; } catch (e) {}
    flagSessionExpired(reason);
    notifyAuthListeners();
  }

  // DrexCloud

  var databaseSingleton = null;

  // Llamadas a DrexTotpFunction (verificación del lado servidor).
  // El secreto nunca viaja al cliente: solo se envían códigos de 6 dígitos.
  function totpApi(path, body) {
    var base = (AWS_CONFIG.totpFunctionUrl || '').replace(/\/$/, '');
    if (!base) return Promise.reject(new Error('totp-not-configured'));
    // FIX 2026-09-18: timeout para no dejar la verificación 2FA colgada.
    return promiseTimeout(getAuth().getIdToken().then(function (jwt) {
      if (!jwt) throw new Error('totp-no-session');
      return fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
        body: JSON.stringify(body || {})
      }).then(function (res) {
        if (!res.ok) throw new Error('totp-http-' + res.status);
        return res.json();
      });
    }), 25000, 'totp-timeout');
  }
  function totpSetupStart() { return totpApi('/totp/setup/start', {}); }
  function totpSetupConfirm(code) { return totpApi('/totp/setup/confirm', { code: code }); }
  function totpVerify(code) { return totpApi('/totp/verify', { code: code }); }
  function totpDisable(code) { return totpApi('/totp/disable', { code: code }); }
  function totpBackupRegenerate(code) { return totpApi('/totp/backup/regenerate', { code: code }); }
  function totpConfigured() { return !!(AWS_CONFIG.totpFunctionUrl || '').trim(); }
  var totpApiNs = {
    configured: totpConfigured,
    setupStart: totpSetupStart,
    setupConfirm: totpSetupConfirm,
    verify: totpVerify,
    disable: totpDisable,
    backupRegenerate: totpBackupRegenerate
  };
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
    totp: totpApiNs,
    setFastPolling: setFastPolling
  };
  // ServerValue también directo sobre DrexCloud.database (sin llamar),
  // porque el código migrado usa DrexCloud.database.ServerValue.TIMESTAMP
  DrexCloud.database.ServerValue = DrexCloud.database().ServerValue;

  // Clases de proveedor para `new DrexCloud.auth.GoogleProvider()` etc.
  function makeProvider(socialName) {
    var P = function () { this._socialName = socialName; };
    return P;
  }
  DrexCloud.auth.GoogleProvider = makeProvider('Google');
  DrexCloud.auth.FacebookProvider = makeProvider('Facebook');
  DrexCloud.auth.TwitterProvider = makeProvider('X (Twitter)');

  // La app lo usa para no mostrar el login mientras la sesión se restaura.
  DrexCloud.authRestorePending = function () { return restorePending; };

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
