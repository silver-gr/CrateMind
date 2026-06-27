# Audio Analysis (BPM + Key) — Design

**Date:** 2026-06-27
**Status:** Approved (design)
**Scope:** Transfer the standalone `analyze_bpm.py` tooling into CrateMind as a
first-class feature, and add musical-key detection. Both run as a background job
over the library and feed the recommender and Set Builder.

## Goal

CrateMind tracks already carry `bpm` and `key_text`, populated from embedded
ID3 tags at scan time and consumed by the recommender (`to_camelot(key_text)`
for harmonic mixing, BPM for transition warnings/curves). Many files have wrong
or missing tags. This feature computes BPM and key **from the audio itself** and
uses those values to fill the gaps — without ever altering the source files or
their tags.

## Decisions (locked)

1. **DSP engine:** librosa (full). Port the existing BPM logic verbatim; add a
   librosa-based key detector. librosa/numpy/scipy become **required** backend
   dependencies.
2. **Provenance:** analyzed values live in **separate columns**. Tag-derived
   `bpm`/`key_text` are never overwritten.
3. **Effective value:** the recommender and Set Builder curves use an
   `effective` value — tag value when present, else analyzed. Analysis fills
   gaps end-to-end (curves + harmonic mixing), not just informationally.
4. **Run model:** batch background job, mirroring the existing
   scan/fingerprint/duplicate jobs. No per-track on-demand analysis (YAGNI).

## Data-safety invariant

- Audio is **decoded read-only** via ffmpeg (`-f f32le`, first 120 s). Source
  files are never modified, moved, or retagged.
- All writes are confined to new CrateMind DB columns on `Track`.
- ID3 tags are never written.

## Architecture

### 1. Service — `backend/app/services/audio_analysis.py`

Pure, DB-free analysis functions (testable in isolation):

- `decode_audio(path) -> np.ndarray` — ffmpeg → mono f32le @ 22050 Hz, first
  120 s. Ported verbatim from `analyze_bpm.py`.
- `estimate_bpm(audio) -> (bpm, raw, confidence, method)` — librosa
  `feature.tempo` primary; numpy onset-autocorr fallback (`scipy.signal`);
  half-tempo correction below the 109 BPM threshold. Ported verbatim.
- `estimate_key(audio) -> (key, confidence)` — **new.** librosa `chroma_cqt`
  → mean 12-bin chroma vector → correlate against rotated Krumhansl-Schmuckler
  major and minor profiles → best match. Returns a musical key string the
  recommender already understands (e.g. `"A minor"`, `"F# major"`) plus a
  normalized confidence in `[0, 1]`.
- `AnalysisResult` dataclass: `bpm, bpm_raw, bpm_confidence, bpm_method, key,
  key_confidence, error`.
- `analyze_file(path) -> AnalysisResult` — orchestrates decode + both
  estimators; captures per-file errors instead of raising.
- `analyze_all(session, *, force=False, limit=None, job=None) -> dict` — selects
  tracks (`analyzed_at IS NULL` unless `force`), runs `analyze_file` over a
  `ThreadPoolExecutor`, writes results, updates `job.message` with progress.
  Returns `{analyzed, failed}`.

### 2. Data model — `backend/app/models.py`

New nullable columns on `Track` (additive; never touches `bpm`/`key_text`):

| column | type | meaning |
|--------|------|---------|
| `bpm_analyzed` | float? | corrected analyzed BPM |
| `bpm_analyzed_raw` | float? | uncorrected estimate |
| `bpm_analyzed_confidence` | float? | 0–1 |
| `bpm_analyzed_method` | str? | `librosa-beat-track-v1` / `ffmpeg+onset-autocorr-v1` |
| `key_analyzed` | str? | musical key, e.g. `"A minor"` |
| `key_analyzed_confidence` | float? | 0–1 |
| `analyzed_at` | datetime? | last analysis time |
| `analysis_error` | str? | last failure message, else null |

**Migration:** the repo has no Alembic. `db.init_db()` gains an idempotent
`ensure_track_columns()` that runs `ALTER TABLE tracks ADD COLUMN ...` for any
missing column (mirrors the tool's `ensure_bpm_columns`). Fresh DBs get the
columns from `SQLModel.metadata.create_all`; existing DBs migrate on launch.

### 3. Recommender — `backend/app/services/recommender.py`

Add two small helpers and route existing scoring through them:

- `effective_bpm(track) -> float | None` — `track.bpm if not None else track.bpm_analyzed`.
- `effective_key(track) -> str | None` — `track.key_text or track.key_analyzed`.

`to_camelot()` is unchanged (already parses musical + Camelot input). The reason
strings note when a value is analyzed rather than tagged (e.g. `"key 8A
(analyzed)"`) to keep recommendations transparent.

### 4. Job + API

- `backend/app/jobs/worker.py`: `_run_analyze(job_id, force, limit)` +
  `start_analyze(job_id, force, limit)`, following `_run_fingerprint` exactly
  (own Session/thread, `_finish` with `analyzed N, failed M`).
- `backend/app/config.py`: detect `ffmpeg` on PATH (`shutil.which`), like the
  existing `ffprobe`/`fpcalc` detection; expose on settings + `/api/health` and
  `/api/settings`.
- `backend/app/api/scan.py`: `POST /scan/analyze` with body
  `{force?: bool, limit?: int}` → 400 if ffmpeg absent, else `create_job(...,
  "analyze")` + `start_analyze(...)`, returns the `Job`. Status reuses the
  existing `GET /scan/status`.

### 5. Frontend

- `frontend/src/lib/api.ts`: `startAnalyze(opts?)` → `POST /scan/analyze`.
- `frontend/src/lib/types.ts`: add analyzed fields to `Track`/`TrackDetail`;
  add `ffmpeg: boolean` to the health/settings shape.
- `frontend/src/pages/Settings.tsx`: an "Audio analysis (BPM + Key)" action
  alongside Scan / Fingerprint / Duplicates; reuse the existing job-poll
  pattern; disabled with a hint when ffmpeg is missing. Greek copy.
- Display: where a track has no tag BPM/key, show the analyzed value with a
  subtle "~ (analyzed)" marker and confidence in `ProfileEditor` and
  `TrackTable`. Set Builder curves consume `effective_bpm` so analyzed tracks
  appear on the graphs.

### 6. Dependencies

`backend/pyproject.toml` base deps gain `librosa>=0.10`, `numpy`, `scipy`.
README gains a one-line note that audio analysis needs `ffmpeg` on PATH.

## Testing

`backend/tests/test_audio_analysis.py`:

- **BPM** — synthesize a click track at a known tempo (deterministic numpy
  array) → `estimate_bpm` returns within tolerance.
- **Key** — synthesize tones of a known triad → `estimate_key` returns the
  expected key (or its relative, asserted loosely).
- **Provenance fallback** — a `Track` with no `key_text` but a `key_analyzed`
  resolves via `effective_key`; a track with both prefers `key_text`.
- **Idempotency** — `analyze_all` skips already-analyzed tracks unless `force`.

Use direct array fixtures rather than real audio files to keep tests fast and
hermetic; decode is exercised by a single guarded smoke test that skips when
ffmpeg is absent.

## Out of scope (YAGNI)

- Per-track on-demand analysis button (batch-only for now).
- Writing analyzed values back into ID3 tags or into `bpm`/`key_text`.
- Migrating BPM data from the legacy `media_catalog.sqlite`.
