# CrateMind Deno Desktop Port — Parallel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution model:** This plan is designed for **parallel Sonnet 5 sub-agents**. Tasks within a wave run concurrently; waves are sequential barriers. Every task owns a disjoint set of files (see Ownership Map). The coordinator (main session) dispatches agents, reviews between waves, and commits per wave.

**Goal:** A self-contained Deno Desktop app that serves the existing CrateMind React UI and a full TypeScript port of the FastAPI backend from one `Deno.serve()` process, storing everything in local SQLite (`node:sqlite`), streaming local audio with Range support, and making zero external API calls.

**Architecture:** `desktop/main.ts` boots config → SQLite (WAL, FTS5-verified, migrations, launch backup) → same-origin router (`/api/*` + `/api/tracks/:id/audio` + SPA fallback from `frontend/dist`). Business logic is ported 1:1 from `backend/app` (Python stays untouched as reference). Frontend is already same-origin (`BASE = "/api"`) — **no frontend changes required**.

**Tech Stack:** Deno 2.9.0 (`deno desktop` CLI present), `node:sqlite` `DatabaseSync` (FTS5 verified working 2026-07-21), `jsr:@std/http/file-server` for static SPA, `URLPattern` routing, `Deno.Command` for ffprobe/fpcalc sidecars, Deno test runner.

## Global Constraints

Every task's requirements implicitly include all of these:

- **Data safety (product invariant):** never delete/move/retag source audio; scans read-only; no beatgrid/cue/DJ-app DB access; duplicate handling never auto-deletes.
- **No external runtime API calls.** No cloud, auth, analytics, telemetry, CORS. Endpoints whose Python implementation requires external services or non-portable DSP (`/api/artists/enrich`, `/api/scan/analyze`) return `501 {"detail": "Not available in desktop build"}`.
- **No separate FastAPI process; no Python spawning.** `backend/` and `frontend/` are **read-only reference** for all agents.
- Audio served **only by DB track id** (`/api/tracks/:id/audio`); never by arbitrary path. AIFF/AIF stays 415.
- **Parameterized SQL only** (`db.prepare(...).run/get/all` with bound params). Column/operator names may come only from hard-coded maps, never from user input.
- **`node:sqlite` binding rule:** booleans must be bound as `0`/`1` integers; `undefined` must be converted to `null`. Use the foundation helpers (`bindable()`) for every write.
- **Timestamps:** ISO-8601 UTC with `T` and `Z` via foundation `nowIso()` (e.g. `2026-07-21T18:00:00.000Z`). Never `Date#toString()`. Fresh DB only — importing the Python-era DB is out of scope (deferred).
- **Error shape:** all API errors are `{"detail": string}` JSON with the proper status — the frontend `req<T>` reads `.detail`.
- **API contract source of truth:** the Python routers under `backend/app/api/` + `frontend/src/lib/api.ts` + `frontend/src/lib/types.ts`. Field names in JSON responses must match the Python `model_dump()` output (= DB column names). When in doubt, read the Python code — do not invent shapes.
- Tests: every test creates its own DB under `await Deno.makeTempDir()`; never touch real app data. Tests needing ffprobe/fpcalc use `ignore: <binary missing>`.
- UI copy stays Greek (moot — no frontend edits).
- All new code lives under `desktop/`. Deno-style TS: no `any` where avoidable, `deno check` clean.

## Parallel-Agent Rules (conflict avoidance)

1. **Ownership Map is law.** An agent creates/edits ONLY the files listed for its task. Reading anything is fine.
2. **Frozen after Wave 0:** `desktop/deno.json`, `desktop/main.ts`, `desktop/src/types/models.ts`, `desktop/src/db/database.ts`, `desktop/src/db/schema.sql`, `desktop/src/services/config.ts`, `desktop/src/services/appPaths.ts`, `desktop/src/utils/http.ts`, `desktop/src/utils/time.ts`, `desktop/src/api/router.ts`, `desktop/src/spa.ts`, `desktop/tests/helpers.ts`. If an agent believes a frozen file must change, it **stops that sub-goal and reports the exact needed change in its final message** (blocker protocol) — it never edits the file. The coordinator applies fixes between waves.
3. **Stub replacement, not shared edits:** Wave 0 creates every `desktop/src/api/<domain>.ts` as a stub. Each Wave 2 agent replaces the body of its own stub file only. `router.ts` already imports all of them — no import-line merge conflicts ever.
4. **Tests:** an agent runs ONLY its own test file(s) (`deno test -A desktop/tests/<own>.test.ts`) plus `deno check desktop/main.ts`. The full suite runs at wave barriers by the coordinator.
5. **No git.** Agents never commit/stage. Coordinator commits once per wave.
6. **No installs.** No `npm install`, no `pip`, no new dependencies beyond `jsr:@std/http` and `jsr:@std/assert` (already pinned in Wave 0 `deno.json`).
7. **Blocker protocol:** on any blocker (frozen-file change needed, ambiguous Python behavior, missing tool, failing foundation API), the agent finishes what is finishable, then reports in its final message under a `BLOCKERS:` heading: file, exact problem, proposed resolution. Never work around a blocker by editing outside the ownership map.

## Ownership Map

| Task | Wave | Creates (owns) |
|------|------|----------------|
| T0 Foundation | 0 | `desktop/deno.json`, `desktop/main.ts`, `desktop/src/types/models.ts`, `desktop/src/db/schema.sql`, `desktop/src/db/database.ts`, `desktop/src/db/seed.ts` (stub), `desktop/src/services/appPaths.ts`, `desktop/src/services/config.ts`, `desktop/src/utils/http.ts`, `desktop/src/utils/time.ts`, `desktop/src/api/router.ts`, `desktop/src/api/{system,tracks,searches,sets,tags,duplicates,export,scan,artists}.ts` (stubs), `desktop/src/spa.ts`, `desktop/tests/helpers.ts`, `desktop/tests/foundation.test.ts` |
| T1 Search | 1 | `desktop/src/services/searchParser.ts`, `desktop/src/services/searchExecutor.ts`, `desktop/tests/search.test.ts` |
| T2 Streaming | 1 | `desktop/src/services/streaming.ts`, `desktop/tests/streaming.test.ts` |
| T3 Recommender | 1 | `desktop/src/services/camelot.ts`, `desktop/src/services/recommender.ts`, `desktop/tests/recommender.test.ts` |
| T4 Exporters | 1 | `desktop/src/services/exporterM3u.ts`, `desktop/src/services/exporterCsv.ts`, `desktop/src/services/exporterMarkdown.ts`, `desktop/src/services/exporterJsonBackup.ts`, `desktop/tests/exporters.test.ts` |
| T5 Scanner | 1 | `desktop/src/services/ffprobe.ts`, `desktop/src/services/metadata.ts`, `desktop/src/services/hashing.ts`, `desktop/src/services/fingerprint.ts`, `desktop/src/services/scanner.ts`, `desktop/src/services/duplicateDetector.ts`, `desktop/src/services/jobs.ts`, `desktop/tests/scanner.test.ts` |
| T6 Tracks API | 2 | `desktop/src/api/tracks.ts` (replace stub), `desktop/tests/api_tracks.test.ts` |
| T7 Searches API | 2 | `desktop/src/api/searches.ts` (replace stub), `desktop/src/db/seed.ts` (replace stub), `desktop/tests/api_searches.test.ts` |
| T8 Sets API | 2 | `desktop/src/api/sets.ts` (replace stub), `desktop/tests/api_sets.test.ts` |
| T9 Tags+Dupes API | 2 | `desktop/src/api/tags.ts`, `desktop/src/api/duplicates.ts` (replace stubs), `desktop/tests/api_tags_duplicates.test.ts` |
| T10 Export API | 2 | `desktop/src/api/export.ts` (replace stub), `desktop/tests/api_export.test.ts` |
| T11 Scan+Artists+System API | 2 | `desktop/src/api/scan.ts`, `desktop/src/api/artists.ts`, `desktop/src/api/system.ts` (replace stubs), `desktop/tests/api_scan_artists.test.ts` |
| T12 Integration | 3 | (coordinator; may touch anything) |

Wave 1 tasks depend only on T0. Wave 2 dependencies: T6←T1,T2; T7←T1; T8←T3; T10←T4; T11←T5. T9←T0 only.

## Blocker Register (known risks + pinned mitigations)

| # | Risk | Status / Mitigation |
|---|------|---------------------|
| 1 | `deno desktop` packaging flags unverified | Isolated to T12 final step. Everything else runs via `deno run -A desktop/main.ts` + browser at `http://127.0.0.1:8734`. Packaging failure does not block parity. Consult `deno desktop --help` at that step; never guess flags. |
| 2 | FTS5 in `node:sqlite` | **Verified working** (Deno 2.9.0, probe 2026-07-21). Startup `verifySqliteFeatures()` still fails loudly per guide. |
| 3 | `node:sqlite` rejects `boolean`/`undefined` bindings | Foundation `bindable()` helper converts; Global Constraint for all writes. |
| 4 | `/tracks/search`, `/tracks/count`, `/tracks/batch-profile` shadowed by `/tracks/:id` | Router preserves registration order; each API task MUST list literal routes before `:param` routes in its `routes()` array. |
| 5 | librosa/scipy DSP (`audio_analysis.py`) unportable | `/api/scan/analyze` → 501. `*_analyzed` columns stay in schema (frontend types reference them). |
| 6 | LLM artist enrichment external | `/api/artists/enrich` → 501. All other artists endpoints are DB-only and get real ports. |
| 7 | Python DB timestamps use space-separator format | Importer out of scope; fresh DB uses `nowIso()`. Do NOT copy the real DB into app-data. |
| 8 | Long scan blocking event loop | Scanner yields between files (sequential `await`s; progress into `jobs` table). No worker threads in v1. |
| 9 | `frontend/dist` may be stale/absent | T12 runs `npm run build` (only allowed npm use, coordinator-run). SPA server returns a clear 503 page if dist missing. |
| 10 | Parallel edit conflicts | Ownership Map + frozen files + stub pattern + coordinator-only commits. |
| 11 | Test DB collisions between parallel agents | Every test uses `Deno.makeTempDir()`; `CRATEMIND_DATA_DIR` env override in `loadConfig()`. |
| 12 | ffprobe/fpcalc missing on PATH | Config resolves from `CRATEMIND_FFPROBE_PATH` etc. or PATH; features degrade; tests `ignore` when absent. Bundled sidecars deferred (guide §24 allows). |

---

## Wave 0 — T0 Foundation & Contracts (single agent, sequential)

Everything below is the **contract** other agents compile against. Signatures are binding; bodies follow the referenced Python.

**Read first:** `backend/app/db.py`, `backend/app/config.py`, `backend/app/models.py`, `backend/app/main.py`, guide §§3,6,9 (`cratemind_deno_desktop_self_contained_agent_guide.md`).

- [ ] **Step 0.1: `desktop/deno.json`**

```json
{
  "name": "cratemind-desktop",
  "version": "0.1.0",
  "tasks": {
    "dev": "deno run -A --env-file=../.env main.ts",
    "desktop": "deno desktop --backend cef main.ts",
    "check": "deno check main.ts",
    "test": "deno test -A tests/"
  },
  "imports": {
    "@std/http": "jsr:@std/http@^1",
    "@std/assert": "jsr:@std/assert@^1"
  },
  "desktop": {
    "app": { "name": "CrateMind", "identifier": "gr.x3lixi.cratemind" },
    "backend": "cef"
  },
  "compilerOptions": { "strict": true }
}
```

(If the installed `deno desktop` rejects the `desktop` config key, drop it and note in report — packaging is T12's problem.)

- [ ] **Step 0.2: `desktop/src/db/schema.sql`** — full DDL, all 15 tables + FTS + indexes, translated from `backend/app/models.py` (incl. the late columns from `db.py:ensure_track_columns`). Datetimes are `TEXT`, booleans `INTEGER` 0/1. Tables: `tracks`, `artist_profiles`, `track_dj_profile`, `tags`, `track_tags`, `fingerprints`, `duplicate_groups`, `duplicate_group_tracks`, `sets`, `set_tracks`, `track_pair_notes`, `play_events`, `audit_log`, `jobs`, `saved_searches`, plus:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS track_search USING fts5(
  artist, title, album, label, genre, comment, notes, tags
);
```

Column names/defaults must mirror `models.py` exactly (e.g. `track_dj_profile.personal_status TEXT NOT NULL DEFAULT 'unknown'`, `tracks.play_count INTEGER NOT NULL DEFAULT 0`, `tracks.missing INTEGER NOT NULL DEFAULT 0`). Indexes: `tracks.absolute_path` UNIQUE, plus `quick_hash`, `full_hash`, `artist_normalized`, `missing`; `saved_searches.name`; `track_pair_notes.from_track_id`/`to_track_id`; `artist_profiles.normalized_name` UNIQUE.

- [ ] **Step 0.3: `desktop/src/types/models.ts`** — TS interfaces mirroring every table row (`Track`, `TrackDJProfile`, `ArtistProfileRow`, `Tag`, `TrackTag`, `FingerprintRow`, `DuplicateGroupRow`, `DuplicateGroupTrackRow`, `DJSetRow`, `SetTrackRow`, `TrackPairNoteRow`, `PlayEventRow`, `JobRow`, `SavedSearchRow`), field names = column names, `| null` for nullables. Plus request-body types ported from `backend/app/schemas.py` (`ProfileUpdate`, `BatchProfileUpdate`, `TagCreate`, `TagAssign`, `DuplicateResolve`, `SetCreate`, `SetTrackAdd`, `SetReorder`, `PairNoteCreate`, `RecommendQuery`, `SavedSearchCreate`, `SavedSearchUpdate`, `ExportRequest`, `ScanRequest`, `PlayLog`).

- [ ] **Step 0.4: `desktop/src/utils/time.ts` + `desktop/src/utils/http.ts`**

```ts
// time.ts
export function nowIso(): string;                     // new Date().toISOString()

// http.ts
export class HttpError extends Error { constructor(public status: number, public detail: string) }
export function json(data: unknown, status = 200): Response;         // content-type application/json
export function err(status: number, detail: string): Response;       // json({detail}, status)
export function noContent(): Response;                               // 204
export async function readJson<T>(req: Request): Promise<T>;         // throws HttpError(400) on bad JSON
export function bindable(v: unknown): string | number | null;        // boolean→0/1, undefined→null, Date→ISO, passthrough
```

- [ ] **Step 0.5: `desktop/src/services/appPaths.ts` + `config.ts`** — port of `config.py` semantics, app-data default per guide §6:

```ts
// appPaths.ts
export function getAppDataDir(): string;   // CRATEMIND_DATA_DIR override; else darwin ~/Library/Application Support/CrateMind, win %APPDATA%\CrateMind, linux XDG

// config.ts
export interface AppConfig {
  dataDir: string; dbFile: string; backupDir: string; exportsDir: string; backupKeep: number;
  libraryRoots: string[];                  // CRATEMIND_LIBRARY_ROOTS comma-split
  ffprobePath: string | null; fpcalcPath: string | null; ffmpegPath: string | null;  // CRATEMIND_*_PATH else PATH lookup else null
}
export function loadConfig(): AppConfig;   // also mkdirs dataDir/backups/exports (ensure_dirs)
```

PATH lookup: try `Deno.Command(name, {args:["-version"]})`-free approach — just check candidate paths from `PATH` env split for an existing executable file (no spawning at config time).

- [ ] **Step 0.6: `desktop/src/db/database.ts`** — port of `db.py`:

```ts
import { DatabaseSync } from "node:sqlite";
export function openDb(dbFile: string): DatabaseSync;          // WAL, foreign_keys ON, busy_timeout 5000
export function verifySqliteFeatures(db: DatabaseSync): void;  // FTS5 probe table create/drop; throw loudly if missing
export function initDb(db: DatabaseSync): void;                // exec schema.sql (read via import.meta + Deno.readTextFileSync), record migration version 1
export function backupOnLaunch(dbFile: string, backupDir: string, keep: number): string | null; // copy `cratemind-YYYY-MM-DD-HHMMSS.sqlite`, prune to keep; null if db absent
export function reindexTrack(db: DatabaseSync, trackId: number): void;  // exact port of db.py:reindex_track (same SELECT joining profile.notes + group_concat tags; DELETE then INSERT into track_search)
export function reindexAll(db: DatabaseSync): number;
```

- [ ] **Step 0.7: `desktop/src/api/router.ts` + stubs + `desktop/src/spa.ts` + `desktop/src/db/seed.ts` stub**

```ts
// router.ts
export interface AppContext { db: DatabaseSync; config: AppConfig }
export interface RouteDef {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  pattern: URLPattern;                       // e.g. new URLPattern({ pathname: "/api/tracks/:id/audio" })
  handler: (req: Request, params: Record<string, string | undefined>, ctx: AppContext) => Promise<Response> | Response;
}
export function buildHandler(ctx: AppContext): (req: Request) => Promise<Response>;
// iterates routes in registration order: system, tracks, searches, sets, tags, duplicates, exportRoutes, scan, artists
// match method+pattern → handler; HttpError → err(status, detail); unknown error → 500 {detail}; no /api match → 404 {detail:"Not found"}; non-/api → spa.ts
```

Every stub `desktop/src/api/<name>.ts`:

```ts
import type { RouteDef } from "./router.ts";
export function routes(): RouteDef[] { return []; }
```

`spa.ts`: `serveDir` over `frontend/dist` (path resolved relative to `import.meta.url`, NOT `Deno.cwd()`), 404 → serve `index.html` (React Router fallback), dist missing → 503 HTML "Run npm run build in frontend/". `seed.ts` stub: `export function runSeeds(_ctx: AppContext): void {}`.

- [ ] **Step 0.8: `desktop/main.ts`** — loadConfig → backupOnLaunch → openDb → verifySqliteFeatures → initDb → runSeeds → `Deno.serve({ port: 8734, hostname: "127.0.0.1" }, buildHandler(ctx))`. Log data dir + port. Port from `CRATEMIND_PORT` env, default 8734.

- [ ] **Step 0.9: `desktop/tests/helpers.ts`**

```ts
export interface TestCtx { ctx: AppContext; dir: string; cleanup(): Promise<void> }
export async function makeTestCtx(): Promise<TestCtx>;   // temp dir, CRATEMIND-free, openDb+initDb there
export function seedTrack(db: DatabaseSync, overrides?: Partial<Track>): number;      // minimal valid tracks row (+reindexTrack), returns id
export function seedProfile(db: DatabaseSync, trackId: number, overrides?: Partial<TrackDJProfile>): void;  // upsert into track_dj_profile (+reindexTrack)
```

- [ ] **Step 0.10: `desktop/tests/foundation.test.ts`** — asserts: initDb idempotent (run twice); all 15 tables + `track_search` + `schema_migrations` exist (`sqlite_master`); FTS5 probe passes; `reindexTrack` makes a seeded track findable via `SELECT rowid FROM track_search WHERE track_search MATCH '…'`; `bindable(true)===1`, `bindable(undefined)===null`; `backupOnLaunch` creates and prunes to `keep`; router returns 404 `{detail}` for unknown `/api/x` and dispatches a registered test route.

- [ ] **Step 0.11: Verify** — `cd desktop && deno task check && deno task test` → all pass. Report contract deviations, if any, explicitly.

---

## Wave 1 — parallel service ports (5 agents)

Common to all Wave-1 tasks: import only from `desktop/src/{types,db,utils,services/config}`; own files only; tests via `deno test -A desktop/tests/<own>.test.ts`; port Python behavior exactly — same edge cases, same defaults; end report lists any `BLOCKERS:`.

### Task T1: Search parser + executor

**Read first:** `backend/app/services/search.py` (all 225 lines — this is the spec), `backend/tests/test_search.py`, `backend/app/db.py` (FTS columns).

**Files:** Create `desktop/src/services/searchParser.ts`, `desktop/src/services/searchExecutor.ts`, `desktop/tests/search.test.ts`.

**Interfaces — Produces (binding for T6/T7):**

```ts
// searchExecutor.ts
export function searchTracks(db: DatabaseSync, query: string, limit = 500, offset = 0): Track[];
export function countTracks(db: DatabaseSync, query: string): number;
// searchParser.ts
export interface CompiledQuery { where: string[]; params: (string | number)[]; ftsInclude: string[]; ftsExclude: string[]; matchesNothing?: boolean }
export function compileQuery(query: string): CompiledQuery;
```

- [ ] Port tokenization (shlex-like: honor double/single quotes, fallback to whitespace split on unbalanced quotes), numeric specs (`7+`, `7-` suffix, `a-b` range incl. negative-number regex, plain equals), all `_PROFILE_NUM`/`_TRACK_NUM`/`_STR_FIELDS` maps verbatim, `not_recent`/`played_recently` (cutoff via `nowIso`-compatible ISO comparison on `tracks.last_played_at`), all bare tokens (`untagged`, `weapons`, `approved`, `missing`, `never_played`, `dramatic`, `can_cut_into`, `can_cut_out_of`, `_STATUS_VALUES`), negation via `-` prefix (`NOT (crit)`), unknown `field:value` → free text.
- [ ] Executor builds: `SELECT t.* FROM tracks t LEFT JOIN track_dj_profile p ON p.track_id=t.id LEFT JOIN artist_profiles a ON a.normalized_name=t.artist_normalized WHERE … ORDER BY t.artist, t.title LIMIT ? OFFSET ?` (limit ≤ 0 → unbounded). Positive FTS terms: `SELECT rowid FROM track_search WHERE track_search MATCH ?` with `"term" "term"` AND-joined, zero hits → return `[]` / count 0. Negative terms: `OR`-joined match, exclude ids. String contains → `LOWER(col) LIKE LOWER(?)` with `%v%` (ilike port).
- [ ] Tests (port `test_search.py` + guide flagship): flagship query `status:approved darkness:7+ energy:8+ bpm:150-160 role:bridge break:long tolerance:huge not_recent:30 dramatic` returns exactly the seeded weapon and excludes: recently-played decoy, non-dramatic decoy; `never_played` and `-never_played`; `untagged`; free-text FTS hit + `-word` exclusion; `energy:7-9` range; `status:approved` exact; quoted phrase.

### Task T2: Audio streaming service

**Read first:** `backend/app/services/streaming.py`, `backend/tests/test_audio.py`, guide §10.

**Files:** Create `desktop/src/services/streaming.ts`, `desktop/tests/streaming.test.ts`.

**Interfaces — Produces (binding for T6):**

```ts
export const AUDIO_MIME: Record<string, string>;   // exactly guide §10 map; .aiff/.aif absent → 415
export type RangeParse = { kind: "full" } | { kind: "range"; start: number; end: number } | { kind: "invalid" };
export function parseRange(header: string | null, fileSize: number): RangeParse;
export function streamResponse(path: string, ext: string, rangeHeader: string | null, fileSize: number): Promise<Response>;
// 200 full / 206 with Content-Range / 416 with Content-Range: bytes */size; always Accept-Ranges: bytes, Content-Length, Content-Type
export class UnsupportedMediaError extends Error {}   // thrown for unknown ext → route maps to 415
```

- [ ] `parseRange`: accept `bytes=0-99`, `bytes=100-`, `bytes=-500` (suffix = last N, clamp to size); reject multi-range (`,`), non-`bytes` units, start>end, start≥fileSize → invalid; end ≥ size clamps to size-1. Mirror `streaming.py` decisions exactly where they differ from this sketch — Python wins.
- [ ] `streamResponse`: `Deno.open` + seek + 64 KiB-chunk `ReadableStream` per guide §10 pseudo-code; `cancel()` closes file; never buffer whole file.
- [ ] Tests: full 200 (body bytes equal file), `bytes=0-99` → 206 + `Content-Range: bytes 0-99/N` + 100 bytes, suffix `-500`, open-ended `100-`, invalid → 416 with `bytes */N`, unknown ext throws UnsupportedMediaError, streamed-in-chunks (file > 64 KiB round-trips intact).

### Task T3: Recommender + Camelot

**Read first:** `backend/app/services/recommender.py` (all 270 lines — the spec), `backend/tests/test_recommender.py`, `backend/app/schemas.py:RecommendQuery`, `frontend/src/lib/types.ts` (`Recommendation`).

**Files:** Create `desktop/src/services/camelot.ts`, `desktop/src/services/recommender.ts`, `desktop/tests/recommender.test.ts`.

**Interfaces — Produces (binding for T8):**

```ts
// camelot.ts — port the key map + compatibility scoring exactly as recommender.py embeds it
export function camelotOf(keyText: string | null): string | null;
export function keyCompatibility(a: string | null, b: string | null): number; // same scale as Python
// recommender.ts
export interface Recommendation { track: Track; score: number; reasons: string[]; warnings: string[] }  // match Python response field names EXACTLY (verify in sets.py recommend-next serialization)
export function recommendNext(db: DatabaseSync, q: RecommendQuery): Recommendation[];
```

- [ ] Port scoring weights, positive/negative reason strings **verbatim** (transparency is the product feature), bridge mode (`before_track_id` — candidate must lead from A into B), `TrackPairNote` memory reasons, `approved_only`, `max_weirdness`, `target_bpm/energy/role`, limit.
- [ ] Tests: port every case in `test_recommender.py` (same seeded fixtures, same expected ordering/reason substrings); bridge-mode test; pair-note boost test.

### Task T4: Exporters

**Read first:** `backend/app/services/exporter_m3u.py`, `exporter_csv.py`, `exporter_markdown.py`, `backend/app/api/export.py` (json-backup logic + filename/overwrite handling), `backend/tests/test_export_m3u.py`.

**Files:** Create `desktop/src/services/exporterM3u.ts`, `exporterCsv.ts`, `exporterMarkdown.ts`, `exporterJsonBackup.ts`, `desktop/tests/exporters.test.ts`.

**Interfaces — Produces (binding for T10):**

```ts
export interface ExportInput { tracks: Track[]; profiles: Map<number, TrackDJProfile>; setTitle?: string }
export function writeM3u(input: ExportInput, destPath: string): void;        // #EXTM3U + #EXTINF lines identical to Python
export function writeCsv(input: ExportInput, destPath: string): void;        // same columns/order as exporter_csv.py
export function writeMarkdown(input: ExportInput, destPath: string): void;
export function writeJsonBackup(db: DatabaseSync, destPath: string): { count: number };  // same JSON structure as export.py
```

- [ ] Byte-identical output where Python output is deterministic (headers, field order, line endings). No overwrite unless caller passed a fresh path (overwrite policy lives in T10 route; exporters just write).
- [ ] Tests: golden-string comparisons for m3u/csv/markdown from 2 seeded tracks (one full-metadata, one nulls); json-backup round-trip contains all tables it covers in Python.

### Task T5: Scanner, metadata, hashing, fingerprint, duplicates, jobs

**Read first:** `backend/app/services/scanner.py`, `ffprobe_reader.py`, `metadata_reader.py` (only for which tags matter — Deno uses ffprobe JSON instead of mutagen, guide §11), `hashing.py`, `fingerprint.py`, `duplicate_detector.py`, `backend/app/jobs/worker.py`, `backend/tests/test_scanner.py`, `test_duplicate_detector.py`.

**Files:** Create `desktop/src/services/{ffprobe,metadata,hashing,fingerprint,scanner,duplicateDetector,jobs}.ts`, `desktop/tests/scanner.test.ts`.

**Interfaces — Produces (binding for T11):**

```ts
// jobs.ts
export function createJob(db: DatabaseSync, kind: string): JobRow;
export function updateJob(db: DatabaseSync, id: number, patch: Partial<JobRow>): void;
export function listJobs(db: DatabaseSync, limit?: number): JobRow[];
export function runJob(db: DatabaseSync, kind: "scan" | "fingerprint" | "duplicate_scan", work: (job: JobRow) => Promise<void>): JobRow;
// fire-and-forget async; status pending→running→done/error like worker.py; returns the created row immediately
// scanner.ts
export async function scanRoots(db: DatabaseSync, config: AppConfig, roots: string[], job: JobRow): Promise<void>;
// upsert by absolute_path (same layered-identity semantics as scanner.py: quick_hash match ⇒ moved file), read-only on audio, reindexTrack after each upsert, progress into job
// ffprobe.ts
export interface ProbeResult { duration: number | null; bitrate: number | null; sampleRate: number | null; channels: number | null; codec: string | null; container: string | null; tags: Record<string, string> }
export async function probe(ffprobePath: string, filePath: string): Promise<ProbeResult | null>;
// metadata.ts — guide §11 tag normalization (case-insensitive keys: artist/album_artist, title, album, genre, date/year, comment, bpm/TBPM, key/initialkey/TKEY, label/organization)
export function extractTags(probe: ProbeResult): Partial<Track>;
// hashing.ts — port quick_hash (same byte windows as hashing.py) and full_hash (sha256 stream)
// duplicateDetector.ts — port grouping logic (never deletes; only creates duplicate_groups rows)
```

- [ ] Scanner walks only given roots, audio extensions from scanner.py; missing-file marking (`missing=1`) exactly as Python; never writes to source files.
- [ ] Tests: hashing golden values on fixture bytes; extractTags casing variants; scanner upsert-idempotence + moved-file detection with temp files (fake tiny files, ffprobe mocked/optional via `ignore` when absent); duplicate grouping on seeded hash collisions; job lifecycle status transitions.

---

## Wave 2 — parallel API routers (6 agents)

Common: replace ONLY your own stub file(s); export `routes(): RouteDef[]` with **literal paths before `:param` paths**; bodies via `readJson<T>`; errors via `HttpError`; audit-worthy writes may skip audit_log in v1 (note it); after any write touching searchable columns call `reindexTrack`. **Response shapes: open the Python router file and `frontend/src/lib/types.ts` and match field-for-field.** Verify with your own API tests (spin `buildHandler(ctx)` from helpers, call it with `new Request(...)` directly — no network needed).

### Task T6: Tracks API (`desktop/src/api/tracks.ts`)

**Read first:** `backend/app/api/tracks.py` (all 257 lines), `frontend/src/lib/types.ts` (`Track`, `TrackDetail`, `Profile`), T1/T2 interfaces above.

Routes (all under `/api/tracks`): `GET ""` (q?, limit default 300, offset → `searchTracks` when q else plain list, same serialization as Python `_track_out`), `GET /search`, `GET /count` (→ `{count}` via `countTracks`), `GET /:id` (TrackDetail: track + profile + tags + artist profile — mirror tracks.py join logic), `GET /:id/audio` (404 unknown id / 410 file missing on disk / 415 unsupported ext / else `streamResponse`), `PATCH /:id/profile` (upsert partial; only provided fields; `updated_at=nowIso()`; reindex; return full profile row), `POST /:id/play` (transaction: insert play_events, increment play_count, set last_played_at; return per tracks.py), `POST /batch-profile` (→ `{updated}`).

- [ ] Tests: list/limit/q; count; 404 detail shape; profile PATCH persists + partial-only + FTS reindex visible via search; play increments and `not_recent:30` stops matching; audio 200/206/416/404/410/415 (reuse T2 via seeded temp file); batch-profile.

### Task T7: Saved searches API + seeds (`desktop/src/api/searches.ts`, `desktop/src/db/seed.ts`)

**Read first:** `backend/app/api/searches.py`, `frontend/src/lib/types.ts` (`SavedSearch`), T1 interfaces.

Routes under `/api/searches`: `GET ""` (each row + live `count` via `countTracks` — check Python field name), `POST ""`, `PATCH /:id`, `DELETE /:id` (204), `GET /:id/tracks`. `runSeeds`: insert-if-missing defaults per guide §14 (Forgotten Approved `status:approved not_recent:90`, Approved Never Played `status:approved never_played`, Long Break Candidates `break:long`, Peak Bridge Weapons = flagship query) — match names/queries `searches.py` seeds if Python has its own seed list (check first; Python wins).

- [ ] Tests: CRUD lifecycle; live count reflects seeded tracks; seeds idempotent (runSeeds twice → no dupes); 404 on missing id.

### Task T8: Sets + pair-notes API (`desktop/src/api/sets.ts`)

**Read first:** `backend/app/api/sets.py` (all 261 lines), `frontend/src/lib/types.ts` (`DJSet`, `SetTrackRow`, `SetAnalysis`, `PairNote`, `Recommendation`), T3 interfaces.

Routes (no sub-prefix): `GET /api/sets`, `POST /api/sets`, `GET /api/sets/:id` (with ordered tracks — mirror sets.py serialization), `POST /api/sets/:id/tracks` (append at max+1 or given position), `PATCH /api/sets/:id/tracks/reorder` (transaction; positions rewritten from `ordered_track_ids`), `DELETE /api/sets/:id/tracks/:trackId` (204; compact positions per Python), `GET /api/sets/:id/analysis` (port sets.py analysis math verbatim), `POST /api/sets/:id/recommend-next` (→ `recommendNext`), `POST /api/sets/:id/log-play` (insert play_events for each set track + bump counters; → `{tracks_logged}`), `GET /api/pair-notes` (optional `track_id` filter — matches from OR to), `POST /api/pair-notes`.

- [ ] Tests: create set → add 4 tracks → reorder → verify order; remove compacts; analysis values on seeded fixture (port `test_sets_effective.py` cases); recommend-next returns reasons; log-play logs N events; pair-notes CRUD + filter.

### Task T9: Tags + duplicates API (`desktop/src/api/tags.ts`, `desktop/src/api/duplicates.ts`)

**Read first:** `backend/app/api/tags.py`, `backend/app/api/duplicates.py`, types.ts (`Tag`, `DuplicateGroup`).

Tags routes (no prefix): `GET /api/tags`, `POST /api/tags`, `POST /api/tracks/:id/tags` (create-or-get by name when no id; insert track_tags; reindexTrack), `DELETE /api/tracks/:id/tags/:tagId` (204; reindexTrack). Duplicates: `GET /api/duplicates` (groups + member tracks per Python serialization), `POST /api/duplicates/:groupId/resolve` (status + roles; **never deletes files**).

- [ ] Tests: tag assign by name creates once, reused second time; FTS finds track by tag name after assign, stops after remove; duplicate resolve updates roles/status only.

### Task T10: Export API (`desktop/src/api/export.ts`)

**Read first:** `backend/app/api/export.py` (all 82 lines), T4 interfaces.

Routes under `/api/export`: `POST /m3u`, `/csv`, `/markdown`, `/json-backup`. Resolve tracks from `set_id` (ordered) or `track_ids` (that order); default filename per Python; write into `config.exportsDir` ONLY; `overwrite:false` → if exists, uniquify or 409 (match Python); response `{path, count}` field names per Python.

- [ ] Tests: set export writes into exportsDir with expected content (via T4 golden helpers); no-overwrite behavior; 404 when set/tracks missing; path always inside exportsDir (reject `filename` containing separators — mirror or tighten Python; note if tightened).

### Task T11: Scan + artists + system API (`desktop/src/api/scan.ts`, `artists.ts`, `system.ts`)

**Read first:** `backend/app/api/scan.py`, `backend/app/api/artists.py`, `backend/app/main.py` (health/settings payloads), `backend/app/services/artist_catalog.py` (rebuild + accept-prefill logic), T5 interfaces.

Scan routes under `/api/scan`: `POST /start` (roots override or config roots → `runJob("scan", …)` → Job JSON), `POST /fingerprint` (fpcalc present? job : 503/501 per Python), `POST /analyze` → **501** `{"detail": "Not available in desktop build"}`, `POST /duplicates` (job over duplicateDetector), `GET /status` (per Python: latest jobs). Artists under `/api/artists`: `GET ""` (filters q/confidence_label/needs_review/min_track_count/limit/offset), `GET /stats` (4 counts per `ArtistStatsResponse`), `POST /rebuild` (port artist_catalog rebuild — pure DB aggregation), `POST /enrich` → **501**, `POST /tracks/:id/accept-prefill` (port from artists.py/artist_catalog.py — writes profile prefill, reindex), `GET /:id`. System: `GET /api/health` (same keys as main.py: status, library_roots, ffprobe/fpcalc/ffmpeg booleans, db) + `GET /api/settings` (same keys as main.py).

- [ ] Tests: health/settings key sets; scan job on temp dir with 2 fake files reaches done with processed=2 (ffprobe-less path tolerated: metadata nulls); artists rebuild aggregates from seeded tracks; stats counts; 501s for analyze/enrich; status returns latest job.

---

## Wave 3 — T12 Integration (coordinator, sequential)

- [ ] Full suite: `cd desktop && deno task check && deno task test` — fix cross-task breakage (coordinator may edit anything now).
- [ ] `cd frontend && npm run build` (type-check + dist refresh).
- [ ] Boot `deno task dev` with `CRATEMIND_DATA_DIR` pointed at a scratch dir + real `CRATEMIND_LIBRARY_ROOTS`; curl acceptance: `/api/health`, `/api/tracks?limit=5`, flagship query via `/api/tracks?q=…`, `/api/searches` (live counts), `POST /api/tracks/:id/play` then flagship excludes it, audio Range curl (`-H "Range: bytes=0-99"` → 206), export m3u+markdown → files in exports dir, SPA `/` serves index.html and `/sets` deep-link serves index.html.
- [ ] Grep audit (guide §21): `rg "https?://" desktop/src frontend/src` — no runtime external URLs (jsr imports resolved at build, docs links ok).
- [ ] `deno desktop --backend cef main.ts` — window opens, UI loads, MiniPlayer plays. Consult `deno desktop --help` for packaging/`--output`; if packaging flags differ from guide §4, adapt from help output — never guess.
- [ ] Commit protocol: coordinator committed Wave 0/1/2 already (`Add Deno desktop foundation…`, `Port CrateMind services to Deno…`, `Port CrateMind API routers to Deno…`); final commit `Add CrateMind Deno desktop integration — self-contained same-origin app` noting backend/frontend impact, data-safety, tests.

## Acceptance checklist (from guide §24)

Desktop window opens · React UI served from Deno · SQLite in app-data · migrations · tracks endpoint · search parser · flagship query · profile edit · play logging · audio Range streaming · MiniPlayer · saved searches · dashboard counts · SetBuilder · pair notes · recommender reasons · exports · no external API calls.

Deferred (allowed): fpcalc bundling, folder-picker bindings, reveal-in-Finder, native menu/tray, auto-update, signing, cross-platform sidecars, Python-DB importer, `/api/scan/analyze` DSP, LLM enrichment.
