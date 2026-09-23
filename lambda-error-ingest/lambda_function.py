"""
Drex: ingesta de telemetría de errores del cliente web.

Por qué existe: el colector `DrexCloud.reliability` del bundle web
(drex-cloud.js) muestrea errores al 10 %, los deduplica por firma y los
envía en lotes con navigator.sendBeacon a `window.DREX_ERROR_INGEST_URL`.
Sin este endpoint, los errores solo quedan en el respaldo local del
navegador (localStorage, máx 50) y nunca salen del dispositivo.

Contrato:
  cliente -> POST {app:'drex-web', v:1, batch:[{v,ts,kind,msg,stack,url,line,col,sig}]}
  - batch: lista de 1..10 eventos.
  - Cada evento se valida y acota (msg<=300, stack<=2048, url<=300,
    kind<=32, sig<=100, ts en ms (Date.now()) o segundos, dentro de
    ±1 día tras normalizar a segundos).
  - Rate limiting atómico por IP (ventana fija, fail-open).
  - Responde 202 {ok:true}. Nunca hace eco de datos del cliente.

Almacenamiento (tabla drex-kv, un ítem por evento):
  pk='clientErrors', sk='<AAAAMMDD>/<sig>/<ts>-<rand4>'
  atributos: kind, msg, stack, url, line, col, ts, ttl (=ts+7 días).
  La IP NO se persiste en el evento (solo se usa para el rate limit,
  igual que en drex-username-resolve).

Propiedades de seguridad:
- Sin autenticación en la Function URL (el cliente web no firma): la
  protección es validación estricta + rate limit por IP + muestreo del
  cliente. Un abusador solo puede insertar eventos acotados y efímeros.
- CORS restringido a los orígenes oficiales de Drex.
- TTL de 7 días: la tabla no crece sin cota (si el TTL no está habilitado
  en drex-kv sobre el atributo `ttl`, el atributo es inofensivo; ver
  DEPLOY.md).

Variables de entorno:
  DREX_TABLE   tabla DynamoDB (default: drex-kv)
  RL_MAX       lotes por IP y ventana (default: 60)
  RL_WINDOW    ventana en segundos (default: 60)

IAM mínimo del rol:
  dynamodb:PutItem, dynamodb:UpdateItem sobre la tabla drex-kv
"""

import base64
import json
import os
import random
import re
import time

import boto3
import botocore.exceptions

TABLE_NAME = os.environ.get("DREX_TABLE", "drex-kv")

RL_MAX = int(os.environ.get("RL_MAX", "60"))
RL_WINDOW = int(os.environ.get("RL_WINDOW", "60"))

_BATCH_MAX = 10
_TTL_SECONDS = 7 * 24 * 3600

_ALLOWED_ORIGINS = {
    "https://floreseternasoporte-creator.github.io",
    "https://drex.glamworksapps.workers.dev",
    "https://getdrex.com",
    "https://www.getdrex.com",
}

_KIND_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")

_dynamo = None


def _table():
    global _dynamo
    if _dynamo is None:
        _dynamo = boto3.resource("dynamodb", region_name="us-east-1").Table(TABLE_NAME)
    return _dynamo


def _resp(status, body_dict, origin):
    headers = {"Content-Type": "application/json", "Cache-Control": "no-store"}
    if origin in _ALLOWED_ORIGINS:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Vary"] = "Origin"
    return {"statusCode": status, "headers": headers, "body": json.dumps(body_dict)}


def _client_ip(event):
    try:
        return event["requestContext"]["http"]["sourceIp"]
    except Exception:
        return "unknown"


def _rate_limited(table, key_id, max_n):
    """Ventana fija atómica por IP. Fail-open ante errores de BD."""
    now = int(time.time())
    key = {"pk": "ratelimit", "sk": "erringest-ip/" + key_id}
    try:
        table.update_item(
            Key=key,
            UpdateExpression="SET #c = :one, #e = :exp, #t = :ttl",
            ConditionExpression="attribute_not_exists(pk) OR #e < :now",
            ExpressionAttributeNames={"#c": "c", "#e": "e", "#t": "ttl"},
            ExpressionAttributeValues={
                ":one": 1,
                ":exp": now + RL_WINDOW,
                ":ttl": now + RL_WINDOW + 300,
                ":now": now,
            },
        )
        return False
    except botocore.exceptions.ClientError as e:
        if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            return False
    except Exception:
        return False
    try:
        r = table.update_item(
            Key=key,
            UpdateExpression="ADD #c :inc SET #t = :ttl",
            ExpressionAttributeNames={"#c": "c", "#t": "ttl"},
            ExpressionAttributeValues={":inc": 1, ":ttl": now + RL_WINDOW + 300},
            ReturnValues="UPDATED_NEW",
        )
        return int(r["Attributes"]["c"]) > max_n
    except Exception:
        return False


def _clean_str(v, max_len):
    if not isinstance(v, str):
        return ""
    return v[:max_len]


def _clean_int(v):
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    if abs(n) > 2**53:
        return None
    return n


def _clean_ts(v, now):
    """Normaliza el timestamp del evento a segundos (epoch Unix).

    El cliente web emite Date.now() en MILISEGUNDOS; también se aceptan
    segundos por compatibilidad (y por el ejemplo de DEPLOY.md). Sin esta
    normalización, un ts en ms jamás cae dentro de la ventana de ±1 día y
    el evento real se rechaza; además el TTL (ts + 7 días) quedaría unos
    56.000 años en el futuro y la limpieza automática nunca correría.
    Devuelve el ts en segundos o None si no es válido.
    """
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    if abs(n) > 2**53:
        return None
    if n >= 10**12:
        # Milisegundos: 1e12 ms = 2001-09-09; el ms actual es ~1.75e12.
        # Segundos válidos nunca llegan aquí (1e12 s = año 33658).
        n = n // 1000
    if abs(n - now) > 86400:
        return None
    return n


def _valid_event(ev, now):
    """Valida y normaliza un evento. Devuelve dict limpio o None."""
    if not isinstance(ev, dict):
        return None
    kind = _clean_str(ev.get("kind"), 32)
    if not _KIND_RE.match(kind):
        return None
    msg = _clean_str(ev.get("msg"), 300)
    if not msg:
        return None
    ts = _clean_ts(ev.get("ts"), now)
    if ts is None:
        return None
    sig = _clean_str(ev.get("sig"), 100) or "nosig"
    # La firma viaja en la clave: solo caracteres seguros.
    sig = re.sub(r"[^A-Za-z0-9_-]", "_", sig)[:64] or "nosig"
    return {
        "kind": kind,
        "msg": msg,
        "stack": _clean_str(ev.get("stack"), 2048),
        "url": _clean_str(ev.get("url"), 300),
        "line": _clean_int(ev.get("line")),
        "col": _clean_int(ev.get("col")),
        "ts": ts,
        "sig": sig,
    }


def _store_events(table, events, day):
    for ev in events:
        rand = "%04x" % random.getrandbits(16)
        sk = "%s/%s/%d-%s" % (day, ev["sig"], ev["ts"], rand)
        item = {
            "pk": "clientErrors",
            "sk": sk,
            "kind": ev["kind"],
            "msg": ev["msg"],
            "ts": ev["ts"],
            "ttl": ev["ts"] + _TTL_SECONDS,
        }
        if ev["stack"]:
            item["stack"] = ev["stack"]
        if ev["url"]:
            item["url"] = ev["url"]
        if ev["line"] is not None:
            item["line"] = ev["line"]
        if ev["col"] is not None:
            item["col"] = ev["col"]
        table.put_item(Item=item)


def lambda_handler(event, context):
    origin = ""
    try:
        origin = (event.get("headers") or {}).get("origin", "") or ""
    except Exception:
        pass

    try:
        method = (event.get("requestContext") or {}).get("http", {}).get("method", "")
    except Exception:
        method = ""
    if method == "OPTIONS":
        r = _resp(204, {}, origin)
        r["headers"]["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        r["headers"]["Access-Control-Allow-Headers"] = "Content-Type"
        r["headers"]["Access-Control-Max-Age"] = "86400"
        return r

    if method != "POST":
        return _resp(405, {"error": "method_not_allowed"}, origin)

    try:
        body = event.get("body") or ""
        if event.get("isBase64Encoded"):
            body = base64.b64decode(body).decode("utf-8", "replace")
        data = json.loads(body) if body else {}
    except Exception:
        return _resp(400, {"error": "invalid_request"}, origin)

    if not isinstance(data, dict) or data.get("app") != "drex-web":
        return _resp(400, {"error": "invalid_request"}, origin)

    batch = data.get("batch")
    if not isinstance(batch, list) or not (1 <= len(batch) <= _BATCH_MAX):
        return _resp(400, {"error": "invalid_request"}, origin)

    table = _table()
    ip = _client_ip(event)
    if _rate_limited(table, ip, RL_MAX):
        return _resp(429, {"error": "rate_limited"}, origin)

    now = int(time.time())
    events = []
    for ev in batch:
        clean = _valid_event(ev, now)
        if clean:
            events.append(clean)
    if not events:
        # Lote sin eventos válidos: se acepta (202) para no dar señal al
        # cliente sobre qué fue rechazado; no se escribe nada.
        return _resp(202, {"ok": True}, origin)

    day = time.strftime("%Y%m%d", time.gmtime(now))
    try:
        _store_events(table, events, day)
    except Exception:
        return _resp(500, {"error": "internal"}, origin)

    return _resp(202, {"ok": True}, origin)
