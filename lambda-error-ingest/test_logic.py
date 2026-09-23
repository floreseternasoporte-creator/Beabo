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

print("RESULTADO: TODO OK")
