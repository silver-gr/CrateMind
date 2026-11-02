"""CMWD v2: linear RMS/peak envelopes plus measured frequency RGB colours.

Little-endian 48-byte header, no padding:
  0 magic 'CMWD' | 4 u16 version | 6 u16 reserved=0 | 8 u32 sample_rate | 12 u32 hop
  16 u32 win | 20 u32 frames | 24 f64 duration | 32 16-byte signature digest
Five planar Uint8 arrays follow: rms, peak, red, green, blue. Envelope frame i
covers 40 unwindowed samples, centred at (i*40+20)/44100 seconds. Both envelope
planes use one track-maximum peak reference with a 0.01 floor and linear scaling.
Colours use independent overlapping 512-sample FFTs, aligned by nearest centre.
Source audio is read only; channels are analysed separately, then averaged.
NumPy only: SciPy is excluded from the desktop bundle.
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
from . import waveform_color as color
from .waveform import RATE, _cache_dir, _signature

logger = logging.getLogger(__name__)
VERSION = 2
MAGIC = b'CMWD'
WIN = 40
HOP = 40  # 1102.5 envelope points/s at 44.1 kHz
HEADER = struct.Struct('<4sHHIIIId16s')
MAX_BYTES = 64 * 1024 ** 2
DECODE_TIMEOUT_S = 180
CHUNK_FRAMES = 2048
# Separate from the overview's striped locks so a slow detail analysis never blocks it.
_DETAIL_LOCKS = [threading.Lock() for _ in range(16)]
assert HEADER.size == 48


def frame_count(samples: int) -> int:
    return max(0, (samples + HOP - 1) // HOP)


class _Analyzer:
    """Bounded PCM buffers; only compact envelope/colour results span the track."""

    def __init__(self) -> None:
        self.buf = np.zeros((0, 2), np.float32)
        self.color_buf = np.zeros((color.PREPAD, 2), np.float32)
        self.total = 0
        self.done = 0
        self.color_done = 0
        self.envelopes: list[np.ndarray] = []
        self.colors: list[np.ndarray] = []

    def _frames(self, count: int) -> None:
        for start in range(0, count, CHUNK_FRAMES):
            stop = min(start + CHUNK_FRAMES, count)
            block = self.buf[start * HOP:stop * HOP].reshape(-1, WIN, 2)
            rms = np.sqrt(np.mean(np.square(block, dtype=np.float64), axis=1)).mean(axis=1)
            peak = np.abs(block).max(axis=1).astype(np.float64).mean(axis=1)
            self.envelopes.append(np.column_stack([rms, peak]))
        self.buf = self.buf[count * HOP:]
        self.done += count

    def _color_frames(self, count: int) -> None:
        view = np.lib.stride_tricks.sliding_window_view(self.color_buf, color.WIN, axis=0)
        for start in range(0, count, CHUNK_FRAMES):
            stop = min(start + CHUNK_FRAMES, count)
            self.colors.append(color.analyze(view[start * color.HOP:(stop - 1) * color.HOP + 1:color.HOP]))
        self.color_buf = self.color_buf[count * color.HOP:]
        self.color_done += count

    def feed(self, samples: np.ndarray) -> None:
        self.total += len(samples)
        if HEADER.size + 5 * frame_count(self.total) > MAX_BYTES:
            raise ValueError('detail waveform exceeds the size limit')
        # Decoder reads are small; also bound temporary buffers for direct callers.
        batch_samples = CHUNK_FRAMES * HOP
        for start in range(0, len(samples), batch_samples):
            block = samples[start:start + batch_samples]
            self.buf = np.concatenate([self.buf, block])
            self._frames(len(self.buf) // HOP)
            self.color_buf = np.concatenate([self.color_buf, block])
            if len(self.color_buf) >= color.WIN:
                self._color_frames((len(self.color_buf) - color.WIN) // color.HOP + 1)

    def _finish_analysis(self) -> int:
        """Pad pending tails once, shared by raw and compact finalization."""
        frames = frame_count(self.total)
        if not frames:
            return 0
        if frames > self.done:
            self.buf = np.pad(self.buf, ((0, WIN - len(self.buf)), (0, 0)))
            self._frames(1)
        color_frames = (self.total + color.HOP - 1) // color.HOP
        if color_frames > self.color_done:
            count = color_frames - self.color_done
            need = color.WIN + (count - 1) * color.HOP
            self.color_buf = np.pad(self.color_buf, ((0, need - len(self.color_buf)), (0, 0)))
            self._color_frames(count)
        return frames

    def finish(self) -> tuple[int, np.ndarray]:
        """Raw numerical results for tests; decoding uses finish_quantized()."""
        frames = self._finish_analysis()
        if not frames:
            return 0, np.zeros((0, 5), np.float64)
        colors = np.concatenate(self.colors)
        nearest = _nearest_color_indices(0, frames, len(colors))
        return frames, np.column_stack([np.concatenate(self.envelopes), colors[nearest]])

    def finish_quantized(self) -> tuple[int, np.ndarray]:
        """Fill final bytes blockwise, without expanding track-length float RGB."""
        frames = self._finish_analysis()
        planes = np.empty((5, frames), np.uint8)
        if not frames:
            return 0, planes
        reference = max(.01, max(float(block[:, 1].max()) for block in self.envelopes))
        colors = np.concatenate(self.colors)
        start = 0
        for block in self.envelopes:
            stop = start + len(block)
            planes[:2, start:stop] = _uint8_planes(block, reference)
            nearest = _nearest_color_indices(start, len(block), len(colors))
            planes[2:, start:stop] = _uint8_planes(colors[nearest])
            start = stop
        return frames, planes


def _nearest_color_indices(start: int, count: int, color_frames: int) -> np.ndarray:
    # Envelope centres 20+i*40; colour centres 128+j*256, ties select the later frame.
    centers = (start + np.arange(count)) * HOP + WIN // 2
    return np.clip((centers - color.PREPAD + color.HOP // 2) // color.HOP, 0, color_frames - 1)


def _uint8_planes(values: np.ndarray, reference: float = 1.0) -> np.ndarray:
    return (255 * np.clip(values / reference, 0, 1)).astype(np.uint8).T


def _quantize(values: np.ndarray) -> np.ndarray:
    """(frames, rms/peak/R/G/B) -> five Uint8 planes, truncating after scaling."""
    if not len(values):
        return np.zeros((5, 0), np.uint8)
    ref = max(float(values[:, 1].max()), .01)
    planes = np.empty((5, len(values)), np.uint8)
    planes[:2] = _uint8_planes(values[:, :2], ref)
    planes[2:] = _uint8_planes(values[:, 2:])
    return planes


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
    frames, planes = analyzer.finish_quantized()
    if frames == 0:
        return b''
    if HEADER.size + 5 * frames > MAX_BYTES:
        raise ValueError('detail waveform exceeds the size limit')
    return encode(frames, analyzer.total / RATE, digest, planes)


def _valid(blob: bytes, digest: bytes) -> bool:
    if len(blob) < HEADER.size or len(blob) > MAX_BYTES:
        return False
    magic, version, _, rate, hop, win, frames, _, stored = HEADER.unpack_from(blob)
    return (magic == MAGIC and version == VERSION and (rate, hop, win) == (RATE, HOP, WIN)
            and stored == digest and len(blob) == HEADER.size + 5 * frames and frames > 0)


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
