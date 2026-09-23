#!/usr/bin/env python3
"""Chequeo de restos de desarrollo en la UI visible de Drex.

Busca marcadores de trabajo pendiente o textos de prueba en:
  1. el texto visible del HTML (sin scripts, estilos ni comentarios),
  2. atributos visibles (placeholder, title, aria-label, alt, value),
  3. los strings literales del JS (gran parte termina renderizada).

Los marcadores en MAYÚSCULAS se buscan sensibles a caso para no confundirlos
con palabras normales ('TODO' no es 'todo'). Falla si encuentra alguno.
"""
import re
import sys

HTML_PATH = 'index.html'

# Sensibles a mayúsculas/minúsculas tal como están escritos.
# TODO exige ':'/'('/'[' detrás: en español "TODO" (todo) es palabra normal
# y aparecía en comentarios ("barría TODO localStorage").
MARKERS_CASE_SENSITIVE = ['FIXME', 'XXX', 'PLACEHOLDER', 'TBD']
MARKERS_TODO_LIKE = ['TODO']
# Insensibles a caso.
MARKERS_CASE_FOLD = [
    'lorem ipsum', 'texto de prueba', 'test text', 'dummy text',
    'hello world', 'foo bar',
]
MARKERS_WORD_FOLD = ['asdf', 'qwerty', 'hack']


def _scan_str(js, i):
    """js[i] es ' o ": devuelve el índice justo después del cierre."""
    q = js[i]
    n = len(js)
    i += 1
    while i < n:
        if js[i] == '\\':
            i += 2
            continue
        if js[i] == q:
            return i + 1
        if js[i] == '\n':
            return i  # string sin terminar: tolerante, no tragar el resto
        i += 1
    return n


def _scan_interp(js, i, out):
    """Tras '${': consume hasta el '}' que lo cierra (maneja anidación).

    Si out es lista, agrega las partes estáticas de templates anidados;
    si es None, solo salta.
    """
    n = len(js)
    depth = 1
    while i < n and depth:
        c = js[i]
        if c in ('"', "'"):
            i = _scan_str(js, i)
            continue
        if c == '`':
            i = _scan_tpl(js, i, out)
            continue
        if c == '/' and i + 1 < n and js[i + 1] == '/':
            j = js.find('\n', i)
            i = n if j == -1 else j
            continue
        if c == '/' and i + 1 < n and js[i + 1] == '*':
            j = js.find('*/', i + 2)
            i = n if j == -1 else j + 2
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
        i += 1
    return i


def _scan_tpl(js, i, out):
    """js[i] es `: agrega sus partes ESTÁTICAS (fuera de ${}) a out.

    El código dentro de ${...} no es texto visible: ignorarlo evita que
    identificadores como PLACEHOLDER en `${x || PLACEHOLDER}` se reporten.
    Devuelve el índice justo después del cierre.
    """
    n = len(js)
    i += 1
    cur = []
    while i < n:
        c = js[i]
        if c == '\\':
            cur.append(js[i:i + 2])
            i += 2
            continue
        if c == '`':
            if out is not None:
                out.append(''.join(cur))
            return i + 1
        if c == '$' and i + 1 < n and js[i + 1] == '{':
            if out is not None:
                out.append(''.join(cur))
            cur = []
            i = _scan_interp(js, i + 2, out)
            continue
        cur.append(c)
        i += 1
    if out is not None:
        out.append(''.join(cur))
    return n


def strip_js_comments(js):
    """Quita //... y /*...*/ respetando strings y templates anidados.

    Sin esto, un backtick dentro de un comentario (ej. "// ... <>&"'` se ...")
    se parsea como apertura de template literal y el extractor de strings
    traga cientos de líneas de código, generando falsos positivos.
    """
    out = []
    i, n = 0, len(js)
    while i < n:
        c = js[i]
        if c in ('"', "'"):
            j = _scan_str(js, i)
            out.append(js[i:j])
            i = j
        elif c == '`':
            j = _scan_tpl(js, i, None)
            out.append(js[i:j])
            i = j
        elif c == '/' and i + 1 < n and js[i + 1] == '/':
            j = js.find('\n', i)
            i = n if j == -1 else j
        elif c == '/' and i + 1 < n and js[i + 1] == '*':
            j = js.find('*/', i + 2)
            i = n if j == -1 else j + 2
        else:
            out.append(c)
            i += 1
    return ''.join(out)


def js_strings(js):
    """Extrae el contenido de los strings literales.

    De los template literals solo las partes estáticas (fuera de ${...});
    maneja templates anidados dentro de interpolaciones.
    """
    out = []
    i, n = 0, len(js)
    while i < n:
        c = js[i]
        if c in ('"', "'"):
            j = _scan_str(js, i)
            out.append(js[i + 1:j - 1] if j <= n and js[j - 1] == c else js[i + 1:j])
            i = j
        elif c == '`':
            i = _scan_tpl(js, i, out)
        else:
            i += 1
    return out


def main():
    h = open(HTML_PATH, encoding='utf-8').read()

    t = re.sub(r'<script.*?</script>', ' ', h, flags=re.S)
    t = re.sub(r'<style.*?</style>', ' ', t, flags=re.S)
    t = re.sub(r'<!--.*?-->', ' ', t, flags=re.S)
    attrs = ' '.join(re.findall(
        r'(?:placeholder|title|aria-label|alt|value)="([^"]*)"', t))
    visible = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', t))

    scripts = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', h, re.S)
    scripts = [strip_js_comments(b) for b in scripts]
    strings = ' '.join(js_strings('\n'.join(scripts)))

    corpus_visible = visible + ' ' + attrs
    corpus_js = ' '.join(js_strings('\n'.join(scripts)))

    hits = []
    # En HTML visible aplican todos los marcadores.
    for m in MARKERS_CASE_SENSITIVE:
        for mm in re.finditer(r'\b' + re.escape(m) + r'\b', corpus_visible):
            hits.append((m, corpus_visible[max(0, mm.start() - 50):mm.end() + 50]))
    for m in MARKERS_TODO_LIKE:
        for mm in re.finditer(r'\b' + re.escape(m) + r'[:(\[]', corpus_visible):
            hits.append((m, corpus_visible[max(0, mm.start() - 50):mm.end() + 50]))
    for m in MARKERS_CASE_FOLD + MARKERS_WORD_FOLD:
        for mm in re.finditer(r'\b' + re.escape(m) + r'\b', corpus_visible, re.I):
            hits.append((m, corpus_visible[max(0, mm.start() - 50):mm.end() + 50]))
    # En strings JS solo los inequívocos: palabras sueltas como 'qwerty' o
    # 'hack' aparecen en datos legítimos (ej. lista de contraseñas débiles).
    for m in MARKERS_CASE_SENSITIVE:
        for mm in re.finditer(r'\b' + re.escape(m) + r'\b', corpus_js):
            hits.append((m, corpus_js[max(0, mm.start() - 50):mm.end() + 50]))
    for m in MARKERS_TODO_LIKE:
        for mm in re.finditer(r'\b' + re.escape(m) + r'[:(\[]', corpus_js):
            hits.append((m, corpus_js[max(0, mm.start() - 50):mm.end() + 50]))
    for m in MARKERS_CASE_FOLD:
        for mm in re.finditer(r'\b' + re.escape(m) + r'\b', corpus_js, re.I):
            hits.append((m, corpus_js[max(0, mm.start() - 50):mm.end() + 50]))

    if hits:
        print('FALLO: restos de desarrollo en la UI visible:')
        seen = set()
        for m, ctx in hits:
            key = (m, ctx)
            if key in seen:
                continue
            seen.add(key)
            print(f'  - [{m}] ...{re.sub(r"\s+", " ", ctx).strip()[:110]}...')
        return 1
    print('OK: sin TODO/FIXME ni textos de prueba en la UI visible')
    return 0


if __name__ == '__main__':
    sys.exit(main())
