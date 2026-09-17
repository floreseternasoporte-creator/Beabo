import re

P = '/home/hatch/workspace/beabo/index.html'
H = open(P, encoding='utf-8').read()

def V(vid):
    m = re.search(r'<div id="' + vid + r'"[^>]*>', H)
    assert m, 'vista no encontrada: ' + vid
    s = m.start()
    m2 = re.search(r'<div id="[a-z-]+-view"', H[s + len(m.group(0)):])
    assert m2, 'fin no encontrado: ' + vid
    e = s + len(m.group(0)) + m2.start()
    return s, e, H[s:e]

def W(s, e, chunk):
    global H
    H = H[:s] + chunk + H[e:]

def rep(chunk, old, new, cnt=1):
    c = chunk.count(old)
    assert c == cnt, f'count {c} != {cnt} :: {old[:80]}'
    return chunk.replace(old, new)

# ================= Mi perfil: estilo plano Twitter/X =================
s, e, c = V('profile-view')

# 1. Fondo blanco (Twitter es blanco, no gris)
c = rep(c, '<div id="profile-view" class="fixed inset-0 overflow-y-auto z-40 hidden bg-[#f0f4f9] text-[#1c2b4a] scrollbar-hide">',
           '<div id="profile-view" class="fixed inset-0 overflow-y-auto z-40 hidden bg-white text-[#1c2b4a] scrollbar-hide">')

# 2. Avatar: anillo blanco + sin sombra
c = rep(c, 'class="w-24 h-24 rounded-full object-cover ring-4 ring-[#f0f4f9] bg-[#eef2f7] shadow-md"',
           'class="w-24 h-24 rounded-full object-cover ring-4 ring-white bg-[#eef2f7]"')

# 3. Botón editar foto: borde blanco + sin scale (mata taps en iOS) + sin sombra
c = rep(c, 'class="tap44 absolute bottom-0 right-0 w-8 h-8 rounded-full bg-[#0084FF] text-white border-[3px] border-[#f0f4f9] flex items-center justify-center active:scale-90 transition shadow"',
           'class="tap44 absolute bottom-0 right-0 w-8 h-8 rounded-full bg-[#0084FF] text-white border-[3px] border-white flex items-center justify-center active:opacity-80 transition"')

# 4. Botón "Editar perfil": sin scale + sin sombra
c = rep(c, 'class="flex-1 py-2.5 min-h-[44px] rounded-full bg-[#1c2b4a] text-white text-sm font-bold active:scale-[.98] transition shadow-sm"',
           'class="flex-1 py-2.5 min-h-[44px] rounded-full bg-[#1c2b4a] text-white text-sm font-bold active:opacity-80 transition"')

# 5. Botón compartir: sin scale + sin sombra
c = rep(c, 'class="w-11 h-11 shrink-0 rounded-full bg-white border border-[#dce1e5] text-[#1c2b4a] flex items-center justify-center active:scale-95 transition shadow-sm"',
           'class="w-11 h-11 shrink-0 rounded-full bg-white border border-[#dce1e5] text-[#1c2b4a] flex items-center justify-center active:opacity-80 transition"')

# 6. Nota de perfil: tarjeta gris -> plana
c = rep(c, '<div id="profile-note" class="mx-4 hidden mt-2 bg-[#f0f4f9] p-4 rounded-2xl border border-[#dce1e5] text-center">',
           '<div id="profile-note" class="mx-4 hidden mt-2 p-4 text-center border-y border-[#efefef]">')

# 7. Desktop: botón flotante de editar avatar sin scale
c = rep(c, 'active:scale-90 transition" title="Editar foto y perfil"',
           'active:opacity-80 transition" title="Editar foto y perfil"', 1)

# 8. Desktop: botón principal sin scale
c = rep(c, 'class="flex-1 bg-[#24324c] text-white py-2.5 min-h-[44px] rounded-full font-bold text-sm active:scale-[.98] transition',
           'class="flex-1 bg-[#24324c] text-white py-2.5 min-h-[44px] rounded-full font-bold text-sm active:opacity-80 transition')

# 9. Desktop: sidebar de estadísticas sin tarjeta
c = rep(c, '<div class="bg-white rounded-2xl p-6 shadow-sm border">',
           '<div class="bg-white py-2 border-y border-[#efefef]">')
c = rep(c, '<h3 class="font-bold text-gray-900 mb-4">Estadísticas</h3>',
           '<h3 class="font-bold text-[17px] text-[#1c2b4a] px-4 mb-2">Estadísticas</h3>')
c = rep(c, '<div class="space-y-4">',
           '<div>')
c = rep(c, '<div class="flex items-center justify-between">',
           '<div class="flex items-center justify-between px-4 py-3 border-t border-[#efefef]">', 4)
c = rep(c, '<button onclick="openHistorialView()" class="w-full mt-5 bg-[#eef2f7] text-[#5c6974] py-3 rounded-2xl font-semibold">Ver historial</button>',
           '<button onclick="openHistorialView()" class="w-full mt-2 text-[#1c2b4a] py-3 font-semibold text-[15px] active:bg-[#f5f5f5]">Ver historial</button>')

# 10b. Header móvil sticky: blanco translúcido (la vista ahora es blanca)
c = rep(c, '<div class="sticky top-0 bg-[#f0f4f9]/95 backdrop-blur',
           '<div class="sticky top-0 bg-white/95 backdrop-blur')

# 10c. Sombras restantes: botón editar avatar (desktop) y avatar del modal de autor
c = rep(c, 'border-2 border-[#24324c] shadow-md flex items-center justify-center',
           'border-2 border-[#24324c] flex items-center justify-center')
c = rep(c, 'class="w-20 h-20 rounded-full object-cover ring-4 ring-white bg-[#eef2f7] shadow-md"',
           'class="w-20 h-20 rounded-full object-cover ring-4 ring-white bg-[#eef2f7]"')

# 10. Cualquier active:scale restante en la vista -> opacity (seguridad iOS)
n_scale = c.count('active:scale')
assert n_scale == 0, f'quedan {n_scale} active:scale sin convertir: ' + str(re.findall(r'active:scale[^" ]*', c))

W(s, e, c)
print('Mi perfil OK')

open(P, 'w', encoding='utf-8').write(H)
print('ESCRITO:', P)
