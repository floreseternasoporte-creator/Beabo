#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
drex-data-export — backend durable para "Descargar mis datos".

Flujo estilo Meta: solicitar -> preparar en servidor (sobrevive al cierre de
la pestana) -> notificar in-app -> descargar via URL pre-firmada S3.

Acciones por Function URL (POST JSON {action, ...}):
  - request       : valida access token (Cognito GetUser), crea el job y
                    dispara el worker asincrono (auto-invocacion).
  - download-url  : verifica titularidad y devuelve presigned GET de 15 min.
Invocaciones internas (lambda:InvokeFunction, NO por Function URL):
  - {"internal":"worker", ...} : procesa las 27 secciones, genera JSON+HTML,
                    sube a S3, marca ready y notifica. workerToken
                    anti-confused-deputy; auto-continuacion con cursor.
  - {"internal":"sweep"}        : EventBridge diario; marca expired y limpia
                    cuentas eliminadas.

Solo boto3 del runtime (sin dependencias externas).
Diseno: docs/EXPORT-BACKEND-DESIGN.md · Mapa de datos: docs/DATA-SCHEMA.md
"""
import base64
import hashlib
import hmac
import html as _html
import json
import os
import re
import secrets
import time
import uuid

try:  # perezoso: los tests usan dobles sin boto3 instalado
    import boto3
    import botocore.exceptions as _botocore_exc
except Exception:  # pragma: no cover
    boto3 = None
    _botocore_exc = None

# ---------------------------------------------------------------- config ---
REGION = os.environ.get("AWS_REGION", "us-east-1")
TABLE_NAME = os.environ.get("DREX_TABLE", "drex-kv")
SUPPORT_TABLE_NAME = os.environ.get("DREX_SUPPORT_TABLE", "drex-support-tickets")
BUCKET = os.environ.get("EXPORT_BUCKET", "drex-exports-002493750027")
POOL_ID = os.environ.get("COGNITO_USER_POOL_ID", "us-east-1_kDSYEBsnY")

RL_EXPORT_USER_MAX = int(os.environ.get("RL_EXPORT_USER_MAX", "3"))
RL_EXPORT_USER_WINDOW = int(os.environ.get("RL_EXPORT_USER_WINDOW", "3600"))
RL_EXPORT_IP_MAX = int(os.environ.get("RL_EXPORT_IP_MAX", "100"))
RL_EXPORT_IP_WINDOW = int(os.environ.get("RL_EXPORT_IP_WINDOW", "3600"))
RL_DL_USER_MAX = int(os.environ.get("RL_DL_USER_MAX", "30"))
RL_DL_USER_WINDOW = int(os.environ.get("RL_DL_USER_WINDOW", "3600"))

MAX_SNAPSHOT_BYTES = 64 * 1024          # browserSnapshot <= 64 KB
MAX_EXPORT_BYTES = 50 * 1024 * 1024     # el worker aborta si el JSON supera 50 MB
PRESIGNED_TTL_S = 15 * 60               # URL de descarga: 15 minutos
JOB_TTL_MS = 7 * 24 * 3600 * 1000       # el archivo vive 7 dias
JOB_TTL_ATTR_S = 30 * 24 * 3600        # el registro historico se auto-borra 30 dias despues
HEARTBEAT_STUCK_MS = 15 * 60 * 1000     # sin heartbeat en 15 min -> atorado
WORKER_TIME_GUARD_MS = 60 * 1000        # si queda menos de 60 s, continua con cursor

_ALLOWED_ORIGINS = set(
    o.strip()
    for o in os.environ.get(
        "CORS_ORIGINS",
        "https://floreseternasoporte-creator.github.io,"
        "https://drex.glamworksapps.workers.dev,"
        "https://getdrex.com,"
        "https://www.getdrex.com",
    ).split(",")
    if o.strip()
)

# Limites v1 (mismos que el cliente): posts 200, comentarios 500,
# notificaciones 100, conversaciones 50, mensajes/conv 50, media 50, global 100.
LIM = {
    "posts": 200, "comments": 500, "notifs": 100, "convs": 50,
    "msgsPerConv": 50, "mediaPosts": 50, "global": 100,
}

# ------------------------------------------------- clientes (inyectables) ---
_test = {}  # dobles para tests: set_test_clients(ddb=, support=, s3=, idp=, lam=)


def set_test_clients(**kw):
    """Solo tests: inyecta dobles de DynamoDB/S3/Cognito/Lambda."""
    _test.update(kw)


def _boto3_client(name):
    if name in _test:
        return _test[name]
    if boto3 is None:  # pragma: no cover
        raise RuntimeError("boto3 no disponible")
    return boto3.client(name, region_name=REGION)


def _ddb():
    return _test.get("ddb") or _boto3_client("dynamodb")


def _s3():
    return _test.get("s3") or _boto3_client("s3")


def _idp():
    return _test.get("idp") or _boto3_client("cognito-idp")


def _lam():
    return _test.get("lam") or _boto3_client("lambda")


def _support_table_name():
    return SUPPORT_TABLE_NAME


# ------------------------------------------------------------------ utils ---
def _now_ms():
    return int(time.time() * 1000)


def _now_s():
    return int(time.time())


def _err_code(exc):
    try:
        return exc.response.get("Error", {}).get("Code", "")
    except Exception:
        return ""


class HttpError(Exception):
    def __init__(self, status, code, message=""):
        super().__init__(message or code)
        self.status = status
        self.code = code
        self.message = message or code


def _origin(event):
    try:
        h = event.get("headers") or {}
        for k, v in h.items():
            if str(k).lower() == "origin":
                return v
    except Exception:
        pass
    return ""


def _cors_headers(origin):
    h = {"Content-Type": "application/json", "Cache-Control": "no-store"}
    if origin in _ALLOWED_ORIGINS:
        h["Access-Control-Allow-Origin"] = origin
        h["Vary"] = "Origin"
    return h


def _resp(status, body_dict, origin):
    return {
        "statusCode": status,
        "headers": _cors_headers(origin),
        "body": json.dumps(body_dict, ensure_ascii=False),
    }


def _client_ip(event):
    try:
        return event["requestContext"]["http"]["sourceIp"]
    except Exception:
        return "unknown"


def _parse_body(event):
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        try:
            raw = base64.b64decode(raw).decode("utf-8")
        except Exception:
            raw = ""
    if not raw:
        return {}
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def _bearer(event):
    try:
        h = event.get("headers") or {}
        for k, v in h.items():
            if str(k).lower() == "authorization":
                m = re.match(r"(?i)^\s*Bearer\s+(.+?)\s*$", str(v))
                if m:
                    return m.group(1)
    except Exception:
        pass
    return ""


# ------------------------------------------------------------- auth/token ---
def verify_token(token):
    """Valida el access token con Cognito GetUser (API publica, sin IAM).
    Devuelve (sub, attrs). Token invalido/expirado/revocado -> HttpError 401.
    El sub sale SOLO del token verificado (anti-IDOR)."""
    if not token:
        raise HttpError(401, "invalid_token")
    try:
        r = _idp().get_user(AccessToken=token)
    except Exception as e:
        raise HttpError(401, "invalid_token", "invalid_token")
    sub = r.get("Username") or ""
    if not sub:
        raise HttpError(401, "invalid_token")
    attrs = {}
    for a in r.get("UserAttributes") or []:
        n = a.get("Name")
        if n:
            attrs[n] = a.get("Value")
    return sub, attrs


# -------------------------------------------------------------- rate limit ---
def _rate_limited(scope, key_id, max_n, window_s):
    """Ventana fija atomica (mismo patron que drex-username-resolve).
    scope='export'|'exportip'|'exportdl'. Ante errores de BD: fail-open."""
    if not key_id:
        return False
    now = _now_s()
    ddb = _ddb()
    key = {"pk": "ratelimit", "sk": "%s/%s" % (scope, key_id)}
    try:
        ddb.update_item(
            TableName=TABLE_NAME,
            Key=key,
            UpdateExpression="SET #c = :one, #e = :exp, #t = :ttl",
            ConditionExpression="attribute_not_exists(pk) OR #e < :now",
            ExpressionAttributeNames={"#c": "c", "#e": "e", "#t": "ttl"},
            ExpressionAttributeValues={
                ":one": 1, ":exp": now + window_s,
                ":ttl": now + window_s + 300, ":now": now,
            },
        )
        return False
    except Exception as e:
        if _err_code(e) != "ConditionalCheckFailedException":
            return False  # error real de BD: no bloquear
        # La ventana esta vigente: continuar al incremento atomico.
    try:
        r = ddb.update_item(
            TableName=TABLE_NAME,
            Key=key,
            UpdateExpression="ADD #c :inc SET #t = :ttl",
            ExpressionAttributeNames={"#c": "c", "#t": "ttl"},
            ExpressionAttributeValues={":inc": 1, ":ttl": now + window_s + 300},
            ReturnValues="UPDATED_NEW",
        )
        return int(r["Attributes"]["c"]) > max_n
    except Exception:
        return False


# ------------------------------------------------------- acceso DynamoDB ----
# La tabla drex-kv guarda un item por atributo: pk=primer segmento,
# sk=resto unido con '/', v=string JSON del valor.


def _parse_v(item):
    if not item:
        return None
    raw = item.get("v")
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return raw


def get_v(pk, sk):
    r = _ddb().get_item(TableName=TABLE_NAME, Key={"pk": pk, "sk": sk})
    return _parse_v(r.get("Item"))


def put_v(pk, sk, obj, extra_attrs=None):
    item = {"pk": pk, "sk": sk, "v": json.dumps(obj, ensure_ascii=False)}
    if extra_attrs:
        item.update(extra_attrs)
    _ddb().put_item(TableName=TABLE_NAME, Item=item)


def query_prefix(pk, prefix, limit=None, descending=True, table=None):
    """Lee items pk=pk con sk que empieza por prefix. Devuelve [(sk, valor)]."""
    tname = table or TABLE_NAME
    out = []
    kwargs = {
        "TableName": tname,
        "KeyConditionExpression": "pk = :pk AND begins_with(sk, :pre)",
        "ExpressionAttributeValues": {":pk": pk, ":pre": prefix},
        "ScanIndexForward": not descending,
    }
    if limit:
        kwargs["Limit"] = limit
    while True:
        r = _ddb().query(**kwargs)
        for it in r.get("Items", []):
            out.append((it.get("sk"), _parse_v(it)))
            if limit and len(out) >= limit:
                return out[:limit]
        lek = r.get("LastEvaluatedKey")
        if not lek:
            break
        kwargs["ExclusiveStartKey"] = lek
    return out


def scan_pk(pk, limit, filter_fn=None, table=None):
    """Scan acotado sobre una pk global con filtro en codigo. [(sk, valor)]."""
    tname = table or TABLE_NAME
    out = []
    kwargs = {
        "TableName": tname,
        "FilterExpression": "pk = :pk",
        "ExpressionAttributeValues": {":pk": pk},
        "Limit": limit,
    }
    scanned = 0
    while True:
        r = _ddb().scan(**kwargs)
        for it in r.get("Items", []):
            v = _parse_v(it)
            if filter_fn is None or filter_fn(it.get("sk"), v):
                out.append((it.get("sk"), v))
        scanned += r.get("ScannedCount", 0)
        if len(out) >= limit or scanned >= limit or not r.get("LastEvaluatedKey"):
            break
        kwargs["ExclusiveStartKey"] = r["LastEvaluatedKey"]
    return out[:limit]


# ------------------------------------------------------------------- jobs ---
def job_sk(sub, job_id):
    return "%s/dataExports/%s" % (sub, job_id)


def read_job(sub, job_id):
    v = get_v("users", job_sk(sub, job_id))
    return v if isinstance(v, dict) else None


def write_job(job):
    put_v("users", job_sk(job["sub"], job["jobId"]), job,
          extra_attrs={"ttl": job.get("ttl")})


PUBLIC_JOB_FIELDS = (
    "jobId", "sub", "format", "status", "progress", "summary", "error",
    "createdAt", "updatedAt", "expiresAt", "lastHeartbeat", "fileSize",
    "language", "attempts",
)


def job_public(job):
    return {k: job.get(k) for k in PUBLIC_JOB_FIELDS if k in job}


def find_active_job(sub):
    for _sk, v in query_prefix("users", "%s/dataExports/" % sub, limit=50):
        if isinstance(v, dict) and v.get("status") in ("requested", "preparing"):
            return v
    return None

# --------------------------------------- defensa en profundidad: secretos ---
FORBIDDEN_KEYS = frozenset([
    "twofactorsecret", "twofactorbackupcodes",  # secretos 2FA legacy
    "hashes",                                   # hashes de codigos de respaldo
    "endpoint", "p256dh",                       # pushSubscriptions (excluida)
    "auth", "token", "idtoken", "accesstoken", "refreshtoken",
    "password", "secret", "privatekey",
])
_JWT_RE = re.compile(r"^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")


def strip_secrets_deep(node):
    """Elimina llaves que huelan a secreto + JWT/data URLs gigantes.
    Espejo Python de stripSecretsDeep() del cliente."""
    if node is None:
        return None
    if isinstance(node, str):
        if len(node) > 200000:
            return "[valor muy largo omitido por privacidad]"
        if _JWT_RE.match(node):
            return "[token omitido]"
        return node
    if isinstance(node, list):
        return [strip_secrets_deep(x) for x in node]
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if str(k).lower() in FORBIDDEN_KEYS:
                continue
            out[k] = strip_secrets_deep(v)
        return out
    return node


def sanitize_media(obj):
    """Conserva URLs/metadata de media; nunca incrusta binarios (data URLs)."""
    if obj is None:
        return None
    if isinstance(obj, str):
        if len(obj) > 2048 and obj[:5].lower() == "data:":
            return "[binario omitido: %d caracteres]" % len(obj)
        return obj
    if isinstance(obj, list):
        return [sanitize_media(x) for x in obj]
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in ("data", "blob", "base64") and isinstance(v, str) and len(v) > 2048:
                out[k] = "[binario omitido: %d caracteres]" % len(v)
            else:
                out[k] = sanitize_media(v)
        return out
    return obj


def strip_own_email(obj, email):
    if not isinstance(obj, dict) or not email:
        return obj
    low = str(email).lower()
    for f in ("authorEmail", "userEmail", "email"):
        if isinstance(obj.get(f), str) and obj[f].lower() == low:
            del obj[f]
    return obj


# --------------------------------------------------------------------- i18n ---
def _lang_of(job):
    l = (job or {}).get("language")
    return l if l in ("en", "zh", "es") else "es"


def _tr(entry, lang):
    if isinstance(entry, dict):
        return entry.get(lang) or entry.get("es")
    return entry


SECTION_TITLES = {
    "account": {"en": "Account", "es": "Cuenta", "zh": "账户"},
    "profile": {"en": "Profile", "es": "Perfil", "zh": "个人资料"},
    "twoFactor": {"en": "Two-factor authentication", "es": "Verificación en dos pasos", "zh": "双重验证"},
    "interests": {"en": "Interest profile", "es": "Perfil de intereses", "zh": "兴趣画像"},
    "posts": {"en": "Posts", "es": "Publicaciones", "zh": "帖子"},
    "comments": {"en": "Comments", "es": "Comentarios", "zh": "评论"},
    "votes": {"en": "Votes", "es": "Votos", "zh": "投票"},
    "ecos": {"en": "Ecos", "es": "Ecos", "zh": "Ecos"},
    "saved": {"en": "Saved", "es": "Guardados", "zh": "收藏"},
    "social": {"en": "Social connections", "es": "Conexiones sociales", "zh": "社交关系"},
    "ratings": {"en": "Ratings received", "es": "Calificaciones recibidas", "zh": "收到的评分"},
    "conversations": {"en": "Conversations", "es": "Conversaciones", "zh": "会话"},
    "notifications": {"en": "Notifications", "es": "Notificaciones", "zh": "通知"},
    "settings": {"en": "Settings", "es": "Ajustes", "zh": "设置"},
    "securityPrefs": {"en": "Security preferences", "es": "Preferencias de seguridad", "zh": "安全偏好"},
    "devices": {"en": "Devices", "es": "Dispositivos", "zh": "设备"},
    "loginHistory": {"en": "Login history", "es": "Historial de accesos", "zh": "登录历史"},
    "sessions": {"en": "Sessions", "es": "Sesiones", "zh": "登录会话"},
    "fiestas": {"en": "Fiestas", "es": "Fiestas", "zh": "派对"},
    "groups": {"en": "Groups", "es": "Grupos", "zh": "群组"},
    "music": {"en": "Music", "es": "Música", "zh": "音乐"},
    "languages": {"en": "Languages", "es": "Idiomas", "zh": "语言"},
    "appeals": {"en": "Appeals", "es": "Apelaciones", "zh": "申诉"},
    "moderationReports": {"en": "Moderation reports", "es": "Reportes de moderación", "zh": "审核举报"},
    "supportTickets": {"en": "Support tickets", "es": "Tickets de soporte", "zh": "支持工单"},
    "parental": {"en": "Parental supervision", "es": "Supervisión parental", "zh": "家长监督"},
    "browserData": {"en": "Browser data", "es": "Datos del navegador", "zh": "浏览器数据"},
}

EXCLUDED = [
    ("pushSubscriptions", {"en": "Push endpoints and keys are credentials: the whole category is excluded.",
                            "es": "Los endpoints y claves push son credenciales: la categoría se excluye por completo.",
                            "zh": "推送端点和密钥属于凭据：整个类别均被排除。"}),
    ("twoFactorSecret / twoFactorBackupCodes", {"en": "Legacy 2FA secrets are never exported.",
                                                "es": "Los secretos 2FA legacy nunca se exportan.",
                                                "zh": "旧版双重验证密钥永不导出。"}),
    ("recoveryCodes.hashes", {"en": "Only metadata (generatedAt, usedCount); hashes are equivalent to credentials.",
                              "es": "Solo metadata (generatedAt, usedCount); los hashes equivalen a credenciales.",
                              "zh": "仅包含元数据（生成时间、已使用次数）；哈希等同于凭据。"}),
    ("parentalLinkCodes (activos)", {"en": "Active link codes are single-use secrets; only used/expired metadata.",
                                     "es": "Los códigos de enlace activos son secretos de un solo uso; solo metadata de usados/vencidos.",
                                     "zh": "有效的关联代码是一次性密钥；仅包含已使用/已过期的元数据。"}),
    ("tokens de Cognito (localStorage)", {"en": "Cognito session tokens stored in the browser are never read.",
                                          "es": "Los tokens de sesión de Cognito en el navegador nunca se leen.",
                                          "zh": "绝不读取浏览器中存储的 Cognito 会话令牌。"}),
    ("datos de otros usuarios", {"en": "Only your data: other users' profiles, posts and comments are excluded.",
                                 "es": "Solo tus datos: se excluyen perfiles, publicaciones y comentarios de otros.",
                                 "zh": "仅包含你的数据：不包含其他用户的个人资料、帖子和评论。"}),
    ("calificaciones que diste", {"en": "Ratings you gave live under other users' profiles and cannot be listed without scanning them.",
                                  "es": "Las calificaciones que diste viven en perfiles ajenos y no se pueden listar sin barrerlos.",
                                  "zh": "你给出的评分存储在其他用户的资料下，无法列出。"}),
    ("correctionHelpful / solicitudes enviadas", {"en": "Stored under global keys with no per-user index; listing them would require scanning shared tables.",
                                                  "es": "Guardados bajo llaves globales sin índice por usuario; listarlos exigiría barrer tablas compartidas.",
                                                  "zh": "存储在没有按用户索引的全局键下；列出它们需要扫描共享表。"}),
    ("ratelimit, userCount, revokeOtherSessions, usernames/", {"en": "Rate limits, counters and internal indexes are infrastructure, not your data.",
                                                               "es": "Límites, contadores e índices internos son infraestructura, no tus datos.",
                                                               "zh": "限流、计数器和内部索引属于基础设施，不是你的数据。"}),
    ("typing, userPresence, fiestaReactions, flags de UI", {"en": "Typing indicators, presence, live reactions and UI flags are ephemeral.",
                                                            "es": "Indicadores de escritura, presencia, reacciones en vivo y flags de UI son efímeros.",
                                                            "zh": "输入指示、在线状态、直播互动和界面标记都是临时的。"}),
    ("musicAudio (binario)", {"en": "Audio binaries are heavy; the file lists your tracks' metadata and links.",
                              "es": "El audio binario es pesado; el archivo lista la metadata y enlaces de tus pistas.",
                              "zh": "音频二进制文件较大；文件仅列出你的曲目的元数据和链接。"}),
]

LIMITS = [
    ("posts", 200, {"en": "Latest 200 posts (scanned from the 600 most recent).",
                    "es": "Últimas 200 publicaciones (escaneadas de las 600 más recientes).",
                    "zh": "最近 200 条帖子（从最近 600 条中筛选）。"}),
    ("comments", 500, {"en": "Latest 500 comments from your personal index.",
                       "es": "Últimos 500 comentarios de tu índice personal.",
                       "zh": "个人索引中最近的 500 条评论。"}),
    ("notifications", 100, {"en": "Latest 100 notifications.",
                            "es": "Últimas 100 notificaciones.",
                            "zh": "最近 100 条通知。"}),
    ("conversations", 50, {"en": "Latest 50 conversations.",
                           "es": "Últimas 50 conversaciones.",
                           "zh": "最近 50 个会话。"}),
    ("messagesPerConversation", 50, {"en": "Latest 50 messages per conversation.",
                                     "es": "Últimos 50 mensajes por conversación.",
                                     "zh": "每个会话最近 50 条消息。"}),
    ("appeals_reports_exercises_fiestas_groups", 100,
     {"en": "Latest 100 of yours found scanning the 600 most recent shared records (no server-side per-user query exists).",
      "es": "Últimos 100 tuyos encontrados al escanear los 600 registros compartidos más recientes (no existe consulta por usuario en el servidor).",
      "zh": "在最近 600 条共享记录中筛选出的属于你的最近 100 条（服务器端没有按用户的查询）。"}),
]

NOTIF_STRINGS = {
    "ready_title": {"en": "Your data file is ready", "es": "Tu archivo de datos está listo", "zh": "你的数据文件已准备就绪"},
    "ready_body": {"en": "Your copy of your Drex data is ready to download. Available for 7 days.",
                   "es": "Tu copia de datos de Drex está lista para descargar. Disponible por 7 días.",
                   "zh": "你的 Drex 数据副本已可下载。7 天内有效。"},
    "failed_title": {"en": "Your data request could not be completed", "es": "Tu solicitud de datos no pudo completarse", "zh": "你的数据申请未能完成"},
    "failed_body": {"en": "Something went wrong while preparing your file. You can try again from the Security Center.",
                    "es": "Algo salió mal al preparar tu archivo. Puedes intentarlo de nuevo desde el Centro de seguridad.",
                    "zh": "准备文件时出现问题。你可以从安全中心重试。"},
}

# ----------------------------------------------------- secciones (27) ------
# Cada runner recibe ctx={'uid','email','job'} y devuelve
# {'data':..., 'count':N, 'note':...opcional}. Solo datos del dueno del job.


def sec_account(ctx):
    uid, email = ctx["uid"], ctx["email"]
    try:
        r = _idp().admin_get_user(UserPoolId=POOL_ID, Username=uid)
    except Exception:
        r = {}
    attrs = {a.get("Name"): a.get("Value") for a in (r.get("UserAttributes") or []) if a.get("Name")}
    mfa = r.get("UserMFASettingList") or []
    return {
        "data": {
            "uid": uid,
            "email": attrs.get("email", email),
            "emailVerified": str(attrs.get("email_verified", "")).lower() == "true",
            "name": attrs.get("name"),
            "picture": attrs.get("picture"),
            "mfaMethods": mfa,
            "preferredMfa": r.get("PreferredMfaSetting"),
        },
        "count": 1,
        "note": "Cognito attributes only: no password hashes or tokens are ever exported.",
    }


_PROFILE_MOVED = {
    "devices", "logins", "sessions", "ratings", "recoveryCodes",
    "twoFactorEnabled", "supervisedBy", "supervising", "parentalControls",
}
_PROFILE_EXCLUDED = {"twoFactorSecret", "twoFactorBackupCodes", "dataExports"}


def sec_profile(ctx):
    root = get_v("users", ctx["uid"]) or {}
    if not isinstance(root, dict):
        root = {}
    p = {k: v for k, v in root.items()
         if k not in _PROFILE_MOVED and k not in _PROFILE_EXCLUDED}
    return {"data": p, "count": 1}


def sec_two_factor(ctx):
    root = get_v("users", ctx["uid"]) or {}
    rc = (root.get("recoveryCodes") or {}) if isinstance(root, dict) else {}
    rc_meta = None
    if isinstance(rc, dict):
        rc_meta = {"generatedAt": rc.get("generatedAt"),
                   "usedCount": rc.get("usedCount", 0)}
    try:
        r = _idp().admin_get_user(UserPoolId=POOL_ID, Username=ctx["uid"])
        mfa = r.get("UserMFASettingList") or []
        enabled = bool(mfa) or (root.get("twoFactorEnabled") is True)
    except Exception:
        mfa, enabled = [], (root.get("twoFactorEnabled") is True)
    return {"data": {"enabled": enabled, "methods": mfa,
                     "recoveryCodes": rc_meta}, "count": 1}


def sec_interests(ctx):
    v = get_v("userInterests", ctx["uid"])
    return {"data": v, "count": _count_val(v)}


def _count_val(v):
    if v is None:
        return 0
    if isinstance(v, (list, tuple)):
        return len(v)
    if isinstance(v, dict):
        return len(v)
    return 1


def _ts_of(item):
    if not isinstance(item, dict):
        return 0
    for f in ("timestamp", "createdAt", "requestedAt", "followedAt", "blockedAt"):
        v = item.get(f)
        if isinstance(v, (int, float)):
            return v
    return 0


def sec_posts(ctx):
    uid, email = ctx["uid"], ctx["email"]
    found = scan_pk("communityNotes", 600,
                    lambda sk, v: isinstance(v, dict) and str(v.get("authorId")) == uid)
    found.sort(key=lambda e: _ts_of(e[1]), reverse=True)
    found = found[:LIM["posts"]]
    out = []
    for pid, post in found[:LIM["mediaPosts"]]:
        media = {}
        imgs = get_v("noteImages", pid)
        vids = get_v("noteVideos", pid)
        if imgs:
            media["images"] = sanitize_media(imgs)
        if vids:
            media["videos"] = sanitize_media(vids)
        out.append({"id": pid, "post": strip_own_email(dict(post), email), "media": media})
    for pid, post in found[LIM["mediaPosts"]:]:
        out.append({"id": pid, "post": strip_own_email(dict(post), email), "media": {}})
    note = "limited" if len(found) >= LIM["posts"] else None
    return {"data": out, "count": len(out), "note": note}


def sec_comments(ctx):
    uid, email = ctx["uid"], ctx["email"]
    seen = {}
    for _sk, v in query_prefix("userComments", "%s/" % uid, limit=LIM["comments"]):
        if isinstance(v, dict):
            seen[_sk] = v
    for _sk, v in scan_pk("postComments", 600,
                          lambda sk, vv: isinstance(vv, dict) and str(vv.get("authorId")) == uid):
        seen.setdefault(_sk, v)
    items = sorted(seen.items(), key=lambda e: _ts_of(e[1]), reverse=True)[:LIM["comments"]]
    out = [{"id": sk, "comment": strip_own_email(dict(v), email)} for sk, v in items]
    return {"data": out, "count": len(out)}


def sec_votes(ctx):
    uid = ctx["uid"]
    out = {
        "postVotes": get_v("userVotes", uid),
        "commentVotes": get_v("userCommentVotes", uid),
    }
    return {"data": out, "count": _count_val(out["postVotes"]) + _count_val(out["commentVotes"])}


def sec_ecos(ctx):
    uid = ctx["uid"]
    out = {"ecos": {}, "legacyReposts": {}}
    for sk, v in query_prefix("userEcos", "%s/" % uid, limit=500):
        out["ecos"][sk] = v
    for sk, v in query_prefix("userReposts", "%s/" % uid, limit=500):
        out["legacyReposts"][sk] = v
    return {"data": out, "count": len(out["ecos"]) + len(out["legacyReposts"])}


def sec_saved(ctx):
    uid = ctx["uid"]
    out = {
        "posts": get_v("savedPosts", uid),
        "folders": get_v("savedFolders", uid),
        "comments": get_v("savedComments", uid),
    }
    return {"data": out, "count": sum(_count_val(x) for x in out.values())}


def sec_social(ctx):
    uid = ctx["uid"]
    following = {sk: v for sk, v in query_prefix("following", "%s/" % uid, limit=1000)}
    followers = {sk: v for sk, v in query_prefix("followers", "%s/" % uid, limit=1000)}
    req_in = {sk: v for sk, v in query_prefix("followRequests", "%s/" % uid, limit=500)}
    # Enviadas: sk='<targetUid>/<uid>' (scan acotado, filtro por sufijo).
    req_out = {}
    for sk, v in scan_pk("followRequests", 600,
                         lambda sk, vv: str(sk).endswith("/%s" % uid)):
        req_out[sk] = v
    blocks = {sk: v for sk, v in query_prefix("blocks", "%s/" % uid, limit=1000)}
    out = {
        "following": following, "followers": followers,
        "followRequestsReceived": req_in, "followRequestsSent": req_out,
        "blocks": blocks,
        "profileNote": get_v("profileNotes", uid),
        "collabs": get_v("userCollabs", uid),
    }
    return {"data": out,
            "count": sum(_count_val(x) for x in (following, followers, req_in, req_out, blocks))}


def sec_ratings(ctx):
    uid = ctx["uid"]
    out = {sk: v for sk, v in query_prefix("users", "%s/ratings/" % uid, limit=1000)}
    return {"data": out, "count": len(out),
            "note": "Ratings you received. Ratings you gave live under other users' profiles."}


def sec_conversations(ctx):
    uid = ctx["uid"]
    convs = query_prefix("userConversations", "%s/" % uid, limit=LIM["convs"])
    convs.sort(key=lambda e: _ts_of(e[1]), reverse=True)
    convs = convs[:LIM["convs"]]
    out = []
    for sk, meta in convs:
        conv_id = sk.split("/", 1)[1] if "/" in sk else sk
        msgs = query_prefix("conversationMessages", "%s/" % conv_id,
                            limit=LIM["msgsPerConv"])
        msgs.sort(key=lambda e: _ts_of(e[1]), reverse=True)
        msgs = msgs[:LIM["msgsPerConv"]]
        out.append({
            "id": conv_id,
            "meta": meta,
            "messages": [{"id": msk, "message": mv} for msk, mv in msgs],
        })
    return {"data": out, "count": sum(len(c["messages"]) for c in out),
            "note": "Your conversations, including messages from the other participants (your own mailbox). "}


def sec_notifications(ctx):
    uid = ctx["uid"]
    items = query_prefix("notifications", "%s/" % uid, limit=LIM["notifs"])
    items.sort(key=lambda e: _ts_of(e[1]), reverse=True)
    items = items[:LIM["notifs"]]
    out = [{"id": sk, "notification": v} for sk, v in items]
    return {"data": out, "count": len(out)}


def sec_settings(ctx):
    v = get_v("userSettings", ctx["uid"])
    return {"data": v, "count": _count_val(v)}


def sec_security_prefs(ctx):
    uid = ctx["uid"]
    out = {}
    for sk, v in query_prefix("security", "%s/preferences/" % uid, limit=50):
        out[sk.split("/")[-1]] = v
    return {"data": out, "count": len(out)}


def sec_devices(ctx):
    uid = ctx["uid"]
    out = {sk: v for sk, v in query_prefix("users", "%s/devices/" % uid, limit=500)}
    return {"data": out, "count": len(out)}


def sec_login_history(ctx):
    uid = ctx["uid"]
    items = query_prefix("users", "%s/logins/" % uid, limit=50)
    out = [{"id": sk, "login": v} for sk, v in items]
    return {"data": out, "count": len(out),
            "note": "Latest 50 logins. No IP addresses are stored by design."}


def sec_sessions(ctx):
    uid = ctx["uid"]
    out = {sk: v for sk, v in query_prefix("users", "%s/sessions/" % uid, limit=200)}
    return {"data": out, "count": len(out)}


def sec_fiestas(ctx):
    uid = ctx["uid"]
    mine = scan_pk("fiestas", 600,
                   lambda sk, v: isinstance(v, dict) and str(v.get("hostId")) == uid)
    mine.sort(key=lambda e: _ts_of(e[1]), reverse=True)
    mine = mine[:LIM["global"]]
    out = []
    for fid, f in mine:
        pre = "%s/%s" % (fid, uid)
        out.append({
            "id": fid, "fiesta": f,
            "myMembership": get_v("fiestaMembers", pre),
            "mySignals": get_v("fiestaSignals", pre),
            "kicked": get_v("fiestaKicked", pre),
        })
    return {"data": out, "count": len(out)}


_CREATOR_FIELDS = ("creatorId", "createdBy", "authorId", "hostId", "ownerId")


def sec_groups(ctx):
    uid = ctx["uid"]
    mine = scan_pk("groups", 600,
                   lambda sk, v: isinstance(v, dict) and
                   any(str(v.get(f)) == uid for f in _CREATOR_FIELDS))
    mine.sort(key=lambda e: _ts_of(e[1]), reverse=True)
    mine = mine[:LIM["global"]]
    out = [{"id": sk, "group": v} for sk, v in mine]
    return {"data": out, "count": len(out)}


def sec_music(ctx):
    uid = ctx["uid"]
    tracks = scan_pk("musicTracks", 600,
                     lambda sk, v: isinstance(v, dict) and str(v.get("authorId")) == uid)
    tracks.sort(key=lambda e: _ts_of(e[1]), reverse=True)
    tracks = tracks[:LIM["global"]]
    playlists = {sk: v for sk, v in query_prefix("musicPlaylists", "%s/" % uid, limit=200)}
    favs = get_v("musicFavorites", uid)
    votes = {sk: v for sk, v in query_prefix("musicVotes", "%s/" % uid, limit=500)}
    out = {
        "tracks": [{"id": sk, "track": sanitize_media(v)} for sk, v in tracks],
        "playlists": playlists, "favorites": favs, "votes": votes,
    }
    return {"data": out,
            "count": len(tracks) + len(playlists) + _count_val(favs) + len(votes),
            "note": "Track metadata and links. Audio binaries are not embedded."}


def sec_languages(ctx):
    uid = ctx["uid"]
    exs = scan_pk("languageExercises", 600,
                  lambda sk, v: isinstance(v, dict) and str(v.get("authorId")) == uid)
    exs.sort(key=lambda e: _ts_of(e[1]), reverse=True)
    exs = exs[:LIM["global"]]
    corr = []
    for sk, v in scan_pk("exerciseCorrections", 200,
                         lambda sk, vv: str(sk).endswith("/%s" % uid)):
        corr.append({"id": sk, "correction": v})
    out = {
        "settings": get_v("userLanguages", uid),
        "exercises": [{"id": sk, "exercise": v} for sk, v in exs],
        "correctionsGiven": corr,
    }
    return {"data": out, "count": len(exs) + len(corr) + _count_val(out["settings"])}


def sec_appeals(ctx):
    uid = ctx["uid"]
    items = scan_pk("appeals", 600,
                    lambda sk, v: isinstance(v, dict) and (
                        str(v.get("authorId")) == uid or
                        str(v.get("accountUid")) == uid))
    items.sort(key=lambda e: _ts_of(e[1]), reverse=True)
    items = items[:LIM["global"]]
    out = [{"id": sk, "appeal": strip_own_email(dict(v), ctx["email"])} for sk, v in items]
    return {"data": out, "count": len(out)}


def sec_moderation_reports(ctx):
    uid = ctx["uid"]
    items = scan_pk("commentModerationQueue", 600,
                    lambda sk, v: isinstance(v, dict) and str(v.get("authorId")) == uid)
    items.sort(key=lambda e: _ts_of(e[1]), reverse=True)
    items = items[:LIM["global"]]
    out = [{"id": sk, "report": strip_own_email(dict(v), ctx["email"])} for sk, v in items]
    return {"data": out, "count": len(out)}


def sec_support_tickets(ctx):
    uid = ctx["uid"]
    out = []
    kwargs = {
        "TableName": _support_table_name(),
        "IndexName": "byUser",
        "KeyConditionExpression": "userId = :u",
        "ExpressionAttributeValues": {":u": uid},
        "ScanIndexForward": False,
        "Limit": 200,
    }
    while True:
        r = _ddb().query(**kwargs)
        out.extend(r.get("Items", []))
        lek = r.get("LastEvaluatedKey")
        if not lek or len(out) >= 200:
            break
        kwargs["ExclusiveStartKey"] = lek
    return {"data": out[:200], "count": len(out[:200]),
            "note": "Includes support team replies: part of your support history."}


def sec_parental(ctx):
    uid = ctx["uid"]
    codes = []
    for sk, v in query_prefix("parentalLinkCodes", "", limit=200):
        if isinstance(v, dict) and str(v.get("teenUid")) == uid:
            exp = v.get("expiresAt") or 0
            used = v.get("used") is True
            if used or (isinstance(exp, (int, float)) and exp < _now_ms()):
                codes.append({"createdAt": v.get("createdAt"), "expiresAt": exp, "used": used})
    out = {
        "supervisedBy": get_v("users", "%s/supervisedBy" % uid),
        "supervising": get_v("users", "%s/supervising" % uid),
        "dailyLimitMins": get_v("users", "%s/parentalControls/dailyLimitMins" % uid),
        "pastLinkCodes": codes,
    }
    return {"data": out, "count": _count_val(out["supervisedBy"]) + _count_val(out["supervising"]),
            "note": "Active link codes are single-use secrets and are never exported."}


def sec_browser_data(ctx):
    snap = (ctx.get("job") or {}).get("browserSnapshot")
    if not isinstance(snap, dict):
        snap = {}
    return {"data": strip_secrets_deep(snap), "count": len(snap),
            "note": "Data that only lives in your browser, captured when you requested the export."}


SECTIONS = [
    ("account", sec_account), ("profile", sec_profile),
    ("twoFactor", sec_two_factor), ("interests", sec_interests),
    ("posts", sec_posts), ("comments", sec_comments), ("votes", sec_votes),
    ("ecos", sec_ecos), ("saved", sec_saved), ("social", sec_social),
    ("ratings", sec_ratings), ("conversations", sec_conversations),
    ("notifications", sec_notifications), ("settings", sec_settings),
    ("securityPrefs", sec_security_prefs), ("devices", sec_devices),
    ("loginHistory", sec_login_history), ("sessions", sec_sessions),
    ("fiestas", sec_fiestas), ("groups", sec_groups), ("music", sec_music),
    ("languages", sec_languages), ("appeals", sec_appeals),
    ("moderationReports", sec_moderation_reports),
    ("supportTickets", sec_support_tickets), ("parental", sec_parental),
    ("browserData", sec_browser_data),
]
assert len(SECTIONS) == 27, "deben ser 27 secciones"

# --------------------------------------------- ensamblaje + HTML ------------
def build_payload(job, sections, failures, started_ms):
    """sections: {id: {status,count,note,error,data}}. Misma forma que el
    buildPayloadObject del cliente (version 1)."""
    lang = _lang_of(job)
    secs = {}
    total = 0
    for sid, s in sections.items():
        secs[sid] = {
            "status": s.get("status", "ok"),
            "count": s.get("count", 0),
            "note": s.get("note"),
            "error": s.get("error"),
            "data": s.get("data") if s.get("status") == "ok" else None,
        }
        total += s.get("count", 0) or 0
    ok_n = sum(1 for s in sections.values() if s.get("status") == "ok")
    payload = {
        "export": "drex-user-data",
        "version": 1,
        "generatedAt": _iso_ms(_now_ms()),
        "jobId": job["jobId"],
        "format": job.get("format", "json"),
        "language": lang,
        "account": (secs.get("account") or {}).get("data") or {
            "uid": job["sub"], "email": job.get("email")},
        "sections": secs,
        "summary": {
            "sectionsOk": ok_n,
            "sectionsFailed": len(failures),
            "totalRecords": total,
            "partialFailures": failures,
            "elapsedMs": _now_ms() - started_ms,
        },
        "limits": [{"section": s, "limit": n, "note": _tr(t, lang)}
                   for s, n, t in LIMITS],
        "excluded": [{"category": c, "reason": _tr(t, lang)}
                     for c, t in EXCLUDED],
    }
    return strip_secrets_deep(payload)


def _iso_ms(ms):
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(ms / 1000))
    except Exception:
        return ""


def render_html(payload, lang):
    """Informe HTML legible, determinista, sin <script>. Generado en servidor
    desde el mismo JSON que se exporta."""
    lang = lang if lang in ("en", "zh", "es") else "es"
    html_lang = "zh" if lang == "zh" else ("en" if lang == "en" else "es")
    doc_title = {"en": "My Drex data", "zh": "我的 Drex 数据", "es": "Mis datos de Drex"}[lang]
    e = _html.escape
    view_data = {"en": "View data", "zh": "查看数据", "es": "Ver datos"}[lang]
    summary_t = {"en": "Summary", "zh": "摘要", "es": "Resumen"}[lang]
    sections_ok_t = {"en": "sections", "zh": "个部分", "es": "secciones"}[lang]
    skipped_t = {"en": "skipped", "zh": "已跳过", "es": "omitidas"}[lang]
    failed_t = {"en": "Failed", "zh": "失败", "es": "Falló"}[lang]
    limits_h = ({"en": ("Section", "Limit", "Note"),
                 "zh": ("部分", "限制", "说明"),
                 "es": ("Sección", "Límite", "Nota")})[lang]
    excl_h = ({"en": ("Excluded", "Why"), "zh": ("已排除", "原因"),
               "es": ("Excluido", "Por qué")})[lang]
    limits_title = {"en": "About this file", "zh": "关于此文件",
                    "es": "Sobre este archivo"}[lang]
    limits_body = _tr(LIMITS and {"en": "Large sections include the most recent items to keep the file usable. Media files list their links; audio/video binaries are not embedded.",
                                  "es": "Las secciones grandes incluyen los elementos más recientes para que el archivo sea manejable. Los archivos multimedia listan sus enlaces; el audio/video binario no se incrusta.",
                                  "zh": "较大的部分仅包含最近的项目，以保持文件可用。媒体文件仅列出链接；不嵌入音视频二进制文件。"}, lang)
    privacy_note = {"en": "Only your data. Secrets and other people's data are never included.",
                    "zh": "仅包含你的数据。绝不包含密钥和其他人的数据。",
                    "es": "Solo tus datos. Los secretos y los datos de otras personas nunca se incluyen."}[lang]

    p = []
    p.append('<!DOCTYPE html><html lang="%s"><head><meta charset="utf-8">' % html_lang)
    p.append('<meta name="viewport" content="width=device-width, initial-scale=1">')
    p.append("<title>" + e(doc_title) + "</title>")
    p.append("<style>"
             "body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#eef2f7;color:#1c2b4a;margin:0;padding:0}"
             ".hdr{background:#1c2b4a;color:#fff;padding:32px 24px}"
             ".hdr h1{margin:0 0 6px;font-size:26px}"
             ".hdr .wave{color:#8fa2ff;font-weight:700}"
             ".hdr p{margin:4px 0;opacity:.85;font-size:14px}"
             ".wrap{max-width:860px;margin:0 auto;padding:20px 16px 60px}"
             ".card{background:#fff;border-radius:14px;padding:18px 20px;margin:14px 0;box-shadow:0 1px 3px rgba(28,43,74,.08)}"
             ".card h2{margin:0 0 8px;font-size:18px;color:#1c2b4a}"
             ".meta{font-size:13px;color:#5c6974}"
             ".badge{display:inline-block;font-size:12px;font-weight:700;border-radius:999px;padding:2px 10px;margin-left:8px}"
             ".ok{background:#e6f6ec;color:#137333}.bad{background:#fdecea;color:#b3261e}"
             "details{margin-top:10px}summary{cursor:pointer;color:#2F33B8;font-weight:600;font-size:14px}"
             "pre{background:#f0f4f9;border-radius:10px;padding:12px;overflow:auto;font-size:12px;max-height:420px}"
             "table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #dce1e5;padding:6px 8px;text-align:left;vertical-align:top}"
             "th{background:#eef2f7}"
             ".foot{font-size:12px;color:#5c6974;margin-top:26px}"
             "</style></head><body>")
    acct = payload.get("account") or {}
    p.append('<div class="hdr"><h1><span class="wave">((•))</span> Drex — ' + e(doc_title) + "</h1>"
             "<p>" + e(payload.get("generatedAt") or "") + " · " + e(acct.get("email") or "") + "</p></div>")
    p.append('<div class="wrap">')
    s = payload.get("summary") or {}
    p.append('<div class="card"><h2>' + e(summary_t) + "</h2>"
             '<p class="meta">' + str(s.get("sectionsOk", 0)) + " / 27 " + e(sections_ok_t) +
             (" · " + '<span class="badge bad">' + str(s.get("sectionsFailed", 0)) + " " + e(skipped_t) + "</span>"
              if s.get("sectionsFailed") else ' <span class="badge ok">OK</span>') + "</p>"
             '<p class="meta">' + e(limits_body) + "</p></div>")
    for sid, sec in (payload.get("sections") or {}).items():
        title = _tr(SECTION_TITLES.get(sid, sid), lang)
        badge = ('<span class="badge ok">' + str(sec.get("count", 0)) + "</span>"
                 if sec.get("status") == "ok"
                 else '<span class="badge bad">' + e(failed_t) + "</span>")
        p.append('<div class="card"><h2>' + e(title) + badge + "</h2>")
        if sec.get("note"):
            p.append('<p class="meta">' + e(str(sec["note"])) + "</p>")
        if sec.get("error"):
            p.append('<p class="meta">Error: ' + e(str(sec["error"])) + "</p>")
        if sec.get("status") == "ok" and sec.get("data") is not None:
            js = json.dumps(sec["data"], ensure_ascii=False, indent=2)
            if len(js) > 60000:
                js = js[:60000] + "\n…[truncado]"
            p.append("<details><summary>" + e(view_data) + "</summary><pre>" + e(js) + "</pre></details>")
        p.append("</div>")
    p.append('<div class="card"><h2>' + e(limits_title) + "</h2><table><tr><th>" +
             e(limits_h[0]) + "</th><th>" + e(limits_h[1]) + "</th><th>" + e(limits_h[2]) + "</th></tr>")
    for l in payload.get("limits") or []:
        p.append("<tr><td>" + e(str(l.get("section"))) + "</td><td>" + e(str(l.get("limit"))) +
                 "</td><td>" + e(str(l.get("note"))) + "</td></tr>")
    p.append("</table></div>")
    p.append('<div class="card"><h2>' + e(privacy_note) + "</h2><table><tr><th>" +
             e(excl_h[0]) + "</th><th>" + e(excl_h[1]) + "</th></tr>")
    for x in payload.get("excluded") or []:
        p.append("<tr><td><code>" + e(str(x.get("category"))) + "</code></td><td>" +
                 e(str(x.get("reason"))) + "</td></tr>")
    p.append("</table></div>")
    p.append('<p class="foot">Drex · ' + e(doc_title) + " · " + e(payload.get("jobId") or "") + "</p>")
    p.append("</div></body></html>")
    return "".join(p)


# ------------------------------------------------------------ notificaciones -
def write_notification(sub, job_id, ok, lang):
    key = "ready" if ok else "failed"
    notif = {
        "type": "data_export",
        "title": _tr(NOTIF_STRINGS[key + "_title"], lang),
        "body": _tr(NOTIF_STRINGS[key + "_body"], lang),
        "jobId": job_id,
        "timestamp": _now_ms(),
        "read": False,
    }
    put_v("notifications", "%s/exp_%s" % (sub, job_id), notif)

# ------------------------------------------------------- accion: request ----
def _validate_snapshot(raw):
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise HttpError(400, "bad_snapshot", "bad_snapshot")
    try:
        blob = json.dumps(raw, ensure_ascii=False)
    except Exception:
        raise HttpError(400, "bad_snapshot", "bad_snapshot")
    if len(blob.encode("utf-8")) > MAX_SNAPSHOT_BYTES:
        raise HttpError(400, "snapshot_too_large", "snapshot_too_large")
    # Defensa en profundidad: el snapshot es dato no confiable del cliente.
    return strip_secrets_deep(raw)


def action_request(event, body, origin):
    token = _bearer(event)
    sub, attrs = verify_token(token)
    ip = _client_ip(event)

    fmt = body.get("format")
    fmt = "html" if fmt == "html" else "json"
    lang = body.get("lang")
    lang = lang if lang in ("en", "zh", "es") else "es"
    snapshot = _validate_snapshot(body.get("browserSnapshot"))

    if _rate_limited("export", sub, RL_EXPORT_USER_MAX, RL_EXPORT_USER_WINDOW):
        raise HttpError(429, "too_many_requests")
    if _rate_limited("exportip", ip, RL_EXPORT_IP_MAX, RL_EXPORT_IP_WINDOW):
        raise HttpError(429, "too_many_requests")

    # Idempotencia: un solo job activo por usuario.
    active = find_active_job(sub)
    if active:
        return _resp(200, {"jobId": active["jobId"], "status": active["status"],
                           "alreadyActive": True,
                           "message": _tr(
                               {"en": "You already have a request in progress.",
                                "es": "Ya tienes una solicitud en curso.",
                                "zh": "你已有一个进行中的申请。"}, lang)}, origin)

    now = _now_ms()
    job_id = "ex_" + uuid.uuid4().hex[:16]
    job = {
        "jobId": job_id, "sub": sub, "format": fmt, "language": lang,
        "status": "requested", "createdAt": now, "updatedAt": now,
        "lastHeartbeat": now,
        "expiresAt": now + JOB_TTL_MS,
        "ttl": _now_s() + JOB_TTL_MS // 1000 + JOB_TTL_ATTR_S,
        "progress": {"done": 0, "total": len(SECTIONS), "current": None},
        "summary": None, "error": None,
        "fileKey": None, "fileSize": None, "fileSha256": None,
        "attempts": 0, "workerToken": secrets.token_hex(32),
        "browserSnapshot": snapshot,
        "requestedFrom": "web",
        "email": attrs.get("email"),
    }
    write_job(job)

    # Dispara el worker asincrono (sobrevive al cierre de la pestana).
    try:
        fn_name = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "drex-data-export")
        _lam().invoke(
            FunctionName=fn_name,
            InvocationType="Event",
            Payload=json.dumps({
                "internal": "worker", "jobId": job_id, "sub": sub,
                "format": fmt, "workerToken": job["workerToken"], "cursor": None,
            }).encode("utf-8"),
        )
    except Exception as e:
        # Si no se pudo invocar, el job queda en requested con error honesto;
        # el cliente puede reintentar (el sweep/worker futuro lo retomaria).
        job["status"] = "failed"
        job["error"] = {"code": "worker_invoke_failed",
                        "message": "worker_invoke_failed"}
        write_job(job)
        print(json.dumps({"evt": "worker_invoke_failed", "jobId": job_id,
                          "err": type(e).__name__}))
        raise HttpError(500, "worker_invoke_failed")

    return _resp(200, {
        "jobId": job_id, "status": "requested", "alreadyActive": False,
        "message": _tr(
            {"en": "Request received. We are preparing your file; we will notify you when it is ready.",
             "es": "Solicitud recibida. Estamos preparando tu archivo; te avisaremos cuando esté listo.",
             "zh": "已收到申请。我们正在准备你的文件，准备好后会通知你。"}, lang),
    }, origin)


# -------------------------------------------------- accion: download-url ---
def action_download_url(event, body, origin):
    token = _bearer(event)
    sub, _attrs = verify_token(token)
    job_id = body.get("jobId")
    if not job_id or not isinstance(job_id, str):
        raise HttpError(400, "bad_job_id")

    if _rate_limited("exportdl", sub, RL_DL_USER_MAX, RL_DL_USER_WINDOW):
        raise HttpError(429, "too_many_requests")

    # El job se lee SIEMPRE bajo el sub del token: 404 generico para
    # jobs ajenos o inexistentes (sin enumeracion).
    job = read_job(sub, job_id)
    if not job:
        raise HttpError(404, "not_found")
    if job.get("status") not in ("ready", "downloaded"):
        raise HttpError(409, "not_ready")
    if _now_ms() > int(job.get("expiresAt") or 0):
        raise HttpError(410, "expired")

    key = job.get("fileKey")
    if not key:
        raise HttpError(404, "not_found")
    try:
        head = _s3().head_object(Bucket=BUCKET, Key=key)
    except Exception:
        raise HttpError(404, "not_found")
    size = head.get("ContentLength") or job.get("fileSize") or 0

    url = _s3().generate_presigned_url(
        "get_object",
        Params={"Bucket": BUCKET, "Key": key},
        ExpiresIn=PRESIGNED_TTL_S,
    )
    ext = "html" if job.get("format") == "html" else "json"
    day = time.strftime("%Y-%m-%d", time.gmtime((job.get("createdAt") or _now_ms()) / 1000))
    return _resp(200, {
        "url": url,
        "expiresIn": PRESIGNED_TTL_S,
        "filename": "drex-mis-datos-%s.%s" % (day, ext),
        "sha256": job.get("fileSha256"),
        "size": size,
    }, origin)


# ------------------------------------------------------------------ worker -
def _self_invoke(payload):
    fn_name = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "drex-data-export")
    _lam().invoke(FunctionName=fn_name, InvocationType="Event",
                  Payload=json.dumps(payload).encode("utf-8"))


def _remaining_ms(context):
    try:
        return context.get_remaining_time_in_millis()
    except Exception:
        return 15 * 60 * 1000


def _partial_key(sub, job_id):
    return "exports/%s/%s.partial.json" % (sub, job_id)


def run_worker(payload, context):
    job_id = payload.get("jobId")
    sub = payload.get("sub")
    token = payload.get("workerToken") or ""
    cursor = payload.get("cursor") or {}
    if not job_id or not sub:
        print(json.dumps({"evt": "worker_bad_payload"}))
        return {"ok": False, "reason": "bad_payload"}

    job = read_job(sub, job_id)
    if not job:
        print(json.dumps({"evt": "worker_job_missing", "jobId": job_id}))
        return {"ok": False, "reason": "job_missing"}
    # Anti-confused-deputy: solo la invocacion con el token del job continua.
    if not hmac.compare_digest(str(job.get("workerToken") or ""),
                               str(token)):
        print(json.dumps({"evt": "worker_token_mismatch", "jobId": job_id}))
        return {"ok": False, "reason": "token_mismatch"}
    # Si el usuario cancelo o el sweep expiro el job, no seguir trabajando.
    if job.get("status") not in ("requested", "preparing"):
        print(json.dumps({"evt": "worker_aborted_status",
                          "jobId": job_id, "status": job.get("status")}))
        return {"ok": False, "reason": "status_" + str(job.get("status"))}

    started = _now_ms()
    lang = _lang_of(job)
    ctx = {"uid": sub, "email": job.get("email") or "", "job": job}
    sections = {}
    failures = []

    # Continuacion: secciones ya hechas viven en el parcial de S3.
    start_idx = int(cursor.get("nextSection") or 0)
    partial_key = cursor.get("partialKey")
    if start_idx > 0 and partial_key:
        try:
            raw = _s3().get_object(Bucket=BUCKET, Key=partial_key)["Body"].read()
            prev = json.loads(raw.decode("utf-8"))
            sections.update(prev.get("sections") or {})
            failures.extend(prev.get("failures") or [])
        except Exception as e:
            print(json.dumps({"evt": "worker_partial_missing", "jobId": job_id,
                              "err": type(e).__name__}))

    job["status"] = "preparing"
    job["attempts"] = int(job.get("attempts") or 0) + 1
    job["updatedAt"] = started
    job["lastHeartbeat"] = started
    job["progress"] = {"done": len(sections), "total": len(SECTIONS),
                       "current": None}
    write_job(job)

    try:
        for idx in range(start_idx, len(SECTIONS)):
            sid, runner = SECTIONS[idx]
            # Releer estado: el usuario pudo cancelar desde otro dispositivo.
            cur = read_job(sub, job_id) or {}
            if cur.get("status") not in ("requested", "preparing"):
                print(json.dumps({"evt": "worker_cancelled", "jobId": job_id,
                                  "section": sid}))
                return {"ok": False, "reason": "cancelled"}
            try:
                res = runner(ctx) or {}
                sections[sid] = {
                    "status": "ok",
                    "count": int(res.get("count") or 0),
                    "note": res.get("note"),
                    "error": None,
                    "data": res.get("data"),
                }
            except Exception as e:
                # Fallo parcial honesto: se registra y se continua.
                print(json.dumps({"evt": "worker_section_failed",
                                  "jobId": job_id, "section": sid,
                                  "err": type(e).__name__}))
                failures.append({"category": sid, "error": "read_failed"})
                sections[sid] = {"status": "failed", "count": 0,
                                 "note": None, "error": "read_failed", "data": None}
            now = _now_ms()
            job["progress"] = {"done": len(sections), "total": len(SECTIONS),
                               "current": sid}
            job["updatedAt"] = now
            job["lastHeartbeat"] = now
            write_job(job)

            # Si queda poco tiempo, guardar cursor y continuar en otra invocacion.
            if (idx + 1) < len(SECTIONS) and _remaining_ms(context) < WORKER_TIME_GUARD_MS:
                pkey = _partial_key(sub, job_id)
                _s3().put_object(
                    Bucket=BUCKET, Key=pkey,
                    Body=json.dumps({"sections": sections,
                                     "failures": failures},
                                    ensure_ascii=False).encode("utf-8"),
                    ContentType="application/json",
                    ServerSideEncryption="AES256",
                )
                cur2 = read_job(sub, job_id) or job
                cur2["cursor"] = {"nextSection": idx + 1, "partialKey": pkey}
                cur2["updatedAt"] = _now_ms()
                cur2["lastHeartbeat"] = _now_ms()
                write_job(cur2)
                _self_invoke({"internal": "worker", "jobId": job_id,
                              "sub": sub, "format": job.get("format", "json"),
                              "workerToken": job.get("workerToken"),
                              "cursor": {"nextSection": idx + 1,
                                         "partialKey": pkey}})
                print(json.dumps({"evt": "worker_continued", "jobId": job_id,
                                  "nextSection": idx + 1}))
                return {"ok": True, "continued": True}

        # Ensamblar: JSON (+HTML desde el mismo contenido) en servidor.
        payload_doc = build_payload(job, sections, failures, started)
        json_bytes = json.dumps(payload_doc, ensure_ascii=False,
                                indent=2).encode("utf-8")
        if len(json_bytes) > MAX_EXPORT_BYTES:
            raise _TooLarge()
        sha = hashlib.sha256(json_bytes).hexdigest()
        html_bytes = render_html(payload_doc, lang).encode("utf-8")

        json_key = "exports/%s/%s.json" % (sub, job_id)
        html_key = "exports/%s/%s.html" % (sub, job_id)
        _s3().put_object(Bucket=BUCKET, Key=json_key, Body=json_bytes,
                         ContentType="application/json; charset=utf-8",
                         ServerSideEncryption="AES256",
                         Metadata={"sha256": sha})
        _s3().put_object(Bucket=BUCKET, Key=html_key, Body=html_bytes,
                         ContentType="text/html; charset=utf-8",
                         ServerSideEncryption="AES256",
                         Metadata={"sha256": hashlib.sha256(html_bytes).hexdigest()})
        # Limpiar parcial de continuacion si existio.
        try:
            if partial_key:
                _s3().delete_object(Bucket=BUCKET, Key=partial_key)
        except Exception:
            pass

        fin = read_job(sub, job_id) or job
        fin["status"] = "ready"
        fin["fileKey"] = json_key if job.get("format") != "html" else html_key
        fin["fileJsonKey"] = json_key
        fin["fileHtmlKey"] = html_key
        fin["fileSize"] = len(json_bytes if job.get("format") != "html" else html_bytes)
        fin["fileSha256"] = (sha if job.get("format") != "html"
                             else hashlib.sha256(html_bytes).hexdigest())
        fin["summary"] = {
            "sections": len(SECTIONS),
            "sectionsOk": sum(1 for s in sections.values() if s.get("status") == "ok"),
            "items": sum(int(s.get("count") or 0) for s in sections.values()),
            "bytes": len(json_bytes),
            "ms": _now_ms() - started,
        }
        fin["progress"] = {"done": len(SECTIONS), "total": len(SECTIONS),
                           "current": None}
        fin["updatedAt"] = _now_ms()
        fin["lastHeartbeat"] = _now_ms()
        fin.pop("cursor", None)
        write_job(fin)
        write_notification(sub, job_id, True, lang)
        print(json.dumps({"evt": "worker_ready", "jobId": job_id,
                          "bytes": len(json_bytes)}))
        return {"ok": True}
    except _TooLarge:
        _fail_job(sub, job_id, "too_large", lang)
        return {"ok": False, "reason": "too_large"}
    except Exception as e:
        # Nunca PII en logs: solo jobId y clase de error.
        print(json.dumps({"evt": "worker_failed", "jobId": job_id,
                          "err": type(e).__name__}))
        _fail_job(sub, job_id, "worker_error", lang)
        return {"ok": False, "reason": "worker_error"}


class _TooLarge(Exception):
    pass


def _fail_job(sub, job_id, code, lang):
    job = read_job(sub, job_id) or {"jobId": job_id, "sub": sub}
    job["status"] = "failed"
    job["error"] = {"code": code, "message": code}
    job["updatedAt"] = _now_ms()
    job["lastHeartbeat"] = _now_ms()
    write_job(job)
    try:
        write_notification(sub, job_id, False, lang)
    except Exception:
        pass
    # Limpiar parcial si quedo.
    try:
        _s3().delete_object(Bucket=BUCKET, Key=_partial_key(sub, job_id))
    except Exception:
        pass


# ------------------------------------------------------------------- sweep --
def run_sweep():
    """EventBridge diario: marca expired los jobs vencidos; borra jobs y
    objetos de cuentas eliminadas. Nunca escribe PII en logs."""
    now = _now_ms()
    marked = 0
    cleaned_accounts = 0
    # Scan acotado: solo candidatos con '/dataExports/' en la sk.
    kwargs = {
        "TableName": TABLE_NAME,
        "FilterExpression": "contains(sk, :m)",
        "ExpressionAttributeValues": {":m": "/dataExports/"},
        "ProjectionExpression": "pk, sk",
    }
    while True:
        r = _ddb().scan(**kwargs)
        for it in r.get("Items", []):
            pk, sk = it.get("pk"), it.get("sk") or ""
            parts = sk.split("/")
            if len(parts) < 3:
                continue
            sub, job_id = parts[0], parts[2]
            job = read_job(sub, job_id)
            if not isinstance(job, dict):
                continue
            status = job.get("status")
            try:
                if int(job.get("expiresAt") or 0) < now and status in ("ready", "failed", "downloaded"):
                    job["status"] = "expired"
                    job["updatedAt"] = now
                    write_job(job)
                    marked += 1
                    continue
                # Cuenta eliminada: borrar job + objetos de inmediato.
                try:
                    _idp().admin_get_user(UserPoolId=POOL_ID, Username=sub)
                except Exception as e:
                    if _err_code(e) == "UserNotFoundException":
                        for k in (job.get("fileJsonKey"), job.get("fileHtmlKey"),
                                  job.get("fileKey"), _partial_key(sub, job_id)):
                            if k:
                                try:
                                    _s3().delete_object(Bucket=BUCKET, Key=k)
                                except Exception:
                                    pass
                        try:
                            _ddb().delete_item(
                                TableName=TABLE_NAME,
                                Key={"pk": "users", "sk": job_sk(sub, job_id)})
                        except Exception:
                            pass
                        cleaned_accounts += 1
            except Exception as e:
                print(json.dumps({"evt": "sweep_item_failed", "jobId": job_id,
                                  "err": type(e).__name__}))
        lek = r.get("LastEvaluatedKey")
        if not lek:
            break
        kwargs["ExclusiveStartKey"] = lek
    print(json.dumps({"evt": "sweep_done", "markedExpired": marked,
                      "cleanedAccounts": cleaned_accounts}))
    return {"markedExpired": marked, "cleanedAccounts": cleaned_accounts}


# ---------------------------------------------------------------- handler ---
def lambda_handler(event, context=None):
    """Despacha: interno (worker/sweep) o Function URL (request/download-url)."""
    event = event or {}
    internal = event.get("internal")
    if internal == "worker":
        return run_worker(event, context)
    if internal == "sweep":
        return run_sweep()

    origin = _origin(event)
    method = ""
    try:
        method = (event.get("requestContext") or {}).get("http", {}).get("method", "")
    except Exception:
        pass
    if not method:
        method = event.get("httpMethod", "")
    if method == "OPTIONS":
        h = _cors_headers(origin)
        h["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        h["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        h["Access-Control-Max-Age"] = "600"
        return {"statusCode": 200, "headers": h, "body": ""}
    if method and method != "POST":
        return _resp(405, {"error": "method_not_allowed"}, origin)

    body = _parse_body(event)
    action = body.get("action")
    try:
        if action == "request":
            return action_request(event, body, origin)
        if action == "download-url":
            return action_download_url(event, body, origin)
        return _resp(400, {"error": "bad_action"}, origin)
    except HttpError as e:
        return _resp(e.status, {"error": e.code}, origin)
    except Exception as e:  # nunca filtrar detalles internos
        print(json.dumps({"evt": "unhandled", "action": str(action),
                          "err": type(e).__name__}))
        return _resp(500, {"error": "internal_error"}, origin)
