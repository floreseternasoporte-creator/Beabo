#!/usr/bin/env python3
"""Tests de regresión para tools/check-ui-leftovers.py.

El extractor de strings JS es load-bearing (CI falla si reporta de más o de
menos): estos tests fijan su comportamiento ante los casos que ya dieron
falsos positivos (backticks en comentarios, ${...} con identificadores,
templates anidados) y ante marcadores reales.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib

m = importlib.import_module('check-ui-leftovers')

FAILS = []


def check(name, cond):
    print(('OK  ' if cond else 'FAIL') + ' ' + name)
    if not cond:
        FAILS.append(name)


# 1. Backtick dentro de un comentario no debe tragar código posterior.
js = "// comenta `backtick` y sigue\nvar s = 'hola';\nvar t = 'TODO: real';"
strings = m.js_strings(m.strip_js_comments(js))
check('backtick en comentario no contamina', strings == ['hola', 'TODO: real'])

# 2. Interpolaciones ${...} no son texto visible.
strings = m.js_strings("const t = `${esc(p) || PLACEHOLDER} fin`;")
check('${} excluido del corpus', all('PLACEHOLDER' not in s for s in strings))
check('parte estática conservada', any('fin' in s for s in strings))

# 3. Templates anidados dentro de ${...}.
strings = m.js_strings("const x = `a ${b => `c ${d} e`} f`;")
check('templates anidados', strings == ['a ', 'c ', ' e', ' f'])

# 4. Comentarios // y /* */ con comillas dentro se eliminan.
js = 'var a = 1; // dice "hola"\n/* bloque \'x\' */\nvar u = "https://a.b/c";'
clean = m.strip_js_comments(js)
check('comentarios eliminados', '//' not in clean.replace('https://', ''))
check('URL intacta', 'https://a.b/c' in clean)

# 5. TODO exige :/(/[ (español "TODO" no es marcador).
import re
pat = r'\bTODO[:(\[]'
check('TODO: detectado', bool(re.search(pat, 'arreglar TODO: esto')))
check('TODO español ignorado', not re.search(pat, 'barría TODO localStorage'))

# 6. Marcador real en string simple sí se extrae.
strings = m.js_strings('var s = "lorem ipsum dolor";')
check('lorem ipsum detectado', strings == ['lorem ipsum dolor'])

# 7. String sin terminar no traga el resto del archivo.
strings = m.js_strings("var a = 'incompleto\nvar b = 'ok';")
check('string sin terminar tolerante', 'ok' in strings)

if FAILS:
    print(f'\n{len(FAILS)} tests fallaron')
    sys.exit(1)
print('\nTodos los tests pasaron')
