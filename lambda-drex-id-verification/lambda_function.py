"""
drex-id-verification — Lambda Python 3.12 para verificación de edad con documento de identidad.

Arquitectura con adaptador:
    IdentityProvider (interfaz) -> VeriffProvider (producción) / DemoProvider (demo)

Modo por defecto: DREX_IDV_MODE=demo (simula el flujo completo sin keys reales).
Modo producción: DREX_IDV_MODE=production + VERIFF_API_KEY / VERIFF_SECRET_KEY.

Rutas (Function URL):
    POST /session      -> crea sesión de verificación (auth: Cognito Bearer)
    GET  /status       -> estado de birthdayVerification del usuario (auth: Cognito Bearer)
    POST /webhook      -> webhook de Veriff firmado HMAC-SHA256
    GET  /demo/verify  -> página demo (solo modo demo)
    POST /demo/complete-> completa una sesión demo (solo modo demo)

Modelo de datos (DynamoDB drex-kv, un ítem por atributo):
    pk='users', sk='<sub>/birthdayVerification'
        v = {"status": "none|pending|verified|rejected|expired",
             "country": "CU", "verifiedAt": <ms>, "method": "id_document",
             "provider": "veriff|demo"}
    pk='users', sk='<sub>/idVerification/sessions/<sessionId>'
        v = {"status": "pending|verified|rejected|expired", "country": ..., 
             "documentType": ..., "provider": "veriff|demo", "mode": "demo|production",
             "providerSessionId": ..., "verificationUrl": ..., "createdAt": <ms>,
             "updatedAt": <ms>, "demoToken": ... (solo demo)}
    pk='users', sk='<sub>/idVerification/rate/<YYYY-MM-DD>'     -> {"count": N}
    pk='users', sk='idVerification/providerIndex/<providerSessionId>' -> {"sub": ..., "sessionId": ...}
    pk='users', sk='idVerification/demoIndex/<demoToken>'             -> {"sub": ..., "sessionId": ...}
    pk='users', sk='idv_ip_rate/<ip>/<YYYY-MM-DD>'                     -> {"count": N}
    pk='notifications', sk='<sub>/<pushId>'
        v = {"message": ..., "timestamp": <ms>, "read": False,
             "type": "id_verification", "notificationId": <pushId>, "system": True, ...}

REGLA DE PRIVACIDAD: los logs NUNCA incluyen PII (números de documento, imágenes,
nombres, emails). Solo sessionId + clase de evento. Los secretos no se loguean.
"""

import base64
import hashlib
import hmac
import html as _html
import json
import os
import secrets
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

try:
    import boto3
except ImportError:  # pragma: no cover - en Lambda boto3 existe siempre
    boto3 = None

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------

AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
KV_TABLE = os.environ.get("KV_TABLE", "drex-kv")
IDV_MODE = os.environ.get("DREX_IDV_MODE", "demo").lower()  # demo | production

VERIFF_BASE_URL = os.environ.get("VERIFF_BASE_URL", "https://stationapi.veriff.com/v1")
VERIFF_API_KEY = os.environ.get("VERIFF_API_KEY", "")
VERIFF_SECRET_KEY = os.environ.get("VERIFF_SECRET_KEY", "")

ALLOWED_COUNTRIES = {"CU", "US", "CA", "MX", "BR"}
ALLOWED_DOC_TYPES = {"passport", "id_card", "driving_licence"}
# Alias que envía el cliente Drex (IDV_DOCS_BY_COUNTRY) -> tipo canónico interno.
DOC_TYPE_ALIASES = {"national_id": "id_card",
                    "drivers_license": "driving_licence"}
VERIFF_DOC_TYPES = {"passport": "PASSPORT", "id_card": "ID_CARD",
                    "driving_licence": "DRIVERS_LICENSE"}

MAX_SESSIONS_PER_USER_DAY = int(os.environ.get("IDV_MAX_SESSIONS_PER_USER_DAY", "5"))
MAX_SESSIONS_PER_IP_DAY = int(os.environ.get("IDV_MAX_SESSIONS_PER_IP_DAY", "20"))

# Cabecera de firma de webhook de Veriff (documentada en devdocs.veriff.com)
WEBHOOK_SIG_HEADER = "x-hmac-signature"

_users_table = None
_cognito_client = None


# ---------------------------------------------------------------------------
# Clientes AWS (inyectables para tests)
# ---------------------------------------------------------------------------

def get_dynamodb_table():
    global _users_table
    if _users_table is None:
        if boto3 is None:
            raise RuntimeError("boto3 no disponible")
        _users_table = boto3.resource("dynamodb", region_name=AWS_REGION).Table(KV_TABLE)
    return _users_table


def get_cognito_client():
    global _cognito_client
    if _cognito_client is None:
        if boto3 is None:
            raise RuntimeError("boto3 no disponible")
        _cognito_client = boto3.client("cognito-idp", region_name=AWS_REGION)
    return _cognito_client


# ---------------------------------------------------------------------------
# Reloj (inyectable para tests)
# ---------------------------------------------------------------------------

def now_ms():
    return int(time.time() * 1000)


def utc_today():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def utc_iso(dt=None):
    dt = dt or datetime.now(timezone.utc)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Logging sin PII
# ---------------------------------------------------------------------------

def log(event_class, **fields):
    """Log estructurado. 'fields' solo debe contener sessionId y clase de evento,
    NUNCA datos del documento, nombres, emails, bodies ni secretos."""
    safe = {"ts": utc_iso(), "ev": event_class}
    for k, v in fields.items():
        safe[k] = v
    print(json.dumps(safe, default=str))


# ---------------------------------------------------------------------------
# Adaptador de proveedor de identidad
# ---------------------------------------------------------------------------

class IdentityProvider:
    """Interfaz del proveedor de verificación. Para cambiar de proveedor se crea
    una subclase que implemente estos dos métodos; el resto del código no cambia."""

    name = "base"

    def create_session(self, *, country, document_type, vendor_data, callback_url):
        """Crea una sesión de verificación.
        Retorna dict {provider_session_id, verification_url, expires_at_iso}."""
        raise NotImplementedError

    def verify_webhook(self, raw_body: bytes, headers: dict) -> bool:
        """Verifica la firma del webhook. Retorna True si la firma es válida."""
        raise NotImplementedError


def veriff_http_post(url, headers, body_bytes, timeout=15):
    """Llamada HTTP POST (stdlib). Separada para poder mockearla en tests."""
    req = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


class VeriffProvider(IdentityProvider):
    """Proveedor Veriff (producción). Requiere VERIFF_API_KEY y VERIFF_SECRET_KEY."""

    name = "veriff"

    def __init__(self, api_key, secret_key, base_url=VERIFF_BASE_URL):
        if not api_key or not secret_key:
            raise RuntimeError("Faltan VERIFF_API_KEY / VERIFF_SECRET_KEY")
        self.api_key = api_key
        self.secret_key = secret_key
        self.base_url = base_url.rstrip("/")

    def _sign(self, payload_bytes: bytes) -> str:
        return hmac.new(self.secret_key.encode("utf-8"), payload_bytes,
                        hashlib.sha256).hexdigest()

    def create_session(self, *, country, document_type, vendor_data, callback_url):
        payload = {
            "verification": {
                "document": {
                    "type": VERIFF_DOC_TYPES[document_type],
                    "country": country,
                },
                "timestamp": utc_iso(),
                "callback": callback_url,
                "vendorData": vendor_data,
            }
        }
        body = json.dumps(payload).encode("utf-8")
        # POST /sessions requiere solo X-AUTH-CLIENT; se envía la firma también
        # (regla general de Veriff para el resto de endpoints).
        headers = {
            "Content-Type": "application/json",
            "X-AUTH-CLIENT": self.api_key,
            "X-HMAC-SIGNATURE": self._sign(body),
        }
        status, raw = veriff_http_post(self.base_url + "/sessions", headers, body)
        if status not in (200, 201):
            raise RuntimeError("Veriff create session HTTP %s" % status)
        data = json.loads(raw.decode("utf-8"))
        v = data.get("verification", data)
        if not v.get("id") or not v.get("url"):
            raise RuntimeError("Respuesta inesperada de Veriff")
        return {
            "provider_session_id": v["id"],
            "verification_url": v["url"],
            "expires_at_iso": v.get("expiresAt") or v.get("expires_at"),
        }

    def verify_webhook(self, raw_body: bytes, headers: dict) -> bool:
        sig = (headers.get(WEBHOOK_SIG_HEADER)
               or headers.get("X-Hmac-Signature")
               or headers.get("X-HMAC-SIGNATURE") or "")
        if not sig:
            return False
        expected = self._sign(raw_body)
        return hmac.compare_digest(expected, sig.lower())


class DemoProvider(IdentityProvider):
    """Proveedor demo: simula el flujo completo sin llamar a Veriff.
    La verificación se completa en la página demo (GET /demo/verify) con un
    token aleatorio de un solo uso."""

    name = "demo"

    def create_session(self, *, country, document_type, vendor_data, callback_url):
        # vendor_data llega como "<sub>::<session_id>"; el demo token identifica la sesión.
        return {"provider_session_id": None, "verification_url": None,
                "expires_at_iso": None}

    def verify_webhook(self, raw_body: bytes, headers: dict) -> bool:
        # El modo demo no usa el webhook firmado; usa /demo/complete con token.
        return False


def get_provider() -> IdentityProvider:
    if IDV_MODE == "production":
        return VeriffProvider(VERIFF_API_KEY, VERIFF_SECRET_KEY)
    return DemoProvider()


# ---------------------------------------------------------------------------
# Utilidades de DynamoDB (convención drex-kv: un ítem por atributo)
# ---------------------------------------------------------------------------

def db_get(pk, sk):
    resp = get_dynamodb_table().get_item(Key={"pk": pk, "sk": sk})
    item = resp.get("Item")
    if not item:
        return None
    try:
        return json.loads(item["v"])
    except (KeyError, TypeError, ValueError):
        return None


def db_put(pk, sk, value):
    get_dynamodb_table().put_item(
        Item={"pk": pk, "sk": sk, "v": json.dumps(value)})


def db_bump_counter(pk, sk):
    """Incremento atómico; retorna el nuevo valor."""
    resp = get_dynamodb_table().update_item(
        Key={"pk": pk, "sk": sk},
        UpdateExpression="ADD #n :one",
        ExpressionAttributeNames={"#n": "n"},
        ExpressionAttributeValues={":one": 1},
        ReturnValues="UPDATED_NEW",
    )
    return int(resp["Attributes"]["n"])


def push_id():
    """ID estilo push de Firebase (20 chars, ordenado por tiempo), como los que
    genera DrexCloud.database().ref(...).push() en la app."""
    PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz"
    now = now_ms()
    time_chars = []
    for _ in range(8):
        time_chars.append(PUSH_CHARS[now % 64])
        now //= 64
    time_chars.reverse()
    rand = [PUSH_CHARS[secrets.randbelow(64)] for _ in range(12)]
    return "".join(time_chars + rand)


# ---------------------------------------------------------------------------
# Notificaciones in-app
# ---------------------------------------------------------------------------

IDV_NOTIF_MESSAGES = {
    "verified": {
        "es": "✅ Tu identidad fue verificada. Ya puedes usar las funciones para mayores de edad.",
        "en": "✅ Your identity was verified. You can now use adult features.",
    },
    "rejected": {
        "es": "❌ Tu verificación de identidad no fue aprobada. Revisa tu documento e inténtalo de nuevo.",
        "en": "❌ Your identity verification was not approved. Check your document and try again.",
    },
    "resubmission": {
        "es": "⚠️ Necesitamos más información para verificar tu identidad. Completa el paso pendiente.",
        "en": "⚠️ We need more information to verify your identity. Please complete the pending step.",
    },
    "expired": {
        "es": "⌛ Tu sesión de verificación de identidad expiró. Inicia una nueva cuando quieras.",
        "en": "⌛ Your identity verification session expired. Start a new one whenever you like.",
    },
}

NOTIF_LANG = "es"  # la app Drex es ES por defecto


def write_notification(sub, kind, meta=None):
    nid = push_id()
    data = {
        "message": IDV_NOTIF_MESSAGES[kind][NOTIF_LANG],
        "timestamp": now_ms(),
        "read": False,
        "type": "id_verification",  # no mapeado en notifTypeToPrefKey -> nunca se ignora
        "notificationId": nid,
        "system": True,
        "actionType": "id_verification",
        "section": "security",
    }
    if meta:
        data.update(meta)
    db_put("notifications", "%s/%s" % (sub, nid), data)
    return nid


# ---------------------------------------------------------------------------
# Auth: Cognito Bearer -> sub (anti-IDOR: el sub sale SOLO del token)
# ---------------------------------------------------------------------------

def authenticate(event):
    """Valida 'Authorization: Bearer <Cognito access token>' con Cognito GetUser.
    Retorna (sub, attrs) o lanza AuthError."""
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    authz = headers.get("authorization", "")
    if not authz.startswith("Bearer "):
        raise AuthError("missing_bearer")
    token = authz[len("Bearer "):].strip()
    if not token:
        raise AuthError("missing_bearer")
    try:
        resp = get_cognito_client().get_user(AccessToken=token)
    except Exception as e:
        # NotAuthorizedException, InvalidParameterException, etc.
        log("auth_failed", reason=type(e).__name__)
        raise AuthError("invalid_token")
    attrs = {a["Name"]: a["Value"] for a in resp.get("UserAttributes", [])}
    sub = attrs.get("sub")
    if not sub:
        log("auth_failed", reason="no_sub")
        raise AuthError("invalid_token")
    return sub, attrs


class AuthError(Exception):
    pass


def client_ip(event):
    rc = event.get("requestContext") or {}
    http = rc.get("http") or {}
    return http.get("sourceIp", "unknown")


# ---------------------------------------------------------------------------
# Lógica de negocio
# ---------------------------------------------------------------------------

def create_idv_session(sub, country, document_type, function_url):
    today = utc_today()

    # Rate limit por usuario
    n = db_bump_counter("users", "%s/idVerification/rate/%s" % (sub, today))
    if n > MAX_SESSIONS_PER_USER_DAY:
        log("rate_limited", scope="user", sessions_today=n)
        raise RateLimited("user")

    session_id = secrets.token_hex(16)
    created = now_ms()
    provider = get_provider()

    if provider.name == "veriff":
        result = provider.create_session(
            country=country,
            document_type=document_type,
            vendor_data=session_id,
            callback_url=function_url.rstrip("/") + "/webhook",
        )
        verification_url = result["verification_url"]
        provider_session_id = result["provider_session_id"]
        expires_at = result.get("expires_at_iso")
        demo_token = None
    else:
        demo_token = secrets.token_urlsafe(32)
        verification_url = function_url.rstrip("/") + "/demo/verify?token=" + demo_token
        provider_session_id = None
        # Expira en 24h
        expires_at = utc_iso(
            datetime.fromtimestamp((created + 24 * 3600 * 1000) / 1000, timezone.utc))

    record = {
        "status": "pending",
        "country": country,
        "documentType": document_type,
        "provider": provider.name,
        "mode": IDV_MODE,
        "createdAt": created,
        "updatedAt": created,
        "providerSessionId": provider_session_id,
        "verificationUrl": verification_url,
        "expiresAt": expires_at,
    }
    if demo_token:
        record["demoToken"] = demo_token
    db_put("users", "%s/idVerification/sessions/%s" % (sub, session_id), record)

    # El servidor es la fuente de verdad del estado: marca "pending" salvo que el
    # usuario ya esté verificado (una nueva sesión no revoca una verificación).
    cur = db_get("users", "%s/birthdayVerification" % sub) or {}
    if cur.get("status") != "verified":
        db_put("users", "%s/birthdayVerification" % sub, {
            "status": "pending",
            "provider": provider.name,
            "country": country,
            "documentType": document_type,
            "sessionId": session_id,
            "updatedAt": utc_iso(),
        })

    # Índice proveedor -> (sub, sessionId) para el webhook
    if provider_session_id:
        db_put("users",
               "idVerification/providerIndex/%s" % provider_session_id,
               {"sub": sub, "sessionId": session_id})
    if demo_token:
        db_put("users", "idVerification/demoIndex/%s" % demo_token,
               {"sub": sub, "sessionId": session_id})

    log("session_created", session_id=session_id, provider=provider.name, mode=IDV_MODE)
    return {
        "sessionId": session_id,
        "verificationUrl": verification_url,
        "expiresAt": expires_at,
        "mode": IDV_MODE,
    }


class RateLimited(Exception):
    pass


def get_age_verification_status(sub):
    data = db_get("users", "%s/birthdayVerification" % sub)
    if not data:
        return {"status": "none", "country": None, "verifiedAt": None,
                "method": None, "provider": None}
    return {
        "status": data.get("status", "none"),
        "country": data.get("country"),
        "verifiedAt": data.get("verifiedAt"),
        "method": data.get("method"),
        "provider": data.get("provider"),
    }


# Mapeo de eventos de Veriff -> estado interno
VERIFF_STATUS_TO_INTERNAL = {
    "approved": "verified",
    "declined": "rejected",
    "resubmission_requested": "pending",
    "abandoned": "expired",
    "expired": "expired",
    "started": "pending",
}


def apply_decision(*, sub, session_id, veriff_status, provider_name, country=None):
    """Aplica el resultado de la verificación. NUNCA recibe datos del documento."""
    internal = VERIFF_STATUS_TO_INTERNAL.get(veriff_status)
    if not internal:
        log("unknown_veriff_status", session_id=session_id)
        return None

    sk = "%s/idVerification/sessions/%s" % (sub, session_id)
    record = db_get("users", sk) or {}
    ts = now_ms()

    session_update = {
        "status": internal if internal != "pending" else record.get("status", "pending"),
        "updatedAt": ts,
        "lastEvent": veriff_status,
    }
    if country:
        session_update["country"] = country
    record.update(session_update)
    db_put("users", sk, record)

    age = db_get("users", "%s/birthdayVerification" % sub) or {}
    age_update = {
        "status": internal,
        "provider": provider_name,
        "country": country or record.get("country") or age.get("country"),
        "method": "id_document",
    }
    if internal == "verified":
        age_update["verifiedAt"] = ts
    age.update(age_update)
    db_put("users", "%s/birthdayVerification" % sub, age)

    # Notificación in-app del resultado (solo para estados finales o resubmission)
    notif_kind = {"verified": "verified", "rejected": "rejected",
                  "expired": "expired"}.get(internal)
    if internal == "pending" and veriff_status == "resubmission_requested":
        notif_kind = "resubmission"
    if notif_kind:
        write_notification(sub, notif_kind,
                           {"idvSessionId": session_id, "idvStatus": internal})

    log("decision_applied", session_id=session_id, provider=provider_name,
        event=veriff_status, result=internal)
    return internal


def handle_veriff_webhook(event):
    provider = get_provider()
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    raw_body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw_body = base64.b64decode(raw_body)
    else:
        raw_body = raw_body.encode("utf-8")

    if not provider.verify_webhook(raw_body, headers):
        log("webhook_bad_signature")
        return resp(403, {"error": "bad_signature"})

    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except ValueError:
        log("webhook_bad_payload")
        return resp(400, {"error": "bad_payload"})

    verification = payload.get("verification") or {}
    veriff_status = verification.get("status")
    provider_session_id = verification.get("id") or payload.get("id")
    document = verification.get("document") or {}
    country = document.get("country")

    if not provider_session_id or not veriff_status:
        log("webhook_missing_fields")
        return resp(400, {"error": "missing_fields"})

    idx = db_get("users", "idVerification/providerIndex/%s" % provider_session_id)
    if not idx:
        log("webhook_unknown_session", provider="veriff")
        return resp(404, {"error": "unknown_session"})

    apply_decision(sub=idx["sub"], session_id=idx["sessionId"],
                   veriff_status=veriff_status, provider_name="veriff",
                   country=country)
    return resp(200, {"ok": True})


# ---------------------------------------------------------------------------
# Modo demo: página de verificación + endpoint de completado
# ---------------------------------------------------------------------------

DEMO_PAGE = """<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Drex — Verificación de identidad (DEMO)</title>
<style>
body{font-family:system-ui,sans-serif;background:#0e0f1a;color:#f2f2f7;margin:0;
display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#1a1c2e;border:1px solid #2e3158;border-radius:16px;padding:32px;
max-width:420px;width:92%;text-align:center}
h1{font-size:20px;margin:0 0 8px}.badge{display:inline-block;background:#f5a623;
color:#000;font-size:12px;font-weight:700;border-radius:999px;padding:4px 12px;margin-bottom:12px}
p{color:#a7a9c4;font-size:14px;line-height:1.5}
button{border:0;border-radius:12px;padding:14px 0;width:100%;font-size:16px;font-weight:700;
cursor:pointer;margin-top:12px}
.ok{background:#2fbf71;color:#fff}.no{background:#e5484d;color:#fff}
#msg{margin-top:14px;font-size:14px;min-height:20px}
</style></head><body>
<div class="card">
<div class="badge">MODO DEMO</div>
<h1>Verificación de identidad</h1>
<p>Este es el simulador de Drex (sin Veriff real). Pulsa un botón para simular
el resultado de la revisión del documento.</p>
<button class="ok" onclick="decide('approve')">✅ Simular aprobación</button>
<button class="no" onclick="decide('reject')">❌ Simular rechazo</button>
<p id="msg"></p>
</div>
<script>
var token = new URLSearchParams(location.search).get('token') || '';
function decide(d){
  var msg = document.getElementById('msg');
  msg.textContent = 'Procesando…';
  fetch('complete', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({token: token, decision: d})})
    .then(function(r){ return r.json().then(function(j){ return {s:r.status, j:j}; }); })
    .then(function(x){
      if (x.s === 200) msg.textContent = '✅ Listo. Puedes cerrar esta página y volver a Drex.';
      else msg.textContent = 'Error: ' + (x.j.error || x.s);
    }).catch(function(){ msg.textContent = 'Error de red.'; });
}
</script></body></html>
"""


def handle_demo_verify(event):
    qs = event.get("queryStringParameters") or {}
    token = qs.get("token", "")
    idx = db_get("users", "idVerification/demoIndex/%s" % token) if token else None
    if not idx:
        return resp(404, {"error": "unknown_or_expired_demo_session"},
                    content_type="text/html; charset=utf-8")
    body = DEMO_PAGE
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "text/html; charset=utf-8"},
        "body": body,
    }


def handle_demo_complete(event):
    try:
        payload = json.loads(event.get("body") or "{}")
    except ValueError:
        return resp(400, {"error": "bad_payload"})
    token = payload.get("token", "")
    decision = payload.get("decision", "")
    if decision not in ("approve", "reject"):
        return resp(400, {"error": "bad_decision"})
    idx = db_get("users", "idVerification/demoIndex/%s" % token) if token else None
    if not idx:
        log("demo_bad_token")
        return resp(404, {"error": "unknown_or_expired_demo_session"})
    veriff_status = "approved" if decision == "approve" else "declined"
    apply_decision(sub=idx["sub"], session_id=idx["sessionId"],
                   veriff_status=veriff_status, provider_name="demo")
    return resp(200, {"ok": True})


# ---------------------------------------------------------------------------
# HTTP plumbing
# ---------------------------------------------------------------------------

def resp(status, obj, content_type="application/json"):
    return {
        "statusCode": status,
        "headers": {"Content-Type": content_type},
        "body": json.dumps(obj),
    }


def error(status, code):
    return resp(status, {"error": code})


def route(event):
    rc = event.get("requestContext") or {}
    http = rc.get("http") or {}
    method = (http.get("method") or "").upper()
    path = http.get("path") or "/"
    # Normaliza prefijo de stage de Function URL (p.ej. /default/session)
    if path.startswith("/default/"):
        path = path[len("/default"):]
    return method, path


def lambda_handler(event, context):
    method, path = route(event)
    function_url = "https://%s/" % (event.get("headers") or {}).get("host", "")

    # Webhook de Veriff: sin auth de usuario (firma HMAC)
    if method == "POST" and path == "/webhook":
        if IDV_MODE == "production":
            return handle_veriff_webhook(event)
        log("webhook_in_demo_mode")
        return error(404, "webhook_disabled_in_demo")

    # Endpoints demo (solo en modo demo)
    if method == "GET" and path == "/demo/verify":
        if IDV_MODE != "demo":
            return error(404, "not_found")
        return handle_demo_verify(event)
    if method == "POST" and path == "/demo/complete":
        if IDV_MODE != "demo":
            return error(404, "not_found")
        return handle_demo_complete(event)

    # Resto: requiere auth Cognito
    try:
        sub, _attrs = authenticate(event)
    except AuthError as e:
        return error(401, str(e))

    # Rate limit por IP (todas las rutas autenticadas)
    ip = client_ip(event)
    if ip != "unknown":
        n = db_bump_counter("users", "idv_ip_rate/%s/%s" % (ip, utc_today()))
        if n > MAX_SESSIONS_PER_IP_DAY:
            log("rate_limited", scope="ip")
            return error(429, "rate_limited")

    if method == "POST" and path == "/session":
        try:
            payload = json.loads(event.get("body") or "{}")
        except ValueError:
            return error(400, "bad_payload")
        country = (payload.get("country") or "").upper()
        document_type = (payload.get("documentType") or "").lower()
        document_type = DOC_TYPE_ALIASES.get(document_type, document_type)
        if country not in ALLOWED_COUNTRIES:
            return error(400, "bad_country")
        if document_type not in ALLOWED_DOC_TYPES:
            return error(400, "bad_document_type")
        try:
            result = create_idv_session(sub, country, document_type, function_url)
        except RateLimited:
            return error(429, "rate_limited")
        except Exception as e:
            log("session_failed", reason=type(e).__name__)
            return error(502, "provider_error")
        return resp(200, result)

    if method == "GET" and path == "/status":
        return resp(200, get_age_verification_status(sub))

    return error(404, "not_found")
