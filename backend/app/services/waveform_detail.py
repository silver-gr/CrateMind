"""Three-band detail waveform (low / mid / high / full) as a compact binary blob.

Binary layout (little-endian, 48-byte header, no padding):
  0 magic 'CMWD' | 4 u16 version | 6 u16 reserved=0 | 8 u32 sample_rate | 12 u32 hop
  16 u32 win | 20 u32 frames | 24 f64 duration | 32 16-byte signature digest
followed by four Uint8 arrays of `frames` bytes: full, low, mid, high.
Frame i is centred at (i*hop + win/2)/sample_rate seconds. All four arrays share ONE
per-track sqrt scale. Source audio is only read; stereo is analysed per channel and the
per-channel RMS is averaged (channels are never summed). NumPy only: SciPy is excluded
from the desktop bundle.
"""
from __future__ import annotations
import hashlib
import json
import logging
import os
import shutil
import struct
import subprocess
import tempfile
import threading
from pathlib import Path
import numpy as np
from ..config import get_settings
from .media_tools import media_tools
from .waveform import RATE, _cache_dir, _signature

logger = logging.getLogger(__name__)
VERSION = 1
MAGIC = b'CMWD'
WIN = 1024
HOP = 294  # 150 points/s at 44.1 kHz
HEADER = struct.Struct('<4sHHIIIId16s')
LOW_HZ, HIGH_HZ = 200.0, 2500.0
MAX_BYTES = 64 * 1024 ** 2
DECODE_TIMEOUT_S = 180
CHUNK_FRAMES = 2048
# Separate from the overview's striped locks so a slow detail analysis never blocks it.
_DETAIL_LOCKS = [threading.Lock() for _ in range(16)]
assert HEADER.size == 48


def _band_matrix() -> np.ndarray:
    """(WIN//2+1, 4) weights mapping |rfft|^2 to mean-square for full, low, mid, high."""
    n = WIN // 2 + 1
    window = np.hanning(WIN + 1)[:-1]  # periodic Hann
    norm = WIN * float(np.sum(window ** 2))
    weight = np.full(n, 2.0 / norm)
    weight[0] = weight[-1] = 1.0 / norm
    freq = np.arange(n) * RATE / WIN
    masks = [np.ones(n, bool), freq < LOW_HZ, (freq >= LOW_HZ) & (freq < HIGH_HZ), freq >= HIGH_HZ]
    return np.stack([weight * m for m in masks], axis=1).astype(np.float32)


_WINDOW = np.hanning(WIN + 1)[:-1].astype(np.float32)
_BANDS = _band_matrix()


def frame_count(samples: int) -> int:
    return 0 if samples <= 0 else (max(samples - WIN, 0) + HOP - 1) // HOP + 1


class _Analyzer:
    def __init__(self) -> None:
        self.buf = np.zeros((0, 2), np.float32)
        self.total = 0
        self.done = 0
        self.rms: list[np.ndarray] = []

    def _frames(self, count: int) -> None:
        view = np.lib.stride_tricks.sliding_window_view(self.buf, WIN, axis=0)  # (n, ch, WIN)
        for start in range(0, count, CHUNK_FRAMES):
            stop = min(start + CHUNK_FRAMES, count)
            block = view[start * HOP:(stop - 1) * HOP + 1:HOP] * _WINDOW
            spec = np.fft.rfft(block, axis=-1)
            power = spec.real ** 2 + spec.imag ** 2  # (k, ch, bins)
            ms = power @ _BANDS  # (k, ch, 4)
            self.rms.append(np.sqrt(np.maximum(ms, 0)).mean(axis=1))  # mean of per-channel RMS
        self.buf = self.buf[count * HOP:]
        self.done += count

    def feed(self, samples: np.ndarray) -> None:
        self.total += len(samples)
        self.buf = np.concatenate([self.buf, samples])
        if len(self.buf) >= WIN:
            self._frames((len(self.buf) - WIN) // HOP + 1)

    def finish(self) -> tuple[int, np.ndarray]:
        frames = frame_count(self.total)
        if frames > self.done:
            need = WIN + (frames - self.done - 1) * HOP
            self.buf = np.pad(self.buf, ((0, need - len(self.buf)), (0, 0)))
            self._frames(frames - self.done)
        if not self.rms:
            return 0, np.zeros((0, 4), np.float32)
        return frames, np.concatenate(self.rms)


def _quantize(rms: np.ndarray) -> np.ndarray:
    """(frames, 4 = full/low/mid/high) -> (4, frames) uint8 with one shared sqrt scale."""
    ref = float(np.percentile(rms[:, 0], 99.9)) if len(rms) else 0.0
    if ref <= 1e-9:
        return np.zeros((4, len(rms)), np.uint8)
    return np.round(255 * np.sqrt(np.clip(rms / ref, 0, 1))).astype(np.uint8).T


def _digest(signature: dict) -> bytes:
    raw = json.dumps({**signature, 'detail': VERSION, 'win': WIN, 'hop': HOP, 'rate': RATE}, sort_keys=True)
    return hashlib.sha256(raw.encode()).digest()[:16]


def encode(frames: int, duration: float, digest: bytes, planes: np.ndarray) -> bytes:
    header = HEADER.pack(MAGIC, VERSION, 0, RATE, HOP, WIN, frames, duration, digest)
    return header + np.ascontiguousarray(planes, np.uint8).tobytes()


def _decode(path: Path, binary: str, digest: bytes) -> bytes:
    cmd = [binary, '-nostdin', '-v', 'error', '-i', str(path), '-map', '0:a:0',
           '-vn', '-ac', '2', '-ar', str(RATE), '-f', 'f32le', '-']
    analyzer = _Analyzer()
    pending = b''
    with tempfile.TemporaryFile() as errors, media_tools.process(cmd, stdout=subprocess.PIPE, stderr=errors) as proc:
        timer = threading.Timer(DECODE_TIMEOUT_S, proc.kill)
        timer.start()
        try:
            while raw := proc.stdout.read(WIN * 256 * 8):
                raw = pending + raw
                usable = len(raw) - len(raw) % 8
                pending = raw[usable:]
                samples = np.frombuffer(raw[:usable], dtype='<f4').reshape(-1, 2)
                if not np.isfinite(samples).all():
                    raise ValueError('decoder produced non-finite PCM')
                analyzer.feed(samples)
            if proc.wait() != 0:
                raise ValueError('audio decoding failed or exceeded the time limit')
        except BaseException:
            proc.kill(); proc.wait()
            raise
        finally:
            timer.cancel()
    frames, rms = analyzer.finish()
    if frames == 0:
        return b''
    if HEADER.size + 4 * frames > MAX_BYTES:
        raise ValueError('detail waveform exceeds the size limit')
    return encode(frames, analyzer.total / RATE, digest, _quantize(rms))


def _valid(blob: bytes, digest: bytes) -> bool:
    if len(blob) < HEADER.size or len(blob) > MAX_BYTES:
        return False
    magic, version, _, rate, hop, win, frames, _, stored = HEADER.unpack_from(blob)
    return (magic == MAGIC and version == VERSION and (rate, hop, win) == (RATE, HOP, WIN)
            and stored == digest and len(blob) == HEADER.size + 4 * frames and frames > 0)


def _resolve(absolute_path: str) -> Path | None:
    from .library_paths import resolve_source_path
    try:
        path = resolve_source_path(absolute_path)
        return path if path.is_file() else None
    except OSError:
        return None


def detail_etag(absolute_path: str) -> str | None:
    """Cheap validator (stat only) so a matching If-None-Match skips all analysis."""
    path = _resolve(absolute_path)
    if path is None:
        return None
    try:
        return '"' + _digest(_signature(path)).hex() + '"'
    except OSError:
        return None


def get_or_compute_detail(track_id: int, absolute_path: str) -> tuple[str, bytes] | None:
    """Return (etag, blob) or None when the source/ffmpeg is unavailable or decoding fails."""
    path = _resolve(absolute_path)
    if path is None:
        return None
    with _DETAIL_LOCKS[track_id % len(_DETAIL_LOCKS)]:
        try:
            signature = _signature(path)
            digest = _digest(signature)
            etag = '"' + digest.hex() + '"'
            cache = _cache_dir() / f'{track_id}-detail-v{VERSION}.bin'
            try:
                blob = cache.read_bytes()
                if _valid(blob, digest):
                    return etag, blob
            except OSError:
                pass
            binary = get_settings().ffmpeg_path or shutil.which('ffmpeg')
            if not binary:
                return None
            blob = _decode(path, binary, digest)
            if not blob or _signature(path) != signature:
                return None
            temp = None
            try:
                with tempfile.NamedTemporaryFile(dir=cache.parent, delete=False) as f:
                    temp = f.name
                    f.write(blob)
                os.replace(temp, cache)
            except OSError:
                logger.warning('Could not cache detail waveform for track %s', track_id)
            finally:
                if temp and os.path.exists(temp):
                    os.unlink(temp)
            return etag, blob
        except (OSError, ValueError, subprocess.SubprocessError):
            logger.exception('Detail waveform extraction failed for track %s', track_id)
            return None
