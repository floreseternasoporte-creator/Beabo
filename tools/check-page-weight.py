#!/usr/bin/env python3
"""Chequeo del peso de index.html de Drex.

El service worker es network-first para el HTML: cada navegación vuelve a
descargar index.html completo. Este chequeo pone un presupuesto para que el
peso no crezca sin control y la app siga cargando rápido en el teléfono.

Falla si index.html supera el presupuesto en bytes crudos o con gzip
(lo que realmente viaja por la red). Si hay que subir el presupuesto,
se hace de forma consciente editando BUDGET_* aquí.
"""
import gzip
import re
import sys

HTML_PATH = 'index.html'
BUDGET_RAW = 2_500_000      # 2.5 MB
BUDGET_GZIP = 700_000       # 700 KB


def main():
    raw = open(HTML_PATH, 'rb').read()
    raw_n = len(raw)
    gzip_n = len(gzip.compress(raw, compresslevel=9))

    h = raw.decode('utf-8')
    blocks = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', h, re.S)
    sizes = sorted(
        ((len(b.encode('utf-8')), i) for i, b in enumerate(blocks)),
        reverse=True,
    )

    print(f'index.html: {raw_n/1e6:.2f} MB crudo / {gzip_n/1e3:.0f} KB gzip '
          f'(presupuesto: {BUDGET_RAW/1e6:.1f} MB / {BUDGET_GZIP/1e3:.0f} KB)')
    print('Bloques inline más pesados:')
    for s, i in sizes[:5]:
        print(f'  bloque {i}: {s/1024:.0f} KB')

    errors = []
    if raw_n > BUDGET_RAW:
        errors.append(
            f'peso crudo {raw_n/1e6:.2f} MB supera el presupuesto '
            f'de {BUDGET_RAW/1e6:.1f} MB')
    if gzip_n > BUDGET_GZIP:
        errors.append(
            f'peso gzip {gzip_n/1e3:.0f} KB supera el presupuesto '
            f'de {BUDGET_GZIP/1e3:.0f} KB')
    if errors:
        print('FALLO: presupuesto de peso excedido')
        for e in errors:
            print('  -', e)
        print('Los bloques de arriba muestran dónde está el peso.')
        return 1
    print('OK: dentro del presupuesto de peso')
    return 0


if __name__ == '__main__':
    sys.exit(main())
