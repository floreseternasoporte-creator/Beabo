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
MARKERS_CASE_SENSITIVE = ['TODO', 'FIXME', 'XXX', 'PLACEHOLDER', 'TBD']
# Insensibles a caso.
MARKERS_CASE_FOLD = [
    'lorem ipsum', 'texto de prueba', 'test text', 'dummy text',
    'hello world', 'foo bar',
]
MARKERS_WORD_FOLD = ['asdf', 'qwerty', 'hack']


def js_strings(js):
    """Extrae el contenido de los strings literales '...', "..." y `...`."""
    out = []
    # `...` sin ${} anidado complejo: suficiente como heurística
    for m in re.finditer(r"""'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`""", js):
        s = m.group(0)
        out.append(s[1:-1])
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
    strings = ' '.join(js_strings('\n'.join(scripts)))

    corpus_visible = visible + ' ' + attrs
    corpus_js = ' '.join(js_strings('\n'.join(scripts)))

    hits = []
    # En HTML visible aplican todos los marcadores.
    for m in MARKERS_CASE_SENSITIVE:
        for mm in re.finditer(r'\b' + re.escape(m) + r'\b', corpus_visible):
            hits.append((m, corpus_visible[max(0, mm.start() - 50):mm.end() + 50]))
    for m in MARKERS_CASE_FOLD + MARKERS_WORD_FOLD:
        for mm in re.finditer(r'\b' + re.escape(m) + r'\b', corpus_visible, re.I):
            hits.append((m, corpus_visible[max(0, mm.start() - 50):mm.end() + 50]))
    # En strings JS solo los inequívocos: palabras sueltas como 'qwerty' o
    # 'hack' aparecen en datos legítimos (ej. lista de contraseñas débiles).
    for m in MARKERS_CASE_SENSITIVE:
        for mm in re.finditer(r'\b' + re.escape(m) + r'\b', corpus_js):
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
