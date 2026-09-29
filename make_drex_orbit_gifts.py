#!/usr/bin/env python3
"""Genera los 6 regalos exclusivos Drex Orbit: PNG 512x512 transparentes,
arte original estilo cosmico indigo Drex (nada parecido a TikTok)."""
import math, random
from PIL import Image, ImageDraw, ImageFilter

random.seed(7)
S = 512
CX, CY = S/2, S/2

def base():
    return Image.new('RGBA', (S, S), (0, 0, 0, 0))

def radial_glow(img, cx, cy, r, color, alpha=200):
    g = Image.new('L', (S, S), 0)
    d = ImageDraw.Draw(g)
    steps = 48
    for i in range(steps, 0, -1):
        rr = r * i / steps
        a = int(alpha * (1 - i/steps) ** 1.6)
        d.ellipse([cx-rr, cy-rr, cx+rr, cy+rr], fill=a)
    glow = Image.new('RGBA', (S, S), color + (0,))
    img.alpha_composite(glow, (0, 0), glow)
    # apply the falloff mask
    px = img.load(); gm = g.load()
    # simpler: paste a colored ellipse blurred
    return img

def glow_disc(img, cx, cy, r, color, blur=30):
    layer = Image.new('RGBA', (S, S), (0,0,0,0))
    d = ImageDraw.Draw(layer)
    d.ellipse([cx-r, cy-r, cx+r, cy+r], fill=color + (255,))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    img.alpha_composite(layer)
    return img

def star(img, x, y, r, color=(255,255,255,255)):
    d = ImageDraw.Draw(img)
    d.ellipse([x-r, y-r, x+r, y+r], fill=color)

def stars_field(img, n=40):
    for _ in range(n):
        x = random.uniform(60, S-60); y = random.uniform(60, S-60)
        r = random.uniform(1.2, 3.4)
        a = random.randint(90, 230)
        star(img, x, y, r, (255,255,255,a))

def ring(img, cx, cy, r, w, color):
    d = ImageDraw.Draw(img)
    d.ellipse([cx-r, cy-r, cx+r, cy+r], outline=color, width=w)

def save(img, name):
    img.save(f'/home/hatch/workspace/beabo/assets/live-gifts/{name}.png')
    print('ok', name)

# ---------- 1. orbit_corona: Corona Indigo ----------
img = base()
glow_disc(img, CX, CY-20, 200, (80, 60, 220), 40)
stars_field(img, 45)
d = ImageDraw.Draw(img)
# crown body: 5 points
pts = [(CX-150, CY+90), (CX-150, CY-30), (CX-90, CY+20), (CX-45, CY-70),
       (CX, CY+10), (CX+45, CY-70), (CX+90, CY+20), (CX+150, CY-30), (CX+150, CY+90)]
d.polygon(pts, fill=(58, 44, 170, 255), outline=(150, 130, 255, 255))
# gold trim
d.polygon(pts, outline=(255, 205, 90, 255))
for x, y in [(CX-150, CY-30), (CX-45, CY-70), (CX+45, CY-70), (CX+150, CY-30)]:
    star(img, x, y-14, 12, (255, 215, 120, 255))
    glow_disc(img, x, y-14, 26, (255, 200, 90), 14)
# jewels on band
for x in (CX-100, CX-50, CX, CX+50, CX+100):
    d.ellipse([x-14, CY+52, x+14, CY+80], fill=(20, 10, 80, 255), outline=(255,205,90,255))
    star(img, x, CY+66, 7, (140, 180, 255, 255))
d.rectangle([CX-150, CY+90, CX+150, CY+112], fill=(255, 205, 90, 255))
img = img.filter(ImageFilter.GaussianBlur(0.4))
save(img, 'orbit_corona')

# ---------- 2. orbit_nucleo: Nucleo Drex ----------
img = base()
glow_disc(img, CX, CY, 210, (47, 51, 184), 42)
stars_field(img, 50)
# orbit rings
for r, w, col in [(150, 5, (120, 120, 255, 220)), (185, 3, (90, 90, 230, 160))]:
    ring(img, CX, CY, r, w, col)
# core
for r, col, bl in [(95, (90, 110, 255), 26), (62, (140, 160, 255), 12), (34, (230, 238, 255), 4)]:
    glow_disc(img, CX, CY, r, col, bl)
# orbiting sparks
for a in range(0, 360, 45):
    x = CX + 150*math.cos(math.radians(a)); y = CY + 150*math.sin(math.radians(a))
    star(img, x, y, 8, (180, 190, 255, 255))
    glow_disc(img, x, y, 20, (120, 130, 255), 12)
save(img, 'orbit_nucleo')

# ---------- 3. orbit_portal: Portal Estelar ----------
img = base()
d = ImageDraw.Draw(img)
# spiral arms
for arm in range(3):
    pts = []
    for i in range(90):
        t = i / 90
        ang = t * 4.2 * math.pi + arm * 2.1
        r = 40 + t * 165
        x = CX + r * math.cos(ang); y = CY + r * math.sin(ang) * 0.82
        pts.append((x, y))
    d.line(pts, fill=(110, 100, 255, 235), width=17)
    d.line(pts, fill=(190, 190, 255, 200), width=6)
glow_disc(img, CX, CY, 200, (70, 60, 200), 44)
glow_disc(img, CX, CY, 55, (20, 16, 70), 10)
d.ellipse([CX-38, CY-38, CX+38, CY+38], fill=(8, 6, 30, 255), outline=(170, 160, 255, 255))
stars_field(img, 42)
save(img, 'orbit_portal')

# ---------- 4. orbit_cometa: Cometa Dorado ----------
img = base()
# tail
for i in range(46):
    t = i / 46
    x = CX + 120 - t * 300; y = CY - 60 + t * 170
    r = 66 * (1 - t) + 4
    glow_disc(img, x, y, r, (255, 190, 90) if i % 2 else (150, 120, 255), 16)
# head
glow_disc(img, CX+120, CY-60, 95, (255, 205, 110), 30)
glow_disc(img, CX+120, CY-60, 52, (255, 235, 190), 12)
star(img, CX+120, CY-60, 26, (255, 252, 240, 255))
stars_field(img, 48)
save(img, 'orbit_cometa')

# ---------- 5. orbit_cristal: Cristal Prisma ----------
img = base()
glow_disc(img, CX, CY, 190, (90, 90, 220), 40)
stars_field(img, 40)
d = ImageDraw.Draw(img)
# crystal: hexagonal prism
top = [(CX, CY-150), (CX+105, CY-85), (CX+105, CY+75), (CX, CY+140), (CX-105, CY+75), (CX-105, CY-85)]
d.polygon(top, fill=(70, 80, 220, 235), outline=(200, 210, 255, 255))
# facets
d.polygon([(CX, CY-150), (CX+105, CY-85), (CX, CY-10), (CX-105, CY-85)], fill=(120, 130, 255, 235), outline=(200,210,255,255))
d.polygon([(CX, CY-10), (CX+105, CY-85), (CX+105, CY+75), (CX, CY+140)], fill=(52, 60, 190, 235), outline=(200,210,255,255))
d.polygon([(CX, CY-10), (CX, CY+140), (CX-105, CY+75), (CX-105, CY-85)], fill=(88, 96, 235, 235), outline=(200,210,255,255))
# inner glow lines
d.line([(CX, CY-150), (CX, CY+140)], fill=(235, 240, 255, 255), width=5)
# sparkles
for x, y in [(CX-140, CY-40), (CX+140, CY-60), (CX, CY+170)]:
    star(img, x, y, 10, (220, 225, 255, 255))
    glow_disc(img, x, y, 24, (150, 160, 255), 12)
save(img, 'orbit_cristal')

# ---------- 6. orbit_fenix: Fenix Cosmico ----------
img = base()
glow_disc(img, CX, CY, 200, (120, 70, 220), 42)
stars_field(img, 46)
d = ImageDraw.Draw(img)
# abstract phoenix: sweeping wing arcs
for k in range(5):
    w = 26 - k*3
    # left wing
    pts = []
    for i in range(60):
        t = i/60
        x = CX - 30 - t*150
        y = CY + 40 - math.sin(t*math.pi)* (120 - k*16) - k*10
        pts.append((x, y))
    col = (150 - k*12, 110 - k*8, 255, 235)
    d.line(pts, fill=col, width=w)
    # right wing mirrored
    pts2 = [(2*CX - x, y) for x, y in pts]
    d.line(pts2, fill=col, width=w)
# body flame
glow_disc(img, CX, CY+30, 70, (200, 150, 255), 22)
glow_disc(img, CX, CY+30, 38, (240, 235, 255), 10)
# head
star(img, CX, CY-70, 16, (235, 240, 255, 255))
glow_disc(img, CX, CY-70, 34, (160, 150, 255), 14)
save(img, 'orbit_fenix')

print('done')
