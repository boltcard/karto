"""Karto PoS's Paid chime: the app's own sound, made here so no file of anyone else's
is shipped. Two soft bell notes a fourth apart, each a sine with two quieter overtones and a fast decay, 0.6 s in
all. Writes app/assets/pos/paid.wav (mono, 16-bit, 44.1 kHz); the same bytes on every run.
Run: python3 app/scripts/chime.py
"""
import math
import pathlib
import struct
import wave

RATE = 44_100
OUT = pathlib.Path(__file__).resolve().parent.parent / 'assets' / 'pos' / 'paid.wav'


def note(freq: float, start: float, length: float, total: int) -> list[float]:
    out = [0.0] * total
    for i in range(int(length * RATE)):
        t = i / RATE
        # A short attack so the note doesn't click, then a decay like a struck bell's.
        env = min(1.0, t / 0.004) * math.exp(-t * 9.0)
        tone = math.sin(2 * math.pi * freq * t) + 0.35 * math.sin(2 * math.pi * 2 * freq * t) + 0.12 * math.sin(2 * math.pi * 3 * freq * t)
        n = int(start * RATE) + i
        if n < total:
            out[n] += env * tone
    return out


total = int(0.6 * RATE)
first = note(1318.51, 0.0, 0.6, total)   # E6
second = note(1760.0, 0.11, 0.49, total)  # A6
mix = [a + b for a, b in zip(first, second)]
peak = max(abs(x) for x in mix)
frames = b''.join(struct.pack('<h', int(x / peak * 0.8 * 32767)) for x in mix)
with wave.open(str(OUT), 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(frames)
print(f'{OUT.name}: {len(frames)} bytes of sound')
