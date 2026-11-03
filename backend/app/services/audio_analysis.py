"""Audio analysis: estimate BPM and musical key from the audio itself.

Read-only on source files (ffmpeg decode only). Results are written to the
Track.*_analyzed columns by analyze_all — never to embedded tags, and never to
the tag-derived bpm/key_text fields. BPM logic is ported from the standalone
analyze_bpm.py; key detection (librosa chroma → Krumhansl-Schmuckler) is new.
"""
from __future__ import annotations

import concurrent.futures
import logging
import math
import threading
import time
import os
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Mapping, Optional

import numpy as np
from sqlalchemy import and_, or_
from scipy import signal
from sqlmodel import select
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

from ..models import Track
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
from .tempo_ranges import TEMPO_RANGES, TempoRange, fold_into, get_range, resolve_track_range
from .cyanite import CyaniteClient, CyaniteResult

SAMPLE_RATE = 22050
HOP_LENGTH = 512
WINDOW_SECONDS = 120
MIN_BPM = 60
MAX_BPM = 240
BPM_METHOD = TEMPO_RANGES["psy"].method               # "librosa-onset-multilag-v2@133-286"
FALLBACK_METHOD = TEMPO_RANGES["psy"].fallback_method  # "ffmpeg+onset-autocorr-v1@133-286"
ESSENTIA_METHOD = "essentia-rhythmextractor2013-multifeature-v1"

# Krumhansl-Schmuckler key profiles (Temperley-normalised major/minor weights).
_KS_MAJOR = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
)
_KS_MINOR = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
)
_PITCHES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


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
        selected = [
            (octave_fold(r[0], anchor), octave_fold(r[1], anchor), r[2], r[3])
            for r in selected
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


def estimate_key(audio: np.ndarray) -> tuple[Optional[str], Optional[float]]:
    """librosa chroma → Krumhansl-Schmuckler correlation → best musical key.
    Returns a key string the recommender's to_camelot understands, e.g.
    "A minor" / "F# major"."""
    if librosa is None:
        raise RuntimeError("librosa not available")
    if audio.size < SAMPLE_RATE * 10:
        raise RuntimeError("audio too short for key analysis")
    chroma = librosa.feature.chroma_cqt(y=audio, sr=SAMPLE_RATE, hop_length=HOP_LENGTH)
    if chroma.size == 0:
        raise RuntimeError("empty chroma")
    vec = np.mean(chroma, axis=1)
    if float(np.sum(vec)) <= 1e-9:
        raise RuntimeError("flat chroma")

    best_corr = -2.0
    best_key: Optional[str] = None
    for i in range(12):
        maj = float(np.corrcoef(np.roll(_KS_MAJOR, i), vec)[0, 1])
        minr = float(np.corrcoef(np.roll(_KS_MINOR, i), vec)[0, 1])
        if maj > best_corr:
            best_corr, best_key = maj, f"{_PITCHES[i]} major"
        if minr > best_corr:
            best_corr, best_key = minr, f"{_PITCHES[i]} minor"
    confidence = max(0.0, min(1.0, (best_corr + 1.0) / 2.0))
    return best_key, round(confidence, 4)


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
            audio = decode_audio(path)
        except Exception as exc:
            logger.warning("audio_decode_failed path=%r error=%s", path, exc)
            res.error = f"decode: {exc}"
        else:
            logger.debug("analysis_file stage=decode-done samples=%s", audio.size)
            try:
                bpm, raw, conf, method = estimate_file_bpm(path, audio, tempo_range)
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

    if job is not None:
        job.total = len(tracks)
        session.add(job)
        session.commit()

    by_id = {t.id: t for t in tracks}
    analyzed = failed = validated = validation_failed = 0
    locally_processed: set[int] = set()
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
                    analyze_file,
                    path,
                    run_primary=run_primary,
                    run_essentia=run_essentia,
                    tempo_range=window,
                )
                futures[future] = (track.id, run_primary, run_essentia)
        for done in concurrent.futures.as_completed(futures):
            child_diagnostics.progress()  # stack dumps only when a file stalls
            tid, ran_primary, ran_essentia = futures[done]
            res = done.result()
            t = by_id[tid]
            now = datetime.now(UTC)
            if ran_primary:
                t.bpm_analyzed = res.bpm
                t.bpm_analyzed_raw = res.bpm_raw
                t.bpm_analyzed_confidence = res.bpm_confidence
                t.bpm_analyzed_method = res.bpm_method
                t.key_analyzed = res.key
                t.key_analyzed_confidence = res.key_confidence
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

    disagreements = sum(t.bpm_disagreement is True for t in tracks)
    consensus = sum(t.bpm_consensus is not None for t in tracks)
    needs_review = sum(t.bpm_needs_review is True for t in tracks)
    return {
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
    }


def _apply_cyanite_result(track: Track, result: CyaniteResult) -> None:
    track.cyanite_track_id = result.track_id
    track.cyanite_status = result.status
    track.bpm_cyanite = result.bpm
    track.bpm_cyanite_range_adjusted = result.bpm_range_adjusted
    track.key_cyanite = result.key
    track.cyanite_error = result.error
    track.cyanite_updated_at = datetime.now(UTC)
