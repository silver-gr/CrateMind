# AGENTS.md

Guidance for coding agents working in `/Users/silver/Projects/Music-ReORG`.

## Project Overview

This workspace catalogs and analyzes a local music library. It is intentionally small:

- `import_media_to_db.py` scans `Media/` and writes audio metadata to `media_catalog.sqlite`.
- `analyze_bpm.py` estimates BPM values for rows in `media_catalog.sqlite`.
- `DEDUP_REPORT.md`, `non_320.txt`, `hashes.txt`, `fingerprints.txt`, `tags.txt`, and `sc_*.json` are analysis outputs/reports.
- `Media` is a symlink to an external music library volume. Treat it as source data, not project code.

There is no package manifest and no test suite at the moment. Prefer small, direct Python changes over adding framework or build-system machinery.

## Local Runtime

Use the local BPM virtualenv when running the Python scripts:

```bash
.venv_bpm/bin/python import_media_to_db.py --help
.venv_bpm/bin/python analyze_bpm.py --help
```

Observed local dependencies:

- Python 3.14 via `.venv_bpm/bin/python`
- `numpy`
- `scipy`
- `librosa`
- system `ffmpeg` and `ffprobe`

The import script needs `ffprobe`. The BPM script needs `ffmpeg`, and uses `librosa` when available with a NumPy/SciPy fallback.

## Common Commands

Index the music library into the default database:

```bash
.venv_bpm/bin/python import_media_to_db.py
```

Index a different library or database:

```bash
.venv_bpm/bin/python import_media_to_db.py --media-root /path/to/Music --db /path/to/media_catalog.sqlite
```

Analyze BPM for tracks that do not already have BPM values:

```bash
.venv_bpm/bin/python analyze_bpm.py
```

Run a small BPM smoke test before a long analysis:

```bash
.venv_bpm/bin/python analyze_bpm.py --limit 10 --workers 2
```

Force BPM re-analysis:

```bash
.venv_bpm/bin/python analyze_bpm.py --force
```

Inspect the catalog schema:

```bash
sqlite3 media_catalog.sqlite '.schema media_files'
```

## Data Safety

- Do not edit, delete, move, or rename files under `Media/` unless the user explicitly asks.
- Do not run deduplication or deletion actions from `DEDUP_REPORT.md` without explicit confirmation.
- `import_media_to_db.py` recreates the `media_files` table contents with `DELETE FROM media_files`; call this out before running it if the user did not directly request a fresh import.
- `analyze_bpm.py` mutates BPM columns in the SQLite catalog. Use `--limit` for smoke tests.
- Avoid committing `.venv_bpm/`, `__pycache__/`, `.DS_Store`, `Media`, and SQLite `-wal`/`-shm` runtime files.

## Code Style

- Keep scripts as standard-library-first Python with small focused helper functions.
- Preserve the existing `argparse` command-line style.
- Use `pathlib.Path` for filesystem paths.
- Keep SQLite schema migrations additive and idempotent, as in `ensure_bpm_columns`.
- Prefer structured parsing (`json`, SQLite queries, `ffprobe` JSON) over ad hoc string parsing.
- Keep comments sparse and useful; most of the current code is self-explanatory.
