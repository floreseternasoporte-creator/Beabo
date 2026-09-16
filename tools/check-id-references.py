#!/usr/bin/env python3
"""Chequeo de referencias internas a IDs en Drex.

Recoge todos los IDs que existen (atributos id="..." en el HTML, incluidos los
generados en strings JS, más los creados dinámicamente con .id = '...' o
setAttribute('id', ...)) y verifica que cada referencia estática a un ID
exista:

  - getElementById('x') / getElementById("x") / getElementById(`x`)
  - querySelector('#x') / querySelectorAll('#x')
  - href="#x", <label for="x">, aria-controls/labelledby/describedby="x"

Solo se revisan referencias con string literal estático; las dinámicas
(getElementById('msg-' + id), variables, ${} en templates) se omiten porque
no se pueden resolver de forma estática.
"""
import re
import sys

HTML_PATH = 'index.html'


def main():
    h = open(HTML_PATH, encoding='utf-8').read()

    dom_ids = set(re.findall(r'id="([\w-]+)"', h))
    dom_ids.update(re.findall(r"""\.id\s*=\s*['"]([\w-]+)['"]""", h))
    dom_ids.update(re.findall(r"""setAttribute\(\s*['"]id['"]\s*,\s*['"]([\w-]+)['"]\s*\)""", h))

    # Familias de IDs generados en templates: id="theme-btn-${key}" -> prefijo 'theme-btn-'.
    dynamic_prefixes = set()
    for m in re.finditer(r'id="([^"]*)\$\{[^"]*"', h):
        prefix = m.group(1)
        if prefix and re.fullmatch(r'[\w-]+', prefix):
            dynamic_prefixes.add(prefix)

    refs = {}

    def add(ref, kind):
        refs.setdefault(ref, set()).add(kind)

    for m in re.finditer(r"getElementById\(\s*['\"`]([^'\"`${}]+)['\"`]\s*\)", h):
        add(m.group(1), 'getElementById')
    for m in re.finditer(r"querySelector(All)?\(\s*['\"`]#([\w-]+)['\"`]\s*\)", h):
        add(m.group(2), 'querySelector')
    for m in re.finditer(r'href="#([\w-]+)"', h):
        add(m.group(1), 'href')
    for m in re.finditer(r'<label[^>]*\bfor="([\w-]+)"', h):
        add(m.group(1), 'label-for')
    for m in re.finditer(r'aria-(?:controls|labelledby|describedby)="([\w-]+)"', h):
        add(m.group(1), 'aria')

    missing = {}
    for r, kinds in refs.items():
        if r in dom_ids:
            continue
        if any(r.startswith(p) for p in dynamic_prefixes):
            continue
        missing[r] = kinds
    if missing:
        print('FALLO: referencias a IDs que no existen en el DOM:')
        for r in sorted(missing):
            print(f'  - #{r}  <- {", ".join(sorted(missing[r]))}')
        return 1
    print(f'OK: {len(refs)} referencias a IDs, todas existen '
          f'({len(dom_ids)} IDs conocidos)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
