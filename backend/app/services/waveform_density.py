"""Bounded signed-PCM density tiles. Source media is only ever read.

CMDN v1 has a 56-byte little-endian header followed by row-major Uint8 alpha.
The horizontal kernel composites gamma contributions before cropping the halo.
"""
from __future__ import annotations

import hashlib
import json
import math
import shutil
import struct
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..config import get_settings
from .library_paths import resolve_source_path
from .media_tools import media_tools
from .waveform import RATE, _signature

WIDTH = 2048
VERSION = 1
HEADER = struct.Struct('<4sHHIIddd16s')
TIMEOUT_S = 20
MAX_START_SECONDS = 86400
PCM_CHUNK_FRAMES = 8192
ADMISSION = threading.BoundedSemaphore(2)


class DensityBusy(Exception):
    pass


class DensityUnavailable(Exception):
    pass


class DensityChanged(Exception):
    pass


class DensityCancelled(Exception):
    pass


@dataclass(frozen=True)
class Geometry:
    tile_index: int
    pixels_per_second: float
    height: int
    dpr: float

    def __post_init__(self):
        if (not isinstance(self.tile_index, int) or not 0 <= self.tile_index <= 345600
                or not math.isfinite(self.pixels_per_second) or not 16 <= self.pixels_per_second <= 8192
                or not isinstance(self.height, int) or not 2 <= self.height <= 1024
                or not math.isfinite(self.dpr) or not .5 <= self.dpr <= 8
                or self.start_seconds > MAX_START_SECONDS):
            raise ValueError('Μη έγκυρη γεωμετρία κυματομορφής.')

    @property
    def start_seconds(self):
        return self.tile_index * WIDTH / self.pixels_per_second


def _check(cancel_event, deadline):
    if cancel_event is not None and cancel_event.is_set():
        raise DensityCancelled('Η απόδοση κυματομορφής ακυρώθηκε.')
    if deadline is not None and time.monotonic() >= deadline:
        raise TimeoutError('Η απόδοση κυματομορφής ξεπέρασε το χρονικό όριο.')


class Raster:
    """Streaming occupancy counts, bounded by tile width times effective height."""

    def __init__(self, geometry: Geometry, *, width=WIDTH, sample_rate=RATE):
        self.geometry = geometry
        self.width = width
        self.effective = int(min(geometry.height, (100 / .7) * geometry.dpr))
        self.padding = (geometry.height - self.effective) // 2
        self.kernel = np.ones(math.ceil(1.2 * geometry.dpr))
        if len(self.kernel) > 2:
            self.kernel[0] = self.kernel[-1] = .75
            self.kernel[len(self.kernel) // 2] = 1.5
        self.tile_column = geometry.tile_index * width
        self.first_column = max(0, self.tile_column - len(self.kernel))
        self.last_column = self.tile_column + width + len(self.kernel)
        columns = np.arange(self.first_column, self.last_column + 1)
        self.boundaries = np.floor(columns * sample_rate / geometry.pixels_per_second + .5).astype(np.int64)
        self.start_sample = int(self.boundaries[0])
        self.end_sample = int(self.boundaries[-1])
        self.histogram = np.zeros((len(columns) - 1, self.effective), np.int32)
        self.counts = np.zeros(len(columns) - 1, np.int32)
        self.seen = 0

    def feed(self, samples):
        samples = np.asarray(samples)
        if samples.ndim == 1:
            samples = samples[:, None]
        if samples.ndim != 2 or not 1 <= samples.shape[1] <= 32 or not np.isfinite(samples).all():
            raise DensityUnavailable('Μη έγκυρα δείγματα ήχου.')
        samples = samples[:max(0, self.end_sample - self.start_sample - self.seen)]
        if not len(samples):
            return
        positions = self.start_sample + self.seen + np.arange(len(samples))
        columns = np.searchsorted(self.boundaries, positions, side='right') - 1
        rows = np.clip(np.clip(samples.astype(np.float64), -1, 1) * (.7 * self.effective / 2)
                       + self.effective / 2, 1, self.effective - 2).astype(np.int64)
        np.add.at(self.histogram, (np.repeat(columns, samples.shape[1]), rows.ravel()), 1)
        self.counts += np.bincount(columns, minlength=len(self.counts)).astype(np.int32)
        self.seen += len(samples)

    def finish(self, *, cancel_event=None, deadline=None):
        height, dpr = self.geometry.height, self.geometry.dpr
        result = np.zeros((height, len(self.counts)), np.uint8)
        for column, n in enumerate(self.counts):
            if column % 32 == 0:
                _check(cancel_event, deadline)
            if not n:
                continue
            histogram = self.histogram[column]
            occupied = np.flatnonzero(histogram)
            first, last = occupied[0], occupied[-1]
            alpha = np.clip(70 * (np.clip(histogram[first:last + 1], .3, n) *
                                 (10 * (last - first + 1) / (float(n) * dpr))) ** .25, 0, 255)
            rows = height - 1 - (self.padding + np.arange(first, last + 1))
            for k, weight in enumerate(self.kernel):
                target = column + k - len(self.kernel) // 2
                if not 0 <= target < result.shape[1]:
                    continue
                contribution = np.trunc(alpha * weight)
                old = result[rows, target].astype(np.float64)
                result[rows, target] = np.minimum(255, np.trunc((old ** 2.2 + contribution ** 2.2) ** (1 / 2.2)))
        offset = self.tile_column - self.first_column
        return np.ascontiguousarray(result[:, offset:offset + self.width])


def _source(absolute_path):
    try:
        path = resolve_source_path(absolute_path)
        if not path.is_file():
            raise DensityUnavailable('Δεν είναι διαθέσιμο το αρχείο ήχου.')
        return path
    except OSError as error:
        raise DensityUnavailable('Δεν είναι διαθέσιμο το αρχείο ήχου.') from error


def _digest(signature, geometry):
    fields = dict(signature, density=VERSION, width=WIDTH, rate=RATE,
                  tile_index=geometry.tile_index, pixels_per_second=float(geometry.pixels_per_second),
                  height=geometry.height, dpr=float(geometry.dpr))
    return hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).digest()[:16]


def density_etag(absolute_path, geometry):
    try:
        return '"' + _digest(_signature(_source(absolute_path)), geometry).hex() + '"'
    except OSError as error:
        raise DensityUnavailable('Δεν είναι διαθέσιμο το αρχείο ήχου.') from error


def encode(geometry, digest, alpha):
    return HEADER.pack(b'CMDN', VERSION, 0, WIDTH, geometry.height, geometry.start_seconds,
                       geometry.pixels_per_second, geometry.dpr, digest) + alpha.tobytes()


def _wav_channels(stream):
    """Read only a bounded streaming WAV header; FFmpeg emits float32 PCM."""
    header = stream.read(12)
    if len(header) != 12 or header[:4] != b'RIFF' or header[8:] != b'WAVE':
        raise DensityUnavailable('Αποτυχία αποκωδικοποίησης ήχου.')
    consumed, channels = 12, None
    while consumed < 65536:
        chunk = stream.read(8)
        if len(chunk) != 8:
            break
        tag, size = struct.unpack('<4sI', chunk)
        consumed += 8
        if tag == b'data':
            if channels is None:
                break
            return channels
        if size > 65536 - consumed:
            break
        payload = stream.read(size + size % 2)
        consumed += len(payload)
        if len(payload) < size:
            break
        if tag == b'fmt ' and size >= 16:
            channels = struct.unpack_from('<H', payload, 2)[0]
            if not 1 <= channels <= 32 or struct.unpack_from('<H', payload, 14)[0] != 32:
                break
    raise DensityUnavailable('Μη έγκυρη κεφαλίδα αποκωδικοποίησης ήχου.')


def _decode_into(path: Path, renderer: Raster, cancel_event, deadline):
    binary = get_settings().ffmpeg_path or shutil.which('ffmpeg')
    if not binary:
        raise DensityUnavailable('Δεν είναι διαθέσιμη η αποκωδικοποίηση ήχου.')
    # Whole-second seek preserves the resampling clock; one second supplies context.
    seek_seconds = max(0, renderer.start_sample // RATE - 1)
    trim = renderer.start_sample - seek_seconds * RATE
    length = renderer.end_sample - renderer.start_sample
    command = [binary, '-nostdin', '-v', 'error', '-ss', str(seek_seconds), '-i', str(path),
               '-map', '0:a:0', '-vn', '-af', f'aresample={RATE},atrim=start_sample={trim}:end_sample={trim + length}',
               '-c:a', 'pcm_f32le', '-f', 'wav', '-']
    with tempfile.TemporaryFile() as errors:
        with media_tools.process(command, stdout=subprocess.PIPE, stderr=errors,
                                 cancel_event=cancel_event, deadline=deadline) as proc:
            try:
                channels = _wav_channels(proc.stdout)
                pending = b''
                while raw := proc.stdout.read(PCM_CHUNK_FRAMES * channels * 4):
                    _check(cancel_event, deadline)
                    raw = pending + raw
                    usable = len(raw) - len(raw) % (channels * 4)
                    pending = raw[usable:]
                    renderer.feed(np.frombuffer(raw[:usable], '<f4').reshape(-1, channels))
                _check(cancel_event, deadline)
                if proc.wait() != 0 or pending:
                    raise DensityUnavailable('Αποτυχία αποκωδικοποίησης ήχου.')
            except BaseException:
                _check(cancel_event, deadline)
                raise


def render_density(absolute_path, geometry, *, cancel_event=None, deadline=None,
                   admitted=False, detail_digest=None):
    """Return ETag/blob; the reservation is always released by the worker owner."""
    if not admitted and not ADMISSION.acquire(False):
        raise DensityBusy('Η απόδοση κυματομορφής είναι απασχολημένη.')
    deadline = time.monotonic() + TIMEOUT_S if deadline is None else deadline
    try:
        _check(cancel_event, deadline)
        path = _source(absolute_path)
        signature = _signature(path)
        if detail_digest is not None:
            from .waveform_detail import detail_etag
            # This API accepts catalog logical paths, not an already resolved mount.
            if detail_etag(absolute_path) != '"' + detail_digest.lower() + '"':
                raise DensityChanged('Το αρχείο ήχου άλλαξε· απαιτείται ανανέωση κυματομορφής.')
        digest = _digest(signature, geometry)
        renderer = Raster(geometry)
        _decode_into(path, renderer, cancel_event, deadline)
        alpha = renderer.finish(cancel_event=cancel_event, deadline=deadline)
        try:
            unchanged = _signature(path) == signature
        except OSError:
            unchanged = False
        if not unchanged:
            raise DensityChanged('Το αρχείο ήχου άλλαξε· απαιτείται ανανέωση κυματομορφής.')
        _check(cancel_event, deadline)
        return '"' + digest.hex() + '"', encode(geometry, digest, alpha)
    except subprocess.TimeoutExpired as error:
        _check(cancel_event, deadline)
        raise TimeoutError('Η απόδοση κυματομορφής ξεπέρασε το χρονικό όριο.') from error
    except OSError as error:
        _check(cancel_event, deadline)
        raise DensityUnavailable('Δεν είναι διαθέσιμη η κυματομορφή.') from error
    finally:
        ADMISSION.release()
