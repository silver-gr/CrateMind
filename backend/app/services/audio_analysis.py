"""Audio analysis: estimate BPM and musical key from the audio itself.

Read-only on source files (ffmpeg decode only). Results are written to the
Track.*_analyzed columns by analyze_all — never to embedded tags, and never to
the tag-derived bpm/key_text fields. BPM logic is ported from the standalone
analyze_bpm.py; key detection (librosa chroma → Krumhansl-Schmuckler) is new.
"""
from __future__ import annotations

import concurrent.futures
import logging
import threading
import time
import os
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Optional

import numpy as np
from sqlalchemy import and_, or_
from scipy import signal
from sqlmodel import select
from ..config import get_settings

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
from .bpm_validation import GetSongBpmClient, ReccoBeatsClient
from .cyanite import CyaniteClient, CyaniteResult

SAMPLE_RATE = 22050
HOP_LENGTH = 512
WINDOW_SECONDS = 120
MIN_BPM = 60
MAX_BPM = 240
BPM_METHOD = "librosa-onset-multilag-v2"
FALLBACK_METHOD = "ffmpeg+onset-autocorr-v1"
ESSENTIA_METHOD = "essentia-rhythmextractor2013-multifeature-v1"
HALF_TEMPO_THRESHOLD = 109.0

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
    cmd = [
        "ffmpeg", "-nostdin", "-v", "error", "-ss", str(start), "-i", path,
        "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-t", str(seconds), "-f", "f32le", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, check=False, timeout=180)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", errors="replace").strip() or "ffmpeg decode failed"
        raise RuntimeError(err)
    audio = np.frombuffer(proc.stdout, dtype=np.float32)
    if audio.size == 0:
        raise RuntimeError("decoded audio was empty")
    return audio


def _estimate_bpm_librosa(audio: np.ndarray) -> tuple[float, float]:
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
    grid = np.arange(135, 286.001, .02)
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


def _corrected_bpm(bpm: float) -> float:
    """Double sub-threshold tempos so half-time detections land in DJ range."""
    if bpm < HALF_TEMPO_THRESHOLD:
        return round(bpm * 2.0, 2)
    return round(bpm, 2)


def estimate_bpm(audio: np.ndarray) -> tuple[float, float, float, str]:
    """librosa primary, numpy autocorr fallback. Returns
    (corrected_bpm, raw_bpm, confidence, method)."""
    try:
        raw, conf = _estimate_bpm_librosa(audio)
        method = BPM_METHOD
    except Exception:
        raw, conf = _estimate_bpm_autocorr(audio)
        method = FALLBACK_METHOD
    return _corrected_bpm(raw), round(raw, 2), conf, method



def estimate_file_bpm(path: str, intro_audio: np.ndarray) -> tuple[float, float, float, str]:
    """Match the validated three-section benchmark; tolerate short tracks."""
    results = []
    for start in (30, 120, 210):
        try:
            if start == 30:
                section = intro_audio[30 * SAMPLE_RATE:90 * SAMPLE_RATE]
            else:
                section = decode_audio(path, start=start, seconds=60)
            if section.size < SAMPLE_RATE * 10:
                continue
            results.append(estimate_bpm(section))
        except (RuntimeError, subprocess.TimeoutExpired):
            continue
    if not results:
        return estimate_bpm(intro_audio)
    # Never blend fallback estimates into a successful refined estimate.
    refined = [result for result in results if result[3] == BPM_METHOD]
    selected = refined or results
    return (
        round(float(np.median([r[0] for r in selected])), 2),
        round(float(np.median([r[1] for r in selected])), 2),
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


def bpm_disagreement(
    primary: Optional[float],
    secondary: Optional[float],
    threshold_percent: float,
) -> tuple[Optional[bool], Optional[float]]:
    """Compare BPMs after resolving common half/double-time ambiguity."""
    if primary is None or secondary is None or primary <= 0 or secondary <= 0:
        return None, None
    equivalent = min(
        (secondary / 2.0, secondary, secondary * 2.0),
        key=lambda candidate: abs(candidate - primary),
    )
    difference = abs(equivalent - primary) / primary * 100.0
    rounded = round(difference, 3)
    return rounded > max(0.0, threshold_percent), rounded


def _octave_adjusted(bpm: float, anchor: float) -> float:
    return min((bpm / 2.0, bpm, bpm * 2.0), key=lambda candidate: abs(candidate - anchor))


def bpm_consensus(
    votes: list[tuple[str, Optional[float]]],
    threshold_percent: float,
) -> tuple[Optional[float], Optional[str]]:
    """Return unique two-vote-or-better BPM cluster after octave normalization."""
    valid = [
        (source, float(value))
        for source, value in votes
        if value is not None and np.isfinite(value) and value > 0
    ]
    if len(valid) < 2:
        return None, None

    threshold = max(0.0, threshold_percent)
    clusters: dict[frozenset[str], tuple[float, list[tuple[str, float]]]] = {}
    for _anchor_source, anchor in valid:
        members = []
        for source, value in valid:
            adjusted = _octave_adjusted(value, anchor)
            difference = abs(adjusted - anchor) / anchor * 100.0
            if difference <= threshold:
                members.append((source, adjusted))
        if len(members) < 2:
            continue
        source_set = frozenset(source for source, _value in members)
        spread = float(np.std([value for _source, value in members]))
        current = clusters.get(source_set)
        if current is None or spread < current[0]:
            clusters[source_set] = (spread, members)

    if not clusters:
        return None, None
    largest = max(len(source_set) for source_set in clusters)
    winners = [
        (source_set, cluster)
        for source_set, cluster in clusters.items()
        if len(source_set) == largest
    ]
    if len(winners) != 1:
        return None, None

    source_set, (_spread, members) = winners[0]
    consensus = _corrected_bpm(float(np.median([value for _source, value in members])))
    source_order = [source for source, _value in valid if source in source_set]
    return consensus, "+".join(source_order)


def _refresh_consensus(track: Track, threshold_percent: float) -> None:
    comparison = track.bpm_reccobeats or track.bpm_essentia
    track.bpm_disagreement, track.bpm_disagreement_percent = bpm_disagreement(
        track.bpm_analyzed,
        comparison,
        threshold_percent,
    )

    if (
        track.bpm_consensus_sources
        and track.bpm_consensus_sources.startswith("manual:")
        and track.bpm_consensus is not None
        and np.isfinite(track.bpm_consensus)
        and track.bpm_consensus > 0
    ):
        track.bpm_needs_review = False
        return

    if track.bpm is not None and np.isfinite(track.bpm) and track.bpm > 0:
        track.bpm_consensus = round(float(track.bpm), 2)
        track.bpm_consensus_sources = "metadata"
        track.bpm_needs_review = False
        return

    cyanite_bpm = track.bpm_cyanite_range_adjusted or track.bpm_cyanite
    votes = [
        ("local", track.bpm_analyzed),
        ("essentia", track.bpm_essentia),
        ("reccobeats", track.bpm_reccobeats),
        ("getsongbpm", track.bpm_getsongbpm),
        ("cyanite", cyanite_bpm),
    ]
    track.bpm_consensus, track.bpm_consensus_sources = bpm_consensus(
        votes,
        threshold_percent,
    )
    has_analysis_vote = any(
        value is not None and np.isfinite(value) and value > 0
        for _source, value in votes
    )
    track.bpm_needs_review = has_analysis_vote and track.bpm_consensus is None


def analyze_file(
    path: str,
    *,
    run_primary: bool = True,
    run_essentia: bool = True,
) -> AnalysisResult:
    """Run requested local engines for one file. Captures errors per engine."""
    res = AnalysisResult()
    if run_primary:
        try:
            audio = decode_audio(path)
        except Exception as exc:
            logger.warning("audio_decode_failed path=%r error=%s", path, exc)
            res.error = f"decode: {exc}"
        else:
            try:
                bpm, raw, conf, method = estimate_file_bpm(path, audio)
                res.bpm, res.bpm_raw = bpm, raw
                res.bpm_confidence, res.bpm_method = conf, method
            except Exception as exc:
                logger.warning("librosa_bpm_failed path=%r error=%s", path, exc)
                res.error = f"bpm: {exc}"
            try:
                key, kconf = estimate_key(audio)
                res.key, res.key_confidence = key, kconf
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


def analyze_all(
    session,
    *,
    force: bool = False,
    limit: int | None = None,
    job=None,
    only_unprocessed: bool = False,
    track_ids: list[int] | None = None,
    local_only: bool = False,
) -> dict:
    """Analyze selected tracks, optionally restricting work to primary local analysis."""
    from .library_paths import resolve_source_path

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
        stmt = stmt.where(Track.id.in_(track_ids))
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
                future = ex.submit(
                    analyze_file,
                    str(resolve_source_path(track.absolute_path)),
                    run_primary=run_primary,
                    run_essentia=run_essentia,
                )
                futures[future] = (track.id, run_primary, run_essentia)
        for done in concurrent.futures.as_completed(futures):
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
