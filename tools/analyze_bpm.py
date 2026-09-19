#!/usr/bin/env python3

import argparse
import concurrent.futures
import os
import sqlite3
import subprocess
import time
from pathlib import Path

import numpy as np
from scipy import signal

try:
    import librosa
except Exception:
    librosa = None


DEFAULT_DB_PATH = Path("/Users/silver/Projects/Music-ReORG/media_catalog.sqlite")
SAMPLE_RATE = 22050
HOP_LENGTH = 512
WINDOW_SECONDS = 120
MIN_BPM = 60
MAX_BPM = 240
BPM_METHOD = "librosa-beat-track-v1"
FALLBACK_METHOD = "ffmpeg+onset-autocorr-v1"
HALF_TEMPO_THRESHOLD = 109.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Estimate BPM for tracks in media_catalog.sqlite")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--workers", type=int, default=max(1, min(8, os.cpu_count() or 4)))
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def ensure_bpm_columns(conn: sqlite3.Connection) -> None:
    existing = {
        row[1]
        for row in conn.execute("PRAGMA table_info(media_files)")
    }
    wanted = {
        "bpm_estimate": "ALTER TABLE media_files ADD COLUMN bpm_estimate REAL",
        "bpm_confidence": "ALTER TABLE media_files ADD COLUMN bpm_confidence REAL",
        "bpm_method": "ALTER TABLE media_files ADD COLUMN bpm_method TEXT",
        "bpm_analyzed_at_epoch": "ALTER TABLE media_files ADD COLUMN bpm_analyzed_at_epoch REAL",
        "bpm_error": "ALTER TABLE media_files ADD COLUMN bpm_error TEXT",
        "bpm_raw_estimate": "ALTER TABLE media_files ADD COLUMN bpm_raw_estimate REAL",
        "bpm_correction": "ALTER TABLE media_files ADD COLUMN bpm_correction TEXT",
    }
    for name, sql in wanted.items():
        if name not in existing:
            conn.execute(sql)
    conn.commit()


def fetch_tracks(conn: sqlite3.Connection, force: bool, limit: int | None) -> list[tuple[int, str]]:
    sql = """
        SELECT id, absolute_path
        FROM media_files
    """
    params: list[object] = []
    if not force:
        sql += " WHERE bpm_estimate IS NULL"
    sql += " ORDER BY id"
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)
    return list(conn.execute(sql, params))


def decode_audio(path: str) -> np.ndarray:
    cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        path,
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-t",
        str(WINDOW_SECONDS),
        "-f",
        "f32le",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", errors="replace").strip() or "ffmpeg decode failed"
        raise RuntimeError(err)
    audio = np.frombuffer(proc.stdout, dtype=np.float32)
    if audio.size == 0:
        raise RuntimeError("decoded audio was empty")
    return audio


def estimate_bpm_from_audio(audio: np.ndarray) -> tuple[float, float]:
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


def estimate_bpm_with_librosa(audio: np.ndarray) -> tuple[float, float]:
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


def analyze_track(row: tuple[int, str]) -> tuple[float | None, float | None, str | None, str | None, float, int]:
    track_id, path = row
    analyzed_at = time.time()
    try:
        audio = decode_audio(path)
        if librosa is not None:
            bpm, confidence = estimate_bpm_with_librosa(audio)
            return bpm, confidence, BPM_METHOD, None, analyzed_at, track_id
        bpm, confidence = estimate_bpm_from_audio(audio)
        return bpm, confidence, FALLBACK_METHOD, None, analyzed_at, track_id
    except Exception as exc:
        if librosa is not None:
            try:
                audio = decode_audio(path)
                bpm, confidence = estimate_bpm_from_audio(audio)
                return bpm, confidence, FALLBACK_METHOD, None, analyzed_at, track_id
            except Exception:
                pass
        return None, None, None, str(exc), analyzed_at, track_id


def corrected_bpm(bpm: float | None) -> tuple[float | None, str | None]:
    if bpm is None:
        return None, None
    if bpm < HALF_TEMPO_THRESHOLD:
        return round(bpm * 2.0, 2), f"doubled_below_{int(HALF_TEMPO_THRESHOLD)}"
    return bpm, None


def main() -> int:
    args = parse_args()
    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA busy_timeout = 5000")
    ensure_bpm_columns(conn)
    rows = fetch_tracks(conn, args.force, args.limit)
    conn.close()

    if not rows:
        print("No tracks need BPM analysis.")
        return 0

    workers = max(1, args.workers)
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        for result in executor.map(analyze_track, rows, chunksize=8):
            results.append(result)

    write_conn = sqlite3.connect(args.db)
    write_conn.execute("PRAGMA busy_timeout = 5000")
    write_conn.executemany(
        """
        UPDATE media_files
        SET bpm_estimate = ?,
            bpm_raw_estimate = ?,
            bpm_confidence = ?,
            bpm_method = ?,
            bpm_analyzed_at_epoch = ?,
            bpm_error = ?,
            bpm_correction = ?
        WHERE id = ?
        """,
        [
            (
                corrected_bpm(bpm)[0],
                bpm,
                confidence,
                method,
                analyzed_at,
                error,
                corrected_bpm(bpm)[1],
                track_id,
            )
            for bpm, confidence, method, error, analyzed_at, track_id in results
        ],
    )
    write_conn.commit()
    write_conn.close()

    ok = sum(1 for bpm, _, _, error, _, _ in results if bpm is not None and error is None)
    failed = len(results) - ok
    print(f"Analyzed BPM for {ok} tracks; {failed} failed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
