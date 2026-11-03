"""Synthetic tempo signals for the therapy estimator tests (Phase B, B4).

The expected values in test_tempo_wide.py were measured on exactly these generators, so
they are copied verbatim, seeds included, from the B4 prototype suites:
  - bench.py: click_train, piano, psytrance, ambient and their helpers;
  - skeptic-rhythmic-modern/rm_signals.py: metronome, heartbeat_drum, house and helpers;
  - skeptic-rhythmic-modern/rm_probe.py: pop_68;
  - skeptic-slow-acoustic/slow_acoustic.py: g_lull68_piano, g_lull34_piano_voice, build.
Names that collide between the suites are prefixed (rm_piano, rm_reverb, sa_piano,
sa_reverb, _sa_place); the code is otherwise unchanged. The case builders at the end turn
a measured case name into its signal exactly as each suite's runner did.

Synthetic only (numpy plus scipy.signal): no real audio is read.
"""
from __future__ import annotations

import zlib
from functools import lru_cache

import numpy as np
from scipy.signal import butter, fftconvolve, lfilter, sosfilt

SR = 22050


# ======================================================================
# From bench.py

def _seed(name: str) -> int:
    return zlib.crc32(name.encode("utf-8"))


def _place(buf: np.ndarray, sound: np.ndarray, at: float, gain: float = 1.0) -> None:
    start = int(round(at * SR))
    if start >= buf.size or start < 0:
        return
    end = min(buf.size, start + sound.size)
    buf[start:end] += gain * sound[: end - start]


def _finish(buf: np.ndarray) -> np.ndarray:
    peak = float(np.max(np.abs(buf)))
    if peak > 0:
        buf = buf * (0.9 / peak)
    return buf.astype(np.float32)


def _beat_times(bpm: float, seconds: float, jitter: float = 0.0, rng=None) -> np.ndarray:
    period = 60.0 / bpm
    times, t = [], 0.05
    while t < seconds:
        times.append(t)
        step = period * (1.0 + (rng.uniform(-jitter, jitter) if jitter else 0.0))
        t += step
    return np.asarray(times)


def _click(rng) -> np.ndarray:
    n = int(0.012 * SR)
    t = np.arange(n) / SR
    env = np.exp(-t / 0.003)
    return (0.6 * np.sin(2 * np.pi * 1500 * t) + 0.4 * rng.standard_normal(n)) * env


def _piano_note(freq: float, dur: float, attack: float, tau: float) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    tone = np.zeros(n)
    for k in range(1, 7):
        fk = freq * k * np.sqrt(1 + 0.0004 * k * k)   # slight inharmonicity
        if fk >= SR / 2:
            break
        tone += np.sin(2 * np.pi * fk * t) / k ** 1.5 * np.exp(-t * k * 0.4 / tau)
    env = np.minimum(t / attack, 1.0) * np.exp(-t / tau)   # soft (linear) attack
    return tone * env


def _kick() -> np.ndarray:
    n = int(0.30 * SR)
    t = np.arange(n) / SR
    freq = 50 + 110 * np.exp(-t / 0.03)
    phase = 2 * np.pi * np.cumsum(freq) / SR
    return np.sin(phase) * np.exp(-t / 0.12) * np.minimum(t / 0.001, 1)


def _bass(freq: float, dur: float) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    saw = sum(np.sin(2 * np.pi * freq * k * t) / k for k in range(1, 8))
    return saw * np.minimum(t / 0.003, 1) * np.exp(-t / 0.035)


def click_train(bpm: float, seconds: float = 60.0, seed: int = 0, jitter: float = 0.0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    buf = np.zeros(int(seconds * SR))
    click = _click(rng)
    for t in _beat_times(bpm, seconds, jitter, rng):
        _place(buf, click, t)
    return _finish(buf)


_PROGRESSION = (  # I - vi - IV - V in C, one chord per bar
    (261.63, 329.63, 392.00),
    (220.00, 261.63, 329.63),
    (174.61, 220.00, 261.63),
    (196.00, 246.94, 293.66),
)


def piano(bpm: float, seconds: float = 60.0, seed: int = 0) -> np.ndarray:
    """Soft-attack piano chord on every beat, quieter eighth-note arpeggio
    notes between beats, and a sustained pad underneath."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    buf = np.zeros(n)
    period = 60.0 / bpm
    for i, t in enumerate(_beat_times(bpm, seconds)):
        chord = _PROGRESSION[(i // 4) % 4]
        vel = 0.8 + 0.1 * rng.uniform(-1, 1)
        for f in chord:
            _place(buf, _piano_note(f, 2.5, attack=0.035, tau=0.9), t, vel / 3)
        arp = chord[i % 3] * 2                                  # off-beat, an octave up
        _place(buf, _piano_note(arp, 1.2, attack=0.025, tau=0.35), t + period / 2, 0.15 * vel)
    t = np.arange(n) / SR
    pad = sum(np.sin(2 * np.pi * f * t + rng.uniform(0, 2 * np.pi)) for f in (65.41, 98.00, 130.81, 196.00))
    pad *= 0.06 * (0.8 + 0.2 * np.sin(2 * np.pi * 0.07 * t))
    return _finish(buf + pad * np.minimum(t / 3.0, 1.0))


def psytrance(bpm: float, seconds: float = 60.0, seed: int = 0) -> np.ndarray:
    """Four-on-the-floor kick, bass on the three off-beat 16ths of each beat."""
    del seed  # fully deterministic without noise
    buf = np.zeros(int(seconds * SR))
    kick = _kick()
    sixteenth = 60.0 / bpm / 4
    bass = _bass(55.0, sixteenth * 0.95)
    for t in _beat_times(bpm, seconds):
        _place(buf, kick, t, 1.0)
        for k in (1, 2, 3):
            _place(buf, bass, t + k * sixteenth, 0.45)
    return _finish(buf)


def ambient(seconds: float = 60.0, seed: int = 0) -> np.ndarray:
    """Slowly evolving pad, no percussive onsets (no tempo)."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for f in (110.0, 164.81, 220.0, 277.18, 329.63, 440.0):
        detune = rng.uniform(-0.4, 0.4)
        lfo = 0.5 + 0.5 * np.sin(2 * np.pi * rng.uniform(0.02, 0.09) * t + rng.uniform(0, 2 * np.pi))
        out += lfo * np.sin(2 * np.pi * (f + detune) * t + rng.uniform(0, 2 * np.pi)) / (1 + f / 220)
    # slowly breathing low-passed noise (one-pole), no transients
    smooth = lfilter([0.02], [1.0, -0.98], rng.standard_normal(n))
    out += 0.3 * smooth * (0.5 + 0.5 * np.sin(2 * np.pi * 0.03 * t))
    return _finish(out * np.minimum(t / 4.0, 1.0))


# ======================================================================
# From skeptic-rhythmic-modern/rm_signals.py

TWO_PI = 2 * np.pi


def seed_of(name: str) -> int:
    return zlib.crc32(name.encode("utf-8"))


def T(d: float) -> np.ndarray:
    return np.arange(int(d * SR)) / SR


@lru_cache(None)
def _sos(kind: str, f1: float, f2: float | None, order: int):
    if kind == "band":
        return butter(order, [f1, f2], btype="band", fs=SR, output="sos")
    return butter(order, f1, btype=kind, fs=SR, output="sos")


def hp(x, f, o=2):
    return sosfilt(_sos("high", float(f), None, o), x)


def lp(x, f, o=2):
    return sosfilt(_sos("low", float(f), None, o), x)


def bp(x, f1, f2, o=2):
    return sosfilt(_sos("band", float(f1), float(f2), o), x)


def ramp(t, a):
    return np.minimum(t / a, 1.0)


def norm(x):
    p = float(np.max(np.abs(x)))
    return x / p if p > 0 else x


def place(buf, s, t, g=1.0):
    i = int(round(t * SR))
    if i < 0 or i >= buf.size:
        return
    e = min(buf.size, i + s.size)
    buf[i:e] += g * s[: e - i]


def db(x):
    return 10 ** (x / 20)


def release(x, r=0.02):
    m = min(x.size, int(r * SR))
    if m > 1:
        x[-m:] *= np.linspace(1, 0, m)
    return x


def sweep_sine(f, t):
    return np.sin(TWO_PI * np.cumsum(f) / SR)


def kick_acoustic(rng):
    t = T(0.45)
    body = sweep_sine(50 + 85 * np.exp(-t / 0.035), t) * np.exp(-t / 0.16)
    beater = hp(rng.standard_normal(t.size), 1500) * np.exp(-t / 0.004) * 0.35
    return norm((body + beater) * ramp(t, 0.0007))


def kick_house(rng):
    t = T(0.38)
    body = sweep_sine(48 + 150 * np.exp(-t / 0.02), t) * np.exp(-t / 0.17)
    click = hp(rng.standard_normal(t.size), 2500) * np.exp(-t / 0.002) * 0.3
    return norm(np.tanh(1.3 * (body + click)) * ramp(t, 0.0005))


def snare(rng, tone=190.0, wires=0.16, room=0.0):
    t = T(0.5)
    body = (np.sin(TWO_PI * tone * t) + 0.6 * np.sin(TWO_PI * tone * 1.74 * t)) * np.exp(-t / 0.05) * 0.6
    w = hp(rng.standard_normal(t.size), 1800) * np.exp(-t / wires) * 0.8
    snap = hp(rng.standard_normal(t.size), 4000) * np.exp(-t / 0.006) * 0.5
    x = body + w + snap
    if room:
        x += room * lp(rng.standard_normal(t.size), 3000) * np.exp(-t / 0.18) * ramp(t, 0.01)
    return norm(x * ramp(t, 0.0005))


def rim(rng):
    t = T(0.08)
    x = (0.7 * np.sin(TWO_PI * 1650 * t) * np.exp(-t / 0.012) + 0.5 * np.sin(TWO_PI * 520 * t) * np.exp(-t / 0.02)
         + 0.4 * hp(rng.standard_normal(t.size), 2000) * np.exp(-t / 0.002))
    return norm(x)


def clap(rng):
    t = T(0.3)
    n = hp(rng.standard_normal(t.size), 900)
    env = np.zeros(t.size)
    for off in (0.0, 0.009, 0.019, 0.027):
        env += np.exp(-np.clip(t - off, 0, None) / 0.005) * (t >= off)
    env += 0.45 * np.exp(-np.clip(t - 0.027, 0, None) / 0.09) * (t >= 0.027)
    return norm(bp(n, 900, 6000) * env)


_HAT_F = (317.0, 465.0, 541.0, 731.0, 876.0, 1046.0)


def hat(rng, decay=0.035):
    t = T(max(0.08, decay * 6))
    metal = sum(np.sign(np.sin(TWO_PI * f * 2.3 * t + rng.uniform(0, TWO_PI))) for f in _HAT_F) / 6
    x = hp(0.6 * metal + 0.6 * rng.standard_normal(t.size), 6000, 4)
    return norm(x * np.exp(-t / decay) * ramp(t, 0.0005))


def shaker(rng, decay=0.03):
    t = T(0.14)
    x = bp(rng.standard_normal(t.size), 3500, 9000)
    return norm(x * (1 - np.exp(-t / 0.004)) * np.exp(-t / decay))


def woodblock(rng, f0=1800.0, decay=0.025):
    t = T(0.12)
    x = np.sin(TWO_PI * f0 * t) * np.exp(-t / decay) + 0.45 * np.sin(TWO_PI * 2.71 * f0 * t) * np.exp(-t / (decay * 0.5))
    x[: int(0.002 * SR)] += 0.3 * rng.standard_normal(int(0.002 * SR))
    return norm(x * ramp(t, 0.0003))


def doum(rng):
    t = T(0.65)
    x = sweep_sine(88 * (1 + 0.12 * np.exp(-t / 0.04)), t) * np.exp(-t / 0.3)
    x += 0.4 * np.sin(TWO_PI * 176.5 * t) * np.exp(-t / 0.12) + 0.2 * lp(rng.standard_normal(t.size), 800) * np.exp(-t / 0.01)
    return norm(x * ramp(t, 0.001))


def chord(fn, freqs, rng, strum=0.012, **kw):
    parts = [fn(f, **kw) for f in freqs]
    n = max(p.size for p in parts) + int(strum * SR) + 1
    out = np.zeros(n)
    for p in parts:
        o = int(rng.uniform(0, strum) * SR)
        out[o:o + p.size] += p
    return out / len(freqs)


def rm_piano(f, dur=2.0, vel=0.7):
    t = T(dur)
    x = np.zeros(t.size)
    for k in range(1, 9):
        fk = f * k * np.sqrt(1 + 0.0003 * k * k)
        if fk > SR / 2 - 800:
            break
        x += np.sin(TWO_PI * fk * t) / k ** (1.4 - 0.3 * vel) * np.exp(-t * (0.7 + 0.45 * k))
    return release(x * ramp(t, 0.003), 0.1)


def power_chord(f, dur, rng, mute=True):
    t = T(dur)
    x = np.zeros(t.size)
    for r in (1.0, 1.5, 2.0):
        for k in range(1, 16):
            if f * r * k > 7000:
                break
            x += np.sin(TWO_PI * f * r * k * t + rng.uniform(0, TWO_PI)) / k
    x = np.tanh(4 * x / 3) * 0.6
    x = lp(x, 3500) * ramp(t, 0.002) * np.exp(-t / (0.09 if mute else 0.7))
    return release(x, 0.015)


def organ(freqs, dur):
    t = T(dur)
    x = sum(w * np.sin(TWO_PI * f * k * t) for f in freqs for k, w in ((1, 1), (2, 0.8), (3, 0.5), (4, 0.3), (6, 0.2)) if f * k < 9000)
    return release(x * ramp(t, 0.005), 0.015) / len(freqs)


def bass_finger(f, dur, vel=1.0):
    t = T(dur + 0.04)
    x = (np.sin(TWO_PI * f * t) + 0.5 * np.sin(2 * TWO_PI * f * t) + 0.25 * np.sin(3 * TWO_PI * f * t)
         + 0.1 * np.sin(4 * TWO_PI * f * t))
    return release(x * ramp(t, 0.004) * np.exp(-t / 0.7) * vel, 0.04)


def bass_synth(f, dur):
    t = T(dur)
    x = sum(np.sin(TWO_PI * f * k * t) / k for k in range(1, 16) if f * k < 6000)
    return release(lp(x, 450) * ramp(t, 0.003) * np.exp(-t / 0.4), 0.02)


def sub_bass(f, dur):
    t = T(dur)
    return release(np.sin(TWO_PI * f * t) * ramp(t, 0.006) * np.exp(-t / 0.9), 0.04)


def pad(n, segments, rng, cutoff=1400.0):
    """Continuous detuned-saw pad; segments = [(start_s, freqs)]; 0.4 s crossfades."""
    out = np.zeros(n)
    tt = np.arange(n) / SR
    for i, (s, freqs) in enumerate(segments):
        e = segments[i + 1][0] if i + 1 < len(segments) else n / SR
        a, b = int(max(0, s - 0.2) * SR), int(min(n / SR, e + 0.2) * SR)
        if b <= a:
            continue
        t = tt[a:b]
        seg = np.zeros(b - a)
        for f in freqs:
            for det in (-0.004, 0.004):
                for k in range(1, 8):
                    seg += np.sin(TWO_PI * f * (1 + det) * k * t + rng.uniform(0, TWO_PI)) / k
        w = np.minimum(1, np.minimum((t - t[0]) / 0.4, (t[-1] - t) / 0.4 + 1e-9))
        out[a:b] += seg * np.clip(w, 0, 1) / len(freqs)
    return lp(out, cutoff)


def rm_reverb(x, rng, rt60=1.2, wet=0.25, lpf=4000.0):
    t = T(rt60)
    ir = lp(rng.standard_normal(t.size), lpf) * np.exp(-6.9 * t / rt60)
    ir[: int(0.012 * SR)] = 0  # pre-delay
    w = fftconvolve(x, ir)[: x.size]
    rx, rw = np.sqrt(np.mean(x ** 2)) + 1e-12, np.sqrt(np.mean(w ** 2)) + 1e-12
    return x + wet * w * rx / rw


def sidechain(x, kick_times, depth=0.55, rel=0.16):
    g = np.ones(x.size)
    m = int(4 * rel * SR)
    curve = 1 - depth * np.exp(-np.arange(m) / (rel * SR))
    for kt in kick_times:
        i = int(round(kt * SR))
        if 0 <= i < x.size:
            e = min(x.size, i + m)
            g[i:e] = np.minimum(g[i:e], curve[: e - i])
    return x * g


def master(x, rng, lpf=None, noise_db=-62.0, drive=1.2):
    x = norm(x)
    if lpf:
        x = lp(x, lpf)
    x = np.tanh(drive * norm(x)) / np.tanh(drive)
    x = x + db(noise_db) * lp(rng.standard_normal(x.size), 6000)
    return (0.9 * norm(x)).astype(np.float32)


def beat_grid(bpm, seconds, rng=None, start=0.12, drift=0.0, drift_period=23.0):
    """Beat onset times and the local beat period; drift = +- fraction of slow sinusoidal
    tempo wander (live band). The tempo's mean equals bpm."""
    phi = rng.uniform(0, TWO_PI) if (drift and rng is not None) else 0.0
    times, periods, t = [], [], start
    while t < seconds + 3:
        local = bpm * (1 + drift * np.sin(TWO_PI * t / drift_period + phi))
        p = 60.0 / local
        times.append(t)
        periods.append(p)
        t += p
    return np.asarray(times), np.asarray(periods)


def seq(buf, B, P, pattern, sound, rng, spb=4, bpb=4, swing=0.5, hum=0.01, lag=0.0,
        bars=None, prob=1.0, vj=0.12, gain=1.0, out_times=None):
    """Place `sound(rng)` on a step pattern [(step_in_bar, velocity)]. spb steps per beat,
    bpb beats per bar. swing (0.5 = straight) delays the odd step of each pair (spb 2 or 4).
    hum = uniform timing jitter as a fraction of the local beat period; lag in seconds."""
    nbars = len(B) // bpb
    for bar in range(nbars):
        if bars is not None and not bars(bar):
            continue
        for step, v in pattern:
            beat = bar * bpb + step // spb
            if beat >= len(B):
                break
            s = step % spb
            frac = s / spb
            if swing != 0.5 and spb in (2, 4) and s % 2 == 1:
                frac = (s - 1) / spb + 2 * swing / spb
            if prob < 1 and rng.random() > prob:
                continue
            t = B[beat] + frac * P[beat] + rng.uniform(-hum, hum) * P[beat] + lag
            place(buf, sound(rng), t, gain * v * (1 + rng.uniform(-vj, vj)))
            if out_times is not None:
                out_times.append(t)


def bar_starts(B, bpb):
    return [(B[i], i // bpb) for i in range(0, len(B), bpb)]


POP = ((261.63, 329.63, 392.0), (196.0, 246.94, 293.66), (220.0, 261.63, 329.63), (174.61, 220.0, 261.63))  # C G Am F


MINOR = ((220.0, 261.63, 329.63), (196.0, 246.94, 293.66), (174.61, 220.0, 261.63), (164.81, 207.65, 246.94))  # Am G F E


def metronome(bpm, seconds, seed, every=4, sub=1, accent_db=6.0):
    """Gait-training metronome: woodblock clicks on every beat, the first of each group of
    `every` higher and louder (accent_db), optional quiet subdivision ticks (sub per beat).
    Exact timing; played into a small room (reverb) with a little background noise."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    B, P = beat_grid(bpm, seconds, rng)
    buf = np.zeros(n)
    acc, norm_click, tick = woodblock(rng, 2400.0), woodblock(rng, 1800.0), woodblock(rng, 1200.0, 0.015)
    for i, (t, p) in enumerate(zip(B, P)):
        if i % every == 0:
            place(buf, acc, t, 1.0)
        else:
            place(buf, norm_click, t, db(-accent_db))
        for k in range(1, sub):
            place(buf, tick, t + k / sub * p, db(-accent_db - 10))
    buf = rm_reverb(buf, rng, 0.5, 0.25, 5000)
    buf += db(-45) * lp(rng.standard_normal(n), 1500)
    return master(buf, rng, drive=1.0)


def heartbeat_drum(bpm, seconds, seed, dub_at=0.32):
    """Heartbeat drumming: a doum (lub) on each beat and a softer doum (dub) dub_at of a beat
    later, plus a quiet shaker on the beat."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    B, P = beat_grid(bpm, seconds, rng)
    buf = np.zeros(n)
    hum = 0.015
    for t, p in zip(B, P):
        t0 = t + rng.uniform(-hum, hum) * p
        place(buf, doum(rng), t0, 1.0)
        place(buf, doum(rng), t0 + dub_at * p * (1 + rng.uniform(-0.03, 0.03)), 0.62)
        place(buf, shaker(rng), t0, 0.08)
    return master(rm_reverb(buf, rng, 1.2, 0.3), rng)


def house(bpm, seconds, seed, style="deep"):
    """Four-on-the-floor dance. deep: clap 2/4, swung 16th shaker, off-beat open hat, organ
    chord stabs, sidechained pad, off-beat sub. tech: rolling 16th bass on steps 2-4,
    closed 16th hats. piano: house piano stabs. nudisco: octave bass on eighths, muted
    16th guitar. minimal: kick, off-beat hat, two rims. breakdown: deep with a kickless middle."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    B, P = beat_grid(bpm, seconds, rng)
    kit, hats, music, bass, padb = (np.zeros(n) for _ in range(5))
    hum = 0.003
    nbars = len(B) // 4
    kickbars = (lambda b: not (nbars * 0.4 <= b < nbars * 0.6)) if style == "breakdown" else None
    kt = []
    seq(kit, B, P, [(0, 1.0), (4, 1.0), (8, 1.0), (12, 1.0)], kick_house, rng, hum=hum, vj=0.03, bars=kickbars, out_times=kt)
    if style != "minimal":
        seq(kit, B, P, [(4, 0.8), (12, 0.85)], clap, rng, hum=hum, gain=db(-4))
    seq(hats, B, P, [(s, 0.8) for s in (2, 6, 10, 14)], lambda r: hat(r, 0.2), rng, hum=hum)
    segs = [(t0, MINOR[(bar // 2) % 4]) for t0, bar in bar_starts(B, 4)]
    if style in ("deep", "breakdown"):
        seq(hats, B, P, [(s, 0.5 if s % 2 == 0 else 0.35) for s in range(16)], shaker, rng, swing=0.6, hum=hum, gain=db(-6))
        for t0, bar in bar_starts(B, 4):
            ch = MINOR[(bar // 2) % 4]
            for s in (3, 6, 10):
                beat = bar * 4 + s // 4
                if beat < len(B):
                    place(music, organ([f * 2 for f in ch], 0.12), B[beat] + (s % 4) / 4 * P[beat], 0.8)
        seq(bass, B, P, [(s, 0.9) for s in (2, 6, 10, 14)], lambda r: sub_bass(55.0, 0.22), rng, hum=hum)
    elif style == "tech":
        seq(hats, B, P, [(s, 0.4) for s in range(16)], hat, rng, hum=hum, gain=db(-4))
        seq(bass, B, P, [(s, 0.9 if s % 4 == 2 else 0.6) for s in range(16) if s % 4], lambda r: bass_synth(55.0, 0.1), rng, hum=hum)
    elif style == "piano":
        for t0, bar in bar_starts(B, 4):
            ch = POP[bar % 4]
            for s in (0, 3, 6, 10, 12):
                beat = bar * 4 + s // 4
                if beat < len(B):
                    place(music, chord(rm_piano, [f * 2 for f in ch], rng, strum=0.003, dur=0.35, vel=0.9), B[beat] + (s % 4) / 4 * P[beat], 0.9)
        seq(bass, B, P, [(s, 0.8) for s in (2, 6, 10, 14)], lambda r: bass_synth(65.41, 0.2), rng, hum=hum)
    elif style == "nudisco":
        seq(bass, B, P, [(s, 0.9 if s % 4 == 0 else 0.8) for s in range(0, 16, 2)],
            lambda r: bass_synth(55.0 * (2 if r.random() < 0.5 else 1), 0.15), rng, hum=hum)
        seq(hats, B, P, [(s, 0.35) for s in range(16)], hat, rng, hum=hum, gain=db(-4))
        seq(music, B, P, [(s, 0.7 if s % 2 == 0 else 0.4) for s in range(16)],
            lambda r: power_chord(220.0, 0.06, r, mute=True), rng, hum=hum, prob=0.8)
    elif style == "minimal":
        seq(kit, B, P, [(7, 0.6), (13, 0.5)], rim, rng, hum=hum, gain=db(-8))
        seq(bass, B, P, [(s, 0.8) for s in (2, 10)], lambda r: sub_bass(49.0, 0.25), rng, hum=hum)
    padb = sidechain(pad(n, segs, rng, 1600), kt, 0.6, 0.16)
    bass = sidechain(bass, kt, 0.4, 0.1)
    mix = kit + db(-14) * hats + db(-10) * norm(music) + db(-6) * norm(bass) + db(-18) * norm(padb)
    return master(mix, rng, drive=2.0)


# ======================================================================
# From skeptic-rhythmic-modern/rm_probe.py

def pop_68(dq, seconds, seed, hats=True, kit_db=0.0):
    """6/8 pop ballad: kick on 1, snare on 4 (the second dotted quarter), closed hats on every
    eighth, piano arpeggio on eighths, bass on the dotted quarters, string pad."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    B, P = beat_grid(dq, seconds, rng)
    kit, hh, pno, bass = (np.zeros(n) for _ in range(4))
    hum = 0.01
    seq(kit, B, P, [(0, 1.0)], kick_acoustic, rng, spb=3, bpb=2, hum=hum)
    seq(kit, B, P, [(5, 0.5)], kick_acoustic, rng, spb=3, bpb=2, hum=hum, prob=0.3)
    seq(kit, B, P, [(3, 0.95)], lambda r: snare(r, 190, 0.17, room=0.4), rng, spb=3, bpb=2, hum=hum, gain=db(-2))
    if hats:
        seq(hh, B, P, [(s, 0.6 if s % 3 == 0 else 0.45) for s in range(6)], hat, rng, spb=3, bpb=2, hum=hum)
    segs = []
    for t0, bar in bar_starts(B, 2):
        ch = POP[(bar // 2) % 4]
        segs.append((t0, ch))
        for k, f in enumerate((ch[0] / 2, ch[1], ch[2], ch[0] * 2, ch[2], ch[1])):
            beat = bar * 2 + k // 3
            if beat < len(B):
                t = B[beat] + (k % 3) / 3 * P[beat] + rng.uniform(-hum, hum) * P[beat]
                place(pno, rm_piano(f, 1.6, 0.7), t, 0.85 if k % 3 == 0 else 0.6)
        for k in range(2):
            beat = bar * 2 + k
            if beat < len(B):
                place(bass, bass_finger(ch[0] / 4, 0.9 * 60 / dq, 0.9), B[beat], 1.0 if k == 0 else 0.8)
    strings = pad(n, segs, rng, 1800)
    mix = db(kit_db) * (rm_reverb(kit, rng, 1.2, 0.25) + db(-12) * hh) + db(-6) * norm(rm_reverb(pno, rng, 1.6, 0.3)) \
        + db(-8) * norm(bass) + db(-16) * norm(strings)
    return master(mix, rng)


# ======================================================================
# From skeptic-slow-acoustic/slow_acoustic.py

SECONDS = 60.0


N = int(SECONDS * SR)


def midi(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def _sa_place(buf, sound, at, gain=1.0):
    s = int(round(at * SR))
    if s < 0:
        sound = sound[-s:]
        s = 0
    if s >= buf.size or sound.size == 0:
        return
    e = min(buf.size, s + sound.size)
    buf[s:e] += gain * sound[: e - s]


def _fade(x, attack=0.002, release=0.015, curve="lin"):
    n = x.size
    a = max(1, int(attack * SR))
    r = max(1, int(release * SR))
    env = np.ones(n)
    k = min(a, n)
    ramp = np.arange(k) / a
    env[:k] = 0.5 - 0.5 * np.cos(np.pi * ramp) if curve == "cos" else ramp
    k = min(r, n)
    env[n - k:] *= 0.5 + 0.5 * np.cos(np.pi * np.arange(k) / r)
    return x * env


def _rms(x):
    return float(np.sqrt(np.mean(np.square(x)) + 1e-20))


def pink(n, rng):
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.arange(spec.size)
    spec[1:] /= np.sqrt(f[1:])
    spec[0] = 0
    x = np.fft.irfft(spec, n)
    return x / (np.max(np.abs(x)) + 1e-12)


def sa_reverb(x, rng, rt60=1.4, wet=0.3, predelay=0.018):
    n = int(rt60 * 1.3 * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal(n) * np.exp(-6.91 * t / rt60)
    ir = lfilter([0.35], [1, -0.65], ir)
    ir[: int(predelay * SR)] = 0
    for d, g in ((0.011, 0.5), (0.019, 0.35), (0.027, 0.3)):   # early reflections
        ir[int(d * SR)] += g * np.sqrt(np.sum(ir ** 2) / 200)
    w = fftconvolve(x, ir)[: x.size]
    return (1 - wet) * x + wet * w * (_rms(x) / _rms(w))


def finish(x, rng, peak=0.7, noise_db=-54.0):
    x = x / (np.max(np.abs(x)) + 1e-12)
    x = x + 10 ** (noise_db / 20) * pink(x.size, rng)
    return (peak * x / np.max(np.abs(x))).astype(np.float32)


class Grid:
    """Beat map (beat k at times[k]) with optional drift / phrase ritardando, and
    humanised onset times."""

    def __init__(self, bpm, rng, drift=0.0, drift_beats=24, rit=0.0, phrase=16, start=0.15,
                 jitter=0.007):
        self.p0 = 60.0 / bpm
        n = int(SECONDS / self.p0 * 1.3) + 16
        i = np.arange(n)
        ph = rng.uniform(0, 2 * np.pi)
        p = self.p0 * (1 + drift * np.sin(2 * np.pi * i / drift_beats + ph))
        if rit:
            p[i % phrase == phrase - 2] *= 1 + rit / 2
            p[i % phrase == phrase - 1] *= 1 + rit
        self.times = start + np.concatenate([[0.0], np.cumsum(p)])[:n]
        self.rng = rng
        self.jitter = jitter

    def t(self, pos, human=True):
        base = float(np.interp(pos, np.arange(self.times.size), self.times))
        if not human:
            return base
        j = float(np.clip(self.rng.normal(0, self.jitter), -0.018, 0.018))
        return base + j * self.p0

    def n_beats(self):
        return int(np.searchsorted(self.times, SECONDS))

    def true_bpm(self, seconds):
        b = self.times[self.times < seconds]
        return 60.0 / float(np.median(np.diff(b)))


_CACHE: dict = {}


def _cached(key, fn):
    if key not in _CACHE:
        _CACHE[key] = fn(np.random.default_rng(_seed(repr(key))))
    return _CACHE[key]


def sa_piano(f, dur, vel=0.7):
    dur = round(max(0.1, min(dur, 5.0)) / 0.05) * 0.05
    vq = round(vel, 1)
    key = ("piano", round(f, 2), dur, vq)

    def make(rng):
        n = int(dur * SR)
        t = (np.arange(n) / SR)[:, None]
        K = max(1, min(30, int(5000 / f)))
        k = np.arange(1, K + 1)
        fk = f * k * np.sqrt(1 + 3e-4 * k * k)
        amp = k ** -(1.7 - 0.6 * vq)
        ts = np.clip(3.5 * (261.6 / f) ** 0.6, 0.5, 7.0)
        tf = 0.3 * ts / 3.5 + 0.08
        env = 0.55 * np.exp(-t / (tf / (1 + 0.2 * (k - 1)))) + 0.45 * np.exp(-t / (ts / (1 + 0.25 * (k - 1))))
        x = (amp * env * np.sin(2 * np.pi * fk * t + rng.uniform(0, 6.28, K))).sum(1)
        x /= np.max(np.abs(x)) + 1e-12
        m = int(0.005 * SR)
        x[:m] += 0.05 * vq * lfilter([0.3], [1, -0.7], rng.standard_normal(m))
        return _fade(x, 0.0015, 0.12)

    return _cached(key, make)


_FORM = {  # (Hz, bandwidth, amplitude)
    "a": ((800, 80, 1.0), (1150, 90, 0.5), (2900, 120, 0.15), (3300, 130, 0.1)),
    "o": ((450, 70, 1.0), (800, 80, 0.35), (2830, 100, 0.06)),
    "u": ((325, 50, 1.0), (700, 60, 0.15), (2530, 170, 0.03)),
    "e": ((400, 60, 1.0), (1600, 80, 0.35), (2700, 120, 0.2)),
    "i": ((270, 60, 1.0), (2140, 90, 0.25), (2950, 100, 0.2)),
    "m": ((250, 90, 1.0), (1000, 200, 0.03)),
}


def _form_gain(freqs, vowel, scale):
    g = np.full(freqs.shape, 0.002)
    for F, B, A in _FORM[vowel]:
        g += A / (1 + ((freqs - F * scale) / (B * scale / 2)) ** 2)
    return g


def voice(f0, dur, vowel, cons, rng, fscale=1.0, f_prev=None, vib=0.006, attack=0.08, breath=0.01):
    """Formant-synthesised sung syllable. cons in (None, 'l', 'm', 'n', 'h', 's'). The
    vowel starts at sample 0; 'h' and 's' noise is returned as a separate pre-roll."""
    n = int(max(0.12, dur) * SR)
    t = np.arange(n) / SR
    vr = rng.uniform(5.0, 6.0)
    ramp = np.clip((t - 0.15) / 0.25, 0, 1)
    ft = f0 * (1 + vib * ramp * np.sin(2 * np.pi * vr * t + rng.uniform(0, 6.28)))
    ft *= 1 + 0.002 * lfilter([0.002], [1, -0.998], rng.standard_normal(n)) / 0.03
    if f_prev is not None:
        g = np.clip(t / 0.05, 0, 1)
        ft = ft * (f_prev / f0) ** (1 - g)
    ph = 2 * np.pi * np.cumsum(ft) / SR
    K = max(1, int(4500 / f0))
    k = np.arange(1, K + 1)
    a_v = _form_gain(k * f0, vowel, fscale) / k
    a_v /= np.sqrt(np.sum(a_v ** 2))
    s = np.sin(np.outer(ph, k))
    x = s @ a_v
    env = np.ones(n)
    if cons in ("l", "m", "n"):
        a_m = _form_gain(k * f0, "m", fscale) / k
        a_m /= np.sqrt(np.sum(a_m ** 2))
        xm = s @ a_m
        w = np.clip(t / 0.07, 0, 1)
        x = (1 - w) * xm * 0.6 + w * x
        env = 0.35 + 0.65 * np.clip(t / attack, 0, 1)
    else:
        a = np.clip(t / attack, 0, 1)
        env = 0.5 - 0.5 * np.cos(np.pi * a)
    x = x * env
    x += breath * lfilter([1, -0.9], [1], rng.standard_normal(n)) * env
    x = _fade(x, 0.003, 0.09, curve="cos")
    pre = None
    if cons == "h":
        m = int(0.06 * SR)
        pre = 0.08 * lfilter([1, -0.5], [1], rng.standard_normal(m)) * np.linspace(0.2, 1, m)
    elif cons == "s":
        m = int(0.09 * SR)
        nz = rng.standard_normal(m)
        nz = np.diff(np.diff(nz, prepend=0), prepend=0)
        pre = 0.05 * nz * np.sin(np.pi * np.arange(m) / m)
    return x, pre


SCALE = (0, 2, 4, 5, 7, 9, 11)


CHORD_DEG = {"C": (0, 2, 4), "Am": (5, 0, 2), "F": (3, 5, 0), "G": (4, 6, 1), "Em": (2, 4, 6), "Dm": (1, 3, 5)}


PROG = ("C", "Am", "F", "G")


def deg2midi(d, base=60):
    return base + SCALE[d % 7] + 12 * (d // 7)


def melody(rng, patterns, n_bars, bar_beats, lo=0, hi=9, base=60, prog=PROG):
    """[(pos_beats, dur_beats, midi)]: chord tone on each bar's first note, then steps."""
    out, cur = [], 4
    for b in range(n_bars):
        pat = patterns[b % len(patterns)]
        ch = CHORD_DEG[prog[b % len(prog)]]
        for j, (p, d) in enumerate(pat):
            if j == 0:
                cands = [c + 7 * o for c in ch for o in (-1, 0, 1) if lo <= c + 7 * o <= hi]
                cur = min(cands, key=lambda c: abs(c - cur) + rng.uniform(0, 1.5))
            else:
                cur = int(np.clip(cur + rng.choice((-2, -1, -1, 1, 1, 2)), lo, hi))
            out.append((b * bar_beats + p, d, deg2midi(cur, base)))
    return out


def sing(buf, grid, notes, rng, fscale=1.0, gain=1.0, cons_p=(0.25, 0.2, 0.2, 0.1, 0.1, 0.15),
         vowels="aoeiu", attack=0.08, offset_sd=0.0, legato=0.05):
    conss = (None, "l", "n", "m", "h", "s")
    prev = None
    for i, (p, d, m) in enumerate(notes):
        t0 = grid.t(p) + (rng.normal(0, offset_sd) if offset_sd else 0.0)
        t1 = grid.t(p + d, human=False)
        cons = conss[rng.choice(len(conss), p=np.asarray(cons_p) / sum(cons_p))]
        vow = vowels[rng.integers(len(vowels))]
        x, pre = voice(midi(m), t1 - t0 + legato, vow, cons, rng, fscale, f_prev=prev, attack=attack)
        g = gain * rng.uniform(0.8, 1.0) * (1.1 if p % 4 == 0 else 1.0)
        _sa_place(buf, x, t0, g)
        if pre is not None:
            _sa_place(buf, pre, t0 - pre.size / SR, g)
        prev = midi(m) if cons in (None, "l") else None


def g_lull68_piano(dq, rng):
    gr = Grid(dq, rng)
    buf = np.zeros(N)
    nb = gr.n_beats() + 1
    for b in range(nb):
        deg = CHORD_DEG[PROG[(b // 2) % 4]]
        bar_end = gr.t(2 * (b // 2 + 1), human=False)
        t = gr.t(b)
        _sa_place(buf, sa_piano(midi(deg2midi(deg[0], 36)), bar_end - t + 0.1, 0.7), t, 0.8)
        for j in (1, 2):
            tt = gr.t(b + j / 3)
            for dd in deg[1:]:
                _sa_place(buf, sa_piano(midi(deg2midi(dd, 48)), bar_end - tt + 0.1, 0.4), tt, 0.22)
    pats = ([(0, 2 / 3), (2 / 3, 1 / 3), (1, 2 / 3), (5 / 3, 1 / 3)], [(0, 1), (1, 1)],
            [(0, 2 / 3), (2 / 3, 1 / 3), (1, 1)], [(0, 2)])
    for p, d, m in melody(rng, pats, nb // 2 + 1, 2, base=72):
        _sa_place(buf, sa_piano(midi(m), d * gr.p0 + 0.4, 0.6), gr.t(p), 0.55)
    return gr, sa_reverb(buf, rng, 1.6, 0.3)


def g_lull34_piano_voice(bpm, rng):
    gr = Grid(bpm, rng)
    pno, voc = np.zeros(N), np.zeros(N)
    nb = gr.n_beats() + 1
    for b in range(nb):
        bar = b // 3
        deg = CHORD_DEG[PROG[bar % 4]]
        bar_end = gr.t(3 * (bar + 1), human=False)
        t = gr.t(b)
        if b % 3 == 0:
            _sa_place(pno, sa_piano(midi(deg2midi(deg[0], 36)), bar_end - t + 0.1, 0.7), t, 0.8)
        else:
            for dd in deg:
                _sa_place(pno, sa_piano(midi(deg2midi(dd, 48)), gr.p0 * 0.9, 0.4), t + rng.normal(0, 0.004), 0.25)
    pats = ([(0, 2), (2, 1)], [(0, 1), (1, 1), (2, 1)], [(0, 1.5), (1.5, 0.5), (2, 1)], [(0, 3)])
    sing(voc, gr, melody(rng, pats, nb // 3 + 1, 3), rng, fscale=1.12)
    return gr, sa_reverb(0.6 * pno / _rms(pno) + 0.8 * voc / _rms(voc), rng, 1.3, 0.28)


_PEAKS = (0.9, 0.5, 0.25, 0.7, 0.12)


def build(name, kind, bpm, accepted, fn):
    rng = np.random.default_rng(_seed(name))
    gr, mix = fn(rng)
    peak = _PEAKS[_seed(name + "/peak") % len(_PEAKS)]
    audio = finish(mix, rng, peak=peak, noise_db=-50.0 - (_seed(name + "/nf") % 10))
    return dict(name=name, kind=kind, nominal=bpm, accepted=accepted, grid=gr, audio=audio, peak=peak)


# ======================================================================
# Case builders: a measured case name -> its signal, as each suite's runner built it.


def bench_signal(name: str, seconds: float) -> np.ndarray:
    """bench.signals(): generated at `seconds`, seed _seed(name) (e.g. "click-60", "ambient")."""
    if name == "ambient":
        return ambient(seconds, _seed(name))
    family, bpm = name.rsplit("-", 1)
    generator = {"click": click_train, "piano": piano, "psy": psytrance}[family]
    return generator(int(bpm), seconds, _seed(name))


_RM_CASES = {  # rm_signals.cases() and rm_probe.cases(): gen(sec) = fn(sec, seed_of(name))
    "met-116-acc2-strong": lambda sec, s: metronome(116, sec, s, 2, accent_db=12),
    "met-120-acc3": lambda sec, s: metronome(120, sec, s, 3),
    "heartbeat-60": lambda sec, s: heartbeat_drum(60, sec, s),
    "heartbeat-72": lambda sec, s: heartbeat_drum(72, sec, s),
    "minimal-128": lambda sec, s: house(128, sec, s, "minimal"),
    "minimal2-124": lambda sec, s: house(124, sec, s, "minimal"),
    "pop68-50": lambda sec, s: pop_68(50, sec, s),
    "pop68-70": lambda sec, s: pop_68(70, sec, s),
}


def rm_signal(name: str, seconds: float) -> np.ndarray:
    """run_rm.py: each case generated at `seconds` with seed seed_of(name)."""
    return _RM_CASES[name](seconds, seed_of(name))


_SLOW_CASES = {  # slow_acoustic._spec(): (name -> nominal tempo, builder)
    "lull68-piano-dq56": (56, lambda r: g_lull68_piano(56, r)),
    "lull34-piano-voice-72": (72, lambda r: g_lull34_piano_voice(72, r)),
}


def slow_signal(name: str, seconds: float) -> np.ndarray:
    """run.py: build the 60 s case (name-seeded finish, peak and noise floor), then crop."""
    bpm, fn = _SLOW_CASES[name]
    case = build(name, "tempo", bpm, None, fn)
    return case["audio"][: int(seconds * SR)]
