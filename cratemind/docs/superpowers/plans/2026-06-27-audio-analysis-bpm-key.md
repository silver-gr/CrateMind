# Audio Analysis (BPM + Key) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a background job to CrateMind that computes BPM and musical key from the audio itself (librosa), stores results in dedicated columns that never overwrite tag-derived values, and feeds them to the recommender and Set Builder curves via a tag-first fallback.

**Architecture:** A new pure-Python service (`audio_analysis.py`) decodes audio via ffmpeg and estimates BPM (ported verbatim from the legacy `analyze_bpm.py`) and key (new librosa chroma → Krumhansl-Schmuckler). A threaded job (`worker._run_analyze`) writes results to new `Track.*_analyzed` columns. `effective_bpm`/`effective_key` helpers in the recommender (tag value first, analyzed fallback) are consumed by the recommender and the Set Builder analysis endpoint. The frontend gains a Settings trigger and shows analyzed values with a `~` marker where no tag value exists.

**Tech Stack:** FastAPI, SQLModel/SQLite, librosa/numpy/scipy, ffmpeg (subprocess, decode-only), React 18 + TS + Vite.

## Global Constraints

- **Data-safety invariant:** audio is decoded **read-only** (ffmpeg `-f f32le`, first 120 s). NEVER modify, move, or retag source files. ALL writes go to new `Track` columns. NEVER write ID3 tags, NEVER touch `bpm`/`key_text`.
- **Provenance:** analyzed values live in separate columns. Tag-derived `bpm`/`key_text` are never overwritten.
- **Effective value:** recommender + Set Builder curves use `effective_*` = tag value when present, else analyzed.
- **Python ≥ 3.11**, `from __future__ import annotations` at top of every backend module.
- **UI copy is Greek by default**; keep English only for established terms (`BPM`, `key`, `M3U8`).
- **TDD:** write the failing test first, watch it fail, implement, watch it pass, commit.
- Backend tests: `cd backend && . .venv/bin/activate && pytest`. Frontend type-check: `cd frontend && npm run build`.
- Run all backend git/test commands with the repo's `rtk` prefix where applicable.

---

## File Ownership & Parallelization Map

**Each task owns a disjoint set of files — no two tasks ever edit the same file**, so independent tasks in the same wave can run as parallel agents/workflow stages with zero merge conflicts.

| Task | Owns (create/modify) | Depends on |
|------|----------------------|------------|
| A. Dependencies | `backend/pyproject.toml` | — |
| B. ffmpeg detection | `backend/app/config.py`, `backend/app/main.py`, `backend/tests/test_config_ffmpeg.py` | — |
| C. Schema + migration | `backend/app/models.py`, `backend/app/db.py`, `backend/tests/test_schema_analysis.py` | — |
| D. Analysis service | `backend/app/services/audio_analysis.py`, `backend/tests/test_audio_analysis.py` | A, C |
| E. Recommender fallback | `backend/app/services/recommender.py`, `backend/tests/test_recommender.py` | C |
| F. Job + API | `backend/app/jobs/worker.py`, `backend/app/api/scan.py`, `backend/app/schemas.py`, `backend/tests/test_analyze_api.py` | B, D |
| G. Set Builder curves | `backend/app/api/sets.py`, `backend/tests/test_sets_effective.py` | C, E |
| H. FE types | `frontend/src/lib/types.ts` | — |
| I. FE api client | `frontend/src/lib/api.ts` | — |
| J. FE labels | `frontend/src/lib/labels.ts` | — |
| K. FE Settings trigger | `frontend/src/pages/Settings.tsx` | H, I, J |
| L. FE ProfileEditor display | `frontend/src/components/ProfileEditor.tsx` | H |
| M. FE TrackTable display | `frontend/src/components/TrackTable.tsx` | H |
| N. Docs | `README.md` | — |

### Execution waves (each wave's tasks run in parallel)

- **Wave 0 (7 parallel):** A, B, C, H, I, J, N
- **Wave 1 (5 parallel):** D *(A,C)*, E *(C)*, K *(H,I,J)*, L *(H)*, M *(H)*
- **Wave 2 (2 parallel):** F *(B,D)*, G *(C,E)*
- **Wave 3 (serial):** Final integration — install deps, full `pytest`, `npm run build`, commit.

> **Hot-file note:** Task A edits `pyproject.toml` and Task D *runs* against the installed deps — D must start only after A's `pip install` completes. The Wave boundaries already enforce this.

### Workflow execution sketch (optional, for the Workflow tool)

```
pipeline over backend+frontend lanes:
  wave0 = parallel([A, B, C, H, I, J, N])        // barrier: all schema/deps/types land
  wave1 = parallel([D, E, K, L, M])              // needs wave0
  wave2 = parallel([F, G])                       // needs D,E (+B,C)
  wave3 = integration()                          // serial verify+commit
```
Each task is a self-contained subagent prompt: "implement Task X from docs/superpowers/plans/2026-06-27-audio-analysis-bpm-key.md, run its tests, report pass/fail." Run a verifier pass on D, E, F, G (the logic-bearing tasks) before the Wave-3 commit.

---

## Task A: Dependencies

**Files:**
- Modify: `backend/pyproject.toml` (dependencies array)

**Interfaces:**
- Produces: `librosa`, `numpy`, `scipy` importable in the backend venv.

- [ ] **Step 1: Add DSP deps to `pyproject.toml`**

In `[project].dependencies`, add three entries (keep the existing ones):

```toml
    "librosa>=0.10",
    "numpy>=1.24",
    "scipy>=1.11",
```

- [ ] **Step 2: Install**

Run: `cd backend && . .venv/bin/activate && pip install -e ".[dev]"`
Expected: resolves and installs librosa + numba/llvmlite + soundfile transitively. (This is slow — run in background if available.)

- [ ] **Step 3: Verify import**

Run: `cd backend && . .venv/bin/activate && python -c "import librosa, numpy, scipy; print(librosa.__version__)"`
Expected: prints a version ≥ `0.10`.

- [ ] **Step 4: Commit**

```bash
rtk git add backend/pyproject.toml && rtk git commit -m "feat(deps): add librosa/numpy/scipy for audio analysis"
```

---

## Task B: ffmpeg detection

**Files:**
- Modify: `backend/app/config.py` (add field + property)
- Modify: `backend/app/main.py` (expose on /health and /settings)
- Test: `backend/tests/test_config_ffmpeg.py`

**Interfaces:**
- Produces: `Settings.ffmpeg -> str | None`; `/api/health` and `/api/settings` include an `ffmpeg` key.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_config_ffmpeg.py`:

```python
"""ffmpeg is detected and surfaced on the health/settings endpoints."""
from __future__ import annotations


def test_health_reports_ffmpeg_key(client):
    body = client.get("/api/health").json()
    assert "ffmpeg" in body
    assert isinstance(body["ffmpeg"], bool)


def test_settings_reports_ffmpeg_key(client):
    body = client.get("/api/settings").json()
    assert "ffmpeg" in body
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && . .venv/bin/activate && pytest tests/test_config_ffmpeg.py -v`
Expected: FAIL — `"ffmpeg" not in body`.

- [ ] **Step 3: Add the config field + property**

In `backend/app/config.py`, add a field next to `fpcalc_path` (after line `fpcalc_path: str = ""`):

```python
    ffmpeg_path: str = ""
```

And add a property next to the `fpcalc` property:

```python
    @property
    def ffmpeg(self) -> str | None:
        return self.ffmpeg_path or shutil.which("ffmpeg")
```

- [ ] **Step 4: Expose on the endpoints**

In `backend/app/main.py`, in `health()` add to the returned dict (next to `"fpcalc"`):

```python
        "ffmpeg": bool(settings.ffmpeg),
```

In `read_settings()` add to the returned dict (next to `"fpcalc": s.fpcalc`):

```python
        "ffmpeg": s.ffmpeg,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && . .venv/bin/activate && pytest tests/test_config_ffmpeg.py -v`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
rtk git add backend/app/config.py backend/app/main.py backend/tests/test_config_ffmpeg.py
rtk git commit -m "feat(config): detect ffmpeg on PATH, expose on health/settings"
```

---

## Task C: Schema columns + idempotent migration

**Files:**
- Modify: `backend/app/models.py` (add 8 columns to `Track`)
- Modify: `backend/app/db.py` (add `ensure_track_columns()`, call in `init_db()`)
- Test: `backend/tests/test_schema_analysis.py`

**Interfaces:**
- Produces: `Track.bpm_analyzed`, `bpm_analyzed_raw`, `bpm_analyzed_confidence`, `bpm_analyzed_method`, `key_analyzed`, `key_analyzed_confidence`, `analyzed_at`, `analysis_error` (all nullable). These columns exist on both fresh and pre-existing DBs after `init_db()`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_schema_analysis.py`:

```python
"""Audio-analysis columns exist after init and never collide with tag columns."""
from __future__ import annotations

from sqlalchemy import text

import app.db as dbmod
from app.models import Track

ANALYSIS_COLS = {
    "bpm_analyzed", "bpm_analyzed_raw", "bpm_analyzed_confidence",
    "bpm_analyzed_method", "key_analyzed", "key_analyzed_confidence",
    "analyzed_at", "analysis_error",
}


def test_analysis_columns_present(db):
    cols = {row[1] for row in db.exec(text("PRAGMA table_info(tracks)"))}
    assert ANALYSIS_COLS <= cols
    # tag columns are untouched and distinct
    assert {"bpm", "key_text"} <= cols
    assert "bpm" not in ANALYSIS_COLS


def test_ensure_track_columns_is_idempotent(db):
    dbmod.ensure_track_columns()
    dbmod.ensure_track_columns()  # second call must not raise
    cols = {row[1] for row in db.exec(text("PRAGMA table_info(tracks)"))}
    assert ANALYSIS_COLS <= cols


def test_track_model_roundtrips_analyzed_fields(db):
    t = Track(absolute_path="/x.wav", bpm=150, key_text="Am",
              bpm_analyzed=128.0, key_analyzed="A minor", missing=False)
    db.add(t)
    db.commit()
    db.refresh(t)
    assert t.bpm == 150 and t.bpm_analyzed == 128.0
    assert t.key_text == "Am" and t.key_analyzed == "A minor"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && . .venv/bin/activate && pytest tests/test_schema_analysis.py -v`
Expected: FAIL — analysis columns missing / `Track` has no attribute `bpm_analyzed`.

- [ ] **Step 3: Add columns to the `Track` model**

In `backend/app/models.py`, inside `class Track`, immediately after the `key_text`/`rating` tag fields and before the `# content identity` block, add:

```python
    # audio analysis — computed from the audio itself; NEVER overwrites the
    # tag-derived bpm/key_text above. See services/audio_analysis.py.
    bpm_analyzed: Optional[float] = None
    bpm_analyzed_raw: Optional[float] = None
    bpm_analyzed_confidence: Optional[float] = None
    bpm_analyzed_method: Optional[str] = None
    key_analyzed: Optional[str] = None
    key_analyzed_confidence: Optional[float] = None
    analyzed_at: Optional[datetime] = None
    analysis_error: Optional[str] = None
```

- [ ] **Step 4: Add the migration helper in `db.py`**

In `backend/app/db.py`, add this function (after `init_db`):

```python
def ensure_track_columns() -> None:
    """Idempotently add audio-analysis columns to a pre-existing tracks table.

    The repo has no Alembic; fresh DBs get these columns from
    SQLModel.metadata.create_all, but a DB created before this feature needs the
    ALTERs. Safe to call on every launch.
    """
    wanted = {
        "bpm_analyzed": "REAL",
        "bpm_analyzed_raw": "REAL",
        "bpm_analyzed_confidence": "REAL",
        "bpm_analyzed_method": "TEXT",
        "key_analyzed": "TEXT",
        "key_analyzed_confidence": "REAL",
        "analyzed_at": "TIMESTAMP",
        "analysis_error": "TEXT",
    }
    engine = get_engine()
    with engine.connect() as conn:
        existing = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(tracks)")}
        for name, sqltype in wanted.items():
            if name not in existing:
                conn.exec_driver_sql(f"ALTER TABLE tracks ADD COLUMN {name} {sqltype}")
        conn.commit()
```

Then call it inside `init_db()`, on the line immediately after `conn.commit()` at the end of the existing `with engine.connect()` block:

```python
    ensure_track_columns()
```

(Place the call after the existing `with engine.connect() as conn:` block in `init_db`, so the table exists first.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && . .venv/bin/activate && pytest tests/test_schema_analysis.py -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
rtk git add backend/app/models.py backend/app/db.py backend/tests/test_schema_analysis.py
rtk git commit -m "feat(db): add audio-analysis columns + idempotent migration"
```

---

## Task D: Analysis service (BPM + key)

**Files:**
- Create: `backend/app/services/audio_analysis.py`
- Test: `backend/tests/test_audio_analysis.py`

**Interfaces:**
- Consumes: `Track` (+ analyzed columns from Task C).
- Produces:
  - `AnalysisResult` dataclass: `bpm, bpm_raw, bpm_confidence, bpm_method, key, key_confidence, error` (all Optional).
  - `decode_audio(path: str) -> np.ndarray`
  - `estimate_bpm(audio: np.ndarray) -> tuple[float, float, float, str]` → `(corrected_bpm, raw_bpm, confidence, method)`
  - `estimate_key(audio: np.ndarray) -> tuple[str | None, float | None]`
  - `analyze_file(path: str) -> AnalysisResult`
  - `analyze_all(session, *, force=False, limit=None, job=None) -> dict` → `{"analyzed": int, "failed": int}`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_audio_analysis.py`:

```python
"""BPM + key estimation and the analyze_all DB writer.

DSP tests use synthesized numpy arrays (no ffmpeg, no real files) so they are
fast and hermetic. analyze_all is tested with analyze_file monkeypatched, so it
exercises selection/idempotency without decoding audio.
"""
from __future__ import annotations

import numpy as np

from app.models import Track
from app.services import audio_analysis as aa

SR = aa.SAMPLE_RATE


def _sine(freq: float, seconds: float = 12.0) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    return np.sin(2 * np.pi * freq * t).astype(np.float32)


def _click_track(bpm: float, seconds: float = 20.0) -> np.ndarray:
    audio = np.zeros(int(SR * seconds), dtype=np.float32)
    step = int(SR * 60.0 / bpm)
    audio[::step] = 1.0  # impulses at the beat
    return audio


def test_estimate_bpm_recovers_tempo():
    bpm, raw, conf, method = aa.estimate_bpm(_click_track(120.0))
    # accept the tempo or its octaves (120/60/240)
    assert min(abs(bpm - 120), abs(bpm - 60), abs(bpm - 240)) < 8
    assert 0.0 <= conf <= 1.0
    assert method in (aa.BPM_METHOD, aa.FALLBACK_METHOD)


def test_estimate_key_returns_valid_key():
    # C-major triad → tonic C or a member of the C-major / A-minor family
    audio = _sine(261.63) + _sine(329.63) + _sine(392.00)
    key, conf = aa.estimate_key(audio.astype(np.float32))
    assert key is not None
    assert key.split()[0] in {"C", "A", "E", "G", "D", "F"}
    assert key.endswith("major") or key.endswith("minor")
    assert 0.0 <= conf <= 1.0


def test_analyze_file_bad_path_sets_error():
    res = aa.analyze_file("/no/such/file.wav")
    assert res.error is not None
    assert res.bpm is None and res.key is None


def test_analyze_all_writes_and_is_idempotent(db, monkeypatch):
    monkeypatch.setattr(aa, "analyze_file", lambda path: aa.AnalysisResult(
        bpm=128.0, bpm_raw=128.0, bpm_confidence=0.9,
        bpm_method=aa.BPM_METHOD, key="A minor", key_confidence=0.8))
    for i in range(2):
        db.add(Track(absolute_path=f"/t{i}.wav", missing=False))
    db.commit()

    first = aa.analyze_all(db, force=False)
    assert first["analyzed"] == 2
    t0 = db.exec(__import__("sqlmodel").select(Track)).first()
    assert t0.bpm_analyzed == 128.0 and t0.key_analyzed == "A minor"
    assert t0.analyzed_at is not None

    second = aa.analyze_all(db, force=False)   # already analyzed → skipped
    assert second["analyzed"] == 0

    third = aa.analyze_all(db, force=True)     # force re-analyzes
    assert third["analyzed"] == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && . .venv/bin/activate && pytest tests/test_audio_analysis.py -v`
Expected: FAIL — `ModuleNotFoundError: app.services.audio_analysis`.

- [ ] **Step 3: Implement the service**

Create `backend/app/services/audio_analysis.py`:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && . .venv/bin/activate && pytest tests/test_audio_analysis.py -v`
Expected: PASS (4 tests). If `test_estimate_bpm_recovers_tempo` is flaky on the click track, widen tolerance to `< 10` — do not change the estimator.

- [ ] **Step 5: Commit**

```bash
rtk git add backend/app/services/audio_analysis.py backend/tests/test_audio_analysis.py
rtk git commit -m "feat(analysis): BPM + key estimation service (librosa + KS key)"
```

---

## Task E: Recommender effective-value fallback

**Files:**
- Modify: `backend/app/services/recommender.py`
- Test: `backend/tests/test_recommender.py` (append tests)

**Interfaces:**
- Produces: `effective_bpm(track: Track) -> float | None`, `effective_key(track: Track) -> str | None`. Imported by Task G.
- The `recommend(...)` result dicts use effective values for `"bpm"`/`"key"` and add `"bpm_is_analyzed"`/`"key_is_analyzed"` booleans.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_recommender.py`)

```python
def test_effective_prefers_tag_over_analyzed(db):
    t = Track(absolute_path="/e.wav", bpm=150, key_text="Am",
              bpm_analyzed=120, key_analyzed="C major", missing=False)
    assert recommender.effective_bpm(t) == 150
    assert recommender.effective_key(t) == "Am"


def test_effective_falls_back_to_analyzed(db):
    t = Track(absolute_path="/f.wav", bpm=None, key_text=None,
              bpm_analyzed=128, key_analyzed="A minor", missing=False)
    assert recommender.effective_bpm(t) == 128
    assert recommender.effective_key(t) == "A minor"


def test_analyzed_bpm_used_in_ranking(db):
    t = Track(absolute_path="/g.wav", bpm=None, bpm_analyzed=150, missing=False)
    db.add(t)
    db.commit()
    ranked = recommender.recommend(db, recommender.Context(target_bpm=150))
    row = next(r for r in ranked if r["track_id"] == t.id)
    assert row["bpm"] == 150
    assert row["bpm_is_analyzed"] is True
    assert any("BPM" in r for r in row["reasons"])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && . .venv/bin/activate && pytest tests/test_recommender.py -k effective -v`
Expected: FAIL — `recommender has no attribute 'effective_bpm'`.

- [ ] **Step 3: Add the helpers**

In `backend/app/services/recommender.py`, after the `to_camelot` function (around line 68), add:

```python
def effective_bpm(track: Track) -> Optional[float]:
    """Tag BPM when present, else the analyzed estimate."""
    return track.bpm if track.bpm is not None else track.bpm_analyzed


def effective_key(track: Track) -> Optional[str]:
    """Tag key when present, else the analyzed estimate."""
    return track.key_text or track.key_analyzed
```

- [ ] **Step 4: Route `_score` through the helpers**

In `_score`, replace the four `track.bpm` / `track.key_text` reads:

- Line ~119: `s, r = bpm_fit(track.bpm, ctx.target_bpm or ctx.previous_bpm)` → `s, r = bpm_fit(effective_bpm(track), ctx.target_bpm or ctx.previous_bpm)`
- Line ~124: `s, r = key_fit(ctx.previous_key, track.key_text)` → `s, r = key_fit(ctx.previous_key, effective_key(track))`
- Line ~131: `s, r = bpm_fit(track.bpm, ctx.next_bpm)` → `s, r = bpm_fit(effective_bpm(track), ctx.next_bpm)`
- Line ~135: `s, r = key_fit(track.key_text, ctx.next_key)` → `s, r = key_fit(effective_key(track), ctx.next_key)`

- [ ] **Step 5: Use effective values + provenance in the result dict**

In `recommend(...)`, replace the `"bpm": track.bpm,` and `"key": track.key_text,` lines (around 248-249) with:

```python
            "bpm": effective_bpm(track),
            "key": effective_key(track),
            "bpm_is_analyzed": track.bpm is None and track.bpm_analyzed is not None,
            "key_is_analyzed": not track.key_text and track.key_analyzed is not None,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && . .venv/bin/activate && pytest tests/test_recommender.py -v`
Expected: PASS (all existing + 3 new).

- [ ] **Step 7: Commit**

```bash
rtk git add backend/app/services/recommender.py backend/tests/test_recommender.py
rtk git commit -m "feat(recommender): effective_bpm/effective_key tag-first fallback"
```

---

## Task F: Analysis job + API endpoint

**Files:**
- Modify: `backend/app/schemas.py` (add `AnalyzeRequest`)
- Modify: `backend/app/jobs/worker.py` (add `_run_analyze` / `start_analyze`)
- Modify: `backend/app/api/scan.py` (add `POST /scan/analyze`)
- Test: `backend/tests/test_analyze_api.py`

**Interfaces:**
- Consumes: `audio_analysis.analyze_all` (Task D), `Settings.ffmpeg` (Task B).
- Produces: `POST /api/scan/analyze` body `{force?: bool, limit?: int}` → returns a `Job`; 400 when ffmpeg absent. Job kind `"analyze"`, done-message `analyzed N, failed M`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_analyze_api.py`:

```python
"""Analyze endpoint: ffmpeg gate + job creation."""
from __future__ import annotations

import app.config as cfg


def test_analyze_requires_ffmpeg(client, monkeypatch):
    monkeypatch.setattr(cfg.shutil, "which", lambda name: None)
    cfg.get_settings.cache_clear()
    r = client.post("/api/scan/analyze", json={})
    assert r.status_code == 400
    assert "ffmpeg" in r.json()["detail"].lower()


def test_analyze_creates_job(client, monkeypatch):
    monkeypatch.setattr(cfg.shutil, "which",
                        lambda name: "/usr/bin/ffmpeg" if name == "ffmpeg" else None)
    cfg.get_settings.cache_clear()
    r = client.post("/api/scan/analyze", json={"force": False})
    assert r.status_code == 200
    job = r.json()
    assert job["kind"] == "analyze"
    assert job["status"] in ("pending", "running", "done")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && . .venv/bin/activate && pytest tests/test_analyze_api.py -v`
Expected: FAIL — 404 (route not defined yet).

- [ ] **Step 3: Add the request schema**

In `backend/app/schemas.py`, after `ScanRequest`, add:

```python
class AnalyzeRequest(BaseModel):
    force: bool = False
    limit: Optional[int] = None
```

- [ ] **Step 4: Add the worker functions**

In `backend/app/jobs/worker.py`, extend the services import line:

```python
from ..services import audio_analysis, duplicate_detector, fingerprint, scanner
```

Then add (next to `_run_fingerprint`):

```python
def _run_analyze(job_id: int, force: bool, limit: Optional[int]) -> None:
    with Session(get_engine()) as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        job.status = "running"
        session.add(job)
        session.commit()
        try:
            result = audio_analysis.analyze_all(session, force=force, limit=limit, job=job)
            _finish(session, job, "done",
                    f"analyzed {result['analyzed']}, failed {result['failed']}")
        except Exception as exc:  # noqa: BLE001
            _finish(session, job, "error", error=str(exc))
```

And the starter (next to `start_fingerprint`):

```python
def start_analyze(job_id: int, force: bool = False, limit: Optional[int] = None) -> None:
    threading.Thread(target=_run_analyze, args=(job_id, force, limit), daemon=True).start()
```

- [ ] **Step 5: Add the endpoint**

In `backend/app/api/scan.py`, extend the schemas import:

```python
from ..schemas import AnalyzeRequest, ScanRequest
```

Then add the route (after `start_fingerprint`):

```python
@router.post("/analyze")
def start_analyze(req: AnalyzeRequest, session: Session = Depends(get_session)):
    if not get_settings().ffmpeg:
        raise HTTPException(400, "ffmpeg not found on PATH. Required for audio analysis.")
    job = worker.create_job(session, "analyze")
    worker.start_analyze(job.id, req.force, req.limit)
    return job
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && . .venv/bin/activate && pytest tests/test_analyze_api.py -v`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
rtk git add backend/app/schemas.py backend/app/jobs/worker.py backend/app/api/scan.py backend/tests/test_analyze_api.py
rtk git commit -m "feat(api): POST /scan/analyze background job (ffmpeg-gated)"
```

---

## Task G: Set Builder curves use effective values

**Files:**
- Modify: `backend/app/api/sets.py`
- Test: `backend/tests/test_sets_effective.py`

**Interfaces:**
- Consumes: `effective_bpm`, `effective_key` (Task E).
- Produces: `/sets/{id}/analysis` `bpm_curve` and the BPM-jump warning use effective BPM; `recommend-next` seeds the context with effective values.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_sets_effective.py`:

```python
"""Set analysis curves fall back to analyzed BPM when no tag BPM exists."""
from __future__ import annotations

import app.db as dbmod
from app.models import Track
from sqlmodel import Session


def _make_track(**kw) -> int:
    with Session(dbmod.get_engine()) as s:
        t = Track(missing=False, **kw)
        s.add(t)
        s.commit()
        s.refresh(t)
        return t.id


def test_bpm_curve_uses_analyzed_fallback(client):
    tid = _make_track(absolute_path="/only-analyzed.wav", bpm=None, bpm_analyzed=142.0)
    set_id = client.post("/api/sets", json={"title": "T"}).json()["id"]
    client.post(f"/api/sets/{set_id}/tracks", json={"track_id": tid})
    analysis = client.get(f"/api/sets/{set_id}/analysis").json()
    assert analysis["bpm_curve"] == [142.0]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && . .venv/bin/activate && pytest tests/test_sets_effective.py -v`
Expected: FAIL — `bpm_curve == [None]` (uses `tr.bpm`).

- [ ] **Step 3: Import the helpers**

In `backend/app/api/sets.py`, change the recommender import line:

```python
from ..services import recommender
from ..services.recommender import effective_bpm, effective_key
```

- [ ] **Step 4: Use effective BPM in `analysis()`**

Replace `bpm_curve.append(tr.bpm)` with:

```python
        bpm_curve.append(effective_bpm(tr))
```

Replace the BPM-jump warning block:

```python
            if ptr.bpm and tr.bpm and abs(ptr.bpm - tr.bpm) > 8:
                transition_warnings.append({
                    "from_position": link.position - 1,
                    "message": f"BPM jump {ptr.bpm:g}->{tr.bpm:g}",
                })
```

with:

```python
            pbpm, cbpm = effective_bpm(ptr), effective_bpm(tr)
            if pbpm and cbpm and abs(pbpm - cbpm) > 8:
                transition_warnings.append({
                    "from_position": link.position - 1,
                    "message": f"BPM jump {pbpm:g}->{cbpm:g}",
                })
```

- [ ] **Step 5: Use effective values in `recommend_next()`**

Replace the `recommender.Context(...)` seed lines for previous/next/target with effective values:

```python
        previous_key=effective_key(last_track) if last_track else None,
        previous_bpm=effective_bpm(last_track) if last_track else None,
        next_key=effective_key(next_track) if next_track else None,
        next_bpm=effective_bpm(next_track) if next_track else None,
        ...
        target_bpm=req.target_bpm or (effective_bpm(last_track) if last_track else None),
```

(Leave the other Context fields unchanged.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && . .venv/bin/activate && pytest tests/test_sets_effective.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add backend/app/api/sets.py backend/tests/test_sets_effective.py
rtk git commit -m "feat(sets): Set Builder curves + recommend use effective BPM/key"
```

---

## Task H: Frontend types

**Files:**
- Modify: `frontend/src/lib/types.ts`

**Interfaces:**
- Produces: `Track` gains the analyzed fields; `Recommendation` gains optional provenance flags.

- [ ] **Step 1: Add analyzed fields to `Track`**

In `frontend/src/lib/types.ts`, inside `interface Track`, after the `key_text?: string | null;` line, add:

```ts
  bpm_analyzed?: number | null;
  bpm_analyzed_raw?: number | null;
  bpm_analyzed_confidence?: number | null;
  bpm_analyzed_method?: string | null;
  key_analyzed?: string | null;
  key_analyzed_confidence?: number | null;
  analyzed_at?: string | null;
  analysis_error?: string | null;
```

- [ ] **Step 2: Add provenance flags to `Recommendation`**

In `interface Recommendation`, after `key?: string | null;`, add:

```ts
  bpm_is_analyzed?: boolean;
  key_is_analyzed?: boolean;
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npm run build`
Expected: `tsc --noEmit` passes (no new errors).

- [ ] **Step 4: Commit**

```bash
rtk git add frontend/src/lib/types.ts
rtk git commit -m "feat(types): analyzed BPM/key fields on Track + Recommendation"
```

---

## Task I: Frontend API client

**Files:**
- Modify: `frontend/src/lib/api.ts`

**Interfaces:**
- Produces: `api.startAnalyze(opts?: { force?: boolean; limit?: number }) => Promise<Job>`.

- [ ] **Step 1: Add the method**

In `frontend/src/lib/api.ts`, in the `// scan` group (after `startFingerprint`), add:

```ts
  startAnalyze: (opts?: { force?: boolean; limit?: number }) =>
    req<Job>("/scan/analyze", {
      method: "POST",
      body: JSON.stringify({ force: opts?.force ?? false, limit: opts?.limit ?? null }),
    }),
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npm run build`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
rtk git add frontend/src/lib/api.ts
rtk git commit -m "feat(api-client): startAnalyze() for the analysis job"
```

---

## Task J: Frontend job labels

**Files:**
- Modify: `frontend/src/lib/labels.ts`

**Interfaces:**
- Produces: `jobKindLabel("analyze")` → Greek label; `translateJobMessage("analyzed N, failed M")` → Greek.

- [ ] **Step 1: Add the kind label**

In `frontend/src/lib/labels.ts`, in the job-kind map (the object with `scan:`, `fingerprint:`, `duplicates:` around line 67), add:

```ts
  analyze: "ανάλυση BPM + key",
```

- [ ] **Step 2: Add the message translation**

In `translateJobMessage`, add a `.replace(...)` in the chain (next to the `fingerprinted` rule near line 144):

```ts
    .replace(/^analyzed (\d+), failed (\d+)$/i, "αναλύθηκαν $1, απέτυχαν $2")
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npm run build`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
rtk git add frontend/src/lib/labels.ts
rtk git commit -m "feat(labels): Greek labels for the analyze job"
```

---

## Task K: Settings trigger

**Files:**
- Modify: `frontend/src/pages/Settings.tsx`

**Interfaces:**
- Consumes: `api.startAnalyze` (I), `Job` type incl. analyze kind (H/J).
- Produces: an "Ανάλυση BPM + Key" action that starts the job and polls it, gated on ffmpeg availability.

- [ ] **Step 1: Add an ffmpeg-availability flag**

In `Settings.tsx`, find where `hasFpcalc` is derived from `health`/`settings` and add a sibling line:

```ts
  const hasFfmpeg = Boolean(health?.ffmpeg ?? settings?.ffmpeg);
```

- [ ] **Step 2: Add the handler**

Clone the existing `runFingerprint` function verbatim, rename it to `runAnalyze`, and change the single API call from `api.startFingerprint()` to `api.startAnalyze()`. (Keep its exact busy/poll/try-catch structure so behaviour matches the other jobs.) For reference, the result must be:

```ts
  async function runAnalyze() {
    setBusy(true);
    try {
      const j = await api.startAnalyze();
      poll(j.id);
    } catch (e) {
      toast.error(String(e));
      setBusy(false);
    }
  }
```

(If the real `runFingerprint` uses a `finally`/different toast, mirror that instead — match the sibling exactly.)

- [ ] **Step 3: Add the button**

Clone the fingerprint `<Button>` block (the one with `onClick={runFingerprint}` / `disabled={busy || !hasFpcalc}`) and change:
- `onClick={runFingerprint}` → `onClick={runAnalyze}`
- `disabled={busy || !hasFpcalc}` → `disabled={busy || !hasFfmpeg}`
- the icon → `<AudioWaveform .../>` (already imported)
- the label text → `Ανάλυση BPM + Key`
- the disabled hint/title → `ffmpeg δεν βρέθηκε στο PATH` (mirror how the fingerprint button shows its `!hasFpcalc` hint)

Add it directly after the fingerprint button in the same action cluster. (There are two clusters around lines 356-371 and 618-633; add it to the primary tools cluster — the one alongside `runFingerprint`. If both clusters render the fingerprint button, add it to both for consistency.)

- [ ] **Step 4: Type-check + visual sanity**

Run: `cd frontend && npm run build`
Expected: passes.
If a dev server is running, confirm the button appears in Settings and is disabled when `/api/health` reports `ffmpeg: false`.

- [ ] **Step 5: Commit**

```bash
rtk git add frontend/src/pages/Settings.tsx
rtk git commit -m "feat(settings): Audio analysis (BPM + Key) trigger"
```

---

## Task L: ProfileEditor display

**Files:**
- Modify: `frontend/src/components/ProfileEditor.tsx`

**Interfaces:**
- Consumes: `Track.bpm_analyzed` / `key_analyzed` (H).
- Produces: shows analyzed BPM/key (with a `~` marker) when no tag value exists.

- [ ] **Step 1: BPM line**

Replace the BPM display (around line 144):

```tsx
            {detail.track.bpm ? `${detail.track.bpm.toFixed(0)} BPM` : "χωρίς BPM"}
```

with:

```tsx
            {detail.track.bpm
              ? `${detail.track.bpm.toFixed(0)} BPM`
              : detail.track.bpm_analyzed
                ? `~${detail.track.bpm_analyzed.toFixed(0)} BPM`
                : "χωρίς BPM"}
```

- [ ] **Step 2: Key line**

Replace the key display (around line 147):

```tsx
            {detail.track.key_text || "χωρίς key"}
```

with:

```tsx
            {detail.track.key_text
              || (detail.track.key_analyzed ? `~${detail.track.key_analyzed}` : "χωρίς key")}
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npm run build`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
rtk git add frontend/src/components/ProfileEditor.tsx
rtk git commit -m "feat(profile): show analyzed BPM/key with ~ marker when untagged"
```

---

## Task M: TrackTable display

**Files:**
- Modify: `frontend/src/components/TrackTable.tsx`

**Interfaces:**
- Consumes: `Track.bpm_analyzed` / `key_analyzed` (H).
- Produces: BPM/key cells fall back to analyzed values (marked with `~`).

- [ ] **Step 1: BPM cell**

Replace the BPM cell (line ~323):

```tsx
                    {t.bpm ? t.bpm.toFixed(0) : "—"}
```

with:

```tsx
                    {t.bpm ? t.bpm.toFixed(0) : t.bpm_analyzed ? `~${t.bpm_analyzed.toFixed(0)}` : "—"}
```

- [ ] **Step 2: Key cell**

Replace the key cell (line ~326):

```tsx
                    {t.key_text || "—"}
```

with:

```tsx
                    {t.key_text || (t.key_analyzed ? `~${t.key_analyzed}` : "—")}
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npm run build`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
rtk git add frontend/src/components/TrackTable.tsx
rtk git commit -m "feat(table): analyzed BPM/key fallback in track rows"
```

---

## Task N: Docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Note ffmpeg + the analysis feature**

In `README.md`, under the `## External tools` section, add a bullet:

```markdown
- `ffmpeg` (required for **Audio analysis**) — decodes audio read-only to
  estimate BPM and musical key. Run the job from **Settings → Ανάλυση BPM + Key**.
  Results fill BPM/key only where embedded tags are missing; source files and
  tags are never modified.
```

And under the workflow/Settings description, add one line noting that Settings can run **Audio analysis (BPM + key)** alongside Scan / Fingerprint.

- [ ] **Step 2: Commit**

```bash
rtk git add README.md
rtk git commit -m "docs: document the audio-analysis (BPM + key) feature"
```

---

## Wave 3: Integration & Verification

**Files:** none (verification only).

- [ ] **Step 1: Full backend test suite**

Run: `cd backend && . .venv/bin/activate && pytest`
Expected: all tests pass (existing + new: `test_config_ffmpeg`, `test_schema_analysis`, `test_audio_analysis`, `test_recommender`, `test_analyze_api`, `test_sets_effective`).

- [ ] **Step 2: Frontend type-check / build**

Run: `cd frontend && npm run build`
Expected: `tsc --noEmit && vite build` succeed with no type errors.

- [ ] **Step 3: End-to-end smoke (manual, requires ffmpeg + a real library)**

Start backend (`uvicorn app.main:app --reload --port 8000`) and frontend (`npm run dev`). In **Settings**, click **Ανάλυση BPM + Key**; confirm the job runs to `done` with an `αναλύθηκαν N, απέτυχαν M` message. Open a previously untagged track in the tagging panel and confirm a `~NNN BPM` / `~<key>` value now shows. Confirm a track's embedded tag BPM/key is unchanged and the source file's mtime is unchanged.

- [ ] **Step 4: Data-safety verification**

Confirm via `gitnexus_detect_changes()` (or `rtk git diff --stat`) that no scanner/exporter/metadata-writer code paths were modified to write tags, and that the only new writes target `Track.*_analyzed` columns.

- [ ] **Step 5: Final integration commit (if anything was adjusted during verification)**

```bash
rtk git add -A && rtk git commit -m "chore: audio-analysis integration verification"
```

---

## Self-Review

**Spec coverage:**
- librosa engine → Task A. ✔
- Separate analyzed columns, never overwrite tags → Task C + the data-safety constraint. ✔
- BPM port + KS key detection → Task D. ✔
- effective_bpm/effective_key drive recommender + curves → Tasks E, G. ✔
- Batch job mirroring fingerprint, ffmpeg-gated → Tasks B, F. ✔
- Settings trigger + display surfaces → Tasks K, L, M; types/api/labels → H, I, J. ✔
- Tests on synthesized fixtures (no real audio) → Task D (DSP), monkeypatched analyze_all, endpoint gate. ✔
- README ffmpeg note → Task N. ✔
- Out-of-scope held: no per-track analysis, no tag writes, no legacy-DB migration. ✔

**Type/signature consistency:** `effective_bpm`/`effective_key` defined in E, imported in G; `analyze_all(session, *, force, limit, job)` defined in D, called in F; `AnalyzeRequest{force, limit}` defined in F-schemas, consumed in F-api; `api.startAnalyze` (I) ↔ `POST /scan/analyze` (F) ↔ `runAnalyze` (K). Job message `"analyzed N, failed M"` (D/F) ↔ `translateJobMessage` regex (J). Analyzed Track columns (C) auto-serialize via existing `model_dump` in `tracks.py` `_list_payload`/`_track_payload` — no change needed; consumed by TS `Track` (H) in L/M.

**No placeholders:** every code step contains the literal code; modify-steps cite the existing line/anchor to replace.
