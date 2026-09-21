#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Harness local para drex-data-export: dobles de DynamoDB/S3/Cognito/Lambda.
No toca AWS ni cuentas reales. Ejecutar: python3 tests/test_lambda.py"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import lambda_function as L  # noqa: E402


# ------------------------------------------------------------ dobles -------
class _CognitoError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeDDB:
    """DynamoDB en memoria. Soporta las operaciones exactas que usa la Lambda."""

    def __init__(self):
        self.tables = {}  # table -> list[item dict]

    def _t(self, name):
        return self.tables.setdefault(name, [])

    # ---- escritura estilo fachada (pk, sk, v) ----
    def get_item(self, TableName, Key):
        for it in self._t(TableName):
            if it.get("pk") == Key.get("pk") and it.get("sk") == Key.get("sk"):
                return {"Item": dict(it)}
        return {}

    def put_item(self, TableName, Item):
        t = self._t(TableName)
        for i, it in enumerate(t):
            if it.get("pk") == Item.get("pk") and it.get("sk") == Item.get("sk"):
                t[i] = dict(Item)
                return {}
        t.append(dict(Item))
        return {}

    def delete_item(self, TableName, Key):
        t = self._t(TableName)
        self.tables[TableName] = [it for it in t
                                 if not (it.get("pk") == Key.get("pk")
                                         and it.get("sk") == Key.get("sk"))]
        return {}

    def update_item(self, TableName, Key, UpdateExpression,
                    ExpressionAttributeNames=None, ExpressionAttributeValues=None,
                    ConditionExpression=None, ReturnValues=None):
        names = ExpressionAttributeNames or {}
        vals = ExpressionAttributeValues or {}
        t = self._t(TableName)
        item = None
        for it in t:
            if it.get("pk") == Key.get("pk") and it.get("sk") == Key.get("sk"):
                item = it
                break
        if ConditionExpression == "attribute_not_exists(pk) OR #e < :now":
            exists = item is not None
            expired = exists and item.get(names.get("#e", "e"), 0) < vals.get(":now", 0)
            if exists and not expired:
                raise _CognitoError("ConditionalCheckFailedException")
            if item is None:
                item = {"pk": Key["pk"], "sk": Key["sk"]}
                t.append(item)
        if item is None:
            item = {"pk": Key["pk"], "sk": Key["sk"]}
            t.append(item)
        # SET #c = :one, #e = :exp, #t = :ttl  |  ADD #c :inc SET #t = :ttl
        for part in UpdateExpression.split("SET"):
            part = part.strip()
            if part.startswith("ADD"):
                an, vn = part[3:].strip().split()
                a = names.get(an, an)
                v = vals.get(vn, 0)
                item[a] = item.get(a, 0) + v
            elif part:
                for assign in part.split(","):
                    assign = assign.strip()
                    if not assign or "=" not in assign:
                        continue
                    an, vn = [x.strip() for x in assign.split("=", 1)]
                    item[names.get(an, an)] = vals.get(vn)
        if ReturnValues == "UPDATED_NEW":
            return {"Attributes": dict(item)}
        return {}

    # ---- lectura ----
    def query(self, TableName, KeyConditionExpression="", ExpressionAttributeValues=None,
              IndexName=None, ScanIndexForward=True, Limit=None, ExclusiveStartKey=None,
              **kw):
        vals = ExpressionAttributeValues or {}
        items = list(self._t(TableName))
        if IndexName == "byUser":
            u = vals.get(":u")
            items = [it for it in items if it.get("userId") == u]
        elif "begins_with(sk" in KeyConditionExpression:
            pk = vals.get(":pk")
            pre = vals.get(":pre")
            items = [it for it in items
                     if it.get("pk") == pk and str(it.get("sk", "")).startswith(pre or "")]
        elif "userId = :u" in KeyConditionExpression:
            u = vals.get(":u")
            items = [it for it in items if it.get("userId") == u]
        items.sort(key=lambda it: str(it.get("sk", "")))
        if not ScanIndexForward:
            items = list(reversed(items))
        start = 0
        if ExclusiveStartKey:
            esk = ExclusiveStartKey.get("sk")
            for i, it in enumerate(items):
                if str(it.get("sk", "")) == str(esk):
                    start = i + 1
                    break
        items = items[start:]
        lek = None
        if Limit and len(items) > Limit:
            lek = {"pk": items[Limit - 1].get("pk"), "sk": items[Limit - 1].get("sk")}
            items = items[:Limit]
        return {"Items": [dict(i) for i in items],
                **({"LastEvaluatedKey": lek} if lek else {})}

    def scan(self, TableName, FilterExpression="", ExpressionAttributeValues=None,
             ProjectionExpression=None, Limit=None, ExclusiveStartKey=None, **kw):
        vals = ExpressionAttributeValues or {}
        items = list(self._t(TableName))
        if "contains(sk" in FilterExpression:
            m = vals.get(":m", "")
            items = [it for it in items if m in str(it.get("sk", ""))]
        elif "pk = :pk" in FilterExpression:
            pk = vals.get(":pk")
            items = [it for it in items if it.get("pk") == pk]
        if ProjectionExpression:
            fields = [f.strip() for f in ProjectionExpression.split(",")]
            items = [{f: it.get(f) for f in fields} for it in items]
        if Limit:
            items = items[:Limit]
        return {"Items": items, "ScannedCount": len(items)}


class FakeS3:
    def __init__(self):
        self.objects = {}  # (bucket, key) -> dict
        self.presigned = []

    def put_object(self, Bucket, Key, Body, **kw):
        blob = Body if isinstance(Body, (bytes, bytearray)) else str(Body).encode()
        self.objects[(Bucket, Key)] = {"Body": bytes(blob), **kw}
        return {}

    def get_object(self, Bucket, Key):
        o = self.objects.get((Bucket, Key))
        if o is None:
            raise _CognitoError("NoSuchKey")
        return {"Body": io.BytesIO(o["Body"])}

    def head_object(self, Bucket, Key):
        o = self.objects.get((Bucket, Key))
        if o is None:
            raise _CognitoError("404")
        return {"ContentLength": len(o["Body"])}

    def delete_object(self, Bucket, Key):
        self.objects.pop((Bucket, Key), None)
        return {}

    def generate_presigned_url(self, op, Params, ExpiresIn):
        url = "https://%s.s3.amazonaws.com/%s?presigned=1&exp=%s" % (
            Params["Bucket"], Params["Key"], ExpiresIn)
        self.presigned.append(url)
        return url


class FakeIdp:
    def __init__(self, subs):
        self.subs = subs  # {token|sub: dict}

    def get_user(self, AccessToken):
        u = self.subs.get(AccessToken)
        if not u:
            raise _CognitoError("NotAuthorizedException")
        return {"Username": u["sub"],
                "UserAttributes": [{"Name": k, "Value": v}
                                  for k, v in u.get("attrs", {}).items()]}

    def admin_get_user(self, UserPoolId, Username):
        for u in self.subs.values():
            if u["sub"] == Username:
                if u.get("deleted"):
                    raise _CognitoError("UserNotFoundException")
                return {"Username": Username,
                        "UserAttributes": [{"Name": k, "Value": v}
                                           for k, v in u.get("attrs", {}).items()],
                        "UserMFASettingList": u.get("mfa", []),
                        "PreferredMfaSetting": u.get("prefMfa")}
        raise _CognitoError("UserNotFoundException")


class FakeLambda:
    def __init__(self):
        self.invocations = []

    def invoke(self, FunctionName, InvocationType, Payload):
        self.invocations.append({
            "FunctionName": FunctionName, "InvocationType": InvocationType,
            "Payload": json.loads(Payload.decode("utf-8") if isinstance(Payload, bytes) else Payload),
        })
        return {"StatusCode": 202}


class FakeContext:
    def __init__(self, remaining_ms=14 * 60 * 1000):
        self._ms = remaining_ms

    def get_remaining_time_in_millis(self):
        return self._ms


# ---------------------------------------------------------------- helpers ---
PASSED, FAILED = 0, 0


def ok(cond, name, extra=""):
    global PASSED, FAILED
    if cond:
        PASSED += 1
        print("  ok   " + name)
    else:
        FAILED += 1
        print("  FALLO " + name + (" — " + str(extra) if extra else ""))


def put(ddb, table, pk, sk, v):
    ddb.put_item(TableName=table, Item={"pk": pk, "sk": sk, "v": json.dumps(v)})


SUB = "sub-usuario-1"
OTHER = "sub-otro-9"
TOKEN = "token-bueno-1"
BAD_TOKEN = "token-malo"


def make_env():
    ddb, s3, lam = FakeDDB(), FakeS3(), FakeLambda()
    idp = FakeIdp({
        TOKEN: {"sub": SUB, "attrs": {"email": "user@example.com",
                                      "email_verified": "true",
                                      "name": "Usuario", "picture": "https://img/p.png"},
                "mfa": ["SOFTWARE_TOKEN_MFA"], "prefMfa": "SOFTWARE_TOKEN_MFA"},
    })
    L.set_test_clients(ddb=ddb, s3=s3, idp=idp, lam=lam)
    os.environ["AWS_LAMBDA_FUNCTION_NAME"] = "drex-data-export"
    return ddb, s3, idp, lam


def seed_user_data(ddb, sub=SUB):
    put(ddb, "drex-kv", "users", sub, {
        "username": "tester", "displayName": "Tester", "email": "user@example.com",
        "twoFactorSecret": "SECRETO-NO-DEBE-SALIR",
        "twoFactorBackupCodes": {"a1": False},
        "twoFactorEnabled": True,
        "recoveryCodes": {"hashes": ["abc123hash"], "generatedAt": 1726000000000, "usedCount": 1},
    })
    put(ddb, "drex-kv", "userInterests", sub, {"authors": {"a": 8}})
    put(ddb, "drex-kv", "communityNotes", "n1",
        {"authorId": sub, "content": "mi post", "timestamp": 1726000001000})
    put(ddb, "drex-kv", "communityNotes", "n2",
        {"authorId": OTHER, "content": "post AJENO", "timestamp": 1726000002000})
    put(ddb, "drex-kv", "noteImages", "n1", {"imageUrls": ["https://img/x.jpg"]})
    put(ddb, "drex-kv", "noteVideos", "n1",
        {"videoUrl": "data:video/mp4;base64," + "A" * 5000})
    put(ddb, "drex-kv", "userComments", sub + "/c1",
        {"noteId": "n9", "content": "mi comentario", "timestamp": 1,
         "authorEmail": "user@example.com"})
    put(ddb, "drex-kv", "postComments", "n9/c9",
        {"authorId": sub, "content": "otro comentario mio", "timestamp": 2})
    put(ddb, "drex-kv", "userVotes", sub, {"n5": "up"})
    put(ddb, "drex-kv", "userCommentVotes", sub, {"k1": "up"})
    put(ddb, "drex-kv", "userEcos", sub + "/n7", {"noteId": "n7"})
    put(ddb, "drex-kv", "userReposts", sub + "/n8", {"noteId": "n8"})
    put(ddb, "drex-kv", "savedPosts", sub, {"n3": True})
    put(ddb, "drex-kv", "savedFolders", sub, {"f1": {"name": "x"}})
    put(ddb, "drex-kv", "savedComments", sub, {})
    put(ddb, "drex-kv", "following", sub + "/u2", {"followedAt": 1})
    put(ddb, "drex-kv", "followers", sub + "/u3", {"followedAt": 2})
    put(ddb, "drex-kv", "followRequests", sub + "/u4", {"requestedAt": 3})
    put(ddb, "drex-kv", "followRequests", "u6/" + sub, {"requestedAt": 4})
    put(ddb, "drex-kv", "blocks", sub + "/u5", {"blockedAt": 4})
    put(ddb, "drex-kv", "profileNotes", sub, {"text": "hola", "timestamp": 5})
    put(ddb, "drex-kv", "userCollabs", sub, {"n10": True})
    put(ddb, "drex-kv", "users", sub + "/ratings/rater1", {"stars": 5})
    put(ddb, "drex-kv", "userConversations", sub + "/conv1", {"lastMessageTime": 10})
    put(ddb, "drex-kv", "conversationMessages", "conv1/m1",
        {"senderId": sub, "text": "hola", "timestamp": 10})
    put(ddb, "drex-kv", "conversationMessages", "conv1/m2",
        {"senderId": OTHER, "text": "respuesta ajena en MI chat", "timestamp": 11})
    put(ddb, "drex-kv", "notifications", sub + "/nn1", {"message": "x", "timestamp": 11})
    put(ddb, "drex-kv", "userSettings", sub, {"appLanguage": "es"})
    put(ddb, "drex-kv", "security", sub + "/preferences/newDeviceAlerts", True)
    put(ddb, "drex-kv", "users", sub + "/devices/fp1", {"label": "iPhone"})
    put(ddb, "drex-kv", "users", sub + "/logins/1726000000000_x",
        {"ts": 1726000000000, "browser": "Safari"})
    put(ddb, "drex-kv", "users", sub + "/sessions/s1", {"id": "s1", "current": True})
    put(ddb, "drex-kv", "fiestas", "f1", {"hostId": sub, "title": "mi fiesta"})
    put(ddb, "drex-kv", "fiestaMembers", "f1/" + sub, {"joinedAt": 1})
    put(ddb, "drex-kv", "groups", "g1", {"creatorId": sub, "name": "mi grupo"})
    put(ddb, "drex-kv", "musicTracks", "t1",
        {"authorId": sub, "title": "mi rola", "createdAt": 20})
    put(ddb, "drex-kv", "musicPlaylists", sub + "/pl1", {"name": "pl"})
    put(ddb, "drex-kv", "musicFavorites", sub, [{"trackId": "t9"}])
    put(ddb, "drex-kv", "musicVotes", sub + "/t1", "up")
    put(ddb, "drex-kv", "userLanguages", sub, {"native": "es", "learning": "en"})
    put(ddb, "drex-kv", "languageExercises", "ex1",
        {"authorId": sub, "text": "hello", "timestamp": 30})
    put(ddb, "drex-kv", "exerciseCorrections", "ex9/" + sub, {"text": "bien"})
    put(ddb, "drex-kv", "appeals", "a1", {"authorId": sub, "message": "apelo"})
    put(ddb, "drex-kv", "commentModerationQueue", "q1",
        {"authorId": sub, "contentPreview": "reporte mio"})
    # tickets en la tabla aparte
    ddb.put_item(TableName="drex-support-tickets",
                 Item={"ticketId": "tk1", "userId": sub, "subject": "ayuda"})
    put(ddb, "drex-kv", "users", sub + "/supervisedBy", "parent-1")
    put(ddb, "drex-kv", "parentalLinkCodes", "code1",
        {"teenUid": sub, "createdAt": 1, "expiresAt": 2, "used": True})
    # secretos que NUNCA deben salir
    put(ddb, "drex-kv", "pushSubscriptions", sub + "/s1",
        {"endpoint": "https://push/secret", "keys": {"p256dh": "K", "auth": "A"}})
    put(ddb, "drex-kv", "musicAudio", "t1", {"chunk_0": "AUDIO-BINARIO"})
    put(ddb, "drex-kv", "ratelimit", "export/x", {"c": 1})


def fn_event(action, body_extra=None, token=TOKEN):
    body = {"action": action}
    body.update(body_extra or {})
    return {
        "version": "2.0",
        "requestContext": {"http": {"method": "POST", "sourceIp": "1.2.3.4"}},
        "headers": {"origin": "https://floreseternasoporte-creator.github.io",
                    "authorization": "Bearer " + token},
        "body": json.dumps(body),
        "isBase64Encoded": False,
    }


def call(action, body_extra=None, token=TOKEN, headers_extra=None):
    ev = fn_event(action, body_extra, token)
    if headers_extra:
        ev["headers"].update(headers_extra)
    return L.lambda_handler(ev, FakeContext())


def body_of(resp):
    return json.loads(resp["body"])

# ---------------------------------------------------------------- tests ----
def test_request_happy():
    print("== request: ciclo feliz ==")
    ddb, s3, idp, lam = make_env()
    snap = {"drex_music_history": [{"id": "t1"}],
            "accessToken": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.xxx"}
    r = call("request", {"format": "json", "browserSnapshot": snap, "lang": "es"})
    b = body_of(r)
    ok(r["statusCode"] == 200 and b.get("status") == "requested", "request 200 requested", b)
    ok(b.get("jobId", "").startswith("ex_"), "jobId con prefijo ex_")
    ok(b.get("alreadyActive") is False, "no alreadyActive la primera vez")
    job = L.read_job(SUB, b["jobId"])
    ok(job and job["status"] == "requested", "job creado en requested")
    ok(job.get("workerToken") and len(job["workerToken"]) == 64, "workerToken de 32 bytes hex")
    ok(job.get("browserSnapshot", {}).get("drex_music_history") == [{"id": "t1"}],
       "snapshot guardado")
    ok("accessToken" not in job.get("browserSnapshot", {}),
       "snapshot sanitizado (llave tipo token eliminada)")
    ok(len(lam.invocations) == 1, "worker invocado 1 vez")
    inv = lam.invocations[0]["Payload"]
    ok(inv.get("internal") == "worker" and inv.get("jobId") == b["jobId"], "payload worker correcto")
    ok(lam.invocations[0]["InvocationType"] == "Event", "invocacion asincrona (Event)")
    ok(inv.get("workerToken") == job["workerToken"], "workerToken viaja al worker")
    ok(r["headers"].get("Access-Control-Allow-Origin") ==
       "https://floreseternasoporte-creator.github.io", "CORS allowlist")


def test_request_auth():
    print("== request: auth ==")
    make_env()
    r = call("request", {}, token=BAD_TOKEN)
    ok(r["statusCode"] == 401 and body_of(r).get("error") == "invalid_token", "token malo -> 401")
    ev = fn_event("request", {}, token=TOKEN)
    del ev["headers"]["authorization"]
    r = L.lambda_handler(ev, FakeContext())
    ok(r["statusCode"] == 401, "sin Authorization -> 401")
    r = call("no-existe")
    ok(r["statusCode"] == 400 and body_of(r).get("error") == "bad_action", "accion mala -> 400")


def test_request_snapshot_grande():
    print("== request: snapshot >64KB ==")
    make_env()
    big = {"k": "x" * (70 * 1024)}
    r = call("request", {"browserSnapshot": big})
    ok(r["statusCode"] == 400 and body_of(r).get("error") == "snapshot_too_large",
       "snapshot gigante -> 400")


def test_request_idempotente():
    print("== request: idempotencia ==")
    ddb, s3, idp, lam = make_env()
    b1 = body_of(call("request", {}))
    b2 = body_of(call("request", {}))
    ok(b2.get("alreadyActive") is True and b2.get("jobId") == b1["jobId"],
       "segundo request devuelve el job activo")
    ok(len(lam.invocations) == 1, "no se dispara otro worker")


def test_request_rate_limit():
    print("== request: rate limit 3/hora ==")
    ddb, s3, idp, lam = make_env()
    codes = []
    for i in range(3):
        b = body_of(call("request", {}))
        # marcar el job como fallido para que el siguiente no sea idempotente
        job = L.read_job(SUB, b["jobId"])
        job["status"] = "failed"
        L.write_job(job)
        codes.append(b.get("error") or b.get("status"))
    ok(codes == ["requested", "requested", "requested"], "3 solicitudes pasan", codes)
    r4 = call("request", {})
    ok(r4["statusCode"] == 429 and body_of(r4).get("error") == "too_many_requests",
       "4ta solicitud en la hora -> 429", codes)


def test_download_url():
    print("== download-url ==")
    ddb, s3, idp, lam = make_env()
    b = body_of(call("request", {}))
    job_id = b["jobId"]
    r = call("download-url", {"jobId": job_id})
    ok(r["statusCode"] == 409, "job no listo -> 409")
    # marcar ready + objeto en S3
    job = L.read_job(SUB, job_id)
    job["status"] = "ready"
    job["fileKey"] = "exports/%s/%s.json" % (SUB, job_id)
    job["fileSha256"] = "abc"
    job["format"] = "json"
    L.write_job(job)
    s3.put_object(Bucket=L.BUCKET, Key=job["fileKey"], Body=b"{}")
    r = call("download-url", {"jobId": job_id})
    d = body_of(r)
    ok(r["statusCode"] == 200 and d["url"].startswith("https://"), "200 con URL", d.get("url", "")[:60])
    ok(d.get("expiresIn") == 900, "expira en 15 min")
    ok(d.get("filename", "").startswith("drex-mis-datos-") and d["filename"].endswith(".json"),
       "nombre de archivo", d.get("filename"))
    ok(d.get("sha256") == "abc" and d.get("size") == 2, "sha256 + size")
    # job ajeno -> 404 generico (sin enumeracion)
    r = call("download-url", {"jobId": "ex_inexistente"})
    ok(r["statusCode"] == 404 and body_of(r).get("error") == "not_found", "inexistente -> 404")
    # token invalido -> 401
    r = call("download-url", {"jobId": job_id}, token=BAD_TOKEN)
    ok(r["statusCode"] == 401, "token malo -> 401")
    # expirado -> 410
    job["expiresAt"] = 1
    L.write_job(job)
    r = call("download-url", {"jobId": job_id})
    ok(r["statusCode"] == 410, "expirado -> 410")


def _run_worker_full():
    ddb, s3, idp, lam = make_env()
    seed_user_data(ddb)
    b = body_of(call("request", {"format": "json", "lang": "es"}))
    job_id = b["jobId"]
    job = L.read_job(SUB, job_id)
    inv = lam.invocations[0]["Payload"]
    res = L.run_worker(inv, FakeContext())
    return ddb, s3, idp, lam, job_id, res


def test_worker_happy():
    print("== worker: ciclo completo ==")
    ddb, s3, idp, lam, job_id, res = _run_worker_full()
    ok(res.get("ok") is True, "worker ok")
    job = L.read_job(SUB, job_id)
    ok(job["status"] == "ready", "job en ready")
    ok(job.get("fileKey", "").endswith(".json"), "fileKey json", job.get("fileKey"))
    jk = ("drex-exports-002493750027", "exports/%s/%s.json" % (SUB, job_id))
    hk = ("drex-exports-002493750027", "exports/%s/%s.html" % (SUB, job_id))
    ok(jk in s3.objects and hk in s3.objects, "JSON y HTML en S3")
    payload = json.loads(s3.objects[jk]["Body"].decode("utf-8"))
    ok(len(payload.get("sections", {})) == 27, "27 secciones", str(len(payload.get("sections", {}))))
    ok(payload.get("export") == "drex-user-data" and payload.get("version") == 1, "forma del payload")
    ok(len(payload.get("excluded", [])) == 11, "11 exclusiones documentadas")
    ok(len(payload.get("limits", [])) == 6, "6 limites documentados")
    ok(job.get("fileSha256") == __import__("hashlib").sha256(
        s3.objects[jk]["Body"]).hexdigest(), "sha256 del job coincide")
    ok(s3.objects[jk].get("ServerSideEncryption") == "AES256", "SSE-S3")
    # notificacion in-app
    n = L.get_v("notifications", SUB + "/exp_" + job_id)
    ok(n and n.get("type") == "data_export" and n.get("read") is False, "notificacion in-app")
    ok("Tu archivo de datos" in n.get("title", ""), "titulo ES", n.get("title"))
    # HTML determinista sin scripts, con identidad
    h = s3.objects[hk]["Body"].decode("utf-8")
    ok(h.startswith("<!DOCTYPE html>") and "((•))" in h, "HTML con identidad Drex")
    ok("<script" not in h, "HTML sin scripts")
    # heartbeat y progreso
    ok(job.get("lastHeartbeat", 0) >= job.get("createdAt", 0), "heartbeat escrito")
    ok((job.get("progress") or {}).get("done") == 27, "progreso 27/27")
    return payload


def test_worker_exclusiones(payload=None):
    print("== worker: exclusiones de privacidad ==")
    if payload is None:
        payload = test_worker_happy()
    flat = json.dumps(payload, ensure_ascii=False)
    for needle, name in [
        ("SECRETO-NO-DEBE-SALIR", "secreto 2FA legacy"),
        ("abc123hash", "hash de recovery"),
        ("https://push/secret", "endpoint push"),
        ("post AJENO", "post de otro usuario"),
        ("AUDIO-BINARIO", "audio binario"),
    ]:
        ok(needle not in flat, "ausente: " + name)
    ok("mi post" in flat, "post propio presente")
    ok("respuesta ajena en MI chat" in flat, "mensajes de interlocutores en MI chat (documentado)")
    tf = payload["sections"]["twoFactor"]["data"]
    ok(tf["recoveryCodes"].get("usedCount") == 1 and "hashes" not in tf["recoveryCodes"],
       "recoveryCodes: solo metadata")
    ok(tf["enabled"] is True, "2FA enabled desde Cognito")
    prof = payload["sections"]["profile"]["data"]
    ok("twoFactorSecret" not in prof and "dataExports" not in prof, "perfil sin secretos ni jobs")
    # sanitizeMedia: data URL gigante -> marcador
    posts = payload["sections"]["posts"]["data"]
    with_media = [p for p in posts if (p.get("media") or {}).get("videos")]
    ok(with_media and "binario omitido" in json.dumps(with_media[0]), "binario sanitizado")


def test_worker_token_mismatch():
    print("== worker: workerToken ==")
    ddb, s3, idp, lam = make_env()
    seed_user_data(ddb)
    b = body_of(call("request", {}))
    inv = dict(lam.invocations[0]["Payload"])
    inv["workerToken"] = "0" * 64
    res = L.run_worker(inv, FakeContext())
    ok(res.get("ok") is False, "token distinto -> aborta")
    job = L.read_job(SUB, inv["jobId"])
    ok(job["status"] == "requested", "job intacto")
    ok(len(s3.objects) == 0, "nada subido a S3")


def test_worker_cancelado():
    print("== worker: job cancelado por el usuario ==")
    ddb, s3, idp, lam = make_env()
    b = body_of(call("request", {}))
    job = L.read_job(SUB, b["jobId"])
    job["status"] = "failed"
    job["error"] = {"code": "cancelled_by_user"}
    L.write_job(job)
    inv = lam.invocations[0]["Payload"]
    res = L.run_worker(inv, FakeContext())
    ok(res.get("ok") is False and len(s3.objects) == 0, "no trabaja sobre job cancelado")


def test_worker_continuacion():
    print("== worker: auto-continuacion con cursor ==")
    ddb, s3, idp, lam = make_env()
    seed_user_data(ddb)
    b = body_of(call("request", {}))
    inv = lam.invocations[0]["Payload"]
    # primera pasada con poco tiempo: debe guardar cursor y re-invocarse
    res = L.run_worker(inv, FakeContext(remaining_ms=30_000))
    ok(res.get("continued") is True, "se auto-continua")
    ok(len(lam.invocations) == 2, "segunda invocacion emitida")
    inv2 = lam.invocations[1]["Payload"]
    ok(inv2.get("cursor", {}).get("nextSection", 0) > 0, "cursor con nextSection")
    ok(inv2.get("workerToken") == inv.get("workerToken"), "mismo workerToken")
    # segunda pasada con tiempo de sobra: completa
    res2 = L.run_worker(inv2, FakeContext())
    ok(res2.get("ok") is True, "segunda pasada completa")
    job = L.read_job(SUB, b["jobId"])
    ok(job["status"] == "ready", "ready tras continuacion")
    ok(len(job.get("summary", {})) > 0, "summary presente")


def test_worker_fallo_parcial():
    print("== worker: fallo parcial honesto ==")
    ddb, s3, idp, lam = make_env()
    seed_user_data(ddb)
    b = body_of(call("request", {}))
    inv = lam.invocations[0]["Payload"]
    real = L.sec_votes

    def boom(ctx):
        raise RuntimeError("bd caida")
    L.sec_votes = boom
    # parchear tambien en SECTIONS (tupla inmutable -> reconstruir)
    L.SECTIONS[:] = [(sid, boom if sid == "votes" else fn) for sid, fn in L.SECTIONS]
    try:
        res = L.run_worker(inv, FakeContext())
    finally:
        L.SECTIONS[:] = [(sid, real if sid == "votes" else fn) for sid, fn in L.SECTIONS]
        L.sec_votes = real
    ok(res.get("ok") is True, "worker termina aunque falle una seccion")
    job = L.read_job(SUB, b["jobId"])
    ok(job["status"] == "ready", "sigue ready")
    jk = ("drex-exports-002493750027", "exports/%s/%s.json" % (SUB, b["jobId"]))
    payload = json.loads(s3.objects[jk]["Body"].decode("utf-8"))
    ok(payload["sections"]["votes"]["status"] == "failed", "votes marcada failed")
    ok(payload["summary"]["sectionsFailed"] == 1, "1 fallo parcial registrado")


def test_sweep():
    print("== sweep ==")
    ddb, s3, idp, lam = make_env()
    # job vencido
    now_ms = int(__import__("time").time() * 1000)
    put(ddb, "drex-kv", "users", SUB + "/dataExports/ex_viejo",
        {"jobId": "ex_viejo", "sub": SUB, "status": "ready",
         "expiresAt": now_ms - 1000, "createdAt": 1})
    # job de cuenta eliminada
    idp.subs["token-x"] = {"sub": "sub-borrado", "deleted": True, "attrs": {}}
    put(ddb, "drex-kv", "users", "sub-borrado/dataExports/ex_borrado",
        {"jobId": "ex_borrado", "sub": "sub-borrado", "status": "ready",
         "expiresAt": now_ms + 10**9, "createdAt": 1,
         "fileKey": "exports/sub-borrado/ex_borrado.json"})
    s3.put_object(Bucket=L.BUCKET, Key="exports/sub-borrado/ex_borrado.json", Body=b"x")
    # job vigente (no tocar)
    put(ddb, "drex-kv", "users", SUB + "/dataExports/ex_vigente",
        {"jobId": "ex_vigente", "sub": SUB, "status": "ready",
         "expiresAt": now_ms + 10**9, "createdAt": 1})
    res = L.run_sweep()
    j = L.read_job(SUB, "ex_viejo")
    ok(j["status"] == "expired", "vencido -> expired")
    ok(res.get("markedExpired") == 1, "1 marcado")
    ok(L.read_job("sub-borrado", "ex_borrado") is None, "job de cuenta borrada eliminado")
    ok(("drex-exports-002493750027", "exports/sub-borrado/ex_borrado.json") not in s3.objects,
       "objeto S3 de cuenta borrada eliminado")
    ok(L.read_job(SUB, "ex_vigente")["status"] == "ready", "vigente intacto")


def test_strip_secrets():
    print("== strip_secrets_deep ==")
    node = {"user": {"twoFactorSecret": "x", "name": "a"},
            "nested": [{"hashes": [1], "ok": 1}],
            "tok": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.firma",
            "big": "z" * 250000,
            "Password": "p"}
    out = L.strip_secrets_deep(node)
    flat = json.dumps(out)
    ok("twoFactorSecret" not in flat and "hashes" not in flat and "Password" not in flat,
       "llaves prohibidas eliminadas (case-insensitive)")
    ok("token omitido" in flat, "JWT redactado")
    ok("muy largo omitido" in flat, "string gigante truncado")
    ok(out["nested"][0]["ok"] == 1, "datos legitimos intactos")


def test_cors_options():
    print("== CORS / OPTIONS ==")
    make_env()
    ev = {"version": "2.0",
          "requestContext": {"http": {"method": "OPTIONS"}},
          "headers": {"origin": "https://getdrex.com"}, "body": ""}
    r = L.lambda_handler(ev, FakeContext())
    ok(r["statusCode"] == 200, "OPTIONS 200")
    ok(r["headers"].get("Access-Control-Allow-Origin") == "https://getdrex.com",
       "CORS refleja origen permitido")
    r = call("request", {}, token=BAD_TOKEN,
           headers_extra={"origin": "https://evil.example"})
    ok("Access-Control-Allow-Origin" not in r["headers"], "origen no permitido sin header CORS")


def run():
    test_request_happy()
    test_request_auth()
    test_request_snapshot_grande()
    test_request_idempotente()
    test_request_rate_limit()
    test_download_url()
    payload = test_worker_happy()
    test_worker_exclusiones(payload)
    test_worker_token_mismatch()
    test_worker_cancelado()
    test_worker_continuacion()
    test_worker_fallo_parcial()
    test_sweep()
    test_strip_secrets()
    test_cors_options()
    print("")
    print("RESULTADO: %d ok, %d fallos" % (PASSED, FAILED))
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(run())
