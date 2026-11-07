# Repository Guidelines

Guidance for every coding agent working in this repository. Claude Code loads `AGENTS.md` itself when a project has no `CLAUDE.md`, so this is the only rules file: do not add a `CLAUDE.md` or `.claude/CLAUDE.md` beside it (other agents then ignore it and warn).

## What this is

CrateMind is a local-first, single-user DJ intelligence layer. It scans a music library, lets the user attach **taste metadata** (energy/intensity/darkness/set role/status/substyle/…), finds duplicates, builds sets with a transparent recommender, plays two decks with a djay-style mixer and a Numark Mixtrack Platinum FX controller, and exports artifacts (M3U8 / CSV / JSON backup / Markdown).

**Data-safety invariant (the product's reason for existing):** CrateMind owns *taste metadata only*. It must never delete, move, or retag source audio, and never touches beatgrids or cue points in DJ apps, and never writes to, moves or locks DJ-app files. An opt-in import may read them: the library database from a private copy, and per-track analysis files in place, read-only. Scans are read-only; exports write to the configured output dir, never the source library. Duplicate detection flags groups for review and never auto-deletes. Treat any task that implies mutating the music library as a bug unless the user explicitly asks. Tests and QA must never touch real user data (the live dataset or djay files).

## Runtimes

- **Web (development):** FastAPI backend on `:8000` plus the Vite frontend on `:5173` (proxies `/api`). Both must run together.
- **Desktop:** Tauri 2 shell in `native/` with the backend frozen by PyInstaller as a sidecar (`backend/packaging/desktop.spec`, which bundles librosa/SciPy/numba for local BPM/key analysis; Essentia and provider jobs stay web-only). MIDI (the controller) is handled by the native shell and exists only in the desktop app. macOS preview build: see `docs/TAURI_DESKTOP_OPERATIONS.md`. An unsigned Windows x64 one-click installer (Velopack `Setup.exe`, per-user, no admin) and its update feed are built by `.github/workflows/windows.yml` on pushes to `windows-build` and on `v*` tags (tags also publish a GitHub Release). Installed Windows apps download newer releases in the background and install them when CrateMind closes (`native/src-tauri/src/updates.rs`; see the operations guide). The same workflow builds a Developer ID signed, notarized macOS arm64 DMG for every tag (signing secrets: see the operations guide).
- **Shared library:** the web runner can use the desktop dataset folder via `CRATEMIND_DATASET_ROOT`; a dataset lease then allows only one app at a time.

## Build, Test, and Development Commands

Backend (FastAPI, Python ≥ 3.12, uv):

```bash
cd backend
uv sync
cp ../.env.example .env                            # set CRATEMIND_LIBRARY_ROOTS
uv run uvicorn app.main:app --reload --port 8000   # API docs at /docs
uv run pytest                                      # all tests
uv run pytest tests/test_search.py::test_name      # one test; -k <keyword> by keyword
```

Backend tests are hermetic: `tests/conftest.py` clears `CRATEMIND_*`, sets `NO_CRATEMIND_ENV_FILE=1` and points every data path (including djay sources) at throwaway temp paths. Keep it that way; never let a test resolve the developer `.env`, the live dataset or djay files.

Frontend (React 19, TypeScript, Vite 8, Tailwind v4, bun):

```bash
cd frontend
bun install
bun run dev          # :5173
bun test             # unit tests in frontend/tests
bun run build        # tsc --noEmit && vite build (also the type check)
```

Desktop schema/route checks after backend changes:

```bash
python3 scripts/desktop/generate_schema_contract.py --check   # regenerate without --check after a schema change
python3 scripts/desktop/check_parity_inventory.py             # every new route must be classified here
```

## Architecture

### Backend (`backend/app/`)
Layered: `api/` routers → `services/` logic → `models.py` (SQLModel) + `db.py` (engine, FTS, backup). Routers mount under `/api` in `main.py`/`app_factory.py`. `config.py` is env-driven (`pydantic-settings`, `CRATEMIND_*` vars, `lru_cache`d settings; look settings up per call, never bind them at import).

- **`db.py`:** SQLite in WAL mode. `init_db()` is idempotent (tables, pragmas, the `track_search` FTS5 table). `backup_on_launch()` snapshots the database at most once per rolling 24 hours, and always before a pending schema upgrade when the library lives in a dataset folder; it keeps `backup_keep` bundles (default 3). FTS is kept in sync manually via `reindex_track()` / `reindex_all()`: call these after any write that changes searchable columns.
- **`models.py`:** `Track` is the spine (`id` primary key, unique `absolute_path`); `quick_hash`/`full_hash`/Chromaprint `Fingerprint` give content identity. `TrackDJProfile` (1:1) holds the taste axes. Other tables: `Tag`/`TrackTag`, `DuplicateGroup(+Track)`, `DJSet`/`SetTrack`, `TrackPairNote` (transition memory), `PlayEvent`, `AuditLog`, `Job`, `SavedSearch` (Memory Crate), `track_cues`, `TrackBeatgrid` (djay import), `TrackDownbeat` (user downbeat). Any schema change needs the regenerated schema contract.
- **`services/search.py`:** the search mini-language (`energy:7-9`, `status:approved`, `bpm:148-155`, `role:peak`, `-retired`, `not_recent:30`, …) compiles to SQLAlchemy criteria; bare words become FTS5 free text. To add a field, extend `_PROFILE_NUM` / `_TRACK_NUM` / `_STR_FIELDS` and the boolean-token handling, and keep `docs/README.md#search-syntax` in sync.
- **`services/recommender.py`:** a *transparent* weighted scorer (explicitly "not AI"): every candidate returns positive/negative reasons. Camelot-wheel key compatibility, a bridge mode, and `TrackPairNote` memory (low ratings penalise).
- **`services/djay_import.py`:** read-only djay Pro import (analysis format v8, 4/4). Copies `MediaLibrary.db` + `-wal` (never `-shm`) to a private temp dir, never opens the live DB, reads `.djayMetadata` plists in place.
- **`services/waveform_detail.py`:** CMWD v2 binary detail waveform (RMS/peak envelopes plus frequency RGB colours; NumPy only, no SciPy). `waveform_color.py` computes the colours and `waveform_density.py` renders the per-tile signed-PCM density texture.
- **`jobs/worker.py`:** a threaded runner over the `jobs` table (deliberately not Celery/RQ); each job gets its own `Session`. Poll progress via the `Job` row.
- Other single-purpose services: `scanner`, `metadata_reader` (mutagen), `ffprobe_reader`, `fingerprint`, `duplicate_detector`, `hashing`, `exporter_{m3u,csv,markdown}`, `backup`, `streaming`, `audit`, `audio_analysis` (BPM/key, run in a spawned child process; local-only on desktop).

### Frontend (`frontend/src/`)
React + react-router. `app/App.tsx` maps the routes to `pages/` (Dashboard, Library, Artists, Crates, Playlists, Tagging queue `/tag`, Set Builder `/sets`, Flow, Energy maps, Key harmony, Tag cloud, Duplicates, Settings, plus capability-gated collection pages). `lib/api.ts` is the single typed fetch wrapper (`req<T>`); `lib/types.ts` holds shared route-level types. Tailwind v4 via the Vite plugin (config in `src/index.css`). `components/ui/` is the glass design system; `components/layout/` is the shell and sidebar. Two-deck playback uses the Signalsmith Stretch WASM worklet (`lib/audio/stretchDeck.ts`); the deck waveform panels portal from `MiniPlayer` into `DeckViewSlot`. `MiniPlayer.tsx` is the riskiest file (high churn); check the change risk before editing it.

### External tools
`ffprobe` (duration/codec/bitrate), `fpcalc`/Chromaprint (fingerprints) and `ffmpeg` (BPM/key analysis) are auto-detected on `PATH` and must degrade gracefully when absent; the desktop app bundles them.

## Coding Style & Naming Conventions

Python: simple modules with focused service functions and FastAPI routers. Prefer `pathlib`, structured parsing, SQLModel models and explicit error handling. Keep side effects obvious, especially around scanning, exports and file access.

TypeScript React function components. Page components use PascalCase filenames, shared helpers use camelCase, and route-level data types belong in `frontend/src/lib/types.ts` unless they are local to one component.

All user-facing UI copy must be in Greek: labels, buttons, headings, tooltips, toasts, error messages and report text. Use English only when no Greek word is a good match, such as `beatgrid`, `downbeat`, `BPM`, `M3U8`, `tag` or `export`. Never show internal keys or English reason codes (`non_straight`, `missing`) to the user; map them to Greek text.

## Testing Guidelines

Backend: `pytest`, files named `test_*.py` in `backend/tests/`. Add tests for scanner idempotency, parser behaviour, duplicate safety, recommender scoring, exports, data-safety guarantees and API regressions; build fixtures by hand, never from personal data. Frontend: `bun test` for pure helpers in `frontend/tests/`, and `bun run build` for type/build validation.

## Commit & Pull Request Guidelines

History uses imperative, intent-style subjects such as `Add CrateMind v1.1...` with concise bodies explaining backend/frontend impact, data-safety and tests. Follow that pattern; include constraints, rejected alternatives and tested/not-tested notes when useful. PRs should summarise user-visible behaviour, data-safety impact, commands run, and screenshots for UI changes.

## Versioning & Releases

- SemVer, staying 0.x while the desktop app is a preview (minor = features, patch = fixes).
- `CHANGELOG.md` follows the x3lixi format (Keep a Changelog): `## [X.Y.Z] - YYYY-MM-DD — headline`, a summary, then Added/Changed/Fixed with bold lead-ins, `---` between versions. User-facing English, with Greek UI labels in «».
- Bump every version location with `python3 scripts/version.py set X.Y.Z`, never by hand (`show` and `check X.Y.Z` verify).
- Release = commit "Release X.Y.Z" containing the changelog entry, then an annotated tag `vX.Y.Z`. Push the tag only with the user's OK: CI builds the Windows installer and publishes a GitHub Release with that changelog section as notes (public download, no login). That release's `releases.win.json` and full `.nupkg` are the update feed, so every installed Windows app picks the release up; never mark a release as a prerelease unless it should stay hidden from updates.

## Safety & Configuration

Configure library roots in `backend/.env` from `.env.example`; keep local databases, backups, `.env` files and media paths out of commits. Never point a runner or a test at the retired `backend/data/*.sqlite` databases.

See `README.md` (Greek overview, features, limitations, roadmap) and `docs/README.md` for the user workflow and the full search-syntax reference.

## Codebase Intelligence (Repowise)

The repo is indexed by Repowise (MCP tools plus the `repowise` CLI; a post-commit hook runs `repowise update`). Its generated `.claude/CLAUDE.md` is switched off with `editor_files.claude_md: false` in the local `.repowise/config.yaml`; this section carries the guidance that file held.

- **Entry points:** `backend/app/main.py`, `backend/app/desktop_runtime/bootstrap.py` and `server.py`, `backend/app/library_exchange/cli.py`, `frontend/src/main.tsx`, `frontend/src/app/App.tsx`.
- **Hotspots** (bug-fix history and churn): `backend/app/services/djay_import.py` and `tests/test_djay_import.py`, `frontend/src/components/MiniPlayer.tsx`, `frontend/src/components/DeckScrollWaveform.tsx`, `frontend/src/pages/SetBuilder.tsx`. Run `get_risk` before editing them.
- **Which tool:** `get_answer` for one how/where/why question; `get_context` for a triage card on files, modules or symbols (`include=["skeleton"]` for a whole file, `["callers"]` or `["decisions"]` for depth); `get_symbol` only as a follow-up for an id a prior response named; `search_codebase` for identifiers (a hit whose `sources` are `[fts]` only has no semantic agreement, so verify it); `get_why` before a refactor or a pattern divergence; `get_change_risk` before committing a multi-file change; `get_health` to self-check the files you touched; `get_overview` once, in an unfamiliar area.
- **Pre-edit, not instead-of-edit:** the tools decide which files to read; still Read a file before editing it. Bytes marked `verified: true` need no re-read. An empty `callers`/`used_by` comes with a `*_basis`; read it before concluding nothing calls a symbol.
- **Record a decision you reasoned out:** `repowise decision add --agent <your slug> --title T --decision D --rationale '<why>' --affects <path>` (it lands as a candidate; accept with `repowise decision confirm <id> --agent <your slug> --evidence <commit|file>`).

<!-- REPOWISE_DISTILL:START — Do not edit below this line. Auto-generated by Repowise. -->
### Output Distillation

- Prefer `repowise distill <cmd>` for noisy commands — test runs, builds, `git status`/`log`/`diff`, searches, file listings. It runs the command unchanged (exit code preserved) and prints a compact, errors-first rendering; every error line survives.
- Output may contain a marker like `[repowise#a1b2c3d4e5f6: 230 lines omitted (~6.1k tokens); restore: repowise expand a1b2c3d4e5f6]`. The omitted content is fully preserved — run `repowise expand <ref>` to retrieve it, or `repowise expand <ref> -q <regex>` for just the matching lines.
- Never re-run a command to see omitted output; expand the marker instead.
- For structure-level questions about a large indexed file ("what's in here", "which function handles X"), `get_context(["path"], include=["skeleton"])` returns the file with bodies elided — every signature plus the bodies of the most central symbols — at a fraction of the cost of a full Read.
<!-- REPOWISE_DISTILL:END -->
