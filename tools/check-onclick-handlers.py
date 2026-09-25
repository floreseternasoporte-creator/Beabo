#!/usr/bin/env python3
"""Chequeo de handlers inline de Drex.

Extrae todos los atributos on*="..." de index.html (incluidos los generados
dentro de strings JS) y verifica que cada función global llamada exista:
definida en los scripts inline o en la lista de globales externos.

Falla si un handler llama a una función que no existe (typo, función
eliminada, etc.). Los métodos sobre resultados de expresiones
— ej. document.getElementById('x').click() — se omiten: no se pueden
resolver de forma estática y casi siempre son métodos DOM.
"""
import re
import sys

HTML_PATH = 'index.html'

# Globales que no están definidos en index.html pero existen en runtime.
EXTERNAL_GLOBALS = {
    'DrexCloud',        # drex-cloud.js
    'DrexRecoveryCodes',  # recovery-codes.js (script defer)
    'firebase',         # SDK compat (si se usa)
}

# Raíces que nunca son funciones nuestras: keywords, builtins y DOM.
SKIP_ROOTS = {
    'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
    'new', 'this', 'event',
    'console', 'JSON', 'Math', 'Date', 'RegExp', 'Error', 'Map', 'Set',
    'Promise', 'Intl', 'URL', 'URLSearchParams', 'FormData', 'FileReader',
    'Image', 'Audio', 'CustomEvent', 'MutationObserver',
    'window', 'document', 'localStorage', 'sessionStorage', 'navigator',
    'location', 'history', 'fetch', 'alert', 'confirm', 'prompt',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'requestAnimationFrame', 'getComputedStyle',
    'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent',
    'decodeURIComponent', 'String', 'Number', 'Boolean', 'Array', 'Object',
}


def main():
    h = open(HTML_PATH, encoding='utf-8').read()

    handlers = re.findall(r'on\w+\s*=\\?"((?:[^"\\]|\\.)*)\\?"', h)

    scripts = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', h, re.S)
    defined = set()
    for b in scripts:
        defined.update(re.findall(r'(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(', b))
        defined.update(re.findall(r'(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=', b))
        # Baro expone globales vía baro6dExpose('nombre', fn) -> window[nombre] = fn
        defined.update(re.findall(r"baro6dExpose\(\s*['\"]([A-Za-z_$][\w$]*)['\"]", b))
        defined.update(re.findall(r'window\.([A-Za-z_$][\w$]*)\s*=', b))
        defined.update(re.findall(r'class\s+([A-Za-z_$][\w$]*)', b))
    defined |= EXTERNAL_GLOBALS

    errors = []
    for hd in handlers:
        for cm in re.finditer(r'([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(', hd):
            chain, start = cm.group(1), cm.start()
            # Método sobre el resultado de una expresión: ).click(, ].foo(, 'x'.bar(.
            # (Si el receptor fuera un identificador simple, el regex ya habría
            # capturado la cadena completa desde su inicio.)
            if start > 0 and hd[start - 1] == '.':
                continue
            root = chain.split('.')[0]
            if root in SKIP_ROOTS or root in defined:
                continue
            errors.append(f'{chain}()  en  on*="{hd[:90]}"')

    if errors:
        seen, uniq = set(), []
        for e in errors:
            key = e.split('  en')[0]
            if key not in seen:
                seen.add(key)
                uniq.append(e)
        print('FALLO: handlers que llaman funciones inexistentes:')
        for e in uniq:
            print('  -', e)
        return 1
    print(f'OK: {len(handlers)} handlers inline, '
          f'todas las funciones llamadas existen ({len(defined)} definidas)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
