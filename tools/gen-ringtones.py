#!/usr/bin/env python3
"""Genera los timbres de llamada ORIGINALES de Drex (entrante y saliente).

Síntesis propia con numpy (sin muestras ni audio de terceros). Hay 3 variantes con el
mismo carácter "app de mensajería" (motivo corto, percusivo y rápido, repetido en dos
pulsos con pausa), pero distinto instrumento:

  A  piano eléctrico  (FM tipo "keyboard piano")  <- por defecto
  B  marimba          (madera, saltarina)
  C  pluck sintético  (trino de tercera mayor, estilo teléfono)

Cada archivo es UN ciclo del bucle y empieza/termina en silencio (bucle sin cortes).

Uso:
  python3 tools/gen-ringtones.py OUT_DIR                  # genera ring-in-A/B/C.mp3 y ring-out-A/B/C.mp3
  python3 tools/gen-ringtones.py OUT_DIR --default A      # además copia esa variante a ring-in.mp3 / ring-out.mp3
  python3 tools/gen-ringtones.py --print-js A             # imprime DC_RING_SYNTH (respaldo de index.html) de la variante

Para CAMBIAR la variante de la app: copia ring-in-X.mp3 / ring-out-X.mp3 sobre assets/audio/ring-in.mp3 /
ring-out.mp3 (o usa --default X) y pega el resultado de --print-js X en `const DC_RING_SYNTH=` de index.html
(y copia index.html a 404.html; sube DREX_SW_VERSION).
Requiere numpy y ffmpeg.
"""
import json, os, re, shutil, subprocess, sys, wave
import numpy as np

SR = 44100
_SEMI = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def nf(name):
    m = re.match(r'^([A-G])(#?)(\d)$', name)
    midi = 12 * (int(m.group(3)) + 1) + _SEMI[m.group(1)] + (1 if m.group(2) else 0)
    return 440.0 * 2 ** ((midi - 69) / 12)


def seq(names, t0, step, hold, lv=0.9, accent=1.0):
    """Arpegio rápido: cada nota dura `step`+cola, la última se sostiene `hold`."""
    out = []
    for i, n in enumerate(names):
        last = i == len(names) - 1
        out.append((n, t0 + i * step, hold if last else step * 5, lv * (accent if last else 1.0) * (0.9 + 0.1 * (i % 2))))
    return out


# ---------------------------------------------------------------- timbres
def tone_epiano(f, dur):
    n = int(SR * (dur + 0.6)); t = np.arange(n) / SR
    idx = 1.6 * np.exp(-t / 0.18)                       # brillo inicial que se apaga (tipo Rhodes)
    body = np.sin(2 * np.pi * f * t + idx * np.sin(2 * np.pi * f * t)) * np.exp(-t / 0.24)
    bell = 0.18 * np.sin(2 * np.pi * f * 14 * t) * np.exp(-t / 0.025)   # "tine" del ataque
    return body + bell


def tone_marimba(f, dur):
    n = int(SR * (dur + 0.4)); t = np.arange(n) / SR
    x = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.20)
    x += 0.38 * np.sin(2 * np.pi * f * 4.0 * t) * np.exp(-t / 0.035)
    x += 0.10 * np.sin(2 * np.pi * f * 9.2 * t) * np.exp(-t / 0.015)
    rng = np.random.default_rng(int(f))
    th = int(SR * 0.006)
    x[:th] += 0.12 * rng.standard_normal(th) * np.linspace(1, 0, th)    # golpe de maza
    return x


def tone_pluck(f, dur):
    n = int(SR * (dur + 0.6)); t = np.arange(n) / SR
    x = np.zeros(n)
    for h in range(1, 9):
        if f * h > 9000: break
        x += (1.0 / h) * np.sin(2 * np.pi * f * h * t) * np.exp(-t / (0.26 / (h ** 0.9)))
    return 0.9 * x


TONES = {'A': tone_epiano, 'B': tone_marimba, 'C': tone_pluck}

VARIANTS = {
    'A': {  # piano eléctrico: dos pulsos rápidos, arpegio que sube, salta alto y cae
        'in': dict(len=3.2, notes=seq(['C#5', 'E5', 'B5', 'G#5'], 0.08, 0.085, 0.55) + seq(['C#5', 'F#5', 'B5', 'A5'], 0.74, 0.085, 0.95, accent=1.0)),
        'out': dict(len=3.6, notes=seq(['G#4', 'C#5', 'E5'], 0.10, 0.14, 0.9, lv=0.8) + seq(['G#4', 'C#5', 'E5'], 1.80, 0.14, 1.1, lv=0.55))},
    'B': {  # marimba: motivo saltarín en pentatónica de Sol
        'in': dict(len=3.0, notes=seq(['D5', 'G5', 'B5', 'D6'], 0.08, 0.09, 0.45) + seq(['D5', 'G5', 'A5', 'B5', 'D6'], 0.70, 0.075, 0.8)),
        'out': dict(len=3.4, notes=seq(['G5', 'B5'], 0.10, 0.20, 0.8, lv=0.8) + seq(['G5', 'D6'], 1.60, 0.20, 1.0, lv=0.55))},
    'C': {  # pluck sintético: trino de tercera mayor (como teléfono antiguo) que resuelve hacia arriba
        'in': dict(len=3.4, notes=seq(['G5', 'B5', 'G5', 'B5', 'G5', 'B5', 'D6'], 0.08, 0.07, 0.5) + seq(['G5', 'B5', 'G5', 'B5', 'G5', 'B5', 'E6'], 0.98, 0.07, 0.9)),
        'out': dict(len=3.8, notes=seq(['B4', 'D5', 'B4', 'D5', 'G5'], 0.10, 0.12, 0.9, lv=0.8) + seq(['B4', 'D5', 'B4', 'D5', 'B5'], 1.90, 0.12, 1.1, lv=0.55))},
}


def render(variant, kind):
    cfg = VARIANTS[variant][kind]
    tone = TONES[variant]
    length = cfg['len']
    n = int(SR * length)
    dry = np.zeros((n, 2))
    for i, (name, t0, dur, lv) in enumerate(cfg['notes']):
        x = tone(nf(name), dur)
        rel = int(SR * min(0.25, dur * 0.4)); x[-rel:] *= np.linspace(1, 0, rel)
        att = int(SR * 0.002); x[:att] *= np.linspace(0, 1, att)
        s = int(SR * t0); e = min(n, s + len(x))
        pan = 0.36 + 0.28 * ((i * 3) % 5) / 4.0          # reparte las notas en el estéreo
        dry[s:e, 0] += lv * x[:e - s] * np.cos(pan * np.pi / 2)
        dry[s:e, 1] += lv * x[:e - s] * np.sin(pan * np.pi / 2)
    # eco corto
    d = int(SR * 0.16)
    echo = np.zeros_like(dry)
    echo[d:, 0] += dry[:n - d, 1] * 0.22; echo[d:, 1] += dry[:n - d, 0] * 0.22
    echo[2 * d:, 0] += dry[:n - 2 * d, 0] * 0.08; echo[2 * d:, 1] += dry[:n - 2 * d, 1] * 0.08
    sig = dry + echo
    # reverb breve
    rng = np.random.default_rng(7)
    L = int(SR * 0.7); tt = np.arange(L) / SR
    wet = np.zeros_like(sig)
    for ch in range(2):
        ir = rng.standard_normal(L) * np.exp(-tt / 0.18)
        ir[: int(SR * 0.008)] *= np.linspace(0, 1, int(SR * 0.008))
        ir /= np.sqrt(np.sum(ir ** 2))
        m = 1 << int(np.ceil(np.log2(n + L)))
        wet[:, ch] = np.fft.irfft(np.fft.rfft(sig[:, ch], m) * np.fft.rfft(ir, m), m)[:n]
    out = sig + 0.14 * wet
    fi = int(SR * 0.003); out[:fi] *= np.linspace(0, 1, fi)[:, None]
    fo = int(SR * 0.08); out[-fo:] *= np.linspace(1, 0, fo)[:, None]
    return out


def lufs(path):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True)
    m = re.findall(r'I:\s+(-?\d+\.?\d*) LUFS', r.stderr)
    return float(m[-1])


def write(path_base, sig, target_lufs):
    sig = sig / np.max(np.abs(sig)) * 0.7
    wav = path_base + '.wav'

    def dump(x):
        pcm = (np.clip(x, -1, 1) * 32767).astype('<i2')
        with wave.open(wav, 'wb') as w:
            w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
    dump(sig)
    gain = 10 ** ((target_lufs - lufs(wav)) / 20)
    sig = sig * gain
    peak = np.max(np.abs(sig))
    if peak > 0.89:                                    # limitador suave: pico máx ≈ -1 dBFS
        sig = np.tanh(sig / 0.89 * 0.9) / np.tanh(0.9) * 0.89
    dump(sig)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '64k',
                    '-write_xing', '0', path_base + '.mp3'], check=True)
    os.remove(wav)


def js_synth(variant):
    def fmt(cfg):
        notes = ','.join('[%s,%.2f,%.2f]' % (('%.2f' % nf(n)).rstrip('0').rstrip('.'), t0, dur) for n, t0, dur, _ in cfg['notes'])
        return '{len:%s,notes:[%s]}' % (cfg['len'], notes)
    v = VARIANTS[variant]
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
