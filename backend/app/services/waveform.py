"""Full-band stereo overview envelopes. Source audio is only read.

Stream 44.1 kHz float PCM into 1024-sample windows (~23 ms), preserving sample
peaks separately from RMS energy. Never sum stereo channels (phase cancellation),
normalize each window, or invent a minimum amplitude for silence.
"""
from __future__ import annotations
import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
import numpy as np
from ..config import get_settings

logger = logging.getLogger(__name__)
VERSION = 2
RATE = 44100
WINDOW = 1024
MAX_POINTS = 32768
_LOCKS = [threading.Lock() for _ in range(16)]


def _cache_dir() -> Path:
    path = get_settings().db_file.parent / 'cache' / 'waveforms'
    path.mkdir(parents=True, exist_ok=True)
    return path


def _signature(path: Path) -> dict:
    stat = path.stat()
    return {'path': str(path.resolve()), 'size': stat.st_size, 'mtime_ns': stat.st_mtime_ns}


def _envelopes(samples: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Stereo PCM -> window peaks, energy and valid frame counts, including tail."""
    n = len(samples)
    count = (n + WINDOW - 1) // WINDOW
    padded = np.pad(samples, ((0, count * WINDOW - n), (0, 0))).reshape(count, WINDOW, 2)
    weights = np.full(count, WINDOW, dtype=np.int64)
    weights[-1] = n - (count - 1) * WINDOW
    peaks = np.max(np.abs(padded), axis=(1, 2))
    energy = np.sum(padded.astype(np.float64) ** 2, axis=(1, 2)) / (weights * 2)
    return peaks, energy, weights


def _decode(path: Path, binary: str) -> dict:
    cmd = [binary, '-nostdin', '-v', 'error', '-i', str(path), '-map', '0:a:0',
           '-vn', '-ac', '2', '-ar', str(RATE), '-f', 'f32le', '-']
    peaks, energies, weights = [], [], []
    # stderr goes to a file so a noisy decoder cannot deadlock its pipe.
    with tempfile.TemporaryFile() as errors, subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errors) as proc:
        timer = threading.Timer(180, proc.kill)
        timer.start()
        try:
            while raw := proc.stdout.read(WINDOW * 128 * 2 * 4):
                samples = np.frombuffer(raw, dtype='<f4').reshape(-1, 2)
                if not np.isfinite(samples).all():
                    raise ValueError('decoder produced non-finite PCM')
                p, e, w = _envelopes(samples)
                peaks.append(p); energies.append(e); weights.append(w)
            if proc.wait() != 0:
                raise ValueError('audio decoding failed or exceeded 180 seconds')
        except BaseException:
            proc.kill(); proc.wait()
            raise
        finally:
            timer.cancel()
    if not peaks:
        return {'peaks': [], 'rms': [], 'version': VERSION}
    p = np.concatenate(peaks); e = np.concatenate(energies); w = np.concatenate(weights)
    frames = int(w.sum())
    if len(p) > MAX_POINTS:
        edges = np.linspace(0, len(p), MAX_POINTS + 1, dtype=np.int64)[:-1]
        p = np.maximum.reduceat(p, edges)
        e = np.add.reduceat(e * w, edges) / np.add.reduceat(w, edges)
    return {'version': VERSION, 'sample_rate': RATE, 'window_samples': WINDOW,
            'duration': frames / RATE, 'sample_frames': frames,
            'peaks': np.round(np.clip(p, 0, 1), 5).tolist(),
            'rms': np.round(np.clip(np.sqrt(e), 0, 1), 5).tolist()}


def get_or_compute_waveform(track_id: int, absolute_path: str) -> dict:
    path = Path(absolute_path)
    empty = {'peaks': [], 'rms': [], 'version': VERSION}
    if not path.is_file():
        return empty
    with _LOCKS[track_id % len(_LOCKS)]:
        try:
            signature = _signature(path)
            cache = _cache_dir() / f'{track_id}-v{VERSION}.json'
            if cache.is_file():
                try:
                    data = json.loads(cache.read_text())
                    p, r = data.get('peaks', []), data.get('rms', [])
                    if (data.get('source') == signature and data.get('version') == VERSION
                            and 0 < len(p) == len(r) <= MAX_POINTS
                            and all(isinstance(x, (int, float)) and 0 <= x <= 1 for x in p + r)):
                        return {k: v for k, v in data.items() if k != 'source'}
                except (ValueError, TypeError, AttributeError):
                    logger.warning('Invalid waveform cache for track %s', track_id)
            configured = get_settings().ffmpeg_path
            binary = configured or shutil.which('ffmpeg')
            if not binary:
                return empty
            result = _decode(path, binary)
            if _signature(path) != signature or not result['peaks']:
                return empty
            temp = None
            try:
                with tempfile.NamedTemporaryFile(mode='w', dir=cache.parent, delete=False) as f:
                    temp = f.name
                    json.dump({**result, 'source': signature}, f, separators=(',', ':'))
                os.replace(temp, cache)
            except OSError:
                logger.warning('Could not cache waveform for track %s', track_id)
            finally:
                if temp and os.path.exists(temp):
                    os.unlink(temp)
            return result
        except (OSError, ValueError, subprocess.SubprocessError):
            logger.exception('Waveform extraction failed for track %s', track_id)
            return empty
