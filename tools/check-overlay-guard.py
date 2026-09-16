#!/usr/bin/env python3
"""Chequeo del guard de la barra inferior de Drex.

Verifica que todo elemento `fixed inset-0` con z-index < 100 esté cubierto por
el guard (OVERLAY_IDS en index.html), que oculta #bottom-nav y #fab-create-btn
mientras un overlay está abierto. La barra tiene z-100: cualquier overlay por
debajo de eso queda visualmente roto si la barra sigue visible.

Falla si:
  - un fixed inset-0 con z < 100 no está en OVERLAY_IDS ni en EXEMPT, o
  - un ID de OVERLAY_IDS ya no existe en el DOM (typo o elemento eliminado).
"""
import re
import sys

HTML_PATH = 'index.html'

# Elementos fixed inset-0 con z < 100 que NO son overlays, con el motivo.
# (Las pantallas opacas conservan la barra por diseño, igual que chat-room-view.)
EXEMPT = {
    'chat-inbox-view': 'vista',
    'new-chat-view': 'vista',
    'create-group-chat-view': 'vista',
    'chat-room-view': 'vista',
    'chat-room-info-panel': 'pantalla opaca (se abre desde el chat)',
    'chat-bubbles-panel': 'pantalla opaca (se abre desde el chat)',
    'chat-group-info-panel': 'pantalla opaca (se abre desde el chat)',
    'saved-posts-view': 'vista',
    'practicar-view': 'vista',
    'practicar-detail-view': 'vista',
    'historial-view': 'vista',
    'creator-hub-view': 'vista',
    'fiesta-view': 'vista',
    'fiesta-room-view': 'vista',
    'note-creation-fullscreen': 'vista',
    'comments-view': 'vista',
    'search-view': 'vista',
    'profile-view': 'vista',
    'image-modal': 'usa body.drex-viewer-open (no el guard)',
    'signout-spinner': 'transitorio (cierre de sesión)',
}


def main():
    h = open(HTML_PATH, encoding='utf-8').read()

    m = re.search(r'const OVERLAY_IDS = \[(.*?)\];', h, re.S)
    if not m:
        print('FALLO: no se encontró OVERLAY_IDS en index.html')
        return 1
    guard = set(re.findall(r"'([\w-]+)'", m.group(1)))

    found = {}
    for tag_m in re.finditer(r'<(?:div|section|aside)[^>]*\bid="([\w-]+)"[^>]*>', h):
        tag, id_ = tag_m.group(0), tag_m.group(1)
        cls_m = re.search(r'class="([^"]*)"', tag)
        if not cls_m:
            continue
        classes = cls_m.group(1).split()
        if 'fixed' not in classes or 'inset-0' not in classes:
            continue
        z = None
        zm = re.search(r'z-\[(\d+)\]', cls_m.group(1))
        if zm:
            z = int(zm.group(1))
        else:
            zm = re.search(r'(?<![\w-])z-(\d+)(?![\w\]])', cls_m.group(1))
            if zm:
                z = int(zm.group(1))
        st_m = re.search(r'style="([^"]*)"', tag)
        if st_m:
            sz_m = re.search(r'z-index\s*:\s*(\d+)', st_m.group(1))
            if sz_m:
                z = int(sz_m.group(1))
        if z is None or z >= 100:
            continue
        found[id_] = z

    errors = []
    for id_, z in sorted(found.items(), key=lambda kv: kv[1]):
        if id_ in guard or id_ in EXEMPT:
            continue
        errors.append(f'z-{z} #{id_}: fixed inset-0 sin cobertura del guard '
                      f'(agrégalo a OVERLAY_IDS o a EXEMPT con motivo)')

    dom_ids = set(re.findall(r'id="([\w-]+)"', h))
    for id_ in sorted(guard):
        if id_ not in dom_ids:
            errors.append(f'#{id_}: está en OVERLAY_IDS pero no existe en el DOM')

    if errors:
        print('FALLO: cobertura del guard de la barra inferior')
        for e in errors:
            print('  -', e)
        return 1
    print(f'OK: {len(found)} fixed inset-0 con z<100 '
          f'({len(guard)} en guard, {len(EXEMPT)} exentos)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
