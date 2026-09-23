"""Tests de la lógica pura de drex-error-ingest (sin AWS)."""
import sys
import time

sys.path.insert(0, ".")

import lambda_function as L


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        raise SystemExit(1)


now = int(time.time())
good = {
    "v": 1, "ts": now, "kind": "login", "msg": "boom",
    "stack": "Error: boom\n at f (a.js:1:2)", "url": "https://x/Beabo/",
    "line": 12, "col": 3, "sig": "boom|at f",
}

ev = L._valid_event(dict(good), now)
check("evento válido pasa", ev is not None and ev["kind"] == "login")
check("firma saneada", ev["sig"] == "boom_at_f")

check("kind inválido se rechaza", L._valid_event({**good, "kind": "a b"}, now) is None)
check("kind vacío se rechaza", L._valid_event({**good, "kind": ""}, now) is None)
check("msg vacío se rechaza", L._valid_event({**good, "msg": ""}, now) is None)
check("msg se acota a 300", len(L._valid_event({**good, "msg": "x" * 999}, now)["msg"]) == 300)
check("stack se acota a 2048", len(L._valid_event({**good, "stack": "y" * 9999}, now)["stack"]) == 2048)
check("ts futuro lejano se rechaza", L._valid_event({**good, "ts": now + 90000}, now) is None)
check("ts pasado lejano se rechaza", L._valid_event({**good, "ts": now - 90000}, now) is None)
check("ts en ventana pasa", L._valid_event({**good, "ts": now - 80000}, now) is not None)
check("no-dict se rechaza", L._valid_event("hola", now) is None)
check("line no numérico -> None", L._valid_event({**good, "line": "abc"}, now)["line"] is None)
check("sig con caracteres raros se sanea", L._valid_event({**good, "sig": "a/b\\c:d"}, now)["sig"] == "a_b_c_d")

# _clean_str con no-string
check("clean_str no-string -> ''", L._clean_str(None, 10) == "")
check("clean_int enorme -> None", L._clean_int(2**60) is None)

# --- Normalización ms->s con el PAYLOAD REAL del cliente ---
# Exactamente lo que construye relReportError() en drex-cloud.js:
# { v:1, ts: Date.now(), kind, msg, stack, url, line, col, sig }
ms_now = int(time.time() * 1000)


def client_event(ts):
    return {
        "v": 1, "ts": ts, "kind": "error", "msg": "boom",
        "stack": "Error: boom\n at f (a.js:1:2)",
        "url": "https://floreseternasoporte-creator.github.io/Beabo/",
        "line": 12, "col": 3, "sig": "boom|at f",
    }


ev = L._valid_event(client_event(ms_now), now)
check("payload real del cliente (ts en ms) pasa", ev is not None)
check("ts en ms se normaliza a segundos", ev["ts"] == ms_now // 1000)
check("ts normalizado dentro de ±1 día", abs(ev["ts"] - now) <= 86400)

ev = L._valid_event(client_event(now), now)
check("payload en segundos (compat) pasa intacto", ev is not None and ev["ts"] == now)

check("ms de hace 2 días se rechaza",
      L._valid_event(client_event(ms_now - 2 * 86400 * 1000), now) is None)
check("ms futuro (+2 días) se rechaza",
      L._valid_event(client_event(ms_now + 2 * 86400 * 1000), now) is None)
check("ms 25h atrás se rechaza",
      L._valid_event(client_event(ms_now - 25 * 3600 * 1000), now) is None)
check("ms 23h atrás pasa",
      L._valid_event(client_event(ms_now - 23 * 3600 * 1000), now) is not None)
check("ts no numérico se rechaza",
      L._valid_event(client_event("ayer"), now) is None)
check("1e12-1 como segundos (año 33658) se rechaza",
      L._valid_event(client_event(10**12 - 1), now) is None)


# --- El ts normalizado deja el TTL y la sk sanos ---
class FakeTable:
    def __init__(self):
        self.items = []

    def put_item(self, Item):
        self.items.append(Item)
        return {}


ft = FakeTable()
ev_ms = L._valid_event(client_event(ms_now), now)
L._store_events(ft, [ev_ms], "20260923")
check("se persiste 1 ítem", len(ft.items) == 1)
item = ft.items[0]
check("pk clientErrors", item["pk"] == "clientErrors")
check("ttl = ts + 7 días en segundos", item["ttl"] == ev_ms["ts"] + 7 * 24 * 3600)
check("ttl es epoch-segundos sano (< 2**32)", item["ttl"] < 2**32)
check("sk embebe el ts en segundos", str(ev_ms["ts"]) in item["sk"])

print("RESULTADO: TODO OK")
