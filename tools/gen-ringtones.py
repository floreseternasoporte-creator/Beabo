#!/usr/bin/env python3
"""Genera los timbres de llamada ORIGINALES de Drex (entrante y saliente).

Síntesis propia con numpy (sin muestras ni audio de terceros): campana de vidrio
suave (fundamental + armónico 2 + parcial inarmónico muy corto), eco ping-pong
ligero y reverb sintética. Cada archivo es UN ciclo del bucle y termina en
silencio, para que el bucle no tenga cortes ni chasquidos.

Uso:  python3 tools/gen-ringtones.py [carpeta_salida]   (requiere numpy y ffmpeg)
Salida: <carpeta>/ring-in.mp3 y <carpeta>/ring-out.mp3
La melodía de respaldo de index.html (DC_RING_IN / DC_RING_OUT) usa las mismas notas.
"""
import subprocess, sys, wave, os
import numpy as np

SR = 44100
# nota -> frecuencia (Hz), afinación 440
F = {'A4': 440.00, 'B4': 493.88, 'D5': 587.33, 'E5': 659.25, 'F#5': 739.99, 'G#5': 830.61, 'A5': 880.00, 'B5': 987.77}

# [nota, inicio s, duración s, nivel 0..1]
IN_NOTES = [
    ('A4', 0.10, 0.9, 0.80), ('D5', 0.32, 0.9, 0.85), ('F#5', 0.54, 0.9, 0.90), ('E5', 0.76, 1.5, 0.85),
    ('B4', 1.80, 0.9, 0.80), ('E5', 2.02, 0.9, 0.85), ('F#5', 2.24, 0.9, 0.90), ('A5', 2.46, 1.7, 0.95),
]
IN_LEN = 4.6          # s, ciclo completo del bucle (incluye la pausa)
OUT_NOTES = [
    ('D5', 0.10, 1.0, 0.75), ('A5', 0.40, 1.4, 0.70),
    ('D5', 1.90, 1.0, 0.55), ('F#5', 2.20, 1.4, 0.55),
]
OUT_LEN = 4.0


def bell(freq, dur, level):
    n = int(SR * (dur + 1.2))
    t = np.arange(n) / SR
    env_main = np.exp(-t / 0.50)
    env_2 = np.exp(-t / 0.22)
    env_hi = np.exp(-t / 0.045)
    x = np.sin(2 * np.pi * freq * t) * env_main
    x += 0.22 * np.sin(2 * np.pi * freq * 2.0 * t) * env_2
    x += 0.07 * np.sin(2 * np.pi * freq * 5.43 * t) * env_hi
    att = int(SR * 0.006)
    x[:att] *= np.linspace(0, 1, att)
    rel = int(SR * 0.25)
    x[-rel:] *= np.linspace(1, 0, rel)
    return level * x


def render(notes, length):
    n = int(SR * length)
    dry = np.zeros((n, 2))
    for i, (name, t0, dur, lv) in enumerate(notes):
        x = bell(F[name], dur, lv)
        s = int(SR * t0)
        e = min(n, s + len(x))
        pan = 0.42 + 0.16 * (i % 2)                  # ligero vaivén estéreo
        dry[s:e, 0] += x[:e - s] * np.cos(pan * np.pi / 2)
        dry[s:e, 1] += x[:e - s] * np.sin(pan * np.pi / 2)
    # eco ping-pong suave
    d = int(SR * 0.23)
    echo = np.zeros_like(dry)
    for k in range(1, 4):
        g = 0.30 ** k
        o = d * k
        if o >= n: break
        echo[o:, (k) % 2] += dry[:n - o, (k - 1) % 2] * g
        echo[o:, (k + 1) % 2] += dry[:n - o, (k) % 2] * 0.0
    sig = dry + echo
    # reverb sintética corta (ruido con caída exponencial, decorrelado L/R)
    rng = np.random.default_rng(7)
    L = int(SR * 1.0)
    tt = np.arange(L) / SR
    wet = np.zeros_like(sig)
    for ch in range(2):
        ir = rng.standard_normal(L) * np.exp(-tt / 0.28)
        ir[: int(SR * 0.012)] *= np.linspace(0, 1, int(SR * 0.012))
        ir /= np.sqrt(np.sum(ir ** 2))
        m = 1 << int(np.ceil(np.log2(n + L)))
        conv = np.fft.irfft(np.fft.rfft(sig[:, ch], m) * np.fft.rfft(ir, m), m)[:n]
        wet[:, ch] = conv
    out = sig + 0.20 * wet
    # inicio y final en silencio: bucle sin chasquidos
    fi = int(SR * 0.004); out[:fi] *= np.linspace(0, 1, fi)[:, None]
    fo = int(SR * 0.08); out[-fo:] *= np.linspace(1, 0, fo)[:, None]
    return out


def write(path_base, sig, peak_db):
    sig = sig / np.max(np.abs(sig)) * (10 ** (peak_db / 20))
    pcm = (sig * 32767).astype('<i2')
    wav = path_base + '.wav'
    with wave.open(wav, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '64k',
                    '-write_xing', '0', path_base + '.mp3'], check=True)
    os.remove(wav)


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else '.'
    os.makedirs(out, exist_ok=True)
    write(os.path.join(out, 'ring-in'), render(IN_NOTES, IN_LEN), -3.0)
    write(os.path.join(out, 'ring-out'), render(OUT_NOTES, OUT_LEN), -8.0)
    print('ok')
