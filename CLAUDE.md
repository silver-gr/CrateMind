# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CrateMind — a local-first, single-user DJ intelligence layer. It scans a music
library, lets the user attach **taste metadata** (energy/darkness/set role/
status/…), finds duplicates, builds sets with a transparent recommender, and
exports artifacts (M3U8 / CSV / JSON backup / Markdown).

**Data-safety invariant (the product's reason for existing):** CrateMind owns
*taste metadata only*. It must never delete, move, or retag source audio, and
never touches beatgrids, cue points, or DJ-app databases. Scans are read-only;
exports write to the configured output dir, never the source library. Duplicate
detection flags groups for review and never auto-deletes. Treat any task that
implies mutating the music library as a bug unless the user explicitly asks.

## Commands

Backend (FastAPI, Python ≥3.11, uv):
```bash
cd backend
uv sync
cp ../.env.example .env           # set CRATEMIND_LIBRARY_ROOTS
uv run uvicorn app.main:app --reload --port 8000   # API docs at /docs
```

Backend tests (pytest, `-q` via pyproject):
```bash
cd backend
uv run pytest                           # all
uv run pytest tests/test_search.py      # one file
uv run pytest tests/test_search.py::test_name  # one test
uv run pytest -k recommender            # by keyword
```

Frontend (React 18 + TS + Vite 6, bun):
```bash
cd frontend
bun install
bun run dev          # :5173, proxies /api -> :8000
bun run build        # tsc --noEmit && vite build  (use as type-check; no test runner)
```

Both servers must run together in dev — the frontend has no data without the
backend on :8000.

## Architecture

### Backend (`backend/app/`)
Layered: `api/` routers → `services/` logic → `models.py` (SQLModel) + `db.py`
(engine, FTS, backup). All routers mount under `/api` in `main.py`. `config.py`
is env-driven (`pydantic-settings`, `CRATEMIND_*` vars, `lru_cache`d settings).

- **`db.py`** — SQLite in WAL mode. `init_db()` is idempotent (tables + pragmas
  + the `track_search` FTS5 virtual table). `backup_on_launch()` snapshots the
  DB to `backups/` on every startup and prunes to `backup_keep`. FTS is kept in
  sync manually via `reindex_track()` / `reindex_all()` — call these after any
  write that changes searchable columns.
- **`models.py`** — `Track` is the spine. Its **identity is layered**:
  `absolute_path` is the unique PK used for upsert, but `quick_hash`/`full_hash`
  /chromaprint `Fingerprint` give content identity so a library that moves on
  disk isn't re-imported as new. `TrackDJProfile` (1:1 with Track) holds all the
  taste axes. Other tables: `Tag`/`TrackTag`, `DuplicateGroup(+Track)`,
  `DJSet`/`SetTrack`, `TrackPairNote` (transition memory), `PlayEvent` +
  denormalised `play_count`/`last_played_at` on Track, `AuditLog`, `Job`,
  `SavedSearch` (= a "Memory Crate").
- **`services/search.py`** — the search mini-language. Field filters
  (`energy:7-9`, `status:approved`, `bpm:148-155`, `role:peak`, `-retired`,
  `not_recent:30`, …) compile to SQLAlchemy criteria; bare words become FTS5
  free-text. To add a field, extend `_PROFILE_NUM` / `_TRACK_NUM` / `_STR_FIELDS`
  and the boolean-token handling — keep it mirrored with the README's syntax docs.
- **`services/recommender.py`** — a *transparent* weighted scorer (explicitly
  "not AI"): every candidate returns positive/negative reason strings. Uses a
  Camelot-wheel key map for harmonic compatibility, plus a **bridge mode** (score
  a track that must lead from Track A *into* Track B) and `TrackPairNote` memory.
- **`jobs/worker.py`** — deliberately not Celery/RQ. A threaded runner over the
  `jobs` table; each job gets its own `Session` on its own thread (scan /
  fingerprint / duplicate_scan). Poll progress via the `Job` row.
- Other services are single-purpose: `scanner`, `metadata_reader` (mutagen),
  `ffprobe_reader`, `fingerprint` (Chromaprint/fpcalc), `duplicate_detector`,
  `hashing`, `recommender`, `exporter_{m3u,csv,markdown}`, `backup`, `streaming`
  (local audio audition), `audit`.

### Frontend (`frontend/src/`)
React + react-router v6. `app/App.tsx` maps 6 routes to `pages/`: Dashboard,
Library, TaggingQueue (`/tag`), Duplicates, SetBuilder (`/sets`), Settings.
`lib/api.ts` is the single typed fetch wrapper (all calls go through `req<T>`);
`lib/types.ts` holds shared route-level types. Tailwind v4 via the Vite plugin
(no `tailwind.config` — config is in CSS). `components/ui/` is the glass design
system; `components/layout/` is the shell + sidebar.

### External tools (optional, auto-detected on PATH)
`ffprobe` (duration/codec/bitrate) and `fpcalc`/Chromaprint (acoustic
fingerprints for duplicates). Both degrade gracefully when absent — never make
them hard dependencies.

## Conventions

- **UI copy is Greek by default.** Keep English only for established DJ/audio/
  file-format/dev terms (`BPM`, `M3U8`, `tag`, `export`).
- Backend: `pathlib`, SQLModel models, focused service functions, explicit
  error handling. Make side effects (scan/export/file access) obvious.
- Frontend: TS function components; pages PascalCase, helpers camelCase.
- After any DB write touching searchable columns, reindex FTS (see `db.py`).
- Commits: imperative, intent-style subjects (`Add CrateMind v1.1 — …`) with
  bodies noting backend/frontend impact, data-safety, and tests.

See `AGENTS.md` for the long-form contributor guide; `README.md` for the user
workflow and full search-syntax reference.
