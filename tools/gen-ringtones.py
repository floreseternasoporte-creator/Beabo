#!/usr/bin/env python3
"""Genera los timbres de llamada ORIGINALES "galácticos" de Drex (entrante y saliente).

Síntesis propia con numpy (sin muestras ni audio de terceros): campanas FM cristalinas,
pads etéreos con detune, "pings" tipo sonar, barridos suaves, sub bajo discreto, shimmer
(octava arriba) y reverb larga con estéreo amplio. Tres variantes:

  A  "Estrellas"  arpegio de campanas de cristal que sube y centellea sobre un pad suave
  B  "Sonar"      ping de señal de nave con eco y respuesta, sobre un pad quieto y un sweep suave   <- por defecto en la app
  C  "Nebulosa"   pad grande que florece con un barrido y una frase lenta de campanas

Todo en modo lidio / pentatónica (sonoridad abierta y luminosa, nada oscuro). Hay energía en
medios y agudos (300 Hz - 6 kHz) para que se oiga en altavoces de móvil; el sub bajo es solo un detalle.
Cada archivo es UN ciclo del bucle y empieza/termina en silencio (bucle sin cortes).

Uso:
  python3 tools/gen-ringtones.py OUT_DIR                  # genera ring-in-A/B/C.mp3 y ring-out-A/B/C.mp3
  python3 tools/gen-ringtones.py OUT_DIR --default A      # además copia esa variante a ring-in.mp3 / ring-out.mp3
  python3 tools/gen-ringtones.py --print-js A             # imprime DC_RING_SYNTH (respaldo de index.html)

Para CAMBIAR la variante de la app: copia ring-in-X.mp3 / ring-out-X.mp3 sobre assets/audio/ring-in.mp3 /
ring-out.mp3 (o usa --default X) y pega la salida de --print-js X en `const DC_RING_SYNTH=` de index.html
(copia index.html a 404.html y sube DREX_SW_VERSION). Requiere numpy y ffmpeg.
"""
import os, re, shutil, subprocess, sys, wave
import numpy as np

SR = 44100
_SEMI = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def nf(name):
    m = re.match(r'^([A-G])(#?)(\d)$', name)
    midi = 12 * (int(m.group(3)) + 1) + _SEMI[m.group(1)] + (1 if m.group(2) else 0)
    return 440.0 * 2 ** ((midi - 69) / 12)


# ------------------------------------------------------------------ voces
def fm_bell(f, dur, lv=1.0, tau=0.85, bright=2.4):
    """Campana de cristal: FM con modulador inarmónico (3.5x) que se apaga + parcial alto breve."""
    n = int(SR * (dur + 0.3)); t = np.arange(n) / SR
    idx = bright * np.exp(-t / 0.35)
    x = np.sin(2 * np.pi * f * t + idx * np.sin(2 * np.pi * f * 3.5 * t)) * np.exp(-t / tau)
    x += 0.10 * np.sin(2 * np.pi * f * 6.1 * t) * np.exp(-t / 0.06)
    a = int(SR * 0.002); x[:a] *= np.linspace(0, 1, a)
    r = int(SR * 0.12); x[-r:] *= np.linspace(1, 0, r)
    return lv * x


def sonar_ping(f, dur, lv=1.0, tau=0.55):
    """Ping de sonar: seno limpio con un leve 'chirp' inicial y un armónico suave."""
    n = int(SR * (dur + 0.2)); t = np.arange(n) / SR
    fr = f * (1 + 0.03 * np.exp(-t / 0.015))
    ph = 2 * np.pi * np.cumsum(fr) / SR
    x = (np.sin(ph) + 0.18 * np.sin(2 * ph)) * np.exp(-t / tau)
    a = int(SR * 0.003); x[:a] *= np.linspace(0, 1, a)
    r = int(SR * 0.1); x[-r:] *= np.linspace(1, 0, r)
    return lv * x


def pad(freqs, dur, lv=1.0, attack=0.9, release=1.0):
    """Pad etéreo estéreo: por nota, 3 voces desafinadas (±8 cents) con 6 armónicos (1/h), panoramizadas."""
    n = int(SR * dur); t = np.arange(n) / SR
    env = np.minimum(1, t / attack) ** 2
    env *= np.minimum(1, (dur - t) / release) ** 1.5
    out = np.zeros((n, 2))
    for f in freqs:
        for k, (cents, pan) in enumerate(((-8, 0.15), (0, 0.5), (8, 0.85))):
            ff = f * 2 ** (cents / 1200)
            v = np.zeros(n)
            for h in range(1, 7):
                if ff * h > 7000: break
                v += (1.0 / h) * np.sin(2 * np.pi * ff * h * t + 0.7 * k)
            out[:, 0] += v * np.cos(pan * np.pi / 2); out[:, 1] += v * np.sin(pan * np.pi / 2)
    return lv * 0.18 * out * env[:, None]


def sub(f, dur, lv=1.0):
    """Sub bajo suave: seno + 2º y 3er armónico (audibles en móvil) con ataque lento."""
    n = int(SR * dur); t = np.arange(n) / SR
    env = np.minimum(1, t / 0.5) ** 2 * np.minimum(1, (dur - t) / 0.8) ** 1.5
    x = np.sin(2 * np.pi * f * t) + 0.55 * np.sin(2 * np.pi * 2 * f * t) + 0.30 * np.sin(2 * np.pi * 3 * f * t)
    return lv * 0.35 * x * env


def sweep(dur, f0, f1, lv=1.0, seed=3):
    """Barrido suave: seno que sube con un poco de aire (ruido filtrado) y envolvente de campana."""
    n = int(SR * dur); t = np.arange(n) / SR
    fr = f0 * (f1 / f0) ** (t / dur)
    ph = 2 * np.pi * np.cumsum(fr) / SR
    env = np.sin(np.pi * t / dur) ** 2
    tone = np.sin(ph) * 0.6 + 0.25 * np.sin(2 * ph)
    rng = np.random.default_rng(seed)
    nz = rng.standard_normal(n); sp = np.fft.rfft(nz); fq = np.fft.rfftfreq(n, 1 / SR)
    sp *= ((fq > 2500) & (fq < 7000)); air = np.fft.irfft(sp, n); air /= np.max(np.abs(air)) + 1e-9
    return lv * 0.5 * (tone + 0.35 * air) * env


def place(buf, x, t0, pan=0.5):
    """Suma `x` (mono o estéreo) en `buf` desde t0 s, con panorama si es mono."""
    s = int(SR * t0); n = buf.shape[0]
    if s >= n: return
    e = min(n, s + len(x)); m = e - s
    if x.ndim == 1:
        buf[s:e, 0] += x[:m] * np.cos(pan * np.pi / 2); buf[s:e, 1] += x[:m] * np.sin(pan * np.pi / 2)
    else:
        buf[s:e] += x[:m]


# ------------------------------------------------------------------ variantes
# Cada una devuelve (dry, shimmer_send, longitud). `fb` = notas para el respaldo sintetizado de index.html.
def var_A(kind):
    if kind == 'in':   # Estrellas: cascada ascendente de campanas (re lidio) + eco "centelleo" sobre pad Dmaj9
        L = 3.8; dry = np.zeros((int(SR * L), 2)); sh = np.zeros_like(dry)
        place(dry, pad([nf('D3'), nf('A3'), nf('E4'), nf('F#4')], 3.2, 0.9, attack=0.7, release=1.4), 0.05)
        place(dry, sub(nf('D2'), 1.6, 0.8), 0.05)
        notes = [('A5', 0.12, 1.0), ('D6', 0.25, 1.0), ('E6', 0.38, 1.0), ('F#6', 0.51, 1.1), ('A6', 0.66, 1.3), ('E6', 1.10, 1.5)]
        for i, (nm, t0, d) in enumerate(notes):
            b = fm_bell(nf(nm), d, 0.75 if i < 5 else 0.6)
            place(dry, b, t0, 0.3 + 0.4 * ((i * 2) % 5) / 4); place(sh, b, t0, 0.5)
        for k, (g, dt) in enumerate(((0.35, 0.30), (0.18, 0.60))):   # ecos de las dos notas más altas
            for nm, t0 in (('A6', 0.66), ('E6', 1.10)):
                b = fm_bell(nf(nm), 0.8, g * 0.9); place(dry, b, t0 + dt, 0.25 if k == 0 else 0.75)
        return dry, sh, L
    L = 4.0; dry = np.zeros((int(SR * L), 2)); sh = np.zeros_like(dry)   # saliente: tres campanas bajas y calmadas
    place(dry, pad([nf('D3'), nf('A3'), nf('E4')], 3.4, 0.7, attack=0.9, release=1.5), 0.05)
    for i, (nm, t0) in enumerate((('A5', 0.15), ('D6', 0.55), ('E6', 0.95))):
        b = fm_bell(nf(nm), 1.4, 0.55, tau=1.0, bright=1.6); place(dry, b, t0, 0.35 + 0.15 * i); place(sh, b, t0, 0.5)
    return dry, sh, L


def var_B(kind):
    if kind == 'in':   # Sonar: ping agudo + eco punteado + respuesta más grave, con sweep suave y pad quieto (fa lidio)
        L = 3.8; dry = np.zeros((int(SR * L), 2)); sh = np.zeros_like(dry)
        place(dry, pad([nf('F3'), nf('C4'), nf('G4'), nf('A4')], 3.2, 0.8, attack=1.0, release=1.4), 0.05)
        place(dry, sub(nf('F2'), 1.4, 0.7), 0.05)
        place(dry, sweep(0.9, 500, 2600, 0.45), 0.00)
        p1 = sonar_ping(nf('C6'), 0.9, 0.95); place(dry, p1, 0.80, 0.5); place(sh, p1, 0.80, 0.5)
        for g, dt, pn in ((0.45, 0.32, 0.2), (0.25, 0.64, 0.8), (0.12, 0.96, 0.3)):   # eco punteado ping-pong
            place(dry, sonar_ping(nf('C6'), 0.7, g), 0.80 + dt, pn)
        p2 = sonar_ping(nf('G5'), 1.0, 0.8, tau=0.7); place(dry, p2, 1.95, 0.5); place(sh, p2, 1.95, 0.5)  # respuesta
        place(dry, sonar_ping(nf('G5'), 0.7, 0.30, tau=0.7), 2.30, 0.8)
        return dry, sh, L
    L = 4.0; dry = np.zeros((int(SR * L), 2)); sh = np.zeros_like(dry)   # saliente: dos pings suaves "buscando señal"
    place(dry, pad([nf('F3'), nf('C4'), nf('G4')], 3.4, 0.6, attack=1.0, release=1.5), 0.05)
    for t0 in (0.2, 1.9):
        p = sonar_ping(nf('G5'), 1.0, 0.7 if t0 < 1 else 0.5, tau=0.7); place(dry, p, t0, 0.5); place(sh, p, t0, 0.5)
        place(dry, sonar_ping(nf('G5'), 0.7, 0.28, tau=0.7), t0 + 0.45, 0.2); place(dry, sonar_ping(nf('G5'), 0.7, 0.14, tau=0.7), t0 + 0.9, 0.8)
    return dry, sh, L


def var_C(kind):
    if kind == 'in':   # Nebulosa: pad grande que florece tras un barrido + frase lenta de 3 campanas (sol lidio add9)
        L = 4.0; dry = np.zeros((int(SR * L), 2)); sh = np.zeros_like(dry)
        place(dry, sweep(1.0, 350, 3200, 0.55, seed=5), 0.05)
        place(dry, pad([nf('G3'), nf('D4'), nf('A4'), nf('B4'), nf('F#5')], 3.5, 1.15, attack=0.9, release=1.5), 0.40)
        place(dry, sub(nf('G2'), 1.8, 0.8), 0.40)
        for i, (nm, t0, d) in enumerate((('D6', 1.05, 1.6), ('B5', 1.60, 1.6), ('G6', 2.15, 1.9))):
            b = fm_bell(nf(nm), d, 0.8, tau=1.1, bright=2.0); place(dry, b, t0, 0.3 + 0.2 * i); place(sh, b, t0, 0.5)
            place(dry, fm_bell(nf(nm), 1.0, 0.25, tau=0.9), t0 + 0.42, 0.7 - 0.2 * i)
        return dry, sh, L
    L = 4.2; dry = np.zeros((int(SR * L), 2)); sh = np.zeros_like(dry)   # saliente: swell suave + una campana
    place(dry, sweep(0.9, 400, 2200, 0.35, seed=6), 0.05)
    place(dry, pad([nf('G3'), nf('D4'), nf('A4')], 3.6, 0.7, attack=1.0, release=1.6), 0.35)
    b = fm_bell(nf('D6'), 1.8, 0.55, tau=1.2, bright=1.6); place(dry, b, 1.2, 0.45); place(sh, b, 1.2, 0.5)
    place(dry, fm_bell(nf('D6'), 1.2, 0.2, tau=1.0), 1.65, 0.75)
    return dry, sh, L


VARIANTS = {'A': var_A, 'B': var_B, 'C': var_C}

# Notas del respaldo sintetizado de index.html (suena solo si el mp3 no carga): [freq, inicio s, duración s]
FALLBACK = {
    'A': {'in': (3.8, [('A5', 0.12, 1.0), ('D6', 0.25, 1.0), ('E6', 0.38, 1.0), ('F#6', 0.51, 1.1), ('A6', 0.66, 1.3), ('E6', 1.10, 1.5)]),
          'out': (4.0, [('A5', 0.15, 1.4), ('D6', 0.55, 1.4), ('E6', 0.95, 1.4)])},
    'B': {'in': (3.8, [('C6', 0.80, 0.9), ('G5', 1.95, 1.0)]),
          'out': (4.0, [('G5', 0.20, 1.0), ('G5', 1.90, 1.0)])},
    'C': {'in': (4.0, [('D6', 1.05, 1.6), ('B5', 1.60, 1.6), ('G6', 2.15, 1.9)]),
          'out': (4.2, [('D6', 1.20, 1.8)])},
}


def reverb(sig, rt=0.5, length=2.0, seed=11):
    """Reverb larga y ancha: ruido decorrelado L/R, con cola que pierde agudos (calidez)."""
    rng = np.random.default_rng(seed)
    n = sig.shape[0]; Lr = int(SR * length); tt = np.arange(Lr) / SR
    wet = np.zeros_like(sig)
    m = 1 << int(np.ceil(np.log2(n + Lr)))
    fq = np.fft.rfftfreq(Lr, 1 / SR)
    for ch in range(2):
        ir = rng.standard_normal(Lr) * np.exp(-tt / rt)
        ir[: int(SR * 0.02)] *= np.linspace(0, 1, int(SR * 0.02))
        sp = np.fft.rfft(ir) * (1.0 / (1.0 + (fq / 5500.0) ** 2))      # amortigua agudos de la cola
        ir = np.fft.irfft(sp, Lr); ir /= np.sqrt(np.sum(ir ** 2))
        wet[:, ch] = np.fft.irfft(np.fft.rfft(sig[:, ch], m) * np.fft.rfft(ir, m), m)[:n]
    return wet


def octave_up(x):
    """Shimmer barato: copia una octava arriba (lectura al doble de velocidad)."""
    n = x.shape[0]; idx = np.arange(0, n, 2.0)
    out = np.zeros_like(x)
    for ch in range(2):
        out[: len(idx), ch] = np.interp(idx, np.arange(n), x[:, ch])
    return out


def render(variant, kind):
    dry, sh, L = VARIANTS[variant](kind)
    send = dry + 0.35 * octave_up(sh)
    wet = reverb(send, rt=0.55, length=2.2)
    out = dry + 0.55 * wet
    # leve ensanchamiento estéreo (mid/side)
    mid = (out[:, 0] + out[:, 1]) / 2; side = (out[:, 0] - out[:, 1]) / 2 * 1.25
    out = np.stack([mid + side, mid - side], axis=1)
    fi = int(SR * 0.004); out[:fi] *= np.linspace(0, 1, fi)[:, None]
    fo = int(SR * 0.35); out[-fo:] *= (np.linspace(1, 0, fo) ** 2)[:, None]   # cola muerta antes del final: bucle limpio
    return out


def lufs(path):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True)
    return float(re.findall(r'I:\s+(-?\d+\.?\d*) LUFS', r.stderr)[-1])


def write(path_base, sig, target_lufs):
    sig = sig / np.max(np.abs(sig)) * 0.7
    wav = path_base + '.wav'

    def dump(x):
        pcm = (np.clip(x, -1, 1) * 32767).astype('<i2')
        with wave.open(wav, 'wb') as w:
            w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
    dump(sig)
    sig = sig * 10 ** ((target_lufs - lufs(wav)) / 20)
    if np.max(np.abs(sig)) > 0.89:                     # limitador suave: pico máx ≈ -1 dBFS
        sig = np.tanh(sig / 0.89 * 0.9) / np.tanh(0.9) * 0.89
    dump(sig)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '64k',
                    '-write_xing', '0', path_base + '.mp3'], check=True)
    os.remove(wav)


def js_synth(variant):
    def fmt(c):
        ln, notes = c
        return '{len:%s,notes:[%s]}' % (ln, ','.join('[%s,%.2f,%.2f]' % (('%.2f' % nf(n)).rstrip('0').rstrip('.'), t0, d) for n, t0, d in notes))
    v = FALLBACK[variant]
    return 'const DC_RING_SYNTH={in:%s,out:%s};' % (fmt(v['in']), fmt(v['out']))


if __name__ == '__main__':
    args = sys.argv[1:]
    if args and args[0] == '--print-js':
        print(js_synth(args[1])); sys.exit(0)
    out = args[0] if args else '.'
    default = args[args.index('--default') + 1] if '--default' in args else None
    os.makedirs(out, exist_ok=True)
    for v in VARIANTS:
        write(os.path.join(out, 'ring-in-' + v), render(v, 'in'), -17.0)
        write(os.path.join(out, 'ring-out-' + v), render(v, 'out'), -22.0)
    if default:
        shutil.copyfile(os.path.join(out, 'ring-in-%s.mp3' % default), os.path.join(out, 'ring-in.mp3'))
        shutil.copyfile(os.path.join(out, 'ring-out-%s.mp3' % default), os.path.join(out, 'ring-out.mp3'))
    print('ok')
