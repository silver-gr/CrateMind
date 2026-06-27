"""Audio analysis: estimate BPM and musical key from the audio itself.

Read-only on source files (ffmpeg decode only). Results are written to the
Track.*_analyzed columns by analyze_all — never to embedded tags, and never to
the tag-derived bpm/key_text fields. BPM logic is ported from the standalone
analyze_bpm.py; key detection (librosa chroma → Krumhansl-Schmuckler) is new.
"""
from __future__ import annotations

import concurrent.futures
import os
import subprocess
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

import numpy as np
from scipy import signal
from sqlmodel import select

try:  # librosa is a hard dependency, but stay defensive so import never crashes
    import librosa
except Exception:  # pragma: no cover
    librosa = None

from ..models import Track

SAMPLE_RATE = 22050
HOP_LENGTH = 512
WINDOW_SECONDS = 120
MIN_BPM = 60
MAX_BPM = 240
BPM_METHOD = "librosa-tempo-v1"
FALLBACK_METHOD = "ffmpeg+onset-autocorr-v1"
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


def _workers() -> int:
    return max(1, min(8, os.cpu_count() or 4))


def decode_audio(path: str) -> np.ndarray:
    """Decode the first WINDOW_SECONDS of `path` to mono float32 @ SAMPLE_RATE.
    Read-only: ffmpeg only reads the source file."""
    cmd = [
        "ffmpeg", "-v", "error", "-i", path,
        "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-t", str(WINDOW_SECONDS), "-f", "f32le", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, check=False)
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
    onset_env = librosa.onset.onset_strength(y=audio, sr=SAMPLE_RATE)
    if onset_env.size == 0:
        raise RuntimeError("empty onset envelope")
    tempo = librosa.feature.tempo(onset_envelope=onset_env, sr=SAMPLE_RATE, aggregate=None)
    if tempo.size == 0:
        raise RuntimeError("librosa returned no tempo candidates")
    median_tempo = float(np.median(tempo))
    spread = float(np.std(tempo))
    confidence = max(0.0, min(1.0, 1.0 - (spread / max(median_tempo, 1.0))))
    return round(median_tempo, 2), round(confidence, 4)


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


def analyze_file(path: str) -> AnalysisResult:
    """Decode + estimate BPM and key for one file. Captures errors per stage."""
    try:
        audio = decode_audio(path)
    except Exception as exc:
        return AnalysisResult(error=f"decode: {exc}")
    res = AnalysisResult()
    try:
        bpm, raw, conf, method = estimate_bpm(audio)
        res.bpm, res.bpm_raw, res.bpm_confidence, res.bpm_method = bpm, raw, conf, method
    except Exception as exc:
        res.error = f"bpm: {exc}"
    try:
        key, kconf = estimate_key(audio)
        res.key, res.key_confidence = key, kconf
    except Exception as exc:
        res.error = (res.error + "; " if res.error else "") + f"key: {exc}"
    return res


def analyze_all(session, *, force: bool = False, limit: Optional[int] = None, job=None) -> dict:
    """Analyze library tracks and write results to the *_analyzed columns.

    Decoding/estimation runs on a thread pool; DB writes are serialized in the
    calling thread (one SQLite Session). Never touches bpm/key_text or files.
    """
    stmt = select(Track).where(Track.missing == False)  # noqa: E712
    if not force:
        stmt = stmt.where(Track.analyzed_at.is_(None))
    stmt = stmt.order_by(Track.id)
    if limit is not None:
        stmt = stmt.limit(limit)
    tracks = list(session.exec(stmt).all())

    if job is not None:
        job.total = len(tracks)
        session.add(job)
        session.commit()

    by_id = {t.id: t for t in tracks}
    analyzed = failed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=_workers()) as ex:
        futures = {ex.submit(analyze_file, t.absolute_path): t.id for t in tracks}
        for done in concurrent.futures.as_completed(futures):
            tid = futures[done]
            res = done.result()
            t = by_id[tid]
            t.bpm_analyzed = res.bpm
            t.bpm_analyzed_raw = res.bpm_raw
            t.bpm_analyzed_confidence = res.bpm_confidence
            t.bpm_analyzed_method = res.bpm_method
            t.key_analyzed = res.key
            t.key_analyzed_confidence = res.key_confidence
            t.analyzed_at = datetime.utcnow()
            t.analysis_error = res.error
            session.add(t)
            if res.bpm is None and res.key is None:
                failed += 1
            else:
                analyzed += 1
            if job is not None:
                job.processed = analyzed + failed
                job.message = f"analyzed {analyzed}, failed {failed}"
                session.add(job)
            session.commit()
    return {"analyzed": analyzed, "failed": failed}
