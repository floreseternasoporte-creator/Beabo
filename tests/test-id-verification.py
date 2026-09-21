"""
Tests unitarios de la Lambda drex-id-verification.

Mocks: Cognito, DynamoDB (drex-kv) y la API de Veriff. No toca red ni AWS real.
boto3 se sustituye en sys.modules antes de importar lambda_function.

Uso:
    python3 tests/test-id-verification.py
"""

import base64
import hashlib
import hmac
import io
import json
import os
import sys
import unittest

# boto3 no existe en este entorno; la Lambda lo importa de forma tolerante,
# pero nos aseguramos de que el stub esté presente antes de la importación.
sys.modules.setdefault("boto3", None)

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "lambda-drex-id-verification"))

import lambda_function as lf  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeCognito:
    def __init__(self):
        self.users = {}  # token -> dict(sub=..., attrs)

    def get_user(self, AccessToken):
        if AccessToken not in self.users:
            raise Exception("NotAuthorizedException")
        u = self.users[AccessToken]
        return {"UserAttributes": [{"Name": "sub", "Value": u["sub"]}] +
                                  [{"Name": k, "Value": v} for k, v in u.get("attrs", {}).items()]}


class FakeTable:
    def __init__(self):
        self.items = {}  # (pk, sk) -> {"pk","sk","v"}

    def get_item(self, Key):
        it = self.items.get((Key["pk"], Key["sk"]))
        return {"Item": it} if it else {}

    def put_item(self, Item):
        self.items[(Item["pk"], Item["sk"])] = Item
        return {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames,
                    ExpressionAttributeValues, ReturnValues):
        k = (Key["pk"], Key["sk"])
        it = self.items.get(k, {"pk": Key["pk"], "sk": Key["sk"]})
        it["n"] = it.get("n", 0) + ExpressionAttributeValues[":one"]
        self.items[k] = it
        return {"Attributes": {"n": it["n"]}}


class Ctx:
    pass


def make_event(method, path, headers=None, body=None, ip="1.2.3.4"):
    return {
        "requestContext": {"http": {"method": method, "path": path, "sourceIp": ip}},
        "headers": dict(headers or {}),
        "body": body,
        "isBase64Encoded": False,
    }


AUTH_HEADERS = {"Authorization": "Bearer GOODTOKEN", "host": "abc.lambda-url.us-east-1.on.aws"}


# ---------------------------------------------------------------------------
# Base con entorno limpio
# ---------------------------------------------------------------------------

class Base(unittest.TestCase):
    def setUp(self):
        self.cognito = FakeCognito()
        self.table = FakeTable()
        lf._cognito_client = self.cognito
        lf._users_table = self.table
        lf.IDV_MODE = "demo"
        lf.VERIFF_API_KEY = "testkey"
        lf.VERIFF_SECRET_KEY = "testsecret"
        lf.MAX_SESSIONS_PER_USER_DAY = 5
        lf.MAX_SESSIONS_PER_IP_DAY = 20
        self.cognito.users["GOODTOKEN"] = {"sub": "SUB123"}
        self.cognito.users["OTHERTOKEN"] = {"sub": "SUB999"}

    def create_session(self, token="GOODTOKEN", country="CU", document_type="passport",
                       ip="1.2.3.4"):
        ev = make_event("POST", "/session",
                        {"Authorization": "Bearer " + token,
                         "host": "abc.lambda-url.us-east-1.on.aws"},
                        json.dumps({"country": country, "documentType": document_type}),
                        ip=ip)
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 200, r["body"])
        return json.loads(r["body"])

    def session_record(self, sub, session_id):
        it = self.table.items.get(("users", "%s/idVerification/sessions/%s" % (sub, session_id)))
        return json.loads(it["v"]) if it else None


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

class TestAuth(Base):
    def test_valid_token_extracts_sub_from_token(self):
        r = lf.lambda_handler(make_event("GET", "/status", AUTH_HEADERS), Ctx())
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(json.loads(r["body"])["status"], "none")

    def test_invalid_token_401(self):
        ev = make_event("GET", "/status", {"Authorization": "Bearer BADTOKEN"})
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 401)

    def test_missing_bearer_401(self):
        ev = make_event("GET", "/status", {})
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 401)
        self.assertEqual(json.loads(r["body"])["error"], "missing_bearer")

    def test_anti_idor_sub_comes_only_from_token(self):
        # El cliente NO puede elegir el sub: no hay ningún parámetro de sub en
        # el contrato y el estado se lee con el sub del token.
        b1 = self.create_session(token="GOODTOKEN")
        b2 = self.create_session(token="OTHERTOKEN")
        self.assertIsNotNone(self.session_record("SUB123", b1["sessionId"]))
        self.assertIsNotNone(self.session_record("SUB999", b2["sessionId"]))
        self.assertIsNone(self.session_record("SUB123", b2["sessionId"]))
        # GET /status con el token de SUB999 ve SOLO lo suyo (su propio
        # 'pending' tras crear sesion); nunca nada de SUB123.
        ev = make_event("GET", "/status", {"Authorization": "Bearer OTHERTOKEN"})
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(json.loads(r["body"])["status"], "pending")
        v123 = json.loads(self.table.items[("users", "SUB123/birthdayVerification")]["v"])
        self.assertEqual(v123["status"], "pending")  # el suyo propio, separado


# ---------------------------------------------------------------------------
# POST /session
# ---------------------------------------------------------------------------

class TestCreateSession(Base):
    def test_demo_session_ok(self):
        b = self.create_session()
        self.assertIn("sessionId", b)
        self.assertIn("/demo/verify?token=", b["verificationUrl"])
        self.assertEqual(b["mode"], "demo")
        rec = self.session_record("SUB123", b["sessionId"])
        self.assertIsNotNone(rec)
        self.assertEqual(rec["status"], "pending")
        self.assertEqual(rec["country"], "CU")
        self.assertEqual(rec["documentType"], "passport")
        self.assertEqual(rec["provider"], "demo")
        # índice demo -> (sub, sessionId)
        token = b["verificationUrl"].split("token=")[1]
        it = self.table.items.get(("users", "idVerification/demoIndex/" + token))
        self.assertIsNotNone(it)

    def test_bad_country(self):
        ev = make_event("POST", "/session", AUTH_HEADERS,
                        json.dumps({"country": "XX", "documentType": "passport"}))
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 400)
        self.assertEqual(json.loads(r["body"])["error"], "bad_country")

    def test_bad_document_type(self):
        ev = make_event("POST", "/session", AUTH_HEADERS,
                        json.dumps({"country": "US", "documentType": "dni"}))
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 400)

    def test_bad_payload(self):
        ev = make_event("POST", "/session", AUTH_HEADERS, "{no json")
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 400)

    def test_client_doc_type_aliases(self):
        # El cliente Drex envía national_id / drivers_license (IDV_DOCS_BY_COUNTRY);
        # la Lambda los normaliza a los canónicos id_card / driving_licence.
        for alias, canon in [("national_id", "id_card"),
                             ("drivers_license", "driving_licence")]:
            ev = make_event("POST", "/session", AUTH_HEADERS,
                            json.dumps({"country": "CU", "documentType": alias}),
                            ip="7.7.7.%d" % len(alias))
            r = lf.lambda_handler(ev, Ctx())
            self.assertEqual(r["statusCode"], 200, (alias, r["body"]))
            b = json.loads(r["body"])
            rec = self.session_record("SUB123", b["sessionId"])
            self.assertEqual(rec["documentType"], canon)

    def test_session_writes_pending_status(self):
        # Fuente de verdad: crear sesión marca birthdayVerification=pending.
        b = self.create_session()
        it = self.table.items.get(("users", "SUB123/birthdayVerification"))
        self.assertIsNotNone(it)
        v = json.loads(it["v"])
        self.assertEqual(v["status"], "pending")
        self.assertEqual(v["provider"], "demo")

    def test_session_does_not_revoke_verified(self):
        # Una sesión nueva NO revoca una verificación ya aprobada.
        self.table.items[("users", "SUB123/birthdayVerification")] = {
            "v": json.dumps({"status": "verified", "provider": "veriff"})}
        b = self.create_session()
        it = self.table.items.get(("users", "SUB123/birthdayVerification"))
        self.assertEqual(json.loads(it["v"])["status"], "verified")

    def test_all_countries_and_doc_types(self):
        lf.MAX_SESSIONS_PER_USER_DAY = 100
        for c in ["CU", "US", "CA", "MX", "BR"]:
            for d in ["passport", "id_card", "driving_licence"]:
                ev = make_event(
                    "POST", "/session",
                    {"Authorization": "Bearer GOODTOKEN",
                     "host": "abc.lambda-url.us-east-1.on.aws"},
                    json.dumps({"country": c, "documentType": d}),
                    ip="9.9.9.%s" % (ord(c[0]) + len(d)))  # IP distinta p/evitar rate limit
                r = lf.lambda_handler(ev, Ctx())
                self.assertEqual(r["statusCode"], 200, (c, d, r["body"]))


# ---------------------------------------------------------------------------
# Rate limit
# ---------------------------------------------------------------------------

class TestRateLimit(Base):
    def test_user_rate_limit_5_per_day(self):
        for i in range(5):
            b = self.create_session(ip="10.0.0.%d" % i)
            self.assertIn("sessionId", b)
        ev = make_event("POST", "/session", AUTH_HEADERS,
                        json.dumps({"country": "CU", "documentType": "passport"}),
                        ip="10.0.0.99")
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 429)

    def test_ip_rate_limit(self):
        lf.MAX_SESSIONS_PER_IP_DAY = 2
        # dos usuarios distintos desde la misma IP
        self.create_session(token="GOODTOKEN", ip="5.6.7.8")
        self.create_session(token="OTHERTOKEN", ip="5.6.7.8")
        ev = make_event("GET", "/status",
                        {"Authorization": "Bearer GOODTOKEN"}, ip="5.6.7.8")
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 429)


# ---------------------------------------------------------------------------
# GET /status
# ---------------------------------------------------------------------------

class TestStatus(Base):
    def test_status_none_default(self):
        r = lf.lambda_handler(make_event("GET", "/status", AUTH_HEADERS), Ctx())
        body = json.loads(r["body"])
        self.assertEqual(body, {"status": "none", "country": None,
                                "verifiedAt": None, "method": None, "provider": None})

    def test_status_after_verified(self):
        lf.apply_decision(sub="SUB123", session_id="s1", veriff_status="approved",
                          provider_name="demo", country="CU")
        r = lf.lambda_handler(make_event("GET", "/status", AUTH_HEADERS), Ctx())
        body = json.loads(r["body"])
        self.assertEqual(body["status"], "verified")
        self.assertEqual(body["country"], "CU")
        self.assertEqual(body["method"], "id_document")
        self.assertEqual(body["provider"], "demo")
        self.assertIsNotNone(body["verifiedAt"])


# ---------------------------------------------------------------------------
# Webhook Veriff (modo producción)
# ---------------------------------------------------------------------------

def sign(secret, raw):
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


class TestWebhook(Base):
    def setUp(self):
        super().setUp()
        lf.IDV_MODE = "production"
        # sesión "real" de Veriff: creamos el índice proveedor manualmente
        self.table.items[("users", "SUB123/idVerification/sessions/sess1")] = {
            "pk": "users", "sk": "SUB123/idVerification/sessions/sess1",
            "v": json.dumps({"status": "pending", "country": "US",
                             "provider": "veriff", "mode": "production"})}
        self.table.items[("users", "idVerification/providerIndex/veriff-abc")] = {
            "pk": "users", "sk": "idVerification/providerIndex/veriff-abc",
            "v": json.dumps({"sub": "SUB123", "sessionId": "sess1"})}

    def webhook(self, payload, secret="testsecret", headers_extra=None, raw_override=None):
        raw = raw_override if raw_override is not None else json.dumps(payload).encode()
        headers = {"X-HMAC-SIGNATURE": sign(secret, raw)}
        if headers_extra:
            headers.update(headers_extra)
        return make_event("POST", "/webhook", headers, raw.decode())

    def payload(self, status="approved", psid="veriff-abc", country="US"):
        return {"id": psid, "verification": {
            "id": psid, "status": status, "code": 9001,
            "document": {"type": "PASSPORT", "country": country},
            "person": {"firstName": "Jane", "lastName": "Doe"},
            "timestamp": "2026-09-20T00:00:00Z"}}

    def test_valid_signature_approved(self):
        ev = self.webhook(self.payload("approved"))
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 200)
        age = json.loads(self.table.items[("users", "SUB123/birthdayVerification")]["v"])
        self.assertEqual(age["status"], "verified")
        self.assertEqual(age["provider"], "veriff")
        self.assertEqual(age["method"], "id_document")
        self.assertIn("verifiedAt", age)
        sess = json.loads(self.table.items[("users", "SUB123/idVerification/sessions/sess1")]["v"])
        self.assertEqual(sess["status"], "verified")
        # notificación in-app escrita con la convención de la app
        notifs = [k for k in self.table.items if k[0] == "notifications" and k[1].startswith("SUB123/")]
        self.assertEqual(len(notifs), 1)
        n = json.loads(self.table.items[notifs[0]]["v"])
        self.assertEqual(n["type"], "id_verification")
        self.assertFalse(n["read"])
        self.assertTrue(n["system"])
        self.assertIn("message", n)

    def test_invalid_signature_403(self):
        ev = self.webhook(self.payload("approved"), secret="WRONG")
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 403)
        self.assertNotIn(("users", "SUB123/birthdayVerification"), self.table.items)

    def test_missing_signature_403(self):
        ev = make_event("POST", "/webhook", {}, json.dumps(self.payload("approved")))
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 403)

    def test_declined_maps_to_rejected(self):
        r = lf.lambda_handler(self.webhook(self.payload("declined")), Ctx())
        self.assertEqual(r["statusCode"], 200)
        age = json.loads(self.table.items[("users", "SUB123/birthdayVerification")]["v"])
        self.assertEqual(age["status"], "rejected")

    def test_resubmission_stays_pending(self):
        r = lf.lambda_handler(self.webhook(self.payload("resubmission_requested")), Ctx())
        self.assertEqual(r["statusCode"], 200)
        age = json.loads(self.table.items[("users", "SUB123/birthdayVerification")]["v"])
        self.assertEqual(age["status"], "pending")
        notifs = [k for k in self.table.items if k[0] == "notifications"]
        self.assertEqual(len(notifs), 1)  # aviso de "necesitamos más información"

    def test_abandoned_maps_to_expired(self):
        r = lf.lambda_handler(self.webhook(self.payload("abandoned")), Ctx())
        self.assertEqual(r["statusCode"], 200)
        age = json.loads(self.table.items[("users", "SUB123/birthdayVerification")]["v"])
        self.assertEqual(age["status"], "expired")

    def test_unknown_session_404(self):
        r = lf.lambda_handler(self.webhook(self.payload("approved", psid="nope")), Ctx())
        self.assertEqual(r["statusCode"], 404)

    def test_bad_payload_400(self):
        raw = b"{not json"
        ev = make_event("POST", "/webhook",
                        {"X-HMAC-SIGNATURE": sign("testsecret", raw)}, raw.decode())
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 400)

    def test_webhook_disabled_in_demo_mode(self):
        lf.IDV_MODE = "demo"
        r = lf.lambda_handler(self.webhook(self.payload("approved")), Ctx())
        self.assertEqual(r["statusCode"], 404)

    def test_started_event_updates_session_only(self):
        r = lf.lambda_handler(self.webhook(self.payload("started")), Ctx())
        self.assertEqual(r["statusCode"], 200)
        age = json.loads(self.table.items[("users", "SUB123/birthdayVerification")]["v"])
        self.assertEqual(age["status"], "pending")


# ---------------------------------------------------------------------------
# Flujo demo completo
# ---------------------------------------------------------------------------

class TestDemoFlow(Base):
    def test_demo_page_ok(self):
        b = self.create_session()
        token = b["verificationUrl"].split("token=")[1]
        ev = make_event("GET", "/demo/verify", {"host": "x"}, ip="2.2.2.2")
        ev["queryStringParameters"] = {"token": token}
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 200)
        self.assertIn("MODO DEMO", r["body"])
        self.assertNotIn(token, "")  # el token viaja en la URL, no se expone en logs

    def test_demo_page_bad_token(self):
        ev = make_event("GET", "/demo/verify", {}, ip="2.2.2.2")
        ev["queryStringParameters"] = {"token": "bad"}
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 404)

    def test_demo_complete_approve(self):
        b = self.create_session()
        token = b["verificationUrl"].split("token=")[1]
        ev = make_event("POST", "/demo/complete", {"host": "x"},
                        json.dumps({"token": token, "decision": "approve"}), ip="2.2.2.2")
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 200)
        ev2 = make_event("GET", "/status", AUTH_HEADERS, ip="2.2.2.3")
        body = json.loads(lf.lambda_handler(ev2, Ctx())["body"])
        self.assertEqual(body["status"], "verified")
        self.assertEqual(body["provider"], "demo")

    def test_demo_complete_reject(self):
        b = self.create_session()
        token = b["verificationUrl"].split("token=")[1]
        ev = make_event("POST", "/demo/complete", {"host": "x"},
                        json.dumps({"token": token, "decision": "reject"}), ip="2.2.2.2")
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 200)
        ev2 = make_event("GET", "/status", AUTH_HEADERS, ip="2.2.2.3")
        self.assertEqual(json.loads(lf.lambda_handler(ev2, Ctx())["body"])["status"], "rejected")

    def test_demo_complete_bad_token(self):
        ev = make_event("POST", "/demo/complete", {},
                        json.dumps({"token": "zzz", "decision": "approve"}), ip="2.2.2.2")
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 404)

    def test_demo_complete_bad_decision(self):
        ev = make_event("POST", "/demo/complete", {},
                        json.dumps({"token": "zzz", "decision": "maybe"}), ip="2.2.2.2")
        r = lf.lambda_handler(ev, Ctx())
        self.assertEqual(r["statusCode"], 400)

    def test_demo_endpoints_disabled_in_production(self):
        lf.IDV_MODE = "production"
        ev = make_event("GET", "/demo/verify", {}, ip="2.2.2.2")
        ev["queryStringParameters"] = {"token": "x"}
        self.assertEqual(lf.lambda_handler(ev, Ctx())["statusCode"], 404)
        ev2 = make_event("POST", "/demo/complete", {},
                         json.dumps({"token": "x", "decision": "approve"}), ip="2.2.2.2")
        self.assertEqual(lf.lambda_handler(ev2, Ctx())["statusCode"], 404)


# ---------------------------------------------------------------------------
# Proveedor Veriff
# ---------------------------------------------------------------------------

class TestVeriffProvider(Base):
    def test_missing_keys_raises(self):
        with self.assertRaises(RuntimeError):
            lf.VeriffProvider("", "")

    def test_create_session_calls_veriff(self):
        calls = {}

        def fake_post(url, headers, body_bytes, timeout=15):
            calls["url"] = url
            calls["headers"] = headers
            calls["body"] = json.loads(body_bytes.decode())
            resp_body = json.dumps({"verification": {
                "id": "veriff-123", "url": "https://magic.veriff.me/v/veriff-123"}})
            return 201, resp_body.encode()

        old = lf.veriff_http_post
        lf.veriff_http_post = fake_post
        try:
            p = lf.VeriffProvider("k", "s")
            out = p.create_session(country="CU", document_type="passport",
                                   vendor_data="sess-1",
                                   callback_url="https://x/webhook")
        finally:
            lf.veriff_http_post = old
        self.assertEqual(calls["url"], "https://stationapi.veriff.com/v1/sessions")
        self.assertEqual(calls["headers"]["X-AUTH-CLIENT"], "k")
        self.assertIn("X-HMAC-SIGNATURE", calls["headers"])
        doc = calls["body"]["verification"]["document"]
        self.assertEqual(doc, {"type": "PASSPORT", "country": "CU"})
        self.assertEqual(out["provider_session_id"], "veriff-123")
        self.assertTrue(out["verification_url"].startswith("https://"))

    def test_verify_webhook_signature_ok(self):
        p = lf.VeriffProvider("k", "s")
        raw = b'{"verification":{"id":"a","status":"approved"}}'
        sig = hmac.new(b"s", raw, hashlib.sha256).hexdigest()
        self.assertTrue(p.verify_webhook(raw, {"x-hmac-signature": sig}))

    def test_verify_webhook_signature_bad(self):
        p = lf.VeriffProvider("k", "s")
        raw = b'{"verification":{"id":"a","status":"approved"}}'
        self.assertFalse(p.verify_webhook(raw, {"x-hmac-signature": "00" * 32}))

    def test_demo_provider_interface(self):
        p = lf.DemoProvider()
        self.assertIsInstance(p, lf.IdentityProvider)
        self.assertEqual(p.name, "demo")
        self.assertFalse(p.verify_webhook(b"{}", {}))


# ---------------------------------------------------------------------------
# Logs sin PII
# ---------------------------------------------------------------------------

class TestNoPIIInLogs(Base):
    def test_logs_contain_no_pii(self):
        buf = io.StringIO()
        old = sys.stdout
        sys.stdout = buf
        try:
            # flujo con datos "sensibles" que nunca deben aparecer en logs
            ev = make_event("POST", "/session", AUTH_HEADERS,
                            json.dumps({"country": "CU", "documentType": "passport"}))
            r = lf.lambda_handler(ev, Ctx())
            b = json.loads(r["body"])
            token = b["verificationUrl"].split("token=")[1]
            evc = make_event("POST", "/demo/complete", {},
                             json.dumps({"token": token, "decision": "approve"}))
            lf.lambda_handler(evc, Ctx())
            # auth fallida tampoco debe loguear el token
            lf.lambda_handler(make_event("GET", "/status",
                                         {"Authorization": "Bearer SECRETTOKEN123"}), Ctx())
        finally:
            sys.stdout = old
        logs = buf.getvalue()
        for secret in ["SECRETTOKEN123", "PASSPORT", "Jane", "Doe",
                       "token=" + "x" * 8]:
            self.assertNotIn(secret, logs, "PII en logs: %s" % secret)
        # el token demo completo tampoco debe salir en claro
        self.assertNotIn(token, logs)
        # pero sí hay trazabilidad por sessionId
        self.assertIn("session_created", logs)
        self.assertIn("decision_applied", logs)
        self.assertIn(b["sessionId"], logs)


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules["__main__"])
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    total = result.testsRun
    failed = len(result.failures) + len(result.errors)
    print("\n==== RESULTADO: %d/%d tests OK ====" % (total - failed, total))
    sys.exit(1 if failed else 0)
