#!/usr/bin/env python3
"""Cobertura del CSS Tailwind purgado inline de Drex.

El bloque <style> con el CSS purgado (generado con tailwindcss@3.4.17) es
parte de index.html. Si alguien agrega una clase de Tailwind en el HTML o
en los JS externos sin regenerar el bloque, la UI se rompe EN SILENCIO
(la clase no tiene regla). Este check falla en ese caso.

Solo se revisan tokens usados COMO CLASES (atributos class="", classList,
className, setAttribute('class',...)): así los IDs, los strings de i18n,
los comentarios y el código JS no generan falsos positivos.

También falla ante construcción DINÁMICA de clases ('bg-' + x, `bg-${x}`),
que el purge estático jamás puede ver.

Uso: python3 tools/check-tailwind-coverage.py   (desde la raíz del repo)
"""

import re
import sys

HTML_PATH = 'index.html'
JS_FILES = [
    'drex-cloud.js', 'drex-sheet.js', 'drex-i18n.js', 'drex-rec-engine.js',
    'fiesta-games-data.js', 'recovery-codes.js', 'drex-data-export.js',
]
SHEET_CSS = 'drex-sheet.css'
TW_MARKER = 'Tailwind CSS 3.4.17 purgado para Drex'

# Familias de utilidades Tailwind v3 (primer segmento del core, sin
# variantes ni '!'). 'bg-red-500' -> 'bg'. Una familia futura que no esté
# aquí simplemente no se verifica (falso negativo, nunca falla de más).
UTILITY_PREFIXES = set('''
accent align animate antialiased appearance aspect backdrop bg basis
blur border bottom box break brightness caret clear col columns container
content contrast cursor decoration delay divide drop duration ease fill
filter flex float font from gap grayscale grid grow h hidden hue indent
inset invert isolate items justify leading left line list m max mb me min
ml mr ms mt mx my object opacity order origin overflow overscroll p pb pe
pl place placeholder pointer pr ps pt px py right ring rotate rounded row
saturate scale scroll select self sepia shadow shrink size skew snap space
sr start stroke table text to top touch tracking transform transition
translate truncate underline via visible w whitespace will z
'''.split())

# Utilidades de una sola palabra (sin -, [, /, :) de Tailwind v3.
SINGLE_WORD_UTILITIES = set('''
container visible invisible collapse static fixed absolute relative sticky
isolate block inline inline-block inline-flex inline-table inline-grid
flow-root flex grid table table-cell table-row list-item hidden contents
flex-1 flex-auto flex-initial flex-none grow shrink
truncate antialiased subpixel-antialiased
uppercase lowercase capitalize normal-case italic not-italic
underline overline line-through no-underline
border rounded shadow outline ring blur filter grayscale
transform resize truncate transition
group peer not-sr-only
'''.split())

# Variantes conocidas de Tailwind v3 (para no confundir 'align-items:x'
# con una variante 'align-items:').
KNOWN_VARIANTS = set('''
sm md lg xl 2xl
max-sm max-md max-lg max-xl max-2xl
hover focus focus-within focus-visible active visited target disabled
first last odd even
group-hover group-focus group-active
peer-hover peer-focus peer-checked peer-disabled peer-first peer-last
peer-odd peer-even peer-visited peer-active
open checked selected
motion-safe motion-reduce contrast-more contrast-less
dark portrait landscape ltr rtl
'''.split())

FA_RE = re.compile(r'^fa[srlbd]?$|^fa-')
CODE_CHARS_RE = re.compile(r'[;{}|\\^$<>=~`]')
TOKEN_RE = re.compile(r'!?-?[A-Za-z0-9_@\[][^\s"\'`{};]*')
# En un selector: .foo, .\!bar, .md\:baz, escapes hex tipo \2c<espacio>.
CLASS_IN_SELECTOR_RE = re.compile(
    r'\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[^.:\s>+~#\[])+)')


def css_unescape(s):
    r"""Desescapa un nombre de clase de un selector CSS (.\!hidden -> !hidden)."""
    s = re.sub(r'\\([0-9a-fA-F]{1,6})\s?', lambda m: chr(int(m.group(1), 16)), s)
    s = re.sub(r'\\(.)', r'\1', s, flags=re.S)
    return s


def classes_in_block(block):
    """Nombres de clase (desescapados) con regla en el bloque CSS."""
    out = set()
    for sel_group in re.findall(r'([^{}]+)\{', block):
        sel_group = sel_group.strip()
        if sel_group.startswith('@'):
            continue
        for sel in sel_group.split(','):
            for m in CLASS_IN_SELECTOR_RE.finditer(sel):
                out.add(css_unescape(m.group(1)))
    return out


def split_tw_block(html):
    """Separa el bloque <style> del Tailwind purgado del resto del HTML."""
    m = re.search(
        r'<style>\n/\* ' + re.escape(TW_MARKER) + r'[\s\S]*?\n</style>\n?', html)
    if not m:
        print('FALLO: no se encontró el bloque <style> del Tailwind purgado '
              f'(marcador "{TW_MARKER}").', file=sys.stderr)
        sys.exit(2)
    return m.group(0), html[:m.start()] + html[m.end():]


def strip_comments(text, is_js=False):
    text = re.sub(r'<!--[\s\S]*?-->', '', text)
    if is_js:
        text = re.sub(r'/\*[\s\S]*?\*/', '', text)
        text = re.sub(r'(?<!:)//[^\n]*', '', text)
    return text


def extract_tokens(text):
    toks = set()
    for m in TOKEN_RE.finditer(text):
        t = m.group(0).rstrip(',;')
        if t:
            toks.add(t)
    return toks


def class_context_strings(text):
    """Fragmentos de texto donde viven clases: class="", classList, className.

    Solo el CONTENIDO de clase, nunca el resto del template literal (donde
    viven id="...", onclick=..., querySelector('.a.b'), style.cssText, etc.).
    """
    out = []
    # 1. atributos class="..." / class='...' (incluye ternarios ${} dentro)
    for m in re.finditer(r'class\s*=\s*(["\'])([\s\S]*?)\1', text):
        out.append(m.group(2))
    # 2. dentro de template literals: strings dentro de ${...} (ternarios)
    for tm in re.finditer(r'`(?:[^`\\]|\\.)*`', text):
        lit = tm.group(0)
        if '${' not in lit:
            continue
        for em in re.finditer(r'\$\{([^{}]*)\}', lit):
            for sm in re.finditer(r"""(['"])((?:\\.|(?!\1).)*)\1""", em.group(1)):
                out.append(sm.group(2))
    # 3. classList.add/remove/toggle/replace('a', 'b') — respeta ) dentro de comillas
    q = r"(?:[^()'\"`]|\'[^\']*\'|\"[^\"]*\")"
    for m in re.finditer(
            r'classList\s*\.\s*(?:add|remove|toggle|replace)\s*\(((' + q + r')*)\)',
            text):
        out.append(m.group(1))
    # 4. .className = '...' / .className += "..."
    for m in re.finditer(r'\.className\s*(?:\+)?=\s*(["\'])([\s\S]*?)\1', text):
        out.append(m.group(2))
    # 5. setAttribute('class', ...) — respeta ) dentro de comillas
    for m in re.finditer(
            r'setAttribute\(\s*["\']class["\']\s*,((' + q + r')*)\)', text):
        out.append(m.group(1))
    return out


def strip_variants(s):
    """Quita prefijos de variante conocidos: 'md:hover:bg-red-500' -> 'bg-red-500'."""
    while True:
        m = re.match(r'^([A-Za-z0-9_@\[\].-]+):', s)
        if not m or m.group(1) not in KNOWN_VARIANTS:
            return s
        s = s[m.end():]
        if not s:
            return ''


def is_tailwind_utility(tok):
    """¿El token tiene forma de utilidad Tailwind COMPLETA (familia conocida)?

    'bg-red-500' sí; 'bg' solo (prefijo sin valor), 'account-config-view'
    (familia desconocida), 'align-items:center' (declaración CSS) o
    'bg-[var(--x)]/95' (Tailwind no lo genera: opacidad sobre var()) no.
    """
    s = tok[1:] if tok.startswith('!') else tok  # important (!hidden)
    if not s:
        return False
    s = strip_variants(s)
    if not s or ':' in s:  # ':' restante = declaración CSS, no utilidad
        return False
    if s in SINGLE_WORD_UTILITIES:
        return True
    if CODE_CHARS_RE.search(s):
        return False
    bare = re.sub(r'\[[^\]]*\]', '', s)  # fuera secciones [...]
    if re.search(r'(?<!\d)\.(?!\d)', bare):
        return False  # '.' no numérico: selector JS ('.a.b'), no clase
    if re.search(r'[A-Z]', bare):
        return False  # mayúsculas fuera de [...] ('pt-BR'): Tailwind es minúsculas
    m = re.match(r'^(-?[a-z]+)([-/\[]|$)', s)
    if not m:
        return False
    prefix, sep = m.group(1).lstrip('-'), m.group(2)
    if prefix not in UTILITY_PREFIXES:
        return False
    if not sep or sep == '[':
        # prefijo solo ('bg') o 'p[0]' (acceso a array JS): no es utilidad
        return False
    if '/' in bare:  # modificador de opacidad: /50, /[.16]
        mm = re.search(r'/(\[[^\]]*\]|[^\[/\]]*)$', s)
        if not mm or not re.fullmatch(r'\d+|\[.*\]', mm.group(1)):
            return False
        if 'var(' in s:
            return False  # Tailwind no aplica opacidad sobre var(): no lo genera
    return True


# Clases muertas conocidas: Tailwind v3.4 NO las genera porque no existen en
# su escala, así que no tienen regla ni con el Play CDN ni con el bloque
# purgado (no hacen nada hoy). Se documentan aquí en vez de bloquear el check.
KNOWN_DEAD = {
    'w-4.5',  # v3 no tiene 4.5 en la escala de spacing (v4 sí)
    'h-4.5',
}


def needs_tw_rule(tok, tw_covered, custom_covered):
    if tok in tw_covered:
        return False
    if tok in custom_covered:
        return False
    if tok in KNOWN_DEAD:
        return False
    if FA_RE.match(tok):
        return False
    return is_tailwind_utility(tok)


def find_dynamic_constructions(sources):
    """Construcción dinámica de clases Tailwind: invisible al purge estático.

    Casos:  'bg-' + x      `bg-${x}`
    Solo se marcan prefijos de familias Tailwind reales ('users/' + uid es
    una ruta de Firebase, no una clase).
    """
    hits = []
    pat_concat = re.compile(r'''(['"])([A-Za-z][A-Za-z0-9_.:-]*[-:/\[])\1\s*\+''')
    pat_tpl = re.compile(r'`([A-Za-z][A-Za-z0-9_.:-]*[-:/\[])\$\{')

    def stem(frag):
        s = frag.rstrip('-:/[').split(':')[-1]
        return s.split('-')[0].split('_')[0]

    for name, text in sources:
        for m in pat_concat.finditer(text):
            if stem(m.group(2)) in UTILITY_PREFIXES:
                hits.append((name, m.group(0)[:44]))
        for m in pat_tpl.finditer(text):
            if stem(m.group(1)) in UTILITY_PREFIXES:
                hits.append((name, m.group(0)[:44] + '...}'))
    return hits


def main():
    try:
        html = open(HTML_PATH, encoding='utf-8').read()
    except FileNotFoundError:
        print(f'FALLO: no existe {HTML_PATH} (corre desde la raíz del repo).',
              file=sys.stderr)
        sys.exit(2)

    tw_block, html_sin_tw = split_tw_block(html)
    tw_covered = classes_in_block(tw_block)

    # Clases custom de la app (otros <style> + drex-sheet.css): no son Tailwind.
    custom_covered = set()
    for block in re.findall(r'<style[^>]*>([\s\S]*?)</style>', html_sin_tw):
        custom_covered |= classes_in_block(block)
    try:
        custom_covered |= classes_in_block(open(SHEET_CSS, encoding='utf-8').read())
    except FileNotFoundError:
        pass

    # Los <style> y comentarios son CSS/prosa, no listas de clases.
    html_limpio = re.sub(r'<style[^>]*>[\s\S]*?</style>', '', html_sin_tw)
    html_limpio = strip_comments(html_limpio)

    sources = [(HTML_PATH, html_limpio)]
    for js in JS_FILES:
        try:
            sources.append((js, strip_comments(
                open(js, encoding='utf-8').read(), is_js=True)))
        except FileNotFoundError:
            print(f'AVISO: no existe {js}, se omite.', file=sys.stderr)

    tokens = set()
    for _, text in sources:
        for s in class_context_strings(text):
            tokens |= extract_tokens(s)

    missing = sorted(t for t in tokens if needs_tw_rule(t, tw_covered, custom_covered))
    dynamic = find_dynamic_constructions(sources)

    ok = True
    if missing:
        ok = False
        print(f'FALLO: {len(missing)} clase(s) de Tailwind sin regla en el '
              'bloque purgado (regenera el CSS o quita la clase):')
        for t in missing[:40]:
            print(f'  - {t}')
        if len(missing) > 40:
            print(f'  ... y {len(missing) - 40} más')
    if dynamic:
        ok = False
        print(f'FALLO: {len(dynamic)} construcción(es) DINÁMICA(S) de clases '
              'Tailwind (el purge estático no las ve; usa clases completas):')
        for name, frag in dynamic[:20]:
            print(f'  - {name}: {frag}')
    if ok:
        print(f'OK: {len(tw_covered)} clases en el bloque purgado; '
              f'{len(tokens)} tokens de clase revisados, 0 sin regla, 0 dinámicos.')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
