"""Audio analysis: estimate BPM and musical key from the audio itself.

Read-only on source files (ffmpeg decode only). Results are written to the
Track.*_analyzed columns by analyze_all — never to embedded tags, and never to
the tag-derived bpm/key_text fields. BPM logic is ported from the standalone
analyze_bpm.py; the key comes from services/key_detect.py (whole track).
"""
from __future__ import annotations

import concurrent.futures
import json
import logging
import math
import threading
import time
import os
import subprocess
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Mapping, Optional

import numpy as np
from sqlalchemy import and_, func, or_
from scipy import signal
from sqlmodel import Session, select
from ..config import get_settings
from ..desktop_runtime import child_diagnostics

logger = logging.getLogger(__name__)
_ESSENTIA_TIMING_COUNT = 0
_ESSENTIA_TIMING_TOTAL_MS = 0.0
_ESSENTIA_TIMING_LOCK = threading.Lock()
_ESSENTIA_LOCAL = threading.local()

try:  # librosa is a hard dependency, but stay defensive so import never crashes
    import librosa
except Exception:  # pragma: no cover
    librosa = None

_ESSENTIA_IMPORT_ERROR: Optional[str] = None
try:
    from essentia.standard import EasyLoader, RhythmExtractor2013
except Exception as exc:  # pragma: no cover
    EasyLoader = RhythmExtractor2013 = None
    _ESSENTIA_IMPORT_ERROR = f"{type(exc).__name__}: {exc}"
    if get_settings().essentia_enabled:
        logger.error("essentia_import_failed error=%s", _ESSENTIA_IMPORT_ERROR)

from ..models import Job, Track, TrackBeatgrid, TrackStructure
from . import beatgrid_detect, key_detect, playback_loudness, track_structure
from .bpm_consensus import (  # noqa: F401  re-exported for existing callers
    HALF_TEMPO_THRESHOLD,
    _corrected_bpm,
    _octave_adjusted,
    _refresh_consensus,
    bpm_consensus,
    bpm_disagreement,
)
from .bpm_validation import GetSongBpmClient, ReccoBeatsClient
from .sql_ids import ids_in
from .tempo import SAME_TEMPO, effective_bpm, grid_tempo
from .tempo_ranges import TEMPO_RANGES, TempoRange, fold_into, get_range, resolve_track_range
from .cyanite import CyaniteClient, CyaniteResult
from .key_detect import estimate_key  # noqa: F401  re-exported; analyze_file calls it by this name

SAMPLE_RATE = 22050
HOP_LENGTH = 512
WINDOW_SECONDS = 120
MIN_BPM = 60
MAX_BPM = 240
BPM_METHOD = TEMPO_RANGES["psy"].method               # "librosa-onset-multilag-v2@133-286"
FALLBACK_METHOD = TEMPO_RANGES["psy"].fallback_method  # "ffmpeg+onset-autocorr-v1@133-286"
FALLBACK_EDGE = 1.03  # a fallback value within 3% past a window edge is kept as is
OCTAVE_TOLERANCE = 0.03  # therapy sections fold only when within 3% of an octave
ESSENTIA_METHOD = "essentia-rhythmextractor2013-multifeature-v1"

@dataclass
class AnalysisResult:
    bpm: Optional[float] = None
    bpm_raw: Optional[float] = None
    bpm_confidence: Optional[float] = None
    bpm_method: Optional[str] = None
    key: Optional[str] = None
    key_confidence: Optional[float] = None
    error: Optional[str] = None
    bpm_essentia: Optional[float] = None
    bpm_essentia_confidence: Optional[float] = None
    essentia_error: Optional[str] = None


def _workers() -> int:
    return max(1, min(8, os.cpu_count() or 4))


PLAYBACK_PAUSE_MESSAGE = "Σε παύση όσο παίζει ένα deck"
PLAYBACK_POLL_S = 2.0
_pause_lock = threading.Lock()
_paused_jobs: dict[int, Optional[str]] = {}  # job id -> its message before the pause, put back after it


def _set_job_message(engine, job_id: int, message: Optional[str]) -> Optional[str]:
    """Write a job's message in a short session of its own; returns the message it replaced."""
    with Session(engine) as session:
        job = session.get(Job, job_id)
        if job is None:
            return None
        before = job.message
        if before != message:
            job.message = message
            session.add(job)
            session.commit()
        return before


def _wait_for_decks(engine, job_id: Optional[int]) -> None:
    """Hold a track back while a deck plays (api/deck_rescue.deck_playing), so analysis never competes with a live
    set. Runs on a pool thread before each track; the job row says why meanwhile. The caller's session holds no write
    while it waits, and terminating the child still stops it."""
    from ..api.deck_rescue import deck_playing

    while deck_playing() and not stop_requested():
        child_diagnostics.progress()  # a long set is a pause, not a stalled file
        if job_id is not None:
            with _pause_lock:  # re-marked every poll: the main thread may have written its counts meanwhile
                before = _set_job_message(engine, job_id, PLAYBACK_PAUSE_MESSAGE)
                if before != PLAYBACK_PAUSE_MESSAGE:
                    _paused_jobs[job_id] = before
        time.sleep(PLAYBACK_POLL_S)
    if job_id is not None:
        with _pause_lock:
            if job_id in _paused_jobs:
                _set_job_message(engine, job_id, _paused_jobs.pop(job_id))


def _after_decks(session, job):
    """What each analysis phase passes its pool work through: `after_decks(fn)` is `fn`, made to wait first while a
    deck plays."""
    engine, job_id = session.get_bind(), None if job is None else job.id

    def wrap(fn):
        def run(*args, **kwargs):
            _wait_for_decks(engine, job_id)
            if stop_requested():
                raise AnalysisStopped
            return fn(*args, **kwargs)
        return run
    return wrap


class AnalysisStopped(Exception):
    """A queued track that never started because the user stopped the analysis."""


_stop_file: Optional[Path] = None


def stop_on_file(path: Optional[Path]) -> None:
    """Stop every phase between tracks once `path` exists: the analysis child's stop request (jobs/worker.py)."""
    global _stop_file
    _stop_file = path


def stop_requested() -> bool:
    return _stop_file is not None and _stop_file.exists()


def _completed(futures):
    """`as_completed`, leaving out the tracks a stop kept from starting. Tracks already running finish and are kept."""
    for future in concurrent.futures.as_completed(futures):
        if not isinstance(future.exception(), AnalysisStopped):
            yield future


def decode_audio(path: str, *, start: float = 0, seconds: float = WINDOW_SECONDS) -> np.ndarray:
    """Decode the first WINDOW_SECONDS of `path` to mono float32 @ SAMPLE_RATE.
    Read-only: ffmpeg only reads the source file."""
    ffmpeg = get_settings().ffmpeg
    if not ffmpeg:
        raise RuntimeError("Δεν βρέθηκε το ffmpeg. Χρειάζεται για την ανάλυση ήχου.")
    cmd = [
        ffmpeg, "-nostdin", "-v", "error", "-ss", str(start), "-i", path,
        "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-t", str(seconds), "-f", "f32le", "-",
    ]
    # stdin=DEVNULL: never hand ffmpeg an inherited stdin (a pipe with a
    # pending read would block it on Windows), as media_tools does.
    proc = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, check=False, timeout=180,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", errors="replace").strip() or "ffmpeg decode failed"
        raise RuntimeError(err)
    audio = np.frombuffer(proc.stdout, dtype=np.float32)
    if audio.size == 0:
        raise RuntimeError("decoded audio was empty")
    return audio


def _estimate_bpm_librosa(audio: np.ndarray, lo: float = 133.0, hi: float = 286.0) -> tuple[float, float]:
    if librosa is None:
        raise RuntimeError("librosa not available")
    if audio.size < SAMPLE_RATE * 10:
        raise RuntimeError("audio too short for BPM analysis")
    from scipy.signal import fftconvolve

    hop = 128
    env = librosa.onset.onset_strength(y=audio, sr=SAMPLE_RATE, hop_length=hop)
    if not env.size or not np.all(np.isfinite(env)):
        raise RuntimeError("invalid onset envelope")
    env = np.maximum(env - np.median(env), 0)
    env = np.minimum(env, np.percentile(env, 99))
    ac = fftconvolve(env, env[::-1], mode="full")[len(env) - 1:]
    ac = ac / np.maximum(1, np.arange(len(env), 0, -1))
    if ac[0] <= 1e-12:
        raise RuntimeError("insufficient rhythmic evidence")
    ac = ac / ac[0]
    grid = np.arange(lo, hi + 0.001, 0.02)
    periods = 60 * SAMPLE_RATE / (hop * grid)
    scores = np.zeros(len(grid))
    lags = np.arange(len(ac))
    weights = 1 / np.sqrt(np.arange(1, 25))
    for multiple, weight in enumerate(weights, start=1):
        scores += np.interp(periods * multiple, lags, ac) * weight
    index = int(np.argmax(scores))
    # Normalized periodicity strength, not a calibrated probability of correctness.
    confidence = float(np.clip(scores[index] / weights.sum(), 0, 1))
    return round(float(grid[index]), 2), round(confidence, 4)


class NoClearTempo(RuntimeError):
    """The therapy estimator found no clear pulse: store no BPM and no error."""

    def __init__(self, confidence: float):
        super().__init__("no clear tempo")
        self.confidence = confidence


# Therapy wide estimator (B4 final-A). Measured on 900+ synthetic cases; runtime is
# about 1.45x the DJ scorer per 60 s section (160 ms against 110 ms).
WIDE_HOP = 128
WIDE_FPS = SAMPLE_RATE / WIDE_HOP
WIDE_COMB_MAX = 960.0      # tatum search ceiling
WIDE_LOG_STEP = 2.5e-4     # relative grid step
WIDE_MULTIPLES = 24
WIDE_HALF_PENALTY = 0.5
WIDE_ODD_PENALTY = 0.3     # per prime 3, 5, 7, 11
WIDE_PRIMES = (2, 3, 5, 7, 11)
WIDE_GROUP_ABOVE = 200.0   # tatums faster than this are grouped by accent
WIDE_ACCENT_MIN = 1.2
WIDE_PARSIMONY = 0.9
WIDE_TOL = 0.02
THERAPY_CONF_GATE = 0.18   # below it: no clear tempo


def _wide_autocorr(audio: np.ndarray) -> np.ndarray:
    """Linear-amplitude mel flux (hop 128), median floor, 99th-percentile clip,
    unbiased autocorrelation normalised to lag 0."""
    if librosa is None:
        raise RuntimeError("librosa not available")
    from scipy.signal import fftconvolve

    audio = np.asarray(audio, dtype=np.float32)
    if audio.size < SAMPLE_RATE * 10:
        raise RuntimeError("audio too short for BPM analysis")
    if not np.all(np.isfinite(audio)):
        raise RuntimeError("non-finite audio")
    peak = float(np.max(np.abs(audio)))
    if peak <= 0:
        raise NoClearTempo(0.0)
    mel = librosa.feature.melspectrogram(y=audio / peak, sr=SAMPLE_RATE, hop_length=WIDE_HOP)
    env = librosa.onset.onset_strength(S=np.sqrt(mel), sr=SAMPLE_RATE, hop_length=WIDE_HOP)
    env = np.maximum(env - np.median(env), 0)
    cap = np.percentile(env, 99)
    env = np.minimum(env, cap if cap > 0 else env.max())  # sparse onsets: do not clip to zero
    ac = fftconvolve(env, env[::-1], mode="full")[len(env) - 1:]
    ac = ac / np.maximum(1, np.arange(len(env), 0, -1))
    if not np.isfinite(ac[0]) or ac[0] <= 1e-12:
        raise NoClearTempo(0.0)  # insufficient rhythmic evidence
    return ac / ac[0]


def _wide_comb(ac: np.ndarray, periods: np.ndarray) -> np.ndarray:
    """A candidate earns the autocorrelation at its multiples and loses part of it
    between teeth (1/2, 1/3, 1/5, 1/7, 1/11), so a slower sub-harmonic loses."""
    lags = np.arange(len(ac))
    on = np.zeros(len(periods)); off = np.zeros(len(periods)); wsum = np.zeros(len(periods))
    for k in range(1, WIDE_MULTIPLES + 1):
        w = np.where(periods * k <= 0.5 * len(ac), 1 / np.sqrt(k), 0.0)
        wsum += w
        on += w * np.interp(periods * k, lags, ac)
        for d in WIDE_PRIMES:
            mid = np.mean([np.interp(periods * (k - j / d), lags, ac) for j in range(1, d)], axis=0)
            off += w * (WIDE_HALF_PENALTY if d == 2 else WIDE_ODD_PENALTY) * mid
    return (on - off) / np.maximum(wsum, 1e-12)


def _wide_at(ac: np.ndarray, lag: float) -> float:
    lo, hi = int(np.floor(lag * (1 - WIDE_TOL))), int(np.ceil(lag * (1 + WIDE_TOL))) + 1
    return float(ac[lo:hi].max()) if 0 <= lo and hi <= ac.size else 0.0


def _wide_accent(ac: np.ndarray, period: float, g: int) -> float:
    return _wide_at(ac, g * period) / (np.mean([_wide_at(ac, j * period) for j in range(1, g)]) + 1e-12)


def _wide_clarity(ac: np.ndarray, period: float) -> float:
    k = max(2, int(4.0 * WIDE_FPS // period))
    return float(np.clip(np.mean([_wide_at(ac, m * period) - _wide_at(ac, (m - 0.5) * period)
                                  for m in range(1, k + 1)]), 0, 1))


def _estimate_bpm_wide(audio: np.ndarray, lo: float = 40.0, hi: float = 240.0) -> tuple[float, float]:
    """Therapy tempo (final-A): the fastest regular pulse up to 960 BPM, grouped by
    accent above 200, halved into [lo, hi]. No tempo prior, no pull toward 120.
    Confidence is pulse clarity; below THERAPY_CONF_GATE raises NoClearTempo."""
    ac = _wide_autocorr(audio)
    grid = np.exp(np.arange(np.log(lo), np.log(WIDE_COMB_MAX), WIDE_LOG_STEP))
    periods = 60 * WIDE_FPS / grid
    i = int(np.argmax(_wide_comb(ac, periods)))
    tatum, bpm = periods[i], float(grid[i])
    if bpm > WIDE_GROUP_ABOVE:
        accents = {g: _wide_accent(ac, tatum, g) for g in (2, 3, 4) if bpm / g >= lo * (1 - WIDE_TOL)}
        best = max(accents.values(), default=0.0)
        if best >= WIDE_ACCENT_MIN:
            bpm /= min(g for g, a in accents.items() if a >= WIDE_PARSIMONY * best)
    while bpm > hi:
        bpm /= 2
    conf = max(_wide_clarity(ac, 60 * WIDE_FPS / bpm), _wide_clarity(ac, tatum))
    if conf < THERAPY_CONF_GATE:
        raise NoClearTempo(round(conf, 4))
    return round(bpm, 2), round(conf, 4)


def _estimate_bpm_autocorr(audio: np.ndarray) -> tuple[float, float]:
    """Pure-numpy onset-flux autocorrelation fallback (no librosa)."""
    if audio.size < SAMPLE_RATE * 10:
        raise RuntimeError("audio too short for BPM analysis")
    audio = audio - np.mean(audio)
    peak = np.max(np.abs(audio))
    if peak <= 1e-9:
        raise RuntimeError("audio is effectively silent")
    audio = audio / peak

    frame_count = 1 + max(0, (audio.size - HOP_LENGTH) // HOP_LENGTH)
    if frame_count < 32:
        raise RuntimeError("not enough frames for onset analysis")

    envelope = []
    previous_magnitude = None
    for start in range(0, audio.size - HOP_LENGTH, HOP_LENGTH):
        frame = audio[start : start + HOP_LENGTH]
        spectrum = np.abs(np.fft.rfft(frame * np.hanning(frame.size)))
        if previous_magnitude is None:
            flux = 0.0
        else:
            delta = spectrum - previous_magnitude
            flux = float(np.sum(delta[delta > 0]))
        envelope.append(flux)
        previous_magnitude = spectrum

    onset_env = np.asarray(envelope, dtype=np.float64)
    onset_env = signal.medfilt(onset_env, kernel_size=7)
    onset_env = onset_env - np.mean(onset_env)
    if np.max(np.abs(onset_env)) <= 1e-12:
        raise RuntimeError("flat onset envelope")

    corr = signal.correlate(onset_env, onset_env, mode="full")
    corr = corr[corr.size // 2 :]
    if corr.size < 2:
        raise RuntimeError("autocorrelation failed")

    fps = SAMPLE_RATE / HOP_LENGTH
    min_lag = max(1, int(round(fps * 60.0 / MAX_BPM)))
    max_lag = min(corr.size - 1, int(round(fps * 60.0 / MIN_BPM)))
    if min_lag >= max_lag:
        raise RuntimeError("invalid BPM lag window")

    window = corr[min_lag : max_lag + 1]
    lag_offsets = np.arange(min_lag, max_lag + 1)
    candidate_bpms = 60.0 * fps / lag_offsets

    weights = np.ones_like(candidate_bpms)
    octave_penalty = np.minimum(np.abs(np.log2(candidate_bpms / 120.0)), 1.0)
    weights *= 1.0 - 0.15 * octave_penalty
    weighted = window * weights

    peak_idx = int(np.argmax(weighted))
    best_lag = lag_offsets[peak_idx]
    bpm = float(60.0 * fps / best_lag)

    sorted_scores = np.sort(weighted)
    best_score = float(weighted[peak_idx])
    next_score = float(sorted_scores[-2]) if sorted_scores.size > 1 else 0.0
    baseline = float(np.median(np.abs(window))) + 1e-9
    confidence = max(0.0, min(1.0, (best_score - next_score) / (best_score + baseline)))

    half_bpm = bpm / 2.0
    double_bpm = bpm * 2.0
    if bpm < 80 and double_bpm <= MAX_BPM:
        bpm = double_bpm
    elif bpm > 190 and half_bpm >= MIN_BPM:
        bpm = half_bpm

    return round(bpm, 2), round(confidence, 4)


def estimate_bpm(
    audio: np.ndarray, tempo_range: TempoRange = TEMPO_RANGES["psy"]
) -> tuple[float, float, float, str]:
    """librosa multi-lag scorer on the window's grid, numpy autocorr fallback
    folded into the window. The therapy window runs the wide estimator with no
    fallback; NoClearTempo propagates. Returns (bpm, raw_bpm, confidence, method)."""
    if tempo_range.estimator == "wide":
        bpm, conf = _estimate_bpm_wide(audio, tempo_range.lo, tempo_range.hi)
        return bpm, bpm, conf, tempo_range.method
    try:
        raw, conf = _estimate_bpm_librosa(audio, tempo_range.lo, tempo_range.hi)
    except Exception:
        raw, conf = _estimate_bpm_autocorr(audio)
        if tempo_range.key == "psy":  # the DJ default keeps the legacy octave rule
            bpm = _corrected_bpm(raw)
        elif tempo_range.lo / FALLBACK_EDGE <= raw <= tempo_range.hi * FALLBACK_EDGE:
            # The coarse lag grid lands just past an edge (117.45 for 118-120);
            # folding that would double or halve it.
            bpm = round(raw, 2)
        else:
            bpm = round(fold_into(raw, tempo_range.lo, tempo_range.hi), 2)
        return bpm, round(raw, 2), conf, tempo_range.fallback_method
    return raw, raw, conf, tempo_range.method



def estimate_file_bpm(
    path: str, intro_audio: np.ndarray, tempo_range: TempoRange = TEMPO_RANGES["psy"]
) -> tuple[float, float, float, str]:
    """Match the validated three-section benchmark; tolerate short tracks.

    Successful sections give their median. Otherwise a section without a clear
    tempo re-raises its NoClearTempo (the most confident one), so the intro is not
    re-run; only when every section failed for another reason does the intro
    fallback run."""
    results = []
    unclear: list[NoClearTempo] = []
    for start in (30, 120, 210):
        try:
            if start == 30:
                section = intro_audio[30 * SAMPLE_RATE:90 * SAMPLE_RATE]
            else:
                section = decode_audio(path, start=start, seconds=60)
            if section.size < SAMPLE_RATE * 10:
                continue
            results.append(estimate_bpm(section, tempo_range))
        except NoClearTempo as exc:
            unclear.append(exc)
        except (RuntimeError, subprocess.TimeoutExpired):
            continue
    if not results:
        if unclear:
            raise max(unclear, key=lambda exc: exc.confidence)
        return estimate_bpm(intro_audio, tempo_range)
    # Never blend fallback estimates into a successful refined estimate.
    refined = [result for result in results if result[3] != tempo_range.fallback_method]
    selected = refined or results
    if tempo_range.estimator == "wide":
        # Sections one or two octaves apart would blend to a non-octave value
        # (x1.5, x3). Fold every section into the octave most sections share;
        # confidence only breaks a tie. The median then folds back into the window.
        def octave_fold(bpm: float, ref: float) -> float:
            return bpm * 2.0 ** max(-2, min(2, round(math.log2(ref / bpm))))

        anchor = max(selected, key=lambda r: (
            sum(octave_fold(s[0], r[0]) == s[0] for s in selected), r[2],
        ))[0]
        # Only true octaves fold; a x3 or x1.5 section is left out, so the
        # anchor's octave group decides instead of a value no section measured.
        selected = [
            (octave_fold(r[0], anchor), octave_fold(r[1], anchor), r[2], r[3])
            for r in selected
            if abs(octave_fold(r[0], anchor) / anchor - 1.0) <= OCTAVE_TOLERANCE
        ]
        bpm = fold_into(float(np.median([r[0] for r in selected])), tempo_range.lo, tempo_range.hi)
        raw = fold_into(float(np.median([r[1] for r in selected])), tempo_range.lo, tempo_range.hi)
    else:
        bpm = float(np.median([r[0] for r in selected]))
        raw = float(np.median([r[1] for r in selected]))
    return (
        round(bpm, 2),
        round(raw, 2),
        round(float(np.median([r[2] for r in selected])), 4),
        selected[0][3],
    )


def _get_rhythm_extractor():
    extractor = getattr(_ESSENTIA_LOCAL, "rhythm_extractor", None)
    if extractor is None:
        extractor = RhythmExtractor2013(
            method="degara",
            minTempo=MIN_BPM,
            maxTempo=MAX_BPM,
        )
        _ESSENTIA_LOCAL.rhythm_extractor = extractor
    return extractor


def estimate_bpm_essentia(path: str) -> tuple[float, float]:
    """Independent Essentia estimate over a representative 60-second segment."""
    global _ESSENTIA_TIMING_COUNT, _ESSENTIA_TIMING_TOTAL_MS

    if EasyLoader is None or RhythmExtractor2013 is None:
        detail = _ESSENTIA_IMPORT_ERROR or "unknown import failure"
        raise RuntimeError(f"essentia not available: {detail}")

    started = time.perf_counter()
    audio = EasyLoader(
        filename=path,
        sampleRate=44100,
        startTime=30.0,
        endTime=90.0,
    )()
    if len(audio) < 44100 * 10:
        audio = EasyLoader(
            filename=path,
            sampleRate=44100,
            startTime=0.0,
            endTime=60.0,
        )()
    loaded = time.perf_counter()
    if len(audio) < 44100 * 10:
        raise RuntimeError("audio too short for Essentia BPM analysis")
    rhythm = _get_rhythm_extractor()
    bpm, _ticks, confidence, _estimates, _intervals = rhythm(audio)
    finished = time.perf_counter()

    total_ms = (finished - started) * 1000
    with _ESSENTIA_TIMING_LOCK:
        _ESSENTIA_TIMING_COUNT += 1
        _ESSENTIA_TIMING_TOTAL_MS += total_ms
        if _ESSENTIA_TIMING_COUNT % 25 == 0:
            logger.info(
                "essentia_progress analyzed=%d avg_ms=%.1f last_decode_ms=%.1f last_rhythm_ms=%.1f",
                _ESSENTIA_TIMING_COUNT,
                _ESSENTIA_TIMING_TOTAL_MS / _ESSENTIA_TIMING_COUNT,
                (loaded - started) * 1000,
                (finished - loaded) * 1000,
            )
    if not np.isfinite(bpm) or bpm <= 0:
        raise RuntimeError("Essentia returned no BPM")
    return round(float(bpm), 2), round(float(confidence), 4)


def analyze_file(
    path: str,
    *,
    run_primary: bool = True,
    run_essentia: bool = True,
    tempo_range: TempoRange = TEMPO_RANGES["psy"],
) -> AnalysisResult:
    """Run requested local engines for one file. Captures errors per engine.
    No clear tempo (therapy window) stores no BPM and no error, so the track
    counts as analysed and is not retried."""
    res = AnalysisResult()
    if run_primary:
        logger.debug("analysis_file stage=decode-start path=%r", path)
        try:
            audio = decode_audio(path, seconds=key_detect.MAX_SECONDS)
        except Exception as exc:
            logger.warning("audio_decode_failed path=%r error=%s", path, exc)
            res.error = f"decode: {exc}"
        else:
            logger.debug("analysis_file stage=decode-done samples=%s", audio.size)
            try:
                bpm, raw, conf, method = estimate_file_bpm(path, audio[: WINDOW_SECONDS * SAMPLE_RATE], tempo_range)
                res.bpm, res.bpm_raw = bpm, raw
                res.bpm_confidence, res.bpm_method = conf, method
                logger.debug("analysis_file stage=bpm-done bpm=%s method=%s", bpm, method)
            except NoClearTempo as exc:
                res.bpm_confidence, res.bpm_method = exc.confidence, tempo_range.method
                logger.debug("analysis_file stage=bpm-done no-clear-tempo conf=%s", exc.confidence)
            except Exception as exc:
                logger.warning("librosa_bpm_failed path=%r error=%s", path, exc)
                res.error = f"bpm: {exc}"
            try:
                key, kconf = estimate_key(audio)
                res.key, res.key_confidence = key, kconf
                logger.debug("analysis_file stage=key-done key=%s", key)
            except Exception as exc:
                logger.warning("librosa_key_failed path=%r error=%s", path, exc)
                res.error = (res.error + "; " if res.error else "") + f"key: {exc}"
    if run_essentia:
        try:
            bpm, confidence = estimate_bpm_essentia(path)
            res.bpm_essentia = bpm
            res.bpm_essentia_confidence = confidence
        except Exception as exc:
            logger.warning("essentia_bpm_failed path=%r error=%s", path, exc)
            res.essentia_error = str(exc)
    return res


_CONSENSUS_COLUMNS = ["bpm_consensus", "bpm_consensus_sources", "bpm_needs_review"]


def _grid_targets(session, *, force: bool, track_ids: list[int] | None, limit: int | None) -> list[int]:
    """Tracks that need CrateMind's own beat grid or their structure: none stored for the current
    version of either, or a structure measured in a tempo octave the track's BPM no longer has. Its
    own selection, so a backlog never re-runs BPM, key or providers."""
    stmt = select(Track.id).where(Track.missing == False)  # noqa: E712
    if track_ids is not None:
        stmt = stmt.where(ids_in(Track.id, track_ids))
    if not force:
        grid = select(TrackBeatgrid.track_id).where(
            TrackBeatgrid.source == beatgrid_detect.SOURCE,
            TrackBeatgrid.source_version == beatgrid_detect.VERSION,
        )
        structure = select(TrackStructure.track_id).where(TrackStructure.version == track_structure.VERSION)
        stmt = stmt.where(or_(Track.id.not_in(grid), Track.id.not_in(structure),
                              ids_in(Track.id, _off_octave_structures(session))))
    stmt = stmt.order_by(Track.id)
    if limit is not None:
        stmt = stmt.limit(limit)
    return list(session.exec(stmt).all())


def _off_octave_structures(session) -> list[int]:
    """Tracks whose structure was measured at a tempo their resolved BPM no longer folds to (a ×½ or
    ×2 pressed since): the structure is read again along the folded beats, the grid is kept."""
    resolved = func.cratemind_bpm(Track.bpm, Track.bpm_analyzed, Track.bpm_consensus, Track.bpm_consensus_sources,
                                  Track.artist, Track.title, Track.bpm_grid)       # services/tempo.py, as the Library shows it
    rows = session.exec(
        select(Track.id, resolved, TrackBeatgrid.bpm, func.json_extract(TrackStructure.data, "$.bpm"),
               TrackBeatgrid.beats.is_not(None))
        .join(TrackStructure, TrackStructure.track_id == Track.id)
        .join(TrackBeatgrid, and_(TrackBeatgrid.track_id == Track.id, TrackBeatgrid.source == beatgrid_detect.SOURCE))
        .where(TrackStructure.version == track_structure.VERSION, TrackStructure.data.is_not(None))).all()
    return [track_id for track_id, bpm, grid_bpm, measured, is_list in rows if measured and grid_bpm
            and abs(grid_bpm * _structure_factor(grid_bpm, bpm, bool(is_list)) - measured) / measured > SAME_TEMPO]


def _structure_factor(grid_bpm: Optional[float], track_bpm: Optional[float], beat_list: bool) -> float:
    """`tempo_factor`, as the deck folds the grid: it folds only steady grids, so a beat list at half
    the track's tempo is not doubled (lines on its midpoints would fall between the beats it draws)."""
    factor = track_structure.tempo_factor(grid_bpm, track_bpm)
    return 1.0 if beat_list and factor == 2.0 else factor


def _beat_times(bpm: float, anchor_s: float, beats: Optional[np.ndarray], seconds: float) -> np.ndarray:
    """Every beat of a grid up to `seconds`: the beat list, or the steady grid from its anchor."""
    if beats is not None:
        return np.asarray(beats, dtype=float)
    return anchor_s + np.arange(max(0, math.ceil((seconds - anchor_s) * bpm / 60.0))) * 60.0 / bpm


def _structure_of(bands: Optional[np.ndarray], bpm: Optional[float], anchor_s: Optional[float],
                  beats: Optional[np.ndarray], confidence: Optional[float], seconds: float,
                  downbeat: Optional[int], track_bpm: Optional[float]) -> Optional[track_structure.Structure]:
    """The structure along a grid, only for a grid a deck would be served (confident, with an anchor).
    `downbeat`: a beat list's first downbeat (a steady grid's anchor is one). `track_bpm`: the track's
    resolved BPM; a grid an octave off it is folded onto it first, as the deck folds it, so a phrase
    is 8 real bars. The structure carries the tempo it was measured at."""
    if bands is None or not bpm or anchor_s is None or (confidence or 0) < beatgrid_detect.MIN_CONFIDENCE:
        return None
    factor = _structure_factor(bpm, track_bpm, beats is not None)
    times, down = track_structure.fold_beats(_beat_times(bpm, anchor_s, beats, seconds),
                                             0 if beats is None else int(downbeat or 0), factor)
    structure = track_structure.detect_structure(bands, times, down)
    return None if structure is None else replace(structure, bpm=round(bpm * factor, 2))


def _grid_for(path: str, duration: float | None, hint_bpm: float | None,
              ) -> tuple[Optional[beatgrid_detect.GridResult], Optional[track_structure.Structure] | Exception]:
    """One file's grid and, along it, its structure (one read-only decode, one transform).
    (None, None): nothing to fit. A structure that fails comes back as its exception, so the grid
    is still stored. Runs on a pool thread."""
    if duration is not None and not beatgrid_detect.MIN_SECONDS <= duration <= beatgrid_detect.MAX_SECONDS:
        return None, None  # known too short or too long: do not decode it at all
    audio = decode_audio(path, seconds=beatgrid_detect.MAX_SECONDS + 1)
    grid, bands = beatgrid_detect.detect_with_bands(audio, hint_bpm)
    if grid is None:
        return None, None
    # The beats as the row will hold them (float32), so reading the structure back from a stored grid gives the same one.
    beats = None if grid.beats is None else np.asarray(grid.beats, dtype="<f4").astype(float)
    try:
        # The hint folds onto the new grid exactly as the resolved BPM will once the grid is stored.
        return grid, _structure_of(bands, grid.bpm, grid.anchor_s, beats, grid.confidence,
                                   audio.size / beatgrid_detect.SAMPLE_RATE, grid.first_downbeat_index, hint_bpm)
    except Exception as exc:  # noqa: BLE001  the grid is good without it
        return grid, exc


def _structure_for(path: str, bpm: float, anchor_s: float, beats: Optional[np.ndarray], confidence: float,
                   downbeat: Optional[int], track_bpm: Optional[float]) -> Optional[track_structure.Structure]:
    """The structure of a file whose grid is already stored (read-only decode; the grid is not
    measured again). Runs on a pool thread."""
    audio = decode_audio(path, seconds=beatgrid_detect.MAX_SECONDS + 1)
    return _structure_of(beatgrid_detect.band_energies(audio), bpm, anchor_s, beats, confidence,
                         audio.size / beatgrid_detect.SAMPLE_RATE, downbeat, track_bpm)


def _store_grid(session, track_id: int, grid: Optional[beatgrid_detect.GridResult]) -> None:
    """Upsert the track's CrateMind row, and the track's `bpm_grid` with it. No grid is stored too
    (no anchor, confidence 0), so the track is not decoded again on every run. Rows from other
    sources (djay) are never touched."""
    row = session.exec(select(TrackBeatgrid).where(
        TrackBeatgrid.track_id == track_id, TrackBeatgrid.source == beatgrid_detect.SOURCE)).first()
    if row is None:
        row = TrackBeatgrid(track_id=track_id, source=beatgrid_detect.SOURCE)
    beats = grid.beats if grid else None      # a track with sections: explicit beat times, like a djay list
    row.straight = beats is None
    row.beats = None if beats is None else np.asarray(beats, dtype="<f4").tobytes()
    row.edited = False
    row.bpm = grid.bpm if grid else None
    row.anchor_s = grid.anchor_s if grid else None
    row.first_downbeat_index = grid.first_downbeat_index if grid else None
    row.residual_ms = grid.residual_ms if grid else None
    row.confidence = grid.confidence if grid else 0.0
    row.source_version = beatgrid_detect.VERSION
    row.imported_at = datetime.now(UTC)
    session.add(row)
    track = session.get(Track, track_id)
    if track is not None:
        track.bpm_grid = grid_tempo(row.bpm, row.anchor_s, row.confidence, row.straight, track.bpm_analyzed_method)
        session.add(track)


def _store_structure(session, track_id: int, structure: Optional[track_structure.Structure]) -> None:
    """Upsert the track's structure row. No structure is stored too (no data), so the track is not
    decoded again on every run."""
    row = session.exec(select(TrackStructure).where(TrackStructure.track_id == track_id)).first()
    if row is None:
        row = TrackStructure(track_id=track_id, version=track_structure.VERSION)
    row.version = track_structure.VERSION
    row.quality = structure.quality if structure else None
    row.data = None if structure is None else json.dumps(
        {"sections": [asdict(section) for section in structure.sections],
         "anchors": list(structure.anchors), "phrases": list(structure.phrases),
         "fills": [asdict(fill) for fill in structure.fills], "bpm": structure.bpm}, separators=(",", ":"))
    row.created_at = datetime.now(UTC)
    session.add(row)


def detect_grids(session, track_ids: list[int], *, force: bool = False, job=None, done: int = 0) -> dict:
    """Detect and store CrateMind's beat grid and the structure along it for `track_ids`. A track
    whose grid is current keeps it and only gets its structure. Touches only track_beatgrids rows
    with source "cratemind" and track_structures. A file that fails to decode stores nothing and is
    tried again next run."""
    from .library_paths import resolve_source_path

    made = failed = structures = structures_failed = 0
    if not track_ids or stop_requested():
        return {"grids": 0, "grids_failed": 0, "structures": 0, "structures_failed": 0}
    tracks = session.exec(select(Track).where(ids_in(Track.id, track_ids))).all()
    current = {} if force else {row.track_id: row for row in session.exec(select(TrackBeatgrid).where(
        ids_in(TrackBeatgrid.track_id, track_ids), TrackBeatgrid.source == beatgrid_detect.SOURCE,
        TrackBeatgrid.source_version == beatgrid_detect.VERSION)).all()}
    after_decks = _after_decks(session, job)
    with concurrent.futures.ThreadPoolExecutor(max_workers=_workers()) as ex:
        futures = {}
        for t in tracks:
            path, row = str(resolve_source_path(t.absolute_path)), current.get(t.id)
            if row is None:
                # The octave hint leaves the stored grid tempo out, so a rebuild never feeds on its own result.
                futures[ex.submit(after_decks(_grid_for), path, t.duration, effective_bpm(t, include_grid=False))] = (t.id, True)
            elif row.anchor_s is None or not row.bpm or (row.confidence or 0) < beatgrid_detect.MIN_CONFIDENCE:
                _store_structure(session, t.id, None)       # no grid a deck would use: nothing to decode
            else:
                beats = None if row.beats is None else np.frombuffer(row.beats, dtype="<f4").astype(float)
                futures[ex.submit(after_decks(_structure_for), path, row.bpm, row.anchor_s, beats, row.confidence,
                                  row.first_downbeat_index, effective_bpm(t))] = (t.id, False)
        settled = len(tracks) - len(futures)                # tracks that needed no decode are done already
        if job is not None:
            job.processed = done + settled
            session.add(job)
        session.commit()
        for count, finished in enumerate(_completed(futures), start=1 + settled):
            child_diagnostics.progress()
            track_id, with_grid = futures[finished]
            try:
                result = finished.result()
            except Exception as exc:  # noqa: BLE001  one bad file never stops the run
                logger.warning("%s track_id=%s error=%s", "beatgrid_failed" if with_grid else "structure_failed", track_id, exc)
                failed += with_grid
                structures_failed += not with_grid
            else:
                grid, structure = result if with_grid else (None, result)
                if with_grid:
                    _store_grid(session, track_id, grid)
                    made += grid is not None
                if isinstance(structure, Exception):        # no row: the next run reads it from the stored grid
                    logger.warning("structure_failed track_id=%s error=%s", track_id, structure)
                    structures_failed += 1
                    stale = session.exec(select(TrackStructure).where(TrackStructure.track_id == track_id)).first()
                    if stale is not None:                   # it belonged to the grid that was just replaced
                        session.delete(stale)
                else:
                    _store_structure(session, track_id, structure)
                    structures += structure is not None
            if job is not None:
                job.processed = done + count
                session.add(job)
            session.commit()
    return {"grids": made, "grids_failed": failed, "structures": structures, "structures_failed": structures_failed}


def _key_targets(session, *, skip: set[int], track_ids: list[int] | None, limit: int | None) -> list[int]:
    """Tracks whose key came from an older key method (or none recorded): the key phase re-keys them
    without running BPM or providers again. `skip`: tracks this run's first pass analyses anyway (it
    keys them with the current method)."""
    stmt = select(Track.id).where(
        Track.missing == False,  # noqa: E712
        Track.analyzed_at.is_not(None),
        Track.key_analyzed.is_not(None),
        or_(Track.key_analyzed_method.is_(None), Track.key_analyzed_method != key_detect.METHOD),
    )
    if track_ids is not None:
        stmt = stmt.where(ids_in(Track.id, track_ids))
    stmt = stmt.order_by(Track.id)
    if limit is not None:
        stmt = stmt.limit(limit)
    return [track_id for track_id in session.exec(stmt).all() if track_id not in skip]


def _key_for(path: str) -> tuple[Optional[str], Optional[float]]:
    """One file's key from one read-only whole-track decode. Runs on a pool thread."""
    return estimate_key(decode_audio(path, seconds=key_detect.MAX_SECONDS))


def detect_keys(session, track_ids: list[int], *, job=None, done: int = 0) -> dict:
    """Re-key `track_ids` with the current key method. Writes only key_analyzed, its confidence and
    method. A file that fails (decode or analysis) keeps its old key and is tried again next run."""
    from .library_paths import resolve_source_path

    keyed = failed = 0
    if not track_ids or stop_requested():
        return {"keys": 0, "keys_failed": 0}
    tracks = {t.id: t for t in session.exec(select(Track).where(ids_in(Track.id, track_ids))).all()}
    after_decks = _after_decks(session, job)
    with concurrent.futures.ThreadPoolExecutor(max_workers=_workers()) as ex:
        futures = {ex.submit(after_decks(_key_for), str(resolve_source_path(t.absolute_path))): t.id for t in tracks.values()}
        for count, finished in enumerate(_completed(futures), start=1):
            child_diagnostics.progress()
            track = tracks[futures[finished]]
            try:
                key, confidence = finished.result()
            except Exception as exc:  # noqa: BLE001  one bad file never stops the run
                logger.warning("key_failed track_id=%s error=%s", track.id, exc)
                failed += 1
            else:
                track.key_analyzed, track.key_analyzed_confidence = key, confidence
                track.key_analyzed_method = key_detect.METHOD
                session.add(track)
                keyed += 1
            if job is not None:
                job.processed = done + count
                session.add(job)
            session.commit()
    return {"keys": keyed, "keys_failed": failed}


def _loudness_targets(session, *, force: bool, track_ids: list[int] | None, limit: int | None) -> list[int]:
    """Tracks with no loudness measurement (every selected track when forced). Its own selection,
    like the grid phase, so a backlog never re-runs BPM, key or providers."""
    stmt = select(Track.id).where(Track.missing == False)  # noqa: E712
    if track_ids is not None:
        stmt = stmt.where(ids_in(Track.id, track_ids))
    if not force:
        stmt = stmt.where(Track.loudness_measured_at.is_(None))
    stmt = stmt.order_by(Track.id)
    if limit is not None:
        stmt = stmt.limit(limit)
    return list(session.exec(stmt).all())


def detect_loudness(session, track_ids: list[int], *, job=None, done: int = 0) -> dict:
    """Measure and store the whole-track loudness of `track_ids` (ffmpeg only reads the files).
    Writes only the loudness columns. A file that fails stores nothing and is tried again next run."""
    from .library_paths import resolve_source_path

    measured = failed = 0
    if not track_ids or stop_requested():
        return {"loudness": 0, "loudness_failed": 0}
    tracks = {t.id: t for t in session.exec(select(Track).where(ids_in(Track.id, track_ids))).all()}
    after_decks = _after_decks(session, job)
    with concurrent.futures.ThreadPoolExecutor(max_workers=_workers()) as ex:
        futures = {}
        for t in tracks.values():
            try:
                futures[ex.submit(after_decks(playback_loudness.measure_file), str(resolve_source_path(t.absolute_path)))] = t.id
            except Exception as exc:  # noqa: BLE001  a path that does not resolve here skips only that track
                logger.warning("loudness_failed track_id=%s error=%s", t.id, exc)
                failed += 1
        done += failed
        for count, finished in enumerate(_completed(futures), start=1):
            child_diagnostics.progress()
            track = tracks[futures[finished]]
            try:
                value = finished.result()
            except Exception as exc:  # noqa: BLE001  one bad file never stops the run
                logger.warning("loudness_failed track_id=%s error=%s", track.id, exc)
                failed += 1
            else:
                playback_loudness.store(track, value)
                session.add(track)
                measured += 1
            if job is not None:
                job.processed = done + count
                session.add(job)
            session.commit()
    return {"loudness": measured, "loudness_failed": failed}


def analyze_all(
    session,
    *,
    force: bool = False,
    limit: int | None = None,
    job=None,
    only_unprocessed: bool = False,
    track_ids: list[int] | None = None,
    local_only: bool = False,
    tempo_range: str = "psy",
    root_ranges: Mapping[str, str] | None = None,
) -> dict:
    """Analyze selected tracks, optionally restricting work to primary local analysis.

    Each track runs in the window of its music folder (`root_ranges`, keyed by
    connected root; the longest prefix wins), else in `tempo_range`.
    """
    from .library_paths import resolve_source_path

    get_range(tempo_range)  # an unknown window fails before any work
    settings = get_settings()
    essentia_ready = not local_only and settings.essentia_enabled
    reccobeats_ready = not local_only and settings.reccobeats_enabled
    getsongbpm_ready = (
        not local_only
        and settings.getsongbpm_enabled
        and settings.getsongbpm_bulk_enabled
        and bool(settings.getsongbpm_api_key)
    )
    cyanite_ready = (
        not local_only
        and settings.cyanite_enabled
        and bool(settings.cyanite_access_token)
    )
    stmt = select(Track).where(Track.missing == False)  # noqa: E712
    if track_ids is not None:
        stmt = stmt.where(ids_in(Track.id, track_ids))
    if only_unprocessed and not force:
        stmt = stmt.where(Track.analyzed_at.is_(None))
    elif not force:
        pending = [
            Track.analyzed_at.is_(None),
        ]
        if essentia_ready:
            pending.append(Track.essentia_analyzed_at.is_(None))
        if reccobeats_ready:
            pending.append(
                and_(
                    Track.bpm_analyzed.is_not(None),
                    or_(
                        and_(
                            Track.bpm_reccobeats.is_(None),
                            Track.reccobeats_error.is_(None),
                        ),
                        and_(
                            Track.reccobeats_track_id.is_(None),
                            Track.reccobeats_catalog_checked_at.is_(None),
                        ),
                    ),
                )
            )
        if getsongbpm_ready:
            pending.append(
                and_(
                    Track.bpm_disagreement == True,  # noqa: E712
                    Track.bpm_getsongbpm.is_(None),
                    Track.getsongbpm_error.is_(None),
                )
            )
        if cyanite_ready:
            pending.extend(
                [
                    and_(
                        Track.bpm_needs_review == True,  # noqa: E712
                        Track.cyanite_track_id.is_(None),
                        Track.cyanite_error.is_(None),
                    ),
                    and_(
                        Track.cyanite_track_id.is_not(None),
                        Track.bpm_cyanite.is_(None),
                        Track.cyanite_status.in_(["not_started", "enqueued", "processing"]),
                    ),
                ]
            )
        stmt = stmt.where(or_(*pending))
    stmt = stmt.order_by(Track.id)
    if limit is not None:
        stmt = stmt.limit(limit)
    tracks = list(session.exec(stmt).all())
    logger.info("analysis stage=tracks-selected count=%s", len(tracks))

    needs_essentia = essentia_ready and any(
        force or track.essentia_analyzed_at is None for track in tracks
    )
    if needs_essentia and (EasyLoader is None or RhythmExtractor2013 is None):
        detail = _ESSENTIA_IMPORT_ERROR or "unknown import failure"
        logger.error("analysis_aborted essentia_unavailable error=%s", detail)
        raise RuntimeError(f"Essentia unavailable: {detail}")

    grid_ids = _grid_targets(session, force=force, track_ids=track_ids, limit=limit)
    first_pass = {t.id for t in tracks if force or t.analyzed_at is None}
    key_ids = _key_targets(session, skip=first_pass, track_ids=track_ids, limit=limit)
    loudness_ids = _loudness_targets(session, force=force, track_ids=track_ids, limit=limit)
    if job is not None:
        job.total = len(tracks) + len(grid_ids) + len(key_ids) + len(loudness_ids)
        session.add(job)
        session.commit()

    by_id = {t.id: t for t in tracks}
    analyzed = failed = validated = validation_failed = 0
    locally_processed: set[int] = set()
    after_decks = _after_decks(session, job)
    with concurrent.futures.ThreadPoolExecutor(max_workers=_workers()) as ex:
        futures = {}
        for track in tracks:
            run_primary = force or track.analyzed_at is None
            run_essentia = essentia_ready and (
                force or track.essentia_analyzed_at is None
            )
            if run_primary or run_essentia:
                path = str(resolve_source_path(track.absolute_path))
                window = get_range(resolve_track_range(path, tempo_range, root_ranges or {}))
                future = ex.submit(
                    after_decks(analyze_file),
                    path,
                    run_primary=run_primary,
                    run_essentia=run_essentia,
                    tempo_range=window,
                )
                futures[future] = (track.id, run_primary, run_essentia)
        for done in _completed(futures):
            child_diagnostics.progress()  # stack dumps only when a file stalls
            tid, ran_primary, ran_essentia = futures[done]
            res = done.result()
            t = by_id[tid]
            now = datetime.now(UTC)
            if ran_primary and t.analyzed_at is not None and (res.error or "").startswith("decode:"):
                # The file could not be read this time (drive unplugged, file gone): keep the last
                # BPM and key, as the grid, key and loudness phases do; the next forced run tries again.
                t.analysis_error = res.error
                failed += 1
            elif ran_primary:
                t.bpm_analyzed = res.bpm
                t.bpm_analyzed_raw = res.bpm_raw
                t.bpm_analyzed_confidence = res.bpm_confidence
                t.bpm_analyzed_method = res.bpm_method
                t.key_analyzed = res.key
                t.key_analyzed_confidence = res.key_confidence
                t.key_analyzed_method = key_detect.METHOD
                t.analyzed_at = now
                t.analysis_error = res.error
                if res.bpm is None and res.key is None:
                    failed += 1
                else:
                    analyzed += 1
            if ran_essentia:
                t.bpm_essentia = res.bpm_essentia
                t.bpm_essentia_confidence = res.bpm_essentia_confidence
                t.bpm_essentia_method = ESSENTIA_METHOD
                t.essentia_analyzed_at = now
                t.essentia_error = res.essentia_error
                if res.bpm_essentia is None:
                    validation_failed += 1
                else:
                    validated += 1
            t.bpm_disagreement, t.bpm_disagreement_percent = bpm_disagreement(
                t.bpm_analyzed,
                t.bpm_essentia,
                settings.bpm_disagreement_percent,
            )
            # A manual fix (or its reset) may have been committed by another
            # session since the rows were loaded; never write a stale consensus back.
            session.refresh(t, attribute_names=_CONSENSUS_COLUMNS)
            _refresh_consensus(t, settings.bpm_disagreement_percent)
            session.add(t)
            locally_processed.add(tid)
            if job is not None:
                job.processed = len(locally_processed)
                job.message = (
                    f"analyzed {analyzed}, failed {failed}, essentia {validated}, "
                    f"validation failed {validation_failed}"
                )
                session.add(job)
            session.commit()

    for t in tracks:
        session.refresh(t, attribute_names=_CONSENSUS_COLUMNS)
        _refresh_consensus(t, settings.bpm_disagreement_percent)

    reccobeats_analyzed = reccobeats_failed = 0
    reccobeats_catalog_matched = reccobeats_catalog_missed = 0
    if reccobeats_ready:
        client = ReccoBeatsClient(
            api_url=settings.reccobeats_api_url,
            ffmpeg=settings.ffmpeg or "ffmpeg",
            timeout_seconds=settings.reccobeats_timeout_seconds,
            clip_start_seconds=settings.reccobeats_clip_start_seconds,
        )
        targets = [
            t
            for t in tracks
            if t.bpm_analyzed is not None
            and (
                force
                or (t.bpm_reccobeats is None and t.reccobeats_error is None)
                or (
                    t.reccobeats_track_id is None
                    and t.reccobeats_catalog_checked_at is None
                )
            )
        ]
        for t in targets:
            if stop_requested():
                break
            now = datetime.now(UTC)
            catalog_result = None
            should_lookup = force or (
                t.reccobeats_track_id is None
                and t.reccobeats_catalog_checked_at is None
            )
            if should_lookup:
                try:
                    if not t.artist or not t.title:
                        raise RuntimeError("artist/title metadata unavailable")
                    catalog_result = client.lookup(
                        artist=t.artist,
                        title=t.title,
                        duration_seconds=t.duration,
                    )
                    t.reccobeats_track_id = catalog_result.track_id
                    t.bpm_reccobeats = catalog_result.bpm
                    t.key_reccobeats = catalog_result.key
                    t.reccobeats_source = catalog_result.source
                    t.reccobeats_catalog_error = None
                    t.reccobeats_error = None
                    reccobeats_catalog_matched += 1
                    reccobeats_analyzed += 1
                except Exception as exc:
                    logger.info(
                        "reccobeats_catalog_miss track_id=%s artist=%r title=%r error=%s",
                        t.id,
                        t.artist,
                        t.title,
                        exc,
                    )
                    t.reccobeats_catalog_error = str(exc)
                    reccobeats_catalog_missed += 1
                t.reccobeats_catalog_checked_at = now

            if catalog_result is None and (
                force or t.bpm_reccobeats is None
            ):
                try:
                    result = client.analyze(str(resolve_source_path(t.absolute_path)), t.duration)
                    t.bpm_reccobeats = result.bpm
                    t.reccobeats_source = result.source
                    t.reccobeats_error = None
                    reccobeats_analyzed += 1
                except Exception as exc:
                    logger.warning(
                        "reccobeats_failed track_id=%s path=%r error=%s",
                        t.id,
                        t.absolute_path,
                        exc,
                    )
                    t.reccobeats_error = str(exc)
                    reccobeats_failed += 1
            t.reccobeats_analyzed_at = now
            if t.bpm_reccobeats is not None:
                t.bpm_disagreement, t.bpm_disagreement_percent = bpm_disagreement(
                    t.bpm_analyzed,
                    t.bpm_reccobeats,
                    settings.bpm_disagreement_percent,
                )
            session.refresh(t, attribute_names=_CONSENSUS_COLUMNS)
            _refresh_consensus(t, settings.bpm_disagreement_percent)
            session.add(t)
            locally_processed.add(t.id)
            if job is not None:
                job.processed = len(locally_processed)
                job.message = (
                    f"ReccoBeats {reccobeats_analyzed}, failed {reccobeats_failed}, "
                    f"catalog {reccobeats_catalog_matched}, "
                    f"catalog misses {reccobeats_catalog_missed}"
                )
                session.add(job)
            session.commit()

    getsongbpm_matched = getsongbpm_failed = 0
    if getsongbpm_ready:
        client = GetSongBpmClient(
            api_url=settings.getsongbpm_api_url,
            api_key=settings.getsongbpm_api_key,
            timeout_seconds=settings.getsongbpm_timeout_seconds,
        )
        targets = [
            t
            for t in tracks
            if t.bpm_disagreement is True
            and (
                force
                or (t.bpm_getsongbpm is None and t.getsongbpm_error is None)
            )
        ]
        for t in targets:
            if stop_requested():
                break
            try:
                if not t.artist or not t.title:
                    raise RuntimeError("artist/title metadata unavailable")
                result = client.lookup(artist=t.artist, title=t.title)
                t.getsongbpm_song_id = result.song_id
                t.bpm_getsongbpm = result.bpm
                t.key_getsongbpm = result.key
                t.getsongbpm_error = None
                getsongbpm_matched += 1
            except Exception as exc:
                logger.warning(
                    "getsongbpm_failed track_id=%s artist=%r title=%r error=%s",
                    t.id,
                    t.artist,
                    t.title,
                    exc,
                )
                t.getsongbpm_error = str(exc)
                getsongbpm_failed += 1
            t.getsongbpm_updated_at = datetime.now(UTC)
            session.refresh(t, attribute_names=_CONSENSUS_COLUMNS)
            _refresh_consensus(t, settings.bpm_disagreement_percent)
            session.add(t)
            locally_processed.add(t.id)
            if job is not None:
                job.processed = len(locally_processed)
                job.message = (
                    f"GetSongBPM {getsongbpm_matched}, "
                    f"failed {getsongbpm_failed}"
                )
                session.add(job)
            session.commit()

    cyanite_submitted = cyanite_finished = cyanite_failed = cyanite_skipped = 0
    if cyanite_ready:
        client = CyaniteClient(
            access_token=settings.cyanite_access_token,
            api_url=settings.cyanite_api_url,
            ffmpeg=settings.ffmpeg or "ffmpeg",
            timeout_seconds=settings.cyanite_timeout_seconds,
        )
        used_credits = len(
            session.exec(
                select(Track.id).where(Track.cyanite_track_id.is_not(None))
            ).all()
        )
        credits_remaining = max(
            0,
            settings.cyanite_analysis_credit_limit - used_credits,
        )
        targets = [t for t in tracks if t.bpm_needs_review is True]
        for t in targets:
            if stop_requested():
                break
            try:
                if t.cyanite_track_id:
                    external = client.fetch(t.cyanite_track_id)
                elif credits_remaining <= 0:
                    cyanite_skipped += 1
                    continue
                else:
                    title = " - ".join(part for part in (t.artist, t.title) if part) or t.file_name
                    external = client.submit(
                        source=str(resolve_source_path(t.absolute_path)),
                        title=title,
                        external_id=f"cratemind-track-{t.id}",
                    )
                    cyanite_submitted += 1
                    credits_remaining -= 1
                _apply_cyanite_result(t, external)
                session.refresh(t, attribute_names=_CONSENSUS_COLUMNS)
                _refresh_consensus(t, settings.bpm_disagreement_percent)
                if external.status == "finished":
                    cyanite_finished += 1
                elif external.error:
                    cyanite_failed += 1
            except Exception as exc:
                logger.warning(
                    "cyanite_failed track_id=%s path=%r error=%s",
                    t.id,
                    t.absolute_path,
                    exc,
                )
                t.cyanite_status = "failed"
                t.cyanite_error = str(exc)
                t.cyanite_updated_at = datetime.now(UTC)
                cyanite_failed += 1
            session.add(t)
            if t.id not in locally_processed:
                locally_processed.add(t.id)
            if job is not None:
                job.processed = len(locally_processed)
                session.add(job)
            session.commit()

    # Last, after every phase that reports progress: provider loops set job.processed themselves.
    grids = detect_grids(session, grid_ids, force=force, job=job, done=len(locally_processed))
    keys = detect_keys(session, key_ids, job=job, done=len(locally_processed) + len(grid_ids))
    loudness = detect_loudness(session, loudness_ids, job=job,
                               done=len(locally_processed) + len(grid_ids) + len(key_ids))

    disagreements = sum(t.bpm_disagreement is True for t in tracks)
    consensus = sum(t.bpm_consensus is not None for t in tracks)
    needs_review = sum(t.bpm_needs_review is True for t in tracks)
    return {
        **grids,
        **keys,
        **loudness,
        "analyzed": analyzed,
        "failed": failed,
        "validated": validated,
        "validation_failed": validation_failed,
        "disagreements": disagreements,
        "reccobeats_analyzed": reccobeats_analyzed,
        "reccobeats_failed": reccobeats_failed,
        "reccobeats_catalog_matched": reccobeats_catalog_matched,
        "reccobeats_catalog_missed": reccobeats_catalog_missed,
        "getsongbpm_matched": getsongbpm_matched,
        "getsongbpm_failed": getsongbpm_failed,
        "consensus": consensus,
        "needs_review": needs_review,
        "cyanite_submitted": cyanite_submitted,
        "cyanite_finished": cyanite_finished,
        "cyanite_failed": cyanite_failed,
        "cyanite_skipped": cyanite_skipped,
        "stopped": stop_requested(),
    }


def _apply_cyanite_result(track: Track, result: CyaniteResult) -> None:
    track.cyanite_track_id = result.track_id
    track.cyanite_status = result.status
    track.bpm_cyanite = result.bpm
    track.bpm_cyanite_range_adjusted = result.bpm_range_adjusted
    track.key_cyanite = result.key
    track.cyanite_error = result.error
    track.cyanite_updated_at = datetime.now(UTC)
