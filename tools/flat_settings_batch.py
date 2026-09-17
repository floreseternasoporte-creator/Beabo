import re, sys

P = '/home/hatch/workspace/beabo/index.html'
H = open(P, encoding='utf-8').read()

def V(vid):
    m = re.search(r'<div id="' + vid + r'"[^>]*>', H)
    assert m, 'vista no encontrada: ' + vid
    s = m.start()
    m2 = re.search(r'<div id="[a-z-]+-view"', H[s + len(m.group(0)):])
    e = s + len(m.group(0)) + m2.start()
    return s, e, H[s:e]

def W(s, e, chunk):
    global H
    H = H[:s] + chunk + H[e:]

def rep(chunk, old, new, cnt=1):
    c = chunk.count(old)
    assert c == cnt, f'count {c} != {cnt} :: {old[:80]}'
    return chunk.replace(old, new)

def reprep(chunk, pat, new, cnt=1):
    c = len(re.findall(pat, chunk))
    assert c == cnt, f'regex count {c} != {cnt} :: {pat[:80]}'
    return re.sub(pat, new, chunk)

HAIR = '<div class="ml-[60px] h-px bg-[#efefef]"></div>'
HAIRF = '<div class="h-px bg-[#efefef]"></div>'

def flat_container(chunk, vid):
    return rep(chunk, f'<div id="{vid}" class="fixed inset-0 bg-[#f0f4f9]',
                     f'<div id="{vid}" class="fixed inset-0 bg-white')

def flat_scroller(chunk, old):
    return rep(chunk, old, 'flex-1 overflow-y-auto bg-white pb-8')

def ig_headers(chunk, old, first_pt='pt-6'):
    parts = chunk.split(old)
    assert len(parts) > 1
    out = parts[0]
    for i, p in enumerate(parts[1:], start=1):
        pt = first_pt if i == 1 else 'pt-8'
        out += f'<p class="px-4 {pt} pb-1.5 text-[17px] font-semibold text-[#1c2b4a]">' + p
    return out

# ================= 1. security-center-view =================
s, e, c = V('security-center-view')
c = flat_container(c, 'security-center-view')
c = flat_scroller(c, 'flex-1 overflow-y-auto px-4 py-5 space-y-10')
c = rep(c, '<section class="rounded-3xl bg-[#0084FF] p-5 text-white shadow-lg shadow-[#0084FF]/15">',
           '<section class="bg-[#0084FF] px-5 py-6 text-white">')
c = ig_headers(c, '<p class="px-2 pb-1.5 text-[11px] font-bold text-[#6b7280] uppercase tracking-wider">')
c = rep(c, '<section class="bg-white rounded-2xl border border-[#dce1e5] overflow-hidden divide-y divide-[#eef2f7]">',
           '<section class="bg-white">', 3)
c = rep(c, '<section class="bg-white rounded-2xl border border-[#dce1e5] overflow-hidden">',
           '<section class="bg-white">')
c = rep(c, 'class="w-full p-4 flex items-center gap-3 text-left active:bg-[#f8fafc]"',
           'class="w-full px-4 py-3 flex items-center gap-4 text-left active:bg-[#f5f5f5]"', 4)
c = rep(c, 'class="w-full p-4 flex items-center gap-3 text-left active:bg-red-50"',
           'class="w-full px-4 py-3 flex items-center gap-4 text-left active:bg-[#fef2f2]"')
c = rep(c, '<span class="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style="background:#eef6ff">', '', 5)
c = rep(c, '<span class="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style="background:#fef2f2">', '')
c = rep(c, '<svg class="w-5 h-5" fill="none" stroke="#0084FF" viewBox="0 0 24 24" stroke-width="2">',
           '<svg class="w-7 h-7 shrink-0 text-[#1c2b4a]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">', 5)
c = rep(c, '<svg class="w-5 h-5" fill="none" stroke="#b91c1c" viewBox="0 0 24 24" stroke-width="2">',
           '<svg class="w-7 h-7 shrink-0 text-[#b91c1c]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">')
c = reprep(c, r'</svg>\s*</span>', '</svg>', 6)
c = rep(c, '<span class="block text-sm font-bold text-[#1c2b4a]">',
           '<span class="block text-[16px] text-[#1c2b4a]">', 4)
c = rep(c, '<span class="block text-sm font-bold text-[#b91c1c]">',
           '<span class="block text-[16px] font-medium text-[#dc2626]">')
c = reprep(c, r'<span( id="[^"]*")? class="block text-xs text-\[#6b7280\] mt-0\.5">',
           r'<span\1 class="block text-[13px] text-[#7b8794] mt-0.5 leading-snug">', 5)
c = rep(c, '<svg class="w-5 h-5 text-[#b6c0d1] shrink-0"', '<svg class="w-5 h-5 text-[#c3ccd8] shrink-0"', 3)
c = rep(c, '<div class="p-4 flex items-center gap-3">', '<div class="px-4 py-3 flex items-center gap-4">')
c = rep(c, '<p class="text-sm font-bold text-[#1c2b4a]">Avisar sobre cambios importantes</p>',
           '<p class="text-[16px] text-[#1c2b4a]">Avisar sobre cambios importantes</p>')
c = rep(c, '<p class="text-xs text-[#6b7280] mt-0.5">Incluye cambios de acceso y privacidad.</p>',
           '<p class="text-[13px] text-[#7b8794] mt-0.5">Incluye cambios de acceso y privacidad.</p>')
c = rep(c, '<div class="p-4 flex items-center justify-between gap-3 border-b border-[#eef2f7]">',
           '<div class="px-4 py-3 flex items-center justify-between gap-4">')
c = rep(c, '<p class="text-sm font-bold text-[#1c2b4a]">Sesiones activas</p>',
           '<p class="text-[16px] text-[#1c2b4a]">Sesiones activas</p>')
c = reprep(c, r'</button>(\s*)<button', '</button>\n' + HAIR + r'\1<button', 3)
c = rep(c, '</button>\n          </div>\n          <div class="px-4 py-3 flex items-center justify-between gap-4">',
           '</button>\n          </div>\n' + HAIRF + '\n          <div class="px-4 py-3 flex items-center justify-between gap-4">')
W(s, e, c)
print('1. security-center-view OK')

# ================= 2. privacy-config-view =================
s, e, c = V('privacy-config-view')
c = flat_container(c, 'privacy-config-view')
c = flat_scroller(c, 'flex-1 overflow-y-auto px-4 py-5 space-y-5')
c = rep(c, '<div class="w-full bg-white p-4 rounded-2xl flex items-center justify-between border border-[#dce1e5] shadow-sm">',
           '<div class="w-full px-4 py-3 flex items-center justify-between gap-4">')
c = rep(c, '<button id="follow-requests-nav-entry" onclick="openFollowRequestsView()" class="hidden w-full bg-white p-4 rounded-2xl flex items-center justify-between border border-[#dce1e5] shadow-sm active:scale-95 transition-all">',
           '<button id="follow-requests-nav-entry" onclick="openFollowRequestsView()" class="hidden w-full px-4 py-3 flex items-center justify-between gap-4 text-left active:bg-[#f5f5f5]">')
c = rep(c, '<button onclick="openBlockedAccountsView()" class="w-full bg-white p-4 rounded-2xl flex items-center justify-between border border-[#dce1e5] shadow-sm active:scale-95 transition-all">',
           '<button onclick="openBlockedAccountsView()" class="w-full px-4 py-3 flex items-center justify-between gap-4 text-left active:bg-[#f5f5f5]">')
c = rep(c, '<div class="flex items-center gap-3">', '<div class="flex items-center gap-4 min-w-0">', 3)
c = rep(c, '<div class="w-10 h-10 bg-[#eef2f7] rounded-xl flex items-center justify-center text-[#5c6974]">', '', 3)
c = rep(c, '<svg class="w-6 h-6"', '<svg class="w-7 h-7 shrink-0 text-[#1c2b4a]"', 3)
c = reprep(c, r'</svg>\s*</div>', '</svg>', 3)
c = rep(c, '<p class="font-bold text-[#1c2b4a]">', '<p class="text-[16px] text-[#1c2b4a]">', 3)
c = rep(c, '<p class="text-sm text-[#6b7280]">', '<p class="text-[13px] text-[#7b8794] mt-0.5 leading-snug">', 2)
c = rep(c, '<p class="text-sm text-[#6b7280]" id="follow-requests-count-label">', '<p class="text-[13px] text-[#7b8794] mt-0.5 leading-snug" id="follow-requests-count-label">')
c = rep(c, 'text-[#b6c0d1]', 'text-[#c3ccd8]', 2)
# estructura: grupo plano con hairlines; banner gris después
c = rep(c, '<div class="w-full px-4 py-3 flex items-center justify-between gap-4">',
           '<div class="bg-white">\n      <div class="w-full px-4 py-3 flex items-center justify-between gap-4">')
c = rep(c, '</label>\n      </div>\n      <button id="follow-requests-nav-entry"',
           '</label>\n      </div>\n      <div class="follow-req-hairline ml-[60px] h-px bg-[#efefef] hidden"></div>\n      <button id="follow-requests-nav-entry"')
c = rep(c, '<p class="text-sm text-[#6b7280] bg-[#dce1e5]/30 p-4 rounded-xl border border-[#dce1e5]">',
           '<p class="BANNERPH">')
# mover banner tras el grupo: capturar junction botón-oculto -> banner -> bloqueados
m = re.search(r'(<button id="follow-requests-nav-entry".*?</button>)\s*<p class="BANNERPH">(.*?)</p>\s*(<button onclick="openBlockedAccountsView\(\).*?</button>)', c, re.S)
assert m, 'junction banner privacy'
new_group = (m.group(1)
    + '\n      <div class="follow-req-hairline ml-[60px] h-px bg-[#efefef] hidden"></div>\n      '
    + m.group(3) + '\n      </div>'
    + '\n      <p class="mx-4 mt-5 bg-[#f0f2f5] rounded-xl p-4 text-[13px] text-[#6b7280] leading-relaxed">' + m.group(2) + '</p>')
c = c[:m.start()] + new_group + c[m.end():]
# el hairline sigue la visibilidad del botón de solicitudes
H = rep(H, "navEntry.classList.toggle('hidden', !snap.val());",
           "navEntry.classList.toggle('hidden', !snap.val());\n      document.querySelectorAll('.follow-req-hairline').forEach(el => el.classList.toggle('hidden', !snap.val()));")
W(s, e, c)
print('2. privacy-config-view OK')

# ================= 3. notification-settings-view =================
s, e, c = V('notification-settings-view')
c = flat_container(c, 'notification-settings-view')
c = flat_scroller(c, 'flex-1 overflow-y-auto px-4 py-5 space-y-10')
c = reprep(c, r'<div class="bg-white border border-\[#dce1e5\] rounded-3xl p-4 shadow-sm">\s*<p class="text-sm text-\[#606d77\] leading-relaxed">(.*?)</p>\s*</div>',
           r'<p class="px-4 pt-4 text-[14px] text-[#606d77] leading-relaxed">\1</p>')
c = rep(c, '<div class="space-y-1">', '<div>', 3)
c = ig_headers(c, '<p class="text-[11px] font-bold text-[#6b7280] uppercase tracking-wider px-2 pb-1">')
c = rep(c, '<div class="bg-white border border-[#dce1e5] rounded-3xl overflow-hidden shadow-sm divide-y divide-[#eef2f7]">',
           '<div class="bg-white">', 3)
c = rep(c, '<div class="flex items-center justify-between p-4">',
           '<div class="px-4 py-3 flex items-center justify-between gap-4">', 7)
c = rep(c, '<div class="flex items-center gap-3">', '<div class="flex-1 min-w-0">', 7)
c = rep(c, '<p class="font-semibold text-[#1c2b4a]">', '<p class="text-[16px] text-[#1c2b4a]">', 7)
c = rep(c, '<p class="text-xs text-[#6b7280]">', '<p class="text-[13px] text-[#7b8794] mt-0.5">', 7)
c = reprep(c, r'</button>\s*</div>\s*<div class="px-4 py-3 flex items-center justify-between gap-4">',
           '</button>\n          </div>\n' + HAIRF + '\n          <div class="px-4 py-3 flex items-center justify-between gap-4">', 4)
W(s, e, c)
print('3. notification-settings-view OK')

# ================= 4. theme-config-view =================
s, e, c = V('theme-config-view')
c = flat_container(c, 'theme-config-view')
c = flat_scroller(c, 'flex-1 overflow-y-auto px-4 py-5 space-y-5')
c = reprep(c, r'<div class="bg-white border border-\[#dce1e5\] rounded-3xl p-5 shadow-sm">\s*<p class="text-sm text-\[#606d77\] leading-relaxed">(.*?)</p>\s*</div>',
           r'<p class="px-4 pt-4 text-[14px] text-[#606d77] leading-relaxed">\1</p>')
c = rep(c, 'class="theme-option-btn w-full bg-white border border-[#dce1e5] rounded-3xl p-5 text-left shadow-sm transition-all"',
           'class="theme-option-btn w-full px-4 py-3 flex items-center justify-between gap-4 text-left active:bg-[#f5f5f5]"', 2)
c = rep(c, '<div class="flex items-start justify-between gap-4">',
           '<div class="flex items-center justify-between gap-4 w-full">', 2)
c = rep(c, '<p class="font-bold text-[#1c2b4a] text-lg">', '<p class="text-[16px] text-[#1c2b4a]">', 2)
c = rep(c, '<p class="text-sm text-[#6b7280] mt-1">', '<p class="text-[13px] text-[#7b8794] mt-0.5">', 2)
c = rep(c, '<span class="theme-option-check text-[#1c2b4a] text-xl font-bold">',
           '<span class="theme-option-check text-[#0084FF] text-xl font-bold">', 2)
c = reprep(c, r'</button>(\s*)<button type="button" data-theme-option',
           '</button>\n' + HAIRF + r'\1<button type="button" data-theme-option')
# envolver opciones en grupo plano
c = rep(c, '<button type="button" data-theme-option="light"',
           '<div class="bg-white mt-2">\n      <button type="button" data-theme-option="light"')
c = reprep(c, r'(<button type="button" data-theme-option="dark"[\s\S]*?</button>)',
           r'\1\n      </div>')
W(s, e, c)
# CSS: selección por check, sin bordes ni fondos de tarjeta
H = rep(H, '.theme-option-btn {\n  border-color: var(--theme-border) !important;\n  background: var(--theme-surface) !important;\n}',
           '.theme-option-btn {}')
H = rep(H, '.theme-option-btn .theme-option-check {\n  opacity: 0;\n  transform: scale(0.8);\n  transition: all 0.2s ease;\n  color: var(--brand-accent);\n}',
           '.theme-option-btn .theme-option-check {\n  opacity: 0;\n  transform: scale(0.8);\n  transition: all 0.2s ease;\n  color: #0084FF;\n}')
H = rep(H, '.theme-option-btn.selected {\n  border-color: var(--brand-accent) !important;\n  background: var(--brand-accent-soft) !important;\n  box-shadow: 0 0 0 2px rgba(92,105,116, 0.12);\n}',
           '.theme-option-btn.selected {}')
H = rep(H, 'body.theme-dark .theme-option-btn.selected {\n  box-shadow: 0 0 0 2px rgba(143, 162, 199, 0.18);\n}',
           '')
print('4. theme-config-view OK')

# ================= 5. cache-config-view =================
s, e, c = V('cache-config-view')
c = flat_container(c, 'cache-config-view')
c = flat_scroller(c, 'flex-1 overflow-y-auto px-4 py-5 space-y-5')
c = rep(c, '<div class="bg-white rounded-3xl p-5 shadow-sm">', '<div class="px-4 pt-4">')
c = rep(c, '<p class="text-[15px] font-bold text-[#1c2b4a]">Almacenamiento temporal</p>',
           '<p class="text-[16px] text-[#1c2b4a]">Almacenamiento temporal</p>')
c = rep(c, '<div class="bg-white rounded-3xl shadow-sm overflow-hidden">', '<div class="bg-white">')
c = rep(c, '<p class="px-5 pt-4 pb-2 text-[13px] font-bold text-[#1c2b4a]">Desglose por categoría</p>',
           '<p class="px-4 pt-8 pb-1.5 text-[17px] font-semibold text-[#1c2b4a]">Desglose por categoría</p>')
c = rep(c, '<button id="clear-cache-btn" onclick="clearRealtimeCache()" class="w-full bg-[#e11d48] text-white py-4 rounded-2xl font-bold active:scale-95 transition-all shadow-sm">',
           '<button id="clear-cache-btn" onclick="clearRealtimeCache()" class="w-full px-4 py-3 mt-8 text-left text-[16px] font-medium text-[#dc2626] active:bg-[#fef2f2]">')
c = reprep(c, r'<div class="bg-white rounded-3xl p-4 text-xs text-\[#6b7280\] shadow-sm leading-relaxed">\s*(.*?)\s*</div>',
           r'<p class="px-4 pt-6 text-[13px] text-[#7b8794] leading-relaxed">\1</p>')
W(s, e, c)
print('5. cache-config-view OK')

# ================= 6. account-config-view =================
s, e, c = V('account-config-view')
c = flat_container(c, 'account-config-view')
c = flat_scroller(c, 'flex-1 overflow-y-auto px-4 py-5 space-y-5')
c = rep(c, '<p class="text-sm text-[#6b7280] bg-[#dce1e5]/30 p-4 rounded-xl border border-[#dce1e5]">',
           '<p class="mx-4 mt-4 bg-[#f0f2f5] rounded-xl p-4 text-sm text-[#6b7280] leading-relaxed">')
c = rep(c, 'class="w-full bg-white p-4 rounded-2xl flex items-center justify-between border border-[#dce1e5] shadow-sm active:scale-95 transition-all"',
           'class="w-full px-4 py-3 flex items-center justify-between gap-4 text-left active:bg-[#f5f5f5]"', 8)
c = rep(c, '<div class="flex items-center gap-3 min-w-0">', '<div class="flex items-center gap-4 min-w-0">', 6)
c = rep(c, '<div class="flex items-center gap-3">', '<div class="flex items-center gap-4 min-w-0">', 2)
c = rep(c, '<div class="w-10 h-10 bg-[#eef2f7] rounded-xl flex items-center justify-center text-[#5c6974] shrink-0">', '', 6)
c = rep(c, '<div class="w-10 h-10 bg-[#eef2f7] rounded-xl flex items-center justify-center text-[#5c6974]">', '')
c = rep(c, '<div class="w-10 h-10 bg-[#fff3f1] rounded-xl flex items-center justify-center text-[#b91c1c]">', '')
# los svg de chips: 8 en total (7 normales + 1 rojo)
c = rep(c, '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">',
           '<svg class="w-7 h-7 shrink-0 text-[#1c2b4a]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">', 8)
c = reprep(c, r'</svg>\s*</div>', '</svg>', 8)
c = rep(c, '<p class="font-bold text-[#1c2b4a]">', '<p class="text-[16px] text-[#1c2b4a]">', 7)
c = rep(c, '<span class="font-bold text-[#b91c1c]">', '<span class="text-[16px] font-medium text-[#dc2626]">')
c = rep(c, '<p class="text-sm text-[#6b7280]">', '<p class="text-[13px] text-[#7b8794] mt-0.5">')
c = rep(c, 'text-[#b6c0d1]', 'text-[#c3ccd8]', 8)
# el svg rojo: el de desactivar (icono papelera)
c = rep(c, '<svg class="w-7 h-7 shrink-0 text-[#1c2b4a]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2',
           '<svg class="w-7 h-7 shrink-0 text-[#b91c1c]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2')
# estructura: grupo 7 botones + botón peligro aparte
c = rep(c, '<button onclick="openEmailConfigView()"',
           '<div class="bg-white mt-2">\n      <button onclick="openEmailConfigView()"')
c = reprep(c, r'</button>(\s*)<button', '</button>\n' + HAIR + r'\1<button', 6)
c = rep(c, '<div class="h-px bg-[#dce1e5] my-4"></div>', '')
c = rep(c, '<button onclick="openDeactivateDeleteAccountView()"',
           '</div>\n      <div class="bg-white mt-6">\n      <button onclick="openDeactivateDeleteAccountView()"')
c = reprep(c, r'</button>\n    </div>\n  </div>\s*$', '</button>\n      </div>\n    </div>\n  </div>')
W(s, e, c)
print('6. account-config-view OK')

# ================= 7. profile-config-view =================
s, e, c = V('profile-config-view')
c = flat_container(c, 'profile-config-view')
c = flat_scroller(c, 'flex-1 overflow-y-auto p-6 space-y-6')
c = rep(c, '<p class="text-sm text-[#6b7280] bg-[#dce1e5]/30 p-4 rounded-xl border border-[#dce1e5]">',
           '<p class="mx-4 mt-4 bg-[#f0f2f5] rounded-xl p-4 text-sm text-[#6b7280] leading-relaxed">')
c = rep(c, 'class="w-full bg-white p-4 rounded-2xl flex items-center justify-between border border-[#dce1e5] shadow-sm active:scale-95 transition-all"',
           'class="w-full px-4 py-3 flex items-center justify-between gap-4 text-left active:bg-[#f5f5f5]"', 6)
c = rep(c, '<div class="w-10 h-10 bg-[#eef2f7] rounded-xl flex items-center justify-center text-[#5c6974]">', '', 6)
c = rep(c, '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">',
           '<svg class="w-7 h-7 shrink-0 text-[#1c2b4a]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">', 6)
c = reprep(c, r'</svg>\s*</div>', '</svg>', 6)
c = rep(c, '<div class="flex items-center gap-3">', '<div class="flex items-center gap-4 min-w-0">', 6)
c = rep(c, '<span class="font-bold text-[#1c2b4a]">', '<span class="text-[16px] text-[#1c2b4a]">', 6)
c = rep(c, 'text-[#b6c0d1]', 'text-[#c3ccd8]', 6)
c = rep(c, '<button onclick="openUpdatePhotoView()"',
           '<div class="bg-white mt-2">\n      <button onclick="openUpdatePhotoView()"')
c = reprep(c, r'</button>(\s*)<button', '</button>\n' + HAIR + r'\1<button', 5)
c = reprep(c, r'</button>\n    </div>\n  </div>', '</button>\n      </div>\n    </div>\n  </div>')
W(s, e, c)
print('7. profile-config-view OK')

# ================= 8. chat-privacy-settings-view =================
s, e, c = V('chat-privacy-settings-view')
c = flat_container(c, 'chat-privacy-settings-view')
c = flat_scroller(c, 'flex-1 overflow-y-auto px-4 py-5 space-y-10')
c = rep(c, '<section class="bg-white rounded-2xl border border-[#dce1e5] overflow-hidden">',
           '<section class="bg-white">')
c = rep(c, '<div class="p-4 border-b border-[#eef2f7]"><p class="font-bold text-[#1c2b4a]">Control del chat</p><p class="text-xs text-[#6b7280] mt-1">Reduce los datos que se conservan y compartes.</p></div>',
           '<div class="px-4 pt-4 pb-2"><p class="text-[17px] font-semibold text-[#1c2b4a]">Control del chat</p><p class="text-[13px] text-[#7b8794] mt-0.5">Reduce los datos que se conservan y compartes.</p></div>')
c = rep(c, '<div class="p-4 flex items-center justify-between gap-4">',
           '<div class="px-4 py-3 flex items-center justify-between gap-4">')
c = rep(c, '<div class="p-4 flex items-center justify-between gap-4 border-t border-[#eef2f7]">',
           '<div class="px-4 py-3 flex items-center justify-between gap-4">')
c = rep(c, '<p class="text-sm font-bold text-[#1c2b4a]">', '<p class="text-[16px] text-[#1c2b4a]">', 2)
c = rep(c, '<p class="text-xs text-[#6b7280] mt-1">', '<p class="text-[13px] text-[#7b8794] mt-0.5">', 2)
c = reprep(c, r'</button></div>\s*<div class="px-4 py-3 flex items-center justify-between gap-4">',
           '</button></div>\n        ' + HAIRF + '\n        <div class="px-4 py-3 flex items-center justify-between gap-4">', 1)
c = rep(c, '<section class="bg-white rounded-2xl border border-[#dce1e5] p-4"><p class="font-bold text-[#1c2b4a]">Datos locales del chat</p><p class="text-xs text-[#6b7280] mt-1 mb-4">Elimina borradores y silencios almacenados en este dispositivo. No borra los mensajes de la conversación.</p><button onclick="clearPrivateChatData()" class="w-full min-h-11 rounded-xl border border-red-200 bg-red-50 text-red-600 text-sm font-bold active:scale-[.98]">Limpiar datos locales de chat</button></section>',
           '<section class="bg-white mt-6"><div class="px-4 pt-4 pb-2"><p class="text-[17px] font-semibold text-[#1c2b4a]">Datos locales del chat</p><p class="text-[13px] text-[#7b8794] mt-0.5">Elimina borradores y silencios almacenados en este dispositivo. No borra los mensajes de la conversación.</p></div><button onclick="clearPrivateChatData()" class="w-full px-4 py-3 text-left text-[16px] font-medium text-[#dc2626] active:bg-[#fef2f2]">Limpiar datos locales de chat</button></section>')
W(s, e, c)
print('8. chat-privacy-settings-view OK')

# ================= 9. direct-messages-config-view =================
s, e, c = V('direct-messages-config-view')
c = flat_container(c, 'direct-messages-config-view')
c = flat_scroller(c, 'flex-1 overflow-y-auto px-4 py-5 space-y-5')
c = rep(c, '<p class="text-sm text-[#6b7280] bg-[#dce1e5]/30 p-4 rounded-xl border border-[#dce1e5]">',
           '<p class="px-4 pt-4 text-[14px] text-[#606d77] leading-relaxed">')
c = rep(c, '<label class="block text-sm font-bold text-[#1c2b4a]">Permisos de Mensajes</label>',
           '<label class="block text-[17px] font-semibold text-[#1c2b4a] px-4">Permisos de Mensajes</label>')
c = rep(c, 'class="w-full px-4 py-3 border border-[#dce1e5] rounded-2xl focus:outline-none focus:ring-2 focus:ring-[#0084FF]"',
           'class="w-full px-4 py-3 bg-white border border-[#dce1e5] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#0084FF]"')
c = rep(c, 'class="w-full bg-[#0084FF] text-white py-3 rounded-2xl font-bold active:scale-95 transition-all"',
           'class="w-full bg-[#0084FF] text-white py-3.5 rounded-xl font-bold active:opacity-90 transition-all"')
W(s, e, c)
print('9. direct-messages-config-view OK')

# ================= 10. phone-config-view =================
s, e, c = V('phone-config-view')
c = flat_container(c, 'phone-config-view')
c = flat_scroller(c, 'flex-1 overflow-y-auto px-4 py-5 space-y-5')
c = rep(c, '<div class="flex items-center gap-3 bg-[#dce1e5]/40 p-4 rounded-2xl border border-[#dce1e5]">',
           '<div class="flex items-center gap-4 px-4 py-4 bg-white">')
c = rep(c, '<div class="w-10 h-10 bg-[#0084FF] rounded-xl flex items-center justify-center shrink-0">',
           '<div class="shrink-0 text-[#0084FF]">')
c = rep(c, '<svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">',
           '<svg class="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">')
c = rep(c, '<p class="text-sm text-[#5c6974] font-medium leading-snug">',
           '<p class="text-[13px] text-[#7b8794] leading-snug">')
c = rep(c, '<label class="block text-sm font-bold text-[#1c2b4a]">Número de Teléfono</label>',
           '<label class="block text-[17px] font-semibold text-[#1c2b4a] px-4">Número de Teléfono</label>')
c = rep(c, 'class="w-full px-4 py-3 border border-[#dce1e5] rounded-2xl bg-white focus:outline-none focus:ring-2 focus:ring-[#0084FF] text-[#1c2b4a]"',
           'class="w-full px-4 py-3 bg-white border border-[#dce1e5] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#0084FF] text-[#1c2b4a]"')
c = rep(c, '<label id="phone-human-check" class="flex items-center gap-3 p-4 bg-white border border-[#dce1e5] rounded-2xl cursor-pointer select-none active:scale-[0.98] transition-transform"',
           '<label id="phone-human-check" class="flex items-center gap-3 px-4 py-4 bg-white cursor-pointer select-none"')
c = rep(c, 'class="w-full bg-[#0084FF] text-white py-3.5 rounded-2xl font-bold active:scale-95 transition-all shadow-lg shadow-[#0084FF]/20"',
           'class="w-full bg-[#0084FF] text-white py-3.5 rounded-xl font-bold active:opacity-90 transition-all"')
W(s, e, c)
print('10. phone-config-view OK')
# ================= 11. app-language-settings-view =================
s, e, c = V('app-language-settings-view')
c = flat_container(c, 'app-language-settings-view')
c = flat_scroller(c, 'flex-1 overflow-y-auto px-4 py-5 space-y-5')
c = rep(c, '<button id="app-language-es" onclick="setAppLanguage(\'es\')"',
           '<div class="bg-white mt-2">\n      <button id="app-language-es" onclick="setAppLanguage(\'es\')"')
c = rep(c, 'class="app-language-option w-full min-h-16 flex items-center justify-between gap-3 rounded-2xl border border-[#0084FF] bg-white p-4 text-left"',
           'class="app-language-option w-full px-4 py-3 flex items-center justify-between gap-4 text-left active:bg-[#f5f5f5]"')
c = rep(c, 'class="app-language-option w-full min-h-16 flex items-center justify-between gap-3 rounded-2xl border border-[#dce1e5] bg-white p-4 text-left"',
           'class="app-language-option w-full px-4 py-3 flex items-center justify-between gap-4 text-left active:bg-[#f5f5f5]"')
c = rep(c, '<p class="font-bold text-[#1c2b4a]">Español</p><p class="text-xs text-[#6b7280] mt-1">Idioma de la interfaz</p>',
           '<p class="text-[16px] text-[#1c2b4a]">Español</p><p class="text-[13px] text-[#7b8794] mt-0.5">Idioma de la interfaz</p>')
c = rep(c, '<p class="font-bold text-[#1c2b4a]">English</p><p class="text-xs text-[#6b7280] mt-1">App interface language</p>',
           '<p class="text-[16px] text-[#1c2b4a]">English</p><p class="text-[13px] text-[#7b8794] mt-0.5">App interface language</p>')
c = rep(c, '<span class="app-language-check w-6 h-6 rounded-full bg-[#0084FF] text-white flex items-center justify-center" aria-hidden="true">✓</span>',
           '<span class="app-language-check text-[#0084FF] text-xl font-bold" aria-hidden="true">✓</span>')
c = rep(c, '<span class="app-language-check hidden w-6 h-6 rounded-full bg-[#0084FF] text-white flex items-center justify-center" aria-hidden="true">✓</span>',
           '<span class="app-language-check hidden text-[#0084FF] text-xl font-bold" aria-hidden="true">✓</span>')
c = reprep(c, r'</button>(\s*)<button id="app-language-en"',
           '</button>\n' + HAIR + r'\1<button id="app-language-en"')
c = rep(c, '<p class="text-xs text-[#6b7280] leading-relaxed px-1 pt-2">El idioma de la aplicación es independiente',
           '</div>\n      <p class="px-4 pt-6 text-[13px] text-[#7b8794] leading-relaxed">El idioma de la aplicación es independiente')
W(s, e, c)
# syncAppLanguageUI: solo alterna el check, sin bordes
H = rep(H, "option.classList.toggle('border-[#0084FF]', selected); option.classList.toggle('border-[#dce1e5]', !selected); option.querySelector('.app-language-check')?.classList.toggle('hidden', !selected);",
           "option.querySelector('.app-language-check')?.classList.toggle('hidden', !selected);")
print('11. app-language-settings-view OK')
# ================= 12. learning-language-settings-view =================
s, e, c = V('learning-language-settings-view')
c = flat_container(c, 'learning-language-settings-view')
c = flat_scroller(c, 'flex-1 overflow-y-auto px-4 py-5 space-y-5')
c = rep(c, '<div class="bg-white border border-[#dce1e5] rounded-3xl p-4 shadow-sm">',
           '<p class="px-4 pt-4 text-[14px] text-[#606d77] leading-relaxed">')
c = reprep(c, r'<p class="px-4 pt-4 text-\[14px\] text-\[#606d77\] leading-relaxed">\s*<p class="text-sm text-\[#6b7280\] leading-relaxed">(.*?)</p>\s*</div>',
           r'<p class="px-4 pt-4 text-[14px] text-[#606d77] leading-relaxed">\1</p>')
c = rep(c, '<div id="learning-language-settings-list" class="space-y-2">',
           '<div id="learning-language-settings-list" class="bg-white mt-2">')
W(s, e, c)
# selectLearningLanguageFromSettings: solo alterna el check
H = rep(H, "button.classList.toggle('border-[#0084FF]', selected);\n      button.classList.toggle('bg-[#eef2f7]', selected);\n      button.classList.toggle('border-[#dce1e5]', !selected);\n      button.classList.toggle('bg-white', !selected);\n      button.querySelector('.learning-language-check')?.classList.toggle('hidden', !selected);",
           "button.querySelector('.learning-language-check')?.classList.toggle('hidden', !selected);")
print('12. learning-language-settings-view OK')
# ================= 13. translations-config-view =================
s, e, c = V('translations-config-view')
c = flat_container(c, 'translations-config-view')
c = flat_scroller(c, 'flex-1 overflow-y-auto px-4 py-5 space-y-5')
# tarjeta descripcion -> intro plano (chip + svg fuera)
c = rep(c, '<div class="bg-white border border-[#dce1e5] rounded-3xl p-4 shadow-sm">\n        <div class="flex items-center gap-3 mb-3">',
           '<div class="px-4 pt-4">\n        <div class="mb-2">')
c = reprep(c, r'<div class="w-10 h-10 bg-\[#eef2f7\] rounded-xl flex items-center justify-center text-\[#5c6974\]">\s*<svg class="w-6 h-6" fill="none"[\s\S]*?</svg>\s*</div>', '')
c = rep(c, '<p class="font-bold text-[#1c2b4a]">Idioma de publicaciones</p>',
           '<p class="text-[17px] font-semibold text-[#1c2b4a]">Idioma de publicaciones</p>')
c = rep(c, '<p class="text-xs text-[#6b7280]">Las publicaciones en otros idiomas se traducir\u00e1n autom\u00e1ticamente</p>',
           '<p class="text-[13px] text-[#7b8794] mt-0.5">Las publicaciones en otros idiomas se traducir\u00e1n autom\u00e1ticamente</p>')
c = rep(c, '<p class="text-sm text-[#6b7280] leading-relaxed">Selecciona tu idioma preferido.',
           '<p class="mt-2 text-[14px] text-[#606d77] leading-relaxed">Selecciona tu idioma preferido.')
# tarjeta toggle -> fila plana
c = rep(c, '<div class="bg-white border border-[#dce1e5] rounded-3xl p-4 shadow-sm">\n        <div class="flex items-center justify-between">',
           '<div class="bg-white mt-2">\n        <div class="px-4 py-3 flex items-center justify-between gap-4">')
c = rep(c, '<p class="font-bold text-[#1c2b4a]">Traducci\u00f3n autom\u00e1tica</p>',
           '<p class="text-[16px] text-[#1c2b4a]">Traducci\u00f3n autom\u00e1tica</p>')
c = rep(c, '<p class="text-sm text-[#6b7280]">Traducir publicaciones en otros idiomas</p>',
           '<p class="text-[13px] text-[#7b8794] mt-0.5">Traducir publicaciones en otros idiomas</p>')
# tarjeta lista -> grupo plano
c = rep(c, '<div class="bg-white border border-[#dce1e5] rounded-3xl p-4 shadow-sm">\n        <p class="font-bold text-[#1c2b4a] mb-3">Seleccionar idioma</p>',
           '<div class="bg-white mt-6">\n        <p class="px-4 pt-4 pb-2 text-[17px] font-semibold text-[#1c2b4a]">Seleccionar idioma</p>')
c = rep(c, '<div id="language-list" class="space-y-2 max-h-[50vh] overflow-y-auto pr-1">',
           '<div id="language-list" class="max-h-[50vh] overflow-y-auto">')
W(s, e, c)
print('13. translations-config-view OK')

# ================= 14. pronouns-config-view =================
s, e, c = V('pronouns-config-view')
c = flat_container(c, 'pronouns-config-view')
c = rep(c, '<div class="flex-1 p-6 space-y-3">', '<div class="flex-1 overflow-y-auto px-4 py-5"><div class="bg-white mt-2">')
c = rep(c, 'class="pronouns-option w-full text-left p-4 rounded-2xl bg-white border border-[#dce1e5] font-semibold text-[#1c2b4a]"',
           'class="pronouns-option w-full flex items-center justify-between px-4 py-3 text-left text-[16px] text-[#1c2b4a] active:bg-[#f5f5f5]"', 3)
c = reprep(c, r"(pronouns-option[^>]*>)(Él|Ella|No distinguido)</button>",
           r"\1\2" + '<span class="pronouns-check text-[#0084FF] text-xl font-bold hidden" aria-hidden="true">✓</span></button>', 3)
c = reprep(c, r'</button>(\s*)<button', '</button>\n' + HAIR + r'\1<button', 2)
c = reprep(c, r'(<button onclick="selectPronounsOption\(\'No distinguido\'\)[\s\S]*?</button>)\s*</div>\s*</div>',
           r'\1\n      </div>\n    </div>\n  </div>')
W(s, e, c)
# renderPronounsSelection: alterna el check en vez de borde/fondo
H = rep(H, """  function renderPronounsSelection() {
    document.querySelectorAll('.pronouns-option').forEach(btn => {
      const isActive = btn.textContent.trim() === selectedPronounsOption;
      btn.classList.toggle('border-[#5c6974]', isActive);
      btn.classList.toggle('bg-[#eef2f7]', isActive);
    });
  }""",
"""  function renderPronounsSelection() {
    document.querySelectorAll('.pronouns-option').forEach(btn => {
      const isActive = (btn.firstChild?.textContent || '').trim() === selectedPronounsOption;
      btn.querySelector('.pronouns-check')?.classList.toggle('hidden', !isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }""")
print('14. pronouns-config-view OK')

# ================= 15. screentime-view =================
s, e, c = V('screentime-view')
c = flat_container(c, 'screentime-view')
c = flat_scroller(c, 'flex-1 overflow-y-auto px-4 py-5 space-y-5')
# paneles de stats: sin cromo de tarjeta
c = rep(c, '<div class="bg-white border border-[#dce1e5] rounded-3xl p-5 shadow-sm">',
           '<div class="bg-white px-1 pt-2">', 2)
c = rep(c, '<p class="text-[11px] font-bold text-[#6b7280] uppercase tracking-wider mb-3">Hoy</p>',
           '<p class="text-[17px] font-semibold text-[#1c2b4a] mb-3">Hoy</p>')
c = rep(c, '<p class="text-[11px] font-bold text-[#6b7280] uppercase tracking-wider">Últimos 7 días</p>',
           '<p class="text-[17px] font-semibold text-[#1c2b4a]">Últimos 7 días</p>')
# grupo Límite diario
c = rep(c, '<p class="text-[11px] font-bold text-[#6b7280] uppercase tracking-wider px-2 pb-1">Límite diario</p>',
           '<p class="text-[17px] font-semibold text-[#1c2b4a] px-4 pb-1.5">Límite diario</p>')
c = rep(c, '<div class="bg-white border border-[#dce1e5] rounded-3xl overflow-hidden shadow-sm divide-y divide-[#eef2f7]">',
           '<div class="bg-white">')
c = rep(c, '<span class="w-9 h-9 rounded-2xl bg-[#eaf5fd] flex items-center justify-center shrink-0">', '')
c = rep(c, '<span class="w-9 h-9 rounded-2xl bg-[#fef6ea] flex items-center justify-center shrink-0">', '')
c = rep(c, '<span class="w-9 h-9 rounded-2xl bg-[#f0eafd] flex items-center justify-center shrink-0">', '')
c = rep(c, '<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-[#0ea5e9]"',
           '<svg xmlns="http://www.w3.org/2000/svg" class="w-7 h-7 shrink-0 text-[#0ea5e9]"')
c = rep(c, '<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-[#d97706]"',
           '<svg xmlns="http://www.w3.org/2000/svg" class="w-7 h-7 shrink-0 text-[#d97706]"')
c = rep(c, '<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-[#8b5cf6]"',
           '<svg xmlns="http://www.w3.org/2000/svg" class="w-7 h-7 shrink-0 text-[#8b5cf6]"')
c = reprep(c, r'</svg>\s*</span>', '</svg>', 3)
c = rep(c, '<div class="flex items-center justify-between p-4">',
           '<div class="px-4 py-3 flex items-center justify-between gap-4">', 3)
c = rep(c, '<div class="flex items-center gap-3">', '<div class="flex items-center gap-4 min-w-0">', 3)
c = rep(c, '<p class="font-semibold text-[#1c2b4a]">', '<p class="text-[16px] text-[#1c2b4a]">', 3)
c = rep(c, '<p class="text-xs text-[#6b7280]">', '<p class="text-[13px] text-[#7b8794] mt-0.5">', 3)
c = reprep(c, r'(</(?:select|button)>\s*</div>)\s*<div class="px-4 py-3 flex items-center justify-between gap-4">',
           r'\1\n          ' + HAIRF + '\n          <div class="px-4 py-3 flex items-center justify-between gap-4">', 2)
W(s, e, c)
print('15. screentime-view OK')

# ================= 16. formularios (name, username, info, location, email, password, birthday) =================
def flat_form(vid, scroller_old):
    s, e, c = V(vid)
    c = flat_container(c, vid)
    c = rep(c, scroller_old, '<div class="flex-1 overflow-y-auto px-4 py-5 space-y-5">')
    if '<div class="bg-white border border-[#dce1e5] rounded-3xl p-4 shadow-sm">' in c:
        c = c.replace('<div class="bg-white border border-[#dce1e5] rounded-3xl p-4 shadow-sm">', '<div class="bg-white">')
    # reemplazos sin conteo (alcance limitado a la vista)
    c = c.replace('<label class="block mb-2 font-bold text-[#5c6974]">', '<label class="block mb-1.5 text-[15px] font-semibold text-[#1c2b4a]">')
    c = c.replace('w-full p-3 rounded-xl border border-[#dce1e5] bg-white text-[#1c2b4a]', 'w-full px-4 py-3 rounded-xl bg-[#f0f2f5] text-[#1c2b4a] placeholder-[#9aa5b1] focus:outline-none')
    c = c.replace('<p class="text-xs text-[#6b7280]', '<p class="text-[13px] text-[#7b8794]')
    assert '<label class="block mb-2 font-bold text-[#5c6974]">' not in c, 'labels sin convertir en ' + vid
    W(s, e, c)
    print('16x.', vid, 'OK')

flat_form('name-config-view', '<div class="flex-1 p-6 space-y-4">')
flat_form('username-config-view', '<div class="flex-1 p-6">')
flat_form('info-config-view', '<div class="flex-1 p-6">')
flat_form('password-config-view', '<div class="flex-1 p-6 space-y-4">')

# birthday (labels propios)
s, e, c = V('birthday-config-view')
c = flat_container(c, 'birthday-config-view')
c = rep(c, '<div class="flex-1 p-6 space-y-4 overflow-y-auto">', '<div class="flex-1 overflow-y-auto px-4 py-5 space-y-5">')
c = rep(c, '<div class="bg-white border border-[#dce1e5] rounded-3xl p-4 shadow-sm">', '<div class="bg-white">')
c = c.replace('<p class="text-xs text-[#6b7280]', '<p class="text-[13px] text-[#7b8794]')
c = rep(c, '<label class="block mb-4 font-bold text-[#5c6974]">', '<label class="block mb-1.5 text-[15px] font-semibold text-[#1c2b4a]">')
c = rep(c, '<label class="block text-sm font-semibold text-[#5c6974] mb-2">', '<label class="block text-[13px] font-semibold text-[#7b8794] mb-1.5">', 3)
W(s, e, c)
print('16x. birthday-config-view OK')

# email: input readonly
s, e, c = V('email-config-view')
c = flat_container(c, 'email-config-view')
c = rep(c, '<div class="flex-1 p-6 space-y-4">', '<div class="flex-1 overflow-y-auto px-4 py-5 space-y-5">')
c = rep(c, '<div class="bg-white border border-[#dce1e5] rounded-3xl p-4 shadow-sm">', '<div class="bg-white">')
c = rep(c, '<label class="block mb-2 font-bold text-[#5c6974]">', '<label class="block mb-1.5 text-[15px] font-semibold text-[#1c2b4a]">')
c = rep(c, 'w-full p-3 rounded-xl border border-[#dce1e5] bg-gray-100 text-[#6b7280]', 'w-full px-4 py-3 rounded-xl bg-[#f0f2f5] text-[#6b7280]')
c = rep(c, '<p class="text-xs text-[#6b7280]', '<p class="text-[13px] text-[#7b8794]')
W(s, e, c)
print('16x. email-config-view OK')

# birthday: stepper buttons keep (funcionales), solo labels ya planos arriba
s, e, c = V('birthday-config-view')
n_labels = c.count('text-[15px] font-semibold text-[#1c2b4a]')
assert n_labels == 1, f'birthday main label {n_labels}'
W(s, e, c)
print('16y. birthday labels OK')

# location: buscador de país + ciudad + preview
s, e, c = V('location-config-view')
c = flat_container(c, 'location-config-view')
c = rep(c, '<label for="settings-country-search" class="block font-bold text-[#5c6974]">',
           '<label for="settings-country-search" class="block mb-1.5 text-[15px] font-semibold text-[#1c2b4a]">')
c = rep(c, 'class="w-full min-h-12 pl-11 pr-4 rounded-xl border border-[#dce1e5] bg-white text-[#1c2b4a]"',
           'class="w-full min-h-12 pl-11 pr-4 rounded-xl bg-[#f0f2f5] text-[#1c2b4a] placeholder-[#9aa5b1] focus:outline-none"')
c = rep(c, '<div id="settings-country-selected" class="hidden items-center justify-between gap-3 rounded-xl border border-[#0084FF] bg-[#eef2f7] px-4 py-3">',
           '<div id="settings-country-selected" class="hidden items-center justify-between gap-3 rounded-xl bg-[#f0f2f5] px-4 py-3">')
c = rep(c, '<label for="settings-city" class="block mb-2 font-bold text-[#5c6974]">',
           '<label for="settings-city" class="block mb-1.5 text-[15px] font-semibold text-[#1c2b4a]">')
c = rep(c, 'class="w-full min-h-11 px-4 rounded-xl border border-[#dce1e5] bg-white text-[#1c2b4a]"',
           'class="w-full min-h-11 px-4 rounded-xl bg-[#f0f2f5] text-[#1c2b4a] placeholder-[#9aa5b1] focus:outline-none"')
c = rep(c, '<div class="rounded-2xl border border-[#dce1e5] bg-white p-4"><p class="text-xs font-bold text-[#1c2b4a]">Vista previa</p><p id="settings-location-preview" class="text-sm text-[#5c6974] mt-1">',
           '<div class="bg-white"><p class="text-[13px] font-semibold text-[#7b8794]">Vista previa</p><p id="settings-location-preview" class="text-[15px] text-[#1c2b4a] mt-1">')
c = rep(c, '<p id="settings-country-status" class="text-xs text-[#6b7280]"', '<p id="settings-country-status" class="text-[13px] text-[#7b8794]"')
c = rep(c, '<p class="text-xs text-[#6b7280] mt-2">La ciudad es opcional.', '<p class="text-[13px] text-[#7b8794] mt-2">La ciudad es opcional.')
W(s, e, c)
print('16z. location-config-view OK')

# ================= 17. renderers dinámicos: listas de idiomas =================
def replace_fn(name, new_src):
    global H
    i = H.find('function ' + name + '(')
    assert i >= 0, 'fn no encontrada: ' + name
    j = H.find('{', i)
    depth = 0
    for k in range(j, len(H)):
        if H[k] == '{': depth += 1
        elif H[k] == '}':
            depth -= 1
            if depth == 0:
                H = H[:i] + new_src + H[k+1:]
                return
    raise AssertionError('llaves sin cerrar: ' + name)

# CSS: lang-selected sin borde/fondo
H = rep(H, '.lang-selected {\n      border-color: #0084FF !important;\n      background: #eef2f7 !important;\n    }',
           '.lang-selected {}')

replace_fn('renderLanguageList', '''function renderLanguageList() {
    const list = document.getElementById('language-list');
    if (!list) return;

    list.innerHTML = WORLD_LANGUAGES.map((lang, i, arr) => `
      <button
        class="lang-option-btn w-full flex items-center justify-between px-4 py-3 text-left active:bg-[#f5f5f5]"
        data-lang-code="${lang.code}"
        onclick="selectLanguage('${lang.code}')"
      >
        <span class="text-[16px] text-[#1c2b4a]">${lang.name}</span>
        <span class="lang-check text-[#0084FF] text-xl font-bold" style="display:${lang.code === userPreferredLang ? 'inline' : 'none'}">\\u2713</span>
      </button>${i < arr.length - 1 ? '\\n      <div class="ml-4 h-px bg-[#efefef]"></div>' : ''}
    `).join('');
  }''')

# selectLanguage: check inline en vez de flex
H = rep(H, "if (check) check.style.display = isSelected ? 'flex' : 'none';",
           "if (check) check.style.display = isSelected ? 'inline' : 'none';")

replace_fn('renderLearningLanguageSettings', '''function renderLearningLanguageSettings(selectedCode = '', selectedName = '') {
    const list = document.getElementById('learning-language-settings-list');
    if (!list || typeof LEARNING_LANGUAGE_META === 'undefined') return;
    const currentCode = selectedCode || window._drexLearningLanguage || '';
    const currentName = selectedName || '';
    const entries = Object.entries(LEARNING_LANGUAGE_META);
    list.innerHTML = entries.map(([code, meta], idx) => {
      const selected = code === currentCode;
      const safeCode = String(code).replace(/[^a-z]/gi, '');
      return `
        <button type="button" class="learning-language-option w-full flex items-center justify-between gap-4 px-4 py-3 text-left active:bg-[#f5f5f5]" data-learning-language="${safeCode}" onclick="selectLearningLanguageFromSettings('${safeCode}')">
          <div class="flex items-center gap-4 min-w-0">
            <img src="${getCountryFlagUrl(meta.flag)}" alt="Bandera de ${escapeHtml(meta.name)}" class="w-9 h-6 object-cover rounded-sm shrink-0">
            <div class="min-w-0"><p class="text-[16px] text-[#1c2b4a]">${escapeHtml(meta.name)}</p><p class="text-[13px] text-[#7b8794] mt-0.5">Idioma de aprendizaje</p></div>
          </div>
          <span class="learning-language-check ${selected ? '' : 'hidden'} text-[#0084FF] text-xl font-bold shrink-0" aria-hidden="true">\\u2713</span>
        </button>${idx < entries.length - 1 ? '\\n        <div class="ml-[60px] h-px bg-[#efefef]"></div>' : ''}`;
    }).join('');
    syncLearningLanguagePreview(currentCode, currentName);
  }''')

print('17. renderers OK')

# escritura atómica: solo si todas las secciones pasaron
open(P, 'w', encoding='utf-8').write(H)
print('ESCRITO:', P)
