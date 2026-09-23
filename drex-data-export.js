/* ============================================================
   DrexDataExport — "Descargar mis datos" como flujo asíncrono estilo Meta
   ----------------------------------------------------------------------------
   Solicitar → bottom sheet de confirmación ("Solicitud recibida. Estamos
   preparando tu archivo.") → en preparación EN EL SERVIDOR (sobrevive al
   cierre de la pestaña: de unos minutos a unos días, mensaje honesto) →
   listo → notificación in-app + botón descargar (URL pre-firmada S3).

   El ensamblaje YA NO ocurre en el navegador. El cliente solo:
     1. POST /request  -> crea el job en el backend (Lambda drex-data-export)
     2. polling del estado leyendo el job en DynamoDB (ruta sin cambios)
     3. POST /download-url -> URL pre-firmada de 15 min -> descarga directa

   Mapa de datos: docs/DATA-SCHEMA.md (38 categorías -> 27 secciones).
   Backend: docs/EXPORT-BACKEND-DESIGN.md · Lambda: lambda-drex-data-export/

   EXCLUSIONES DE PRIVACIDAD (las aplica el servidor; se documentan aquí):
     - pushSubscriptions: categoría excluida por completo.
     - recoveryCodes.hashes: solo metadata (generatedAt, usedCount).
     - twoFactorSecret / twoFactorBackupCodes (legacy): exclusión total.
     - parentalLinkCodes activos: secretos de un solo uso.
     - Tokens de Cognito: nunca se leen ni se envían (solo el access token
       como credencial Bearer del request, jamás dentro del snapshot).
     - Datos de otros usuarios, infraestructura, transitorio, musicAudio.

   API pública (window.DrexDataExport) — SIN CAMBIOS:
     requestExport({format:'json'|'html'}) -> Promise<{job, alreadyActive}>
     getJobs()        -> Promise<job[]> (marca expirados de 7+ días)
     getJob(jobId)    -> Promise<job|null>
     retryExport(jobId)   -> Promise<{job, alreadyActive}> (failed/expirado -> nuevo request)
     cancelExport(jobId)  -> Promise<job>  (NUEVO: cancela un job atorado/activo)
     downloadExport(jobId) -> Promise<{filename, bytes}>
     renderInto(el)   -> monta la UI dentro de <div id="drex-data-export">
     onExportReady(fn) -> suscripción al hook "exportación lista"
     t / _internals / _setDeps / _resetDeps -> i18n y testabilidad

   Configuración del backend:
     - window.DREX_EXPORT_BACKEND_URL (o dep backendUrl): URL de la Function
       URL de la Lambda drex-data-export. Sin esto, requestExport rechaza
       con 'export/backend-unconfigured'.
   ============================================================ */
(function (global) {
  'use strict';

  var root = (typeof window !== 'undefined') ? window : global;

  /* ---------------- i18n (tabla propia en/es/zh; el PT cae a es) ---------------- */
  var STRINGS = {
    // UI principal
    title: { en: 'Download your data', es: 'Descargar mis datos', zh: '下载我的数据' },
    intro: {
      en: 'Request a copy of everything Drex has about you. We prepare it in the background (usually from a few minutes to a few days) and notify you when it is ready.',
      es: 'Solicita una copia de todo lo que Drex tiene sobre ti. La preparamos en segundo plano (normalmente de unos minutos a unos días) y te avisamos cuando esté lista.',
      zh: '申请一份 Drex 关于你的全部数据的副本。我们会在后台准备（通常需要几分钟到几天），准备好后通知你。'
    },
    formatLabel: { en: 'Format', es: 'Formato', zh: '格式' },
    formatJsonDesc: { en: 'Complete data (JSON)', es: 'Datos completos (JSON)', zh: '完整数据 (JSON)' },
    formatHtmlDesc: { en: 'Readable report (HTML)', es: 'Informe legible (HTML)', zh: '可读报告 (HTML)' },
    requestBtn: { en: 'Request my data', es: 'Solicitar mis datos', zh: '申请我的数据' },
    requesting: { en: 'Requesting…', es: 'Solicitando…', zh: '申请中…' },
    activeExport: { en: 'Current request', es: 'Solicitud actual', zh: '当前申请' },
    history: { en: 'Request history', es: 'Historial de solicitudes', zh: '申请历史' },
    noHistory: { en: 'No requests yet.', es: 'Aún no hay solicitudes.', zh: '暂无申请记录。' },
    downloadBtn: { en: 'Download', es: 'Descargar', zh: '下载' },
    retryBtn: { en: 'Retry', es: 'Reintentar', zh: '重试' },
    cancelBtn: { en: 'Cancel', es: 'Cancelar', zh: '取消' },
    requestAgainBtn: { en: 'Request again', es: 'Solicitar de nuevo', zh: '重新申请' },
    preparing: { en: 'Preparing…', es: 'En preparación…', zh: '准备中…' },
    requested: { en: 'Requested', es: 'Solicitada', zh: '已申请' },
    ready: { en: 'Ready', es: 'Lista', zh: '已就绪' },
    downloaded: { en: 'Downloaded', es: 'Descargada', zh: '已下载' },
    failed: { en: 'Failed', es: 'Falló', zh: '失败' },
    expired: { en: 'Expired', es: 'Expirada', zh: '已过期' },
    expiredNote: {
      en: 'This file expired after 7 days. Request it again to get a fresh copy.',
      es: 'Este archivo expiró después de 7 días. Solicítalo de nuevo para obtener una copia actualizada.',
      zh: '该文件已在 7 天后过期。请重新申请以获取最新副本。'
    },
    partialNote: {
      en: 'Some sections could not be read and were skipped. The rest is complete.',
      es: 'Algunas secciones no pudieron leerse y se omitieron. El resto está completo.',
      zh: '部分内容无法读取，已跳过。其余内容完整。'
    },
    stuckNote: {
      en: 'This request seems stuck (no progress for over 15 minutes). You can cancel it and try again — nothing was lost.',
      es: 'Esta solicitud parece atorada (sin progreso por más de 15 minutos). Puedes cancelarla e intentarlo de nuevo — no se perdió nada.',
      zh: '此申请似乎卡住了（超过 15 分钟没有进展）。你可以取消并重试——不会丢失任何内容。'
    },
    cancelledNote: {
      en: 'Request cancelled.',
      es: 'Solicitud cancelada.',
      zh: '已取消申请。'
    },
    limitsTitle: { en: 'About this file', es: 'Sobre este archivo', zh: '关于此文件' },
    limitsBody: {
      en: 'Large sections include the most recent items (for example, the latest 200 posts or 100 notifications) to keep the file usable. Media files list their links; audio/video binaries are not embedded.',
      es: 'Las secciones grandes incluyen los elementos más recientes (por ejemplo, las últimas 200 publicaciones o 100 notificaciones) para que el archivo sea manejable. Los archivos multimedia listan sus enlaces; el audio/video binario no se incrusta.',
      zh: '较大的部分仅包含最近的项目（例如最近 200 条帖子或 100 条通知），以保持文件可用。媒体文件仅列出链接；不嵌入音视频二进制文件。'
    },
    privacyNote: {
      en: 'Only your data. Secrets (passwords, 2FA codes, push keys) and other people\u2019s data are never included.',
      es: 'Solo tus datos. Los secretos (contraseñas, códigos 2FA, claves push) y los datos de otras personas nunca se incluyen.',
      zh: '仅包含你的数据。绝不包含密钥（密码、双重验证代码、推送密钥）和其他人的数据。'
    },
    needLogin: {
      en: 'Sign in to request your data.',
      es: 'Inicia sesión para solicitar tus datos.',
      zh: '请先登录以申请你的数据。'
    },
    alreadyActive: {
      en: 'You already have a request in progress.',
      es: 'Ya tienes una solicitud en curso.',
      zh: '你已有一个进行中的申请。'
    },
    requestFailed: {
      en: 'Could not create the request. Check your connection and try again.',
      es: 'No se pudo crear la solicitud. Revisa tu conexión e inténtalo de nuevo.',
      zh: '无法创建申请。请检查网络后重试。'
    },
    backendUnconfigured: {
      en: 'The data export service is not configured yet. Try again later.',
      es: 'El servicio de exportación aún no está configurado. Inténtalo más tarde.',
      zh: '数据导出服务尚未配置。请稍后再试。'
    },
    authExpired: {
      en: 'Your session expired. Sign in again to continue.',
      es: 'Tu sesión venció. Inicia sesión de nuevo para continuar.',
      zh: '你的会话已过期。请重新登录以继续。'
    },
    downloadFailed: {
      en: 'Could not download the file. Try again.',
      es: 'No se pudo descargar el archivo. Inténtalo de nuevo.',
      zh: '无法下载文件。请重试。'
    },
    shaMismatch: {
      en: 'The downloaded file failed the integrity check. Try again.',
      es: 'El archivo descargado no pasó la verificación de integridad. Inténtalo de nuevo.',
      zh: '下载的文件未通过完整性校验。请重试。'
    },
    notReady: {
      en: 'Your file is still being prepared. We will notify you when it is ready.',
      es: 'Tu archivo aún se está preparando. Te avisaremos cuando esté listo.',
      zh: '你的文件仍在准备中。准备好后我们会通知你。'
    },
    // Bottom sheet de confirmación
    sheetTitle: { en: 'Request received', es: 'Solicitud recibida', zh: '已收到申请' },
    sheetBody: {
      en: 'We are preparing your file on our servers. It usually takes from a few minutes to a few days — we will notify you here in Drex when it is ready to download. You can close the app; nothing will be lost.',
      es: 'Estamos preparando tu archivo en nuestros servidores. Suele tomar de unos minutos a unos días — te avisaremos aquí en Drex cuando esté listo para descargar. Puedes cerrar la app; no se perderá nada.',
      zh: '我们正在服务器上准备你的文件。通常需要几分钟到几天——准备好后我们会在 Drex 内通知你下载。你可以关闭应用；不会丢失任何内容。'
    },
    sheetOk: { en: 'Got it', es: 'Entendido', zh: '知道了' },
    // Etiquetas de formato en historial
    fmtJson: { en: 'JSON', es: 'JSON', zh: 'JSON' },
    fmtHtml: { en: 'HTML', es: 'HTML', zh: 'HTML' },
    sectionsOk: { en: 'sections', es: 'secciones', zh: '个部分' },
    sectionsSkipped: { en: 'skipped', es: 'omitidas', zh: '已跳过' }
  };

  function detectLang() {
    try {
      if (typeof global.getAppLanguage === 'function') {
        var l = global.getAppLanguage();
        if (l === 'en' || l === 'zh' || l === 'es') return l;
      }
      var stored = null;
      if (global.localStorage) {
        stored = global.localStorage.getItem('drex_app_language_v1') || global.localStorage.getItem('selectedLanguage');
      }
      if (stored === 'en' || stored === 'zh') return stored;
    } catch (_) {}
    return 'es';
  }

  function t(key) {
    var entry = STRINGS[key];
    if (!entry) return key;
    var lang = detectLang();
    return entry[lang] || entry.es;
  }

  /* ---------------- dependencias inyectables (tests) ---------------- */
  var defaultDeps = {
    db: function () { return global.DrexCloud.database(); },
    auth: function () { return global.DrexCloud.auth(); },
    storage: function () { return global.localStorage; },
    sheet: function () { return global.DrexSheet || null; },
    now: function () { return Date.now(); },
    backendUrl: '',
    fetchFn: function () { return (typeof global.fetch === 'function') ? global.fetch : null; },
    pollMs: 60000, // intervalo de polling del estado; inyectable en tests
    // Access token de Cognito para autenticar los requests al backend.
    sessionToken: function () {
      return new Promise(function (resolve, reject) {
        try {
          var user = currentUser();
          var cu = user && user._cognitoUser;
          if (!cu || typeof cu.getSession !== 'function') {
            return reject(new Error('auth/no-session'));
          }
          cu.getSession(function (err, session) {
            if (err || !session) return reject(err || new Error('auth/no-session'));
            try {
              var at = session.getAccessToken();
              var jwt = (at && typeof at.getJwtToken === 'function') ? at.getJwtToken() : String(at || '');
              if (!jwt) return reject(new Error('auth/no-token'));
              resolve(jwt);
            } catch (e) { reject(e); }
          });
        } catch (e) { reject(e); }
      });
    }
  };
  var deps = defaultDeps;
  function D() { return deps; }

  function currentUser() {
    try {
      var a = D().auth();
      return (a && a.currentUser) || null;
    } catch (_) { return null; }
  }

  function backendUrl() {
    var d = D();
    if (d.backendUrl) return d.backendUrl;
    try { if (global.DREX_EXPORT_BACKEND_URL) return global.DREX_EXPORT_BACKEND_URL; } catch (_) {}
    return '';
  }

  /* ---------------- utilidades ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function iso(ts) { try { return new Date(ts).toISOString(); } catch (_) { return ''; } }
  function fileDate(ts) { return iso(ts).slice(0, 10); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function readOnce(path, queryFn) {
    var ref = D().db().ref(path);
    if (typeof queryFn === 'function') ref = queryFn(ref);
    return ref.once('value').then(function (snap) {
      if (!snap || typeof snap.val !== 'function') return null;
      var v = snap.val();
      return (v === undefined) ? null : v;
    });
  }
  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; reject(new Error('timeout:' + (label || 'read'))); }
      }, ms);
      Promise.resolve(promise).then(function (v) {
        if (!done) { done = true; clearTimeout(timer); resolve(v); }
      }, function (e) {
        if (!done) { done = true; clearTimeout(timer); reject(e); }
      });
    });
  }

  /* -------- defensa en profundidad: nada que huela a secreto viaja al servidor --------
     Se aplica al browserSnapshot ANTES de enviarlo. Lista cerrada de
     nombres de llave (coincidencia exacta, insensible a mayúsculas). */
  var FORBIDDEN_KEYS = [
    'twofactorsecret', 'twofactorbackupcodes',
    'hashes',
    'endpoint', 'p256dh',
    'auth', 'token', 'idtoken', 'accesstoken', 'refreshtoken',
    'password', 'secret', 'privatekey'
  ];
  function stripSecretsDeep(node) {
    if (node == null) return node;
    if (typeof node === 'string') {
      if (node.length > 200000) return '[valor muy largo omitido por privacidad]';
      if (/^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(node)) return '[token omitido]';
      return node;
    }
    if (Array.isArray(node)) return node.map(stripSecretsDeep);
    if (isObj(node)) {
      var out = {};
      Object.keys(node).forEach(function (k) {
        if (FORBIDDEN_KEYS.indexOf(String(k).toLowerCase()) !== -1) return;
        out[k] = stripSecretsDeep(node[k]);
      });
      return out;
    }
    return node;
  }

  /* -------- exclusiones documentadas (las aplica el servidor; se muestran aquí) -------- */
  var EXCLUDED = [
    { id: 'pushSubscriptions', reasonKey: 'exPush' },
    { id: 'twoFactorSecret / twoFactorBackupCodes', reasonKey: 'ex2fa' },
    { id: 'recoveryCodes.hashes', reasonKey: 'exHashes' },
    { id: 'parentalLinkCodes (activos)', reasonKey: 'exParental' },
    { id: 'tokens de Cognito (localStorage)', reasonKey: 'exTokens' },
    { id: 'datos de otros usuarios', reasonKey: 'exOthers' },
    { id: 'calificaciones que diste', reasonKey: 'exGivenRatings' },
    { id: 'correctionHelpful / solicitudes enviadas', reasonKey: 'exNoIndex' },
    { id: 'ratelimit, userCount, revokeOtherSessions, usernames/', reasonKey: 'exInfra' },
    { id: 'typing, userPresence, fiestaReactions, flags de UI', reasonKey: 'exTransient' },
    { id: 'musicAudio (binario)', reasonKey: 'exAudio' }
  ];
  var EXCLUDED_STRINGS = {
    exPush: { en: 'Push endpoints and keys are credentials: the whole category is excluded.', es: 'Los endpoints y claves push son credenciales: la categoría se excluye por completo.', zh: '推送端点和密钥属于凭据：整个类别均被排除。' },
    ex2fa: { en: 'Legacy 2FA secrets are never exported.', es: 'Los secretos 2FA legacy nunca se exportan.', zh: '旧版双重验证密钥永不导出。' },
    exHashes: { en: 'Only metadata (generatedAt, usedCount); hashes are equivalent to credentials.', es: 'Solo metadata (generatedAt, usedCount); los hashes equivalen a credenciales.', zh: '仅包含元数据（生成时间、已使用次数）；哈希等同于凭据。' },
    exParental: { en: 'Active link codes are single-use secrets; only used/expired metadata.', es: 'Los códigos de enlace activos son secretos de un solo uso; solo metadata de usados/vencidos.', zh: '有效的关联代码是一次性密钥；仅包含已使用/已过期的元数据。' },
    exTokens: { en: 'Cognito session tokens stored in the browser are never read.', es: 'Los tokens de sesión de Cognito en el navegador nunca se leen.', zh: '绝不读取浏览器中存储的 Cognito 会话令牌。' },
    exOthers: { en: 'Only your data: other users\u2019 profiles, posts and comments are excluded.', es: 'Solo tus datos: se excluyen perfiles, publicaciones y comentarios de otros.', zh: '仅包含你的数据：不包含其他用户的个人资料、帖子和评论。' },
    exGivenRatings: { en: 'Ratings you gave live under other users\u2019 profiles and cannot be listed without scanning them.', es: 'Las calificaciones que diste viven en perfiles ajenos y no se pueden listar sin barrerlos.', zh: '你给出的评分存储在其他用户的资料下，无法列出。' },
    exNoIndex: { en: 'Stored under global keys with no per-user index; listing them would require scanning shared tables.', es: 'Guardados bajo llaves globales sin índice por usuario; listarlos exigiría barrer tablas compartidas.', zh: '存储在没有按用户索引的全局键下；列出它们需要扫描共享表。' },
    exInfra: { en: 'Rate limits, counters and internal indexes are infrastructure, not your data.', es: 'Límites, contadores e índices internos son infraestructura, no tus datos.', zh: '限流、计数器和内部索引属于基础设施，不是你的数据。' },
    exTransient: { en: 'Typing indicators, presence, live reactions and UI flags are ephemeral.', es: 'Indicadores de escritura, presencia, reacciones en vivo y flags de UI son efímeros.', zh: '输入指示、在线状态、直播互动和界面标记都是临时的。' },
    exAudio: { en: 'Audio binaries are heavy; the file lists your tracks\u2019 metadata and links.', es: 'El audio binario es pesado; el archivo lista la metadata y enlaces de tus pistas.', zh: '音频二进制文件较大；文件仅列出你的曲目的元数据和链接。' }
  };
  function excludedList() {
    return EXCLUDED.map(function (e) {
      var s = EXCLUDED_STRINGS[e.reasonKey] || {};
      var lang = detectLang();
      return { category: e.id, reason: s[lang] || s.es };
    });
  }

  /* -------- límites honestos por sección (los aplica el servidor; se muestran aquí) -------- */
  var LIMITS = [
    { section: 'posts', n: 200, noteKey: 'limPosts' },
    { section: 'comments', n: 500, noteKey: 'limComments' },
    { section: 'notifications', n: 100, noteKey: 'limNotifs' },
    { section: 'conversations', n: 50, noteKey: 'limConvs' },
    { section: 'messagesPerConversation', n: 50, noteKey: 'limMsgs' },
    { section: 'appeals_reports_exercises_fiestas_groups', n: 100, noteKey: 'limGlobal' }
  ];
  var LIMIT_STRINGS = {
    limPosts: { en: 'Latest 200 posts.', es: 'Últimas 200 publicaciones.', zh: '最近 200 条帖子。' },
    limComments: { en: 'Latest 500 comments from your personal index.', es: 'Últimos 500 comentarios de tu índice personal.', zh: '个人索引中最近的 500 条评论。' },
    limNotifs: { en: 'Latest 100 notifications.', es: 'Últimas 100 notificaciones.', zh: '最近 100 条通知。' },
    limConvs: { en: 'Latest 50 conversations.', es: 'Últimas 50 conversaciones.', zh: '最近 50 个会话。' },
    limMsgs: { en: 'Latest 50 messages per conversation.', es: 'Últimos 50 mensajes por conversación.', zh: '每个会话最近 50 条消息。' },
    limGlobal: { en: 'Latest 100 of each shared category that belong to you.', es: 'Últimos 100 de cada categoría compartida que te pertenecen.', zh: '属于你的每个共享类别的最近 100 条。' }
  };
  function limitsList() {
    return LIMITS.map(function (l) {
      var s = LIMIT_STRINGS[l.noteKey] || {};
      var lang = detectLang();
      return { section: l.section, limit: l.n, note: s[lang] || s.es };
    });
  }

  var TOTAL_SECTIONS = 27; // el servidor procesa 27 secciones (docs/DATA-SCHEMA.md)

  /* -------- snapshot del navegador (datos que solo viven localmente) --------
     Se captura EN EL MOMENTO de la solicitud y viaja al servidor (<=64 KB)
     para que también sobreviva al cierre de la pestaña. Allowlist estricta:
     jamás se leen llaves CognitoIdentityServiceProvider.* (tokens) ni
     sessionStorage. stripSecretsDeep como defensa en profundidad. */
  var SNAPSHOT_KEYS = [
    'drex_hidden_posts',
    'drex_music_history',
    'drex_translation_settings',
    'drex_app_language_v1',
    'selectedLanguage',
    'drex_allow_adult_content',
    'drex_last_login_method',
    'drex_chat_saved_messages_v1',
    'drex_notification_settings_v1',
    'drex_chat_privacy_settings_v1'
  ];
  var SNAPSHOT_BUDGET = 60 * 1024; // 60 KB (el servidor acepta hasta 64 KB)

  function captureBrowserSnapshot() {
    var snap = {};
    var used = 2;
    function tryAdd(k, v) {
      var s;
      try { s = JSON.stringify(v); } catch (_) { return; }
      if (s == null) return;
      if (used + s.length + k.length + 4 > SNAPSHOT_BUDGET) return;
      snap[k] = v;
      used += s.length + k.length + 4;
    }
    try {
      var st = D().storage();
      if (!st) return {};
      SNAPSHOT_KEYS.forEach(function (k) {
        var raw = null;
        try { raw = st.getItem(k); } catch (_) {}
        if (raw == null) return;
        var v;
        try { v = JSON.parse(raw); } catch (_) { v = raw; }
        tryAdd(k, v);
      });
      // Borradores de chat: drex_chat_draft_<roomId>
      var drafts = {};
      try {
        var n = 0;
        try { n = st.length || 0; } catch (_) {}
        for (var i = 0; i < n; i++) {
          var k = null;
          try { k = st.key(i); } catch (_) {}
          if (k && k.indexOf('drex_chat_draft_') === 0) {
            var raw2 = null;
            try { raw2 = st.getItem(k); } catch (_) {}
            if (raw2 == null) continue;
            try { drafts[k] = JSON.parse(raw2); } catch (_) { drafts[k] = raw2; }
          }
        }
      } catch (_) {}
      if (Object.keys(drafts).length) tryAdd('chatDrafts', drafts);
    } catch (_) {}
    return stripSecretsDeep(snap);
  }

  /* ---------------- llamadas al backend ---------------- */
  function apiRequest(action, body) {
    var url = backendUrl();
    if (!url) return Promise.reject(Object.assign(new Error('export/backend-unconfigured'), { code: 'export/backend-unconfigured' }));
    var fetchFn = null;
    try { fetchFn = D().fetchFn(); } catch (_) {}
    if (typeof fetchFn !== 'function') {
      return Promise.reject(Object.assign(new Error('export/no-fetch'), { code: 'export/no-fetch' }));
    }
    return D().sessionToken().then(function (tok) {
      var payload = Object.assign({ action: action }, body || {});
      return withTimeout(fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
        body: JSON.stringify(payload)
      }), 30000, 'export-api');
    }).then(function (res) {
      var dataP = Promise.resolve({});
      try {
        dataP = Promise.resolve(res.json()).catch(function () { return {}; });
      } catch (_) {}
      return dataP.then(function (data) {
        if (!res || !res.ok) {
          var code = (data && data.error) || ('http-' + (res && res.status));
          var err = new Error('export/' + code);
          err.code = 'export/' + code;
          err.status = res && res.status;
          throw err;
        }
        return data || {};
      });
    }).catch(function (e) {
      // 401 del backend = sesión vencida: mensaje accionable.
      if (e && (e.status === 401 || /invalid_token/.test(e.code || ''))) {
        var authErr = new Error('auth/expired');
        authErr.code = 'auth/expired';
        throw authErr;
      }
      throw e;
    });
  }

  /* ---------------- ciclo de vida del trabajo ---------------- */
  var JOB_TTL_MS = 7 * 24 * 3600 * 1000; // 7 días: expirado -> solicitar de nuevo
  var ACTIVE_STATUSES = ['requested', 'preparing'];
  var STUCK_MS = 15 * 60 * 1000; // sin heartbeat en 15 min -> atorado

  function jobBase(uid, jobId) { return 'users/' + uid + '/dataExports/' + jobId; }
  function isExpired(job) {
    if (!job || !job.createdAt) return false;
    return (D().now() - job.createdAt) > JOB_TTL_MS;
  }
  // Antídoto anti-atoro: el worker escribe lastHeartbeat con cada sección.
  // Si un job lleva >15 min en preparing/requested sin heartbeat, el cliente
  // ofrece cancelarlo y reintentarlo (el servidor también lo detecta).
  function isStuck(job) {
    if (!job) return false;
    if (ACTIVE_STATUSES.indexOf(job.status) === -1) return false;
    if (isExpired(job)) return false;
    var beat = job.lastHeartbeat || job.updatedAt || job.createdAt || 0;
    return (D().now() - beat) > STUCK_MS;
  }
  function writeJob(uid, jobId, job) {
    return D().db().ref(jobBase(uid, jobId)).set(job);
  }
  function patchJob(uid, jobId, patch) {
    patch.updatedAt = D().now();
    return D().db().ref(jobBase(uid, jobId)).update(patch);
  }

  var readyHooks = [];
  function fireReadyHooks(job) {
    readyHooks.slice().forEach(function (fn) {
      try { fn(job); } catch (_) {}
    });
  }

  function sortJobsDesc(jobs) {
    jobs.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    return jobs;
  }

  function getJobs() {
    var user = currentUser();
    if (!user) return Promise.reject(new Error('auth/no-user'));
    var uid = user.uid;
    return readOnce('users/' + uid + '/dataExports', function (r) {
      return r.orderByChild('createdAt');
    }).then(function (v) {
      var jobs = [];
      if (isObj(v)) Object.keys(v).forEach(function (k) {
        var j = v[k];
        if (isObj(j)) { j.id = j.id || k; jobs.push(j); }
      });
      sortJobsDesc(jobs);
      // Expiración: 7 días -> 'expired' (best-effort, no bloquea el listado).
      jobs.forEach(function (j) {
        if (j.status !== 'expired' && j.status !== 'downloaded' && isExpired(j)) {
          j.status = 'expired';
          patchJob(uid, j.id, { status: 'expired' }).catch(function () {});
        }
      });
      return jobs;
    });
  }

  function getJob(jobId) {
    var user = currentUser();
    if (!user) return Promise.reject(new Error('auth/no-user'));
    return D().db().ref(jobBase(user.uid, jobId)).once('value').then(function (snap) {
      var j = snap && typeof snap.val === 'function' ? snap.val() : null;
      if (!j) return null;
      j.id = j.id || jobId;
      if (j.status !== 'expired' && j.status !== 'downloaded' && isExpired(j)) {
        j.status = 'expired';
        patchJob(user.uid, j.id, { status: 'expired' }).catch(function () {});
      }
      return j;
    });
  }

  // El request va al backend: el servidor crea el job, lo prepara en
  // segundo plano (sobrevive al cierre de la pestaña) y notifica al
  // terminar. Idempotente: si ya hay un job activo, se devuelve ese.
  function requestExport(opts) {
    opts = opts || {};
    var format = (opts.format === 'html') ? 'html' : 'json';
    var user = currentUser();
    if (!user || !user.uid) return Promise.reject(new Error('auth/no-user'));
    if (!backendUrl()) {
      return Promise.reject(Object.assign(new Error('export/backend-unconfigured'), { code: 'export/backend-unconfigured' }));
    }
    var uid = user.uid;
    return getJobs().then(function (jobs) {
      var active = null;
      for (var i = 0; i < jobs.length; i++) {
        if (ACTIVE_STATUSES.indexOf(jobs[i].status) !== -1 && !isExpired(jobs[i])) { active = jobs[i]; break; }
      }
      if (active) return { job: active, alreadyActive: true };
      var snapshot = captureBrowserSnapshot();
      return apiRequest('request', { format: format, browserSnapshot: snapshot, lang: detectLang() })
        .then(function (data) {
          if (!data || !data.jobId) throw new Error('export/bad-response');
          showRequestSheet(format);
          var now = D().now();
          var job = {
            id: data.jobId, uid: uid, format: format,
            status: data.status || 'requested',
            createdAt: now, updatedAt: now, lastHeartbeat: now,
            progress: { done: 0, total: TOTAL_SECTIONS, current: null }
          };
          return { job: job, alreadyActive: !!data.alreadyActive };
        });
    });
  }

  function retryExport(jobId) {
    var user = currentUser();
    if (!user) return Promise.reject(new Error('auth/no-user'));
    return getJob(jobId).then(function (job) {
      if (!job) throw new Error('job/not-found');
      if (job.status !== 'failed' && job.status !== 'expired') throw new Error('job/not-retryable');
      // Reintentar = nueva solicitud al backend (el job fallido queda en el historial).
      return requestExport({ format: job.format === 'html' ? 'html' : 'json' });
    });
  }

  // Cancela un job activo (p. ej. atorado sin heartbeat). El worker, al
  // despertar, ve el estado y aborta sin escribir nada más.
  function cancelExport(jobId) {
    var user = currentUser();
    if (!user) return Promise.reject(new Error('auth/no-user'));
    var uid = user.uid;
    return getJob(jobId).then(function (job) {
      if (!job) throw new Error('job/not-found');
      if (ACTIVE_STATUSES.indexOf(job.status) === -1) throw new Error('job/not-cancellable');
      return patchJob(uid, jobId, {
        status: 'failed',
        error: { code: 'cancelled_by_user', message: 'cancelled_by_user' }
      }).then(function () {
        job.status = 'failed';
        job.error = { code: 'cancelled_by_user' };
        return job;
      });
    });
  }

  /* ---------------- informe HTML legible (paridad con el servidor) --------
     El archivo HTML lo genera el servidor; este builder se conserva para
     tests/paridad visual y queda expuesto en _internals. */
  var SECTION_TITLES = {
    account: { en: 'Account', es: 'Cuenta', zh: '账户' },
    profile: { en: 'Profile', es: 'Perfil', zh: '个人资料' },
    twoFactor: { en: 'Two-factor authentication', es: 'Verificación en dos pasos', zh: '双重验证' },
    interests: { en: 'Interest profile', es: 'Perfil de intereses', zh: '兴趣画像' },
    posts: { en: 'Posts', es: 'Publicaciones', zh: '帖子' },
    comments: { en: 'Comments', es: 'Comentarios', zh: '评论' },
    votes: { en: 'Votes', es: 'Votos', zh: '投票' },
    ecos: { en: 'Ecos', es: 'Ecos', zh: 'Ecos' },
    saved: { en: 'Saved', es: 'Guardados', zh: '收藏' },
    social: { en: 'Social connections', es: 'Conexiones sociales', zh: '社交关系' },
    ratings: { en: 'Ratings received', es: 'Calificaciones recibidas', zh: '收到的评分' },
    conversations: { en: 'Conversations', es: 'Conversaciones', zh: '会话' },
    notifications: { en: 'Notifications', es: 'Notificaciones', zh: '通知' },
    settings: { en: 'Settings', es: 'Ajustes', zh: '设置' },
    securityPrefs: { en: 'Security preferences', es: 'Preferencias de seguridad', zh: '安全偏好' },
    devices: { en: 'Devices', es: 'Dispositivos', zh: '设备' },
    loginHistory: { en: 'Login history', es: 'Historial de accesos', zh: '登录历史' },
    sessions: { en: 'Sessions', es: 'Sesiones', zh: '登录会话' },
    fiestas: { en: 'Fiestas', es: 'Fiestas', zh: '派对' },
    groups: { en: 'Groups', es: 'Grupos', zh: '群组' },
    music: { en: 'Music', es: 'Música', zh: '音乐' },
    languages: { en: 'Languages', es: 'Idiomas', zh: '语言' },
    appeals: { en: 'Appeals', es: 'Apelaciones', zh: '申诉' },
    moderationReports: { en: 'Moderation reports', es: 'Reportes de moderación', zh: '审核举报' },
    supportTickets: { en: 'Support tickets', es: 'Tickets de soporte', zh: '支持工单' },
    parental: { en: 'Parental supervision', es: 'Supervisión parental', zh: '家长监督' },
    browserData: { en: 'Browser data', es: 'Datos del navegador', zh: '浏览器数据' }
  };
  function sectionTitle(id) {
    var tt = SECTION_TITLES[id];
    if (!tt) return id;
    var lang = detectLang();
    return tt[lang] || tt.es;
  }

  function buildHtml(payload) {
    var lang = payload.language || 'es';
    var htmlLang = (lang === 'zh') ? 'zh' : (lang === 'en' ? 'en' : 'es');
    var docTitle = lang === 'en' ? 'My Drex data' : (lang === 'zh' ? '我的 Drex 数据' : 'Mis datos de Drex');
    var parts = [];
    parts.push('<!DOCTYPE html><html lang="' + htmlLang + '"><head><meta charset="utf-8">');
    parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
    parts.push('<title>' + esc(docTitle) + '</title>');
    parts.push('<style>' +
      'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#eef2f7;color:#1c2b4a;margin:0;padding:0}' +
      '.hdr{background:#1c2b4a;color:#fff;padding:32px 24px}' +
      '.hdr h1{margin:0 0 6px;font-size:26px}' +
      '.hdr .wave{color:#8fa2ff;font-weight:700}' +
      '.hdr p{margin:4px 0;opacity:.85;font-size:14px}' +
      '.wrap{max-width:860px;margin:0 auto;padding:20px 16px 60px}' +
      '.card{background:#fff;border-radius:14px;padding:18px 20px;margin:14px 0;box-shadow:0 1px 3px rgba(28,43,74,.08)}' +
      '.card h2{margin:0 0 8px;font-size:18px;color:#1c2b4a}' +
      '.meta{font-size:13px;color:#5c6974}' +
      '.badge{display:inline-block;font-size:12px;font-weight:700;border-radius:999px;padding:2px 10px;margin-left:8px}' +
      '.ok{background:#e6f6ec;color:#137333}.bad{background:#fdecea;color:#b3261e}' +
      'details{margin-top:10px}summary{cursor:pointer;color:#2F33B8;font-weight:600;font-size:14px}' +
      'pre{background:#f0f4f9;border-radius:10px;padding:12px;overflow:auto;font-size:12px;max-height:420px}' +
      'table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #dce1e5;padding:6px 8px;text-align:left;vertical-align:top}' +
      'th{background:#eef2f7}' +
      '.foot{font-size:12px;color:#5c6974;margin-top:26px}' +
      '</style></head><body>');
    parts.push('<div class="hdr"><h1><span class="wave">((•))</span> Drex — ' + esc(docTitle) + '</h1>' +
      '<p>' + esc(payload.generatedAt || '') + ' · ' + esc((payload.account && payload.account.email) || '') + '</p></div>');
    parts.push('<div class="wrap">');
    var s = payload.summary || {};
    var sumTitle = lang === 'en' ? 'Summary' : (lang === 'zh' ? '摘要' : 'Resumen');
    parts.push('<div class="card"><h2>' + esc(sumTitle) + '</h2>' +
      '<p class="meta">' + (s.sectionsOk || 0) + ' / ' + TOTAL_SECTIONS + ' ' + esc(t('sectionsOk')) +
      (s.sectionsFailed ? ' · <span class="badge bad">' + s.sectionsFailed + ' ' + esc(t('sectionsSkipped')) + '</span>' : ' <span class="badge ok">OK</span>') + '</p>' +
      '<p class="meta">' + esc(t('limitsBody')) + '</p></div>');
    Object.keys(payload.sections || {}).forEach(function (id) {
      var sec = payload.sections[id];
      var title = sectionTitle(id);
      var badge = sec.status === 'ok'
        ? '<span class="badge ok">' + sec.count + '</span>'
        : '<span class="badge bad">' + esc(t('failed')) + '</span>';
      parts.push('<div class="card"><h2>' + esc(title) + badge + '</h2>');
      if (sec.note) parts.push('<p class="meta">' + esc(sec.note) + '</p>');
      if (sec.error) parts.push('<p class="meta">Error: ' + esc(sec.error) + '</p>');
      if (sec.status === 'ok' && sec.data !== null && sec.data !== undefined) {
        var json = JSON.stringify(sec.data, null, 2);
        var shown = json.length > 60000 ? json.slice(0, 60000) + '\n…[truncado]' : json;
        parts.push('<details><summary>' + esc(lang === 'en' ? 'View data' : (lang === 'zh' ? '查看数据' : 'Ver datos')) + '</summary><pre>' + esc(shown) + '</pre></details>');
      }
      parts.push('</div>');
    });
    parts.push('<div class="card"><h2>' + esc(t('limitsTitle')) + '</h2><table><tr><th>' +
      esc(lang === 'en' ? 'Section' : (lang === 'zh' ? '部分' : 'Sección')) + '</th><th>' +
      esc(lang === 'en' ? 'Limit' : (lang === 'zh' ? '限制' : 'Límite')) + '</th><th>' +
      esc(lang === 'en' ? 'Note' : (lang === 'zh' ? '说明' : 'Nota')) + '</th></tr>');
    (payload.limits || []).forEach(function (l) {
      parts.push('<tr><td>' + esc(l.section) + '</td><td>' + esc(String(l.limit)) + '</td><td>' + esc(l.note) + '</td></tr>');
    });
    parts.push('</table></div>');
    parts.push('<div class="card"><h2>' + esc(t('privacyNote')) + '</h2><table><tr><th>' +
      esc(lang === 'en' ? 'Excluded' : (lang === 'zh' ? '已排除' : 'Excluido')) + '</th><th>' +
      esc(lang === 'en' ? 'Why' : (lang === 'zh' ? '原因' : 'Por qué')) + '</th></tr>');
    (payload.excluded || []).forEach(function (e) {
      parts.push('<tr><td><code>' + esc(e.category) + '</code></td><td>' + esc(e.reason) + '</td></tr>');
    });
    parts.push('</table></div>');
    parts.push('<p class="foot">Drex · ' + esc(docTitle) + ' · ' + esc(payload.jobId || '') + '</p>');
    parts.push('</div></body></html>');
    return parts.join('');
  }

  /* ---------------- descarga via URL pre-firmada ---------------- */
  function fetchFileBytes(url) {
    var fetchFn = null;
    try { fetchFn = D().fetchFn(); } catch (_) {}
    if (typeof fetchFn !== 'function') {
      return Promise.reject(Object.assign(new Error('export/no-fetch'), { code: 'export/no-fetch' }));
    }
    // La URL pre-firmada lleva su propia firma: NO se manda Authorization.
    return withTimeout(fetchFn(url, { method: 'GET' }), 120000, 'download')
      .then(function (res) {
        if (!res || !res.ok) throw new Error('export/download-http-' + (res && res.status));
        if (typeof res.arrayBuffer === 'function') return res.arrayBuffer();
        throw new Error('export/no-array-buffer');
      })
      .then(function (buf) {
        if (buf instanceof Uint8Array) return buf;
        return new Uint8Array(buf);
      });
  }

  function sha256Hex(bytes) {
    try {
      var sc = global.crypto && global.crypto.subtle;
      if (!sc) return Promise.resolve(null);
      return sc.digest('SHA-256', bytes).then(function (dig) {
        return Array.prototype.map.call(new Uint8Array(dig), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
      });
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  function triggerDownloadBytes(filename, bytes, mime) {
    var blob;
    if (typeof Blob !== 'undefined') {
      blob = new Blob([bytes], { type: mime });
    }
    var doc = (typeof document !== 'undefined') ? document : null;
    if (!doc || !blob) return false;
    var url = null;
    try {
      url = (global.URL && global.URL.createObjectURL) ? global.URL.createObjectURL(blob) : null;
    } catch (_) { url = null; }
    if (!url) return false;
    var a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    doc.body.appendChild(a);
    try { a.click(); } catch (_) {}
    setTimeout(function () {
      try { doc.body.removeChild(a); } catch (_) {}
      try { global.URL.revokeObjectURL(url); } catch (_) {}
    }, 4000);
    return true;
  }

  // Descarga el archivo ya preparado por el servidor. El navegador NO
  // re-ensambla nada: descarga los bytes tal cual, verifica sha256 y
  // marca el job como 'downloaded'.
  function downloadExport(jobId) {
    var user = currentUser();
    if (!user) return Promise.reject(new Error('auth/no-user'));
    return getJob(jobId).then(function (job) {
      if (!job) throw new Error('job/not-found');
      if (job.status === 'expired') throw new Error('job/expired');
      if (job.status !== 'ready' && job.status !== 'downloaded') throw new Error('job/not-ready');
      return apiRequest('download-url', { jobId: jobId }).then(function (data) {
        if (!data || !data.url) throw new Error('export/bad-response');
        return fetchFileBytes(data.url).then(function (bytes) {
          var isHtml = job.format === 'html';
          var ext = isHtml ? 'html' : 'json';
          var mime = isHtml ? 'text/html;charset=utf-8' : 'application/json;charset=utf-8';
          var filename = data.filename || ('drex-mis-datos-' + fileDate(D().now()) + '.' + ext);
          var verifyP = data.sha256
            ? sha256Hex(bytes).then(function (hex) {
                if (hex && hex !== String(data.sha256).toLowerCase()) {
                  var e = new Error('export/sha-mismatch');
                  e.code = 'export/sha-mismatch';
                  throw e;
                }
              })
            : Promise.resolve();
          return verifyP.then(function () {
            if (!triggerDownloadBytes(filename, bytes, mime)) throw new Error('export/download-unavailable');
            try {
              patchJob(user.uid, jobId, { status: 'downloaded', downloadedAt: D().now() }).catch(function () {});
            } catch (_) {}
            return { filename: filename, bytes: bytes.length };
          });
        });
      });
    });
  }

  /* ---------------- bottom sheet de confirmación ---------------- */
  function showRequestSheet(format) {
    var Sheet = null;
    try { Sheet = D().sheet(); } catch (_) {}
    if (!Sheet || typeof Sheet.open !== 'function') return;
    var bodyHtml =
      '<p style="margin:0 0 8px">' + esc(t('sheetBody')) + '</p>' +
      '<p style="margin:0;color:#5c6974;font-size:13px">' + esc(t('formatLabel')) + ': <b>' + esc(format === 'html' ? t('fmtHtml') : t('fmtJson')) + '</b></p>';
    try {
      Sheet.open({
        title: t('sheetTitle'),
        body: bodyHtml,
        actions: [{ id: 'ok', label: t('sheetOk'), primary: true }],
        onAction: function () { Sheet.close(); }
      });
    } catch (_) {}
  }

  /* ---------------- UI (misma pantalla, nuevo flujo) ---------------- */
  function statusLabel(status) {
    return t(status) || status;
  }
  function statusClass(status) {
    return status === 'ready' ? 'ready'
      : status === 'downloaded' ? 'downloaded'
      : status === 'failed' ? 'failed'
      : status === 'expired' ? 'expired'
      : (ACTIVE_STATUSES.indexOf(status) !== -1 ? 'preparing' : '');
  }

  var lastSeenStatus = {};
  function noteStatuses(jobs) {
    (jobs || []).forEach(function (j) {
      var prev = lastSeenStatus[j.id];
      if (prev && prev !== 'ready' && j.status === 'ready') fireReadyHooks(j);
      lastSeenStatus[j.id] = j.status;
    });
  }

  function jobCard(job) {
    var isHtml = job.format === 'html';
    var cls = statusClass(job.status);
    var expired = job.status === 'expired';
    var partial = job.status === 'ready' && job.summary && job.summary.sectionsFailed > 0;
    var prog = job.progress || {};
    var progTxt = (ACTIVE_STATUSES.indexOf(job.status) !== -1 && prog.total)
      ? ' · ' + (prog.done || 0) + '/' + prog.total + (prog.current ? ' · ' + esc(String(prog.current)) : '')
      : '';
    var stuck = isStuck(job);
    var html = '<div class="ddex-card" data-job="' + esc(job.id) + '">';
    html += '<div class="ddex-row"><b>' + esc(fileDate(job.createdAt)) + ' · ' + esc(isHtml ? t('fmtHtml') : t('fmtJson')) + '</b>';
    html += '<span class="ddex-status ' + cls + '">' + esc(statusLabel(job.status)) + progTxt + '</span></div>';
    if (stuck) {
      html += '<div class="ddex-note warn">' + esc(t('stuckNote')) + '</div>';
    }
    if (expired) html += '<div class="ddex-note">' + esc(t('expiredNote')) + '</div>';
    if (partial) html += '<div class="ddex-note">' + esc(t('partialNote')) + '</div>';
    if (job.error && job.error.code && job.status === 'failed' && !stuck) {
      html += '<div class="ddex-note">Error: ' + esc(String(job.error.code)) + '</div>';
    }
    html += '<div class="ddex-actions">';
    if (job.status === 'ready' || job.status === 'downloaded') {
      html += '<button class="ddex-btn primary" data-act="download" data-id="' + esc(job.id) + '">' + esc(t('downloadBtn')) + '</button>';
    }
    if (stuck) {
      html += '<button class="ddex-btn" data-act="cancel" data-id="' + esc(job.id) + '">' + esc(t('cancelBtn')) + '</button>';
    }
    if (job.status === 'failed' || expired) {
      html += '<button class="ddex-btn" data-act="retry" data-id="' + esc(job.id) + '">' + esc(t('requestAgainBtn')) + '</button>';
    }
    html += '</div></div>';
    return html;
  }

  function renderInto(el) {
    if (!el) return;
    var lang = detectLang();
    var state = { busy: false, error: null, notice: null };

    function css() {
      return '<style>' +
        '.ddex{font-family:inherit;color:inherit}' +
        '.ddex .ddex-intro{color:#5c6974;font-size:14px;margin:0 0 12px}' +
        '.ddex .ddex-fmt{display:flex;gap:8px;margin:0 0 12px}' +
        '.ddex .ddex-fmt label{flex:1;border:1.5px solid #dce1e5;border-radius:12px;padding:10px;cursor:pointer;font-size:13px}' +
        '.ddex .ddex-fmt input{margin-right:6px}' +
        '.ddex .ddex-cta{width:100%;padding:12px;border:0;border-radius:12px;background:#2F33B8;color:#fff;font-size:15px;font-weight:700;cursor:pointer}' +
        '.ddex .ddex-cta[disabled]{opacity:.5;cursor:wait}' +
        '.ddex .ddex-sec{margin:18px 0 8px;font-size:14px;font-weight:700}' +
        '.ddex .ddex-card{border:1px solid #e1e5ea;border-radius:12px;padding:12px;margin:8px 0;background:#fff}' +
        '.ddex .ddex-row{display:flex;justify-content:space-between;align-items:center;gap:8px}' +
        '.ddex .ddex-status{font-size:12px;font-weight:700;padding:2px 10px;border-radius:999px;background:#eef0f4;color:#444}' +
        '.ddex .ddex-status.preparing{background:#fff3cd;color:#8a6d00}' +
        '.ddex .ddex-status.ready{background:#e6f6ec;color:#137333}' +
        '.ddex .ddex-status.downloaded{background:#e8eaf6;color:#2F33B8}' +
        '.ddex .ddex-status.failed{background:#fdecea;color:#b3261e}' +
        '.ddex .ddex-status.expired{background:#f1f3f5;color:#868e96}' +
        '.ddex .ddex-note{font-size:13px;color:#5c6974;margin:8px 0 0}' +
        '.ddex .ddex-note.warn{color:#8a6d00;font-weight:700}' +
        '.ddex .ddex-actions{display:flex;gap:8px;margin-top:10px}' +
        '.ddex .ddex-btn{padding:8px 14px;border-radius:10px;border:1px solid #dce1e5;background:#fff;font-size:13px;font-weight:600;cursor:pointer}' +
        '.ddex .ddex-btn.primary{background:#2F33B8;border-color:#2F33B8;color:#fff}' +
        '.ddex .ddex-btn[disabled]{opacity:.5}' +
        '.ddex .ddex-empty{color:#868e96;font-size:13px}' +
        '.ddex .ddex-err{background:#fdecea;color:#b3261e;border-radius:10px;padding:10px;font-size:13px;margin:0 0 10px}' +
        '.ddex .ddex-ok{background:#e6f6ec;color:#137333;border-radius:10px;padding:10px;font-size:13px;margin:0 0 10px}' +
        '.ddex .ddex-info{background:#eef2f7;border-radius:12px;padding:12px;font-size:13px;color:#5c6974;margin:14px 0}' +
        '</style>';
    }

    function formHtml() {
      return '<p class="ddex-intro">' + esc(t('intro')) + '</p>' +
        '<div class="ddex-fmt">' +
        '<label><input type="radio" name="ddex-fmt" value="json" checked> ' + esc(t('formatJsonDesc')) + '</label>' +
        '<label><input type="radio" name="ddex-fmt" value="html"> ' + esc(t('formatHtmlDesc')) + '</label>' +
        '</div>' +
        '<button class="ddex-cta" data-act="request"' + (state.busy ? ' disabled' : '') + '>' +
        esc(state.busy ? t('requesting') : t('requestBtn')) + '</button>';
    }

    function errFor(e) {
      var code = (e && e.code) || (e && e.message) || 'error';
      if (code === 'auth/expired') return t('authExpired');
      if (code === 'export/backend-unconfigured' || code === 'export/no-fetch') return t('backendUnconfigured');
      if (code === 'job/not-ready') return t('notReady');
      if (code === 'export/sha-mismatch') return t('shaMismatch');
      if (/^export\/too_many_requests/.test(code) || code === 'export/http-429') return t('alreadyActive');
      if (/^export\/unauthorized|^export\/invalid_token/.test(code)) return t('authExpired');
      return t('requestFailed');
    }

    function paint(jobs, active) {
      var user = currentUser();
      var html = css() + '<div class="ddex">';
      if (state.error) html += '<div class="ddex-err">' + esc(state.error) + '</div>';
      if (state.notice) html += '<div class="ddex-ok">' + esc(state.notice) + '</div>';
      if (!user) {
        html += '<p class="ddex-intro">' + esc(t('needLogin')) + '</p>';
      } else if (!active) {
        html += formHtml();
      } else {
        html += '<div class="ddex-sec">' + esc(t('activeExport')) + '</div>' + jobCard(active);
      }
      html += '<div class="ddex-sec">' + esc(t('history')) + '</div>';
      var hist = (jobs || []).filter(function (j) { return !active || j.id !== active.id; });
      if (!hist.length && !active) html += '<p class="ddex-empty">' + esc(t('noHistory')) + '</p>';
      else hist.forEach(function (j) { html += jobCard(j); });
      html += '<div class="ddex-info"><b>' + esc(t('limitsTitle')) + '</b><br>' + esc(t('limitsBody')) + '</div>';
      html += '<div class="ddex-info">' + esc(t('privacyNote')) + '</div>';
      html += '</div>';
      el.innerHTML = html;
    }

    function refresh() {
      state.error = null;
      return getJobs().then(function (jobs) {
        noteStatuses(jobs);
        var active = null;
        for (var i = 0; i < jobs.length; i++) {
          if (ACTIVE_STATUSES.indexOf(jobs[i].status) !== -1 && !isExpired(jobs[i])) { active = jobs[i]; break; }
        }
        paint(jobs, active);
      }).catch(function (e) {
        state.error = errFor(e);
        paint([], null);
      });
    }

    function busyDo(promise, noticeKey) {
      state.busy = true; state.error = null; state.notice = null;
      return promise.then(function (r) {
        state.busy = false;
        if (noticeKey) state.notice = t(noticeKey);
        return refresh().then(function () { return r; });
      }, function (e) {
        state.busy = false;
        state.error = errFor(e);
        return refresh().then(function () { throw e; });
      });
    }

    el.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!btn || btn.disabled) return;
      var act = btn.getAttribute('data-act');
      var id = btn.getAttribute('data-id');
      if (act === 'request') {
        var fmt = 'json';
        try {
          var sel = el.querySelector('input[name="ddex-fmt"]:checked');
          if (sel && sel.value === 'html') fmt = 'html';
        } catch (_) {}
        busyDo(requestExport({ format: fmt }).then(function (r) {
          if (r && r.alreadyActive) state.notice = t('alreadyActive');
          return r;
        }));
      } else if (act === 'download' && id) {
        btn.disabled = true;
        downloadExport(id).then(function () { return refresh(); }, function (e) {
          state.error = errFor(e); return refresh();
        });
      } else if (act === 'retry' && id) {
        busyDo(retryExport(id));
      } else if (act === 'cancel' && id) {
        busyDo(cancelExport(id), 'cancelledNote');
      }
    });

    refresh();
    var timer = setInterval(function () {
      // Polling ligero: el servidor puede terminar mientras la pestaña
      // está abierta; si se cerró, el re-render al volver lo recoge.
      if (el && el.isConnected !== false) refresh().catch(function () {});
    }, D().pollMs || 60000);
    return function destroy() { try { clearInterval(timer); } catch (_) {} };
  }

  /* ---------------- API pública ---------------- */
  var api = {
    requestExport: requestExport,
    getJobs: getJobs,
    getJob: getJob,
    retryExport: retryExport,
    cancelExport: cancelExport,
    downloadExport: downloadExport,
    renderInto: renderInto,
    onExportReady: function (fn) {
      if (typeof fn === 'function') readyHooks.push(fn);
      return function () {
        var i = readyHooks.indexOf(fn);
        if (i !== -1) readyHooks.splice(i, 1);
      };
    },
    t: t,
    _setDeps: function (d) { deps = Object.assign({}, defaultDeps, d || {}); },
    _resetDeps: function () { deps = defaultDeps; lastSeenStatus = {}; },
    _internals: {
      EXCLUDED: EXCLUDED,
      LIMITS: LIMITS,
      TOTAL_SECTIONS: TOTAL_SECTIONS,
      JOB_TTL_MS: JOB_TTL_MS,
      STUCK_MS: STUCK_MS,
      stripSecretsDeep: stripSecretsDeep,
      excludedList: excludedList,
      limitsList: limitsList,
      buildHtml: buildHtml,
      isExpired: isExpired,
      isStuck: isStuck,
      esc: esc,
      captureBrowserSnapshot: captureBrowserSnapshot,
      SNAPSHOT_KEYS: SNAPSHOT_KEYS,
      _getReadyHooks: function () { return readyHooks; },
      _fireReadyHooks: fireReadyHooks
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DrexDataExport = api;
})(typeof window !== 'undefined' ? window : this);
